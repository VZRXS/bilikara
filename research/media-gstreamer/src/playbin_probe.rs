//! Capability experiment, not an alternative product player. `suburi` is
//! subtitle-named; the SDK's auxiliary-input behavior must be observed, not
//! assumed to be a general dynamic audio-file replacement API.
use super::{element, emit, error_facts, uri, Dsp};
use gstreamer::{self as gst, prelude::*};
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

fn segment_mapping(
    segment: &Mutex<Option<gst::FormattedSegment<gst::ClockTime>>>,
    pts: u64,
) -> Value {
    let value = segment.lock().unwrap();
    value.as_ref().map_or(Value::Null,|s|json!({"start_ns":s.start().map(|t|t.nseconds()),"time_ns":s.time().map(|t|t.nseconds()),"base_ns":s.base().map(|t|t.nseconds()),"stream_time_ns":if pts==u64::MAX{None}else{s.to_stream_time(gst::ClockTime::from_nseconds(pts)).map(|t|t.nseconds())}}))
}

pub fn run(manifest: &Value, vs: &gst::Element, audio: &gst::Element) -> std::process::ExitCode {
    let mut failed = false;
    for (case, auxiliary, muxed) in [
        ("video-only-control", None, false),
        ("independent-aac", Some(0), false),
        ("independent-flac-restored", Some(1), false),
        ("independent-coded-restored", Some(1), false),
        ("collection-selection", None, true),
    ] {
        if muxed && manifest["collection_fixture"].as_str().is_none() {
            emit(
                json!({"type":"playbin3-case","case":case,"status":"NOT RUN","reason":"two-audio container fixture missing"}),
            );
            failed = true;
            continue;
        }
        let player = element("playbin3", "playbin3-evaluation")
            .downcast::<gst::Pipeline>()
            .unwrap();
        let coded = case == "independent-coded-restored";
        if coded && manifest["timing_video"].as_str().is_none() {
            emit(json!({"type":"playbin3-case","case":case,"status":"NOT RUN"}));
            failed = true;
            continue;
        }
        let input = if coded {
            manifest["timing_video"].as_str().unwrap()
        } else if muxed {
            manifest["collection_fixture"].as_str().unwrap()
        } else {
            manifest["video"].as_str().unwrap()
        };
        player.set_property("uri", uri(input));
        if let Some(index) = auxiliary {
            player.set_property(
                "suburi",
                uri(if coded {
                    manifest["timing_audio"].as_str().unwrap()
                } else {
                    manifest["audio"][index].as_str().unwrap()
                }),
            );
        }
        player.set_property("video-sink", vs);
        player.set_property("audio-sink", audio);
        // Real pinned DSP in a supported audio-filter bin. Its latency still
        // needs explicit mapping; the test doesn't confuse attachment with
        // sample-accurate dynamic latency/continuous-track qualification.
        let bin = gst::Bin::new();
        let convert = element("audioconvert", "probe-convert");
        let resample = element("audioresample", "probe-resample");
        let caps = element("capsfilter", "probe-format");
        caps.set_property(
            "caps",
            gst::Caps::builder("audio/x-raw")
                .field("format", "F32LE")
                .field("rate", 48000i32)
                .field("channels", 2i32)
                .field("layout", "interleaved")
                .build(),
        );
        let filter = element("identity", "probe-signalsmith");
        bin.add_many([&convert, &resample, &caps, &filter]).unwrap();
        gst::Element::link_many([&convert, &resample, &caps, &filter]).unwrap();
        for (name, pad) in [
            ("sink", convert.static_pad("sink").unwrap()),
            ("src", filter.static_pad("src").unwrap()),
        ] {
            bin.add_pad(
                &gst::GhostPad::builder_with_target(&pad)
                    .unwrap()
                    .name(name)
                    .build(),
            )
            .unwrap();
        }
        let dsp = Arc::new(Mutex::new(Dsp::new()));
        let audio_pts = Arc::new(AtomicU64::new(u64::MAX));
        let video_pts = Arc::new(AtomicU64::new(u64::MAX));
        let audio_pts_observer = audio_pts.clone();
        let video_pts_observer = video_pts.clone();
        let audio_segment = Arc::new(Mutex::new(None));
        let video_segment = Arc::new(Mutex::new(None));
        let audio_segment_observer = audio_segment.clone();
        let video_segment_observer = video_segment.clone();
        let video_pad = vs.static_pad("sink").unwrap();
        let video_probe = video_pad.add_probe(
            gst::PadProbeType::BUFFER | gst::PadProbeType::EVENT_DOWNSTREAM,
            move |_, info| {
                if let Some(buffer) = info.buffer() {
                    video_pts_observer.store(
                        buffer.pts().map_or(u64::MAX, |t| t.nseconds()),
                        Ordering::Relaxed,
                    );
                } else if let Some(gst::EventView::Segment(event)) = info.event().map(|e| e.view())
                {
                    *video_segment_observer.lock().unwrap() =
                        event.segment().downcast_ref::<gst::ClockTime>().cloned();
                }
                gst::PadProbeReturn::Ok
            },
        );
        let processor = dsp.clone();
        filter.static_pad("sink").unwrap().add_probe(
            gst::PadProbeType::BUFFER
                | gst::PadProbeType::EVENT_FLUSH
                | gst::PadProbeType::EVENT_DOWNSTREAM,
            move |_, info| {
                if let Some(buffer) = info.buffer_mut() {
                    audio_pts_observer.store(
                        buffer.pts().map_or(u64::MAX, |t| t.nseconds()),
                        Ordering::Relaxed,
                    );
                    processor
                        .lock()
                        .unwrap()
                        .process(buffer.make_mut().map_writable().unwrap().as_mut_slice());
                } else if let Some(gst::EventView::Segment(event)) = info.event().map(|e| e.view())
                {
                    *audio_segment_observer.lock().unwrap() =
                        event.segment().downcast_ref::<gst::ClockTime>().cloned();
                } else if info
                    .event()
                    .is_some_and(|event| matches!(event.view(), gst::EventView::FlushStop(_)))
                {
                    processor.lock().unwrap().reset();
                }
                gst::PadProbeReturn::Ok
            },
        );
        player.set_property("audio-filter", &bin);
        audio.set_property("ts-offset", 0i64);
        vs.set_property("ts-offset", 120_000_000i64);
        let bus = player.bus().unwrap();
        emit(
            json!({"type":"playbin3-case","case":case,"status":"START","dsp":"pinned Signalsmith always-on","plugin_version":player.factory().and_then(|f|f.plugin()).map(|p|p.version().to_string()),"suburi_semantics":player.find_property("suburi").and_then(|p|p.blurb().map(str::to_owned))}),
        );
        if player.set_state(gst::State::Playing).is_err() {
            failed = true;
        }
        let started = Instant::now();
        let mut collection: Vec<gst::Stream> = Vec::new();
        let mut switched = false;
        let mut sought = false;
        let mut initial_selected = false;
        while started.elapsed()
            < Duration::from_secs(if auxiliary.is_none() && !muxed { 2 } else { 6 })
        {
            if let Some(message) = bus.timed_pop(gst::ClockTime::from_mseconds(20)) {
                match message.view() {
                    gst::MessageView::Error(e) => {
                        emit(
                            json!({"type":"playbin3-error","case":case,"details":error_facts(&e.error())}),
                        );
                        failed = true;
                        break;
                    }
                    gst::MessageView::StreamCollection(c) => {
                        collection = c.stream_collection().iter().collect();
                        emit(
                            json!({"type":"playbin3-collection","case":case,"streams":collection.iter().enumerate().map(|(index,s)|json!({"index":index,"id":s.stream_id().map(|v|v.to_string()),"kind":format!("{:?}",s.stream_type()),"caps":s.caps().map(|c|c.to_string())})).collect::<Vec<_>>()}),
                        );
                        initial_selected = false;
                    }
                    gst::MessageView::StreamsSelected(s) => emit(
                        json!({"type":"playbin3-selected","case":case,"streams":s.streams().iter().map(|s|json!({"id":s.stream_id().map(|v|v.to_string()),"kind":format!("{:?}",s.stream_type())})).collect::<Vec<_>>(),"at_ms":started.elapsed().as_millis()}),
                    ),
                    gst::MessageView::AsyncDone(_) => emit(
                        json!({"type":"playbin3-async-done","case":case,"position_ns":player.query_position::<gst::ClockTime>().map(|t|t.nseconds()),"at_ms":started.elapsed().as_millis()}),
                    ),
                    gst::MessageView::Latency(_) => {
                        let _ = player.recalculate_latency();
                    }
                    _ => {}
                }
            }
            let audio_streams: Vec<_> = collection
                .iter()
                .filter(|s| s.stream_type().contains(gst::StreamType::AUDIO))
                .collect();
            if !initial_selected && !collection.is_empty() {
                let selected: Vec<_> = collection
                    .iter()
                    .filter(|s| s.stream_type().contains(gst::StreamType::VIDEO))
                    .chain(audio_streams.iter().take(1).copied())
                    .map(|s| s.stream_id().unwrap().to_string())
                    .collect();
                let ids: Vec<_> = selected.iter().map(String::as_str).collect();
                let accepted = player.send_event(gst::event::SelectStreams::new(&ids));
                emit(
                    json!({"type":"playbin3-select-request","case":case,"phase":"initial","ids":selected,"accepted":accepted}),
                );
                initial_selected = true;
            }
            if !switched && started.elapsed() > Duration::from_secs(2) {
                if muxed && audio_streams.len() >= 2 {
                    let selected: Vec<_> = collection
                        .iter()
                        .filter(|s| s.stream_type().contains(gst::StreamType::VIDEO))
                        .chain(std::iter::once(audio_streams[1]))
                        .map(|s| s.stream_id().unwrap().to_string())
                        .collect();
                    let ids: Vec<_> = selected.iter().map(String::as_str).collect();
                    dsp.lock().unwrap().key = 2.;
                    let accepted = player.send_event(gst::event::SelectStreams::new(&ids));
                    emit(
                        json!({"type":"playbin3-select-request","case":case,"phase":"switch-to-second-and-pitch","ids":selected,"accepted":accepted,"position_ns":player.query_position::<gst::ClockTime>().map(|t|t.nseconds()),"at_ms":started.elapsed().as_millis()}),
                    );
                } else if auxiliary == Some(0) {
                    // A documented *next* auxiliary URI request, not a claim of
                    // an immediate in-place audio replacement.
                    player.set_property("suburi", uri(manifest["audio"][1].as_str().unwrap()));
                    emit(
                        json!({"type":"playbin3-next-auxiliary-request","case":case,"at_ms":started.elapsed().as_millis()}),
                    );
                }
                switched = true;
            }
            if auxiliary == Some(1) && !sought && started.elapsed() > Duration::from_millis(1200) {
                let accepted = player
                    .seek_simple(
                        gst::SeekFlags::FLUSH | gst::SeekFlags::ACCURATE,
                        gst::ClockTime::from_seconds(12),
                    )
                    .is_ok();
                emit(
                    json!({"type":"playbin3-restore-seek","case":case,"accepted":accepted,"target_seconds":12,"at_ms":started.elapsed().as_millis()}),
                );
                sought = true;
            }
        }
        let sources:Vec<_>=player.iterate_recurse().into_iter().filter_map(Result::ok)
            .filter(|e|e.factory().is_some_and(|f|f.name()=="filesrc"))
            .map(|e|{let location=e.property::<String>("location");json!({"video":Some(location.as_str())==manifest["video"].as_str(),"audio0":Some(location.as_str())==manifest["audio"][0].as_str(),"audio1":Some(location.as_str())==manifest["audio"][1].as_str(),"collection_fixture":Some(location.as_str())==manifest["collection_fixture"].as_str(),"timing_audio":Some(location.as_str())==manifest["timing_audio"].as_str(),"timing_video":Some(location.as_str())==manifest["timing_video"].as_str()})}).collect();
        emit(
            json!({"type":"playbin3-case-result","case":case,"sources":sources,"position_ns":player.query_position::<gst::ClockTime>().map(|t|t.nseconds()),"last_audio_input_pts_ns":audio_pts.load(Ordering::Relaxed),"last_video_sink_pts_ns":video_pts.load(Ordering::Relaxed),"audio_segment":segment_mapping(&audio_segment,audio_pts.load(Ordering::Relaxed)),"video_segment":segment_mapping(&video_segment,video_pts.load(Ordering::Relaxed)),"audio_stats":format!("{:?}",audio.property::<gst::Structure>("stats")),"clock":player.clock().map(|c|c.name().to_string()),"audio_stream_count":collection.iter().filter(|s|s.stream_type().contains(gst::StreamType::AUDIO)).count()}),
        );
        let _ = player.set_state(gst::State::Null);
        if let Some(probe) = video_probe {
            video_pad.remove_probe(probe);
        }
    }
    if failed {
        std::process::ExitCode::FAILURE
    } else {
        std::process::ExitCode::SUCCESS
    }
}
