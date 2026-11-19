//! Real GStreamer pipelines on CPU-only software decoders. Run with
//! `BILIKARA_TEST_GSTREAMER_ENGINE=1 CUDA_VISIBLE_DEVICES='' cargo test -- --ignored --test-threads=1`.
mod support;

use bilikara_media_engine::{ClockMode, Command, ObservationKind, SettingsPatch};
use std::time::{Duration, Instant};
use support::*;

const SHORT: Duration = Duration::from_secs(10);

fn load(h: &support::Harness, generation: u64, audio: &std::path::Path, start: f64, play: bool) {
    h.engine
        .command(Command::Load {
            program: program(generation, "p1"),
            media: media(audio),
            start_seconds: start,
            play,
        })
        .unwrap();
}

#[test]
#[ignore = "live GStreamer"]
fn natural_end_reports_one_drained_eos_with_tail_and_start_preserved() {
    let mut h = Harness::start(ClockMode::System);
    let fixtures = fixtures();
    let p = program(1, "p1");
    load(&h, 1, &fixtures.aac, 0.0, true);
    h.wait(SHORT, "ready", is("ready"));
    h.wait(SHORT, "playing", is("playing"));
    h.wait(SHORT, "0.4 s rendered", |o| {
        o.position.is_some_and(|p| p > 0.4)
    });
    // Jump close to the end so the test is short; the end marker lives in the
    // last 60 ms and only reaches the sink if the DSP tail is drained.
    h.engine
        .command(Command::Seek {
            program: p.clone(),
            seconds: 6.5,
            play: None,
        })
        .unwrap();
    let eos = h.wait(SHORT, "drained eos", is("eos"));
    assert_eq!(
        eos.kind,
        ObservationKind::Eos {
            drained: true,
            watchdog: false
        }
    );
    h.drain(Duration::from_millis(1500));
    assert_eq!(h.eos_count(&p), 1, "exactly one completion");
    let chunks = h.pcm_after(Instant::now() - Duration::from_secs(30));
    let tail = window(&chunks, f64::from(SECONDS) - 0.05, f64::from(SECONDS));
    assert!(
        tail.len() > 2 * 2000,
        "tail frames rendered: {}",
        tail.len() / 2
    );
    // Signalsmith's analysis window smears the 1 kHz -> 2 kHz boundary, so
    // compare tone energy instead of a zero-crossing frequency estimate.
    let marker = tone_power(&tail, 2000.0);
    let previous = tone_power(&tail, 1000.0);
    assert!(
        marker > 0.001 && marker > previous * 2.0,
        "end marker survives the drain: {marker} vs {previous}"
    );
    let start = window(&chunks, 0.0, 0.2);
    assert!(rms(&start) > 0.1, "track start audible from frame zero");
    let first = h.frames.presented.lock().unwrap().first().copied().unwrap();
    assert_eq!(first.index, 0, "first presented frame is frame zero");
}

#[test]
#[ignore = "live GStreamer"]
fn accurate_seek_aligns_independent_audio_and_video() {
    let mut h = Harness::start(ClockMode::System);
    let fixtures = fixtures();
    let p = program(1, "p1");
    load(&h, 1, &fixtures.aac, 0.0, false);
    h.wait(SHORT, "ready", is("ready"));
    for target in [6.0f64, 2.0, 4.0] {
        h.engine
            .command(Command::Seek {
                program: p.clone(),
                seconds: target,
                play: Some(false),
            })
            .unwrap();
        let settled = h.wait(SHORT, "seek settled", is("seek-settled"));
        let settled_at = Instant::now();
        let frames = h.frames.presented.lock().unwrap().clone();
        let shown = frames.last().unwrap().index;
        let expected = (target * f64::from(FPS)).round() as u32;
        assert!(
            shown.abs_diff(expected) <= 1,
            "seek {target}: frame {shown} != {expected}; settled={settled:?}; recent={:?}",
            frames
                .iter()
                .rev()
                .take(4)
                .map(|f| (f.index, f.pts_ns, settled_at.duration_since(f.at)))
                .collect::<Vec<_>>()
        );
    }
    let resumed = Instant::now();
    h.engine
        .command(Command::Play { program: p.clone() })
        .unwrap();
    h.wait(SHORT, "playing", is("playing"));
    std::thread::sleep(Duration::from_millis(1200));
    let chunks = h.pcm_after(resumed);
    let first_pts = chunks.iter().find_map(|c| c.pts_ns).unwrap() as f64 / 1e9;
    assert!(
        (first_pts - 4.0).abs() < 0.03,
        "audio resumes at the seek target: {first_pts}"
    );
    let tone = frequency(&window(&chunks, 4.1, 4.9));
    assert!(
        (tone - 700.0).abs() < 25.0,
        "second-4 tone from the independent file: {tone}"
    );
}

