//! Opt-in native Host transport. Desktop's Python adapter does not start this
//! listener. HTTP is a projection/command adapter to the process-wide AppState.
mod api;
mod cache;
mod diagnostics;
mod files;
mod login;
mod maintenance;
mod network;

use crate::app_state::native_session::{Identity, with_app};
use axum::{
    Router,
    body::{Body, to_bytes},
    extract::{ConnectInfo, State},
    http::{HeaderMap, Method, Request, StatusCode},
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use std::{
    net::{IpAddr, SocketAddr, TcpListener},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{io::AsyncWriteExt, sync::Semaphore};

pub struct Asset {
    pub bytes: Vec<u8>,
    pub mime: String,
}
pub type AssetSource = Arc<dyn Fn(&str) -> Option<Asset> + Send + Sync>;

#[derive(Debug)]
pub(crate) struct ApiError {
    pub status: u16,
    pub code: String,
    pub message: String,
    pub extra: Value,
}
impl ApiError {
    pub(crate) fn new(status: u16, code: &str, message: impl Into<String>) -> Self {
        Self {
            status,
            code: code.into(),
            message: message.into(),
            extra: json!({}),
        }
    }
    pub(crate) fn invalid(message: impl Into<String>) -> Self {
        Self::new(400, "invalid_request", message)
    }
    fn response(self) -> Response {
        let mut value = self.extra;
        if !value.is_object() {
            value = json!({});
        }
        value["ok"] = json!(false);
        value["error"] = json!(self.message);
        value["code"] = json!(self.code);
        json_response(self.status, value)
    }
}
impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

pub(crate) struct HostContext {
    directory: PathBuf,
    cache_root: PathBuf,
    assets: AssetSource,
    stop: Arc<AtomicBool>,
    api_slots: Arc<Semaphore>,
    event_slots: Arc<Semaphore>,
    port: u16,
}

/// Dropping the handle stops the server and native cache pump. Keep it managed
/// by the platform shell for the complete foreground Host lifetime.
pub struct NativeHost {
    bootstrap_url: String,
    context: Arc<HostContext>,
}
impl NativeHost {
    pub fn start(directory: &Path, assets: AssetSource) -> Result<Self, String> {
        start(directory, assets).map_err(|error| error.to_string())
    }
    pub fn bootstrap_url(&self) -> &str {
        &self.bootstrap_url
    }
    pub fn local_port(&self) -> u16 {
        self.context.port
    }
}
impl Drop for NativeHost {
    fn drop(&mut self) {
        self.context.stop.store(true, Ordering::Release);
    }
}

pub(crate) fn now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|v| v.as_secs_f64())
        .unwrap_or(0.0)
}
pub(crate) fn token() -> Result<String, ApiError> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|_| ApiError::new(503, "entropy", "设备无法生成安全的访问凭证"))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}
pub(crate) fn qr_image(value: &str) -> Result<String, ApiError> {
    let code = qrcode::QrCode::new(value).map_err(|_| ApiError::invalid("无法生成二维码"))?;
    let svg = code
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(256, 256)
        .build();
    Ok(format!(
        "data:image/svg+xml;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(svg)
    ))
}

