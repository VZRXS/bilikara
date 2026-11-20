//! L2, the composited cast: L1's audio, controls and T4 pacing with the video
//! re-encoded under the Audience overlay. The platform compositor (hardware,
//! e.g. Android MediaCodec) is preferred; otherwise the companion transcodes
//! (Media Foundation H.264 on Windows, software MPEG-2 elsewhere).
use super::*;
use crate::cast_compositor::{self, Compositor};
use crate::dlna::cast_http::{LiveProducer, LiveStream};
use crate::experimental_libav::{
    LibavMetadataProbe, ProbeError,
    cast_mux::{CastPacing, CastStart, CastSummary},
    live_audio::{
        Composite, CompositeReport, CompositeVideo, EncodedUnit, Event, TranscodeCodec, composite,
    },
};
use std::time::Instant;

const MAX_WIDTH: u32 = 1920;
const MAX_HEIGHT: u32 = 1080;
pub(super) const FPS_CAP: (u32, u32) = (30, 1);

pub(super) enum Video {
    External(Arc<dyn Compositor>),
    Transcode(TranscodeCodec),
}
pub(super) struct Plan {
    pub video: Video,
    pub width: u32,
    pub height: u32,
    pub bit_rate: u32,
}
impl Plan {
    /// Diagnostics name of the planned encoder.
    pub fn encoder(&self) -> &'static str {
        match &self.video {
            Video::External(c) => c.name(),
            Video::Transcode(TranscodeCodec::H264) => "companion_h264",
            Video::Transcode(TranscodeCodec::Mpeg2) => "companion_mpeg2",
        }
    }
}

/// Output size for a platform compositor: the source scaled down to fit
/// 1920x1080, even dimensions, never upscaled.
fn fit(width: u32, height: u32) -> (u32, u32) {
    let scale = (f64::from(MAX_WIDTH) / f64::from(width))
        .min(f64::from(MAX_HEIGHT) / f64::from(height))
        .min(1.0);
    let even = |v: f64| ((v * scale / 2.0).round() as u32).max(1) * 2;
    (even(f64::from(width)), even(f64::from(height)))
}
fn bit_rate(width: u32, height: u32, codec: Option<TranscodeCodec>) -> u32 {
    let pixels = width * height;
    let h264 = if pixels > 1280 * 720 {
        8_000_000
    } else if pixels > 854 * 480 {
        5_000_000
    } else if pixels > 640 * 360 {
        2_500_000
    } else {
        1_200_000
    };
    // MPEG-2 needs about half again the rate for comparable quality.
    if codec == Some(TranscodeCodec::Mpeg2) {
        h264 / 2 * 3
    } else {
        h264
    }
}

/// Chooses how this source is composited, or why it cannot be.
pub(super) fn plan(
    kinds: u32,
    platform: Option<Arc<dyn Compositor>>,
    facts: &CastSummary,
) -> Result<Plan, &'static str> {
    let (width, height) = (facts.width, facts.height);
    if width == 0 || height == 0 {
        return Err("composite_source_size");
    }
    if let Some(platform) = platform.filter(|_| kinds & composite::KIND_EXTERNAL != 0) {
        let (width, height) = fit(width, height);
        return Ok(Plan {
            video: Video::External(platform),
            width,
            height,
            bit_rate: bit_rate(width, height, None),
        });
    }
    let codec = if kinds & composite::KIND_H264 != 0 {
        TranscodeCodec::H264
    } else if kinds & composite::KIND_MPEG2 != 0 {
        TranscodeCodec::Mpeg2
    } else {
        return Err("composite_unavailable");
    };
    // The companion keeps the source size (no scaler in the build).
    if width > MAX_WIDTH || height > MAX_HEIGHT + 8 || width % 2 != 0 || height % 2 != 0 {
        return Err("composite_source_size");
    }
    Ok(Plan {
        video: Video::Transcode(codec),
        width,
        height,
        bit_rate: bit_rate(width, height, Some(codec)),
    })
}

