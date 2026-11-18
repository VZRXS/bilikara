use super::*;
use base64::engine::general_purpose::{STANDARD_NO_PAD, URL_SAFE};

fn renderer() -> Renderer {
    let f = Fixture::start(vec![]);
    let r = f.renderer();
    f.join();
    r
}
fn identification(r: &Report) -> &Value {
    &r.diagnostics()["cast"]["devices"][0]["device"]["identification"]
}

#[test]
fn approved_metadata_projections_are_readable_and_rule_hits_are_typed() {
    let mut r = renderer();
    r.description.manufacturer = "sOnY".into();
    r.description.model_name = "BRAVIA   KD-55X80J".into();
    r.description.name = "海豚星空 私密房间".into();
    r.description.model_description = "LeLink receiver".into();
    r.context.server = "Linux/5.15.0-private-host UPnP/1.0 Platinum/1.0.5.13 Secret/987654".into();
    let t = trace(30);
    t.renderer(&r);
    let id = t.begin_output(&r.context, config(None));
    t.capabilities(
        id,
        ProtocolState::Reported,
        &["http-get:*:video/vnd.dlna.mpeg-tts:*".into()],
        true,
        false,
    );
    let report = t.report();
    let p = identification(&report);
    assert!(p["brands"].as_array().unwrap().contains(&json!("sony")));
    assert_eq!(p["model"], "Sony KD-55X80J");
    assert_eq!(
        p["server_products"],
        json!([{"name":"Platinum","major":1},{"name":"Linux","major":null}])
    );
    assert_eq!(p["rules"]["is_purek_room"], false);
    assert_eq!(p["rules"]["is_lebo_receiver"], false);
    assert_eq!(p["rules"]["declares_ts"], true);
    assert_eq!(p["rules"]["has_avtransport"], true);
    assert_eq!(p["rules"]["server_stack"], json!(["platinum"]));
    assert!(
        p["brand_matches"]
            .as_array()
            .unwrap()
            .iter()
            .all(|m| m["field"] != "friendly_name" && m["field"] != "model_description")
    );
    let name = &report.diagnostics()["cast"]["devices"][0]["device"]["friendly_name"];
    assert!(name.get("digest").is_some());
    assert_eq!(name.as_object().unwrap().len(), 4);
    for raw in ["私密房间", "5.15.0-private-host", "1.0.5.13", "987654"] {
        assert!(!report.json().contains(raw));
        assert!(!report.text().contains(raw));
    }
    assert!(report.text().contains("Platinum/1"));
    assert!(report.text().contains("model=Sony KD-55X80J"));
    // An unrelated snapshot must preserve recognized manufacturer/model facts.
    t.record_stage_at(
        None,
        None,
        Duration::ZERO,
        &StageResult {
            context: Some(r.context.clone()),
            ..stage(Stage::Description, Ok(()))
        },
    );
    assert_eq!(identification(&t.report())["model"], "Sony KD-55X80J");
    t.capabilities(id, ProtocolState::Unavailable, &[], true, false);
    assert!(identification(&t.report())["rules"]["declares_ts"].is_null());
    let c = t.begin_connection();
    let mut phase = purek::PhaseResult {
        schema_version: 1,
        phase: purek::Phase::DescriptionBefore,
        stage: StageResult {
            context: Some(r.context.clone()),
            ..stage(Stage::Description, Ok(()))
        },
        error_code: None,
        facts: purek::PhaseFacts::default(),
    };
    phase.facts.services = Some(purek::ServiceSummary {
        entries: vec![],
        advertised: 40,
        truncated: true,
    });
    t.purek(c, &phase);
    assert!(identification(&t.report())["rules"]["has_avtransport"].is_null());
    phase.facts.services.as_mut().unwrap().truncated = false;
    t.purek(c, &phase);
    assert_eq!(
        identification(&t.report())["rules"]["has_avtransport"],
        false
    );
}

