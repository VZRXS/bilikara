//! IP Helper facts for Windows adapters: default gateway and interface metric,
//! adapter description, hardware flag, physical medium and interface type.
//! These replace the PowerShell `Get-NetIPConfiguration`/`Get-NetAdapter`
//! facts the v0.7.2 Host used, without starting a process.

use super::InterfaceAddress;
use super::policy::WINDOWS_HOTSPOT_KEYWORDS;
use std::net::Ipv4Addr;

// ipifcons.h
const IF_TYPE_ETHERNET_CSMACD: u32 = 6;
const IF_TYPE_PPP: u32 = 23;
const IF_TYPE_SOFTWARE_LOOPBACK: u32 = 24;
const IF_TYPE_PROP_VIRTUAL: u32 = 53;
const IF_TYPE_IEEE80211: u32 = 71;
const IF_TYPE_TUNNEL: u32 = 131;
const IF_TYPE_WWANPP: u32 = 243;
const IF_TYPE_WWANPP2: u32 = 244;
// NDIS_PHYSICAL_MEDIUM
const MEDIUM_WIRELESS_LAN: i32 = 1;
const MEDIUM_WIRELESS_WAN: i32 = 8;
const MEDIUM_NATIVE_802_11: i32 = 9;
const MEDIUM_BLUETOOTH: i32 = 10;
const MEDIUM_802_3: i32 = 14;

/// One adapter as reported by GetAdaptersAddresses and GetIfEntry2.
struct Adapter {
    name: String,
    description: String,
    if_type: u32,
    oper_up: bool,
    has_gateway: bool,
    metric: u32,
    hardware: Option<bool>,
    physical_medium: Option<i32>,
    addresses: Vec<Ipv4Addr>,
}

impl Adapter {
    fn kind(&self) -> &'static str {
        let labels = format!("{} {}", self.name, self.description).to_lowercase();
        let medium = self.physical_medium;
        if self.if_type == IF_TYPE_SOFTWARE_LOOPBACK {
            "loopback"
        } else if matches!(self.if_type, IF_TYPE_WWANPP | IF_TYPE_WWANPP2)
            || medium == Some(MEDIUM_WIRELESS_WAN)
        {
            "cellular"
        } else if WINDOWS_HOTSPOT_KEYWORDS
            .iter()
            .any(|keyword| labels.contains(keyword))
        {
            "hotspot"
        } else if medium == Some(MEDIUM_BLUETOOTH) {
            "bluetooth"
        } else if matches!(self.if_type, IF_TYPE_TUNNEL | IF_TYPE_PPP) {
            "tunnel"
        } else if self.if_type == IF_TYPE_PROP_VIRTUAL {
            "virtual"
        } else if self.if_type == IF_TYPE_IEEE80211
            || matches!(medium, Some(MEDIUM_WIRELESS_LAN | MEDIUM_NATIVE_802_11))
        {
            "wifi"
        } else if self.if_type == IF_TYPE_ETHERNET_CSMACD && medium == Some(MEDIUM_802_3) {
            "ethernet"
        } else {
            "unknown"
        }
    }

    fn candidates(&self) -> impl Iterator<Item = InterfaceAddress> + '_ {
        let kind = self.kind();
        self.addresses.iter().map(move |address| InterfaceAddress {
            name: self.name.clone(),
            address: address.to_string(),
            is_up: Some(self.oper_up),
            has_default_route: self.has_gateway,
            interface_type: kind.to_owned(),
            description: self.description.clone(),
            hardware: self.hardware,
            route_metric: self.has_gateway.then_some(self.metric),
        })
    }
}

#[cfg(windows)]
pub(super) fn interfaces() -> Vec<InterfaceAddress> {
    adapters().iter().flat_map(Adapter::candidates).collect()
}

