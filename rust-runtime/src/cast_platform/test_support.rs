//! Thread-scoped registry: tests exercise production acquire/install paths without
//! replacing the process platform or affecting concurrent tests/worker threads.
use super::*;
use std::{cell::RefCell, collections::BTreeSet, sync::Mutex};

thread_local! {
    static REGISTRY: RefCell<Option<Arc<OnceLock<Installed>>>> = const { RefCell::new(None) };
}
pub(super) fn registry() -> Option<Arc<OnceLock<Installed>>> {
    REGISTRY.with(|slot| slot.borrow().clone())
}
pub(crate) fn scoped<T>(action: impl FnOnce() -> T) -> T {
    struct Reset(Option<Arc<OnceLock<Installed>>>);
    impl Drop for Reset {
        fn drop(&mut self) {
            REGISTRY.with(|slot| *slot.borrow_mut() = self.0.take());
        }
    }
    let _reset = Reset(REGISTRY.with(|slot| slot.replace(Some(Arc::new(OnceLock::new())))));
    action()
}

#[derive(Default)]
pub(crate) struct RecordingPlatform {
    active: Mutex<BTreeSet<u64>>,
    pub events: Mutex<Vec<(u64, bool)>>,
}
impl RecordingPlatform {
    pub fn active(&self) -> usize {
        self.active.lock().unwrap().len()
    }
    pub fn assert_finished(&self, scans: usize) {
        assert_eq!(self.active(), 0, "discovery lease leaked");
        let events = self.events.lock().unwrap();
        assert_eq!(
            events.len(),
            scans * 2,
            "missing or duplicate discovery lease"
        );
        for pair in events.chunks_exact(2) {
            assert!(pair[0].1);
            assert_eq!(pair[1], (pair[0].0, false));
        }
    }
}
impl CastPlatform for RecordingPlatform {
    fn discovery_begin(&self, id: u64) -> bool {
        assert!(self.active.lock().unwrap().insert(id));
        self.events.lock().unwrap().push((id, true));
        true
    }
    fn discovery_end(&self, id: u64) {
        assert!(self.active.lock().unwrap().remove(&id));
        self.events.lock().unwrap().push((id, false));
    }
}
