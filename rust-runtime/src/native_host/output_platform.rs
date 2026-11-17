//! Local L1 resource adapter sharing cast's lease namespace and Android service.
//! Playback intent stays in AppState; a late notification cannot stop a new lease.
use super::*;
use crate::cast_platform::OutputLease;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutputActivity {
    Stopped,
    Paused,
    Playing,
}
#[derive(Default)]
struct Applied {
    phase: Option<OutputActivity>,
    lease: Option<OutputLease>,
}
static APPLIED: std::sync::Mutex<Applied> = std::sync::Mutex::new(Applied {
    phase: None,
    lease: None,
});
pub(super) fn apply(phase: OutputActivity) -> Result<(), ApiError> {
    let mut applied = APPLIED.lock().map_err(|_| {
        ApiError::new(
            503,
            "purek_output_platform",
            "Output resource lock unavailable",
        )
    })?;
    if applied.phase == Some(phase) {
        return Ok(());
    }
    if phase == OutputActivity::Stopped {
        applied.lease = None;
    } else {
        let error = |e: crate::cast_platform::PlatformError| {
            ApiError::new(
                503,
                match e {
                    crate::cast_platform::PlatformError::ForegroundRequired => {
                        "purek_output_foreground_required"
                    }
                    crate::cast_platform::PlatformError::Unavailable
                    | crate::cast_platform::PlatformError::AlreadyInstalled => {
                        "purek_output_platform"
                    }
                },
                "Output resources unavailable; retry in foreground",
            )
        };
        if applied.lease.is_none() {
            applied.lease = Some(OutputLease::acquire().map_err(error)?);
        }
        applied
            .lease
            .as_ref()
            .unwrap()
            .set_paused(phase == OutputActivity::Paused)
            .map_err(error)?;
    }
    applied.phase = Some(phase);
    Ok(())
}
#[cfg(target_os = "android")]
pub fn interrupted(lease: u64, reason: i32) {
    if !matches!(reason, 1..=4) {
        return;
    }
    // AppState -> resource lock is the admission order. Check inside AppState
    // too, so a new admission cannot slip between validation and interruption.
    let _ = with_app(|app| {
        let mut applied = APPLIED.lock().map_err(|_| {
            ApiError::new(
                503,
                "purek_output_platform",
                "Output resource lock unavailable",
            )
        })?;
        if applied.lease.as_ref().map(OutputLease::id) != Some(lease) {
            return Ok(());
        }
        let code = match reason {
            1 => "purek_output_notification_stop",
            4 => "purek_output_thermal",
            _ => "purek_output_platform_stopped",
        };
        applied.lease = None;
        applied.phase = Some(OutputActivity::Stopped);
        app.native().local_output.interrupt_output(code);
        app.native().revision += 1;
        Ok(())
    });
}
#[cfg(target_os = "android")]
pub fn thermal(lease: u64, status: i32, headroom: f32) {
    let _ = with_app(|app| {
        let applied = APPLIED.lock().map_err(|_| {
            ApiError::new(
                503,
                "purek_output_platform",
                "Output resource lock unavailable",
            )
        })?;
        if applied.lease.as_ref().map(OutputLease::id) != Some(lease) {
            return Ok(());
        }
        app.native()
            .local_output
            .controller
            .thermal(status, headroom);
        app.native().revision += 1;
        Ok(())
    });
}
