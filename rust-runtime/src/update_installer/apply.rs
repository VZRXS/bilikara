//! The external desktop updater: replaces an installation after its owners exit.
//!
//! The Host validates the downloaded package, then starts a copy of the
//! installed `bilikara-updater` from the update workspace with a plan. This
//! module is that program's logic. It never kills an owner. Startup validates
//! the plan and pins owners before acknowledging readiness. Replacement runs
//! after both owners exit. Before any reopen it keeps a timestamped log and a small
//! result under the data root, which the next Host start reports once.
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

pub const PLAN_FILE: &str = "plan.json";
pub const LOG_FILE: &str = "apply.log";
pub const RESULT_FILE: &str = "last-result.txt";
const WORKSPACE_LOCK: &str = "updater.lock";

/// The updater's file name in a package for `platform`.
pub fn updater_name(platform: &str) -> &'static str {
    if platform == "windows" {
        "bilikara-updater.exe"
    } else {
        "bilikara-updater"
    }
}
const OWNER_WAIT: Duration = Duration::from_secs(120);
const IN_USE_RETRIES: u32 = 30;

/// Written by the Host into the update workspace; read only by the updater.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Plan {
    pub schema_version: u32,
    pub platform: String,
    pub operation: String,
    /// Validated payload inside the workspace.
    pub source: PathBuf,
    /// The installation to replace: a Windows directory or a macOS `.app`.
    pub destination: PathBuf,
    pub workspace: PathBuf,
    /// Kept log and result for the next Host start.
    pub reports: PathBuf,
    /// Installation-relative directories carried into the new installation.
    pub preserve: Vec<String>,
    pub wait_pids: Vec<u32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// File replacement succeeded; this does not prove application readiness.
    Installed,
    Failed,
    /// An owner outlived the wait; nothing changed and nothing is reopened.
    OwnersRunning,
}
impl Outcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Installed => "installed",
            Self::Failed => "failed",
            Self::OwnersRunning => "owners_running",
        }
    }
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

impl Plan {
    fn incoming(&self) -> PathBuf {
        sibling(&self.destination, &format!("incoming-{}", self.operation))
    }
    fn previous(&self) -> PathBuf {
        sibling(&self.destination, &format!("previous-{}", self.operation))
    }

    /// Structural checks only: the Host is the trust boundary that validated
    /// the package. These keep a damaged or mismatched plan from touching
    /// anything outside the installation and its own workspace.
    pub fn validate(&self, plan_path: &Path) -> io::Result<()> {
        let safe_name = |name: &str| {
            !name.is_empty()
                && name.len() <= 96
                && name
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"-_".contains(&c))
        };
        if self.schema_version != 1
            || !matches!(self.platform.as_str(), "windows" | "macos")
            || !safe_name(&self.operation)
            || !self.operation.starts_with("update-")
            || self.preserve.iter().any(|name| !safe_name(name))
            || self.wait_pids.is_empty()
            || self.wait_pids.contains(&0)
        {
            return Err(invalid("update plan fields are invalid"));
        }
        for path in [
            &self.source,
            &self.destination,
            &self.workspace,
            &self.reports,
        ] {
            if !path.is_absolute() {
                return Err(invalid("update plan paths must be absolute"));
            }
        }
        if plan_path.parent() != Some(self.workspace.as_path())
            || self.workspace.file_name().and_then(|n| n.to_str()) != Some(self.operation.as_str())
            || !self.source.starts_with(&self.workspace)
            || self.workspace.starts_with(&self.destination)
            || self.destination.starts_with(&self.workspace)
            || self.destination.parent().is_none()
        {
            return Err(invalid("update plan paths do not belong together"));
        }
        if self.platform == "macos"
            && self.destination.extension().and_then(|e| e.to_str()) != Some("app")
        {
            return Err(invalid("macOS updates replace an app bundle"));
        }
        Ok(())
    }
}

fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".");
    name.push(suffix);
    path.with_file_name(name)
}

/// Append-only, timestamped log in the workspace, copied into `reports`.
pub struct Log {
    path: PathBuf,
}
impl Log {
    pub fn create(workspace: &Path) -> io::Result<Self> {
        let path = workspace.join(LOG_FILE);
        fs::File::create(&path)?;
        Ok(Self { path })
    }
    pub fn line(&self, message: impl AsRef<str>) {
        let stamp = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%.3f%:z");
        if let Ok(mut file) = fs::OpenOptions::new().append(true).open(&self.path) {
            let _ = writeln!(file, "[{stamp}] {}", message.as_ref());
        }
    }
}

