//! End-to-end self-test through actual T3/T4/T2/T9, with event-synchronized answers.
use super::*;
use crate::dlna::diagnostics::{Answer, UserAnswers, VideoAnswer};
use crate::native_host::cast_session::self_test;

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap()
}

#[test]
fn self_test_discovery_links_udn_evidence_not_unrelated_salted_keys() {
    let receiver = Receiver::new();
    let target = receiver.renderer();
    let mut found = target.clone();
    found.context.device_key = "independent-t2-salt".into();
    let devices = [found];
    let matched = self_test::runner::identity_match(&target, &devices).unwrap();
    let trace = crate::dlna::diagnostics::SessionTrace::new(
        crate::dlna::diagnostics::Platform::Windows,
        crate::dlna::diagnostics::TargetKind::Purek,
        "0.8.0",
        "11",
    )
    .unwrap();
    let connection = trace.begin_connection();
    trace.discovery_facts(connection, Duration::from_secs(15), Some(false), Some(true));
    trace.discovery_target_facts(connection, &target.context, None, Some(matched));
    let report = trace.report();
    let c = &report.diagnostics()["cast_self_test"]["discovery"]["connections"][0];
    assert_eq!(c["target_before_auth"], false);
    assert_eq!(c["target_after_auth"], true);
    assert!(c["matched_before_device_key"].is_null());
    assert!(c["matched_after_device_key"].is_string());
    assert_ne!(c["target_device_key"], c["matched_after_device_key"]);
    assert_eq!(
        report.diagnostics()["cast_self_test"]["conclusion"]["decision_row"],
        11
    );
    let mut other = target.clone();
    other.description.id = "uuid:another-device".into();
    assert!(self_test::runner::identity_match(&other, &devices).is_none());
    let mut missing = target;
    missing.description.id.clear();
    assert!(self_test::runner::identity_match(&missing, &[missing.clone()]).is_none());
    privacy(&report.json());
}

