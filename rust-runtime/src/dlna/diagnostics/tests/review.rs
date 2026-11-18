use super::*;

#[test]
fn sink_ts_aliases_profiles_and_plain_mpeg_remain_distinct() {
    let t = trace(20);
    let id = t.begin_output(&context(), config(None));
    for sink in [
        "http-get:*:video/vnd.dlna.mpeg-tts:*",
        "http-get:*:video/mp2t:*",
        "http-get:*:video/MP2T:*",
        "http-get:*:video/mpeg_ts:*",
        "http-get:*:video/x-mpegts:*",
        "http-get:*:video/mpegts:*",
        "http-get:*:video/mpeg-ts:*",
        "http-get:*:video/mpeg:DLNA.ORG_PN=MPEG_TS_HD_NA_ISO;DLNA.ORG_OP=01",
        "http-get:*:video/mpeg:DLNA.ORG_PN=AVC_TS_HD_50_AC3",
        "http-get:*: video/x-mpeg :dlna.org_pn=vc1_ts_ap_l1_ac3",
        "http-get:*:video/mpeg:DLNA.ORG_PN=HEVC_TS_MAIN10",
    ] {
        t.capabilities(id, ProtocolState::Reported, &[sink.into()], true, false);
        assert_eq!(
            output(&t.report(), "output")["sink_mime_classes"],
            json!(["ts"]),
            "{sink}"
        );
    }
    for sink in [
        "http-get:*:video/mpeg:*",
        "http-get:*:video/x-mpeg:DLNA.ORG_PN=MPEG_PS_PAL",
        "http-get:*:video/mpeg:Secret=DLNA.ORG_PN=MPEG_TS_HD_NA",
    ] {
        t.capabilities(id, ProtocolState::Reported, &[sink.into()], true, false);
        assert_eq!(
            output(&t.report(), "output")["sink_mime_classes"],
            json!(["mpeg"])
        );
    }
}

#[test]
fn cancellation_retains_late_terminal_bytes_and_stops_at_sender_close() {
    run(async {
        let t = trace(20);
        let id = t.begin_output(&context(), config(None));
        let (sender, mut receiver) = tokio::sync::broadcast::channel(8);
        let cancel = super::super::super::CancellationToken::new();
        cancel.cancel();
        let mut receiving = Box::pin(t.receive_http(id, Duration::ZERO, &mut receiver, &cancel));
        // Ensure cancellation has been observed, with no terminal event queued yet.
        tokio::select! {
            _ = &mut receiving => panic!("receiver returned before late terminal event"),
            _ = tokio::time::sleep(Duration::from_millis(20)) => {}
        }
        let mut bytes = http(cast_http::HttpStage::BytesWritten);
        bytes.bytes_written = 4096;
        sender.send(bytes).unwrap();
        let mut end = http(cast_http::HttpStage::Disconnect);
        end.disconnect_reason = Some(Reason::Cancelled);
        sender.send(end).unwrap();
        drop(sender);
        tokio::time::timeout(Duration::from_millis(200), receiving)
            .await
            .unwrap();
        let r = t.report();
        assert_eq!(output(&r, "output")["bytes_written"], 4096);
        assert_eq!(output(&r, "output")["disconnects"], json!(["cancelled"]));
    });
}

#[test]
fn cancellation_grace_is_bounded_when_endpoint_sender_stays_open() {
    run(async {
        let t = trace(20);
        let id = t.begin_output(&context(), config(None));
        let (sender, mut receiver) = tokio::sync::broadcast::channel(8);
        let cancel = super::super::super::CancellationToken::new();
        cancel.cancel();
        tokio::time::timeout(
            Duration::from_secs(2),
            t.receive_http(id, Duration::ZERO, &mut receiver, &cancel),
        )
        .await
        .unwrap();
        assert_eq!(sender.receiver_count(), 1);
    });
}

#[test]
fn dropped_devices_are_deduplicated_and_overflow_is_not_reported_as_exact() {
    let t = trace(0);
    for n in 0..(DEVICES + 3) {
        let mut e = stage(Stage::Description, Ok(()));
        e.context.as_mut().unwrap().device_key = format!("key{n}");
        for _ in 0..10 {
            t.record_stage_at(None, None, Duration::ZERO, &e);
        }
    }
    let r = t.report();
    assert_eq!(r.diagnostics()["cast"]["dropped_devices"], 3);
    assert_eq!(r.diagnostics()["cast"]["dropped_device_observations"], 30);
    for n in 3..=DROPPED_DEVICE_KEYS {
        let mut e = stage(Stage::Description, Ok(()));
        e.context.as_mut().unwrap().device_key = format!("key{}", DEVICES + n);
        t.record_stage_at(None, None, Duration::ZERO, &e);
    }
    let r = t.report();
    assert!(r.diagnostics()["cast"]["dropped_devices"].is_null());
    assert_eq!(r.diagnostics()["cast"]["dropped_devices_lower_bound"], 4097);
    assert_eq!(t.lock().dropped_device_keys.len(), 4096);
}

