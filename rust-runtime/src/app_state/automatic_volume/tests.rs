use super::*;
use crate::app_state::native_session::Identity;
use std::path::PathBuf;

fn unique_directory(label: &str) -> PathBuf {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).unwrap();
    std::env::temp_dir().join(format!(
        "bilikara-volume-{label}-{}",
        bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
    ))
}

fn app() -> (AppState, Identity) {
    let mut app = AppState::default();
    let seed = serde_json::from_value(json!({"session_started_at":1,"session_played_file":"test.json","updated_at":1,"session_users":["Fixture"]})).unwrap();
    assert!(app.initialize_once(seed).error().is_none());
    app.native_session.host_token = "trusted-fixture-host".into();
    app.set_scanner_available(true);
    let host = Identity {
        token: "trusted-fixture-host".into(),
        loopback: true,
        client: "host-fixture".into(),
    };
    add(&mut app, "first");
    (app, host)
}

fn add(app: &mut AppState, id: &str) {
    add_owned(app, id, None);
}

fn add_owned(app: &mut AppState, id: &str, root: Option<&Path>) {
    let item: PlaylistItem = serde_json::from_value(json!({"id":id,"bvid":format!("BV{id}"),"aid":1,"cid":2,"page":1,"video_page":1,"original_url":"https://example.test","resolved_url":"https://example.test","title":"Synthetic tone","part_title":"Original","display_title":"Synthetic tone","cover_url":"","embed_url":""})).unwrap();
    let response = app.execute(AppStateRequest::AddItem {
        schema_version: 1,
        item,
        requester_user_id: None,
        requester_name: "Fixture".into(),
        position: "tail".into(),
        reset_av_delay: false,
        allow_repeat: true,
        now: 2.0,
    });
    assert!(response.error().is_none(), "{:?}", response.error());
    let item = app.data.as_ref().unwrap().find_item(id).unwrap();
    let response = app.execute(AppStateRequest::BeginCacheAttempt {
        schema_version: 1,
        item_id: id.into(),
        expected_item_incarnation_id: item.item_incarnation_id.clone(),
    });
    let reserved = response.result().unwrap();
    let directory = reserved["artifact_relative_directory"].as_str().unwrap();
    if let Some(root) = root {
        let token = reserved["cache_attempt_token"].as_u64().unwrap();
        let stage = root
            .join(".staging")
            .join(format!("attempt-{token}"))
            .join("complete");
        std::fs::create_dir_all(&stage).unwrap();
        for name in ["video.mp4", "original.m4a", "instrumental.m4a"] {
            std::fs::write(stage.join(name), b"policy fixture: reader lifetime only").unwrap();
        }
        assert!(app.publish_external_artifact(token).unwrap());
    }
    let event = serde_json::from_value(json!({"schema_version":1,"command":"apply_cache_event","item_id":id,"cache_attempt_token":reserved["cache_attempt_token"],"now":3,
        "event":{"kind":"ready","message":"Ready","item_incarnation_id":reserved["item_incarnation_id"],"artifact_set_id":reserved["artifact_set_id"],"artifact_relative_directory":directory,"video_relative_path":format!("{directory}/video.mp4"),"video_media_url":format!("/media/{directory}/video.mp4"),"audio_variants":[{"id":"original","label":"Original","audio_url":format!("/media/{directory}/original.m4a")},{"id":"instrumental","label":"Instrumental","audio_url":format!("/media/{directory}/instrumental.m4a")}],"selected_audio_variant_id":"original"}})).unwrap();
    let response = app.execute(event);
    assert!(response.error().is_none(), "{:?}", response.error());
}

