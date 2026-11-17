// Ported from VZRXS/bilikara PR #120 by FMPeach (MIT), commit 297ae1de,
// rust-runtime/src/show_dlna.rs and rust-runtime/src/show_dlna/discovery/tests.rs.
// Extended for the DLNA fix plan; SOAP/DIDL reference: Kirakara-App e449070 (MIT).
use super::*;

#[test]
fn deeply_nested_xml_is_rejected_on_a_two_mib_stack_at_every_entry() {
    std::thread::Builder::new()
        .stack_size(2 * 1024 * 1024)
        .spawn(|| {
            let source = format!("<root>{}{}</root>", "<a>".repeat(5000), "</a>".repeat(5000));
            assert!(source.len() < MAX_DESCRIPTION_BYTES);
            assert!(source.len() < MAX_SOAP_BYTES);
            assert_eq!(parse(&source), Err(PolicyError::TooDeep));
            assert_eq!(
                validate_soap_response(&source, SoapAction::Play),
                Err(PolicyError::TooDeep)
            );
            assert_eq!(parse_sink_protocol_info(&source), Err(PolicyError::TooDeep));
            assert_eq!(parse_transport_info(&source), Err(PolicyError::TooDeep));
            assert_eq!(parse_position_info(&source), Err(PolicyError::TooDeep));
        })
        .unwrap()
        .join()
        .unwrap();
}

#[test]
fn xml_depth_preflight_handles_limits_quotes_comments_cdata_and_unicode_names() {
    let nested = |count: usize| format!("{}{}", "<a>".repeat(count), "</a>".repeat(count));
    assert!(bounded_xml(&nested(64), MAX_DESCRIPTION_BYTES).is_ok());
    assert_eq!(
        bounded_xml(&nested(65), MAX_DESCRIPTION_BYTES).unwrap_err(),
        PolicyError::TooDeep
    );
    let unicode = format!("{}{}", "<设备 x='/>'>".repeat(5000), "</设备>".repeat(5000));
    assert_eq!(
        bounded_xml(&unicode, MAX_DESCRIPTION_BYTES).unwrap_err(),
        PolicyError::TooDeep
    );
    let disguise = format!(
        "<a>{}{}{}{}</a>",
        "<!-- </a> -->".repeat(80),
        "<![CDATA[</a><a/>]]>".repeat(80),
        "<a quote='/>'>".repeat(64),
        "</a>".repeat(64)
    );
    assert_eq!(
        bounded_xml(&disguise, MAX_DESCRIPTION_BYTES).unwrap_err(),
        PolicyError::TooDeep
    );
    let harmless = format!(
        "<root value=\"/>\">{}{}<empty /></root>",
        "<!-- <fake> -->".repeat(100),
        "<![CDATA[<fake>]]>".repeat(100)
    );
    assert!(bounded_xml(&harmless, MAX_DESCRIPTION_BYTES).is_ok());
    for source in [
        "<a x='unterminated",
        "<!-- missing end",
        "<![CDATA[broken",
        "<?broken",
        "</a>",
    ] {
        assert_eq!(
            bounded_xml(source, MAX_DESCRIPTION_BYTES).unwrap_err(),
            PolicyError::InvalidXml
        );
    }
}

