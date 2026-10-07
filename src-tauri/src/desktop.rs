#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
use crate::platform;
use crate::{
    backend_download, backend_process, desktop_diagnostics, presentation, window_lifecycle,
};
use std::path::PathBuf;
use tauri::Manager;

// Embed the shared assets/configuration once for both ordinary and tool modes.
fn context() -> tauri::Context<tauri::Wry> {
    tauri::generate_context!()
}

pub(crate) fn run() {
    if std::env::args().skip(1).any(|arg| arg == "--import-legacy") {
        crate::desktop_import::run(context());
        return;
    }
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

    let context = context();
    #[cfg(windows)]
    let context = {
        let mut context = context;
        if let Err(reason) = crate::desktop_storage::configure_windows(
            context.config_mut(),
            &current_exe,
            crate::desktop_storage::native_data_override(),
        ) {
            desktop_diagnostics::fail_before_app(startup_log.as_ref(), &reason);
            panic!("invalid desktop storage configuration: {reason}");
        }
        context
    };
    let startup_log_for_setup = startup_log.clone();
    let run_result = tauri::Builder::default()
        .manage(presentation::PresentationState::default())
        .manage(window_lifecycle::ApplicationLifecycleState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            crate::window_chrome::set_window_maximize_region,
            crate::window_chrome::set_window_chrome_theme,
            window_lifecycle::set_window_fullscreen,
            window_lifecycle::restart_application,
            window_lifecycle::apply_desktop_update,
            window_lifecycle::get_host_layout,
            window_lifecycle::set_host_layout,
            backend_process::start_desktop_update,
            backend_process::cancel_desktop_update,
            platform::open_external_web_url,
            backend_download::save_backend_download,
            presentation::get_presentation_displays,
            presentation::get_presentation_session,
            presentation::show_presentation_display_identifiers,
            presentation::dismiss_presentation_display_identifiers,
            presentation::activate_local_presentation,
            presentation::mark_presentation_host_ready,
            presentation::mark_presentation_controller_ready,
            presentation::send_presentation_command,
            presentation::acknowledge_presentation_command,
            presentation::publish_presentation_playback_state,
            presentation::publish_presentation_output_state,
            presentation::request_presentation_output_state,
            presentation::record_presentation_video_geometry,
            presentation::deactivate_local_presentation,
        ])
        .setup(move |app| {
            let startup_log = startup_log_for_setup.clone();

            #[cfg(target_os = "macos")]
            {
                platform::create_macos_main_webview_window(app)?;
                // Tauri's predefined Quit invokes Cocoa terminate: directly.
                // Keep its standard menus, replacing the app menu's final Quit
                // with an ordinary item routed through CloseRequested.
                let menu = tauri::menu::Menu::default(app.handle())?;
                if let Some(tauri::menu::MenuItemKind::Submenu(application)) = menu.items()?.first()
                {
                    let count = application.items()?.len();
                    application.remove_at(count.saturating_sub(1))?;
                    application.append(&tauri::menu::MenuItem::with_id(
                        app,
                        "bilikara-quit",
                        "Quit bilikara",
                        true,
                        Some("CmdOrCtrl+Q"),
                    )?)?;
                }
                app.set_menu(menu)?;
            }

            // Tauri ignores a configured window's data directory, so build the
            // Windows main window here with the same portable store as the
            // audience and identifier windows.
            #[cfg(target_os = "windows")]
            crate::desktop_storage::create_windows_main_webview_window(app)?;

            let Some(window) = app.get_webview_window("main") else {
                desktop_diagnostics::fail_desktop_startup(
                    app.handle(),
                    startup_log.as_ref(),
                    "main Tauri window is unavailable",
                );
                return Ok(());
            };
            // Windows imports the old portable window preferences in the data
            // gate; restore them before Host launch, while main is still hidden.
            #[cfg(not(windows))]
            window_lifecycle::initialize_main_window_geometry(app, &window);
            #[cfg(target_os = "linux")]
            if let Err(error) = platform::configure_linux_main_window(&window) {
                eprintln!("Native Linux header bar unavailable: {error}");
            }
            #[cfg(target_os = "windows")]
            if let Err(error) = platform::configure_windows_main_window(&window) {
                if let Some(startup_log) = startup_log.as_ref() {
                    startup_log.append("windows_native_chrome", error.clone());
                }
                eprintln!("Windows native rounded corners unavailable: {error}");
            }
            #[cfg(windows)]
            if let Err(error) = window_lifecycle::install_display_change_handler(&window) {
                eprintln!("Windows display-change recovery unavailable: {error}");
            }
            crate::desktop_import::gate_startup(app, window, startup_log);
            Ok(())
        })
        .on_window_event(window_lifecycle::handle_window_event)
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "bilikara-quit"
                && let Some(window) = app.get_webview_window("main")
            {
                let _ = window.close();
            }
        })
        .build(context)
        .map(|app| app.run(window_lifecycle::handle_run_event));

    match run_result {
        Ok(()) => {
            desktop_diagnostics::append_desktop_diagnostic("desktop_exit", "status=ok");
        }
        Err(error) => {
            desktop_diagnostics::append_desktop_diagnostic(
                "tauri_run",
                format!("status=error message={error}"),
            );
            #[cfg(windows)]
            desktop_diagnostics::fail_before_app(startup_log.as_ref(), &error.to_string());
            panic!("error while running tauri application: {error}");
        }
    }
}
