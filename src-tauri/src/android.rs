//! Android's in-process Rust Host. The shell resolves private storage and serves
//! the existing bundled Host/Remote assets; it owns no playlist business rules.
use bilikara_runtime::native_host::{Asset, NativeHost, RemoteExportRenderer};
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
                let result: Result<(bool, RemoteExportRenderer), jni::errors::Error> = (|| {
                    let vm = env.get_java_vm()?;
                    // Retain the class, not Activity/WebView, for HTTP workers.
                    let class = env.get_object_class(activity)?;
                    let class = env.new_global_ref(class)?;
                    let origin = env.new_string(origin)?;
                    let ready = env
                        .call_method(
                            activity,
                            "installHostWindowControls",
                            "(Landroid/webkit/WebView;Ljava/lang/String;)Z",
                            &[
                                jni::objects::JValue::Object(view),
                                jni::objects::JValue::Object(&origin),
                            ],
                        )?
                        .z()?;
                    let renderer: RemoteExportRenderer = Arc::new(move |spec, path| {
                        let mut env = vm
                            .attach_current_thread()
                            .map_err(|_| "export_attach".to_owned())?;
                        let result = env.with_local_frame(8, |env| -> jni::errors::Result<i32> {
                            let spec = env.new_string(spec)?;
                            let path = env.new_string(path.to_string_lossy())?;
                            let class: &jni::objects::JClass<'_> = class.as_obj().into();
                            env.call_static_method(
                                class,
                                "renderRemoteExport",
                                "(Ljava/lang/String;Ljava/lang/String;)I",
                                &[
                                    jni::objects::JValue::Object(&spec),
                                    jni::objects::JValue::Object(&path),
                                ],
                            )?
                            .i()
                        });
                        if result.is_err() {
                            let _ = env.exception_clear();
                        }
                        match result {
                            Ok(0) => Ok(()),
                            _ => Err("export_render".into()),
                        }
                    });
                    Ok((ready, renderer))
                })(
                );
                if result.is_err() {
                    let _ = env.exception_clear();
                }
                let _ = sender.send(result.ok());
            });
        })
        .map_err(|_| "Cannot initialize Android window controls".to_owned())?;
    let bridge = tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv_timeout(std::time::Duration::from_secs(5))
            .ok()
            .flatten()
    })
    .await
    .map_err(|_| "Cannot initialize Android window controls".to_owned())?;
    let window_controls_ready = if let Some((ready, renderer)) = bridge {
        host.set_export_renderer(renderer)?;
        ready
    } else {
        false
    };
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
            session_archives: Vec::new(),
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