#[test]
#[ignore = "live GStreamer"]
fn repeated_mixed_controls_never_hang_and_complete_once() {
    let mut h = Harness::start(ClockMode::AudioSink);
    let fixtures = fixtures();
    let p = program(1, "p1");
    load(&h, 1, &fixtures.aac, 0.0, true);
    h.wait(SHORT, "ready", is("ready"));
    // Deterministic adversarial ordering: commands are issued without waiting
    // for settlement so seeks, pauses, key changes and resumes overlap.
    let mut state = 0x9e37_79b9u32;
    let mut next = || {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        state
    };
    for round in 0..60 {
        let choice = next() % 6;
        let command = match choice {
            0 => Command::Pause { program: p.clone() },
            1 => Command::Play { program: p.clone() },
            2 | 3 => Command::Seek {
                program: p.clone(),
                seconds: f64::from(next() % 7000) / 1000.0,
                play: if round % 3 == 0 {
                    Some(next() % 2 == 0)
                } else {
                    None
                },
            },
            4 => Command::Settings(SettingsPatch {
                key_shift: Some((next() % 9) as f32 - 4.0),
                ..Default::default()
            }),
            _ => Command::Settings(SettingsPatch {
                av_delay_ms: Some(i64::from(next() % 600) - 300),
                ..Default::default()
            }),
        };
        // Play after a drained EOS is a legitimate rejection.
        let _ = h.engine.command(command);
        std::thread::sleep(Duration::from_millis(u64::from(next() % 120)));
    }
    h.engine
        .command(Command::Seek {
            program: p.clone(),
            seconds: 7.0,
            play: Some(true),
        })
        .unwrap();
    h.wait(
        Duration::from_secs(15),
        "eos after mixed controls",
        is("eos"),
    );
    h.drain(Duration::from_millis(1500));
    assert_eq!(h.eos_count(&p), 1, "one completion for the final segment");
    assert!(
        !h.seen
            .iter()
            .any(|o| matches!(o.kind, ObservationKind::Error { .. })),
        "no errors or stalls: {:?}",
        h.seen
            .iter()
            .filter(|o| matches!(o.kind, ObservationKind::Error { .. }))
            .collect::<Vec<_>>()
    );
}

#[test]
#[ignore = "live GStreamer"]
fn superseded_segment_and_retired_pipeline_cannot_complete_current_program() {
    let mut h = Harness::start(ClockMode::System);
    let fixtures = fixtures();
    let first = program(1, "p1");
    load(&h, 1, &fixtures.aac, 0.0, true);
    h.wait(SHORT, "ready", is("ready"));
    h.engine
        .command(Command::Seek {
            program: first.clone(),
            seconds: 7.8,
            play: None,
        })
        .unwrap();
    // Seek back before the old segment drains: its EOS is stale.
    std::thread::sleep(Duration::from_millis(150));
    h.engine
        .command(Command::Seek {
            program: first.clone(),
            seconds: 1.0,
            play: None,
        })
        .unwrap();
    h.drain(Duration::from_millis(1200));
    assert_eq!(h.eos_count(&first), 0, "superseded segment never completes");
    // Retire the program near its end; the next generation starts at zero.
    h.engine
        .command(Command::Seek {
            program: first.clone(),
            seconds: 7.9,
            play: None,
        })
        .unwrap();
    std::thread::sleep(Duration::from_millis(60));
    load(&h, 2, &fixtures.aac, 0.0, true);
    let second = program(2, "p1");
    h.wait(SHORT, "second ready", |o| {
        o.program == second && matches!(o.kind, ObservationKind::Ready)
    });
    h.drain(Duration::from_millis(1500));
    assert_eq!(
        h.eos_count(&second),
        0,
        "retired pipeline EOS cannot end the new program"
    );
    assert_eq!(
        h.engine.command(Command::Pause {
            program: first.clone()
        }),
        Err(bilikara_media_engine::CommandError {
            code: "stale-program".into()
        })
    );
    assert_eq!(h.engine.snapshot().pipelines_created, 2);
}

