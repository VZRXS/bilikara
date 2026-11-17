use super::*;
use crate::dlna::{
    DiscoverySource, DlnaError, cast_http, dlna_policy::PolicyError, test_support::*,
};
use crate::experimental_libav::cast_mux::CastStart;
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use std::{
    io::{Cursor, Read},
    sync::Arc,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

mod identification;
mod review;

fn trace(capacity: usize) -> SessionTrace {
    SessionTrace::with_capacity(
        Platform::Windows,
        TargetKind::Purek,
        "0.8.0",
        "11.0",
        capacity,
    )
    .unwrap()
}
fn context() -> DeviceContext {
    DeviceContext {
        device_key: "unsalted-enumerable-url-digest".into(),
        udn_hash: Some("unsalted-udn-digest".into()),
        source: DiscoverySource::SearchResponse,
        server: "fixture".into(),
        route: None,
    }
}
fn stage(action: Stage, result: Result<(), DlnaError>) -> StageResult {
    StageResult {
        stage: action,
        attempt: 1,
        elapsed: Duration::from_millis(4),
        http_status: result
            .as_ref()
            .err()
            .and_then(|e| e.http_status)
            .or(Some(200)),
        result,
        disposition: Disposition::Applied,
        nonconforming_body: None,
        context: Some(context()),
    }
}
fn config(cell: Option<Cell>) -> OutputConfig {
    OutputConfig {
        cell,
        mode: Mode::File,
        mime: Mime::Ts,
        preflight: MediaPreflight::default(),
    }
}
fn http(stage: cast_http::HttpStage) -> HttpStageResult {
    HttpStageResult {
        stage,
        context: context(),
        generation: Some(1),
        connection_id: 1,
        elapsed: Duration::from_millis(20),
        http_status: Some(200),
        result: Ok(()),
        bytes_written: 0,
        disconnect_reason: None,
        media_time_us: None,
        live_start: None,
    }
}
fn output<'a>(r: &'a Report, name: &str) -> &'a Value {
    &r.diagnostics()["cast"][name]
}

#[test]
fn output_stage_separates_preparation_control_request_and_delivery() {
    use cast_http::HttpStage as H;
    let t = trace(512);
    let id = t.begin_output(&context(), config(None));
    assert_eq!(output(&t.report(), "output")["stage"], "starting");
    t.complete_output(id, UserAnswers::default());
    assert_eq!(output(&t.report(), "output")["stage"], "before_play");
    for (failure, code) in [
        (Failure::UnsupportedCodec, "cast_media_unsupported_codec"),
        (Failure::PrepareFailed, "cast_media_prepare_failed"),
        (Failure::BackendUnavailable, "cast_backend_unavailable"),
    ] {
        let id = t.begin_output(&context(), config(None));
        t.failure(id, failure);
        let r = t.report();
        assert_eq!(output(&r, "output")["stage"], "media_preparation");
        assert_eq!(output(&r, "output")["code"], code);
    }
    let id = t.begin_output(&context(), config(None));
    let mut stop = stage(
        Stage::Action(SoapAction::Stop),
        Err(DlnaError::from(PolicyError::SoapFault(Some(701)))),
    );
    stop.disposition = Disposition::Ignored;
    t.record_stage_at(None, Some(id), Duration::ZERO, &stop);
    assert!(output(&t.report(), "output")["code"].is_null());
    let set = stage(
        Stage::Action(SoapAction::SetAVTransportURI),
        Err(DlnaError::from(PolicyError::SoapFault(Some(714)))),
    );
    t.record_stage_at(None, Some(id), Duration::ZERO, &set);
    assert_eq!(output(&t.report(), "output")["stage"], "control");
    assert_eq!(output(&t.report(), "output")["code"], "cast_control_fault");
    t.record_stage_at(
        None,
        Some(id),
        Duration::ZERO,
        &stage(Stage::Action(SoapAction::Play), Ok(())),
    );
    assert_eq!(
        output(&t.report_at(Duration::from_secs(9)), "output")["code"],
        Value::Null
    );
    assert_eq!(
        output(&t.report_at(Duration::from_secs(10)), "output")["code"],
        "cast_not_requested"
    );
    t.http_at(id, Duration::from_secs(10), &http(H::Get));
    assert_eq!(
        output(&t.report_at(Duration::from_secs(19)), "output")["stage"],
        "request_rejected_or_interrupted"
    );
    assert_eq!(
        output(&t.report_at(Duration::from_secs(20)), "output")["code"],
        "cast_no_delivery"
    );
    t.http_at(id, Duration::from_secs(20), &http(H::FirstByte));
    assert_eq!(
        output(&t.report(), "output")["stage"],
        "delivered_unverified"
    );
    t.failure(id, Failure::Interrupted);
    assert_eq!(output(&t.report(), "output")["stage"], "transport_stopped");
    let id = t.begin_output(&context(), config(None));
    t.failure(id, Failure::PipelineFailed);
    assert_eq!(output(&t.report(), "output")["stage"], "media_preparation");
    let id = t.begin_output(&context(), config(None));
    t.first_ts_packet(id);
    t.failure(id, Failure::PipelineFailed);
    assert_eq!(output(&t.report(), "output")["stage"], "media_pipeline");
    let id = t.begin_output(&context(), config(None));
    t.record_stage_at(
        None,
        Some(id),
        Duration::ZERO,
        &stage(Stage::Action(SoapAction::Play), Ok(())),
    );
    let mut rejected = http(H::Rejected);
    rejected.result = Err(Reason::PublicPeer);
    t.http_at(id, Duration::ZERO, &rejected);
    assert_eq!(
        output(&t.report(), "output")["code"],
        "cast_request_rejected"
    );
}

