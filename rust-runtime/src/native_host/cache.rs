//! In-process adapter for the existing native cache workers. Every event is
//! applied through its reserved AppState attempt token; no Python event pump.
use super::preferences::{CachePolicy, MediaSelection};
use super::*;
use crate::PlaylistItem;
use crate::cache_runtime::{CacheJobSpec, CacheRuntimeCommand, execute_cache_runtime};
use bilikara_rust::{CacheItem, CachePlanRequest, plan_cache_window};
use std::collections::HashMap;

pub(super) fn start_pump(context: Arc<HostContext>) -> Result<(), ApiError> {
    execute_cache_runtime(CacheRuntimeCommand::Start {}).map_err(cache_error)?;
    context.clone().spawn("native-host-cache", move||{
        let mut fingerprint=String::new();
        let mut selections=HashMap::new();
        let mut last_error=String::new();
        let mut last_cleanup=std::time::Instant::now();
        let mut last_metrics=None::<std::time::Instant>;
        while !context.stop.load(Ordering::Acquire){
            let _ = with_app(|app| {
                if app.native().updates.expire(now()) { app.native().revision += 1; }
                Ok(())
            });
            if let Err(error)=tick(&context,&mut fingerprint,&mut selections) && error.to_string()!=last_error {
                last_error=error.to_string();let _=with_app(|app|{app.native_diagnostic(&json!({"event":"native-cache-error","kind":error.code,"message":error.message}),now());Ok(())});
            }
            if last_cleanup.elapsed() >= Duration::from_secs(10) {
                if maintenance::collect(&context.cache_root, false).is_err() {
                    let _=with_app(|app|{app.native_diagnostic(&json!({"event":"native-cache-cleanup-failed"}),now());Ok(())});
                }
                last_cleanup=std::time::Instant::now();
            }
            if last_metrics.is_none_or(|at| at.elapsed() >= Duration::from_secs(2)) {
                if let Ok(bytes) = usage_bytes(&context.cache_root) {
                    let _ = with_app(|app| {
                        if app.native().cache_usage_bytes != bytes {
                            app.native().cache_usage_bytes = bytes;
                            app.native().revision += 1;
                        }
                        Ok(())
                    });
                }
                last_metrics=Some(std::time::Instant::now());
            }
            thread::sleep(Duration::from_millis(200));
        }
        let _=execute_cache_runtime(CacheRuntimeCommand::Shutdown{});
    }).map_err(|_|ApiError::new(503,"cache_start","无法启动媒体缓存服务"))?;
    Ok(())
}

// Operational metadata sampling off the AppState lock, at most once per 2s.
// Include partial/stale downloads in disk usage, never follow links outside the
// private media directory, and bound malformed directory trees.
fn usage_bytes(root: &Path) -> std::io::Result<u64> {
    let mut pending = vec![(root.to_path_buf(), 0)];
    let mut total = 0_u64;
    let mut entries_seen = 0;
    while let Some((directory, depth)) = pending.pop() {
        for entry in std::fs::read_dir(directory)? {
            let entry = entry?;
            entries_seen += 1;
            if entries_seen > 100_000 {
                return Err(std::io::Error::other("cache metrics entry limit exceeded"));
            }
            let metadata = std::fs::symlink_metadata(entry.path())?;
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_file() {
                total = total.saturating_add(metadata.len());
            } else if metadata.is_dir() && depth < 8 {
                pending.push((entry.path(), depth + 1));
            }
        }
    }
    Ok(total)
}

fn cache_error(error: crate::CacheRuntimeError) -> ApiError {
    ApiError::new(503, "cache", format!("Rust 缓存服务：{}", error.message))
}

