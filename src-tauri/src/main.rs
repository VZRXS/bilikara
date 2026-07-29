#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use serde::Deserialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

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

#[derive(Deserialize, Debug)]
struct ReadyEvent {
    #[allow(dead_code)]
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

fn resolve_backend_command() -> (String, Vec<String>) {
    let current_exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("."));
    let current_exe = current_exe.canonicalize().unwrap_or(current_exe);
    #[allow(unused_mut)]
    let mut current_dir = current_exe
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."));

    // On macOS, the executable is inside Contents/MacOS/, so we go up 3 levels to get next to the .app bundle
    #[cfg(target_os = "macos")]
    {
        if current_dir.ends_with("MacOS") {
            current_dir = current_dir
                .parent()
                .unwrap_or(current_dir)
                .parent()
                .unwrap_or(current_dir)
                .parent()
                .unwrap_or(current_dir);
        }
    }

    // Windows packaged path
    let win_path = current_dir.join("bilikara").join("bilikara.exe");
    if is_backend_candidate(&win_path, &current_exe) {
        return (win_path.to_string_lossy().to_string(), vec![]);
    }

    let win_path2 = current_dir.join("bilikara.exe");
    if is_backend_candidate(&win_path2, &current_exe) {
        return (win_path2.to_string_lossy().to_string(), vec![]);
    }

    // macOS packaged path
    let mac_path = current_dir
        .join("bilikara.app")
        .join("Contents")
        .join("MacOS")
        .join("bilikara");
    if is_backend_candidate(&mac_path, &current_exe) {
        return (mac_path.to_string_lossy().to_string(), vec![]);
    }

    if let Some(script_path) = find_dev_launcher(current_dir) {
        return (
            "python".to_string(),
            vec![script_path.to_string_lossy().to_string()],
        );
    }

    // Default to Python script for development
    ("python".to_string(), vec!["start_bilikara.py".to_string()])
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
    if !path.exists() {
        return false;
    }
    let candidate = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    candidate != current_exe
}

fn current_executable_string() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.canonicalize().ok().or(Some(path)))
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_default()
}

fn make_shutdown_token() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("{}-{}", std::process::id(), nanos)
}

fn parse_local_http_url(base_url: &str) -> Option<(&str, u16)> {
    let rest = base_url.strip_prefix("http://")?;
    let authority = rest.split('/').next()?;
    let (host, port_text) = authority.rsplit_once(':')?;
    let port = port_text.parse::<u16>().ok()?;
    Some((host, port))
}

fn validate_backend_download_request(
    request: &SaveBackendDownloadRequest,
) -> Result<(&'static str, String), String> {
    if request.path.len() > 4096
        || request
            .path
            .chars()
            .any(|character| character.is_ascii_control() || character.is_ascii_whitespace())
    {
        return Err("导出请求路径无效".to_string());
    }
    if request
        .client_id
        .as_deref()
        .is_some_and(|value| value.contains('\r') || value.contains('\n') || value.len() > 256)
    {
        return Err("导出客户端标识无效".to_string());
    }

    if request.path.starts_with("/api/playlist/export?") {
        if request.body.as_deref().is_some_and(|body| !body.is_empty()) {
            return Err("歌单导出不接受请求体".to_string());
        }
        return Ok(("GET", String::new()));
    }
    if request.path == "/api/diagnostics/package" {
        let body = request.body.clone().unwrap_or_else(|| "{}".to_string());
        if body.len() > 64 * 1024 {
            return Err("诊断请求体过大".to_string());
        }
        return Ok(("POST", body));
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
    let mut lines = header_text.split("\r\n");
    let status = lines
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| "后端返回了无效的 HTTP 状态".to_string())?;
    let mut headers = Vec::new();
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            return Err("后端返回了无效的 HTTP 响应头".to_string());
        };
        headers.push((name.trim().to_ascii_lowercase(), value.trim().to_string()));
    }
    let body = raw[(header_end + 4)..].to_vec();
    if let Some(expected_length) = headers
        .iter()
        .find(|(name, _)| name == "content-length")
        .and_then(|(_, value)| value.parse::<usize>().ok())
        && body.len() != expected_length
    {
        return Err(format!(
            "导出文件接收不完整：预期 {expected_length} 字节，实际 {} 字节",
            body.len()
        ));
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
    let safe = safe.trim_matches('-');
    if safe.is_empty() {
        fallback.to_string()
    } else {
        safe.to_string()
    }
}

