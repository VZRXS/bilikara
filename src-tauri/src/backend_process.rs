use crate::desktop_diagnostics::{self, BoundedOutputTail, DesktopStartupLog};
use crate::platform;
use serde::Deserialize;
#[cfg(test)]
use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::Manager;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const BACKEND_READY_TIMEOUT: Duration = Duration::from_secs(90);
const ACTIVE_BACKEND_DOWNLOAD_SHUTDOWN_GRACE: Duration = Duration::from_secs(10);

#[derive(Debug, PartialEq, Eq)]
struct BackendCommandResolution {
    command: String,
    args: Vec<String>,
    candidate_type: &'static str,
}

#[derive(Debug, PartialEq, Eq)]
struct PackagedBackendMissing {
    command_path: PathBuf,
    candidate_type: &'static str,
    candidate_exists: bool,
    candidate_executable: bool,
}

#[derive(Clone, Deserialize, Debug, PartialEq, Eq)]
struct ReadyEvent {
    event: String,
    #[allow(dead_code)]
    host: String,
    #[allow(dead_code)]
    port: u16,
    #[serde(rename = "baseUrl")]
    base_url: String,
    #[serde(default, rename = "bootstrapUrl")]
    bootstrap_url: Option<String>,
}

#[derive(Clone)]
pub(crate) struct BackendProcess {
    child: Arc<Mutex<Option<Child>>>,
    base_url: Arc<Mutex<Option<String>>>,
    shutdown_token: String,
    host_cookie: Arc<Mutex<Option<String>>>,
    active_downloads: Arc<AtomicUsize>,
}

impl BackendProcess {
    pub(crate) fn backend_url(&self) -> Result<Option<String>, ()> {
        self.base_url.lock().map(|url| url.clone()).map_err(|_| ())
    }

    pub(crate) fn host_cookie(&self) -> Option<String> {
        self.host_cookie
            .lock()
            .ok()
            .and_then(|cookie| cookie.clone())
    }

    pub(crate) fn begin_download(&self) -> ActiveBackendDownloadGuard {
        ActiveBackendDownloadGuard::acquire(self.active_downloads.clone())
    }
}

pub(crate) struct ActiveBackendDownloadGuard {
    active_downloads: Arc<AtomicUsize>,
}

impl ActiveBackendDownloadGuard {
    fn acquire(active_downloads: Arc<AtomicUsize>) -> Self {
        active_downloads.fetch_add(1, Ordering::AcqRel);
        Self { active_downloads }
    }
}

impl Drop for ActiveBackendDownloadGuard {
    fn drop(&mut self) {
        self.active_downloads.fetch_sub(1, Ordering::AcqRel);
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct BackendAddress {
    pub(crate) connect_host: String,
    pub(crate) host_header: String,
    pub(crate) port: u16,
}

#[derive(Debug, PartialEq, Eq)]
enum BackendStdoutLine {
    Ready(ReadyEvent),
    Output(String),
}

fn resolve_backend_command() -> Result<BackendCommandResolution, PackagedBackendMissing> {
    let unavailable = || PackagedBackendMissing {
        command_path: PathBuf::new(),
        candidate_type: "current-executable-unavailable",
        candidate_exists: false,
        candidate_executable: false,
    };
    let current_exe = std::env::current_exe().map_err(|_| unavailable())?;
    let current_exe = current_exe.canonicalize().unwrap_or(current_exe);
    let current_dir = current_exe.parent().ok_or_else(unavailable)?;
    let packaged_macos =
        cfg!(target_os = "macos") && platform::is_macos_app_bundle_executable(&current_exe);
    resolve_backend_command_from(&current_exe, current_dir, packaged_macos)
}

// Require the native capability handoff without logging its contents.
fn ready_navigation(ready: &ReadyEvent) -> Option<(String, Option<String>)> {
    let address = parse_local_http_url(&ready.base_url)?;
    if address.connect_host != "127.0.0.1" && address.connect_host != "::1" {
        return None;
    }
    let bootstrap = ready.bootstrap_url.as_ref()?;
    if !window_origin_authorized(bootstrap, &ready.base_url) {
        return None;
    }
    let url = tauri::Url::parse(bootstrap).ok()?;
    let token = url.path().strip_prefix("/bootstrap/")?;
    if url.query().is_some()
        || url.fragment().is_some()
        || token.len() != 43
        || !token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return None;
    }
    Some((bootstrap.clone(), Some(format!("bilikara_native={token}"))))
}

fn resolve_backend_command_from(
    current_exe: &Path,
    current_dir: &Path,
    packaged_macos: bool,
) -> Result<BackendCommandResolution, PackagedBackendMissing> {
    // The builder stages this exact layout for development and distribution.
    // Never search ancestors, the checkout, PATH, or a legacy Python package.
    let (executable, candidate_type) = if packaged_macos {
        (
            current_dir
                .join("../Frameworks/bilikara-backend.app/Contents/MacOS/bilikara-desktop-host"),
            "macos-embedded-backend",
        )
    } else {
        (
            current_dir.join("_internal").join(if cfg!(windows) {
                "bilikara-desktop-host.exe"
            } else {
                "bilikara-desktop-host"
            }),
            "native-contained",
        )
    };
    if !is_backend_candidate(&executable, current_exe) {
        return Err(PackagedBackendMissing {
            candidate_exists: executable.is_file(),
            candidate_executable: path_has_executable_bit(&executable),
            command_path: executable,
            candidate_type,
        });
    }
    Ok(BackendCommandResolution {
        command: executable
            .canonicalize()
            .unwrap_or(executable)
            .to_string_lossy()
            .into_owned(),
        args: vec![],
        candidate_type,
    })
}

fn is_backend_candidate(path: &Path, current_exe: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    let canonical_candidate = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let canonical_current_exe = current_exe
        .canonicalize()
        .unwrap_or_else(|_| current_exe.to_path_buf());
    if canonical_candidate == canonical_current_exe {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(metadata) = path.metadata() {
            if metadata.permissions().mode() & 0o111 == 0 {
                return false;
            }
        } else {
            return false;
        }
    }
    true
}

fn current_executable_string() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.canonicalize().ok().or(Some(path)))
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_default()
}

