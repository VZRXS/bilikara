//! macOS and iOS link types and PF_ROUTE default routes.

#[cfg(target_vendor = "apple")]
use super::InterfaceAddress;
use std::collections::HashMap;

/// `sizeof(struct rt_msghdr)` and field offsets on Darwin.
const RT_MSGHDR_LEN: usize = 92;
const RTM_VERSION: u8 = 5;
const RTF_UP: i32 = 0x1;
const RTF_GATEWAY: i32 = 0x2;
const RTF_HOST: i32 = 0x4;
const RTF_IFSCOPE: i32 = 0x100_0000;
const RTA_DST: i32 = 0x1;
const RTA_NETMASK: i32 = 0x4;
const RTAX_MAX: usize = 8;
const AF_INET: u8 = 2;

#[cfg(target_vendor = "apple")]
const _: () = {
    assert!(std::mem::size_of::<libc::rt_msghdr>() == RT_MSGHDR_LEN);
    assert!(std::mem::offset_of!(libc::rt_msghdr, rtm_version) == 2);
    assert!(std::mem::offset_of!(libc::rt_msghdr, rtm_index) == 4);
    assert!(std::mem::offset_of!(libc::rt_msghdr, rtm_flags) == 8);
    assert!(std::mem::offset_of!(libc::rt_msghdr, rtm_addrs) == 12);
    assert!(libc::RTM_VERSION == RTM_VERSION as libc::c_int);
    assert!(libc::RTF_IFSCOPE == RTF_IFSCOPE);
    assert!(libc::AF_INET == AF_INET as libc::c_int);
};

/// Applies `(interface index, IFT_* link type)` pairs from AF_LINK entries.
#[cfg(target_vendor = "apple")]
pub(super) fn annotate(candidates: &mut [InterfaceAddress], links: &HashMap<String, (u16, u8)>) {
    let routes = default_routes();
    for candidate in candidates {
        let Some(&(index, link_type)) = links.get(&candidate.name) else {
            continue;
        };
        match link_kind(link_type) {
            Some(kind @ ("loopback" | "cellular")) => candidate.interface_type = kind.to_owned(),
            Some(kind) if candidate.interface_type == "unknown" => {
                candidate.interface_type = kind.to_owned();
            }
            _ => {}
        }
        if let Some(&metric) = routes.get(&index) {
            candidate.has_default_route = true;
            candidate.route_metric = Some(metric);
        }
    }
}

/// `<net/if_types.h>`: Wi-Fi also reports IFT_ETHER.
#[cfg(target_vendor = "apple")]
fn link_kind(link_type: u8) -> Option<&'static str> {
    match link_type {
        0x06 => Some("ethernet"),
        0x17 | 0x37 | 0x39 => Some("tunnel"),
        0x18 => Some("loopback"),
        0xff => Some("cellular"),
        _ => None,
    }
}

