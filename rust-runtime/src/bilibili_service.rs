use md5::compute as md5_compute;
use reqwest::blocking::Client;
use reqwest::header::{COOKIE, HeaderMap, HeaderValue, REFERER, USER_AGENT};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use url::form_urlencoded;

const NAV_URL: &str = "https://api.bilibili.com/x/web-interface/nav";
const PLAYURL_URL: &str = "https://api.bilibili.com/x/player/wbi/playurl";
const WBI_CACHE_TTL: Duration = Duration::from_secs(600);
const WBI_MIXIN_TABLE: [usize; 64] = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29,
    28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25,
    54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BilibiliDashRequest {
    #[serde(default = "schema_version")]
    pub schema_version: u32,
    #[serde(default)]
    pub bvid: String,
    #[serde(default)]
    pub cid: u64,
    #[serde(default)]
    pub avid: u64,
    #[serde(default = "default_qn")]
    pub qn: u32,
    #[serde(default = "default_fnval")]
    pub fnval: u32,
    #[serde(default)]
    pub cookie: String,
    #[serde(default = "default_user_agent")]
    pub user_agent: String,
    #[serde(default = "default_referer")]
    pub referer: String,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BilibiliRedirectRequest {
    #[serde(default = "schema_version")]
    pub schema_version: u32,
    pub url: String,
    #[serde(default)]
    pub cookie: String,
    #[serde(default = "default_user_agent")]
    pub user_agent: String,
    #[serde(default = "default_referer")]
    pub referer: String,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BilibiliStream {
    pub url: String,
    pub backup_urls: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codec_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codec_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codecs: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quality_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bandwidth: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub order: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BilibiliDashResult {
    pub video: Vec<BilibiliStream>,
    pub audio: Vec<BilibiliStream>,
    pub flac: Option<BilibiliStream>,
    pub dolby: Option<BilibiliStream>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BilibiliRedirectResult {
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BilibiliServiceError {
    pub kind: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_code: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_code: Option<i64>,
}

#[derive(Debug, Clone)]
struct CachedWbiKeys {
    img_key: String,
    sub_key: String,
    loaded_at: Instant,
}

static WBI_KEYS: OnceLock<Mutex<Option<CachedWbiKeys>>> = OnceLock::new();

pub(crate) struct BilibiliHttpClient {
    client: Client,
}

impl BilibiliHttpClient {
    pub(crate) fn new(
        cookie: &str,
        user_agent: &str,
        referer: &str,
        timeout_ms: u64,
    ) -> Result<Self, BilibiliServiceError> {
        let request = BilibiliDashRequest {
            schema_version: 1,
            bvid: String::new(),
            cid: 0,
            avid: 0,
            qn: default_qn(),
            fnval: default_fnval(),
            cookie: cookie.to_owned(),
            user_agent: user_agent.to_owned(),
            referer: referer.to_owned(),
            timeout_ms,
        };
        let client = Client::builder()
            .timeout(Duration::from_millis(timeout_ms.max(100)))
            .default_headers(request_headers(&request)?)
            .build()
            .map_err(|error| service_error("client", error.to_string(), None))?;
        Ok(Self { client })
    }

    pub(crate) fn get_json(&self, url: &str) -> Result<Value, BilibiliServiceError> {
        get_json(&self.client, url)
    }

    pub(crate) fn get_api_json(
        &self,
        url: &str,
        fallback: &str,
    ) -> Result<Value, BilibiliServiceError> {
        let payload = self.get_json(url)?;
        ensure_api_success(&payload, fallback)?;
        Ok(payload)
    }

    pub(crate) fn get_wbi_json(
        &self,
        url: &str,
        params: BTreeMap<String, String>,
        fallback: &str,
    ) -> Result<Value, BilibiliServiceError> {
        let (img_key, sub_key) = cached_wbi_keys(&self.client)?;
        let query = sign_params(params, &img_key, &sub_key, unix_timestamp());
        self.get_api_json(&format!("{url}?{query}"), fallback)
    }
}

pub fn fetch_dash_playurl(
    request: &BilibiliDashRequest,
) -> Result<BilibiliDashResult, BilibiliServiceError> {
    validate_request(request)?;
    let client = BilibiliHttpClient::new(
        &request.cookie,
        &request.user_agent,
        &request.referer,
        request.timeout_ms,
    )?;
    let mut params = BTreeMap::from([
        ("cid".to_owned(), request.cid.to_string()),
        ("fnval".to_owned(), request.fnval.to_string()),
        ("fourk".to_owned(), "1".to_owned()),
        ("platform".to_owned(), "web".to_owned()),
        ("qn".to_owned(), request.qn.to_string()),
    ]);
    if request.avid > 0 {
        params.insert("avid".to_owned(), request.avid.to_string());
    }
    if !request.bvid.trim().is_empty() {
        params.insert("bvid".to_owned(), request.bvid.trim().to_owned());
    }
    let payload = client.get_wbi_json(PLAYURL_URL, params, "playurl request failed")?;
    parse_playurl_payload(&payload)
}

pub fn resolve_redirect(
    request: &BilibiliRedirectRequest,
) -> Result<BilibiliRedirectResult, BilibiliServiceError> {
    if request.schema_version != 1 {
        return Err(service_error(
            "invalid_request",
            "unsupported schema version",
            None,
        ));
    }
    let parsed = url::Url::parse(request.url.trim())
        .map_err(|_| service_error("invalid_request", "invalid redirect URL", None))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(service_error(
            "invalid_request",
            "unsupported redirect URL scheme",
            None,
        ));
    }
    let client = BilibiliHttpClient::new(
        &request.cookie,
        &request.user_agent,
        &request.referer,
        request.timeout_ms,
    )?;
    let response = client
        .client
        .get(parsed)
        .send()
        .map_err(|error| service_error("network", error.to_string(), None))?;
    if !response.status().is_success() {
        return Err(http_status_error(response.status().as_u16()));
    }
    Ok(BilibiliRedirectResult {
        url: response.url().to_string(),
    })
}

fn validate_request(request: &BilibiliDashRequest) -> Result<(), BilibiliServiceError> {
    if request.schema_version != 1 {
        return Err(service_error(
            "invalid_request",
            "unsupported schema version",
            None,
        ));
    }
    if request.cid == 0 {
        return Err(service_error(
            "invalid_request",
            "cid must be positive",
            None,
        ));
    }
    if request.bvid.trim().is_empty() && request.avid == 0 {
        return Err(service_error(
            "invalid_request",
            "bvid or avid is required",
            None,
        ));
    }
    Ok(())
}

fn request_headers(request: &BilibiliDashRequest) -> Result<HeaderMap, BilibiliServiceError> {
    let mut headers = HeaderMap::new();
    insert_header(&mut headers, USER_AGENT, &request.user_agent)?;
    insert_header(&mut headers, REFERER, &request.referer)?;
    if !request.cookie.trim().is_empty() {
        insert_header(&mut headers, COOKIE, request.cookie.trim())?;
    }
    Ok(headers)
}

fn insert_header(
    headers: &mut HeaderMap,
    name: reqwest::header::HeaderName,
    value: &str,
) -> Result<(), BilibiliServiceError> {
    let header = HeaderValue::from_str(value)
        .map_err(|error| service_error("invalid_request", error.to_string(), None))?;
    headers.insert(name, header);
    Ok(())
}

fn cached_wbi_keys(client: &Client) -> Result<(String, String), BilibiliServiceError> {
    let cache = WBI_KEYS.get_or_init(|| Mutex::new(None));
    {
        let guard = cache
            .lock()
            .map_err(|_| service_error("state", "WBI key cache lock is poisoned", None))?;
        if let Some(keys) = guard.as_ref()
            && keys.loaded_at.elapsed() < WBI_CACHE_TTL
        {
            return Ok((keys.img_key.clone(), keys.sub_key.clone()));
        }
    }
    let payload = get_json(client, NAV_URL)?;
    let (img_key, sub_key) = parse_wbi_keys(&payload)?;
    let mut guard = cache
        .lock()
        .map_err(|_| service_error("state", "WBI key cache lock is poisoned", None))?;
    *guard = Some(CachedWbiKeys {
        img_key: img_key.clone(),
        sub_key: sub_key.clone(),
        loaded_at: Instant::now(),
    });
    Ok((img_key, sub_key))
}

fn parse_wbi_keys(payload: &Value) -> Result<(String, String), BilibiliServiceError> {
    let code = payload.get("code").and_then(Value::as_i64).unwrap_or(0);
    if code != 0 && code != -101 {
        ensure_api_success(payload, "WBI key request failed")?;
    }
    let Some(wbi) = payload.pointer("/data/wbi_img").and_then(Value::as_object) else {
        ensure_api_success(payload, "WBI key request failed")?;
        return Err(service_error(
            "invalid_response",
            "WBI key information is missing",
            None,
        ));
    };
    let img_key = asset_key(wbi.get("img_url"))?;
    let sub_key = asset_key(wbi.get("sub_url"))?;
    Ok((img_key, sub_key))
}

fn asset_key(value: Option<&Value>) -> Result<String, BilibiliServiceError> {
    let url = value.and_then(Value::as_str).unwrap_or_default();
    let file_name = url.rsplit('/').next().unwrap_or_default();
    let key = file_name.split('.').next().unwrap_or_default().trim();
    if key.is_empty() {
        return Err(service_error(
            "invalid_response",
            "invalid WBI key URL",
            None,
        ));
    }
    Ok(key.to_owned())
}

fn get_json(client: &Client, url: &str) -> Result<Value, BilibiliServiceError> {
    let response = client
        .get(url)
        .send()
        .map_err(|error| service_error("network", error.to_string(), None))?;
    let status = response.status();
    if !status.is_success() {
        return Err(http_status_error(status.as_u16()));
    }
    response
        .json::<Value>()
        .map_err(|error| service_error("invalid_response", error.to_string(), None))
}

fn http_status_error(status_code: u16) -> BilibiliServiceError {
    let (kind, message) = match status_code {
        401 => (
            "authentication",
            "Bilibili login/Cookie is invalid or expired (HTTP 401)".to_owned(),
        ),
        402 => (
            "unavailable",
            "Bilibili media access is unavailable or requires payment (HTTP 402)".to_owned(),
        ),
        403 => (
            "forbidden",
            "Bilibili media access was forbidden (HTTP 403)".to_owned(),
        ),
        _ => ("http", format!("Bilibili returned HTTP {status_code}")),
    };
    service_error(kind, message, Some(status_code))
}

fn ensure_api_success(payload: &Value, fallback: &str) -> Result<(), BilibiliServiceError> {
    let code = payload.get("code").and_then(Value::as_i64).unwrap_or(0);
    if code == 0 {
        return Ok(());
    }
    let message = payload
        .get("message")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(fallback);
    let kind = match code {
        -101 => "authentication",
        -352 | -412 | 412 => "risk_control",
        -403 => "forbidden",
        -404 | 62002 => "unavailable",
        -400 => "invalid_request",
        _ => "api",
    };
    let mut error = service_error(kind, message, None);
    error.api_code = Some(code);
    Err(error)
}

fn parse_playurl_payload(payload: &Value) -> Result<BilibiliDashResult, BilibiliServiceError> {
    ensure_api_success(payload, "playurl request failed")?;
    let data = payload
        .get("data")
        .and_then(Value::as_object)
        .ok_or_else(|| service_error("invalid_response", "playurl data is missing", None))?;
    let Some(dash) = data.get("dash").and_then(Value::as_object) else {
        let video: Vec<BilibiliStream> = data
            .get("durl")
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(parse_durl_stream).collect())
            .unwrap_or_default();
        if video.is_empty() {
            return Err(service_error(
                "unsupported",
                "video has neither DASH nor fallback URLs",
                None,
            ));
        }
        return Ok(BilibiliDashResult {
            video,
            audio: Vec::new(),
            flac: None,
            dolby: None,
        });
    };
    let video = dash
        .get("video")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(parse_video_stream).collect())
        .unwrap_or_default();
    let audio = dash
        .get("audio")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(parse_audio_stream).collect())
        .unwrap_or_default();
    let flac = dash
        .get("flac")
        .and_then(Value::as_object)
        .and_then(|value| value.get("audio"))
        .and_then(|value| parse_special_audio(value, 30251, "flac", "audio/flac", "flac"));
    let dolby = dash
        .get("dolby")
        .and_then(Value::as_object)
        .and_then(|value| value.get("audio"))
        .and_then(Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .find_map(|value| parse_special_audio(value, 30250, "ec-3", "audio/mp4", "eac3"))
        });
    Ok(BilibiliDashResult {
        video,
        audio,
        flac,
        dolby,
    })
}