fn start(directory: &Path, assets: AssetSource) -> Result<NativeHost, ApiError> {
    let directory = directory
        .canonicalize()
        .map_err(|_| ApiError::new(503, "storage", "Host 私有目录不可用"))?;
    let cache_root = directory.join("media");
    std::fs::create_dir_all(&cache_root)
        .map_err(|_| ApiError::new(503, "storage", "无法创建媒体缓存目录"))?;
    std::fs::create_dir_all(directory.join("logs"))
        .map_err(|_| ApiError::new(503, "storage", "无法创建诊断目录"))?;
    // No cache worker/listener exists yet. Old staging files cannot belong to a
    // live attempt after the validated restart reset.
    maintenance::collect(&cache_root, true)
        .map_err(|_| ApiError::new(503, "cache_storage", "无法清理旧媒体缓存"))?;
    let listener = TcpListener::bind((std::net::Ipv4Addr::UNSPECIFIED, 0))
        .map_err(|_| ApiError::new(503, "listen", "无法开启本地 Host 服务"))?;
    listener
        .set_nonblocking(true)
        .map_err(|_| ApiError::new(503, "listen", "无法配置 Host 服务"))?;
    let port = listener
        .local_addr()
        .map_err(|_| ApiError::invalid("无法确定 Host 端口"))?
        .port();
    let host_token = token()?;
    let invite = token()?;
    let lan_urls: Vec<String> = network::lan_addresses()
        .into_iter()
        .map(|ip| format!("http://{ip}:{port}/remote?invite={invite}"))
        .collect();
    let local = format!("http://127.0.0.1:{port}/remote?invite={invite}");
    let preferred = lan_urls.first().unwrap_or(&local).clone();
    let qr = qr_image(&preferred)?;
    let saved_cookie = login::load(&directory)?;
    with_app(|app| {
        app.native_core_snapshot()?;
        if !app.native().host_token.is_empty() {
            return Err(ApiError::new(
                409,
                "already_started",
                "原生 Host 服务已启动",
            ));
        }
        let session = app.native();
        session.host_token = host_token.clone();
        session.invite = invite;
        session.cookie = saved_cookie;
        session.remote_access =
            json!({"local_url":local,"preferred_url":preferred,"lan_urls":lan_urls,"qr_image":qr});
        Ok(())
    })?;
    let context = Arc::new(HostContext {
        directory,
        cache_root,
        assets,
        stop: Arc::new(AtomicBool::new(false)),
        api_slots: Arc::new(Semaphore::new(32)),
        event_slots: Arc::new(Semaphore::new(12)),
        port,
    });
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .max_blocking_threads(8)
        .enable_all()
        .build()
        .map_err(|_| ApiError::new(503, "runtime", "无法启动 Host 网络运行时"))?;
    let worker_context = context.clone();
    thread::Builder::new()
        .name("native-host-http".into())
        .spawn(move || {
            runtime.block_on(async move {
                let listener = match tokio::net::TcpListener::from_std(listener) {
                    Ok(value) => value,
                    Err(_) => return,
                };
                let stop = worker_context.stop.clone();
                let router = Router::new().fallback(handle).with_state(worker_context);
                let server = axum::serve(
                    listener,
                    router.into_make_service_with_connect_info::<SocketAddr>(),
                );
                let _ = server
                    .with_graceful_shutdown(async move {
                        while !stop.load(Ordering::Acquire) {
                            tokio::time::sleep(Duration::from_millis(200)).await;
                        }
                    })
                    .await;
            })
        })
        .map_err(|_| ApiError::new(503, "runtime", "无法创建 Host 服务线程"))?;
    cache::start_pump(context.clone())?;
    Ok(NativeHost {
        bootstrap_url: format!("http://127.0.0.1:{port}/bootstrap/{host_token}"),
        context,
    })
}

fn json_response(status: u16, value: Value) -> Response {
    (
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        axum::Json(value),
    )
        .into_response()
}
fn cookie(headers: &HeaderMap) -> String {
    headers
        .get("cookie")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .find_map(|entry| entry.trim().strip_prefix("bilikara_native="))
        .unwrap_or("")
        .to_owned()
}

fn validate_origin(headers: &HeaderMap, port: u16) -> Result<(), ApiError> {
    let host = headers
        .get("host")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| ApiError::invalid("缺少 Host"))?;
    let address: SocketAddr = host
        .parse()
        .map_err(|_| ApiError::new(403, "host", "只接受设备的本地 IP 地址"))?;
    if address.port() != port
        || !match address.ip() {
            IpAddr::V4(ip) => ip.is_loopback() || ip.is_private(),
            _ => false,
        }
    {
        return Err(ApiError::new(403, "host", "无效的 Host 地址"));
    }
    if let Some(origin) = headers.get("origin")
        && origin.to_str().ok() != Some(&format!("http://{host}"))
    {
        return Err(ApiError::new(403, "origin", "不接受跨站请求"));
    }
    if headers.get("sec-fetch-site").and_then(|v| v.to_str().ok()) == Some("cross-site") {
        return Err(ApiError::new(403, "origin", "不接受跨站请求"));
    }
    Ok(())
}

async fn handle(
    State(context): State<Arc<HostContext>>,
    ConnectInfo(address): ConnectInfo<SocketAddr>,
    request: Request<Body>,
) -> Response {
    let response = match handle_inner(context, address, request).await {
        Ok(value) => value,
        Err(error) => error.response(),
    };
    let mut response = response;
    let headers = response.headers_mut();
    headers.insert("cache-control", "no-store".parse().unwrap());
    headers.insert("referrer-policy", "no-referrer".parse().unwrap());
    headers.insert("x-content-type-options", "nosniff".parse().unwrap());
    headers.insert("x-frame-options", "DENY".parse().unwrap());
    response
}

