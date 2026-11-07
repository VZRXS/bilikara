//! Bounded, Host-only Pure K / DLNA diagnostics. Entries hold stages, stable
//! codes, categories, counts and monotonic durations. They never hold receiver
//! or local addresses, URLs, stream capabilities, room identifiers, QR text,
//! authorization tokens, raw HTTP bodies or SOAP payloads.
use super::*;
use std::{
    collections::VecDeque,
    sync::{Mutex, atomic::AtomicU64},
};

const CONNECTIONS: usize = 6;
const STEPS: usize = 16;
const ACTIONS: usize = 24;
static SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn sequence() -> u64 {
    SEQUENCE.fetch_add(1, Ordering::Relaxed).wrapping_add(1)
}
fn millis(since: Instant) -> u64 {
    u64::try_from(since.elapsed().as_millis()).unwrap_or(u64::MAX)
}

/// Safe transport facts for a failed request; attached to the ApiError only.
pub(super) fn request_error(error: &reqwest::Error) -> ApiError {
    let transport = if error.is_timeout() {
        "timeout"
    } else if error.is_connect() {
        "connect"
    } else {
        "io"
    };
    network_error().with_diagnostic(json!({ "transport": transport }))
}
pub(super) fn http_error(status: reqwest::StatusCode) -> ApiError {
    failure(502, "http", "房台请求失败，请确认官方授权后重试")
        .with_diagnostic(json!({ "http_status": status.as_u16() }))
}

/// Address classes only: enough to notice a VPN/TUN or link-local route
/// without recording either address.
pub(super) fn route_facts(local: Ipv4Addr, receiver: Ipv4Addr) -> Value {
    let [a, b, ..] = local.octets();
    let class = if local.is_loopback() {
        "loopback"
    } else if local.is_private() {
        "private"
    } else if local.is_link_local() {
        "link_local"
    } else if a == 100 && (64..128).contains(&b) {
        "shared"
    } else if a == 198 && (b == 18 || b == 19) {
        "benchmark"
    } else {
        "other"
    };
    json!({"local_class":class,
        "same_subnet_24":local.octets()[..3] == receiver.octets()[..3]})
}

/// One connection attempt. Runs on a single worker thread; the caller commits
/// the finished value into AppState.
pub(super) struct ConnectTrace {
    kind: &'static str,
    started: Instant,
    steps: Vec<Value>,
    route: Option<Value>,
}
impl ConnectTrace {
    pub fn new(room: &Room) -> Self {
        Self {
            kind: room.connection_type(),
            started: Instant::now(),
            steps: Vec::new(),
            route: None,
        }
    }
    pub fn route(&mut self, facts: Value) {
        self.route = Some(facts);
    }
    pub fn step<T>(&mut self, stage: &'static str, since: Instant, result: &Result<T, ApiError>) {
        let mut entry = json!({"stage":stage,"elapsed_ms":millis(since)});
        match result {
            Ok(_) => entry["outcome"] = json!("ok"),
            Err(error) => {
                entry["outcome"] = json!("failed");
                entry["code"] = json!(error.code);
                if let Some(facts) = error.diagnostic().and_then(Value::as_object) {
                    for (key, value) in facts {
                        entry[key] = value.clone();
                    }
                }
            }
        }
        if self.steps.len() < STEPS {
            self.steps.push(entry);
        }
    }
    pub fn finish(self, result: Option<&ApiError>) -> Value {
        let failed = self
            .steps
            .iter()
            .rev()
            .find(|s| s["outcome"] == "failed" && s["stage"] != "ssdp");
        json!({"attempt":sequence(),"connection_type":self.kind,
            "elapsed_ms":millis(self.started),"route":self.route,"steps":self.steps,
            "result":if result.is_some() {"failed"} else {"connected"},
            "code":result.map(|e| e.code.as_str()),
            "failure_stage":result.and(failed.map(|s| s["stage"].clone())),
            "retryable":result.map(|e| retryable(&e.code))})
    }
}
pub(super) fn retryable(code: &str) -> bool {
    !matches!(
        code,
        "purek_qr_invalid"
            | "purek_description_invalid"
            | "purek_renderer"
            | "purek_output_codec"
            | "purek_output_backend_unavailable"
    )
}