#[test]
#[ignore = "live GStreamer"]
fn pitch_and_variant_replacement_follow_the_program() {
    let mut h = Harness::start(ClockMode::System);
    let fixtures = fixtures();
    h.engine
        .command(Command::Settings(SettingsPatch {
            key_shift: Some(2.0),
            ..Default::default()
        }))
        .unwrap();
    load(&h, 1, &fixtures.aac, 2.0, true);
    h.wait(SHORT, "playing", is("playing"));
    std::thread::sleep(Duration::from_millis(900));
    let chunks = h.pcm_after(Instant::now() - Duration::from_secs(5));
    let shifted = frequency(&window(&chunks, 2.2, 2.8));
    let expected = 500.0 * 2f64.powf(2.0 / 12.0);
    assert!(
        (shifted - expected).abs() < 25.0,
        "+2 semitones: {shifted} vs {expected}"
    );
    // Audio variant change = new authorized program at the preserved position.
    let switched = Instant::now();
    h.engine
        .command(Command::Settings(SettingsPatch {
            key_shift: Some(0.0),
            ..Default::default()
        }))
        .unwrap();
    h.engine
        .command(Command::Load {
            program: program(2, "p2"),
            media: media(&fixtures.flac),
            start_seconds: 3.0,
            play: true,
        })
        .unwrap();
    h.wait(SHORT, "variant playing", |o| {
        o.program.playback_generation == 2 && matches!(o.kind, ObservationKind::Playing)
    });
    std::thread::sleep(Duration::from_millis(900));
    let chunks = h.pcm_after(switched);
    let tone = frequency(&window(&chunks, 3.1, 3.8));
    assert!(
        (tone - 650.0).abs() < 25.0,
        "FLAC 44.1k variant at second 3: {tone}"
    );
    let frames = h.frames.presented.lock().unwrap().clone();
    let after: Vec<_> = frames.iter().filter(|f| f.at >= switched).collect();
    assert!(
        after.first().unwrap().index.abs_diff(90) <= 1,
        "variant reload resumes video at 3 s"
    );
    assert_eq!(h.engine.snapshot().video_decoders, 1, "one video decoder");
}

#[test]
#[ignore = "live GStreamer"]
fn signed_av_delay_holds_the_leading_stream() {
    for delay in [300i64, -300] {
        let mut h = Harness::start(ClockMode::System);
        let fixtures = fixtures();
        h.engine
            .command(Command::Settings(SettingsPatch {
                av_delay_ms: Some(delay),
                ..Default::default()
            }))
            .unwrap();
        load(&h, 1, &fixtures.aac, 0.0, true);
        h.wait(SHORT, "playing", is("playing"));
        std::thread::sleep(Duration::from_millis(1500));
        let frames = h.frames.presented.lock().unwrap().clone();
        // Frame 30 (1.0 s) vs. the PCM chunk containing 1.0 s.
        let video_at = frames.iter().find(|f| f.index == 30).expect("frame 30").at;
        let chunks = h.capture.chunks.lock().unwrap().clone();
        let audio_at = chunks
            .iter()
            .find(|c| c.pts_ns.is_some_and(|p| p >= 1_000_000_000))
            .expect("audio at 1 s")
            .at;
        let offset = audio_at.duration_since(video_at).as_secs_f64() * 1000.0
            - video_at.duration_since(audio_at).as_secs_f64() * 1000.0;
        assert!(
            (offset - delay as f64).abs() < 60.0,
            "delay {delay} ms produced audio-minus-video {offset:.1} ms"
        );
    }
}

#[test]
#[ignore = "live GStreamer"]
fn pause_intent_survives_paused_reloads_and_reports_software_decoders() {
    let mut h = Harness::start(ClockMode::AudioSink);
    let fixtures = fixtures();
    let p = program(1, "p1");
    load(&h, 1, &fixtures.aac, 1.0, false);
    h.wait(SHORT, "ready", is("ready"));
    h.drain(Duration::from_millis(800));
    assert!(
        !h.seen
            .iter()
            .any(|o| matches!(o.kind, ObservationKind::Playing)),
        "load with play=false stays paused"
    );
    let snapshot = h.engine.snapshot();
    assert!(
        snapshot
            .decoders
            .iter()
            .all(|d| !d.contains("nv") && !d.starts_with("va")),
        "{:?}",
        snapshot.decoders
    );
    assert!(
        snapshot.decoders.iter().any(|d| d == "avdec_h264"),
        "{:?}",
        snapshot.decoders
    );
    let position = snapshot.position.unwrap();
    assert!(
        (position - 1.0).abs() < 0.05,
        "paused at restore position: {position}"
    );
    h.engine
        .command(Command::Stop { program: p.clone() })
        .unwrap();
    h.wait(SHORT, "stopped", is("stopped"));
    assert!(
        *h.frames.clears.lock().unwrap() >= 1,
        "surface cleared on stop"
    );
}

