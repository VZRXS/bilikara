use reqwest::blocking::{Client, Response};
use reqwest::header::{ACCEPT_ENCODING, HeaderMap, HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

const DOWNLOAD_SCHEMA_VERSION: u32 = 1;
const MAX_CANDIDATES: usize = 64;
const MAX_HEADERS: usize = 64;
const MAX_HEADER_VALUE_BYTES: usize = 16 * 1024;
const MAX_ATTEMPTS_PER_CANDIDATE: u32 = 5;
const MAX_TIMEOUT_MS: u64 = 24 * 60 * 60 * 1000;
const COPY_BUFFER_BYTES: usize = 64 * 1024;
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn default_connect_timeout_ms() -> u64 {
    15_000
}

fn default_request_timeout_ms() -> u64 {
    30 * 60 * 1000
}

fn default_attempts_per_candidate() -> u32 {
    1
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct HttpHeader {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DownloadCandidate {
    pub url: String,
    #[serde(default)]
    pub headers: Vec<HttpHeader>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DownloadRequest {
    pub schema_version: u32,
    pub candidates: Vec<DownloadCandidate>,
    pub destination: PathBuf,
    #[serde(default = "default_connect_timeout_ms")]
    pub connect_timeout_ms: u64,
    #[serde(default = "default_request_timeout_ms")]
    pub request_timeout_ms: u64,
    #[serde(default = "default_attempts_per_candidate")]
    pub attempts_per_candidate: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DownloadErrorKind {
    InvalidRequest,
    DestinationExists,
    Network,
    HttpStatus,
    Io,
    LengthMismatch,
    EmptyBody,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DownloadError {
    pub kind: DownloadErrorKind,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidate_index: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u16>,
}

impl DownloadError {
    fn new(kind: DownloadErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            candidate_index: None,
            http_status: None,
        }
    }

    fn for_candidate(mut self, candidate_index: usize) -> Self {
        self.candidate_index = Some(candidate_index);
        self
    }
}

impl std::fmt::Display for DownloadError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for DownloadError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DownloadProgress {
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DownloadResult {
    pub destination: PathBuf,
    pub bytes_written: u64,
    pub content_length: Option<u64>,
    pub candidate_index: usize,
    pub attempt: u32,
}

pub fn download_to_path<F>(
    request: &DownloadRequest,
    mut continue_download: F,
) -> Result<DownloadResult, DownloadError>
where
    F: FnMut(DownloadProgress) -> bool,
{
    validate_request(request)?;
    if request.destination.exists() {
        return Err(DownloadError::new(
            DownloadErrorKind::DestinationExists,
            "download destination already exists",
        ));
    }

    let client = Client::builder()
        .connect_timeout(Duration::from_millis(request.connect_timeout_ms))
        .timeout(Duration::from_millis(request.request_timeout_ms))
        .build()
        .map_err(|_| {
            DownloadError::new(
                DownloadErrorKind::Network,
                "failed to initialize HTTP client",
            )
        })?;

    let mut last_error =
        DownloadError::new(DownloadErrorKind::Network, "all download candidates failed");
    for (candidate_index, candidate) in request.candidates.iter().enumerate() {
        let headers = candidate_headers(candidate).map_err(|error| {
            DownloadError::new(DownloadErrorKind::InvalidRequest, error)
                .for_candidate(candidate_index)
        })?;
        for attempt in 1..=request.attempts_per_candidate {
            if !continue_download(DownloadProgress {
                downloaded_bytes: 0,
                total_bytes: None,
            }) {
                return Err(
                    DownloadError::new(DownloadErrorKind::Cancelled, "download cancelled")
                        .for_candidate(candidate_index),
                );
            }

            match download_candidate(
                &client,
                candidate,
                headers.clone(),
                &request.destination,
                candidate_index,
                attempt,
                &mut continue_download,
            ) {
                Ok(result) => return Ok(result),
                Err(error) if error.kind == DownloadErrorKind::Cancelled => return Err(error),
                Err(error) => last_error = error,
            }
        }
    }
    Err(last_error)
}

fn validate_request(request: &DownloadRequest) -> Result<(), DownloadError> {
    if request.schema_version != DOWNLOAD_SCHEMA_VERSION {
        return Err(DownloadError::new(
            DownloadErrorKind::InvalidRequest,
            "unsupported download request schema",
        ));
    }
    if request.candidates.is_empty() || request.candidates.len() > MAX_CANDIDATES {
        return Err(DownloadError::new(
            DownloadErrorKind::InvalidRequest,
            "download request must contain between 1 and 64 candidates",
        ));
    }
    if !request.destination.is_absolute() || request.destination.file_name().is_none() {
        return Err(DownloadError::new(
            DownloadErrorKind::InvalidRequest,
            "download destination must be an absolute file path",
        ));
    }
    let Some(parent) = request.destination.parent() else {
        return Err(DownloadError::new(
            DownloadErrorKind::InvalidRequest,
            "download destination has no parent directory",
        ));
    };
    if !parent.is_dir() {
        return Err(DownloadError::new(
            DownloadErrorKind::InvalidRequest,
            "download destination parent does not exist",
        ));
    }
    if request.connect_timeout_ms == 0
        || request.connect_timeout_ms > MAX_TIMEOUT_MS
        || request.request_timeout_ms == 0
        || request.request_timeout_ms > MAX_TIMEOUT_MS
    {
        return Err(DownloadError::new(
            DownloadErrorKind::InvalidRequest,
            "download timeout is outside the supported range",
        ));
    }
    if request.attempts_per_candidate == 0
        || request.attempts_per_candidate > MAX_ATTEMPTS_PER_CANDIDATE
    {
        return Err(DownloadError::new(
            DownloadErrorKind::InvalidRequest,
            "attempts_per_candidate must be between 1 and 5",
        ));
    }

    for candidate in &request.candidates {
        let parsed = reqwest::Url::parse(candidate.url.trim()).map_err(|_| {
            DownloadError::new(DownloadErrorKind::InvalidRequest, "invalid candidate URL")
        })?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err(DownloadError::new(
                DownloadErrorKind::InvalidRequest,
                "candidate URL must use HTTP or HTTPS",
            ));
        }
        if candidate.headers.len() > MAX_HEADERS {
            return Err(DownloadError::new(
                DownloadErrorKind::InvalidRequest,
                "candidate contains too many headers",
            ));
        }
    }
    Ok(())
}

fn candidate_headers(candidate: &DownloadCandidate) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();
    for header in &candidate.headers {
        if header.value.len() > MAX_HEADER_VALUE_BYTES {
            return Err("candidate header value is too large".to_string());
        }
        let name = HeaderName::from_bytes(header.name.trim().as_bytes())
            .map_err(|_| "candidate header name is invalid".to_string())?;
        let value = HeaderValue::from_str(&header.value)
            .map_err(|_| "candidate header value is invalid".to_string())?;
        headers.append(name, value);
    }
    if !headers.contains_key(ACCEPT_ENCODING) {
        headers.insert(ACCEPT_ENCODING, HeaderValue::from_static("identity"));
    }
    Ok(headers)
}

fn download_candidate<F>(
    client: &Client,
    candidate: &DownloadCandidate,
    headers: HeaderMap,
    destination: &Path,
    candidate_index: usize,
    attempt: u32,
    continue_download: &mut F,
) -> Result<DownloadResult, DownloadError>
where
    F: FnMut(DownloadProgress) -> bool,
{
    let response = client
        .get(candidate.url.trim())
        .headers(headers)
        .send()
        .map_err(|_| {
            DownloadError::new(DownloadErrorKind::Network, "HTTP request failed")
                .for_candidate(candidate_index)
        })?;
    let status = response.status();
    if !status.is_success() {
        let mut error = DownloadError::new(
            DownloadErrorKind::HttpStatus,
            format!("HTTP request returned status {}", status.as_u16()),
        )
        .for_candidate(candidate_index);
        error.http_status = Some(status.as_u16());
        return Err(error);
    }

    let temp_path = temporary_path(destination);
    let result = stream_response(
        response,
        &temp_path,
        destination,
        candidate_index,
        attempt,
        continue_download,
    );
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

fn stream_response<F>(
    mut response: Response,
    temp_path: &Path,
    destination: &Path,
    candidate_index: usize,
    attempt: u32,
    continue_download: &mut F,
) -> Result<DownloadResult, DownloadError>
where
    F: FnMut(DownloadProgress) -> bool,
{
    let content_length = response.content_length();
    let mut output = create_temp_file(temp_path, candidate_index)?;
    let mut buffer = vec![0_u8; COPY_BUFFER_BYTES];
    let mut downloaded_bytes = 0_u64;

    loop {
        let count = response.read(&mut buffer).map_err(|_| {
            DownloadError::new(DownloadErrorKind::Network, "HTTP response body failed")
                .for_candidate(candidate_index)
        })?;
        if count == 0 {
            break;
        }
        output.write_all(&buffer[..count]).map_err(|_| {
            DownloadError::new(DownloadErrorKind::Io, "failed to write temporary download")
                .for_candidate(candidate_index)
        })?;
        downloaded_bytes = downloaded_bytes.saturating_add(count as u64);
        if !continue_download(DownloadProgress {
            downloaded_bytes,
            total_bytes: content_length,
        }) {
            return Err(
                DownloadError::new(DownloadErrorKind::Cancelled, "download cancelled")
                    .for_candidate(candidate_index),
            );
        }
    }

    if downloaded_bytes == 0 {
        return Err(DownloadError::new(
            DownloadErrorKind::EmptyBody,
            "HTTP response body was empty",
        )
        .for_candidate(candidate_index));
    }
    if let Some(expected) = content_length
        && downloaded_bytes != expected
    {
        return Err(DownloadError::new(
            DownloadErrorKind::LengthMismatch,
            "HTTP response length did not match Content-Length",
        )
        .for_candidate(candidate_index));
    }
    output.sync_all().map_err(|_| {
        DownloadError::new(DownloadErrorKind::Io, "failed to flush temporary download")
            .for_candidate(candidate_index)
    })?;
    drop(output);
    fs::hard_link(temp_path, destination).map_err(|_| {
        let (kind, message) = if destination.exists() {
            (
                DownloadErrorKind::DestinationExists,
                "download destination appeared during transfer",
            )
        } else {
            (
                DownloadErrorKind::Io,
                "failed to publish completed download",
            )
        };
        DownloadError::new(kind, message).for_candidate(candidate_index)
    })?;
    let _ = fs::remove_file(temp_path);

    Ok(DownloadResult {
        destination: destination.to_path_buf(),
        bytes_written: downloaded_bytes,
        content_length,
        candidate_index,
        attempt,
    })
}

fn create_temp_file(path: &Path, candidate_index: usize) -> Result<File, DownloadError> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| {
            DownloadError::new(DownloadErrorKind::Io, "failed to create temporary download")
                .for_candidate(candidate_index)
        })
}

fn temporary_path(destination: &Path) -> PathBuf {
    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let name = destination
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("download");
    destination.with_file_name(format!(".{name}.{}.{}.part", std::process::id(), sequence))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};
    use std::thread;

    fn test_dir(label: &str) -> PathBuf {
        let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-output")
            .join(format!("{label}-{}-{sequence}", std::process::id()));
        fs::create_dir_all(&path).expect("create test directory");
        path
    }

    fn serve(
        responses: Vec<&'static str>,
    ) -> (String, Arc<Mutex<Vec<String>>>, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let address = listener.local_addr().expect("test server address");
        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&requests);
        let handle = thread::spawn(move || {
            for response in responses {
                let (mut stream, _) = listener.accept().expect("accept test request");
                let mut request = vec![0_u8; 16 * 1024];
                let count = stream.read(&mut request).expect("read test request");
                captured
                    .lock()
                    .expect("capture request")
                    .push(String::from_utf8_lossy(&request[..count]).into_owned());
                stream
                    .write_all(response.as_bytes())
                    .expect("write response");
            }
        });
        (format!("http://{address}"), requests, handle)
    }

    fn request(destination: PathBuf, candidates: Vec<DownloadCandidate>) -> DownloadRequest {
        DownloadRequest {
            schema_version: 1,
            candidates,
            destination,
            connect_timeout_ms: 2_000,
            request_timeout_ms: 5_000,
            attempts_per_candidate: 1,
        }
    }

    fn candidate(url: String) -> DownloadCandidate {
        DownloadCandidate {
            url,
            headers: Vec::new(),
        }
    }

    #[test]
    fn falls_back_to_the_next_candidate_and_publishes_atomically() {
        let (base, _, server) = serve(vec![
            "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            "HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nvideo",
        ]);
        let root = test_dir("fallback");
        let destination = root.join("track.m4s");
        let result = download_to_path(
            &request(
                destination.clone(),
                vec![
                    candidate(format!("{base}/primary")),
                    candidate(format!("{base}/backup")),
                ],
            ),
            |_| true,
        )
        .expect("fallback download succeeds");
        server.join().expect("server joins");

        assert_eq!(result.candidate_index, 1);
        assert_eq!(result.bytes_written, 5);
        assert_eq!(fs::read(&destination).expect("read output"), b"video");
        assert_eq!(fs::read_dir(&root).expect("read output dir").count(), 1);
        fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn sends_headers_without_exposing_them_in_results() {
        let (base, requests, server) = serve(vec![
            "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
        ]);
        let root = test_dir("headers");
        let destination = root.join("track.m4s");
        let mut input = candidate(format!("{base}/media"));
        input.headers.push(HttpHeader {
            name: "Cookie".to_string(),
            value: "SESSDATA=secret".to_string(),
        });
        download_to_path(&request(destination, vec![input]), |_| true).expect("download succeeds");
        server.join().expect("server joins");

        let request_text = &requests.lock().expect("request capture")[0];
        assert!(request_text.contains("cookie: SESSDATA=secret"));
        assert!(request_text.contains("accept-encoding: identity"));
        fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn cancellation_and_truncated_bodies_leave_no_output() {
        let (cancel_base, _, cancel_server) = serve(vec![
            "HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nvideo",
        ]);
        let cancel_root = test_dir("cancel");
        let cancel_destination = cancel_root.join("track.m4s");
        let error = download_to_path(
            &request(cancel_destination.clone(), vec![candidate(cancel_base)]),
            |progress| progress.downloaded_bytes == 0,
        )
        .expect_err("download is cancelled");
        cancel_server.join().expect("server joins");
        assert_eq!(error.kind, DownloadErrorKind::Cancelled);
        assert!(!cancel_destination.exists());
        assert_eq!(
            fs::read_dir(&cancel_root).expect("read cancel dir").count(),
            0
        );
        fs::remove_dir_all(cancel_root).expect("remove test directory");

        let (short_base, _, short_server) = serve(vec![
            "HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\nshort",
        ]);
        let short_root = test_dir("short");
        let short_destination = short_root.join("track.m4s");
        let error = download_to_path(
            &request(short_destination.clone(), vec![candidate(short_base)]),
            |_| true,
        )
        .expect_err("truncated response fails");
        short_server.join().expect("server joins");
        assert!(matches!(
            error.kind,
            DownloadErrorKind::Network | DownloadErrorKind::LengthMismatch
        ));
        assert!(!short_destination.exists());
        assert_eq!(
            fs::read_dir(&short_root).expect("read short dir").count(),
            0
        );
        fs::remove_dir_all(short_root).expect("remove test directory");
    }

    #[test]
    fn refuses_to_replace_an_existing_destination() {
        let root = test_dir("existing");
        let destination = root.join("track.m4s");
        fs::write(&destination, b"keep").expect("write existing output");
        let error = download_to_path(
            &request(
                destination.clone(),
                vec![candidate("https://example.invalid/media".to_string())],
            ),
            |_| true,
        )
        .expect_err("existing output is rejected");
        assert_eq!(error.kind, DownloadErrorKind::DestinationExists);
        assert_eq!(
            fs::read(destination).expect("read existing output"),
            b"keep"
        );
        fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn refuses_to_replace_a_destination_created_during_transfer() {
        let (base, _, server) = serve(vec![
            "HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nvideo",
        ]);
        let root = test_dir("destination-race");
        let destination = root.join("track.m4s");
        let raced_destination = destination.clone();
        let error = download_to_path(
            &request(destination.clone(), vec![candidate(base)]),
            move |progress| {
                if progress.downloaded_bytes > 0 && !raced_destination.exists() {
                    fs::write(&raced_destination, b"keep").expect("create raced output");
                }
                true
            },
        )
        .expect_err("raced output is rejected");
        server.join().expect("server joins");

        assert_eq!(error.kind, DownloadErrorKind::DestinationExists);
        assert_eq!(fs::read(&destination).expect("read raced output"), b"keep");
        assert_eq!(fs::read_dir(&root).expect("read output dir").count(), 1);
        fs::remove_dir_all(root).expect("remove test directory");
    }
}
