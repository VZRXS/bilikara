use super::*;
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::Mutex,
};

fn qr(base: &str, token: &str) -> String {
    let mut inner = Url::parse("https://conn.dolphinstar.cn/Remote").unwrap();
    inner
        .query_pairs_mut()
        .append_pair("url", base)
        .append_pair("token", token)
        .append_pair("name", "Fixture room");
    let mut outer = Url::parse("https://wx.chunk.cn/projection/login").unwrap();
    outer
        .query_pairs_mut()
        .append_pair(
            "projection_url",
            &base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(inner.as_str()),
        )
        .append_pair("place_code", "fixture");
    outer.into()
}
fn description(identity: &str, control: &str) -> String {
    format!(
        "<root xmlns=\"urn:schemas-upnp-org:device-1-0\"><device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType><UDN>uuid:{identity}</UDN><friendlyName>Fixture room</friendlyName><serviceList><service><serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType><controlURL>{control}</controlURL></service></serviceList></device></root>"
    )
}
const SOAP: &str = "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body><u:SetDeviceAuthorizationResponse xmlns:u=\"urn:schemas-upnp-org:service:ConnectionManager:1\"/></s:Body></s:Envelope>";
fn media_description() -> String {
    description("fixture", "/control").replace("</serviceList>", "<service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/transport</controlURL></service><service><serviceType>urn:schemas-upnp-org:service:RenderingControl:2</serviceType><controlURL>/rendering</controlURL></service></serviceList>")
}

#[test]
fn network_xml_depth_is_bounded_on_a_two_mib_stack() {
    thread::Builder::new()
        .stack_size(2 * 1024 * 1024)
        .spawn(|| {
            let location = Url::parse("http://192.168.1.8/description.xml").unwrap();
            let service = "urn:schemas-upnp-org:service:ConnectionManager:1";
            for depth in [65, 5000] {
                // Fake closes in lexical sections must not hide real nesting.
                let text = format!(
                    "{}<!-- </n> --><![CDATA[</n>]]><?pi </n>?>secret{}",
                    "<n>".repeat(depth),
                    "</n>".repeat(depth)
                );
                let error = protocol::xml(&text).err().unwrap();
                assert_eq!(error.code, "purek_protocol");
                assert!(error.to_string().contains("嵌套过深"));
                assert!(!error.to_string().contains("secret"));
                assert_eq!(
                    Renderer::parse(&text, &location).err().unwrap().code,
                    "purek_protocol"
                );
                assert_eq!(
                    protocol::authorization_result(&text, service)
                        .unwrap_err()
                        .code,
                    "purek_protocol"
                );
                assert_eq!(
                    protocol::authorization_fault(&text, service).code,
                    "purek_http"
                );
                assert_eq!(
                    renderer::protocol_info(&text, service).err().unwrap().code,
                    "purek_protocol_info"
                );
            }
            for depth in [1, 63, 64] {
                for leaf in ["<n/>", "<n></n>"] {
                    let text = format!(
                        "{}{leaf}{}",
                        "<n>".repeat(depth - 1),
                        "</n>".repeat(depth - 1)
                    );
                    let doc = protocol::xml(&text).unwrap();
                    assert_eq!(doc.descendants().filter(|n| n.is_element()).count(), depth);
                }
            }
            let empty_leaf_at_65 = format!("{}<n/>{}", "<n>".repeat(64), "</n>".repeat(64));
            assert!(protocol::xml(&empty_leaf_at_65).is_err());
            Renderer::parse(&media_description(), &location).unwrap();
            protocol::authorization_result(SOAP, service).unwrap();
            renderer::protocol_info(&protocol_reply("http-get:*:video/MP2T:*"), service).unwrap();
        })
        .unwrap()
        .join()
        .unwrap();
}

#[test]
fn network_xml_scan_respects_lexical_sections_and_quoted_attributes() {
    let text = format!(
        "<?xml version=\"1.0\"?>{}<叶 a=\"> /&gt; &lt;\" b='> /&lt;'><!-- {} --><![CDATA[{}]]><?pi {}?></叶>{}",
        "<n>".repeat(63),
        "<fake></n>".repeat(80),
        "<fake></n>".repeat(80),
        "<fake></n>".repeat(80),
        "</n>".repeat(63)
    );
    let doc = protocol::xml(&text).unwrap();
    assert_eq!(doc.descendants().filter(|n| n.is_element()).count(), 64);
    let leaf = doc.descendants().find(|n| n.has_tag_name("叶")).unwrap();
    assert_eq!(leaf.attribute("a"), Some("> /> <"));
    assert_eq!(leaf.attribute("b"), Some("> /<"));
    assert_eq!(
        leaf.children()
            .find(|n| n.is_text())
            .unwrap()
            .text()
            .unwrap(),
        "<fake></n>".repeat(80)
    );

    // Skipped lexical sections cannot lower the depth before a malicious leaf.
    for decoy in ["<!-- </n> -->", "<![CDATA[</n>]]>", "<?pi </n>?>"] {
        let text = format!("{}{decoy}<n/>{}", "<n>".repeat(64), "</n>".repeat(64));
        assert!(protocol::xml(&text).is_err());
    }
    for invalid in [
        "<n a='<fake>'/>",
        "<n a='unterminated/>",
        "<n><fake</n>",
        "<n><!-- unterminated</n>",
        "<n><![CDATA[unterminated</n>",
        "<n><?pi unterminated</n>",
        "</n><n/>",
        "<!DOCTYPE n [<!ENTITY x '<n/>'>]><n>&x;</n>",
    ] {
        assert_eq!(protocol::xml(invalid).err().unwrap().code, "purek_protocol");
    }
}

#[test]
fn network_xml_size_budget_also_applies_to_direct_parser_calls() {
    let mut text = format!("<root>{}</root>", "x".repeat(1024 * 1024 - 13));
    assert_eq!(text.len(), 1024 * 1024);
    assert!(protocol::xml(&text).is_ok());
    text.push(' ');
    let error = protocol::xml(&text).err().unwrap();
    assert_eq!(error.code, "purek_protocol");
    assert_eq!(error.message, "房台响应过大");
}

fn protocol_reply(sink: &str) -> String {
    format!(
        "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body><u:GetProtocolInfoResponse xmlns:u=\"urn:schemas-upnp-org:service:ConnectionManager:1\"><Source/><Sink>{sink}</Sink></u:GetProtocolInfoResponse></s:Body></s:Envelope>"
    )
}
struct Fixture {
    base: String,
    seen: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}
