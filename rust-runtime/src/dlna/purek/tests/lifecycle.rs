// Adapted from bilikara-next 7750dca, native_host/purek/tests.rs (MIT), with
// ChunK-Helper 3b00533 lifecycle behavior (MIT). See THIRD_PARTY_NOTICES.md.
use super::*;

#[test]
fn confirmation_retries_route_loss_before_recovery_or_five_failure_cleanup() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static ROUTES: AtomicUsize = AtomicUsize::new(0);
    static FAILURES: AtomicUsize = AtomicUsize::new(0);
    for failure_count in [1, 5] {
        ROUTES.store(0, Ordering::SeqCst);
        FAILURES.store(failure_count, Ordering::SeqCst);
        let mut client = client();
        // A different /24 prevents a same-subnet fallback from hiding the
        // simulated missing route. Both addresses are local loopback fixtures.
        client.interfaces = Some(vec![Ipv4Addr::new(127, 1, 0, 1)]);
        client.route_lookup = |_| {
            let call = ROUTES.fetch_add(1, Ordering::SeqCst);
            if call > 0 && call <= FAILURES.load(Ordering::SeqCst) {
                Err(DlnaError::new(ErrorCode::RouteUnavailable))
            } else {
                Ok(Ipv4Addr::new(127, 1, 0, 1))
            }
        };
        let mut replies = vec![device("uuid:fixture", false), authorized()];
        if failure_count == 1 {
            replies.push(device("uuid:fixture", true));
        }
        replies.push(authorized());
        let fixture = Fixture::start(replies);
        let operation = connect(&client, &fixture);
        let failed_routes: Vec<_> = operation
            .stages
            .iter()
            .filter(|stage| stage.phase == Phase::Route && stage.stage.result.is_err())
            .collect();
        assert_eq!(failed_routes.len(), failure_count);
        for (index, stage) in failed_routes.iter().enumerate() {
            assert_eq!(stage.stage.attempt as usize, index + 1);
            assert_eq!(
                stage.stage.disposition,
                if index < 4 {
                    Disposition::Retrying
                } else {
                    Disposition::Applied
                }
            );
        }
        if failure_count == 1 {
            assert!(
                !operation
                    .stages
                    .iter()
                    .any(|stage| stage.phase == Phase::Revoke)
            );
            let confirmed = operation
                .stages
                .iter()
                .find(|stage| stage.phase == Phase::Confirm)
                .unwrap();
            assert_eq!(confirmed.stage.attempt, 2);
            let mut session = operation.result.unwrap();
            assert!(session.is_registered());
            run(session.release()).result.unwrap();
        } else {
            assert_eq!(operation.result.unwrap_err().code, PureKErrorCode::Route);
            assert!(
                operation
                    .stages
                    .iter()
                    .any(|stage| stage.phase == Phase::Revoke)
            );
        }
        let requests = fixture.join();
        assert_eq!(requests.len(), if failure_count == 1 { 4 } else { 3 });
        let last = requests.last().unwrap();
        assert!(last.body.contains("<Enable>0</Enable>"));
        assert!(last.body.contains("<DeviceIP>127.1.0.1</DeviceIP>"));
        assert_eq!(
            requests[0].peer.ip(),
            IpAddr::V4(Ipv4Addr::new(127, 1, 0, 1))
        );
    }
}

