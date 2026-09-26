//! Shared Rust library repository exposed through the existing Host/Remote API.
//! All Bilibili I/O runs outside AppState. One process-wide task lease protects
//! manual imports and configured-source refresh after login/credential restore.
//! No account-wide scan or cloud upload is scheduled here.
use super::*;
use crate::gatcha_repository::{
    GatchaOperation, GatchaPaths, GatchaRepositoryRequest, execute_gatcha,
};
use crate::status_service::{GachaTaskStatus, GachaTaskUpdate};
use std::time::Instant;

/// Internal, bounded observations, not arbitrary upstream text/URLs or cookies.
#[derive(Clone, serde::Serialize)]
pub(crate) struct LibraryDiagnostic {
    at: f64,
    trigger: &'static str,
    event: &'static str,
    elapsed_ms: u64,
    error_code: String,
    up_error_count: usize,
    favlist_failed: bool,
}

fn record(
    trigger: &'static str,
    event: &'static str,
    started: Instant,
    result: Option<&Result<Value, ApiError>>,
    owner: Option<&TaskLease>,
) {
    let summary = result
        .and_then(|result| result.as_ref().ok())
        .map(|v| v.get("refresh_summary").unwrap_or(v));
    let diagnostic = LibraryDiagnostic {
        at: now(),
        trigger,
        event,
        elapsed_ms: started.elapsed().as_millis() as u64,
        error_code: result
            .and_then(|r| r.as_ref().err())
            .map(|e| e.code.clone())
            .unwrap_or_default(),
        up_error_count: summary
            .and_then(|s| s["errors"].as_array())
            .map_or(0, Vec::len),
        favlist_failed: summary
            .is_some_and(|s| s["favlist_error"].as_str().is_some_and(|e| !e.is_empty())),
    };
    let _ = with_app(|app| {
        if owner.is_some_and(|owner| {
            owner.stopped()
                || owner
                    .ticket
                    .as_ref()
                    .is_some_and(|ticket| !app.native().login.owns_configured_refresh(ticket))
        }) {
            return Ok(());
        }
        app.native_library_diagnostic(diagnostic);
        Ok(())
    });
}

pub(super) fn paths(directory: &Path) -> GatchaPaths {
    GatchaPaths {
        uid_file: directory.join("gatcha_uids.json"),
        cache_file: directory.join("gatcha_cache.json"),
        favlist_file: directory.join("gatcha_favlist.json"),
        pool_config_file: directory.join("gatcha_pool_config.json"),
    }
}

fn default_uids() -> Vec<String> {
    // Embedded in the APK; a parity test checks the desktop configuration.
    serde_json::from_str(include_str!("default_uids.json")).expect("bundled default UP list")
}

pub(super) fn initialize(directory: &Path) -> Result<bool, ApiError> {
    let recovered =
        crate::gatcha_repository::initialize_native_uids(&paths(directory), &default_uids())
            .map_err(|error| ApiError::new(503, &error.kind, error.message))?;
    Ok(recovered)
}

pub(super) fn migrate_pool(directory: &Path) -> Result<(), ApiError> {
    let legacy = paths(directory).pool_config_file;
    if legacy.exists() {
        let config = execute(directory, GatchaOperation::PoolConfigSnapshot)?;
        with_app(|app| app.native_migrate_pool_default(config))?;
        // The new checkpoint is durable before retiring the legacy input. Keep
        // a byte-for-byte backup; an interrupted rename is safe to retry.
        let backup = directory.join("gatcha_pool_config.legacy.backup.json");
        if !backup.exists() {
            std::fs::rename(&legacy, backup)
                .map_err(|_| ApiError::new(503, "pool_config_migration", "无法备份旧卡池配置"))?;
        }
    }
    Ok(())
}

pub(super) fn publish_favorites_timestamp(directory: &Path) {
    if let Ok(value) = execute(directory, GatchaOperation::FavlistUpdatedAt)
        && let Some(updated) = value["updated_at"].as_f64().filter(|v| v.is_finite())
    {
        let _ = with_app(|app| {
            let session = app.native();
            if session.favlist_updated_at != updated {
                session.favlist_updated_at = updated;
                session.revision += 1;
            }
            Ok(())
        });
    }
}

fn execute(directory: &Path, operation: GatchaOperation) -> Result<Value, ApiError> {
    execute_gatcha(&GatchaRepositoryRequest {
        schema_version: 1,
        paths: paths(directory),
        default_uids: default_uids(),
        operation,
    })
    .map_err(|error| ApiError::new(400, &error.kind, error.message))
}

pub(super) fn query_value(query: &str, key: &str) -> String {
    url::form_urlencoded::parse(query.as_bytes())
        .find(|(name, _)| name == key)
        .map(|(_, value)| value.trim().to_owned())
        .unwrap_or_default()
}

pub(super) fn query_number(
    query: &str,
    key: &str,
    default: usize,
    max: usize,
) -> Result<usize, ApiError> {
    let value = query_value(query, key);
    if value.is_empty() {
        return Ok(default);
    }
    value
        .parse::<usize>()
        .ok()
        .filter(|v| *v <= max)
        .ok_or_else(|| ApiError::invalid(format!("无效的 {key}")))
}

fn saved_pool(directory: &Path, key: &str) -> Result<Value, ApiError> {
    let saved = with_app(|app| Ok(app.native_pool_config(key, &Value::Null)))?;
    if !saved.is_null() {
        return Ok(saved);
    }
    let config = execute(directory, GatchaOperation::PoolConfigSnapshot)?;
    with_app(|app| {
        app.native_migrate_pool_default(config)?;
        Ok(app.native_pool_config(key, &Value::Null))
    })
}