impl Fixture {
    fn start(reply: impl Fn(&str, usize) -> (u16, String) + Send + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let captured = seen.clone();
        let stopping = stop.clone();
        let worker = thread::spawn(move || {
            while !stopping.load(Ordering::Acquire) {
                let Ok((mut stream, _)) = listener.accept() else {
                    thread::sleep(Duration::from_millis(5));
                    continue;
                };
                // Windows sockets inherit the listener's non-blocking mode.
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut data = Vec::new();
                let mut chunk = [0; 4096];
                loop {
                    let size = stream.read(&mut chunk).unwrap_or(0);
                    if size == 0 {
                        break;
                    }
                    data.extend_from_slice(&chunk[..size]);
                    if let Some(offset) = data.windows(4).position(|w| w == b"\r\n\r\n") {
                        let header = String::from_utf8_lossy(&data[..offset]);
                        let length = header
                            .lines()
                            .find_map(|s| {
                                s.to_lowercase()
                                    .strip_prefix("content-length:")
                                    .and_then(|s| s.trim().parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if data.len() >= offset + 4 + length {
                            break;
                        }
                    }
                }
                let request = String::from_utf8(data).unwrap();
                let count = {
                    let mut seen = captured.lock().unwrap();
                    seen.push(request.clone());
                    seen.len()
                };
                let (status, body) = reply(&request, count);
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nConnection: close\r\nLocation: http://127.0.0.1:1/forbidden\r\n\r\n{body}",
                    body.len()
                );
            }
        });
        Self {
            base,
            seen,
            stop,
            thread: Some(worker),
        }
    }
    fn room(&self) -> Room {
        Room::parse(&qr(&self.base, "synthetic+secret<&")).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        let _ = self.thread.take().unwrap().join();
    }
}

#[test]
fn qr_is_strict_and_preserves_opaque_tokens() {
    let raw = qr("http://192.168.1.8:1234/render", "a+b/c=&<");
    let room = Room::parse(&raw).unwrap();
    assert_eq!(room.authorization.as_ref().unwrap().token, "a+b/c=&<");
    assert_eq!(
        room.description.as_str(),
        "http://192.168.1.8:1234/render/description.xml"
    );
    for raw in [
        raw.replace("wx.chunk.cn", "evil.example"),
        format!("{raw}&place_code=duplicate"),
        qr("http://8.8.8.8", "x"),
        qr("http://example.com", "x"),
        qr("http://user:pass@192.168.1.8", "x"),
    ] {
        assert!(Room::parse(&raw).is_err());
    }
    let state = RoomState {
        room: Some(room),
        ..Default::default()
    };
    let snapshot = state.snapshot().to_string();
    assert!(!snapshot.contains("a+b"));
    assert!(!snapshot.contains("projection_url"));
    assert!(!snapshot.contains("192.168"));
}

#[test]
fn ordinary_dlna_input_is_local_explicit_and_has_no_vendor_authorization() {
    let room = Room::from_input("http://192.168.1.8:8200/renderer/device.xml").unwrap();
    assert_eq!(room.connection_type(), "dlna");
    assert!(room.authorization.is_none());
    assert_eq!(room.description.path(), "/renderer/device.xml");
    for input in [
        "https://example.com/device.xml",
        "http://8.8.8.8/device.xml",
        "file:///tmp/device.xml",
        "http://user:pass@192.168.1.8/device.xml",
        "http://192.168.1.8/device.xml?token=secret",
        "http://192.168.1.8/device.xml#fragment",
        "http://[::1]/device.xml",
        "http://169.254.1.8/device.xml",
        "http://192.168.1.8/\ndevice.xml",
    ] {
        assert!(
            Room::from_input(input).is_err(),
            "invalid description input accepted"
        );
    }
    assert_eq!(
        Room::from_input(&qr("http://192.168.1.8", "opaque"))
            .unwrap()
            .connection_type(),
        "purek"
    );
    let state = RoomState {
        room: Some(room),
        ..Default::default()
    }
    .snapshot()
    .to_string();
    assert!(!state.contains("192.168") && !state.contains("device.xml"));
}

#[test]
fn ordinary_dlna_connect_and_release_use_only_standard_services() {
    let fixture = Fixture::start(|request, _| {
        if request.starts_with("GET /renderer/device.xml ") {
            (200, media_description())
        } else if request.contains("#GetProtocolInfo") {
            (200, protocol_reply("http-get:*:video/MP2T:*"))
        } else {
            panic!("non-standard receiver request")
        }
    });
    let room = Room::dlna(&format!("{}/renderer/device.xml", fixture.base)).unwrap();
    let connection = connect_with(room, |_, _| {
        panic!("ordinary DLNA never advertises the receiver")
    })
    .unwrap();
    assert_eq!(connection.room.name, "Fixture room");
    assert_eq!(renderer::probe(&connection).unwrap().formats.len(), 1);
    release(&connection).unwrap();
    let seen = fixture.seen.lock().unwrap();
    assert_eq!(seen.len(), 3);
    assert_eq!(seen.iter().filter(|r| r.starts_with("GET ")).count(), 2);
    assert!(
        !seen
            .iter()
            .any(|r| r.contains("SetDeviceAuthorization") || r.contains("Token"))
    );
}

#[test]
fn ordinary_dlna_avtransport_uses_service_version_instance_zero_and_standard_actions() {
    for version in [1, 2] {
        let playing = AtomicBool::new(false);
        let fixture = Fixture::start(move |request, _| {
            if request.starts_with("GET ") {
                return (
                    200,
                    media_description().replace(
                        "service:AVTransport:1",
                        &format!("service:AVTransport:{version}"),
                    ),
                );
            }
            let body = request.split_once("\r\n\r\n").unwrap().1;
            let doc = protocol::xml(body).unwrap();
            let action = doc
                .root_element()
                .children()
                .find(|n| n.has_tag_name(("http://schemas.xmlsoap.org/soap/envelope/", "Body")))
                .unwrap()
                .children()
                .find(|n| n.is_element())
                .unwrap();
            let name = action.tag_name().name();
            let service = format!("urn:schemas-upnp-org:service:AVTransport:{version}");
            assert_eq!(action.tag_name().namespace(), Some(service.as_str()));
            assert!(
                request
                    .to_lowercase()
                    .contains(&format!("soapaction: \"{service}#{name}\"").to_lowercase())
            );
            assert_eq!(
                action
                    .children()
                    .find(|n| n.has_tag_name("InstanceID"))
                    .unwrap()
                    .text(),
                Some("0")
            );
            let fields = match name {
                "Stop" => { playing.store(false, Ordering::Release); String::new() },
                "Play" => {
                    assert_eq!(action.children().find(|n| n.has_tag_name("Speed")).unwrap().text(), Some("1"));
                    playing.store(true, Ordering::Release); String::new()
                },
                "SetAVTransportURI" => {
                    let uri = action.children().find(|n| n.has_tag_name("CurrentURI")).unwrap().text().unwrap();
                    assert_eq!(uri, "http://127.0.0.1/live.ts?a=1&b=2");
                    let metadata = action.children().find(|n| n.has_tag_name("CurrentURIMetaData")).unwrap().text().unwrap();
                    let didl = protocol::xml(metadata).unwrap();
                    assert_eq!(didl.descendants().find(|n| n.tag_name().name() == "res").unwrap().text(), Some(uri));
                    String::new()
                },
                "GetTransportInfo" => format!("<CurrentTransportState>{}</CurrentTransportState><CurrentTransportStatus>OK</CurrentTransportStatus><CurrentSpeed>1</CurrentSpeed>", if playing.load(Ordering::Acquire) { "PLAYING" } else { "STOPPED" }),
                "GetPositionInfo" => "<Track>1</Track><TrackDuration>00:00:06</TrackDuration><TrackMetaData/><TrackURI/><RelTime>00:00:01</RelTime><AbsTime>00:00:01</AbsTime><RelCount>-1</RelCount><AbsCount>-1</AbsCount>".into(),
                _ => panic!("non-standard AVTransport action"),
            };
            (
                200,
                transport_reply(name, &fields).replace(
                    "service:AVTransport:1",
                    &format!("service:AVTransport:{version}"),
                ),
            )
        });
        let connection = connect_with(
            Room::dlna(&format!("{}/device.xml", fixture.base)).unwrap(),
            |_, _| panic!("no SSDP impersonation"),
        )
        .unwrap();
        renderer::start_transport(
            &connection,
            "http://127.0.0.1/live.ts?a=1&b=2",
            "http-get:*:video/MP2T:*",
        )
        .unwrap();
        assert_eq!(renderer::transport_state(&connection).unwrap(), "PLAYING");
        let position = renderer::transport(&connection, "GetPositionInfo", "").unwrap();
        assert!(position.contains("<RelTime>00:00:01</RelTime>"));
        for unsupported in ["Pause", "Seek", "SetDeviceAuthorization"] {
            assert!(renderer::transport(&connection, unsupported, "").is_err());
        }
        renderer::transport(&connection, "Stop", "").unwrap();
        assert_eq!(renderer::transport_state(&connection).unwrap(), "STOPPED");
        let requests = fixture.seen.lock().unwrap();
        let actions: Vec<_> = requests
            .iter()
            .filter_map(|r| r.split("#").nth(1).and_then(|r| r.split('"').next()))
            .collect();
        assert_eq!(
            actions,
            [
                "Stop",
                "SetAVTransportURI",
                "Play",
                "GetTransportInfo",
                "GetPositionInfo",
                "Stop",
                "GetTransportInfo"
            ]
        );
    }
}
#[test]
fn renderer_rejects_external_controls_and_dtd() {
    let location = Url::parse("http://192.168.1.8/description.xml").unwrap();
    let excessive = description("fixture", "/control").replace(
        "</serviceList>",
        &format!(
            "{}</serviceList>",
            "<service><serviceType>urn:fixture:service</serviceType></service>".repeat(40)
        ),
    );
    assert!(Renderer::parse(&excessive, &location).is_err());
    assert!(Renderer::parse(&description("fixture", "http://8.8.8.8/control"), &location).is_err());
    assert!(
        Renderer::parse(
            &format!(
                "<!DOCTYPE root [<!ENTITY x SYSTEM 'file:///etc/passwd'>]>{}",
                description("fixture", "/control")
            ),
            &location
        )
        .is_err()
    );
    assert!(Renderer::parse(&description("fixture\r\nX:evil", "/control"), &location).is_err());
    assert!(protocol::authorization_result("<root>ok</root>", "urn:x").is_err());
}
#[test]
fn real_http_authorization_success_and_explicit_revoke() {
    let fixture = Fixture::start(|request, _| {
        (
            200,
            if request.starts_with("GET ") {
                description("fixture", "/control")
            } else {
                SOAP.into()
            },
        )
    });
    let publications = Mutex::new(Vec::new());
    let connection = connect_with(fixture.room(), |_, alive| {
        publications.lock().unwrap().push(alive);
        Ok(())
    })
    .unwrap();
    assert_eq!(connection.local, Ipv4Addr::LOCALHOST);
    register(&connection, false).unwrap();
    let requests = fixture.seen.lock().unwrap();
    assert_eq!(requests.len(), 4);
    assert!(requests[1].contains("<DeviceIP>127.0.0.1</DeviceIP>"));
    assert!(requests[1].contains("synthetic+secret&lt;&amp;"));
    assert!(requests[1].contains("<Enable>1</Enable>"));
    assert!(requests[3].contains("<Enable>0</Enable>"));
    assert_eq!(*publications.lock().unwrap(), [true]);
    let advertisement = String::from_utf8(protocol::advertisement(
        &connection.room,
        &connection.renderer,
        &connection.renderer.udn,
        true,
    ))
    .unwrap();
    assert!(advertisement.contains("LOCATION:"));
    assert!(!advertisement.contains("synthetic"));
    assert!(!advertisement.contains("Token"));
}
#[test]
fn changed_identity_rolls_back_before_claiming_connected() {
    let fixture = Fixture::start(|request, count| {
        (
            200,
            if request.starts_with("GET ") {
                description(if count >= 3 { "changed" } else { "fixture" }, "/control")
            } else {
                SOAP.into()
            },
        )
    });
    let error = connect_with(fixture.room(), |_, _| Ok(())).err().unwrap();
    assert_eq!(error.code, "purek_identity_changed");
    assert!(
        fixture
            .seen
            .lock()
            .unwrap()
            .last()
            .unwrap()
            .contains("<Enable>0</Enable>")
    );
}
#[test]
fn failed_publication_keeps_the_direct_registration() {
    let fixture = Fixture::start(|request, _| {
        (
            200,
            if request.starts_with("GET ") {
                description("fixture", "/control")
            } else {
                SOAP.into()
            },
        )
    });
    let publications = Mutex::new(Vec::new());
    let connection = connect_with(fixture.room(), |_, alive| {
        publications.lock().unwrap().push(alive);
        if alive { Err(network_error()) } else { Ok(()) }
    })
    .unwrap();
    assert_eq!(connection.local, Ipv4Addr::LOCALHOST);
    assert_eq!(*publications.lock().unwrap(), [true]);
    let requests = fixture.seen.lock().unwrap();
    assert!(requests.iter().any(|r| r.contains("<Enable>1</Enable>")));
    assert!(!requests.iter().any(|r| r.contains("<Enable>0</Enable>")));
}
#[test]
fn health_checks_release_only_after_repeated_transient_failures_or_a_change() {
    let mut checks = health::Checks::default();
    let now = Instant::now();
    for _ in 1..HEALTH_RETRY_LIMIT {
        assert!(checks.observe(1, "fixture", Health::Transient, false, now));
    }
    assert!(!checks.observe(1, "fixture", Health::Transient, false, now));
    assert!(checks.observe(1, "fixture", Health::Healthy, false, now));
    assert!(checks.observe(1, "fixture", Health::Transient, false, now));
    assert!(!checks.observe(1, "fixture", Health::Changed, true, now));
}

#[test]
fn stale_health_completion_cannot_release_a_reconnected_room() {
    let fixture = Fixture::start(|request, _| {
        if request.starts_with("GET ") {
            (200, media_description())
        } else {
            (200, SOAP.into())
        }
    });
    let connection = connect_with(fixture.room(), |_, _| Ok(())).unwrap();
    let identity = connection.target_room_id.clone();
    let mut state = RoomState {
        generation: 2,
        busy: true,
        connected: Some(connection),
        ..Default::default()
    };
    assert_eq!(
        state.finish_health_check(1, &identity, Health::Changed, Instant::now()),
        None
    );
    assert_eq!(
        state.finish_health_check(2, "retired identity", Health::Changed, Instant::now()),
        None
    );
    assert!(state.connected.is_some() && state.busy);
    assert_eq!(state.generation, 2);
    assert_eq!(
        state.finish_health_check(2, &identity, Health::Changed, Instant::now()),
        Some(true)
    );
    assert!(state.connected.is_none() && state.busy);
    assert_eq!(state.generation, 3);
    assert_eq!(state.error.as_deref(), Some("purek_network"));
}

#[test]
fn only_a_unique_validated_701_stop_fault_allows_a_new_transport() {
    let fault = |detail: &str| {
        format!(
            "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body><s:Fault><detail><UPnPError xmlns=\"urn:schemas-upnp-org:control-1-0\">{detail}</UPnPError></detail></s:Fault></s:Body></s:Envelope>"
        )
    };
    for (status, reply, expected) in [
        (503, fault("<errorCode>701</errorCode>"), "purek_http"),
        (
            200,
            fault("<errorCode>701</errorCode>"),
            "purek_receiver_fault",
        ),
        (
            500,
            fault("<errorCode>501</errorCode>"),
            "purek_receiver_fault",
        ),
        (
            500,
            fault("<errorCode>701</errorCode><errorCode>501</errorCode>"),
            "purek_receiver_fault",
        ),
        (
            500,
            fault("<errorCode><nested>701</nested></errorCode>"),
            "purek_receiver_fault",
        ),
        (500, "invalid XML".into(), "purek_protocol_info"),
    ] {
        let fixture = Fixture::start(move |request, _| {
            if request.starts_with("GET ") {
                return (200, media_description());
            }
            if request.contains("#SetDeviceAuthorization") {
                return (200, SOAP.into());
            }
            if request.contains("#Stop") {
                return (status, reply.clone());
            }
            (200, transport_reply("SetAVTransportURI", ""))
        });
        let connection = connect_with(fixture.room(), |_, _| Ok(())).unwrap();
        let trace = trace::OutputTrace::new(false);
        let result = renderer::start_transport_traced(
            &connection,
            "http://127.0.0.1/fixture.ts",
            "http-get:*:video/MP2T:*",
            &trace,
        );
        assert_eq!(result.unwrap_err().code, expected);
        let requests = fixture.seen.lock().unwrap();
        assert!(
            !requests
                .iter()
                .any(|r| r.contains("#SetAVTransportURI") || r.contains("#Play"))
        );
        let snapshot = trace.snapshot();
        assert_eq!(snapshot["actions"].as_array().unwrap().len(), 1);
        assert_eq!(snapshot["actions"][0]["action"], "Stop");
        assert_eq!(snapshot["actions"][0]["outcome"], "failed");
        assert_eq!(snapshot["stage"], "control");
    }
    let fixture = Fixture::start(|request, _| {
        if request.starts_with("GET ") {
            (200, media_description())
        } else {
            (200, SOAP.into())
        }
    });
    let connection = connect_with(fixture.room(), |_, _| Ok(())).unwrap();
    drop(fixture);
    let error = renderer::start_transport(
        &connection,
        "http://127.0.0.1/fixture.ts",
        "http-get:*:video/MP2T:*",
    )
    .unwrap_err();
    assert_eq!(error.code, "purek_network");
    assert_eq!(error.diagnostic().unwrap()["transport"], "connect");
}
#[test]
fn rejected_stop_does_not_abort_transport_start() {
    let fixture = Fixture::start(|request, _| {
        if request.starts_with("GET ") {
            return (200, media_description());
        }
        if request.contains("#SetDeviceAuthorization") {
            return (200, SOAP.into());
        }
        if request.contains("#Stop") {
            return (500, "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body><s:Fault><faultstring>UPnPError</faultstring><detail><UPnPError xmlns=\"urn:schemas-upnp-org:control-1-0\"><errorCode>701</errorCode></UPnPError></detail></s:Fault></s:Body></s:Envelope>".into());
        }
        for action in ["SetAVTransportURI", "Play"] {
            if request.contains(&format!("#{action}")) {
                return (200, transport_reply(action, ""));
            }
        }
        panic!("unexpected receiver action")
    });
    let connection = connect_with(fixture.room(), |_, _| Ok(())).unwrap();
    renderer::start_transport(
        &connection,
        "http://127.0.0.1/fixture.ts",
        "http-get:*:video/MP2T:*",
    )
    .unwrap();
    let requests = fixture.seen.lock().unwrap();
    let actions: Vec<_> = requests
        .iter()
        .filter_map(|r| r.split("#").nth(1).and_then(|r| r.split('"').next()))
        .filter(|a| *a != "SetDeviceAuthorization")
        .collect();
    assert_eq!(actions, ["Stop", "SetAVTransportURI", "Play"]);
}
#[test]
fn only_unreachable_receivers_count_as_interrupted_monitoring() {
    assert!(!renderer::monitor_unavailable(&network_error()));
    assert!(!renderer::monitor_unavailable(&failure(
        502, "http", "fixed"
    )));
    assert!(renderer::monitor_unavailable(
        &failure(502, "http", "fixed").with_diagnostic(json!({"http_status":404}))
    ));
    for code in ["receiver_fault", "protocol_info", "protocol"] {
        assert!(renderer::monitor_unavailable(&failure(502, code, "fixed")));
    }
}
#[test]
fn redirects_and_soap_faults_do_not_authorize() {
    let fixture = Fixture::start(|_, _| (302, "synthetic echoed secret".into()));
    let error = connect_with(fixture.room(), |_, _| panic!("must not publish"))
        .err()
        .unwrap();
    assert_eq!(error.code, "purek_http");
    assert!(!error.to_string().contains("secret"));
    assert_eq!(fixture.seen.lock().unwrap().len(), 1);
    assert!(protocol::authorization_result("<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body><s:Fault/></s:Body></s:Envelope>","urn:x").is_err());
}
#[test]
fn qr_image_decode_works_without_browser_barcode_detector() {
    let raw = qr("http://192.168.1.8", "fixture");
    let code = crate::qr_image::encode_qr(&raw).unwrap();
    let width = (code.width() + 8) * 3;
    let mut pixels = vec![255; width * width];
    for y in 0..code.width() {
        for x in 0..code.width() {
            if code[(x, y)] == qrcode::Color::Dark {
                for yy in (y + 4) * 3..(y + 5) * 3 {
                    for xx in (x + 4) * 3..(x + 5) * 3 {
                        pixels[yy * width + xx] = 0;
                    }
                }
            }
        }
    }
    assert_eq!(
        decode(&json!({"width":width,"height":width,"pixels":STANDARD.encode(&pixels)})).unwrap(),
        raw
    );
    assert!(decode(&json!({"width":577,"height":576,"pixels":""})).is_err());
    assert!(
        decode(
            &json!({"width":width,"height":width,"pixels":STANDARD.encode(vec![255;width*width])})
        )
        .is_err()
    );
}

#[test]
fn dense_room_qr_survives_a_photographed_screen() {
    // Synthetic camera frame: dense modules, skewed screen, antialiasing and
    // uneven screen brightness. No venue credentials or user photo is stored.
    let raw = format!(
        "{}&bill_id={}",
        qr("http://192.168.1.8", "fixture"),
        "7".repeat(90)
    );
    let code = crate::qr_image::encode_qr(&raw).unwrap();
    let width = 324;
    let height = 576;
    let mut pixels = vec![35; width * height];
    for y in 200..385 {
        for x in 45..225 {
            let mut level = 0.0;
            for (dx, dy) in [(0.25, 0.25), (0.75, 0.25), (0.25, 0.75), (0.75, 0.75)] {
                let (px, py) = (x as f64 + dx, y as f64 + dy);
                let mut v = (py - 210.0) / 156.0;
                let mut u = 0.0;
                for _ in 0..4 {
                    let left = 62.0 - 10.0 * v;
                    u = (px - left) / (152.0 + 2.0 * v);
                    v = (py - 210.0 - 3.0 * u) / (150.0 + 9.0 * u);
                }
                let inside = (0.0..1.0).contains(&u) && (0.0..1.0).contains(&v);
                let sx = (u * (code.width() + 8) as f64).floor() as isize - 4;
                let sy = (v * (code.width() + 8) as f64).floor() as isize - 4;
                let dark = inside
                    && sx >= 0
                    && sy >= 0
                    && sx < code.width() as isize
                    && sy < code.width() as isize
                    && code[(sx as usize, sy as usize)] == qrcode::Color::Dark;
                level += if !inside {
                    35.0
                } else if dark {
                    35.0 + 15.0 * u
                } else {
                    245.0 - 20.0 * v
                };
            }
            pixels[y * width + x] = (level / 4.0).round() as u8;
        }
    }
    assert_eq!(
        decode(&json!({"width":width,"height":height,"pixels":STANDARD.encode(pixels)})).unwrap(),
        raw
    );
}

#[test]
fn photo_with_multiple_valid_rooms_is_ambiguous() {
    let width = 576;
    let height = 288;
    let mut pixels = vec![255; width * height];
    for (left, raw) in [
        (20, qr("http://192.168.1.8", "one")),
        (310, qr("http://192.168.1.9", "two")),
    ] {
        let code = crate::qr_image::encode_qr(&raw).unwrap();
        assert!((code.width() + 8) * 3 < height);
        for y in 0..code.width() {
            for x in 0..code.width() {
                if code[(x, y)] == qrcode::Color::Dark {
                    for yy in (y + 4) * 3..(y + 5) * 3 {
                        for xx in left + (x + 4) * 3..left + (x + 5) * 3 {
                            pixels[yy * width + xx] = 0;
                        }
                    }
                }
            }
        }
    }
    assert_eq!(
        decode(&json!({"width":width,"height":height,"pixels":STANDARD.encode(pixels)}))
            .unwrap_err()
            .code,
        "purek_qr_image"
    );
}
#[test]
fn registration_timeout_is_bounded_and_errors_do_not_echo_credentials() {
    let fixture = Fixture::start(|_, _| {
        thread::sleep(Duration::from_millis(4300));
        (200, "secret".into())
    });
    let start = Instant::now();
    let error = probe(&fixture.room(), Ipv4Addr::LOCALHOST).err().unwrap();
    assert!(start.elapsed() < Duration::from_secs(6));
    assert_eq!(error.code, "purek_network");
    assert!(!error.message.contains("secret"));
}

#[test]
fn discovery_uses_local_ssdp_fixture_and_does_not_authorize() {
    let receiver = Fixture::start(|_, _| {
        (
            200,
            description("discovery", "/control").replace(
                "<friendlyName>",
                "<manufacturer>PureK</manufacturer><friendlyName>",
            ),
        )
    });
    let responder = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    responder
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let destination = match responder.local_addr().unwrap() {
        std::net::SocketAddr::V4(v) => v,
        _ => unreachable!(),
    };
    let location = format!("{}/description.xml", receiver.base);
    let worker = thread::spawn(move || {
        let mut bytes = [0; 1024];
        let (size, source) = responder.recv_from(&mut bytes).unwrap();
        assert!(String::from_utf8_lossy(&bytes[..size]).starts_with("M-SEARCH * HTTP/1.1"));
        responder
            .send_to(
                format!("HTTP/1.1 200 OK\r\nLOCATION: {location}\r\n\r\n").as_bytes(),
                source,
            )
            .unwrap();
    });
    assert_eq!(discover_at(destination).unwrap(), ["Fixture room"]);
    worker.join().unwrap();
    let requests = receiver.seen.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].starts_with("GET "));
}

