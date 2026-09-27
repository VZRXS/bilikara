//! LAN Remote address discovery.
//!
//! Platform collectors read interface and routing tables from the local OS;
//! [`policy`] classifies and orders those facts without further I/O.

#[cfg(any(target_vendor = "apple", test))]
mod apple;
#[cfg(any(target_os = "linux", target_os = "android"))]
mod linux;
mod policy;
#[cfg(unix)]
mod posix;
#[cfg(any(windows, test))]
mod windows;

pub use policy::rank_lan_ipv4_candidates;

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::net::{IpAddr, Ipv4Addr, UdpSocket};

const ROUTE_TARGETS: [(&str, u16); 3] = [("1.1.1.1", 80), ("8.8.8.8", 80), ("9.9.9.9", 80)];

/// One IPv4 address and what the OS reports about its interface. FFI callers
/// may send only the original fields; collectors also fill the optional facts.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct InterfaceAddress {
    pub name: String,
    pub address: String,
    #[serde(default)]
    pub is_up: Option<bool>,
    #[serde(default)]
    pub has_default_route: bool,
    /// `unknown`, `ethernet`, `wifi`, `physical`, `hotspot`, `virtual`,
    /// `tunnel`, `container`, `bluetooth`, `cellular` or `loopback`.
    #[serde(default = "unknown_interface_type")]
    pub interface_type: String,
    #[serde(default)]
    pub description: String,
    /// Whether the OS reports a hardware-backed link; `None` when unknown.
    #[serde(default)]
    pub hardware: Option<bool>,
    /// Preference among default routes; lower is preferred.
    #[serde(default)]
    pub route_metric: Option<u32>,
}

