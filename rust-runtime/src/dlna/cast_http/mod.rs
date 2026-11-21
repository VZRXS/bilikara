//! T4 private cast transport. Independent listener, shared capability and
//! diagnostics for file (F) and live (L) generations. AppState and UI mode
//! selection belong to T5/T6. No existing Host /media route is involved.
//!
//! Contract: design dlna-lessons-and-fix-plan.md §5.2/5.2b/5.5, T4 and §8.3;
//! media-libav/CAST_MUX.md schema 2. Live joins / jumps follow Kirakara-Show,
//! avoiding next's source-IP gate, single-consumer gate and short write timeout.
mod continuity;
#[cfg(test)]
#[path = "../diagnostics/loopback_http.rs"]
pub(crate) mod diagnostic_fixture;
mod diagnostics;
mod live;
mod protocol;
#[cfg(test)]
mod tests;

pub use super::dlna_policy::DeliveryMode;
pub use diagnostics::{HttpDiagnostics, HttpStage, HttpStageResult};
pub use live::{LiveError, LiveOptions, LiveProducer, LiveSnapshot, LiveStream, MAX_RING_BYTES};
pub use protocol::WRITE_STALL;

use super::{CancellationToken, DeviceContext, DlnaError, discovery};
use crate::experimental_libav::cast_mux::CastFile;
use diagnostics::Diagnostics;
use protocol::{ByteRange, Writer};
use std::{
    collections::VecDeque,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::PathBuf,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncSeekExt},
    net::{TcpListener, TcpStream},
    sync::{OwnedSemaphorePermit, Semaphore, broadcast},
    task::{JoinHandle, JoinSet},
};

pub const MAX_SESSIONS: usize = 4;
pub const MAX_GETS: usize = 4;
const MAX_CONNECTIONS: usize = 16;
const MAX_HEADERS: usize = 12;
const MAX_HEADERS_PER_PEER: usize = 4;
const DEFAULT_STAGES: usize = 256;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TsMime {
    #[default]
    Mp2t,
    Mpeg,
}

impl TsMime {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Mp2t => "video/MP2T",
            Self::Mpeg => "video/mpeg",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    Cancelled,
    GenerationEnded,
    Replaced,
    Completed,
    PeerClosed,
    WriteStall,
    WriteError,
    ReadError,
    FileChanged,
    ProducerFailed,
    PublicPeer,
    NotFound,
    Method,
    MalformedRequest,
    IncompleteHeader,
    HeaderTimeout,
    HeaderTooLarge,
    HeaderPreempted,
    Range,
}

impl Reason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Cancelled => "cancelled",
            Self::GenerationEnded => "generation_ended",
            Self::Replaced => "replaced",
            Self::Completed => "completed",
            Self::PeerClosed => "peer_closed",
            Self::WriteStall => "write_stall",
            Self::WriteError => "write_error",
            Self::ReadError => "read_error",
            Self::FileChanged => "file_changed",
            Self::ProducerFailed => "producer_failed",
            Self::PublicPeer => "public_peer",
            Self::NotFound => "not_found",
            Self::Method => "method",
            Self::MalformedRequest => "malformed_request",
            Self::IncompleteHeader => "incomplete_header",
            Self::HeaderTimeout => "header_timeout",
            Self::HeaderTooLarge => "header_too_large",
            Self::HeaderPreempted => "header_preempted",
            Self::Range => "range",
        }
    }
}

#[derive(Debug)]
pub enum EndpointError {
    Route(DlnaError),
    Bind,
    Random,
    SessionLimit,
    InvalidServer,
    InvalidFile,
    StaleGeneration,
    Closed,
}

impl std::fmt::Display for EndpointError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Route(_) => "cast route unavailable",
            Self::Bind => "cast listener unavailable",
            Self::Random => "cast token unavailable",
            Self::SessionLimit => "cast session limit",
            Self::InvalidServer => "invalid cast server identity",
            Self::InvalidFile => "invalid cast file",
            Self::StaleGeneration => "stale cast generation",
            Self::Closed => "cast endpoint closed",
        })
    }
}
impl std::error::Error for EndpointError {}

