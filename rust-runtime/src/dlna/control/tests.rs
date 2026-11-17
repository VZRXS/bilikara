// Ported from VZRXS/bilikara PR #120 by FMPeach (MIT), commit 297ae1de,
// rust-runtime/src/show_dlna.rs (SOAP fixtures), with fix-plan regressions.
use super::*;
use crate::dlna::test_support::*;

#[test]
fn deeply_nested_soap_reply_is_rejected_over_tcp() {
    let source = format!("<root>{}{}</root>", "<a>".repeat(5000), "</a>".repeat(5000));
    assert!(source.len() < dlna_policy::MAX_SOAP_BYTES);
    let fixture = Fixture::start(vec![Reply::raw(
        Some(SoapAction::GetTransportInfo),
        200,
        source,
    )]);
    let client = fixture_client(&fixture, HTTP_TIMEOUT);
    let operation = run(client.get_transport_info(&CancellationToken::new()));
    assert_eq!(
        operation.result.unwrap_err().code,
        ErrorCode::Policy(PolicyError::TooDeep)
    );
    assert_eq!(operation.stages[0].http_status, Some(200));
    fixture.join();
}

fn fixture_client(fixture: &Fixture, timeout: Duration) -> ControlClient {
    ControlClient::with_policy(
        fixture.renderer(),
        &[Ipv4Addr::LOCALHOST],
        NetworkPolicy::LoopbackFixture,
        timeout,
    )
    .unwrap()
}

fn request(uri: &str, capabilities: CapabilityQuery) -> StartRequest<'_> {
    StartRequest {
        uri,
        title: "歌曲 <一> & \"二\"",
        file: None,
        capabilities,
    }
}

fn text(source: &str, name: &str) -> String {
    dlna_policy::bounded_xml(source, dlna_policy::MAX_SOAP_BYTES)
        .unwrap()
        .descendants()
        .find(|n| n.is_element() && n.tag_name().name() == name)
        .unwrap()
        .text()
        .unwrap_or_default()
        .to_owned()
}

#[test]
fn no_value_actions_accept_2xx_nonconforming_bodies() {
    for (action, status, body) in [
        (SoapAction::SetAVTransportURI, 200, ""),
        (SoapAction::SetAVTransportURI, 200, "OK"),
        (
            SoapAction::SetAVTransportURI,
            200,
            "<s:Envelope xmlns:s='x'><s:Body/></s:Envelope>",
        ),
        (SoapAction::Play, 204, ""),
        (SoapAction::Pause, 202, "accepted"),
        (SoapAction::Seek, 200, "<unrelated/>"),
        (SoapAction::Stop, 200, ""),
    ] {
        let fixture = Fixture::start(vec![Reply::raw(Some(action), status, body)]);
        let client = fixture_client(&fixture, HTTP_TIMEOUT);
        let cancel = CancellationToken::new();
        let uri = format!("http://{}/cast.ts", fixture.address);
        let operation = run(async {
            match action {
                SoapAction::SetAVTransportURI => client.set_uri(&uri, "", &cancel).await,
                SoapAction::Play => client.play(&cancel).await,
                SoapAction::Pause => client.pause(&cancel).await,
                SoapAction::Seek => client.seek(Duration::from_secs(1), &cancel).await,
                SoapAction::Stop => client.stop(&cancel).await,
                _ => unreachable!(),
            }
        });
        fixture.join();
        assert!(
            operation.result.is_ok(),
            "{action:?} HTTP {status}: {:?}",
            operation.result
        );
        assert!(operation.stages[0].nonconforming_body.is_some());
    }
}

#[test]
fn empty_success_bodies_start_without_metadata_or_play_retries() {
    let fixture = Fixture::start(vec![
        Reply::ok(SoapAction::Stop),
        Reply::raw(Some(SoapAction::SetAVTransportURI), 200, ""),
        Reply::raw(Some(SoapAction::Play), 200, ""),
    ]);
    let client = fixture_client(&fixture, HTTP_TIMEOUT);
    let uri = format!("http://{}/cast.ts", fixture.address);
    let operation = run(client.start(
        request(&uri, CapabilityQuery::Skip),
        &CancellationToken::new(),
    ));
    assert!(operation.result.is_ok());
    assert_eq!(operation.stages.len(), 3);
    assert!(
        operation.stages[1..]
            .iter()
            .all(|stage| stage.attempt == 1 && stage.nonconforming_body.is_some())
    );
    assert_eq!(fixture.join().len(), 3);
}

