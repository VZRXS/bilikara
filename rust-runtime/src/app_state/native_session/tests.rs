use super::*;

#[test]
fn sse_projection_is_shared_until_revision_changes_and_separates_host_fields() {
    let (mut app, _) = setup();
    app.native().startup_warning = "host warning".into();
    let (revision, host) = app.native_sse_frame(true).unwrap();
    let (_, same) = app.native_sse_frame(true).unwrap();
    assert!(std::sync::Arc::ptr_eq(&host, &same));
    let (_, remote) = app.native_sse_frame(false).unwrap();
    assert!(host.contains("host warning"));
    assert!(!remote.contains("host warning"));
    app.native_execute(AppStateRequest::AddSessionUser {
        schema_version: 1,
        name: "Frame Test".into(),
        now: 2.0,
    })
    .unwrap();
    let (changed, next) = app.native_sse_frame(true).unwrap();
    assert!(changed > revision);
    assert!(!std::sync::Arc::ptr_eq(&host, &next));
    assert!(next.contains("Frame Test"));
}

#[test]
fn remote_churn_is_bounded_without_permanently_refusing_new_devices() {
    let (mut app, _) = setup();
    for index in 0..MAX_REMOTE_DEVICES + 20 {
        let token = format!("phone-{index}");
        app.native_join_remote("", token.clone()).unwrap();
        let remote = Identity {
            token,
            loopback: false,
            client: "phone".into(),
        };
        app.native_register(&remote, &json!({"name":"Alice", "claim":true}), false, 2.0)
            .unwrap();
        assert_eq!(app.native_identity(&remote).unwrap()["registered"], true);
        assert!(app.native_session.devices.len() <= MAX_REMOTE_DEVICES);
        assert!(app.data.as_ref().unwrap().remote_identities.len() <= MAX_REMOTE_DEVICES);
    }
    let old = app
        .native_join_remote("phone-0", "replacement".into())
        .unwrap();
    assert_eq!(old, "replacement");
    let recent = format!("phone-{}", MAX_REMOTE_DEVICES + 19);
    assert_eq!(
        app.native_join_remote(&recent, "unused".into()).unwrap(),
        recent
    );
}

#[test]
fn guest_preferences_migrate_to_the_user_and_internet_guests_do_not_change_host_defaults() {
    let (mut app, host) = setup();
    let token = app.native_join_remote("", "guest-phone".into()).unwrap();
    let remote = Identity {
        token,
        loopback: false,
        client: "phone".into(),
    };
    let guest = app.native_pool_key(&remote, "").unwrap();
    app.native_save_pool_config(guest.clone(), json!({"uid_weight":17}))
        .unwrap();
    assert!(
        app.data
            .as_ref()
            .unwrap()
            .gatcha_pool_preferences
            .is_empty()
    );
    app.native_register(&remote, &json!({"name":"Alice", "claim":true}), false, 2.0)
        .unwrap();
    assert!(
        !app.native_session
            .guest_pool_preferences
            .contains_key(&guest)
    );
    assert_eq!(
        app.native_pool_config("user:Alice", &Value::Null)["uid_weight"],
        17
    );
    assert!(app.native_pool_key(&host, "Unregistered").is_err());
    let peer = Identity {
        client: "native-internet:guest-1".into(),
        ..host.clone()
    };
    let key = app.native_pool_key(&peer, "").unwrap();
    app.native_save_pool_config(key.clone(), json!({"uid_weight":29}))
        .unwrap();
    assert_eq!(app.native_pool_config(&key, &Value::Null)["uid_weight"], 29);
    assert_eq!(
        app.native_pool_config("host", &json!({"uid_weight":50}))["uid_weight"],
        50
    );
    assert!(
        !app.data
            .as_ref()
            .unwrap()
            .gatcha_pool_preferences
            .contains_key(&key)
    );
    let exclusions: Vec<String> = (0..20_000).map(|i| format!("1234567{i}")).collect();
    app.native_save_pool_config("user:Alice".into(), json!({"excluded_uids":exclusions}))
        .unwrap();
    assert_eq!(
        app.native_pool_config("user:Alice", &Value::Null)["excluded_uids"]
            .as_array()
            .unwrap()
            .len(),
        20_000
    );
}

