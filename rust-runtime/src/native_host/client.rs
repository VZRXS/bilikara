//! JSON transport for an owned native Host window. This calls the existing
//! authenticated HTTP adapter; it never duplicates a command or AppState rule.
use reqwest::{blocking::Client, redirect::Policy};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    io::Read,
    sync::{
        Arc, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

const MAX_REQUEST: usize = 512 * 1024;
const MAX_RESPONSE: u64 = 16 * 1024 * 1024;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct NativeJsonRequest {
    pub method: String,
    pub path: String,
    pub client_id: String,
    pub body: Option<Value>,
}

impl NativeJsonRequest {
    fn verifies_scanner(&self) -> bool {
        self.method == "POST"
            && self.path.split('?').next() == Some("/api/player/automatic-volume")
            && self.body.as_ref().is_some_and(|body| {
                body.get("action").and_then(Value::as_str) == Some("enable")
                    && body.get("enabled").and_then(Value::as_bool) == Some(true)
            })
    }

    fn destination(&self, port: u16) -> Result<url::Url, &'static str> {
        if !matches!(self.method.as_str(), "GET" | "POST")
            || !self.path.starts_with("/api/")
            || self.path.len() > 8192
            || self
                .path
                .bytes()
                .any(|b| b.is_ascii_control() || b == b'\\' || !b.is_ascii())
            || self.client_id.len() > 128
            || self
                .client_id
                .bytes()
                .any(|b| b.is_ascii_control() || !b.is_ascii())
            || (self.method == "GET" && self.body.is_some())
            || (self.method == "POST" && !self.body.as_ref().is_some_and(Value::is_object))
            || self
                .body
                .as_ref()
                .is_some_and(|body| body.to_string().len() > MAX_REQUEST)
        {
            return Err("native_api_request");
        }
        let url = url::Url::parse(&format!("http://127.0.0.1:{port}{}", self.path))
            .map_err(|_| "native_api_request")?;
        if url.host_str() != Some("127.0.0.1")
            || url.port_or_known_default() != Some(port)
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
            || url.path() != self.path.split('?').next().unwrap_or("")
        {
            return Err("native_api_request");
        }
        Ok(url)
    }
}

#[derive(Serialize)]
pub struct NativeJsonReply {
    pub status: u16,
    pub body: Value,
}

/// The shell owns this capability. It is never serialized, logged, returned to
/// JavaScript, or accepted from a caller-supplied URL/header.
#[derive(Clone)]
pub struct NativeJsonClient {
    port: u16,
    host_capability: Arc<str>,
    stop: Arc<AtomicBool>,
    client: Arc<OnceLock<Result<Client, &'static str>>>,
}
impl NativeJsonClient {
    pub(super) fn new(port: u16, host_capability: String, stop: Arc<AtomicBool>) -> Self {
        Self {
            port,
            host_capability: host_capability.into(),
            stop,
            client: Arc::new(OnceLock::new()),
        }
    }