#[test]
fn export_redacts_all_untrusted_text_and_resalts_every_identifier() {
    let forbidden = [
        "capability-0123456789abcdef",
        "purek-token+a/b=Secret",
        "192.168.31.86",
        "uuid:8b8931b8-0f54-4562-924d-0269a14d270f",
        "AA:BB:CC:DD:EE:FF",
        "PrivateUserKevin",
        r"C:\Users\PrivateUserKevin\Media\video.mp4",
        "room-private-889",
        "bill-private-777",
    ];
    let hostile = forbidden.join(" ");
    let fixture = Fixture::start(vec![]);
    let mut r = fixture.renderer();
    fixture.join();
    // Empty fixture completes immediately; no application I/O for these inputs.
    r.context.device_key = hostile.clone();
    r.context.udn_hash = Some(hostile.clone());
    r.context.server = hostile.clone();
    r.description.name = hostile.clone();
    r.description.manufacturer = hostile.clone();
    r.description.model_name = hostile.clone();
    r.description.model_description = hostile.clone();
    r.description.id = hostile.clone();
    r.description.location = "http://192.168.31.86:49152/desc?token=secret".into();
    let t = SessionTrace::new(Platform::Windows, TargetKind::Purek, &hostile, &hostile).unwrap();
    t.renderer(&r);
    let id = t.begin_output(&r.context, config(None));
    t.capabilities(
        id,
        ProtocolState::Reported,
        &[format!("http-get:*:video/MP2T:{hostile}")],
        true,
        false,
    );
    let c = t.begin_connection();
    let mut p = purek::PhaseResult {
        schema_version: 1,
        phase: purek::Phase::Register,
        stage: stage(Stage::Description, Ok(())),
        error_code: None,
        facts: purek::PhaseFacts::default(),
    };
    p.stage.context = Some(r.context.clone());
    p.facts.services = Some(purek::ServiceSummary {
        entries: vec![purek::ServiceSummaryEntry {
            kind: purek::ServiceKind::Other {
                salted_digest: hostile.clone(),
            },
            version: 1,
        }],
        advertised: 1,
        truncated: false,
    });
    t.purek(c, &p);
    let report = t.report();
    for value in &forbidden {
        assert!(!report.json().contains(value), "JSON leaked {value}");
        assert!(!report.text().contains(value), "text leaked {value}");
        assert!(
            !format!("{report:?}").contains(value),
            "Debug leaked {value}"
        );
    }
    let key = &report.diagnostics()["cast"]["devices"][0]["device"]["device_key"];
    assert_eq!(key, &report.diagnostics()["cast"]["output"]["device"]);
    assert_eq!(
        key,
        &t.report().diagnostics()["cast"]["devices"][0]["device"]["device_key"]
    );
    let other = trace(512);
    other.renderer(&r);
    assert_ne!(
        key,
        &other.report().diagnostics()["cast"]["devices"][0]["device"]["device_key"]
    );
    assert_ne!(
        report.diagnostics()["cast"]["devices"][0]["device"]["udn_hash"],
        other.report().diagnostics()["cast"]["devices"][0]["device"]["udn_hash"]
    );
}

