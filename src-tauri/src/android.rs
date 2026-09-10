//! Android's first vertical slice: an in-process Rust AppState and a read-only
//! startup probe. This is deliberately not yet a functional Host: no persistent
//! queue mutations, network listener, Python process, or CLI fallback is exposed.
use bilikara_runtime::{
    AppStateRequest, AppStateSeed, PlayerSettingsSeed, execute_app_state, initialize_app_state_once,
};
use serde::Serialize;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

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
fn android_alpha_status() -> Result<AndroidAlphaStatus, String> {
    let response = execute_app_state(AppStateRequest::Snapshot { schema_version: 1 });
    let snapshot = response.snapshot().ok_or_else(|| {
        response.error().map_or_else(
            || "Native AppState returned no snapshot".to_owned(),
            |error| format!("{}: {}", error.kind, error.message),
        )
    })?;
    Ok(AndroidAlphaStatus {
        schema_version: 1,
        stage: "native-bootstrap",
        backend: "rust",
        revision: snapshot.revision,
        host_api_ready: false,
        persistence_ready: false,
        playback_ready: false,
    })
}

pub(crate) fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![android_alpha_status])
        .setup(|app| {
            // Resolve storage through the platform, never through a desktop cwd.
            // This slice does not load or overwrite any saved user state.
            std::fs::create_dir_all(app.path().app_data_dir()?)?;
            let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs_f64();
            let response = initialize_app_state_once(AppStateSeed {
                playback_mode: "local".to_owned(),
                player_settings: PlayerSettingsSeed::default(),
                current_item: None,
                current_item_started: false,
                playlist: Vec::new(),
                history: Vec::new(),
                session_history: Vec::new(),
                session_users: Vec::new(),
                session_started_at: now,
                session_played_file: "native-bootstrap.json".to_owned(),
                session_played: Vec::new(),
                previous_session: None,
                backup: None,
                updated_at: now,
            });
            if response.snapshot().is_none() {
                return Err(std::io::Error::other(format!(
                    "Android Rust AppState bootstrap failed: {:?}",
                    response.error()
                ))
                .into());
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Android Alpha application failed");
}
