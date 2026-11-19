//! Trusted stdin experiment, never a product transport or a queue authority.
use gst::glib::translate::ToGlibPtr;
use gstreamer::{self as gst, prelude::*};
use serde_json::{json, Value};
mod playbin_probe;
mod surface;
use std::{
    io::{self, BufRead},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};
unsafe extern "C" {
    fn bm_stretch_new_v1() -> *mut std::ffi::c_void;
    fn bm_stretch_free_v1(v: *mut std::ffi::c_void);
    fn bm_stretch_latency_v1(v: *mut std::ffi::c_void) -> u32;
    fn bm_stretch_process_v1(
        v: *mut std::ffi::c_void,
        input: *const f32,
        ni: u32,
        output: *mut f32,
        no: u32,
        key: f32,
    ) -> i32;
}
struct Dsp {
    voice: *mut std::ffi::c_void,
    key: f32,
    latency: u32,
    end: Option<gst::ClockTime>,
    chunks: u64,
    explicit_copy_bytes: u64,
    processed_frames: u64,
}
// One mutex owns this processor; no native pointer crosses the domain API.
unsafe impl Send for Dsp {}
impl Dsp {
    fn new() -> Self {
        let voice = unsafe { bm_stretch_new_v1() };
        assert!(!voice.is_null());
        Self {
            voice,
            key: 0.,
            latency: unsafe { bm_stretch_latency_v1(voice) },
            end: None,
            chunks: 0,
            explicit_copy_bytes: 0,
            processed_frames: 0,
        }
    }
    fn process(&mut self, bytes: &mut [u8]) {
        assert_eq!(bytes.len() % 8, 0);
        for chunk in bytes.chunks_mut(4096 * 8) {
            self.chunks += 1;
            self.explicit_copy_bytes += chunk.len() as u64 * 2;
            self.processed_frames += chunk.len() as u64 / 8;
            let input: Vec<f32> = chunk
                .chunks_exact(4)
                .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
                .collect();
            let mut output = vec![0f32; input.len()];
            let n = (input.len() / 2) as u32;
            assert_eq!(
                unsafe {
                    bm_stretch_process_v1(
                        self.voice,
                        input.as_ptr(),
                        n,
                        output.as_mut_ptr(),
                        n,
                        self.key,
                    )
                },
                0
            );
            for (b, v) in chunk.chunks_exact_mut(4).zip(output) {
                b.copy_from_slice(&v.to_le_bytes());
            }
        }
    }
    fn reset(&mut self) {
        let key = self.key;
        let counters = (self.chunks, self.explicit_copy_bytes, self.processed_frames);
        *self = Self::new();
        self.key = key;
        (self.chunks, self.explicit_copy_bytes, self.processed_frames) = counters;
    }
}
impl Drop for Dsp {
    fn drop(&mut self) {
        unsafe { bm_stretch_free_v1(self.voice) }
    }
}
fn emit(v: Value) {
    println!("{v}");
}
fn error_facts(error: &gst::glib::Error) -> Value {
    let pointer: *mut gst::glib::ffi::GError = error.to_glib_none().0;
    json!({"domain":error.domain().as_str().to_string(),"code":unsafe{(*pointer).code}})
}
fn start_element(element: &gst::Element, bus: &gst::Bus) -> bool {
    if element.set_state(gst::State::Playing).is_ok() {
        return true;
    }
    if let Some(message) = bus.timed_pop_filtered(
        gst::ClockTime::from_mseconds(100),
        &[gst::MessageType::Error],
    ) {
        if let gst::MessageView::Error(error) = message.view() {
            emit(json!({"type":"error","code":"startup","details":error_facts(&error.error())}));
        }
    }
    emit(json!({"type":"error","code":"state-change-failed"}));
    let _ = element.set_state(gst::State::Null);
    false
}
// A flush gives an explicit timeline a new GStreamer sequence number. A
// terminal message can already be on the bus when the next command is read.
fn flush_to(
    video: &gst::Element,
    audio: &gst::Element,
    position: gst::ClockTime,
) -> Option<gst::Seqnum> {
    let event = gst::event::Seek::new(
        1.,
        gst::SeekFlags::FLUSH | gst::SeekFlags::ACCURATE,
        gst::SeekType::Set,
        position,
        gst::SeekType::None,
        gst::ClockTime::NONE,
    );
    let seqnum = event.seqnum();
    // Sending to the whole pipeline also seeks from the PCM monitor. Its
    // tee branch reaches the same audio sources and flushes them twice.
    let audio_accepted = audio.send_event(event.clone());
    let video_accepted = video.send_event(event);
    let accepted = audio_accepted && video_accepted;
    emit(
        json!({"type":"seek-inputs","seqnum":format!("{seqnum:?}"),"position_ns":position.nseconds(),"accepted":accepted}),
    );
    accepted.then_some(seqnum)
}