#[test]
fn successful_http_queries_still_require_values_and_faults_still_fail() {
    for action in [
        SoapAction::GetProtocolInfo,
        SoapAction::GetTransportInfo,
        SoapAction::GetPositionInfo,
        SoapAction::Play,
    ] {
        for body in ["", "<unrelated/>", &fault(501)] {
            let fixture = Fixture::start(vec![Reply::raw(Some(action), 200, body)]);
            let client = fixture_client(&fixture, HTTP_TIMEOUT);
            let result = run(async {
                let cancel = CancellationToken::new();
                match action {
                    SoapAction::GetProtocolInfo => {
                        client.get_protocol_info(&cancel).await.result.map(|_| ())
                    }
                    SoapAction::GetTransportInfo => {
                        client.get_transport_info(&cancel).await.result.map(|_| ())
                    }
                    SoapAction::GetPositionInfo => {
                        client.get_position_info(&cancel).await.result.map(|_| ())
                    }
                    _ => client.play(&cancel).await.result,
                }
            });
            fixture.join();
            if action == SoapAction::Play && !body.contains("Fault") {
                assert!(result.is_ok());
            } else {
                assert!(result.is_err());
            }
        }
    }
}

#[test]
fn every_stop_error_is_ignored_and_set_uri_is_sent() {
    let stop = SoapAction::Stop;
    let mut cases: Vec<_> = [701, 402, 501]
        .into_iter()
        .map(|code| Reply::raw(Some(stop), 500, fault(code)))
        .collect();
    cases.extend([
        Reply::raw(Some(stop), 405, "method not allowed"),
        Reply::raw(Some(stop), 200, "<not-soap/>"),
        Reply::reset(stop),
    ]);
    for reply in cases {
        let nonconforming = reply.status == 200 && !reply.reset;
        let fixture = Fixture::start(vec![
            reply,
            Reply::ok(SoapAction::SetAVTransportURI),
            Reply::ok(SoapAction::Play),
        ]);
        let client = fixture_client(&fixture, HTTP_TIMEOUT);
        let uri = format!("http://{}/cast.ts", fixture.address);
        let result = run(client.start(
            request(&uri, CapabilityQuery::Skip),
            &CancellationToken::new(),
        ));
        assert!(result.result.is_ok(), "{:?}", result.result);
        if nonconforming {
            assert!(result.stages[0].result.is_ok());
            assert!(result.stages[0].nonconforming_body.is_some());
        } else {
            assert!(result.stages[0].result.is_err());
            assert_eq!(result.stages[0].disposition, Disposition::Ignored);
        }
        assert_eq!(fixture.join().len(), 3);
    }
}