#[test]
fn accepts_only_device_or_local_helper_locations_and_actual_local_routes() {
    let sender = Ipv4Addr::new(192, 168, 1, 12);
    let local = Ipv4Addr::new(192, 168, 1, 20);
    for location in [
        "http://127.0.0.1/admin",
        "http://169.254.169.254/metadata",
        "http://1.1.1.1/",
        "http://example.com/",
        "http://192.168.1.13/device.xml",
        "http://user:secret@192.168.1.12/device.xml",
        "https://192.168.1.12/device.xml",
    ] {
        assert!(
            accept_advertisement(location, sender, Some(local), &[local], NetworkPolicy::Lan)
                .is_err(),
            "{location}"
        );
    }
    let location = "http://192.168.1.12:1234/device.xml";
    assert!(
        accept_advertisement(location, sender, Some(local), &[local], NetworkPolicy::Lan).is_ok()
    );
    assert!(
        accept_advertisement(location, local, Some(local), &[local], NetworkPolicy::Lan).is_err()
    );
    let accepted =
        accept_advertisement(location, local, None, &[local], NetworkPolicy::Lan).unwrap();
    assert_eq!((accepted.address, accepted.helper), (sender, Some(local)));
    assert!(
        accept_advertisement(
            location,
            Ipv4Addr::new(192, 168, 1, 13),
            None,
            &[local],
            NetworkPolicy::Lan
        )
        .is_err()
    );
    assert!(
        accept_advertisement(
            "http://100.64.1.20/device.xml",
            local,
            None,
            &[local],
            NetworkPolicy::Lan
        )
        .is_ok()
    );
    assert!(
        accept_advertisement(
            "http://100.128.1.20/device.xml",
            local,
            None,
            &[local],
            NetworkPolicy::Lan
        )
        .is_err()
    );
    assert_eq!(
        validate_route_source(local, &[local], NetworkPolicy::Lan),
        Ok(local)
    );
    assert_eq!(
        validate_route_source(sender, &[local], NetworkPolicy::Lan),
        Err(PolicyError::RouteNotLocal)
    );
}

fn description(control: &str) -> String {
    format!(
        "<root xmlns=\"urn:schemas-upnp-org:device-1-0\"><device><deviceType>{MEDIA_RENDERER}</deviceType><friendlyName>电视 &amp; 音响</friendlyName><UDN>UUID:Renderer</UDN><serviceList><service><serviceType>{AV_TRANSPORT}1</serviceType><controlURL>/old</controlURL></service><service><serviceType>{AV_TRANSPORT}2</serviceType><controlURL>{control}</controlURL></service></serviceList></device></root>"
    )
}

fn parse(source: &str) -> Result<RendererDescription, PolicyError> {
    parse_description(
        source,
        "http://192.168.1.12:9000/path/description.xml",
        "uuid:response",
        "",
        NetworkPolicy::Lan,
    )
}

fn response(action: &str, fields: &str) -> String {
    format!(
        "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body><u:{action}Response xmlns:u=\"{AV_TRANSPORT}1\">{fields}</u:{action}Response></s:Body></s:Envelope>"
    )
}

#[test]
fn description_resolves_namespaces_relative_colon_paths_and_highest_service() {
    let renderer = parse(&description(
        "_urn:schemas-upnp-org:service:AVTransport_control?x=1&amp;y=2",
    ))
    .unwrap();
    assert_eq!(renderer.name, "电视 & 音响");
    assert_eq!(renderer.id, "uuid:renderer");
    assert!(renderer.av_transport.service_type.ends_with(":2"));
    assert_eq!(
        renderer.av_transport.control_url,
        "http://192.168.1.12:9000/path/_urn:schemas-upnp-org:service:AVTransport_control?x=1&y=2"
    );
    assert_eq!(renderer.vendor_class, VendorClass::Generic);
}

#[test]
fn description_accepts_query_duplicate_services_and_ignores_cross_origin_base() {
    for base in [
        "http://192.168.1.13/",
        "http://1.1.1.1/",
        "https://192.168.1.12/",
        "http://192.168.1.12:9001/",
    ] {
        let source = description("control?query=1&amp;two=2")
            .replace("<device>", &format!("<URLBase>{base}</URLBase><device>"));
        assert_eq!(
            parse(&source).unwrap().av_transport.control_url,
            "http://192.168.1.12:9000/path/control?query=1&two=2"
        );
    }
    let source = description("/first").replace("</serviceList>", &format!("<service><serviceType>{AV_TRANSPORT}2</serviceType><controlURL>/last?token=1</controlURL></service></serviceList>"));
    assert_eq!(
        parse(&source).unwrap().av_transport.control_url,
        "http://192.168.1.12:9000/last?token=1"
    );
    let source = description("control").replace(
        "<device>",
        "<URLBase>http://192.168.1.12:9000/base/</URLBase><device>",
    );
    assert_eq!(
        parse(&source).unwrap().av_transport.control_url,
        "http://192.168.1.12:9000/base/control"
    );
}

