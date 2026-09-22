use std::path::Path;

/// Keep GTK's native caption actions and window-manager gestures, with a plain
/// header surface that joins the Host toolbar rather than repeating its brand.
#[cfg(target_os = "linux")]
pub(crate) fn configure_linux_main_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    use gtk::prelude::*;
    let gtk_window = window.gtk_window().map_err(|error| error.to_string())?;
    if gtk_window.is_realized() {
        return Err("window was already realized; retaining its system decorations".into());
    }
    let header = gtk::HeaderBar::new();
    header.set_widget_name("bilikara-native-titlebar");
    header.set_show_close_button(true);
    header.set_has_subtitle(false);
    header.set_title(None);
    header.set_decoration_layout(Some(":minimize,maximize,close"));
    gtk_window.set_titlebar(Some(&header));
    header.show();
    Ok(())
}

#[cfg(target_os = "macos")]
use objc2::{MainThreadMarker, rc::Retained};
#[cfg(target_os = "macos")]
use objc2_web_kit::{WKAudiovisualMediaTypes, WKWebViewConfiguration};
#[cfg(target_os = "macos")]
use tauri::Manager;

/// Ask Windows to clip the transparent, undecorated host window with the
/// platform's own rounded-corner treatment. The web surface stays square so
/// its radius cannot diverge from the non-client frame while resizing.
#[cfg(target_os = "windows")]
pub(crate) fn configure_windows_main_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    sync_windows_main_window_frame(&window.as_ref().window())
}

#[cfg(target_os = "windows")]
pub(crate) fn sync_windows_main_window_frame(window: &tauri::Window) -> Result<(), String> {
    use std::ffi::c_void;
    use windows_sys::Win32::Graphics::Dwm::{
        DWMWA_BORDER_COLOR, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DONOTROUND, DWMWCP_ROUND,
        DwmSetWindowAttribute,
    };

    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    let fullscreen = window.is_fullscreen().map_err(|error| error.to_string())?;
    let square = fullscreen || window.is_maximized().map_err(|error| error.to_string())?;
    window
        .set_shadow(!fullscreen)
        .map_err(|error| error.to_string())?;
    let preference: i32 = if square {
        DWMWCP_DONOTROUND
    } else {
        DWMWCP_ROUND
    };
    // DWMWA_COLOR_NONE/DEFAULT. Unsupported DWM attributes on Windows 10
    // leave that OS's normal frame behavior intact.
    let border: u32 = if fullscreen { 0xfffffffe } else { 0xffffffff };
    unsafe {
        DwmSetWindowAttribute(
            hwnd.0,
            DWMWA_BORDER_COLOR as u32,
            (&border as *const u32).cast::<c_void>(),
            std::mem::size_of_val(&border) as u32,
        );
    }
    let result = unsafe {
        DwmSetWindowAttribute(
            hwnd.0,
            DWMWA_WINDOW_CORNER_PREFERENCE as u32,
            (&preference as *const i32).cast::<c_void>(),
            std::mem::size_of_val(&preference) as u32,
        )
    };
    if result < 0 {
        return Err(format!(
            "DWM rounded-corner preference failed with HRESULT 0x{:08X}",
            result as u32
        ));
    }
    Ok(())
}

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

fn external_web_url(value: &str) -> Result<tauri::Url, String> {
    let url = tauri::Url::parse(value).map_err(|_| "invalid web URL")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || value.chars().any(char::is_control)
        || value.len() > 4096
    {
        return Err("only web URLs are allowed".into());
    }
    Ok(url)
}

#[tauri::command]
pub(crate) fn open_external_web_url(
    window: tauri::WebviewWindow,
    backend: tauri::State<'_, crate::backend_process::BackendProcess>,
    url: String,
) -> Result<(), String> {
    crate::presentation::authorize_window(&window, &backend, &["main"])?;
    let url = external_web_url(&url)?;
    // System handlers receive one validated URL argument, never a shell command.
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        let value: Vec<u16> = std::ffi::OsStr::new(url.as_str())
            .encode_wide()
            .chain(Some(0))
            .collect();
        let result = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                std::ptr::null(),
                value.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                1,
            )
        };
        if result as isize <= 32 {
            return Err("system browser could not open the URL".into());
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let program = if cfg!(target_os = "macos") {
            "/usr/bin/open"
        } else {
            "/usr/bin/xdg-open"
        };
        let mut child = std::process::Command::new(program)
            .arg(url.as_str())
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|_| "system browser is unavailable")?;
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    }
    Ok(())
}

#[cfg(test)]
mod web_url_tests {
    #[test]
    fn only_web_links_with_no_embedded_credentials() {
        for url in [
            "file:///tmp/a",
            "javascript:alert(1)",
            "https://user:secret@example.com",
            "https://example.com/\n",
        ] {
            assert!(super::external_web_url(url).is_err());
        }
        assert!(
            super::external_web_url("https://github.com/VZRXS/bilikara/releases/tag/v0.8.0")
                .is_ok()
        );
    }
}