fn measure(app: &mut AppState, id: &str, lufs: f64) {
    let data = app.data.as_mut().unwrap();
    let (key, _) = rendition(data.find_item(id).unwrap()).unwrap();
    data.automatic_playback
        .measurements
        .insert(key, MeasurementState::Complete(fact(lufs)));
}
fn fact(lufs: f64) -> LoudnessMeasurement {
    LoudnessMeasurement {
        algorithm: "ebur128-0.1.10-i-histogram-pcm-v1".into(),
        integrated_lufs: lufs,
        duration_seconds: 90.0,
        elapsed_seconds: 0.2,
        sample_rate: 48000,
        channels: 2,
        codec: "aac".into(),
    }
}
fn manual(app: &mut AppState, percent: i32) {
    let response = app.execute(AppStateRequest::SetVolume {
        schema_version: 1,
        volume_percent: percent,
        expected_item_incarnation_id: None,
        now: 4.0,
    });
    assert!(response.error().is_none());
}
fn action(
    app: &mut AppState,
    host: &Identity,
    action: &str,
) -> Result<Value, crate::native_host::ApiError> {
    let context = app.data.as_ref().unwrap().automatic_context();
    app.native_automatic_volume(host, &json!({"action":action,"context":context}))
}
fn enable(app: &mut AppState, host: &Identity, enabled: bool) {
    app.native_automatic_volume(host, &json!({"action":"enable","enabled":enabled}))
        .unwrap();
}
fn percent(app: &AppState) -> i32 {
    app.data.as_ref().unwrap().player_settings.volume_percent
}

#[test]
fn first_enable_measurement_and_manual_edits_never_establish_reference() {
    let (mut app, host) = app();
    assert!(!app.data.as_ref().unwrap().automatic_volume.enabled);
    manual(&mut app, 50);
    enable(&mut app, &host, true);
    let job = AnalysisJob {
        key: rendition(app.data.as_ref().unwrap().current_item.as_ref().unwrap())
            .unwrap()
            .0,
        relative: String::new(),
        lease: String::new(),
        epoch: app.data.as_ref().unwrap().automatic_playback.analysis_epoch,
        expected: app.data.as_ref().unwrap().automatic_context(),
    };
    app.finish_analysis(&job, Some(fact(-12.0)), false).unwrap();
    assert_eq!(percent(&app), 50);
    assert_eq!(
        app.data.as_ref().unwrap().automatic_volume.target_lufs,
        None
    );
    assert_eq!(
        app.data.as_ref().unwrap().automatic_snapshot().status,
        "waiting_baseline"
    );
    action(&mut app, &host, "reference").unwrap();
    assert_eq!(percent(&app), 50);
    let target = app
        .data
        .as_ref()
        .unwrap()
        .automatic_volume
        .target_lufs
        .unwrap();
    assert!((target + 18.020_599_913_279_625).abs() < 1e-10);
    manual(&mut app, 60);
    assert_eq!(
        app.data.as_ref().unwrap().automatic_volume.target_lufs,
        Some(target)
    );
    action(&mut app, &host, "reference").unwrap();
    assert_eq!(percent(&app), 60);
    assert_eq!(
        app.data
            .as_ref()
            .unwrap()
            .automatic_volume
            .calibration_revision,
        2
    );
}

#[test]
fn invalid_reference_and_stale_context_are_atomic() {
    let (mut app, host) = app();
    enable(&mut app, &host, true);
    assert!(action(&mut app, &host, "reference").is_err());
    measure(&mut app, "first", -12.0);
    for value in [0, 101, 500] {
        manual(&mut app, value);
        assert!(action(&mut app, &host, "reference").is_err());
        assert_eq!(percent(&app), value);
    }
    manual(&mut app, 50);
    app.execute(AppStateRequest::SetMuted {
        schema_version: 1,
        is_muted: true,
        now: 5.0,
    });
    assert!(action(&mut app, &host, "reference").is_err());
    app.execute(AppStateRequest::SetMuted {
        schema_version: 1,
        is_muted: false,
        now: 6.0,
    });
    let context = app.data.as_ref().unwrap().automatic_context();
    manual(&mut app, 51);
    assert_eq!(
        app.native_automatic_volume(&host, &json!({"action":"reference","context":context}))
            .unwrap_err()
            .code,
        "stale_automatic_context"
    );
    assert!(
        app.data
            .as_ref()
            .unwrap()
            .automatic_volume
            .target_lufs
            .is_none()
    );
    measure(&mut app, "first", f64::NAN);
    assert!(action(&mut app, &host, "reference").is_err());
}