fn command_path_for_diagnostics(command: &str) -> PathBuf {
    let path = PathBuf::from(command);
    if path.is_absolute() || path.components().count() > 1 {
        return path;
    }
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|value| std::env::split_paths(&value).collect::<Vec<_>>())
        .map(|directory| directory.join(command))
        .find(|candidate| candidate.is_file())
        .unwrap_or(path)
}

fn path_has_executable_bit(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.metadata()
            .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn make_shutdown_token() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("{}-{}", std::process::id(), nanos)
}

fn normalized_url_host(host: &str) -> String {
    host.trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.')
        .to_ascii_lowercase()
}

pub(crate) fn parse_local_http_url(base_url: &str) -> Option<BackendAddress> {
    let url = tauri::Url::parse(base_url).ok()?;
    if url.scheme() != "http"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "" | "/")
    {
        return None;
    }
    let connect_host = normalized_url_host(url.host_str()?);
    if connect_host.is_empty() {
        return None;
    }
    let port = url.port_or_known_default()?;
    let host_header = if connect_host.contains(':') {
        format!("[{connect_host}]")
    } else {
        connect_host.clone()
    };
    Some(BackendAddress {
        connect_host,
        host_header,
        port,
    })
}

pub(crate) fn parsed_http_origin(url: &str) -> Option<(String, String, u16)> {
    let parsed = tauri::Url::parse(url).ok()?;
    if parsed.scheme() != "http" || !parsed.username().is_empty() || parsed.password().is_some() {
        return None;
    }
    let host = normalized_url_host(parsed.host_str()?);
    if host.is_empty() {
        return None;
    }
    Some((
        parsed.scheme().to_ascii_lowercase(),
        host,
        parsed.port_or_known_default()?,
    ))
}

pub(crate) fn window_origin_authorized(window_url: &str, backend_url: &str) -> bool {
    parsed_http_origin(window_url)
        .zip(parsed_http_origin(backend_url))
        .is_some_and(|(window_origin, backend_origin)| window_origin == backend_origin)
}

