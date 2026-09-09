//! Narrow package-path diagnostic in the existing developer driver.
use super::*;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use windows_sys::Win32::System::LibraryLoader::{
    GetDllDirectoryW, GetModuleFileNameW, GetModuleHandleW,
};

pub fn run(args: &[std::ffi::OsString]) -> i32 {
    if args.len() != 2 {
        return 2;
    }
    let companion = PathBuf::from(&args[0]);
    let root = PathBuf::from(&args[1]).canonicalize().unwrap();
    let loaded = unsafe { LibavMetadataProbe::load(&companion) };
    let Ok(probe) = loaded else {
        let outcome = if matches!(
            loaded,
            Err(bilikara_runtime::experimental_libav::ProbeError::Unavailable(_))
        ) {
            "unavailable"
        } else {
            "error"
        };
        println!("{}", serde_json::json!({"outcome": outcome}));
        return 1;
    };
    let manifest: serde_json::Value = serde_json::from_slice(
        &std::fs::read(companion.parent().unwrap().join("ffmpeg-runtime.json")).unwrap(),
    )
    .unwrap();
    let mut modules = Vec::new();
    for name in manifest["pe"].as_object().unwrap().keys() {
        let wide: Vec<u16> = std::ffi::OsStr::new(name)
            .encode_wide()
            .chain(Some(0))
            .collect();
        let module = unsafe { GetModuleHandleW(wide.as_ptr()) };
        if module.is_null() {
            continue;
        }
        let mut buffer = vec![0; 32768];
        let n = unsafe { GetModuleFileNameW(module, buffer.as_mut_ptr(), buffer.len() as u32) };
        if n == 0 || n as usize >= buffer.len() {
            return 1;
        }
        let path = PathBuf::from(std::ffi::OsString::from_wide(&buffer[..n as usize]))
            .canonicalize()
            .unwrap();
        let system = PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join("System32")
            .canonicalize()
            .unwrap();
        let actual = match path.strip_prefix(&root) {
            Ok(p) => p.to_string_lossy().replace('\\', "/"),
            Err(_) if path.parent() == Some(system.as_path()) => format!("SYSTEM32/{name}"),
            Err(_) => return 1,
        };
        modules.push(serde_json::json!({"name":name, "actual":actual,
            "intended":format!("_internal/vendor/{name}")}));
    }
    let required = ["avformat-", "avcodec-", "avutil-"];
    if !required.iter().all(|p| {
        modules
            .iter()
            .any(|m| m["name"].as_str().unwrap().starts_with(p))
    }) {
        return 1;
    }
    let mut directory = vec![0; 32768];
    let n = unsafe { GetDllDirectoryW(directory.len() as u32, directory.as_mut_ptr()) };
    if n as usize >= directory.len() {
        return 1;
    }
    let dll_directory = if n == 0 {
        "default".to_owned()
    } else {
        let path = PathBuf::from(std::ffi::OsString::from_wide(&directory[..n as usize]))
            .canonicalize()
            .unwrap();
        match path.strip_prefix(&root) {
            Ok(p) => p.to_string_lossy().replace('\\', "/"),
            Err(_) => return 1,
        }
    };
    println!(
        "{}",
        serde_json::json!({"outcome":"success", "process":"libav_metadata.exe (Runtime rlib)",
        "dll_directory": dll_directory,
        "modules": modules, "version":probe.backend_info().runtime_version,
        "scan":probe.packet_scan_available(), "mp4":probe.copy_remux_available(),
        "flac":probe.copy_profile_available(bilikara_runtime::experimental_libav::CopyProfile::Flac)})
    );
    0
}
