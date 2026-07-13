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
}