#[cfg(windows)]
fn adapters() -> Vec<Adapter> {
    use windows_sys::Win32::Foundation::{ERROR_BUFFER_OVERFLOW, NO_ERROR};
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GAA_FLAG_INCLUDE_GATEWAYS, GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER,
        GAA_FLAG_SKIP_MULTICAST, GetAdaptersAddresses, IP_ADAPTER_ADDRESSES_LH,
    };
    use windows_sys::Win32::Networking::WinSock::AF_INET;

    let flags = GAA_FLAG_INCLUDE_GATEWAYS
        | GAA_FLAG_SKIP_ANYCAST
        | GAA_FLAG_SKIP_MULTICAST
        | GAA_FLAG_SKIP_DNS_SERVER;
    let mut size: u32 = 16 * 1024;
    for _ in 0..4 {
        // u64 storage keeps the adapter list 8-byte aligned.
        let mut buffer = vec![0_u64; (size as usize).div_ceil(8)];
        let first = buffer.as_mut_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>();
        // SAFETY: `first` points to at least `size` writable, aligned bytes.
        let status = unsafe {
            GetAdaptersAddresses(
                u32::from(AF_INET),
                flags,
                std::ptr::null(),
                first,
                &mut size,
            )
        };
        if status == ERROR_BUFFER_OVERFLOW {
            continue;
        }
        if status != NO_ERROR {
            return Vec::new();
        }
        let mut adapters = Vec::new();
        let mut current = first;
        while !current.is_null() {
            // SAFETY: the list lives in `buffer` until this function returns.
            let adapter = unsafe { &*current };
            adapters.push(read(adapter));
            current = adapter.Next;
        }
        return adapters;
    }
    Vec::new()
}

#[cfg(windows)]
fn read(
    adapter: &windows_sys::Win32::NetworkManagement::IpHelper::IP_ADAPTER_ADDRESSES_LH,
) -> Adapter {
    use windows_sys::Win32::Foundation::NO_ERROR;
    use windows_sys::Win32::NetworkManagement::IpHelper::{GetIfEntry2, MIB_IF_ROW2};
    use windows_sys::Win32::NetworkManagement::Ndis::IfOperStatusUp;
    use windows_sys::Win32::Networking::WinSock::IpDadStatePreferred;

    let mut addresses = Vec::new();
    let mut unicast = adapter.FirstUnicastAddress;
    while !unicast.is_null() {
        // SAFETY: unicast entries belong to the live adapter list.
        let entry = unsafe { &*unicast };
        if entry.DadState == IpDadStatePreferred {
            addresses.extend(ipv4(&entry.Address));
        }
        unicast = entry.Next;
    }
    let mut has_gateway = false;
    let mut gateway = adapter.FirstGatewayAddress;
    while !gateway.is_null() {
        // SAFETY: gateway entries belong to the live adapter list.
        let entry = unsafe { &*gateway };
        has_gateway |= ipv4(&entry.Address).is_some_and(|address| !address.is_unspecified());
        gateway = entry.Next;
    }
    let mut row = MIB_IF_ROW2 {
        InterfaceLuid: adapter.Luid,
        ..MIB_IF_ROW2::default()
    };
    // SAFETY: `row` is zero-initialised apart from the adapter LUID it names.
    let found = unsafe { GetIfEntry2(&mut row) } == NO_ERROR;
    Adapter {
        // SAFETY: IP Helper strings are NUL-terminated UTF-16 in the live list.
        name: unsafe { wide(adapter.FriendlyName) },
        description: unsafe { wide(adapter.Description) },
        if_type: adapter.IfType,
        oper_up: adapter.OperStatus == IfOperStatusUp,
        has_gateway,
        metric: adapter.Ipv4Metric,
        // Bit 0 of InterfaceAndOperStatusFlags is HardwareInterface.
        hardware: found.then_some(row.InterfaceAndOperStatusFlags._bitfield & 1 != 0),
        physical_medium: found.then_some(row.PhysicalMediumType),
        addresses,
    }
}

/// # Safety
///
/// `value` must be null or point to a NUL-terminated UTF-16 string.
#[cfg(windows)]
unsafe fn wide(value: windows_sys::core::PWSTR) -> String {
    if value.is_null() {
        return String::new();
    }
    let mut length = 0;
    // SAFETY: the caller guarantees a terminating NUL code unit.
    while unsafe { *value.add(length) } != 0 {
        length += 1;
    }
    // SAFETY: `length` initialised code units precede the terminator.
    String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(value, length) })
}

