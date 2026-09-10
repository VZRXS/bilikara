//! Restart policy belongs to AppState, not to a Tauri or Python adapter.
use super::*;
use crate::native_host_storage::{NativeHostStorage, NativeStorageError};

fn restart_item(item: &mut PlaylistItem) {
    item.item_incarnation_id.clear();
    clear_committed_artifact(item, true);
    item.cache_status = default_cache_status();
    item.cache_progress = 0.0;
    item.cache_message = default_cache_message();
}

fn restart_seed(seed: &mut AppStateSeed) {
    seed.current_item_started = false;
    for item in seed.current_item.iter_mut().chain(seed.playlist.iter_mut()) {
        restart_item(item);
    }
    if let Some(backup) = &mut seed.backup {
        for item in backup
            .current_item
            .iter_mut()
            .chain(backup.playlist.iter_mut())
        {
            restart_item(item);
        }
    }
}

impl AppStateData {
    fn native_checkpoint(&self) -> AppStateSeed {
        let mut seed = AppStateSeed {
            playback_mode: self.playback_mode.clone(),
            player_settings: self.player_settings.clone(),
            current_item: self.current_item.clone(),
            current_item_started: false,
            playlist: self.playlist.clone(),
            history: self.history.clone(),
            session_history: self.session_history.clone(),
            session_users: self.session_users.clone(),
            session_started_at: self.session_started_at,
            session_played_file: self.session_played_file.clone(),
            session_played: self.session_played.clone(),
            previous_session: self.previous_session.clone(),
            backup: self.backup.clone(),
            updated_at: self.updated_at,
        };
        restart_seed(&mut seed);
        seed
    }
}

impl AppState {
    pub(super) fn initialize_native(
        &mut self,
        directory: &Path,
        initial: AppStateSeed,
    ) -> AppStateResponse {
        if self.data.is_some() {
            return if self
                .native_storage
                .as_ref()
                .is_some_and(|storage| storage.is_directory(directory))
            {
                self.execute(AppStateRequest::Snapshot {
                    schema_version: SCHEMA_VERSION,
                })
            } else {
                invalid_request_response(
                    "native_storage_conflict",
                    "AppState is already initialized with a different persistence owner",
                )
            };
        }
        let (storage, loaded) = match NativeHostStorage::open(directory) {
            Ok(value) => value,
            Err(error) => return storage_error_response(error),
        };
        let mut seed = loaded.unwrap_or(initial);
        // Validate before normalization. A malformed saved file is not a new
        // installation, and must never be overwritten by an empty default seed.
        if let Err(error) = validate_seed(&seed) {
            return execute_error_response(error);
        }
        restart_seed(&mut seed);
        self.native_storage = Some(storage);
        let response = self.initialize_once(seed);
        if response.error().is_some() {
            self.native_storage = None;
        }
        response
    }

    pub(super) fn persist_native(&mut self, next: &AppStateData) -> Result<(), NativeStorageError> {
        if let Some(storage) = self.native_storage.as_mut() {
            storage.save(next.native_checkpoint())?;
        }
        Ok(())
    }
}

