use serde::{Deserialize, Serialize};
use std::cmp::Ordering;

use crate::version::version_sort_key_impl;

const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseCandidate {
    pub tag_name: String,
    pub draft: bool,
    pub prerelease: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseSelectionRequest {
    pub current_version: String,
    pub include_preview: bool,
    pub releases: Vec<ReleaseCandidate>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReleaseCandidateWire {
    tag_name: String,
    draft: bool,
    prerelease: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SelectionWireRequest {
    schema_version: u32,
    current_version: String,
    include_preview: bool,
    releases: Vec<ReleaseCandidateWire>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ReleaseSelection {
    Selected { selected_index: usize },
    NoMatch,
}

#[derive(Debug, PartialEq, Eq)]
#[allow(dead_code)]
pub enum ReleaseSelectionError {
    InvalidSchemaVersion,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum SelectionStatus {
    Selected,
    NoMatch,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
struct SelectionResponse {
    schema_version: u32,
    status: SelectionStatus,
    selected_index: Option<usize>,
}

fn parsed_version_sort_key(version: &str) -> Option<[String; 5]> {
    version_sort_key_impl(version)
}

fn compare_numeric_fields(left: &str, right: &str) -> Ordering {
    let left = left.trim_start_matches('0');
    let right = right.trim_start_matches('0');
    let left = if left.is_empty() { "0" } else { left };
    let right = if right.is_empty() { "0" } else { right };

    left.len().cmp(&right.len()).then_with(|| left.cmp(right))
}

fn compare_version_sort_keys(left: &[String; 5], right: &[String; 5]) -> Ordering {
    for (left_part, right_part) in left.iter().zip(right.iter()) {
        let ordering = compare_numeric_fields(left_part, right_part);
        if ordering != Ordering::Equal {
            return ordering;
        }
    }
    Ordering::Equal
}

pub fn select_release(
    request: &ReleaseSelectionRequest,
) -> Result<ReleaseSelection, ReleaseSelectionError> {
    let mut valid_releases = Vec::new();

    for (i, release) in request.releases.iter().enumerate() {
        if !release.draft {
            if let Some(sort_key) = parsed_version_sort_key(&release.tag_name) {
                valid_releases.push((i, release, sort_key));
            }
        }
    }

    if valid_releases.is_empty() {
        return Ok(ReleaseSelection::NoMatch);
    }

    let candidates: Vec<_> = if request.include_preview {
        valid_releases.iter().collect()
    } else {
        valid_releases
            .iter()
            .filter(|(_, _, sort_key)| sort_key[3] == "1")
            .collect()
    };

    if candidates.is_empty() {
        return Ok(ReleaseSelection::NoMatch);
    }

    let mut best_index = candidates[0].0;
    let mut best_sort_key = &candidates[0].2;

    for (i, _, sort_key) in candidates.into_iter().skip(1) {
        if compare_version_sort_keys(sort_key, best_sort_key) == Ordering::Greater {
            best_sort_key = sort_key;
            best_index = *i;
        }
    }

    Ok(ReleaseSelection::Selected {
        selected_index: best_index,
    })
}

pub(crate) fn select_release_json(request_json: &str) -> Option<String> {
    let wire_req: SelectionWireRequest = serde_json::from_str(request_json).ok()?;
    if wire_req.schema_version != SCHEMA_VERSION {
        return None;
    }

    let domain_releases = wire_req
        .releases
        .into_iter()
        .map(|r| ReleaseCandidate {
            tag_name: r.tag_name,
            draft: r.draft,
            prerelease: r.prerelease,
        })
        .collect();

    let req = ReleaseSelectionRequest {
        current_version: wire_req.current_version,
        include_preview: wire_req.include_preview,
        releases: domain_releases,
    };

    let result = select_release(&req).ok()?;

    let (status, selected_index) = match result {
        ReleaseSelection::Selected { selected_index } => {
            (SelectionStatus::Selected, Some(selected_index))
        }
        ReleaseSelection::NoMatch => (SelectionStatus::NoMatch, None),
    };

    let response = SelectionResponse {
        schema_version: SCHEMA_VERSION,
        status,
        selected_index,
    };

    serde_json::to_string(&response).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(
        current: &str,
        include_preview: bool,
        releases: Vec<(&str, bool, bool)>,
    ) -> ReleaseSelectionRequest {
        let releases = releases
            .into_iter()
            .map(|(tag, draft, prerelease)| ReleaseCandidate {
                tag_name: tag.to_string(),
                draft,
                prerelease,
            })
            .collect();
        ReleaseSelectionRequest {
            current_version: current.to_string(),
            include_preview,
            releases,
        }
    }

    #[test]
    fn test_typed_api_empty_input() {
        let req = request("v0.7.0", false, vec![]);
        assert_eq!(select_release(&req).unwrap(), ReleaseSelection::NoMatch);
    }

    #[test]
    fn test_typed_api_drafts_and_invalid() {
        let req = request(
            "v0.7.0",
            false,
            vec![("v0.8.0", true, false), ("invalid", false, false)],
        );
        assert_eq!(select_release(&req).unwrap(), ReleaseSelection::NoMatch);
    }

    #[test]
    fn test_typed_api_stable_only() {
        let req = request(
            "v0.7.0",
            false,
            vec![("v0.8.0-preview.1", false, false), ("v0.8.0", false, false)],
        );
        assert_eq!(
            select_release(&req).unwrap(),
            ReleaseSelection::Selected { selected_index: 1 }
        );
    }

    #[test]
    fn test_json_adapter_valid_selected() {
        let json_str = r#"{
            "schema_version": 1,
            "current_version": "v0.7.0",
            "include_preview": false,
            "releases": [
                {"tag_name": "v0.8.0", "draft": false, "prerelease": false}
            ]
        }"#;
        let resp = select_release_json(json_str).unwrap();
        assert!(resp.contains(r#""status":"selected""#));
        assert!(resp.contains(r#""selected_index":0"#));
        assert!(resp.contains(r#""schema_version":1"#));
    }

    #[test]
    fn test_json_adapter_valid_no_match_explicit_null() {
        let json_str = r#"{
            "schema_version": 1,
            "current_version": "v0.7.0",
            "include_preview": false,
            "releases": []
        }"#;
        let resp = select_release_json(json_str).unwrap();
        assert!(resp.contains(r#""status":"no_match""#));
        assert!(resp.contains(r#""selected_index":null"#));
    }

    #[test]
    fn test_json_adapter_unsupported_schema() {
        let json_str = r#"{
            "schema_version": 2,
            "current_version": "v0.7.0",
            "include_preview": false,
            "releases": []
        }"#;
        assert!(select_release_json(json_str).is_none());
    }

    #[test]
    fn test_json_adapter_malformed_json() {
        assert!(select_release_json("not json").is_none());
    }

    #[test]
    fn test_json_adapter_missing_fields() {
        let json_str = r#"{
            "schema_version": 1,
            "current_version": "v0.7.0",
            "releases": []
        }"#;
        assert!(select_release_json(json_str).is_none());
    }

    #[test]
    fn test_json_adapter_incorrectly_typed_fields() {
        let json_str = r#"{
            "schema_version": 1,
            "current_version": "v0.7.0",
            "include_preview": "false",
            "releases": []
        }"#;
        assert!(select_release_json(json_str).is_none());
    }

    #[test]
    fn test_json_adapter_unknown_fields_rejected() {
        let json_str = r#"{
            "schema_version": 1,
            "current_version": "v0.7.0",
            "include_preview": false,
            "releases": [],
            "unknown_extra": 123
        }"#;
        assert!(select_release_json(json_str).is_none());
    }

    #[test]
    fn test_duplicate_version_first_input_tie() {
        let req = request(
            "v0.7.0",
            false,
            vec![("v0.8.0", false, false), ("v0.8.0", false, false)],
        );
        assert_eq!(
            select_release(&req).unwrap(),
            ReleaseSelection::Selected { selected_index: 0 }
        );
    }

    #[test]
    fn test_arbitrarily_large_version_field_wins_without_overflow() {
        let req = request(
            "v0.7.0",
            false,
            vec![
                ("v18446744073709551616.0.0", false, false),
                ("v1.0.0", false, false),
            ],
        );
        assert_eq!(
            select_release(&req).unwrap(),
            ReleaseSelection::Selected { selected_index: 0 }
        );
    }

    #[test]
    fn test_leading_zero_equivalent_versions_keep_first_input_tie() {
        let req = request(
            "v0.7.0",
            false,
            vec![("v0008.0.0", false, false), ("v8.0.0", false, false)],
        );
        assert_eq!(
            select_release(&req).unwrap(),
            ReleaseSelection::Selected { selected_index: 0 }
        );
    }
}