/// Caller supplies the platform version; values are HTTP tokens, never raw
/// user text. Unknown is usable during discovery / test-only construction.
#[derive(Clone, Debug)]
pub struct ServerIdentity(String);
impl ServerIdentity {
    pub fn new(os: &str, version: &str) -> Result<Self, EndpointError> {
        if [os, version].iter().any(|v| {
            v.is_empty()
                || v.len() > 64
                || !v
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        }) {
            return Err(EndpointError::InvalidServer);
        }
        Ok(Self(format!(
            "{os}/{version} UPnP/1.0 bilikara/{}",
            env!("CARGO_PKG_VERSION")
        )))
    }
}
impl Default for ServerIdentity {
    fn default() -> Self {
        Self::new(std::env::consts::OS, "unknown").expect("static server tokens")
    }
}

pub struct PublishedMedia {
    /// Capability-bearing URI for SetAVTransportURI; never log it.
    pub uri: String,
    pub generation: u64,
    pub mode: DeliveryMode,
    pub content_type: &'static str,
    pub length: Option<u64>,
}

struct FileBody {
    path: PathBuf,
    length: u64,
    mp4: bool,
    converted: bool,
    /// Present while the file is still being rendered behind its declared length.
    growth: Option<Arc<Growth>>,
    // File handles must close before the final T3 lease is dropped (Windows).
    _lease: Option<Arc<CastFile>>,
}

/// Render progress of a file-mode TS published before it is complete
/// (`CastEndpoint::publish_growing_file`). Its length is declared up front;
/// readers wait at the rendered edge, then read on. The renderer reports
/// progress here and stops once the generation is abandoned.
#[derive(Default)]
pub struct Growth {
    written: AtomicU64,
    // 0 rendering, 1 complete (padded to the declared length), 2 failed.
    state: AtomicU8,
    abandoned: AtomicBool,
    wake: tokio::sync::Notify,
}
impl Growth {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }
    /// Bytes now readable from the start of the file (monotonic).
    pub fn advance(&self, written: u64) {
        self.written.fetch_max(written, Ordering::AcqRel);
        self.wake.notify_waiters();
    }
    pub fn complete(&self, written: u64) {
        self.written.fetch_max(written, Ordering::AcqRel);
        self.state.store(1, Ordering::Release);
        self.wake.notify_waiters();
    }
    pub fn fail(&self) {
        self.state.store(2, Ordering::Release);
        self.wake.notify_waiters();
    }
    /// The generation was replaced, cleared or shut down: stop rendering.
    pub fn abandoned(&self) -> bool {
        self.abandoned.load(Ordering::Acquire)
    }
    fn abandon(&self) {
        self.abandoned.store(true, Ordering::Release);
        self.wake.notify_waiters();
    }
}
enum Body {
    File(FileBody),
    Live(Arc<LiveStream>),
}
struct Generation {
    id: u64,
    target: String,
    ts_mime: TsMime,
    body: Body,
    first: AtomicBool,
    cancel: CancellationToken,
}
impl Generation {
    fn mime(&self) -> &'static str {
        match &self.body {
            Body::File(f) if f.mp4 => "video/mp4",
            _ => self.ts_mime.as_str(),
        }
    }
    fn cancel(&self) {
        self.cancel.cancel();
        match &self.body {
            Body::Live(stream) => stream.cancel(),
            Body::File(FileBody {
                growth: Some(growth),
                ..
            }) => growth.abandon(),
            Body::File(_) => {}
        }
    }
}
impl Drop for Generation {
    fn drop(&mut self) {
        self.cancel();
    }
}

#[derive(Clone)]
struct Client {
    id: u64,
    cancel: CancellationToken,
    closed: CancellationToken,
    /// 0 reading, 1 complete, 2 preempted. CAS prevents preemption of a GET
    /// whose header completed concurrently with header-slot selection.
    header_phase: Arc<AtomicU8>,
}
struct Current {
    last: Option<u64>,
    media: Option<Arc<Generation>>,
}
struct Shared {
    stop: CancellationToken,
    current: Mutex<Current>,
    clients: Mutex<VecDeque<Client>>,
    admission: tokio::sync::Mutex<()>,
    next_connection: AtomicU64,
    renderer: Ipv4Addr,
    server: String,
    diag: Diagnostics,
}
impl Shared {
    fn event(
        &self,
        stage: HttpStage,
        generation: Option<u64>,
        id: u64,
        status: Option<u16>,
        result: Result<(), Reason>,
        bytes: u64,
    ) {
        self.diag
            .record(self.stage(stage, generation, id, status, result, bytes));
    }

