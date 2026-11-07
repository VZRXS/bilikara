//! Canonical output sample-clock policy. No I/O, clocks, serde or mutable state.
use std::f64::consts::FRAC_PI_2;

pub const RATE: i64 = 48_000;
pub const SPLICE_FRAMES: i64 = 1_920;
pub const TRACK_FADE_FRAMES: i64 = 3_840;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum OffsetMode {
    #[default]
    Splice,
    Gradual,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Transition {
    pub at: i64,
    pub from: f64,
    pub to: f64,
    pub duration: i64,
}
impl Transition {
    pub fn new(at: i64, from: f64, target_ms: i32, mode: OffsetMode) -> Self {
        let to = f64::from(target_ms.clamp(-crate::MAX_AV_DELAY_MS, crate::MAX_AV_DELAY_MS)) * 48.0;
        // At most 25% rate change, even for opposite five-second extremes.
        let duration = if mode == OffsetMode::Gradual {
            (RATE * 3).max(((to - from).abs() * 4.0).ceil() as i64)
        } else {
            0
        };
        Self {
            at,
            from,
            to,
            duration,
        }
    }
    pub fn offset(self, frame: i64) -> f64 {
        if self.duration == 0 {
            return self.to;
        }
        let phase = ((frame - self.at) as f64 / self.duration as f64).clamp(0.0, 1.0);
        self.from + (self.to - self.from) * phase
    }
    pub fn audible(self, base: i64, frame: i64) -> f64 {
        base as f64 + frame as f64 - self.offset(frame)
    }
    /// Input must be ahead of the audible cursor to compensate DSP latency,
    /// matching the Host's videoTime - offset + pitchDelay convention.
    pub fn input(self, base: i64, frame: i64, dsp_latency: i64) -> i64 {
        (self.audible(base, frame) + dsp_latency as f64).round() as i64
    }
}

pub fn equal_power(index: i64, frames: i64) -> (f32, f32) {
    let phase = if frames <= 1 {
        1.0
    } else {
        (index as f64 / (frames - 1) as f64).clamp(0.0, 1.0)
    };
    (
        (phase * FRAC_PI_2).cos() as f32,
        (phase * FRAC_PI_2).sin() as f32,
    )
}
pub fn gain(percent: i32, muted: bool) -> f32 {
    if muted {
        0.0
    } else {
        percent.clamp(0, crate::MAX_VOLUME_PERCENT) as f32 / 100.0
    }
}
pub fn approach_key(current: f32, target: f32, frames: i64) -> f32 {
    current
        + (target - current).clamp(
            -(frames as f32) * 24.0 / RATE as f32,
            (frames as f32) * 24.0 / RATE as f32,
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn positive_delay_repeats_history_and_negative_delay_advances_source() {
        let zero = Transition::new(0, 0.0, 0, OffsetMode::Splice);
        let lag = Transition::new(48000, 0.0, 150, OffsetMode::Splice);
        assert_eq!(lag.input(0, 48000, 0), 40_800);
        assert_eq!(zero.input(0, 48000, 0) - lag.input(0, 48000, 0), 7_200);
        let ahead = Transition::new(48000, 0.0, -150, OffsetMode::Splice);
        assert_eq!(ahead.input(0, 48000, 0), 55_200);
        assert_eq!(lag.input(0, 48000, 5760) - 5760, 40_800);
    }
    #[test]
    fn gradual_motion_preserves_sample_clock_and_converges_with_bounded_rate() {
        let t = Transition::new(0, 0.0, 150, OffsetMode::Gradual);
        assert_eq!(t.duration, 144000);
        assert!((t.audible(0, 48000) - 45_600.0).abs() < 1e-9);
        assert_eq!(t.offset(144000), 7200.0);
        assert_eq!(t.offset(192000), 7200.0);
        for from in [-240000.0, 0.0, 240000.0] {
            for target in [-5000, 0, 5000] {
                let t = Transition::new(123, from, target, OffsetMode::Gradual);
                let ratio = (t.audible(0, 124) - t.audible(0, 123)).abs();
                assert!((0.75 - 1e-9..=1.25 + 1e-9).contains(&ratio));
                assert_eq!(t.offset(123 + t.duration), f64::from(target) * 48.0);
            }
        }
    }
    #[test]
    fn crossfades_have_exact_endpoints_constant_power_and_gain_uses_shared_bounds() {
        assert_eq!(equal_power(0, SPLICE_FRAMES), (1.0, 0.0));
        let end = equal_power(SPLICE_FRAMES - 1, SPLICE_FRAMES);
        assert!(end.0.abs() < 1e-6);
        assert_eq!(end.1, 1.0);
        for n in 0..TRACK_FADE_FRAMES {
            let (a, b) = equal_power(n, TRACK_FADE_FRAMES);
            assert!((a * a + b * b - 1.0).abs() < 1e-6);
        }
        assert_eq!(gain(700, false), 5.0);
        assert_eq!(gain(100, true), 0.0);
    }
}
