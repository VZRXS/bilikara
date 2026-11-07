//! iOS in-process Host entry. Packaged startup has read-only Tauri IPC.
//! System operations use a separate, frame-scoped WK bridge on the local Host.
use crate::ios_bridge_policy::HostFramePolicy;
use crate::mobile_navigation::{HostNavigation, packaged_startup};
use bilikara_runtime::{
    AppStateRequest, execute_app_state,
    native_host::startup::{Failure, Stage},
    native_host::{Asset, NativeHost, mobile},
};
use serde::Serialize;
use std::sync::Arc;
use tauri::Manager;

struct IosBootstrap {
    host: Option<NativeHost>,
    error: Option<Failure>,
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
) -> Result<IosHostStatus, serde_json::Value> {
    if window.label() != "main" || !window.url().is_ok_and(|url| packaged_startup(&url)) {
        return Err("startup_origin_denied".into());
    }
    if let Some(error) = bootstrap.error.as_ref() {
        return Err(serde_json::to_value(error).expect("fixed startup diagnostic"));
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

fn initialize(app: &tauri::App) -> Result<NativeHost, Failure> {
    crate::ios_audio::configure().map_err(|code| Failure::new(Stage::AudioSession, None, code))?;
    // Tauri maps app_data_dir to Library/Application Support/<bundle identifier>
    // on iOS. Keep durable data out of Documents and temporary directories.
    let directory = app.path().app_data_dir().map_err(|_| {
        Failure::new(
            Stage::StoragePath,
            Some(Stage::AudioSession),
            "native_storage_path",
        )
    })?;
    let resolver = app.asset_resolver();
    let host = mobile::start_diagnosed(
        &directory,
        Arc::new(move |path| {
            resolver.get(path.to_owned()).map(|asset| Asset {
                bytes: asset.bytes,
                mime: asset.mime_type,
            })
        }),
    )
    .map_err(|mut failure| {
        if failure.last_completed.is_none() {
            failure.last_completed = Some(Stage::StoragePath);
        }
        failure
    })?;
    if let Err(error) = host.set_app_version(&app.package_info().version.to_string()) {
        drop(host);
        let _ = execute_app_state(AppStateRequest::Shutdown { schema_version: 1 });
        return Err(Failure::new(
            Stage::AppVersion,
            Some(Stage::WorkerStart),
            &error,
        ));
    }
    if let Ok(cache) = app.path().app_cache_dir() {
        crate::ios_export::clean_stale(&cache.join("playlist-export-documents"));
    }
    // Rendering stays in the shared Rust service. The bundled font is copied
    // to private cache only on first export; an I/O failure remains retryable.
    let export_assets = app.asset_resolver();
    let cache = app.path().app_cache_dir().map_err(|e| e.to_string());
    let version = app.package_info().version.to_string();
    let ready = std::sync::OnceLock::new();
    host.set_export_renderer(Arc::new(move |spec, output| {
        let cache = cache
            .as_ref()
            .map_err(Clone::clone)?
            .join("playlist-export-font");
        let path = cache.join("SourceHanSans-VF.ttf");
        if ready.get().is_none()
            && serde_json::from_str::<serde_json::Value>(spec).is_ok_and(|s| s["format"] != "csv")
        {
            std::fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
            let font = export_assets
                .get("fonts/SourceHanSans-VF.ttf".to_owned())
                .ok_or("Bundled export font unavailable")?;
            std::fs::write(&path, font.bytes).map_err(|e| e.to_string())?;
            let _ = ready.set(());
        }
        bilikara_runtime::native_host::render_rust_export(spec, output, &path, &version)
    }))
    .map_err(|e| Failure::new(Stage::WorkerStart, None, &e))?;
    Ok(host)
}

fn create_main_if_ready(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    if !crate::ios_presentation::main_scene_available() {
        return Ok(());
    }
    let bootstrap = app.state::<IosBootstrap>();
    let navigation = HostNavigation::new(bootstrap.host.as_ref().map(NativeHost::bootstrap_url))
        .map_err(std::io::Error::other)?;
    let platform_policy = bootstrap
        .host
        .as_ref()
        .and_then(|host| HostFramePolicy::new(host.bootstrap_url()).ok());
    let window = if let Some(window) = app.get_webview_window("main") {
        window
    } else {
        let config = app
            .config()
            .app
            .windows
            .iter()
            .find(|w| w.label == "main")
            .ok_or("iOS main window configuration is missing")?;
        let mut builder = tauri::WebviewWindowBuilder::from_config(app, config)?.visible(false);
        if let Some(policy) = &platform_policy {
            // Tauri installs this user script in the main frame only.
            builder = builder
                .initialization_script(crate::ios_platform::initialization_script(policy))
                .initialization_script(crate::ios_presentation::initialization_script(policy, 0));
        }
        builder
            .on_navigation(move |url| navigation.allows(url))
            .build()?
    };
    if let Some(policy) = platform_policy {
        let exporter = bootstrap.host.as_ref().map(NativeHost::playlist_exporter);
        let json_client = bootstrap.host.as_ref().map(NativeHost::json_client);
        let export_cache = app
            .path()
            .app_cache_dir()
            .ok()
            .map(|p| p.join("playlist-export-documents"));

        window.with_webview(move |platform| {
            // SAFETY: Tauri owns this live WKWebView. The callback runs
            // on the main thread; the bridge stores only a weak view.
            if let Some(mtm) = objc2_foundation::MainThreadMarker::new()
                && let Some(view) = unsafe {
                    platform
                        .inner()
                        .cast::<crate::ios_platform::HostWebView>()
                        .as_ref()
                }
            {
                if !crate::ios_presentation::bound(view)
                    && crate::ios_presentation::attach_main(view, mtm)
                {
                    crate::ios_presentation::install(view, policy.clone(), mtm);
                    crate::ios_platform::install(
                        view,
                        policy,
                        exporter,
                        export_cache,
                        json_client,
                        mtm,
                    );
                }
            }
        })?;
    } else {
        window.with_webview(|platform| {
            if let Some(mtm) = objc2_foundation::MainThreadMarker::new()
                && let Some(view) = unsafe {
                    platform
                        .inner()
                        .cast::<crate::ios_platform::HostWebView>()
                        .as_ref()
                }
            {
                crate::ios_presentation::attach_main(view, mtm);
            }
        })?;
    }
    Ok(())
}

pub(crate) fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![ios_host_status])
        .setup(|app| {
            // Keep the diagnostic page even if storage or listener setup fails.
            // Wake, navigation and repeated status reads never start another Host.
            let (mut host, mut error) = match initialize(app) {
                Ok(host) => (Some(host), None),
                Err(error) => (None, Some(error)),
            };
            let _navigation =
                match HostNavigation::new(host.as_ref().map(NativeHost::bootstrap_url)) {
                    Ok(navigation) => navigation,
                    Err(code) => {
                        drop(host.take());
                        error = Some(Failure::new(Stage::Ready, Some(Stage::AppVersion), code));
                        HostNavigation::new(None).expect("empty startup navigation policy")
                    }
                };
            app.manage(IosBootstrap { host, error });
            create_main_if_ready(app.handle())?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("iOS application shell failed")
        .run(|app, event| {
            if matches!(
                event,
                tauri::RunEvent::Ready | tauri::RunEvent::SceneRequested { .. }
            ) {
                if create_main_if_ready(app).is_err() {
                    eprintln!("ios_main_scene_unavailable");
                }
                crate::ios_presentation::scene_changed();
            }
        });
}
