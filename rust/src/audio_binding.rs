use serde::{Deserialize, Serialize};
use std::collections::HashSet;

const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AudioPageWireDescriptor {
    original_index: usize,
    page: i64,
    duration: i64,
    part: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AudioBindingWireRequest {
    schema_version: u32,
    tolerance_seconds: i64,
    pages: Vec<AudioPageWireDescriptor>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum AudioBindingWireStatus {
    Decided,
    NoMatch,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum AudioBindingWireMode {
    Single,
    Automatic,
    ManualRequired,
}

#[derive(Debug, Serialize)]
struct AudioBindingWireResponse {
    schema_version: u32,
    status: AudioBindingWireStatus,
    mode: Option<AudioBindingWireMode>,
    selected_indices: Vec<usize>,
    automatic_video_index: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AudioPageDescriptor {
    pub original_index: usize,
    pub page: i64,
    pub duration: i64,
    pub part: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AudioBindingRequest {
    pub tolerance_seconds: i64,
    pub pages: Vec<AudioPageDescriptor>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioBindingMode {
    Single,
    Automatic,
    ManualRequired,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AudioBindingDecision {
    pub mode: AudioBindingMode,
    pub selected_indices: Vec<usize>,
    pub automatic_video_index: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AudioBindingResult {
    Decided(AudioBindingDecision),
    NoMatch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioBindingError {
    InvalidRequest,
}

fn part_keyword_match(part: &str) -> bool {
    let normalized = part.trim().to_lowercase();
    ["on", "off", "人声", "原唱", "伴奏"]
        .iter()
        .any(|keyword| normalized.contains(keyword))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum VocalRole {
    On,
    Off,
}

fn part_vocal_role(part: &str) -> Option<VocalRole> {
    let normalized = part.trim().to_lowercase();
    let tokens: Vec<&str> = normalized
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|token| !token.is_empty())
        .collect();
    let has_vocal = tokens.contains(&"vocal");
    let is_on = normalized.contains("人声")
        || normalized.contains("原唱")
        || tokens.contains(&"onvocal")
        || (has_vocal && tokens.contains(&"on"));
    let is_off = normalized.contains("伴奏")
        || tokens.contains(&"offvocal")
        || (has_vocal && tokens.contains(&"off"));

    match (is_on, is_off) {
        (true, false) => Some(VocalRole::On),
        (false, true) => Some(VocalRole::Off),
        _ => None,
    }
}

fn is_automatic_pair(pages: &[AudioPageDescriptor], tolerance_seconds: i64) -> bool {
    pages.len() == 2
        && pages.iter().any(|page| part_keyword_match(&page.part))
        && pages[0].duration.abs_diff(pages[1].duration) <= tolerance_seconds as u64
}

fn automatic_video_index(pages: &[AudioPageDescriptor]) -> Option<usize> {
    if pages.len() != 2 {
        return None;
    }

    match (
        part_vocal_role(&pages[0].part),
        part_vocal_role(&pages[1].part),
    ) {
        (Some(VocalRole::On), Some(VocalRole::Off)) => return Some(pages[0].original_index),
        (Some(VocalRole::Off), Some(VocalRole::On)) => return Some(pages[1].original_index),
        _ => {}
    }
    None
}

pub fn decide_audio_binding(
    request: &AudioBindingRequest,
) -> Result<AudioBindingResult, AudioBindingError> {
    if request.tolerance_seconds < 0 {
        return Err(AudioBindingError::InvalidRequest);
    }

    let mut original_indices = HashSet::with_capacity(request.pages.len());
    if request
        .pages
        .iter()
        .any(|page| !original_indices.insert(page.original_index))
    {
        return Err(AudioBindingError::InvalidRequest);
    }

    match request.pages.as_slice() {
        [] => Ok(AudioBindingResult::NoMatch),
        [page] => Ok(AudioBindingResult::Decided(AudioBindingDecision {
            mode: AudioBindingMode::Single,
            selected_indices: vec![page.original_index],
            automatic_video_index: None,
        })),
        pages if is_automatic_pair(pages, request.tolerance_seconds) => {
            Ok(AudioBindingResult::Decided(AudioBindingDecision {
                mode: AudioBindingMode::Automatic,
                selected_indices: pages.iter().map(|page| page.original_index).collect(),
                automatic_video_index: automatic_video_index(pages),
            }))
        }
        _ => Ok(AudioBindingResult::Decided(AudioBindingDecision {
            mode: AudioBindingMode::ManualRequired,
            selected_indices: vec![],
            automatic_video_index: None,
        })),
    }
}

pub(crate) fn decide_audio_binding_json(request_json: &str) -> Option<String> {
    let wire_request: AudioBindingWireRequest = serde_json::from_str(request_json).ok()?;
    if wire_request.schema_version != SCHEMA_VERSION || wire_request.tolerance_seconds < 0 {
        return None;
    }

    let mut last_index = None;
    for page in &wire_request.pages {
        if last_index.is_some_and(|previous| page.original_index <= previous) {
            return None;
        }
        last_index = Some(page.original_index);
    }

    let request = AudioBindingRequest {
        tolerance_seconds: wire_request.tolerance_seconds,
        pages: wire_request
            .pages
            .into_iter()
            .map(|page| AudioPageDescriptor {
                original_index: page.original_index,
                page: page.page,
                duration: page.duration,
                part: page.part,
            })
            .collect(),
    };

    let response = match decide_audio_binding(&request).ok()? {
        AudioBindingResult::NoMatch => AudioBindingWireResponse {
            schema_version: SCHEMA_VERSION,
            status: AudioBindingWireStatus::NoMatch,
            mode: None,
            selected_indices: vec![],
            automatic_video_index: None,
        },
        AudioBindingResult::Decided(decision) => AudioBindingWireResponse {
            schema_version: SCHEMA_VERSION,
            status: AudioBindingWireStatus::Decided,
            mode: Some(match decision.mode {
                AudioBindingMode::Single => AudioBindingWireMode::Single,
                AudioBindingMode::Automatic => AudioBindingWireMode::Automatic,
                AudioBindingMode::ManualRequired => AudioBindingWireMode::ManualRequired,
            }),
            selected_indices: decision.selected_indices,
            automatic_video_index: decision.automatic_video_index,
        },
    };

    serde_json::to_string(&response).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(index: usize, number: i64, duration: i64, part: &str) -> AudioPageDescriptor {
        AudioPageDescriptor {
            original_index: index,
            page: number,
            duration,
            part: part.to_string(),
        }
    }

    fn request(pages: Vec<AudioPageDescriptor>) -> AudioBindingRequest {
        AudioBindingRequest {
            tolerance_seconds: 3,
            pages,
        }
    }

    fn decision(
        mode: AudioBindingMode,
        selected_indices: Vec<usize>,
        automatic_video_index: Option<usize>,
    ) -> AudioBindingResult {
        AudioBindingResult::Decided(AudioBindingDecision {
            mode,
            selected_indices,
            automatic_video_index,
        })
    }

    #[test]
    fn empty_input_is_no_match() {
        assert_eq!(
            decide_audio_binding(&request(vec![])).unwrap(),
            AudioBindingResult::NoMatch
        );
    }

    #[test]
    fn one_page_is_single() {
        assert_eq!(
            decide_audio_binding(&request(vec![page(7, 4, 300, "plain")])).unwrap(),
            decision(AudioBindingMode::Single, vec![7], None)
        );
    }

    #[test]
    fn two_pages_without_keyword_require_manual_binding() {
        assert_eq!(
            decide_audio_binding(&request(vec![
                page(0, 1, 300, "main track"),
                page(1, 2, 301, "music track"),
            ]))
            .unwrap(),
            decision(AudioBindingMode::ManualRequired, vec![], None)
        );
    }

    #[test]
    fn exactly_one_keyword_is_enough_for_automatic_pairing() {
        assert_eq!(
            decide_audio_binding(&request(vec![
                page(0, 1, 300, "plain"),
                page(1, 2, 301, "伴奏版"),
            ]))
            .unwrap(),
            decision(AudioBindingMode::Automatic, vec![0, 1], None)
        );
    }

    #[test]
    fn complementary_vocal_labels_prefer_on_vocal() {
        assert_eq!(
            decide_audio_binding(&request(vec![
                page(0, 1, 300, "on vocal"),
                page(1, 2, 301, "off vocal"),
            ]))
            .unwrap(),
            decision(AudioBindingMode::Automatic, vec![0, 1], Some(0))
        );
    }

    #[test]
    fn reversed_complementary_vocal_labels_prefer_on_vocal() {
        assert_eq!(
            decide_audio_binding(&request(vec![
                page(7, 1, 300, "off_vocal"),
                page(3, 2, 301, "ON-VOCAL"),
            ]))
            .unwrap(),
            decision(AudioBindingMode::Automatic, vec![7, 3], Some(3))
        );
    }

    #[test]
    fn vocal_role_parser_requires_an_unambiguous_role() {
        for label in ["on vocal", "ON_VOCAL", "onvocal", "人声版", "原唱"] {
            assert_eq!(part_vocal_role(label), Some(VocalRole::On), "{label:?}");
        }
        for label in ["off vocal", "OFF-VOCAL", "offvocal", "伴奏版"] {
            assert_eq!(part_vocal_role(label), Some(VocalRole::Off), "{label:?}");
        }
        for label in [
            "on/off vocal",
            "人声/伴奏",
            "song vocal",
            "office vocal",
            "vocal track",
        ] {
            assert_eq!(part_vocal_role(label), None, "{label:?}");
        }
    }

    #[test]
    fn incomplete_or_same_vocal_roles_do_not_override_first_page_fallback() {
        for pages in [
            vec![page(0, 1, 300, "on vocal"), page(1, 2, 301, "music track")],
            vec![page(0, 1, 300, "on vocal"), page(1, 2, 301, "ON_VOCAL")],
        ] {
            assert_eq!(
                decide_audio_binding(&request(pages)).unwrap(),
                decision(AudioBindingMode::Automatic, vec![0, 1], None)
            );
        }
    }

    #[test]
    fn duplicate_page_numbers_still_select_the_on_vocal_entry() {
        assert_eq!(
            decide_audio_binding(&request(vec![
                page(0, 1, 300, "off vocal"),
                page(1, 1, 301, "on vocal"),
            ]))
            .unwrap(),
            decision(AudioBindingMode::Automatic, vec![0, 1], Some(1))
        );
    }

    #[test]
    fn keyword_case_whitespace_and_cjk_match_python_policy() {
        for label in [
            "ON",
            "On",
            "on",
            "OFF",
            "Off",
            "off",
            "人声",
            "原唱",
            "伴奏",
            "  ON  ",
            "\t伴奏\n",
        ] {
            assert!(part_keyword_match(label), "label should match: {label:?}");
        }
    }

    #[test]
    fn english_keywords_keep_current_substring_side_effects() {
        assert!(part_keyword_match("song"));
        assert!(part_keyword_match("office"));
        assert!(part_keyword_match("instrumental song version"));
        assert!(!part_keyword_match("vocal track"));
    }

    #[test]
    fn duration_difference_below_at_and_above_tolerance() {
        for (difference, expected_mode) in [
            (2, AudioBindingMode::Automatic),
            (3, AudioBindingMode::Automatic),
            (4, AudioBindingMode::ManualRequired),
        ] {
            let result = decide_audio_binding(&request(vec![
                page(0, 1, 300, "plain"),
                page(1, 2, 300 + difference, "off"),
            ]))
            .unwrap();
            let AudioBindingResult::Decided(value) = result else {
                panic!("two pages must produce a decision");
            };
            assert_eq!(value.mode, expected_mode);
        }
    }

    #[test]
    fn custom_tolerance_is_honored() {
        let request = AudioBindingRequest {
            tolerance_seconds: 4,
            pages: vec![page(0, 1, 300, "plain"), page(1, 2, 304, "off")],
        };
        assert_eq!(
            decide_audio_binding(&request).unwrap(),
            decision(AudioBindingMode::Automatic, vec![0, 1], None)
        );
    }

    #[test]
    fn reversed_input_preserves_selection_order_without_inferred_vocal_pair() {
        assert_eq!(
            decide_audio_binding(&request(vec![
                page(8, 2, 301, "off vocal"),
                page(3, 1, 300, "plain"),
            ]))
            .unwrap(),
            decision(AudioBindingMode::Automatic, vec![8, 3], None)
        );
    }

    #[test]
    fn p1_recognized_and_p2_unrecognized_has_no_override() {
        assert_eq!(
            decide_audio_binding(&request(vec![
                page(0, 1, 300, "on vocal"),
                page(1, 2, 301, "music track"),
            ]))
            .unwrap(),
            decision(AudioBindingMode::Automatic, vec![0, 1], None)
        );
    }

    #[test]
    fn other_or_duplicate_page_numbers_have_no_override() {
        for pages in [
            vec![page(0, 3, 300, "plain"), page(1, 4, 301, "off")],
            vec![page(0, 1, 300, "plain"), page(1, 1, 301, "off")],
        ] {
            assert_eq!(
                decide_audio_binding(&request(pages)).unwrap(),
                decision(AudioBindingMode::Automatic, vec![0, 1], None)
            );
        }
    }

    #[test]
    fn more_than_two_pages_require_manual_binding() {
        assert_eq!(
            decide_audio_binding(&request(vec![
                page(0, 1, 300, "on"),
                page(1, 2, 301, "off"),
                page(2, 3, 302, "伴奏"),
            ]))
            .unwrap(),
            decision(AudioBindingMode::ManualRequired, vec![], None)
        );
    }

    #[test]
    fn duplicate_original_indices_are_rejected() {
        assert_eq!(
            decide_audio_binding(&request(vec![
                page(4, 1, 300, "plain"),
                page(4, 2, 301, "off"),
            ])),
            Err(AudioBindingError::InvalidRequest)
        );
    }

    #[test]
    fn negative_tolerance_is_rejected() {
        let request = AudioBindingRequest {
            tolerance_seconds: -1,
            pages: vec![],
        };
        assert_eq!(
            decide_audio_binding(&request),
            Err(AudioBindingError::InvalidRequest)
        );
    }

    #[test]
    fn duration_subtraction_cannot_overflow() {
        assert_eq!(
            decide_audio_binding(&request(vec![
                page(0, 1, i64::MIN, "on"),
                page(1, 2, i64::MAX, "plain"),
            ]))
            .unwrap(),
            decision(AudioBindingMode::ManualRequired, vec![], None)
        );
    }

    #[test]
    fn unique_non_monotonic_indices_are_valid() {
        assert_eq!(
            decide_audio_binding(&request(vec![
                page(9, 1, 300, "plain"),
                page(2, 2, 301, "off"),
            ]))
            .unwrap(),
            decision(AudioBindingMode::Automatic, vec![9, 2], None)
        );
    }

    fn assert_wire_response(request: &str, expected: serde_json::Value) {
        let response = decide_audio_binding_json(request).expect("wire request should succeed");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&response).unwrap(),
            expected
        );
    }

    #[test]
    fn wire_adapter_rejects_malformed_unsupported_and_unknown_fields() {
        assert!(decide_audio_binding_json("not json").is_none());
        assert!(
            decide_audio_binding_json(r#"{"schema_version":2,"tolerance_seconds":3,"pages":[]}"#)
                .is_none()
        );
        assert!(
            decide_audio_binding_json(
                r#"{"schema_version":1,"tolerance_seconds":3,"pages":[],"extra":true}"#
            )
            .is_none()
        );
        assert!(
            decide_audio_binding_json(
                r#"{"schema_version":1,"tolerance_seconds":3,"pages":[{"original_index":0,"page":1,"duration":300,"part":"on","cid":1}]}"#
            )
            .is_none()
        );
    }

    #[test]
    fn wire_adapter_rejects_negative_tolerance_and_non_increasing_indices() {
        assert!(
            decide_audio_binding_json(r#"{"schema_version":1,"tolerance_seconds":-1,"pages":[]}"#)
                .is_none()
        );
        for pages in [
            r#"[{"original_index":0,"page":1,"duration":300,"part":"on"},{"original_index":0,"page":2,"duration":301,"part":"off"}]"#,
            r#"[{"original_index":1,"page":1,"duration":300,"part":"on"},{"original_index":0,"page":2,"duration":301,"part":"off"}]"#,
        ] {
            let request =
                format!(r#"{{"schema_version":1,"tolerance_seconds":3,"pages":{pages}}}"#);
            assert!(decide_audio_binding_json(&request).is_none());
        }
    }

    #[test]
    fn wire_adapter_returns_valid_no_match() {
        assert_wire_response(
            r#"{"schema_version":1,"tolerance_seconds":3,"pages":[]}"#,
            serde_json::json!({
                "schema_version": 1,
                "status": "no_match",
                "mode": null,
                "selected_indices": [],
                "automatic_video_index": null
            }),
        );
    }

    #[test]
    fn wire_adapter_returns_single_decision() {
        assert_wire_response(
            r#"{"schema_version":1,"tolerance_seconds":3,"pages":[{"original_index":4,"page":7,"duration":300,"part":"plain"}]}"#,
            serde_json::json!({
                "schema_version": 1,
                "status": "decided",
                "mode": "single",
                "selected_indices": [4],
                "automatic_video_index": null
            }),
        );
    }

    #[test]
    fn wire_adapter_returns_automatic_decision() {
        assert_wire_response(
            r#"{"schema_version":1,"tolerance_seconds":3,"pages":[{"original_index":4,"page":1,"duration":300,"part":"off vocal"},{"original_index":9,"page":2,"duration":301,"part":"On Vocal"}]}"#,
            serde_json::json!({
                "schema_version": 1,
                "status": "decided",
                "mode": "automatic",
                "selected_indices": [4, 9],
                "automatic_video_index": 9
            }),
        );
    }

    #[test]
    fn wire_adapter_returns_manual_required_decision() {
        assert_wire_response(
            r#"{"schema_version":1,"tolerance_seconds":3,"pages":[{"original_index":4,"page":1,"duration":300,"part":"plain"},{"original_index":9,"page":2,"duration":301,"part":"music"}]}"#,
            serde_json::json!({
                "schema_version": 1,
                "status": "decided",
                "mode": "manual_required",
                "selected_indices": [],
                "automatic_video_index": null
            }),
        );
    }
}