/// Keep replacement and restart results separate: a failed reopen must not
/// undo an installed package or hide the reason from the next manual launch.
fn report(plan: &Plan, log: &Log, outcome: Outcome, relaunch_failed: bool) {
    log.line(format!("result: {}", outcome.as_str()));
    let reports = report_directory(plan);
    if reports != plan.reports {
        log.line(format!(
            "installation not restored; keeping recovery report at {}",
            reports.display()
        ));
    }
    let kept = (|| {
        fs::create_dir_all(&reports)?;
        fs::copy(&log.path, reports.join(format!("{}.log", plan.operation)))?;
        // Written last and replaced atomically: a reader never sees half.
        let partial = reports.join(format!("{RESULT_FILE}.partial"));
        fs::write(
            &partial,
            format!(
                "operation={}\nresult={}\n{}",
                plan.operation,
                outcome.as_str(),
                if relaunch_failed {
                    "relaunch=failed\n"
                } else {
                    ""
                },
            ),
        )?;
        fs::rename(partial, reports.join(RESULT_FILE))
    })();
    if let Err(error) = kept {
        log.line(format!("could not keep the result: {error}"));
    }
}

fn report_directory(plan: &Plan) -> PathBuf {
    // With portable Windows data, a failed restoration leaves that data in
    // the backup. Never recreate an empty destination just to write a log:
    // that would obstruct recovery and look like a launchable installation.
    if !plan.destination.is_dir()
        && let Ok(relative) = plan.reports.strip_prefix(&plan.destination)
    {
        let previous = plan.previous();
        return if previous.is_dir() {
            previous.join(relative)
        } else {
            plan.workspace.join("recovery-report")
        };
    }
    plan.reports.clone()
}

/// Retry an operation while the OS reports the target as in use.
fn retry_in_use<T>(
    log: &Log,
    what: &str,
    mut operation: impl FnMut() -> io::Result<T>,
) -> io::Result<T> {
    let mut attempt = 0;
    loop {
        match operation() {
            Ok(value) => return Ok(value),
            Err(error) if attempt < IN_USE_RETRIES && in_use(&error) => {
                attempt += 1;
                if attempt == 1 || attempt % 10 == 0 {
                    log.line(format!("{what} is in use, retrying ({error})"));
                }
                std::thread::sleep(Duration::from_secs(1));
            }
            Err(error) => return Err(error),
        }
    }
}

fn in_use(error: &io::Error) -> bool {
    // Windows sharing/lock violations and access denied for an open folder.
    matches!(error.raw_os_error(), Some(5 | 32 | 33))
        || error.kind() == io::ErrorKind::PermissionDenied
}

/// Copy a tree, recreating relative symbolic links and Unix permissions.
fn copy_tree(source: &Path, target: &Path, log: &Log) -> io::Result<()> {
    fs::create_dir(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let from = entry.path();
        let to = target.join(entry.file_name());
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            #[cfg(unix)]
            std::os::unix::fs::symlink(fs::read_link(&from)?, &to)?;
            #[cfg(not(unix))]
            return Err(invalid("installations must not contain links"));
        } else if kind.is_dir() {
            copy_tree(&from, &to, log)?;
        } else {
            retry_in_use(log, &from.display().to_string(), || fs::copy(&from, &to))?;
        }
    }
    #[cfg(unix)]
    fs::set_permissions(target, fs::metadata(source)?.permissions())?;
    Ok(())
}

/// Replace the installation. `wait` and `relaunch` are the OS primitives;
/// tests substitute recorders for the relaunch and real processes for owners.
pub fn apply(
    plan: &Plan,
    log: &Log,
    wait: impl Fn(&[u32], Duration) -> io::Result<bool>,
    relaunch: impl Fn(&Path) -> io::Result<()>,
) -> Outcome {
    apply_with_rename(plan, log, wait, relaunch, |from, to| fs::rename(from, to))
}

