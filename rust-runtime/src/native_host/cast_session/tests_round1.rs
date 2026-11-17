use super::*;

fn start_local_playback(host: &Host) {
    let s = host.snapshot();
    assert_eq!(
        host.post(
            "/api/player/claim-program",
            json!({
                "playback_generation":s["playback_generation"],
                "item_incarnation_id":s["current_item"]["item_incarnation_id"],
                "artifact_set_id":s["current_item"]["artifact_set_id"]
            })
        )
        .unwrap()["claimed"],
        true
    );
    host.post(
        "/api/player/status",
        json!({
            "playback_generation":s["playback_generation"],"item_id":s["current_item"]["id"],
            "status_sequence":1,"observed_phase":"playing","is_paused":false,
            "current_time":3.0,"duration":120.0
        }),
    )
    .unwrap();
    assert_eq!(host.snapshot()["player_status"]["is_paused"], false);
}

fn assert_output_failed_with_connection(snapshot: &Value, code: &str, stage: &str) {
    assert_eq!(snapshot["cast"]["connected"], true, "{}", snapshot["cast"]);
    assert_eq!(snapshot["cast"]["phase"], "active");
    assert_eq!(snapshot["cast"]["output_enabled"], false);
    assert_eq!(snapshot["cast"]["owns_playback"], false);
    assert_eq!(snapshot["cast"]["local_media"], "host");
    assert!(snapshot["cast"]["selected"].is_string());
    assert_eq!(snapshot["purek"]["connected"], true);
    assert!(snapshot["purek"]["output"]["target_room_id"].is_string());
    assert_eq!(snapshot["purek"]["error_code"], Value::Null);
    assert_eq!(snapshot["purek"]["error_stage"], Value::Null);
    assert_eq!(snapshot["purek"]["output"]["status"], "error");
    assert_eq!(snapshot["purek"]["output"]["last_error"], code);
    assert_eq!(snapshot["media_output"]["target"], "local");
    assert_eq!(snapshot["media_output"]["requested_target"], "local");
    assert_eq!(snapshot["media_output"]["status"], "error");
    assert_eq!(snapshot["media_output"]["last_error"], code);
    assert_eq!(
        snapshot["media_output"]["failure"],
        json!({"code":code,"stage":stage})
    );
    assert_eq!(snapshot["current_item"]["id"], "song-one");
    assert!(snapshot["player_control_command"].is_object());
    assert_eq!(snapshot["cast"]["resume"]["position"], 3.0);
    assert_eq!(snapshot["cast"]["resume"]["is_paused"], false);
}

#[test]
fn playing_room_without_cast_backend_keeps_connection_and_local_output() {
    // Isolate both the environment and the process-wide media configuration.
    // This regression must also run when its parent uses a test companion.
    if std::env::var_os("BILIKARA_TEST_CAST_ABSENCE_CHILD").is_none() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "native_host::cast_session::tests::round1::playing_room_without_cast_backend_keeps_connection_and_local_output",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("BILIKARA_TEST_CAST_ABSENCE_CHILD", "1")
            .env_remove("BILIKARA_TEST_CAST_COMPANION")
            .env_remove("BILIKARA_TEST_LIBAV_COMPANION")
            .env_remove("BILIKARA_LIBAV_COMPANION")
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            output.status.success() && stdout.contains("1 passed"),
            "{stdout}\n{}",
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }
    let _serial = GLOBAL_APP_TEST_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    for vendor in [false, true] {
        for output_mode in ["file", "live"] {
            let host = Host::new();
            assert_eq!(host.snapshot()["current_item"]["id"], "song-one");
            start_local_playback(&host);
            let receiver = Receiver::new();
            let key = discover(&host, &receiver);
            mode(&host, &key, output_mode);
            if !vendor {
                host.post(
                    "/api/purek/prepare",
                    json!({"url":format!("http://{}/description", receiver.address)}),
                )
                .unwrap();
            }
            host.post(
                "/api/cast/connect",
                if vendor {
                    json!({"purek_qr":receiver.qr()})
                } else {
                    json!({})
                },
            )
            .unwrap();
            let failed = host.wait(|s| {
                s["cast"]["error_code"] == "cast_backend_unavailable" && s["cast"]["busy"] == false
            });
            assert_output_failed_with_connection(
                &failed,
                "purek_output_backend_unavailable",
                "media_preparation",
            );
            assert_eq!(failed["media_output"]["available"], false);
            let connection = failed["purek"]["output"]["target_room_id"].clone();
            // Retrying a still unavailable pipeline must fail only the output,
            // without requiring another device admission or revoking Pure K.
            host.post("/api/cast/output", json!({"enabled":true}))
                .unwrap();
            let retried = host.wait(|s| {
                s["cast"]["error_code"] == "cast_backend_unavailable" && s["cast"]["busy"] == false
            });
            assert_output_failed_with_connection(
                &retried,
                "purek_output_backend_unavailable",
                "media_preparation",
            );
            assert_eq!(retried["purek"]["output"]["target_room_id"], connection);
            let state = receiver.state.lock().unwrap();
            assert_eq!(state.releases, 0);
            for action in ["Stop", "SetAVTransportURI", "Play", "Pause", "Seek"] {
                assert!(
                    !state.actions.iter().any(|a| a == action),
                    "{action} without output"
                );
            }
            assert_eq!(
                state
                    .actions
                    .iter()
                    .filter(|a| a.as_str() == "SetDeviceAuthorization")
                    .count(),
                usize::from(vendor)
            );
            drop(state);
            host.post("/api/cast/disconnect", json!({})).unwrap();
            host.wait(|s| s["cast"]["phase"] == "idle" && s["cast"]["busy"] == false);
            assert_eq!(receiver.state.lock().unwrap().releases, usize::from(vendor));
        }
    }
}