    /// Run off the UI thread. Exactly one HTTP attempt, including for POST:
    /// a lost response is not permission to repeat a committed command.
    pub fn execute(&self, request: NativeJsonRequest) -> Result<NativeJsonReply, &'static str> {
        let destination = request.destination(self.port)?;
        let verifies_scanner = request.verifies_scanner();
        if self.stop.load(Ordering::Acquire) {
            return Err("native_api_retired");
        }
        let client = self
            .client
            .get_or_init(|| {
                Client::builder()
                    .no_proxy()
                    .redirect(Policy::none())
                    .retry(reqwest::retry::never())
                    .connect_timeout(Duration::from_secs(3))
                    .timeout(Duration::from_secs(30))
                    .pool_max_idle_per_host(0)
                    .build()
                    .map_err(|_| "native_api_transport")
            })
            .as_ref()
            .map_err(|code| *code)?;
        let method = if request.method == "POST" {
            reqwest::Method::POST
        } else {
            reqwest::Method::GET
        };
        let mut outgoing = client
            .request(method, destination)
            .header(
                "Cookie",
                format!("bilikara_native={}", self.host_capability),
            )
            .header("Origin", format!("http://127.0.0.1:{}", self.port))
            .header("Accept", "application/json")
            .header("X-Bilikara-Client", request.client_id);
        if verifies_scanner {
            // First qualification is synchronous and has a 120-second decoder
            // budget. Control/state requests retain their ordinary deadline.
            outgoing = outgoing.timeout(Duration::from_secs(125));
        }
        if let Some(body) = request.body {
            outgoing = outgoing.json(&body);
        }
        let response = outgoing.send().map_err(|error| {
            if error.is_timeout() {
                "native_api_timeout"
            } else if error.is_connect() {
                "native_api_connect"
            } else {
                "native_api_transport"
            }
        })?;
        if response.status().is_redirection() {
            return Err("native_api_redirect");
        }
        let json = response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| {
                value
                    .split(';')
                    .next()
                    .is_some_and(|mime| mime.trim().eq_ignore_ascii_case("application/json"))
            });
        if !json {
            return Err("native_api_not_json");
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_RESPONSE)
        {
            return Err("native_api_response_limit");
        }
        let status = response.status().as_u16();
        let mut bytes = Vec::new();
        response
            .take(MAX_RESPONSE + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "native_api_read")?;
        if bytes.len() as u64 > MAX_RESPONSE {
            return Err("native_api_response_limit");
        }
        if self.stop.load(Ordering::Acquire) {
            return Err("native_api_retired");
        }
        let body = serde_json::from_slice(&bytes).map_err(|_| "native_api_invalid_json")?;
        Ok(NativeJsonReply { status, body })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Write, net::TcpListener, thread};
    fn request() -> NativeJsonRequest {
        NativeJsonRequest {
            method: "POST".into(),
            path: "/api/player/volume".into(),
            client_id: "host-fixture".into(),
            body: Some(serde_json::json!({"volume":50})),
        }
    }
    #[test]
    fn native_transport_rejects_origin_escape_headers_and_non_json_requests() {
        for path in [
            "/bootstrap/x",
            "https://example.org/api/state",
            "//example.org/api/state",
            "/api/../state",
            "/api/%2e%2e/state",
            "/api/state#fragment",
            "/api/\\evil",
            "/api/state\r\nX: bad",
        ] {
            let mut value = request();
            value.path = path.into();
            assert!(value.destination(8080).is_err(), "{path}");
        }
        let mut value = request();
        value.client_id = "x\r\nCookie: x".into();
        assert!(value.destination(8080).is_err());
        let mut value = request();
        value.method = "DELETE".into();
        assert!(value.destination(8080).is_err());
        let mut value = request();
        value.method = "GET".into();
        assert!(value.destination(8080).is_err());
        let mut value = request();
        value.body = Some(serde_json::json!({"large":"x".repeat(MAX_REQUEST)}));
        assert!(value.destination(8080).is_err());
        assert!(request().destination(8080).is_ok());
        let mut value = request();
        value.method = "GET".into();
        value.body = None;
        value.path = "/api/catalog/search?q=%E6%AD%8C&offset=6".into();
        assert!(value.destination(8080).is_ok());
    }
    fn server(response: &'static str) -> (u16, thread::JoinHandle<String>) {
        delayed_server(response, Duration::ZERO)
    }
    fn delayed_server(
        response: &'static str,
        delay: Duration,
    ) -> (u16, thread::JoinHandle<String>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let worker = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut byte = [0];
            while !bytes.ends_with(b"\r\n\r\n") {
                stream.read_exact(&mut byte).unwrap();
                bytes.push(byte[0]);
                assert!(bytes.len() < 8192);
            }
            let headers = String::from_utf8(bytes).unwrap();
            let size = headers
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length: ")
                        .and_then(|value| value.trim().parse::<usize>().ok())
                })
                .unwrap_or(0);
            let mut body = vec![0; size];
            stream.read_exact(&mut body).unwrap();
            thread::sleep(delay);
            // The short-deadline negative case deliberately closes first.
            let _ = stream.write_all(response.as_bytes());
            format!("{headers}{}", String::from_utf8(body).unwrap())
        });
        (port, worker)
    }
    fn client(port: u16) -> NativeJsonClient {
        NativeJsonClient::new(
            port,
            "fixture-capability".into(),
            Arc::new(AtomicBool::new(false)),
        )
    }
    #[test]
    fn native_transport_sends_one_authenticated_request_and_preserves_http_errors() {
        let (port, worker) = server(
            "HTTP/1.1 409 Conflict\r\nContent-Type: application/json\r\nContent-Length: 27\r\nConnection: close\r\n\r\n{\"ok\":false,\"code\":\"stale\"}",
        );
        let reply = client(port).execute(request()).unwrap();
        assert_eq!(reply.status, 409);
        assert_eq!(reply.body["code"], "stale");
        let captured = worker.join().unwrap();
        assert!(captured.starts_with("POST /api/player/volume HTTP/1.1\r\n"));
        assert!(
            captured
                .to_ascii_lowercase()
                .contains("cookie: bilikara_native=fixture-capability\r\n")
        );
        assert!(captured.ends_with("{\"volume\":50}"));
        let serialized = serde_json::to_string(&reply).unwrap();
        assert!(!serialized.contains("fixture-capability"));
        assert!(!serialized.contains("cookie"));
    }
    #[test]
    fn native_transport_never_follows_redirects_or_serves_binary_exports() {
        let (port, worker) = server(
            "HTTP/1.1 302 Found\r\nLocation: http://example.invalid/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        assert_eq!(
            client(port).execute(request()).err(),
            Some("native_api_redirect")
        );
        worker.join().unwrap();
        let (port, worker) = server(
            "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        assert_eq!(
            client(port).execute(request()).err(),
            Some("native_api_not_json")
        );
        worker.join().unwrap();
        let value = client(0);
        value.stop.store(true, Ordering::Release);
        assert_eq!(value.execute(request()).err(), Some("native_api_retired"));
    }

    #[test]
    fn scanner_verification_retains_its_work_budget_without_relaxing_controls() {
        let reply = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}";
        for verification in [false, true] {
            let (port, worker) = delayed_server(reply, Duration::from_millis(150));
            let value = client(port);
            assert!(
                value
                    .client
                    .set(Ok(Client::builder()
                        .no_proxy()
                        .timeout(Duration::from_millis(50))
                        .build()
                        .unwrap()))
                    .is_ok()
            );
            let mut input = request();
            if verification {
                input.path = "/api/player/automatic-volume".into();
                input.body = Some(serde_json::json!({"action":"enable","enabled":true}));
            }
            let result = value.execute(input);
            let received = worker.join().unwrap();
            assert!(received.starts_with("POST /api/player/"));
            if verification {
                assert_eq!(result.unwrap().body["ok"], true);
            } else {
                assert_eq!(result.err(), Some("native_api_timeout"));
            }
        }
    }
}
