// Adapted from bilikara-next 7750dca, native_host/purek/tests.rs (MIT), and
// ChunK-Helper 3b00533, Qr/PureKQrParser.cs (MIT). See THIRD_PARTY_NOTICES.md.
use super::*;

#[test]
fn qr_trims_pasted_surrounding_whitespace_but_rejects_interior_controls() {
    let raw = room_qr("http://10.1.2.3", "opaque+token");
    let expected = Room::parse(&raw).unwrap();
    for (prefix, suffix) in [
        ("", "\n"),
        ("", "\r\n"),
        ("\t", ""),
        ("", "\t"),
        ("\n\r\t ", " \t\r\n"),
    ] {
        let room = Room::parse(&format!("{prefix}{raw}{suffix}")).unwrap();
        assert_eq!(room.authorization_url(), expected.authorization_url());
        assert_eq!(room.description, expected.description);
        assert_eq!(room.token, expected.token);
    }
    for control in ['\n', '\r', '\t', '\u{1}'] {
        let embedded = raw.replace("/projection/login", &format!("/projection/{control}login"));
        assert_eq!(
            Room::parse(&embedded).unwrap_err().code,
            PureKErrorCode::InvalidQr
        );
    }
    assert!(Room::parse(" \t\r\n ").is_err());
}

#[test]
fn qr_accepts_chunk_case_ports_fragments_queries_and_all_lan_classes_rejected_by_next() {
    for (base, expected) in [
        (
            "http://192.168.2.3:8123/box?room=secret#unused",
            AddressClass::Private,
        ),
        (
            "https://10.0.0.12:8443/box/description.xml/?room=secret#unused",
            AddressClass::Private,
        ),
        ("http://100.64.1.2:8000", AddressClass::Shared),
        ("http://169.254.3.4/", AddressClass::LinkLocal),
        ("http://receiver.local:8000/", AddressClass::Hostname),
    ] {
        let mut inner = Url::parse("https://CONN.DOLPHINSTAR.CN:8443/rEmOtE/#inner").unwrap();
        inner
            .query_pairs_mut()
            .append_pair("URL", base)
            .append_pair("TOKEN", "opaque+token");
        let raw = wrap(
            inner.as_str(),
            "http://WX.CHUNK.CN:8000/PROJECTION/LOGIN/#outer",
            true,
        );
        let room = Room::parse(&raw).unwrap();
        assert_eq!(room.facts.address_class, expected);
        assert_eq!(room.token, "opaque+token");
        assert!(room.description.query().is_none());
        assert!(room.description.fragment().is_none());
        assert!(room.authorization_url().contains(":8000/PROJECTION/LOGIN/"));
        assert!(!room.authorization_url().contains("#outer"));
        assert_eq!(
            room.facts.requires_address_confirmation,
            expected == AddressClass::Hostname
        );
        // All five variants violate next's private-literal/query/case/port rules.
        assert!(
            base.contains('?')
                || matches!(
                    expected,
                    AddressClass::Shared | AddressClass::LinkLocal | AddressClass::Hostname
                )
        );
    }
}

#[test]
fn qr_accepts_percent_wrapped_inner_and_does_not_append_description_twice() {
    for inner_encoded in [false, true] {
        let mut inner = Url::parse("https://conn.dolphinstar.cn/Remote").unwrap();
        inner
            .query_pairs_mut()
            .append_pair("url", "http://10.1.2.3/a/DESCRIPTION.XML/?q=1")
            .append_pair("token", "a+b/c==&<>");
        let inner = if inner_encoded {
            url::form_urlencoded::byte_serialize(inner.as_str().as_bytes()).collect()
        } else {
            inner.to_string()
        };
        for url_safe in [false, true] {
            let room = Room::parse(&wrap(
                &inner,
                "https://wx.chunk.cn/projection/login",
                url_safe,
            ))
            .unwrap();
            assert_eq!(room.description.path(), "/a/DESCRIPTION.XML/");
            assert!(room.description.query().is_none());
            assert_eq!(room.token, "a+b/c==&<>");
        }
    }
}

#[test]
fn qr_only_raw_name_pluses_are_form_spaces_and_opaque_values_remain_exact() {
    let inner = "https://conn.dolphinstar.cn/Remote?url=http%3A%2F%2F10.1.2.3&token=a+b%2Bc%2F%3D%26%3C&name=Room+Name%2BPlus";
    let room = Room::parse(&wrap(inner, "https://wx.chunk.cn/projection/login", false)).unwrap();
    assert_eq!(room.token, "a+b+c/=&<");
    assert_eq!(room.name(), "Room Name+Plus");
    let raw = wrap(inner, "https://wx.chunk.cn/projection/login", true).replace("%3D", "=");
    assert_eq!(Room::parse(&raw).unwrap().token, room.token);
}