pub(crate) fn request_backend_shutdown(base_url: &str, shutdown_token: &str, native: bool) -> bool {
    let Some(address) = parse_local_http_url(base_url) else {
        return false;
    };
    let Ok(mut stream) = TcpStream::connect((address.connect_host.as_str(), address.port)) else {
        return false;
    };
    let _ = stream.set_write_timeout(Some(Duration::from_secs(1)));
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let request = format!(
        "POST /api/app/shutdown HTTP/1.1\r\nHost: {}:{}\r\nContent-Length: 2\r\nContent-Type: application/json\r\nX-Bilikara-Shutdown-Token: {}\r\nConnection: close\r\n\r\n{}",
        address.host_header, address.port, shutdown_token, "{}"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    // Python accepts a write-half-close; Hyper treats it as disconnect before
    // dispatch. Native HTTP uses Content-Length framing and Connection: close.
    if !native {
        let _ = stream.shutdown(Shutdown::Write);
    }
    let mut response = Vec::new();
    let _ = stream.read_to_end(&mut response);
    !native || response.starts_with(b"HTTP/1.1 200 ") || response.starts_with(b"HTTP/1.0 200 ")
}

/// Private lifecycle request. Browser content never receives this token.
fn request_update(
    backend: &BackendProcess,
    route: &str,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let base = backend
        .backend_url()
        .map_err(|_| "backend unavailable")?
        .ok_or("backend unavailable")?;
    let address = parse_local_http_url(&base).ok_or("invalid backend address")?;
    let mut stream = TcpStream::connect((address.connect_host.as_str(), address.port))
        .map_err(|_| "backend unavailable")?;
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .map_err(|e| e.to_string())?;
    let body = body.to_string();
    let request = format!(
        "POST {route} HTTP/1.1\r\nHost: {}:{}\r\nContent-Length: {}\r\nContent-Type: application/json\r\nX-Bilikara-Shutdown-Token: {}\r\nConnection: close\r\n\r\n{}",
        address.host_header,
        address.port,
        body.len(),
        backend.shutdown_token,
        body
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|_| "update request failed")?;
    let mut response = Vec::new();
    stream
        .take(32768)
        .read_to_end(&mut response)
        .map_err(|_| "update response failed")?;
    let split = response
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or("invalid update response")?;
    let data: serde_json::Value =
        serde_json::from_slice(&response[split + 4..]).map_err(|_| "invalid update response")?;
    if !response.starts_with(b"HTTP/1.1 200 ") || data["ok"] != true {
        return Err(data["error"]
            .as_str()
            .unwrap_or("native update operation was not accepted")
            .chars()
            .take(500)
            .collect());
    }
    Ok(data["data"].clone())
}

pub(crate) fn activate_update(backend: &BackendProcess, operation: u64) -> Result<(), String> {
    request_update(
        backend,
        "/api/app/update/activate",
        serde_json::json!({"operation":operation}),
    )
    .map(|_| ())
}

#[tauri::command]
pub(crate) async fn start_desktop_update(
    window: tauri::WebviewWindow,
    backend: tauri::State<'_, BackendProcess>,
    include_preview: bool,
) -> Result<serde_json::Value, String> {
    crate::presentation::authorize_window(&window, &backend, &["main"])?;
    let backend = backend.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        request_update(
            &backend,
            "/api/app/update/install",
            serde_json::json!({"include_preview":include_preview}),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn cancel_desktop_update(
    window: tauri::WebviewWindow,
    backend: tauri::State<'_, BackendProcess>,
) -> Result<serde_json::Value, String> {
    crate::presentation::authorize_window(&window, &backend, &["main"])?;
    let backend = backend.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        request_update(&backend, "/api/app/update/cancel", serde_json::json!({}))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn wait_for_child_exit(child: &mut Child, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) => {
                if Instant::now() >= deadline {
                    return false;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(_) => return true,
        }
    }
}

fn wait_for_active_backend_downloads(active_downloads: &AtomicUsize, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    while active_downloads.load(Ordering::Acquire) > 0 {
        if Instant::now() >= deadline {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn process_backend_stdout_line(line: &str, ready_handled: &mut bool) -> BackendStdoutLine {
    if !*ready_handled
        && let Ok(ready) = serde_json::from_str::<ReadyEvent>(line)
        && ready.event == "bilikara.ready"
    {
        *ready_handled = true;
        return BackendStdoutLine::Ready(ready);
    }
    BackendStdoutLine::Output(desktop_diagnostics::sanitized_backend_stdout_line(line))
}

fn write_and_flush_ready_marker<W: io::Write>(mut writer: W, base_url: &str) -> io::Result<()> {
    writeln!(writer, "Backend ready at {}", base_url)?;
    writer.flush()
}

fn forward_backend_stdout_line<W: Write>(mut writer: W, line: &str) {
    let _ = writeln!(writer, "Backend stdout: {line}");
}

fn drain_backend_stdout<R, FReady, FOutput>(
    reader: R,
    mut on_ready: FReady,
    mut on_output: FOutput,
) -> io::Result<()>
where
    R: BufRead,
    FReady: FnMut(ReadyEvent),
    FOutput: FnMut(String),
{
    let mut ready_handled = false;
    for line in reader.lines() {
        match process_backend_stdout_line(&line?, &mut ready_handled) {
            BackendStdoutLine::Ready(ready) => on_ready(ready),
            BackendStdoutLine::Output(output) => on_output(output),
        }
    }
    Ok(())
}

pub(crate) fn launch(
    app: &tauri::App,
    window: tauri::WebviewWindow,
    startup_log: Option<DesktopStartupLog>,
) {
    let mut resolution = match resolve_backend_command() {
        Ok(resolution) => resolution,
        Err(missing) => {
            let detail = format!(
                "candidate_type={} command_path={} candidate_exists={} candidate_executable={}. Reinstall the complete native bundle, or run npm run prepare:desktop before cargo run.",
                missing.candidate_type,
                missing.command_path.display(),
                missing.candidate_exists,
                missing.candidate_executable,
            );
            if let Some(startup_log) = startup_log.as_ref() {
                startup_log.append("packaged_backend_missing", &detail);
            }
            desktop_diagnostics::fail_desktop_startup(app.handle(), startup_log.as_ref(), &detail);
            return;
        }
    };
    resolution.args.extend(vec![
        "--no-browser".to_string(),
        "--headless".to_string(),
        "--port".to_string(),
        "0".to_string(),
    ]);
    let diagnostic_command_path = command_path_for_diagnostics(&resolution.command);
    let candidate_exists = diagnostic_command_path.is_file();
    let candidate_executable = path_has_executable_bit(&diagnostic_command_path);
    if let Some(startup_log) = startup_log.as_ref() {
        startup_log.append(
            "backend_resolved",
            format!(
                "candidate_type={} command_path={} candidate_exists={} candidate_executable={} args_count={}",
                resolution.candidate_type,
                diagnostic_command_path.display(),
                candidate_exists,
                candidate_executable,
                resolution.args.len()
            ),
        );
    }

    let shutdown_token = make_shutdown_token();
    let desktop_executable = current_executable_string();

    let mut command = Command::new(&resolution.command);
    command
        .args(resolution.args)
        .env("BILIKARA_STARTUP_LOG", "1")
        .env("BILIKARA_LAUNCH_MODE", "tauri")
        .env("BILIKARA_DESKTOP_PID", std::process::id().to_string())
        .env("BILIKARA_DESKTOP_EXECUTABLE", desktop_executable)
        .env("BILIKARA_SHUTDOWN_TOKEN", shutdown_token.clone())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let detail = format!(
                "status=error kind={:?} raw_os_error={:?} message={}",
                error.kind(),
                error.raw_os_error(),
                error
            );
            if let Some(startup_log) = startup_log.as_ref() {
                startup_log.append("backend_spawn", &detail);
            }
            desktop_diagnostics::fail_desktop_startup(app.handle(), startup_log.as_ref(), &detail);
            return;
        }
    };
    if let Some(startup_log) = startup_log.as_ref() {
        startup_log.append(
            "backend_spawn",
            format!("status=ok child_pid={}", child.id()),
        );
    }

    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        desktop_diagnostics::fail_desktop_startup(
            app.handle(),
            startup_log.as_ref(),
            "backend child started without a stdout pipe",
        );
        return;
    };
    let stderr = child.stderr.take();
    let window_clone = window.clone();
    let child_arc = Arc::new(Mutex::new(Some(child)));
    let base_url = Arc::new(Mutex::new(None));
    let base_url_for_reader = base_url.clone();
    let ready_received = Arc::new(AtomicBool::new(false));
    let stdout_tail = Arc::new(Mutex::new(BoundedOutputTail::default()));
    let stderr_tail = Arc::new(Mutex::new(BoundedOutputTail::default()));

    let host_cookie = Arc::new(Mutex::new(None));
    app.manage(BackendProcess {
        child: child_arc.clone(),
        base_url: base_url.clone(),
        shutdown_token: shutdown_token.clone(),
        host_cookie: host_cookie.clone(),
        active_downloads: Arc::new(AtomicUsize::new(0)),
    });

    if let Some(stderr) = stderr {
        let stderr_tail_for_reader = stderr_tail.clone();
        let startup_log_for_stderr = startup_log.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                match line {
                    Ok(line) => {
                        let sanitized = desktop_diagnostics::sanitized_backend_stdout_line(&line);
                        desktop_diagnostics::push_backend_tail(
                            &stderr_tail_for_reader,
                            sanitized.clone(),
                        );
                        eprintln!("Backend stderr: {sanitized}");
                    }
                    Err(error) => {
                        if let Some(startup_log) = startup_log_for_stderr.as_ref() {
                            startup_log.append(
                                "backend_stderr_reader",
                                format!("status=error message={error}"),
                            );
                        }
                        break;
                    }
                }
            }
        });
    } else if let Some(startup_log) = startup_log.as_ref() {
        startup_log.append("backend_stderr_reader", "status=missing-pipe");
    }

    let ready_for_reader = ready_received.clone();
    let stdout_tail_for_reader = stdout_tail.clone();
    let startup_log_for_stdout = startup_log.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        let result = drain_backend_stdout(
            reader,
            |ready| {
                let Some((navigation, cookie)) = ready_navigation(&ready) else {
                    eprintln!("Rejected invalid backend readiness URL");
                    return;
                };
                if let Ok(mut stored) = host_cookie.lock() {
                    *stored = cookie;
                }
                ready_for_reader.store(true, Ordering::Release);
                if let Some(startup_log) = startup_log_for_stdout.as_ref() {
                    let address = parse_local_http_url(&ready.base_url)
                        .map(|address| format!("{}:{}", address.connect_host, address.port))
                        .unwrap_or_else(|| "unparsed".to_string());
                    startup_log.append(
                        "backend_ready",
                        format!("ready_marker_received=true address={address}"),
                    );
                }
                if let Err(error) = write_and_flush_ready_marker(io::stdout(), &ready.base_url) {
                    eprintln!("Failed to flush backend readiness output: {error}");
                    if let Some(startup_log) = startup_log_for_stdout.as_ref() {
                        startup_log
                            .append("ready_forward", format!("status=error message={error}"));
                    }
                }
                if let Ok(mut stored_url) = base_url_for_reader.lock() {
                    *stored_url = Some(ready.base_url.clone());
                }
                if let Err(error) = window_clone.show() {
                    eprintln!("Failed to show window: {}", error);
                    if let Some(startup_log) = startup_log_for_stdout.as_ref() {
                        startup_log.append("window_show", format!("status=error message={error}"));
                    }
                } else if let Some(startup_log) = startup_log_for_stdout.as_ref() {
                    startup_log.append("window_show", "status=ok");
                }
                if let Err(error) = window_clone.set_always_on_top(true)
                    && let Some(startup_log) = startup_log_for_stdout.as_ref()
                {
                    startup_log.append(
                        "window_raise",
                        format!("status=error phase=enable message={error}"),
                    );
                }
                if let Err(error) = window_clone.set_always_on_top(false)
                    && let Some(startup_log) = startup_log_for_stdout.as_ref()
                {
                    startup_log.append(
                        "window_raise",
                        format!("status=error phase=disable message={error}"),
                    );
                }
                if let Err(error) = window_clone.set_focus() {
                    if let Some(startup_log) = startup_log_for_stdout.as_ref() {
                        startup_log.append("window_focus", format!("status=error message={error}"));
                    }
                } else if let Some(startup_log) = startup_log_for_stdout.as_ref() {
                    startup_log.append("window_focus", "status=ok");
                }
                if let Err(error) = window_clone.eval(format!(
                    "window.location.replace({});",
                    serde_json::to_string(&navigation).expect("navigation URL")
                )) {
                    eprintln!("Failed to navigate to backend: {}", error);
                    if let Some(startup_log) = startup_log_for_stdout.as_ref() {
                        startup_log
                            .append("window_navigate", format!("status=error message={error}"));
                    }
                } else if let Some(startup_log) = startup_log_for_stdout.as_ref() {
                    startup_log.append("window_navigate", "status=ok");
                }
            },
            |line| {
                desktop_diagnostics::push_backend_tail(&stdout_tail_for_reader, line.clone());
                forward_backend_stdout_line(io::stdout(), &line);
            },
        );
        if let Err(error) = result {
            eprintln!("Failed to read backend stdout: {error}");
            if let Some(startup_log) = startup_log_for_stdout.as_ref() {
                startup_log.append(
                    "backend_stdout_reader",
                    format!("status=error message={error}"),
                );
            }
        }
    });

    let app_handle = app.handle().clone();
    let child_for_monitor = child_arc.clone();
    let ready_for_monitor = ready_received.clone();
    let stdout_tail_for_monitor = stdout_tail.clone();
    let stderr_tail_for_monitor = stderr_tail.clone();
    let startup_log_for_monitor = startup_log.clone();
    std::thread::spawn(move || {
        let ready_deadline = Instant::now() + BACKEND_READY_TIMEOUT;
        loop {
            std::thread::sleep(Duration::from_millis(250));
            let ready = ready_for_monitor.load(Ordering::Acquire);
            let mut failure_reason = None;
            let mut monitor_complete = false;
            match child_for_monitor.lock() {
                Ok(mut child_lock) => {
                    if let Some(child) = child_lock.as_mut() {
                        match child.try_wait() {
                            Ok(Some(status)) => {
                                let phase = if ready { "after-ready" } else { "before-ready" };
                                let detail = format!(
                                    "phase={phase} status={status} ready_marker_received={ready}"
                                );
                                if let Some(startup_log) = startup_log_for_monitor.as_ref() {
                                    startup_log.append("backend_exit", &detail);
                                }
                                *child_lock = None;
                                failure_reason = Some(format!("backend exited {detail}"));
                            }
                            Ok(None) if !ready && Instant::now() >= ready_deadline => {
                                let kill_result = child.kill();
                                let wait_result = child.wait();
                                let detail = format!(
                                    "ready_marker_received=false timeout_seconds={} kill_result={kill_result:?} exit_status={wait_result:?}",
                                    BACKEND_READY_TIMEOUT.as_secs()
                                );
                                if let Some(startup_log) = startup_log_for_monitor.as_ref() {
                                    startup_log.append("backend_ready_timeout", &detail);
                                }
                                *child_lock = None;
                                failure_reason =
                                    Some(format!("backend ready marker timed out: {detail}"));
                            }
                            Ok(None) => {}
                            Err(error) => {
                                let detail = format!(
                                    "ready_marker_received={ready} kind={:?} raw_os_error={:?} message={error}",
                                    error.kind(),
                                    error.raw_os_error()
                                );
                                if let Some(startup_log) = startup_log_for_monitor.as_ref() {
                                    startup_log.append("backend_wait", &detail);
                                }
                                *child_lock = None;
                                failure_reason =
                                    Some(format!("failed to wait for backend: {detail}"));
                            }
                        }
                    } else {
                        monitor_complete = true;
                    }
                }
                Err(_) => {
                    failure_reason = Some("backend process lock became unavailable".to_string());
                }
            }

            if let Some(reason) = failure_reason {
                std::thread::sleep(Duration::from_millis(100));
                desktop_diagnostics::persist_backend_tails(
                    startup_log_for_monitor.as_ref(),
                    &stdout_tail_for_monitor,
                    &stderr_tail_for_monitor,
                );
                desktop_diagnostics::fail_desktop_startup(
                    &app_handle,
                    startup_log_for_monitor.as_ref(),
                    &desktop_diagnostics::backend_failure_reason(&reason, &stderr_tail_for_monitor),
                );
                break;
            }
            if monitor_complete {
                break;
            }
        }
    });
}

