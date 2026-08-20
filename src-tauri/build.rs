fn main() {
    let app_manifest = tauri_build::AppManifest::new().commands(&[
        "set_window_fullscreen",
        "get_presentation_displays",
        "get_presentation_session",
        "activate_local_presentation",
        "mark_presentation_host_ready",
        "mark_presentation_controller_ready",
        "send_presentation_command",
        "acknowledge_presentation_command",
        "publish_presentation_playback_state",
        "deactivate_local_presentation",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(app_manifest))
        .expect("failed to run Tauri build script");
}
