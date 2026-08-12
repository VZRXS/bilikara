use crate::http_downloader::{DownloadError, DownloadProgress, DownloadRequest, download_to_path};
use serde::Serialize;
use std::ffi::{CStr, CString, c_char, c_void};
use std::panic::{AssertUnwindSafe, catch_unwind};

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
