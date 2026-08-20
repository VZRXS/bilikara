use crate::bilibili_service::{
    BilibiliDashRequest, BilibiliRedirectRequest, fetch_dash_playurl, resolve_redirect,
};
use crate::cloudflare_service::{CloudflareServiceRequest, execute_cloudflare};
use crate::diagnostics::{DiagnosticRequest, build_diagnostic_artifact, probe_connectivity_only};
use crate::gatcha_repository::{GatchaRepositoryRequest, execute_gatcha};
use crate::http_downloader::{DownloadError, DownloadProgress, DownloadRequest, download_to_path};
use crate::json_http::{JsonHttpRequest, execute_json_request};
use crate::media_backend::{
    MediaError, MediaNormalizeRequest, MediaPathRequest, normalize_media, probe_media,
};
use crate::networking::{NetworkAddressRequest, detect_lan_ipv4_addresses};
use crate::status_service::{
    BilibiliLoginFacts, BilibiliLoginStatus, BilibiliLoginUpdate, GachaTaskUpdate,
    RuntimeStatusService,
};
use crate::update_installer::{
    LaunchUpdateHelperRequest, PrepareUpdateRequest, launch_update_helper, prepare_update,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::ffi::{CStr, CString, c_char, c_void};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Mutex, OnceLock};

const RUNTIME_ABI_VERSION: u32 = 1;

pub type DownloadProgressCallback =
    extern "C" fn(downloaded_bytes: u64, total_bytes: u64, context: *mut c_void) -> i32;

#[derive(Serialize)]
struct DownloadWireResponse<T> {
    schema_version: u32,
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<DownloadError>,
}

#[derive(Serialize)]
struct MediaWireResponse<T> {
    schema_version: u32,
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<MediaError>,
}

#[derive(Deserialize)]
#[serde(tag = "command", rename_all = "snake_case", deny_unknown_fields)]
enum StatusServiceCommand {
    GachaSnapshot,
    GachaTryBegin {
        busy_message: String,
        #[serde(default)]
        task: Option<GachaTaskUpdate>,
    },
    GachaSet {
        task: GachaTaskUpdate,
        #[serde(default)]
        busy_message: String,
    },
    GachaRelease,
    GachaReset,
    BilibiliBegin {
        message: String,
    },
    BilibiliSet {
        #[serde(default)]
        generation: Option<u64>,
        state: BilibiliLoginStatus,
        #[serde(default)]
        message: String,
        #[serde(default)]
        qr_image: String,
    },
    BilibiliSnapshot {
        facts: BilibiliLoginFacts,
    },
    BilibiliReset,
}

#[derive(Serialize)]
struct StatusServiceWireResponse {
    schema_version: u32,
    status: &'static str,
    result: Value,
}

#[derive(Deserialize)]
#[serde(
    tag = "service",
    content = "request",
    rename_all = "snake_case",
    deny_unknown_fields
)]
enum RuntimeServiceCommand {
    BilibiliDash(BilibiliDashRequest),
    BilibiliRedirect(BilibiliRedirectRequest),
    Cloudflare(CloudflareServiceRequest),
    GatchaRepository(GatchaRepositoryRequest),
    JsonHttp(JsonHttpRequest),
    NetworkAddresses(NetworkAddressRequest),
    PrepareUpdate(PrepareUpdateRequest),
    LaunchUpdateHelper(LaunchUpdateHelperRequest),
    BuildDiagnostics(DiagnosticRequest),
    ProbeConnectivity {
        targets: BTreeMap<String, String>,
        timeout_ms: u64,
        #[serde(default)]
        local_usernames: Vec<String>,
    },
}

#[derive(Serialize)]
struct RuntimeServiceWireResponse {
    schema_version: u32,
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<Value>,
}

static STATUS_SERVICE: OnceLock<Mutex<RuntimeStatusService>> = OnceLock::new();

#[unsafe(no_mangle)]
pub extern "C" fn bilikara_runtime_abi_version() -> u32 {
    RUNTIME_ABI_VERSION
}