#[test]
fn manual_override_survives_seek_restart_and_rendition_then_new_song_is_absolute() {
    let (mut app, host) = app();
    manual(&mut app, 50);
    enable(&mut app, &host, true);
    measure(&mut app, "first", -12.0);
    action(&mut app, &host, "reference").unwrap();
    add(&mut app, "second");
    measure(&mut app, "second", -8.0);
    let target = app.data.as_ref().unwrap().automatic_volume.clone();
    for volume in [0, 32, 100, 350] {
        manual(&mut app, volume);
        app.execute(AppStateRequest::RestartPlaybackProgram { schema_version: 1 });
        assert_eq!(percent(&app), volume);
        assert!(
            app.native_snapshot(false).unwrap()["automatic_volume"]["manual_override"]
                .as_bool()
                .unwrap()
        );
    }
    let item = app
        .data
        .as_ref()
        .unwrap()
        .current_item
        .as_ref()
        .unwrap()
        .clone();
    let response = app.execute(AppStateRequest::SetAudioVariant {
        schema_version: 1,
        item_id: item.id,
        expected_item_incarnation_id: item.item_incarnation_id,
        variant_id: "instrumental".into(),
        now: 7.0,
    });
    assert!(response.error().is_none());
    assert_eq!(percent(&app), 350);
    app.execute(AppStateRequest::AdvanceToNext {
        schema_version: 1,
        expected_playback_generation: app.data.as_ref().unwrap().playback_generation,
        reset_av_delay: false,
        now: 8.0,
    });
    assert_eq!(percent(&app), 32);
    assert!(
        !app.data
            .as_ref()
            .unwrap()
            .automatic_playback
            .manual_override
    );
    for _ in 0..5 {
        app.data.as_mut().unwrap().apply_automatic_volume();
        assert_eq!(percent(&app), 32);
    }
    manual(&mut app, 79);
    action(&mut app, &host, "resume").unwrap();
    assert_eq!(percent(&app), 32);
    enable(&mut app, &host, false);
    assert_eq!(percent(&app), 32);
    manual(&mut app, 75);
    enable(&mut app, &host, true);
    assert_eq!(percent(&app), 75);
    assert_eq!(app.data.as_ref().unwrap().automatic_volume, target);
}

#[test]
fn late_scan_disable_and_newer_intent_never_overwrite_manual() {
    let (mut app, host) = app();
    manual(&mut app, 50);
    enable(&mut app, &host, true);
    measure(&mut app, "first", -12.0);
    action(&mut app, &host, "reference").unwrap();
    let data = app.data.as_ref().unwrap();
    let job = AnalysisJob {
        key: rendition(data.current_item.as_ref().unwrap()).unwrap().0,
        relative: String::new(),
        lease: String::new(),
        epoch: data.automatic_playback.analysis_epoch,
        expected: data.automatic_context(),
    };
    manual(&mut app, 0);
    app.finish_analysis(&job, Some(fact(-8.0)), false).unwrap();
    assert_eq!(percent(&app), 0);
    manual(&mut app, 500);
    app.finish_analysis(&job, Some(fact(-16.0)), false).unwrap();
    assert_eq!(percent(&app), 500);
    enable(&mut app, &host, false);
    app.finish_analysis(&job, Some(fact(-24.0)), false).unwrap();
    assert_eq!(percent(&app), 500);
    let prior = app.data.as_ref().unwrap().automatic_volume.clone();
    app.execute(AppStateRequest::Shutdown { schema_version: 1 });
    app.finish_analysis(&job, Some(fact(-12.0)), false).unwrap();
    assert!(app.data.is_none());
    assert!(prior.target_lufs.is_some());
}