#[test]
fn all_media_services_are_pinned_to_the_authorized_origin() {
    let location = Url::parse("http://192.168.123.231:1234/description.xml").unwrap();
    let text = media_description();
    let renderer = Renderer::parse(&text, &location).unwrap();
    assert_eq!(
        renderer
            .services
            .av_transport
            .as_ref()
            .unwrap()
            .control
            .path(),
        "/transport"
    );
    assert_eq!(
        renderer
            .services
            .rendering_control
            .as_ref()
            .unwrap()
            .service_type,
        "urn:schemas-upnp-org:service:RenderingControl:2"
    );
    for target in [
        "http://192.168.123.232:1234/transport",
        "http://192.168.123.231:1235/transport",
        "http://user:secret@192.168.123.231:1234/transport",
        "/transport?secret=synthetic",
        "/transport#fragment",
    ] {
        assert!(Renderer::parse(&text.replace("/transport", target), &location).is_err());
    }
    assert!(
        Renderer::parse(
            &text.replace(
                "<device>",
                "<URLBase>http://192.168.123.232/</URLBase><device>"
            ),
            &location
        )
        .is_err()
    );
    let service = "<service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/second</controlURL></service>";
    assert!(
        Renderer::parse(
            &text.replace("</serviceList>", &format!("{service}</serviceList>")),
            &location
        )
        .is_err()
    );
    assert!(
        Renderer::parse(
            &text.replace("AVTransport:1", "AVTransport:invalid"),
            &location
        )
        .is_err()
    );
}