#[test]
#[ignore = "requires trusted BILIKARA_TEST_CAST_COMPANION; real pipeline failure and retry"]
fn pipeline_failure_can_retry_on_the_same_registered_connection() {
    let _serial = GLOBAL_APP_TEST_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    for vendor in [false, true] {
        for output_mode in ["file", "live"] {
            let host = Host::new();
            host.use_long_media();
            start_local_playback(&host);
            let snapshot = host.snapshot();
            let video = host.context.cache_root.join(
                snapshot["current_item"]["video_media_url"]
                    .as_str()
                    .unwrap()
                    .strip_prefix("/media/")
                    .unwrap(),
            );
            let valid_video = std::fs::read(&video).unwrap();
            std::fs::write(&video, b"invalid media for pipeline failure").unwrap();
            let receiver = Receiver::new();
            let key = discover(&host, &receiver);
            mode(&host, &key, output_mode);
            host.post(
                "/api/cast/connect",
                if vendor {
                    json!({"purek_qr":receiver.qr()})
                } else {
                    json!({"device_key":key})
                },
            )
            .unwrap();
            let failed = host.wait(|s| {
                s["cast"]["error_code"] == "cast_prepare_failed" && s["cast"]["busy"] == false
            });
            assert_output_failed_with_connection(
                &failed,
                "purek_output_pipeline",
                "media_preparation",
            );
            let connection = failed["purek"]["output"]["target_room_id"].clone();
            assert_eq!(receiver.state.lock().unwrap().releases, 0);
            std::fs::write(&video, valid_video).unwrap();
            host.post("/api/cast/output", json!({"enabled":true}))
                .unwrap();
            let recovered = host
                .wait(|s| s["media_output"]["status"] == "streaming" && s["cast"]["busy"] == false);
            assert_eq!(recovered["cast"]["connected"], true);
            assert_eq!(recovered["cast"]["output_enabled"], true);
            assert_eq!(recovered["cast"]["owns_playback"], true);
            assert_eq!(recovered["cast"]["error_code"], Value::Null);
            assert_eq!(recovered["media_output"]["last_error"], Value::Null);
            assert_eq!(recovered["media_output"]["failure"], Value::Null);
            assert_eq!(recovered["purek"]["connected"], true);
            assert_eq!(recovered["purek"]["output"]["target_room_id"], connection);
            assert_eq!(recovered["purek"]["error_code"], Value::Null);
            let state = receiver.state.lock().unwrap();
            assert!(state.bytes > 0);
            assert_eq!(state.releases, 0);
            assert_eq!(
                state
                    .actions
                    .iter()
                    .filter(|a| a.as_str() == "SetDeviceAuthorization")
                    .count(),
                usize::from(vendor)
            );
            drop(state);
            host.post("/api/cast/disconnect", json!({})).unwrap();
            host.wait(|s| s["cast"]["phase"] == "idle" && s["cast"]["busy"] == false);
            assert_eq!(receiver.state.lock().unwrap().releases, usize::from(vendor));
        }
    }
}