fn pool(directory: &Path, key: &str) -> Result<Value, ApiError> {
    let mut config = saved_pool(directory, key)?;
    config["uid_options"] = execute(
        directory,
        GatchaOperation::BrowseUid {
            uid: String::new(),
            query: String::new(),
            offset: 0,
            limit: 1,
        },
    )?["owners"]
        .clone();
    config["favlist_folder_options"] = execute(
        directory,
        GatchaOperation::BrowseFavlist {
            folder_id: String::new(),
            query: String::new(),
            offset: 0,
            limit: 1,
        },
    )?["folders"]
        .clone();
    Ok(config)
}

pub(super) fn read(
    context: &HostContext,
    identity: &Identity,
    path: &str,
    query: &str,
) -> Result<Value, ApiError> {
    let key = with_app(|app| app.native_pool_key(identity, &query_value(query, "requester_name")))?;
    let search = query_value(query, "q");
    if search.chars().count() > 120 {
        return Err(ApiError::invalid("搜索内容过长"));
    }
    let offset = query_number(query, "offset", 0, 1_000_000)?;
    // Shared Host currently requests its complete local list; Remote supplies
    // an explicit 100-item page and loads the following pages on scroll.
    let default_limit = if path == "/api/gatcha/search" {
        30
    } else {
        10_000
    };
    let limit = query_number(query, "limit", default_limit, 10_000)?.clamp(1, 10_000);
    let operation = match path {
        "/api/gatcha/uids" => GatchaOperation::UidSnapshot,
        "/api/gatcha/pool-config" => return pool(&context.directory, &key),
        "/api/gatcha/search" => GatchaOperation::Search {
            query: search,
            offset,
            limit: limit.min(500),
        },
        "/api/gatcha/browse" => GatchaOperation::BrowseUid {
            uid: query_value(query, "uid"),
            query: search,
            offset,
            limit,
        },
        "/api/gatcha/favlist/browse" => GatchaOperation::BrowseFavlist {
            folder_id: query_value(query, "folder_id"),
            query: search,
            offset,
            limit,
        },
        "/api/gatcha/candidate" => GatchaOperation::Candidate {
            cookie_available: with_app(|app| Ok(!app.native().cookie.is_empty()))?,
            pool_config: Some(saved_pool(&context.directory, &key)?),
        },
        _ => return Err(ApiError::new(404, "not_found", "未知曲库操作")),
    };
    let mut value = execute(&context.directory, operation)?;
    if let Some(items) = value.get_mut("items").and_then(Value::as_array_mut) {
        let available = crate::gatcha_repository::annotate_local(&paths(&context.directory), items)
            .map_err(|error| ApiError::new(503, &error.kind, error.message))?;
        if path == "/api/gatcha/search"
            && !query_value(query, "q").is_empty()
            && !available
            && with_app(|app| Ok(app.native().cookie.is_empty()))?
        {
            return Err(ApiError::new(
                400,
                "missing_cookie",
                "请登录 Bilibili 账号或输入 Cookie",
            ));
        }
    }
    Ok(value)
}

fn network_operation(path: &str, body: &Value, cookie: &str) -> Result<GatchaOperation, ApiError> {
    let operation = match path {
        "/api/gatcha/uids/preview" => "preview_uid",
        "/api/gatcha/uids/add" => "add_uid",
        "/api/gatcha/refresh" => "refresh_all",
        "/api/gatcha/favlist/preview" => "preview_favlist",
        "/api/gatcha/favlist" => "refresh_favlist",
        _ => return Err(ApiError::new(404, "not_found", "未知曲库操作")),
    };
    let mut request = json!({"operation":operation,"cookie":cookie,
        "user_agent":crate::native_video::USER_AGENT,"referer":"https://www.bilibili.com/","timeout_ms":20000});
    if operation != "refresh_all" {
        let raw = crate::app_state::native_session::text(body, "uid")?;
        let uid = raw.trim().trim_end_matches('/').to_owned();
        // Keep UID normalization in the repository, including space URLs.
        if uid.len() > 256 {
            return Err(ApiError::invalid("UID 格式无效"));
        }
        request["uid"] = json!(uid);
    }
    if matches!(operation, "add_uid" | "refresh_all") {
        request["keywords"] = json!([
            "卡拉", "カラ", "投屏", "KTV", "纯K", "纯k", "kara", "Kara", "karaoke", "Karaoke",
            "vocal", "Vocal", "伴奏"
        ]);
    }
    if operation.contains("favlist") {
        request["folder_keywords"] = json!(["🎤", "卡拉", "k"]);
    }
    if operation == "refresh_favlist" {
        let folders = body["folder_ids"]
            .as_array()
            .filter(|values| !values.is_empty() && values.len() <= 100)
            .ok_or_else(|| ApiError::invalid("请选择 1–100 个收藏夹"))?;
        if folders.iter().any(|v| {
            v.as_str().is_none_or(|s| {
                s.is_empty() || s.len() > 32 || !s.bytes().all(|b| b.is_ascii_digit())
            })
        }) {
            return Err(ApiError::invalid("收藏夹 ID 无效"));
        }
        request["folder_ids"] = json!(folders);
    }
    serde_json::from_value(request).map_err(|_| ApiError::invalid("曲库操作格式无效"))
}

struct TaskLease {
    complete: bool,
    automatic: bool,
    trigger: &'static str,
    started: Instant,
    ticket: Option<crate::gatcha_refresh::RefreshTicket>,
    stop: Option<Arc<AtomicBool>>,
}

fn partial_refresh(value: &Value) -> bool {
    crate::gatcha_refresh::summary_has_errors(value)
}

fn credential_scope(cookie: &str) -> String {
    use sha2::{Digest, Sha256};
    let account = cookie
        .split(';')
        .find_map(|part| part.trim().strip_prefix("DedeUserID="))
        .filter(|id| !id.is_empty())
        .unwrap_or(cookie);
    format!("{:x}", Sha256::digest(account.as_bytes()))
}

