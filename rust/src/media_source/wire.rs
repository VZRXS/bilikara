//! Additive wire representation kept separate from pure source identity policy.
use super::MediaSource;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

#[derive(Serialize, Deserialize)]
#[serde(tag = "provider", deny_unknown_fields)]
enum SourceWire {
    #[serde(rename = "bilibili")]
    Bilibili,
    #[serde(rename = "youtube")]
    YouTube { video_id: String },
}

impl Serialize for MediaSource {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let wire = match self {
            Self::Bilibili => SourceWire::Bilibili,
            Self::YouTube { video_id } => SourceWire::YouTube {
                video_id: video_id.clone(),
            },
        };
        wire.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for MediaSource {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(match SourceWire::deserialize(deserializer)? {
            SourceWire::Bilibili => Self::Bilibili,
            SourceWire::YouTube { video_id } => Self::YouTube { video_id },
        })
    }
}
