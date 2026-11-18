use super::*;

#[test]
fn playback_join_bursts_backward_keyframe_seek_and_five_second_lead() {
    run(async {
        let endpoint = endpoint().await;
        let stream = live(LiveOptions::default());
        for i in 0..13 {
            push(&stream, i64::from(i) * 1_000_000, i, i == 0 || i == 10);
        }
        stream.set_elapsed(Duration::from_secs(7));
        stream.finish(true);
        let media = endpoint
            .publish_live(1, stream.clone(), TsMime::Mp2t)
            .unwrap();
        let response = request(&endpoint, "GET", &media.uri, "").await;
        let bytes = timeout(Duration::from_millis(500), response.body())
            .await
            .unwrap();
        assert_eq!(bytes.len(), 13 * 188);
        assert_eq!(bytes[21], 0x65);
        for (i, p) in bytes.chunks_exact(188).enumerate() {
            assert_eq!(p[22], i as u8);
        }
        let diag = endpoint.shutdown().await;
        assert!(!diag.stages.iter().any(|e| e.stage == HttpStage::LiveJump));
        let get = diag
            .stages
            .iter()
            .find(|e| e.stage == HttpStage::Get)
            .unwrap();
        assert_eq!(get.media_time_us, Some(0));
        assert_eq!(get.live_start, Some(start()));
    });
}

