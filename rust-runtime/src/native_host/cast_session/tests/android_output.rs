use super::*;

#[test]
fn android_output_requires_a_live_connection_and_pipeline_is_host_only() {
    // This boundary case intentionally exercises an unavailable companion.
    // Isolate the inherited integration-test override without mutating the
    // environment of concurrent tests or weakening the expected error.
    if std::env::var_os("BILIKARA_TEST_CAST_COMPANION").is_some() {
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "native_host::cast_session::tests::android_output::android_output_requires_a_live_connection_and_pipeline_is_host_only",
                "--nocapture",
                "--test-threads=1",
            ])
            .env_remove("BILIKARA_TEST_CAST_COMPANION")
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&result.stdout);
        let stderr = String::from_utf8_lossy(&result.stderr);
        assert!(result.status.success(), "{stdout}\n{stderr}");
        assert!(
            stdout.contains("1 passed"),
            "isolated test did not run: {stdout}"
        );
        return;
    }
    let _serial = GLOBAL_APP_TEST_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let host = Host::new();
    assert_eq!(
        host.post("/api/cast/output", json!({"enabled":true}))
            .unwrap_err()
            .code,
        "cast_renderer_unavailable"
    );
    let remote = Identity {
        token: String::new(),
        loopback: false,
        client: "remote".into(),
    };
    assert!(
        api::dispatch(
            &host.context,
            &remote,
            false,
            &Method::POST,
            "/api/cast/pipeline-test",
            "",
            json!({})
        )
        .is_err()
    );
    // The sample-dependent pipeline/self-test API is added in P10.
    assert_eq!(host.snapshot()["cast"]["owns_playback"], Value::Null);
}

#[test]
#[ignore = "requires trusted BILIKARA_TEST_CAST_COMPANION; simulated receiver"]
fn android_output_roundtrips_keep_connection_until_explicit_disconnect() {
    assert_roundtrips(false);
}

#[test]
#[ignore = "requires trusted BILIKARA_TEST_CAST_COMPANION; simulated Pure K room"]
fn android_purek_output_retains_registration_and_disconnect_awaits_release() {
    assert_roundtrips(true);
}

fn assert_roundtrips(purek: bool) {
    let _serial = GLOBAL_APP_TEST_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let receiver = Receiver::new();
    let host = Host::new();
    host.use_long_media();
    if purek {
        host.post("/api/cast/connect", json!({"purek_qr":receiver.qr()}))
            .unwrap();
        host.wait(|s| s["cast"]["phase"] == "active");
    } else {
        host.connect(receiver.renderer());
    }
    let selected = host.snapshot()["cast"]["selected"].clone();
    for cycle in 0..2 {
        host.post("/api/cast/output", json!({"enabled":false}))
            .unwrap();
        let local =
            host.wait(|s| s["cast"]["owns_playback"] == false && s["cast"]["busy"] == false);
        assert_eq!(receiver.state.lock().unwrap().releases, 0);
        assert_eq!(local["cast"]["connected"], true);
        assert_eq!(local["cast"]["selected"], selected);
        assert!(local["cast"]["resume"].is_object());
        assert_eq!(receiver.state.lock().unwrap().state, "STOPPED");
        let mode = if cycle == 0 { "live" } else { "file" };
        let changed = host
            .post(
                "/api/cast/command",
                json!({
                    "command":"cast.set_device_mode", "device_key":selected,
                    "revision":local["revision"], "mode":mode
                }),
            )
            .unwrap();
        assert_eq!(changed["cast"]["effective_mode"], mode);
        assert_eq!(changed["cast"]["owns_playback"], false);
        assert_eq!(
            host.post("/api/cast/discover", json!({})).unwrap_err().code,
            "cast_busy"
        );
        host.post("/api/cast/output", json!({"enabled":true}))
            .unwrap();
        let cast = host.wait(|s| s["cast"]["owns_playback"] == true && s["cast"]["busy"] == false);
        assert_eq!(cast["cast"]["selected"], selected);
        assert_eq!(cast["cast"]["resume"], Value::Null);
        assert_eq!(cast["cast"]["effective_mode"], mode);
    }
    host.post("/api/cast/output", json!({"enabled":false}))
        .unwrap();
    host.wait(|s| s["cast"]["owns_playback"] == false && s["cast"]["busy"] == false);
    receiver.release_hold.store(purek, Ordering::Release);
    host.post("/api/cast/disconnect", json!({})).unwrap();
    if purek {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !receiver.release_ready.load(Ordering::Acquire) {
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(10));
        }
        assert_ne!(host.snapshot()["cast"]["phase"], "idle");
        receiver.release_hold.store(false, Ordering::Release);
    }
    let state = host.wait(|s| s["cast"]["phase"] == "idle");
    assert_eq!(state["cast"]["connected"], false);
    assert_eq!(
        state["cast"]["resume"],
        Value::Null,
        "disconnecting local output must not seek local playback again"
    );
    assert_eq!(receiver.state.lock().unwrap().releases, usize::from(purek));
}