/// # Safety
///
/// `request_json` must point to a valid null-terminated UTF-8 string. The callback and
/// context must remain valid for the duration of this blocking call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bilikara_runtime_download(
    request_json: *const c_char,
    callback: Option<DownloadProgressCallback>,
    context: *mut c_void,
) -> *mut c_char {
    catch_unwind(AssertUnwindSafe(|| {
        if request_json.is_null() {
            return None;
        }
        // SAFETY: Required by this export's C ABI contract.
        let request_text = unsafe { CStr::from_ptr(request_json) }.to_str().ok()?;
        let request: DownloadRequest = serde_json::from_str(request_text).ok()?;
        let response = match download_to_path(&request, |progress: DownloadProgress| {
            callback.is_none_or(|notify| {
                notify(
                    progress.downloaded_bytes,
                    progress.total_bytes.unwrap_or(0),
                    context,
                ) == 0
            })
        }) {
            Ok(result) => DownloadWireResponse {
                schema_version: 1,
                status: "completed",
                result: Some(result),
                error: None,
            },
            Err(error) => DownloadWireResponse {
                schema_version: 1,
                status: if error.kind == crate::http_downloader::DownloadErrorKind::Cancelled {
                    "cancelled"
                } else {
                    "failed"
                },
                result: None,
                error: Some(error),
            },
        };
        let encoded = serde_json::to_string(&response).ok()?;
        CString::new(encoded).ok().map(CString::into_raw)
    }))
    .ok()
    .flatten()
    .unwrap_or(std::ptr::null_mut())
}

#[unsafe(no_mangle)]
/// # Safety
///
/// `request_json` must point to a valid null-terminated UTF-8 media probe request.
pub unsafe extern "C" fn bilikara_runtime_media_probe(request_json: *const c_char) -> *mut c_char {
    media_call(request_json, |request: MediaPathRequest| {
        probe_media(&request)
    })
}

#[unsafe(no_mangle)]
/// # Safety
///
/// `request_json` must point to a valid null-terminated UTF-8 media normalize request.
pub unsafe extern "C" fn bilikara_runtime_media_normalize(
    request_json: *const c_char,
) -> *mut c_char {
    media_call(request_json, |request: MediaNormalizeRequest| {
        normalize_media(&request)
    })
}

#[unsafe(no_mangle)]
/// # Safety
///
/// `request_json` must point to a valid null-terminated UTF-8 status-service command.
pub unsafe extern "C" fn bilikara_runtime_status_service(
    request_json: *const c_char,
) -> *mut c_char {
    catch_unwind(AssertUnwindSafe(|| {
        if request_json.is_null() {
            return None;
        }
        // SAFETY: This C ABI entrypoint requires a valid null-terminated UTF-8 string.
        let request_text = unsafe { CStr::from_ptr(request_json) }.to_str().ok()?;
        let command: StatusServiceCommand = serde_json::from_str(request_text).ok()?;
        let service = STATUS_SERVICE.get_or_init(|| Mutex::new(RuntimeStatusService::default()));
        let mut service = service
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let result = match command {
            StatusServiceCommand::GachaSnapshot => json!(service.gacha_snapshot()),
            StatusServiceCommand::GachaTryBegin { busy_message, task } => {
                let started = service.try_begin_gacha_refresh(busy_message, task);
                json!({"started": started, "snapshot": service.gacha_snapshot()})
            }
            StatusServiceCommand::GachaSet { task, busy_message } => {
                service.set_gacha_busy_message(busy_message);
                service.set_gacha_task(task);
                json!(service.gacha_snapshot())
            }
            StatusServiceCommand::GachaRelease => {
                service.release_gacha_refresh();
                json!(service.gacha_snapshot())
            }
            StatusServiceCommand::GachaReset => {
                service.reset_gacha();
                json!(service.gacha_snapshot())
            }
            StatusServiceCommand::BilibiliBegin { message } => {
                let generation = service.begin_bilibili_login(message);
                json!({"generation": generation})
            }
            StatusServiceCommand::BilibiliSet {
                generation,
                state,
                message,
                qr_image,
            } => {
                let applied = service.set_bilibili_login(
                    generation,
                    BilibiliLoginUpdate {
                        state,
                        message,
                        qr_image,
                    },
                );
                json!({"applied": applied})
            }
            StatusServiceCommand::BilibiliSnapshot { facts } => {
                json!(service.bilibili_snapshot(facts))
            }
            StatusServiceCommand::BilibiliReset => {
                service.reset_bilibili_login();
                json!({"reset": true})
            }
        };
        let response = StatusServiceWireResponse {
            schema_version: 1,
            status: "completed",
            result,
        };
        CString::new(serde_json::to_string(&response).ok()?)
            .ok()
            .map(CString::into_raw)
    }))
    .ok()
    .flatten()
    .unwrap_or(std::ptr::null_mut())
}