#[test]
fn actual_http_soap_retries_metadata_and_preserves_xml_arguments() {
    for (status, body) in [
        (500, fault(714)),
        (200, fault(714)),
        (400, "bad metadata".to_owned()),
        (503, "unavailable".to_owned()),
    ] {
        let fixture = Fixture::start(vec![
            Reply::ok(SoapAction::Stop),
            Reply::raw(Some(SoapAction::SetAVTransportURI), status, body),
            Reply::ok(SoapAction::SetAVTransportURI),
            Reply::ok(SoapAction::Play),
        ]);
        let client = fixture_client(&fixture, HTTP_TIMEOUT);
        let uri = format!("http://{}/cast/stage.ts?a=1&b=2", fixture.address);
        let result = run(client.start(
            request(&uri, CapabilityQuery::Skip),
            &CancellationToken::new(),
        ));
        result.result.unwrap();
        assert_eq!(result.stages[1].disposition, Disposition::Retrying);
        assert_eq!(result.stages[1].http_status, Some(status));
        assert_eq!(result.stages[2].attempt, 2);
        let requests = fixture.join();
        for request in &requests {
            assert_eq!(
                request.header("content-type"),
                Some("text/xml; charset=\"utf-8\"")
            );
            assert_eq!(request.header("connection"), Some("close"));
            assert_eq!(
                request
                    .header("content-length")
                    .unwrap()
                    .parse::<usize>()
                    .unwrap(),
                request.body.len()
            );
            assert!(request.header("transfer-encoding").is_none());
            assert!(
                request
                    .body
                    .starts_with("<?xml version=\"1.0\" encoding=\"utf-8\"?>")
            );
            assert!(
                request
                    .body
                    .contains(" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"")
            );
            assert_eq!(request.peer.ip(), IpAddr::V4(Ipv4Addr::LOCALHOST));
        }
        assert_eq!(text(&requests[1].body, "CurrentURI"), uri);
        assert_eq!(text(&requests[2].body, "CurrentURIMetaData"), "");
        let metadata = text(&requests[1].body, "CurrentURIMetaData");
        assert_eq!(text(&metadata, "title"), "歌曲 <一> & \"二\"");
        assert!(metadata.contains("parentID=\"0\""));
        // Literal expected wire bytes, independent of the production builder.
        let escaped_uri = uri.replace('&', "&amp;");
        let expected = format!(
            "<?xml version=\"1.0\" encoding=\"utf-8\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body><u:SetAVTransportURI xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\"><InstanceID>0</InstanceID><CurrentURI>{escaped_uri}</CurrentURI><CurrentURIMetaData></CurrentURIMetaData></u:SetAVTransportURI></s:Body></s:Envelope>"
        );
        assert_eq!(requests[2].body.as_bytes(), expected.as_bytes());
        assert_eq!(
            requests[2].header("soapaction"),
            Some("\"urn:schemas-upnp-org:service:AVTransport:1#SetAVTransportURI\"")
        );
    }
}

#[test]
fn metadata_retry_is_bounded_and_does_not_retry_transport_errors() {
    {
        let reply = Reply::reset(SoapAction::SetAVTransportURI);
        let fixture = Fixture::start(vec![Reply::ok(SoapAction::Stop), reply]);
        let client = fixture_client(&fixture, HTTP_TIMEOUT);
        let uri = format!("http://{}/cast.ts", fixture.address);
        assert!(
            run(client.start(
                request(&uri, CapabilityQuery::Skip),
                &CancellationToken::new()
            ))
            .result
            .is_err()
        );
        assert_eq!(fixture.join().len(), 2);
    }
    let fixture = Fixture::start(vec![
        Reply::ok(SoapAction::Stop),
        Reply::raw(Some(SoapAction::SetAVTransportURI), 500, fault(714)),
        Reply::raw(Some(SoapAction::SetAVTransportURI), 500, fault(714)),
    ]);
    let client = fixture_client(&fixture, HTTP_TIMEOUT);
    let uri = format!("http://{}/cast.ts", fixture.address);
    let operation = run(client.start(
        request(&uri, CapabilityQuery::Skip),
        &CancellationToken::new(),
    ));
    assert_eq!(operation.result.unwrap_err().upnp_code, Some(714));
    assert_eq!(fixture.join().len(), 3);
}

#[test]
fn protocol_info_failure_timeout_empty_or_unchecked_never_blocks_play() {
    let query = SoapAction::GetProtocolInfo;
    for (reply, state) in [
        (
            Reply::raw(Some(query), 500, fault(501)),
            ProtocolInfoState::Unavailable,
        ),
        (
            Reply::raw(Some(query), 404, "missing"),
            ProtocolInfoState::Unavailable,
        ),
        (
            Reply::ok(query).delayed(Duration::from_millis(350)),
            ProtocolInfoState::Unavailable,
        ),
        (
            Reply::fields(query, "<Source/><Sink/>"),
            ProtocolInfoState::Empty,
        ),
        (
            Reply::fields(query, "<Sink>http-get:*:video/mp4:*</Sink>"),
            ProtocolInfoState::Reported,
        ),
    ] {
        let fixture = Fixture::start(vec![
            reply,
            Reply::ok(SoapAction::Stop),
            Reply::ok(SoapAction::SetAVTransportURI),
            Reply::ok(SoapAction::Play),
        ]);
        let client = fixture_client(&fixture, Duration::from_millis(150));
        let uri = format!("http://{}/cast.ts", fixture.address);
        let operation = run(client.start(
            request(&uri, CapabilityQuery::Query),
            &CancellationToken::new(),
        ));
        let started = operation.result.unwrap();
        assert_eq!(started.protocol_info_state, state);
        assert_eq!(started.protocol_info, dlna_policy::DEFAULT_PROTOCOL_INFO);
        assert_eq!(fixture.join().len(), 4);
    }
    for capabilities in [
        CapabilityQuery::Skip,
        CapabilityQuery::Known(Vec::new()),
        CapabilityQuery::Known(vec!["http-get:*:video/mp4:*".into()]),
    ] {
        let fixture = Fixture::start(vec![
            Reply::ok(SoapAction::Stop),
            Reply::ok(SoapAction::SetAVTransportURI),
            Reply::ok(SoapAction::Play),
        ]);
        let client = fixture_client(&fixture, HTTP_TIMEOUT);
        let uri = format!("http://{}/cast.ts", fixture.address);
        assert!(
            run(client.start(request(&uri, capabilities), &CancellationToken::new()))
                .result
                .is_ok()
        );
        fixture.join();
    }
}

#[test]
fn missing_connection_manager_is_advisory_and_reported_mime_is_used() {
    let fixture = Fixture::start(vec![
        Reply::ok(SoapAction::Stop),
        Reply::ok(SoapAction::SetAVTransportURI),
        Reply::ok(SoapAction::Play),
    ]);
    let mut renderer = fixture.renderer();
    renderer.description.connection_manager = None;
    let client = ControlClient::with_policy(
        renderer,
        &[Ipv4Addr::LOCALHOST],
        NetworkPolicy::LoopbackFixture,
        HTTP_TIMEOUT,
    )
    .unwrap();
    let uri = format!("http://{}/cast.ts", fixture.address);
    let result = run(client.start(
        request(&uri, CapabilityQuery::Query),
        &CancellationToken::new(),
    ));
    assert_eq!(
        result.stages[0].result.as_ref().unwrap_err().code,
        ErrorCode::Unavailable
    );
    assert_eq!(
        result.result.unwrap().protocol_info_state,
        ProtocolInfoState::Unavailable
    );
    fixture.join();

    let fixture = Fixture::start(vec![
        Reply::fields(
            SoapAction::GetProtocolInfo,
            "<Sink>http-get:*:video/mpeg:DLNA.ORG_PN=MPEG_TS</Sink>",
        ),
        Reply::ok(SoapAction::Stop),
        Reply::ok(SoapAction::SetAVTransportURI),
        Reply::ok(SoapAction::Play),
    ]);
    let client = fixture_client(&fixture, HTTP_TIMEOUT);
    let uri = format!("http://{}/cast.ts", fixture.address);
    assert_eq!(
        run(client.start(
            request(&uri, CapabilityQuery::Query),
            &CancellationToken::new()
        ))
        .result
        .unwrap()
        .protocol_info,
        "http-get:*:video/mpeg:*"
    );
    assert!(
        text(&fixture.join()[2].body, "CurrentURIMetaData").contains("http-get:*:video/mpeg:*")
    );
}

#[test]
fn play_failure_retries_once_after_one_second() {
    let fixture = Fixture::start(vec![
        Reply::ok(SoapAction::Stop),
        Reply::ok(SoapAction::SetAVTransportURI),
        Reply::raw(Some(SoapAction::Play), 500, fault(701)),
        Reply::ok(SoapAction::Play),
    ]);
    let client = fixture_client(&fixture, HTTP_TIMEOUT);
    let uri = format!("http://{}/cast.ts", fixture.address);
    let operation = run(client.start(
        request(&uri, CapabilityQuery::Skip),
        &CancellationToken::new(),
    ));
    operation.result.unwrap();
    assert_eq!(operation.stages[2].disposition, Disposition::Retrying);
    assert_eq!(operation.stages[3].attempt, 2);
    let requests = fixture.join();
    assert!(requests[3].at.duration_since(requests[2].at) >= Duration::from_secs(1));
}

#[test]
fn cancelling_during_play_retry_does_not_wait_for_the_one_second_delay() {
    let fixture = Fixture::start(vec![
        Reply::ok(SoapAction::Stop),
        Reply::ok(SoapAction::SetAVTransportURI),
        Reply::raw(Some(SoapAction::Play), 500, fault(701)),
    ]);
    let client = fixture_client(&fixture, HTTP_TIMEOUT);
    let uri = format!("http://{}/cast.ts", fixture.address);
    run(async {
        let cancel = CancellationToken::new();
        let trigger = cancel.clone();
        let worker = tokio::spawn(async move {
            client
                .start(request(&uri, CapabilityQuery::Skip), &trigger)
                .await
        });
        // Synchronize on all three actual requests, rather than a fixed timer.
        let requests = tokio::task::spawn_blocking(move || fixture.join())
            .await
            .unwrap();
        assert_eq!(requests.len(), 3);
        cancel.cancel();
        assert!(
            tokio::time::timeout(Duration::from_millis(100), worker)
                .await
                .unwrap()
                .unwrap()
                .result
                .unwrap_err()
                .is_cancelled()
        );
    });
}

#[test]
fn pause_seek_and_position_use_standard_avtransport_actions() {
    let fixture = Fixture::start(vec![
        Reply::ok(SoapAction::Pause),
        Reply::ok(SoapAction::Seek),
        Reply::fields(
            SoapAction::GetPositionInfo,
            "<RelTime>0:01:02.250</RelTime><TrackDuration>0:03:00</TrackDuration>",
        ),
    ]);
    let client = fixture_client(&fixture, HTTP_TIMEOUT);
    let cancel = CancellationToken::new();
    run(async {
        client.pause(&cancel).await.result.unwrap();
        client
            .seek(Duration::from_millis(62_250), &cancel)
            .await
            .result
            .unwrap();
        let position = client.get_position_info(&cancel).await.result.unwrap();
        assert_eq!(position.position, Some(Duration::from_millis(62_250)));
        assert_eq!(position.duration, Some(Duration::from_secs(180)));
    });
    let requests = fixture.join();
    assert_eq!(text(&requests[1].body, "Unit"), "REL_TIME");
    assert_eq!(text(&requests[1].body, "Target"), "0:01:02.250");
}

#[test]
fn monitor_fault_http404_or_malformed_reply_disables_polling_without_disconnect() {
    for reply in [
        Reply::raw(Some(SoapAction::GetTransportInfo), 500, fault(401)),
        Reply::raw(Some(SoapAction::GetTransportInfo), 404, "missing"),
        Reply::raw(Some(SoapAction::GetTransportInfo), 200, "not XML"),
        Reply::ok(SoapAction::GetTransportInfo),
    ] {
        let fixture = Fixture::start(vec![reply]);
        let client = fixture_client(&fixture, HTTP_TIMEOUT);
        let mut monitor = TransportMonitor::default();
        run(async {
            let sample = monitor.poll(&client, &CancellationToken::new()).await;
            assert_eq!(sample.decision, MonitorDecision::Disabled);
            assert!(sample.operation.unwrap().result.is_err());
            assert!(
                monitor
                    .poll(&client, &CancellationToken::new())
                    .await
                    .operation
                    .is_none()
            );
        });
        assert_eq!(fixture.join().len(), 1);
    }
}

#[test]
fn unknown_transport_state_disables_monitoring_without_disconnect() {
    let fixture = Fixture::start(vec![Reply::fields(
        SoapAction::GetTransportInfo,
        "<CurrentTransportState>VENDOR_UNKNOWN</CurrentTransportState>",
    )]);
    let client = fixture_client(&fixture, HTTP_TIMEOUT);
    let mut monitor = TransportMonitor::default();
    let sample = run(monitor.poll(&client, &CancellationToken::new()));
    assert_eq!(sample.state, Some(TransportState::Unknown));
    assert_eq!(sample.decision, MonitorDecision::Disabled);
    fixture.join();
}

#[test]
fn only_three_consecutive_network_failures_disconnect_and_stopped_is_observational() {
    let action = SoapAction::GetTransportInfo;
    let fixture = Fixture::start(vec![
        Reply::reset(action),
        Reply::fields(
            action,
            "<CurrentTransportState>STOPPED</CurrentTransportState>",
        ),
        Reply::reset(action),
        Reply::reset(action),
        Reply::reset(action),
    ]);
    let client = fixture_client(&fixture, HTTP_TIMEOUT);
    let mut monitor = TransportMonitor::default();
    run(async {
        let cancel = CancellationToken::new();
        assert_eq!(
            monitor.poll(&client, &cancel).await.decision,
            MonitorDecision::TransientFailure
        );
        let stopped = monitor.poll(&client, &cancel).await;
        assert_eq!(stopped.decision, MonitorDecision::Observed);
        assert_eq!(stopped.state, Some(TransportState::Stopped));
        assert_eq!(
            monitor.poll(&client, &cancel).await.decision,
            MonitorDecision::TransientFailure
        );
        assert_eq!(
            monitor.poll(&client, &cancel).await.decision,
            MonitorDecision::TransientFailure
        );
        assert_eq!(
            monitor.poll(&client, &cancel).await.decision,
            MonitorDecision::Disconnected
        );
    });
    fixture.join();
}

#[test]
fn cancellation_aborts_a_pending_soap_request_within_100ms() {
    // Use the request hook from R1 stabilization 45a2e8d: cancellation must
    // exercise a pending SOAP response, not race the TCP connection setup.
    let (received, mut requests) = tokio::sync::mpsc::unbounded_channel();
    let fixture = Fixture::start_with_request_hook(
        vec![Reply::ok(SoapAction::Stop).delayed(Duration::from_millis(350))],
        move |_, _| received.send(()).unwrap(),
    );
    let client = fixture_client(&fixture, HTTP_TIMEOUT);
    run(async {
        let cancel = CancellationToken::new();
        let trigger = cancel.clone();
        let worker = tokio::spawn(async move { client.stop(&trigger).await });
        tokio::time::timeout(Duration::from_secs(2), requests.recv())
            .await
            .unwrap()
            .unwrap();
        let since = Instant::now();
        cancel.cancel();
        let operation = tokio::time::timeout(Duration::from_millis(100), worker)
            .await
            .unwrap()
            .unwrap();
        assert!(operation.result.unwrap_err().is_cancelled());
        assert!(since.elapsed() < Duration::from_millis(100));
    });
    fixture.join();
}

#[test]
fn soap_is_bounded_and_redirects_are_never_followed() {
    for chunked in [false, true] {
        let mut reply = Reply::raw(
            Some(SoapAction::GetTransportInfo),
            200,
            "x".repeat(dlna_policy::MAX_SOAP_BYTES + 1),
        );
        reply.chunked = chunked;
        let fixture = Fixture::start(vec![reply]);
        let client = fixture_client(&fixture, HTTP_TIMEOUT);
        let error = run(client.get_transport_info(&CancellationToken::new()))
            .result
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::Policy(PolicyError::TooLarge));
        assert_eq!(error.http_status, Some(200));
        fixture.join();
    }
    let mut reply = Reply::raw(Some(SoapAction::Pause), 302, "moved");
    reply.headers = "Location: http://127.0.0.1:1/admin\r\n".into();
    let fixture = Fixture::start(vec![reply]);
    let client = fixture_client(&fixture, HTTP_TIMEOUT);
    let error = run(client.pause(&CancellationToken::new()))
        .result
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::HttpStatus);
    assert_eq!(error.http_status, Some(302));
    fixture.join();
}