fn scenario(name: &str) -> Value {
    eprintln!("self-test scenario: {name}");
    let _serial = GLOBAL_APP_TEST_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    assert!(
        std::env::var_os("BILIKARA_TEST_CAST_COMPANION").is_some(),
        "Set BILIKARA_TEST_CAST_COMPANION to the same-build test companion"
    );
    let mut host = Host::new();
    if let Some(root) = crate::cast_samples::root() {
        Arc::get_mut(&mut host.context).unwrap().sample_root = Some(root);
    }
    if name == "long_a" {
        host.use_long_media();
    }
    if name == "bad_b" {
        let root = host.context.directory.join("bad-sample");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("sample-b.ts"), b"corrupt").unwrap();
        Arc::get_mut(&mut host.context).unwrap().sample_root = Some(root);
    }
    if name == "no_sample_root" {
        Arc::get_mut(&mut host.context).unwrap().sample_root = None;
    }
    if name == "missing_b" {
        let root = host.context.directory.join("missing-samples");
        Arc::get_mut(&mut host.context).unwrap().sample_root = Some(root);
    }
    if matches!(name, "bad_a" | "bad_audio" | "no_cache") {
        let snap = with_app(|app| app.native_core_snapshot()).unwrap();
        for item in snap.current_item.iter().chain(&snap.playlist) {
            let path = host
                .context
                .cache_root
                .join(item.video_media_url.strip_prefix("/media/").unwrap());
            if name == "bad_audio" {
                std::fs::write(path.with_file_name("audio.m4a"), b"not audio").unwrap();
            } else if name == "bad_a" {
                std::fs::write(path, b"not a video").unwrap();
            } else {
                std::fs::remove_file(path).unwrap();
            }
        }
    }
    let receiver = Receiver::new();
    {
        let mut state = receiver.state.lock().unwrap();
        state.fault_on = match name {
            "stop_fault" => Some("Stop"),
            "set_fault" => Some("SetAVTransportURI"),
            "play_fault" => Some("Play"),
            "registration_rejected" => Some("SetDeviceAuthorization"),
            _ => None,
        };
        state.no_pull = name == "no_pull";
        state.clients = if name == "concurrent" { 5 } else { 1 };
        state.different_peer = name == "different_peer";
        state.synchronize_pulls = matches!(name, "different_peer" | "concurrent");
        state.reject_files = name == "live_only";
    }
    let renderer = if name == "empty" {
        None
    } else {
        let mut renderer = receiver.renderer();
        if name == "no_udn" {
            renderer.description.id.clear();
        }
        Some(renderer)
    };
    let qr = matches!(
        name,
        "registration_rejected" | "cancel" | "handoff" | "finish"
    )
    .then(|| receiver.qr());
    let cancel = CancellationToken::new();
    let (send, receive) = tokio::sync::mpsc::channel(2);
    let mut handoff_report = None;
    let report = runtime().block_on(async {
        let run = self_test::tests::run(
            host.context.clone(),
            renderer,
            qr,
            cancel.clone(),
            send,
            receive,
            self_test::runner::Timing {
                scan_before: Duration::ZERO,
                scan_after: Duration::ZERO,
                playback: if name == "no_pull" {
                    Duration::from_millis(10_050)
                } else {
                    Duration::from_millis(250)
                },
                question_after: Duration::from_millis(100),
                answer_timeout: if name == "unanswered" {
                    Duration::from_millis(100)
                } else {
                    Duration::from_secs(30)
                },
                between: Duration::ZERO,
                poll: Duration::from_millis(50),
                handoff_timeout: Duration::from_secs(5),
            },
        );
        let answer = async {
            if name == "unanswered" {
                return;
            }
            loop {
                let state = self_test::tests::question().await;
                if state["running"] == false {
                    break;
                }
                if state["handoff_available"] == true {
                    self_test::route(&host.context, &host.identity, &Method::POST, "/api/cast/self-test/handoff", &json!({"generation":1,"start_casting":name=="handoff"})).unwrap();
                    if name == "handoff" {
                        tokio::time::timeout(Duration::from_secs(10), async {
                            loop {
                                if host.snapshot()["cast"]["phase"] == "active" { break; }
                                tokio::task::yield_now().await;
                            }
                        }).await.unwrap();
                        let state = host.snapshot();
                        assert_eq!(state["cast"]["self_test"]["running"], false);
                        assert_eq!(state["cast"]["self_test"]["report_available"], true);
                        let report = self_test::route(&host.context, &host.identity, &Method::GET, "/api/cast/self-test/report", &json!({})).unwrap();
                        let metadata = &report["diagnostics"]["cast_self_test"]["metadata"];
                        assert!(metadata["finished_at"].is_string(), "self-test must finish while handed-off playback is still active");
                        assert_eq!(metadata["cancelled"], false);
                        assert!(report["text"].as_str().is_some_and(|text| !text.is_empty()));
                        handoff_report = Some(report["diagnostics"].clone());
                        assert_eq!(receiver.state.lock().unwrap().releases, 0);
                        assert_eq!(receiver.state.lock().unwrap().actions.iter().filter(|a| a.as_str()=="SetDeviceAuthorization").count(), 1);
                        receiver.release_hold.store(true, Ordering::Release);
                        host.post("/api/cast/disconnect", json!({})).unwrap();
                        tokio::time::timeout(Duration::from_secs(3), async {
                            loop {
                                if receiver.release_ready.load(Ordering::Acquire) { break; }
                                tokio::task::yield_now().await;
                            }
                        }).await.unwrap();
                        let owns = host.snapshot()["cast"]["owns_playback"].clone();
                        receiver.release_hold.store(false, Ordering::Release);
                        assert_eq!(owns, true, "ordinary worker must await handed-off room cleanup");
                        break;
                    }
                    continue;
                }
                if name == "cancel" {
                    let start = Instant::now();
                    cancel.cancel();
                    loop {
                        let state = self_test::tests::question().await;
                        if state["running"] == false {
                            break;
                        }
                        tokio::task::yield_now().await;
                    }
                    assert!(
                        start.elapsed() < Duration::from_secs(3),
                        "cancellation exceeded 3 seconds"
                    );
                    break;
                }
                let cell = state["cell"].as_str().unwrap();
                let yes = match name {
                    "no_pull" | "decode" => false,
                    "uniform_file" => cell == "file_b",
                    "uniform_live" => cell == "live_b",
                    "mp4" => cell == "file_mp4_a",
                    _ => true,
                };
                let answer = UserAnswers {
                    video: if yes {
                        VideoAnswer::Normal
                    } else {
                        VideoAnswer::Black
                    },
                    audio: if yes { Answer::Yes } else { Answer::No },
                    synchronized: Answer::Yes,
                };
                let body = json!({"generation":1,"cell":cell,"question_id":state["question_id"],"answers":answer});
                if name == "success" {
                    let mut stale = body.clone(); stale["question_id"] = json!(0);
                    assert_eq!(self_test::route(&host.context, &host.identity, &Method::POST, "/api/cast/self-test/answer", &stale).unwrap_err().code, "cast_self_test_stale");
                    self_test::tests::expired_answer(&host.context, &host.identity, &body);
                }
                self_test::route(
                    &host.context,
                    &host.identity,
                    &Method::POST,
                    "/api/cast/self-test/answer",
                    &body,
                )
                .unwrap();
            }
        };
        let (report, ()) = tokio::join!(run, answer);
        report
    });
    let value = report.diagnostics().clone();
    let result = &value["cast_self_test"];
    if let Some(handoff_report) = handoff_report {
        assert_eq!(
            value, handoff_report,
            "later playback cancellation must not alter the finished self-test report"
        );
    }
    if name == "bad_audio" {
        assert_eq!(
            self_test::tests::mux_count(),
            1,
            "failed merge must not retry every cached song"
        );
    }
    if name == "long_a" {
        assert!(
            result["preflight"]["sample_a"]["synthesis_ms"]
                .as_u64()
                .unwrap()
                < 20_000
        );
        assert_eq!(self_test::tests::mux_count(), 1);
        assert!((19_000_000..20_000_000).contains(&self_test::tests::recorded_end_us()));
    }
    if matches!(
        name,
        "success" | "uniform_file" | "uniform_live" | "mp4" | "live_only"
    ) {
        let mp4 = result["cells"][4]["skip_reason"].is_null();
        assert_eq!(
            self_test::tests::mux_count(),
            if mp4 { 2 } else { 1 },
            "{name}: original inputs are merged at most twice"
        );
    }
    if name == "mp4" {
        assert!(
            with_app(|app| Ok(app
                .cast_preferences()?
                .devices
                .values()
                .any(|d| d.learned_variant == Some(Variant::FileMp4))))
            .unwrap()
        );
    }
    assert_eq!(
        result["environment"]["companion_aac"], true,
        "test companion must execute"
    );
    if !matches!(name, "bad_a" | "bad_audio" | "no_cache") {
        assert!(
            result["preflight"]["sample_a"].is_object(),
            "{name}: A must actually synthesize"
        );
    }
    let platform_sample_failure =
        std::env::var("BILIKARA_TEST_SAMPLE_ASSET_CASE").is_ok_and(|case| {
            matches!(
                case.as_str(),
                "no_space" | "copy_failed" | "absent" | "corrupt"
            )
        });
    if platform_sample_failure {
        assert!(result["preflight"]["sample_b"].is_null());
    } else if !matches!(name, "bad_b" | "no_sample_root" | "missing_b") {
        assert!(
            result["preflight"]["sample_b"].is_object(),
            "{name}: B must actually prepare"
        );
    }
    assert_eq!(result["schema_version"], 1);
    assert_eq!(result["steps"].as_array().unwrap().len(), 8);
    assert_eq!(result["cells"].as_array().unwrap().len(), 5);
    assert!(
        result["cells"]
            .as_array()
            .unwrap()
            .iter()
            .all(|c| c["terminal"] == true && c["stage"].is_string())
    );
    privacy(&report.json());
    privacy(report.text());
    assert!(
        report.text().lines().count() < 30,
        "self-test summary must stay one page"
    );
    if matches!(name, "success" | "no_udn") {
        let prefs = with_app(|app| app.cast_preferences().cloned()).unwrap();
        let state = host.snapshot();
        if name == "no_udn" {
            assert!(prefs.devices.is_empty());
            assert_eq!(state["cast"]["self_test"]["preferences_persisted"], false);
        } else {
            assert!(
                prefs
                    .devices
                    .values()
                    .any(|d| d.learned_mode == Some(LearnedMode::File)
                        && d.learned_variant == Some(Variant::Original))
            );
        }
        let read = self_test::route(
            &host.context,
            &host.identity,
            &Method::GET,
            "/api/cast/self-test/report",
            &json!({}),
        )
        .unwrap();
        assert_eq!(
            read["diagnostics"]["cast_self_test"]["conclusion"]["decision_row"],
            1
        );
        assert!(
            self_test::route(
                &host.context,
                &host.identity,
                &Method::POST,
                "/api/cast/self-test/answer",
                &json!({"generation":1,"cell":"file_a"})
            )
            .is_err()
        );
        let forbidden = Identity {
            token: "remote".into(),
            loopback: false,
            client: "remote".into(),
        };
        assert!(
            self_test::route(
                &host.context,
                &forbidden,
                &Method::GET,
                "/api/cast/self-test/report",
                &json!({})
            )
            .is_err()
        );
        assert!(self_test::download(&forbidden).is_err());
        let saved = runtime()
            .block_on(axum::body::to_bytes(
                self_test::download(&host.identity).unwrap().into_body(),
                1024 * 1024,
            ))
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&saved).unwrap()["diagnostics"]["cast_self_test"]["conclusion"]
                ["decision_row"],
            1
        );
        let zip =
            crate::native_host::diagnostics::package(&host.context, &host.identity, &json!({}))
                .unwrap();
        let zip = runtime()
            .block_on(axum::body::to_bytes(zip.into_body(), 16 * 1024 * 1024))
            .unwrap();
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(zip)).unwrap();
        let mut found = false;
        for i in 0..archive.len() {
            let mut f = archive.by_index(i).unwrap();
            if f.name().ends_with(".json") {
                let mut text = String::new();
                f.read_to_string(&mut text).unwrap();
                if text.contains("cast_self_test") {
                    found = true;
                    privacy(&text);
                }
            }
        }
        assert!(found, "diagnostic ZIP must include self-test JSON");
    }
    if matches!(name, "cancel" | "handoff" | "finish") {
        assert!(receiver.state.lock().unwrap().releases > 0);
        assert_eq!(result["metadata"]["cancelled"], name == "cancel");
    }
    value
}

