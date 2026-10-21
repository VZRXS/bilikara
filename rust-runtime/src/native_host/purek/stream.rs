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
}
impl Running {
    #[cfg(test)]
    pub fn new(generation: u64, framing: Framing) -> Result<Arc<Self>, ApiError> {
        Self::with_level(generation, framing, false)
    }
    #[cfg(test)]
    pub fn with_level(generation: u64, framing: Framing, l1: bool) -> Result<Arc<Self>, ApiError> {
        Self::with_protocol(generation, framing, l1, capabilities::TsProtocol::Mp2t)
    }
    pub fn with_protocol(
        generation: u64,
        framing: Framing,
        l1: bool,
        protocol: capabilities::TsProtocol,
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
            capability: random.iter().map(|b| format!("{b:02x}")).collect(),
        }))
    }
    pub fn cancel(&self) {
        self.stop.store(true, Ordering::Release);
        self.wake.notify_all();
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
    pub fn push(&self, data: &[u8], time: i64, key: bool) -> bool {
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
        context.spawn("purek-stream-listener",move|| {
            while !running.stop.load(Ordering::Acquire) && !host.stop.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((socket,peer)) => {
                        if peer.ip()!=IpAddr::V4(receiver) {
                            running.rejected.fetch_add(1,Ordering::Relaxed);
                            let mut socket=socket;let _=socket.set_write_timeout(Some(Duration::from_millis(100)));
                            let _=socket.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"); continue;
                        }
                        if running.clients.fetch_add(1,Ordering::AcqRel)>=4 {
                            running.clients.fetch_sub(1,Ordering::AcqRel); continue;
                        }
                        let session=running.clone();
                        if host.spawn("purek-stream-client",move||{ session.serve(socket); session.clients.fetch_sub(1,Ordering::AcqRel); }).is_err() {
                            running.clients.fetch_sub(1,Ordering::AcqRel);
                        }
                    }
                    Err(e) if e.kind()==std::io::ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(20)),
                    Err(_) => {running.cancel();break;}
                }
            }
            running.cancel();
        }).map_err(|_|network_error())?;
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
    fn serve(&self, mut socket: TcpStream) {
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
        let error = if self.stop.load(Ordering::Acquire) {
            Some("410 Gone")
        } else if !valid || !bytes.ends_with(b"\r\n\r\n") {
            Some("404 Not Found")
        } else if !matches!(first[0], "GET" | "HEAD") {
            Some("405 Method Not Allowed")
        } else {
            None
        };
        if let Some(error) = error {
            let _ = write!(
                socket,
                "HTTP/1.1 {error}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
            return;
        }
        if first[0] == "HEAD" {
            let _ = socket.write_all(&self.headers(true));
            return;
        }
        let Ok(mut q) = self.queue.lock() else {
            return;
        };
        if q.consumer {
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
        if socket.write_all(&self.headers(false)).is_err() {
            return;
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
                return;
            }
            let Ok(mut q) = self.queue.lock() else {
                return;
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
                    && write!(socket, "{:x}\r\n", chunk.data.len()).is_err()
                {
                    return;
                }
                if socket.write_all(&chunk.data).is_err() {
                    return;
                }
                if matches!(self.framing, Framing::Chunked) && socket.write_all(b"\r\n").is_err() {
                    return;
                }
                self.delivered.store(true, Ordering::Release);
                self.publish();
            } else if q.eof && q.chunks.is_empty() {
                if matches!(self.framing, Framing::Chunked) {
                    let _ = socket.write_all(b"0\r\n\r\n");
                }
                return;
            } else {
                let Ok((next, _)) = self.wake.wait_timeout(q, Duration::from_millis(50)) else {
                    return;
                };
                drop(next);
            }
        }
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
