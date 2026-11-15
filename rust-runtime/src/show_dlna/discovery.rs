//! Kirakara's Windows discovery flow: system UPnP, SSDP NOTIFY and M-SEARCH.

use super::{Advertisement, HTTP_TIMEOUT, NetworkPolicy, Renderer, lan_url, load_description};
use socket2::{Domain, Protocol, Socket, Type};
use std::collections::{HashMap, HashSet};
use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};
use url::{Host, Url};

#[cfg(windows)]
mod windows;

const MULTICAST: Ipv4Addr = Ipv4Addr::new(239, 255, 255, 250);
const SSDP_PORT: u16 = 1900;
const SEARCH_WINDOW: Duration = Duration::from_secs(40);
const POLL_INTERVAL: Duration = Duration::from_millis(20);
const SEND_INTERVAL: Duration = Duration::from_millis(80);
const DESCRIPTION_RETRY: Duration = Duration::from_secs(1);
const MAX_LOCATIONS: usize = 128;
const DESCRIPTION_WORKERS: usize = 8;
const MEDIA_RENDERER: &str = "urn:schemas-upnp-org:device:MediaRenderer:1";
const SEARCH_TARGETS: [&str; 4] = [MEDIA_RENDERER, "ssdp:all", MEDIA_RENDERER, "ssdp:all"];

enum Event {
    Seen {
        location: String,
        usn: String,
        sender: Option<Ipv4Addr>,
        reply_on: Option<Ipv4Addr>,
    },
    Left {
        usn: String,
        sender: Option<Ipv4Addr>,
    },
}

pub fn discover(
    cancelled: impl Fn() -> bool,
    publish: impl FnMut(Vec<Renderer>),
) -> Result<(), String> {
    let interfaces: Vec<Ipv4Addr> = crate::local_lan_ipv4_addresses()
        .iter()
        .filter_map(|value| value.parse().ok())
        .filter(|&address| NetworkPolicy::Lan.allows(address))
        .collect();
    if interfaces.is_empty() {
        return Err("DLNA discovery requires an active LAN IPv4 interface".to_owned());
    }
    if cancelled() {
        return Ok(());
    }

    let channels: Vec<_> = interfaces
        .iter()
        .filter_map(|&address| search_socket(address).ok().map(|socket| (socket, address)))
        .collect();
    let notify = match notify_socket(&interfaces, SSDP_PORT) {
        Ok(socket) => Some(socket),
        Err(error) => {
            eprintln!("[show-cast] SSDP NOTIFY listener unavailable: {error}");
            None
        }
    };
    let (system_sender, system_events) = mpsc::sync_channel::<Event>(MAX_LOCATIONS);
    #[cfg(windows)]
    let system = match windows::Discovery::start(system_sender) {
        Ok(discovery) => Some(discovery),
        Err(error) => {
            eprintln!("[show-cast] Windows UPnP discovery unavailable: {error}");
            None
        }
    };
    #[cfg(not(windows))]
    let system: Option<()> = {
        drop(system_sender);
        None
    };
    if channels.is_empty() && notify.is_none() && system.is_none() {
        return Err("DLNA discovery could not open any SSDP listener".to_owned());
    }
    eprintln!(
        "[show-cast] DLNA discovery: Windows UPnP={}, NOTIFY={}, M-SEARCH interfaces={}",
        system.is_some(),
        notify.is_some(),
        channels.len()
    );

    let mut targets = SEARCH_TARGETS.into_iter();
    let mut send_at = Instant::now();
    let mut packet = [0_u8; 16 * 1024];
    collect_renderers(
        &interfaces,
        NetworkPolicy::Lan,
        SEARCH_WINDOW,
        move |events| {
            if Instant::now() >= send_at
                && let Some(target) = targets.next()
            {
                let request = search_request(target);
                for (socket, _) in &channels {
                    let _ = socket.send_to(request.as_bytes(), (MULTICAST, SSDP_PORT));
                }
                send_at = Instant::now() + SEND_INTERVAL;
            }
            #[cfg(windows)]
            if let Some(system) = &system {
                system.pump_messages();
            }
            events.extend(system_events.try_iter().take(MAX_LOCATIONS));
            if let Some(socket) = &notify {
                receive_packets(socket, None, &mut packet, events);
            }
            for (socket, address) in &channels {
                receive_packets(socket, Some(*address), &mut packet, events);
            }
        },
        cancelled,
        publish,
    );
    Ok(())
}

fn search_socket(interface: Ipv4Addr) -> io::Result<UdpSocket> {
    let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    socket.bind(&SocketAddr::from((interface, 0)).into())?;
    socket.set_multicast_if_v4(&interface)?;
    socket.set_multicast_ttl_v4(4)?;
    socket.set_nonblocking(true)?;
    Ok(socket.into())
}

