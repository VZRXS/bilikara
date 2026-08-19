use if_addrs::get_if_addrs;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr, UdpSocket};

const ROUTE_TARGETS: [(&str, u16); 3] = [("1.1.1.1", 80), ("8.8.8.8", 80), ("9.9.9.9", 80)];
const MACOS_VIRTUAL_PREFIXES: [&str; 11] = [
    "lo", "utun", "bridge", "awdl", "llw", "ap", "gif", "stf", "p2p", "vmnet", "vnic",
];
const LINUX_VIRTUAL_PREFIXES: [&str; 14] = [
    "lo",
    "docker",
    "veth",
    "virbr",
    "br-",
    "tun",
    "tap",
    "wg",
    "tailscale",
    "zt",
    "cni",
    "flannel",
    "kube",
    "podman",
];
const WINDOWS_VIRTUAL_KEYWORDS: [&str; 28] = [
    "hyper-v",
    "vethernet",
    "vmware",
    "virtualbox",
    "wsl",
    "docker",
    "tailscale",
    "zerotier",
    "singbox",
    "sing-box",
    "singbox_tun",
    "sing-tun",
    "mihomo",
    "meta",
    "clash",
    "v2rayn",
    "nekoray",
    "hiddify",
    "tun2socks",
    "vpn",
    "tunnel",
    "wintun",
    "loopback",
    "bluetooth",
    "vmess",
    "vless",
    "trojan",
    "shadowsocks",
];

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct InterfaceAddress {
    pub name: String,
    pub address: String,
    #[serde(default)]
    pub is_up: Option<bool>,
    #[serde(default)]
    pub has_default_route: bool,
    #[serde(default = "unknown_interface_type")]
    pub interface_type: String,
    #[serde(default)]
    pub description: String,
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

pub fn detect_lan_ipv4_addresses(request: &NetworkAddressRequest) -> NetworkAddressResult {
    let platform = normalized_platform(&request.platform_name);
    let route_sources = request
        .route_sources
        .clone()
        .unwrap_or_else(route_selected_ipv4s);
    let mut candidates = request
        .candidates
        .clone()
        .unwrap_or_else(enumerate_interfaces);
    let known: HashSet<String> = candidates.iter().map(|item| item.address.clone()).collect();
    for address in &route_sources {
        if !known.contains(address) {
            candidates.push(InterfaceAddress {
                name: "route-selected".to_owned(),
                address: address.clone(),
                is_up: Some(true),
                has_default_route: true,
                interface_type: "unknown".to_owned(),
                description: String::new(),
            });
        }
    }
    NetworkAddressResult {
        addresses: rank_lan_ipv4_candidates(&candidates, &route_sources, &platform),
    }
}

pub fn rank_lan_ipv4_candidates(
    candidates: &[InterfaceAddress],
    route_sources: &[String],
    platform: &str,
) -> Vec<String> {
    let route_set: HashSet<Ipv4Addr> = route_sources
        .iter()
        .filter_map(|value| valid_ipv4(value))
        .collect();
    let mut unique: HashMap<Ipv4Addr, InterfaceAddress> = HashMap::new();
    for candidate in candidates {
        let Some(address) = valid_ipv4(&candidate.address) else {
            continue;
        };
        let should_replace = unique
            .get(&address)
            .is_some_and(|current| candidate.is_up == Some(true) && current.is_up != Some(true));
        if should_replace || !unique.contains_key(&address) {
            let mut normalized = candidate.clone();
            normalized.address = address.to_string();
            unique.insert(address, normalized);
        }
    }
    let mut values: Vec<(Ipv4Addr, InterfaceAddress)> = unique
        .into_iter()
        .filter(|(_, candidate)| candidate.is_up != Some(false))
        .collect();
    if values.iter().any(|(address, _)| !address.is_link_local()) {
        values.retain(|(address, _)| !address.is_link_local());
    }
    values.sort_by(|(left_address, left), (right_address, right)| {
        interface_score(right, right_address, &route_set, platform)
            .cmp(&interface_score(left, left_address, &route_set, platform))
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
            .then_with(|| u32::from(*left_address).cmp(&u32::from(*right_address)))
    });
    let Some((_, recommended)) = values.first() else {
        return Vec::new();
    };
    let physical: Vec<&InterfaceAddress> = values
        .iter()
        .map(|(_, candidate)| candidate)
        .filter(|candidate| !is_virtual_interface(candidate, platform))
        .collect();
    let visible: Vec<&InterfaceAddress> = if physical.is_empty() {
        vec![recommended]
    } else if is_virtual_interface(recommended, platform) {
        std::iter::once(recommended).chain(physical).collect()
    } else {
        physical
    };
    let mut seen = HashSet::new();
    visible
        .into_iter()
        .filter(|candidate| seen.insert(candidate.address.clone()))
        .map(|candidate| candidate.address.clone())
        .collect()
}

fn enumerate_interfaces() -> Vec<InterfaceAddress> {
    get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|interface| match interface.addr.ip() {
            IpAddr::V4(address) => Some(InterfaceAddress {
                name: interface.name,
                address: address.to_string(),
                is_up: Some(true),
                has_default_route: false,
                interface_type: "unknown".to_owned(),
                description: String::new(),
            }),
            IpAddr::V6(_) => None,
        })
        .collect()
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
        if valid_ipv4(&address.to_string()).is_some() && !selected.contains(&address.to_string()) {
            selected.push(address.to_string());
        }
    }
    selected
}

