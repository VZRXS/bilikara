use super::*;
use crate::experimental_libav::cast_mux::{CastEvent, CastStart};
use std::{collections::HashMap, future::Future, path::Path, time::Instant};
use tokio::{
    io::AsyncWriteExt,
    net::TcpSocket,
    time::{sleep, timeout},
};

mod companion;
mod external;
mod review;

fn run(future: impl Future<Output = ()>) {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap()
        .block_on(future);
}

fn context() -> DeviceContext {
    DeviceContext {
        device_key: "test-device-digest".into(),
        udn_hash: None,
        source: super::super::DiscoverySource::Manual,
        server: "fixture".into(),
        route: None,
    }
}

async fn endpoint() -> CastEndpoint {
    CastEndpoint::bind_on(
        Ipv4Addr::LOCALHOST,
        Ipv4Addr::LOCALHOST,
        context(),
        ServerIdentity::new("Windows", "11").unwrap(),
        Arc::new(Semaphore::new(MAX_SESSIONS)),
        DEFAULT_STAGES,
    )
    .await
    .unwrap()
}

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let base = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join(".tmp/cast-http-tests");
        std::fs::create_dir_all(&base).unwrap();
        let mut nonce = [0; 16];
        getrandom::fill(&mut nonce).unwrap();
        let path = base.join(nonce.iter().map(|b| format!("{b:02x}")).collect::<String>());
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn file(&self, name: &str, contents: &[u8]) -> PathBuf {
        let path = self.0.join(name);
        std::fs::write(&path, contents).unwrap();
        path
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

fn fixture_file(
    endpoint: &CastEndpoint,
    id: u64,
    path: &Path,
    mp4: bool,
    converted: bool,
) -> PublishedMedia {
    endpoint
        .publish(
            id,
            Body::File(FileBody {
                path: path.into(),
                length: std::fs::metadata(path).unwrap().len(),
                mp4,
                converted,
                _lease: None,
            }),
            TsMime::Mp2t,
        )
        .unwrap()
}

fn target(uri: &str) -> &str {
    &uri[uri.find("/cast/").unwrap()..]
}

async fn connect(endpoint: &CastEndpoint, alias: Option<Ipv4Addr>, small: bool) -> TcpStream {
    let socket = TcpSocket::new_v4().unwrap();
    if let Some(alias) = alias {
        socket.bind((alias, 0).into()).unwrap();
    }
    if small {
        socket.set_recv_buffer_size(8192).unwrap();
    }
    socket.connect(endpoint.local_addr()).await.unwrap()
}

struct Reply {
    status: u16,
    headers: HashMap<String, String>,
    socket: TcpStream,
}
impl Reply {
    async fn body(mut self) -> Vec<u8> {
        let mut bytes = Vec::new();
        timeout(Duration::from_secs(5), self.socket.read_to_end(&mut bytes))
            .await
            .unwrap()
            .unwrap();
        bytes
    }
}

async fn reply(mut socket: TcpStream) -> Reply {
    let mut header = Vec::new();
    timeout(Duration::from_secs(3), async {
        while !header.ends_with(b"\r\n\r\n") {
            let mut byte = [0];
            assert_eq!(
                socket.read(&mut byte).await.unwrap(),
                1,
                "closed before HTTP header: {header:?}"
            );
            header.extend(byte);
        }
    })
    .await
    .unwrap();
    let header = String::from_utf8(header).unwrap();
    let mut lines = header.split("\r\n");
    let status = lines
        .next()
        .unwrap()
        .split_whitespace()
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    let headers = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(k, v)| (k.to_ascii_lowercase(), v.trim().into()))
        .collect();
    Reply {
        status,
        headers,
        socket,
    }
}