    fn stage(
        &self,
        stage: HttpStage,
        generation: Option<u64>,
        id: u64,
        status: Option<u16>,
        result: Result<(), Reason>,
        bytes: u64,
    ) -> HttpStageResult {
        HttpStageResult {
            stage,
            context: self.diag.context.clone(),
            generation,
            connection_id: id,
            elapsed: self.diag.clock.elapsed(),
            http_status: status,
            disconnect_reason: (stage == HttpStage::Disconnect)
                .then_some(result.err().unwrap_or(Reason::Completed)),
            result,
            bytes_written: bytes,
            media_time_us: None,
            live_start: None,
        }
    }

    fn clear(&self) {
        let mut current = self.current.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(old) = current.media.take() {
            old.cancel();
        }
    }

    async fn admit(&self, client: &Client) -> Result<(), Reason> {
        let _serial = self.admission.lock().await;
        let oldest = {
            let mut clients = self.clients.lock().unwrap_or_else(|e| e.into_inner());
            clients.retain(|c| !c.closed.is_cancelled());
            if clients.len() == MAX_GETS {
                clients.pop_front()
            } else {
                None
            }
        };
        if let Some(oldest) = oldest {
            oldest.cancel.cancel();
            // The new GET is admitted after the evicted socket closes. Header
            // probes and HEAD never consume any of the four GET slots.
            tokio::select! {
                biased;
                _ = self.stop.cancelled() => return Err(Reason::Cancelled),
                _ = oldest.closed.cancelled() => (),
            }
        }
        self.clients
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push_back(client.clone());
        Ok(())
    }
}

/// One listener / 128-bit token survives file/live generation switches. Dropping
/// cancels it; shutdown additionally joins every reader and releases the port.
/// Global admission bounds independent listeners; per-listener accepted tasks,
/// per-token GETs, ring memory and diagnostic retention have separate bounds.
pub struct CastEndpoint {
    shared: Arc<Shared>,
    address: SocketAddr,
    token: String,
    task: Option<JoinHandle<()>>,
}

fn session_budget() -> Arc<Semaphore> {
    static BUDGET: OnceLock<Arc<Semaphore>> = OnceLock::new();
    BUDGET
        .get_or_init(|| Arc::new(Semaphore::new(MAX_SESSIONS)))
        .clone()
}

impl CastEndpoint {
    /// Local pipeline diagnostic only: no caller-selected listener or receiver.
    #[allow(dead_code)] // P6 wires the pipeline diagnostic into next's Host.
    pub(crate) async fn bind_pipeline() -> Result<Self, EndpointError> {
        Self::bind_on(
            Ipv4Addr::LOCALHOST,
            Ipv4Addr::LOCALHOST,
            DeviceContext {
                device_key: "pipeline".into(),
                udn_hash: None,
                source: super::DiscoverySource::Manual,
                server: String::new(),
                route: None,
            },
            ServerIdentity::default(),
            session_budget(),
            DEFAULT_STAGES,
        )
        .await
    }

    /// Always consult T2's verified system route. The public API cannot select
    /// an unspecified listener or substitute a renderer-supplied bind address.
    pub async fn bind(
        renderer: Ipv4Addr,
        context: DeviceContext,
        server: ServerIdentity,
    ) -> Result<Self, EndpointError> {
        let local = discovery::route_source(renderer).map_err(EndpointError::Route)?;
        Self::bind_on(
            local,
            renderer,
            context,
            server,
            session_budget(),
            DEFAULT_STAGES,
        )
        .await
    }