fn automatic_refresh(
    session: &crate::app_state::native_session::NativeSession,
    trigger: &str,
    has_identity: bool,
) -> bool {
    if session.desktop && !has_identity && matches!(trigger, "login_success" | "credential_restore")
    {
        !session.startup_library_refresh_attempted
            || session.library_credential_scope != credential_scope(&session.cookie)
    } else {
        !has_identity && trigger != "cookie_config"
    }
}

fn pending_refresh_ready(session: &crate::app_state::native_session::NativeSession) -> bool {
    let Some(trigger) = session.pending_library_refresh else {
        return false;
    };
    if session.cookie.is_empty()
        || session.library_refresh_active
        || session.login.gacha_snapshot().busy
        || (!automatic_refresh(session, trigger, false)
            && session
                .library_cooldown_until
                .is_some_and(|until| until > Instant::now()))
    {
        return false;
    }
    true
}

impl TaskLease {
    fn acquire(
        identity: Option<&Identity>,
        trigger: &'static str,
        configured: bool,
        allow_guest: bool,
    ) -> Result<(Self, String), ApiError> {
        Self::acquire_current(identity, Some(trigger), configured, allow_guest)
    }

    // None means the current credential transaction's pending intent. Resolve
    // it, capture its cookie and consume it only after admission, under one lock.
    // Callers never carry an old trigger across transactions or requeue failures.
    fn acquire_current(
        identity: Option<&Identity>,
        mut trigger: Option<&'static str>,
        configured: bool,
        allow_guest: bool,
    ) -> Result<(Self, String), ApiError> {
        let pending = trigger.is_none();
        let started = Instant::now();
        let result = with_app(|app| {
            // Source edits retain the desktop's registered Remote behavior.
            if let Some(identity) = identity {
                app.native_requester(identity, "")?;
            }
            let session = app.native();
            if pending {
                trigger = session.pending_library_refresh;
            }
            let trigger = trigger
                .ok_or_else(|| ApiError::new(409, "no_pending_refresh", "没有待执行的曲库刷新"))?;
            let login_trigger = session.desktop
                && identity.is_none()
                && matches!(trigger, "login_success" | "credential_restore");
            let scope = credential_scope(&session.cookie);
            let automatic = automatic_refresh(session, trigger, identity.is_some());
            Self::reserve_for(session, automatic, allow_guest, configured)?;
            if pending {
                session.pending_library_refresh = None;
            }
            if login_trigger {
                session.startup_library_refresh_attempted = true;
                session.library_credential_scope = scope;
            }
            let ticket = if configured {
                // Reserve keeps native authorization/cooldown policy. Transfer
                // its lease to the shared task owner under the same AppState lock.
                if !automatic {
                    session.login.release_gacha_refresh();
                }
                session.login.begin_configured_refresh(
                    !automatic,
                    GachaTaskUpdate {
                        status: GachaTaskStatus::Running,
                        message: "本地曲库更新中".into(),
                        error: String::new(),
                        result: None,
                        blocking: !automatic,
                    },
                )
            } else {
                None
            };
            Ok((
                Self {
                    complete: false,
                    automatic,
                    trigger,
                    started,
                    ticket,
                    stop: None,
                },
                session.cookie.clone(),
            ))
        });
        if let Some(trigger) = trigger {
            match &result {
                Ok(_) => record(trigger, "started", started, None, None),
                Err(error) => record(
                    trigger,
                    "skipped",
                    started,
                    Some(&Err(ApiError::new(error.status, &error.code, ""))),
                    None,
                ),
            }
        }
        result
    }

    #[cfg(test)]
    fn reserve(
        session: &mut crate::app_state::native_session::NativeSession,
        automatic: bool,
    ) -> Result<(), ApiError> {
        Self::reserve_for(session, automatic, false, true)
    }

    fn reserve_for(
        session: &mut crate::app_state::native_session::NativeSession,
        automatic: bool,
        allow_guest: bool,
        configured: bool,
    ) -> Result<(), ApiError> {
        if session.cookie.is_empty() && !allow_guest {
            return Err(ApiError::new(
                400,
                "missing_cookie",
                "请先在 Host 设置中登录 Bilibili",
            ));
        }
        if !automatic
            && configured
            && session
                .library_cooldown_until
                .is_some_and(|until| until > Instant::now())
        {
            return Err(ApiError::new(
                429,
                "library_cooldown",
                "曲库刚刚更新完成，请稍后再刷新",
            ));
        }
        // One internal I/O lease still prevents overlapping scans. It is
        // not the manual/global UI lock: cached Gacha and browsing remain
        // available during the login/credential-restore background task.
        if session.library_refresh_active || session.login.gacha_snapshot().busy {
            return Err(ApiError::new(
                409,
                "library_busy",
                "拉取任务执行中，请等待任务结束",
            ));
        }
        let task = GachaTaskUpdate {
            status: GachaTaskStatus::Running,
            message: "本地曲库更新中".into(),
            error: String::new(),
            result: None,
            blocking: !automatic,
        };
        if automatic {
            session.login.set_gacha_task(task);
        } else {
            session
                .login
                .try_begin_gacha_refresh("拉取任务执行中，请等待任务结束".into(), Some(task));
        }
        session.library_refresh_active = true;
        session.revision += 1;
        Ok(())
    }

    fn finish(mut self, result: &Result<Value, ApiError>) -> Result<(), ApiError> {
        if self.stopped() {
            self.complete = true;
            return Ok(());
        }
        if let Some(ticket) = &self.ticket {
            let current = with_app(|app| Ok(app.native().login.owns_configured_refresh(ticket)))?;
            if !current {
                self.complete = true;
                return Ok(());
            }
        }
        record(
            self.trigger,
            if result.is_err() {
                "failed"
            } else if result.as_ref().is_ok_and(partial_refresh) {
                "partial"
            } else {
                "success"
            },
            self.started,
            Some(result),
            Some(&self),
        );
        self.publish_owned(result)?;
        self.complete = true;
        Ok(())
    }

