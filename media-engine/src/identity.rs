//! Immutable program identity issued by Rust AppState.
//!
//! The engine never derives or advances this identity. Every command and every
//! observation carries the complete value so that the Host can fence stale work
//! exactly as it does for the Legacy WebView adapter.
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProgramIdentity {
    pub playback_generation: u64,
    pub item_id: String,
    pub item_incarnation_id: String,
    pub selected_audio_variant_id: String,
    pub artifact_set_id: Option<String>,
}

const MAX_FIELD: usize = 256;

fn bounded(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_FIELD && !value.chars().any(char::is_control)
}

impl ProgramIdentity {
    /// Shape check matching `BilikaraMediaBackend.identity` in the frontend.
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.playback_generation == 0 || self.playback_generation > (1u64 << 53) {
            return Err("invalid-playback-generation");
        }
        if !bounded(&self.item_id) || !bounded(&self.item_incarnation_id) {
            return Err("invalid-item-identity");
        }
        if self.selected_audio_variant_id.len() > MAX_FIELD
            || self.selected_audio_variant_id.chars().any(char::is_control)
        {
            return Err("invalid-audio-variant");
        }
        if let Some(artifact) = &self.artifact_set_id {
            if !bounded(artifact) {
                return Err("invalid-artifact-set");
            }
        }
        Ok(())
    }

    /// Media can only execute for a program bound to an exact artifact set.
    pub fn validate_mountable(&self) -> Result<(), &'static str> {
        self.validate()?;
        if self.artifact_set_id.is_none() {
            return Err("program-not-mountable");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) fn sample(generation: u64) -> ProgramIdentity {
        ProgramIdentity {
            playback_generation: generation,
            item_id: "item-a".into(),
            item_incarnation_id: "inc-a".into(),
            selected_audio_variant_id: "p1".into(),
            artifact_set_id: Some("set-a".into()),
        }
    }

    #[test]
    fn rejects_incomplete_or_unbounded_identities() {
        assert!(sample(1).validate_mountable().is_ok());
        assert_eq!(sample(0).validate(), Err("invalid-playback-generation"));
        let mut value = sample(1);
        value.item_id.clear();
        assert_eq!(value.validate(), Err("invalid-item-identity"));
        let mut value = sample(1);
        value.artifact_set_id = None;
        assert!(value.validate().is_ok());
        assert_eq!(value.validate_mountable(), Err("program-not-mountable"));
        let mut value = sample(1);
        value.item_incarnation_id = "x".repeat(MAX_FIELD + 1);
        assert_eq!(value.validate(), Err("invalid-item-identity"));
        let mut value = sample(1);
        value.selected_audio_variant_id = "a\nb".into();
        assert_eq!(value.validate(), Err("invalid-audio-variant"));
    }

    #[test]
    fn deserialization_rejects_unknown_fields() {
        let error = serde_json::from_str::<ProgramIdentity>(
            r#"{"playback_generation":1,"item_id":"a","item_incarnation_id":"b","selected_audio_variant_id":"c","artifact_set_id":"d","extra":1}"#,
        );
        assert!(error.is_err());
    }
}