#[test]
#[ignore = "live GStreamer"]
fn next_program_starts_without_process_restart_and_measures_gap() {
    let mut h = Harness::start(ClockMode::AudioSink);
    let fixtures = fixtures();
    let first = program(1, "p1");
    load(&h, 1, &fixtures.aac, 7.0, true);
    h.wait(SHORT, "first eos", |o| {
        o.program == first && matches!(o.kind, ObservationKind::Eos { .. })
    });
    let eos_at = Instant::now();
    load(&h, 2, &fixtures.aac, 0.0, true);
    h.wait(SHORT, "second playing", |o| {
        o.program.playback_generation == 2 && matches!(o.kind, ObservationKind::Playing)
    });
    std::thread::sleep(Duration::from_millis(400));
    let first_audio = h
        .pcm_after(eos_at)
        .into_iter()
        .find(|c| c.pts_ns.is_some_and(|p| p < 100_000_000))
        .expect("second program audio")
        .at;
    let gap = first_audio.duration_since(eos_at).as_secs_f64() * 1000.0;
    eprintln!("ENGINE_GAP_MS={gap:.1}");
    assert!(gap < 400.0, "EOS-to-next-audio gap {gap:.1} ms");
    assert_eq!(h.engine.snapshot().pipelines_created, 2);
}

/// Real PulseAudio sink in the shell configuration (system clock; the sink's
/// own virtual clock previously stopped after Pause/Seek/track changes).
/// Requires BILIKARA_TEST_PULSE_SERVER pointing at a private server.
#[test]
#[ignore = "live GStreamer + private PulseAudio"]
fn pulse_clock_survives_repeated_pause_seek_and_track_changes() {
    require_live();
    let server = std::env::var("BILIKARA_TEST_PULSE_SERVER")
        .expect("BILIKARA_TEST_PULSE_SERVER must name a private PulseAudio server");
    let fixtures = fixtures();
    let frames = std::sync::Arc::new(Frames::default());
    let (sender, receiver) = std::sync::mpsc::channel();
    let sender = std::sync::Mutex::new(sender);
    let engine = bilikara_media_engine::Engine::start(
        bilikara_media_engine::EngineConfig {
            audio: bilikara_media_engine::AudioOutput::Pulse {
                server: Some(server),
                device: None,
            },
            clock: ClockMode::System, // the shell configuration
            hardware_decoding: false,
        },
        frames.clone(),
        std::sync::Arc::new(move |o| {
            let _ = sender.lock().unwrap().send(o);
        }),
    )
    .unwrap();
    let mut seen = Vec::new();
    let mut wait =
        |what: &str, timeout: Duration, f: &dyn Fn(&bilikara_media_engine::Observation) -> bool| {
            let deadline = Instant::now() + timeout;
            loop {
                let o = receiver
                    .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                    .unwrap_or_else(|_| {
                        panic!(
                            "timeout waiting for {what}: {:#?}",
                            seen.iter().rev().take(10).collect::<Vec<_>>()
                        )
                    });
                seen.push(o.clone());
                if let ObservationKind::Error { .. } = o.kind {
                    panic!("engine error during {what}: {o:?}");
                }
                if f(&o) {
                    return o;
                }
            }
        };
    let mut generation = 0u64;
    for round in 0..6 {
        generation += 1;
        let p = program(generation, if round % 2 == 0 { "p1" } else { "p2" });
        let audio = if round % 2 == 0 {
            &fixtures.aac
        } else {
            &fixtures.flac
        };
        engine
            .command(Command::Load {
                program: p.clone(),
                media: media(audio),
                start_seconds: 1.0,
                play: true,
            })
            .unwrap();
        wait("playing", SHORT, &|o| {
            o.program == p && matches!(o.kind, ObservationKind::Playing)
        });
        for (pause, seek) in [(true, 3.0), (false, 5.0), (true, 2.5), (false, 6.6)] {
            if pause {
                engine
                    .command(Command::Pause { program: p.clone() })
                    .unwrap();
                std::thread::sleep(Duration::from_millis(120));
            }
            engine
                .command(Command::Seek {
                    program: p.clone(),
                    seconds: seek,
                    play: Some(true),
                })
                .unwrap();
            wait("seek settled", SHORT, &|o| {
                o.program == p && matches!(o.kind, ObservationKind::SeekSettled { .. })
            });
            // The pipeline clock must keep advancing after every recovery.
            let before = wait("position", SHORT, &|o| {
                o.program == p && matches!(o.kind, ObservationKind::Position)
            })
            .position
            .unwrap();
            let after = wait("advancing position", SHORT, &|o| {
                o.program == p
                    && matches!(o.kind, ObservationKind::Position)
                    && o.position.unwrap() > before + 0.2
            });
            assert!(after.position.unwrap() > before);
        }
        let eos = wait("drained eos", Duration::from_secs(8), &|o| {
            o.program == p && matches!(o.kind, ObservationKind::Eos { .. })
        });
        assert_eq!(
            eos.kind,
            ObservationKind::Eos {
                drained: true,
                watchdog: false
            },
            "round {round}"
        );
    }
    std::thread::sleep(Duration::from_millis(800));
    while let Ok(o) = receiver.try_recv() {
        seen.push(o);
    }
    for g in 1..=generation {
        let count = seen
            .iter()
            .filter(|o| {
                o.program.playback_generation == g && matches!(o.kind, ObservationKind::Eos { .. })
            })
            .count();
        assert_eq!(count, 1, "generation {g} completes exactly once");
    }
    let snapshot = engine.snapshot();
    assert_eq!(snapshot.audio_sink, "pulsesink");
    engine.shutdown();
}

