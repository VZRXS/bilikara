//! sysfs and procfs interface facts for Linux and Android.
//!
//! Android may deny these reads to apps; an unreadable fact stays unknown
//! rather than marking a link virtual.

use super::InterfaceAddress;
use std::collections::HashMap;
use std::fs;
use std::io::ErrorKind;
use std::path::Path;

// <linux/if_arp.h>
const ARPHRD_ETHER: u32 = 1;
const ARPHRD_PPP: u32 = 512;
const ARPHRD_RAWIP: u32 = 519;
const ARPHRD_TUNNEL: u32 = 768;
const ARPHRD_TUNNEL6: u32 = 769;
const ARPHRD_LOOPBACK: u32 = 772;
const ARPHRD_SIT: u32 = 776;
const ARPHRD_IPGRE: u32 = 778;
const ARPHRD_NONE: u32 = 65534;
const RTF_UP: u32 = 0x1;
/// Bridge ports, bond slaves and VLAN parents nest only a few levels deep.
const MAX_LOWER_DEPTH: u8 = 4;

pub(super) fn annotate(candidates: &mut [InterfaceAddress], sysfs: &Path, routes: &Path) {
    let defaults = default_routes(routes);
    let mut known: HashMap<String, Facts> = HashMap::new();
    for candidate in candidates.iter_mut() {
        let facts = known
            .entry(candidate.name.clone())
            .or_insert_with(|| Facts::read(sysfs, &candidate.name));
        if facts.down {
            candidate.is_up = Some(false);
        }
        if let Some(kind) = facts.kind
            && (candidate.interface_type == "unknown" || kind == "cellular")
        {
            candidate.interface_type = kind.to_owned();
        }
        candidate.hardware = facts.hardware;
        if let Some(&metric) = defaults.get(&candidate.name) {
            candidate.has_default_route = true;
            candidate.route_metric = Some(metric);
        }
    }
}

#[derive(Default)]
struct Facts {
    hardware: Option<bool>,
    kind: Option<&'static str>,
    down: bool,
}

impl Facts {
    fn read(sysfs: &Path, name: &str) -> Self {
        if !valid_name(name) {
            return Self::default();
        }
        let directory = sysfs.join(name);
        if !directory.is_dir() {
            return Self::default();
        }
        let text = |file: &str| fs::read_to_string(directory.join(file)).ok();
        let device_type = text("uevent")
            .and_then(|uevent| {
                uevent.lines().find_map(|line| {
                    line.strip_prefix("DEVTYPE=")
                        .map(|value| value.trim().to_owned())
                })
            })
            .unwrap_or_default();
        let link_type = text("type").and_then(|value| value.trim().parse::<u32>().ok());
        let kind = if link_type == Some(ARPHRD_LOOPBACK) {
            Some("loopback")
        } else if device_type == "wwan" || link_type == Some(ARPHRD_RAWIP) {
            Some("cellular")
        } else if device_type == "wireguard"
            || directory.join("tun_flags").exists()
            || matches!(
                link_type,
                Some(
                    ARPHRD_NONE
                        | ARPHRD_PPP
                        | ARPHRD_TUNNEL
                        | ARPHRD_TUNNEL6
                        | ARPHRD_SIT
                        | ARPHRD_IPGRE
                )
            )
        {
            Some("tunnel")
        } else if device_type == "bluetooth" {
            Some("bluetooth")
        } else if device_type == "wlan"
            || directory.join("wireless").exists()
            || directory.join("phy80211").exists()
        {
            Some("wifi")
        } else if link_type == Some(ARPHRD_ETHER) {
            Some("ethernet")
        } else {
            None
        };
        let down = matches!(
            text("operstate").as_deref().map(str::trim),
            Some("down" | "lowerlayerdown" | "notpresent" | "dormant")
        );
        Self {
            hardware: hardware_backed(sysfs, name, 0),
            kind,
            down,
        }
    }
}

