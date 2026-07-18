use std::collections::HashSet;

use serde::{Deserialize, Serialize};

const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolKind {
    Bbdown,
    YtDlp,
    Aria2c,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolTarget {
    pub platform: String,
    pub architecture: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolAssetInput {
    Supplied { name: String, primary_url: String },
    DefaultForTarget(ToolTarget),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolFallbackBaseInput {
    pub original_index: usize,
    pub base_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolDownloadPlanRequest {
    pub tool: ToolKind,
    pub asset: ToolAssetInput,
    pub fallback_bases: Vec<ToolFallbackBaseInput>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolCandidateSource {
    SuppliedPrimary,
    BuiltInPrimary,
    ConfiguredFallback,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedToolCandidate {
    pub source: ToolCandidateSource,
    pub fallback_index: Option<usize>,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolDownloadPlan {
    pub tool: ToolKind,
    pub asset_name: String,
    pub candidates: Vec<PlannedToolCandidate>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolDownloadPlanError {
    InvalidRequest,
    UnsupportedTarget,
}

pub fn plan_tool_download_candidates(
    request: &ToolDownloadPlanRequest,
) -> Result<ToolDownloadPlan, ToolDownloadPlanError> {
    let mut indices = HashSet::with_capacity(request.fallback_bases.len());
    if request
        .fallback_bases
        .iter()
        .any(|fallback| !indices.insert(fallback.original_index))
    {
        return Err(ToolDownloadPlanError::InvalidRequest);
    }

    let (asset_name, primary) = match &request.asset {
        ToolAssetInput::Supplied { name, primary_url } => {
            if name.is_empty() {
                return Err(ToolDownloadPlanError::InvalidRequest);
            }
            (
                name.clone(),
                (!primary_url.is_empty())
                    .then(|| (ToolCandidateSource::SuppliedPrimary, primary_url.clone())),
            )
        }
        ToolAssetInput::DefaultForTarget(target) => default_asset(request.tool, target)?,
    };

    let mut candidates = Vec::new();
    let mut seen = HashSet::new();
    if let Some((source, url)) = primary {
        seen.insert(url.clone());
        candidates.push(PlannedToolCandidate {
            source,
            fallback_index: None,
            url,
        });
    }
    for fallback in &request.fallback_bases {
        if fallback.base_url.is_empty() {
            continue;
        }
        let url = format!(
            "{}/{}",
            fallback.base_url,
            quote_tool_asset_name(&asset_name)
        );
        if seen.insert(url.clone()) {
            candidates.push(PlannedToolCandidate {
                source: ToolCandidateSource::ConfiguredFallback,
                fallback_index: Some(fallback.original_index),
                url,
            });
        }
    }
    if matches!(request.asset, ToolAssetInput::DefaultForTarget(_))
        && matches!(request.tool, ToolKind::Bbdown | ToolKind::YtDlp)
        && candidates.is_empty()
    {
        return Err(ToolDownloadPlanError::InvalidRequest);
    }

    Ok(ToolDownloadPlan {
        tool: request.tool,
        asset_name,
        candidates,
    })
}

fn default_asset(
    tool: ToolKind,
    target: &ToolTarget,
) -> Result<(String, Option<(ToolCandidateSource, String)>), ToolDownloadPlanError> {
    let name = match tool {
        ToolKind::Bbdown => match (target.platform.as_str(), target.architecture.as_str()) {
            ("windows", "x64" | "x86") => "BBDown_1.6.3_20240814_win-x64.zip",
            ("windows", "arm64") => "BBDown_1.6.3_20240814_win-arm64.zip",
            ("darwin", "x64") => "BBDown_1.6.3_20240814_osx-x64.zip",
            ("darwin", "arm64") => "BBDown_1.6.3_20240814_osx-arm64.zip",
            ("linux", "x64") => "BBDown_1.6.3_20240814_linux-x64.zip",
            ("linux", "arm64") => "BBDown_1.6.3_20240814_linux-arm64.zip",
            _ => return Err(ToolDownloadPlanError::UnsupportedTarget),
        },
        ToolKind::YtDlp => match (target.platform.as_str(), target.architecture.as_str()) {
            ("windows", "arm64") => "yt-dlp_arm64.exe",
            ("windows", "x86") => "yt-dlp_x86.exe",
            ("windows", _) => "yt-dlp.exe",
            ("darwin", _) => "yt-dlp_macos",
            ("linux", _) => "yt-dlp_linux",
            _ => "yt-dlp",
        },
        ToolKind::Aria2c => {
            if target.platform != "windows" {
                return Err(ToolDownloadPlanError::UnsupportedTarget);
            }
            if target.architecture == "x86" {
                "aria2-1.37.0-win-32bit-build1.zip"
            } else {
                "aria2-1.37.0-win-64bit-build1.zip"
            }
        }
    }
    .to_string();
    let primary = if tool == ToolKind::Aria2c {
        Some((
            ToolCandidateSource::BuiltInPrimary,
            format!(
                "https://github.com/aria2/aria2/releases/download/release-1.37.0/{}",
                quote_tool_asset_name(&name)
            ),
        ))
    } else {
        None
    };
    Ok((name, primary))
}

fn quote_tool_asset_name(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut result = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~' | b'/') {
            result.push(char::from(byte));
        } else {
            result.push('%');
            result.push(char::from(HEX[(byte >> 4) as usize]));
            result.push(char::from(HEX[(byte & 0x0f) as usize]));
        }
    }
    result
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ToolDownloadPlanWireRequest {
    schema_version: u32,
    tool: ToolKindWire,
    asset: ToolAssetWireInput,
    fallback_bases: Vec<ToolFallbackBaseWireInput>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum ToolKindWire {
    Bbdown,
    #[serde(rename = "ytdlp")]
    YtDlp,
    Aria2c,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
enum ToolAssetWireInput {
    Supplied { name: String, primary_url: String },
    DefaultForTarget { platform: String, arch: String },
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ToolFallbackBaseWireInput {
    original_index: usize,
    base_url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum ToolDownloadPlanWireStatus {
    Planned,
    Empty,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum ToolCandidateSourceWire {
    SuppliedPrimary,
    BuiltInPrimary,
    ConfiguredFallback,
}

#[derive(Debug, Serialize)]
struct PlannedToolCandidateWire {
    source: ToolCandidateSourceWire,
    fallback_index: Option<usize>,
    url: String,
}

#[derive(Debug, Serialize)]
struct ToolDownloadPlanWireResponse {
    schema_version: u32,
    status: ToolDownloadPlanWireStatus,
    tool: ToolKindWire,
    asset_name: String,
    candidates: Vec<PlannedToolCandidateWire>,
}

impl From<ToolKindWire> for ToolKind {
    fn from(tool: ToolKindWire) -> Self {
        match tool {
            ToolKindWire::Bbdown => Self::Bbdown,
            ToolKindWire::YtDlp => Self::YtDlp,
            ToolKindWire::Aria2c => Self::Aria2c,
        }
    }
}

impl From<ToolKind> for ToolKindWire {
    fn from(tool: ToolKind) -> Self {
        match tool {
            ToolKind::Bbdown => Self::Bbdown,
            ToolKind::YtDlp => Self::YtDlp,
            ToolKind::Aria2c => Self::Aria2c,
        }
    }
}

pub(crate) fn plan_tool_download_candidates_json(request_json: &str) -> Option<String> {
    let wire: ToolDownloadPlanWireRequest = serde_json::from_str(request_json).ok()?;
    if wire.schema_version != SCHEMA_VERSION {
        return None;
    }
    let mut previous_index = None;
    for fallback in &wire.fallback_bases {
        if previous_index.is_some_and(|previous| fallback.original_index <= previous) {
            return None;
        }
        previous_index = Some(fallback.original_index);
    }
    let tool: ToolKind = wire.tool.into();
    let request = ToolDownloadPlanRequest {
        tool,
        asset: match wire.asset {
            ToolAssetWireInput::Supplied { name, primary_url } => {
                ToolAssetInput::Supplied { name, primary_url }
            }
            ToolAssetWireInput::DefaultForTarget { platform, arch } => {
                ToolAssetInput::DefaultForTarget(ToolTarget {
                    platform,
                    architecture: arch,
                })
            }
        },
        fallback_bases: wire
            .fallback_bases
            .into_iter()
            .map(|fallback| ToolFallbackBaseInput {
                original_index: fallback.original_index,
                base_url: fallback.base_url,
            })
            .collect(),
    };
    let plan = plan_tool_download_candidates(&request).ok()?;
    let status = if plan.candidates.is_empty() {
        ToolDownloadPlanWireStatus::Empty
    } else {
        ToolDownloadPlanWireStatus::Planned
    };
    serde_json::to_string(&ToolDownloadPlanWireResponse {
        schema_version: SCHEMA_VERSION,
        status,
        tool: plan.tool.into(),
        asset_name: plan.asset_name,
        candidates: plan
            .candidates
            .into_iter()
            .map(|candidate| PlannedToolCandidateWire {
                source: match candidate.source {
                    ToolCandidateSource::SuppliedPrimary => {
                        ToolCandidateSourceWire::SuppliedPrimary
                    }
                    ToolCandidateSource::BuiltInPrimary => ToolCandidateSourceWire::BuiltInPrimary,
                    ToolCandidateSource::ConfiguredFallback => {
                        ToolCandidateSourceWire::ConfiguredFallback
                    }
                },
                fallback_index: candidate.fallback_index,
                url: candidate.url,
            })
            .collect(),
    })
    .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fallback(index: usize, base: &str) -> ToolFallbackBaseInput {
        ToolFallbackBaseInput {
            original_index: index,
            base_url: base.to_string(),
        }
    }

    #[test]
    fn supplied_primary_is_first_and_exact_duplicates_are_removed() {
        let request = ToolDownloadPlanRequest {
            tool: ToolKind::YtDlp,
            asset: ToolAssetInput::Supplied {
                name: "yt dlp/歌曲".to_string(),
                primary_url: " https://primary ".to_string(),
            },
            fallback_bases: vec![fallback(2, ""), fallback(5, "https://mirror")],
        };
        let plan = plan_tool_download_candidates(&request).unwrap();
        assert_eq!(plan.candidates[0].url, " https://primary ");
        assert_eq!(
            plan.candidates[1].url,
            "https://mirror/yt%20dlp/%E6%AD%8C%E6%9B%B2"
        );
        assert_eq!(plan.candidates[1].fallback_index, Some(5));
    }

    #[test]
    fn default_assets_preserve_platform_mappings_and_mirror_order() {
        let bbdown = ToolDownloadPlanRequest {
            tool: ToolKind::Bbdown,
            asset: ToolAssetInput::DefaultForTarget(ToolTarget {
                platform: "windows".to_string(),
                architecture: "x86".to_string(),
            }),
            fallback_bases: vec![fallback(0, "https://one"), fallback(1, "https://two")],
        };
        let plan = plan_tool_download_candidates(&bbdown).unwrap();
        assert_eq!(plan.asset_name, "BBDown_1.6.3_20240814_win-x64.zip");
        assert_eq!(plan.candidates.len(), 2);
        assert!(plan.candidates[0].url.starts_with("https://one/"));

        let aria = ToolDownloadPlanRequest {
            tool: ToolKind::Aria2c,
            asset: ToolAssetInput::DefaultForTarget(ToolTarget {
                platform: "windows".to_string(),
                architecture: "x86".to_string(),
            }),
            fallback_bases: vec![fallback(0, "https://mirror")],
        };
        let plan = plan_tool_download_candidates(&aria).unwrap();
        assert_eq!(plan.asset_name, "aria2-1.37.0-win-32bit-build1.zip");
        assert_eq!(
            plan.candidates[0].source,
            ToolCandidateSource::BuiltInPrimary
        );
        assert_eq!(
            plan.candidates[1].source,
            ToolCandidateSource::ConfiguredFallback
        );
    }

    #[test]
    fn repeated_fallback_results_are_deduplicated_stably() {
        let request = ToolDownloadPlanRequest {
            tool: ToolKind::YtDlp,
            asset: ToolAssetInput::Supplied {
                name: "yt-dlp".to_string(),
                primary_url: "https://mirror/yt-dlp".to_string(),
            },
            fallback_bases: vec![fallback(0, "https://mirror"), fallback(1, "https://mirror")],
        };
        let plan = plan_tool_download_candidates(&request).unwrap();
        assert_eq!(plan.candidates.len(), 1);
        assert_eq!(
            plan.candidates[0].source,
            ToolCandidateSource::SuppliedPrimary
        );
    }

    #[test]
    fn empty_supplied_plan_is_valid_but_invalid_and_unsupported_requests_fail() {
        let empty = ToolDownloadPlanRequest {
            tool: ToolKind::Bbdown,
            asset: ToolAssetInput::Supplied {
                name: "asset.zip".to_string(),
                primary_url: String::new(),
            },
            fallback_bases: vec![],
        };
        assert!(
            plan_tool_download_candidates(&empty)
                .unwrap()
                .candidates
                .is_empty()
        );

        let duplicate_indices = ToolDownloadPlanRequest {
            fallback_bases: vec![fallback(1, "a"), fallback(1, "b")],
            ..empty.clone()
        };
        assert_eq!(
            plan_tool_download_candidates(&duplicate_indices),
            Err(ToolDownloadPlanError::InvalidRequest)
        );

        let unsupported = ToolDownloadPlanRequest {
            tool: ToolKind::Aria2c,
            asset: ToolAssetInput::DefaultForTarget(ToolTarget {
                platform: "linux".to_string(),
                architecture: "x64".to_string(),
            }),
            fallback_bases: vec![],
        };
        assert_eq!(
            plan_tool_download_candidates(&unsupported),
            Err(ToolDownloadPlanError::UnsupportedTarget)
        );
    }

    #[test]
    fn unicode_percent_encoding_and_execution_are_deterministic() {
        let request = ToolDownloadPlanRequest {
            tool: ToolKind::YtDlp,
            asset: ToolAssetInput::Supplied {
                name: "歌曲%20demo".to_string(),
                primary_url: String::new(),
            },
            fallback_bases: vec![fallback(0, "https://例子.test")],
        };
        let first = plan_tool_download_candidates(&request).unwrap();
        assert_eq!(
            first.candidates[0].url,
            "https://例子.test/%E6%AD%8C%E6%9B%B2%2520demo"
        );
        for _ in 0..20 {
            assert_eq!(plan_tool_download_candidates(&request).unwrap(), first);
        }
    }

    #[test]
    fn wire_rejects_bad_schema_enums_indices_and_unknown_fields() {
        for invalid in [
            r#"{"schema_version":2,"tool":"bbdown","asset":{"mode":"supplied","name":"a","primary_url":""},"fallback_bases":[]}"#,
            r#"{"schema_version":1,"tool":"unknown","asset":{"mode":"supplied","name":"a","primary_url":""},"fallback_bases":[]}"#,
            r#"{"schema_version":1,"tool":"bbdown","asset":{"mode":"unknown"},"fallback_bases":[]}"#,
            r#"{"schema_version":1,"tool":"bbdown","asset":{"mode":"supplied","name":"a","primary_url":""},"fallback_bases":[{"original_index":1,"base_url":"a"},{"original_index":1,"base_url":"b"}]}"#,
            r#"{"schema_version":1,"tool":"bbdown","asset":{"mode":"supplied","name":"a","primary_url":""},"fallback_bases":[],"extra":true}"#,
        ] {
            assert!(plan_tool_download_candidates_json(invalid).is_none());
        }
    }
}