fn tick(
    context: &HostContext,
    last_fingerprint: &mut String,
    selections: &mut HashMap<String, (String, MediaSelection, bool)>,
) -> Result<(), ApiError> {
    if with_app(|app| Ok(app.native_session_choice_pending()))? {
        return Ok(());
    }
    let processed = crate::cache_runtime::process_cache_events(
        crate::cache_application::HostContract::Native,
        128,
    )
    .map_err(cache_error)?;
    if processed.effects.cancelled {
        last_fingerprint.clear();
    }
    for error in processed.effects.errors {
        if ![
            "item_not_found",
            "cache_attempt_stale",
            "cache_attempt_not_found",
            "cache_attempt_mismatch",
        ]
        .contains(&error.kind.as_str())
        {
            with_app(|app| {
                app.native_diagnostic(
                    &json!({"event":"cache-projection-rejected","kind":error.kind}),
                    now(),
                );
                Ok(())
            })?;
        }
    }
    let (snapshot, cookie, policy, player) = with_app(|app| {
        Ok((
            app.native_core_snapshot()?,
            app.native().cookie.clone(),
            app.native().cache_policy.clone(),
            app.native().player_media.clone(),
        ))
    })?;
    let effective = MediaSelection::new(&policy, &player, context.desktop);
    let usable = policy.available_with(
        context.desktop && context.bbdown.is_some(),
        context.desktop && context.aria2().is_some(),
    ) && (!context.desktop
        || (player.usable()
            || policy.download_source == "downkyi" && player.details["hevc_supported"] == true));
    let items: Vec<_> = snapshot
        .current_item
        .iter()
        .chain(snapshot.playlist.iter())
        .collect();
    // Do not resubmit on every progress/status observation. Failure stays failed
    // until explicit retry, avoiding an unbounded Bilibili request loop.
    let fingerprint = format!(
        "{}:{effective:?}:{usable}:{}",
        policy.snapshot(),
        items
            .iter()
            .map(|item| {
                format!(
                    "{}:{}:{}",
                    item.id, item.item_incarnation_id, item.cache_status
                )
            })
            .collect::<Vec<_>>()
            .join("|")
    );
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
        max_items: if usable { policy.max_cache_items } else { 0 },
        retention_limit: 0,
        active_item_ids: active,
        primary_active_item_id: primary,
        urgent_item_ids: ids("urgent_item_ids"),
    })
    .map_err(|_| ApiError::new(500, "cache_plan", "Rust 缓存规划失败"))?;
    selections.retain(|id, (incarnation, _, _)| {
        items
            .iter()
            .any(|item| &item.id == id && &item.item_incarnation_id == incarnation)
    });
    // Leaving the retained window invalidates the AppState reader. Re-entry
    // needs a fresh attempt even if the runtime still remembers old artifacts.
    for (id, (_, _, retained)) in selections.iter_mut() {
        if !plan.retained_ids.contains(id) {
            *retained = false;
        }
    }
    // Retry is the existing replacement-attempt path: it cancels old work,
    // reserves a new AppState token, and keeps readable artifacts until publish.
    // This map tracks only which effective inputs this pump has submitted.
    let mut replaced = Vec::new();
    if context.desktop && usable {
        for item in items
            .iter()
            .filter(|item| plan.desired_ids.contains(&item.id))
        {
            if selections
                .get(&item.id)
                .is_some_and(|(_, old, retained)| !retained || effective.changes_artifact(old))
            {
                execute_cache_runtime(CacheRuntimeCommand::Retry {
                    job: job(context, item, &cookie, &policy, &effective)?,
                    urgent: false,
                })
                .map_err(cache_error)?;
                replaced.push(item.id.clone());
            }
            selections.insert(
                item.id.clone(),
                (item.item_incarnation_id.clone(), effective.clone(), true),
            );
        }
    }
    let jobs = items
        .iter()
        .filter(|item| {
            plan.desired_ids.contains(&item.id)
                && (item.cache_status != "failed" || replaced.contains(&item.id))
        })
        .map(|item| job(context, item, &cookie, &policy, &effective))
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

fn item_log_path(directory: &Path, item_id: &str) -> Result<PathBuf, ApiError> {
    // Imported identifiers must never turn a per-song log into a path outside logs.
    if item_id.is_empty()
        || item_id.len() > 160
        || item_id.contains(['/', '\\', ':'])
        || matches!(item_id, "." | "..")
        || item_id.chars().any(char::is_control)
    {
        return Err(ApiError::invalid("缓存歌曲标识无效"));
    }
    let root = directory.join("logs/native");
    std::fs::create_dir_all(&root)
        .map_err(|_| ApiError::new(503, "cache_log", "无法创建缓存日志目录"))?;
    Ok(root.join(format!("{item_id}.log")))
}

