//! Native resource adapters, never a second playback authority. IDs fence late
//! platform callbacks and RAII releases resources even when an async scan drops.
use serde::{Deserialize, Serialize};
use std::sync::{
    Arc, OnceLock,
    atomic::{AtomicU64, Ordering},
};

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
impl NetworkFacts {
    pub fn network_hint(&self) -> Option<NetworkHint> {
        if self.default_network == DefaultNetwork::Cellular
            && self.wifi_connected == Some(true)
            && self.wifi_validated == Some(false)
        {
            Some(NetworkHint::CellularDefault)
        } else if self.vpn_active == Some(true) {
            Some(NetworkHint::VpnActive)
        } else if self.wifi_validated == Some(false) && self.wifi_connected == Some(true) {
            Some(NetworkHint::WifiUnvalidated)
        } else if self.multicast_acquired == Some(false) {
            Some(NetworkHint::MulticastUnavailable)
        } else if self.battery_optimization_ignored == Some(false) {
            Some(NetworkHint::BatteryRestricted)
        } else {
            None
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlatformError {
    Unavailable,
    ForegroundRequired,
    AlreadyInstalled,
}
impl PlatformError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Unavailable => "cast_platform_unavailable",
            Self::ForegroundRequired => "cast_platform_foreground_required",
            Self::AlreadyInstalled => "cast_platform_already_installed",
        }
    }
}

/// Implementations must bound calls, release synchronously, and never call
/// AppState synchronously from these methods (admission holds its lock).
pub trait CastPlatform: Send + Sync {
    fn discovery_begin(&self, lease_id: u64) -> bool;
    fn discovery_end(&self, lease_id: u64);
    fn output_active(&self, lease_id: u64, active: bool) -> Result<(), PlatformError>;
    /// Same Android operation codes: stopped=0, paused=1, playing=2.
    fn output_mode(&self, lease_id: u64, mode: i32) -> Result<(), PlatformError> {
        self.output_active(lease_id, mode != 0)
    }
    fn network_facts(&self) -> NetworkFacts;
}

type Installed = Result<Arc<dyn CastPlatform>, InitializationFailure>;
static PLATFORM: OnceLock<Installed> = OnceLock::new();
static NEXT_LEASE: AtomicU64 = AtomicU64::new(1);

pub fn install(platform: Arc<dyn CastPlatform>) -> Result<(), PlatformError> {
    with_registry(|slot| install_into(slot, platform))
}
fn install_into(
    slot: &OnceLock<Installed>,
    platform: Arc<dyn CastPlatform>,
) -> Result<(), PlatformError> {
    slot.set(Ok(platform))
        .map_err(|_| PlatformError::AlreadyInstalled)
}

fn with_registry<T>(action: impl FnOnce(&OnceLock<Installed>) -> T) -> T {
    #[cfg(test)]
    if let Some(slot) = test_support::registry() {
        return action(&slot);
    }
    action(&PLATFORM)
}

fn installed() -> Option<Installed> {
    with_registry(|slot| slot.get().cloned())
}

/// Cast is optional. Publish success OR failure once, then continue Host startup.
/// The JNI callback only returns its candidate; a late reply cannot install it.
pub fn initialize_optional(initialize: impl FnOnce() -> Installed) {
    let result = initialize();
    if result.is_err() {
        eprintln!("cast_platform_unavailable");
    }
    with_registry(|slot| {
        if slot.set(result).is_err() {
            eprintln!("cast_platform_already_installed");
        }
    });
}

pub fn initialization_failure() -> Option<InitializationFailure> {
    match installed() {
        Some(Err(reason)) => Some(reason),
        None if cfg!(target_os = "android") => Some(InitializationFailure::NotInitialized),
        _ => None,
    }
}

pub fn network_facts() -> NetworkFacts {
    match installed() {
        Some(Ok(platform)) => platform.network_facts(),
        _ => NetworkFacts {
            platform_unavailable_reason: initialization_failure(),
            ..Default::default()
        },
    }
}

pub struct DiscoveryLease {
    platform: Option<Arc<dyn CastPlatform>>,
    id: u64,
    pub acquired: Option<bool>,
}
impl DiscoveryLease {
    pub fn acquire() -> Self {
        Self::with_platform(installed().and_then(Result::ok))
    }
    fn with_platform(platform: Option<Arc<dyn CastPlatform>>) -> Self {
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

pub struct OutputLease {
    platform: Option<Arc<dyn CastPlatform>>,
    id: u64,
}
impl OutputLease {
    pub fn acquire() -> Result<Self, PlatformError> {
        if initialization_failure().is_some() {
            return Err(PlatformError::Unavailable);
        }
        Self::with_platform(installed().and_then(Result::ok))
    }
    fn with_platform(platform: Option<Arc<dyn CastPlatform>>) -> Result<Self, PlatformError> {
        let id = NEXT_LEASE.fetch_add(1, Ordering::Relaxed);
        if let Some(p) = &platform
            && let Err(error) = p.output_active(id, true)
        {
            let _ = p.output_active(id, false);
            return Err(error);
        }
        Ok(Self { platform, id })
    }
    pub fn set_paused(&self, paused: bool) -> Result<(), PlatformError> {
        if let Some(platform) = &self.platform {
            platform.output_mode(self.id, if paused { 1 } else { 2 })?;
        }
        Ok(())
    }
    pub fn id(&self) -> u64 {
        self.id
    }
}
impl Drop for OutputLease {
    fn drop(&mut self) {
        if let Some(platform) = &self.platform {
            let _ = platform.output_active(self.id, false);
        }
    }
}

#[cfg(test)]
pub(crate) mod test_support;
#[cfg(test)]
mod tests;
