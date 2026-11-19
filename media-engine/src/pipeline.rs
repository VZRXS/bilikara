//! One GStreamer pipeline per authorized program.
//!
//! A program is one video artifact plus one selected audio variant. Each file
//! has its own `uridecodebin`; one pipeline seek reaches each source exactly
//! once through its own sink, so the independent audio file always follows the
//! video timeline (no auxiliary-input segment). Stale bus traffic is tagged
//! with the pipeline token and discarded by the engine.
use crate::frame::{FrameSink, VideoFrame};
use crate::pitch::{self, PitchShift};
use gst::prelude::*;
use gstreamer as gst;
use gstreamer_app as gst_app;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SinkKind {
    Video,
    Audio,
}

pub(crate) type EventSink = Arc<dyn Fn(PipelineEvent) + Send + Sync>;

pub(crate) enum PipelineEvent {
    Bus {
        token: u64,
        message: gst::Message,
    },
    SinkEos {
        token: u64,
        sink: SinkKind,
        seqnum: gst::Seqnum,
    },
    /// The video sink prerolled (and presented) a frame of this segment.
    VideoPreroll {
        token: u64,
        segment: Option<gst::Seqnum>,
    },
}

/// Test/diagnostic PCM observer receiving exactly what the audio sink renders.
pub trait PcmSink: Send + Sync + 'static {
    fn pcm(&self, pts_ns: Option<u64>, samples: &[f32]);
}

