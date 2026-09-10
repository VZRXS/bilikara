//! In-process adapter for the existing native cache workers. Every event is
//! applied through its reserved AppState attempt token; no Python event pump.
use super::*;
use crate::cache_runtime::{CacheJobSpec, CacheRuntimeCommand, execute_cache_runtime};
use crate::{AppStateRequest, CacheEvent, PlaylistItem};
use bilikara_rust::{CacheItem, CachePlanRequest, plan_cache_window};
use std::collections::HashMap;

pub(super) fn start_pump(context: Arc<HostContext>) -> Result<(), ApiError> {
    execute_cache_runtime(CacheRuntimeCommand::Start {}).map_err(cache_error)?;
    thread::Builder::new().name("native-host-cache".into()).spawn(move||{
        let mut fingerprint=String::new();
        let mut last_error=String::new();
        while !context.stop.load(Ordering::Acquire){
            if let Err(error)=tick(&context,&mut fingerprint) && error.to_string()!=last_error {
                last_error=error.to_string();let _=with_app(|app|{app.native_diagnostic(&json!({"event":"native-cache-error","kind":error.code,"message":error.message}),now());Ok(())});
            }
            thread::sleep(Duration::from_millis(200));
        }
        let _=execute_cache_runtime(CacheRuntimeCommand::Shutdown{});
    }).map_err(|_|ApiError::new(503,"cache_start","无法启动媒体缓存服务"))?;
    Ok(())
}

fn cache_error(error: crate::CacheRuntimeError) -> ApiError {
    ApiError::new(503, "cache", format!("Rust 缓存服务：{}", error.message))
}

fn tick(context: &HostContext, last_fingerprint: &mut String) -> Result<(), ApiError> {
    let events = execute_cache_runtime(CacheRuntimeCommand::DrainEvents { max_events: 128 })
        .map_err(cache_error)?;
    if let Some(events) = events["events"].as_array() {
        for event in events {
            apply_event(event)?;
        }
    }
    let (snapshot, cookie) =
        with_app(|app| Ok((app.native_core_snapshot()?, app.native().cookie.clone())))?;
    let items: Vec<_> = snapshot
        .current_item
        .iter()
        .chain(snapshot.playlist.iter())
        .collect();
    // Do not resubmit on every progress/status observation. Failure stays failed
    // until explicit retry, avoiding an unbounded Bilibili request loop.
    let fingerprint = items
        .iter()
        .map(|item| {
            format!(
                "{}:{}:{}",
                item.id, item.item_incarnation_id, item.cache_status
            )
        })
        .collect::<Vec<_>>()
        .join("|");
    if fingerprint == *last_fingerprint {
        return Ok(());
    }
    let runtime = execute_cache_runtime(CacheRuntimeCommand::Snapshot {}).map_err(cache_error)?;
    let known = |value: &str| items.iter().any(|item| item.id == value);
    let ids = |key: &str| -> Vec<String> {
        runtime[key]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|id| known(id))
            .map(str::to_owned)
            .collect()
    };
    let active = ids("active_item_ids");
    let primary = runtime["primary_active_item_id"]
        .as_str()
        .filter(|id| active.iter().any(|item| item == id))
        .map(str::to_owned);
    let plan = plan_cache_window(CachePlanRequest {
        items: items
            .iter()
            .enumerate()
            .map(|(index, item)| CacheItem {
                original_index: index,
                item_id: item.id.clone(),
                cache_ready: item.cache_status == "ready",
            })
            .collect(),
        max_items: 3,
        retention_limit: 0,
        active_item_ids: active,
        primary_active_item_id: primary,
        urgent_item_ids: ids("urgent_item_ids"),
    })
    .map_err(|_| ApiError::new(500, "cache_plan", "Rust 缓存规划失败"))?;
    let jobs = items
        .iter()
        .filter(|item| plan.desired_ids.contains(&item.id) && item.cache_status != "failed")
        .map(|item| job(context, item, &cookie))
        .collect::<Result<Vec<_>, _>>()?;
    execute_cache_runtime(CacheRuntimeCommand::Sync {
        cache_root: context.cache_root.clone(),
        current_ids: items.iter().map(|item| item.id.clone()).collect(),
        current_item_incarnations: items
            .iter()
            .map(|item| (item.id.clone(), item.item_incarnation_id.clone()))
            .collect::<HashMap<_, _>>(),
        retained_ids: plan.retained_ids,
        jobs,
        ordered_ids: plan.pending_order,
        preempt_item_id: plan.preempt_ids.first().cloned().unwrap_or_default(),
    })
    .map_err(cache_error)?;
    *last_fingerprint = fingerprint;
    Ok(())
}

