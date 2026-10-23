//! Shared in-process mobile startup. This is operational I/O, not another
//! application-state owner. Platform shells supply private storage and assets;
//! TLS, native media libraries, windows and system bridges remain in the shell.
use super::{AssetSource, NativeHost};
use crate::{AppStateSeed, PlayerSettingsSeed, initialize_native_host};
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
    if START_ATTEMPTED.swap(true, Ordering::AcqRel) {
        return Err("mobile_start_already_attempted".into());
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "System time is before the Unix epoch".to_owned())?
        .as_secs_f64();
    let response = initialize_native_host(
        directory,
        AppStateSeed {
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
    response.snapshot().ok_or_else(|| {
        response.error().map_or_else(
            || "Native Host returned no snapshot".to_owned(),
            |error| format!("{}: {}", error.kind, error.message),
        )
    })?;
    NativeHost::start(directory, assets)
}
