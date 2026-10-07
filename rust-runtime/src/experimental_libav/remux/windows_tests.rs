//! Portable timing checks and explicitly required real-companion package checks.
use super::*;

fn summary(base: super::super::TimeBase) -> super::super::PacketSummary {
    use super::super::{PacketSummary, StreamType, TimestampBounds};
    PacketSummary {
        index: 0,
        media_type: StreamType::Video,
        codec_name: Some("h264".into()),
        time_base: Some(base),
        packet_count: 24,
        payload_bytes: 1083,
        corrupt_packets: 0,
        pts_ticks: Some(TimestampBounds {
            min: 21000,
            max: 1000000,
        }),
        dts_ticks: Some(TimestampBounds {
            min: -145875,
            max: 800000,
        }),
    }
}

#[test]
fn timestamp_bounds_allow_at_most_200_ms_at_each_endpoint() {
    use super::super::{TimeBase, TimestampBounds};
    let a = summary(TimeBase {
        numerator: 1,
        denominator: 1_000_000,
    });
    for shift in [0, -21000, 21000, -200000, 200000] {
        let mut b = a.clone();
        for bounds in [&mut b.pts_ticks, &mut b.dts_ticks].into_iter().flatten() {
            bounds.min += shift;
            bounds.max += shift;
        }
        assert!(same_bounds(&a, &b), "shift {shift}");
    }
    for endpoint in 0..4 {
        for shift in [-200001, 200001] {
            let mut b = a.clone();
            let pts = b.pts_ticks.as_mut().unwrap();
            if endpoint == 0 {
                pts.min += shift;
            }
            if endpoint == 1 {
                pts.max += shift;
            }
            let dts = b.dts_ticks.as_mut().unwrap();
            if endpoint == 2 {
                dts.min += shift;
            }
            if endpoint == 3 {
                dts.max += shift;
            }
            assert!(!same_bounds(&a, &b), "endpoint {endpoint}, shift {shift}");
        }
    }
    let mut b = a.clone();
    b.time_base = Some(TimeBase {
        numerator: 2,
        denominator: 1000,
    });
    b.pts_ticks = Some(TimestampBounds { min: 110, max: 600 });
    b.dts_ticks = Some(TimestampBounds {
        min: -172,
        max: 500,
    });
    assert!(same_bounds(&a, &b)); // Distinct time bases; +199/+200/-198.125/+200 ms.
    b.pts_ticks.as_mut().unwrap().max += 1;
    assert!(!same_bounds(&a, &b)); // +202 ms, regardless of tick units.
}

#[test]
fn timestamp_bounds_reject_unknown_invalid_and_extreme_mismatches() {
    use super::super::{TimeBase, TimestampBounds};
    let a = summary(TimeBase {
        numerator: 1,
        denominator: 1_000_000,
    });
    for mutate in [
        |b: &mut super::super::PacketSummary| b.pts_ticks = None,
        |b: &mut super::super::PacketSummary| b.dts_ticks = None,
        |b: &mut super::super::PacketSummary| b.time_base = None,
        |b: &mut super::super::PacketSummary| b.time_base.as_mut().unwrap().numerator = 0,
        |b: &mut super::super::PacketSummary| b.time_base.as_mut().unwrap().denominator = -1,
        |b: &mut super::super::PacketSummary| {
            b.pts_ticks = Some(TimestampBounds { min: 1, max: 0 })
        },
    ] {
        let mut b = a.clone();
        mutate(&mut b);
        assert!(!same_bounds(&a, &b));
        assert!(!same_bounds(&b, &a));
    }
    let mut a = a;
    a.time_base = Some(TimeBase {
        numerator: i32::MAX,
        denominator: i32::MAX,
    });
    a.pts_ticks = Some(TimestampBounds {
        min: i64::MIN,
        max: i64::MIN,
    });
    a.dts_ticks = a.pts_ticks;
    assert!(same_bounds(&a, &a));
    let mut b = a.clone();
    b.pts_ticks = Some(TimestampBounds {
        min: i64::MAX,
        max: i64::MAX,
    });
    assert!(!same_bounds(&a, &b));
}

