// Ported from VZRXS/bilikara PR #120 by FMPeach (MIT), commit 297ae1de,
// rust-runtime/src/show_dlna/discovery/tests.rs, with async cancellation regressions.
use super::*;
use crate::dlna::test_support::*;

#[test]
fn deeply_nested_description_from_notify_returns_structured_error() {
    let source = format!("<root>{}{}</root>", "<a>".repeat(5000), "</a>".repeat(5000));
    let fixture = Fixture::start(vec![Reply::raw(None, 200, source)]);
    let location = format!("http://{}/deep.xml", fixture.address);
    std::thread::Builder::new()
        .stack_size(2 * 1024 * 1024)
        .spawn(move || {
            run(async {
                let notify = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
                let target = notify.local_addr().unwrap();
                let sender = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
                sender
                    .send_to(
                        format!(
                            "NOTIFY * HTTP/1.1\r\nNTS: ssdp:alive\r\nLOCATION: {location}\r\n\r\n"
                        )
                        .as_bytes(),
                        target,
                    )
                    .await
                    .unwrap();
                let mut stages = StageLog::default();
                let result = collect_renderers(
                    &[Ipv4Addr::LOCALHOST],
                    NetworkPolicy::LoopbackFixture,
                    options(target, Duration::from_millis(300)),
                    Sockets {
                        search: Vec::new(),
                        notify: Some(notify),
                    },
                    &CancellationToken::new(),
                    &mut |_| {},
                    &mut stages,
                )
                .await
                .unwrap();
                assert!(result.is_empty());
                assert!(stages.iter().any(|stage| {
                    stage.stage == Stage::Description
                        && stage.result.as_ref().is_err_and(|error| {
                            error.code == ErrorCode::Policy(PolicyError::TooDeep)
                        })
                }));
            })
        })
        .unwrap()
        .join()
        .unwrap();
    fixture.join();
}

fn options(destination: SocketAddr, window: Duration) -> Options {
    Options {
        window,
        destination,
        notify_port: 0,
        ..Options::default()
    }
}

#[test]
fn msearch_visits_each_interface_and_all_targets_without_vendor_filtering() {
    let fixture = Fixture::start(vec![Reply::raw(
        None,
        200,
        description(
            "Ordinary MediaRenderer",
            "<manufacturer>Example TV</manufacturer>",
        ),
    )]);
    let location = format!("http://{}/device.xml", fixture.address);
    run(async {
        let udp = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let destination = udp.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let mut seen = HashSet::new();
            let mut buffer = [0; 4096];
            for _ in 0..SEARCH_TARGETS.len() * 2 {
                let (length, peer) =
                    tokio::time::timeout(Duration::from_secs(2), udp.recv_from(&mut buffer))
                        .await
                        .unwrap()
                        .unwrap();
                let request = std::str::from_utf8(&buffer[..length]).unwrap();
                assert!(request.starts_with("M-SEARCH * HTTP/1.1\r\n"));
                assert!(request.contains("\r\nMX: 2\r\n"));
                let target = request
                    .lines()
                    .find_map(|line| line.strip_prefix("ST: "))
                    .unwrap();
                seen.insert((peer.ip(), target.to_owned()));
                let response = format!(
                    "HTTP/1.1 200 OK\r\nLOCATION: {location}\r\nUSN: uuid:fixture::upnp:rootdevice\r\nSERVER: Example/1.0\r\n\r\n"
                );
                udp.send_to(response.as_bytes(), peer).await.unwrap();
            }
            seen
        });
        let local = Ipv4Addr::LOCALHOST;
        let alias = Ipv4Addr::new(127, 0, 0, 2);
        let mut updates = Vec::new();
        let operation = discover_on(
            vec![local, alias],
            NetworkPolicy::LoopbackFixture,
            options(destination, Duration::from_millis(800)),
            &CancellationToken::new(),
            |update| updates.push(update),
        )
        .await;
        let renderers = operation.result.unwrap();
        assert_eq!(renderers.len(), 1);
        assert_eq!(renderers[0].description.name, "Ordinary MediaRenderer");
        assert_eq!(
            renderers[0].description.vendor_class,
            dlna_policy::VendorClass::Generic
        );
        assert_eq!(renderers[0].local_address, local);
        assert_eq!(renderers[0].context.source, DiscoverySource::SearchResponse);
        assert_eq!(renderers[0].context.server, "Example/1.0");
        assert!(
            operation
                .stages
                .iter()
                .filter(|stage| matches!(stage.stage, Stage::Route | Stage::Description))
                .all(|stage| stage.context.as_ref().unwrap().device_key
                    == renderers[0].context.device_key)
        );
        assert!(
            updates
                .iter()
                .any(|u| matches!(u, DiscoveryUpdate::Renderers(r) if r.len() == 1))
        );
        let seen = server.await.unwrap();
        for ip in [local, alias] {
            for target in &SEARCH_TARGETS[..3] {
                assert!(
                    seen.contains(&(IpAddr::V4(ip), target.to_string())),
                    "{ip} {target}"
                );
            }
        }
    });
    let requests = fixture.join();
    assert_eq!(requests.len(), 1); // Duplicate advertisements do not refetch.
    assert!(requests[0].headers.starts_with("GET /device.xml "));
    assert_eq!(requests[0].peer.ip(), IpAddr::V4(Ipv4Addr::LOCALHOST));
}

