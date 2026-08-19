#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::fs::{self, OpenOptions};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;

#[cfg(target_os = "macos")]
use objc2::{MainThreadMarker, rc::Retained};
#[cfg(target_os = "macos")]
use objc2_web_kit::{WKAudiovisualMediaTypes, WKWebViewConfiguration};
#[cfg(target_os = "macos")]
use tauri_plugin_dialog::MessageDialogKind;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const MAX_BACKEND_DOWNLOAD_BYTES: usize = 512 * 1024 * 1024;
const MAX_BACKEND_RESPONSE_BYTES: u64 = (MAX_BACKEND_DOWNLOAD_BYTES + 64 * 1024) as u64;
const MAX_BACKEND_OUTPUT_CHARS: usize = 2_048;
const MAX_BACKEND_TAIL_LINES: usize = 40;
const MAX_DESKTOP_STARTUP_LOG_BYTES: u64 = 512 * 1024;
const BACKEND_READY_TIMEOUT: Duration = Duration::from_secs(90);
const ACTIVE_BACKEND_DOWNLOAD_SHUTDOWN_GRACE: Duration = Duration::from_secs(10);
const DESKTOP_STARTUP_LOG_NAME: &str = "desktop-startup.log";

#[derive(Debug, PartialEq, Eq)]
struct BackendCommandResolution {
    command: String,
    args: Vec<String>,
    candidate_type: &'static str,
}

#[derive(Debug, PartialEq, Eq)]
struct PackagedBackendMissing {
    command_path: PathBuf,
    candidate_type: &'static str,
    candidate_exists: bool,
    candidate_executable: bool,
}

#[derive(Debug, Default)]
struct BoundedOutputTail {
    lines: VecDeque<String>,
}

impl BoundedOutputTail {
    fn push(&mut self, line: String) {
        if self.lines.len() == MAX_BACKEND_TAIL_LINES {
            self.lines.pop_front();
        }
        self.lines.push_back(line);
    }

    fn snapshot(&self) -> Vec<String> {
        self.lines.iter().cloned().collect()
    }
}

#[derive(Clone, Debug)]
struct DesktopStartupLog {
    path: PathBuf,
    write_lock: Arc<Mutex<()>>,
}

impl DesktopStartupLog {
    fn open(path: PathBuf) -> io::Result<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        if path
            .metadata()
            .map(|metadata| metadata.len() > MAX_DESKTOP_STARTUP_LOG_BYTES)
            .unwrap_or(false)
        {
            OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .open(&path)?;
        }
        Ok(Self {
            path,
            write_lock: Arc::new(Mutex::new(())),
        })
    }

    fn append(&self, event: &str, detail: impl AsRef<str>) {
        let Ok(_guard) = self.write_lock.lock() else {
            eprintln!("Desktop startup log lock is unavailable");
            return;
        };
        let result = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .and_then(|mut file| {
                writeln!(
                    file,
                    "[unix_ms={}] event={} {}",
                    unix_timestamp_millis(),
                    event,
                    sanitized_backend_stdout_line(detail.as_ref())
                )
            });
        if let Err(error) = result {
            eprintln!("Failed to write desktop startup log: {error}");
        }
    }
}

#[cfg(target_os = "windows")]
use windows_sys::Win32::Devices::Display::{
    DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME, DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME,
    DISPLAYCONFIG_MODE_INFO, DISPLAYCONFIG_PATH_INFO, DISPLAYCONFIG_SOURCE_DEVICE_NAME,
    DISPLAYCONFIG_TARGET_DEVICE_NAME, DisplayConfigGetDeviceInfo, GetDisplayConfigBufferSizes,
    QDC_ONLY_ACTIVE_PATHS, QueryDisplayConfig,
};

#[derive(Clone, Debug, Default, Eq, PartialEq)]
struct StageSession {
    active: bool,
    display_id: Option<String>,
}

#[derive(Default)]
struct StageSessionState(Mutex<StageSession>);

#[derive(Clone, Deserialize, Debug, PartialEq, Eq)]
struct ReadyEvent {
    event: String,
    #[allow(dead_code)]
    host: String,
    #[allow(dead_code)]
    port: u16,
    #[serde(rename = "baseUrl")]
    base_url: String,
}

struct BackendProcess {
    child: Arc<Mutex<Option<Child>>>,
    base_url: Arc<Mutex<Option<String>>>,
    shutdown_token: String,
    active_downloads: Arc<AtomicUsize>,
}

struct ActiveBackendDownloadGuard {
    active_downloads: Arc<AtomicUsize>,
}

impl ActiveBackendDownloadGuard {
    fn acquire(active_downloads: Arc<AtomicUsize>) -> Self {
        active_downloads.fetch_add(1, Ordering::AcqRel);
        Self { active_downloads }
    }
}

impl Drop for ActiveBackendDownloadGuard {
    fn drop(&mut self) {
        self.active_downloads.fetch_sub(1, Ordering::AcqRel);
    }
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct SaveBackendDownloadRequest {
    path: String,
    body: Option<String>,
    client_id: Option<String>,
}

#[derive(Debug)]
struct BackendDownloadResponse {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

#[derive(Debug, PartialEq, Eq)]
struct ValidatedBackendDownloadResponse {
    filename: String,
    required_extension: &'static str,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BackendDownloadKind {
    PlaylistCsv,
    PlaylistImage,
    Diagnostics,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ValidatedBackendDownloadRequest {
    method: &'static str,
    path: String,
    body: String,
    client_id: Option<String>,
    default_filename: &'static str,
    kind: BackendDownloadKind,
    format: String,
    source: Option<String>,
    page_size: Option<u32>,
}

#[derive(Debug, PartialEq, Eq)]
struct BackendAddress {
    connect_host: String,
    host_header: String,
    port: u16,
}

#[derive(Debug, PartialEq, Eq)]
enum BackendStdoutLine {
    Ready(ReadyEvent),
    Output(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum SaveBackendDownloadStatus {
    Saved,
    Cancelled,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct StageTiming {
    stage: String,
    elapsed_ms: u64,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveBackendDownloadResult {
    status: SaveBackendDownloadStatus,
    stage: String,
    format: Option<String>,
    source: Option<String>,
    page_size: Option<u32>,
    http_status: Option<u16>,
    content_type: Option<String>,
    bytes: Option<usize>,
    filename_extension: Option<String>,
    elapsed_ms: u64,
    stage_timings: Vec<StageTiming>,
    error_code: Option<String>,
    error_message: Option<String>,
}

fn resolve_backend_command() -> Result<BackendCommandResolution, PackagedBackendMissing> {
    let current_exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("."));
    let current_exe = current_exe.canonicalize().unwrap_or(current_exe);
    let current_dir = current_exe
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."));
    let packaged_macos = cfg!(target_os = "macos") && is_macos_app_bundle_executable(&current_exe);
    resolve_backend_command_from(&current_exe, current_dir, packaged_macos)
}

fn resolve_backend_command_from(
    current_exe: &Path,
    current_dir: &Path,
    packaged_macos: bool,
) -> Result<BackendCommandResolution, PackagedBackendMissing> {
    if packaged_macos {
        let embedded_backend = embedded_macos_backend_path(current_exe).unwrap_or_else(|| {
            current_dir
                .join("..")
                .join("Frameworks")
                .join("bilikara-backend.app")
                .join("Contents")
                .join("MacOS")
                .join("bilikara")
        });
        if is_backend_candidate(&embedded_backend, current_exe) {
            return Ok(BackendCommandResolution {
                command: embedded_backend.to_string_lossy().to_string(),
                args: vec![],
                candidate_type: "macos-embedded-backend",
            });
        }
        return Err(PackagedBackendMissing {
            candidate_exists: embedded_backend.is_file(),
            candidate_executable: path_has_executable_bit(&embedded_backend),
            command_path: embedded_backend,
            candidate_type: "macos-embedded-backend",
        });
    }

    // Windows packaged path
    let win_path = current_dir.join("bilikara").join("bilikara.exe");
    if is_backend_candidate(&win_path, current_exe) {
        return Ok(BackendCommandResolution {
            command: win_path.to_string_lossy().to_string(),
            args: vec![],
            candidate_type: "windows-bundle-directory",
        });
    }

    let win_path2 = current_dir.join("bilikara.exe");
    if is_backend_candidate(&win_path2, current_exe) {
        return Ok(BackendCommandResolution {
            command: win_path2.to_string_lossy().to_string(),
            args: vec![],
            candidate_type: "windows-adjacent",
        });
    }

    // macOS packaged paths (dedicated backend candidate preferred over standalone app)
    let mac_dedicated = current_dir
        .join("bilikara-backend")
        .join("bilikara-backend");
    if is_backend_candidate(&mac_dedicated, current_exe) {
        return Ok(BackendCommandResolution {
            command: mac_dedicated.to_string_lossy().to_string(),
            args: vec![],
            candidate_type: "macos-dedicated-backend",
        });
    }

    let mac_path = current_dir
        .join("bilikara.app")
        .join("Contents")
        .join("MacOS")
        .join("bilikara");
    if is_backend_candidate(&mac_path, current_exe) {
        return Ok(BackendCommandResolution {
            command: mac_path.to_string_lossy().to_string(),
            args: vec![],
            candidate_type: "macos-sibling-app",
        });
    }

    if let Some(script_path) = find_dev_launcher(current_dir) {
        return Ok(BackendCommandResolution {
            command: "python".to_string(),
            args: vec![script_path.to_string_lossy().to_string()],
            candidate_type: "development-python-script",
        });
    }

    // Default to Python script for development
    Ok(BackendCommandResolution {
        command: "python".to_string(),
        args: vec!["start_bilikara.py".to_string()],
        candidate_type: "python-fallback",
    })
}

fn is_macos_app_bundle_executable(path: &Path) -> bool {
    let Some(mac_os_dir) = path.parent() else {
        return false;
    };
    let Some(contents_dir) = mac_os_dir.parent() else {
        return false;
    };
    let Some(app_dir) = contents_dir.parent() else {
        return false;
    };
    mac_os_dir.file_name().is_some_and(|name| name == "MacOS")
        && contents_dir
            .file_name()
            .is_some_and(|name| name == "Contents")
        && app_dir
            .extension()
            .is_some_and(|extension| extension == "app")
}

fn embedded_macos_backend_path(current_exe: &Path) -> Option<PathBuf> {
    if !is_macos_app_bundle_executable(current_exe) {
        return None;
    }
    let contents_dir = current_exe.parent()?.parent()?;
    Some(
        contents_dir
            .join("Frameworks")
            .join("bilikara-backend.app")
            .join("Contents")
            .join("MacOS")
            .join("bilikara"),
    )
}

fn find_dev_launcher(start_dir: &std::path::Path) -> Option<PathBuf> {
    let mut cursor = Some(start_dir);
    while let Some(dir) = cursor {
        let candidate = dir.join("start_bilikara.py");
        if candidate.exists() {
            return Some(candidate);
        }
        cursor = dir.parent();
    }
    None
}

fn is_backend_candidate(path: &Path, current_exe: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    let canonical_candidate = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let canonical_current_exe = current_exe
        .canonicalize()
        .unwrap_or_else(|_| current_exe.to_path_buf());
    if canonical_candidate == canonical_current_exe {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(metadata) = path.metadata() {
            if metadata.permissions().mode() & 0o111 == 0 {
                return false;
            }
        } else {
            return false;
        }
    }
    true
}

fn current_executable_string() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.canonicalize().ok().or(Some(path)))
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_default()
}

fn unix_timestamp_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn is_packaged_macos_executable(path: &Path) -> bool {
    #[cfg(target_os = "macos")]
    {
        is_macos_app_bundle_executable(path)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        false
    }
}

fn desktop_startup_log_path(current_exe: &Path) -> Option<PathBuf> {
    if let Some(override_path) = std::env::var_os("BILIKARA_DESKTOP_STARTUP_LOG")
        && !override_path.is_empty()
    {
        return Some(PathBuf::from(override_path));
    }
    if !is_packaged_macos_executable(current_exe) {
        return None;
    }
    let home = std::env::var_os("HOME")?;
    if home.is_empty() {
        return None;
    }
    Some(
        PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join("bilikara")
            .join("data")
            .join("logs")
            .join(DESKTOP_STARTUP_LOG_NAME),
    )
}

fn command_path_for_diagnostics(command: &str) -> PathBuf {
    let path = PathBuf::from(command);
    if path.is_absolute() || path.components().count() > 1 {
        return path;
    }
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|value| std::env::split_paths(&value).collect::<Vec<_>>())
        .map(|directory| directory.join(command))
        .find(|candidate| candidate.is_file())
        .unwrap_or(path)
}

fn path_has_executable_bit(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.metadata()
            .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn open_desktop_startup_log(current_exe: &Path) -> Option<DesktopStartupLog> {
    let path = desktop_startup_log_path(current_exe)?;
    match DesktopStartupLog::open(path.clone()) {
        Ok(log) => Some(log),
        Err(error) => {
            eprintln!(
                "Failed to open desktop startup log at {}: {error}",
                path.display()
            );
            None
        }
    }
}

fn install_desktop_panic_hook(startup_log: Option<&DesktopStartupLog>) {
    let Some(startup_log) = startup_log.cloned() else {
        return;
    };
    let previous_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |panic_info| {
        startup_log.append("desktop_panic", format!("message={panic_info}"));
        previous_hook(panic_info);
    }));
}

fn make_shutdown_token() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("{}-{}", std::process::id(), nanos)
}

fn normalized_url_host(host: &str) -> String {
    host.trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.')
        .to_ascii_lowercase()
}

fn parse_local_http_url(base_url: &str) -> Option<BackendAddress> {
    let url = tauri::Url::parse(base_url).ok()?;
    if url.scheme() != "http"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "" | "/")
    {
        return None;
    }
    let connect_host = normalized_url_host(url.host_str()?);
    if connect_host.is_empty() {
        return None;
    }
    let port = url.port_or_known_default()?;
    let host_header = if connect_host.contains(':') {
        format!("[{connect_host}]")
    } else {
        connect_host.clone()
    };
    Some(BackendAddress {
        connect_host,
        host_header,
        port,
    })
}