async fn handle_inner(
    context: Arc<HostContext>,
    address: SocketAddr,
    request: Request<Body>,
) -> Result<Response, ApiError> {
    validate_origin(request.headers(), context.port)?;
    let method = request.method().clone();
    if !matches!(method, Method::GET | Method::HEAD | Method::POST) {
        return Err(ApiError::new(405, "method", "不支持此请求方式"));
    }
    let path = request.uri().path().to_owned();
    let query = request.uri().query().unwrap_or("").to_owned();
    let identity = Identity {
        token: cookie(request.headers()),
        loopback: address.ip().is_loopback(),
        client: request
            .headers()
            .get("x-bilikara-client")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_owned(),
    };
    if method == Method::GET && path.starts_with("/bootstrap/") {
        let secret = path.trim_start_matches("/bootstrap/");
        with_app(|app| {
            app.native_authorize(
                &Identity {
                    token: secret.to_owned(),
                    loopback: identity.loopback,
                    client: String::new(),
                },
                true,
            )
        })?;
        return Ok(redirect_cookie("/", secret));
    }
    if method == Method::GET
        && matches!(path.as_str(), "/remote" | "/remote.html")
        && let Some((_, invite)) =
            url::form_urlencoded::parse(query.as_bytes()).find(|(key, _)| key == "invite")
    {
        let device_token = with_app(|app| app.native_redeem(&invite, &identity.token, token()?))?;
        return Ok(redirect_cookie("/remote", &device_token));
    }
    if path == "/api/health" && method == Method::GET && identity.loopback {
        return Ok(json_response(
            200,
            json!({"ok":true,"status":"ready","backend":"rust"}),
        ));
    }
    let host = with_app(|app| app.native_authorize(&identity, false))?;
    if path == "/api/events" && method == Method::GET {
        return event_stream(context, identity, host).await;
    }
    if path.starts_with("/media/") && matches!(method, Method::GET | Method::HEAD) {
        if !host {
            return Err(ApiError::new(403, "host_only", "媒体只供 Host 播放"));
        }
        return files::media(&context, &path, request.headers(), method == Method::HEAD).await;
    }
    if !path.starts_with("/api/") && matches!(method, Method::GET | Method::HEAD) {
        if matches!(path.as_str(), "/" | "/index.html") && !host {
            return Err(ApiError::new(403, "host_only", "请使用手机点歌页面"));
        }
        return files::asset(&context, &path, method == Method::HEAD);
    }
    let permit = context
        .api_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError::new(429, "busy", "Host 请求较多，请稍后重试"))?;
    let body = if method == Method::POST {
        if !request
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .starts_with("application/json")
        {
            return Err(ApiError::new(415, "content_type", "仅支持 JSON 请求"));
        }
        let bytes = tokio::time::timeout(
            Duration::from_secs(5),
            to_bytes(request.into_body(), 64 * 1024),
        )
        .await
        .map_err(|_| ApiError::new(408, "timeout", "请求接收超时"))?
        .map_err(|_| ApiError::new(413, "body_too_large", "请求过大"))?;
        serde_json::from_slice(&bytes).map_err(|_| ApiError::invalid("JSON 格式无效"))?
    } else {
        json!({})
    };
    let result = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        api::dispatch(&context, &identity, host, &method, &path, &query, body)
    })
    .await
    .map_err(|_| ApiError::new(500, "task", "原生请求处理失败"))??;
    Ok(json_response(200, json!({"ok":true,"data":result})))
}

fn redirect_cookie(location: &str, token: &str) -> Response {
    let mut response = (StatusCode::SEE_OTHER, [("location", location)]).into_response();
    response.headers_mut().insert(
        "set-cookie",
        format!("bilikara_native={token}; Path=/; HttpOnly; SameSite=Strict")
            .parse()
            .expect("random token header"),
    );
    response
}

async fn event_stream(
    context: Arc<HostContext>,
    identity: Identity,
    host: bool,
) -> Result<Response, ApiError> {
    let permit = context
        .event_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError::new(429, "events_busy", "连接数量已达上限"))?;
    let (reader, mut writer) = tokio::io::duplex(64 * 1024);
    tokio::spawn(async move {
        let _permit = permit;
        let mut last_revision = None;
        while !context.stop.load(Ordering::Acquire) {
            let identity = identity.clone();
            let value = tokio::task::spawn_blocking(move || {
                with_app(|app| {
                    app.native_authorize(&identity, false)?;
                    app.native_snapshot(host)
                })
            })
            .await;
            let Ok(Ok(value)) = value else { break };
            let revision = value["state_revision"].as_u64();
            let frame = if revision == last_revision {
                ": keepalive\n\n".into()
            } else {
                last_revision = revision;
                format!("event: state\ndata: {value}\n\n")
            };
            if !matches!(
                tokio::time::timeout(Duration::from_secs(5), writer.write_all(frame.as_bytes()))
                    .await,
                Ok(Ok(()))
            ) {
                break;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    });
    Ok((
        [("content-type", "text/event-stream")],
        Body::from_stream(tokio_util::io::ReaderStream::new(reader)),
    )
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_dns_rebinding_and_foreign_origins() {
        let mut headers = HeaderMap::new();
        headers.insert("host", "127.0.0.1:4567".parse().unwrap());
        assert!(validate_origin(&headers, 4567).is_ok());
        headers.insert("origin", "https://evil.test".parse().unwrap());
        assert!(validate_origin(&headers, 4567).is_err());
        headers.remove("origin");
        headers.insert("host", "evil.test:4567".parse().unwrap());
        assert!(validate_origin(&headers, 4567).is_err());
        headers.insert("host", "127.0.0.1:9999".parse().unwrap());
        assert!(validate_origin(&headers, 4567).is_err());
    }
    #[test]
    fn invitation_qr_is_local_not_an_external_service() {
        let image = qr_image("http://192.168.1.2:1234/remote?invite=test").unwrap();
        assert!(image.starts_with("data:image/svg+xml;base64,"));
    }
}
