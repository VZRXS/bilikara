//! Gather addresses locally and reuse Rust's LAN ranking. A phone's cellular
//! private address is not a reachable LAN Remote invitation.
use super::*;
use crate::networking::{InterfaceAddress, rank_lan_ipv4_candidates};
use std::net::{IpAddr, Ipv4Addr};

// Interface enumeration is local I/O, never a probe of an Internet service.
// Poll independently of browser requests so SSE clients and restored windows
// see the same current address. The shared AppState remains the only authority.
pub(super) fn start_monitor(context: &Arc<HostContext>) -> Result<(), ApiError> {
    let port = context.port;
    let stop = context.stop.clone();
    context
        .spawn("native-lan-monitor", move || {
            while !stop.load(Ordering::Acquire) {
                for _ in 0..25 {
                    if stop.load(Ordering::Acquire) {
                        return;
                    }
                    thread::sleep(Duration::from_millis(200));
                }
                if stop.load(Ordering::Acquire) {
                    return;
                }
                let addresses = lan_addresses();
                let urls = lan_urls(port, &addresses);
                let unchanged =
                    with_app(|app| Ok(app.native().remote_access["lan_urls"] == json!(urls)));
                if !matches!(unchanged, Ok(false)) {
                    continue;
                }
                // QR generation runs outside the AppState lock and only on change.
                if let Ok(access) = remote_access(port, &addresses) {
                    let _ = with_app(|app| {
                        if !stop.load(Ordering::Acquire) {
                            publish_access(app.native(), access);
                        }
                        Ok(())
                    });
                }
            }
        })
        .map_err(|_| ApiError::new(503, "network_monitor", "无法启动本地网络监测"))
}

fn lan_urls(port: u16, addresses: &[String]) -> Vec<String> {
    addresses
        .iter()
        .map(|ip| format!("http://{ip}:{port}/remote"))
        .collect()
}

pub(super) fn remote_access(port: u16, addresses: &[String]) -> Result<Value, ApiError> {
    let urls = lan_urls(port, addresses);
    let local = format!("http://127.0.0.1:{port}/remote");
    let preferred = urls.first().unwrap_or(&local);
    let qr = access_qr_image(preferred)?;
    Ok(json!({"local_url":local,"preferred_url":preferred,"lan_urls":urls,"qr_image":qr}))
}

fn publish_access(session: &mut crate::app_state::native_session::NativeSession, access: Value) {
    if session.remote_access != access {
        session.remote_access = access;
        session.revision += 1;
    }
}

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
    fn network_switch_disconnect_and_reconnect_replace_access_and_revision() {
        let mut session = crate::app_state::native_session::NativeSession::default();
        let first = remote_access(8080, &["192.168.1.5".into()]).unwrap();
        publish_access(&mut session, first.clone());
        assert_eq!(session.revision, 1);
        publish_access(&mut session, first.clone());
        assert_eq!(session.revision, 1, "unchanged interfaces must not publish");
        let switched = remote_access(8080, &["10.45.66.136".into()]).unwrap();
        publish_access(&mut session, switched.clone());
        assert_eq!(
            session.remote_access["preferred_url"],
            "http://10.45.66.136:8080/remote"
        );
        assert_ne!(session.remote_access["qr_image"], first["qr_image"]);
        let disconnected = remote_access(8080, &[]).unwrap();
        publish_access(&mut session, disconnected);
        assert_eq!(session.remote_access["lan_urls"], json!([]));
        assert_eq!(
            session.remote_access["preferred_url"],
            "http://127.0.0.1:8080/remote"
        );
        publish_access(&mut session, switched);
        assert_eq!(session.revision, 4);
        assert_eq!(
            session.remote_access["preferred_url"],
            "http://10.45.66.136:8080/remote"
        );
    }
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
