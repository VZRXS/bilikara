// Ported from VZRXS/bilikara PR #120 by FMPeach (MIT), commit 297ae1de,
// rust-runtime/src/show_dlna/discovery.rs. See THIRD_PARTY_NOTICES.md.
//! Per-interface M-SEARCH plus best-effort NOTIFY. Async description tasks are
//! aborted when discovery ends; cancellation never joins blocking HTTP workers.

use super::*;
use dlna_policy::{
    AdvertisementKind, SsdpChannel, SsdpMessage, accept_advertisement, canonical_usn, lan_url,
    parse_description, parse_ssdp, select_local_source, validate_route_source,
};
use socket2::{Domain, Protocol, Socket, Type};
use std::collections::{HashMap, HashSet};
use std::io;
use std::net::{SocketAddr, UdpSocket as StdUdpSocket};
use tokio::net::UdpSocket;
use tokio::task::{AbortHandle, JoinSet};

#[cfg(test)]
#[path = "diagnostics/loopback_discovery.rs"]
pub(crate) mod diagnostic_fixture;

const MULTICAST: Ipv4Addr = Ipv4Addr::new(239, 255, 255, 250);
const SSDP_PORT: u16 = 1900;
pub const SEARCH_WINDOW: Duration = Duration::from_secs(40);
const POLL_INTERVAL: Duration = Duration::from_millis(20);
const SEND_INTERVAL: Duration = Duration::from_millis(80);
const DESCRIPTION_RETRY: Duration = Duration::from_secs(1);
const FAILURE_TTL: Duration = Duration::from_secs(45);
const CANDIDATE_TTL: Duration = Duration::from_secs(60);
const MAX_FAILURES: usize = 512;
const MAX_DESCRIPTION_ATTEMPTS: u8 = 3;
const MAX_LOCATIONS: usize = 128;
const DESCRIPTION_WORKERS: usize = 8;
const MAX_STAGES: usize = 512;
const SEARCH_TARGETS: [&str; 6] = [
    dlna_policy::MEDIA_RENDERER,
    "urn:schemas-upnp-org:service:AVTransport:1",
    "ssdp:all",
    dlna_policy::MEDIA_RENDERER,
    "urn:schemas-upnp-org:service:AVTransport:1",
    "ssdp:all",
];

#[derive(Clone, Debug)]
pub enum DiscoveryUpdate {
    Renderers(Vec<Renderer>),
    Stage(StageResult),
    /// Cumulative number omitted from the returned bounded stage buffer.
    StagesDropped(usize),
}

/// A bounded 40-second scan; publish receives incremental snapshots and stage
/// facts. NOTIFY binding/join failures degrade to M-SEARCH and remain visible.
pub async fn discover(
    cancel: &CancellationToken,
    publish: impl FnMut(DiscoveryUpdate),
) -> Operation<Vec<Renderer>> {
    let _multicast = crate::cast_platform::DiscoveryLease::acquire();
    let (interfaces, policy, options) = discovery_setup();
    discover_on(interfaces, policy, options, cancel, publish).await
}

fn discovery_setup() -> (Vec<Ipv4Addr>, NetworkPolicy, Options) {
    #[cfg(test)]
    if let Some(setup) = lease_tests::setup() {
        return setup;
    }
    (
        local_ipv4(NetworkPolicy::Lan),
        NetworkPolicy::Lan,
        Options::default(),
    )
}

pub fn route_source(target: Ipv4Addr) -> Result<Ipv4Addr, DlnaError> {
    if !NetworkPolicy::Lan.allows(target) {
        return Err(PolicyError::AddressNotAllowed.into());
    }
    route_source_on(target, &local_ipv4(NetworkPolicy::Lan), NetworkPolicy::Lan)
}

pub(super) fn route_source_on(
    target: Ipv4Addr,
    interfaces: &[Ipv4Addr],
    policy: NetworkPolicy,
) -> Result<Ipv4Addr, DlnaError> {
    validate_route_source(system_route_source(target)?, interfaces, policy).map_err(Into::into)
}

