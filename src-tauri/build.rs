fn main() {
    let app_manifest = tauri_build::AppManifest::new().commands(&[
        "set_window_fullscreen",
        "get_stage_display_info",
        "open_stage_window",
        "close_stage_window",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(app_manifest))
        .expect("failed to run Tauri build script");
}
