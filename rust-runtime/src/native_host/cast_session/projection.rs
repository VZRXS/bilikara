//! next 3057fb7 snapshot contract, projected from the R1/R2 T5 authority.
//! No connection, output selection or playback state is owned by this adapter.
use super::*;

// Keep the existing next vocabulary on compatibility fields. The cast snapshot
// and T7 report retain the original R1 code for more detailed diagnostics.
pub(super) fn legacy_error(code: &str) -> &str {
    match code {
        "cast_purek_address_confirmation_required" | "purek_address_confirmation_required" => {
            "purek_qr_invalid"
        }
        "cast_purek_cancelled" | "cancelled" | "purek_cancelled" => "purek_stopped",
        code if code.starts_with("purek_") => code,
        "cast_track_prepare_failed" | "cast_track_rejected" | "cast_track_no_delivery" | "cast_track_restore_failed" => code,
        "cast_purek_qr_invalid" | "cast_purek_address_not_allowed" => "purek_qr_invalid",
        "cast_purek_authorization_rejected" => "purek_authorization",
        "cast_purek_identity_changed" | "cast_purek_route_changed" => "purek_identity_changed",
        "cast_purek_registration_unavailable"
        | "missing_av_transport"
        | "not_renderer"
        | "cast_renderer_unavailable" => "purek_renderer",
        "cast_purek_unavailable" | "unavailable" => "purek_unavailable",
        "cast_purek_http" | "http_status" => "purek_http",
        "cast_purek_description"
        | "invalid_xml"
        | "invalid_utf8"
        | "response_too_large"
        | "xml_too_deep"
        | "invalid_service"
        | "external_control"
        | "invalid_soap" => "purek_protocol",
        "cast_purek_resolve"
        | "cast_purek_route"
        | "route_unavailable"
        | "route_not_local"
        | "no_interfaces"
        | "connect"
        | "timeout"
        | "io"
        | "http_initialization" => "purek_network",
        "soap_fault" => "purek_receiver_fault",
        "cast_backend_unavailable" => "purek_output_backend_unavailable",
        "cast_busy" => "purek_busy",
        _ => "purek_output_pipeline",
    }
}

fn legacy_protocol_error(code: &str) -> &str {
    match code {
        "connect" | "timeout" | "io" => "purek_network",
        "http_status" => "purek_http",
        "unavailable" => "purek_output_no_connection_manager",
        _ => "purek_protocol_info",
    }
}

impl State {
    /// R1 T8 holds local playback while it probes the receiver; it is neither
    /// an output being stopped nor an ordinary requested network output.
    fn self_test_owns_output(&self) -> bool {
        self.self_test.running && self.owns_playback && !self.self_test_handoff_active
    }