fn apply_with_rename(
    plan: &Plan,
    log: &Log,
    wait: impl Fn(&[u32], Duration) -> io::Result<bool>,
    relaunch: impl Fn(&Path) -> io::Result<()>,
    mut rename: impl FnMut(&Path, &Path) -> io::Result<()>,
) -> Outcome {
    log.line(format!(
        "updater {} started for {}",
        env!("CARGO_PKG_VERSION"),
        plan.operation
    ));
    match wait(&plan.wait_pids, OWNER_WAIT) {
        Ok(true) => log.line("owners exited"),
        Ok(false) => {
            log.line("an owner did not exit in time; nothing was changed");
            report(plan, log, Outcome::OwnersRunning, false);
            return Outcome::OwnersRunning;
        }
        Err(error) => {
            log.line(format!(
                "could not inspect the owners ({error}); nothing was changed"
            ));
            report(plan, log, Outcome::OwnersRunning, false);
            return Outcome::OwnersRunning;
        }
    }
    let incoming = plan.incoming();
    let previous = plan.previous();
    let mut created = false;
    let replaced = (|| -> Result<(), String> {
        if incoming.exists() || previous.exists() {
            return Err("an incoming or backup directory already exists".into());
        }
        created = true;
        copy_tree(&plan.source, &incoming, log)
            .map_err(|e| format!("copying the new package failed: {e}"))?;
        for name in &plan.preserve {
            let kept = plan.destination.join(name);
            if kept.is_dir() {
                copy_tree(&kept, &incoming.join(name), log)
                    .map_err(|e| format!("copying {name} failed: {e}"))?;
            }
        }
        retry_in_use(log, "the installation", || {
            rename(&plan.destination, &previous)
        })
        .map_err(|e| format!("the installation stayed in use: {e}"))?;
        if let Err(error) = retry_in_use(log, "the new installation", || {
            rename(&incoming, &plan.destination)
        }) {
            log.line(format!(
                "moving the new installation failed ({error}), restoring"
            ));
            retry_in_use(log, "restoring the previous installation", || {
                rename(&previous, &plan.destination)
            })
            .map_err(|e| {
                format!(
                    "restoring the previous installation failed: {e}; backup: {}",
                    previous.display()
                )
            })?;
            return Err("the new installation could not be moved into place".into());
        }
        Ok(())
    })();
    let outcome = match replaced {
        Ok(()) => {
            log.line(format!(
                "installed, previous installation kept at {}",
                previous.display()
            ));
            Outcome::Installed
        }
        Err(message) => {
            log.line(message);
            if created && incoming.exists() && plan.destination.is_dir() {
                let _ = fs::remove_dir_all(&incoming);
            }
            log.line(if plan.destination.is_dir() {
                "replacement failed, relaunching the previous installation".to_owned()
            } else {
                format!(
                    "replacement failed; backup and staged package retained for manual recovery: {}, {}",
                    previous.display(), incoming.display(),
                )
            });
            Outcome::Failed
        }
    };
    report(plan, log, outcome, false);
    if !plan.destination.is_dir() {
        return outcome;
    }
    if let Err(error) = relaunch(&plan.destination) {
        log.line(format!("relaunching failed: {error}"));
        report(plan, log, outcome, true);
    }
    outcome
}

/// Wait until every owner has exited, without ever signalling one.
pub fn wait_for_owners(pids: &[u32], timeout: Duration) -> io::Result<bool> {
    Owners::open(pids)?.wait(timeout)
}

struct Owners {
    #[cfg(windows)]
    handles: Vec<windows_sys::Win32::Foundation::HANDLE>,
    #[cfg(unix)]
    pids: Vec<libc::pid_t>,
}

#[cfg(windows)]
impl Drop for Owners {
    fn drop(&mut self) {
        for &handle in &self.handles {
            // SAFETY: each handle came from OpenProcess and is closed once.
            unsafe { windows_sys::Win32::Foundation::CloseHandle(handle) };
        }
    }
}

impl Owners {
    fn open(pids: &[u32]) -> io::Result<Self> {
        #[cfg(windows)]
        {
            use windows_sys::Win32::Foundation::{ERROR_INVALID_PARAMETER, GetLastError};
            use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE};
            // Pin every owner's identity first, while they are still running, so
            // a reused PID can never be mistaken for an owner later.
            let mut owned = Self {
                handles: Vec::new(),
            };
            for &pid in pids {
                // SAFETY: documented Win32 call; the handle is owned by `owned`.
                let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
                if handle.is_null() {
                    // An absent process is the only accepted "already exited".
                    if unsafe { GetLastError() } == ERROR_INVALID_PARAMETER {
                        continue;
                    }
                    return Err(io::Error::last_os_error());
                }
                owned.handles.push(handle);
            }
            Ok(owned)
        }
        #[cfg(unix)]
        {
            let pids = pids
                .iter()
                .map(|&pid| {
                    libc::pid_t::try_from(pid)
                        .ok()
                        .filter(|pid| *pid > 0)
                        .ok_or_else(|| invalid("invalid owner PID"))
                })
                .collect::<io::Result<Vec<_>>>()?;
            Ok(Self { pids })
        }
    }

    fn wait(&self, timeout: Duration) -> io::Result<bool> {
        let deadline = Instant::now() + timeout;
        #[cfg(windows)]
        {
            use windows_sys::Win32::Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT};
            use windows_sys::Win32::System::Threading::WaitForSingleObject;
            for &handle in &self.handles {
                let remaining = deadline.saturating_duration_since(Instant::now());
                // SAFETY: a live handle owned above.
                let status = unsafe {
                    WaitForSingleObject(
                        handle,
                        remaining.as_millis().min(u32::MAX as u128 - 1) as u32,
                    )
                };
                match status {
                    WAIT_OBJECT_0 => {}
                    WAIT_TIMEOUT => return Ok(false),
                    _ => return Err(io::Error::last_os_error()),
                }
            }
            Ok(true)
        }
        #[cfg(unix)]
        {
            for &pid in &self.pids {
                loop {
                    // SAFETY: signal 0 performs only an existence/permission check.
                    if unsafe { libc::kill(pid, 0) } != 0 {
                        let error = io::Error::last_os_error();
                        if error.raw_os_error() == Some(libc::ESRCH) {
                            break;
                        }
                        return Err(error);
                    }
                    if Instant::now() >= deadline {
                        return Ok(false);
                    }
                    std::thread::sleep(Duration::from_millis(200));
                }
            }
            Ok(true)
        }
    }
}

