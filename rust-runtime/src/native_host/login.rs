//! Bilibili's existing web QR flow, using native HTTP and the shared runtime
//! login-generation guard. The QR/key/cookie never appears in Remote snapshots.
use super::*;
use crate::{BilibiliLoginStatus, BilibiliLoginUpdate};
use reqwest::cookie::{CookieStore, Jar};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    time::Instant,
};

const COOKIE_FILE: &str = "bilibili-login.json";
const MAX_LOGIN_BYTES: u64 = 16 * 1024;
const GENERATE: &str = "https://passport.bilibili.com/x/passport-login/web/qrcode/generate";
const POLL: &str = "https://passport.bilibili.com/x/passport-login/web/qrcode/poll";

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

fn record(diagnostic: LoginDiagnostic) {
    let _ = with_app(|app| {
        app.native_login_diagnostic(diagnostic);
        Ok(())
    });
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

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SavedLogin {
    schema_version: u32,
    cookie: String,
}

fn io_error() -> ApiError {
    ApiError::new(503, "login_storage", "B 站登录存储不可用；原文件已保留")
}
fn private_options() -> OpenOptions {
    let options = OpenOptions::new();
    #[cfg(unix)]
    let options = {
        use std::os::unix::fs::OpenOptionsExt;
        let mut options = options;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        options
    };
    options
}
fn regular_or_missing(path: &Path) -> Result<(), ApiError> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_file() => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        _ => Err(io_error()),
    }
}

fn canonical_cookie(value: &str) -> Option<String> {
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

pub(super) fn load(directory: &Path) -> Result<String, ApiError> {
    let path = directory.join(COOKIE_FILE);
    regular_or_missing(&path)?;
    let file = match private_options().read(true).open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(_) => return Err(io_error()),
    };
    let mut bytes = Vec::new();
    file.take(MAX_LOGIN_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| io_error())?;
    if bytes.len() as u64 > MAX_LOGIN_BYTES {
        return Err(io_error());
    }
    let login: SavedLogin = serde_json::from_slice(&bytes).map_err(|_| io_error())?;
    if login.schema_version != 1 {
        return Err(io_error());
    }
    if login.cookie.is_empty() {
        Ok(String::new())
    } else {
        canonical_cookie(&login.cookie).ok_or_else(io_error)
    }
}

fn save(directory: &Path, cookie: &str) -> Result<(), ApiError> {
    if !cookie.is_empty() && canonical_cookie(cookie).as_deref() != Some(cookie) {
        return Err(io_error());
    }
    let destination = directory.join(COOKIE_FILE);
    let pending = directory.join("bilibili-login.pending");
    regular_or_missing(&destination)?;
    regular_or_missing(&pending)?;
    let bytes = serde_json::to_vec(&SavedLogin {
        schema_version: 1,
        cookie: cookie.into(),
    })
    .map_err(|_| io_error())?;
    if bytes.len() as u64 > MAX_LOGIN_BYTES {
        return Err(io_error());
    }
    let mut file = private_options()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&pending)
        .map_err(|_| io_error())?;
    file.write_all(&bytes)
        .and_then(|()| file.sync_all())
        .map_err(|_| io_error())?;
    drop(file);
    fs::rename(pending, destination).map_err(|_| io_error())
}

pub(super) fn begin(context: Arc<HostContext>, identity: &Identity) -> Result<Value, ApiError> {
    let generation = with_app(|app| {
        app.native_authorize(identity, true)?;
        let session = app.native();
        if !session.cookie.is_empty() || session.login_generation.is_some() {
            return Ok(None);
        }
        let generation = session
            .login
            .begin_bilibili_login("正在生成 B 站登录二维码".into());
        session.login_generation = Some(generation);
        session.revision += 1;
        Ok(Some(generation))
    })?;
    if let Some(generation) = generation {
        let context = context.clone();
        if thread::Builder::new()
            .name("native-bilibili-login".into())
            .spawn(move || {
                if let Err(error) = run(&context, generation) {
                    let _ = finish(&context, generation, Err(error));
                }
            })
            .is_err()
        {
            with_app(|app| {
                let session = app.native();
                session.login_generation = None;
                session.login.set_bilibili_login(
                    Some(generation),
                    BilibiliLoginUpdate {
                        state: BilibiliLoginStatus::Failed,
                        message: "无法启动登录线程".into(),
                        qr_image: String::new(),
                    },
                );
                session.revision += 1;
                Ok(())
            })?;
        }
    }
    with_app(|app| app.native_snapshot(true))
}