#[test]
fn empty_room_connection_and_probe_never_control_unrelated_receiver_playback() {
    let _serial = GLOBAL_APP_TEST_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    for vendor in [false, true] {
        let host = Host::new();
        assert!(
            crate::execute_app_state(AppStateRequest::BeginSession {
                schema_version: 1,
                new_session: crate::app_state::SessionArchiveSeed {
                    file_name: "empty-room.json".into(),
                    session_started_at: 5.0,
                    items: Vec::new(),
                },
                now: 5.0,
            })
            .error()
            .is_none()
        );
        let receiver = Receiver::new();
        receiver.query_hold.store(true, Ordering::Release);
        if vendor {
            host.post("/api/cast/connect", json!({"purek_qr":receiver.qr()}))
                .unwrap();
        } else {
            let key = discover(&host, &receiver);
            host.post("/api/cast/connect", json!({"device_key":key}))
                .unwrap();
        }
        assert_eq!(
            host.post(
                "/api/player/output",
                json!({"target":"native","experimental":true})
            )
            .unwrap_err()
            .code,
            "purek_busy"
        );
        assert!(!with_app(|app| Ok(app.native().local_output.controller.owns_playback)).unwrap());
        receiver.query_hold.store(false, Ordering::Release);
        let snapshot =
            host.wait(|s| s["cast"]["connected"] == true && s["cast"]["phase"] == "active");
        assert_eq!(snapshot["cast"]["owns_playback"], false);
        assert_eq!(snapshot["media_output"]["status"], "waiting");
        receiver.state.lock().unwrap().fault_on = Some("GetProtocolInfo");
        receiver.query_hold.store(true, Ordering::Release);
        host.post("/api/cast/probe", json!({})).unwrap();
        let probing = host.wait(|s| s["media_output"]["status"] == "probing");
        assert_eq!(probing["purek"]["output"]["status"], "probing");
        receiver.query_hold.store(false, Ordering::Release);
        let unverified = host.wait(|s| s["cast"]["busy"] == false);
        assert_eq!(unverified["media_output"]["status"], "unverified");
        assert_eq!(unverified["purek"]["output"]["status"], "unverified");
        assert_eq!(
            unverified["purek"]["output"]["capabilities"]["protocol_info_state"],
            "unavailable"
        );
        assert_eq!(
            unverified["media_output"]["last_error"],
            "purek_protocol_info"
        );
        assert_eq!(
            unverified["purek"]["output"]["last_error"],
            "purek_protocol_info"
        );
        assert_eq!(unverified["purek"]["error_code"], Value::Null);
        host.post("/api/cast/output", json!({"enabled":false}))
            .unwrap();
        host.wait(|s| s["cast"]["busy"] == false);
        assert_eq!(host.snapshot()["media_output"]["status"], "unverified");
        receiver.state.lock().unwrap().fault_on = None;
        host.post("/api/cast/probe", json!({})).unwrap();
        host.wait(|s| s["media_output"]["status"] == "authorized");
        host.post("/api/cast/disconnect", json!({})).unwrap();
        host.wait(|s| s["cast"]["phase"] == "idle" && s["cast"]["busy"] == false);
        let state = receiver.state.lock().unwrap();
        for action in ["Stop", "SetAVTransportURI", "Play", "Pause", "Seek"] {
            assert!(
                !state.actions.iter().any(|a| a == action),
                "{action} without media ownership"
            );
        }
        assert!(
            state
                .actions
                .iter()
                .filter(|a| a.as_str() == "GetProtocolInfo")
                .count()
                >= 2
        );
        assert_eq!(state.releases > 0, vendor);
        drop(state);
        if vendor {
            receiver.state.lock().unwrap().fault_on = Some("SetDeviceAuthorization");
            host.post("/api/cast/connect", json!({"purek_qr":receiver.qr()}))
                .unwrap();
            let rejected =
                host.wait(|s| s["cast"]["error_code"].is_string() && s["cast"]["busy"] == false);
            assert_eq!(
                rejected["cast"]["error_code"],
                "cast_purek_authorization_rejected"
            );
            assert_eq!(rejected["purek"]["error_code"], "purek_authorization");
            assert_eq!(rejected["purek"]["error_stage"], "authorization");
            assert_eq!(rejected["purek"]["connected"], false);
            host.post("/api/purek/prepare", json!({"qr_url":receiver.qr()}))
                .unwrap();
            assert_eq!(host.snapshot()["purek"]["error_code"], Value::Null);
            assert_eq!(host.snapshot()["purek"]["error_stage"], Value::Null);
        }
    }
}

#[test]
#[ignore = "requires trusted BILIKARA_TEST_CAST_COMPANION; real T3 mux + Pure K loopback receiver"]
fn platform_notification_disconnect_revokes_purek_and_restores_local_playback() {
    let _serial = GLOBAL_APP_TEST_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let host = Host::new();
    let receiver = Receiver::new();
    host.post("/api/cast/connect", json!({"purek_qr":receiver.qr()}))
        .unwrap();
    host.wait(|s| s["cast"]["phase"] == "active");
    let lease = with_app(|app| Ok(app.native().cast.platform_output_id.unwrap())).unwrap();
    platform_stopped(lease + 1, 1);
    assert_eq!(host.snapshot()["cast"]["phase"], "active");
    platform_stopped(lease, 1);
    let snap = host.wait(|s| s["cast"]["phase"] == "idle" && s["cast"]["busy"] == false);
    assert_eq!(snap["cast"]["owns_playback"], false);
    assert_eq!(snap["cast"]["local_media"], "host");
    assert!(receiver.state.lock().unwrap().releases > 0);
}

fn discover(_host: &Host, receiver: &Receiver) -> String {
    let renderer = receiver.renderer();
    let key = renderer_key(&renderer);
    with_app(|app| {
        app.native().cast.renderers.push(renderer);
        Ok(())
    })
    .unwrap();
    key
}
fn mode(host: &Host, key: &str, mode: &str) {
    host.post("/api/cast/command", json!({"command":"cast.set_device_mode", "device_key":key, "mode":mode, "revision":host.snapshot()["revision"]})).unwrap();
}

