// Stage priority adapted from bilikara-next 7750dca, purek/trace.rs (MIT,
// Copyright (c) 2026 bilikara contributors), including 0870f2b. Stop tolerance
// follows bilikara's T2 contract, not next's narrower tolerated-701 exception.
use super::{Event, model::*};
use serde::Serialize;
use serde_json::{Value, json};

#[derive(Clone, Debug, Default, Serialize)]
pub(super) struct HttpCounts {
    head: u64,
    get: u64,
    peer_mismatches: u64,
    not_found: u64,
    method_not_allowed: u64,
    incomplete_header: u64,
    header_preempted: u64,
    rejected: u64,
    live_jumps: u64,
}

#[derive(Clone, Debug, Serialize)]
pub(super) struct Output {
    pub id: u64,
    pub device: String,
    pub cell: Option<Cell>,
    pub skip_reason: Option<SkipReason>,
    pub mode: Mode,
    pub mime: Mime,
    pub preflight: MediaPreflight,
    pub started_ms: u64,
    pub protocol_info_state: ProtocolState,
    pub sink_mime_classes: Vec<Mime>,
    pub av_transport_present: Option<bool>,
    pub rendering_control_present: Option<bool>,
    pub listener_ready: bool,
    pub first_ts_packet_ms: Option<u64>,
    pub failure: Option<Failure>,
    pub terminal: bool,
    pub ended_ms: Option<u64>,
    pub play_ms: Option<u64>,
    pub first_get_ms: Option<u64>,
    pub first_byte_ms: Option<u64>,
    /// Time of terminal byte-count event; NOT the last successful socket write.
    pub bytes_observed_ms: Option<u64>,
    pub bytes_written: u64,
    #[serde(skip)]
    completed_bytes_written: u64,
    pub http: HttpCounts,
    pub observations: RequestObservations,
    pub empty_metadata_retry: bool,
    pub transport_info_count: u64,
    pub transport_info_failed: u64,
    pub transport_baseline: Option<Transport>,
    pub transport_states: Vec<Transport>,
    pub dropped_transport_states: usize,
    pub position_advanced: Option<bool>,
    pub user_answers: UserAnswers,
    pub actions: Vec<Event>,
    pub dropped_actions: usize,
    pub disconnects: Vec<&'static str>,
    pub dropped_disconnects: usize,
    pub generation: Option<u64>,
    pub last_media_time_us: Option<i64>,
    pub live_start: Option<Value>,
    control_failure: Option<&'static str>,
}

impl Output {
    pub fn new(id: u64, device: String, at: u64, config: OutputConfig) -> Self {
        Self {
            id,
            device,
            cell: config.cell,
            skip_reason: None,
            mode: config.mode,
            mime: config.mime,
            preflight: config.preflight,
            started_ms: at,
            protocol_info_state: ProtocolState::NotChecked,
            sink_mime_classes: vec![],
            av_transport_present: None,
            rendering_control_present: None,
            listener_ready: false,
            first_ts_packet_ms: None,
            failure: None,
            terminal: false,
            ended_ms: None,
            play_ms: None,
            first_get_ms: None,
            first_byte_ms: None,
            bytes_observed_ms: None,
            bytes_written: 0,
            completed_bytes_written: 0,
            http: HttpCounts::default(),
            observations: RequestObservations::default(),
            empty_metadata_retry: false,
            transport_info_count: 0,
            transport_info_failed: 0,
            transport_baseline: None,
            transport_states: vec![],
            dropped_transport_states: 0,
            position_advanced: None,
            user_answers: UserAnswers::default(),
            actions: vec![],
            dropped_actions: 0,
            disconnects: vec![],
            dropped_disconnects: 0,
            generation: None,
            last_media_time_us: None,
            live_start: None,
            control_failure: None,
        }
    }