#[test]
fn qr_receiver_query_never_reaches_description_soap_or_notify() {
    let receiver = std::net::UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    receiver
        .set_read_timeout(Some(Duration::from_secs(1)))
        .unwrap();
    let mut client = client();
    client.notify_destination = receiver.local_addr().unwrap();
    let fixture = Fixture::start(vec![
        device("uuid:fixture", false),
        authorized(),
        device("uuid:fixture", true),
        Reply::ok(SoapAction::Play),
        authorized(),
    ]);
    let raw = room_qr(
        &format!(
            "http://{}/room?room=qr-private-room&bill=qr-private-bill#qr-private-fragment",
            fixture.address
        ),
        "opaque+token",
    );
    let operation = run(client.connect(
        &raw,
        AddressApproval::LanLiteralOnly,
        &CancellationToken::new(),
    ));
    let mut diagnostics = format!("{:?}", operation.stages);
    let mut session = operation.result.unwrap();
    assert_eq!(
        session.renderer().unwrap().description.location,
        format!("http://{}/room/description.xml", fixture.address)
    );
    let control = run(session
        .control_client()
        .unwrap()
        .play(&CancellationToken::new()));
    control.result.unwrap();
    let release = run(session.release());
    release.result.unwrap();
    diagnostics.push_str(&format!(
        "{:?}{:?}{session:?}",
        control.stages, release.stages
    ));
    let address = fixture.address;
    let requests = fixture.join();
    for index in [0, 2] {
        assert!(
            requests[index]
                .headers
                .starts_with("GET /room/description.xml HTTP/1.1\r\n")
        );
    }
    // Query supplied by the service description is a separate protocol field;
    // preserve it while removing every parameter inherited from the QR URL.
    for index in [1, 4] {
        assert!(
            requests[index]
                .headers
                .starts_with("POST /cm?opaque=room HTTP/1.1\r\n")
        );
    }
    assert!(requests[3].headers.starts_with("POST /av HTTP/1.1\r\n"));
    let mut buffer = [0; 4096];
    for _ in 0..10 {
        let (size, _) = receiver.recv_from(&mut buffer).unwrap();
        let packet = std::str::from_utf8(&buffer[..size]).unwrap();
        if packet.contains("NTS: ssdp:alive") {
            assert!(packet.contains(&format!(
                "LOCATION: http://{}/room/description.xml\r\n",
                address
            )));
        } else {
            assert!(packet.contains("NTS: ssdp:byebye"));
            assert!(!packet.contains("LOCATION:"));
        }
        for private in ["qr-private-room", "qr-private-bill", "qr-private-fragment"] {
            assert!(!packet.contains(private));
        }
    }
    for private in ["qr-private-room", "qr-private-bill", "qr-private-fragment"] {
        assert!(!diagnostics.contains(private));
        assert!(
            requests
                .iter()
                .all(|request| !request.headers.contains(private))
        );
    }
}

#[test]
fn auth_unlocks_avtransport_then_t2_control_and_release_use_real_endpoints() {
    let fixture = Fixture::start(vec![
        device("uuid:fixture", false),
        authorized(),
        device("uuid:fixture", true),
        Reply::ok(SoapAction::Play),
        authorized(),
    ]);
    let operation = connect(&client(), &fixture);
    let before = operation
        .stages
        .iter()
        .find(|step| step.phase == Phase::DescriptionBefore)
        .unwrap();
    assert_eq!(
        before.facts.services.as_ref().unwrap().entries,
        vec![ServiceSummaryEntry {
            kind: ServiceKind::ConnectionManager,
            version: 1
        }]
    );
    let confirmed = operation
        .stages
        .iter()
        .find(|step| step.phase == Phase::Confirm)
        .unwrap();
    assert_eq!(confirmed.facts.udn_same, Some(true));
    assert_eq!(confirmed.facts.services_changed_after_auth, Some(true));
    assert_eq!(confirmed.facts.services.as_ref().unwrap().entries.len(), 2);
    assert!(
        !operation
            .stages
            .iter()
            .any(|step| step.phase == Phase::Revoke)
    );
    let mut session = operation.result.unwrap();
    assert!(session.is_registered());
    assert!(session.renderer().is_ok());
    run(session
        .control_client()
        .unwrap()
        .play(&CancellationToken::new()))
    .result
    .unwrap();
    let release = run(session.release());
    assert!(release.result.is_ok());
    assert!(!session.is_registered());
    assert!(session.renderer().is_err());
    assert!(run(session.release()).stages.is_empty());
    let requests = fixture.join();
    assert!(
        requests[1]
            .headers
            .starts_with("POST /cm?opaque=room HTTP/1.1")
    );
    assert!(requests[3].headers.starts_with("POST /av HTTP/1.1"));
    assert!(requests[4].body.contains("<Enable>0</Enable>"));
}

