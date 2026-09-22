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
