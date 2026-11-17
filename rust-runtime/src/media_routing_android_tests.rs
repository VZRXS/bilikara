//! User decision 4: compare existing Rust outputs with the shared libav route.
use super::*;
use crate::experimental_libav::{LibavMetadataProbe, ScanSelection};
use std::fs;

fn fixture(relative: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join(relative)
        .canonicalize()
        .unwrap()
}
fn root() -> PathBuf {
    let mut nonce = [0u8; 8];
    getrandom::fill(&mut nonce).unwrap();
    let root = fixture("..")
        .join(".tmp")
        .join(format!("android-media-{}", u64::from_le_bytes(nonce)));
    fs::create_dir_all(&root).unwrap();
    root
}
fn companion() -> PathBuf {
    std::env::var_os("BILIKARA_TEST_CAST_COMPANION")
        .map(PathBuf::from)
        .expect("fresh same-build test companion")
}
fn inspect_result(path: &Path, kind: ExpectedMediaKind, config: &Configuration) -> Metadata {
    match inspect_with_config(
        &InspectRequest {
            schema_version: 1,
            operation: Operation::Validate,
            source: path.into(),
            expected_kind: kind,
            container_hint: None,
            compatibility: None,
        },
        config,
        &AtomicBool::new(false),
        &|| false,
    )
    .unwrap()
    {
        Inspection::Completed {
            metadata,
            diagnostic,
        } => {
            assert_eq!(diagnostic.backend, Backend::Libav);
            metadata
        }
        other => panic!("libav route did not execute: {other:?}"),
    }
}