    async fn bind_on(
        local: Ipv4Addr,
        renderer: Ipv4Addr,
        context: DeviceContext,
        server: ServerIdentity,
        budget: Arc<Semaphore>,
        stages: usize,
    ) -> Result<Self, EndpointError> {
        let permit = budget
            .try_acquire_owned()
            .map_err(|_| EndpointError::SessionLimit)?;
        let mut nonce = [0; 16];
        getrandom::fill(&mut nonce).map_err(|_| EndpointError::Random)?;
        let token = nonce.iter().map(|b| format!("{b:02x}")).collect();
        let listener = TcpListener::bind((local, 0))
            .await
            .map_err(|_| EndpointError::Bind)?;
        let address = listener.local_addr().map_err(|_| EndpointError::Bind)?;
        let shared = Arc::new(Shared {
            stop: CancellationToken::new(),
            current: Mutex::new(Current {
                last: None,
                media: None,
            }),
            clients: Mutex::new(VecDeque::new()),
            admission: tokio::sync::Mutex::new(()),
            next_connection: AtomicU64::new(1),
            renderer,
            server: server.0,
            diag: Diagnostics::new(context, stages),
        });
        shared.event(HttpStage::Listener, None, 0, None, Ok(()), 0);
        let task = tokio::spawn(listen(listener, shared.clone(), permit));
        Ok(Self {
            shared,
            address,
            token,
            task: Some(task),
        })
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.address
    }
    pub fn subscribe(&self) -> broadcast::Receiver<HttpStageResult> {
        self.shared.diag.events.subscribe()
    }
    pub fn diagnostics(&self) -> HttpDiagnostics {
        self.shared.diag.snapshot()
    }

    /// Takes ownership of T3's lease; no arbitrary filesystem resource is served.
    /// Audio conversion is declared with CI=1; live always uses the design's CI=0.
    pub fn publish_file(
        &self,
        generation: u64,
        file: CastFile,
        mime: TsMime,
    ) -> Result<PublishedMedia, EndpointError> {
        self.publish_shared_file(generation, Arc::new(file), mime)
    }

    pub(crate) fn publish_shared_file(
        &self,
        generation: u64,
        file: Arc<CastFile>,
        mime: TsMime,
    ) -> Result<PublishedMedia, EndpointError> {
        let length = std::fs::metadata(file.path())
            .map_err(|_| EndpointError::InvalidFile)?
            .len();
        let mp4 = match file.path().extension().and_then(|s| s.to_str()) {
            Some("mp4") => true,
            Some("ts") => false,
            _ => return Err(EndpointError::InvalidFile),
        };
        if length == 0 || length != file.summary.bytes {
            return Err(EndpointError::InvalidFile);
        }
        let body = FileBody {
            path: file.path().to_owned(),
            length,
            mp4,
            converted: file.summary.audio_transcoded,
            growth: None,
            _lease: Some(file),
        };
        self.publish(generation, Body::File(body), mime)
    }

    /// Publish a TS file whose final length is declared (`file.summary.bytes`)
    /// while it is still being rendered; `growth` reports the readable
    /// prefix. HTTP semantics are those of a file: Content-Length, Range and
    /// HEAD use the declared length, and reads wait at the rendered edge.
    pub fn publish_growing_file(
        &self,
        generation: u64,
        file: CastFile,
        growth: Arc<Growth>,
        mime: TsMime,
    ) -> Result<PublishedMedia, EndpointError> {
        let length = file.summary.bytes;
        if length == 0
            || !length.is_multiple_of(188)
            || file.path().extension().and_then(|s| s.to_str()) != Some("ts")
        {
            return Err(EndpointError::InvalidFile);
        }
        let body = FileBody {
            path: file.path().to_owned(),
            length,
            mp4: false,
            converted: file.summary.audio_transcoded,
            growth: Some(growth),
            _lease: Some(Arc::new(file)),
        };
        self.publish(generation, Body::File(body), mime)
    }

    pub fn publish_live(
        &self,
        generation: u64,
        stream: Arc<LiveStream>,
        mime: TsMime,
    ) -> Result<PublishedMedia, EndpointError> {
        self.publish(generation, Body::Live(stream), mime)
    }

