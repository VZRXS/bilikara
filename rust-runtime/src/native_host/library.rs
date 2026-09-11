//! Shared Rust library repository exposed through the existing Host/Remote API.
//! All Bilibili I/O runs outside AppState. One process-wide task lease protects
//! manual imports/refreshes; no startup scan or cloud upload is scheduled here.
use super::*;
use crate::gatcha_repository::{
    GatchaOperation, GatchaPaths, GatchaRepositoryRequest, execute_gatcha,
};
use crate::status_service::{GachaTaskStatus, GachaTaskUpdate};
use std::time::Instant;

pub(super) fn paths(directory: &Path) -> GatchaPaths {
    GatchaPaths {
        uid_file: directory.join("gatcha_uids.json"),
        cache_file: directory.join("gatcha_cache.json"),
        favlist_file: directory.join("gatcha_favlist.json"),
        pool_config_file: directory.join("gatcha_pool_config.json"),
    }
}

fn execute(directory: &Path, operation: GatchaOperation) -> Result<Value, ApiError> {
    execute_gatcha(&GatchaRepositoryRequest {
        schema_version: 1,
        paths: paths(directory),
        default_uids: Vec::new(),
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
    fn acquire(identity: &Identity) -> Result<(Self, String), ApiError> {
        with_app(|app| {
            // Source edits retain the desktop's registered Remote behavior.
            app.native_requester(identity, "")?;
            let session = app.native();
            if session.cookie.is_empty() {
                return Err(ApiError::new(
                    400,
                    "missing_cookie",
                    "请先在 Host 设置中登录 Bilibili",
                ));
            }
            if session
                .library_cooldown_until
                .is_some_and(|until| until > Instant::now())
            {
                return Err(ApiError::new(
                    429,
                    "library_cooldown",
                    "上次曲库拉取失败，正在冷却，请稍后再试",
                ));
            }
            if !session.login.try_begin_gacha_refresh(
                "拉取任务执行中，请等待任务结束".into(),
                Some(GachaTaskUpdate {
                    status: GachaTaskStatus::Running,
                    message: "本地曲库更新中".into(),
                    error: String::new(),
                    result: None,
                    blocking: true,
                }),
            ) {
                return Err(ApiError::new(
                    409,
                    "library_busy",
                    "拉取任务执行中，请等待任务结束",
                ));
            }
            session.revision += 1;
            Ok((Self { complete: false }, session.cookie.clone()))
        })
    }

    fn finish(mut self, result: &Result<Value, ApiError>) -> Result<(), ApiError> {
        Self::publish(result)?;
        self.complete = true;
        Ok(())
    }

    fn publish(result: &Result<Value, ApiError>) -> Result<(), ApiError> {
        with_app(|app| {
            let partial = result.as_ref().is_ok_and(partial_refresh);
            let failed = result.is_err() || partial;
            let session = app.native();
            session.login.release_gacha_refresh();
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
            session.library_cooldown_until =
                failed.then(|| Instant::now() + Duration::from_secs(60));
            session.revision += 1;
            Ok(())
        })
    }
}
impl Drop for TaskLease {
    fn drop(&mut self) {
        if !self.complete {
            let _ = Self::publish(&Err(ApiError::new(503, "library_task", "曲库任务中断")));
        }
    }
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
    let (lease, cookie) = TaskLease::acquire(identity)?;
    let operation = network_operation(path, body, &cookie)?;
    if path == "/api/gatcha/refresh" {
        let context = context.clone();
        thread::Builder::new()
            .name("native-library-refresh".into())
            .spawn(move || {
                let result = execute(&context.directory, operation);
                let _ = lease.finish(&result);
            })
            .map_err(|_| ApiError::new(503, "library_task", "无法启动曲库任务"))?;
        return Ok(json!({"started":true}));
    }
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
