//! Discovery resource hooks extracted from bilikara R2 A3 (b49e1ae).
//! Platform implementations and output resources are integrated separately.
//! IDs fence late callbacks; RAII releases resources when an async scan drops.
use std::sync::{
    Arc, OnceLock,
    atomic::{AtomicU64, Ordering},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlatformError {
    AlreadyInstalled,
}

/// Implementations must bound calls and release synchronously. Discovery owns
/// this lease for the entire scan, including cancellation and failed setup.
pub trait CastPlatform: Send + Sync {
    fn discovery_begin(&self, lease_id: u64) -> bool;
    fn discovery_end(&self, lease_id: u64);
}

type Installed = Arc<dyn CastPlatform>;
static PLATFORM: OnceLock<Installed> = OnceLock::new();
static NEXT_LEASE: AtomicU64 = AtomicU64::new(1);

pub fn install(platform: Arc<dyn CastPlatform>) -> Result<(), PlatformError> {
    with_registry(|slot| {
        slot.set(platform)
            .map_err(|_| PlatformError::AlreadyInstalled)
    })
}

fn with_registry<T>(action: impl FnOnce(&OnceLock<Installed>) -> T) -> T {
    #[cfg(test)]
    if let Some(slot) = test_support::registry() {
        return action(&slot);
    }
    action(&PLATFORM)
}

pub struct DiscoveryLease {
    platform: Option<Arc<dyn CastPlatform>>,
    id: u64,
    pub acquired: Option<bool>,
}
impl DiscoveryLease {
    pub fn acquire() -> Self {
        let platform = with_registry(|slot| slot.get().cloned());
        let id = NEXT_LEASE.fetch_add(1, Ordering::Relaxed);
        let acquired = platform.as_ref().map(|p| p.discovery_begin(id));
        Self {
            platform,
            id,
            acquired,
        }
    }
}
impl Drop for DiscoveryLease {
    fn drop(&mut self) {
        // Also close a failed acquisition: adapters may have partially acquired.
        if let Some(platform) = &self.platform {
            platform.discovery_end(self.id);
        }
    }
}

#[cfg(test)]
pub(crate) mod test_support;
