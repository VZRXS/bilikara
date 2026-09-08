use super::*;
use crate::experimental_libav::{InspectionLevel, TimestampBounds};
fn pair() -> (ScanObservation, Inventory) {
    let requested = ScanSelection {
        stream_index: 1,
        expected_kind: ExpectedMediaKind::Audio,
    };
    let a = ScanObservation::new(
        requested,
        Ok(PacketScan {
            inspection_level: InspectionLevel::PacketScan,
            requested,
            terminal: ScanTerminal::Eof,
            error: None,
            demuxed_packets: 60,
            incidental_corrupt_packets: 0,
            selected: Some(PacketSummary {
                index: 1,
                media_type: StreamType::Audio,
                codec_name: Some("aac".into()),
                time_base: Some(TimeBase {
                    numerator: 1,
                    denominator: 48000,
                }),
                packet_count: 48,
                payload_bytes: 17000,
                corrupt_packets: 0,
                pts_ticks: Some(TimestampBounds {
                    min: -1024,
                    max: 47000,
                }),
                dts_ticks: None,
            }),
        }),
    );
    let b = reference_inventory(br#"{"streams":[{"index":1,"codec_type":"audio","codec_name":"aac","time_base":"1/48000","nb_read_packets":"48","tags":{"title":"SECRET_TITLE"}}]}"#, true, false);
    (a, b)
}
#[test]
fn exact_counts_identity_completion_and_errors_cannot_hide_mismatch() {
    let (a, b) = pair();
    assert!(!compare_inventory(&a, &b, true).needs_analysis());
    for field in [0, 1, 2, 3, 4, 5, 6] {
        let mut b = b.clone();
        match field {
            0 => b.streams[0].packet_count = Some(47),
            1 => b.streams[0].index = 0,
            2 => b.streams[0].media_type = StreamType::Video,
            3 => b.outcome = Outcome::Cancelled,
            4 => b.process_completed = false,
            5 => b.streams[0].packet_count = None,
            _ => b.streams[0].packet_count = Some(0),
        }
        assert!(compare_inventory(&a, &b, true).needs_analysis());
    }
    let mut bad = a.clone();
    bad.terminal = ScanTerminal::Incomplete;
    assert!(compare_inventory(&bad, &b, true).needs_analysis());
    for outcome in [
        Outcome::InvalidMedia,
        Outcome::Cancelled,
        Outcome::Io,
        Outcome::Timeout,
    ] {
        let a = ScanObservation::error(a.requested, outcome);
        let b = Inventory::error(outcome);
        let comparison = compare_inventory(&a, &b, true);
        assert!(comparison.needs_analysis());
        assert!(
            !comparison
                .kinds
                .contains(&Kind::MatchingComparablePacketScan)
        );
        assert!(compare_operational(&a, &Operational::error(outcome), true).needs_analysis());
    }
    assert!(compare_inventory(&a, &b, false).needs_analysis());
}
#[test]
fn diagnostics_unknown_counts_and_private_text_are_not_clean_parity() {
    let (a, mut b) = pair();
    b.diagnostics_present = true;
    let c = compare_inventory(&a, &b, true);
    assert!(c.needs_analysis());
    assert!(!c.kinds.contains(&Kind::MatchingComparablePacketScan));
    assert!(
        compare_operational(
            &a,
            &Operational {
                outcome: Outcome::Success,
                process_completed: true,
                diagnostics_present: true
            },
            true
        )
        .needs_analysis()
    );
    assert!(!serde_json::to_string(&b).unwrap().contains("SECRET_TITLE"));
    let error = ScanObservation::new(
        a.requested,
        Err(ProbeError::BackendFailure(
            "/private/SECRET_TITLE auth=SECRET".into(),
        )),
    );
    assert!(!serde_json::to_string(&error).unwrap().contains("SECRET"));
    for count in ["-1", "18446744073709551616", "wrong"] {
        let bytes = format!(
            r#"{{"streams":[{{"index":1,"codec_type":"audio","nb_read_packets":"{count}"}}]}}"#
        );
        assert_eq!(
            reference_inventory(bytes.as_bytes(), true, false).outcome,
            Outcome::InvalidOutput
        );
    }
    let b = reference_inventory(
        br#"{"streams":[{"index":1,"codec_type":"audio","nb_read_packets":"N/A"}]}"#,
        true,
        false,
    );
    assert_eq!(b.streams[0].packet_count, None);
    let code = reference_inventory(
        br#"{"error":{"code":-1094995529,"string":"SECRET"}}"#,
        false,
        true,
    );
    assert_eq!(code.outcome, Outcome::InvalidMedia);
    assert!(!serde_json::to_string(&code).unwrap().contains("SECRET"));
}
#[test]
fn ffmpeg_build_adapter_requires_compile_runtime_consistency() {
    let bytes = b"ffmpeg version 9.0.1 Copyright\nconfiguration: --disable-network --enable-shared\nlibavformat 63. 1.101 / 63. 1.101\nlibavcodec 63. 1.101 / 63. 1.101\nlibavutil 61. 1.101 / 61. 1.101\n";
    let b = ReferenceBuild::parse_ffmpeg(bytes).unwrap();
    assert_eq!(b.ffmpeg_identity().unwrap().version, "9.0.1");
    let bad = String::from_utf8_lossy(bytes).replace("/ 61. 1.101", "/ 61. 1.102");
    assert!(ReferenceBuild::parse_ffmpeg(bad.as_bytes()).is_err());
}