#[test]
fn unsolicited_notify_loads_a_description_and_withdraws_before_search_ends() {
    let fixture = Fixture::start(vec![Reply::raw(None, 200, description("Notify Only", ""))]);
    let location = format!("http://{}/device.xml", fixture.address);
    run(async {
        let notify = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let target = notify.local_addr().unwrap();
        let sender = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let cancel = CancellationToken::new();
        let trigger = cancel.clone();
        let (published, mut snapshots) = tokio::sync::mpsc::unbounded_channel();
        let worker = tokio::spawn(async move {
            let mut stages = StageLog::default();
            collect_renderers(
                &[Ipv4Addr::LOCALHOST],
                NetworkPolicy::LoopbackFixture,
                options(target, Duration::from_secs(4)),
                Sockets {
                    search: Vec::new(),
                    notify: Some(notify),
                },
                &trigger,
                &mut |update| {
                    if let DiscoveryUpdate::Renderers(renderers) = update {
                        published.send(renderers).unwrap();
                    }
                },
                &mut stages,
            )
            .await
        });
        let alive = format!(
            "NOTIFY * HTTP/1.1\r\nNTS: ssdp:alive\r\nUSN: UUID:Fixture::{}\r\nLOCATION: {location}\r\n\r\n",
            dlna_policy::MEDIA_RENDERER
        );
        sender.send_to(alive.as_bytes(), target).await.unwrap();
        sender.send_to(alive.as_bytes(), target).await.unwrap();
        let found = tokio::time::timeout(Duration::from_secs(2), snapshots.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].description.name, "Notify Only");
        assert_eq!(found[0].context.source, DiscoverySource::Notify);
        let byebye =
            b"NOTIFY * HTTP/1.1\r\nNTS: ssdp:byebye\r\nUSN: uuid:fixture::upnp:rootdevice\r\n\r\n";
        let spoof = UdpSocket::bind((Ipv4Addr::new(127, 0, 0, 2), 0))
            .await
            .unwrap();
        spoof.send_to(byebye, target).await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(80), snapshots.recv())
                .await
                .is_err()
        );
        sender.send_to(byebye, target).await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_secs(1), snapshots.recv())
                .await
                .unwrap()
                .unwrap()
                .is_empty()
        );
        cancel.cancel();
        assert!(
            tokio::time::timeout(Duration::from_millis(100), worker)
                .await
                .unwrap()
                .unwrap()
                .unwrap_err()
                .is_cancelled()
        );
    });
    fixture.join();
}

#[test]
fn no_interfaces_and_notify_port_conflicts_degrade_without_panicking() {
    run(async {
        let operation = discover_on(
            Vec::new(),
            NetworkPolicy::LoopbackFixture,
            Options::default(),
            &CancellationToken::new(),
            |_| {},
        )
        .await;
        assert_eq!(operation.result.unwrap_err().code, ErrorCode::NoInterfaces);
        assert_eq!(operation.stages.last().unwrap().stage, Stage::Discovery);
        let occupied = StdUdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).unwrap();
        let port = occupied.local_addr().unwrap().port();
        let mut stages = Vec::new();
        let sockets = open_sockets(&[Ipv4Addr::LOCALHOST], port, &mut |stage| {
            stages.push(stage)
        });
        assert_eq!(sockets.search.len(), 1);
        assert!(sockets.notify.is_none());
        let notify_error = stages
            .iter()
            .find(|s| s.stage == Stage::NotifyListen)
            .unwrap();
        assert_eq!(
            notify_error.result.as_ref().unwrap_err().code,
            ErrorCode::SocketBind
        );
        assert_eq!(notify_error.disposition, Disposition::Ignored);
        let destination = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let operation = discover_on(
            vec![Ipv4Addr::LOCALHOST],
            NetworkPolicy::LoopbackFixture,
            Options {
                window: Duration::from_millis(60),
                destination: destination.local_addr().unwrap(),
                notify_port: port,
                ..Options::default()
            },
            &CancellationToken::new(),
            |_| {},
        )
        .await;
        assert!(operation.result.unwrap().is_empty());
    });
}