fn extend_audio_segment(event: &gst::EventRef, latency: gst::ClockTime) -> Option<gst::Event> {
    let gst::EventView::Segment(segment) = event.view() else {
        return None;
    };
    let mut segment = segment.segment().downcast_ref::<gst::ClockTime>()?.clone();
    // A finite input segment can end before the DSP's last output samples.
    // Allow the drain at the sink without changing the start or running time.
    segment.set_stop(segment.stop()?.checked_add(latency)?);
    let mut extended = gst::event::Segment::builder(&segment)
        .seqnum(event.seqnum())
        .build();
    extended
        .get_mut()
        .unwrap()
        .set_running_time_offset(event.running_time_offset());
    Some(extended)
}

fn element(factory: &str, name: &str) -> gst::Element {
    gst::ElementFactory::make(factory)
        .name(name)
        .build()
        .expect("prototype plugin unavailable")
}
fn uri(path: &str) -> String {
    gst::glib::filename_to_uri(path, None)
        .expect("absolute fixture path")
        .to_string()
}
fn same(a: &Value, b: &Value) -> bool {
    [
        "playback_generation",
        "item_id",
        "item_incarnation_id",
        "selected_audio_variant_id",
        "artifact_set_id",
    ]
    .iter()
    .all(|k| a[*k] == b[*k])
}
fn valid(p: &Value) -> bool {
    p["playback_generation"].as_u64().is_some_and(|n| n > 0)
        && [
            "item_id",
            "item_incarnation_id",
            "selected_audio_variant_id",
            "artifact_set_id",
        ]
        .iter()
        .all(|k| p[*k].as_str().is_some_and(|s| !s.is_empty()))
}
fn source(p: &gst::Pipeline, path: &str, kind: &'static str, target: &gst::Element, name: &str) {
    let decode = element("uridecodebin", name);
    decode.set_property("uri", uri(path));
    p.add(&decode).unwrap();
    let target = target.clone();
    decode.connect_pad_added(move |decode, pad| {
        let caps = pad.current_caps().unwrap_or_else(|| pad.query_caps(None));
        if caps
            .structure(0)
            .is_some_and(|s| s.name().starts_with(kind))
        {
            let sink = target.static_pad("sink").unwrap();
            if !sink.is_linked() {
                let input = decode.name();
                pad.add_probe(gst::PadProbeType::EVENT_UPSTREAM, move |_, info| {
                    if let Some(event) = info.event() {
                        if matches!(event.view(), gst::EventView::Seek(_)) {
                            emit(json!({"type":"source-seek","input":input.as_str(),
                                "seqnum":format!("{:?}",event.seqnum())}));
                        }
                    }
                    gst::PadProbeReturn::Ok
                });
                pad.link(&sink).unwrap();
            }
        }
    });
}
fn main() -> std::process::ExitCode {
    surface::initialize_threads();
    gst::init().expect("isolated SDK required");
    let args: Vec<String> = std::env::args().collect();
    assert!(
        [2, 3].contains(&args.len()),
        "Usage: poc MANIFEST [--playbin3-probe]"
    );
    let manifest: Value = serde_json::from_slice(&std::fs::read(&args[1]).unwrap()).unwrap();
    let mut program = manifest["program"].clone();
    assert!(valid(&program));
    let p = gst::Pipeline::new();
    let vs = element("ximagesink", "visible-video");
    vs.set_property("sync", true);
    vs.set_property("qos", true);
    vs.set_property("enable-last-sample", false);
    let audio = element("pulsesink", "actual-audio");
    audio.set_property("sync", true);
    if let Some(s) = manifest["pulse_server"].as_str() {
        audio.set_property("server", s);
    }
    if let Some(s) = manifest["pulse_device"].as_str() {
        audio.set_property("device", s);
    }
    if args.len() == 3 {
        assert_eq!(args[2], "--playbin3-probe");
        return playbin_probe::run(&manifest, &vs, &audio);
    }
    // The virtual PulseAudio sink clock can stall after an accurate flush.
    // Keep the default and offer a controlled clock-only A/B experiment.
    match manifest["diagnostic_clock"].as_str() {
        None | Some("sink") => {}
        Some("system") => p.use_clock(Some(&gst::SystemClock::obtain())),
        _ => panic!("unsupported diagnostic clock"),
    }
    let replay_eos = manifest["diagnostic_replay_eos"].as_bool() == Some(true);
    let vq = element("queue", "video-queue");
    let vc = element("videoconvert", "video-convert");
    let scale = element("videoscale", "audience-scale");
    // Let ximagesink negotiate the new drawable with videoscale. Forcing new
    // caps separately from the window switch can reject frames in flight.
    let mut surfaces = surface::Surfaces::new();
    assert!(surfaces.attach(&vs, "audience"), "initial native surface");
    let sel = element("input-selector", "track-selector");
    sel.set_property("sync-streams", true);
    sel.set_property_from_str("sync-mode", "clock");
    sel.set_property("cache-buffers", true);
    let pcm_caps = gst::Caps::builder("audio/x-raw")
        .field("format", "F32LE")
        .field("layout", "interleaved")
        .field("rate", 48000i32)
        .field("channels", 2i32)
        .build();
    let filter = element("identity", "signalsmith");
    let volume = element("volume", "gain");
    let tee = element("tee", "observer-tee");
    let aq = element("queue", "audio-output-queue");
    let mq = element("queue", "monitor-queue");
    mq.set_property("max-size-buffers", 4u32);
    mq.set_property_from_str("leaky", "downstream");
    let monitor = gstreamer_app::AppSink::builder()
        .name("pcm-monitor")
        .sync(false)
        .async_(false)
        .max_buffers(4)
        .drop(true)
        .build();
    p.add_many([
        &vq,
        &vc,
        &scale,
        &vs,
        &sel,
        &filter,
        &volume,
        &tee,
        &aq,
        &audio,
        &mq,
        monitor.upcast_ref(),
    ])
    .unwrap();
    gst::Element::link_many([&vq, &scale, &vc, &vs]).unwrap();
    gst::Element::link_many([&sel, &filter, &volume, &tee]).unwrap();
    gst::Element::link_many([&tee, &aq, &audio]).unwrap();
    gst::Element::link_many([&tee, &mq, monitor.upcast_ref()]).unwrap();
    source(
        &p,
        manifest["video"].as_str().unwrap(),
        "video/",
        &vq,
        "video-input",
    );
    let mut tracks = Vec::new();
    for (i, path) in manifest["audio"].as_array().unwrap().iter().enumerate() {
        let q = element("queue", &format!("track-{i}"));
        // Decoders can expose different sample rates and formats. Normalize
        // before switching pads so the active DSP/sink chain keeps one format.
        let convert = element("audioconvert", &format!("track-convert-{i}"));
        let resample = element("audioresample", &format!("track-resample-{i}"));
        let caps = element("capsfilter", &format!("track-format-{i}"));
        caps.set_property("caps", &pcm_caps);
        p.add_many([&q, &convert, &resample, &caps]).unwrap();
        gst::Element::link_many([&q, &convert, &resample, &caps]).unwrap();
        let pad = sel.request_pad_simple("sink_%u").unwrap();
        caps.static_pad("src").unwrap().link(&pad).unwrap();
        pad.add_probe(gst::PadProbeType::EVENT_DOWNSTREAM, move |_, info| {
            if let Some(event) = info.event() {
                if matches!(event.view(), gst::EventView::Eos(_)) {
                    emit(json!({"type":"track-eos-event","index":i,
                        "seqnum":format!("{:?}",event.seqnum())}));
                }
            }
            gst::PadProbeReturn::Ok
        });
        tracks.push(pad);
        source(
            &p,
            path.as_str().unwrap(),
            "audio/",
            &q,
            &format!("audio-input-{i}"),
        );
    }
    sel.set_property("active-pad", &tracks[0]);
    let dsp = Arc::new(Mutex::new(Dsp::new()));
    let initial_key = manifest["initial_key_shift"].as_f64().unwrap_or(0.);
    assert!(initial_key.is_finite() && initial_key.abs() <= 6.);
    dsp.lock().unwrap().key = initial_key as f32;
    let failed_drain = Arc::new(AtomicBool::new(false));
    let probe_failed_drain = failed_drain.clone();
    let probe = dsp.clone();
    let output = filter.static_pad("src").unwrap();
    let latency_ns = u64::from(dsp.lock().unwrap().latency) * 1_000_000_000 / 48000;
    output.add_probe(gst::PadProbeType::EVENT_DOWNSTREAM, move |_, info| {
        if let Some(event) = info.event_mut() {
            if let Some(extended) =
                extend_audio_segment(event, gst::ClockTime::from_nseconds(latency_ns))
            {
                *event = extended;
            }
        }
        gst::PadProbeReturn::Ok
    });
    // Always-on DSP has fixed, explicitly measured latency. Sink offsets use
    // that latency plus signed user delay on ONE pipeline clock.
    vs.set_property("ts-offset", latency_ns as i64);
    let initial_delay = manifest["initial_delay_ms"].as_i64().unwrap_or(0);
    assert!(initial_delay.unsigned_abs() <= 1000);
    audio.set_property("ts-offset", initial_delay.max(0) * 1_000_000);
    vs.set_property(
        "ts-offset",
        latency_ns as i64 + (-initial_delay).max(0) * 1_000_000,
    );
    filter.static_pad("sink").unwrap().add_probe(
        gst::PadProbeType::BUFFER
            | gst::PadProbeType::EVENT_DOWNSTREAM
            | gst::PadProbeType::EVENT_FLUSH,
        move |_, info| {
            if let Some(buffer) = info.buffer_mut() {
                let mut dsp = probe.lock().unwrap();
                let b = buffer.make_mut();
                dsp.end = b.pts().zip(b.duration()).map(|(p, d)| p + d);
                dsp.process(b.map_writable().unwrap().as_mut_slice());
            } else if let Some(event) = info.event() {
                match event.view() {
                    gst::EventView::FlushStop(_) => probe.lock().unwrap().reset(),
                    gst::EventView::Eos(_) => {
                        let mut d = probe.lock().unwrap();
                        if let Some(pts) = d.end {
                            emit(json!({"type":"dsp-tail","pts_ns":pts.nseconds(),"duration_ns":latency_ns}));
                            let mut tail = gst::Buffer::with_size(d.latency as usize * 8).unwrap();
                            {
                                let b = tail.get_mut().unwrap();
                                b.set_pts(pts);
                                b.set_duration(gst::ClockTime::from_nseconds(latency_ns));
                                let mut map = b.map_writable().unwrap();
                                map.as_mut_slice().fill(0);
                                d.process(map.as_mut_slice());
                            }
                            if let Err(error) = output.push(tail) {
                                if error == gst::FlowError::Flushing {
                                    emit(json!({"type":"eos-cancelled","reason":"flushing"}));
                                } else {
                                    emit(json!({"type":"error","code":"dsp-tail-push","flow":format!("{error:?}")}));
                                    probe_failed_drain.store(true,Ordering::Relaxed);
                                }
                                // A cancelled/failed tail is never a successful
                                // EOS acknowledgement. Flush/retirement owns it.
                                return gst::PadProbeReturn::Drop;
                            }
                        }
                    }
                    _ => {}
                }
            }
            gst::PadProbeReturn::Ok
        },
    );
    let (tx, rx) = mpsc::sync_channel(32);
    std::thread::spawn(move || {
        for line in io::stdin().lock().lines() {
            match line {
                Ok(s) if s.len() < 16384 => {
                    if tx
                        .send(serde_json::from_str::<Value>(&s).unwrap_or(Value::Null))
                        .is_err()
                    {
                        break;
                    }
                }
                _ => break,
            }
        }
    });
    for (name, sink) in [("video", &vs), ("audio", &audio)] {
        sink.static_pad("sink").unwrap().add_probe(gst::PadProbeType::EVENT_DOWNSTREAM, move |_,info| {
            if let Some(event)=info.event() {
                match event.view() {
                    gst::EventView::Segment(e)=>{
                        if let Some(s)=e.segment().downcast_ref::<gst::ClockTime>() {
                            emit(json!({"type":"sink-segment","sink":name,"start_ns":s.start().map(|t|t.nseconds()),"stop_ns":s.stop().map(|t|t.nseconds()),"time_ns":s.time().map(|t|t.nseconds()),"base_ns":s.base().map(|t|t.nseconds()),"seqnum":format!("{:?}",event.seqnum())}));
                        }
                    },
                    gst::EventView::Eos(_)=>emit(json!({"type":"sink-eos-event","sink":name,"seqnum":format!("{:?}",event.seqnum())})),
                    _=>{}
                }
            }
            gst::PadProbeReturn::Ok
        });
    }
    let bus = p.bus().unwrap();
    let start = Instant::now();
    let mut sample_at = Instant::now();
    let mut decoders = false;
    let mut eos = false;
    let mut exit = false;
    let mut failed = false;
    let mut intended_playing = true;
    let mut seek_segment = None;
    let mut last_drained_eos: Option<gst::Message> = None;
    let mut pcm_frames = 0u64;
    let mut peak = 0f32;
    if !start_element(p.upcast_ref(), &bus) {
        return std::process::ExitCode::FAILURE;
    }
    emit(
        json!({"type":"created","version":gst::version_string().to_string(),"program":program,"dsp_latency_samples":dsp.lock().unwrap().latency,"audio_sink":"pulsesink","video_sink":"ximagesink"}),
    );
    let diagnostic_max_seconds = manifest["diagnostic_max_seconds"].as_u64().unwrap_or(1800);
    assert!((10..=7500).contains(&diagnostic_max_seconds));
    while !exit
        && !failed_drain.load(Ordering::Relaxed)
        && start.elapsed() < Duration::from_secs(diagnostic_max_seconds)
    {
        loop {
            let c = match rx.try_recv() {
                Ok(command) => command,
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => {
                    exit = true;
                    break;
                }
            };
            let action = c["action"].as_str().unwrap_or("");
            if !same(&c["expected_program"], &program) {
                emit(json!({"type":"rejected","reason":"stale-program","seq":c["seq"]}));
                continue;
            }
            let mut ok = true;
            let previous_clock = p.clock();
            match action {
                "play" => {
                    intended_playing = true;
                    p.set_state(gst::State::Playing).unwrap();
                }
                "pause" => {
                    intended_playing = false;
                    p.set_state(gst::State::Paused).unwrap();
                }
                "seek" => {
                    if let Some(seconds) =
                        c["seconds"].as_f64().filter(|s| s.is_finite() && *s >= 0.)
                    {
                        let position = gst::ClockTime::from_nseconds((seconds * 1e9) as u64);
                        if let Some(seqnum) = flush_to(&vs, &audio, position) {
                            seek_segment = Some(seqnum);
                            eos = false;
                        } else {
                            ok = false;
                        }
                    } else {
                        ok = false;
                    }
                }
                "volume" => {
                    if let Some(g) = c["gain"]
                        .as_f64()
                        .filter(|v| v.is_finite() && *v >= 0. && *v <= 5.)
                    {
                        volume.set_property("volume", g);
                        volume.set_property("mute", c["muted"].as_bool().unwrap_or(false));
                    } else {
                        ok = false;
                    }
                }
                "pitch" => {
                    if let Some(k) = c["semitones"]
                        .as_f64()
                        .filter(|v| v.is_finite() && v.abs() <= 6.)
                    {
                        dsp.lock().unwrap().key = k as f32;
                    } else {
                        ok = false;
                    }
                }
                "delay" => {
                    if let Some(d) = c["milliseconds"]
                        .as_i64()
                        .filter(|d| d.unsigned_abs() <= 1000)
                    {
                        audio.set_property("ts-offset", d.max(0) * 1_000_000);
                        vs.set_property("ts-offset", latency_ns as i64 + (-d).max(0) * 1_000_000);
                    } else {
                        ok = false;
                    }
                }
                "track" => {
                    let next = &c["program"];
                    let index = c["index"].as_u64().unwrap_or(u64::MAX) as usize;
                    if index < tracks.len()
                        && valid(next)
                        && next["playback_generation"].as_u64()
                            > program["playback_generation"].as_u64()
                        && ["item_id", "item_incarnation_id", "artifact_set_id"]
                            .iter()
                            .all(|k| next[*k] == program[*k])
                    {
                        // The pipeline query can pick the non-synchronized
                        // monitor's decode-ahead position. Preserve the visible
                        // sink's media time when selecting the new program.
                        if let Some(position) = vs.query_position::<gst::ClockTime>() {
                            // Selection alone gives the replacement program no
                            // new segment identity. Flush at its current media
                            // position so queued EOS and DSP tails stay retired.
                            sel.set_property("active-pad", &tracks[index]);
                            if let Some(seqnum) = flush_to(&vs, &audio, position) {
                                seek_segment = Some(seqnum);
                                program = next.clone();
                                eos = false;
                            } else {
                                // A partial rebind cannot keep owning playback
                                // as the previous program.
                                emit(json!({"type":"error","code":"track-flush-failed"}));
                                ok = false;
                                failed = true;
                                exit = true;
                            }
                        } else {
                            ok = false;
                        }
                    } else {
                        ok = false;
                    }
                }
                "surface" => {
                    ok = surfaces.attach(&vs, c["surfaceToken"].as_str().unwrap_or(""));
                }
                "surfaceProbe" => emit(
                    json!({"type":"surface-observation","seq":c["seq"],"colors":if c["timecodeOnly"].as_bool().unwrap_or(false){None}else{Some(surfaces.visible_colors())},"timecode_frame":surfaces.timecode_frame(),"at_ms":start.elapsed().as_millis()}),
                ),
                "diagnosticClockLost" => {
                    ok = p.clock().is_some_and(|clock| {
                        bus.post(gst::message::ClockLost::builder(&clock).src(&p).build())
                            .is_ok()
                    });
                }
                "diagnosticReplayEos" if replay_eos => {
                    ok = last_drained_eos
                        .as_ref()
                        .is_some_and(|message| bus.post(message.clone()).is_ok());
                }
                "stop" => exit = true,
                _ => ok = false,
            }
            emit(
                json!({"type":"command","seq":c["seq"],"action":action,"accepted":ok,"program":program,
                "clock_preserved":previous_clock==p.clock()}),
            );
            if exit {
                break;
            }
        }
        if let Some(m) = bus.timed_pop(gst::ClockTime::from_mseconds(10)) {
            match m.view() {
                gst::MessageView::Error(e) => {
                    emit(
                        json!({"type":"error","details":error_facts(&e.error()),"source":m.src().map(|s|s.name().to_string())}),
                    );
                    failed = true;
                    exit = true;
                }
                gst::MessageView::Warning(w) => {
                    emit(json!({"type":"warning","details":error_facts(&w.error())}))
                }
                gst::MessageView::NewClock(c) => emit(
                    json!({"type":"clock","name":c.clock().map(|clock|clock.name().to_string())}),
                ),
                gst::MessageView::ClockLost(_) => {
                    emit(json!({"type":"clock-lost"}));
                    p.set_state(gst::State::Paused).unwrap();
                    if intended_playing {
                        p.set_state(gst::State::Playing).unwrap();
                    }
                }
                gst::MessageView::Latency(_) => {
                    if p.recalculate_latency().is_err() {
                        emit(json!({"type":"error","code":"latency-recalculation-failed"}));
                        failed = true;
                        exit = true;
                    }
                }
                gst::MessageView::Eos(_) => {
                    let message_seqnum = m.seqnum();
                    let reason = if seek_segment.is_some_and(|active| active != message_seqnum) {
                        Some("stale-segment")
                    } else if eos {
                        Some("duplicate")
                    } else {
                        None
                    };
                    if let Some(reason) = reason {
                        emit(json!({"type":"eos-ignored","reason":reason,
                            "message_seqnum":format!("{message_seqnum:?}"),
                            "seek_seqnum":seek_segment.map(|s|format!("{s:?}"))}));
                    } else {
                        eos = true;
                        intended_playing = false;
                        if replay_eos {
                            last_drained_eos = Some(m.clone());
                        }
                        emit(json!({"type":"eos","program":program,"drained":true,
                            "message_seqnum":format!("{message_seqnum:?}"),
                            "seek_seqnum":seek_segment.map(|s|format!("{s:?}"))}));
                    }
                }
                gst::MessageView::AsyncDone(_) => {
                    emit(json!({"type":"async-done","at_ms":start.elapsed().as_millis()}))
                }
                _ => {}
            }
        }
        while let Some(s) = monitor.try_pull_sample(gst::ClockTime::ZERO) {
            if let Some(b) = s.buffer() {
                if let Ok(map) = b.map_readable() {
                    pcm_frames += (map.size() / 8) as u64;
                    for v in map.as_slice().chunks_exact(4) {
                        peak = peak.max(f32::from_le_bytes(v.try_into().unwrap()).abs());
                    }
                }
            }
        }
        if sample_at.elapsed() > Duration::from_millis(500) {
            {
                let d = dsp.lock().unwrap();
                emit(
                    json!({"type":"dsp-work","at_ms":start.elapsed().as_millis(),"chunks":d.chunks,"minimum_vector_allocations":d.chunks*2,"explicit_copy_bytes":d.explicit_copy_bytes,"processed_frames":d.processed_frames,"note":"excludes Gst buffer copies, allocator capacity and sink conversion"}),
                );
            }
            let position = p.query_position::<gst::ClockTime>().map(|t| t.nseconds());
            let video_position = vs.query_position::<gst::ClockTime>().map(|t| t.nseconds());
            let video_stats = vs.property::<gst::Structure>("stats");
            emit(
                json!({"type":"sample","at_ms":start.elapsed().as_millis(),"position_ns":position,
                    "video_position_ns":video_position,"video_rendered":video_stats.get::<u64>("rendered").ok(),
                    "seek_seqnum":seek_segment.map(|s|format!("{s:?}")),
                    "state":format!("{:?}",p.current_state()),"eos":eos,"video_stats":format!("{video_stats:?}"),
                    "audio_stats":format!("{:?}",audio.property::<gst::Structure>("stats")),
                    "audio_offset_ns":audio.property::<i64>("ts-offset"),"video_offset_ns":vs.property::<i64>("ts-offset"),
                    "pcm_frames":pcm_frames,"pcm_peak":peak,"clock_time_ns":p.clock().and_then(|c|c.time()).map(|t|t.nseconds()),
                    "base_time_ns":p.base_time().map(|t|t.nseconds())}),
            );
            if !decoders && position.is_some_and(|v| v > 500_000_000) {
                let factories: Vec<_> = p
                    .iterate_recurse()
                    .into_iter()
                    .filter_map(Result::ok)
                    .filter_map(|e| e.factory())
                    .filter(|f| f.klass().contains("Decoder"))
                    .map(|f| f.name().to_string())
                    .collect();
                let video_decoder_count = factories
                    .iter()
                    .filter(|name| {
                        gst::ElementFactory::find(name).is_some_and(|factory| {
                            factory.klass().contains("Decoder") && factory.klass().contains("Video")
                        })
                    })
                    .count();
                emit(
                    json!({"type":"decoders","factories":factories,"video_decoder_count":video_decoder_count,
                    "video_caps":vs.static_pad("sink").and_then(|p|p.current_caps()).map(|c|c.to_string()),
                    "audio_caps":audio.static_pad("sink").and_then(|p|p.current_caps()).map(|c|c.to_string())}),
                );
                decoders = true;
            }
            sample_at = Instant::now();
        }
    }
    p.set_state(gst::State::Null).unwrap();
    emit(json!({"type":"disposed"}));
    if failed || failed_drain.load(Ordering::Relaxed) {
        std::process::ExitCode::FAILURE
    } else {
        std::process::ExitCode::SUCCESS
    }
}

