use super::*;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::Ordering;

fn raw_result() -> wire::ProbeResult {
    // These wire structs contain only integers/byte arrays, so zero is valid.
    let mut raw: wire::ProbeResult = unsafe { std::mem::zeroed() };
    raw.inspection_level = 1;
    raw.stream_count = 1;
    raw.container.len = 4;
    raw.container.bytes[..4].copy_from_slice(b"flac");
    raw
}

#[test]
fn unknown_fields_are_none_and_negative_start_is_preserved() {
    let mut raw = raw_result();
    raw.streams[0].duration_ticks = i64::MIN; // ignored unless explicitly known
    let value = convert_metadata(&raw, "test").unwrap();
    assert_eq!(value.duration_us, None);
    assert_eq!(value.streams[0].duration_us, None);
    assert_eq!(value.streams[0].raw_bit_depth, None);
    assert_eq!(value.streams[0].codec_name, None);
    raw.streams[0].present = wire::START | wire::TIME_BASE;
    raw.streams[0].time_base_num = 1;
    raw.streams[0].time_base_den = 48000;
    raw.streams[0].start_ticks = -1024;
    assert_eq!(
        convert_metadata(&raw, "test").unwrap().streams[0].start_time_us,
        Some(-21333)
    );
}

#[test]
fn time_conversion_checks_units_rounding_sentinels_and_overflow() {
    let base = TimeBase {
        numerator: 1,
        denominator: 48000,
    };
    assert_eq!(ticks_us(48000, base).unwrap(), 1_000_000);
    assert_eq!(ticks_us(-48000, base).unwrap(), -1_000_000);
    assert_eq!(
        ticks_us(
            1,
            TimeBase {
                numerator: 1,
                denominator: 2_000_000
            }
        )
        .unwrap(),
        1
    );
    assert_eq!(
        ticks_us(
            -1,
            TimeBase {
                numerator: 1,
                denominator: 2_000_000
            }
        )
        .unwrap(),
        -1
    );
    assert!(ticks_us(i64::MIN, base).is_err());
    assert!(
        ticks_us(
            i64::MAX,
            TimeBase {
                numerator: i32::MAX,
                denominator: 1
            }
        )
        .is_err()
    );
    assert!(
        ticks_us(
            1,
            TimeBase {
                numerator: 0,
                denominator: 1
            }
        )
        .is_err()
    );
}

#[test]
fn malformed_project_results_fail_explicitly() {
    let mut raw = raw_result();
    raw.stream_count = 33;
    assert!(convert_metadata(&raw, "test").is_err());
    raw.stream_count = 1;
    raw.streams[0].present = wire::DURATION;
    assert!(convert_metadata(&raw, "test").is_err());
    raw.streams[0].present = wire::TIME_BASE | wire::START;
    raw.streams[0].time_base_num = 1;
    raw.streams[0].time_base_den = 1000;
    raw.streams[0].start_ticks = i64::MIN;
    assert!(convert_metadata(&raw, "test").is_err());
    raw.streams[0].present = 0;
    raw.container.len = 129;
    assert!(convert_metadata(&raw, "test").is_err());
    raw.container.len = 1;
    raw.container.bytes[0] = 255;
    assert!(convert_metadata(&raw, "test").is_err());
}

#[test]
fn errors_keep_availability_cancellation_and_media_semantics_separate() {
    assert!(matches!(
        status_error(1, "missing".into()),
        ProbeError::Unavailable(_)
    ));
    assert_eq!(status_error(9, "cancelled".into()), ProbeError::Cancelled);
    assert!(matches!(
        status_error(999, "unknown".into()),
        ProbeError::BackendFailure(_)
    ));
    for (status, expected) in [
        (2, MediaErrorKind::InvalidRequest),
        (3, MediaErrorKind::SourceMissing),
        (5, MediaErrorKind::UnsupportedCodec),
        (6, MediaErrorKind::MediaContractViolation),
        (7, MediaErrorKind::InvalidMedia),
        (8, MediaErrorKind::Io),
    ] {
        let ProbeError::Media(error) = status_error(status, "test".into()) else {
            panic!("expected Media")
        };
        assert_eq!(error.kind, expected);
        assert_eq!(
            error.kind.allows_backend_fallback(),
            expected == MediaErrorKind::UnsupportedCodec
        );
    }
}

