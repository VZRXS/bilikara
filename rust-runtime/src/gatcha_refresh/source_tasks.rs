//! Per-refresh-round single flight. The owning status service lives in AppState;
//! only network work and short repository commits run outside its lock.
use super::*;
use std::collections::HashMap;
use std::sync::Condvar;

type SourceResult = Result<Value, GatchaRepositoryError>;

#[derive(Debug, Default)]
struct Flight {
    result: Mutex<Option<SourceResult>>,
    ready: Condvar,
}

#[derive(Debug, Default)]
pub(crate) struct SourceTasks(Mutex<HashMap<String, Arc<Flight>>>);

impl SourceTasks {
    pub(super) fn run(
        &self,
        control: &RefreshControl,
        key: String,
        action: impl FnOnce() -> SourceResult,
    ) -> Result<(Value, bool), GatchaRepositoryError> {
        control.check()?;
        let (flight, owner) = {
            let mut flights = self.0.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(flight) = flights.get(&key) {
                (flight.clone(), false)
            } else {
                let flight = Arc::new(Flight::default());
                flights.insert(key.clone(), flight.clone());
                (flight, true)
            }
        };
        if owner {
            // Also release waiters if an unexpected unwind interrupts the owner.
            struct Completion<'a>(&'a Flight);
            impl Drop for Completion<'_> {
                fn drop(&mut self) {
                    let mut result = self.0.result.lock().unwrap_or_else(|e| e.into_inner());
                    if result.is_none() {
                        *result = Some(Err(GatchaRepositoryError {
                            kind: "cancelled".into(),
                            message: "来源拉取已中断".into(),
                        }));
                    }
                    self.0.ready.notify_all();
                }
            }
            let completion = Completion(&flight);
            let result = action().and_then(|value| control.check().map(|()| value));
            let cached = result.clone().map(|mut value| {
                // Only the owner publishes a delta. Retain small completion
                // metadata, not a second copy of every song in this round.
                if let Some(object) = value.as_object_mut() {
                    object.remove("entries");
                }
                value
            });
            *flight.result.lock().unwrap_or_else(|e| e.into_inner()) = Some(cached);
            // Failed sources can be retried during this same round.
            if result.is_err() {
                self.0
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&key);
            }
            drop(completion);
            return result.map(|value| (value, false));
        }
        loop {
            control.check()?;
            let result = flight.result.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(result) = result.as_ref() {
                return result.clone().map(|value| (value, true));
            }
            let _wait = flight.ready.wait_timeout(result, Duration::from_millis(50));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn same_source_reuses_one_result_while_another_source_can_finish() {
        let control = Arc::new(RefreshControl::default());
        control.share_sources(Arc::new(SourceTasks::default()));
        let (entered, started) = mpsc::channel();
        let (release, released) = mpsc::channel();
        let worker_control = control.clone();
        let worker = std::thread::spawn(move || {
            worker_control.source("uid:1".into(), || {
                entered.send(()).unwrap();
                released.recv_timeout(Duration::from_secs(3)).unwrap();
                Ok(json!({"uid":"1"}))
            })
        });
        started.recv_timeout(Duration::from_secs(3)).unwrap();
        assert_eq!(
            control.source("uid:2".into(), || Ok(json!(2))).unwrap(),
            (json!(2), false)
        );
        let waiter_control = control.clone();
        let waiter = std::thread::spawn(move || {
            waiter_control.source("uid:1".into(), || panic!("duplicate fetch"))
        });
        release.send(()).unwrap();
        assert_eq!(worker.join().unwrap().unwrap(), (json!({"uid":"1"}), false));
        assert_eq!(waiter.join().unwrap().unwrap(), (json!({"uid":"1"}), true));
        assert!(
            control
                .source("uid:1".into(), || panic!("repeat in same round"))
                .unwrap()
                .1
        );
    }

    #[test]
    fn failures_retry_and_stopped_waiters_do_not_execute_or_publish() {
        let sources = Arc::new(SourceTasks::default());
        let control = RefreshControl::default();
        control.share_sources(sources.clone());
        assert!(
            control
                .source("uid:1".into(), || Err(GatchaRepositoryError {
                    kind: "fixture".into(),
                    message: "offline".into()
                }))
                .is_err()
        );
        assert!(!control.source("uid:1".into(), || Ok(json!(1))).unwrap().1);
        let stopped = RefreshControl::default();
        stopped.share_sources(sources);
        stopped.stop();
        assert!(
            stopped
                .source("uid:1".into(), || panic!("stopped fetch"))
                .is_err()
        );
    }
}
