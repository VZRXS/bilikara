//! T7a: session-local, bounded, thread-safe DLNA facts and export boundary.
//! No AppState, Python, UI, raw wire payload or autonomous network operation.
//!
//! Stage priority and bounded connection/output traces adapted from
//! bilikara-next 7750dca, native_host/purek/trace.rs (MIT), including 0870f2b.
//! Copyright (c) 2026 bilikara contributors. See NOTICE.md and README.md.
mod identification;
mod model;
mod output;
mod privacy;
#[cfg(test)]
mod tests;

use super::{
    DeviceContext, Disposition, ErrorCode, Operation, Renderer, Stage, StageResult,
    cast_http::{HttpStageResult, Reason},
    discovery::DiscoveryUpdate,
    dlna_policy::{LocalSourceKind, SoapAction, TransportState},
    purek,
};
pub use model::*;
use output::Output;
use privacy::Privacy;
pub use privacy::{AddressClass, Metadata, address_class};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    sync::Mutex,
    time::{Duration, Instant},
};

const DEVICES: usize = 128;
const CONNECTIONS: usize = 6;
const OUTPUTS: usize = 2;
const CELLS: usize = 5;
const DROPPED_DEVICE_KEYS: usize = 4096;
const CANCEL_DRAIN_GRACE: Duration = Duration::from_millis(500);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DiagnosticError {
    EntropyUnavailable,
}
impl std::fmt::Display for DiagnosticError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("cast_diagnostics_entropy_unavailable")
    }
}
impl std::error::Error for DiagnosticError {}

#[derive(Clone, Debug, Serialize)]
struct Route {
    selection: Option<&'static str>,
    routed_source_is_local: Option<bool>,
    route_matches_selected: Option<bool>,
    route_matches_reply: Option<bool>,
}
#[derive(Clone, Debug, Serialize)]
struct Device {
    device_key: String,
    udn_hash: Option<String>,
    source: &'static str,
    sources: Vec<&'static str>,
    server: Metadata,
    route: Option<Route>,
    vendor_class: Option<&'static str>,
    manufacturer: Option<Metadata>,
    model_name: Option<Metadata>,
    model_description: Option<Metadata>,
    friendly_name: Option<Metadata>,
    identification: identification::Identification,
    address_class: Option<AddressClass>,
    local_address_class: Option<AddressClass>,
    same_subnet_24: Option<bool>,
}

#[derive(Clone, Debug, Serialize)]
pub(super) struct Event {
    pub(super) sequence: u64,
    pub at_ms: u64,
    connection: Option<u64>,
    output: Option<u64>,
    device_key: Option<String>,
    pub stage: &'static str,
    pub attempt: u8,
    elapsed_ms: Option<u64>,
    http_status: Option<u16>,
    http_status_class: Option<u16>,
    upnp_code: Option<u32>,
    pub outcome: &'static str,
    result: String,
    pub code: Option<&'static str>,
    transport_error: Option<&'static str>,
    pub disposition: &'static str,
    nonconforming_body: Option<&'static str>,
    facts: Value,
}
#[derive(Clone, Debug, Serialize)]
struct Connection {
    id: u64,
    started_ms: u64,
    discovery_duration_ms: Option<u64>,
    target_before_auth: Option<bool>,
    target_after_auth: Option<bool>,
    target_device_key: Option<String>,
    matched_before_device_key: Option<String>,
    matched_after_device_key: Option<String>,
}

struct State {
    sequence: u64,
    events: Vec<Event>,
    devices: BTreeMap<String, Device>,
    discovered: BTreeSet<String>,
    connections: VecDeque<Connection>,
    outputs: VecDeque<Output>,
    cells: Vec<Output>,
    environment: Environment,
    steps: Vec<SelfTestStep>,
    samples: [Option<MediaPreflight>; 2],
    dropped_stages: usize,
    dropped_device_keys: BTreeSet<String>,
    dropped_device_keys_overflow: bool,
    dropped_device_observations: usize,
    dropped_connections: usize,
    dropped_outputs: usize,
    source_dropped_stages: usize,
    delivery_lagged_stages: u64,
    discovery_dropped: BTreeMap<u64, usize>,
    finished: Option<(u64, String, bool)>,
}

/// Own one collector per cast/self-test session. Constructing it requires fresh
/// OS entropy; never fall back to a deterministic identifier. Drop with session.
/// Only safe projections are retained, so Debug/report/logging never sees inputs.
pub struct SessionTrace {
    privacy: Privacy,
    started: Instant,
    started_at: String,
    app_version: Option<String>,
    os_version: Option<String>,
    platform: Platform,
    target_kind: TargetKind,
    capacity: usize,
    state: Mutex<State>,
}