#[test]
fn unnumbered_control_fault_matches_row_nine_and_has_compact_result() {
    for action in [
        SoapAction::Stop,
        SoapAction::SetAVTransportURI,
        SoapAction::Play,
    ] {
        let t = trace(20);
        let id = t.begin_output(&context(), config(Some(Cell::FileA)));
        t.record_stage_at(
            None,
            Some(id),
            Duration::ZERO,
            &stage(
                Stage::Action(action),
                Err(DlnaError::from(PolicyError::SoapFault(None))),
            ),
        );
        t.complete_output(id, UserAnswers::default());
        let r = t.report();
        assert_eq!(
            r.diagnostics()["cast_self_test"]["conclusion"]["decision_row"],
            9
        );
        assert_eq!(
            output(&r, "output")["actions"][0]["result"],
            "fault:unknown"
        );
        assert!(r.text().contains("fault:unknown"));
    }
}

#[test]
fn compact_action_results_preserve_error_precedence_and_success() {
    for (error, status, expected) in [
        (None, Some(200), "ok"),
        (
            Some(DlnaError::from(PolicyError::SoapFault(Some(714)))),
            Some(500),
            "fault:714",
        ),
        (
            Some(DlnaError {
                code: ErrorCode::HttpStatus,
                http_status: Some(500),
                upnp_code: None,
            }),
            Some(500),
            "http:5xx",
        ),
        (
            Some(DlnaError {
                code: ErrorCode::Timeout,
                http_status: None,
                upnp_code: None,
            }),
            None,
            "timeout",
        ),
        (
            Some(DlnaError {
                code: ErrorCode::Connect,
                http_status: None,
                upnp_code: None,
            }),
            None,
            "unreachable",
        ),
        (
            Some(DlnaError {
                code: ErrorCode::Cancelled,
                http_status: None,
                upnp_code: None,
            }),
            None,
            "cancelled",
        ),
        (
            Some(DlnaError::from(PolicyError::InvalidSoap)),
            Some(200),
            "failed",
        ),
    ] {
        assert_eq!(compact_result(error.as_ref(), status), expected);
    }
}

#[test]
fn diagnostic_metadata_removes_cc_and_all_cf_before_hashing_and_truncation() {
    let p = Privacy::new().unwrap();
    // Includes bidi/zero-width, Arabic, Syriac, musical and supplementary Cf.
    let formats = "\u{ad}\u{600}\u{61c}\u{6dd}\u{70f}\u{890}\u{8e2}\u{180e}\u{200b}\u{200c}\u{200d}\u{202a}\u{202b}\u{202c}\u{202d}\u{202e}\u{2060}\u{2069}\u{feff}\u{fff9}\u{110bd}\u{13430}\u{1bca0}\u{1d173}\u{e0001}\u{e0020}";
    let raw = format!("\0{formats}abc{formats}\r\n");
    let result = p.metadata(&raw, 3);
    assert_eq!(result.characters, 3);
    assert!(!result.truncated);
    assert!(result.controls_removed);
    assert_eq!(result.digest, p.metadata("abc", 3).digest);
    // Input text for UI/T1 is untouched; projection normalization is local.
    assert!(raw.contains('\u{202e}'));
}

#[test]
fn discovery_target_cross_references_require_explicit_t8_matches() {
    let t = trace(20);
    let c = t.begin_connection();
    let target = context();
    let mut discovered = context();
    discovered.device_key = "different-t2-key".into();
    t.discovery_facts(c, Duration::from_secs(5), Some(false), Some(true));
    t.discovery_target_facts(c, &target, None, Some(&discovered));
    let r = t.report();
    let connection = &r.diagnostics()["cast"]["connections"][0];
    assert_ne!(
        connection["target_device_key"],
        connection["matched_after_device_key"]
    );
    assert!(connection["matched_before_device_key"].is_null());
    assert_eq!(connection["target_after_auth"], true);
    assert!(!r.json().contains("different-t2-key"));
}

#[test]
fn decision_row_three_accepts_both_b_modes_and_row_four_remains_reachable() {
    for (file_b, live_b, row) in [(true, true, 3), (true, false, 3), (false, true, 4)] {
        let t = trace(20);
        for (cell, works) in [(Cell::FileB, file_b), (Cell::LiveB, live_b)] {
            let id = t.begin_output(&context(), config(Some(cell)));
            t.complete_output(
                id,
                UserAnswers {
                    video: if works {
                        VideoAnswer::Normal
                    } else {
                        VideoAnswer::Black
                    },
                    audio: if works { Answer::Yes } else { Answer::No },
                    synchronized: Answer::Unanswered,
                },
            );
        }
        assert_eq!(
            t.report().diagnostics()["cast_self_test"]["conclusion"]["decision_row"],
            row
        );
    }
}