#[test]
fn media_service_changes_invalidate_authorization_identity() {
    let fixture = Fixture::start(|request, count| {
        (
            200,
            if request.starts_with("GET ") {
                if count >= 3 {
                    media_description().replace("/transport", "/changed")
                } else {
                    media_description()
                }
            } else {
                SOAP.into()
            },
        )
    });
    let error = connect_with(fixture.room(), |_, _| Ok(())).err().unwrap();
    assert_eq!(error.code, "purek_identity_changed");
    assert!(
        fixture
            .seen
            .lock()
            .unwrap()
            .last()
            .unwrap()
            .contains("<Enable>0</Enable>")
    );
}

#[test]
fn protocol_info_requires_a_single_correct_soap_response() {
    let service = "urn:schemas-upnp-org:service:ConnectionManager:1";
    assert!(
        renderer::protocol_info(&protocol_reply(""), service)
            .unwrap()
            .formats
            .is_empty()
    );
    let valid = protocol_reply("http-get:*:video/MP2T:DLNA.ORG_PN=AVC_TS_HD_50_AC3;DLNA.ORG_OP=00");
    assert_eq!(
        renderer::protocol_info(&valid, service).unwrap().formats[0].mime,
        "video/mp2t"
    );
    for invalid in [
        valid.replace("ConnectionManager:1", "ConnectionManager:2"),
        valid.replace("<Source/>", "<Source/><Sink/>"),
        valid.replace("<Source/>", ""),
        valid.replace("<Source/>", "<Source/><s:Fault/>"),
        valid.replace("<Sink>", "<Sink><Nested/>"),
        valid.replace("<Sink>", "<Sink xmlns=\"urn:untrusted\">"),
        valid.replace("<s:Body>", "<s:Body/><s:Body>"),
        "<root><Sink>http-get:*:video/MP2T:*</Sink></root>".into(),
        SOAP.into(),
        format!("<!DOCTYPE s:Envelope [<!ENTITY x 'secret'>]>{valid}"),
    ] {
        let error = renderer::protocol_info(&invalid, service).err().unwrap();
        assert_eq!(error.code, "purek_protocol_info");
        assert!(!error.to_string().contains("secret"));
    }
}