/// Immutable, already redacted export. Private fields prevent callers injecting
/// arbitrary JSON/text before packaging. Repeated exports of a session correlate;
/// a fresh SessionTrace always uses a fresh key. The salt is never exported.
#[derive(Clone, Debug, Serialize)]
pub struct Report {
    diagnostics: Value,
    text: String,
}
impl Report {
    pub fn json(&self) -> String {
        serde_json::to_string_pretty(&json!({"diagnostics":self.diagnostics}))
            .expect("typed report serializes")
    }
    pub fn text(&self) -> &str {
        &self.text
    }
    pub fn diagnostics(&self) -> &Value {
        &self.diagnostics
    }
    pub fn artifact(
        &self,
        request: &crate::DiagnosticRequest,
    ) -> Result<crate::DiagnosticResult, crate::DiagnosticError> {
        crate::diagnostics::build_diagnostic_artifact_with_cast(request, self)
    }
}

fn ms(d: Duration) -> u64 {
    u64::try_from(d.as_millis()).unwrap_or(u64::MAX)
}

impl SessionTrace {
    pub fn new(
        platform: Platform,
        target_kind: TargetKind,
        app_version: &str,
        os_version: &str,
    ) -> Result<Self, DiagnosticError> {
        Self::with_capacity(platform, target_kind, app_version, os_version, 512)
    }
    pub fn with_capacity(
        platform: Platform,
        target_kind: TargetKind,
        app_version: &str,
        os_version: &str,
        capacity: usize,
    ) -> Result<Self, DiagnosticError> {
        Ok(Self {
            privacy: Privacy::new()?,
            started: Instant::now(),
            started_at: chrono::Local::now().to_rfc3339(),
            app_version: privacy::version(app_version),
            os_version: privacy::version(os_version),
            platform,
            target_kind,
            capacity: capacity.min(4096),
            state: Mutex::new(State {
                sequence: 0,
                events: vec![],
                devices: BTreeMap::new(),
                discovered: BTreeSet::new(),
                connections: VecDeque::new(),
                outputs: VecDeque::new(),
                cells: vec![],
                environment: Environment::default(),
                steps: vec![],
                samples: [None, None],
                dropped_stages: 0,
                dropped_device_keys: BTreeSet::new(),
                dropped_device_keys_overflow: false,
                dropped_device_observations: 0,
                dropped_connections: 0,
                dropped_outputs: 0,
                source_dropped_stages: 0,
                delivery_lagged_stages: 0,
                discovery_dropped: BTreeMap::new(),
                finished: None,
            }),
        })
    }
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }
    pub fn elapsed(&self) -> Duration {
        self.started.elapsed()
    }
    pub fn begin_connection(&self) -> u64 {
        let mut s = self.lock();
        s.sequence = s.sequence.saturating_add(1);
        let id = s.sequence;
        if s.connections.len() == CONNECTIONS {
            if let Some(old) = s.connections.pop_front() {
                s.discovery_dropped.remove(&old.id);
            }
            s.dropped_connections = s.dropped_connections.saturating_add(1);
        }
        s.connections.push_back(Connection {
            id,
            started_ms: ms(self.elapsed()),
            discovery_duration_ms: None,
            target_before_auth: None,
            target_after_auth: None,
            target_device_key: None,
            matched_before_device_key: None,
            matched_after_device_key: None,
        });
        id
    }
    fn device(&self, s: &mut State, context: &DeviceContext) -> String {
        let key = self.privacy.id("device", &context.device_key);
        if !s.devices.contains_key(&key) && s.devices.len() >= DEVICES {
            s.dropped_device_observations = s.dropped_device_observations.saturating_add(1);
            if s.dropped_device_keys.len() < DROPPED_DEVICE_KEYS {
                s.dropped_device_keys.insert(key.clone());
            } else if !s.dropped_device_keys.contains(&key) {
                s.dropped_device_keys_overflow = true;
            }
            return key;
        }
        let previous = s.devices.remove(&key);
        let mut d = Device {
            device_key: key.clone(),
            udn_hash: context
                .udn_hash
                .as_ref()
                .map(|id| self.privacy.id("udn", id)),
            source: match context.source {
                super::DiscoverySource::SearchResponse => "search_response",
                super::DiscoverySource::Notify => "notify",
                super::DiscoverySource::Manual => "manual",
            },
            sources: vec![],
            server: self.privacy.metadata(&context.server, 256),
            route: context.route.as_ref().map(|r| Route {
                selection: r.selection.map(|v| match v {
                    LocalSourceKind::Route => "route",
                    LocalSourceKind::ReplyInterface => "reply_interface",
                    LocalSourceKind::SameSubnet => "same_subnet",
                    LocalSourceKind::Explicit => "explicit",
                }),
                routed_source_is_local: r.routed_source_is_local,
                route_matches_selected: r.route_matches_selected,
                route_matches_reply: r.route_matches_reply,
            }),
            vendor_class: None,
            manufacturer: None,
            model_name: None,
            model_description: None,
            friendly_name: None,
            identification: identification::Identification::default(),
            address_class: None,
            local_address_class: None,
            same_subnet_24: None,
        };
        let server_changed = previous
            .as_ref()
            .is_none_or(|old| old.server.digest != d.server.digest);
        if let Some(old) = previous {
            d.identification = old.identification;
            d.sources = old.sources;
            d.udn_hash = d.udn_hash.or(old.udn_hash);
            d.route = d.route.or(old.route);
            d.vendor_class = old.vendor_class;
            d.manufacturer = old.manufacturer;
            d.model_name = old.model_name;
            d.model_description = old.model_description;
            d.friendly_name = old.friendly_name;
            d.address_class = old.address_class;
            d.local_address_class = old.local_address_class;
            d.same_subnet_24 = old.same_subnet_24;
        }
        if server_changed {
            d.identification.server(&context.server);
        }
        if !d.sources.contains(&d.source) {
            d.sources.push(d.source);
        }
        s.devices.insert(key.clone(), d);
        key
    }
    pub fn renderer(&self, renderer: &Renderer) {
        let mut s = self.lock();
        let key = self.device(&mut s, &renderer.context);
        if let Some(d) = s.devices.get_mut(&key) {
            let r = &renderer.description;
            d.identification.description(r);
            d.vendor_class = Some(r.vendor_class.as_str());
            d.manufacturer = Some(self.privacy.metadata(&r.manufacturer, 256));
            d.model_name = Some(self.privacy.metadata(&r.model_name, 256));
            d.model_description = Some(self.privacy.metadata(&r.model_description, 256));
            d.friendly_name = Some(self.privacy.metadata(&r.name, 64));
            d.local_address_class = Some(address_class(renderer.local_address));
            if let Ok(url) = url::Url::parse(&r.location)
                && let Some(url::Host::Ipv4(peer)) = url.host()
            {
                d.address_class = Some(address_class(peer));
                d.same_subnet_24 = Some(peer.octets()[..3] == renderer.local_address.octets()[..3]);
            }
        }
    }
    pub fn begin_output(&self, context: &DeviceContext, config: OutputConfig) -> u64 {
        let mut s = self.lock();
        let key = self.device(&mut s, context);
        s.sequence = s.sequence.saturating_add(1);
        let id = s.sequence;
        if s.outputs.len() == OUTPUTS {
            s.outputs.pop_front();
            s.dropped_outputs = s.dropped_outputs.saturating_add(1);
        }
        s.outputs
            .push_back(Output::new(id, key, ms(self.elapsed()), config));
        id
    }
    fn push(&self, s: &mut State, mut e: Event) {
        s.sequence = s.sequence.saturating_add(1);
        e.sequence = s.sequence;
        if s.events.len() < self.capacity {
            s.events.push(e);
        } else {
            s.dropped_stages = s.dropped_stages.saturating_add(1);
        }
    }
    fn stage_event(
        &self,
        s: &mut State,
        connection: Option<u64>,
        output: Option<u64>,
        at: Duration,
        stage: &StageResult,
    ) -> Event {
        let error = stage.result.as_ref().err();
        let status = stage
            .http_status
            .or_else(|| error.and_then(|e| e.http_status));
        let device_key = stage.context.as_ref().map(|c| self.device(s, c));
        let facts = context_facts(s, device_key.as_deref());
        Event {
            sequence: s.sequence.saturating_add(1),
            at_ms: ms(at),
            connection,
            output,
            device_key,
            stage: stage.stage.as_str(),
            attempt: stage.attempt,
            elapsed_ms: Some(ms(stage.elapsed)),
            http_status: status,
            http_status_class: status.map(|v| v / 100),
            upnp_code: error.and_then(|e| e.upnp_code),
            outcome: if error.is_some() { "failed" } else { "ok" },
            result: compact_result(error, status),
            code: error.and_then(|e| stage_code(stage.stage, e)),
            transport_error: error.map(|e| e.code.as_str()),
            disposition: match stage.disposition {
                Disposition::Applied => "applied",
                Disposition::Ignored => "ignored",
                Disposition::Retrying => "retrying",
            },
            nonconforming_body: stage
                .nonconforming_body
                .map(|p| ErrorCode::Policy(p).as_str()),
            facts,
        }
    }
    /// For live callbacks use elapsed(); replayed stages need a caller-provided
    /// completion offset on THIS session clock (not an endpoint's elapsed clock).
    pub fn record_stage_at(
        &self,
        connection: Option<u64>,
        output: Option<u64>,
        at: Duration,
        stage: &StageResult,
    ) {
        let mut s = self.lock();
        let e = self.stage_event(&mut s, connection, output, at, stage);
        if let Some(o) = s.outputs.iter_mut().find(|o| Some(o.id) == output) {
            o.action(&e);
        }
        self.push(&mut s, e);
    }
    /// Batch alternative to discovery callbacks; never ingest both for the same
    /// operation. Batch timing reconstructs sequential completions from durations.
    pub fn record_operation<T>(
        &self,
        connection: Option<u64>,
        output: Option<u64>,
        operation: &Operation<T>,
    ) {
        let total = operation
            .stages
            .iter()
            .fold(Duration::ZERO, |d, e| d.saturating_add(e.elapsed));
        let finished = self.elapsed();
        let mut at = finished.saturating_sub(total);
        for e in &operation.stages {
            at = at.saturating_add(e.elapsed).min(finished);
            self.record_stage_at(connection, output, at, e);
        }
        let mut s = self.lock();
        s.source_dropped_stages = s
            .source_dropped_stages
            .saturating_add(operation.dropped_stages);
    }
    pub fn discovery(&self, connection: u64, update: &DiscoveryUpdate) {
        match update {
            DiscoveryUpdate::Stage(stage) => {
                self.record_stage_at(Some(connection), None, self.elapsed(), stage)
            }
            DiscoveryUpdate::Renderers(renderers) => {
                for r in renderers {
                    self.renderer(r);
                    let mut s = self.lock();
                    if s.discovered.len() < DEVICES {
                        s.discovered
                            .insert(self.privacy.id("device", &r.context.device_key));
                    }
                }
            }
            DiscoveryUpdate::StagesDropped(count) => {
                let mut s = self.lock();
                // T2 sends a cumulative count, not a delta. Live stages still
                // arrive, so source loss and collector loss remain separate.
                if s.connections.iter().any(|c| c.id == connection) {
                    let previous = s.discovery_dropped.entry(connection).or_default();
                    let delta = count.saturating_sub(*previous);
                    *previous = (*previous).max(*count);
                    s.source_dropped_stages = s.source_dropped_stages.saturating_add(delta);
                }
            }
        }
    }
    pub fn discovery_facts(
        &self,
        connection: u64,
        duration: Duration,
        before: Option<bool>,
        after: Option<bool>,
    ) {
        if let Some(c) = self
            .lock()
            .connections
            .iter_mut()
            .find(|c| c.id == connection)
        {
            c.discovery_duration_ms = Some(ms(duration));
            c.target_before_auth = before;
            c.target_after_auth = after;
        }
    }
    /// T8 supplies verified identity matches; this records cross-references,
    /// never compares raw UDN/URLs or merges independently salted T2/T9 keys.
    /// Call alongside discovery_facts for the same connection attempt.
    pub fn discovery_target_facts(
        &self,
        connection: u64,
        target: &DeviceContext,
        matched_before: Option<&DeviceContext>,
        matched_after: Option<&DeviceContext>,
    ) {
        let mut s = self.lock();
        if let Some(c) = s.connections.iter_mut().find(|c| c.id == connection) {
            c.target_device_key = Some(self.privacy.id("device", &target.device_key));
            c.matched_before_device_key =
                matched_before.map(|d| self.privacy.id("device", &d.device_key));
            c.matched_after_device_key =
                matched_after.map(|d| self.privacy.id("device", &d.device_key));
        }
    }
    pub fn purek(&self, connection: u64, phase: &purek::PhaseResult) {
        let mut s = self.lock();
        let mut e = self.stage_event(&mut s, Some(connection), None, self.elapsed(), &phase.stage);
        e.stage = phase.phase.as_str();
        e.code = phase.error_code.map(|c| c.as_str());
        let f = &phase.facts;
        if let Some(d) = e.device_key.as_ref().and_then(|key| s.devices.get_mut(key))
            && let Some(summary) = &f.services
        {
            let av = summary
                .entries
                .iter()
                .any(|e| e.kind == purek::ServiceKind::AvTransport);
            let rc = summary
                .entries
                .iter()
                .any(|e| e.kind == purek::ServiceKind::RenderingControl);
            d.identification.rules.has_avtransport = if av || !summary.truncated {
                Some(av)
            } else {
                None
            };
            d.identification.rules.has_rendering_control = if rc || !summary.truncated {
                Some(rc)
            } else {
                None
            };
        }
        let services = f.services.as_ref().map(|summary| json!({"advertised":summary.advertised,
            "truncated":summary.truncated || summary.entries.len() > 32,
            "entries":summary.entries.iter().take(32).map(|entry| {
                let (kind,digest) = match &entry.kind { purek::ServiceKind::AvTransport => ("av_transport",None),
                    purek::ServiceKind::ConnectionManager => ("connection_manager",None),
                    purek::ServiceKind::RenderingControl => ("rendering_control",None),
                    purek::ServiceKind::Other { salted_digest } => ("other",Some(self.privacy.id("service", salted_digest))) };
                json!({"kind":kind,"digest":digest,"version":entry.version})
            }).collect::<Vec<_>>()}));
        e.facts = json!({"schema_version":1,"context":e.facts,"qr":f.qr.as_ref().map(|q| json!({"place_present":q.place_present,
            "bill_present":q.bill_present,"token_present":q.token_present,"token_bytes":q.token_bytes,
            "name_present":q.name_present,"appid_present":q.appid_present,"address_class":purek_class(q.address_class),
            "requires_address_confirmation":q.requires_address_confirmation})),
            "address_class":f.address_class.map(purek_class),"local_address_class":f.local_address_class.map(purek_class),
            "same_subnet_24":f.same_subnet_24,"services":services,"udn_same":f.udn_same,
            "registration_endpoint_changed":f.registration_endpoint_changed,"services_changed_after_auth":f.services_changed_after_auth,
            "route_changed":f.route_changed,"unconfirmed_response":f.unconfirmed_response,"alive":f.alive,
            "announcements_sent":f.announcements_sent,"consecutive_failures":f.consecutive_failures,"recent_delivery":f.recent_delivery});
        self.push(&mut s, e);
    }
    pub fn record_purek_operation<T>(&self, connection: u64, operation: &purek::PureKOperation<T>) {
        for p in &operation.stages {
            self.purek(connection, p);
        }
    }
    pub fn http_at(&self, output: u64, at: Duration, h: &HttpStageResult) {
        let mut s = self.lock();
        let key = self.device(&mut s, &h.context);
        let context = context_facts(&s, Some(&key));
        let e = Event {
            sequence: s.sequence.saturating_add(1),
            at_ms: ms(at),
            connection: None,
            output: Some(output),
            device_key: Some(key),
            stage: h.stage.as_str(),
            attempt: 1,
            elapsed_ms: None,
            http_status: h.http_status,
            http_status_class: h.http_status.map(|v| v / 100),
            upnp_code: None,
            outcome: if h.result.is_ok() { "ok" } else { "failed" },
            result: match h.result {
                Ok(()) => "ok".into(),
                Err(Reason::Cancelled | Reason::GenerationEnded | Reason::Replaced) => {
                    "cancelled".into()
                }
                Err(_) => h
                    .http_status
                    .filter(|s| !(200..300).contains(s))
                    .map_or_else(|| "failed".into(), |s| format!("http:{}xx", s / 100)),
            },
            code: h.result.err().map(http_code),
            transport_error: h.result.err().map(|e| e.as_str()),
            disposition: "applied",
            nonconforming_body: None,
            facts: json!({"context":context,"generation":h.generation,"connection_id":h.connection_id,"bytes_written":h.bytes_written,"endpoint_elapsed_ms":ms(h.elapsed),
                "disconnect_reason":h.disconnect_reason.map(|e| e.as_str()),"media_time_us":h.media_time_us,
                "media_time_basis":"dts_watermark_not_pts"}),
        };
        if let Some(o) = s.outputs.iter_mut().find(|o| o.id == output) {
            o.http(&e, h);
        }
        self.push(&mut s, e);
    }
    /// Await in the admitted worker; this function never spawns a detached task.
    /// Capture endpoint_origin before bind, then subscribe before publication.
    /// On cancellation allow up to 500ms for endpoint terminal events, stopping
    /// earlier when the sender closes. T5 must shut down its endpoint concurrently.
    /// Lag is explicit; T5 may separately
    /// recover first_get_written from T4's snapshot without replaying duplicates.
    pub async fn receive_http(
        &self,
        output: u64,
        endpoint_origin: Duration,
        receiver: &mut tokio::sync::broadcast::Receiver<HttpStageResult>,
        cancel: &super::CancellationToken,
    ) {
        loop {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => break,
                result = receiver.recv() => match result {
                    Ok(h) => self.http_at(output, endpoint_origin.saturating_add(h.elapsed), &h),
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => self.lagged(n),
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
                }
            }
        }
        let deadline = tokio::time::Instant::now() + CANCEL_DRAIN_GRACE;
        while tokio::time::Instant::now() < deadline {
            match tokio::time::timeout_at(deadline, receiver.recv()).await {
                Ok(Ok(h)) => self.http_at(output, endpoint_origin.saturating_add(h.elapsed), &h),
                Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(n))) => self.lagged(n),
                Ok(Err(tokio::sync::broadcast::error::RecvError::Closed)) | Err(_) => break,
            }
        }
    }
    /// Record events lost by an external, generation-aware HTTP receiver.
    pub fn lagged(&self, n: u64) {
        let mut s = self.lock();
        s.delivery_lagged_stages = s.delivery_lagged_stages.saturating_add(n);
    }
    pub fn environment(&self, mut facts: Environment) {
        facts.interface_kinds.truncate(32);
        self.lock().environment = facts;
    }
    pub fn self_test_step(&self, step: SelfTestStep) {
        let mut s = self.lock();
        if let Some(old) = s.steps.iter_mut().find(|v| v.stage == step.stage) {
            *old = step;
        } else {
            s.steps.push(step);
        }
    }
    pub fn sample(&self, variant: Variant, facts: MediaPreflight) {
        self.lock().samples[usize::from(variant == Variant::B)] = Some(facts);
    }
    pub fn capabilities(
        &self,
        output: u64,
        state: ProtocolState,
        sinks: &[String],
        av_transport: bool,
        rendering_control: bool,
    ) {
        let mut s = self.lock();
        let mut facts = None;
        if let Some(o) = s.outputs.iter_mut().find(|o| o.id == output) {
            o.protocol_info_state = state;
            o.sink_mime_classes.clear();
            for sink in sinks.iter().take(512) {
                // MIME categories only. Never retain protocolInfo extension text.
                let mime = sink_mime(sink);
                if !o.sink_mime_classes.contains(&mime) {
                    o.sink_mime_classes.push(mime);
                }
            }
            o.av_transport_present = Some(av_transport);
            o.rendering_control_present = Some(rendering_control);
            facts = Some((o.device.clone(), o.sink_mime_classes.contains(&Mime::Ts)));
        }
        if let Some((key, ts)) = facts
            && let Some(d) = s.devices.get_mut(&key)
        {
            d.identification.rules.has_avtransport = Some(av_transport);
            d.identification.rules.has_rendering_control = Some(rendering_control);
            d.identification.rules.declares_ts = match state {
                ProtocolState::Reported | ProtocolState::Empty => Some(ts),
                _ => None,
            };
        }
    }
    pub fn first_ts_packet(&self, output: u64) {
        if let Some(o) = self.lock().outputs.iter_mut().find(|o| o.id == output) {
            o.first_ts_packet_ms.get_or_insert(ms(self.elapsed()));
        }
    }
    pub fn failure(&self, output: u64, failure: Failure) {
        if let Some(o) = self.lock().outputs.iter_mut().find(|o| o.id == output) {
            o.failure.get_or_insert(failure);
        }
    }
    pub fn observations(&self, output: u64, facts: RequestObservations) {
        if let Some(o) = self.lock().outputs.iter_mut().find(|o| o.id == output) {
            o.observations = facts;
        }
    }
    pub fn transport(&self, output: u64, state: TransportState, position_advanced: Option<bool>) {
        if let Some(o) = self.lock().outputs.iter_mut().find(|o| o.id == output) {
            let state = match state {
                TransportState::Stopped => Transport::Stopped,
                TransportState::Playing => Transport::Playing,
                TransportState::Transitioning => Transport::Transitioning,
                TransportState::Paused => Transport::PausedPlayback,
                TransportState::NoMedia => Transport::NoMediaPresent,
                TransportState::Unknown => Transport::Unknown,
            };
            o.transport_baseline.get_or_insert(state);
            if o.transport_states.len() < 32 {
                o.transport_states.push(state);
            } else {
                o.dropped_transport_states = o.dropped_transport_states.saturating_add(1);
            }
            o.position_advanced = position_advanced.or(o.position_advanced);
        }
    }
    /// Freeze one matrix cell before starting the next. At most five unique cells.
    pub fn complete_output(&self, output: u64, answers: UserAnswers) {
        let mut s = self.lock();
        let Some(o) = s.outputs.iter_mut().find(|o| o.id == output) else {
            return;
        };
        o.user_answers = answers;
        o.terminal = true;
        o.ended_ms = Some(ms(self.elapsed()));
        let cell = o.clone();
        if let Some(kind) = cell.cell {
            s.cells.retain(|o| o.cell != Some(kind));
            if s.cells.len() < CELLS {
                s.cells.push(cell);
            }
        }
    }
    pub fn skip_output(&self, output: u64, reason: SkipReason) {
        if let Some(o) = self.lock().outputs.iter_mut().find(|o| o.id == output) {
            o.skip_reason = Some(reason);
        }
        self.complete_output(output, UserAnswers::default());
    }
    pub fn finish(&self, cancelled: bool) {
        let mut s = self.lock();
        s.finished.get_or_insert((
            ms(self.elapsed()),
            chrono::Local::now().to_rfc3339(),
            cancelled,
        ));
    }
    pub fn report(&self) -> Report {
        self.report_at(self.elapsed())
    }
    fn report_at(&self, elapsed: Duration) -> Report {
        let s = self.lock();
        let now = s.finished.as_ref().map_or(ms(elapsed), |f| f.0);
        let mut events = s.events.clone();
        events.sort_by_key(|e| (e.at_ms, e.sequence));
        let devices: Vec<_> = s.devices.values().map(|d| json!({"device":d,
            "stages":events.iter().filter(|e| e.device_key.as_ref() == Some(&d.device_key)).collect::<Vec<_>>()})).collect();
        let mut conclusion = output::conclusion(&s.cells);
        if conclusion.decision_row.is_none() {
            conclusion.decision_row =
                if s.cells.iter().any(|o| {
                    o.classification(now).0 == "delivered_unverified"
                        && matches!(
                            o.user_answers.video,
                            VideoAnswer::Black | VideoAnswer::Unsupported
                        )
                }) {
                    Some(6)
                } else if s
                    .cells
                    .iter()
                    .any(|o| o.classification(now).1 == Some("cast_not_requested"))
                {
                    Some(7)
                } else if s.cells.iter().any(|o| {
                    matches!(
                        o.classification(now).1,
                        Some("cast_request_rejected" | "cast_no_delivery" | "cast_interrupted")
                    )
                }) {
                    Some(8)
                } else if s.cells.iter().any(|o| {
                    o.actions.iter().any(|a| {
                        matches!(a.stage, "Stop" | "SetAVTransportURI" | "Play")
                            && (a.upnp_code.is_some() || a.transport_error == Some("soap_fault"))
                    })
                }) {
                    Some(9)
                } else if events
                    .iter()
                    .any(|e| e.code == Some("cast_purek_authorization_rejected"))
                {
                    Some(10)
                } else if s.connections.iter().any(|c| {
                    c.target_before_auth == Some(false) && c.target_after_auth == Some(true)
                }) {
                    Some(11)
                } else if s.discovered.is_empty()
                    && s.cells.iter().any(|o| {
                        o.classification(now).1 == Some("cast_control_unreachable")
                            || o.skip_reason == Some(SkipReason::NoReceiver)
                    })
                {
                    Some(12)
                } else {
                    None
                };
        }
        let metadata = json!({"schema_version":1,"app_version":self.app_version,"platform":self.platform,"os_version":self.os_version,
            "started_at":self.started_at,"finished_at":s.finished.as_ref().map(|f| &f.1),"elapsed_ms":now,
            "cancelled":s.finished.as_ref().is_some_and(|f| f.2),"target_kind":self.target_kind});
        let cast = json!({"schema_version":1,"connections":s.connections,"devices":devices,"stages":events,
            "output":s.outputs.back().map(|o| o.snapshot(now)),"previous_output":s.outputs.iter().rev().nth(1).map(|o| o.snapshot(now)),
            "dropped_stages":s.dropped_stages,"source_dropped_stages":s.source_dropped_stages,"delivery_lagged_stages":s.delivery_lagged_stages,
            "dropped_devices":(!s.dropped_device_keys_overflow).then_some(s.dropped_device_keys.len()),
            "dropped_devices_lower_bound":s.dropped_device_keys.len() + usize::from(s.dropped_device_keys_overflow),
            "dropped_device_observations":s.dropped_device_observations,
            "dropped_connections":s.dropped_connections,"dropped_outputs":s.dropped_outputs});
        let self_test = json!({"schema_version":1,"metadata":metadata,"environment":s.environment,"steps":s.steps,
            "discovery":{"count":s.discovered.len(),"connections":s.connections,"devices":devices},
            "purek":events.iter().filter(|e| e.stage.starts_with("purek_")).collect::<Vec<_>>(),
            "capabilities":s.outputs.back().map(|o| json!({"protocol_info_state":o.protocol_info_state,"sink_mime_classes":o.sink_mime_classes,
                "transport_baseline":o.transport_baseline,"av_transport_present":o.av_transport_present,"rendering_control_present":o.rendering_control_present})),
            "preflight":{"sample_a":s.samples[0],"sample_b":s.samples[1]},
            "cells":s.cells.iter().map(|o| o.snapshot(now)).collect::<Vec<_>>(),"conclusion":conclusion});
        let mut text = format!(
            "DLNA diagnostics schema v1\n{}\nDevices: {}; elapsed: {} ms; cancelled: {}\nDropped: collector={}, source={}, broadcast={}\n",
            self.started_at,
            s.devices.len(),
            now,
            s.finished.as_ref().is_some_and(|f| f.2),
            s.dropped_stages,
            s.source_dropped_stages,
            s.delivery_lagged_stages
        );
        text.push_str(&format!(
            "Platform: {:?}; target: {:?}; app: {}; OS version: {}\n",
            self.platform,
            self.target_kind,
            self.app_version.as_deref().unwrap_or("unknown"),
            self.os_version.as_deref().unwrap_or("unknown")
        ));
        for d in s.devices.values() {
            text.push_str(&format!(
                "Device {}: {}\n",
                d.device_key,
                d.identification.summary()
            ));
        }
        for o in s
            .outputs
            .iter()
            .filter(|_| s.steps.is_empty())
            .chain(s.cells.iter().filter(|_| !s.steps.is_empty()))
        {
            let (stage, code) = o.classification(now);
            text.push_str(&format!(
                "Output {} device {}: {} / {}; bytes={}\n",
                o.id,
                o.device,
                stage,
                code.unwrap_or("none"),
                o.bytes_written
            ));
            if !s.steps.is_empty() {
                text.push_str(&format!(
                    "  {:?}: video={:?}; audio={:?}; sync={:?}; skip={:?}\n",
                    o.cell,
                    o.user_answers.video,
                    o.user_answers.audio,
                    o.user_answers.synchronized,
                    o.skip_reason
                ));
            }
        }
        for e in events.iter().filter(|_| s.steps.is_empty()) {
            text.push_str(&format!(
                "{} ms {}: {} {} (HTTP {:?}, UPnP {:?}, duration {:?} ms)\n",
                e.at_ms,
                e.stage,
                e.result,
                e.code.unwrap_or("none"),
                e.http_status,
                e.upnp_code,
                e.elapsed_ms
            ));
        }
        text.push_str(&format!(
            "Decision row: {:?}; physical picture/audio require user answers.\n",
            conclusion.decision_row
        ));
        Report {
            diagnostics: json!({"cast":cast,"cast_self_test":self_test}),
            text,
        }
    }
}

