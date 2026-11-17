use super::*;
use std::{collections::BTreeSet, sync::Mutex};

#[derive(Default)]
struct Fake {
    discoveries: Mutex<BTreeSet<u64>>,
    outputs: Mutex<Vec<(u64, bool)>>,
    reject: bool,
}
impl CastPlatform for Fake {
    fn discovery_begin(&self, id: u64) -> bool {
        self.discoveries.lock().unwrap().insert(id);
        !self.reject
    }
    fn discovery_end(&self, id: u64) {
        self.discoveries.lock().unwrap().remove(&id);
    }
    fn output_active(&self, id: u64, active: bool) -> Result<(), PlatformError> {
        self.outputs.lock().unwrap().push((id, active));
        if active && self.reject {
            Err(PlatformError::ForegroundRequired)
        } else {
            Ok(())
        }
    }
    fn network_facts(&self) -> NetworkFacts {
        NetworkFacts::default()
    }
}

#[test]
fn discovery_leases_overlap_and_release_on_error_and_future_drop() {
    let fake = Arc::new(Fake::default());
    let first = DiscoveryLease::with_platform(Some(fake.clone()));
    let second = DiscoveryLease::with_platform(Some(fake.clone()));
    assert_eq!(fake.discoveries.lock().unwrap().len(), 2);
    drop(first);
    assert_eq!(fake.discoveries.lock().unwrap().len(), 1);
    drop(second);
    assert!(fake.discoveries.lock().unwrap().is_empty());
    fn fail(fake: Arc<Fake>) -> Result<(), ()> {
        let _lease = DiscoveryLease::with_platform(Some(fake));
        Err(())
    }
    assert!(fail(fake.clone()).is_err());
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        let (started, ready) = tokio::sync::oneshot::channel();
        let hook = fake.clone();
        let task = tokio::spawn(async move {
            let _lease = DiscoveryLease::with_platform(Some(hook));
            let _ = started.send(());
            std::future::pending::<()>().await;
        });
        ready.await.unwrap();
        let since = std::time::Instant::now();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert!(since.elapsed() < std::time::Duration::from_secs(1));
    });
    assert!(fake.discoveries.lock().unwrap().is_empty());
}

#[test]
fn failed_multicast_is_best_effort_and_partial_acquisition_is_released() {
    let fake = Arc::new(Fake {
        reject: true,
        ..Default::default()
    });
    let lease = DiscoveryLease::with_platform(Some(fake.clone()));
    assert_eq!(lease.acquired, Some(false));
    drop(lease);
    assert!(fake.discoveries.lock().unwrap().is_empty());
}

#[test]
fn foreground_rejection_rolls_back_and_output_lives_through_handoff() {
    let rejected = Arc::new(Fake {
        reject: true,
        ..Default::default()
    });
    assert!(matches!(
        OutputLease::with_platform(Some(rejected.clone())),
        Err(PlatformError::ForegroundRequired)
    ));
    let events = rejected.outputs.lock().unwrap();
    assert_eq!(events.len(), 2);
    assert_eq!(events[0], (events[1].0, true));
    assert!(!events[1].1);
    let fake = Arc::new(Fake::default());
    let lease = OutputLease::with_platform(Some(fake.clone())).unwrap();
    let id = lease.id();
    fn handoff(lease: OutputLease) -> OutputLease {
        lease
    }
    let handoff = handoff(lease);
    assert_eq!(*fake.outputs.lock().unwrap(), vec![(id, true)]);
    drop(handoff);
    assert_eq!(*fake.outputs.lock().unwrap(), vec![(id, true), (id, false)]);
}

#[test]
fn install_is_once_and_unknown_facts_do_not_make_up_a_warning() {
    let slot = OnceLock::new();
    assert_eq!(install_into(&slot, Arc::new(Fake::default())), Ok(()));
    assert_eq!(
        install_into(&slot, Arc::new(Fake::default())),
        Err(PlatformError::AlreadyInstalled)
    );
    assert_eq!(NetworkFacts::default().network_hint(), None);
}

#[test]
fn network_hints_prioritize_cellular_route_and_wire_rejects_private_fields() {
    let mut facts = NetworkFacts {
        default_network: DefaultNetwork::Cellular,
        wifi_connected: Some(true),
        wifi_validated: Some(false),
        vpn_active: Some(true),
        multicast_acquired: Some(false),
        battery_optimization_ignored: Some(false),
        ..Default::default()
    };
    assert_eq!(facts.network_hint(), Some(NetworkHint::CellularDefault));
    facts.default_network = DefaultNetwork::Wifi;
    assert_eq!(facts.network_hint(), Some(NetworkHint::VpnActive));
    facts.vpn_active = Some(false);
    assert_eq!(facts.network_hint(), Some(NetworkHint::WifiUnvalidated));
    facts.wifi_validated = Some(true);
    assert_eq!(
        facts.network_hint(),
        Some(NetworkHint::MulticastUnavailable)
    );
    facts.multicast_acquired = Some(true);
    assert_eq!(facts.network_hint(), Some(NetworkHint::BatteryRestricted));
    facts.battery_optimization_ignored = Some(true);
    assert_eq!(facts.network_hint(), None);
    let json = serde_json::to_value(&facts).unwrap();
    assert_eq!(
        serde_json::from_value::<NetworkFacts>(json.clone()).unwrap(),
        facts
    );
    for key in ["ssid", "ip", "network_handle", "exception"] {
        let mut injected = json.clone();
        injected[key] = "sensitive".into();
        assert!(serde_json::from_value::<NetworkFacts>(injected).is_err());
    }
    let mut injected = json;
    injected["default_network"] = "192.168.1.1".into();
    assert!(serde_json::from_value::<NetworkFacts>(injected).is_err());
}