#[test]
fn udn_identity_ignores_diagnostic_salt_and_no_udn_preferences_are_transient() {
    let _serial = GLOBAL_APP_TEST_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let host = Host::new();
    let receiver = Receiver::new();
    let mut renderer = receiver.renderer();
    let expected = preference_key(&renderer).unwrap();
    renderer.description.id =
        " UUID:CAST-FIXTURE::urn:schemas-upnp-org:device:MediaRenderer:1 ".into();
    renderer.context.device_key = "0123456789abcdef0123456789abcdef".into();
    assert_eq!(preference_key(&renderer).unwrap(), expected);
    renderer.description.id = renderer.description.location.clone();
    assert!(preference_key(&renderer).is_none());
    let key = renderer_key(&renderer);
    with_app(|app| {
        app.native().cast.renderers.push(renderer);
        Ok(())
    })
    .unwrap();
    let request = json!({"command":"cast.set_device_mode", "device_key":key, "mode":"live", "revision":host.snapshot()["revision"]});
    let result = host.post("/api/cast/command", request).unwrap();
    assert_eq!(result["cast"]["devices"][&key]["mode"], "live");
    assert!(with_app(|app| Ok(app.cast_preferences()?.is_empty())).unwrap());
    assert_eq!(
        host.post(
            "/api/cast/discover",
            json!({"description_url":"http://8.8.8.8/description"})
        )
        .unwrap_err()
        .status,
        400
    );
    assert!(with_app(|app| Ok(app.cast_preferences()?.is_empty())).unwrap());
}

#[test]
fn learning_clear_removes_metadata_and_unknown_device_cannot_consume_capacity() {
    let _serial = GLOBAL_APP_TEST_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let host = Host::new();
    let receiver = Receiver::new();
    let key = discover(&host, &receiver);
    for learned in [Some("live"), None] {
        host.post("/api/cast/command", json!({"command":"cast.set_device_learning", "device_key":key, "learned_mode":learned, "learned_variant":null, "revision":host.snapshot()["revision"]})).unwrap();
        with_app(|app| {
            let saved = &app.cast_preferences()?.devices[&key];
            assert_eq!(saved.learned_at.is_some(), learned.is_some());
            assert_eq!(saved.self_test_report_version.is_some(), learned.is_some());
            Ok(())
        })
        .unwrap();
    }
    assert_eq!(host.post("/api/cast/command", json!({"command":"cast.set_device_mode", "device_key":"0123456789abcdef0123456789abcdef", "mode":"file", "revision":host.snapshot()["revision"]})).unwrap_err().code, "cast_device_preferences_unavailable");
}

#[test]
#[ignore = "requires trusted BILIKARA_TEST_CAST_COMPANION"]
fn purek_reconnect_reuses_preference_and_full_store_does_not_block_connect() {
    let _serial = GLOBAL_APP_TEST_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let host = Host::new();
    let receiver = Receiver::new();
    let qr = receiver.qr();
    host.post("/api/cast/connect", json!({"purek_qr":qr}))
        .unwrap();
    let first = host.wait(|s| s["cast"]["phase"] == "active");
    let key = first["cast"]["selected"].as_str().unwrap().to_owned();
    assert_eq!(key, preference_key(&receiver.renderer()).unwrap());
    mode(&host, &key, "live");
    host.wait(|s| s["cast"]["phase"] == "active" && s["cast"]["busy"] == false);
    host.post("/api/cast/connect", json!({"purek_qr":qr}))
        .unwrap();
    let second = host.wait(|s| s["cast"]["phase"] == "active" && s["cast"]["operation_id"] == 2);
    assert_eq!(second["cast"]["selected"], key);
    assert_eq!(second["cast"]["effective_mode"], "live");
    assert_eq!(second["cast"]["devices"].as_object().unwrap().len(), 1);
    host.post("/api/cast/disconnect", json!({})).unwrap();
    host.wait(|s| s["cast"]["phase"] == "idle" && s["cast"]["busy"] == false);
    with_app(|app| {
        for index in 0..256 {
            app.cast_set_device(
                &format!("{index:032x}"),
                app.native_core_snapshot()?.revision,
                Default::default(),
            )?;
        }
        Ok(())
    })
    .unwrap();
    let mut renderer = receiver.renderer();
    renderer.description.id = "uuid:new-receiver".into();
    host.connect(renderer);
    assert_eq!(host.snapshot()["cast"]["owns_playback"], true);
    assert_eq!(
        host.snapshot()["cast"]["devices"]
            .as_object()
            .unwrap()
            .len(),
        256
    );
}

