//! Native Host metadata I/O and adaptation to the canonical Rust page-binding
//! policy. No downloader subprocess, Python rule mirror, or client-supplied
//! network destination is involved.
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

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct NativeVideoError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binding: Option<Value>,
}

impl NativeVideoError {
    fn invalid(message: &str) -> Self {
        Self {
            code: "invalid_video".into(),
            message: message.into(),
            binding: None,
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

#[derive(Debug, Deserialize)]
struct View {
    aid: i64,
    bvid: String,
    title: String,
    #[serde(default)]
    pic: String,
    pages: Vec<Page>,
    #[serde(default)]
    owner: Owner,
}

#[derive(Debug, Default, Deserialize)]
struct Owner {
    #[serde(default)]
    mid: i64,
    #[serde(default)]
    name: String,
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
                "请输入 BV 号、av 号或包含 BV/av 的完整视频链接；Alpha 暂不解析短链接",
            )
        })?
        .as_str();
    let query = if identifier[..2].eq_ignore_ascii_case("bv") {
        format!("bvid=BV{}", &identifier[2..])
    } else {
        format!("aid={}", &identifier[2..])
    };
    let page = url::Url::parse(input.trim())
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
    let (query, preferred) = reference(&request.url)?;
    let client = BilibiliHttpClient::new(cookie, USER_AGENT, "https://www.bilibili.com/", 15_000)
        .map_err(network_error)?;
    let value = client
        .get_api_json(&format!("{VIEW_ENDPOINT}?{query}"), "获取视频信息失败")
        .map_err(network_error)?;
    let view: View = serde_json::from_value(value.get("data").cloned().unwrap_or(Value::Null))
        .map_err(|_| NativeVideoError::invalid("B 站视频信息不完整"))?;
    let mut id = [0_u8; 16];
    getrandom::fill(&mut id)
        .map_err(|_| NativeVideoError::invalid("设备无法生成安全的点歌标识"))?;
    assemble(
        request,
        preferred,
        view,
        id.iter().map(|byte| format!("{byte:02x}")).collect(),
    )
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
    }
}

fn assemble(
    request: &NativeVideoRequest,
    preferred: i64,
    view: View,
    id: String,
) -> Result<PlaylistItem, NativeVideoError> {
    let mut seen = HashSet::new();
    if view.aid <= 0
        || view.bvid.len() != 12
        || !view.bvid.starts_with("BV")
        || view.pages.is_empty()
        || view.pages.len() > 1000
        || view.title.len() > 4096
        || view.pages.iter().any(|p| {
            p.page <= 0
                || p.cid <= 0
                || p.duration < 0
                || p.part.len() > 4096
                || !seen.insert(p.page)
        })
    {
        return Err(NativeVideoError::invalid("B 站分 P 信息无效"));
    }
    let preferred = if seen.contains(&preferred) {
        preferred
    } else {
        view.pages[0].page
    };
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
        return Err(NativeVideoError::invalid("视频没有可播放的分 P"));
    };
    let manual = decision.mode == AudioBindingMode::ManualRequired;
    let selected = request.selected_audio_pages.clone().unwrap_or_default();
    if manual && request.selected_video_page.is_none() && selected.is_empty() {
        return Err(NativeVideoError {
            code: "manual_binding_required".into(),
            message: "请选择视频和音频分 P".into(),
            binding: Some(
                json!({"title":view.title,"preferred_page":preferred,"pages":view.pages}),
            ),
        });
    }
    if !manual && (request.selected_video_page.is_some() || !selected.is_empty()) {
        return Err(NativeVideoError::invalid("当前视频不需要手动绑定分 P"));
    }
    let video_page = if manual {
        request.selected_video_page.unwrap_or(preferred)
    } else {
        decision
            .automatic_video_index
            .map(|i| view.pages[i].page)
            .unwrap_or(preferred)
    };
    let selected = if manual {
        if selected.is_empty() {
            vec![video_page]
        } else {
            selected
        }
    } else {
        decision
            .selected_indices
            .iter()
            .map(|&i| view.pages[i].page)
            .collect()
    };
    if !seen.contains(&video_page)
        || selected.is_empty()
        || selected.len() > 32
        || selected.iter().any(|p| !seen.contains(p))
    {
        return Err(NativeVideoError::invalid(
            "选择的分 P 无效，一次最多绑定 32 个音轨",
        ));
    }
    let mut distinct = HashSet::new();
    let selected: Vec<_> = selected
        .iter()
        .filter(|&&p| distinct.insert(p))
        .map(|p| {
            view.pages
                .iter()
                .find(|page| page.page == *p)
                .expect("validated page")
        })
        .collect();
    let video = view
        .pages
        .iter()
        .find(|p| p.page == video_page)
        .expect("validated video page");
    let default_index = selected
        .iter()
        .position(|p| p.page == video_page)
        .unwrap_or(0);
    let default_audio = selected[default_index];
    let resolved = format!(
        "https://www.bilibili.com/video/{}?p={video_page}",
        view.bvid
    );
    Ok(PlaylistItem {
        id,
        original_url: request.url.clone(),
        resolved_url: resolved,
        bvid: view.bvid,
        aid: view.aid,
        cid: video.cid,
        page: video_page,
        title: view.title.clone(),
        part_title: video.part.clone(),
        display_title: format!("{} - {}", view.title, video.part),
        cover_url: view.pic.replace("http://", "https://"),
        embed_url: String::new(),
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
        owner_url: if view.owner.mid > 0 {
            format!("https://space.bilibili.com/{}", view.owner.mid)
        } else {
            String::new()
        },
        requester_name: String::new(),
        queue_slot_type: "cycle".into(),
        cache_status: "pending".into(),
        cache_progress: 0.0,
        cache_message: "等待 Rust 缓存队列".into(),
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