#[test]
fn description_rejects_external_controls_and_non_renderers() {
    for control in [
        "http://192.168.1.13/control",
        "http://1.1.1.1/control",
        "//192.168.1.13/control",
        "https://192.168.1.12/control",
        "http://user:secret@192.168.1.12/control",
    ] {
        assert!(parse(&description(control)).is_err(), "{control}");
    }
    assert_eq!(
        parse(&description("/control").replace("MediaRenderer", "MediaServer")),
        Err(PolicyError::NotRenderer)
    );
    assert_eq!(
        parse(&description("/control").replace("AVTransport", "Other")),
        Err(PolicyError::MissingAvTransport)
    );
    assert_eq!(parse("<broken>"), Err(PolicyError::InvalidXml));
    assert_eq!(
        parse(&"x".repeat(MAX_DESCRIPTION_BYTES + 1)),
        Err(PolicyError::TooLarge)
    );
    assert!(parse("<!DOCTYPE root [<!ENTITY e SYSTEM 'file:///test'>]><root>&e;</root>").is_err());
}

#[test]
fn optional_endpoints_and_missing_id_name_are_supported() {
    let source = description("/control").replace("<UDN>UUID:Renderer</UDN>", "").replace("<friendlyName>电视 &amp; 音响</friendlyName>", "").replace("</serviceList>", &format!("<service><serviceType>{CONNECTION_MANAGER}1</serviceType><controlURL>/cm</controlURL></service><service><serviceType>{RENDERING_CONTROL}3</serviceType><controlURL>/volume</controlURL></service></serviceList>"));
    let renderer = parse(&source).unwrap();
    assert_eq!(renderer.id, "uuid:response");
    assert_eq!(renderer.name, "192.168.1.12");
    assert!(
        renderer
            .connection_manager
            .unwrap()
            .control_url
            .ends_with("/cm")
    );
    assert!(
        renderer
            .rendering_control
            .unwrap()
            .service_type
            .ends_with(":3")
    );
    let renderer = parse_description(
        &source,
        "http://192.168.1.12/device.xml",
        "",
        "",
        NetworkPolicy::Lan,
    )
    .unwrap();
    assert_eq!(renderer.id, "http://192.168.1.12/device.xml");
}

#[test]
fn lan_urls_allow_private_shared_and_link_local_only() {
    for host in [
        "192.168.1.2",
        "10.0.0.2",
        "172.16.0.2",
        "169.254.1.2",
        "100.64.1.2",
        "100.127.255.254",
    ] {
        assert!(
            lan_url(
                &format!("http://{host}:8000/device?q=1"),
                NetworkPolicy::Lan
            )
            .is_ok()
        );
    }
    for url in [
        "http://127.0.0.1/",
        "http://0.0.0.0/",
        "http://1.1.1.1/",
        "http://100.128.1.2/",
        "http://example.com/",
        "http://[::1]/",
        "http://192.168.1.2:0/",
        "http://192.168.1.2/#part",
        "https://192.168.1.2/",
        "http://user:secret@192.168.1.2/",
    ] {
        assert!(lan_url(url, NetworkPolicy::Lan).is_err(), "{url}");
    }
    assert!(lan_url("http://127.0.0.1/", NetworkPolicy::LoopbackFixture).is_ok());
}

#[test]
fn parses_responses_and_announcements_on_their_own_sockets() {
    let response = b"http/1.1  200\r\nlocation: http://10.0.0.2:9000/device.xml\r\nusn: UUID:Test::upnp:rootdevice\r\nSERVER: device \xff\r\n\r\n";
    let parsed = parse_ssdp(response, SsdpChannel::SearchResponse).unwrap();
    assert_eq!(parsed.usn, "uuid:test");
    assert_eq!(parsed.kind, AdvertisementKind::Response);
    assert_eq!(parsed.server, "");
    assert!(parse_ssdp(response, SsdpChannel::Notify).is_none());
    for (nts, kind) in [
        ("SSDP:ALIVE", AdvertisementKind::Alive),
        ("ssdp:update", AdvertisementKind::Update),
    ] {
        let notify = format!(
            "NOTIFY * HTTP/1.1\r\nNTS: {nts}\r\nLOCATION: http://10.0.0.2/device.xml\r\nSERVER: HpPlay\r\n\r\n"
        );
        let parsed = parse_ssdp(notify.as_bytes(), SsdpChannel::Notify).unwrap();
        assert_eq!(parsed.kind, kind);
        assert_eq!(parsed.server, "HpPlay");
        assert!(parse_ssdp(notify.as_bytes(), SsdpChannel::SearchResponse).is_none());
    }
    let bye = b"NOTIFY * HTTP/1.1\r\nNTS: ssdp:byebye\r\nUSN: UUID:Test::upnp:rootdevice\r\n\r\n";
    assert_eq!(
        parse_ssdp(bye, SsdpChannel::Notify).unwrap().kind,
        AdvertisementKind::Byebye
    );
    assert_eq!(
        canonical_usn(" UUID:ABC::urn:schemas-upnp-org:device:MediaRenderer:1 "),
        "uuid:abc"
    );
}