fn privacy(text: &str) {
    use base64::{
        Engine,
        engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    };
    for secret in [
        "127.0.0.1",
        "127.0.0.2",
        "uuid:cast-fixture",
        "test-secret-token",
        "test-place",
        "test-bill",
        "Test Room",
        "projection_url",
        "conn.dolphinstar.cn",
    ] {
        for encoded in [
            secret.to_owned(),
            STANDARD.encode(secret),
            URL_SAFE_NO_PAD.encode(secret),
            url::form_urlencoded::byte_serialize(secret.as_bytes()).collect(),
        ] {
            assert!(!text.contains(&encoded), "report leaked {secret}");
        }
    }
}

#[test]
#[ignore = "requires trusted BILIKARA_TEST_CAST_COMPANION; real T3 mux + loopback receiver"]
fn self_test_success_and_decision_rows_one_to_five() {
    for (name, row) in [
        ("success", 1),
        ("no_udn", 1),
        ("live_only", 2),
        ("uniform_file", 3),
        ("uniform_live", 4),
        ("mp4", 5),
        ("decode", 6),
    ] {
        let report = scenario(name);
        assert_eq!(
            report["cast_self_test"]["conclusion"]["decision_row"], row,
            "{name}: {report}"
        );
    }
}
#[test]
#[ignore = "requires trusted BILIKARA_TEST_CAST_COMPANION; real T3 mux + loopback receiver"]
fn self_test_control_failures_are_independent_and_reports_complete() {
    for (name, row) in [
        ("stop_fault", 1),
        ("set_fault", 9),
        ("play_fault", 9),
        ("empty", 12),
        ("registration_rejected", 1),
    ] {
        let report = scenario(name);
        assert_eq!(
            report["cast_self_test"]["conclusion"]["decision_row"], row,
            "{name}: {report}"
        );
        if name == "registration_rejected" {
            assert!(
                report
                    .to_string()
                    .contains("cast_purek_authorization_rejected")
            );
        }
    }
}
#[test]
#[ignore = "requires trusted BILIKARA_TEST_CAST_COMPANION; real T3 mux + loopback receiver"]
fn self_test_missing_bad_samples_and_unanswered_continue() {
    for name in [
        "bad_a",
        "bad_audio",
        "no_cache",
        "bad_b",
        "no_sample_root",
        "missing_b",
        "unanswered",
    ] {
        let report = scenario(name);
        let cells = report["cast_self_test"]["cells"].as_array().unwrap();
        if name == "bad_b" {
            assert_eq!(cells[1]["skip_reason"], "sample_integrity_failed");
            assert_eq!(cells[3]["skip_reason"], "sample_integrity_failed");
        }
        if matches!(name, "no_sample_root" | "missing_b") {
            assert_eq!(cells[1]["skip_reason"], "sample_unavailable");
            assert_eq!(cells[3]["skip_reason"], "sample_unavailable");
        }
        if matches!(name, "bad_a" | "bad_audio" | "no_cache") {
            assert!(!cells[0]["skip_reason"].is_null());
            assert!(!cells[2]["skip_reason"].is_null());
        }
        if name == "unanswered" {
            assert!(cells.iter().all(|c| c["skip_reason"].is_null()));
            assert!(
                cells
                    .iter()
                    .all(|c| c["user_answers"]["video"] == "unanswered")
            );
            assert!(report["cast_self_test"]["conclusion"]["learned_mode"].is_null());
        }
    }
}

