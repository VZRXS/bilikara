use super::*;

fn data() -> Value {
    json!({"format":{"format_name":"mov,mp4,m4a,3gp,3g2,mj2","duration":"1.000000","start_time":"-0.021333","bit_rate":"120000"},
        "streams":[{"index":7,"codec_type":"audio","codec_name":"aac","duration":"1.000000","start_time":"-0.021333","time_base":"1/48000","sample_rate":"48000","channels":2}]})
}
fn observation(value: &Value) -> Observation {
    reference_metadata(&serde_json::to_vec(value).unwrap(), true)
}
fn mismatch(field: &str, changed: Value, kind: Kind) {
    let mut right = data();
    right["streams"][0][field] = changed;
    let comparison = compare(&observation(&data()), &observation(&right), true);
    assert!(
        comparison.fields.iter().any(|f| f.kind == kind),
        "{comparison:?}"
    );
}
#[test]
fn altered_codec_inventory_type_timing_and_availability_are_detected() {
    mismatch("codec_name", json!("flac"), Kind::SemanticMismatch);
    mismatch("index", json!(8), Kind::SemanticMismatch);
    mismatch("codec_type", json!("video"), Kind::SemanticMismatch);
    mismatch("duration", json!("1.000010"), Kind::SemanticMismatch);
    mismatch("start_time", json!("0.000000"), Kind::SemanticMismatch);
    mismatch("sample_rate", Value::Null, Kind::Advisory);
    let mut extra = data();
    let mut stream = extra["streams"][0].clone();
    stream["index"] = json!(8);
    extra["streams"].as_array_mut().unwrap().push(stream);
    let comparison = compare(&observation(&data()), &observation(&extra), true);
    assert!(
        comparison
            .fields
            .iter()
            .any(|f| f.field == "stream_count" && f.kind == Kind::SemanticMismatch)
    );
    assert!(
        comparison
            .fields
            .iter()
            .any(|f| f.field == "streams[8]" && f.kind == Kind::SemanticMismatch)
    );
    // Reverse ordering does not lose either actual identity.
    let mut reversed = extra.clone();
    reversed["streams"].as_array_mut().unwrap().reverse();
    assert!(!compare(&observation(&extra), &observation(&reversed), true).needs_analysis());
    reversed["streams"][1]["index"] = json!(8);
    assert_eq!(observation(&reversed).outcome, Outcome::InvalidOutput);
}
#[test]
fn narrow_aliases_rationals_rounding_and_unknown_zero_remain_distinct() {
    let mut other = data();
    other["format"]["format_name"] = json!("m4a");
    other["streams"][0]["time_base"] = json!("2/96000");
    other["streams"][0]["duration"] = json!("1.000001");
    let result = compare(&observation(&data()), &observation(&other), true);
    assert!(!result.needs_analysis());
    other["format"]["duration"] = json!("1.000001");
    assert!(
        compare(&observation(&data()), &observation(&other), true)
            .fields
            .iter()
            .any(|f| f.field == "container.duration_us" && f.kind == Kind::SemanticMismatch)
    );
    assert_eq!(
        observation(&data()).metadata.unwrap().start_time_us,
        Some(-21333)
    );
    other["format"]["duration"] = Value::Null;
    let mut zero = other.clone();
    zero["format"]["duration"] = json!("0.000000");
    let result = compare(&observation(&zero), &observation(&other), true);
    assert!(
        result
            .fields
            .iter()
            .any(|f| f.field == "container.duration_us" && f.kind == Kind::Advisory)
    );
    let result = compare(&observation(&other), &observation(&other), true);
    assert!(
        result
            .fields
            .iter()
            .any(|f| f.field == "container.duration_us" && f.kind == Kind::NotComparable)
    );
    other["format"]["format_name"] = json!("matroska,webm");
    assert_eq!(observation(&other).outcome, Outcome::InvalidOutput);
}
#[test]
fn bitrate_differences_are_advisory_and_container_duration_is_not_stream_duration() {
    let mut other = data();
    other["format"]["bit_rate"] = json!("999999");
    let result = compare(&observation(&data()), &observation(&other), true);
    assert!(result.kinds.contains(&Kind::Advisory));
    assert!(!result.needs_analysis());
    other["format"]["duration"] = json!("2.000000");
    let result = compare(&observation(&data()), &observation(&other), true);
    assert!(
        result
            .fields
            .iter()
            .any(|f| f.field == "container.duration_us" && f.kind == Kind::SemanticMismatch)
    );
    assert!(
        result
            .fields
            .iter()
            .any(|f| f.field == "streams[7].duration_us"
                && f.kind == Kind::MatchingComparableMetadata)
    );
}
#[test]
fn errors_and_missing_same_build_cannot_become_parity_or_unsupported() {
    let mut inconsistent = observation(&data());
    inconsistent.outcome = Outcome::InvalidMedia;
    assert!(compare(&inconsistent, &observation(&data()), true).needs_analysis());
    for (bytes, success, outcome) in [
        (&b"not json"[..], false, Outcome::InvalidOutput),
        (&b"{}"[..], false, Outcome::ExecutionError),
        (
            &b"{\"error\":{\"code\":-123456,\"string\":\"unsupported SECRET\"}}"[..],
            false,
            Outcome::ExecutionError,
        ),
        (
            &b"{\"error\":{\"code\":-1094995529}}"[..],
            false,
            Outcome::InvalidMedia,
        ),
        (
            &b"{\"error\":{\"code\":-541478725}}"[..],
            true,
            Outcome::InvalidMedia,
        ),
    ] {
        let error = reference_metadata(bytes, success);
        assert_eq!(error.outcome, outcome);
        assert!(error.metadata.is_none());
        let result = compare(&error, &error, true);
        assert_eq!(result.kinds, vec![Kind::BackendOrReferenceError]);
        assert!(compare(&observation(&data()), &error, true).needs_analysis());
    }
    for error in [
        Outcome::Cancelled,
        Outcome::Timeout,
        Outcome::Unavailable,
        Outcome::Io,
    ] {
        assert!(compare(&observation(&data()), &Observation::error(error), true).needs_analysis());
    }
    assert!(compare(&observation(&data()), &observation(&data()), false).needs_analysis());
}
fn pure(outcome: Outcome) -> PureObservation {
    PureObservation {
        outcome,
        expected_kind: ExpectedMediaKind::Audio,
        requested_stream_contract_satisfied: (outcome == Outcome::Success).then_some(true),
        codec: (outcome == Outcome::Success).then(|| "aac".into()),
        sample_end_us: (outcome == Outcome::Success).then_some(1021333),
    }
}
#[test]
fn depth_contract_rejections_and_potential_bypass_are_separate() {
    let single = observation(&data());
    let result = compare_pure(&single, &pure(Outcome::InvalidMedia));
    assert_eq!(result.kinds, vec![Kind::DepthOrContractDifference]);
    let result = compare_pure(&single, &pure(Outcome::Success));
    assert!(!result.needs_analysis());
    assert!(
        result
            .fields
            .iter()
            .any(|f| f.field == "stream.duration_us_vs_sample_end_us"
                && f.kind == Kind::DepthOrContractDifference
                && f.left != f.right)
    );
    assert!(compare_pure(&single, &pure(Outcome::Io)).needs_analysis());
    assert!(compare_pure(&single, &pure(Outcome::MediaContractViolation)).needs_analysis());
    let mut multi = data();
    let mut track = multi["streams"][0].clone();
    track["index"] = json!(12);
    multi["streams"].as_array_mut().unwrap().push(track);
    let result = compare_pure(&observation(&multi), &pure(Outcome::MediaContractViolation));
    assert_eq!(result.kinds, vec![Kind::DepthOrContractDifference]);
    let result = compare_pure(&observation(&multi), &pure(Outcome::Success));
    assert_eq!(result.kinds, vec![Kind::PotentialSafetyMismatch]);
    let mut raw = data();
    raw["format"]["format_name"] = json!("flac");
    assert_eq!(
        compare_pure(&observation(&raw), &pure(Outcome::InvalidMedia)).kinds,
        vec![Kind::DepthOrContractDifference]
    );
}
fn info() -> BackendInfo {
    BackendInfo { backend:"bilikara_media_libav".into(), abi_version:1, build_version:"9.0.1".into(),runtime_version:"9.0.1".into(),
        build_library_versions:[4129125,4129125,3998053],runtime_library_versions:[4129125,4129125,3998053],
        build_configuration:"--prefix=/private/SECRET_PATH --disable-network --enable-shared --extra-cflags=COOKIE_SECRET".into(),
        runtime_configurations:std::array::from_fn(|_|"--prefix=/private/SECRET_PATH --disable-network --enable-shared --extra-cflags=COOKIE_SECRET".into()) }
}
fn build(info: &BackendInfo) -> Value {
    json!({"program_version":{"version":"9.0.1","configuration":info.build_configuration},
        "library_versions":[{"name":"libavformat","version":4129125},{"name":"libavcodec","version":4129125},{"name":"libavutil","version":3998053}]})
}
#[test]
fn identity_checks_raw_configuration_and_runtime_versions_before_redaction() {
    let info = info();
    let parse = |v: &Value| ReferenceBuild::parse(&serde_json::to_vec(v).unwrap()).unwrap();
    assert!(parse(&build(&info)).matches(&info));
    let mut changed = build(&info);
    changed["program_version"]["configuration"] =
        json!("--prefix=/different --disable-network --enable-shared");
    assert!(!parse(&changed).matches(&info));
    changed = build(&info);
    changed["library_versions"][0]["version"] = json!(4129124);
    assert!(!parse(&changed).matches(&info));
    let mut changed_info = info.clone();
    changed_info.runtime_configurations[2] = "different".into();
    assert!(!parse(&build(&info)).matches(&changed_info));
}
#[test]
fn allowlist_excludes_fake_sensitive_metadata_paths_config_and_error_text() {
    let mut input = data();
    input["format"]["filename"] = json!("/private/SECRET_PATH");
    input["format"]["tags"] =
        json!({"title":"SECRET_TITLE","cookie":"COOKIE_SECRET","room":"ROOM_SECRET"});
    input["streams"][0]["tags"] =
        json!({"url":"https://example.invalid/SIGNED_SECRET?auth=AUTH_SECRET"});
    input["stderr"] = json!("SECRET_STDERR");
    let observation = observation(&input);
    let info = info();
    let reference = ReferenceBuild::parse(&serde_json::to_vec(&build(&info)).unwrap()).unwrap();
    let error = Observation::libav(Err(ProbeError::BackendFailure(
        "SECRET_ERROR /private/SECRET_PATH".into(),
    )));
    let pure = PureObservation::new(
        ExpectedMediaKind::Audio,
        Ok(MediaProbe {
            path: "/private/SECRET_PATH".into(),
            kind: ExpectedMediaKind::Audio,
            codec: "aac".into(),
            duration_seconds: 1.0,
            sample_count: 48,
            sample_bytes: 123,
            file_bytes: 321,
            fragmented: false,
            fast_start: false,
        }),
    );
    let text = serde_json::to_string(&json!({"libav":observation,"identity":libav_identity(&info).unwrap(),"reference":reference.identity().unwrap(),"error":error,"pure":pure})).unwrap();
    for secret in [
        "SECRET_PATH",
        "SECRET_TITLE",
        "COOKIE_SECRET",
        "ROOM_SECRET",
        "SIGNED_SECRET",
        "AUTH_SECRET",
        "SECRET_STDERR",
        "SECRET_ERROR",
        "/private/",
        "https://",
    ] {
        assert!(!text.contains(secret), "leaked {secret}");
    }
    assert!(text.contains("--disable-network"));
}
#[test]
fn invalid_numeric_metadata_is_not_silently_unknown_or_zero() {
    for value in [
        "NaN",
        "1e20",
        "9999999999999999999999999999999999999999999999999",
        "-9223372036854.775808",
        "1.1234567",
    ] {
        assert_eq!(micros(&json!(value), false), Err(Outcome::InvalidOutput));
    }
    assert_eq!(micros(&json!("-0.000001"), false), Ok(Some(-1)));
    assert_eq!(micros(&json!("0"), true), Ok(Some(0)));
    assert_eq!(micros(&json!("N/A"), true), Ok(None));
    assert_eq!(positive(&json!("-1")), Err(Outcome::InvalidOutput));
    let mut malformed = data();
    malformed["streams"][0]["time_base"] = json!("1/0");
    assert_eq!(observation(&malformed).outcome, Outcome::InvalidOutput);
}