async fn request(endpoint: &CastEndpoint, method: &str, uri: &str, extra: &str) -> Reply {
    let mut socket = connect(endpoint, None, false).await;
    socket
        .write_all(
            format!(
                "{method} {} HTTP/1.1\r\nHost: fixture\r\n{extra}\r\n",
                target(uri)
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    reply(socket).await
}

async fn until(mut condition: impl FnMut() -> bool) {
    timeout(Duration::from_secs(3), async {
        while !condition() {
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}

fn start() -> CastStart {
    CastStart {
        source_start_us: 2_000_000,
        timestamp_origin_us: 1_958_333,
        profile: 100,
        level: 40,
        width: 1920,
        height: 1080,
        has_b_frames: true,
        audio_transcoded: false,
    }
}

fn live(options: LiveOptions) -> Arc<LiveStream> {
    let stream = Arc::new(LiveStream::new(options).unwrap());
    stream.push(CastEvent::Start(start())).unwrap();
    stream
}

fn packet(pid: u16, stamp: u8, key: bool) -> Vec<u8> {
    let mut p = vec![0xff; 188];
    p[0] = 0x47;
    p[1] = (pid >> 8) as u8 | 0x40;
    p[2] = pid as u8;
    // Adaptation includes PCR and payload. Counters intentionally begin at 13
    // to prove the transport replaces them for each independent reader.
    p[3] = 0x3d;
    p[4] = 7;
    p[5] = 0x10;
    p[6..12].copy_from_slice(&[0, 0, 0, stamp, 0x7e, 0]);
    p[12..16].copy_from_slice(&[0, 0, 1, 0xe0]);
    p[16..18].copy_from_slice(&170u16.to_be_bytes());
    p[18..21].copy_from_slice(&[0x80, 0, 0]);
    p[21] = if key { 0x65 } else { 0x41 };
    p[22] = stamp;
    p
}

fn push(stream: &LiveStream, time: i64, stamp: u8, key: bool) {
    stream
        .push(CastEvent::Data {
            bytes: &packet(256, stamp, key),
            time_us: time,
            key,
        })
        .unwrap();
}

fn common(reply: &Reply, mime: &str, file: bool, converted: bool) {
    assert_eq!(reply.headers["content-type"], mime);
    assert_eq!(reply.headers["transfermode.dlna.org"], "Streaming");
    assert_eq!(reply.headers["ext"], "");
    assert_eq!(
        reply.headers["server"],
        "Windows/11 UPnP/1.0 bilikara/0.8.0"
    );
    assert_eq!(reply.headers["cache-control"], "no-store");
    assert_eq!(reply.headers["connection"], "close");
    assert_eq!(
        reply.headers["accept-ranges"],
        if file { "bytes" } else { "none" }
    );
    assert_eq!(
        reply.headers["contentfeatures.dlna.org"],
        format!(
            "DLNA.ORG_OP={};DLNA.ORG_CI={};DLNA.ORG_FLAGS=01700000000000000000000000000000",
            if file { "01" } else { "00" },
            u8::from(converted)
        )
    );
    assert!(!reply.headers.contains_key("transfer-encoding"));
}

#[test]
fn file_range_boundaries_head_and_common_headers() {
    run(async {
        let temp = Temp::new();
        let path = temp.file("test.ts", b"0123456789");
        let endpoint = endpoint().await;
        let media = fixture_file(&endpoint, 1, &path, false, false);
        for (range, status, expected, content_range) in [
            ("", 200, "0123456789", ""),
            ("bytes=0-0", 206, "0", "bytes 0-0/10"),
            ("bytes=3-6", 206, "3456", "bytes 3-6/10"),
            ("bytes=8-", 206, "89", "bytes 8-9/10"),
            ("bytes=-3", 206, "789", "bytes 7-9/10"),
            ("bytes=-30", 206, "0123456789", "bytes 0-9/10"),
            ("bytes=7-999", 206, "789", "bytes 7-9/10"),
            (
                "bytes=0-18446744073709551615",
                206,
                "0123456789",
                "bytes 0-9/10",
            ),
            ("bytes=10-", 416, "", "bytes */10"),
            ("bytes=7-3", 200, "0123456789", ""),
            ("bytes=-0", 416, "", "bytes */10"),
            ("bytes=18446744073709551616-", 200, "0123456789", ""),
            ("bytes=0-18446744073709551616", 200, "0123456789", ""),
            ("bytes=-18446744073709551616", 200, "0123456789", ""),
            ("bytes=+1-2", 200, "0123456789", ""),
            ("bytes=", 200, "0123456789", ""),
            ("bytes=abc", 200, "0123456789", ""),
            ("bytes=not-a-range", 200, "0123456789", ""),
            ("Bytes=0-1", 206, "01", "bytes 0-1/10"),
            ("bytes=1-2,5-6", 200, "0123456789", ""),
            ("items=1-2", 200, "0123456789", ""),
        ] {
            for method in ["HEAD", "GET"] {
                let extra = if range.is_empty() {
                    String::new()
                } else {
                    format!("rAnGe: {range}\r\n")
                };
                let reply = request(&endpoint, method, &media.uri, &extra).await;
                assert_eq!(reply.status, status, "{method} {range}");
                common(&reply, "video/MP2T", true, false);
                assert_eq!(reply.headers["content-length"], expected.len().to_string());
                assert_eq!(
                    reply
                        .headers
                        .get("content-range")
                        .map_or("", String::as_str),
                    content_range
                );
                assert_eq!(
                    reply.body().await,
                    if method == "HEAD" {
                        b""
                    } else {
                        expected.as_bytes()
                    }
                );
            }
        }
        endpoint.shutdown().await;
    });
}

#[test]
fn shared_listener_token_generation_switch_mp4_mime_and_conversion() {
    run(async {
        let temp = Temp::new();
        let endpoint = endpoint().await;
        let address = endpoint.local_addr();
        assert!(address.ip().is_loopback());
        assert_ne!(address.port(), 0);
        assert_eq!(endpoint.token.len(), 32);
        assert!(endpoint.token.bytes().all(|b| b.is_ascii_hexdigit()));
        let stream = live(LiveOptions::default());
        let old = endpoint
            .publish_live(7, stream.clone(), TsMime::Mpeg)
            .unwrap();
        let mut reader = request(&endpoint, "GET", &old.uri, "").await;
        common(&reader, "video/mpeg", false, false);
        let path = temp.file("test.mp4", b"fixture-mp4");
        let media = fixture_file(&endpoint, 8, &path, true, true);
        assert_eq!(endpoint.local_addr(), address);
        assert_eq!(
            target(&old.uri).split('/').nth(2),
            target(&media.uri).split('/').nth(2)
        );
        let mut byte = [0];
        assert_eq!(
            timeout(Duration::from_secs(1), reader.socket.read(&mut byte))
                .await
                .unwrap()
                .unwrap(),
            0
        );
        let result = request(&endpoint, "GET", &old.uri, "").await;
        assert_eq!(result.status, 404);
        assert!(result.body().await.is_empty());
        let result = request(&endpoint, "GET", &media.uri, "").await;
        common(&result, "video/mp4", true, true);
        assert_eq!(result.body().await, b"fixture-mp4");
        assert!(matches!(
            endpoint.publish_live(8, live(LiveOptions::default()), TsMime::Mp2t),
            Err(EndpointError::StaleGeneration)
        ));
        endpoint.clear_generation();
        assert_eq!(request(&endpoint, "HEAD", &media.uri, "").await.status, 404);
        endpoint.shutdown().await;
    });
}

#[test]
fn wrong_token_generation_path_and_method_are_rejected_after_headers() {
    run(async {
        let endpoint = endpoint().await;
        let media = endpoint
            .publish_live(12, live(LiveOptions::default()), TsMime::Mp2t)
            .unwrap();
        let bad_token = media.uri.replace(&endpoint.token, &"0".repeat(32));
        let bad_generation = media.uri.replace("/12.ts", "/13.ts");
        let traversal = media.uri.replace("/12.ts", "/../12.ts");
        for (method, uri, status) in [
            ("GET", &bad_token, 404),
            ("GET", &bad_generation, 404),
            ("GET", &traversal, 404),
            ("POST", &media.uri, 405),
        ] {
            let mut socket = connect(&endpoint, None, false).await;
            socket
                .write_all(
                    format!(
                        "{method} {} HTTP/1.1\r\nHost: fixture\r\nX-Probe: half",
                        target(uri)
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            let mut byte = [0];
            assert!(
                timeout(Duration::from_millis(250), socket.read(&mut byte))
                    .await
                    .is_err()
            );
            socket.write_all(b"-finished\r\n\r\n").await.unwrap();
            let response = reply(socket).await;
            assert_eq!(response.status, status);
            assert!(response.body().await.is_empty());
        }
        endpoint.shutdown().await;
    });
}

#[test]
fn lan_peer_alias_is_allowed_and_mismatch_is_structured() {
    if !crate::dlna::test_support::loopback_aliases(
        "lan_peer_alias_is_allowed_and_mismatch_is_structured",
        &[Ipv4Addr::new(127, 0, 0, 2)],
    ) {
        return;
    }
    run(async {
        let endpoint = endpoint().await;
        let stream = live(LiveOptions::default());
        push(&stream, 0, 1, true);
        stream.finish(true);
        let media = endpoint.publish_live(1, stream, TsMime::Mp2t).unwrap();
        let mut socket = connect(&endpoint, Some(Ipv4Addr::new(127, 0, 0, 2)), false).await;
        socket
            .write_all(format!("GET {} HTTP/1.1\r\n\r\n", target(&media.uri)).as_bytes())
            .await
            .unwrap();
        let reply = reply(socket).await;
        assert_eq!(reply.status, 200);
        assert_eq!(reply.body().await.len(), 188);
        let diagnostic = endpoint.shutdown().await;
        assert_eq!(diagnostic.peer_mismatches, 1);
        let event = diagnostic
            .stages
            .iter()
            .find(|e| e.stage == HttpStage::PeerMismatch)
            .unwrap();
        assert_eq!(event.context, context());
        assert_eq!(event.generation, Some(1));
        assert_eq!(event.result, Ok(()));
    });
}

#[test]
fn public_peer_403_waits_for_complete_header_over_loopback_transport() {
    run(async {
        let endpoint = endpoint().await;
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let mut socket = TcpStream::connect(listener.local_addr().unwrap())
            .await
            .unwrap();
        let state = endpoint.shared.clone();
        let task = tokio::spawn(async move {
            let (accepted, _) = listener.accept().await.unwrap();
            let client = Client {
                id: 100,
                cancel: CancellationToken::new(),
                closed: CancellationToken::new(),
                header_phase: Arc::new(AtomicU8::new(0)),
            };
            // A public source cannot be routed through a real loopback connection;
            // inject only the accept peer fact, use the actual parser and writer.
            serve(accepted, "8.8.8.8".parse().unwrap(), &state, &client).await;
        });
        socket
            .write_all(b"GET /unknown HTTP/1.1\r\nX-Probe: ")
            .await
            .unwrap();
        let mut byte = [0];
        assert!(
            timeout(Duration::from_millis(250), socket.read(&mut byte))
                .await
                .is_err()
        );
        socket.write_all(b"complete\r\n\r\n").await.unwrap();
        let response = reply(socket).await;
        assert_eq!(response.status, 403);
        assert!(response.body().await.is_empty());
        task.await.unwrap();
        let diag = endpoint.shutdown().await;
        assert!(
            diag.stages
                .iter()
                .any(|e| e.stage == HttpStage::Rejected && e.result == Err(Reason::PublicPeer))
        );
        for ip in [
            "10.1.2.3",
            "100.64.0.1",
            "100.127.255.254",
            "172.20.1.1",
            "192.168.50.9",
            "169.254.1.2",
            "127.1.2.3",
            "::1",
            "fe80::1",
            "fd00::123",
            "::ffff:192.168.1.2",
        ] {
            assert!(protocol::private_peer(ip.parse().unwrap()), "{ip}");
        }
        for ip in [
            "1.1.1.1",
            "100.63.255.254",
            "100.128.0.1",
            "8.8.8.8",
            "2001:4860:4860::8888",
            "::ffff:8.8.8.8",
        ] {
            assert!(!protocol::private_peer(ip.parse().unwrap()), "{ip}");
        }
    });
}

#[test]
fn header_deadline_size_limit_and_malformed_complete_request() {
    run(async {
        let endpoint = endpoint().await;
        let media = endpoint
            .publish_live(1, live(LiveOptions::default()), TsMime::Mp2t)
            .unwrap();
        let mut socket = connect(&endpoint, None, false).await;
        socket
            .write_all(b"GET /half HTTP/1.1\r\nX: ")
            .await
            .unwrap();
        let since = Instant::now();
        let mut byte = [0];
        assert_eq!(
            timeout(Duration::from_secs(6), socket.read(&mut byte))
                .await
                .unwrap()
                .unwrap(),
            0
        );
        assert!(since.elapsed() >= Duration::from_millis(4900));
        let mut socket = connect(&endpoint, None, false).await;
        socket
            .write_all(&vec![b'x'; protocol::HEADER_LIMIT])
            .await
            .unwrap();
        assert_eq!(
            timeout(Duration::from_secs(1), socket.read(&mut byte))
                .await
                .unwrap()
                .unwrap(),
            0
        );
        let mut socket = connect(&endpoint, None, false).await;
        socket.write_all(b"not-http\r\nbad\r\n\r\n").await.unwrap();
        assert_eq!(reply(socket).await.status, 400);
        // Exactly 8192 including the terminator is accepted, without a stricter
        // arbitrary small-header limit.
        let beginning = format!("HEAD {} HTTP/1.1\r\nX-Pad: ", target(&media.uri));
        let exact = format!(
            "{beginning}{}\r\n\r\n",
            "x".repeat(protocol::HEADER_LIMIT - beginning.len() - 4)
        );
        let mut socket = connect(&endpoint, None, false).await;
        socket.write_all(exact.as_bytes()).await.unwrap();
        assert_eq!(reply(socket).await.status, 200);
        let diag = endpoint.shutdown().await;
        for reason in [
            Reason::HeaderTimeout,
            Reason::HeaderTooLarge,
            Reason::MalformedRequest,
        ] {
            assert!(diag.stages.iter().any(|e| e.result == Err(reason)));
        }
    });
}

#[test]
fn fifth_get_closes_oldest_and_all_new_gets_return_200() {
    run(async {
        let endpoint = endpoint().await;
        let stream = live(LiveOptions::default());
        let media = endpoint
            .publish_live(1, stream.clone(), TsMime::Mp2t)
            .unwrap();
        let mut replies = Vec::new();
        for _ in 0..4 {
            let reply = request(&endpoint, "GET", &media.uri, "").await;
            assert_eq!(reply.status, 200);
            replies.push(reply);
        }
        // HEAD consumes no GET slot and cannot evict a media connection.
        assert_eq!(request(&endpoint, "HEAD", &media.uri, "").await.status, 200);
        assert_eq!(endpoint.shared.clients.lock().unwrap().len(), 4);
        let mut fifth = request(&endpoint, "GET", &media.uri, "").await;
        assert_eq!(fifth.status, 200);
        let mut byte = [0];
        assert_eq!(
            timeout(Duration::from_secs(1), replies[0].socket.read(&mut byte))
                .await
                .unwrap()
                .unwrap(),
            0
        );
        push(&stream, 0, 7, true);
        let mut packet = [0; 188];
        for reply in replies
            .iter_mut()
            .skip(1)
            .chain(std::iter::once(&mut fifth))
        {
            timeout(Duration::from_secs(1), reply.socket.read_exact(&mut packet))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(packet[22], 7);
        }
        let diag = endpoint.shutdown().await;
        assert!(
            diag.stages
                .iter()
                .any(|e| e.disconnect_reason == Some(Reason::Replaced))
        );
        assert!(!diag.stages.iter().any(|e| e.http_status == Some(409)));
    });
}

#[test]
fn first_body_byte_event_once_per_generation_and_no_head_false_positive() {
    run(async {
        let endpoint = endpoint().await;
        let mut events = endpoint.subscribe();
        let stream = live(LiveOptions::default());
        let media = endpoint
            .publish_live(4, stream.clone(), TsMime::Mp2t)
            .unwrap();
        let head = request(&endpoint, "HEAD", &media.uri, "").await;
        assert!(head.body().await.is_empty());
        let mut a = request(&endpoint, "GET", &media.uri, "").await;
        let mut b = request(&endpoint, "GET", &media.uri, "").await;
        assert!(!endpoint.diagnostics().first_get_written);
        push(&stream, 0, 2, true);
        let first = timeout(Duration::from_secs(1), async {
            loop {
                let event = events.recv().await.unwrap();
                if event.stage == HttpStage::FirstByte {
                    break event;
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(first.context, context());
        assert_eq!(first.generation, Some(4));
        assert_eq!(first.http_status, Some(200));
        assert!(first.bytes_written > 0);
        assert_eq!(first.result, Ok(()));
        let mut packet = [0; 188];
        a.socket.read_exact(&mut packet).await.unwrap();
        b.socket.read_exact(&mut packet).await.unwrap();
        assert_eq!(
            endpoint
                .diagnostics()
                .stages
                .iter()
                .filter(|e| e.stage == HttpStage::FirstByte)
                .count(),
            1
        );
        let next = live(LiveOptions::default());
        let media = endpoint
            .publish_live(5, next.clone(), TsMime::Mp2t)
            .unwrap();
        assert!(!endpoint.diagnostics().first_get_written);
        push(&next, 0, 3, true);
        next.finish(true);
        assert_eq!(
            request(&endpoint, "GET", &media.uri, "")
                .await
                .body()
                .await
                .len(),
            188
        );
        let diag = endpoint.shutdown().await;
        assert!(diag.first_get_written);
        assert_eq!(
            diag.stages
                .iter()
                .filter(|e| e.stage == HttpStage::FirstByte)
                .count(),
            2
        );
    });
}

#[test]
fn live_midstream_join_uses_playback_keyframe_and_ignores_every_range() {
    run(async {
        let endpoint = endpoint().await;
        let stream = live(LiveOptions::default());
        for i in 0..15 {
            push(&stream, i64::from(i) * 1_000_000, i, i % 3 == 0);
        }
        stream.set_elapsed(Duration::from_secs(10));
        stream.finish(true);
        let media = endpoint
            .publish_live(1, stream.clone(), TsMime::Mp2t)
            .unwrap();
        for range in [
            "bytes=0-0",
            "bytes=-0",
            "bytes=999999999-",
            "bytes=malformed",
            "items=2-3",
        ] {
            let mut response =
                request(&endpoint, "GET", &media.uri, &format!("Range: {range}\r\n")).await;
            assert_eq!(response.status, 200);
            common(&response, "video/MP2T", false, false);
            assert!(!response.headers.contains_key("content-length"));
            assert!(!response.headers.contains_key("content-range"));
            let mut data = [0; 188 * 6];
            timeout(
                Duration::from_secs(1),
                response.socket.read_exact(&mut data),
            )
            .await
            .unwrap()
            .unwrap();
            assert_eq!(data[21], 0x65);
            assert_eq!(data[22], 9);
            for (index, p) in data.chunks_exact(188).enumerate() {
                assert_eq!(p[3] & 15, index as u8);
                assert_eq!(p[9], (index + 9) as u8); // PCR untouched
            }
        }
        let head = request(&endpoint, "HEAD", &media.uri, "Range: bytes=7-9\r\n").await;
        assert_eq!(head.status, 200);
        assert!(!head.headers.contains_key("content-length"));
        assert!(head.body().await.is_empty());
        endpoint.shutdown().await;
    });
}

#[test]
fn live_default_five_second_burst_then_one_x_and_configurable_burst() {
    run(async {
        for (burst, times) in [
            (Duration::from_secs(5), [0, 2_000_000, 4_000_000, 6_000_000]),
            (Duration::from_secs(1), [0, 200_000, 500_000, 2_000_000]),
        ] {
            let endpoint = endpoint().await;
            let options = LiveOptions {
                burst,
                ..LiveOptions::default()
            };
            assert!(
                matches!(options.pacing(), crate::experimental_libav::cast_mux::CastPacing::Realtime { burst: b } if b == burst)
            );
            let stream = live(options);
            for (i, time) in times.into_iter().enumerate() {
                push(&stream, time, i as u8, i == 0);
            }
            stream.finish(true);
            let media = endpoint.publish_live(1, stream, TsMime::Mp2t).unwrap();
            let mut response = request(&endpoint, "GET", &media.uri, "").await;
            let since = Instant::now();
            let mut first = [0; 188 * 3];
            timeout(
                Duration::from_millis(500),
                response.socket.read_exact(&mut first),
            )
            .await
            .unwrap()
            .unwrap();
            let mut last = [0; 188];
            assert!(
                timeout(
                    Duration::from_millis(300),
                    response.socket.read_exact(&mut last)
                )
                .await
                .is_err()
            );
            timeout(
                Duration::from_secs(2),
                response.socket.read_exact(&mut last),
            )
            .await
            .unwrap()
            .unwrap();
            assert!(since.elapsed() >= Duration::from_millis(850));
            assert_eq!(last[22], 3);
            endpoint.shutdown().await;
        }
    });
}

#[test]
fn lagging_live_reader_jumps_to_keyframe_with_discontinuity_and_continuous_cc() {
    run(async {
        let endpoint = endpoint().await;
        let stream = live(LiveOptions {
            burst: Duration::ZERO,
            max_client_lag: Duration::from_millis(100),
            ..LiveOptions::default()
        });
        push(&stream, 0, 0, true);
        let media = endpoint
            .publish_live(1, stream.clone(), TsMime::Mp2t)
            .unwrap();
        let mut response = request(&endpoint, "GET", &media.uri, "").await;
        let mut first = [0; 188];
        response.socket.read_exact(&mut first).await.unwrap();
        push(&stream, 1_000_000, 1, false);
        // The reader is now pacing a complete PES. Simulate elapsed media time
        // and eviction while that unit is in flight.
        sleep(Duration::from_millis(80)).await;
        for i in 2..140 {
            push(&stream, i64::from(i) * 1_000_000, i, i % 3 == 0);
        }
        stream.set_elapsed(Duration::from_secs(139));
        stream.finish(true);
        let mut rest = Vec::new();
        timeout(
            Duration::from_secs(3),
            response.socket.read_to_end(&mut rest),
        )
        .await
        .unwrap()
        .unwrap();
        let packets: Vec<_> = rest.chunks_exact(188).collect();
        assert_eq!(packets.len(), 4); // old paced packet, marker, key 138, packet 139
        assert_eq!(packets[0][22], 1);
        assert_eq!(packets[0][3] & 15, 1);
        assert_eq!(packets[1][3] & 0x30, 0x20);
        assert_eq!(packets[1][5] & 0x80, 0x80);
        assert_eq!(packets[1][3] & 15, 1);
        assert_eq!(packets[2][21], 0x65);
        assert_eq!(packets[2][22], 138);
        assert_eq!(packets[2][3] & 15, 2);
        assert_eq!(packets[3][3] & 15, 3);
        let diag = endpoint.shutdown().await;
        let jump = diag
            .stages
            .iter()
            .find(|e| e.stage == HttpStage::LiveJump)
            .unwrap();
        assert_eq!(jump.media_time_us, Some(138_000_000));
        assert_eq!(jump.live_start, Some(start()));
        let get = diag
            .stages
            .iter()
            .find(|e| e.stage == HttpStage::Get)
            .unwrap();
        assert_eq!(get.media_time_us, Some(0));
        assert_eq!(get.live_start, Some(start()));
        assert_eq!(jump.connection_id, get.connection_id);
    });
}

#[test]
fn live_retains_ten_seconds_whole_gops_and_fails_explicitly_at_memory_limit() {
    run(async {
        let stream = live(LiveOptions::default());
        for i in 0..40 {
            push(&stream, i64::from(i) * 1_000_000, i, i % 3 == 0);
        }
        let snapshot = stream.snapshot();
        assert!(snapshot.retained_span >= Duration::from_secs(10));
        assert!(snapshot.retained_span < Duration::from_secs(13));
        assert!(snapshot.keyframes >= 4);
        assert_eq!(snapshot.start, Some(start()));
        assert_eq!(snapshot.error, None);
        let limited = live(LiveOptions {
            max_bytes: 188 * 128,
            ..LiveOptions::default()
        });
        let bytes = packet(256, 0, true).repeat(128);
        limited
            .push(CastEvent::Data {
                bytes: &bytes,
                time_us: 0,
                key: true,
            })
            .unwrap();
        assert_eq!(
            limited.push(CastEvent::Data {
                bytes: &packet(256, 1, false),
                time_us: 1,
                key: false
            }),
            Err(LiveError::BufferLimit)
        );
        assert_eq!(limited.snapshot().buffered_bytes, bytes.len());
        assert_eq!(limited.snapshot().error, Some(LiveError::BufferLimit));
        // next's four-second-GOP refusal must not reappear here.
        let long = live(LiveOptions::default());
        push(&long, 0, 1, true);
        push(&long, 12_000_000, 2, false);
        assert_eq!(long.snapshot().retained_span, Duration::from_secs(12));
        assert_eq!(long.snapshot().error, None);
        assert!(matches!(
            LiveStream::new(LiveOptions {
                retention: Duration::from_secs(9),
                ..LiveOptions::default()
            }),
            Err(LiveError::InvalidOptions)
        ));
        assert!(matches!(
            LiveStream::new(LiveOptions {
                max_bytes: MAX_RING_BYTES + 1,
                ..LiveOptions::default()
            }),
            Err(LiveError::InvalidOptions)
        ));
    });
}

#[test]
fn cancellation_releases_listener_connections_and_session_budget_within_one_second() {
    run(async {
        let budget = Arc::new(Semaphore::new(MAX_SESSIONS));
        let mut endpoints = Vec::new();
        for _ in 0..MAX_SESSIONS {
            endpoints.push(
                CastEndpoint::bind_on(
                    Ipv4Addr::LOCALHOST,
                    Ipv4Addr::LOCALHOST,
                    context(),
                    ServerIdentity::default(),
                    budget.clone(),
                    16,
                )
                .await
                .unwrap(),
            );
        }
        assert!(matches!(
            CastEndpoint::bind_on(
                Ipv4Addr::LOCALHOST,
                Ipv4Addr::LOCALHOST,
                context(),
                ServerIdentity::default(),
                budget.clone(),
                16
            )
            .await,
            Err(EndpointError::SessionLimit)
        ));
        let endpoint = endpoints.pop().unwrap();
        let address = endpoint.local_addr();
        let media = endpoint
            .publish_live(1, live(LiveOptions::default()), TsMime::Mp2t)
            .unwrap();
        let mut sockets = Vec::new();
        for _ in 0..4 {
            sockets.push(request(&endpoint, "GET", &media.uri, "").await.socket);
        }
        let mut half = connect(&endpoint, None, false).await;
        half.write_all(b"GET /half HTTP/1.1\r\n").await.unwrap();
        let since = Instant::now();
        timeout(Duration::from_secs(1), endpoint.shutdown())
            .await
            .unwrap();
        for mut socket in sockets {
            let mut byte = [0];
            assert_eq!(
                timeout(Duration::from_secs(1), socket.read(&mut byte))
                    .await
                    .unwrap()
                    .unwrap(),
                0
            );
        }
        // Windows may reset a cancelled header connection whose request bytes
        // have not yet been consumed. Both EOF and reset prove it is closed;
        // the complete GETs above must still finish with clean EOF.
        let mut byte = [0];
        let half_closed = timeout(Duration::from_secs(1), half.read(&mut byte))
            .await
            .unwrap();
        assert!(
            matches!(half_closed, Ok(0))
                || half_closed.is_err_and(|e| matches!(
                    e.kind(),
                    std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted
                ))
        );
        let rebound = TcpListener::bind(address).await.unwrap();
        assert!(since.elapsed() < Duration::from_secs(1));
        drop(rebound);
        assert_eq!(budget.available_permits(), 1);
        for endpoint in endpoints {
            endpoint.shutdown().await;
        }
        assert_eq!(budget.available_permits(), MAX_SESSIONS);
    });
}

#[test]
fn accepted_connections_and_diagnostics_are_bounded() {
    if !crate::dlna::test_support::loopback_aliases(
        "accepted_connections_and_diagnostics_are_bounded",
        &(0..MAX_HEADERS)
            .map(|i| Ipv4Addr::new(127, 0, 0, i as u8 + 2))
            .collect::<Vec<_>>(),
    ) {
        return;
    }
    run(async {
        let endpoint = CastEndpoint::bind_on(
            Ipv4Addr::LOCALHOST,
            Ipv4Addr::LOCALHOST,
            context(),
            ServerIdentity::default(),
            Arc::new(Semaphore::new(1)),
            16,
        )
        .await
        .unwrap();
        let media = endpoint
            .publish_live(1, live(LiveOptions::default()), TsMime::Mp2t)
            .unwrap();
        let mut probes = Vec::new();
        for i in 0..MAX_HEADERS {
            let mut socket = connect(
                &endpoint,
                Some(Ipv4Addr::new(127, 0, 0, i as u8 + 2)),
                false,
            )
            .await;
            socket
                .write_all(format!("HEAD {} HTTP/1.1\r\nX: ", target(&media.uri)).as_bytes())
                .await
                .unwrap();
            probes.push(socket);
        }
        sleep(Duration::from_millis(100)).await;
        let mut extra = connect(&endpoint, None, false).await;
        extra
            .write_all(format!("HEAD {} HTTP/1.1\r\n\r\n", target(&media.uri)).as_bytes())
            .await
            .unwrap();
        assert_eq!(
            timeout(Duration::from_millis(500), reply(extra))
                .await
                .unwrap()
                .status,
            200
        );
        let mut first = probes.remove(0);
        let mut byte = [0];
        let closed = timeout(Duration::from_secs(1), first.read(&mut byte))
            .await
            .unwrap();
        assert!(
            matches!(closed, Ok(0))
                || closed.is_err_and(|e| matches!(
                    e.kind(),
                    std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted
                ))
        );
        for mut probe in probes {
            probe.write_all(b"done\r\n\r\n").await.unwrap();
            assert_eq!(reply(probe).await.status, 200);
        }
        let diag = endpoint.shutdown().await;
        assert_eq!(diag.stages.len(), 16);
        assert!(diag.dropped_stages > 0);
        assert!(!format!("{diag:?}").contains(&media.uri));
        assert!(!format!("{diag:?}").contains("127.0.0.1"));
    });
}

#[test]
fn dropping_endpoint_releases_port_budget_and_live_storage() {
    run(async {
        let endpoint = endpoint().await;
        let address = endpoint.local_addr();
        let stream = live(LiveOptions::default());
        push(&stream, 0, 0, true);
        let media = endpoint
            .publish_live(1, stream.clone(), TsMime::Mp2t)
            .unwrap();
        let mut response = request(&endpoint, "GET", &media.uri, "").await;
        let mut packet = [0; 188];
        response.socket.read_exact(&mut packet).await.unwrap();
        drop(endpoint);
        let mut byte = [0];
        assert_eq!(
            timeout(Duration::from_secs(1), response.socket.read(&mut byte))
                .await
                .unwrap()
                .unwrap(),
            0
        );
        timeout(Duration::from_secs(1), async {
            loop {
                if let Ok(listener) = TcpListener::bind(address).await {
                    break listener;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(stream.snapshot().buffered_bytes, 0);
        assert_eq!(stream.snapshot().keyframes, 0);
        assert_eq!(stream.snapshot().error, Some(LiveError::Cancelled));
    });
}

async fn backpressured_file() -> (Temp, CastEndpoint, Reply) {
    let temp = Temp::new();
    let path = temp.0.join("large.ts");
    // Sparse local fixture: large enough to fill native TCP windows without
    // allocating the file in memory or constructing a media encoder.
    std::fs::File::create(&path)
        .unwrap()
        .set_len(128 * 1024 * 1024)
        .unwrap();
    let endpoint = endpoint().await;
    let media = fixture_file(&endpoint, 1, &path, false, false);
    let mut socket = connect(&endpoint, None, true).await;
    socket
        .write_all(format!("GET {} HTTP/1.1\r\n\r\n", target(&media.uri)).as_bytes())
        .await
        .unwrap();
    let response = reply(socket).await;
    assert_eq!(response.status, 200);
    until(|| endpoint.diagnostics().bytes_written > 0).await;
    (temp, endpoint, response)
}

async fn settled(endpoint: &CastEndpoint) -> u64 {
    timeout(Duration::from_secs(4), async {
        loop {
            let before = endpoint.diagnostics().bytes_written;
            sleep(Duration::from_millis(250)).await;
            let after = endpoint.diagnostics().bytes_written;
            if before == after && after > 0 {
                break after;
            }
        }
    })
    .await
    .unwrap()
}

async fn resume_reading(endpoint: &CastEndpoint, response: &mut Reply, before: u64) {
    timeout(Duration::from_secs(5), async {
        let mut block = [0; 16 * 1024];
        while endpoint.diagnostics().bytes_written <= before {
            assert!(response.socket.read(&mut block).await.unwrap() > 0);
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[test]
fn real_backpressure_pauses_three_and_ten_seconds_then_resumes() {
    run(async {
        let (_temp, endpoint, mut response) = backpressured_file().await;
        // Every individual stall is shorter than the deadline. The separate
        // single_large_write test proves resetting within one send() call.
        for pause in [
            Duration::from_secs(3),
            Duration::from_secs(10),
            Duration::from_secs(3),
        ] {
            let before = settled(&endpoint).await;
            sleep(pause).await;
            assert!(
                !endpoint
                    .diagnostics()
                    .stages
                    .iter()
                    .any(|e| e.stage == HttpStage::Disconnect)
            );
            resume_reading(&endpoint, &mut response, before).await;
        }
        assert!(
            !endpoint
                .diagnostics()
                .stages
                .iter()
                .any(|e| e.disconnect_reason == Some(Reason::WriteStall))
        );
        let since = Instant::now();
        timeout(Duration::from_secs(1), endpoint.shutdown())
            .await
            .unwrap();
        assert!(since.elapsed() < Duration::from_secs(1));
    });
}

#[test]
fn real_backpressure_disconnects_only_after_fifteen_seconds_without_progress() {
    run(async {
        let (_temp, endpoint, _response) = backpressured_file().await;
        let since = Instant::now();
        timeout(Duration::from_secs(20), async {
            loop {
                if endpoint
                    .diagnostics()
                    .stages
                    .iter()
                    .any(|e| e.disconnect_reason == Some(Reason::WriteStall))
                {
                    break;
                }
                sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .unwrap();
        assert!(since.elapsed() >= Duration::from_millis(14_900));
        let diag = endpoint.shutdown().await;
        let terminal = diag
            .stages
            .iter()
            .find(|e| e.stage == HttpStage::Disconnect)
            .unwrap();
        assert_eq!(terminal.disconnect_reason, Some(Reason::WriteStall));
        assert!(terminal.bytes_written > 0);
        assert!(terminal.bytes_written < 128 * 1024 * 1024);
        assert!(diag.stages.iter().any(
            |e| e.stage == HttpStage::BytesWritten && e.bytes_written == terminal.bytes_written
        ));
    });
}

#[cfg(windows)]
#[test]
fn windows_accepted_socket_full_send_buffer_waits_for_slow_reader() {
    run(async {
        let (_temp, endpoint, mut response) = backpressured_file().await;
        let before = settled(&endpoint).await;
        sleep(Duration::from_secs(1)).await;
        assert!(
            !endpoint
                .diagnostics()
                .stages
                .iter()
                .any(|e| e.stage == HttpStage::Disconnect)
        );
        // This executes actual Winsock accept/readiness writes. Inherited
        // nonblocking mode must never turn WouldBlock into a terminal write error.
        let mut block = [0; 4096];
        for _ in 0..48 {
            assert!(
                timeout(Duration::from_secs(1), response.socket.read(&mut block))
                    .await
                    .unwrap()
                    .unwrap()
                    > 0
            );
            sleep(Duration::from_millis(5)).await;
        }
        until(|| endpoint.diagnostics().bytes_written > before).await;
        let diag = endpoint.shutdown().await;
        assert!(!diag.stages.iter().any(|e| matches!(
            e.disconnect_reason,
            Some(Reason::WriteError | Reason::WriteStall | Reason::PeerClosed)
        )));
    });
}

#[test]
fn continuity_handles_adaptation_only_wrap_all_pids_and_null_packets() {
    let mut continuity = continuity::Continuity::new();
    let mut bytes = Vec::new();
    for i in 0..20 {
        bytes.extend(packet(256, i, false));
    }
    bytes.extend(packet(0, 0, false));
    bytes.extend(packet(4096, 0, false));
    bytes.extend(packet(8191, 0, false));
    let original = bytes.clone();
    continuity.rewrite(&mut bytes);
    for (index, (actual, expected)) in bytes
        .chunks_exact(188)
        .zip(original.chunks_exact(188))
        .enumerate()
    {
        assert_eq!(&actual[..3], &expected[..3]);
        assert_eq!(&actual[4..], &expected[4..]);
        assert_eq!(
            actual[3] & 15,
            if index < 20 {
                index as u8 & 15
            } else if index == 22 {
                13
            } else {
                0
            }
        );
    }
    let markers: Vec<_> = continuity.discontinuities().collect();
    assert_eq!(markers.len(), 3);
    assert!(markers.iter().all(|p| p[3] & 0x30 == 0x20 && p[5] == 0x80));
    let marker = markers.iter().find(|p| p[2] == 0 && p[1] == 1).unwrap();
    assert_eq!(marker[3] & 15, 3);
    let mut adaptation = *marker;
    continuity.rewrite(&mut adaptation);
    assert_eq!(adaptation[3] & 15, 3);
    let mut next = packet(256, 20, false);
    continuity.rewrite(&mut next);
    assert_eq!(next[3] & 15, 4);
    assert!(continuity::valid(&bytes));
    assert!(!continuity::valid(&[0; 188]));
    assert!(!continuity::valid(&bytes[..bytes.len() - 1]));
}

#[test]
fn live_invalid_event_and_producer_failure_are_explicit_and_readers_do_not_cancel_producer() {
    run(async {
        let no_start = LiveStream::new(LiveOptions::default()).unwrap();
        assert_eq!(
            no_start.push(CastEvent::Data {
                bytes: &packet(256, 0, true),
                time_us: 0,
                key: true
            }),
            Err(LiveError::InvalidEvent)
        );
        let stream = live(LiveOptions::default());
        push(&stream, 0, 1, true);
        let endpoint = endpoint().await;
        let media = endpoint
            .publish_live(1, stream.clone(), TsMime::Mp2t)
            .unwrap();
        let response = request(&endpoint, "GET", &media.uri, "").await;
        drop(response);
        push(&stream, 1, 2, false);
        assert_eq!(stream.snapshot().error, None);
        let _response = request(&endpoint, "GET", &media.uri, "").await;
        stream.finish(false);
        until(|| {
            endpoint
                .diagnostics()
                .stages
                .iter()
                .any(|e| e.disconnect_reason == Some(Reason::ProducerFailed))
        })
        .await;
        assert_eq!(stream.snapshot().error, Some(LiveError::ProducerFailed));
        endpoint.shutdown().await;
        assert_eq!(
            stream.push(CastEvent::Start(start())),
            Err(LiveError::Cancelled)
        );
    });
}

#[test]
fn public_bind_rejects_unroutable_public_renderer_and_server_header_injection() {
    run(async {
        assert!(matches!(
            CastEndpoint::bind(
                Ipv4Addr::new(8, 8, 8, 8),
                context(),
                ServerIdentity::default()
            )
            .await,
            Err(EndpointError::Route(_))
        ));
        assert!(matches!(
            ServerIdentity::new("Windows", "11\r\nX: bad"),
            Err(EndpointError::InvalidServer)
        ));
    });
}
