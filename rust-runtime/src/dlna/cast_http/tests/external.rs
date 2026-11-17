use super::*;

#[test]
fn external_producer_lag_jumps_to_playback_keyframe_with_timestamp_basis() {
    let (stream, mut producer) = LiveStream::external(LiveOptions::default()).unwrap();
    producer.start(start()).unwrap();
    let mut cursor = live::Cursor::new();
    producer.push(&packet(256, 0, true), 0, true).unwrap();
    assert!(matches!(
        stream.read(&mut cursor),
        live::Read::Data {
            time_us: 0,
            jumped: false,
            ..
        }
    ));
    stream.set_elapsed(Duration::from_millis(4500));
    for i in 1..=9 {
        producer
            .push(
                &packet(256, i, i % 2 == 0),
                i64::from(i) * 1_000_000,
                i % 2 == 0,
            )
            .unwrap();
    }
    stream.set_elapsed(Duration::from_millis(6500));
    match stream.read(&mut cursor) {
        live::Read::Data {
            chunks,
            time_us,
            jumped,
            start: basis,
            ..
        } => {
            assert!(jumped);
            assert_eq!(time_us, 6_000_000);
            assert_eq!(basis, start());
            assert_eq!(chunks[0][21], 0x65);
            assert_eq!(chunks[0][22], 6);
        }
        _ => panic!("lagged external stream must jump to a playback keyframe"),
    }
    producer.finish(true).unwrap();
}

#[test]
fn external_producer_http_joins_playback_keyframe_and_rewrites_each_reader() {
    run(async {
        let endpoint = endpoint().await;
        let (stream, mut producer) = LiveStream::external(LiveOptions::default()).unwrap();
        let media = endpoint
            .publish_live(1, stream.clone(), TsMime::Mp2t)
            .unwrap();
        producer.start(start()).unwrap();
        assert!(
            matches!(producer.pacing(), crate::experimental_libav::cast_mux::CastPacing::Realtime { burst } if burst == Duration::from_secs(5))
        );
        for i in 0..=5 {
            producer
                .push(
                    &packet(256, i, i % 2 == 0),
                    i64::from(i) * 1_000_000,
                    i % 2 == 0,
                )
                .unwrap();
        }
        stream.set_elapsed(Duration::from_millis(2500));
        producer.finish(true).unwrap();
        for _ in 0..2 {
            let response = request(&endpoint, "GET", &media.uri, "Range: bytes=1-2\r\n").await;
            assert_eq!(response.status, 200);
            assert!(!response.headers.contains_key("content-length"));
            let bytes = response.body().await;
            assert_eq!(bytes.len(), 4 * 188);
            for (i, p) in bytes.chunks_exact(188).enumerate() {
                assert_eq!(p[22], i as u8 + 2);
                assert_eq!(p[3] & 15, i as u8);
            }
            assert_eq!(bytes[21], 0x65);
        }
        let diagnostics = endpoint.shutdown().await;
        let gets: Vec<_> = diagnostics
            .stages
            .iter()
            .filter(|e| e.stage == HttpStage::Get)
            .collect();
        assert_eq!(gets.len(), 2);
        assert!(
            gets.iter()
                .all(|e| e.media_time_us == Some(2_000_000) && e.live_start == Some(start()))
        );
    });
}

#[test]
fn external_producer_survives_reader_disconnect_but_generation_retirement_cancels() {
    run(async {
        let endpoint = endpoint().await;
        let (stream, mut producer) = LiveStream::external(LiveOptions::default()).unwrap();
        producer.start(start()).unwrap();
        producer.push(&packet(256, 0, true), 0, true).unwrap();
        let media = endpoint
            .publish_live(1, stream.clone(), TsMime::Mp2t)
            .unwrap();
        let mut response = request(&endpoint, "GET", &media.uri, "").await;
        let mut bytes = [0; 188];
        timeout(
            Duration::from_secs(3),
            response.socket.read_exact(&mut bytes),
        )
        .await
        .unwrap()
        .unwrap();
        drop(response);
        assert!(!producer.cancellation().load(Ordering::Acquire));
        producer
            .push(&packet(256, 1, false), 100_000, false)
            .unwrap();
        let (replacement, next) = LiveStream::external(LiveOptions::default()).unwrap();
        endpoint.publish_live(2, replacement, TsMime::Mpeg).unwrap();
        assert!(producer.cancellation().load(Ordering::Acquire));
        assert_eq!(
            producer.push(&packet(256, 2, true), 200_000, true),
            Err(LiveError::Cancelled)
        );
        assert_eq!(producer.finish(true), Err(LiveError::Cancelled));
        assert_eq!(stream.snapshot().buffered_bytes, 0);
        assert_eq!(request(&endpoint, "GET", &media.uri, "").await.status, 404);
        endpoint.shutdown().await;
        assert!(next.cancellation().load(Ordering::Acquire));
    });
}