#[unsafe(no_mangle)]
/// # Safety
///
/// `request_json` must point to a valid null-terminated UTF-8 runtime-service command.
pub unsafe extern "C" fn bilikara_runtime_service(request_json: *const c_char) -> *mut c_char {
    catch_unwind(AssertUnwindSafe(|| {
        if request_json.is_null() {
            return None;
        }
        // SAFETY: This C ABI entrypoint requires a valid null-terminated UTF-8 string.
        let request_text = unsafe { CStr::from_ptr(request_json) }.to_str().ok()?;
        let command: RuntimeServiceCommand = serde_json::from_str(request_text).ok()?;
        let response = match command {
            RuntimeServiceCommand::BilibiliDash(request) => {
                service_result(fetch_dash_playurl(&request))
            }
            RuntimeServiceCommand::BilibiliRedirect(request) => {
                service_result(resolve_redirect(&request))
            }
            RuntimeServiceCommand::Cloudflare(request) => {
                service_result(execute_cloudflare(&request))
            }
            RuntimeServiceCommand::GatchaRepository(request) => {
                service_result(execute_gatcha(&request))
            }
            RuntimeServiceCommand::JsonHttp(request) => {
                service_result(execute_json_request(&request))
            }
            RuntimeServiceCommand::NetworkAddresses(request) => RuntimeServiceWireResponse {
                schema_version: 1,
                status: "completed",
                result: serde_json::to_value(detect_lan_ipv4_addresses(&request)).ok(),
                error: None,
            },
            RuntimeServiceCommand::PrepareUpdate(request) => {
                service_result(prepare_update(&request))
            }
            RuntimeServiceCommand::LaunchUpdateHelper(request) => {
                match launch_update_helper(&request) {
                    Ok(()) => RuntimeServiceWireResponse {
                        schema_version: 1,
                        status: "completed",
                        result: Some(json!({"launched": true})),
                        error: None,
                    },
                    Err(error) => failed_service_response(error),
                }
            }
            RuntimeServiceCommand::BuildDiagnostics(request) => {
                service_result(build_diagnostic_artifact(&request))
            }
            RuntimeServiceCommand::ProbeConnectivity {
                targets,
                timeout_ms,
                local_usernames,
            } => RuntimeServiceWireResponse {
                schema_version: 1,
                status: "completed",
                result: Some(probe_connectivity_only(
                    &targets,
                    timeout_ms,
                    &local_usernames,
                )),
                error: None,
            },
        };
        let encoded = serde_json::to_string(&response).ok()?;
        CString::new(encoded).ok().map(CString::into_raw)
    }))
    .ok()
    .flatten()
    .unwrap_or(std::ptr::null_mut())
}

fn service_result<T, E>(result: Result<T, E>) -> RuntimeServiceWireResponse
where
    T: Serialize,
    E: Serialize,
{
    match result {
        Ok(result) => RuntimeServiceWireResponse {
            schema_version: 1,
            status: "completed",
            result: serde_json::to_value(result).ok(),
            error: None,
        },
        Err(error) => failed_service_response(error),
    }
}

fn failed_service_response<E: Serialize>(error: E) -> RuntimeServiceWireResponse {
    RuntimeServiceWireResponse {
        schema_version: 1,
        status: "failed",
        result: None,
        error: serde_json::to_value(error).ok(),
    }
}

fn media_call<Request, ResultValue, Operation>(
    request_json: *const c_char,
    operation: Operation,
) -> *mut c_char
where
    Request: serde::de::DeserializeOwned,
    ResultValue: Serialize,
    Operation: FnOnce(Request) -> Result<ResultValue, MediaError>,
{
    catch_unwind(AssertUnwindSafe(|| {
        if request_json.is_null() {
            return None;
        }
        // SAFETY: The C ABI entrypoints require a valid null-terminated UTF-8 string.
        let request_text = unsafe { CStr::from_ptr(request_json) }.to_str().ok()?;
        let request: Request = serde_json::from_str(request_text).ok()?;
        let response = match operation(request) {
            Ok(result) => MediaWireResponse {
                schema_version: 1,
                status: "completed",
                result: Some(result),
                error: None,
            },
            Err(error) => MediaWireResponse {
                schema_version: 1,
                status: "failed",
                result: None,
                error: Some(error),
            },
        };
        CString::new(serde_json::to_string(&response).ok()?)
            .ok()
            .map(CString::into_raw)
    }))
    .ok()
    .flatten()
    .unwrap_or(std::ptr::null_mut())
}

/// # Safety
///
/// `value` must be a pointer returned by this library and must be freed exactly once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bilikara_runtime_free_string(value: *mut c_char) {
    if value.is_null() {
        return;
    }
    // SAFETY: Required by this export's C ABI contract.
    drop(unsafe { CString::from_raw(value) });
}