#[test]
fn lebo_uses_the_same_control_sequence_and_untrusted_routes_are_rejected() {
    let fixture = Fixture::start(vec![
        Reply::ok(SoapAction::Stop),
        Reply::ok(SoapAction::SetAVTransportURI),
        Reply::ok(SoapAction::Play),
    ]);
    let mut renderer = fixture.renderer();
    renderer.description.vendor_class = dlna_policy::VendorClass::Lebo;
    assert!(ControlClient::new(renderer.clone()).is_err()); // Production never admits loopback fixtures.
    let client = ControlClient::with_policy(
        renderer.clone(),
        &[Ipv4Addr::LOCALHOST],
        NetworkPolicy::LoopbackFixture,
        HTTP_TIMEOUT,
    )
    .unwrap();
    let uri = format!("http://{}/cast.ts", fixture.address);
    assert!(
        run(client.start(
            request(&uri, CapabilityQuery::Skip),
            &CancellationToken::new()
        ))
        .result
        .is_ok()
    );
    fixture.join();
    renderer.local_address = Ipv4Addr::new(127, 0, 0, 2);
    assert!(
        ControlClient::with_policy(
            renderer,
            &[Ipv4Addr::LOCALHOST],
            NetworkPolicy::LoopbackFixture,
            HTTP_TIMEOUT
        )
        .is_err()
    );
}

