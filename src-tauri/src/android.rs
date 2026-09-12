//! Android's in-process Rust Host. The shell resolves private storage and serves
//! the existing bundled Host/Remote assets; it owns no playlist business rules.
use bilikara_runtime::native_host::{Asset, NativeHost};
use bilikara_runtime::{
    AppStateRequest, AppStateSeed, PlayerSettingsSeed, execute_app_state, initialize_native_host,
};
use serde::Serialize;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

// Operational startup result, not a second application-state authority.
struct AndroidBootstrap {
    error: Option<String>,
    host: Option<NativeHost>,
}

#[derive(Serialize)]
struct AndroidAlphaStatus {
    schema_version: u32,
    stage: &'static str,
    backend: &'static str,
    revision: u64,
    host_api_ready: bool,
    persistence_ready: bool,
    playback_ready: bool,
    window_controls_ready: bool,
    bootstrap_url: String,
}

#[tauri::command]
async fn android_alpha_status(
    bootstrap: tauri::State<'_, AndroidBootstrap>,
    window: tauri::WebviewWindow,
) -> Result<AndroidAlphaStatus, String> {
    if let Some(error) = &bootstrap.error {
        return Err(error.clone());
    }
    let response = execute_app_state(AppStateRequest::Snapshot { schema_version: 1 });
    let snapshot = response.snapshot().ok_or_else(|| {
        response.error().map_or_else(
            || "Native AppState returned no snapshot".to_owned(),
            |error| format!("{}: {}", error.kind, error.message),
        )
    })?;
    let host = bootstrap
        .host
        .as_ref()
        .ok_or_else(|| "Native Host listener is unavailable".to_owned())?;
    let bootstrap_url = host.bootstrap_url().to_owned();
    let origin = tauri::Url::parse(&bootstrap_url)
        .map_err(|_| "Native Host origin is invalid".to_owned())?
        .origin()
        .ascii_serialization();
    // Install the origin-scoped window bridge before the bootstrap navigates.
    // The local-only IPC capability remains unchanged: no Remote gets IPC.
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    window
        .with_webview(move |webview| {
            webview.jni_handle().exec(move |env, activity, view| {
                let result = (|| {
                    let origin = env.new_string(origin)?;
                    env.call_method(
                        activity,
                        "installHostWindowControls",
                        "(Landroid/webkit/WebView;Ljava/lang/String;)Z",
                        &[
                            jni::objects::JValue::Object(view),
                            jni::objects::JValue::Object(&origin),
                        ],
                    )?
                    .z()
                })();
                if result.is_err() {
                    let _ = env.exception_clear();
                }
                let _ = sender.send(result.unwrap_or(false));
            });
        })
        .map_err(|_| "Cannot initialize Android window controls".to_owned())?;
    let window_controls_ready = tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap_or(false)
    })
    .await
    .map_err(|_| "Cannot initialize Android window controls".to_owned())?;
    Ok(AndroidAlphaStatus {
        schema_version: 3,
        stage: "native-host-alpha",
        backend: "rust",
        revision: snapshot.revision,
        host_api_ready: true,
        persistence_ready: true,
        playback_ready: true,
        window_controls_ready,
        bootstrap_url,
    })
}

fn initialize(app: &tauri::App) -> Result<NativeHost, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|_| "Android app-private storage directory is unavailable".to_owned())?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "System time is before the Unix epoch".to_owned())?
        .as_secs_f64();
    let response = initialize_native_host(
        &directory,
        AppStateSeed {
            playback_mode: "local".to_owned(),
            player_settings: PlayerSettingsSeed::default(),
            current_item: None,
            current_item_started: false,
            playlist: Vec::new(),
            history: Vec::new(),
            session_history: Vec::new(),
            session_users: Vec::new(),
            session_started_at: now,
            session_played_file: "native-session.json".to_owned(),
            session_played: Vec::new(),
            previous_session: None,
            backup: None,
            updated_at: now,
        },
    );
    response.snapshot().ok_or_else(|| {
        response.error().map_or_else(
            || "Native Host returned no snapshot".to_owned(),
            |error| format!("{}: {}", error.kind, error.message),
        )
    })?;
    let resolver = app.asset_resolver();
    NativeHost::start(
        &directory,
        Arc::new(move |path| {
            resolver.get(path.to_owned()).map(|asset| Asset {
                bytes: asset.bytes,
                mime: asset.mime_type,
            })
        }),
    )
}

pub(crate) fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![android_alpha_status])
        .setup(|app| {
            // Keep the local diagnostic page usable on a read/write failure.
            // Do not retry with empty defaults or delete the user's checkpoint.
            let (host, error) = match initialize(app) {
                Ok(host) => (Some(host), None),
                Err(error) => (None, Some(error)),
            };
            app.manage(AndroidBootstrap { host, error });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Android Alpha application failed");
}