fn parse_durl_stream(value: &Value) -> Option<BilibiliStream> {
    let object = value.as_object()?;
    Some(BilibiliStream {
        url: stream_url(object)?,
        backup_urls: backup_urls(object),
        codec_id: None,
        codec_name: None,
        codecs: None,
        mime_type: None,
        width: None,
        height: None,
        quality_id: None,
        bandwidth: None,
        order: integer(object, &["order"]),
    })
}

fn parse_video_stream(value: &Value) -> Option<BilibiliStream> {
    let object = value.as_object()?;
    let codec_id = integer(object, &["codecid", "codecId"]).unwrap_or(0);
    let codec_name = match codec_id {
        7 => "avc".to_owned(),
        12 => "hevc".to_owned(),
        13 => "av1".to_owned(),
        other => format!("codec_{other}"),
    };
    Some(BilibiliStream {
        url: stream_url(object)?,
        backup_urls: backup_urls(object),
        codec_id: Some(codec_id),
        codec_name: Some(codec_name),
        codecs: text(object, &["codecs"]),
        mime_type: text(object, &["mimeType", "mime_type"]),
        width: unsigned(object, &["width"]),
        height: unsigned(object, &["height"]),
        quality_id: integer(object, &["id"]),
        bandwidth: unsigned(object, &["bandwidth"]),
        order: None,
    })
}

