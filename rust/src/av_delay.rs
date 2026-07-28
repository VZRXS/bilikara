use serde::{Deserialize, Serialize};

pub const MAX_AV_DELAY_MS: i32 = 5_000;
const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AvDelayState {
    pub global_delay_ms: i32,
    pub local_delay_ms: i32,
    pub locked: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AvDelayAction {
    SetEffective { effective_delay_ms: i32 },
    Adjust { delta_ms: i32 },
    ResetLocal,
    ToggleLock,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AvDelayDecision {
    pub state: AvDelayState,
    pub effective_delay_ms: i32,
    pub has_local_adjustment: bool,
    pub lock_button_enabled: bool,
}

fn bounded(value: i64) -> i32 {
    value.clamp(-(MAX_AV_DELAY_MS as i64), MAX_AV_DELAY_MS as i64) as i32
}

pub fn decide_av_delay(state: AvDelayState, action: AvDelayAction) -> AvDelayDecision {
    let mut next = state;
    match action {
        AvDelayAction::SetEffective { effective_delay_ms } => {
            let target = bounded(i64::from(effective_delay_ms));
            next.local_delay_ms = target - next.global_delay_ms;
        }
        AvDelayAction::Adjust { delta_ms } => {
            let effective = i64::from(next.global_delay_ms) + i64::from(next.local_delay_ms);
            let target = bounded(effective + i64::from(delta_ms));
            next.local_delay_ms = target - next.global_delay_ms;
        }
        AvDelayAction::ResetLocal => next.local_delay_ms = 0,
        AvDelayAction::ToggleLock if next.locked => {
            next.local_delay_ms += next.global_delay_ms;
            next.global_delay_ms = 0;
            next.locked = false;
        }
        AvDelayAction::ToggleLock if next.local_delay_ms != 0 => {
            next.global_delay_ms += next.local_delay_ms;
            next.local_delay_ms = 0;
            next.locked = true;
        }
        AvDelayAction::ToggleLock => {}
    }
    snapshot(next)
}

pub fn snapshot(state: AvDelayState) -> AvDelayDecision {
    let effective_delay_ms = state.global_delay_ms + state.local_delay_ms;
    let has_local_adjustment = state.local_delay_ms != 0;
    AvDelayDecision {
        state,
        effective_delay_ms,
        has_local_adjustment,
        lock_button_enabled: state.locked || has_local_adjustment,
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WireRequest {
    schema_version: u32,
    state: WireState,
    action: WireAction,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WireState {
    global_delay_ms: i32,
    local_delay_ms: i32,
    locked: bool,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum WireAction {
    Snapshot,
    SetEffective { effective_delay_ms: i32 },
    Adjust { delta_ms: i32 },
    ResetLocal,
    ToggleLock,
}

#[derive(Debug, Serialize)]
struct WireResponse {
    schema_version: u32,
    global_delay_ms: i32,
    local_delay_ms: i32,
    effective_delay_ms: i32,
    locked: bool,
    has_local_adjustment: bool,
    lock_button_enabled: bool,
}

pub(crate) fn decide_av_delay_json(request_json: &str) -> Option<String> {
    let request: WireRequest = serde_json::from_str(request_json).ok()?;
    if request.schema_version != SCHEMA_VERSION {
        return None;
    }
    let state = AvDelayState {
        global_delay_ms: request.state.global_delay_ms,
        local_delay_ms: request.state.local_delay_ms,
        locked: request.state.locked,
    };
    let effective = i64::from(state.global_delay_ms) + i64::from(state.local_delay_ms);
    if !(-i64::from(MAX_AV_DELAY_MS)..=i64::from(MAX_AV_DELAY_MS)).contains(&effective) {
        return None;
    }
    let decision = match request.action {
        WireAction::Snapshot => snapshot(state),
        WireAction::SetEffective { effective_delay_ms } => {
            decide_av_delay(state, AvDelayAction::SetEffective { effective_delay_ms })
        }
        WireAction::Adjust { delta_ms } => {
            decide_av_delay(state, AvDelayAction::Adjust { delta_ms })
        }
        WireAction::ResetLocal => decide_av_delay(state, AvDelayAction::ResetLocal),
        WireAction::ToggleLock => decide_av_delay(state, AvDelayAction::ToggleLock),
    };
    serde_json::to_string(&WireResponse {
        schema_version: SCHEMA_VERSION,
        global_delay_ms: decision.state.global_delay_ms,
        local_delay_ms: decision.state.local_delay_ms,
        effective_delay_ms: decision.effective_delay_ms,
        locked: decision.state.locked,
        has_local_adjustment: decision.has_local_adjustment,
        lock_button_enabled: decision.lock_button_enabled,
    })
    .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(global: i32, local: i32, locked: bool) -> AvDelayState {
        AvDelayState {
            global_delay_ms: global,
            local_delay_ms: local,
            locked,
        }
    }

    #[test]
    fn lock_and_unlock_preserve_effective_delay() {
        let locked = decide_av_delay(state(100, 75, false), AvDelayAction::ToggleLock);
        assert_eq!(locked.state, state(175, 0, true));
        assert_eq!(locked.effective_delay_ms, 175);
        assert!(locked.lock_button_enabled);

        let unlocked = decide_av_delay(locked.state, AvDelayAction::ToggleLock);
        assert_eq!(unlocked.state, state(0, 175, false));
        assert_eq!(unlocked.effective_delay_ms, 175);
    }

    #[test]
    fn adjustments_only_change_local_delay_and_are_bounded_by_effective_delay() {
        let adjusted =
            decide_av_delay(state(200, 10, true), AvDelayAction::Adjust { delta_ms: 50 });
        assert_eq!(adjusted.state, state(200, 60, true));
        let bounded = decide_av_delay(
            adjusted.state,
            AvDelayAction::SetEffective {
                effective_delay_ms: 99_999,
            },
        );
        assert_eq!(bounded.state, state(200, 4_800, true));
        assert_eq!(bounded.effective_delay_ms, MAX_AV_DELAY_MS);
    }

    #[test]
    fn reset_returns_to_global_and_button_state_tracks_all_combinations() {
        let cases = [
            (state(0, 0, false), false, false),
            (state(0, 20, false), true, true),
            (state(0, 0, true), false, true),
            (state(100, 20, true), true, true),
        ];
        for (input, has_local, enabled) in cases {
            let decision = snapshot(input);
            assert_eq!(decision.has_local_adjustment, has_local);
            assert_eq!(decision.lock_button_enabled, enabled);
        }
        let reset = decide_av_delay(state(100, 20, true), AvDelayAction::ResetLocal);
        assert_eq!(reset.state, state(100, 0, true));
        assert_eq!(reset.effective_delay_ms, 100);
    }

    #[test]
    fn unlocked_without_local_adjustment_cannot_be_locked() {
        let unchanged = decide_av_delay(state(0, 0, false), AvDelayAction::ToggleLock);
        assert_eq!(unchanged.state, state(0, 0, false));
        assert!(!unchanged.lock_button_enabled);
    }

    #[test]
    fn locked_zero_baseline_is_valid_and_can_always_be_unlocked() {
        let locked = snapshot(state(0, 0, true));
        assert_eq!(locked.effective_delay_ms, 0);
        assert!(locked.lock_button_enabled);

        let unlocked = decide_av_delay(locked.state, AvDelayAction::ToggleLock);
        assert_eq!(unlocked.state, state(0, 0, false));
        assert_eq!(unlocked.effective_delay_ms, 0);
        assert!(!unlocked.lock_button_enabled);
    }
}
