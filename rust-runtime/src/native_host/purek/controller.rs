//! AppState-owned output selection and transport. Only the worker executes I/O;
//! stale work must match the committed intent version before publishing.
use super::*;
use crate::app_state::{AppState, AppStateRequest};
use bilikara_rust::output_controller::{self as policy, Action, Control, Facts, Transport};

#[derive(Clone, Default)]
pub(crate) struct Controller {
    pub(super) selected: bool,
    /// Remains true while an explicit switch back to local is stopping the TV.
    pub(crate) owns_playback: bool,
    playing: bool,
    position: f64,
    duration: f64,
    anchor: f64,
    clock: Option<Instant>,
    program: Option<String>,
    started: Option<String>,
    completed: bool,
    restart: bool,
    pending: bool,
    version: u64,
    status_sequence: u64,
    transition: Option<Instant>,
    transition_remaining: u64,
    pub(super) error: Option<String>,
    pub(super) release_platform: bool,
    thermal_status: Option<i32>,
    thermal_headroom: Option<f32>,
}
impl Controller {
    #[cfg(target_os = "android")]
    pub(crate) fn platform_failure(&mut self, code: &str) {
        self.fail(code);
    }
    #[cfg(target_os = "android")]
    pub(crate) fn thermal(&mut self, status: i32, headroom: f32) {
        self.thermal_status = (0..=6).contains(&status).then_some(status);
        self.thermal_headroom = (headroom.is_finite() && headroom >= 0.0).then_some(headroom);
    }
    pub(super) fn managed(&self, version: u64) -> bool {
        self.selected && self.owns_playback && self.version == version
    }
    pub(super) fn streaming(&mut self) {
        if self.selected
            && self.owns_playback
            && self.playing
            && self.error.is_none()
            && self.clock.is_none()
        {
            self.anchor = self.position;
            self.clock = Some(Instant::now());
        }
    }
    fn bump(&mut self) {
        self.version = self.version.wrapping_add(1);
        self.pending = true;
    }
    fn position_at(&self, instant: Instant) -> f64 {
        let value = self.clock.map_or(self.position, |clock| {
            self.anchor + instant.saturating_duration_since(clock).as_secs_f64()
        });
        value.clamp(
            0.0,
            if self.duration > 0.0 {
                self.duration
            } else {
                21600.0
            },
        )
    }
    fn freeze(&mut self, instant: Instant) {
        self.position = self.position_at(instant);
        self.anchor = self.position;
        self.clock = None;
    }
    pub(super) fn fail(&mut self, code: &str) {
        self.freeze(Instant::now());
        self.version = self.version.wrapping_add(1);
        self.playing = false;
        self.pending = false;
        self.release_platform = true;
        self.error = Some(code.to_owned());
        self.completed = false;
    }
    pub(super) fn finish(&mut self, signature: &str) {
        if self.owns_playback
            && self.selected
            && self.program.as_deref() == Some(signature)
            && self.started.as_deref() == Some(signature)
        {
            self.freeze(Instant::now());
            self.position = self.duration.max(self.position);
            self.completed = true;
        }
    }
    pub(crate) fn projection(&self, room: &RoomState, host: bool) -> Value {
        let output = room.output.snapshot();
        let status = if !self.owns_playback {
            output["status"].as_str().unwrap_or("stopped")
        } else if self.error.is_some() {
            "error"
        } else if !self.selected {
            "stopping"
        } else if room.busy || self.pending {
            if self.playing { "starting" } else { "pausing" }
        } else if !self.playing {
            if self.release_platform {
                "stopped"
            } else {
                "paused"
            }
        } else if self.program.is_none()
            || self.transition.is_some()
            || room.output.running.is_none()
        {
            "waiting"
        } else {
            output["status"].as_str().unwrap_or("starting")
        };
        json!({"schema_version":1,"target":if self.owns_playback{"purek"}else{"local"},
            "requested_target":if self.selected{"purek"}else{"local"},"status":status,
            "available":crate::media_routing::output_companion().is_some(),"authorized":room.connected.is_some(),
            "can_manage":host,"experimental":true,"qualified":false,"busy":room.busy||self.pending,
            "desired_playing":self.playing,"position":self.position,"duration":self.duration,
            "transition_remaining_ms":self.transition_remaining,"pipeline_level":output["pipeline_level"],
            "offset_mode":output["offset_mode"],"last_error":self.error.as_deref().map(Value::from).unwrap_or_else(||output["last_error"].clone()),
            "measured_adjust_latency_ms":output["measured_adjust_latency_ms"],"position_source":"sender_estimate",
            "thermal_status":self.thermal_status,"thermal_headroom":self.thermal_headroom})
    }
    pub(crate) fn observation(&self, item: &str, generation: u64, room: &RoomState) -> Value {
        let phase = if self.error.is_some() {
            "failed"
        } else if !self.playing || !self.selected {
            "paused"
        } else if room.output.running.is_some()
            && room.output.snapshot()["status"] == "streaming"
            && !room.busy
            && !self.pending
        {
            "playing"
        } else {
            "starting"
        };
        json!({"item_id":item,"playback_generation":generation,"status_sequence":self.status_sequence.max(1),
            "observed_phase":phase,"is_paused":phase!="playing","current_time":self.position,"duration":self.duration,
            "position_source":"sender_estimate"})
    }
}

