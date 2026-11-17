use super::*;
use crate::experimental_libav::{NegotiationFailure, open_input, wire};
use std::{
    ffi::c_void,
    mem::{size_of, transmute},
    path::PathBuf,
    sync::atomic::Ordering,
};
#[repr(C)]
#[derive(Default, Debug)]
struct Inspection {
    status: u32,
    streams: u32,
    first_video_key: u32,
    audio_rate: u32,
    audio_channels: u32,
    duration_us: i64,
    packets: [u64; 2],
    first_pts_us: [i64; 2],
    last_end_us: [i64; 2],
    audio_profile: i32,
}
fn inspect(probe: &LibavMetadataProbe, path: &Path) -> Inspection {
    type Check = unsafe extern "C" fn(*const wire::Request, u32, *mut Inspection) -> u32;
    // SAFETY: explicitly selected test companion; C verifies the private size.
    let check: Check =
        unsafe { transmute(probe._library.symbol(c"bm_test_cast_check_v1").unwrap()) };
    let file = open_input(path).unwrap();
    let fd = probe._library.descriptor(&file).unwrap();
    extern "C" fn never(_: *mut c_void) -> i32 {
        0
    }
    let request = wire::Request {
        fd: fd.fd,
        cancelled: never,
        opaque: std::ptr::null_mut(),
    };
    let mut result = Inspection::default();
    // SAFETY: descriptor/library/result outlive this synchronous invocation.
    assert_eq!(
        unsafe { check(&request, size_of::<Inspection>() as u32, &mut result) },
        0
    );
    assert_eq!(result.status, 0, "{result:?}");
    assert_eq!(result.streams, 2);
    assert_eq!(result.first_video_key, 1);
    assert!(result.packets.iter().all(|n| *n > 0));
    result
}
fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("tests/fixtures/bbdown")
}
fn load() -> LibavMetadataProbe {
    let path = std::env::var_os("BILIKARA_TEST_CAST_COMPANION")
        .expect("actual freshly built test companion");
    // SAFETY: only the explicit build/test environment selects this artifact.
    unsafe { LibavMetadataProbe::load(Path::new(&path)) }.unwrap()
}
fn temporary() -> PathBuf {
    let mut nonce = [0; 16];
    getrandom::fill(&mut nonce).unwrap();
    let name = nonce.iter().map(|b| format!("{b:02x}")).collect::<String>();
    let path = std::env::temp_dir().join(format!("bilikara-cast-{name}"));
    std::fs::create_dir(&path).unwrap();
    path
}
fn repeated_video(probe: &LibavMetadataProbe, source: &Path, path: &Path) {
    video_fixture(probe, source, path, c"bm_test_cast_fixture_v1");
}
fn video_fixture(probe: &LibavMetadataProbe, source: &Path, path: &Path, symbol: &std::ffi::CStr) {
    type Fixture = unsafe extern "C" fn(*const wire::Request, *const std::ffi::c_char) -> u32;
    // SAFETY: explicitly supplied test companion; private test-only signature.
    let create: Fixture = unsafe { transmute(probe._library.symbol(symbol).unwrap()) };
    let file = open_input(source).unwrap();
    let fd = probe._library.descriptor(&file).unwrap();
    extern "C" fn never(_: *mut c_void) -> i32 {
        0
    }
    let request = wire::Request {
        fd: fd.fd,
        cancelled: never,
        opaque: std::ptr::null_mut(),
    };
    let path = std::ffi::CString::new(path.to_str().unwrap()).unwrap();
    // SAFETY: descriptor and output string live through this synchronous call.
    assert_eq!(unsafe { create(&request, path.as_ptr()) }, 0);
}
// Parse actual PSI, not just FFmpeg's reported codec names.
fn tables(bytes: &[u8]) {
    let first_pes = bytes.chunks_exact(188).find_map(|p| {
        if p[1] & 0x40 == 0 || p[3] & 0x10 == 0 {
            return None;
        }
        let at = 4 + if p[3] & 0x20 != 0 {
            1 + usize::from(p[4])
        } else {
            0
        };
        if at + 4 <= 188 && p[at..at + 3] == [0, 0, 1] {
            Some(p[at + 3])
        } else {
            None
        }
    });
    assert!(
        first_pes.is_some_and(|id| (0xe0..=0xef).contains(&id)),
        "first media PES must be video"
    );
    let mut pmt = None;
    let mut checked = false;
    for packet in bytes.chunks_exact(188) {
        assert_eq!(packet[0], 0x47);
        let pid = (u16::from(packet[1] & 31) << 8) | u16::from(packet[2]);
        if packet[1] & 0x40 == 0 || packet[3] & 0x10 == 0 {
            continue;
        }
        let mut at = 4;
        if packet[3] & 0x20 != 0 {
            at += 1 + usize::from(packet[4]);
        }
        if at >= 188 {
            continue;
        }
        at += 1 + usize::from(packet[at]);
        if at + 12 > 188 {
            continue;
        }
        let s = &packet[at..];
        if pid == 0 && s[0] == 0 {
            pmt = Some((u16::from(s[10] & 31) << 8) | u16::from(s[11]));
        }
        if Some(pid) == pmt && s[0] == 2 {
            let pcr = (u16::from(s[8] & 31) << 8) | u16::from(s[9]);
            let end = 3 + ((usize::from(s[1] & 15) << 8) | usize::from(s[2])) - 4;
            let mut offset = 12 + ((usize::from(s[10] & 15) << 8) | usize::from(s[11]));
            let mut kinds = Vec::new();
            while offset + 5 <= end {
                let stream = (u16::from(s[offset + 1] & 31) << 8) | u16::from(s[offset + 2]);
                kinds.push(s[offset]);
                if s[offset] == 0x1b {
                    assert_eq!(stream, pcr);
                }
                offset += 5 + ((usize::from(s[offset + 3] & 15) << 8) | usize::from(s[offset + 4]));
            }
            assert_eq!(kinds, [0x1b, 0x0f]);
            checked = true;
        }
    }
    assert!(checked, "PAT/PMT must precede a joinable group");
}
fn clocks(bytes: &[u8]) {
    const WRAP: u64 = (1u64 << 33) * 300;
    let mut pcrs = Vec::new();
    let mut pats = Vec::new();
    for (index, p) in bytes.chunks_exact(188).enumerate() {
        let pid = (u16::from(p[1] & 31) << 8) | u16::from(p[2]);
        if p[3] & 0x20 != 0 && p[4] >= 7 && p[5] & 0x10 != 0 {
            let base = (u64::from(p[6]) << 25)
                | (u64::from(p[7]) << 17)
                | (u64::from(p[8]) << 9)
                | (u64::from(p[9]) << 1)
                | (u64::from(p[10]) >> 7);
            let ext = (u64::from(p[10] & 1) << 8) | u64::from(p[11]);
            pcrs.push((index as u64, base * 300 + ext));
        }
        if pid == 0 && p[1] & 0x40 != 0 {
            pats.push(index as u64);
        }
    }
    assert!(pcrs.len() > 10);
    assert!(pats.len() > 2);
    let first = pcrs.first().unwrap();
    let last = pcrs.last().unwrap();
    let packet_ticks = ((last.1 + WRAP - first.1) % WRAP).div_ceil(last.0 - first.0);
    for pair in pcrs.windows(2) {
        let delta = (pair[1].1 + WRAP - pair[0].1) % WRAP;
        let tick = packet_ticks;
        // libav checks PCR around PSI insertion. Bound the configured 20 ms
        // plus at most four TS packets (PAT/PMT/SDT and packet quantization).
        assert!(
            delta > 0 && delta <= 20 * 27_000 + 4 * tick,
            "PCR interval {} us",
            delta / 27
        );
    }
    for pair in pats.windows(2) {
        let delta = (pair[1] - pair[0]) * packet_ticks;
        assert!(
            delta <= 50 * 27_000 + 4 * packet_ticks,
            "PAT interval {} us",
            delta / 27
        );
    }
}
#[test]
#[ignore = "requires actual cast test companion; run through test:libav-prerequisites"]
fn real_cast_mux_contract() {
    let probe = load();
    assert!(probe.cast_mux_available());
    let root = temporary();
    let cache = root.join("cache");
    std::fs::create_dir(&cache).unwrap();
    let fixture = fixtures();
    let stop = AtomicBool::new(false);
    let session = CastSession::new(&cache, 32 * 1024 * 1024).unwrap();
    let repeated = root.join("three-gops.mp4");
    repeated_video(
        &probe,
        &fixture.join("video-reordered-start.mp4"),
        &repeated,
    );
    let preflight = probe.cast_preflight(&repeated, &stop).unwrap();
    assert_eq!(preflight.packets, 72);
    assert!(preflight.has_b_frames);
    assert!((preflight.duration_us - 3_003_000).abs() < 1000);
    assert!((preflight.gop_us.unwrap() - 1_001_000).abs() < 1000);
    for video in [fixture.join("video-reordered-start.mp4"), repeated.clone()] {
        for (audio, transcoded) in [
            ("audio.m4a", false),
            ("audio-flac.mp4", true),
            ("audio-eac3.m4a", true),
        ] {
            for format in [CastFormat::Ts, CastFormat::Mp4] {
                let inputs = CastInputs {
                    video: &video,
                    audio: &fixture.join(audio),
                    start_us: 0,
                };
                let output = session
                    .mux(&probe, &inputs, format, &stop)
                    .unwrap_or_else(|e| panic!("{video:?}/{audio}/{format:?}: {e}"));
                let checked = inspect(&probe, output.path());
                let source = probe.cast_preflight(&video, &stop).unwrap();
                let expected = source.duration_us.max(if audio == "audio-eac3.m4a" {
                    2_048_000 - source.source_start_us
                } else {
                    1_000_000 - source.source_start_us
                });
                assert!(
                    (checked.duration_us - expected).abs() <= 100_000,
                    "input/output duration: {checked:?} expected {expected}"
                );
                assert_eq!(output.summary.audio_transcoded, transcoded);
                if transcoded {
                    assert_eq!(checked.audio_rate, 48000);
                    assert_eq!(checked.audio_channels, 2);
                }
                assert!(
                    (checked.duration_us - output.summary.duration_us).abs() <= 100_000,
                    "{video:?}/{audio}/{format:?}: {checked:?} {:?}",
                    output.summary
                );
                let bytes = std::fs::read(output.path()).unwrap();
                if format == CastFormat::Ts {
                    tables(&bytes);
                    assert_eq!(null_packets(&bytes), 0);
                } else {
                    assert_unsigned_ctts(&bytes);
                    let mut offset = 0;
                    let mut atoms = Vec::new();
                    while offset + 8 <= bytes.len() {
                        let size = u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap())
                            as usize;
                        assert!(size >= 8);
                        atoms.push(&bytes[offset + 4..offset + 8]);
                        offset += size;
                    }
                    assert!(
                        atoms.iter().position(|a| *a == b"moov")
                            < atoms.iter().position(|a| *a == b"mdat")
                    );
                }
                let path = output.path().to_owned();
                drop(output);
                assert!(!path.exists());
            }
        }
    }
    let video = fixture.join("video-reordered-start.mp4");
    let audio = fixture.join("audio.m4a");
    let inputs = CastInputs {
        video: &video,
        audio: &audio,
        start_us: 0,
    };
    let mut chunks = Vec::new();
    let mut keys = 0;
    probe
        .cast_ts(
            &inputs,
            CastPacing::FullSpeed,
            8 * 1024 * 1024,
            &stop,
            &mut |bytes, _, key| {
                keys += usize::from(key);
                chunks.extend_from_slice(bytes);
                true
            },
        )
        .unwrap();
    assert!(keys >= 1);
    let repeated_inputs = CastInputs {
        video: &repeated,
        audio: &fixture.join("audio-eac3.m4a"),
        start_us: 0,
    };
    let mut stream = Vec::new();
    let mut joins = Vec::new();
    probe
        .cast_ts(
            &repeated_inputs,
            CastPacing::FullSpeed,
            8 * 1024 * 1024,
            &stop,
            &mut |bytes, _, key| {
                if key {
                    joins.push(stream.len());
                }
                stream.extend_from_slice(bytes);
                true
            },
        )
        .unwrap();
    assert_eq!(joins.len(), 3);
    let joined = root.join("join.ts");
    std::fs::write(&joined, &stream[joins[1]..]).unwrap();
    tables(&stream[joins[1]..]);
    inspect(&probe, &joined);
    let seek_inputs = CastInputs {
        start_us: 1_500_000,
        ..repeated_inputs
    };
    let seek_file = session
        .mux(&probe, &seek_inputs, CastFormat::Ts, &stop)
        .unwrap();
    assert!((seek_file.summary.source_start_us - 1_001_000).abs() < 1000);
    inspect(&probe, seek_file.path());
    drop(seek_file);

    tables(&chunks);
    clocks(&chunks);
    assert!(matches!(
        probe.cast_ts(
            &inputs,
            CastPacing::FullSpeed,
            8 * 1024 * 1024,
            &stop,
            &mut |_, _, _| false
        ),
        Err(ProbeError::Cancelled)
    ));
    assert!(matches!(
        probe.cast_ts(
            &inputs,
            CastPacing::FullSpeed,
            8 * 1024 * 1024,
            &stop,
            &mut |_, _, _| panic!("caught callback panic")
        ),
        Err(ProbeError::BackendFailure(_))
    ));
    let measured = session.mux(&probe, &inputs, CastFormat::Ts, &stop).unwrap();
    let quota = measured.summary.bytes;
    drop(measured);
    let bounded = CastSession::new(&cache, quota).unwrap();
    let held = bounded.mux(&probe, &inputs, CastFormat::Ts, &stop).unwrap();
    assert!(bounded.mux(&probe, &inputs, CastFormat::Ts, &stop).is_err());
    drop(held);
    let held = bounded.mux(&probe, &inputs, CastFormat::Ts, &stop).unwrap();
    let held_path = held.path().to_owned();
    drop(bounded);
    assert!(held_path.exists());
    drop(held);
    assert!(!held_path.exists());
    stop.store(true, Ordering::Release);
    for format in [CastFormat::Ts, CastFormat::Mp4] {
        assert!(matches!(
            session.mux(&probe, &inputs, format, &stop),
            Err(ProbeError::Cancelled)
        ));
    }
    stop.store(false, Ordering::Release);
    let tiny = CastSession::new(&cache, 188).unwrap();
    for format in [CastFormat::Ts, CastFormat::Mp4] {
        assert!(tiny.mux(&probe, &inputs, format, &stop).is_err());
    }
    drop(tiny);
    let hevc = fixture.join("video-hevc.mp4");
    let unsupported = CastInputs {
        video: &hevc,
        audio: &audio,
        start_us: 0,
    };
    assert!(matches!(
        session.mux(&probe, &unsupported, CastFormat::Ts, &stop),
        Err(ProbeError::Media(crate::MediaError {
            kind: crate::MediaErrorKind::UnsupportedCodec,
            ..
        }))
    ));
    let mut generated = 0;
    let began = std::time::Instant::now();
    let worker_stop = &stop;
    std::thread::scope(|scope| {
        scope.spawn(|| {
            std::thread::sleep(Duration::from_millis(80));
            worker_stop.store(true, Ordering::Release);
        });
        assert!(matches!(
            probe.cast_ts(
                &inputs,
                CastPacing::Realtime {
                    burst: Duration::ZERO
                },
                8 * 1024 * 1024,
                &stop,
                &mut |_, _, _| {
                    generated += 1;
                    true
                }
            ),
            Err(ProbeError::Cancelled)
        ));
    });
    assert!(began.elapsed() < Duration::from_millis(500));
    assert!(generated > 0);
    drop(session);
    assert!(
        std::fs::read_dir(cache.join(".cast"))
            .unwrap()
            .all(|e| e.unwrap().file_name() == ".lock")
    );
    std::fs::remove_dir_all(root).unwrap();
}

