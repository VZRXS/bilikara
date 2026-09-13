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

pub(super) fn initialize(directory: &Path) -> Result<(), ApiError> {
    crate::gatcha_repository::initialize_native_uids(&paths(directory), &default_uids())
        .map_err(|error| ApiError::new(503, &error.kind, error.message))
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

fn pool(directory: &Path) -> Result<Value, ApiError> {
    let mut config = execute(directory, GatchaOperation::PoolConfigSnapshot)?;
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

pub(super) fn read(context: &HostContext, path: &str, query: &str) -> Result<Value, ApiError> {
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
        "/api/gatcha/pool-config" => return pool(&context.directory),
        "/api/gatcha/search" => GatchaOperation::Search {
            query: search,
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
        },
        _ => return Err(ApiError::new(404, "not_found", "未知曲库操作")),
    };
    execute(&context.directory, operation)
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
}

fn partial_refresh(value: &Value) -> bool {
    let summary = value.get("refresh_summary").unwrap_or(value);
    summary["errors"]
        .as_array()
        .is_some_and(|errors| !errors.is_empty())
        || summary["favlist_error"]
            .as_str()
            .is_some_and(|error| !error.is_empty())
}
impl TaskLease {
    fn acquire(
        identity: Option<&Identity>,
        trigger: &'static str,
    ) -> Result<(Self, String), ApiError> {
        let started = Instant::now();
        let result = with_app(|app| {
            // Source edits retain the desktop's registered Remote behavior.
            if let Some(identity) = identity {
                app.native_requester(identity, "")?;
            }
            let session = app.native();
            Self::reserve(session, identity.is_none())?;
            Ok((
                Self {
                    complete: false,
                    automatic: identity.is_none(),
                    trigger,
                    started,
                },
                session.cookie.clone(),
            ))
        });
        match &result {
            Ok(_) => record(trigger, "started", started, None),
            Err(error) => record(
                trigger,
                "skipped",
                started,
                Some(&Err(ApiError::new(error.status, &error.code, ""))),
            ),
        }
        result
    }

    fn reserve(
        session: &mut crate::app_state::native_session::NativeSession,
        automatic: bool,
    ) -> Result<(), ApiError> {
        if session.cookie.is_empty() {
            return Err(ApiError::new(
                400,
                "missing_cookie",
                "请先在 Host 设置中登录 Bilibili",
            ));
        }
        if !automatic
            && session
                .library_cooldown_until
                .is_some_and(|until| until > Instant::now())
        {
            return Err(ApiError::new(
                429,
                "library_cooldown",
                "上次曲库拉取失败，正在冷却，请稍后再试",
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
        Self::publish(result, self.automatic)?;
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
        );
        self.complete = true;
        Ok(())
    }

    fn publish(result: &Result<Value, ApiError>, automatic: bool) -> Result<(), ApiError> {
        with_app(|app| {
            Self::publish_session(app.native(), result, automatic);
            Ok(())
        })
    }

    fn publish_session(
        session: &mut crate::app_state::native_session::NativeSession,
        result: &Result<Value, ApiError>,
        automatic: bool,
    ) {
        let partial = result.as_ref().is_ok_and(partial_refresh);
        let failed = result.is_err() || partial;
        session.library_refresh_active = false;
        if !automatic {
            session.login.release_gacha_refresh();
        }
        session.login.set_gacha_task(GachaTaskUpdate {
            status: if result.is_err() {
                GachaTaskStatus::Failed
            } else if partial {
                GachaTaskStatus::Partial
            } else {
                GachaTaskStatus::Success
            },
            message: if failed {
                "曲库更新失败或部分更新，请稍后重试"
            } else {
                "本地曲库更新完成"
            }
            .into(),
            error: String::new(),
            result: None,
            blocking: false,
        });
        // This cooldown is shared by all phones; playback/cache downloads
        // and cached browsing are not blocked by a failed library fetch.
        if !automatic {
            session.library_cooldown_until =
                failed.then(|| Instant::now() + Duration::from_secs(60));
        }
        session.revision += 1;
    }
}
impl Drop for TaskLease {
    fn drop(&mut self) {
        if !self.complete {
            let result = Err(ApiError::new(503, "library_task", "曲库任务中断"));
            record(self.trigger, "interrupted", self.started, Some(&result));
            let _ = Self::publish(&result, self.automatic);
        }
    }
}

fn refresh(
    context: &HostContext,
    identity: Option<&Identity>,
    trigger: &'static str,
) -> Result<Value, ApiError> {
    if context.stop.load(Ordering::Acquire) {
        return Err(ApiError::new(503, "stopped", "Host 已停止"));
    }
    let (lease, cookie) = TaskLease::acquire(identity, trigger)?;
    let operation = network_operation("/api/gatcha/refresh", &json!({}), &cookie)?;
    let directory = context.directory.clone();
    let stop = context.stop.clone();
    thread::Builder::new()
        .name("native-library-refresh".into())
        .spawn(move || {
            let result = if stop.load(Ordering::Acquire) {
                Err(ApiError::new(503, "stopped", "Host 已停止"))
            } else {
                execute(&directory, operation)
            };
            let _ = lease.finish(&result);
        })
        .map_err(|_| ApiError::new(503, "library_task", "无法启动曲库任务"))?;
    Ok(json!({"started":true}))
}

pub(super) fn refresh_after_login(context: &HostContext, trigger: &'static str) {
    // A library failure must not turn a successful login into a failed login.
    // No manual/global UI lock or cooldown for login/credential restore, as on
    // desktop. The internal I/O lease still prevents duplicate scans.
    let _ = refresh(context, None, trigger);
}

pub(super) fn write(
    context: &Arc<HostContext>,
    identity: &Identity,
    path: &str,
    body: &Value,
) -> Result<Value, ApiError> {
    if path == "/api/gatcha/pool-config" {
        with_app(|app| app.native_requester(identity, ""))?;
        let mut value = body.clone();
        value["operation"] = json!("pool_config_update");
        let operation: GatchaOperation =
            serde_json::from_value(value).map_err(|_| ApiError::invalid("卡池设置无效"))?;
        // Do not queue behind a long import's repository lock.
        if with_app(|app| Ok(app.native().login.gacha_snapshot().busy))? {
            return Err(ApiError::new(
                409,
                "library_busy",
                "拉取任务执行中，请等待任务结束",
            ));
        }
        execute(&context.directory, operation)?;
        with_app(|app| {
            app.native().revision += 1;
            Ok(())
        })?;
        return pool(&context.directory);
    }
    // Validate the route/body before acquiring a lease or beginning any I/O.
    network_operation(path, body, "")?;
    if path == "/api/gatcha/refresh" {
        return refresh(context, Some(identity), "manual_refresh");
    }
    let (lease, cookie) = TaskLease::acquire(Some(identity), "manual_source")?;
    let operation = network_operation(path, body, &cookie)?;
    let result = execute(&context.directory, operation);
    lease.finish(&result)?;
    let mut value = result?;
    // Desktop's add response summarizes imports; never resend an entire pool
    // over HTTP/SSE or enqueue it for D1 merely because a source was refreshed.
    if let Some(value) = value.as_object_mut() {
        value.remove("entries");
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
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
        TaskLease::publish_session(&mut session, &failed, true);
        assert!(session.library_cooldown_until.is_none());
        TaskLease::reserve(&mut session, false).unwrap();
        assert!(session.login.gacha_snapshot().busy);
        TaskLease::publish_session(&mut session, &failed, false);
        let cooldown = session.library_cooldown_until;
        assert!(cooldown.is_some());
        assert!(TaskLease::reserve(&mut session, false).is_err());
        TaskLease::reserve(&mut session, true).unwrap();
        TaskLease::publish_session(&mut session, &Ok(json!({})), true);
        assert_eq!(
            session.library_cooldown_until, cooldown,
            "Auto refresh must not reset a manual cooldown either"
        );
        session.library_cooldown_until = None;
        TaskLease::reserve(&mut session, false).unwrap();
        TaskLease::publish_session(&mut session, &Ok(json!({})), false);
        assert!(session.library_cooldown_until.is_none());
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
        assert!(initialize(&corrupt).is_err());
        assert_eq!(std::fs::read(paths(&corrupt).uid_file).unwrap(), b"broken");
        assert!(!corrupt.join("native-library-defaults.json").exists());
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