#[test]
fn loading_old_remote_state_bounds_devices_and_preserves_every_user_preference() {
    let mut seed: AppStateSeed = serde_json::from_value(
        json!({"session_started_at":1,"session_played_file":"test.json","updated_at":1}),
    )
    .unwrap();
    for index in 0..300 {
        seed.remote_identities
            .insert(format!("digest-{index}"), "Alice".into());
        seed.gatcha_pool_preferences
            .insert(format!("user:{index}"), json!({"updated_at":index}));
    }
    seed.gatcha_pool_preferences
        .insert("device:old".into(), json!({}));
    seed.gatcha_pool_preferences
        .insert("host".into(), json!({"uid_weight":23}));
    bound_saved_remote_state(&mut seed);
    assert_eq!(seed.remote_identities.len(), MAX_REMOTE_DEVICES);
    assert_eq!(seed.gatcha_pool_preferences.len(), 302);
    assert!(seed.gatcha_pool_preferences.contains_key("user:299"));
    assert!(seed.gatcha_pool_preferences.contains_key("user:0"));
    assert!(seed.gatcha_pool_preferences.contains_key("device:old"));
    assert_eq!(seed.gatcha_pool_preferences["host"]["uid_weight"], 23);
}

#[test]
fn pool_preferences_are_user_owned_and_editable_while_refresh_is_running() {
    let (mut app, host) = setup();
    app.native_execute(AppStateRequest::AddSessionUser {
        schema_version: 1,
        name: "Bob".into(),
        now: 1.0,
    })
    .unwrap();
    let token = app.native_join_remote("", "alice-phone".into()).unwrap();
    let remote = Identity {
        token,
        loopback: false,
        client: "remote".into(),
    };
    app.native_register(&remote, &json!({"name":"Alice","claim":true}), false, 2.0)
        .unwrap();
    let alice = app.native_pool_key(&remote, "Bob").unwrap();
    assert_eq!(alice, "user:Alice");
    assert_eq!(alice, app.native_pool_key(&host, "Alice").unwrap());
    let bob = app.native_pool_key(&host, "Bob").unwrap();
    app.native().library_refresh_active = true;
    app.native_save_pool_config(
        alice.clone(),
        json!({"uid_weight":0,"favlist_weight":100,"excluded_uids":["42"]}),
    )
    .unwrap();
    app.native_save_pool_config(bob.clone(), json!({"uid_weight":100,"favlist_weight":0}))
        .unwrap();
    app.native().library_refresh_active = false;
    assert_eq!(
        app.native_pool_config(&alice, &Value::Null)["uid_weight"],
        0
    );
    assert_eq!(
        app.native_pool_config(&bob, &Value::Null)["uid_weight"],
        100
    );
    assert_eq!(
        app.native_pool_config(&alice, &Value::Null)["excluded_uids"],
        json!(["42"])
    );
    assert!(
        app.native_snapshot(false)
            .unwrap()
            .get("gatcha_pool_preferences")
            .is_none()
    );
    app.native_execute(AppStateRequest::ResetRuntime {
        schema_version: 1,
        new_session: SessionArchiveSeed {
            file_name: "reset.json".into(),
            session_started_at: 3.0,
            items: vec![],
        },
        now: 3.0,
    })
    .unwrap();
    for key in [alice, bob] {
        let reset = app.native_pool_config(&key, &json!({"uid_weight":1}));
        assert_eq!(reset["uid_weight"], 50);
        assert_eq!(reset["excluded_uids"], json!([]));
    }
}

#[test]
fn login_diagnostics_are_bounded_not_evicted_by_playback_and_not_in_remote_snapshots() {
    let (mut app, _) = setup();
    for generation in 1..=60 {
        app.native_login_diagnostic(crate::native_host::LoginDiagnostic::new(
            generation, "generate",
        ));
    }
    for n in 0..200 {
        app.native_diagnostic(&json!({"event":"timeupdate"}), n as f64);
    }
    let diagnostics = app.native_diagnostics();
    let log = diagnostics["bilibili_login"].as_array().unwrap();
    assert_eq!(log.len(), 50);
    assert_eq!(log[0]["generation"], 11);
    assert_eq!(log[49]["generation"], 60);
    assert_eq!(diagnostics["events"].as_array().unwrap().len(), 100);
    for is_host in [false, true] {
        assert!(
            !app.native_snapshot(is_host)
                .unwrap()
                .to_string()
                .contains("bilibili_login")
        );
    }
}

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
    let identity = Identity {
        token: "host-token".into(),
        loopback: true,
        client: "host-webview".into(),
    };
    (app, identity)
}

