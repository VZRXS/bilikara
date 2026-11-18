//! Real schema-2 companion, local fixtures, actual loopback HTTP delivery. This
//! is simulated receiver evidence, never DLNA hardware qualification.
use super::*;
use crate::experimental_libav::{
    LibavMetadataProbe,
    cast_mux::{CastFormat, CastInputs, CastSession},
};
use std::sync::atomic::AtomicBool;

fn probe() -> LibavMetadataProbe {
    let path = std::env::var_os("BILIKARA_TEST_CAST_COMPANION")
        .expect("explicit freshly built test companion");
    // SAFETY: the operator selects the locally built, trusted test library.
    unsafe { LibavMetadataProbe::load(Path::new(&path)) }.unwrap()
}

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("tests/fixtures/bbdown")
}

// Private test-shim ABI from media-libav/probe.h and test_shim.c. Reuse the
// companion fixture export without changing T3 or adding an encoder/CLI.
#[repr(C)]
struct FixtureRequest {
    fd: i32,
    cancelled: extern "C" fn(*mut std::ffi::c_void) -> i32,
    opaque: *mut std::ffi::c_void,
}
extern "C" fn never_cancel(_: *mut std::ffi::c_void) -> i32 {
    0
}
type MakeFixture = unsafe extern "C" fn(*const FixtureRequest, *const std::ffi::c_char) -> u32;

fn repeated_video(_probe: &LibavMetadataProbe, source: &Path, destination: &Path) {
    let file = std::fs::File::open(source).unwrap();
    let output = std::ffi::CString::new(destination.to_str().unwrap()).unwrap();
    let path = std::env::var_os("BILIKARA_TEST_CAST_COMPANION").unwrap();
    #[cfg(windows)]
    {
        use std::os::windows::{ffi::OsStrExt, io::AsRawHandle};
        use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
        let wide: Vec<u16> = path.encode_wide().chain(Some(0)).collect();
        // SAFETY: _probe keeps this already validated module alive. Resolve
        // only its known test/descriptor ABI. Its /MD UCRT duplicates the
        // borrowed handle; no Rust CRT fd crosses the boundary.
        let status = unsafe {
            let module = GetModuleHandleW(wide.as_ptr());
            assert!(!module.is_null());
            let make: MakeFixture = std::mem::transmute(
                GetProcAddress(module, c"bm_test_cast_fixture_v1".as_ptr().cast()).unwrap(),
            );
            let open: unsafe extern "C" fn(*mut std::ffi::c_void) -> i32 = std::mem::transmute(
                GetProcAddress(module, c"bm_fd_from_handle_v1".as_ptr().cast()).unwrap(),
            );
            let close: unsafe extern "C" fn(i32) = std::mem::transmute(
                GetProcAddress(module, c"bm_fd_close_v1".as_ptr().cast()).unwrap(),
            );
            let fd = open(file.as_raw_handle());
            assert!(fd >= 0);
            let status = make(
                &FixtureRequest {
                    fd,
                    cancelled: never_cancel,
                    opaque: std::ptr::null_mut(),
                },
                output.as_ptr(),
            );
            close(fd);
            status
        };
        assert_eq!(status, 0);
    }
    #[cfg(unix)]
    {
        use std::os::unix::{ffi::OsStrExt, io::AsRawFd};
        let path = std::ffi::CString::new(path.as_bytes()).unwrap();
        // SAFETY: the trusted test ABI above; fd/strings live through this
        // synchronous call. Balance dlopen's extra module reference.
        let status = unsafe {
            let module = libc::dlopen(path.as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL);
            assert!(!module.is_null());
            let symbol = libc::dlsym(module, c"bm_test_cast_fixture_v1".as_ptr());
            assert!(!symbol.is_null());
            let make: MakeFixture = std::mem::transmute(symbol);
            let status = make(
                &FixtureRequest {
                    fd: file.as_raw_fd(),
                    cancelled: never_cancel,
                    opaque: std::ptr::null_mut(),
                },
                output.as_ptr(),
            );
            libc::dlclose(module);
            status
        };
        assert_eq!(status, 0);
    }
}

