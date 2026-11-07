//! Description availability is not the media delivery clock. Keep bounded
//! evidence under AppState and bind it to the admitted connection generation.
use super::*;

const ADVANCING_DESCRIPTION_GRACE: Duration = Duration::from_secs(120);

#[derive(Default)]
pub(super) struct Checks {
    binding: Option<(u64, String)>,
    failures: u32,
    first_failure: Option<Instant>,
}

impl Checks {
    fn bind(&mut self, generation: u64, identity: &str) {
        if !self
            .binding
            .as_ref()
            .is_some_and(|(g, id)| *g == generation && id == identity)
        {
            *self = Self {
                binding: Some((generation, identity.to_owned())),
                ..Self::default()
            };
        }
    }

    pub fn interval(&mut self, generation: u64, identity: &str, advancing: bool) -> Duration {
        self.bind(generation, identity);
        // Do not hammer a busy description server while the real stream is
        // advancing. A missing/stalled consumer keeps the ordinary retry rate.
        Duration::from_secs(if self.failures > 0 && !advancing {
            1
        } else {
            20
        })
    }

    pub fn observe(
        &mut self,
        generation: u64,
        identity: &str,
        health: Health,
        advancing: bool,
        now: Instant,
    ) -> bool {
        self.bind(generation, identity);
        match health {
            Health::Healthy => {
                self.failures = 0;
                self.first_failure = None;
                true
            }
            Health::Changed => false,
            Health::Transient => {
                self.failures = self.failures.saturating_add(1);
                let since = *self.first_failure.get_or_insert(now);
                self.failures < HEALTH_RETRY_LIMIT
                    || (advancing
                        && now.saturating_duration_since(since) < ADVANCING_DESCRIPTION_GRACE)
            }
        }
    }
}

impl RoomState {
    /// A completed I/O probe may only mutate its own still-admitted lease.
    pub(super) fn finish_health_check(
        &mut self,
        generation: u64,
        identity: &str,
        health: Health,
        now: Instant,
    ) -> Option<bool> {
        if self.generation != generation
            || !self.busy
            || !self
                .connected
                .as_ref()
                .is_some_and(|c| c.target_room_id == identity)
        {
            return None;
        }
        let advancing = self.output.running.as_ref().is_some_and(|r| r.advancing());
        let healthy = self
            .health
            .observe(generation, identity, health, advancing, now);
        self.busy = !healthy;
        if !healthy {
            self.diagnostics.connection(json!({
                "result":"released","failure_stage":"health_check",
                "cause":if health == Health::Changed {"route_or_identity_changed"} else {"unreachable"}}));
            self.connected = None;
            self.generation += 1;
            self.output.stop(self.generation);
            self.error = Some("purek_network".into());
        }
        Some(!healthy)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn actual_progress_only_defers_description_failure_for_a_bounded_interval() {
        let start = Instant::now();
        let mut checks = Checks::default();
        for seconds in [0, 20, 40, 60, 80, 100, 119] {
            assert!(checks.observe(
                1,
                "first",
                Health::Transient,
                true,
                start + Duration::from_secs(seconds)
            ));
        }
        assert!(!checks.observe(
            1,
            "first",
            Health::Transient,
            true,
            start + ADVANCING_DESCRIPTION_GRACE
        ));
        assert!(checks.observe(
            1,
            "first",
            Health::Healthy,
            true,
            start + ADVANCING_DESCRIPTION_GRACE
        ));
        assert!(checks.observe(
            1,
            "first",
            Health::Transient,
            true,
            start + Duration::from_secs(121)
        ));
        // An open socket or an old byte counter does not keep a stalled stream alive.
        for _ in 1..HEALTH_RETRY_LIMIT - 1 {
            assert!(checks.observe(
                1,
                "first",
                Health::Transient,
                false,
                start + Duration::from_secs(122)
            ));
        }
        assert!(!checks.observe(
            1,
            "first",
            Health::Transient,
            false,
            start + Duration::from_secs(123)
        ));
    }

    #[test]
    fn new_connections_reset_failures_and_changes_are_never_tolerated() {
        let now = Instant::now();
        let mut checks = Checks::default();
        for _ in 0..HEALTH_RETRY_LIMIT - 1 {
            assert!(checks.observe(1, "first", Health::Transient, false, now));
        }
        assert!(checks.observe(2, "first", Health::Transient, false, now));
        assert!(checks.observe(2, "second", Health::Transient, false, now));
        assert_eq!(checks.interval(2, "second", true), Duration::from_secs(20));
        assert_eq!(checks.interval(2, "second", false), Duration::from_secs(1));
        assert!(!checks.observe(2, "second", Health::Changed, true, now));
        assert!(checks.observe(2, "second", Health::Healthy, false, now));
        assert_eq!(checks.interval(2, "second", false), Duration::from_secs(20));
    }
}
