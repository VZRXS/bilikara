use std::collections::HashSet;

use serde::{Deserialize, Serialize};

const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PreferredRegularAudioCandidate {
    pub original_index: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreferredAudioSourceRequest {
    pub audio_hires: bool,
    pub regular_candidates: Vec<PreferredRegularAudioCandidate>,
    pub flac_available: bool,
    pub dolby_available: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreferredAudioSource {
    Regular,
    Flac,
    Dolby,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PreferredAudioSourceSelection {
    Selected {
        preferred_source: PreferredAudioSource,
        selected_regular_index: Option<usize>,
    },
    NoMatch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreferredAudioSourceError {
    InvalidRequest,
}

pub fn select_preferred_audio_source(
    request: &PreferredAudioSourceRequest,
) -> Result<PreferredAudioSourceSelection, PreferredAudioSourceError> {
    let mut indices = HashSet::with_capacity(request.regular_candidates.len());
    if request
        .regular_candidates
        .iter()
        .any(|candidate| !indices.insert(candidate.original_index))
    {
        return Err(PreferredAudioSourceError::InvalidRequest);
    }

    let selected_regular_index = request
        .regular_candidates
        .first()
        .map(|candidate| candidate.original_index);
    let preferred_source = if request.audio_hires && request.dolby_available {
        Some(PreferredAudioSource::Dolby)
    } else if request.audio_hires && request.flac_available {
        Some(PreferredAudioSource::Flac)
    } else if selected_regular_index.is_some() {
        Some(PreferredAudioSource::Regular)
    } else {
        None
    };

    Ok(match preferred_source {
        Some(preferred_source) => PreferredAudioSourceSelection::Selected {
            preferred_source,
            selected_regular_index,
        },
        None => PreferredAudioSourceSelection::NoMatch,
    })
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PreferredRegularAudioWireCandidate {
    original_index: usize,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PreferredAudioSourceWireRequest {
    schema_version: u32,
    audio_hires: bool,
    regular_candidates: Vec<PreferredRegularAudioWireCandidate>,
    flac_available: bool,
    dolby_available: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum WireStatus {
    Selected,
    NoMatch,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum WirePreferredSource {
    Regular,
    Flac,
    Dolby,
}

#[derive(Debug, Serialize)]
struct PreferredAudioSourceWireResponse {
    schema_version: u32,
    status: WireStatus,
    preferred_source: Option<WirePreferredSource>,
    selected_regular_index: Option<usize>,
}

pub(crate) fn select_preferred_audio_source_json(request_json: &str) -> Option<String> {
    let wire: PreferredAudioSourceWireRequest = serde_json::from_str(request_json).ok()?;
    if wire.schema_version != SCHEMA_VERSION
        || wire
            .regular_candidates
            .windows(2)
            .any(|pair| pair[0].original_index >= pair[1].original_index)
    {
        return None;
    }
    let request = PreferredAudioSourceRequest {
        audio_hires: wire.audio_hires,
        regular_candidates: wire
            .regular_candidates
            .into_iter()
            .map(|candidate| PreferredRegularAudioCandidate {
                original_index: candidate.original_index,
            })
            .collect(),
        flac_available: wire.flac_available,
        dolby_available: wire.dolby_available,
    };
    let response = match select_preferred_audio_source(&request).ok()? {
        PreferredAudioSourceSelection::NoMatch => PreferredAudioSourceWireResponse {
            schema_version: SCHEMA_VERSION,
            status: WireStatus::NoMatch,
            preferred_source: None,
            selected_regular_index: None,
        },
        PreferredAudioSourceSelection::Selected {
            preferred_source,
            selected_regular_index,
        } => PreferredAudioSourceWireResponse {
            schema_version: SCHEMA_VERSION,
            status: WireStatus::Selected,
            preferred_source: Some(match preferred_source {
                PreferredAudioSource::Regular => WirePreferredSource::Regular,
                PreferredAudioSource::Flac => WirePreferredSource::Flac,
                PreferredAudioSource::Dolby => WirePreferredSource::Dolby,
            }),
            selected_regular_index,
        },
    };
    serde_json::to_string(&response).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(index: usize) -> PreferredRegularAudioCandidate {
        PreferredRegularAudioCandidate {
            original_index: index,
        }
    }

    fn request(
        indices: &[usize],
        audio_hires: bool,
        flac_available: bool,
        dolby_available: bool,
    ) -> PreferredAudioSourceRequest {
        PreferredAudioSourceRequest {
            audio_hires,
            regular_candidates: indices.iter().copied().map(candidate).collect(),
            flac_available,
            dolby_available,
        }
    }

    #[test]
    fn regular_first_nonzero_index_is_preserved_without_ranking() {
        let selection =
            select_preferred_audio_source(&request(&[7, 2], false, false, false)).unwrap();
        assert_eq!(
            selection,
            PreferredAudioSourceSelection::Selected {
                preferred_source: PreferredAudioSource::Regular,
                selected_regular_index: Some(7),
            }
        );
    }

    #[test]
    fn dolby_overrides_flac_and_regular_when_hires_is_enabled() {
        assert_eq!(
            select_preferred_audio_source(&request(&[4], true, true, true)).unwrap(),
            PreferredAudioSourceSelection::Selected {
                preferred_source: PreferredAudioSource::Dolby,
                selected_regular_index: Some(4),
            }
        );
        assert_eq!(
            select_preferred_audio_source(&request(&[4], true, true, false)).unwrap(),
            PreferredAudioSourceSelection::Selected {
                preferred_source: PreferredAudioSource::Flac,
                selected_regular_index: Some(4),
            }
        );
    }

    #[test]
    fn hires_disabled_ignores_separate_sources() {
        assert_eq!(
            select_preferred_audio_source(&request(&[3, 1], false, true, true)).unwrap(),
            PreferredAudioSourceSelection::Selected {
                preferred_source: PreferredAudioSource::Regular,
                selected_regular_index: Some(3),
            }
        );
        assert_eq!(
            select_preferred_audio_source(&request(&[], false, true, true)).unwrap(),
            PreferredAudioSourceSelection::NoMatch
        );
    }

    #[test]
    fn hires_sources_work_without_regular_and_empty_input_is_no_match() {
        assert_eq!(
            select_preferred_audio_source(&request(&[], true, true, false)).unwrap(),
            PreferredAudioSourceSelection::Selected {
                preferred_source: PreferredAudioSource::Flac,
                selected_regular_index: None,
            }
        );
        assert_eq!(
            select_preferred_audio_source(&request(&[], true, false, true)).unwrap(),
            PreferredAudioSourceSelection::Selected {
                preferred_source: PreferredAudioSource::Dolby,
                selected_regular_index: None,
            }
        );
        assert_eq!(
            select_preferred_audio_source(&request(&[], true, false, false)).unwrap(),
            PreferredAudioSourceSelection::NoMatch
        );
    }

    #[test]
    fn duplicate_indices_are_invalid_but_unique_nonmonotonic_typed_input_is_valid() {
        assert_eq!(
            select_preferred_audio_source(&request(&[2, 2], true, false, false)),
            Err(PreferredAudioSourceError::InvalidRequest)
        );
        assert!(select_preferred_audio_source(&request(&[9, 1], true, false, false)).is_ok());
    }

    #[test]
    fn repeated_execution_is_deterministic() {
        let request = request(&[5, 2], true, true, true);
        assert_eq!(
            select_preferred_audio_source(&request),
            select_preferred_audio_source(&request)
        );
    }

    #[test]
    fn wire_rejects_malformed_schema_duplicate_indices_and_unknown_fields() {
        assert!(select_preferred_audio_source_json("not json").is_none());
        assert!(select_preferred_audio_source_json(r#"{"schema_version":2,"audio_hires":true,"regular_candidates":[],"flac_available":false,"dolby_available":false}"#).is_none());
        assert!(select_preferred_audio_source_json(r#"{"schema_version":1,"audio_hires":true,"regular_candidates":[{"original_index":0},{"original_index":0}],"flac_available":false,"dolby_available":false}"#).is_none());
        assert!(select_preferred_audio_source_json(r#"{"schema_version":1,"audio_hires":true,"regular_candidates":[],"flac_available":false,"dolby_available":false,"extra":true}"#).is_none());
    }
}