#[test]
fn g0_uses_real_http_without_transmitting_room_credentials() {
    let fixture = Fixture::start(|request, _| {
        (
            200,
            if request.starts_with("GET ") {
                media_description()
            } else if request.contains("#GetProtocolInfo") {
                protocol_reply("http-get:*:video/MP2T:*")
            } else {
                SOAP.into()
            },
        )
    });
    let connection = connect_with(fixture.room(), |_, _| Ok(())).unwrap();
    let formats = renderer::probe(&connection).unwrap();
    assert_eq!(formats.formats[0].mime, "video/mp2t");
    let requests = fixture.seen.lock().unwrap();
    assert_eq!(requests.len(), 4);
    assert!(requests[3].starts_with("POST /control "));
    assert!(requests[3].contains("GetProtocolInfo"));
    assert!(!requests[3].contains("synthetic"));
    assert!(!requests[3].contains("Token"));
}

#[test]
fn oversized_length_is_rejected_without_waiting_for_body() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let (release, waiting) = std::sync::mpsc::channel();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut request = Vec::new();
        while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
            let mut byte = [0];
            stream.read_exact(&mut byte).unwrap();
            request.push(byte[0]);
            assert!(request.len() <= 16384);
        }
        // Deliberately withhold the body until the caller has a result. The
        // declared limit alone must reject it; no timeout/retry is acceptance.
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Length: 1048577\r\nConnection: close\r\n\r\n"
        )
        .unwrap();
        stream.flush().unwrap();
        let _ = waiting.recv_timeout(Duration::from_secs(6));
    });
    let reply = client(None).unwrap().get(url).send().unwrap();
    let error = response(reply).err().unwrap();
    release.send(()).unwrap();
    server.join().unwrap();
    assert_eq!(error.code, "purek_protocol");
}

#[test]
fn g0_fault_redirect_and_oversized_reply_are_errors_not_empty_sinks() {
    for (status, reply, expected) in [
        (302, "synthetic echoed credential".into(), "purek_http"),
        (500, "synthetic echoed credential".into(), "purek_http"),
        (
            200,
            "<Fault>synthetic echoed credential</Fault>".into(),
            "purek_protocol_info",
        ),
        (200, "x".repeat(1024 * 1024 + 1), "purek_protocol"),
    ] {
        let fixture = Fixture::start(move |request, _| {
            if request.starts_with("GET ") {
                (200, media_description())
            } else if request.contains("#GetProtocolInfo") {
                (status, reply.clone())
            } else {
                (200, SOAP.into())
            }
        });
        let connection = connect_with(fixture.room(), |_, _| Ok(())).unwrap();
        let error = renderer::probe(&connection).err().unwrap();
        assert_eq!(error.code, expected);
        assert!(!error.to_string().contains("credential"));
        assert_eq!(fixture.seen.lock().unwrap().len(), 4);
    }
}

#[test]
fn output_state_never_qualifies_advertisements_or_accepts_stale_callbacks() {
    let location = Url::parse("http://192.168.123.231/description.xml").unwrap();
    let mut output = renderer::OutputSession::default();
    assert_eq!(output.snapshot()["status"], "stopped");
    output.authorize(1, "opaque-fixture-id".into());
    output.probing(
        2,
        Renderer::parse(&media_description(), &location)
            .unwrap()
            .services,
    );
    let formats = capabilities::ProtocolInfo::parse(
        "http-get:*:video/MP2T:DLNA.ORG_PN=AVC_TS_MP_HD_AAC_MULT5",
    )
    .unwrap();
    assert!(!output.finish(1, Ok(formats.clone())));
    assert!(output.finish(2, Ok(formats)));
    let snapshot = output.snapshot();
    assert_eq!(snapshot["status"], "authorized");
    assert_eq!(snapshot["last_error"], "purek_output_validation_required");
    for (key, value) in snapshot["capabilities"].as_object().unwrap() {
        if key.starts_with("supports_") {
            assert_eq!(value, false);
        }
    }
    assert!(!snapshot.to_string().contains("192.168"));
    assert!(!snapshot.to_string().contains("uuid:"));
    output.stop(3);
    assert!(!output.finish(2, Err(network_error())));
    assert_eq!(output.snapshot()["status"], "stopped");
    assert_eq!(output.snapshot()["target_room_id"], Value::Null);
    assert_eq!(output.snapshot()["capabilities"]["sink_formats"], json!([]));
}

#[test]
fn missing_av_transport_is_unsupported_and_sink_declarations_remain_advisory() {
    let location = Url::parse("http://192.168.123.231/description.xml").unwrap();
    let mut output = renderer::OutputSession::default();
    output.probing(
        1,
        Renderer::parse(&description("fixture", "/control"), &location)
            .unwrap()
            .services,
    );
    assert!(output.finish(
        1,
        Ok(capabilities::ProtocolInfo::parse("http-get:*:video/MP2T:*").unwrap())
    ));
    assert_eq!(output.snapshot()["status"], "unsupported");
    assert_eq!(
        output.snapshot()["last_error"],
        "purek_output_no_av_transport"
    );
    assert_eq!(
        output.protocol().unwrap_err().code,
        "purek_output_no_av_transport"
    );
    // A receiver may omit MPEG-TS from its Sink and still play it. Keep the
    // declared formats visible, but permit an explicit unqualified trial.
    for formats in [
        "rtsp-rtp-udp:*:video/MP2T:*",
        "http-get:*:audio/aac:*",
        "http-get:*:video/mp4:*,http-get:*:video/x-matroska:*",
        "http-get:*:video/MP2T:DLNA.ORG_PN=AVC_TS_HD_50_AC3",
        "http-get:*:video/mpeg:DLNA.ORG_PN=MPEG_PS_PAL",
        "http-get:*:video/vnd.dlna.mpeg-tts:DLNA.ORG_PN=AVC_TS_MP_HD_AAC_MULT5",
    ] {
        let mut output = renderer::OutputSession::default();
        output.probing(
            1,
            Renderer::parse(&media_description(), &location)
                .unwrap()
                .services,
        );
        assert!(output.finish(1, Ok(capabilities::ProtocolInfo::parse(formats).unwrap())));
        let snapshot = output.snapshot();
        assert_eq!(snapshot["status"], "unverified", "{formats}");
        assert_eq!(
            snapshot["capabilities"]["protocol_info_state"], "reported",
            "{formats}"
        );
        assert_eq!(
            output.protocol().unwrap(),
            capabilities::TsProtocol::Mp2t,
            "{formats}"
        );
        for (key, value) in snapshot["capabilities"].as_object().unwrap() {
            if key.starts_with("supports_") {
                assert_eq!(value, false);
            }
        }
    }
}

#[test]
fn unavailable_or_empty_protocol_info_allows_only_an_unqualified_explicit_trial() {
    let location = Url::parse("http://192.168.123.231/description.xml").unwrap();
    for result in [
        Ok(capabilities::ProtocolInfo::parse("").unwrap()),
        Err(network_error()),
        Err(failure(502, "http", "fixed error")),
        Err(failure(502, "protocol_info", "fixed error")),
    ] {
        let mut output = renderer::OutputSession::default();
        assert!(
            output.protocol().is_err(),
            "no attempt before an authorized probe"
        );
        output.probing(
            1,
            Renderer::parse(&media_description(), &location)
                .unwrap()
                .services,
        );
        assert!(output.protocol().is_err());
        let expected_error = result.as_ref().err().map(|e| e.code.clone());
        assert!(output.finish(1, result));
        let snapshot = output.snapshot();
        assert_eq!(snapshot["status"], "unverified");
        assert_eq!(
            snapshot["capabilities"]["protocol_info_state"],
            if expected_error.is_some() {
                "unavailable"
            } else {
                "empty"
            }
        );
        assert_eq!(
            snapshot["capabilities"]["protocol_info_error"],
            json!(expected_error)
        );
        assert_eq!(snapshot["capabilities"]["sink_formats"], json!([]));
        for (key, value) in snapshot["capabilities"].as_object().unwrap() {
            if key.starts_with("supports_") {
                assert_eq!(value, false);
            }
        }
        assert_eq!(output.protocol().unwrap(), capabilities::TsProtocol::Mp2t);
        output.stop(2);
        assert!(
            output.protocol().is_err(),
            "disconnect clears compatibility admission"
        );
    }
    let mut output = renderer::OutputSession::default();
    output.probing(
        1,
        Renderer::parse(&description("fixture", "/control"), &location)
            .unwrap()
            .services,
    );
    output.finish(1, Err(network_error()));
    assert_eq!(output.snapshot()["status"], "unsupported");
    assert_eq!(
        output.protocol().unwrap_err().code,
        "purek_output_no_av_transport"
    );
}

