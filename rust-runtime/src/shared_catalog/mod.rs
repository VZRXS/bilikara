//! One catalog service for Python FFI, native Host and Internet Remote.
//! D1 is primary; the verified public Sheets snapshot is a read-only search fallback.
mod operations;
mod read;
mod sheets;
#[cfg(test)]
mod tests;

use crate::app_state::with_catalog;
use crate::cloudflare_service::{
    CloudflareOperation, CloudflareServiceError, CloudflareServiceRequest, execute_cloudflare,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashSet, VecDeque},
    time::{Duration, Instant},
};

pub const DEFAULT_API_URL: &str = "https://api.kevinx96.icu";

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum CatalogOperation {
    Read {
        path: String,
        query: String,
    },
    NormalizeEntry {
        entry: Value,
    },
    Append {
        entries: Vec<Value>,
    },
    EnqueueAppend {
        entries: Vec<Value>,
    },
    Export {
        secret: String,
        limit: Value,
    },
    PendingReview {
        secret: String,
        limit: Value,
        export_limit: Value,
    },
    ApproveReview {
        secret: String,
        bvids: Vec<Value>,
        limit: Value,
        export_limit: Value,
    },
    Mutate {
        action: CatalogAction,
        params: Value,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CatalogAction {
    RejectReview,
    ListBlacklist,
    RestoreBlacklist,
    DeleteInvalid,
    DeleteVideo,
    DeleteMid,
    RateSong,
    VerifySecret,
    Maintenance,
    ResetTags,
}

#[derive(Clone, Debug, Deserialize)]
pub struct CatalogRequest {
    pub schema_version: u32,
    pub base_url: String,
    pub user_agent: String,
    pub timeout_ms: u64,
    #[serde(default)]
    pub review_keywords: Vec<String>,
    /// Host configuration only; an empty value disables Sheets.
    #[serde(default)]
    pub sheets_url: Option<String>,
    #[serde(flatten)]
    pub operation: CatalogOperation,
}
impl Default for CatalogRequest {
    fn default() -> Self {
        Self {
            schema_version: 1,
            base_url: DEFAULT_API_URL.into(),
            user_agent: "bilikara/0.8.0".into(),
            timeout_ms: 8000,
            review_keywords: Vec::new(),
            sheets_url: None,
            operation: CatalogOperation::Read {
                path: "/api/catalog/search".into(),
                query: String::new(),
            },
        }
    }
}

impl CatalogRequest {
    /// Host-owned configuration; never supplied by an HTTP/Internet client.
    pub fn for_host() -> Self {
        let mut request = Self::default();
        if let Ok(base) = std::env::var("BILIKARA_CF_API_URL")
            && !base.trim().is_empty()
        {
            request.base_url = base.trim().trim_end_matches('/').into();
        }
        request
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct CatalogError {
    pub kind: String,
    pub message: String,
    pub status_code: u16,
    pub fallback_eligible: bool,
}
impl CatalogError {
    pub(crate) fn new(status: u16, kind: &str, message: impl Into<String>) -> Self {
        Self {
            kind: kind.into(),
            message: message.into(),
            status_code: status,
            fallback_eligible: false,
        }
    }
    fn invalid(message: impl Into<String>) -> Self {
        Self::new(400, "invalid_request", message)
    }
    fn response() -> Self {
        Self::new(
            503,
            "catalog_response",
            "Catalog returned an invalid response",
        )
    }
    fn status_kind(status: u16) -> &'static str {
        match status {
            400 | 422 => "catalog_invalid_request",
            401 => "catalog_unauthorized",
            403 => "catalog_forbidden",
            404 => "catalog_not_found",
            409 => "catalog_conflict",
            429 => "catalog_rate_limited",
            _ => "catalog_unavailable",
        }
    }
    fn upstream(error: CloudflareServiceError) -> Self {
        let status = error.status_code.filter(|s| *s >= 400).unwrap_or(503);
        // Neither arbitrary 4xx nor a local validation/FFI error is an outage.
        let eligible = matches!(
            error.kind.as_str(),
            "timeout" | "transport" | "invalid_json" | "response_too_large"
        ) || (error.kind == "http_status"
            && matches!(error.status_code, Some(408 | 429 | 500 | 502 | 503 | 504)));
        Self {
            kind: Self::status_kind(status).into(),
            message: "Catalog request failed".into(),
            status_code: status,
            fallback_eligible: eligible,
        }
    }
}

/// Transient cache metadata, owned by the existing AppState authority.
#[derive(Debug, Default)]
pub(crate) struct CatalogState {
    cache: VecDeque<(String, Instant, Value)>,
    inflight: HashSet<String>,
    backoff: VecDeque<(String, Instant, CatalogError)>,
    generation: u64,
    sheets: sheets::SnapshotState,
    // Conservative process-local exclusions survive snapshot refresh/invalidation.
    exclusions: HashSet<(String, String, String)>,
    exclusions_full: bool,
}

pub(crate) fn invalidate() -> Result<(), CatalogError> {
    with_catalog(|state| {
        state.cache.clear();
        state.sheets.snapshot = None;
        state.backoff.clear();
        state.generation = state.generation.wrapping_add(1);
        Ok(())
    })
}

pub fn execute_catalog(request: &CatalogRequest) -> Result<Value, CatalogError> {
    let mut request = request.clone();
    if request.sheets_url.is_none() {
        request.sheets_url = std::env::var("BILIKARA_CATALOG_SHEETS_URL").ok();
    }
    execute_with_fallback(&request, &execute_cloudflare, &sheets::fetch)
}

fn execute_with_fallback(
    request: &CatalogRequest,
    fetch: &impl Fn(&CloudflareServiceRequest) -> Result<Value, CloudflareServiceError>,
    snapshot_fetch: &impl Fn(&str, &CatalogRequest) -> Result<Vec<Value>, CatalogError>,
) -> Result<Value, CatalogError> {
    let result = execute_with(request, fetch);
    if let Err(error) = &result
        && error.fallback_eligible
        && let CatalogOperation::Read { path, query } = &request.operation
        && matches!(path.as_str(), "/api/catalog/search" | "/api/lark/search")
        && let Some(endpoint) = sheets::endpoint(request)
    {
        return sheets::search(request, query, &endpoint, snapshot_fetch);
    }
    result
}

pub(crate) fn execute_with(
    request: &CatalogRequest,
    fetch: &impl Fn(&CloudflareServiceRequest) -> Result<Value, CloudflareServiceError>,
) -> Result<Value, CatalogError> {
    if request.schema_version != 1 {
        return Err(CatalogError::invalid("Unsupported catalog schema"));
    }
    match &request.operation {
        CatalogOperation::Read { path, query } => read::read_with(request, path, query, fetch),
        _ => operations::execute(request, fetch),
    }
}

fn cloud_request(
    request: &CatalogRequest,
    operation: CloudflareOperation,
    timeout_ms: u64,
) -> CloudflareServiceRequest {
    CloudflareServiceRequest {
        schema_version: 1,
        base_url: request.base_url.clone(),
        user_agent: request.user_agent.clone(),
        timeout_ms,
        operation,
    }
}

fn query_value(query: &str, key: &str) -> String {
    url::form_urlencoded::parse(query.as_bytes())
        .find(|(name, _)| name == key)
        .map(|(_, value)| value.trim().to_owned())
        .unwrap_or_default()
}
fn query_number(query: &str, key: &str, default: usize, max: usize) -> Result<usize, CatalogError> {
    let value = query_value(query, key);
    if value.is_empty() {
        return Ok(default);
    }
    value
        .parse::<usize>()
        .ok()
        .filter(|v| *v <= max)
        .ok_or_else(|| CatalogError::invalid(format!("Invalid {key}")))
}

fn normalize_bvid(raw: &str, raw_url: &str) -> Option<String> {
    let value = if raw.trim().is_empty() {
        raw_url.trim()
    } else {
        raw.trim()
    };
    let candidate = if value.starts_with("https://") || value.starts_with("http://") {
        let url = url::Url::parse(value).ok()?;
        if !matches!(
            url.host_str(),
            Some("www.bilibili.com" | "bilibili.com" | "m.bilibili.com")
        ) || !url.username().is_empty()
            || url.password().is_some()
        {
            return None;
        }
        let mut parts = url.path_segments()?;
        if parts.next()? != "video" {
            return None;
        }
        parts.next()?.to_owned()
    } else {
        value.to_owned()
    };
    if candidate.len() != 12
        || !candidate.as_bytes()[..2].eq_ignore_ascii_case(b"BV")
        || !candidate[2..].bytes().all(|c| c.is_ascii_alphanumeric())
    {
        return None;
    }
    Some(format!("BV{}", &candidate[2..]))
}