    pub fn action(&mut self, e: &Event) {
        if e.stage == "Play" && e.outcome == "ok" {
            self.play_ms = Some(e.at_ms);
        }
        if e.stage == "SetAVTransportURI" && e.attempt > 1 {
            self.empty_metadata_retry = true;
        }
        if matches!(e.stage, "SetAVTransportURI" | "Play") && e.disposition == "applied" {
            if e.outcome == "failed" {
                self.control_failure = e.code;
            } else {
                self.control_failure = None;
            }
        }
        if e.stage == "GetTransportInfo" {
            self.transport_info_count = self.transport_info_count.saturating_add(1);
            if e.outcome == "failed" {
                self.transport_info_failed = self.transport_info_failed.saturating_add(1);
            }
        }
        if self.actions.len() < 24 {
            self.actions.push(e.clone());
        } else {
            self.dropped_actions = self.dropped_actions.saturating_add(1);
        }
    }

    pub fn http(&mut self, e: &Event, h: &super::super::cast_http::HttpStageResult) {
        use super::super::cast_http::{HttpStage as S, Reason as R};
        // A cell belongs to a single publication. Do not merge a stale generation
        // into a new cell; the caller passes the output id associated at publish.
        if let Some(g) = h.generation {
            self.generation = Some(g);
        }
        match h.stage {
            S::Listener => self.listener_ready = h.result.is_ok(),
            S::Head => self.http.head = self.http.head.saturating_add(1),
            S::Get => {
                self.http.get = self.http.get.saturating_add(1);
                self.first_get_ms.get_or_insert(e.at_ms);
            }
            S::PeerMismatch => {
                self.http.peer_mismatches = self.http.peer_mismatches.saturating_add(1)
            }
            S::FirstByte => {
                self.first_byte_ms.get_or_insert(e.at_ms);
                self.bytes_written = self.bytes_written.max(h.bytes_written);
            }
            S::BytesWritten => {
                self.completed_bytes_written =
                    self.completed_bytes_written.saturating_add(h.bytes_written);
                self.bytes_written = self.bytes_written.max(self.completed_bytes_written);
                if h.bytes_written > 0 {
                    self.bytes_observed_ms = Some(e.at_ms);
                }
            }
            S::LiveJump => self.http.live_jumps = self.http.live_jumps.saturating_add(1),
            S::Rejected => {
                self.http.rejected = self.http.rejected.saturating_add(1);
                match h.result.as_ref().err() {
                    Some(R::NotFound) => {
                        self.http.not_found = self.http.not_found.saturating_add(1)
                    }
                    Some(R::Method) => {
                        self.http.method_not_allowed =
                            self.http.method_not_allowed.saturating_add(1)
                    }
                    Some(R::HeaderPreempted) => {
                        self.http.header_preempted = self.http.header_preempted.saturating_add(1)
                    }
                    Some(R::IncompleteHeader | R::HeaderTimeout | R::HeaderTooLarge) => {
                        self.http.incomplete_header = self.http.incomplete_header.saturating_add(1)
                    }
                    _ => {}
                }
            }
            S::Disconnect => {
                if let Some(reason) = h.disconnect_reason {
                    if self.disconnects.len() < 16 {
                        self.disconnects.push(reason.as_str());
                    } else {
                        self.dropped_disconnects = self.dropped_disconnects.saturating_add(1);
                    }
                    // Normal EOF, generation replacement and session cancellation
                    // are lifecycle events, not evidence of a receiver failure.
                    if matches!(
                        reason,
                        R::WriteStall | R::PeerClosed | R::WriteError | R::ReadError
                    ) {
                        self.failure.get_or_insert(Failure::Interrupted);
                    }
                }
            }
        }
        if h.media_time_us.is_some() {
            self.last_media_time_us = h.media_time_us;
        }
        if let Some(s) = h.live_start {
            self.live_start = Some(json!({"source_start_us":s.source_start_us,
                "timestamp_origin_us":s.timestamp_origin_us,"profile":s.profile,"level":s.level,
                "width":s.width,"height":s.height,"has_b_frames":s.has_b_frames,
                "audio_transcoded":s.audio_transcoded}));
        }
    }

