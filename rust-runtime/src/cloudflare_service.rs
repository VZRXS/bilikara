use reqwest::Method;
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::sync::OnceLock;
use std::sync::mpsc::{SyncSender, TrySendError, sync_channel};
use std::thread;
use std::time::Duration;

const MAX_PENDING_APPENDS: usize = 64;

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum CloudflareOperation {
    Request {
        method: String,
        path: String,
        #[serde(default)]
        payload: Option<Value>,
        #[serde(default)]
        authorization: String,
    },
    Append {
        #[serde(default)]
        entries: Vec<Value>,
    },
    EnqueueAppend {
        #[serde(default)]
        entries: Vec<Value>,
    },
}

#[derive(Clone, Debug, Deserialize)]
pub struct CloudflareServiceRequest {
    #[serde(default = "schema_version")]
    pub schema_version: u32,
    pub base_url: String,
    #[serde(default = "default_user_agent")]
    pub user_agent: String,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
    #[serde(flatten)]
    pub operation: CloudflareOperation,
}

#[derive(Clone, Debug, Serialize)]
pub struct CloudflareServiceError {
    pub kind: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_code: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body_preview: Option<String>,
}

#[derive(Clone)]
struct AppendJob {
    base_url: String,
    user_agent: String,
    timeout_ms: u64,
    records: Vec<Value>,
}

static APPEND_QUEUE: OnceLock<Option<SyncSender<AppendJob>>> = OnceLock::new();

pub fn execute_cloudflare(
    request: &CloudflareServiceRequest,
) -> Result<Value, CloudflareServiceError> {
    if request.schema_version != 1 {
        return Err(failure("invalid_request", "unsupported schema version"));
    }
    validate_base_url(&request.base_url)?;
    match &request.operation {
        CloudflareOperation::Request {
            method,
            path,
            payload,
            authorization,
        } => request_json(
            &request.base_url,
            &request.user_agent,
            request.timeout_ms,
            method,
            path,
            payload.as_ref(),
            authorization,
        )
        .map(|payload| json!({"payload": payload})),
        CloudflareOperation::Append { entries } => append_entries(
            &request.base_url,
            &request.user_agent,
            request.timeout_ms,
            entries,
        ),
        CloudflareOperation::EnqueueAppend { entries } => {
            let records = normalize_entries(entries);
            if records.is_empty() {
                return Ok(json!({"accepted": false, "count": 0}));
            }
            let count = records.len();
            let job = AppendJob {
                base_url: request.base_url.trim_end_matches('/').to_owned(),
                user_agent: request.user_agent.clone(),
                timeout_ms: request.timeout_ms,
                records,
            };
            let sender = append_sender().as_ref().ok_or_else(|| {
                failure(
                    "queue_unavailable",
                    "Cloudflare append worker is unavailable",
                )
            })?;
            match sender.try_send(job) {
                Ok(()) => Ok(json!({"accepted": true, "count": count})),
                Err(TrySendError::Full(_)) => Ok(json!({
                    "accepted": false,
                    "count": count,
                    "reason": "queue_full",
                })),
                Err(TrySendError::Disconnected(_)) => Err(failure(
                    "queue_unavailable",
                    "Cloudflare append worker is unavailable",
                )),
            }
        }
    }
}

fn append_sender() -> &'static Option<SyncSender<AppendJob>> {
    APPEND_QUEUE.get_or_init(|| {
        let (sender, receiver) = sync_channel::<AppendJob>(MAX_PENDING_APPENDS);
        let worker = thread::Builder::new()
            .name("cloudflare-pool-append".to_owned())
            .spawn(move || {
                while let Ok(job) = receiver.recv() {
                    if let Err(error) = request_json(
                        &job.base_url,
                        &job.user_agent,
                        job.timeout_ms,
                        "POST",
                        "/batch-add",
                        Some(&json!({"records": job.records})),
                        "",
                    ) {
                        eprintln!(
                            "[bilikara:cloudflare] background append failed: {}",
                            error.message
                        );
                    }
                }
            });
        worker.ok().map(|_| sender)
    })
}

fn append_entries(
    base_url: &str,
    user_agent: &str,
    timeout_ms: u64,
    entries: &[Value],
) -> Result<Value, CloudflareServiceError> {
    let records = normalize_entries(entries);
    if records.is_empty() {
        return Ok(json!({"attempted": 0, "added": 0}));
    }
    let attempted = records.len();
    let payload = request_json(
        base_url,
        user_agent,
        timeout_ms,
        "POST",
        "/batch-add",
        Some(&json!({"records": records})),
        "",
    )?;
    let mut result = payload.as_object().cloned().unwrap_or_default();
    result
        .entry("attempted".to_owned())
        .or_insert_with(|| json!(attempted));
    Ok(Value::Object(result))
}