    fn stopped(&self) -> bool {
        self.stop
            .as_ref()
            .is_some_and(|stop| stop.load(Ordering::Acquire))
    }

    fn publish_owned(&self, result: &Result<Value, ApiError>) -> Result<(), ApiError> {
        with_app(|app| {
            if self.stopped() {
                return Ok(());
            }
            let session = app.native();
            let cancelled = Err(ApiError::new(
                409,
                "cancelled",
                "账号已切换，曲库任务已取消",
            ));
            let result = if self
                .ticket
                .as_ref()
                .is_some_and(|ticket| ticket.1.check().is_err())
            {
                &cancelled
            } else {
                result
            };
            if let Some(ticket) = &self.ticket {
                if !session.login.owns_configured_refresh(ticket) {
                    return Ok(());
                }
                // Native status text/cooldown remain an entry-specific projection.
                let mut task = crate::gatcha_refresh::native_task(result.as_ref().ok());
                if let Err(error) = result {
                    task.error.clone_from(&error.message);
                }
                session
                    .login
                    .finish_configured_refresh(ticket.0, !self.automatic, task);
            }
            Self::publish_session(session, result, self.automatic, self.ticket.is_some());
            Ok(())
        })
    }

    fn publish_session(
        session: &mut crate::app_state::native_session::NativeSession,
        result: &Result<Value, ApiError>,
        automatic: bool,
        configured: bool,
    ) {
        let mut task = crate::gatcha_refresh::native_task(result.as_ref().ok());
        if let Err(error) = result {
            task.error.clone_from(&error.message);
        }
        let succeeded = task.status == GachaTaskStatus::Success;
        session.library_refresh_active = false;
        if !automatic {
            session.login.release_gacha_refresh();
        }
        session.login.set_gacha_task(task);
        // Only a successful scan consumes the manual refresh cooldown.
        // Failed/partial scans can immediately retry their missing sources.
        if !automatic && configured {
            session.library_cooldown_until =
                succeeded.then(|| Instant::now() + Duration::from_secs(60));
        }
        session.revision += 1;
    }
}
impl Drop for TaskLease {
    fn drop(&mut self) {
        if !self.complete {
            let result = Err(ApiError::new(503, "library_task", "曲库任务中断"));
            record(
                self.trigger,
                "interrupted",
                self.started,
                Some(&result),
                Some(self),
            );
            if !self.stopped() {
                let _ = self.publish_owned(&result);
            }
        }
    }
}

fn refresh(
    context: &HostContext,
    identity: Option<&Identity>,
    trigger: Option<&'static str>,
) -> Result<Value, ApiError> {
    if context.stop.load(Ordering::Acquire) {
        return Err(ApiError::new(503, "stopped", "Host 已停止"));
    }
    let (mut lease, cookie) = TaskLease::acquire_current(identity, trigger, true, false)?;
    let trigger = lease.trigger;
    lease.stop = Some(context.stop.clone());
    let control = lease
        .ticket
        .as_ref()
        .expect("configured refresh ticket")
        .1
        .clone();
    control.follow_host(context.stop.clone());
    if trigger == "manual_refresh" {
        control.retry_failed_sources();
    }
    let operation = network_operation("/api/gatcha/refresh", &json!({}), &cookie)?;
    let request = crate::gatcha_refresh::RefreshRequest {
        repository: GatchaRepositoryRequest {
            schema_version: 1,
            paths: paths(&context.directory),
            default_uids: default_uids(),
            operation,
        },
        rebuild: (context.desktop && lease.automatic).then(|| {
            crate::gatcha_refresh::RebuildPaths {
                uid_temp: context.directory.join("gatcha_uids_temp.json"),
                cache_temp: context.directory.join("gatcha_cache_temp.json"),
                favlist_temp: context.directory.join("gatcha_favlist_temp.json"),
                progress: context.directory.join("gatcha_rebuild_progress.json"),
            }
        }),
        catalog: Some(catalog_append::completion()),
    };
    let stop = context.stop.clone();
    context
        .spawn("native-library-refresh", move || {
            let result = if stop.load(Ordering::Acquire) {
                Err(ApiError::new(503, "stopped", "Host 已停止"))
            } else {
                let outcome = crate::gatcha_refresh::execute(&request, &control, &|progress| {
                    let generation = lease.ticket.as_ref().expect("configured refresh ticket").0;
                    let _ = with_app(|app| {
                        let session = app.native();
                        session
                            .login
                            .configured_refresh_progress(generation, progress);
                        session.revision = session.revision.saturating_add(1);
                        Ok(())
                    });
                });
                crate::gatcha_refresh::complete_catalog(&request, &outcome, &control);
                control
                    .check()
                    .and(outcome.payload)
                    .map_err(|e| ApiError::new(400, &e.kind, e.message))
            };
            if !stop.load(Ordering::Acquire) && control.check().is_ok() {
                publish_favorites_timestamp(
                    request.repository.paths.favlist_file.parent().unwrap(),
                );
            }
            let _ = lease.finish(&result);
        })
        .map_err(|_| ApiError::new(503, "library_task", "无法启动曲库任务"))?;
    Ok(json!({"started":true}))
}

pub(super) fn invalidate_credentials(
    session: &mut crate::app_state::native_session::NativeSession,
) {
    session.login.cancel_configured_refresh();
    session.pending_library_refresh = None;
}

pub(super) fn refresh_after_login(context: &HostContext) {
    // The credential transaction already queued its intent. A late caller may
    // try the newest intent, but cannot replace it or resurrect a consumed one.
    // Busy/cooldown leaves the intent intact for the coordinator.
    let _ = refresh(context, None, None);
}

pub(super) fn start_coordinator(context: Arc<HostContext>) -> Result<(), ApiError> {
    let worker_context = context.clone();
    context
        .spawn("native-library-coordinator", move || {
            while !worker_context.stop.load(Ordering::Acquire) {
                let ready =
                    with_app(|app| Ok(pending_refresh_ready(app.native()))).unwrap_or(false);
                if ready {
                    refresh_after_login(&worker_context);
                }
                thread::sleep(Duration::from_millis(100));
            }
        })
        .map_err(|_| ApiError::new(503, "library_task", "无法启动曲库调度"))
}