#[test]
fn missing_companion_is_unavailable_and_default_state_still_initializes() {
    // No artifact/environment is consulted by AppState or the established probe.
    let mut state = crate::AppState::default();
    let request = serde_json::from_value(serde_json::json!({
        "command": "initialize", "schema_version": 1,
        "state": { "session_started_at": 1.0, "session_played_file": "session.json", "updated_at": 1.0 }
    })).unwrap();
    assert!(matches!(
        state.execute(request),
        crate::AppStateResponse::Success(_)
    ));
    assert!(matches!(
        state.execute(crate::AppStateRequest::Snapshot { schema_version: 1 }),
        crate::AppStateResponse::Success(_)
    ));
    let result = unsafe { LibavMetadataProbe::load(Path::new("/bilikara-m1-absent/companion.so")) };
    assert!(matches!(result, Err(ProbeError::Unavailable(_))));
    let error = crate::probe_media(&crate::MediaPathRequest {
        schema_version: 1,
        source: PathBuf::from("/bilikara-m1-absent/input.mp4"),
        expected_kind: crate::ExpectedMediaKind::Video,
    })
    .unwrap_err();
    assert_eq!(error.kind, MediaErrorKind::SourceMissing);
    if let Some(input) = std::env::var_os("BILIKARA_M1_DEFAULT_INPUT") {
        let result = crate::probe_media(&crate::MediaPathRequest {
            schema_version: 1,
            source: input.into(),
            expected_kind: crate::ExpectedMediaKind::Video,
        })
        .unwrap();
        assert_eq!(result.codec, "h264");
        let maps = std::fs::read_to_string("/proc/self/maps").unwrap();
        assert!(!maps.contains("libbilikara_media_libav"));
        assert!(!maps.contains("libavformat.so"));
    }
}

#[test]
fn negotiation_rejects_mismatched_runtime_facts_and_layout() {
    fn set<const N: usize>(out: &mut wire::Text<N>, value: &str) {
        out.len = value.len() as u32;
        out.bytes[..value.len()].copy_from_slice(value.as_bytes());
    }
    let mut info: wire::Info = unsafe { std::mem::zeroed() };
    info.abi = 1;
    info.request_size = std::mem::size_of::<wire::Request>() as u32;
    info.result_size = std::mem::size_of::<wire::ProbeResult>() as u32;
    info.stream_size = std::mem::size_of::<wire::Stream>() as u32;
    info.build_versions = [4129125, 4129125, 3998053];
    info.runtime_versions = info.build_versions;
    set(&mut info.backend, "bilikara_media_libav");
    set(&mut info.build_version, "9.0.1");
    set(&mut info.runtime_version, "9.0.1");
    set(&mut info.build_config, "--disable-network --enable-shared");
    for config in &mut info.runtime_configs {
        set(config, "--disable-network --enable-shared");
    }
    assert!(convert_info(&info).is_ok());
    info.runtime_versions[0] += 1;
    assert!(matches!(
        convert_info(&info),
        Err(ProbeError::Unavailable(_))
    ));
    info.runtime_versions = info.build_versions;
    set(&mut info.runtime_configs[1], "different");
    assert!(matches!(
        convert_info(&info),
        Err(ProbeError::Unavailable(_))
    ));
    set(
        &mut info.runtime_configs[1],
        "--disable-network --enable-shared",
    );
    info.result_size -= 1;
    assert!(matches!(
        convert_info(&info),
        Err(ProbeError::Unavailable(_))
    ));
}