fn play_loopback_http(h: &mut support::Harness, server: &HttpFixture) {
    let fixtures = fixtures();
    h.engine
        .command(Command::Load {
            program: program(1, "p1"),
            media: bilikara_media_engine::MediaSource {
                video_uri: server.url(&fixtures.video),
                audio_uri: server.url(&fixtures.aac),
                cookies: vec!["bilikara_native=fixture".into()],
            },
            start_seconds: 1.0,
            play: true,
        })
        .unwrap();
    h.wait(SHORT, "ready over loopback HTTP", is("ready"));
    h.wait(SHORT, "playing", is("playing"));
    h.wait(SHORT, "advancing position", |o| {
        o.position.is_some_and(|p| p > 1.4)
    });
}

/// Control: the Host's loopback media routes play over HTTP with ranges.
#[test]
#[ignore = "live GStreamer"]
fn loopback_http_sources_play_with_byte_ranges() {
    let server = HttpFixture::serve(fixtures().video.parent().unwrap());
    let mut h = Harness::start(ClockMode::System);
    play_loopback_http(&mut h, &server);
    assert!(server.requests.load(std::sync::atomic::Ordering::SeqCst) >= 2);
}

/// The engine only plays the Host's loopback media routes. A user's proxy
/// environment (common for GitHub access) must never redirect those requests:
/// GStreamer's HTTP source otherwise adopts `$http_proxy` and ignores `no_proxy`.
#[test]
#[ignore = "live GStreamer"]
fn loopback_http_sources_bypass_a_proxy_environment() {
    let fixtures = fixtures();
    let server = HttpFixture::serve(fixtures.video.parent().unwrap());
    const KEYS: [&str; 8] = [
        "http_proxy",
        "HTTP_PROXY",
        "https_proxy",
        "HTTPS_PROXY",
        "all_proxy",
        "ALL_PROXY",
        "no_proxy",
        "NO_PROXY",
    ];
    struct Restore;
    impl Drop for Restore {
        fn drop(&mut self) {
            for key in KEYS {
                std::env::remove_var(key);
            }
        }
    }
    let _restore = Restore;
    for key in &KEYS[..6] {
        // Port 9 (discard) is closed: any proxied request fails.
        std::env::set_var(key, "http://127.0.0.1:9");
    }
    // As applied by the desktop shell at startup (src-tauri/src/main.rs).
    std::env::set_var("no_proxy", bilikara_media_engine::loopback_no_proxy(None));
    std::env::remove_var("NO_PROXY");
    let mut h = Harness::start(ClockMode::System);
    play_loopback_http(&mut h, &server);
    assert!(
        server.requests.load(std::sync::atomic::Ordering::SeqCst) >= 2,
        "requests reached the loopback server directly"
    );
    assert!(
        !h.seen
            .iter()
            .any(|o| matches!(o.kind, ObservationKind::Error { .. })),
        "no source errors: {:?}",
        h.seen
            .iter()
            .filter(|o| matches!(o.kind, ObservationKind::Error { .. }))
            .collect::<Vec<_>>()
    );
}