#[test]
#[ignore = "requires trusted BILIKARA_TEST_CAST_COMPANION; real mux and simulated receiver"]
fn android_sample_assets_lifecycle_and_b_only_failures() {
    use crate::cast_samples::{self, SamplePlatform};
    use crate::dlna::diagnostics::SkipReason;
    use std::sync::atomic::AtomicUsize;
    const CASE: &str = "BILIKARA_TEST_SAMPLE_ASSET_CASE";
    let Ok(case) = std::env::var(CASE) else {
        for case in [
            "ready",
            "no_space",
            "copy_failed",
            "absent",
            "corrupt",
            "cancel",
        ] {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    &format!(
                        "{}::android_sample_assets_lifecycle_and_b_only_failures",
                        module_path!().split_once("::").unwrap().1
                    ),
                    "--ignored",
                    "--nocapture",
                ])
                .env(CASE, case)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{case}: {} {}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(
                String::from_utf8_lossy(&output.stdout).contains("1 passed"),
                "child test must execute: {case}"
            );
        }
        return;
    };
    struct Assets {
        root: PathBuf,
        case: String,
        cleaned: AtomicUsize,
    }
    impl SamplePlatform for Assets {
        fn root(&self) -> PathBuf {
            self.root.clone()
        }
        fn prepare(&self) -> Result<(), SkipReason> {
            match self.case.as_str() {
                "no_space" => return Err(SkipReason::SampleStorageInsufficient),
                "copy_failed" => {
                    std::fs::write(self.root.join("sample-b.ts.part"), b"partial").unwrap();
                    return Err(SkipReason::SampleCopyFailed);
                }
                "absent" => return Err(SkipReason::PlatformUnavailable),
                _ => {}
            }
            let mut bytes =
                include_bytes!("../../../../../resources/cast-samples/sample-b.ts").to_vec();
            if self.case == "corrupt" {
                bytes[100] ^= 1;
            }
            std::fs::write(self.root.join("sample-b.ts"), bytes).unwrap();
            Ok(())
        }
        fn cleanup(&self) {
            for name in ["sample-b.ts", "sample-b.ts.part"] {
                let _ = std::fs::remove_file(self.root.join(name));
            }
            self.cleaned.fetch_add(1, Ordering::SeqCst);
        }
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../.tmp")
        .join(format!("android-sample-{}", token().unwrap()));
    std::fs::create_dir_all(&root).unwrap();
    let assets = Arc::new(Assets {
        root: root.clone(),
        case: case.clone(),
        cleaned: AtomicUsize::new(0),
    });
    cast_samples::configure(assets.clone());
    let report = scenario(if case == "cancel" {
        "cancel"
    } else {
        "success"
    });
    let cells = report["cast_self_test"]["cells"].as_array().unwrap();
    let reason = match case.as_str() {
        "no_space" => Some("sample_storage_insufficient"),
        "copy_failed" => Some("sample_copy_failed"),
        "absent" => Some("platform_unavailable"),
        "corrupt" => Some("sample_integrity_failed"),
        _ => None,
    };
    if case != "cancel" {
        for (index, cell) in cells.iter().take(4).enumerate() {
            if let Some(reason) = reason.filter(|_| index % 2 == 1) {
                assert_eq!(cell["skip_reason"], reason);
            } else {
                assert!(
                    cell["skip_reason"].is_null(),
                    "A must remain available: {cell}"
                );
                assert!(cell["http"]["get"].as_u64().unwrap() > 0);
            }
        }
    }
    assert_eq!(assets.cleaned.load(Ordering::SeqCst), 1);
    assert!(std::fs::read_dir(&root).unwrap().next().is_none());
    if case == "absent" {
        let host = Host::new();
        let result = runtime().block_on(super::pipeline::run(
            host.context.clone(),
            &CancellationToken::new(),
        ));
        assert_eq!(result["code"], "cast_sample_not_integrated");
        assert_eq!(assets.cleaned.load(Ordering::SeqCst), 2);
    }
    std::fs::remove_dir(root).unwrap();
}
#[test]
#[ignore = "requires trusted BILIKARA_TEST_CAST_COMPANION; real T3 mux + loopback receiver"]
fn self_test_pull_observations_preserve_peer_and_concurrency_facts() {
    for name in ["no_pull", "different_peer", "concurrent"] {
        let report = scenario(name);
        let cells = report["cast_self_test"]["cells"].as_array().unwrap();
        if name == "no_pull" {
            assert!(cells.iter().all(|c| c["http"]["get"] == 0));
            assert_eq!(report["cast_self_test"]["conclusion"]["decision_row"], 7);
        }
        if name == "different_peer" {
            assert_eq!(
                cells[1]["observations"]["source_matches_description"],
                false
            );
            assert!(cells[1]["observations"]["source_same_subnet_24"].is_null());
        }
        if name == "concurrent" {
            assert!(
                cells[1]["observations"]["over_client_limit"]
                    .as_u64()
                    .unwrap()
                    >= 1
            );
            assert!(cells[1]["observations"]["last_byte_ms"].as_u64().unwrap() > 0);
            assert!(
                cells[1]["observations"]["maximum_concurrent_get"]
                    .as_u64()
                    .unwrap()
                    >= 2
            );
        }
    }
}
#[test]
#[ignore = "requires trusted BILIKARA_TEST_CAST_COMPANION; real T3 mux + loopback receiver"]
fn self_test_cancel_awaits_revocation_within_three_seconds() {
    scenario("cancel");
}

