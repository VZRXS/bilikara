use super::*;

fn setup() -> (AppState, Identity) {
    let mut app = AppState::default();
    let seed:AppStateSeed=serde_json::from_value(json!({"session_users":["Alice"],"session_started_at":1.0,"session_played_file":"native.json","updated_at":1.0})).unwrap();
    assert!(
        app.execute(AppStateRequest::Initialize {
            schema_version: 1,
            state: Box::new(seed)
        })
        .error()
        .is_none()
    );
    app.native().host_token = "host-token".into();
    app.native().invite = "invite-token".into();
    let identity = Identity {
        token: "host-token".into(),
        loopback: true,
        client: "host-webview".into(),
    };
    (app, identity)
}

fn ready(app: &mut AppState) -> (AppSnapshot, Value) {
    let item:PlaylistItem=serde_json::from_value(json!({"id":"first","original_url":"https://www.bilibili.com/video/BV1z84y1p7oS","resolved_url":"https://www.bilibili.com/video/BV1z84y1p7oS?p=1","bvid":"BV1z84y1p7oS","aid":1,"cid":2,"page":1,"title":"Song","part_title":"P1","display_title":"Song","cover_url":"","embed_url":"","selected_pages":[1],"selected_cids":[2],"selected_durations":[120],"selected_parts":["P1"],"available_pages":[1],"available_cids":[2],"available_durations":[120],"available_parts":["P1"]})).unwrap();
    app.native_execute(AppStateRequest::AddItem {
        schema_version: 1,
        item,
        position: "tail".into(),
        requester_name: "Alice".into(),
        reset_av_delay: false,
        allow_repeat: false,
        now: 2.0,
    })
    .unwrap();
    let item = app.native_core_snapshot().unwrap().current_item.unwrap();
    let reservation = app
        .native_execute(AppStateRequest::BeginCacheAttempt {
            schema_version: 1,
            item_id: item.id.clone(),
            expected_item_incarnation_id: item.item_incarnation_id,
        })
        .unwrap();
    let directory = reservation["artifact_relative_directory"].as_str().unwrap();
    let event:CacheEvent=serde_json::from_value(json!({"kind":"ready","message":"ready","video_relative_path":format!("{directory}/video.mp4"),"video_media_url":format!("/media/{directory}/video.mp4"),"audio_variants":[{"id":"p1_p1","label":"P1","page":1,"audio_url":format!("/media/{directory}/audio.m4a")}],"selected_audio_variant_id":"p1_p1","item_incarnation_id":reservation["item_incarnation_id"],"artifact_set_id":reservation["artifact_set_id"],"artifact_relative_directory":directory})).unwrap();
    app.native_execute(AppStateRequest::ApplyCacheEvent {
        schema_version: 1,
        item_id: item.id,
        cache_attempt_token: reservation["cache_attempt_token"].as_u64().unwrap(),
        event,
        now: 3.0,
    })
    .unwrap();
    let snapshot = app.native_core_snapshot().unwrap();
    let claim = json!({"playback_generation":snapshot.playback_generation,"item_incarnation_id":reservation["item_incarnation_id"],"artifact_set_id":reservation["artifact_set_id"]});
    (snapshot, claim)
}