pub(super) fn system_route_source(target: Ipv4Addr) -> Result<Ipv4Addr, DlnaError> {
    // UDP connect consults the OS routing table without sending any packet.
    let socket = StdUdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))
        .map_err(|_| DlnaError::new(ErrorCode::RouteUnavailable))?;
    socket
        .connect((target, SSDP_PORT))
        .map_err(|_| DlnaError::new(ErrorCode::RouteUnavailable))?;
    match socket
        .local_addr()
        .map_err(|_| DlnaError::new(ErrorCode::RouteUnavailable))?
        .ip()
    {
        IpAddr::V4(address) => Ok(address),
        _ => Err(DlnaError::new(ErrorCode::RouteUnavailable)),
    }
}

/// Manual description URL fallback uses the same policy and route validation.
pub async fn load_renderer(location: &str, cancel: &CancellationToken) -> Operation<Renderer> {
    load_on(
        location,
        "",
        "",
        &local_ipv4(NetworkPolicy::Lan),
        NetworkPolicy::Lan,
        HTTP_TIMEOUT,
        cancel,
    )
    .await
}

async fn load_on(
    location: &str,
    usn: &str,
    server: &str,
    interfaces: &[Ipv4Addr],
    policy: NetworkPolicy,
    timeout: Duration,
    cancel: &CancellationToken,
) -> Operation<Renderer> {
    let since = Instant::now();
    let mut context = DeviceContext::new(DiscoverySource::Manual, location, usn, server);
    let route = if cancel.is_cancelled() {
        Err(DlnaError::new(ErrorCode::Cancelled))
    } else {
        lan_url(location, policy)
            .map_err(DlnaError::from)
            .and_then(|(_, address)| {
                choose_source(
                    address,
                    None,
                    interfaces,
                    policy,
                    system_route_source,
                    &mut context,
                )
            })
    };
    let stages = vec![StageResult::new(Stage::Route, since, None, &route).for_device(&context)];
    let local = match route {
        Ok(local) => local,
        Err(error) => {
            return Operation {
                result: Err(error),
                stages,
                dropped_stages: 0,
            };
        }
    };
    let input = DescriptionRequest {
        location: location.to_owned(),
        usn: usn.to_owned(),
        server: server.to_owned(),
        local,
        context,
        attempt: 1,
    };
    let mut operation = load_description(http_client(local, timeout), input, policy, cancel).await;
    operation.stages.splice(0..0, stages);
    operation
}

fn choose_source(
    target: Ipv4Addr,
    reply_on: Option<Ipv4Addr>,
    interfaces: &[Ipv4Addr],
    policy: NetworkPolicy,
    lookup: fn(Ipv4Addr) -> Result<Ipv4Addr, DlnaError>,
    context: &mut DeviceContext,
) -> Result<Ipv4Addr, DlnaError> {
    let routed = lookup(target).ok();
    let selected = select_local_source(target, routed, reply_on, interfaces, policy);
    context.route = Some(RouteFacts {
        selection: selected.as_ref().ok().map(|source| source.kind),
        routed_source_is_local: routed
            .map(|source| validate_route_source(source, interfaces, policy).is_ok()),
        route_matches_selected: routed
            .zip(selected.as_ref().ok())
            .map(|(route, selected)| route == selected.address),
        route_matches_reply: routed.zip(reply_on).map(|(route, reply)| route == reply),
    });
    selected.map(|source| source.address).map_err(Into::into)
}

struct DescriptionRequest {
    location: String,
    usn: String,
    server: String,
    local: Ipv4Addr,
    context: DeviceContext,
    attempt: u8,
}