pub(super) fn logout(context: &HostContext, identity: &Identity) -> Result<Value, ApiError> {
    with_app(|app| {
        app.native_authorize(identity, true)?;
        save(&context.directory, "")?;
        let session = app.native();
        session.login_generation = None;
        session.login.reset_bilibili_login();
        session.cookie.clear();
        session.revision += 1;
        app.native_snapshot(true)
    })
}

fn get_json(
    client: &reqwest::blocking::Client,
    url: &str,
    diagnostic: &mut LoginDiagnostic,
) -> Result<Value, ApiError> {
    let response = client.get(url).send().map_err(|error| {
        transport_error(error, diagnostic);
        ApiError::new(502, "login_network", "B 站登录请求失败，请检查网络后重试")
    })?;
    diagnostic.http_status = Some(response.status().as_u16());
    if !response.status().is_success() {
        return Err(ApiError::new(
            502,
            "login_http",
            format!("B 站登录返回 HTTP {}", response.status().as_u16()),
        ));
    }
    let mut bytes = Vec::new();
    response
        .take(128 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ApiError::new(502, "login_body", "B 站登录响应读取失败"))?;
    if bytes.len() > 128 * 1024 {
        return Err(ApiError::new(502, "login_body", "B 站登录响应过大"));
    }
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| ApiError::new(502, "login_json", "B 站登录响应格式错误"))?;
    diagnostic.api_code = value["code"].as_i64();
    if diagnostic.stage == "poll" {
        diagnostic.poll_code = value["data"]["code"].as_i64();
    }
    if value["code"] != 0 {
        return Err(ApiError::new(
            502,
            "login_api",
            "B 站暂时无法完成登录，请稍后重试",
        ));
    }
    Ok(value)
}

fn error_result(error: &ApiError) -> &'static str {
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
) -> (Result<Value, ApiError>, LoginDiagnostic) {
    let started = Instant::now();
    let mut diagnostic = LoginDiagnostic::new(generation, stage);
    let result = get_json(client, url, &mut diagnostic);
    diagnostic.elapsed_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
    if let Err(error) = &result {
        diagnostic.result = error_result(error);
    }
    (result, diagnostic)
}

fn request_json(
    client: &reqwest::blocking::Client,
    url: &str,
    generation: u64,
    stage: &'static str,
) -> Result<Value, ApiError> {
    let (result, diagnostic) = observe_json(client, url, generation, stage);
    record(diagnostic);
    result
}

