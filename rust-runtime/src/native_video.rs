//! Shared desktop/native metadata I/O and adaptation to the canonical Rust page-binding
//! policy. No downloader subprocess, Python rule mirror, or client-supplied
//! arbitrary network destination is fetched. Short-link hops are allowlisted.
use crate::app_state::PlaylistItem;
use crate::bilibili_service::BilibiliHttpClient;
use bilikara_rust::{
    AudioBindingMode, AudioBindingRequest, AudioBindingResult, AudioPageDescriptor,
    decide_audio_binding,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::sync::OnceLock;

// Match the existing desktop BILIBILI_HEADERS web profile. Some media CDN
// nodes reject abbreviated product UAs even when the metadata API accepts them.
// Metadata, QR login and every native media candidate share this value.
pub(crate) const USER_AGENT: &str = concat!(
    "Mozilla/5.0 (X11; Linux x86_64) ",
    "AppleWebKit/537.36 (KHTML, like Gecko) ",
    "Chrome/123.0.0.0 Safari/537.36"
);
// Keep native metadata on the same current API as the desktop Host adapter.
const VIEW_ENDPOINT: &str = "https://api.bilibili.com/x/web-interface/wbi/view";

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeVideoRequest {
    pub url: String,
    #[serde(default)]
    pub selected_video_page: Option<i64>,
    #[serde(default)]
    pub selected_audio_pages: Option<Vec<i64>>,
}

/// Desktop transport options are host-supplied, never a public endpoint override.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VideoServiceRequest {
    pub operation: VideoOperation,
    pub url: String,
    #[serde(default, deserialize_with = "selected_video_integer")]
    pub selected_video_page: Option<i64>,
    #[serde(default)]
    pub selected_audio_pages: Value,
    #[serde(default)]
    pub cookie: String,
    pub user_agent: String,
    pub referer: String,
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VideoOperation {
    Item,
    Owner,
    Reference,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct NativeVideoError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binding: Option<Value>,
    #[serde(skip)]
    pub missing_bvid: Option<String>,
}
impl NativeVideoError {
    fn invalid(message: &str) -> Self {
        Self {
            code: "invalid_video".into(),
            message: message.into(),
            binding: None,
            missing_bvid: None,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct VideoServiceError {
    pub kind: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binding: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_code: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_code: Option<i64>,
}
impl From<NativeVideoError> for VideoServiceError {
    fn from(e: NativeVideoError) -> Self {
        Self {
            kind: e.code,
            message: e.message,
            binding: e.binding,
            status_code: None,
            api_code: None,
        }
    }
}
impl From<crate::bilibili_service::BilibiliServiceError> for VideoServiceError {
    fn from(e: crate::bilibili_service::BilibiliServiceError) -> Self {
        Self {
            kind: e.kind,
            message: e.message,
            binding: None,
            status_code: e.status_code,
            api_code: e.api_code,
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
struct Page {
    page: i64,
    cid: i64,
    duration: i64,
    part: String,
}
#[derive(Debug)]
struct View {
    aid: i64,
    bvid: String,
    title: String,
    pic: String,
    pages: Vec<Page>,
    owner: Owner,
}
#[derive(Debug, Default)]
struct Owner {
    mid: i64,
    name: String,
}
#[derive(Debug, Serialize)]
struct VideoReference {
    original_url: String,
    resolved_url: String,
    bvid: String,
    aid: i64,
    page: i64,
}

fn selected_video_integer<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<i64>, D::Error> {
    let value = Value::deserialize(deserializer)?;
    if value.is_null() {
        return Ok(None);
    }
    integer(&value)
        .map(Some)
        .ok_or_else(|| serde::de::Error::custom("invalid selected video page"))
}

fn integer(value: &Value) -> Option<i64> {
    match value {
        Value::Bool(b) => Some(i64::from(*b)),
        Value::Number(n) => n.as_i64().or_else(|| {
            n.as_f64()
                .filter(|v| v.is_finite() && *v >= i64::MIN as f64 && *v < i64::MAX as f64)
                .map(|v| v as i64)
        }),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}
fn text(value: &Value) -> String {
    value.as_str().unwrap_or("").to_owned()
}
fn owner(data: &Value) -> Owner {
    Owner {
        mid: integer(&data["owner"]["mid"]).unwrap_or(0),
        name: text(&data["owner"]["name"]).trim().to_owned(),
    }
}
fn owner_url(mid: i64) -> String {
    if mid != 0 {
        format!("https://space.bilibili.com/{mid}")
    } else {
        String::new()
    }
}
fn parse_view(data: &Value) -> Result<View, NativeVideoError> {
    let invalid = || NativeVideoError::invalid("B 站视频信息不完整");
    let aid = integer(&data["aid"])
        .filter(|v| *v > 0)
        .ok_or_else(invalid)?;
    let bvid = data["bvid"]
        .as_str()
        .filter(|v| !v.is_empty())
        .ok_or_else(invalid)?
        .to_owned();
    let mut pages = Vec::new();
    for (index, raw) in data["pages"].as_array().into_iter().flatten().enumerate() {
        if !raw.is_object() {
            continue;
        }
        let cid = integer(&raw["cid"]).unwrap_or(0);
        if cid <= 0 {
            continue;
        }
        let page = integer(&raw["page"])
            .filter(|v| *v != 0)
            .unwrap_or(index as i64 + 1);
        let part = text(&raw["part"]).trim().to_owned();
        pages.push(Page {
            page,
            cid,
            duration: integer(&raw["duration"]).unwrap_or(0),
            part: if part.is_empty() {
                format!("P{page}")
            } else {
                part
            },
        });
    }
    if pages.iter().any(|p| p.duration >= 10) {
        pages.retain(|p| p.duration >= 10);
    }
    Ok(View {
        aid,
        bvid,
        title: text(&data["title"]).trim().to_owned(),
        pic: text(&data["pic"]),
        pages,
        owner: owner(data),
    })
}

fn desktop_reference(
    input: &str,
    client: &BilibiliHttpClient,
) -> Result<VideoReference, VideoServiceError> {
    static BARE: OnceLock<regex::Regex> = OnceLock::new();
    static PATH: OnceLock<regex::Regex> = OnceLock::new();
    let input = input.trim();
    if input.is_empty() {
        return Err(NativeVideoError::invalid("请输入 B 站视频链接").into());
    }
    let bare = BARE.get_or_init(|| regex::Regex::new(r"(?i)^(BV[0-9A-Za-z]+|av[0-9]+)$").unwrap());
    let original_url = if bare.is_match(input) {
        format!("https://www.bilibili.com/video/{input}")
    } else if !input.starts_with("http://") && !input.starts_with("https://") {
        format!("https://{input}")
    } else {
        input.to_owned()
    };
    let invalid = || NativeVideoError::invalid("当前仅支持普通 B 站视频 URL 或 BV/av 号");
    let parsed = url::Url::parse(&original_url).map_err(|_| invalid())?;
    let resolved_url =
        if matches!(parsed.host_str(), Some("b23.tv" | "bili2233.cn")) && parsed.port().is_none() {
            client.resolve_video_short_url(&original_url)?
        } else {
            original_url.clone()
        };
    let parsed = url::Url::parse(&resolved_url).map_err(|_| invalid())?;
    let pattern =
        PATH.get_or_init(|| regex::Regex::new(r"(?i)/video/(BV[0-9A-Za-z]+|av[0-9]+)").unwrap());
    let captures = pattern.captures(parsed.path()).ok_or_else(invalid)?;
    let vid = &captures[1];
    let page = parsed
        .query_pairs()
        .find(|(k, v)| k == "p" && !v.is_empty())
        .map(|(_, v)| v.trim().parse::<i64>())
        .transpose()
        .map_err(|_| NativeVideoError::invalid("视频分P参数无效"))?
        .unwrap_or(1)
        .max(1);
    let (bvid, aid) = if vid[..2].eq_ignore_ascii_case("bv") {
        (vid.to_owned(), 0)
    } else {
        (String::new(), vid[2..].parse().map_err(|_| invalid())?)
    };
    Ok(VideoReference {
        original_url,
        resolved_url,
        bvid,
        aid,
        page,
    })
}

pub fn execute_video(request: &VideoServiceRequest) -> Result<Value, VideoServiceError> {
    let client = BilibiliHttpClient::for_video(
        &request.cookie,
        &request.user_agent,
        &request.referer,
        request.timeout_ms,
    )?;
    let reference = desktop_reference(&request.url, &client)?;
    execute_with_reference(request, reference, &client, |client, url| {
        client.get_video_json(url)
    })
}

fn execute_with_reference(
    request: &VideoServiceRequest,
    reference: VideoReference,
    client: &BilibiliHttpClient,
    fetch: impl FnOnce(
        &BilibiliHttpClient,
        &str,
    ) -> Result<Value, crate::bilibili_service::BilibiliServiceError>,
) -> Result<Value, VideoServiceError> {
    if matches!(request.operation, VideoOperation::Reference) {
        return Ok(json!(reference));
    }
    let query = if reference.bvid.is_empty() {
        format!("aid={}", reference.aid)
    } else {
        url::form_urlencoded::Serializer::new(String::new())
            .append_pair("bvid", &reference.bvid)
            .finish()
    };
    let payload = fetch(client, &format!("{VIEW_ENDPOINT}?{query}"))?;
    if payload.get("code").and_then(Value::as_i64) != Some(0) || !payload["data"].is_object() {
        return Err(NativeVideoError::invalid("B 站接口响应格式异常").into());
    }
    let data = &payload["data"];
    if matches!(request.operation, VideoOperation::Owner) {
        let owner = owner(data);
        return Ok(
            json!({"owner_mid":owner.mid,"owner_name":owner.name,"owner_url":owner_url(owner.mid)}),
        );
    }
    let view = parse_view(data)?;
    let mut id = [0_u8; 6];
    getrandom::fill(&mut id)
        .map_err(|_| NativeVideoError::invalid("设备无法生成安全的点歌标识"))?;
    Ok(json!(assemble(
        request,
        &reference,
        view,
        id.iter().map(|b| format!("{b:02x}")).collect()
    )?))
}

fn reference(input: &str) -> Result<(String, i64), NativeVideoError> {
    static REFERENCE: OnceLock<regex::Regex> = OnceLock::new();
    if input.len() > 4096 {
        return Err(NativeVideoError::invalid("视频链接过长"));
    }
    let pattern = REFERENCE.get_or_init(|| {
        regex::Regex::new(r"(?i)\b(BV[0-9A-Za-z]{10}|av[1-9][0-9]{0,15})\b")
            .expect("reference pattern")
    });
    let identifier = pattern
        .find(input)
        .ok_or_else(|| {
            NativeVideoError::invalid(
                "请输入 BV 号、av 号或包含 BV/av 的完整视频链接；请检查视频号或链接",
            )
        })?
        .as_str();
    let query = if identifier[..2].eq_ignore_ascii_case("bv") {
        format!("bvid=BV{}", &identifier[2..])
    } else {
        format!("aid={}", &identifier[2..])
    };
    // Share text may join the title and URL without any intervening whitespace.
    // Stop at prose punctuation without swallowing a valid query or fragment.
    let link = input
        .find("https://")
        .or_else(|| input.find("http://"))
        .map(|start| {
            input[start..]
                .split(|c: char| c.is_whitespace() || "】》」』\"<>，。".contains(c))
                .next()
                .unwrap_or_default()
        })
        .unwrap_or(input.trim());
    let page = url::Url::parse(link)
        .ok()
        .and_then(|url| {
            url.query_pairs()
                .find(|(key, _)| key == "p")
                .and_then(|(_, value)| value.parse::<i64>().ok())
        })
        .unwrap_or(1)
        .max(1);
    Ok((query, page))
}

pub fn fetch_native_video(
    request: &NativeVideoRequest,
    cookie: &str,
) -> Result<PlaylistItem, NativeVideoError> {
    fetch_native_video_with(request, cookie, |client, url| client.get_video_json(url))
}

fn fetch_native_video_with(
    request: &NativeVideoRequest,
    cookie: &str,
    fetch: impl FnOnce(
        &BilibiliHttpClient,
        &str,
    ) -> Result<Value, crate::bilibili_service::BilibiliServiceError>,
) -> Result<PlaylistItem, NativeVideoError> {
    let shared = VideoServiceRequest {
        operation: VideoOperation::Item,
        url: request.url.clone(),
        selected_video_page: request.selected_video_page,
        selected_audio_pages: json!(request.selected_audio_pages),
        cookie: cookie.into(),
        user_agent: USER_AGENT.into(),
        referer: "https://www.bilibili.com/".into(),
        timeout_ms: 15_000,
    };
    let mut resolved_bvid = String::new();
    let result = (|| {
        let client = BilibiliHttpClient::for_video(cookie, USER_AGENT, &shared.referer, 15_000)?;
        // Preserve the native caller's accepted pasted identifiers; all ordinary
        // desktop forms and allowlisted short links use the shared resolver.
        let resolved = match desktop_reference(&request.url, &client) {
            Ok(r) => r,
            Err(e) if e.kind == "invalid_video" => {
                let (query, page) = reference(&request.url)?;
                let mut r = desktop_reference(
                    &format!(
                        "https://www.bilibili.com/video/{}?p={page}",
                        if query.starts_with("bvid=") {
                            query.trim_start_matches("bvid=").to_owned()
                        } else {
                            format!("av{}", query.trim_start_matches("aid="))
                        }
                    ),
                    &client,
                )?;
                r.original_url = request.url.clone();
                r
            }
            Err(e) => return Err(e),
        };
        resolved_bvid.clone_from(&resolved.bvid);
        execute_with_reference(&shared, resolved, &client, fetch)
    })();
    match result {
        Ok(value) => {
            let mut item: PlaylistItem = serde_json::from_value(value)
                .map_err(|_| NativeVideoError::invalid("B 站视频信息不完整"))?;
            item.original_url = request.url.clone();
            item.cover_url = item.cover_url.replace("http://", "https://");
            item.cache_message = "等待缓存队列".into();
            Ok(item)
        }
        Err(e)
            if e.status_code.is_some()
                || e.api_code.is_some()
                || e.kind != "invalid_video" && e.kind != "manual_binding_required" =>
        {
            let missing = e.api_code == Some(-404) && !resolved_bvid.is_empty();
            let mut error = network_error(crate::bilibili_service::BilibiliServiceError {
                kind: e.kind,
                message: e.message,
                status_code: e.status_code,
                api_code: e.api_code,
            });
            error.missing_bvid = missing.then_some(resolved_bvid);
            Err(error)
        }
        Err(e) => Err(NativeVideoError {
            code: e.kind,
            message: e.message,
            binding: e.binding,
            missing_bvid: None,
        }),
    }
}

fn network_error(error: crate::bilibili_service::BilibiliServiceError) -> NativeVideoError {
    // Do not expose response bodies, request URLs or cookies to other devices.
    let message = match error.api_code {
        Some(-101) => "B 站登录已失效，请在 Host 重新登录".to_owned(),
        Some(-404 | 62002) => "视频不存在或不可访问".to_owned(),
        Some(-352 | -412 | 412) => "B 站暂时限制请求，请稍后重试".to_owned(),
        Some(code) => format!("B 站返回错误 ({code})"),
        None => match error.status_code {
            Some(412 | 429) => "B 站暂时限制请求，请稍后重试（HTTP 412/429）".to_owned(),
            Some(status) => format!("获取视频信息失败（HTTP {status}），请稍后重试"),
            None => format!("无法获取视频信息（{}），请检查网络", error.kind),
        },
    };
    NativeVideoError {
        code: error.kind,
        message,
        binding: None,
        missing_bvid: None,
    }
}

fn assemble(
    request: &VideoServiceRequest,
    reference: &VideoReference,
    view: View,
    id: String,
) -> Result<PlaylistItem, NativeVideoError> {
    let mut seen = HashSet::new();
    if view.pages.is_empty() {
        return Err(NativeVideoError::invalid("视频没有可播放的分 P 信息"));
    }
    if view
        .pages
        .iter()
        .any(|p| p.page <= 0 || p.cid <= 0 || !seen.insert(p.page))
    {
        return Err(NativeVideoError::invalid("B 站分 P 信息无效"));
    }
    let preferred = reference.page.min(view.pages.len() as i64);
    let AudioBindingResult::Decided(decision) = decide_audio_binding(&AudioBindingRequest {
        tolerance_seconds: 3,
        pages: view
            .pages
            .iter()
            .enumerate()
            .map(|(index, p)| AudioPageDescriptor {
                original_index: index,
                page: p.page,
                duration: p.duration,
                part: p.part.clone(),
            })
            .collect(),
    })
    .map_err(|_| NativeVideoError::invalid("分 P 绑定规则无法执行"))?
    else {
        return Err(NativeVideoError::invalid("视频没有可播放的分 P 信息"));
    };
    let manual = decision.mode == AudioBindingMode::ManualRequired;
    let raw_audio = request.selected_audio_pages.as_array();
    if manual && request.selected_video_page.is_none() && raw_audio.is_none_or(Vec::is_empty) {
        return Err(NativeVideoError {
            code: "manual_binding_required".into(),
            missing_bvid: None,
            message: "该视频包含多个分P，请先选择视频和音频绑定关系".into(),
            binding: Some(
                json!({"title":view.title,"preferred_page":preferred,"pages":view.pages}),
            ),
        });
    }
    let mut distinct = HashSet::new();
    let normalized: Vec<i64> = raw_audio
        .into_iter()
        .flatten()
        .filter_map(integer)
        .filter(|p| *p > 0 && distinct.insert(*p))
        .collect();
    let (video_page, selected) = if manual {
        let initial_video = request
            .selected_video_page
            .filter(|p| *p != 0)
            .unwrap_or(preferred);
        if !seen.contains(&initial_video) {
            return Err(NativeVideoError::invalid("选择的视频分P无效"));
        }
        let selected = if normalized.is_empty() {
            vec![initial_video]
        } else {
            normalized
        };
        if selected.iter().any(|p| !seen.contains(p)) {
            return Err(NativeVideoError::invalid("选择的音频分P无效"));
        }
        (
            request
                .selected_video_page
                .filter(|p| *p != 0)
                .unwrap_or(selected[0]),
            selected,
        )
    } else {
        if request.selected_video_page.is_some() || !normalized.is_empty() {
            return Err(NativeVideoError::invalid("当前视频不需要手动绑定分P"));
        }
        let selected: Vec<_> = decision
            .selected_indices
            .iter()
            .map(|&i| view.pages[i].page)
            .collect();
        if selected.is_empty() {
            return Err(NativeVideoError::invalid("至少需要选择一个音频分P"));
        }
        let video = decision
            .automatic_video_index
            .map(|i| view.pages[i].page)
            .unwrap_or_else(|| {
                if selected.contains(&preferred) {
                    preferred
                } else {
                    selected[0]
                }
            });
        (video, selected)
    };
    let selected: Vec<_> = selected
        .iter()
        .map(|n| {
            view.pages
                .iter()
                .find(|p| p.page == *n)
                .expect("validated audio page")
        })
        .collect();
    let video = view
        .pages
        .iter()
        .find(|p| p.page == video_page)
        .ok_or_else(|| NativeVideoError::invalid("选择的视频分P无效"))?;
    let default_index = selected
        .iter()
        .position(|p| p.page == video_page)
        .unwrap_or(0);
    let default_audio = selected[default_index];
    // Replace only the query, as the desktop contract does. Url serialization
    // would also rewrite host casing, explicit ports and literal Unicode paths.
    let (before_fragment, fragment) = reference.resolved_url.split_once('#').map_or(
        (reference.resolved_url.as_str(), None),
        |(base, fragment)| (base, Some(fragment)),
    );
    let (base, query) = before_fragment
        .split_once('?')
        .unwrap_or((before_fragment, ""));
    let pairs = url::form_urlencoded::parse(query.as_bytes()).filter(|(key, _)| key != "p");
    let query = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(pairs)
        .append_pair("p", &video_page.to_string())
        .finish()
        // Python's desktop urlencode uses RFC3986's unreserved tilde; HTML
        // form encoding instead leaves asterisk unescaped.
        .replace("%7E", "~")
        .replace('*', "%2A");
    let resolved = format!(
        "{base}?{query}{}",
        fragment
            .filter(|f| !f.is_empty())
            .map(|f| format!("#{f}"))
            .unwrap_or_default()
    );
    let embed_url = format!(
        "https://player.bilibili.com/player.html?{}",
        url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs([
                ("aid", view.aid.to_string()),
                ("bvid", view.bvid.clone()),
                ("cid", video.cid.to_string()),
                ("page", video_page.to_string()),
                ("high_quality", "1".into()),
                ("danmaku", "0".into()),
                ("autoplay", "1".into()),
                ("isOutside", "true".into())
            ])
            .finish()
    );
    Ok(PlaylistItem {
        id,
        original_url: reference.original_url.clone(),
        resolved_url: resolved,
        bvid: view.bvid,
        aid: view.aid,
        cid: video.cid,
        page: video_page,
        title: view.title.clone(),
        part_title: video.part.clone(),
        display_title: format!("{} - {}", view.title, video.part),
        cover_url: view.pic,
        embed_url,
        selected_pages: selected.iter().map(|p| p.page).collect(),
        selected_cids: selected.iter().map(|p| p.cid).collect(),
        selected_durations: selected.iter().map(|p| p.duration).collect(),
        selected_parts: selected.iter().map(|p| p.part.clone()).collect(),
        available_pages: view.pages.iter().map(|p| p.page).collect(),
        available_cids: view.pages.iter().map(|p| p.cid).collect(),
        available_durations: view.pages.iter().map(|p| p.duration).collect(),
        available_parts: view.pages.iter().map(|p| p.part.clone()).collect(),
        audio_variants: Vec::new(),
        selected_audio_variant_id: crate::cache_runtime::variant_id(
            default_audio.page as u32,
            &default_audio.part,
            default_index,
        ),
        video_page,
        manual_selection: manual,
        owner_mid: view.owner.mid,
        owner_name: view.owner.name,
        owner_url: owner_url(view.owner.mid),
        requester_name: String::new(),
        queue_slot_type: "cycle".into(),
        cache_status: "pending".into(),
        cache_progress: 0.0,
        cache_activity_at: 0.0,
        cache_download_current_bytes: 0,
        cache_download_total_bytes: 0,
        cache_download_tracks: Vec::new(),
        cache_message: "等待缓存".into(),
        video_relative_path: String::new(),
        video_media_url: String::new(),
        item_incarnation_id: String::new(),
        artifact_set_id: String::new(),
        artifact_relative_directory: String::new(),
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_caller_uses_shared_network_parse_and_desktop_binding_contract() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/view", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut byte = [0];
            while !bytes.ends_with(b"\r\n\r\n") {
                socket.read_exact(&mut byte).unwrap();
                bytes.push(byte[0]);
            }
            let request = String::from_utf8(bytes).unwrap().to_lowercase();
            assert!(request.contains("cookie: sessdata=synthetic"));
            let payload = json!({"code":0,"data":{
                "aid":123,"bvid":"BV1xx411c7mD","title":" 歌曲 ","pic":"http://example.invalid/pic",
                "owner":{"mid":42,"name":" UP "},
                "pages":[{"cid":1,"duration":3,"part":"intro"},{"cid":2,"duration":123,"part":" K İ "}]
            }}).to_string();
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
                payload.len()
            )
            .unwrap();
        });
        let request = NativeVideoRequest {
            url: "pasted BV1xx411c7mD-extra".into(),
            ..Default::default()
        };
        let item = fetch_native_video_with(&request, "SESSDATA=synthetic", |client, url| {
            assert_eq!(
                url,
                "https://api.bilibili.com/x/web-interface/wbi/view?bvid=BV1xx411c7mD"
            );
            client.get_video_json(&endpoint)
        })
        .unwrap();
        server.join().unwrap();
        assert_eq!(item.original_url, request.url);
        assert_eq!(item.available_pages, vec![2]);
        assert_eq!(item.video_page, 2);
        assert_eq!(item.selected_audio_variant_id, "p2_k_i");
        assert_eq!(item.owner_name, "UP");
        assert_eq!(item.cover_url, "https://example.invalid/pic");
        assert!(item.embed_url.contains("cid=2&page=2"));
        assert_eq!(item.id.len(), 12);
    }

    #[test]
    fn native_api_error_mapping_and_manual_payload_survive_shared_execution() {
        let request = NativeVideoRequest {
            url: "BV1xx411c7mD".into(),
            ..Default::default()
        };
        let error = fetch_native_video_with(&request, "", |_, _| {
            Err(crate::bilibili_service::BilibiliServiceError {
                kind: "authentication".into(),
                message: "sensitive upstream message".into(),
                api_code: Some(-101),
                status_code: None,
            })
        })
        .unwrap_err();
        assert_eq!(error.code, "authentication");
        assert!(error.message.contains("重新登录"));
        assert!(!error.message.contains("sensitive"));
        let error = fetch_native_video_with(&request, "", |_, _| {
            Ok(json!({"code":0,"data":{
                "aid":1,"bvid":"BV1xx411c7mD","title":"manual",
                "pages":[{"cid":1,"duration":100},{"cid":2,"duration":200}]
            }}))
        })
        .unwrap_err();
        assert_eq!(error.code, "manual_binding_required");
        assert_eq!(
            error.binding.unwrap(),
            json!({"title":"manual","preferred_page":1,"pages":[
                {"cid":1,"page":1,"duration":100,"part":"P1"}, {"cid":2,"page":2,"duration":200,"part":"P2"}
            ]})
        );
    }

    #[test]
    fn desktop_reference_keeps_forms_and_first_nonblank_page_without_network() {
        let client =
            BilibiliHttpClient::for_video("", USER_AGENT, "https://www.bilibili.com/", 15000)
                .unwrap();
        for (input, bvid, aid, page) in [
            ("BV1xx411c7mD", "BV1xx411c7mD", 0, 1),
            ("av123", "", 123, 1),
            (
                "www.bilibili.com/video/bv1xx411c7mD/?p=&p=3&p=4",
                "bv1xx411c7mD",
                0,
                3,
            ),
            ("http://www.bilibili.com/video/av123?p=-2#part", "", 123, 1),
        ] {
            let r = desktop_reference(input, &client).unwrap();
            assert_eq!((r.bvid.as_str(), r.aid, r.page), (bvid, aid, page));
        }
        assert!(desktop_reference("http://localhost/private", &client).is_err());
        assert!(
            desktop_reference("https://www.bilibili.com/video/av123?p=invalid", &client).is_err()
        );
    }

    #[test]
    fn pasted_share_text_keeps_page_and_only_missing_video_carries_deletion_identity() {
        for input in [
            "【Song】https://www.bilibili.com/video/BV1xx411c7mD?p=2",
            "分享https://www.bilibili.com/video/BV1xx411c7mD?p=2。更多",
            "Song https://www.bilibili.com/video/BV1xx411c7mD?p=2 https://www.bilibili.com/video/av123?p=3",
        ] {
            assert_eq!(reference(input).unwrap().1, 2, "{input}");
        }
        assert_eq!(
            reference("【Song】 https://www.bilibili.com/video/BV1xx411c7mD?p=2")
                .unwrap()
                .1,
            2
        );
        let request = NativeVideoRequest {
            url: "BV1xx411c7mD".into(),
            ..Default::default()
        };
        for code in [-404, -101, -412, 62002] {
            let failure = fetch_native_video_with(&request, "", |_, _| {
                Err(crate::bilibili_service::BilibiliServiceError {
                    kind: "api".into(),
                    message: "fixture".into(),
                    status_code: None,
                    api_code: Some(code),
                })
            })
            .unwrap_err();
            assert_eq!(
                failure.missing_bvid.as_deref(),
                (code == -404).then_some("BV1xx411c7mD")
            );
            assert!(
                !serde_json::to_string(&failure)
                    .unwrap()
                    .contains("missing_bvid")
            );
        }
    }
    #[test]
    fn uses_current_metadata_api_and_reports_only_safe_upstream_errors() {
        assert_eq!(
            VIEW_ENDPOINT,
            "https://api.bilibili.com/x/web-interface/wbi/view"
        );
        let error = network_error(crate::bilibili_service::BilibiliServiceError {
            kind: "http".into(),
            message: "private URL and cookie must not escape".into(),
            status_code: Some(412),
            api_code: None,
        });
        assert!(error.message.contains("暂时限制"));
        assert!(!error.message.contains("private"));
    }
    fn assemble(
        request: &NativeVideoRequest,
        preferred: i64,
        view: View,
        id: String,
    ) -> Result<PlaylistItem, NativeVideoError> {
        let shared = VideoServiceRequest {
            operation: VideoOperation::Item,
            url: request.url.clone(),
            selected_video_page: request.selected_video_page,
            selected_audio_pages: json!(request.selected_audio_pages),
            cookie: String::new(),
            user_agent: USER_AGENT.into(),
            referer: String::new(),
            timeout_ms: 15000,
        };
        let reference = VideoReference {
            original_url: request.url.clone(),
            resolved_url: "https://www.bilibili.com/video/BV1z84y1p7oS".into(),
            bvid: String::new(),
            aid: 1,
            page: preferred,
        };
        super::assemble(&shared, &reference, view, id)
    }
    fn view(parts: &[(&str, i64)]) -> View {
        View {
            aid: 1,
            bvid: "BV1z84y1p7oS".into(),
            title: "Test".into(),
            pic: String::new(),
            owner: Owner::default(),
            pages: parts
                .iter()
                .enumerate()
                .map(|(i, (label, duration))| Page {
                    page: i as i64 + 1,
                    cid: i as i64 + 100,
                    duration: *duration,
                    part: (*label).into(),
                })
                .collect(),
        }
    }
    #[test]
    fn extracts_only_identifiers_never_a_client_network_target() {
        assert_eq!(
            reference("https://www.bilibili.com/video/BV1z84y1p7oS?p=2").unwrap(),
            ("bvid=BV1z84y1p7oS".into(), 2)
        );
        assert_eq!(reference("av12345").unwrap().0, "aid=12345");
        assert!(reference("http://127.0.0.1/private").is_err());
        assert!(reference("https://b23.tv/short").is_err());
        assert!(reference("BV1z84y1p7oS-extra").is_ok());
        assert!(reference("BV1z84y1p7oSx").is_err());
    }
    #[test]
    fn single_page_and_auto_pair_use_existing_domain_rules() {
        let request = NativeVideoRequest::default();
        let single = assemble(&request, 1, view(&[("Song", 123)]), "single".into()).unwrap();
        assert_eq!(single.selected_pages, vec![1]);
        assert!(!single.manual_selection);
        let pair = assemble(
            &request,
            1,
            view(&[("Off Vocal", 123), ("On Vocal", 123)]),
            "pair".into(),
        )
        .unwrap();
        assert_eq!(pair.video_page, 2);
        assert_eq!(pair.selected_pages, vec![1, 2]);
        assert_eq!(pair.selected_audio_variant_id, "p2_on_vocal");
    }
    #[test]
    fn manual_binding_roundtrip_preserves_available_pages() {
        let request = NativeVideoRequest::default();
        let err = assemble(
            &request,
            2,
            view(&[("A", 100), ("B", 200), ("C", 300)]),
            "id".into(),
        )
        .unwrap_err();
        assert_eq!(err.code, "manual_binding_required");
        assert_eq!(err.binding.unwrap()["preferred_page"], 2);
        let request = NativeVideoRequest {
            selected_video_page: Some(2),
            selected_audio_pages: Some(vec![1, 3, 1]),
            ..request
        };
        let item = assemble(
            &request,
            1,
            view(&[("A", 100), ("B", 200), ("C", 300)]),
            "id".into(),
        )
        .unwrap();
        assert_eq!(item.selected_pages, vec![1, 3]);
        assert_eq!(item.available_pages, vec![1, 2, 3]);
        assert_eq!(item.cid, 101);
    }
    #[test]
    fn invalid_selection_and_metadata_fail_before_queueing() {
        let request = NativeVideoRequest {
            selected_video_page: Some(99),
            ..Default::default()
        };
        assert!(assemble(&request, 1, view(&[("A", 100), ("B", 200)]), "id".into()).is_err());
        assert!(assemble(&request, 1, view(&[("A", 100)]), "id".into()).is_err());
        let mut malformed = view(&[("A", 100), ("B", 100)]);
        malformed.pages[1].page = 1;
        assert!(assemble(&NativeVideoRequest::default(), 1, malformed, "id".into()).is_err());
    }
}