fn route_source(target: Ipv4Addr) -> Option<Ipv4Addr> {
    // UDP connect selects a source address through the routing table without sending.
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    socket.connect((target, SSDP_PORT)).ok()?;
    match socket.local_addr().ok()?.ip() {
        IpAddr::V4(address) => Some(address),
        _ => None,
    }
}

fn notify_socket(interfaces: &[Ipv4Addr], port: u16) -> io::Result<UdpSocket> {
    let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    socket.set_reuse_address(true)?;
    socket.bind(&SocketAddr::from((Ipv4Addr::UNSPECIFIED, port)).into())?;
    // On Winsock this also controls reception from same-PC publishers such as ChunK Helper.
    socket.set_multicast_loop_v4(true)?;
    socket.set_nonblocking(true)?;
    for interface in interfaces {
        if let Err(error) = socket.join_multicast_v4(&MULTICAST, interface) {
            eprintln!("[show-cast] SSDP multicast join on {interface} failed: {error}");
        }
    }
    Ok(socket.into())
}

fn search_request(target: &str) -> String {
    format!(
        "M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: {target}\r\nUSER-AGENT: Windows/10 UPnP/1.1 bilikara/0.8\r\n\r\n"
    )
}

fn receive_packets(
    socket: &UdpSocket,
    reply_on: Option<Ipv4Addr>,
    packet: &mut [u8],
    events: &mut Vec<Event>,
) {
    // Keep noisy sockets from starving other interfaces or delaying cancellation.
    for _ in 0..64 {
        let Ok((length, sender)) = socket.recv_from(packet) else {
            break;
        };
        if let IpAddr::V4(sender) = sender.ip()
            && let Some(event) = parse_packet(&packet[..length], sender, reply_on)
        {
            events.push(event);
        }
    }
}

fn canonical_id(usn: &str) -> String {
    usn.split("::")
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
}

fn parse_packet(packet: &[u8], sender: Ipv4Addr, reply_on: Option<Ipv4Addr>) -> Option<Event> {
    let text = String::from_utf8_lossy(packet);
    let mut lines = text.lines();
    let mut start = lines.next()?.split_ascii_whitespace();
    let first = start.next()?;
    let second = start.next()?;
    if reply_on.is_some() {
        if !(first.eq_ignore_ascii_case("HTTP/1.1") || first.eq_ignore_ascii_case("HTTP/1.0"))
            || second != "200"
        {
            return None;
        }
    } else if !first.eq_ignore_ascii_case("NOTIFY")
        || second != "*"
        || !start.next()?.eq_ignore_ascii_case("HTTP/1.1")
        || start.next().is_some()
    {
        return None;
    }

    let mut location = None;
    let mut nts = None;
    let mut usn = "";
    for line in lines.take_while(|line| !line.trim().is_empty()) {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim();
        let value = value.trim();
        if name.eq_ignore_ascii_case("location") {
            if location.replace(value).is_some() {
                return None;
            }
        } else if name.eq_ignore_ascii_case("nts") {
            nts = Some(value);
        } else if name.eq_ignore_ascii_case("usn") {
            usn = value;
        }
    }
    let usn = canonical_id(usn);
    if reply_on.is_none() {
        let nts = nts?;
        if nts.eq_ignore_ascii_case("ssdp:byebye") {
            return (!usn.is_empty()).then_some(Event::Left {
                usn,
                sender: Some(sender),
            });
        }
        if !nts.eq_ignore_ascii_case("ssdp:alive") && !nts.eq_ignore_ascii_case("ssdp:update") {
            return None;
        }
    }
    Some(Event::Seen {
        location: location?.to_owned(),
        usn,
        sender: Some(sender),
        reply_on,
    })
}

struct Candidate {
    load_id: u64,
    usn: String,
    helper: Option<Ipv4Addr>,
    renderer: Option<Renderer>,
    retry_at: Option<Instant>,
}

struct DescriptionJob {
    load_id: u64,
    advertisement: Advertisement,
}

fn accept_location(
    location: &str,
    sender: Option<Ipv4Addr>,
    reply_on: Option<Ipv4Addr>,
    interfaces: &[Ipv4Addr],
    policy: NetworkPolicy,
) -> Option<(Url, Ipv4Addr, Option<Ipv4Addr>)> {
    let (url, address) = lan_url(location, policy).ok()?;
    let helper = sender.filter(|&sender| sender != address);
    // A same-PC NOTIFY publisher can announce a renderer hosted on another LAN address.
    if helper.is_some_and(|sender| reply_on.is_some() || !interfaces.contains(&sender)) {
        return None;
    }
    Some((url, address, helper))
}