/// Requirement 4.5: the pitch element reuses one persistent scratch buffer, so
/// steady-state processing performs no heap allocation. Prints the counters as
/// a reproducible measurement (`DSP_STEADY`).
#[test]
#[ignore = "live GStreamer"]
fn steady_state_pitch_processing_reuses_buffers() {
    let mut h = Harness::start(ClockMode::System);
    let fixtures = fixtures();
    h.engine
        .command(Command::Settings(SettingsPatch {
            key_shift: Some(3.0),
            ..Default::default()
        }))
        .unwrap();
    load(&h, 1, &fixtures.aac, 0.0, true);
    h.wait(SHORT, "playing", is("playing"));
    h.wait(SHORT, "1 s rendered", |o| {
        o.position.is_some_and(|p| p > 1.0)
    });
    let before = h.engine.snapshot().dsp;
    let started = Instant::now();
    std::thread::sleep(Duration::from_millis(2000));
    let after = h.engine.snapshot().dsp;
    let elapsed = started.elapsed().as_secs_f64();
    let n = |value: &serde_json::Value, key: &str| value[key].as_u64().unwrap();
    let frames = n(&after, "processed_frames") - n(&before, "processed_frames");
    let calls = n(&after, "process_calls") - n(&before, "process_calls");
    eprintln!(
        "DSP_STEADY seconds={elapsed:.2} frames={frames} calls={calls} allocations={} copied_bytes={} before={before} after={after}",
        n(&after, "allocations") - n(&before, "allocations"),
        n(&after, "copied_bytes") - n(&before, "copied_bytes"),
    );
    assert!(
        frames as f64 > 48_000.0 * elapsed * 0.8,
        "real-time processing: {frames} frames"
    );
    assert_eq!(
        n(&after, "allocations"),
        n(&before, "allocations"),
        "no steady-state heap allocation"
    );
    assert_eq!(
        n(&after, "resets"),
        n(&before, "resets"),
        "no DSP reset while playing"
    );
}

/// Starting playback after a paused preroll (the Host's countdown) must be
/// prompt: position reaches 0.5 s within 1.5 s of Play. A PulseAudio stream
/// opened during the preroll stalled the pipeline for the whole paused
/// duration (3.59 s after a 3 s preroll); the stream now opens at Play.
#[test]
#[ignore = "live GStreamer + private PulseAudio"]
fn pulse_play_after_paused_preroll_starts_promptly() {
    require_live();
    let clock = ClockMode::System;
    let server = std::env::var("BILIKARA_TEST_PULSE_SERVER")
        .expect("BILIKARA_TEST_PULSE_SERVER must name a private PulseAudio server");
    let fixtures = fixtures();
    let (sender, receiver) = std::sync::mpsc::channel();
    let sender = std::sync::Mutex::new(sender);
    let engine = bilikara_media_engine::Engine::start(
        bilikara_media_engine::EngineConfig {
            audio: bilikara_media_engine::AudioOutput::Pulse {
                server: Some(server),
                device: None,
            },
            clock,
            hardware_decoding: false,
        },
        std::sync::Arc::new(Frames::default()),
        std::sync::Arc::new(move |o| {
            let _ = sender.lock().unwrap().send(o);
        }),
    )
    .unwrap();
    let p = program(1, "p1");
    engine
        .command(Command::Load {
            program: p.clone(),
            media: media(&fixtures.aac),
            start_seconds: 0.0,
            play: false,
        })
        .unwrap();
    let wait = |what: &str, f: &dyn Fn(&bilikara_media_engine::Observation) -> bool| loop {
        let o = receiver
            .recv_timeout(SHORT)
            .unwrap_or_else(|_| panic!("timeout waiting for {what}"));
        if f(&o) {
            return o;
        }
    };
    wait("ready", &|o| matches!(o.kind, ObservationKind::Ready));
    std::thread::sleep(Duration::from_secs(3));
    let started = Instant::now();
    engine
        .command(Command::Play { program: p.clone() })
        .unwrap();
    wait("half a second rendered", &|o| {
        o.position.is_some_and(|x| x >= 0.5)
    });
    let elapsed = started.elapsed().as_secs_f64();
    eprintln!("PULSE_START_SECONDS={elapsed:.3}");
    assert!(
        elapsed < 1.5,
        "audio clock started {elapsed:.3} s after Play"
    );
    engine.shutdown();
}

/// A PulseAudio monitor recording whose frames carry the wall-clock instant at
/// which they reached the sink (arrival time minus the frames still to come).
struct Monitor {
    pipeline: gstreamer::Pipeline,
    frames: std::sync::Arc<std::sync::Mutex<Vec<(Instant, i16)>>>,
}