async fn load_description(
    client: Result<reqwest::Client, DlnaError>,
    input: DescriptionRequest,
    policy: NetworkPolicy,
    cancel: &CancellationToken,
) -> Operation<Renderer> {
    let since = Instant::now();
    let mut status = None;
    let result = async {
        let client = client?;
        let (url, _) = lan_url(&input.location, policy)?;
        let reply = http_request(
            &client,
            url,
            None,
            dlna_policy::MAX_DESCRIPTION_BYTES,
            cancel,
        )
        .await?;
        status = Some(reply.status);
        if !(200..300).contains(&reply.status) {
            return Err(DlnaError::new(ErrorCode::HttpStatus).status(reply.status));
        }
        let description = parse_description(
            &reply.body,
            &input.location,
            &input.usn,
            &input.server,
            policy,
        )
        .map_err(|error| DlnaError::from(error).status(reply.status))?;
        let mut context = input.context.clone();
        context.udn_hash = (description.id != description.location)
            .then(|| identifier_hash(&canonical_usn(&description.id)));
        Ok(Renderer {
            description,
            local_address: input.local,
            context,
        })
    }
    .await;
    let context = result
        .as_ref()
        .map(|renderer| &renderer.context)
        .unwrap_or(&input.context);
    let mut stage =
        StageResult::new(Stage::Description, since, status, &result).for_device(context);
    stage.attempt = input.attempt;
    Operation {
        result,
        stages: vec![stage],
        dropped_stages: 0,
    }
}

#[derive(Clone)]
struct Options {
    window: Duration,
    destination: SocketAddr,
    notify_port: u16,
    route_lookup: fn(Ipv4Addr) -> Result<Ipv4Addr, DlnaError>,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            window: SEARCH_WINDOW,
            destination: (MULTICAST, SSDP_PORT).into(),
            notify_port: SSDP_PORT,
            route_lookup: system_route_source,
        }
    }
}

struct SearchChannel {
    socket: UdpSocket,
    interface: Ipv4Addr,
}
struct Sockets {
    search: Vec<SearchChannel>,
    notify: Option<UdpSocket>,
}

fn search_socket(interface: Ipv4Addr) -> io::Result<UdpSocket> {
    let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    socket.bind(&SocketAddr::from((interface, 0)).into())?;
    socket.set_multicast_if_v4(&interface)?;
    socket.set_multicast_ttl_v4(4)?;
    socket.set_multicast_loop_v4(true)?;
    socket.set_nonblocking(true)?;
    UdpSocket::from_std(socket.into())
}

fn open_sockets(
    interfaces: &[Ipv4Addr],
    port: u16,
    record: &mut impl FnMut(StageResult),
) -> Sockets {
    let mut search = Vec::new();
    for &interface in interfaces {
        let since = Instant::now();
        let result = search_socket(interface).map_err(|_| DlnaError::new(ErrorCode::SocketBind));
        record(StageResult::new(Stage::SearchBind, since, None, &result));
        if let Ok(socket) = result {
            search.push(SearchChannel { socket, interface });
        }
    }
    let since = Instant::now();
    let notify = (|| {
        let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
        socket.set_reuse_address(true)?;
        socket.bind(&SocketAddr::from((Ipv4Addr::UNSPECIFIED, port)).into())?;
        socket.set_multicast_loop_v4(true)?;
        socket.set_nonblocking(true)?;
        Ok::<_, io::Error>(socket)
    })()
    .map_err(|_| DlnaError::new(ErrorCode::SocketBind));
    let mut stage = StageResult::new(Stage::NotifyListen, since, None, &notify);
    if stage.result.is_err() {
        stage.disposition = Disposition::Ignored;
    }
    record(stage);
    let notify = notify.ok().and_then(|socket| {
        for interface in interfaces {
            let since = Instant::now();
            let result = socket
                .join_multicast_v4(&MULTICAST, interface)
                .map_err(|_| DlnaError::new(ErrorCode::MulticastJoin));
            let mut stage = StageResult::new(Stage::MulticastJoin, since, None, &result);
            if stage.result.is_err() {
                stage.disposition = Disposition::Ignored;
            }
            record(stage);
        }
        match UdpSocket::from_std(socket.into()) {
            Ok(socket) => Some(socket),
            Err(_) => {
                let result: Result<(), _> = Err(DlnaError::new(ErrorCode::SocketBind));
                let mut stage =
                    StageResult::new(Stage::NotifyListen, Instant::now(), None, &result);
                stage.disposition = Disposition::Ignored;
                record(stage);
                None
            }
        }
    });
    Sockets { search, notify }
}

