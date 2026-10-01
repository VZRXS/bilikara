#![cfg(feature = "native-host")]

use bilikara_runtime::{
    AppStateRequest, execute_app_state, initialize_native_host,
    native_host::{Asset, NativeHost},
};
use serde_json::{Value, json};
use std::{
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[test]
#[ignore = "Explicit public video download through the real native Host API/cache/publication pipeline"]
fn youtube_quick_request_reaches_ready_native_media_over_http() {
    let video_id =
        std::env::var("BILIKARA_TEST_YOUTUBE_VIDEO_ID").unwrap_or_else(|_| "YE7VzlLtp-4".into());
    let canonical = format!("https://www.youtube.com/watch?v={video_id}");
    let directory = std::env::temp_dir().join(format!(
        "bilikara-youtube-http-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let seed=serde_json::from_value(json!({"session_users":["Alice"],"session_started_at":1.0,"session_played_file":"test.json","updated_at":1.0})).unwrap();
    assert!(initialize_native_host(&directory, seed).error().is_none());
    let host = NativeHost::start(
        &directory,
        Arc::new(|path| {
            (path == "index.html").then(|| Asset {
                bytes: b"<!doctype html><html lang=\"en\">Test</html>".to_vec(),
                mime: "text/html".into(),
            })
        }),
    )
    .unwrap();
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap();
    let base = format!("http://127.0.0.1:{}", host.local_port());
    let bootstrap = client.get(host.bootstrap_url()).send().unwrap();
    assert!(bootstrap.status().is_success());
    let cookie = bootstrap.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let post = |path: &str, body: Value| {
        client
            .post(format!("{base}{path}"))
            .header("cookie", &cookie)
            .header("origin", &base)
            .json(&body)
            .send()
            .unwrap()
    };
    assert!(
        post(
            "/api/cache-policy",
            json!({"video_quality":"360P 流畅","audio_hires":false})
        )
        .status()
        .is_success()
    );
    let added = post(
        "/api/playlist/add",
        json!({"url":format!("{canonical}&list=ignored&radio=1"),"requester_name":"Alice"}),
    );
    assert!(
        added.status().is_success(),
        "metadata HTTP {}",
        added.status()
    );
    let added: Value = added.json().unwrap();
    let item = &added["data"]["current_item"];
    assert_eq!(item["media_source"]["provider"], "youtube");
    assert_eq!(item["original_url"], canonical);
    assert_eq!(item["bvid"], "");
    assert_eq!(item["owner_mid"], 0);
    let until = Instant::now() + Duration::from_secs(90);
    let ready = loop {
        let state: Value = client
            .get(format!("{base}/api/state"))
            .header("cookie", &cookie)
            .send()
            .unwrap()
            .json()
            .unwrap();
        let item = &state["data"]["current_item"];
        assert_ne!(
            item["cache_status"], "failed",
            "cache failed: {}",
            item["cache_message"]
        );
        if item["cache_status"] == "ready" {
            break item.clone();
        }
        if item["cache_status"] == "pending" {
            let diagnostics: Value = client
                .get(format!("{base}/api/diagnostics/native"))
                .header("cookie", &cookie)
                .send()
                .unwrap()
                .json()
                .unwrap();
            assert!(
                diagnostics["data"]["events"]
                    .as_array()
                    .is_none_or(|events| events.is_empty()),
                "native cache diagnostics: {}",
                diagnostics["data"]["events"]
            );
        }
        assert!(
            Instant::now() < until,
            "cache did not become ready: status={}, message={}",
            item["cache_status"],
            item["cache_message"]
        );
        std::thread::sleep(Duration::from_millis(500));
    };
    for url in [
        &ready["video_media_url"],
        &ready["audio_variants"][0]["audio_url"],
    ] {
        let url = url.as_str().unwrap();
        assert!(url.starts_with("/media/"));
        let response = client
            .get(format!("{base}{url}"))
            .header("cookie", &cookie)
            .header("Range", "bytes=0-4095")
            .send()
            .unwrap();
        assert_eq!(response.status(), 206);
        let bytes = response.bytes().unwrap();
        assert!(bytes.windows(4).any(|w| w == b"ftyp"));
    }
    let rating = post(
        "/api/rating/submit",
        json!({"play_id":ready["id"],"bvid":"","score":5,"session_user_name":"Alice"}),
    );
    assert!(!rating.status().is_success());
    eprintln!(
        "YouTube quick request: canonical metadata, native cache, video/audio HTTP ranges and rating exclusion passed"
    );
    drop(host);
    execute_app_state(AppStateRequest::Shutdown { schema_version: 1 });
    // Only this test's generated, uniquely named directory is removed.
    std::fs::remove_dir_all(directory).unwrap();
}