#[test]
fn metadata_is_unicode_bounded_and_controls_are_removed_before_retention() {
    let p = Privacy::new().unwrap();
    let a = p.metadata(&format!("\0\n\r{}", "電🎤".repeat(200)), 256);
    assert_eq!(a.characters, 256);
    assert!(a.truncated && a.controls_removed);
    assert_eq!(a.digest, p.metadata(&"電🎤".repeat(128), 256).digest);
    let short = p.metadata("短\t名", 256);
    assert_eq!(short.characters, 2);
    assert!(!short.truncated);
    assert_eq!(short.digest, p.metadata("短名", 256).digest);
    assert_eq!(p.metadata(&"名".repeat(300), 64).characters, 64);
}

#[test]
fn no_usn_keys_are_session_hmacs_and_metadata_limits_apply_at_boundary() {
    let fixture = Fixture::start(vec![]);
    let mut r = fixture.renderer();
    fixture.join();
    r.context.udn_hash = None;
    r.description.name = format!("\n{}", "房🎤".repeat(200));
    r.description.model_name = format!("\0{}", "型🎤".repeat(200));
    r.description.manufacturer = r.description.model_name.clone();
    r.description.model_description = r.description.model_name.clone();
    r.context.server = r.description.model_name.clone();
    let t = trace(20);
    t.renderer(&r);
    let id = t.begin_output(&r.context, config(None));
    let first = t.report();
    let device = &first.diagnostics()["cast"]["devices"][0]["device"];
    assert_eq!(device["friendly_name"]["characters"], 64);
    for field in ["manufacturer", "model_name", "model_description", "server"] {
        assert_eq!(device[field]["characters"], 256);
        assert_eq!(device[field]["controls_removed"], true);
        assert_eq!(device[field]["truncated"], true);
    }
    let key = &device["device_key"];
    assert_eq!(key, &output(&first, "output")["device"]);
    assert_ne!(key, &r.context.device_key);
    assert!(device["udn_hash"].is_null());
    assert_eq!(
        key,
        &t.report().diagnostics()["cast"]["devices"][0]["device"]["device_key"]
    );
    let other = trace(20);
    other.renderer(&r);
    assert_ne!(
        key,
        &other.report().diagnostics()["cast"]["devices"][0]["device"]["device_key"]
    );
    assert!(id > 0);
    // A version-shaped IP must not bypass the text-free boundary.
    let t = SessionTrace::new(
        Platform::Windows,
        TargetKind::Generic,
        "192.168.31.86",
        "192.168.31.86",
    )
    .unwrap();
    assert!(!t.report().json().contains("192.168.31.86"));
    assert_eq!(
        privacy::version("0.8.0-preview.2"),
        Some("0.8.0-preview.2".into())
    );
    assert!(privacy::version("0.8.0-PrivateUserKevin.2").is_none());
}

