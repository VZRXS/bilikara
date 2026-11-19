//! Pinned Signalsmith pitch processor as a GStreamer element.
//!
//! The processor has a fixed look-ahead of `L` frames. Instead of hiding that
//! delay behind sink offsets, the element primes the stretcher with the first
//! `L` input frames, stamps every output buffer with the input timeline and
//! drains exactly `L` zero frames at EOS. The output therefore has the same
//! number of frames and the same timestamps as the input: the beginning and the
//! end of a track are preserved and audio stays aligned with video without any
//! latency compensation. Processing is in place with one persistent scratch
//! buffer, so steady-state playback performs no heap allocation.
use gst::glib;
use gst::prelude::*;
use gst::subclass::prelude::*;
use gstreamer as gst;
use std::ffi::c_void;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

pub const RATE: u64 = 48_000;
pub const CHANNELS: usize = 2;
const FRAME_BYTES: usize = CHANNELS * 4;
/// `bm_stretch_process_v1` accepts at most 4096 output frames per call.
const MAX_CHUNK: usize = 4096;
pub const MAX_SEMITONES: f32 = 12.0;

unsafe extern "C" {
    fn bm_stretch_new_v1() -> *mut c_void;
    fn bm_stretch_free_v1(voice: *mut c_void);
    fn bm_stretch_latency_v1(voice: *mut c_void) -> u32;
    fn bm_stretch_prime_v1(voice: *mut c_void, input: *const f32, frames: u32, key: f32) -> i32;
    fn bm_stretch_process_v1(
        voice: *mut c_void,
        input: *const f32,
        input_frames: u32,
        output: *mut f32,
        output_frames: u32,
        key: f32,
    ) -> i32;
}

/// Owned stretcher; only the element's state mutex touches it.
struct Voice(*mut c_void);
// SAFETY: the pointer is exclusively owned and accessed under one mutex.
unsafe impl Send for Voice {}

impl Voice {
    fn new() -> Option<Self> {
        let pointer = unsafe { bm_stretch_new_v1() };
        (!pointer.is_null()).then_some(Self(pointer))
    }
    fn latency(&self) -> usize {
        unsafe { bm_stretch_latency_v1(self.0) as usize }
    }
    fn prime(&mut self, input: &[f32], key: f32) -> bool {
        let frames = (input.len() / CHANNELS) as u32;
        unsafe { bm_stretch_prime_v1(self.0, input.as_ptr(), frames, key) == 0 }
    }
    fn process(&mut self, input: &[f32], output: &mut [f32], key: f32) -> bool {
        debug_assert_eq!(input.len(), output.len());
        for (source, target) in input
            .chunks(MAX_CHUNK * CHANNELS)
            .zip(output.chunks_mut(MAX_CHUNK * CHANNELS))
        {
            let frames = (source.len() / CHANNELS) as u32;
            let status = unsafe {
                bm_stretch_process_v1(
                    self.0,
                    source.as_ptr(),
                    frames,
                    target.as_mut_ptr(),
                    frames,
                    key,
                )
            };
            if status != 0 {
                return false;
            }
        }
        true
    }
}

impl Drop for Voice {
    fn drop(&mut self) {
        unsafe { bm_stretch_free_v1(self.0) }
    }
}

/// Reproducible processing counters; read by the engine's snapshot.
#[derive(Default)]
pub struct PitchStats {
    pub process_calls: AtomicU64,
    pub processed_frames: AtomicU64,
    pub copied_bytes: AtomicU64,
    /// Heap allocations made by the element itself after start: stretcher
    /// creation, scratch growth, writable copies of shared input buffers and
    /// one tail buffer per drained EOS.
    pub allocations: AtomicU64,
    pub buffer_copies: AtomicU64,
    pub tails: AtomicU64,
    pub resets: AtomicU64,
}

impl PitchStats {
    pub fn snapshot(&self) -> serde_json::Value {
        serde_json::json!({
            "process_calls": self.process_calls.load(Ordering::Relaxed),
            "processed_frames": self.processed_frames.load(Ordering::Relaxed),
            "copied_bytes": self.copied_bytes.load(Ordering::Relaxed),
            "allocations": self.allocations.load(Ordering::Relaxed),
            "shared_input_copies": self.buffer_copies.load(Ordering::Relaxed),
            "drained_tails": self.tails.load(Ordering::Relaxed),
            "resets": self.resets.load(Ordering::Relaxed),
        })
    }
}

struct State {
    voice: Option<Voice>,
    latency: usize,
    priming: Vec<f32>,
    primed: bool,
    origin: Option<gst::ClockTime>,
    frames_out: u64,
    scratch: Vec<f32>,
    discont: bool,
}

