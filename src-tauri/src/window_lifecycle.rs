use crate::backend_process::{self, BackendProcess};
use crate::desktop_diagnostics::append_desktop_diagnostic;
use crate::presentation;
use tauri::Manager;

#[tauri::command]
pub(crate) fn set_window_fullscreen(
    window: tauri::WebviewWindow,
    backend: tauri::State<'_, BackendProcess>,
    presentation: tauri::State<'_, presentation::PresentationState>,
    fullscreen: bool,
) -> Result<(), String> {
    presentation::authorize_window(&window, &backend, &["main"])?;
    if !presentation.allows_manual_fullscreen() {
        return Err("presentation mode owns native fullscreen state".to_string());
    }
    window
        .set_fullscreen(fullscreen)
        .map_err(|error| error.to_string())
}

pub(crate) fn handle_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if window.label() == "controller"
        && let tauri::WindowEvent::Destroyed = event
    {
        append_desktop_diagnostic("presentation_window_destroyed", "window=controller");
        presentation::handle_controller_destroyed(window.app_handle());
    }
    if window.label() == "main"
        && let tauri::WindowEvent::Destroyed = event
        && let Some(state) = window.try_state::<BackendProcess>()
    {
        append_desktop_diagnostic("presentation_window_destroyed", "window=main cleanup=begin");
        presentation::prepare_app_shutdown(window.app_handle());
        append_desktop_diagnostic("desktop_shutdown", "stage=presentation_shutdown_prepared");
        backend_process::shutdown(&state);
    }
}
