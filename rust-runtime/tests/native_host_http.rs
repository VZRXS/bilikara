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
    let host = NativeHost::start(
        &directory,
        Arc::new(|path| match path {
            "index.html" | "remote.html" => Some(Asset {
                bytes: b"<!doctype html>shared UI".to_vec(),
                mime: "text/html".into(),
            }),
            _ => None,
        }),
    )
    .unwrap();
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    let base = format!("http://127.0.0.1:{}", host.local_port());
    let anonymous = client.get(format!("{base}/api/state")).send().unwrap();
    assert_eq!(anonymous.status(), 403);
    let bootstrap = client.get(host.bootstrap_url()).send().unwrap();
    assert_eq!(bootstrap.status(), 303);
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
    let post = |path: &str, body: Value, cookie: &str| {
        client
            .post(format!("{base}{path}"))
            .header("cookie", cookie)
            .header("x-bilikara-client", "test-host")
            .json(&body)
            .send()
            .unwrap()
    };
    let foreign = client
        .post(format!("{base}/api/session-users/add"))
        .header("cookie", &cookie)
        .header("origin", "https://evil.test")
        .json(&json!({"name":"Attacker"}))
        .send()
        .unwrap();
    assert_eq!(foreign.status(), 403);
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
    let join = client.get(invite).send().unwrap();
    assert_eq!(join.status(), 303);
    let remote_cookie = join.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    assert_ne!(remote_cookie, cookie);
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