    fn publish(
        &self,
        id: u64,
        body: Body,
        ts_mime: TsMime,
    ) -> Result<PublishedMedia, EndpointError> {
        if self.shared.stop.is_cancelled() {
            return Err(EndpointError::Closed);
        }
        let (mode, length, extension) = match &body {
            Body::File(f) => (
                DeliveryMode::File,
                Some(f.length),
                if f.mp4 { "mp4" } else { "ts" },
            ),
            Body::Live(_) => (DeliveryMode::Live, None, "ts"),
        };
        let mut current = self
            .shared
            .current
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if current.last.is_some_and(|last| id <= last) {
            return Err(EndpointError::StaleGeneration);
        }
        let media = Arc::new(Generation {
            id,
            target: format!("/cast/{}/{id}.{extension}", self.token),
            ts_mime,
            body,
            first: AtomicBool::new(false),
            cancel: CancellationToken::new(),
        });
        let output = PublishedMedia {
            uri: format!("http://{}{}", self.address, media.target),
            generation: id,
            mode,
            content_type: media.mime(),
            length,
        };
        if let Some(old) = current.media.replace(media) {
            old.cancel();
        }
        current.last = Some(id);
        self.shared.diag.generation(id);
        Ok(output)
    }

    pub fn clear_generation(&self) {
        self.shared.clear();
    }

    pub async fn shutdown(mut self) -> HttpDiagnostics {
        self.shared.stop.cancel();
        self.shared.clear();
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
        self.diagnostics()
    }
}
impl Drop for CastEndpoint {
    fn drop(&mut self) {
        self.shared.stop.cancel();
        self.shared.clear();
    }
}

async fn listen(listener: TcpListener, shared: Arc<Shared>, _permit: OwnedSemaphorePermit) {
    let mut tasks = JoinSet::new();
    let mut headers: VecDeque<(IpAddr, Client)> = VecDeque::new();
    loop {
        headers.retain(|(_, c)| {
            c.header_phase.load(Ordering::Acquire) == 0 && !c.closed.is_cancelled()
        });
        tokio::select! {
            biased;
            _ = shared.stop.cancelled() => break,
            Some(_) = tasks.join_next(), if !tasks.is_empty() => (),
            result = listener.accept(), if tasks.len() < MAX_CONNECTIONS || !headers.is_empty() => {
                match result {
                    Ok((socket, peer)) => {
                        headers.retain(|(_, c)| c.header_phase.load(Ordering::Acquire) == 0 && !c.closed.is_cancelled());
                        let peer_count = headers.iter().filter(|(ip, _)| *ip == peer.ip()).count();
                        let victim = if peer_count >= MAX_HEADERS_PER_PEER {
                            headers.iter().position(|(ip, _)| *ip == peer.ip())
                        } else if headers.len() >= MAX_HEADERS || tasks.len() >= MAX_CONNECTIONS {
                            (!headers.is_empty()).then_some(0)
                        } else { None };
                        if let Some(victim) = victim {
                            let (_, oldest) = headers.remove(victim).expect("header victim");
                            if oldest.header_phase.compare_exchange(0, 2, Ordering::AcqRel, Ordering::Acquire).is_ok() {
                              oldest.cancel.cancel();
                              tokio::select! {
                                _ = shared.stop.cancelled() => break,
                                _ = oldest.closed.cancelled() => (),
                              }
                            }
                        }
                        while tasks.try_join_next().is_some() {}
                        // A completed header can race the snapshot above. Wait
                        // for a task slot rather than growing the accepted set.
                        if tasks.len() >= MAX_CONNECTIONS {
                            tokio::select! {
                                _ = shared.stop.cancelled() => break,
                                _ = tasks.join_next() => (),
                            }
                        }
                        // Tokio explicitly performs nonblocking readiness IO on
                        // accepted sockets on Windows too. WouldBlock is waited
                        // on by AsyncWriteExt, never treated as a disconnect.
                        let client = Client { id: shared.next_connection.fetch_add(1, Ordering::Relaxed), cancel: CancellationToken::new(), closed: CancellationToken::new(), header_phase: Arc::new(AtomicU8::new(0)) };
                        headers.push_back((peer.ip(), client.clone()));
                        let state = shared.clone();
                        tasks.spawn(async move {
                            serve(socket, peer.ip(), &state, &client).await;
                            // serve owns the socket and all file reader leases;
                            // its return precedes admission of a replacement.
                            client.closed.cancel();
                            state.clients.lock().unwrap_or_else(|e| e.into_inner()).retain(|c| c.id != client.id);
                        });
                    }
                    Err(_) => { shared.stop.cancel(); break; }
                }
            }
        }
    }
    drop(listener);
    shared.clear();
    while tasks.join_next().await.is_some() {}
}

