use reqwest::Method;
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

const DEFAULT_TIMEOUT_MS: u64 = 12_000;
const MAX_ERROR_BODY_BYTES: usize = 4_096;

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JsonHttpRequest {
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: Vec<HttpHeader>,
    #[serde(default)]
    pub payload: Option<Value>,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HttpHeader {
    pub name: String,
    pub value: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct JsonHttpResult {
    pub status_code: u16,
    pub payload: Value,
}

#[derive(Clone, Debug, Serialize)]
pub struct JsonHttpError {
    pub kind: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_code: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body_preview: Option<String>,
}

fn default_timeout_ms() -> u64 {
    DEFAULT_TIMEOUT_MS
}

pub fn execute_json_request(request: &JsonHttpRequest) -> Result<JsonHttpResult, JsonHttpError> {
    let method =
        Method::from_bytes(request.method.trim().to_uppercase().as_bytes()).map_err(|_| {
            JsonHttpError {
                kind: "invalid_request",
                message: "unsupported HTTP method".to_owned(),
                status_code: None,
                body_preview: None,
            }
        })?;
    let timeout_ms = request.timeout_ms.clamp(100, 300_000);
    let client = Client::builder()
        .timeout(Duration::from_millis(timeout_ms))
        .build()
        .map_err(transport_error)?;
    let mut builder = client.request(method, request.url.trim());
    for header in &request.headers {
        builder = builder.header(header.name.trim(), header.value.as_str());
    }
    if let Some(payload) = &request.payload {
        builder = builder.json(payload);
    }
    let response = builder.send().map_err(transport_error)?;
    let status = response.status();
    let body = response.text().map_err(transport_error)?;
    if !status.is_success() {
        return Err(JsonHttpError {
            kind: "http_status",
            message: format!("HTTP {}", status.as_u16()),
            status_code: Some(status.as_u16()),
            body_preview: Some(truncated(&body)),
        });
    }
    let payload = serde_json::from_str(&body).map_err(|_| JsonHttpError {
        kind: "invalid_json",
        message: "response body is not valid JSON".to_owned(),
        status_code: Some(status.as_u16()),
        body_preview: Some(truncated(&body)),
    })?;
    Ok(JsonHttpResult {
        status_code: status.as_u16(),
        payload,
    })
}

fn transport_error(error: reqwest::Error) -> JsonHttpError {
    JsonHttpError {
        kind: if error.is_timeout() {
            "timeout"
        } else {
            "transport"
        },
        message: error.to_string(),
        status_code: error.status().map(|status| status.as_u16()),
        body_preview: None,
    }
}

fn truncated(value: &str) -> String {
    value.chars().take(MAX_ERROR_BODY_BYTES).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_invalid_methods_before_network_access() {
        let error = execute_json_request(&JsonHttpRequest {
            method: "not a method".to_owned(),
            url: "https://example.invalid".to_owned(),
            headers: Vec::new(),
            payload: None,
            timeout_ms: 100,
        })
        .unwrap_err();
        assert_eq!(error.kind, "invalid_request");
    }
}
