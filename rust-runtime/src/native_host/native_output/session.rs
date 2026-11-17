//! Local L1 status only. Receiver state is projected by cast_session.
use super::*;
#[derive(Default, PartialEq, Eq)]
enum Status {
    #[default]
    Stopped,
    Starting,
    Streaming,
    Paused,
    Error,
}
impl Status {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Stopped => "stopped",
            Self::Starting => "starting",
            Self::Streaming => "streaming",
            Self::Paused => "paused",
            Self::Error => "error",
        }
    }
}
#[derive(Default)]
pub(super) struct OutputSession {
    pub mode: bilikara_rust::output_audio::OffsetMode,
    generation: u64,
    status: Status,
    last_error: Option<String>,
    pub running: Option<Arc<stream::Running>>,
}
impl OutputSession {
    pub(super) fn begin(&mut self, generation: u64, running: Arc<super::stream::Running>) {
        self.generation = generation;
        self.status = Status::Starting;
        self.last_error = None;
        self.running = Some(running);
    }
    pub(super) fn streaming(&mut self, generation: u64) -> bool {
        if self.generation != generation || self.status != Status::Starting {
            return false;
        }
        self.status = Status::Streaming;
        true
    }
    pub(super) fn pipeline_error(&mut self) {
        self.status = Status::Error;
        self.last_error = Some("purek_output_pipeline".into());
        if let Some(running) = &self.running {
            running.trace.terminal(Some("purek_output_pipeline"));
        }
    }
    pub(super) fn end(&mut self, generation: u64, paused: bool, error: Option<&str>) {
        if let Some(running) = self.running.take() {
            running
                .trace
                .terminal(error.or(if paused { Some("paused") } else { None }));
            running.cancel();
        }
        self.generation = generation;
        self.status = if error.is_some() {
            Status::Error
        } else if paused {
            Status::Paused
        } else {
            Status::Stopped
        };
        self.last_error = error.map(str::to_owned);
    }

    pub fn snapshot(&self) -> Value {
        json!({"schema_version":1,"generation":self.generation,
 "status":self.status.as_str(),"pipeline_level":self.running.as_ref().map(|_|"L1"),
 "offset_mode":match self.mode {bilikara_rust::output_audio::OffsetMode::Splice=>"splice",bilikara_rust::output_audio::OffsetMode::Gradual=>"gradual"},"last_error":self.last_error,"measured_adjust_latency_ms":null})
    }
}
