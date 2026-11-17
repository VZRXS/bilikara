//! Isolated processes exercise Android provisioning using actual host libraries.
use super::*;
use crate::native_host::{NativeHost, android_media};
use crate::{AppStateRequest, execute_app_state};
use std::{fs, process::Command};

struct IncompatibleCompanion {
    directory: PathBuf,
    library: PathBuf,
}

impl IncompatibleCompanion {
    fn build() -> Self {
        let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../.tmp")
            .join(format!("a2-abi-{}", token().unwrap()));
        fs::create_dir_all(&directory).unwrap();
        let name = if cfg!(target_os = "windows") {
            "incompatible.dll"
        } else if cfg!(target_os = "macos") {
            "libincompatible.dylib"
        } else {
            "libincompatible.so"
        };
        let fixture = Self {
            library: directory.join(name),
            directory,
        };
        fs::write(
            fixture.directory.join("fixture.c"),
            include_bytes!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../tests/fixtures/libav_incompatible.c"
            )),
        )
        .unwrap();
        // Use the native compiler already required by this Cargo test build.
        // Relative arguments avoid passing Windows verbatim paths to MSVC.
        let mut compiler = if cfg!(target_os = "windows") {
            let mut command = Command::new("cl.exe");
            command.args([
                "/nologo",
                "/LD",
                "/W4",
                "/WX",
                "fixture.c",
                "/Fofixture.obj",
                "/link",
                "/OUT:incompatible.dll",
                "/IMPLIB:fixture.lib",
            ]);
            command
        } else {
            let mut command = Command::new("cc");
            command.args([
                if cfg!(target_os = "macos") {
                    "-dynamiclib"
                } else {
                    "-shared"
                },
                "-fPIC",
                "-Wall",
                "-Wextra",
                "-Werror",
                "fixture.c",
                "-o",
                name,
            ]);
            command
        };
        let status = compiler
            .current_dir(&fixture.directory)
            .status()
            .expect("native C compiler required to build the incompatible ABI fixture");
        assert!(
            status.success(),
            "incompatible ABI fixture compilation failed: {status}"
        );
        assert!(fixture.library.is_file());
        fixture
    }
}

impl Drop for IncompatibleCompanion {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.directory);
    }
}

#[test]
#[ignore = "requires freshly built BILIKARA_TEST_CAST_COMPANION and a native C compiler"]
fn android_media_startup_cache_and_failure_matrix() {
    let valid = PathBuf::from(std::env::var_os("BILIKARA_TEST_CAST_COMPANION").expect("companion"));
    assert!(valid.is_file());
    let incompatible = IncompatibleCompanion::build();
    for case in ["available", "missing", "invalid", "abi", "jni"] {
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "native_host::cast_session::media::android_tests::android_media_startup_child",
                "--ignored",
                "--nocapture",
            ])
            .env("BILIKARA_A2_CASE", case)
            .env("BILIKARA_A2_VALID", &valid)
            .env("BILIKARA_A2_INCOMPATIBLE", &incompatible.library)
            // Use production shared routing, never cast's test-only override.
            .env_remove("BILIKARA_TEST_CAST_COMPANION")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{case}: {}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        println!("A2_STARTUP {case}: passed");
    }
}