impl Monitor {
    fn start(server: &str, sink: &str) -> Self {
        use gstreamer::prelude::*;
        let pipeline = gstreamer::Pipeline::new();
        let source = gstreamer::ElementFactory::make("pulsesrc")
            .property("server", server)
            .property("device", format!("{sink}.monitor"))
            .property("buffer-time", 40_000i64)
            .property("latency-time", 10_000i64)
            .build()
            .expect("pulsesrc");
        let caps = gstreamer::Caps::builder("audio/x-raw")
            .field("format", "S16LE")
            .field("layout", "interleaved")
            .field("rate", 48_000i32)
            .field("channels", 2i32)
            .build();
        let appsink = gstreamer_app::AppSink::builder()
            .caps(&caps)
            .sync(false)
            .build();
        let frames = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink_frames = frames.clone();
        appsink.set_callbacks(
            gstreamer_app::AppSinkCallbacks::builder()
                .new_sample(move |appsink| {
                    let arrived = Instant::now();
                    let sample = appsink
                        .pull_sample()
                        .map_err(|_| gstreamer::FlowError::Eos)?;
                    let buffer = sample.buffer().ok_or(gstreamer::FlowError::Error)?;
                    let map = buffer
                        .map_readable()
                        .map_err(|_| gstreamer::FlowError::Error)?;
                    let left: Vec<i16> = map
                        .as_slice()
                        .chunks_exact(4)
                        .map(|f| i16::from_le_bytes([f[0], f[1]]))
                        .collect();
                    let n = left.len();
                    let mut frames = sink_frames.lock().unwrap();
                    for (j, value) in left.into_iter().enumerate() {
                        let ahead = Duration::from_secs_f64((n - j) as f64 / 48_000.0);
                        frames.push((arrived - ahead, value));
                    }
                    Ok(gstreamer::FlowSuccess::Ok)
                })
                .build(),
        );
        pipeline.add_many([&source, appsink.upcast_ref()]).unwrap();
        source.link(&appsink).unwrap();
        pipeline.set_state(gstreamer::State::Playing).unwrap();
        // Discard the source's start-up period.
        std::thread::sleep(Duration::from_millis(500));
        Monitor { pipeline, frames }
    }

    fn stop(self) -> Vec<(Instant, i16)> {
        use gstreamer::prelude::*;
        let _ = self.pipeline.set_state(gstreamer::State::Null);
        std::mem::take(&mut *self.frames.lock().unwrap())
    }
}

fn loud(value: i16) -> bool {
    value.unsigned_abs() > 1600
}

/// Seconds from `from` to the first audible frame (within `within`).
fn onset(frames: &[(Instant, i16)], from: Instant, within: Duration) -> Option<f64> {
    frames
        .iter()
        .filter(|(t, _)| *t >= from && *t < from + within)
        .find(|(_, v)| loud(*v))
        .map(|(t, _)| t.duration_since(from).as_secs_f64())
}

/// Longest run of silence (seconds) between `from` and `from + within`.
fn longest_silence(frames: &[(Instant, i16)], from: Instant, within: Duration) -> f64 {
    let window: Vec<&(Instant, i16)> = frames
        .iter()
        .filter(|(t, _)| *t >= from && *t < from + within)
        .collect();
    // 5 ms of consecutive near-zero samples counts as silence (a sine crosses
    // zero for a few samples only).
    let mut longest = 0usize;
    let mut run = 0usize;
    for (_, value) in &window {
        if value.unsigned_abs() < 200 {
            run += 1;
            longest = longest.max(run);
        } else {
            run = 0;
        }
    }
    if longest < 240 {
        0.0
    } else {
        longest as f64 / 48_000.0
    }
}

/// The fixture plays 300 + 100 * floor(t) Hz during second t of the track.
fn heard_second(frames: &[(Instant, i16)], at: Instant) -> Option<u32> {
    let half = Duration::from_millis(75);
    let samples: Vec<f64> = frames
        .iter()
        .filter(|(t, _)| *t >= at - half && *t < at + half)
        .map(|(_, v)| f64::from(*v))
        .collect();
    if samples.len() < 4_000 || !samples.iter().any(|v| v.abs() > 1600.0) {
        return None;
    }
    let power = |frequency: f64| {
        let k = 2.0 * (2.0 * std::f64::consts::PI * frequency / 48_000.0).cos();
        let (mut s1, mut s2) = (0.0f64, 0.0f64);
        for x in &samples {
            let s0 = x + k * s1 - s2;
            s2 = s1;
            s1 = s0;
        }
        s1 * s1 + s2 * s2 - k * s1 * s2
    };
    (0..13u32).max_by(|a, b| {
        power(f64::from(300 + 100 * a))
            .partial_cmp(&power(f64::from(300 + 100 * b)))
            .unwrap()
    })
}