#[derive(Clone)]
pub enum AudioOutput {
    /// PulseAudio (including PipeWire's Pulse service), then ALSA.
    Auto,
    Pulse {
        server: Option<String>,
        device: Option<String>,
    },
    /// Clock-synchronized discard sink.
    Fake,
    /// Clock-synchronized capture for deterministic tests.
    Capture(Arc<dyn PcmSink>),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClockMode {
    /// The audio sink provides the pipeline clock (GStreamer default). A
    /// PulseAudio sink opens its stream at the first Play, so a program's
    /// first run falls back to the system clock.
    AudioSink,
    /// Monotonic system clock; the audio sink slaves to it (the shell).
    System,
}

#[derive(Clone, Debug)]
pub struct MediaSource {
    pub video_uri: String,
    pub audio_uri: String,
    /// `name=value` cookies for HTTP sources (Host loopback authorization).
    pub cookies: Vec<String>,
}

impl MediaSource {
    pub fn validate(&self) -> Result<(), &'static str> {
        for uri in [&self.video_uri, &self.audio_uri] {
            if uri.len() > 4096 || uri.chars().any(char::is_control) {
                return Err("invalid-media-uri");
            }
            if !(uri.starts_with("file:///")
                || uri.starts_with("http://")
                || uri.starts_with("https://"))
            {
                return Err("unsupported-media-uri");
            }
        }
        if self.cookies.len() > 8
            || self
                .cookies
                .iter()
                .any(|c| c.len() > 512 || c.chars().any(char::is_control) || !c.contains('='))
        {
            return Err("invalid-media-cookie");
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct OutputSettings {
    pub volume: f64,
    pub muted: bool,
    pub key_shift: f32,
    pub av_delay_ms: i64,
}

impl Default for OutputSettings {
    fn default() -> Self {
        Self {
            volume: 1.0,
            muted: false,
            key_shift: 0.0,
            av_delay_ms: 0,
        }
    }
}

pub const MAX_VOLUME: f64 = 4.0;
pub const MAX_AV_DELAY_MS: i64 = 5000;

#[derive(Default)]
pub struct FrameCounters {
    pub rendered: AtomicU64,
    pub presented: AtomicU64,
}

pub(crate) struct ProgramPipeline {
    pub token: u64,
    pub pipeline: gst::Pipeline,
    pub audio_sink: gst::Element,
    pub audio_sink_factory: String,
    pub video_sink: gst_app::AppSink,
    pub volume: gst::Element,
    pub pitch: PitchShift,
    pub present: Arc<AtomicBool>,
    pub frames: Arc<FrameCounters>,
    pub linked: Arc<Mutex<[bool; 2]>>,
    /// Blocks the PulseAudio sink's input until the program first plays.
    audio_hold: Mutex<Option<(gst::Pad, gst::PadProbeId)>>,
}

fn make(factory: &str, name: &str) -> Result<gst::Element, String> {
    gst::ElementFactory::make(factory)
        .name(name)
        .build()
        .map_err(|_| format!("missing-element:{factory}"))
}

fn audio_sink(output: &AudioOutput) -> Result<(gst::Element, String), String> {
    let element = match output {
        AudioOutput::Auto => {
            let mut chosen = None;
            for factory in ["pulsesink", "alsasink", "autoaudiosink"] {
                if let Ok(element) = make(factory, "audio-output") {
                    chosen = Some(element);
                    break;
                }
            }
            chosen.ok_or_else(|| "missing-element:audio-sink".to_string())?
        }
        AudioOutput::Pulse { server, device } => {
            let element = make("pulsesink", "audio-output")?;
            if let Some(server) = server {
                element.set_property("server", server);
            }
            if let Some(device) = device {
                element.set_property("device", device);
            }
            element
        }
        AudioOutput::Fake => {
            let element = make("fakesink", "audio-output")?;
            element.set_property("sync", true);
            element
        }
        AudioOutput::Capture(sink) => {
            let sink = sink.clone();
            let appsink = gst_app::AppSink::builder()
                .name("audio-output")
                .caps(&pitch::caps())
                .sync(true)
                .max_buffers(8)
                .drop(false)
                .build();
            appsink.set_callbacks(
                gst_app::AppSinkCallbacks::builder()
                    .new_sample(move |appsink| {
                        let sample = appsink.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                        if let Some(buffer) = sample.buffer() {
                            if let Ok(map) = buffer.map_readable() {
                                let samples: Vec<f32> = map
                                    .as_slice()
                                    .chunks_exact(4)
                                    .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                                    .collect();
                                sink.pcm(buffer.pts().map(|t| t.nseconds()), &samples);
                            }
                        }
                        Ok(gst::FlowSuccess::Ok)
                    })
                    .build(),
            );
            appsink.upcast()
        }
    };
    let factory = element
        .factory()
        .map(|f| f.name().to_string())
        .unwrap_or_default();
    if factory == "pulsesink" {
        element.set_property("client-name", "bilikara");
    }
    Ok((element, factory))
}

/// Container-level caps keep decoding; elementary streams of the other media
/// type are exposed undecoded and discarded, so no hidden decoder runs.
fn continue_decoding(caps: &gst::CapsRef, wanted: &str) -> bool {
    let Some(name) = caps.structure(0).map(|s| s.name().as_str().to_owned()) else {
        return true;
    };
    const CONTAINERS: [&str; 7] = [
        "video/quicktime",
        "video/x-matroska",
        "video/webm",
        "video/mpegts",
        "audio/x-m4a",
        "application/x-id3",
        "video/x-flv",
    ];
    if CONTAINERS.iter().any(|c| name == *c) {
        return true;
    }
    if name.starts_with("text/")
        || name.starts_with("subpicture/")
        || name.starts_with("image/")
        || name.starts_with("closedcaption/")
        || name.starts_with("application/x-subtitle")
    {
        return false;
    }
    match wanted {
        "video" => !name.starts_with("audio/"),
        _ => {
            !(name.starts_with("video/x-h26")
                || name.starts_with("video/x-vp")
                || name.starts_with("video/x-av1")
                || name == "video/mpeg"
                || name.starts_with("video/x-divx"))
        }
    }
}

fn discard_pad(pipeline: &gst::Pipeline, pad: &gst::Pad) {
    if let Ok(sink) = gst::ElementFactory::make("fakesink")
        .property("sync", false)
        .property("async", false)
        .build()
    {
        if pipeline.add(&sink).is_ok() {
            let _ = sink.sync_state_with_parent();
            if let Some(target) = sink.static_pad("sink") {
                let _ = pad.link(&target);
            }
        }
    }
}

/// Loopback hosts that must never be reached through a proxy.
const LOOPBACK_HOSTS: [&str; 3] = ["127.0.0.1", "localhost", "::1"];

/// The `no_proxy` value with the loopback hosts appended (existing entries are
/// kept). GStreamer's HTTP source and libsoup's default resolver otherwise
/// route the Host's loopback media through a user's `http_proxy`. The desktop
/// shell applies this to `no_proxy`/`NO_PROXY` at startup, before any thread
/// exists; the engine additionally clears the source's env-derived proxy.
pub fn loopback_no_proxy(current: Option<&str>) -> String {
    let mut entries: Vec<String> = current
        .unwrap_or("")
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(str::to_owned)
        .collect();
    for host in LOOPBACK_HOSTS {
        if !entries.iter().any(|entry| entry.eq_ignore_ascii_case(host)) {
            entries.push(host.to_owned());
        }
    }
    entries.join(",")
}

/// `http://127.0.0.1`, `http://localhost` or `http://[::1]` (any port/path).
fn is_loopback_http(uri: &str) -> bool {
    let Some(rest) = uri.strip_prefix("http://") else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = if let Some(v6) = authority.strip_prefix('[') {
        v6.split(']').next().unwrap_or("")
    } else {
        authority
            .rsplit_once(':')
            .map_or(authority, |(host, _)| host)
    };
    LOOPBACK_HOSTS.contains(&host)
}

fn source(
    pipeline: &gst::Pipeline,
    name: &str,
    uri: &str,
    cookies: &[String],
    wanted: &'static str,
    target: gst::Element,
    linked: Arc<Mutex<[bool; 2]>>,
) -> Result<gst::Element, String> {
    let decode = make("uridecodebin", name)?;
    decode.set_property("uri", uri);
    let cookies = cookies.to_vec();
    let loopback = is_loopback_http(uri);
    decode.connect("source-setup", false, move |values| {
        let source = values[1].get::<gst::Element>().ok()?;
        // The HTTP source adopts `$http_proxy` (ignoring `no_proxy`); the
        // Host's loopback media must never be routed through a user proxy.
        if loopback && source.find_property("proxy").is_some() {
            source.set_property("proxy", None::<&str>);
        }
        if source.find_property("cookies").is_some() && !cookies.is_empty() {
            let refs: Vec<&str> = cookies.iter().map(String::as_str).collect();
            source.set_property("cookies", gst::glib::StrV::from(refs.as_slice()));
        }
        if source.find_property("user-agent").is_some() {
            source.set_property("user-agent", "bilikara-media-engine");
        }
        None
    });
    decode.connect("autoplug-continue", false, move |values| {
        let caps = values[2].get::<gst::Caps>().ok()?;
        Some(continue_decoding(&caps, wanted).to_value())
    });
    let weak = pipeline.downgrade();
    decode.connect_pad_added(move |_, pad| {
        let Some(pipeline) = weak.upgrade() else {
            return;
        };
        let caps = pad.current_caps().unwrap_or_else(|| pad.query_caps(None));
        let raw = caps
            .structure(0)
            .is_some_and(|s| s.name().starts_with(&format!("{wanted}/x-raw")));
        let index = usize::from(wanted == "audio");
        let mut state = linked.lock().unwrap();
        if raw && !state[index] {
            if let Some(sink) = target.static_pad("sink") {
                if pad.link(&sink).is_ok() {
                    state[index] = true;
                    return;
                }
            }
        }
        drop(state);
        discard_pad(&pipeline, pad);
    });
    pipeline
        .add(&decode)
        .map_err(|_| "pipeline-add".to_string())?;
    Ok(decode)
}

pub(crate) struct BuildContext<'a> {
    pub token: u64,
    pub media: &'a MediaSource,
    pub audio: &'a AudioOutput,
    pub clock: ClockMode,
    pub settings: OutputSettings,
    pub events: EventSink,
    pub frame_sink: Arc<dyn FrameSink>,
    pub frame_sequence: Arc<AtomicU64>,
    pub present: bool,
}

pub(crate) fn build(context: BuildContext<'_>) -> Result<ProgramPipeline, String> {
    let BuildContext {
        token,
        media,
        audio,
        clock,
        settings,
        events,
        frame_sink,
        frame_sequence,
        present,
    } = context;
    media.validate().map_err(str::to_string)?;
    let pipeline = gst::Pipeline::with_name(&format!("bilikara-program-{token}"));
    if clock == ClockMode::System {
        pipeline.use_clock(Some(&gst::SystemClock::obtain()));
    }
    let video_queue = make("queue", "video-queue")?;
    let video_convert = make("videoconvert", "video-convert")?;
    video_convert.set_property("n-threads", 2u32);
    let video_caps = make("capsfilter", "video-format")?;
    let bgrx = gst::Caps::builder("video/x-raw")
        .field("format", "BGRx")
        .build();
    video_caps.set_property("caps", &bgrx);
    let video_sink = gst_app::AppSink::builder()
        .name("video-output")
        .caps(&bgrx)
        .sync(true)
        .max_buffers(2)
        .drop(false)
        .enable_last_sample(false)
        .build();
    video_sink.set_property("qos", true);

    let audio_queue = make("queue", "audio-queue")?;
    let audio_convert = make("audioconvert", "audio-convert")?;
    let audio_resample = make("audioresample", "audio-resample")?;
    let audio_caps = make("capsfilter", "audio-format")?;
    audio_caps.set_property("caps", pitch::caps());
    let audio_rate = make("audiorate", "audio-continuity")?;
    let pitch = PitchShift::new("pitch");
    let volume = make("volume", "gain")?;
    let (audio_sink, audio_sink_factory) = audio_sink(audio)?;
    // libpulse 15.99-16.x reports a playback stream that was created corked
    // as having played ever since it was created (fixed in PulseAudio 17,
    // time-smoother-2 "stream starts paused"). pulsesink always creates its
    // stream corked, so a stream opened during a paused preroll would place
    // the first samples the whole preroll duration in the future: silence
    // for the countdown's length, then audio behind the picture (or, with
    // the sink's clock, a frozen pipeline). The program therefore prerolls on
    // video alone and the sink receives its caps, and opens the stream, only
    // when the program first plays. Until then the sink cannot provide a
    // clock, which is why the shell runs on the system clock; the sink keeps
    // its default skew slaving against it.
    let hold_audio = audio_sink_factory == "pulsesink";
    if hold_audio {
        audio_sink.set_property("async", false);
    }

    pipeline
        .add_many([
            &video_queue,
            &video_convert,
            &video_caps,
            video_sink.upcast_ref(),
            &audio_queue,
            &audio_convert,
            &audio_resample,
            &audio_caps,
            &audio_rate,
            pitch.upcast_ref(),
            &volume,
            &audio_sink,
        ])
        .map_err(|_| "pipeline-add".to_string())?;
    gst::Element::link_many([
        &video_queue,
        &video_convert,
        &video_caps,
        video_sink.upcast_ref(),
    ])
    .map_err(|_| "video-link".to_string())?;
    gst::Element::link_many([
        &audio_queue,
        &audio_convert,
        &audio_resample,
        &audio_caps,
        &audio_rate,
        pitch.upcast_ref(),
        &volume,
        &audio_sink,
    ])
    .map_err(|_| "audio-link".to_string())?;

    let linked = Arc::new(Mutex::new([false; 2]));
    source(
        &pipeline,
        "video-source",
        &media.video_uri,
        &media.cookies,
        "video",
        video_queue.clone(),
        linked.clone(),
    )?;
    source(
        &pipeline,
        "audio-source",
        &media.audio_uri,
        &media.cookies,
        "audio",
        audio_queue.clone(),
        linked.clone(),
    )?;

    let audio_hold = if hold_audio {
        let pad = audio_sink.static_pad("sink").ok_or("audio-sink-pad")?;
        pad.add_probe(gst::PadProbeType::BLOCK_DOWNSTREAM, |_, _| {
            gst::PadProbeReturn::Ok
        })
        .map(|id| (pad, id))
    } else {
        None
    };

    let present = Arc::new(AtomicBool::new(present));
    let frames = Arc::new(FrameCounters::default());
    // Segment seqnums let the engine tie a settled seek to the frame that the
    // video sink actually prerolled for it.
    let video_segment = Arc::new(Mutex::new(None::<gst::Seqnum>));
    if let Some(pad) = video_sink.static_pad("sink") {
        let video_segment = video_segment.clone();
        pad.add_probe(gst::PadProbeType::EVENT_DOWNSTREAM, move |_, info| {
            if let Some(event) = info.event() {
                if matches!(event.view(), gst::EventView::Segment(_)) {
                    *video_segment.lock().unwrap() = Some(event.seqnum());
                }
            }
            gst::PadProbeReturn::Ok
        });
    }
    {
        let preroll_events = events.clone();
        let (present_sample, present_preroll) = (present.clone(), present.clone());
        let (sink_sample, sink_preroll) = (frame_sink.clone(), frame_sink);
        let (frames_sample, frames_preroll) = (frames.clone(), frames.clone());
        let (sequence_sample, sequence_preroll) = (frame_sequence.clone(), frame_sequence);
        video_sink.set_callbacks(
            gst_app::AppSinkCallbacks::builder()
                .new_sample(move |appsink| {
                    let sample = appsink.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                    frames_sample.rendered.fetch_add(1, Ordering::Relaxed);
                    if present_sample.load(Ordering::Acquire) {
                        let sequence = sequence_sample.fetch_add(1, Ordering::Relaxed);
                        if let Some(frame) = VideoFrame::from_sample(&sample, sequence, token) {
                            frames_sample.presented.fetch_add(1, Ordering::Relaxed);
                            sink_sample.present(Arc::new(frame));
                        }
                    }
                    Ok(gst::FlowSuccess::Ok)
                })
                .new_preroll(move |appsink| {
                    let sample = appsink.pull_preroll().map_err(|_| gst::FlowError::Eos)?;
                    // A paused/seeked program shows its exact target frame.
                    if present_preroll.load(Ordering::Acquire) {
                        let sequence = sequence_preroll.fetch_add(1, Ordering::Relaxed);
                        if let Some(frame) = VideoFrame::from_sample(&sample, sequence, token) {
                            frames_preroll.presented.fetch_add(1, Ordering::Relaxed);
                            sink_preroll.present(Arc::new(frame));
                        }
                    }
                    let segment = *video_segment.lock().unwrap();
                    preroll_events(PipelineEvent::VideoPreroll { token, segment });
                    Ok(gst::FlowSuccess::Ok)
                })
                .build(),
        );
    }

    for (kind, sink) in [
        (
            SinkKind::Video,
            video_sink.upcast_ref::<gst::Element>().clone(),
        ),
        (SinkKind::Audio, audio_sink.clone()),
    ] {
        let events = events.clone();
        if let Some(pad) = sink.static_pad("sink") {
            pad.add_probe(gst::PadProbeType::EVENT_DOWNSTREAM, move |_, info| {
                if let Some(event) = info.event() {
                    if matches!(event.view(), gst::EventView::Eos(_)) {
                        events(PipelineEvent::SinkEos {
                            token,
                            sink: kind,
                            seqnum: event.seqnum(),
                        });
                    }
                }
                gst::PadProbeReturn::Ok
            });
        }
    }

    let bus = pipeline.bus().ok_or("pipeline-bus")?;
    bus.set_sync_handler(move |_, message| {
        events(PipelineEvent::Bus {
            token,
            message: message.to_owned(),
        });
        gst::BusSyncReply::Drop
    });

    let program = ProgramPipeline {
        token,
        pipeline,
        audio_sink,
        audio_sink_factory,
        video_sink,
        volume,
        pitch,
        present,
        frames,
        linked,
        audio_hold: Mutex::new(audio_hold),
    };
    program.apply(&settings);
    Ok(program)
}

impl ProgramPipeline {
    /// Called after every request to play: the first one lets the held audio
    /// reach the sink, which opens its stream right as playback starts.
    pub fn release_audio(&self) {
        if let Some((pad, id)) = self.audio_hold.lock().unwrap().take() {
            pad.remove_probe(id);
        }
    }

