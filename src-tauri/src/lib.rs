// Desktop and mobile share the application crate, not the desktop child-process
// launcher. Keep desktop-only windowing and backend adapters out of mobile builds.
#[cfg(desktop)]
mod backend_download;
#[cfg(desktop)]
mod backend_process;
#[cfg(desktop)]
mod bilibili_login;
#[cfg(desktop)]
mod desktop;
#[cfg(desktop)]
mod desktop_diagnostics;
#[cfg(desktop)]
mod desktop_import;
#[cfg(desktop)]
mod desktop_storage;
#[cfg(desktop)]
mod platform;
#[cfg(desktop)]
mod playback_hints;
#[cfg(desktop)]
mod presentation;
#[cfg(desktop)]
mod presentation_geometry;
#[cfg(desktop)]
mod update_preferences;
#[cfg(desktop)]
mod window_chrome;
#[cfg(desktop)]
mod window_lifecycle;
#[cfg(all(desktop, any(target_os = "windows", test)))]
mod windows_fullscreen;

#[cfg(target_os = "android")]
mod android;

#[cfg(target_os = "ios")]
mod ios;
#[cfg(target_os = "ios")]
mod ios_audio;
#[cfg(any(target_os = "ios", test))]
mod mobile_navigation;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(desktop)]
    desktop::run();
    #[cfg(target_os = "android")]
    android::run();
    #[cfg(target_os = "ios")]
    ios::run();
}