#[test]
fn local_ip_is_not_host_authority_and_remote_limit_is_enforced() {
    let (mut app, host) = setup();
    assert!(app.native_authorize(&host, true).unwrap());
    let forged = Identity {
        token: String::new(),
        ..host.clone()
    };
    assert!(app.native_authorize(&forged, true).is_err());
    // Even a correct bootstrap token must not grant Host authority to a LAN
    // peer. Cross-site entry handling must preserve the actual peer check.
    let non_loopback = Identity {
        loopback: false,
        ..host.clone()
    };
    assert!(app.native_authorize(&non_loopback, true).is_err());
    let remote = Identity {
        token: "remote0".into(),
        loopback: false,
        client: "phone".into(),
    };
    assert!(app.native_redeem("wrong", "", "remote0".into()).is_err());
    for index in 0..10 {
        app.native_redeem("invite-token", "", format!("remote{index}"))
            .unwrap();
    }
    assert!(
        app.native_redeem("invite-token", "", "overflow".into())
            .is_err()
    );
    assert_eq!(
        app.native_redeem("invite-token", "remote0", "unused".into())
            .unwrap(),
        "remote0"
    );
    assert!(app.native_authorize(&remote, true).is_err());
    assert!(!app.native_authorize(&remote, false).unwrap());
    assert!(app.native_requester(&remote, "Alice").is_err());
    assert_eq!(
        app.native_register(&remote, &json!({"name":"Alice"}), false, 2.0)
            .unwrap_err()
            .code,
        "session_user_already_exists"
    );
    app.native_register(&remote, &json!({"name":"Alice","claim":true}), false, 2.0)
        .unwrap();
    assert_eq!(
        app.native_requester(&remote, "Spoofed user").unwrap(),
        "Alice"
    );
    app.execute(AppStateRequest::Shutdown { schema_version: 1 });
    assert!(app.native_authorize(&host, true).is_err());
}

#[test]
fn playback_claim_status_and_commands_are_exact_generation_bound() {
    let (mut app, host) = setup();
    let (snapshot, claim) = ready(&mut app);
    assert_eq!(
        app.native_claim(&host, &claim, false).unwrap()["claimed"],
        true
    );
    let intruder = Identity {
        client: "another-webview".into(),
        ..host.clone()
    };
    assert_eq!(
        app.native_claim(&intruder, &claim, false).unwrap()["claimed"],
        false
    );
    let status = json!({"item_id":"first","playback_generation":snapshot.playback_generation,"status_sequence":1,"observed_phase":"playing","is_paused":false,"current_time":25.0,"duration":120.0});
    app.native_player_status(&host, &status, 4.0).unwrap();
    assert_eq!(
        app.native_snapshot(false).unwrap()["player_status"]["current_time"],
        25.0
    );
    assert!(app.native_player_status(&intruder, &status, 4.0).is_err());
    assert_eq!(
        app.native_player_status(&host, &status, 4.0).unwrap()["duplicate"],
        true
    );
    let mut conflict = status.clone();
    conflict["current_time"] = json!(2.0);
    assert!(app.native_player_status(&host, &conflict, 4.0).is_err());
    let control = json!({"item_id":"first","playback_generation":snapshot.playback_generation,"action":"pause"});
    app.native_control(&host, &control, 4.0).unwrap();
    app.native_execute(AppStateRequest::RestartPlaybackProgram { schema_version: 1 })
        .unwrap();
    assert!(app.native_control(&host, &control, 5.0).is_err());
    assert!(app.native_player_status(&host, &status, 5.0).is_err());
    let view = app.native_snapshot(true).unwrap();
    assert!(view["player_status"].is_null());
    assert!(view["player_control_command"].is_null());
}

#[test]
fn rapid_controls_are_queued_and_future_ack_cannot_drop_them() {
    let (mut app, host) = setup();
    let (snapshot, _) = ready(&mut app);
    let control = json!({"item_id":"first","playback_generation":snapshot.playback_generation,"action":"seek-relative","delta_seconds":15});
    for _ in 0..16 {
        app.native_control(&host, &control, 4.0).unwrap();
    }
    assert_eq!(
        app.native_control(&host, &control, 4.0).unwrap_err().status,
        429
    );
    app.native_ack(&host, &json!({"seq":999})).unwrap();
    assert_eq!(
        app.native_snapshot(true).unwrap()["player_control_command"]["seq"],
        1
    );
    app.native_ack(&host, &json!({"seq":1})).unwrap();
    assert_eq!(
        app.native_snapshot(true).unwrap()["player_control_command"]["seq"],
        2
    );
    assert!(app.native_snapshot(false).unwrap()["player_control_command"].is_null());
}