fn search_request(target: &str) -> String {
    format!(
        "M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: {target}\r\nUSER-AGENT: UPnP/1.1 bilikara/0.8\r\n\r\n"
    )
}

async fn discover_on(
    interfaces: Vec<Ipv4Addr>,
    policy: NetworkPolicy,
    options: Options,
    cancel: &CancellationToken,
    mut publish: impl FnMut(DiscoveryUpdate),
) -> Operation<Vec<Renderer>> {
    let since = Instant::now();
    let mut stages = StageLog::default();
    let mut record = |stage: StageResult| {
        record(stage, &mut publish, &mut stages);
    };
    let result = if cancel.is_cancelled() {
        Err(DlnaError::new(ErrorCode::Cancelled))
    } else if interfaces.is_empty() {
        Err(DlnaError::new(ErrorCode::NoInterfaces))
    } else {
        let sockets = open_sockets(&interfaces, options.notify_port, &mut record);
        if sockets.search.is_empty() && sockets.notify.is_none() {
            Err(DlnaError::new(ErrorCode::DiscoveryUnavailable))
        } else {
            // End the record borrow before collection uses the same publisher.
            collect_renderers(
                &interfaces,
                policy,
                options,
                sockets,
                cancel,
                &mut publish,
                &mut stages,
            )
            .await
        }
    };
    let stage = StageResult::new(Stage::Discovery, since, None, &result);
    publish(DiscoveryUpdate::Stage(stage.clone()));
    // record() reserves the last buffer slot for this scan-wide result.
    stages.entries.push(stage);
    Operation {
        result,
        stages: stages.entries,
        dropped_stages: stages.dropped,
    }
}

struct Candidate {
    load_id: u64,
    usn: String,
    server: String,
    helper: Option<Ipv4Addr>,
    local: Ipv4Addr,
    renderer: Option<Renderer>,
    context: DeviceContext,
    attempt: u8,
    last_seen: u64,
    expires: Instant,
    loading: Option<(Instant, AbortHandle)>,
}

impl Candidate {
    fn abort(&self) {
        if let Some((_, task)) = &self.loading {
            task.abort();
        }
    }
}

struct Failure {
    attempt: u8,
    terminal: bool,
    retry_at: Instant,
    expires: Instant,
}

impl Failure {
    fn new(error: &DlnaError, attempt: u8, now: Instant) -> Self {
        // Only transport and temporary server failures can change on retry.
        let transient = error.is_network()
            || error
                .http_status
                .is_some_and(|s| s == 408 || s == 429 || (500..600).contains(&s));
        Self {
            attempt,
            terminal: !transient || attempt >= MAX_DESCRIPTION_ATTEMPTS,
            retry_at: now + DESCRIPTION_RETRY * (1 << (attempt.saturating_sub(1).min(5))),
            expires: now + FAILURE_TTL,
        }
    }
    fn permits(&self, now: Instant) -> bool {
        !self.terminal && now >= self.retry_at
    }
}

fn expire_entries(
    candidates: &mut HashMap<String, Candidate>,
    failures: &mut HashMap<String, Failure>,
    now: Instant,
) -> bool {
    failures.retain(|_, failure| now < failure.expires);
    let mut changed = false;
    candidates.retain(|_, candidate| {
        if now >= candidate.expires {
            candidate.abort();
            changed |= candidate.renderer.is_some();
            false
        } else {
            true
        }
    });
    changed
}

struct Seen {
    message: SsdpMessage,
    sender: Ipv4Addr,
    reply_on: Option<Ipv4Addr>,
}