    pub fn apply(&self, settings: &OutputSettings) {
        self.volume
            .set_property("volume", settings.volume.clamp(0.0, MAX_VOLUME));
        self.volume.set_property("mute", settings.muted);
        self.pitch.set_semitones(settings.key_shift);
        let delay = settings
            .av_delay_ms
            .clamp(-MAX_AV_DELAY_MS, MAX_AV_DELAY_MS);
        // Positive delay holds audio; negative delay holds video (frame zero
        // stays on screen while audio begins). Both run on one pipeline clock.
        let audio_offset = delay.max(0) * 1_000_000;
        let video_offset = (-delay).max(0) * 1_000_000;
        if self.audio_sink.find_property("ts-offset").is_some() {
            self.audio_sink.set_property("ts-offset", audio_offset);
        }
        self.video_sink.set_property("ts-offset", video_offset);
    }

    pub fn decoders(&self) -> Vec<String> {
        self.pipeline
            .iterate_recurse()
            .into_iter()
            .filter_map(Result::ok)
            .filter_map(|element| element.factory())
            .filter(|factory| factory.klass().contains("Decoder"))
            .map(|factory| factory.name().to_string())
            .collect()
    }

    pub fn video_decoder_count(&self) -> usize {
        self.pipeline
            .iterate_recurse()
            .into_iter()
            .filter_map(Result::ok)
            .filter_map(|element| element.factory())
            .filter(|factory| {
                let klass = factory.klass();
                klass.contains("Decoder") && klass.contains("Video")
            })
            .count()
    }