#[test]
#[ignore = "subprocess-only entry; run android_media_startup_cache_and_failure_matrix"]
fn android_media_startup_child() {
    let Ok(case) = std::env::var("BILIKARA_A2_CASE") else {
        return;
    };
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../.tmp")
        .join(format!("a2-startup-{}", token().unwrap()));
    fs::create_dir_all(&root).unwrap();
    let invalid = root.join("invalid-library");
    fs::write(&invalid, b"not a library").unwrap();
    let path = match case.as_str() {
        "available" => PathBuf::from(std::env::var_os("BILIKARA_A2_VALID").unwrap()),
        "abi" => PathBuf::from(std::env::var_os("BILIKARA_A2_INCOMPATIBLE").unwrap()),
        "missing" => root.join("missing-library"),
        _ => invalid,
    };
    if case == "jni" {
        android_media::android_media_unavailable();
    } else {
        android_media::configure_android_media(&path);
    }
    let available = case == "available";
    let status = android_media::capability().unwrap();
    assert_eq!(status.metadata, available);
    assert_eq!(status.loudness, available);
    assert_eq!(status.cast, available);
    assert_eq!(status.l1, available);
    assert_eq!(
        crate::media_routing::output_companion().is_some(),
        available
    );
    let expected_reason = match case.as_str() {
        "missing" => Some("companion_missing"),
        "invalid" => Some("companion_load_failed"),
        "abi" => Some("companion_negotiation_failed"),
        "jni" => Some("native_library_dir_unavailable"),
        _ => None,
    };
    assert_eq!(status.reason, expected_reason);
    let seed = serde_json::from_value(json!({"session_users":["Alice"],"session_started_at":1,"session_played_file":"session.json","updated_at":1,"automatic_volume":{"enabled":!available}})).unwrap();
    assert!(crate::initialize_native_host(&root, seed).error().is_none());
    let host = NativeHost::start(&root, Arc::new(|_| None))
        .expect("media failure must not block real Host startup");
    assert!(host.local_port() > 0);
    let snapshot = with_app(|app| app.native_snapshot(true)).unwrap();
    assert_eq!(snapshot["automatic_volume"]["scanner_available"], available);
    // This is the same probe used by S0 and every cast preparation.
    let cast = probe();
    if available {
        assert!(cast.unwrap().cast_mux_available());
    } else {
        assert_eq!(cast.err().unwrap().code, "cast_backend_unavailable");
    }
    let failure_loads = crate::experimental_libav::TEST_LOADS.load(Ordering::Acquire);
    let wake_scanner = || {
        use crate::native_host::automatic_volume::TEST_SCANNER_WAKES;
        let before = TEST_SCANNER_WAKES.load(Ordering::Acquire);
        with_app(|app| {
            app.notify_analysis(false);
            Ok(())
        })
        .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while TEST_SCANNER_WAKES.load(Ordering::Acquire) == before {
            assert!(
                std::time::Instant::now() < deadline,
                "scanner did not process wake"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    };
    if !available {
        for _ in 0..3 {
            wake_scanner();
            assert_eq!(probe().err().unwrap().code, "cast_backend_unavailable");
        }
        assert_eq!(
            crate::experimental_libav::TEST_LOADS.load(Ordering::Acquire),
            failure_loads,
            "startup/automatic volume/cast must share the failed load"
        );
    }
    let diagnostics = with_app(|app| Ok(app.native_diagnostics())).unwrap();
    let events = diagnostics["events"].as_array().unwrap();
    let capability = events
        .iter()
        .find(|e| e["event"] == "android-media-capability")
        .unwrap();
    assert_eq!(capability["companion_cast"], available);
    assert_eq!(capability["companion_loudness"], available);
    assert_eq!(capability["companion_l1"], available);
    if let Some(reason) = expected_reason {
        assert_eq!(capability["reason"], reason);
        assert!(
            events
                .iter()
                .any(|e| e["event"] == "automatic-volume-unavailable" && e["reason"] == reason)
        );
        assert_eq!(
            events
                .iter()
                .filter(|e| e["event"] == "automatic-volume-unavailable")
                .count(),
            1
        );
    }
    let prepared = root.join("prepared");
    fs::create_dir(&prepared).unwrap();
    let fixtures =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/native_host/cast_session/fixtures");
    for (source, destination, kind) in [
        (
            "keyframes-30s.mp4",
            "video.mp4",
            crate::ExpectedMediaKind::Video,
        ),
        (
            "audio-30s.m4a",
            "audio.m4a",
            crate::ExpectedMediaKind::Audio,
        ),
    ] {
        crate::media_backend::normalize_media(&crate::MediaNormalizeRequest {
            schema_version: 1,
            source: fixtures.join(source),
            destination: prepared.join(destination),
            expected_kind: kind,
        })
        .unwrap();
        let routed = crate::media_routing::normalize(
            &crate::MediaNormalizeRequest {
                schema_version: 1,
                source: fixtures.join(source),
                destination: root.join(format!("routed-{destination}")),
                expected_kind: kind,
            },
            &AtomicBool::new(false),
            &|| false,
        )
        .unwrap();
        assert_eq!(
            routed.diagnostic.backend,
            if available {
                crate::media_routing::Backend::Libav
            } else {
                crate::media_routing::Backend::PureRust
            }
        );
        if !available {
            assert_eq!(
                routed.diagnostic.compatibility_reason,
                Some(if case == "jni" {
                    crate::media_routing::Reason::NotProvisioned
                } else {
                    crate::media_routing::Reason::Unavailable
                })
            );
            assert_eq!(
                fs::read(&routed.media.output.path).unwrap(),
                fs::read(prepared.join(destination)).unwrap()
            );
        }
    }
    let item = serde_json::from_value(json!({"id":"old-cache","original_url":"https://example.test/video","resolved_url":"https://example.test/video","bvid":"old-cache","aid":1,"cid":2,"page":1,"title":"old-cache","part_title":"P1","display_title":"old-cache","cover_url":"","embed_url":"","selected_pages":[1],"selected_cids":[2],"selected_durations":[30],"selected_parts":["P1"],"available_pages":[1],"available_cids":[2],"available_durations":[30],"available_parts":["P1"]})).unwrap();
    assert!(
        execute_app_state(AppStateRequest::AddItem {
            schema_version: 1,
            requester_user_id: None,
            item,
            position: "tail".into(),
            requester_name: "Alice".into(),
            reset_av_delay: false,
            allow_repeat: true,
            now: 2.0
        })
        .error()
        .is_none()
    );
    let item = with_app(|app| Ok(app.native_core_snapshot()?.current_item.unwrap())).unwrap();
    let reservation =
        crate::app_state::begin_cache_attempt_for_runtime("old-cache", &item.item_incarnation_id)
            .unwrap();
    let directory = host
        .context
        .cache_root
        .join(&reservation.artifact_relative_directory);
    fs::create_dir_all(&directory).unwrap();
    fs::copy(prepared.join("video.mp4"), directory.join("video.mp4")).unwrap();
    fs::copy(prepared.join("audio.m4a"), directory.join("audio.m4a")).unwrap();
    let video = format!("{}/video.mp4", reservation.artifact_relative_directory);
    let audio = format!("{}/audio.m4a", reservation.artifact_relative_directory);
    let event = serde_json::from_value(json!({"kind":"ready","message":"ready","video_relative_path":video,"video_media_url":format!("/media/{video}"),"audio_variants":[{"id":"p1","page":1,"label":"P1","audio_url":format!("/media/{audio}")}],"selected_audio_variant_id":"p1","item_incarnation_id":reservation.item_incarnation_id,"artifact_set_id":reservation.artifact_set_id,"artifact_relative_directory":reservation.artifact_relative_directory})).unwrap();
    assert!(
        execute_app_state(AppStateRequest::ApplyCacheEvent {
            schema_version: 1,
            item_id: "old-cache".into(),
            cache_attempt_token: reservation.cache_attempt_token,
            event,
            now: 3.0
        })
        .error()
        .is_none()
    );
    // A real sync with libav configured must keep the old Rust cache out of
    // worker admission: no reservation, download, or normalization is needed.
    let command = serde_json::from_value(json!({
        "command":"sync", "cache_root":host.context.cache_root, "current_ids":["old-cache"],
        "current_item_incarnations":{"old-cache":item.item_incarnation_id},
        "retained_ids":["old-cache"], "ordered_ids":["old-cache"],
        "jobs":[{"item_id":"old-cache","item_incarnation_id":item.item_incarnation_id,
          "bvid":"BV1xx411c7mD","video_page":1,"pages":[{"page":1,"cid":2,"label":"P1"}],
          "cache_root":host.context.cache_root,"log_file":root.join("reuse.log"),
          "reported_ready":true,"existing_video_relative_path":video,
          "existing_audio_variants":[{"id":"p1","page":1,"label":"P1","relative_path":audio}]}]
    }))
    .unwrap();
    let synced = crate::cache_runtime::execute_cache_runtime(command).unwrap();
    assert_eq!(synced["generations"], json!({}));
    assert_eq!(synced["snapshot"]["pending_ids"], json!([]));
    assert!(!root.join("reuse.log").exists());
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    for relative in [video, audio] {
        let path = host.context.cache_root.join(&relative);
        let before = fs::read(&path).unwrap();
        let response = runtime
            .block_on(crate::native_host::files::media(
                &host.context,
                &format!("/media/{relative}"),
                &axum::http::HeaderMap::new(),
                false,
            ))
            .unwrap();
        assert_eq!(response.status(), 200);
        let body = runtime
            .block_on(axum::body::to_bytes(response.into_body(), usize::MAX))
            .unwrap();
        assert_eq!(body.as_ref(), before);
        assert_eq!(fs::read(&path).unwrap(), before);
    }
    if !available {
        assert_eq!(
            crate::experimental_libav::TEST_LOADS.load(Ordering::Acquire),
            failure_loads,
            "normalization must also reuse the failed load"
        );
    }
    if matches!(case.as_str(), "missing" | "invalid") {
        fs::write(&path, b"a changed, still invalid companion file").unwrap();
        for _ in 0..3 {
            wake_scanner();
            assert_eq!(probe().err().unwrap().code, "cast_backend_unavailable");
        }
        assert_eq!(
            crate::experimental_libav::TEST_LOADS.load(Ordering::Acquire),
            failure_loads + 1
        );
        let diagnostics = with_app(|app| Ok(app.native_diagnostics())).unwrap();
        assert_eq!(
            diagnostics["events"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|e| e["event"] == "automatic-volume-unavailable")
                .count(),
            2
        );
    }
    drop(host);
    execute_app_state(AppStateRequest::Shutdown { schema_version: 1 });
    fs::remove_dir_all(root).unwrap();
}
