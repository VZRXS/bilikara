//! getifaddrs(3) enumeration shared by Linux, Android, macOS and iOS.

use super::InterfaceAddress;
use std::ffi::CStr;
use std::net::Ipv4Addr;

pub(super) fn interfaces() -> Vec<InterfaceAddress> {
    let mut head: *mut libc::ifaddrs = std::ptr::null_mut();
    // SAFETY: on success getifaddrs stores a list that stays valid until the
    // matching freeifaddrs call below.
    if unsafe { libc::getifaddrs(&mut head) } != 0 {
        return Vec::new();
    }
    let mut candidates = Vec::new();
    #[cfg(target_vendor = "apple")]
    let mut links = std::collections::HashMap::new();
    let mut current = head;
    while !current.is_null() {
        // SAFETY: `current` is a node of the list returned above.
        let entry = unsafe { &*current };
        current = entry.ifa_next;
        if entry.ifa_addr.is_null() || entry.ifa_name.is_null() {
            continue;
        }
        // SAFETY: getifaddrs provides NUL-terminated names and a valid
        // address whose family selects the concrete sockaddr type.
        let name = unsafe { CStr::from_ptr(entry.ifa_name) }
            .to_string_lossy()
            .into_owned();
        let family = i32::from(unsafe { (*entry.ifa_addr).sa_family });
        match family {
            libc::AF_INET => {
                // SAFETY: AF_INET entries point to a sockaddr_in.
                let sockaddr = unsafe { &*entry.ifa_addr.cast::<libc::sockaddr_in>() };
                candidates.push(address(name, sockaddr, entry.ifa_flags));
            }
            #[cfg(target_vendor = "apple")]
            libc::AF_LINK => {
                // SAFETY: AF_LINK entries point to a sockaddr_dl.
                let link = unsafe { &*entry.ifa_addr.cast::<libc::sockaddr_dl>() };
                links.insert(name, (link.sdl_index, link.sdl_type));
            }
            _ => {}
        }
    }
    // SAFETY: `head` came from the successful getifaddrs call above.
    unsafe { libc::freeifaddrs(head) };
    #[cfg(target_vendor = "apple")]
    super::apple::annotate(&mut candidates, &links);
    #[cfg(any(target_os = "linux", target_os = "android"))]
    super::linux::annotate(
        &mut candidates,
        std::path::Path::new("/sys/class/net"),
        std::path::Path::new("/proc/net/route"),
    );
    candidates
}

fn address(name: String, sockaddr: &libc::sockaddr_in, flags: libc::c_uint) -> InterfaceAddress {
    let has = |flag: libc::c_int| flags & flag as libc::c_uint != 0;
    let interface_type = if has(libc::IFF_LOOPBACK) {
        "loopback"
    } else if has(libc::IFF_POINTOPOINT) {
        "tunnel"
    } else {
        "unknown"
    };
    InterfaceAddress {
        name,
        address: Ipv4Addr::from(sockaddr.sin_addr.s_addr.to_ne_bytes()).to_string(),
        // Without a carrier (IFF_RUNNING) a configured address is unreachable.
        is_up: Some(has(libc::IFF_UP) && has(libc::IFF_RUNNING)),
        interface_type: interface_type.to_owned(),
        ..InterfaceAddress::default()
    }
}