fn inspect_ts(data: &[u8]) -> u64 {
    assert!(continuity::valid(data));
    let mut counters = HashMap::new();
    let mut pmt = None;
    let mut codecs = Vec::new();
    let mut first_video = Vec::new();
    let mut video_pid = None;
    let mut video_complete = false;
    let mut pcrs = Vec::new();
    for p in data.chunks_exact(188) {
        let pid = (u16::from(p[1] & 31) << 8) | u16::from(p[2]);
        if pid == 8191 {
            continue;
        }
        let payload = p[3] & 16 != 0;
        if let Some(previous) = counters.get(&pid) {
            assert_eq!(
                p[3] & 15,
                if payload {
                    (previous + 1) & 15
                } else {
                    *previous
                },
                "PID {pid}"
            );
        }
        if payload {
            counters.insert(pid, p[3] & 15);
        }
        let mut at = 4;
        if p[3] & 32 != 0 {
            if p[4] >= 7 && p[5] & 16 != 0 {
                let base = (u64::from(p[6]) << 25)
                    | (u64::from(p[7]) << 17)
                    | (u64::from(p[8]) << 9)
                    | (u64::from(p[9]) << 1)
                    | (u64::from(p[10]) >> 7);
                let extension = (u64::from(p[10] & 1) << 8) | u64::from(p[11]);
                pcrs.push(base * 300 + extension);
            }
            at += 1 + usize::from(p[4]);
        }
        if !payload || at >= 188 {
            continue;
        }
        if p[1] & 64 != 0 && pid == 0 {
            let table = &p[at + 1 + usize::from(p[at])..];
            assert_eq!(table[0], 0);
            pmt = Some((u16::from(table[10] & 31) << 8) | u16::from(table[11]));
        } else if p[1] & 64 != 0 && Some(pid) == pmt {
            let table = &p[at + 1 + usize::from(p[at])..];
            assert_eq!(table[0], 2);
            let end = 3 + ((usize::from(table[1] & 15) << 8) | usize::from(table[2])) - 4;
            let mut offset = 12 + ((usize::from(table[10] & 15) << 8) | usize::from(table[11]));
            codecs.clear();
            while offset + 5 <= end {
                codecs.push(table[offset]);
                offset += 5
                    + ((usize::from(table[offset + 3] & 15) << 8) | usize::from(table[offset + 4]));
            }
        } else if !video_complete
            && p[1] & 64 != 0
            && p[at..].starts_with(&[0, 0, 1])
            && (0xe0..=0xef).contains(&p[at + 3])
        {
            if video_pid.is_none() {
                video_pid = Some(pid);
                first_video.extend_from_slice(&p[at..]);
            } else {
                video_complete = true;
            }
        } else if !video_complete && Some(pid) == video_pid {
            first_video.extend_from_slice(&p[at..]);
        }
    }
    assert!(pmt.is_some(), "PAT present on join");
    assert_eq!(codecs, [0x1b, 0x0f]);
    assert!(
        first_video
            .windows(4)
            .any(|w| w[..3] == [0, 0, 1] && w[3] & 31 == 5),
        "first video PES includes IDR"
    );
    assert!(pcrs.len() > 2);
    const WRAP: u64 = (1u64 << 33) * 300;
    assert!(
        pcrs.windows(2)
            .all(|p| (p[1] + WRAP - p[0]) % WRAP < 27_000_000),
        "PCR monotonic including wrap"
    );
    pcrs[0]
}