#[test]
fn cache_retirement_waits_for_queue_player_and_all_media_readers() {
    let (mut app, host) = setup();
    let (snapshot, claim) = ready(&mut app);
    let item = snapshot.current_item.unwrap();
    let i = &item.item_incarnation_id;
    let a = &item.artifact_set_id;
    assert!(!app.native_can_retire_artifact(i, a));
    app.native_pin_media(&item.video_media_url).unwrap();
    app.native_pin_media(&item.video_media_url).unwrap();
    app.native_claim(&host, &claim, false).unwrap();
    app.native_execute(AppStateRequest::RemoveItem {
        schema_version: 1,
        item_id: item.id.clone(),
        now: 5.0,
    })
    .unwrap();
    assert!(app.native_pin_media(&item.video_media_url).is_err());
    assert!(!app.native_can_retire_artifact(i, a));
    app.native_release_claim();
    app.native_unpin_media(&item.video_media_url);
    assert!(!app.native_can_retire_artifact(i, a));
    app.native_unpin_media(&item.video_media_url);
    assert!(app.native_can_retire_artifact(i, a));
    assert!(!app.native_can_retire_artifact("../credentials", a));
}

#[test]
fn cache_retirement_preserves_inflight_publication_reservations() {
    let (mut app, _) = setup();
    let (snapshot, _) = ready(&mut app);
    let item = snapshot.current_item.unwrap();
    let reservation = app
        .native_execute(AppStateRequest::BeginCacheAttempt {
            schema_version: 1,
            item_id: item.id.clone(),
            expected_item_incarnation_id: item.item_incarnation_id.clone(),
        })
        .unwrap();
    let artifact = reservation["artifact_set_id"].as_str().unwrap();
    assert_ne!(artifact, item.artifact_set_id);
    assert!(!app.native_can_retire_artifact(&item.item_incarnation_id, artifact));
    app.native_execute(AppStateRequest::RemoveItem {
        schema_version: 1,
        item_id: item.id,
        now: 5.0,
    })
    .unwrap();
    assert!(app.native_can_retire_artifact(&item.item_incarnation_id, artifact));
}

#[test]
fn bounded_native_diagnostics_keep_playback_facts_not_credentials_or_urls() {
    let (mut app, _) = setup();
    for _ in 0..120 {
        app.native_diagnostic(
            &json!({"event":"error", "media_kind":"audio", "paused":true,
            "error_code":4, "action":"reload", "cookie":"secret", "url":"https://private"}),
            1.0,
        );
    }
    let result = app.native_diagnostics();
    let events = result["events"].as_array().unwrap();
    assert_eq!(events.len(), 100);
    assert_eq!(events[0]["paused"], true);
    assert_eq!(events[0]["error_code"], 4);
    assert_eq!(events[0]["action"], "reload");
    assert!(!result.to_string().contains("secret"));
    assert!(!result.to_string().contains("https://private"));
}

#[test]
fn native_diagnostics_preserve_split_output_clock_facts_as_typed_values() {
    let (mut app, _) = setup();
    app.native_diagnostic(
        &json!({
            "event": "sync-wait-for-audio-clock",
            "audio_current_time": 30.1, "video_current_time": 30.4,
            "drift_seconds": 0.3, "effective_av_delay_seconds": 0.0,
            "audio_ready_state": 4, "video_ready_state": 4,
            "audio_paused": false, "video_paused": true,
            "audio_seeking": false, "video_seeking": false,
            "audio_playback_rate": 1.0, "video_playback_rate": 1.0,
            "dropped_video_frames": 2, "total_video_frames": 300,
            "audio_buffered_end": "https://private",
            "video_buffered_end": {"cookie": "secret"},
        }),
        1.0,
    );
    let result = app.native_diagnostics();
    let event = &result["events"][0];
    assert_eq!(event["audio_current_time"], 30.1);
    assert_eq!(event["video_current_time"], 30.4);
    assert_eq!(event["drift_seconds"], 0.3);
    assert_eq!(event["audio_ready_state"], 4);
    assert_eq!(event["audio_paused"], false);
    assert_eq!(event["video_paused"], true);
    assert_eq!(event["audio_seeking"], false);
    assert_eq!(event["audio_playback_rate"], 1.0);
    assert_eq!(event["dropped_video_frames"], 2);
    assert_eq!(event["total_video_frames"], 300);
    assert!(!result.to_string().contains("secret"));
    assert!(!result.to_string().contains("https://private"));
}