#[test]
fn http_disconnect_categories_and_dts_basis_are_preserved_without_guessing_reset() {
    use cast_http::HttpStage as H;
    for (reason, interrupted) in [
        (Reason::Completed, false),
        (Reason::Cancelled, false),
        (Reason::GenerationEnded, false),
        (Reason::Replaced, false),
        (Reason::WriteStall, true),
        (Reason::PeerClosed, true),
        (Reason::WriteError, true),
        (Reason::ReadError, true),
    ] {
        let t = trace(20);
        let id = t.begin_output(&context(), config(None));
        t.record_stage_at(
            None,
            Some(id),
            Duration::ZERO,
            &stage(Stage::Action(SoapAction::Play), Ok(())),
        );
        t.http_at(id, Duration::from_millis(1), &http(H::Get));
        let mut first = http(H::FirstByte);
        first.bytes_written = 100;
        t.http_at(id, Duration::from_millis(2), &first);
        assert_eq!(output(&t.report(), "output")["bytes_written"], 100);
        let mut written = http(H::BytesWritten);
        written.bytes_written = 188;
        t.http_at(id, Duration::from_millis(3), &written);
        let mut end = http(H::Disconnect);
        end.disconnect_reason = Some(reason);
        t.http_at(id, Duration::from_millis(4), &end);
        let r = t.report();
        let o = output(&r, "output");
        assert_eq!(o["disconnects"][0], reason.as_str());
        assert_eq!(
            o["code"],
            if interrupted {
                json!("cast_interrupted")
            } else {
                Value::Null
            }
        );
        assert!(o["observations"]["last_byte_ms"].is_null());
        assert_eq!(o["bytes_observed_ms"], 3);
        assert_eq!(o["bytes_written"], 188);
        assert!(!r.json().contains("\"reset\""));
    }
    let t = trace(20);
    let id = t.begin_output(&context(), config(None));
    let mut h = http(H::LiveJump);
    h.media_time_us = Some(-66_667);
    h.live_start = Some(CastStart {
        source_start_us: 2_000_000,
        timestamp_origin_us: 1_933_333,
        profile: 100,
        level: 40,
        width: 1920,
        height: 1080,
        has_b_frames: true,
        audio_transcoded: false,
    });
    t.http_at(id, Duration::ZERO, &h);
    assert_eq!(output(&t.report(), "output")["last_media_time_us"], -66_667);
    assert_eq!(
        output(&t.report(), "output")["live_start"]["timestamp_origin_us"],
        1_933_333
    );
}

#[test]
fn broadcast_lag_and_cancel_drain_are_explicit() {
    run(async {
        let t = trace(30);
        let id = t.begin_output(&context(), config(None));
        let (sender, mut receiver) = tokio::sync::broadcast::channel(2);
        for _ in 0..5 {
            sender.send(http(cast_http::HttpStage::Head)).unwrap();
        }
        let cancel = super::super::CancellationToken::new();
        cancel.cancel();
        t.receive_http(id, Duration::from_millis(500), &mut receiver, &cancel)
            .await;
        let r = t.report();
        assert_eq!(r.diagnostics()["cast"]["delivery_lagged_stages"], 3);
        assert_eq!(output(&r, "output")["http"]["head"], 2);
        assert_eq!(r.diagnostics()["cast"]["stages"][0]["at_ms"], 520);
        assert!(r.diagnostics()["cast"]["stages"][0]["elapsed_ms"].is_null());
    });
}

#[test]
fn zero_capacity_preserves_aggregate_facts_and_bounds_actions_and_devices() {
    let t = trace(0);
    let id = t.begin_output(&context(), config(None));
    for _ in 0..100 {
        t.record_stage_at(
            None,
            Some(id),
            Duration::ZERO,
            &stage(Stage::Action(SoapAction::Play), Ok(())),
        );
        t.http_at(id, Duration::ZERO, &http(cast_http::HttpStage::Head));
    }
    let r = t.report();
    assert_eq!(r.diagnostics()["cast"]["dropped_stages"], 200);
    assert_eq!(
        output(&r, "output")["actions"].as_array().unwrap().len(),
        24
    );
    assert_eq!(output(&r, "output")["dropped_actions"], 76);
    assert_eq!(output(&r, "output")["http"]["head"], 100);
    for i in 0..150 {
        let mut e = stage(Stage::Description, Ok(()));
        e.context.as_mut().unwrap().device_key = i.to_string();
        t.record_stage_at(None, None, Duration::ZERO, &e);
    }
    let r = t.report();
    assert_eq!(
        r.diagnostics()["cast"]["devices"].as_array().unwrap().len(),
        128
    );
    assert_eq!(r.diagnostics()["cast"]["dropped_devices"], 23);
}