#[test]
#[ignore = "requires trusted BILIKARA_TEST_CAST_COMPANION; simulated Pure K room"]
fn android_output_stop_soap_fault_preserves_room_and_local_resume() {
    assert_stop_failure("soap_fault");
}

#[test]
#[ignore = "requires trusted BILIKARA_TEST_CAST_COMPANION; simulated Pure K room"]
fn android_output_stop_http_error_preserves_room_and_local_resume() {
    assert_stop_failure("http_error");
}

#[test]
#[ignore = "requires trusted BILIKARA_TEST_CAST_COMPANION; simulated Pure K room"]
fn android_output_stop_timeout_preserves_room_and_local_resume() {
    assert_stop_failure("timeout");
}

fn assert_stop_failure(failure: &str) {
    let _serial = GLOBAL_APP_TEST_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let receiver = Receiver::new();
    let host = Host::new();
    host.use_long_media();
    host.post("/api/cast/connect", json!({"purek_qr":receiver.qr()}))
        .unwrap();
    let active = host.wait(|s| s["cast"]["phase"] == "active");
    {
        let mut state = receiver.state.lock().unwrap();
        match failure {
            "soap_fault" => state.fault_on = Some("Stop"),
            "http_error" => state.http_error_on = Some("Stop"),
            "timeout" => state.hang_on = Some("Stop"),
            _ => panic!("unknown failure"),
        }
        state.actions.clear();
    }
    host.post("/api/cast/output", json!({"enabled":false}))
        .unwrap();
    let local = host.wait(|s| s["cast"]["owns_playback"] == false && s["cast"]["busy"] == false);
    assert_eq!(
        local["cast"]["connected"], true,
        "Stop {failure}: {}",
        local["cast"]
    );
    assert_eq!(local["cast"]["phase"], "active");
    assert_eq!(local["cast"]["selected"], active["cast"]["selected"]);
    assert_eq!(local["cast"]["output_enabled"], false);
    assert_eq!(local["cast"]["local_media"], "host");
    assert!(local["cast"]["resume"].is_object());
    {
        let mut state = receiver.state.lock().unwrap();
        assert!(state.actions.iter().any(|action| action == "Stop"));
        assert_eq!(state.releases, 0);
        state.fault_on = None;
        state.http_error_on = None;
        state.hang_on = None;
    }
    host.post("/api/cast/output", json!({"enabled":true}))
        .unwrap();
    host.wait(|s| s["cast"]["owns_playback"] == true && s["cast"]["busy"] == false);
    assert_eq!(receiver.state.lock().unwrap().releases, 0);
    host.post("/api/cast/disconnect", json!({})).unwrap();
    host.wait(|s| s["cast"]["phase"] == "idle");
    assert_eq!(receiver.state.lock().unwrap().releases, 1);
}

#[test]
#[ignore = "requires trusted BILIKARA_TEST_CAST_COMPANION; simulated Pure K room"]
fn android_output_restart_set_and_play_faults_release_failed_session() {
    let _serial = GLOBAL_APP_TEST_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    for action in ["SetAVTransportURI", "Play"] {
        let receiver = Receiver::new();
        let host = Host::new();
        host.use_long_media();
        host.post("/api/cast/connect", json!({"purek_qr":receiver.qr()}))
            .unwrap();
        host.wait(|s| s["cast"]["phase"] == "active");
        host.post("/api/cast/output", json!({"enabled":false}))
            .unwrap();
        host.wait(|s| s["cast"]["owns_playback"] == false && s["cast"]["busy"] == false);
        receiver.state.lock().unwrap().fault_on = Some(action);
        host.post("/api/cast/output", json!({"enabled":true}))
            .unwrap();
        let local = host.wait(|s| s["cast"]["phase"] == "idle");
        assert_eq!(local["cast"]["connected"], false);
        assert_eq!(local["cast"]["owns_playback"], false);
        assert_eq!(local["cast"]["local_media"], "host");
        assert!(local["cast"]["resume"].is_object());
        assert!(local["cast"]["error_code"].is_string());
        assert_eq!(receiver.state.lock().unwrap().releases, 1);
    }
}
