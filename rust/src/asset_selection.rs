use serde::{Deserialize, Serialize};

use crate::archive::is_downloadable_archive;
use crate::asset_tokens::{
    asset_tokens, has_arm64, has_linux, has_macos, has_universal, has_windows, has_x64,
};

const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SelectionRequest {
    schema_version: u32,
    target: Target,
    assets: Vec<AssetDescriptor>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Target {
    platform: String,
    arch: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AssetDescriptor {
    original_index: usize,
    name: String,
    label: String,
    browser_download_url: String,
    content_type: String,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum SelectionStatus {
    Selected,
    NoMatch,
}

#[derive(Debug, PartialEq, Serialize)]
struct AssetScore {
    original_index: usize,
    score: i32,
}

#[derive(Debug, PartialEq, Serialize)]
struct SelectionResponse {
    schema_version: u32,
    status: SelectionStatus,
    selected_index: Option<usize>,
    scores: Vec<AssetScore>,
}

fn asset_text(asset: &AssetDescriptor) -> String {
    [
        asset.name.as_str(),
        asset.label.as_str(),
        asset.browser_download_url.as_str(),
        asset.content_type.as_str(),
    ]
    .join(" ")
    .to_lowercase()
}

fn score_asset_for_target(asset: &AssetDescriptor, target: &Target) -> i32 {
    if !is_downloadable_archive(&asset.name, &asset.browser_download_url) {
        return -1;
    }

    let text = asset_text(asset);
    let tokens = asset_tokens(&text);
    let windows_asset = has_windows(&tokens);
    let macos_asset = has_macos(&tokens);
    let linux_asset = has_linux(&tokens);
    let x64_asset = has_x64(&text, &tokens);
    let arm64_asset = has_arm64(&tokens);
    let universal_asset = has_universal(&tokens);

    let platform_score = match target.platform.as_str() {
        "windows" => {
            if macos_asset || linux_asset || !windows_asset {
                return -1;
            }
            100
        }
        "macos" => {
            if windows_asset || linux_asset || !macos_asset {
                return -1;
            }
            100
        }
        _ => return -1,
    };

    let arch_score = match target.arch.as_str() {
        "arm64" => {
            if arm64_asset {
                40
            } else if target.platform == "macos" && universal_asset {
                30
            } else if x64_asset || target.platform == "windows" {
                return -1;
            } else {
                5
            }
        }
        "x64" | "amd64" => {
            if x64_asset {
                40
            } else if target.platform == "macos" && universal_asset {
                30
            } else if arm64_asset {
                return -1;
            } else {
                5
            }
        }
        _ => {
            if x64_asset || arm64_asset || universal_asset {
                5
            } else {
                0
            }
        }
    };

    platform_score + arch_score
}

fn select_update_asset(request: SelectionRequest) -> Option<SelectionResponse> {
    if request.schema_version != SCHEMA_VERSION
        || request
            .assets
            .windows(2)
            .any(|pair| pair[0].original_index >= pair[1].original_index)
    {
        return None;
    }

    let scores: Vec<AssetScore> = request
        .assets
        .iter()
        .map(|asset| AssetScore {
            original_index: asset.original_index,
            score: score_asset_for_target(asset, &request.target),
        })
        .collect();

    let selected_index = scores
        .iter()
        .filter(|entry| entry.score >= 0)
        .max_by_key(|entry| (entry.score, std::cmp::Reverse(entry.original_index)))
        .map(|entry| entry.original_index);
    let status = if selected_index.is_some() {
        SelectionStatus::Selected
    } else {
        SelectionStatus::NoMatch
    };

    Some(SelectionResponse {
        schema_version: SCHEMA_VERSION,
        status,
        selected_index,
        scores,
    })
}

/// Parses a schema-v1 selection request and serializes its deterministic result.
///
/// `None` means that the JSON was malformed, the schema was unsupported, asset
/// indexes were not strictly increasing and unique, or response serialization
/// failed. A valid request with no eligible asset returns a `no_match` response.
pub(crate) fn select_update_asset_json(request_json: &str) -> Option<String> {
    let request: SelectionRequest = serde_json::from_str(request_json).ok()?;
    let response = select_update_asset(request)?;
    serde_json::to_string(&response).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn request(target_platform: &str, target_arch: &str, assets: Value) -> String {
        json!({
            "schema_version": 1,
            "target": {"platform": target_platform, "arch": target_arch},
            "assets": assets,
        })
        .to_string()
    }

    fn asset(index: usize, name: &str, url: &str) -> Value {
        json!({
            "original_index": index,
            "name": name,
            "label": "",
            "browser_download_url": url,
            "content_type": "application/zip",
        })
    }

    fn response(request_json: &str) -> Value {
        serde_json::from_str(&select_update_asset_json(request_json).unwrap()).unwrap()
    }

    #[test]
    fn preserves_platform_and_architecture_scores() {
        let cases = [
            (
                "windows",
                "x64",
                asset(0, "bilikara-windows-x64.zip", "https://example/file.zip"),
                140,
            ),
            (
                "windows",
                "arm64",
                asset(0, "bilikara-windows-arm64.zip", "https://example/file.zip"),
                140,
            ),
            (
                "windows",
                "arm64",
                asset(0, "bilikara-windows-x64.zip", "https://example/file.zip"),
                -1,
            ),
            (
                "macos",
                "x64",
                asset(0, "bilikara-macos-x64.zip", "https://example/file.zip"),
                140,
            ),
            (
                "macos",
                "arm64",
                asset(
                    0,
                    "bilikara-macos-universal2.zip",
                    "https://example/file.zip",
                ),
                130,
            ),
            (
                "macos",
                "x64",
                asset(
                    0,
                    "bilikara-macos-universal2.zip",
                    "https://example/file.zip",
                ),
                130,
            ),
            (
                "macos",
                "arm64",
                asset(0, "bilikara-macos.zip", "https://example/file.zip"),
                105,
            ),
            (
                "macos",
                "x64",
                asset(0, "bilikara-macos-arm64.zip", "https://example/file.zip"),
                -1,
            ),
            (
                "macos",
                "unknown",
                asset(0, "bilikara-macos.zip", "https://example/file.zip"),
                100,
            ),
            (
                "macos",
                "unknown",
                asset(0, "bilikara-macos-x64.zip", "https://example/file.zip"),
                105,
            ),
            (
                "windows",
                "x64",
                asset(0, "bilikara-macos-x64.zip", "https://example/file.zip"),
                -1,
            ),
            (
                "linux",
                "x64",
                asset(0, "bilikara-linux-x64.zip", "https://example/file.zip"),
                -1,
            ),
        ];

        for (platform, arch, descriptor, expected) in cases {
            let result = response(&request(platform, arch, json!([descriptor])));
            assert_eq!(result["scores"][0]["score"], expected);
        }
    }

    #[test]
    fn recognizes_query_zip_and_rejects_non_downloadable_assets() {
        let result = response(&request(
            "windows",
            "x64",
            json!([
                asset(
                    0,
                    "bilikara-windows-x64",
                    "https://example/download.zip?token=1"
                ),
                asset(
                    1,
                    "bilikara-windows-x64.zip.sha256",
                    "https://example/download.zip"
                ),
                asset(
                    2,
                    "bilikara-windows-x64.zip.sha256sum",
                    "https://example/download.zip"
                ),
                asset(
                    3,
                    "bilikara-windows-x64.zip.sig",
                    "https://example/download.zip"
                ),
                asset(
                    4,
                    "bilikara-windows-x64.zip.asc",
                    "https://example/download.zip"
                ),
                asset(
                    5,
                    "bilikara-windows-x64.txt",
                    "https://example/download.zip"
                ),
                asset(6, "bilikara-windows-x64.zip", ""),
            ]),
        ));

        assert_eq!(result["selected_index"], 0);
        assert_eq!(
            result["scores"],
            json!([
                {"original_index": 0, "score": 140},
                {"original_index": 1, "score": -1},
                {"original_index": 2, "score": -1},
                {"original_index": 3, "score": -1},
                {"original_index": 4, "score": -1},
                {"original_index": 5, "score": -1},
                {"original_index": 6, "score": -1},
            ])
        );
    }

    #[test]
    fn equal_scores_choose_the_earliest_original_index() {
        let result = response(&request(
            "windows",
            "x64",
            json!([
                asset(3, "first-windows-x64.zip", "https://example/first.zip"),
                asset(9, "second-windows-x64.zip", "https://example/second.zip"),
            ]),
        ));

        assert_eq!(result["status"], "selected");
        assert_eq!(result["selected_index"], 3);
        assert_eq!(result["scores"][0]["score"], 140);
        assert_eq!(result["scores"][1]["score"], 140);
    }

    #[test]
    fn empty_and_ineligible_assets_are_successful_no_match_results() {
        let empty = response(&request("windows", "x64", json!([])));
        assert_eq!(empty["status"], "no_match");
        assert!(empty["selected_index"].is_null());
        assert_eq!(empty["scores"], json!([]));

        let ineligible = response(&request(
            "linux",
            "x64",
            json!([asset(
                2,
                "bilikara-linux-x86_64.zip",
                "https://example/linux.zip"
            )]),
        ));
        assert_eq!(ineligible["status"], "no_match");
        assert!(ineligible["selected_index"].is_null());
        assert_eq!(ineligible["scores"][0]["score"], -1);
    }

    #[test]
    fn unicode_and_escaped_nul_fields_are_processed_without_failure() {
        let result = response(&request(
            "macos",
            "arm64",
            json!([{
                "original_index": 0,
                "name": "歌\u{0}名-macos-arm64.zip",
                "label": "日本語",
                "browser_download_url": "https://example/歌曲.zip",
                "content_type": "application/zip",
            }]),
        ));
        assert_eq!(result["status"], "selected");
        assert_eq!(result["scores"][0]["score"], 140);
    }

    #[test]
    fn rejects_invalid_json_schema_and_indexes() {
        assert!(select_update_asset_json("not json").is_none());
        assert!(
            select_update_asset_json(
                &json!({
                    "schema_version": 2,
                    "target": {"platform": "windows", "arch": "x64"},
                    "assets": [],
                })
                .to_string()
            )
            .is_none()
        );
        assert!(
            select_update_asset_json(
                &json!({
                    "schema_version": 1,
                    "target": {"platform": "windows", "arch": "x64"},
                    "assets": [
                        asset(2, "a-windows-x64.zip", "https://example/a.zip"),
                        asset(2, "b-windows-x64.zip", "https://example/b.zip"),
                    ],
                })
                .to_string()
            )
            .is_none()
        );
        assert!(
            select_update_asset_json(
                &json!({
                    "schema_version": 1,
                    "target": {"platform": "windows", "arch": "x64"},
                    "assets": [
                        asset(4, "a-windows-x64.zip", "https://example/a.zip"),
                        asset(1, "b-windows-x64.zip", "https://example/b.zip"),
                    ],
                })
                .to_string()
            )
            .is_none()
        );
        assert!(
            select_update_asset_json(
                &json!({
                    "schema_version": 1,
                    "target": {
                        "platform": "windows",
                        "arch": "x64",
                        "unexpected": true
                    },
                    "assets": [],
                })
                .to_string()
            )
            .is_none()
        );
        assert!(
            select_update_asset_json(
                &json!({
                    "schema_version": 1,
                    "target": {"platform": "windows", "arch": "x64"},
                    "assets": [{
                        "original_index": 0,
                        "name": "bilikara-windows-x64.zip",
                        "label": "",
                        "browser_download_url": "https://example/file.zip",
                        "content_type": "application/zip",
                        "unexpected": true,
                    }],
                })
                .to_string()
            )
            .is_none()
        );
        assert!(
            select_update_asset_json(
                &json!({
                    "schema_version": 1,
                    "target": {"platform": "windows", "arch": "x64"},
                    "assets": [{
                        "original_index": 0,
                        "name": "bilikara-windows-x64.zip",
                        "label": "",
                        "browser_download_url": "https://example/file.zip",
                    }],
                })
                .to_string()
            )
            .is_none()
        );
    }
}