fn context_facts(s: &State, key: Option<&str>) -> Value {
    key.and_then(|k| s.devices.get(k)).map_or(
        Value::Null,
        |d| json!({"source":d.source,"route":d.route,"udn_hash":d.udn_hash}),
    )
}

fn sink_mime(sink: &str) -> Mime {
    let mut parts = sink.splitn(4, ':');
    let _protocol = parts.next();
    let _network = parts.next();
    let mime = parts.next().unwrap_or("").trim().to_ascii_lowercase();
    let extension = parts.next().unwrap_or("");
    // T1 deliberately accepts video/mpeg for TS playback. It alone is also
    // used for program streams, so require an explicitly TS DLNA profile here.
    // Keep only a category; never export the untrusted profile/extension text.
    let ts_profile = extension.split(';').any(|part| {
        part.split_once('=').is_some_and(|(key, value)| {
            key.trim().eq_ignore_ascii_case("DLNA.ORG_PN") && {
                let value = value.trim().to_ascii_uppercase();
                ["MPEG_TS_", "AVC_TS_", "HEVC_TS_", "VC1_TS_"]
                    .iter()
                    .any(|prefix| value.starts_with(prefix))
            }
        })
    });
    match mime.as_str() {
        "video/mp2t"
        | "video/mpeg_ts"
        | "video/vnd.dlna.mpeg-tts"
        | "video/x-mpegts"
        | "video/mpegts"
        | "video/mpeg-ts" => Mime::Ts,
        "video/mpeg" | "video/x-mpeg" if ts_profile => Mime::Ts,
        "video/mpeg" | "video/x-mpeg" => Mime::Mpeg,
        "video/mp4" => Mime::Mp4,
        "*" => Mime::Wildcard,
        v if v.starts_with("audio/") => Mime::Audio,
        _ => Mime::Other,
    }
}

