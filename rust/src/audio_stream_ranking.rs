use std::collections::HashSet;

use serde::{Deserialize, Serialize};

const SCHEMA_VERSION: u32 = 1;
const DOLBY_QUALITY_ID: i64 = 30250;
const FLAC_QUALITY_ID: i64 = 30251;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AudioStreamDescriptor {
    pub original_index: usize,
    pub quality_id: i64,
    pub bandwidth: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AudioStreamSelectionRequest {
    pub audio_hires: bool,
    pub regular_streams: Vec<AudioStreamDescriptor>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioRegularReason {
    HiresEnabled,
    StandardOnly,
    HiresOnlyFallback,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AudioStreamSelection {
    Selected {
        selected_index: usize,
        ranked_indices: Vec<usize>,
        reason: AudioRegularReason,
    },
    NoMatch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioStreamSelectionError {
    InvalidRequest,
}

fn quality_rank(quality_id: i64) -> u8 {
    match quality_id {
        30250 => 0,
        30251 => 1,
        30280 => 2,
        30232 => 3,
        30216 => 4,
        _ => 99,
    }
}

pub fn select_audio_stream(
    request: &AudioStreamSelectionRequest,
) -> Result<AudioStreamSelection, AudioStreamSelectionError> {
    let mut indices = HashSet::with_capacity(request.regular_streams.len());
    if request
        .regular_streams
        .iter()
        .any(|stream| !indices.insert(stream.original_index))
    {
        return Err(AudioStreamSelectionError::InvalidRequest);
    }

    let mut ranked: Vec<(usize, &AudioStreamDescriptor)> =
        request.regular_streams.iter().enumerate().collect();
    let reason = if request.audio_hires {
        (!ranked.is_empty()).then_some(AudioRegularReason::HiresEnabled)
    } else {
        let standard: Vec<_> = ranked
            .iter()
            .copied()
            .filter(|(_, stream)| !matches!(stream.quality_id, DOLBY_QUALITY_ID | FLAC_QUALITY_ID))
            .collect();
        if standard.is_empty() {
            (!ranked.is_empty()).then_some(AudioRegularReason::HiresOnlyFallback)
        } else {
            ranked = standard;
            Some(AudioRegularReason::StandardOnly)
        }
    };
    ranked.sort_by_key(|(position, stream)| (quality_rank(stream.quality_id), *position));
    let ranked_indices: Vec<usize> = ranked
        .iter()
        .map(|(_, stream)| stream.original_index)
        .collect();
    Ok(match (ranked_indices.first().copied(), reason) {
        (Some(selected_index), Some(reason)) => AudioStreamSelection::Selected {
            selected_index,
            ranked_indices,
            reason,
        },
        _ => AudioStreamSelection::NoMatch,
    })
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AudioStreamWireDescriptor {
    original_index: usize,
    quality_id: i64,
    bandwidth: i64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AudioStreamWireRequest {
    schema_version: u32,
    audio_hires: bool,
    regular_streams: Vec<AudioStreamWireDescriptor>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum WireStatus {
    Selected,
    NoMatch,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum WireRegularReason {
    HiresEnabled,
    StandardOnly,
    HiresOnlyFallback,
}

#[derive(Debug, Serialize)]
struct AudioStreamWireResponse {
    schema_version: u32,
    status: WireStatus,
    selected_index: Option<usize>,
    ranked_indices: Vec<usize>,
    reason: Option<WireRegularReason>,
}

pub(crate) fn select_audio_stream_json(request_json: &str) -> Option<String> {
    let wire: AudioStreamWireRequest = serde_json::from_str(request_json).ok()?;
    if wire.schema_version != SCHEMA_VERSION
        || wire
            .regular_streams
            .windows(2)
            .any(|pair| pair[0].original_index >= pair[1].original_index)
    {
        return None;
    }
    let request = AudioStreamSelectionRequest {
        audio_hires: wire.audio_hires,
        regular_streams: wire
            .regular_streams
            .into_iter()
            .map(|stream| AudioStreamDescriptor {
                original_index: stream.original_index,
                quality_id: stream.quality_id,
                bandwidth: stream.bandwidth,
            })
            .collect(),
    };
    let response = match select_audio_stream(&request).ok()? {
        AudioStreamSelection::NoMatch => AudioStreamWireResponse {
            schema_version: SCHEMA_VERSION,
            status: WireStatus::NoMatch,
            selected_index: None,
            ranked_indices: vec![],
            reason: None,
        },
        AudioStreamSelection::Selected {
            selected_index,
            ranked_indices,
            reason,
        } => AudioStreamWireResponse {
            schema_version: SCHEMA_VERSION,
            status: WireStatus::Selected,
            selected_index: Some(selected_index),
            ranked_indices,
            reason: Some(match reason {
                AudioRegularReason::HiresEnabled => WireRegularReason::HiresEnabled,
                AudioRegularReason::StandardOnly => WireRegularReason::StandardOnly,
                AudioRegularReason::HiresOnlyFallback => WireRegularReason::HiresOnlyFallback,
            }),
        },
    };
    serde_json::to_string(&response).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stream(index: usize, quality: i64, bandwidth: i64) -> AudioStreamDescriptor {
        AudioStreamDescriptor {
            original_index: index,
            quality_id: quality,
            bandwidth,
        }
    }

    fn request(streams: Vec<AudioStreamDescriptor>, hires: bool) -> AudioStreamSelectionRequest {
        AudioStreamSelectionRequest {
            audio_hires: hires,
            regular_streams: streams,
        }
    }

    #[test]
    fn empty_and_one_stream() {
        assert_eq!(
            select_audio_stream(&request(vec![], true)).unwrap(),
            AudioStreamSelection::NoMatch
        );
        assert_eq!(
            select_audio_stream(&request(vec![stream(4, 30280, 1)], true)).unwrap(),
            AudioStreamSelection::Selected {
                selected_index: 4,
                ranked_indices: vec![4],
                reason: AudioRegularReason::HiresEnabled,
            }
        );
    }

    #[test]
    fn normal_quality_order_and_unknown_values() {
        let result = select_audio_stream(&request(
            vec![
                stream(0, 0, 999),
                stream(1, 30216, 1),
                stream(2, 30280, 1),
                stream(3, 30232, 1),
            ],
            true,
        ))
        .unwrap();
        assert_eq!(
            result,
            AudioStreamSelection::Selected {
                selected_index: 2,
                ranked_indices: vec![2, 3, 1, 0],
                reason: AudioRegularReason::HiresEnabled,
            }
        );
    }

    #[test]
    fn bandwidth_is_ignored_and_original_order_breaks_ties() {
        let result = select_audio_stream(&request(
            vec![stream(8, 30280, 0), stream(3, 30280, 999_999)],
            true,
        ))
        .unwrap();
        assert_eq!(
            result,
            AudioStreamSelection::Selected {
                selected_index: 8,
                ranked_indices: vec![8, 3],
                reason: AudioRegularReason::HiresEnabled,
            }
        );
    }

    #[test]
    fn hires_disabled_filters_dolby_and_flac_when_standard_exists() {
        let result = select_audio_stream(&request(
            vec![
                stream(0, 30250, 1),
                stream(1, 30251, 1),
                stream(2, 30280, 1),
            ],
            false,
        ))
        .unwrap();
        assert_eq!(
            result,
            AudioStreamSelection::Selected {
                selected_index: 2,
                ranked_indices: vec![2],
                reason: AudioRegularReason::StandardOnly,
            }
        );
    }

    #[test]
    fn hires_disabled_falls_back_when_regular_list_contains_only_hires() {
        let result = select_audio_stream(&request(
            vec![stream(0, 30251, 1), stream(1, 30250, 1)],
            false,
        ))
        .unwrap();
        assert_eq!(
            result,
            AudioStreamSelection::Selected {
                selected_index: 1,
                ranked_indices: vec![1, 0],
                reason: AudioRegularReason::HiresOnlyFallback,
            }
        );
    }

    #[test]
    fn duplicate_indices_invalid_non_monotonic_unique_indices_valid() {
        let duplicate = request(vec![stream(1, 30280, 1), stream(1, 30232, 1)], true);
        assert_eq!(
            select_audio_stream(&duplicate),
            Err(AudioStreamSelectionError::InvalidRequest)
        );
        let non_monotonic = request(vec![stream(8, 30280, 1), stream(2, 30232, 1)], true);
        assert!(select_audio_stream(&non_monotonic).is_ok());
    }

    #[test]
    fn repeated_execution_is_deterministic() {
        let req = request(vec![stream(0, 30280, 1), stream(1, 30280, 2)], true);
        assert_eq!(select_audio_stream(&req), select_audio_stream(&req));
    }

    #[test]
    fn wire_rejects_invalid_schema_and_duplicate_indices() {
        assert!(select_audio_stream_json("not json").is_none());
        assert!(
            select_audio_stream_json(
                r#"{"schema_version":2,"audio_hires":true,"regular_streams":[]}"#
            )
            .is_none()
        );
        assert!(select_audio_stream_json(r#"{"schema_version":1,"audio_hires":true,"regular_streams":[{"original_index":0,"quality_id":30280,"bandwidth":1},{"original_index":0,"quality_id":30232,"bandwidth":1}]}"#).is_none());
        assert!(
            select_audio_stream_json(
                r#"{"schema_version":1,"audio_hires":true,"regular_streams":[],"extra":true}"#
            )
            .is_none()
        );
    }
}
