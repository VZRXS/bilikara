#![cfg(feature = "native-host")]

use bilikara_runtime::{
    AppStateRequest, execute_app_state, initialize_native_host,
    native_host::{Asset, NativeHost},
};
use reqwest::blocking::{Client, Response};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};

struct Fixture {
    directory: std::path::PathBuf,
    host: Option<NativeHost>,
    client: Client,
    base: String,
    host_cookie: String,
}

fn cookie(response: &Response) -> String {
    response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned()
}

impl Fixture {
    fn start() -> Self {
        let directory = std::env::temp_dir().join(format!(
            "bilikara-native-identity-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let seed = serde_json::from_value(json!({
            "session_started_at":1.0, "session_played_file":"fixture.json", "updated_at":1.0
        }))
        .unwrap();
        assert!(initialize_native_host(&directory, seed).error().is_none());
        let host = NativeHost::start(
            &directory,
            Arc::new(|path| {
                matches!(path, "index.html" | "remote.html").then(|| Asset {
                    bytes: b"<!doctype html><html lang=\"en\">identity fixture</html>".to_vec(),
                    mime: "text/html".into(),
                })
            }),
        )
        .unwrap();
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let response = client.get(host.bootstrap_url()).send().unwrap();
        assert_eq!(response.status(), 200);
        assert!(
            !response.headers()["set-cookie"]
                .to_str()
                .unwrap()
                .contains("Max-Age")
        );
        Self {
            directory,
            base: format!("http://127.0.0.1:{}", host.local_port()),
            host_cookie: cookie(&response),
            host: Some(host),
            client,
        }
    }

    fn post(&self, path: &str, cookie: &str, body: Value) -> Response {
        self.client
            .post(format!("{}{path}", self.base))
            .header("cookie", cookie)
            .header("x-bilikara-client", "identity-test")
            .json(&body)
            .send()
            .unwrap()
    }

    fn get(&self, path: &str, cookie: &str) -> Response {
        self.client
            .get(format!("{}{path}", self.base))
            .header("cookie", cookie)
            .send()
            .unwrap()
    }

    fn identity(&self, cookie: &str) -> Value {
        let response = self.get("/api/remote-identity", cookie);
        assert_eq!(response.status(), 200);
        response.json::<Value>().unwrap()["data"].clone()
    }

    fn ok(&self, path: &str, cookie: &str, body: Value) -> Value {
        let response = self.post(path, cookie, body);
        assert_eq!(response.status(), 200);
        response.json::<Value>().unwrap()["data"].clone()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        drop(self.host.take());
        execute_app_state(AppStateRequest::Shutdown { schema_version: 1 });
        std::fs::remove_dir_all(&self.directory).unwrap();
    }
}

#[test]
fn lan_identity_removal_and_rename_require_fresh_registration_not_name_reuse() {
    let f = Fixture::start();
    let host = &f.host_cookie;
    assert_eq!(f.get("/api/state", "").status(), 403);
    let first = f.get("/remote", "");
    assert_eq!(first.status(), 200);
    let first = cookie(&first);
    let second = cookie(&f.get("/remote", ""));
    f.ok(
        "/api/remote-identity/register",
        &first,
        json!({"name":"Alice"}),
    );
    assert_eq!(
        f.post(
            "/api/remote-identity/register",
            &second,
            json!({"name":"Alice"})
        )
        .status(),
        409
    );
    f.ok(
        "/api/remote-identity/register",
        &second,
        json!({"name":"Alice", "claim":true}),
    );
    assert_eq!(f.identity(&first)["name"], "Alice");
    assert_eq!(f.identity(&second)["name"], "Alice");
    let previous_identity_marker = f.identity(&first)["session_id"].clone();
    f.ok("/api/session-users/add", host, json!({"name":"Bob"}));
    assert_eq!(
        f.post("/api/remote-identity/rename", &first, json!({"name":"Bob"}))
            .status(),
        409
    );
    assert_eq!(f.identity(&first)["name"], "Alice");
    assert_eq!(
        f.post("/api/session-users/remove", &first, json!({"name":"Bob"}))
            .status(),
        403
    );

    f.ok("/api/session-users/remove", host, json!({"name":"Alice"}));
    assert_eq!(f.identity(&first)["registered"], false);
    // The old browser must not regain the singer merely because Host adds a
    // different person using the same display name.
    f.ok("/api/session-users/add", host, json!({"name":"Alice"}));
    let latest = f.get("/api/state", &first).json::<Value>().unwrap();
    assert_ne!(
        latest["data"]["remote_session_id"],
        previous_identity_marker
    );
    for device in [&first, &second] {
        assert_eq!(f.identity(device)["registered"], false);
        for name in ["Alice", "Injected"] {
            let denied = f.post("/api/remote-identity/rename", device, json!({"name":name}));
            assert_eq!(denied.status(), 403);
            assert_eq!(denied.json::<Value>().unwrap()["code"], "identity_required");
        }
        assert_eq!(
            f.post("/api/remote/connection-diagnostic", device, json!({}))
                .status(),
            403
        );
        assert_eq!(
            f.post(
                "/api/remote-identity/register",
                device,
                json!({"name":"Alice"})
            )
            .status(),
            409
        );
    }
    f.ok(
        "/api/remote-identity/register",
        &first,
        json!({"name":"Alice", "claim":true}),
    );
    f.ok(
        "/api/remote-identity/register",
        &second,
        json!({"name":"Alice", "claim":true}),
    );
    let renamed = f.ok(
        "/api/remote-identity/rename",
        &first,
        json!({"name":"Carla"}),
    );
    assert_eq!(renamed["name"], "Carla");
    assert_eq!(f.identity(&second)["registered"], false);
    f.ok("/api/session-users/add", host, json!({"name":"Alice"}));
    assert_eq!(f.identity(&second)["registered"], false);
    // A revoked browser can explicitly register another singer without a ban,
    // and refreshing the page preserves that newly registered identity.
    f.ok(
        "/api/remote-identity/register",
        &second,
        json!({"name":"Diana"}),
    );
    assert!(
        f.get("/remote", &second)
            .headers()
            .get("set-cookie")
            .is_none()
    );
    assert_eq!(f.identity(&second)["name"], "Diana");
    assert_eq!(
        f.post(
            "/api/session-users/remove",
            &second,
            json!({"name":"Carla"})
        )
        .status(),
        403
    );
    let state = f.get("/api/state", &second).json::<Value>().unwrap();
    assert_eq!(
        state["data"]["session_users"],
        json!(["Bob", "Carla", "Alice", "Diana"])
    );
    assert!(state["data"].get("remote_access").is_none());
    assert!(!state.to_string().contains(first.split('=').nth(1).unwrap()));
}
