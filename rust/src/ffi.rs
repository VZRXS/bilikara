use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use std::panic::{catch_unwind, UnwindSafe};

use crate::asset_tokens::{
    asset_tokens, has_arm64, has_linux, has_macos, has_universal, has_windows, has_x64,
};
use crate::filename::safe_filename_impl;
use crate::platform::normalize_machine_arch_impl;
use crate::title_cleanup::clean_display_title_impl;
use crate::version::{normalize_version_tag_impl, version_sort_key_impl, version_tuple_impl};

#[no_mangle]
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
        CStr::from_ptr(p).to_str().ok()
    }
}
fn tokens_from_payload(p: &str) -> std::collections::HashSet<String> {
    p.lines()
        .filter(|v| !v.is_empty())
        .map(str::to_string)
        .collect()
}

#[no_mangle]
#[allow(clippy::missing_safety_doc)]
pub unsafe extern "C" fn rust_asset_tokens(p: *const c_char) -> *mut c_char {
    ffi_string_result(|| {
        let mut v: Vec<_> = asset_tokens(input(p)?).into_iter().collect();
        v.sort();
        Some(v.join("\n"))
    })
}
macro_rules! classifier {
    ($name:ident,$fun:ident) => {
        #[no_mangle]
        #[allow(clippy::missing_safety_doc)]
        pub unsafe extern "C" fn $name(p: *const c_char) -> *mut c_char {
            ffi_string_result(|| Some(bool_string($fun(&tokens_from_payload(input(p)?)))))
        }
    };
}
classifier!(rust_asset_has_windows, has_windows);
classifier!(rust_asset_has_macos, has_macos);
classifier!(rust_asset_has_linux, has_linux);
classifier!(rust_asset_has_arm64, has_arm64);
classifier!(rust_asset_has_universal, has_universal);
#[no_mangle]
#[allow(clippy::missing_safety_doc)]
pub unsafe extern "C" fn rust_asset_has_x64(text: *const c_char, p: *const c_char) -> *mut c_char {
    ffi_string_result(|| {
        Some(bool_string(has_x64(
            input(text)?,
            &tokens_from_payload(input(p)?),
        )))
    })
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
/// that the pointer is non-null and points to a valid null-terminated UTF-8 C string.
#[no_mangle]
pub unsafe extern "C" fn rust_normalize_machine_arch(machine: *const c_char) -> *mut c_char {
    ffi_string_result(|| {
        if machine.is_null() {
            return None;
        }
        let machine = CStr::from_ptr(machine).to_str().ok()?;
        Some(normalize_machine_arch_impl(machine))
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

    #[test]
    fn machine_arch_export_rejects_invalid_ffi_inputs() {
        let invalid_utf8 = [0xff_u8 as c_char, 0];
        unsafe {
            assert!(rust_normalize_machine_arch(std::ptr::null()).is_null());
            assert!(rust_normalize_machine_arch(invalid_utf8.as_ptr()).is_null());
        }
    }
}