#[test]
#[ignore = "requires BILIKARA_TEST_CAST_COMPANION; exercises real library and checked-in media"]
fn rust_and_libav_normalization_inspection_and_loudness_comparison() {
    let root = root();
    let config = Configuration {
        companion: Some(companion()),
        ..Configuration::default()
    };
    // SAFETY: explicit same-build test artifact.
    let probe = unsafe { LibavMetadataProbe::load(config.companion.as_ref().unwrap()) }.unwrap();
    let flag = AtomicBool::new(false);
    for (name, source, kind, extension) in [
        (
            "aac",
            "../tests/fixtures/bbdown/audio.m4a",
            ExpectedMediaKind::Audio,
            "m4a",
        ),
        (
            "flac",
            "../tests/fixtures/bbdown/audio-flac.mp4",
            ExpectedMediaKind::Audio,
            "flac",
        ),
        (
            "h264",
            "../tests/fixtures/bbdown/video.mp4",
            ExpectedMediaKind::Video,
            "mp4",
        ),
        (
            "aac30",
            "src/native_host/cast_session/fixtures/audio-30s.m4a",
            ExpectedMediaKind::Audio,
            "m4a",
        ),
        (
            "h26430",
            "src/native_host/cast_session/fixtures/keyframes-30s.mp4",
            ExpectedMediaKind::Video,
            "mp4",
        ),
        (
            "fragmented",
            "../tests/fixtures/bbdown/video-reordered-start.mp4",
            ExpectedMediaKind::Video,
            "mp4",
        ),
    ] {
        let source = fixture(source);
        let rust_path = root.join(format!("{name}-rust.{extension}"));
        let libav_path = root.join(format!("{name}-libav.{extension}"));
        let request = MediaNormalizeRequest {
            schema_version: 1,
            source: source.clone(),
            destination: rust_path.clone(),
            expected_kind: kind,
        };
        let rust =
            normalize_with_config(&request, &Configuration::default(), &flag, &|| false).unwrap();
        assert_eq!(rust.diagnostic.backend, Backend::PureRust);
        let libav = normalize_with_config(
            &MediaNormalizeRequest {
                destination: libav_path.clone(),
                ..request
            },
            &config,
            &flag,
            &|| false,
        )
        .unwrap();
        assert_eq!(libav.diagnostic.backend, Backend::Libav);
        assert_eq!(rust.media.output.codec, libav.media.output.codec);
        assert_eq!(rust.media.output.kind, libav.media.output.kind);
        // One AAC access unit (<=23.22 ms here), or one 30fps frame, plus
        // integer timescale rounding fits 50ms. No percentage-of-length slack.
        if name == "h264" {
            // This historical synthetic M6 fixture has a corrupt timescale:
            // mdhd timescale 256, stts 599998 ticks, mvhd timescale 1200000,
            // elst presentation duration 399999 ticks. Rust ignores the edit;
            // libav input honors it. Neither normalized duration is equivalent
            // to the edited source. Pin and report it, never widen tolerances.
            let bytes = fs::read(&source).unwrap();
            let mdhd = bytes.windows(4).position(|w| w == b"mdhd").unwrap();
            assert_eq!(
                u32::from_be_bytes(bytes[mdhd + 16..mdhd + 20].try_into().unwrap()),
                256
            );
            assert_eq!(
                u32::from_be_bytes(bytes[mdhd + 20..mdhd + 24].try_into().unwrap()),
                599998
            );
            assert_eq!(rust.media.output.duration_seconds, 599998.0 / 256.0);
            assert_eq!(libav.media.output.duration_seconds, 100000.0 / 256.0);
        } else {
            assert!(
                (rust.media.output.duration_seconds - libav.media.output.duration_seconds).abs()
                    <= 0.050,
                "{name}: {:?} vs {:?}",
                rust.media,
                libav.media
            );
        }
        // Inspect source with the old Rust parser and new route independently.
        let old = media_backend::probe_media(&MediaPathRequest {
            schema_version: 1,
            source: source.clone(),
            expected_kind: kind,
        })
        .unwrap();
        let new = inspect_result(&source, kind, &config);
        assert_eq!(new.stream_count, 1);
        assert_eq!(new.streams[0].kind, old.kind);
        assert_eq!(new.streams[0].codec.as_deref(), Some(old.codec.as_str()));
        assert_eq!(new.size, old.file_bytes);
        if name == "h264" {
            assert_eq!(old.duration_seconds, 599998.0 / 256.0);
            assert_eq!(new.streams[0].duration_seconds, Some(0.332031));
        } else {
            assert!(
                (new.streams[0].duration_seconds.unwrap() - old.duration_seconds).abs() <= 0.050,
                "{name}: old={old:?}, new={new:?}"
            );
        }
        let left = probe.probe_metadata(&rust_path, &flag).unwrap();
        let right = probe.probe_metadata(&libav_path, &flag).unwrap();
        let a = &left.streams[0];
        let b = &right.streams[0];
        let source_metadata = probe.probe_metadata(&source, &flag).unwrap();
        if matches!(name, "h26430" | "fragmented" | "aac" | "aac30") {
            // Presentation start, not just duration: Rust drops edit lists;
            // libav preserves B-frame offsets and AAC priming edits.
            let (source_start, rust_start) = match name {
                "h26430" => (0, 66_667),
                "fragmented" => (21_000, 166_875),
                "aac" | "aac30" => (0, 0),
                _ => unreachable!(),
            };
            assert_eq!(
                source_metadata.start_time_us,
                Some(source_start),
                "{name} source"
            );
            assert_eq!(
                source_metadata.streams[0].start_time_us,
                Some(source_start),
                "{name} source stream"
            );
            assert_eq!(left.start_time_us, Some(rust_start), "{name} Rust");
            assert_eq!(a.start_time_us, Some(rust_start), "{name} Rust stream");
            assert_eq!(right.start_time_us, Some(source_start), "{name} libav");
            assert_eq!(b.start_time_us, Some(source_start), "{name} libav stream");
            if matches!(name, "aac" | "aac30") {
                // Both report start=0, but Rust retains 1024 leading samples.
                let seconds = if name == "aac" { 1.0 } else { 30.0 };
                assert_eq!(
                    rust.media.output.duration_seconds,
                    seconds + 1024.0 / 48_000.0
                );
                assert_eq!(libav.media.output.duration_seconds, seconds);
            }
        }
        assert_eq!(
            (
                a.media_type,
                &a.codec_name,
                a.width_px,
                a.height_px,
                a.sample_rate_hz,
                a.channel_count,
                a.raw_bit_depth
            ),
            (
                b.media_type,
                &b.codec_name,
                b.width_px,
                b.height_px,
                b.sample_rate_hz,
                b.channel_count,
                b.raw_bit_depth
            )
        );
        let a_scan = probe
            .scan_packets(
                &rust_path,
                ScanSelection {
                    stream_index: 0,
                    expected_kind: kind,
                },
                &flag,
            )
            .unwrap();
        let b_scan = probe
            .scan_packets(
                &libav_path,
                ScanSelection {
                    stream_index: 0,
                    expected_kind: kind,
                },
                &flag,
            )
            .unwrap();
        assert!(a_scan.clean_eof() && b_scan.clean_eof());
        let a_packets = a_scan.selected.unwrap();
        let b_packets = b_scan.selected.unwrap();
        assert_eq!(a_packets.packet_count, b_packets.packet_count, "{name}");
        assert_eq!(a_packets.payload_bytes, b_packets.payload_bytes, "{name}");
        let loudness = if kind == ExpectedMediaKind::Audio {
            let a = probe.integrated_loudness(&rust_path, &flag).unwrap();
            let b = probe.integrated_loudness(&libav_path, &flag).unwrap();
            // Remux must not change gain. 0.1 LU allows AAC priming/edit-list
            // boundary rounding and EBU histogram quantization, not transcoding.
            assert!(
                (a.integrated_lufs - b.integrated_lufs).abs() <= 0.1,
                "{name}: {a:?} vs {b:?}"
            );
            serde_json::json!([a.integrated_lufs, b.integrated_lufs])
        } else {
            serde_json::Value::Null
        };
        println!(
            "A2_COMPARISON {}",
            serde_json::json!({"fixture":name,"source_start_us":source_metadata.start_time_us,"rust_start_us":left.start_time_us,"libav_start_us":right.start_time_us,"rust_seconds":rust.media.output.duration_seconds,"libav_seconds":libav.media.output.duration_seconds,"rust_bytes":rust.media.output.file_bytes,"libav_bytes":libav.media.output.file_bytes,"packets":a_packets.packet_count,"payload_bytes":a_packets.payload_bytes,"codec":a.codec_name,"rate":a.sample_rate_hz,"channels":a.channel_count,"width":a.width_px,"height":a.height_px,"lufs":loudness})
        );
        // Existing Rust output is readable by the new route without mutation.
        let before = fs::read(&rust_path).unwrap();
        inspect_result(&rust_path, kind, &config);
        assert_eq!(fs::read(&rust_path).unwrap(), before);
    }
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn missing_or_invalid_companion_preserves_rust_normalization_and_records_reason() {
    let root = root();
    let invalid = root.join("invalid-library");
    fs::write(&invalid, b"not a dynamic library").unwrap();
    for (i, path) in [root.join("missing-library"), invalid]
        .into_iter()
        .enumerate()
    {
        let config = Configuration {
            companion: Some(path),
            ..Configuration::default()
        };
        let source = fixture("../tests/fixtures/bbdown/audio.m4a");
        let request = MediaNormalizeRequest {
            schema_version: 1,
            source: source.clone(),
            destination: root.join(format!("fallback-{i}.m4a")),
            expected_kind: ExpectedMediaKind::Audio,
        };
        let result =
            normalize_with_config(&request, &config, &AtomicBool::new(false), &|| false).unwrap();
        let expected = media_backend::normalize_media(&MediaNormalizeRequest {
            destination: root.join(format!("old-{i}.m4a")),
            ..request
        })
        .unwrap();
        assert_eq!(
            fs::read(&result.media.output.path).unwrap(),
            fs::read(&expected.output.path).unwrap()
        );
        assert_eq!(result.diagnostic.backend, Backend::PureRust);
        assert_eq!(
            result.diagnostic.compatibility_reason,
            Some(Reason::Unavailable)
        );
        let inspected = inspect_with_config(
            &InspectRequest {
                schema_version: 1,
                operation: Operation::Metadata,
                source: source.clone(),
                expected_kind: ExpectedMediaKind::Audio,
                container_hint: None,
                compatibility: None,
            },
            &config,
            &AtomicBool::new(false),
            &|| false,
        )
        .unwrap();
        let Inspection::Completed {
            metadata,
            diagnostic,
        } = inspected
        else {
            panic!("Rust fallback")
        };
        let old = media_backend::probe_media(&MediaPathRequest {
            schema_version: 1,
            source,
            expected_kind: ExpectedMediaKind::Audio,
        })
        .unwrap();
        assert_eq!(metadata.duration_seconds, Some(old.duration_seconds));
        assert_eq!(
            metadata.streams[0].codec.as_deref(),
            Some(old.codec.as_str())
        );
        assert_eq!(diagnostic.compatibility_reason, Some(Reason::Unavailable));
    }
    fs::remove_dir_all(root).unwrap();
}
