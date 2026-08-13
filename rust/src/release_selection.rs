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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateAction {
    NormalUpgrade,
    PreviewToStable,
    DevelopmentToStable,
    DevelopmentToPreview,
    NoAction,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateReason {
    NewerVersion,
    PreviewChannelDisabled,
    DevelopmentBuild,
    AlreadyCurrent,
    StableNotNewer,
    PreviewNotNewer,
    DevelopmentTargetNotStable,
    NoStableRelease,
    NoEligibleRelease,
}

#[derive(Debug, PartialEq, Eq)]
pub struct ReleaseDecision {
    pub selection: ReleaseSelection,
    pub action: UpdateAction,
    pub reason: UpdateReason,
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
    action: UpdateAction,
    reason: UpdateReason,
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

pub fn decide_release_update(
    request: &ReleaseSelectionRequest,
) -> Result<ReleaseDecision, ReleaseSelectionError> {
    let mut valid_releases = Vec::new();

    for (i, release) in request.releases.iter().enumerate() {
        if !release.draft {
            if let Some(sort_key) = parsed_version_sort_key(&release.tag_name) {
                valid_releases.push((i, release, sort_key));
            }
        }
    }

    if valid_releases.is_empty() {
        return Ok(ReleaseDecision {
            selection: ReleaseSelection::NoMatch,
            action: UpdateAction::NoAction,
            reason: if request.include_preview {
                UpdateReason::NoEligibleRelease
            } else {
                UpdateReason::NoStableRelease
            },
        });
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
        return Ok(ReleaseDecision {
            selection: ReleaseSelection::NoMatch,
            action: UpdateAction::NoAction,
            reason: if request.include_preview {
                UpdateReason::NoEligibleRelease
            } else {
                UpdateReason::NoStableRelease
            },
        });
    }

    let mut best_index = candidates[0].0;
    let mut best_sort_key = &candidates[0].2;

    for (i, _, sort_key) in candidates.into_iter().skip(1) {
        if compare_version_sort_keys(sort_key, best_sort_key) == Ordering::Greater {
            best_sort_key = sort_key;
            best_index = *i;
        }
    }

    let selected_key = best_sort_key;
    let selected_is_stable = selected_key[3] == "1";
    let (action, reason) = match parsed_version_sort_key(&request.current_version) {
        None if selected_is_stable => (
            UpdateAction::DevelopmentToStable,
            UpdateReason::DevelopmentBuild,
        ),
        None if request.include_preview => (
            UpdateAction::DevelopmentToPreview,
            UpdateReason::DevelopmentBuild,
        ),
        None => (
            UpdateAction::NoAction,
            UpdateReason::DevelopmentTargetNotStable,
        ),
        Some(current_key) => {
            let ordering = compare_version_sort_keys(selected_key, &current_key);
            if ordering == Ordering::Greater {
                (UpdateAction::NormalUpgrade, UpdateReason::NewerVersion)
            } else if current_key[3] == "0" && selected_is_stable && !request.include_preview {
                (
                    UpdateAction::PreviewToStable,
                    UpdateReason::PreviewChannelDisabled,
                )
            } else if ordering == Ordering::Equal {
                (UpdateAction::NoAction, UpdateReason::AlreadyCurrent)
            } else if current_key[3] == "1" {
                (UpdateAction::NoAction, UpdateReason::StableNotNewer)
            } else {
                (UpdateAction::NoAction, UpdateReason::PreviewNotNewer)
            }
        }
    };

    Ok(ReleaseDecision {
        selection: ReleaseSelection::Selected {
            selected_index: best_index,
        },
        action,
        reason,
    })
}

pub fn select_release(
    request: &ReleaseSelectionRequest,
) -> Result<ReleaseSelection, ReleaseSelectionError> {
    Ok(decide_release_update(request)?.selection)
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

    let decision = decide_release_update(&req).ok()?;

    let (status, selected_index) = match decision.selection {
        ReleaseSelection::Selected { selected_index } => {
            (SelectionStatus::Selected, Some(selected_index))
        }
        ReleaseSelection::NoMatch => (SelectionStatus::NoMatch, None),
    };

    let response = SelectionResponse {
        schema_version: SCHEMA_VERSION,
        status,
        selected_index,
        action: decision.action,
        reason: decision.reason,
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
        assert!(resp.contains(r#""action":"normal_upgrade""#));
        assert!(resp.contains(r#""reason":"newer_version""#));
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
        assert!(resp.contains(r#""action":"no_action""#));
        assert!(resp.contains(r#""reason":"no_stable_release""#));
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
    fn update_decision_matrix_distinguishes_upgrades_channel_switches_and_no_action() {
        struct Case {
            name: &'static str,
            current: &'static str,
            include_preview: bool,
            releases: Vec<(&'static str, bool, bool)>,
            selected_index: Option<usize>,
            action: UpdateAction,
            reason: UpdateReason,
        }

        let cases = vec![
            Case {
                name: "stable normal update",
                current: "v0.6.3",
                include_preview: false,
                releases: vec![("v0.6.4", false, false)],
                selected_index: Some(0),
                action: UpdateAction::NormalUpgrade,
                reason: UpdateReason::NewerVersion,
            },
            Case {
                name: "stable already current",
                current: "v0.6.4",
                include_preview: false,
                releases: vec![("v0.6.4", false, false)],
                selected_index: Some(0),
                action: UpdateAction::NoAction,
                reason: UpdateReason::AlreadyCurrent,
            },
            Case {
                name: "stable to preview when enabled",
                current: "v0.6.4",
                include_preview: true,
                releases: vec![("v0.7.0-preview.1", false, true)],
                selected_index: Some(0),
                action: UpdateAction::NormalUpgrade,
                reason: UpdateReason::NewerVersion,
            },
            Case {
                name: "preview to newer preview",
                current: "v0.7.0-preview.1",
                include_preview: true,
                releases: vec![("v0.7.0-preview.2", false, true)],
                selected_index: Some(0),
                action: UpdateAction::NormalUpgrade,
                reason: UpdateReason::NewerVersion,
            },
            Case {
                name: "preview has no newer preview",
                current: "v0.7.0-preview.3",
                include_preview: true,
                releases: vec![("v0.7.0-preview.3", false, true)],
                selected_index: Some(0),
                action: UpdateAction::NoAction,
                reason: UpdateReason::AlreadyCurrent,
            },
            Case {
                name: "preview switches to numerically lower stable",
                current: "v0.7.0-preview.3",
                include_preview: false,
                releases: vec![("v0.6.4", false, false)],
                selected_index: Some(0),
                action: UpdateAction::PreviewToStable,
                reason: UpdateReason::PreviewChannelDisabled,
            },
            Case {
                name: "preview upgrades to final stable",
                current: "v0.7.0-preview.3",
                include_preview: false,
                releases: vec![("v0.7.0", false, false)],
                selected_index: Some(0),
                action: UpdateAction::NormalUpgrade,
                reason: UpdateReason::NewerVersion,
            },
            Case {
                name: "development build switches to stable",
                current: "v0.7.0-12-gabcdef",
                include_preview: false,
                releases: vec![("v0.6.4", false, false)],
                selected_index: Some(0),
                action: UpdateAction::DevelopmentToStable,
                reason: UpdateReason::DevelopmentBuild,
            },
            Case {
                name: "development build switches to preview when preview enabled",
                current: "v0.7.0-preview.3-12-gabcdef",
                include_preview: true,
                releases: vec![("v0.7.0-preview.3", false, true)],
                selected_index: Some(0),
                action: UpdateAction::DevelopmentToPreview,
                reason: UpdateReason::DevelopmentBuild,
            },
            Case {
                name: "stable does not downgrade",
                current: "v0.7.0",
                include_preview: false,
                releases: vec![("v0.6.4", false, false)],
                selected_index: Some(0),
                action: UpdateAction::NoAction,
                reason: UpdateReason::StableNotNewer,
            },
            Case {
                name: "draft and malformed releases are ignored",
                current: "v0.7.0",
                include_preview: false,
                releases: vec![("v0.8.0", true, false), ("broken", false, false)],
                selected_index: None,
                action: UpdateAction::NoAction,
                reason: UpdateReason::NoStableRelease,
            },
            Case {
                name: "no stable is available",
                current: "v0.7.0-preview.3",
                include_preview: false,
                releases: vec![("v0.8.0-preview.1", false, true)],
                selected_index: None,
                action: UpdateAction::NoAction,
                reason: UpdateReason::NoStableRelease,
            },
        ];

        for case in cases {
            let decision =
                decide_release_update(&request(case.current, case.include_preview, case.releases))
                    .unwrap();
            assert_eq!(decision.action, case.action, "{} action", case.name);
            assert_eq!(decision.reason, case.reason, "{} reason", case.name);
            assert_eq!(
                decision.selection,
                case.selected_index
                    .map(|selected_index| ReleaseSelection::Selected { selected_index })
                    .unwrap_or(ReleaseSelection::NoMatch),
                "{} selection",
                case.name
            );
        }
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
