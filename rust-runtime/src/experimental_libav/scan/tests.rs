use super::*;
use crate::experimental_libav::{Callback, MediaErrorKind, wire};
use std::{path::PathBuf, sync::atomic::Ordering};
fn selection() -> ScanSelection {
    ScanSelection {
        stream_index: 0,
        expected_kind: ExpectedMediaKind::Audio,
    }
}
fn raw() -> wire::ScanResult {
    let mut r: wire::ScanResult = unsafe { std::mem::zeroed() };
    r.inspection_level = 2;
    r.terminal = 1;
    r.selected_count = 1;
    r.demuxed_packets = 5;
    r.selected.media_type = 2;
    r.selected.packet_count = 5;
    r.selected.payload_bytes = 300;
    r
}
#[test]
fn scan_conversion_rejects_false_success_and_retains_partial_evidence() {
    let mut r = raw();
    assert!(convert(&r, selection()).unwrap().clean_eof());
    r.terminal = 0;
    assert!(convert(&r, selection()).is_err());
    r.status = 9;
    let scan = convert(&r, selection()).unwrap();
    assert_eq!(scan.error, Some(ProbeError::Cancelled));
    assert_eq!(scan.selected.unwrap().packet_count, 5);
    r.terminal = 1;
    assert!(convert(&r, selection()).is_err());
    r.status = 7;
    r.selected.corrupt_packets = 1;
    assert!(!convert(&r, selection()).unwrap().clean_eof());
    r.status = 0;
    assert!(convert(&r, selection()).is_err());
    r = raw();
    r.selected.packet_count = 0;
    r.selected.payload_bytes = 0;
    assert!(convert(&r, selection()).is_err());
    r.status = 7;
    assert!(!convert(&r, selection()).unwrap().clean_eof());
    r = raw();
    r.selected.index = 1;
    assert!(convert(&r, selection()).is_err());
    r = raw();
    r.selected.media_type = 1;
    assert!(convert(&r, selection()).is_err());
    r = raw();
    r.selected.packet_count = 6;
    assert!(convert(&r, selection()).is_err());
    r = raw();
    r.incidental_corrupt_packets = 1;
    assert!(convert(&r, selection()).is_err());
}
#[test]
fn scan_timestamps_preserve_negatives_unknowns_and_validate_bounds() {
    let mut r = raw();
    r.selected.pts_min = i64::MIN;
    assert_eq!(
        convert(&r, selection())
            .unwrap()
            .selected
            .unwrap()
            .pts_ticks,
        None
    );
    r.selected.present = 5;
    r.selected.time_base_num = 1;
    r.selected.time_base_den = 48000;
    r.selected.pts_min = -1024;
    r.selected.pts_max = 0;
    assert_eq!(
        convert(&r, selection())
            .unwrap()
            .selected
            .unwrap()
            .pts_ticks,
        Some(TimestampBounds { min: -1024, max: 0 })
    );
    r.selected.pts_min = i64::MIN;
    assert!(convert(&r, selection()).is_err());
    r.selected.pts_min = 10;
    assert!(convert(&r, selection()).is_err());
    r.selected.present = 1;
    assert!(convert(&r, selection()).is_err());
}
fn env_path(name: &str) -> PathBuf {
    let p = PathBuf::from(std::env::var_os(name).unwrap_or_else(|| panic!("required {name}")));
    assert!(p.is_absolute() && p.exists());
    p
}
#[test]
#[ignore = "requires explicitly built real scan companion and fixtures; no live skips"]
fn live_scan_lifecycle_and_selection() {
    let companion = env_path("BILIKARA_LIBAV_COMPANION");
    let probe = unsafe { LibavMetadataProbe::load(&companion) }.unwrap();
    assert!(probe.packet_scan_available());
    let fixtures = env_path("BILIKARA_LIBAV_FIXTURES");
    let source = fixtures.join("aac.m4a");
    let flag = AtomicBool::new(false);
    let callback = Callback::new(&flag);
    let full = probe
        .scan_with_callback(&source, selection(), &callback)
        .unwrap();
    assert!(full.clean_eof());
    let packets = full.selected.as_ref().unwrap().packet_count;
    assert!(packets > 4);
    let observations = callback.observations.load(Ordering::Relaxed);
    assert!(observations > 2 * packets as u32);
    assert_eq!(
        probe
            .scan_packets(&source, selection(), &AtomicBool::new(true))
            .unwrap_err(),
        ProbeError::Cancelled
    );
    let fds = || std::fs::read_dir("/proc/self/fd").unwrap().count();
    let before = fds();
    for _ in 0..100 {
        flag.store(false, Ordering::Relaxed);
        let mut callback = Callback::new(&flag);
        // Calibrated successful run: two explicit observations per iteration.
        // Cancel near its end, deterministically after packet iteration began.
        callback.cancel_on_observation = observations - 2;
        let partial = probe
            .scan_with_callback(&source, selection(), &callback)
            .unwrap();
        assert_eq!(partial.terminal, ScanTerminal::Incomplete);
        assert_eq!(partial.error, Some(ProbeError::Cancelled));
        assert!(partial.selected.unwrap().packet_count > 0);
        assert!(
            !probe
                .probe_metadata(&source, &AtomicBool::new(false))
                .unwrap()
                .streams
                .is_empty()
        );
        assert_eq!(
            probe
                .scan_packets(&source, selection(), &AtomicBool::new(false))
                .unwrap(),
            full
        );
    }
    assert_eq!(before, fds());
    for s in [
        ScanSelection {
            stream_index: 1,
            ..selection()
        },
        ScanSelection {
            expected_kind: ExpectedMediaKind::Video,
            ..selection()
        },
    ] {
        let bad = probe
            .scan_packets(&source, s, &AtomicBool::new(false))
            .unwrap();
        assert!(!bad.clean_eof());
        assert!(matches!(
            bad.error,
            Some(ProbeError::Media(crate::MediaError {
                kind: MediaErrorKind::InvalidRequest,
                ..
            }))
        ));
        assert!(bad.selected.is_none());
    }
    for (index, kind) in [(0, ExpectedMediaKind::Video), (1, ExpectedMediaKind::Audio)] {
        let scan = probe
            .scan_packets(
                &fixtures.join("av.mp4"),
                ScanSelection {
                    stream_index: index,
                    expected_kind: kind,
                },
                &AtomicBool::new(false),
            )
            .unwrap();
        assert!(scan.clean_eof());
        assert!(scan.demuxed_packets > scan.selected.unwrap().packet_count);
    }
    for source in [
        Path::new("https://example.invalid/a.mp4"),
        Path::new("/dev/null"),
        Path::new("relative"),
    ] {
        assert!(
            probe
                .scan_packets(source, selection(), &AtomicBool::new(false))
                .is_err()
        );
    }
    for name in ["local.ffconcat", "network.m3u8", "outside.wav"] {
        let scan = probe
            .scan_packets(&fixtures.join(name), selection(), &AtomicBool::new(false))
            .unwrap();
        assert!(!scan.clean_eof());
        assert!(scan.error.is_some());
    }
    // The actual mapped file must be the explicit newly built scan companion.
    let maps = std::fs::read_to_string("/proc/self/maps").unwrap();
    assert!(
        maps.lines()
            .any(|line| line.ends_with(companion.to_str().unwrap()))
    );
}
#[test]
#[ignore = "requires accepted M1 companion without scan exports"]
fn live_old_companion_keeps_metadata_without_scan() {
    let probe =
        unsafe { LibavMetadataProbe::load(&env_path("BILIKARA_M3_OLD_COMPANION")) }.unwrap();
    assert!(!probe.packet_scan_available());
    let source = env_path("BILIKARA_LIBAV_FIXTURES").join("aac.m4a");
    assert!(
        probe
            .probe_metadata(&source, &AtomicBool::new(false))
            .is_ok()
    );
    assert!(matches!(
        probe.scan_packets(&source, selection(), &AtomicBool::new(false)),
        Err(ProbeError::Unavailable(_))
    ));
}