#[test]
fn selected_local_interface_is_used_even_when_the_route_changes_to_tun() {
    let fixture = Fixture::start(vec![Reply::ok(SoapAction::Play)]);
    let mut renderer = fixture.renderer();
    renderer.context.source = DiscoverySource::SearchResponse;
    renderer.context.route = Some(RouteFacts {
        selection: Some(LocalSourceKind::ReplyInterface),
        routed_source_is_local: Some(false),
        route_matches_selected: Some(false),
        route_matches_reply: Some(false),
    });
    let client = ControlClient::with_route_lookup(
        renderer,
        &[Ipv4Addr::LOCALHOST],
        NetworkPolicy::LoopbackFixture,
        HTTP_TIMEOUT,
        |_| Ok(Ipv4Addr::new(198, 18, 0, 1)),
    )
    .unwrap();
    let operation = run(client.play(&CancellationToken::new()));
    operation.result.unwrap();
    let context = operation.stages[0].context.as_ref().unwrap();
    assert_eq!(
        context.route.as_ref().unwrap().selection,
        Some(LocalSourceKind::ReplyInterface)
    );
    assert_eq!(
        context.route.as_ref().unwrap().route_matches_selected,
        Some(false)
    );
    assert_eq!(fixture.join()[0].peer.ip(), IpAddr::V4(Ipv4Addr::LOCALHOST));
}
