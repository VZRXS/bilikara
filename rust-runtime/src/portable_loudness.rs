//! Bounded offline AAC-LC/FLAC analysis. This decoder never owns playback,
//! calibration or queues; the Host supplies an AppState-owned artifact lease.
use crate::loudness::{ALGORITHM, LoudnessMeasurement};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    Cancelled,
    MissingArtifact,
    UnsupportedContainer,
    UnsupportedCodecProfile,
    PacketTimeline,
    DurationMismatch,
    DecoderFailure,
    AnalysisTimeout,
    SilentSignal,
}
impl Error {
    pub fn diagnostic_code(self) -> &'static str {
        match self {
            Self::Cancelled => "cancelled",
            Self::MissingArtifact => "missing_artifact",
            Self::UnsupportedContainer => "unsupported_container",
            Self::UnsupportedCodecProfile => "unsupported_codec_profile",
            Self::PacketTimeline => "packet_timeline",
            Self::DurationMismatch => "duration_mismatch",
            Self::DecoderFailure => "decoder_failure",
            Self::AnalysisTimeout => "analysis_timeout",
            Self::SilentSignal => "silent_signal",
        }
    }
}
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};
use symphonia::core::{
    codecs::audio::{
        AudioDecoderOptions,
        well_known::{CODEC_ID_AAC, CODEC_ID_FLAC},
    },
    common::Limit,
    formats::{FormatOptions, TrackType, probe::Hint},
    io::{MediaSource, MediaSourceStream},
    meta::MetadataOptions,
};

struct LegacyAacSource {
    file: File,
    offsets: Vec<u64>,
}
impl Read for LegacyAacSource {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let position = self.file.stream_position()?;
        let count = self.file.read(buffer)?;
        for offset in &self.offsets {
            for (index, value) in [6, 1, 2].into_iter().enumerate() {
                let at = offset + index as u64;
                if at >= position && at - position < count as u64 {
                    buffer[(at - position) as usize] = value;
                }
            }
        }
        Ok(count)
    }
}
impl Seek for LegacyAacSource {
    fn seek(&mut self, position: SeekFrom) -> std::io::Result<u64> {
        self.file.seek(position)
    }
}
impl MediaSource for LegacyAacSource {
    fn is_seekable(&self) -> bool {
        true
    }
    fn byte_len(&self) -> Option<u64> {
        self.file.metadata().ok().map(|m| m.len())
    }
}

fn failure() -> Error {
    // No path, parser payload or provider metadata crosses the API boundary.
    Error::DecoderFailure
}

/// Bounded codec/timeline observations. No paths, URLs, tags or decoder text.
#[derive(Debug, Default)]
pub struct ScanDiagnostics {
    pub legacy_aac_sl_config: usize,
    pub codec: Option<&'static str>,
    pub profile: Option<u32>,
    pub tracks: usize,
    pub sample_rate: u32,
    pub channels: u32,
    pub declared_seconds: f64,
    pub decoded_seconds: f64,
    pub packet_index: u64,
    pub packet_seconds: f64,
    pub packet_duration: f64,
    pub gap_seconds: f64,
}

/// Decode the complete immutable local audio artifact into a histogram meter.
/// No subprocess, network, dynamic library, playback or whole-track PCM buffer.
pub fn analyze(path: &Path, cancelled: &AtomicBool) -> Result<LoudnessMeasurement, Error> {
    analyze_diagnosed(path, cancelled, &mut ScanDiagnostics::default())
}

