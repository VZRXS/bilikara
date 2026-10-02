fn main() {
    let windows_msvc = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    if windows_msvc {
        // tauri-build embeds Common Controls v6 in application binaries only.
        // Native HWND/WebView tests need the same activation context in the lib
        // test executable; otherwise Windows fails before running any tests.
        let manifest = std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap())
            .join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        // NDK r27 and older do not default to 16 KB ELF alignment. Keep both
        // linker page sizes explicit; this has no effect on desktop builds.
        println!("cargo:rustc-link-arg=-Wl,-z,max-page-size=16384");
        println!("cargo:rustc-link-arg=-Wl,-z,common-page-size=16384");
    }
    let app_manifest = tauri_build::AppManifest::new().commands(&[
        "android_alpha_status",
        "set_window_fullscreen",
        "set_window_maximize_region",
        "set_window_chrome_theme",
        "restart_application",
        "apply_desktop_update",
        "get_host_layout",
        "set_host_layout",
        "start_desktop_update",
        "cancel_desktop_update",
        "open_external_web_url",
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
        "publish_presentation_output_state",
        "request_presentation_output_state",
        "record_presentation_video_geometry",
        "deactivate_local_presentation",
    ]);
    let mut attributes = tauri_build::Attributes::new().app_manifest(app_manifest);
    if windows_msvc {
        // The linker embeds the same manifest for binaries and lib unit tests.
        // Keep Tauri's icon/version resources, without embedding a second copy.
        attributes = attributes
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
    }
    tauri_build::try_build(attributes).expect("failed to run Tauri build script");
}