#[test]
fn authorization_soap_uses_kirakara_envelope_and_chunk_action_arguments() {
    // Check T2/Kirakara SOAP bytes with ChunK's action argument names. ChunK's
    // own serializer omits the XML declaration and uses an unquoted charset;
    // this fixture does not claim byte-for-byte equality with that request.
    let fixture = Fixture::start(vec![
        device("uuid:fixture", false),
        authorized(),
        device("uuid:fixture", true),
        authorized(),
    ]);
    let mut session = connect(&client(), &fixture).result.unwrap();
    run(session.release()).result.unwrap();
    let requests = fixture.join();
    for (index, enable) in [(1, "1"), (3, "0")] {
        let request = &requests[index];
        let expected = format!(
            "<?xml version=\"1.0\" encoding=\"utf-8\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body><u:SetDeviceAuthorization xmlns:u=\"urn:schemas-upnp-org:service:ConnectionManager:1\"><DeviceIP>127.0.0.1</DeviceIP><Token>token+a/b=&amp;&lt;secret&gt;</Token><Enable>{enable}</Enable></u:SetDeviceAuthorization></s:Body></s:Envelope>"
        );
        assert_eq!(request.body, expected);
        assert_eq!(
            request.header("Content-Type"),
            Some("text/xml; charset=\"utf-8\"")
        );
        assert_eq!(
            request.header("SOAPAction"),
            Some("\"urn:schemas-upnp-org:service:ConnectionManager:1#SetDeviceAuthorization\"")
        );
        assert_eq!(
            request
                .header("Content-Length")
                .unwrap()
                .parse::<usize>()
                .unwrap(),
            expected.len()
        );
        assert_eq!(request.header("Connection"), Some("close"));
        assert_eq!(request.peer.ip(), IpAddr::V4(Ipv4Addr::LOCALHOST));
    }
}

#[test]
fn nonstandard_http_200_ack_is_recorded_and_confirmation_still_succeeds() {
    for body in ["", "OK", "<vendorResponse/>", "<unclosed"] {
        let fixture = Fixture::start(vec![
            device("uuid:fixture", false),
            authorization(200, body),
            device("uuid:fixture", true),
            authorized(),
        ]);
        let operation = connect(&client(), &fixture);
        let stage = operation
            .stages
            .iter()
            .find(|step| step.phase == Phase::Register)
            .unwrap();
        assert!(stage.stage.result.is_ok());
        assert!(stage.facts.unconfirmed_response);
        assert!(stage.stage.nonconforming_body.is_some());
        let mut session = operation.result.unwrap();
        run(session.release()).result.unwrap();
        fixture.join();
    }
}

#[test]
fn fault_http500_timeout_and_deep_xml_are_distinct_and_all_attempt_cleanup() {
    for (reply, expected, cause, status, upnp) in [
        (
            authorization(500, &fault(606)),
            PureKErrorCode::AuthorizationRejected,
            ErrorCode::Policy(PolicyError::SoapFault(Some(606))),
            Some(500),
            Some(606),
        ),
        (
            authorization(200, &fault(501)),
            PureKErrorCode::AuthorizationRejected,
            ErrorCode::Policy(PolicyError::SoapFault(Some(501))),
            Some(200),
            Some(501),
        ),
        (
            authorization(500, "<html>error</html>"),
            PureKErrorCode::Http,
            ErrorCode::HttpStatus,
            Some(500),
            None,
        ),
        (
            authorization(204, ""),
            PureKErrorCode::Http,
            ErrorCode::HttpStatus,
            Some(204),
            None,
        ),
        (
            authorized().delayed(Duration::from_millis(600)),
            PureKErrorCode::Http,
            ErrorCode::Timeout,
            None,
            None,
        ),
        (
            authorization(200, &"<a>".repeat(10_000)),
            PureKErrorCode::Http,
            ErrorCode::Policy(PolicyError::TooDeep),
            Some(200),
            None,
        ),
    ] {
        let fixture = Fixture::start(vec![device("uuid:fixture", false), reply, authorized()]);
        let operation = connect(&client(), &fixture);
        let error = operation.result.unwrap_err();
        assert_eq!(error.code, expected);
        assert_eq!(error.cause.code, cause);
        assert_eq!(error.cause.http_status, status);
        assert_eq!(error.cause.upnp_code, upnp);
        let stage = operation
            .stages
            .iter()
            .find(|step| step.phase == Phase::Register)
            .unwrap();
        assert_eq!(stage.error_code, Some(expected));
        assert!(
            operation
                .stages
                .iter()
                .any(|step| step.phase == Phase::Revoke)
        );
        let requests = fixture.join();
        assert_eq!(requests.len(), 3);
        assert!(requests[2].body.contains("<DeviceIP>127.0.0.1</DeviceIP>"));
        assert!(requests[2].body.contains("<Enable>0</Enable>"));
    }
}