fn apply_event(event: &Value) -> Result<(), ApiError> {
    let Some(item_id) = event["item_id"].as_str() else {
        return Ok(());
    };
    let Some(token) = event["cache_attempt_token"].as_u64().filter(|v| *v > 0) else {
        return Ok(());
    };
    let payload = &event["payload"];
    let projection = match event["kind"].as_str().unwrap_or("") {
        "queued" => CacheEvent::Queued {
            message: "等待 Rust 缓存队列".into(),
        },
        "started" => CacheEvent::Started {
            message: "正在下载视频及音轨".into(),
        },
        "progress" => {
            let track = &payload["track"];
            let current = track["current_bytes"].as_f64().unwrap_or(0.0);
            let total = track["target_bytes"].as_f64().unwrap_or(0.0);
            let progress = if total > 0.0 {
                (100.0 * current / total).clamp(0.0, 99.0)
            } else {
                0.0
            };
            CacheEvent::Progress {
                progress,
                message: Some(format!(
                    "{}：{}%",
                    track["label"].as_str().unwrap_or("下载中"),
                    progress as u32
                )),
            }
        }
        "ready" => {
            let mut ready = payload.clone();
            ready["kind"] = json!("ready");
            ready["message"] = json!("已就绪");
            serde_json::from_value(ready)
                .map_err(|_| ApiError::new(500, "cache_event", "缓存完成消息无效"))?
        }
        "failed" => CacheEvent::Failed {
            message: payload["message"]
                .as_str()
                .unwrap_or("媒体下载失败，请查看诊断或重试")
                .chars()
                .take(400)
                .collect(),
        },
        "cancelled" => CacheEvent::Cancelled {
            message: "缓存任务已取消".into(),
        },
        "evicted" => CacheEvent::Evicted {
            message: "等待进入缓存窗口".into(),
        },
        _ => return Ok(()),
    };
    with_app(|app| {
        let response = app.execute(AppStateRequest::ApplyCacheEvent {
            schema_version: 1,
            item_id: item_id.into(),
            cache_attempt_token: token,
            event: projection,
            now: now(),
        });
        if let Some(error) = response.error()
            && ![
                "item_not_found",
                "cache_attempt_stale",
                "cache_attempt_not_found",
                "cache_attempt_mismatch",
            ]
            .contains(&error.kind.as_str())
        {
            app.native_diagnostic(
                &json!({"event":"cache-projection-rejected","kind":error.kind}),
                now(),
            );
        }
        Ok(())
    })
}

fn job(context: &HostContext, item: &PlaylistItem, cookie: &str) -> Result<CacheJobSpec, ApiError> {
    let pages=item.available_pages.iter().enumerate().filter(|(_,page)|item.selected_pages.contains(page)||**page==item.video_page).map(|(index,page)|json!({"page":page,"cid":item.available_cids.get(index),"duration_seconds":item.available_durations.get(index),"label":item.available_parts.get(index)})).collect::<Vec<_>>();
    serde_json::from_value(json!({
        "schema_version":1,"item_id":item.id,"item_incarnation_id":item.item_incarnation_id,"bvid":item.bvid,"aid":item.aid,
        "video_page":item.video_page,"pages":pages,"cache_root":context.cache_root,"log_file":context.directory.join("logs/native-cache.log"),
        "cookie":cookie,"user_agent":crate::native_video::USER_AGENT,"referer":"https://www.bilibili.com/","timeout_ms":15000,
        "video_quality":"720P","avc_quality_cap":"720P","audio_hires":false,"selected_audio_variant_id":item.selected_audio_variant_id,
        "reported_ready":item.cache_status=="ready","existing_video_relative_path":item.video_relative_path,
        "existing_audio_variants":item.audio_variants.iter().map(|variant|json!({"id":variant.get("id"),"label":variant.get("label"),"page":variant.get("page"),"relative_path":variant.get("audio_url").and_then(Value::as_str).unwrap_or("").trim_start_matches("/media/")})).collect::<Vec<_>>()
    })).map_err(|_|ApiError::new(500,"cache_job","歌曲缺少原生缓存所需的分 P 信息"))
}

pub(super) fn retry(
    context: &HostContext,
    item: &PlaylistItem,
    cookie: &str,
) -> Result<(), ApiError> {
    execute_cache_runtime(CacheRuntimeCommand::Retry {
        job: job(context, item, cookie)?,
        urgent: true,
    })
    .map_err(cache_error)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_malformed_ready_message_without_mutating_state() {
        assert!(
            apply_event(
                &json!({"item_id":"id","cache_attempt_token":1,"kind":"ready","payload":{}})
            )
            .is_err()
        );
        assert!(
            apply_event(
                &json!({"item_id":"id","cache_attempt_token":0,"kind":"ready","payload":{}})
            )
            .is_ok()
        );
    }
}