#[test]
fn external_producer_drop_and_error_wake_waiting_reader() {
    run(async {
        for explicit in [false, true] {
            let (stream, mut producer) = LiveStream::external(LiveOptions::default()).unwrap();
            producer.start(start()).unwrap();
            let notified = stream.wake.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            assert!(matches!(
                stream.read(&mut live::Cursor::new()),
                live::Read::Wait
            ));
            if explicit {
                assert_eq!(producer.finish(false), Err(LiveError::ProducerFailed));
            } else {
                drop(producer);
            }
            timeout(Duration::from_secs(1), notified).await.unwrap();
            assert!(matches!(
                stream.read(&mut live::Cursor::new()),
                live::Read::End(Err(LiveError::ProducerFailed))
            ));
        }
    });
}

#[test]
fn external_producer_preserves_invalid_event_and_buffer_limit() {
    for invalid in [true, false] {
        let (stream, mut producer) = LiveStream::external(LiveOptions {
            max_bytes: 188 * 128,
            ..LiveOptions::default()
        })
        .unwrap();
        producer.start(start()).unwrap();
        let error = if invalid {
            producer.push(&packet(256, 0, false), 0, false).unwrap_err()
        } else {
            let bytes = packet(256, 0, true).repeat(128);
            producer.push(&bytes, 0, true).unwrap();
            producer.push(&packet(256, 1, false), 1, false).unwrap_err()
        };
        assert_eq!(
            error,
            if invalid {
                LiveError::InvalidEvent
            } else {
                LiveError::BufferLimit
            }
        );
        assert_eq!(producer.finish(true), Err(error));
        assert_eq!(stream.snapshot().error, Some(error));
    }
}

#[test]
fn external_producer_ahead_fails_before_eviction_and_wakes_readers() {
    run(async {
        let (stream, mut producer) = LiveStream::external(LiveOptions::default()).unwrap();
        producer.start(start()).unwrap();
        producer.push(&packet(256, 0, true), 0, true).unwrap();
        producer
            .push(&packet(256, 2, true), 2_000_000, true)
            .unwrap();
        let before = stream.snapshot();
        let notified = stream.wake.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        // At a near-zero playback point, accepting 12s would evict the GOP at
        // zero under the ten-second retention window and move a TV's join to 2s.
        assert_eq!(
            producer.push(&packet(256, 12, true), 12_000_000, true),
            Err(LiveError::ProducerAhead)
        );
        timeout(Duration::from_secs(1), notified).await.unwrap();
        let after = stream.snapshot();
        assert_eq!(after.buffered_bytes, before.buffered_bytes);
        assert_eq!(after.keyframes, before.keyframes);
        assert_eq!(after.retained_span, before.retained_span);
        assert_eq!(after.error, Some(LiveError::ProducerAhead));
        assert!(after.finished);
        assert!(matches!(
            stream.read(&mut live::Cursor::new()),
            live::Read::End(Err(LiveError::ProducerAhead))
        ));
        // Waiting cannot resume a failed generation or overwrite its cause.
        stream.set_elapsed(Duration::from_secs(20));
        assert_eq!(
            producer.push(&packet(256, 13, true), 13_000_000, true),
            Err(LiveError::ProducerAhead)
        );
        assert_eq!(producer.finish(false), Err(LiveError::ProducerAhead));
    });
}

#[test]
fn external_producer_lead_tracks_elapsed_time_and_configured_burst() {
    fn assert_send<T: Send>() {}
    assert_send::<LiveProducer>();
    for burst in [
        Duration::ZERO,
        Duration::from_secs(2),
        Duration::from_secs(5),
    ] {
        let (stream, mut producer) = LiveStream::external(LiveOptions {
            burst,
            ..LiveOptions::default()
        })
        .unwrap();
        producer.start(start()).unwrap();
        producer.push(&packet(256, 0, true), 0, true).unwrap();
        // The inclusive initial burst boundary is valid, including zero lead.
        let lead = burst.as_micros() as i64;
        producer.push(&packet(256, 1, true), lead, true).unwrap();
        stream.set_elapsed(Duration::from_secs(3));
        producer
            .push(&packet(256, 2, true), 3_000_000 + lead, true)
            .unwrap();
        assert_eq!(
            producer.push(&packet(256, 3, true), 4_000_000 + lead, true),
            Err(LiveError::ProducerAhead)
        );
        assert_eq!(producer.finish(true), Err(LiveError::ProducerAhead));
    }
}