#[test]
fn state_commit_wakes_sse_waiters_without_waiting_for_a_poll_tick() {
    let (mut app, _) = setup();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let changed = state_changes().notified();
        tokio::pin!(changed);
        changed.as_mut().enable();
        app.native_execute(AppStateRequest::AddSessionUser {
            schema_version: 1,
            name: "Bob".into(),
            now: 2.0,
        })
        .unwrap();
        tokio::time::timeout(std::time::Duration::from_millis(100), changed)
            .await
            .expect("committed state wakes subscribers");
    });
}

fn ready(app: &mut AppState) -> (AppSnapshot, Value) {
    ready_at(app, None)
}

fn ready_at(app: &mut AppState, cache_root: Option<&Path>) -> (AppSnapshot, Value) {
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
    if let Some(root) = cache_root {
        let path = root.join(directory);
        std::fs::create_dir_all(&path).unwrap();
        std::fs::write(path.join("video.mp4"), b"video").unwrap();
        std::fs::write(path.join("audio.m4a"), b"audio").unwrap();
    }
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
fn local_ip_is_not_host_authority_and_old_visitors_do_not_fill_the_room() {
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
    for index in 0..64 {
        app.native_join_remote("", format!("remote{index}"))
            .unwrap();
    }
    assert_eq!(
        app.native_join_remote("", "visitor65".into()).unwrap(),
        "visitor65"
    );
    assert_eq!(
        app.native_join_remote("remote0", "unused".into()).unwrap(),
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
fn runtime_reset_reclaims_remote_devices_only_after_a_successful_commit() {
    let (mut app, host) = setup();
    app.data.as_mut().unwrap().native_session_choice_pending = true;
    for index in 0..10 {
        app.native_join_remote("", format!("remote{index}"))
            .unwrap();
    }
    let remote = Identity {
        token: "remote0".into(),
        loopback: false,
        client: "phone".into(),
    };
    app.native_register(&remote, &json!({"name":"Alice", "claim":true}), false, 2.0)
        .unwrap();
    let reset = |file_name: &str| AppStateRequest::ResetRuntime {
        schema_version: 1,
        new_session: SessionArchiveSeed {
            file_name: file_name.into(),
            session_started_at: 3.0,
            items: vec![],
        },
        now: 3.0,
    };
    assert!(app.native_execute(reset("../invalid.json")).is_err());
    assert!(app.native_session_choice_pending());
    assert_eq!(app.native_requester(&remote, "").unwrap(), "Alice");
    assert_eq!(
        app.native_session.devices.len(),
        10,
        "failed reset must preserve admitted devices"
    );
    app.native_execute(reset("next.json")).unwrap();
    assert!(!app.native_session_choice_pending());
    assert!(app.native_authorize(&host, true).unwrap());
    assert!(app.native_authorize(&remote, false).is_err());
    assert!(app.native_core_snapshot().unwrap().session_users.is_empty());
    assert_eq!(
        app.native_join_remote("remote0", "new-remote".into())
            .unwrap(),
        "new-remote"
    );
    assert_eq!(
        app.native_identity(&Identity {
            token: "new-remote".into(),
            ..remote
        })
        .unwrap()["registered"],
        false
    );
}

#[test]
fn remote_identity_revocation_survives_same_name_reuse_and_failed_commits() {
    let (mut app, _) = setup();
    let root = std::env::temp_dir().join(format!(
        "bilikara-identity-revocation-{}",
        crate::native_host::token().unwrap()
    ));
    let seed: AppStateSeed = serde_json::from_value(json!({
        "session_users":["Alice"], "session_started_at":1.0,
        "session_played_file":"native.json", "updated_at":1.0
    }))
    .unwrap();
    app.execute(AppStateRequest::Shutdown { schema_version: 1 });
    assert!(app.initialize_native(&root, seed).error().is_none());
    app.native_join_remote("", "remote".into()).unwrap();
    let remote = Identity {
        token: "remote".into(),
        loopback: false,
        client: "phone".into(),
    };
    app.native_register(&remote, &json!({"name":"Alice", "claim":true}), false, 2.0)
        .unwrap();
    let identity_before = app.native_identity(&remote).unwrap();
    let remove = || AppStateRequest::RemoveSessionUser {
        schema_version: 1,
        name: "Alice".into(),
        now: 3.0,
    };
    // A storage rejection cannot revoke a still-committed singer's identity.
    let before = std::fs::read(root.join("host-state.json")).unwrap();
    std::fs::create_dir(root.join("host-state.pending")).unwrap();
    assert!(app.execute(remove()).error().is_some());
    assert_eq!(app.native_requester(&remote, "").unwrap(), "Alice");
    assert_eq!(app.native_identity(&remote).unwrap(), identity_before);
    assert_eq!(std::fs::read(root.join("host-state.json")).unwrap(), before);
    std::fs::remove_dir(root.join("host-state.pending")).unwrap();

    // Use the shared command boundary, not just the HTTP adapter wrapper.
    assert!(app.execute(remove()).error().is_none());
    assert!(app.native_requester(&remote, "Alice").is_err());
    // SSE may coalesce remove+add into one snapshot with the same user list.
    // Its identity marker must still tell the frontend to recheck registration.
    assert_ne!(
        app.native_snapshot(false).unwrap()["remote_session_id"],
        identity_before["session_id"]
    );
    assert!(
        app.execute(AppStateRequest::AddSessionUser {
            schema_version: 1,
            name: "Alice".into(),
            now: 4.0,
        })
        .error()
        .is_none()
    );
    assert!(app.native_requester(&remote, "Alice").is_err());
    assert_eq!(
        app.native_register(&remote, &json!({"name":"Alice"}), true, 5.0)
            .unwrap_err()
            .code,
        "identity_required"
    );
    assert_eq!(
        app.native_register(&remote, &json!({"name":"Alice"}), false, 5.0)
            .unwrap_err()
            .code,
        "session_user_already_exists"
    );
    // Explicitly claiming a name still works; revocation is not a device ban.
    app.native_register(&remote, &json!({"name":"Alice", "claim":true}), false, 5.0)
        .unwrap();
    assert_eq!(app.native_requester(&remote, "Spoof").unwrap(), "Alice");
    assert!(app.native_authorize(&remote, true).is_err());
    app.execute(AppStateRequest::Shutdown { schema_version: 1 });
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn stale_remote_identity_cannot_use_rename_to_register_in_a_new_session() {
    let (mut app, _) = setup();
    app.native_join_remote("", "remote".into()).unwrap();
    let remote = Identity {
        token: "remote".into(),
        loopback: false,
        client: "phone".into(),
    };
    app.native_register(&remote, &json!({"name":"Alice", "claim":true}), false, 2.0)
        .unwrap();
    app.data.as_mut().unwrap().native_session_choice_pending = true;
    app.native_execute(AppStateRequest::ResolveNativeSession {
        schema_version: 1,
        continue_previous: false,
        new_session: SessionArchiveSeed {
            file_name: "new-session.json".into(),
            session_started_at: 3.0,
            items: vec![],
        },
        now: 3.0,
    })
    .unwrap();
    assert_eq!(app.native_identity(&remote).unwrap()["registered"], false);
    assert_eq!(
        app.native_register(&remote, &json!({"name":"Alice"}), true, 4.0)
            .unwrap_err()
            .code,
        "identity_required"
    );
    assert!(app.native_core_snapshot().unwrap().session_users.is_empty());
}

#[test]
fn remote_registration_claim_and_rename_share_the_session_name_policy() {
    let (mut app, _) = setup();
    app.native_join_remote("", "remote".into()).unwrap();
    let remote = Identity {
        token: "remote".into(),
        loopback: false,
        client: "phone".into(),
    };
    let registered = app
        .native_register(&remote, &json!({"name":"  Alice\t Smith  "}), false, 2.0)
        .unwrap();
    assert_eq!(registered["registered"], true);
    assert_eq!(registered["name"], "Alice Smith");
    assert_eq!(
        app.native_requester(&remote, "Spoof").unwrap(),
        "Alice Smith"
    );

    app.native_join_remote("", "claimant".into()).unwrap();
    let claimant = Identity {
        token: "claimant".into(),
        ..remote.clone()
    };
    assert_eq!(
        app.native_register(&claimant, &json!({"name":"Alice   Smith"}), false, 2.0)
            .unwrap_err()
            .code,
        "session_user_already_exists"
    );
    app.native_register(
        &claimant,
        &json!({"name":"Alice   Smith", "claim":true}),
        false,
        2.0,
    )
    .unwrap();
    let renamed = app
        .native_register(&remote, &json!({"name":" New\n Name "}), true, 3.0)
        .unwrap();
    assert_eq!(renamed["name"], "New Name");
    assert_eq!(app.native_requester(&remote, "").unwrap(), "New Name");
    assert_eq!(app.native_identity(&claimant).unwrap()["registered"], false);
}

#[test]
fn missing_duration_accepts_status_and_playback_commands_without_history() {
    let (mut app, host) = setup();
    let (snapshot, claim) = ready(&mut app);
    app.native_claim(&host, &claim, false).unwrap();
    let generation = snapshot.playback_generation;
    app.native_player_status(
        &host,
        &json!({"item_id":"first","playback_generation":generation,
        "status_sequence":1,"observed_phase":"playing","is_paused":false,"current_time":25.0}),
        4.0,
    )
    .unwrap();
    assert_eq!(
        app.native_snapshot(false).unwrap()["player_status"]["duration"].as_f64(),
        Some(0.0)
    );
    assert!(!app.native_core_snapshot().unwrap().current_item_started);
    for action in ["play", "pause", "seek-absolute", "next-track"] {
        app.native_control(
            &host,
            &json!({"item_id":"first","playback_generation":generation,
            "action":action,"target_seconds":30.0}),
            4.0,
        )
        .unwrap();
    }
    app.native_execute(AppStateRequest::AdvanceToNext {
        schema_version: 1,
        expected_playback_generation: generation,
        reset_av_delay: false,
        now: 5.0,
    })
    .unwrap();
    assert!(app.native_core_snapshot().unwrap().history.is_empty());
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
fn native_and_ffi_controls_share_one_fifo_and_host_only_ack() {
    let (mut app, host) = setup();
    let (snapshot, _) = ready(&mut app);
    let generation = snapshot.playback_generation;
    app.native_control(
        &host,
        &json!({"item_id":"first","playback_generation":generation,
        "action":"seek-relative","delta_seconds":7}),
        4.0,
    )
    .unwrap();
    app.native_execute(AppStateRequest::IssuePlayerControl {
        schema_version: 1,
        control: PlayerControlInput {
            action: "seek-relative".into(),
            playback_generation: generation,
            item_id: "first".into(),
            delta_seconds: 11.0,
            target_seconds: None,
        },
        now: 4.0,
    })
    .unwrap();
    let remote = Identity {
        token: "unknown".into(),
        loopback: false,
        client: "remote".into(),
    };
    assert_eq!(
        app.native_ack(&remote, &json!({"seq":1}))
            .unwrap_err()
            .status,
        403
    );
    assert_eq!(
        app.native_control(&remote, &json!({}), 5.0)
            .unwrap_err()
            .status,
        403
    );
    assert_eq!(
        app.native_snapshot(true).unwrap()["player_control_command"]["delta_seconds"],
        7.0
    );
    app.native_execute(AppStateRequest::AckPlayerControl {
        schema_version: 1,
        seq: 1,
    })
    .unwrap();
    assert_eq!(
        app.native_snapshot(true).unwrap()["player_control_command"]["delta_seconds"],
        11.0
    );
    app.native_ack(&host, &json!({"seq":2})).unwrap();
    assert!(
        app.native_execute(AppStateRequest::PlayerControlSnapshot { schema_version: 1 })
            .unwrap()["command"]
            .is_null()
    );
}

#[test]
fn cache_retirement_waits_for_queue_player_and_all_media_readers() {
    let (mut app, host) = setup();
    let root = std::env::temp_dir().join(format!("bilikara-native-readers-{}", std::process::id()));
    app.open_artifact_lifetime(&root).unwrap();
    let (snapshot, claim) = ready_at(&mut app, Some(&root));
    let item = snapshot.current_item.unwrap();
    let i = &item.item_incarnation_id;
    let a = &item.artifact_set_id;
    assert!(!app.can_retire_artifact(i, a));
    let first = app.native_pin_media(&item.video_media_url).unwrap();
    let second = app.native_pin_media(&item.video_media_url).unwrap();
    app.native_claim(&host, &claim, false).unwrap();
    app.native_execute(AppStateRequest::RemoveItem {
        schema_version: 1,
        item_id: item.id.clone(),
        now: 5.0,
    })
    .unwrap();
    assert!(app.native_pin_media(&item.video_media_url).is_err());
    assert!(!app.can_retire_artifact(i, a));
    app.native_release_claim();
    app.native_unpin_media(&first);
    assert!(!app.can_retire_artifact(i, a));
    app.native_unpin_media(&second);
    assert!(app.can_retire_artifact(i, a));
    assert!(!app.can_retire_artifact("../credentials", a));
    std::fs::remove_dir_all(root).unwrap();
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
    assert!(!app.can_retire_artifact(&item.item_incarnation_id, artifact));
    app.native_execute(AppStateRequest::RemoveItem {
        schema_version: 1,
        item_id: item.id.clone(),
        now: 5.0,
    })
    .unwrap();
    assert!(!app.can_retire_artifact(&item.item_incarnation_id, artifact));
    app.settle_artifact_attempt(
        &item.id,
        reservation["cache_attempt_token"].as_u64().unwrap(),
    );
    assert!(app.can_retire_artifact(&item.item_incarnation_id, artifact));
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
            "drift_before_correction_seconds": -0.6,
            "correction_target_audio_time": 30.4,
            "sync_force_correction": true,
            "local_video_held_for_audio": true,
            "local_video_deferred_recovery": false,
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
    assert_eq!(event["drift_before_correction_seconds"], -0.6);
    assert_eq!(event["correction_target_audio_time"], 30.4);
    assert_eq!(event["sync_force_correction"], true);
    assert_eq!(event["local_video_held_for_audio"], true);
    assert_eq!(event["local_video_deferred_recovery"], false);
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

#[test]
fn native_sync_decision_measurements_reject_text_and_objects() {
    let (mut app, _) = setup();
    app.native_diagnostic(
        &json!({
            "event": "sync-audio-drift-correction",
            "drift_before_correction_seconds": "secret",
            "correction_target_audio_time": {"url":"https://private"},
            "sync_force_correction": "secret",
            "local_video_held_for_audio": 1,
            "local_video_deferred_recovery": {},
        }),
        1.0,
    );
    let result = app.native_diagnostics();
    let event = &result["events"][0];
    assert_eq!(event.as_object().unwrap().len(), 2); // event and at only
}

#[test]
fn desktop_player_facts_are_host_owned_transient_and_separate_from_backend_support() {
    let (mut app, host) = setup();
    app.native().desktop = true;
    let report = json!({"hevc_supported":true,"avc_supported":true,"max_avc_quality_index":3});
    assert_eq!(
        app.native_snapshot(true).unwrap()["cache_policy"]["media_capabilities"],
        json!({})
    );
    let response = app.native_media_capabilities(&host, &report).unwrap();
    assert_eq!(response["max_avc_quality"], "480P 清晰");
    let revision = app.native().revision;
    app.native_media_capabilities(&host, &report).unwrap();
    assert_eq!(app.native().revision, revision);
    let before = app.native().player_media.clone();
    assert!(
        app.native_media_capabilities(&host, &json!({"hevc_supported":"yes"}))
            .is_err()
    );
    assert_eq!(app.native().player_media, before);
    app.native_join_remote("", "remote".into()).unwrap();
    let remote = Identity {
        token: "remote".into(),
        loopback: false,
        client: "phone".into(),
    };
    assert_eq!(
        app.native_media_capabilities(&remote, &report)
            .unwrap_err()
            .status,
        403
    );
    let (_, claim) = ready(&mut app);
    app.native_claim(&host, &claim, false).unwrap();
    let other = Identity {
        client: "new-webview".into(),
        ..host.clone()
    };
    assert_eq!(
        app.native_media_capabilities(&other, &report)
            .unwrap_err()
            .code,
        "player_not_owner"
    );
    app.native_claim(&host, &claim, true).unwrap();
    app.native_claim(&other, &claim, false).unwrap();
    assert_eq!(
        app.native_snapshot(true).unwrap()["cache_policy"]["media_capabilities"],
        json!({})
    );
    app.native_media_capabilities(
        &other,
        &json!({"hevc_supported":true,"avc_supported":false}),
    )
    .unwrap();
    let state = app.native_snapshot(true).unwrap();
    assert_eq!(state["cache_policy"]["enabled"], false);
    assert_eq!(
        state["cache_policy"]["media_backend"]["hevc_available"],
        false
    );
    assert_eq!(state["bbdown"]["ready"], false);
}

#[test]
fn desktop_next_consumes_reset_preference_without_resetting_global_delay() {
    for reset in [false, true] {
        let (mut app, _) = setup();
        app.native().desktop = true;
        let (snapshot, _) = ready(&mut app);
        let mut second = snapshot.current_item.unwrap();
        second.id = "second".into();
        clear_committed_artifact(&mut second, true);
        second.cache_status = "pending".into();
        second.cache_progress = 0.0;
        app.native_execute(AppStateRequest::AddItem {
            schema_version: 1,
            item: second,
            position: "tail".into(),
            requester_name: "Alice".into(),
            reset_av_delay: false,
            allow_repeat: true,
            now: 4.0,
        })
        .unwrap();
        app.native_execute(AppStateRequest::ApplyAvDelay {
            schema_version: 1,
            action: AvDelayCommand::SetPersistent {
                effective_delay_ms: 320,
            },
            now: 5.0,
        })
        .unwrap();
        app.native_execute(AppStateRequest::ApplyAvDelay {
            schema_version: 1,
            action: AvDelayCommand::SetEffective {
                effective_delay_ms: 620,
            },
            now: 6.0,
        })
        .unwrap();
        app.native().cache_policy.reset_offset_on_next = reset;
        let generation = app.native_core_snapshot().unwrap().playback_generation;
        app.native_execute(AppStateRequest::AdvanceToNext {
            schema_version: 1,
            expected_playback_generation: generation,
            reset_av_delay: !reset,
            now: 7.0,
        })
        .unwrap();
        let settings = app.native_core_snapshot().unwrap().player_settings;
        assert_eq!(settings.av_delay.global_delay_ms, 320);
        assert_eq!(
            settings.av_delay.local_delay_ms,
            if reset { 0 } else { 300 }
        );
    }
}

#[test]
fn public_titles_use_legacy_cleanup_without_changing_raw_records() {
    let (mut app, _) = setup();
    ready(&mut app);
    let mut seed: AppStateSeed = serde_json::from_value(
        json!({"session_started_at":1.0,"session_played_file":"titles.json","updated_at":1.0}),
    )
    .unwrap();
    let mut item = app.native_core_snapshot().unwrap().current_item.unwrap();
    item.title = "【ニコカラ】Song [on vocal]".into();
    item.display_title = "【ニコカラ】Song [on vocal] - P1".into();
    seed.current_item = Some(item.clone());
    let mut queued = item.clone();
    queued.id = "queued".into();
    seed.playlist.push(queued);
    let entry: HistoryEntry = serde_json::from_value(json!({"key":"song:1", "title":item.title,
        "display_title":item.display_title,"part_title":"P1", "original_url":item.original_url,
        "resolved_url":item.resolved_url,"requested_at":1.0}))
    .unwrap();
    seed.history.push(entry.clone());
    seed.session_history.push(entry);
    app.execute(AppStateRequest::Initialize {
        schema_version: 1,
        state: Box::new(seed),
    });
    for host in [true, false] {
        let public = app.native_snapshot(host).unwrap();
        assert_eq!(public["current_item"]["display_title"], "Song [on vocal]");
        for key in ["playlist", "history", "session_history"] {
            assert_eq!(public[key][0]["display_title"], "Song [on vocal]", "{key}");
            assert_eq!(public[key][0]["title"], item.title);
        }
    }
    assert_eq!(
        app.native_core_snapshot()
            .unwrap()
            .current_item
            .unwrap()
            .display_title,
        item.display_title
    );
}