#[test]
#[ignore = "requires trusted BILIKARA_TEST_CAST_COMPANION"]
fn live_zero_missing_and_stagnant_position_advance_and_pause_is_idempotent() {
    let _serial = GLOBAL_APP_TEST_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    for reading in ["zero", "missing", "stagnant"] {
        let host = Host::with_duration(8);
        let receiver = Receiver::new();
        let key = discover(&host, &receiver);
        mode(&host, &key, "live");
        {
            let mut state = receiver.state.lock().unwrap();
            state.duration = 0;
            state.position = 0;
            state.no_position = reading == "missing";
        }
        host.connect(receiver.renderer());
        host.command("pause");
        let generation = host.snapshot()["cast"]["generation"].clone();
        host.command("pause");
        assert_eq!(host.snapshot()["cast"]["generation"], generation);
        assert_eq!(host.snapshot()["cast"]["is_paused"], true);
        host.command("play");
        if reading == "stagnant" {
            receiver.state.lock().unwrap().position = 1;
        }
        host.wait(|s| s["cast"]["position"].as_f64().unwrap() >= 7.0);
        receiver.state.lock().unwrap().state = "STOPPED";
        let next =
            host.wait(|s| s["current_item"]["id"] == "song-two" && s["cast"]["phase"] == "active");
        assert_eq!(next["cast"]["owns_playback"], true);
        assert!(next["cast"]["error_code"].is_null());
    }
}

#[test]
#[ignore = "requires trusted BILIKARA_TEST_CAST_COMPANION"]
fn stopped_mid_song_after_pause_and_during_seek_never_advances() {
    let _serial = GLOBAL_APP_TEST_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    for scenario in ["middle", "paused", "seek"] {
        let host = Host::new();
        let receiver = Receiver::new();
        host.connect(receiver.renderer());
        receiver.state.lock().unwrap().position = 40;
        host.wait(|s| s["cast"]["position"] == 40.0);
        if scenario == "paused" {
            host.command("pause");
        }
        if scenario == "seek" {
            host.post("/api/cast/command", json!({"action":"seek-absolute", "target_seconds":100, "playback_generation":host.snapshot()["playback_generation"]})).unwrap();
            host.wait(|s| s["cast"]["busy"] == false);
        }
        {
            let mut state = receiver.state.lock().unwrap();
            state.state = "STOPPED";
            state.position = if scenario == "paused" { 119 } else { 0 };
        }
        if scenario == "seek" {
            host.wait(|s| s["cast"]["receiver_state"] == "stopped");
            assert_eq!(host.snapshot()["current_item"]["id"], "song-one");
            receiver.state.lock().unwrap().state = "PLAYING";
            host.wait(|s| s["cast"]["receiver_state"] == "playing");
            assert_eq!(host.snapshot()["cast"]["phase"], "active");
        } else {
            host.wait(|s| {
                assert_eq!(
                    s["current_item"]["id"], "song-one",
                    "unexpected natural advance: {scenario}"
                );
                s["cast"]["phase"] == "recovering"
            });
            let snap = host.wait(|s| s["cast"]["phase"] == "idle");
            assert_eq!(snap["current_item"]["id"], "song-one");
            assert_eq!(snap["cast"]["owns_playback"], false);
            assert_eq!(
                snap["cast"]["resume"]["position"],
                if scenario == "paused" { 119.0 } else { 40.0 },
                "STOPPED must freeze the last receiver position throughout recovery"
            );
        }
    }
}

#[test]
#[ignore = "requires trusted BILIKARA_TEST_CAST_COMPANION"]
fn hung_poll_is_interrupted_by_command_and_recovers_within_deadline() {
    let _serial = GLOBAL_APP_TEST_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    for delay in [1500, 2500, 3500] {
        slow_receiver_keeps_session_and_changes_program(delay);
    }
    let host = Host::new();
    let receiver = Receiver::new();
    host.connect(receiver.renderer());
    host.wait(|s| s["cast"]["duration"] == 120.0);
    let polls = {
        let mut state = receiver.state.lock().unwrap();
        state.hang = true;
        state
            .actions
            .iter()
            .filter(|a| *a == "GetTransportInfo")
            .count()
    };
    let began = Instant::now();
    host.wait(|_| {
        receiver
            .state
            .lock()
            .unwrap()
            .actions
            .iter()
            .filter(|a| *a == "GetTransportInfo")
            .count()
            > polls
    });
    let command = Instant::now();
    let timed_out = host.command("pause");
    assert_eq!(timed_out["cast"]["error_code"], "timeout");
    // The approved 4s command timeout replaces the old 2s timeout.
    assert!(command.elapsed() < Duration::from_millis(4600));
    host.wait(|s| s["cast"]["phase"] == "recovering");
    // The in-flight command can now consume 4s before the next monitor reply.
    assert!(began.elapsed() < Duration::from_secs(12));
    host.wait(|s| s["cast"]["phase"] == "idle");
    assert!(began.elapsed() < Duration::from_secs(15));
    assert_eq!(
        host.snapshot()["cast"]["error_code"],
        "cast_receiver_unreachable"
    );
    drop(host);
    // A hung monitor must not delay Next's AppState transition or URI work.
    let host = Host::new();
    receiver.state.lock().unwrap().hang = false;
    host.connect(receiver.renderer());
    host.wait(|s| s["cast"]["duration"] == 120.0);
    let polls = {
        let mut state = receiver.state.lock().unwrap();
        state.hang = true;
        state
            .actions
            .iter()
            .filter(|a| *a == "GetTransportInfo")
            .count()
    };
    host.wait(|_| {
        receiver
            .state
            .lock()
            .unwrap()
            .actions
            .iter()
            .filter(|a| *a == "GetTransportInfo")
            .count()
            > polls
    });
    // A real command timeout must release busy and the worker's queue, even
    // though the receiver keeps the abandoned TCP connection open.
    let timeout_started = Instant::now();
    let timed_out = host.command("pause");
    assert_eq!(timed_out["cast"]["error_code"], "timeout");
    assert_eq!(timed_out["cast"]["busy"], false);
    assert!(timeout_started.elapsed() < Duration::from_millis(4600));
    let began = Instant::now();
    host.post(
        "/api/cast/command",
        json!({"action":"next", "playback_generation":host.snapshot()["playback_generation"]}),
    )
    .unwrap();
    host.wait(|s| s["current_item"]["id"] == "song-two");
    assert!(
        began.elapsed() < Duration::from_millis(600),
        "Next waited for the hung poll"
    );
    let cancel = Instant::now();
    host.post("/api/cast/disconnect", json!({})).unwrap();
    host.wait(|s| s["cast"]["phase"] == "idle" && s["cast"]["busy"] == false);
    assert!(cancel.elapsed() < Duration::from_secs(3));
}

