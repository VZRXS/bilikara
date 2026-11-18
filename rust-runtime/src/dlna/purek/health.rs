// Adapted from bilikara-next 7750dca, native_host/purek/health.rs (MIT),
// including dd88c12, and ChunK-Helper 3b00533, Network/RendererHealthMonitor.cs
// (MIT). Rewritten with T2 cancellation. See THIRD_PARTY_NOTICES.md.

use super::*;

pub const NORMAL_INTERVAL: Duration = Duration::from_secs(20);
pub const RETRY_INTERVAL: Duration = Duration::from_secs(1);
pub(super) const FAILURE_LIMIT: u8 = 5;
const DELIVERY_RECENT: Duration = Duration::from_secs(15);
const DESCRIPTION_GRACE: Duration = Duration::from_secs(120);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HealthState {
    Online,
    Suspect,
    Offline,
    IdentityChanged,
    Cancelled,
    Released,
}

#[derive(Default)]
pub(super) struct Checks {
    failures: u8,
    first_failure: Option<Instant>,
    last_total_bytes: u64,
    last_byte_at: Option<Instant>,
}
impl Checks {
    fn bytes(&mut self, total: u64, now: Instant) {
        if total > self.last_total_bytes {
            self.last_total_bytes = total;
            self.last_byte_at = Some(now);
        }
    }
    fn recent(&self, now: Instant) -> bool {
        self.last_byte_at
            .is_some_and(|at| now.saturating_duration_since(at) < DELIVERY_RECENT)
    }
    fn failed(&mut self, now: Instant) -> HealthState {
        self.failures = self.failures.saturating_add(1);
        let since = *self.first_failure.get_or_insert(now);
        if self.failures < FAILURE_LIMIT
            || (self.recent(now) && now.saturating_duration_since(since) < DESCRIPTION_GRACE)
        {
            HealthState::Suspect
        } else {
            HealthState::Offline
        }
    }
    fn healthy(&mut self) {
        self.failures = 0;
        self.first_failure = None;
    }
    fn interval(&self) -> Duration {
        if self.failures > 0 {
            RETRY_INTERVAL
        } else {
            NORMAL_INTERVAL
        }
    }
}

impl Session {
    /// Supply the cumulative bytes actually delivered by this admitted T4 lease.
    /// Repeated counters, open connections and elapsed playback time add no evidence.
    pub fn record_delivery(&mut self, total_bytes: u64) {
        self.health.bytes(total_bytes, Instant::now());
    }

    pub fn health_interval(&self) -> Duration {
        self.health.interval()
    }

    /// A single command worker can select this deadline alongside its own
    /// health/command deadlines instead of borrowing the lease in `maintain`.
    pub fn announcement_delay(&self) -> Option<Duration> {
        self.is_registered().then(|| {
            self.next_announcement
                .saturating_duration_since(Instant::now())
        })
    }

    pub async fn renew_announcement(&mut self, cancel: &CancellationToken) -> Option<PhaseResult> {
        if self.announcement_delay()? > Duration::ZERO {
            return None;
        }
        let stage = self.announcement(true, cancel).await;
        self.next_announcement = Instant::now() + ANNOUNCE_INTERVAL;
        Some(stage)
    }

    /// One immediate sample for a worker/self-test. `maintain` owns scheduling.
    pub async fn poll_health(&mut self, cancel: &CancellationToken) -> PureKOperation<HealthState> {
        if self.closed {
            return PureKOperation {
                result: Ok(HealthState::Released),
                stages: Vec::new(),
            };
        }
        let mut stages = Vec::new();
        let since = Instant::now();
        let route = self.client.route(self.target, &mut self.context, cancel);
        stages.push(route_stage(
            since,
            &route,
            self.target,
            &self.context,
            self.client.policy,
        ));
        let route = match route {
            Ok(local) => local,
            Err(error) => {
                let state = if error.cause.is_cancelled() {
                    HealthState::Cancelled
                } else {
                    self.health.failed(Instant::now())
                };
                let mut stage = PhaseResult::new(
                    Phase::Health,
                    since,
                    &Err::<(), _>(error),
                    Some(&self.context),
                );
                stage.facts.consecutive_failures = self.health.failures;
                stage.facts.recent_delivery = self.health.recent(Instant::now());
                if state == HealthState::Suspect {
                    stage.stage.disposition = Disposition::Retrying;
                }
                stages.push(stage);
                return self.finish_health(state, stages).await;
            }
        };
        self.local = route;
        let (observed, mut stage) = self.read_description(Phase::Health, cancel).await;
        let now = Instant::now();
        let state = match observed {
            Ok(description) => {
                let previous = self.description.as_ref().expect("session description");
                let same = description.udn.eq_ignore_ascii_case(&previous.udn);
                stage.facts.udn_same = Some(same);
                stage.facts.registration_endpoint_changed =
                    Some(description.manager != previous.manager);
                stage.facts.services_changed_after_auth =
                    Some(description.services_changed(previous));
                let route_changed = self
                    .registration
                    .as_ref()
                    .is_some_and(|registration| registration.local != route);
                stage.facts.route_changed = Some(route_changed);
                if !same {
                    register::fail_stage(
                        &mut stage,
                        &PureKError::new(
                            PureKErrorCode::IdentityChanged,
                            DlnaError::new(ErrorCode::Unavailable),
                        ),
                    );
                    HealthState::IdentityChanged
                } else if route_changed {
                    // Reuse confirmation's identity check, single re-registration
                    // and original-IP cleanup. Never re-register a new UDN.
                    stages.push(stage);
                    let result = self.confirm(cancel, &mut stages).await;
                    let state = match result {
                        Ok(()) => {
                            self.health.healthy();
                            HealthState::Online
                        }
                        Err(error) if error.cause.is_cancelled() => HealthState::Cancelled,
                        Err(error) if error.code == PureKErrorCode::IdentityChanged => {
                            HealthState::IdentityChanged
                        }
                        Err(_) => HealthState::Offline,
                    };
                    return self.finish_health(state, stages).await;
                } else {
                    self.description = Some(description);
                    self.health.healthy();
                    HealthState::Online
                }
            }
            Err(error) if error.cause.is_cancelled() => HealthState::Cancelled,
            Err(_) => self.health.failed(now),
        };
        stage.facts.consecutive_failures = self.health.failures;
        stage.facts.recent_delivery = self.health.recent(now);
        if state == HealthState::Suspect {
            stage.stage.disposition = Disposition::Retrying;
        }
        stages.push(stage);
        self.finish_health(state, stages).await
    }

