//! Retained standalone next L1 preview, isolated from receiver sessions (P6).
//! P8 reuses the L1 producer for T4; this module never connects a receiver.
use super::*;
use std::time::Instant;
pub(crate) mod controller;
#[path = "purek/output.rs"]
mod output;
#[path = "purek/preview.rs"]
pub(crate) mod preview;
#[path = "native_output/session.rs"]
mod renderer;
#[path = "native_output/producer.rs"]
mod stream;
#[path = "native_output/diagnostics.rs"]
mod trace;
#[derive(Default)]
pub(crate) struct LocalOutput {
    pub(crate) program_epoch: u64,
    pub(crate) controller: controller::Controller,
    busy: bool,
    generation: u64,
    local_preview: Option<Arc<preview::Preview>>,
    output: renderer::OutputSession,
    diagnostics: trace::Log,
}
impl LocalOutput {
    #[cfg(target_os = "android")]
    pub(crate) fn interrupt_output(&mut self, code: &str) {
        if self.controller.owns_playback {
            self.controller.platform_failure(code);
        }
        if let Some(r) = &self.output.running {
            r.cancel();
        }
    }
}
fn snapshot(session: &crate::app_state::native_session::NativeSession) -> Value {
    session.local_output.output.snapshot()
}
fn failure(status: u16, code: &str, message: &str) -> ApiError {
    ApiError::new(status, &format!("purek_{code}"), message)
}
fn busy() -> ApiError {
    failure(409, "busy", "本机管线操作正在进行")
}
fn network_error() -> ApiError {
    failure(503, "output_pipeline", "本机管线无法启动")
}
