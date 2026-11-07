//! Startup facts only: no paths, saved records, credentials or parallel state.
use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    AudioSession,
    StoragePath,
    Clock,
    StorageOpen,
    CheckpointRestore,
    StateInitialize,
    CacheRecovery,
    ListenerBind,
    AccessSetup,
    LoginLoad,
    PreferencesLoad,
    LibraryLoad,
    ExportCleanup,
    WorkerStart,
    AppVersion,
    Ready,
}

#[derive(Debug, Serialize)]
pub struct Failure {
    pub schema_version: u32,
    pub stage: Stage,
    pub last_completed: Option<Stage>,
    pub code: &'static str,
    pub io_kind: Option<String>,
    pub os_error: Option<i32>,
}

impl Failure {
    pub fn new(stage: Stage, last_completed: Option<Stage>, code: &str) -> Self {
        // Native error payloads are never copied into an IPC error.
        let code = match code {
            "native_storage_invalid" => "native_storage_invalid",
            "native_storage_version" => "native_storage_version",
            "native_storage_in_use" => "native_storage_in_use",
            "native_storage_full" => "native_storage_full",
            "native_storage_path" => "native_storage_path",
            "native_storage_write" | "native_storage_io" => "native_storage_io",
            "desktop_import_pending" => "desktop_import_pending",
            "mobile_start_already_attempted" => "mobile_start_already_attempted",
            "audio_session_unavailable" => "audio_session_unavailable",
            "audio_session_configuration_failed" => "audio_session_configuration_failed",
            "cache_storage" => "cache_storage",
            "listen" => "listen",
            "login_storage" => "login_storage",
            "preferences_storage" => "preferences_storage",
            "library_storage" => "library_storage",
            "runtime" => "runtime",
            "entropy" => "entropy",
            _ => "host_startup_failed",
        };
        Self {
            schema_version: 1,
            stage,
            last_completed,
            code,
            io_kind: None,
            os_error: None,
        }
    }
}

pub(super) struct Progress {
    pub stage: Stage,
    pub last_completed: Option<Stage>,
}

impl Progress {
    pub fn enter(&mut self, stage: Stage) {
        self.last_completed = Some(self.stage);
        self.stage = stage;
    }

    pub fn failed(&self, error: super::ApiError) -> Failure {
        let mut failure = Failure::new(self.stage, self.last_completed, &error.code);
        if let Some((kind, errno)) = error.io_facts.map(|facts| *facts) {
            failure.io_kind = Some(kind);
            failure.os_error = errno;
        }
        failure
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostic_never_echoes_native_payloads() {
        let failure = Failure::new(
            Stage::LibraryLoad,
            Some(Stage::PreferencesLoad),
            "private/path?token=secret",
        );
        let value = serde_json::to_string(&failure).unwrap();
        assert!(!value.contains("secret"));
        assert!(!value.contains("private"));
        assert!(value.contains("host_startup_failed"));
    }
}
