//! Restore missing uploader metadata after loading desktop records. Network
//! work runs outside AppState; the existing command owns all record updates.
use super::*;
use crate::app_state::{AppSnapshot, AppStateRequest};
use crate::native_video::{VideoOperation, VideoServiceRequest, execute_video};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap};

fn missing_urls(snapshot: &AppSnapshot) -> BTreeSet<String> {
    let items = snapshot
        .current_item
        .iter()
        .chain(&snapshot.playlist)
        .map(|i| (&i.owner_name, &i.resolved_url, &i.original_url));
    let history = snapshot
        .history
        .iter()
        .chain(&snapshot.session_history)
        .map(|i| (&i.owner_name, &i.resolved_url, &i.original_url));
    let played = snapshot
        .session_played
        .iter()
        .map(|i| (&i.owner_name, &i.resolved_url, &i.original_url));
    items
        .chain(history)
        .chain(played)
        .filter(|(name, _, _)| name.trim().is_empty())
        .map(|(_, resolved, original)| {
            if resolved.trim().is_empty() {
                original
            } else {
                resolved
            }
        })
        .filter(|url| !url.trim().is_empty())
        .cloned()
        .collect()
}

const STARTUP_BUDGET: usize = 32;
const RETRY_SECONDS: f64 = 24.0 * 60.0 * 60.0;

fn url_key(url: &str) -> String {
    format!("{:x}", Sha256::digest(url.as_bytes()))
}

fn eligible(urls: BTreeSet<String>, attempts: &HashMap<String, f64>, now: f64) -> Vec<String> {
    let mut urls: Vec<_> = urls
        .into_iter()
        .filter(|url| {
            attempts
                .get(&url_key(url))
                .is_none_or(|at| now - at >= RETRY_SECONDS)
        })
        .collect();
    // Previously untouched records precede retries, so broken old videos cannot
    // starve all remaining history on every launch.
    urls.sort_by(|a, b| {
        attempts
            .get(&url_key(a))
            .unwrap_or(&0.0)
            .total_cmp(attempts.get(&url_key(b)).unwrap_or(&0.0))
            .then_with(|| a.cmp(b))
    });
    urls.truncate(STARTUP_BUDGET);
    urls
}

fn record_attempt(context: &HostContext, url: &str) -> Result<(), ApiError> {
    with_app(|app| {
        let mut next = app.native().owner_enrichment_attempts.clone();
        let now = now();
        next.retain(|_, at| now - *at < 30.0 * RETRY_SECONDS);
        next.insert(url_key(url), now);
        let bytes = serde_json::to_vec(&next).map_err(|_| ApiError::invalid("无法保存补全进度"))?;
        let pending = context.directory.join("owner-enrichment.pending");
        std::fs::write(&pending, bytes)
            .and_then(|_| {
                std::fs::rename(&pending, context.directory.join("owner-enrichment.json"))
            })
            .map_err(|_| ApiError::new(503, "owner_enrichment_storage", "无法保存补全进度"))?;
        app.native().owner_enrichment_attempts = next;
        Ok(())
    })
}

pub(super) fn start(context: Arc<HostContext>) -> Result<(), ApiError> {
    let attempts: HashMap<String, f64> =
        std::fs::read(context.directory.join("owner-enrichment.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
    let urls = with_app(|app| {
        app.native().owner_enrichment_attempts = attempts
            .into_iter()
            .filter(|(key, at)| {
                key.len() == 64
                    && key.bytes().all(|c| c.is_ascii_hexdigit())
                    && at.is_finite()
                    && *at <= now()
            })
            .collect();
        Ok(eligible(
            missing_urls(&app.native_core_snapshot()?),
            &app.native().owner_enrichment_attempts,
            now(),
        ))
    })?;
    context
        .clone()
        .spawn("native-owner-enrichment", move || {
            for url in urls {
                if context.stop.load(Ordering::Acquire) {
                    break;
                }
                if record_attempt(&context, &url).is_err() {
                    break;
                }
                let Ok(cookie) = with_app(|app| Ok(app.native().cookie.clone())) else {
                    break;
                };
                let Ok(owner) = execute_video(&VideoServiceRequest {
                    operation: VideoOperation::Owner,
                    url: url.clone(),
                    selected_video_page: None,
                    selected_audio_pages: Value::Null,
                    cookie,
                    user_agent: crate::native_video::USER_AGENT.into(),
                    referer: "https://www.bilibili.com/".into(),
                    timeout_ms: 8_000,
                }) else {
                    continue;
                };
                let (Some(mid), Some(name), Some(owner_url)) = (
                    owner["owner_mid"].as_i64(),
                    owner["owner_name"].as_str(),
                    owner["owner_url"].as_str(),
                ) else {
                    continue;
                };
                if mid <= 0 || name.trim().is_empty() {
                    continue;
                }
                let _ = with_app(|app| {
                    if context.stop.load(Ordering::Acquire) {
                        return Ok(());
                    }
                    app.native_execute(AppStateRequest::UpdateOwnerInfo {
                        schema_version: 1,
                        source_url: url,
                        owner_mid: mid,
                        owner_name: name.into(),
                        owner_url: owner_url.into(),
                        now: now(),
                    })?;
                    Ok(())
                });
            }
        })
        .map_err(|_| ApiError::new(503, "owner_enrichment", "无法启动 UP 信息补全"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn failed_history_is_backed_off_and_budget_favors_untouched_records() {
        let urls: BTreeSet<_> = (0..100).map(|i| format!("url-{i:03}")).collect();
        let mut attempts = HashMap::new();
        attempts.insert(url_key("url-000"), 100.0);
        let first = eligible(urls.clone(), &attempts, 200.0);
        assert_eq!(first.len(), STARTUP_BUDGET);
        assert!(!first.contains(&"url-000".into()));
        let later = eligible(urls, &attempts, RETRY_SECONDS + 200.0);
        assert_eq!(later[0], "url-001");
        assert_eq!(
            eligible(
                BTreeSet::from(["url-000".into()]),
                &attempts,
                RETRY_SECONDS + 200.0
            ),
            vec!["url-000"]
        );
    }

    #[test]
    fn startup_work_deduplicates_missing_owners_across_all_projections() {
        let mut app = crate::app_state::AppState::default();
        let item = json!({"id":"song","original_url":"https://www.bilibili.com/video/BV1z84y1p7oS","resolved_url":"https://www.bilibili.com/video/BV1z84y1p7oS?p=1","bvid":"BV1z84y1p7oS","aid":1,"cid":2,"title":"Song","part_title":"Song","display_title":"Song","cover_url":"","embed_url":""});
        let seed = serde_json::from_value(json!({"current_item":item,"playlist":[],"session_started_at":1,"session_played_file":"played.json","updated_at":1})).unwrap();
        app.execute(AppStateRequest::Initialize {
            schema_version: 1,
            state: Box::new(seed),
        });
        let urls = missing_urls(&app.native_core_snapshot().unwrap());
        assert_eq!(urls.len(), 1);
        app.native_execute(AppStateRequest::UpdateOwnerInfo {
            schema_version: 1,
            source_url: urls.first().unwrap().clone(),
            owner_mid: 42,
            owner_name: "UP".into(),
            owner_url: "https://space.bilibili.com/42".into(),
            now: 2.0,
        })
        .unwrap();
        assert!(missing_urls(&app.native_core_snapshot().unwrap()).is_empty());
    }
}
