//! Deterministic lifecycle and transport policy for an explicitly selected
//! network output. Operational I/O and mutable authority remain in AppState.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Keep,
    Stop,
    Pause,
    Wait,
    Start,
    Advance,
    Disconnected,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct Facts {
    pub selected: bool,
    pub authorized: bool,
    pub busy: bool,
    pub blocked: bool,
    pub has_item: bool,
    pub cache_ready: bool,
    pub active: bool,
    pub same_program: bool,
    pub playing: bool,
    pub restart: bool,
    /// Only receiver completion for the current program, not producer EOF.
    pub completed: bool,
    pub waiting_for_transition: bool,
}
pub fn decide(f: Facts) -> Action {
    if f.busy {
        return Action::Keep;
    }
    if !f.selected {
        return if f.active { Action::Stop } else { Action::Keep };
    }
    if !f.authorized {
        return Action::Disconnected;
    }
    if f.blocked {
        return if f.active { Action::Stop } else { Action::Keep };
    }
    if !f.has_item {
        return if f.active { Action::Stop } else { Action::Wait };
    }
    if f.active && (!f.same_program || f.restart) {
        return Action::Stop;
    }
    if !f.playing {
        return if f.active {
            Action::Pause
        } else {
            Action::Keep
        };
    }
    if f.completed && f.same_program {
        return Action::Advance;
    }
    if !f.cache_ready || f.waiting_for_transition {
        return Action::Wait;
    }
    if !f.active {
        Action::Start
    } else {
        Action::Keep
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Transport {
    pub playing: bool,
    pub position: f64,
    pub duration: f64,
}
#[derive(Clone, Copy, Debug)]
pub enum Control {
    Play,
    Pause,
    Toggle,
    SeekAbsolute(f64),
    SeekRelative(f64),
    Next,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Intent {
    pub transport: Transport,
    pub restart: bool,
    pub next: bool,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InvalidPosition;
pub fn control(mut state: Transport, command: Control) -> Result<Intent, InvalidPosition> {
    if !state.position.is_finite()
        || !state.duration.is_finite()
        || state.position < 0.0
        || state.duration < 0.0
    {
        return Err(InvalidPosition);
    }
    let mut restart = false;
    let mut next = false;
    match command {
        Control::Play => state.playing = true,
        Control::Pause => state.playing = false,
        Control::Toggle => state.playing = !state.playing,
        Control::SeekAbsolute(target) | Control::SeekRelative(target) => {
            let target = if matches!(command, Control::SeekRelative(_)) {
                state.position + target
            } else {
                target
            };
            if !target.is_finite() {
                return Err(InvalidPosition);
            }
            // Matches the live pipeline's existing six-hour seek boundary.
            let limit = if state.duration > 0.0 {
                state.duration.min(21600.0)
            } else {
                21600.0
            };
            state.position = target.clamp(0.0, limit);
            restart = true;
        }
        Control::Next => next = true,
    }
    Ok(Intent {
        transport: state,
        restart,
        next,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn streaming() -> Facts {
        Facts {
            selected: true,
            authorized: true,
            has_item: true,
            cache_ready: true,
            active: true,
            same_program: true,
            playing: true,
            ..Default::default()
        }
    }
    #[test]
    fn failures_hold_network_selection_and_idle_waits_for_cached_media() {
        let f = streaming();
        assert_eq!(decide(f), Action::Keep);
        assert_eq!(
            decide(Facts {
                authorized: false,
                ..f
            }),
            Action::Disconnected
        );
        assert_eq!(decide(Facts { blocked: true, ..f }), Action::Stop);
        assert_eq!(
            decide(Facts {
                blocked: true,
                active: false,
                ..f
            }),
            Action::Keep
        );
        assert_eq!(
            decide(Facts {
                active: false,
                has_item: false,
                ..f
            }),
            Action::Wait
        );
        assert_eq!(
            decide(Facts {
                active: false,
                cache_ready: false,
                ..f
            }),
            Action::Wait
        );
        assert_eq!(decide(Facts { active: false, ..f }), Action::Start);
        assert_eq!(
            decide(Facts {
                busy: true,
                same_program: false,
                ..f
            }),
            Action::Keep
        );
    }
    #[test]
    fn pause_seek_and_new_program_rebuild_but_sender_eof_never_advances() {
        let f = streaming();
        assert_eq!(
            decide(Facts {
                playing: false,
                ..f
            }),
            Action::Pause
        );
        assert_eq!(decide(Facts { restart: true, ..f }), Action::Stop);
        assert_eq!(
            decide(Facts {
                same_program: false,
                ..f
            }),
            Action::Stop
        );
        assert_eq!(
            decide(Facts {
                active: false,
                completed: true,
                ..f
            }),
            Action::Advance
        );
        assert_eq!(
            decide(Facts {
                active: false,
                waiting_for_transition: true,
                ..f
            }),
            Action::Wait
        );
        assert_eq!(
            decide(Facts {
                active: false,
                completed: true,
                playing: false,
                ..f
            }),
            Action::Keep
        );
    }
    #[test]
    fn controls_keep_pause_intent_across_seek_and_clamp_at_real_duration() {
        let s = Transport {
            playing: false,
            position: 40.0,
            duration: 90.0,
        };
        let seek = control(s, Control::SeekRelative(-100.0)).unwrap();
        assert_eq!(seek.transport.position, 0.0);
        assert!(!seek.transport.playing);
        assert!(seek.restart);
        assert_eq!(
            control(s, Control::SeekAbsolute(200.0))
                .unwrap()
                .transport
                .position,
            90.0
        );
        assert!(control(s, Control::SeekAbsolute(f64::NAN)).is_err());
        assert!(control(s, Control::Toggle).unwrap().transport.playing);
        assert!(control(s, Control::Next).unwrap().next);
    }
}