fn parse_audio_stream(value: &Value) -> Option<BilibiliStream> {
    let object = value.as_object()?;
    Some(BilibiliStream {
        url: stream_url(object)?,
        backup_urls: backup_urls(object),
        codec_id: None,
        codec_name: None,
        codecs: text(object, &["codecs"]),
        mime_type: text(object, &["mimeType", "mime_type"]),
        width: None,
        height: None,
        quality_id: integer(object, &["id"]),
        bandwidth: unsigned(object, &["bandwidth"]),
        order: None,
    })
}

fn parse_special_audio(
    value: &Value,
    default_quality: i64,
    default_codecs: &str,
    default_mime: &str,
    codec_name: &str,
) -> Option<BilibiliStream> {
    let object = value.as_object()?;
    Some(BilibiliStream {
        url: stream_url(object)?,
        backup_urls: backup_urls(object),
        codec_id: None,
        codec_name: Some(codec_name.to_owned()),
        codecs: Some(text(object, &["codecs"]).unwrap_or_else(|| default_codecs.to_owned())),
        mime_type: Some(
            text(object, &["mimeType", "mime_type"]).unwrap_or_else(|| default_mime.to_owned()),
        ),
        width: None,
        height: None,
        quality_id: Some(integer(object, &["id"]).unwrap_or(default_quality)),
        bandwidth: Some(unsigned(object, &["bandwidth"]).unwrap_or(0)),
        order: None,
    })
}