#[test]
fn confirmation_retries_temporary_description_failure_without_revoking_registration() {
    let fixture = Fixture::start(vec![
        device("uuid:fixture", false),
        authorized(),
        Reply::raw(None, 503, "busy"),
        device("uuid:fixture", true),
        authorized(),
    ]);
    let operation = connect(&client(), &fixture);
    let confirms: Vec<_> = operation
        .stages
        .iter()
        .filter(|step| step.phase == Phase::Confirm)
        .collect();
    assert_eq!(confirms.len(), 2);
    assert_eq!(confirms[0].stage.disposition, Disposition::Retrying);
    assert_eq!(confirms[1].stage.attempt, 2);
    assert!(
        !operation
            .stages
            .iter()
            .any(|step| step.phase == Phase::Revoke)
    );
    let mut session = operation.result.unwrap();
    run(session.release()).result.unwrap();
    let requests = fixture.join();
    assert!(requests[3].headers.starts_with("GET "));
    assert!(requests[4].body.contains("<Enable>0</Enable>"));
}

#[test]
fn identity_change_during_confirmation_revokes_and_never_announces_alive() {
    let fixture = Fixture::start(vec![
        device("uuid:fixture", false),
        authorized(),
        device("uuid:different", true),
        authorized(),
    ]);
    let operation = connect(&client(), &fixture);
    assert_eq!(
        operation.result.unwrap_err().code,
        PureKErrorCode::IdentityChanged
    );
    let stage = operation
        .stages
        .iter()
        .find(|step| step.phase == Phase::Confirm)
        .unwrap();
    assert_eq!(stage.facts.udn_same, Some(false));
    assert!(
        !operation
            .stages
            .iter()
            .any(|step| step.facts.alive == Some(true))
    );
    assert!(fixture.join()[3].body.contains("<Enable>0</Enable>"));
}

#[test]
fn registration_endpoint_and_service_changes_are_diagnostic_and_revoke_uses_original_interface() {
    let after = describe(
        "UUID:FIXTURE",
        &format!(
            "{}{}",
            service("ConnectionManager", "2", "/new-cm"),
            service("AVTransport", "3", "/new-av")
        ),
    );
    let fixture = Fixture::start(vec![
        device("uuid:fixture", false),
        authorized(),
        Reply::raw(None, 200, &after),
        Reply::raw(None, 200, &after),
        authorized(),
    ]);
    let operation = connect(&client(), &fixture);
    let stage = operation
        .stages
        .iter()
        .find(|step| step.phase == Phase::Confirm)
        .unwrap();
    assert_eq!(stage.facts.registration_endpoint_changed, Some(true));
    let mut session = operation.result.unwrap();
    let health = run(session.poll_health(&CancellationToken::new()));
    assert_eq!(health.result.unwrap(), HealthState::Online);
    assert!(
        session
            .renderer()
            .unwrap()
            .description
            .av_transport
            .control_url
            .ends_with("/new-av")
    );
    run(session.release()).result.unwrap();
    assert!(
        fixture.join()[4]
            .headers
            .starts_with("POST /cm?opaque=room HTTP/1.1")
    );
}