pub fn analyze_diagnosed(
    path: &Path,
    cancelled: &AtomicBool,
    diagnostic: &mut ScanDiagnostics,
) -> Result<LoudnessMeasurement, Error> {
    let started = Instant::now();
    let check = || {
        if cancelled.load(Ordering::Acquire) {
            Err(Error::Cancelled)
        } else if started.elapsed().as_secs() >= 120 {
            Err(Error::AnalysisTimeout)
        } else {
            Ok(())
        }
    };
    check()?;
    let file = File::open(path).map_err(|_| Error::MissingArtifact)?;
    let metadata = file.metadata().map_err(|_| Error::MissingArtifact)?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > 2 * 1024 * 1024 * 1024 {
        return Err(failure());
    }
    let mut hint = Hint::new();
    if let Some(extension) = path.extension().and_then(|value| value.to_str()) {
        hint.with_extension(extension);
    }
    let offsets = crate::media_backend::legacy_aac_sl_config_fixes(path)
        .map_err(|_| Error::UnsupportedContainer)?;
    diagnostic.legacy_aac_sl_config = offsets.len();
    let stream = MediaSourceStream::new(
        Box::new(LegacyAacSource { file, offsets }),
        Default::default(),
    );
    let options = MetadataOptions::default()
        .limit_tag_bytes(Limit::Maximum(65536))
        .limit_visual_bytes(Limit::Maximum(0));
    let mut format = symphonia::default::get_probe()
        .probe(&hint, stream, FormatOptions::default(), options)
        .map_err(|_| Error::UnsupportedContainer)?;
    diagnostic.tracks = format.tracks().len();
    if format.tracks().len() != 1 {
        return Err(Error::UnsupportedContainer);
    }
    let track = format.default_track(TrackType::Audio).ok_or_else(failure)?;
    let parameters = track
        .codec_params
        .as_ref()
        .and_then(|value| value.audio())
        .ok_or_else(failure)?;
    let codec = match parameters.codec {
        CODEC_ID_AAC => "aac",
        CODEC_ID_FLAC => "flac",
        _ => return Err(Error::UnsupportedCodecProfile),
    };
    diagnostic.codec = Some(codec);
    diagnostic.profile = parameters.profile.map(|profile| profile.get());
    let id = track.id;
    let time_base = track.time_base.ok_or(Error::PacketTimeline)?;
    let declared = track
        .duration
        .and_then(|duration| time_base.calc_duration(duration))
        .map(|time| time.as_secs_f64())
        .ok_or(Error::DurationMismatch)?;
    diagnostic.declared_seconds = declared;
    if !(0.4..=21600.0).contains(&declared) {
        return Err(Error::DurationMismatch);
    }
    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(parameters, &AudioDecoderOptions::default().verify(true))
        .map_err(|_| Error::UnsupportedCodecProfile)?;
    let mut meter: Option<ebur128::EbuR128> = None;
    let mut frames = 0u64;
    let mut previous_end: Option<f64> = None;
    let mut duration_error: Option<f64> = None;
    let mut last_block_seconds = 0.0;
    let mut samples = Vec::<f32>::new();
    loop {
        check()?;
        let Some(packet) = format.next_packet().map_err(|_| failure())? else {
            break;
        };
        diagnostic.packet_index += 1;
        if duration_error.is_some_and(|error| error.abs() > 0.002) {
            return Err(Error::DurationMismatch);
        }
        // Discard metadata as it arrives; no duration-sized metadata queue.
        while !format.metadata().is_latest() {
            format.metadata().pop();
        }
        if packet.track_id != id || packet.data.len() > 1024 * 1024 {
            return Err(failure());
        }
        let pts = time_base
            .calc_time(packet.pts)
            .map(|time| time.as_secs_f64())
            .ok_or(Error::PacketTimeline)?;
        let duration = time_base
            .calc_duration(packet.dur)
            .map(|time| time.as_secs_f64())
            .ok_or(Error::PacketTimeline)?;
        diagnostic.packet_seconds = pts;
        diagnostic.packet_duration = duration;
        diagnostic.gap_seconds = previous_end.map_or(0.0, |end| pts - end);
        // Accept millisecond timestamp quantization, never gaps/overlaps that
        // would make concatenated decoded samples misrepresent the track.
        if previous_end.is_some_and(|end| (pts - end).abs() > 0.002) {
            return Err(Error::PacketTimeline);
        }
        previous_end = Some(pts + duration);
        let decoded = decoder.decode(&packet).map_err(|_| failure())?;
        let rate = decoded.spec().rate();
        let channels = decoded.spec().channels().count() as u32;
        diagnostic.sample_rate = rate;
        diagnostic.channels = channels;
        if !(8000..=192000).contains(&rate)
            || !(1..=2).contains(&channels)
            || decoded.frames() > 65536
        {
            return Err(failure());
        }
        if meter.is_none() {
            meter = Some(
                ebur128::EbuR128::new(channels, rate, ebur128::Mode::I | ebur128::Mode::HISTOGRAM)
                    .map_err(|_| failure())?,
            );
        }
        let meter = meter.as_mut().unwrap();
        if meter.rate() != rate || meter.channels() != channels {
            return Err(failure());
        }
        last_block_seconds = decoded.frames() as f64 / f64::from(rate);
        duration_error = Some(last_block_seconds - duration);
        decoded.copy_to_vec_interleaved(&mut samples);
        if samples.iter().any(|value| !value.is_finite()) {
            return Err(failure());
        }
        // A shortened final AAC packet expresses end padding in ISO MP4.
        // Measure only its declared valid samples, not the decoder's padded
        // block. The next-iteration check still rejects this anywhere inside
        // the stream; do not trim ordinary timestamp quantization (<=2ms).
        let measured_frames = if codec == "aac" && last_block_seconds - duration > 0.002 {
            let valid = (duration * f64::from(rate)).round() as usize;
            if valid > decoded.frames() {
                return Err(Error::DurationMismatch);
            }
            samples.truncate(valid * channels as usize);
            valid
        } else {
            decoded.frames()
        };
        meter.add_frames_f32(&samples).map_err(|_| failure())?;
        frames = frames
            .checked_add(measured_frames as u64)
            .ok_or_else(failure)?;
        diagnostic.decoded_seconds = frames as f64 / f64::from(rate);
        if diagnostic.decoded_seconds > 21600.0 {
            return Err(failure());
        }
    }
    check()?;
    if decoder.finalize().verify_ok == Some(false) {
        return Err(Error::DecoderFailure);
    }
    let meter = meter.ok_or_else(failure)?;
    // ISO MP4 may shorten only the final AAC packet to express encoder
    // padding. Internal packet duration mismatches are rejected above.
    if duration_error.is_some_and(|error| {
        error < -0.002
            || error
                > if codec == "aac" {
                    last_block_seconds + 0.002
                } else {
                    0.002
                }
    }) {
        return Err(Error::DurationMismatch);
    }
    let duration = frames as f64 / f64::from(meter.rate());
    if (duration - declared).abs() > 0.05 {
        return Err(Error::DurationMismatch);
    }
    let integrated_lufs = meter.loudness_global().map_err(|_| failure())?;
    if !integrated_lufs.is_finite() {
        return Err(Error::SilentSignal);
    }
    let result = LoudnessMeasurement {
        algorithm: ALGORITHM.into(),
        integrated_lufs,
        duration_seconds: duration,
        elapsed_seconds: started.elapsed().as_secs_f64(),
        sample_rate: meter.rate(),
        channels: meter.channels(),
        codec: codec.into(),
    };
    if !result.valid() {
        return Err(failure());
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires an explicitly supplied compressed artifact and independent reference"]
    fn portable_external_artifact_reference() {
        let path = std::path::PathBuf::from(
            std::env::var_os("BILIKARA_TEST_LOUDNESS_ARTIFACT").expect("artifact"),
        );
        let expected: f64 = std::env::var("BILIKARA_TEST_LOUDNESS_REFERENCE")
            .expect("reference")
            .parse()
            .unwrap();
        let mut diagnostic = ScanDiagnostics::default();
        let fact = analyze_diagnosed(&path, &AtomicBool::new(false), &mut diagnostic);
        println!("{diagnostic:?}");
        let fact = fact.unwrap();
        assert!(
            (fact.integrated_lufs - expected).abs() <= 0.5,
            "{fact:?} vs {expected}"
        );
        assert!(fact.valid());
        // iOS analyzes the published Rust-normalized artifact, not provider
        // bytes. Exercise that production boundary with the same oracle.
        let root = std::env::temp_dir().join(format!(
            "bilikara-loudness-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        let output = root.join("audio.m4a");
        crate::media_backend::normalize_media(&crate::media_backend::MediaNormalizeRequest {
            schema_version: 1,
            source: path,
            destination: output.clone(),
            expected_kind: crate::media_backend::ExpectedMediaKind::Audio,
        })
        .unwrap();
        if let Some(destination) = std::env::var_os("BILIKARA_TEST_LOUDNESS_NORMALIZED_OUTPUT") {
            std::fs::copy(&output, destination).unwrap();
        }
        let mut diagnostic = ScanDiagnostics::default();
        let normalized = analyze_diagnosed(&output, &AtomicBool::new(false), &mut diagnostic);
        println!("normalized: {diagnostic:?} {normalized:?}");
        std::fs::remove_dir_all(root).unwrap();
        assert!((normalized.unwrap().integrated_lufs - expected).abs() <= 0.5);
    }

    #[test]
    #[ignore = "requires generated offline AAC/FLAC fixtures and independent FFmpeg oracle"]
    fn actual_compressed_audio_oracle_cancellation_and_failures() {
        let root = std::path::PathBuf::from(
            std::env::var_os("BILIKARA_TEST_LOUDNESS_FIXTURES").expect("offline fixtures"),
        );
        let oracle: serde_json::Value =
            serde_json::from_slice(&std::fs::read(root.join("oracle.json")).unwrap()).unwrap();
        for name in [
            "aac-44100.m4a",
            "aac-48000.m4a",
            "aac-8000.m4a",
            "aac-24000.mp4",
            "flac-96000.flac",
            "aac-quantized.m4a",
            "aac-provider.m4a",
        ] {
            let fact = analyze(&root.join(name), &AtomicBool::new(false))
                .unwrap_or_else(|error| panic!("{name}: {error:?}"));
            let key = if name == "aac-quantized.m4a" {
                "aac-48000.m4a"
            } else {
                name
            };
            let expected = oracle[key].as_f64().unwrap();
            assert!(
                (fact.integrated_lufs - expected).abs() <= 0.15,
                "{name}: {fact:?} vs {expected}"
            );
            assert!(fact.valid());
            println!("{name}: {fact:?}");
            if name.starts_with("aac-") {
                let output = root.join(format!("published-{name}"));
                crate::media_backend::normalize_media(
                    &crate::media_backend::MediaNormalizeRequest {
                        schema_version: 1,
                        source: root.join(name),
                        destination: output.clone(),
                        expected_kind: crate::media_backend::ExpectedMediaKind::Audio,
                    },
                )
                .unwrap();
                let published = analyze(&output, &AtomicBool::new(false)).unwrap();
                assert!(
                    (published.integrated_lufs - expected).abs() <= 0.15,
                    "published {name}: {published:?}"
                );
                if name == "aac-provider.m4a" {
                    // Recreate the old mp4 writer's exact descriptor defect.
                    // Both real decoders' valid-PCM oracle stays independent of
                    // the compatibility overlay, and cache bytes must not change.
                    let mut bytes = std::fs::read(&output).unwrap();
                    let esds = bytes.windows(4).position(|v| v == b"esds").unwrap();
                    let size =
                        u32::from_be_bytes(bytes[esds - 4..esds].try_into().unwrap()) as usize;
                    let tail = esds - 4 + size - 3;
                    assert_eq!(&bytes[tail..tail + 3], &[6, 1, 2]);
                    bytes[tail..tail + 3].copy_from_slice(&[6, 0, 0]);
                    let legacy = root.join(format!("legacy-{name}"));
                    std::fs::write(&legacy, &bytes).unwrap();
                    let mut diagnostic = ScanDiagnostics::default();
                    let compatible =
                        analyze_diagnosed(&legacy, &AtomicBool::new(false), &mut diagnostic)
                            .unwrap();
                    assert_eq!(diagnostic.legacy_aac_sl_config, 1);
                    assert!((compatible.integrated_lufs - expected).abs() <= 0.15);
                    assert_eq!(std::fs::read(legacy).unwrap(), bytes);
                }
            }
            assert!(matches!(
                analyze(&root.join(name), &AtomicBool::new(true)),
                Err(Error::Cancelled)
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
            "opus-48000.mp4",
        ] {
            assert!(
                analyze(&root.join(name), &AtomicBool::new(false)).is_err(),
                "{name} must not produce a complete fact"
            );
        }
        let flag = AtomicBool::new(false);
        std::thread::scope(|scope| {
            scope.spawn(|| {
                std::thread::sleep(std::time::Duration::from_millis(10));
                flag.store(true, Ordering::Release);
            });
            assert!(matches!(
                analyze(&root.join("long.m4a"), &flag),
                Err(Error::Cancelled)
            ));
        });
    }
}