fn stream_url(object: &serde_json::Map<String, Value>) -> Option<String> {
    text(object, &["baseUrl", "base_url", "url"]).filter(|value| !value.is_empty())
}

fn backup_urls(object: &serde_json::Map<String, Value>) -> Vec<String> {
    ["backupUrl", "backup_url"]
        .iter()
        .find_map(|key| object.get(*key).and_then(Value::as_array))
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn text(object: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| object.get(*key))
        .and_then(|value| match value {
            Value::String(text) => Some(text.trim().to_owned()),
            Value::Number(number) => Some(number.to_string()),
            _ => None,
        })
}

fn integer(object: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<i64> {
    keys.iter()
        .find_map(|key| object.get(*key))
        .and_then(|value| value.as_i64().or_else(|| value.as_str()?.parse().ok()))
}

fn unsigned(object: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<u64> {
    keys.iter()
        .find_map(|key| object.get(*key))
        .and_then(|value| value.as_u64().or_else(|| value.as_str()?.parse().ok()))
}

fn mixin_key(img_key: &str, sub_key: &str) -> String {
    let source: Vec<char> = format!("{img_key}{sub_key}").chars().collect();
    WBI_MIXIN_TABLE
        .iter()
        .filter_map(|index| source.get(*index))
        .take(32)
        .collect()
}

fn sign_params(
    mut params: BTreeMap<String, String>,
    img_key: &str,
    sub_key: &str,
    timestamp: u64,
) -> String {
    params.insert("wts".to_owned(), timestamp.to_string());
    let mut serializer = form_urlencoded::Serializer::new(String::new());
    for (key, value) in &params {
        let sanitized: String = value
            .chars()
            .filter(|character| !matches!(character, '!' | '\'' | '(' | ')' | '*'))
            .collect();
        serializer.append_pair(key, &sanitized);
    }
    let query = serializer.finish();
    let digest = format!(
        "{:x}",
        md5_compute(format!("{query}{}", mixin_key(img_key, sub_key)))
    );
    format!("{query}&w_rid={digest}")
}

fn unix_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs())
}

