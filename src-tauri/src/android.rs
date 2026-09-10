//! Android's in-process Rust Host bootstrap and read-only startup probe. Storage
//! is owned by AppState; the shell only resolves platform paths and reports errors.
//! No network listener, Python process, or CLI fallback is exposed.
use bilikara_runtime::{
    AppStateRequest, AppStateSeed, PlayerSettingsSeed, execute_app_state, initialize_native_host,
};
use serde::Serialize;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

// Operational startup result, not a second application-state authority.
struct AndroidBootstrap {
    error: Option<String>,
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
}

#[tauri::command]
fn android_alpha_status(
    bootstrap: tauri::State<'_, AndroidBootstrap>,
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
    Ok(AndroidAlphaStatus {
        schema_version: 2,
        stage: "native-persistence",
        backend: "rust",
        revision: snapshot.revision,
        host_api_ready: false,
        persistence_ready: true,
        playback_ready: false,
    })
}

fn initialize(app: &tauri::App) -> Result<(), String> {
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
    response.snapshot().map(|_| ()).ok_or_else(|| {
        response.error().map_or_else(
            || "Native Host returned no snapshot".to_owned(),
            |error| format!("{}: {}", error.kind, error.message),
        )
    })
}

pub(crate) fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![android_alpha_status])
        .setup(|app| {
            // Keep the local diagnostic page usable on a read/write failure.
            // Do not retry with empty defaults or delete the user's checkpoint.
            let error = initialize(app).err();
            app.manage(AndroidBootstrap { error });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Android Alpha application failed");
}
