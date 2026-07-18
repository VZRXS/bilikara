use serde::{Deserialize, Serialize};

const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VideoQuality {
    Q360,
    Q480,
    Q720,
    Q720HighFrameRate,
    Q1080,
    Q1080HighBitrate,
    Q1080HighFrameRate,
    Q4k,
    Hdr,
    DolbyVision,
    Q8k,
}

impl VideoQuality {
    pub fn label(self) -> &'static str {
        match self {
            Self::Q360 => "360P 流畅",
            Self::Q480 => "480P 清晰",
            Self::Q720 => "720P 高清",
            Self::Q720HighFrameRate => "720P 60帧",
            Self::Q1080 => "1080P 高清",
            Self::Q1080HighBitrate => "1080P 高码率",
            Self::Q1080HighFrameRate => "1080P 高帧率",
            Self::Q4k => "4K 超清",
            Self::Hdr => "HDR 真彩",
            Self::DolbyVision => "杜比视界",
            Self::Q8k => "8K 超高清",
        }
    }

    pub fn dash_quality_id(self) -> i64 {
        match self {
            Self::Q360 => 16,
            Self::Q480 => 32,
            Self::Q720 => 64,
            Self::Q720HighFrameRate => 74,
            Self::Q1080 => 80,
            Self::Q1080HighBitrate => 112,
            Self::Q1080HighFrameRate => 116,
            Self::Q4k => 120,
            Self::Hdr => 125,
            Self::DolbyVision => 126,
            Self::Q8k => 127,
        }
    }

    fn from_exact_label(value: &str) -> Option<Self> {
        ALL_QUALITIES
            .iter()
            .copied()
            .find(|quality| quality.label() == value)
    }

    fn from_active_label(value: &str) -> Option<Self> {
        ACTIVE_QUALITIES
            .iter()
            .copied()
            .find(|quality| quality.label() == value.trim())
    }

    fn active_index(self) -> Option<usize> {
        ACTIVE_QUALITIES.iter().position(|quality| *quality == self)
    }

    fn max_height(self) -> u32 {
        match self {
            Self::Q360 => 360,
            Self::Q480 => 480,
            Self::Q720 | Self::Q720HighFrameRate => 720,
            Self::Q1080 | Self::Q1080HighBitrate | Self::Q1080HighFrameRate => 1080,
            Self::Q4k => 2160,
            Self::Q8k => 4320,
            Self::Hdr | Self::DolbyVision => 1080,
        }
    }
}

const ACTIVE_QUALITIES: [VideoQuality; 5] = [
    VideoQuality::Q1080HighFrameRate,
    VideoQuality::Q1080,
    VideoQuality::Q720,
    VideoQuality::Q480,
    VideoQuality::Q360,
];

