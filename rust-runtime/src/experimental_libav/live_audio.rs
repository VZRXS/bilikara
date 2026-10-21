//! Optional L1 media adapter. User controls come from AppState; DSP buffering
//! and source cursors belong only to this synchronous output invocation.
use super::{LibavMetadataProbe, ProbeError};
use bilikara_rust::output_audio::OffsetMode;
use std::{path::Path, sync::atomic::AtomicBool};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Control {
    pub offset_ms: i32,
    pub key_shift: i32,
    pub volume_percent: i32,
    pub muted: bool,
    pub track: usize,
    pub mode: OffsetMode,
}

#[cfg(all(
    test,
    any(
        target_os = "android",
        target_os = "linux",
        target_os = "windows",
        target_os = "macos"
    )
))]
mod tests {
    use super::*;
    #[test]
    #[ignore = "requires actual L1 companion; npm run test:purek-l1 supplies inputs"]
    fn real_l1_tracks_offsets_pitch_gain_and_resampling_keep_one_ts_clock() {
        let companion =
            std::env::var_os("BILIKARA_TEST_LIBAV_COMPANION").expect("L1 companion required");
        let probe = unsafe { LibavMetadataProbe::load(Path::new(&companion)) }.unwrap();
        assert!(probe.live_l1_available());
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("tests/fixtures/bbdown");
        let directory = std::path::PathBuf::from(
            std::env::var_os("BILIKARA_TEST_L1_OUTPUT").expect("owned output directory"),
        );
        std::fs::create_dir_all(&directory).unwrap();
        for mode in [OffsetMode::Splice, OffsetMode::Gradual] {
            let mut frame = 0;
            let mut keys = 0;
            let mut bytes = Vec::new();
            let mut last = 0;
            let mut controls = || {
                let step = frame;
                frame += 1;
                Ok(Control {
                    offset_ms: match step {
                        0..6 => 0,
                        6..12 => 150,
                        12..18 => 0,
                        18..36 => -150,
                        _ => 0,
                    },
                    key_shift: if step >= 28 { 2 } else { 0 },
                    volume_percent: if step >= 30 { 50 } else { 100 },
                    muted: (36..40).contains(&step),
                    track: usize::from(step >= 24),
                    mode,
                })
            };
            probe
                .render_live_ts(
                    &fixture.join("video-reordered-start.mp4"),
                    &[&fixture.join("audio.m4a"), &fixture.join("audio-flac.mp4")],
                    0,
                    &AtomicBool::new(false),
                    &mut |chunk, time, key| {
                        assert!(time >= last);
                        last = time;
                        keys += usize::from(key);
                        bytes.extend_from_slice(chunk);
                        bytes.len() < 4 * 1024 * 1024
                    },
                    &mut controls,
                )
                .unwrap();
            assert!(frame > 40);
            assert!(keys >= 1);
            assert_eq!(bytes.len() % 188, 0);
            let output = directory.join(if mode == OffsetMode::Splice {
                "splice.ts"
            } else {
                "gradual.ts"
            });
            std::fs::write(&output, &bytes).unwrap();
            let facts = super::super::live_ts::inspect(&probe, &output);
            assert_eq!(facts.status, 0, "{facts:?}");
            assert_eq!(facts.complete, 1);
            assert_eq!(facts.packets[0], 24);
            assert!(facts.packets[1] > 40);
            assert!(
                (facts.max_pts[0] - facts.max_pts[1]).abs() < 100_000,
                "{facts:?}"
            );
            assert!(facts.first_dts.iter().all(|t| *t >= 0));
        }
        // Exercise native encoder/decoder/DSP cleanup before start, after live
        // bytes, and when a Rust control callback unwinds at the FFI boundary.
        for stage in 0..3 {
            let stop = AtomicBool::new(stage == 0);
            let mut delivered = 0;
            let result = probe.render_live_ts(
                &fixture.join("video-reordered-start.mp4"),
                &[&fixture.join("audio.m4a")],
                0,
                &stop,
                &mut |_, _, _| {
                    delivered += 1;
                    if stage == 1 {
                        stop.store(true, std::sync::atomic::Ordering::Release);
                    }
                    true
                },
                &mut || {
                    assert_ne!(stage, 2, "synthetic control failure");
                    Ok(Control {
                        offset_ms: 0,
                        key_shift: 0,
                        volume_percent: 100,
                        muted: false,
                        track: 0,
                        mode: OffsetMode::Splice,
                    })
                },
            );
            if stage == 2 {
                assert!(
                    result
                        .unwrap_err()
                        .to_string()
                        .contains("L1 renderer panic")
                );
            } else {
                assert!(matches!(result, Err(ProbeError::Cancelled)));
                assert_eq!(delivered > 0, stage == 1);
            }
        }
    }
}

