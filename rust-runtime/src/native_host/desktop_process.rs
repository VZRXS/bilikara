//! Windows desktop lifetime: the Host owns a kill-on-close job, and watches
//! the shell's process handle so an unexpected shell exit also stops the Host.
pub(crate) static JOB_OWNED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

#[cfg(windows)]
pub(super) struct Parent(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl Parent {
    pub(super) fn open() -> Result<Self, String> {
        use windows_sys::Win32::System::{JobObjects::*, Threading::*};
        let parent = std::env::var("BILIKARA_DESKTOP_PID")
            .ok()
            .and_then(|s| s.parse::<u32>().ok());
        // SAFETY: all structures and handles use the documented Win32 ABI. The
        // unnamed, non-inheritable job handle belongs to this process only.
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err("无法创建桌面进程组".into());
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags =
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&limits) as u32,
            ) == 0
                || AssignProcessToJobObject(job, GetCurrentProcess()) == 0
            {
                windows_sys::Win32::Foundation::CloseHandle(job);
                return Err("无法配置桌面进程退出清理".into());
            }
            JOB_OWNED.store(true, std::sync::atomic::Ordering::Release);
            // Intentionally retain this OS handle until process termination.
            // Closing it here would kill the Host itself; OS teardown closes it
            // and terminates all remaining descendants even after a forced kill.
            let handle = parent.map_or(std::ptr::null_mut(), |pid| {
                OpenProcess(PROCESS_SYNCHRONIZE, 0, pid)
            });
            if parent.is_some() && handle.is_null() {
                return Err("桌面父进程已退出".into());
            }
            Ok(Self(handle))
        }
    }

    pub(super) fn arm_orphan_exit_watchdog(&self) {
        // A blocked HTTP/export worker must not keep the Host and its Job tree
        // alive indefinitely after the shell disappeared unexpectedly.
        let _ = std::thread::Builder::new()
            .name("orphan-host-exit".into())
            .spawn(|| {
                std::thread::sleep(std::time::Duration::from_secs(5));
                std::process::exit(1); // OS closes the owned Job and kills descendants.
            });
    }

    pub(super) fn exited(&self) -> bool {
        !self.0.is_null()
            && unsafe {
                // SAFETY: this owned process handle stays valid until Drop.
                windows_sys::Win32::System::Threading::WaitForSingleObject(self.0, 0)
                    != windows_sys::Win32::Foundation::WAIT_TIMEOUT
            }
    }
}

#[cfg(windows)]
impl Drop for Parent {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                windows_sys::Win32::Foundation::CloseHandle(self.0);
            }
        }
    }
}
