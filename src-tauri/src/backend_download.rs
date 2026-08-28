use crate::backend_process::{
    BackendAddress, BackendProcess, parse_local_http_url, window_origin_authorized,
};
use serde::{Deserialize, Serialize};
use std::io::{self, Read, Write};
use std::net::{Shutdown, TcpStream};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri_plugin_dialog::DialogExt;

const MAX_BACKEND_DOWNLOAD_BYTES: usize = 512 * 1024 * 1024;
const MAX_BACKEND_RESPONSE_BYTES: u64 = (MAX_BACKEND_DOWNLOAD_BYTES + 64 * 1024) as u64;

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveBackendDownloadRequest {
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
pub(crate) struct SaveBackendDownloadResult {
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
pub(crate) async fn save_backend_download(
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
    let base_url = match state.backend_url() {
        Ok(Some(url)) => url,
        Ok(None) => {
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
        Err(()) => {
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
    let active_download_guard = state.begin_download();

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

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};

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
}