#[test]
#[ignore = "requires real M1 artifacts and an absolute report path outside the repository"]
fn live_existing_missing_mdat_normalization_rejection() {
    use crate::experimental_libav::LibavMetadataProbe;
    use crate::{MediaNormalizeRequest, MediaPathRequest, normalize_media, probe_media};
    use std::path::PathBuf;
    use std::sync::atomic::AtomicBool;
    use std::time::Instant;
    let required = |name| {
        PathBuf::from(
            std::env::var_os(name).expect("live artifact/report setting is required; never skip"),
        )
    };
    let companion = required("BILIKARA_LIBAV_COMPANION");
    let source = required("BILIKARA_LIBAV_FIXTURES").join("missing-mdat.m4a");
    let report = required("BILIKARA_M2_CONTRACT_REPORT");
    assert!(report.is_absolute());
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .canonicalize()
        .unwrap();
    assert!(
        !report
            .parent()
            .unwrap()
            .canonicalize()
            .unwrap()
            .starts_with(repo)
    );
    // SAFETY: the explicit live invocation supplies the accepted trusted M1 artifact.
    let probe = unsafe { LibavMetadataProbe::load(&companion) }.unwrap();
    let libav = Observation::libav(probe.probe_metadata(&source, &AtomicBool::new(false)));
    assert_eq!(libav.outcome, Outcome::Success);
    let pure = PureObservation::new(
        ExpectedMediaKind::Audio,
        probe_media(&MediaPathRequest {
            schema_version: 1,
            source: source.clone(),
            expected_kind: ExpectedMediaKind::Audio,
        })
        .map_err(|e| e.kind.into()),
    );
    assert_eq!(pure.outcome, Outcome::Success);
    let root = std::env::temp_dir().join(format!("bilikara-m2-contract-{}", std::process::id()));
    std::fs::create_dir(&root).unwrap();
    let destination = root.join("must-not-publish.mp4");
    let start = Instant::now();
    // Exercise the existing M1/S3 rejection only. No new remux/scan implementation.
    let error = normalize_media(&MediaNormalizeRequest {
        schema_version: 1,
        source,
        destination: destination.clone(),
        expected_kind: ExpectedMediaKind::Audio,
    })
    .unwrap_err();
    let elapsed_us = start.elapsed().as_micros();
    assert_eq!(error.kind, MediaErrorKind::InvalidMedia);
    assert!(!error.kind.allows_backend_fallback());
    assert!(!destination.exists());
    assert_eq!(
        std::fs::read_dir(&root).unwrap().count(),
        0,
        "temporary outputs cleaned"
    );
    let comparison = compare_pure(
        &libav,
        &PureObservation::new(ExpectedMediaKind::Audio, Err(error.kind.into())),
    );
    assert_eq!(comparison.kinds, vec![Kind::DepthOrContractDifference]);
    let evidence = json!({"schema_version":1,"fixture_label":"missing-mdat",
        "libav":libav,"pure_rust_probe":pure,
        "existing_normalization":{"operation":"bilikara_runtime::normalize_media","outcome":Outcome::from(error.kind),
            "inspection":"existing normalization container prerequisites beyond read-only probe",
            "requested_contract_satisfied":false,"destination_published":false,"backend_fallback_allowed":false},
        "comparison":comparison,"complete_media_validation":"not_established",
        "elapsed_us":elapsed_us,"timing_boundary":"existing normalize_media call through rejection and temporary-output cleanup"});
    std::fs::write(report, serde_json::to_vec_pretty(&evidence).unwrap()).unwrap();
    std::fs::remove_dir(root).unwrap();
}
