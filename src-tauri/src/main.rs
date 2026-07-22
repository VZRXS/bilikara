#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use serde::Deserialize;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

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
        .invoke_handler(tauri::generate_handler![
            set_window_fullscreen,
            save_backend_download
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
                        break;
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event
                && let Some(state) = window.try_state::<BackendProcess>()
            {
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
                    if shutdown_requested
                        && wait_for_child_exit(&mut child, Duration::from_secs(20))
                    {
                        return;
                    }
                    let _ = child.kill();
                    let _ = child.wait();
                }
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
