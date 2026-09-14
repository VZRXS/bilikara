//! Shared PR109 QR-login engine. No HostContext, listener, persistence or state owner.
use reqwest::cookie::{CookieStore, Jar};
use serde::Serialize;
use serde_json::Value;
use std::{
    io::Read,
    sync::Arc,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[derive(Debug, Serialize)]
pub(crate) struct LoginError {
    pub status: u16,
    #[serde(rename = "kind")]
    pub code: String,
    pub message: String,
}
impl LoginError {
    pub(crate) fn new(status: u16, code: &str, message: impl Into<String>) -> Self {
        Self {
            status,
            code: code.into(),
            message: message.into(),
        }
    }
}
fn now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |v| v.as_secs_f64())
}
#[cfg(any(test, feature = "native-host"))]
const MAX_LOGIN_BYTES: u64 = 16 * 1024;
const GENERATE: &str = "https://passport.bilibili.com/x/passport-login/web/qrcode/generate";
const POLL: &str = "https://passport.bilibili.com/x/passport-login/web/qrcode/poll";
const QR_LIFETIME: Duration = Duration::from_secs(180);
const SCAN_MESSAGE: &str = "请使用哔哩哔哩 App 扫码，或截图后从扫一扫相册中选择";

/// Internal observations only, never deserialized from HTTP/UI input. No URL,
/// QR/key, cookie, response body or arbitrary upstream error text is retained.
#[derive(Clone, Debug, Serialize)]
pub(crate) struct LoginDiagnostic {
    pub at: f64,
    pub generation: u64,
    pub stage: &'static str,
    pub result: &'static str,
    pub elapsed_ms: u64,
    pub error_kind: Option<&'static str>,
    pub transport_hint: Option<&'static str>,
    pub http_status: Option<u16>,
    pub api_code: Option<i64>,
    pub poll_code: Option<i64>,
}

impl LoginDiagnostic {
    pub(crate) fn new(generation: u64, stage: &'static str) -> Self {
        Self {
            at: now(),
            generation,
            stage,
            result: "ok",
            elapsed_ms: 0,
            error_kind: None,
            transport_hint: None,
            http_status: None,
            api_code: None,
            poll_code: None,
        }
    }
}

fn transport_error(error: reqwest::Error, diagnostic: &mut LoginDiagnostic) {
    // Strip the poll URL before inspecting the source chain. Hints are a
    // classification, not raw error messages, and remain distinct from kind.
    let error = error.without_url();
    diagnostic.error_kind = Some(if error.is_timeout() {
        "timeout"
    } else if error.is_connect() {
        "connect"
    } else if error.is_body() {
        "body"
    } else if error.is_decode() {
        "decode"
    } else {
        "request"
    });
    let mut source = std::error::Error::source(&error);
    while let Some(cause) = source {
        let message = cause.to_string().to_ascii_lowercase();
        let hint = if message.contains("certificate") {
            Some("tls_certificate")
        } else if message.contains("tls") || message.contains("ssl") {
            Some("tls")
        } else if message.contains("dns") || message.contains("resolve") {
            Some("dns")
        } else if message.contains("connection reset") {
            Some("connection_reset")
        } else {
            None
        };
        if hint.is_some() {
            diagnostic.transport_hint = hint;
        }
        source = cause.source();
    }
}

#[cfg(any(test, feature = "native-host"))]
pub(crate) fn canonical_cookie(value: &str) -> Option<String> {
    if value.len() > MAX_LOGIN_BYTES as usize || value.contains(['\r', '\n', '\0']) {
        return None;
    }
    let allowed = [
        "SESSDATA",
        "bili_jct",
        "DedeUserID",
        "DedeUserID__ckMd5",
        "sid",
        "buvid3",
        "buvid4",
    ];
    let mut pairs = std::collections::BTreeMap::new();
    for entry in value.split(';') {
        let Some((name, value)) = entry.trim().split_once('=') else {
            continue;
        };
        if allowed.contains(&name) && !value.is_empty() && value.is_ascii() {
            pairs.insert(name, value);
        }
    }
    if !pairs.contains_key("SESSDATA") || !pairs.contains_key("bili_jct") {
        return None;
    }
    Some(
        pairs
            .iter()
            .map(|(name, value)| format!("{name}={value}"))
            .collect::<Vec<_>>()
            .join("; "),
    )
}

