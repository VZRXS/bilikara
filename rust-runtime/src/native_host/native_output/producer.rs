//! Bounded local L1 producer. No DLNA listener, peer ACL or network controller.
use super::*;
use std::sync::atomic::AtomicI64;
pub(super) struct Running {
    pub duration_us: AtomicI64,
    pub stop: AtomicBool,
    pub played: AtomicBool,
    pub delivered: AtomicBool,
    announced: AtomicBool,
    generation: u64,
    clock: Instant,
    capability: String,
    pub preview: Option<Arc<preview::Preview>>,
    pub trace: Arc<trace::OutputTrace>,
}
impl Running {
    pub fn new(generation: u64, trace: Arc<trace::OutputTrace>) -> Result<Arc<Self>, ApiError> {
        Ok(Arc::new(Self {
            duration_us: AtomicI64::new(0),
            stop: AtomicBool::new(false),
            played: AtomicBool::new(false),
            delivered: AtomicBool::new(false),
            announced: AtomicBool::new(false),
            generation,
            clock: Instant::now(),
            capability: token()?,
            preview: None,
            trace,
        }))
    }
    pub fn cancel(&self) {
        self.stop.store(true, Ordering::Release);
        if let Some(p) = &self.preview {
            p.wake();
        }
    }
    pub fn publish(&self) {
        if self.played.load(Ordering::Acquire)
            && self.delivered.load(Ordering::Acquire)
            && !self.announced.swap(true, Ordering::AcqRel)
        {
            output::mark_streaming(self.generation);
        }
    }
    pub fn finished(&self, error: bool) {
        if let Some(p) = &self.preview {
            p.finish(self.generation, error, self.stop.load(Ordering::Acquire));
        }
    }
    pub fn has_consumer(&self) -> bool {
        self.preview.as_ref().is_some_and(|p| p.recent())
    }
    pub fn generation(&self) -> u64 {
        self.generation
    }
    pub fn preview_nonce(&self) -> String {
        self.capability.clone()
    }
    pub fn push(&self, data: &[u8], time: i64, key: bool) -> bool {
        while time as i128 - self.clock.elapsed().as_micros() as i128 > 2_000_000 {
            if self.stop.load(Ordering::Acquire) {
                return false;
            }
            thread::sleep(Duration::from_millis(20));
        }
        self.preview
            .as_ref()
            .is_some_and(|p| p.push(self.generation, data, time, key, &self.stop))
    }
}
impl Drop for Running {
    fn drop(&mut self) {
        self.cancel();
    }
}
