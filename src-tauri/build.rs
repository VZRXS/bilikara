fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        // NDK r27 and older do not default to 16 KB ELF alignment. Keep both
        // linker page sizes explicit; this has no effect on desktop builds.
        println!("cargo:rustc-link-arg=-Wl,-z,max-page-size=16384");
        println!("cargo:rustc-link-arg=-Wl,-z,common-page-size=16384");
    }
    let app_manifest = tauri_build::AppManifest::new().commands(&[
        "android_alpha_status",
        "set_window_fullscreen",
        "restart_application",
        "get_presentation_displays",
        "get_presentation_session",
        "show_presentation_display_identifiers",
        "dismiss_presentation_display_identifiers",
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
