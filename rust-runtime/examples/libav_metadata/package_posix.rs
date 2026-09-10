//! Actual loaded-image provenance for a relocated POSIX package.
use super::*;
use std::ffi::{CStr, CString};
use std::os::unix::ffi::OsStrExt;

pub fn run(args: &[std::ffi::OsString]) -> i32 {
    if args.len() != 2 {
        return 2;
    }
    match inspect(&PathBuf::from(&args[0]), &PathBuf::from(&args[1])) {
        Ok(report) => {
            println!("{report}");
            0
        }
        Err(()) => {
            println!("{}", serde_json::json!({"outcome": "unavailable"}));
            1
        }
    }
}

fn inspect(companion: &std::path::Path, root: &std::path::Path) -> Result<serde_json::Value, ()> {
    let root = root.canonicalize().map_err(|_| ())?;
    let parent = companion
        .parent()
        .ok_or(())?
        .canonicalize()
        .map_err(|_| ())?;
    // SAFETY: explicit trusted package artifact, matching the developer driver.
    let probe = unsafe { LibavMetadataProbe::load(companion) }.map_err(|_| ())?;
    let filename = CString::new(companion.as_os_str().as_bytes()).map_err(|_| ())?;
    // Acquire our own reference so every diagnostic exit can close it.
    let handle = unsafe { libc::dlopen(filename.as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL) };
    if handle.is_null() {
        return Err(());
    }
    let result = (|| {
        let mut modules = Vec::new();
        for symbol in [
            c"bm_abi_version",
            c"avformat_version",
            c"avcodec_version",
            c"avutil_version",
        ] {
            let address = unsafe { libc::dlsym(handle, symbol.as_ptr()) };
            let mut info = std::mem::MaybeUninit::<libc::Dl_info>::zeroed();
            if address.is_null() || unsafe { libc::dladdr(address, info.as_mut_ptr()) } == 0 {
                return Err(());
            }
            let info = unsafe { info.assume_init() };
            if info.dli_fname.is_null() {
                return Err(());
            }
            let path = std::path::Path::new(std::ffi::OsStr::from_bytes(unsafe {
                CStr::from_ptr(info.dli_fname).to_bytes()
            }))
            .canonicalize()
            .map_err(|_| ())?;
            if path.parent() != Some(parent.as_path()) {
                return Err(());
            }
            let actual = path.strip_prefix(&root).map_err(|_| ())?;
            modules.push(serde_json::json!({"symbol": symbol.to_string_lossy(),
                "actual": actual, "name": path.file_name()}));
        }
        Ok(serde_json::json!({"outcome": "success", "modules": modules,
            "version": probe.backend_info().runtime_version,
            "scan": probe.packet_scan_available(), "mp4": probe.copy_remux_available(),
            "flac": probe.copy_profile_available(bilikara_runtime::experimental_libav::CopyProfile::Flac)}))
    })();
    unsafe { libc::dlclose(handle) };
    result
}