#[test]
#[ignore = "requires trusted BILIKARA_TEST_CAST_COMPANION; real T3 mux + loopback receiver"]
fn self_test_handoff_keeps_registration_until_normal_session_ends() {
    scenario("handoff");
    scenario("finish");
}

#[test]
#[ignore = "requires trusted BILIKARA_TEST_CAST_COMPANION; real T3 mux + loopback receiver"]
fn self_test_long_original_is_recorded_once_with_twenty_second_bound() {
    scenario("long_a");
}

#[test]
#[ignore = "requires trusted BILIKARA_TEST_CAST_COMPANION; real T3 mux + loopback receiver"]
fn self_test_file_a_is_vbr_and_live_a_retains_cbr_without_another_merge() {
    let _serial = GLOBAL_APP_TEST_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let host = Host::new();
    runtime().block_on(self_test::tests::file_sample_is_vbr(host.context.clone()));
}

// Regression for R1 M3: enter the production route and worker, never tests::run.
#[test]
#[ignore = "requires trusted BILIKARA_TEST_CAST_COMPANION; production S0-S7 timing and real T3/T4"]
fn self_test_start_api_freezes_report_before_handoff_playback() {
    let _serial = GLOBAL_APP_TEST_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    assert!(std::env::var_os("BILIKARA_TEST_CAST_COMPANION").is_some());
    let host = Host::new();
    host.use_long_media();
    let receiver = Receiver::new();
    // The existing prepare route owns the QR; start accepts no credential input.
    host.post("/api/purek/prepare", json!({"qr_url":receiver.qr()}))
        .unwrap();
    // Discovery reports the prepared room's own description location; start
    // attaches the room credential only to that device row.
    let location = with_app(|app| {
        Ok(app
            .native()
            .cast
            .room
            .as_ref()
            .unwrap()
            .description
            .to_string())
    })
    .unwrap();
    let description = reqwest::blocking::get(&location).unwrap().text().unwrap();
    let renderer = crate::dlna::session_fixture::renderer(&location, &description);
    let key = renderer_key(&renderer);
    with_app(|app| {
        app.native().cast.renderers = vec![renderer];
        Ok(())
    })
    .unwrap();
    let accepted = host
        .post(
            "/api/cast/self-test/start",
            json!({"generation":0,"device_key":key}),
        )
        .unwrap();
    assert_eq!(accepted["generation"], 1);
    assert_eq!(
        host.post("/api/cast/self-test/start", json!({"generation":0}))
            .unwrap_err()
            .code,
        "cast_self_test_stale"
    );
    let deadline = Instant::now() + Duration::from_secs(180);
    let mut answered = std::collections::HashSet::new();
    loop {
        assert!(
            Instant::now() < deadline,
            "production self-test failed to reach handoff"
        );
        let snapshot = host.snapshot();
        let state = &snapshot["cast"]["self_test"];
        if state["handoff_available"] == true {
            break;
        }
        assert_eq!(
            state["running"], true,
            "self-test ended before handoff: {state}"
        );
        if state["question"] == true && answered.insert(state["question_id"].as_u64().unwrap()) {
            host.post(
                "/api/cast/self-test/answer",
                json!({"generation":1,"question_id":state["question_id"],"cell":state["cell"],
                "answers":{"video":"normal","audio":"yes","synchronized":"yes"}}),
            )
            .unwrap();
        }
        thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(answered.len(), 4, "all four matrix cells must execute");
    host.post(
        "/api/cast/self-test/handoff",
        json!({"generation":1,"start_casting":true}),
    )
    .unwrap();
    let snapshot =
        host.wait(|s| s["cast"]["phase"] == "active" && s["cast"]["self_test"]["running"] == false);
    assert_eq!(snapshot["cast"]["connected"], true);
    assert_eq!(snapshot["cast"]["owns_playback"], true);
    // N4: the tested device is the prepared room, so its credential stays.
    assert!(
        with_app(|app| Ok(app
            .native()
            .cast
            .room
            .as_ref()
            .unwrap()
            .authorization
            .is_some()))
        .unwrap()
    );
    assert_eq!(snapshot["cast"]["self_test"]["report_available"], true);
    let report = api::dispatch(
        &host.context,
        &host.identity,
        true,
        &Method::GET,
        "/api/cast/self-test/report",
        "",
        json!({}),
    )
    .unwrap();
    let metadata = &report["diagnostics"]["cast_self_test"]["metadata"];
    assert!(
        metadata["finished_at"].is_string(),
        "M3: production complete() must freeze the report before handoff"
    );
    assert_eq!(metadata["cancelled"], false);
    assert_eq!(receiver.state.lock().unwrap().releases, 0);
    assert_eq!(
        receiver
            .state
            .lock()
            .unwrap()
            .actions
            .iter()
            .filter(|a| a.as_str() == "SetDeviceAuthorization")
            .count(),
        1
    );
    privacy(&report.to_string());
    host.post("/api/cast/disconnect", json!({})).unwrap();
    host.wait(|s| s["cast"]["phase"] == "idle" && s["cast"]["owns_playback"] == false);
    let after = api::dispatch(
        &host.context,
        &host.identity,
        true,
        &Method::GET,
        "/api/cast/self-test/report",
        "",
        json!({}),
    )
    .unwrap();
    assert_eq!(
        after, report,
        "ordinary playback cancellation must not alter the completed self-test"
    );
    assert_eq!(receiver.state.lock().unwrap().releases, 1);
}

#[test]
fn self_test_start_rejects_stale_generation_and_second_authorization_input() {
    let _serial = GLOBAL_APP_TEST_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let host = Host::new();
    assert_eq!(
        host.post("/api/cast/self-test/start", json!({"generation":1}))
            .unwrap_err()
            .code,
        "cast_self_test_stale"
    );
    assert!(
        host.post(
            "/api/cast/self-test/start",
            json!({"generation":0,"purek_qr":"secret"})
        )
        .is_err()
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
            "/api/cast/self-test/start",
            "",
            json!({"generation":0})
        )
        .is_err()
    );
    assert_eq!(
        with_app(|app| Ok(app.native().cast.self_test.generation)).unwrap(),
        0
    );
}