pub(super) fn write(
    context: &Arc<HostContext>,
    identity: &Identity,
    path: &str,
    body: &Value,
) -> Result<Value, ApiError> {
    if path == "/api/gatcha/pool-config" {
        let key = with_app(|app| {
            app.native_pool_key(
                identity,
                body["requester_name"].as_str().unwrap_or_default(),
            )
        })?;
        let mut value = body.clone();
        value
            .as_object_mut()
            .ok_or_else(|| ApiError::invalid("卡池设置无效"))?
            .remove("requester_name");
        value["operation"] = json!("pool_config_update");
        let operation: GatchaOperation =
            serde_json::from_value(value).map_err(|_| ApiError::invalid("卡池设置无效"))?;
        let GatchaOperation::PoolConfigUpdate {
            uid_weight,
            favlist_weight,
            excluded_uids,
            excluded_favlist_folders,
        } = operation
        else {
            unreachable!()
        };
        let legacy = saved_pool(&context.directory, &key)?;
        with_app(|app| {
            let mut config = app.native_pool_config(&key, &legacy);
            if let Some(value) = uid_weight {
                config["uid_weight"] = json!(value);
            }
            if let Some(value) = favlist_weight {
                config["favlist_weight"] = json!(value);
            }
            if let Some(value) = excluded_uids {
                config["excluded_uids"] = json!(value);
            }
            if let Some(value) = excluded_favlist_folders {
                config["excluded_favlist_folders"] = json!(value);
            }
            config["updated_at"] = json!(now());
            app.native_save_pool_config(key.clone(), config)
        })?;
        return pool(&context.directory, &key);
    }
    // Validate the route/body before acquiring a lease or beginning any I/O.
    network_operation(path, body, "")?;
    if path == "/api/gatcha/refresh" {
        return refresh(context, Some(identity), Some("manual_refresh"));
    }
    let (lease, cookie) = TaskLease::acquire(
        Some(identity),
        "manual_source",
        false,
        path.starts_with("/api/gatcha/favlist"),
    )?;
    let operation = network_operation(path, body, &cookie)?;
    let result = execute(&context.directory, operation);
    publish_favorites_timestamp(&context.directory);
    lease.finish(&result)?;
    let mut value = result?;
    // Restore preview.1's post-write moderation append, stripping candidates
    // from the response before it can be forwarded through HTTP/Remote.
    catalog_append::source_result(&mut value);
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn configured_native_http_uses_shared_task_and_stopped_lease_cannot_publish() {
        let _owned = crate::app_state::native_session::GLOBAL_APP_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        crate::execute_app_state(crate::AppStateRequest::Shutdown { schema_version: 1 });
        let directory = std::env::temp_dir().join(format!("native-refresh-{}", token().unwrap()));
        let seed = serde_json::from_value(
            json!({"session_started_at":1.0,"session_played_file":"native.json","updated_at":1.0}),
        )
        .unwrap();
        assert!(
            crate::initialize_native_host(&directory, seed)
                .error()
                .is_none()
        );
        let host = super::super::start(
            &directory,
            Arc::new(|_| {
                Some(Asset {
                    bytes: b"fixture".to_vec(),
                    mime: "text/html".into(),
                })
            }),
            true,
            None,
        )
        .unwrap();
        // Empty configured sources exercise the real service without any remote
        // traffic; the known cache summary proves repository execution occurred.
        std::fs::write(
            paths(&directory).uid_file,
            br#"{"schema_version":2,"uids":[],"profiles":{}}"#,
        )
        .unwrap();
        with_app(|app| {
            app.native().cookie = "synthetic".into();
            Ok(())
        })
        .unwrap();
        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let bootstrap = client
            .get(host.bootstrap_url())
            .header("sec-fetch-mode", "navigate")
            .header("sec-fetch-dest", "document")
            .send()
            .unwrap();
        let cookie = bootstrap.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned();
        let response = client
            .post(format!(
                "http://127.0.0.1:{}/api/gatcha/refresh",
                host.local_port()
            ))
            .header("cookie", cookie)
            .json(&json!({}))
            .send()
            .unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(response.json::<Value>().unwrap()["data"]["started"], true);
        let deadline = Instant::now() + Duration::from_secs(5);
        while with_app(|app| Ok(app.native().library_refresh_active)).unwrap() {
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(
            with_app(|app| Ok(app.native().login.gacha_snapshot().last_status)).unwrap(),
            GachaTaskStatus::Success
        );
        let cache: Value =
            serde_json::from_slice(&std::fs::read(paths(&directory).cache_file).unwrap()).unwrap();
        assert_eq!(cache["refresh_summary"]["completed"], true);
        let (mut late, _) = TaskLease::acquire(None, "test_late", true, false).unwrap();
        late.stop = Some(host.context.stop.clone());
        late.ticket
            .as_ref()
            .unwrap()
            .1
            .follow_host(host.context.stop.clone());
        host.context.stop.store(true, Ordering::Release);
        let revision = with_app(|app| Ok(app.native().revision)).unwrap();
        assert!(late.ticket.as_ref().unwrap().1.check().is_err());
        late.finish(&Ok(json!({}))).unwrap();
        assert_eq!(with_app(|app| Ok(app.native().revision)).unwrap(), revision);
        assert_eq!(
            with_app(|app| Ok(app.native().login.gacha_snapshot().last_status)).unwrap(),
            GachaTaskStatus::Running
        );
        drop(host);
        crate::execute_app_state(crate::AppStateRequest::Shutdown { schema_version: 1 });
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn pending_cookie_refresh_survives_cooldown_without_changing_login_admission() {
        let mut session = crate::app_state::native_session::NativeSession::default();
        session.desktop = true;
        session.cookie = "DedeUserID=3; SESSDATA=account-c".into();
        session.startup_library_refresh_attempted = true;
        session.library_credential_scope = credential_scope("DedeUserID=2");
        session.library_cooldown_until = Some(Instant::now() + Duration::from_secs(60));
        session.pending_library_refresh = Some("cookie_config");
        for _ in 0..3 {
            assert!(!pending_refresh_ready(&session));
            assert_eq!(session.pending_library_refresh, Some("cookie_config"));
        }
        assert_eq!(
            TaskLease::reserve_for(&mut session, false, false, true)
                .unwrap_err()
                .code,
            "library_cooldown"
        );
        // Existing new-account QR policy still bypasses cooldown, but never
        // the outstanding worker's lease.
        session.pending_library_refresh = Some("login_success");
        session.library_refresh_active = true;
        assert!(!pending_refresh_ready(&session));
        session.library_refresh_active = false;
        assert!(pending_refresh_ready(&session));
        assert_eq!(session.pending_library_refresh, Some("login_success"));
        session.pending_library_refresh = Some("cookie_config");
        session.library_cooldown_until = Some(Instant::now() - Duration::from_secs(1));
        assert!(pending_refresh_ready(&session));
        assert_eq!(session.pending_library_refresh, Some("cookie_config"));
        // Logout removes deferred intent as well as cancelling the old task.
        session.pending_library_refresh = Some("cookie_config");
        invalidate_credentials(&mut session);
        assert_eq!(session.pending_library_refresh, None);
    }

    // Pause an older caller after failed admission, commit newer credentials,
    // then resume it. Both the immediate path and coordinator use this same
    // acquisition function; there is no caller-owned trigger to write back.
    fn check_pending_handoff(old: &'static str, latest: &'static str, same_cookie: bool) {
        let _owned = crate::app_state::native_session::GLOBAL_APP_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        with_app(|app| {
            let session = app.native();
            *session = crate::app_state::native_session::NativeSession::default();
            session.desktop = true;
            session.cookie = "DedeUserID=3; SESSDATA=old".into();
            session.startup_library_refresh_attempted = true;
            session.library_credential_scope = credential_scope("DedeUserID=2");
            session.library_cooldown_until = Some(Instant::now() + Duration::from_secs(60));
            session.library_refresh_active = true;
            session.pending_library_refresh = Some(old);
            Ok(())
        })
        .unwrap();
        let (rejected_tx, rejected_rx) = std::sync::mpsc::channel();
        let (resume_tx, resume_rx) = std::sync::mpsc::channel();
        let worker = thread::spawn(move || {
            let error = TaskLease::acquire_current(None, None, true, false)
                .err()
                .unwrap();
            rejected_tx.send(error.code).unwrap();
            resume_rx.recv_timeout(Duration::from_secs(10)).unwrap();
            TaskLease::acquire_current(None, None, true, false)
        });
        assert_eq!(
            rejected_rx.recv_timeout(Duration::from_secs(10)).unwrap(),
            if old == "login_success" {
                "library_busy"
            } else {
                "library_cooldown"
            }
        );
        with_app(|app| {
            let session = app.native();
            if !same_cookie {
                invalidate_credentials(session);
                session.cookie = "DedeUserID=4; SESSDATA=new".into();
            }
            session.pending_library_refresh = Some(latest);
            session.library_refresh_active = false;
            Ok(())
        })
        .unwrap();
        resume_tx.send(()).unwrap();
        let result = worker.join().unwrap();
        let (lease, cookie) = if latest == "cookie_config" {
            assert_eq!(result.err().unwrap().code, "library_cooldown");
            with_app(|app| {
                let session = app.native();
                assert_eq!(session.pending_library_refresh, Some(latest));
                assert!(!pending_refresh_ready(session));
                session.library_cooldown_until = None;
                Ok(())
            })
            .unwrap();
            TaskLease::acquire_current(None, None, true, false).unwrap()
        } else {
            result.unwrap()
        };
        assert_eq!(lease.trigger, latest);
        assert_eq!(lease.automatic, latest == "login_success");
        assert_eq!(
            cookie,
            if same_cookie {
                "DedeUserID=3; SESSDATA=old"
            } else {
                "DedeUserID=4; SESSDATA=new"
            }
        );
        // Another delayed caller cannot duplicate the consumed intent, during
        // or after execution, even when the current pending slot is empty.
        assert_eq!(
            TaskLease::acquire_current(None, None, true, false)
                .err()
                .unwrap()
                .code,
            "no_pending_refresh"
        );
        lease.finish(&Ok(json!({}))).unwrap();
        assert_eq!(
            TaskLease::acquire_current(None, None, true, false)
                .err()
                .unwrap()
                .code,
            "no_pending_refresh"
        );
        with_app(|app| {
            *app.native() = crate::app_state::native_session::NativeSession::default();
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn old_qr_attempt_cannot_bypass_new_cookie_cooldown() {
        check_pending_handoff("login_success", "cookie_config", false);
    }

    #[test]
    fn old_cookie_attempt_cannot_delay_new_qr_refresh() {
        check_pending_handoff("cookie_config", "login_success", false);
    }

    #[test]
    fn same_cookie_commit_still_replaces_older_trigger_semantics() {
        check_pending_handoff("login_success", "cookie_config", true);
        check_pending_handoff("cookie_config", "login_success", true);
    }

    #[test]
    fn delayed_refresh_after_logout_cannot_recreate_pending_intent() {
        let _owned = crate::app_state::native_session::GLOBAL_APP_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        with_app(|app| {
            let session = app.native();
            *session = crate::app_state::native_session::NativeSession::default();
            session.cookie = "synthetic".into();
            session.library_refresh_active = true;
            session.pending_library_refresh = Some("login_success");
            Ok(())
        })
        .unwrap();
        assert_eq!(
            TaskLease::acquire_current(None, None, true, false)
                .err()
                .unwrap()
                .code,
            "library_busy"
        );
        with_app(|app| {
            let session = app.native();
            invalidate_credentials(session);
            session.cookie.clear();
            session.library_refresh_active = false;
            Ok(())
        })
        .unwrap();
        assert_eq!(
            TaskLease::acquire_current(None, None, true, false)
                .err()
                .unwrap()
                .code,
            "no_pending_refresh"
        );
        with_app(|app| {
            assert_eq!(app.native().pending_library_refresh, None);
            *app.native() = crate::app_state::native_session::NativeSession::default();
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn desktop_saved_login_refreshes_sources_on_startup() {
        let _owned = crate::app_state::native_session::GLOBAL_APP_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        crate::execute_app_state(crate::AppStateRequest::Shutdown { schema_version: 1 });
        let directory =
            std::env::temp_dir().join(format!("native-startup-refresh-{}", token().unwrap()));
        let seed = serde_json::from_value(
            json!({"session_started_at":1.0,"session_played_file":"native.json","updated_at":1.0}),
        )
        .unwrap();
        assert!(
            crate::initialize_native_host(&directory, seed)
                .error()
                .is_none()
        );
        initialize(&directory).unwrap();
        std::fs::write(
            paths(&directory).uid_file,
            br#"{"schema_version":2,"uids":[],"profiles":{}}"#,
        )
        .unwrap();
        std::fs::write(
            directory.join("BBDown.data"),
            "SESSDATA=synthetic; bili_jct=synthetic",
        )
        .unwrap();
        let host = super::super::start(&directory, Arc::new(|_| None), true, None).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while with_app(|app| Ok(app.native().library_refresh_active)).unwrap() {
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(10));
        }
        with_app(|app| {
            assert!(app.native().startup_library_refresh_attempted);
            assert_eq!(
                app.native().login.gacha_snapshot().last_status,
                GachaTaskStatus::Success
            );
            Ok(())
        })
        .unwrap();
        assert!(paths(&directory).cache_file.exists());
        drop(host);
        crate::execute_app_state(crate::AppStateRequest::Shutdown { schema_version: 1 });
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn desktop_login_refresh_uses_startup_bypass_only_once() {
        let _owned = crate::app_state::native_session::GLOBAL_APP_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        with_app(|app| {
            *app.native() = crate::app_state::native_session::NativeSession::default();
            app.native().desktop = true;
            app.native().cookie = "synthetic".into();
            Ok(())
        })
        .unwrap();
        let (configured, _) = TaskLease::acquire(None, "cookie_config", true, false).unwrap();
        assert!(!configured.automatic);
        assert!(!with_app(|app| Ok(app.native().startup_library_refresh_attempted)).unwrap());
        configured.finish(&Ok(json!({}))).unwrap();
        let (first, _) = TaskLease::acquire(None, "credential_restore", true, false).unwrap();
        assert!(first.automatic);
        with_app(|app| {
            let status = app.native().login.gacha_snapshot();
            assert!(status.background_busy);
            assert!(!status.blocking);
            Ok(())
        })
        .unwrap();
        assert!(TaskLease::acquire(None, "login_success", true, false).is_err());
        first.finish(&Ok(json!({}))).unwrap();
        assert_eq!(
            TaskLease::acquire(None, "login_success", true, false)
                .err()
                .unwrap()
                .code,
            "library_cooldown"
        );
        with_app(|app| {
            app.native().cookie = "different-account".into();
            Ok(())
        })
        .unwrap();
        let (changed_account, _) = TaskLease::acquire(None, "login_success", true, false).unwrap();
        assert!(
            changed_account.automatic,
            "new account needs its own source refresh"
        );
        changed_account.finish(&Ok(json!({}))).unwrap();
        assert!(
            TaskLease::acquire(None, "login_success", true, false).is_err(),
            "same account still observes cooldown"
        );
        with_app(|app| {
            app.native().library_cooldown_until = None;
            Ok(())
        })
        .unwrap();
        let (next, _) = TaskLease::acquire(None, "login_success", true, false).unwrap();
        assert!(!next.automatic);
        with_app(|app| {
            let status = app.native().login.gacha_snapshot();
            assert!(status.busy);
            assert!(status.blocking);
            Ok(())
        })
        .unwrap();
        next.finish(&Ok(json!({}))).unwrap();
        with_app(|app| {
            *app.native() = crate::app_state::native_session::NativeSession::default();
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn preview_then_import_does_not_consume_or_obey_full_refresh_cooldown() {
        let mut session = crate::app_state::native_session::NativeSession::default();
        session.library_cooldown_until = Some(Instant::now() + Duration::from_secs(60));
        TaskLease::reserve_for(&mut session, false, true, false).unwrap();
        TaskLease::publish_session(&mut session, &Ok(json!({})), false, false);
        TaskLease::reserve_for(&mut session, false, true, false).unwrap();
        TaskLease::publish_session(
            &mut session,
            &Err(ApiError::invalid("fixture")),
            false,
            false,
        );
        assert!(session.library_cooldown_until.is_some());
    }

    #[test]
    fn automatic_refresh_is_nonblocking_and_does_not_consume_manual_cooldown() {
        let mut session = crate::app_state::native_session::NativeSession::default();
        session.cookie = "synthetic".into();
        TaskLease::reserve(&mut session, true).unwrap();
        let status = session.login.gacha_snapshot();
        assert!(status.background_busy);
        assert!(
            !status.busy,
            "Login refresh must not globally disable Gacha controls"
        );
        assert!(!status.blocking);
        assert!(
            TaskLease::reserve(&mut session, true).is_err(),
            "No overlapping automatic scans"
        );
        let failed = Err(ApiError::new(503, "test", "offline failure"));
        TaskLease::publish_session(&mut session, &failed, true, true);
        assert_eq!(session.login.gacha_snapshot().last_error, "offline failure");
        assert!(session.library_cooldown_until.is_none());
        TaskLease::reserve(&mut session, false).unwrap();
        assert!(session.login.gacha_snapshot().busy);
        TaskLease::publish_session(&mut session, &failed, false, true);
        assert!(session.library_cooldown_until.is_none());
        TaskLease::reserve(&mut session, false).unwrap();
        TaskLease::publish_session(&mut session, &Ok(json!({})), false, true);
        let cooldown = session.library_cooldown_until;
        assert!(cooldown.is_some());
        assert!(TaskLease::reserve(&mut session, false).is_err());
        TaskLease::reserve(&mut session, true).unwrap();
        TaskLease::publish_session(&mut session, &failed, true, true);
        assert_eq!(session.library_cooldown_until, cooldown);
        session.library_cooldown_until = None;
        session.cookie.clear();
        TaskLease::reserve_for(&mut session, false, true, true).unwrap();
        TaskLease::publish_session(&mut session, &failed, false, true);
        assert!(TaskLease::reserve_for(&mut session, false, false, true).is_err());
    }
    #[test]
    fn default_ups_seed_once_and_migrate_old_alpha_without_resetting_user_sources() {
        let directory =
            std::env::temp_dir().join(format!("native-library-defaults-{}", token().unwrap()));
        std::fs::create_dir_all(&directory).unwrap();
        initialize(&directory).unwrap();
        let snapshot = execute(&directory, GatchaOperation::UidSnapshot).unwrap();
        assert_eq!(snapshot["uids"], json!(default_uids()));
        assert_eq!(snapshot["count"], 27);
        let uid_file = paths(&directory).uid_file;
        // Once initialized, even a deliberate empty source list stays empty.
        let empty = br#"{"schema_version":2,"uids":[],"profiles":{}}"#;
        std::fs::write(&uid_file, empty).unwrap();
        initialize(&directory).unwrap();
        assert_eq!(std::fs::read(&uid_file).unwrap(), empty);

        for (name, legacy) in [
            (
                "legacy-empty",
                json!({"schema_version":2,"uids":[],"profiles":{}}),
            ),
            (
                "legacy-custom",
                json!({"uids":["123", "3145040"],"profiles":{"123":{"name":"My UP"}}}),
            ),
        ] {
            let root = directory.join(name);
            std::fs::create_dir_all(&root).unwrap();
            let files = paths(&root);
            std::fs::write(&files.uid_file, legacy.to_string()).unwrap();
            let excluded = br#"{"uid_weight":20,"excluded_uids":["3145040"],"excluded_favlist_folders":["123:456"]}"#;
            std::fs::write(&files.pool_config_file, excluded).unwrap();
            let cached = br#"{"schema_version":3,"uids":{"123":[{"bvid":"BV1z84y1p7oS"}]}}"#;
            std::fs::write(&files.cache_file, cached).unwrap();
            initialize(&root).unwrap();
            let migrated = execute(&root, GatchaOperation::UidSnapshot).unwrap();
            assert!(
                default_uids()
                    .iter()
                    .all(|uid| migrated["uids"].as_array().unwrap().contains(&json!(uid)))
            );
            assert_eq!(
                migrated["count"],
                if name == "legacy-custom" { 28 } else { 27 }
            );
            assert_eq!(migrated["profiles"], legacy["profiles"]);
            assert_eq!(std::fs::read(&files.pool_config_file).unwrap(), excluded);
            assert_eq!(std::fs::read(&files.cache_file).unwrap(), cached);
            let once = std::fs::read(&files.uid_file).unwrap();
            initialize(&root).unwrap();
            assert_eq!(std::fs::read(&files.uid_file).unwrap(), once);
        }
        let corrupt = directory.join("corrupt");
        std::fs::create_dir_all(&corrupt).unwrap();
        std::fs::write(paths(&corrupt).uid_file, b"broken").unwrap();
        assert!(initialize(&corrupt).unwrap());
        assert_eq!(
            std::fs::read(corrupt.join("gatcha_uids.corrupt.json")).unwrap(),
            b"broken"
        );
        assert_eq!(
            execute(&corrupt, GatchaOperation::UidSnapshot).unwrap()["count"],
            27
        );
        assert!(corrupt.join("native-library-defaults.json").exists());
        assert!(!initialize(&corrupt).unwrap());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn refresh_summary_failures_do_not_announce_success() {
        assert!(partial_refresh(
            &json!({"refresh_summary":{"errors":[{"uid":"1"}]}})
        ));
        assert!(partial_refresh(
            &json!({"refresh_summary":{"favlist_error":"blocked"}})
        ));
        assert!(!partial_refresh(
            &json!({"refresh_summary":{"errors":[],"favlist_error":""}})
        ));
    }
    #[test]
    fn source_request_is_typed_and_cannot_override_paths_or_credentials() {
        let operation = network_operation(
            "/api/gatcha/uids/add",
            &json!({"uid":"123","cookie":"evil","cache_file":"elsewhere"}),
            "trusted",
        )
        .unwrap();
        let GatchaOperation::AddUid {
            uid,
            cookie,
            keywords,
            ..
        } = operation
        else {
            panic!()
        };
        assert_eq!(uid, "123");
        assert_eq!(cookie, "trusted");
        assert!(keywords.contains(&"卡拉".into()));
        for body in [
            json!({"uid":"123","folder_ids":[]}),
            json!({"uid":"123","folder_ids":["../x"]}),
            json!({"uid":"123","folder_ids":[1]}),
        ] {
            assert!(network_operation("/api/gatcha/favlist", &body, "").is_err());
        }
        assert!(network_operation("/api/gatcha/delete", &json!({}), "").is_err());
        assert!(query_number("offset=-1", "offset", 0, 1_000_000).is_err());
        assert_eq!(
            query_number("offset=200", "offset", 0, 1_000_000).unwrap(),
            200
        );
    }
}