/// What reaches the PulseAudio sink follows the engine: sound starts with Play
/// after a long paused preroll (the Host countdown), continues from the target
/// after a flushing seek, and resumes in place after a pause. Measured at the
/// sink with wall-clock-stamped monitor frames, not from reported positions.
#[test]
#[ignore = "live GStreamer + private PulseAudio"]
fn pulse_audio_follows_the_engine_through_preroll_seek_and_resume() {
    pulse_timeline(false);
}

/// The same timeline with the Host's loopback HTTP media routes as sources.
#[test]
#[ignore = "live GStreamer + private PulseAudio"]
fn pulse_audio_over_loopback_http_follows_the_engine() {
    pulse_timeline(true);
}

fn pulse_timeline(http: bool) {
    require_live();
    let server = std::env::var("BILIKARA_TEST_PULSE_SERVER")
        .expect("BILIKARA_TEST_PULSE_SERVER must name a private PulseAudio server");
    let sink = std::env::var("BILIKARA_TEST_PULSE_SINK").unwrap_or_else(|_| "bilikara_lab".into());
    let fixtures = fixtures();
    let (sender, receiver) = std::sync::mpsc::channel();
    let sender = std::sync::Mutex::new(sender);
    let engine = bilikara_media_engine::Engine::start(
        bilikara_media_engine::EngineConfig {
            audio: bilikara_media_engine::AudioOutput::Pulse {
                server: Some(server.clone()),
                device: None,
            },
            clock: ClockMode::System, // the shell configuration
            hardware_decoding: false,
        },
        std::sync::Arc::new(Frames::default()),
        std::sync::Arc::new(move |o| {
            let _ = sender.lock().unwrap().send(o);
        }),
    )
    .unwrap();
    let wait = |what: &str, f: &dyn Fn(&bilikara_media_engine::Observation) -> bool| loop {
        let o = receiver
            .recv_timeout(SHORT)
            .unwrap_or_else(|_| panic!("timeout waiting for {what}"));
        if f(&o) {
            return o;
        }
    };
    let monitor = Monitor::start(&server, &sink);
    let p = program(1, "p1");
    let http_server = http.then(|| HttpFixture::serve(fixtures.video.parent().unwrap()));
    let source = match &http_server {
        Some(served) => bilikara_media_engine::MediaSource {
            video_uri: served.url(&fixtures.video),
            audio_uri: served.url(&fixtures.aac),
            cookies: vec!["bilikara_native=fixture".into()],
        },
        None => media(&fixtures.aac),
    };
    engine
        .command(Command::Load {
            program: p.clone(),
            media: source,
            start_seconds: 0.0,
            play: false,
        })
        .unwrap();
    wait("ready", &|o| matches!(o.kind, ObservationKind::Ready));
    // The countdown: a long paused preroll.
    std::thread::sleep(Duration::from_secs(3));
    let played = Instant::now();
    engine
        .command(Command::Play { program: p.clone() })
        .unwrap();
    std::thread::sleep(Duration::from_millis(2_200));
    let seeked = Instant::now();
    engine
        .command(Command::Seek {
            program: p.clone(),
            seconds: 4.25,
            play: Some(true),
        })
        .unwrap();
    std::thread::sleep(Duration::from_millis(1_500));
    engine
        .command(Command::Pause { program: p.clone() })
        .unwrap();
    std::thread::sleep(Duration::from_secs(1));
    let resumed = Instant::now();
    engine
        .command(Command::Play { program: p.clone() })
        .unwrap();
    std::thread::sleep(Duration::from_millis(1_900));
    let frames = monitor.stop();
    engine.shutdown();

    let ms = Duration::from_millis;
    let start = onset(&frames, played, ms(3_000));
    let seek_gap = longest_silence(&frames, seeked, ms(1_000));
    let resume = onset(&frames, resumed, ms(1_500));
    let heard = [
        (played + ms(500), 0),
        (played + ms(1_500), 1),
        (seeked + ms(350), 4),
        (seeked + ms(1_100), 5),
        (resumed + ms(600), 6),
        (resumed + ms(1_550), 7),
    ]
    .map(|(at, expected)| (expected, heard_second(&frames, at)));
    eprintln!(
        "PULSE_TIMELINE http={http} start_onset={start:?} seek_gap={seek_gap:.3} resume_onset={resume:?} heard={heard:?}"
    );
    let start = start.expect("sound after Play");
    assert!(start < 0.3, "sound began {start:.3} s after Play");
    assert!(seek_gap < 0.3, "{seek_gap:.3} s of silence after the seek");
    let resume = resume.expect("sound after resuming");
    assert!(resume < 0.3, "sound resumed {resume:.3} s after Play");
    for (expected, heard) in heard {
        assert_eq!(heard, Some(expected), "track second heard at the sink");
    }
}