fn active(context: &HostContext, generation: u64) -> bool {
    !context.stop.load(Ordering::Acquire)
        && with_app(|app| Ok(app.native().login_generation == Some(generation))).unwrap_or(false)
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

fn run(context: &HostContext, generation: u64) -> Result<(), ApiError> {
    let jar = Arc::new(Jar::default());
    let client = crate::http_client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .user_agent(crate::native_video::USER_AGENT)
        .cookie_provider(jar.clone())
        .build()
        .map_err(|_| ApiError::new(502, "login_client", "无法初始化 B 站安全连接"))?;
    let generated = request_json(&client, GENERATE, generation, "generate")?;
    let qr = generated["data"]["url"]
        .as_str()
        .filter(|value| value.len() <= 4096)
        .ok_or_else(|| ApiError::new(502, "login_qr", "B 站未返回登录二维码"))?;
    // Bilibili's current API uses account.bilibili.com; older responses use
    // passport.bilibili.com. Both remain exact HTTPS origins, never arbitrary URLs.
    if !valid_qr_url(qr) {
        return Err(ApiError::new(502, "login_qr", "B 站二维码地址无效"));
    }
    let key = generated["data"]["qrcode_key"]
        .as_str()
        .filter(|value| !value.is_empty() && value.len() <= 256)
        .ok_or_else(|| ApiError::new(502, "login_qr", "B 站二维码标识缺失"))?;
    let image = qr_image(qr)?;
    update_waiting(
        context,
        generation,
        &image,
        "请使用哔哩哔哩 App 扫码，或截图后从扫一扫相册中选择",
    )?;
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("qrcode_key", key)
        .append_pair("source", "main-fe-header")
        .finish();
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(180) && active(context, generation) {
        thread::sleep(Duration::from_secs(2));
        if !active(context, generation) {
            return Ok(());
        }
        let polled = request_json(&client, &format!("{POLL}?{query}"), generation, "poll")?;
        match polled["data"]["code"].as_i64() {
            Some(86101) => {}
            Some(86090) => update_waiting(
                context,
                generation,
                &image,
                "扫码成功，请在哔哩哔哩 App 中确认",
            )?,
            Some(86038) => break,
            Some(0) => {
                let scope = url::Url::parse("https://api.bilibili.com/").expect("cookie scope");
                let cookie = jar
                    .cookies(&scope)
                    .and_then(|header| header.to_str().ok().and_then(canonical_cookie))
                    .ok_or_else(|| {
                        ApiError::new(502, "login_cookie", "B 站登录响应缺少有效凭证，请重新扫码")
                    })?;
                return finish(context, generation, Ok(cookie));
            }
            _ => {
                return Err(ApiError::new(
                    502,
                    "login_code",
                    "B 站登录返回未知状态，请重新扫码",
                ));
            }
        }
    }
    if active(context, generation) {
        return Err(ApiError::new(
            408,
            "login_expired",
            "二维码已过期，请重新生成",
        ));
    }
    Ok(())
}

fn update_waiting(
    context: &HostContext,
    generation: u64,
    image: &str,
    message: &str,
) -> Result<(), ApiError> {
    if !active(context, generation) {
        return Ok(());
    }
    with_app(|app| {
        let session = app.native();
        if session.login_generation == Some(generation) {
            session.login.set_bilibili_login(
                Some(generation),
                BilibiliLoginUpdate {
                    state: BilibiliLoginStatus::Waiting,
                    message: message.into(),
                    qr_image: image.into(),
                },
            );
            session.revision += 1;
        }
        Ok(())
    })
}

fn finish(
    context: &HostContext,
    generation: u64,
    result: Result<String, ApiError>,
) -> Result<(), ApiError> {
    with_app(|app| {
        let session = app.native();
        if context.stop.load(Ordering::Acquire) || session.login_generation != Some(generation) {
            return Ok(());
        }
        let result = result.and_then(|cookie| {
            save(&context.directory, &cookie)?;
            Ok(cookie)
        });
        let mut diagnostic = LoginDiagnostic::new(generation, "finish");
        if let Err(error) = &result {
            diagnostic.result = error_result(error);
        }
        let update = match result {
            Ok(cookie) => {
                session.cookie = cookie;
                BilibiliLoginUpdate {
                    state: BilibiliLoginStatus::LoggedIn,
                    message: "Bilibili 已登录".into(),
                    qr_image: String::new(),
                }
            }
            Err(error) => BilibiliLoginUpdate {
                state: BilibiliLoginStatus::Failed,
                message: error.message,
                qr_image: String::new(),
            },
        };
        session.login.set_bilibili_login(Some(generation), update);
        session.login_generation = None;
        session.revision += 1;
        app.native_login_diagnostic(diagnostic);
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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
    #[test]
    fn private_cookie_checkpoint_roundtrip_and_invalid_file_preservation() {
        let path = std::env::temp_dir().join(format!("bilikara-native-login-{}", token().unwrap()));
        fs::create_dir(&path).unwrap();
        assert_eq!(load(&path).unwrap(), "");
        let cookie = canonical_cookie("SESSDATA=a; bili_jct=b").unwrap();
        save(&path, &cookie).unwrap();
        assert_eq!(load(&path).unwrap(), cookie);
        save(&path, "").unwrap();
        assert_eq!(load(&path).unwrap(), "");
        let bad = b"incomplete";
        fs::write(path.join(COOKIE_FILE), bad).unwrap();
        assert!(load(&path).is_err());
        assert_eq!(fs::read(path.join(COOKIE_FILE)).unwrap(), bad);
        fs::remove_dir_all(path).unwrap();
    }
}
