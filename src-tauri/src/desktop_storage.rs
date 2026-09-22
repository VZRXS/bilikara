//! Shell-owned files stay beside the portable Windows installation.
use std::path::PathBuf;

pub(crate) fn native_data_override() -> Option<PathBuf> {
    [
        "BILIKARA_NATIVE_DATA_DIR",
        "BILIKARA_DESKTOP_RUST_PREVIEW_DIR",
        "BILIKARA_HOME",
    ]
    .iter()
    .find_map(|key| std::env::var_os(key).filter(|value| !value.is_empty()))
    .map(PathBuf::from)
}

#[cfg(any(windows, test))]
pub(crate) fn configure_windows(
    config: &mut tauri::Config,
    executable: &std::path::Path,
    native_override: Option<PathBuf>,
) -> Result<(), String> {
    let runtime = if let Some(native) = native_override {
        if !native.is_absolute() {
            return Err("Native data directory must be absolute".into());
        }
        // WebView starts before the backend. Never create files inside an
        // uninitialized import destination; isolate its shell files next to it.
        let mut name = native
            .file_name()
            .ok_or("Invalid native data directory")?
            .to_os_string();
        name.push(".desktop");
        native.with_file_name(name)
    } else {
        if !executable.is_absolute() {
            return Err("Desktop executable path must be absolute".into());
        }
        executable
            .parent()
            .ok_or("Desktop installation directory is unavailable")?
            .join("runtime")
    };
    for window in &mut config.app.windows {
        window.data_directory = Some(runtime.join("webview"));
    }
    Ok(())
}

#[cfg(any(windows, test))]
pub(crate) fn webview_directory(config: &tauri::Config) -> Result<PathBuf, String> {
    config
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .and_then(|window| window.data_directory.clone())
        .ok_or_else(|| "Portable WebView directory is unavailable".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_shell_files_follow_the_installation_and_explicit_isolation() {
        let root = std::env::temp_dir().join("Bilikara portable 空");
        let mut config = tauri::Config::default();
        config.app.windows.push(tauri::utils::config::WindowConfig {
            label: "main".into(),
            ..Default::default()
        });
        configure_windows(&mut config, &root.join("bilikara-desktop.exe"), None).unwrap();
        assert_eq!(
            webview_directory(&config).unwrap(),
            root.join("runtime/webview")
        );
        let native = root.join("test-native");
        configure_windows(
            &mut config,
            &root.join("bilikara-desktop.exe"),
            Some(native.clone()),
        )
        .unwrap();
        let webview = webview_directory(&config).unwrap();
        assert_eq!(webview, root.join("test-native.desktop/webview"));
        assert!(!webview.starts_with(native));
        assert!(
            configure_windows(
                &mut config,
                &root.join("bilikara-desktop.exe"),
                Some("relative".into())
            )
            .is_err()
        );
        assert!(
            configure_windows(&mut config, std::path::Path::new("relative.exe"), None).is_err()
        );
        assert!(webview_directory(&tauri::Config::default()).is_err());
    }
}