fn service_error(
    kind: &str,
    message: impl Into<String>,
    status_code: Option<u16>,
) -> BilibiliServiceError {
    BilibiliServiceError {
        kind: kind.to_owned(),
        message: message.into(),
        status_code,
        api_code: None,
    }
}

fn schema_version() -> u32 {
    1
}

fn default_qn() -> u32 {
    127
}

fn default_fnval() -> u32 {
    4048
}

fn default_timeout_ms() -> u64 {
    15_000
}

fn default_user_agent() -> String {
    "Mozilla/5.0 Bilikara Rust Runtime".to_owned()
}

fn default_referer() -> String {
    "https://www.bilibili.com/".to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn wbi_signing_is_stable_and_filters_forbidden_characters() {
        let params = BTreeMap::from([
            ("bvid".to_owned(), "BV1xx411c7mD".to_owned()),
            ("cid".to_owned(), "456!'()*".to_owned()),
        ]);
        let first = sign_params(params.clone(), &"a".repeat(32), &"b".repeat(32), 1234);
        let second = sign_params(params, &"a".repeat(32), &"b".repeat(32), 1234);
        assert_eq!(first, second);
        assert!(first.contains("cid=456"));
        assert!(!first.contains("%21"));
        assert!(first.contains("w_rid="));
    }

    #[test]
    fn parses_dash_video_regular_audio_and_hires_audio() {
        let payload = json!({
            "code": 0,
            "data": {"dash": {
                "video": [{"baseUrl": "https://video", "backupUrl": ["https://video-b"], "codecid": 7, "id": 80, "bandwidth": 10, "width": 1920, "height": 1080}],
                "audio": [{"base_url": "https://audio", "id": 30280, "bandwidth": 5}],
                "flac": {"audio": {"baseUrl": "https://flac", "id": 30251}},
                "dolby": {"audio": [{"baseUrl": "https://dolby", "id": 30250}]}
            }}
        });
        let parsed = parse_playurl_payload(&payload).expect("valid DASH payload");
        assert_eq!(parsed.video[0].codec_name.as_deref(), Some("avc"));
        assert_eq!(parsed.audio[0].quality_id, Some(30280));
        assert_eq!(
            parsed.flac.as_ref().map(|stream| stream.url.as_str()),
            Some("https://flac")
        );
        assert_eq!(
            parsed
                .dolby
                .as_ref()
                .and_then(|stream| stream.codec_name.as_deref()),
            Some("eac3")
        );
    }

    #[test]
    fn rejects_api_risk_control_response() {
        let error = parse_playurl_payload(&json!({"code": -352, "message": "risk"}))
            .expect_err("risk-control response must fail");
        assert_eq!(error.kind, "risk_control");
        assert_eq!(error.api_code, Some(-352));
    }

    #[test]
    fn classifies_explicit_authentication_and_access_responses() {
        let authentication =
            parse_playurl_payload(&json!({"code": -101, "message": "not logged in"}))
                .expect_err("authentication response must fail");
        assert_eq!(authentication.kind, "authentication");
        assert_eq!(authentication.api_code, Some(-101));

        let forbidden = parse_playurl_payload(&json!({"code": -403, "message": "forbidden"}))
            .expect_err("forbidden response must fail");
        assert_eq!(forbidden.kind, "forbidden");
        assert_eq!(forbidden.api_code, Some(-403));

        let unavailable = parse_playurl_payload(&json!({"code": 62002, "message": "unavailable"}))
            .expect_err("unavailable response must fail");
        assert_eq!(unavailable.kind, "unavailable");
        assert_eq!(unavailable.api_code, Some(62002));
    }

    #[test]
    fn anonymous_nav_auth_response_with_valid_wbi_data_produces_keys() {
        let payload = json!({
            "code": -101,
            "message": "账号未登录",
            "data": {
                "isLogin": false,
                "wbi_img": {
                    "img_url": "https://i0.hdslb.com/bfs/wbi/0123456789abcdef.png",
                    "sub_url": "https://i0.hdslb.com/bfs/wbi/fedcba9876543210.png"
                }
            }
        });

        assert_eq!(
            parse_wbi_keys(&payload).expect("anonymous WBI keys"),
            ("0123456789abcdef".to_owned(), "fedcba9876543210".to_owned())
        );
    }

    #[test]
    fn anonymous_nav_auth_response_without_wbi_data_remains_an_error() {
        let error = parse_wbi_keys(&json!({
            "code": -101,
            "message": "账号未登录",
            "data": {"isLogin": false}
        }))
        .expect_err("missing anonymous WBI data must fail");

        assert_eq!(error.kind, "authentication");
        assert_eq!(error.api_code, Some(-101));
    }

    #[test]
    fn classifies_http_authentication_payment_and_forbidden_responses() {
        let authentication = http_status_error(401);
        assert_eq!(authentication.kind, "authentication");
        assert!(authentication.message.contains("invalid or expired"));

        let unavailable = http_status_error(402);
        assert_eq!(unavailable.kind, "unavailable");
        assert!(unavailable.message.contains("requires payment"));

        let forbidden = http_status_error(403);
        assert_eq!(forbidden.kind, "forbidden");
        assert!(forbidden.message.contains("media access was forbidden"));
    }

    #[test]
    fn guest_request_headers_omit_cookie_without_weakening_logged_in_requests() {
        let mut request = BilibiliDashRequest {
            schema_version: 1,
            bvid: "BV1xx411c7mD".to_owned(),
            cid: 456,
            avid: 0,
            qn: default_qn(),
            fnval: default_fnval(),
            cookie: String::new(),
            user_agent: default_user_agent(),
            referer: default_referer(),
            timeout_ms: default_timeout_ms(),
        };
        let guest_headers = request_headers(&request).expect("guest headers");
        assert!(!guest_headers.contains_key(COOKIE));

        request.cookie = "SESSDATA=test".to_owned();
        let logged_in_headers = request_headers(&request).expect("logged-in headers");
        assert_eq!(
            logged_in_headers
                .get(COOKIE)
                .and_then(|value| value.to_str().ok()),
            Some("SESSDATA=test")
        );
    }
}
