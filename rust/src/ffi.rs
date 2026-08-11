use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use std::panic::{UnwindSafe, catch_unwind};

use crate::archive::is_downloadable_archive;
use crate::asset_selection::select_update_asset_json;
use crate::asset_tokens::{
    asset_tokens, has_arm64, has_linux, has_macos, has_universal, has_windows, has_x64,
};
use crate::filename::safe_filename_impl;
use crate::platform::normalize_machine_arch_impl;
use crate::title_cleanup::clean_display_title_impl;
use crate::url_utils::{format_download_proxy_url, release_list_api_from_latest};
use crate::version::{normalize_version_tag_impl, version_sort_key_impl, version_tuple_impl};

#[unsafe(no_mangle)]
pub extern "C" fn rust_backend_abi_version() -> u32 {
    catch_unwind(|| 1).unwrap_or(0)
}

fn ffi_string_result<F>(operation: F) -> *mut c_char
where
    F: FnOnce() -> Option<String> + UnwindSafe,
{
    match catch_unwind(operation) {
        Ok(Some(value)) => CString::new(value)
            .map(CString::into_raw)
            .unwrap_or(std::ptr::null_mut()),
        _ => std::ptr::null_mut(),
    }
}

fn bool_string(value: bool) -> String {
    if value { "1" } else { "0" }.to_string()
}
unsafe fn input<'a>(p: *const c_char) -> Option<&'a str> {
    if p.is_null() {
        None
    } else {
        // SAFETY: Every caller is an unsafe C export whose contract requires a
        // valid, null-terminated input pointer. Null is rejected above.
        unsafe { CStr::from_ptr(p) }.to_str().ok()
    }
}
fn tokens_from_payload(p: &str) -> std::collections::HashSet<String> {
    p.lines()
        .filter(|v| !v.is_empty())
        .map(str::to_string)
        .collect()
}

#[unsafe(no_mangle)]
#[allow(clippy::missing_safety_doc)]
pub unsafe extern "C" fn rust_asset_tokens(p: *const c_char) -> *mut c_char {
    ffi_string_result(|| {
        // SAFETY: Required by this export's C ABI contract.
        let text = unsafe { input(p)? };
        let mut v: Vec<_> = asset_tokens(text).into_iter().collect();
        v.sort();
        Some(v.join("\n"))
    })
}
macro_rules! classifier {
    ($name:ident,$fun:ident) => {
        #[unsafe(no_mangle)]
        #[allow(clippy::missing_safety_doc)]
        pub unsafe extern "C" fn $name(p: *const c_char) -> *mut c_char {
            ffi_string_result(|| {
                // SAFETY: Required by this export's C ABI contract.
                let payload = unsafe { input(p)? };
                Some(bool_string($fun(&tokens_from_payload(payload))))
            })
        }
    };
}
classifier!(rust_asset_has_windows, has_windows);
classifier!(rust_asset_has_macos, has_macos);
classifier!(rust_asset_has_linux, has_linux);
classifier!(rust_asset_has_arm64, has_arm64);
classifier!(rust_asset_has_universal, has_universal);
#[unsafe(no_mangle)]
#[allow(clippy::missing_safety_doc)]
pub unsafe extern "C" fn rust_asset_has_x64(text: *const c_char, p: *const c_char) -> *mut c_char {
    ffi_string_result(|| {
        // SAFETY: Required by this export's C ABI contract.
        let text = unsafe { input(text)? };
        // SAFETY: Required by this export's C ABI contract.
        let payload = unsafe { input(p)? };
        Some(bool_string(has_x64(text, &tokens_from_payload(payload))))
    })
}

/// # Safety
///
/// This function is unsafe because it dereferences raw pointers. The caller must ensure
/// that all pointers are non-null and point to valid null-terminated UTF-8 C strings.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rust_clean_display_title(
    title: *const c_char,
    display_title: *const c_char,
    part_title: *const c_char,
) -> *mut c_char {
    ffi_string_result(|| {
        // SAFETY: Required by this export's C ABI contract.
        let title = unsafe { input(title)? };
        // SAFETY: Required by this export's C ABI contract.
        let display_title = unsafe { input(display_title)? };
        // SAFETY: Required by this export's C ABI contract.
        let part_title = unsafe { input(part_title)? };
        Some(clean_display_title_impl(title, display_title, part_title))
    })
}

/// # Safety
///
/// This function is unsafe because it dereferences raw pointers. The caller must ensure
/// that both pointers are non-null and point to valid null-terminated UTF-8 C strings.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rust_safe_filename(
    name: *const c_char,
    fallback: *const c_char,
) -> *mut c_char {
    ffi_string_result(|| {
        // SAFETY: Required by this export's C ABI contract.
        let name = unsafe { input(name)? };
        // SAFETY: Required by this export's C ABI contract.
        let fallback = unsafe { input(fallback)? };
        Some(safe_filename_impl(name, fallback))
    })
}

/// # Safety
///
/// This function is unsafe because it dereferences a raw pointer. The caller must ensure
/// that the pointer is non-null and points to a valid null-terminated UTF-8 C string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rust_normalize_version_tag(version: *const c_char) -> *mut c_char {
    ffi_string_result(|| {
        // SAFETY: Required by this export's C ABI contract.
        let version = unsafe { input(version)? };
        Some(normalize_version_tag_impl(version))
    })
}

/// Returns the first three numeric version fields separated by commas.
///
/// # Safety
///
/// This function is unsafe because it dereferences a raw pointer. The caller must ensure
/// that the pointer is non-null and points to a valid null-terminated UTF-8 C string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rust_version_tuple(version: *const c_char) -> *mut c_char {
    ffi_string_result(|| {
        // SAFETY: Required by this export's C ABI contract.
        let version = unsafe { input(version)? };
        Some(
            version_tuple_impl(version)
                .map(|value| value.join(","))
                .unwrap_or_default(),
        )
    })
}

/// Returns the five numeric sort-key fields separated by commas, or an empty string for
/// a successfully processed invalid version.
///
/// # Safety
///
/// This function is unsafe because it dereferences a raw pointer. The caller must ensure
/// that the pointer is non-null and points to a valid null-terminated UTF-8 C string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rust_version_sort_key(version: *const c_char) -> *mut c_char {
    ffi_string_result(|| {
        // SAFETY: Required by this export's C ABI contract.
        let version = unsafe { input(version)? };
        Some(
            version_sort_key_impl(version)
                .map(|value| value.join(","))
                .unwrap_or_default(),
        )
    })
}

/// # Safety
///
/// This function is unsafe because it dereferences a raw pointer. The caller must ensure
/// that the pointer is non-null and points to a valid null-terminated UTF-8 C string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rust_normalize_machine_arch(machine: *const c_char) -> *mut c_char {
    ffi_string_result(|| {
        // SAFETY: Required by this export's C ABI contract.
        let machine = unsafe { input(machine)? };
        Some(normalize_machine_arch_impl(machine))
    })
}