fn slow_receiver_keeps_session_and_changes_program(delay_ms: u64) {
    let host = Host::new();
    let receiver = Receiver::new();
    receiver.state.lock().unwrap().response_delay = Duration::from_millis(delay_ms);
    host.connect(receiver.renderer());
    // Three complete real SOAP poll pairs, not a sleep followed by one lucky
    // snapshot. Every observed snapshot must retain the session and ownership.
    let assert_active = |s: &Value| {
        assert_eq!(s["cast"]["phase"], "active", "{delay_ms}ms: {}", s["cast"]);
        assert_eq!(s["cast"]["owns_playback"], true);
        assert!(
            s["cast"]["error_code"].is_null(),
            "{delay_ms}ms: {}",
            s["cast"]
        );
    };
    let completed_polls = || {
        receiver
            .state
            .lock()
            .unwrap()
            .completed
            .iter()
            .filter(|a| *a == "GetPositionInfo")
            .count()
    };
    // Only the new 3.5s case needs per-pair waits (>20s for three pairs).
    // Existing cases keep the combined 20s deadline for all three pairs.
    let first_count = if delay_ms == 3500 { 1 } else { 3 };
    for count in first_count..=3 {
        host.wait(|s| {
            assert_active(s);
            completed_polls() >= count
        });
    }
    let paused = host.command("pause");
    assert_active(&paused);
    assert_eq!(paused["cast"]["is_paused"], true);
    assert_eq!(paused["cast"]["receiver_state"], "paused");
    let resumed = host.command("play");
    assert_active(&resumed);
    assert_eq!(resumed["cast"]["is_paused"], false);
    let baseline = completed_polls();
    // Verify monitoring still progresses after controls, not only that busy
    // cleared before an abandoned slow request could back up the receiver.
    for count in 1..=3 {
        host.wait(|s| {
            assert_active(s);
            completed_polls() >= baseline + count
        });
    }
    let next = host.command("next");
    assert_active(&next);
    assert_eq!(next["current_item"]["id"], "song-two");
    host.wait(|s| s["cast"]["duration"] == 120.0);
    {
        let mut state = receiver.state.lock().unwrap();
        state.position = 119;
        state.state = "STOPPED";
    }
    if delay_ms == 3500 {
        // This new case needs two monitor replies plus the next start's SOAP
        // sequence (>20s total). Bound observation and startup separately;
        // retain the original combined deadline for the existing cases.
        host.wait(|s| {
            assert_ne!(s["cast"]["phase"], "recovering");
            assert_ne!(s["cast"]["phase"], "idle");
            assert!(s["cast"]["error_code"].is_null());
            s["current_item"]["id"] == "song-three"
        });
    }
    let next = host.wait(|s| {
        assert_ne!(s["cast"]["phase"], "recovering");
        assert_ne!(s["cast"]["phase"], "idle");
        s["current_item"]["id"] == "song-three" && s["cast"]["phase"] == "active"
    });
    assert_eq!(next["cast"]["operation_id"], 1);
    assert!(next["cast"]["error_code"].is_null());
}

