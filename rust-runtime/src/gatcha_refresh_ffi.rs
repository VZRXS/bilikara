//! Coarse C ABI adapter for the existing default Host status owner. Callbacks
//! are observer notifications only; no callback is needed to finish a task.
use crate::ffi::status_service;
use crate::gatcha_refresh::{self, RefreshRequest};
use crate::status_service::{GachaTaskStatus, GachaTaskUpdate};
use serde::Deserialize;
use serde_json::json;
use std::ffi::{CStr, CString, c_char};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Mutex, OnceLock};
use std::thread::JoinHandle;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StartRequest {
    #[serde(default)]
    owner: u64,
    refresh: RefreshRequest,
    use_global_lock: bool,
    blocking: bool,
}

// Handles are resource lifetime management, not a second task/status owner.
#[derive(Default)]
struct Workers {
    owner: u64,
    stopped: bool,
    handles: Vec<JoinHandle<()>>,
}
static WORKERS: OnceLock<Mutex<Workers>> = OnceLock::new();
fn workers() -> std::sync::MutexGuard<'static, Workers> {
    WORKERS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

pub(crate) fn reset() {
    new_owner();
}

fn new_owner() -> u64 {
    stop(0);
    let mut workers = workers();
    workers.owner = workers.owner.wrapping_add(1).max(1);
    workers.stopped = false;
    workers.owner
}

#[unsafe(no_mangle)]
pub extern "C" fn bilikara_runtime_gatcha_refresh_owner() -> u64 {
    new_owner()
}

fn stop(owner: u64) {
    let handles = {
        let mut workers = workers();
        if owner != 0 && owner != workers.owner {
            return;
        }
        workers.stopped = true;
        status_service().reset_gacha();
        std::mem::take(&mut workers.handles)
    };
    for worker in handles {
        // A notification may request shutdown. Never join its own thread.
        if worker.thread().id() != std::thread::current().id() {
            let _ = worker.join();
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn bilikara_runtime_gatcha_refresh_stop(owner: u64) {
    stop(owner);
}

// 0: accepted/start; 1: committed completion; 2: stale/cancelled cleanup.
// The callback and its context must remain valid through event 1 or 2.
#[unsafe(no_mangle)]
/// # Safety
/// `request` must be a NUL-terminated JSON string. `observer`, when present,
/// must be thread safe and valid until completion or refresh_stop returns.
pub unsafe extern "C" fn bilikara_runtime_gatcha_refresh_start(
    request: *const c_char,
    observer: Option<extern "C" fn(u32, u64)>,
    context: u64,
) -> *mut c_char {
    let result = catch_unwind(AssertUnwindSafe(|| {
        if request.is_null() {
            return Err("invalid_request");
        }
        // SAFETY: the caller provides a valid NUL-terminated request.
        let request = unsafe { CStr::from_ptr(request) }
            .to_str()
            .map_err(|_| "invalid_request")?;
        let request: StartRequest = serde_json::from_str(request).map_err(|_| "invalid_request")?;
        let mut workers = workers();
        if workers.stopped || (request.owner != 0 && request.owner != workers.owner) {
            return Err("stopped");
        }
        workers.handles.retain(|worker| !worker.is_finished());
        let ticket = status_service().begin_configured_refresh(
            request.use_global_lock,
            GachaTaskUpdate {
                status: GachaTaskStatus::Running,
                message: "拉取任务执行中，请等待任务结束".into(),
                error: String::new(),
                result: None,
                blocking: request.blocking,
            },
        );
        let Some((generation, control)) = ticket else {
            return Ok(false);
        };
        let owner = workers.owner;
        drop(workers);
        if request.use_global_lock
            && let Some(observer) = observer
        {
            observer(0, context);
        }
        // Observers may request shutdown. Never call them under either the
        // worker-resource mutex or the authoritative status mutex.
        let mut workers = self::workers();
        if workers.stopped || workers.owner != owner {
            drop(workers);
            if let Some(observer) = observer {
                observer(2, context);
            }
            return Ok(true);
        }
        let worker_control = control.clone();
        let worker = std::thread::Builder::new()
            .name("gatcha-configured-refresh".into())
            .spawn(move || {
                let outcome = catch_unwind(AssertUnwindSafe(|| {
                    gatcha_refresh::execute(&request.refresh, &worker_control, &|progress| {
                        status_service().configured_refresh_progress(generation, progress);
                    })
                }))
                .unwrap_or_else(|_| {
                    gatcha_refresh::interpret(
                        Err(crate::GatchaRepositoryError {
                            kind: "internal".into(),
                            message: "曲库任务中断".into(),
                        }),
                        false,
                    )
                });
                // Complete indexing before releasing task ownership. No Python
                // callback or native Host/session is involved in this work.
                gatcha_refresh::complete_catalog(&request.refresh, &outcome, &worker_control);
                let committed = status_service().finish_configured_refresh(
                    generation,
                    request.use_global_lock,
                    outcome.task,
                );
                if let Some(observer) = observer {
                    observer(
                        if committed && request.use_global_lock {
                            1
                        } else {
                            2
                        },
                        context,
                    );
                }
            });
        match worker {
            Ok(worker) => {
                workers.handles.push(worker);
                Ok(true)
            }
            Err(_) => {
                control.stop();
                let outcome = gatcha_refresh::interpret(
                    Err(crate::GatchaRepositoryError {
                        kind: "worker".into(),
                        message: "无法启动曲库任务".into(),
                    }),
                    false,
                );
                status_service().finish_configured_refresh(
                    generation,
                    request.use_global_lock,
                    outcome.task,
                );
                drop(workers);
                if let Some(observer) = observer {
                    observer(if request.use_global_lock { 1 } else { 2 }, context);
                }
                Err("worker")
            }
        }
    }))
    .unwrap_or(Err("internal"));
    let value = match result {
        Ok(started) => json!({"schema_version":1,"status":"ok","result":{"started":started}}),
        Err(kind) => {
            json!({"schema_version":1,"status":"error","error":{"kind":kind,"message":"Configured-source refresh unavailable"}})
        }
    };
    CString::new(value.to_string())
        .expect("JSON contains no NUL")
        .into_raw()
}