fn job(
    context: &HostContext,
    item: &PlaylistItem,
    cookie: &str,
    policy: &CachePolicy,
    effective: &MediaSelection,
) -> Result<CacheJobSpec, ApiError> {
    let executor = match policy.download_source.as_str() {
        "native" => crate::cache_runtime::Executor::Native,
        "downkyi" if context.desktop => crate::cache_runtime::Executor::Downkyi {
            executable: context.aria2().ok_or_else(|| {
                ApiError::new(501, "aria2_unavailable", "DownKyi/aria2c unavailable")
            })?,
            force_avc: effective.force_avc,
        },
        "bbdown" if context.desktop => crate::cache_runtime::Executor::Bbdown {
            executable: context.bbdown.clone().ok_or_else(|| {
                ApiError::new(
                    501,
                    "bbdown_unavailable",
                    "BBDown executable unavailable; configure BB_DOWN_PATH and restart Host",
                )
            })?,
            force_avc: true,
            default_host: false,
        },
        _ => {
            return Err(ApiError::new(
                501,
                "cache_source_unavailable",
                "Selected downloader has no native Host executor",
            ));
        }
    };
    crate::cache_runtime::orchestration::build_job(
        item,
        crate::cache_runtime::orchestration::JobInputs {
            cache_root: context.cache_root.clone(),
            log_file: item_log_path(&context.directory, &item.id)?,
            cookie: cookie.into(),
            user_agent: crate::native_video::USER_AGENT.into(),
            referer: "https://www.bilibili.com/".into(),
            video_quality: effective.quality.clone(),
            avc_quality_cap: effective.avc_cap.clone(),
            audio_hires: policy.audio_hires,
            executor,
        },
        if policy.download_source == "downkyi" {
            crate::cache_runtime::orchestration::JobContract::Downkyi
        } else {
            crate::cache_runtime::orchestration::JobContract::Native
        },
    )
    .map_err(cache_error)
}

pub(super) fn retry(
    context: &HostContext,
    item: &PlaylistItem,
    cookie: &str,
) -> Result<(), ApiError> {
    let (policy, player) = with_app(|app| {
        Ok((
            app.native().cache_policy.clone(),
            app.native().player_media.clone(),
        ))
    })?;
    if let Some(message) =
        crate::desktop_login::download_login_error(&policy.download_source, cookie)
    {
        use std::io::Write;
        if let Ok(mut log) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(item_log_path(&context.directory, &item.id)?)
        {
            let _ = writeln!(
                log,
                "download_login_required source={}",
                policy.download_source
            );
        }
        return Err(ApiError::new(403, "download_login_required", message));
    }
    if !policy.available_with(
        context.desktop && context.bbdown.is_some(),
        context.desktop && context.aria2().is_some(),
    ) {
        return Err(ApiError::new(
            501,
            "imported_cache_policy_unavailable",
            "Imported downloader/preferences are unavailable; select supported Native settings explicitly",
        ));
    }
    if context.desktop
        && !(player.usable()
            || policy.download_source == "downkyi" && player.details["hevc_supported"] == true)
    {
        return Err(ApiError::new(
            501,
            "player_media_unavailable",
            "Host player reports no AVC decode support; this media backend requires AVC",
        ));
    }
    let effective = MediaSelection::new(&policy, &player, context.desktop);
    execute_cache_runtime(CacheRuntimeCommand::Retry {
        job: job(context, item, cookie, &policy, &effective)?,
        urgent: true,
    })
    .map_err(cache_error)?;
    Ok(())
}

#[cfg(test)]
mod log_tests {
    use super::*;
    #[test]
    fn song_logs_are_separate_append_only_and_reject_path_components() {
        let root = std::env::temp_dir().join(format!(
            "bilikara-song-logs-{}-{}",
            std::process::id(),
            (now() * 1e9) as u64
        ));
        let first = item_log_path(&root, "first").unwrap();
        let second = item_log_path(&root, "second").unwrap();
        assert_eq!(first, root.join("logs/native/first.log"));
        let content = vec![b'x'; 1024 * 1024 + 1];
        std::fs::write(&first, &content).unwrap();
        std::fs::write(&second, b"second task").unwrap();
        assert_eq!(item_log_path(&root, "first").unwrap(), first);
        assert_eq!(std::fs::read(first).unwrap(), content);
        assert_eq!(std::fs::read(second).unwrap(), b"second task");
        for id in ["", "../outside", "a/b", "a\\b", "C:outside", ".."] {
            assert!(item_log_path(&root, id).is_err());
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