fn receive_packets(socket: &UdpSocket, reply_on: Option<Ipv4Addr>, events: &mut Vec<Seen>) {
    let mut buffer = [0; dlna_policy::MAX_SSDP_BYTES + 1];
    for _ in 0..64 {
        let Ok((length, sender)) = socket.try_recv_from(&mut buffer) else {
            break;
        };
        let channel = if reply_on.is_some() {
            SsdpChannel::SearchResponse
        } else {
            SsdpChannel::Notify
        };
        if let IpAddr::V4(sender) = sender.ip()
            && let Some(message) = parse_ssdp(&buffer[..length], channel)
        {
            events.push(Seen {
                message,
                sender,
                reply_on,
            });
        }
    }
}

fn snapshot(candidates: &HashMap<String, Candidate>) -> Vec<Renderer> {
    let mut renderers: Vec<_> = candidates
        .values()
        .filter_map(|c| c.renderer.clone())
        .collect();
    renderers.sort_by_cached_key(|r| {
        (
            r.description.name.to_lowercase(),
            canonical_usn(&r.description.id),
            r.description.location.clone(),
        )
    });
    let mut seen = HashSet::new();
    renderers.retain(|r| seen.insert(canonical_usn(&r.description.id)));
    renderers
}

#[derive(Default)]
struct StageLog {
    entries: Vec<StageResult>,
    dropped: usize,
}

#[cfg(test)]
impl std::ops::Deref for StageLog {
    type Target = [StageResult];
    fn deref(&self) -> &Self::Target {
        &self.entries
    }
}

fn record(stage: StageResult, publish: &mut impl FnMut(DiscoveryUpdate), stages: &mut StageLog) {
    // Bound retained storage without hiding later devices from live consumers.
    publish(DiscoveryUpdate::Stage(stage.clone()));
    if stages.entries.len() < MAX_STAGES - 1 {
        stages.entries.push(stage);
    } else {
        stages.dropped += 1;
        publish(DiscoveryUpdate::StagesDropped(stages.dropped));
    }
}

fn interrupted_descriptions(
    candidates: &HashMap<String, Candidate>,
    code: ErrorCode,
    publish: &mut impl FnMut(DiscoveryUpdate),
    stages: &mut StageLog,
) {
    for candidate in candidates.values() {
        if let Some((since, _)) = &candidate.loading {
            let result: Result<(), _> = Err(DlnaError::new(code));
            let mut stage = StageResult::new(Stage::Description, *since, None, &result)
                .for_device(&candidate.context);
            stage.attempt = candidate.attempt;
            record(stage, publish, stages);
        }
    }
}