#[test]
fn qr_rejects_public_loopback_credentials_non_web_and_obvious_injection() {
    for base in [
        "http://8.8.8.8/",
        "http://127.0.0.1/",
        "http://0/",
        "http://0x7f000001/",
        "http://224.0.0.1/",
        "http://100.63.255.255/",
        "http://100.128.0.0/",
        "http://[::1]/",
        "http://[::ffff:192.168.1.1]/",
        "ftp://10.1.2.3/",
        "file:///etc/passwd",
        "http://user:pass@10.1.2.3/",
        "http://10.1.2.3:0/",
        "http://10.1.2.3/%0d%0aInjected",
        "http://10.1.2.3/?a=%0D%0AInjected",
        "http://10.1.2.3/\\evil",
        "http://10.1.2.3/<script>",
    ] {
        assert!(
            Room::parse(&room_qr(base, "opaque")).is_err(),
            "accepted {base}"
        );
    }
    for inner in [
        "https://evil.test/Remote?url=http://10.1.2.3&token=x",
        "https://conn.dolphinstar.cn.evil.test/Remote?url=http://10.1.2.3&token=x",
        "https://user:pass@conn.dolphinstar.cn/Remote?url=http://10.1.2.3&token=x",
        "ftp://conn.dolphinstar.cn/Remote?url=http://10.1.2.3&token=x",
        "https://conn.dolphinstar.cn/Other?url=http://10.1.2.3&token=x",
        "https://conn.dolphinstar.cn/Remote?url=http://10.1.2.3&token=x&TOKEN=y",
        "https://conn.dolphinstar.cn/Remote?url=http://10.1.2.3&token=%0D%0AHeader",
        "https://conn.dolphinstar.cn/Remote?url=http://10.1.2.3&token=%FF",
        "https://conn.dolphinstar.cn/Remote?url=http://10.1.2.3&token=%XY",
        "https://conn.dolphinstar.cn/Remote?url=http://10.1.2.3",
    ] {
        assert!(Room::parse(&wrap(inner, "https://wx.chunk.cn/projection/login", true)).is_err());
    }
    let valid = room_qr("http://10.1.2.3", "opaque");
    for raw in [
        valid.replace("wx.chunk.cn", "evil.test"),
        format!("{valid}&PLACE_CODE=duplicate"),
        format!("{valid}&unexpected=embedded\ncontrol"),
    ] {
        let error = Room::parse(&raw).unwrap_err();
        assert_eq!(error.code, PureKErrorCode::InvalidQr);
        assert!(!format!("{error:?}").contains("opaque"));
    }
}

#[test]
fn qr_bounds_raw_decoded_fields_and_base64_utf8() {
    for raw in [
        "x".repeat(32_769),
        room_qr("http://10.1.2.3", &"x".repeat(4_097)),
        "https://wx.chunk.cn/projection/login?place_code=p&projection_url=@@@".into(),
        "https://wx.chunk.cn/projection/login?place_code=p&projection_url=_w".into(),
    ] {
        assert!(Room::parse(&raw).is_err());
    }
    let long_name = format!(
        "https://conn.dolphinstar.cn/Remote?url=http://10.1.2.3&token=t&name={}",
        "a".repeat(101)
    );
    assert!(
        Room::parse(&wrap(
            &long_name,
            "https://wx.chunk.cn/projection/login",
            true
        ))
        .is_err()
    );
}

#[test]
fn hostname_approval_never_authorizes_public_or_mixed_dns_answers() {
    let raw = room_qr("http://receiver.local/", "token");
    let operation = run(PureKClient::new().connect(
        &raw,
        AddressApproval::LanLiteralOnly,
        &CancellationToken::new(),
    ));
    assert_eq!(
        operation.result.unwrap_err().code,
        PureKErrorCode::AddressConfirmationRequired
    );
    for addresses in [
        vec![],
        vec!["8.8.8.8"],
        vec!["192.168.1.2", "8.8.8.8"],
        vec!["::1"],
        vec!["192.168.1.2", "2001:db8::1"],
    ] {
        let addresses: Vec<_> = addresses
            .iter()
            .map(|value| value.parse().unwrap())
            .collect();
        assert_eq!(
            validated_resolution(&addresses, NetworkPolicy::Lan)
                .unwrap_err()
                .code,
            PureKErrorCode::AddressNotAllowed
        );
    }
    assert_eq!(
        validated_resolution(
            &[
                "100.64.1.2".parse().unwrap(),
                "192.168.1.2".parse().unwrap()
            ],
            NetworkPolicy::Lan
        )
        .unwrap(),
        Ipv4Addr::new(100, 64, 1, 2)
    );
}