/// Variables the old shell gave only its own Host; a relaunched shell creates
/// its own. User overrides such as `BILIKARA_NATIVE_DATA_DIR` remain.
pub const HOST_PRIVATE_ENV: [&str; 6] = [
    "BILIKARA_LAUNCH_MODE",
    "BILIKARA_DESKTOP_PID",
    "BILIKARA_DESKTOP_EXECUTABLE",
    "BILIKARA_SHUTDOWN_TOKEN",
    "BILIKARA_STARTUP_LOG",
    "BILIKARA_DESKTOP_STARTUP_LOG",
];

/// Open the installed application as a new, unrelated process.
pub fn relaunch(destination: &Path) -> io::Result<()> {
    #[cfg(target_os = "macos")]
    {
        let mut open = std::process::Command::new("/usr/bin/open");
        for key in HOST_PRIVATE_ENV {
            open.env_remove(key);
        }
        let status = open
            .arg(destination)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()?;
        if status.success() {
            Ok(())
        } else {
            Err(io::Error::other(format!("open exited with {status}")))
        }
    }
    #[cfg(windows)]
    {
        // vars_os: a non-Unicode variable must not stop the relaunch.
        let mut environment: Vec<(std::ffi::OsString, std::ffi::OsString)> = std::env::vars_os()
            .filter(|(key, _)| {
                !HOST_PRIVATE_ENV
                    .iter()
                    .any(|k| key.to_str().is_some_and(|key| k.eq_ignore_ascii_case(key)))
            })
            .collect();
        // CreateProcess expects the block sorted case-insensitively by name.
        environment.sort_by_key(|(key, _)| key.to_string_lossy().to_uppercase());
        windows::spawn_detached(
            &destination.join("bilikara-desktop.exe"),
            &[],
            destination.parent().unwrap_or(destination),
            Some(&environment),
        )
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = destination;
        Err(io::Error::other("desktop updates are not supported here"))
    }
}

/// The updater's entry: read the plan beside it, apply it, report, exit.
pub fn run_from_plan(plan_path: &Path) -> io::Result<Outcome> {
    let handoff = super::handoff::Handoff::receive(
        plan_path
            .parent()
            .ok_or_else(|| invalid("missing workspace"))?,
    )?;
    let started = (|| {
        let plan: Plan = serde_json::from_slice(&fs::read(plan_path)?)
            .map_err(|e| invalid(&format!("unreadable update plan: {e}")))?;
        plan.validate(plan_path)?;
        // Held until all reporting/relaunch work ends. A newly opened Host
        // must not remove a workspace merely because a result exists already.
        let lease = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(plan.workspace.join(WORKSPACE_LOCK))?;
        fs2::FileExt::try_lock_exclusive(&lease)?;
        let log = Log::create(&plan.workspace)?;
        if !plan.source.is_dir() || !plan.destination.is_dir() {
            return Err(invalid("update source or installation is missing"));
        }
        let owners = Owners::open(&plan.wait_pids)?;
        if let Some(handoff) = &handoff {
            handoff.ready()?;
            log.line("Host acknowledged updater readiness");
        }
        Ok((plan, log, owners, lease))
    })();
    let (plan, log, owners, lease) = match started {
        Ok(started) => started,
        Err(error) => {
            if let Some(handoff) = &handoff {
                handoff.reject(&error);
            }
            return Err(error);
        }
    };
    // This is the standalone program's one-shot entry. Keep the lease until
    // OS process teardown, including the return to main: on Windows the EXE
    // can still be in use after this function returns. No handles are inherited
    // by the new application. The OS closes this file on updater exit.
    std::mem::forget(lease);
    let outcome = apply(&plan, &log, |_, timeout| owners.wait(timeout), relaunch);
    // The log is kept under `reports`. The running updater lives in the
    // workspace: Unix may unlink it now; Windows cannot, so the next Host
    // start removes that workspace when it reads the result.
    #[cfg(unix)]
    if outcome != Outcome::OwnersRunning && plan.destination.is_dir() {
        let _ = fs::remove_dir_all(&plan.workspace);
    }
    Ok(outcome)
}

/// Remove only an owned, finished workspace. Missing leases from older helpers
/// are retained: a marker alone is not evidence that its writer has stopped.
#[cfg(feature = "native-host")]
pub(crate) fn cleanup_workspace(workspace: &Path, reports: &Path) -> io::Result<()> {
    use std::io::Read;
    if !fs::symlink_metadata(workspace)?.is_dir() {
        return Err(invalid("update workspace is not a directory"));
    }
    let plan_path = workspace.join(PLAN_FILE);
    let mut bytes = Vec::new();
    fs::File::open(&plan_path)?
        .take(64 * 1024)
        .read_to_end(&mut bytes)?;
    let plan: Plan =
        serde_json::from_slice(&bytes).map_err(|_| invalid("unreadable cleanup plan"))?;
    plan.validate(&plan_path)?;
    if plan.reports != reports || !plan.destination.is_dir() {
        return Err(invalid("workspace is unrelated or needed for recovery"));
    }
    let lease = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(workspace.join(WORKSPACE_LOCK))?;
    fs2::FileExt::try_lock_exclusive(&lease)?;
    fs::remove_dir_all(workspace)
}