fn audio_fixture(probe: &LibavMetadataProbe, path: &Path, kind: u32, seconds: u32) {
    type Create = unsafe extern "C" fn(*const std::ffi::c_char, u32, u32) -> u32;
    // SAFETY: test-only export of the explicitly supplied native test companion.
    let create: Create =
        unsafe { transmute(probe._library.symbol(c"bm_test_cast_audio_v1").unwrap()) };
    let path = std::ffi::CString::new(path.to_str().unwrap()).unwrap();
    // SAFETY: the path outlives the synchronous fixture encoder.
    assert_eq!(unsafe { create(path.as_ptr(), kind, seconds) }, 0);
}

#[test]
#[ignore = "requires actual cast test companion"]
fn transcode_uses_decoded_eof_for_unknown_and_inaccurate_flac_duration() {
    let probe = load();
    let root = temporary();
    let audio = root.join("\u{97f3}\u{9891} unknown.flac");
    audio_fixture(&probe, &audio, 0, 2);
    let original = std::fs::read(&audio).unwrap();
    assert_eq!(&original[..4], b"fLaC");
    let mut header = u64::from_be_bytes(original[18..26].try_into().unwrap());
    assert_eq!(header & ((1 << 36) - 1), 192000);
    header &= !((1 << 36) - 1);
    let video = fixtures().join("video-reordered-start.mp4");
    let stop = AtomicBool::new(false);
    let session = CastSession::new(&root, 8 * 1024 * 1024).unwrap();
    for samples in [0, 192000 + 9600, 192000 - 19200] {
        let mut bytes = original.clone();
        bytes[18..26].copy_from_slice(&(header | samples).to_be_bytes());
        std::fs::write(&audio, bytes).unwrap();
        for format in [CastFormat::Ts, CastFormat::Mp4] {
            let out = session
                .mux(
                    &probe,
                    &CastInputs {
                        video: &video,
                        audio: &audio,
                        start_us: 0,
                    },
                    format,
                    &stop,
                )
                .unwrap();
            let actual = inspect(&probe, out.path());
            assert!(out.summary.audio_transcoded);
            assert!(
                (out.summary.duration_us - 2_000_000).abs() < 50_000,
                "{samples}: {actual:?}"
            );
            assert!((actual.last_end_us[1] - actual.first_pts_us[1] - 2_000_000).abs() < 50_000);
        }
    }
    drop(session);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
#[ignore = "requires actual cast test companion"]
fn multichannel_and_nonstandard_rate_aac_are_converted_to_stereo_lc() {
    let probe = load();
    let root = temporary();
    let video = fixtures().join("video-reordered-start.mp4");
    let audio = root.join("audio.m4a");
    let stop = AtomicBool::new(false);
    let session = CastSession::new(&root, 8 * 1024 * 1024).unwrap();
    for kind in [1, 2] {
        audio_fixture(&probe, &audio, kind, 2);
        for format in [CastFormat::Ts, CastFormat::Mp4] {
            let out = session
                .mux(
                    &probe,
                    &CastInputs {
                        video: &video,
                        audio: &audio,
                        start_us: 0,
                    },
                    format,
                    &stop,
                )
                .unwrap();
            let actual = inspect(&probe, out.path());
            assert!(
                out.summary.audio_transcoded,
                "AAC fixture {kind} bypassed conversion"
            );
            assert_eq!(
                (
                    actual.audio_rate,
                    actual.audio_channels,
                    actual.audio_profile
                ),
                (48000, 2, 1)
            );
        }
    }
    drop(session);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
#[ignore = "requires actual cast test companion"]
fn transcoded_ts_keeps_aac_priming_packet() {
    let probe = load();
    let root = temporary();
    let original = fixtures().join("video-reordered-start.mp4");
    let intra = root.join("intra.mp4");
    video_fixture(&probe, &original, &intra, c"bm_test_cast_intra_fixture_v1");
    let repeated = root.join("repeated.mp4");
    repeated_video(&probe, &original, &repeated);
    let audio = root.join("audio.flac");
    audio_fixture(&probe, &audio, 0, 4);
    let stop = AtomicBool::new(false);
    let session = CastSession::new(&root, 8 * 1024 * 1024).unwrap();
    for video in [&original, &intra, &repeated] {
        for start_us in [0, 1_500_000] {
            if video == &original && start_us > 0 {
                continue;
            }
            let out = session
                .mux(
                    &probe,
                    &CastInputs {
                        video,
                        audio: &audio,
                        start_us,
                    },
                    CastFormat::Ts,
                    &stop,
                )
                .unwrap();
            let actual = inspect(&probe, out.path());
            assert!(
                (actual.first_pts_us[0] - actual.first_pts_us[1] - 21_333).abs() < 25,
                "{actual:?}"
            );
            tables(&std::fs::read(out.path()).unwrap());
        }
    }
    drop(session);
    std::fs::remove_dir_all(root).unwrap();
}

fn null_packets(bytes: &[u8]) -> usize {
    bytes
        .chunks_exact(188)
        .filter(|p| p[1] & 31 == 31 && p[2] == 255)
        .count()
}

#[test]
#[ignore = "requires actual cast test companion"]
fn live_start_precedes_data_and_file_ts_avoids_cbr_padding() {
    let probe = load();
    let root = temporary();
    let video = root.join("three-gops.mp4");
    repeated_video(
        &probe,
        &fixtures().join("video-reordered-start.mp4"),
        &video,
    );
    let audio = fixtures().join("audio-eac3.m4a");
    let inputs = CastInputs {
        video: &video,
        audio: &audio,
        start_us: 1_500_000,
    };
    let stop = AtomicBool::new(false);
    let mut started = None;
    let mut data = 0;
    let result = probe.cast_ts_with_events(
        &inputs,
        CastPacing::FullSpeed,
        8 * 1024 * 1024,
        &stop,
        &mut |event| match event {
            CastEvent::Start(start) => {
                assert!(started.is_none());
                assert!((start.source_start_us - 1_001_000).abs() < 1000);
                assert!(start.timestamp_origin_us < start.source_start_us);
                assert_eq!((start.width, start.height), (160, 90));
                assert!(start.audio_transcoded);
                started = Some(start);
                true
            }
            CastEvent::Data { .. } => {
                assert!(started.is_some());
                data += 1;
                false
            }
        },
    );
    assert!(matches!(result, Err(ProbeError::Cancelled)));
    assert_eq!(data, 1); // start is delivered even though no EOF/summary was reached
    for panic in [false, true] {
        let result = probe.cast_ts_with_events(
            &inputs,
            CastPacing::FullSpeed,
            8 * 1024 * 1024,
            &stop,
            &mut |event| {
                assert!(matches!(event, CastEvent::Start(_)));
                assert!(!panic, "caught start callback panic");
                false
            },
        );
        if panic {
            assert!(matches!(result, Err(ProbeError::BackendFailure(_))));
        } else {
            assert!(matches!(result, Err(ProbeError::Cancelled)));
        }
    }
    let session = CastSession::new(&root, 8 * 1024 * 1024).unwrap();
    let file = session.mux(&probe, &inputs, CastFormat::Ts, &stop).unwrap();
    let bytes = std::fs::read(file.path()).unwrap();
    assert_eq!(null_packets(&bytes), 0);
    tables(&bytes);
    inspect(&probe, file.path());
    let mut live = Vec::new();
    probe
        .cast_ts(
            &inputs,
            CastPacing::FullSpeed,
            8 * 1024 * 1024,
            &stop,
            &mut |b, _, _| {
                live.extend_from_slice(b);
                true
            },
        )
        .unwrap();
    assert!(null_packets(&live) > 0);
    assert!(live.len() > bytes.len() * 2);
    clocks(&live);
    drop(file);
    drop(session);
    std::fs::remove_dir_all(root).unwrap();
}

fn assert_unsigned_ctts(bytes: &[u8]) {
    let mut offset = 0;
    while offset + 8 <= bytes.len() {
        let size = u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
        assert!(size >= 8 && offset + size <= bytes.len());
        let kind = &bytes[offset + 4..offset + 8];
        if kind == b"ctts" {
            assert_eq!(bytes[offset + 8], 0, "legacy MP4 requires unsigned CTS v0");
        }
        if [b"moov", b"trak", b"mdia", b"minf", b"stbl"].contains(&kind.try_into().unwrap()) {
            assert_unsigned_ctts(&bytes[offset + 8..offset + size]);
        }
        offset += size;
    }
}

#[test]
#[ignore = "requires actual cast test companion"]
fn malformed_cast_inputs_have_media_error_categories() {
    use crate::MediaErrorKind::{InvalidMedia, MediaContractViolation};
    let probe = load();
    let root = temporary();
    let stop = AtomicBool::new(false);
    let session = CastSession::new(&root, 8 * 1024 * 1024).unwrap();
    let video = fixtures().join("video-reordered-start.mp4");
    let audio = fixtures().join("audio.m4a");
    let empty = root.join("empty.m4a");
    std::fs::write(&empty, []).unwrap();
    let flac = root.join("truncated.flac");
    audio_fixture(&probe, &flac, 0, 2);
    type AudioIo = unsafe extern "C" fn(*const wire::Request) -> u32;
    // SAFETY: explicitly selected test companion and private test-only signature.
    let audio_io: AudioIo =
        unsafe { transmute(probe._library.symbol(c"bm_test_cast_audio_io_v1").unwrap()) };
    {
        let input = open_input(&flac).unwrap();
        let fd = probe._library.descriptor(&input).unwrap();
        extern "C" fn never(_: *mut c_void) -> i32 {
            0
        }
        let request = wire::Request {
            fd: fd.fd,
            cancelled: never,
            opaque: std::ptr::null_mut(),
        };
        // SAFETY: synchronous test call keeps all descriptor borrows alive.
        assert_eq!(unsafe { audio_io(&request) }, 8); // BM_IO, not BM_INVALID_MEDIA
        // Scope end releases the descriptor (Windows closes its duplicated CRT
        // fd; POSIX only ends the borrow) before `input`, and both before the
        // sample is rewritten below.
    }
    let mut bytes = std::fs::read(&flac).unwrap();
    bytes.truncate(bytes.len() - 31);
    std::fs::write(&flac, bytes).unwrap();
    let combined = session
        .mux(
            &probe,
            &CastInputs {
                video: &video,
                audio: &audio,
                start_us: 0,
            },
            CastFormat::Mp4,
            &stop,
        )
        .unwrap();
    for (v, a, kind) in [
        (video.as_path(), empty.as_path(), InvalidMedia),
        (&empty, &audio, InvalidMedia),
        (&video, &video, MediaContractViolation),
        (&audio, &audio, MediaContractViolation),
        (&video, &flac, InvalidMedia),
        (combined.path(), &audio, MediaContractViolation),
    ] {
        match session.mux(
            &probe,
            &CastInputs {
                video: v,
                audio: a,
                start_us: 0,
            },
            CastFormat::Ts,
            &stop,
        ) {
            Err(ProbeError::Media(error)) => assert_eq!(error.kind, kind, "{v:?}/{a:?}"),
            result => panic!("wrong error category for {v:?}/{a:?}: {:?}", result.err()),
        }
    }
    drop(combined);
    drop(session);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
#[ignore = "requires actual cast test companion"]
fn cancellation_after_staging_write_removes_partial_before_session_drop() {
    let probe = load();
    let root = temporary();
    let audio = root.join("long.flac");
    audio_fixture(&probe, &audio, 0, 60);
    let video = fixtures().join("video-reordered-start.mp4");
    let session = CastSession::new(&root, 32 * 1024 * 1024).unwrap();
    for format in [CastFormat::Ts, CastFormat::Mp4] {
        let stop = AtomicBool::new(false);
        let done = AtomicBool::new(false);
        let observed = AtomicBool::new(false);
        std::thread::scope(|scope| {
            scope.spawn(|| {
                let deadline = std::time::Instant::now() + Duration::from_secs(10);
                while !done.load(Ordering::Acquire) && std::time::Instant::now() < deadline {
                    for directory in std::fs::read_dir(root.join(".cast")).unwrap().flatten() {
                        if !directory.path().is_dir() {
                            continue;
                        }
                        for entry in std::fs::read_dir(directory.path()).unwrap().flatten() {
                            if entry.path().extension().is_some_and(|e| e == "part")
                                && std::fs::metadata(entry.path()).is_ok_and(|m| m.len() > 0)
                            {
                                observed.store(true, Ordering::Release);
                                stop.store(true, Ordering::Release);
                                return;
                            }
                        }
                    }
                    std::thread::sleep(Duration::from_millis(1));
                }
            });
            let result = session.mux(
                &probe,
                &CastInputs {
                    video: &video,
                    audio: &audio,
                    start_us: 0,
                },
                format,
                &stop,
            );
            done.store(true, Ordering::Release);
            assert!(
                matches!(result, Err(ProbeError::Cancelled)),
                "expected cancellation: {:?}",
                result.err()
            );
        });
        assert!(observed.load(Ordering::Acquire));
        let directories: Vec<_> = std::fs::read_dir(root.join(".cast"))
            .unwrap()
            .flatten()
            .filter(|e| e.path().is_dir())
            .collect();
        assert_eq!(directories.len(), 1); // session is still alive
        assert!(
            std::fs::read_dir(directories[0].path())
                .unwrap()
                .all(|e| e.unwrap().file_name() == ".lease")
        );
    }
    drop(session);
    std::fs::remove_dir_all(root).unwrap();
}

// Native ABI=0 fixture ported from R2 A2 (702951f).
struct IncompatibleCompanion {
    directory: PathBuf,
    library: PathBuf,
}

impl IncompatibleCompanion {
    fn build() -> Self {
        let directory = temporary();
        let name = if cfg!(target_os = "windows") {
            "incompatible.dll"
        } else if cfg!(target_os = "macos") {
            "libincompatible.dylib"
        } else {
            "libincompatible.so"
        };
        let fixture = Self {
            library: directory.join(name),
            directory,
        };
        std::fs::write(
            fixture.directory.join("fixture.c"),
            include_bytes!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../tests/fixtures/libav_incompatible.c"
            )),
        )
        .unwrap();
        // Use the native compiler already required by this Cargo test build.
        // Relative arguments avoid passing Windows verbatim paths to MSVC.
        let mut compiler = if cfg!(target_os = "windows") {
            let mut command = std::process::Command::new("cl.exe");
            command.args([
                "/nologo",
                "/LD",
                "/W4",
                "/WX",
                "fixture.c",
                "/Fofixture.obj",
                "/link",
                "/OUT:incompatible.dll",
                "/IMPLIB:fixture.lib",
            ]);
            command
        } else {
            let mut command = std::process::Command::new("cc");
            command.args([
                if cfg!(target_os = "macos") {
                    "-dynamiclib"
                } else {
                    "-shared"
                },
                "-fPIC",
                "-Wall",
                "-Wextra",
                "-Werror",
                "fixture.c",
                "-o",
                name,
            ]);
            command
        };
        let status = compiler
            .current_dir(&fixture.directory)
            .status()
            .expect("native C compiler required to build the incompatible ABI fixture");
        assert!(
            status.success(),
            "incompatible ABI fixture compilation failed: {status}"
        );
        assert!(fixture.library.is_file());
        fixture
    }
}

impl Drop for IncompatibleCompanion {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

#[test]
fn incompatible_project_abi_is_rejected_before_cast_negotiation() {
    let fixture = IncompatibleCompanion::build();
    // SAFETY: this test just built the trusted ABI=0 library from a pinned source.
    let error = match unsafe { LibavMetadataProbe::load(&fixture.library) } {
        Ok(_) => panic!("ABI=0 companion was accepted"),
        Err(error) => error,
    };
    // This ABI=0 fixture exports no metadata/cast negotiation symbols. Require
    // P7's typed ABI rejection, not a later missing-symbol or capability error.
    assert!(
        matches!(
            error,
            ProbeError::NegotiationFailed(NegotiationFailure::Abi)
        ),
        "{error:?}"
    );
}