#[test]
fn host_capability_and_unknown_fields_cannot_be_forged() {
    let (mut app, host) = app();
    let token = app
        .native_join_remote("", "ordinary-fixture".into())
        .unwrap();
    let remote = Identity {
        token,
        loopback: true,
        client: "phone".into(),
    };
    for identity in [
        &remote,
        &Identity {
            loopback: false,
            ..host.clone()
        },
        &Identity {
            token: "fake".into(),
            ..host.clone()
        },
    ] {
        for body in [
            json!({"action":"enable","enabled":true}),
            json!({"action":"reference","context":app.data.as_ref().unwrap().automatic_context()}),
            json!({"action":"resume","context":app.data.as_ref().unwrap().automatic_context()}),
        ] {
            assert_eq!(
                app.native_automatic_volume(identity, &body)
                    .unwrap_err()
                    .status,
                403
            );
        }
    }
    assert!(
        app.native_automatic_volume(
            &host,
            &json!({"action":"enable","enabled":true,"origin":"automatic"})
        )
        .is_err()
    );
    assert!(app.native_authorize(&remote, false).is_ok());
    assert_eq!(
        app.native_snapshot(false).unwrap()["automatic_volume"]["host_controls"],
        false
    );
    assert!(
        app.native_snapshot(false).unwrap()["automatic_volume"]
            .get("context")
            .is_none()
    );
}

#[test]
fn saved_settings_schema_defaults_and_target_survive_restart() {
    for value in [
        json!(null),
        json!({"enabled":"yes"}),
        json!({"enabled":true,"target_lufs":-999}),
        json!({"enabled":true,"extra":1}),
    ] {
        let seed:AppStateSeed=serde_json::from_value(json!({"session_started_at":1,"session_played_file":"test.json","updated_at":1,"automatic_volume":value})).unwrap();
        assert!(!seed.automatic_volume.enabled);
    }
    let (mut app, host) = app();
    manual(&mut app, 50);
    enable(&mut app, &host, true);
    measure(&mut app, "first", -12.0);
    action(&mut app, &host, "reference").unwrap();
    let checkpoint = app.data.as_ref().unwrap().native_checkpoint();
    let target = checkpoint.automatic_volume.clone();
    let mut restored = AppState::default();
    restored.initialize_once(checkpoint);
    assert_eq!(restored.data.as_ref().unwrap().automatic_volume, target);
    assert!(
        restored
            .data
            .as_ref()
            .unwrap()
            .automatic_playback
            .manual_override
    );
    assert_eq!(percent(&restored), 50);
}

#[test]
fn no_song_and_queue_edits_cannot_create_or_drift_target() {
    let (mut app, host) = app();
    manual(&mut app, 1);
    enable(&mut app, &host, true);
    measure(&mut app, "first", -12.0);
    action(&mut app, &host, "reference").unwrap();
    assert_eq!(percent(&app), 1);
    let saved = app.data.as_ref().unwrap().automatic_volume.clone();
    add(&mut app, "second");
    app.execute(AppStateRequest::RemoveItem {
        schema_version: 1,
        item_id: "first".into(),
        now: 10.0,
    });
    assert_eq!(app.data.as_ref().unwrap().automatic_volume, saved);
    app.execute(AppStateRequest::RemoveItem {
        schema_version: 1,
        item_id: "second".into(),
        now: 11.0,
    });
    assert_eq!(app.data.as_ref().unwrap().automatic_volume, saved);
    enable(&mut app, &host, false);
    enable(&mut app, &host, true);
    assert_eq!(app.data.as_ref().unwrap().automatic_volume, saved);
    assert!(action(&mut app, &host, "reference").is_err());
    let (mut fresh, host) = self::app();
    fresh.execute(AppStateRequest::RemoveItem {
        schema_version: 1,
        item_id: "first".into(),
        now: 12.0,
    });
    enable(&mut fresh, &host, true);
    let empty = fresh.data.as_ref().unwrap().automatic_snapshot();
    assert_eq!(empty.reference_reason, "no_audio");
    assert!(
        !empty.can_reference,
        "no song cannot enable the reference button"
    );
    assert_eq!(
        fresh.data.as_ref().unwrap().automatic_snapshot().status,
        "waiting_baseline"
    );
    assert!(
        fresh
            .data
            .as_ref()
            .unwrap()
            .automatic_volume
            .target_lufs
            .is_none()
    );
    assert_eq!(percent(&fresh), 100);
}