#[test]
#[ignore = "requires an actual same-build libav companion"]
fn reordered_video_preserves_nonzero_start() {
    use super::super::{ScanSelection, TimeBase, TimestampBounds};
    let companion = PathBuf::from(std::env::var_os("BILIKARA_LIBAV_COMPANION").expect("companion"));
    let probe = unsafe { LibavMetadataProbe::load(&companion) }.unwrap();
    let scratch = Scratch::new(&std::env::temp_dir()).unwrap();
    let source = scratch.directory.join("reordered 视频.mp4");
    let destination = scratch.directory.join("normalized 视频.mp4");
    let bytes = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../tests/fixtures/bbdown/video-reordered-start.mp4"
    ));
    fs::write(&source, bytes).unwrap();
    let flag = AtomicBool::new(false);
    let input = probe
        .scan_packets(
            &source,
            ScanSelection {
                stream_index: 0,
                expected_kind: ExpectedMediaKind::Video,
            },
            &flag,
        )
        .unwrap();
    let expected = input.selected.as_ref().unwrap();
    assert!(input.clean_eof());
    assert_eq!(expected.packet_count, 24);
    assert_eq!(expected.payload_bytes, 1083);
    assert_eq!(expected.corrupt_packets, 0);
    assert_eq!(
        expected.time_base,
        Some(TimeBase {
            numerator: 1,
            denominator: 16000
        })
    );
    assert_eq!(
        expected.pts_ticks,
        Some(TimestampBounds {
            min: 336,
            max: 15685
        })
    );
    assert_eq!(
        expected.dts_ticks,
        Some(TimestampBounds {
            min: -2334,
            max: 13015
        })
    );
    let result = probe
        .copy_remux_mp4(
            &CopyRemuxRequest {
                source: &source,
                destination: &destination,
                expected_kind: ExpectedMediaKind::Video,
            },
            &flag,
        )
        .unwrap();
    assert!(result.finalized_and_published && result.leading_moov);
    assert!(result.decoder_configuration_preserved);
    assert!(result.output_scan.clean_eof());
    assert_eq!(result.output_scan.selected.as_ref().unwrap(), expected);
    assert_eq!(fs::read(&source).unwrap(), bytes);
    fs::remove_dir_all(&scratch.directory).unwrap();
}

#[test]
#[ignore = "requires extracted same-build package artifacts"]
fn packaged_cancellation_and_collision() {
    let path = |name| PathBuf::from(std::env::var_os(name).expect("required package artifact"));
    let fixtures = path("BILIKARA_LIBAV_FIXTURES");
    let probe = unsafe { LibavMetadataProbe::load(&path("BILIKARA_LIBAV_COMPANION")) }.unwrap();
    let faults = unsafe { LibavMetadataProbe::load(&path("BILIKARA_M5_FAULT_COMPANION")) }.unwrap();
    type SetFault =
        unsafe extern "C" fn(u32, extern "C" fn(*mut std::ffi::c_void), *mut std::ffi::c_void);
    let set_fault: SetFault =
        unsafe { std::mem::transmute(faults._library.symbol(c"bm_test_remux_fault").unwrap()) };
    extern "C" fn cancel(context: *mut std::ffi::c_void) {
        unsafe { &*context.cast::<AtomicBool>() }.store(true, Ordering::Relaxed);
    }
    for (profile, name) in [
        (CopyProfile::Mp4, "aac.m4a"),
        (CopyProfile::Flac, "flac.mp4"),
    ] {
        let source = fixtures.join(name);
        let original = fs::read(&source).unwrap();
        let destination = fixtures.join(format!("collision.{}", profile.extension()));
        let q = CopyRemuxRequest {
            source: &source,
            destination: &destination,
            expected_kind: ExpectedMediaKind::Audio,
        };
        let flag = AtomicBool::new(false);
        // Existing C checkpoint after three real packet writes, not pre-cancel.
        unsafe { set_fault(1, cancel, (&flag as *const AtomicBool).cast_mut().cast()) };
        assert_eq!(
            faults.copy_profile(&q, profile, &flag).unwrap_err(),
            ProbeError::Cancelled
        );
        assert!(!destination.exists());
        assert_eq!(fs::read(&source).unwrap(), original);
        flag.store(false, Ordering::Relaxed);
        // Existing Rust before_publish seam and sentinel: the actual platform
        // no-replace hard_link must preserve a newly competing destination.
        let error = probe
            .remux_impl(
                &q,
                profile,
                &super::super::Callback::new(&flag),
                &mut || fs::write(&destination, b"competing destination").unwrap(),
                &mut || {},
            )
            .unwrap_err();
        assert!(
            matches!(error, ProbeError::Media(e) if e.kind == MediaErrorKind::DestinationExists)
        );
        assert_eq!(fs::read(&destination).unwrap(), b"competing destination");
        assert_eq!(fs::read(&source).unwrap(), original);
        assert!(!fs::read_dir(&fixtures).unwrap().any(|e| {
            e.unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".bilikara-remux-")
        }));
        fs::remove_file(destination).unwrap();
    }
}