impl Default for InterfaceAddress {
    fn default() -> Self {
        Self {
            name: String::new(),
            address: String::new(),
            is_up: None,
            has_default_route: false,
            interface_type: unknown_interface_type(),
            description: String::new(),
            hardware: None,
            route_metric: None,
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NetworkAddressRequest {
    #[serde(default)]
    pub platform_name: String,
    #[serde(default)]
    pub candidates: Option<Vec<InterfaceAddress>>,
    #[serde(default)]
    pub route_sources: Option<Vec<String>>,
}

#[derive(Clone, Debug, Serialize)]
pub struct NetworkAddressResult {
    pub addresses: Vec<String>,
}

fn unknown_interface_type() -> String {
    "unknown".to_owned()
}

/// Ranked addresses for the legacy Python Host adapter. Omitted route sources
/// keep its UDP route lookup, which selects a local address without sending.
pub fn detect_lan_ipv4_addresses(request: &NetworkAddressRequest) -> NetworkAddressResult {
    let platform = normalized_platform(&request.platform_name);
    let route_sources = request
        .route_sources
        .clone()
        .unwrap_or_else(route_selected_ipv4s);
    let mut candidates = request.candidates.clone().unwrap_or_else(local_interfaces);
    let known: HashSet<String> = candidates.iter().map(|item| item.address.clone()).collect();
    for address in &route_sources {
        if !known.contains(address) {
            candidates.push(InterfaceAddress {
                name: "route-selected".to_owned(),
                address: address.clone(),
                is_up: Some(true),
                has_default_route: true,
                ..InterfaceAddress::default()
            });
        }
    }
    NetworkAddressResult {
        addresses: rank_lan_ipv4_candidates(&candidates, &route_sources, &platform),
    }
}

/// Local transport addresses include secondary adapters even when they are not
/// preferred for QR display. This list never includes arbitrary remote hosts.
#[cfg(feature = "native-host")]
pub(crate) fn local_transport_addresses() -> Vec<std::net::IpAddr> {
    local_interfaces()
        .into_iter()
        .filter(|interface| interface.is_up != Some(false))
        .filter_map(|interface| interface.address.parse().ok())
        .collect()
}

/// Current LAN Remote addresses from local interface and routing tables only.
pub fn local_lan_ipv4_addresses() -> Vec<String> {
    rank_lan_ipv4_candidates(&local_interfaces(), &[], &normalized_platform(""))
}

#[cfg(windows)]
fn local_interfaces() -> Vec<InterfaceAddress> {
    windows::interfaces()
}

#[cfg(unix)]
fn local_interfaces() -> Vec<InterfaceAddress> {
    posix::interfaces()
}

#[cfg(not(any(windows, unix)))]
fn local_interfaces() -> Vec<InterfaceAddress> {
    Vec::new()
}

fn route_selected_ipv4s() -> Vec<String> {
    let mut selected = Vec::new();
    for target in ROUTE_TARGETS {
        let Ok(socket) = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)) else {
            continue;
        };
        if socket.connect(target).is_err() {
            continue;
        }
        let Ok(local) = socket.local_addr() else {
            continue;
        };
        let IpAddr::V4(address) = local.ip() else {
            continue;
        };
        let address = address.to_string();
        if policy::valid_ipv4(&address).is_some() && !selected.contains(&address) {
            selected.push(address);
        }
    }
    selected
}

fn normalized_platform(requested: &str) -> String {
    if !requested.trim().is_empty() {
        return requested.trim().to_lowercase();
    }
    let current = if cfg!(target_os = "windows") {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "ios") {
        "ios"
    } else if cfg!(target_os = "android") {
        "android"
    } else {
        "linux"
    };
    current.to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    #[cfg(any(target_os = "linux", target_os = "macos", windows))]
    use std::process::Command;

    fn candidate(name: &str, address: &str, kind: &str) -> InterfaceAddress {
        InterfaceAddress {
            name: name.to_owned(),
            address: address.to_owned(),
            is_up: Some(true),
            interface_type: kind.to_owned(),
            ..InterfaceAddress::default()
        }
    }

    #[test]
    fn route_selected_physical_address_beats_virtual_links() {
        let values = vec![
            candidate("vEthernet (WSL)", "172.28.32.1", "virtual"),
            candidate("Wi-Fi", "192.168.31.8", "physical"),
        ];
        assert_eq!(
            rank_lan_ipv4_candidates(&values, &["192.168.31.8".to_owned()], "win32"),
            vec!["192.168.31.8"]
        );
    }

    #[test]
    fn tunnel_is_a_last_resort() {
        let values = vec![candidate("tun0", "10.8.0.2", "tunnel")];
        assert_eq!(
            rank_lan_ipv4_candidates(&values, &["10.8.0.2".to_owned()], "linux"),
            vec!["10.8.0.2"]
        );
    }

    #[test]
    fn windows_virtual_only_service_returns_last_resort() {
        let result = detect_lan_ipv4_addresses(&NetworkAddressRequest {
            platform_name: "win32".to_owned(),
            candidates: Some(vec![candidate("vEthernet (WSL)", "172.28.32.1", "virtual")]),
            route_sources: Some(vec!["172.28.32.1".to_owned()]),
        });
        assert_eq!(result.addresses, vec!["172.28.32.1"]);
    }

    #[test]
    fn windows_proxy_adapters_do_not_beat_physical_lan() {
        let values = vec![
            candidate("singbox_tun", "172.19.0.1", "unknown"),
            candidate("Ethernet", "192.168.50.20", "physical"),
        ];
        assert_eq!(
            rank_lan_ipv4_candidates(&values, &["172.19.0.1".to_owned()], "win32"),
            vec!["192.168.50.20"]
        );
    }

    #[test]
    fn wire_requests_accept_original_and_additive_interface_facts() {
        let request: NetworkAddressRequest = serde_json::from_value(serde_json::json!({
            "platform_name": "win32",
            "candidates": [
                {"name": "Ethernet 2", "address": "10.8.0.2", "is_up": true},
                {
                    "name": "WLAN",
                    "address": "172.20.10.2",
                    "is_up": true,
                    "has_default_route": true,
                    "interface_type": "wifi",
                    "description": "Intel(R) Wi-Fi 6 AX201 160MHz",
                    "hardware": true,
                    "route_metric": 35
                }
            ],
            "route_sources": []
        }))
        .unwrap();
        assert_eq!(
            detect_lan_ipv4_addresses(&request).addresses,
            vec!["172.20.10.2", "10.8.0.2"]
        );
        let unknown = serde_json::from_value::<NetworkAddressRequest>(serde_json::json!({
            "candidates": [{"name": "WLAN", "address": "172.20.10.2", "mac": "00:15:5d:00:00:01"}]
        }));
        assert!(unknown.is_err(), "unknown interface facts stay rejected");
    }

    // The live tests below read this machine's real interface and routing
    // tables. On CI the independent OS tool must succeed, so a missing route
    // fails instead of silently validating nothing.
    #[cfg(any(target_os = "linux", target_os = "macos", windows))]
    fn required_on_ci() -> bool {
        std::env::var_os("CI").is_some()
    }

    #[cfg(any(target_os = "linux", target_os = "macos", windows))]
    fn command_output(program: &str, args: &[&str]) -> Option<String> {
        let output = Command::new(program).args(args).output().ok()?;
        output
            .status
            .success()
            .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
    }

    #[test]
    fn live_interfaces_classify_loopback_and_rank_only_local_addresses() {
        let interfaces = local_interfaces();
        assert!(
            interfaces
                .iter()
                .any(|item| item.interface_type == "loopback" && item.address.starts_with("127.")),
            "{interfaces:#?}"
        );
        for item in &interfaces {
            assert!(item.address.parse::<Ipv4Addr>().is_ok(), "{item:?}");
            assert!(!item.name.is_empty(), "{item:?}");
        }
        let known: HashSet<&str> = interfaces
            .iter()
            .map(|item| item.address.as_str())
            .collect();
        let ranked = local_lan_ipv4_addresses();
        let unique: HashSet<&String> = ranked.iter().collect();
        assert_eq!(unique.len(), ranked.len(), "{ranked:?}");
        for address in &ranked {
            assert!(
                known.contains(address.as_str()),
                "{address} not in {known:?}"
            );
            assert!(!address.starts_with("127."), "{ranked:?}");
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn live_linux_default_route_matches_iproute2() {
        let Some(output) = command_output("ip", &["-4", "route", "show", "default"]) else {
            assert!(
                !required_on_ci(),
                "`ip -4 route show default` must run on CI"
            );
            return;
        };
        let devices: HashSet<&str> = output
            .lines()
            .filter_map(|line| {
                let mut words = line.split_whitespace();
                words.find(|word| *word == "dev")?;
                words.next()
            })
            .collect();
        assert!(!required_on_ci() || !devices.is_empty(), "{output}");
        let interfaces = local_interfaces();
        for device in devices {
            for item in interfaces.iter().filter(|item| item.name == device) {
                assert!(item.has_default_route, "{item:?} in {output}");
                assert!(item.route_metric.is_some(), "{item:?}");
            }
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn live_macos_primary_default_route_matches_route_get() {
        let Some(output) = command_output("route", &["-n", "get", "default"]) else {
            assert!(!required_on_ci(), "`route -n get default` must run on CI");
            return;
        };
        let device = output
            .lines()
            .find_map(|line| line.trim().strip_prefix("interface:"))
            .map(str::trim)
            .expect("route -n get default names an interface");
        let interfaces = local_interfaces();
        let primary: Vec<&InterfaceAddress> = interfaces
            .iter()
            .filter(|item| item.name == device)
            .collect();
        for item in &primary {
            assert!(item.has_default_route, "{item:?}");
            assert_eq!(item.route_metric, Some(0), "{item:?}");
        }
        assert!(
            !required_on_ci() || !primary.is_empty(),
            "{device}: {interfaces:#?}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn live_windows_gateways_match_net_ip_configuration() {
        let script = "Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway } | \
                      ForEach-Object { $_.InterfaceAlias }";
        let Some(output) = command_output("powershell", &["-NoProfile", "-Command", script]) else {
            assert!(!required_on_ci(), "Get-NetIPConfiguration must run on CI");
            return;
        };
        let aliases: HashSet<&str> = output
            .lines()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .collect();
        assert!(!required_on_ci() || !aliases.is_empty(), "{output}");
        let interfaces = local_interfaces();
        for alias in &aliases {
            let matching: Vec<&InterfaceAddress> = interfaces
                .iter()
                .filter(|item| item.name == *alias)
                .collect();
            assert!(!matching.is_empty(), "{alias}: {interfaces:#?}");
            for item in matching {
                assert!(item.has_default_route, "{item:?}");
                assert!(item.route_metric.is_some(), "{item:?}");
                assert!(item.hardware.is_some(), "{item:?}");
            }
        }
        // Get-NetIPConfiguration omits hidden and disconnected adapters.
        let connected_hardware = |item: &&InterfaceAddress| {
            item.has_default_route && item.is_up == Some(true) && item.hardware == Some(true)
        };
        for item in interfaces.iter().filter(connected_hardware) {
            assert!(
                aliases.contains(item.name.as_str()),
                "{item:?} not in {aliases:?}"
            );
        }
    }
}