async fn serve(mut socket: TcpStream, peer: IpAddr, shared: &Shared, client: &Client) {
    let _ = socket.set_nodelay(true);
    let header = tokio::select! {
        biased;
        _ = shared.stop.cancelled() => Err(Reason::Cancelled),
        _ = client.cancel.cancelled() => Err(Reason::HeaderPreempted),
        result = protocol::read_header(&mut socket, &shared.stop) => result,
    };
    let header = if client
        .header_phase
        .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        Err(Reason::HeaderPreempted)
    } else {
        header
    };
    let header = match header {
        Ok(header) => header,
        Err(reason) => {
            shared.event(HttpStage::Rejected, None, client.id, None, Err(reason), 0);
            shared.event(HttpStage::Disconnect, None, client.id, None, Err(reason), 0);
            return;
        }
    };
    let request = protocol::parse(&header);
    let media = shared
        .current
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .media
        .clone();
    let found = media.as_ref().filter(|g| {
        request
            .as_ref()
            .is_ok_and(|r| protocol::same_target(&r.target, &g.target))
    });
    let denial = if !protocol::private_peer(peer) {
        Some((403, Reason::PublicPeer))
    } else if request.is_err() {
        Some((400, Reason::MalformedRequest))
    } else if found.is_none() {
        Some((404, Reason::NotFound))
    } else if !request
        .as_ref()
        .is_ok_and(|r| matches!(r.method.as_str(), "GET" | "HEAD"))
    {
        Some((405, Reason::Method))
    } else {
        None
    };
    let mut writer = Writer {
        socket: &mut socket,
        shared,
        generation: found.map(|g| &**g),
        connection: client,
        status: None,
        bytes: 0,
        media: None,
    };
    if let Some((status, reason)) = denial {
        writer.status = Some(status);
        writer.event(HttpStage::Rejected, Err(reason));
        let headers = protocol::headers(shared, writer.generation, status, Some(0), None);
        let result = writer.send(&headers, false).await;
        writer.event(HttpStage::Disconnect, result.and(Err(reason)));
        return;
    }
    let media = found.expect("validated generation");
    let request = request.expect("validated request");
    if peer != IpAddr::V4(shared.renderer) {
        writer.event(HttpStage::PeerMismatch, Ok(()));
    }
    let head = request.method == "HEAD";
    if !head && let Err(reason) = shared.admit(client).await {
        writer.event(HttpStage::Disconnect, Err(reason));
        return;
    }
    let (status, length, range, offset) = match &media.body {
        Body::Live(_) => (200, None, None, 0),
        Body::File(file) => match protocol::byte_range(request.range.as_deref(), file.length) {
            ByteRange::Full => (200, Some(file.length), None, 0),
            ByteRange::Partial { start, length } => {
                (206, Some(length), Some((start, length, file.length)), start)
            }
            ByteRange::Unsatisfiable => (416, Some(0), Some((0, 0, file.length)), 0),
        },
    };
    writer.status = Some(status);
    if head || matches!(media.body, Body::File(_)) {
        writer.event(
            if head {
                HttpStage::Head
            } else {
                HttpStage::Get
            },
            Ok(()),
        );
    }
    if status == 416 {
        writer.event(HttpStage::Rejected, Err(Reason::Range));
    }
    let response = protocol::headers(shared, Some(media), status, length, range);
    let result = async {
        writer.send(&response, false).await?;
        if head || status == 416 {
            return Ok(());
        }
        match &media.body {
            Body::File(file) => {
                serve_file(&mut writer, file, offset, length.expect("file length")).await
            }
            Body::Live(stream) => serve_live(&mut writer, stream).await,
        }
    }
    .await;
    if !head && matches!(media.body, Body::Live(_)) && writer.media.is_none() {
        writer.event(HttpStage::Get, result);
    }
    writer.event(HttpStage::BytesWritten, Ok(()));
    writer.event(HttpStage::Disconnect, result);
}

