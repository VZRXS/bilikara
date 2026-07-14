use serde::{Deserialize, Serialize};
use std::collections::HashSet;

const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PageDescriptorWire {
    original_index: usize,
    page: i64,
    cid: i64,
    duration: i64,
    part: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct MediaPageSelectionWireRequest {
    schema_version: u32,
    preferred_page: Option<i64>,
    #[serde(default = "default_tolerance")]
    tolerance_seconds: i64,
    pages: Vec<PageDescriptorWire>,
}

fn default_tolerance() -> i64 {
    3
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum WireSelectionStatus {
    Selected,
    NoMatch,
}

#[derive(Debug, Serialize)]
struct MediaPageSelectionWireResponse {
    schema_version: u32,
    status: WireSelectionStatus,
    selected_indices: Vec<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaPageDescriptor {
    pub original_index: usize,
    pub page: i64,
    pub cid: i64,
    pub duration: i64,
    pub part: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaPageSelectionRequest {
    pub preferred_page: Option<i64>,
    pub tolerance_seconds: i64,
    pub pages: Vec<MediaPageDescriptor>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum MediaPageSelection {
    Selected { selected_indices: Vec<usize> },
    NoMatch,
}

#[derive(Debug, PartialEq, Eq)]
#[allow(dead_code)]
pub enum MediaPageSelectionError {
    InvalidRequest,
}

fn duration_distance(left: i64, right: i64) -> i128 {
    (i128::from(left) - i128::from(right)).abs()
}

fn cluster_spread(cluster: &[&MediaPageDescriptor]) -> i128 {
    if cluster.is_empty() {
        return 1_000_000_000;
    }
    let mut min_dur = cluster[0].duration;
    let mut max_dur = cluster[0].duration;
    for page in cluster.iter().skip(1) {
        if page.duration < min_dur {
            min_dur = page.duration;
        }
        if page.duration > max_dur {
            max_dur = page.duration;
        }
    }
    duration_distance(max_dur, min_dur)
}

fn is_better_cluster(
    candidate: &[&MediaPageDescriptor],
    current: &[&MediaPageDescriptor],
    preferred_page: Option<i64>,
) -> bool {
    if candidate.len() != current.len() {
        return candidate.len() > current.len();
    }

    let candidate_sum: i128 = candidate.iter().map(|p| i128::from(p.duration)).sum();
    let current_sum: i128 = current.iter().map(|p| i128::from(p.duration)).sum();
    if candidate_sum != current_sum {
        return candidate_sum > current_sum;
    }

    let candidate_has_pref =
        preferred_page.is_some_and(|pref| candidate.iter().any(|p| p.page == pref));
    let current_has_pref =
        preferred_page.is_some_and(|pref| current.iter().any(|p| p.page == pref));
    if candidate_has_pref != current_has_pref {
        return candidate_has_pref;
    }

    let candidate_spread = cluster_spread(candidate);
    let current_spread = cluster_spread(current);
    if candidate_spread != current_spread {
        return candidate_spread < current_spread;
    }

    let candidate_pages: Vec<i64> = candidate.iter().map(|p| p.page).collect();
    let current_pages: Vec<i64> = current.iter().map(|p| p.page).collect();
    candidate_pages < current_pages
}

fn preferred_or_first_page(
    pages: &[MediaPageDescriptor],
    preferred_page: Option<i64>,
) -> Option<&MediaPageDescriptor> {
    if pages.is_empty() {
        return None;
    }
    if let Some(pref) = preferred_page {
        for page in pages {
            if page.page == pref {
                return Some(page);
            }
        }
    }
    Some(&pages[0])
}

pub fn select_media_pages(
    request: &MediaPageSelectionRequest,
) -> Result<MediaPageSelection, MediaPageSelectionError> {
    if request.tolerance_seconds < 0 {
        return Err(MediaPageSelectionError::InvalidRequest);
    }
    let mut original_indices = HashSet::with_capacity(request.pages.len());
    if request
        .pages
        .iter()
        .any(|page| !original_indices.insert(page.original_index))
    {
        return Err(MediaPageSelectionError::InvalidRequest);
    }

    if request.pages.is_empty() {
        return Ok(MediaPageSelection::NoMatch);
    }

    if request.pages.len() == 1 {
        return Ok(MediaPageSelection::Selected {
            selected_indices: vec![request.pages[0].original_index],
        });
    }

    let mut sorted_pages: Vec<&MediaPageDescriptor> = request.pages.iter().collect();
    sorted_pages.sort_by_key(|item| (item.duration, item.page));

    let mut best_cluster: Vec<&MediaPageDescriptor> = Vec::new();
    let mut left = 0;
    let tolerance = i128::from(request.tolerance_seconds);

    for right in 0..sorted_pages.len() {
        let current = sorted_pages[right];
        while duration_distance(current.duration, sorted_pages[left].duration) > tolerance {
            left += 1;
        }
        let candidate = &sorted_pages[left..=right];
        if is_better_cluster(candidate, &best_cluster, request.preferred_page) {
            best_cluster = candidate.to_vec();
        }
    }

    if best_cluster.len() <= 1 {
        let selected = if let Some(first_in_best) = best_cluster.first() {
            first_in_best
        } else {
            preferred_or_first_page(&request.pages, request.preferred_page).unwrap()
        };
        return Ok(MediaPageSelection::Selected {
            selected_indices: vec![selected.original_index],
        });
    }

    best_cluster.sort_by_key(|item| item.page);
    let selected_indices = best_cluster
        .iter()
        .map(|item| item.original_index)
        .collect();

    Ok(MediaPageSelection::Selected { selected_indices })
}

pub(crate) fn select_media_pages_json(request_json: &str) -> Option<String> {
    let wire_req: MediaPageSelectionWireRequest = serde_json::from_str(request_json).ok()?;
    if wire_req.schema_version != SCHEMA_VERSION || wire_req.tolerance_seconds < 0 {
        return None;
    }

    let mut last_idx: Option<usize> = None;
    for page in &wire_req.pages {
        if let Some(prev) = last_idx {
            if page.original_index <= prev {
                return None;
            }
        }
        last_idx = Some(page.original_index);
    }

    let domain_pages = wire_req
        .pages
        .into_iter()
        .map(|p| MediaPageDescriptor {
            original_index: p.original_index,
            page: p.page,
            cid: p.cid,
            duration: p.duration,
            part: p.part,
        })
        .collect();

    let req = MediaPageSelectionRequest {
        preferred_page: wire_req.preferred_page,
        tolerance_seconds: wire_req.tolerance_seconds,
        pages: domain_pages,
    };

    let result = select_media_pages(&req).ok()?;

    let (status, selected_indices) = match result {
        MediaPageSelection::Selected { selected_indices } => {
            (WireSelectionStatus::Selected, selected_indices)
        }
        MediaPageSelection::NoMatch => (WireSelectionStatus::NoMatch, vec![]),
    };

    let response = MediaPageSelectionWireResponse {
        schema_version: SCHEMA_VERSION,
        status,
        selected_indices,
    };

    serde_json::to_string(&response).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn descriptor(
        index: usize,
        page: i64,
        cid: i64,
        duration: i64,
        part: &str,
    ) -> MediaPageDescriptor {
        MediaPageDescriptor {
            original_index: index,
            page,
            cid,
            duration,
            part: part.to_string(),
        }
    }

    #[test]
    fn test_1_empty_input() {
        let req = MediaPageSelectionRequest {
            preferred_page: Some(1),
            tolerance_seconds: 3,
            pages: vec![],
        };
        assert_eq!(
            select_media_pages(&req).unwrap(),
            MediaPageSelection::NoMatch
        );
    }

    #[test]
    fn test_2_one_page() {
        let req = MediaPageSelectionRequest {
            preferred_page: Some(1),
            tolerance_seconds: 3,
            pages: vec![descriptor(0, 1, 100, 240, "P1")],
        };
        assert_eq!(
            select_media_pages(&req).unwrap(),
            MediaPageSelection::Selected {
                selected_indices: vec![0]
            }
        );
    }

    #[test]
    fn test_3_two_pages_below_tolerance() {
        let req = MediaPageSelectionRequest {
            preferred_page: Some(1),
            tolerance_seconds: 3,
            pages: vec![
                descriptor(0, 1, 100, 300, "P1"),
                descriptor(1, 2, 101, 302, "P2"),
            ],
        };
        assert_eq!(
            select_media_pages(&req).unwrap(),
            MediaPageSelection::Selected {
                selected_indices: vec![0, 1]
            }
        );
    }

    #[test]
    fn test_4_exactly_at_tolerance() {
        let req = MediaPageSelectionRequest {
            preferred_page: Some(1),
            tolerance_seconds: 3,
            pages: vec![
                descriptor(0, 1, 100, 300, "P1"),
                descriptor(1, 2, 101, 303, "P2"),
            ],
        };
        assert_eq!(
            select_media_pages(&req).unwrap(),
            MediaPageSelection::Selected {
                selected_indices: vec![0, 1]
            }
        );
    }

    #[test]
    fn test_5_above_tolerance() {
        let req = MediaPageSelectionRequest {
            preferred_page: Some(1),
            tolerance_seconds: 3,
            pages: vec![
                descriptor(0, 1, 100, 300, "P1"),
                descriptor(1, 2, 101, 304, "P2"),
            ],
        };
        assert_eq!(
            select_media_pages(&req).unwrap(),
            MediaPageSelection::Selected {
                selected_indices: vec![1]
            }
        );
    }

    #[test]
    fn test_6_larger_cluster_wins() {
        let req = MediaPageSelectionRequest {
            preferred_page: Some(1),
            tolerance_seconds: 3,
            pages: vec![
                descriptor(0, 1, 100, 100, "outlier"),
                descriptor(1, 2, 101, 300, "c1"),
                descriptor(2, 3, 102, 301, "c2"),
                descriptor(3, 4, 103, 302, "c3"),
            ],
        };
        assert_eq!(
            select_media_pages(&req).unwrap(),
            MediaPageSelection::Selected {
                selected_indices: vec![1, 2, 3]
            }
        );
    }

    #[test]
    fn test_7_higher_representative_duration_wins() {
        let req = MediaPageSelectionRequest {
            preferred_page: Some(99),
            tolerance_seconds: 3,
            pages: vec![
                descriptor(0, 1, 100, 100, "c1a"),
                descriptor(1, 2, 101, 101, "c1b"),
                descriptor(2, 3, 102, 200, "c2a"),
                descriptor(3, 4, 103, 201, "c2b"),
            ],
        };
        assert_eq!(
            select_media_pages(&req).unwrap(),
            MediaPageSelection::Selected {
                selected_indices: vec![2, 3]
            }
        );
    }

    #[test]
    fn test_8_preferred_page_wins_after_duration_tie() {
        let c_pref = [
            descriptor(0, 1, 100, 100, "A"),
            descriptor(1, 2, 101, 100, "B"),
        ];
        let c_nopref = [
            descriptor(2, 3, 102, 100, "C"),
            descriptor(3, 4, 103, 100, "D"),
        ];
        let c_pref_refs: Vec<&MediaPageDescriptor> = c_pref.iter().collect();
        let c_nopref_refs: Vec<&MediaPageDescriptor> = c_nopref.iter().collect();
        assert!(is_better_cluster(&c_pref_refs, &c_nopref_refs, Some(1)));
        assert!(!is_better_cluster(&c_nopref_refs, &c_pref_refs, Some(1)));
    }

    #[test]
    fn test_9_smaller_spread_wins() {
        let c_narrow = [
            descriptor(0, 2, 102, 100, "A"),
            descriptor(1, 3, 103, 100, "B"),
        ];
        let c_wide = [
            descriptor(2, 4, 104, 99, "C"),
            descriptor(3, 5, 105, 101, "D"),
        ];
        let c_narrow_refs: Vec<&MediaPageDescriptor> = c_narrow.iter().collect();
        let c_wide_refs: Vec<&MediaPageDescriptor> = c_wide.iter().collect();
        assert!(is_better_cluster(&c_narrow_refs, &c_wide_refs, Some(99)));
        assert!(!is_better_cluster(&c_wide_refs, &c_narrow_refs, Some(99)));
    }

    #[test]
    fn test_10_lexicographically_smaller_page_number_sequence_wins() {
        let c_lower = [
            descriptor(0, 1, 100, 100, "A"),
            descriptor(1, 2, 101, 100, "B"),
        ];
        let c_higher = [
            descriptor(2, 3, 102, 100, "C"),
            descriptor(3, 4, 103, 100, "D"),
        ];
        let c_lower_refs: Vec<&MediaPageDescriptor> = c_lower.iter().collect();
        let c_higher_refs: Vec<&MediaPageDescriptor> = c_higher.iter().collect();
        assert!(is_better_cluster(&c_lower_refs, &c_higher_refs, Some(99)));
        assert!(!is_better_cluster(&c_higher_refs, &c_lower_refs, Some(99)));
    }

    #[test]
    fn test_11_shuffled_input() {
        let req = MediaPageSelectionRequest {
            preferred_page: Some(1),
            tolerance_seconds: 3,
            pages: vec![
                descriptor(0, 3, 103, 302, "P3"),
                descriptor(1, 1, 101, 300, "P1"),
                descriptor(2, 2, 102, 301, "P2"),
            ],
        };
        assert_eq!(
            select_media_pages(&req).unwrap(),
            MediaPageSelection::Selected {
                selected_indices: vec![1, 2, 0]
            }
        );
    }

    #[test]
    fn test_12_duplicate_page_numbers_with_exact_original_index_ordering() {
        // index 0: page=1, duration=301
        // index 1: page=1, duration=300
        // Duration sorting puts index 1 (300) before index 0 (301).
        // Page sorting must stably preserve index 1 before index 0.
        let req = MediaPageSelectionRequest {
            preferred_page: Some(1),
            tolerance_seconds: 3,
            pages: vec![
                descriptor(0, 1, 101, 301, "P1_longer"),
                descriptor(1, 1, 102, 300, "P1_shorter"),
            ],
        };
        assert_eq!(
            select_media_pages(&req).unwrap(),
            MediaPageSelection::Selected {
                selected_indices: vec![1, 0]
            }
        );
    }

    #[test]
    fn test_13_duplicate_cids() {
        let req = MediaPageSelectionRequest {
            preferred_page: Some(1),
            tolerance_seconds: 3,
            pages: vec![
                descriptor(0, 1, 100, 300, "P1"),
                descriptor(1, 2, 100, 301, "P2"),
            ],
        };
        assert_eq!(
            select_media_pages(&req).unwrap(),
            MediaPageSelection::Selected {
                selected_indices: vec![0, 1]
            }
        );
    }

    #[test]
    fn test_14_identical_durations() {
        let req = MediaPageSelectionRequest {
            preferred_page: Some(1),
            tolerance_seconds: 3,
            pages: vec![
                descriptor(0, 1, 101, 300, "P1"),
                descriptor(1, 2, 102, 300, "P2"),
            ],
        };
        assert_eq!(
            select_media_pages(&req).unwrap(),
            MediaPageSelection::Selected {
                selected_indices: vec![0, 1]
            }
        );
    }

    #[test]
    fn test_15_zero_durations() {
        let req = MediaPageSelectionRequest {
            preferred_page: Some(1),
            tolerance_seconds: 3,
            pages: vec![
                descriptor(0, 1, 101, 0, "P1"),
                descriptor(1, 2, 102, 0, "P2"),
            ],
        };
        assert_eq!(
            select_media_pages(&req).unwrap(),
            MediaPageSelection::Selected {
                selected_indices: vec![0, 1]
            }
        );
    }

    #[test]
    fn test_16_preferred_page_absent() {
        let req = MediaPageSelectionRequest {
            preferred_page: Some(99),
            tolerance_seconds: 3,
            pages: vec![
                descriptor(0, 1, 101, 300, "P1"),
                descriptor(1, 2, 102, 301, "P2"),
            ],
        };
        assert_eq!(
            select_media_pages(&req).unwrap(),
            MediaPageSelection::Selected {
                selected_indices: vec![0, 1]
            }
        );
    }

    #[test]
    fn test_17_preferred_page_in_non_winning_cluster() {
        let req = MediaPageSelectionRequest {
            preferred_page: Some(1),
            tolerance_seconds: 3,
            pages: vec![
                descriptor(0, 1, 101, 50, "short_pref"),
                descriptor(1, 2, 102, 300, "c1"),
                descriptor(2, 3, 103, 301, "c2"),
            ],
        };
        assert_eq!(
            select_media_pages(&req).unwrap(),
            MediaPageSelection::Selected {
                selected_indices: vec![1, 2]
            }
        );
    }

    #[test]
    fn test_18_stable_first_input_behavior_where_python_is_stable() {
        let c_first = [
            descriptor(0, 1, 101, 100, "A"),
            descriptor(1, 2, 102, 100, "B"),
        ];
        let c_second = [
            descriptor(2, 1, 103, 100, "C"),
            descriptor(3, 2, 104, 100, "D"),
        ];
        let c_first_refs: Vec<&MediaPageDescriptor> = c_first.iter().collect();
        let c_second_refs: Vec<&MediaPageDescriptor> = c_second.iter().collect();
        assert!(!is_better_cluster(&c_second_refs, &c_first_refs, Some(99)));
    }

    #[test]
    fn test_19_valid_no_match() {
        let req = MediaPageSelectionRequest {
            preferred_page: None,
            tolerance_seconds: 3,
            pages: vec![],
        };
        assert_eq!(
            select_media_pages(&req).unwrap(),
            MediaPageSelection::NoMatch
        );
    }

    #[test]
    fn test_20_invalid_request_handling() {
        let req = MediaPageSelectionRequest {
            preferred_page: Some(1),
            tolerance_seconds: -1,
            pages: vec![descriptor(0, 1, 100, 240, "P1")],
        };
        assert_eq!(
            select_media_pages(&req),
            Err(MediaPageSelectionError::InvalidRequest)
        );

        let json_str = r#"{
            "schema_version": 1,
            "preferred_page": 1,
            "tolerance_seconds": -1,
            "pages": [
                {"original_index": 0, "page": 1, "cid": 100, "duration": 240, "part": "P1"}
            ]
        }"#;
        assert!(select_media_pages_json(json_str).is_none());
    }

    #[test]
    fn typed_api_rejects_duplicate_original_indices() {
        let req = MediaPageSelectionRequest {
            preferred_page: Some(1),
            tolerance_seconds: 3,
            pages: vec![
                descriptor(4, 1, 100, 300, "P1"),
                descriptor(4, 2, 101, 301, "P2"),
            ],
        };

        assert_eq!(
            select_media_pages(&req),
            Err(MediaPageSelectionError::InvalidRequest)
        );
    }

    #[test]
    fn typed_api_accepts_unique_non_monotonic_original_indices() {
        let req = MediaPageSelectionRequest {
            preferred_page: Some(1),
            tolerance_seconds: 3,
            pages: vec![
                descriptor(7, 1, 100, 300, "P1"),
                descriptor(2, 2, 101, 301, "P2"),
                descriptor(5, 3, 102, 302, "P3"),
            ],
        };

        assert_eq!(
            select_media_pages(&req).unwrap(),
            MediaPageSelection::Selected {
                selected_indices: vec![7, 2, 5]
            }
        );
    }

    #[test]
    fn typed_api_selected_indices_remain_unique() {
        let req = MediaPageSelectionRequest {
            preferred_page: Some(1),
            tolerance_seconds: 3,
            pages: vec![
                descriptor(9, 3, 103, 302, "P3"),
                descriptor(3, 1, 101, 300, "P1"),
                descriptor(6, 2, 102, 301, "P2"),
            ],
        };

        let MediaPageSelection::Selected { selected_indices } = select_media_pages(&req).unwrap()
        else {
            panic!("non-empty request must select at least one page");
        };
        let unique: HashSet<usize> = selected_indices.iter().copied().collect();
        assert_eq!(unique.len(), selected_indices.len());
    }

    #[test]
    fn test_overflow_i64_min_and_max_durations() {
        let req = MediaPageSelectionRequest {
            preferred_page: Some(1),
            tolerance_seconds: 3,
            pages: vec![
                descriptor(0, 1, 100, i64::MIN, "P1"),
                descriptor(1, 2, 101, i64::MAX, "P2"),
            ],
        };

        let res = select_media_pages(&req).unwrap();
        assert_eq!(
            res,
            MediaPageSelection::Selected {
                selected_indices: vec![1]
            }
        );
    }

    #[test]
    fn test_overflow_extreme_spread_calculation() {
        let p_min = descriptor(0, 1, 100, i64::MIN, "P1");
        let p_max = descriptor(1, 2, 101, i64::MAX, "P2");
        let cluster = [&p_min, &p_max];
        let spread = cluster_spread(&cluster);
        assert_eq!(spread, i128::from(i64::MAX) - i128::from(i64::MIN));
    }

    #[test]
    fn test_overflow_extreme_sliding_window_distance() {
        let req = MediaPageSelectionRequest {
            preferred_page: Some(1),
            tolerance_seconds: i64::MAX,
            pages: vec![
                descriptor(0, 1, 100, i64::MIN, "P1"),
                descriptor(1, 2, 101, i64::MAX, "P2"),
            ],
        };

        let res = select_media_pages(&req).unwrap();
        assert_eq!(
            res,
            MediaPageSelection::Selected {
                selected_indices: vec![1]
            }
        );
    }

    #[test]
    fn test_large_equal_length_cluster_sums_exceed_i64() {
        let candidate_a = descriptor(0, 1, 100, i64::MAX, "A");
        let candidate_b = descriptor(1, 2, 101, i64::MAX, "B");

        let current_a = descriptor(2, 3, 102, i64::MAX, "C");
        let current_b = descriptor(3, 4, 103, i64::MAX - 1, "D");

        let candidate = [&candidate_a, &candidate_b];
        let current = [&current_a, &current_b];

        assert!(is_better_cluster(&candidate, &current, None));
        assert!(!is_better_cluster(&current, &candidate, None));
    }
}