#[test]
fn malformed_ssdp_is_ignored_without_becoming_an_advertisement() {
    for packet in [
        "M-SEARCH * HTTP/1.1\r\n\r\n",
        "HTTP/1.1 404\r\nLOCATION: http://10.0.0.2/\r\n",
        "HTTP/1.1 200\r\nLOCATION: http://10.0.0.2/\r\nlocation: http://10.0.0.3/\r\n",
        "HTTP/1.1 200\r\n\r\n",
        "NOTIFY * HTTP/1.1\r\nNTS: ssdp:unknown\r\nLOCATION: http://10.0.0.2/\r\n",
        "NOTIFY * HTTP/1.1\r\nNTS: ssdp:byebye\r\n",
    ] {
        assert!(parse_ssdp(packet.as_bytes(), SsdpChannel::SearchResponse).is_none());
        assert!(parse_ssdp(packet.as_bytes(), SsdpChannel::Notify).is_none());
    }
    assert!(parse_ssdp(&vec![b'x'; MAX_SSDP_BYTES + 1], SsdpChannel::Notify).is_none());
}

#[test]
fn vendor_badges_do_not_filter_ordinary_renderers() {
    for field in ["HPPLAY", "LeBo TV", "客厅乐播"] {
        assert_eq!(vendor_class(&[field]), VendorClass::Lebo);
        for tag in [
            "manufacturer",
            "modelName",
            "modelDescription",
            "friendlyName",
        ] {
            let source = description("/control")
                .replace("</device>", &format!("<{tag}>{field}</{tag}></device>"));
            let source = if tag == "friendlyName" {
                source.replace("<friendlyName>电视 &amp; 音响</friendlyName>", "")
            } else {
                source
            };
            assert_eq!(parse(&source).unwrap().vendor_class, VendorClass::Lebo);
        }
        assert_eq!(
            parse_description(
                &description("/control"),
                "http://192.168.1.12/device.xml",
                "",
                field,
                NetworkPolicy::Lan
            )
            .unwrap()
            .vendor_class,
            VendorClass::Lebo
        );
    }
    for field in ["DolphinStar", "chunk.cn", "PureK", "纯K", "海豚星空"] {
        assert_eq!(vendor_class(&[field]), VendorClass::Dolphinstar);
    }
    assert_eq!(
        vendor_class(&["普通电视", "Samsung", "Sony"]),
        VendorClass::Generic
    );
}

#[test]
fn protocol_selection_matches_app_and_never_blocks_unreported_capabilities() {
    assert_eq!(choose_mpeg_ts_protocol_info(&[]), DEFAULT_PROTOCOL_INFO);
    assert_eq!(
        choose_mpeg_ts_protocol_info(&["http-get:*:video/mp4:*".into(), "malformed".into()]),
        DEFAULT_PROTOCOL_INFO
    );
    let entries = [
        "http-get:*:video/vnd.dlna.mpeg-tts:*",
        "HTTP-GET:*:video/MPEG:DLNA.ORG_PN=anything",
        "http-get:*:video/MP2T:*",
    ];
    let entries: Vec<_> = entries.iter().map(|s| s.to_string()).collect();
    assert_eq!(
        choose_mpeg_ts_protocol_info(&entries),
        DEFAULT_PROTOCOL_INFO
    );
    assert_eq!(
        choose_mpeg_ts_protocol_info(&entries[..2]),
        "http-get:*:video/MPEG:*"
    );
    assert_eq!(
        choose_mpeg_ts_protocol_info(&entries[..1]),
        "http-get:*:video/vnd.dlna.mpeg-tts:*"
    );
    assert_eq!(
        choose_mpeg_ts_protocol_info(&["rtsp:*:video/mp2t:*".into()]),
        DEFAULT_PROTOCOL_INFO
    );
    assert_eq!(
        parse_sink_protocol_info(&response(
            "GetProtocolInfo",
            "<Sink> http-get:*:video/mpeg:*, http-get:*:video/mp4:* </Sink>"
        ))
        .unwrap()
        .len(),
        2
    );
    assert!(
        parse_sink_protocol_info(&response("GetProtocolInfo", "<Sink/>"))
            .unwrap()
            .is_empty()
    );
}

