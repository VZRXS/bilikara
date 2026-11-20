//! next 3057fb7 L1 DSP feeding R1/P4's unique, bounded T4 producer.
//! T5 remains the network session authority; local/Audience L1 is independent.
use super::*;
use crate::dlna::cast_http::{LiveProducer, LiveStream};
use crate::experimental_libav::{
    LibavMetadataProbe, ProbeError,
    cast_mux::{CastPacing, CastStart, CastSummary},
    live_audio::{Control, Event},
};
use std::time::Instant;

#[allow(clippy::too_many_arguments)]
pub(super) fn generate(
    probe: &LibavMetadataProbe,
    input: &media::Inputs,
    item: &crate::app_state::PlaylistItem,
    facts: CastSummary,
    position: f64,
    identity: (u64, u64),
    stream: Arc<LiveStream>,
    mut producer: LiveProducer,
) -> Result<(), ApiError> {
    let mut pacing_error = None;
    let result = (|| {
        // `facts` is the preflight that admitted this source to L1.
        let CastPacing::Realtime { burst } = producer.pacing() else {
            unreachable!()
        };
        // The ring starts its own clock in start(). Starting ours afterwards
        // and retaining 100ms headroom cannot spend preparation time as lead.
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
        let mut last = with_app(|app| read_control(app, input, item, identity))
            .map_err(|_| ProbeError::BackendFailure("L1 output context changed".into()))?
            .ok_or(ProbeError::Cancelled)?;
        probe.render_live_ts_with_events(
            &input.video,
            &paths,
            (position * 1_000_000.0) as i64,
            stream.cancellation(),
            &mut |event| match event {
                Event::Start(start) => {
                    let result = producer.start(CastStart {
                        source_start_us: start.source_start_us,
                        timestamp_origin_us: start.timestamp_origin_us,
                        profile: facts.profile,
                        level: facts.level,
                        width: facts.width,
                        height: facts.height,
                        has_b_frames: facts.has_b_frames,
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
                    let due = match pacing_due(time_us, lead) {
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
                // A program transition is retired by T5, not by this callback.
                // Keep only the last control for the old program until joined
                // cleanup, never apply a new song's settings to the old stream.
                if let Some(control) = with_app(|app| read_control(app, input, item, identity))
                    .map_err(|_| ProbeError::BackendFailure("L1 output context changed".into()))?
                {
                    last = control;
                }
                Ok(last)
            },
        )
    })();
    let finished = producer.finish(result.is_ok() && pacing_error.is_none());
    if let Some(error) = pacing_error {
        return Err(error);
    }
    result.map_err(|_| ApiError::new(409, "cast_prepare_failed", "Cannot generate L1 media"))?;
    finished.map_err(|_| ApiError::new(409, "cast_prepare_failed", "L1 stream terminated"))
}

pub(super) fn pacing_due(time_us: i64, lead: Duration) -> Result<Duration, ApiError> {
    // Validate before waiting: casting a negative DTS to u64 would keep the
    // worker asleep indefinitely, before the ring can reject the event.
    let time_us = u64::try_from(time_us)
        .map_err(|_| ApiError::new(409, "cast_prepare_failed", "Negative L1 media timestamp"))?;
    Ok(Duration::from_micros(time_us).saturating_sub(lead))
}

pub(super) fn read_control(
    app: &mut crate::app_state::AppState,
    input: &media::Inputs,
    item: &crate::app_state::PlaylistItem,
    identity: (u64, u64),
) -> Result<Option<Control>, ApiError> {
    let facts = match app.native_output_audio_facts() {
        Ok(facts) => facts,
        // T5 owns queue completion and program replacement, including the
        // empty-current interval. It must not become a producer failure.
        Err(error) if error.code == "output_media" => return Ok(None),
        Err(error) => return Err(error),
    };
    let s = &app.native().cast;
    if (s.operation, s.generation) != identity
        || s.cancel.is_cancelled()
        || facts.source.0 != item.id
        || facts.source.1 != item.item_incarnation_id
        || facts.source.2 != item.artifact_set_id
    {
        return Ok(None);
    }
    let track = input
        .tracks
        .iter()
        .position(|(id, _)| *id == facts.track)
        .ok_or_else(|| ApiError::invalid("Uncached L1 track"))?;
    Ok(Some(Control {
        offset_ms: facts.settings.av_offset_ms,
        key_shift: facts.settings.key_shift,
        volume_percent: facts.settings.volume_percent,
        muted: facts.settings.is_muted,
        track,
        mode: s.offset_mode,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pacing_rejects_negative_timestamps_before_waiting() {
        let lead = Duration::from_millis(1900);
        for time_us in [-1, i64::MIN] {
            let error = pacing_due(time_us, lead).unwrap_err();
            assert_eq!(error.status, 409);
            assert_eq!(error.code, "cast_prepare_failed");
            assert_eq!(error.message, "Negative L1 media timestamp");
        }
        assert_eq!(pacing_due(0, lead).unwrap(), Duration::ZERO);
        assert_eq!(pacing_due(1_900_000, lead).unwrap(), Duration::ZERO);
        assert_eq!(
            pacing_due(2_000_000, lead).unwrap(),
            Duration::from_millis(100)
        );
    }
}