fn parsed_http_origin(url: &str) -> Option<(String, String, u16)> {
    let parsed = tauri::Url::parse(url).ok()?;
    if parsed.scheme() != "http" || !parsed.username().is_empty() || parsed.password().is_some() {
        return None;
    }
    let host = normalized_url_host(parsed.host_str()?);
    if host.is_empty() {
        return None;
    }
    Some((
        parsed.scheme().to_ascii_lowercase(),
        host,
        parsed.port_or_known_default()?,
    ))
}

fn window_origin_authorized(window_url: &str, backend_url: &str) -> bool {
    parsed_http_origin(window_url)
        .zip(parsed_http_origin(backend_url))
        .is_some_and(|(window_origin, backend_origin)| window_origin == backend_origin)
}

fn validate_backend_download_request(
    request: &SaveBackendDownloadRequest,
) -> Result<ValidatedBackendDownloadRequest, String> {
    if request.path.len() > 4096
        || request
            .path
            .chars()
            .any(|character| character.is_ascii_control() || character.is_ascii_whitespace())
    {
        return Err("导出请求路径无效".to_string());
    }
    let client_id = request
        .client_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if client_id.is_some_and(|value| {
        value.len() > 256 || value.chars().any(|character| character.is_ascii_control())
    }) {
        return Err("导出客户端标识无效".to_string());
    }

    let request_url = tauri::Url::parse(&format!("http://bilikara.invalid{}", request.path))
        .map_err(|_| "导出请求路径无效".to_string())?;
    if request_url.fragment().is_some() || request_url.host_str() != Some("bilikara.invalid") {
        return Err("导出请求路径无效".to_string());
    }

    if request_url.path() == "/api/playlist/export" && request_url.query().is_some() {
        if request.body.as_deref().is_some_and(|body| !body.is_empty()) {
            return Err("歌单导出不接受请求体".to_string());
        }
        let export_format = request_url
            .query_pairs()
            .find_map(|(name, value)| (name == "format").then(|| value.into_owned()))
            .unwrap_or_else(|| "csv".to_string());
        let export_source = request_url
            .query_pairs()
            .find_map(|(name, value)| (name == "source").then(|| value.into_owned()));
        let export_page_size = request_url.query_pairs().find_map(|(name, value)| {
            (name == "page_size")
                .then(|| value.parse::<u32>().ok())
                .flatten()
        });
        let (kind, default_filename) = match export_format.as_str() {
            "csv" => (BackendDownloadKind::PlaylistCsv, "bilikara-playlist.csv"),
            "image" => (BackendDownloadKind::PlaylistImage, "bilikara-playlist.png"),
            _ => return Err("歌单导出格式无效".to_string()),
        };
        return Ok(ValidatedBackendDownloadRequest {
            method: "GET",
            path: request.path.clone(),
            body: String::new(),
            client_id: client_id.map(str::to_string),
            default_filename,
            kind,
            format: export_format,
            source: export_source,
            page_size: export_page_size,
        });
    }
    if request_url.path() == "/api/diagnostics/package" && request_url.query().is_none() {
        let body = request.body.clone().unwrap_or_else(|| "{}".to_string());
        if body.len() > 64 * 1024 {
            return Err("诊断请求体过大".to_string());
        }
        if !serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .is_some_and(|value| value.is_object())
        {
            return Err("诊断请求体必须是 JSON 对象".to_string());
        }
        return Ok(ValidatedBackendDownloadRequest {
            method: "POST",
            path: request.path.clone(),
            body,
            client_id: client_id.map(str::to_string),
            default_filename: "bilikara-diagnostics.zip",
            kind: BackendDownloadKind::Diagnostics,
            format: "zip".to_string(),
            source: Some("diagnostics".to_string()),
            page_size: None,
        });
    }
    Err("不允许保存该后端端点".to_string())
}

fn parse_backend_download_response(raw: Vec<u8>) -> Result<BackendDownloadResponse, String> {
    let header_end = raw
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| "后端返回了无效的 HTTP 响应".to_string())?;
    let header_text = std::str::from_utf8(&raw[..header_end])
        .map_err(|_| "后端返回了无效的 HTTP 响应头".to_string())?;
    if header_end > 64 * 1024 {
        return Err("后端返回了过大的 HTTP 响应头".to_string());
    }
    let mut lines = header_text.split("\r\n");
    let mut status_parts = lines
        .next()
        .ok_or_else(|| "后端返回了无效的 HTTP 状态".to_string())?
        .split_whitespace();
    let version = status_parts.next().unwrap_or_default();
    if !matches!(version, "HTTP/1.0" | "HTTP/1.1") {
        return Err("后端返回了不支持的 HTTP 版本".to_string());
    }
    let status = status_parts
        .next()
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|value| (100..=599).contains(value))
        .ok_or_else(|| "后端返回了无效的 HTTP 状态".to_string())?;
    let mut headers = Vec::new();
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            return Err("后端返回了无效的 HTTP 响应头".to_string());
        };
        headers.push((name.trim().to_ascii_lowercase(), value.trim().to_string()));
    }
    let body = raw[(header_end + 4)..].to_vec();
    if let Some((_, value)) = headers.iter().find(|(name, _)| name == "content-length") {
        let expected_length = value
            .parse::<usize>()
            .map_err(|_| "后端返回了无效的 Content-Length".to_string())?;
        if body.len() != expected_length {
            return Err(format!(
                "导出文件接收不完整：预期 {expected_length} 字节，实际 {} 字节",
                body.len()
            ));
        }
    }
    Ok(BackendDownloadResponse {
        status,
        headers,
        body,
    })
}

fn backend_response_header<'a>(
    response: &'a BackendDownloadResponse,
    name: &str,
) -> Option<&'a str> {
    response
        .headers
        .iter()
        .find(|(header_name, _)| header_name.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}

fn backend_error_message(response: &BackendDownloadResponse) -> String {
    serde_json::from_slice::<serde_json::Value>(&response.body)
        .ok()
        .and_then(|payload| {
            payload
                .get("error")
                .and_then(|value| value.as_str())
                .map(str::to_string)
        })
        .filter(|message| !message.trim().is_empty())
        .unwrap_or_else(|| format!("导出请求失败（HTTP {}）", response.status))
}

fn safe_download_filename(value: &str, fallback: &str) -> String {
    let filename = value
        .split(';')
        .find_map(|part| {
            let (name, value) = part.trim().split_once('=')?;
            name.eq_ignore_ascii_case("filename")
                .then(|| value.trim().trim_matches('"'))
        })
        .unwrap_or(fallback);
    let safe = filename
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();
    let safe = safe.trim_matches(|character| matches!(character, '-' | '.'));
    if safe.is_empty() {
        fallback.to_string()
    } else {
        safe.to_string()
    }
}

fn build_backend_http_request(
    address: &BackendAddress,
    request: &ValidatedBackendDownloadRequest,
) -> Vec<u8> {
    let mut request_bytes = format!(
        "{} {} HTTP/1.1\r\nHost: {}:{}\r\nConnection: close\r\n",
        request.method, request.path, address.host_header, address.port
    )
    .into_bytes();
    if let Some(client_id) = request.client_id.as_deref() {
        request_bytes.extend_from_slice(format!("X-Bilikara-Client: {client_id}\r\n").as_bytes());
    }
    if request.method == "POST" {
        request_bytes.extend_from_slice(b"Content-Type: application/json\r\n");
    }
    request_bytes
        .extend_from_slice(format!("Content-Length: {}\r\n\r\n", request.body.len()).as_bytes());
    request_bytes.extend_from_slice(request.body.as_bytes());
    request_bytes
}

fn request_backend_download(
    base_url: &str,
    request: &ValidatedBackendDownloadRequest,
) -> Result<Vec<u8>, String> {
    let Some(address) = parse_local_http_url(base_url) else {
        return Err("本机后端地址无效".to_string());
    };
    eprintln!(
        "[tauri-export] transport=resolve host={} port={}",
        address.connect_host, address.port
    );
    let mut stream = TcpStream::connect((address.connect_host.as_str(), address.port))
        .map_err(|error| format!("无法连接本机后端：{error}"))?;
    eprintln!("[tauri-export] transport=connect status=ok");
    stream
        .set_write_timeout(Some(Duration::from_secs(10)))
        .map_err(|error| format!("无法设置导出写入超时：{error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(180)))
        .map_err(|error| format!("无法设置导出读取超时：{error}"))?;

    let request_bytes = build_backend_http_request(&address, request);
    stream
        .write_all(&request_bytes)
        .map_err(|error| format!("发送导出请求失败：{error}"))?;
    eprintln!(
        "[tauri-export] transport=request_written method={} endpoint={}",
        request.method, request.path
    );
    let _ = stream.shutdown(Shutdown::Write);

    let mut raw_response = Vec::new();
    (&mut stream)
        .take(MAX_BACKEND_RESPONSE_BYTES + 1)
        .read_to_end(&mut raw_response)
        .map_err(|error| format!("接收导出文件失败：{error}"))?;
    if raw_response.len() as u64 > MAX_BACKEND_RESPONSE_BYTES {
        return Err("后端导出响应过大".to_string());
    }
    eprintln!(
        "[tauri-export] transport=response_received bytes={}",
        raw_response.len()
    );
    Ok(raw_response)
}

fn validate_backend_download_response(
    response: &BackendDownloadResponse,
    request: &ValidatedBackendDownloadRequest,
) -> Result<ValidatedBackendDownloadResponse, String> {
    if !(200..300).contains(&response.status) {
        return Err(backend_error_message(response));
    }
    if response.body.len() > MAX_BACKEND_DOWNLOAD_BYTES {
        return Err("后端导出文件过大".to_string());
    }
    if backend_response_header(response, "transfer-encoding")
        .is_some_and(|value| !value.eq_ignore_ascii_case("identity"))
    {
        return Err("后端返回了不支持的传输编码".to_string());
    }
    let content_type = backend_response_header(response, "content-type")
        .ok_or_else(|| "后端响应缺少 Content-Type".to_string())?;
    let media_type = content_type.split(';').next().unwrap_or_default().trim();
    let required_extension = match request.kind {
        BackendDownloadKind::PlaylistCsv if media_type.eq_ignore_ascii_case("text/csv") => "csv",
        BackendDownloadKind::PlaylistImage if media_type.eq_ignore_ascii_case("image/png") => "png",
        BackendDownloadKind::PlaylistImage
            if media_type.eq_ignore_ascii_case("application/zip") =>
        {
            "zip"
        }
        BackendDownloadKind::Diagnostics if media_type.eq_ignore_ascii_case("application/zip") => {
            "zip"
        }
        _ => {
            return Err(format!("后端返回了意外的 Content-Type：{content_type}"));
        }
    };
    let content_disposition = backend_response_header(response, "content-disposition")
        .ok_or_else(|| "后端响应缺少 Content-Disposition".to_string())?;
    if !content_disposition
        .split(';')
        .next()
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("attachment"))
    {
        return Err("后端返回了无效的 Content-Disposition".to_string());
    }
    let filename = safe_download_filename(content_disposition, request.default_filename);
    if !Path::new(&filename)
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case(required_extension))
    {
        return Err("后端文件名与 Content-Type 不一致".to_string());
    }
    Ok(ValidatedBackendDownloadResponse {
        filename,
        required_extension,
    })
}

fn final_download_target_path(selected_path: &Path, required_extension: &str) -> (PathBuf, bool) {
    if selected_path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case(required_extension))
    {
        return (selected_path.to_path_buf(), false);
    }
    (selected_path.with_extension(required_extension), true)
}

fn staged_error(stage: &str, message: impl AsRef<str>) -> String {
    let message = message.as_ref().trim();
    if message.is_empty() {
        format!("[{stage}] 导出失败")
    } else {
        format!("[{stage}] {message}")
    }
}

fn log_native_export_stage(stage: &str, endpoint: &str, detail: &str) {
    if detail.is_empty() {
        eprintln!("[tauri-export] stage={stage} endpoint={endpoint}");
    } else {
        eprintln!("[tauri-export] stage={stage} endpoint={endpoint} {detail}");
    }
}

fn write_backend_download(
    target_path: &Path,
    body: &[u8],
    allow_overwrite: bool,
) -> Result<(), String> {
    if allow_overwrite {
        return std::fs::write(target_path, body)
            .map_err(|error| staged_error("write_file", format!("写入导出文件失败：{error}")));
    }

    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target_path)
        .map_err(|error| {
            let message = if error.kind() == io::ErrorKind::AlreadyExists {
                "修正扩展名后的目标文件已存在，请重新选择保存位置".to_string()
            } else {
                format!("创建导出文件失败：{error}")
            };
            staged_error("write_file", message)
        })?;
    if let Err(error) = file.write_all(body) {
        drop(file);
        let _ = std::fs::remove_file(target_path);
        return Err(staged_error(
            "write_file",
            format!("写入导出文件失败：{error}"),
        ));
    }
    Ok(())
}

fn export_dialog_spec(response: &ValidatedBackendDownloadResponse) -> (&str, &str) {
    (&response.filename, response.required_extension)
}