impl State {
    fn new() -> Self {
        Self {
            voice: None,
            latency: 0,
            priming: Vec::new(),
            primed: false,
            origin: None,
            frames_out: 0,
            scratch: Vec::new(),
            discont: true,
        }
    }
}

mod imp {
    use super::*;

    pub struct PitchShift {
        pub(super) sinkpad: gst::Pad,
        pub(super) srcpad: gst::Pad,
        pub(super) key: AtomicU32,
        pub(super) stats: OnceLock<Arc<PitchStats>>,
        state: Mutex<State>,
    }

    impl PitchShift {
        pub(super) fn stats(&self) -> &Arc<PitchStats> {
            self.stats.get_or_init(Default::default)
        }

        fn key(&self) -> f32 {
            f32::from_bits(self.key.load(Ordering::Relaxed))
        }

        fn ensure_voice(&self, state: &mut State) -> Result<(), gst::FlowError> {
            if state.voice.is_none() {
                let voice = Voice::new().ok_or(gst::FlowError::Error)?;
                state.latency = voice.latency();
                if state.latency == 0 || state.latency > 1 << 16 {
                    return Err(gst::FlowError::NotNegotiated);
                }
                state.voice = Some(voice);
                if state.priming.capacity() < state.latency * CHANNELS * 2 {
                    state.priming.reserve(state.latency * CHANNELS * 2);
                    self.stats().allocations.fetch_add(1, Ordering::Relaxed);
                }
                self.stats().allocations.fetch_add(1, Ordering::Relaxed);
            }
            Ok(())
        }

        pub(super) fn reset(&self) {
            let mut state = self.state.lock().unwrap();
            state.voice = None;
            state.priming.clear();
            state.primed = false;
            state.origin = None;
            state.frames_out = 0;
            state.discont = true;
            self.stats().resets.fetch_add(1, Ordering::Relaxed);
        }

        fn pts_for(state: &State, frame: u64) -> Option<gst::ClockTime> {
            let offset = frame
                .mul_div_floor(gst::ClockTime::SECOND.nseconds(), RATE)
                .map(gst::ClockTime::from_nseconds)?;
            state.origin.map(|origin| origin + offset)
        }

        fn stamp(state: &mut State, buffer: &mut gst::BufferRef, frames: usize) {
            let start = Self::pts_for(state, state.frames_out);
            let end = Self::pts_for(state, state.frames_out + frames as u64);
            buffer.set_pts(start);
            buffer.set_dts(gst::ClockTime::NONE);
            buffer.set_duration(start.zip(end).map(|(start, end)| end - start));
            buffer.set_offset(state.frames_out);
            buffer.set_offset_end(state.frames_out + frames as u64);
            if std::mem::take(&mut state.discont) {
                buffer.set_flags(gst::BufferFlags::DISCONT);
            } else {
                buffer.unset_flags(gst::BufferFlags::DISCONT);
            }
            state.frames_out += frames as u64;
        }