/// Enable=1 registrations; the fixture logs Enable=0 releases as the same action.
fn registrations(receiver: &Receiver) -> usize {
    let state = receiver.state.lock().unwrap();
    state
        .actions
        .iter()
        .filter(|a| a.as_str() == "SetDeviceAuthorization")
        .count()
        - state.releases
}

fn wait_long(host: &Host, what: &str, predicate: impl Fn(&Value) -> bool) -> Value {
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        let snapshot = host.snapshot();
        if predicate(&snapshot) {
            return snapshot;
        }
        assert!(Instant::now() < deadline, "{what}: {}", snapshot["cast"]);
        thread::sleep(Duration::from_millis(20));
    }
}

fn room_renderer() -> Renderer {
    let location = with_app(|app| {
        Ok(app
            .native()
            .cast
            .room
            .as_ref()
            .unwrap()
            .description
            .to_string())
    })
    .unwrap();
    let description = reqwest::blocking::get(&location).unwrap().text().unwrap();
    crate::dlna::session_fixture::renderer(&location, &description)
}

// P10 review B1: the Host UI order is prepare/connect -> disconnect -> start.
// The disconnect must still revoke the ordinary registration, while the
// self-test keeps the prepared room and performs its own Pure K S2/S3.
#[test]
#[ignore = "requires trusted BILIKARA_TEST_CAST_COMPANION; production self-test runner"]
fn self_test_ui_order_disconnect_revokes_session_but_keeps_room_for_purek_test() {
    let _serial = GLOBAL_APP_TEST_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    assert!(std::env::var_os("BILIKARA_TEST_CAST_COMPANION").is_some());
    let host = Host::new();
    host.use_long_media();
    let receiver = Receiver::new();
    host.post("/api/purek/prepare", json!({"qr_url":receiver.qr()}))
        .unwrap();
    host.post("/api/cast/connect", json!({})).unwrap();
    host.wait(|s| s["cast"]["phase"] == "active" && s["cast"]["connected"] == true);
    assert_eq!(registrations(&receiver), 1);
    // static/cast-self-test.js: closePhysical(); disconnect({retain_room:true}); start.
    host.post("/api/cast/disconnect", json!({"retain_room":true}))
        .unwrap();
    host.wait(|s| {
        s["cast"]["phase"] == "idle"
            && s["cast"]["connected"] == false
            && s["cast"]["owns_playback"] == false
    });
    assert_eq!(
        receiver.state.lock().unwrap().releases,
        1,
        "disconnect must still revoke the ordinary session registration"
    );
    let renderer = room_renderer();
    let key = renderer_key(&renderer);
    with_app(|app| {
        app.native().cast.renderers = vec![renderer];
        Ok(())
    })
    .unwrap();
    let generation = host.snapshot()["cast"]["self_test"]["generation"]
        .as_u64()
        .unwrap();
    host.post(
        "/api/cast/self-test/start",
        json!({"generation":generation,"device_key":key}),
    )
    .unwrap();
    let generation = generation + 1;
    assert_eq!(
        host.snapshot()["cast"]["self_test"]["purek_room_unmatched"],
        false
    );
    wait_long(&host, "self-test Pure K registration", |s| {
        s["cast"]["self_test"]["registration_attempted"] == true
    });
    assert_eq!(host.snapshot()["cast"]["self_test"]["registered"], true);
    assert_eq!(registrations(&receiver), 2);
    host.post(
        "/api/cast/self-test/cancel",
        json!({"generation":generation}),
    )
    .unwrap();
    wait_long(&host, "self-test cancellation", |s| {
        s["cast"]["self_test"]["running"] == false && s["cast"]["owns_playback"] == false
    });
    assert_eq!(receiver.state.lock().unwrap().releases, 2);
    let report = api::dispatch(
        &host.context,
        &host.identity,
        true,
        &Method::GET,
        "/api/cast/self-test/report",
        "",
        json!({}),
    )
    .unwrap();
    let test = &report["diagnostics"]["cast_self_test"];
    assert_eq!(test["metadata"]["target_kind"], "purek");
    assert_eq!(test["environment"]["purek_room_unmatched"], false);
    privacy(&report.to_string());
}