#[cfg(windows)]
pub mod windows {
    use std::ffi::OsStr;
    use std::io;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    fn wide(text: &OsStr) -> Vec<u16> {
        text.encode_wide().chain(Some(0)).collect()
    }

    /// Quote one argument for the MSVC command-line convention.
    fn quote(argument: &str, line: &mut String) {
        if !argument.is_empty() && !argument.contains([' ', '\t', '"']) {
            line.push_str(argument);
            return;
        }
        line.push('"');
        let mut backslashes = 0;
        for c in argument.chars() {
            match c {
                '\\' => backslashes += 1,
                '"' => {
                    line.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
                    line.push('"');
                    backslashes = 0;
                }
                _ => {
                    line.extend(std::iter::repeat_n('\\', backslashes));
                    line.push(c);
                    backslashes = 0;
                }
            }
        }
        line.extend(std::iter::repeat_n('\\', backslashes * 2));
        line.push('"');
    }

    /// Start a GUI-subsystem program that inherits no handles at all, so a
    /// parent's pipes (for example the Host's stdout to its shell) are never
    /// held open by the updater or the relaunched application. It breaks away
    /// from a kill-on-close job when the caller owns one.
    pub fn spawn_detached(
        program: &Path,
        arguments: &[&OsStr],
        directory: &Path,
        environment: Option<&[(std::ffi::OsString, std::ffi::OsString)]>,
    ) -> io::Result<()> {
        spawn_detached_owned(program, arguments, directory, environment).map(|_| ())
    }

    pub(in crate::update_installer) fn spawn_detached_owned(
        program: &Path,
        arguments: &[&OsStr],
        directory: &Path,
        environment: Option<&[(std::ffi::OsString, std::ffi::OsString)]>,
    ) -> io::Result<Child> {
        use windows_sys::Win32::System::Threading::{
            CREATE_BREAKAWAY_FROM_JOB, CREATE_NEW_PROCESS_GROUP, CREATE_UNICODE_ENVIRONMENT,
            DETACHED_PROCESS,
        };
        let mut line = String::new();
        quote(&program.to_string_lossy(), &mut line);
        for argument in arguments {
            line.push(' ');
            quote(&argument.to_string_lossy(), &mut line);
        }
        let mut line = wide(OsStr::new(&line));
        let application = wide(program.as_os_str());
        let directory = wide(directory.as_os_str());
        let block: Option<Vec<u16>> = environment.map(|pairs| {
            let mut block = Vec::new();
            for (key, value) in pairs {
                block.extend(key.encode_wide());
                block.push(u16::from(b'='));
                block.extend(value.encode_wide());
                block.push(0);
            }
            block.push(0);
            block
        });
        let flags = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_UNICODE_ENVIRONMENT;
        // Fail closed if breakaway is refused. An updater left in the Host's
        // kill-on-close job would be killed exactly when it needs to install.
        let flags = if in_job()? {
            flags | CREATE_BREAKAWAY_FROM_JOB
        } else {
            flags
        };
        create(&application, &mut line, flags, block.as_deref(), &directory)
    }

    pub(in crate::update_installer) struct Child(windows_sys::Win32::Foundation::HANDLE);

    impl Child {
        pub fn exited(&self) -> io::Result<bool> {
            self.wait_for(0)
        }

        fn wait_for(&self, milliseconds: u32) -> io::Result<bool> {
            use windows_sys::Win32::Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT};
            // SAFETY: this process handle is owned until Drop.
            match unsafe {
                windows_sys::Win32::System::Threading::WaitForSingleObject(self.0, milliseconds)
            } {
                WAIT_OBJECT_0 => Ok(true),
                WAIT_TIMEOUT => Ok(false),
                _ => Err(io::Error::last_os_error()),
            }
        }

