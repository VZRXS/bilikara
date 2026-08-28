#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use std::path::PathBuf;
use tauri::Manager;

mod backend_download;
mod backend_process;
mod desktop_diagnostics;
mod platform;
mod presentation;
mod window_lifecycle;

fn main() {
    let current_exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("."));
    let current_exe = current_exe.canonicalize().unwrap_or(current_exe);
    let current_dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let startup_log = desktop_diagnostics::open_desktop_startup_log(&current_exe);
    if let Some(startup_log) = startup_log.as_ref() {
        startup_log.append(
            "desktop_start",
            format!(
                "desktop_executable={} cwd={} log_path={}",
                current_exe.display(),
                current_dir.display(),
                startup_log.path().display()
            ),
        );
    }
    desktop_diagnostics::install_desktop_panic_hook(startup_log.as_ref());
    desktop_diagnostics::install_runtime_desktop_diagnostics(startup_log.as_ref());

    let startup_log_for_setup = startup_log.clone();
    let run_result = tauri::Builder::default()
        .manage(presentation::PresentationState::default())
        .manage(window_lifecycle::ApplicationLifecycleState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            window_lifecycle::set_window_fullscreen,
            window_lifecycle::restart_application,
            backend_download::save_backend_download,
            presentation::get_presentation_displays,
            presentation::get_presentation_session,
            presentation::activate_local_presentation,
            presentation::mark_presentation_host_ready,
            presentation::mark_presentation_controller_ready,
            presentation::send_presentation_command,
            presentation::acknowledge_presentation_command,
            presentation::publish_presentation_playback_state,
            presentation::deactivate_local_presentation,
        ])
        .setup(move |app| {
            let startup_log = startup_log_for_setup.clone();

            #[cfg(target_os = "macos")]
            platform::create_macos_main_webview_window(app)?;

            let Some(window) = app.get_webview_window("main") else {
                desktop_diagnostics::fail_desktop_startup(
                    app.handle(),
                    startup_log.as_ref(),
                    "main Tauri window is unavailable",
                );
                return Ok(());
            };
            window_lifecycle::initialize_main_window_geometry(app, &window);
            backend_process::launch(app, window, startup_log);
            Ok(())
        })
        .on_window_event(window_lifecycle::handle_window_event)
        .run(tauri::generate_context!());

    match run_result {
        Ok(()) => {
            desktop_diagnostics::append_desktop_diagnostic("desktop_exit", "status=ok");
        }
        Err(error) => {
            desktop_diagnostics::append_desktop_diagnostic(
                "tauri_run",
                format!("status=error message={error}"),
            );
            panic!("error while running tauri application: {error}");
        }
    }
}