        fn sink_chain(
            &self,
            _pad: &gst::Pad,
            mut buffer: gst::Buffer,
        ) -> Result<gst::FlowSuccess, gst::FlowError> {
            let key = self.key();
            let stats = self.stats().clone();
            let mut guard = self.state.lock().unwrap();
            let state = &mut *guard;
            self.ensure_voice(state)?;
            if state.origin.is_none() {
                state.origin = buffer.pts();
                if state.origin.is_none() {
                    return Err(gst::FlowError::Error);
                }
            }
            let bytes = buffer.size();
            if !bytes.is_multiple_of(FRAME_BYTES) {
                return Err(gst::FlowError::NotNegotiated);
            }
            let frames = bytes / FRAME_BYTES;
            if frames == 0 {
                return Ok(gst::FlowSuccess::Ok);
            }
            let samples = frames * CHANNELS;
            if state.scratch.capacity() < samples {
                state.scratch.reserve(samples - state.scratch.len());
                stats.allocations.fetch_add(1, Ordering::Relaxed);
            }
            state.scratch.clear();
            {
                let map = buffer.map_readable().map_err(|_| gst::FlowError::Error)?;
                state.scratch.extend(
                    map.as_slice()
                        .chunks_exact(4)
                        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])),
                );
            }
            stats
                .copied_bytes
                .fetch_add(bytes as u64, Ordering::Relaxed);
            let latency = state.latency;
            let (output_from, output_frames) = if state.primed {
                (0usize, frames)
            } else {
                let needed = latency * CHANNELS - state.priming.len();
                let taken = needed.min(samples);
                let scratch = std::mem::take(&mut state.scratch);
                state.priming.extend_from_slice(&scratch[..taken]);
                state.scratch = scratch;
                if state.priming.len() < latency * CHANNELS {
                    return Ok(gst::FlowSuccess::Ok);
                }
                let priming = std::mem::take(&mut state.priming);
                let voice = state.voice.as_mut().unwrap();
                if !voice.prime(&priming, key) {
                    state.priming = priming;
                    return Err(gst::FlowError::Error);
                }
                state.priming = priming;
                state.priming.clear();
                state.primed = true;
                (taken, frames - taken / CHANNELS)
            };
            if output_frames == 0 {
                return Ok(gst::FlowSuccess::Ok);
            }
            if !buffer.is_writable() {
                stats.buffer_copies.fetch_add(1, Ordering::Relaxed);
                stats.allocations.fetch_add(1, Ordering::Relaxed);
            }
            let out = buffer.make_mut();
            out.set_size(output_frames * FRAME_BYTES);
            {
                let mut map = out.map_writable().map_err(|_| gst::FlowError::Error)?;
                let target = map.as_mut_slice();
                let (prefix, aligned, suffix) = unsafe { target.align_to_mut::<f32>() };
                let input = &state.scratch[output_from..output_from + output_frames * CHANNELS];
                let voice = state.voice.as_mut().unwrap();
                if prefix.is_empty() && suffix.is_empty() {
                    if !voice.process(input, aligned, key) {
                        return Err(gst::FlowError::Error);
                    }
                } else {
                    // Rare unaligned memory: process into a temporary block.
                    let mut temporary = vec![0f32; input.len()];
                    stats.allocations.fetch_add(1, Ordering::Relaxed);
                    if !voice.process(input, &mut temporary, key) {
                        return Err(gst::FlowError::Error);
                    }
                    for (bytes, value) in target.chunks_exact_mut(4).zip(temporary) {
                        bytes.copy_from_slice(&value.to_le_bytes());
                    }
                }
            }
            stats
                .process_calls
                .fetch_add(output_frames.div_ceil(MAX_CHUNK) as u64, Ordering::Relaxed);
            stats
                .processed_frames
                .fetch_add(output_frames as u64, Ordering::Relaxed);
            Self::stamp(state, out, output_frames);
            drop(guard);
            self.srcpad.push(buffer)
        }

        /// Produces the final `L` frames (or a short stream's frames) by feeding
        /// zeros. Returns `None` when nothing was pending.
        fn drain(&self) -> Result<Option<gst::Buffer>, gst::FlowError> {
            let key = self.key();
            let stats = self.stats().clone();
            let mut guard = self.state.lock().unwrap();
            let state = &mut *guard;
            if state.voice.is_none() || state.origin.is_none() {
                return Ok(None);
            }
            let latency = state.latency;
            let pending = if state.primed {
                latency
            } else {
                let pending = state.priming.len() / CHANNELS;
                if pending == 0 {
                    return Ok(None);
                }
                state.priming.resize(latency * CHANNELS, 0.0);
                let priming = std::mem::take(&mut state.priming);
                let ok = state.voice.as_mut().unwrap().prime(&priming, key);
                state.priming = priming;
                state.priming.clear();
                if !ok {
                    return Err(gst::FlowError::Error);
                }
                state.primed = true;
                pending
            };
            state.scratch.clear();
            state.scratch.resize(latency * CHANNELS, 0.0);
            let mut tail =
                gst::Buffer::with_size(latency * FRAME_BYTES).map_err(|_| gst::FlowError::Error)?;
            stats.allocations.fetch_add(1, Ordering::Relaxed);
            {
                let out = tail.get_mut().unwrap();
                {
                    let mut map = out.map_writable().map_err(|_| gst::FlowError::Error)?;
                    let mut processed = vec![0f32; latency * CHANNELS];
                    stats.allocations.fetch_add(1, Ordering::Relaxed);
                    if !state
                        .voice
                        .as_mut()
                        .unwrap()
                        .process(&state.scratch, &mut processed, key)
                    {
                        return Err(gst::FlowError::Error);
                    }
                    for (bytes, value) in map.as_mut_slice().chunks_exact_mut(4).zip(processed) {
                        bytes.copy_from_slice(&value.to_le_bytes());
                    }
                }
                out.set_size(pending * FRAME_BYTES);
                Self::stamp(state, out, pending);
            }
            stats.tails.fetch_add(1, Ordering::Relaxed);
            stats
                .processed_frames
                .fetch_add(pending as u64, Ordering::Relaxed);
            // The stretcher is spent; a following segment primes a new one.
            state.voice = None;
            state.primed = false;
            Ok(Some(tail))
        }

        fn sink_event(&self, _pad: &gst::Pad, event: gst::Event) -> bool {
            match event.view() {
                gst::EventView::FlushStop(_) => {
                    self.reset();
                    self.srcpad.push_event(event)
                }
                gst::EventView::Segment(_) => {
                    // A new segment always starts a new stretcher timeline.
                    let mut state = self.state.lock().unwrap();
                    state.voice = None;
                    state.priming.clear();
                    state.primed = false;
                    state.origin = None;
                    state.frames_out = 0;
                    state.discont = true;
                    drop(state);
                    self.srcpad.push_event(event)
                }
                gst::EventView::Eos(_) => {
                    match self.drain() {
                        Ok(Some(tail)) => {
                            if let Err(error) = self.srcpad.push(tail) {
                                // Flushing cancels the drain; never forward a
                                // completion that did not deliver its tail.
                                if error != gst::FlowError::Flushing {
                                    gst::element_imp_error!(
                                        self,
                                        gst::StreamError::Failed,
                                        ["DSP tail push failed: {error:?}"]
                                    );
                                }
                                return false;
                            }
                        }
                        Ok(None) => {}
                        Err(_) => {
                            gst::element_imp_error!(
                                self,
                                gst::StreamError::Failed,
                                ["DSP tail processing failed"]
                            );
                            return false;
                        }
                    }
                    self.srcpad.push_event(event)
                }
                _ => self.srcpad.push_event(event),
            }
        }

        fn sink_query(&self, _pad: &gst::Pad, query: &mut gst::QueryRef) -> bool {
            self.srcpad.peer_query(query)
        }

        fn src_event(&self, _pad: &gst::Pad, event: gst::Event) -> bool {
            self.sinkpad.push_event(event)
        }

        fn src_query(&self, _pad: &gst::Pad, query: &mut gst::QueryRef) -> bool {
            self.sinkpad.peer_query(query)
        }
    }

    #[glib::object_subclass]
    impl ObjectSubclass for PitchShift {
        const NAME: &'static str = "BilikaraPitchShift";
        type Type = super::PitchShift;
        type ParentType = gst::Element;

        fn with_class(klass: &Self::Class) -> Self {
            let templ = klass.pad_template("sink").unwrap();
            let sinkpad = gst::Pad::builder_from_template(&templ)
                .chain_function(|pad, parent, buffer| {
                    PitchShift::catch_panic_pad_function(
                        parent,
                        || Err(gst::FlowError::Error),
                        |this| this.sink_chain(pad, buffer),
                    )
                })
                .event_function(|pad, parent, event| {
                    PitchShift::catch_panic_pad_function(
                        parent,
                        || false,
                        |this| this.sink_event(pad, event),
                    )
                })
                .query_function(|pad, parent, query| {
                    PitchShift::catch_panic_pad_function(
                        parent,
                        || false,
                        |this| this.sink_query(pad, query),
                    )
                })
                .flags(gst::PadFlags::PROXY_CAPS | gst::PadFlags::PROXY_ALLOCATION)
                .build();
            let templ = klass.pad_template("src").unwrap();
            let srcpad = gst::Pad::builder_from_template(&templ)
                .event_function(|pad, parent, event| {
                    PitchShift::catch_panic_pad_function(
                        parent,
                        || false,
                        |this| this.src_event(pad, event),
                    )
                })
                .query_function(|pad, parent, query| {
                    PitchShift::catch_panic_pad_function(
                        parent,
                        || false,
                        |this| this.src_query(pad, query),
                    )
                })
                .flags(gst::PadFlags::PROXY_CAPS | gst::PadFlags::PROXY_ALLOCATION)
                .build();
            Self {
                sinkpad,
                srcpad,
                key: AtomicU32::new(0f32.to_bits()),
                stats: OnceLock::new(),
                state: Mutex::new(State::new()),
            }
        }
    }

    impl ObjectImpl for PitchShift {
        fn constructed(&self) {
            self.parent_constructed();
            let element = self.obj();
            element.add_pad(&self.sinkpad).unwrap();
            element.add_pad(&self.srcpad).unwrap();
        }
    }

    impl GstObjectImpl for PitchShift {}

    impl ElementImpl for PitchShift {
        fn metadata() -> Option<&'static gst::subclass::ElementMetadata> {
            static METADATA: OnceLock<gst::subclass::ElementMetadata> = OnceLock::new();
            Some(METADATA.get_or_init(|| {
                gst::subclass::ElementMetadata::new(
                    "bilikara pitch shift",
                    "Filter/Effect/Audio",
                    "Pinned Signalsmith pitch shift with exact start/tail preservation",
                    "bilikara",
                )
            }))
        }

        fn pad_templates() -> &'static [gst::PadTemplate] {
            static TEMPLATES: OnceLock<Vec<gst::PadTemplate>> = OnceLock::new();
            TEMPLATES.get_or_init(|| {
                let caps = super::caps();
                vec![
                    gst::PadTemplate::new(
                        "src",
                        gst::PadDirection::Src,
                        gst::PadPresence::Always,
                        &caps,
                    )
                    .unwrap(),
                    gst::PadTemplate::new(
                        "sink",
                        gst::PadDirection::Sink,
                        gst::PadPresence::Always,
                        &caps,
                    )
                    .unwrap(),
                ]
            })
        }

        fn change_state(
            &self,
            transition: gst::StateChange,
        ) -> Result<gst::StateChangeSuccess, gst::StateChangeError> {
            if matches!(
                transition,
                gst::StateChange::ReadyToPaused | gst::StateChange::PausedToReady
            ) {
                self.reset();
            }
            self.parent_change_state(transition)
        }
    }
}

