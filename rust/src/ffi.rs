use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use std::panic::{catch_unwind, UnwindSafe};

use crate::filename::safe_filename_impl;
use crate::title_cleanup::clean_display_title_impl;
use crate::version::{normalize_version_tag_impl, version_sort_key_impl, version_tuple_impl};

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

/// # Safety
///
/// This function is unsafe because it dereferences raw pointers. The caller must ensure
/// that all pointers are non-null and point to valid null-terminated UTF-8 C strings.
#[no_mangle]
pub unsafe extern "C" fn rust_clean_display_title(
    title: *const c_char,
    display_title: *const c_char,
    part_title: *const c_char,
) -> *mut c_char {
    ffi_string_result(|| {
        if title.is_null() || display_title.is_null() || part_title.is_null() {
            return None;
        }
        let title = CStr::from_ptr(title).to_str().ok()?;
        let display_title = CStr::from_ptr(display_title).to_str().ok()?;
        let part_title = CStr::from_ptr(part_title).to_str().ok()?;
        Some(clean_display_title_impl(title, display_title, part_title))
    })
}

/// # Safety
///
/// This function is unsafe because it dereferences raw pointers. The caller must ensure
/// that both pointers are non-null and point to valid null-terminated UTF-8 C strings.
#[no_mangle]
pub unsafe extern "C" fn rust_safe_filename(
    name: *const c_char,
    fallback: *const c_char,
) -> *mut c_char {
    ffi_string_result(|| {
        if name.is_null() || fallback.is_null() {
            return None;
        }
        let name = CStr::from_ptr(name).to_str().ok()?;
        let fallback = CStr::from_ptr(fallback).to_str().ok()?;
        Some(safe_filename_impl(name, fallback))
    })
}

/// # Safety
///
/// This function is unsafe because it dereferences a raw pointer. The caller must ensure
/// that the pointer is non-null and points to a valid null-terminated UTF-8 C string.
#[no_mangle]
pub unsafe extern "C" fn rust_normalize_version_tag(version: *const c_char) -> *mut c_char {
    ffi_string_result(|| {
        if version.is_null() {
            return None;
        }
        let version = CStr::from_ptr(version).to_str().ok()?;
        Some(normalize_version_tag_impl(version))
    })
}

/// Returns the first three numeric version fields separated by commas.
///
/// # Safety
///
/// This function is unsafe because it dereferences a raw pointer. The caller must ensure
/// that the pointer is non-null and points to a valid null-terminated UTF-8 C string.
#[no_mangle]
pub unsafe extern "C" fn rust_version_tuple(version: *const c_char) -> *mut c_char {
    ffi_string_result(|| {
        if version.is_null() {
            return None;
        }
        let version = CStr::from_ptr(version).to_str().ok()?;
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
#[no_mangle]
pub unsafe extern "C" fn rust_version_sort_key(version: *const c_char) -> *mut c_char {
    ffi_string_result(|| {
        if version.is_null() {
            return None;
        }
        let version = CStr::from_ptr(version).to_str().ok()?;
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
/// that the pointer is null or was returned by this library as an owned C string.
#[no_mangle]
pub unsafe extern "C" fn rust_free_string(ptr: *mut c_char) {
    let _ = catch_unwind(|| {
        if !ptr.is_null() {
            let _ = CString::from_raw(ptr);
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
            assert!(rust_clean_display_title(
                invalid_utf8.as_ptr(),
                empty.as_ptr(),
                empty.as_ptr(),
            )
            .is_null());
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
}
