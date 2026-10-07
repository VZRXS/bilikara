//! Whole-track integrated loudness over the optional, negotiated PCM visitor.
use super::{LibavMetadataProbe, ProbeError};
use serde::{Deserialize, Serialize};
use std::{path::Path, sync::atomic::AtomicBool};

pub const ALGORITHM: &str = "ebur128-0.1.10-i-histogram-pcm-v1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct LoudnessMeasurement {
    pub algorithm: String,
    pub integrated_lufs: f64,
    pub duration_seconds: f64,
    pub elapsed_seconds: f64,
    pub sample_rate: u32,
    pub channels: u32,
    pub codec: String,
}

impl LoudnessMeasurement {
    pub fn valid(&self) -> bool {
        self.algorithm == ALGORITHM
            && bilikara_rust::automatic_volume::valid_loudness(self.integrated_lufs)
            && self.duration_seconds.is_finite()
            && (0.4..=21600.0).contains(&self.duration_seconds)
            && self.elapsed_seconds.is_finite()
            && self.elapsed_seconds >= 0.0
            && (8000..=192000).contains(&self.sample_rate)
            && (1..=2).contains(&self.channels)
            && !self.codec.is_empty()
            && self.codec.len() <= 128
    }
}

impl LibavMetadataProbe {
    pub fn loudness_available(&self) -> bool {
        #[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
        {
            self.pcm.is_ok()
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
        {
            false
        }
    }

    pub fn integrated_loudness(
        &self,
        source: &Path,
        cancelled: &AtomicBool,
    ) -> Result<LoudnessMeasurement, ProbeError> {
        #[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
        {
            self.decode_loudness(source, cancelled)
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
        {
            let _ = (source, cancelled);
            Err(ProbeError::Unavailable(
                "native PCM scanner unavailable".into(),
            ))
        }
    }
}

#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
mod native {
    use super::*;
    use crate::experimental_libav::{
        Callback, backend_error, cancellation_callback, open_input, status_error, wire,
    };
    use std::{
        ffi::c_void,
        mem::{size_of, transmute},
        sync::atomic::Ordering,
    };

    #[repr(C)]
    struct Info {
        schema: u32,
        request_size: u32,
        result_size: u32,
        max_frames: u32,
    }
    #[repr(C)]
    struct Request {
        input: wire::Request,
        visit: extern "C" fn(*mut c_void, *const f32, u32, u32, u32) -> i32,
        opaque: *mut c_void,
    }
    #[repr(C)]
    struct ResultData {
        status: u32,
        complete: u32,
        sample_rate: u32,
        channels: u32,
        frames: u64,
        codec: wire::Text<128>,
    }
    pub(in crate::experimental_libav) struct Capability {
        decode: unsafe extern "C" fn(*const Request, *mut ResultData) -> u32,
    }
    impl Capability {
        pub(in crate::experimental_libav) fn load(
            library: &wire::Library,
        ) -> Result<Self, ProbeError> {
            // SAFETY: already trusted/build-negotiated companion; separately
            // sized optional ABI. Missing symbols affect only this feature.
            unsafe {
                let get_info: unsafe extern "C" fn(u32, *mut Info) -> u32 =
                    transmute(library.symbol(c"bm_pcm_info_v1")?);
                let mut info = Info {
                    schema: 0,
                    request_size: 0,
                    result_size: 0,
                    max_frames: 0,
                };
                if get_info(size_of::<Info>() as u32, &mut info) != 0
                    || info.schema != 1
                    || info.request_size as usize != size_of::<Request>()
                    || info.result_size as usize != size_of::<ResultData>()
                    || info.max_frames != 4096
                {
                    return Err(backend_error("incompatible PCM visitor"));
                }
                Ok(Self {
                    decode: transmute::<
                        *mut c_void,
                        unsafe extern "C" fn(*const Request, *mut ResultData) -> u32,
                    >(library.symbol(c"bm_decode_audio_v1")?),
                })
            }
        }
    }
    struct Visitor<'a> {
        cancelled: &'a AtomicBool,
        meter: Option<ebur128::EbuR128>,
        error: bool,
    }
    extern "C" fn visit(
        opaque: *mut c_void,
        samples: *const f32,
        frames: u32,
        channels: u32,
        rate: u32,
    ) -> i32 {
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            // SAFETY: caller borrows this Visitor and chunk for the synchronous
            // decode only. Bounds validated before building any slice.
            let visitor = unsafe { &mut *opaque.cast::<Visitor<'_>>() };
            if visitor.cancelled.load(Ordering::Acquire) {
                return false;
            }
            let mut consume = || -> Result<(), ebur128::Error> {
                if visitor.meter.is_none() {
                    // Histogram bounds memory independently of song duration;
                    // no LRA/true-peak modes, only integrated loudness.
                    visitor.meter = Some(ebur128::EbuR128::new(
                        channels,
                        rate,
                        ebur128::Mode::I | ebur128::Mode::HISTOGRAM,
                    )?);
                }
                let meter = visitor.meter.as_mut().unwrap();
                if meter.channels() != channels || meter.rate() != rate {
                    return Err(ebur128::Error::InvalidMode);
                }
                let data = unsafe {
                    std::slice::from_raw_parts(samples, frames as usize * channels as usize)
                };
                meter.add_frames_f32(data)
            };
            if samples.is_null()
                || !(1..=4096).contains(&frames)
                || !(1..=2).contains(&channels)
                || !(8000..=192000).contains(&rate)
            {
                visitor.error = true;
                return false;
            }
            if consume().is_err() {
                visitor.error = true;
                return false;
            }
            true
        }));
        i32::from(!matches!(outcome, Ok(true)))
    }
    impl LibavMetadataProbe {
        pub(super) fn decode_loudness(
            &self,
            source: &Path,
            cancelled: &AtomicBool,
        ) -> Result<LoudnessMeasurement, ProbeError> {
            let capability = self.pcm.as_ref().map_err(Clone::clone)?;
            if cancelled.load(Ordering::Acquire) {
                return Err(ProbeError::Cancelled);
            }
            let file = open_input(source)?;
            let descriptor = self._library.descriptor(&file)?;
            let callback = Callback::new(cancelled);
            let mut visitor = Visitor {
                cancelled,
                meter: None,
                error: false,
            };
            let request = Request {
                input: wire::Request {
                    fd: descriptor.fd,
                    cancelled: cancellation_callback,
                    opaque: (&callback as *const Callback<'_>).cast_mut().cast(),
                },
                visit,
                opaque: (&mut visitor as *mut Visitor<'_>).cast(),
            };
            let mut raw: ResultData = unsafe { std::mem::zeroed() };
            let started = std::time::Instant::now();
            // SAFETY: all callback/descriptor/library lifetimes enclose this
            // synchronous call, independently negotiated v1 layout.
            let status = unsafe { (capability.decode)(&request, &mut raw) };
            if visitor.error {
                return Err(backend_error("invalid PCM measurement"));
            }
            if status != 0 || raw.status != 0 {
                return Err(status_error(
                    if status != 0 { status } else { raw.status },
                    "audio decode incomplete".into(),
                ));
            }
            if raw.complete != 1 || cancelled.load(Ordering::Acquire) {
                return Err(ProbeError::Cancelled);
            }
            let meter = visitor.meter.ok_or_else(|| backend_error("empty audio"))?;
            let lufs = meter
                .loudness_global()
                .map_err(|_| backend_error("no gated loudness"))?;
            let result = LoudnessMeasurement {
                algorithm: ALGORITHM.into(),
                integrated_lufs: lufs,
                duration_seconds: raw.frames as f64 / f64::from(raw.sample_rate),
                elapsed_seconds: started.elapsed().as_secs_f64(),
                sample_rate: raw.sample_rate,
                channels: raw.channels,
                codec: super::super::text(&raw.codec)?,
            };
            if !result.valid() {
                return Err(backend_error("silent, short or invalid audio"));
            }
            Ok(result)
        }
    }
}
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
pub(super) use native::Capability;

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;

    #[test]
    #[ignore = "requires prepared native PCM companion and generated offline audio fixtures"]
    fn real_compressed_pcm_integrated_loudness() {
        let companion = std::path::PathBuf::from(
            std::env::var_os("BILIKARA_TEST_LIBAV_COMPANION").expect("real companion"),
        );
        let fixtures = std::path::PathBuf::from(
            std::env::var_os("BILIKARA_TEST_LOUDNESS_FIXTURES").expect("fixtures"),
        );
        // SAFETY: explicit locally compiled same-build test artifact.
        let probe = unsafe { LibavMetadataProbe::load(&companion) }.unwrap();
        assert!(probe.loudness_available());
        if let Some(old) = std::env::var_os("BILIKARA_TEST_OLD_LIBAV_COMPANION") {
            // SAFETY: explicit older local companion, never a client path.
            let older = unsafe { LibavMetadataProbe::load(Path::new(&old)) }.unwrap();
            assert!(!older.loudness_available());
            assert!(
                older
                    .probe_metadata(&fixtures.join("aac-48000.m4a"), &AtomicBool::new(false))
                    .is_ok()
            );
            assert!(matches!(
                older.integrated_loudness(&fixtures.join("aac-48000.m4a"), &AtomicBool::new(false)),
                Err(ProbeError::Unavailable(_))
            ));
        }
        let oracle: serde_json::Value =
            serde_json::from_slice(&std::fs::read(fixtures.join("oracle.json")).unwrap()).unwrap();
        for name in [
            "aac-44100.m4a",
            "aac-48000.m4a",
            "aac-quantized.m4a",
            "flac-96000.flac",
            "opus-48000.mp4",
        ] {
            let flag = AtomicBool::new(false);
            let fact = probe
                .integrated_loudness(&fixtures.join(name), &flag)
                .unwrap();
            let expected = oracle[if name == "aac-quantized.m4a" {
                "aac-48000.m4a"
            } else {
                name
            }]
            .as_f64()
            .unwrap();
            assert!(
                (fact.integrated_lufs - expected).abs() <= 0.15,
                "{name}: measured {} vs independent FFmpeg {expected}",
                fact.integrated_lufs
            );
            assert!(fact.valid());
            println!(
                "{name} LUFS={:.4} duration={:.3}s scan={:.6}s ratio={:.6}",
                fact.integrated_lufs,
                fact.duration_seconds,
                fact.elapsed_seconds,
                fact.elapsed_seconds / fact.duration_seconds
            );
            flag.store(true, Ordering::Release);
            assert!(matches!(
                probe.integrated_loudness(&fixtures.join(name), &flag),
                Err(ProbeError::Cancelled)
            ));
        }
        for name in [
            "silence.m4a",
            "short.m4a",
            "truncated.m4a",
            "invalid.m4a",
            "aac-gap.m4a",
            "aac-overlap.m4a",
            "surround.m4a",
        ] {
            assert!(
                probe
                    .integrated_loudness(&fixtures.join(name), &AtomicBool::new(false))
                    .is_err(),
                "{name} is unavailable, never complete"
            );
        }
        let flag = AtomicBool::new(false);
        let (result, cancelled_after) = std::thread::scope(|scope| {
            let timer = scope.spawn(|| {
                std::thread::sleep(std::time::Duration::from_millis(10));
                flag.store(true, Ordering::Release);
            });
            let result = probe.integrated_loudness(&fixtures.join("long.m4a"), &flag);
            timer.join().unwrap();
            (result, flag.load(Ordering::Acquire))
        });
        assert!(cancelled_after);
        assert!(
            matches!(result, Err(ProbeError::Cancelled)),
            "cooperative cancellation inside decode: {result:?}"
        );
        // One full long scan also checks that histogram/chunk memory does not
        // grow with a twenty-minute track. Linux RSS is an observation, not a
        // cross-platform allocator or real-time playback guarantee.
        #[cfg(target_os = "linux")]
        let memory = || {
            let status = std::fs::read_to_string("/proc/self/status").unwrap();
            let value = |key: &str| {
                status
                    .lines()
                    .find_map(|line| line.strip_prefix(key))
                    .unwrap()
                    .split_whitespace()
                    .next()
                    .unwrap()
                    .parse::<u64>()
                    .unwrap()
            };
            (value("VmRSS:"), value("VmHWM:"))
        };
        #[cfg(target_os = "linux")]
        let before = memory();
        let long = probe
            .integrated_loudness(&fixtures.join("long.m4a"), &AtomicBool::new(false))
            .unwrap();
        assert!((long.duration_seconds - 1200.0).abs() < 0.01);
        println!(
            "long AAC 48000 stereo duration={:.3}s scan={:.6}s ratio={:.6}",
            long.duration_seconds,
            long.elapsed_seconds,
            long.elapsed_seconds / long.duration_seconds
        );
        #[cfg(target_os = "linux")]
        {
            let after = memory();
            println!("Linux process RSS/HWM KiB before={before:?} after={after:?}");
            assert!(
                after.1.saturating_sub(before.1) < 64 * 1024,
                "bounded long-track working memory"
            );
        }
    }
}
