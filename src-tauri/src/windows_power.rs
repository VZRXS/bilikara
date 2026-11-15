//! Keep the controller and stage displays awake for the desktop session.

use crate::desktop_diagnostics::DesktopStartupLog;
use std::marker::PhantomData;
use windows_sys::Win32::System::Power::{
    ES_CONTINUOUS, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED, SetThreadExecutionState,
};

pub(crate) struct SleepInhibitor {
    log: Option<DesktopStartupLog>,
    // Windows stores this request on the thread that made it.
    _thread: PhantomData<*mut ()>,
}

impl SleepInhibitor {
    pub(crate) fn acquire(log: Option<DesktopStartupLog>) -> Option<Self> {
        let flags = ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED;
        if unsafe { SetThreadExecutionState(flags) } == 0 {
            if let Some(log) = &log {
                log.append("windows_sleep", "status=unavailable");
            }
            eprintln!("Windows rejected the system and display wake request");
            return None;
        }
        if let Some(log) = &log {
            log.append("windows_sleep", "status=active system=true display=true");
        }
        Some(Self {
            log,
            _thread: PhantomData,
        })
    }
}

impl Drop for SleepInhibitor {
    fn drop(&mut self) {
        let previous = unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
        if let Some(log) = &self.log {
            let status = if previous != 0 {
                "released"
            } else {
                "release_failed"
            };
            log.append(
                "windows_sleep",
                format!("status={status} previous=0x{previous:08x}"),
            );
        }
    }
}