#[test]
fn route_source_must_be_one_of_the_actual_interface_facts() {
    let source = route_source_on(
        Ipv4Addr::LOCALHOST,
        &[Ipv4Addr::LOCALHOST],
        NetworkPolicy::LoopbackFixture,
    )
    .unwrap();
    assert_eq!(source, Ipv4Addr::LOCALHOST);
    assert_eq!(
        route_source_on(Ipv4Addr::LOCALHOST, &[], NetworkPolicy::LoopbackFixture)
            .unwrap_err()
            .code,
        ErrorCode::Policy(PolicyError::RouteNotLocal)
    );
    assert!(route_source(Ipv4Addr::LOCALHOST).is_err());
    assert!(route_source(Ipv4Addr::new(1, 1, 1, 1)).is_err());
}

#[test]
fn manual_description_url_accepts_relaxed_descriptions_and_marks_lebo() {
    for source in [
        description("客厅乐播", "<manufacturer>HPPLAY</manufacturer>").replace("<device>", "<URLBase>http://192.168.2.20/</URLBase><device>"),
        description("LeBo TV", "").replace(">/control<", ">/control?first=1&amp;second=2<"),
        description("乐播", "").replace("</serviceList>", "<service><serviceType>urn:schemas-upnp-org:service:AVTransport:2</serviceType><controlURL>_urn:control?ok=1</controlURL></service></serviceList>"),
    ] {
        let fixture = Fixture::start(vec![Reply::raw(None, 200, source)]);
        let location = format!("http://{}/device.xml", fixture.address);
        let operation = run(load_on(&location, "", "", &[Ipv4Addr::LOCALHOST], NetworkPolicy::LoopbackFixture, HTTP_TIMEOUT, &CancellationToken::new()));
        assert_eq!(operation.result.unwrap().description.vendor_class, dlna_policy::VendorClass::Lebo);
        assert_eq!(operation.stages.len(), 2);
        assert_eq!(operation.stages[0].stage, Stage::Route);
        assert_eq!(operation.stages[1].stage, Stage::Description);
        fixture.join();
    }
    let source = description("External", "").replace(">/control<", ">http://127.0.0.2/control<");
    let fixture = Fixture::start(vec![Reply::raw(None, 200, source)]);
    let location = format!("http://{}/device.xml", fixture.address);
    assert_eq!(
        run(load_on(
            &location,
            "",
            "",
            &[Ipv4Addr::LOCALHOST],
            NetworkPolicy::LoopbackFixture,
            HTTP_TIMEOUT,
            &CancellationToken::new()
        ))
        .result
        .unwrap_err()
        .code,
        ErrorCode::Policy(PolicyError::ExternalControl)
    );
    fixture.join();
}

