//! Gather addresses locally and reuse Rust's LAN ranking. A phone's cellular
//! private address is not a reachable LAN Remote invitation.
use crate::networking::{InterfaceAddress, rank_lan_ipv4_candidates};
use std::net::{IpAddr, Ipv4Addr};

pub(super) fn lan_addresses() -> Vec<String> {
    let candidates = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .map(|interface| InterfaceAddress {
            address: interface.ip().to_string(),
            name: interface.name,
            is_up: Some(true),
            has_default_route: false,
            interface_type: "unknown".into(),
            description: String::new(),
        })
        .collect::<Vec<_>>();
    let platform = if cfg!(target_os = "windows") {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };
    select(&candidates, platform)
}

fn select(candidates: &[InterfaceAddress], platform: &str) -> Vec<String> {
    let candidates = candidates
        .iter()
        .filter(|candidate| {
            let name = candidate.name.to_lowercase();
            candidate
                .address
                .parse::<Ipv4Addr>()
                .is_ok_and(|ip| ip.is_private() && !IpAddr::V4(ip).is_loopback())
                && ![
                    "rmnet", "v4-rmnet", "ccmni", "v4-ccmni", "pdp", "wwan", "dummy",
                ]
                .iter()
                .any(|prefix| name.starts_with(prefix))
        })
        .cloned()
        .collect::<Vec<_>>();
    // Do not prefer the Internet default route: on Android that can be a VPN or
    // cellular link, and selecting it breaks same-Wi-Fi phone control.
    rank_lan_ipv4_candidates(&candidates, &[], platform)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn android_wifi_beats_cellular_and_vpn_interfaces() {
        let values = [
            ("rmnet_data0", "10.1.2.3"),
            ("tun0", "10.8.0.2"),
            ("wlan0", "192.168.31.8"),
        ]
        .map(|(name, address)| InterfaceAddress {
            name: name.into(),
            address: address.into(),
            is_up: Some(true),
            has_default_route: false,
            interface_type: "unknown".into(),
            description: String::new(),
        });
        assert_eq!(select(&values, "linux"), vec!["192.168.31.8"]);
        assert!(select(&values[..1], "linux").is_empty());
    }
}
