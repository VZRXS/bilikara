#![cfg(feature = "native-host")]

use bilikara_runtime::{
    AppStateRequest, AppStateSeed, execute_app_state, initialize_native_host,
    native_host::{Asset, NativeHost},
};
use serde_json::{Value, json};
use std::{
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[test]
fn standalone_host_http_preserves_auth_identity_queue_and_media_boundaries() {
    let directory = std::env::temp_dir().join(format!(
        "bilikara-native-http-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let seed: AppStateSeed = serde_json::from_value(
        json!({"session_started_at":1.0,"session_played_file":"test.json","updated_at":1.0}),
    )
    .unwrap();
    assert!(initialize_native_host(&directory, seed).error().is_none());
    let obsolete = format!(
        "i-{}-0000000000000001/a-{}-0000000000000001",
        "a".repeat(32),
        "a".repeat(32)
    );
    for kind in ["artifacts", ".staging", ".retired"] {
        let path = directory.join("media").join(kind).join(&obsolete);
        std::fs::create_dir_all(&path).unwrap();
        std::fs::write(path.join("obsolete.mp4"), b"old generated test media").unwrap();
    }
    let untouched = directory.join("media/artifacts/not-an-owned-identity");
    std::fs::create_dir_all(&untouched).unwrap();
    std::fs::write(untouched.join("keep.txt"), b"do not remove unknown data").unwrap();
    let host = NativeHost::start(
        &directory,
        Arc::new(|path| match path {
            "index.html" | "remote.html" => Some(Asset {
                bytes: b"<!doctype html><html lang=\"en\">shared UI<script src=\"/internet-remote-host.js\" defer></script></html>".to_vec(),
                mime: "text/html".into(),
            }),
            _ => None,
        }),
    )
    .unwrap();
    for kind in ["artifacts", ".staging", ".retired"] {
        assert!(!directory.join("media").join(kind).join(&obsolete).exists());
    }
    assert!(untouched.join("keep.txt").is_file());
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    let base = format!("http://127.0.0.1:{}", host.local_port());
    let anonymous = client.get(format!("{base}/api/state")).send().unwrap();
    assert_eq!(anonymous.status(), 403);
    // Real WebView startup is a top-level cross-site navigation from Tauri's
    // asset origin. Test it separately from ordinary same-origin HTTP requests.
    let bootstrap = client
        .get(host.bootstrap_url())
        .header("sec-fetch-site", "cross-site")
        .header("sec-fetch-mode", "navigate")
        .header("sec-fetch-dest", "document")
        .send()
        .unwrap();
    assert_eq!(bootstrap.status(), 200);
    assert!(bootstrap.headers().get("location").is_none());
    assert_eq!(bootstrap.headers()["referrer-policy"], "no-referrer");
    assert_eq!(bootstrap.headers()["cache-control"], "no-store");
    assert!(
        bootstrap.headers()["content-security-policy"]
            .to_str()
            .unwrap()
            .contains("frame-ancestors 'none'")
    );
    let cookie = bootstrap.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    assert!(
        bootstrap.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .contains("HttpOnly")
    );
    assert!(
        bootstrap.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .contains("SameSite=Strict")
    );
    let entry_html = bootstrap.text().unwrap();
    assert!(entry_html.contains("url=/\""));
    assert!(!entry_html.contains(cookie.split('=').nth(1).unwrap()));
    for (mode, dest) in [
        ("cors", "empty"),
        ("no-cors", "image"),
        ("navigate", "iframe"),
    ] {
        let forbidden = client
            .get(host.bootstrap_url())
            .header("sec-fetch-site", "cross-site")
            .header("sec-fetch-mode", mode)
            .header("sec-fetch-dest", dest)
            .send()
            .unwrap();
        assert_eq!(forbidden.status(), 403);
        assert!(forbidden.headers().get("set-cookie").is_none());
    }
    let forged = client
        .get(format!("{base}/bootstrap/{}", "a".repeat(43)))
        .header("sec-fetch-site", "cross-site")
        .header("sec-fetch-mode", "navigate")
        .header("sec-fetch-dest", "document")
        .send()
        .unwrap();
    assert_eq!(forged.status(), 403);
    assert!(forged.headers().get("set-cookie").is_none());
    let rebinding = client
        .get(host.bootstrap_url())
        .header("host", format!("evil.test:{}", host.local_port()))
        .send()
        .unwrap();
    assert_eq!(rebinding.status(), 403);
    assert!(rebinding.headers().get("set-cookie").is_none());
    let same_origin = client
        .get(format!("{base}/api/state"))
        .header("cookie", &cookie)
        .header("origin", &base)
        .header("sec-fetch-site", "same-origin")
        .send()
        .unwrap();
    assert_eq!(same_origin.status(), 200);
    for path in [
        "/",
        "/api/state",
        "/api/health",
        "/api/events",
        "/media/test.mp4",
    ] {
        let cross_site = client
            .get(format!("{base}{path}"))
            .header("cookie", &cookie)
            .header("sec-fetch-site", "cross-site")
            .header("sec-fetch-mode", "navigate")
            .header("sec-fetch-dest", "document")
            .send()
            .unwrap();
        assert_eq!(cross_site.status(), 403);
        assert_eq!(cross_site.json::<Value>().unwrap()["code"], "origin");
    }
    let post = |path: &str, body: Value, cookie: &str| {
        client
            .post(format!("{base}{path}"))
            .header("cookie", cookie)
            .header("x-bilikara-client", "test-host")
            .json(&body)
            .send()
            .unwrap()
    };
    for origin in ["https://evil.test", "http://tauri.localhost", "null"] {
        let foreign = client
            .post(format!("{base}/api/session-users/add"))
            .header("cookie", &cookie)
            .header("origin", origin)
            .json(&json!({"name":"Attacker"}))
            .send()
            .unwrap();
        assert_eq!(foreign.status(), 403);
    }
    assert_eq!(
        post("/api/session-users/add", json!({"name":"Alice"}), &cookie).status(),
        200
    );
    let snapshot: Value = client
        .get(format!("{base}/api/state"))
        .header("cookie", &cookie)
        .send()
        .unwrap()
        .json()
        .unwrap();
    assert_eq!(snapshot["data"]["session_users"], json!(["Alice"]));
    assert_eq!(snapshot["data"]["capabilities"]["native_host"], true);
    assert!(!snapshot.to_string().contains("host-token"));
    let invite = snapshot["data"]["remote_access"]["local_url"]
        .as_str()
        .unwrap();
    for (mode, dest) in [
        ("cors", "empty"),
        ("no-cors", "image"),
        ("navigate", "iframe"),
    ] {
        let forbidden = client
            .get(invite)
            .header("sec-fetch-mode", mode)
            .header("sec-fetch-dest", dest)
            .send()
            .unwrap();
        assert_eq!(forbidden.status(), 403);
        assert!(forbidden.headers().get("set-cookie").is_none());
    }
    let join = client
        .get(invite)
        .header("sec-fetch-site", "cross-site")
        .header("sec-fetch-mode", "navigate")
        .header("sec-fetch-dest", "document")
        .send()
        .unwrap();
    assert_eq!(join.status(), 200);
    assert!(join.headers().get("location").is_none());
    let remote_cookie = join.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    assert_ne!(remote_cookie, cookie);
    let entry_html = join.text().unwrap();
    assert!(entry_html.contains("url=/remote\""));
    assert!(!entry_html.contains(remote_cookie.split('=').nth(1).unwrap()));
    assert_eq!(
        post(
            "/api/session-users/add",
            json!({"name":"MustNotAdd"}),
            &remote_cookie
        )
        .status(),
        403
    );
    assert_eq!(
        post(
            "/api/remote-identity/register",
            json!({"name":"Alice"}),
            &remote_cookie
        )
        .status(),
        409
    );
    let registered: Value = post(
        "/api/remote-identity/register",
        json!({"name":"Alice","claim":true}),
        &remote_cookie,
    )
    .json()
    .unwrap();
    assert_eq!(registered["data"]["name"], "Alice");
    let snapshot: Value = client
        .get(format!("{base}/api/state"))
        .header("cookie", &remote_cookie)
        .send()
        .unwrap()
        .json()
        .unwrap();
    assert!(snapshot["data"].get("remote_access").is_none());
    assert!(snapshot["data"]["bbdown"].get("login").is_none());
    assert_eq!(
        post(
            "/api/cache-policy",
            json!({"max_cache_items":5}),
            &remote_cookie
        )
        .status(),
        403
    );
    let policy = post(
        "/api/cache-policy",
        json!({"max_cache_items":4,"video_quality":"1080P 高清"}),
        &cookie,
    )
    .json::<Value>()
    .unwrap();
    assert_eq!(policy["data"]["cache_policy"]["max_cache_items"], 4);
    assert_eq!(
        policy["data"]["cache_policy"]["video_quality"],
        "1080P 高清"
    );
    assert!(
        policy["data"]["state_revision"].as_u64().unwrap()
            > snapshot["data"]["state_revision"].as_u64().unwrap()
    );
    assert_eq!(
        post(
            "/api/cache-policy",
            json!({"max_cache_items":2,"video_quality":"bad"}),
            &cookie
        )
        .status(),
        400
    );
    let saved: Value =
        serde_json::from_slice(&std::fs::read(directory.join("native-preferences.json")).unwrap())
            .unwrap();
    assert_eq!(saved["cache"]["max_cache_items"], 4);
    assert_eq!(saved["cache"]["video_quality"], "1080P 高清");
    // A failed write cannot publish an in-memory change or destroy the prior file.
    std::fs::create_dir(directory.join("native-preferences.pending")).unwrap();
    assert_eq!(
        post("/api/cache-policy", json!({"max_cache_items":1}), &cookie).status(),
        503
    );
    std::fs::remove_dir(directory.join("native-preferences.pending")).unwrap();
    let unchanged = client
        .get(format!("{base}/api/state"))
        .header("cookie", &cookie)
        .send()
        .unwrap()
        .json::<Value>()
        .unwrap();
    assert_eq!(
        unchanged["data"]["cache_policy"],
        policy["data"]["cache_policy"]
    );
    assert_eq!(
        client
            .get(format!("{base}/"))
            .header("cookie", &remote_cookie)
            .send()
            .unwrap()
            .status(),
        403
    );
    assert_eq!(
        client
            .get(format!("{base}/remote"))
            .header("cookie", &remote_cookie)
            .send()
            .unwrap()
            .status(),
        200
    );
    assert_eq!(
        client
            .get(format!("{base}/media/host-state.json"))
            .header("cookie", &cookie)
            .send()
            .unwrap()
            .status(),
        404
    );
    assert_eq!(
        post(
            "/api/playlist/add",
            json!({"url":"http://127.0.0.1/private","requester_name":"Alice"}),
            &cookie
        )
        .status(),
        400
    );
    assert_eq!(
        post("/api/player/volume", json!({"volume_percent":40}), &cookie).status(),
        200
    );
    let delay: Value = post(
        "/api/player/av-delay-action",
        json!({"type":"adjust","delta_ms":100}),
        &remote_cookie,
    )
    .json()
    .unwrap();
    assert_eq!(delay["data"]["effective_delay_ms"], 100);
    assert_eq!(
        post("/api/diagnostics/markdown", json!({}), &remote_cookie).status(),
        403
    );
    let diagnostic: Value = post("/api/diagnostics/markdown", json!({}), &cookie)
        .json()
        .unwrap();
    let markdown = diagnostic["data"]["markdown"].as_str().unwrap();
    assert!(markdown.contains("rust-native"));
    assert!(!markdown.contains(cookie.split('=').nth(1).unwrap()));
    assert!(!markdown.contains("bilibili-login.json"));
    drop(host);
    std::thread::sleep(Duration::from_millis(500));
    execute_app_state(AppStateRequest::Shutdown { schema_version: 1 });
    // Only this test's uniquely named private directory is removed.
    std::fs::remove_dir_all(&directory).unwrap();
}