#[test]
fn cancelling_discovery_with_a_pending_description_returns_within_100ms() {
    run(async {
        use tokio::io::AsyncReadExt;
        let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let location = format!("http://{}/device.xml", listener.local_addr().unwrap());
        let (requested, ready) = tokio::sync::oneshot::channel();
        let server_stop = CancellationToken::new();
        let stopping = server_stop.clone();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut header = Vec::new();
            while !header.ends_with(b"\r\n\r\n") {
                header.push(stream.read_u8().await.unwrap());
            }
            requested.send(()).unwrap();
            // Hold the response until the test has observed cancellation.
            stopping.cancelled().await;
        });
        let notify = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let address = notify.local_addr().unwrap();
        let sender = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let cancel = CancellationToken::new();
        let trigger = cancel.clone();
        let worker = tokio::spawn(async move {
            let mut stages = StageLog::default();
            let result = collect_renderers(
                &[Ipv4Addr::LOCALHOST],
                NetworkPolicy::LoopbackFixture,
                options(address, SEARCH_WINDOW),
                Sockets {
                    search: Vec::new(),
                    notify: Some(notify),
                },
                &trigger,
                &mut |_| {},
                &mut stages,
            )
            .await;
            (result, stages)
        });
        sender
            .send_to(
                format!("NOTIFY * HTTP/1.1\r\nNTS: ssdp:alive\r\nLOCATION: {location}\r\n\r\n")
                    .as_bytes(),
                address,
            )
            .await
            .unwrap();
        tokio::time::timeout(HTTP_TIMEOUT, ready)
            .await
            .unwrap()
            .unwrap();
        let cancelled_at = Instant::now();
        cancel.cancel();
        let (result, stages) = tokio::time::timeout(Duration::from_millis(100), worker)
            .await
            .unwrap()
            .unwrap();
        assert!(cancelled_at.elapsed() < Duration::from_millis(100));
        assert!(result.unwrap_err().is_cancelled());
        assert!(stages.iter().any(|stage| stage.stage == Stage::Description
            && stage.result.as_ref().is_err_and(DlnaError::is_cancelled)));
        // The listener is released along with cancellation, not after HTTP timeout.
        StdUdpSocket::bind(address).unwrap();
        server_stop.cancel();
        server.await.unwrap();
    });
}

#[test]
fn failed_descriptions_retry_only_on_later_advertisements_and_byebye_aborts_inflight() {
    let fixture = Fixture::start(vec![
        Reply::raw(None, 503, "busy"),
        Reply::raw(None, 200, description("Ready", "")),
    ]);
    let location = format!("http://{}/device.xml", fixture.address);
    run(async {
        let notify = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let address = notify.local_addr().unwrap();
        let sender = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let mut updates = Vec::new();
        let packet =
            format!("NOTIFY * HTTP/1.1\r\nNTS: ssdp:alive\r\nLOCATION: {location}\r\n\r\n");
        let announcer = tokio::spawn(async move {
            sender.send_to(packet.as_bytes(), address).await.unwrap();
            tokio::time::sleep(Duration::from_millis(1200)).await;
            sender.send_to(packet.as_bytes(), address).await.unwrap();
        });
        let mut stages = StageLog::default();
        let result = collect_renderers(
            &[Ipv4Addr::LOCALHOST],
            NetworkPolicy::LoopbackFixture,
            options(address, Duration::from_millis(1500)),
            Sockets {
                search: Vec::new(),
                notify: Some(notify),
            },
            &CancellationToken::new(),
            &mut |u| updates.push(u),
            &mut stages,
        )
        .await
        .unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].description.name, "Ready");
        assert!(
            stages
                .iter()
                .any(|s| s.stage == Stage::Description && s.http_status == Some(503))
        );
        announcer.await.unwrap();
    });
    fixture.join();

    let fixture = Fixture::start(vec![
        Reply::raw(None, 200, description("Too late", "")).delayed(Duration::from_millis(250)),
    ]);
    let location = format!("http://{}/device.xml", fixture.address);
    run(async {
        let notify = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let address = notify.local_addr().unwrap();
        let sender = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let server = tokio::spawn(async move {
            sender.send_to(format!("NOTIFY * HTTP/1.1\r\nNTS: ssdp:alive\r\nUSN: uuid:fixture\r\nLOCATION: {location}\r\n\r\n").as_bytes(), address).await.unwrap();
            tokio::time::sleep(Duration::from_millis(100)).await;
            sender
                .send_to(
                    b"NOTIFY * HTTP/1.1\r\nNTS: ssdp:byebye\r\nUSN: uuid:fixture\r\n\r\n",
                    address,
                )
                .await
                .unwrap();
        });
        let result = collect_renderers(
            &[Ipv4Addr::LOCALHOST],
            NetworkPolicy::LoopbackFixture,
            options(address, Duration::from_millis(500)),
            Sockets {
                search: Vec::new(),
                notify: Some(notify),
            },
            &CancellationToken::new(),
            &mut |_| {},
            &mut StageLog::default(),
        )
        .await
        .unwrap();
        assert!(result.is_empty());
        server.await.unwrap();
    });
    fixture.join();
}

