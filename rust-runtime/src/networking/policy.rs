//! Pure LAN Remote address policy over collected interface facts.
//!
//! Physical links are offered first, ordered by the default route. Virtual,
//! VPN, VM, container and Bluetooth links stay a single last resort as in
//! v0.7.2. Loopback and cellular addresses are never offered: other devices
//! on the LAN cannot reach them.

use super::InterfaceAddress;
use std::collections::{HashMap, HashSet};
use std::net::Ipv4Addr;

/// Windows adapters that host this PC's Mobile Hotspot.
pub(super) const WINDOWS_HOTSPOT_KEYWORDS: [&str; 2] = [
    "wi-fi direct virtual adapter",
    "hosted network virtual adapter",
];
/// Carrier links on Android, iOS and Linux modems, plus placeholder devices.
const CELLULAR_PREFIXES: [&str; 10] = [
    "rmnet", "r_rmnet", "v4-rmnet", "ccmni", "v4-ccmni", "seth_lte", "pdp", "wwan", "clat", "dummy",
];
const APPLE_VIRTUAL_PREFIXES: [&str; 22] = [
    "lo", "utun", "ipsec", "ppp", "gif", "stf", "bridge", "awdl", "llw", "ap", "p2p", "vmnet",
    "vmenet", "vnic", "feth", "zt", "tun", "tap", "anpi", "pktap", "xhc", "gpd",
];
const LINUX_VIRTUAL_PREFIXES: [&str; 23] = [
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
    "vboxnet",
    "vmnet",
    "lxcbr",
    "lxdbr",
    "incusbr",
    "nordlynx",
    "ppp",
    "ipsec",
    "p2p",
];
const WINDOWS_VIRTUAL_KEYWORDS: [&str; 51] = [
    "hyper-v",
    "vethernet",
    "vmware",
    "virtualbox",
    "vbox",
    "parallels",
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
    "wireguard",
    "openvpn",
    "tap-windows",
    "tap-win32",
    "anyconnect",
    "globalprotect",
    "pangp",
    "fortinet",
    "sangfor",
    "easyconnect",
    "hamachi",
    "radmin",
    "softether",
    "npcap",
    "km-test",
    "wan miniport",
    "loopback",
    "bluetooth",
    "vmess",
    "vless",
    "trojan",
    "shadowsocks",
    "virtual ethernet",
    "virtual adapter",
    "virtual miniport",
    "virtual port",
    "virtual network",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Role {
    /// A physical or hardware-backed LAN link.
    Lan,
    /// A network this device hosts: Windows Mobile Hotspot or iOS Personal Hotspot.
    Hotspot,
    /// Virtual, VPN, VM, container or Bluetooth link: offered only when nothing else is.
    Fallback,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Platform {
    Windows,
    MacOs,
    Ios,
    Linux,
    Android,
    Other,
}

impl Platform {
    fn parse(value: &str) -> Self {
        let value = value.trim().to_lowercase();
        if value.starts_with("win") {
            Self::Windows
        } else if value == "darwin" || value == "macos" {
            Self::MacOs
        } else if value == "ios" {
            Self::Ios
        } else if value == "android" {
            Self::Android
        } else if value.starts_with("linux") {
            Self::Linux
        } else {
            Self::Other
        }
    }
}

/// Ordering among offered links; derived `Ord` compares fields in order.
#[derive(PartialEq, Eq, PartialOrd, Ord)]
struct Rank {
    role: Role,
    not_route_source: bool,
    no_default_route: bool,
    route_metric: u32,
    not_known_up: bool,
    not_private: bool,
    unknown_medium: bool,
    generic_name: bool,
    name: String,
    address: u32,
}

pub(super) fn valid_ipv4(value: &str) -> Option<Ipv4Addr> {
    let address: Ipv4Addr = value.trim().parse().ok()?;
    (!address.is_loopback()
        && !address.is_unspecified()
        && !address.is_multicast()
        && !address.is_broadcast())
    .then_some(address)
}

pub fn rank_lan_ipv4_candidates(
    candidates: &[InterfaceAddress],
    route_sources: &[String],
    platform: &str,
) -> Vec<String> {
    let platform = Platform::parse(platform);
    let routes: HashSet<Ipv4Addr> = route_sources
        .iter()
        .filter_map(|value| valid_ipv4(value))
        .collect();
    // One entry per address; an interface reported up replaces an unknown one.
    let mut unique: Vec<(Ipv4Addr, &InterfaceAddress)> = Vec::new();
    let mut slots: HashMap<Ipv4Addr, usize> = HashMap::new();
    for candidate in candidates {
        let Some(address) = valid_ipv4(&candidate.address) else {
            continue;
        };
        if let Some(&slot) = slots.get(&address) {
            if candidate.is_up == Some(true) && unique[slot].1.is_up != Some(true) {
                unique[slot].1 = candidate;
            }
        } else {
            slots.insert(address, unique.len());
            unique.push((address, candidate));
        }
    }
    let mut offered: Vec<(Rank, Ipv4Addr)> = unique
        .into_iter()
        .filter_map(|(address, candidate)| {
            let role = role(candidate, address, platform)?;
            Some((rank(role, address, candidate, &routes, platform), address))
        })
        .collect();
    if offered.iter().any(|(_, address)| !address.is_link_local()) {
        offered.retain(|(_, address)| !address.is_link_local());
    }
    offered.sort();
    let reachable: Vec<String> = offered
        .iter()
        .filter(|(rank, _)| rank.role != Role::Fallback)
        .map(|(_, address)| address.to_string())
        .collect();
    if !reachable.is_empty() {
        return reachable;
    }
    offered
        .first()
        .map(|(_, address)| vec![address.to_string()])
        .unwrap_or_default()
}

fn role(candidate: &InterfaceAddress, address: Ipv4Addr, platform: Platform) -> Option<Role> {
    let kind = candidate.interface_type.trim().to_lowercase();
    let name = candidate.name.trim().to_lowercase();
    let labels = format!("{name} {}", candidate.description.to_lowercase());
    if candidate.is_up == Some(false)
        || kind == "loopback"
        || kind == "cellular"
        || CELLULAR_PREFIXES
            .iter()
            .any(|prefix| name.starts_with(prefix))
    {
        return None;
    }
    // A phone's non-private address belongs to its carrier, not to a LAN.
    if matches!(platform, Platform::Ios | Platform::Android) && !address.is_private() {
        return None;
    }
    let hosted = kind == "hotspot"
        || (platform == Platform::Windows
            && WINDOWS_HOTSPOT_KEYWORDS
                .iter()
                .any(|keyword| labels.contains(keyword)))
        || (platform == Platform::Ios && name.starts_with("bridge"));
    if hosted {
        return Some(Role::Hotspot);
    }
    if matches!(
        kind.as_str(),
        "virtual" | "tunnel" | "container" | "bluetooth"
    ) || named_virtual(&name, &labels, platform)
        || candidate.hardware == Some(false)
    {
        return Some(Role::Fallback);
    }
    Some(Role::Lan)
}

fn named_virtual(name: &str, labels: &str, platform: Platform) -> bool {
    match platform {
        Platform::MacOs | Platform::Ios => APPLE_VIRTUAL_PREFIXES
            .iter()
            .any(|prefix| name.starts_with(prefix)),
        Platform::Linux | Platform::Android => LINUX_VIRTUAL_PREFIXES
            .iter()
            .any(|prefix| name.starts_with(prefix)),
        Platform::Windows => WINDOWS_VIRTUAL_KEYWORDS
            .iter()
            .any(|keyword| labels.contains(keyword)),
        Platform::Other => false,
    }
}

fn rank(
    role: Role,
    address: Ipv4Addr,
    candidate: &InterfaceAddress,
    routes: &HashSet<Ipv4Addr>,
    platform: Platform,
) -> Rank {
    let name = candidate.name.to_lowercase();
    let preferred_name = match platform {
        Platform::MacOs | Platform::Ios => name.starts_with("en"),
        Platform::Linux | Platform::Android => ["eth", "en", "wlan", "wl"]
            .iter()
            .any(|prefix| name.starts_with(prefix)),
        Platform::Windows | Platform::Other => false,
    };
    Rank {
        role,
        not_route_source: !routes.contains(&address),
        no_default_route: !candidate.has_default_route,
        route_metric: candidate.route_metric.unwrap_or(u32::MAX),
        not_known_up: candidate.is_up != Some(true),
        not_private: !address.is_private(),
        unknown_medium: !matches!(
            candidate.interface_type.to_lowercase().as_str(),
            "ethernet" | "wifi" | "physical"
        ),
        generic_name: !preferred_name,
        name,
        address: u32::from(address),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn up(name: &str, address: &str) -> InterfaceAddress {
        InterfaceAddress {
            name: name.to_owned(),
            address: address.to_owned(),
            is_up: Some(true),
            ..InterfaceAddress::default()
        }
    }

    fn kind(mut value: InterfaceAddress, interface_type: &str) -> InterfaceAddress {
        value.interface_type = interface_type.to_owned();
        value
    }

    fn gateway(mut value: InterfaceAddress, metric: u32) -> InterfaceAddress {
        value.has_default_route = true;
        value.route_metric = Some(metric);
        value
    }

    fn hardware(mut value: InterfaceAddress, backed: bool) -> InterfaceAddress {
        value.hardware = Some(backed);
        value
    }

    fn described(mut value: InterfaceAddress, description: &str) -> InterfaceAddress {
        value.description = description.to_owned();
        value
    }

    fn offered(values: &[InterfaceAddress], routes: &[&str], platform: &str) -> Vec<String> {
        let routes: Vec<String> = routes.iter().map(|value| (*value).to_owned()).collect();
        rank_lan_ipv4_candidates(values, &routes, platform)
    }

    // v0.7.2 reference cases, carried over verbatim from tests/test_networking.py.

    #[test]
    fn v072_macos_hotspot_prefers_route_selected_en0() {
        let values = [
            up("en0", "172.20.10.12"),
            up("bridge0", "192.168.3.1"),
            up("bridge100", "192.168.2.1"),
            up("utun0", "10.0.0.2"),
            up("utun7", "10.0.0.7"),
            up("awdl0", "169.254.10.2"),
            up("llw0", "169.254.10.3"),
        ];
        assert_eq!(
            offered(&values, &["172.20.10.12"], "darwin"),
            ["172.20.10.12"]
        );
    }

    #[test]
    fn v072_macos_active_en_variants_and_default_route() {
        let mut down = up("en0", "192.168.1.10");
        down.is_up = Some(false);
        let mut default = up("en1", "192.168.1.11");
        default.has_default_route = true;
        let values = [down, default, up("en2", "192.168.1.12")];
        assert_eq!(
            offered(&values, &["192.168.1.11"], "darwin"),
            ["192.168.1.11", "192.168.1.12"]
        );
    }

    #[test]
    fn v072_linux_physical_names_beat_container_and_bridge_names() {
        for (physical, virtual_name) in [
            ("eth0", "docker0"),
            ("wlan0", "virbr0"),
            ("enp3s0", "br-123"),
            ("wlp2s0", "veth123"),
        ] {
            let mut lan = up(physical, "192.168.50.20");
            lan.has_default_route = true;
            let values = [lan, up(virtual_name, "172.18.0.1")];
            assert_eq!(
                offered(&values, &["192.168.50.20"], "linux"),
                ["192.168.50.20"],
                "{physical} vs {virtual_name}"
            );
        }
    }

    #[test]
    fn v072_linux_fallback_without_default_route_and_tunnel_only() {
        assert_eq!(
            offered(&[up("enp3s0", "10.10.0.5")], &[], "linux"),
            ["10.10.0.5"]
        );
        assert_eq!(
            offered(&[kind(up("tun0", "10.8.0.2"), "tunnel")], &[], "linux"),
            ["10.8.0.2"]
        );
    }

    #[test]
    fn v072_windows_route_and_physical_adapter_ranking() {
        let values = [
            described(
                kind(up("vEthernet (WSL)", "172.28.32.1"), "virtual"),
                "Hyper-V Virtual Ethernet Adapter",
            ),
            kind(up("Ethernet", "192.168.31.8"), "physical"),
            kind(up("VPN", "10.8.0.2"), "tunnel"),
        ];
        assert_eq!(
            offered(&values, &["192.168.31.8"], "win32"),
            ["192.168.31.8"]
        );
        assert_eq!(offered(&values[2..], &["10.8.0.2"], "win32"), ["10.8.0.2"]);
        assert_eq!(offered(&values, &["10.8.0.2"], "win32")[0], "192.168.31.8");
    }

    #[test]
    fn v072_windows_structured_facts_deprioritize_virtual_adapters() {
        let values = [
            hardware(
                described(
                    up("vEthernet (Default Switch)", "172.28.32.1"),
                    "Hyper-V Virtual Ethernet Adapter",
                ),
                false,
            ),
            hardware(gateway(kind(up("Wi-Fi", "192.168.31.8"), "wifi"), 35), true),
        ];
        assert_eq!(
            offered(&values, &["192.168.31.8"], "win32"),
            ["192.168.31.8"]
        );
    }

    #[test]
    fn v072_general_validity_public_private_link_local_and_empty() {
        let values = [
            up("lo0", "127.0.0.1"),
            up("en0", "0.0.0.0"),
            up("en1", "224.0.0.1"),
            up("en2", "169.254.20.1"),
            up("en3", "8.8.4.4"),
            up("en4", "192.168.1.20"),
        ];
        let ranked = offered(&values, &[], "darwin");
        assert_eq!(ranked[0], "192.168.1.20");
        assert!(ranked.contains(&"8.8.4.4".to_owned()));
        assert!(!ranked.contains(&"169.254.20.1".to_owned()));
        assert_eq!(
            offered(&[up("en0", "169.254.20.1")], &[], "darwin"),
            ["169.254.20.1"]
        );
        assert!(offered(&[], &[], "linux").is_empty());
        let mut down = up("en0", "192.168.1.20");
        down.is_up = Some(false);
        assert!(offered(&[down], &[], "darwin").is_empty());
    }

    // Regressions reported against v0.8.0-preview.1 and the native Host.

    #[test]
    fn windows_generic_vpn_adapter_does_not_replace_hotspot_wlan() {
        let values = [
            hardware(gateway(kind(up("WLAN", "172.20.10.2"), "wifi"), 35), true),
            hardware(
                described(up("以太网 2", "10.8.0.2"), "TAP-Windows Adapter V9"),
                false,
            ),
        ];
        // The legacy adapter still passes the UDP route source it observed.
        assert_eq!(offered(&values, &["10.8.0.2"], "win32"), ["172.20.10.2"]);
        assert_eq!(offered(&values, &[], "win32"), ["172.20.10.2"]);
        // Name-only facts (as preview.1 had) still recognise the description.
        let names_only = [
            up("WLAN", "172.20.10.2"),
            described(up("以太网 2", "10.8.0.2"), "TAP-Windows Adapter V9"),
        ];
        assert_eq!(
            offered(&names_only, &["10.8.0.2"], "win32"),
            ["172.20.10.2"]
        );
    }

    #[test]
    fn default_gateway_orders_links_without_a_route_probe() {
        let values = [
            hardware(kind(up("Ethernet", "192.168.1.100"), "ethernet"), true),
            hardware(gateway(kind(up("Wi-Fi", "172.20.10.2"), "wifi"), 35), true),
        ];
        assert_eq!(
            offered(&values, &[], "win32"),
            ["172.20.10.2", "192.168.1.100"]
        );
    }

    // Windows.

    #[test]
    fn windows_interface_metric_orders_two_default_gateways() {
        let values = [
            hardware(gateway(kind(up("Wi-Fi", "192.168.1.20"), "wifi"), 35), true),
            hardware(
                gateway(kind(up("Ethernet", "192.168.1.10"), "ethernet"), 25),
                true,
            ),
        ];
        assert_eq!(
            offered(&values, &[], "win32"),
            ["192.168.1.10", "192.168.1.20"]
        );
    }

    #[test]
    fn windows_mobile_hotspot_is_offered_after_the_upstream_link() {
        let values = [
            hardware(
                kind(
                    described(
                        up("本地连接* 10", "192.168.137.1"),
                        "Microsoft Wi-Fi Direct Virtual Adapter #2",
                    ),
                    "hotspot",
                ),
                false,
            ),
            hardware(gateway(kind(up("WLAN", "192.168.31.8"), "wifi"), 40), true),
        ];
        assert_eq!(
            offered(&values, &[], "win32"),
            ["192.168.31.8", "192.168.137.1"]
        );
        // The description alone identifies the hosted network.
        let described_only = [described(
            up("Local Area Connection* 10", "192.168.137.1"),
            "Microsoft Wi-Fi Direct Virtual Adapter #2",
        )];
        assert_eq!(offered(&described_only, &[], "win32"), ["192.168.137.1"]);
    }

    #[test]
    fn windows_cellular_is_excluded_and_bluetooth_is_last_resort() {
        let cellular = gateway(kind(up("Cellular", "10.176.4.9"), "cellular"), 50);
        assert!(offered(std::slice::from_ref(&cellular), &[], "win32").is_empty());
        let bluetooth = hardware(
            kind(
                described(
                    up("Bluetooth Network Connection", "192.168.44.2"),
                    "Bluetooth Device (Personal Area Network)",
                ),
                "bluetooth",
            ),
            true,
        );
        assert_eq!(
            offered(&[cellular.clone(), bluetooth.clone()], &[], "win32"),
            ["192.168.44.2"]
        );
        let wifi = hardware(kind(up("WLAN", "192.168.31.8"), "wifi"), true);
        assert_eq!(
            offered(&[cellular, bluetooth, wifi], &[], "win32"),
            ["192.168.31.8"]
        );
    }

    #[test]
    fn windows_virtual_descriptions_and_flags_are_last_resort() {
        for (name, description) in [
            ("以太网 3", "Sangfor SSL VPN CS Support System VNIC"),
            ("Ethernet 4", "PANGP Virtual Ethernet Adapter #2"),
            (
                "Ethernet 5",
                "Cisco AnyConnect Secure Mobility Client Virtual Miniport Adapter",
            ),
            (
                "VMware Network Adapter VMnet8",
                "VMware Virtual Ethernet Adapter for VMnet8",
            ),
            ("以太网 6", "VirtualBox Host-Only Ethernet Adapter"),
            ("Radmin VPN", "Famatech Radmin VPN Ethernet Adapter"),
            ("Ethernet 7", "ZeroTier Virtual Port"),
        ] {
            let values = [
                described(up(name, "10.20.30.40"), description),
                up("以太网", "192.168.10.8"),
            ];
            assert_eq!(
                offered(&values, &["10.20.30.40"], "win32"),
                ["192.168.10.8"],
                "{name}"
            );
        }
        // Without descriptions, the OS hardware flag still decides.
        let values = [
            hardware(up("Ethernet 2", "10.20.30.40"), false),
            hardware(up("Ethernet", "192.168.10.8"), true),
        ];
        assert_eq!(
            offered(&values, &["10.20.30.40"], "win32"),
            ["192.168.10.8"]
        );
    }

    #[test]
    fn windows_external_switch_is_used_when_it_is_the_only_link() {
        let values = [gateway(
            hardware(
                described(
                    up("vEthernet (External)", "192.168.1.30"),
                    "Hyper-V Virtual Ethernet Adapter",
                ),
                false,
            ),
            25,
        )];
        assert_eq!(offered(&values, &[], "win32"), ["192.168.1.30"]);
    }

    #[test]
    fn desktop_public_lan_addresses_follow_private_ones() {
        let values = [
            hardware(
                gateway(kind(up("Ethernet", "133.9.1.20"), "ethernet"), 25),
                true,
            ),
            hardware(kind(up("Wi-Fi", "192.168.1.20"), "wifi"), true),
        ];
        assert_eq!(
            offered(&values, &[], "win32"),
            ["133.9.1.20", "192.168.1.20"],
            "the default route outranks address scope"
        );
        let without_route = [
            hardware(kind(up("Ethernet", "133.9.1.20"), "ethernet"), true),
            hardware(kind(up("Wi-Fi", "192.168.1.20"), "wifi"), true),
        ];
        assert_eq!(
            offered(&without_route, &[], "win32"),
            ["192.168.1.20", "133.9.1.20"]
        );
    }

    // Linux (Ubuntu) with sysfs facts.

    #[test]
    fn linux_hardware_backed_bridge_and_usb_tether_are_lan() {
        let values = [
            hardware(
                gateway(kind(up("br0", "192.168.1.5"), "ethernet"), 100),
                true,
            ),
            hardware(kind(up("docker0", "172.17.0.1"), "ethernet"), false),
            hardware(kind(up("virbr0", "192.168.122.1"), "ethernet"), false),
            hardware(kind(up("usb0", "192.168.42.129"), "ethernet"), true),
            hardware(kind(up("wg0", "10.6.0.2"), "tunnel"), false),
            hardware(kind(up("wwan0", "10.64.2.3"), "cellular"), true),
        ];
        assert_eq!(
            offered(&values, &[], "linux"),
            ["192.168.1.5", "192.168.42.129"]
        );
    }

    #[test]
    fn linux_route_metric_prefers_ethernet_over_wifi() {
        let values = [
            hardware(
                gateway(kind(up("wlp2s0", "192.168.1.21"), "wifi"), 600),
                true,
            ),
            hardware(
                gateway(kind(up("enp3s0", "192.168.1.20"), "ethernet"), 100),
                true,
            ),
        ];
        assert_eq!(
            offered(&values, &[], "linux"),
            ["192.168.1.20", "192.168.1.21"]
        );
    }

    // macOS and iOS.

    #[test]
    fn macos_primary_route_beats_scoped_default_and_full_tunnel_vpn() {
        let values = [
            gateway(kind(up("en0", "192.168.1.20"), "ethernet"), 1),
            gateway(kind(up("en7", "192.168.1.30"), "ethernet"), 0),
            gateway(kind(up("utun4", "10.9.0.2"), "tunnel"), 0),
        ];
        assert_eq!(
            offered(&values, &[], "darwin"),
            ["192.168.1.30", "192.168.1.20"]
        );
    }

    #[test]
    fn ios_personal_hotspot_is_offered_and_cellular_never_is() {
        let values = [
            gateway(kind(up("pdp_ip0", "10.52.7.9"), "cellular"), 0),
            kind(up("bridge100", "172.20.10.1"), "ethernet"),
            kind(up("utun3", "10.9.0.2"), "tunnel"),
            up("awdl0", "169.254.3.4"),
        ];
        assert_eq!(offered(&values, &[], "ios"), ["172.20.10.1"]);
        let with_wifi = [
            values[0].clone(),
            values[1].clone(),
            gateway(kind(up("en0", "192.168.31.8"), "ethernet"), 1),
        ];
        assert_eq!(
            offered(&with_wifi, &[], "ios"),
            ["192.168.31.8", "172.20.10.1"]
        );
        // On macOS the same bridge is Internet Sharing or a VM network.
        assert_eq!(offered(&with_wifi, &[], "darwin"), ["192.168.31.8"]);
    }

    // Android, carried over from the native Host selection.

    #[test]
    fn android_wifi_beats_cellular_and_vpn_interfaces() {
        let values = [
            up("rmnet_data0", "10.1.2.3"),
            up("tun0", "10.8.0.2"),
            up("wlan0", "192.168.31.8"),
        ];
        for platform in ["linux", "android"] {
            assert_eq!(
                offered(&values, &[], platform),
                ["192.168.31.8"],
                "{platform}"
            );
            assert!(
                offered(&values[..1], &[], platform).is_empty(),
                "{platform}"
            );
        }
    }

    #[test]
    fn android_hotspot_and_tethering_links_are_lan_on_cellular() {
        let values = [
            up("rmnet_data2", "10.140.20.3"),
            up("v4-rmnet_data2", "192.0.0.4"),
            up("ccmni1", "10.33.1.2"),
            up("ap0", "192.168.43.1"),
            up("rndis0", "192.168.42.129"),
        ];
        assert_eq!(
            offered(&values, &[], "android"),
            ["192.168.43.1", "192.168.42.129"]
        );
    }

    #[test]
    fn mobile_hosts_offer_only_private_addresses() {
        let values = [up("wlan0", "133.9.1.20")];
        assert!(offered(&values, &[], "android").is_empty());
        assert!(offered(&values, &[], "ios").is_empty());
        assert_eq!(offered(&values, &[], "linux"), ["133.9.1.20"]);
    }
}