    async fn finish_health(
        &mut self,
        state: HealthState,
        mut stages: Vec<PhaseResult>,
    ) -> PureKOperation<HealthState> {
        if matches!(
            state,
            HealthState::Offline | HealthState::IdentityChanged | HealthState::Cancelled
        ) {
            stages.extend(self.release().await.stages);
        }
        PureKOperation {
            result: Ok(state),
            stages,
        }
    }

    /// Await this in the AppState worker, with the admitted generation's token
    /// and T4 byte counter. Always attempts cleanup before returning, including
    /// cancellation. Callback records are bounded individually, never accumulated.
    pub async fn maintain(
        &mut self,
        cancel: &CancellationToken,
        mut delivered_bytes: tokio::sync::watch::Receiver<u64>,
        mut publish: impl FnMut(PhaseResult),
    ) -> HealthState {
        let mut next_probe = Instant::now() + NORMAL_INTERVAL;
        let mut evidence_open = true;
        // An old counter is not proof of bytes delivered just now.
        self.health.last_total_bytes = self
            .health
            .last_total_bytes
            .max(*delivered_bytes.borrow_and_update());
        let final_state = loop {
            if self.closed {
                break HealthState::Released;
            }
            let deadline = if self.registration.is_some() {
                next_probe.min(self.next_announcement)
            } else {
                next_probe
            };
            tokio::select! {
                biased;
                _ = cancel.cancelled() => break HealthState::Cancelled,
                update = delivered_bytes.changed(), if evidence_open => {
                    if update.is_ok() { self.record_delivery(*delivered_bytes.borrow_and_update()); }
                    else { evidence_open = false; }
                }
                _ = tokio::time::sleep_until(deadline.into()) => {}
            }
            if let Some(stage) = self.renew_announcement(cancel).await {
                publish(stage);
            }
            if Instant::now() >= next_probe {
                let operation = self.poll_health(cancel).await;
                for stage in operation.stages {
                    publish(stage);
                }
                let state = operation.result.unwrap_or(HealthState::Offline);
                if !matches!(state, HealthState::Online | HealthState::Suspect) {
                    break state;
                }
                next_probe = Instant::now() + self.health_interval();
            }
        };
        for stage in self.release().await.stages {
            publish(stage);
        }
        final_state
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_fresh_actual_bytes_extend_description_grace_and_never_beyond_120_seconds() {
        let start = Instant::now();
        let mut checks = Checks::default();
        assert_eq!(checks.interval(), NORMAL_INTERVAL);
        for second in 0..120 {
            checks.bytes(second + 1, start + Duration::from_secs(second));
            assert_eq!(
                checks.failed(start + Duration::from_secs(second)),
                HealthState::Suspect
            );
            assert_eq!(checks.interval(), RETRY_INTERVAL);
        }
        checks.bytes(121, start + DESCRIPTION_GRACE);
        assert_eq!(
            checks.failed(start + DESCRIPTION_GRACE),
            HealthState::Offline
        );
        checks.healthy();
        assert_eq!(checks.interval(), NORMAL_INTERVAL);
        assert_eq!(
            checks.failed(start + DESCRIPTION_GRACE),
            HealthState::Suspect
        );
    }

    #[test]
    fn repeated_or_stalled_byte_counters_do_not_extend_grace() {
        let start = Instant::now();
        let mut checks = Checks::default();
        checks.bytes(42, start);
        for second in 0..15 {
            checks.bytes(42, start + Duration::from_secs(second));
            assert_eq!(
                checks.failed(start + Duration::from_secs(second)),
                HealthState::Suspect
            );
        }
        assert_eq!(checks.failed(start + DELIVERY_RECENT), HealthState::Offline);
        assert_eq!(Checks::default().failed(start), HealthState::Suspect);
    }
}