fn request_json(
    base_url: &str,
    user_agent: &str,
    timeout_ms: u64,
    method: &str,
    path: &str,
    payload: Option<&Value>,
    authorization: &str,
) -> Result<Value, CloudflareServiceError> {
    if !path.starts_with('/') || path.starts_with("//") {
        return Err(failure(
            "invalid_request",
            "Cloudflare path must be relative to the configured API",
        ));
    }
    let method = Method::from_bytes(method.trim().to_uppercase().as_bytes())
        .map_err(|_| failure("invalid_request", "unsupported HTTP method"))?;
    if method != Method::GET && method != Method::POST {
        return Err(failure("invalid_request", "unsupported HTTP method"));
    }
    let client = Client::builder()
        .timeout(Duration::from_millis(timeout_ms.clamp(100, 300_000)))
        .build()
        .map_err(transport_failure)?;
    let url = format!("{}{}", base_url.trim_end_matches('/'), path);
    let mut builder = client
        .request(method, url)
        .header("Accept", "application/json")
        .header("User-Agent", user_agent);
    if !authorization.trim().is_empty() {
        builder = builder.header("Authorization", authorization.trim());
    }
    if let Some(payload) = payload {
        builder = builder.json(payload);
    }
    let response = builder.send().map_err(transport_failure)?;
    let status = response.status();
    let body = response.text().map_err(transport_failure)?;
    if !status.is_success() {
        return Err(CloudflareServiceError {
            kind: "http_status".to_owned(),
            message: format!("HTTP {}", status.as_u16()),
            status_code: Some(status.as_u16()),
            body_preview: Some(body.chars().take(4096).collect()),
        });
    }
    serde_json::from_str(&body).map_err(|_| CloudflareServiceError {
        kind: "invalid_json".to_owned(),
        message: "response body is not valid JSON".to_owned(),
        status_code: Some(status.as_u16()),
        body_preview: Some(body.chars().take(4096).collect()),
    })
}

fn normalize_entries(entries: &[Value]) -> Vec<Value> {
    let mut seen = std::collections::HashSet::new();
    entries
        .iter()
        .filter_map(Value::as_object)
        .filter_map(normalize_entry)
        .filter(|entry| {
            entry
                .get("bvid")
                .and_then(Value::as_str)
                .is_some_and(|bvid| seen.insert(bvid.to_owned()))
        })
        .collect()
}

fn normalize_entry(entry: &Map<String, Value>) -> Option<Value> {
    let bvid = text(entry, &["bvid"]);
    let title = text(entry, &["title"]);
    if !valid_bvid(&bvid) || title.is_empty() || title == "已失效视频" {
        return None;
    }
    let mut url = text(entry, &["url"]);
    if url.is_empty() {
        url = format!("https://www.bilibili.com/video/{bvid}");
    }
    let mut result = Map::from_iter([
        (
            "mid".to_owned(),
            Value::String(text(entry, &["mid", "owner_mid"])),
        ),
        ("bvid".to_owned(), Value::String(bvid)),
        ("title".to_owned(), Value::String(title)),
        ("url".to_owned(), Value::String(url)),
        (
            "owner_name".to_owned(),
            Value::String(text(entry, &["owner_name", "author"])),
        ),
        (
            "owner_url".to_owned(),
            Value::String(text(entry, &["owner_url"])),
        ),
    ]);
    for key in [
        "cover_url",
        "rank",
        "played_count",
        "preserved_1",
        "preserved_2",
        "preserved_3",
        "preserved_4",
        "preserved_5",
        "tag_1",
        "tag_2",
        "tag_3",
        "tag_4",
        "tag_5",
        "tag_status",
    ] {
        if let Some(value) = entry.get(key).filter(|value| !value.is_null()) {
            result.insert(key.to_owned(), Value::String(value_text(value)));
        }
    }
    Some(Value::Object(result))
}

fn value_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.trim().to_owned(),
        Value::Number(number) => number.to_string(),
        Value::Bool(boolean) => boolean.to_string(),
        _ => value.to_string(),
    }
}

fn valid_bvid(value: &str) -> bool {
    value.len() == 12
        && value.starts_with("BV")
        && value[2..]
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
}

fn text(entry: &Map<String, Value>, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|key| entry.get(*key))
        .and_then(|value| match value {
            Value::String(text) => Some(text.trim().to_owned()),
            Value::Number(number) => Some(number.to_string()),
            _ => None,
        })
        .unwrap_or_default()
}

fn validate_base_url(value: &str) -> Result<(), CloudflareServiceError> {
    let parsed = url::Url::parse(value.trim())
        .map_err(|_| failure("invalid_request", "invalid Cloudflare API URL"))?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.cannot_be_a_base() {
        return Err(failure("invalid_request", "invalid Cloudflare API URL"));
    }
    Ok(())
}

fn transport_failure(error: reqwest::Error) -> CloudflareServiceError {
    CloudflareServiceError {
        kind: if error.is_timeout() {
            "timeout".to_owned()
        } else {
            "transport".to_owned()
        },
        message: error.to_string(),
        status_code: error.status().map(|status| status.as_u16()),
        body_preview: None,
    }
}

fn failure(kind: &str, message: impl Into<String>) -> CloudflareServiceError {
    CloudflareServiceError {
        kind: kind.to_owned(),
        message: message.into(),
        status_code: None,
        body_preview: None,
    }
}

fn schema_version() -> u32 {
    1
}

fn default_user_agent() -> String {
    "bilikara/dev (+https://github.com/VZRXS/bilikara)".to_owned()
}

fn default_timeout_ms() -> u64 {
    12_000
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalization_filters_invalid_and_duplicate_entries() {
        let entries = vec![
            json!({"bvid": "BV1xx411c7mD", "title": "Song"}),
            json!({"bvid": "BV1xx411c7mD", "title": "Duplicate"}),
            json!({"bvid": "invalid", "title": "Bad"}),
            json!({"bvid": "BV1yy411c7mD", "title": "已失效视频"}),
        ];
        let normalized = normalize_entries(&entries);
        assert_eq!(normalized.len(), 1);
        assert_eq!(
            normalized[0]["url"],
            "https://www.bilibili.com/video/BV1xx411c7mD"
        );
    }
}
