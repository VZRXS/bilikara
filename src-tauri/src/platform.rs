use std::path::Path;

#[cfg(target_os = "macos")]
use objc2::{MainThreadMarker, rc::Retained};
#[cfg(target_os = "macos")]
use objc2_web_kit::{WKAudiovisualMediaTypes, WKWebViewConfiguration};
#[cfg(target_os = "macos")]
use tauri::Manager;

pub(crate) fn is_macos_app_bundle_executable(path: &Path) -> bool {
    let Some(mac_os_dir) = path.parent() else {
        return false;
    };
    let Some(contents_dir) = mac_os_dir.parent() else {
        return false;
    };
    let Some(app_dir) = contents_dir.parent() else {
        return false;
    };
    mac_os_dir.file_name().is_some_and(|name| name == "MacOS")
        && contents_dir
            .file_name()
            .is_some_and(|name| name == "Contents")
        && app_dir
            .extension()
            .is_some_and(|extension| extension == "app")
}

#[cfg(target_os = "macos")]
fn macos_autoplay_webview_configuration() -> Retained<WKWebViewConfiguration> {
    let main_thread = MainThreadMarker::new()
        .expect("the macOS Tauri setup hook must execute on the main thread");
    // SAFETY: The configuration is created on the main thread, and the public
    // WebKit setter accepts the pinned crate's no-media option-set value.
    let configuration = unsafe { WKWebViewConfiguration::new(main_thread) };
    unsafe {
        configuration.setMediaTypesRequiringUserActionForPlayback(WKAudiovisualMediaTypes::None);
    }
    configuration
}

#[cfg(target_os = "macos")]
pub(crate) fn create_macos_main_webview_window(app: &tauri::App) -> tauri::Result<()> {
    if app.get_webview_window("main").is_some() {
        return Err(tauri::Error::WebviewLabelAlreadyExists("main".into()));
    }
    let window_config = app
        .config()
        .app
        .windows
        .iter()
        .find(|config| config.label == "main")
        .ok_or(tauri::Error::WindowNotFound)?
        .clone();

    tauri::WebviewWindowBuilder::from_config(app.handle(), &window_config)?
        .with_webview_configuration(macos_autoplay_webview_configuration())
        .build()?;
    Ok(())
}
