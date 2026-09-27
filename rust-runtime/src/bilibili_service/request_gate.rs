//! Process-wide API admission: bound parallel requests, pace starts, and share
//! simultaneous identical reads only within the same credential/header scope.
use super::*;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Condvar};

type Response = Result<Value, BilibiliServiceError>;
#[derive(Default)]
struct Flight {
    result: Mutex<Option<Response>>,
    ready: Condvar,
}
#[derive(Default)]
struct State {
    active: HashMap<String, Arc<Flight>>,
    next: Option<Instant>,
    queue: VecDeque<u64>,
    ticket: u64,
}
#[derive(Default)]
struct Gate {
    state: Mutex<State>,
    changed: Condvar,
}
static GATE: OnceLock<Gate> = OnceLock::new();

struct Owner<'a>(&'a Gate, String, Arc<Flight>);
impl Drop for Owner<'_> {
    fn drop(&mut self) {
        let mut result = self.2.result.lock().unwrap_or_else(|e| e.into_inner());
        if result.is_none() {
            *result = Some(Err(service_error("network", "B 站请求中断，请重试", None)));
        }
        self.2.ready.notify_all();
        self.0
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .active
            .remove(&self.1);
        self.0.changed.notify_all();
    }
}

impl Gate {
    fn run(
        &self,
        key: String,
        timeout: Duration,
        spacing: Duration,
        fetch: impl FnOnce() -> Response,
    ) -> Response {
        self.run_controlled(key, timeout, spacing, || false, fetch)
    }

    fn run_controlled(
        &self,
        key: String,
        timeout: Duration,
        spacing: Duration,
        stopped: impl Fn() -> bool,
        fetch: impl FnOnce() -> Response,
    ) -> Response {
        let deadline = Instant::now() + timeout;
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let ticket = state.ticket;
        state.ticket = state.ticket.wrapping_add(1);
        state.queue.push_back(ticket);
        loop {
            if stopped() {
                state.queue.retain(|queued| *queued != ticket);
                self.changed.notify_all();
                return Err(service_error("cancelled", "B 站请求已取消", None));
            }
            if let Some(flight) = state.active.get(&key).cloned() {
                state.queue.retain(|queued| *queued != ticket);
                self.changed.notify_all();
                drop(state);
                let mut result = flight.result.lock().unwrap_or_else(|e| e.into_inner());
                while result.is_none() {
                    if stopped() {
                        return Err(service_error("cancelled", "B 站请求已取消", None));
                    }
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        return Err(service_error("network", "等待 B 站响应超时，请重试", None));
                    }
                    result = flight
                        .ready
                        .wait_timeout(result, remaining.min(Duration::from_millis(50)))
                        .unwrap_or_else(|e| e.into_inner())
                        .0;
                }
                return result.as_ref().unwrap().clone();
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                state.queue.retain(|queued| *queued != ticket);
                self.changed.notify_all();
                return Err(service_error("network", "B 站请求繁忙，请稍后重试", None));
            }
            let delay = state.next.map_or(Duration::ZERO, |next| {
                next.saturating_duration_since(Instant::now())
            });
            if state.active.len() < 4 && delay.is_zero() && state.queue.front() == Some(&ticket) {
                state.queue.pop_front();
                break;
            }
            state = self
                .changed
                .wait_timeout(
                    state,
                    (if delay.is_zero() {
                        remaining
                    } else {
                        delay.min(remaining)
                    })
                    .min(Duration::from_millis(50)),
                )
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
        let flight = Arc::new(Flight::default());
        state.active.insert(key.clone(), flight.clone());
        state.next = Some(Instant::now() + spacing);
        self.changed.notify_all();
        drop(state);
        let _owner = Owner(self, key, flight.clone());
        let result = fetch();
        *flight.result.lock().unwrap_or_else(|e| e.into_inner()) = Some(result.clone());
        result
    }
}

pub(super) fn run(
    scope: &str,
    key: &str,
    timeout: Duration,
    fetch: impl FnOnce() -> Response,
) -> Response {
    GATE.get_or_init(Gate::default).run(
        format!("{scope}:{key}"),
        timeout,
        Duration::from_millis(250),
        fetch,
    )
}