#[cfg(test)]
mod tests {
    use super::Dsp;
    fn energy(bytes: &[u8]) -> f64 {
        let samples: Vec<_> = bytes
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
            .collect();
        assert!(samples.iter().all(|s| s.is_finite() && s.abs() < 0.5));
        (samples.iter().map(|s| f64::from(*s).powi(2)).sum::<f64>() / samples.len() as f64).sqrt()
    }
    #[test]
    fn actual_signalsmith_tail_preserves_final_input_and_flush_discards_old_pcm() {
        let mut dsp = Dsp::new();
        dsp.key = 2.;
        let mut input = vec![0u8; 24000 * 8];
        // Only the END contains tone. It must emerge from the zero-fed tail;
        // observing an earlier tone cannot make this test pass.
        for frame in 20000..24000 {
            let value = 0.125 * (std::f32::consts::TAU * 440. * frame as f32 / 48000.).sin();
            for channel in 0..2 {
                input[frame * 8 + channel * 4..frame * 8 + channel * 4 + 4]
                    .copy_from_slice(&value.to_le_bytes());
            }
        }
        dsp.process(&mut input);
        assert!(energy(&input) < 0.01);
        let mut tail = vec![0u8; dsp.latency as usize * 8];
        dsp.process(&mut tail);
        assert!(
            energy(&tail) > 0.02,
            "last input samples must survive DSP drain"
        );
        let count = dsp.processed_frames;
        dsp.reset();
        assert_eq!(dsp.key, 2.);
        assert_eq!(dsp.processed_frames, count);
        let mut silence = vec![0u8; dsp.latency as usize * 16];
        dsp.process(&mut silence);
        assert!(
            energy(&silence) < 1e-6,
            "flush must not leak the previous track's PCM"
        );
    }
}