pub(crate) fn command(identity: &Identity, body: &Value) -> Result<Value, ApiError> {
    let object = body
        .as_object()
        .ok_or_else(|| ApiError::invalid("JSON object required"))?;
    with_app(|app| {
        let host = app.native_authorize(identity, false)?;
        if object.len() == 1 && body.get("offset_mode").is_some() {
            let mode = match body["offset_mode"].as_str() {
                Some("splice") => bilikara_rust::output_audio::OffsetMode::Splice,
                Some("gradual") => bilikara_rust::output_audio::OffsetMode::Gradual,
                _ => return Err(ApiError::invalid("offset_mode must be splice or gradual")),
            };
            let room = &mut app.native().purek;
            if room.busy {
                return Err(busy());
            }
            if !room.controller.owns_playback {
                return Err(failure(
                    409,
                    "output_not_selected",
                    "请先在 Host 选择电视输出",
                ));
            }
            room.output.mode = mode;
        } else {
            app.native_authorize(identity, true)?;
            let target = body["target"]
                .as_str()
                .filter(|s| matches!(*s, "local" | "purek"))
                .ok_or_else(|| ApiError::invalid("target must be local or purek"))?;
            if object
                .keys()
                .any(|k| !matches!(k.as_str(), "target" | "experimental"))
                || (target == "purek" && body["experimental"] != true)
            {
                return Err(failure(
                    400,
                    "output_experimental",
                    "实验性电视输出需要明确确认",
                ));
            }
            if app.native().purek.busy {
                return Err(busy());
            }
            if target == "purek" {
                if crate::media_routing::output_companion().is_none() {
                    return Err(failure(
                        501,
                        "output_backend_unavailable",
                        "此构建没有原生媒体输出",
                    ));
                }
                if app.native().purek.connected.is_none() {
                    return Err(failure(409, "not_authorized", "请先在 Host 授权房台"));
                }
                app.native().purek.output.protocol()?;
            }
            let observation = app.native_snapshot(true)?["player_status"].clone();
            let program = output::signature(app, true).ok();
            let active = app.native().purek.output.running.is_some();
            let c = &mut app.native().purek.controller;
            if target == "purek" {
                if !c.owns_playback {
                    c.position = observation["current_time"].as_f64().unwrap_or(0.0);
                    c.duration = observation["duration"].as_f64().unwrap_or(0.0);
                    c.program = program;
                }
                c.selected = true;
                c.owns_playback = true;
                c.playing = true;
                c.restart = true;
                c.error = None;
                c.release_platform = false;
                c.completed = false;
                c.transition = None;
            } else {
                c.freeze(Instant::now());
                c.selected = false;
                c.owns_playback = c.owns_playback || active;
                c.error = None;
                c.release_platform = true;
            }
            app.native_clear_output_controls();
            app.native().purek.controller.bump();
        }
        app.native().revision += 1;
        app.native_snapshot(host)
    })
}