impl LibavMetadataProbe {
    pub fn live_l1_available(&self) -> bool {
        #[cfg(any(
            target_os = "android",
            target_os = "linux",
            target_os = "windows",
            target_os = "macos"
        ))]
        {
            native::Capability::load(&self._library).is_ok()
        }
        #[cfg(not(any(
            target_os = "android",
            target_os = "linux",
            target_os = "windows",
            target_os = "macos"
        )))]
        {
            false
        }
    }
    pub fn render_live_ts(
        &self,
        video: &Path,
        audio: &[&Path],
        start_us: i64,
        stop: &AtomicBool,
        visit: &mut dyn FnMut(&[u8], i64, bool) -> bool,
        controls: &mut dyn FnMut() -> Result<Control, ProbeError>,
    ) -> Result<(), ProbeError> {
        #[cfg(any(
            target_os = "android",
            target_os = "linux",
            target_os = "windows",
            target_os = "macos"
        ))]
        {
            native::run(self, video, audio, start_us, stop, visit, controls)
        }
        #[cfg(not(any(
            target_os = "android",
            target_os = "linux",
            target_os = "windows",
            target_os = "macos"
        )))]
        {
            let _ = (video, audio, start_us, stop, visit, controls);
            Err(ProbeError::Unavailable("L1 platform not packaged".into()))
        }
    }
}

