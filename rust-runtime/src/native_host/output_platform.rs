//! Shell resource adapter; playback intent stays in AppState.
use super::*;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutputActivity {
    Stopped,
    Paused,
    Playing,
}
pub type OutputActivityHook = Arc<dyn Fn(OutputActivity) -> Result<(), String> + Send + Sync>;
#[cfg(target_os = "android")]
static HOOK: std::sync::OnceLock<OutputActivityHook> = std::sync::OnceLock::new();

#[cfg(target_os = "android")]
pub fn install(hook: OutputActivityHook) -> Result<(), String> {
    HOOK.set(hook)
        .map_err(|_| "Android output resources are already installed".into())
}

static APPLIED: std::sync::Mutex<Option<OutputActivity>> = std::sync::Mutex::new(None);
pub(super) fn apply(phase: OutputActivity) -> Result<(), ApiError> {
    let mut applied = APPLIED.lock().map_err(|_| {
        ApiError::new(
            503,
            "purek_output_platform",
            "Output resource lock unavailable",
        )
    })?;
    if *applied == Some(phase) {
        return Ok(());
    }
    let result = apply_resource(phase);
    if result.is_ok() {
        *applied = Some(phase);
    }
    result
}
fn apply_resource(phase: OutputActivity) -> Result<(), ApiError> {
    #[cfg(target_os = "android")]
    {
        HOOK.get().ok_or_else(|| {
            ApiError::new(
                503,
                "purek_output_platform",
                "Android media service is unavailable",
            )
        })?(phase)
        .map_err(|code| ApiError::new(503, &code, "请返回前台后重试电视输出"))
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = phase;
        Ok(())
    }
}

#[cfg(target_os = "android")]
pub fn interrupted(reason: i32) {
    let code = match reason {
        1 => "purek_output_notification_stop",
        3 => "purek_output_thermal",
        _ => "purek_output_platform_stopped",
    };
    let _ = with_app(|app| {
        app.native().purek.interrupt_output(code);
        app.native().revision += 1;
        Ok(())
    });
}
#[cfg(target_os = "android")]
pub fn thermal(status: i32, headroom: f32) {
    let _ = with_app(|app| {
        app.native().purek.controller.thermal(status, headroom);
        app.native().revision += 1;
        Ok(())
    });
}