fn get_json(
    client: &reqwest::blocking::Client,
    url: &str,
    diagnostic: &mut LoginDiagnostic,
) -> Result<Value, LoginError> {
    let response = client.get(url).send().map_err(|error| {
        transport_error(error, diagnostic);
        LoginError::new(502, "login_network", "B 站登录请求失败，请检查网络后重试")
    })?;
    diagnostic.http_status = Some(response.status().as_u16());
    if !response.status().is_success() {
        return Err(LoginError::new(
            502,
            "login_http",
            format!("B 站登录返回 HTTP {}", response.status().as_u16()),
        ));
    }
    let mut bytes = Vec::new();
    response
        .take(128 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| LoginError::new(502, "login_body", "B 站登录响应读取失败"))?;
    if bytes.len() > 128 * 1024 {
        return Err(LoginError::new(502, "login_body", "B 站登录响应过大"));
    }
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| LoginError::new(502, "login_json", "B 站登录响应格式错误"))?;
    diagnostic.api_code = value["code"].as_i64();
    if diagnostic.stage == "poll" {
        diagnostic.poll_code = value["data"]["code"].as_i64();
    }
    if value["code"] != 0 {
        return Err(LoginError::new(
            502,
            "login_api",
            "B 站暂时无法完成登录，请稍后重试",
        ));
    }
    Ok(value)
}

pub(crate) fn error_result(error: &LoginError) -> &'static str {
    match error.code.as_str() {
        "login_network" => "network_error",
        "login_http" => "http_error",
        "login_body" => "body_error",
        "login_json" => "invalid_json",
        "login_api" => "api_error",
        "login_client" => "client_error",
        "login_qr" => "invalid_qr",
        "login_cookie" => "missing_cookie",
        "login_code" => "unknown_poll_code",
        "login_expired" => "expired",
        "login_storage" => "storage_error",
        _ => "internal_error",
    }
}

fn observe_json(
    client: &reqwest::blocking::Client,
    url: &str,
    generation: u64,
    stage: &'static str,
) -> (Result<Value, LoginError>, LoginDiagnostic) {
    let started = Instant::now();
    let mut diagnostic = LoginDiagnostic::new(generation, stage);
    let result = get_json(client, url, &mut diagnostic);
    diagnostic.elapsed_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
    if let Err(error) = &result {
        diagnostic.result = error_result(error);
    }
    (result, diagnostic)
}

fn valid_qr_url(value: &str) -> bool {
    url::Url::parse(value).is_ok_and(|url| {
        url.scheme() == "https"
            && matches!(
                url.host_str(),
                Some("passport.bilibili.com" | "account.bilibili.com")
            )
            && url.username().is_empty()
            && url.password().is_none()
            && url.port_or_known_default() == Some(443)
    })
}

fn poll_until_confirmed(
    mut request: impl FnMut() -> Result<Value, LoginError>,
    mut update: impl FnMut(&str) -> Result<(), LoginError>,
    mut wait: impl FnMut(Duration) -> bool,
) -> Result<bool, LoginError> {
    let mut delay = Duration::from_secs(2);
    let mut reconnecting = false;
    while wait(delay) {
        let response = request();
        // Cancellation/deadline also applies to responses arriving in flight.
        if !wait(Duration::ZERO) {
            return Ok(false);
        }
        let polled = match response {
            Err(error) if error.code == "login_network" => {
                if !reconnecting {
                    update("网络连接暂时中断，正在自动重试；无需重新扫码")?;
                }
                reconnecting = true;
                delay = (delay * 2).min(Duration::from_secs(8));
                continue;
            }
            result => result?, // HTTP/API rejection and malformed data remain terminal.
        };
        delay = Duration::from_secs(2);
        match polled["data"]["code"].as_i64() {
            Some(86101) if reconnecting => update(SCAN_MESSAGE)?,
            Some(86101) => {}
            Some(86090) => update("扫码成功，请在哔哩哔哩 App 中确认")?,
            Some(86038) => break,
            Some(0) => return Ok(true),
            _ => {
                return Err(LoginError::new(
                    502,
                    "login_code",
                    "B 站登录返回未知状态，请重新扫码",
                ));
            }
        }
        reconnecting = false;
    }
    Ok(false)
}

fn wait_for_poll(delay: Duration, deadline: Instant, mut is_active: impl FnMut() -> bool) -> bool {
    let wake_at = (Instant::now() + delay).min(deadline);
    loop {
        let now = Instant::now();
        if now >= deadline || !is_active() {
            return false;
        }
        if now >= wake_at {
            return true;
        }
        // Do not keep an obsolete login generation sleeping through backoff.
        thread::sleep((wake_at - now).min(Duration::from_millis(100)));
    }
}

