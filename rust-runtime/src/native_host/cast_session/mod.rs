//! One joined worker owns network resources; all observable state lives in AppState.
use super::*;
use crate::app_state::cast::{LearnedMode, Mode, Variant};
use crate::app_state::native_session::text;
use crate::dlna::{CancellationToken, Renderer, diagnostics::SessionTrace};
use std::sync::Arc;

mod l1;
mod media;
mod projection;
mod worker;
pub(crate) use projection::output_command;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Phase {
    #[default]
    Idle,
    Discovering,
    Connecting,
    Active,
    Recovering,
}

#[derive(Clone)]
pub(crate) struct Assisted {
    pub remote: String,
    pub request: String,
    pub epoch: String,
    pub generation: u64,
}

pub(crate) enum Request {
    Discover(Option<String>),
    Connect {
        output: crate::cast_platform::OutputLease,
        renderer: Option<Box<Renderer>>,
        qr: Option<String>,
        confirmed: bool,
        location: Option<String>,
        assisted: Option<Assisted>,
    },
    Disconnect,
}
#[derive(Clone, Debug)]
pub(crate) enum Control {
    Pause,
    Play,
    Next,
    Seek(f64),
    Restart,
    ProgramChanged,
    Probe,
}

#[derive(Default)]
pub(crate) struct State {
    pub delivered: bool,
    pub protocol_state: Option<crate::dlna::diagnostics::ProtocolState>,
    pub protocol_error: Option<String>,
    pub capability_probe_running: bool,
    pub sink_protocols: Vec<String>,
    pub auto_discovery: bool,
    pub room_generation: u64,
    pub room_busy: bool,
    pub room: Option<super::purek::Room>,
    pub room_error: Option<String>,
    // Sanitized next-compatible code/stage derived from the failed transport operation.
    pub room_failure: Option<(String, &'static str)>,
    // Local output failures do not revoke the receiver connection or room lease.
    pub output_failure: Option<(String, &'static str)>,
    pub connection_id: Option<String>,
    pub connection_cancel: Option<CancellationToken>,
    pub offset_mode: bilikara_rust::output_audio::OffsetMode,
    pub observation_sequence: u64,
    pub published_resume: Option<Value>,
    pub network_facts: crate::cast_platform::NetworkFacts,
    pub platform_output_id: Option<u64>,
    pub platform_stop_error: Option<&'static str>,
    pub phase: Phase,
    pub owns_playback: bool,
    /// Actual admitted live L1 pipeline; never inferred from receiver metadata.
    pub l1: bool,
    // A suspended output retains its worker, renderer and Pure K registration.
    // Existing clients continue to use owns_playback/local_media for playback.
    pub connected: bool,
    // Desired output; owns_playback changes only after awaited output cleanup.
    pub output_enabled: bool,
    pub pipeline_running: bool,
    pub pipeline_result: Option<Value>,
    pub operation: u64,
    pub generation: u64,
    pub playback_generation: u64,
    pub renderers: Vec<Renderer>,
    pub selected: Option<String>,
    pub session_devices: std::collections::BTreeMap<String, crate::app_state::cast::Device>,
    pub receiver_state: Option<&'static str>,
    pub position: f64,
    pub duration: f64,
    pub paused: bool,
    pub error_code: Option<String>,
    pub resume: Option<Value>,
    pub mode: Mode,
    pub pending: Option<Request>,
    pub control: Option<Control>,
    pub control_busy: bool,
    pub cancel: CancellationToken,
    pub mux_stop: Arc<AtomicBool>,
    pub trace: Option<Arc<SessionTrace>>,
    pub worker_started: bool,
    pub worker_mutation: bool,
}
impl State {
    pub fn visible(&self) -> bool {
        self.operation != 0 || !self.session_devices.is_empty()
    }
    pub fn snapshot(&self, preferences: &crate::app_state::cast::Preferences) -> Value {
        let preference = self
            .selected
            .as_ref()
            .and_then(|k| {
                preferences
                    .devices
                    .get(k)
                    .or_else(|| self.session_devices.get(k))
            })
            .cloned()
            .unwrap_or_default();
        json!({"phase":self.phase,"owns_playback":self.owns_playback,
            "network_hint":self.network_facts.network_hint(),"network_facts":self.network_facts,
            "connected":self.connected,"output_enabled":self.output_enabled,
            "pipeline_running":self.pipeline_running,"pipeline_result":self.pipeline_result,
            "operation_id":self.operation,"generation":self.generation,
            "renderers":self.renderers.iter().map(|r| json!({"device_key":renderer_key(r),"preferences_persisted":preference_key(r).is_some(),"label":r.description.name.chars().take(100).collect::<String>()})).collect::<Vec<_>>(),
            "devices":preferences.devices.iter().chain(self.session_devices.iter()).map(|(key,d)|(key.clone(),json!({"mode":d.mode,"learned_mode":d.learned_mode}))).collect::<serde_json::Map<_,_>>(),
            "selected":self.selected,"receiver_state":self.receiver_state,"position":self.position,
            "duration":self.duration,"is_paused":self.paused,"error_code":self.error_code,"resume":self.resume,
            "mode":preference.mode,"learned_mode":preference.learned_mode,"effective_mode":self.mode,
            "busy":self.control_busy || self.pending.is_some() || self.pipeline_running,"local_media":if self.owns_playback {"retain_paused_muted"} else {"host"}})
    }
    fn replace(&mut self, request: Request, phase: Phase) {
        self.cancel.cancel();
        self.cancel = CancellationToken::new();
        self.mux_stop.store(true, Ordering::Release);
        self.operation += 1;
        self.pending = Some(request);
        self.phase = phase;
        self.control = None;
        self.control_busy = false;
        self.error_code = None;
        self.room_error = None;
        self.room_failure = None;
        self.output_failure = None;
        self.capability_probe_running = false;
        self.protocol_state = None;
        self.protocol_error = None;
        self.sink_protocols.clear();
        self.resume = None;
        self.published_resume = None;
        self.delivered = false;
        self.l1 = false;
    }
}

/// Persistence identity is independent of T2 URL fallbacks and T9 trace salts.
fn preference_key(renderer: &Renderer) -> Option<String> {
    use sha2::{Digest, Sha256};
    let udn = crate::dlna::dlna_policy::canonical_usn(&renderer.description.id);
    if !udn.starts_with("uuid:")
        || udn.len() <= 5
        || udn == renderer.description.location.to_ascii_lowercase()
        || udn.starts_with("http:")
        || udn.starts_with("https:")
    {
        return None;
    }
    Some(
        Sha256::digest(udn.as_bytes())[..16]
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect(),
    )
}
fn renderer_key(renderer: &Renderer) -> String {
    preference_key(renderer).unwrap_or_else(|| renderer.context.device_key.clone())
}

pub(super) fn route(
    context: &Arc<HostContext>,
    identity: &Identity,
    method: &Method,
    path: &str,
    body: &Value,
) -> Result<Value, ApiError> {
    if path == "/api/cast/capabilities" && method == Method::GET {
        with_app(|app| app.native_authorize(identity, true))?;
        return Ok(
            json!({"pipeline_available":media::probe().is_ok_and(|probe| probe.cast_mux_available())}),
        );
    }
    with_app(|app| {
        app.native_authorize(identity, path != "/api/cast/command")?;
        if path == "/api/cast/report" && method == Method::GET {
            return app
                .native()
                .cast
                .trace
                .as_ref()
                .map(|t| {
                    let report = t.report();
                    json!({"diagnostics":report.diagnostics(),"text":report.text()})
                })
                .ok_or_else(|| {
                    ApiError::new(404, "cast_report_unavailable", "No cast report yet")
                });
        }
        if method != Method::POST || !body.is_object() {
            return Err(ApiError::invalid("Cast requires POST JSON"));
        }
        if app.native_session_choice_pending() {
            return Err(ApiError::new(
                409,
                "session_choice_pending",
                "Choose a session first",
            ));
        }
        if context.stop.load(Ordering::Acquire) {
            return Err(ApiError::new(503, "stopped", "Host stopped"));
        }
        if path == "/api/cast/command"
            && matches!(
                body["command"].as_str(),
                Some("cast.set_device_mode" | "cast.set_device_learning")
            )
        {
            app.native_authorize(identity, true)?;
            let key = text(body, "device_key")?;
            if !crate::app_state::cast::valid_key(&key) {
                return Err(ApiError::invalid("Invalid device key"));
            }
            let persistent = app.cast_preferences()?.devices.contains_key(&key)
                || app
                    .native()
                    .cast
                    .renderers
                    .iter()
                    .any(|r| preference_key(r).as_deref() == Some(&key));
            if !persistent
                && !app
                    .native()
                    .cast
                    .renderers
                    .iter()
                    .any(|r| renderer_key(r) == key)
            {
                return Err(ApiError::new(
                    409,
                    "cast_device_preferences_unavailable",
                    "Discover the receiver first",
                ));
            }
            let revision = body["revision"]
                .as_u64()
                .ok_or_else(|| ApiError::invalid("Missing revision"))?;
            let mut device = app
                .cast_preferences()?
                .devices
                .get(&key)
                .cloned()
                .or_else(|| app.native().cast.session_devices.get(&key).cloned())
                .unwrap_or_default();
            if body["command"] == "cast.set_device_mode" {
                device.mode = serde_json::from_value(body["mode"].clone())
                    .map_err(|_| ApiError::invalid("Invalid mode"))?;
            } else {
                device.learned_mode =
                    serde_json::from_value::<Option<LearnedMode>>(body["learned_mode"].clone())
                        .map_err(|_| ApiError::invalid("Invalid learned mode"))?;
                device.learned_variant =
                    serde_json::from_value::<Option<Variant>>(body["learned_variant"].clone())
                        .map_err(|_| ApiError::invalid("Invalid learned variant"))?;
                let learned = device.learned_mode.is_some() || device.learned_variant.is_some();
                device.learned_at = learned.then(|| chrono::Utc::now().to_rfc3339());
                device.self_test_report_version = learned.then_some(1);
            }
            device.last_used = chrono::Utc::now().timestamp_millis().max(0) as u64;
            let effective = device.effective_mode();
            if app.native().cast.owns_playback
                && app.native().cast.selected.as_deref() == Some(&key)
                && app.native().cast.control_busy
            {
                return Err(ApiError::new(
                    409,
                    "cast_busy",
                    "Wait for the current cast operation",
                ));
            }
            if persistent {
                app.cast_set_device(&key, revision, device)?;
            } else {
                app.cast_set_session_device(&key, revision, device)?;
            }
            let state = &mut app.native().cast;
            if (state.connected || state.owns_playback)
                && state.selected.as_deref() == Some(&key)
                && state.mode != effective
            {
                state.mode = effective;
                if state.owns_playback {
                    state.control = Some(Control::Restart);
                    state.control_busy = true;
                }
            }
            return app.native_snapshot(true);
        }
        if app.native().cast.pipeline_running && path != "/api/cast/disconnect" {
            return Err(ApiError::new(409, "cast_busy", "Pipeline test is running"));
        }
        match path {
            "/api/cast/output" => {
                let enabled = body["enabled"]
                    .as_bool()
                    .ok_or_else(|| ApiError::invalid("Missing output selection"))?;
                let s = &mut app.native().cast;
                if !s.connected || s.phase != Phase::Active || s.control_busy {
                    return Err(ApiError::new(
                        409,
                        "cast_renderer_unavailable",
                        "No connected receiver",
                    ));
                }
                if s.output_enabled != enabled {
                    if enabled && s.output_failure.take().is_some() {
                        s.error_code = None;
                    }
                    s.output_enabled = enabled;
                    s.control_busy = true;
                }
            }
            "/api/cast/preferences" => {
                if body.as_object().is_none_or(|o| o.len() != 1) {
                    return Err(ApiError::invalid("auto_discovery must be the only field"));
                }
                let enabled = body["auto_discovery"]
                    .as_bool()
                    .ok_or_else(|| ApiError::invalid("auto_discovery must be a boolean"))?;
                let session = app.native();
                super::preferences::save(
                    &context.directory,
                    &session.cache_policy,
                    session.ui_language,
                    enabled,
                )?;
                session.cast.auto_discovery = enabled;
            }
            "/api/cast/probe" => {
                if body.as_object().is_none_or(|o| !o.is_empty()) {
                    return Err(ApiError::invalid("probe requires an empty object"));
                }
                let state = &mut app.native().cast;
                if !state.connected || state.phase != Phase::Active || state.control_busy {
                    return Err(ApiError::new(
                        409,
                        "cast_busy",
                        "Connect and wait for current operation",
                    ));
                }
                state.control = Some(Control::Probe);
                state.control_busy = true;
            }
            "/api/cast/discover" => {
                if app.native().cast.connected || app.native().cast.owns_playback {
                    return Err(ApiError::new(
                        409,
                        "cast_busy",
                        "Disconnect before discovery",
                    ));
                }
                let location = body
                    .get("description_url")
                    .map(|_| text(body, "description_url"))
                    .transpose()?;
                if let Some(location) = &location {
                    crate::dlna::dlna_policy::lan_url(
                        location,
                        crate::dlna::dlna_policy::NetworkPolicy::Lan,
                    )
                    .map_err(|_| ApiError::invalid("Discovery requires a LAN IPv4 URL"))?;
                }
                app.native()
                    .cast
                    .replace(Request::Discover(location), Phase::Discovering);
                app.native().cast.network_facts = crate::cast_platform::network_facts();
            }
            "/api/cast/connect" => {
                if app.native().local_output.controller.owns_playback || app.native().cast.room_busy
                {
                    return Err(ApiError::new(
                        409,
                        "cast_busy",
                        "Stop the current output operation first",
                    ));
                }
                if body.get("device_key").is_none() && body.get("purek_qr").is_none() {
                    let room = if let Some(url) =
                        body["url"].as_str().or(body["description_url"].as_str())
                    {
                        super::purek::Room::from_input(url)?
                    } else {
                        app.native().cast.room.clone().ok_or_else(|| {
                            ApiError::invalid("Prepare or discover a receiver first")
                        })?
                    };
                    let output = crate::cast_platform::OutputLease::acquire()
                        .map_err(|e| ApiError::new(409, e.code(), e.code()))?;
                    app.native().cast.room_generation += 1;
                    admit_prepared(
                        app,
                        context,
                        room,
                        output,
                        body["address_confirmed"] == true,
                        None,
                    )?;
                    return Ok(json!({"accepted":true,"operation_id":app.native().cast.operation}));
                }
                let qr = body
                    .get("purek_qr")
                    .map(|_| text(body, "purek_qr"))
                    .transpose()?;
                let renderer = if qr.is_some() {
                    None
                } else {
                    let key = text(body, "device_key")?;
                    Some(Box::new(
                        app.native()
                            .cast
                            .renderers
                            .iter()
                            .find(|r| renderer_key(r) == key)
                            .cloned()
                            .ok_or_else(|| {
                                ApiError::new(
                                    409,
                                    "cast_renderer_unavailable",
                                    "Discover the receiver again",
                                )
                            })?,
                    ))
                };
                let snapshot = app.native_snapshot(true)?;
                let output = crate::cast_platform::OutputLease::acquire()
                    .map_err(|error| ApiError::new(409, error.code(), error.code()))?;
                app.native().cast.platform_output_id = Some(output.id());
                app.native().cast.platform_stop_error = None;
                app.native().cast.network_facts = crate::cast_platform::network_facts();
                if !app.native().cast.owns_playback {
                    app.native().cast.position = snapshot["player_status"]["current_time"]
                        .as_f64()
                        .unwrap_or(0.0);
                    app.native().cast.paused = snapshot["player_status"]["is_paused"]
                        .as_bool()
                        .unwrap_or(false);
                }
                app.native().cast.playback_generation =
                    snapshot["playback_generation"].as_u64().unwrap_or(0);
                app.native().cast.replace(
                    Request::Connect {
                        output,
                        renderer,
                        qr,
                        confirmed: body["address_confirmed"] == true,
                        location: None,
                        assisted: None,
                    },
                    Phase::Connecting,
                );
                app.native().cast.room = None;
                app.native().cast.room_generation += 1;
                app.native().cast.room_busy = true;
                app.native().cast.room_error = None;
                app.native().cast.owns_playback = snapshot["current_item"].is_object();
                app.native().cast.output_enabled = true;
            }
            "/api/cast/disconnect" => {
                app.native().cast.room_generation += 1;
                app.native().cast.room = None;
                app.native().cast.room_busy = false;
                app.native().cast.protocol_state = None;
                app.native().cast.protocol_error = None;
                app.native().cast.sink_protocols.clear();
                app.native()
                    .cast
                    .replace(Request::Disconnect, Phase::Recovering);
            }
            "/api/cast/command" => {
                enqueue(app, body)?;
            }
            _ => return Err(ApiError::new(404, "not_found", "Unknown cast route")),
        }
        app.native().revision += 1;
        ensure_worker(app, context)?;
        Ok(json!({"accepted":true,"operation_id":app.native().cast.operation}))
    })
}

/// Fixed native callback. Never trust a stale service/notification to stop a
/// newer output. Both paths retain the existing awaited Pure K cleanup.
pub fn platform_stopped(lease_id: u64, reason: i32) {
    if !matches!(reason, 1..=4) {
        return;
    }
    let _ = with_app(|app| {
        let cast = &mut app.native().cast;
        if cast.platform_output_id != Some(lease_id) {
            return Ok(());
        }
        cast.platform_output_id = None;
        cast.platform_stop_error = match reason {
            3 => Some("cast_platform_unavailable"),
            4 => Some("purek_output_thermal"),
            _ => None,
        };
        cast.replace(Request::Disconnect, Phase::Recovering);
        app.native().revision += 1;
        Ok(())
    });
}

pub(crate) fn enqueue(app: &mut crate::app_state::AppState, body: &Value) -> Result<(), ApiError> {
    let snapshot = app.native_core_snapshot()?;
    if body
        .get("expected_queue_version")
        .is_some_and(|v| !v.is_null() && !v.is_string())
    {
        return Err(ApiError::invalid("Invalid queue version"));
    }
    if body
        .get("item_id")
        .is_some_and(|v| v.as_str() != snapshot.current_item.as_ref().map(|i| i.id.as_str()))
        || body["playback_generation"].as_u64() != Some(snapshot.playback_generation)
    {
        return Err(ApiError::new(409, "stale_player", "Playback changed"));
    }
    if matches!(body["action"].as_str(), Some("next" | "next-track"))
        && body
            .get("expected_queue_version")
            .and_then(Value::as_str)
            .is_some_and(|v| v != snapshot.queue_version)
    {
        return Err(ApiError::new(
            409,
            "queue_version_conflict",
            "Queue changed",
        ));
    }
    let state = &mut app.native().cast;
    if !state.owns_playback || state.phase != Phase::Active {
        return Err(ApiError::new(409, "cast_not_active", "Cast is not active"));
    }
    if state.control_busy {
        return Err(ApiError::new(409, "cast_busy", "Cast command is pending"));
    }
    let action = body["action"]
        .as_str()
        .ok_or_else(|| ApiError::invalid("Missing action"))?;
    state.control = Some(match action {
        "pause" => Control::Pause,
        "play" | "resume" => Control::Play,
        "toggle-pause" | "toggle-play" => {
            if state.paused {
                Control::Play
            } else {
                Control::Pause
            }
        }
        "next" | "next-track" => Control::Next,
        "seek-absolute" | "seek-relative" => {
            if state.mode == Mode::Live {
                return Err(ApiError::new(
                    409,
                    "cast_seek_unsupported",
                    "Seeking live delivery is not supported in this version",
                ));
            }
            let v = if action == "seek-relative" {
                body["delta_seconds"].as_f64().map(|d| state.position + d)
            } else {
                body["target_seconds"].as_f64()
            };
            Control::Seek(
                v.filter(|v| v.is_finite() && v.abs() <= 86400.0)
                    .ok_or_else(|| ApiError::invalid("Invalid seek"))?
                    .max(0.0)
                    .min(state.duration.max(0.0)),
            )
        }
        _ => {
            return Err(ApiError::new(
                400,
                "cast_command_unsupported",
                "Unsupported cast command",
            ));
        }
    });
    state.control_busy = true;
    app.native().revision += 1;
    Ok(())
}

#[cfg(test)]
mod tests;

fn ensure_worker(
    app: &mut crate::app_state::AppState,
    context: &Arc<HostContext>,
) -> Result<(), ApiError> {
    if !app.native().cast.worker_started {
        let ctx = context.clone();
        if context
            .spawn("dlna-session", move || worker::run(ctx))
            .is_err()
        {
            let input = app.native_cast_input()?;
            let state = &mut app.native().cast;
            state.pending = None;
            state.phase = Phase::Idle;
            state.owns_playback = false;
            state.platform_output_id = None;
            state.connected = false;
            state.output_enabled = false;
            state.pipeline_running = false;
            state.error_code = Some("cast_worker_unavailable".into());
            state.resume = Some(
                json!({"item_id":input.current_item.as_ref().map(|i|&i.id),"playback_generation":input.playback_generation,"position":state.position,"is_paused":state.paused,"operation_id":state.operation}),
            );
            return Err(ApiError::new(
                503,
                "cast_worker_unavailable",
                "Cannot start cast worker",
            ));
        }
        app.native().cast.worker_started = true;
    }
    Ok(())
}

pub(crate) fn admit_prepared(
    app: &mut crate::app_state::AppState,
    context: &Arc<HostContext>,
    room: super::purek::Room,
    output: crate::cast_platform::OutputLease,
    confirmed: bool,
    assisted: Option<Assisted>,
) -> Result<(), ApiError> {
    if context.stop.load(Ordering::Acquire) {
        return Err(ApiError::new(503, "stopped", "Host stopped"));
    }
    let snapshot = app.native_snapshot(true)?;
    let has_media = app.native_cast_input()?.current_item.is_some();
    let state = &mut app.native().cast;
    state.platform_output_id = Some(output.id());
    state.position = snapshot["player_status"]["current_time"]
        .as_f64()
        .unwrap_or(0.0);
    state.paused = snapshot["player_status"]["is_paused"]
        .as_bool()
        .unwrap_or(false);
    state.playback_generation = snapshot["playback_generation"].as_u64().unwrap_or(0);
    let qr = room.authorization_url().map(str::to_owned);
    let location = qr.is_none().then(|| room.description.to_string());
    state.platform_stop_error = None;
    state.room = Some(room);
    state.replace(
        Request::Connect {
            output,
            renderer: None,
            qr,
            confirmed,
            location,
            assisted,
        },
        Phase::Connecting,
    );
    state.room_busy = true;
    state.room_error = None;
    state.connection_cancel = Some(state.cancel.clone());
    state.output_enabled = true;
    state.owns_playback = has_media;
    app.native().revision += 1;
    ensure_worker(app, context)
}

/// Preserve next's opt-in discovery without creating another network worker.
pub(super) fn auto_discover(context: &Arc<HostContext>) -> Result<(), ApiError> {
    with_app(|app| {
        if !app.native().cast.auto_discovery || app.native_session_choice_pending() {
            return Ok(());
        }
        let state = &mut app.native().cast;
        if state.connected
            || state.room_busy
            || state.room.is_some()
            || state.pending.is_some()
            || state.phase != Phase::Idle
        {
            return Ok(());
        }
        state.replace(Request::Discover(None), Phase::Discovering);
        app.native().revision += 1;
        ensure_worker(app, context)
    })
}
