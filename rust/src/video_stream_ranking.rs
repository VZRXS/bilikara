use std::collections::HashSet;

use serde::{Deserialize, Serialize};

const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VideoCodec {
    Avc,
    Hevc,
    Av1,
    Other(String),
}

impl VideoCodec {
    pub fn from_name(value: &str) -> Self {
        match value {
            "avc" => Self::Avc,
            "hevc" => Self::Hevc,
            "av1" => Self::Av1,
            _ => Self::Other(value.to_string()),
        }
    }

    pub fn name(&self) -> &str {
        match self {
            Self::Avc => "avc",
            Self::Hevc => "hevc",
            Self::Av1 => "av1",
            Self::Other(value) => value,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VideoStreamDescriptor {
    pub original_index: usize,
    pub quality_id: i64,
    pub bandwidth: i64,
    pub codec: VideoCodec,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VideoStreamSelectionRequest {
    pub max_quality_id: i64,
    pub codec_filter: Option<VideoCodec>,
    pub max_avc_quality_id: Option<i64>,
    pub streams: Vec<VideoStreamDescriptor>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VideoSelectionReason {
    Preferred,
    QualityFallback,
    UncappedFallback,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VideoStreamSelection {
    Selected {
        selected_index: usize,
        ranked_indices: Vec<usize>,
        reason: VideoSelectionReason,
    },
    NoMatch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VideoStreamSelectionError {
    InvalidRequest,
}

pub fn select_video_stream(
    request: &VideoStreamSelectionRequest,
) -> Result<VideoStreamSelection, VideoStreamSelectionError> {
    let mut indices = HashSet::with_capacity(request.streams.len());
    if request
        .streams
        .iter()
        .any(|stream| !indices.insert(stream.original_index))
    {
        return Err(VideoStreamSelectionError::InvalidRequest);
    }
    if request.streams.is_empty() {
        return Ok(VideoStreamSelection::NoMatch);
    }

    let codec_filter = request
        .codec_filter
        .as_ref()
        .filter(|codec| !codec.name().is_empty());

    let mut ranked: Vec<(usize, &VideoStreamDescriptor)> = request
        .streams
        .iter()
        .enumerate()
        .filter(|(_, stream)| {
            stream.quality_id <= request.max_quality_id
                && codec_filter.is_none_or(|codec| stream.codec == *codec)
                && !(codec_filter == Some(&VideoCodec::Avc)
                    && request
                        .max_avc_quality_id
                        .is_some_and(|cap| cap != 0 && stream.quality_id > cap))
        })
        .collect();
    let reason = if ranked.is_empty() {
        ranked = request
            .streams
            .iter()
            .enumerate()
            .filter(|(_, stream)| stream.quality_id <= request.max_quality_id)
            .collect();
        if ranked.is_empty() {
            ranked = request.streams.iter().enumerate().collect();
            VideoSelectionReason::UncappedFallback
        } else {
            VideoSelectionReason::QualityFallback
        }
    } else {
        VideoSelectionReason::Preferred
    };

    ranked.sort_by_key(|(position, stream)| {
        (
            std::cmp::Reverse(stream.quality_id),
            std::cmp::Reverse(stream.bandwidth),
            *position,
        )
    });
    let ranked_indices: Vec<usize> = ranked
        .iter()
        .map(|(_, stream)| stream.original_index)
        .collect();
    Ok(VideoStreamSelection::Selected {
        selected_index: ranked_indices[0],
        ranked_indices,
        reason,
    })
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct VideoStreamWireDescriptor {
    original_index: usize,
    quality_id: i64,
    bandwidth: i64,
    codec: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct VideoStreamWireRequest {
    schema_version: u32,
    max_quality_id: i64,
    codec_filter: Option<String>,
    max_avc_quality_id: Option<i64>,
    streams: Vec<VideoStreamWireDescriptor>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum WireStatus {
    Selected,
    NoMatch,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum WireReason {
    Preferred,
    QualityFallback,
    UncappedFallback,
}

#[derive(Debug, Serialize)]
struct VideoStreamWireResponse {
    schema_version: u32,
    status: WireStatus,
    selected_index: Option<usize>,
    ranked_indices: Vec<usize>,
    reason: Option<WireReason>,
}

pub(crate) fn select_video_stream_json(request_json: &str) -> Option<String> {
    let wire: VideoStreamWireRequest = serde_json::from_str(request_json).ok()?;
    if wire.schema_version != SCHEMA_VERSION
        || wire
            .streams
            .windows(2)
            .any(|pair| pair[0].original_index >= pair[1].original_index)
    {
        return None;
    }
    let request = VideoStreamSelectionRequest {
        max_quality_id: wire.max_quality_id,
        codec_filter: wire.codec_filter.as_deref().map(VideoCodec::from_name),
        max_avc_quality_id: wire.max_avc_quality_id,
        streams: wire
            .streams
            .into_iter()
            .map(|stream| VideoStreamDescriptor {
                original_index: stream.original_index,
                quality_id: stream.quality_id,
                bandwidth: stream.bandwidth,
                codec: VideoCodec::from_name(&stream.codec),
            })
            .collect(),
    };
    let response = match select_video_stream(&request).ok()? {
        VideoStreamSelection::NoMatch => VideoStreamWireResponse {
            schema_version: SCHEMA_VERSION,
            status: WireStatus::NoMatch,
            selected_index: None,
            ranked_indices: vec![],
            reason: None,
        },
        VideoStreamSelection::Selected {
            selected_index,
            ranked_indices,
            reason,
        } => VideoStreamWireResponse {
            schema_version: SCHEMA_VERSION,
            status: WireStatus::Selected,
            selected_index: Some(selected_index),
            ranked_indices,
            reason: Some(match reason {
                VideoSelectionReason::Preferred => WireReason::Preferred,
                VideoSelectionReason::QualityFallback => WireReason::QualityFallback,
                VideoSelectionReason::UncappedFallback => WireReason::UncappedFallback,
            }),
        },
    };
    serde_json::to_string(&response).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stream(index: usize, quality: i64, bandwidth: i64, codec: &str) -> VideoStreamDescriptor {
        VideoStreamDescriptor {
            original_index: index,
            quality_id: quality,
            bandwidth,
            codec: VideoCodec::from_name(codec),
        }
    }

    fn request(streams: Vec<VideoStreamDescriptor>) -> VideoStreamSelectionRequest {
        VideoStreamSelectionRequest {
            max_quality_id: 80,
            codec_filter: None,
            max_avc_quality_id: None,
            streams,
        }
    }

    #[test]
    fn empty_and_one_stream() {
        assert_eq!(
            select_video_stream(&request(vec![])).unwrap(),
            VideoStreamSelection::NoMatch
        );
        assert_eq!(
            select_video_stream(&request(vec![stream(7, 80, 0, "avc")])).unwrap(),
            VideoStreamSelection::Selected {
                selected_index: 7,
                ranked_indices: vec![7],
                reason: VideoSelectionReason::Preferred,
            }
        );
    }

    #[test]
    fn exact_quality_bandwidth_and_stable_order() {
        let result = select_video_stream(&request(vec![
            stream(4, 64, 999, "avc"),
            stream(2, 80, 100, "hevc"),
            stream(9, 80, 200, "av1"),
            stream(6, 80, 200, "avc"),
        ]))
        .unwrap();
        assert_eq!(
            result,
            VideoStreamSelection::Selected {
                selected_index: 9,
                ranked_indices: vec![9, 6, 2, 4],
                reason: VideoSelectionReason::Preferred,
            }
        );
    }

    #[test]
    fn codec_aliases_and_unknown_values_preserve_exact_identity() {
        assert_eq!(VideoCodec::from_name("avc"), VideoCodec::Avc);
        assert_eq!(VideoCodec::from_name("hevc"), VideoCodec::Hevc);
        assert_eq!(VideoCodec::from_name("av1"), VideoCodec::Av1);
        assert_eq!(VideoCodec::from_name("avc1").name(), "avc1");
        let mut req = request(vec![stream(0, 80, 1, "avc1"), stream(1, 80, 2, "avc")]);
        req.codec_filter = Some(VideoCodec::from_name("avc1"));
        assert_eq!(
            select_video_stream(&req).unwrap(),
            VideoStreamSelection::Selected {
                selected_index: 0,
                ranked_indices: vec![0],
                reason: VideoSelectionReason::Preferred,
            }
        );
    }

    #[test]
    fn unavailable_codec_uses_quality_fallback() {
        let mut req = request(vec![stream(0, 80, 1, "hevc"), stream(1, 64, 2, "av1")]);
        req.codec_filter = Some(VideoCodec::Avc);
        assert_eq!(
            select_video_stream(&req).unwrap(),
            VideoStreamSelection::Selected {
                selected_index: 0,
                ranked_indices: vec![0, 1],
                reason: VideoSelectionReason::QualityFallback,
            }
        );
    }

    #[test]
    fn empty_codec_filter_means_no_filter() {
        let mut req = request(vec![stream(0, 80, 1, "hevc"), stream(1, 64, 2, "avc")]);
        req.codec_filter = Some(VideoCodec::from_name(""));
        assert_eq!(
            select_video_stream(&req).unwrap(),
            VideoStreamSelection::Selected {
                selected_index: 0,
                ranked_indices: vec![0, 1],
                reason: VideoSelectionReason::Preferred,
            }
        );
    }

    #[test]
    fn requested_quality_unavailable_uses_uncapped_fallback() {
        let mut req = request(vec![stream(0, 116, 1, "avc"), stream(1, 120, 2, "hevc")]);
        req.max_quality_id = 64;
        assert_eq!(
            select_video_stream(&req).unwrap(),
            VideoStreamSelection::Selected {
                selected_index: 1,
                ranked_indices: vec![1, 0],
                reason: VideoSelectionReason::UncappedFallback,
            }
        );
    }

    #[test]
    fn avc_cap_applies_only_to_preferred_avc_stage() {
        let mut req = request(vec![stream(0, 80, 1, "avc"), stream(1, 64, 1, "avc")]);
        req.codec_filter = Some(VideoCodec::Avc);
        req.max_avc_quality_id = Some(64);
        assert_eq!(
            select_video_stream(&req).unwrap(),
            VideoStreamSelection::Selected {
                selected_index: 1,
                ranked_indices: vec![1],
                reason: VideoSelectionReason::Preferred,
            }
        );

        req.streams = vec![stream(0, 80, 1, "avc")];
        assert_eq!(
            select_video_stream(&req).unwrap(),
            VideoStreamSelection::Selected {
                selected_index: 0,
                ranked_indices: vec![0],
                reason: VideoSelectionReason::QualityFallback,
            }
        );
    }

    #[test]
    fn zero_bandwidth_and_non_monotonic_indices_are_valid() {
        let result = select_video_stream(&request(vec![
            stream(10, 80, 0, "avc"),
            stream(3, 80, 0, "avc"),
        ]))
        .unwrap();
        assert_eq!(
            result,
            VideoStreamSelection::Selected {
                selected_index: 10,
                ranked_indices: vec![10, 3],
                reason: VideoSelectionReason::Preferred,
            }
        );
    }

    #[test]
    fn duplicate_indices_are_invalid() {
        let req = request(vec![stream(1, 80, 1, "avc"), stream(1, 64, 2, "hevc")]);
        assert_eq!(
            select_video_stream(&req),
            Err(VideoStreamSelectionError::InvalidRequest)
        );
    }

    #[test]
    fn repeated_execution_is_deterministic() {
        let req = request(vec![stream(0, 80, 1, "avc"), stream(1, 80, 1, "avc")]);
        assert_eq!(select_video_stream(&req), select_video_stream(&req));
    }

    #[test]
    fn wire_rejects_invalid_schema_duplicate_or_non_increasing_indices() {
        assert!(select_video_stream_json("not json").is_none());
        assert!(select_video_stream_json(r#"{"schema_version":2,"max_quality_id":80,"codec_filter":null,"max_avc_quality_id":null,"streams":[]}"#).is_none());
        assert!(select_video_stream_json(r#"{"schema_version":1,"max_quality_id":80,"codec_filter":null,"max_avc_quality_id":null,"streams":[{"original_index":1,"quality_id":80,"bandwidth":1,"codec":"avc"},{"original_index":1,"quality_id":64,"bandwidth":1,"codec":"hevc"}]}"#).is_none());
    }
}