#[cfg(windows)]
fn ipv4(address: &windows_sys::Win32::Networking::WinSock::SOCKET_ADDRESS) -> Option<Ipv4Addr> {
    use windows_sys::Win32::Networking::WinSock::{AF_INET, SOCKADDR_IN};

    let length = usize::try_from(address.iSockaddrLength).ok()?;
    if address.lpSockaddr.is_null() || length < std::mem::size_of::<SOCKADDR_IN>() {
        return None;
    }
    // SAFETY: IP Helper returned a sockaddr of `length` bytes.
    let sockaddr = unsafe { &*address.lpSockaddr.cast::<SOCKADDR_IN>() };
    // SAFETY: every IN_ADDR union view covers the same four bytes.
    (sockaddr.sin_family == AF_INET)
        .then(|| Ipv4Addr::from(unsafe { sockaddr.sin_addr.S_un.S_addr }.to_ne_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn adapter(
        name: &str,
        description: &str,
        if_type: u32,
        medium: i32,
        hardware: bool,
    ) -> Adapter {
        Adapter {
            name: name.to_owned(),
            description: description.to_owned(),
            if_type,
            oper_up: true,
            has_gateway: false,
            metric: 25,
            hardware: Some(hardware),
            physical_medium: Some(medium),
            addresses: Vec::new(),
        }
    }

    fn with(mut value: Adapter, addresses: &[[u8; 4]], gateway: Option<u32>) -> Adapter {
        value.addresses = addresses.iter().copied().map(Ipv4Addr::from).collect();
        if let Some(metric) = gateway {
            value.has_gateway = true;
            value.metric = metric;
        }
        value
    }

    #[test]
    fn ip_helper_facts_map_to_policy_kinds_and_ranking() {
        let adapters = [
            with(
                adapter("WLAN", "Intel(R) Wi-Fi 6 AX201 160MHz", 71, 9, true),
                &[[172, 20, 10, 2]],
                Some(35),
            ),
            with(
                adapter("以太网", "Realtek PCIe GbE Family Controller", 6, 14, true),
                &[[192, 168, 1, 100]],
                None,
            ),
            with(
                adapter(
                    "vEthernet (WSL)",
                    "Hyper-V Virtual Ethernet Adapter",
                    6,
                    0,
                    false,
                ),
                &[[172, 28, 32, 1]],
                None,
            ),
            with(
                adapter("Meta", "Meta Tunnel", 53, 0, false),
                &[[198, 18, 0, 1]],
                Some(0),
            ),
            with(
                adapter("以太网 2", "TAP-Windows Adapter V9", 6, 14, false),
                &[[10, 8, 0, 2]],
                None,
            ),
            with(
                adapter(
                    "本地连接* 10",
                    "Microsoft Wi-Fi Direct Virtual Adapter #2",
                    71,
                    9,
                    false,
                ),
                &[[192, 168, 137, 1]],
                None,
            ),
            with(
                adapter("手机网络", "Generic Mobile Broadband Adapter", 243, 8, true),
                &[[10, 176, 4, 9]],
                Some(50),
            ),
            with(
                adapter(
                    "蓝牙网络连接",
                    "Bluetooth Device (Personal Area Network)",
                    6,
                    10,
                    true,
                ),
                &[[192, 168, 44, 2]],
                None,
            ),
            with(
                adapter("Loopback Pseudo-Interface 1", "", 24, 0, false),
                &[[127, 0, 0, 1]],
                None,
            ),
            with(
                adapter("PPPoE", "WAN Miniport (PPPOE)", 23, 0, false),
                &[[133, 9, 1, 20]],
                Some(1),
            ),
        ];
        let kinds: Vec<&str> = adapters.iter().map(Adapter::kind).collect();
        assert_eq!(
            kinds,
            [
                "wifi",
                "ethernet",
                "unknown",
                "virtual",
                "ethernet",
                "hotspot",
                "cellular",
                "bluetooth",
                "loopback",
                "tunnel"
            ]
        );
        let candidates: Vec<InterfaceAddress> =
            adapters.iter().flat_map(Adapter::candidates).collect();
        let wlan = &candidates[0];
        assert!(wlan.has_default_route && wlan.route_metric == Some(35));
        assert_eq!(wlan.hardware, Some(true));
        assert_eq!(candidates[1].route_metric, None);
        assert_eq!(
            super::super::rank_lan_ipv4_candidates(&candidates, &[], "win32"),
            ["172.20.10.2", "192.168.1.100", "192.168.137.1"]
        );
    }

    #[test]
    fn every_preferred_address_of_an_adapter_is_a_candidate() {
        let mut value = with(
            adapter(
                "Ethernet",
                "Intel(R) Ethernet Connection I219-V",
                6,
                14,
                true,
            ),
            &[[192, 168, 1, 10], [10, 0, 0, 10]],
            Some(25),
        );
        value.oper_up = false;
        let candidates: Vec<InterfaceAddress> = value.candidates().collect();
        assert_eq!(candidates.len(), 2);
        assert!(candidates.iter().all(|item| item.is_up == Some(false)));
        assert!(super::super::rank_lan_ipv4_candidates(&candidates, &[], "win32").is_empty());
    }
}