/// # Safety
///
/// `api_url` must point to a valid null-terminated UTF-8 C string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rust_release_list_api_from_latest(api_url: *const c_char) -> *mut c_char {
    ffi_string_result(|| {
        // SAFETY: Required by this export's C ABI contract.
        let api_url = unsafe { input(api_url)? };
        Some(release_list_api_from_latest(api_url))
    })
}

/// # Safety
///
/// Both pointers must point to valid null-terminated UTF-8 C strings.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rust_format_download_proxy_url(
    proxy: *const c_char,
    url: *const c_char,
) -> *mut c_char {
    ffi_string_result(|| {
        // SAFETY: Required by this export's C ABI contract.
        let proxy = unsafe { input(proxy)? };
        // SAFETY: Required by this export's C ABI contract.
        let url = unsafe { input(url)? };
        Some(format_download_proxy_url(proxy, url))
    })
}

/// Returns `1` for a downloadable ZIP, `0` for a valid non-downloadable
/// asset, and `-1` when the FFI input is invalid or the call panics.
///
/// # Safety
///
/// Both pointers must point to valid null-terminated UTF-8 C strings.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rust_is_downloadable_archive(
    name: *const c_char,
    url: *const c_char,
) -> i32 {
    catch_unwind(|| {
        // SAFETY: Required by this export's C ABI contract.
        let name = unsafe { input(name) }.ok_or(())?;
        // SAFETY: Required by this export's C ABI contract.
        let url = unsafe { input(url) }.ok_or(())?;
        Ok::<i32, ()>(i32::from(is_downloadable_archive(name, url)))
    })
    .ok()
    .and_then(Result::ok)
    .unwrap_or(-1)
}

/// Selects the best update asset from a schema-v1 JSON request.
///
/// The returned owned string is a schema-v1 JSON response and must be released
/// with [`rust_free_string`]. A null result means that the pointer/UTF-8 input,
/// JSON syntax, request schema, asset-index ordering, response serialization, or
/// Rust call failed. A valid request with no eligible asset returns a concrete
/// `no_match` response rather than null.
///
/// # Safety
///
/// `request_json` must point to a valid null-terminated UTF-8 C string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rust_select_update_asset(request_json: *const c_char) -> *mut c_char {
    ffi_string_result(|| {
        // SAFETY: Required by this export's C ABI contract.
        let request_json = unsafe { input(request_json)? };
        select_update_asset_json(request_json)
    })
}

/// Selects the best release version from a schema-v1 JSON request.
///
/// Returns an owned JSON string that must be freed.
///
/// # Safety
///
/// `request_json` must point to a valid null-terminated UTF-8 C string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rust_select_release(request_json: *const c_char) -> *mut c_char {
    ffi_string_result(|| {
        let request_json = unsafe { input(request_json)? };
        crate::release_selection::select_release_json(request_json)
    })
}

/// Selects matching video pages from a schema-v1 JSON request.
///
/// Returns an owned JSON string that must be freed with [`rust_free_string`].
///
/// # Safety
///
/// `request_json` must point to a valid null-terminated UTF-8 C string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rust_select_media_pages(request_json: *const c_char) -> *mut c_char {
    ffi_string_result(|| {
        let request_json = unsafe { input(request_json)? };
        crate::media_page_selection::select_media_pages_json(request_json)
    })
}

/// Decides audio-page pairing and binding from a schema-v1 JSON request.
///
/// Returns an owned JSON string that must be freed with [`rust_free_string`].
/// A valid empty page list returns a concrete `no_match` response. Invalid
/// pointers, UTF-8, JSON, schemas, or requests return null.
///
/// # Safety
///
/// `request_json` must point to a valid null-terminated UTF-8 C string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rust_decide_audio_binding(request_json: *const c_char) -> *mut c_char {
    ffi_string_result(|| {
        // SAFETY: Required by this export's C ABI contract.
        let request_json = unsafe { input(request_json)? };
        crate::audio_binding::decide_audio_binding_json(request_json)
    })
}

/// Decides validation and persisted normalization for playback selector mode.
///
/// Rust availability is supplied as an immutable fact. This function performs
/// no backend probing, persistence, or user-facing message construction.
///
/// # Safety
///
/// `request_json` must point to a valid null-terminated UTF-8 C string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rust_decide_playback_selector_policy(
    request_json: *const c_char,
) -> *mut c_char {
    ffi_string_result(|| {
        // SAFETY: Required by this export's C ABI contract.
        let request_json = unsafe { input(request_json)? };
        crate::playback_selector_policy::decide_playback_selector_policy_json(request_json)
    })
}

/// Routes tool preparation from immutable filesystem facts.
///
/// The caller retains all filesystem, subprocess, HTTP, archive, and runtime
/// status responsibilities.
///
/// # Safety
///
/// `request_json` must point to a valid null-terminated UTF-8 C string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rust_decide_tool_prepare_policy(
    request_json: *const c_char,
) -> *mut c_char {
    ffi_string_result(|| {
        // SAFETY: Required by this export's C ABI contract.
        let request_json = unsafe { input(request_json)? };
        crate::tool_prepare_policy::decide_tool_prepare_policy_json(request_json)
    })
}

/// Plans ordered updater download candidates from a schema-v1 JSON request.
///
/// Returns an owned JSON string that must be freed with [`rust_free_string`].
/// A valid request whose inputs normalize to no URLs returns a concrete `empty`
/// response. Invalid pointers, UTF-8, JSON, schemas, source kinds, or indices
/// return null.
///
/// # Safety
///
/// `request_json` must point to a valid null-terminated UTF-8 C string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rust_plan_update_download_candidates(
    request_json: *const c_char,
) -> *mut c_char {
    ffi_string_result(|| {
        // SAFETY: Required by this export's C ABI contract.
        let request_json = unsafe { input(request_json)? };
        crate::download_candidate_planning::plan_update_download_candidates_json(request_json)
    })
}

/// Plans ordered media primary/backup URL candidates from schema-v1 JSON.
///
/// Returns an owned JSON string that must be freed with [`rust_free_string`].
/// Valid inputs that produce no candidates return an `empty` response; invalid
/// pointers, UTF-8, JSON, schemas, modes, stream kinds, or indices return null.
///
/// # Safety
///
/// `request_json` must point to a valid null-terminated UTF-8 C string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rust_plan_media_download_candidates(
    request_json: *const c_char,
) -> *mut c_char {
    ffi_string_result(|| {
        // SAFETY: Required by this export's C ABI contract.
        let request_json = unsafe { input(request_json)? };
        crate::media_download_candidate_planning::plan_media_download_candidates_json(request_json)
    })
}