#[test]
fn time_lag_jumps_without_ring_eviction_and_reports_target_basis() {
    run(async {
        let endpoint = endpoint().await;
        let stream = live(LiveOptions {
            burst: Duration::ZERO,
            max_client_lag: Duration::from_millis(200),
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
        sleep(Duration::from_millis(80)).await;
        for i in 11..22 {
            push(&stream, i64::from(i) * 100_000, i, i == 20);
        }
        stream.set_elapsed(Duration::from_millis(2100));
        stream.finish(true);
        assert_eq!(stream.snapshot().retained_span, Duration::from_millis(2100));
        let bytes = response.body().await;
        let packets: Vec<_> = bytes.chunks_exact(188).collect();
        assert_eq!(packets.len(), 4);
        assert_eq!(packets[0][22], 1);
        assert_eq!(packets[1][5] & 0x80, 0x80);
        assert_eq!(packets[2][21], 0x65);
        assert_eq!(packets[2][22], 20);
        assert_eq!(packets[3][22], 21);
        let diag = endpoint.shutdown().await;
        let jump = diag
            .stages
            .iter()
            .find(|e| e.stage == HttpStage::LiveJump)
            .unwrap();
        assert_eq!(jump.media_time_us, Some(2_000_000));
        assert_eq!(jump.live_start, Some(start()));
    });
}

#[test]
fn lf_absolute_form_and_unparseable_ranges_preserve_capability_checks() {
    run(async {
        let temp = Temp::new();
        let endpoint = endpoint().await;
        let media = fixture_file(
            &endpoint,
            1,
            &temp.file("file.ts", b"0123456789"),
            false,
            false,
        );
        for target in [
            target(&media.uri).to_owned(),
            media.uri.clone(),
            format!("{}?probe=1", target(&media.uri)),
            format!("{}?probe=1", media.uri),
            format!("http://old-renderer:123{}", target(&media.uri)),
        ] {
            for ending in ["\n", "\r\n"] {
                let mut socket = connect(&endpoint, None, false).await;
                socket.write_all(format!("GET {target} HTTP/1.1{ending}Host: fixture{ending}Range: bytes=abc{ending}").as_bytes()).await.unwrap();
                let mut byte = [0];
                assert!(
                    timeout(Duration::from_millis(50), socket.read(&mut byte))
                        .await
                        .is_err()
                );
                socket.write_all(ending.as_bytes()).await.unwrap();
                let response = reply(socket).await;
                assert_eq!(response.status, 200);
                assert_eq!(response.body().await, b"0123456789");
            }
        }
        for path in [
            format!("/wrong/../{}", target(&media.uri).trim_start_matches('/')),
            format!("{}#fragment", target(&media.uri)),
            format!(
                "{}?token=ignored",
                target(&media.uri).replace("/1.ts", "/2.ts")
            ),
            format!(
                "{}?token=ignored",
                target(&media.uri).replace(&endpoint.token, &"0".repeat(32))
            ),
        ] {
            let mut socket = connect(&endpoint, None, false).await;
            socket
                .write_all(
                    format!("GET http://renderer{path} HTTP/1.1\nHost: ignored\n\n").as_bytes(),
                )
                .await
                .unwrap();
            assert_eq!(reply(socket).await.status, 404);
        }
        let mut socket = connect(&endpoint, None, false).await;
        let mut raw = format!("GET {} HTTP/1.1\nRange: bytes=", target(&media.uri)).into_bytes();
        raw.extend_from_slice(b"\xff\xfe\n\n");
        socket.write_all(&raw).await.unwrap();
        let response = reply(socket).await;
        assert_eq!(response.status, 200);
        assert_eq!(response.body().await, b"0123456789");
        let mut socket = connect(&endpoint, None, false).await;
        socket
            .write_all(format!("GET {} HTTP/1.1\nX: bad\rvalue\n\n", target(&media.uri)).as_bytes())
            .await
            .unwrap();
        assert_eq!(reply(socket).await.status, 400);
        endpoint.shutdown().await;
    });
}

#[test]
fn slow_header_flood_cannot_starve_valid_get_or_displace_active_gets() {
    run(async {
        let endpoint = endpoint().await;
        let stream = live(LiveOptions::default());
        let media = endpoint
            .publish_live(1, stream.clone(), TsMime::Mp2t)
            .unwrap();
        let mut active = Vec::new();
        for _ in 0..MAX_GETS {
            active.push(request(&endpoint, "GET", &media.uri, "").await);
        }
        let mut slow = Vec::new();
        for _ in 0..MAX_CONNECTIONS {
            let mut socket = connect(&endpoint, None, false).await;
            socket
                .write_all(b"GET /no-token HTTP/1.1\nX: half")
                .await
                .unwrap();
            slow.push(socket);
        }
        let since = Instant::now();
        let response = timeout(
            Duration::from_millis(700),
            request(&endpoint, "HEAD", &media.uri, ""),
        )
        .await
        .unwrap();
        assert_eq!(response.status, 200);
        assert!(response.body().await.is_empty());
        assert!(since.elapsed() < Duration::from_millis(700));
        push(&stream, 0, 42, true);
        for reader in &mut active {
            let mut bytes = [0; 188];
            timeout(
                Duration::from_millis(500),
                reader.socket.read_exact(&mut bytes),
            )
            .await
            .unwrap()
            .unwrap();
            assert_eq!(bytes[22], 42);
        }
        // A fresh GET remains prompt, replacing exactly the oldest active GET.
        let response = timeout(
            Duration::from_millis(700),
            request(&endpoint, "GET", &media.uri, ""),
        )
        .await
        .unwrap();
        assert_eq!(response.status, 200);
        stream.finish(true);
        assert_eq!(response.body().await.len(), 188);
        let diag = endpoint.shutdown().await;
        assert!(
            diag.stages
                .iter()
                .filter(
                    |e| e.result == Err(Reason::HeaderPreempted) && e.stage == HttpStage::Rejected
                )
                .count()
                >= MAX_CONNECTIONS - MAX_HEADERS_PER_PEER
        );
        assert_eq!(
            diag.stages
                .iter()
                .filter(|e| e.disconnect_reason == Some(Reason::Replaced))
                .count(),
            1
        );
        drop(slow);
    });
}

#[test]
fn single_large_write_progress_resets_stall_deadline() {
    run(async {
        let endpoint = endpoint().await;
        endpoint
            .publish_live(1, live(LiveOptions::default()), TsMime::Mp2t)
            .unwrap();
        let generation = endpoint
            .shared
            .current
            .lock()
            .unwrap()
            .media
            .clone()
            .unwrap();
        // Size the paused reader before listen(): the handshake must advertise a
        // window that its buffer can hold. Shrinking SO_RCVBUF after accept, and
        // below the loopback MSS (65483 on Linux), makes Linux drop full-size
        // segments and wait on backed-off retransmission and zero-window probes,
        // so resumed reading cannot produce prompt progress. The 8 MiB body still
        // far exceeds both kernel buffers, keeping the single send() backpressured.
        let listener = TcpSocket::new_v4().unwrap();
        listener.set_recv_buffer_size(256 * 1024).unwrap();
        listener.bind((Ipv4Addr::LOCALHOST, 0).into()).unwrap();
        let listener = listener.listen(1).unwrap();
        let sender = TcpSocket::new_v4().unwrap();
        sender.set_send_buffer_size(8192).unwrap();
        let mut sender = sender
            .connect(listener.local_addr().unwrap())
            .await
            .unwrap();
        // Same socket option as the endpoint's accepted connections.
        sender.set_nodelay(true).unwrap();
        let (mut reader, _) = listener.accept().await.unwrap();
        let shared = endpoint.shared.clone();
        const SIZE: usize = 8 * 1024 * 1024;
        let task = tokio::spawn(async move {
            let client = Client {
                id: 999,
                cancel: CancellationToken::new(),
                closed: CancellationToken::new(),
                header_phase: Arc::new(AtomicU8::new(1)),
            };
            let mut writer = Writer {
                socket: &mut sender,
                shared: &shared,
                generation: Some(&generation),
                connection: &client,
                status: Some(200),
                bytes: 0,
                media: None,
            };
            // Exactly ONE send() invocation. Renewing a deadline in a caller's
            // per-chunk loop cannot make this test pass.
            let result = writer.send(&vec![0x5a; SIZE], true).await;
            assert_eq!(result, Ok(()));
            assert_eq!(writer.bytes, SIZE as u64);
        });
        let since = Instant::now();
        let mut received = Vec::new();
        for pause in [5, 5, 6] {
            let before = settled(&endpoint).await;
            sleep(Duration::from_secs(pause)).await;
            assert!(
                !task.is_finished(),
                "single send must still be backpressured: before={before}, now={}, received={}",
                endpoint.diagnostics().bytes_written,
                received.len()
            );
            timeout(Duration::from_secs(3), async {
                let mut block = [0; 16 * 1024];
                while endpoint.diagnostics().bytes_written <= before {
                    let count = reader.read(&mut block).await.unwrap();
                    assert!(count > 0, "connection closed before successful progress");
                    received.extend_from_slice(&block[..count]);
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
        }
        assert!(since.elapsed() > WRITE_STALL);
        timeout(Duration::from_secs(8), reader.read_to_end(&mut received))
            .await
            .unwrap()
            .unwrap();
        task.await.unwrap();
        assert_eq!(received, vec![0x5a; SIZE]);
        endpoint.shutdown().await;
    });
}

#[test]
fn lag_jump_pins_all_continuations_of_large_pes_before_discontinuity() {
    run(async {
        let endpoint = endpoint().await;
        let stream = live(LiveOptions::default());
        let mut frame = Vec::new();
        for i in 0..(128 * 350) {
            let mut p = packet(256, (i % 251) as u8, i == 0);
            if i == 0 {
                p[16..18].fill(0);
            } else {
                p[1] &= !0x40;
                p[12..].fill((i % 251) as u8);
            }
            frame.extend(p);
        }
        for (i, bytes) in frame.chunks(188 * 128).enumerate() {
            stream
                .push(CastEvent::Data {
                    bytes,
                    time_us: 0,
                    key: i == 0,
                })
                .unwrap();
        }
        push(&stream, 1_000_000, 1, false); // closes the zero-length video PES
        let media = endpoint
            .publish_live(1, stream.clone(), TsMime::Mp2t)
            .unwrap();
        let mut socket = connect(&endpoint, None, true).await;
        socket
            .write_all(format!("GET {} HTTP/1.1\r\n\r\n", target(&media.uri)).as_bytes())
            .await
            .unwrap();
        let mut response = reply(socket).await;
        let written = settled(&endpoint).await;
        assert!(
            written < frame.len() as u64,
            "large PES must be in flight during eviction"
        );
        for i in 2..32 {
            push(&stream, i64::from(i) * 1_000_000, i, i % 3 == 0);
        }
        stream.set_elapsed(Duration::from_secs(31));
        stream.finish(true);
        let mut received = Vec::new();
        timeout(
            Duration::from_secs(12),
            response.socket.read_to_end(&mut received),
        )
        .await
        .unwrap()
        .unwrap();
        let mut counters = continuity::Continuity::new();
        counters.rewrite(&mut frame);
        assert_eq!(
            &received[..frame.len()],
            frame,
            "no video PES continuation may be lost"
        );
        let tail: Vec<_> = received[frame.len()..].chunks_exact(188).collect();
        assert_eq!(tail.len(), 3); // marker, complete IDR at 30s, complete PES at 31s
        assert_eq!(tail[0][3] & 0x30, 0x20);
        assert_eq!(tail[0][5] & 0x80, 0x80);
        assert_eq!(tail[1][21], 0x65);
        assert_eq!(tail[1][22], 30);
        assert_eq!(tail[2][22], 31);
        assert_eq!(tail[1][3] & 15, (frame.len() / 188 % 16) as u8);
        let diag = endpoint.shutdown().await;
        let jump = diag
            .stages
            .iter()
            .find(|e| e.stage == HttpStage::LiveJump)
            .unwrap();
        assert_eq!(jump.media_time_us, Some(30_000_000));
        assert_eq!(jump.live_start, Some(start()));
    });
}