pub(super) fn run_controlled(
    scope: &str,
    key: &str,
    timeout: Duration,
    stopped: impl Fn() -> bool,
    fetch: impl FnOnce() -> Response,
) -> Response {
    GATE.get_or_init(Gate::default).run_controlled(
        format!("{scope}:{key}"),
        timeout,
        Duration::from_millis(250),
        stopped,
        fetch,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};
    #[test]
    fn stopped_waiter_leaves_admission_without_starting_network_io() {
        let gate = Gate::default();
        for id in 0..4 {
            gate.state
                .lock()
                .unwrap()
                .active
                .insert(id.to_string(), Arc::new(Flight::default()));
        }
        let stop = std::sync::atomic::AtomicBool::new(false);
        std::thread::scope(|scope| {
            let waiter = scope.spawn(|| {
                gate.run_controlled(
                    "cancel".into(),
                    Duration::from_secs(30),
                    Duration::ZERO,
                    || stop.load(Ordering::Acquire),
                    || panic!("cancelled waiter must not fetch"),
                )
            });
            let deadline = Instant::now() + Duration::from_secs(2);
            while gate.state.lock().unwrap().queue.is_empty() {
                assert!(Instant::now() < deadline);
                std::thread::yield_now();
            }
            stop.store(true, Ordering::Release);
            let started = Instant::now();
            assert_eq!(waiter.join().unwrap().unwrap_err().kind, "cancelled");
            assert!(started.elapsed() < Duration::from_secs(1));
        });
        assert!(gate.state.lock().unwrap().queue.is_empty());
    }
    #[test]
    fn queued_reads_are_fifo_and_timed_out_waiters_do_not_block_the_queue() {
        let gate = Gate::default();
        for id in 0..4 {
            gate.state
                .lock()
                .unwrap()
                .active
                .insert(format!("reserved-{id}"), Arc::new(Flight::default()));
        }
        assert!(
            gate.run(
                "expired".into(),
                Duration::from_millis(1),
                Duration::ZERO,
                || panic!("expired request must not start")
            )
            .is_err()
        );
        let order = Mutex::new(Vec::new());
        std::thread::scope(|scope| {
            for id in 0..3 {
                let gate = &gate;
                let order = &order;
                scope.spawn(move || {
                    gate.run(
                        format!("scope-{id}:same-url"),
                        Duration::from_secs(2),
                        Duration::ZERO,
                        || {
                            order.lock().unwrap().push(id);
                            Ok(json!(id))
                        },
                    )
                    .unwrap()
                });
                let deadline = Instant::now() + Duration::from_secs(1);
                while gate.state.lock().unwrap().queue.len() < id + 1 {
                    assert!(Instant::now() < deadline);
                    std::thread::yield_now();
                }
            }
            gate.state.lock().unwrap().active.remove("reserved-0");
            gate.changed.notify_all();
        });
        assert_eq!(*order.lock().unwrap(), vec![0, 1, 2]);
        assert!(gate.state.lock().unwrap().queue.is_empty());
    }

    #[test]
    fn owner_panic_releases_admission_and_publishes_an_error() {
        let gate = Gate::default();
        let _ = std::panic::catch_unwind(|| {
            gate.run(
                "panic".into(),
                Duration::from_secs(1),
                Duration::ZERO,
                || panic!("fixture"),
            )
        });
        assert!(gate.state.lock().unwrap().active.is_empty());
        assert_eq!(
            gate.run(
                "panic".into(),
                Duration::from_secs(1),
                Duration::ZERO,
                || Ok(json!(42))
            )
            .unwrap(),
            json!(42)
        );
    }
    #[test]
    fn identical_reads_share_one_request_and_unique_reads_are_paced() {
        let gate = Gate::default();
        let calls = AtomicUsize::new(0);
        let started = Instant::now();
        std::thread::scope(|scope| {
            let first = scope.spawn(|| {
                gate.run(
                    "a".into(),
                    Duration::from_secs(2),
                    Duration::from_millis(40),
                    || {
                        calls.fetch_add(1, Ordering::SeqCst);
                        std::thread::sleep(Duration::from_millis(100));
                        Ok(serde_json::json!(1))
                    },
                )
            });
            while calls.load(Ordering::SeqCst) == 0 {
                std::thread::yield_now();
            }
            assert_eq!(
                gate.run(
                    "a".into(),
                    Duration::from_secs(2),
                    Duration::ZERO,
                    || panic!("duplicate upstream")
                ),
                Ok(serde_json::json!(1))
            );
            assert_eq!(first.join().unwrap(), Ok(serde_json::json!(1)));
        });
        gate.run(
            "b".into(),
            Duration::from_secs(2),
            Duration::from_millis(40),
            || Ok(Value::Null),
        )
        .unwrap();
        gate.run("c".into(), Duration::from_secs(2), Duration::ZERO, || {
            Ok(Value::Null)
        })
        .unwrap();
        assert!(started.elapsed() >= Duration::from_millis(140));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}