#[test]
fn model_codes_whitespace_masks_and_output_bound_are_conservative() {
    for (raw, expected) in [
        ("", "unknown"),
        ("  \t ", "unknown"),
        ("55A6H  TV", "55A6H TV"),
        ("KD-55X80J\tTV", "KD-55X80J TV"),
        ("889", "*"),
        ("KD-55X80J 123456 ABCDEF12", "KD-55X80J * *"),
        ("serial KD-55X80J", "* *"),
        ("PrivateUserKevin", "*"),
        ("TV 192.168.31.86", "TV *"),
        ("TV AA-BB-CC-DD-EE-FF", "TV *"),
        ("TV uuid-8b8931b8-0f54-4562-924d-0269a14d270f", "TV *"),
        (r"C:\Users\Kevin\video.mp4", "*"),
        ("room-private-889", "*"),
        ("token PkTok9", "* *"),
        ("TV 🎤", "TV *"),
    ] {
        let mut r = renderer();
        r.description.model_name = raw.into();
        let t = trace(10);
        t.renderer(&r);
        assert_eq!(identification(&t.report())["model"], expected, "{raw}");
    }
    let mut r = renderer();
    r.description.model_name = "KD-55X80J TV ".repeat(30);
    let t = trace(10);
    t.renderer(&r);
    let report = t.report();
    let model = identification(&report)["model"].as_str().unwrap();
    assert!(model.len() <= 48 && model.is_ascii());
    assert!(
        model
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-._ *".contains(&b))
    );
}

#[test]
fn separated_ipv4_models_are_masked_in_every_export() {
    for (raw, address) in [
        ("KD-192-168-1-5", "192-168-1-5"),
        ("TV-10-0-0-23", "10-0-0-23"),
        ("IP192-168-31-86", "192-168-31-86"),
        ("KD_192_168_1_5", "192_168_1_5"),
        ("MiTV-192-168-31-86", "192-168-31-86"),
        ("MiTV-IP192_168_31_86", "192_168_31_86"),
        ("KD-192.168_1-5", "192.168_1-5"),
    ] {
        let mut r = renderer();
        r.description.model_name = raw.into();
        let t = trace(10);
        t.renderer(&r);
        let report = t.report();
        assert_eq!(identification(&report)["model"], "*", "{raw}");
        for surface in export_surfaces(&report) {
            for forbidden in forms(address) {
                assert!(
                    !surface.contains(&forbidden),
                    "leaked {forbidden} from {raw}"
                );
            }
        }
    }
}

#[test]
fn room_names_and_free_text_do_not_classify_devices() {
    let mut r = renderer();
    r.description.manufacturer = "Sony".into();
    r.description.model_name = "KD-55X80J".into();
    r.description.model_description.clear();
    r.context.server.clear();
    let t = trace(10);
    t.renderer(&r);
    let baseline = identification(&t.report()).clone();
    for room in [
        "荣耀厅",
        "三星包厢",
        "长虹厅",
        "Platinum VIP Room",
        "Sharp Room",
        "海豚星空 纯K ChunK Hpplay LeBo Lelink 包厢",
    ] {
        r.description.name = room.into();
        r.description.model_description = format!("{room} LeBo PureK");
        t.renderer(&r);
        let report = t.report();
        assert_eq!(identification(&report), &baseline, "{room}");
        assert_eq!(identification(&report)["brands"], json!(["sony"]));
        for surface in export_surfaces(&report) {
            assert!(!surface.contains(room), "leaked room {room}");
        }
        let name = &report.diagnostics()["cast"]["devices"][0]["device"]["friendly_name"];
        assert!(name["digest"].is_string());
        assert_eq!(name.as_object().unwrap().len(), 4);
    }
    // Authoritative fields still drive classification, independently of rooms.
    for source in ["manufacturer", "model_name", "server"] {
        for (raw, brand, purek, lebo) in [
            ("chunk.cn", "purek", true, false),
            ("ChunK", "purek", true, false),
            ("Hpplay", "lebo", false, true),
        ] {
            r.description.manufacturer.clear();
            r.description.model_name.clear();
            r.context.server.clear();
            match source {
                "manufacturer" => r.description.manufacturer = raw.into(),
                "model_name" => r.description.model_name = raw.into(),
                _ => r.context.server = raw.into(),
            }
            t.renderer(&r);
            let report = t.report();
            let p = identification(&report);
            assert_eq!(p["brands"], json!([brand]), "{source}: {raw}");
            assert_eq!(p["rules"]["is_purek_room"], purek);
            assert_eq!(p["rules"]["is_lebo_receiver"], lebo);
        }
    }
}