#[test]
fn standard_av_transport_only_receivers_do_not_gain_vendor_authorization() {
    let fixture = Fixture::start(|request, _| {
        assert!(
            request.starts_with("GET "),
            "no vendor registration or guessed query endpoint"
        );
        (200, "<root><device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType><UDN>uuid:av-only</UDN><serviceList><service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/av</controlURL></service></serviceList></device></root>".into())
    });
    let location = fixture.room().description.clone();
    let standard = connect_with(Room::dlna(location.as_str()).unwrap(), |_, _| {
        panic!("standard DLNA must not publish vendor announcements")
    })
    .unwrap();
    assert!(standard.renderer.services.connection_manager.is_none());
    assert!(standard.renderer.services.av_transport.is_some());
    register(&standard, true).unwrap();
    assert_eq!(
        renderer::probe(&standard).err().unwrap().code,
        "purek_output_no_connection_manager"
    );
    assert_eq!(fixture.seen.lock().unwrap().len(), 2);
    assert_eq!(
        connect_with(fixture.room(), |_, _| Ok(()))
            .err()
            .unwrap()
            .code,
        "purek_renderer"
    );
    assert_eq!(fixture.seen.lock().unwrap().len(), 3);
}

#[test]
fn app_state_probe_publishes_busy_and_stale_results_cannot_release_a_new_lease() {
    let _owned = crate::app_state::native_session::GLOBAL_APP_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let (entered, observed) = std::sync::mpsc::channel();
    let (resume, released) = std::sync::mpsc::channel();
    let fixture = Fixture::start(move |request, _| {
        (
            200,
            if request.starts_with("GET ") {
                media_description()
            } else if request.contains("#GetProtocolInfo") {
                entered.send(()).unwrap();
                released.recv_timeout(Duration::from_secs(3)).unwrap();
                protocol_reply("http-get:*:video/MP2T:*")
            } else {
                SOAP.into()
            },
        )
    });
    let connection = connect_with(fixture.room(), |_, _| Ok(())).unwrap();
    with_app(|app| {
        app.native().purek = RoomState {
            connected: Some(connection),
            ..Default::default()
        };
        Ok(())
    })
    .unwrap();
    let worker = thread::spawn(probe_output);
    observed.recv_timeout(Duration::from_secs(3)).unwrap();
    with_app(|app| {
        let state = &mut app.native().purek;
        assert!(state.busy);
        assert_eq!(state.snapshot()["output"]["status"], "probing");
        state.generation += 1;
        state.output.stop(state.generation);
        Ok(())
    })
    .unwrap();
    resume.send(()).unwrap();
    assert_eq!(worker.join().unwrap().err().unwrap().code, "purek_busy");
    with_app(|app| {
        assert!(
            app.native().purek.busy,
            "stale callback cannot release a replacement operation"
        );
        assert_eq!(app.native().purek.snapshot()["output"]["status"], "stopped");
        app.native().purek = RoomState::default();
        Ok(())
    })
    .unwrap();
}

#[test]
fn app_state_probe_retry_preserves_authorization_and_current_results_publish_once() {
    let _owned = crate::app_state::native_session::GLOBAL_APP_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let calls = std::sync::atomic::AtomicUsize::new(0);
    let fixture = Fixture::start(move |request, _| {
        (
            200,
            if request.starts_with("GET ") {
                media_description()
            } else if request.contains("#GetProtocolInfo") {
                match calls.fetch_add(1, Ordering::AcqRel) {
                    0 => protocol_reply(""),
                    1 => "<invalid/>".into(),
                    _ => protocol_reply("http-get:*:video/mp4:*"),
                }
            } else {
                SOAP.into()
            },
        )
    });
    let connection = connect_with(fixture.room(), |_, _| Ok(())).unwrap();
    let target = connection.target_room_id.clone();
    with_app(|app| {
        let mut state = RoomState {
            generation: 1,
            connected: Some(connection),
            ..Default::default()
        };
        state.output.authorize(1, target.clone());
        app.native().purek = state;
        Ok(())
    })
    .unwrap();
    for (index, (status, error)) in [
        ("unverified", "purek_output_capabilities_unverified"),
        ("unverified", "purek_protocol_info"),
        ("unverified", "purek_output_capabilities_unverified"),
    ]
    .into_iter()
    .enumerate()
    {
        let snapshot = probe_output().unwrap();
        assert_eq!(snapshot["connected"], true);
        assert_eq!(snapshot["busy"], false);
        assert_eq!(snapshot["output"]["target_room_id"], target);
        assert_eq!(snapshot["output"]["generation"], index + 2);
        assert_eq!(snapshot["output"]["status"], status);
        assert_eq!(snapshot["output"]["last_error"], error);
        let revision = with_app(|app| Ok(app.native().revision)).unwrap();
        assert_eq!(snapshot["revision"], revision);
        assert_eq!(
            snapshot,
            with_app(|app| Ok(super::snapshot(app.native()))).unwrap()
        );
        assert!(
            !with_app(|app| Ok(app
                .native()
                .purek
                .output
                .finish(index as u64 + 2, Err(network_error()))))
            .unwrap()
        );
        assert_eq!(with_app(|app| Ok(app.native().revision)).unwrap(), revision);
    }
    assert_eq!(
        fixture
            .seen
            .lock()
            .unwrap()
            .iter()
            .filter(|s| s.contains("#SetDeviceAuthorization"))
            .count(),
        1
    );
    with_app(|app| {
        app.native().purek = RoomState::default();
        Ok(())
    })
    .unwrap();
}

fn transport_reply(action: &str, fields: &str) -> String {
    format!(
        "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body><u:{action}Response xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\">{fields}</u:{action}Response></s:Body></s:Envelope>"
    )
}
#[test]
fn receiver_didl_is_escaped_and_empty_metadata_retries_only_a_real_fault() {
    for fault in [true, false] {
        let sets = std::sync::atomic::AtomicUsize::new(0);
        let fixture = Fixture::start(move |request, _| {
            if request.starts_with("GET ") {
                return (200, media_description());
            }
            if request.contains("#SetDeviceAuthorization") {
                return (200, SOAP.into());
            }
            if request.contains("#SetAVTransportURI") && sets.fetch_add(1, Ordering::AcqRel) == 0 {
                return if fault {
                    (500,"<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body><s:Fault><faultstring>synthetic credential must never be echoed</faultstring></s:Fault></s:Body></s:Envelope>".into())
                } else {
                    (503, "synthetic credential must never be echoed".into())
                };
            }
            for action in ["Stop", "SetAVTransportURI", "Play", "GetTransportInfo"] {
                if request.contains(&format!("#{action}")) {
                    return (
                        200,
                        transport_reply(
                            action,
                            if action == "GetTransportInfo" {
                                "<CurrentTransportState>PLAYING</CurrentTransportState>"
                            } else {
                                ""
                            },
                        ),
                    );
                }
            }
            panic!("unexpected receiver action")
        });
        let connection = connect_with(fixture.room(), |_, _| Ok(())).unwrap();
        let uri = "http://127.0.0.1/fixture.ts?a=1&b=2";
        let result = renderer::start_transport(&connection, uri, "http-get:*:video/MP2T:*");
        if fault {
            result.unwrap();
            assert_eq!(renderer::transport_state(&connection).unwrap(), "PLAYING");
        } else {
            let error = result.unwrap_err();
            assert!(!error.to_string().contains("credential"));
        }
        let requests = fixture.seen.lock().unwrap();
        let sets: Vec<_> = requests
            .iter()
            .filter(|r| r.contains("#SetAVTransportURI"))
            .collect();
        assert_eq!(sets.len(), if fault { 2 } else { 1 });
        let body = sets[0].split_once("\r\n\r\n").unwrap().1;
        let doc = protocol::xml(body).unwrap();
        let metadata = doc
            .descendants()
            .find(|n| n.has_tag_name("CurrentURIMetaData"))
            .unwrap()
            .text()
            .unwrap();
        let didl = protocol::xml(metadata).unwrap();
        let resource = didl
            .descendants()
            .find(|n| n.tag_name().name() == "res")
            .unwrap();
        assert_eq!(resource.text().unwrap(), uri);
        assert_eq!(
            resource.attribute("protocolInfo"),
            Some("http-get:*:video/MP2T:*")
        );
        if fault {
            assert!(sets[1].contains("<CurrentURIMetaData></CurrentURIMetaData>"));
        }
        assert!(!requests.iter().any(|r| r.contains("#Pause")));
    }
}

