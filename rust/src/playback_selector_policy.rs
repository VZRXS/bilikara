use serde::{Deserialize, Serialize};
use serde_json::Value;

const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PlaybackSelectorMode {
    Python,
    Rust,
}

impl PlaybackSelectorMode {
    fn from_value(value: &Value) -> Option<Self> {
        match value.as_str() {
            Some("python") => Some(Self::Python),
            Some("rust") => Some(Self::Rust),
            _ => None,
        }
    }
}

pub const DEFAULT_PLAYBACK_SELECTOR_MODE: PlaybackSelectorMode = PlaybackSelectorMode::Rust;
pub const VALID_PLAYBACK_SELECTOR_MODES: [PlaybackSelectorMode; 2] =
    [PlaybackSelectorMode::Python, PlaybackSelectorMode::Rust];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PlaybackSelectorStatus {
    Accepted,
    Normalized,
    Rejected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PlaybackSelectorReason {
    Default,
    ExplicitPython,
    ExplicitRust,
    InvalidPersisted,
    InvalidRequested,
    RustUnavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PlaybackSelectorDecision {
    pub status: PlaybackSelectorStatus,
    pub effective_mode: Option<PlaybackSelectorMode>,
    pub reason: PlaybackSelectorReason,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PersistedPlaybackSelectorMode {
    Unset,
    Explicit(PlaybackSelectorMode),
    Invalid,
}

pub fn validate_requested_playback_selector_mode(
    requested: Option<PlaybackSelectorMode>,
    rust_available: bool,
) -> PlaybackSelectorDecision {
    match requested {
        Some(PlaybackSelectorMode::Python) => PlaybackSelectorDecision {
            status: PlaybackSelectorStatus::Accepted,
            effective_mode: Some(PlaybackSelectorMode::Python),
            reason: PlaybackSelectorReason::ExplicitPython,
        },
        Some(PlaybackSelectorMode::Rust) if rust_available => PlaybackSelectorDecision {
            status: PlaybackSelectorStatus::Accepted,
            effective_mode: Some(PlaybackSelectorMode::Rust),
            reason: PlaybackSelectorReason::ExplicitRust,
        },
        Some(PlaybackSelectorMode::Rust) => PlaybackSelectorDecision {
            status: PlaybackSelectorStatus::Rejected,
            effective_mode: None,
            reason: PlaybackSelectorReason::RustUnavailable,
        },
        None => PlaybackSelectorDecision {
            status: PlaybackSelectorStatus::Rejected,
            effective_mode: None,
            reason: PlaybackSelectorReason::InvalidRequested,
        },
    }
}

pub fn decide_persisted_playback_selector_mode(
    persisted: PersistedPlaybackSelectorMode,
    rust_available: bool,
) -> PlaybackSelectorDecision {
    match persisted {
        PersistedPlaybackSelectorMode::Explicit(PlaybackSelectorMode::Python) => {
            PlaybackSelectorDecision {
                status: PlaybackSelectorStatus::Accepted,
                effective_mode: Some(PlaybackSelectorMode::Python),
                reason: PlaybackSelectorReason::ExplicitPython,
            }
        }
        PersistedPlaybackSelectorMode::Explicit(PlaybackSelectorMode::Rust) if rust_available => {
            PlaybackSelectorDecision {
                status: PlaybackSelectorStatus::Accepted,
                effective_mode: Some(PlaybackSelectorMode::Rust),
                reason: PlaybackSelectorReason::ExplicitRust,
            }
        }
        PersistedPlaybackSelectorMode::Explicit(PlaybackSelectorMode::Rust) => {
            PlaybackSelectorDecision {
                status: PlaybackSelectorStatus::Normalized,
                effective_mode: Some(PlaybackSelectorMode::Python),
                reason: PlaybackSelectorReason::RustUnavailable,
            }
        }
        PersistedPlaybackSelectorMode::Unset => PlaybackSelectorDecision {
            status: if rust_available {
                PlaybackSelectorStatus::Accepted
            } else {
                PlaybackSelectorStatus::Normalized
            },
            effective_mode: Some(if rust_available {
                DEFAULT_PLAYBACK_SELECTOR_MODE
            } else {
                PlaybackSelectorMode::Python
            }),
            reason: if rust_available {
                PlaybackSelectorReason::Default
            } else {
                PlaybackSelectorReason::RustUnavailable
            },
        },
        PersistedPlaybackSelectorMode::Invalid => PlaybackSelectorDecision {
            status: PlaybackSelectorStatus::Normalized,
            effective_mode: Some(if rust_available {
                DEFAULT_PLAYBACK_SELECTOR_MODE
            } else {
                PlaybackSelectorMode::Python
            }),
            reason: PlaybackSelectorReason::InvalidPersisted,
        },
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
enum WireRequest {
    ValidateRequested {
        schema_version: u32,
        rust_available: bool,
        mode: Value,
    },
    ResolvePersisted {
        schema_version: u32,
        rust_available: bool,
        is_set: bool,
        mode: Value,
    },
}

#[derive(Debug, Serialize)]
struct WireResponse {
    schema_version: u32,
    status: PlaybackSelectorStatus,
    effective_mode: Option<PlaybackSelectorMode>,
    reason: PlaybackSelectorReason,
}

pub(crate) fn decide_playback_selector_policy_json(request_json: &str) -> Option<String> {
    let request: WireRequest = serde_json::from_str(request_json).ok()?;
    let decision = match request {
        WireRequest::ValidateRequested {
            schema_version,
            rust_available,
            mode,
        } => {
            if schema_version != SCHEMA_VERSION {
                return None;
            }
            validate_requested_playback_selector_mode(
                PlaybackSelectorMode::from_value(&mode),
                rust_available,
            )
        }
        WireRequest::ResolvePersisted {
            schema_version,
            rust_available,
            is_set,
            mode,
        } => {
            if schema_version != SCHEMA_VERSION {
                return None;
            }
            let persisted = if !is_set {
                PersistedPlaybackSelectorMode::Unset
            } else if let Some(mode) = PlaybackSelectorMode::from_value(&mode) {
                PersistedPlaybackSelectorMode::Explicit(mode)
            } else {
                PersistedPlaybackSelectorMode::Invalid
            };
            decide_persisted_playback_selector_mode(persisted, rust_available)
        }
    };
    serde_json::to_string(&WireResponse {
        schema_version: SCHEMA_VERSION,
        status: decision.status,
        effective_mode: decision.effective_mode,
        reason: decision.reason,
    })
    .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_modes_and_default_are_stable() {
        assert_eq!(
            VALID_PLAYBACK_SELECTOR_MODES,
            [PlaybackSelectorMode::Python, PlaybackSelectorMode::Rust]
        );
        assert_eq!(DEFAULT_PLAYBACK_SELECTOR_MODE, PlaybackSelectorMode::Rust);
    }

    #[test]
    fn requested_modes_are_validated_without_fallback() {
        let python =
            validate_requested_playback_selector_mode(Some(PlaybackSelectorMode::Python), false);
        assert_eq!(python.status, PlaybackSelectorStatus::Accepted);
        assert_eq!(python.effective_mode, Some(PlaybackSelectorMode::Python));

        let rust =
            validate_requested_playback_selector_mode(Some(PlaybackSelectorMode::Rust), true);
        assert_eq!(rust.status, PlaybackSelectorStatus::Accepted);
        assert_eq!(rust.effective_mode, Some(PlaybackSelectorMode::Rust));

        let unavailable =
            validate_requested_playback_selector_mode(Some(PlaybackSelectorMode::Rust), false);
        assert_eq!(unavailable.status, PlaybackSelectorStatus::Rejected);
        assert_eq!(unavailable.effective_mode, None);
        assert_eq!(unavailable.reason, PlaybackSelectorReason::RustUnavailable);

        let invalid = validate_requested_playback_selector_mode(None, true);
        assert_eq!(invalid.status, PlaybackSelectorStatus::Rejected);
        assert_eq!(invalid.reason, PlaybackSelectorReason::InvalidRequested);
    }

    #[test]
    fn persisted_mode_matrix_preserves_preview_behavior() {
        let cases = [
            (
                PersistedPlaybackSelectorMode::Unset,
                true,
                PlaybackSelectorMode::Rust,
                PlaybackSelectorReason::Default,
            ),
            (
                PersistedPlaybackSelectorMode::Explicit(PlaybackSelectorMode::Rust),
                true,
                PlaybackSelectorMode::Rust,
                PlaybackSelectorReason::ExplicitRust,
            ),
            (
                PersistedPlaybackSelectorMode::Explicit(PlaybackSelectorMode::Python),
                true,
                PlaybackSelectorMode::Python,
                PlaybackSelectorReason::ExplicitPython,
            ),
            (
                PersistedPlaybackSelectorMode::Explicit(PlaybackSelectorMode::Python),
                false,
                PlaybackSelectorMode::Python,
                PlaybackSelectorReason::ExplicitPython,
            ),
            (
                PersistedPlaybackSelectorMode::Invalid,
                true,
                PlaybackSelectorMode::Rust,
                PlaybackSelectorReason::InvalidPersisted,
            ),
            (
                PersistedPlaybackSelectorMode::Invalid,
                false,
                PlaybackSelectorMode::Python,
                PlaybackSelectorReason::InvalidPersisted,
            ),
            (
                PersistedPlaybackSelectorMode::Explicit(PlaybackSelectorMode::Rust),
                false,
                PlaybackSelectorMode::Python,
                PlaybackSelectorReason::RustUnavailable,
            ),
        ];
        for (persisted, available, expected_mode, expected_reason) in cases {
            let decision = decide_persisted_playback_selector_mode(persisted, available);
            assert_eq!(decision.effective_mode, Some(expected_mode));
            assert_eq!(decision.reason, expected_reason);
        }
    }

    #[test]
    fn wire_adapter_rejects_unknown_fields_and_preserves_invalid_values() {
        assert!(decide_playback_selector_policy_json(
            r#"{"schema_version":1,"operation":"resolve_persisted","rust_available":true,"is_set":true,"mode":"hybrid"}"#
        )
        .is_some());
        assert!(decide_playback_selector_policy_json(
            r#"{"schema_version":1,"operation":"resolve_persisted","rust_available":true,"is_set":true,"mode":"rust","extra":1}"#
        )
        .is_none());
    }
}
