use super::*;
use std::{
    net::TcpListener,
    sync::atomic::{AtomicU64, Ordering},
};

struct Directory(std::path::PathBuf);
impl Directory {
    fn new() -> Self {
        static SEQUENCE: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "bilikara-announcements-{}-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn sample() -> Feed {
    parse(include_bytes!("../../../announcements/example.json")).unwrap()
}
fn now() -> i64 {
    timestamp("2026-09-01T12:00:00+09:00").unwrap()
}
fn fresh(directory: &Directory) -> State {
    let mut state = State::load(&directory.0, "0.8.0".into(), "android".into());
    state.finish(
        &directory.0,
        Ok(Refresh::Changed {
            feed: sample(),
            etag: Some("\"first\"".into()),
        }),
        now(),
    );
    state
}

#[test]
fn bounded_schema_rejects_bad_intervals_duplicate_ids_and_unsafe_metadata() {
    let mut feed = sample();
    feed.announcements[1].ends_at = Some("2026-09-01T10:00:00+09:00".into());
    assert!(feed.validate().is_err());
    feed = sample();
    feed.announcements[1].id = feed.announcements[0].id.clone();
    assert!(feed.validate().is_err());
    feed = sample();
    feed.announcements[0].platforms.push("unknown".into());
    assert!(feed.validate().is_err());
    feed = sample();
    feed.announcements[0].published_at = "2026-09-01T12:00:00".into();
    assert!(feed.validate().is_err());
    feed = sample();
    feed.announcements[0]
        .body_markdown
        .insert("zh".into(), "x".repeat(16385));
    assert!(feed.validate().is_err());
    assert!(parse(&vec![b' '; MAX_FEED_BYTES + 1]).is_err());
    assert!(validate_manifest(include_bytes!("../../../announcements/index.json")).is_ok());
}

#[test]
fn shown_batch_survives_restart_and_cached_feed_revalidation() {
    let directory = Directory::new();
    let mut state = fresh(&directory);
    let snapshot = state.snapshot(now());
    assert_eq!(snapshot["automatic_ids"].as_array().unwrap().len(), 2);
    let ids: Vec<String> = serde_json::from_value(snapshot["automatic_ids"].clone()).unwrap();
    state.shown(&directory.0, &ids).unwrap();
    // A process/session restart creates fresh operational state and reloads
    // only installation-owned records, never a previous queue/session seed.
    let mut reloaded = State::load(&directory.0, "0.8.0".into(), "android".into());
    assert_eq!(reloaded.snapshot(now())["automatic_ids"], json!([]));
    assert!(reloaded.fresh(now() + 1));
    assert!(!reloaded.fresh(now() + 301));
    reloaded.finish(&directory.0, Ok(Refresh::Unchanged), now() + 400);
    assert_eq!(reloaded.etag().as_deref(), Some("\"first\""));
    assert_eq!(
        reloaded.snapshot(now())["items"].as_array().unwrap().len(),
        2
    );
    reloaded.finish(
        &directory.0,
        Err("announcement_network".into()),
        now() + 500,
    );
    assert!(reloaded.fresh(now() + 501));
    assert_eq!(reloaded.snapshot(now())["automatic_ids"], json!([]));
    assert_eq!(reloaded.snapshot(now())["error"], "announcement_network");
}

#[test]
fn expired_notice_remains_manual_but_cannot_auto_pop_up_from_offline_cache() {
    let directory = Directory::new();
    let mut state = fresh(&directory);
    state.finish(&directory.0, Err("announcement_network".into()), now());
    let snapshot = state.snapshot(timestamp("2026-09-03T00:00:00Z").unwrap());
    assert_eq!(snapshot["automatic_ids"], json!(["example-release-0.8.0"]));
    assert_eq!(snapshot["items"][0]["expired"], true);
}

#[test]
fn corrupt_storage_is_preserved_without_blocking_manual_viewing() {
    let directory = Directory::new();
    let path = directory.0.join("announcements.json");
    fs::write(&path, "not json").unwrap();
    let mut state = State::load(&directory.0, "0.8.0".into(), "android".into());
    state.finish(
        &directory.0,
        Ok(Refresh::Changed {
            feed: sample(),
            etag: None,
        }),
        now(),
    );
    assert_eq!(state.snapshot(now())["storage_error"], true);
    assert_eq!(state.snapshot(now())["automatic_ids"], json!([]));
    assert_eq!(state.snapshot(now())["items"].as_array().unwrap().len(), 2);
    assert!(
        state
            .shown(&directory.0, &["example-release-0.8.0".into()])
            .is_err()
    );
    assert_eq!(fs::read_to_string(path).unwrap(), "not json");
}

#[test]
fn no_seen_id_is_evicted_and_invalid_refresh_never_replaces_last_good_feed() {
    let directory = Directory::new();
    let mut state = fresh(&directory);
    state.saved.shown = (0..MAX_SHOWN).map(|i| format!("old-{i}")).collect();
    assert!(
        state
            .shown(&directory.0, &["example-release-0.8.0".into()])
            .is_err()
    );
    assert_eq!(state.saved.shown.len(), MAX_SHOWN);
    state.finish(
        &directory.0,
        parse(b"<html>error</html>").map(|feed| Refresh::Changed { feed, etag: None }),
        now(),
    );
    assert_eq!(state.etag().as_deref(), Some("\"first\""));
    assert_eq!(state.snapshot(now())["items"].as_array().unwrap().len(), 2);
}

#[test]
fn conditional_http_request_uses_etag_and_does_not_follow_redirects() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/feed", listener.local_addr().unwrap());
    let worker = std::thread::spawn(move || {
        for round in 0..3 {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut byte = [0];
            while !request.ends_with(b"\r\n\r\n") {
                stream.read_exact(&mut byte).unwrap();
                request.push(byte[0]);
            }
            let headers = String::from_utf8(request).unwrap().to_ascii_lowercase();
            match round {
                0 => {
                    assert!(!headers.contains("if-none-match"));
                    let body = serde_json::to_vec(&sample()).unwrap();
                    write!(stream, "HTTP/1.1 200 OK\r\nETag: \"test\"\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).unwrap();
                    stream.write_all(&body).unwrap();
                }
                1 => {
                    assert!(headers.contains("if-none-match: \"test\""));
                    stream.write_all(b"HTTP/1.1 304 Not Modified\r\nConnection: close\r\n\r\n").unwrap();
                }
                _ => stream.write_all(b"HTTP/1.1 302 Found\r\nLocation: https://example.invalid/never-fetch\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap(),
            }
        }
    });
    assert!(
        matches!(fetch_from(&url, None), Ok(Refresh::Changed { etag: Some(tag), .. }) if tag == "\"test\"")
    );
    assert!(matches!(
        fetch_from(&url, Some("\"test\"")),
        Ok(Refresh::Unchanged)
    ));
    assert!(matches!(fetch_from(&url, None), Err(message) if message == "announcement_http_302"));
    worker.join().unwrap();
}

#[test]
fn delayed_acknowledgement_survives_feed_replacement_and_write_failure_is_explicit() {
    let directory = Directory::new();
    let mut state = fresh(&directory);
    state.finish(
        &directory.0,
        Ok(Refresh::Changed {
            feed: Feed {
                schema_version: 1,
                announcements: vec![],
            },
            etag: None,
        }),
        now(),
    );
    state
        .shown(&directory.0, &["example-release-0.8.0".into()])
        .unwrap();
    state.finish(
        &directory.0,
        Ok(Refresh::Changed {
            feed: sample(),
            etag: None,
        }),
        now(),
    );
    assert!(
        !state.snapshot(now())["automatic_ids"]
            .as_array()
            .unwrap()
            .contains(&json!("example-release-0.8.0"))
    );
    // A directory at the pending-file path simulates a publication failure,
    // without platform-specific ACL changes or weakening filesystem guards.
    fs::create_dir(directory.0.join("announcements.pending")).unwrap();
    assert!(
        state
            .shown(&directory.0, &["example-service-20260901".into()])
            .is_err()
    );
    assert_eq!(state.snapshot(now())["storage_error"], true);
    assert_eq!(state.snapshot(now())["automatic_ids"], json!([]));
}