#[cfg(target_vendor = "apple")]
fn default_routes() -> HashMap<u16, u32> {
    let mut mib = [
        libc::CTL_NET,
        libc::PF_ROUTE,
        0,
        libc::AF_INET,
        libc::NET_RT_DUMP,
        0,
    ];
    for _ in 0..3 {
        let mut size: libc::size_t = 0;
        // SAFETY: a null buffer asks the kernel only for the required size.
        let sized = unsafe {
            libc::sysctl(
                mib.as_mut_ptr(),
                mib.len() as libc::c_uint,
                std::ptr::null_mut(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        };
        if sized != 0 {
            return HashMap::new();
        }
        // Headroom for routes added between the two calls.
        let mut buffer = vec![0_u8; size + 4096];
        let mut length = buffer.len();
        // SAFETY: `buffer` provides `length` writable bytes.
        let read = unsafe {
            libc::sysctl(
                mib.as_mut_ptr(),
                mib.len() as libc::c_uint,
                buffer.as_mut_ptr().cast(),
                &mut length,
                std::ptr::null_mut(),
                0,
            )
        };
        if read == 0 {
            buffer.truncate(length);
            return parse_default_routes(&buffer);
        }
        if std::io::Error::last_os_error().raw_os_error() != Some(libc::ENOMEM) {
            return HashMap::new();
        }
    }
    HashMap::new()
}

/// Interface index -> 0 for the primary default route, 1 when every default
/// through that interface is scoped (`RTF_IFSCOPE`) to it.
pub(super) fn parse_default_routes(buffer: &[u8]) -> HashMap<u16, u32> {
    let mut routes = HashMap::new();
    let mut offset = 0;
    while offset + RT_MSGHDR_LEN <= buffer.len() {
        let length = usize::from(u16::from_ne_bytes([buffer[offset], buffer[offset + 1]]));
        if length < RT_MSGHDR_LEN || offset + length > buffer.len() {
            break;
        }
        let message = &buffer[offset..offset + length];
        offset += length;
        if message[2] != RTM_VERSION {
            continue;
        }
        let index = u16::from_ne_bytes([message[4], message[5]]);
        let flags = i32_at(message, 8);
        let present = i32_at(message, 12);
        if flags & (RTF_UP | RTF_GATEWAY) != RTF_UP | RTF_GATEWAY
            || flags & RTF_HOST != 0
            || !is_default_destination(&message[RT_MSGHDR_LEN..], present)
        {
            continue;
        }
        let metric = u32::from(flags & RTF_IFSCOPE != 0);
        routes
            .entry(index)
            .and_modify(|current: &mut u32| *current = (*current).min(metric))
            .or_insert(metric);
    }
    routes
}

fn i32_at(bytes: &[u8], at: usize) -> i32 {
    i32::from_ne_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

/// Walks the sockaddrs after the header: 0.0.0.0 with an all-zero mask.
fn is_default_destination(mut addresses: &[u8], present: i32) -> bool {
    let mut destination = None;
    let mut zero_mask = true;
    for slot in 0..RTAX_MAX {
        let bit = 1_i32 << slot;
        if present & bit == 0 {
            continue;
        }
        let Some(&length) = addresses.first() else {
            return false;
        };
        let length = usize::from(length);
        // Darwin aligns each sockaddr to 4 bytes; a zero length occupies 4.
        let step = if length == 0 { 4 } else { (length + 3) & !3 };
        if step > addresses.len() {
            return false;
        }
        let sockaddr = &addresses[..length];
        if bit == RTA_DST {
            if sockaddr.len() < 8 || sockaddr[1] != AF_INET {
                return false;
            }
            destination = Some([sockaddr[4], sockaddr[5], sockaddr[6], sockaddr[7]]);
        } else if bit == RTA_NETMASK {
            zero_mask = sockaddr.iter().skip(4).all(|byte| *byte == 0);
        }
        addresses = &addresses[step..];
    }
    destination == Some([0, 0, 0, 0]) && zero_mask
}

#[cfg(test)]
mod tests {
    use super::*;

    const RTA_GATEWAY: i32 = 0x2;

    /// A sockaddr of `length` bytes padded to Darwin's 4-byte alignment.
    fn padded(mut value: Vec<u8>) -> Vec<u8> {
        value.resize(value.len().div_ceil(4) * 4, 0);
        value
    }

    fn sockaddr_in(address: [u8; 4]) -> Vec<u8> {
        let mut value = vec![16, AF_INET, 0, 0];
        value.extend_from_slice(&address);
        value.extend_from_slice(&[0; 8]);
        value
    }

    fn message(
        index: u16,
        flags: i32,
        version: u8,
        addresses: &[Vec<u8>],
        present: i32,
    ) -> Vec<u8> {
        let mut body: Vec<u8> = addresses.concat();
        let length = u16::try_from(RT_MSGHDR_LEN + body.len()).unwrap();
        let mut header = vec![0_u8; RT_MSGHDR_LEN];
        header[0..2].copy_from_slice(&length.to_ne_bytes());
        header[2] = version;
        header[3] = 4;
        header[4..6].copy_from_slice(&index.to_ne_bytes());
        header[8..12].copy_from_slice(&flags.to_ne_bytes());
        header[12..16].copy_from_slice(&present.to_ne_bytes());
        header.append(&mut body);
        header
    }

    #[test]
    fn route_dump_finds_primary_and_scoped_default_routes() {
        let all = RTA_DST | RTA_GATEWAY | RTA_NETMASK;
        let gateway = sockaddr_in([192, 168, 1, 1]);
        let zero_mask = vec![0, 0, 0, 0];
        let default_route = [sockaddr_in([0; 4]), gateway.clone(), zero_mask.clone()];
        let up_gateway = RTF_UP | RTF_GATEWAY;
        let mut dump = Vec::new();
        dump.extend(message(4, up_gateway, RTM_VERSION, &default_route, all));
        dump.extend(message(
            12,
            up_gateway | RTF_IFSCOPE,
            RTM_VERSION,
            &default_route,
            all,
        ));
        dump.extend(message(
            4,
            up_gateway | RTF_IFSCOPE,
            RTM_VERSION,
            &default_route,
            all,
        ));
        // A /24 through en0, a host route and an old message version.
        let subnet_mask = padded(vec![7, 0, 0, 0, 255, 255, 255]);
        dump.extend(message(
            5,
            up_gateway,
            RTM_VERSION,
            &[
                sockaddr_in([192, 168, 1, 0]),
                gateway.clone(),
                subnet_mask.clone(),
            ],
            all,
        ));
        dump.extend(message(
            6,
            up_gateway | RTF_HOST,
            RTM_VERSION,
            &default_route,
            all,
        ));
        dump.extend(message(7, up_gateway, 4, &default_route, all));
        // A non-zero mask on 0.0.0.0 is a split route such as 0.0.0.0/1.
        let half = padded(vec![5, 0, 0, 0, 128]);
        dump.extend(message(
            8,
            up_gateway,
            RTM_VERSION,
            &[sockaddr_in([0; 4]), gateway.clone(), half],
            all,
        ));
        dump.extend(message(9, RTF_UP, RTM_VERSION, &default_route, all));
        let routes = parse_default_routes(&dump);
        assert_eq!(routes, HashMap::from([(4, 0), (12, 1)]));
    }

    #[test]
    fn truncated_or_malformed_dumps_stop_without_panicking() {
        let all = RTA_DST | RTA_GATEWAY | RTA_NETMASK;
        let default_route = [sockaddr_in([0; 4]), sockaddr_in([10, 0, 0, 1]), vec![0; 4]];
        let valid = message(3, RTF_UP | RTF_GATEWAY, RTM_VERSION, &default_route, all);
        for cut in 0..valid.len() {
            let routes = parse_default_routes(&valid[..cut]);
            assert!(routes.is_empty(), "prefix {cut}");
        }
        let mut short = valid.clone();
        short[0..2].copy_from_slice(&10_u16.to_ne_bytes());
        assert!(parse_default_routes(&short).is_empty());
        // A sockaddr length running past the message is rejected.
        let mut overlong = valid.clone();
        overlong[RT_MSGHDR_LEN] = 200;
        assert!(parse_default_routes(&overlong).is_empty());
        assert_eq!(parse_default_routes(&valid), HashMap::from([(3, 0)]));
    }
}