pub(crate) fn run(
    generation: u64,
    is_active: impl Fn() -> bool,
    mut update: impl FnMut(&str, &str) -> Result<(), LoginError>,
    mut record: impl FnMut(LoginDiagnostic),
    cookie_policy: fn(&str) -> Option<String>,
) -> Result<Option<String>, LoginError> {
    if !is_active() {
        return Ok(None);
    }
    let mut request_json = |client: &reqwest::blocking::Client, url: &str, generation, stage| {
        let (result, diagnostic) = observe_json(client, url, generation, stage);
        record(diagnostic);
        result
    };
    let jar = Arc::new(Jar::default());
    let client = crate::http_client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .user_agent(crate::native_video::USER_AGENT)
        .referer(false)
        .default_headers({
            let mut headers = reqwest::header::HeaderMap::new();
            headers.insert(
                reqwest::header::REFERER,
                reqwest::header::HeaderValue::from_static("https://www.bilibili.com/"),
            );
            headers
        })
        .cookie_provider(jar.clone())
        .build()
        .map_err(|_| LoginError::new(502, "login_client", "无法初始化 B 站安全连接"))?;
    let generated = request_json(&client, GENERATE, generation, "generate")?;
    let qr = generated["data"]["url"]
        .as_str()
        .filter(|value| value.len() <= 4096)
        .ok_or_else(|| LoginError::new(502, "login_qr", "B 站未返回登录二维码"))?;
    // Bilibili's current API uses account.bilibili.com; older responses use
    // passport.bilibili.com. Both remain exact HTTPS origins, never arbitrary URLs.
    if !valid_qr_url(qr) {
        return Err(LoginError::new(502, "login_qr", "B 站二维码地址无效"));
    }
    let key = generated["data"]["qrcode_key"]
        .as_str()
        .filter(|value| !value.is_empty() && value.len() <= 256)
        .ok_or_else(|| LoginError::new(502, "login_qr", "B 站二维码标识缺失"))?;
    let deadline = Instant::now() + QR_LIFETIME;
    if !is_active() {
        return Ok(None);
    }
    update(qr, SCAN_MESSAGE)?;
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("qrcode_key", key)
        .append_pair("source", "main-fe-header")
        .finish();
    // Reuse this QR/key and cookie jar; retries never generate another login.
    let poll_url = format!("{POLL}?{query}");
    let confirmed = poll_until_confirmed(
        || request_json(&client, &poll_url, generation, "poll"),
        |message| update(qr, message),
        |delay| wait_for_poll(delay, deadline, &is_active),
    )?;
    if confirmed {
        let scope = url::Url::parse("https://api.bilibili.com/").expect("cookie scope");
        let cookie = jar
            .cookies(&scope)
            .and_then(|header| header.to_str().ok().and_then(cookie_policy))
            .ok_or_else(|| {
                LoginError::new(502, "login_cookie", "B 站登录响应缺少有效凭证，请重新扫码")
            })?;
        return Ok(Some(cookie));
    }
    if is_active() {
        return Err(LoginError::new(
            408,
            "login_expired",
            "二维码已过期，请重新生成",
        ));
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{io::Write, net::TcpListener};
    fn network_failure() -> LoginError {
        LoginError::new(502, "login_network", "test transport failure")
    }

    #[test]
    fn qr_poll_backs_off_with_a_cap_and_resets_after_recovery() {
        let mut responses = [
            Err(network_failure()),
            Err(network_failure()),
            Err(network_failure()),
            Ok(json!({"data":{"code":86101}})),
            Err(network_failure()),
            Ok(json!({"data":{"code":86090}})),
            Ok(json!({"data":{"code":0}})),
        ]
        .into_iter();
        let mut delays = Vec::new();
        let mut messages = Vec::new();
        assert!(
            poll_until_confirmed(
                || responses.next().expect("No extra requests"),
                |message| {
                    messages.push(message.to_owned());
                    Ok(())
                },
                |delay| {
                    if !delay.is_zero() {
                        delays.push(delay.as_secs());
                    }
                    true
                },
            )
            .unwrap()
        );
        assert_eq!(delays, [2, 4, 8, 8, 2, 4, 2]);
        assert_eq!(
            messages.len(),
            4,
            "Consecutive network failures do not churn QR state"
        );
        assert_eq!(messages[1], SCAN_MESSAGE);
        assert_eq!(messages[0], messages[2]);
        assert!(responses.next().is_none());
    }

    #[test]
    fn qr_poll_persistent_network_failure_ends_at_original_deadline() {
        let mut elapsed = Duration::ZERO;
        let mut requests = 0;
        let mut updates = 0;
        assert!(
            !poll_until_confirmed(
                || {
                    requests += 1;
                    Err(network_failure())
                },
                |_| {
                    updates += 1;
                    Ok(())
                },
                |delay| {
                    elapsed = (elapsed + delay).min(QR_LIFETIME);
                    elapsed < QR_LIFETIME
                },
            )
            .unwrap()
        );
        assert_eq!(elapsed, QR_LIFETIME);
        assert!(
            (20..=25).contains(&requests),
            "No busy loop or unbounded retries"
        );
        assert_eq!(updates, 1);
    }

    #[test]
    fn qr_poll_discards_late_success_and_error_after_cancellation_or_expiry() {
        use std::cell::Cell;
        for response in [Ok(json!({"data":{"code":0}})), Err(network_failure())] {
            let active = Cell::new(true);
            let mut response = Some(response);
            assert!(
                !poll_until_confirmed(
                    || {
                        active.set(false); // Deadline / logout / new generation while HTTP is in flight.
                        response.take().expect("No later polls")
                    },
                    |_| panic!("Obsolete request must not change login state"),
                    |_| active.get(),
                )
                .unwrap()
            );
        }
        assert!(
            !poll_until_confirmed(
                || panic!("Cancelled login must not make a request"),
                |_| panic!("Cancelled login must not change state"),
                |_| false,
            )
            .unwrap()
        );
    }

    #[test]
    fn qr_poll_does_not_retry_upstream_rejections_invalid_data_or_expired_qr() {
        for code in ["login_http", "login_api", "login_json", "login_body"] {
            let mut requests = 0;
            let error = poll_until_confirmed(
                || {
                    requests += 1;
                    Err(LoginError::new(502, code, "test rejection"))
                },
                |_| panic!("No retry state for terminal errors"),
                |_| true,
            )
            .unwrap_err();
            assert_eq!(error.code, code);
            assert_eq!(requests, 1);
        }
        assert!(
            !poll_until_confirmed(
                || Ok(json!({"data":{"code":86038}})),
                |_| panic!("Expired QR must not be retried"),
                |_| true,
            )
            .unwrap()
        );
        assert_eq!(
            poll_until_confirmed(|| Ok(json!({"data":{"code":123}})), |_| Ok(()), |_| true)
                .unwrap_err()
                .code,
            "login_code"
        );
    }

    #[test]
    fn qr_poll_wait_checks_cancellation_during_backoff_and_does_not_extend_deadline() {
        let now = Instant::now();
        assert!(!wait_for_poll(Duration::from_secs(8), now, || true));
        assert!(!wait_for_poll(Duration::ZERO, now + QR_LIFETIME, || false));
        let mut checks = 0;
        assert!(!wait_for_poll(
            Duration::from_secs(8),
            now + QR_LIFETIME,
            || {
                checks += 1;
                checks < 2
            }
        ));
        assert_eq!(checks, 2);
        assert!(
            now.elapsed() < Duration::from_secs(5),
            "Cancellation must not wait through 8s backoff"
        );
        assert!(!wait_for_poll(
            Duration::from_secs(8),
            Instant::now() + Duration::from_millis(1),
            || true
        ));
    }

    #[test]
    fn qr_poll_recovers_after_the_reported_four_waiting_polls_then_network_failure() {
        let client = crate::http_client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap();
        let mut step = 0;
        let mut observations = Vec::new();
        let result = poll_until_confirmed(
            || {
                let response = match step {
                    0..=3 => {
                        "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{\"code\":0,\"data\":{\"code\":86101}}"
                    }
                    4 => "", // A real transport failure, not an HTTP/API rejection.
                    5 => {
                        "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{\"code\":0,\"data\":{\"code\":86090}}"
                    }
                    6 => {
                        "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{\"code\":0,\"data\":{\"code\":0}}"
                    }
                    _ => panic!("Unexpected extra poll"),
                };
                step += 1;
                let (url, worker) = mock_response(response, Duration::ZERO);
                let (result, diagnostic) = observe_json(&client, &url, 1, "poll");
                worker.join().unwrap();
                observations.push(diagnostic);
                result
            },
            |_| Ok(()),
            |_| true,
        );
        assert!(
            result.unwrap(),
            "Transient connection failure must not discard a valid QR"
        );
        assert_eq!(step, 7);
        assert_eq!(observations[4].result, "network_error");
        assert_eq!(observations[5].poll_code, Some(86090));
        assert!(
            !serde_json::to_string(&observations)
                .unwrap()
                .contains("PRIVATE_KEY")
        );
    }

    fn mock_response(response: &'static str, delay: Duration) -> (String, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let worker = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = Vec::new();
            let mut byte = [0];
            while !request.ends_with(b"\r\n\r\n") {
                stream.read_exact(&mut byte).unwrap();
                request.push(byte[0]);
            }
            thread::sleep(delay);
            let _ = stream.write_all(response.as_bytes());
        });
        (
            format!("http://{address}/poll?qrcode_key=PRIVATE_KEY"),
            worker,
        )
    }

    #[test]
    fn login_request_diagnostics_distinguish_http_api_json_and_body_errors_without_secrets() {
        let client = crate::http_client::builder().no_proxy().build().unwrap();
        for (response, expected, status, api, poll) in [
            (
                "HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\nPRIVATE_BODY",
                "http_error",
                403,
                None,
                None,
            ),
            (
                "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nPRIVATE_BAD_JSON",
                "invalid_json",
                200,
                None,
                None,
            ),
            (
                "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{\"code\":-412,\"message\":\"PRIVATE_BODY\"}",
                "api_error",
                200,
                Some(-412),
                None,
            ),
            (
                "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{\"code\":0,\"data\":{\"code\":86090,\"url\":\"PRIVATE_QR\",\"cookie\":\"SESSDATA=PRIVATE_COOKIE\"}}",
                "ok",
                200,
                Some(0),
                Some(86090),
            ),
            (
                "HTTP/1.1 200 OK\r\nContent-Length: 1000\r\nConnection: close\r\n\r\n{}",
                "body_error",
                200,
                None,
                None,
            ),
        ] {
            let (url, worker) = mock_response(response, Duration::ZERO);
            let (result, diagnostic) = observe_json(&client, &url, 7, "poll");
            worker.join().unwrap();
            assert_eq!(result.is_ok(), expected == "ok");
            assert_eq!(diagnostic.result, expected);
            assert_eq!(diagnostic.http_status, Some(status));
            assert_eq!(diagnostic.api_code, api);
            assert_eq!(diagnostic.poll_code, poll);
            assert_eq!(diagnostic.stage, "poll");
            assert_eq!(diagnostic.generation, 7);
            let serialized = serde_json::to_string(&diagnostic).unwrap();
            for secret in ["PRIVATE", "http://", "qrcode_key", "SESSDATA", "Cookie"] {
                assert!(!serialized.contains(secret), "{serialized}");
            }
        }
    }

    #[test]
    fn login_transport_timeout_and_refused_connection_are_not_indistinguishable() {
        let client = crate::http_client::builder()
            .no_proxy()
            .timeout(Duration::from_millis(100))
            .build()
            .unwrap();
        let (url, worker) = mock_response("HTTP/1.1 200 OK\r\n\r\n{}", Duration::from_millis(250));
        let (result, diagnostic) = observe_json(&client, &url, 1, "generate");
        worker.join().unwrap();
        assert_eq!(result.unwrap_err().code, "login_network");
        assert_eq!(diagnostic.result, "network_error");
        assert_eq!(diagnostic.error_kind, Some("timeout"));
        assert!(diagnostic.elapsed_ms >= 90);
        assert_eq!(diagnostic.http_status, None);
        // The listener has gone away; the same endpoint now refuses a connection.
        // Windows may retry a refused loopback connect for over 100ms, so do
        // not reuse the deliberately tiny timeout from the first scenario.
        let connect_client = crate::http_client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let (_, refused) = observe_json(&connect_client, &url, 2, "generate");
        assert_eq!(refused.error_kind, Some("connect"));
        assert!(
            !serde_json::to_string(&refused)
                .unwrap()
                .contains("PRIVATE_KEY")
        );
    }

    #[test]
    fn qr_origin_accepts_both_official_accounts_without_widening_network_trust() {
        for value in [
            "https://passport.bilibili.com/scan?token=test",
            "https://account.bilibili.com/h5/account-h5/auth/scan-web?token=test",
        ] {
            assert!(valid_qr_url(value));
        }
        for value in [
            "http://account.bilibili.com/scan",
            "https://account.bilibili.com.evil.test/",
            "https://evil.test/",
            "https://user@account.bilibili.com/",
            "https://account.bilibili.com:8443/",
        ] {
            assert!(!valid_qr_url(value));
        }
    }
    #[test]
    fn cookie_accepts_only_required_bilibili_pairs_without_header_injection() {
        assert_eq!(
            canonical_cookie("junk=discard; SESSDATA=secret; bili_jct=csrf; DedeUserID=42")
                .unwrap(),
            "DedeUserID=42; SESSDATA=secret; bili_jct=csrf"
        );
        assert!(canonical_cookie("SESSDATA=secret").is_none());
        assert!(canonical_cookie("SESSDATA=secret\r\nHost: evil; bili_jct=x").is_none());
    }
}
