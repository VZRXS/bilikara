use std::collections::VecDeque;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
#[cfg(test)]
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, TrySendError, sync_channel};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(target_os = "macos")]
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

const MAX_BACKEND_OUTPUT_CHARS: usize = 2_048;
const MAX_BACKEND_TAIL_LINES: usize = 40;
const MAX_DESKTOP_STARTUP_LOG_BYTES: u64 = 512 * 1024;
const MAX_RUNTIME_DESKTOP_DIAGNOSTIC_EVENT_CHARS: usize = 64;
const MAX_RUNTIME_DESKTOP_DIAGNOSTIC_DETAIL_CHARS: usize = MAX_BACKEND_OUTPUT_CHARS;
const RUNTIME_DESKTOP_DIAGNOSTIC_CAPACITY: usize = 64;
const DESKTOP_STARTUP_LOG_NAME: &str = "desktop-startup.log";

#[derive(Debug, Default)]
pub(crate) struct BoundedOutputTail {
    lines: VecDeque<String>,
}

impl BoundedOutputTail {
    fn push(&mut self, line: String) {
        if self.lines.len() == MAX_BACKEND_TAIL_LINES {
            self.lines.pop_front();
        }
        self.lines.push_back(line);
    }

    fn snapshot(&self) -> Vec<String> {
        self.lines.iter().cloned().collect()
    }
}

#[derive(Clone, Debug)]
pub(crate) struct DesktopStartupLog {
    path: PathBuf,
    write_lock: Arc<Mutex<()>>,
    #[cfg(test)]
    write_failures: Arc<AtomicUsize>,
}