pub(super) fn storage_error_response(error: NativeStorageError) -> AppStateResponse {
    AppStateResponse::Failure(AppStateFailure {
        schema_version: SCHEMA_VERSION,
        status: "persistence_error",
        error: AppStateError {
            kind: error.kind.to_owned(),
            message: error.message,
            details: None,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static DIRECTORY_ID: AtomicU64 = AtomicU64::new(0);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "bilikara-native-storage-test-{}-{}",
                std::process::id(),
                DIRECTORY_ID.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn bytes(&self) -> Vec<u8> {
            fs::read(self.0.join("host-state.json")).unwrap()
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    fn seed() -> AppStateSeed {
        serde_json::from_value(json!({
            "session_started_at": 10, "updated_at": 10,
            "session_played_file": "native-session.json", "session_users": ["Alice"]
        }))
        .unwrap()
    }

    fn item(id: &str) -> PlaylistItem {
        serde_json::from_value(json!({
            "id": id, "original_url": "https://example.test/video", "resolved_url": "https://example.test/video?p=1",
            "bvid": "BV1z84y1p7oS", "aid": 1, "cid": 2, "title": "Test song", "part_title": "P1",
            "display_title": "Test song - P1", "cover_url": "", "embed_url": "", "requester_name": "Alice"
        })).unwrap()
    }

    fn snapshot(response: AppStateResponse) -> AppSnapshot {
        response
            .snapshot()
            .unwrap_or_else(|| panic!("Native state failed: {:?}", response.error()))
            .clone()
    }

    fn saved(directory: &TestDirectory) -> AppStateSeed {
        serde_json::from_value(
            serde_json::from_slice::<Value>(&directory.bytes()).unwrap()["state"].clone(),
        )
        .unwrap()
    }

    #[test]
    fn restart_policy_preserves_page_selection_but_strips_artifacts_from_live_items_and_backups() {
        let mut queued = item("queued");
        queued.page = 2;
        queued.selected_pages = vec![2, 3];
        queued.manual_selection = true;
        queued.cache_status = "ready".into();
        queued.cache_message = "Ready".into();
        queued.cache_progress = 100.0;
        queued.item_incarnation_id = "old-incarnation".into();
        queued.artifact_set_id = "old-artifact".into();
        queued.artifact_relative_directory = "old-directory".into();
        queued.video_relative_path = "old-video.mp4".into();
        queued.video_media_url = "/old-media".into();
        queued.audio_variants = vec![Map::new()];
        queued.selected_audio_variant_id = "old-audio".into();
        let mut initial = seed();
        initial.current_item_started = true;
        initial.current_item = Some(queued.clone());
        initial.playlist = vec![queued.clone()];
        initial.backup = Some(BackupSeed {
            current_item: Some(queued.clone()),
            playlist: vec![queued],
            played_session: None,
            updated_at: 10.0,
        });
        restart_seed(&mut initial);
        assert!(!initial.current_item_started);
        let backup = initial.backup.as_ref().unwrap();
        for restored in initial
            .current_item
            .iter()
            .chain(&initial.playlist)
            .chain(&backup.current_item)
            .chain(&backup.playlist)
        {
            assert_eq!(restored.page, 2);
            assert_eq!(restored.selected_pages, [2, 3]);
            assert!(restored.manual_selection);
            assert_eq!(restored.cache_status, "pending");
            assert_eq!(restored.cache_progress, 0.0);
            assert_eq!(restored.cache_message, default_cache_message());
            assert!(restored.item_incarnation_id.is_empty());
            assert!(restored.artifact_set_id.is_empty());
            assert!(restored.artifact_relative_directory.is_empty());
            assert!(restored.video_relative_path.is_empty());
            assert!(restored.video_media_url.is_empty());
            assert!(restored.audio_variants.is_empty());
            assert!(restored.selected_audio_variant_id.is_empty());
        }
    }

    #[test]
    fn discarded_backup_stays_discarded_after_reopening_the_host() {
        let directory = TestDirectory::new();
        let mut state = AppState::default();
        let mut initial = seed();
        initial.backup = Some(BackupSeed {
            current_item: Some(item("backup")),
            playlist: vec![],
            played_session: None,
            updated_at: 10.0,
        });
        snapshot(state.initialize_native(&directory.0, initial));
        snapshot(state.execute(AppStateRequest::DiscardBackup {
            schema_version: 1,
            new_session: SessionArchiveSeed {
                file_name: "discarded.json".into(),
                session_started_at: 20.0,
                items: vec![],
            },
            now: 20.0,
        }));
        drop(state);
        let mut second = AppState::default();
        snapshot(second.initialize_native(&directory.0, seed()));
        assert!(second.data.as_ref().unwrap().backup.is_none());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_checkpoint_is_not_treated_as_a_new_installation() {
        let directory = TestDirectory::new();
        let target = directory.0.join("absent.json");
        std::os::unix::fs::symlink(&target, directory.0.join("host-state.json")).unwrap();
        let mut state = AppState::default();
        assert_eq!(
            state
                .initialize_native(&directory.0, seed())
                .error()
                .unwrap()
                .kind,
            "native_storage_invalid"
        );
        assert!(state.data.is_none());
        assert!(!target.exists());
        assert!(
            fs::symlink_metadata(directory.0.join("host-state.json"))
                .unwrap()
                .is_symlink()
        );
    }

    #[test]
    fn round_trip_keeps_queue_settings_and_archives_but_not_live_credentials() {
        let directory = TestDirectory::new();
        let mut initial = seed();
        initial.current_item = Some(item("playing"));
        initial.playlist = vec![item("queued")];
        initial.player_settings.volume_percent = 64;
        initial.player_settings.global_av_delay_ms = 120;
        initial.history = vec![serde_json::from_value(json!({
            "key": "song:1", "display_title": "Test song", "original_url": "https://example.test/video",
            "resolved_url": "https://example.test/video?p=1", "requested_at": 10, "title": "Test song",
            "part_title": "P1", "requester_name": "Alice", "request_count": 1
        })).unwrap()];
        initial.session_history = initial.history.clone();
        initial.session_played = vec![serde_json::from_value(json!({
            "key": "song:1", "item_id": "playing", "display_title": "Test song", "title": "Test song",
            "part_title": "P1", "original_url": "https://example.test/video", "resolved_url": "https://example.test/video?p=1",
            "bvid": "BV1z84y1p7oS", "aid": 1, "cid": 2, "page": 1, "played_at": 10, "requester_name": "Alice"
        })).unwrap()];
        initial.previous_session = Some(SessionArchiveSeed {
            file_name: "previous.json".into(),
            session_started_at: 1.0,
            items: initial.session_played.clone(),
        });
        initial.backup = Some(BackupSeed {
            current_item: initial.current_item.clone(),
            playlist: initial.playlist.clone(),
            played_session: initial.previous_session.clone(),
            updated_at: 10.0,
        });
        let mut first = AppState::default();
        let before = snapshot(first.initialize_native(&directory.0, initial.clone()));
        snapshot(first.execute(AppStateRequest::MarkCurrentItemStarted {
            schema_version: 1,
            item_id: "playing".into(),
            now: 11.0,
        }));
        let incarnation = before
            .current_item
            .as_ref()
            .unwrap()
            .item_incarnation_id
            .clone();
        assert!(!incarnation.is_empty());
        let reservation = first.execute(AppStateRequest::BeginCacheAttempt {
            schema_version: 1,
            item_id: "playing".into(),
            expected_item_incarnation_id: incarnation.clone(),
        });
        assert!(reservation.error().is_none());
        assert!(
            !first
                .data
                .as_ref()
                .unwrap()
                .active_cache_attempts
                .is_empty()
        );
        assert!(first.data.as_ref().unwrap().current_item_started);
        drop(first); // Simulates process exit without an explicit Shutdown command.

        let mut second = AppState::default();
        let after = snapshot(second.initialize_native(&directory.0, seed()));
        assert_eq!(after.playlist.len(), 1);
        assert_eq!(after.playlist[0].id, "queued");
        assert_eq!(after.session_users, initial.session_users);
        assert_eq!(after.history, initial.history);
        assert_eq!(after.session_history, initial.session_history);
        assert_eq!(after.session_played, initial.session_played);
        assert_eq!(
            second.data.as_ref().unwrap().previous_session,
            initial.previous_session
        );
        assert_eq!(
            second.data.as_ref().unwrap().player_settings,
            initial.player_settings
        );
        assert_eq!(second.data.as_ref().unwrap().backup, initial.backup);
        assert!(!after.current_item_started);
        let current = after.current_item.unwrap();
        assert_ne!(current.item_incarnation_id, incarnation);
        assert_eq!(current.cache_status, "pending");
        assert!(current.artifact_set_id.is_empty());
        assert!(
            second
                .data
                .as_ref()
                .unwrap()
                .active_cache_attempts
                .is_empty()
        );
        assert_eq!(second.internet_remote_peers, InternetRemotePeers::default());
        let bytes = String::from_utf8(directory.bytes()).unwrap();
        assert!(!bytes.contains(&incarnation));
        assert!(!bytes.contains("active_cache_attempts"));
        assert!(!bytes.contains("internet_remote_peers"));
    }

    #[test]
    fn repeated_initialization_is_read_only_and_cannot_replace_the_persistence_owner() {
        let directory = TestDirectory::new();
        let other = TestDirectory::new();
        let mut state = AppState::default();
        snapshot(state.initialize_native(&directory.0, seed()));
        let changed = snapshot(state.execute(AppStateRequest::SetVolume {
            schema_version: 1,
            volume_percent: 35,
            now: 20.0,
        }));
        let bytes = directory.bytes();
        assert_eq!(
            snapshot(state.initialize_native(&directory.0, seed())),
            changed
        );
        assert_eq!(directory.bytes(), bytes);
        assert_eq!(saved(&directory).player_settings.volume_percent, 35);
        for response in [
            state.initialize_native(&other.0, seed()),
            state.execute(AppStateRequest::Initialize {
                schema_version: 1,
                state: Box::new(seed()),
            }),
        ] {
            assert_eq!(response.error().unwrap().kind, "native_storage_conflict");
        }
        assert!(!other.0.join("host-state.json").exists());
        assert_eq!(directory.bytes(), bytes);
        assert_eq!(
            snapshot(state.execute(AppStateRequest::Snapshot { schema_version: 1 })),
            changed
        );
    }

    #[test]
    fn storage_lock_excludes_a_second_writer_and_shutdown_releases_it() {
        let directory = TestDirectory::new();
        let mut first = AppState::default();
        let mut second = AppState::default();
        snapshot(first.initialize_native(&directory.0, seed()));
        assert_eq!(
            second
                .initialize_native(&directory.0, seed())
                .error()
                .unwrap()
                .kind,
            "native_storage_in_use"
        );
        assert!(second.data.is_none());
        assert!(second.native_storage.is_none());
        first.execute(AppStateRequest::Shutdown { schema_version: 1 });
        snapshot(second.initialize_native(&directory.0, seed()));
    }

    #[test]
    fn failed_replace_keeps_old_checkpoint_state_and_identity_allocator_then_allows_retry() {
        let directory = TestDirectory::new();
        let mut state = AppState::default();
        let before = snapshot(state.initialize_native(&directory.0, seed()));
        let bytes = directory.bytes();
        let before_counter = state.next_item_incarnation_id;
        let checkpoint = directory.0.join("host-state.json");
        let original = directory.0.join("retained.json");
        fs::rename(&checkpoint, &original).unwrap();
        fs::create_dir(&checkpoint).unwrap(); // Deterministic replacement failure on every platform.
        let request = || AppStateRequest::AddItem {
            schema_version: 1,
            item: item("new"),
            position: "tail".into(),
            requester_name: "Alice".into(),
            reset_av_delay: false,
            allow_repeat: false,
            now: 20.0,
        };
        assert_eq!(
            state.execute(request()).error().unwrap().kind,
            "native_storage_io"
        );
        assert_eq!(
            snapshot(state.execute(AppStateRequest::Snapshot { schema_version: 1 })),
            before
        );
        assert_eq!(state.next_item_incarnation_id, before_counter);
        assert_eq!(fs::read(&original).unwrap(), bytes);
        assert!(!directory.0.join("host-state.pending").exists());
        fs::remove_dir(&checkpoint).unwrap();
        fs::rename(&original, &checkpoint).unwrap();
        assert_eq!(
            snapshot(state.execute(request())).current_item.unwrap().id,
            "new"
        );
        assert_eq!(saved(&directory).current_item.unwrap().id, "new");
    }

    #[test]
    fn bad_or_newer_checkpoint_is_never_replaced_by_defaults() {
        for contents in [
            b"{incomplete".to_vec(),
            serde_json::to_vec(&json!({"schema_version": 999, "state": seed()})).unwrap(),
            serde_json::to_vec(&json!({"schema_version": 1, "state": {"session_started_at": -1, "updated_at": 10, "session_played_file": "bad.json"}})).unwrap(),
        ] {
            let directory = TestDirectory::new();
            fs::write(directory.0.join("host-state.json"), &contents).unwrap();
            let mut state = AppState::default();
            assert!(state.initialize_native(&directory.0, seed()).error().is_some());
            assert!(state.data.is_none());
            assert!(state.native_storage.is_none());
            assert_eq!(directory.bytes(), contents);
            assert!(!directory.0.join("host-state.pending").exists());
        }
    }

    #[test]
    fn oversized_checkpoint_and_failed_first_save_do_not_initialize_empty_state() {
        let directory = TestDirectory::new();
        let checkpoint = directory.0.join("host-state.json");
        let file = fs::File::create(&checkpoint).unwrap();
        file.set_len(32 * 1024 * 1024 + 1).unwrap();
        drop(file);
        let mut state = AppState::default();
        assert_eq!(
            state
                .initialize_native(&directory.0, seed())
                .error()
                .unwrap()
                .kind,
            "native_storage_invalid"
        );
        assert!(state.data.is_none());
        assert_eq!(
            fs::metadata(&checkpoint).unwrap().len(),
            32 * 1024 * 1024 + 1
        );
        fs::remove_file(&checkpoint).unwrap();
        let pending = directory.0.join("host-state.pending");
        fs::create_dir(&pending).unwrap();
        assert_eq!(
            state
                .initialize_native(&directory.0, seed())
                .error()
                .unwrap()
                .kind,
            "native_storage_invalid"
        );
        assert!(state.data.is_none());
        assert!(state.native_storage.is_none());
        assert!(!checkpoint.exists());
        fs::remove_dir(&pending).unwrap();
        snapshot(state.initialize_native(&directory.0, seed()));
    }

    #[test]
    fn runtime_only_changes_do_not_rewrite_checkpoint_and_reset_cannot_revive_backup() {
        let directory = TestDirectory::new();
        let mut state = AppState::default();
        let mut initial = seed();
        initial.current_item = Some(item("playing"));
        initial.backup = Some(BackupSeed {
            current_item: Some(item("backup")),
            playlist: vec![],
            played_session: None,
            updated_at: 10.0,
        });
        snapshot(state.initialize_native(&directory.0, initial));
        let before = directory.bytes();
        snapshot(state.execute(AppStateRequest::MarkCurrentItemStarted {
            schema_version: 1,
            item_id: "playing".into(),
            now: 40.0,
        }));
        assert_eq!(directory.bytes(), before);
        let incarnation = state
            .data
            .as_ref()
            .unwrap()
            .current_item
            .as_ref()
            .unwrap()
            .item_incarnation_id
            .clone();
        state.execute(AppStateRequest::BeginCacheAttempt {
            schema_version: 1,
            item_id: "playing".into(),
            expected_item_incarnation_id: incarnation,
        });
        let active = state.data.as_ref().unwrap().active_cache_attempts["playing"].clone();
        snapshot(state.execute(AppStateRequest::ApplyCacheEvent {
            schema_version: 1,
            item_id: "playing".into(),
            cache_attempt_token: active.token,
            event: CacheEvent::Progress {
                progress: 0.5,
                message: Some("Downloading".into()),
            },
            now: 41.0,
        }));
        assert_eq!(directory.bytes(), before);
        snapshot(state.execute(AppStateRequest::ResetRuntime {
            schema_version: 1,
            new_session: SessionArchiveSeed {
                file_name: "reset.json".into(),
                session_started_at: 50.0,
                items: vec![],
            },
            now: 50.0,
        }));
        drop(state);
        let mut reopened = AppState::default();
        let after = snapshot(reopened.initialize_native(&directory.0, seed()));
        assert!(after.current_item.is_none());
        assert!(after.playlist.is_empty());
        assert!(after.session_users.is_empty());
        assert!(reopened.data.as_ref().unwrap().backup.is_none());
    }
}
