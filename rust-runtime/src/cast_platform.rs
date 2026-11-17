//! Discovery resource hooks extracted from bilikara R2 A3 (b49e1ae).
//! Platform implementations and output resources are integrated separately.
//! IDs fence late callbacks; RAII releases resources when an async scan drops.
use serde::{Deserialize, Serialize};
use std::sync::{
    Arc, OnceLock,
    atomic::{AtomicU64, Ordering},
};

// R2 A3 closed diagnostic DTOs from b49e1ae; P7 adds platform collection.
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DefaultNetwork {
    #[default]
    Unknown,
    None,
    Wifi,
    Cellular,
    Ethernet,
    Vpn,
    Other,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WifiLockMode {
    HighPerf,
    LowLatency,
}

/// Closed categories only: no addresses, SSIDs, network handles or error text.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct NetworkFacts {
    pub platform_unavailable_reason: Option<InitializationFailure>,
    pub default_network: DefaultNetwork,
    pub wifi_connected: Option<bool>,
    pub wifi_validated: Option<bool>,
    pub vpn_active: Option<bool>,
    pub battery_optimization_ignored: Option<bool>,
    pub multicast_acquired: Option<bool>,
    pub wifi_lock_mode: Option<WifiLockMode>,
}

/// Closed startup categories; never retain JNI exceptions or platform paths.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InitializationFailure {
    InitializationFailed,
    InitializationTimedOut,
    NotInitialized,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NetworkHint {
    CellularDefault,
    WifiUnvalidated,
    VpnActive,
    MulticastUnavailable,
    BatteryRestricted,
}

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
