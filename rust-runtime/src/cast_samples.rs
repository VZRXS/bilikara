//! Optional trusted platform I/O for packaged self-test data, separate from cast
//! network leases and application state. Never configured by HTTP or JavaScript.
use crate::dlna::diagnostics::SkipReason;
use std::{
    path::PathBuf,
    sync::{Arc, OnceLock},
};

pub trait SamplePlatform: Send + Sync {
    fn root(&self) -> PathBuf;
    fn prepare(&self) -> Result<(), SkipReason>;
    fn cleanup(&self);
}
static PLATFORM: OnceLock<Arc<dyn SamplePlatform>> = OnceLock::new();
pub fn configure(platform: Arc<dyn SamplePlatform>) {
    let _ = PLATFORM.set(platform);
}
pub(crate) fn root() -> Option<PathBuf> {
    PLATFORM.get().map(|p| p.root())
}
pub(crate) struct SampleLease(Arc<dyn SamplePlatform>);
impl Drop for SampleLease {
    fn drop(&mut self) {
        self.0.cleanup();
    }
}
pub(crate) fn acquire() -> Result<Option<SampleLease>, SkipReason> {
    let Some(platform) = PLATFORM.get() else {
        return if cfg!(target_os = "android") {
            Err(SkipReason::PlatformUnavailable)
        } else {
            Ok(None)
        };
    };
    acquire_platform(platform.clone()).map(Some)
}
fn acquire_platform(platform: Arc<dyn SamplePlatform>) -> Result<SampleLease, SkipReason> {
    let lease = SampleLease(platform);
    lease.0.prepare()?;
    Ok(lease)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    struct Platform {
        failure: Option<SkipReason>,
        cleaned: AtomicUsize,
    }
    impl SamplePlatform for Platform {
        fn root(&self) -> PathBuf {
            "private-cache/cast-samples".into()
        }
        fn prepare(&self) -> Result<(), SkipReason> {
            self.failure.map_or(Ok(()), Err)
        }
        fn cleanup(&self) {
            self.cleaned.fetch_add(1, Ordering::SeqCst);
        }
    }
    #[test]
    fn sample_lease_cleans_on_completion_cancellation_and_prepare_failure() {
        for failure in [
            None,
            Some(SkipReason::SampleStorageInsufficient),
            Some(SkipReason::PlatformUnavailable),
            Some(SkipReason::SampleCopyFailed),
        ] {
            let platform = Arc::new(Platform {
                failure,
                cleaned: AtomicUsize::new(0),
            });
            let result = acquire_platform(platform.clone());
            if let Some(reason) = failure {
                assert!(matches!(result, Err(actual) if actual == reason));
                assert_eq!(platform.cleaned.load(Ordering::SeqCst), 1);
            } else {
                assert_eq!(platform.cleaned.load(Ordering::SeqCst), 0);
                drop(result); // Also the path taken when the async runner is cancelled/dropped.
                assert_eq!(platform.cleaned.load(Ordering::SeqCst), 1);
            }
        }
    }
}
