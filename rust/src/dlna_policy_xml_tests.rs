// B8 regression cases ported from bilikara-next integration 3057fb7,
// rust-runtime/src/native_host/purek/tests.rs (introduced by 7061f1f).
// The Runtime keeps its original adapter/integration assertions as well.
use super::*;

#[test]
fn network_xml_depth_is_bounded_on_a_two_mib_stack() {
    std::thread::Builder::new()
        .stack_size(2 * 1024 * 1024)
        .spawn(|| {
            for depth in [65, 5000] {
                // Fake closes in lexical sections must not hide real nesting.
                let text = format!(
                    "{}<!-- </n> --><![CDATA[</n>]]><?pi </n>?>secret{}",
                    "<n>".repeat(depth),
                    "</n>".repeat(depth)
                );
                let error = bounded_xml(&text, MAX_XML_BYTES).unwrap_err();
                assert_eq!(error, PolicyError::TooDeep);
                assert!(!format!("{error:?}").contains("secret"));
            }
            for depth in [1, 63, 64] {
                for leaf in ["<n/>", "<n></n>"] {
                    let text = format!(
                        "{}{leaf}{}",
                        "<n>".repeat(depth - 1),
                        "</n>".repeat(depth - 1)
                    );
                    let doc = bounded_xml(&text, MAX_XML_BYTES).unwrap();
                    assert_eq!(doc.descendants().filter(|n| n.is_element()).count(), depth);
                }
            }
            let empty_leaf_at_65 = format!("{}<n/>{}", "<n>".repeat(64), "</n>".repeat(64));
            assert_eq!(
                bounded_xml(&empty_leaf_at_65, MAX_XML_BYTES).unwrap_err(),
                PolicyError::TooDeep
            );
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
    let doc = bounded_xml(&text, MAX_XML_BYTES).unwrap();
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
        assert_eq!(
            bounded_xml(&text, MAX_XML_BYTES).unwrap_err(),
            PolicyError::TooDeep
        );
    }
    for invalid in [
        "<n a='<fake>'/>",
        "<n a=\"<fake>\"/>",
        "<n a='unterminated/>",
        "<n><fake</n>",
        "<n><!-- unterminated</n>",
        "<n><![CDATA[unterminated</n>",
        "<n><?pi unterminated</n>",
        "</n><n/>",
        "<n>",
        "<!DOCTYPE n [<!ENTITY x '<n/>'>]><n>&x;</n>",
    ] {
        assert_eq!(
            bounded_xml(invalid, MAX_XML_BYTES).unwrap_err(),
            PolicyError::InvalidXml
        );
    }
}

#[test]
fn network_xml_size_budget_also_applies_to_direct_parser_calls() {
    let mut text = format!("<root>{}</root>", "x".repeat(1024 * 1024 - 13));
    assert_eq!(text.len(), 1024 * 1024);
    assert!(bounded_xml(&text, MAX_XML_BYTES).is_ok());
    text.push(' ');
    for limit in [MAX_XML_BYTES, usize::MAX] {
        assert_eq!(
            bounded_xml(&text, limit).unwrap_err(),
            PolicyError::TooLarge
        );
    }
}

#[test]
fn network_xml_node_budget_applies_to_all_protocol_parsers() {
    // roxmltree counts the document root and the <root> element as two nodes.
    // Comments and processing instructions consume the same node budget.
    for leaf in ["<n/>", "<!-- n -->", "<?pi n?>"] {
        let text = format!("<root>{}</root>", leaf.repeat(8190));
        let doc = bounded_xml(&text, MAX_XML_BYTES).unwrap();
        assert_eq!(doc.descendants().count(), 8192);
        let text = format!("<root>{}</root>", leaf.repeat(8191));
        assert_eq!(
            bounded_xml(&text, MAX_XML_BYTES).unwrap_err(),
            PolicyError::InvalidXml
        );
    }
    let text = format!("<root>{}</root>", "<n/>".repeat(8191));
    assert!(text.len() < MAX_SOAP_BYTES);
    assert_eq!(
        parse_description(
            &text,
            "http://192.168.1.8/description.xml",
            "uuid:fixture",
            "",
            NetworkPolicy::Lan
        ),
        Err(PolicyError::InvalidXml)
    );
    assert_eq!(
        validate_soap_response(&text, SoapAction::Play),
        Err(PolicyError::InvalidXml)
    );
    assert_eq!(
        parse_sink_protocol_info(&text),
        Err(PolicyError::InvalidXml)
    );
    assert_eq!(parse_transport_info(&text), Err(PolicyError::InvalidXml));
    assert_eq!(parse_position_info(&text), Err(PolicyError::InvalidXml));
}

#[test]
fn network_xml_retains_smaller_soap_and_utf8_byte_budgets() {
    let prefix = "<Envelope><Body><PlayResponse>";
    let suffix = "</PlayResponse></Body></Envelope>";
    let mut text = format!(
        "{prefix}{}{suffix}",
        "x".repeat(64 * 1024 - prefix.len() - suffix.len())
    );
    assert_eq!(text.len(), 64 * 1024);
    assert_eq!(validate_soap_response(&text, SoapAction::Play), Ok(()));
    text.push(' ');
    assert!(bounded_xml(&text, MAX_XML_BYTES).is_ok());
    assert_eq!(
        validate_soap_response(&text, SoapAction::Play),
        Err(PolicyError::TooLarge)
    );
    assert_eq!(parse_sink_protocol_info(&text), Err(PolicyError::TooLarge));
    assert_eq!(parse_transport_info(&text), Err(PolicyError::TooLarge));
    assert_eq!(parse_position_info(&text), Err(PolicyError::TooLarge));
    assert!(bounded_xml("<叶/>", 6).is_ok());
    assert_eq!(bounded_xml("<叶/>", 5).unwrap_err(), PolicyError::TooLarge);
}