#[test]
fn route_change_reregisters_once_and_cleans_each_exact_registered_ip() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static ROUTES: AtomicUsize = AtomicUsize::new(0);
    ROUTES.store(0, Ordering::SeqCst);
    let mut client = client();
    client.route_lookup = |_| {
        Ok(if ROUTES.fetch_add(1, Ordering::SeqCst) == 0 {
            Ipv4Addr::LOCALHOST
        } else {
            Ipv4Addr::new(127, 0, 0, 2)
        })
    };
    let fixture = Fixture::start(vec![
        device("uuid:fixture", false),
        authorized(),
        device("uuid:fixture", true),
        authorized(),
        authorized(),
        device("uuid:fixture", true),
        authorized(),
    ]);
    let operation = connect(&client, &fixture);
    assert!(
        operation
            .stages
            .iter()
            .any(|step| step.facts.route_changed == Some(true))
    );
    assert_eq!(
        operation
            .stages
            .iter()
            .filter(|step| step.phase == Phase::Register)
            .count(),
        2
    );
    let mut session = operation.result.unwrap();
    run(session.release()).result.unwrap();
    let requests = fixture.join();
    for (index, ip, enable) in [
        (1, "127.0.0.1", "1"),
        (3, "127.0.0.1", "0"),
        (4, "127.0.0.2", "1"),
        (6, "127.0.0.2", "0"),
    ] {
        assert!(
            requests[index]
                .body
                .contains(&format!("<DeviceIP>{ip}</DeviceIP>"))
        );
        assert!(
            requests[index]
                .body
                .contains(&format!("<Enable>{enable}</Enable>"))
        );
        assert_eq!(requests[index].peer.ip().to_string(), ip);
    }
}

#[test]
fn announce_is_best_effort_and_wire_uses_real_receiver_location_and_identities() {
    let receiver = std::net::UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    receiver
        .set_read_timeout(Some(Duration::from_secs(1)))
        .unwrap();
    let mut client = client();
    client.notify_destination = receiver.local_addr().unwrap();
    let fixture = Fixture::start(vec![
        device("uuid:real-receiver", false),
        authorized(),
        device("uuid:real-receiver", true),
        authorized(),
    ]);
    let operation = connect(&client, &fixture);
    let announcement = operation
        .stages
        .iter()
        .find(|step| step.phase == Phase::Announcement)
        .unwrap();
    assert_eq!(announcement.facts.announcements_sent, 5);
    let mut buffer = [0; 4096];
    let mut nts = Vec::new();
    for _ in 0..5 {
        let (size, peer) = receiver.recv_from(&mut buffer).unwrap();
        let packet = std::str::from_utf8(&buffer[..size]).unwrap();
        assert!(packet.starts_with("NOTIFY * HTTP/1.1\r\n"));
        assert!(packet.contains(&format!(
            "LOCATION: http://{}/room/description.xml\r\n",
            fixture.address
        )));
        assert!(packet.contains("CACHE-CONTROL: max-age=60\r\n"));
        assert!(packet.contains("USN: uuid:real-receiver"));
        assert!(packet.contains("NTS: ssdp:alive\r\n"));
        assert!(!packet.contains("token+"));
        assert!(!packet.contains("secret-query"));
        assert_eq!(peer.ip(), IpAddr::V4(Ipv4Addr::LOCALHOST));
        nts.push(
            packet
                .lines()
                .find(|line| line.starts_with("NT:"))
                .unwrap()
                .to_owned(),
        );
    }
    assert!(nts.contains(&"NT: urn:schemas-upnp-org:service:AVTransport:1".into()));
    assert!(nts.contains(&"NT: upnp:rootdevice".into()));
    let mut session = operation.result.unwrap();
    run(session.release()).result.unwrap();
    for _ in 0..5 {
        let (size, _) = receiver.recv_from(&mut buffer).unwrap();
        let packet = std::str::from_utf8(&buffer[..size]).unwrap();
        assert!(packet.contains("NTS: ssdp:byebye"));
        assert!(!packet.contains("LOCATION:"));
    }
    fixture.join();

    let mut client = super::client();
    client.notify_destination = "[::1]:1900".parse().unwrap(); // IPv4 socket cannot send here.
    let fixture = Fixture::start(vec![
        device("uuid:fixture", false),
        authorized(),
        device("uuid:fixture", true),
        authorized(),
    ]);
    let operation = connect(&client, &fixture);
    let stage = operation
        .stages
        .iter()
        .find(|step| step.phase == Phase::Announcement)
        .unwrap();
    assert!(stage.stage.result.is_err());
    assert_eq!(stage.stage.disposition, Disposition::Ignored);
    let mut session = operation.result.unwrap();
    assert!(session.renderer().is_ok());
    run(session.release()).result.unwrap();
    fixture.join();
}