#[test]
fn didl_preserves_chinese_special_characters_and_file_facts() {
    let title = "歌曲 <一> & \"二\" '三'";
    let uri = "http://192.168.1.2/cast.ts?a=1&b=2";
    let file = FileMetadata {
        size: 1234,
        duration: Duration::from_millis(62_123),
    };
    let didl = build_didl(uri, title, DEFAULT_PROTOCOL_INFO, Some(file));
    let xml = Document::parse(&didl).unwrap();
    let item = xml
        .descendants()
        .find(|n| n.has_tag_name(("urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/", "item")))
        .unwrap();
    assert_eq!(item.attribute("parentID"), Some("0"));
    assert_eq!(direct_text(item, "title"), Some(title));
    let res = item
        .children()
        .find(|n| n.is_element() && n.tag_name().name() == "res")
        .unwrap();
    assert_eq!(res.attribute("size"), Some("1234"));
    assert_eq!(res.attribute("duration"), Some("0:01:02.123"));
    assert_eq!(res.text(), Some(uri));
    let live = build_didl(uri, title, DEFAULT_PROTOCOL_INFO, None);
    assert!(!live.contains(" size="));
    assert!(!live.contains(" duration="));
    assert!(
        content_features(DeliveryMode::Live, true).starts_with("DLNA.ORG_OP=00;DLNA.ORG_CI=0;")
    );
    assert_eq!(
        content_features(DeliveryMode::File, false),
        "DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000"
    );
    assert!(content_features(DeliveryMode::File, true).contains("CI=1;"));
}

#[test]
fn soap_envelope_matches_kirakara_app_bytes_and_round_trips_metadata() {
    // Independent literal of buildSoapEnvelope's concatenation, including spaces.
    let expected = "<?xml version=\"1.0\" encoding=\"utf-8\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body><u:SetAVTransportURI xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\"><InstanceID>0</InstanceID><CurrentURI>http://192.168.1.10/stage.ts?a=1&amp;b=2</CurrentURI><CurrentURIMetaData>&lt;item&gt;歌名&lt;/item&gt;</CurrentURIMetaData></u:SetAVTransportURI></s:Body></s:Envelope>";
    assert_eq!(
        soap_envelope(
            &format!("{AV_TRANSPORT}1"),
            SoapAction::SetAVTransportURI,
            &[
                ("InstanceID", "0"),
                ("CurrentURI", "http://192.168.1.10/stage.ts?a=1&b=2"),
                ("CurrentURIMetaData", "<item>歌名</item>")
            ]
        )
        .unwrap()
        .as_bytes(),
        expected.as_bytes()
    );
    let didl = build_didl(
        "http://192.168.1.2/file?a=1&b=2",
        "歌曲 <一> & \"二\"",
        DEFAULT_PROTOCOL_INFO,
        None,
    );
    let soap = soap_envelope(
        &format!("{AV_TRANSPORT}1"),
        SoapAction::SetAVTransportURI,
        &[("CurrentURIMetaData", &didl)],
    )
    .unwrap();
    let document = Document::parse(&soap).unwrap();
    assert_eq!(
        document
            .descendants()
            .find(|n| n.is_element() && n.tag_name().name() == "CurrentURIMetaData")
            .unwrap()
            .text(),
        Some(didl.as_str())
    );
    assert_eq!(
        soap_envelope("service", SoapAction::Play, &[("bad><injected", "value")]),
        Err(PolicyError::InvalidSoap)
    );
}