/// Same contract as `l1::generate`, with the composited video.
#[allow(clippy::too_many_arguments)]
pub(super) fn generate(
    probe: &LibavMetadataProbe,
    input: &media::Inputs,
    item: &crate::app_state::PlaylistItem,
    facts: CastSummary,
    plan: Plan,
    hub: Arc<overlay::Hub>,
    position: f64,
    identity: (u64, u64),
    stream: Arc<LiveStream>,
    mut producer: LiveProducer,
) -> Result<CompositeReport, ApiError> {
    let mut pacing_error = None;
    overlay::prewarm();
    let view = overlay::View::new(hub, plan.width, plan.height);
    let start_us = (position * 1_000_000.0) as i64;
    let end_us = facts.source_start_us.max(0) + facts.duration_us;
    let result = (|| {
        let CastPacing::Realtime { burst } = producer.pacing() else {
            unreachable!()
        };
        let lead = burst
            .min(Duration::from_secs(2))
            .saturating_sub(Duration::from_millis(100));
        let mut began = None;
        let mut bytes_written = 0_u64;
        let paths = input
            .tracks
            .iter()
            .map(|(_, path)| path.as_path())
            .collect::<Vec<_>>();
        let mut last = with_app(|app| super::l1::read_control(app, input, item, identity))
            .map_err(|_| ProbeError::BackendFailure("L2 output context changed".into()))?
            .ok_or(ProbeError::Cancelled)?;
        let mut platform_stream = match &plan.video {
            Video::External(compositor) => Some(
                compositor
                    .open(&cast_compositor::Request {
                        video: input.video.clone(),
                        start_us,
                        end_us,
                        width: plan.width,
                        height: plan.height,
                        fps: FPS_CAP,
                        bit_rate: plan.bit_rate,
                    })
                    .map_err(ProbeError::BackendFailure)?,
            ),
            Video::Transcode(_) => None,
        };
        // The platform encoder receives the overlay before each unit it
        // produces; the companion transcoder pulls it per frame instead.
        let mut overlay_generation = 0;
        let cancelled = stream.cancellation();
        let mut next = || -> Result<Option<EncodedUnit>, ProbeError> {
            let platform = platform_stream.as_mut().expect("external video");
            if cancelled.load(Ordering::Acquire) {
                return Err(ProbeError::Cancelled);
            }
            if let Some((generation, rgba)) = view
                .refresh(overlay_generation)
                .map_err(ProbeError::BackendFailure)?
            {
                platform
                    .set_overlay(&rgba)
                    .map_err(ProbeError::BackendFailure)?;
                overlay_generation = generation;
            }
            Ok(platform
                .next(cancelled)
                .map_err(|e| {
                    if cancelled.load(Ordering::Acquire) {
                        ProbeError::Cancelled
                    } else {
                        ProbeError::BackendFailure(e)
                    }
                })?
                .map(|u| EncodedUnit {
                    data: u.data,
                    key: u.key,
                    pts_us: u.pts_us,
                    dts_us: u.dts_us,
                }))
        };
        let video = match plan.video {
            Video::External(_) => CompositeVideo::External {
                width: plan.width,
                height: plan.height,
                next: &mut next,
            },
            Video::Transcode(codec) => CompositeVideo::Transcode {
                codec,
                width: plan.width,
                height: plan.height,
            },
        };
        let external = matches!(video, CompositeVideo::External { .. });
        probe.render_composited_ts_with_events(
            &input.video,
            &paths,
            start_us,
            stream.cancellation(),
            &mut |event| match event {
                Event::Start(start) => {
                    let result = producer.start(CastStart {
                        source_start_us: start.source_start_us,
                        timestamp_origin_us: start.timestamp_origin_us,
                        profile: -1,
                        level: -1,
                        width: plan.width,
                        height: plan.height,
                        has_b_frames: false,
                        audio_transcoded: true,
                    });
                    began = Some(Instant::now());
                    result.is_ok()
                }
                Event::Data {
                    bytes,
                    time_us,
                    key,
                } => {
                    let Some(began) = began else {
                        return false;
                    };
                    let due = match super::l1::pacing_due(time_us, lead) {
                        Ok(due) => due,
                        Err(error) => {
                            pacing_error = Some(error);
                            return false;
                        }
                    };
                    while began.elapsed() < due {
                        if stream.cancellation().load(Ordering::Acquire) {
                            return false;
                        }
                        thread::sleep(
                            (due - began.elapsed().min(due)).min(Duration::from_millis(10)),
                        );
                    }
                    bytes_written = bytes_written.saturating_add(bytes.len() as u64);
                    bytes_written <= media::MAX_BYTES && producer.push(bytes, time_us, key).is_ok()
                }
            },
            &mut || {
                if let Some(control) =
                    with_app(|app| super::l1::read_control(app, input, item, identity)).map_err(
                        |_| ProbeError::BackendFailure("L2 output context changed".into()),
                    )?
                {
                    last = control;
                }
                Ok(last)
            },
            Composite {
                video,
                fps: FPS_CAP,
                bit_rate: plan.bit_rate,
                end_us,
                overlay: (!external).then_some(&view as _),
            },
        )
    })();
    let finished = producer.finish(result.is_ok() && pacing_error.is_none());
    if let Some(error) = pacing_error {
        return Err(error);
    }
    let report = result.map_err(|e| {
        eprintln!("[cast] composited producer failed: {e}");
        ApiError::new(
            409,
            "cast_prepare_failed",
            "Cannot generate composited media",
        )
    })?;
    finished.map_err(|_| ApiError::new(409, "cast_prepare_failed", "L2 stream terminated"))?;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts(width: u32, height: u32) -> CastSummary {
        CastSummary {
            packets: 1,
            bytes: 1,
            profile: 100,
            level: 40,
            width,
            height,
            has_b_frames: false,
            audio_transcoded: false,
            source_start_us: 0,
            duration_us: 1_000_000,
            gop_us: None,
        }
    }

    #[test]
    fn plans_prefer_the_platform_and_keep_transcodes_within_1080p() {
        assert_eq!(fit(3840, 2160), (1920, 1080));
        assert_eq!(fit(1280, 720), (1280, 720));
        assert_eq!(fit(1080, 1920), (608, 1080));
        let all = composite::KIND_EXTERNAL | composite::KIND_H264 | composite::KIND_MPEG2;
        let plan = super::plan(all, None, &facts(1920, 1080)).unwrap();
        assert!(matches!(plan.video, Video::Transcode(TranscodeCodec::H264)));
        assert_eq!(plan.bit_rate, 8_000_000);
        let plan = super::plan(
            composite::KIND_EXTERNAL | composite::KIND_MPEG2,
            None,
            &facts(1280, 720),
        )
        .unwrap();
        assert!(matches!(
            plan.video,
            Video::Transcode(TranscodeCodec::Mpeg2)
        ));
        assert_eq!(plan.bit_rate, 7_500_000);
        assert_eq!(
            super::plan(all, None, &facts(3840, 2160)).err(),
            Some("composite_source_size")
        );
        assert_eq!(
            super::plan(composite::KIND_EXTERNAL, None, &facts(1280, 720)).err(),
            Some("composite_unavailable")
        );
    }
}