#[test]
fn public_model_codes_remain_readable_and_brand_aliases_are_deduplicated() {
    for (raw, expected, brands) in [
        ("MiTV-MSSP3", "MiTV-MSSP3", json!(["xiaomi"])),
        ("mitv-MSSP3", "MiTV-MSSP3", json!(["xiaomi"])),
        ("Hisense 65E8D VIDAA", "Hisense 65E8D", json!(["hisense"])),
        ("A12345 K8812", "A12345 K8812", json!(["unknown"])),
        ("MiTV-A123456", "*", json!(["xiaomi"])),
        ("MiTV-ABCDEF12", "*", json!(["xiaomi"])),
        ("MiTV-Private8812", "*", json!(["xiaomi"])),
    ] {
        let mut r = renderer();
        r.description.manufacturer.clear();
        r.description.model_name = raw.into();
        r.context.server.clear();
        let t = trace(10);
        t.renderer(&r);
        let report = t.report();
        let p = identification(&report);
        assert_eq!(p["model"], expected, "{raw}");
        assert_eq!(p["brands"], brands, "{raw}");
    }
}

fn export_surfaces(report: &Report) -> Vec<String> {
    let request:crate::DiagnosticRequest=serde_json::from_value(json!({"app_home":".tmp/no-metadata-data","log_dir":".tmp/no-metadata-logs","system":{},"tools_and_tasks":{},"cache_policy":{},"runtime_state":{},"connectivity_override":{}})).unwrap();
    let artifact = report.artifact(&request).unwrap();
    let mut surfaces = vec![
        report.json(),
        report.text().into(),
        format!("{report:?}"),
        artifact.markdown,
    ];
    let mut zip =
        zip::ZipArchive::new(Cursor::new(STANDARD.decode(artifact.zip_base64).unwrap())).unwrap();
    for i in 0..zip.len() {
        let mut text = String::new();
        zip.by_index(i).unwrap().read_to_string(&mut text).unwrap();
        surfaces.push(text);
    }
    surfaces
}

fn forms(raw: &str) -> Vec<String> {
    let hex: String = raw.as_bytes().iter().map(|b| format!("{b:02x}")).collect();
    let percent: String = raw.as_bytes().iter().map(|b| format!("%{b:02X}")).collect();
    vec![
        raw.into(),
        raw.to_lowercase(),
        raw.to_uppercase(),
        hex.clone(),
        hex.to_uppercase(),
        percent.clone(),
        percent.to_lowercase(),
        STANDARD.encode(raw),
        STANDARD_NO_PAD.encode(raw),
        URL_SAFE.encode(raw),
        URL_SAFE_NO_PAD.encode(raw),
        serde_json::to_string(raw)
            .unwrap()
            .trim_matches('"')
            .to_owned(),
        raw.encode_utf16().map(|c| format!("\\u{c:04x}")).collect(),
    ]
}

#[test]
fn hidden_secrets_in_all_metadata_and_encodings_never_escape_any_export() {
    let secrets = [
        "6f67cd9e1a2840cab1a2307afba009d1",
        "PkTok+9/x=Zq",
        "place-private-889",
        "bill-private-777",
        "192.168.31.86",
        "2001:db8::dead:beef",
        "fe80::beef%eth0",
        "uuid:8b8931b8-0f54-4562-924d-0269a14d270f",
        "AA:BB:CC:DD:EE:FF",
        "AA-BB-CC-DD-EE-FF",
        "PrivateUserKevin",
        "用户名小王",
        r"C:\Users\PrivateUserKevin\PrivateMedia\secret.mp4",
        "secret-user@example.invalid",
        "userinfo:pass",
        "房间私密889",
    ];
    for secret in secrets {
        for injected in forms(secret) {
            let mut r = renderer();
            let v = format!("Sony {injected}");
            r.description.manufacturer = v.clone();
            r.description.model_name = v.clone();
            r.description.model_description = v.clone();
            r.description.name = v;
            r.context.server = format!("Linux/6.8.0 Platinum/1.0 {injected}");
            let t = trace(10);
            t.renderer(&r);
            let report = t.report();
            let surfaces = export_surfaces(&report);
            for forbidden in forms(secret) {
                for text in &surfaces {
                    assert!(
                        !text.contains(&forbidden),
                        "leaked {forbidden} from {injected}"
                    );
                }
            }
        }
    }
}
