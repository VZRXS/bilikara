// Ported from VZRXS/bilikara PR #120 by FMPeach (MIT), commit 297ae1de,
// rust-runtime/src/show_dlna.rs (actual TCP SOAP fixture). See THIRD_PARTY_NOTICES.md.
use super::*;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use std::thread::{self, JoinHandle};

pub fn run<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(future)
}

pub fn response(action: SoapAction, fields: &str) -> String {
    let action = action.as_str();
    format!(
        "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body><u:{action}Response xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\">{fields}</u:{action}Response></s:Body></s:Envelope>"
    )
}

pub fn fault(code: u32) -> String {
    format!(
        "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body><s:Fault><detail><UPnPError><errorCode>{code}</errorCode><errorDescription>Rejected</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>"
    )
}

pub fn description(name: &str, extra: &str) -> String {
    format!(
        "<root><device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType><friendlyName>{name}</friendlyName><UDN>uuid:fixture</UDN>{extra}<serviceList><service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/control</controlURL></service><service><serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType><controlURL>/cm</controlURL></service></serviceList></device></root>"
    )
}

#[derive(Clone)]
pub struct Reply {
    pub action: Option<SoapAction>,
    pub status: u16,
    pub body: String,
    pub reset: bool,
    pub delay: Option<Duration>,
    pub headers: String,
    pub chunked: bool,
}

impl Reply {
    pub fn raw(action: Option<SoapAction>, status: u16, body: impl Into<String>) -> Self {
        Self {
            action,
            status,
            body: body.into(),
            reset: false,
            delay: None,
            headers: String::new(),
            chunked: false,
        }
    }
    pub fn ok(action: SoapAction) -> Self {
        Self::fields(action, "")
    }
    pub fn fields(action: SoapAction, fields: &str) -> Self {
        Self::raw(Some(action), 200, response(action, fields))
    }
    pub fn reset(action: SoapAction) -> Self {
        Self {
            reset: true,
            ..Self::ok(action)
        }
    }
    pub fn delayed(mut self, duration: Duration) -> Self {
        self.delay = Some(duration);
        self
    }
}

pub struct Request {
    pub headers: String,
    pub body: String,
    pub at: Instant,
    pub peer: SocketAddr,
}

impl Request {
    pub fn header(&self, key: &str) -> Option<&str> {
        self.headers.lines().find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case(key).then(|| value.trim())
        })
    }
}

pub fn read_request(stream: &mut TcpStream, peer: SocketAddr) -> Request {
    // Windows accepts can inherit a nonblocking listener's mode.
    stream.set_nonblocking(false).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let mut bytes = Vec::new();
    let mut byte = [0; 1];
    while !bytes.ends_with(b"\r\n\r\n") {
        stream.read_exact(&mut byte).unwrap();
        bytes.push(byte[0]);
        assert!(bytes.len() < 64 * 1024);
    }
    let headers = String::from_utf8(bytes).unwrap();
    let length = headers
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().unwrap())
        })
        .unwrap_or(0);
    let mut body = vec![0; length];
    stream.read_exact(&mut body).unwrap();
    Request {
        headers,
        body: String::from_utf8(body).unwrap(),
        at: Instant::now(),
        peer,
    }
}

pub fn write_reply(mut stream: TcpStream, reply: Reply) {
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    if reply.reset {
        let socket = socket2::Socket::from(stream);
        socket.set_linger(Some(Duration::ZERO)).unwrap();
        return;
    }
    if let Some(delay) = reply.delay {
        thread::sleep(delay);
    }
    // A cancelled request may already be closed. The fixture must still accept
    // subsequent requests, rather than serializing behind the timed-out reply.
    if reply.chunked {
        let _ = write!(
            stream,
            "HTTP/1.1 {} Fixture\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n{}\r\n{:x}\r\n{}\r\n0\r\n\r\n",
            reply.status,
            reply.headers,
            reply.body.len(),
            reply.body
        );
    } else {
        let _ = write!(
            stream,
            "HTTP/1.1 {} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n{}\r\n{}",
            reply.status,
            reply.body.len(),
            reply.headers,
            reply.body
        );
    }
}

pub struct Fixture {
    pub address: SocketAddr,
    worker: JoinHandle<Vec<Request>>,
}

impl Fixture {
    pub fn start(replies: Vec<Reply>) -> Self {
        Self::start_with_request_hook(replies, |_, _| {})
    }
    pub fn start_with_request_hook(
        replies: Vec<Reply>,
        on_request: impl Fn(usize, &Request) + Send + 'static,
    ) -> Self {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let worker = thread::spawn(move || {
            let mut requests = Vec::new();
            let mut delayed = Vec::new();
            for reply in replies {
                let deadline = Instant::now() + Duration::from_secs(4);
                let (mut stream, peer) = loop {
                    match listener.accept() {
                        Ok(connection) => break connection,
                        Err(error)
                            if error.kind() == std::io::ErrorKind::WouldBlock
                                && Instant::now() < deadline =>
                        {
                            thread::sleep(Duration::from_millis(2))
                        }
                        result => panic!("missing fixture request {:?}: {result:?}", reply.action),
                    }
                };
                let request = read_request(&mut stream, peer);
                if let Some(action) = reply.action {
                    assert!(
                        request
                            .header("soapaction")
                            .unwrap()
                            .ends_with(&format!("#{}\"", action.as_str()))
                    );
                }
                on_request(requests.len(), &request);
                requests.push(request);
                if reply.delay.is_some() {
                    delayed.push(thread::spawn(move || write_reply(stream, reply)));
                } else {
                    write_reply(stream, reply);
                }
            }
            for worker in delayed {
                worker.join().unwrap();
            }
            requests
        });
        Self { address, worker }
    }
    pub fn join(self) -> Vec<Request> {
        self.worker.join().unwrap()
    }
    pub fn renderer(&self) -> Renderer {
        Renderer {
            description: dlna_policy::parse_description(
                &description("普通电视", ""),
                &format!("http://{}/description.xml", self.address),
                "",
                "",
                NetworkPolicy::LoopbackFixture,
            )
            .unwrap(),
            local_address: Ipv4Addr::LOCALHOST,
            context: DeviceContext::new(
                DiscoverySource::Manual,
                &format!("http://{}/description.xml", self.address),
                "uuid:fixture",
                "",
            ),
        }
    }
}

/// Counts every actual HTTP fetch, including unexpected duplicate requests.
/// Drop stops and joins the bounded listener; tests never detach a server.
pub struct CountingFixture {
    pub address: SocketAddr,
    requests: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl CountingFixture {
    pub fn start(reply: Reply) -> Self {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let requests = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let count = requests.clone();
        let stopping = stop.clone();
        let worker = thread::spawn(move || {
            while !stopping.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((mut stream, peer)) => {
                        let request = read_request(&mut stream, peer);
                        assert!(request.headers.starts_with("GET "));
                        count.fetch_add(1, Ordering::SeqCst);
                        write_reply(stream, reply.clone());
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2))
                    }
                    Err(error) => panic!("counting fixture: {error}"),
                }
            }
        });
        Self {
            address,
            requests,
            stop,
            worker: Some(worker),
        }
    }
    pub fn count(&self) -> usize {
        self.requests.load(Ordering::SeqCst)
    }
}

impl Drop for CountingFixture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            worker.join().unwrap();
        }
    }
}
