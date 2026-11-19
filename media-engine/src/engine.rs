//! Engine thread: serializes commands, owns the current program pipeline and
//! turns GStreamer bus traffic into identity-bound observations.
//!
//! Invariants:
//! * Every command names the exact program it targets; a mismatch is rejected
//!   before any media operation.
//! * Bus messages from a retired pipeline are ignored by token.
//! * EOS is reported at most once per accepted segment, only when the pipeline
//!   has drained every sink (DSP tail included) for the current seek sequence.
//! * The engine never chooses another program; completion is an observation.
use crate::frame::FrameSink;
use crate::identity::ProgramIdentity;
use crate::pipeline::{
    self, AudioOutput, BuildContext, ClockMode, EventSink, MediaSource, OutputSettings,
    PipelineEvent, ProgramPipeline, SinkKind, MAX_AV_DELAY_MS, MAX_VOLUME,
};
use crate::pitch::MAX_SEMITONES;
use gst::prelude::*;
use gstreamer as gst;
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

const TICK: Duration = Duration::from_millis(50);
const POSITION_INTERVAL: Duration = Duration::from_millis(250);
const PREROLL_DEADLINE: Duration = Duration::from_secs(20);
const STALL_DEADLINE: Duration = Duration::from_secs(5);
const EOS_STALL_DEADLINE: Duration = Duration::from_millis(2500);
/// Bound for demuxers that do not propagate the seek seqnum to segments.
const PREROLL_GRACE: Duration = Duration::from_millis(400);

#[derive(Clone)]
pub struct EngineConfig {
    pub audio: AudioOutput,
    pub clock: ClockMode,
    /// Hardware decoders are excluded unless explicitly enabled.
    pub hardware_decoding: bool,
}

impl Default for EngineConfig {
    fn default() -> Self {
        Self {
            audio: AudioOutput::Auto,
            clock: ClockMode::System,
            hardware_decoding: false,
        }
    }
}