    fn status(&self) -> &'static str {
        if self.error_code.as_deref() == Some("missing_av_transport") {
            "unsupported"
        } else if self.error_code.is_some() || self.room_error.is_some() {
            "error"
        } else if self.self_test_owns_output() {
            "probing"
        } else if self.owns_playback && !self.output_enabled {
            "stopping"
        } else if !self.owns_playback
            && (self.capability_probe_running || matches!(self.control, Some(Control::Probe)))
        {
            "probing"
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
            if self.capability_unverified() {
                "unverified"
            } else if self.output_enabled {
                "waiting"
            } else {
                "authorized"
            }
        } else {
            "stopped"
        }
    }

    /// Whether DSP settings can reach the receiver without file regeneration.
    fn live_l1(&self) -> bool {
        self.l1 && self.mode == Mode::Live
    }

    /// L2 composited, L1 (DSP audio with copied video), L0 (raw T3).
    pub(super) fn pipeline_level(&self) -> Option<&'static str> {
        self.owns_playback.then(|| {
            if self.composited.is_some() {
                "L2"
            } else if self.l1 {
                "L1"
            } else {
                "L0"
            }
        })
    }

    pub(crate) fn pipeline_reason(&self) -> Option<&'static str> {
        (self.owns_playback && !self.l1).then(|| {
            self.l1_refusal.unwrap_or(match self.mode {
                Mode::File => "file_mode",
                _ => "l1_unavailable",
            })
        })
    }

    pub(crate) fn output_projection(&self, host: bool) -> Value {
        json!({"schema_version":1,
            "target":if self.owns_playback {"purek"} else {"local"},
            "requested_target":if self.output_enabled || self.self_test_owns_output() {"purek"} else {"local"},
            "status":self.status(),"available":crate::media_routing::output_companion().is_some(),
            "authorized":self.connected,"can_manage":host,"experimental":true,"qualified":false,
            "busy":self.room_busy || self.pending.is_some() || self.control_busy || self.self_test_owns_output(),
            "desired_playing":self.output_enabled && !self.paused,"position":self.position,"duration":self.duration,
            "transition_remaining_ms":0,"pipeline_level":self.pipeline_level(),
            "pipeline_reason":self.pipeline_reason(),
            "audio_track_switch":if !self.owns_playback {"local"} else if self.phase != Phase::Active || self.control_busy || !self.delivered {"pending"}
                else if self.l1 {"direct"} else if self.mode == Mode::File {"remux"} else {"file_required"},
            "picture":self.picture,"composite_encoder":self.composited,
            "composite_reason":if self.connected {self.composite_refusal} else {None},
            "receiver_capabilities":if self.connected {self.receiver_capabilities()} else {Value::Null},
            "stream_generation":self.generation.max(self.room_generation),"producer_eof":false,"preview_tail_sequence":null,
            "offset_mode":match self.offset_mode {bilikara_rust::output_audio::OffsetMode::Splice=>"splice",bilikara_rust::output_audio::OffsetMode::Gradual=>"gradual"},"last_error":self.output_error(),
            "measured_adjust_latency_ms":null,"position_source":"sender_estimate",
            "thermal_status":null,"thermal_headroom":null,
            "failure":if host {self.failure()} else {Value::Null}})
    }

    fn failure(&self) -> Value {
        self.output_failure
            .as_ref()
            .map(|(code, stage)| (legacy_error(code), *stage))
            .or_else(|| self.room_error_projection())
            .map(|(code, stage)| json!({"stage":stage,"code":code}))
            .unwrap_or(Value::Null)
    }

    fn room_error_projection(&self) -> Option<(&str, &str)> {
        if self.room_error.is_none()
            && self
                .output_failure
                .as_ref()
                .is_some_and(|(code, _)| self.error_code.as_ref() == Some(code))
        {
            return None;
        }
        let raw = self.room_error.as_deref().or(self.error_code.as_deref())?;
        Some(
            self.room_failure
                .as_ref()
                .map(|(code, stage)| (code.as_str(), *stage))
                .unwrap_or_else(|| {
                    (
                        legacy_error(raw),
                        match raw {
                            "cast_purek_qr_invalid"
                            | "cast_purek_address_not_allowed"
                            | "cast_purek_address_confirmation_required"
                            | "cast_purek_resolve"
                            | "cast_purek_route"
                            | "route_unavailable"
                            | "route_not_local" => "route",
                            "cast_purek_authorization_rejected" => "authorization",
                            "cast_purek_identity_changed" | "cast_purek_route_changed" => {
                                "revalidation"
                            }
                            "cast_purek_unavailable" => "health_check",
                            _ => "description",
                        },
                    )
                }),
        )
    }

    fn output_error(&self) -> Option<&str> {
        if let Some((code, _)) = &self.output_failure {
            return Some(legacy_error(code));
        }
        if self.owns_playback && let Some(code) = self.track_error {
            return Some(code);
        }
        match self.status() {
            "unsupported" => Some("purek_output_no_av_transport"),
            "unverified" => Some(
                self.protocol_error
                    .as_deref()
                    .map(legacy_protocol_error)
                    .unwrap_or("purek_output_capabilities_unverified"),
            ),
            _ => self.room_error_projection().map(|(code, _)| code),
        }
    }

    /// What the receiver declared in GetProtocolInfo and learned in its
    /// self-test, and what the current picture needs that it lacks.
    /// "unknown" when the receiver did not say (no list, or wildcards).
    pub(crate) fn receiver_capabilities(&self) -> Value {
        let reported =
            self.protocol_state == Some(crate::dlna::diagnostics::ProtocolState::Reported);
        let formats = self.sink_formats();
        let (mut ts, mut h264, mut mpeg2, mut mp4, mut wildcard) =
            (false, false, false, false, false);
        for format in &formats {
            let mime = format["mime"].as_str().unwrap_or("");
            let profile = format["profile"].as_str().unwrap_or("");
            let ts_profile = profile.starts_with("MPEG_TS") || profile.starts_with("AVC_TS");
            // video/mpeg is also MPEG-PS: only its unprofiled or TS entries count.
            let ts_entry = ts_profile
                || matches!(
                    mime,
                    "video/mp2t" | "video/vnd.dlna.mpeg-tts" | "video/x-mpegts"
                )
                || (mime == "video/mpeg" && profile.is_empty());
            wildcard |= matches!(mime, "*" | "*/*" | "video/*");
            mp4 |= mime == "video/mp4";
            if ts_entry {
                ts = true;
                // A TS type without a profile accepts any TS codec.
                h264 |= profile.is_empty() || profile.starts_with("AVC_TS");
                mpeg2 |= profile.is_empty() || profile.starts_with("MPEG_TS");
            }
        }
        let tri = |yes: bool| {
            if !reported || (!yes && wildcard) {
                "unknown"
            } else if yes {
                "yes"
            } else {
                "no"
            }
        };
        let live = match self.learned_live {
            Some(true) => "yes",
            Some(false) => "no",
            None => "unknown",
        };
        let codec = super::show::expected_codec();
        let declared =
            json!({"ts":tri(ts),"h264":tri(h264),"mpeg2":tri(mpeg2),"mp4":tri(mp4),"live":live});
        let lacking = |keys: &[&str]| {
            keys.iter()
                .filter(|k| declared[**k] == "no")
                .map(|k| (*k).to_owned())
                .collect::<Vec<_>>()
        };
        json!({"declared":declared,"composited_codec":codec,
            "missing":{"pure":lacking(&["ts"]),"composited":lacking(&["ts",codec,"live"])}})
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
                // Preserve next's 188-byte AVC/AAC TS assessment. Receiver
                // profiles restrict the advertisement; they do not qualify
                // actual playback or prevent R1's explicit trial.
                let profile = f["profile"].as_str();
                let aac_ts = profile.is_none_or(|p| p.starts_with("AVC_TS_") && p.contains("AAC"));
                match f["mime"].as_str() {
                    Some("video/mp2t") => aac_ts,
                    Some("video/mpeg") => aac_ts && profile.is_none_or(|p| p.ends_with("_ISO")),
                    Some("*" | "video/*") => profile.is_none(),
                    _ => false,
                }
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
            "error_code":self.room_error_projection().map(|(code,_)|code),
            "error_stage":self.room_error_projection().map(|(_,stage)|stage),
            "capabilities":{"dlna_sender":false,"airplay":"system"},
            "output":{"schema_version":1,"target_room_id":self.connection_id,"generation":self.generation.max(self.room_generation),
                "status":self.status(),"capabilities":{
                    "has_av_transport":self.connected && renderer.is_some(),
                    "has_rendering_control":self.connected && renderer.is_some_and(|r|r.description.rendering_control.is_some()),
                    "has_connection_manager":self.connected && renderer.is_some_and(|r|r.description.connection_manager.is_some()),
                    "protocol_info_state":self.protocol_state.unwrap_or(crate::dlna::diagnostics::ProtocolState::NotChecked),"protocol_info_error":self.protocol_error.as_deref().map(legacy_protocol_error),
                    "supports_play":false,"supports_pause":false,"supports_seek":false,
                    // Runtime capabilities of an admitted live L1 stream only; file
                    // regeneration is reported by pipeline_level, never here.
                    "supports_live_stream":self.live_l1(),"supports_midstream_param_change":self.live_l1(),
                    "supports_runtime_av_offset":self.live_l1(),"supports_track_switch":self.live_l1(),"supports_pitch_shift":self.live_l1(),
                    "sink_formats":self.sink_formats()},
                "pipeline_level":self.pipeline_level(),
                "offset_mode":match self.offset_mode {bilikara_rust::output_audio::OffsetMode::Splice=>"splice",bilikara_rust::output_audio::OffsetMode::Gradual=>"gradual"},"last_error":self.output_error(),
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
            if !app.native().cast.l1 && mode != bilikara_rust::output_audio::OffsetMode::Splice {
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
        let result = super::super::native_output::controller::command(identity, body)?;
        if target == "native" {
            pipeline::start(context)?;
        }
        return Ok(result);
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
                // The restore seek carries the intended play state, so the
                // Host settles directly into it (no transient pause). The
                // following play/pause matches it and remains for clients
                // that predate atomic restoration.
                play_intent: (action == "seek-absolute").then(|| resume["is_paused"] != true),
            },
            now: now(),
        })?;
    }
    app.native().cast.published_resume = Some(resume);
    app.native().cast.resume_status_pending = true;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn receiver_capabilities_follow_declared_profiles_and_the_self_test() {
        let mut state = State {
            connected: true,
            ..Default::default()
        };
        let declared = |state: &State| state.receiver_capabilities()["declared"].clone();
        // Nothing reported: every entry is unknown, nothing is missing.
        assert_eq!(declared(&state)["ts"], "unknown");
        assert_eq!(
            state.receiver_capabilities()["missing"]["composited"],
            json!([])
        );
        state.protocol_state = Some(crate::dlna::diagnostics::ProtocolState::Reported);
        state.sink_protocols = vec![
            "http-get:*:video/mpeg:DLNA.ORG_PN=MPEG_PS_PAL".into(),
            "http-get:*:video/vnd.dlna.mpeg-tts:DLNA.ORG_PN=AVC_TS_HD_50_AC3_T".into(),
            "http-get:*:audio/mpeg:*".into(),
        ];
        state.learned_live = Some(false);
        let caps = state.receiver_capabilities();
        assert_eq!(caps["declared"]["ts"], "yes");
        assert_eq!(caps["declared"]["h264"], "yes");
        assert_eq!(caps["declared"]["mpeg2"], "no", "MPEG-PS is not TS");
        assert_eq!(caps["declared"]["mp4"], "no");
        assert_eq!(caps["declared"]["live"], "no");
        assert_eq!(caps["missing"]["pure"], json!([]));
        let codec = caps["composited_codec"].as_str().unwrap().to_owned();
        let mut wanted = vec!["live".to_owned()];
        if codec == "mpeg2" {
            wanted.insert(0, "mpeg2".into());
        }
        assert_eq!(caps["missing"]["composited"], json!(wanted));
        // An unprofiled TS type accepts either codec; wildcards stay unknown.
        state.sink_protocols = vec!["http-get:*:video/mpeg:*".into(), "http-get:*:*:*".into()];
        state.learned_live = Some(true);
        let caps = state.receiver_capabilities();
        assert_eq!(caps["declared"]["mpeg2"], "yes");
        assert_eq!(caps["declared"]["mp4"], "unknown");
        assert_eq!(caps["missing"]["composited"], json!([]));
        state.sink_protocols = vec!["http-get:*:video/mp4:*".into()];
        assert_eq!(
            state.receiver_capabilities()["missing"]["pure"],
            json!(["ts"])
        );
        assert_eq!(
            state.output_projection(true)["receiver_capabilities"]["declared"]["mp4"],
            "yes"
        );
    }

    #[test]
    fn advisory_and_unsupported_snapshots_preserve_next_status_contract() {
        let mut state = State {
            connected: true,
            phase: Phase::Active,
            ..Default::default()
        };
        for protocols in [
            vec![],
            vec!["http-get:*:audio/aac:*".into()],
            vec!["http-get:*:video/MP2T:DLNA.ORG_PN=AVC_TS_HD_50_AC3".into()],
            vec!["http-get:*:video/mpeg:DLNA.ORG_PN=MPEG_PS_PAL".into()],
        ] {
            state.protocol_state = Some(crate::dlna::diagnostics::ProtocolState::Reported);
            state.sink_protocols = protocols;
            assert_eq!(state.output_projection(false)["status"], "unverified");
            assert_eq!(state.room_snapshot()["output"]["status"], "unverified");
            assert_eq!(
                state.output_projection(false)["last_error"],
                "purek_output_capabilities_unverified"
            );
            // Advisory metadata must not relabel actual, already delivered media.
            state.owns_playback = true;
            state.output_enabled = true;
            state.delivered = true;
            assert_eq!(state.output_projection(false)["status"], "streaming");
            state.owns_playback = false;
        }
        state.connected = false;
        state.error_code = Some("missing_av_transport".into());
        assert_eq!(state.output_projection(true)["status"], "unsupported");
        assert_eq!(state.room_snapshot()["output"]["status"], "unsupported");
        assert_eq!(
            state.output_projection(true)["last_error"],
            "purek_output_no_av_transport"
        );
        assert_eq!(state.room_snapshot()["error_code"], "purek_renderer");
        assert_eq!(state.room_snapshot()["error_stage"], "description");
    }
}
