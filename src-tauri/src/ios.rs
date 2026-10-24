//! iOS in-process Host entry. UIKit/system commands are separate work; the only
//! IPC permission here reads startup facts from the packaged main document.
use crate::mobile_navigation::{HostNavigation, packaged_startup};
use bilikara_runtime::{
    AppStateRequest, execute_app_state,
    native_host::{Asset, NativeHost, mobile},
};
use serde::Serialize;
use std::sync::Arc;
use tauri::Manager;

struct IosBootstrap {
    host: Option<NativeHost>,
    error: Option<&'static str>,
}

#[derive(Serialize)]
struct IosHostStatus {
    schema_version: u32,
    platform: &'static str,
    backend: &'static str,
    revision: u64,
    host_api_ready: bool,
    persistence_ready: bool,
    playback: &'static str,
    bootstrap_url: String,
}

#[tauri::command]
async fn ios_host_status(
    window: tauri::WebviewWindow,
    bootstrap: tauri::State<'_, IosBootstrap>,
) -> Result<IosHostStatus, String> {
    if window.label() != "main" || !window.url().is_ok_and(|url| packaged_startup(&url)) {
        return Err("startup_origin_denied".into());
    }
    if let Some(error) = bootstrap.error {
        return Err(error.into());
    }
    let host = bootstrap.host.as_ref().ok_or("host_unavailable")?;
    let response = execute_app_state(AppStateRequest::Snapshot { schema_version: 1 });
    let snapshot = response.snapshot().ok_or("app_state_unavailable")?;
    Ok(IosHostStatus {
        schema_version: 1,
        platform: "ios",
        backend: "rust",
        revision: snapshot.revision,
        host_api_ready: true,
        persistence_ready: true,
        // Listener/checkpoint readiness is not evidence of audio or DSP output.
        playback: "unverified",
        bootstrap_url: host.bootstrap_url().to_owned(),
    })
}

fn initialize(app: &tauri::App) -> Result<NativeHost, String> {
    crate::ios_audio::configure().map_err(str::to_owned)?;
    // Tauri maps app_data_dir to Library/Application Support/<bundle identifier>
    // on iOS. Keep durable data out of Documents and temporary directories.
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|_| "native_storage_path")?;
    let resolver = app.asset_resolver();
    let host = mobile::start(
        &directory,
        Arc::new(move |path| {
            resolver.get(path.to_owned()).map(|asset| Asset {
                bytes: asset.bytes,
                mime: asset.mime_type,
            })
        }),
    )?;
    host.set_app_version(&app.package_info().version.to_string())?;
    Ok(host)
}

fn startup_error(error: &str) -> &'static str {
    // Fixed codes only: storage errors may carry private paths. Do not render
    // raw errors, bootstrap credentials or checkpoint contents in the WebView.
    match error.split(':').next().unwrap_or("") {
        "native_storage_invalid" => "native_storage_invalid",
        "native_storage_version" => "native_storage_version",
        "native_storage_in_use" => "native_storage_in_use",
        "native_storage_full" => "native_storage_full",
        "native_storage_path" => "native_storage_path",
        "native_storage_write" | "native_storage_io" => "native_storage_io",
        "mobile_start_already_attempted" => "mobile_start_already_attempted",
        "audio_session_unavailable" => "audio_session_unavailable",
        "audio_session_configuration_failed" => "audio_session_configuration_failed",
        _ => "host_startup_failed",
    }
}

pub(crate) fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![ios_host_status])
        .setup(|app| {
            // Keep the diagnostic page even if storage or listener setup fails.
            // Wake, navigation and repeated status reads never start another Host.
            let (mut host, mut error) = match initialize(app) {
                Ok(host) => (Some(host), None),
                Err(error) => (None, Some(startup_error(&error))),
            };
            let navigation = match HostNavigation::new(host.as_ref().map(NativeHost::bootstrap_url))
            {
                Ok(navigation) => navigation,
                Err(code) => {
                    drop(host.take());
                    error = Some(code);
                    HostNavigation::new(None).expect("empty startup navigation policy")
                }
            };
            app.manage(IosBootstrap { host, error });
            let config = app
                .config()
                .app
                .windows
                .iter()
                .find(|w| w.label == "main")
                .ok_or("iOS main window configuration is missing")?;
            tauri::WebviewWindowBuilder::from_config(app, config)?
                .on_navigation(move |url| navigation.allows(url))
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("iOS application shell failed");
}