#[tauri::command]
async fn save_backend_download(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, BackendProcess>,
    request: SaveBackendDownloadRequest,
) -> Result<SaveBackendDownloadResult, String> {
    let start_total = Instant::now();
    let mut stage_timings = Vec::new();

    // Stage 1: validate_request
    let t_stage = Instant::now();
    log_native_export_stage("validate_request", &request.path, "");
    let validated = match validate_backend_download_request(&request) {
        Ok(v) => {
            stage_timings.push(StageTiming {
                stage: "validate_request".to_string(),
                elapsed_ms: t_stage.elapsed().as_millis() as u64,
            });
            v
        }
        Err(error) => {
            stage_timings.push(StageTiming {
                stage: "validate_request".to_string(),
                elapsed_ms: t_stage.elapsed().as_millis() as u64,
            });
            log_native_export_stage(
                "validate_request",
                &request.path,
                &format!("status=failed error={error}"),
            );
            return Ok(SaveBackendDownloadResult {
                status: SaveBackendDownloadStatus::Failed,
                stage: "validate_request".to_string(),
                format: None,
                source: None,
                page_size: None,
                http_status: None,
                content_type: None,
                bytes: None,
                filename_extension: None,
                elapsed_ms: start_total.elapsed().as_millis() as u64,
                stage_timings,
                error_code: Some("VALIDATE_REQUEST_FAILED".to_string()),
                error_message: Some(staged_error("validate_request", error)),
            });
        }
    };

    let req_format = Some(validated.format.clone());
    let req_source = validated.source.clone();
    let req_page_size = validated.page_size;

    // Stage 2: authorize_window
    let t_stage = Instant::now();
    log_native_export_stage("authorize_window", &validated.path, "");
    let base_url = match state.base_url.lock() {
        Ok(guard) => match guard.clone() {
            Some(url) => url,
            None => {
                stage_timings.push(StageTiming {
                    stage: "authorize_window".to_string(),
                    elapsed_ms: t_stage.elapsed().as_millis() as u64,
                });
                return Ok(SaveBackendDownloadResult {
                    status: SaveBackendDownloadStatus::Failed,
                    stage: "authorize_window".to_string(),
                    format: req_format.clone(),
                    source: req_source.clone(),
                    page_size: req_page_size,
                    http_status: None,
                    content_type: None,
                    bytes: None,
                    filename_extension: None,
                    elapsed_ms: start_total.elapsed().as_millis() as u64,
                    stage_timings,
                    error_code: Some("AUTHORIZE_WINDOW_FAILED".to_string()),
                    error_message: Some(staged_error("authorize_window", "本机后端尚未就绪")),
                });
            }
        },
        Err(_) => {
            stage_timings.push(StageTiming {
                stage: "authorize_window".to_string(),
                elapsed_ms: t_stage.elapsed().as_millis() as u64,
            });
            return Ok(SaveBackendDownloadResult {
                status: SaveBackendDownloadStatus::Failed,
                stage: "authorize_window".to_string(),
                format: req_format.clone(),
                source: req_source.clone(),
                page_size: req_page_size,
                http_status: None,
                content_type: None,
                bytes: None,
                filename_extension: None,
                elapsed_ms: start_total.elapsed().as_millis() as u64,
                stage_timings,
                error_code: Some("AUTHORIZE_WINDOW_FAILED".to_string()),
                error_message: Some(staged_error("authorize_window", "无法读取本机后端地址")),
            });
        }
    };

    let window_url = match window.url() {
        Ok(url) => url,
        Err(error) => {
            stage_timings.push(StageTiming {
                stage: "authorize_window".to_string(),
                elapsed_ms: t_stage.elapsed().as_millis() as u64,
            });
            return Ok(SaveBackendDownloadResult {
                status: SaveBackendDownloadStatus::Failed,
                stage: "authorize_window".to_string(),
                format: req_format.clone(),
                source: req_source.clone(),
                page_size: req_page_size,
                http_status: None,
                content_type: None,
                bytes: None,
                filename_extension: None,
                elapsed_ms: start_total.elapsed().as_millis() as u64,
                stage_timings,
                error_code: Some("AUTHORIZE_WINDOW_FAILED".to_string()),
                error_message: Some(staged_error(
                    "authorize_window",
                    format!("无法读取当前页面地址：{error}"),
                )),
            });
        }
    };

    if !window_origin_authorized(window_url.as_str(), &base_url) {
        stage_timings.push(StageTiming {
            stage: "authorize_window".to_string(),
            elapsed_ms: t_stage.elapsed().as_millis() as u64,
        });
        log_native_export_stage(
            "authorize_window",
            &validated.path,
            "status=failed error=unauthorized",
        );
        return Ok(SaveBackendDownloadResult {
            status: SaveBackendDownloadStatus::Failed,
            stage: "authorize_window".to_string(),
            format: req_format.clone(),
            source: req_source.clone(),
            page_size: req_page_size,
            http_status: None,
            content_type: None,
            bytes: None,
            filename_extension: None,
            elapsed_ms: start_total.elapsed().as_millis() as u64,
            stage_timings,
            error_code: Some("AUTHORIZE_WINDOW_FAILED".to_string()),
            error_message: Some(staged_error("authorize_window", "当前页面无权调用本机导出")),
        });
    }

    stage_timings.push(StageTiming {
        stage: "authorize_window".to_string(),
        elapsed_ms: t_stage.elapsed().as_millis() as u64,
    });

    let endpoint = validated.path.clone();
    let worker_endpoint = endpoint.clone();
    // Acquire before scheduling the worker, then move the lease into it. This
    // keeps WindowEvent::Destroyed from shutting down Python before the export
    // request has reached its handler, even if the invoke future is cancelled.
    let active_download_guard = ActiveBackendDownloadGuard::acquire(state.active_downloads.clone());

    // Stage 3 & 4: request_backend and validate_response
    let fetch_res = tauri::async_runtime::spawn_blocking(move || {
        let _active_download_guard = active_download_guard;
        let mut worker_timings = Vec::new();
        // Stage 3: request_backend
        let t_req = Instant::now();
        log_native_export_stage("request_backend", &worker_endpoint, "");
        let raw_response = match request_backend_download(&base_url, &validated) {
            Ok(raw) => {
                worker_timings.push(StageTiming {
                    stage: "request_backend".to_string(),
                    elapsed_ms: t_req.elapsed().as_millis() as u64,
                });
                raw
            }
            Err(error) => {
                worker_timings.push(StageTiming {
                    stage: "request_backend".to_string(),
                    elapsed_ms: t_req.elapsed().as_millis() as u64,
                });
                return Err(Box::new((
                    "request_backend",
                    "REQUEST_BACKEND_FAILED",
                    staged_error("request_backend", error),
                    None,
                    None,
                    None,
                    None,
                    worker_timings,
                )));
            }
        };

        // Stage 4: validate_response
        let t_val = Instant::now();
        log_native_export_stage("validate_response", &worker_endpoint, "");
        let response = match parse_backend_download_response(raw_response) {
            Ok(resp) => resp,
            Err(error) => {
                worker_timings.push(StageTiming {
                    stage: "validate_response".to_string(),
                    elapsed_ms: t_val.elapsed().as_millis() as u64,
                });
                return Err(Box::new((
                    "validate_response",
                    "VALIDATE_RESPONSE_FAILED",
                    staged_error("validate_response", error),
                    None,
                    None,
                    None,
                    None,
                    worker_timings,
                )));
            }
        };
        let http_status = response.status;
        let content_type = backend_response_header(&response, "content-type").map(str::to_string);
        let bytes = response.body.len();

        let validated_response = match validate_backend_download_response(&response, &validated) {
            Ok(val) => {
                worker_timings.push(StageTiming {
                    stage: "validate_response".to_string(),
                    elapsed_ms: t_val.elapsed().as_millis() as u64,
                });
                val
            }
            Err(error) => {
                worker_timings.push(StageTiming {
                    stage: "validate_response".to_string(),
                    elapsed_ms: t_val.elapsed().as_millis() as u64,
                });
                return Err(Box::new((
                    "validate_response",
                    "VALIDATE_RESPONSE_FAILED",
                    staged_error("validate_response", error),
                    Some(http_status),
                    content_type,
                    Some(bytes),
                    None,
                    worker_timings,
                )));
            }
        };

        eprintln!(
            "[tauri-export] response status={} bytes={} content_type={} filename={}",
            response.status,
            response.body.len(),
            backend_response_header(&response, "content-type").unwrap_or("missing"),
            validated_response.filename
        );

        Ok((response, validated_response, worker_timings))
    })
    .await;

    let (response, validated_response, worker_timings) = match fetch_res {
        Ok(Ok(tuple)) => tuple,
        Ok(Err(error)) => {
            let (stage, code, msg, http_status, content_type, bytes, filename_ext, worker_timings) =
                *error;

            stage_timings.extend(worker_timings);
            log_native_export_stage(stage, &endpoint, &format!("status=failed error={msg}"));
            return Ok(SaveBackendDownloadResult {
                status: SaveBackendDownloadStatus::Failed,
                stage: stage.to_string(),
                format: req_format,
                source: req_source,
                page_size: req_page_size,
                http_status,
                content_type,
                bytes,
                filename_extension: filename_ext,
                elapsed_ms: start_total.elapsed().as_millis() as u64,
                stage_timings,
                error_code: Some(code.to_string()),
                error_message: Some(msg),
            });
        }
        Err(panic_err) => {
            return Ok(SaveBackendDownloadResult {
                status: SaveBackendDownloadStatus::Failed,
                stage: "request_backend".to_string(),
                format: req_format,
                source: req_source,
                page_size: req_page_size,
                http_status: None,
                content_type: None,
                bytes: None,
                filename_extension: None,
                elapsed_ms: start_total.elapsed().as_millis() as u64,
                stage_timings,
                error_code: Some("WORKER_PANIC".to_string()),
                error_message: Some(staged_error(
                    "request_backend",
                    format!("导出工作线程失败：{panic_err}"),
                )),
            });
        }
    };

    stage_timings.extend(worker_timings);

    // Stage 5: choose_destination
    let t_stage = Instant::now();
    log_native_export_stage("choose_destination", &endpoint, "");
    let (dialog_filename, filter_ext) = export_dialog_spec(&validated_response);

    let dialog = window
        .dialog()
        .file()
        .set_title("保存导出文件")
        .set_file_name(dialog_filename)
        .add_filter("导出文件", &[filter_ext]);

    let Some(file_path) = dialog.blocking_save_file() else {
        stage_timings.push(StageTiming {
            stage: "choose_destination".to_string(),
            elapsed_ms: t_stage.elapsed().as_millis() as u64,
        });
        log_native_export_stage("complete", &endpoint, "status=cancelled");
        return Ok(SaveBackendDownloadResult {
            status: SaveBackendDownloadStatus::Cancelled,
            stage: "choose_destination".to_string(),
            format: req_format,
            source: req_source,
            page_size: req_page_size,
            http_status: None,
            content_type: None,
            bytes: None,
            filename_extension: None,
            elapsed_ms: start_total.elapsed().as_millis() as u64,
            stage_timings,
            error_code: None,
            error_message: None,
        });
    };

    let target_path = match file_path.into_path() {
        Ok(path) => {
            stage_timings.push(StageTiming {
                stage: "choose_destination".to_string(),
                elapsed_ms: t_stage.elapsed().as_millis() as u64,
            });
            path
        }
        Err(error) => {
            stage_timings.push(StageTiming {
                stage: "choose_destination".to_string(),
                elapsed_ms: t_stage.elapsed().as_millis() as u64,
            });
            log_native_export_stage(
                "choose_destination",
                &endpoint,
                &format!("status=failed error={error}"),
            );
            return Ok(SaveBackendDownloadResult {
                status: SaveBackendDownloadStatus::Failed,
                stage: "choose_destination".to_string(),
                format: req_format,
                source: req_source,
                page_size: req_page_size,
                http_status: Some(response.status),
                content_type: backend_response_header(&response, "content-type")
                    .map(str::to_string),
                bytes: Some(response.body.len()),
                filename_extension: Some(validated_response.required_extension.to_string()),
                elapsed_ms: start_total.elapsed().as_millis() as u64,
                stage_timings,
                error_code: Some("CHOOSE_DESTINATION_FAILED".to_string()),
                error_message: Some(staged_error(
                    "choose_destination",
                    format!("无法使用所选保存路径：{error}"),
                )),
            });
        }
    };

    let http_status = response.status;
    let content_type = backend_response_header(&response, "content-type").map(str::to_string);
    let bytes = response.body.len();
    let ext = validated_response.required_extension.to_string();

    // Stage 6: write_file
    let t_write = Instant::now();
    log_native_export_stage("write_file", &endpoint, "");
    let (final_target_path, extension_corrected) =
        final_download_target_path(&target_path, validated_response.required_extension);

    let write_res = tauri::async_runtime::spawn_blocking(move || {
        write_backend_download(&final_target_path, &response.body, !extension_corrected)
    })
    .await;

    let write_elapsed = t_write.elapsed().as_millis() as u64;

    match write_res {
        Ok(Ok(())) => {
            stage_timings.push(StageTiming {
                stage: "write_file".to_string(),
                elapsed_ms: write_elapsed,
            });
            stage_timings.push(StageTiming {
                stage: "complete".to_string(),
                elapsed_ms: 0,
            });
            log_native_export_stage("complete", &endpoint, "status=saved");
            Ok(SaveBackendDownloadResult {
                status: SaveBackendDownloadStatus::Saved,
                stage: "complete".to_string(),
                format: req_format,
                source: req_source,
                page_size: req_page_size,
                http_status: Some(http_status),
                content_type,
                bytes: Some(bytes),
                filename_extension: Some(ext),
                elapsed_ms: start_total.elapsed().as_millis() as u64,
                stage_timings,
                error_code: None,
                error_message: None,
            })
        }
        Ok(Err(error)) => {
            stage_timings.push(StageTiming {
                stage: "write_file".to_string(),
                elapsed_ms: write_elapsed,
            });
            log_native_export_stage(
                "write_file",
                &endpoint,
                &format!("status=failed error={error}"),
            );
            Ok(SaveBackendDownloadResult {
                status: SaveBackendDownloadStatus::Failed,
                stage: "write_file".to_string(),
                format: req_format,
                source: req_source,
                page_size: req_page_size,
                http_status: Some(http_status),
                content_type,
                bytes: Some(bytes),
                filename_extension: Some(ext),
                elapsed_ms: start_total.elapsed().as_millis() as u64,
                stage_timings,
                error_code: Some("WRITE_FILE_FAILED".to_string()),
                error_message: Some(error),
            })
        }
        Err(panic_err) => {
            stage_timings.push(StageTiming {
                stage: "write_file".to_string(),
                elapsed_ms: write_elapsed,
            });
            log_native_export_stage(
                "write_file",
                &endpoint,
                &format!("status=failed panic={panic_err}"),
            );
            Ok(SaveBackendDownloadResult {
                status: SaveBackendDownloadStatus::Failed,
                stage: "write_file".to_string(),
                format: req_format,
                source: req_source,
                page_size: req_page_size,
                http_status: Some(http_status),
                content_type,
                bytes: Some(bytes),
                filename_extension: Some(ext),
                elapsed_ms: start_total.elapsed().as_millis() as u64,
                stage_timings,
                error_code: Some("WORKER_PANIC".to_string()),
                error_message: Some(staged_error(
                    "write_file",
                    format!("写入工作线程失败：{panic_err}"),
                )),
            })
        }
    }
}