#[test]
fn description_size_limits_and_redirects_are_recorded_without_following() {
    for chunked in [false, true] {
        let mut reply = Reply::raw(
            None,
            200,
            "x".repeat(dlna_policy::MAX_DESCRIPTION_BYTES + 1),
        );
        reply.chunked = chunked;
        let fixture = Fixture::start(vec![reply]);
        let location = format!("http://{}/device.xml", fixture.address);
        let error = run(load_on(
            &location,
            "",
            "",
            &[Ipv4Addr::LOCALHOST],
            NetworkPolicy::LoopbackFixture,
            HTTP_TIMEOUT,
            &CancellationToken::new(),
        ))
        .result
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::Policy(PolicyError::TooLarge));
        fixture.join();
    }
    let mut reply = Reply::raw(None, 302, "moved");
    reply.headers = "Location: http://127.0.0.1:1/admin\r\n".into();
    let fixture = Fixture::start(vec![reply]);
    let location = format!("http://{}/device.xml", fixture.address);
    let error = run(load_on(
        &location,
        "",
        "",
        &[Ipv4Addr::LOCALHOST],
        NetworkPolicy::LoopbackFixture,
        HTTP_TIMEOUT,
        &CancellationToken::new(),
    ))
    .result
    .unwrap_err();
    assert_eq!(error.http_status, Some(302));
    fixture.join();
}

fn nonlocal_route(_: Ipv4Addr) -> Result<Ipv4Addr, DlnaError> {
    Ok(Ipv4Addr::new(10, 7, 0, 2))
}
fn tun_route(_: Ipv4Addr) -> Result<Ipv4Addr, DlnaError> {
    Ok(Ipv4Addr::new(198, 18, 0, 1))
}

#[test]
fn msearch_reply_interface_survives_nonlocal_and_virtual_routes() {
    for lookup in [nonlocal_route as fn(_) -> _, tun_route] {
        let fixture = Fixture::start(vec![Reply::raw(None, 200, description("Fallback TV", ""))]);
        let location = format!("http://{}/device.xml", fixture.address);
        run(async {
            let udp = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
            let destination = udp.local_addr().unwrap();
            let responder = tokio::spawn(async move {
                let mut buffer = [0; 2048];
                let (_, peer) = udp.recv_from(&mut buffer).await.unwrap();
                udp.send_to(format!("HTTP/1.1 200 OK\r\nLOCATION: {location}\r\nUSN: uuid:fixture\r\nSERVER: Fallback/1\r\n\r\n").as_bytes(), peer).await.unwrap();
            });
            let operation = discover_on(
                vec![Ipv4Addr::LOCALHOST],
                NetworkPolicy::LoopbackFixture,
                Options {
                    route_lookup: lookup,
                    ..options(destination, Duration::from_millis(300))
                },
                &CancellationToken::new(),
                |_| {},
            )
            .await;
            let renderers = operation.result.unwrap();
            assert_eq!(renderers.len(), 1);
            assert_eq!(renderers[0].local_address, Ipv4Addr::LOCALHOST);
            let route = renderers[0].context.route.as_ref().unwrap();
            assert_eq!(route.selection, Some(LocalSourceKind::ReplyInterface));
            assert_eq!(route.routed_source_is_local, Some(false));
            assert_eq!(route.route_matches_reply, Some(false));
            assert_eq!(route.route_matches_selected, Some(false));
            assert!(
                operation
                    .stages
                    .iter()
                    .filter(|s| matches!(s.stage, Stage::Route | Stage::Description))
                    .all(|s| s.context.as_ref().unwrap().device_key
                        == renderers[0].context.device_key)
            );
            responder.await.unwrap();
        });
        assert_eq!(fixture.join().len(), 1);
    }
}