#[test]
#[ignore = "requires freshly built native schema-2 test companion"]
fn real_companion_file_ts_mp4_live_http_and_t3_lease_cleanup() {
    run(async {
        let temp = Temp::new();
        let probe = probe();
        let fixtures = fixtures();
        // T3's real cast fixture: 24 H.264 packets with B frames / reordered
        // timestamps. The older one-sample BBDown stub is not cast media.
        let video = temp.0.join("three-gops.mp4");
        repeated_video(&probe, &fixtures.join("video-reordered-start.mp4"), &video);
        let preflight = probe
            .cast_preflight(&video, &AtomicBool::new(false))
            .unwrap();
        assert_eq!(preflight.packets, 72);
        assert!(preflight.has_b_frames);
        assert!((preflight.gop_us.unwrap() - 1_001_000).abs() < 1000);
        let audio = fixtures.join("audio.m4a");
        let inputs = CastInputs {
            video: &video,
            audio: &audio,
            start_us: 0,
        };
        let session = CastSession::new(&temp.0, 16 * 1024 * 1024).unwrap();
        let endpoint = endpoint().await;
        let address = endpoint.local_addr();
        for (id, format) in [(1, CastFormat::Ts), (2, CastFormat::Mp4)] {
            let file = session
                .mux(&probe, &inputs, format, &AtomicBool::new(false))
                .unwrap();
            let path = file.path().to_owned();
            let expected = std::fs::read(&path).unwrap();
            let media = endpoint.publish_file(id, file, TsMime::Mp2t).unwrap();
            let response = request(&endpoint, "GET", &media.uri, "").await;
            assert_eq!(response.status, 200);
            assert_eq!(
                response.headers["content-length"],
                expected.len().to_string()
            );
            assert_eq!(response.body().await, expected);
            let response = request(&endpoint, "GET", &media.uri, "Range: bytes=1-13\r\n").await;
            assert_eq!(response.status, 206);
            assert_eq!(response.body().await, &expected[1..14]);
            assert!(
                request(&endpoint, "HEAD", &media.uri, "")
                    .await
                    .body()
                    .await
                    .is_empty()
            );
            endpoint.clear_generation();
            until(|| !path.exists()).await;
        }
        let (stream, producer) = LiveStream::external(LiveOptions {
            burst: Duration::ZERO,
            ..LiveOptions::default()
        })
        .unwrap();
        let media = endpoint
            .publish_live(3, stream.clone(), TsMime::Mp2t)
            .unwrap();
        let mut response = request(&endpoint, "GET", &media.uri, "Range: bytes=9999999-\r\n").await;
        assert_eq!(response.status, 200);
        assert!(!response.headers.contains_key("content-length"));
        let thread = tokio::task::spawn_blocking(move || {
            let probe = super::companion::probe();
            producer.generate(
                &probe,
                &CastInputs {
                    video: &video,
                    audio: &audio,
                    start_us: 0,
                },
                16 * 1024 * 1024,
            )
        });
        let reader = tokio::spawn(async move {
            let mut ts = Vec::new();
            timeout(Duration::from_secs(8), response.socket.read_to_end(&mut ts))
                .await
                .unwrap()
                .unwrap();
            ts
        });
        until(|| stream.snapshot().keyframes >= 2).await;
        assert!(!stream.snapshot().finished);
        let joined = request(&endpoint, "GET", &media.uri, "Range: bytes=-0\r\n").await;
        assert_eq!(joined.status, 200);
        let joined = joined.body().await;
        let ts = reader.await.unwrap();
        thread.await.unwrap().unwrap();
        let initial_pcr = inspect_ts(&ts);
        let join_pcr = inspect_ts(&joined);
        const WRAP: u64 = (1u64 << 33) * 300;
        assert!(
            (join_pcr + WRAP - initial_pcr) % WRAP > 500_000 * 27,
            "second HTTP GET joined a later real GOP"
        );
        assert!(stream.snapshot().start.is_some());
        let diag = endpoint.shutdown().await;
        assert!(diag.first_get_written);
        assert!(
            diag.stages
                .iter()
                .any(|e| e.generation == Some(3) && e.stage == HttpStage::FirstByte)
        );
        drop(session);
        assert_eq!(std::fs::read_dir(temp.0.join(".cast")).unwrap().count(), 1); // stable .lock
        assert!(TcpListener::bind(address).await.is_ok());
    });
}