#[test]
fn health_tolerates_transient_description_failures_and_only_releases_after_five() {
    let mut replies = vec![
        device("uuid:fixture", false),
        authorized(),
        device("uuid:fixture", true),
        Reply::raw(None, 503, "busy"),
        device("uuid:fixture", true),
    ];
    replies.extend((0..5).map(|_| Reply::raw(None, 503, "busy")));
    replies.push(authorized());
    let fixture = Fixture::start(replies);
    let mut session = connect(&client(), &fixture).result.unwrap();
    assert_eq!(session.health_interval(), NORMAL_INTERVAL);
    assert_eq!(
        run(session.poll_health(&CancellationToken::new()))
            .result
            .unwrap(),
        HealthState::Suspect
    );
    assert!(session.is_registered());
    assert_eq!(session.health_interval(), RETRY_INTERVAL);
    assert_eq!(
        run(session.poll_health(&CancellationToken::new()))
            .result
            .unwrap(),
        HealthState::Online
    );
    assert_eq!(session.health_interval(), NORMAL_INTERVAL);
    for attempt in 1..=5 {
        let operation = run(session.poll_health(&CancellationToken::new()));
        assert_eq!(
            operation.result.unwrap(),
            if attempt == 5 {
                HealthState::Offline
            } else {
                HealthState::Suspect
            }
        );
        assert_eq!(
            operation
                .stages
                .iter()
                .find(|step| step.phase == Phase::Health)
                .unwrap()
                .facts
                .consecutive_failures,
            attempt
        );
        assert_eq!(session.is_registered(), attempt < 5);
    }
    assert_eq!(fixture.join().len(), 11);
}

#[test]
fn health_identity_change_releases_even_while_delivering_and_service_changes_do_not() {
    let fixture = Fixture::start(vec![
        device("uuid:fixture", false),
        authorized(),
        device("uuid:fixture", true),
        device("uuid:fixture", false),
        device("uuid:another", true),
        authorized(),
    ]);
    let mut session = connect(&client(), &fixture).result.unwrap();
    session.record_delivery(1_000);
    assert_eq!(
        run(session.poll_health(&CancellationToken::new()))
            .result
            .unwrap(),
        HealthState::Online
    );
    assert!(session.is_registered());
    assert_eq!(
        run(session.poll_health(&CancellationToken::new()))
            .result
            .unwrap(),
        HealthState::IdentityChanged
    );
    assert!(!session.is_registered());
    assert_eq!(fixture.join().len(), 6);
}

#[test]
fn fresh_delivery_extends_health_failure_tolerance_in_real_http_probes() {
    let mut replies = vec![
        device("uuid:fixture", false),
        authorized(),
        device("uuid:fixture", true),
    ];
    replies.extend((0..6).map(|_| Reply::raw(None, 503, "busy")));
    replies.push(authorized());
    let fixture = Fixture::start(replies);
    let mut session = connect(&client(), &fixture).result.unwrap();
    for total in 1..=6 {
        session.record_delivery(total);
        let operation = run(session.poll_health(&CancellationToken::new()));
        assert_eq!(operation.result.unwrap(), HealthState::Suspect);
        assert!(
            !operation
                .stages
                .iter()
                .any(|step| step.phase == Phase::Revoke)
        );
    }
    run(session.release()).result.unwrap();
    fixture.join();
}

#[test]
fn cancellation_after_register_request_reaches_receiver_attempts_independent_revoke() {
    let cancel = CancellationToken::new();
    let request_cancel = cancel.clone();
    let fixture = Fixture::start_with_request_hook(
        vec![
            device("uuid:fixture", false),
            authorized().delayed(Duration::from_millis(400)),
            authorized(),
        ],
        move |index, request| {
            if index == 1 {
                assert!(request.body.contains("<Enable>1</Enable>"));
                // Cancel while registration is awaiting its delayed reply,
                // regardless of how long the preceding description took.
                request_cancel.cancel();
            }
        },
    );
    let client = client();
    let raw = fixture_qr(&fixture);
    let operation = run(client.connect(&raw, AddressApproval::LanLiteralOnly, &cancel));
    assert_eq!(
        operation.result.unwrap_err().code,
        PureKErrorCode::Cancelled
    );
    assert!(
        operation
            .stages
            .iter()
            .any(|step| step.phase == Phase::Revoke && step.stage.result.is_ok())
    );
    assert!(fixture.join()[2].body.contains("<Enable>0</Enable>"));
}