/// A link is hardware-backed when it, or a lower device it bridges, bonds or
/// tags, has a bus `device`; purely virtual devices live under
/// `/sys/devices/virtual/net`.
fn hardware_backed(sysfs: &Path, name: &str, depth: u8) -> Option<bool> {
    let directory = sysfs.join(name);
    match fs::symlink_metadata(directory.join("device")) {
        Ok(_) => return Some(true),
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(_) => return None,
    }
    if depth >= MAX_LOWER_DEPTH {
        return Some(false);
    }
    let mut lowers = Vec::new();
    for entry in fs::read_dir(&directory).ok()?.flatten() {
        if let Some(lower) = entry
            .file_name()
            .to_str()
            .and_then(|file| file.strip_prefix("lower_"))
        {
            lowers.push(lower.to_owned());
        }
    }
    match fs::read_dir(directory.join("brif")) {
        Ok(ports) => lowers.extend(
            ports
                .flatten()
                .filter_map(|entry| entry.file_name().into_string().ok()),
        ),
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(_) => return None,
    }
    let mut unknown = false;
    for lower in lowers.iter().filter(|lower| valid_name(lower)) {
        match hardware_backed(sysfs, lower, depth + 1) {
            Some(true) => return Some(true),
            Some(false) => {}
            None => unknown = true,
        }
    }
    (!unknown).then_some(false)
}

fn valid_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains('/')
}