// Repeat encoded access units without an encoder. Double sample durations to
// obtain a 2.002s GOP; filler_data NALs make the input approximately 7 Mbps.
// This exercises T3's real approximately 15 Mbps live CBR and multi-chunk PES.
fn long_high_bitrate_video(source: &Path, destination: &Path) {
    use mp4::{
        AvcConfig, MediaConfig, Mp4Config, Mp4Reader, Mp4Sample, Mp4Writer, TrackConfig, TrackType,
    };
    // The committed fixture is fragmented. Normalize through the real test
    // companion first; mp4 0.14's sample reader does not implement its trun
    // data offsets. The resulting ordinary MP4 keeps the encoded samples.
    let normalized = destination.with_extension("source.mp4");
    repeated_video(&probe(), source, &normalized);
    let input = std::fs::File::open(normalized).unwrap();
    let size = input.metadata().unwrap().len();
    let mut reader = Mp4Reader::read_header(input, size).unwrap();
    let (&id, track) = reader.tracks().iter().next().unwrap();
    let timescale = track.timescale();
    let count = track.sample_count();
    assert_eq!(count, 72);
    let config = TrackConfig {
        track_type: TrackType::Video,
        timescale,
        language: track.language().to_owned(),
        media_conf: MediaConfig::AvcConfig(AvcConfig {
            width: track.width(),
            height: track.height(),
            seq_param_set: track.sequence_parameter_set().unwrap().to_vec(),
            pic_param_set: track.picture_parameter_set().unwrap().to_vec(),
        }),
    };
    let samples: Vec<_> = (1..=24)
        .map(|n| reader.read_sample(id, n).unwrap().unwrap())
        .collect();
    let gop_ticks: u64 = samples.iter().map(|s| u64::from(s.duration) * 2).sum();
    let output = std::fs::File::create(destination).unwrap();
    let mut writer = Mp4Writer::write_start(
        output,
        &Mp4Config {
            major_brand: "isom".parse().unwrap(),
            minor_version: 512,
            compatible_brands: vec!["isom".parse().unwrap(), "avc1".parse().unwrap()],
            timescale: 1000,
        },
    )
    .unwrap();
    writer.add_track(&config).unwrap();
    for repeat in 0..15 {
        for sample in &samples {
            let mut data = sample.bytes.to_vec();
            let mut nals = data.as_slice();
            while !nals.is_empty() {
                let length = u32::from_be_bytes(nals[..4].try_into().unwrap()) as usize;
                assert!(length > 0 && length + 4 <= nals.len());
                nals = &nals[4 + length..];
            }
            let filler_size = 73_000 - data.len() - 4;
            data.extend_from_slice(&(filler_size as u32).to_be_bytes());
            data.push(12); // H.264 filler_data NAL, nal_ref_idc=0
            data.resize(72_999, 0xff);
            data.push(0x80); // rbsp_trailing_bits
            writer
                .write_sample(
                    1,
                    &Mp4Sample {
                        start_time: (sample.start_time - samples[0].start_time) * 2
                            + repeat * gop_ticks,
                        duration: sample.duration * 2,
                        rendering_offset: sample.rendering_offset * 2,
                        is_sync: sample.is_sync,
                        bytes: data.into(),
                    },
                )
                .unwrap();
        }
    }
    writer.write_end().unwrap();
}

fn first_video_pts(bytes: &[u8]) -> u64 {
    for p in bytes.chunks_exact(188) {
        if p[1] & 0x40 == 0 || p[3] & 0x10 == 0 {
            continue;
        }
        let offset = if p[3] & 0x20 != 0 {
            5 + usize::from(p[4])
        } else {
            4
        };
        let payload = &p[offset..];
        if payload.starts_with(&[0, 0, 1, 0xe0]) && payload.len() >= 14 && payload[7] & 0x80 != 0 {
            let b = &payload[9..14];
            return (u64::from(b[0] & 14) << 29)
                | (u64::from(b[1]) << 22)
                | (u64::from(b[2] & 0xfe) << 14)
                | (u64::from(b[3]) << 7)
                | u64::from(b[4] >> 1);
        }
    }
    panic!("missing video PTS");
}