fn control(app: &mut AppState, c: &mut Controller, instant: Instant) -> Result<(), ApiError> {
    let Some(command) = app.native_output_control() else {
        return Ok(());
    };
    let facts = app.native_output_audio_facts()?;
    if command["playback_generation"] != facts.source.3 || command["item_id"] != facts.source.0 {
        app.native_execute(AppStateRequest::AckPlayerControl {
            schema_version: 1,
            seq: command["seq"].as_u64().unwrap_or(0),
        })?;
        return Ok(());
    }
    let action = match command["action"].as_str() {
        Some("play") => Control::Play,
        Some("pause") => Control::Pause,
        Some("toggle-play") => Control::Toggle,
        Some("seek-relative") => {
            Control::SeekRelative(command["delta_seconds"].as_f64().unwrap_or(0.0))
        }
        Some("seek-absolute") => {
            Control::SeekAbsolute(command["target_seconds"].as_f64().unwrap_or(0.0))
        }
        Some("next-track") => Control::Next,
        _ => return Err(ApiError::invalid("Invalid output control")),
    };
    let intent = policy::control(
        Transport {
            playing: c.playing,
            position: c.position_at(instant),
            duration: c.duration,
        },
        action,
    )
    .map_err(|_| ApiError::invalid("Invalid output position"))?;
    c.freeze(instant);
    c.position = intent.transport.position;
    c.playing = intent.transport.playing;
    if c.playing {
        c.error = None;
        c.release_platform = false;
    }
    c.restart |= intent.restart;
    c.bump();
    if intent.next {
        advance(app, c, Some(facts.source.3), instant)?;
    }
    app.native_execute(AppStateRequest::AckPlayerControl {
        schema_version: 1,
        seq: command["seq"].as_u64().unwrap_or(0),
    })?;
    Ok(())
}
fn advance(
    app: &mut AppState,
    c: &mut Controller,
    generation: Option<u64>,
    instant: Instant,
) -> Result<(), ApiError> {
    let facts = app.native_output_audio_facts()?;
    if generation.is_none() {
        app.native_execute(AppStateRequest::ApplyPlayerStatusObservation {
            schema_version: 1,
            expected_playback_generation: facts.source.3,
            item_id: facts.source.0.clone(),
            is_paused: false,
            current_time: c.duration,
            duration: c.duration,
            now: now(),
        })?;
    }
    let delay = facts.settings.song_advance_delay_seconds.max(0) as u64;
    let reset_av_delay = app.native().cache_policy.reset_offset_on_next;
    app.native_execute(AppStateRequest::AdvanceToNext {
        schema_version: 1,
        expected_playback_generation: facts.source.3,
        reset_av_delay,
        now: now(),
    })?;
    c.completed = false;
    c.freeze(instant);
    c.playing = true;
    c.pending = true;
    c.transition = Some(instant + Duration::from_secs(delay));
    Ok(())
}

