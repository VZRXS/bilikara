//! Closed, numeric-only audience geometry diagnostics. These are WebView/OS
//! measurements, not media identities or authoritative playback state.
use serde::{Deserialize, Serialize};

const MAX_DIMENSION: f64 = 1_000_000.0;
const MAX_SAFE_JS_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct VideoGeometry {
    video_sequence: u64,
    video_width: u32,
    video_height: u32,
    video_bounds: Bounds,
    frame_bounds: Bounds,
    viewport_width: f64,
    viewport_height: f64,
    window_width: f64,
    window_height: f64,
    device_pixel_ratio: f64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Bounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

fn dimension(value: f64) -> bool {
    value.is_finite() && (0.0..=MAX_DIMENSION).contains(&value)
}

impl Bounds {
    fn valid(&self) -> bool {
        [self.x, self.y]
            .iter()
            .all(|value| value.is_finite() && value.abs() <= MAX_DIMENSION)
            && dimension(self.width)
            && dimension(self.height)
    }
}

impl VideoGeometry {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.video_sequence == 0
            || self.video_sequence > MAX_SAFE_JS_INTEGER
            || ![
                f64::from(self.video_width),
                f64::from(self.video_height),
                self.viewport_width,
                self.viewport_height,
                self.window_width,
                self.window_height,
            ]
            .into_iter()
            .all(dimension)
            || !self.video_bounds.valid()
            || !self.frame_bounds.valid()
            || !self.device_pixel_ratio.is_finite()
            || !(0.1..=16.0).contains(&self.device_pixel_ratio)
        {
            return Err("invalid presentation video geometry".to_string());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn payload() -> serde_json::Value {
        json!({
            "videoSequence": 1, "videoWidth": 1080, "videoHeight": 1920,
            "videoBounds": { "x": 0.0, "y": -250.0, "width": 1280.0, "height": 2276.0 },
            "frameBounds": { "x": 0.0, "y": 0.0, "width": 1280.0, "height": 720.0 },
            "viewportWidth": 1280.0, "viewportHeight": 720.0,
            "windowWidth": 1280.0, "windowHeight": 720.0, "devicePixelRatio": 1.5,
        })
    }

    #[test]
    fn records_overflow_without_clamping_evidence() {
        let geometry: VideoGeometry = serde_json::from_value(payload()).unwrap();
        geometry.validate().unwrap();
        let record = serde_json::to_value(geometry).unwrap();
        assert_eq!(record, payload());
        assert_eq!(record["videoBounds"]["height"], json!(2276.0));
        assert_eq!(record["videoBounds"]["y"], json!(-250.0));
    }

    #[test]
    fn allows_pending_metadata_but_rejects_invalid_numeric_facts() {
        let mut geometry: VideoGeometry = serde_json::from_value(payload()).unwrap();
        geometry.video_width = 0;
        geometry.video_height = 0;
        geometry.validate().unwrap();
        for invalid in [-1.0, f64::NAN, f64::INFINITY, MAX_DIMENSION + 1.0] {
            geometry.video_bounds.height = invalid;
            assert!(geometry.validate().is_err());
        }
        geometry.video_bounds.height = 720.0;
        geometry.video_sequence = MAX_SAFE_JS_INTEGER + 1;
        assert!(geometry.validate().is_err());
        geometry.video_sequence = 1;
        geometry.device_pixel_ratio = 0.0;
        assert!(geometry.validate().is_err());
    }

    #[test]
    fn rejects_urls_text_and_unknown_nested_fields() {
        for key in ["url", "title", "reason"] {
            let mut value = payload();
            value[key] = json!("must not enter the log");
            assert!(serde_json::from_value::<VideoGeometry>(value).is_err());
        }
        let mut value = payload();
        value["videoBounds"]["src"] = json!("secret");
        assert!(serde_json::from_value::<VideoGeometry>(value).is_err());
        assert!(serde_json::from_value::<VideoGeometry>(json!({})).is_err());
    }
}