#[test]
fn maintain_cancellation_attempts_revoke_and_cleanup_errors_are_only_diagnostic() {
    let fixture = Fixture::start(vec![
        device("uuid:fixture", false),
        authorized(),
        device("uuid:fixture", true),
        authorization(500, &fault(606)),
    ]);
    let mut session = connect(&client(), &fixture).result.unwrap();
    let (_bytes, receiver) = tokio::sync::watch::channel(0);
    let cancel = CancellationToken::new();
    cancel.cancel();
    let mut stages = Vec::new();
    assert_eq!(
        run(session.maintain(&cancel, receiver, |stage| stages.push(stage))),
        HealthState::Cancelled
    );
    let stage = stages
        .iter()
        .find(|step| step.phase == Phase::Revoke)
        .unwrap();
    assert!(stage.stage.result.is_err());
    assert_eq!(stage.stage.disposition, Disposition::Ignored);
    assert!(!session.is_registered());
    fixture.join();
}

#[test]
fn self_test_can_inspect_after_rejected_registration_without_registering_or_announcing() {
    let fixture = Fixture::start(vec![
        device("uuid:fixture", false),
        authorization(500, &fault(606)),
        authorized(),
        device("uuid:fixture", true),
    ]);
    let client = client();
    assert!(connect(&client, &fixture).result.is_err());
    let room = Room::parse_on(&fixture_qr(&fixture), NetworkPolicy::LoopbackFixture).unwrap();
    let operation = run(client.inspect(
        room,
        AddressApproval::LanLiteralOnly,
        &CancellationToken::new(),
    ));
    let mut session = operation.result.unwrap();
    assert!(session.renderer().is_ok());
    assert!(!session.is_registered());
    assert!(
        !operation
            .stages
            .iter()
            .any(|step| step.phase == Phase::Register || step.phase == Phase::Announcement)
    );
    assert!(run(session.release()).stages.is_empty());
    fixture.join();
}

#[test]
fn all_phase_records_and_debug_are_redacted_and_hashes_are_salted_per_attempt() {
    let mut keys = Vec::new();
    for _ in 0..2 {
        let fixture = Fixture::start(vec![
            device("uuid:room-secret-udn", false),
            authorized(),
            device("uuid:room-secret-udn", true),
            device("uuid:room-secret-udn", true),
            authorized(),
        ]);
        let operation = connect(&client(), &fixture);
        let text = format!("{operation:?}");
        let mut stages = operation.stages;
        let mut session = operation.result.unwrap();
        keys.push(session.context.udn_hash.clone().unwrap());
        stages.extend(run(session.poll_health(&CancellationToken::new())).stages);
        stages.extend(run(session.release()).stages);
        let text = format!("{text}{stages:?}");
        for secret in [
            "token+a/b",
            "secret-query",
            "secret-place",
            "secret-bill",
            "secret-app",
            "Room Secret Label",
            "Secret Room Label",
            "127.0.0.1",
            "uuid:room-secret-udn",
            "wx.chunk.cn",
            "dolphinstar.cn",
            "http://",
        ] {
            assert!(!text.contains(secret), "leaked {secret}");
        }
        assert!(
            stages
                .iter()
                .all(|step| step.schema_version == 1 && step.stage.context.is_some())
        );
        fixture.join();
    }
    assert_ne!(keys[0], keys[1]);
}

#[test]
fn cancellation_during_route_renewal_never_starts_a_new_registration() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static ROUTES: AtomicUsize = AtomicUsize::new(0);
    ROUTES.store(0, Ordering::SeqCst);
    let mut client = client();
    client.route_lookup = |_| {
        Ok(if ROUTES.fetch_add(1, Ordering::SeqCst) == 0 {
            Ipv4Addr::LOCALHOST
        } else {
            Ipv4Addr::new(127, 0, 0, 2)
        })
    };
    let cancel = CancellationToken::new();
    let request_cancel = cancel.clone();
    let fixture = Fixture::start_with_request_hook(
        vec![
            device("uuid:fixture", false),
            authorized(),
            device("uuid:fixture", true),
            authorized().delayed(Duration::from_millis(500)),
            authorized(),
        ],
        move |index, request| {
            if index == 3 {
                assert!(request.body.contains("<Enable>0</Enable>"));
                // The old route's revoke must have reached the receiver before
                // cancellation can test that renewal never registers again.
                request_cancel.cancel();
            }
        },
    );
    let raw = fixture_qr(&fixture);
    let operation = run(client.connect(&raw, AddressApproval::LanLiteralOnly, &cancel));
    assert_eq!(
        operation.result.unwrap_err().code,
        PureKErrorCode::Cancelled
    );
    let requests = fixture.join();
    assert_eq!(
        requests
            .iter()
            .filter(|request| request.body.contains("<Enable>1</Enable>"))
            .count(),
        1
    );
    assert!(requests[4].body.contains("<DeviceIP>127.0.0.1</DeviceIP>"));
    assert!(requests[4].body.contains("<Enable>0</Enable>"));
}

