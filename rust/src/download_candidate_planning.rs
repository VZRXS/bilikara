use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::url_utils::format_download_proxy_url;

const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateCandidateSource {
    Primary,
    Mirror,
    DerivedMirror,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateCandidateInput {
    pub original_index: usize,
    pub url: String,
    pub source: UpdateCandidateSource,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateDownloadProxy {
    pub template: String,
    pub proxy_first: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateDownloadPlanRequest {
    pub candidates: Vec<UpdateCandidateInput>,
    pub proxy: Option<UpdateDownloadProxy>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateCandidateRoute {
    Direct,
    Proxy,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedUpdateCandidate {
    pub input_index: usize,
    pub source: UpdateCandidateSource,
    pub route: UpdateCandidateRoute,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateDownloadPlan {
    pub candidates: Vec<PlannedUpdateCandidate>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateDownloadPlanError {
    InvalidRequest,
}

pub fn plan_update_download_candidates(
    request: &UpdateDownloadPlanRequest,
) -> Result<UpdateDownloadPlan, UpdateDownloadPlanError> {
    let mut input_indices = HashSet::with_capacity(request.candidates.len());
    if request
        .candidates
        .iter()
        .any(|candidate| !input_indices.insert(candidate.original_index))
    {
        return Err(UpdateDownloadPlanError::InvalidRequest);
    }

    let mut planned = Vec::with_capacity(request.candidates.len().saturating_mul(2));
    let mut seen_urls = HashSet::with_capacity(request.candidates.len().saturating_mul(2));

    for candidate in &request.candidates {
        let direct_url = candidate.url.trim();
        if direct_url.is_empty() {
            continue;
        }

        let mut proxy_url = request
            .proxy
            .as_ref()
            .map(|proxy| format_download_proxy_url(&proxy.template, direct_url))
            .unwrap_or_default();
        if proxy_url.trim() == direct_url {
            proxy_url.clear();
        }
        let proxy_first = request
            .proxy
            .as_ref()
            .is_some_and(|proxy| proxy.proxy_first);

        let routes = if proxy_first {
            [
                (UpdateCandidateRoute::Proxy, proxy_url.as_str()),
                (UpdateCandidateRoute::Direct, direct_url),
            ]
        } else {
            [
                (UpdateCandidateRoute::Direct, direct_url),
                (UpdateCandidateRoute::Proxy, proxy_url.as_str()),
            ]
        };

        for (route, url) in routes {
            let normalized_url = url.trim();
            if normalized_url.is_empty() || !seen_urls.insert(normalized_url.to_string()) {
                continue;
            }
            planned.push(PlannedUpdateCandidate {
                input_index: candidate.original_index,
                source: candidate.source,
                route,
                url: normalized_url.to_string(),
            });
        }
    }

    Ok(UpdateDownloadPlan {
        candidates: planned,
    })
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdateDownloadPlanWireRequest {
    schema_version: u32,
    candidates: Vec<UpdateCandidateWireInput>,
    proxy: Option<UpdateDownloadProxyWire>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdateCandidateWireInput {
    original_index: usize,
    url: String,
    source: UpdateCandidateSourceWire,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum UpdateCandidateSourceWire {
    Primary,
    Mirror,
    DerivedMirror,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdateDownloadProxyWire {
    template: String,
    proxy_first: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum UpdateDownloadPlanWireStatus {
    Planned,
    Empty,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum UpdateCandidateRouteWire {
    Direct,
    Proxy,
}

#[derive(Debug, Serialize)]
struct PlannedUpdateCandidateWire {
    input_index: usize,
    source: UpdateCandidateSourceWire,
    route: UpdateCandidateRouteWire,
    url: String,
}

#[derive(Debug, Serialize)]
struct UpdateDownloadPlanWireResponse {
    schema_version: u32,
    status: UpdateDownloadPlanWireStatus,
    candidates: Vec<PlannedUpdateCandidateWire>,
}

impl From<UpdateCandidateSourceWire> for UpdateCandidateSource {
    fn from(source: UpdateCandidateSourceWire) -> Self {
        match source {
            UpdateCandidateSourceWire::Primary => Self::Primary,
            UpdateCandidateSourceWire::Mirror => Self::Mirror,
            UpdateCandidateSourceWire::DerivedMirror => Self::DerivedMirror,
        }
    }
}

impl From<UpdateCandidateSource> for UpdateCandidateSourceWire {
    fn from(source: UpdateCandidateSource) -> Self {
        match source {
            UpdateCandidateSource::Primary => Self::Primary,
            UpdateCandidateSource::Mirror => Self::Mirror,
            UpdateCandidateSource::DerivedMirror => Self::DerivedMirror,
        }
    }
}

pub(crate) fn plan_update_download_candidates_json(request_json: &str) -> Option<String> {
    let wire_request: UpdateDownloadPlanWireRequest = serde_json::from_str(request_json).ok()?;
    if wire_request.schema_version != SCHEMA_VERSION {
        return None;
    }

    let mut previous_index = None;
    for candidate in &wire_request.candidates {
        if previous_index.is_some_and(|previous| candidate.original_index <= previous) {
            return None;
        }
        previous_index = Some(candidate.original_index);
    }

    let request = UpdateDownloadPlanRequest {
        candidates: wire_request
            .candidates
            .into_iter()
            .map(|candidate| UpdateCandidateInput {
                original_index: candidate.original_index,
                url: candidate.url,
                source: candidate.source.into(),
            })
            .collect(),
        proxy: wire_request.proxy.map(|proxy| UpdateDownloadProxy {
            template: proxy.template,
            proxy_first: proxy.proxy_first,
        }),
    };
    let plan = plan_update_download_candidates(&request).ok()?;
    let status = if plan.candidates.is_empty() {
        UpdateDownloadPlanWireStatus::Empty
    } else {
        UpdateDownloadPlanWireStatus::Planned
    };
    let response = UpdateDownloadPlanWireResponse {
        schema_version: SCHEMA_VERSION,
        status,
        candidates: plan
            .candidates
            .into_iter()
            .map(|candidate| PlannedUpdateCandidateWire {
                input_index: candidate.input_index,
                source: candidate.source.into(),
                route: match candidate.route {
                    UpdateCandidateRoute::Direct => UpdateCandidateRouteWire::Direct,
                    UpdateCandidateRoute::Proxy => UpdateCandidateRouteWire::Proxy,
                },
                url: candidate.url,
            })
            .collect(),
    };
    serde_json::to_string(&response).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn candidate(index: usize, url: &str, source: UpdateCandidateSource) -> UpdateCandidateInput {
        UpdateCandidateInput {
            original_index: index,
            url: url.to_string(),
            source,
        }
    }

    fn request(
        candidates: Vec<UpdateCandidateInput>,
        proxy: Option<(&str, bool)>,
    ) -> UpdateDownloadPlanRequest {
        UpdateDownloadPlanRequest {
            candidates,
            proxy: proxy.map(|(template, proxy_first)| UpdateDownloadProxy {
                template: template.to_string(),
                proxy_first,
            }),
        }
    }

    fn urls(plan: &UpdateDownloadPlan) -> Vec<&str> {
        plan.candidates
            .iter()
            .map(|candidate| candidate.url.as_str())
            .collect()
    }

    #[test]
    fn empty_input_is_a_valid_empty_plan() {
        let plan = plan_update_download_candidates(&request(vec![], None)).unwrap();
        assert!(plan.candidates.is_empty());
    }

    #[test]
    fn one_direct_url_preserves_identity() {
        let plan = plan_update_download_candidates(&request(
            vec![candidate(
                7,
                "https://example/app.zip",
                UpdateCandidateSource::Primary,
            )],
            None,
        ))
        .unwrap();
        assert_eq!(urls(&plan), ["https://example/app.zip"]);
        assert_eq!(plan.candidates[0].input_index, 7);
        assert_eq!(plan.candidates[0].source, UpdateCandidateSource::Primary);
        assert_eq!(plan.candidates[0].route, UpdateCandidateRoute::Direct);
    }

    #[test]
    fn trims_urls_and_removes_empty_entries() {
        let plan = plan_update_download_candidates(&request(
            vec![
                candidate(0, "  https://example/a  ", UpdateCandidateSource::Primary),
                candidate(1, " \t\n ", UpdateCandidateSource::Mirror),
            ],
            None,
        ))
        .unwrap();
        assert_eq!(urls(&plan), ["https://example/a"]);
    }

    #[test]
    fn stable_first_occurrence_deduplication_preserves_source() {
        let plan = plan_update_download_candidates(&request(
            vec![
                candidate(0, "https://example/a", UpdateCandidateSource::Primary),
                candidate(1, " https://example/a ", UpdateCandidateSource::Mirror),
                candidate(2, "https://example/b", UpdateCandidateSource::DerivedMirror),
            ],
            None,
        ))
        .unwrap();
        assert_eq!(urls(&plan), ["https://example/a", "https://example/b"]);
        assert_eq!(plan.candidates[0].input_index, 0);
        assert_eq!(plan.candidates[1].input_index, 2);
    }

    #[test]
    fn direct_first_and_proxy_first_are_explicit() {
        let direct_first = plan_update_download_candidates(&request(
            vec![candidate(
                0,
                "https://example/a",
                UpdateCandidateSource::Primary,
            )],
            Some(("https://proxy/{url}", false)),
        ))
        .unwrap();
        assert_eq!(
            urls(&direct_first),
            ["https://example/a", "https://proxy/https://example/a"]
        );

        let proxy_first = plan_update_download_candidates(&request(
            vec![candidate(
                0,
                "https://example/a",
                UpdateCandidateSource::Primary,
            )],
            Some(("https://proxy/{url}", true)),
        ))
        .unwrap();
        assert_eq!(
            urls(&proxy_first),
            ["https://proxy/https://example/a", "https://example/a"]
        );
    }

    #[test]
    fn supports_encoded_placeholder_and_suffix_separators() {
        let encoded = plan_update_download_candidates(&request(
            vec![candidate(
                0,
                "https://example/歌曲 a",
                UpdateCandidateSource::Primary,
            )],
            Some(("https://proxy/{url_encoded}", true)),
        ))
        .unwrap();
        assert_eq!(
            urls(&encoded)[0],
            "https://proxy/https%3A%2F%2Fexample%2F%E6%AD%8C%E6%9B%B2%20a"
        );

        for template in [
            "https://proxy/",
            "https://proxy=",
            "https://proxy?",
            "https://proxy&",
        ] {
            let plan = plan_update_download_candidates(&request(
                vec![candidate(
                    0,
                    "https://example/a",
                    UpdateCandidateSource::Primary,
                )],
                Some((template, true)),
            ))
            .unwrap();
            assert_eq!(urls(&plan)[0], format!("{template}https://example/a"));
        }
    }

    #[test]
    fn empty_or_equal_proxy_does_not_add_a_candidate() {
        for proxy in ["", "   ", "{url}"] {
            let plan = plan_update_download_candidates(&request(
                vec![candidate(
                    0,
                    "https://example/a",
                    UpdateCandidateSource::Primary,
                )],
                Some((proxy, true)),
            ))
            .unwrap();
            assert_eq!(urls(&plan), ["https://example/a"]);
            assert_eq!(plan.candidates[0].route, UpdateCandidateRoute::Direct);
        }
    }

    #[test]
    fn proxy_results_repeated_by_later_direct_inputs_are_deduplicated_stably() {
        let plan = plan_update_download_candidates(&request(
            vec![
                candidate(0, "https://example/a", UpdateCandidateSource::Primary),
                candidate(
                    1,
                    "https://proxy/https://example/a",
                    UpdateCandidateSource::Mirror,
                ),
            ],
            Some(("https://proxy/{url}", false)),
        ))
        .unwrap();
        assert_eq!(
            urls(&plan),
            [
                "https://example/a",
                "https://proxy/https://example/a",
                "https://proxy/https://proxy/https://example/a",
            ]
        );
        assert_eq!(plan.candidates[1].input_index, 0);
    }

    #[test]
    fn ordered_mirrors_and_cross_source_duplicates_are_stable() {
        let plan = plan_update_download_candidates(&request(
            vec![
                candidate(0, "https://primary", UpdateCandidateSource::Primary),
                candidate(1, "https://mirror-b", UpdateCandidateSource::Mirror),
                candidate(2, "https://mirror-a", UpdateCandidateSource::Mirror),
                candidate(3, "https://primary", UpdateCandidateSource::DerivedMirror),
            ],
            None,
        ))
        .unwrap();
        assert_eq!(
            urls(&plan),
            ["https://primary", "https://mirror-b", "https://mirror-a"]
        );
    }

    #[test]
    fn unicode_and_percent_encoded_urls_are_preserved() {
        let plan = plan_update_download_candidates(&request(
            vec![
                candidate(
                    0,
                    "https://例子.test/歌曲.zip",
                    UpdateCandidateSource::Primary,
                ),
                candidate(
                    1,
                    "https://example/%E6%AD%8C.zip",
                    UpdateCandidateSource::Mirror,
                ),
            ],
            None,
        ))
        .unwrap();
        assert_eq!(
            urls(&plan),
            [
                "https://例子.test/歌曲.zip",
                "https://example/%E6%AD%8C.zip"
            ]
        );
    }

    #[test]
    fn duplicate_typed_indices_are_invalid() {
        let error = plan_update_download_candidates(&request(
            vec![
                candidate(3, "https://example/a", UpdateCandidateSource::Primary),
                candidate(3, "https://example/b", UpdateCandidateSource::Mirror),
            ],
            None,
        ));
        assert_eq!(error, Err(UpdateDownloadPlanError::InvalidRequest));
    }

    #[test]
    fn planning_is_deterministic() {
        let request = request(
            vec![
                candidate(0, "https://example/a", UpdateCandidateSource::Primary),
                candidate(1, "https://example/b", UpdateCandidateSource::Mirror),
            ],
            Some(("https://proxy/{url_encoded}", true)),
        );
        let first = plan_update_download_candidates(&request).unwrap();
        for _ in 0..20 {
            assert_eq!(plan_update_download_candidates(&request).unwrap(), first);
        }
    }

    fn wire_request(candidates: Value, proxy: Value) -> String {
        json!({
            "schema_version": 1,
            "candidates": candidates,
            "proxy": proxy,
        })
        .to_string()
    }

    #[test]
    fn wire_returns_valid_empty_and_planned_responses() {
        let empty: Value = serde_json::from_str(
            &plan_update_download_candidates_json(&wire_request(json!([]), Value::Null)).unwrap(),
        )
        .unwrap();
        assert_eq!(empty["status"], "empty");
        assert_eq!(empty["candidates"], json!([]));

        let planned: Value = serde_json::from_str(
            &plan_update_download_candidates_json(&wire_request(
                json!([{"original_index": 0, "url": " https://example/a ", "source": "primary"}]),
                json!({"template": "https://proxy/{url}", "proxy_first": false}),
            ))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(planned["status"], "planned");
        assert_eq!(planned["candidates"][0]["route"], "direct");
        assert_eq!(planned["candidates"][1]["route"], "proxy");
    }

    #[test]
    fn wire_rejects_bad_schema_json_sources_indices_and_unknown_fields() {
        assert!(plan_update_download_candidates_json("not json").is_none());
        assert!(
            plan_update_download_candidates_json(
                &json!({"schema_version": 2, "candidates": [], "proxy": null}).to_string()
            )
            .is_none()
        );
        assert!(
            plan_update_download_candidates_json(&wire_request(
                json!([{"original_index": 0, "url": "x", "source": "unknown"}]),
                Value::Null,
            ))
            .is_none()
        );
        assert!(
            plan_update_download_candidates_json(&wire_request(
                json!([
                    {"original_index": 1, "url": "a", "source": "primary"},
                    {"original_index": 1, "url": "b", "source": "mirror"}
                ]),
                Value::Null,
            ))
            .is_none()
        );
        assert!(
            plan_update_download_candidates_json(
                &json!({"schema_version": 1, "candidates": [], "proxy": null, "extra": true})
                    .to_string()
            )
            .is_none()
        );
    }
}