struct Plan {
    action: Action,
    version: u64,
    program: Option<String>,
    position: f64,
}
fn plan(app: &mut AppState, instant: Instant, paint: bool) -> Result<Option<Plan>, ApiError> {
    let mut c = app.native().purek.controller.clone();
    if !c.owns_playback && !c.selected {
        return Ok(None);
    }
    if app.native().purek.busy {
        return Ok(None);
    }
    let facts = match app.native_output_audio_facts() {
        Ok(f) => Some(f),
        Err(e) if e.code == "output_media" => None,
        Err(e) => return Err(e),
    };
    let program = facts
        .as_ref()
        .map(|_| output::signature(app, true))
        .transpose()?;
    if program != c.program {
        c.program = program.clone();
        c.position = 0.0;
        c.anchor = 0.0;
        c.duration = 0.0;
        c.clock = None;
        c.completed = false;
        c.restart = false;
    }
    if c.selected && facts.is_some() {
        control(app, &mut c, instant)?;
    }
    let program = output::signature(app, true).ok();
    let facts = app.native_output_audio_facts().ok();
    if c.transition.is_some_and(|t| instant >= t) {
        c.transition = None;
    }
    c.transition_remaining = c.transition.map_or(0, |t| {
        t.saturating_duration_since(instant).as_millis() as u64
    });
    if paint {
        c.position = c.position_at(instant);
        c.status_sequence = c.status_sequence.saturating_add(1);
    }
    let action = if c.error.is_some() && app.native().purek.connected.is_none() {
        if app.native().purek.output.running.is_some() {
            Action::Stop
        } else {
            Action::Keep
        }
    } else {
        policy::decide(Facts {
            selected: c.selected,
            authorized: app.native().purek.connected.is_some(),
            busy: false,
            blocked: c.error.is_some(),
            has_item: facts.is_some(),
            cache_ready: facts.as_ref().is_some_and(|f| f.cache_ready),
            active: app.native().purek.output.running.is_some(),
            same_program: c.started == program,
            playing: c.playing,
            restart: c.restart,
            completed: c.completed,
            waiting_for_transition: c.transition.is_some(),
        })
    };
    let plan = Plan {
        action,
        version: c.version,
        program,
        position: c.position,
    };
    if matches!(action, Action::Keep | Action::Wait) {
        c.pending = false;
    }
    let observation = if paint && c.selected && c.clock.is_some() {
        facts.map(|f| (f.source.0, f.source.3, c.position, c.duration, !c.playing))
    } else {
        None
    };
    app.native().purek.controller = c;
    if paint {
        app.native().revision += 1;
    }
    if let Some((item, generation, position, duration, paused)) = observation {
        app.native_execute(AppStateRequest::ApplyPlayerStatusObservation {
            schema_version: 1,
            expected_playback_generation: generation,
            item_id: item,
            is_paused: paused,
            current_time: position,
            duration,
            now: now(),
        })?;
    }
    Ok(Some(plan))
}
pub(crate) fn maintain(context: Arc<HostContext>) {
    let mut last = Instant::now() - Duration::from_secs(2);
    while !context.stop.load(Ordering::Acquire) {
        let instant = Instant::now();
        let paint = last.elapsed() >= Duration::from_secs(1);
        if paint {
            last = instant;
        }
        if let Ok(Some(plan)) = with_app(|app| plan(app, instant, paint)) {
            let result = match plan.action {
                Action::Start => {
                    output::start_managed(&context, plan.position, plan.version).map(|_| ())
                }
                Action::Stop => output::stop(false, None).map(|_| ()),
                Action::Pause => output::stop(true, None).map(|_| ()),
                Action::Disconnected => {
                    let _ = output::stop(false, Some("purek_not_authorized"));
                    Err(failure(
                        409,
                        "not_authorized",
                        "房台已断开，请重新授权或选择本地输出",
                    ))
                }
                Action::Advance => with_app(|app| {
                    let mut c = app.native().purek.controller.clone();
                    if c.version == plan.version
                        && output::signature(app, true).ok() == plan.program
                    {
                        advance(app, &mut c, None, instant)?;
                        app.native().purek.controller = c;
                        app.native().revision += 1;
                    }
                    Ok(())
                }),
                Action::Keep | Action::Wait => Ok(()),
            };
            let _ = with_app(|app| {
                if app.native().purek.controller.version != plan.version {
                    return Ok(());
                }
                if let Err(error) = result {
                    if error.code != "purek_busy" {
                        app.native().purek.controller.fail(&error.code);
                        app.native().revision += 1;
                    }
                    return Ok(());
                }
                if plan.action == Action::Start {
                    let duration = app.native().purek.output.running.as_ref().map_or(0.0, |r| {
                        r.duration_us.load(Ordering::Acquire) as f64 / 1_000_000.0
                    });
                    let delivered = app.native().purek.output.running.as_ref().is_some_and(|r| {
                        r.played.load(Ordering::Acquire) && r.delivered.load(Ordering::Acquire)
                    });
                    let c = &mut app.native().purek.controller;
                    c.started = plan.program;
                    c.anchor = c.position;
                    c.clock = None;
                    c.duration = duration;
                    if delivered {
                        c.streaming();
                    }
                    c.restart = false;
                    c.pending = false;
                    app.native().revision += 1;
                } else if matches!(plan.action, Action::Stop | Action::Pause) {
                    let c = &mut app.native().purek.controller;
                    c.freeze(instant);
                    c.restart = false;
                    c.pending = false;
                    app.native().revision += 1;
                }
                if !app.native().purek.controller.selected
                    && app.native().purek.output.running.is_none()
                {
                    let c = app.native().purek.controller.clone();
                    if let Ok(f) = app.native_output_audio_facts() {
                        for action in [
                            json!({"action":"seek-absolute","target_seconds":c.position}),
                            json!({"action":if c.playing{"play"}else{"pause"}}),
                        ] {
                            app.native_execute(AppStateRequest::IssuePlayerControl {
                                schema_version: 1,
                                control: crate::app_state::PlayerControlInput {
                                    action: action["action"].as_str().unwrap().into(),
                                    playback_generation: f.source.3,
                                    item_id: f.source.0.clone(),
                                    delta_seconds: 0.0,
                                    target_seconds: action["target_seconds"].as_f64(),
                                },
                                now: now(),
                            })?;
                        }
                    }
                    app.native().purek.controller = Controller::default();
                    app.native().revision += 1;
                }
                Ok(())
            });
        }
        let desired = with_app(|app| {
            use super::super::output_platform::OutputActivity::*;
            let room = &app.native().purek;
            Ok(if room.controller.release_platform {
                Stopped
            } else if room.output.running.is_some() {
                Playing
            } else if room.controller.owns_playback
                && room.controller.selected
                && room.controller.program.is_some()
            {
                Paused
            } else {
                Stopped
            })
        });
        if let Ok(desired) = desired {
            match super::super::output_platform::apply(desired) {
                Ok(()) => (),
                Err(error) => {
                    let _ = with_app(|app| {
                        app.native().purek.controller.fail(&error.code);
                        app.native().revision += 1;
                        Ok(())
                    });
                }
            }
        }
        thread::sleep(Duration::from_millis(100));
    }
    let _ = super::super::output_platform::apply(
        super::super::output_platform::OutputActivity::Stopped,
    );
}