#[test]
fn matrix_cells_survive_output_rotation_and_choose_first_matching_decision() {
    let cells = [
        Cell::FileA,
        Cell::FileB,
        Cell::LiveA,
        Cell::LiveB,
        Cell::FileMp4A,
    ];
    for (winner, row) in [
        (Cell::FileA, 1),
        (Cell::LiveA, 2),
        (Cell::FileB, 3),
        (Cell::LiveB, 4),
        (Cell::FileMp4A, 5),
    ] {
        let t = trace(20);
        for cell in cells {
            let id = t.begin_output(&context(), config(Some(cell)));
            t.complete_output(
                id,
                if cell == winner {
                    UserAnswers {
                        video: VideoAnswer::Normal,
                        audio: Answer::Yes,
                        synchronized: Answer::Yes,
                    }
                } else {
                    UserAnswers {
                        video: VideoAnswer::Black,
                        audio: Answer::No,
                        synchronized: Answer::Unanswered,
                    }
                },
            );
        }
        let r = t.report();
        let st = &r.diagnostics()["cast_self_test"];
        assert_eq!(st["cells"].as_array().unwrap().len(), 5);
        assert_eq!(st["conclusion"]["decision_row"], row);
        for cell in st["cells"].as_array().unwrap() {
            for key in [
                "cell",
                "actions",
                "empty_metadata_retry",
                "http",
                "observations",
                "bytes_written",
                "first_byte_ms",
                "disconnects",
                "transport_states",
                "position_advanced",
                "stage",
                "code",
                "user_answers",
            ] {
                assert!(cell.get(key).is_some(), "missing cell field {key}");
            }
        }
        assert_eq!(r.diagnostics()["cast"]["dropped_outputs"], 3);
    }
    let t = trace(20);
    let id = t.begin_output(&context(), config(Some(Cell::FileA)));
    t.record_stage_at(
        None,
        Some(id),
        Duration::ZERO,
        &stage(Stage::Action(SoapAction::Play), Ok(())),
    );
    t.http_at(id, Duration::ZERO, &http(cast_http::HttpStage::FirstByte));
    t.complete_output(id, UserAnswers::default());
    assert!(t.report_at(Duration::from_secs(100)).diagnostics()["cast_self_test"]["conclusion"]["decision_row"].is_null());
}