#[derive(Clone, Debug)]
pub enum Command {
    Load {
        program: ProgramIdentity,
        media: MediaSource,
        start_seconds: f64,
        play: bool,
    },
    Play {
        program: ProgramIdentity,
    },
    Pause {
        program: ProgramIdentity,
    },
    /// Accurate flushing seek. `play` atomically sets the resulting intent
    /// (used by local handback restoration) when present.
    Seek {
        program: ProgramIdentity,
        seconds: f64,
        play: Option<bool>,
    },
    Settings(SettingsPatch),
    Stop {
        program: ProgramIdentity,
    },
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SettingsPatch {
    pub volume: Option<f64>,
    pub muted: Option<bool>,
    pub key_shift: Option<f32>,
    pub av_delay_ms: Option<i64>,
}

/// Synchronous acceptance of a command; media completion is observed later.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct CommandReceipt {
    /// Identifier echoed by the matching `seek-settled` observation. A later
    /// seek supersedes an earlier one; both settle with the later position.
    pub seek_id: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CommandError {
    pub code: String,
}

impl CommandError {
    fn new(code: impl Into<String>) -> Self {
        Self { code: code.into() }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    Loading,
    Seeking,
    Paused,
    Playing,
    Ended,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ObservationKind {
    Loading,
    Ready,
    Playing,
    Paused,
    Position,
    SeekSettled {
        seek_id: u64,
    },
    Eos {
        drained: bool,
        watchdog: bool,
    },
    Error {
        code: String,
        fatal: bool,
        detail: String,
    },
    ClockLost,
    Stopped,
}

#[derive(Clone, Debug, Serialize)]
pub struct Observation {
    pub seq: u64,
    pub program: ProgramIdentity,
    #[serde(flatten)]
    pub kind: ObservationKind,
    pub position: Option<f64>,
    pub duration: Option<f64>,
    pub intent_playing: bool,
    pub at_ms: u64,
}

pub type Observer = Arc<dyn Fn(Observation) + Send + Sync>;

#[derive(Clone, Debug, Serialize)]
pub struct Capability {
    pub available: bool,
    pub version: String,
    pub missing: Vec<String>,
    pub audio_sinks: Vec<String>,
}

const REQUIRED: [&str; 11] = [
    "uridecodebin",
    "queue",
    "videoconvert",
    "capsfilter",
    "appsink",
    "audioconvert",
    "audioresample",
    "audiorate",
    "volume",
    "qtdemux",
    "souphttpsrc",
];

/// Runtime probe; never constructs a pipeline or opens a device.
pub fn probe() -> Capability {
    if let Err(error) = gst::init() {
        return Capability {
            available: false,
            version: String::new(),
            missing: vec![format!("gstreamer-init:{error}")],
            audio_sinks: Vec::new(),
        };
    }
    let (major, minor, _, _) = gst::version();
    let mut missing: Vec<String> = REQUIRED
        .iter()
        .filter(|name| gst::ElementFactory::find(name).is_none())
        .map(|name| (*name).to_string())
        .collect();
    let software = |names: &[&str]| {
        names
            .iter()
            .any(|name| gst::ElementFactory::find(name).is_some())
    };
    if !software(&["avdec_h264", "openh264dec"]) {
        missing.push("h264-decoder".into());
    }
    if !software(&["avdec_aac", "faad", "fdkaacdec"]) {
        missing.push("aac-decoder".into());
    }
    if !software(&["avdec_flac", "flacdec"]) {
        missing.push("flac-decoder".into());
    }
    let audio_sinks: Vec<String> = ["pulsesink", "alsasink", "autoaudiosink"]
        .iter()
        .filter(|name| gst::ElementFactory::find(name).is_some())
        .map(|name| (*name).to_string())
        .collect();
    if audio_sinks.is_empty() {
        missing.push("audio-sink".into());
    }
    if (major, minor) < (1, 20) {
        missing.push(format!("gstreamer>=1.20 (found {major}.{minor})"));
    }
    Capability {
        available: missing.is_empty(),
        version: gst::version_string().to_string(),
        missing,
        audio_sinks,
    }
}

fn disable_hardware_decoders() -> Vec<String> {
    let registry = gst::Registry::get();
    let mut disabled = Vec::new();
    for feature in registry.features(gst::ElementFactory::static_type()) {
        let Ok(factory) = feature.clone().downcast::<gst::ElementFactory>() else {
            continue;
        };
        let klass = factory.klass();
        if klass.contains("Decoder") && klass.contains("Hardware") {
            feature.set_rank(gst::Rank::NONE);
            disabled.push(feature.name().to_string());
        }
    }
    disabled.sort();
    disabled
}

enum Message {
    Command(Command, SyncSender<Result<CommandReceipt, CommandError>>),
    Pipeline(PipelineEvent),
    Shutdown(SyncSender<()>),
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Snapshot {
    pub program: Option<ProgramIdentity>,
    pub phase: Option<Phase>,
    pub position: Option<f64>,
    pub duration: Option<f64>,
    pub intent_playing: bool,
    pub frames_rendered: u64,
    pub frames_presented: u64,
    pub audio_sink: String,
    pub clock: Option<String>,
    pub decoders: Vec<String>,
    pub video_decoders: usize,
    pub pipelines_created: u64,
    pub dsp: Value,
    pub disabled_hardware_decoders: Vec<String>,
}

pub struct Engine {
    sender: Sender<Message>,
    thread: Option<JoinHandle<()>>,
    snapshot: Arc<Mutex<Snapshot>>,
}

impl Engine {
    pub fn start(
        config: EngineConfig,
        frame_sink: Arc<dyn FrameSink>,
        observer: Observer,
    ) -> Result<Self, String> {
        gst::init().map_err(|error| format!("gstreamer-init:{error}"))?;
        let disabled = if config.hardware_decoding {
            Vec::new()
        } else {
            disable_hardware_decoders()
        };
        let (sender, receiver) = mpsc::channel();
        let snapshot = Arc::new(Mutex::new(Snapshot {
            disabled_hardware_decoders: disabled,
            ..Snapshot::default()
        }));
        let runtime = Runtime {
            config,
            frame_sink,
            observer,
            sender: sender.clone(),
            settings: OutputSettings::default(),
            current: None,
            next_token: 1,
            next_seek: 1,
            observation_seq: 0,
            frame_sequence: Arc::new(AtomicU64::new(1)),
            started: Instant::now(),
            snapshot: snapshot.clone(),
            pipelines_created: 0,
        };
        let thread = std::thread::Builder::new()
            .name("bilikara-media-engine".into())
            .spawn(move || runtime.run(receiver))
            .map_err(|error| format!("engine-thread:{error}"))?;
        Ok(Self {
            sender,
            thread: Some(thread),
            snapshot,
        })
    }

    /// Validates and starts one command on the engine thread. Completion of
    /// asynchronous media work is reported through observations.
    pub fn command(&self, command: Command) -> Result<CommandReceipt, CommandError> {
        let (reply, result) = mpsc::sync_channel(1);
        self.sender
            .send(Message::Command(command, reply))
            .map_err(|_| CommandError::new("engine-stopped"))?;
        result
            .recv_timeout(Duration::from_secs(10))
            .map_err(|_| CommandError::new("engine-unresponsive"))?
    }

    pub fn snapshot(&self) -> Snapshot {
        self.snapshot.lock().unwrap().clone()
    }

    pub fn shutdown(mut self) {
        self.stop_thread();
    }

    fn stop_thread(&mut self) {
        if let Some(thread) = self.thread.take() {
            let (reply, done) = mpsc::sync_channel(1);
            if self.sender.send(Message::Shutdown(reply)).is_ok() {
                let _ = done.recv_timeout(Duration::from_secs(10));
            }
            let _ = thread.join();
        }
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        self.stop_thread();
    }
}

struct ActiveSeek {
    seek_id: u64,
    seqnum: gst::Seqnum,
    /// ASYNC_DONE arrived before the video sink reported this segment's preroll.
    awaiting_preroll: bool,
    awaiting_since: Option<Instant>,
}

struct Active {
    program: ProgramIdentity,
    pipeline: ProgramPipeline,
    phase: Phase,
    intent_playing: bool,
    /// Latest requested seek waiting for the current preroll/seek to settle.
    pending_seek: Option<(f64, u64)>,
    active_seek: Option<ActiveSeek>,
    /// Sequence number of the segment that may legitimately end in EOS.
    segment_seqnum: Option<gst::Seqnum>,
    eos_reported: bool,
    sink_eos: [Option<gst::Seqnum>; 2],
    sink_eos_at: Option<Instant>,
    /// Segment of the last frame prerolled by the video sink.
    video_preroll: Option<Option<gst::Seqnum>>,
    duration: Option<gst::ClockTime>,
    pipeline_state: gst::State,
    phase_since: Instant,
    last_position: Option<gst::ClockTime>,
    last_progress: Instant,
    last_position_report: Instant,
    reported_position: Option<gst::ClockTime>,
    stall_reported: bool,
    ready_reported: bool,
}

struct Runtime {
    config: EngineConfig,
    frame_sink: Arc<dyn FrameSink>,
    observer: Observer,
    sender: Sender<Message>,
    settings: OutputSettings,
    current: Option<Active>,
    next_token: u64,
    next_seek: u64,
    observation_seq: u64,
    frame_sequence: Arc<AtomicU64>,
    started: Instant,
    snapshot: Arc<Mutex<Snapshot>>,
    pipelines_created: u64,
}

fn trace_enabled() -> bool {
    static TRACE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *TRACE.get_or_init(|| std::env::var_os("BILIKARA_ENGINE_TRACE").is_some())
}

fn seconds(time: Option<gst::ClockTime>) -> Option<f64> {
    time.map(|t| t.nseconds() as f64 / 1e9)
}

impl Runtime {
    fn run(mut self, receiver: Receiver<Message>) {
        // Pipeline callbacks share the command queue, so commands and media
        // events are handled strictly in arrival order on this thread.
        let forward = Mutex::new(self.sender.clone());
        let events: EventSink = Arc::new(move |event| {
            let _ = forward.lock().unwrap().send(Message::Pipeline(event));
        });
        loop {
            match receiver.recv_timeout(TICK) {
                Ok(Message::Command(command, reply)) => {
                    let result = self.command(command, &events);
                    let _ = reply.send(result);
                }
                Ok(Message::Pipeline(event)) => self.pipeline_event(event),
                Ok(Message::Shutdown(reply)) => {
                    self.retire_current(false);
                    let _ = reply.send(());
                    break;
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
            self.tick();
        }
        self.retire_current(false);
    }

    fn observe(&mut self, kind: ObservationKind) {
        let Some(active) = &self.current else {
            return;
        };
        let position = active
            .pipeline
            .pipeline
            .query_position::<gst::ClockTime>()
            .or(active.last_position);
        self.observation_seq += 1;
        let observation = Observation {
            seq: self.observation_seq,
            program: active.program.clone(),
            kind,
            position: seconds(position),
            duration: seconds(active.duration),
            intent_playing: active.intent_playing,
            at_ms: self.started.elapsed().as_millis() as u64,
        };
        self.publish_snapshot();
        (self.observer)(observation);
    }

    fn observe_retired(&mut self, program: ProgramIdentity, kind: ObservationKind) {
        self.observation_seq += 1;
        let observation = Observation {
            seq: self.observation_seq,
            program,
            kind,
            position: None,
            duration: None,
            intent_playing: false,
            at_ms: self.started.elapsed().as_millis() as u64,
        };
        self.publish_snapshot();
        (self.observer)(observation);
    }

    fn publish_snapshot(&self) {
        let mut snapshot = self.snapshot.lock().unwrap();
        snapshot.pipelines_created = self.pipelines_created;
        match &self.current {
            Some(active) => {
                snapshot.program = Some(active.program.clone());
                snapshot.phase = Some(active.phase);
                snapshot.position = seconds(
                    active
                        .pipeline
                        .pipeline
                        .query_position::<gst::ClockTime>()
                        .or(active.last_position),
                );
                snapshot.duration = seconds(active.duration);
                snapshot.intent_playing = active.intent_playing;
                snapshot.frames_rendered = active.pipeline.frames.rendered.load(Ordering::Relaxed);
                snapshot.frames_presented =
                    active.pipeline.frames.presented.load(Ordering::Relaxed);
                snapshot.audio_sink = active.pipeline.audio_sink_factory.clone();
                snapshot.clock = active
                    .pipeline
                    .pipeline
                    .clock()
                    .map(|clock| clock.name().to_string());
                snapshot.decoders = active.pipeline.decoders();
                snapshot.video_decoders = active.pipeline.video_decoder_count();
                snapshot.dsp = active.pipeline.pitch.stats().snapshot();
            }
            None => {
                snapshot.program = None;
                snapshot.phase = None;
                snapshot.position = None;
                snapshot.duration = None;
                snapshot.intent_playing = false;
            }
        }
    }

    fn require_current(&self, program: &ProgramIdentity) -> Result<(), CommandError> {
        program.validate().map_err(CommandError::new)?;
        match &self.current {
            Some(active) if &active.program == program => Ok(()),
            Some(_) => Err(CommandError::new("stale-program")),
            None => Err(CommandError::new("no-program")),
        }
    }

    fn command(
        &mut self,
        command: Command,
        events: &EventSink,
    ) -> Result<CommandReceipt, CommandError> {
        let none = CommandReceipt::default();
        match command {
            Command::Load {
                program,
                media,
                start_seconds,
                play,
            } => self
                .load(program, media, start_seconds, play, events)
                .map(|seek_id| CommandReceipt { seek_id }),
            Command::Play { program } => {
                self.require_current(&program)?;
                self.set_intent(true).map(|()| none)
            }
            Command::Pause { program } => {
                self.require_current(&program)?;
                self.set_intent(false).map(|()| none)
            }
            Command::Seek {
                program,
                seconds,
                play,
            } => {
                self.require_current(&program)?;
                self.seek(seconds, play).map(|seek_id| CommandReceipt {
                    seek_id: Some(seek_id),
                })
            }
            Command::Settings(patch) => self.settings(patch).map(|()| none),
            Command::Stop { program } => {
                self.require_current(&program)?;
                self.retire_current(true);
                Ok(none)
            }
        }
    }

    fn load(
        &mut self,
        program: ProgramIdentity,
        media: MediaSource,
        start_seconds: f64,
        play: bool,
        events: &EventSink,
    ) -> Result<Option<u64>, CommandError> {
        program.validate_mountable().map_err(CommandError::new)?;
        media.validate().map_err(CommandError::new)?;
        if !start_seconds.is_finite() || start_seconds < 0.0 {
            return Err(CommandError::new("invalid-start"));
        }
        if let Some(active) = &self.current {
            if active.program.playback_generation > program.playback_generation {
                return Err(CommandError::new("stale-program"));
            }
        }
        // The previous pipeline retires before the new one opens its device:
        // there is never more than one executing program.
        self.retire_current(false);
        let token = self.next_token;
        self.next_token += 1;
        let initial_seek = start_seconds > 0.05;
        let built = pipeline::build(BuildContext {
            token,
            media: &media,
            audio: &self.config.audio,
            clock: self.config.clock,
            settings: self.settings,
            events: events.clone(),
            frame_sink: self.frame_sink.clone(),
            frame_sequence: self.frame_sequence.clone(),
            present: !initial_seek,
        })
        .map_err(CommandError::new)?;
        self.pipelines_created += 1;
        let now = Instant::now();
        let seek_id = if initial_seek {
            let id = self.next_seek;
            self.next_seek += 1;
            Some(id)
        } else {
            None
        };
        self.current = Some(Active {
            program,
            pipeline: built,
            phase: Phase::Loading,
            intent_playing: play,
            pending_seek: seek_id.map(|id| (start_seconds, id)),
            active_seek: None,
            segment_seqnum: None,
            eos_reported: false,
            sink_eos: [None, None],
            sink_eos_at: None,
            video_preroll: None,
            duration: None,
            pipeline_state: gst::State::Null,
            phase_since: now,
            last_position: None,
            last_progress: now,
            last_position_report: now,
            reported_position: None,
            stall_reported: false,
            ready_reported: false,
        });
        let result = self
            .current
            .as_ref()
            .unwrap()
            .pipeline
            .pipeline
            .set_state(gst::State::Paused);
        if result.is_err() {
            self.fail("state-change-failed", "pipeline could not preroll".into());
            return Ok(seek_id);
        }
        self.observe(ObservationKind::Loading);
        Ok(seek_id)
    }

    fn set_intent(&mut self, playing: bool) -> Result<(), CommandError> {
        let active = self.current.as_mut().unwrap();
        match active.phase {
            Phase::Failed => return Err(CommandError::new("program-failed")),
            Phase::Ended if playing => return Err(CommandError::new("program-ended")),
            _ => {}
        }
        active.intent_playing = playing;
        if matches!(active.phase, Phase::Paused | Phase::Playing | Phase::Ended) {
            let target = if playing {
                gst::State::Playing
            } else {
                gst::State::Paused
            };
            if active.pipeline.pipeline.set_state(target).is_err() {
                self.fail("state-change-failed", format!("{target:?}"));
                return Ok(());
            }
            if playing {
                active.pipeline.release_audio();
            }
            if !playing && active.phase == Phase::Playing {
                active.phase = Phase::Paused;
                active.phase_since = Instant::now();
                self.observe(ObservationKind::Paused);
            }
        }
        Ok(())
    }

    fn seek(&mut self, seconds: f64, play: Option<bool>) -> Result<u64, CommandError> {
        if !seconds.is_finite() || seconds < 0.0 {
            return Err(CommandError::new("invalid-seek"));
        }
        let seek_id = self.next_seek;
        self.next_seek += 1;
        let active = self.current.as_mut().unwrap();
        if active.phase == Phase::Failed {
            return Err(CommandError::new("program-failed"));
        }
        if let Some(play) = play {
            active.intent_playing = play;
        }
        let target = match active.duration {
            Some(duration) => seconds.min(duration.nseconds() as f64 / 1e9),
            None => seconds,
        };
        if matches!(active.phase, Phase::Loading | Phase::Seeking) {
            // Latest request wins; it is issued once the current one settles.
            // A superseded pending request settles together with it (its
            // waiter observes a settled id at or after its own).
            active.pending_seek = Some((target, seek_id));
            return Ok(seek_id);
        }
        self.issue_seek(target, seek_id);
        Ok(seek_id)
    }

    fn issue_seek(&mut self, seconds: f64, seek_id: u64) {
        let active = self.current.as_mut().unwrap();
        let position = gst::ClockTime::from_nseconds((seconds * 1e9) as u64);
        if !active.intent_playing && active.pipeline_state == gst::State::Playing {
            let _ = active.pipeline.pipeline.set_state(gst::State::Paused);
        }
        let event = gst::event::Seek::new(
            1.0,
            gst::SeekFlags::FLUSH | gst::SeekFlags::ACCURATE,
            gst::SeekType::Set,
            position,
            gst::SeekType::None,
            gst::ClockTime::NONE,
        );
        let seqnum = event.seqnum();
        if trace_enabled() {
            eprintln!("[engine] issue seek {seek_id} -> {seconds}s seqnum={seqnum:?}");
        }
        active.segment_seqnum = Some(seqnum);
        active.active_seek = Some(ActiveSeek {
            seek_id,
            seqnum,
            awaiting_preroll: false,
            awaiting_since: None,
        });
        active.eos_reported = false;
        active.sink_eos = [None, None];
        active.sink_eos_at = None;
        active.video_preroll = None;
        active.phase = Phase::Seeking;
        active.phase_since = Instant::now();
        active.last_position = Some(position);
        active.last_progress = Instant::now();
        active.stall_reported = false;
        if !active.pipeline.pipeline.send_event(event) {
            self.fail("seek-rejected", format!("{seconds}"));
        }
    }

    fn settings(&mut self, patch: SettingsPatch) -> Result<(), CommandError> {
        let mut next = self.settings;
        if let Some(volume) = patch.volume {
            if !volume.is_finite() || !(0.0..=MAX_VOLUME).contains(&volume) {
                return Err(CommandError::new("invalid-volume"));
            }
            next.volume = volume;
        }
        if let Some(muted) = patch.muted {
            next.muted = muted;
        }
        if let Some(key) = patch.key_shift {
            if !key.is_finite() || key.abs() > MAX_SEMITONES {
                return Err(CommandError::new("invalid-key-shift"));
            }
            next.key_shift = key;
        }
        if let Some(delay) = patch.av_delay_ms {
            if delay.abs() > MAX_AV_DELAY_MS {
                return Err(CommandError::new("invalid-av-delay"));
            }
            next.av_delay_ms = delay;
        }
        self.settings = next;
        if let Some(active) = &self.current {
            active.pipeline.apply(&next);
        }
        Ok(())
    }

    fn retire_current(&mut self, report: bool) {
        if let Some(active) = self.current.take() {
            active.pipeline.shutdown();
            self.frame_sink.clear();
            if report {
                self.observe_retired(active.program, ObservationKind::Stopped);
            } else {
                self.publish_snapshot();
            }
        }
    }

    fn fail(&mut self, code: &str, detail: String) {
        let Some(active) = self.current.as_mut() else {
            return;
        };
        if active.phase == Phase::Failed {
            return;
        }
        active.phase = Phase::Failed;
        active.intent_playing = false;
        active.pipeline.present.store(false, Ordering::Release);
        // Release devices immediately; the Host decides any recovery.
        let _ = active.pipeline.pipeline.set_state(gst::State::Null);
        self.observe(ObservationKind::Error {
            code: code.into(),
            fatal: true,
            detail,
        });
    }

    fn pipeline_event(&mut self, event: PipelineEvent) {
        match event {
            PipelineEvent::Bus { token, message } => {
                if self
                    .current
                    .as_ref()
                    .is_some_and(|active| active.pipeline.token == token)
                {
                    self.bus(message);
                }
            }
            PipelineEvent::SinkEos {
                token,
                sink,
                seqnum,
            } => {
                let Some(active) = self.current.as_mut() else {
                    return;
                };
                if active.pipeline.token != token {
                    return;
                }
                if active
                    .segment_seqnum
                    .is_some_and(|current| current != seqnum)
                {
                    return;
                }
                active.sink_eos[usize::from(sink == SinkKind::Audio)] = Some(seqnum);
                active.sink_eos_at.get_or_insert_with(Instant::now);
            }
            PipelineEvent::VideoPreroll { token, segment } => {
                let Some(active) = self.current.as_mut() else {
                    return;
                };
                if active.pipeline.token != token {
                    return;
                }
                active.video_preroll = Some(segment);
                let waiting = active
                    .active_seek
                    .as_ref()
                    .is_some_and(|seek| seek.awaiting_preroll && segment == Some(seek.seqnum));
                if waiting {
                    self.async_done();
                }
            }
        }
    }

    fn bus(&mut self, message: gst::Message) {
        if trace_enabled() {
            let active = self.current.as_ref().unwrap();
            eprintln!(
                "[engine] token={} phase={:?} {:?} seqnum={:?} src={:?} segment={:?}",
                active.pipeline.token,
                active.phase,
                message.type_(),
                message.seqnum(),
                message.src().map(|s| s.name().to_string()),
                active.segment_seqnum
            );
        }
        let is_pipeline = {
            let active = self.current.as_ref().unwrap();
            message.src().is_some_and(|source| {
                source == active.pipeline.pipeline.upcast_ref::<gst::Object>()
            })
        };
        match message.view() {
            gst::MessageView::Error(error) => {
                let source = message
                    .src()
                    .map(|s| s.path_string().to_string())
                    .unwrap_or_default();
                self.fail(
                    "pipeline-error",
                    format!("{source}: {} ({:?})", error.error(), error.debug()),
                );
            }
            gst::MessageView::StateChanged(change) if is_pipeline => {
                let active = self.current.as_mut().unwrap();
                active.pipeline_state = change.current();
                if change.current() == gst::State::Playing
                    && active.active_seek.is_none()
                    && active.pending_seek.is_none()
                    && active.phase == Phase::Paused
                {
                    active.phase = Phase::Playing;
                    active.phase_since = Instant::now();
                    active.last_progress = Instant::now();
                    self.observe(ObservationKind::Playing);
                }
            }
            gst::MessageView::AsyncDone(_) => self.async_done(),
            gst::MessageView::Eos(_) => self.eos(message.seqnum()),
            gst::MessageView::ClockLost(_) => {
                let active = self.current.as_mut().unwrap();
                // A new clock is selected by a PAUSED→PLAYING cycle. A user
                // pause intent must survive clock recovery.
                let _ = active.pipeline.pipeline.set_state(gst::State::Paused);
                if active.intent_playing {
                    let _ = active.pipeline.pipeline.set_state(gst::State::Playing);
                    active.pipeline.release_audio();
                }
                self.observe(ObservationKind::ClockLost);
            }
            gst::MessageView::Latency(_) => {
                let active = self.current.as_ref().unwrap();
                let _ = active.pipeline.pipeline.recalculate_latency();
            }
            gst::MessageView::DurationChanged(_) => {
                let active = self.current.as_mut().unwrap();
                if let Some(duration) = active.pipeline.pipeline.query_duration::<gst::ClockTime>()
                {
                    active.duration = Some(duration);
                }
            }
            _ => {}
        }
    }

    fn async_done(&mut self) {
        let active = self.current.as_mut().unwrap();
        if active.duration.is_none() {
            active.duration = active.pipeline.pipeline.query_duration::<gst::ClockTime>();
        }
        match active.phase {
            Phase::Loading | Phase::Seeking => {
                if let Some(seek) = active.active_seek.as_mut() {
                    // Settlement means the target frame is on screen: wait for
                    // the video preroll of exactly this seek's segment.
                    let grace_expired = seek
                        .awaiting_since
                        .is_some_and(|since| since.elapsed() >= PREROLL_GRACE);
                    if active.video_preroll != Some(Some(seek.seqnum)) && !grace_expired {
                        seek.awaiting_preroll = true;
                        seek.awaiting_since.get_or_insert_with(Instant::now);
                        return;
                    }
                }
                let settled = active.active_seek.take();
                if let Some((seconds, seek_id)) = active.pending_seek.take() {
                    if let Some(settled) = settled {
                        // The superseded request still completes for its caller.
                        let id = settled.seek_id;
                        self.observe(ObservationKind::SeekSettled { seek_id: id });
                    }
                    self.issue_seek(seconds, seek_id);
                    return;
                }
                let active = self.current.as_mut().unwrap();
                let linked = *active.pipeline.linked.lock().unwrap();
                if !linked[0] || !linked[1] {
                    let missing = if linked[0] { "audio" } else { "video" };
                    self.fail("missing-stream", format!("no decodable {missing} stream"));
                    return;
                }
                active.pipeline.present.store(true, Ordering::Release);
                active.phase = Phase::Paused;
                active.phase_since = Instant::now();
                active.last_progress = Instant::now();
                if !active.ready_reported {
                    active.ready_reported = true;
                    self.observe(ObservationKind::Ready);
                }
                if let Some(settled) = settled {
                    self.observe(ObservationKind::SeekSettled {
                        seek_id: settled.seek_id,
                    });
                }
                let active = self.current.as_mut().unwrap();
                if active.intent_playing {
                    if active.pipeline_state == gst::State::Playing {
                        // A flushing seek in PLAYING resumes by itself.
                        active.phase = Phase::Playing;
                        active.phase_since = Instant::now();
                        self.observe(ObservationKind::Playing);
                    } else if active
                        .pipeline
                        .pipeline
                        .set_state(gst::State::Playing)
                        .is_err()
                    {
                        self.fail("state-change-failed", "Playing".into());
                    } else {
                        active.pipeline.release_audio();
                    }
                } else if active.pipeline_state == gst::State::Playing {
                    let _ = active.pipeline.pipeline.set_state(gst::State::Paused);
                    self.observe(ObservationKind::Paused);
                } else {
                    self.observe(ObservationKind::Paused);
                }
            }
            _ => {}
        }
    }

    fn eos(&mut self, seqnum: gst::Seqnum) {
        let active = self.current.as_mut().unwrap();
        if active.eos_reported
            || matches!(
                active.phase,
                Phase::Failed | Phase::Loading | Phase::Seeking
            )
            || active
                .segment_seqnum
                .is_some_and(|current| current != seqnum)
        {
            return;
        }
        self.complete(false);
    }

    fn complete(&mut self, watchdog: bool) {
        let active = self.current.as_mut().unwrap();
        active.eos_reported = true;
        active.intent_playing = false;
        active.phase = Phase::Ended;
        active.phase_since = Instant::now();
        self.observe(ObservationKind::Eos {
            drained: true,
            watchdog,
        });
    }

    fn tick(&mut self) {
        let Some(active) = self.current.as_mut() else {
            return;
        };
        let now = Instant::now();
        if active.active_seek.as_ref().is_some_and(|seek| {
            seek.awaiting_preroll
                && seek
                    .awaiting_since
                    .is_some_and(|since| now.duration_since(since) >= PREROLL_GRACE)
        }) {
            self.async_done();
            return;
        }
        if matches!(active.phase, Phase::Loading | Phase::Seeking)
            && now.duration_since(active.phase_since) > PREROLL_DEADLINE
        {
            let code = if active.phase == Phase::Loading {
                "preroll-timeout"
            } else {
                "seek-timeout"
            };
            self.fail(code, "no preroll before deadline".into());
            return;
        }
        if !matches!(active.phase, Phase::Playing | Phase::Paused) {
            return;
        }
        let position = active.pipeline.pipeline.query_position::<gst::ClockTime>();
        if position.is_some() && position != active.last_position {
            active.last_position = position;
            active.last_progress = now;
            active.stall_reported = false;
        }
        let playing = active.phase == Phase::Playing && active.intent_playing;
        let stalled_for = now.duration_since(active.last_progress);
        if playing
            && !active.eos_reported
            && active.sink_eos.iter().any(Option::is_some)
            && stalled_for > EOS_STALL_DEADLINE
        {
            // One sink drained and the clock no longer advances: never wait
            // forever for the other branch.
            self.complete(true);
            return;
        }
        if playing && !active.stall_reported && stalled_for > STALL_DEADLINE {
            active.stall_reported = true;
            self.observe(ObservationKind::Error {
                code: "stalled".into(),
                fatal: false,
                detail: format!("position unchanged for {} ms", stalled_for.as_millis()),
            });
            return;
        }
        let active = self.current.as_mut().unwrap();
        let due = now.duration_since(active.last_position_report) >= POSITION_INTERVAL;
        if due && active.reported_position != active.last_position {
            active.last_position_report = now;
            active.reported_position = active.last_position;
            self.observe(ObservationKind::Position);
        }
    }
}

/// Serializable command error/observation helpers for bridges.
pub fn observation_json(observation: &Observation) -> Value {
    serde_json::to_value(observation).unwrap_or_else(|_| json!({"type":"error"}))
}