#[test]
#[ignore = "requires freshly built native schema-2 test companion"]
fn real_companion_default_burst_join_after_one_point_five_seconds_keeps_all_bytes() {
    run(async {
        let temp = Temp::new();
        let video = temp.0.join("thirty-seconds-7mbps.mp4");
        long_high_bitrate_video(&fixtures().join("video-reordered-start.mp4"), &video);
        let stream = Arc::new(LiveStream::new(LiveOptions::default()).unwrap());
        let endpoint = endpoint().await;
        let media = endpoint
            .publish_live(1, stream.clone(), TsMime::Mp2t)
            .unwrap();
        let produced = Arc::new(Mutex::new(Vec::new()));
        let output = produced.clone();
        let generator = stream.clone();
        let task = tokio::task::spawn_blocking(move || {
            let probe = probe();
            let preflight = probe
                .cast_preflight(&video, &AtomicBool::new(false))
                .unwrap();
            assert_eq!(preflight.packets, 360);
            assert!((1_900_000..2_100_000).contains(&preflight.gop_us.unwrap()));
            let result = probe.cast_ts_with_events(
                &CastInputs {
                    video: &video,
                    audio: &fixtures().join("audio.m4a"),
                    start_us: 0,
                },
                generator.options.pacing(),
                96 * 1024 * 1024,
                &AtomicBool::new(false),
                &mut |event| {
                    if let CastEvent::Data { bytes, .. } = &event {
                        output.lock().unwrap().extend_from_slice(bytes);
                    }
                    generator.push(event).is_ok()
                },
            );
            generator.finish(result.is_ok());
            result.unwrap()
        });
        until(|| stream.snapshot().start.is_some()).await;
        sleep(Duration::from_millis(1500)).await;
        assert!(!task.is_finished());
        let prefix_length = produced.lock().unwrap().len();
        assert!(
            prefix_length > 9 * 1024 * 1024,
            "real high-rate producer has five seconds of lead"
        );
        let mut response = request(&endpoint, "GET", &media.uri, "").await;
        assert_eq!(response.status, 200);
        let burst_started = Instant::now();
        let mut received = vec![0; prefix_length];
        timeout(
            Duration::from_secs(1),
            response.socket.read_exact(&mut received),
        )
        .await
        .unwrap()
        .unwrap();
        let burst_elapsed = burst_started.elapsed();
        // All already buffered data, including the five-second lead, bursts
        // immediately. Remaining bytes follow the real generation's 1x clock.
        timeout(
            Duration::from_secs(30),
            response.socket.read_to_end(&mut received),
        )
        .await
        .unwrap()
        .unwrap();
        let summary = task.await.unwrap();
        let mut expected = std::mem::take(&mut *produced.lock().unwrap());
        assert_eq!(expected.len() as u64, summary.bytes);
        assert!(expected.len() > 45 * 1024 * 1024);
        assert_eq!(
            first_video_pts(&received),
            first_video_pts(&expected),
            "1.5s join must select the 0s GOP, never the generated 6s GOP"
        );
        continuity::Continuity::new().rewrite(&mut expected);
        assert_eq!(
            received.len(),
            expected.len(),
            "all subsequent bytes must reach the normal reader"
        );
        assert_eq!(received, expected);
        let diag = endpoint.shutdown().await;
        assert!(!diag.stages.iter().any(|e| e.stage == HttpStage::LiveJump));
        let get = diag
            .stages
            .iter()
            .find(|e| e.stage == HttpStage::Get)
            .unwrap();
        assert_eq!(get.media_time_us, Some(0));
        assert_eq!(get.live_start, stream.snapshot().start);
        eprintln!(
            "default-burst regression: total_bytes={}, prefix_bytes={}, burst_ms={}, first_pts_90khz={}, join_watermark_us=0, jumps=0",
            summary.bytes,
            prefix_length,
            burst_elapsed.as_millis(),
            first_video_pts(&received)
        );
    });
}
