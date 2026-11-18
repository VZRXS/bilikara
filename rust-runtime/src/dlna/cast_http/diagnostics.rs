use super::{DeviceContext, Reason};
use crate::experimental_libav::cast_mux::CastStart;
use std::{
    collections::VecDeque,
    sync::Mutex,
    time::{Duration, Instant},
};
use tokio::sync::broadcast;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HttpStage {
    Listener,
    Get,
    Head,
    PeerMismatch,
    FirstByte,
    BytesWritten,
    LiveJump,
    Rejected,
    Disconnect,
}

impl HttpStage {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Listener => "http.listener",
            Self::Get => "http.get",
            Self::Head => "http.head",
            Self::PeerMismatch => "http.peer_mismatch",
            Self::FirstByte => "http.first_byte",
            Self::BytesWritten => "http.bytes_written",
            Self::LiveJump => "http.live_jump",
            Self::Rejected => "http.rejected",
            Self::Disconnect => "http.disconnect",
        }
    }
}

/// T2-style recordable facts. No URI, capability token, address or raw IO error
/// is retained. connection_id correlates request / first byte / disconnect.
#[derive(Clone, Debug)]
pub struct HttpStageResult {
    pub stage: HttpStage,
    pub context: DeviceContext,
    pub generation: Option<u64>,
    pub connection_id: u64,
    pub elapsed: Duration,
    pub http_status: Option<u16>,
    pub result: Result<(), Reason>,
    pub bytes_written: u64,
    pub disconnect_reason: Option<Reason>,
    /// Join/jump watermark relative to live_start.timestamp_origin_us. Thus
    /// source timestamp = origin + media_time_us; presentation elapsed from
    /// the source start = origin + media_time_us - source_start_us.
    pub media_time_us: Option<i64>,
    pub live_start: Option<CastStart>,
}

#[derive(Clone, Debug)]
pub struct HttpDiagnostics {
    pub stages: Vec<HttpStageResult>,
    pub dropped_stages: usize,
    /// Body bytes, including progress not yet in a terminal BytesWritten stage.
    pub bytes_written: u64,
    pub peer_mismatches: u64,
    pub rejected: u64,
    /// Retained independently of the bounded stage log so subscribers can
    /// recover after broadcast lag. Reset on publishing a new generation.
    pub first_get_written: bool,
    pub generation: Option<u64>,
}

struct Records {
    stages: VecDeque<HttpStageResult>,
    dropped: usize,
    bytes: u64,
    mismatches: u64,
    rejected: u64,
    first: bool,
    generation: Option<u64>,
}

pub(super) struct Diagnostics {
    records: Mutex<Records>,
    capacity: usize,
    pub(super) events: broadcast::Sender<HttpStageResult>,
    pub(super) clock: Instant,
    pub(super) context: DeviceContext,
}

impl Diagnostics {
    pub(super) fn new(context: DeviceContext, capacity: usize) -> Self {
        Self {
            records: Mutex::new(Records {
                stages: VecDeque::new(),
                dropped: 0,
                bytes: 0,
                mismatches: 0,
                rejected: 0,
                first: false,
                generation: None,
            }),
            capacity,
            events: broadcast::channel(capacity).0,
            clock: Instant::now(),
            context,
        }
    }

    pub(super) fn generation(&self, generation: u64) {
        let mut r = self.records.lock().unwrap_or_else(|e| e.into_inner());
        r.generation = Some(generation);
        r.first = false;
    }

    pub(super) fn written(&self, bytes: usize, generation: u64) {
        let mut r = self.records.lock().unwrap_or_else(|e| e.into_inner());
        r.bytes = r.bytes.saturating_add(bytes as u64);
        if r.generation == Some(generation) {
            r.first = true;
        }
    }

    pub(super) fn record(&self, event: HttpStageResult) {
        let mut r = self.records.lock().unwrap_or_else(|e| e.into_inner());
        if r.stages.len() == self.capacity {
            r.stages.pop_front();
            r.dropped = r.dropped.saturating_add(1);
        }
        if event.stage == HttpStage::PeerMismatch {
            r.mismatches = r.mismatches.saturating_add(1);
        }
        if event.stage == HttpStage::Rejected {
            r.rejected = r.rejected.saturating_add(1);
        }
        r.stages.push_back(event.clone());
        // Publish under the same short lock to preserve stage ordering.
        let _ = self.events.send(event);
    }

    pub(super) fn snapshot(&self) -> HttpDiagnostics {
        let r = self.records.lock().unwrap_or_else(|e| e.into_inner());
        HttpDiagnostics {
            stages: r.stages.iter().cloned().collect(),
            dropped_stages: r.dropped,
            bytes_written: r.bytes,
            peer_mismatches: r.mismatches,
            rejected: r.rejected,
            first_get_written: r.first,
            generation: r.generation,
        }
    }
}