/// Interfaces with an IPv4 default route and their lowest route metric.
fn default_routes(path: &Path) -> HashMap<String, u32> {
    let mut routes = HashMap::new();
    let Ok(table) = fs::read_to_string(path) else {
        return routes;
    };
    for line in table.lines().skip(1) {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 8 {
            continue;
        }
        let hex = |index: usize| u32::from_str_radix(fields[index], 16).ok();
        if hex(1) != Some(0) || hex(7) != Some(0) || hex(3).is_none_or(|flags| flags & RTF_UP == 0)
        {
            continue;
        }
        let metric = fields[6].parse().unwrap_or(u32::MAX);
        routes
            .entry(fields[0].to_owned())
            .and_modify(|current: &mut u32| *current = (*current).min(metric))
            .or_insert(metric);
    }
    routes
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct Tree(PathBuf);

    impl Tree {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let root = std::env::temp_dir().join(format!(
                "bilikara-sysfs-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = fs::remove_dir_all(&root);
            fs::create_dir_all(root.join("class/net")).unwrap();
            fs::create_dir_all(root.join("devices/pci0000:00/0000:00:1f.6")).unwrap();
            Self(root)
        }

        fn net(&self) -> PathBuf {
            self.0.join("class/net")
        }

        /// A net device directory with sysfs attribute files.
        fn link(&self, name: &str, files: &[(&str, &str)]) -> &Self {
            let directory = self.net().join(name);
            fs::create_dir_all(&directory).unwrap();
            for (file, content) in files {
                fs::write(directory.join(file), content).unwrap();
            }
            self
        }

        fn hardware(&self, name: &str) -> &Self {
            symlink(
                self.0.join("devices/pci0000:00/0000:00:1f.6"),
                self.net().join(name).join("device"),
            )
            .unwrap();
            self
        }

        fn lower(&self, upper: &str, lower: &str) -> &Self {
            symlink(
                self.net().join(lower),
                self.net().join(upper).join(format!("lower_{lower}")),
            )
            .unwrap();
            self
        }

        fn port(&self, bridge: &str, port: &str) -> &Self {
            let ports = self.net().join(bridge).join("brif");
            fs::create_dir_all(&ports).unwrap();
            symlink(self.net().join(port).join("brport"), ports.join(port)).unwrap();
            self
        }

        fn routes(&self, rows: &[&str]) -> PathBuf {
            let path = self.0.join("route");
            let mut table = String::from(
                "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n",
            );
            for row in rows {
                table.push_str(row);
                table.push('\n');
            }
            fs::write(&path, table).unwrap();
            path
        }
    }

    impl Drop for Tree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn observed(name: &str, address: &str) -> InterfaceAddress {
        InterfaceAddress {
            name: name.to_owned(),
            address: address.to_owned(),
            is_up: Some(true),
            ..InterfaceAddress::default()
        }
    }

    #[test]
    fn sysfs_and_route_table_facts_drive_the_real_ranking() {
        let tree = Tree::new();
        let ethernet = [
            ("type", "1\n"),
            ("operstate", "up\n"),
            ("uevent", "INTERFACE=x\n"),
        ];
        tree.link("eth0", &ethernet).hardware("eth0");
        tree.link("wlp2s0", &[("type", "1\n"), ("uevent", "DEVTYPE=wlan\n")])
            .hardware("wlp2s0");
        tree.link("eth1", &ethernet).hardware("eth1");
        tree.link("br0", &[("type", "1\n"), ("uevent", "DEVTYPE=bridge\n")])
            .port("br0", "eth1")
            .lower("br0", "eth1");
        tree.link("vethab12", &ethernet);
        tree.link(
            "docker0",
            &[("type", "1\n"), ("uevent", "DEVTYPE=bridge\n")],
        )
        .port("docker0", "vethab12");
        tree.link("eth2", &ethernet).hardware("eth2");
        tree.link("eth2.100", &[("type", "1\n"), ("uevent", "DEVTYPE=vlan\n")])
            .lower("eth2.100", "eth2");
        tree.link("tun0", &[("type", "65534\n"), ("tun_flags", "0x1001\n")]);
        tree.link("wwan0", &[("type", "519\n"), ("uevent", "DEVTYPE=wwan\n")])
            .hardware("wwan0");
        tree.link("enp5s0", &[("type", "1\n"), ("operstate", "down\n")])
            .hardware("enp5s0");
        let routes = tree.routes(&[
            "eth0\t00000000\t0101A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0",
            "wlp2s0\t00000000\t0101A8C0\t0003\t0\t0\t600\t00000000\t0\t0\t0",
            "tun0\t00000000\t00000000\t0001\t0\t0\t0\t00000080\t0\t0\t0",
            "eth0\t0001A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0",
        ]);
        let mut candidates = vec![
            observed("docker0", "172.17.0.1"),
            observed("tun0", "10.8.0.2"),
            observed("wlp2s0", "192.168.1.21"),
            observed("br0", "192.168.2.5"),
            observed("eth0", "192.168.1.20"),
            observed("eth2.100", "10.100.0.5"),
            observed("wwan0", "10.64.2.3"),
            observed("enp5s0", "192.168.9.9"),
        ];
        annotate(&mut candidates, &tree.net(), &routes);
        let fact = |name: &str| candidates.iter().find(|item| item.name == name).unwrap();
        assert_eq!(fact("eth0").route_metric, Some(100));
        assert!(fact("eth0").has_default_route);
        assert_eq!(fact("wlp2s0").interface_type, "wifi");
        assert_eq!(fact("wlp2s0").route_metric, Some(600));
        assert_eq!(fact("br0").hardware, Some(true), "bridge over a NIC");
        assert_eq!(fact("eth2.100").hardware, Some(true), "VLAN over a NIC");
        assert_eq!(fact("docker0").hardware, Some(false));
        assert_eq!(fact("tun0").interface_type, "tunnel");
        assert!(
            !fact("tun0").has_default_route,
            "0.0.0.0/1 is not a default route"
        );
        assert_eq!(fact("wwan0").interface_type, "cellular");
        assert_eq!(fact("enp5s0").is_up, Some(false));
        assert_eq!(
            super::super::rank_lan_ipv4_candidates(&candidates, &[], "linux"),
            ["192.168.1.20", "192.168.1.21", "10.100.0.5", "192.168.2.5"]
        );
    }

    #[test]
    fn unreadable_or_missing_sysfs_leaves_facts_unknown() {
        let tree = Tree::new();
        let mut candidates = vec![observed("wlan0", "192.168.31.8")];
        annotate(&mut candidates, &tree.net(), &tree.0.join("missing-route"));
        assert_eq!(candidates[0].hardware, None);
        assert_eq!(candidates[0].interface_type, "unknown");
        assert!(!candidates[0].has_default_route);
        assert_eq!(
            super::super::rank_lan_ipv4_candidates(&candidates, &[], "android"),
            ["192.168.31.8"]
        );
    }

    #[test]
    fn bridge_with_an_unreadable_port_is_not_declared_virtual() {
        let tree = Tree::new();
        tree.link("br0", &[("type", "1\n")]);
        fs::create_dir_all(tree.net().join("br0/brif")).unwrap();
        symlink(tree.0.join("nowhere"), tree.net().join("br0/brif/eth9")).unwrap();
        // The dangling port has no sysfs entry of its own, so its facts are unknown.
        assert_eq!(hardware_backed(&tree.net(), "br0", 0), None);
        assert!(!valid_name("../eth0") && !valid_name("..") && valid_name("eth0.100"));
    }
}