async fn serve_file(
    writer: &mut Writer<'_>,
    file: &FileBody,
    offset: u64,
    mut remaining: u64,
) -> Result<(), Reason> {
    // Open the already-private local file before starting async operations. A
    // cancelled async open can otherwise outlive the generation's T3 lease.
    let handle = std::fs::File::open(&file.path).map_err(|_| Reason::ReadError)?;
    let mut input = tokio::fs::File::from_std(handle);
    let result = async {
        let metadata = writer
            .wait(input.metadata())
            .await?
            .map_err(|_| Reason::ReadError)?;
        let growing = file.growth.as_deref();
        if !metadata.is_file()
            || metadata.len() > file.length
            || (growing.is_none() && metadata.len() != file.length)
        {
            return Err(Reason::FileChanged);
        }
        writer
            .wait(input.seek(std::io::SeekFrom::Start(offset)))
            .await?
            .map_err(|_| Reason::ReadError)?;
        let mut block = [0; 64 * 1024];
        let mut position = offset;
        while remaining != 0 {
            let readable = match growing {
                Some(growth) => rendered(writer, growth, position).await? - position,
                None => remaining,
            };
            let size = remaining.min(readable).min(block.len() as u64) as usize;
            let count = writer
                .wait(input.read(&mut block[..size]))
                .await?
                .map_err(|_| Reason::ReadError)?;
            if count == 0 {
                return Err(Reason::FileChanged);
            }
            writer.send(&block[..count], true).await?;
            remaining -= count as u64;
            position += count as u64;
        }
        Ok(())
    }
    .await;
    // A cancelled Tokio read may still own a blocking file operation. Wait for
    // that bounded local read before closing, then release the T3 lease.
    drop(input.into_std().await);
    result
}

/// Wait until bytes past `position` are rendered; return the readable end.
/// A render that makes no progress for the write-stall period ends the read.
async fn rendered(writer: &Writer<'_>, growth: &Growth, position: u64) -> Result<u64, Reason> {
    let mut deadline = tokio::time::Instant::now() + WRITE_STALL;
    loop {
        // Register before inspecting progress: no wakeup can be lost.
        let notified = growth.wake.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        let written = growth.written.load(Ordering::Acquire);
        match growth.state.load(Ordering::Acquire) {
            2 => return Err(Reason::ProducerFailed),
            _ if written > position => return Ok(written),
            // Complete files are padded to their declared length.
            1 => return Err(Reason::FileChanged),
            _ => {}
        }
        match writer
            .wait(tokio::time::timeout_at(deadline, notified))
            .await?
        {
            Ok(()) => {
                if growth.written.load(Ordering::Acquire) > written {
                    deadline = tokio::time::Instant::now() + WRITE_STALL;
                }
            }
            Err(_) => return Err(Reason::WriteStall),
        }
    }
}

async fn serve_live(writer: &mut Writer<'_>, stream: &LiveStream) -> Result<(), Reason> {
    let mut cursor = live::Cursor::new();
    let mut continuity = continuity::Continuity::new();
    let mut origin = None;
    let mut clock = tokio::time::Instant::now();
    loop {
        // Register before inspecting the ring: no notification can be lost
        // between the empty check and awaiting new producer data.
        let notified = stream.wake.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        match stream.read(&mut cursor) {
            live::Read::Data {
                chunks,
                time_us,
                jumped,
                start,
                playback_us,
            } => {
                let joined = writer.media.is_none();
                writer.media = Some((time_us, start));
                if joined {
                    writer.event(HttpStage::Get, Ok(()));
                }
                if jumped {
                    writer.event(HttpStage::LiveJump, Ok(()));
                    for packet in continuity.discontinuities() {
                        writer.send(&packet, true).await?;
                    }
                    origin = None;
                }
                let start = *origin.get_or_insert_with(|| {
                    clock = tokio::time::Instant::now();
                    playback_us
                });
                let delay = Duration::from_micros(time_us.saturating_sub(start).max(0) as u64)
                    .saturating_sub(stream.options.burst);
                writer.wait(tokio::time::sleep_until(clock + delay)).await?;
                // All continuations of this PES unit are pinned. Eviction or
                // lag can only change the cursor after this complete unit.
                for bytes in chunks {
                    let mut bytes = bytes.to_vec();
                    continuity.rewrite(&mut bytes);
                    writer.send(&bytes, true).await?;
                }
            }
            live::Read::Wait => {
                writer.wait(notified).await?;
            }
            live::Read::End(result) => {
                return result.map_err(|error| {
                    if error == LiveError::Cancelled {
                        Reason::GenerationEnded
                    } else {
                        Reason::ProducerFailed
                    }
                });
            }
        }
    }
}
