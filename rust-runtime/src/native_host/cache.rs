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
        let mut last_integrity_check=std::time::Instant::now();
        while !context.stop.load(Ordering::Acquire){
            if last_integrity_check.elapsed() >= Duration::from_secs(2) {
                fingerprint.clear();
                last_integrity_check=std::time::Instant::now();
            }
            let _ = with_app(|app| {
                if app.native().updates.expire(now()) { app.native().revision += 1; }
                Ok(())
            });
            if let Err(error)=tick(&context,&mut fingerprint,&mut selections) && error.to_string()!=last_error {
                last_error=error.to_string();let _=with_app(|app|{app.native_diagnostic(&json!({"event":"native-cache-error","kind":error.code,"message":error.message}),now());Ok(())});
            }
            if last_cleanup.elapsed() >= Duration::from_secs(10) {
                if maintenance::collect(&context.cache_root, false).is_err() || collect_logs(&context.directory).is_err() {
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
    if usable {
        let mut invalidated = false;
        for item in &items {
            let ready = if item.cache_status == "ready" {
                match job(context, item, &cookie, &policy, &effective) {
                    Ok(job) => crate::cache_runtime::existing_artifacts_ready(&job),
                    Err(error) => {
                        project_problem(item, &error.message, true)?;
                        invalidated = true;
                        continue;
                    }
                }
            } else {
                true
            };
            if !ready {
                execute_cache_runtime(CacheRuntimeCommand::Cancel {
                    item_id: item.id.clone(),
                    reason: "缓存文件已清空，等待重新缓存".into(),
                })
                .map_err(cache_error)?;
                project_problem(item, "缓存文件已清空，等待重新缓存", false)?;
                selections.insert(
                    item.id.clone(),
                    (item.item_incarnation_id.clone(), effective.clone(), false),
                );
                invalidated = true;
            } else if item.cache_status == "failed"
                && item.cache_message.starts_with("缓存不可用: ")
            {
                project_problem(item, "等待缓存", false)?;
                invalidated = true;
            }
        }
        if invalidated {
            last_fingerprint.clear();
            return Ok(());
        }
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
        max_items: policy.max_cache_items,
        retention_limit: 3,
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
            usable
                && plan.desired_ids.contains(&item.id)
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
    if !usable {
        let message = format!(
            "缓存不可用: {}",
            if !policy.available_with(context.bbdown.is_some(), context.aria2().is_some()) {
                format!(
                    "{} 下载工具或设置不可用，请在 Host 检查下载源",
                    policy.download_source
                )
            } else {
                "Host 播放器不支持所需的视频解码，请检查媒体能力".into()
            }
        );
        for item in items
            .iter()
            .take(policy.max_cache_items)
            .filter(|item| item.cache_status != "ready")
        {
            if item.cache_status != "failed" || item.cache_message != message {
                project_problem(item, &message, true)?;
            }
        }
    }
    collect_logs(&context.directory)?;
    *last_fingerprint = fingerprint;
    Ok(())
}

fn project_problem(item: &PlaylistItem, message: &str, failed: bool) -> Result<(), ApiError> {
    with_app(|app| {
        let snapshot = app.native_core_snapshot()?;
        // Disk inspection happens off-lock. Never clear a newly published
        // replacement or a different incarnation based on that stale inspection.
        if !snapshot
            .current_item
            .iter()
            .chain(&snapshot.playlist)
            .any(|live| {
                live.id == item.id
                    && live.item_incarnation_id == item.item_incarnation_id
                    && live.artifact_set_id == item.artifact_set_id
                    && live.cache_status == item.cache_status
            })
        {
            return Ok(());
        }
        let reservation = app
            .reserve_runtime_attempt(&item.id, &item.item_incarnation_id)
            .map_err(|e| ApiError::new(409, &e.kind, e.message))?;
        let event = if failed {
            crate::app_state::CacheEvent::Failed {
                message: message.into(),
            }
        } else {
            crate::app_state::CacheEvent::Evicted {
                message: message.into(),
            }
        };
        app.native_execute(crate::app_state::AppStateRequest::ApplyCacheEvent {
            schema_version: 1,
            item_id: item.id.clone(),
            cache_attempt_token: reservation.cache_attempt_token,
            event,
            now: now(),
        })?;
        app.settle_artifact_reservation(&reservation);
        Ok(())
    })
}

fn collect_logs(directory: &Path) -> Result<(), ApiError> {
    let runtime = execute_cache_runtime(CacheRuntimeCommand::Snapshot {}).map_err(cache_error)?;
    visit_song_logs(directory, |path, id| {
        // Recheck live ownership immediately before unlinking. Active workers
        // may still append after cancellation, so retain their logs until drained.
        with_app(|app| {
            let snapshot = app.native_core_snapshot()?;
            let retained = app.native_session_choice_pending()
                || snapshot
                    .current_item
                    .iter()
                    .chain(snapshot.playlist.iter())
                    .any(|item| item.id == id)
                || ["active_item_ids", "pending_ids"].iter().any(|key| {
                    runtime[*key]
                        .as_array()
                        .is_some_and(|ids| ids.iter().any(|value| value.as_str() == Some(id)))
                });
            if !retained {
                std::fs::remove_file(path)
                    .map_err(|_| ApiError::new(503, "cache_log", "无法清理缓存日志"))?;
            }
            Ok(())
        })
    })
}

fn visit_song_logs(
    directory: &Path,
    mut visit: impl FnMut(&Path, &str) -> Result<(), ApiError>,
) -> Result<(), ApiError> {
    let root = directory.join("logs");
    for folder in std::iter::once(root.clone())
        .chain(["native", "bbdown", "downkyi"].map(|source| root.join(source)))
    {
        match std::fs::symlink_metadata(&folder) {
            Ok(metadata) if metadata.is_dir() => {}
            Ok(_) => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err(ApiError::new(503, "cache_log", "无法读取缓存日志目录")),
        }
        if folder == root {
            continue;
        }
        for entry in std::fs::read_dir(folder)
            .map_err(|_| ApiError::new(503, "cache_log", "无法读取缓存日志目录"))?
        {
            let entry = entry.map_err(|_| ApiError::new(503, "cache_log", "无法读取缓存日志"))?;
            let path = entry.path();
            if entry.file_type().is_ok_and(|kind| kind.is_file())
                && path.extension().is_some_and(|ext| ext == "log")
                && let Some(id) = path.file_stem().and_then(|name| name.to_str())
            {
                visit(&path, id)?;
            }
        }
    }
    Ok(())
}

pub(super) fn clear_song_logs(directory: &Path) -> Result<(), ApiError> {
    visit_song_logs(directory, |path, _| {
        std::fs::remove_file(path).map_err(|_| ApiError::new(503, "cache_log", "无法清理缓存日志"))
    })
}

fn item_log_path(directory: &Path, source: &str, item_id: &str) -> Result<PathBuf, ApiError> {
    // Imported identifiers must never turn a per-song log into a path outside logs.
    if item_id.is_empty()
        || item_id.len() > 160
        || item_id.contains(['/', '\\', ':'])
        || matches!(item_id, "." | "..")
        || item_id.chars().any(char::is_control)
    {
        return Err(ApiError::invalid("缓存歌曲标识无效"));
    }
    if !["native", "bbdown", "downkyi"].contains(&source) {
        return Err(ApiError::invalid("缓存下载源无效"));
    }
    let root = directory.join("logs").join(source);
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
            log_file: item_log_path(&context.directory, &policy.download_source, &item.id)?,
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
    force: bool,
) -> Result<(), ApiError> {
    let (policy, player) = with_app(|app| {
        let snapshot = app.native_core_snapshot()?;
        let policy = app.native().cache_policy.clone();
        let items: Vec<_> = snapshot
            .current_item
            .iter()
            .chain(snapshot.playlist.iter())
            .collect();
        let position = items
            .iter()
            .position(|live| {
                live.id == item.id && live.item_incarnation_id == item.item_incarnation_id
            })
            .ok_or_else(|| ApiError::new(409, "stale_item", "此歌曲已更换"))?;
        crate::cache_runtime::orchestration::validate_manual_retry(
            &items[position].cache_status,
            force,
            position < policy.max_cache_items,
        )
        .map_err(|error| ApiError::new(409, &error.kind, error.message))?;
        Ok((
            app.native().cache_policy.clone(),
            app.native().player_media.clone(),
        ))
    })?;
    if let Some(message) =
        crate::desktop_login::download_login_error(&policy.download_source, cookie)
    {
        crate::cache_runtime::append_log(
            &item_log_path(&context.directory, &policy.download_source, &item.id)?,
            &format!("download_login_required source={}", policy.download_source),
        );
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
    crate::cache_runtime::orchestration::retry_native_host(
        job(context, item, cookie, &policy, &effective)?,
        force,
    )
    .map_err(|error| {
        if ["retry_not_allowed", "item_incarnation_mismatch"].contains(&error.kind.as_str()) {
            ApiError::new(409, &error.kind, error.message)
        } else {
            cache_error(error)
        }
    })?;
    Ok(())
}

#[cfg(test)]
mod log_tests {
    use super::*;
    #[test]
    fn native_pump_retains_three_ready_items_self_heals_and_reports_unavailable_source() {
        use crate::app_state::{AppStateRequest, CacheEvent};
        let _guard = crate::app_state::native_session::GLOBAL_APP_TEST_LOCK
            .lock()
            .unwrap();
        let directory =
            std::env::temp_dir().join(format!("bilikara-cache-regression-{}", token().unwrap()));
        let context = HostContext {
            cache_root: directory.join("media"),
            directory: directory.clone(),
            assets: Arc::new(|_| None),
            stop: Arc::new(AtomicBool::new(false)),
            api_slots: Arc::new(Semaphore::new(1)),
            export_slots: Arc::new(Semaphore::new(1)),
            export_renderer: std::sync::OnceLock::new(),
            port: 0,
            desktop: false,
            bind_address: std::net::Ipv4Addr::UNSPECIFIED,
            allowed_hosts: Default::default(),
            shutdown_token: None,
            desktop_installation: None,
            bbdown: None,
            aria2: std::sync::Mutex::new(None),
            aria2_prepare: std::sync::Mutex::new(()),
            workers: std::sync::Mutex::new(vec![]),
        };
        with_app(|app| {
            app.execute(AppStateRequest::Shutdown {schema_version:1});
            let seed = serde_json::from_value(json!({"session_users":["Alice"],"session_started_at":1,"session_played_file":"test.json","updated_at":1})).unwrap();
            app.native_execute(AppStateRequest::Initialize {schema_version:1,state:Box::new(seed)})?;
            app.open_artifact_lifetime(&context.cache_root).unwrap();
            for index in 0..5 {
                let id = format!("song{index}");
                let item = serde_json::from_value(json!({"id":id,"original_url":"https://example.test/song","resolved_url":"https://example.test/song","bvid":"BV1xx411c7mD","aid":1,"cid":index+1,"title":"Song","part_title":"P1","display_title":"Song","cover_url":"","embed_url":"","selected_pages":[1],"selected_cids":[index+1],"selected_durations":[120],"selected_parts":["P1"],"available_pages":[1],"available_cids":[index+1],"available_durations":[120],"available_parts":["P1"]})).unwrap();
                app.native_execute(AppStateRequest::AddItem {schema_version:1,item,position:"tail".into(),requester_name:"Alice".into(),reset_av_delay:false,allow_repeat:true,now:2.0})?;
                let item = app.native_core_snapshot()?.current_item.into_iter().chain(app.native_core_snapshot()?.playlist).find(|i| i.id == id).unwrap();
                let reservation = app.reserve_runtime_attempt(&id,&item.item_incarnation_id).unwrap();
                let relative = &reservation.artifact_relative_directory;
                let dir = context.cache_root.join(relative);
                std::fs::create_dir_all(&dir).unwrap();
                std::fs::write(dir.join("video.mp4"),b"fixture video").unwrap();
                std::fs::write(dir.join("audio.m4a"),b"fixture audio").unwrap();
                let event: CacheEvent = serde_json::from_value(json!({"kind":"ready","message":"ready","video_relative_path":format!("{relative}/video.mp4"),"video_media_url":format!("/media/{relative}/video.mp4"),"audio_variants":[{"id":"p1_p1","label":"P1","page":1,"audio_url":format!("/media/{relative}/audio.m4a")}],"selected_audio_variant_id":"p1_p1","item_incarnation_id":reservation.item_incarnation_id,"artifact_set_id":reservation.artifact_set_id,"artifact_relative_directory":relative})).unwrap();
                app.native_execute(AppStateRequest::ApplyCacheEvent {schema_version:1,item_id:id,cache_attempt_token:reservation.cache_attempt_token,event,now:3.0})?;
            }
            app.native().cache_policy.max_cache_items = 1;
            Ok(())
        }).unwrap();
        execute_cache_runtime(CacheRuntimeCommand::Start {}).unwrap();
        let mut fingerprint = String::new();
        let mut selections = HashMap::new();
        tick(&context, &mut fingerprint, &mut selections).unwrap();
        tick(&context, &mut fingerprint, &mut selections).unwrap();
        let snapshot = with_app(|app| app.native_core_snapshot()).unwrap();
        assert_eq!(
            snapshot
                .playlist
                .iter()
                .map(|i| i.cache_status.as_str())
                .collect::<Vec<_>>(),
            ["ready", "ready", "ready", "pending"]
        );
        let current = snapshot.current_item.unwrap();
        std::fs::remove_file(context.cache_root.join(&current.video_relative_path)).unwrap();
        fingerprint.clear(); // The pump does this on its periodic integrity tick.
        tick(&context, &mut fingerprint, &mut selections).unwrap();
        let current =
            with_app(|app| Ok(app.native_core_snapshot()?.current_item.unwrap())).unwrap();
        assert_eq!(current.cache_status, "pending");
        assert!(current.artifact_set_id.is_empty());
        with_app(|app| {
            app.native().cache_policy.download_source = "bbdown".into();
            Ok(())
        })
        .unwrap();
        tick(&context, &mut fingerprint, &mut selections).unwrap();
        let failed = with_app(|app| Ok(app.native_core_snapshot()?.current_item.unwrap())).unwrap();
        assert_eq!(failed.cache_status, "failed");
        assert!(failed.cache_message.starts_with("缓存不可用: "));
        execute_cache_runtime(CacheRuntimeCommand::Shutdown {}).unwrap();
        with_app(|app| {
            app.execute(AppStateRequest::Shutdown { schema_version: 1 });
            Ok(())
        })
        .unwrap();
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn song_logs_are_separate_append_only_and_reject_path_components() {
        let root = std::env::temp_dir().join(format!(
            "bilikara-song-logs-{}-{}",
            std::process::id(),
            (now() * 1e9) as u64
        ));
        let first = item_log_path(&root, "native", "first").unwrap();
        let second = item_log_path(&root, "native", "second").unwrap();
        assert_eq!(first, root.join("logs/native/first.log"));
        let content = vec![b'x'; 1024 * 1024 + 1];
        std::fs::write(&first, &content).unwrap();
        std::fs::write(&second, b"second task").unwrap();
        assert_eq!(item_log_path(&root, "native", "first").unwrap(), first);
        assert_eq!(std::fs::read(first).unwrap(), content);
        assert_eq!(std::fs::read(second).unwrap(), b"second task");
        for source in ["native", "bbdown", "downkyi"] {
            let old = item_log_path(&root, source, "obsolete").unwrap();
            assert_eq!(old, root.join(format!("logs/{source}/obsolete.log")));
            std::fs::write(old, b"old task").unwrap();
        }
        assert!(item_log_path(&root, "../outside", "id").is_err());
        let diagnostic = root.join("logs/monthly-d1-refresh.log");
        std::fs::write(&diagnostic, b"keep diagnostic").unwrap();
        let unrelated = root.join("logs/native/notes.txt");
        std::fs::write(&unrelated, b"keep notes").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&diagnostic, root.join("logs/native/link.log")).unwrap();
        visit_song_logs(&root, |path, id| {
            if id == "obsolete" {
                std::fs::remove_file(path).unwrap();
            }
            assert_ne!(id, "link", "Never visit symlink targets");
            Ok(())
        })
        .unwrap();
        for source in ["native", "bbdown", "downkyi"] {
            assert!(!root.join(format!("logs/{source}/obsolete.log")).exists());
        }
        assert!(diagnostic.exists());
        assert!(unrelated.exists());
        for id in ["", "../outside", "a/b", "a\\b", "C:outside", ".."] {
            assert!(item_log_path(&root, "native", id).is_err());
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