#[cfg(any(
    target_os = "android",
    target_os = "linux",
    target_os = "windows",
    target_os = "macos"
))]
mod native {
    use super::*;
    use crate::experimental_libav::{backend_error, open_input, status_error, wire};
    use bilikara_rust::output_audio::{self as policy, Transition};
    use std::{
        ffi::c_void,
        mem::{size_of, transmute},
        sync::atomic::{AtomicBool, Ordering},
    };
    type Read = unsafe extern "C" fn(*mut c_void, u32, i64, u32, *mut f32) -> i32;
    #[repr(C)]
    struct Info {
        schema: u32,
        request_size: u32,
        result_size: u32,
    }
    #[repr(C)]
    struct Live {
        video: wire::Request,
        audio: wire::Request,
        start_us: i64,
        visit: extern "C" fn(*mut c_void, *const u8, u32, i64, u32) -> i32,
        opaque: *mut c_void,
    }
    #[repr(C)]
    struct Request {
        live: Live,
        audio: [wire::Request; 2],
        tracks: u32,
        render: extern "C" fn(*mut c_void, Read, *mut c_void, i64, i64, u32, *mut f32) -> i32,
        opaque: *mut c_void,
    }
    #[repr(C)]
    #[derive(Default)]
    struct ResultData {
        status: u32,
        complete: u32,
        packets: u64,
        bytes: u64,
    }
    #[derive(Clone, Copy)]
    struct Dsp {
        create: unsafe extern "C" fn() -> *mut c_void,
        free: unsafe extern "C" fn(*mut c_void),
        latency: unsafe extern "C" fn(*mut c_void) -> u32,
        prime: unsafe extern "C" fn(*mut c_void, *const f32, u32, f32) -> i32,
        process: unsafe extern "C" fn(*mut c_void, *const f32, u32, *mut f32, u32, f32) -> i32,
    }
    pub(super) struct Capability {
        run: unsafe extern "C" fn(*const Request, *mut ResultData) -> u32,
        dsp: Dsp,
    }
    impl Capability {
        pub(super) fn load(library: &wire::Library) -> Result<Self, ProbeError> {
            // SAFETY: only a trusted companion selected by startup is loaded.
            unsafe {
                let get: unsafe extern "C" fn(u32, *mut Info) -> u32 =
                    transmute(library.symbol(c"bm_l1_info_v1")?);
                let mut info = Info {
                    schema: 0,
                    request_size: 0,
                    result_size: 0,
                };
                if get(size_of::<Info>() as u32, &mut info) != 0
                    || info.schema != 1
                    || info.request_size as usize != size_of::<Request>()
                    || info.result_size as usize != size_of::<ResultData>()
                {
                    return Err(backend_error("L1 capability unavailable"));
                }
                Ok(Self {
                    run: transmute::<
                        *mut c_void,
                        unsafe extern "C" fn(*const Request, *mut ResultData) -> u32,
                    >(library.symbol(c"bm_live_l1_v1")?),
                    dsp: Dsp {
                        create: transmute::<*mut c_void, unsafe extern "C" fn() -> *mut c_void>(
                            library.symbol(c"bm_stretch_new_v1")?,
                        ),
                        free: transmute::<*mut c_void, unsafe extern "C" fn(*mut c_void)>(
                            library.symbol(c"bm_stretch_free_v1")?,
                        ),
                        latency: transmute::<*mut c_void, unsafe extern "C" fn(*mut c_void) -> u32>(
                            library.symbol(c"bm_stretch_latency_v1")?,
                        ),
                        prime: transmute::<
                            *mut c_void,
                            unsafe extern "C" fn(*mut c_void, *const f32, u32, f32) -> i32,
                        >(library.symbol(c"bm_stretch_prime_v1")?),
                        process: transmute::<
                            *mut c_void,
                            unsafe extern "C" fn(
                                *mut c_void,
                                *const f32,
                                u32,
                                *mut f32,
                                u32,
                                f32,
                            ) -> i32,
                        >(
                            library.symbol(c"bm_stretch_process_v1")?
                        ),
                    },
                })
            }
        }
    }
    struct Voice {
        handle: *mut c_void,
        dsp: Dsp,
        track: usize,
        mapping: Transition,
        key: f32,
        latency: i64,
        last: i64,
    }
    impl Drop for Voice {
        fn drop(&mut self) {
            unsafe { (self.dsp.free)(self.handle) }
        }
    }
    struct Source {
        read: Read,
        opaque: *mut c_void,
    }
    impl Source {
        fn read(&self, track: usize, start: i64, frames: usize) -> Result<Vec<f32>, ProbeError> {
            if frames == 0 || frames > 16384 || track > 1 {
                return Err(backend_error("invalid L1 PCM request"));
            }
            let mut out = vec![0.0; frames * 2];
            // SAFETY: decoder/context are borrowed only inside its audio callback.
            let status = unsafe {
                (self.read)(
                    self.opaque,
                    track as u32,
                    start,
                    frames as u32,
                    out.as_mut_ptr(),
                )
            };
            if status != 0 {
                return Err(status_error(status as u32, "L1 PCM read failed".into()));
            }
            if out.iter().any(|v| !v.is_finite()) {
                return Err(backend_error("nonfinite L1 PCM"));
            }
            Ok(out)
        }
    }
    impl Voice {
        fn new(
            dsp: Dsp,
            source: &Source,
            track: usize,
            mapping: Transition,
            key: f32,
            base: i64,
            frame: i64,
        ) -> Result<Self, ProbeError> {
            let handle = unsafe { (dsp.create)() };
            if handle.is_null() {
                return Err(backend_error("Signalsmith allocation failed"));
            }
            let latency = i64::from(unsafe { (dsp.latency)(handle) });
            let mut voice = Self {
                handle,
                dsp,
                track,
                mapping,
                key,
                latency,
                last: 0,
            };
            if !(1..=16384).contains(&latency) {
                return Err(backend_error("invalid Signalsmith latency"));
            }
            let start = mapping.audible(base, frame).round() as i64;
            let samples = source.read(track, start, latency as usize)?;
            let status = unsafe { (dsp.prime)(handle, samples.as_ptr(), latency as u32, key) };
            if status != 0 {
                return Err(backend_error("Signalsmith prime failed"));
            }
            voice.last = mapping.input(base, frame, latency);
            Ok(voice)
        }
        fn render(
            &mut self,
            source: &Source,
            base: i64,
            frame: i64,
            frames: usize,
            key: f32,
        ) -> Result<Vec<f32>, ProbeError> {
            let start = self.mapping.input(base, frame, self.latency);
            let end = self
                .mapping
                .input(base, frame + frames as i64, self.latency);
            if (start - self.last).abs() > 1 || !(1..=8192).contains(&(end - start)) {
                return Err(backend_error("discontinuous DSP input cursor"));
            }
            let samples = source.read(self.track, start, (end - start) as usize)?;
            self.key = policy::approach_key(self.key, key, frames as i64);
            let mut out = vec![0.0; frames * 2];
            let status = unsafe {
                (self.dsp.process)(
                    self.handle,
                    samples.as_ptr(),
                    (end - start) as u32,
                    out.as_mut_ptr(),
                    frames as u32,
                    self.key,
                )
            };
            if status != 0 || out.iter().any(|v| !v.is_finite()) {
                return Err(backend_error("Signalsmith process failed"));
            }
            self.last = end;
            Ok(out)
        }
    }
    #[cfg(test)]
    #[test]
    #[ignore = "requires native Signalsmith companion; test:purek-l1 runs it explicitly"]
    fn real_signalsmith_pitch_and_impulse_verify_frequency_and_latency_compensation() {
        let companion =
            std::env::var_os("BILIKARA_TEST_LIBAV_COMPANION").expect("native companion");
        let probe = unsafe { LibavMetadataProbe::load(Path::new(&companion)) }.unwrap();
        let cap = Capability::load(&probe._library).unwrap();
        unsafe extern "C" fn synthetic(
            opaque: *mut c_void,
            _: u32,
            start: i64,
            count: u32,
            out: *mut f32,
        ) -> i32 {
            let impulse = unsafe { *(opaque as *const bool) };
            let out = unsafe { std::slice::from_raw_parts_mut(out, count as usize * 2) };
            for n in 0..count as usize {
                let pos = start + n as i64;
                let sample = if impulse {
                    if pos == 4800 { 0.5 } else { 0.0 }
                } else {
                    (pos as f64 * 440.0 * std::f64::consts::TAU / 48000.0).sin() as f32 * 0.2
                };
                out[n * 2] = sample;
                out[n * 2 + 1] = sample;
            }
            0
        }
        for (impulse, key) in [(false, 0.0), (false, 6.0), (true, 0.0)] {
            let mut impulse = impulse;
            let source = Source {
                read: synthetic,
                opaque: (&mut impulse as *mut bool).cast(),
            };
            let mapping = Transition::new(0, 0.0, 0, OffsetMode::Splice);
            let mut voice = Voice::new(cap.dsp, &source, 0, mapping, key, 0, 0).unwrap();
            let mut samples = Vec::new();
            for frame in 0..24 {
                samples.extend(
                    voice
                        .render(&source, 0, frame * 1024, 1024, key)
                        .unwrap()
                        .chunks_exact(2)
                        .map(|c| c[0]),
                );
            }
            if impulse {
                let peak = samples
                    .iter()
                    .enumerate()
                    .max_by(|a, b| a.1.abs().total_cmp(&b.1.abs()))
                    .unwrap()
                    .0;
                assert!((peak as i64 - 4800).abs() <= 96, "impulse peak {peak}");
                assert!(samples[peak].abs() > 0.1);
            } else {
                let view = &samples[9600..];
                let crossings = view
                    .windows(2)
                    .filter(|p| p[0] <= 0.0 && p[1] > 0.0)
                    .count();
                let actual = crossings as f64 * 48000.0 / view.len() as f64;
                let expected = 440.0 * 2.0f64.powf(f64::from(key) / 12.0);
                assert!(
                    (actual - expected).abs() < 5.0,
                    "pitch {key}: expected {expected}, actual {actual}"
                );
                let rms = (view.iter().map(|s| f64::from(*s).powi(2)).sum::<f64>()
                    / view.len() as f64)
                    .sqrt();
                assert!((0.08..0.25).contains(&rms), "rms {rms}");
            }
        }
        let mut impulse = false;
        let mut source = || Source {
            read: synthetic,
            opaque: (&mut impulse as *mut bool).cast(),
        };
        let mut processor = Processor {
            dsp: cap.dsp,
            voice: None,
            fade: None,
            target: None,
            gain: 1.0,
            next_frame: 0,
        };
        let mut output = vec![0.0; 2048];
        // Faster-than-fade updates must converge to the last request without
        // resetting the output cursor; extreme offset changes stay bounded.
        for n in 0..192 {
            let c = Control {
                offset_ms: if n < 24 {
                    if n % 2 == 0 { 5000 } else { -5000 }
                } else {
                    0
                },
                key_shift: if n % 3 == 0 { -6 } else { 6 },
                volume_percent: 500,
                muted: n >= 190,
                track: if n < 24 { n % 2 } else { 0 },
                mode: OffsetMode::Splice,
            };
            processor
                .render(source(), 0, n as i64 * 1024, 1024, c, &mut output)
                .unwrap();
            assert!(output.iter().all(|x| x.is_finite() && x.abs() <= 1.0));
        }
        assert!(processor.fade.is_none());
        assert_eq!(processor.voice.as_ref().unwrap().track, 0);
        assert_eq!(
            processor.voice.as_ref().unwrap().mapping.offset(192 * 1024),
            0.0
        );
        assert!(output.iter().all(|x| *x == 0.0));
    }
    struct Fade {
        old: Voice,
        at: i64,
        frames: i64,
    }
    struct Processor {
        dsp: Dsp,
        voice: Option<Voice>,
        fade: Option<Fade>,
        target: Option<Control>,
        gain: f32,
        next_frame: i64,
    }
    impl Processor {
        fn render(
            &mut self,
            source: Source,
            base: i64,
            frame: i64,
            frames: usize,
            c: Control,
            out: &mut [f32],
        ) -> Result<(), ProbeError> {
            if frame != self.next_frame
                || c.offset_ms.unsigned_abs() > bilikara_rust::MAX_AV_DELAY_MS as u32
                || c.key_shift.unsigned_abs() > 6
                || !(0..=bilikara_rust::MAX_VOLUME_PERCENT).contains(&c.volume_percent)
                || c.track > 1
            {
                return Err(backend_error("invalid L1 control snapshot"));
            }
            if self.voice.is_none() {
                let t = Transition::new(
                    frame,
                    f64::from(c.offset_ms) * 48.0,
                    c.offset_ms,
                    OffsetMode::Splice,
                );
                self.voice = Some(Voice::new(
                    self.dsp,
                    &source,
                    c.track,
                    t,
                    c.key_shift as f32,
                    base,
                    frame,
                )?);
                self.target = Some(c);
                self.gain = policy::gain(c.volume_percent, c.muted);
            }
            let target = self.target.unwrap();
            let changed =
                target.offset_ms != c.offset_ms || target.track != c.track || target.mode != c.mode;
            if self.fade.is_none() && changed {
                let old = self.voice.as_ref().unwrap();
                let t = Transition::new(frame, old.mapping.offset(frame), c.offset_ms, c.mode);
                if target.track != c.track || c.mode == OffsetMode::Splice {
                    let new = Voice::new(self.dsp, &source, c.track, t, old.key, base, frame)?;
                    let old = self.voice.replace(new).unwrap();
                    self.fade = Some(Fade {
                        old,
                        at: frame,
                        frames: if target.track != c.track {
                            policy::TRACK_FADE_FRAMES
                        } else {
                            policy::SPLICE_FRAMES
                        },
                    });
                } else {
                    self.voice.as_mut().unwrap().mapping = t;
                }
                self.target = Some(c);
            }
            let new = self.voice.as_mut().unwrap().render(
                &source,
                base,
                frame,
                frames,
                c.key_shift as f32,
            )?;
            let old = match self.fade.as_mut() {
                Some(f) => Some(
                    f.old
                        .render(&source, base, frame, frames, c.key_shift as f32)?,
                ),
                None => None,
            };
            let gain = policy::gain(c.volume_percent, c.muted);
            for n in 0..frames {
                let (a, b) = self.fade.as_ref().map_or((0.0, 1.0), |f| {
                    policy::equal_power(frame + n as i64 - f.at, f.frames)
                });
                let g = self.gain + (gain - self.gain) * (n + 1) as f32 / frames as f32;
                for ch in 0..2 {
                    let i = n * 2 + ch;
                    out[i] = (old.as_ref().map_or(0.0, |v| v[i] * a) + new[i] * b)
                        .mul_add(g, 0.0)
                        .clamp(-1.0, 1.0);
                }
            }
            self.gain = gain;
            self.next_frame = frame + frames as i64;
            if self
                .fade
                .as_ref()
                .is_some_and(|f| self.next_frame >= f.at + f.frames)
            {
                self.fade = None;
            }
            Ok(())
        }
    }
    struct Cancellation<'a> {
        stop: &'a AtomicBool,
        failed: AtomicBool,
    }
    struct Context<'a> {
        cancellation: &'a Cancellation<'a>,
        stop: &'a AtomicBool,
        visit: &'a mut dyn FnMut(&[u8], i64, bool) -> bool,
        controls: &'a mut dyn FnMut() -> Result<Control, ProbeError>,
        processor: Processor,
        error: Option<ProbeError>,
        tracks: usize,
    }
    extern "C" fn cancelled(opaque: *mut c_void) -> i32 {
        // Separate context: PCM reads re-enter C and may poll cancellation
        // while the renderer exclusively borrows its mutable DSP state.
        let c = unsafe { &*(opaque as *const Cancellation<'_>) };
        i32::from(c.stop.load(Ordering::Acquire) || c.failed.load(Ordering::Acquire))
    }
    extern "C" fn ts_visit(
        opaque: *mut c_void,
        bytes: *const u8,
        size: u32,
        time: i64,
        key: u32,
    ) -> i32 {
        let c = unsafe { &mut *(opaque as *mut Context<'_>) };
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            if bytes.is_null()
                || size == 0
                || size > 24064
                || !size.is_multiple_of(188)
                || time < 0
                || key > 1
            {
                return Err(backend_error("invalid L1 TS bytes"));
            }
            let bytes = unsafe { std::slice::from_raw_parts(bytes, size as usize) };
            if bytes.chunks_exact(188).any(|b| b[0] != 0x47) {
                return Err(backend_error("invalid L1 TS sync"));
            }
            if !(c.visit)(bytes, time, key == 1) {
                return Err(ProbeError::Cancelled);
            }
            Ok(())
        }))
        .unwrap_or_else(|_| Err(backend_error("L1 visitor panic")));
        match result {
            Ok(()) => 0,
            Err(e) => {
                c.cancellation.failed.store(true, Ordering::Release);
                c.error = Some(e);
                1
            }
        }
    }
    extern "C" fn render(
        opaque: *mut c_void,
        read: Read,
        decoder: *mut c_void,
        source_us: i64,
        frame: i64,
        frames: u32,
        out: *mut f32,
    ) -> i32 {
        let c = unsafe { &mut *(opaque as *mut Context<'_>) };
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            if c.stop.load(Ordering::Acquire) {
                return Err(ProbeError::Cancelled);
            }
            if out.is_null()
                || decoder.is_null()
                || frames != 1024
                || source_us.unsigned_abs() > 604_800_000_000
                || !(0..=21600 * 48000).contains(&frame)
            {
                return Err(backend_error("invalid L1 render request"));
            }
            let control = (c.controls)()?;
            if control.track >= c.tracks {
                return Err(backend_error("uncached L1 audio track"));
            }
            let out = unsafe { std::slice::from_raw_parts_mut(out, frames as usize * 2) };
            c.processor.render(
                Source {
                    read,
                    opaque: decoder,
                },
                (source_us as f64 * 0.048).round() as i64,
                frame,
                frames as usize,
                control,
                out,
            )
        }))
        .unwrap_or_else(|_| Err(backend_error("L1 renderer panic")));
        match result {
            Ok(()) => 0,
            Err(e) => {
                c.cancellation.failed.store(true, Ordering::Release);
                c.error = Some(e);
                9
            }
        }
    }
    pub(super) fn run(
        probe: &LibavMetadataProbe,
        video: &Path,
        audio: &[&Path],
        start: i64,
        stop: &AtomicBool,
        visit: &mut dyn FnMut(&[u8], i64, bool) -> bool,
        controls: &mut dyn FnMut() -> Result<Control, ProbeError>,
    ) -> Result<(), ProbeError> {
        if audio.is_empty() || audio.len() > 2 || !(0..=21_600_000_000).contains(&start) {
            return Err(backend_error("invalid L1 sources"));
        }
        let cap = Capability::load(&probe._library)?;
        let video = open_input(video)?;
        let files = audio
            .iter()
            .map(|p| open_input(p))
            .collect::<Result<Vec<_>, _>>()?;
        let vd = probe._library.descriptor(&video)?;
        let ad = files
            .iter()
            .map(|f| probe._library.descriptor(f))
            .collect::<Result<Vec<_>, _>>()?;
        let cancellation = Cancellation {
            stop,
            failed: AtomicBool::new(false),
        };
        let mut context = Context {
            cancellation: &cancellation,
            stop,
            visit,
            controls,
            processor: Processor {
                dsp: cap.dsp,
                voice: None,
                fade: None,
                target: None,
                gain: 1.0,
                next_frame: 0,
            },
            error: None,
            tracks: audio.len(),
        };
        let opaque = (&mut context as *mut Context<'_>).cast();
        let input = |fd| wire::Request {
            fd,
            cancelled,
            opaque: (&cancellation as *const Cancellation<'_>).cast_mut().cast(),
        };
        let request = Request {
            live: Live {
                video: input(vd.fd),
                audio: input(ad[0].fd),
                start_us: start,
                visit: ts_visit,
                opaque,
            },
            audio: [input(ad[0].fd), input(ad.get(1).map_or(-1, |d| d.fd))],
            tracks: audio.len() as u32,
            render,
            opaque,
        };
        let mut result = ResultData::default();
        // SAFETY: all descriptors, callbacks, voices and library survive cleanup.
        let status = unsafe { (cap.run)(&request, &mut result) };
        if let Some(e) = context.error {
            return Err(e);
        }
        if stop.load(Ordering::Acquire) {
            return Err(ProbeError::Cancelled);
        }
        if status != 0 {
            return Err(status_error(status, "L1 invocation failed".into()));
        }
        if result.status != 0 {
            return Err(status_error(result.status, "L1 pipeline failed".into()));
        }
        if result.complete != 1 || result.packets == 0 || result.bytes == 0 {
            return Err(backend_error("incomplete L1 TS output"));
        }
        Ok(())
    }
}