glib::wrapper! {
    pub struct PitchShift(ObjectSubclass<imp::PitchShift>) @extends gst::Element, gst::Object;
}

/// The only format the element accepts; upstream converts before it.
pub fn caps() -> gst::Caps {
    gst::Caps::builder("audio/x-raw")
        .field("format", "F32LE")
        .field("layout", "interleaved")
        .field("rate", RATE as i32)
        .field("channels", CHANNELS as i32)
        .build()
}

impl PitchShift {
    pub fn new(name: &str) -> Self {
        glib::Object::builder().property("name", name).build()
    }

    pub fn set_semitones(&self, semitones: f32) -> bool {
        if !semitones.is_finite() || semitones.abs() > MAX_SEMITONES {
            return false;
        }
        self.imp().key.store(semitones.to_bits(), Ordering::Relaxed);
        true
    }

    pub fn semitones(&self) -> f32 {
        f32::from_bits(self.imp().key.load(Ordering::Relaxed))
    }

    pub fn stats(&self) -> Arc<PitchStats> {
        self.imp().stats().clone()
    }
}

/// Latency of the pinned stretcher in frames (diagnostic only).
pub fn latency_frames() -> Option<usize> {
    Voice::new().map(|voice| voice.latency())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(frames: usize, from: usize, hz: f32, amplitude: f32) -> Vec<f32> {
        let mut data = vec![0f32; frames * CHANNELS];
        for frame in from..frames {
            let value = amplitude * (std::f32::consts::TAU * hz * frame as f32 / RATE as f32).sin();
            data[frame * 2] = value;
            data[frame * 2 + 1] = value;
        }
        data
    }

    fn rms(samples: &[f32]) -> f64 {
        (samples.iter().map(|s| f64::from(*s).powi(2)).sum::<f64>() / samples.len().max(1) as f64)
            .sqrt()
    }

    #[test]
    fn priming_and_tail_preserve_every_input_frame() {
        let mut voice = Voice::new().unwrap();
        let latency = voice.latency();
        assert!(latency > 0);
        // Tone only in the final 4000 frames: it can only appear via the tail.
        let frames = 24_000;
        let input = tone(frames, frames - 4000, 440.0, 0.25);
        assert!(voice.prime(&input[..latency * CHANNELS], 0.0));
        let mut output = vec![0f32; (frames - latency) * CHANNELS];
        assert!(voice.process(&input[latency * CHANNELS..], &mut output, 0.0));
        let zeros = vec![0f32; latency * CHANNELS];
        let mut tail = vec![0f32; latency * CHANNELS];
        assert!(voice.process(&zeros, &mut tail, 0.0));
        let mut all = output;
        all.extend_from_slice(&tail);
        assert_eq!(all.len(), input.len(), "output frame count equals input");
        let silent = rms(&all[..(frames - 6000) * CHANNELS]);
        let toned = rms(&all[(frames - 3500) * CHANNELS..]);
        assert!(silent < 0.01, "no tone before its input position: {silent}");
        assert!(toned > 0.05, "last input frames survive the drain: {toned}");
    }

    #[test]
    fn invalid_semitones_are_rejected() {
        gst::init().unwrap();
        let element = PitchShift::new("p");
        assert!(element.set_semitones(2.0));
        assert!(!element.set_semitones(f32::NAN));
        assert!(!element.set_semitones(13.0));
        assert_eq!(element.semitones(), 2.0);
    }
}
