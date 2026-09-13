// Desktop and mobile share the application crate, not the desktop child-process
// launcher. Keep desktop-only windowing and backend adapters out of mobile builds.
#[cfg(desktop)]
mod backend_download;
#[cfg(desktop)]
mod backend_process;
#[cfg(desktop)]
mod desktop;
#[cfg(desktop)]
mod desktop_diagnostics;
#[cfg(desktop)]
mod platform;
#[cfg(desktop)]
mod presentation;
#[cfg(desktop)]
mod window_lifecycle;

#[cfg(target_os = "android")]
mod android;

#[cfg(target_os = "ios")]
compile_error!("iOS Host startup is not implemented; use the Android Alpha target");

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(desktop)]
    desktop::run();
    #[cfg(target_os = "android")]
    android::run();
}