#[test]
#[ignore = "requires trusted BILIKARA_TEST_CAST_COMPANION"]
fn playlist_program_changes_keep_receiver_session() {
    let _serial = GLOBAL_APP_TEST_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    for action in ["defer", "set", "front", "remove", "reset"] {
        let host = Host::new();
        let receiver = Receiver::new();
        host.connect(receiver.renderer());
        let before = with_app(|app| app.native_core_snapshot()).unwrap();
        let request = match action {
            "defer" => AppStateRequest::DeferCurrentItem {
                schema_version: 1,
                item_id: "song-one".into(),
                expected_item_incarnation_id: before.current_item.unwrap().item_incarnation_id,
                expected_playback_generation: before.playback_generation,
                expected_playlist_item_ids: before.playlist.iter().map(|i| i.id.clone()).collect(),
                target_index: 1,
                reset_av_delay: false,
                now: 4.0,
            },
            "set" => AppStateRequest::SetCurrentItem {
                expected_queue_version: None,
                schema_version: 1,
                item_id: Some("song-two".into()),
                reset_av_delay: false,
                now: 4.0,
            },
            "front" => AppStateRequest::MoveToFront {
                expected_queue_version: None,
                schema_version: 1,
                item_id: "song-two".into(),
                reset_av_delay: false,
                now: 4.0,
            },
            "reset" => AppStateRequest::ResetPlayer {
                schema_version: 1,
                now: 4.0,
            },
            _ => AppStateRequest::RemoveItem {
                reset_av_delay: false,
                expected_queue_version: None,
                schema_version: 1,
                item_id: "song-one".into(),
                now: 4.0,
            },
        };
        assert!(crate::execute_app_state(request).error().is_none());
        // next's queue authority advances a removed current item to the next
        // cached item. T5 must retain the connection for that program change.
        let snap = host.wait(|s| {
            s["cast"]["generation"].as_u64().unwrap() >= 2 && s["cast"]["phase"] == "active"
        });
        assert_eq!(
            snap["current_item"]["id"],
            if action == "reset" {
                "song-one"
            } else {
                "song-two"
            },
            "{action}"
        );
        assert_eq!(snap["cast"]["operation_id"], 1);
        assert_eq!(snap["cast"]["owns_playback"], true);
        assert!(snap["cast"]["resume"].is_null());
        assert!(
            receiver
                .state
                .lock()
                .unwrap()
                .actions
                .iter()
                .filter(|a| *a == "SetAVTransportURI")
                .count()
                >= 2
        );
    }
}

#[test]
#[ignore = "requires trusted BILIKARA_TEST_CAST_COMPANION"]
fn corrupt_preferences_do_not_block_cast_and_emit_safe_diagnostic() {
    let _serial = GLOBAL_APP_TEST_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let host = Host::with_storage(120, true);
    let receiver = Receiver::new();
    host.connect(receiver.renderer());
    assert_eq!(host.snapshot()["cast"]["owns_playback"], true);
    assert!(host.snapshot()["cast"]["error_code"].is_null());
    assert_eq!(
        std::fs::read(host.context.directory.join("cast-devices.json")).unwrap(),
        b"{broken"
    );
    let diagnostics = with_app(|app| Ok(app.native_diagnostics()))
        .unwrap()
        .to_string();
    assert!(diagnostics.contains("cast_preferences_write_failed"));
    assert!(!diagnostics.contains("127.0.0.1"));
}

#[test]
#[ignore = "requires trusted BILIKARA_TEST_CAST_COMPANION"]
fn live_seek_uses_actual_keyframe_for_receiver_position_and_local_resume() {
    let _serial = GLOBAL_APP_TEST_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let host = Host::with_duration(30);
    let receiver = Receiver::new();
    // Replace only this newly created test cache, before it is pinned.
    let item = with_app(|app| Ok(app.native_core_snapshot()?.current_item.unwrap())).unwrap();
    let source = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src/native_host/cast_session/fixtures/keyframes-30s.mp4");
    let video = host
        .context
        .cache_root
        .join(item.video_media_url.strip_prefix("/media/").unwrap());
    let audio = host.context.cache_root.join(
        item.audio_variants[0]["audio_url"]
            .as_str()
            .unwrap()
            .strip_prefix("/media/")
            .unwrap(),
    );
    std::fs::copy(&source, video).unwrap();
    std::fs::copy(source.with_file_name("audio-30s.m4a"), audio).unwrap();
    receiver.state.lock().unwrap().duration = 30;
    host.connect(receiver.renderer());
    host.post("/api/cast/command", json!({"action":"seek-absolute", "target_seconds":21, "playback_generation":host.snapshot()["playback_generation"]})).unwrap();
    host.wait(|s| s["cast"]["busy"] == false);
    let key = host.snapshot()["cast"]["selected"]
        .as_str()
        .unwrap()
        .to_owned();
    mode(&host, &key, "live");
    host.wait(|s| s["cast"]["busy"] == false && s["cast"]["phase"] == "active");
    receiver.state.lock().unwrap().position = 5;
    host.wait(|s| s["cast"]["position"] == 25.0);
    host.post("/api/cast/disconnect", json!({})).unwrap();
    let result = host.wait(|s| s["cast"]["phase"] == "idle" && s["cast"]["busy"] == false);
    assert_eq!(result["cast"]["resume"]["position"], 25.0);
}