#[test]
fn disconnect_retains_only_an_authorized_room_and_only_on_request() {
    let _serial = GLOBAL_APP_TEST_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let host = Host::new();
    let receiver = Receiver::new();
    let room = || with_app(|app| Ok(app.native().cast.room.is_some())).unwrap();
    let idle = |s: &Value| s["cast"]["phase"] == "idle" && s["cast"]["busy"] == false;
    // Ordinary disconnect keeps next's semantics: the prepared room is forgotten.
    host.post("/api/purek/prepare", json!({"qr_url":receiver.qr()}))
        .unwrap();
    host.post("/api/cast/disconnect", json!({})).unwrap();
    host.wait(idle);
    assert!(!room());
    for invalid in [json!("yes"), json!(1)] {
        host.post("/api/purek/prepare", json!({"qr_url":receiver.qr()}))
            .unwrap();
        assert!(
            host.post("/api/cast/disconnect", json!({"retain_room":invalid}))
                .is_err()
        );
        assert!(room());
        host.post("/api/cast/disconnect", json!({})).unwrap();
        host.wait(idle);
    }
    // The self-test request keeps the prepared Pure K credential.
    host.post("/api/purek/prepare", json!({"qr_url":receiver.qr()}))
        .unwrap();
    let before = host.snapshot()["purek"]["room_name"].clone();
    host.post("/api/cast/disconnect", json!({"retain_room":true}))
        .unwrap();
    host.wait(idle);
    assert!(room());
    assert_eq!(host.snapshot()["purek"]["room_name"], before);
    // A plain DLNA description is not a Pure K credential and is never kept.
    host.post(
        "/api/purek/prepare",
        json!({"url":format!("http://{}/description", receiver.address)}),
    )
    .unwrap();
    host.post("/api/cast/disconnect", json!({"retain_room":true}))
        .unwrap();
    host.wait(idle);
    assert!(!room());
    assert!(receiver.state.lock().unwrap().actions.is_empty());
}