#[test]
fn maintain_renews_due_announcement_for_thirty_seconds_without_immediate_health_probe() {
    let fixture = Fixture::start(vec![
        device("uuid:fixture", false),
        authorized(),
        device("uuid:fixture", true),
        authorized(),
    ]);
    let mut session = connect(&client(), &fixture).result.unwrap();
    assert!(run(session.renew_announcement(&CancellationToken::new())).is_none());
    session.next_announcement = Instant::now();
    let (_, receiver) = tokio::sync::watch::channel(0);
    let cancel = CancellationToken::new();
    let mut stages = Vec::new();
    let state = run(async {
        tokio::join!(
            session.maintain(&cancel, receiver, |stage| stages.push(stage)),
            async {
                tokio::time::sleep(Duration::from_millis(50)).await;
                cancel.cancel();
            }
        )
        .0
    });
    assert_eq!(state, HealthState::Cancelled);
    assert_eq!(
        stages
            .iter()
            .filter(|stage| stage.facts.alive == Some(true))
            .count(),
        1
    );
    assert!(stages.iter().any(|stage| stage.facts.alive == Some(false)));
    assert!(
        session
            .next_announcement
            .saturating_duration_since(Instant::now())
            > Duration::from_secs(28)
    );
    assert!(!stages.iter().any(|stage| stage.phase == Phase::Health));
    assert_eq!(fixture.join().len(), 4);
}

#[test]
fn cancelled_health_sample_records_the_phase_and_cleans_the_lease() {
    let fixture = Fixture::start(vec![
        device("uuid:fixture", false),
        authorized(),
        device("uuid:fixture", true),
        authorized(),
    ]);
    let mut session = connect(&client(), &fixture).result.unwrap();
    let cancel = CancellationToken::new();
    cancel.cancel();
    let operation = run(session.poll_health(&cancel));
    assert_eq!(operation.result.unwrap(), HealthState::Cancelled);
    assert!(
        operation
            .stages
            .iter()
            .any(|stage| stage.phase == Phase::Health
                && stage.error_code == Some(PureKErrorCode::Cancelled))
    );
    assert!(
        operation
            .stages
            .iter()
            .any(|stage| stage.phase == Phase::Revoke)
    );
    assert!(session.announcement_delay().is_none());
    assert!(!session.is_registered());
    assert_eq!(fixture.join().len(), 4);
}

#[test]
fn confirmation_exhausts_five_failures_before_releasing_and_initial_probe_failure_never_registers()
{
    let mut replies = vec![device("uuid:fixture", false), authorized()];
    replies.extend((0..5).map(|_| Reply::raw(None, 503, "busy")));
    replies.push(authorized());
    let fixture = Fixture::start(replies);
    let operation = connect(&client(), &fixture);
    assert_eq!(
        operation.result.unwrap_err().code,
        PureKErrorCode::Description
    );
    assert_eq!(
        operation
            .stages
            .iter()
            .filter(|stage| stage.phase == Phase::Confirm)
            .count(),
        5
    );
    assert_eq!(fixture.join().len(), 8);
    let fixture = Fixture::start(vec![Reply::raw(None, 503, "busy")]);
    let operation = connect(&client(), &fixture);
    assert_eq!(
        operation.result.unwrap_err().code,
        PureKErrorCode::Description
    );
    assert!(
        !operation
            .stages
            .iter()
            .any(|stage| stage.phase == Phase::Register || stage.phase == Phase::Revoke)
    );
    assert_eq!(fixture.join().len(), 1);
}
