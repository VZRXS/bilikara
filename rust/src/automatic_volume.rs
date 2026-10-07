//! Host-calibrated integrated loudness policy. Percent is linear amplitude;
//! manual boost remains a separate existing player policy.

pub fn valid_loudness(lufs: f64) -> bool {
    lufs.is_finite() && (-70.0..=24.0).contains(&lufs)
}

pub fn reference_target(lufs: f64, percent: i32) -> Option<f64> {
    if !valid_loudness(lufs) || !(1..=100).contains(&percent) {
        return None;
    }
    Some(lufs + 20.0 * (f64::from(percent) / 100.0).log10())
}

pub fn automatic_percent(target: f64, lufs: f64) -> Option<i32> {
    if !target.is_finite() || !(-110.0..=24.0).contains(&target) || !valid_loudness(lufs) {
        return None;
    }
    let percent = 100.0 * 10.0_f64.powf((target - lufs) / 20.0);
    // The existing control uses integer percentages. A positive automatic
    // result must not become an explicit manual zero or mute by quantization.
    Some(percent.round().clamp(1.0, 100.0) as i32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_reference_absolute_outputs_and_precision() {
        let target = reference_target(-12.0, 50).unwrap();
        assert!((target - -18.020_599_913_279_625).abs() < 1e-10);
        assert_eq!(automatic_percent(target, -12.0), Some(50));
        assert_eq!(automatic_percent(target, -8.0), Some(32));
        assert_eq!(automatic_percent(target, -16.0), Some(79));
        assert_eq!(automatic_percent(target, -24.0), Some(100));
        assert_eq!(automatic_percent(-100.0, 0.0), Some(1));
        assert!((reference_target(-12.0, 75).unwrap() + 14.498_774_732_165_998).abs() < 1e-10);
    }

    #[test]
    fn unavailable_and_invalid_are_not_zero_volume() {
        for lufs in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -71.0, 25.0] {
            assert_eq!(reference_target(lufs, 50), None);
            assert_eq!(automatic_percent(-18.0, lufs), None);
        }
        for percent in [-1, 0, 101, 500] {
            assert_eq!(reference_target(-12.0, percent), None);
        }
        assert_eq!(automatic_percent(f64::NAN, -12.0), None);
    }
}
