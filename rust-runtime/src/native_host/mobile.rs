//! Shared in-process mobile startup. This is operational I/O, not another
//! application-state owner. Platform shells supply private storage and assets;
//! TLS, native media libraries, windows and system bridges remain in the shell.
use super::{
    AssetSource, NativeHost,
    startup::{Failure, Progress, Stage},
};
use crate::{
    AppStateRequest, AppStateSeed, PlayerSettingsSeed, execute_app_state, initialize_native_host,
};
use std::{
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

static START_ATTEMPTED: AtomicBool = AtomicBool::new(false);

pub(super) fn platform() -> &'static str {
    if cfg!(target_os = "ios") {
        "ios"
    } else {
        // Retain the Android identity of the existing non-desktop test harness.
        "android"
    }
}

/// Called once by application setup, never by page load, wake or an IPC request.
/// A failed startup stays failed until process restart; it must not overwrite a
/// damaged checkpoint or create a second listener around the same AppState.
pub fn start(directory: &Path, assets: AssetSource) -> Result<NativeHost, String> {
    start_diagnosed(directory, assets).map_err(|failure| {
        if failure.code == "mobile_start_already_attempted" {
            failure.code.to_owned()
        } else {
            format!("{}: startup failed at {:?}", failure.code, failure.stage)
        }
    })
}

/// Same single startup attempt, with bounded, credential-free failure facts.
pub fn start_diagnosed(directory: &Path, assets: AssetSource) -> Result<NativeHost, Failure> {
    if START_ATTEMPTED.swap(true, Ordering::AcqRel) {
        return Err(Failure::new(
            Stage::StateInitialize,
            None,
            "mobile_start_already_attempted",
        ));
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| Failure::new(Stage::Clock, None, "host_startup_failed"))?
        .as_secs_f64();
    let response = initialize_native_host(
        directory,
        AppStateSeed {
            last_playback_generation: 0,
            queue_departures: Vec::new(),
            stable_cycle_cursor: None,
            automatic_volume: Default::default(),
            session_user_ids: Default::default(),
            requester_user_ids: Default::default(),
            playback_mode: "local".into(),
            player_settings: PlayerSettingsSeed::default(),
            current_item: None,
            current_item_started: false,
            playlist: Vec::new(),
            history: Vec::new(),
            session_history: Vec::new(),
            session_users: Vec::new(),
            remote_identities: Default::default(),
            gatcha_pool_preferences: Default::default(),
            session_started_at: now,
            session_played_file: "native-session.json".into(),
            session_played: Vec::new(),
            session_archives: Vec::new(),
            previous_session: None,
            backup: None,
            updated_at: now,
        },
    );
    if response.snapshot().is_none() {
        let error = response.error();
        let details = error.and_then(|error| error.details.as_ref());
        let stage = match details.and_then(|v| v["startup_stage"].as_str()) {
            Some("storage_open") => Stage::StorageOpen,
            Some("checkpoint_restore") => Stage::CheckpointRestore,
            _ => Stage::StateInitialize,
        };
        let mut failure = Failure::new(
            stage,
            Some(if stage == Stage::CheckpointRestore {
                Stage::StorageOpen
            } else {
                Stage::Clock
            }),
            error.map_or("host_startup_failed", |e| &e.kind),
        );
        // Details originate in NativeHostStorage, not arbitrary error messages.
        failure.io_kind = details
            .and_then(|v| v["io_kind"].as_str())
            .map(str::to_owned);
        failure.os_error = details
            .and_then(|v| v["os_error"].as_i64())
            .and_then(|n| i32::try_from(n).ok());
        return Err(failure);
    }
    let mut progress = Progress {
        stage: Stage::StateInitialize,
        last_completed: Some(Stage::CheckpointRestore),
    };
    super::start_observed(directory, assets, false, None, &mut progress).map_err(|error| {
        // NativeHost's owned handle drains any workers/listeners before this
        // boundary. Release the storage authority on failure as well, without
        // retrying startup or writing a fresh seed over the saved checkpoint.
        let _ = execute_app_state(AppStateRequest::Shutdown { schema_version: 1 });
        progress.failed(error)
    })
}
