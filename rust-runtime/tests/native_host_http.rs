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
    // Real native startup seeds the desktop defaults before login/refresh.
    let defaults: Value = client
        .get(format!("{base}/api/gatcha/uids"))
        .header("cookie", &cookie)
        .send()
        .unwrap()
        .json()
        .unwrap();
    assert_eq!(defaults["data"]["count"], 27);
    assert_eq!(defaults["data"]["uids"][0], "3145040");
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
    // Local fixtures: pagination/search/random must not contact D1 or Bilibili.
    let entries: Vec<Value> = (0..221).map(|index| json!({
        "bvid":format!("BV{index:010}"),"title":format!("卡拉 高达 {index}"),"mid":"123",
        "url":format!("https://www.bilibili.com/video/BV{index:010}"),"owner_name":"Fixture",
        "fav_uid":"123","fav_folder_id":"456"
    })).collect();
    for (file, value) in [
        (
            "gatcha_uids.json",
            json!({"schema_version":2,"uids":["123"],"profiles":{}}),
        ),
        (
            "gatcha_cache.json",
            json!({"schema_version":3,"uids":{"123":entries},"profiles":{}}),
        ),
        (
            "gatcha_favlist.json",
            json!({"schema_version":2,"uids":["123"],"folders":[{"id":"456","uid":"123","title":"卡拉","media_count":221}],"items":entries}),
        ),
    ] {
        std::fs::write(directory.join(file), serde_json::to_vec(&value).unwrap()).unwrap();
    }
    let get = |path: &str| {
        client
            .get(format!("{base}{path}"))
            .header("cookie", &remote_cookie)
            .send()
            .unwrap()
    };
    for route in [
        "/api/gatcha/browse?uid=123",
        "/api/gatcha/favlist/browse?folder_id=123:456",
    ] {
        let mut ids = std::collections::HashSet::new();
        for offset in [0, 100, 200] {
            let page: Value = get(&format!("{route}&limit=100&offset={offset}"))
                .json()
                .unwrap();
            assert_eq!(page["ok"], true, "{page}");
            assert_eq!(page["data"]["matched_count"], 221);
            assert_eq!(page["data"]["has_more"], offset < 200);
            for item in page["data"]["items"].as_array().unwrap() {
                assert!(ids.insert(item["bvid"].as_str().unwrap().to_owned()));
            }
        }
        assert_eq!(ids.len(), 221);
        let page: Value = get(&format!("{route}&q=%E9%AB%98%E8%BE%BE%20220"))
            .json()
            .unwrap();
        assert_eq!(page["data"]["matched_count"], 1);
    }
    assert_eq!(get("/api/gatcha/browse?offset=-1").status(), 400);
    assert_eq!(
        get("/api/gatcha/browse?uid=123").json::<Value>().unwrap()["data"]["items"]
            .as_array()
            .unwrap()
            .len(),
        221
    );
    assert_eq!(
        get("/api/gatcha/favlist/browse?folder_id=123:456")
            .json::<Value>()
            .unwrap()["data"]["items"]
            .as_array()
            .unwrap()
            .len(),
        221
    );
    assert_eq!(
        get("/api/gatcha/search?q=220").json::<Value>().unwrap()["data"]["items"][0]["bvid"],
        "BV0000000220"
    );
    let config: Value = post(
        "/api/gatcha/pool-config",
        json!({"uid_weight":0,"favlist_weight":100}),
        &remote_cookie,
    )
    .json()
    .unwrap();
    assert_eq!(config["data"]["uid_options"][0]["count"], 221);
    assert_eq!(config["data"]["favlist_folder_options"][0]["id"], "123:456");
    assert_eq!(
        get("/api/gatcha/candidate").json::<Value>().unwrap()["data"]["source"],
        "favlist"
    );
    assert_eq!(
        post(
            "/api/gatcha/uids/preview",
            json!({"uid":"123","cookie":"fake"}),
            &cookie
        )
        .json::<Value>()
        .unwrap()["code"],
        "missing_cookie"
    );
    // Local fixtures: pagination/search/random must not contact D1 or Bilibili.
    let entries: Vec<Value> = (0..221).map(|index| json!({
        "bvid":format!("BV{index:010}"),"title":format!("卡拉 高达 {index}"),"mid":"123",
        "url":format!("https://www.bilibili.com/video/BV{index:010}"),"owner_name":"Fixture",
        "fav_uid":"123","fav_folder_id":"456"
    })).collect();
    for (file, value) in [
        (
            "gatcha_uids.json",
            json!({"schema_version":2,"uids":["123"],"profiles":{}}),
        ),
        (
            "gatcha_cache.json",
            json!({"schema_version":3,"uids":{"123":entries},"profiles":{}}),
        ),
        (
            "gatcha_favlist.json",
            json!({"schema_version":2,"uids":["123"],"folders":[{"id":"456","uid":"123","title":"卡拉","media_count":221}],"items":entries}),
        ),
    ] {
        std::fs::write(directory.join(file), serde_json::to_vec(&value).unwrap()).unwrap();
    }
    let get = |path: &str| {
        client
            .get(format!("{base}{path}"))
            .header("cookie", &remote_cookie)
            .send()
            .unwrap()
    };
    for route in [
        "/api/gatcha/browse?uid=123",
        "/api/gatcha/favlist/browse?folder_id=123:456",
    ] {
        let mut ids = std::collections::HashSet::new();
        for offset in [0, 100, 200] {
            let page: Value = get(&format!("{route}&limit=100&offset={offset}"))
                .json()
                .unwrap();
            assert_eq!(page["ok"], true, "{page}");
            assert_eq!(page["data"]["matched_count"], 221);
            assert_eq!(page["data"]["has_more"], offset < 200);
            for item in page["data"]["items"].as_array().unwrap() {
                assert!(ids.insert(item["bvid"].as_str().unwrap().to_owned()));
            }
        }
        assert_eq!(ids.len(), 221);
        let page: Value = get(&format!("{route}&q=%E9%AB%98%E8%BE%BE%20220"))
            .json()
            .unwrap();
        assert_eq!(page["data"]["matched_count"], 1);
    }
    assert_eq!(get("/api/gatcha/browse?offset=-1").status(), 400);
    assert_eq!(
        get("/api/gatcha/search?q=220").json::<Value>().unwrap()["data"]["items"][0]["bvid"],
        "BV0000000220"
    );
    let config: Value = post(
        "/api/gatcha/pool-config",
        json!({"uid_weight":0,"favlist_weight":100}),
        &remote_cookie,
    )
    .json()
    .unwrap();
    assert_eq!(config["data"]["uid_options"][0]["count"], 221);
    assert_eq!(config["data"]["favlist_folder_options"][0]["id"], "123:456");
    assert_eq!(
        get("/api/gatcha/candidate").json::<Value>().unwrap()["data"]["source"],
        "favlist"
    );
    assert_eq!(
        post(
            "/api/gatcha/uids/preview",
            json!({"uid":"123","cookie":"fake"}),
            &cookie
        )
        .json::<Value>()
        .unwrap()["code"],
        "missing_cookie"
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
    for source in ["played", "history"] {
        let url = format!("{base}/api/playlist/export-data?source={source}");
        assert_eq!(
            client
                .get(&url)
                .header("cookie", &remote_cookie)
                .send()
                .unwrap()
                .status(),
            403
        );
        let exported = client.get(&url).header("cookie", &cookie).send().unwrap();
        assert_eq!(exported.status(), 200);
        let payload: Value = exported.json().unwrap();
        assert_eq!(payload["data"]["source"], source);
        assert!(payload["data"]["rows"].is_array());
        assert!(
            !payload
                .to_string()
                .contains(cookie.split('=').nth(1).unwrap())
        );
    }
    assert_eq!(
        client
            .get(format!(
                "{base}/api/playlist/export-data?source=../host-state.json"
            ))
            .header("cookie", &cookie)
            .send()
            .unwrap()
            .status(),
        400
    );
    for source in ["played", "history"] {
        let url = format!("{base}/api/playlist/export-data?source={source}");
        assert_eq!(
            client
                .get(&url)
                .header("cookie", &remote_cookie)
                .send()
                .unwrap()
                .status(),
            403
        );
        let exported = client.get(&url).header("cookie", &cookie).send().unwrap();
        assert_eq!(exported.status(), 200);
        let payload: Value = exported.json().unwrap();
        assert_eq!(payload["data"]["source"], source);
        assert!(payload["data"]["rows"].is_array());
        assert!(
            !payload
                .to_string()
                .contains(cookie.split('=').nth(1).unwrap())
        );
    }
    assert_eq!(
        client
            .get(format!(
                "{base}/api/playlist/export-data?source=../host-state.json"
            ))
            .header("cookie", &cookie)
            .send()
            .unwrap()
            .status(),
        400
    );
    let diagnostic: Value = post("/api/diagnostics/markdown", json!({}), &cookie)
        .json()
        .unwrap();
    let markdown = diagnostic["data"]["markdown"].as_str().unwrap();
    assert!(markdown.contains("rust-native"));
    assert!(!markdown.contains(cookie.split('=').nth(1).unwrap()));
    assert!(!markdown.contains("bilibili-login.json"));
    // Browser export uses the native renderer callback, not a Host IPC bridge.
    // Inject only the platform renderer here; use real auth/projection/HTTP.
    let mode = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let renderer_mode = mode.clone();
    host.set_export_renderer(Arc::new(move |spec, path| {
        let data: Value = serde_json::from_str(spec).unwrap();
        assert!(data["data"]["rows"].is_array());
        assert_eq!(data["data"]["schema_version"], 1);
        assert!(
            path.file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("remote-export-")
        );
        std::fs::write(path, b"\xef\xbb\xbfCSV fixture").unwrap();
        match renderer_mode.load(std::sync::atomic::Ordering::SeqCst) {
            1 => return Err("injected renderer failure".into()),
            2 => std::thread::sleep(Duration::from_millis(500)),
            _ => {}
        }
        Ok(())
    }))
    .unwrap();
    let export_url = format!("{base}/api/playlist/export?format=csv&source=history&page_size=50");
    assert_eq!(client.get(&export_url).send().unwrap().status(), 403);
    assert_eq!(
        client
            .get(&export_url)
            .header("cookie", &remote_cookie)
            .header("origin", "https://evil.test")
            .send()
            .unwrap()
            .status(),
        403
    );
    assert_eq!(
        client
            .get(format!(
                "{base}/api/playlist/export?format=csv&source=../host-state.json"
            ))
            .header("cookie", &remote_cookie)
            .send()
            .unwrap()
            .status(),
        400
    );
    let exported = client
        .get(&export_url)
        .header("cookie", &remote_cookie)
        .send()
        .unwrap();
    assert_eq!(exported.status(), 200);
    assert_eq!(
        exported.headers()["content-type"],
        "text/csv; charset=utf-8"
    );
    assert_eq!(exported.headers()["cache-control"], "no-store");
    assert!(
        exported.headers()["content-disposition"]
            .to_str()
            .unwrap()
            .ends_with(".csv\"")
    );
    assert_eq!(
        exported.bytes().unwrap().as_ref(),
        b"\xef\xbb\xbfCSV fixture"
    );
    mode.store(1, std::sync::atomic::Ordering::SeqCst);
    assert_eq!(
        client
            .get(&export_url)
            .header("cookie", &remote_cookie)
            .send()
            .unwrap()
            .status(),
        503
    );
    mode.store(2, std::sync::atomic::Ordering::SeqCst);
    let parallel_client = client.clone();
    let parallel_url = export_url.clone();
    let parallel_cookie = remote_cookie.clone();
    let download = std::thread::spawn(move || {
        parallel_client
            .get(parallel_url)
            .header("cookie", parallel_cookie)
            .send()
            .unwrap()
            .bytes()
            .unwrap()
    });
    let scratch = directory.join("remote-exports");
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while std::fs::read_dir(&scratch).unwrap().count() == 0 && std::time::Instant::now() < deadline
    {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(
        client
            .get(&export_url)
            .header("cookie", &remote_cookie)
            .send()
            .unwrap()
            .status(),
        429
    );
    download.join().unwrap();
    std::thread::sleep(Duration::from_millis(30));
    assert_eq!(
        std::fs::read_dir(&scratch).unwrap().count(),
        0,
        "Completed and failed renders leave no private files"
    );
    drop(host);
    std::thread::sleep(Duration::from_millis(500));
    execute_app_state(AppStateRequest::Shutdown { schema_version: 1 });
    // Only this test's uniquely named private directory is removed.
    std::fs::remove_dir_all(&directory).unwrap();
}