#[test]
fn unmeasured_transition_is_safe_and_mute_and_reset_keep_their_roles() {
    let (mut app, host) = app();
    manual(&mut app, 50);
    enable(&mut app, &host, true);
    measure(&mut app, "first", -12.0);
    action(&mut app, &host, "reference").unwrap();
    add(&mut app, "second");
    add(&mut app, "third");
    app.execute(AppStateRequest::AdvanceToNext {
        schema_version: 1,
        expected_playback_generation: app.data.as_ref().unwrap().playback_generation,
        reset_av_delay: false,
        now: 9.0,
    });
    assert_eq!(percent(&app), 50, "unmeasured next song is never forced up");
    let pending = app.data.as_ref().unwrap().automatic_snapshot();
    assert_eq!(pending.reference_reason, "analyzing");
    assert!(
        !pending.can_reference,
        "incomplete analysis cannot enable the reference button"
    );
    assert_eq!(
        app.data.as_ref().unwrap().automatic_snapshot().status,
        "analyzing"
    );
    manual(&mut app, 500);
    app.execute(AppStateRequest::SetMuted {
        schema_version: 1,
        is_muted: true,
        now: 10.0,
    });
    app.execute(AppStateRequest::AdvanceToNext {
        schema_version: 1,
        expected_playback_generation: app.data.as_ref().unwrap().playback_generation,
        reset_av_delay: false,
        now: 11.0,
    });
    assert_eq!(
        percent(&app),
        100,
        "previous explicit boost is not an automatic default"
    );
    assert!(app.data.as_ref().unwrap().player_settings.is_muted);
    measure(&mut app, "third", -8.0);
    app.data.as_mut().unwrap().apply_automatic_volume();
    assert_eq!(percent(&app), 100);
    app.execute(AppStateRequest::SetMuted {
        schema_version: 1,
        is_muted: false,
        now: 12.0,
    });
    assert_eq!(percent(&app), 32);
    assert!(
        !app.data
            .as_ref()
            .unwrap()
            .automatic_playback
            .manual_override,
        "mute alone is independent"
    );
    app.execute(AppStateRequest::ResetPlayer {
        schema_version: 1,
        now: 13.0,
    });
    assert_eq!(percent(&app), 100);
    assert_eq!(
        app.data.as_ref().unwrap().automatic_snapshot().status,
        "manual"
    );
    action(&mut app, &host, "resume").unwrap();
    assert_eq!(percent(&app), 32);
    manual(&mut app, 100);
    manual(&mut app, 100);
    assert_eq!(
        app.data.as_ref().unwrap().automatic_snapshot().status,
        "manual",
        "manual reset does not resume auto"
    );
}

