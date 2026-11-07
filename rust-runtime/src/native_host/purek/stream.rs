//! Private capability endpoint. Operational buffers are bounded; AppState owns
//! admission, generation, lifecycle and public output status.
use super::*;
use std::{
    collections::VecDeque,
    io::Write,
    net::{IpAddr, TcpListener, TcpStream},
    sync::{
        Condvar, Mutex,
        atomic::{AtomicI64, AtomicU64, AtomicUsize},
    },
    time::Duration,
};

const MAX_BYTES: usize = 16 * 1024 * 1024;
const MAX_SPAN_US: i64 = 4_000_000;
/// Receivers commonly stop reading while they open a decoder. Backpressure is
/// normal; only a sustained stall, matching the 15 s unread rule, disconnects.
const WRITE_STALL: Duration = Duration::from_secs(15);
#[derive(Clone, Copy)]
pub(super) enum Framing {
    Close,
    Chunked,
}
struct Chunk {
    data: Vec<u8>,
    time: i64,
    key: bool,
}
#[derive(Default)]
struct Queue {
    chunks: VecDeque<Chunk>,
    bytes: usize,
    eof: bool,
    error: bool,
    consumer: bool,
    gop_bytes: usize,
    last_time: i64,
}
pub(super) struct Running {
    pub duration_us: AtomicI64,
    pub level: &'static str,
    pub stop: AtomicBool,
    queue: Mutex<Queue>,
    wake: Condvar,
    clock: Instant,
    pub played: AtomicBool,
    pub delivered: AtomicBool,
    announced: AtomicBool,
    rejected: AtomicU64,
    clients: AtomicUsize,
    generation: u64,
    framing: Framing,
    protocol: capabilities::TsProtocol,
    capability: String,
    pub(super) preview: Option<Arc<super::preview::Preview>>,
    pub trace: Arc<super::trace::OutputTrace>,
}
impl Running {
    #[cfg(test)]
    pub fn new(generation: u64, framing: Framing) -> Result<Arc<Self>, ApiError> {
        Self::with_level(generation, framing, false)
    }
    #[cfg(test)]
    pub fn with_level(generation: u64, framing: Framing, l1: bool) -> Result<Arc<Self>, ApiError> {
        Self::with_protocol(
            generation,
            framing,
            l1,
            capabilities::TsProtocol::Mp2t,
            super::trace::OutputTrace::new(false),
        )
    }
    pub fn with_protocol(
        generation: u64,
        framing: Framing,
        l1: bool,
        protocol: capabilities::TsProtocol,
        trace: Arc<super::trace::OutputTrace>,
    ) -> Result<Arc<Self>, ApiError> {
        let mut random = [0u8; 16];
        getrandom::fill(&mut random).map_err(|_| failure(503, "random", "无法初始化媒体会话"))?;
        Ok(Arc::new(Self {
            duration_us: AtomicI64::new(0),
            level: if l1 { "L1" } else { "L0" },
            stop: AtomicBool::new(false),
            queue: Mutex::new(Queue::default()),
            wake: Condvar::new(),
            clock: Instant::now(),
            played: AtomicBool::new(false),
            delivered: AtomicBool::new(false),
            announced: AtomicBool::new(false),
            rejected: AtomicU64::new(0),
            clients: AtomicUsize::new(0),
            generation,
            framing,
            protocol,
            preview: None,
            capability: random.iter().map(|b| format!("{b:02x}")).collect(),
            trace,
        }))
    }
    pub fn cancel(&self) {
        self.stop.store(true, Ordering::Release);
        self.wake.notify_all();
        if let Some(preview) = &self.preview {
            preview.wake();
        }
    }
    pub fn publish(&self) {
        if self.played.load(Ordering::Acquire)
            && self.delivered.load(Ordering::Acquire)
            && !self.announced.swap(true, Ordering::AcqRel)
        {
            super::output::mark_streaming(self.generation);
        }
    }
    pub fn finished(&self, error: bool) {
        if let Some(preview) = &self.preview {
            preview.finish(self.generation, error, self.stop.load(Ordering::Acquire));
        }
        if let Ok(mut q) = self.queue.lock() {
            q.eof = true;
            q.error = error;
        }
        self.wake.notify_all();
    }
    pub fn drained(&self) -> bool {
        self.queue
            .lock()
            .is_ok_and(|q| q.eof && !q.error && q.chunks.is_empty() && !q.consumer)
    }
    pub fn has_consumer(&self) -> bool {
        if let Some(preview) = &self.preview {
            return preview.recent();
        }
        self.queue.lock().is_ok_and(|q| q.consumer)
    }
    pub fn advancing(&self) -> bool {
        !self.stop.load(Ordering::Acquire)
            && self.has_consumer()
            && self.trace.recent_delivery(WRITE_STALL)
    }
    pub fn generation(&self) -> u64 {
        self.generation
    }
    pub fn preview_nonce(&self) -> String {
        self.capability.clone()
    }
    pub fn push(&self, data: &[u8], time: i64, key: bool) -> bool {
        if let Some(preview) = &self.preview {
            while time as i128 - self.clock.elapsed().as_micros() as i128 > 2_000_000 {
                if self.stop.load(Ordering::Acquire) {
                    return false;
                }
                thread::sleep(Duration::from_millis(20));
            }
            return preview.push(self.generation, data, time, key, &self.stop);
        }
        let Ok(mut q) = self.queue.lock() else {
            return false;
        };
        let gop = if key {
            data.len()
        } else {
            q.gop_bytes.saturating_add(data.len())
        };
        if data.len() > 24064 || time < q.last_time || gop > MAX_BYTES {
            q.error = true;
            return false;
        }
        while !self.stop.load(Ordering::Acquire) {
            let span = q.chunks.front().map_or(0, |c| time - c.time);
            let ahead = time as i128 - self.clock.elapsed().as_micros() as i128;
            if q.bytes + data.len() <= MAX_BYTES && span <= MAX_SPAN_US && ahead <= 2_000_000 {
                q.bytes += data.len();
                q.gop_bytes = gop;
                q.last_time = time;
                q.chunks.push_back(Chunk {
                    data: data.to_vec(),
                    time,
                    key,
                });
                self.wake.notify_all();
                return true;
            }
            let Ok((next, _)) = self.wake.wait_timeout(q, Duration::from_millis(50)) else {
                return false;
            };
            q = next;
        }
        false
    }
    pub fn bind(
        self: &Arc<Self>,
        context: &Arc<HostContext>,
        local: Ipv4Addr,
        receiver: Ipv4Addr,
    ) -> Result<String, ApiError> {
        let listener = TcpListener::bind((local, 0)).map_err(|_| network_error())?;
        listener
            .set_nonblocking(true)
            .map_err(|_| network_error())?;
        let port = listener.local_addr().map_err(|_| network_error())?.port();
        let running = self.clone();
        let host = context.clone();
        context
            .spawn("purek-stream-listener", move || {
                while !running.stop.load(Ordering::Acquire) && !host.stop.load(Ordering::Acquire) {
                    match listener.accept() {
                        Ok((socket, peer)) => {
                            // Windows sockets inherit the listener's non-blocking
                            // mode; a full send buffer would then end the stream.
                            if socket.set_nonblocking(false).is_err() {
                                continue;
                            }
                            let permitted = peer.ip() == IpAddr::V4(receiver);
                            // A category only: a different pulling host on the
                            // receiver's /24, never either address.
                            let same_subnet = matches!(peer.ip(), IpAddr::V4(ip)
                                if ip.octets()[..3] == receiver.octets()[..3]);
                            if !permitted {
                                running.rejected.fetch_add(1, Ordering::Relaxed);
                            }
                            if running.clients.fetch_add(1, Ordering::AcqRel) >= 4 {
                                running.clients.fetch_sub(1, Ordering::AcqRel);
                                running.trace.request(super::trace::Request::Overflow);
                                continue;
                            }
                            let session = running.clone();
                            if host
                                .spawn("purek-stream-client", move || {
                                    session.serve(socket, permitted, same_subnet);
                                    session.clients.fetch_sub(1, Ordering::AcqRel);
                                })
                                .is_err()
                            {
                                running.clients.fetch_sub(1, Ordering::AcqRel);
                            }
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(20))
                        }
                        Err(_) => {
                            running.cancel();
                            break;
                        }
                    }
                }
                running.cancel();
            })
            .map_err(|_| network_error())?;
        self.trace.listener_ready();
        Ok(format!(
            "http://{local}:{port}/purek/stream/{}.ts",
            self.capability
        ))
    }
    fn headers(&self, head: bool) -> Vec<u8> {
        let encoding = match self.framing {
            Framing::Chunked => "Transfer-Encoding: chunked\r\n",
            Framing::Close => "",
        };
        let _ = head;
        let mime = self.protocol.mime();
        format!("HTTP/1.1 200 OK\r\nContent-Type: {mime}\r\n{encoding}Connection: close\r\nCache-Control: no-store\r\ntransferMode.dlna.org: Streaming\r\ncontentFeatures.dlna.org: DLNA.ORG_OP=00;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000\r\n\r\n").into_bytes()
    }
    /// Writes all bytes to the non-blocking consumer. Returns a disconnect
    /// category; cancellation is observed even while the receiver is paused.
    fn send(&self, socket: &mut TcpStream, mut data: &[u8]) -> Result<(), &'static str> {
        let mut progress = Instant::now();
        while !data.is_empty() {
            if self.stop.load(Ordering::Acquire) {
                return Err("cancelled");
            }
            match socket.write(data) {
                Ok(0) => return Err("peer_closed"),
                Ok(size) => {
                    data = &data[size..];
                    progress = Instant::now();
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    if progress.elapsed() >= WRITE_STALL {
                        return Err("stalled");
                    }
                    thread::sleep(Duration::from_millis(2));
                }
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::ConnectionReset
                            | std::io::ErrorKind::ConnectionAborted
                            | std::io::ErrorKind::BrokenPipe
                    ) =>
                {
                    return Err("peer_closed");
                }
                Err(_) => return Err("write_error"),
            }
        }
        Ok(())
    }
    fn serve(&self, mut socket: TcpStream, permitted: bool, same_subnet: bool) {
        use super::trace::Request;
        let _ = socket.set_read_timeout(Some(Duration::from_millis(200)));
        let _ = socket.set_write_timeout(Some(Duration::from_millis(200)));
        let mut bytes = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(2);
        while !bytes.ends_with(b"\r\n\r\n")
            && bytes.len() < 8192
            && Instant::now() < deadline
            && !self.stop.load(Ordering::Acquire)
        {
            let mut byte = [0; 1];
            match socket.read(&mut byte) {
                Ok(1) => bytes.push(byte[0]),
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) =>
                {
                    continue;
                }
                _ => return,
            }
        }
        let Ok(request) = std::str::from_utf8(&bytes) else {
            return;
        };
        let first: Vec<_> = request
            .lines()
            .next()
            .unwrap_or_default()
            .split(' ')
            .collect();
        let expected = format!("/purek/stream/{}.ts", self.capability);
        let valid = first.len() == 3
            && first[1].len() == expected.len()
            && first[1]
                .bytes()
                .zip(expected.bytes())
                .fold(0, |a, (b, c)| a | (b ^ c))
                == 0;
        // Wait for the bounded request header before any HTTP response. An
        // immediate denial on accept can race the client's request write and
        // cause an unexpected-message error or TCP reset instead of HTTP 403.
        // Denied peers share the client limit and never reach the media queue.
        let error = if !permitted {
            Some(("403 Forbidden", Request::RejectedPeer { same_subnet }))
        } else if self.stop.load(Ordering::Acquire) {
            Some(("410 Gone", Request::Gone))
        } else if !bytes.ends_with(b"\r\n\r\n") {
            Some(("404 Not Found", Request::Incomplete))
        } else if !valid {
            Some(("404 Not Found", Request::NotFound))
        } else if !matches!(first[0], "GET" | "HEAD") {
            Some(("405 Method Not Allowed", Request::Method))
        } else {
            None
        };
        if let Some((error, kind)) = error {
            self.trace.request(kind);
            let _ = write!(
                socket,
                "HTTP/1.1 {error}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
            return;
        }
        if first[0] == "HEAD" {
            self.trace.request(Request::Head);
            let _ = socket.write_all(&self.headers(true));
            return;
        }
        self.trace.request(Request::Get);
        let Ok(mut q) = self.queue.lock() else {
            return;
        };
        if q.consumer {
            self.trace.request(Request::Conflict);
            let _ = socket.write_all(
                b"HTTP/1.1 409 Conflict\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            );
            return;
        }
        q.consumer = true;
        drop(q);
        struct Release<'a>(&'a Running);
        impl Drop for Release<'_> {
            fn drop(&mut self) {
                if let Ok(mut q) = self.0.queue.lock() {
                    q.consumer = false;
                }
                self.0.wake.notify_all();
            }
        }
        let _release = Release(self);
        self.trace.request(Request::Stream);
        let outcome = self.stream(&mut socket);
        self.trace.disconnect(outcome);
    }
    /// One media consumer. Returns the connection's disconnect category.
    fn stream(&self, socket: &mut TcpStream) -> &'static str {
        // Media writes are non-blocking: WouldBlock is ordinary backpressure,
        // unlike a send timeout, which leaves a Windows socket indeterminate.
        if socket.set_nonblocking(true).is_err() {
            return "socket_error";
        }
        if let Err(outcome) = self.send(socket, &self.headers(false)) {
            return outcome;
        }
        let mut clock = Instant::now();
        let mut origin = None;
        let mut need_key = true;
        while !self.stop.load(Ordering::Acquire) {
            // An RST can arrive after a buffered write succeeded. Check the
            // pending socket error even while production is idle so the old
            // consumer cannot prevent the receiver's next GET. Do not treat
            // a read-side FIN as failure: HTTP clients may half-close requests.
            if !socket.take_error().is_ok_and(|error| error.is_none()) {
                return "peer_closed";
            }
            let Ok(mut q) = self.queue.lock() else {
                return "internal";
            };
            if need_key {
                while q.chunks.front().is_some_and(|c| !c.key) {
                    let old = q.chunks.pop_front().unwrap();
                    q.bytes -= old.data.len();
                    self.wake.notify_all();
                }
                if q.chunks.front().is_some_and(|c| c.key) {
                    need_key = false;
                    clock = Instant::now();
                    origin = q.chunks.front().map(|c| c.time);
                }
            }
            let due = q.chunks.front().is_some_and(|c| {
                c.time - origin.unwrap_or(c.time) <= clock.elapsed().as_micros() as i64 + 2_000_000
            });
            if !need_key && due {
                let chunk = q.chunks.pop_front().unwrap();
                q.bytes -= chunk.data.len();
                self.wake.notify_all();
                drop(q);
                if matches!(self.framing, Framing::Chunked)
                    && let Err(outcome) =
                        self.send(socket, format!("{:x}\r\n", chunk.data.len()).as_bytes())
                {
                    return outcome;
                }
                if let Err(outcome) = self.send(socket, &chunk.data) {
                    return outcome;
                }
                if matches!(self.framing, Framing::Chunked)
                    && let Err(outcome) = self.send(socket, b"\r\n")
                {
                    return outcome;
                }
                self.trace.written(chunk.data.len());
                self.delivered.store(true, Ordering::Release);
                self.publish();
            } else if q.eof && q.chunks.is_empty() {
                if matches!(self.framing, Framing::Chunked) {
                    let _ = self.send(socket, b"0\r\n\r\n");
                }
                return if q.error {
                    "pipeline_failed"
                } else {
                    "completed"
                };
            } else {
                let Ok((next, _)) = self.wake.wait_timeout(q, Duration::from_millis(50)) else {
                    return "internal";
                };
                drop(next);
            }
        }
        "cancelled"
    }
}
impl Drop for Running {
    fn drop(&mut self) {
        self.cancel();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn health_requires_recent_delivery_and_a_live_uncancelled_consumer() {
        let running = Running::new(1, Framing::Close).unwrap();
        running.queue.lock().unwrap().consumer = true;
        assert!(!running.advancing(), "an open GET alone is insufficient");
        running.trace.written(188);
        assert!(running.advancing());
        running.queue.lock().unwrap().consumer = false;
        assert!(
            !running.advancing(),
            "disconnected consumers do not extend authorization"
        );
        running.queue.lock().unwrap().consumer = true;
        running.cancel();
        assert!(!running.advancing());
    }
    fn context() -> Arc<HostContext> {
        Arc::new(HostContext {
            directory: PathBuf::new(),
            cache_root: PathBuf::new(),
            assets: Arc::new(|_| None),
            stop: Arc::new(AtomicBool::new(false)),
            api_slots: Arc::new(Semaphore::new(1)),
            export_slots: Arc::new(Semaphore::new(1)),
            export_renderer: std::sync::OnceLock::new(),
            port: 0,
            desktop: true,
            bind_address: Ipv4Addr::LOCALHOST,
            allowed_hosts: Default::default(),
            bbdown: None,
            aria2: Mutex::new(None),
            aria2_prepare: Mutex::new(()),
            shutdown_token: None,
            desktop_installation: None,
            workers: Mutex::new(vec![]),
        })
    }
    fn finish(context: &HostContext, running: &Running) {
        running.cancel();
        context.stop.store(true, Ordering::Release);
        let workers = std::mem::take(&mut *context.workers.lock().unwrap());
        for worker in workers {
            worker.join().unwrap();
        }
    }
    fn packet(tag: u8) -> Vec<u8> {
        let mut p = vec![tag; 188];
        p[0] = 0x47;
        p
    }
    #[test]
    fn denied_peer_gets_http_403_only_after_its_bounded_request_header() {
        let host = context();
        let running = Running::new(1, Framing::Close).unwrap();
        assert!(running.push(&packet(7), 0, true));
        let uri = running
            .bind(&host, Ipv4Addr::LOCALHOST, Ipv4Addr::new(127, 0, 0, 2))
            .unwrap();
        let endpoint = Url::parse(&uri).unwrap();
        let mut socket =
            TcpStream::connect((Ipv4Addr::LOCALHOST, endpoint.port().unwrap())).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_millis(200)))
            .unwrap();
        socket.write_all(b"GET / HTTP/1.1\r\n").unwrap();
        let mut byte = [0];
        let partial = socket.read(&mut byte);
        assert!(
            matches!(partial, Err(ref error) if matches!(error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut)),
            "A response before the complete request can race the HTTP client: {partial:?}"
        );
        socket.write_all(b"Host: 127.0.0.1\r\n\r\n").unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut response = Vec::new();
        socket.take(4096).read_to_end(&mut response).unwrap();
        assert_eq!(
            response,
            b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        );
        let queue = running.queue.lock().unwrap();
        assert_eq!(queue.bytes, 188);
        assert!(!queue.consumer);
        drop(queue);
        finish(&host, &running);
    }
    #[test]
    fn endpoint_headers_ip_scope_range_and_expired_capability() {
        for framing in [Framing::Close, Framing::Chunked] {
            let host = context();
            let running = Running::new(1, framing).unwrap();
            let uri = running
                .bind(&host, Ipv4Addr::LOCALHOST, Ipv4Addr::LOCALHOST)
                .unwrap();
            let client = reqwest::blocking::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(3))
                .build()
                .unwrap();
            let head = client.head(&uri).send().unwrap();
            assert_eq!(head.status(), 200);
            assert_eq!(head.headers()["content-type"], "video/MP2T");
            assert!(!head.headers().contains_key("content-length"));
            // Use a different permitted receiver rather than requiring a second
            // loopback source alias to be configured on every native OS.
            let forbidden = running
                .bind(&host, Ipv4Addr::LOCALHOST, Ipv4Addr::new(127, 0, 0, 2))
                .unwrap();
            let denied = client.get(&forbidden).send().unwrap();
            assert_eq!(denied.status(), 403);
            assert_eq!(running.rejected.load(Ordering::Relaxed), 1);
            assert_eq!(
                client
                    .get(uri.replace(".ts", "x.ts"))
                    .send()
                    .unwrap()
                    .status(),
                404
            );
            assert!(running.push(&packet(1), 0, true));
            assert!(running.push(&packet(2), 50_000, false));
            running.finished(false);
            let response = client
                .get(&uri)
                .header("Range", "bytes=100-")
                .send()
                .unwrap();
            assert_eq!(response.status(), 200);
            assert_eq!(response.headers()["transfermode.dlna.org"], "Streaming");
            assert_eq!(
                response.bytes().unwrap().as_ref(),
                [packet(1), packet(2)].concat()
            );
            running.cancel();
            let expired = client.get(&uri).send();
            assert!(expired.is_err() || expired.unwrap().status() == 410);
            finish(&host, &running);
        }
    }
    #[test]
    fn reconnect_discards_old_non_key_chunks_and_starts_at_fresh_idr() {
        let host = context();
        let running = Running::new(4, Framing::Close).unwrap();
        let uri = running
            .bind(&host, Ipv4Addr::LOCALHOST, Ipv4Addr::LOCALHOST)
            .unwrap();
        let url = Url::parse(&uri).unwrap();
        let mut socket = TcpStream::connect((Ipv4Addr::LOCALHOST, url.port().unwrap())).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        assert!(running.push(&packet(1), 0, true));
        write!(
            socket,
            "GET {} HTTP/1.1\r\nHost: fixture\r\n\r\n",
            url.path()
        )
        .unwrap();
        let mut header = Vec::new();
        while !header.ends_with(b"\r\n\r\n") {
            let mut b = [0; 1];
            socket.read_exact(&mut b).unwrap();
            header.push(b[0]);
        }
        let mut body = [0; 188];
        socket.read_exact(&mut body).unwrap();
        assert_eq!(body.as_slice(), packet(1));
        socket2::SockRef::from(&socket)
            .set_linger(Some(Duration::ZERO))
            .unwrap();
        drop(socket);
        assert!(running.push(&packet(2), 50_000, false));
        let deadline = Instant::now() + Duration::from_secs(2);
        while running.queue.lock().unwrap().consumer && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        assert!(!running.queue.lock().unwrap().consumer);
        assert!(running.push(&packet(3), 100_000, true));
        assert!(running.push(&packet(4), 150_000, false));
        running.finished(false);
        let result = reqwest::blocking::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap()
            .get(uri)
            .send()
            .unwrap()
            .bytes()
            .unwrap();
        assert_eq!(result.as_ref(), [packet(3), packet(4)].concat());
        finish(&host, &running);
    }
    /// A small-window client that sends GET and then pauses reading, as a
    /// receiver does while opening its decoder.
    fn paused_client(port: u16, path: &str) -> TcpStream {
        let socket = socket2::Socket::new(
            socket2::Domain::IPV4,
            socket2::Type::STREAM,
            Some(socket2::Protocol::TCP),
        )
        .unwrap();
        socket.set_recv_buffer_size(4096).unwrap();
        socket
            .connect(&std::net::SocketAddr::from((Ipv4Addr::LOCALHOST, port)).into())
            .unwrap();
        let mut socket: TcpStream = socket.into();
        write!(socket, "GET {path} HTTP/1.1\r\nHost: fixture\r\n\r\n").unwrap();
        socket
    }
    fn burst(running: &Running, chunks: usize) -> Vec<u8> {
        let mut sent = Vec::new();
        for index in 0..chunks {
            let chunk = packet((index % 251) as u8).repeat(128);
            assert!(running.push(&chunk, 0, true));
            sent.extend_from_slice(&chunk);
        }
        sent
    }
    #[test]
    fn receiver_backpressure_beyond_socket_buffers_does_not_end_the_stream() {
        let host = context();
        let running = Running::new(9, Framing::Close).unwrap();
        // Several MiB at time zero are all due at once: the first-connection burst.
        let sent = burst(&running, 300);
        running.finished(false);
        let uri = running
            .bind(&host, Ipv4Addr::LOCALHOST, Ipv4Addr::LOCALHOST)
            .unwrap();
        let url = Url::parse(&uri).unwrap();
        let mut socket = paused_client(url.port().unwrap(), url.path());
        thread::sleep(Duration::from_millis(1200));
        socket
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        let mut received = Vec::new();
        socket.read_to_end(&mut received).unwrap();
        let body = received
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .map(|offset| &received[offset + 4..])
            .unwrap();
        assert_eq!(
            body.len(),
            sent.len(),
            "the stream ended during backpressure"
        );
        assert!(body == sent.as_slice());
        assert!(running.delivered.load(Ordering::Acquire));
        finish(&host, &running);
    }
    #[test]
    fn cancellation_ends_a_write_blocked_by_a_paused_receiver() {
        let host = context();
        let running = Running::new(10, Framing::Close).unwrap();
        burst(&running, 300);
        let uri = running
            .bind(&host, Ipv4Addr::LOCALHOST, Ipv4Addr::LOCALHOST)
            .unwrap();
        let url = Url::parse(&uri).unwrap();
        let _socket = paused_client(url.port().unwrap(), url.path());
        let deadline = Instant::now() + Duration::from_secs(2);
        while !running.has_consumer() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        assert!(running.has_consumer());
        thread::sleep(Duration::from_millis(300));
        let cancelled = Instant::now();
        running.cancel();
        while running.has_consumer() && cancelled.elapsed() < Duration::from_secs(5) {
            thread::sleep(Duration::from_millis(5));
        }
        assert!(
            cancelled.elapsed() < Duration::from_secs(2),
            "a blocked write must not wait for the stall bound after cancel"
        );
        finish(&host, &running);
    }
    #[test]
    fn trace_counts_requests_bytes_and_disconnects_without_addresses() {
        let host = context();
        let running = Running::new(11, Framing::Close).unwrap();
        let uri = running
            .bind(&host, Ipv4Addr::LOCALHOST, Ipv4Addr::LOCALHOST)
            .unwrap();
        let denied = running
            .bind(&host, Ipv4Addr::LOCALHOST, Ipv4Addr::new(127, 0, 0, 2))
            .unwrap();
        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(3))
            .build()
            .unwrap();
        assert_eq!(client.head(&uri).send().unwrap().status(), 200);
        assert_eq!(client.get(&denied).send().unwrap().status(), 403);
        assert_eq!(
            client
                .get(uri.replace(".ts", "x.ts"))
                .send()
                .unwrap()
                .status(),
            404
        );
        assert_eq!(client.post(&uri).send().unwrap().status(), 405);
        assert!(running.push(&packet(1), 0, true));
        assert!(running.push(&packet(2), 50_000, false));
        running.finished(false);
        assert_eq!(client.get(&uri).send().unwrap().bytes().unwrap().len(), 376);
        let deadline = Instant::now() + Duration::from_secs(2);
        while running.trace.snapshot()["disconnects"]
            .as_array()
            .unwrap()
            .is_empty()
            && Instant::now() < deadline
        {
            thread::sleep(Duration::from_millis(5));
        }
        let snapshot = running.trace.snapshot();
        assert_eq!(snapshot["listener_ready"], true);
        let http = &snapshot["http"];
        assert_eq!(
            (
                http["head"].as_u64(),
                http["get"].as_u64(),
                http["streams"].as_u64()
            ),
            (Some(1), Some(1), Some(1))
        );
        assert_eq!(http["rejected_peer"], 1);
        assert_eq!(http["rejected_peer_same_subnet"], 1);
        assert_eq!(http["not_found"], 1);
        assert_eq!(http["method_not_allowed"], 1);
        assert_eq!(snapshot["bytes_written"], 376);
        assert!(snapshot["first_byte_ms"].is_u64());
        assert_eq!(snapshot["disconnects"], json!(["completed"]));
        let text = snapshot.to_string();
        let capability = Url::parse(&uri).unwrap().path().to_owned();
        assert!(
            !text.contains("127.0.0")
                && !text.contains(&capability)
                && !text.contains("/purek/stream")
        );
        finish(&host, &running);
    }
    #[test]
    fn queue_enforces_four_seconds_and_byte_cap_with_cancellable_backpressure() {
        for byte_limit in [false, true] {
            let mut running = Running::new(1, Framing::Close).unwrap();
            Arc::get_mut(&mut running).unwrap().clock = Instant::now() - Duration::from_secs(60);
            if byte_limit {
                let p = packet(1).repeat(128);
                while running.queue.lock().unwrap().bytes + p.len() <= MAX_BYTES {
                    assert!(running.push(&p, 0, true));
                }
            } else {
                assert!(running.push(&packet(1), 0, true));
                assert!(running.push(&packet(2), 4_000_000, true));
            }
            let cloned = running.clone();
            let (sent, received) = std::sync::mpsc::channel();
            let worker = thread::spawn(move || {
                let data = if byte_limit {
                    packet(3).repeat(128)
                } else {
                    packet(3)
                };
                sent.send(cloned.push(&data, if byte_limit { 0 } else { 4_010_000 }, true))
                    .unwrap();
            });
            assert!(received.recv_timeout(Duration::from_millis(100)).is_err());
            {
                let q = running.queue.lock().unwrap();
                assert!(q.bytes <= MAX_BYTES);
                assert!(
                    q.chunks.back().unwrap().time - q.chunks.front().unwrap().time <= MAX_SPAN_US
                );
            }
            running.cancel();
            assert!(!received.recv_timeout(Duration::from_secs(1)).unwrap());
            worker.join().unwrap();
        }
    }
    #[test]
    fn queue_rejects_backward_time_and_overlarge_gops() {
        let r = Running::new(1, Framing::Close).unwrap();
        assert!(r.push(&packet(1), 1000, true));
        assert!(!r.push(&packet(1), 0, false));
        let r = Running::new(1, Framing::Close).unwrap();
        r.queue.lock().unwrap().gop_bytes = MAX_BYTES;
        assert!(!r.push(&packet(1), 0, false));
    }
    #[test]
    fn cancellation_closes_active_body_and_rotated_uri_keeps_its_own_listener() {
        let host = context();
        let old = Running::new(1, Framing::Close).unwrap();
        let first = old
            .bind(&host, Ipv4Addr::LOCALHOST, Ipv4Addr::LOCALHOST)
            .unwrap();
        assert!(old.push(&packet(1), 0, true));
        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap();
        let mut body = client.get(&first).send().unwrap();
        let mut p = [0; 188];
        body.read_exact(&mut p).unwrap();
        assert_eq!(p.as_slice(), packet(1));
        let new = Running::new(2, Framing::Chunked).unwrap();
        let second = new
            .bind(&host, Ipv4Addr::LOCALHOST, Ipv4Addr::LOCALHOST)
            .unwrap();
        assert_ne!(
            Url::parse(&first).unwrap().path(),
            Url::parse(&second).unwrap().path()
        );
        old.cancel();
        assert_eq!(body.read(&mut p).unwrap(), 0);
        assert_eq!(client.head(&second).send().unwrap().status(), 200);
        let expired = client.head(&first).send();
        assert!(expired.is_err() || expired.unwrap().status() == 410);
        new.cancel();
        finish(&host, &old);
    }
}