#[test]
#[ignore = "requires Node 24 and real P1 companion; invoked by npm run test:purek-output"]
fn node_receiver_live_output_integration() {
    use crate::app_state::{AppStateRequest, CacheEvent};
    let _owned = crate::app_state::native_session::GLOBAL_APP_TEST_LOCK
        .lock()
        .unwrap();
    let directory =
        PathBuf::from(std::env::var_os("BILIKARA_TEST_PUREK_HOME").expect("isolated test home"));
    let companion =
        PathBuf::from(std::env::var_os("BILIKARA_TEST_LIBAV_COMPANION").expect("P1 companion"));
    crate::media_routing::configure(crate::media_routing::Configuration {
        mode: Default::default(),
        companion: Some(companion),
    })
    .unwrap();
    crate::execute_app_state(AppStateRequest::Shutdown { schema_version: 1 });
    let seed=serde_json::from_value(json!({"session_users":["Fixture singer"],"session_started_at":1.0,"session_played_file":"fixture.json","updated_at":1.0})).unwrap();
    assert!(
        crate::initialize_native_host(&directory, seed)
            .error()
            .is_none()
    );
    let host = super::super::start(
        &directory,
        Arc::new(|name| match name {
            "index.html" | "remote.html" => Some(Asset {
                bytes: b"<!doctype html><title>bilikara fixture</title>".to_vec(),
                mime: "text/html".into(),
            }),
            _ => None,
        }),
        true,
        None,
    )
    .unwrap();
    let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("tests/fixtures/bbdown");
    let l1 = std::env::var_os("BILIKARA_TEST_PUREK_L1").is_some();
    let long_video = directory.join("synthetic-l1-video.mp4");
    if l1 {
        extend_idr_fixture(&fixtures.join("video-reordered-start.mp4"), &long_video);
    }
    with_app(|app|{
        for index in 0..if std::env::var_os("BILIKARA_TEST_PUREK_CONTROLLER").is_some() || std::env::var_os("BILIKARA_TEST_PUREK_EOF").is_some(){3}else{2} {
            let id=format!("purek-fixture-{index}");
            let item=serde_json::from_value(json!({"id":id,"original_url":"https://example.test/song","resolved_url":"https://example.test/song","bvid":"BV1xx411c7mD","aid":1,"cid":index+1,"title":"Fixture song","part_title":"P1","display_title":"Fixture song","cover_url":"","embed_url":"","selected_pages":[1],"selected_cids":[index+1],"selected_durations":[1],"selected_parts":["P1"],"available_pages":[1],"available_cids":[index+1],"available_durations":[1],"available_parts":["P1"]})).unwrap();
            app.native_execute(AppStateRequest::AddItem{schema_version:1,item,position:"tail".into(),requester_name:"Fixture singer".into(),requester_user_id:None,reset_av_delay:false,allow_repeat:true,now:2.0})?;
            if index==2 {continue;}
            let item=app.native_core_snapshot()?.current_item.into_iter().chain(app.native_core_snapshot()?.playlist).find(|i|i.id==id).unwrap();
            let reservation=app.reserve_runtime_attempt(&id,&item.item_incarnation_id).unwrap();
            let relative=&reservation.artifact_relative_directory;
            let path=host.context.cache_root.join(relative);std::fs::create_dir_all(&path).unwrap();
            std::fs::copy(if l1{long_video.clone()}else{fixtures.join("video-reordered-start.mp4")},path.join("video.mp4")).unwrap();
            std::fs::copy(fixtures.join("audio.m4a"),path.join("audio.m4a")).unwrap();
            let mut variants=vec![json!({"id":"original","label":"Original","page":1,"audio_url":format!("/media/{relative}/audio.m4a")})];
            if l1 {std::fs::copy(fixtures.join("audio-flac.mp4"),path.join("instrumental.mp4")).unwrap();variants.push(json!({"id":"instrumental","label":"Instrumental","page":1,"audio_url":format!("/media/{relative}/instrumental.mp4")}));}
            let event:CacheEvent=serde_json::from_value(json!({"kind":"ready","message":"ready","video_relative_path":format!("{relative}/video.mp4"),"video_media_url":format!("/media/{relative}/video.mp4"),"audio_variants":variants,"selected_audio_variant_id":"original","item_incarnation_id":reservation.item_incarnation_id,"artifact_set_id":reservation.artifact_set_id,"artifact_relative_directory":relative})).unwrap();
            app.native_execute(AppStateRequest::ApplyCacheEvent{schema_version:1,item_id:id,cache_attempt_token:reservation.cache_attempt_token,event,now:3.0})?;
        }Ok(())
    }).unwrap();
    let result = std::process::Command::new(
        std::env::var_os("BILIKARA_TEST_NODE").expect("Node executable"),
    )
    .arg(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join(
                if std::env::var_os("BILIKARA_TEST_PUREK_MONITOR").is_some() {
                    "tests/purek_monitor_receiver.mjs"
                } else if std::env::var_os("BILIKARA_TEST_PUREK_COMPATIBILITY").is_some() {
                    "tests/purek_compatibility_receiver.mjs"
                } else if std::env::var_os("BILIKARA_TEST_PUREK_CONTROLLER").is_some() {
                    "tests/purek_controller_receiver.mjs"
                } else {
                    "tests/purek_output.test.mjs"
                },
            ),
    )
    .arg(if l1 { "--receiver-l1" } else { "--receiver" })
    .env("BILIKARA_TEST_PUREK_BOOTSTRAP", host.bootstrap_url())
    .output()
    .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(
        String::from_utf8(result.stdout)
            .unwrap()
            .contains("purek-node-receiver-ok")
    );
    let deadline = Instant::now() + Duration::from_secs(3);
    while with_app(|app| Ok(app.artifact_reader_count())).unwrap() != 0 && Instant::now() < deadline
    {
        thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(with_app(|app| Ok(app.artifact_reader_count())).unwrap(), 0);
    drop(host);
    crate::execute_app_state(AppStateRequest::Shutdown { schema_version: 1 });
}

// Repeat only an existing IDR packet, without a video encoder/CLI. This longer
// test-only file makes real Host parameter edits occur before pipeline EOF.
fn extend_idr_fixture(source: &Path, destination: &Path) {
    use mp4::{
        AvcConfig, MediaConfig, Mp4Config, Mp4Reader, Mp4Sample, Mp4Writer, TrackConfig, TrackType,
    };
    // mp4 0.14 does not provide reliable fragmented sample byte offsets. First
    // use the real validated copy-remuxer, then read its ordinary sample table.
    let companion = crate::media_routing::output_companion().unwrap();
    let probe = unsafe { crate::experimental_libav::LibavMetadataProbe::load(companion) }.unwrap();
    let flat = destination.with_extension("flat.mp4");
    probe
        .copy_remux_mp4(
            &crate::experimental_libav::CopyRemuxRequest {
                source,
                destination: &flat,
                expected_kind: crate::ExpectedMediaKind::Video,
            },
            &AtomicBool::new(false),
        )
        .unwrap();
    let file = std::fs::File::open(flat).unwrap();
    let length = file.metadata().unwrap().len();
    let mut reader = Mp4Reader::read_header(file, length).unwrap();
    let (&id, track) = reader.tracks().iter().next().unwrap();
    let config = AvcConfig {
        width: track.width(),
        height: track.height(),
        seq_param_set: track.sequence_parameter_set().unwrap().to_vec(),
        pic_param_set: track.picture_parameter_set().unwrap().to_vec(),
    };
    let sample = reader.read_sample(id, 1).unwrap().unwrap();
    assert!(sample.is_sync);
    let file = std::fs::File::create(destination).unwrap();
    let mut writer = Mp4Writer::write_start(
        file,
        &Mp4Config {
            major_brand: "isom".parse().unwrap(),
            minor_version: 512,
            compatible_brands: vec!["isom".parse().unwrap(), "avc1".parse().unwrap()],
            timescale: 1000,
        },
    )
    .unwrap();
    writer
        .add_track(&TrackConfig {
            track_type: TrackType::Video,
            timescale: 24000,
            language: "und".into(),
            media_conf: MediaConfig::AvcConfig(config),
        })
        .unwrap();
    let frames = if std::env::var_os("BILIKARA_TEST_PUREK_MONITOR").is_some()
        && std::env::var_os("BILIKARA_TEST_PUREK_EOF").is_none()
    {
        864
    } else {
        144
    };
    for n in 0..frames {
        writer
            .write_sample(
                1,
                &Mp4Sample {
                    start_time: n * 1001,
                    duration: 1001,
                    rendering_offset: 0,
                    is_sync: true,
                    bytes: sample.bytes.clone(),
                },
            )
            .unwrap();
    }
    writer.write_end().unwrap();
}

const UPNP_FAULT: &str = "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError synthetic secret</faultstring><detail><UPnPError xmlns=\"urn:schemas-upnp-org:control-1-0\"><errorCode>718</errorCode><errorDescription>synthetic secret</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>";

fn traced(room: Room) -> (Result<Connection, ApiError>, Value) {
    let mut steps = trace::ConnectTrace::new(&room);
    let result = connect_traced(room, |_, _| Ok(()), &mut steps);
    let entry = steps.finish(result.as_ref().err());
    (result, entry)
}

#[test]
fn qr_and_remote_submission_forward_exact_tokens_into_set_device_authorization() {
    let fixture = Fixture::start(|request, _| {
        (
            200,
            if request.starts_with("GET ") {
                description("fixture", "/control")
            } else {
                SOAP.into()
            },
        )
    });
    // append_pair percent-encodes each value, as the vendor QR does.
    let token = "a+b/c==%2F&x=%;'\"<>";
    let room = Room::from_input(&qr(&fixture.base, token)).unwrap();
    assert_eq!(room.authorization.as_ref().unwrap().token, token);
    connect_with(room, |_, _| Ok(())).unwrap();
    let requests = fixture.seen.lock().unwrap();
    let soap = &requests[1];
    assert!(soap.starts_with("POST /control "));
    assert!(soap.contains("<DeviceIP>127.0.0.1</DeviceIP>"));
    assert!(
        soap.contains("<Token>a+b/c==%2F&amp;x=%;&apos;&quot;&lt;&gt;</Token>"),
        "{soap}"
    );
    assert!(!soap.contains("wx.chunk.cn") && !soap.contains("projection_url"));
}

#[test]
fn description_path_is_appended_once() {
    for base in [
        "http://192.168.1.8:1234/render",
        "http://192.168.1.8:1234/render/",
        "http://192.168.1.8:1234/render/description.xml",
    ] {
        let room = Room::parse(&qr(base, "fixture")).unwrap();
        assert_eq!(
            room.description.as_str(),
            "http://192.168.1.8:1234/render/description.xml"
        );
    }
    let root = Room::parse(&qr("http://192.168.1.8:1234", "fixture")).unwrap();
    assert_eq!(
        root.description.as_str(),
        "http://192.168.1.8:1234/description.xml"
    );
}

#[test]
fn authorization_soap_fault_is_a_rejection_not_a_device_http_error() {
    let fixture = Fixture::start(|request, _| {
        if request.starts_with("GET ") {
            (200, description("fixture", "/control"))
        } else if request.contains("<Enable>1</Enable>") {
            (500, UPNP_FAULT.into())
        } else {
            (200, SOAP.into())
        }
    });
    let (result, entry) = traced(fixture.room());
    let error = result.err().unwrap();
    assert_eq!(error.code, "purek_authorization");
    assert_eq!(entry["failure_stage"], "authorization");
    assert_eq!(entry["result"], "failed");
    assert_eq!(entry["retryable"], true);
    let step = &entry["steps"][2];
    assert_eq!(step["stage"], "authorization");
    assert_eq!(step["http_status"], 500);
    assert_eq!(step["soap_fault"], true);
    assert_eq!(step["upnp_error"], 718);
    // Registration is revoked after a failed enable.
    assert!(fixture.seen.lock().unwrap()[2].contains("<Enable>0</Enable>"));
    let text = entry.to_string();
    for secret in ["synthetic", "secret", "127.0.0.1", "control", "fixture"] {
        assert!(!text.contains(secret), "{secret} leaked into {text}");
    }
}

#[test]
fn receiver_http_failures_keep_their_operation_stage_and_status() {
    // An HTTP 500 without a SOAP Fault is not a receiver rejection.
    let plain = Fixture::start(|request, _| {
        if request.starts_with("GET ") {
            (200, description("fixture", "/control"))
        } else {
            (500, "<html>synthetic secret</html>".into())
        }
    });
    let (result, entry) = traced(plain.room());
    assert_eq!(result.err().unwrap().code, "purek_http");
    assert_eq!(entry["failure_stage"], "authorization");
    assert_eq!(entry["steps"][2]["http_status"], 500);
    assert!(entry["steps"][2].get("soap_fault").is_none());

    let missing = Fixture::start(|_, _| (404, "synthetic secret".into()));
    let (result, entry) = traced(missing.room());
    assert_eq!(result.err().unwrap().code, "purek_http");
    assert_eq!(entry["failure_stage"], "description");
    assert_eq!(entry["steps"][1]["http_status"], 404);
    assert_eq!(entry["route"]["local_class"], "loopback");
    assert_eq!(entry["route"]["same_subnet_24"], true);
    assert_eq!(
        missing.seen.lock().unwrap().len(),
        1,
        "no registration without a description"
    );

    // A 200 SetDeviceAuthorization reply without its response element stays invalid.
    let invalid = Fixture::start(|request, _| {
        if request.starts_with("GET ") {
            (200, description("fixture", "/control"))
        } else {
            (200, "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body/></s:Envelope>".into())
        }
    });
    let (result, entry) = traced(invalid.room());
    assert_eq!(result.err().unwrap().code, "purek_authorization");
    assert_eq!(entry["steps"][2]["response"], "invalid");
    assert_eq!(entry["steps"][2]["soap_fault"], false);
}

#[test]
fn unreachable_receiver_is_a_network_failure_with_transport_category() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let (result, entry) = traced(Room::parse(&qr(&base, "synthetic")).unwrap());
    assert_eq!(result.err().unwrap().code, "purek_network");
    assert_eq!(entry["failure_stage"], "description");
    assert!(matches!(
        entry["steps"][1]["transport"].as_str(),
        Some("connect" | "io" | "timeout")
    ));
}