#[test]
fn registered_remote_can_control_but_cannot_manage_cast() {
    let _serial = GLOBAL_APP_TEST_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let host = Host::new();
    let token = with_app(|app| app.native_join_remote("", "registered-phone".into())).unwrap();
    let remote = Identity {
        token,
        loopback: false,
        client: "remote".into(),
    };
    for (path, body, method) in [
        ("/api/cast/discover", json!({}), Method::POST),
        ("/api/cast/connect", json!({}), Method::POST),
        ("/api/cast/disconnect", json!({}), Method::POST),
        ("/api/cast/report", json!({}), Method::GET),
        (
            "/api/cast/command",
            json!({"command":"cast.set_device_mode"}),
            Method::POST,
        ),
        (
            "/api/cast/command",
            json!({"command":"cast.set_device_learning"}),
            Method::POST,
        ),
    ] {
        assert_eq!(
            route(&host.context, &remote, &method, path, &body)
                .unwrap_err()
                .code,
            "forbidden"
        );
    }
    with_app(|app| {
        let state = &mut app.native().cast;
        state.owns_playback = true;
        state.phase = Phase::Active;
        state.worker_started = true;
        Ok(())
    })
    .unwrap();
    assert_eq!(
        route(
            &host.context,
            &remote,
            &Method::POST,
            "/api/cast/command",
            &json!({"action":"pause", "playback_generation":host.snapshot()["playback_generation"]})
        )
        .unwrap()["accepted"],
        true
    );
}

#[test]
#[ignore = "requires trusted BILIKARA_TEST_CAST_COMPANION"]
fn destructive_session_changes_exit_with_explicit_reason_and_clear_queue_retains_cast() {
    let _serial = GLOBAL_APP_TEST_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    for action in [
        "clear_current",
        "begin",
        "discard",
        "reset_runtime",
        "restore",
        "clear_queue",
    ] {
        let host = Host::new();
        let receiver = Receiver::new();
        host.connect(receiver.renderer());
        let archive = crate::app_state::SessionArchiveSeed {
            file_name: "next.json".into(),
            session_started_at: 5.0,
            items: Vec::new(),
        };
        let request = match action {
            "clear_current" => AppStateRequest::SetCurrentItem {
                expected_queue_version: None,
                schema_version: 1,
                item_id: None,
                reset_av_delay: false,
                now: 5.0,
            },
            "begin" => AppStateRequest::BeginSession {
                schema_version: 1,
                new_session: archive,
                now: 5.0,
            },
            "discard" => AppStateRequest::DiscardBackup {
                schema_version: 1,
                new_session: archive,
                now: 5.0,
            },
            "reset_runtime" => AppStateRequest::ResetRuntime {
                schema_version: 1,
                new_session: archive,
                now: 5.0,
            },
            "restore" => AppStateRequest::RestoreBackup {
                schema_version: 1,
                reset_av_delay: false,
                now: 5.0,
            },
            _ => AppStateRequest::ClearPlaylist {
                expected_queue_version: None,
                schema_version: 1,
                now: 5.0,
            },
        };
        assert!(crate::execute_app_state(request).error().is_none());
        if action == "clear_queue" {
            thread::sleep(Duration::from_millis(150));
            assert_eq!(host.snapshot()["cast"]["phase"], "active");
            assert_eq!(host.snapshot()["current_item"]["id"], "song-one");
        } else {
            let snap = host.wait(|s| s["cast"]["phase"] == "idle");
            assert_eq!(snap["cast"]["owns_playback"], false);
            assert_eq!(
                snap["cast"]["error_code"],
                if action == "restore" {
                    "cast_media_unavailable"
                } else if action == "clear_current" {
                    "cast_no_current_item"
                } else {
                    "cast_queue_finished"
                }
            );
        }
    }
}

#[test]
#[ignore = "requires trusted BILIKARA_TEST_CAST_COMPANION"]
fn real_cast_and_mode_write_leave_checkpoint_readable_by_legacy_seed() {
    let _serial = GLOBAL_APP_TEST_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let host = Host::with_storage(120, false);
    let receiver = Receiver::new();
    host.connect(receiver.renderer());
    let key = host.snapshot()["cast"]["selected"]
        .as_str()
        .unwrap()
        .to_owned();
    mode(&host, &key, "file");
    let checkpoint = std::fs::read(host.context.directory.join("host-state.json")).unwrap();
    let saved: Value = serde_json::from_slice(&checkpoint).unwrap();
    let _: crate::app_state::AppStateSeed = serde_json::from_value(saved["state"].clone()).unwrap();
    assert!(!String::from_utf8_lossy(&checkpoint).contains("\"cast"));
    let prefs = std::fs::read_to_string(host.context.directory.join("cast-devices.json")).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&prefs).unwrap()["devices"][&key]["mode"],
        "file"
    );
    for private in ["Fixture TV", "127.0.0.1", "uuid:cast-fixture"] {
        assert!(!prefs.contains(private));
    }
    host.post("/api/cast/disconnect", json!({})).unwrap();
    host.wait(|s| s["cast"]["phase"] == "idle" && s["cast"]["busy"] == false);
    assert!(
        crate::native_host_storage::NativeHostStorage::inspect(&host.context.directory)
            .unwrap()
            .is_some()
    );
}