#[test]
fn storage_failure_preserves_reference_and_disk_restart_restores_it() {
    let directory = unique_directory("save");
    let (mut app, host) = app();
    let (storage, _) = crate::native_host_storage::NativeHostStorage::open(&directory).unwrap();
    app.native_storage = Some(storage);
    manual(&mut app, 50);
    enable(&mut app, &host, true);
    measure(&mut app, "first", -12.0);
    action(&mut app, &host, "reference").unwrap();
    let saved = app.data.as_ref().unwrap().automatic_volume.clone();
    manual(&mut app, 60);
    let bytes = std::fs::read(directory.join("host-state.json")).unwrap();
    std::fs::create_dir(directory.join("host-state.pending")).unwrap();
    assert_eq!(
        action(&mut app, &host, "reference").unwrap_err().status,
        503
    );
    assert_eq!(app.data.as_ref().unwrap().automatic_volume, saved);
    assert_eq!(percent(&app), 60);
    assert!(
        app.data
            .as_ref()
            .unwrap()
            .automatic_playback
            .manual_override
    );
    assert!(
        app.native_automatic_volume(&host, &json!({"action":"enable","enabled":false}))
            .is_err()
    );
    assert_eq!(
        std::fs::read(directory.join("host-state.json")).unwrap(),
        bytes
    );
    std::fs::remove_dir(directory.join("host-state.pending")).unwrap();
    let seed = app.data.as_ref().unwrap().native_checkpoint();
    drop(app);
    let mut restored = AppState::default();
    assert!(
        restored
            .initialize_native(&directory, seed)
            .error()
            .is_none()
    );
    assert_eq!(restored.data.as_ref().unwrap().automatic_volume, saved);
    assert_eq!(percent(&restored), 60);
    assert!(
        restored
            .data
            .as_ref()
            .unwrap()
            .automatic_playback
            .manual_override
    );
    drop(restored);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn analysis_leases_release_after_disable_eviction_and_shutdown() {
    let root = unique_directory("lease");
    let (mut app, host) = app();
    app.execute(AppStateRequest::RemoveItem {
        schema_version: 1,
        item_id: "first".into(),
        now: 9.0,
    });
    let owner = app.open_artifact_lifetime(&root).unwrap();
    add_owned(&mut app, "owned", Some(&root));
    let (sender, _) = std::sync::mpsc::sync_channel(1);
    let cancelled = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    app.install_analysis(AnalysisSignal {
        wake: sender,
        cancelled: cancelled.clone(),
    });
    assert!(app.take_analysis_job().is_none(), "OFF admits no decode");
    enable(&mut app, &host, true);
    let job = app.take_analysis_job().unwrap();
    assert_eq!(app.artifact_reader_count(), 1);
    cancelled.store(false, std::sync::atomic::Ordering::Release);
    enable(&mut app, &host, false);
    assert!(cancelled.load(std::sync::atomic::Ordering::Acquire));
    app.finish_analysis(&job, Some(fact(-12.0)), true).unwrap();
    assert_eq!(app.artifact_reader_count(), 0);
    enable(&mut app, &host, true);
    let job = app.take_analysis_job().unwrap();
    app.execute(AppStateRequest::RemoveItem {
        schema_version: 1,
        item_id: "owned".into(),
        now: 10.0,
    });
    assert!(
        app.prepare_artifact_collection().is_empty(),
        "reader prevents eviction while scanning"
    );
    app.finish_analysis(&job, Some(fact(-8.0)), false).unwrap();
    assert_eq!(app.artifact_reader_count(), 0);
    assert!(
        app.data
            .as_ref()
            .unwrap()
            .automatic_playback
            .measurements
            .is_empty()
    );
    for collection in app.prepare_artifact_collection() {
        assert!(collection.delete().is_ok());
        app.finish_artifact_collection(&collection, true);
    }
    add_owned(&mut app, "shutdown", Some(&root));
    let job = app.take_analysis_job().unwrap();
    app.execute(AppStateRequest::Shutdown { schema_version: 1 });
    app.finish_analysis(&job, Some(fact(-12.0)), false).unwrap();
    assert_eq!(app.artifact_reader_count(), 0);
    for collection in app.prepare_artifact_collection() {
        assert!(collection.delete().is_ok());
        app.finish_artifact_collection(&collection, true);
    }
    assert!(app.close_artifact_lifetime(&owner));
    std::fs::remove_dir_all(root).unwrap();
}