    pub fn shutdown(&self) {
        self.present.store(false, Ordering::Release);
        let _ = self.pipeline.set_state(gst::State::Null);
        if let Some(bus) = self.pipeline.bus() {
            bus.unset_sync_handler();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{is_loopback_http, loopback_no_proxy};

    #[test]
    fn loopback_hosts_are_appended_to_no_proxy_once() {
        assert_eq!(loopback_no_proxy(None), "127.0.0.1,localhost,::1");
        assert_eq!(
            loopback_no_proxy(Some(" example.com,LOCALHOST ,, ")),
            "example.com,LOCALHOST,127.0.0.1,::1"
        );
        let full = loopback_no_proxy(Some("127.0.0.1,localhost,::1"));
        assert_eq!(full, "127.0.0.1,localhost,::1");
    }

    #[test]
    fn only_plain_http_loopback_authorities_bypass_proxies() {
        for uri in [
            "http://127.0.0.1:8080/api/media?x=1",
            "http://localhost/a",
            "http://[::1]:9/a",
            "http://127.0.0.1",
        ] {
            assert!(is_loopback_http(uri), "{uri}");
        }
        for uri in [
            "https://127.0.0.1/a",
            "http://127.0.0.1.example.com/a",
            "http://user@evil.example/127.0.0.1",
            "http://10.0.0.1/a",
            "file:///tmp/a",
            "http://localhost.evil/a",
        ] {
            assert!(!is_loopback_http(uri), "{uri}");
        }
    }
}
