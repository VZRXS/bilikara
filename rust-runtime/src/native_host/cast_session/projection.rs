//! next 3057fb7 snapshot contract, projected from the R1/R2 T5 authority.
//! No connection, output selection or playback state is owned by this adapter.
use super::*;

impl State {
    fn status(&self) -> &'static str {
        if self.error_code.is_some() || self.room_error.is_some() {
            "error"
        } else if self.owns_playback && !self.output_enabled {
            "stopping"
        } else if self.phase == Phase::Connecting || self.room_busy {
            "starting"
        } else if self.control_busy {
            if self.paused { "starting" } else { "pausing" }
        } else if self.owns_playback {
            if self.paused {
                "paused"
            } else if self.delivered {
                "streaming"
            } else {
                "starting"
            }
        } else if self.connected {
            if self.output_enabled {
                "waiting"
            } else {
                "authorized"
            }
        } else {
            "stopped"
        }
    }

    pub(crate) fn output_projection(&self, host: bool) -> Value {
        json!({"schema_version":1,
            "target":if self.owns_playback {"purek"} else {"local"},
            "requested_target":if self.output_enabled {"purek"} else {"local"},
            "status":self.status(),"available":crate::media_routing::output_companion().is_some(),
            "authorized":self.connected,"can_manage":host,"experimental":true,"qualified":false,
            "busy":self.room_busy || self.pending.is_some() || self.control_busy,
            "desired_playing":self.output_enabled && !self.paused,"position":self.position,"duration":self.duration,
            "transition_remaining_ms":0,"pipeline_level":if self.owns_playback {Some("L0")} else {None},
            "stream_generation":self.generation.max(self.room_generation),"producer_eof":false,"preview_tail_sequence":null,
            "offset_mode":match self.offset_mode {bilikara_rust::output_audio::OffsetMode::Splice=>"splice",bilikara_rust::output_audio::OffsetMode::Gradual=>"gradual"},"last_error":self.error_code.as_ref().or(self.room_error.as_ref()),
            "measured_adjust_latency_ms":null,"position_source":"sender_estimate",
            "thermal_status":null,"thermal_headroom":null,
            "failure":if host {self.failure()} else {Value::Null}})
    }

    fn failure(&self) -> Value {
        self.error_code
            .as_ref()
            .or(self.room_error.as_ref())
            .map(|code| json!({"stage":"cast","code":code}))
            .unwrap_or(Value::Null)
    }

    fn sink_formats(&self) -> Vec<Value> {
        let mut formats = Vec::new();
        for entry in &self.sink_protocols {
            let parts: Vec<_> = entry.splitn(4, ':').collect();
            if parts.len() != 4 || !parts[0].eq_ignore_ascii_case("http-get") {
                continue;
            }
            let mime = parts[2]
                .split(';')
                .next()
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase();
            if mime.len() > 129
                || !mime
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"/!#$&^_.+-*".contains(&b))
            {
                continue;
            }
            let profile = parts[3]
                .split(';')
                .find_map(|p| p.strip_prefix("DLNA.ORG_PN="))
                .filter(|p| {
                    !p.is_empty()
                        && p.len() <= 128
                        && p.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
                });
            let value = json!({"mime":mime,"profile":profile});
            if !formats.contains(&value) {
                formats.push(value);
            }
        }
        formats
    }

    pub(crate) fn capability_unverified(&self) -> bool {
        self.protocol_state != Some(crate::dlna::diagnostics::ProtocolState::Reported)
            || !self.sink_formats().iter().any(|f| {
                matches!(
                    f["mime"].as_str(),
                    Some("video/mp2t" | "video/mpeg" | "*" | "video/*")
                )
            })
    }

    pub(crate) fn room_snapshot(&self) -> Value {
        let renderer = self
            .selected
            .as_ref()
            .and_then(|key| self.renderers.iter().find(|r| renderer_key(r) == *key));
        json!({"auto_discovery":self.auto_discovery,"busy":self.room_busy || self.pending.is_some() || self.control_busy,
            "connected":self.connected,"room_name":self.room.as_ref().map(|r| &r.name),
            "connection_type":self.room.as_ref().map(super::super::purek::Room::connection_type),
            "discovered":self.renderers.iter().map(|r|r.description.name.chars().take(100).collect::<String>()).collect::<Vec<_>>(),
            "error_code":self.room_error.as_ref().or(self.error_code.as_ref()),
            "error_stage":if self.room_error.is_some() || self.error_code.is_some(){Some("cast")}else{None},
            "capabilities":{"dlna_sender":false,"airplay":"system"},
            "output":{"schema_version":1,"target_room_id":self.connection_id,"generation":self.generation.max(self.room_generation),
                "status":self.status(),"capabilities":{
                    "has_av_transport":self.connected && renderer.is_some(),
                    "has_rendering_control":self.connected && renderer.is_some_and(|r|r.description.rendering_control.is_some()),
                    "has_connection_manager":self.connected && renderer.is_some_and(|r|r.description.connection_manager.is_some()),
                    "protocol_info_state":self.protocol_state.unwrap_or(crate::dlna::diagnostics::ProtocolState::NotChecked),"protocol_info_error":self.protocol_error,
                    "supports_play":false,"supports_pause":false,"supports_seek":false,
                    "supports_live_stream":false,"supports_midstream_param_change":false,
                    "supports_runtime_av_offset":false,"supports_track_switch":false,"supports_pitch_shift":false,
                    "sink_formats":self.sink_formats()},
                "pipeline_level":if self.owns_playback {Some("L0")} else {None},
                "offset_mode":match self.offset_mode {bilikara_rust::output_audio::OffsetMode::Splice=>"splice",bilikara_rust::output_audio::OffsetMode::Gradual=>"gradual"},"last_error":self.error_code,
                "measured_adjust_latency_ms":null}})
    }

    pub(crate) fn observation(&self, item: &str, generation: u64) -> Value {
        let phase = if self.error_code.is_some() {
            "failed"
        } else if self.paused {
            "paused"
        } else if self.phase == Phase::Active && self.delivered {
            "playing"
        } else {
            "starting"
        };
        json!({"item_id":item,"playback_generation":generation,"status_sequence":self.observation_sequence.max(1),
            "observed_phase":phase,"is_paused":phase!="playing","current_time":self.position,"duration":self.duration,
            "position_source":"sender_estimate"})
    }

    pub(crate) fn diagnostics(&self) -> Value {
        self.trace
            .as_ref()
            .map(|t| t.report().diagnostics().clone())
            .unwrap_or(Value::Null)
    }
}