#[test]
fn authorization_description_accepts_cross_origin_base_duplicate_versions_and_many_identities() {
    let mut services = service("ConnectionManager", "invalid", "/bad");
    services += &service("ConnectionManager", "1", "/cm1");
    services += &service("ConnectionManager", "3", "relative:cm?q=room");
    services += &service("ConnectionManager", "2", "/cm2");
    for index in 0..40 {
        services += &service(&format!("Other{index}"), "1", "/vendor");
    }
    let xml = describe("uuid:fixture", &services)
        .replace("<root>", "<root><URLBase>http://8.8.8.8/foreign/</URLBase>");
    let location = Url::parse("http://10.1.2.3/box/description.xml?q=room").unwrap();
    let description = Description::parse(&xml, &location, None, NetworkPolicy::Lan).unwrap();
    assert!(description.av_transport.is_none());
    assert_eq!(
        description.manager.as_ref().unwrap().service_type,
        "urn:schemas-upnp-org:service:ConnectionManager:3"
    );
    assert_eq!(
        description.manager.as_ref().unwrap().control_url,
        "http://10.1.2.3/box/relative:cm?q=room"
    );
    assert_eq!(description.identities.len(), 32);
    let summary = description.summary(&[1; 32]);
    assert_eq!(summary.entries.len(), 32);
    assert!(summary.truncated);
    assert!(!format!("{summary:?}").contains("Other1"));
    assert_ne!(summary, description.summary(&[2; 32]));
}

#[test]
fn authorization_description_xml_always_uses_t1_depth_and_dtd_gate() {
    let location = Url::parse("http://10.1.2.3/description.xml").unwrap();
    assert!(
        Description::parse(
            &description("uuid:fixture::different", false),
            &location,
            None,
            NetworkPolicy::Lan
        )
        .is_err()
    );
    for xml in [
        "<a>".repeat(10_000),
        format!("{}{}", "<a>".repeat(65), "</a>".repeat(65)),
    ] {
        assert_eq!(
            Description::parse(&xml, &location, None, NetworkPolicy::Lan).err(),
            Some(PolicyError::TooDeep)
        );
    }
    assert_eq!(
        Description::parse(
            "<!DOCTYPE root [<!ENTITY bad 'x'>]><root/>",
            &location,
            None,
            NetworkPolicy::Lan
        )
        .err(),
        Some(PolicyError::InvalidXml)
    );
    assert!(
        Description::parse(
            &describe(
                "uuid:x",
                &service("ConnectionManager", "1", "http://10.1.2.4/cm")
            ),
            &location,
            None,
            NetworkPolicy::Lan
        )
        .is_err()
    );
    assert!(
        Description::parse(
            &describe(
                "uuid:x&#13;&#10;Injected",
                &service("ConnectionManager", "1", "/cm")
            ),
            &location,
            None,
            NetworkPolicy::Lan
        )
        .is_err()
    );
}

#[test]
fn https_qr_receivers_use_t2_control_without_weakening_http_discovery_contract() {
    let location = Url::parse("https://192.168.2.3:8443/description.xml").unwrap();
    let description = Description::parse(
        &description("uuid:fixture", true),
        &location,
        None,
        NetworkPolicy::Lan,
    )
    .unwrap();
    assert!(dlna_policy::lan_url(location.as_str(), NetworkPolicy::Lan).is_err());
    let context = DeviceContext::new(
        DiscoverySource::Manual,
        location.as_str(),
        "uuid:fixture",
        "",
    );
    let renderer = description
        .renderer(Ipv4Addr::new(192, 168, 2, 9), context)
        .unwrap();
    assert!(
        super::super::super::control::ControlClient::with_policy(
            renderer,
            &[Ipv4Addr::new(192, 168, 2, 9)],
            NetworkPolicy::Lan,
            HTTP_TIMEOUT
        )
        .is_ok()
    );
}