fn collect_renderers(
    interfaces: &[Ipv4Addr],
    policy: NetworkPolicy,
    window: Duration,
    mut receive: impl FnMut(&mut Vec<Event>),
    cancelled: impl Fn() -> bool,
    mut publish: impl FnMut(Vec<Renderer>),
) {
    let deadline = Instant::now() + window;
    let done = AtomicBool::new(false);
    let (jobs, requests) = mpsc::sync_channel::<DescriptionJob>(MAX_LOCATIONS);
    let requests = Mutex::new(requests);
    let (results, descriptions) = mpsc::channel();
    thread::scope(|scope| {
        for _ in 0..DESCRIPTION_WORKERS {
            scope.spawn(|| {
                loop {
                    let job = requests.lock().unwrap().recv();
                    let Ok(job) = job else { break };
                    let timeout = deadline
                        .saturating_duration_since(Instant::now())
                        .min(HTTP_TIMEOUT);
                    if done.load(Ordering::Relaxed) || timeout.is_zero() {
                        break;
                    }
                    let renderer = load_description(&job.advertisement, timeout, policy).ok();
                    let _ = results.send((job.advertisement.location, job.load_id, renderer));
                }
            });
        }

        let mut candidates = HashMap::<Url, Candidate>::new();
        let mut events = Vec::new();
        let mut load_id = 0;
        while !cancelled() && Instant::now() < deadline {
            receive(&mut events);
            let mut changed = false;
            for event in events.drain(..) {
                match event {
                    Event::Seen {
                        location,
                        usn,
                        sender,
                        reply_on,
                    } => {
                        let Some((location, address, helper)) =
                            accept_location(&location, sender, reply_on, interfaces, policy)
                        else {
                            continue;
                        };
                        if let Some(known) = candidates.get_mut(&location) {
                            known.helper = helper.or(known.helper);
                            if known.usn.is_empty() {
                                known.usn = usn.clone();
                            }
                            if known
                                .retry_at
                                .is_none_or(|retry_at| Instant::now() < retry_at)
                            {
                                continue;
                            }
                        } else if candidates.len() >= MAX_LOCATIONS {
                            continue;
                        }
                        let Some(local_address) = route_source(address)
                            .filter(|source| interfaces.contains(source))
                            .or(reply_on)
                        else {
                            continue;
                        };
                        load_id += 1;
                        let advertisement = Advertisement {
                            location: location.clone(),
                            usn: usn.clone(),
                            local_address,
                        };
                        if jobs
                            .try_send(DescriptionJob {
                                load_id,
                                advertisement,
                            })
                            .is_ok()
                        {
                            candidates.insert(
                                location,
                                Candidate {
                                    load_id,
                                    usn,
                                    helper,
                                    renderer: None,
                                    retry_at: None,
                                },
                            );
                        }
                    }
                    Event::Left { usn, sender } => {
                        candidates.retain(|location, candidate| {
                            let matches_id = candidate.usn == usn
                                || candidate
                                    .renderer
                                    .as_ref()
                                    .is_some_and(|renderer| canonical_id(&renderer.id) == usn);
                            let matches_sender = sender.is_none_or(|sender| {
                                location.host() == Some(Host::Ipv4(sender))
                                    || candidate.helper == Some(sender)
                            });
                            let remove = matches_id && matches_sender;
                            changed |= remove && candidate.renderer.is_some();
                            !remove
                        });
                    }
                }
            }
            for (location, load_id, renderer) in descriptions.try_iter() {
                if let Some(candidate) = candidates.get_mut(&location)
                    && candidate.load_id == load_id
                {
                    changed |= renderer.is_some();
                    candidate.retry_at = renderer
                        .is_none()
                        .then(|| Instant::now() + DESCRIPTION_RETRY);
                    candidate.renderer = renderer;
                }
            }
            if changed && !cancelled() {
                let mut renderers: Vec<_> = candidates
                    .values()
                    .filter_map(|candidate| candidate.renderer.clone())
                    .collect();
                renderers.sort_by_cached_key(|r| {
                    (
                        r.name.to_lowercase(),
                        canonical_id(&r.id),
                        r.location.clone(),
                    )
                });
                let mut seen = HashSet::new();
                renderers.retain(|r| seen.insert(canonical_id(&r.id)));
                publish(renderers);
            }
            thread::sleep(POLL_INTERVAL);
        }
        // Stop receiving before waiting for any already-started, bounded HTTP requests.
        done.store(true, Ordering::Relaxed);
        drop(jobs);
        drop(receive);
    });
}

#[cfg(test)]
mod tests;