fn valid_ipv4(value: &str) -> Option<Ipv4Addr> {
    let address: Ipv4Addr = value.trim().parse().ok()?;
    (!address.is_loopback() && !address.is_unspecified() && !address.is_multicast())
        .then_some(address)
}

fn normalized_platform(requested: &str) -> String {
    if !requested.trim().is_empty() {
        return requested.trim().to_lowercase();
    }
    if cfg!(target_os = "windows") {
        "win32".to_owned()
    } else if cfg!(target_os = "macos") {
        "darwin".to_owned()
    } else {
        "linux".to_owned()
    }
}

fn is_virtual_interface(candidate: &InterfaceAddress, platform: &str) -> bool {
    let name = candidate.name.to_lowercase();
    let description = candidate.description.to_lowercase();
    let interface_type = candidate.interface_type.to_lowercase();
    if ["virtual", "tunnel", "loopback", "container"].contains(&interface_type.as_str()) {
        return true;
    }
    if platform == "darwin" {
        return MACOS_VIRTUAL_PREFIXES
            .iter()
            .any(|prefix| name.starts_with(prefix));
    }
    if platform.starts_with("linux") {
        return LINUX_VIRTUAL_PREFIXES
            .iter()
            .any(|prefix| name.starts_with(prefix));
    }
    if platform.starts_with("win") {
        let labels = format!("{name} {description}");
        return WINDOWS_VIRTUAL_KEYWORDS
            .iter()
            .any(|keyword| labels.contains(keyword));
    }
    false
}

fn interface_score(
    candidate: &InterfaceAddress,
    address: &Ipv4Addr,
    route_sources: &HashSet<Ipv4Addr>,
    platform: &str,
) -> i32 {
    let mut score = 0;
    if route_sources.contains(address) {
        score += 10_000;
    }
    if candidate.has_default_route {
        score += 1_500;
    }
    match candidate.is_up {
        Some(true) => score += 500,
        Some(false) => score -= 4_000,
        None => {}
    }
    score += if address.is_private() { 600 } else { 150 };
    if address.is_link_local() {
        score -= 2_500;
    }
    score += if is_virtual_interface(candidate, platform) {
        -12_000
    } else {
        800
    };
    let name = candidate.name.to_lowercase();
    let preferred_native_name = (platform == "darwin" && name.starts_with("en"))
        || (platform.starts_with("linux")
            && ["eth", "en", "wlan", "wl"]
                .iter()
                .any(|prefix| name.starts_with(prefix)));
    if preferred_native_name {
        score += 500;
    }
    if ["ethernet", "wifi", "physical"].contains(&candidate.interface_type.to_lowercase().as_str())
    {
        score += 500;
    }
    score
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(name: &str, address: &str, kind: &str) -> InterfaceAddress {
        InterfaceAddress {
            name: name.to_owned(),
            address: address.to_owned(),
            is_up: Some(true),
            has_default_route: false,
            interface_type: kind.to_owned(),
            description: String::new(),
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
}