// P10 review N1/N2/N4: a prepared Pure K room that is not the selected device
// is reported (never silently ignored), the Host output projection shows the
// probe instead of "stopping", and handoff leaves only the device it took over.
#[test]
#[ignore = "requires trusted BILIKARA_TEST_CAST_COMPANION; production S0-S7 timing and real T3/T4"]
fn self_test_unmatched_room_is_reported_and_handoff_owns_only_the_tested_device() {
    let _serial = GLOBAL_APP_TEST_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    assert!(std::env::var_os("BILIKARA_TEST_CAST_COMPANION").is_some());
    let host = Host::new();
    host.use_long_media();
    let receiver = Receiver::new();
    host.post("/api/purek/prepare", json!({"qr_url":receiver.qr()}))
        .unwrap();
    // A plain DLNA row on another description location.
    let renderer = receiver.renderer();
    let location = renderer.description.location.clone();
    let key = renderer_key(&renderer);
    with_app(|app| {
        app.native().cast.renderers = vec![renderer];
        Ok(())
    })
    .unwrap();
    host.post(
        "/api/cast/self-test/start",
        json!({"generation":0,"device_key":key}),
    )
    .unwrap();
    let snapshot = host.snapshot();
    assert_eq!(snapshot["cast"]["self_test"]["purek_room_unmatched"], true);
    let output = &snapshot["media_output"];
    assert_eq!(output["status"], "probing", "{output}");
    assert_eq!(output["target"], "purek");
    assert_eq!(output["requested_target"], "purek");
    assert_eq!(output["busy"], true);
    assert_eq!(output["desired_playing"], false);
    let deadline = Instant::now() + Duration::from_secs(180);
    let mut answered = std::collections::HashSet::new();
    loop {
        assert!(
            Instant::now() < deadline,
            "self-test failed to reach handoff"
        );
        let snapshot = host.snapshot();
        let state = &snapshot["cast"]["self_test"];
        if state["handoff_available"] == true {
            break;
        }
        assert_eq!(state["running"], true, "self-test ended early: {state}");
        assert_ne!(snapshot["media_output"]["status"], "stopping");
        if state["question"] == true && answered.insert(state["question_id"].as_u64().unwrap()) {
            host.post(
                "/api/cast/self-test/answer",
                json!({"generation":1,"question_id":state["question_id"],"cell":state["cell"],
                "answers":{"video":"normal","audio":"yes","synchronized":"yes"}}),
            )
            .unwrap();
        }
        thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(registrations(&receiver), 0, "the unmatched room is unused");
    host.post(
        "/api/cast/self-test/handoff",
        json!({"generation":1,"start_casting":true}),
    )
    .unwrap();
    let snapshot =
        host.wait(|s| s["cast"]["phase"] == "active" && s["cast"]["self_test"]["running"] == false);
    assert_ne!(snapshot["media_output"]["status"], "probing");
    let room = with_app(|app| {
        Ok(app
            .native()
            .cast
            .room
            .as_ref()
            .map(|room| (room.description.to_string(), room.authorization.is_some())))
    })
    .unwrap();
    assert_eq!(
        room,
        Some((location, false)),
        "N4: no unrelated Pure K room"
    );
    let report = api::dispatch(
        &host.context,
        &host.identity,
        true,
        &Method::GET,
        "/api/cast/self-test/report",
        "",
        json!({}),
    )
    .unwrap();
    let test = &report["diagnostics"]["cast_self_test"];
    assert_eq!(test["environment"]["purek_room_unmatched"], true);
    assert_ne!(test["metadata"]["target_kind"], "purek");
    privacy(&report.to_string());
    host.post("/api/cast/disconnect", json!({})).unwrap();
    host.wait(|s| s["cast"]["phase"] == "idle" && s["cast"]["owns_playback"] == false);
    assert_eq!(registrations(&receiver), 0);
}

// P10 review R2: "no device row (automatic discovery) + prepared Pure K room".
// The room credential is used without a target; the session supplies the
// renderer after registration. Loopback rooms select the test fixture.
#[test]
#[ignore = "requires trusted BILIKARA_TEST_CAST_COMPANION; production self-test runner"]
fn self_test_automatic_discovery_registers_the_prepared_purek_room() {
    let _serial = GLOBAL_APP_TEST_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    assert!(std::env::var_os("BILIKARA_TEST_CAST_COMPANION").is_some());
    let host = Host::new();
    host.use_long_media();
    let receiver = Receiver::new();
    host.post("/api/purek/prepare", json!({"qr_url":receiver.qr()}))
        .unwrap();
    with_app(|app| {
        app.native().cast.renderers.clear();
        Ok(())
    })
    .unwrap();
    host.post("/api/cast/self-test/start", json!({"generation":0}))
        .unwrap();
    assert_eq!(
        host.snapshot()["cast"]["self_test"]["purek_room_unmatched"],
        false
    );
    wait_long(&host, "automatic-discovery Pure K registration", |s| {
        s["cast"]["self_test"]["registration_attempted"] == true
    });
    assert_eq!(host.snapshot()["cast"]["self_test"]["registered"], true);
    assert_eq!(registrations(&receiver), 1);
    host.post("/api/cast/self-test/cancel", json!({"generation":1}))
        .unwrap();
    wait_long(&host, "self-test cancellation", |s| {
        s["cast"]["self_test"]["running"] == false && s["cast"]["owns_playback"] == false
    });
    assert_eq!(receiver.state.lock().unwrap().releases, 1);
    let report = api::dispatch(
        &host.context,
        &host.identity,
        true,
        &Method::GET,
        "/api/cast/self-test/report",
        "",
        json!({}),
    )
    .unwrap();
    let test = &report["diagnostics"]["cast_self_test"];
    assert_eq!(test["metadata"]["target_kind"], "purek");
    assert_eq!(test["environment"]["purek_room_unmatched"], false);
    privacy(&report.to_string());
}

// P10 review R2: pipeline::start (R1 link check inside next's pipeline test)
// runs once while the local pipeline test owns playback, publishes a URL-free
// result, cancels when that output stops, and never overlaps the self-test.
#[test]
#[ignore = "requires trusted BILIKARA_TEST_CAST_COMPANION; real T3 mux + T4 loopback"]
fn pipeline_check_runs_once_reports_sample_b_and_cancels_with_local_output() {
    let _serial = GLOBAL_APP_TEST_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    assert!(std::env::var_os("BILIKARA_TEST_CAST_COMPANION").is_some());
    let host = Host::new();
    host.use_long_media();
    let owns_local = |value: bool| {
        with_app(|app| {
            app.native().local_output.controller.owns_playback = value;
            Ok(())
        })
        .unwrap()
    };
    owns_local(true);
    // A Host that never cast has no cast projection until the check runs.
    assert_eq!(host.snapshot()["cast"], Value::Null);
    super::super::pipeline::start(&host.context).unwrap();
    let running = host.snapshot();
    assert_eq!(running["cast"]["pipeline_running"], true);
    assert_eq!(running["cast"]["busy"], true);
    assert_eq!(running["cast"]["pipeline_result"], Value::Null);
    // A second request while running does not start another check.
    super::super::pipeline::start(&host.context).unwrap();
    let done = wait_long(&host, "pipeline check", |s| {
        s["cast"]["pipeline_running"] == false
    });
    assert_eq!(
        done["cast"]["pipeline_result"],
        json!({"ok":true,"first_byte":true,"sample_b":"verified"})
    );
    assert_eq!(
        done["cast"]["operation_id"], 0,
        "the check is not a cast operation"
    );
    assert!(!done["cast"]["pipeline_result"].to_string().contains("http"));
    // Stopping the local pipeline test cancels the check.
    super::super::pipeline::start(&host.context).unwrap();
    assert_eq!(host.snapshot()["cast"]["pipeline_result"], Value::Null);
    owns_local(false);
    let cancelled = wait_long(&host, "pipeline cancellation", |s| {
        s["cast"]["pipeline_running"] == false
    });
    assert_eq!(cancelled["cast"]["pipeline_result"]["ok"], false);
    assert_eq!(
        cancelled["cast"]["pipeline_result"]["code"],
        "cast_cancelled"
    );
    // It never overlaps a running compatibility test.
    owns_local(true);
    with_app(|app| {
        app.native().cast.self_test.running = true;
        Ok(())
    })
    .unwrap();
    super::super::pipeline::start(&host.context).unwrap();
    assert_eq!(host.snapshot()["cast"]["pipeline_running"], false);
    with_app(|app| {
        app.native().cast.self_test.running = false;
        app.native().local_output.controller.owns_playback = false;
        Ok(())
    })
    .unwrap();
}
