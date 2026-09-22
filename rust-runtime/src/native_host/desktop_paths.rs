//! Trusted desktop launch facts. No request body can choose these paths.
use super::*;
use std::ffi::OsString;

pub(super) fn resource_root(executable: &Path) -> Result<PathBuf, String> {
    let parent = executable
        .parent()
        .ok_or("Backend has no parent directory")?;
    Ok(
        if parent.file_name().is_some_and(|n| n == "MacOS")
            && parent.parent().is_some_and(|p| p.ends_with("Contents"))
        {
            parent.parent().unwrap().join("Resources")
        } else {
            parent.to_owned()
        },
    )
}

pub(super) fn package_assets(root: &Path) -> Result<PathBuf, String> {
    let manifest: serde_json::Value = serde_json::from_slice(
        &std::fs::read(root.join("native-desktop.json"))
            .map_err(|_| "Missing native-desktop.json; reinstall the complete bundle or run npm run prepare:desktop")?,
    ).map_err(|_| "Invalid native desktop layout manifest")?;
    if manifest["schema_version"] != 1
        || manifest["backend"] != "rust"
        || manifest["platform"] != PLATFORM
        || manifest["arch"] != machine_arch()
        || manifest["version"]
            .as_str()
            .and_then(sane_version)
            .is_none()
        || read_version_file(&root.join("APP_VERSION")).as_deref() != manifest["version"].as_str()
    {
        return Err("Incompatible native desktop bundle or missing APP_VERSION".into());
    }
    if manifest["development"] != true {
        let vendor = root.join("vendor");
        let bbdown = if cfg!(windows) {
            "BBDown.exe"
        } else {
            "BBDown"
        };
        if !vendor.join(bbdown).is_file()
            || !vendor.join(companion_name()).is_file()
            || !vendor.join("ffmpeg-runtime.json").is_file()
            || (cfg!(target_os = "macos") && !vendor.join("aria2-macos.json").is_file())
        {
            return Err(
                "Incomplete native desktop tools/libav resources; reinstall the complete bundle"
                    .into(),
            );
        }
    }
    Ok(root.join("static"))
}

fn companion_name() -> &'static str {
    if cfg!(windows) {
        "bilikara_media_libav.dll"
    } else if cfg!(target_os = "macos") {
        "libbilikara_media_libav.dylib"
    } else {
        "libbilikara_media_libav.so"
    }
}

pub(super) fn configure_media(resources: &Path) -> Result<(), String> {
    let vendor = resources.join("vendor");
    let companion = if vendor.join("ffmpeg-runtime.json").is_file() {
        Some(
            vendor
                .join(companion_name())
                .canonicalize()
                .map_err(|_| "Missing packaged libav companion")?,
        )
    } else {
        std::env::var_os("BILIKARA_LIBAV_COMPANION")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
    };
    if let Some(path) = &companion {
        if !path.is_absolute() || !path.is_file() {
            return Err("Invalid trusted libav companion path".into());
        }
        // Trusted installed code, admitted before any network/worker starts.
        unsafe { crate::experimental_libav::LibavMetadataProbe::load(path) }
            .map_err(|_| "Packaged libav companion or its dependencies are incompatible")?;
    }
    crate::media_routing::configure(crate::media_routing::Configuration {
        mode: crate::media_routing::Mode::Default,
        companion,
    })
    .map_err(|e| e.message.to_owned())?;
    Ok(())
}

pub(super) fn data_root(
    explicit: Option<PathBuf>,
    executable: &Path,
    platform: &str,
    env: impl Fn(&str) -> Option<OsString>,
) -> Result<PathBuf, String> {
    let selected = explicit.or_else(|| {
        [
            "BILIKARA_NATIVE_DATA_DIR",
            "BILIKARA_DESKTOP_RUST_PREVIEW_DIR",
            "BILIKARA_HOME",
        ]
        .iter()
        .find_map(|key| env(key).filter(|v| !v.is_empty()).map(PathBuf::from))
    });
    if let Some(path) = selected {
        if !path.is_absolute() {
            return Err("Native data directory must be absolute".into());
        }
        return Ok(path);
    }
    let home = || {
        env("HOME")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .ok_or("HOME is unavailable")
    };
    let base = match platform {
        "windows" => env("LOCALAPPDATA")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .ok_or("LOCALAPPDATA is unavailable")?
            .join("bilikara"),
        "macos" => home()?.join("Library/Application Support/bilikara"),
        _ => env("XDG_DATA_HOME")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .map(Ok)
            .unwrap_or_else(|| home().map(|h| h.join(".local/share")))?
            .join("bilikara"),
    };
    if !base.is_absolute() {
        return Err("Platform application data directory must be absolute".into());
    }
    let native = base.join("native");
    // A present native directory is validated by storage, never replaced from
    // legacy data. Only known previous install locations are inspected.
    if !native.join(MARKER).is_file() {
        let mut legacy = vec![base];
        if platform == "windows"
            && let Some(parent) = executable.parent()
        {
            legacy.push(parent.join("runtime"));
        }
        for source in legacy {
            if source.join("data").exists() || source.join("state.json").exists() {
                return Err(format!(
                    "Legacy desktop records found at {}. Choose an explicit import: bilikara-desktop-host --import-from \"{}\" --data-dir \"{}\". The source will remain unchanged.",
                    source.display(),
                    source.display(),
                    native.display()
                ));
            }
        }
    }
    Ok(native)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_defaults_are_platform_data_paths_and_overrides_do_not_select_a_backend() {
        let home = std::env::temp_dir().join(format!("desktop-paths-{}", token().unwrap()));
        let env = |key: &str| match key {
            "HOME" | "LOCALAPPDATA" => Some(home.clone().into_os_string()),
            _ => None,
        };
        assert_eq!(
            data_root(None, Path::new("/installed/host"), "linux", env).unwrap(),
            home.join(".local/share/bilikara/native")
        );
        assert_eq!(
            data_root(None, Path::new("/installed/host"), "macos", env).unwrap(),
            home.join("Library/Application Support/bilikara/native")
        );
        assert_eq!(
            data_root(None, Path::new("/installed/host"), "windows", env).unwrap(),
            home.join("bilikara/native")
        );
        assert!(data_root(Some("relative".into()), Path::new("/host"), "linux", env).is_err());
        assert_eq!(
            data_root(None, Path::new("/host"), "linux", |k| {
                if k == "BILIKARA_DESKTOP_RUST_PREVIEW_DIR" {
                    Some(home.clone().into_os_string())
                } else {
                    env(k)
                }
            })
            .unwrap(),
            home
        );
    }
    #[test]
    fn legacy_detection_never_creates_or_reimports_native_data() {
        let home = std::env::temp_dir().join(format!("desktop-legacy-{}", token().unwrap()));
        let base = home.join("Library/Application Support/bilikara");
        std::fs::create_dir_all(base.join("data")).unwrap();
        let env = |_: &str| Some(home.clone().into_os_string());
        let result = data_root(None, Path::new("/host"), "macos", |k| {
            if k == "HOME" { env(k) } else { None }
        });
        assert!(result.unwrap_err().contains("--import-from"));
        assert!(!base.join("native").exists());
        std::fs::create_dir(base.join("native")).unwrap();
        std::fs::write(
            base.join("native").join(MARKER),
            b"desktop-rust-preview-v1\n",
        )
        .unwrap();
        assert_eq!(
            data_root(None, Path::new("/host"), "macos", |k| if k == "HOME" {
                env(k)
            } else {
                None
            })
            .unwrap(),
            base.join("native")
        );
        std::fs::remove_dir_all(home).unwrap();
    }
}