/// The current and previous output attempt. Producer, HTTP and monitor threads
/// update this small lock without holding the AppState lock.
pub(super) struct OutputTrace {
    started: Instant,
    data: Mutex<OutputData>,
}
#[derive(Default)]
struct Http {
    head: u32,
    get: u32,
    streams: u32,
    rejected_peer: u32,
    rejected_peer_same_subnet: u32,
    not_found: u32,
    method: u32,
    incomplete: u32,
    conflict: u32,
    gone: u32,
    overflow: u32,
}
#[derive(Default)]
struct OutputData {
    attempt: u64,
    managed: bool,
    level: Option<&'static str>,
    framing: Option<&'static str>,
    mime: Option<&'static str>,
    protocol_info: Value,
    route: Value,
    preflight: Value,
    listener_ready: bool,
    pipeline_first_packet_ms: Option<u64>,
    pipeline_end: Option<(&'static str, u64)>,
    http: Http,
    bytes_written: u64,
    first_byte_ms: Option<u64>,
    last_byte_ms: Option<u64>,
    disconnects: Vec<&'static str>,
    actions: Vec<Value>,
    transport_ok: u32,
    transport_failed: u32,
    transport_state: Option<&'static str>,
    monitoring: Option<&'static str>,
    terminal: Option<(String, u64)>,
}
impl OutputTrace {
    pub fn new(managed: bool) -> Arc<Self> {
        Arc::new(Self {
            started: Instant::now(),
            data: Mutex::new(OutputData {
                attempt: sequence(),
                managed,
                ..Default::default()
            }),
        })
    }
    fn update(&self, change: impl FnOnce(&mut OutputData, u64)) {
        let at = millis(self.started);
        if let Ok(mut data) = self.data.lock() {
            change(&mut data, at);
        }
    }
    pub fn configure(
        &self,
        level: &'static str,
        framing: &'static str,
        mime: &'static str,
        protocol_info: Value,
    ) {
        self.update(|d, _| {
            d.level = Some(level);
            d.framing = Some(framing);
            d.mime = Some(mime);
            d.protocol_info = protocol_info;
        });
    }
    pub fn preflight(&self, preflight: Value) {
        self.update(|d, _| d.preflight = preflight);
    }
    pub fn route(&self, facts: Value) {
        self.update(|d, _| d.route = facts);
    }
    pub fn listener_ready(&self) {
        self.update(|d, _| d.listener_ready = true);
    }
    pub fn first_packet(&self) {
        self.update(|d, at| {
            d.pipeline_first_packet_ms.get_or_insert(at);
        });
    }
    pub fn pipeline_end(&self, outcome: &'static str) {
        self.update(|d, at| {
            d.pipeline_end.get_or_insert((outcome, at));
        });
    }
    pub fn request(&self, kind: Request) {
        self.update(|d, _| {
            let h = &mut d.http;
            let counter = match kind {
                Request::Head => &mut h.head,
                Request::Get => &mut h.get,
                Request::Stream => &mut h.streams,
                Request::RejectedPeer { same_subnet } => {
                    if same_subnet {
                        h.rejected_peer_same_subnet = h.rejected_peer_same_subnet.saturating_add(1);
                    }
                    &mut h.rejected_peer
                }
                Request::NotFound => &mut h.not_found,
                Request::Method => &mut h.method,
                Request::Incomplete => &mut h.incomplete,
                Request::Conflict => &mut h.conflict,
                Request::Gone => &mut h.gone,
                Request::Overflow => &mut h.overflow,
            };
            *counter = counter.saturating_add(1);
        });
    }
    pub fn written(&self, bytes: usize) {
        self.update(|d, at| {
            d.bytes_written = d.bytes_written.saturating_add(bytes as u64);
            d.first_byte_ms.get_or_insert(at);
            d.last_byte_ms = Some(at);
        });
    }
    pub fn disconnect(&self, category: &'static str) {
        self.update(|d, _| {
            if d.disconnects.len() < 8 {
                d.disconnects.push(category);
            }
        });
    }
    pub fn action<T>(&self, action: &'static str, since: Instant, result: &Result<T, ApiError>) {
        let elapsed = millis(since);
        self.update(|d, at| {
            let mut entry = json!({"action":action,"at_ms":at,"elapsed_ms":elapsed});
            match result {
                Ok(_) => entry["outcome"] = json!("ok"),
                Err(error) => {
                    entry["outcome"] = json!("failed");
                    entry["code"] = json!(error.code);
                    if let Some(facts) = error.diagnostic().and_then(Value::as_object) {
                        for (key, value) in facts {
                            entry[key] = value.clone();
                        }
                    }
                }
            }
            if d.actions.len() < ACTIONS {
                d.actions.push(entry);
            }
        });
    }
    pub fn transport_state(&self, state: Result<&str, &ApiError>, unavailable: bool) {
        self.update(|d, _| match state {
            Ok(state) => {
                d.transport_ok = d.transport_ok.saturating_add(1);
                d.transport_state = [
                    "STOPPED",
                    "PLAYING",
                    "TRANSITIONING",
                    "PAUSED_PLAYBACK",
                    "NO_MEDIA_PRESENT",
                ]
                .into_iter()
                .find(|s| *s == state);
                d.monitoring = Some("active");
            }
            Err(_) => {
                d.transport_failed = d.transport_failed.saturating_add(1);
                if unavailable {
                    d.monitoring = Some("unavailable");
                }
            }
        });
    }
    /// First terminal code wins; a later stop cannot relabel the failure.
    pub fn terminal(&self, code: Option<&str>) {
        self.update(|d, at| {
            if d.terminal.is_none() {
                d.terminal = Some((code.unwrap_or("stopped").to_owned(), at));
            }
        });
    }
    pub fn received_stream(&self) -> (u32, u32, u64) {
        self.data.lock().map_or((0, 0, 0), |d| {
            (d.http.get, d.http.rejected_peer, d.bytes_written)
        })
    }
    pub fn recent_delivery(&self, maximum_age: Duration) -> bool {
        let at = millis(self.started);
        self.data.lock().is_ok_and(|d| {
            d.bytes_written > 0
                && d.last_byte_ms.is_some_and(|last| {
                    u128::from(at.saturating_sub(last)) < maximum_age.as_millis()
                })
        })
    }
    pub fn tolerated_initial_stop(&self) {
        self.update(|d, _| {
            if let Some(action) = d.actions.last_mut().filter(|a| a["action"] == "Stop") {
                action["disposition"] = json!("tolerated_701");
            }
        });
    }
    pub fn snapshot(&self) -> Value {
        let elapsed = millis(self.started);
        let Ok(d) = self.data.lock() else {
            return Value::Null;
        };
        let code = d.terminal.as_ref().map(|(c, _)| c.as_str());
        let control_failed = d.actions.iter().any(|a| {
            a["outcome"] == "failed"
                && (matches!(a["action"].as_str(), Some("SetAVTransportURI" | "Play"))
                    || (a["action"] == "Stop" && a["disposition"] != "tolerated_701"))
        });
        let preparation = matches!(
            code,
            Some(
                "purek_output_media"
                    | "purek_output_codec"
                    | "purek_output_l1_required"
                    | "purek_output_backend_unavailable"
            )
        ) || (d.pipeline_first_packet_ms.is_none() && d.pipeline_end.is_some());
        let pipeline_failed = d
            .pipeline_end
            .is_some_and(|(outcome, _)| outcome == "failed");
        let stage = if preparation {
            "media_preparation"
        } else if control_failed {
            "control"
        } else if pipeline_failed {
            "media_pipeline"
        } else if d
            .actions
            .iter()
            .all(|a| a["action"] != "Play" || a["outcome"] != "ok")
        {
            if code.is_some() {
                "before_play"
            } else {
                "starting"
            }
        } else if d.http.get == 0 && d.http.rejected_peer == 0 {
            "not_requested"
        } else if d.bytes_written == 0 {
            "request_rejected_or_interrupted"
        } else if code.is_some_and(|c| !matches!(c, "stopped" | "paused")) {
            "transport_stopped"
        } else {
            "delivered_unverified"
        };
        let h = &d.http;
        json!({"attempt":d.attempt,"platform":std::env::consts::OS,"managed":d.managed,
            "pipeline_level":d.level,"framing":d.framing,"mime":d.mime,
            "protocol_info":d.protocol_info,"route":d.route,"preflight":d.preflight,
            "listener_ready":d.listener_ready,
            "pipeline":{"first_packet_ms":d.pipeline_first_packet_ms,
                "end":d.pipeline_end.map(|(o,_)|o),"end_ms":d.pipeline_end.map(|(_,t)|t)},
            "http":{"head":h.head,"get":h.get,"streams":h.streams,"rejected_peer":h.rejected_peer,
                "rejected_peer_same_subnet":h.rejected_peer_same_subnet,"not_found":h.not_found,
                "method_not_allowed":h.method,"incomplete":h.incomplete,"conflict":h.conflict,
                "gone":h.gone,"over_client_limit":h.overflow},
            "bytes_written":d.bytes_written,"first_byte_ms":d.first_byte_ms,"last_byte_ms":d.last_byte_ms,
            "disconnects":d.disconnects,"actions":d.actions,
            "transport_info":{"ok":d.transport_ok,"failed":d.transport_failed,
                "last_state":d.transport_state,"monitoring":d.monitoring},
            "stage":stage,"code":code,"terminal_ms":d.terminal.as_ref().map(|(_,t)|*t),
            "elapsed_ms":elapsed})
    }
}
#[derive(Clone, Copy)]
pub(super) enum Request {
    Head,
    Get,
    Stream,
    RejectedPeer { same_subnet: bool },
    NotFound,
    Method,
    Incomplete,
    Conflict,
    Gone,
    Overflow,
}

/// Retained in RoomState, so the Host report reads it under the AppState lock.
#[derive(Default)]
pub(crate) struct Log {
    connections: VecDeque<Value>,
    output: Option<Arc<OutputTrace>>,
    previous: Option<Arc<OutputTrace>>,
}
impl Log {
    pub fn connection(&mut self, entry: Value) {
        if self.connections.len() >= CONNECTIONS {
            self.connections.pop_front();
        }
        self.connections.push_back(entry);
    }
    pub(super) fn begin_output(&mut self, trace: Arc<OutputTrace>) {
        self.previous = self.output.replace(trace);
    }
    pub(super) fn output(&self) -> Option<&Arc<OutputTrace>> {
        self.output.as_ref()
    }
    /// The stable failure stage and code of the current output attempt.
    pub fn output_failure(&self) -> Value {
        let Some(output) = self.output.as_ref().map(|t| t.snapshot()) else {
            return Value::Null;
        };
        if output["code"]
            .as_str()
            .is_some_and(|c| !matches!(c, "stopped" | "paused"))
        {
            json!({ "stage": output["stage"], "code": output["code"] })
        } else {
            Value::Null
        }
    }
    pub fn last_connection_stage(&self) -> Option<&str> {
        self.connections.back()?["failure_stage"].as_str()
    }
    pub fn snapshot(&self) -> Value {
        json!({"connections":self.connections,
            "output":self.output.as_ref().map(|t| t.snapshot()),
            "previous_output":self.previous.as_ref().map(|t| t.snapshot())})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn ok() -> Result<(), ApiError> {
        Ok(())
    }
    fn played() -> Arc<OutputTrace> {
        let trace = OutputTrace::new(true);
        trace.first_packet();
        trace.action("SetAVTransportURI", Instant::now(), &ok());
        trace.action("Play", Instant::now(), &ok());
        trace
    }

    #[test]
    fn output_stage_separates_preparation_control_request_and_delivery() {
        let preparation = OutputTrace::new(true);
        preparation.terminal(Some("purek_output_codec"));
        assert_eq!(preparation.snapshot()["stage"], "media_preparation");

        let pipeline = OutputTrace::new(true);
        pipeline.pipeline_end("failed");
        pipeline.terminal(Some("purek_output_pipeline"));
        assert_eq!(pipeline.snapshot()["stage"], "media_preparation");

        let control = OutputTrace::new(true);
        control.first_packet();
        control.action(
            "Stop",
            Instant::now(),
            &Err::<(), _>(failure(502, "receiver_fault", "x")),
        );
        control.action(
            "SetAVTransportURI",
            Instant::now(),
            &Err::<(), _>(failure(502, "http", "x").with_diagnostic(json!({"http_status":404}))),
        );
        control.terminal(Some("purek_http"));
        let snapshot = control.snapshot();
        assert_eq!(snapshot["stage"], "control");
        assert_eq!(snapshot["actions"][1]["http_status"], 404);

        let quiet = played();
        quiet.terminal(Some("purek_output_not_requested"));
        assert_eq!(quiet.snapshot()["stage"], "not_requested");

        let rejected = played();
        rejected.request(Request::RejectedPeer { same_subnet: true });
        rejected.terminal(Some("purek_output_request_rejected"));
        let snapshot = rejected.snapshot();
        assert_eq!(snapshot["stage"], "request_rejected_or_interrupted");
        assert_eq!(snapshot["http"]["rejected_peer_same_subnet"], 1);

        let delivered = played();
        delivered.request(Request::Get);
        delivered.written(188 * 128);
        assert_eq!(delivered.snapshot()["stage"], "delivered_unverified");
        delivered.transport_state(Ok("STOPPED"), false);
        delivered.terminal(Some("purek_output_interrupted"));
        // A later stop never relabels the first terminal code.
        delivered.terminal(None);
        let snapshot = delivered.snapshot();
        assert_eq!(snapshot["stage"], "transport_stopped");
        assert_eq!(snapshot["code"], "purek_output_interrupted");
        assert_eq!(snapshot["transport_info"]["last_state"], "STOPPED");
        assert_eq!(snapshot["bytes_written"], 188 * 128);

        let midstream = played();
        midstream.request(Request::Get);
        midstream.written(188);
        midstream.pipeline_end("failed");
        midstream.terminal(Some("purek_output_pipeline"));
        assert_eq!(midstream.snapshot()["stage"], "media_pipeline");

        let stopped = played();
        stopped.request(Request::Get);
        stopped.written(188);
        stopped.terminal(Some("paused"));
        assert_eq!(stopped.snapshot()["stage"], "delivered_unverified");
    }

    #[test]
    fn log_keeps_bounded_connections_and_the_previous_output_attempt() {
        let mut log = Log::default();
        for index in 0..10 {
            log.connection(json!({"attempt":index,"failure_stage":"authorization"}));
        }
        assert_eq!(
            log.snapshot()["connections"].as_array().unwrap().len(),
            CONNECTIONS
        );
        assert_eq!(log.last_connection_stage(), Some("authorization"));
        let first = played();
        first.terminal(Some("purek_output_not_requested"));
        log.begin_output(first);
        assert_eq!(log.output_failure()["stage"], "not_requested");
        let second = OutputTrace::new(true);
        log.begin_output(second);
        let snapshot = log.snapshot();
        assert!(
            snapshot["previous_output"]["attempt"].as_u64()
                < snapshot["output"]["attempt"].as_u64()
        );
        assert!(
            log.output_failure().is_null(),
            "a running attempt has no failure"
        );
    }

    #[test]
    fn unknown_transport_states_and_action_text_are_not_recorded() {
        let trace = played();
        trace.transport_state(Ok("CUSTOM secret 192.168.1.8"), false);
        trace.action(
            "Play",
            Instant::now(),
            &Err::<(), _>(failure(502, "receiver_fault", "secret text")),
        );
        let text = trace.snapshot().to_string();
        assert!(!text.contains("secret") && !text.contains("192.168"));
        assert!(trace.snapshot()["transport_info"]["last_state"].is_null());
    }

    #[test]
    fn delivery_liveness_uses_the_last_real_write_instead_of_an_old_counter() {
        let trace = OutputTrace {
            started: Instant::now() - Duration::from_secs(20),
            data: Mutex::new(OutputData {
                bytes_written: 188,
                first_byte_ms: Some(0),
                last_byte_ms: Some(0),
                ..Default::default()
            }),
        };
        assert!(!trace.recent_delivery(Duration::from_secs(15)));
        trace.written(188);
        assert!(trace.recent_delivery(Duration::from_secs(15)));
        assert_eq!(trace.received_stream().2, 376);
    }
}