const ALL_QUALITIES: [VideoQuality; 11] = [
    VideoQuality::Q360,
    VideoQuality::Q480,
    VideoQuality::Q720,
    VideoQuality::Q720HighFrameRate,
    VideoQuality::Q1080,
    VideoQuality::Q1080HighBitrate,
    VideoQuality::Q1080HighFrameRate,
    VideoQuality::Q4k,
    VideoQuality::Hdr,
    VideoQuality::DolbyVision,
    VideoQuality::Q8k,
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QualityPolicyRequest {
    pub raw_quality: String,
    pub raw_cap: String,
    pub choice_index: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QualityPolicyDecision {
    pub normalized_quality: VideoQuality,
    pub optional_quality: Option<VideoQuality>,
    pub optional_cap: Option<VideoQuality>,
    pub indexed_quality: Option<VideoQuality>,
    pub dash_max_quality_id: i64,
    pub effective_max_height: u32,
    pub bbdown_quality_order: Vec<VideoQuality>,
}

pub fn decide_quality_policy(request: &QualityPolicyRequest) -> QualityPolicyDecision {
    let optional_quality = VideoQuality::from_active_label(&request.raw_quality);
    let normalized_quality = optional_quality.unwrap_or(VideoQuality::Q1080HighFrameRate);
    let optional_cap = VideoQuality::from_active_label(&request.raw_cap);
    let indexed_quality = request
        .choice_index
        .and_then(|index| usize::try_from(index).ok())
        .and_then(|index| ACTIVE_QUALITIES.get(index).copied());
    let dash_max_quality_id = VideoQuality::from_exact_label(&request.raw_quality)
        .map(VideoQuality::dash_quality_id)
        .unwrap_or(80);
    let effective_quality = optional_cap.unwrap_or(normalized_quality);
    let start_index = normalized_quality
        .active_index()
        .expect("normalized quality is active")
        .max(
            optional_cap
                .and_then(VideoQuality::active_index)
                .unwrap_or(0),
        );

    QualityPolicyDecision {
        normalized_quality,
        optional_quality,
        optional_cap,
        indexed_quality,
        dash_max_quality_id,
        effective_max_height: effective_quality.max_height(),
        bbdown_quality_order: ACTIVE_QUALITIES[start_index..].to_vec(),
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct QualityPolicyWireRequest {
    schema_version: u32,
    raw_quality: String,
    raw_cap: String,
    choice_index: Option<i64>,
}

#[derive(Debug, Serialize)]
struct QualityPolicyWireResponse {
    schema_version: u32,
    status: &'static str,
    normalized_quality: &'static str,
    optional_quality: Option<&'static str>,
    optional_cap: Option<&'static str>,
    indexed_quality: Option<&'static str>,
    dash_max_quality_id: i64,
    effective_max_height: u32,
    bbdown_quality_order: Vec<&'static str>,
}

pub(crate) fn decide_quality_policy_json(request_json: &str) -> Option<String> {
    let wire: QualityPolicyWireRequest = serde_json::from_str(request_json).ok()?;
    if wire.schema_version != SCHEMA_VERSION {
        return None;
    }
    let decision = decide_quality_policy(&QualityPolicyRequest {
        raw_quality: wire.raw_quality,
        raw_cap: wire.raw_cap,
        choice_index: wire.choice_index,
    });
    serde_json::to_string(&QualityPolicyWireResponse {
        schema_version: SCHEMA_VERSION,
        status: "decided",
        normalized_quality: decision.normalized_quality.label(),
        optional_quality: decision.optional_quality.map(VideoQuality::label),
        optional_cap: decision.optional_cap.map(VideoQuality::label),
        indexed_quality: decision.indexed_quality.map(VideoQuality::label),
        dash_max_quality_id: decision.dash_max_quality_id,
        effective_max_height: decision.effective_max_height,
        bbdown_quality_order: decision
            .bbdown_quality_order
            .into_iter()
            .map(VideoQuality::label)
            .collect(),
    })
    .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decide(raw: &str, cap: &str, index: Option<i64>) -> QualityPolicyDecision {
        decide_quality_policy(&QualityPolicyRequest {
            raw_quality: raw.to_string(),
            raw_cap: cap.to_string(),
            choice_index: index,
        })
    }

    #[test]
    fn normalizes_every_active_quality_and_defaults_invalid_labels() {
        for quality in ACTIVE_QUALITIES {
            let result = decide(&format!("  {}  ", quality.label()), "", None);
            assert_eq!(result.normalized_quality, quality);
            assert_eq!(result.optional_quality, Some(quality));
        }
        let result = decide("unknown", "", None);
        assert_eq!(result.normalized_quality, VideoQuality::Q1080HighFrameRate);
        assert_eq!(result.optional_quality, None);
    }

    #[test]
    fn maps_every_dash_quality_id_without_trimming() {
        for quality in ALL_QUALITIES {
            assert_eq!(
                decide(quality.label(), "", None).dash_max_quality_id,
                quality.dash_quality_id()
            );
        }
        assert_eq!(decide(" 4K 超清 ", "", None).dash_max_quality_id, 80);
        assert_eq!(decide("", "", None).dash_max_quality_id, 80);
    }

    #[test]
    fn choice_indices_and_boundaries_match_active_choices() {
        for (index, quality) in ACTIVE_QUALITIES.iter().enumerate() {
            assert_eq!(
                decide("", "", Some(index as i64)).indexed_quality,
                Some(*quality)
            );
        }
        assert_eq!(decide("", "", Some(-1)).indexed_quality, None);
        assert_eq!(decide("", "", Some(5)).indexed_quality, None);
        assert_eq!(decide("", "", None).indexed_quality, None);
    }

    #[test]
    fn cap_controls_height_and_never_raises_bbdown_manual_quality() {
        let capped = decide("1080P 高帧率", "720P 高清", None);
        assert_eq!(capped.effective_max_height, 720);
        assert_eq!(
            capped.bbdown_quality_order,
            vec![VideoQuality::Q720, VideoQuality::Q480, VideoQuality::Q360]
        );

        let lower_manual = decide("480P 清晰", "720P 高清", None);
        assert_eq!(lower_manual.effective_max_height, 720);
        assert_eq!(
            lower_manual.bbdown_quality_order,
            vec![VideoQuality::Q480, VideoQuality::Q360]
        );
    }

    #[test]
    fn height_mapping_covers_active_boundaries() {
        let cases = [
            ("360P 流畅", 360),
            ("480P 清晰", 480),
            ("720P 高清", 720),
            ("1080P 高清", 1080),
            ("invalid", 1080),
        ];
        for (label, expected) in cases {
            assert_eq!(decide(label, "", None).effective_max_height, expected);
        }
    }

    #[test]
    fn repeated_execution_is_deterministic() {
        let request = QualityPolicyRequest {
            raw_quality: "歌曲 1080P".to_string(),
            raw_cap: "720P 高清".to_string(),
            choice_index: Some(2),
        };
        assert_eq!(
            decide_quality_policy(&request),
            decide_quality_policy(&request)
        );
    }

    #[test]
    fn wire_rejects_malformed_schema_and_unknown_fields() {
        assert!(decide_quality_policy_json("not json").is_none());
        assert!(
            decide_quality_policy_json(
                r#"{"schema_version":2,"raw_quality":"","raw_cap":"","choice_index":null}"#
            )
            .is_none()
        );
        assert!(
            decide_quality_policy_json(
                r#"{"schema_version":1,"raw_quality":"","raw_cap":"","choice_index":null,"extra":true}"#
            )
            .is_none()
        );
    }
}
