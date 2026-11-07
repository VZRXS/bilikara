//! Shared measured facts; decoder choice does not change volume semantics.
use serde::{Deserialize, Serialize};

pub const ALGORITHM: &str = "ebur128-0.1.10-i-histogram-pcm-v1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct LoudnessMeasurement {
    pub algorithm: String,
    pub integrated_lufs: f64,
    pub duration_seconds: f64,
    pub elapsed_seconds: f64,
    pub sample_rate: u32,
    pub channels: u32,
    pub codec: String,
}

impl LoudnessMeasurement {
    pub fn valid(&self) -> bool {
        self.algorithm == ALGORITHM
            && bilikara_rust::automatic_volume::valid_loudness(self.integrated_lufs)
            && self.duration_seconds.is_finite()
            && (0.4..=21600.0).contains(&self.duration_seconds)
            && self.elapsed_seconds.is_finite()
            && self.elapsed_seconds >= 0.0
            && (8000..=192000).contains(&self.sample_rate)
            && (1..=2).contains(&self.channels)
            && !self.codec.is_empty()
            && self.codec.len() <= 128
    }
}