fn request_backend_download(
    base_url: &str,
    request: &SaveBackendDownloadRequest,
) -> Result<BackendDownloadResponse, String> {
    let Some((host, port)) = parse_local_http_url(base_url) else {
        return Err("本机后端地址无效".to_string());
    };
    let (method, body) = validate_backend_download_request(request)?;
    let connect_host = host.trim_matches(|character| character == '[' || character == ']');
    let mut stream = TcpStream::connect((connect_host, port))
        .map_err(|error| format!("无法连接本机后端：{error}"))?;
    stream
        .set_write_timeout(Some(Duration::from_secs(10)))
        .map_err(|error| format!("无法设置导出写入超时：{error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(180)))
        .map_err(|error| format!("无法设置导出读取超时：{error}"))?;

    let mut request_text = format!(
        "{method} {} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n",
        request.path
    );
    if let Some(client_id) = request
        .client_id
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        request_text.push_str(&format!("X-Bilikara-Client: {client_id}\r\n"));
    }
    if method == "POST" {
        request_text.push_str("Content-Type: application/json\r\n");
    }
    request_text.push_str(&format!("Content-Length: {}\r\n\r\n", body.len()));
    request_text.push_str(&body);
    stream
        .write_all(request_text.as_bytes())
        .map_err(|error| format!("发送导出请求失败：{error}"))?;
    let _ = stream.shutdown(Shutdown::Write);

    let mut raw_response = Vec::new();
    stream
        .read_to_end(&mut raw_response)
        .map_err(|error| format!("接收导出文件失败：{error}"))?;
    let response = parse_backend_download_response(raw_response)?;
    if !(200..300).contains(&response.status) {
        return Err(backend_error_message(&response));
    }
    Ok(response)
}

#[tauri::command]
async fn save_backend_download(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, BackendProcess>,
    request: SaveBackendDownloadRequest,
) -> Result<bool, String> {
    let base_url = state
        .base_url
        .lock()
        .map_err(|_| "无法读取本机后端地址".to_string())?
        .clone()
        .ok_or_else(|| "本机后端尚未就绪".to_string())?;
    let backend_origin = base_url.trim_end_matches('/');
    let backend_prefix = format!("{backend_origin}/");
    let window_url = window
        .url()
        .map_err(|error| format!("无法读取当前页面地址：{error}"))?;
    if window_url.as_str() != backend_origin && !window_url.as_str().starts_with(&backend_prefix) {
        return Err("当前页面无权调用本机导出".to_string());
    }
    let response = request_backend_download(&base_url, &request)?;
    let fallback = if request.path == "/api/diagnostics/package" {
        "bilikara-diagnostics.zip"
    } else if request.path.contains("format=image") {
        "bilikara-playlist.png"
    } else {
        "bilikara-playlist.csv"
    };
    let filename = safe_download_filename(
        backend_response_header(&response, "content-disposition").unwrap_or_default(),
        fallback,
    );
    let mut dialog = window
        .dialog()
        .file()
        .set_title("保存导出文件")
        .set_file_name(filename.clone());
    if let Some(extension) = Path::new(&filename)
        .extension()
        .and_then(|value| value.to_str())
    {
        dialog = dialog.add_filter("导出文件", &[extension]);
    }
    let Some(file_path) = dialog.blocking_save_file() else {
        return Ok(false);
    };
    let target_path = file_path
        .into_path()
        .map_err(|error| format!("无法使用所选保存路径：{error}"))?;
    std::fs::write(&target_path, response.body)
        .map_err(|error| format!("写入导出文件失败：{error}"))?;
    Ok(true)
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
    let Some((host, port)) = parse_local_http_url(base_url) else {
        return false;
    };
    let Ok(mut stream) = TcpStream::connect((host.trim_matches(|c| c == '[' || c == ']'), port))
    else {
        return false;
    };
    let _ = stream.set_write_timeout(Some(Duration::from_secs(1)));
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let request = format!(
        "POST /api/app/shutdown HTTP/1.1\r\nHost: {}:{}\r\nContent-Length: 2\r\nContent-Type: application/json\r\nX-Bilikara-Shutdown-Token: {}\r\nConnection: close\r\n\r\n{}",
        host, port, shutdown_token, "{}"
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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(StageSessionState::default())
        .invoke_handler(tauri::generate_handler![
            set_window_fullscreen,
            save_backend_download,
            get_stage_display_info,
            open_stage_window,
            close_stage_window
        ])
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();

            let (cmd, mut args) = resolve_backend_command();
            args.extend(vec![
                "--no-browser".to_string(),
                "--headless".to_string(),
                "--port".to_string(),
                "0".to_string(),
            ]);

            let shutdown_token = make_shutdown_token();
            let desktop_executable = current_executable_string();

            let mut command = Command::new(&cmd);
            command
                .args(args)
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

            let mut child = command.spawn()?;

            let stdout = child.stdout.take().unwrap();
            let stderr = child.stderr.take();
            let window_clone = window.clone();
            let child_arc = Arc::new(Mutex::new(Some(child)));
            let base_url = Arc::new(Mutex::new(None));
            let base_url_for_reader = base_url.clone();

            app.manage(BackendProcess {
                child: child_arc.clone(),
                base_url: base_url.clone(),
                shutdown_token: shutdown_token.clone(),
            });

            let app_handle = app.handle().clone();
            let child_for_monitor = child_arc.clone();
            std::thread::spawn(move || {
                loop {
                    std::thread::sleep(Duration::from_millis(500));
                    let should_exit = match child_for_monitor.lock() {
                        Ok(mut child_lock) => {
                            if let Some(child) = child_lock.as_mut() {
                                match child.try_wait() {
                                    Ok(Some(_)) | Err(_) => {
                                        *child_lock = None;
                                        true
                                    }
                                    Ok(None) => false,
                                }
                            } else {
                                false
                            }
                        }
                        Err(_) => true,
                    };
                    if should_exit {
                        app_handle.exit(0);
                        break;
                    }
                }
            });

            if let Some(stderr) = stderr {
                std::thread::spawn(move || {
                    let reader = BufReader::new(stderr);
                    #[allow(clippy::manual_flatten)]
                    for line in reader.lines() {
                        if let Ok(line) = line {
                            eprintln!("Backend stderr: {}", line);
                        }
                    }
                });
            }

            std::thread::spawn(move || {
                let reader = BufReader::new(stdout);
                for line in reader.lines() {
                    let line = line.unwrap_or_default();
                    if line.contains("\"event\": \"bilikara.ready\"")
                        && let Ok(ready) = serde_json::from_str::<ReadyEvent>(&line)
                    {
                        println!("Backend ready at {}", ready.base_url);
                        if let Ok(mut stored_url) = base_url_for_reader.lock() {
                            *stored_url = Some(ready.base_url.clone());
                        }
                        if let Err(error) = window_clone.show() {
                            eprintln!("Failed to show window: {}", error);
                        }
                        let _ = window_clone.set_always_on_top(true);
                        let _ = window_clone.set_always_on_top(false);
                        let _ = window_clone.set_focus();
                        if let Err(error) = window_clone
                            .eval(format!("window.location.replace('{}');", ready.base_url))
                        {
                            eprintln!("Failed to navigate to backend: {}", error);
                        }
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn download_request(path: &str, body: Option<&str>) -> SaveBackendDownloadRequest {
        SaveBackendDownloadRequest {
            path: path.to_string(),
            body: body.map(str::to_string),
            client_id: Some("client-1".to_string()),
        }
    }

    #[test]
    fn native_download_request_allows_only_export_endpoints() {
        assert_eq!(
            validate_backend_download_request(&download_request(
                "/api/playlist/export?format=csv&source=played",
                None,
            )),
            Ok(("GET", String::new()))
        );
        assert_eq!(
            validate_backend_download_request(&download_request(
                "/api/diagnostics/package",
                Some("{}"),
            )),
            Ok(("POST", "{}".to_string()))
        );
        assert!(validate_backend_download_request(&download_request("/api/state", None)).is_err());
        assert!(
            validate_backend_download_request(&download_request(
                "/api/playlist/export?format=csv HTTP/1.1",
                None,
            ))
            .is_err()
        );
    }

    #[test]
    fn native_download_response_requires_complete_body() {
        let response = parse_backend_download_response(
            b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nContent-Disposition: attachment; filename=\"list.csv\"\r\n\r\ncsv"
                .to_vec(),
        )
        .expect("valid response");
        assert_eq!(response.status, 200);
        assert_eq!(response.body, b"csv");
        assert_eq!(
            backend_response_header(&response, "content-disposition"),
            Some("attachment; filename=\"list.csv\"")
        );

        let incomplete = parse_backend_download_response(
            b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\ncsv".to_vec(),
        );
        assert!(incomplete.is_err());
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
            "..-unsafe-name.zip"
        );
    }
}