async fn collect_renderers(
    interfaces: &[Ipv4Addr],
    policy: NetworkPolicy,
    options: Options,
    sockets: Sockets,
    cancel: &CancellationToken,
    publish: &mut impl FnMut(DiscoveryUpdate),
    stages: &mut StageLog,
) -> Result<Vec<Renderer>, DlnaError> {
    let deadline = Instant::now() + options.window;
    let mut send_at = Instant::now();
    let mut targets = SEARCH_TARGETS.into_iter();
    let mut candidates = HashMap::<String, Candidate>::new();
    let mut failures = HashMap::<String, Failure>::new();
    let mut clients = HashMap::new();
    let mut jobs = JoinSet::new();
    let mut events = Vec::new();
    let mut load_id = 0;
    let mut seen_id = 0;
    loop {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                interrupted_descriptions(&candidates, ErrorCode::Cancelled, publish, stages);
                return Err(DlnaError::new(ErrorCode::Cancelled));
            },
            _ = tokio::time::sleep(POLL_INTERVAL) => {}
        }
        if Instant::now() >= deadline {
            interrupted_descriptions(&candidates, ErrorCode::Timeout, publish, stages);
            break;
        }
        if Instant::now() >= send_at
            && let Some(target) = targets.next()
        {
            let request = search_request(target);
            for channel in &sockets.search {
                let since = Instant::now();
                let result = tokio::select! {
                    biased;
                    _ = cancel.cancelled() => return Err(DlnaError::new(ErrorCode::Cancelled)),
                    result = channel.socket.send_to(request.as_bytes(), options.destination) => result.map(|_| ()).map_err(|_| DlnaError::new(ErrorCode::SearchSend)),
                };
                record(
                    StageResult::new(Stage::SearchSend, since, None, &result),
                    publish,
                    stages,
                );
            }
            send_at = Instant::now() + SEND_INTERVAL;
        }
        if let Some(notify) = &sockets.notify {
            receive_packets(notify, None, &mut events);
        }
        for channel in &sockets.search {
            receive_packets(&channel.socket, Some(channel.interface), &mut events);
        }
        let mut changed = expire_entries(&mut candidates, &mut failures, Instant::now());
        for Seen {
            message,
            sender,
            reply_on,
        } in events.drain(..)
        {
            if message.kind == AdvertisementKind::Byebye {
                candidates.retain(|location, candidate| {
                    let matches_id = candidate.usn == message.usn
                        || candidate
                            .renderer
                            .as_ref()
                            .is_some_and(|r| canonical_usn(&r.description.id) == message.usn);
                    let matches_sender = lan_url(location, policy)
                        .is_ok_and(|(_, address)| address == sender)
                        || candidate.helper == Some(sender);
                    let remove = matches_id && matches_sender;
                    changed |= remove && candidate.renderer.is_some();
                    if remove {
                        candidate.abort();
                    }
                    !remove
                });
                continue;
            }
            let Some(location) = message.location else {
                continue;
            };
            let source = if reply_on.is_some() {
                DiscoverySource::SearchResponse
            } else {
                DiscoverySource::Notify
            };
            let mut context = DeviceContext::new(source, &location, &message.usn, &message.server);
            let since = Instant::now();
            let accepted = accept_advertisement(&location, sender, reply_on, interfaces, policy)
                .map_err(DlnaError::from);
            let accepted = match accepted {
                Ok(value) => value,
                Err(error) => {
                    record(
                        StageResult::new(Stage::Advertisement, since, None, &Err::<(), _>(error))
                            .for_device(&context),
                        publish,
                        stages,
                    );
                    continue;
                }
            };
            let location = accepted.url.to_string();
            seen_id += 1;
            if let Some(candidate) = candidates.get_mut(&location) {
                candidate.last_seen = seen_id;
                candidate.expires = Instant::now() + CANDIDATE_TTL;
                candidate.helper = accepted.helper.or(candidate.helper);
                if candidate.usn.is_empty() {
                    candidate.usn = message.usn;
                }
                if !message.server.is_empty() {
                    candidate.server = message.server;
                    candidate.context.server = candidate.server.chars().take(256).collect();
                    if let Some(renderer) = candidate.renderer.as_mut() {
                        renderer
                            .context
                            .server
                            .clone_from(&candidate.context.server);
                        let description = &mut renderer.description;
                        let vendor = dlna_policy::vendor_class(&[
                            &description.manufacturer,
                            &description.model_name,
                            &description.model_description,
                            &description.name,
                            &candidate.server,
                        ]);
                        changed |= vendor != description.vendor_class;
                        description.vendor_class = vendor;
                    }
                }
                continue;
            }
            let attempt = if let Some(failure) = failures.get(&location) {
                if !failure.permits(Instant::now()) {
                    continue;
                }
                failure.attempt + 1
            } else {
                1
            };
            if candidates.len() >= MAX_LOCATIONS {
                // Protect confirmed renderers first; preempt the oldest pending
                // candidate, including its HTTP task, so a flood cannot pin slots.
                if let Some(oldest) = candidates
                    .iter()
                    .min_by_key(|(_, c)| (c.renderer.is_some(), c.loading.is_none(), c.last_seen))
                    .map(|(location, _)| location.clone())
                    && let Some(candidate) = candidates.remove(&oldest)
                {
                    candidate.abort();
                    changed |= candidate.renderer.is_some();
                }
            }
            let since = Instant::now();
            let route = choose_source(
                accepted.address,
                reply_on,
                interfaces,
                policy,
                options.route_lookup,
                &mut context,
            );
            record(
                StageResult::new(Stage::Route, since, None, &route).for_device(&context),
                publish,
                stages,
            );
            let Ok(local) = route else { continue };
            load_id += 1;
            candidates.insert(
                location,
                Candidate {
                    load_id,
                    usn: message.usn,
                    server: message.server,
                    helper: accepted.helper,
                    local,
                    renderer: None,
                    context,
                    attempt,
                    last_seen: seen_id,
                    expires: Instant::now() + CANDIDATE_TTL,
                    loading: None,
                },
            );
        }
        while let Some(completed) = jobs.try_join_next() {
            let Ok((location, id, operation)) = completed else {
                continue;
            };
            let operation: Operation<Renderer> = operation;
            if !candidates.get(&location).is_some_and(|c| c.load_id == id) {
                continue;
            }
            for stage in operation.stages {
                record(stage, publish, stages);
            }
            if let Ok(mut renderer) = operation.result {
                let candidate = candidates.get_mut(&location).expect("matched load id");
                candidate.loading = None;
                // A later announcement can supply a SERVER header while HTTP
                // is in flight. Preserve it without changing the correlation key.
                renderer
                    .context
                    .server
                    .clone_from(&candidate.context.server);
                renderer.description.vendor_class = dlna_policy::vendor_class(&[
                    &renderer.description.manufacturer,
                    &renderer.description.model_name,
                    &renderer.description.model_description,
                    &renderer.description.name,
                    &candidate.server,
                ]);
                candidate.context = renderer.context.clone();
                candidate.renderer = Some(renderer);
                failures.remove(&location);
                changed = true;
            } else if let Err(error) = operation.result {
                let candidate = candidates.remove(&location).expect("matched load id");
                if failures.len() >= MAX_FAILURES
                    && let Some(oldest) = failures
                        .iter()
                        .min_by_key(|(_, f)| f.expires)
                        .map(|(key, _)| key.clone())
                {
                    failures.remove(&oldest);
                }
                failures.insert(
                    location,
                    Failure::new(&error, candidate.attempt, Instant::now()),
                );
            }
        }
        // Most recently advertised candidates enter the bounded worker pool
        // first. Old queued junk must not delay a newly received real renderer.
        let mut queued: Vec<_> = candidates
            .iter()
            .filter(|(_, c)| c.renderer.is_none() && c.loading.is_none())
            .map(|(location, c)| (c.last_seen, location.clone()))
            .collect();
        queued.sort_unstable_by(|a, b| b.cmp(a));
        for (_, location) in queued {
            if jobs.len() >= DESCRIPTION_WORKERS {
                break;
            }
            if let Some(candidate) = candidates.get_mut(&location) {
                let input = DescriptionRequest {
                    location: location.clone(),
                    usn: candidate.usn.clone(),
                    server: candidate.server.clone(),
                    local: candidate.local,
                    context: candidate.context.clone(),
                    attempt: candidate.attempt,
                };
                let client = clients
                    .entry(candidate.local)
                    .or_insert_with(|| http_client(candidate.local, HTTP_TIMEOUT))
                    .clone();
                let id = candidate.load_id;
                let cancel = cancel.clone();
                let task = jobs.spawn(async move {
                    let operation = load_description(client, input, policy, &cancel).await;
                    (location, id, operation)
                });
                candidate.loading = Some((Instant::now(), task));
            }
        }
        if changed {
            publish(DiscoveryUpdate::Renderers(snapshot(&candidates)));
        }
    }
    // JoinSet drop aborts requests, including header/body stalls, without waiting.
    Ok(snapshot(&candidates))
}

#[cfg(test)]
pub(crate) mod lease_tests;
#[cfg(test)]
mod tests;