/// Plans ordered tool primary/fallback URL candidates from schema-v1 JSON.
///
/// Returns an owned JSON string that must be freed with [`rust_free_string`].
/// Valid supplied assets with no usable URL return an `empty` response; invalid
/// or unsupported requests return null and therefore use the Python reference.
///
/// # Safety
///
/// `request_json` must point to a valid null-terminated UTF-8 C string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rust_plan_tool_download_candidates(
    request_json: *const c_char,
) -> *mut c_char {
    ffi_string_result(|| {
        // SAFETY: Required by this export's C ABI contract.
        let request_json = unsafe { input(request_json)? };
        crate::tool_download_candidate_planning::plan_tool_download_candidates_json(request_json)
    })
}

/// Plans the desired, pending, retained, and proposed-preemption cache IDs.
///
/// The returned schema-v1 JSON string is owned by Rust and must be freed with
/// [`rust_free_string`]. Invalid pointers, UTF-8, JSON, schema, identities, or
/// references return null. This function performs no queue or process mutation.
///
/// # Safety
///
/// `request_json` must point to a valid null-terminated UTF-8 C string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rust_plan_cache_window(request_json: *const c_char) -> *mut c_char {
    ffi_string_result(|| {
        // SAFETY: Required by this export's C ABI contract.
        let request_json = unsafe { input(request_json)? };
        crate::cache_planning::plan_cache_window_json(request_json)
    })
}

/// Applies or snapshots the canonical two-layer AV-delay state machine.
///
/// The returned string is Rust-owned and must be freed with [`rust_free_string`].
/// This function performs no locking or persistence.
///
/// # Safety
///
/// `request_json` must point to a valid null-terminated UTF-8 C string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rust_apply_av_delay_action(request_json: *const c_char) -> *mut c_char {
    ffi_string_result(|| {
        // SAFETY: Required by this export's C ABI contract.
        let request_json = unsafe { input(request_json)? };
        crate::av_delay::decide_av_delay_json(request_json)
    })
}

/// Plans a deterministic playlist rebuild or cycle insertion from schema-v1 JSON.
///
/// The returned string is Rust-owned and must be freed with [`rust_free_string`].
/// This function performs no store mutation, locking, persistence, or notification.
///
/// # Safety
///
/// `request_json` must point to a valid null-terminated UTF-8 C string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rust_plan_playlist_order(request_json: *const c_char) -> *mut c_char {
    ffi_string_result(|| {
        // SAFETY: Required by this export's C ABI contract.
        let request_json = unsafe { input(request_json)? };
        crate::playlist_planning::plan_playlist_order_json(request_json)
    })
}

/// Decides canonical playlist identity and active/history duplicate references.
///
/// The returned string is Rust-owned and must be freed with [`rust_free_string`].
///
/// # Safety
///
/// `request_json` must point to a valid null-terminated UTF-8 C string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rust_decide_playlist_duplicate(
    request_json: *const c_char,
) -> *mut c_char {
    ffi_string_result(|| {
        // SAFETY: Required by this export's C ABI contract.
        let request_json = unsafe { input(request_json)? };
        crate::playlist_planning::decide_playlist_duplicate_json(request_json)
    })
}

/// Decides normalized quality, DASH, BBDown, and yt-dlp policy from schema-v1 JSON.
///
/// The returned owned JSON string must be freed with [`rust_free_string`].
/// Invalid pointers, UTF-8, JSON, or schemas return null.
///
/// # Safety
///
/// `request_json` must point to a valid null-terminated UTF-8 C string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rust_decide_quality_policy(request_json: *const c_char) -> *mut c_char {
    ffi_string_result(|| {
        // SAFETY: Required by this export's C ABI contract.
        let request_json = unsafe { input(request_json)? };
        crate::quality_policy::decide_quality_policy_json(request_json)
    })
}

/// Selects and ranks a DASH video stream from schema-v1 JSON.
///
/// A valid empty stream list returns `no_match`; invalid pointers, UTF-8, JSON,
/// schemas, or indices return null. The owned result must be freed with
/// [`rust_free_string`].
///
/// # Safety
///
/// `request_json` must point to a valid null-terminated UTF-8 C string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rust_select_video_stream(request_json: *const c_char) -> *mut c_char {
    ffi_string_result(|| {
        // SAFETY: Required by this export's C ABI contract.
        let request_json = unsafe { input(request_json)? };
        crate::video_stream_ranking::select_video_stream_json(request_json)
    })
}

/// Selects and ranks regular DASH audio from schema-v1 JSON.
///
/// A valid request without an eligible source returns `no_match`; invalid
/// pointers, UTF-8, JSON, schemas, or indices return null. The owned result must
/// be freed with [`rust_free_string`].
///
/// # Safety
///
/// `request_json` must point to a valid null-terminated UTF-8 C string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rust_select_audio_stream(request_json: *const c_char) -> *mut c_char {
    ffi_string_result(|| {
        // SAFETY: Required by this export's C ABI contract.
        let request_json = unsafe { input(request_json)? };
        crate::audio_stream_ranking::select_audio_stream_json(request_json)
    })
}

/// Binds a preferred audio source without ranking regular audio candidates.
///
/// A valid request without an eligible source returns `no_match`; invalid
/// pointers, UTF-8, JSON, schemas, or indices return null. The owned result must
/// be freed with [`rust_free_string`].
///
/// # Safety
///
/// `request_json` must point to a valid null-terminated UTF-8 C string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rust_select_preferred_audio_source(
    request_json: *const c_char,
) -> *mut c_char {
    ffi_string_result(|| {
        // SAFETY: Required by this export's C ABI contract.
        let request_json = unsafe { input(request_json)? };
        crate::preferred_audio_source_binding::select_preferred_audio_source_json(request_json)
    })
}