#[tauri::command]
fn set_window_fullscreen(window: tauri::WebviewWindow, fullscreen: bool) -> Result<(), String> {
    window
        .set_fullscreen(fullscreen)
        .map_err(|error| error.to_string())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct MonitorGeometry {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

fn monitor_geometry(monitor: &tauri::window::Monitor) -> MonitorGeometry {
    MonitorGeometry {
        x: monitor.position().x,
        y: monitor.position().y,
        width: monitor.size().width,
        height: monitor.size().height,
    }
}

fn place_windowed_stage(
    stage_window: &tauri::WebviewWindow,
    main_window: &tauri::WebviewWindow,
) -> Result<(), String> {
    const WINDOW_WIDTH: f64 = 1280.0;
    const WINDOW_HEIGHT: f64 = 720.0;
    stage_window
        .set_size(tauri::LogicalSize::new(WINDOW_WIDTH, WINDOW_HEIGHT))
        .map_err(|error| error.to_string())?;
    let Some(controller_monitor) = main_window
        .current_monitor()
        .map_err(|error| error.to_string())?
    else {
        return stage_window.center().map_err(|error| error.to_string());
    };
    let scale = controller_monitor.scale_factor();
    let outer_width = (WINDOW_WIDTH * scale).round() as i32;
    let outer_height = (WINDOW_HEIGHT * scale).round() as i32;
    let monitor_position = controller_monitor.position();
    let monitor_size = controller_monitor.size();
    let x = monitor_position.x + (monitor_size.width as i32 - outer_width).max(0) / 2;
    let y = monitor_position.y + (monitor_size.height as i32 - outer_height).max(0) / 2;
    stage_window
        .set_position(tauri::PhysicalPosition::new(x, y))
        .map_err(|error| error.to_string())
}

#[cfg(test)]
fn default_stage_monitor_index(
    monitors: &[MonitorGeometry],
    current: Option<MonitorGeometry>,
) -> Option<usize> {
    match current {
        Some(active) => monitors.iter().position(|monitor| *monitor != active),
        None => (monitors.len() > 1).then_some(1),
    }
}

#[derive(Clone, Debug)]
struct NativeDisplayMetadata {
    id: String,
    name: String,
}

#[cfg(target_os = "windows")]
fn wide_string(value: &[u16]) -> String {
    let length = value
        .iter()
        .position(|character| *character == 0)
        .unwrap_or(value.len());
    String::from_utf16_lossy(&value[..length])
}

#[cfg(target_os = "windows")]
fn native_display_metadata() -> HashMap<String, NativeDisplayMetadata> {
    let mut metadata = HashMap::new();
    for _ in 0..3 {
        let mut path_count = 0;
        let mut mode_count = 0;
        // SAFETY: The Win32 display configuration APIs fill buffers whose sizes are
        // obtained immediately before the query. A topology race is retried below.
        let size_result = unsafe {
            GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut path_count, &mut mode_count)
        };
        if size_result != 0 {
            return metadata;
        }
        let mut paths = vec![DISPLAYCONFIG_PATH_INFO::default(); path_count as usize];
        let mut modes = vec![DISPLAYCONFIG_MODE_INFO::default(); mode_count as usize];
        // SAFETY: Both pointers refer to writable vectors with the exact capacities
        // reported by GetDisplayConfigBufferSizes. No topology output is requested.
        let query_result = unsafe {
            QueryDisplayConfig(
                QDC_ONLY_ACTIVE_PATHS,
                &mut path_count,
                paths.as_mut_ptr(),
                &mut mode_count,
                modes.as_mut_ptr(),
                std::ptr::null_mut(),
            )
        };
        if query_result == 122 {
            continue;
        }
        if query_result != 0 {
            return metadata;
        }
        for path in paths.iter().take(path_count as usize) {
            let mut source = DISPLAYCONFIG_SOURCE_DEVICE_NAME::default();
            source.header.r#type = DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME;
            source.header.size = std::mem::size_of_val(&source) as u32;
            source.header.adapterId = path.sourceInfo.adapterId;
            source.header.id = path.sourceInfo.id;
            // SAFETY: source begins with the required DISPLAYCONFIG header and its
            // size/type fields describe the concrete packet allocated above.
            if unsafe { DisplayConfigGetDeviceInfo(&mut source.header) } != 0 {
                continue;
            }
            let source_name = wide_string(&source.viewGdiDeviceName);
            if source_name.is_empty() {
                continue;
            }

            let mut target = DISPLAYCONFIG_TARGET_DEVICE_NAME::default();
            target.header.r#type = DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME;
            target.header.size = std::mem::size_of_val(&target) as u32;
            target.header.adapterId = path.targetInfo.adapterId;
            target.header.id = path.targetInfo.id;
            // SAFETY: target follows the same packet contract as source above.
            if unsafe { DisplayConfigGetDeviceInfo(&mut target.header) } != 0 {
                continue;
            }
            let device_path = wide_string(&target.monitorDevicePath);
            let friendly_name = wide_string(&target.monitorFriendlyDeviceName);
            metadata.insert(
                source_name.to_ascii_lowercase(),
                NativeDisplayMetadata {
                    id: if device_path.is_empty() {
                        format!("gdi:{}", source_name.to_ascii_lowercase())
                    } else {
                        format!("edid:{}", device_path.to_ascii_lowercase())
                    },
                    name: friendly_name,
                },
            );
        }
        break;
    }
    metadata
}

#[cfg(not(target_os = "windows"))]
fn native_display_metadata() -> HashMap<String, NativeDisplayMetadata> {
    HashMap::new()
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct StageDisplay {
    id: String,
    name: String,
    width: u32,
    height: u32,
    controller: bool,
    selectable: bool,
}

#[derive(Clone)]
struct StageDisplayRecord {
    display: StageDisplay,
    monitor: tauri::window::Monitor,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct StageDisplayInfo {
    monitor_count: usize,
    displays: Vec<StageDisplay>,
    recommended_display_id: Option<String>,
    stage_active: bool,
    active_display_id: Option<String>,
}

fn display_identity(
    monitor: &tauri::window::Monitor,
    metadata: &HashMap<String, NativeDisplayMetadata>,
) -> (String, String) {
    let platform_name = monitor.name().cloned().unwrap_or_default();
    let native = metadata.get(&platform_name.to_ascii_lowercase());
    let geometry = monitor_geometry(monitor);
    let id = native.map(|entry| entry.id.clone()).unwrap_or_else(|| {
        if platform_name.is_empty() {
            format!(
                "geometry:{}:{}:{}:{}",
                geometry.x, geometry.y, geometry.width, geometry.height
            )
        } else {
            format!("platform:{}", platform_name.to_ascii_lowercase())
        }
    });
    let name = native
        .map(|entry| entry.name.trim())
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .unwrap_or(platform_name);
    (id, name)
}

fn enumerate_stage_displays(
    main_window: &tauri::WebviewWindow,
) -> Result<Vec<StageDisplayRecord>, String> {
    let current_monitor = main_window
        .current_monitor()
        .map_err(|error| error.to_string())?;
    let monitors = main_window
        .available_monitors()
        .map_err(|error| error.to_string())?;
    let metadata = native_display_metadata();
    let current_identity = current_monitor
        .as_ref()
        .map(|monitor| display_identity(monitor, &metadata).0);
    let current_geometry = current_monitor.as_ref().map(monitor_geometry);
    let mut records = Vec::with_capacity(monitors.len());
    for (index, monitor) in monitors.into_iter().enumerate() {
        let geometry = monitor_geometry(&monitor);
        let (id, friendly_name) = display_identity(&monitor, &metadata);
        let controller = current_identity.as_deref() == Some(id.as_str())
            || (current_identity.is_none() && current_geometry == Some(geometry));
        let name = if friendly_name.is_empty() {
            format!("Display {}", index + 1)
        } else {
            friendly_name
        };
        records.push(StageDisplayRecord {
            display: StageDisplay {
                id,
                name,
                width: geometry.width,
                height: geometry.height,
                controller,
                selectable: !controller && current_geometry != Some(geometry),
            },
            monitor,
        });
    }
    Ok(records)
}

fn stage_display_info(records: &[StageDisplayRecord], session: &StageSession) -> StageDisplayInfo {
    StageDisplayInfo {
        monitor_count: records.len(),
        displays: records
            .iter()
            .map(|record| record.display.clone())
            .collect(),
        recommended_display_id: records
            .iter()
            .find(|record| record.display.selectable)
            .map(|record| record.display.id.clone()),
        stage_active: session.active,
        active_display_id: session.display_id.clone(),
    }
}

#[cfg(test)]
mod stage_monitor_tests {
    use super::{MonitorGeometry, default_stage_monitor_index};

    const PRIMARY: MonitorGeometry = MonitorGeometry {
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
    };
    const SECONDARY: MonitorGeometry = MonitorGeometry {
        x: 1920,
        y: 0,
        width: 2560,
        height: 1440,
    };

    #[test]
    fn single_display_uses_windowed_primary() {
        assert_eq!(default_stage_monitor_index(&[PRIMARY], Some(PRIMARY)), None);
    }

    #[test]
    fn extended_desktop_selects_display_other_than_main_window() {
        let monitors = [PRIMARY, SECONDARY];
        assert_eq!(
            default_stage_monitor_index(&monitors, Some(PRIMARY)),
            Some(1)
        );
        assert_eq!(
            default_stage_monitor_index(&monitors, Some(SECONDARY)),
            Some(0)
        );
    }

    #[test]
    fn duplicated_geometry_is_not_treated_as_extended_desktop() {
        assert_eq!(
            default_stage_monitor_index(&[PRIMARY, PRIMARY], Some(PRIMARY)),
            None
        );
    }

    #[test]
    fn missing_current_monitor_prefers_second_available_display() {
        assert_eq!(
            default_stage_monitor_index(&[PRIMARY, SECONDARY], None),
            Some(1)
        );
    }
}

#[tauri::command]
fn get_stage_display_info(
    app: tauri::AppHandle,
    stage_session: tauri::State<'_, StageSessionState>,
) -> Result<StageDisplayInfo, String> {
    let main_window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window is unavailable".to_string())?;
    let records = enumerate_stage_displays(&main_window)?;
    let session = stage_session
        .0
        .lock()
        .map_err(|_| "stage session lock is poisoned".to_string())?
        .clone();
    Ok(stage_display_info(&records, &session))
}

#[tauri::command]
async fn open_stage_window(
    app: tauri::AppHandle,
    backend: tauri::State<'_, BackendProcess>,
    stage_session: tauri::State<'_, StageSessionState>,
    display_id: Option<String>,
) -> Result<StageDisplayInfo, String> {
    let main_window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window is unavailable".to_string())?;
    let records = enumerate_stage_displays(&main_window)?;
    let requested_display_id = display_id.filter(|value| !value.trim().is_empty());
    let target_record = requested_display_id
        .as_deref()
        .map(|requested| {
            records
                .iter()
                .find(|record| record.display.id == requested && record.display.selectable)
                .cloned()
                .ok_or_else(|| "the selected display is no longer available".to_string())
        })
        .transpose()?;
    let secondary_monitor = target_record.is_some();

    if let Some(stage_window) = app.get_webview_window("stage") {
        stage_window
            .set_fullscreen(false)
            .map_err(|error| error.to_string())?;
        stage_window
            .set_decorations(!secondary_monitor)
            .map_err(|error| error.to_string())?;
        stage_window
            .set_resizable(!secondary_monitor)
            .map_err(|error| error.to_string())?;
        if secondary_monitor {
            let target_monitor = &target_record
                .as_ref()
                .ok_or_else(|| "the selected display is unavailable".to_string())?
                .monitor;
            stage_window
                .set_position(target_monitor.position().to_owned())
                .map_err(|error| error.to_string())?;
            stage_window
                .set_size(target_monitor.size().to_owned())
                .map_err(|error| error.to_string())?;
        } else {
            place_windowed_stage(&stage_window, &main_window)?;
        }
        stage_window.show().map_err(|error| error.to_string())?;
        stage_window
            .set_fullscreen(secondary_monitor)
            .map_err(|error| error.to_string())?;
        let _ = main_window.set_focus();
        let mut session = stage_session
            .0
            .lock()
            .map_err(|_| "stage session lock is poisoned".to_string())?;
        session.active = true;
        session.display_id = requested_display_id;
        return Ok(stage_display_info(&records, &session));
    }

    let base_url = backend
        .base_url
        .lock()
        .map_err(|_| "backend URL lock is poisoned".to_string())?
        .clone()
        .ok_or_else(|| "backend is not ready".to_string())?;
    let stage_query = if secondary_monitor {
        "?nativeFullscreen=1"
    } else {
        ""
    };
    let stage_url = format!("{}/stage.html{stage_query}", base_url.trim_end_matches('/'))
        .parse()
        .map_err(|error| format!("invalid stage URL: {error}"))?;
    let stage_window = WebviewWindowBuilder::new(&app, "stage", WebviewUrl::External(stage_url))
        .title("Bilikara Stage")
        .visible(false)
        .decorations(!secondary_monitor)
        .resizable(!secondary_monitor)
        .focused(false)
        .inner_size(1280.0, 720.0)
        .build()
        .map_err(|error| error.to_string())?;
    if secondary_monitor {
        let target_monitor = &target_record
            .as_ref()
            .ok_or_else(|| "the selected display is unavailable".to_string())?
            .monitor;
        stage_window
            .set_position(target_monitor.position().to_owned())
            .map_err(|error| error.to_string())?;
        stage_window
            .set_size(target_monitor.size().to_owned())
            .map_err(|error| error.to_string())?;
    } else {
        place_windowed_stage(&stage_window, &main_window)?;
    }
    stage_window.show().map_err(|error| error.to_string())?;
    stage_window
        .set_fullscreen(secondary_monitor)
        .map_err(|error| error.to_string())?;
    let _ = main_window.set_focus();

    let mut session = stage_session
        .0
        .lock()
        .map_err(|_| "stage session lock is poisoned".to_string())?;
    session.active = true;
    session.display_id = requested_display_id;
    Ok(stage_display_info(&records, &session))
}

#[tauri::command]
async fn close_stage_window(
    app: tauri::AppHandle,
    stage_session: tauri::State<'_, StageSessionState>,
) -> Result<(), String> {
    if let Some(stage_window) = app.get_webview_window("stage") {
        stage_window.close().map_err(|error| error.to_string())?;
    }
    *stage_session
        .0
        .lock()
        .map_err(|_| "stage session lock is poisoned".to_string())? = StageSession::default();
    Ok(())
}

fn request_backend_shutdown(base_url: &str, shutdown_token: &str) -> bool {
    let Some(address) = parse_local_http_url(base_url) else {
        return false;
    };
    let Ok(mut stream) = TcpStream::connect((address.connect_host.as_str(), address.port)) else {
        return false;
    };
    let _ = stream.set_write_timeout(Some(Duration::from_secs(1)));
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let request = format!(
        "POST /api/app/shutdown HTTP/1.1\r\nHost: {}:{}\r\nContent-Length: 2\r\nContent-Type: application/json\r\nX-Bilikara-Shutdown-Token: {}\r\nConnection: close\r\n\r\n{}",
        address.host_header, address.port, shutdown_token, "{}"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let _ = stream.shutdown(Shutdown::Write);
    let mut response = Vec::new();
    let _ = stream.read_to_end(&mut response);
    true
}

fn wait_for_child_exit(child: &mut Child, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) => {
                if Instant::now() >= deadline {
                    return false;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(_) => return true,
        }
    }
}

fn wait_for_active_backend_downloads(active_downloads: &AtomicUsize, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    while active_downloads.load(Ordering::Acquire) > 0 {
        if Instant::now() >= deadline {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn sanitized_diagnostic_line(line: &str) -> String {
    let mut sanitized = line
        .chars()
        .filter(|character| !character.is_control() || matches!(character, '\t'))
        .take(MAX_BACKEND_OUTPUT_CHARS + 1)
        .collect::<String>();
    if sanitized.chars().count() > MAX_BACKEND_OUTPUT_CHARS {
        sanitized = sanitized
            .chars()
            .take(MAX_BACKEND_OUTPUT_CHARS)
            .collect::<String>();
        sanitized.push('…');
    }
    sanitized
}

fn sanitized_backend_stdout_line(line: &str) -> String {
    let lower = line.to_ascii_lowercase();
    if [
        "cookie",
        "authorization",
        "sessdata",
        "bili_jct",
        "csrf",
        "qrcode_key",
        "qrcode-key",
        "access_token",
        "access-token",
        "refresh_token",
        "refresh-token",
        "shutdown_token",
        "shutdown-token",
        "secret",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
        || ((lower.contains("http://") || lower.contains("https://")) && line.contains('?'))
    {
        return "[redacted sensitive backend output]".to_string();
    }
    sanitized_diagnostic_line(line)
}

fn push_backend_tail(tail: &Arc<Mutex<BoundedOutputTail>>, line: String) {
    if let Ok(mut output_tail) = tail.lock() {
        output_tail.push(line);
    }
}

fn persist_backend_tail(
    startup_log: Option<&DesktopStartupLog>,
    stream: &str,
    tail: &Arc<Mutex<BoundedOutputTail>>,
) {
    let Some(startup_log) = startup_log else {
        return;
    };
    let lines = tail
        .lock()
        .map(|output_tail| output_tail.snapshot())
        .unwrap_or_default();
    startup_log.append(
        "backend_tail_summary",
        format!("stream={stream} lines={}", lines.len()),
    );
    for (index, line) in lines.iter().enumerate() {
        startup_log.append(
            "backend_tail",
            format!("stream={stream} index={index} output={line}"),
        );
    }
}

fn persist_backend_tails(
    startup_log: Option<&DesktopStartupLog>,
    stdout_tail: &Arc<Mutex<BoundedOutputTail>>,
    stderr_tail: &Arc<Mutex<BoundedOutputTail>>,
) {
    persist_backend_tail(startup_log, "stdout", stdout_tail);
    persist_backend_tail(startup_log, "stderr", stderr_tail);
}

fn fail_desktop_startup(
    app_handle: &tauri::AppHandle,
    startup_log: Option<&DesktopStartupLog>,
    reason: &str,
) {
    eprintln!("Bilikara desktop startup failed: {reason}");
    if let Some(startup_log) = startup_log {
        startup_log.append("desktop_failure", format!("reason={reason}"));
    }

    #[cfg(target_os = "macos")]
    {
        let diagnostic_location = startup_log
            .map(|log| {
                format!(
                    "Startup details were written to:\n\n{}",
                    log.path.to_string_lossy()
                )
            })
            .unwrap_or_else(|| {
                "The startup log could not be written. Launch the app from Terminal to capture the OS error."
                    .to_string()
            });
        let exit_handle = app_handle.clone();
        app_handle
            .dialog()
            .message(format!(
                "Bilikara's backend stopped or could not start.\n\n{diagnostic_location}"
            ))
            .title("Bilikara backend failure")
            .kind(MessageDialogKind::Error)
            .show(move |_| exit_handle.exit(1));
    }

    #[cfg(not(target_os = "macos"))]
    app_handle.exit(1);
}

fn process_backend_stdout_line(line: &str, ready_handled: &mut bool) -> BackendStdoutLine {
    if !*ready_handled
        && let Ok(ready) = serde_json::from_str::<ReadyEvent>(line)
        && ready.event == "bilikara.ready"
    {
        *ready_handled = true;
        return BackendStdoutLine::Ready(ready);
    }
    BackendStdoutLine::Output(sanitized_backend_stdout_line(line))
}

fn write_and_flush_ready_marker<W: io::Write>(mut writer: W, base_url: &str) -> io::Result<()> {
    writeln!(writer, "Backend ready at {}", base_url)?;
    writer.flush()
}

fn forward_backend_stdout_line<W: Write>(mut writer: W, line: &str) {
    let _ = writeln!(writer, "Backend stdout: {line}");
}

fn drain_backend_stdout<R, FReady, FOutput>(
    reader: R,
    mut on_ready: FReady,
    mut on_output: FOutput,
) -> io::Result<()>
where
    R: BufRead,
    FReady: FnMut(ReadyEvent),
    FOutput: FnMut(String),
{
    let mut ready_handled = false;
    for line in reader.lines() {
        match process_backend_stdout_line(&line?, &mut ready_handled) {
            BackendStdoutLine::Ready(ready) => on_ready(ready),
            BackendStdoutLine::Output(output) => on_output(output),
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn macos_autoplay_webview_configuration() -> Retained<WKWebViewConfiguration> {
    let main_thread = MainThreadMarker::new()
        .expect("the macOS Tauri setup hook must execute on the main thread");
    // SAFETY: The configuration is created on the main thread, and the public
    // WebKit setter accepts the pinned crate's no-media option-set value.
    let configuration = unsafe { WKWebViewConfiguration::new(main_thread) };
    unsafe {
        configuration.setMediaTypesRequiringUserActionForPlayback(WKAudiovisualMediaTypes::None);
    }
    configuration
}

#[cfg(target_os = "macos")]
fn create_macos_main_webview_window(app: &tauri::App) -> tauri::Result<()> {
    if app.get_webview_window("main").is_some() {
        return Err(tauri::Error::WebviewLabelAlreadyExists("main".into()));
    }
    let window_config = app
        .config()
        .app
        .windows
        .iter()
        .find(|config| config.label == "main")
        .ok_or(tauri::Error::WindowNotFound)?
        .clone();

    tauri::WebviewWindowBuilder::from_config(app.handle(), &window_config)?
        .with_webview_configuration(macos_autoplay_webview_configuration())
        .build()?;
    Ok(())
}

fn main() {
    let current_exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("."));
    let current_exe = current_exe.canonicalize().unwrap_or(current_exe);
    let current_dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let startup_log = open_desktop_startup_log(&current_exe);
    if let Some(startup_log) = startup_log.as_ref() {
        startup_log.append(
            "desktop_start",
            format!(
                "desktop_executable={} cwd={} log_path={}",
                current_exe.display(),
                current_dir.display(),
                startup_log.path.display()
            ),
        );
    }
    install_desktop_panic_hook(startup_log.as_ref());

    let startup_log_for_setup = startup_log.clone();
    let run_result = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(StageSessionState::default())
        .invoke_handler(tauri::generate_handler![
            set_window_fullscreen,
            save_backend_download,
            get_stage_display_info,
            open_stage_window,
            close_stage_window
        ])
        .setup(move |app| {
            let startup_log = startup_log_for_setup.clone();

            #[cfg(target_os = "macos")]
            create_macos_main_webview_window(app)?;

            let Some(window) = app.get_webview_window("main") else {
                fail_desktop_startup(
                    app.handle(),
                    startup_log.as_ref(),
                    "main Tauri window is unavailable",
                );
                return Ok(());
            };

            let mut resolution = match resolve_backend_command() {
                Ok(resolution) => resolution,
                Err(missing) => {
                    let detail = format!(
                        "candidate_type={} command_path={} candidate_exists={} candidate_executable={}",
                        missing.candidate_type,
                        missing.command_path.display(),
                        missing.candidate_exists,
                        missing.candidate_executable,
                    );
                    if let Some(startup_log) = startup_log.as_ref() {
                        startup_log.append("packaged_backend_missing", &detail);
                    }
                    fail_desktop_startup(app.handle(), startup_log.as_ref(), &detail);
                    return Ok(());
                }
            };
            resolution.args.extend(vec![
                "--no-browser".to_string(),
                "--headless".to_string(),
                "--port".to_string(),
                "0".to_string(),
            ]);
            let diagnostic_command_path = command_path_for_diagnostics(&resolution.command);
            let candidate_exists = diagnostic_command_path.is_file();
            let candidate_executable = path_has_executable_bit(&diagnostic_command_path);
            if let Some(startup_log) = startup_log.as_ref() {
                startup_log.append(
                    "backend_resolved",
                    format!(
                        "candidate_type={} command_path={} candidate_exists={} candidate_executable={} args_count={}",
                        resolution.candidate_type,
                        diagnostic_command_path.display(),
                        candidate_exists,
                        candidate_executable,
                        resolution.args.len()
                    ),
                );
            }

            let shutdown_token = make_shutdown_token();
            let desktop_executable = current_executable_string();

            let mut command = Command::new(&resolution.command);
            command
                .args(resolution.args)
                .env("PYTHONUNBUFFERED", "1")
                .env("BILIKARA_STARTUP_LOG", "1")
                .env("BILIKARA_LAUNCH_MODE", "tauri")
                .env("BILIKARA_DESKTOP_PID", std::process::id().to_string())
                .env("BILIKARA_DESKTOP_EXECUTABLE", desktop_executable)
                .env("BILIKARA_SHUTDOWN_TOKEN", shutdown_token.clone())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());

            #[cfg(target_os = "windows")]
            command.creation_flags(CREATE_NO_WINDOW);

            let mut child = match command.spawn() {
                Ok(child) => child,
                Err(error) => {
                    let detail = format!(
                        "status=error kind={:?} raw_os_error={:?} message={}",
                        error.kind(),
                        error.raw_os_error(),
                        error
                    );
                    if let Some(startup_log) = startup_log.as_ref() {
                        startup_log.append("backend_spawn", &detail);
                    }
                    fail_desktop_startup(app.handle(), startup_log.as_ref(), &detail);
                    return Ok(());
                }
            };
            if let Some(startup_log) = startup_log.as_ref() {
                startup_log.append(
                    "backend_spawn",
                    format!("status=ok child_pid={}", child.id()),
                );
            }

            let Some(stdout) = child.stdout.take() else {
                let _ = child.kill();
                let _ = child.wait();
                fail_desktop_startup(
                    app.handle(),
                    startup_log.as_ref(),
                    "backend child started without a stdout pipe",
                );
                return Ok(());
            };
            let stderr = child.stderr.take();
            let window_clone = window.clone();
            let child_arc = Arc::new(Mutex::new(Some(child)));
            let base_url = Arc::new(Mutex::new(None));
            let base_url_for_reader = base_url.clone();
            let ready_received = Arc::new(AtomicBool::new(false));
            let stdout_tail = Arc::new(Mutex::new(BoundedOutputTail::default()));
            let stderr_tail = Arc::new(Mutex::new(BoundedOutputTail::default()));

            app.manage(BackendProcess {
                child: child_arc.clone(),
                base_url: base_url.clone(),
                shutdown_token: shutdown_token.clone(),
                active_downloads: Arc::new(AtomicUsize::new(0)),
            });

            if let Some(stderr) = stderr {
                let stderr_tail_for_reader = stderr_tail.clone();
                let startup_log_for_stderr = startup_log.clone();
                std::thread::spawn(move || {
                    let reader = BufReader::new(stderr);
                    for line in reader.lines() {
                        match line {
                            Ok(line) => {
                                let sanitized = sanitized_backend_stdout_line(&line);
                                push_backend_tail(&stderr_tail_for_reader, sanitized.clone());
                                eprintln!("Backend stderr: {sanitized}");
                            }
                            Err(error) => {
                                if let Some(startup_log) = startup_log_for_stderr.as_ref() {
                                    startup_log.append(
                                        "backend_stderr_reader",
                                        format!("status=error message={error}"),
                                    );
                                }
                                break;
                            }
                        }
                    }
                });
            } else if let Some(startup_log) = startup_log.as_ref() {
                startup_log.append("backend_stderr_reader", "status=missing-pipe");
            }

            let ready_for_reader = ready_received.clone();
            let stdout_tail_for_reader = stdout_tail.clone();
            let startup_log_for_stdout = startup_log.clone();
            std::thread::spawn(move || {
                let reader = BufReader::new(stdout);
                let result = drain_backend_stdout(
                    reader,
                    |ready| {
                        ready_for_reader.store(true, Ordering::Release);
                        if let Some(startup_log) = startup_log_for_stdout.as_ref() {
                            let address = parse_local_http_url(&ready.base_url)
                                .map(|address| {
                                    format!("{}:{}", address.connect_host, address.port)
                                })
                                .unwrap_or_else(|| "unparsed".to_string());
                            startup_log.append(
                                "backend_ready",
                                format!("ready_marker_received=true address={address}"),
                            );
                        }
                        if let Err(error) =
                            write_and_flush_ready_marker(io::stdout(), &ready.base_url)
                        {
                            eprintln!("Failed to flush backend readiness output: {error}");
                            if let Some(startup_log) = startup_log_for_stdout.as_ref() {
                                startup_log.append(
                                    "ready_forward",
                                    format!("status=error message={error}"),
                                );
                            }
                        }
                        if let Ok(mut stored_url) = base_url_for_reader.lock() {
                            *stored_url = Some(ready.base_url.clone());
                        }
                        if let Err(error) = window_clone.show() {
                            eprintln!("Failed to show window: {}", error);
                            if let Some(startup_log) = startup_log_for_stdout.as_ref() {
                                startup_log.append(
                                    "window_show",
                                    format!("status=error message={error}"),
                                );
                            }
                        } else if let Some(startup_log) = startup_log_for_stdout.as_ref() {
                            startup_log.append("window_show", "status=ok");
                        }
                        if let Err(error) = window_clone.set_always_on_top(true)
                            && let Some(startup_log) = startup_log_for_stdout.as_ref()
                        {
                            startup_log.append(
                                "window_raise",
                                format!("status=error phase=enable message={error}"),
                            );
                        }
                        if let Err(error) = window_clone.set_always_on_top(false)
                            && let Some(startup_log) = startup_log_for_stdout.as_ref()
                        {
                            startup_log.append(
                                "window_raise",
                                format!("status=error phase=disable message={error}"),
                            );
                        }
                        if let Err(error) = window_clone.set_focus() {
                            if let Some(startup_log) = startup_log_for_stdout.as_ref() {
                                startup_log.append(
                                    "window_focus",
                                    format!("status=error message={error}"),
                                );
                            }
                        } else if let Some(startup_log) = startup_log_for_stdout.as_ref() {
                            startup_log.append("window_focus", "status=ok");
                        }
                        if let Err(error) = window_clone
                            .eval(format!("window.location.replace('{}');", ready.base_url))
                        {
                            eprintln!("Failed to navigate to backend: {}", error);
                            if let Some(startup_log) = startup_log_for_stdout.as_ref() {
                                startup_log.append(
                                    "window_navigate",
                                    format!("status=error message={error}"),
                                );
                            }
                        } else if let Some(startup_log) = startup_log_for_stdout.as_ref() {
                            startup_log.append("window_navigate", "status=ok");
                        }
                    },
                    |line| {
                        push_backend_tail(&stdout_tail_for_reader, line.clone());
                        forward_backend_stdout_line(io::stdout(), &line);
                    },
                );
                if let Err(error) = result {
                    eprintln!("Failed to read backend stdout: {error}");
                    if let Some(startup_log) = startup_log_for_stdout.as_ref() {
                        startup_log.append(
                            "backend_stdout_reader",
                            format!("status=error message={error}"),
                        );
                    }
                }
            });

            let app_handle = app.handle().clone();
            let child_for_monitor = child_arc.clone();
            let ready_for_monitor = ready_received.clone();
            let stdout_tail_for_monitor = stdout_tail.clone();
            let stderr_tail_for_monitor = stderr_tail.clone();
            let startup_log_for_monitor = startup_log.clone();
            std::thread::spawn(move || {
                let ready_deadline = Instant::now() + BACKEND_READY_TIMEOUT;
                loop {
                    std::thread::sleep(Duration::from_millis(250));
                    let ready = ready_for_monitor.load(Ordering::Acquire);
                    let mut failure_reason = None;
                    let mut monitor_complete = false;
                    match child_for_monitor.lock() {
                        Ok(mut child_lock) => {
                            if let Some(child) = child_lock.as_mut() {
                                match child.try_wait() {
                                    Ok(Some(status)) => {
                                        let phase = if ready { "after-ready" } else { "before-ready" };
                                        let detail = format!(
                                            "phase={phase} status={status} ready_marker_received={ready}"
                                        );
                                        if let Some(startup_log) =
                                            startup_log_for_monitor.as_ref()
                                        {
                                            startup_log.append("backend_exit", &detail);
                                        }
                                        *child_lock = None;
                                        failure_reason = Some(format!("backend exited {detail}"));
                                    }
                                    Ok(None) if !ready && Instant::now() >= ready_deadline => {
                                        let kill_result = child.kill();
                                        let wait_result = child.wait();
                                        let detail = format!(
                                            "ready_marker_received=false timeout_seconds={} kill_result={kill_result:?} exit_status={wait_result:?}",
                                            BACKEND_READY_TIMEOUT.as_secs()
                                        );
                                        if let Some(startup_log) =
                                            startup_log_for_monitor.as_ref()
                                        {
                                            startup_log.append("backend_ready_timeout", &detail);
                                        }
                                        *child_lock = None;
                                        failure_reason = Some(format!(
                                            "backend ready marker timed out: {detail}"
                                        ));
                                    }
                                    Ok(None) => {}
                                    Err(error) => {
                                        let detail = format!(
                                            "ready_marker_received={ready} kind={:?} raw_os_error={:?} message={error}",
                                            error.kind(),
                                            error.raw_os_error()
                                        );
                                        if let Some(startup_log) =
                                            startup_log_for_monitor.as_ref()
                                        {
                                            startup_log.append("backend_wait", &detail);
                                        }
                                        *child_lock = None;
                                        failure_reason =
                                            Some(format!("failed to wait for backend: {detail}"));
                                    }
                                }
                            } else {
                                monitor_complete = true;
                            }
                        }
                        Err(_) => {
                            failure_reason =
                                Some("backend process lock became unavailable".to_string());
                        }
                    }

                    if let Some(reason) = failure_reason {
                        std::thread::sleep(Duration::from_millis(100));
                        persist_backend_tails(
                            startup_log_for_monitor.as_ref(),
                            &stdout_tail_for_monitor,
                            &stderr_tail_for_monitor,
                        );
                        fail_desktop_startup(
                            &app_handle,
                            startup_log_for_monitor.as_ref(),
                            &reason,
                        );
                        break;
                    }
                    if monitor_complete {
                        break;
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "stage"
                && let tauri::WindowEvent::Destroyed = event
                && let Some(state) = window.try_state::<StageSessionState>()
                && let Ok(mut session) = state.0.lock()
            {
                *session = StageSession::default();
            }
            if window.label() == "main"
                && let tauri::WindowEvent::Destroyed = event
                && let Some(state) = window.try_state::<BackendProcess>()
            {
                if let Some(stage_window) = window.app_handle().get_webview_window("stage") {
                    let _ = stage_window.close();
                }
                wait_for_active_backend_downloads(
                    &state.active_downloads,
                    ACTIVE_BACKEND_DOWNLOAD_SHUTDOWN_GRACE,
                );
                let shutdown_url = state
                    .base_url
                    .lock()
                    .ok()
                    .and_then(|stored_url| stored_url.clone());
                let shutdown_requested = shutdown_url
                    .as_deref()
                    .map(|url| request_backend_shutdown(url, &state.shutdown_token))
                    .unwrap_or(false);

                if let Ok(mut child_lock) = state.child.lock()
                    && let Some(mut child) = child_lock.take()
                {
                    let exited_gracefully = shutdown_requested
                        && wait_for_child_exit(&mut child, Duration::from_secs(20));
                    if !exited_gracefully {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                }
                window.app_handle().exit(0);
            }
        })
        .run(tauri::generate_context!());

    match run_result {
        Ok(()) => {
            if let Some(startup_log) = startup_log.as_ref() {
                startup_log.append("desktop_exit", "status=ok");
            }
        }
        Err(error) => {
            if let Some(startup_log) = startup_log.as_ref() {
                startup_log.append("tauri_run", format!("status=error message={error}"));
            }
            panic!("error while running tauri application: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::net::TcpListener;
    use std::thread;

    fn download_request(
        path: &str,
        body: Option<&str>,
        client_id: Option<&str>,
    ) -> SaveBackendDownloadRequest {
        SaveBackendDownloadRequest {
            path: path.to_string(),
            body: body.map(str::to_string),
            client_id: client_id.map(str::to_string),
        }
    }

    fn valid_csv_response(version: &str, body: &[u8]) -> Vec<u8> {
        valid_download_response(version, "text/csv; charset=utf-8", "list.csv", body)
    }

    fn valid_download_response(
        version: &str,
        content_type: &str,
        filename: &str,
        body: &[u8],
    ) -> Vec<u8> {
        let mut response = format!(
            "{version} 200 OK\r\nContent-Length: {}\r\nContent-Type: {content_type}\r\nContent-Disposition: attachment; filename=\"{filename}\"\r\n\r\n",
            body.len()
        )
        .into_bytes();
        response.extend_from_slice(body);
        response
    }

    #[test]
    fn native_download_request_allows_only_export_endpoints() {
        let csv = validate_backend_download_request(&download_request(
            "/api/playlist/export?format=csv&source=played",
            None,
            Some("client-1"),
        ))
        .expect("CSV request");
        assert_eq!(csv.method, "GET");
        assert_eq!(csv.kind, BackendDownloadKind::PlaylistCsv);
        assert_eq!(csv.default_filename, "bilikara-playlist.csv");

        let image = validate_backend_download_request(&download_request(
            "/api/playlist/export?format=image&source=played",
            None,
            None,
        ))
        .expect("image request");
        assert_eq!(image.kind, BackendDownloadKind::PlaylistImage);
        assert_eq!(image.default_filename, "bilikara-playlist.png");

        let diagnostics = validate_backend_download_request(&download_request(
            "/api/diagnostics/package",
            Some("{}"),
            Some("client-1"),
        ))
        .expect("diagnostics request");
        assert_eq!(diagnostics.method, "POST");
        assert_eq!(diagnostics.kind, BackendDownloadKind::Diagnostics);
        assert_eq!(diagnostics.body, "{}");

        assert!(
            validate_backend_download_request(&download_request("/api/state", None, None)).is_err()
        );
        assert!(
            validate_backend_download_request(&download_request(
                "/api/playlist/export?format=csv HTTP/1.1",
                None,
                None,
            ))
            .is_err()
        );
        assert!(
            validate_backend_download_request(&download_request(
                "/api/playlist/export?format=pdf",
                None,
                None,
            ))
            .is_err()
        );
    }

    #[test]
    fn native_download_request_enforces_body_and_client_id_rules() {
        assert!(
            validate_backend_download_request(&download_request(
                "/api/playlist/export?format=csv",
                Some("{}"),
                Some("client-1"),
            ))
            .is_err()
        );
        assert!(
            validate_backend_download_request(&download_request(
                "/api/diagnostics/package",
                Some("[]"),
                Some("client-1"),
            ))
            .is_err()
        );
        assert!(
            validate_backend_download_request(&download_request(
                "/api/diagnostics/package",
                Some("{}"),
                Some("client\r\ninjected"),
            ))
            .is_err()
        );
    }

    #[test]
    fn backend_urls_support_loopback_physical_ipv4_and_ipv6() {
        assert_eq!(
            parse_local_http_url("http://127.0.0.1:8080/"),
            Some(BackendAddress {
                connect_host: "127.0.0.1".to_string(),
                host_header: "127.0.0.1".to_string(),
                port: 8080,
            })
        );
        assert_eq!(
            parse_local_http_url("http://192.168.1.20:4567"),
            Some(BackendAddress {
                connect_host: "192.168.1.20".to_string(),
                host_header: "192.168.1.20".to_string(),
                port: 4567,
            })
        );
        assert_eq!(
            parse_local_http_url("http://[::1]:9090/"),
            Some(BackendAddress {
                connect_host: "::1".to_string(),
                host_header: "[::1]".to_string(),
                port: 9090,
            })
        );
        assert!(parse_local_http_url("https://127.0.0.1:8080/").is_none());
        assert!(parse_local_http_url("http://user@127.0.0.1:8080/").is_none());
    }

    #[test]
    fn window_authorization_compares_exact_normalized_origins() {
        for (window_url, backend_url) in [
            (
                "http://127.0.0.1:8080/route?view=host",
                "http://127.0.0.1:8080",
            ),
            ("http://localhost:8080/", "http://LOCALHOST.:8080/"),
            (
                "http://192.168.1.20:49152/host",
                "http://192.168.1.20:49152/",
            ),
            ("http://[::1]:8080/path", "http://[::1]:8080/"),
        ] {
            assert!(
                window_origin_authorized(window_url, backend_url),
                "{window_url} should match {backend_url}"
            );
        }
        for (window_url, backend_url) in [
            (
                "http://127.0.0.1:8080.evil.invalid/",
                "http://127.0.0.1:8080/",
            ),
            ("http://127.0.0.1:8081/", "http://127.0.0.1:8080/"),
            ("https://127.0.0.1:8080/", "http://127.0.0.1:8080/"),
            ("http://localhost:8080/", "http://127.0.0.1:8080/"),
            ("http://user@127.0.0.1:8080/", "http://127.0.0.1:8080/"),
        ] {
            assert!(
                !window_origin_authorized(window_url, backend_url),
                "{window_url} must not match {backend_url}"
            );
        }
    }

    #[test]
    fn export_dialog_spec_selects_validated_filename_and_filter_extension() {
        let csv_resp = ValidatedBackendDownloadResponse {
            filename: "bilikara-played.csv".to_string(),
            required_extension: "csv",
        };
        assert_eq!(
            export_dialog_spec(&csv_resp),
            ("bilikara-played.csv", "csv")
        );

        let single_image_resp = ValidatedBackendDownloadResponse {
            filename: "bilikara-played.png".to_string(),
            required_extension: "png",
        };
        assert_eq!(
            export_dialog_spec(&single_image_resp),
            ("bilikara-played.png", "png")
        );

        let multipage_image_resp = ValidatedBackendDownloadResponse {
            filename: "bilikara-played-1-5.zip".to_string(),
            required_extension: "zip",
        };
        assert_eq!(
            export_dialog_spec(&multipage_image_resp),
            ("bilikara-played-1-5.zip", "zip")
        );

        let diag_resp = ValidatedBackendDownloadResponse {
            filename: "bilikara-diagnostics.zip".to_string(),
            required_extension: "zip",
        };
        assert_eq!(
            export_dialog_spec(&diag_resp),
            ("bilikara-diagnostics.zip", "zip")
        );
    }

    #[test]
    fn native_http_request_formats_get_and_post_without_exposing_body_in_logs() {
        let address = parse_local_http_url("http://127.0.0.1:8080").expect("address");
        let get = validate_backend_download_request(&download_request(
            "/api/playlist/export?format=csv",
            None,
            Some("client-1"),
        ))
        .expect("GET request");
        let get_text =
            String::from_utf8(build_backend_http_request(&address, &get)).expect("UTF-8");
        assert!(get_text.starts_with("GET /api/playlist/export?format=csv HTTP/1.1\r\n"));
        assert!(get_text.contains("Host: 127.0.0.1:8080\r\n"));
        assert!(get_text.contains("X-Bilikara-Client: client-1\r\n"));
        assert!(get_text.ends_with("Content-Length: 0\r\n\r\n"));

        let post = validate_backend_download_request(&download_request(
            "/api/diagnostics/package",
            Some("{\"browser\":{}}"),
            Some("client-2"),
        ))
        .expect("POST request");
        let post_text =
            String::from_utf8(build_backend_http_request(&address, &post)).expect("UTF-8");
        assert!(post_text.starts_with("POST /api/diagnostics/package HTTP/1.1\r\n"));
        assert!(post_text.contains("Content-Type: application/json\r\n"));
        assert!(post_text.ends_with("\r\n\r\n{\"browser\":{}}"));
    }

    #[test]
    fn native_download_response_supports_http_10_http_11_and_close_framing() {
        for version in ["HTTP/1.0", "HTTP/1.1"] {
            let response = parse_backend_download_response(valid_csv_response(version, b"csv"))
                .expect("valid response");
            assert_eq!(response.status, 200);
            assert_eq!(response.body, b"csv");
        }

        let close_framed = parse_backend_download_response(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/csv\r\nContent-Disposition: attachment; filename=\"list.csv\"\r\n\r\ncsv"
                .to_vec(),
        )
        .expect("connection-close response");
        assert_eq!(close_framed.body, b"csv");

        let incomplete = parse_backend_download_response(
            b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\ncsv".to_vec(),
        );
        assert!(incomplete.is_err());
        assert!(
            parse_backend_download_response(
                b"HTTP/1.1 200 OK\r\nContent-Length: nope\r\n\r\ncsv".to_vec()
            )
            .is_err()
        );
        assert!(parse_backend_download_response(b"not-http\r\n\r\ncsv".to_vec()).is_err());
    }

    #[test]
    fn native_download_response_reports_json_errors_and_validates_headers() {
        let request = validate_backend_download_request(&download_request(
            "/api/playlist/export?format=csv",
            None,
            Some("client-1"),
        ))
        .expect("request");
        let forbidden = parse_backend_download_response(
            b"HTTP/1.1 403 Forbidden\r\nContent-Length: 21\r\nContent-Type: application/json\r\n\r\n{\"error\":\"forbidden\"}"
                .to_vec(),
        )
        .expect("parsed 403");
        assert_eq!(
            validate_backend_download_response(&forbidden, &request),
            Err("forbidden".to_string())
        );
        let server_error = parse_backend_download_response(
            b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 18\r\nContent-Type: application/json\r\n\r\n{\"error\":\"failed\"}"
                .to_vec(),
        )
        .expect("parsed 500");
        assert_eq!(
            validate_backend_download_response(&server_error, &request),
            Err("failed".to_string())
        );

        let valid = parse_backend_download_response(valid_csv_response("HTTP/1.1", b"csv"))
            .expect("valid response");
        assert_eq!(
            validate_backend_download_response(&valid, &request),
            Ok(ValidatedBackendDownloadResponse {
                filename: "list.csv".to_string(),
                required_extension: "csv",
            })
        );

        let malformed_type = parse_backend_download_response(
            b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nContent-Type: application/zip\r\nContent-Disposition: attachment; filename=\"list.csv\"\r\n\r\ncsv"
                .to_vec(),
        )
        .expect("parsed response");
        assert!(validate_backend_download_response(&malformed_type, &request).is_err());
    }

    #[test]
    fn native_image_response_selects_png_or_zip_extension() {
        let request = validate_backend_download_request(&download_request(
            "/api/playlist/export?format=image&source=played",
            None,
            Some("client-1"),
        ))
        .expect("image request");
        for (content_type, filename, required_extension) in [
            ("image/png", "bilikara-playlist.png", "png"),
            ("application/zip", "bilikara-playlist-images.zip", "zip"),
        ] {
            let response = parse_backend_download_response(valid_download_response(
                "HTTP/1.1",
                content_type,
                filename,
                b"payload",
            ))
            .expect("valid image response");
            assert_eq!(
                validate_backend_download_response(&response, &request),
                Ok(ValidatedBackendDownloadResponse {
                    filename: filename.to_string(),
                    required_extension,
                })
            );
        }

        let mismatched = parse_backend_download_response(valid_download_response(
            "HTTP/1.1",
            "application/zip",
            "bilikara-playlist.png",
            b"payload",
        ))
        .expect("parse mismatched response");
        assert_eq!(
            validate_backend_download_response(&mismatched, &request),
            Err("后端文件名与 Content-Type 不一致".to_string())
        );
    }

    #[test]
    fn native_diagnostics_response_contract_and_request_validation() {
        let request_payload = SaveBackendDownloadRequest {
            path: "/api/diagnostics/package".to_string(),
            body: Some("{\"browser\":{}}".to_string()),
            client_id: Some("client-1".to_string()),
        };
        let request =
            validate_backend_download_request(&request_payload).expect("diagnostics request");
        assert_eq!(request.method, "POST");
        assert_eq!(request.path, "/api/diagnostics/package");
        assert_eq!(request.kind, BackendDownloadKind::Diagnostics);
        assert_eq!(request.format, "zip");
        assert_eq!(request.body, "{\"browser\":{}}");

        let raw_http = valid_download_response(
            "HTTP/1.1",
            "application/zip",
            "bilikara-diagnostics-20260807-120000.zip",
            b"fake-zip-payload",
        );
        let parsed = parse_backend_download_response(raw_http).expect("parsed response");
        assert_eq!(
            validate_backend_download_response(&parsed, &request),
            Ok(ValidatedBackendDownloadResponse {
                filename: "bilikara-diagnostics-20260807-120000.zip".to_string(),
                required_extension: "zip",
            })
        );
    }

    #[test]
    fn native_download_filename_uses_content_disposition_safely() {
        assert_eq!(
            safe_download_filename(
                "attachment; filename=\"bilikara-played-20260723.csv\"",
                "fallback.csv",
            ),
            "bilikara-played-20260723.csv"
        );
        assert_eq!(
            safe_download_filename(
                "attachment; filename=\"../unsafe name.zip\"",
                "fallback.zip"
            ),
            "unsafe-name.zip"
        );
    }

    #[test]
    fn native_download_corrects_only_the_user_selected_extension() {
        assert_eq!(
            final_download_target_path(Path::new("/exports/custom-name.png"), "png"),
            (PathBuf::from("/exports/custom-name.png"), false)
        );
        assert_eq!(
            final_download_target_path(Path::new("/exports/custom-name.png"), "zip"),
            (PathBuf::from("/exports/custom-name.zip"), true)
        );
        assert_eq!(
            final_download_target_path(Path::new("/exports/my.custom.name.png"), "zip"),
            (PathBuf::from("/exports/my.custom.name.zip"), true)
        );
        assert_eq!(
            final_download_target_path(Path::new("/exports/custom-name"), "zip"),
            (PathBuf::from("/exports/custom-name.zip"), true)
        );
        assert_eq!(
            final_download_target_path(Path::new("/exports/custom-name.ZIP"), "zip"),
            (PathBuf::from("/exports/custom-name.ZIP"), false)
        );
    }

    #[test]
    fn corrected_target_does_not_silently_overwrite_an_existing_file() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let test_dir = std::env::temp_dir().join(format!(
            "bilikara-export-target-test-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir(&test_dir).expect("create test directory");
        let selected = test_dir.join("custom-name.png");
        let corrected = test_dir.join("custom-name.zip");

        std::fs::write(&selected, b"old selected content").expect("seed selected file");
        write_backend_download(&selected, b"new png", true).expect("approved overwrite");
        assert_eq!(
            std::fs::read(&selected).expect("read selected file"),
            b"new png"
        );

        write_backend_download(&corrected, b"new zip", false).expect("new corrected target");
        assert_eq!(
            std::fs::read(&corrected).expect("read corrected file"),
            b"new zip"
        );
        let error = write_backend_download(&corrected, b"replacement", false)
            .expect_err("corrected target must not be overwritten silently");
        assert_eq!(
            error,
            "[write_file] 修正扩展名后的目标文件已存在，请重新选择保存位置"
        );
        assert_eq!(
            std::fs::read(&corrected).expect("read preserved file"),
            b"new zip"
        );

        std::fs::remove_dir_all(&test_dir).expect("clean test directory");
    }

    #[test]
    fn native_download_result_and_errors_are_typed_and_staged() {
        let saved_val = serde_json::to_value(SaveBackendDownloadResult {
            status: SaveBackendDownloadStatus::Saved,
            stage: "complete".to_string(),
            format: Some("csv".to_string()),
            source: Some("played".to_string()),
            page_size: Some(200),
            http_status: Some(200),
            content_type: Some("text/csv".to_string()),
            bytes: Some(1024),
            filename_extension: Some("csv".to_string()),
            elapsed_ms: 100,
            stage_timings: vec![StageTiming {
                stage: "complete".to_string(),
                elapsed_ms: 10,
            }],
            error_code: None,
            error_message: None,
        })
        .expect("saved JSON");
        assert_eq!(saved_val["status"], "saved");
        assert_eq!(saved_val["stage"], "complete");
        assert_eq!(saved_val["format"], "csv");
        assert_eq!(saved_val["source"], "played");
        assert_eq!(saved_val["pageSize"], 200);
        assert_eq!(saved_val["httpStatus"], 200);
        assert_eq!(saved_val["contentType"], "text/csv");
        assert_eq!(saved_val["bytes"], 1024);
        assert_eq!(saved_val["filenameExtension"], "csv");
        assert_eq!(saved_val["elapsedMs"], 100);

        let cancelled_val = serde_json::to_value(SaveBackendDownloadResult {
            status: SaveBackendDownloadStatus::Cancelled,
            stage: "choose_destination".to_string(),
            format: Some("csv".to_string()),
            source: Some("played".to_string()),
            page_size: Some(200),
            http_status: None,
            content_type: None,
            bytes: None,
            filename_extension: None,
            elapsed_ms: 50,
            stage_timings: vec![],
            error_code: None,
            error_message: None,
        })
        .expect("cancelled JSON");
        assert_eq!(cancelled_val["status"], "cancelled");
        assert_eq!(cancelled_val["stage"], "choose_destination");

        let failed_val = serde_json::to_value(SaveBackendDownloadResult {
            status: SaveBackendDownloadStatus::Failed,
            stage: "request_backend".to_string(),
            format: Some("csv".to_string()),
            source: Some("played".to_string()),
            page_size: Some(200),
            http_status: None,
            content_type: None,
            bytes: None,
            filename_extension: None,
            elapsed_ms: 50,
            stage_timings: vec![],
            error_code: Some("REQUEST_BACKEND_FAILED".to_string()),
            error_message: Some("[request_backend] connection refused".to_string()),
        })
        .expect("failed JSON");
        assert_eq!(failed_val["status"], "failed");
        assert_eq!(failed_val["stage"], "request_backend");
        assert_eq!(failed_val["errorCode"], "REQUEST_BACKEND_FAILED");
        assert_eq!(
            staged_error("write_file", "写入导出文件失败：permission denied"),
            "[write_file] 写入导出文件失败：permission denied"
        );
        assert_eq!(
            staged_error("validate_response", ""),
            "[validate_response] 导出失败"
        );
        let write_error = write_backend_download(&std::env::temp_dir(), b"data", true)
            .expect_err("a directory is not a writable file destination");
        assert!(write_error.starts_with("[write_file] 写入导出文件失败："));
    }

    #[test]
    fn native_download_reports_backend_unavailable_at_transport_boundary() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("reserve test port");
        let port = listener.local_addr().expect("local address").port();
        drop(listener);
        let request = validate_backend_download_request(&download_request(
            "/api/playlist/export?format=csv",
            None,
            Some("client-1"),
        ))
        .expect("request");
        let error = request_backend_download(&format!("http://127.0.0.1:{port}"), &request)
            .expect_err("closed port must fail");
        assert!(error.starts_with("无法连接本机后端："));
    }

    #[test]
    fn window_shutdown_waits_for_the_in_flight_download_transport() {
        let active_downloads = Arc::new(AtomicUsize::new(0));
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let downloads_for_worker = active_downloads.clone();
        let worker = thread::spawn(move || {
            let _guard = ActiveBackendDownloadGuard::acquire(downloads_for_worker);
            started_tx.send(()).expect("notify worker start");
            release_rx.recv().expect("wait for worker release");
        });
        started_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("worker must hold the download lease");

        let (finished_tx, finished_rx) = std::sync::mpsc::channel();
        let downloads_for_waiter = active_downloads.clone();
        let waiter = thread::spawn(move || {
            wait_for_active_backend_downloads(&downloads_for_waiter, Duration::from_secs(1));
            finished_tx.send(()).expect("notify waiter completion");
        });
        assert!(finished_rx.recv_timeout(Duration::from_millis(50)).is_err());
        release_tx.send(()).expect("release worker");
        finished_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("waiter must proceed after the transport completes");
        worker.join().expect("join worker");
        waiter.join().expect("join waiter");
    }

    #[test]
    fn window_shutdown_download_wait_is_bounded() {
        let active_downloads = AtomicUsize::new(1);
        let started = Instant::now();

        wait_for_active_backend_downloads(&active_downloads, Duration::from_millis(40));

        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn native_download_raw_tcp_integration_captures_complete_response() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind test server");
        let port = listener.local_addr().expect("local address").port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept client");
            let mut request = Vec::new();
            stream.read_to_end(&mut request).expect("read request");
            let request_text = String::from_utf8(request).expect("request UTF-8");
            assert!(request_text.starts_with("GET /api/playlist/export?format=csv HTTP/1.1"));
            stream
                .write_all(&valid_csv_response("HTTP/1.1", b"csv"))
                .expect("write response");
        });

        let request = validate_backend_download_request(&download_request(
            "/api/playlist/export?format=csv",
            None,
            Some("client-1"),
        ))
        .expect("request");
        let raw = request_backend_download(&format!("http://127.0.0.1:{port}"), &request)
            .expect("download response");
        let response = parse_backend_download_response(raw).expect("parse response");
        assert_eq!(
            validate_backend_download_response(&response, &request),
            Ok(ValidatedBackendDownloadResponse {
                filename: "list.csv".to_string(),
                required_extension: "csv",
            })
        );
        server.join().expect("test server");
    }

    #[test]
    fn readiness_marker_is_written_and_flushed() {
        let mut buf = Vec::new();
        write_and_flush_ready_marker(&mut buf, "http://127.0.0.1:5678").unwrap();
        assert_eq!(
            String::from_utf8(buf).unwrap(),
            "Backend ready at http://127.0.0.1:5678\n"
        );
    }

    #[test]
    fn stdout_reader_handles_ready_once_and_drains_until_eof() {
        let input = concat!(
            "ordinary before\n",
            "{malformed ready\n",
            "{\"event\":\"bilikara.ready\",\"host\":\"127.0.0.1\",\"port\":8080,\"baseUrl\":\"http://127.0.0.1:8080\"}\n",
            "ordinary after\n",
            "{\"event\":\"bilikara.ready\",\"host\":\"127.0.0.1\",\"port\":9090,\"baseUrl\":\"http://127.0.0.1:9090\"}\n",
        );
        let mut ready_urls = Vec::new();
        let mut output = Vec::new();
        drain_backend_stdout(
            Cursor::new(input.as_bytes()),
            |ready| ready_urls.push(ready.base_url),
            |line| output.push(line),
        )
        .expect("EOF ends cleanly");

        assert_eq!(ready_urls, ["http://127.0.0.1:8080"]);
        assert_eq!(output[0], "ordinary before");
        assert_eq!(output[1], "{malformed ready");
        assert_eq!(output[2], "ordinary after");
        assert!(
            output[3].contains("9090"),
            "duplicate readiness is still drained"
        );
    }

    #[test]
    fn stdout_reader_keeps_draining_after_desktop_stdout_breaks() {
        struct BrokenPipeWriter {
            writes: usize,
        }

        impl Write for BrokenPipeWriter {
            fn write(&mut self, _buffer: &[u8]) -> io::Result<usize> {
                self.writes += 1;
                Err(io::ErrorKind::BrokenPipe.into())
            }

            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }

        let mut writer = BrokenPipeWriter { writes: 0 };
        let mut drained = Vec::new();

        drain_backend_stdout(
            Cursor::new(b"first\nsecond\n"),
            |_| panic!("unexpected ready marker"),
            |line| {
                forward_backend_stdout_line(&mut writer, &line);
                drained.push(line);
            },
        )
        .expect("backend stdout reaches EOF");

        assert_eq!(writer.writes, 2);
        assert_eq!(drained, ["first", "second"]);
    }

    #[test]
    fn backend_candidate_validation_and_precedence() {
        let temp_dir = std::env::temp_dir().join(format!("bilikara_test_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&temp_dir);
        let dummy_exe = temp_dir.join("current_exe");
        let _ = std::fs::write(&dummy_exe, b"test");
        let canonical_dummy_exe = dummy_exe.canonicalize().unwrap();
        let noncanonical_dummy_exe = temp_dir.join(".").join("current_exe");

        assert!(!is_backend_candidate(&temp_dir, &dummy_exe));
        assert!(!is_backend_candidate(&dummy_exe, &dummy_exe));
        assert!(!is_backend_candidate(
            &canonical_dummy_exe,
            &noncanonical_dummy_exe
        ));
        assert!(!is_backend_candidate(
            &noncanonical_dummy_exe,
            &canonical_dummy_exe
        ));
        assert!(!is_backend_candidate(
            &temp_dir.join("nonexistent"),
            &dummy_exe
        ));

        let non_exec = temp_dir.join("non_exec_binary");
        let _ = std::fs::write(&non_exec, b"binary content");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&non_exec).unwrap().permissions();
            perms.set_mode(0o644);
            let _ = std::fs::set_permissions(&non_exec, perms);
            assert!(!is_backend_candidate(&non_exec, &dummy_exe));
        }

        let exec_bin = temp_dir.join("exec_binary");
        let _ = std::fs::write(&exec_bin, b"binary content");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&exec_bin).unwrap().permissions();
            perms.set_mode(0o755);
            let _ = std::fs::set_permissions(&exec_bin, perms);
            assert!(is_backend_candidate(&exec_bin, &dummy_exe));
        }

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn packaged_macos_resolves_embedded_backend_without_sibling_or_path() {
        let temp_dir = std::env::temp_dir().join(format!(
            "bilikara_embedded_backend_test_{}_{}",
            std::process::id(),
            unix_timestamp_millis()
        ));
        let desktop_exe = temp_dir
            .join("translocated")
            .join("Bilikara-Desktop.app")
            .join("Contents")
            .join("MacOS")
            .join("bilikara");
        let embedded_backend = temp_dir
            .join("translocated")
            .join("Bilikara-Desktop.app")
            .join("Contents")
            .join("Frameworks")
            .join("bilikara-backend.app")
            .join("Contents")
            .join("MacOS")
            .join("bilikara");
        fs::create_dir_all(desktop_exe.parent().expect("desktop parent"))
            .expect("create desktop directory");
        fs::create_dir_all(embedded_backend.parent().expect("backend parent"))
            .expect("create embedded backend directory");
        fs::write(&desktop_exe, b"desktop").expect("write desktop executable");
        fs::write(&embedded_backend, b"backend").expect("write backend executable");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = fs::metadata(&embedded_backend)
                .expect("backend metadata")
                .permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(&embedded_backend, permissions).expect("mark backend executable");
        }

        let resolution = resolve_backend_command_from(
            &desktop_exe,
            desktop_exe.parent().expect("desktop executable directory"),
            true,
        )
        .expect("packaged resolution");
        assert_eq!(resolution.candidate_type, "macos-embedded-backend");
        assert_eq!(PathBuf::from(resolution.command), embedded_backend);
        assert!(resolution.args.is_empty());
        assert!(!temp_dir.join("translocated").join("bilikara.app").exists());

        fs::remove_dir_all(temp_dir).expect("remove embedded backend test directory");
    }

    #[test]
    fn packaged_macos_missing_embedded_backend_never_falls_back_to_python() {
        let temp_dir = std::env::temp_dir().join(format!(
            "bilikara_missing_backend_test_{}_{}",
            std::process::id(),
            unix_timestamp_millis()
        ));
        let desktop_exe = temp_dir
            .join("Bilikara-Desktop.app")
            .join("Contents")
            .join("MacOS")
            .join("bilikara");
        fs::create_dir_all(desktop_exe.parent().expect("desktop parent"))
            .expect("create desktop directory");
        fs::write(&desktop_exe, b"desktop").expect("write desktop executable");
        fs::write(temp_dir.join("start_bilikara.py"), b"print('dev')")
            .expect("write development launcher decoy");

        let missing = resolve_backend_command_from(
            &desktop_exe,
            desktop_exe.parent().expect("desktop executable directory"),
            true,
        )
        .expect_err("missing packaged backend must fail closed");
        assert_eq!(missing.candidate_type, "macos-embedded-backend");
        assert!(!missing.candidate_exists);
        assert!(!missing.candidate_executable);
        assert!(
            missing
                .command_path
                .ends_with("bilikara-backend.app/Contents/MacOS/bilikara")
        );

        fs::remove_dir_all(temp_dir).expect("remove missing backend test directory");
    }

    #[test]
    fn source_tree_resolution_preserves_development_python_launcher() {
        let temp_dir = std::env::temp_dir().join(format!(
            "bilikara_dev_backend_test_{}_{}",
            std::process::id(),
            unix_timestamp_millis()
        ));
        let target_dir = temp_dir.join("src-tauri").join("target").join("release");
        fs::create_dir_all(&target_dir).expect("create source target directory");
        let desktop_exe = target_dir.join("bilikara");
        fs::write(&desktop_exe, b"desktop").expect("write desktop executable");
        let launcher = temp_dir.join("start_bilikara.py");
        fs::write(&launcher, b"print('dev')").expect("write development launcher");

        let resolution = resolve_backend_command_from(&desktop_exe, &target_dir, false)
            .expect("development resolution");
        assert_eq!(resolution.candidate_type, "development-python-script");
        assert_eq!(resolution.command, "python");
        assert_eq!(resolution.args, [launcher.to_string_lossy().to_string()]);

        fs::remove_dir_all(temp_dir).expect("remove development backend test directory");
    }

    #[test]
    fn stdout_forwarding_is_bounded_and_redacts_sensitive_lines() {
        for line in [
            "Cookie: private",
            "Authorization: Bearer private",
            "SESSDATA=private",
            "csrf=private",
            "qrcode_key=private",
            "access_token=private",
            "secret=private",
            "request https://example.invalid/path?token=private",
        ] {
            assert_eq!(
                sanitized_backend_stdout_line(line),
                "[redacted sensitive backend output]"
            );
        }
        let long_line = "x".repeat(MAX_BACKEND_OUTPUT_CHARS + 100);
        let sanitized = sanitized_backend_stdout_line(&long_line);
        assert_eq!(sanitized.chars().count(), MAX_BACKEND_OUTPUT_CHARS + 1);
        assert!(sanitized.ends_with('…'));
    }

    #[test]
    fn backend_output_tail_keeps_only_recent_bounded_lines() {
        let mut tail = BoundedOutputTail::default();
        for index in 0..(MAX_BACKEND_TAIL_LINES + 5) {
            tail.push(format!("line-{index}"));
        }
        let snapshot = tail.snapshot();
        assert_eq!(snapshot.len(), MAX_BACKEND_TAIL_LINES);
        assert_eq!(snapshot.first().map(String::as_str), Some("line-5"));
        assert_eq!(
            snapshot.last().map(String::as_str),
            Some(format!("line-{}", MAX_BACKEND_TAIL_LINES + 4).as_str())
        );
    }

    #[test]
    fn desktop_startup_log_is_persistent_bounded_and_control_safe() {
        let temp_dir = std::env::temp_dir().join(format!(
            "bilikara_desktop_log_test_{}_{}",
            std::process::id(),
            unix_timestamp_millis()
        ));
        let log_path = temp_dir.join(DESKTOP_STARTUP_LOG_NAME);
        fs::create_dir_all(&temp_dir).expect("create temp log directory");
        fs::write(
            &log_path,
            vec![b'x'; MAX_DESKTOP_STARTUP_LOG_BYTES as usize + 1],
        )
        .expect("write oversized prior log");

        let log = DesktopStartupLog::open(log_path.clone()).expect("open startup log");
        log.append("desktop_start", "cwd=/tmp/control\nsecond-line");
        let contents = fs::read_to_string(&log_path).expect("read startup log");
        assert!(contents.contains("event=desktop_start"));
        assert!(contents.contains("cwd=/tmp/controlsecond-line"));
        assert!(contents.len() < MAX_DESKTOP_STARTUP_LOG_BYTES as usize);

        fs::remove_dir_all(temp_dir).expect("remove temp log directory");
    }
}