#[test]
fn location_flood_does_not_hide_a_later_real_renderer() {
    let fixture = Fixture::start(vec![Reply::raw(None, 200, description("Real TV", ""))]);
    let location = format!("http://{}/device.xml", fixture.address);
    // Reserve and release an unused TCP port; do not rely on any machine NIC.
    let unused = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let closed_port = unused.local_addr().unwrap().port();
    drop(unused);
    run(async {
        let notify = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let address = notify.local_addr().unwrap();
        let sender = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let announcer = tokio::spawn(async move {
            for index in 0..130 {
                sender.send_to(format!("NOTIFY * HTTP/1.1\r\nNTS: ssdp:alive\r\nLOCATION: http://127.0.0.1:{closed_port}/fake{index}.xml\r\n\r\n").as_bytes(), address).await.unwrap();
                if index % 32 == 31 {
                    tokio::time::sleep(Duration::from_millis(30)).await;
                }
            }
            for _ in 0..5 {
                sender.send_to(format!("NOTIFY * HTTP/1.1\r\nNTS: ssdp:alive\r\nLOCATION: {location}\r\nUSN: uuid:fixture\r\n\r\n").as_bytes(), address).await.unwrap();
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        });
        let renderers = collect_renderers(
            &[Ipv4Addr::LOCALHOST],
            NetworkPolicy::LoopbackFixture,
            options(address, Duration::from_millis(2500)),
            Sockets {
                search: Vec::new(),
                notify: Some(notify),
            },
            &CancellationToken::new(),
            &mut |_| {},
            &mut StageLog::default(),
        )
        .await
        .unwrap();
        announcer.await.unwrap();
        assert_eq!(renderers.len(), 1);
        assert_eq!(renderers[0].description.name, "Real TV");
    });
    assert_eq!(fixture.join().len(), 1);
}

#[test]
fn full_candidate_pool_preempts_stalled_http_for_a_later_renderer() {
    run(async {
        let stalled = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let stalled_address = stalled.local_addr().unwrap();
        let stop = CancellationToken::new();
        let stopping = stop.clone();
        let server = tokio::spawn(async move {
            let mut connections = Vec::new();
            loop {
                tokio::select! {
                    biased;
                    _ = stopping.cancelled() => break,
                    connection = stalled.accept() => {
                        connections.push(connection.unwrap().0);
                        assert!(connections.len() <= 32);
                    }
                }
            }
        });
        let notify = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let address = notify.local_addr().unwrap();
        let sender = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let (routed, mut routes) = tokio::sync::mpsc::unbounded_channel();
        let (discovered, discovery) = tokio::sync::oneshot::channel();
        let mut discovered = Some(discovered);
        let scan_stop = CancellationToken::new();
        let announcer = tokio::spawn(async move {
            for index in 0..130 {
                sender.send_to(format!("NOTIFY * HTTP/1.1\r\nNTS: ssdp:alive\r\nLOCATION: http://{stalled_address}/fake{index}.xml\r\n\r\n").as_bytes(), address).await.unwrap();
                if index % 32 == 31 || index == 129 {
                    let batch = if index == 129 { 2 } else { 32 };
                    for _ in 0..batch {
                        tokio::time::timeout(SEARCH_WINDOW, routes.recv())
                            .await
                            .unwrap()
                            .unwrap();
                    }
                }
            }
            // Start the HTTP fixture after setup so its accept deadline does
            // not include time spent preparing the full candidate pool.
            let fixture = Fixture::start(vec![Reply::raw(
                None,
                200,
                description("Responsive TV", ""),
            )]);
            let location = format!("http://{}/device.xml", fixture.address);
            // All 130 candidates are admitted before timing the real renderer.
            let advertised_at = Instant::now();
            sender
                .send_to(
                    format!("NOTIFY * HTTP/1.1\r\nNTS: ssdp:alive\r\nLOCATION: {location}\r\n\r\n")
                        .as_bytes(),
                    address,
                )
                .await
                .unwrap();
            (advertised_at, fixture)
        });
        let result = collect_renderers(
            &[Ipv4Addr::LOCALHOST],
            NetworkPolicy::LoopbackFixture,
            options(address, SEARCH_WINDOW),
            Sockets {
                search: Vec::new(),
                notify: Some(notify),
            },
            &scan_stop,
            &mut |update| match update {
                DiscoveryUpdate::Stage(stage) if stage.stage == Stage::Route => {
                    let _ = routed.send(());
                }
                DiscoveryUpdate::Renderers(renderers) if !renderers.is_empty() => {
                    discovered
                        .take()
                        .unwrap()
                        .send((renderers, Instant::now()))
                        .unwrap();
                    scan_stop.cancel();
                }
                _ => {}
            },
            &mut StageLog::default(),
        )
        .await;
        let (advertised_at, fixture) = announcer.await.unwrap();
        let (renderers, discovered_at) = discovery.await.unwrap();
        assert!(discovered_at.duration_since(advertised_at) <= Duration::from_millis(1000));
        assert!(result.unwrap_err().is_cancelled());
        stop.cancel();
        server.await.unwrap();
        assert_eq!(renderers.len(), 1);
        assert_eq!(renderers[0].description.name, "Responsive TV");
        fixture.join();
    });
}

#[test]
fn single_nonrenderer_advertisement_fetches_only_once_in_4500ms() {
    let source =
        description("Media Server", "").replace("device:MediaRenderer:1", "device:MediaServer:1");
    let fixture = CountingFixture::start(Reply::raw(None, 200, source));
    let location = format!("http://{}/server.xml", fixture.address);
    run(async {
        let notify = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let address = notify.local_addr().unwrap();
        let sender = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        sender
            .send_to(
                format!("NOTIFY * HTTP/1.1\r\nNTS: ssdp:alive\r\nLOCATION: {location}\r\n\r\n")
                    .as_bytes(),
                address,
            )
            .await
            .unwrap();
        let mut stages = StageLog::default();
        let result = collect_renderers(
            &[Ipv4Addr::LOCALHOST],
            NetworkPolicy::LoopbackFixture,
            options(address, Duration::from_millis(4500)),
            Sockets {
                search: Vec::new(),
                notify: Some(notify),
            },
            &CancellationToken::new(),
            &mut |_| {},
            &mut stages,
        )
        .await
        .unwrap();
        assert!(result.is_empty());
        assert_eq!(
            stages
                .iter()
                .filter(|s| s.stage == Stage::Description)
                .count(),
            1
        );
    });
    assert_eq!(fixture.count(), 1);
}

#[test]
fn repeated_terminal_or_single_transient_advertisements_do_not_refetch() {
    for (status, source, repeats) in [
        (
            200,
            description("Media Server", "")
                .replace("device:MediaRenderer:1", "device:MediaServer:1"),
            true,
        ),
        (503, "busy".to_owned(), false),
    ] {
        let fixture = CountingFixture::start(Reply::raw(None, status, source));
        let location = format!("http://{}/server.xml", fixture.address);
        run(async {
            let notify = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
            let address = notify.local_addr().unwrap();
            let sender = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
            let announcer = tokio::spawn(async move {
                for index in 0..9 {
                    if index == 0 || repeats {
                        sender.send_to(format!("NOTIFY * HTTP/1.1\r\nNTS: ssdp:alive\r\nLOCATION: {location}\r\n\r\n").as_bytes(), address).await.unwrap();
                    }
                    tokio::time::sleep(Duration::from_millis(150)).await;
                }
            });
            collect_renderers(
                &[Ipv4Addr::LOCALHOST],
                NetworkPolicy::LoopbackFixture,
                options(address, Duration::from_millis(1500)),
                Sockets {
                    search: Vec::new(),
                    notify: Some(notify),
                },
                &CancellationToken::new(),
                &mut |_| {},
                &mut StageLog::default(),
            )
            .await
            .unwrap();
            announcer.await.unwrap();
        });
        assert_eq!(fixture.count(), 1);
    }
}

#[test]
fn failed_candidate_backoff_is_bounded_and_negative_entries_expire() {
    let now = Instant::now();
    for attempt in 1..=3 {
        let failure = Failure::new(&DlnaError::new(ErrorCode::Connect), attempt, now);
        assert!(!failure.permits(now));
        assert_eq!(
            failure.retry_at.duration_since(now),
            Duration::from_secs(1 << (attempt - 1))
        );
        assert_eq!(failure.permits(failure.retry_at), attempt < 3);
        assert_eq!(failure.expires, now + FAILURE_TTL);
    }
    for code in [
        PolicyError::NotRenderer,
        PolicyError::MissingAvTransport,
        PolicyError::ExternalControl,
        PolicyError::InvalidXml,
        PolicyError::TooDeep,
        PolicyError::TooLarge,
    ] {
        let failure = Failure::new(&code.into(), 1, now);
        assert!(!failure.permits(now + Duration::from_secs(30)));
    }
    let mut failures = HashMap::from([(
        "negative".to_owned(),
        Failure::new(&PolicyError::NotRenderer.into(), 1, now),
    )]);
    let mut candidates = HashMap::from([(
        "queued".to_owned(),
        Candidate {
            load_id: 1,
            usn: String::new(),
            server: String::new(),
            helper: None,
            local: Ipv4Addr::LOCALHOST,
            renderer: None,
            context: DeviceContext::new(DiscoverySource::Notify, "unused", "", ""),
            attempt: 1,
            last_seen: 1,
            expires: now + CANDIDATE_TTL,
            loading: None,
        },
    )]);
    expire_entries(&mut candidates, &mut failures, now + FAILURE_TTL);
    assert!(failures.is_empty());
    assert_eq!(candidates.len(), 1);
    expire_entries(&mut candidates, &mut failures, now + CANDIDATE_TTL);
    assert!(candidates.is_empty());
}

#[test]
fn manual_device_context_correlates_description_and_control_without_raw_identifiers() {
    for id in ["uuid:first-room", "uuid:second-room"] {
        let fixture = Fixture::start(vec![
            Reply::raw(None, 200, description("TV", "").replace("uuid:fixture", id)),
            Reply::ok(SoapAction::Play),
        ]);
        let location = format!("http://{}/device.xml", fixture.address);
        let server = format!("Vendor/1 {}", "服".repeat(300));
        let operation = run(load_on(
            &location,
            "",
            &server,
            &[Ipv4Addr::LOCALHOST],
            NetworkPolicy::LoopbackFixture,
            HTTP_TIMEOUT,
            &CancellationToken::new(),
        ));
        let renderer = operation.result.unwrap();
        let context = &renderer.context;
        assert_eq!(context.source, DiscoverySource::Manual);
        assert_eq!(context.server.chars().count(), 256);
        assert_eq!(context.device_key.len(), 32);
        assert_eq!(context.udn_hash.as_ref().unwrap().len(), 32);
        assert_ne!(&context.device_key, context.udn_hash.as_ref().unwrap());
        for stage in operation.stages {
            assert_eq!(
                stage.context.as_ref().unwrap().device_key,
                context.device_key
            );
        }
        let diagnostic = format!("{context:?}");
        assert!(!diagnostic.contains("127.0.0.1"));
        assert!(!diagnostic.contains(&location));
        assert!(!diagnostic.contains(id));
        let context = context.clone();
        let client = control::ControlClient::with_policy(
            renderer,
            &[Ipv4Addr::LOCALHOST],
            NetworkPolicy::LoopbackFixture,
            HTTP_TIMEOUT,
        )
        .unwrap();
        let playing = run(client.play(&CancellationToken::new()));
        playing.result.unwrap();
        assert_eq!(
            playing.stages[0].context.as_ref().unwrap().device_key,
            context.device_key
        );
        assert_eq!(
            playing.stages[0].context.as_ref().unwrap().udn_hash,
            context.udn_hash
        );
        assert_eq!(fixture.join().len(), 2);
    }
}

#[test]
fn missing_udn_keeps_the_url_correlation_key_without_claiming_a_udn_hash() {
    let source = description("No UDN", "").replace("<UDN>uuid:fixture</UDN>", "");
    let fixture = Fixture::start(vec![Reply::raw(None, 200, source)]);
    let location = format!("http://{}/device.xml", fixture.address);
    let operation = run(load_on(
        &location,
        "",
        "",
        &[Ipv4Addr::LOCALHOST],
        NetworkPolicy::LoopbackFixture,
        HTTP_TIMEOUT,
        &CancellationToken::new(),
    ));
    let renderer = operation.result.unwrap();
    assert!(renderer.context.udn_hash.is_none());
    assert!(
        operation
            .stages
            .iter()
            .all(|stage| stage.context.as_ref().unwrap().device_key == renderer.context.device_key)
    );
    fixture.join();
}

#[test]
fn stage_retention_overflow_counts_drops_and_still_publishes_later_devices() {
    let context = DeviceContext::new(
        DiscoverySource::Notify,
        "http://192.168.1.2/device",
        "uuid:early",
        "Early/1",
    );
    let late = DeviceContext::new(
        DiscoverySource::SearchResponse,
        "http://192.168.1.3/device",
        "uuid:late",
        "Late/1",
    );
    let mut log = StageLog::default();
    let mut updates = Vec::new();
    for _ in 0..MAX_STAGES {
        record(
            StageResult::new(Stage::Route, Instant::now(), None, &Ok::<_, DlnaError>(()))
                .for_device(&context),
            &mut |u| updates.push(u),
            &mut log,
        );
    }
    record(
        StageResult::new(
            Stage::Description,
            Instant::now(),
            Some(200),
            &Ok::<_, DlnaError>(()),
        )
        .for_device(&late),
        &mut |u| updates.push(u),
        &mut log,
    );
    assert_eq!(log.entries.len(), MAX_STAGES - 1);
    assert_eq!(log.dropped, 2);
    assert!(updates.iter().any(|u| matches!(u, DiscoveryUpdate::Stage(stage) if stage.context.as_ref().is_some_and(|c| c.device_key == late.device_key))));
    assert!(matches!(
        updates.last(),
        Some(DiscoveryUpdate::StagesDropped(2))
    ));
}