impl DesktopStartupLog {
    fn open(path: PathBuf) -> io::Result<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        if path
            .metadata()
            .map(|metadata| metadata.len() > MAX_DESKTOP_STARTUP_LOG_BYTES)
            .unwrap_or(false)
        {
            OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .open(&path)?;
        }
        Ok(Self {
            path,
            write_lock: Arc::new(Mutex::new(())),
            #[cfg(test)]
            write_failures: Arc::new(AtomicUsize::new(0)),
        })
    }

    fn write_record(&self, event: &str, detail: &str) -> io::Result<()> {
        let record = format!(
            "[unix_ms={}] event={} {}\n",
            unix_timestamp_millis(),
            event,
            sanitized_backend_stdout_line(detail)
        );
        let record_bytes = u64::try_from(record.len()).unwrap_or(u64::MAX);
        if self
            .path
            .metadata()
            .map(|metadata| {
                metadata.len().saturating_add(record_bytes) > MAX_DESKTOP_STARTUP_LOG_BYTES
            })
            .unwrap_or(false)
        {
            OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .open(&self.path)?;
        }
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?
            .write_all(record.as_bytes())
    }

    pub(crate) fn append(&self, event: &str, detail: impl AsRef<str>) {
        let Ok(_guard) = self.write_lock.lock() else {
            eprintln!("Desktop startup log lock is unavailable");
            return;
        };
        let result = self.write_record(event, detail.as_ref());
        if let Err(error) = result {
            #[cfg(test)]
            self.write_failures.fetch_add(1, Ordering::Relaxed);
            eprintln!("Failed to write desktop startup log: {error}");
        }
    }

    fn try_append(&self, event: &str, detail: impl AsRef<str>) {
        let Ok(_guard) = self.write_lock.try_lock() else {
            return;
        };
        // Panic diagnostics are deliberately silent and best effort so an output
        // failure cannot recurse through the panic hook.
        let _ = self.write_record(event, detail.as_ref());
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RuntimeDesktopDiagnosticRecord {
    event: String,
    detail: String,
}

impl RuntimeDesktopDiagnosticRecord {
    fn new(event: impl AsRef<str>, detail: impl AsRef<str>) -> Self {
        Self {
            event: bounded_runtime_diagnostic_value(
                event.as_ref(),
                MAX_RUNTIME_DESKTOP_DIAGNOSTIC_EVENT_CHARS,
            ),
            detail: bounded_runtime_diagnostic_value(
                detail.as_ref(),
                MAX_RUNTIME_DESKTOP_DIAGNOSTIC_DETAIL_CHARS,
            ),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RuntimeDesktopDiagnosticEnqueue {
    Enqueued,
    DroppedFull,
    DroppedDisconnected,
}

#[derive(Clone, Debug)]
pub(crate) struct RuntimeDesktopDiagnostics {
    sender: SyncSender<RuntimeDesktopDiagnosticRecord>,
}

impl RuntimeDesktopDiagnostics {
    fn start(startup_log: DesktopStartupLog) -> Self {
        let (diagnostics, writer) = Self::start_with_writer(startup_log);
        // The application never joins the diagnostic writer. Dropping the handle
        // detaches it, so shutdown cannot wait for persistence to finish.
        drop(writer);
        diagnostics
    }

    fn start_with_writer(startup_log: DesktopStartupLog) -> (Self, Option<JoinHandle<()>>) {
        let (sender, receiver) = sync_channel(RUNTIME_DESKTOP_DIAGNOSTIC_CAPACITY);
        let diagnostics = Self { sender };
        let writer = std::thread::Builder::new()
            .name("bilikara-desktop-diagnostics".to_string())
            .spawn(move || write_runtime_desktop_diagnostics(receiver, startup_log));
        match writer {
            Ok(writer) => (diagnostics, Some(writer)),
            Err(error) => {
                eprintln!("Failed to start desktop diagnostic writer: {error}");
                (diagnostics, None)
            }
        }
    }

    pub(crate) fn enqueue(
        &self,
        event: impl AsRef<str>,
        detail: impl AsRef<str>,
    ) -> RuntimeDesktopDiagnosticEnqueue {
        let record = RuntimeDesktopDiagnosticRecord::new(event, detail);
        match self.sender.try_send(record) {
            Ok(()) => RuntimeDesktopDiagnosticEnqueue::Enqueued,
            Err(TrySendError::Full(_)) => RuntimeDesktopDiagnosticEnqueue::DroppedFull,
            Err(TrySendError::Disconnected(_)) => {
                RuntimeDesktopDiagnosticEnqueue::DroppedDisconnected
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn from_sender(sender: SyncSender<RuntimeDesktopDiagnosticRecord>) -> Self {
        Self { sender }
    }
}

static RUNTIME_DESKTOP_DIAGNOSTICS: OnceLock<RuntimeDesktopDiagnostics> = OnceLock::new();

fn bounded_runtime_diagnostic_value(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars();
    let mut bounded = String::with_capacity(value.len().min(max_chars));
    bounded.extend(chars.by_ref().take(max_chars));
    if chars.next().is_some() {
        bounded.push('…');
    }
    bounded
}

fn write_runtime_desktop_diagnostics(
    receiver: Receiver<RuntimeDesktopDiagnosticRecord>,
    startup_log: DesktopStartupLog,
) {
    while let Ok(record) = receiver.recv() {
        startup_log.append(&record.event, &record.detail);
    }
}

pub(crate) fn install_runtime_desktop_diagnostics(startup_log: Option<&DesktopStartupLog>) {
    let Some(startup_log) = startup_log.cloned() else {
        return;
    };
    if RUNTIME_DESKTOP_DIAGNOSTICS
        .set(RuntimeDesktopDiagnostics::start(startup_log))
        .is_err()
    {
        eprintln!("Desktop diagnostic writer was already initialized");
    }
}

pub(crate) fn append_desktop_diagnostic(event: &str, detail: impl AsRef<str>) {
    if let Some(diagnostics) = RUNTIME_DESKTOP_DIAGNOSTICS.get() {
        let _ = diagnostics.enqueue(event, detail);
    }
}

fn unix_timestamp_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn is_packaged_macos_executable(path: &Path) -> bool {
    #[cfg(target_os = "macos")]
    {
        crate::platform::is_macos_app_bundle_executable(path)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        false
    }
}

fn desktop_startup_log_path(current_exe: &Path) -> Option<PathBuf> {
    if let Some(override_path) = std::env::var_os("BILIKARA_DESKTOP_STARTUP_LOG")
        && !override_path.is_empty()
    {
        return Some(PathBuf::from(override_path));
    }

    #[cfg(target_os = "windows")]
    {
        let install_dir = current_exe.parent()?;
        let packaged_layout =
            install_dir.join("bilikara.exe").is_file() || install_dir.join("_internal").is_dir();
        if packaged_layout {
            return Some(
                install_dir
                    .join("runtime")
                    .join("data")
                    .join("logs")
                    .join(DESKTOP_STARTUP_LOG_NAME),
            );
        }
    }

    if !is_packaged_macos_executable(current_exe) {
        return None;
    }
    let home = std::env::var_os("HOME")?;
    if home.is_empty() {
        return None;
    }
    Some(
        PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join("bilikara")
            .join("data")
            .join("logs")
            .join(DESKTOP_STARTUP_LOG_NAME),
    )
}

pub(crate) fn open_desktop_startup_log(current_exe: &Path) -> Option<DesktopStartupLog> {
    let path = desktop_startup_log_path(current_exe)?;
    match DesktopStartupLog::open(path.clone()) {
        Ok(log) => Some(log),
        Err(error) => {
            eprintln!(
                "Failed to open desktop startup log at {}: {error}",
                path.display()
            );
            None
        }
    }
}

pub(crate) fn install_desktop_panic_hook(startup_log: Option<&DesktopStartupLog>) {
    let Some(startup_log) = startup_log.cloned() else {
        return;
    };
    let previous_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |panic_info| {
        startup_log.try_append("desktop_panic", format!("message={panic_info}"));
        previous_hook(panic_info);
    }));
}

pub(crate) fn sanitized_backend_stdout_line(line: &str) -> String {
    let lower = line.to_ascii_lowercase();
    if [
        "cookie",
        "authorization",
        "sessdata",
        "bili_jct",
        "csrf",
        "qrcode_key",
        "qrcode-key",
        "access_token",
        "access-token",
        "refresh_token",
        "refresh-token",
        "shutdown_token",
        "shutdown-token",
        "secret",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
        || ((lower.contains("http://") || lower.contains("https://")) && line.contains('?'))
    {
        return "[redacted sensitive backend output]".to_string();
    }
    sanitized_diagnostic_line(line)
}

fn sanitized_diagnostic_line(line: &str) -> String {
    let mut sanitized = line
        .chars()
        .filter(|character| !character.is_control() || matches!(character, '\t'))
        .take(MAX_BACKEND_OUTPUT_CHARS + 1)
        .collect::<String>();
    if sanitized.chars().count() > MAX_BACKEND_OUTPUT_CHARS {
        sanitized = sanitized
            .chars()
            .take(MAX_BACKEND_OUTPUT_CHARS)
            .collect::<String>();
        sanitized.push('…');
    }
    sanitized
}

pub(crate) fn push_backend_tail(tail: &Arc<Mutex<BoundedOutputTail>>, line: String) {
    if let Ok(mut output_tail) = tail.lock() {
        output_tail.push(line);
    }
}

fn persist_backend_tail(
    startup_log: Option<&DesktopStartupLog>,
    stream: &str,
    tail: &Arc<Mutex<BoundedOutputTail>>,
) {
    let Some(startup_log) = startup_log else {
        return;
    };
    let lines = tail
        .lock()
        .map(|output_tail| output_tail.snapshot())
        .unwrap_or_default();
    startup_log.append(
        "backend_tail_summary",
        format!("stream={stream} lines={}", lines.len()),
    );
    for (index, line) in lines.iter().enumerate() {
        startup_log.append(
            "backend_tail",
            format!("stream={stream} index={index} output={line}"),
        );
    }
}

pub(crate) fn persist_backend_tails(
    startup_log: Option<&DesktopStartupLog>,
    stdout_tail: &Arc<Mutex<BoundedOutputTail>>,
    stderr_tail: &Arc<Mutex<BoundedOutputTail>>,
) {
    persist_backend_tail(startup_log, "stdout", stdout_tail);
    persist_backend_tail(startup_log, "stderr", stderr_tail);
}

pub(crate) fn fail_desktop_startup(
    app_handle: &tauri::AppHandle,
    startup_log: Option<&DesktopStartupLog>,
    reason: &str,
) {
    eprintln!("Bilikara desktop startup failed: {reason}");
    if let Some(startup_log) = startup_log {
        startup_log.append("desktop_failure", format!("reason={reason}"));
    }

    #[cfg(target_os = "macos")]
    {
        let diagnostic_location = startup_log
            .map(|log| {
                format!(
                    "Startup details were written to:\n\n{}",
                    log.path.to_string_lossy()
                )
            })
            .unwrap_or_else(|| {
                "The startup log could not be written. Launch the app from Terminal to capture the OS error."
                    .to_string()
            });
        let exit_handle = app_handle.clone();
        app_handle
            .dialog()
            .message(format!(
                "Bilikara's backend stopped or could not start.\n\n{diagnostic_location}"
            ))
            .title("Bilikara backend failure")
            .kind(MessageDialogKind::Error)
            .show(move |_| exit_handle.exit(1));
    }

    #[cfg(not(target_os = "macos"))]
    app_handle.exit(1);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;
    use std::time::{Duration, Instant};

    #[test]
    fn stdout_forwarding_is_bounded_and_redacts_sensitive_lines() {
        for line in [
            "Cookie: private",
            "Authorization: Bearer private",
            "SESSDATA=private",
            "csrf=private",
            "qrcode_key=private",
            "access_token=private",
            "secret=private",
            "request https://example.invalid/path?token=private",
        ] {
            assert_eq!(
                sanitized_backend_stdout_line(line),
                "[redacted sensitive backend output]"
            );
        }
        let long_line = "x".repeat(MAX_BACKEND_OUTPUT_CHARS + 100);
        let sanitized = sanitized_backend_stdout_line(&long_line);
        assert_eq!(sanitized.chars().count(), MAX_BACKEND_OUTPUT_CHARS + 1);
        assert!(sanitized.ends_with('…'));
    }

    #[test]
    fn backend_output_tail_keeps_only_recent_bounded_lines() {
        let mut tail = BoundedOutputTail::default();
        for index in 0..(MAX_BACKEND_TAIL_LINES + 5) {
            tail.push(format!("line-{index}"));
        }
        let snapshot = tail.snapshot();
        assert_eq!(snapshot.len(), MAX_BACKEND_TAIL_LINES);
        assert_eq!(snapshot.first().map(String::as_str), Some("line-5"));
        assert_eq!(
            snapshot.last().map(String::as_str),
            Some(format!("line-{}", MAX_BACKEND_TAIL_LINES + 4).as_str())
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn packaged_windows_desktop_log_does_not_require_runtime_to_exist_yet() {
        let temp_dir = std::env::temp_dir().join(format!(
            "bilikara_desktop_log_path_test_{}_{}",
            std::process::id(),
            unix_timestamp_millis()
        ));
        let runtime_dir = temp_dir.join("runtime");
        fs::create_dir_all(temp_dir.join("_internal")).expect("create packaged internal directory");
        let executable = temp_dir.join("bilikara-desktop.exe");

        assert!(!runtime_dir.exists());

        assert_eq!(
            desktop_startup_log_path(&executable),
            Some(
                runtime_dir
                    .join("data")
                    .join("logs")
                    .join(DESKTOP_STARTUP_LOG_NAME)
            )
        );

        fs::remove_dir_all(temp_dir).expect("remove packaged runtime directory");
    }

    #[test]
    fn desktop_startup_log_is_persistent_bounded_and_control_safe() {
        let temp_dir = std::env::temp_dir().join(format!(
            "bilikara_desktop_log_test_{}_{}",
            std::process::id(),
            unix_timestamp_millis()
        ));
        let log_path = temp_dir.join(DESKTOP_STARTUP_LOG_NAME);
        fs::create_dir_all(&temp_dir).expect("create temp log directory");
        fs::write(
            &log_path,
            vec![b'x'; MAX_DESKTOP_STARTUP_LOG_BYTES as usize + 1],
        )
        .expect("write oversized prior log");

        let log = DesktopStartupLog::open(log_path.clone()).expect("open startup log");
        log.append("desktop_start", "cwd=/tmp/control\nsecond-line");
        let contents = fs::read_to_string(&log_path).expect("read startup log");
        assert!(contents.contains("event=desktop_start"));
        assert!(contents.contains("cwd=/tmp/controlsecond-line"));
        assert!(contents.len() < MAX_DESKTOP_STARTUP_LOG_BYTES as usize);

        fs::remove_dir_all(temp_dir).expect("remove temp log directory");
    }

    fn enqueue_runtime_diagnostic_with_deadline(
        diagnostics: RuntimeDesktopDiagnostics,
        event: impl Into<String>,
        detail: impl Into<String>,
    ) -> RuntimeDesktopDiagnosticEnqueue {
        let event = event.into();
        let detail = detail.into();
        let (outcome_sender, outcome_receiver) = std::sync::mpsc::channel();
        thread::spawn(move || {
            let outcome = diagnostics.enqueue(event, detail);
            let _ = outcome_sender.send(outcome);
        });
        outcome_receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("runtime diagnostic producer must not wait for capacity or a writer")
    }

    fn wait_for_test_condition(mut condition: impl FnMut() -> bool, failure: &str) {
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if condition() {
                return;
            }
            thread::sleep(Duration::from_millis(10));
        }
        assert!(condition(), "{failure}");
    }

    fn finish_test_diagnostic_writer(writer: JoinHandle<()>) {
        wait_for_test_condition(
            || writer.is_finished(),
            "runtime diagnostic writer did not stop after all producers were dropped",
        );
        writer.join().expect("runtime diagnostic writer panicked");
    }

    #[test]
    fn desktop_startup_log_runtime_producer_never_waits_for_capacity_or_writer() {
        let (sender, receiver) = sync_channel(RUNTIME_DESKTOP_DIAGNOSTIC_CAPACITY);
        let diagnostics = RuntimeDesktopDiagnostics::from_sender(sender);

        assert_eq!(
            enqueue_runtime_diagnostic_with_deadline(
                diagnostics.clone(),
                "runtime_capacity",
                "index=0",
            ),
            RuntimeDesktopDiagnosticEnqueue::Enqueued
        );
        for index in 1..RUNTIME_DESKTOP_DIAGNOSTIC_CAPACITY {
            assert_eq!(
                diagnostics.enqueue("runtime_capacity", format!("index={index}")),
                RuntimeDesktopDiagnosticEnqueue::Enqueued
            );
        }
        assert_eq!(
            enqueue_runtime_diagnostic_with_deadline(
                diagnostics.clone(),
                "runtime_full",
                "must_drop",
            ),
            RuntimeDesktopDiagnosticEnqueue::DroppedFull
        );

        drop(receiver);
        assert_eq!(
            enqueue_runtime_diagnostic_with_deadline(
                diagnostics,
                "runtime_disconnected",
                "must_drop",
            ),
            RuntimeDesktopDiagnosticEnqueue::DroppedDisconnected
        );
    }

    #[test]
    fn desktop_startup_log_runtime_records_and_queue_are_bounded() {
        let (sender, receiver) = sync_channel(RUNTIME_DESKTOP_DIAGNOSTIC_CAPACITY);
        let diagnostics = RuntimeDesktopDiagnostics::from_sender(sender);
        let event = "e".repeat(MAX_RUNTIME_DESKTOP_DIAGNOSTIC_EVENT_CHARS + 10);
        let detail = "界".repeat(MAX_RUNTIME_DESKTOP_DIAGNOSTIC_DETAIL_CHARS + 10);

        assert_eq!(
            diagnostics.enqueue(event, detail),
            RuntimeDesktopDiagnosticEnqueue::Enqueued
        );
        let record = receiver.recv().expect("bounded record should be queued");
        assert_eq!(
            record.event.chars().count(),
            MAX_RUNTIME_DESKTOP_DIAGNOSTIC_EVENT_CHARS + 1
        );
        assert_eq!(
            record.detail.chars().count(),
            MAX_RUNTIME_DESKTOP_DIAGNOSTIC_DETAIL_CHARS + 1
        );
        assert!(record.event.ends_with('…'));
        assert!(record.detail.ends_with('…'));
    }

    #[test]
    fn desktop_startup_log_runtime_writer_persists_rotates_and_drops_without_join() {
        let temp_dir = std::env::temp_dir().join(format!(
            "bilikara_runtime_diagnostic_writer_test_{}_{}",
            std::process::id(),
            unix_timestamp_millis()
        ));
        let log_path = temp_dir.join(DESKTOP_STARTUP_LOG_NAME);
        fs::create_dir_all(&temp_dir).expect("create runtime diagnostic test directory");
        let startup_log = DesktopStartupLog::open(log_path.clone()).expect("open runtime log");
        fs::write(
            &log_path,
            vec![b'x'; MAX_DESKTOP_STARTUP_LOG_BYTES as usize - 8],
        )
        .expect("write nearly full runtime log");

        let writer_block = startup_log
            .write_lock
            .lock()
            .expect("block only the test writer");
        let (diagnostics, writer) =
            RuntimeDesktopDiagnostics::start_with_writer(startup_log.clone());
        let writer = writer.expect("start runtime diagnostic writer");
        assert_eq!(
            enqueue_runtime_diagnostic_with_deadline(
                diagnostics.clone(),
                "runtime_persisted",
                "source=producer",
            ),
            RuntimeDesktopDiagnosticEnqueue::Enqueued
        );
        drop(writer_block);

        wait_for_test_condition(
            || {
                fs::read_to_string(&log_path)
                    .map(|contents| contents.contains("event=runtime_persisted"))
                    .unwrap_or(false)
            },
            "queued runtime diagnostic was not persisted",
        );
        assert!(
            log_path.metadata().expect("runtime log metadata").len()
                <= MAX_DESKTOP_STARTUP_LOG_BYTES
        );

        let duplicate_producer = diagnostics.clone();
        drop(duplicate_producer);
        drop(diagnostics);
        finish_test_diagnostic_writer(writer);
        fs::remove_dir_all(temp_dir).expect("remove runtime diagnostic test directory");
    }

    #[test]
    fn desktop_startup_log_runtime_writer_contains_file_failure_and_continues() {
        let temp_dir = std::env::temp_dir().join(format!(
            "bilikara_runtime_diagnostic_failure_test_{}_{}",
            std::process::id(),
            unix_timestamp_millis()
        ));
        let log_path = temp_dir.join(DESKTOP_STARTUP_LOG_NAME);
        fs::create_dir_all(&log_path).expect("create directory where log file should be");
        let startup_log = DesktopStartupLog::open(log_path.clone()).expect("create log handle");
        let (diagnostics, writer) =
            RuntimeDesktopDiagnostics::start_with_writer(startup_log.clone());
        let writer = writer.expect("start runtime diagnostic writer");

        assert_eq!(
            diagnostics.enqueue("runtime_write_failure", "expected=true"),
            RuntimeDesktopDiagnosticEnqueue::Enqueued
        );
        wait_for_test_condition(
            || startup_log.write_failures.load(Ordering::Relaxed) >= 1,
            "runtime writer did not contain the expected file-open failure",
        );

        fs::remove_dir(&log_path).expect("remove invalid log directory");
        assert_eq!(
            diagnostics.enqueue("runtime_after_failure", "status=ok"),
            RuntimeDesktopDiagnosticEnqueue::Enqueued
        );
        wait_for_test_condition(
            || {
                fs::read_to_string(&log_path)
                    .map(|contents| contents.contains("event=runtime_after_failure"))
                    .unwrap_or(false)
            },
            "runtime writer did not continue after a file-open failure",
        );

        drop(diagnostics);
        finish_test_diagnostic_writer(writer);
        fs::remove_dir_all(temp_dir).expect("remove runtime diagnostic failure directory");
    }

    #[test]
    fn desktop_startup_log_panic_write_is_best_effort_when_lock_is_busy() {
        let temp_dir = std::env::temp_dir().join(format!(
            "bilikara_panic_diagnostic_test_{}_{}",
            std::process::id(),
            unix_timestamp_millis()
        ));
        let log_path = temp_dir.join(DESKTOP_STARTUP_LOG_NAME);
        let startup_log = DesktopStartupLog::open(log_path.clone()).expect("open panic log");
        let writer_block = startup_log
            .write_lock
            .lock()
            .expect("block only the panic test writer");
        let log_clone = startup_log.clone();
        let (finished_sender, finished_receiver) = std::sync::mpsc::channel();
        thread::spawn(move || {
            log_clone.try_append("desktop_panic", "must_drop=true");
            let _ = finished_sender.send(());
        });
        finished_receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("panic diagnostic must not wait for the log lock");
        drop(writer_block);

        startup_log.try_append("desktop_panic", "must_drop=false");
        let contents = fs::read_to_string(&log_path).expect("read panic log");
        assert!(!contents.contains("must_drop=true"));
        assert!(contents.contains("must_drop=false"));
        fs::remove_dir_all(temp_dir).expect("remove panic diagnostic test directory");
    }
}