        pub fn kill(&mut self) -> io::Result<()> {
            if self.exited()? {
                return Ok(());
            }
            // SAFETY: only the updater process we created is terminated.
            if unsafe { windows_sys::Win32::System::Threading::TerminateProcess(self.0, 1) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }

        pub fn wait(&self) -> io::Result<()> {
            if self.wait_for(5000)? {
                Ok(())
            } else {
                Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "updater did not exit",
                ))
            }
        }
    }

    impl Drop for Child {
        fn drop(&mut self) {
            // SAFETY: each owned process handle is closed exactly once.
            unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0) };
        }
    }

    fn create(
        application: &[u16],
        line: &mut [u16],
        flags: u32,
        block: Option<&[u16]>,
        directory: &[u16],
    ) -> io::Result<Child> {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{
            CreateProcessW, PROCESS_INFORMATION, STARTUPINFOW,
        };
        // SAFETY: zeroed POD Win32 structures sized as documented; every
        // buffer is NUL-terminated and outlives the call; handles closed.
        unsafe {
            let mut startup: STARTUPINFOW = std::mem::zeroed();
            startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
            let mut process: PROCESS_INFORMATION = std::mem::zeroed();
            let created = CreateProcessW(
                application.as_ptr(),
                line.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                0, // bInheritHandles: nothing is inherited.
                flags,
                block.map_or(std::ptr::null(), |b| b.as_ptr().cast()),
                directory.as_ptr(),
                &startup,
                &mut process,
            );
            if created == 0 {
                return Err(io::Error::last_os_error());
            }
            CloseHandle(process.hThread);
            Ok(Child(process.hProcess))
        }
    }

    fn in_job() -> io::Result<bool> {
        use windows_sys::Win32::System::JobObjects::IsProcessInJob;
        use windows_sys::Win32::System::Threading::GetCurrentProcess;
        let mut result = 0;
        // SAFETY: the pseudo-handle needs no closing; result is an out BOOL.
        unsafe {
            if IsProcessInJob(GetCurrentProcess(), std::ptr::null_mut(), &mut result) == 0 {
                return Err(io::Error::last_os_error());
            }
        }
        Ok(result != 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::process::{Command, Stdio};

    struct Fixture {
        root: PathBuf,
        plan: Plan,
    }

    fn fixture(platform: &str) -> Fixture {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "bilikara-updater-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&root);
        // Spaces, CJK and CMD metacharacters: no shell ever parses these.
        let base = root.join("更新 测试 (x86) & %PATH% !x!");
        let destination = base.join(if platform == "macos" {
            "bilikara-desktop.app"
        } else {
            "bilikara 安装"
        });
        let workspace = base.join("update-op");
        let source = workspace.join("extracted/bilikara");
        for (path, text) in [
            (destination.join("old-only.txt"), "old"),
            (destination.join("runtime/data/user.json"), "keep"),
            (source.join("new-only.txt"), "new"),
            (source.join("nested/deeper/file.bin"), "nested"),
        ] {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, text).unwrap();
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // Bundles keep relative links and executable bits.
            std::os::unix::fs::symlink("nested/deeper", source.join("link")).unwrap();
            let tool = source.join("tool");
            fs::write(&tool, "#!/bin/sh\n").unwrap();
            fs::set_permissions(&tool, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let plan = Plan {
            schema_version: 1,
            platform: platform.into(),
            operation: "update-op".into(),
            source,
            destination,
            workspace: workspace.clone(),
            reports: base.join("data/update-logs"),
            preserve: if platform == "windows" {
                vec!["runtime".into(), "data".into(), "updates".into()]
            } else {
                vec![]
            },
            wait_pids: vec![u32::MAX - 1],
        };
        Fixture { root, plan }
    }

    /// A real process that exits on its own after about `seconds`.
    fn owner(seconds: u32) -> std::process::Child {
        #[cfg(windows)]
        let mut command = {
            let mut command = Command::new("ping");
            command.args(["-n", &(seconds + 1).to_string(), "127.0.0.1"]);
            command
        };
        #[cfg(unix)]
        let mut command = {
            let mut command = Command::new("/bin/sleep");
            command.arg(seconds.to_string());
            command
        };
        command.stdout(Stdio::null()).spawn().unwrap()
    }

    fn kept(plan: &Plan) -> (String, String) {
        let reports = report_directory(plan);
        (
            fs::read_to_string(reports.join(RESULT_FILE)).unwrap(),
            fs::read_to_string(reports.join("update-op.log")).unwrap(),
        )
    }

    /// Records each relaunch with the result already kept at that moment.
    fn recorder(plan: &Plan) -> (RefCell<Vec<(PathBuf, String)>>, PathBuf) {
        (RefCell::new(Vec::new()), plan.reports.join(RESULT_FILE))
    }

    #[test]
    fn replaces_after_owner_exit_preserves_data_and_reports_before_relaunch() {
        for platform in ["windows", "macos"] {
            let Fixture { root, mut plan } = fixture(platform);
            let mut process = owner(2);
            plan.wait_pids = vec![process.id()];
            // Reap the owner so it does not linger as a zombie on Unix.
            let reaper = std::thread::spawn(move || process.wait().unwrap());
            let log = Log::create(&plan.workspace).unwrap();
            let (relaunched, result) = recorder(&plan);
            let started = Instant::now();
            let outcome = apply(&plan, &log, wait_for_owners, |path| {
                relaunched
                    .borrow_mut()
                    .push((path.to_owned(), fs::read_to_string(&result).unwrap()));
                Ok(())
            });
            reaper.join().unwrap();
            assert_eq!(outcome, Outcome::Installed, "{platform}");
            assert!(started.elapsed() >= Duration::from_millis(1500));
            let dst = &plan.destination;
            assert_eq!(fs::read_to_string(dst.join("new-only.txt")).unwrap(), "new");
            assert_eq!(
                fs::read_to_string(dst.join("nested/deeper/file.bin")).unwrap(),
                "nested"
            );
            assert!(!dst.join("old-only.txt").exists());
            // Portable Windows data is carried over; macOS data lives elsewhere.
            assert_eq!(
                dst.join("runtime/data/user.json").exists(),
                platform == "windows"
            );
            let previous = plan.previous();
            assert_eq!(
                fs::read_to_string(previous.join("old-only.txt")).unwrap(),
                "old"
            );
            assert_eq!(
                fs::read_to_string(previous.join("runtime/data/user.json")).unwrap(),
                "keep"
            );
            assert!(!plan.incoming().exists());
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(
                    fs::read_link(dst.join("link")).unwrap(),
                    Path::new("nested/deeper")
                );
                let mode = fs::metadata(dst.join("tool")).unwrap().permissions().mode();
                assert_eq!(mode & 0o111, 0o111);
            }
            let (result, kept_log) = kept(&plan);
            assert_eq!(result, "operation=update-op\nresult=installed\n");
            assert!(kept_log.starts_with("[20"), "{kept_log}");
            assert!(kept_log.contains("] owners exited\n"), "{kept_log}");
            assert!(kept_log.contains("] installed, previous installation kept at"));
            assert_eq!(*relaunched.borrow(), [(dst.clone(), result)]);
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn relaunch_failure_keeps_installed_files_and_reports_the_distinct_failure() {
        let Fixture { root, plan } = fixture("windows");
        let log = Log::create(&plan.workspace).unwrap();
        let outcome = apply(
            &plan,
            &log,
            |_, _| Ok(true),
            |_| Err(io::Error::other("fixture: application could not start")),
        );
        assert_eq!(outcome, Outcome::Installed);
        assert_eq!(
            fs::read_to_string(plan.destination.join("new-only.txt")).unwrap(),
            "new"
        );
        assert_eq!(
            fs::read_to_string(plan.destination.join("runtime/data/user.json")).unwrap(),
            "keep"
        );
        assert_eq!(
            fs::read_to_string(plan.previous().join("old-only.txt")).unwrap(),
            "old"
        );
        let (result, kept_log) = kept(&plan);
        assert_eq!(
            result,
            "operation=update-op\nresult=installed\nrelaunch=failed\n"
        );
        assert!(kept_log.contains("relaunching failed: fixture: application could not start"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failure_before_commit_reopens_the_untouched_installation() {
        let Fixture { root, mut plan } = fixture("windows");
        // An owner that already exited (and was reaped) is not waited for.
        let mut process = owner(0);
        process.wait().unwrap();
        plan.wait_pids = vec![process.id()];
        fs::remove_dir_all(&plan.source).unwrap();
        let log = Log::create(&plan.workspace).unwrap();
        let (relaunched, result) = recorder(&plan);
        let outcome = apply(&plan, &log, wait_for_owners, |path| {
            relaunched
                .borrow_mut()
                .push((path.to_owned(), fs::read_to_string(&result).unwrap()));
            Ok(())
        });
        assert_eq!(outcome, Outcome::Failed);
        let dst = &plan.destination;
        assert_eq!(fs::read_to_string(dst.join("old-only.txt")).unwrap(), "old");
        assert_eq!(
            fs::read_to_string(dst.join("runtime/data/user.json")).unwrap(),
            "keep"
        );
        assert!(!plan.incoming().exists() && !plan.previous().exists());
        let (result, kept_log) = kept(&plan);
        assert_eq!(result, "operation=update-op\nresult=failed\n");
        assert!(
            kept_log.contains("] copying the new package failed"),
            "{kept_log}"
        );
        assert!(kept_log.contains("] replacement failed, relaunching the previous installation"));
        assert_eq!(*relaunched.borrow(), [(dst.clone(), result)]);
        // A failed relaunch is recorded in the kept log, not lost.
        let log = Log::create(&plan.workspace).unwrap();
        apply(&plan, &log, wait_for_owners, |_| {
            Err(io::Error::other("no shell"))
        });
        assert!(kept(&plan).1.contains("] relaunching failed: no shell"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn owners_that_stay_running_change_nothing_and_reopen_nothing() {
        let Fixture { root, mut plan } = fixture("windows");
        let mut exited = owner(0);
        exited.wait().unwrap();
        let mut process = owner(30);
        plan.wait_pids = vec![exited.id(), process.id()];
        let log = Log::create(&plan.workspace).unwrap();
        let outcome = apply(
            &plan,
            &log,
            |pids, _| wait_for_owners(pids, Duration::from_millis(600)),
            |_| panic!("a running owner must not be joined by a second instance"),
        );
        assert!(
            process.try_wait().unwrap().is_none(),
            "timeout must not kill an owner"
        );
        process.kill().unwrap();
        process.wait().unwrap();
        assert_eq!(outcome, Outcome::OwnersRunning);
        assert_eq!(
            fs::read_to_string(plan.destination.join("old-only.txt")).unwrap(),
            "old"
        );
        assert!(!plan.incoming().exists() && !plan.previous().exists());
        let (result, kept_log) = kept(&plan);
        assert_eq!(result, "operation=update-op\nresult=owners_running\n");
        assert!(kept_log.contains("] an owner did not exit in time"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn plans_that_do_not_belong_together_are_refused() {
        let Fixture { root, plan } = fixture("windows");
        let path = plan.workspace.join(PLAN_FILE);
        plan.validate(&path).unwrap();
        let mut cases: Vec<Plan> = Vec::new();
        let mut push = |change: &dyn Fn(&mut Plan)| {
            let mut changed = plan.clone();
            change(&mut changed);
            cases.push(changed);
        };
        push(&|p| p.schema_version = 2);
        push(&|p| p.platform = "linux".into());
        push(&|p| p.operation = "../escape".into());
        push(&|p| p.operation = "operation".into());
        push(&|p| p.preserve = vec!["../data".into()]);
        push(&|p| p.wait_pids = vec![]);
        push(&|p| p.source = p.destination.join("payload"));
        push(&|p| p.destination = p.workspace.join("inside"));
        push(&|p| p.workspace = p.destination.join("update-op"));
        push(&|p| p.reports = PathBuf::from("relative/update-logs"));
        push(&|p| {
            p.platform = "macos".into();
        });
        for case in cases {
            assert!(case.validate(&path).is_err(), "{case:?}");
        }
        assert!(plan.validate(&root.join(PLAN_FILE)).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn replacement_and_rollback_retry_locks_and_keep_recoverable_files() {
        for scenario in ["new_locked", "rollback_locked", "rollback_failed"] {
            let Fixture { root, mut plan } = fixture("windows");
            if scenario == "rollback_failed" {
                plan.reports = plan.destination.join("runtime/data/update-logs");
            }
            let log = Log::create(&plan.workspace).unwrap();
            let relaunched = RefCell::new(Vec::new());
            let mut incoming_attempts = 0;
            let mut restoring_attempts = 0;
            let outcome = apply_with_rename(
                &plan,
                &log,
                |_, _| Ok(true),
                |path| {
                    relaunched.borrow_mut().push(path.to_owned());
                    Ok(())
                },
                |from, to| {
                    if from == plan.incoming() {
                        incoming_attempts += 1;
                        if scenario != "new_locked" {
                            return Err(io::Error::other("injected replacement failure"));
                        }
                        if incoming_attempts == 1 {
                            return Err(io::Error::from(io::ErrorKind::PermissionDenied));
                        }
                    }
                    if from == plan.previous() {
                        restoring_attempts += 1;
                        if scenario == "rollback_failed" {
                            return Err(io::Error::other("injected restoration failure"));
                        }
                        if restoring_attempts == 1 {
                            return Err(io::Error::from(io::ErrorKind::PermissionDenied));
                        }
                    }
                    fs::rename(from, to)
                },
            );
            assert_eq!(
                outcome,
                if scenario == "new_locked" {
                    Outcome::Installed
                } else {
                    Outcome::Failed
                }
            );
            let kept_data = if scenario == "rollback_failed" {
                plan.previous()
            } else {
                plan.destination.clone()
            };
            assert_eq!(
                fs::read_to_string(kept_data.join("runtime/data/user.json")).unwrap(),
                "keep"
            );
            match scenario {
                "new_locked" => {
                    assert_eq!(incoming_attempts, 2);
                    assert!(plan.destination.join("new-only.txt").is_file());
                }
                "rollback_locked" => {
                    assert_eq!(restoring_attempts, 2);
                    assert!(plan.destination.join("old-only.txt").is_file());
                    assert!(!plan.incoming().exists());
                }
                _ => {
                    assert!(relaunched.borrow().is_empty());
                    assert!(!plan.destination.exists());
                    assert!(plan.previous().join("old-only.txt").is_file());
                    assert!(plan.incoming().join("new-only.txt").is_file());
                    assert_eq!(
                        fs::read_to_string(
                            plan.previous()
                                .join("runtime/data/update-logs/last-result.txt")
                        )
                        .unwrap(),
                        "operation=update-op\nresult=failed\n",
                    );
                    assert!(kept(&plan).1.contains("backup and staged package retained"));
                }
            }
            if scenario != "rollback_failed" {
                assert_eq!(
                    relaunched.borrow().as_slice(),
                    std::slice::from_ref(&plan.destination)
                );
            }
            fs::remove_dir_all(root).unwrap();
        }
    }
}