    pub fn classification(&self, now: u64) -> (&'static str, Option<&'static str>) {
        if self.skip_reason.is_some() {
            return ("skipped", None);
        }
        let now = self.ended_ms.unwrap_or(now);
        if self.failure == Some(Failure::PipelineFailed) && self.first_ts_packet_ms.is_none() {
            return ("media_preparation", Some("cast_media_prepare_failed"));
        }
        match self.failure {
            Some(Failure::UnsupportedCodec) => {
                return ("media_preparation", Some("cast_media_unsupported_codec"));
            }
            Some(Failure::PrepareFailed) => {
                return ("media_preparation", Some("cast_media_prepare_failed"));
            }
            Some(Failure::BackendUnavailable) => {
                return ("media_preparation", Some("cast_backend_unavailable"));
            }
            _ => {}
        }
        if let Some(code) = self.control_failure {
            return ("control", Some(code));
        }
        if self.failure == Some(Failure::PipelineFailed) {
            return ("media_pipeline", Some("cast_media_pipeline_failed"));
        }
        let Some(play) = self.play_ms else {
            return (
                if self.terminal {
                    "before_play"
                } else {
                    "starting"
                },
                None,
            );
        };
        if self.http.get == 0 && self.http.rejected == 0 {
            return (
                "not_requested",
                (now.saturating_sub(play) >= 10_000).then_some("cast_not_requested"),
            );
        }
        if self.first_byte_ms.is_none() && self.bytes_written == 0 {
            let code = if self.http.rejected > 0 {
                Some("cast_request_rejected")
            } else {
                self.first_get_ms
                    .filter(|at| now.saturating_sub(*at) >= 10_000)
                    .map(|_| "cast_no_delivery")
            };
            return ("request_rejected_or_interrupted", code);
        }
        if self.failure == Some(Failure::Interrupted) {
            return ("transport_stopped", Some("cast_interrupted"));
        }
        ("delivered_unverified", None)
    }

    pub fn snapshot(&self, now: u64) -> Value {
        let (stage, code) = self.classification(now);
        let mut value = serde_json::to_value(self).expect("typed output serializes");
        value["stage"] = json!(stage);
        value["code"] = json!(code);
        value["media_time_basis"] = json!("dts_watermark_not_pts");
        value["observation_limits"] = json!({
            "range_requests":"unavailable: T4 events do not expose Range headers",
            "source_same_subnet_24":"true only for exact description-peer match; otherwise unknown because T4 does not expose peer IP",
            "last_byte_ms":"session elapsed time of last observed positive-byte event; disconnect events may follow the final socket write"
        });
        value["elapsed_ms"] = json!(self.ended_ms.unwrap_or(now).saturating_sub(self.started_ms));
        let mut actions = self.actions.clone();
        actions.sort_by_key(|e| (e.at_ms, e.sequence));
        value["actions"] = json!(actions);
        value
    }
}

pub(super) fn conclusion(outputs: &[Output]) -> Conclusion {
    let works = |cell| {
        outputs.iter().any(|o| {
            o.cell == Some(cell)
                && matches!(
                    o.user_answers.video,
                    VideoAnswer::Normal | VideoAnswer::Stuttering
                )
                && o.user_answers.audio == Answer::Yes
        })
    };
    // Plan §7.6 row 3 says F×B OR L×B, which would swallow row 4. Interpret
    // row 3 as F×B works (with/without L×B), and row 4 as only L×B works.
    // This preserves the useful distinction: video recoding vs mandatory live
    // delivery plus recoding. A successful A cell still wins rows 1/2 first.
    let selection = if works(Cell::FileA) {
        Some((Mode::File, Variant::A, 1))
    } else if works(Cell::LiveA) {
        Some((Mode::Live, Variant::A, 2))
    } else if works(Cell::FileB) {
        Some((Mode::File, Variant::B, 3))
    } else if works(Cell::LiveB) {
        Some((Mode::Live, Variant::B, 4))
    } else if works(Cell::FileMp4A) {
        Some((Mode::FileMp4, Variant::A, 5))
    } else {
        None
    };
    if let Some((mode, variant, row)) = selection {
        return Conclusion {
            learned_mode: Some(mode),
            learned_variant: Some(variant),
            decision_row: Some(row),
        };
    }
    Conclusion::default()
}
