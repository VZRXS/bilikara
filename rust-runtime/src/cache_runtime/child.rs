//! Shared bounded desktop child lifetime and pipe draining. Never log raw output.
use super::*;
use std::io::Read;
use std::process::{Child, Command, Stdio};

struct OwnedChild(Child, bool);
impl OwnedChild {
    fn try_wait(&mut self) -> std::io::Result<Option<std::process::ExitStatus>> {
        #[cfg(unix)]
        {
            // Observe exit without reaping. Keep the PID reserved until the
            // owned group is terminated, then reap; a later process must never
            // receive a stale group kill after PID reuse.
            let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
            // SAFETY: valid output storage; only our child's PID is inspected.
            let result = unsafe {
                libc::waitid(
                    libc::P_PID,
                    self.0.id(),
                    info.as_mut_ptr(),
                    libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                )
            };
            if result != 0 {
                let error = std::io::Error::last_os_error();
                if error.raw_os_error() == Some(libc::ECHILD) {
                    self.1 = true;
                }
                return Err(error);
            }
            // SAFETY: waitid succeeded and initialized the zeroed structure.
            if unsafe { info.assume_init().si_pid() } == 0 {
                return Ok(None);
            }
            // SAFETY: the unreaped child reserves this process-group identity.
            unsafe {
                libc::kill(-(self.0.id() as i32), libc::SIGKILL);
            }
        }
        let result = self.0.try_wait()?;
        self.1 = result.is_some();
        Ok(result)
    }
}
impl Drop for OwnedChild {
    fn drop(&mut self) {
        if self.1 {
            return;
        }
        #[cfg(unix)]
        // SAFETY: child started in its own process group; never target our group.
        unsafe {
            libc::kill(-(self.0.id() as i32), libc::SIGKILL);
        }
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[cfg(target_os = "linux")]
fn bind_to_parent(command: &mut Command, parent: libc::pid_t) {
    use std::os::unix::process::CommandExt;
    // SAFETY: after fork this closure only calls Linux syscalls and constructs
    // raw OS errors. It never allocates, locks, logs or reads the environment.
    unsafe {
        command.pre_exec(move || {
            if libc::prctl(
                libc::PR_SET_PDEATHSIG,
                libc::SIGKILL as libc::c_ulong,
                0,
                0,
                0,
            ) != 0
            {
                return Err(std::io::Error::last_os_error());
            }
            // The owner may have died between fork and arming the signal.
            // Refuse exec in that case; arming alone cannot report a past exit.
            if libc::getppid() != parent {
                return Err(std::io::Error::from_raw_os_error(libc::ECANCELED));
            }
            Ok(())
        });
    }
}

/// Drain both streams concurrently, retaining only bounded offline help. Download
/// output is never logged or returned: a bounded source parser may observe it.
pub(super) fn supervise(
    mut command: Command,
    cancel: &AtomicBool,
    timeout: Duration,
    capture: bool,
    mut progress: impl FnMut(),
    observe: &(impl Fn(bool, &[u8]) + Sync),
    source: &str,
) -> Result<Vec<u8>, CacheRuntimeError> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(target_os = "linux")]
    bind_to_parent(&mut command, std::process::id() as libc::pid_t);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW, no shell
    }
    if cancel.load(Ordering::Acquire) {
        return Err(CacheRuntimeError::new(
            "cancelled",
            format!("{source} cancelled"),
        ));
    }
    let mut child = OwnedChild(
        command.spawn().map_err(|_| {
            CacheRuntimeError::new(
                "unavailable",
                format!("{source} could not start; configure a compatible executable"),
            )
        })?,
        false,
    );
    fn drain(
        mut input: impl Read,
        capture: bool,
        stderr: bool,
        observe: &(impl Fn(bool, &[u8]) + Sync),
    ) -> Vec<u8> {
        let mut output = Vec::new();
        let mut buffer = [0; 8192];
        while let Ok(size) = input.read(&mut buffer) {
            if size == 0 {
                break;
            }
            observe(stderr, &buffer[..size]);
            if capture {
                output.extend_from_slice(&buffer[..size.min(65536 - output.len())]);
            }
        }
        output
    }
    let stdout = child.0.stdout.take().unwrap();
    let stderr = child.0.stderr.take().unwrap();
    thread::scope(|scope| {
        let out = scope.spawn(move || drain(stdout, capture, false, observe));
        scope.spawn(move || drain(stderr, false, true, observe));
        let start = Instant::now();
        let result = loop {
            if cancel.load(Ordering::Acquire) {
                break Err(CacheRuntimeError::new(
                    "cancelled",
                    format!("{source} cancelled"),
                ));
            }
            if start.elapsed() > timeout {
                break Err(CacheRuntimeError::new(
                    "tool_timeout",
                    format!("{source} timed out"),
                ));
            }
            match child.try_wait() {
                Ok(Some(status)) if status.success() => break Ok(()),
                Ok(Some(_)) => {
                    break Err(CacheRuntimeError::new(
                        "tool_exit",
                        format!("{source} failed; check tool, login and source access, then retry"),
                    ));
                }
                Err(_) => {
                    break Err(CacheRuntimeError::new(
                        "tool_process",
                        format!("{source} process status unavailable"),
                    ));
                }
                Ok(None) => {
                    progress();
                    thread::sleep(Duration::from_millis(100));
                }
            }
        };
        drop(child); // terminate/reap before joining pipe readers, including cancellation
        let output = out.join().unwrap_or_default();
        result.map(|()| output)
    })
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::process::CommandExt;

    struct Tool(OwnedFd);
    impl Tool {
        fn observe(pid: libc::pid_t) -> Option<Self> {
            // Pin the exact test process, so failure cleanup cannot signal a reused PID.
            let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
            if fd < 0 {
                assert_eq!(
                    std::io::Error::last_os_error().raw_os_error(),
                    Some(libc::ESRCH)
                );
                return None;
            }
            Some(Self(unsafe { OwnedFd::from_raw_fd(fd as i32) }))
        }

        fn exited(&self, timeout: i32) -> bool {
            let mut event = libc::pollfd {
                fd: self.0.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            unsafe { libc::poll(&mut event, 1, timeout) > 0 }
        }
    }
    impl Drop for Tool {
        fn drop(&mut self) {
            // A failed regression must not leave its own orphan behind.
            unsafe {
                libc::syscall(
                    libc::SYS_pidfd_send_signal,
                    self.0.as_raw_fd(),
                    libc::SIGKILL,
                    std::ptr::null::<libc::siginfo_t>(),
                    0,
                );
            }
            let _ = self.exited(2000);
        }
    }

    struct Scratch(PathBuf);
    impl Scratch {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "bilikara-child-lifetime-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn tool_command(pid_file: &Path) -> Command {
        let mut command = Command::new("/bin/sh");
        command.args([
            "-c",
            "printf '%s' \"$$\" > \"$1\"; exec sleep 60",
            "tool-fixture",
        ]);
        command.arg(pid_file);
        command
    }

    #[test]
    fn tool_dies_with_owner_even_when_rust_cleanup_cannot_run() {
        const PID_FILE: &str = "BILIKARA_TEST_CHILD_OWNER_PID_FILE";
        const EXIT: &str = "BILIKARA_TEST_CHILD_OWNER_EXIT";
        if let Some(path) = std::env::var_os(PID_FILE) {
            let path = PathBuf::from(path);
            let exit = std::env::var_os(EXIT).is_some();
            let _ = supervise(
                tool_command(&path),
                &AtomicBool::new(false),
                Duration::from_secs(30),
                false,
                || {
                    if exit && path.is_file() {
                        std::process::exit(0); // Deliberately bypass every Rust destructor.
                    }
                },
                &|_, _| {},
                "fixture",
            );
            panic!("fixture owner unexpectedly survived its deadline");
        }
        let scratch = Scratch::new();
        let name = concat!(
            module_path!(),
            "::tool_dies_with_owner_even_when_rust_cleanup_cannot_run"
        )
        .split_once("::")
        .unwrap()
        .1;
        for exit in [false, true] {
            let path = scratch.0.join(if exit { "exit.pid" } else { "killed.pid" });
            let mut command = Command::new(std::env::current_exe().unwrap());
            command
                .args(["--exact", name, "--nocapture"])
                .env(PID_FILE, &path)
                .process_group(0)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            if exit {
                command.env(EXIT, "1");
            } else {
                command.env_remove(EXIT);
            }
            let mut owner = OwnedChild(command.spawn().unwrap(), false);
            let deadline = Instant::now() + Duration::from_secs(5);
            let pid = loop {
                if let Ok(text) = fs::read_to_string(&path)
                    && let Ok(pid) = text.parse::<libc::pid_t>()
                {
                    break pid;
                }
                assert!(Instant::now() < deadline, "fixture tool never started");
                thread::sleep(Duration::from_millis(10));
            };
            let tool = Tool::observe(pid);
            if !exit {
                owner.0.kill().unwrap();
            }
            loop {
                if let Some(status) = owner.try_wait().unwrap() {
                    assert_eq!(status.success(), exit);
                    break;
                }
                assert!(Instant::now() < deadline, "fixture owner never exited");
                thread::sleep(Duration::from_millis(10));
            }
            assert!(
                tool.as_ref().is_none_or(|tool| tool.exited(2000)),
                "tool survived owner death (ordinary process exit: {exit})"
            );
        }
    }

    #[test]
    fn owner_exit_before_guard_is_armed_prevents_exec() {
        let scratch = Scratch::new();
        let path = scratch.0.join("must-not-execute");
        let mut command = Command::new("/bin/sh");
        command
            .args(["-c", "printf started > \"$1\"", "race-fixture"])
            .arg(&path);
        bind_to_parent(&mut command, 0); // Simulate a changed parent before arming.
        assert_eq!(
            command.spawn().unwrap_err().raw_os_error(),
            Some(libc::ECANCELED)
        );
        assert!(
            !path.exists(),
            "a tool must not start after losing its owner"
        );
    }

    #[test]
    fn cancellation_timeout_and_success_keep_the_existing_cleanup_contract() {
        let scratch = Scratch::new();
        for cancelled in [true, false] {
            let path = scratch.0.join(if cancelled {
                "cancel.pid"
            } else {
                "timeout.pid"
            });
            let cancel = AtomicBool::new(false);
            let mut tool = None;
            let error = supervise(
                tool_command(&path),
                &cancel,
                Duration::from_millis(350),
                false,
                || {
                    if tool.is_none()
                        && let Ok(text) = fs::read_to_string(&path)
                        && let Ok(pid) = text.parse::<libc::pid_t>()
                    {
                        tool = Tool::observe(pid);
                        if cancelled {
                            cancel.store(true, Ordering::Release);
                        }
                    }
                },
                &|_, _| {},
                "fixture",
            )
            .unwrap_err();
            assert_eq!(
                error.kind,
                if cancelled {
                    "cancelled"
                } else {
                    "tool_timeout"
                }
            );
            assert!(
                tool.as_ref().unwrap().exited(0),
                "tool remains after supervise returned"
            );
        }
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "printf completed"]);
        assert_eq!(
            supervise(
                command,
                &AtomicBool::new(false),
                Duration::from_secs(2),
                true,
                || {},
                &|_, _| {},
                "fixture"
            )
            .unwrap(),
            b"completed"
        );
    }
}