fn env_path(name: &str) -> PathBuf {
    let path = PathBuf::from(
        std::env::var_os(name).unwrap_or_else(|| panic!("{name} is REQUIRED for live tests")),
    );
    assert!(
        path.is_absolute() && path.exists(),
        "{name} missing/invalid: {path:?}"
    );
    path
}
fn live_probe() -> LibavMetadataProbe {
    // SAFETY: explicit acceptance invocation supplies the trusted test artifact.
    unsafe { LibavMetadataProbe::load(&env_path("BILIKARA_LIBAV_COMPANION")) }
        .expect("live artifact must load; never skip")
}
fn fixtures() -> PathBuf {
    env_path("BILIKARA_LIBAV_FIXTURES")
}
fn probe_file(probe: &LibavMetadataProbe, name: &str) -> Result<Metadata, ProbeError> {
    probe.probe_metadata(&fixtures().join(name), &AtomicBool::new(false))
}
fn reference(name: &str) -> serde_json::Value {
    let prefix = env_path("BILIKARA_LIBAV_FFMPEG_PREFIX");
    let output = Command::new(prefix.join("bin/ffprobe"))
        .env("LD_LIBRARY_PATH", prefix.join("lib"))
        .args([
            "-v",
            "error",
            "-probesize",
            "1048576",
            "-analyzeduration",
            "1000000",
            "-max_probe_packets",
            "256",
            "-skip_estimate_duration_from_pts",
            "1",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
        ])
        .arg(fixtures().join(name))
        .output()
        .expect("same-build ffprobe");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
fn reference_time(value: &serde_json::Value) -> Option<i64> {
    value
        .as_str()
        .map(|v| (v.parse::<f64>().unwrap() * 1_000_000.0).round() as i64)
}
fn compare_time(actual: Option<i64>, reference: Option<i64>) {
    match (actual, reference) {
        (Some(a), Some(b)) => assert!(
            (a - b).abs() <= 1,
            "microsecond rounding tolerance: {a} != {b}"
        ),
        (a, b) => assert_eq!(a, b),
    }
}

#[test]
#[ignore = "requires explicit trusted companion, same-build ffprobe and generated fixtures"]
fn live_metadata_matches_same_build_ffprobe() {
    let probe = live_probe();
    assert_eq!(
        probe.info.build_library_versions,
        probe.info.runtime_library_versions
    );
    for name in [
        "video.mp4",
        "aac.m4a",
        "av.mp4",
        "audio.flac",
        "flac.mp4",
        "unknown-duration.flac",
    ] {
        let actual = probe_file(&probe, name).unwrap();
        let expected = reference(name);
        assert_eq!(actual.inspection_level, InspectionLevel::StreamMetadata);
        assert_eq!(
            actual.container,
            expected["format"]["format_name"].as_str().unwrap()
        );
        compare_time(
            actual.duration_us,
            reference_time(&expected["format"]["duration"]),
        );
        compare_time(
            actual.start_time_us,
            reference_time(&expected["format"]["start_time"]),
        );
        let streams = expected["streams"].as_array().unwrap();
        assert_eq!(actual.streams.len(), streams.len());
        for (a, e) in actual.streams.iter().zip(streams) {
            assert_eq!(a.index, e["index"].as_u64().unwrap() as u32);
            assert_eq!(a.codec_name.as_deref(), e["codec_name"].as_str());
            compare_time(a.duration_us, reference_time(&e["duration"]));
            compare_time(a.start_time_us, reference_time(&e["start_time"]));
            let base = a.time_base.unwrap();
            assert_eq!(
                format!("{}/{}", base.numerator, base.denominator),
                e["time_base"].as_str().unwrap()
            );
            assert_eq!(a.width_px.map(u64::from), e["width"].as_u64());
            assert_eq!(a.height_px.map(u64::from), e["height"].as_u64());
            assert_eq!(
                a.sample_rate_hz,
                e["sample_rate"].as_str().map(|v| v.parse().unwrap())
            );
            assert_eq!(a.channel_count.map(u64::from), e["channels"].as_u64());
            assert_eq!(
                a.raw_bit_depth,
                e["bits_per_raw_sample"]
                    .as_str()
                    .map(|v| v.parse::<u32>().unwrap())
                    .filter(|v| *v > 0)
            );
        }
        println!("{name}: {}", serde_json::to_string(&actual).unwrap());
    }
    let av = probe_file(&probe, "av.mp4").unwrap();
    assert_eq!(av.streams.len(), 2);
    assert!(
        av.streams
            .iter()
            .any(|v| v.codec_name.as_deref() == Some("h264"))
    );
    assert!(
        av.streams
            .iter()
            .any(|v| v.codec_name.as_deref() == Some("aac"))
    );
    assert_eq!(
        probe_file(&probe, "aac.m4a").unwrap().streams[0].raw_bit_depth,
        None
    );
}

#[test]
#[ignore = "requires explicit live artifacts"]
fn live_input_scope_and_errors() {
    let probe = live_probe();
    for path in [
        Path::new("relative.mp4"),
        Path::new("https://example.invalid/a.mp4"),
        Path::new("pipe:0"),
        Path::new("/dev/null"),
        Path::new("/dev/zero"),
        fixtures().as_path(),
    ] {
        assert!(matches!(
            probe.probe_metadata(path, &AtomicBool::new(false)),
            Err(ProbeError::Media(MediaError {
                kind: MediaErrorKind::InvalidRequest,
                ..
            }))
        ));
    }
    assert!(matches!(
        probe_file(&probe, "does-not-exist"),
        Err(ProbeError::Media(MediaError {
            kind: MediaErrorKind::SourceMissing,
            ..
        }))
    ));
    for name in ["truncated.mp4", "unknown.bin"] {
        assert!(matches!(
            probe_file(&probe, name),
            Err(ProbeError::Media(MediaError {
                kind: MediaErrorKind::InvalidMedia,
                ..
            }))
        ));
    }
    for name in ["outside.wav", "local.ffconcat"] {
        assert!(
            matches!(
                probe_file(&probe, name),
                Err(ProbeError::UnsupportedFormat(_))
            ),
            "{name}"
        );
    }
    // The fd has no filename extension or MIME hint. This pinned HLS detector
    // declines recognition in that context: preserve INVALIDDATA, never turn
    // an unknown input into an unsupported/fallback-eligible classification.
    assert!(matches!(
        probe_file(&probe, "network.m3u8"),
        Err(ProbeError::Media(MediaError {
            kind: MediaErrorKind::InvalidMedia,
            ..
        }))
    ));
    let fifo = fixtures().join("input.fifo");
    if !fifo.exists() {
        assert!(
            Command::new("mkfifo")
                .arg(&fifo)
                .status()
                .unwrap()
                .success()
        );
    }
    assert!(matches!(
        probe.probe_metadata(&fifo, &AtomicBool::new(false)),
        Err(ProbeError::Media(MediaError {
            kind: MediaErrorKind::InvalidRequest,
            ..
        }))
    ));
    std::fs::remove_file(fifo).unwrap();
}

#[test]
#[ignore = "requires explicit live artifacts; also used under ASan/LSan"]
fn live_cancellation_and_repeated_cleanup() {
    let probe = live_probe();
    let source = fixtures().join("av.mp4");
    assert_eq!(
        probe
            .probe_metadata(&source, &AtomicBool::new(true))
            .unwrap_err(),
        ProbeError::Cancelled
    );
    let flag = AtomicBool::new(false);
    let mut callback = Callback::new(&flag);
    // Test-only callback-path evidence: first C observation is entry; the second
    // is during libav I/O with a live format context, deterministically cancelled.
    callback.cancel_on_observation = 2;
    assert_eq!(
        probe.probe_with_callback(&source, &callback).unwrap_err(),
        ProbeError::Cancelled
    );
    assert!(callback.observations.load(Ordering::Relaxed) >= 2);
    assert!(flag.load(Ordering::Relaxed));
    let fds = || std::fs::read_dir("/proc/self/fd").unwrap().count();
    let before = fds();
    for _ in 0..100 {
        assert_eq!(probe_file(&probe, "av.mp4").unwrap().streams.len(), 2);
        assert!(probe_file(&probe, "truncated.mp4").is_err());
        flag.store(false, Ordering::Relaxed);
        callback.observations.store(0, Ordering::Relaxed);
        assert_eq!(
            probe.probe_with_callback(&source, &callback).unwrap_err(),
            ProbeError::Cancelled
        );
    }
    assert_eq!(fds(), before, "no input descriptor accumulation");
}

#[test]
#[ignore = "requires explicit live artifacts"]
fn live_metadata_is_separate_from_normalization_contracts() {
    let probe = live_probe();
    assert_eq!(probe_file(&probe, "av.mp4").unwrap().streams.len(), 2);
    let destination = fixtures().join("must-not-publish.mp4");
    let error = crate::normalize_media(&crate::MediaNormalizeRequest {
        schema_version: 1,
        source: fixtures().join("av.mp4"),
        destination: destination.clone(),
        expected_kind: crate::ExpectedMediaKind::Video,
    })
    .unwrap_err();
    assert_eq!(error.kind, MediaErrorKind::MediaContractViolation);
    assert!(!error.kind.allows_backend_fallback());
    assert!(!destination.exists());
    // A metadata success on this mutation is permissible; it cannot soften S3's
    // independent normalization error. Record the actual libav outcome.
    println!(
        "missing-mdat metadata: {:?}",
        probe_file(&probe, "missing-mdat.m4a")
    );
    let error = crate::normalize_media(&crate::MediaNormalizeRequest {
        schema_version: 1,
        source: fixtures().join("missing-mdat.m4a"),
        destination: destination.clone(),
        expected_kind: crate::ExpectedMediaKind::Audio,
    })
    .unwrap_err();
    assert_eq!(error.kind, MediaErrorKind::InvalidMedia);
    assert!(!error.kind.allows_backend_fallback());
    assert!(!destination.exists());
}

#[test]
#[ignore = "controlled fake loader boundaries run in child processes; needs C compiler"]
fn live_loader_negotiation_in_subprocesses() {
    let _required_real_artifact = live_probe();
    let root = fixtures().join("loader-tests");
    std::fs::create_dir_all(&root).unwrap();
    let driver = env_path("BILIKARA_LIBAV_EXAMPLE");
    for (name, source) in [
        ("wrong-abi", "unsigned bm_abi_version(void) { return 999; }"),
        (
            "wrong-build",
            "unsigned bm_abi_version(void) { return 1; } unsigned bm_get_info(unsigned n, void *p) { (void)n; (void)p; return 1; }",
        ),
        ("missing-symbol", "unsigned unrelated(void) { return 0; }"),
    ] {
        let c = root.join(format!("{name}.c"));
        let so = root.join(format!("{name}.so"));
        std::fs::write(&c, source).unwrap();
        assert!(
            Command::new("cc")
                .args(["-shared", "-fPIC"])
                .arg(&c)
                .arg("-o")
                .arg(&so)
                .status()
                .unwrap()
                .success()
        );
        let result = Command::new(&driver)
            .arg(&so)
            .arg(fixtures().join("av.mp4"))
            .output()
            .unwrap();
        assert_eq!(result.status.code(), Some(1));
        let error: serde_json::Value = serde_json::from_slice(&result.stderr).unwrap();
        assert_eq!(error["kind"], "unavailable");
    }
    let result = Command::new(&driver)
        .arg(root.join("absent.so"))
        .arg(fixtures().join("av.mp4"))
        .output()
        .unwrap();
    assert_eq!(result.status.code(), Some(1));
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&result.stderr).unwrap()["kind"],
        "unavailable"
    );

    // Exercise actual loaded versions/configuration, not just shim constants.
    for (name, source) in [
        (
            "runtime-version",
            "unsigned avutil_version(void) { return 1; }",
        ),
        (
            "runtime-config",
            "const char *avformat_configuration(void) { return \"different-build\"; }",
        ),
    ] {
        let c = root.join(format!("{name}.c"));
        let so = root.join(format!("{name}.so"));
        std::fs::write(&c, source).unwrap();
        assert!(
            Command::new("cc")
                .args(["-shared", "-fPIC"])
                .arg(&c)
                .arg("-o")
                .arg(&so)
                .status()
                .unwrap()
                .success()
        );
        let result = Command::new(&driver)
            .env("LD_PRELOAD", &so)
            .arg(env_path("BILIKARA_LIBAV_COMPANION"))
            .arg(fixtures().join("av.mp4"))
            .output()
            .unwrap();
        assert_eq!(result.status.code(), Some(1));
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&result.stderr).unwrap()["kind"],
            "unavailable"
        );
    }
    let dependency = root.join("libm1_test_dependency.so");
    let dependency_c = root.join("dependency.c");
    std::fs::write(&dependency_c, "unsigned m1_dependency(void) { return 1; }").unwrap();
    assert!(
        Command::new("cc")
            .args(["-shared", "-fPIC"])
            .arg(&dependency_c)
            .arg("-o")
            .arg(&dependency)
            .status()
            .unwrap()
            .success()
    );
    let missing_dependency_c = root.join("missing-dependency.c");
    let missing_dependency = root.join("missing-dependency.so");
    std::fs::write(&missing_dependency_c, "extern unsigned m1_dependency(void); unsigned bm_abi_version(void) { return m1_dependency(); }").unwrap();
    assert!(
        Command::new("cc")
            .args(["-shared", "-fPIC"])
            .arg(&missing_dependency_c)
            .arg("-L")
            .arg(&root)
            .arg("-lm1_test_dependency")
            .arg(format!("-Wl,-rpath,{}", root.display()))
            .arg("-o")
            .arg(&missing_dependency)
            .status()
            .unwrap()
            .success()
    );
    std::fs::remove_file(dependency).unwrap(); // only this test's generated stub
    let result = Command::new(&driver)
        .arg(missing_dependency)
        .arg(fixtures().join("av.mp4"))
        .output()
        .unwrap();
    assert_eq!(result.status.code(), Some(1));
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&result.stderr).unwrap()["kind"],
        "unavailable"
    );

    // A fresh process proves that the normal path never consults the optional
    // artifact, even when the explicit-preview test setting names an absent one.
    let result = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "experimental_libav::tests::missing_companion_is_unavailable_and_default_state_still_initializes", "--nocapture"])
        .env("BILIKARA_LIBAV_COMPANION", root.join("absent.so"))
        .env("BILIKARA_M1_DEFAULT_INPUT", fixtures().join("video.mp4")).output().unwrap();
    assert!(
        result.status.success(),
        "{} {}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(String::from_utf8_lossy(&result.stdout).contains("1 passed"));
}
