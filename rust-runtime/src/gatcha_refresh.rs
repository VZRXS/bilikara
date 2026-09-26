//! Configured-source task service shared by the default and native Hosts.
//! Host adapters provide trusted paths/credentials and publish to their existing
//! status owner. Repository work and optional completion indexing never require
//! an observer to run business logic.
use crate::cloudflare_service::{
    CloudflareOperation, CloudflareServiceRequest, execute_cloudflare,
};
use crate::gatcha_repository::{GatchaRepositoryError, GatchaRepositoryRequest};
use crate::status_service::{GachaTaskStatus, GachaTaskUpdate};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Debug, Default)]
pub(crate) struct RefreshControl(Mutex<ControlState>);

#[derive(Debug, Default)]
struct ControlState {
    stopped: bool,
    retry_failed: bool,
    host_stop: Option<Arc<std::sync::atomic::AtomicBool>>,
}

impl RefreshControl {
    #[cfg(feature = "native-host")]
    pub(crate) fn retry_failed_sources(&self) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retry_failed = true;
    }
    pub(crate) fn retries_failed_sources(&self) -> bool {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retry_failed
    }

    pub(crate) fn stop(&self) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).stopped = true;
    }

    #[cfg(feature = "native-host")]
    pub(crate) fn follow_host(&self, stop: Arc<std::sync::atomic::AtomicBool>) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).host_stop = Some(stop);
    }

    pub(crate) fn commit<T>(
        &self,
        action: impl FnOnce() -> Result<T, GatchaRepositoryError>,
    ) -> Result<T, GatchaRepositoryError> {
        let stopped = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if stopped.stopped
            || stopped
                .host_stop
                .as_ref()
                .is_some_and(|s| s.load(std::sync::atomic::Ordering::Acquire))
        {
            return Err(GatchaRepositoryError {
                kind: "cancelled".into(),
                message: "曲库任务已停止".into(),
            });
        }
        action()
    }

    pub(crate) fn check(&self) -> Result<(), GatchaRepositoryError> {
        self.commit(|| Ok(()))
    }

    pub(crate) fn sleep(&self, duration: Duration) -> Result<(), GatchaRepositoryError> {
        let until = std::time::Instant::now() + duration;
        loop {
            self.check()?;
            let remaining = until.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                return Ok(());
            }
            std::thread::sleep(remaining.min(Duration::from_millis(50)));
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RebuildPaths {
    pub uid_temp: std::path::PathBuf,
    pub cache_temp: std::path::PathBuf,
    pub favlist_temp: std::path::PathBuf,
    pub progress: std::path::PathBuf,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CatalogCompletion {
    pub base_url: String,
    pub user_agent: String,
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RefreshRequest {
    pub repository: GatchaRepositoryRequest,
    #[serde(default)]
    pub rebuild: Option<RebuildPaths>,
    #[serde(default)]
    pub catalog: Option<CatalogCompletion>,
}

pub(crate) struct RefreshOutcome {
    #[cfg(feature = "native-host")]
    pub payload: Result<Value, GatchaRepositoryError>,
    pub task: GachaTaskUpdate,
    entries: Vec<Value>,
}

pub(crate) fn summary_has_errors(value: &Value) -> bool {
    let summary = value.get("refresh_summary").unwrap_or(value);
    summary["errors"].as_array().is_some_and(|v| !v.is_empty())
        || summary["favlist_error"]
            .as_str()
            .is_some_and(|v| !v.is_empty())
}

#[cfg(feature = "native-host")]
pub(crate) fn native_task(value: Option<&Value>) -> GachaTaskUpdate {
    let payload = value
        .map(|value| {
            if value.get("refresh_summary").is_some() {
                value.clone()
            } else {
                json!({"refresh_summary": value})
            }
        })
        .ok_or_else(|| GatchaRepositoryError {
            kind: "refresh_failed".into(),
            message: "曲库更新失败，请稍后重试".into(),
        });
    let mut task = interpret(payload, false).task;
    task.blocking = false;
    task
}

/// Preserve the default Host's result DTO and its distinction between no UID
/// success and partial UID success for every Host.
pub(crate) fn interpret(
    payload: Result<Value, GatchaRepositoryError>,
    rebuilt: bool,
) -> RefreshOutcome {
    let (status, message, result, error, entries) = match &payload {
        Err(error) => (
            GachaTaskStatus::Failed,
            "抽卡缓存更新失败。",
            None,
            error.message.clone(),
            vec![],
        ),
        Ok(cache) => {
            let summary = &cache["refresh_summary"];
            let rows = summary["uids"].as_array().cloned().unwrap_or_default();
            let errors = summary["errors"].as_array().cloned().unwrap_or_default();
            let favlist_error = summary["favlist_error"].as_str().unwrap_or_default();
            let has_errors = summary_has_errors(cache);
            let status = if has_errors
                && rows.is_empty()
                && summary["favlist_succeeded"].as_u64().unwrap_or(0) == 0
            {
                GachaTaskStatus::Failed
            } else if has_errors {
                GachaTaskStatus::Partial
            } else {
                GachaTaskStatus::Success
            };
            let message = if rebuilt {
                "抽卡缓存格式重建完成。"
            } else {
                match status {
                    GachaTaskStatus::Failed => "抽卡缓存更新失败，未成功拉取任何 UID。",
                    GachaTaskStatus::Partial => "抽卡缓存已部分更新，但有 UID 或收藏夹拉取失败。",
                    _ => "抽卡缓存更新完成。",
                }
            };
            let uids = cache["uids"].as_object();
            let mut result = json!({
                "uid_count": uids.map_or(0, |v| v.len()),
                "entry_count": uids.map_or(0, |v| v.values().filter_map(Value::as_array).map(Vec::len).sum::<usize>()),
                "uid_results": rows, "errors": errors, "favlist_error": favlist_error,
                "favlist_errors": summary["favlist_errors"].as_array().cloned().unwrap_or_default(),
            });
            if rebuilt {
                result["rebuild"] = cache["rebuild"].clone();
            }
            let entries = if status == GachaTaskStatus::Failed {
                vec![]
            } else if rebuilt {
                cache["catalog_entries"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
            } else {
                added_entries(cache)
            };
            (status, message, Some(result), String::new(), entries)
        }
    };
    RefreshOutcome {
        #[cfg(feature = "native-host")]
        payload,
        task: GachaTaskUpdate {
            status,
            message: message.into(),
            error,
            result,
            blocking: !rebuilt,
        },
        entries,
    }
}

pub(crate) fn added_entries(cache: &Value) -> Vec<Value> {
    let mut entries = cache["favlist_entries"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    for row in cache["refresh_summary"]["uids"]
        .as_array()
        .into_iter()
        .flatten()
    {
        let uid = row["uid"].as_str().unwrap_or_default();
        let count = row["added_count"].as_u64().unwrap_or_default() as usize;
        for entry in cache["uids"][uid]
            .as_array()
            .into_iter()
            .flatten()
            .take(count)
        {
            let Some(mut entry) = entry.as_object().cloned() else {
                continue;
            };
            entry.entry("mid").or_insert_with(|| json!(uid));
            let profile = &cache["profiles"][uid];
            for (field, source) in [("owner_name", "name"), ("owner_url", "space_url")] {
                if !entry.contains_key(field)
                    && profile[source].as_str().is_some_and(|v| !v.is_empty())
                {
                    entry.insert(field.into(), profile[source].clone());
                }
            }
            entries.push(Value::Object(entry));
        }
    }
    entries
}

pub(crate) fn execute(
    request: &RefreshRequest,
    control: &RefreshControl,
    progress: &dyn Fn(Value),
) -> RefreshOutcome {
    let result = crate::gatcha_repository::execute_configured_refresh(request, control, progress);
    let rebuilt = result.as_ref().is_ok_and(|v| !v["rebuild"].is_null());
    interpret(result, rebuilt)
}

/// Queue acceptance is best effort and is independent of observer delivery.
/// Admission to the existing bounded append queue is serialized with stop;
/// network delivery remains owned by that queue, never by an AppState lock.
pub(crate) fn complete_catalog(
    request: &RefreshRequest,
    outcome: &RefreshOutcome,
    control: &RefreshControl,
) {
    if let Some(catalog) = &request.catalog
        && !outcome.entries.is_empty()
    {
        let _ = control.commit(|| {
            let _ = execute_cloudflare(&CloudflareServiceRequest {
                schema_version: 1,
                base_url: catalog.base_url.clone(),
                user_agent: catalog.user_agent.clone(),
                timeout_ms: catalog.timeout_ms,
                operation: CloudflareOperation::EnqueueAppend {
                    entries: outcome.entries.clone(),
                },
            });
            Ok(())
        });
    }
}

pub(crate) type RefreshTicket = (u64, Arc<RefreshControl>);

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(feature = "native-host")]
    #[test]
    fn native_refresh_distinguishes_total_failure_and_retains_diagnostics() {
        let value = json!({"refresh_summary":{"uids":[],"errors":[{"uid":"42","error":"offline"}],"favlist_error":"blocked"}});
        let task = native_task(Some(&value));
        assert_eq!(task.status, GachaTaskStatus::Failed);
        let result = task.result.unwrap();
        assert_eq!(result["errors"][0]["error"], "offline");
        assert_eq!(result["favlist_error"], "blocked");
        let mut mixed = value;
        mixed["refresh_summary"]["uids"] = json!([{"uid":"43"}]);
        assert_eq!(native_task(Some(&mixed)).status, GachaTaskStatus::Partial);
    }
    use crate::status_service::RuntimeStatusService;

    #[test]
    fn summary_classification_and_indexing_scope_are_not_cache_size_heuristics() {
        let base = json!({"uids":{"1":[{"bvid":"BVNEW0000001"},{"bvid":"BVOLD0000001"}]},
            "profiles":{"1":{"name":"UP","space_url":"https://space.bilibili.com/1"}},
            "refresh_summary":{"uids":[{"uid":"1","added_count":1}],"errors":[],"favlist_error":""}});
        let successful = interpret(Ok(base.clone()), false);
        assert_eq!(successful.task.status, GachaTaskStatus::Success);
        assert_eq!(successful.entries.len(), 1);
        assert_eq!(successful.entries[0]["owner_name"], "UP");
        let mut mixed = base.clone();
        mixed["refresh_summary"]["errors"] = json!([{"uid":"2","error":"offline"}]);
        assert_eq!(
            interpret(Ok(mixed.clone()), false).task.status,
            GachaTaskStatus::Partial
        );
        mixed["refresh_summary"]["uids"] = json!([]);
        let failed = interpret(Ok(mixed), false);
        assert_eq!(failed.task.status, GachaTaskStatus::Failed);
        assert!(
            failed.entries.is_empty(),
            "old cached records do not prove refresh success"
        );
        let mut no_new = base;
        no_new["refresh_summary"]["uids"][0]["added_count"] = json!(0);
        assert!(interpret(Ok(no_new.clone()), false).entries.is_empty());
        no_new["rebuild"] = json!({"completed":true});
        no_new["favlist_entries"] = json!([{"bvid":"BVFAVREBUILD"}]);
        no_new["refresh_summary"]["uids"][0]["added_count"] = json!(2);
        no_new["catalog_entries"] = json!([{"bvid":"BVFAVREBUILD"},{"bvid":"BVNEW0000001"}]);
        let rebuilt = interpret(Ok(no_new), true);
        assert_eq!(rebuilt.entries.len(), 2);
        assert_eq!(rebuilt.entries[0], json!({"bvid":"BVFAVREBUILD"}));
        assert_eq!(rebuilt.entries[1]["bvid"], "BVNEW0000001");
        assert!(!rebuilt.task.blocking);
    }

    #[test]
    fn task_owner_rejects_duplicates_and_stale_completion_without_stealing_other_lease() {
        let mut status = RuntimeStatusService::default();
        let running = || GachaTaskUpdate {
            status: GachaTaskStatus::Running,
            message: String::new(),
            error: String::new(),
            result: None,
            blocking: false,
        };
        assert!(status.try_begin_gacha_refresh("manual source".into(), None));
        assert!(status.begin_configured_refresh(true, running()).is_none());
        let old = status.begin_configured_refresh(false, running()).unwrap();
        assert!(status.begin_configured_refresh(false, running()).is_none());
        assert!(
            status.gacha_snapshot().busy,
            "existing manual lease stays owned"
        );
        assert!(status.finish_configured_refresh(
            old.0,
            false,
            interpret(Ok(json!({})), false).task
        ));
        assert!(status.gacha_snapshot().busy);
        status.reset_gacha();
        let stale = status.begin_configured_refresh(false, running()).unwrap();
        status.reset_gacha();
        assert!(stale.1.check().is_err());
        let current = status.begin_configured_refresh(false, running()).unwrap();
        assert!(!status.owns_configured_refresh(&stale));
        assert!(status.owns_configured_refresh(&current));
        assert!(!status.finish_configured_refresh(
            stale.0,
            false,
            interpret(Ok(json!({})), false).task
        ));
        assert_eq!(
            status.gacha_snapshot().last_status,
            GachaTaskStatus::Running
        );
        drop(status);
        assert!(
            current
                .1
                .commit::<()>(|| panic!("stopped owner must not publish"))
                .is_err()
        );
    }
}