#[test]
fn successful_connection_trace_records_advisory_stages_without_failure() {
    let fixture = Fixture::start(|request, _| {
        (
            200,
            if request.starts_with("GET ") {
                description("fixture", "/control")
            } else {
                SOAP.into()
            },
        )
    });
    let mut steps = trace::ConnectTrace::new(&fixture.room());
    let connection =
        connect_traced(fixture.room(), |_, _| Err(network_error()), &mut steps).unwrap();
    let entry = steps.finish(None);
    assert_eq!(entry["result"], "connected");
    assert!(entry["failure_stage"].is_null());
    let stages: Vec<_> = entry["steps"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| (s["stage"].as_str().unwrap(), s["outcome"].as_str().unwrap()))
        .collect();
    assert_eq!(
        stages,
        [
            ("route", "ok"),
            ("description", "ok"),
            ("authorization", "ok"),
            ("revalidation", "ok"),
            ("ssdp", "failed")
        ]
    );
    drop(connection);
}

#[test]
fn traced_transport_start_records_each_soap_action_without_payloads() {
    let fixture = Fixture::start(|request, _| {
        if request.starts_with("GET ") {
            return (200, media_description());
        }
        if request.contains("#Stop") {
            return (500, "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body><s:Fault><faultstring>secret</faultstring><detail><UPnPError xmlns=\"urn:schemas-upnp-org:control-1-0\"><errorCode>701</errorCode></UPnPError></detail></s:Fault></s:Body></s:Envelope>".into());
        }
        for action in ["SetAVTransportURI", "Play"] {
            if request.contains(&format!("#{action}")) {
                return (200, transport_reply(action, ""));
            }
        }
        (200, SOAP.into())
    });
    let connection = connect_with(fixture.room(), |_, _| Ok(())).unwrap();
    let trace = trace::OutputTrace::new(true);
    renderer::start_transport_traced(
        &connection,
        "http://127.0.0.1/purek/stream/secretcapability.ts",
        "http-get:*:video/MP2T:*",
        &trace,
    )
    .unwrap();
    let snapshot = trace.snapshot();
    let actions: Vec<_> = snapshot["actions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| {
            (
                a["action"].as_str().unwrap(),
                a["outcome"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        actions,
        [
            ("Stop", "failed"),
            ("SetAVTransportURI", "ok"),
            ("Play", "ok")
        ]
    );
    assert_eq!(snapshot["actions"][0]["code"], "purek_receiver_fault");
    assert_eq!(snapshot["actions"][0]["upnp_error"], 701);
    // Play succeeded but no receiver GET happened yet: never claimed as playing.
    assert_eq!(snapshot["stage"], "not_requested");
    let text = snapshot.to_string();
    assert!(!text.contains("secret") && !text.contains("127.0.0.1"));
}

#[test]
fn empty_unavailable_and_incompatible_protocol_info_stay_distinct_in_diagnostics() {
    let location = Url::parse("http://192.168.123.231/description.xml").unwrap();
    let services = Renderer::parse(&media_description(), &location)
        .unwrap()
        .services;
    let summary = |result: Result<capabilities::ProtocolInfo, ApiError>| {
        let mut output = renderer::OutputSession::default();
        output.probing(1, services.clone());
        assert!(output.finish(1, result));
        // An explicit trial stays possible in every case.
        assert!(output.protocol().is_ok());
        output.diagnostic_summary()
    };
    let empty = summary(Ok(capabilities::ProtocolInfo::parse("").unwrap()));
    assert_eq!(empty["state"], "empty");
    assert_eq!(empty["declared_compatible"], false);
    let unavailable = summary(Err(failure(502, "protocol_info", "fixed")));
    assert_eq!(unavailable["state"], "unavailable");
    assert_eq!(unavailable["error"], "purek_protocol_info");
    let incompatible = summary(Ok(capabilities::ProtocolInfo::parse(
        "http-get:*:video/mp4:*,http-get:*:audio/aac:*",
    )
    .unwrap()));
    assert_eq!(incompatible["state"], "reported");
    assert_eq!(incompatible["mp4"], true);
    assert_eq!(incompatible["declared_compatible"], false);
    let compatible = summary(Ok(capabilities::ProtocolInfo::parse(
        "http-get:*:video/mpeg:DLNA.ORG_PN=AVC_TS_MP_HD_AAC_MULT5_ISO",
    )
    .unwrap()));
    assert_eq!(compatible["state"], "reported");
    assert_eq!(compatible["declared_compatible"], true);
    assert_eq!(compatible["ts_profiles"], 1);
    assert!(!compatible.to_string().contains("AVC_TS"));
}