/// The B5/B5b command contract remains usable by old Hosts and public Remotes.
pub(crate) fn output_command(
    context: &Arc<HostContext>,
    identity: &Identity,
    body: &Value,
) -> Result<Value, ApiError> {
    let object = body
        .as_object()
        .ok_or_else(|| ApiError::invalid("JSON object required"))?;
    if body.get("offset_mode").is_some() {
        if with_app(|app| Ok(app.native().local_output.controller.owns_playback))? {
            return super::super::native_output::controller::command(identity, body);
        }
        return with_app(|app| {
            let host = app.native_authorize(identity, false)?;
            let mode = match body["offset_mode"].as_str() {
                Some("splice") => bilikara_rust::output_audio::OffsetMode::Splice,
                Some("gradual") => bilikara_rust::output_audio::OffsetMode::Gradual,
                _ => return Err(ApiError::invalid("Invalid offset mode")),
            };
            if object.len() != 1 {
                return Err(ApiError::invalid("offset_mode must be the only field"));
            }
            if !app.native().cast.owns_playback {
                return Err(ApiError::new(
                    409,
                    "purek_output_not_selected",
                    "Select output on Host first",
                ));
            }
            // P8 connects the same setting to L1; raw R1 delivery cannot apply it.
            if mode != bilikara_rust::output_audio::OffsetMode::Splice {
                return Err(ApiError::new(
                    409,
                    "purek_output_l1_required",
                    "L1 output is required",
                ));
            }
            app.native().cast.offset_mode = mode;
            app.native().revision += 1;
            app.native_snapshot(host)
        });
    }
    with_app(|app| app.native_authorize(identity, true))?;
    let target = body["target"]
        .as_str()
        .filter(|t| matches!(*t, "local" | "purek" | "native"))
        .ok_or_else(|| ApiError::invalid("Invalid output target"))?;
    if object
        .keys()
        .any(|k| !matches!(k.as_str(), "target" | "experimental"))
        || (target != "local" && body["experimental"] != true)
    {
        return Err(ApiError::new(
            400,
            "purek_output_experimental",
            "Experimental output requires confirmation",
        ));
    }
    let (connected, local, connecting) = with_app(|app| {
        Ok((
            app.native().cast.connected,
            app.native().local_output.controller.owns_playback,
            app.native().cast.room_busy || app.native().cast.pending.is_some(),
        ))
    })?;
    if target == "native" || (local && target == "local") {
        return super::super::native_output::controller::command(identity, body);
    }
    if !connected {
        if connecting {
            return Err(ApiError::new(
                409,
                "purek_busy",
                "Receiver connection is pending",
            ));
        }
        if target == "purek" {
            return Err(ApiError::new(
                409,
                "purek_not_authorized",
                "Connect a receiver first",
            ));
        }
        return with_app(|app| app.native_snapshot(true));
    }
    route(
        context,
        identity,
        &Method::POST,
        "/api/cast/output",
        &json!({"enabled":target=="purek"}),
    )?;
    with_app(|app| app.native_snapshot(true))
}

pub(crate) fn resume_local(app: &mut crate::app_state::AppState) -> Result<(), ApiError> {
    use crate::app_state::{AppStateRequest, PlayerControlInput};
    let resume = app.native().cast.resume.clone();
    if resume == app.native().cast.published_resume {
        return Ok(());
    }
    let Some(resume) = resume else {
        app.native().cast.published_resume = None;
        return Ok(());
    };
    let input = app.native_cast_input()?;
    let Some(item) = input.current_item else {
        return Ok(());
    };
    if resume["playback_generation"] != input.playback_generation || resume["item_id"] != item.id {
        return Ok(());
    }
    app.native_clear_output_controls();
    for action in [
        "seek-absolute",
        if resume["is_paused"] == true {
            "pause"
        } else {
            "play"
        },
    ] {
        app.native_execute(AppStateRequest::IssuePlayerControl {
            schema_version: 1,
            control: PlayerControlInput {
                expected_queue_version: None,
                action: action.into(),
                playback_generation: input.playback_generation,
                item_id: item.id.clone(),
                delta_seconds: 0.0,
                target_seconds: (action == "seek-absolute")
                    .then(|| resume["position"].as_f64().unwrap_or(0.0)),
            },
            now: now(),
        })?;
    }
    app.native().cast.published_resume = Some(resume);
    Ok(())
}