#[test]
fn soap_status_position_and_faults_remain_structured() {
    let fault = "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body><s:Fault><detail><UPnPError><errorCode>701</errorCode></UPnPError></detail></s:Fault></s:Body></s:Envelope>";
    assert_eq!(
        validate_soap_response(fault, SoapAction::Stop),
        Err(PolicyError::SoapFault(Some(701)))
    );
    assert_eq!(
        validate_soap_response("<ok/>", SoapAction::Stop),
        Err(PolicyError::InvalidSoap)
    );
    for (raw, state) in [
        ("PLAYING", TransportState::Playing),
        ("PAUSED_PLAYBACK", TransportState::Paused),
        ("PAUSED_RECORDING", TransportState::Paused),
        ("TRANSITIONING", TransportState::Transitioning),
        ("STOPPED", TransportState::Stopped),
        ("NO_MEDIA_PRESENT", TransportState::NoMedia),
        ("OTHER", TransportState::Unknown),
    ] {
        assert_eq!(
            parse_transport_info(&response(
                "GetTransportInfo",
                &format!("<CurrentTransportState>{raw}</CurrentTransportState>")
            ))
            .unwrap(),
            state
        );
    }
    assert!(parse_transport_info(&response("GetTransportInfo", "")).is_err());
    let position = parse_position_info(&response(
        "GetPositionInfo",
        "<RelTime>0:01:02.250</RelTime><TrackDuration>NOT_IMPLEMENTED</TrackDuration>",
    ))
    .unwrap();
    assert_eq!(position.position, Some(Duration::from_millis(62_250)));
    assert_eq!(position.duration, None);
}

#[test]
fn times_handle_fraction_unavailable_and_overflow() {
    for (raw, millis) in [
        ("0:00:00", 0),
        ("01:02:03.4", 3_723_400),
        ("1:02:03.04", 3_723_040),
        ("123:59:59.999", 446_399_999),
    ] {
        let duration = parse_upnp_time(raw).unwrap().unwrap();
        assert_eq!(duration, Duration::from_millis(millis));
        assert_eq!(
            parse_upnp_time(&format_upnp_time(duration)).unwrap(),
            Some(duration)
        );
    }
    for raw in ["", "NOT_IMPLEMENTED", " not_implemented "] {
        assert_eq!(parse_upnp_time(raw), Ok(None));
    }
    for raw in [
        "1:60:00",
        "1:00:60",
        "-1:00:00",
        "+1:00:00",
        "1:0:00",
        "1:00:1",
        "1:00:00.",
        "1:00:00.1234",
        "1:00:00.bad",
        "18446744073709551615:00:00",
        "00:01",
        "NaN",
    ] {
        assert_eq!(parse_upnp_time(raw), Err(PolicyError::InvalidTime), "{raw}");
    }
}
#[test]
fn local_source_falls_back_from_nonlocal_or_tun_routes_to_reply_interface() {
    let target = Ipv4Addr::new(192, 168, 1, 20);
    let local = Ipv4Addr::new(192, 168, 1, 5);
    let tun = Ipv4Addr::new(198, 18, 0, 1);
    for (routed, interfaces) in [
        (Some(Ipv4Addr::new(10, 7, 0, 2)), vec![local]),
        (Some(tun), vec![local, tun]),
        (None, vec![local]),
    ] {
        assert_eq!(
            select_local_source(target, routed, Some(local), &interfaces, NetworkPolicy::Lan),
            Ok(LocalSource {
                address: local,
                kind: LocalSourceKind::ReplyInterface
            })
        );
        assert_eq!(
            select_local_source(target, routed, None, &interfaces, NetworkPolicy::Lan),
            Ok(LocalSource {
                address: local,
                kind: LocalSourceKind::SameSubnet
            })
        );
    }
    assert_eq!(
        select_local_source(target, Some(local), Some(tun), &[local], NetworkPolicy::Lan)
            .unwrap()
            .kind,
        LocalSourceKind::Route
    );
    assert_eq!(
        select_local_source(target, Some(tun), Some(tun), &[tun], NetworkPolicy::Lan),
        Err(PolicyError::RouteNotLocal)
    );
}