/// # Safety
///
/// This function is unsafe because it dereferences a raw pointer. The caller must ensure
/// that the pointer is null or was returned by this library as an owned C string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rust_free_string(ptr: *mut c_char) {
    let _ = catch_unwind(|| {
        if !ptr.is_null() {
            // SAFETY: Required by this export's C ABI contract, and null is
            // rejected above.
            let _ = unsafe { CString::from_raw(ptr) };
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_filename_rejects_invalid_ffi_inputs() {
        let fallback = CString::new("fallback.zip").unwrap();
        let invalid_utf8 = [0xff_u8 as c_char, 0];
        unsafe {
            assert!(rust_safe_filename(std::ptr::null(), fallback.as_ptr()).is_null());
            assert!(rust_safe_filename(invalid_utf8.as_ptr(), fallback.as_ptr()).is_null());
        }
    }

    #[test]
    fn title_cleanup_rejects_invalid_ffi_inputs() {
        let empty = CString::new("").unwrap();
        let invalid_utf8 = [0xff_u8 as c_char, 0];
        unsafe {
            assert!(
                rust_clean_display_title(std::ptr::null(), empty.as_ptr(), empty.as_ptr())
                    .is_null()
            );
            assert!(
                rust_clean_display_title(invalid_utf8.as_ptr(), empty.as_ptr(), empty.as_ptr(),)
                    .is_null()
            );
        }
    }

    #[test]
    fn version_exports_reject_invalid_ffi_inputs() {
        let invalid_utf8 = [0xff_u8 as c_char, 0];
        unsafe {
            assert!(rust_normalize_version_tag(std::ptr::null()).is_null());
            assert!(rust_version_tuple(std::ptr::null()).is_null());
            assert!(rust_version_sort_key(std::ptr::null()).is_null());
            assert!(rust_normalize_version_tag(invalid_utf8.as_ptr()).is_null());
            assert!(rust_version_tuple(invalid_utf8.as_ptr()).is_null());
            assert!(rust_version_sort_key(invalid_utf8.as_ptr()).is_null());
        }
    }

    #[test]
    fn machine_arch_export_rejects_invalid_ffi_inputs() {
        let invalid_utf8 = [0xff_u8 as c_char, 0];
        unsafe {
            assert!(rust_normalize_machine_arch(std::ptr::null()).is_null());
            assert!(rust_normalize_machine_arch(invalid_utf8.as_ptr()).is_null());
        }
    }

    #[test]
    fn url_exports_reject_invalid_ffi_inputs() {
        let empty = CString::new("").unwrap();
        let invalid_utf8 = [0xff_u8 as c_char, 0];
        unsafe {
            assert!(rust_release_list_api_from_latest(std::ptr::null()).is_null());
            assert!(rust_release_list_api_from_latest(invalid_utf8.as_ptr()).is_null());
            assert!(rust_format_download_proxy_url(std::ptr::null(), empty.as_ptr()).is_null());
            assert!(
                rust_format_download_proxy_url(empty.as_ptr(), invalid_utf8.as_ptr()).is_null()
            );
        }
    }

    #[test]
    fn archive_export_distinguishes_false_from_failure() {
        let name = CString::new("readme.txt").unwrap();
        let url = CString::new("https://example/readme.txt").unwrap();
        let invalid_utf8 = [0xff_u8 as c_char, 0];
        unsafe {
            assert_eq!(rust_is_downloadable_archive(name.as_ptr(), url.as_ptr()), 0);
            assert_eq!(
                rust_is_downloadable_archive(std::ptr::null(), url.as_ptr()),
                -1
            );
            assert_eq!(
                rust_is_downloadable_archive(name.as_ptr(), invalid_utf8.as_ptr()),
                -1
            );
        }
    }

    #[test]
    fn asset_selection_export_returns_owned_json() {
        let request = CString::new(
            r#"{"schema_version":1,"target":{"platform":"windows","arch":"x64"},"assets":[{"original_index":0,"name":"bilikara-windows-x64.zip","label":"","browser_download_url":"https://example/file.zip","content_type":"application/zip"}]}"#,
        )
        .unwrap();

        unsafe {
            let result = rust_select_update_asset(request.as_ptr());
            assert!(!result.is_null());
            let response = CStr::from_ptr(result).to_str().unwrap();
            assert!(response.contains(r#""status":"selected""#));
            assert!(response.contains(r#""selected_index":0"#));
            rust_free_string(result);
        }
    }

    #[test]
    fn asset_selection_export_rejects_invalid_ffi_and_json_inputs() {
        let invalid_utf8 = [0xff_u8 as c_char, 0];
        let invalid_json = CString::new("not json").unwrap();
        let unsupported_schema = CString::new(
            r#"{"schema_version":2,"target":{"platform":"windows","arch":"x64"},"assets":[]}"#,
        )
        .unwrap();

        unsafe {
            assert!(rust_select_update_asset(std::ptr::null()).is_null());
            assert!(rust_select_update_asset(invalid_utf8.as_ptr()).is_null());
            assert!(rust_select_update_asset(invalid_json.as_ptr()).is_null());
            assert!(rust_select_update_asset(unsupported_schema.as_ptr()).is_null());
        }
    }

    #[test]
    fn select_release_export_rejects_invalid_ffi_and_json_inputs() {
        let invalid_utf8 = [0xff_u8 as c_char, 0];
        let invalid_json = CString::new("not json").unwrap();
        let unsupported_schema = CString::new(
            r#"{"schema_version":2,"current_version":"v0.7.0","include_preview":false,"releases":[]}"#,
        )
        .unwrap();

        unsafe {
            assert!(rust_select_release(std::ptr::null()).is_null());
            assert!(rust_select_release(invalid_utf8.as_ptr()).is_null());
            assert!(rust_select_release(invalid_json.as_ptr()).is_null());
            assert!(rust_select_release(unsupported_schema.as_ptr()).is_null());
        }
    }

    #[test]
    fn select_release_export_returns_owned_json() {
        let request_selected = CString::new(
            r#"{"schema_version":1,"current_version":"v0.7.0","include_preview":false,"releases":[{"tag_name":"v0.8.0","draft":false,"prerelease":false}]}"#,
        )
        .unwrap();
        let request_no_match = CString::new(
            r#"{"schema_version":1,"current_version":"v0.7.0","include_preview":false,"releases":[]}"#,
        )
        .unwrap();

        unsafe {
            let result_selected = rust_select_release(request_selected.as_ptr());
            assert!(!result_selected.is_null());
            let response_selected = CStr::from_ptr(result_selected).to_str().unwrap();
            assert!(response_selected.contains(r#""status":"selected""#));
            assert!(response_selected.contains(r#""selected_index":0"#));
            rust_free_string(result_selected);

            let result_no_match = rust_select_release(request_no_match.as_ptr());
            assert!(!result_no_match.is_null());
            let response_no_match = CStr::from_ptr(result_no_match).to_str().unwrap();
            assert!(response_no_match.contains(r#""status":"no_match""#));
            rust_free_string(result_no_match);
        }
    }

    #[test]
    fn select_media_pages_export_rejects_invalid_inputs() {
        let invalid_utf8 = [0xff_u8 as c_char, 0];
        let invalid_json = CString::new("not json").unwrap();
        let unsupported_schema = CString::new(
            r#"{"schema_version":2,"preferred_page":1,"tolerance_seconds":3,"pages":[]}"#,
        )
        .unwrap();

        unsafe {
            assert!(rust_select_media_pages(std::ptr::null()).is_null());
            assert!(rust_select_media_pages(invalid_utf8.as_ptr()).is_null());
            assert!(rust_select_media_pages(invalid_json.as_ptr()).is_null());
            assert!(rust_select_media_pages(unsupported_schema.as_ptr()).is_null());
        }
    }

    #[test]
    fn select_media_pages_export_returns_owned_json() {
        let request_selected = CString::new(
            r#"{"schema_version":1,"preferred_page":1,"tolerance_seconds":3,"pages":[{"original_index":0,"page":1,"cid":101,"duration":300,"part":"P1"}]}"#,
        )
        .unwrap();
        let request_no_match = CString::new(
            r#"{"schema_version":1,"preferred_page":1,"tolerance_seconds":3,"pages":[]}"#,
        )
        .unwrap();

        unsafe {
            let res_sel = rust_select_media_pages(request_selected.as_ptr());
            assert!(!res_sel.is_null());
            let str_sel = CStr::from_ptr(res_sel).to_str().unwrap();
            assert!(str_sel.contains(r#""status":"selected""#));
            assert!(str_sel.contains(r#""selected_indices":[0]"#));
            rust_free_string(res_sel);

            let res_nomatch = rust_select_media_pages(request_no_match.as_ptr());
            assert!(!res_nomatch.is_null());
            let str_nomatch = CStr::from_ptr(res_nomatch).to_str().unwrap();
            assert!(str_nomatch.contains(r#""status":"no_match""#));
            assert!(str_nomatch.contains(r#""selected_indices":[]"#));
            rust_free_string(res_nomatch);
        }
    }

    #[test]
    fn audio_binding_export_rejects_invalid_ffi_and_json_inputs() {
        let invalid_utf8 = [0xff_u8 as c_char, 0];
        let invalid_json = CString::new("not json").unwrap();
        let unsupported_schema =
            CString::new(r#"{"schema_version":2,"tolerance_seconds":3,"pages":[]}"#).unwrap();

        unsafe {
            assert!(rust_decide_audio_binding(std::ptr::null()).is_null());
            assert!(rust_decide_audio_binding(invalid_utf8.as_ptr()).is_null());
            assert!(rust_decide_audio_binding(invalid_json.as_ptr()).is_null());
            assert!(rust_decide_audio_binding(unsupported_schema.as_ptr()).is_null());
        }
    }

    #[test]
    fn audio_binding_export_returns_owned_json_and_can_be_freed() {
        let request = CString::new(
            r#"{"schema_version":1,"tolerance_seconds":3,"pages":[{"original_index":0,"page":1,"duration":300,"part":"Off Vocal"},{"original_index":1,"page":2,"duration":301,"part":"On Vocal"}]}"#,
        )
        .unwrap();

        unsafe {
            let result = rust_decide_audio_binding(request.as_ptr());
            assert!(!result.is_null());
            let response = CStr::from_ptr(result).to_str().unwrap();
            assert!(response.contains(r#""status":"decided""#));
            assert!(response.contains(r#""mode":"automatic""#));
            assert!(response.contains(r#""selected_indices":[0,1]"#));
            assert!(response.contains(r#""automatic_video_index":1"#));
            rust_free_string(result);
        }
    }

    #[test]
    fn audio_binding_export_uses_shared_panic_containment() {
        let result = ffi_string_result(|| -> Option<String> {
            panic!("simulated audio binding panic");
        });
        assert!(result.is_null());
    }

    #[test]
    fn update_download_planning_export_rejects_invalid_ffi_and_wire_inputs() {
        let invalid_utf8 = [0xff_u8 as c_char, 0];
        let invalid_json = CString::new("not json").unwrap();
        let unsupported_schema =
            CString::new(r#"{"schema_version":2,"candidates":[],"proxy":null}"#).unwrap();
        let invalid_source = CString::new(
            r#"{"schema_version":1,"candidates":[{"original_index":0,"url":"x","source":"unknown"}],"proxy":null}"#,
        )
        .unwrap();
        let invalid_indices = CString::new(
            r#"{"schema_version":1,"candidates":[{"original_index":1,"url":"a","source":"primary"},{"original_index":1,"url":"b","source":"mirror"}],"proxy":null}"#,
        )
        .unwrap();

        unsafe {
            assert!(rust_plan_update_download_candidates(std::ptr::null()).is_null());
            assert!(rust_plan_update_download_candidates(invalid_utf8.as_ptr()).is_null());
            assert!(rust_plan_update_download_candidates(invalid_json.as_ptr()).is_null());
            assert!(rust_plan_update_download_candidates(unsupported_schema.as_ptr()).is_null());
            assert!(rust_plan_update_download_candidates(invalid_source.as_ptr()).is_null());
            assert!(rust_plan_update_download_candidates(invalid_indices.as_ptr()).is_null());
        }
    }

    #[test]
    fn update_download_planning_export_returns_owned_empty_and_planned_json() {
        let empty = CString::new(r#"{"schema_version":1,"candidates":[],"proxy":null}"#).unwrap();
        let planned = CString::new(
            r#"{"schema_version":1,"candidates":[{"original_index":0,"url":"https://example/app.zip","source":"primary"}],"proxy":{"template":"https://proxy/{url}","proxy_first":true}}"#,
        )
        .unwrap();

        unsafe {
            for _ in 0..20 {
                let result = rust_plan_update_download_candidates(empty.as_ptr());
                assert!(!result.is_null());
                let response = CStr::from_ptr(result).to_str().unwrap();
                assert!(response.contains(r#""status":"empty""#));
                assert!(response.contains(r#""candidates":[]"#));
                rust_free_string(result);
            }

            let result = rust_plan_update_download_candidates(planned.as_ptr());
            assert!(!result.is_null());
            let response = CStr::from_ptr(result).to_str().unwrap();
            assert!(response.contains(r#""status":"planned""#));
            assert!(response.contains(r#""route":"proxy""#));
            assert!(response.contains(r#""route":"direct""#));
            rust_free_string(result);
        }
    }

    #[test]
    fn update_download_planning_export_uses_shared_panic_containment() {
        let result = ffi_string_result(|| -> Option<String> {
            panic!("simulated update download planning panic");
        });
        assert!(result.is_null());
    }

    #[test]
    fn media_download_planning_export_rejects_invalid_inputs_and_returns_owned_json() {
        let invalid_utf8 = [0xff_u8 as c_char, 0];
        let invalid_json = CString::new("not json").unwrap();
        let unsupported_schema = CString::new(
            r#"{"schema_version":2,"mode":"dash_streams","stream_kind":"video","streams":[]}"#,
        )
        .unwrap();
        let empty = CString::new(
            r#"{"schema_version":1,"mode":"dash_streams","stream_kind":"video","streams":[]}"#,
        )
        .unwrap();
        let planned = CString::new(
            r#"{"schema_version":1,"mode":"dash_streams","stream_kind":"audio","streams":[{"original_index":0,"primary_url":" a ","backup_urls":["b"]}]}"#,
        )
        .unwrap();
        unsafe {
            assert!(rust_plan_media_download_candidates(std::ptr::null()).is_null());
            assert!(rust_plan_media_download_candidates(invalid_utf8.as_ptr()).is_null());
            assert!(rust_plan_media_download_candidates(invalid_json.as_ptr()).is_null());
            assert!(rust_plan_media_download_candidates(unsupported_schema.as_ptr()).is_null());
            for request in [&empty, &planned] {
                for _ in 0..10 {
                    let result = rust_plan_media_download_candidates(request.as_ptr());
                    assert!(!result.is_null());
                    rust_free_string(result);
                }
            }
        }
    }

    #[test]
    fn tool_download_planning_export_rejects_invalid_inputs_and_returns_owned_json() {
        let invalid_utf8 = [0xff_u8 as c_char, 0];
        let invalid_json = CString::new("not json").unwrap();
        let invalid_enum = CString::new(
            r#"{"schema_version":1,"tool":"unknown","asset":{"mode":"supplied","name":"a","primary_url":""},"fallback_bases":[]}"#,
        )
        .unwrap();
        let empty = CString::new(
            r#"{"schema_version":1,"tool":"bbdown","asset":{"mode":"supplied","name":"a","primary_url":""},"fallback_bases":[]}"#,
        )
        .unwrap();
        let planned = CString::new(
            r#"{"schema_version":1,"tool":"ytdlp","asset":{"mode":"supplied","name":"yt-dlp","primary_url":"https://primary"},"fallback_bases":[{"original_index":0,"base_url":"https://mirror"}]}"#,
        )
        .unwrap();
        unsafe {
            assert!(rust_plan_tool_download_candidates(std::ptr::null()).is_null());
            assert!(rust_plan_tool_download_candidates(invalid_utf8.as_ptr()).is_null());
            assert!(rust_plan_tool_download_candidates(invalid_json.as_ptr()).is_null());
            assert!(rust_plan_tool_download_candidates(invalid_enum.as_ptr()).is_null());
            for request in [&empty, &planned] {
                for _ in 0..10 {
                    let result = rust_plan_tool_download_candidates(request.as_ptr());
                    assert!(!result.is_null());
                    rust_free_string(result);
                }
            }
        }
    }

    #[test]
    fn new_download_planners_use_shared_panic_containment() {
        let result = ffi_string_result(|| -> Option<String> {
            panic!("simulated candidate planning panic");
        });
        assert!(result.is_null());
    }

    #[test]
    fn quality_policy_export_rejects_invalid_inputs_and_repeatedly_frees_owned_json() {
        let invalid_utf8 = [0xff_u8 as c_char, 0];
        let malformed = CString::new("not json").unwrap();
        let unsupported = CString::new(
            r#"{"schema_version":2,"raw_quality":"","raw_cap":"","choice_index":null}"#,
        )
        .unwrap();
        let valid = CString::new(
            r#"{"schema_version":1,"raw_quality":"720P 高清","raw_cap":"","choice_index":2}"#,
        )
        .unwrap();
        unsafe {
            assert!(rust_decide_quality_policy(std::ptr::null()).is_null());
            assert!(rust_decide_quality_policy(invalid_utf8.as_ptr()).is_null());
            assert!(rust_decide_quality_policy(malformed.as_ptr()).is_null());
            assert!(rust_decide_quality_policy(unsupported.as_ptr()).is_null());
            for _ in 0..20 {
                let result = rust_decide_quality_policy(valid.as_ptr());
                assert!(!result.is_null());
                let response = CStr::from_ptr(result).to_str().unwrap();
                assert!(response.contains(r#""status":"decided""#));
                assert!(response.contains(r#""effective_max_height":720"#));
                rust_free_string(result);
            }
        }
    }

    #[test]
    fn video_stream_export_distinguishes_no_match_and_rejects_invalid_indices() {
        let invalid_utf8 = [0xff_u8 as c_char, 0];
        let empty = CString::new(
            r#"{"schema_version":1,"max_quality_id":80,"codec_filter":null,"max_avc_quality_id":null,"streams":[]}"#,
        )
        .unwrap();
        let duplicate = CString::new(
            r#"{"schema_version":1,"max_quality_id":80,"codec_filter":null,"max_avc_quality_id":null,"streams":[{"original_index":0,"quality_id":80,"bandwidth":1,"codec":"avc"},{"original_index":0,"quality_id":64,"bandwidth":1,"codec":"hevc"}]}"#,
        )
        .unwrap();
        let unknown_codec = CString::new(
            r#"{"schema_version":1,"max_quality_id":80,"codec_filter":"codec_99","max_avc_quality_id":null,"streams":[{"original_index":0,"quality_id":80,"bandwidth":1,"codec":"codec_99"}]}"#,
        )
        .unwrap();
        unsafe {
            assert!(rust_select_video_stream(std::ptr::null()).is_null());
            assert!(rust_select_video_stream(invalid_utf8.as_ptr()).is_null());
            assert!(rust_select_video_stream(duplicate.as_ptr()).is_null());
            let result = rust_select_video_stream(empty.as_ptr());
            assert!(!result.is_null());
            assert!(
                CStr::from_ptr(result)
                    .to_str()
                    .unwrap()
                    .contains(r#""status":"no_match""#)
            );
            rust_free_string(result);
            let result = rust_select_video_stream(unknown_codec.as_ptr());
            assert!(!result.is_null());
            assert!(
                CStr::from_ptr(result)
                    .to_str()
                    .unwrap()
                    .contains(r#""selected_index":0"#)
            );
            rust_free_string(result);
        }
    }

    #[test]
    fn audio_stream_export_distinguishes_no_match_and_repeats_allocation_free() {
        let invalid_utf8 = [0xff_u8 as c_char, 0];
        let empty = CString::new(r#"{"schema_version":1,"audio_hires":true,"regular_streams":[]}"#)
            .unwrap();
        let selected = CString::new(
            r#"{"schema_version":1,"audio_hires":true,"regular_streams":[{"original_index":0,"quality_id":30280,"bandwidth":0}]}"#,
        )
        .unwrap();
        unsafe {
            assert!(rust_select_audio_stream(std::ptr::null()).is_null());
            assert!(rust_select_audio_stream(invalid_utf8.as_ptr()).is_null());
            let result = rust_select_audio_stream(empty.as_ptr());
            assert!(!result.is_null());
            assert!(
                CStr::from_ptr(result)
                    .to_str()
                    .unwrap()
                    .contains(r#""status":"no_match""#)
            );
            rust_free_string(result);
            for _ in 0..20 {
                let result = rust_select_audio_stream(selected.as_ptr());
                assert!(!result.is_null());
                assert!(
                    CStr::from_ptr(result)
                        .to_str()
                        .unwrap()
                        .contains(r#""selected_index":0"#)
                );
                rust_free_string(result);
            }
        }
    }

    #[test]
    fn preferred_audio_source_export_validates_input_and_repeats_allocation_free() {
        let invalid_utf8 = [0xff_u8 as c_char, 0];
        let malformed = CString::new("not json").unwrap();
        let unsupported = CString::new(
            r#"{"schema_version":2,"audio_hires":true,"regular_candidates":[],"flac_available":false,"dolby_available":false}"#,
        )
        .unwrap();
        let duplicate = CString::new(
            r#"{"schema_version":1,"audio_hires":true,"regular_candidates":[{"original_index":0},{"original_index":0}],"flac_available":false,"dolby_available":false}"#,
        )
        .unwrap();
        let empty = CString::new(
            r#"{"schema_version":1,"audio_hires":false,"regular_candidates":[],"flac_available":true,"dolby_available":true}"#,
        )
        .unwrap();
        let selected = CString::new(
            r#"{"schema_version":1,"audio_hires":true,"regular_candidates":[{"original_index":3},{"original_index":8}],"flac_available":true,"dolby_available":true}"#,
        )
        .unwrap();
        unsafe {
            assert!(rust_select_preferred_audio_source(std::ptr::null()).is_null());
            assert!(rust_select_preferred_audio_source(invalid_utf8.as_ptr()).is_null());
            assert!(rust_select_preferred_audio_source(malformed.as_ptr()).is_null());
            assert!(rust_select_preferred_audio_source(unsupported.as_ptr()).is_null());
            assert!(rust_select_preferred_audio_source(duplicate.as_ptr()).is_null());
            let result = rust_select_preferred_audio_source(empty.as_ptr());
            assert!(!result.is_null());
            assert!(
                CStr::from_ptr(result)
                    .to_str()
                    .unwrap()
                    .contains(r#""status":"no_match""#)
            );
            rust_free_string(result);
            for _ in 0..20 {
                let result = rust_select_preferred_audio_source(selected.as_ptr());
                assert!(!result.is_null());
                let response = CStr::from_ptr(result).to_str().unwrap();
                assert!(response.contains(r#""preferred_source":"dolby""#));
                assert!(response.contains(r#""selected_regular_index":3"#));
                rust_free_string(result);
            }
        }
    }

    #[test]
    fn cache_plan_export_is_strict_and_repeats_allocation_free() {
        let invalid_utf8 = [0xff_u8 as c_char, 0];
        let malformed = CString::new("not json").unwrap();
        let unsupported = CString::new(
            r#"{"schema_version":2,"items":[],"max_items":0,"retention_limit":0,"active_item_ids":[],"primary_active_item_id":null,"urgent_item_ids":[]}"#,
        )
        .unwrap();
        let duplicate = CString::new(
            r#"{"schema_version":1,"items":[{"original_index":0,"item_id":"a","cache_ready":false},{"original_index":1,"item_id":"a","cache_ready":true}],"max_items":2,"retention_limit":0,"active_item_ids":[],"primary_active_item_id":null,"urgent_item_ids":[]}"#,
        )
        .unwrap();
        let unknown_reference = CString::new(
            r#"{"schema_version":1,"items":[],"max_items":0,"retention_limit":0,"active_item_ids":["missing"],"primary_active_item_id":null,"urgent_item_ids":[]}"#,
        )
        .unwrap();
        let valid = CString::new(
            r#"{"schema_version":1,"items":[],"max_items":0,"retention_limit":0,"active_item_ids":[],"primary_active_item_id":null,"urgent_item_ids":[]}"#,
        )
        .unwrap();
        unsafe {
            assert!(rust_plan_cache_window(std::ptr::null()).is_null());
            assert!(rust_plan_cache_window(invalid_utf8.as_ptr()).is_null());
            assert!(rust_plan_cache_window(malformed.as_ptr()).is_null());
            assert!(rust_plan_cache_window(unsupported.as_ptr()).is_null());
            assert!(rust_plan_cache_window(duplicate.as_ptr()).is_null());
            assert!(rust_plan_cache_window(unknown_reference.as_ptr()).is_null());
            for _ in 0..20 {
                let result = rust_plan_cache_window(valid.as_ptr());
                assert!(!result.is_null());
                let response = CStr::from_ptr(result).to_str().unwrap();
                assert!(response.contains(r#""desired_ids":[]"#));
                rust_free_string(result);
            }
        }
    }

    #[test]
    fn cache_plan_export_uses_shared_panic_containment() {
        let result = ffi_string_result(|| -> Option<String> {
            panic!("simulated cache planning panic");
        });
        assert!(result.is_null());
    }

    #[test]
    fn playlist_order_export_is_strict_and_repeats_allocation_free() {
        let invalid_utf8 = [0xff_u8 as c_char, 0];
        let invalid_payloads = [
            "not json",
            r#"{"schema_version":2,"operation":"rebuild","session_users":[],"current_requester":null,"items":[],"candidate":null}"#,
            r#"{"schema_version":1,"operation":"bad","session_users":[],"current_requester":null,"items":[],"candidate":null}"#,
            r#"{"schema_version":1,"operation":"rebuild","session_users":[],"current_requester":null,"items":[],"candidate":null,"unknown":true}"#,
            r#"{"schema_version":1,"operation":"rebuild","session_users":["A","A"],"current_requester":null,"items":[],"candidate":null}"#,
            r#"{"schema_version":1,"operation":"rebuild","session_users":[],"current_requester":null,"items":[{"original_index":true,"item_id":"a","requester_name":"","slot_type":"cycle"}],"candidate":null}"#,
            r#"{"schema_version":1,"operation":"rebuild","session_users":[],"current_requester":null,"items":[{"original_index":-1,"item_id":"a","requester_name":"","slot_type":"cycle"}],"candidate":null}"#,
            r#"{"schema_version":1,"operation":"rebuild","session_users":[],"current_requester":null,"items":[{"original_index":18446744073709551616,"item_id":"a","requester_name":"","slot_type":"cycle"}],"candidate":null}"#,
            r#"{"schema_version":1,"operation":"rebuild","session_users":[],"current_requester":null,"items":[{"original_index":0,"item_id":"a","requester_name":"","slot_type":"bad"}],"candidate":null}"#,
            r#"{"schema_version":1,"operation":"rebuild","session_users":[],"current_requester":null,"items":[{"original_index":0,"item_id":"a","requester_name":"","slot_type":"cycle"},{"original_index":1,"item_id":"a","requester_name":"","slot_type":"cycle"}],"candidate":null}"#,
            r#"{"schema_version":1,"operation":"insert_cycle","session_users":[],"current_requester":null,"items":[{"original_index":0,"item_id":"a","requester_name":"","slot_type":"cycle"}],"candidate":{"original_index":1,"item_id":"a","requester_name":"","slot_type":"cycle"}}"#,
        ];
        let valid = CString::new(r#"{"schema_version":1,"operation":"rebuild","session_users":[],"current_requester":null,"items":[],"candidate":null}"#).unwrap();
        let oversized = CString::new(format!(
            r#"{{"schema_version":1,"operation":"rebuild","session_users":[],"current_requester":null,"items":[{{"original_index":0,"item_id":"{}","requester_name":"","slot_type":"cycle"}}],"candidate":null}}"#,
            "x".repeat(513)
        ))
        .unwrap();
        let oversized_count = CString::new(format!(
            r#"{{"schema_version":1,"operation":"rebuild","session_users":[],"current_requester":null,"items":[{}],"candidate":null}}"#,
            (0..=10_000)
                .map(|index| format!(r#"{{"original_index":{index},"item_id":"item-{index}","requester_name":"","slot_type":"cycle"}}"#))
                .collect::<Vec<_>>()
                .join(",")
        ))
        .unwrap();
        unsafe {
            assert!(rust_plan_playlist_order(std::ptr::null()).is_null());
            assert!(rust_plan_playlist_order(invalid_utf8.as_ptr()).is_null());
            for payload in invalid_payloads {
                let payload = CString::new(payload).unwrap();
                assert!(rust_plan_playlist_order(payload.as_ptr()).is_null());
            }
            assert!(rust_plan_playlist_order(oversized.as_ptr()).is_null());
            assert!(rust_plan_playlist_order(oversized_count.as_ptr()).is_null());
            for _ in 0..20 {
                let result = rust_plan_playlist_order(valid.as_ptr());
                assert!(!result.is_null());
                assert!(
                    CStr::from_ptr(result)
                        .to_str()
                        .unwrap()
                        .contains(r#""ordered_ids":[]"#)
                );
                rust_free_string(result);
            }
        }
    }

    #[test]
    fn playlist_duplicate_export_is_strict_and_repeats_allocation_free() {
        let invalid_utf8 = [0xff_u8 as c_char, 0];
        let invalid_payloads = [
            "not json",
            r#"{"schema_version":2,"candidate":{"bvid":"BV","aid":1,"video_page":1,"selected_audio_pages":[]},"current_item":null,"queued_items":[],"history_entries":[]}"#,
            r#"{"schema_version":1,"candidate":{"bvid":"BV","aid":true,"video_page":1,"selected_audio_pages":[]},"current_item":null,"queued_items":[],"history_entries":[]}"#,
            r#"{"schema_version":1,"candidate":{"bvid":"BV","aid":-1,"video_page":1,"selected_audio_pages":[]},"current_item":null,"queued_items":[],"history_entries":[]}"#,
            r#"{"schema_version":1,"candidate":{"bvid":"BV","aid":18446744073709551616,"video_page":1,"selected_audio_pages":[]},"current_item":null,"queued_items":[],"history_entries":[]}"#,
            r#"{"schema_version":1,"candidate":{"bvid":"BV","aid":1,"video_page":0,"selected_audio_pages":[]},"current_item":null,"queued_items":[],"history_entries":[]}"#,
            r#"{"schema_version":1,"candidate":{"bvid":"BV","aid":1,"video_page":1,"selected_audio_pages":[]},"current_item":null,"queued_items":[],"history_entries":[],"extra":1}"#,
            r#"{"schema_version":1,"candidate":{"bvid":"BV","aid":1,"video_page":1,"selected_audio_pages":[]},"current_item":{"original_index":0,"item_id":"a","identity":{"bvid":"BV","aid":1,"video_page":1,"selected_audio_pages":[]}},"queued_items":[{"original_index":0,"item_id":"b","identity":{"bvid":"BV2","aid":2,"video_page":1,"selected_audio_pages":[]}}],"history_entries":[]}"#,
            r#"{"schema_version":1,"candidate":{"bvid":"BV","aid":1,"video_page":1,"selected_audio_pages":[]},"current_item":null,"queued_items":[],"history_entries":[{"original_index":0,"key":"valid\u0000invalid"}]}"#,
            r#"{"schema_version":1,"candidate":{"bvid":"BV","aid":1,"video_page":1,"selected_audio_pages":[]},"current_item":null,"queued_items":[],"history_entries":[{"original_index":0,"key":123}]}"#,
        ];
        let valid = CString::new(r#"{"schema_version":1,"candidate":{"bvid":"BV","aid":1,"video_page":1,"selected_audio_pages":[]},"current_item":null,"queued_items":[],"history_entries":[]}"#).unwrap();
        let oversized = CString::new(format!(
            r#"{{"schema_version":1,"candidate":{{"bvid":"{}","aid":1,"video_page":1,"selected_audio_pages":[]}},"current_item":null,"queued_items":[],"history_entries":[]}}"#,
            "x".repeat(513)
        ))
        .unwrap();
        let oversized_count = CString::new(format!(
            r#"{{"schema_version":1,"candidate":{{"bvid":"BV","aid":1,"video_page":1,"selected_audio_pages":[]}},"current_item":null,"queued_items":[],"history_entries":[{}]}}"#,
            (0..=10_000)
                .map(|index| format!(r#"{{"original_index":{index},"key":""}}"#))
                .collect::<Vec<_>>()
                .join(",")
        ))
        .unwrap();
        let oversized_history_key = CString::new(format!(
            r#"{{"schema_version":1,"candidate":{{"bvid":"BV","aid":1,"video_page":1,"selected_audio_pages":[]}},"current_item":null,"queued_items":[],"history_entries":[{{"original_index":0,"key":"{}"}}]}}"#,
            "x".repeat(8_193)
        ))
        .unwrap();
        let audio_pages = (0..256)
            .map(|_| i64::MAX.to_string())
            .collect::<Vec<_>>()
            .join(",");
        let maximum_key = format!(
            "{}:p{}:a{}",
            "B".repeat(512),
            usize::MAX,
            audio_pages.replace(',', "-")
        );
        let maximum = CString::new(format!(
            r#"{{"schema_version":1,"candidate":{{"bvid":"{}","aid":{},"video_page":{},"selected_audio_pages":[{}]}},"current_item":null,"queued_items":[],"history_entries":[{{"original_index":9,"key":"{}"}}]}}"#,
            "B".repeat(512),
            u64::MAX,
            usize::MAX,
            audio_pages,
            maximum_key
        ))
        .unwrap();
        unsafe {
            assert!(rust_decide_playlist_duplicate(std::ptr::null()).is_null());
            assert!(rust_decide_playlist_duplicate(invalid_utf8.as_ptr()).is_null());
            for payload in invalid_payloads {
                let payload = CString::new(payload).unwrap();
                assert!(rust_decide_playlist_duplicate(payload.as_ptr()).is_null());
            }
            assert!(rust_decide_playlist_duplicate(oversized.as_ptr()).is_null());
            assert!(rust_decide_playlist_duplicate(oversized_count.as_ptr()).is_null());
            assert!(rust_decide_playlist_duplicate(oversized_history_key.as_ptr()).is_null());
            let maximum_result = rust_decide_playlist_duplicate(maximum.as_ptr());
            assert!(!maximum_result.is_null());
            assert!(
                CStr::from_ptr(maximum_result)
                    .to_str()
                    .unwrap()
                    .contains(r#""history_duplicate_index":9"#)
            );
            rust_free_string(maximum_result);
            for _ in 0..20 {
                let result = rust_decide_playlist_duplicate(valid.as_ptr());
                assert!(!result.is_null());
                assert!(
                    CStr::from_ptr(result)
                        .to_str()
                        .unwrap()
                        .contains(r#""identity_key":"BV:p1""#)
                );
                rust_free_string(result);
            }
        }
    }

    #[test]
    fn playlist_planning_exports_use_shared_panic_containment() {
        let result = ffi_string_result(|| -> Option<String> {
            panic!("simulated playlist planning panic");
        });
        assert!(result.is_null());
    }

    #[test]
    fn quality_and_stream_exports_use_shared_panic_containment() {
        let result = ffi_string_result(|| -> Option<String> {
            panic!("simulated quality and stream ranking panic");
        });
        assert!(result.is_null());
    }
}