pub(crate) fn shutdown(state: &BackendProcess) {
    wait_for_active_backend_downloads(
        &state.active_downloads,
        ACTIVE_BACKEND_DOWNLOAD_SHUTDOWN_GRACE,
    );
    desktop_diagnostics::append_desktop_diagnostic(
        "desktop_shutdown",
        format!(
            "stage=active_download_wait_finished remaining={}",
            state.active_downloads.load(Ordering::Acquire)
        ),
    );
    let shutdown_url = state
        .base_url
        .lock()
        .ok()
        .and_then(|stored_url| stored_url.clone());
    let shutdown_requested = shutdown_url
        .as_deref()
        .map(|url| {
            request_backend_shutdown(url, &state.shutdown_token, state.host_cookie().is_some())
        })
        .unwrap_or(false);
    desktop_diagnostics::append_desktop_diagnostic(
        "desktop_shutdown",
        format!("stage=backend_shutdown_requested accepted={shutdown_requested}"),
    );

    if let Ok(mut child_lock) = state.child.lock()
        && let Some(mut child) = child_lock.take()
    {
        if shutdown_requested && wait_for_child_exit(&mut child, Duration::from_secs(20)) {
            desktop_diagnostics::append_desktop_diagnostic(
                "desktop_shutdown",
                "stage=backend_exited_gracefully",
            );
            return;
        }
        desktop_diagnostics::append_desktop_diagnostic(
            "desktop_shutdown",
            "stage=backend_force_kill_begin",
        );
        let _ = child.kill();
        let _ = child.wait();
        desktop_diagnostics::append_desktop_diagnostic(
            "desktop_shutdown",
            "stage=backend_force_kill_finished",
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::thread;

    #[test]
    fn private_update_transport_uses_owned_capability_and_bounded_json() {
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            assert_eq!(line, "POST /api/app/update/activate HTTP/1.1\r\n");
            let mut length = 0;
            let mut private = false;
            loop {
                line.clear();
                reader.read_line(&mut line).unwrap();
                if line.trim().is_empty() {
                    break;
                }
                if let Some(value) = line.strip_prefix("Content-Length: ") {
                    length = value.trim().parse::<usize>().unwrap();
                }
                private |= line == "X-Bilikara-Shutdown-Token: fixture-capability\r\n";
            }
            assert!(private);
            let mut body = vec![0; length];
            reader.read_exact(&mut body).unwrap();
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
                serde_json::json!({"operation":7})
            );
            let body = r#"{"ok":true,"data":{"committed":true}}"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
        });
        let backend = BackendProcess {
            child: Arc::new(Mutex::new(None)),
            base_url: Arc::new(Mutex::new(Some(format!("http://{address}")))),
            shutdown_token: "fixture-capability".into(),
            host_cookie: Arc::new(Mutex::new(None)),
            active_downloads: Arc::new(AtomicUsize::new(0)),
        };
        activate_update(&backend, 7).unwrap();
        server.join().unwrap();
    }

    #[test]
    fn desktop_native_capability_handoff_is_explicit() {
        let token = "a".repeat(43);
        let mut ready: ReadyEvent = serde_json::from_value(serde_json::json!({"event":"bilikara.ready","host":"127.0.0.1","port":4567,"baseUrl":"http://127.0.0.1:4567","bootstrapUrl":format!("http://127.0.0.1:4567/bootstrap/{token}")})).unwrap();
        let (url, cookie) = ready_navigation(&ready).unwrap();
        assert!(url.ends_with(&token));
        assert_eq!(cookie, Some(format!("bilikara_native={token}")));
        ready.bootstrap_url = Some(format!("http://192.168.1.2:4567/bootstrap/{token}"));
        assert!(ready_navigation(&ready).is_none());
        ready.bootstrap_url = None;
        assert!(ready_navigation(&ready).is_none());
    }

    #[test]
    fn backend_urls_support_loopback_physical_ipv4_and_ipv6() {
        assert_eq!(
            parse_local_http_url("http://127.0.0.1:8080/"),
            Some(BackendAddress {
                connect_host: "127.0.0.1".to_string(),
                host_header: "127.0.0.1".to_string(),
                port: 8080,
            })
        );
        assert_eq!(
            parse_local_http_url("http://192.168.1.20:4567"),
            Some(BackendAddress {
                connect_host: "192.168.1.20".to_string(),
                host_header: "192.168.1.20".to_string(),
                port: 4567,
            })
        );
        assert_eq!(
            parse_local_http_url("http://[::1]:9090/"),
            Some(BackendAddress {
                connect_host: "::1".to_string(),
                host_header: "[::1]".to_string(),
                port: 9090,
            })
        );
        assert!(parse_local_http_url("https://127.0.0.1:8080/").is_none());
        assert!(parse_local_http_url("http://user@127.0.0.1:8080/").is_none());
    }

    #[test]
    fn window_authorization_compares_exact_normalized_origins() {
        for (window_url, backend_url) in [
            (
                "http://127.0.0.1:8080/route?view=host",
                "http://127.0.0.1:8080",
            ),
            ("http://localhost:8080/", "http://LOCALHOST.:8080/"),
            (
                "http://192.168.1.20:49152/host",
                "http://192.168.1.20:49152/",
            ),
            ("http://[::1]:8080/path", "http://[::1]:8080/"),
        ] {
            assert!(
                window_origin_authorized(window_url, backend_url),
                "{window_url} should match {backend_url}"
            );
        }
        for (window_url, backend_url) in [
            (
                "http://127.0.0.1:8080.evil.invalid/",
                "http://127.0.0.1:8080/",
            ),
            ("http://127.0.0.1:8081/", "http://127.0.0.1:8080/"),
            ("https://127.0.0.1:8080/", "http://127.0.0.1:8080/"),
            ("http://localhost:8080/", "http://127.0.0.1:8080/"),
            ("http://user@127.0.0.1:8080/", "http://127.0.0.1:8080/"),
        ] {
            assert!(
                !window_origin_authorized(window_url, backend_url),
                "{window_url} must not match {backend_url}"
            );
        }
    }

    #[test]
    fn window_shutdown_waits_for_the_in_flight_download_transport() {
        let active_downloads = Arc::new(AtomicUsize::new(0));
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let downloads_for_worker = active_downloads.clone();
        let worker = thread::spawn(move || {
            let _guard = ActiveBackendDownloadGuard::acquire(downloads_for_worker);
            started_tx.send(()).expect("notify worker start");
            release_rx.recv().expect("wait for worker release");
        });
        started_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("worker must hold the download lease");

        let (finished_tx, finished_rx) = std::sync::mpsc::channel();
        let downloads_for_waiter = active_downloads.clone();
        let waiter = thread::spawn(move || {
            wait_for_active_backend_downloads(&downloads_for_waiter, Duration::from_secs(1));
            finished_tx.send(()).expect("notify waiter completion");
        });
        assert!(finished_rx.recv_timeout(Duration::from_millis(50)).is_err());
        release_tx.send(()).expect("release worker");
        finished_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("waiter must proceed after the transport completes");
        worker.join().expect("join worker");
        waiter.join().expect("join waiter");
    }

    #[test]
    fn window_shutdown_download_wait_is_bounded() {
        let active_downloads = AtomicUsize::new(1);
        let started = Instant::now();

        wait_for_active_backend_downloads(&active_downloads, Duration::from_millis(40));

        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn readiness_marker_is_written_and_flushed() {
        let mut buf = Vec::new();
        write_and_flush_ready_marker(&mut buf, "http://127.0.0.1:5678").unwrap();
        assert_eq!(
            String::from_utf8(buf).unwrap(),
            "Backend ready at http://127.0.0.1:5678\n"
        );
    }

    #[test]
    fn stdout_reader_handles_ready_once_and_drains_until_eof() {
        let input = concat!(
            "ordinary before\n",
            "{malformed ready\n",
            "{\"event\":\"bilikara.ready\",\"host\":\"127.0.0.1\",\"port\":8080,\"baseUrl\":\"http://127.0.0.1:8080\"}\n",
            "ordinary after\n",
            "{\"event\":\"bilikara.ready\",\"host\":\"127.0.0.1\",\"port\":9090,\"baseUrl\":\"http://127.0.0.1:9090\"}\n",
        );
        let mut ready_urls = Vec::new();
        let mut output = Vec::new();
        drain_backend_stdout(
            Cursor::new(input.as_bytes()),
            |ready| ready_urls.push(ready.base_url),
            |line| output.push(line),
        )
        .expect("EOF ends cleanly");

        assert_eq!(ready_urls, ["http://127.0.0.1:8080"]);
        assert_eq!(output[0], "ordinary before");
        assert_eq!(output[1], "{malformed ready");
        assert_eq!(output[2], "ordinary after");
        assert!(
            output[3].contains("9090"),
            "duplicate readiness is still drained"
        );
    }

    #[test]
    fn stdout_reader_keeps_draining_after_desktop_stdout_breaks() {
        struct BrokenPipeWriter {
            writes: usize,
        }

        impl Write for BrokenPipeWriter {
            fn write(&mut self, _buffer: &[u8]) -> io::Result<usize> {
                self.writes += 1;
                Err(io::ErrorKind::BrokenPipe.into())
            }

            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }

        let mut writer = BrokenPipeWriter { writes: 0 };
        let mut drained = Vec::new();

        drain_backend_stdout(
            Cursor::new(b"first\nsecond\n"),
            |_| panic!("unexpected ready marker"),
            |line| {
                forward_backend_stdout_line(&mut writer, &line);
                drained.push(line);
            },
        )
        .expect("backend stdout reaches EOF");

        assert_eq!(writer.writes, 2);
        assert_eq!(drained, ["first", "second"]);
    }

    #[test]
    fn backend_candidate_validation_and_precedence() {
        let temp_dir = std::env::temp_dir().join(format!("bilikara_test_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&temp_dir);
        let dummy_exe = temp_dir.join("current_exe");
        let _ = std::fs::write(&dummy_exe, b"test");
        let canonical_dummy_exe = dummy_exe.canonicalize().unwrap();
        let noncanonical_dummy_exe = temp_dir.join(".").join("current_exe");

        assert!(!is_backend_candidate(&temp_dir, &dummy_exe));
        assert!(!is_backend_candidate(&dummy_exe, &dummy_exe));
        assert!(!is_backend_candidate(
            &canonical_dummy_exe,
            &noncanonical_dummy_exe
        ));
        assert!(!is_backend_candidate(
            &noncanonical_dummy_exe,
            &canonical_dummy_exe
        ));
        assert!(!is_backend_candidate(
            &temp_dir.join("nonexistent"),
            &dummy_exe
        ));

        let non_exec = temp_dir.join("non_exec_binary");
        let _ = std::fs::write(&non_exec, b"binary content");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&non_exec).unwrap().permissions();
            perms.set_mode(0o644);
            let _ = std::fs::set_permissions(&non_exec, perms);
            assert!(!is_backend_candidate(&non_exec, &dummy_exe));
        }

        let exec_bin = temp_dir.join("exec_binary");
        let _ = std::fs::write(&exec_bin, b"binary content");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&exec_bin).unwrap().permissions();
            perms.set_mode(0o755);
            let _ = std::fs::set_permissions(&exec_bin, perms);
            assert!(is_backend_candidate(&exec_bin, &dummy_exe));
        }

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn packaged_directory_resolves_contained_executable_without_python() {
        let directory = std::env::temp_dir().join(format!(
            "bilikara_linux_package_{}_{}",
            std::process::id(),
            unique_timestamp_millis()
        ));
        fs::create_dir_all(&directory).unwrap();
        let desktop = directory.join("bilikara-desktop");
        let backend = directory.join("_internal").join(if cfg!(windows) {
            "bilikara-desktop-host.exe"
        } else {
            "bilikara-desktop-host"
        });
        fs::create_dir(backend.parent().unwrap()).unwrap();
        fs::write(&desktop, b"desktop").unwrap();
        fs::write(&backend, b"backend").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&backend, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let resolution = resolve_backend_command_from(&desktop, &directory, false).unwrap();
        assert_eq!(resolution.candidate_type, "native-contained");
        assert_eq!(
            PathBuf::from(resolution.command),
            backend.canonicalize().unwrap()
        );
        assert!(resolution.args.is_empty());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn packaged_macos_resolves_embedded_backend_without_sibling_or_path() {
        let temp_dir = std::env::temp_dir().join(format!(
            "bilikara_embedded_backend_test_{}_{}",
            std::process::id(),
            unique_timestamp_millis()
        ));
        let desktop_exe = temp_dir
            .join("translocated")
            .join("Bilikara-Desktop.app")
            .join("Contents")
            .join("MacOS")
            .join("bilikara");
        let embedded_backend = temp_dir
            .join("translocated")
            .join("Bilikara-Desktop.app")
            .join("Contents")
            .join("Frameworks")
            .join("bilikara-backend.app")
            .join("Contents")
            .join("MacOS")
            .join("bilikara-desktop-host");
        fs::create_dir_all(desktop_exe.parent().expect("desktop parent"))
            .expect("create desktop directory");
        fs::create_dir_all(embedded_backend.parent().expect("backend parent"))
            .expect("create embedded backend directory");
        fs::write(&desktop_exe, b"desktop").expect("write desktop executable");
        fs::write(&embedded_backend, b"backend").expect("write backend executable");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = fs::metadata(&embedded_backend)
                .expect("backend metadata")
                .permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(&embedded_backend, permissions).expect("mark backend executable");
        }

        let resolution = resolve_backend_command_from(
            &desktop_exe,
            desktop_exe.parent().expect("desktop executable directory"),
            true,
        )
        .expect("packaged resolution");
        assert_eq!(resolution.candidate_type, "macos-embedded-backend");
        assert_eq!(
            PathBuf::from(resolution.command),
            embedded_backend.canonicalize().unwrap()
        );
        assert!(resolution.args.is_empty());
        assert!(!temp_dir.join("translocated").join("bilikara.app").exists());

        fs::remove_dir_all(temp_dir).expect("remove embedded backend test directory");
    }

    #[test]
    fn packaged_macos_missing_embedded_backend_never_falls_back_to_python() {
        let temp_dir = std::env::temp_dir().join(format!(
            "bilikara_missing_backend_test_{}_{}",
            std::process::id(),
            unique_timestamp_millis()
        ));
        let desktop_exe = temp_dir
            .join("Bilikara-Desktop.app")
            .join("Contents")
            .join("MacOS")
            .join("bilikara");
        fs::create_dir_all(desktop_exe.parent().expect("desktop parent"))
            .expect("create desktop directory");
        fs::write(&desktop_exe, b"desktop").expect("write desktop executable");
        fs::write(temp_dir.join("start_bilikara.py"), b"print('dev')")
            .expect("write development launcher decoy");

        let missing = resolve_backend_command_from(
            &desktop_exe,
            desktop_exe.parent().expect("desktop executable directory"),
            true,
        )
        .expect_err("missing packaged backend must fail closed");
        assert_eq!(missing.candidate_type, "macos-embedded-backend");
        assert!(!missing.candidate_exists);
        assert!(!missing.candidate_executable);
        assert!(
            missing
                .command_path
                .ends_with("bilikara-backend.app/Contents/MacOS/bilikara-desktop-host")
        );

        fs::remove_dir_all(temp_dir).expect("remove missing backend test directory");
    }

    #[test]
    fn missing_native_backend_never_uses_a_development_or_legacy_launcher() {
        let temp_dir = std::env::temp_dir().join(format!(
            "bilikara_dev_backend_test_{}_{}",
            std::process::id(),
            unique_timestamp_millis()
        ));
        let target_dir = temp_dir.join("src-tauri").join("target").join("release");
        fs::create_dir_all(&target_dir).expect("create source target directory");
        let desktop_exe = target_dir.join("bilikara");
        fs::write(&desktop_exe, b"desktop").expect("write desktop executable");
        let launcher = temp_dir.join("start_bilikara.py");
        fs::write(&launcher, b"print('dev')").expect("write development launcher");

        fs::write(target_dir.join("bilikara.exe"), b"legacy frozen backend").unwrap();
        let missing = resolve_backend_command_from(&desktop_exe, &target_dir, false)
            .expect_err("missing native backend fails closed, even in a checkout");
        assert_eq!(missing.candidate_type, "native-contained");
        assert!(!missing.candidate_exists);

        fs::remove_dir_all(temp_dir).expect("remove development backend test directory");
    }

    fn unique_timestamp_millis() -> u128 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or_default()
    }
}