fn compact_result(error: Option<&super::DlnaError>, status: Option<u16>) -> String {
    let Some(error) = error else {
        return "ok".into();
    };
    if matches!(
        error.code,
        ErrorCode::Policy(super::dlna_policy::PolicyError::SoapFault(_))
    ) {
        return error
            .upnp_code
            .map_or_else(|| "fault:unknown".into(), |code| format!("fault:{code}"));
    }
    match error.code {
        ErrorCode::Timeout => "timeout".into(),
        ErrorCode::Connect | ErrorCode::Io => "unreachable".into(),
        ErrorCode::Cancelled => "cancelled".into(),
        _ => status
            .filter(|s| !(200..300).contains(s))
            .map_or_else(|| "failed".into(), |s| format!("http:{}xx", s / 100)),
    }
}

fn purek_class(c: purek::AddressClass) -> &'static str {
    match c {
        purek::AddressClass::Private => "private",
        purek::AddressClass::Shared => "shared",
        purek::AddressClass::LinkLocal => "link_local",
        purek::AddressClass::Hostname => "hostname",
        purek::AddressClass::LoopbackFixture => "loopback",
    }
}
fn http_code(reason: Reason) -> &'static str {
    match reason {
        Reason::PublicPeer
        | Reason::NotFound
        | Reason::Method
        | Reason::MalformedRequest
        | Reason::IncompleteHeader
        | Reason::HeaderTimeout
        | Reason::HeaderTooLarge
        | Reason::HeaderPreempted
        | Reason::Range => "cast_request_rejected",
        Reason::ProducerFailed | Reason::FileChanged => "cast_media_pipeline_failed",
        Reason::Cancelled | Reason::GenerationEnded | Reason::Replaced | Reason::Completed => {
            "cast_cancelled"
        }
        _ => "cast_interrupted",
    }
}
fn stage_code(stage: Stage, error: &super::DlnaError) -> Option<&'static str> {
    if stage == Stage::Action(SoapAction::Stop) {
        return None;
    }
    if error.is_cancelled() {
        return Some("cast_cancelled");
    }
    Some(match stage {
        Stage::Action(SoapAction::GetProtocolInfo) => "cast_capability_unavailable",
        Stage::Action(_) => {
            if error.is_network() {
                "cast_control_unreachable"
            } else if matches!(
                error.code,
                ErrorCode::Policy(super::dlna_policy::PolicyError::SoapFault(_))
            ) {
                "cast_control_fault"
            } else {
                "cast_control_http"
            }
        }
        Stage::Description => {
            if error.is_network() {
                "cast_description_unreachable"
            } else {
                "cast_description_invalid"
            }
        }
        Stage::Route => "cast_route_unavailable",
        _ => "cast_discovery_unavailable",
    })
}