#[test]
fn bounded_retention_counts_source_loss_and_sorts_concurrent_events() {
    let t = Arc::new(trace(7));
    let c = t.begin_connection();
    let mut workers = vec![];
    for i in 0..4 {
        let t = t.clone();
        workers.push(std::thread::spawn(move || {
            for n in 0..25 {
                t.record_stage_at(
                    Some(c),
                    None,
                    Duration::from_millis(100 - i * 25 - n),
                    &stage(Stage::Description, Ok(())),
                );
            }
        }));
    }
    for w in workers {
        w.join().unwrap();
    }
    for n in [1, 2, 2, 1, 5] {
        t.discovery(c, &DiscoveryUpdate::StagesDropped(n));
    }
    let r = t.report();
    let cast = &r.diagnostics()["cast"];
    assert_eq!(cast["stages"].as_array().unwrap().len(), 7);
    assert_eq!(cast["dropped_stages"], 93);
    assert_eq!(cast["source_dropped_stages"], 5);
    let times: Vec<_> = cast["stages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["at_ms"].as_u64().unwrap())
        .collect();
    assert!(times.windows(2).all(|w| w[0] <= w[1]));
    for _ in 0..10 {
        t.begin_connection();
        t.begin_output(&context(), config(None));
    }
    let r = t.report();
    assert_eq!(
        r.diagnostics()["cast"]["connections"]
            .as_array()
            .unwrap()
            .len(),
        6
    );
    assert_eq!(r.diagnostics()["cast"]["dropped_connections"], 5);
    assert_eq!(r.diagnostics()["cast"]["dropped_outputs"], 8);
}

#[test]
fn stable_codes_preserve_fault_status_retry_and_nonconforming_facts() {
    let t = trace(100);
    let id = t.begin_output(&context(), config(None));
    for (error, code) in [
        (ErrorCode::Timeout, "cast_control_unreachable"),
        (ErrorCode::Connect, "cast_control_unreachable"),
        (ErrorCode::HttpStatus, "cast_control_http"),
        (
            ErrorCode::Policy(PolicyError::SoapFault(Some(716))),
            "cast_control_fault",
        ),
    ] {
        let e = DlnaError {
            code: error,
            http_status: Some(500),
            upnp_code: Some(716),
        };
        t.record_stage_at(
            None,
            Some(id),
            Duration::ZERO,
            &stage(Stage::Action(SoapAction::Play), Err(e)),
        );
        assert_eq!(output(&t.report(), "output")["code"], code);
    }
    let mut retry = stage(Stage::Action(SoapAction::SetAVTransportURI), Ok(()));
    retry.attempt = 2;
    retry.nonconforming_body = Some(PolicyError::InvalidSoap);
    t.record_stage_at(None, Some(id), Duration::ZERO, &retry);
    assert_eq!(output(&t.report(), "output")["empty_metadata_retry"], true);
    let r = t.report();
    let actions = output(&r, "output")["actions"].as_array().unwrap();
    assert_eq!(actions[0]["http_status"], 500);
    assert_eq!(actions[0]["http_status_class"], 5);
    assert_eq!(actions[0]["upnp_code"], 716);
    assert_eq!(
        actions.last().unwrap()["nonconforming_body"],
        "invalid_soap"
    );
}

fn qr(location: &str) -> String {
    let mut inner = url::Url::parse("https://conn.dolphinstar.cn/Remote").unwrap();
    inner
        .query_pairs_mut()
        .append_pair("url", location)
        .append_pair("token", "purek-token+a/b=Secret")
        .append_pair("name", "PrivateRoom")
        .append_pair("appid", "PrivateApp");
    let mut outer = url::Url::parse("https://wx.chunk.cn/projection/login").unwrap();
    outer
        .query_pairs_mut()
        .append_pair("place_code", "PrivatePlace")
        .append_pair("bill_id", "PrivateBill")
        .append_pair("projection_url", &URL_SAFE_NO_PAD.encode(inner.as_str()));
    outer.into()
}

#[test]
fn loopback_discovery_registration_control_delivery_and_report_schema_v1() {
    let desc = description(
        "PrivateRoom",
        "<manufacturer>PrivateManufacturer</manufacturer><modelName>PrivateModel</modelName>",
    );
    let fixture = Fixture::start(vec![
        Reply::raw(None, 200, desc.clone()),
        Reply::raw(None, 200, desc.clone()),
        Reply::ok(SoapAction::SetDeviceAuthorization),
        Reply::raw(None, 200, desc),
        Reply::fields(
            SoapAction::GetProtocolInfo,
            "<Sink>http-get:*:video/MP2T:*</Sink>",
        ),
        Reply::raw(Some(SoapAction::Stop), 500, fault(701)),
        Reply::ok(SoapAction::SetAVTransportURI),
        Reply::ok(SoapAction::Play),
        Reply::ok(SoapAction::SetDeviceAuthorization),
    ]);
    run(async {
        let t = trace(512);
        let connection = t.begin_connection();
        let cancel = super::super::CancellationToken::new();
        let discovered = super::super::discovery::diagnostic_fixture::discover(
            format!("http://{}/description.xml", fixture.address),
            &t,
            connection,
        )
        .await;
        t.renderer(&discovered);
        t.discovery_facts(
            connection,
            Duration::from_millis(900),
            Some(true),
            Some(true),
        );
        let registered =
            purek::diagnostic_fixture::connect(&qr(&format!("http://{}/room", fixture.address)))
                .await;
        t.record_purek_operation(connection, &registered);
        let mut session = registered.result.unwrap();
        assert!(session.is_registered());
        let renderer = session.renderer().unwrap();
        t.renderer(&renderer);
        let id = t.begin_output(session.context(), config(Some(Cell::FileA)));
        let origin = t.elapsed();
        let endpoint = cast_http::diagnostic_fixture::bind(session.context().clone()).await;
        // Subscribe first. Listener happened at bind and can be fed once from snapshot.
        for h in endpoint.diagnostics().stages {
            t.http_at(id, origin.saturating_add(h.elapsed), &h);
        }
        let mut rx = endpoint.subscribe();
        let (live, mut producer) =
            cast_http::LiveStream::external(cast_http::LiveOptions::default()).unwrap();
        let start = CastStart {
            source_start_us: 2_000_000,
            timestamp_origin_us: 1_933_333,
            profile: 100,
            level: 40,
            width: 1920,
            height: 1080,
            has_b_frames: true,
            audio_transcoded: false,
        };
        producer.start(start).unwrap();
        let mut packet = vec![0xff; 188];
        packet[..6].copy_from_slice(&[0x47, 0x41, 0x00, 0x10, 0x00, 0x00]);
        producer.push(&packet, 0, true).unwrap();
        producer.finish(true).unwrap();
        t.first_ts_packet(id);
        let published = endpoint
            .publish_live(1, live, cast_http::TsMime::Mp2t)
            .unwrap();
        let control = session.control_client().unwrap();
        let started = control
            .start(
                super::super::control::StartRequest {
                    uri: &published.uri,
                    title: "PrivateSong",
                    file: None,
                    capabilities: super::super::control::CapabilityQuery::Query,
                },
                &cancel,
            )
            .await;
        t.record_operation(Some(connection), Some(id), &started);
        started.result.unwrap();
        t.capabilities(
            id,
            ProtocolState::Reported,
            &["http-get:*:video/MP2T:*".into()],
            true,
            false,
        );
        let mut socket = tokio::net::TcpStream::connect(endpoint.local_addr())
            .await
            .unwrap();
        let path = url::Url::parse(&published.uri).unwrap().path().to_owned();
        socket
            .write_all(format!("GET {path} HTTP/1.1\r\nHost: fixture\r\n\r\n").as_bytes())
            .await
            .unwrap();
        let mut received = vec![];
        tokio::time::timeout(Duration::from_secs(3), socket.read_to_end(&mut received))
            .await
            .unwrap()
            .unwrap();
        assert!(received.ends_with(&packet));
        endpoint.shutdown().await;
        t.receive_http(id, origin, &mut rx, &cancel).await;
        let released = session.release().await;
        t.record_purek_operation(connection, &released);
        released.result.unwrap();
        t.complete_output(
            id,
            UserAnswers {
                video: VideoAnswer::Normal,
                audio: Answer::Yes,
                synchronized: Answer::Yes,
            },
        );
        for step in [
            SelfTestStage::S0,
            SelfTestStage::S1,
            SelfTestStage::S2,
            SelfTestStage::S3,
            SelfTestStage::S4,
            SelfTestStage::S5,
            SelfTestStage::S6,
            SelfTestStage::S7,
        ] {
            t.self_test_step(SelfTestStep {
                stage: step,
                outcome: StageOutcome::Complete,
                elapsed_ms: 1,
            });
        }
        t.finish(false);
        let report = t.report();
        let d = report.diagnostics();
        assert_eq!(d["cast"]["schema_version"], 1);
        assert_eq!(d["cast_self_test"]["schema_version"], 1);
        for field in [
            "metadata",
            "environment",
            "steps",
            "discovery",
            "purek",
            "capabilities",
            "preflight",
            "cells",
            "conclusion",
        ] {
            assert!(d["cast_self_test"].get(field).is_some(), "missing {field}");
        }
        let o = &d["cast"]["output"];
        assert_eq!(o["stage"], "delivered_unverified");
        assert_eq!(o["http"]["get"], 1);
        assert_eq!(o["bytes_written"], 188);
        assert_eq!(o["last_media_time_us"], 0);
        assert_eq!(o["media_time_basis"], "dts_watermark_not_pts");
        assert_eq!(o["live_start"]["source_start_us"], 2_000_000);
        assert!(o["code"].is_null());
        assert!(!o["first_byte_ms"].is_null());
        assert_eq!(d["cast_self_test"]["conclusion"]["decision_row"], 1);
        for private in [
            "PrivateRoom",
            "PrivateManufacturer",
            "PrivateModel",
            "purek-token+a/b=Secret",
            "127.0.0.1",
            "uuid:fixture",
            &path,
        ] {
            assert!(!report.json().contains(private));
            assert!(!report.text().contains(private));
        }
        let request:crate::DiagnosticRequest=serde_json::from_value(json!({"app_home":".tmp/no-diagnostic-data","log_dir":".tmp/no-diagnostic-logs","system":{},"tools_and_tasks":{},"cache_policy":{},"runtime_state":{},"connectivity_override":{}})).unwrap();
        let artifact = report.artifact(&request).unwrap();
        let bytes = STANDARD.decode(artifact.zip_base64).unwrap();
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let mut json_text = String::new();
        archive
            .by_name("diagnostics.cast.json")
            .unwrap()
            .read_to_string(&mut json_text)
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&json_text).unwrap()["diagnostics"]["cast"]["schema_version"],
            1
        );
        assert!(archive.by_name("diagnostics.cast.txt").is_ok());
    });
    fixture.join();
}
