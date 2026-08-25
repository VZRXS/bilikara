use bilikara_rust::{
    AvDelayAction, AvDelayState, DuplicateActiveItem, DuplicateHistoryEntry,
    PlaylistDuplicateRequest, PlaylistIdentity, PlaylistOrderItem, PlaylistOrderOperation,
    PlaylistOrderRequest, PlaylistSlotType, decide_av_delay, decide_playlist_duplicate,
    plan_playlist_order,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};
use std::path::{Component, Path};
use std::sync::{Mutex, OnceLock};

const SCHEMA_VERSION: u32 = 1;
const MAX_ITEMS: usize = 10_000;
const MAX_SESSION_USERS: usize = 32;
const MAX_SESSION_USER_NAME_CHARS: usize = 24;
const MAX_ITEM_ID_BYTES: usize = 512;
const MAX_STRING_BYTES: usize = 1_048_576;
const MAX_VOLUME_PERCENT: i32 = 100;
const DEFAULT_SONG_ADVANCE_DELAY_SECONDS: i32 = 3;
const MAX_SONG_ADVANCE_DELAY_SECONDS: i32 = 30;
const MIN_KEY_SHIFT: i32 = -6;
const MAX_KEY_SHIFT: i32 = 6;
const IDENTITY_NAMESPACE_BYTES: usize = 16;
const ARTIFACT_ROOT_COMPONENT: &str = "artifacts";

fn default_page() -> i64 {
    1
}

fn default_queue_slot_type() -> String {
    "cycle".to_owned()
}

fn default_cache_status() -> String {
    "pending".to_owned()
}

fn default_cache_message() -> String {
    "等待缓存".to_owned()
}

fn default_volume_percent() -> i32 {
    MAX_VOLUME_PERCENT
}

fn default_song_advance_delay_seconds() -> i32 {
    DEFAULT_SONG_ADVANCE_DELAY_SECONDS
}

fn default_playback_mode() -> String {
    "local".to_owned()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PlaylistItem {
    pub id: String,
    pub original_url: String,
    pub resolved_url: String,
    pub bvid: String,
    pub aid: i64,
    pub cid: i64,
    #[serde(default = "default_page")]
    pub page: i64,
    pub title: String,
    pub part_title: String,
    pub display_title: String,
    pub cover_url: String,
    pub embed_url: String,
    #[serde(default)]
    pub selected_pages: Vec<i64>,
    #[serde(default)]
    pub selected_cids: Vec<i64>,
    #[serde(default)]
    pub selected_durations: Vec<i64>,
    #[serde(default)]
    pub selected_parts: Vec<String>,
    #[serde(default)]
    pub available_pages: Vec<i64>,
    #[serde(default)]
    pub available_cids: Vec<i64>,
    #[serde(default)]
    pub available_durations: Vec<i64>,
    #[serde(default)]
    pub available_parts: Vec<String>,
    #[serde(default)]
    pub audio_variants: Vec<Map<String, Value>>,
    #[serde(default)]
    pub selected_audio_variant_id: String,
    #[serde(default = "default_page")]
    pub video_page: i64,
    #[serde(default)]
    pub manual_selection: bool,
    #[serde(default)]
    pub owner_mid: i64,
    #[serde(default)]
    pub owner_name: String,
    #[serde(default)]
    pub owner_url: String,
    #[serde(default)]
    pub requester_name: String,
    #[serde(default = "default_queue_slot_type")]
    pub queue_slot_type: String,
    #[serde(default = "default_cache_status")]
    pub cache_status: String,
    #[serde(default)]
    pub cache_progress: f64,
    #[serde(default = "default_cache_message")]
    pub cache_message: String,
    #[serde(default)]
    pub video_relative_path: String,
    #[serde(default)]
    pub video_media_url: String,
    #[serde(default)]
    pub item_incarnation_id: String,
    #[serde(default)]
    pub artifact_set_id: String,
    #[serde(default)]
    pub artifact_relative_directory: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct HistoryEntry {
    pub key: String,
    pub display_title: String,
    pub original_url: String,
    pub resolved_url: String,
    pub requested_at: f64,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub part_title: String,
    #[serde(default)]
    pub owner_mid: i64,
    #[serde(default)]
    pub owner_name: String,
    #[serde(default)]
    pub owner_url: String,
    #[serde(default)]
    pub requester_name: String,
    #[serde(default = "default_request_count")]
    pub request_count: u64,
}

fn default_request_count() -> u64 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SessionPlayedEntry {
    pub key: String,
    pub item_id: String,
    pub display_title: String,
    pub title: String,
    pub part_title: String,
    pub original_url: String,
    pub resolved_url: String,
    pub bvid: String,
    pub aid: i64,
    pub cid: i64,
    pub page: i64,
    pub played_at: f64,
    #[serde(default)]
    pub ended_at: Option<f64>,
    #[serde(default)]
    pub owner_mid: i64,
    #[serde(default)]
    pub owner_name: String,
    #[serde(default)]
    pub owner_url: String,
    #[serde(default)]
    pub requester_name: String,
    #[serde(default)]
    pub cover_url: String,
    #[serde(default)]
    pub threshold_reached: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SessionArchiveSeed {
    pub file_name: String,
    pub session_started_at: f64,
    #[serde(default)]
    pub items: Vec<SessionPlayedEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct BackupSeed {
    #[serde(default)]
    pub current_item: Option<PlaylistItem>,
    #[serde(default)]
    pub playlist: Vec<PlaylistItem>,
    #[serde(default)]
    pub played_session: Option<SessionArchiveSeed>,
    pub updated_at: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PlayerSettingsSeed {
    #[serde(default)]
    pub global_av_delay_ms: i32,
    #[serde(default)]
    pub local_av_delay_ms: i32,
    #[serde(default)]
    pub av_delay_locked: bool,
    #[serde(default = "default_volume_percent")]
    pub volume_percent: i32,
    #[serde(default)]
    pub is_muted: bool,
    #[serde(default = "default_song_advance_delay_seconds")]
    pub song_advance_delay_seconds: i32,
    #[serde(default)]
    pub key_shift: i32,
}

impl Default for PlayerSettingsSeed {
    fn default() -> Self {
        Self {
            global_av_delay_ms: 0,
            local_av_delay_ms: 0,
            av_delay_locked: false,
            volume_percent: default_volume_percent(),
            is_muted: false,
            song_advance_delay_seconds: default_song_advance_delay_seconds(),
            key_shift: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AppStateSeed {
    #[serde(default = "default_playback_mode")]
    pub playback_mode: String,
    #[serde(default)]
    pub player_settings: PlayerSettingsSeed,
    #[serde(default)]
    pub current_item: Option<PlaylistItem>,
    #[serde(default)]
    pub current_item_started: bool,
    #[serde(default)]
    pub playlist: Vec<PlaylistItem>,
    #[serde(default)]
    pub history: Vec<HistoryEntry>,
    #[serde(default)]
    pub session_history: Vec<HistoryEntry>,
    #[serde(default)]
    pub session_users: Vec<String>,
    pub session_started_at: f64,
    pub session_played_file: String,
    #[serde(default)]
    pub session_played: Vec<SessionPlayedEntry>,
    #[serde(default)]
    pub previous_session: Option<SessionArchiveSeed>,
    #[serde(default)]
    pub backup: Option<BackupSeed>,
    pub updated_at: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PlaylistItemPatch {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub part_title: Option<String>,
    #[serde(default)]
    pub display_title: Option<String>,
    #[serde(default)]
    pub cover_url: Option<String>,
    #[serde(default)]
    pub embed_url: Option<String>,
    #[serde(default)]
    pub owner_mid: Option<i64>,
    #[serde(default)]
    pub owner_name: Option<String>,
    #[serde(default)]
    pub owner_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum AvDelayCommand {
    Snapshot,
    SetEffective { effective_delay_ms: i32 },
    SetPersistent { effective_delay_ms: i32 },
    Adjust { delta_ms: i32 },
    ResetLocal,
    ToggleLock,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum CacheEvent {
    Queued {
        #[serde(default)]
        message: String,
    },
    Started {
        #[serde(default)]
        message: String,
    },
    Progress {
        progress: f64,
        #[serde(default)]
        message: Option<String>,
    },
    Ready {
        #[serde(default = "default_ready_progress")]
        progress: f64,
        message: String,
        video_relative_path: String,
        video_media_url: String,
        audio_variants: Vec<Map<String, Value>>,
        #[serde(default)]
        selected_audio_variant_id: String,
        item_incarnation_id: String,
        artifact_set_id: String,
        artifact_relative_directory: String,
    },
    Failed {
        message: String,
    },
    Cancelled {
        message: String,
    },
    Evicted {
        message: String,
    },
    Reset {
        message: String,
        #[serde(default)]
        clear_selected_audio_variant: bool,
    },
}

fn default_ready_progress() -> f64 {
    100.0
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "command", rename_all = "snake_case", deny_unknown_fields)]
pub enum AppStateRequest {
    Initialize {
        schema_version: u32,
        state: Box<AppStateSeed>,
    },
    Snapshot {
        schema_version: u32,
    },
    AddItem {
        schema_version: u32,
        item: PlaylistItem,
        position: String,
        requester_name: String,
        #[serde(default)]
        reset_av_delay: bool,
        #[serde(default)]
        allow_repeat: bool,
        now: f64,
    },
    UpdateItem {
        schema_version: u32,
        item_id: String,
        changes: PlaylistItemPatch,
        #[serde(default)]
        persist_backup: bool,
        now: f64,
    },
    RemoveItem {
        schema_version: u32,
        item_id: String,
        now: f64,
    },
    ClearPlaylist {
        schema_version: u32,
        now: f64,
    },
    ClearHistory {
        schema_version: u32,
        now: f64,
    },
    RemoveHistoryEntry {
        schema_version: u32,
        key: String,
        now: f64,
    },
    AdvanceToNext {
        schema_version: u32,
        #[serde(default)]
        reset_av_delay: bool,
        now: f64,
    },
    MoveItem {
        schema_version: u32,
        item_id: String,
        direction: String,
        now: f64,
    },
    MoveToNext {
        schema_version: u32,
        item_id: String,
        now: f64,
    },
    MoveItemToIndex {
        schema_version: u32,
        item_id: String,
        target_index: i64,
        now: f64,
    },
    ResortPlaylistByCycle {
        schema_version: u32,
        now: f64,
    },
    MoveToFront {
        schema_version: u32,
        item_id: String,
        #[serde(default)]
        reset_av_delay: bool,
        now: f64,
    },
    SetCurrentItem {
        schema_version: u32,
        #[serde(default)]
        item_id: Option<String>,
        #[serde(default)]
        reset_av_delay: bool,
        now: f64,
    },
    SetPlaybackMode {
        schema_version: u32,
        mode: String,
        now: f64,
    },
    ApplyAvDelay {
        schema_version: u32,
        action: AvDelayCommand,
        now: f64,
    },
    SetVolume {
        schema_version: u32,
        volume_percent: i32,
        now: f64,
    },
    SetMuted {
        schema_version: u32,
        is_muted: bool,
        now: f64,
    },
    SetSongAdvanceDelay {
        schema_version: u32,
        delay_seconds: i32,
        now: f64,
    },
    SetKeyShift {
        schema_version: u32,
        key_shift: i32,
        now: f64,
    },
    SetAudioVariant {
        schema_version: u32,
        item_id: String,
        variant_id: String,
        now: f64,
    },
    AddSessionUser {
        schema_version: u32,
        name: String,
        now: f64,
    },
    RemoveSessionUser {
        schema_version: u32,
        name: String,
        now: f64,
    },
    RenameSessionUser {
        schema_version: u32,
        current_name: String,
        new_name: String,
        now: f64,
    },
    MoveSessionUserToIndex {
        schema_version: u32,
        name: String,
        target_index: i64,
        now: f64,
    },
    SetSessionUsers {
        schema_version: u32,
        users: Vec<String>,
        now: f64,
    },
    RestoreBackup {
        schema_version: u32,
        #[serde(default)]
        reset_av_delay: bool,
        now: f64,
    },
    DiscardBackup {
        schema_version: u32,
        new_session: SessionArchiveSeed,
        now: f64,
    },
    ContinuePreviousSession {
        schema_version: u32,
        #[serde(default)]
        archive: Option<SessionArchiveSeed>,
        now: f64,
    },
    BeginSession {
        schema_version: u32,
        new_session: SessionArchiveSeed,
        now: f64,
    },
    ResetRuntime {
        schema_version: u32,
        new_session: SessionArchiveSeed,
        now: f64,
    },
    ResetPlayer {
        schema_version: u32,
        now: f64,
    },
    MarkCurrentItemStarted {
        schema_version: u32,
        item_id: String,
        now: f64,
    },
    MarkSessionPlayedThreshold {
        schema_version: u32,
        item_id: String,
        now: f64,
    },
    AppendHistory {
        schema_version: u32,
        entry: HistoryEntry,
        now: f64,
    },
    AppendSessionPlayed {
        schema_version: u32,
        entry: SessionPlayedEntry,
        now: f64,
    },
    UpdateOwnerInfo {
        schema_version: u32,
        source_url: String,
        owner_mid: i64,
        owner_name: String,
        owner_url: String,
        now: f64,
    },
    QueryDuplicate {
        schema_version: u32,
        item: PlaylistItem,
    },
    BeginCacheAttempt {
        schema_version: u32,
        item_id: String,
        expected_item_incarnation_id: String,
    },
    AuthorizeCachePublication {
        schema_version: u32,
        item_id: String,
        cache_attempt_token: u64,
        item_incarnation_id: String,
        artifact_set_id: String,
        artifact_relative_directory: String,
    },
    ApplyCacheEvent {
        schema_version: u32,
        item_id: String,
        cache_attempt_token: u64,
        event: CacheEvent,
        now: f64,
    },
    Shutdown {
        schema_version: u32,
    },
}

impl AppStateRequest {
    fn schema_version(&self) -> u32 {
        match self {
            Self::Initialize { schema_version, .. }
            | Self::Snapshot { schema_version }
            | Self::AddItem { schema_version, .. }
            | Self::UpdateItem { schema_version, .. }
            | Self::RemoveItem { schema_version, .. }
            | Self::ClearPlaylist { schema_version, .. }
            | Self::ClearHistory { schema_version, .. }
            | Self::RemoveHistoryEntry { schema_version, .. }
            | Self::AdvanceToNext { schema_version, .. }
            | Self::MoveItem { schema_version, .. }
            | Self::MoveToNext { schema_version, .. }
            | Self::MoveItemToIndex { schema_version, .. }
            | Self::ResortPlaylistByCycle { schema_version, .. }
            | Self::MoveToFront { schema_version, .. }
            | Self::SetCurrentItem { schema_version, .. }
            | Self::SetPlaybackMode { schema_version, .. }
            | Self::ApplyAvDelay { schema_version, .. }
            | Self::SetVolume { schema_version, .. }
            | Self::SetMuted { schema_version, .. }
            | Self::SetSongAdvanceDelay { schema_version, .. }
            | Self::SetKeyShift { schema_version, .. }
            | Self::SetAudioVariant { schema_version, .. }
            | Self::AddSessionUser { schema_version, .. }
            | Self::RemoveSessionUser { schema_version, .. }
            | Self::RenameSessionUser { schema_version, .. }
            | Self::MoveSessionUserToIndex { schema_version, .. }
            | Self::SetSessionUsers { schema_version, .. }
            | Self::RestoreBackup { schema_version, .. }
            | Self::DiscardBackup { schema_version, .. }
            | Self::ContinuePreviousSession { schema_version, .. }
            | Self::BeginSession { schema_version, .. }
            | Self::ResetRuntime { schema_version, .. }
            | Self::ResetPlayer { schema_version, .. }
            | Self::MarkCurrentItemStarted { schema_version, .. }
            | Self::MarkSessionPlayedThreshold { schema_version, .. }
            | Self::AppendHistory { schema_version, .. }
            | Self::AppendSessionPlayed { schema_version, .. }
            | Self::UpdateOwnerInfo { schema_version, .. }
            | Self::QueryDuplicate { schema_version, .. }
            | Self::BeginCacheAttempt { schema_version, .. }
            | Self::AuthorizeCachePublication { schema_version, .. }
            | Self::ApplyCacheEvent { schema_version, .. }
            | Self::Shutdown { schema_version } => *schema_version,
        }
    }

    fn now(&self) -> Option<f64> {
        match self {
            Self::AddItem { now, .. }
            | Self::UpdateItem { now, .. }
            | Self::RemoveItem { now, .. }
            | Self::ClearPlaylist { now, .. }
            | Self::ClearHistory { now, .. }
            | Self::RemoveHistoryEntry { now, .. }
            | Self::AdvanceToNext { now, .. }
            | Self::MoveItem { now, .. }
            | Self::MoveToNext { now, .. }
            | Self::MoveItemToIndex { now, .. }
            | Self::ResortPlaylistByCycle { now, .. }
            | Self::MoveToFront { now, .. }
            | Self::SetCurrentItem { now, .. }
            | Self::SetPlaybackMode { now, .. }
            | Self::ApplyAvDelay { now, .. }
            | Self::SetVolume { now, .. }
            | Self::SetMuted { now, .. }
            | Self::SetSongAdvanceDelay { now, .. }
            | Self::SetKeyShift { now, .. }
            | Self::SetAudioVariant { now, .. }
            | Self::AddSessionUser { now, .. }
            | Self::RemoveSessionUser { now, .. }
            | Self::RenameSessionUser { now, .. }
            | Self::MoveSessionUserToIndex { now, .. }
            | Self::SetSessionUsers { now, .. }
            | Self::RestoreBackup { now, .. }
            | Self::DiscardBackup { now, .. }
            | Self::ContinuePreviousSession { now, .. }
            | Self::BeginSession { now, .. }
            | Self::ResetRuntime { now, .. }
            | Self::ResetPlayer { now, .. }
            | Self::MarkCurrentItemStarted { now, .. }
            | Self::MarkSessionPlayedThreshold { now, .. }
            | Self::AppendHistory { now, .. }
            | Self::AppendSessionPlayed { now, .. }
            | Self::UpdateOwnerInfo { now, .. }
            | Self::ApplyCacheEvent { now, .. } => Some(*now),
            Self::Initialize { .. }
            | Self::Snapshot { .. }
            | Self::QueryDuplicate { .. }
            | Self::BeginCacheAttempt { .. }
            | Self::AuthorizeCachePublication { .. }
            | Self::Shutdown { .. } => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AvDelaySnapshot {
    schema_version: u32,
    global_delay_ms: i32,
    local_delay_ms: i32,
    effective_delay_ms: i32,
    locked: bool,
    has_local_adjustment: bool,
    lock_button_enabled: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PlayerSettingsSnapshot {
    av_offset_ms: i32,
    av_delay: AvDelaySnapshot,
    volume_percent: i32,
    is_muted: bool,
    song_advance_delay_seconds: i32,
    key_shift: i32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct BackupSummary {
    available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    playlist_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    updated_at: Option<f64>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    preview_titles: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    playback_mode: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PreviousSessionSummary {
    available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    item_count: Option<usize>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AppSnapshot {
    pub schema_version: u32,
    pub revision: u64,
    pub session_generation: u64,
    pub playback_generation: u64,
    pub playback_mode: String,
    pub player_settings: PlayerSettingsSnapshot,
    pub current_item: Option<PlaylistItem>,
    pub current_item_started: bool,
    pub playlist: Vec<PlaylistItem>,
    pub history: Vec<HistoryEntry>,
    pub session_history: Vec<HistoryEntry>,
    pub session_users: Vec<String>,
    pub session_played: Vec<SessionPlayedEntry>,
    pub updated_at: f64,
    pub backup: BackupSummary,
    pub previous_session: PreviousSessionSummary,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PersistenceSnapshot {
    playback_mode: String,
    player_settings: PlayerSettingsSeed,
    history: Vec<HistoryEntry>,
    session_users: Vec<String>,
    session_started_at: f64,
    session_played_file: String,
    session_played: Vec<SessionPlayedEntry>,
    backup: Option<BackupSeed>,
    updated_at: f64,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct PersistenceEffects {
    pub write_core: bool,
    pub write_session_played: bool,
    pub write_backup: bool,
    pub delete_backup: bool,
    pub delete_runtime_files: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AppStateSuccess {
    schema_version: u32,
    status: &'static str,
    committed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    snapshot: Option<AppSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    persistence: Option<PersistenceSnapshot>,
    effects: PersistenceEffects,
    result: Value,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AppStateFailure {
    schema_version: u32,
    status: &'static str,
    error: AppStateError,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AppStateError {
    pub kind: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(untagged)]
pub enum AppStateResponse {
    Success(Box<AppStateSuccess>),
    Failure(AppStateFailure),
}

#[derive(Debug, Clone, PartialEq)]
struct AppStateData {
    revision: u64,
    session_generation: u64,
    playback_generation: u64,
    playback_mode: String,
    player_settings: PlayerSettingsSeed,
    current_item: Option<PlaylistItem>,
    current_item_started: bool,
    playlist: Vec<PlaylistItem>,
    history: Vec<HistoryEntry>,
    session_history: Vec<HistoryEntry>,
    session_users: Vec<String>,
    session_started_at: f64,
    session_played_file: String,
    session_played: Vec<SessionPlayedEntry>,
    previous_session: Option<SessionArchiveSeed>,
    backup: Option<BackupSeed>,
    updated_at: f64,
    active_cache_attempts: HashMap<String, ActiveCacheAttempt>,
}

#[derive(Debug)]
pub struct AppState {
    data: Option<AppStateData>,
    next_cache_attempt_token: u64,
    next_item_incarnation_id: u64,
    next_artifact_set_id: u64,
    identity_namespace: Result<[u8; IDENTITY_NAMESPACE_BYTES], String>,
}

#[derive(Debug, Clone, PartialEq)]
struct ActiveCacheAttempt {
    token: u64,
    reservation: CacheAttemptReservation,
    refresh: bool,
    terminal_event: Option<CacheEvent>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub(crate) struct CacheAttemptReservation {
    pub cache_attempt_token: u64,
    pub item_id: String,
    pub item_incarnation_id: String,
    pub artifact_set_id: String,
    pub artifact_relative_directory: String,
    pub refresh: bool,
}

impl Default for AppState {
    fn default() -> Self {
        let mut namespace = [0_u8; IDENTITY_NAMESPACE_BYTES];
        let identity_namespace = getrandom::fill(&mut namespace)
            .map_err(|error| format!("operating-system identity entropy is unavailable: {error}"))
            .and_then(|()| {
                if namespace.iter().all(|byte| *byte == 0) {
                    Err(
                        "operating-system identity entropy returned an all-zero namespace"
                            .to_owned(),
                    )
                } else {
                    Ok(namespace)
                }
            });
        Self {
            data: None,
            next_cache_attempt_token: 0,
            next_item_incarnation_id: 0,
            next_artifact_set_id: 0,
            identity_namespace,
        }
    }
}

#[derive(Debug)]
struct MutationResult {
    changed: bool,
    operational_changed: bool,
    result: Value,
    effects: PersistenceEffects,
}

impl MutationResult {
    fn unchanged(result: Value) -> Self {
        Self {
            changed: false,
            operational_changed: false,
            result,
            effects: PersistenceEffects::default(),
        }
    }

    fn changed(result: Value, persist_backup: bool) -> Self {
        Self {
            changed: true,
            operational_changed: false,
            result,
            effects: PersistenceEffects {
                write_core: true,
                write_session_played: true,
                write_backup: persist_backup,
                ..PersistenceEffects::default()
            },
        }
    }

    fn with_operational_change(mut self) -> Self {
        self.operational_changed = true;
        self
    }
}

#[derive(Debug)]
enum ExecuteError {
    Rejected(AppStateError),
    Internal(String),
}

static APP_STATE: OnceLock<Mutex<AppState>> = OnceLock::new();

fn rejected(kind: &str, message: impl Into<String>) -> ExecuteError {
    ExecuteError::Rejected(AppStateError {
        kind: kind.to_owned(),
        message: message.into(),
        details: None,
    })
}

fn rejected_with_details(kind: &str, message: impl Into<String>, details: Value) -> ExecuteError {
    ExecuteError::Rejected(AppStateError {
        kind: kind.to_owned(),
        message: message.into(),
        details: Some(details),
    })
}

fn valid_string(value: &str, max_bytes: usize, allow_empty: bool) -> bool {
    (allow_empty || !value.is_empty()) && !value.contains('\0') && value.len() <= max_bytes
}

fn format_authoritative_identity(
    prefix: char,
    namespace: &[u8; IDENTITY_NAMESPACE_BYTES],
    counter: u64,
) -> String {
    let namespace = namespace
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("{prefix}-{namespace}-{counter:016x}")
}

fn valid_authoritative_identity(value: &str, prefix: char) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 51
        && bytes[0] == prefix as u8
        && bytes[1] == b'-'
        && bytes[34] == b'-'
        && bytes[2..34]
            .iter()
            .chain(bytes[35..51].iter())
            .all(u8::is_ascii_hexdigit)
        && bytes[35..51].iter().any(|byte| *byte != b'0')
}

fn artifact_relative_directory(item_incarnation_id: &str, artifact_set_id: &str) -> String {
    format!("{ARTIFACT_ROOT_COMPONENT}/{item_incarnation_id}/{artifact_set_id}")
}

fn valid_artifact_relative_directory(
    value: &str,
    item_incarnation_id: &str,
    artifact_set_id: &str,
) -> bool {
    value == artifact_relative_directory(item_incarnation_id, artifact_set_id)
}

fn clear_committed_artifact(item: &mut PlaylistItem, clear_selected_audio_variant: bool) {
    item.video_relative_path.clear();
    item.video_media_url.clear();
    item.audio_variants.clear();
    item.artifact_set_id.clear();
    item.artifact_relative_directory.clear();
    if clear_selected_audio_variant {
        item.selected_audio_variant_id.clear();
    }
}

fn has_committed_artifact(item: &PlaylistItem) -> bool {
    !item.artifact_set_id.is_empty()
        && !item.artifact_relative_directory.is_empty()
        && !item.video_relative_path.is_empty()
        && !item.video_media_url.is_empty()
        && !item.audio_variants.is_empty()
}

fn allocate_authoritative_identity(
    prefix: char,
    namespace: &[u8; IDENTITY_NAMESPACE_BYTES],
    counter: &mut u64,
    exhausted_kind: &str,
) -> Result<String, ExecuteError> {
    let next = counter
        .checked_add(1)
        .filter(|value| *value > 0)
        .ok_or_else(|| {
            rejected(
                exhausted_kind,
                format!("{prefix} identity allocator is exhausted"),
            )
        })?;
    *counter = next;
    Ok(format_authoritative_identity(prefix, namespace, next))
}

fn assign_new_item_incarnation(
    item: &mut PlaylistItem,
    namespace: &[u8; IDENTITY_NAMESPACE_BYTES],
    counter: &mut u64,
) -> Result<(), ExecuteError> {
    item.item_incarnation_id =
        allocate_authoritative_identity('i', namespace, counter, "item_incarnation_id_exhausted")?;
    clear_committed_artifact(item, true);
    item.cache_status = "pending".to_owned();
    item.cache_progress = 0.0;
    Ok(())
}

fn validate_time(value: f64, field: &str) -> Result<(), ExecuteError> {
    if !value.is_finite() || value < 0.0 {
        return Err(rejected(
            "invalid_time",
            format!("{field} must be finite and non-negative"),
        ));
    }
    Ok(())
}

fn normalize_session_user_name(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(MAX_SESSION_USER_NAME_CHARS)
        .collect()
}

fn validate_session_users(users: &[String]) -> Result<(), ExecuteError> {
    if users.len() > MAX_SESSION_USERS {
        return Err(rejected("too_many_session_users", "too many session users"));
    }
    let mut seen = HashSet::with_capacity(users.len());
    for user in users {
        if user != &normalize_session_user_name(user) || user.is_empty() {
            return Err(rejected(
                "invalid_session_user",
                "session user is not normalized",
            ));
        }
        if !seen.insert(user.as_str()) {
            return Err(rejected("duplicate_session_user", "duplicate session user"));
        }
    }
    Ok(())
}

fn validate_audio_variants(variants: &[Map<String, Value>]) -> Result<(), ExecuteError> {
    if variants.len() > 1_024 {
        return Err(rejected(
            "too_many_audio_variants",
            "too many audio variants",
        ));
    }
    for variant in variants {
        let encoded = serde_json::to_vec(variant)
            .map_err(|_| rejected("invalid_audio_variant", "audio variant is not serializable"))?;
        if encoded.len() > MAX_STRING_BYTES {
            return Err(rejected(
                "invalid_audio_variant",
                "audio variant is too large",
            ));
        }
    }
    Ok(())
}

fn valid_cache_relative_path(value: &str) -> bool {
    if !valid_string(value, MAX_STRING_BYTES, false) {
        return false;
    }
    let normalized = value.trim().replace('\\', "/");
    let path = Path::new(&normalized);
    !normalized.is_empty()
        && !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

fn decode_cache_url_path(value: &str) -> Option<String> {
    fn hex(value: u8) -> Option<u8> {
        match value {
            b'0'..=b'9' => Some(value - b'0'),
            b'a'..=b'f' => Some(value - b'a' + 10),
            b'A'..=b'F' => Some(value - b'A' + 10),
            _ => None,
        }
    }

    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%'
            && index + 2 < bytes.len()
            && let (Some(high), Some(low)) = (hex(bytes[index + 1]), hex(bytes[index + 2]))
        {
            decoded.push((high << 4) | low);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).ok()
}

fn cache_media_path(value: &str) -> Option<String> {
    let without_query = value.split(['?', '#']).next().unwrap_or(value);
    if let Some(relative) = without_query.strip_prefix("/media/") {
        return decode_cache_url_path(relative);
    }
    if let Some(relative) = without_query.strip_prefix("media/") {
        return decode_cache_url_path(relative);
    }
    let parsed = url::Url::parse(value).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return None;
    }
    parsed
        .path()
        .strip_prefix("/media/")
        .and_then(decode_cache_url_path)
}

fn valid_cache_media_url(value: &str) -> bool {
    if !valid_string(value, MAX_STRING_BYTES, false) {
        return false;
    }
    cache_media_path(value).is_some_and(|relative| {
        !relative.is_empty()
            && !relative
                .split('/')
                .any(|segment| segment.eq_ignore_ascii_case("%2e%2e"))
            && valid_cache_relative_path(&relative)
    })
}

fn valid_artifact_file_path(value: &str, artifact_directory: &str) -> bool {
    if !valid_cache_relative_path(value) {
        return false;
    }
    let normalized = value.trim().replace('\\', "/");
    let path = Path::new(&normalized);
    path.parent()
        .is_some_and(|parent| parent.to_string_lossy().replace('\\', "/") == artifact_directory)
        && path.file_name().is_some_and(|name| {
            let name = name.to_string_lossy();
            !name.is_empty() && !name.starts_with('.')
        })
}

fn validate_ready_audio_variants(
    variants: &[Map<String, Value>],
    artifact_directory: &str,
    seen_paths: &mut HashSet<String>,
) -> Result<Vec<String>, ExecuteError> {
    if variants.is_empty() {
        return Err(rejected(
            "invalid_cache_ready",
            "ready cache projection requires at least one audio variant",
        ));
    }
    validate_audio_variants(variants)?;
    let mut ids = Vec::with_capacity(variants.len());
    let mut seen = HashSet::with_capacity(variants.len());
    for variant in variants {
        let Some(id) = variant.get("id").and_then(Value::as_str) else {
            return Err(rejected(
                "invalid_cache_ready",
                "ready audio variant id must be a string",
            ));
        };
        let Some(audio_url) = variant.get("audio_url").and_then(Value::as_str) else {
            return Err(rejected(
                "invalid_cache_ready",
                "ready audio variant URL must be a string",
            ));
        };
        if id.trim().is_empty() || !valid_string(id, MAX_STRING_BYTES, false) {
            return Err(rejected(
                "invalid_cache_ready",
                "ready audio variant id is invalid",
            ));
        }
        if !seen.insert(id.to_owned()) {
            return Err(rejected(
                "duplicate_audio_variant_id",
                "ready audio variant ids must be unique",
            ));
        }
        if !valid_cache_media_url(audio_url) {
            return Err(rejected(
                "invalid_cache_ready",
                "ready audio variant URL is invalid",
            ));
        }
        let Some(relative_path) = cache_media_path(audio_url) else {
            return Err(rejected(
                "invalid_cache_ready",
                "ready audio variant URL is invalid",
            ));
        };
        if !valid_artifact_file_path(&relative_path, artifact_directory) {
            return Err(rejected(
                "invalid_cache_ready",
                "ready audio variant is outside its immutable artifact set",
            ));
        }
        if !seen_paths.insert(relative_path) {
            return Err(rejected(
                "duplicate_artifact_path",
                "ready cache descriptor paths must be unique",
            ));
        }
        ids.push(id.to_owned());
    }
    Ok(ids)
}

fn validate_item(item: &PlaylistItem) -> Result<(), ExecuteError> {
    if !valid_string(&item.id, MAX_ITEM_ID_BYTES, false) {
        return Err(rejected("invalid_item", "playlist item id is invalid"));
    }
    for value in [
        &item.original_url,
        &item.resolved_url,
        &item.bvid,
        &item.title,
        &item.part_title,
        &item.display_title,
        &item.cover_url,
        &item.embed_url,
        &item.selected_audio_variant_id,
        &item.owner_name,
        &item.owner_url,
        &item.requester_name,
        &item.cache_status,
        &item.cache_message,
        &item.video_relative_path,
        &item.video_media_url,
        &item.item_incarnation_id,
        &item.artifact_set_id,
        &item.artifact_relative_directory,
    ] {
        if !valid_string(value, MAX_STRING_BYTES, true) {
            return Err(rejected("invalid_item", "playlist item string is invalid"));
        }
    }
    if !item.item_incarnation_id.is_empty()
        && !valid_authoritative_identity(&item.item_incarnation_id, 'i')
    {
        return Err(rejected(
            "invalid_item",
            "playlist item incarnation identity is invalid",
        ));
    }
    if item.artifact_set_id.is_empty() != item.artifact_relative_directory.is_empty()
        || (!item.artifact_set_id.is_empty()
            && (!valid_authoritative_identity(&item.artifact_set_id, 'a')
                || !valid_artifact_relative_directory(
                    &item.artifact_relative_directory,
                    &item.item_incarnation_id,
                    &item.artifact_set_id,
                )))
    {
        return Err(rejected(
            "invalid_item",
            "playlist item artifact identity is invalid",
        ));
    }
    if item.aid < 0
        || item.cid < 0
        || item.owner_mid < 0
        || item.page <= 0
        || item.video_page <= 0
        || !item.cache_progress.is_finite()
        || !matches!(
            item.queue_slot_type.as_str(),
            "cycle" | "priority" | "manual"
        )
    {
        return Err(rejected(
            "invalid_item",
            "playlist item numeric or slot data is invalid",
        ));
    }
    if item.selected_pages.len() > 256
        || item.selected_cids.len() > 256
        || item.selected_durations.len() > 256
        || item.selected_parts.len() > 256
        || item.available_pages.len() > 256
        || item.available_cids.len() > 256
        || item.available_durations.len() > 256
        || item.available_parts.len() > 256
    {
        return Err(rejected(
            "invalid_item",
            "playlist item page data is too large",
        ));
    }
    if item
        .selected_parts
        .iter()
        .chain(item.available_parts.iter())
        .any(|value| !valid_string(value, MAX_STRING_BYTES, true))
    {
        return Err(rejected(
            "invalid_item",
            "playlist item part label is invalid",
        ));
    }
    validate_audio_variants(&item.audio_variants)
}

fn validate_history_entry(entry: &HistoryEntry) -> Result<(), ExecuteError> {
    validate_time(entry.requested_at, "history requested_at")?;
    if entry.request_count == 0 {
        return Err(rejected(
            "invalid_history",
            "history request_count must be positive",
        ));
    }
    for value in [
        &entry.key,
        &entry.display_title,
        &entry.original_url,
        &entry.resolved_url,
        &entry.title,
        &entry.part_title,
        &entry.owner_name,
        &entry.owner_url,
        &entry.requester_name,
    ] {
        if !valid_string(value, MAX_STRING_BYTES, true) {
            return Err(rejected("invalid_history", "history string is invalid"));
        }
    }
    if entry.owner_mid < 0 {
        return Err(rejected("invalid_history", "history owner id is invalid"));
    }
    Ok(())
}

fn validate_session_played_entry(entry: &SessionPlayedEntry) -> Result<(), ExecuteError> {
    validate_time(entry.played_at, "session played_at")?;
    if let Some(ended_at) = entry.ended_at {
        validate_time(ended_at, "session ended_at")?;
    }
    if !valid_string(&entry.item_id, MAX_ITEM_ID_BYTES, false)
        || entry.aid < 0
        || entry.cid < 0
        || entry.owner_mid < 0
        || entry.page <= 0
    {
        return Err(rejected(
            "invalid_session_played",
            "session played entry is invalid",
        ));
    }
    for value in [
        &entry.key,
        &entry.display_title,
        &entry.title,
        &entry.part_title,
        &entry.original_url,
        &entry.resolved_url,
        &entry.bvid,
        &entry.owner_name,
        &entry.owner_url,
        &entry.requester_name,
        &entry.cover_url,
    ] {
        if !valid_string(value, MAX_STRING_BYTES, true) {
            return Err(rejected(
                "invalid_session_played",
                "session played string is invalid",
            ));
        }
    }
    Ok(())
}

fn validate_archive(archive: &SessionArchiveSeed) -> Result<(), ExecuteError> {
    if !valid_string(&archive.file_name, MAX_STRING_BYTES, false)
        || archive.file_name.contains('/')
        || archive.file_name.contains('\\')
    {
        return Err(rejected(
            "invalid_session_archive",
            "session archive filename is invalid",
        ));
    }
    validate_time(archive.session_started_at, "session_started_at")?;
    if archive.items.len() > MAX_ITEMS {
        return Err(rejected(
            "too_many_items",
            "too many session played entries",
        ));
    }
    for entry in &archive.items {
        validate_session_played_entry(entry)?;
    }
    Ok(())
}

fn validate_item_collection(
    current_item: Option<&PlaylistItem>,
    playlist: &[PlaylistItem],
) -> Result<(), ExecuteError> {
    if playlist.len() + usize::from(current_item.is_some()) > MAX_ITEMS {
        return Err(rejected("too_many_items", "too many playlist items"));
    }
    let mut ids = HashSet::with_capacity(playlist.len() + 1);
    if let Some(item) = current_item {
        validate_item(item)?;
        ids.insert(item.id.as_str());
    }
    for item in playlist {
        validate_item(item)?;
        if !ids.insert(item.id.as_str()) {
            return Err(rejected("duplicate_item_id", "duplicate playlist item id"));
        }
    }
    Ok(())
}

fn validate_backup(backup: &BackupSeed) -> Result<(), ExecuteError> {
    validate_time(backup.updated_at, "backup updated_at")?;
    validate_item_collection(backup.current_item.as_ref(), &backup.playlist)?;
    if let Some(archive) = &backup.played_session {
        validate_archive(archive)?;
    }
    Ok(())
}

fn validate_seed(seed: &AppStateSeed) -> Result<(), ExecuteError> {
    validate_time(seed.updated_at, "updated_at")?;
    validate_time(seed.session_started_at, "session_started_at")?;
    if !valid_string(&seed.playback_mode, MAX_STRING_BYTES, false)
        || !valid_string(&seed.session_played_file, MAX_STRING_BYTES, false)
    {
        return Err(rejected(
            "invalid_initial_state",
            "initial state string is invalid",
        ));
    }
    if seed.session_played_file.contains('/') || seed.session_played_file.contains('\\') {
        return Err(rejected(
            "invalid_initial_state",
            "session played filename must be a basename",
        ));
    }
    if seed.player_settings.volume_percent < 0
        || seed.player_settings.volume_percent > MAX_VOLUME_PERCENT
        || seed.player_settings.song_advance_delay_seconds < 0
        || seed.player_settings.song_advance_delay_seconds > MAX_SONG_ADVANCE_DELAY_SECONDS
        || seed.player_settings.key_shift < MIN_KEY_SHIFT
        || seed.player_settings.key_shift > MAX_KEY_SHIFT
    {
        return Err(rejected(
            "invalid_initial_state",
            "player settings are out of range",
        ));
    }
    let av_state = AvDelayState {
        global_delay_ms: seed.player_settings.global_av_delay_ms,
        local_delay_ms: seed.player_settings.local_av_delay_ms,
        locked: seed.player_settings.av_delay_locked,
    };
    let effective_delay = i64::from(seed.player_settings.global_av_delay_ms)
        + i64::from(seed.player_settings.local_av_delay_ms);
    if !(-i64::from(bilikara_rust::MAX_AV_DELAY_MS)..=i64::from(bilikara_rust::MAX_AV_DELAY_MS))
        .contains(&effective_delay)
        || !(-bilikara_rust::MAX_AV_DELAY_MS..=bilikara_rust::MAX_AV_DELAY_MS)
            .contains(&av_state.global_delay_ms)
        || !(-(bilikara_rust::MAX_AV_DELAY_MS * 2)..=(bilikara_rust::MAX_AV_DELAY_MS * 2))
            .contains(&av_state.local_delay_ms)
    {
        return Err(rejected(
            "invalid_initial_state",
            "AV delay state is out of range",
        ));
    }
    validate_item_collection(seed.current_item.as_ref(), &seed.playlist)?;
    if seed.history.len() > MAX_ITEMS
        || seed.session_history.len() > MAX_ITEMS
        || seed.session_played.len() > MAX_ITEMS
    {
        return Err(rejected(
            "too_many_items",
            "history or session state is too large",
        ));
    }
    for entry in seed.history.iter().chain(seed.session_history.iter()) {
        validate_history_entry(entry)?;
    }
    for entry in &seed.session_played {
        validate_session_played_entry(entry)?;
    }
    validate_session_users(&seed.session_users)?;
    if let Some(previous) = &seed.previous_session {
        validate_archive(previous)?;
    }
    if let Some(backup) = &seed.backup {
        validate_backup(backup)?;
    }
    Ok(())
}

impl AppStateData {
    fn from_seed(
        mut seed: AppStateSeed,
        namespace: &[u8; IDENTITY_NAMESPACE_BYTES],
        next_item_incarnation_id: &mut u64,
    ) -> Result<Self, ExecuteError> {
        if let Some(item) = seed.current_item.as_mut() {
            assign_new_item_incarnation(item, namespace, next_item_incarnation_id)?;
        }
        for item in &mut seed.playlist {
            assign_new_item_incarnation(item, namespace, next_item_incarnation_id)?;
        }
        validate_seed(&seed)?;
        Ok(Self {
            revision: 1,
            session_generation: 1,
            playback_generation: 1,
            playback_mode: seed.playback_mode,
            player_settings: seed.player_settings,
            current_item: seed.current_item,
            current_item_started: seed.current_item_started,
            playlist: seed.playlist,
            history: seed.history,
            session_history: seed.session_history,
            session_users: seed.session_users,
            session_started_at: seed.session_started_at,
            session_played_file: seed.session_played_file,
            session_played: seed.session_played,
            previous_session: seed
                .previous_session
                .filter(|entry| !entry.items.is_empty()),
            backup: seed
                .backup
                .filter(|entry| entry.current_item.is_some() || !entry.playlist.is_empty()),
            updated_at: seed.updated_at,
            active_cache_attempts: HashMap::new(),
        })
    }

    fn current_identity(&self) -> Option<&str> {
        self.current_item.as_ref().map(|item| item.id.as_str())
    }

    fn find_item(&self, item_id: &str) -> Option<&PlaylistItem> {
        self.current_item
            .as_ref()
            .filter(|item| item.id == item_id)
            .or_else(|| self.playlist.iter().find(|item| item.id == item_id))
    }

    fn find_item_mut(&mut self, item_id: &str) -> Option<&mut PlaylistItem> {
        if self
            .current_item
            .as_ref()
            .is_some_and(|item| item.id == item_id)
        {
            return self.current_item.as_mut();
        }
        self.playlist.iter_mut().find(|item| item.id == item_id)
    }

    fn av_snapshot(&self) -> AvDelaySnapshot {
        let state = AvDelayState {
            global_delay_ms: self.player_settings.global_av_delay_ms,
            local_delay_ms: self.player_settings.local_av_delay_ms,
            locked: self.player_settings.av_delay_locked,
        };
        let decision = bilikara_rust::decide_av_delay(state, AvDelayAction::Adjust { delta_ms: 0 });
        AvDelaySnapshot {
            schema_version: SCHEMA_VERSION,
            global_delay_ms: decision.state.global_delay_ms,
            local_delay_ms: decision.state.local_delay_ms,
            effective_delay_ms: decision.effective_delay_ms,
            locked: decision.state.locked,
            has_local_adjustment: decision.has_local_adjustment,
            lock_button_enabled: decision.lock_button_enabled,
        }
    }

    fn backup_summary(&self) -> BackupSummary {
        let Some(backup) = &self.backup else {
            return BackupSummary {
                available: false,
                playlist_count: None,
                updated_at: None,
                preview_titles: Vec::new(),
                playback_mode: None,
            };
        };
        let mut preview_titles = Vec::new();
        if let Some(current) = &backup.current_item
            && !current.display_title.is_empty()
        {
            preview_titles.push(current.display_title.clone());
        }
        preview_titles.extend(
            backup
                .playlist
                .iter()
                .take(3)
                .filter(|item| !item.display_title.is_empty())
                .map(|item| item.display_title.clone()),
        );
        preview_titles.truncate(3);
        BackupSummary {
            available: true,
            playlist_count: Some(
                backup.playlist.len() + usize::from(backup.current_item.is_some()),
            ),
            updated_at: Some(backup.updated_at),
            preview_titles,
            playback_mode: Some(self.playback_mode.clone()),
        }
    }

    fn snapshot(&self) -> AppSnapshot {
        let av_delay = self.av_snapshot();
        AppSnapshot {
            schema_version: SCHEMA_VERSION,
            revision: self.revision,
            session_generation: self.session_generation,
            playback_generation: self.playback_generation,
            playback_mode: self.playback_mode.clone(),
            player_settings: PlayerSettingsSnapshot {
                av_offset_ms: av_delay.effective_delay_ms,
                av_delay,
                volume_percent: self.player_settings.volume_percent,
                is_muted: self.player_settings.is_muted,
                song_advance_delay_seconds: self.player_settings.song_advance_delay_seconds,
                key_shift: self.player_settings.key_shift,
            },
            current_item: self.current_item.clone(),
            current_item_started: self.current_item_started,
            playlist: self.playlist.clone(),
            history: self.history.clone(),
            session_history: self.session_history.clone(),
            session_users: self.session_users.clone(),
            session_played: self.session_played.clone(),
            updated_at: self.updated_at,
            backup: self.backup_summary(),
            previous_session: PreviousSessionSummary {
                available: self.previous_session.is_some(),
                item_count: self
                    .previous_session
                    .as_ref()
                    .map(|entry| entry.items.len()),
            },
        }
    }

    fn persistence_snapshot(&self) -> PersistenceSnapshot {
        PersistenceSnapshot {
            playback_mode: self.playback_mode.clone(),
            player_settings: self.player_settings.clone(),
            history: self.history.clone(),
            session_users: self.session_users.clone(),
            session_started_at: self.session_started_at,
            session_played_file: self.session_played_file.clone(),
            session_played: self.session_played.clone(),
            backup: self.backup.clone(),
            updated_at: self.updated_at,
        }
    }
}

fn playlist_identity(item: &PlaylistItem) -> Result<PlaylistIdentity, ExecuteError> {
    let aid = u64::try_from(item.aid)
        .map_err(|_| rejected("invalid_item", "playlist item aid is invalid"))?;
    let video_page = usize::try_from(item.page)
        .map_err(|_| rejected("invalid_item", "playlist item page is invalid"))?;
    Ok(PlaylistIdentity {
        bvid: item.bvid.clone(),
        aid,
        video_page,
        selected_audio_pages: item.selected_pages.clone(),
    })
}

fn duplicate_decision(
    data: &AppStateData,
    candidate: &PlaylistItem,
    include_active: bool,
    history: &[HistoryEntry],
) -> Result<bilikara_rust::PlaylistDuplicateDecision, ExecuteError> {
    let current_item = if include_active {
        data.current_item
            .as_ref()
            .map(|item| {
                Ok(DuplicateActiveItem {
                    original_index: 0,
                    item_id: item.id.clone(),
                    identity: playlist_identity(item)?,
                })
            })
            .transpose()?
    } else {
        None
    };
    let queued_items = if include_active {
        data.playlist
            .iter()
            .enumerate()
            .map(|(index, item)| {
                Ok(DuplicateActiveItem {
                    original_index: index + 1,
                    item_id: item.id.clone(),
                    identity: playlist_identity(item)?,
                })
            })
            .collect::<Result<Vec<_>, ExecuteError>>()?
    } else {
        Vec::new()
    };
    let history_entries = history
        .iter()
        .enumerate()
        .map(|(index, entry)| DuplicateHistoryEntry {
            original_index: index,
            key: entry.key.clone(),
        })
        .collect();
    decide_playlist_duplicate(PlaylistDuplicateRequest {
        candidate: playlist_identity(candidate)?,
        current_item,
        queued_items,
        history_entries,
    })
    .map_err(|error| {
        rejected(
            "playlist_policy_failed",
            format!("playlist duplicate policy rejected input: {error:?}"),
        )
    })
}

fn slot_type(value: &str) -> Result<PlaylistSlotType, ExecuteError> {
    match value {
        "cycle" => Ok(PlaylistSlotType::Cycle),
        "priority" => Ok(PlaylistSlotType::Priority),
        "manual" => Ok(PlaylistSlotType::Manual),
        _ => Err(rejected("invalid_slot_type", "invalid playlist slot type")),
    }
}

fn rebuild_playlist_order(
    data: &mut AppStateData,
    candidate: Option<PlaylistItem>,
) -> Result<(), ExecuteError> {
    let operation = if candidate.is_some() {
        PlaylistOrderOperation::InsertCycle
    } else {
        PlaylistOrderOperation::Rebuild
    };
    let items = data
        .playlist
        .iter()
        .enumerate()
        .map(|(index, item)| {
            Ok(PlaylistOrderItem {
                original_index: index,
                item_id: item.id.clone(),
                requester_name: normalize_session_user_name(&item.requester_name),
                slot_type: slot_type(&item.queue_slot_type)?,
            })
        })
        .collect::<Result<Vec<_>, ExecuteError>>()?;
    let candidate_descriptor = candidate
        .as_ref()
        .map(|item| {
            Ok(PlaylistOrderItem {
                original_index: items.len(),
                item_id: item.id.clone(),
                requester_name: normalize_session_user_name(&item.requester_name),
                slot_type: slot_type(&item.queue_slot_type)?,
            })
        })
        .transpose()?;
    let plan = plan_playlist_order(PlaylistOrderRequest {
        operation,
        session_users: data.session_users.clone(),
        current_requester: data
            .current_item
            .as_ref()
            .map(|item| normalize_session_user_name(&item.requester_name)),
        items,
        candidate: candidate_descriptor,
    })
    .map_err(|error| {
        rejected(
            "playlist_policy_failed",
            format!("playlist order policy rejected input: {error:?}"),
        )
    })?;
    let mut objects = HashMap::with_capacity(data.playlist.len() + 1);
    for item in data.playlist.drain(..) {
        objects.insert(item.id.clone(), item);
    }
    if let Some(item) = candidate
        && objects.insert(item.id.clone(), item).is_some()
    {
        return Err(rejected(
            "duplicate_item_id",
            "playlist candidate id already exists",
        ));
    }
    if plan.ordered_ids.len() != objects.len() {
        return Err(ExecuteError::Internal(
            "playlist policy violated object conservation".to_owned(),
        ));
    }
    let mut rebuilt = Vec::with_capacity(objects.len());
    for item_id in plan.ordered_ids {
        let item = objects.remove(&item_id).ok_or_else(|| {
            ExecuteError::Internal("playlist policy returned an unknown item id".to_owned())
        })?;
        rebuilt.push(item);
    }
    if !objects.is_empty() {
        return Err(ExecuteError::Internal(
            "playlist policy omitted an item".to_owned(),
        ));
    }
    data.playlist = rebuilt;
    Ok(())
}

fn history_entry_from_item(item: &PlaylistItem, key: String, now: f64) -> HistoryEntry {
    HistoryEntry {
        key,
        display_title: item.display_title.clone(),
        original_url: item.original_url.clone(),
        resolved_url: item.resolved_url.clone(),
        requested_at: now,
        title: item.title.clone(),
        part_title: item.part_title.clone(),
        owner_mid: item.owner_mid,
        owner_name: item.owner_name.clone(),
        owner_url: item.owner_url.clone(),
        requester_name: item.requester_name.clone(),
        request_count: 1,
    }
}

fn record_history(
    data: &AppStateData,
    history: &mut Vec<HistoryEntry>,
    item: &PlaylistItem,
    now: f64,
) -> Result<(), ExecuteError> {
    let decision = duplicate_decision(data, item, false, history)?;
    let mut entry = history_entry_from_item(item, decision.identity_key, now);
    if let Some(index) = decision.history_duplicate_index {
        let previous = history.remove(index);
        entry.request_count = previous.request_count.saturating_add(1);
    }
    history.insert(0, entry);
    Ok(())
}

fn record_session_played(
    data: &mut AppStateData,
    item: &PlaylistItem,
    now: f64,
) -> Result<(), ExecuteError> {
    let key = duplicate_decision(data, item, false, &[])?.identity_key;
    data.session_played.push(SessionPlayedEntry {
        key,
        item_id: item.id.clone(),
        display_title: item.display_title.clone(),
        title: item.title.clone(),
        part_title: item.part_title.clone(),
        original_url: item.original_url.clone(),
        resolved_url: item.resolved_url.clone(),
        bvid: item.bvid.clone(),
        aid: item.aid,
        cid: item.cid,
        page: item.page,
        played_at: now,
        ended_at: None,
        owner_mid: item.owner_mid,
        owner_name: item.owner_name.clone(),
        owner_url: item.owner_url.clone(),
        requester_name: item.requester_name.clone(),
        cover_url: item.cover_url.clone(),
        threshold_reached: false,
    });
    Ok(())
}

fn mark_session_played_ended(data: &mut AppStateData, item_id: &str, now: f64) {
    if let Some(entry) = data
        .session_played
        .iter_mut()
        .rev()
        .find(|entry| entry.item_id == item_id && entry.ended_at.is_none())
    {
        entry.ended_at = Some(now);
    }
}

fn archive_current(data: &mut AppStateData, now: f64) -> Result<(), ExecuteError> {
    let Some(item) = data.current_item.clone() else {
        return Ok(());
    };
    mark_session_played_ended(data, &item.id, now);
    if !data.current_item_started {
        return Ok(());
    }
    let state_for_policy = data.clone();
    record_history(&state_for_policy, &mut data.session_history, &item, now)?;
    record_history(&state_for_policy, &mut data.history, &item, now)?;
    Ok(())
}

fn apply_av_delay(data: &mut AppStateData, action: &AvDelayCommand) -> AvDelaySnapshot {
    let state = AvDelayState {
        global_delay_ms: data.player_settings.global_av_delay_ms,
        local_delay_ms: data.player_settings.local_av_delay_ms,
        locked: data.player_settings.av_delay_locked,
    };
    let decision = match action {
        AvDelayCommand::Snapshot => decide_av_delay(state, AvDelayAction::Adjust { delta_ms: 0 }),
        AvDelayCommand::SetEffective { effective_delay_ms } => decide_av_delay(
            state,
            AvDelayAction::SetEffective {
                effective_delay_ms: *effective_delay_ms,
            },
        ),
        AvDelayCommand::SetPersistent { effective_delay_ms } => decide_av_delay(
            state,
            AvDelayAction::SetPersistent {
                effective_delay_ms: *effective_delay_ms,
            },
        ),
        AvDelayCommand::Adjust { delta_ms } => decide_av_delay(
            state,
            AvDelayAction::Adjust {
                delta_ms: *delta_ms,
            },
        ),
        AvDelayCommand::ResetLocal => decide_av_delay(state, AvDelayAction::ResetLocal),
        AvDelayCommand::ToggleLock => decide_av_delay(state, AvDelayAction::ToggleLock),
    };
    data.player_settings.global_av_delay_ms = decision.state.global_delay_ms;
    data.player_settings.local_av_delay_ms = decision.state.local_delay_ms;
    data.player_settings.av_delay_locked = decision.state.locked;
    AvDelaySnapshot {
        schema_version: SCHEMA_VERSION,
        global_delay_ms: decision.state.global_delay_ms,
        local_delay_ms: decision.state.local_delay_ms,
        effective_delay_ms: decision.effective_delay_ms,
        locked: decision.state.locked,
        has_local_adjustment: decision.has_local_adjustment,
        lock_button_enabled: decision.lock_button_enabled,
    }
}

fn reset_local_av_delay(data: &mut AppStateData) {
    let _ = apply_av_delay(data, &AvDelayCommand::ResetLocal);
}

fn sanitize_backup_item(mut item: PlaylistItem) -> PlaylistItem {
    item.cache_status = "pending".to_owned();
    item.cache_progress = 0.0;
    item.cache_message = "待缓存".to_owned();
    item.item_incarnation_id.clear();
    clear_committed_artifact(&mut item, true);
    item
}

fn update_backup_from_state(data: &mut AppStateData) {
    if data.current_item.is_none() && data.playlist.is_empty() {
        data.backup = None;
        return;
    }
    data.backup = Some(BackupSeed {
        current_item: data.current_item.clone().map(sanitize_backup_item),
        playlist: data
            .playlist
            .clone()
            .into_iter()
            .map(sanitize_backup_item)
            .collect(),
        played_session: Some(SessionArchiveSeed {
            file_name: data.session_played_file.clone(),
            session_started_at: data.session_started_at,
            items: data.session_played.clone(),
        }),
        updated_at: data.updated_at,
    });
}

fn current_changed(before: Option<&str>, after: Option<&str>) -> bool {
    before != after
}

fn mutation_value(changed: bool) -> Value {
    json!({"changed": changed})
}

fn apply_item_patch(item: &mut PlaylistItem, patch: &PlaylistItemPatch) {
    macro_rules! replace {
        ($field:ident) => {
            if let Some(value) = &patch.$field {
                item.$field = value.clone();
            }
        };
    }
    replace!(title);
    replace!(part_title);
    replace!(display_title);
    replace!(cover_url);
    replace!(embed_url);
    replace!(owner_mid);
    replace!(owner_name);
    replace!(owner_url);
}

fn variant_id(page: i64, label: &str, index: usize) -> String {
    let mut normalized = String::new();
    let mut previous_separator = false;
    for character in label.to_lowercase().chars() {
        if character.is_ascii_lowercase() || character.is_ascii_digit() {
            normalized.push(character);
            previous_separator = false;
        } else if !previous_separator && !normalized.is_empty() {
            normalized.push('_');
            previous_separator = true;
        }
    }
    while normalized.ends_with('_') {
        normalized.pop();
    }
    let suffix = if normalized.is_empty() {
        format!("track_{}", index + 1)
    } else {
        normalized
    };
    format!("p{}_{}", page.max(1), suffix)
}

fn predicted_audio_variant_ids(item: &PlaylistItem) -> HashSet<String> {
    item.selected_parts
        .iter()
        .enumerate()
        .filter_map(|(index, label)| {
            let label = label.trim();
            if label.is_empty() {
                return None;
            }
            let page = item
                .selected_pages
                .get(index)
                .copied()
                .unwrap_or(index as i64 + 1);
            Some(variant_id(page, label, index))
        })
        .collect()
}

fn duplicate_result(data: &AppStateData, item: &PlaylistItem) -> Result<Value, ExecuteError> {
    validate_item(item)?;
    let active = duplicate_decision(data, item, true, &[])?;
    let session = duplicate_decision(data, item, false, &data.session_history)?;
    let active_item = active
        .active_duplicate_id
        .as_deref()
        .and_then(|item_id| data.find_item(item_id))
        .cloned();
    let session_entry = session
        .history_duplicate_index
        .and_then(|index| data.session_history.get(index))
        .cloned();
    Ok(json!({
        "identity_key": active.identity_key,
        "active_item": active_item,
        "session_entry": session_entry,
    }))
}

fn duplicate_rejection_details(
    data: &AppStateData,
    item: &PlaylistItem,
) -> Result<Option<Value>, ExecuteError> {
    let result = duplicate_result(data, item)?;
    let active = result.get("active_item").filter(|value| !value.is_null());
    let session = result.get("session_entry").filter(|value| !value.is_null());
    if active.is_none() && session.is_none() {
        return Ok(None);
    }
    Ok(Some(result))
}

fn replace_session_archive(data: &mut AppStateData, archive: &SessionArchiveSeed) {
    data.session_started_at = archive.session_started_at;
    data.session_played_file.clone_from(&archive.file_name);
    data.session_played.clone_from(&archive.items);
}

fn reset_current_identity(data: &mut AppStateData) {
    data.current_item = None;
    data.current_item_started = false;
    data.playlist.clear();
}

fn increment_session_generation(data: &mut AppStateData) -> Result<(), ExecuteError> {
    data.session_generation = data
        .session_generation
        .checked_add(1)
        .ok_or_else(|| ExecuteError::Internal("AppState session generation overflow".to_owned()))?;
    Ok(())
}

fn terminal_cache_event(event: &CacheEvent) -> bool {
    matches!(
        event,
        CacheEvent::Ready { .. }
            | CacheEvent::Failed { .. }
            | CacheEvent::Cancelled { .. }
            | CacheEvent::Evicted { .. }
            | CacheEvent::Reset { .. }
    )
}

fn validate_cache_attempt_ownership(
    data: &AppStateData,
    item_id: &str,
    cache_attempt_token: u64,
    issued_through: u64,
) -> Result<ActiveCacheAttempt, ExecuteError> {
    if cache_attempt_token == 0 {
        return Err(rejected(
            "invalid_cache_attempt_token",
            "cache attempt token must be positive",
        ));
    }
    if cache_attempt_token > issued_through {
        return Err(rejected_with_details(
            "unissued_cache_attempt_token",
            "cache attempt token has not been issued",
            json!({
                "cache_attempt_token": cache_attempt_token,
                "issued_through": issued_through,
            }),
        ));
    }
    let belongs_to = data
        .active_cache_attempts
        .iter()
        .find_map(|(owner_item_id, attempt)| {
            (attempt.token == cache_attempt_token).then_some(owner_item_id.as_str())
        });
    if let Some(owner_item_id) = belongs_to
        && owner_item_id != item_id
    {
        return Err(rejected_with_details(
            "cache_attempt_wrong_item",
            "cache attempt belongs to a different live item",
            json!({
                "cache_attempt_token": cache_attempt_token,
                "item_id": item_id,
                "owner_item_id": owner_item_id,
            }),
        ));
    }
    let Some(active) = data.active_cache_attempts.get(item_id).cloned() else {
        return Err(rejected_with_details(
            "cache_attempt_not_active",
            "cache attempt does not own this live item",
            json!({
                "cache_attempt_token": cache_attempt_token,
                "item_id": item_id,
            }),
        ));
    };
    if active.token != cache_attempt_token {
        return Err(rejected_with_details(
            "cache_attempt_superseded",
            "cache attempt has been superseded",
            json!({
                "cache_attempt_token": cache_attempt_token,
                "active_cache_attempt_token": active.token,
                "item_id": item_id,
            }),
        ));
    }
    if data.find_item(item_id).is_none() {
        return Err(rejected(
            "cache_attempt_item_removed",
            "cache attempt item no longer exists",
        ));
    }
    Ok(active)
}

fn validate_cache_publication_reservation(
    active: &ActiveCacheAttempt,
    item_incarnation_id: &str,
    artifact_set_id: &str,
    artifact_relative_directory: &str,
) -> Result<(), ExecuteError> {
    let reservation = &active.reservation;
    if item_incarnation_id != reservation.item_incarnation_id
        || artifact_set_id != reservation.artifact_set_id
        || artifact_relative_directory != reservation.artifact_relative_directory
    {
        return Err(rejected(
            "cache_publication_identity_mismatch",
            "cache publication does not match its Rust reservation",
        ));
    }
    if !valid_authoritative_identity(item_incarnation_id, 'i')
        || !valid_authoritative_identity(artifact_set_id, 'a')
        || !valid_artifact_relative_directory(
            artifact_relative_directory,
            item_incarnation_id,
            artifact_set_id,
        )
    {
        return Err(rejected(
            "invalid_cache_publication_identity",
            "cache publication identity is invalid",
        ));
    }
    Ok(())
}

fn apply_cache_event(
    data: &mut AppStateData,
    item_id: &str,
    cache_attempt_token: u64,
    issued_through: u64,
    event: &CacheEvent,
) -> Result<MutationResult, ExecuteError> {
    let active =
        validate_cache_attempt_ownership(data, item_id, cache_attempt_token, issued_through)?;
    if let Some(terminal_event) = active.terminal_event {
        if terminal_cache_event(event) && terminal_event == *event {
            return Ok(MutationResult::unchanged(json!({
                "applied": true,
                "replayed": true,
            })));
        }
        return Err(rejected_with_details(
            if terminal_cache_event(event) {
                "cache_terminal_conflict"
            } else {
                "cache_attempt_already_terminal"
            },
            "cache attempt is already terminal",
            json!({
                "cache_attempt_token": cache_attempt_token,
                "item_id": item_id,
            }),
        ));
    }
    let before = data
        .find_item(item_id)
        .cloned()
        .ok_or_else(|| rejected("item_not_found", "playlist item does not exist"))?;
    let ready_selected_audio_variant_id = match event {
        CacheEvent::Ready {
            progress,
            message,
            video_relative_path,
            video_media_url,
            audio_variants,
            selected_audio_variant_id,
            item_incarnation_id,
            artifact_set_id,
            artifact_relative_directory,
        } => {
            validate_cache_publication_reservation(
                &active,
                item_incarnation_id,
                artifact_set_id,
                artifact_relative_directory,
            )?;
            if !progress.is_finite()
                || !valid_string(message, MAX_STRING_BYTES, true)
                || !valid_cache_relative_path(video_relative_path)
                || !valid_cache_media_url(video_media_url)
                || !valid_string(selected_audio_variant_id, MAX_STRING_BYTES, true)
                || !valid_artifact_file_path(video_relative_path, artifact_relative_directory)
                || cache_media_path(video_media_url).as_deref()
                    != Some(video_relative_path.as_str())
            {
                return Err(rejected(
                    "invalid_cache_ready",
                    "ready cache projection is invalid",
                ));
            }
            let mut seen_paths = HashSet::from([video_relative_path.clone()]);
            let variant_ids = validate_ready_audio_variants(
                audio_variants,
                artifact_relative_directory,
                &mut seen_paths,
            )?;
            let current = before.selected_audio_variant_id.as_str();
            let proposal = selected_audio_variant_id.as_str();
            Some(
                variant_ids
                    .iter()
                    .find(|variant_id| variant_id.as_str() == current)
                    .or_else(|| {
                        variant_ids
                            .iter()
                            .find(|variant_id| variant_id.as_str() == proposal)
                    })
                    .unwrap_or(&variant_ids[0])
                    .clone(),
            )
        }
        _ => None,
    };
    let item = data
        .find_item_mut(item_id)
        .ok_or_else(|| rejected("item_not_found", "playlist item does not exist"))?;
    match event {
        CacheEvent::Queued { message } => {
            if !active.refresh {
                item.cache_status = "queued".to_owned();
            }
            item.cache_progress = 0.0;
            item.cache_message = message.clone();
        }
        CacheEvent::Started { message } => {
            if !active.refresh {
                item.cache_status = "downloading".to_owned();
            }
            item.cache_progress = 0.0;
            item.cache_message = message.clone();
            if !active.refresh {
                clear_committed_artifact(item, false);
            }
        }
        CacheEvent::Progress { progress, message } => {
            if !progress.is_finite() {
                return Err(rejected(
                    "invalid_cache_progress",
                    "cache progress must be finite",
                ));
            }
            if !active.refresh {
                item.cache_status = "downloading".to_owned();
            }
            item.cache_progress = progress.clamp(0.0, 100.0);
            if let Some(message) = message {
                item.cache_message.clone_from(message);
            }
        }
        CacheEvent::Ready {
            progress,
            message,
            video_relative_path,
            video_media_url,
            audio_variants,
            selected_audio_variant_id: _,
            item_incarnation_id: _,
            artifact_set_id,
            artifact_relative_directory,
        } => {
            item.cache_status = "ready".to_owned();
            item.cache_progress = progress.clamp(0.0, 100.0);
            item.cache_message.clone_from(message);
            item.video_relative_path.clone_from(video_relative_path);
            item.video_media_url.clone_from(video_media_url);
            item.audio_variants.clone_from(audio_variants);
            item.artifact_set_id.clone_from(artifact_set_id);
            item.artifact_relative_directory
                .clone_from(artifact_relative_directory);
            item.selected_audio_variant_id.clone_from(
                ready_selected_audio_variant_id.as_ref().ok_or_else(|| {
                    ExecuteError::Internal("validated Ready selection is missing".to_owned())
                })?,
            );
        }
        CacheEvent::Failed { message } => {
            if !active.refresh {
                item.cache_status = "failed".to_owned();
            }
            item.cache_message.clone_from(message);
        }
        CacheEvent::Cancelled { message } if active.refresh => {
            item.cache_message.clone_from(message);
        }
        CacheEvent::Cancelled { message }
        | CacheEvent::Evicted { message }
        | CacheEvent::Reset { message, .. } => {
            item.cache_status = "pending".to_owned();
            item.cache_progress = 0.0;
            item.cache_message.clone_from(message);
            clear_committed_artifact(
                item,
                matches!(
                    event,
                    CacheEvent::Reset {
                        clear_selected_audio_variant: true,
                        ..
                    }
                ),
            );
        }
    }
    validate_item(item)?;
    let changed = before != *item;
    let terminal = terminal_cache_event(event);
    if terminal {
        let active = data.active_cache_attempts.get_mut(item_id).ok_or_else(|| {
            ExecuteError::Internal("active cache attempt disappeared during apply".to_owned())
        })?;
        active.terminal_event = Some(event.clone());
    }
    let result = if changed {
        MutationResult::changed(json!({"applied": true, "replayed": false}), false)
    } else {
        MutationResult::unchanged(json!({"applied": true, "replayed": false}))
    };
    if terminal {
        Ok(result.with_operational_change())
    } else {
        Ok(result)
    }
}

fn apply_mutation(
    data: &mut AppStateData,
    request: AppStateRequest,
    issued_cache_attempt_tokens: u64,
    identity_namespace: &[u8; IDENTITY_NAMESPACE_BYTES],
    next_item_incarnation_id: &mut u64,
) -> Result<MutationResult, ExecuteError> {
    match request {
        AppStateRequest::AddItem {
            mut item,
            position,
            requester_name,
            reset_av_delay,
            allow_repeat,
            now,
            ..
        } => {
            validate_item(&item)?;
            if data.find_item(&item.id).is_some() {
                return Err(rejected(
                    "duplicate_item_id",
                    "playlist item id already exists",
                ));
            }
            let requester = normalize_session_user_name(&requester_name);
            if data.session_users.is_empty() {
                return Err(rejected(
                    "session_user_required",
                    "请先在服务端添加本场 KTV 用户",
                ));
            }
            let requester = if requester.is_empty() {
                data.session_users[0].clone()
            } else if data.session_users.contains(&requester) {
                requester
            } else {
                return Err(rejected(
                    "session_user_not_found",
                    "所选用户名不存在，请重新选择",
                ));
            };
            if !allow_repeat && let Some(details) = duplicate_rejection_details(data, &item)? {
                return Err(rejected_with_details(
                    "duplicate_session_request",
                    format!("本次已经点过《{}》", item.display_title),
                    details,
                ));
            }
            if !matches!(position.as_str(), "tail" | "next") {
                return Err(rejected("invalid_position", "playlist position is invalid"));
            }
            assign_new_item_incarnation(&mut item, identity_namespace, next_item_incarnation_id)?;
            item.requester_name = requester;
            item.queue_slot_type = if position == "next" {
                "priority".to_owned()
            } else {
                "cycle".to_owned()
            };
            if data.current_item.is_none() {
                data.previous_session = None;
                if reset_av_delay {
                    reset_local_av_delay(data);
                }
                record_session_played(data, &item, now)?;
                data.current_item = Some(item);
                data.current_item_started = false;
            } else if position == "next" {
                data.playlist.insert(0, item);
            } else {
                rebuild_playlist_order(data, Some(item))?;
            }
            Ok(MutationResult::changed(mutation_value(true), true))
        }
        AppStateRequest::UpdateItem {
            item_id,
            changes,
            persist_backup,
            ..
        } => {
            let item = data
                .find_item_mut(&item_id)
                .ok_or_else(|| rejected("item_not_found", "playlist item does not exist"))?;
            let before = item.clone();
            apply_item_patch(item, &changes);
            validate_item(item)?;
            if before == *item {
                return Ok(MutationResult::unchanged(mutation_value(false)));
            }
            Ok(MutationResult::changed(
                mutation_value(true),
                persist_backup,
            ))
        }
        AppStateRequest::RemoveItem { item_id, now, .. } => {
            if data
                .current_item
                .as_ref()
                .is_some_and(|item| item.id == item_id)
            {
                archive_current(data, now)?;
                data.current_item = None;
                data.current_item_started = false;
                rebuild_playlist_order(data, None)?;
                return Ok(MutationResult::changed(mutation_value(true), true));
            }
            let Some(index) = data.playlist.iter().position(|item| item.id == item_id) else {
                return Ok(MutationResult::unchanged(mutation_value(false)));
            };
            data.playlist.remove(index);
            rebuild_playlist_order(data, None)?;
            Ok(MutationResult::changed(mutation_value(true), true))
        }
        AppStateRequest::ClearPlaylist { .. } => {
            let changed = !data.playlist.is_empty() || data.backup.is_some();
            data.playlist.clear();
            data.backup = None;
            if !changed {
                return Ok(MutationResult::unchanged(mutation_value(false)));
            }
            let mut result = MutationResult::changed(mutation_value(true), false);
            result.effects.delete_backup = true;
            Ok(result)
        }
        AppStateRequest::ClearHistory { .. } => {
            if data.history.is_empty() {
                return Ok(MutationResult::unchanged(mutation_value(false)));
            }
            data.history.clear();
            Ok(MutationResult::changed(mutation_value(true), false))
        }
        AppStateRequest::RemoveHistoryEntry { key, .. } => {
            let key = key.trim();
            if key.is_empty() {
                return Ok(MutationResult::unchanged(mutation_value(false)));
            }
            let before = (
                data.history.len(),
                data.session_history.len(),
                data.session_played.len(),
            );
            data.history.retain(|entry| entry.key != key);
            data.session_history.retain(|entry| entry.key != key);
            data.session_played.retain(|entry| entry.key != key);
            let changed = before
                != (
                    data.history.len(),
                    data.session_history.len(),
                    data.session_played.len(),
                );
            if !changed {
                return Ok(MutationResult::unchanged(mutation_value(false)));
            }
            Ok(MutationResult::changed(mutation_value(true), true))
        }
        AppStateRequest::AdvanceToNext {
            reset_av_delay,
            now,
            ..
        } => {
            if data.current_item.is_none() && data.playlist.is_empty() {
                return Ok(MutationResult::unchanged(mutation_value(false)));
            }
            archive_current(data, now)?;
            data.current_item = if data.playlist.is_empty() {
                None
            } else {
                Some(data.playlist.remove(0))
            };
            data.current_item_started = false;
            data.player_settings.key_shift = 0;
            if data.current_item.is_some() && reset_av_delay {
                reset_local_av_delay(data);
            }
            if let Some(item) = data.current_item.clone() {
                record_session_played(data, &item, now)?;
            }
            rebuild_playlist_order(data, None)?;
            Ok(MutationResult::changed(mutation_value(true), true))
        }
        AppStateRequest::MoveItem {
            item_id, direction, ..
        } => {
            let Some(index) = data.playlist.iter().position(|item| item.id == item_id) else {
                return Ok(MutationResult::unchanged(mutation_value(false)));
            };
            let target = match direction.as_str() {
                "up" if index > 0 => Some(index - 1),
                "down" if index + 1 < data.playlist.len() => Some(index + 1),
                "up" | "down" => None,
                _ => {
                    return Err(rejected(
                        "invalid_direction",
                        "playlist direction is invalid",
                    ));
                }
            };
            let Some(target) = target else {
                return Ok(MutationResult::unchanged(mutation_value(false)));
            };
            data.playlist[index].queue_slot_type = "manual".to_owned();
            data.playlist.swap(index, target);
            rebuild_playlist_order(data, None)?;
            Ok(MutationResult::changed(mutation_value(true), true))
        }
        AppStateRequest::MoveToNext { item_id, .. } => {
            let Some(index) = data.playlist.iter().position(|item| item.id == item_id) else {
                return Ok(MutationResult::unchanged(mutation_value(false)));
            };
            let mut item = data.playlist.remove(index);
            item.queue_slot_type = "priority".to_owned();
            data.playlist.insert(0, item);
            rebuild_playlist_order(data, None)?;
            Ok(MutationResult::changed(mutation_value(true), true))
        }
        AppStateRequest::MoveItemToIndex {
            item_id,
            target_index,
            ..
        } => {
            let Some(index) = data.playlist.iter().position(|item| item.id == item_id) else {
                return Ok(MutationResult::unchanged(mutation_value(false)));
            };
            if data.playlist.is_empty() {
                return Ok(MutationResult::unchanged(mutation_value(false)));
            }
            let target = target_index.clamp(0, data.playlist.len() as i64 - 1) as usize;
            if target == index {
                return Ok(MutationResult::unchanged(
                    json!({"changed": false, "found": true}),
                ));
            }
            let mut item = data.playlist.remove(index);
            item.queue_slot_type = "manual".to_owned();
            data.playlist.insert(target, item);
            rebuild_playlist_order(data, None)?;
            Ok(MutationResult::changed(mutation_value(true), true))
        }
        AppStateRequest::ResortPlaylistByCycle { .. } => {
            if data.playlist.len() < 2 {
                return Ok(MutationResult::unchanged(mutation_value(false)));
            }
            for item in &mut data.playlist {
                item.queue_slot_type = "cycle".to_owned();
            }
            rebuild_playlist_order(data, None)?;
            Ok(MutationResult::changed(mutation_value(true), true))
        }
        AppStateRequest::MoveToFront {
            item_id,
            reset_av_delay,
            now,
            ..
        } => {
            let Some(index) = data.playlist.iter().position(|item| item.id == item_id) else {
                return Ok(MutationResult::unchanged(mutation_value(false)));
            };
            archive_current(data, now)?;
            let item = data.playlist.remove(index);
            if reset_av_delay {
                reset_local_av_delay(data);
            }
            record_session_played(data, &item, now)?;
            data.current_item = Some(item);
            data.current_item_started = false;
            rebuild_playlist_order(data, None)?;
            Ok(MutationResult::changed(mutation_value(true), true))
        }
        AppStateRequest::SetCurrentItem {
            item_id,
            reset_av_delay,
            now,
            ..
        } => match item_id {
            Some(item_id) => {
                if data.current_identity() == Some(item_id.as_str()) {
                    return Ok(MutationResult::unchanged(
                        json!({"changed": false, "found": true}),
                    ));
                }
                let Some(index) = data.playlist.iter().position(|item| item.id == item_id) else {
                    return Ok(MutationResult::unchanged(
                        json!({"changed": false, "found": false}),
                    ));
                };
                archive_current(data, now)?;
                let item = data.playlist.remove(index);
                if reset_av_delay {
                    reset_local_av_delay(data);
                }
                record_session_played(data, &item, now)?;
                data.current_item = Some(item);
                data.current_item_started = false;
                rebuild_playlist_order(data, None)?;
                Ok(MutationResult::changed(
                    json!({"changed": true, "found": true}),
                    true,
                ))
            }
            None => {
                if data.current_item.is_none() {
                    return Ok(MutationResult::unchanged(mutation_value(false)));
                }
                archive_current(data, now)?;
                data.current_item = None;
                data.current_item_started = false;
                Ok(MutationResult::changed(mutation_value(true), true))
            }
        },
        AppStateRequest::SetPlaybackMode { mode, .. } => {
            if !valid_string(&mode, MAX_STRING_BYTES, false) {
                return Err(rejected(
                    "invalid_playback_mode",
                    "playback mode is invalid",
                ));
            }
            if data.playback_mode == mode {
                return Ok(MutationResult::unchanged(json!({"mode": mode})));
            }
            data.playback_mode = mode.clone();
            Ok(MutationResult::changed(json!({"mode": mode}), true))
        }
        AppStateRequest::ApplyAvDelay { action, .. } => {
            let before = data.player_settings.clone();
            let snapshot = apply_av_delay(data, &action);
            let result = serde_json::to_value(snapshot).map_err(|error| {
                ExecuteError::Internal(format!("failed to serialize AV delay decision: {error}"))
            })?;
            if before == data.player_settings {
                return Ok(MutationResult::unchanged(result));
            }
            Ok(MutationResult::changed(result, true))
        }
        AppStateRequest::SetVolume { volume_percent, .. } => {
            let value = volume_percent.clamp(0, MAX_VOLUME_PERCENT);
            if data.player_settings.volume_percent == value {
                return Ok(MutationResult::unchanged(json!({"value": value})));
            }
            data.player_settings.volume_percent = value;
            Ok(MutationResult::changed(json!({"value": value}), true))
        }
        AppStateRequest::SetMuted { is_muted, .. } => {
            if data.player_settings.is_muted == is_muted {
                return Ok(MutationResult::unchanged(json!({"value": is_muted})));
            }
            data.player_settings.is_muted = is_muted;
            Ok(MutationResult::changed(json!({"value": is_muted}), true))
        }
        AppStateRequest::SetSongAdvanceDelay { delay_seconds, .. } => {
            let value = delay_seconds.clamp(0, MAX_SONG_ADVANCE_DELAY_SECONDS);
            if data.player_settings.song_advance_delay_seconds == value {
                return Ok(MutationResult::unchanged(json!({"value": value})));
            }
            data.player_settings.song_advance_delay_seconds = value;
            Ok(MutationResult::changed(json!({"value": value}), true))
        }
        AppStateRequest::SetKeyShift { key_shift, .. } => {
            let value = key_shift.clamp(MIN_KEY_SHIFT, MAX_KEY_SHIFT);
            if data.player_settings.key_shift == value {
                return Ok(MutationResult::unchanged(json!({"value": value})));
            }
            data.player_settings.key_shift = value;
            Ok(MutationResult::changed(json!({"value": value}), true))
        }
        AppStateRequest::SetAudioVariant {
            item_id,
            variant_id,
            ..
        } => {
            let normalized = variant_id.trim();
            if normalized.is_empty() {
                return Ok(MutationResult::unchanged(mutation_value(false)));
            }
            let item = data
                .find_item_mut(&item_id)
                .ok_or_else(|| rejected("item_not_found", "playlist item does not exist"))?;
            let mut allowed: HashSet<String> = item
                .audio_variants
                .iter()
                .filter_map(|variant| variant.get("id").and_then(Value::as_str))
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .collect();
            if allowed.is_empty() {
                allowed = predicted_audio_variant_ids(item);
            }
            if !allowed.contains(normalized) {
                return Ok(MutationResult::unchanged(mutation_value(false)));
            }
            if item.selected_audio_variant_id == normalized {
                return Ok(MutationResult::unchanged(
                    json!({"changed": false, "found": true}),
                ));
            }
            item.selected_audio_variant_id = normalized.to_owned();
            Ok(MutationResult::changed(
                json!({"changed": true, "found": true}),
                true,
            ))
        }
        AppStateRequest::AddSessionUser { name, .. } => {
            let normalized = normalize_session_user_name(&name);
            if normalized.is_empty() {
                return Err(rejected("invalid_session_user", "用户名不能为空"));
            }
            if data.session_users.contains(&normalized) {
                return Err(rejected("duplicate_session_user", "该用户已存在"));
            }
            if data.session_users.len() >= MAX_SESSION_USERS {
                return Err(rejected(
                    "too_many_session_users",
                    format!("最多只能添加 {MAX_SESSION_USERS} 个用户"),
                ));
            }
            data.session_users.push(normalized);
            rebuild_playlist_order(data, None)?;
            Ok(MutationResult::changed(mutation_value(true), true))
        }
        AppStateRequest::RemoveSessionUser { name, .. } => {
            let normalized = normalize_session_user_name(&name);
            let Some(index) = data
                .session_users
                .iter()
                .position(|user| user == &normalized)
            else {
                return Ok(MutationResult::unchanged(mutation_value(false)));
            };
            data.session_users.remove(index);
            rebuild_playlist_order(data, None)?;
            Ok(MutationResult::changed(mutation_value(true), true))
        }
        AppStateRequest::RenameSessionUser {
            current_name,
            new_name,
            ..
        } => {
            let current = normalize_session_user_name(&current_name);
            let renamed = normalize_session_user_name(&new_name);
            let Some(index) = data.session_users.iter().position(|user| user == &current) else {
                return Err(rejected(
                    "session_user_not_found",
                    "session user does not exist",
                ));
            };
            if renamed.is_empty() {
                return Err(rejected(
                    "invalid_session_user",
                    "user name cannot be empty",
                ));
            }
            if renamed != current && data.session_users.contains(&renamed) {
                return Err(rejected(
                    "duplicate_session_user",
                    "session user already exists",
                ));
            }
            if renamed == current {
                return Ok(MutationResult::unchanged(json!({"name": renamed})));
            }
            data.session_users[index] = renamed.clone();
            if let Some(item) = &mut data.current_item
                && item.requester_name == current
            {
                item.requester_name.clone_from(&renamed);
            }
            for item in &mut data.playlist {
                if item.requester_name == current {
                    item.requester_name.clone_from(&renamed);
                }
            }
            for entry in data
                .history
                .iter_mut()
                .chain(data.session_history.iter_mut())
            {
                if entry.requester_name == current {
                    entry.requester_name.clone_from(&renamed);
                }
            }
            for entry in &mut data.session_played {
                if entry.requester_name == current {
                    entry.requester_name.clone_from(&renamed);
                }
            }
            rebuild_playlist_order(data, None)?;
            Ok(MutationResult::changed(json!({"name": renamed}), true))
        }
        AppStateRequest::MoveSessionUserToIndex {
            name, target_index, ..
        } => {
            let normalized = normalize_session_user_name(&name);
            let Some(index) = data
                .session_users
                .iter()
                .position(|user| user == &normalized)
            else {
                return Ok(MutationResult::unchanged(mutation_value(false)));
            };
            let target = target_index.clamp(0, data.session_users.len() as i64 - 1) as usize;
            if target == index {
                return Ok(MutationResult::unchanged(
                    json!({"changed": false, "found": true}),
                ));
            }
            let user = data.session_users.remove(index);
            data.session_users.insert(target, user);
            rebuild_playlist_order(data, None)?;
            Ok(MutationResult::changed(
                json!({"changed": true, "found": true}),
                true,
            ))
        }
        AppStateRequest::SetSessionUsers { users, .. } => {
            let normalized: Vec<String> = users
                .iter()
                .map(|user| normalize_session_user_name(user))
                .collect();
            validate_session_users(&normalized)?;
            if data.session_users == normalized {
                return Ok(MutationResult::unchanged(mutation_value(false)));
            }
            data.session_users = normalized;
            rebuild_playlist_order(data, None)?;
            Ok(MutationResult::changed(mutation_value(true), true))
        }
        AppStateRequest::RestoreBackup { reset_av_delay, .. } => {
            let Some(backup) = data.backup.clone() else {
                return Ok(MutationResult::unchanged(mutation_value(false)));
            };
            if backup.current_item.is_none() && backup.playlist.is_empty() {
                return Ok(MutationResult::unchanged(mutation_value(false)));
            }
            data.current_item = backup.current_item.map(sanitize_backup_item);
            data.playlist = backup
                .playlist
                .into_iter()
                .map(sanitize_backup_item)
                .collect();
            if let Some(item) = data.current_item.as_mut() {
                assign_new_item_incarnation(item, identity_namespace, next_item_incarnation_id)?;
            }
            for item in &mut data.playlist {
                assign_new_item_incarnation(item, identity_namespace, next_item_incarnation_id)?;
            }
            data.current_item_started = false;
            if data.current_item.is_some() && reset_av_delay {
                reset_local_av_delay(data);
            }
            if let Some(archive) = backup.played_session {
                replace_session_archive(data, &archive);
            } else {
                data.session_played.clear();
            }
            data.previous_session = None;
            increment_session_generation(data)?;
            rebuild_playlist_order(data, None)?;
            Ok(MutationResult::changed(mutation_value(true), false))
        }
        AppStateRequest::DiscardBackup { new_session, .. } => {
            validate_archive(&new_session)?;
            let existed =
                data.backup.is_some() || data.current_item.is_some() || !data.playlist.is_empty();
            reset_current_identity(data);
            if existed {
                replace_session_archive(data, &new_session);
                increment_session_generation(data)?;
            }
            data.previous_session = None;
            data.backup = None;
            if !existed {
                return Ok(MutationResult::unchanged(mutation_value(false)));
            }
            let mut result = MutationResult::changed(mutation_value(true), false);
            result.effects.delete_backup = true;
            Ok(result)
        }
        AppStateRequest::ContinuePreviousSession { archive, .. } => {
            if data.current_item.is_some()
                || !data.playlist.is_empty()
                || !data.session_played.is_empty()
            {
                return Ok(MutationResult::unchanged(mutation_value(false)));
            }
            let Some(previous) = data.previous_session.take() else {
                return Ok(MutationResult::unchanged(mutation_value(false)));
            };
            let Some(archive) = archive else {
                return Ok(MutationResult::changed(mutation_value(false), false));
            };
            validate_archive(&archive)?;
            if archive.file_name != previous.file_name {
                return Err(rejected(
                    "previous_session_changed",
                    "previous session archive identity changed",
                ));
            }
            if archive.items.is_empty() {
                return Ok(MutationResult::changed(mutation_value(false), false));
            }
            replace_session_archive(data, &archive);
            increment_session_generation(data)?;
            Ok(MutationResult::changed(mutation_value(true), false))
        }
        AppStateRequest::BeginSession { new_session, .. } => {
            validate_archive(&new_session)?;
            reset_current_identity(data);
            data.session_history.clear();
            replace_session_archive(data, &new_session);
            data.previous_session = None;
            data.backup = None;
            increment_session_generation(data)?;
            let mut result = MutationResult::changed(mutation_value(true), false);
            result.effects.delete_backup = true;
            Ok(result)
        }
        AppStateRequest::ResetRuntime { new_session, .. } => {
            validate_archive(&new_session)?;
            data.playback_mode = "local".to_owned();
            data.player_settings = PlayerSettingsSeed::default();
            reset_current_identity(data);
            data.history.clear();
            data.session_history.clear();
            data.session_users.clear();
            replace_session_archive(data, &new_session);
            data.previous_session = None;
            data.backup = None;
            increment_session_generation(data)?;
            let mut result = MutationResult::changed(mutation_value(true), false);
            result.effects = PersistenceEffects {
                delete_backup: true,
                delete_runtime_files: true,
                ..PersistenceEffects::default()
            };
            Ok(result)
        }
        AppStateRequest::ResetPlayer { .. } => {
            let changed = data.playback_mode != "local"
                || data.player_settings != PlayerSettingsSeed::default()
                || data.current_item_started;
            if !changed {
                return Ok(MutationResult::unchanged(mutation_value(false)));
            }
            data.playback_mode = "local".to_owned();
            data.player_settings = PlayerSettingsSeed::default();
            data.current_item_started = false;
            Ok(MutationResult::changed(mutation_value(true), false))
        }
        AppStateRequest::MarkCurrentItemStarted { item_id, .. } => {
            if data.current_identity() != Some(item_id.trim()) {
                return Ok(MutationResult::unchanged(mutation_value(false)));
            }
            if data.current_item_started {
                return Ok(MutationResult::unchanged(
                    json!({"changed": false, "found": true}),
                ));
            }
            data.current_item_started = true;
            Ok(MutationResult::changed(
                json!({"changed": true, "found": true}),
                false,
            ))
        }
        AppStateRequest::MarkSessionPlayedThreshold { item_id, .. } => {
            let mut changed = false;
            for entry in &mut data.session_played {
                if entry.item_id == item_id && !entry.threshold_reached {
                    entry.threshold_reached = true;
                    changed = true;
                }
            }
            if !changed {
                return Ok(MutationResult::unchanged(mutation_value(false)));
            }
            Ok(MutationResult::changed(mutation_value(true), true))
        }
        AppStateRequest::AppendHistory { entry, .. } => {
            validate_history_entry(&entry)?;
            data.history.insert(0, entry);
            Ok(MutationResult::changed(mutation_value(true), false))
        }
        AppStateRequest::AppendSessionPlayed { entry, .. } => {
            validate_session_played_entry(&entry)?;
            data.session_played.push(entry);
            Ok(MutationResult::changed(mutation_value(true), true))
        }
        AppStateRequest::UpdateOwnerInfo {
            source_url,
            owner_mid,
            owner_name,
            owner_url,
            ..
        } => {
            let source = source_url.trim();
            if source.is_empty() || owner_mid < 0 {
                return Ok(MutationResult::unchanged(mutation_value(false)));
            }
            if !valid_string(&owner_name, MAX_STRING_BYTES, true)
                || !valid_string(&owner_url, MAX_STRING_BYTES, true)
            {
                return Err(rejected("invalid_owner", "owner metadata is invalid"));
            }
            let mut changed = false;
            let mut update_item = |item: &mut PlaylistItem| {
                if source != item.resolved_url.trim() && source != item.original_url.trim() {
                    return;
                }
                if item.owner_mid == owner_mid
                    && item.owner_name == owner_name
                    && item.owner_url == owner_url
                {
                    return;
                }
                item.owner_mid = owner_mid;
                item.owner_name.clone_from(&owner_name);
                item.owner_url.clone_from(&owner_url);
                changed = true;
            };
            if let Some(item) = &mut data.current_item {
                update_item(item);
            }
            for item in &mut data.playlist {
                update_item(item);
            }
            let mut update_history = |entry: &mut HistoryEntry| {
                if source != entry.resolved_url.trim() && source != entry.original_url.trim() {
                    return;
                }
                if entry.owner_mid == owner_mid
                    && entry.owner_name == owner_name
                    && entry.owner_url == owner_url
                {
                    return;
                }
                entry.owner_mid = owner_mid;
                entry.owner_name.clone_from(&owner_name);
                entry.owner_url.clone_from(&owner_url);
                changed = true;
            };
            for entry in data
                .history
                .iter_mut()
                .chain(data.session_history.iter_mut())
            {
                update_history(entry);
            }
            for entry in &mut data.session_played {
                if source != entry.resolved_url.trim() && source != entry.original_url.trim() {
                    continue;
                }
                if entry.owner_mid == owner_mid
                    && entry.owner_name == owner_name
                    && entry.owner_url == owner_url
                {
                    continue;
                }
                entry.owner_mid = owner_mid;
                entry.owner_name.clone_from(&owner_name);
                entry.owner_url.clone_from(&owner_url);
                changed = true;
            }
            if !changed {
                return Ok(MutationResult::unchanged(mutation_value(false)));
            }
            Ok(MutationResult::changed(mutation_value(true), true))
        }
        AppStateRequest::QueryDuplicate { item, .. } => {
            Ok(MutationResult::unchanged(duplicate_result(data, &item)?))
        }
        AppStateRequest::ApplyCacheEvent {
            item_id,
            cache_attempt_token,
            event,
            ..
        } => apply_cache_event(
            data,
            &item_id,
            cache_attempt_token,
            issued_cache_attempt_tokens,
            &event,
        ),
        AppStateRequest::Initialize { .. }
        | AppStateRequest::Snapshot { .. }
        | AppStateRequest::BeginCacheAttempt { .. }
        | AppStateRequest::AuthorizeCachePublication { .. }
        | AppStateRequest::Shutdown { .. } => Err(ExecuteError::Internal(
            "lifecycle request reached mutation dispatcher".to_owned(),
        )),
    }
}

impl AppState {
    pub fn execute(&mut self, request: AppStateRequest) -> AppStateResponse {
        if request.schema_version() != SCHEMA_VERSION {
            return invalid_request_response(
                "unsupported_schema_version",
                "AppState schema_version must be 1",
            );
        }
        if let Some(now) = request.now()
            && let Err(error) = validate_time(now, "now")
        {
            return execute_error_response(error);
        }
        match request {
            AppStateRequest::Initialize { state, .. } => {
                let namespace = match &self.identity_namespace {
                    Ok(namespace) => *namespace,
                    Err(message) => return internal_error_response(message),
                };
                let mut next_item_incarnation_id = self.next_item_incarnation_id;
                match AppStateData::from_seed(*state, &namespace, &mut next_item_incarnation_id) {
                    Ok(data) => {
                        let snapshot = data.snapshot();
                        let persistence = data.persistence_snapshot();
                        self.data = Some(data);
                        self.next_item_incarnation_id = next_item_incarnation_id;
                        AppStateResponse::Success(Box::new(AppStateSuccess {
                            schema_version: SCHEMA_VERSION,
                            status: "completed",
                            committed: true,
                            snapshot: Some(snapshot),
                            persistence: Some(persistence),
                            effects: PersistenceEffects {
                                write_core: true,
                                write_session_played: true,
                                ..PersistenceEffects::default()
                            },
                            result: json!({"initialized": true}),
                        }))
                    }
                    Err(error) => execute_error_response(error),
                }
            }
            AppStateRequest::Snapshot { .. } => {
                let Some(data) = &self.data else {
                    return uninitialized_response();
                };
                AppStateResponse::Success(Box::new(AppStateSuccess {
                    schema_version: SCHEMA_VERSION,
                    status: "completed",
                    committed: false,
                    snapshot: Some(data.snapshot()),
                    persistence: Some(data.persistence_snapshot()),
                    effects: PersistenceEffects::default(),
                    result: json!({"snapshot": true}),
                }))
            }
            AppStateRequest::BeginCacheAttempt {
                item_id,
                expected_item_incarnation_id,
                ..
            } => {
                let Some(data) = self.data.as_ref() else {
                    return uninitialized_response();
                };
                let Some(item) = data.find_item(&item_id) else {
                    return execute_error_response(rejected(
                        "item_not_found",
                        "playlist item does not exist",
                    ));
                };
                if !valid_authoritative_identity(&item.item_incarnation_id, 'i') {
                    return execute_error_response(rejected(
                        "invalid_item_incarnation_id",
                        "live playlist item has no valid Rust incarnation identity",
                    ));
                }
                if item.item_incarnation_id != expected_item_incarnation_id {
                    return execute_error_response(rejected_with_details(
                        "item_incarnation_mismatch",
                        "playlist item incarnation changed before cache reservation",
                        json!({
                            "item_id": item_id,
                            "expected_item_incarnation_id": expected_item_incarnation_id,
                            "actual_item_incarnation_id": item.item_incarnation_id,
                        }),
                    ));
                }
                let Some(cache_attempt_token) = self.next_cache_attempt_token.checked_add(1) else {
                    return execute_error_response(rejected(
                        "cache_attempt_token_exhausted",
                        "cache attempt token allocator is exhausted",
                    ));
                };
                let Some(next_artifact_set_id) = self
                    .next_artifact_set_id
                    .checked_add(1)
                    .filter(|value| *value > 0)
                else {
                    return execute_error_response(rejected(
                        "artifact_set_id_exhausted",
                        "artifact set identity allocator is exhausted",
                    ));
                };
                let namespace = match &self.identity_namespace {
                    Ok(namespace) => *namespace,
                    Err(message) => return internal_error_response(message),
                };
                let artifact_set_id =
                    format_authoritative_identity('a', &namespace, next_artifact_set_id);
                let reservation = CacheAttemptReservation {
                    cache_attempt_token,
                    item_id: item_id.clone(),
                    item_incarnation_id: item.item_incarnation_id.clone(),
                    artifact_relative_directory: artifact_relative_directory(
                        &item.item_incarnation_id,
                        &artifact_set_id,
                    ),
                    artifact_set_id,
                    refresh: has_committed_artifact(item),
                };
                self.next_cache_attempt_token = cache_attempt_token;
                self.next_artifact_set_id = next_artifact_set_id;
                let data = self
                    .data
                    .as_mut()
                    .expect("initialized AppState disappeared during cache reservation");
                data.active_cache_attempts.insert(
                    item_id,
                    ActiveCacheAttempt {
                        token: cache_attempt_token,
                        reservation: reservation.clone(),
                        refresh: reservation.refresh,
                        terminal_event: None,
                    },
                );
                AppStateResponse::Success(Box::new(AppStateSuccess {
                    schema_version: SCHEMA_VERSION,
                    status: "completed",
                    committed: false,
                    snapshot: Some(data.snapshot()),
                    persistence: Some(data.persistence_snapshot()),
                    effects: PersistenceEffects::default(),
                    result: serde_json::to_value(reservation)
                        .unwrap_or_else(|_| json!({"cache_attempt_token": cache_attempt_token})),
                }))
            }
            AppStateRequest::AuthorizeCachePublication {
                item_id,
                cache_attempt_token,
                item_incarnation_id,
                artifact_set_id,
                artifact_relative_directory,
                ..
            } => {
                let Some(data) = self.data.as_ref() else {
                    return uninitialized_response();
                };
                let active = match validate_cache_attempt_ownership(
                    data,
                    &item_id,
                    cache_attempt_token,
                    self.next_cache_attempt_token,
                ) {
                    Ok(active) => active,
                    Err(error) => return execute_error_response(error),
                };
                if active.terminal_event.is_some() {
                    return execute_error_response(rejected(
                        "cache_attempt_already_terminal",
                        "cache attempt is already terminal",
                    ));
                }
                if let Err(error) = validate_cache_publication_reservation(
                    &active,
                    &item_incarnation_id,
                    &artifact_set_id,
                    &artifact_relative_directory,
                ) {
                    return execute_error_response(error);
                }
                AppStateResponse::Success(Box::new(AppStateSuccess {
                    schema_version: SCHEMA_VERSION,
                    status: "completed",
                    committed: false,
                    snapshot: Some(data.snapshot()),
                    persistence: Some(data.persistence_snapshot()),
                    effects: PersistenceEffects::default(),
                    result: json!({"authorized": true}),
                }))
            }
            AppStateRequest::Shutdown { .. } => {
                let was_initialized = self.data.take().is_some();
                AppStateResponse::Success(Box::new(AppStateSuccess {
                    schema_version: SCHEMA_VERSION,
                    status: "completed",
                    committed: was_initialized,
                    snapshot: None,
                    persistence: None,
                    effects: PersistenceEffects::default(),
                    result: json!({"shutdown": was_initialized}),
                }))
            }
            request => {
                let Some(current) = self.data.as_ref() else {
                    return uninitialized_response();
                };
                let mut next = current.clone();
                let namespace = match &self.identity_namespace {
                    Ok(namespace) => *namespace,
                    Err(message) => return internal_error_response(message),
                };
                let mut next_item_incarnation_id = self.next_item_incarnation_id;
                let before_current = current.current_identity().map(str::to_owned);
                let now = request.now();
                let replaces_live_items = matches!(
                    &request,
                    AppStateRequest::RestoreBackup { .. }
                        | AppStateRequest::DiscardBackup { .. }
                        | AppStateRequest::BeginSession { .. }
                        | AppStateRequest::ResetRuntime { .. }
                );
                let mutation = match apply_mutation(
                    &mut next,
                    request,
                    self.next_cache_attempt_token,
                    &namespace,
                    &mut next_item_incarnation_id,
                ) {
                    Ok(mutation) => mutation,
                    Err(error) => return execute_error_response(error),
                };
                if mutation.changed {
                    if replaces_live_items {
                        next.active_cache_attempts.clear();
                    } else {
                        let live_item_ids: HashSet<String> = next
                            .current_item
                            .iter()
                            .chain(next.playlist.iter())
                            .map(|item| item.id.clone())
                            .collect();
                        next.active_cache_attempts
                            .retain(|item_id, _| live_item_ids.contains(item_id));
                    }
                    let Some(revision) = current.revision.checked_add(1) else {
                        return internal_error_response("AppState revision overflow");
                    };
                    next.revision = revision;
                    if current_changed(before_current.as_deref(), next.current_identity()) {
                        let Some(generation) = current.playback_generation.checked_add(1) else {
                            return internal_error_response(
                                "AppState playback generation overflow",
                            );
                        };
                        next.playback_generation = generation;
                    }
                    if let Some(now) = now {
                        next.updated_at = now;
                    }
                    let mut effects = mutation.effects;
                    if effects.write_backup {
                        update_backup_from_state(&mut next);
                        if next.backup.is_none() {
                            effects.write_backup = false;
                            effects.delete_backup = true;
                        }
                    }
                    let snapshot = next.snapshot();
                    let persistence = next.persistence_snapshot();
                    self.data = Some(next);
                    self.next_item_incarnation_id = next_item_incarnation_id;
                    AppStateResponse::Success(Box::new(AppStateSuccess {
                        schema_version: SCHEMA_VERSION,
                        status: "completed",
                        committed: true,
                        snapshot: Some(snapshot),
                        persistence: Some(persistence),
                        effects,
                        result: mutation.result,
                    }))
                } else {
                    let snapshot = current.snapshot();
                    let persistence = current.persistence_snapshot();
                    if mutation.operational_changed {
                        self.data = Some(next);
                    }
                    AppStateResponse::Success(Box::new(AppStateSuccess {
                        schema_version: SCHEMA_VERSION,
                        status: "completed",
                        committed: false,
                        snapshot: Some(snapshot),
                        persistence: Some(persistence),
                        effects: PersistenceEffects::default(),
                        result: mutation.result,
                    }))
                }
            }
        }
    }
}

fn invalid_request_response(kind: &str, message: &str) -> AppStateResponse {
    AppStateResponse::Failure(AppStateFailure {
        schema_version: SCHEMA_VERSION,
        status: "invalid_request",
        error: AppStateError {
            kind: kind.to_owned(),
            message: message.to_owned(),
            details: None,
        },
    })
}

fn uninitialized_response() -> AppStateResponse {
    AppStateResponse::Failure(AppStateFailure {
        schema_version: SCHEMA_VERSION,
        status: "uninitialized",
        error: AppStateError {
            kind: "app_state_uninitialized".to_owned(),
            message: "Rust AppState has not been initialized".to_owned(),
            details: None,
        },
    })
}

fn internal_error_response(message: &str) -> AppStateResponse {
    AppStateResponse::Failure(AppStateFailure {
        schema_version: SCHEMA_VERSION,
        status: "internal_error",
        error: AppStateError {
            kind: "internal_error".to_owned(),
            message: message.to_owned(),
            details: None,
        },
    })
}

fn execute_error_response(error: ExecuteError) -> AppStateResponse {
    match error {
        ExecuteError::Rejected(error) => AppStateResponse::Failure(AppStateFailure {
            schema_version: SCHEMA_VERSION,
            status: "rejected",
            error,
        }),
        ExecuteError::Internal(message) => internal_error_response(&message),
    }
}

pub fn execute_app_state(request: AppStateRequest) -> AppStateResponse {
    let state = APP_STATE.get_or_init(|| Mutex::new(AppState::default()));
    let Ok(mut state) = state.lock() else {
        return internal_error_response("Rust AppState lock is poisoned");
    };
    state.execute(request)
}

pub(crate) fn begin_cache_attempt_for_runtime(
    item_id: &str,
    expected_item_incarnation_id: &str,
) -> Result<CacheAttemptReservation, AppStateError> {
    match execute_app_state(AppStateRequest::BeginCacheAttempt {
        schema_version: SCHEMA_VERSION,
        item_id: item_id.to_owned(),
        expected_item_incarnation_id: expected_item_incarnation_id.to_owned(),
    }) {
        AppStateResponse::Success(success) => serde_json::from_value(success.result.clone())
            .ok()
            .filter(|reservation: &CacheAttemptReservation| {
                reservation.cache_attempt_token > 0
                    && reservation.item_id == item_id
                    && reservation.item_incarnation_id == expected_item_incarnation_id
                    && valid_authoritative_identity(&reservation.item_incarnation_id, 'i')
                    && valid_authoritative_identity(&reservation.artifact_set_id, 'a')
                    && valid_artifact_relative_directory(
                        &reservation.artifact_relative_directory,
                        &reservation.item_incarnation_id,
                        &reservation.artifact_set_id,
                    )
            })
            .ok_or_else(|| AppStateError {
                kind: "invalid_cache_attempt_response".to_owned(),
                message: "AppState returned an invalid cache attempt reservation".to_owned(),
                details: None,
            }),
        AppStateResponse::Failure(failure) => Err(failure.error),
    }
}

pub(crate) fn authorize_cache_publication_for_runtime(
    item_id: &str,
    reservation: &CacheAttemptReservation,
) -> Result<(), AppStateError> {
    match execute_app_state(AppStateRequest::AuthorizeCachePublication {
        schema_version: SCHEMA_VERSION,
        item_id: item_id.to_owned(),
        cache_attempt_token: reservation.cache_attempt_token,
        item_incarnation_id: reservation.item_incarnation_id.clone(),
        artifact_set_id: reservation.artifact_set_id.clone(),
        artifact_relative_directory: reservation.artifact_relative_directory.clone(),
    }) {
        AppStateResponse::Success(success) if success.result["authorized"] == json!(true) => Ok(()),
        AppStateResponse::Success(_) => Err(AppStateError {
            kind: "invalid_cache_publication_authorization".to_owned(),
            message: "AppState returned an invalid publication authorization".to_owned(),
            details: None,
        }),
        AppStateResponse::Failure(failure) => Err(failure.error),
    }
}

pub fn execute_app_state_json(request_json: &str) -> String {
    let response = match serde_json::from_str::<AppStateRequest>(request_json) {
        Ok(request) => execute_app_state(request),
        Err(error) => invalid_request_response(
            "invalid_json_request",
            &format!("invalid AppState request: {error}"),
        ),
    };
    serde_json::to_string(&response).unwrap_or_else(|_| {
        "{\"schema_version\":1,\"status\":\"internal_error\",\"error\":{\"kind\":\"serialization_failed\",\"message\":\"failed to serialize AppState response\"}}".to_owned()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use std::thread;

    fn item(id: &str, bvid: &str, requester_name: &str) -> PlaylistItem {
        PlaylistItem {
            id: id.to_owned(),
            original_url: format!("https://example.test/{id}"),
            resolved_url: format!("https://example.test/{id}?p=1"),
            bvid: bvid.to_owned(),
            aid: 1,
            cid: 2,
            page: 1,
            title: format!("title-{id}"),
            part_title: "P1".to_owned(),
            display_title: format!("title-{id} - P1"),
            cover_url: String::new(),
            embed_url: String::new(),
            selected_pages: vec![1],
            selected_cids: vec![2],
            selected_durations: vec![120],
            selected_parts: vec!["P1".to_owned()],
            available_pages: vec![1],
            available_cids: vec![2],
            available_durations: vec![120],
            available_parts: vec!["P1".to_owned()],
            audio_variants: Vec::new(),
            selected_audio_variant_id: String::new(),
            video_page: 1,
            manual_selection: false,
            owner_mid: 0,
            owner_name: String::new(),
            owner_url: String::new(),
            requester_name: requester_name.to_owned(),
            queue_slot_type: "cycle".to_owned(),
            cache_status: "pending".to_owned(),
            cache_progress: 0.0,
            cache_message: "等待缓存".to_owned(),
            video_relative_path: String::new(),
            video_media_url: String::new(),
            item_incarnation_id: String::new(),
            artifact_set_id: String::new(),
            artifact_relative_directory: String::new(),
        }
    }

    fn history(key: &str, requester: &str) -> HistoryEntry {
        HistoryEntry {
            key: key.to_owned(),
            display_title: key.to_owned(),
            original_url: format!("https://example.test/{key}"),
            resolved_url: format!("https://example.test/{key}"),
            requested_at: 10.0,
            title: key.to_owned(),
            part_title: "P1".to_owned(),
            owner_mid: 0,
            owner_name: String::new(),
            owner_url: String::new(),
            requester_name: requester.to_owned(),
            request_count: 1,
        }
    }

    fn played(id: &str, requester: &str) -> SessionPlayedEntry {
        SessionPlayedEntry {
            key: format!("BV-{id}:p1:a1"),
            item_id: id.to_owned(),
            display_title: id.to_owned(),
            title: id.to_owned(),
            part_title: "P1".to_owned(),
            original_url: format!("https://example.test/{id}"),
            resolved_url: format!("https://example.test/{id}"),
            bvid: format!("BV-{id}"),
            aid: 1,
            cid: 2,
            page: 1,
            played_at: 10.0,
            ended_at: None,
            owner_mid: 0,
            owner_name: String::new(),
            owner_url: String::new(),
            requester_name: requester.to_owned(),
            cover_url: String::new(),
            threshold_reached: false,
        }
    }

    fn seed() -> AppStateSeed {
        AppStateSeed {
            playback_mode: "local".to_owned(),
            player_settings: PlayerSettingsSeed::default(),
            current_item: None,
            current_item_started: false,
            playlist: Vec::new(),
            history: Vec::new(),
            session_history: Vec::new(),
            session_users: vec!["Alice".to_owned(), "Bob".to_owned()],
            session_started_at: 10.0,
            session_played_file: "played-current.json".to_owned(),
            session_played: Vec::new(),
            previous_session: None,
            backup: None,
            updated_at: 10.0,
        }
    }

    fn initialize(state: &mut AppState, seed: AppStateSeed) -> AppSnapshot {
        success(state.execute(AppStateRequest::Initialize {
            schema_version: 1,
            state: Box::new(seed),
        }))
        .snapshot
        .expect("initialize snapshot")
    }

    fn success(response: AppStateResponse) -> AppStateSuccess {
        match response {
            AppStateResponse::Success(success) => *success,
            AppStateResponse::Failure(failure) => panic!("unexpected failure: {failure:?}"),
        }
    }

    fn failure(response: AppStateResponse) -> AppStateFailure {
        match response {
            AppStateResponse::Failure(failure) => failure,
            AppStateResponse::Success(success) => panic!("unexpected success: {success:?}"),
        }
    }

    fn begin_cache_attempt(state: &mut AppState, item_id: &str) -> (u64, AppStateSuccess) {
        let expected_item_incarnation_id = state
            .data
            .as_ref()
            .and_then(|data| data.find_item(item_id))
            .map(|item| item.item_incarnation_id.clone())
            .expect("live item incarnation");
        let response = success(state.execute(AppStateRequest::BeginCacheAttempt {
            schema_version: 1,
            item_id: item_id.to_owned(),
            expected_item_incarnation_id,
        }));
        let token = response.result["cache_attempt_token"]
            .as_u64()
            .expect("positive cache attempt token");
        (token, response)
    }

    fn cache_reservation(response: &AppStateSuccess) -> CacheAttemptReservation {
        serde_json::from_value(response.result.clone()).expect("cache reservation")
    }

    fn apply_cache(
        state: &mut AppState,
        item_id: &str,
        cache_attempt_token: u64,
        event: CacheEvent,
        now: f64,
    ) -> AppStateResponse {
        state.execute(AppStateRequest::ApplyCacheEvent {
            schema_version: 1,
            item_id: item_id.to_owned(),
            cache_attempt_token,
            event,
            now,
        })
    }

    fn ready_event(
        state: &AppState,
        item_id: &str,
        cache_attempt_token: u64,
        video_name: &str,
        variants: &[(&str, &str)],
        producer_selection: &str,
    ) -> CacheEvent {
        let reservation = &state
            .data
            .as_ref()
            .expect("initialized state")
            .active_cache_attempts[item_id]
            .reservation;
        assert_eq!(reservation.cache_attempt_token, cache_attempt_token);
        let directory = reservation.artifact_relative_directory.clone();
        CacheEvent::Ready {
            progress: 100.0,
            message: "ready".to_owned(),
            video_relative_path: format!("{directory}/{video_name}"),
            video_media_url: format!("/media/{directory}/{video_name}"),
            audio_variants: variants
                .iter()
                .map(|(id, audio_name)| {
                    Map::from_iter([
                        ("id".to_owned(), json!(id)),
                        (
                            "audio_url".to_owned(),
                            json!(format!("/media/{directory}/{audio_name}")),
                        ),
                    ])
                })
                .collect(),
            selected_audio_variant_id: producer_selection.to_owned(),
            item_incarnation_id: reservation.item_incarnation_id.clone(),
            artifact_set_id: reservation.artifact_set_id.clone(),
            artifact_relative_directory: directory,
        }
    }

    #[test]
    fn persisted_state_initializes_one_authoritative_snapshot() {
        let mut state = AppState::default();
        let mut initial = seed();
        initial.current_item = Some(item("current", "BV-current", "Alice"));
        initial.current_item_started = true;
        initial.playlist = vec![item("queued", "BV-queued", "Bob")];
        initial.history = vec![history("BV-old:p1:a1", "Alice")];
        initial.session_history = vec![history("BV-session:p1:a1", "Bob")];
        initial.session_played = vec![played("current", "Alice")];
        initial.player_settings = PlayerSettingsSeed {
            global_av_delay_ms: 120,
            local_av_delay_ms: -20,
            av_delay_locked: true,
            volume_percent: 42,
            is_muted: true,
            song_advance_delay_seconds: 8,
            key_shift: 3,
        };
        let snapshot = initialize(&mut state, initial.clone());
        assert_eq!(snapshot.revision, 1);
        assert_eq!(snapshot.session_generation, 1);
        assert_eq!(snapshot.playback_generation, 1);
        assert_eq!(
            snapshot.current_item.as_ref().map(|item| item.id.as_str()),
            Some("current")
        );
        assert_eq!(snapshot.playlist[0].id, "queued");
        assert_eq!(snapshot.history, initial.history);
        assert_eq!(snapshot.session_history, initial.session_history);
        assert_eq!(snapshot.session_users, ["Alice", "Bob"]);
        assert_eq!(snapshot.session_played, initial.session_played);
        assert_eq!(snapshot.player_settings.volume_percent, 42);
        assert_eq!(snapshot.player_settings.av_offset_ms, 100);

        let read = success(state.execute(AppStateRequest::Snapshot { schema_version: 1 }));
        assert!(!read.committed);
        assert_eq!(read.snapshot.expect("snapshot"), snapshot);
    }

    #[test]
    fn revisions_increment_once_and_rejections_or_reads_do_not_increment() {
        let mut state = AppState::default();
        initialize(&mut state, seed());
        let changed = success(state.execute(AppStateRequest::SetVolume {
            schema_version: 1,
            volume_percent: 35,
            now: 11.0,
        }));
        assert!(changed.committed);
        assert_eq!(changed.snapshot.as_ref().expect("snapshot").revision, 2);

        let unchanged = success(state.execute(AppStateRequest::SetVolume {
            schema_version: 1,
            volume_percent: 35,
            now: 12.0,
        }));
        assert!(!unchanged.committed);
        assert_eq!(unchanged.snapshot.as_ref().expect("snapshot").revision, 2);

        let rejected = failure(state.execute(AppStateRequest::SetPlaybackMode {
            schema_version: 1,
            mode: String::new(),
            now: 13.0,
        }));
        assert_eq!(rejected.status, "rejected");
        let read = success(state.execute(AppStateRequest::Snapshot { schema_version: 1 }));
        assert_eq!(read.snapshot.expect("snapshot").revision, 2);
    }

    #[test]
    fn session_and_playback_generations_follow_identity_boundaries() {
        let mut state = AppState::default();
        let first = initialize(&mut state, seed());
        let added = success(state.execute(AppStateRequest::AddItem {
            schema_version: 1,
            item: item("a", "BV-a", ""),
            position: "tail".to_owned(),
            requester_name: "Alice".to_owned(),
            reset_av_delay: false,
            allow_repeat: false,
            now: 11.0,
        }));
        let added = added.snapshot.expect("added snapshot");
        assert_eq!(added.session_generation, first.session_generation);
        assert_eq!(added.playback_generation, first.playback_generation + 1);

        let volume = success(state.execute(AppStateRequest::SetVolume {
            schema_version: 1,
            volume_percent: 50,
            now: 12.0,
        }))
        .snapshot
        .expect("volume snapshot");
        assert_eq!(volume.playback_generation, added.playback_generation);

        let reset = success(state.execute(AppStateRequest::BeginSession {
            schema_version: 1,
            new_session: SessionArchiveSeed {
                file_name: "played-next.json".to_owned(),
                session_started_at: 13.0,
                items: Vec::new(),
            },
            now: 13.0,
        }))
        .snapshot
        .expect("reset snapshot");
        assert_eq!(reset.session_generation, added.session_generation + 1);
        assert_eq!(reset.playback_generation, added.playback_generation + 1);
    }

    #[test]
    fn playlist_duplicate_order_advance_and_history_are_committed_in_rust() {
        let mut state = AppState::default();
        initialize(&mut state, seed());
        for (id, bvid, requester) in [
            ("a", "BV-a", "Alice"),
            ("b", "BV-b", "Bob"),
            ("c", "BV-c", "Alice"),
        ] {
            let response = state.execute(AppStateRequest::AddItem {
                schema_version: 1,
                item: item(id, bvid, ""),
                position: "tail".to_owned(),
                requester_name: requester.to_owned(),
                reset_av_delay: false,
                allow_repeat: false,
                now: 11.0,
            });
            assert!(matches!(response, AppStateResponse::Success(_)));
        }
        let snapshot = success(state.execute(AppStateRequest::Snapshot { schema_version: 1 }))
            .snapshot
            .expect("snapshot");
        assert_eq!(
            snapshot
                .current_item
                .as_ref()
                .map(|entry| entry.id.as_str()),
            Some("a")
        );
        assert_eq!(
            snapshot
                .playlist
                .iter()
                .map(|entry| entry.id.as_str())
                .collect::<Vec<_>>(),
            ["b", "c"]
        );

        let revision = snapshot.revision;
        let duplicate = failure(state.execute(AppStateRequest::AddItem {
            schema_version: 1,
            item: item("duplicate-a", "BV-a", ""),
            position: "tail".to_owned(),
            requester_name: "Alice".to_owned(),
            reset_av_delay: false,
            allow_repeat: false,
            now: 12.0,
        }));
        assert_eq!(duplicate.error.kind, "duplicate_session_request");
        let after_rejection =
            success(state.execute(AppStateRequest::Snapshot { schema_version: 1 }))
                .snapshot
                .expect("snapshot");
        assert_eq!(after_rejection.revision, revision);

        success(state.execute(AppStateRequest::MarkCurrentItemStarted {
            schema_version: 1,
            item_id: "a".to_owned(),
            now: 13.0,
        }));
        let advanced = success(state.execute(AppStateRequest::AdvanceToNext {
            schema_version: 1,
            reset_av_delay: false,
            now: 14.0,
        }))
        .snapshot
        .expect("advanced snapshot");
        assert_eq!(
            advanced
                .current_item
                .as_ref()
                .map(|entry| entry.id.as_str()),
            Some("b")
        );
        assert_eq!(advanced.history[0].requester_name, "Alice");
        assert_eq!(advanced.session_history[0].requester_name, "Alice");
        assert_eq!(advanced.session_played[0].ended_at, Some(14.0));
    }

    #[test]
    fn previous_session_and_backup_restore_are_state_owned() {
        let mut state = AppState::default();
        let mut initial = seed();
        initial.previous_session = Some(SessionArchiveSeed {
            file_name: "played-previous.json".to_owned(),
            session_started_at: 2.0,
            items: vec![played("previous", "Alice")],
        });
        initial.backup = Some(BackupSeed {
            current_item: Some(item("restored", "BV-restored", "Alice")),
            playlist: vec![item("queued", "BV-queued", "Bob")],
            played_session: Some(SessionArchiveSeed {
                file_name: "played-backup.json".to_owned(),
                session_started_at: 3.0,
                items: vec![played("restored", "Alice")],
            }),
            updated_at: 9.0,
        });
        let initialized = initialize(&mut state, initial);
        assert!(initialized.backup.available);
        assert!(initialized.previous_session.available);

        let restored = success(state.execute(AppStateRequest::RestoreBackup {
            schema_version: 1,
            reset_av_delay: false,
            now: 11.0,
        }))
        .snapshot
        .expect("restored snapshot");
        assert_eq!(
            restored
                .current_item
                .as_ref()
                .map(|entry| entry.id.as_str()),
            Some("restored")
        );
        assert_eq!(restored.playlist[0].id, "queued");
        assert!(!restored.previous_session.available);
        assert_eq!(restored.session_played[0].item_id, "restored");
    }

    #[test]
    fn cache_attempt_reservation_is_unique_and_operational_only() {
        let mut state = AppState::default();
        let mut initial = seed();
        initial.current_item = Some(item("a", "BV-a", "Alice"));
        let before = initialize(&mut state, initial);

        let (first, reserved) = begin_cache_attempt(&mut state, "a");
        let first_reservation = cache_reservation(&reserved);
        assert!(first > 0);
        assert_eq!(first_reservation.item_id, "a");
        assert!(!first_reservation.refresh);
        assert!(valid_authoritative_identity(
            &first_reservation.item_incarnation_id,
            'i'
        ));
        assert!(valid_authoritative_identity(
            &first_reservation.artifact_set_id,
            'a'
        ));
        assert!(!reserved.committed);
        assert_eq!(reserved.snapshot.as_ref(), Some(&before));
        assert_eq!(
            reserved.persistence,
            Some(state.data.as_ref().expect("data").persistence_snapshot())
        );
        assert_eq!(reserved.effects, PersistenceEffects::default());
        let (second, superseded) = begin_cache_attempt(&mut state, "a");
        let second_reservation = cache_reservation(&superseded);
        assert!(second > first);
        assert_ne!(
            first_reservation.artifact_set_id,
            second_reservation.artifact_set_id
        );
        assert_eq!(
            first_reservation.item_incarnation_id,
            second_reservation.item_incarnation_id
        );
        assert!(!superseded.committed);
        assert_eq!(superseded.snapshot.as_ref(), Some(&before));
        assert_eq!(
            state.data.as_ref().expect("data").active_cache_attempts["a"].token,
            second
        );
    }

    #[test]
    fn cache_attempt_expected_incarnation_mismatch_is_fully_atomic() {
        let mut state = AppState::default();
        let mut initial = seed();
        initial.current_item = Some(item("a", "BV-a", "Alice"));
        initialize(&mut state, initial);
        let data_before = state.data.clone();
        let persistence_before = state.data.as_ref().expect("data").persistence_snapshot();
        let token_before = state.next_cache_attempt_token;
        let artifact_before = state.next_artifact_set_id;

        let rejected = failure(state.execute(AppStateRequest::BeginCacheAttempt {
            schema_version: 1,
            item_id: "a".to_owned(),
            expected_item_incarnation_id:
                "i-00000000000000000000000000000000-0000000000000001".to_owned(),
        }));

        assert_eq!(rejected.error.kind, "item_incarnation_mismatch");
        assert_eq!(state.next_cache_attempt_token, token_before);
        assert_eq!(state.next_artifact_set_id, artifact_before);
        assert_eq!(state.data, data_before);
        assert_eq!(
            state.data.as_ref().expect("data").persistence_snapshot(),
            persistence_before
        );
        assert!(
            state
                .data
                .as_ref()
                .expect("data")
                .active_cache_attempts
                .is_empty()
        );
    }

    #[test]
    fn removed_and_readded_item_rejects_the_stale_expected_incarnation() {
        let mut state = AppState::default();
        let mut initial = seed();
        initial.current_item = Some(item("a", "BV-old", "Alice"));
        initialize(&mut state, initial);
        let stale_item_incarnation_id = state
            .data
            .as_ref()
            .and_then(|data| data.find_item("a"))
            .expect("old item")
            .item_incarnation_id
            .clone();
        success(state.execute(AppStateRequest::RemoveItem {
            schema_version: 1,
            item_id: "a".to_owned(),
            now: 11.0,
        }));
        success(state.execute(AppStateRequest::AddItem {
            schema_version: 1,
            item: item("a", "BV-new", ""),
            position: "tail".to_owned(),
            requester_name: "Alice".to_owned(),
            reset_av_delay: false,
            allow_repeat: true,
            now: 12.0,
        }));
        let data_before = state.data.clone();
        let token_before = state.next_cache_attempt_token;
        let artifact_before = state.next_artifact_set_id;

        let rejected = failure(state.execute(AppStateRequest::BeginCacheAttempt {
            schema_version: 1,
            item_id: "a".to_owned(),
            expected_item_incarnation_id: stale_item_incarnation_id,
        }));

        assert_eq!(rejected.error.kind, "item_incarnation_mismatch");
        assert_eq!(state.next_cache_attempt_token, token_before);
        assert_eq!(state.next_artifact_set_id, artifact_before);
        assert_eq!(state.data, data_before);
    }

    #[test]
    fn refresh_lifecycle_preserves_then_atomically_replaces_committed_artifacts() {
        let mut state = AppState::default();
        let mut initial = seed();
        initial.current_item = Some(item("a", "BV-a", "Alice"));
        initialize(&mut state, initial);

        let (fill_token, fill_response) = begin_cache_attempt(&mut state, "a");
        assert!(!cache_reservation(&fill_response).refresh);
        let fill_ready = ready_event(
            &state,
            "a",
            fill_token,
            "video-v1.mp4",
            &[("original", "audio-v1.m4a")],
            "original",
        );
        success(apply_cache(&mut state, "a", fill_token, fill_ready, 10.5));
        let committed_v1 = state
            .data
            .as_ref()
            .expect("data")
            .find_item("a")
            .expect("item")
            .clone();

        let (failed_refresh, failed_response) = begin_cache_attempt(&mut state, "a");
        assert!(cache_reservation(&failed_response).refresh);
        for event in [
            CacheEvent::Queued {
                message: "refresh queued".to_owned(),
            },
            CacheEvent::Started {
                message: "refresh started".to_owned(),
            },
            CacheEvent::Progress {
                progress: 64.0,
                message: Some("refresh progress".to_owned()),
            },
        ] {
            success(apply_cache(&mut state, "a", failed_refresh, event, 11.0));
            let refreshing = state
                .data
                .as_ref()
                .expect("data")
                .find_item("a")
                .expect("item");
            assert_eq!(refreshing.cache_status, "ready");
            assert_eq!(
                (
                    &refreshing.video_relative_path,
                    &refreshing.video_media_url,
                    &refreshing.audio_variants,
                    &refreshing.selected_audio_variant_id,
                    &refreshing.artifact_set_id,
                    &refreshing.artifact_relative_directory,
                ),
                (
                    &committed_v1.video_relative_path,
                    &committed_v1.video_media_url,
                    &committed_v1.audio_variants,
                    &committed_v1.selected_audio_variant_id,
                    &committed_v1.artifact_set_id,
                    &committed_v1.artifact_relative_directory,
                )
            );
        }
        success(apply_cache(
            &mut state,
            "a",
            failed_refresh,
            CacheEvent::Failed {
                message: "refresh failed".to_owned(),
            },
            12.0,
        ));
        let after_failure = state
            .data
            .as_ref()
            .expect("data")
            .find_item("a")
            .expect("item");
        assert_eq!(after_failure.cache_status, "ready");
        assert_eq!(after_failure.artifact_set_id, committed_v1.artifact_set_id);

        let (cancelled_refresh, _) = begin_cache_attempt(&mut state, "a");
        success(apply_cache(
            &mut state,
            "a",
            cancelled_refresh,
            CacheEvent::Cancelled {
                message: "refresh cancelled".to_owned(),
            },
            13.0,
        ));
        assert_eq!(
            state
                .data
                .as_ref()
                .expect("data")
                .find_item("a")
                .expect("item")
                .artifact_set_id,
            committed_v1.artifact_set_id
        );

        let (successful_refresh, refresh_response) = begin_cache_attempt(&mut state, "a");
        let refresh_reservation = cache_reservation(&refresh_response);
        assert!(refresh_reservation.refresh);
        assert_ne!(
            refresh_reservation.artifact_set_id,
            committed_v1.artifact_set_id
        );
        let refresh_ready = ready_event(
            &state,
            "a",
            successful_refresh,
            "video-v2.mp4",
            &[("original", "audio-v2.m4a")],
            "original",
        );
        success(apply_cache(
            &mut state,
            "a",
            successful_refresh,
            refresh_ready,
            14.0,
        ));
        let committed_v2 = state
            .data
            .as_ref()
            .expect("data")
            .find_item("a")
            .expect("item");
        assert_eq!(
            committed_v2.artifact_set_id,
            refresh_reservation.artifact_set_id
        );
        assert_ne!(committed_v2.video_media_url, committed_v1.video_media_url);

        let (reset_token, _) = begin_cache_attempt(&mut state, "a");
        success(apply_cache(
            &mut state,
            "a",
            reset_token,
            CacheEvent::Reset {
                message: "explicit reset".to_owned(),
                clear_selected_audio_variant: true,
            },
            15.0,
        ));
        let reset = state
            .data
            .as_ref()
            .expect("data")
            .find_item("a")
            .expect("item");
        assert_eq!(reset.cache_status, "pending");
        assert!(reset.artifact_set_id.is_empty());
        assert!(reset.video_media_url.is_empty());
    }

    #[test]
    fn artifact_identity_exhaustion_is_atomic() {
        let mut state = AppState::default();
        let mut initial = seed();
        initial.current_item = Some(item("a", "BV-a", "Alice"));
        initialize(&mut state, initial);
        state.next_artifact_set_id = u64::MAX;
        let data_before = state.data.clone();
        let token_before = state.next_cache_attempt_token;
        let expected_item_incarnation_id = state
            .data
            .as_ref()
            .and_then(|data| data.find_item("a"))
            .expect("item")
            .item_incarnation_id
            .clone();
        let rejected = failure(state.execute(AppStateRequest::BeginCacheAttempt {
            schema_version: 1,
            item_id: "a".to_owned(),
            expected_item_incarnation_id,
        }));
        assert_eq!(rejected.error.kind, "artifact_set_id_exhausted");
        assert_eq!(state.next_artifact_set_id, u64::MAX);
        assert_eq!(state.next_cache_attempt_token, token_before);
        assert_eq!(state.data, data_before);
    }

    #[test]
    fn cache_attempt_acceptance_requires_exact_live_ownership() {
        let mut state = AppState::default();
        let mut initial = seed();
        initial.current_item = Some(item("a", "BV-a", "Alice"));
        initial.playlist = vec![item("b", "BV-b", "Bob")];
        let before = initialize(&mut state, initial);
        let (old, _) = begin_cache_attempt(&mut state, "a");
        let (current, _) = begin_cache_attempt(&mut state, "a");
        let (other, _) = begin_cache_attempt(&mut state, "b");
        let allocator_before = state.next_cache_attempt_token;
        let attempts_before = state
            .data
            .as_ref()
            .expect("data")
            .active_cache_attempts
            .clone();

        for (token, expected_kind) in [
            (0, "invalid_cache_attempt_token"),
            (allocator_before + 1, "unissued_cache_attempt_token"),
            (old, "cache_attempt_superseded"),
            (other, "cache_attempt_wrong_item"),
        ] {
            let rejected = failure(apply_cache(
                &mut state,
                "a",
                token,
                CacheEvent::Progress {
                    progress: 50.0,
                    message: Some("stale".to_owned()),
                },
                11.0,
            ));
            assert_eq!(rejected.error.kind, expected_kind);
            assert_eq!(state.next_cache_attempt_token, allocator_before);
            assert_eq!(
                state.data.as_ref().expect("data").active_cache_attempts,
                attempts_before
            );
            let snapshot = success(state.execute(AppStateRequest::Snapshot { schema_version: 1 }))
                .snapshot
                .expect("snapshot");
            assert_eq!(snapshot, before);
        }

        let applied = success(apply_cache(
            &mut state,
            "a",
            current,
            CacheEvent::Progress {
                progress: 50.0,
                message: Some("current".to_owned()),
            },
            12.0,
        ));
        assert!(applied.committed);
    }

    #[test]
    fn removed_and_reused_item_ids_never_inherit_old_attempts() {
        let mut state = AppState::default();
        let mut initial = seed();
        initial.current_item = Some(item("a", "BV-old", "Alice"));
        initialize(&mut state, initial);
        let (old, old_response) = begin_cache_attempt(&mut state, "a");
        let old_reservation = cache_reservation(&old_response);
        success(state.execute(AppStateRequest::RemoveItem {
            schema_version: 1,
            item_id: "a".to_owned(),
            now: 11.0,
        }));
        assert!(
            !state
                .data
                .as_ref()
                .expect("data")
                .active_cache_attempts
                .contains_key("a")
        );
        let removed = failure(apply_cache(
            &mut state,
            "a",
            old,
            CacheEvent::Failed {
                message: "removed failure".to_owned(),
            },
            11.5,
        ));
        assert_eq!(removed.error.kind, "cache_attempt_not_active");
        success(state.execute(AppStateRequest::AddItem {
            schema_version: 1,
            item: item("a", "BV-new", ""),
            position: "tail".to_owned(),
            requester_name: "Alice".to_owned(),
            reset_av_delay: false,
            allow_repeat: true,
            now: 12.0,
        }));
        let (_new, new_response) = begin_cache_attempt(&mut state, "a");
        let new_reservation = cache_reservation(&new_response);
        assert_ne!(
            old_reservation.item_incarnation_id,
            new_reservation.item_incarnation_id
        );
        assert_ne!(
            old_reservation.artifact_set_id,
            new_reservation.artifact_set_id
        );
        let rejected = failure(apply_cache(
            &mut state,
            "a",
            old,
            CacheEvent::Failed {
                message: "old failure".to_owned(),
            },
            13.0,
        ));
        assert_eq!(rejected.error.kind, "cache_attempt_superseded");
        assert_eq!(
            state
                .data
                .as_ref()
                .expect("data")
                .find_item("a")
                .expect("re-added item")
                .bvid,
            "BV-new"
        );
    }

    #[test]
    fn clearing_or_replacing_live_items_clears_their_attempt_bindings() {
        let mut state = AppState::default();
        let mut initial = seed();
        initial.current_item = Some(item("a", "BV-a", "Alice"));
        initial.playlist = vec![item("b", "BV-b", "Bob")];
        initialize(&mut state, initial);
        let (current_token, _) = begin_cache_attempt(&mut state, "a");
        let (queued_token, _) = begin_cache_attempt(&mut state, "b");

        success(state.execute(AppStateRequest::ClearPlaylist {
            schema_version: 1,
            now: 11.0,
        }));
        let queued_rejection = failure(apply_cache(
            &mut state,
            "b",
            queued_token,
            CacheEvent::Failed {
                message: "cleared".to_owned(),
            },
            12.0,
        ));
        assert_eq!(queued_rejection.error.kind, "cache_attempt_not_active");
        assert_eq!(
            state.data.as_ref().expect("data").active_cache_attempts["a"].token,
            current_token
        );

        success(state.execute(AppStateRequest::BeginSession {
            schema_version: 1,
            new_session: SessionArchiveSeed {
                file_name: "next.json".to_owned(),
                session_started_at: 13.0,
                items: Vec::new(),
            },
            now: 13.0,
        }));
        assert!(
            state
                .data
                .as_ref()
                .expect("data")
                .active_cache_attempts
                .is_empty()
        );
    }

    #[test]
    fn cache_attempt_tokens_survive_shutdown_reinitialize_and_overflow_atomically() {
        let mut state = AppState::default();
        let mut initial = seed();
        initial.current_item = Some(item("a", "BV-a", "Alice"));
        initialize(&mut state, initial.clone());
        let (first, first_response) = begin_cache_attempt(&mut state, "a");
        let first_reservation = cache_reservation(&first_response);
        success(state.execute(AppStateRequest::Shutdown { schema_version: 1 }));
        initialize(&mut state, initial);
        let (second, second_response) = begin_cache_attempt(&mut state, "a");
        let second_reservation = cache_reservation(&second_response);
        assert!(second > first);
        assert_ne!(
            first_reservation.item_incarnation_id,
            second_reservation.item_incarnation_id
        );
        let stale = failure(apply_cache(
            &mut state,
            "a",
            first,
            CacheEvent::Failed {
                message: "previous lifetime".to_owned(),
            },
            11.0,
        ));
        assert_eq!(stale.error.kind, "cache_attempt_superseded");

        state.next_cache_attempt_token = u64::MAX;
        let data_before = state.data.clone();
        let expected_item_incarnation_id = state
            .data
            .as_ref()
            .and_then(|data| data.find_item("a"))
            .expect("item")
            .item_incarnation_id
            .clone();
        let rejected = failure(state.execute(AppStateRequest::BeginCacheAttempt {
            schema_version: 1,
            item_id: "a".to_owned(),
            expected_item_incarnation_id,
        }));
        assert_eq!(rejected.error.kind, "cache_attempt_token_exhausted");
        assert_eq!(state.next_cache_attempt_token, u64::MAX);
        assert_eq!(state.data, data_before);
    }

    #[test]
    fn terminal_cache_publications_settle_once_and_replay_exactly() {
        let mut state = AppState::default();
        let mut initial = seed();
        initial.current_item = Some(item("a", "BV-a", "Alice"));
        initialize(&mut state, initial);
        let (token, _) = begin_cache_attempt(&mut state, "a");
        let terminal = CacheEvent::Failed {
            message: "network failed".to_owned(),
        };
        let accepted = success(apply_cache(&mut state, "a", token, terminal.clone(), 11.0));
        assert!(accepted.committed);
        let accepted_snapshot = accepted.snapshot.expect("accepted snapshot");

        let replay = success(apply_cache(&mut state, "a", token, terminal, 12.0));
        assert!(!replay.committed);
        assert_eq!(replay.result["replayed"], json!(true));
        assert_eq!(replay.effects, PersistenceEffects::default());
        assert_eq!(replay.snapshot, Some(accepted_snapshot.clone()));

        for (event, expected_kind) in [
            (
                CacheEvent::Failed {
                    message: "different failure".to_owned(),
                },
                "cache_terminal_conflict",
            ),
            (
                CacheEvent::Cancelled {
                    message: "different terminal".to_owned(),
                },
                "cache_terminal_conflict",
            ),
            (
                CacheEvent::Progress {
                    progress: 60.0,
                    message: None,
                },
                "cache_attempt_already_terminal",
            ),
        ] {
            let rejected = failure(apply_cache(&mut state, "a", token, event, 13.0));
            assert_eq!(rejected.error.kind, expected_kind);
            let snapshot = success(state.execute(AppStateRequest::Snapshot { schema_version: 1 }))
                .snapshot
                .expect("snapshot");
            assert_eq!(snapshot, accepted_snapshot);
        }
    }

    #[test]
    fn generic_update_item_is_metadata_only_and_preserves_committed_descriptor() {
        let mut state = AppState::default();
        let mut initial = seed();
        initial.current_item = Some(item("a", "BV-a", "Alice"));
        initialize(&mut state, initial);
        let (token, _) = begin_cache_attempt(&mut state, "a");
        let ready = ready_event(
            &state,
            "a",
            token,
            "committed.mp4",
            &[("original", "committed.m4a")],
            "original",
        );
        success(apply_cache(&mut state, "a", token, ready, 11.0));
        let before = state
            .data
            .as_ref()
            .expect("data")
            .find_item("a")
            .expect("item")
            .clone();

        success(state.execute(AppStateRequest::UpdateItem {
            schema_version: 1,
            item_id: "a".to_owned(),
            changes: PlaylistItemPatch {
                title: Some("enriched title".to_owned()),
                part_title: Some("enriched part".to_owned()),
                display_title: Some("enriched display".to_owned()),
                cover_url: Some("https://example.test/cover.jpg".to_owned()),
                embed_url: Some("https://example.test/embed".to_owned()),
                owner_mid: Some(42),
                owner_name: Some("enriched owner".to_owned()),
                owner_url: Some("https://example.test/owner".to_owned()),
            },
            persist_backup: false,
            now: 12.0,
        }));
        let after = state
            .data
            .as_ref()
            .expect("data")
            .find_item("a")
            .expect("item");
        assert_eq!(after.title, "enriched title");
        assert_eq!(after.owner_name, "enriched owner");

        let before_value = serde_json::to_value(&before).expect("serialize before item");
        let after_value = serde_json::to_value(after).expect("serialize after item");
        let protected_fields = [
            "original_url",
            "resolved_url",
            "bvid",
            "aid",
            "cid",
            "page",
            "selected_pages",
            "selected_cids",
            "selected_durations",
            "selected_parts",
            "available_pages",
            "available_cids",
            "available_durations",
            "available_parts",
            "video_page",
            "manual_selection",
            "audio_variants",
            "selected_audio_variant_id",
            "cache_status",
            "cache_progress",
            "cache_message",
            "video_relative_path",
            "video_media_url",
            "item_incarnation_id",
            "artifact_set_id",
            "artifact_relative_directory",
        ];
        for field in protected_fields {
            assert_eq!(before_value[field], after_value[field], "changed {field}");
            let mut changes = Map::new();
            changes.insert(field.to_owned(), before_value[field].clone());
            let request = json!({
                "command": "update_item",
                "schema_version": 1,
                "item_id": "a",
                "changes": changes,
                "persist_backup": false,
                "now": 13.0,
            });
            assert!(
                serde_json::from_value::<AppStateRequest>(request).is_err(),
                "UpdateItem accepted protected field {field}"
            );
        }
    }

    #[test]
    fn ready_preserves_newer_selection_then_uses_proposal_then_first_variant() {
        let mut state = AppState::default();
        let mut initial = seed();
        initial.current_item = Some(item("a", "BV-a", "Alice"));
        initialize(&mut state, initial);

        let (initial_fill, _) = begin_cache_attempt(&mut state, "a");
        let initial_ready = ready_event(
            &state,
            "a",
            initial_fill,
            "initial.mp4",
            &[
                ("original", "initial-original.m4a"),
                ("accompaniment", "initial-accompaniment.m4a"),
            ],
            "original",
        );
        success(apply_cache(
            &mut state,
            "a",
            initial_fill,
            initial_ready,
            10.5,
        ));
        success(state.execute(AppStateRequest::SetAudioVariant {
            schema_version: 1,
            item_id: "a".to_owned(),
            variant_id: "accompaniment".to_owned(),
            now: 11.0,
        }));
        let (first, _) = begin_cache_attempt(&mut state, "a");
        let first_ready = ready_event(
            &state,
            "a",
            first,
            "first.mp4",
            &[
                ("original", "first-original.m4a"),
                ("accompaniment", "first-accompaniment.m4a"),
            ],
            "original",
        );
        let preserved = success(apply_cache(&mut state, "a", first, first_ready, 12.0));
        assert_eq!(
            preserved
                .snapshot
                .as_ref()
                .expect("snapshot")
                .current_item
                .as_ref()
                .expect("current")
                .selected_audio_variant_id,
            "accompaniment"
        );

        let (second, _) = begin_cache_attempt(&mut state, "a");
        let second_ready = ready_event(
            &state,
            "a",
            second,
            "second.mp4",
            &[("first", "second-first.m4a"), ("proposal", "proposal.m4a")],
            "proposal",
        );
        let proposed = success(apply_cache(&mut state, "a", second, second_ready, 14.0));
        assert_eq!(
            proposed
                .snapshot
                .as_ref()
                .expect("snapshot")
                .current_item
                .as_ref()
                .expect("current")
                .selected_audio_variant_id,
            "proposal"
        );

        let (third, _) = begin_cache_attempt(&mut state, "a");
        let third_ready = ready_event(
            &state,
            "a",
            third,
            "third.mp4",
            &[
                ("deterministic-first", "first.m4a"),
                ("second", "second.m4a"),
            ],
            "missing-proposal",
        );
        let fallback = success(apply_cache(&mut state, "a", third, third_ready, 16.0));
        assert_eq!(
            fallback
                .snapshot
                .as_ref()
                .expect("snapshot")
                .current_item
                .as_ref()
                .expect("current")
                .selected_audio_variant_id,
            "deterministic-first"
        );
    }

    #[test]
    fn invalid_ready_payloads_leave_projection_and_attempt_unsettled() {
        let mut state = AppState::default();
        let mut initial = seed();
        initial.current_item = Some(item("a", "BV-a", "Alice"));
        let initial_snapshot = initialize(&mut state, initial);
        let (token, _) = begin_cache_attempt(&mut state, "a");
        let allocator = state.next_cache_attempt_token;

        let duplicate = ready_event(
            &state,
            "a",
            token,
            "duplicate.mp4",
            &[("same", "one.m4a"), ("same", "two.m4a")],
            "same",
        );
        let mut empty_path = ready_event(&state, "a", token, "video.mp4", &[("a", "a.m4a")], "a");
        let mut empty_video_url = empty_path.clone();
        let mut empty_variant_id = empty_path.clone();
        let mut empty_audio_url = empty_path.clone();
        let mut encoded_traversal = empty_path.clone();
        let mut malformed_proposal = empty_path.clone();
        let mut missing_identity = empty_path.clone();
        let mut duplicate_artifact_path = empty_path.clone();
        let mut contradictory_directory = empty_path.clone();
        if let CacheEvent::Ready {
            video_relative_path,
            ..
        } = &mut empty_path
        {
            video_relative_path.clear();
        }
        if let CacheEvent::Ready {
            video_media_url, ..
        } = &mut empty_video_url
        {
            video_media_url.clear();
        }
        if let CacheEvent::Ready { audio_variants, .. } = &mut empty_variant_id {
            audio_variants[0].insert("id".to_owned(), json!(""));
        }
        if let CacheEvent::Ready { audio_variants, .. } = &mut empty_audio_url {
            audio_variants[0].insert("audio_url".to_owned(), json!(""));
        }
        if let CacheEvent::Ready {
            video_media_url, ..
        } = &mut encoded_traversal
        {
            *video_media_url = "/media/a/%2e%2e/outside.mp4".to_owned();
        }
        if let CacheEvent::Ready {
            selected_audio_variant_id,
            ..
        } = &mut malformed_proposal
        {
            *selected_audio_variant_id = "bad\0proposal".to_owned();
        }
        if let CacheEvent::Ready {
            artifact_set_id, ..
        } = &mut missing_identity
        {
            artifact_set_id.clear();
        }
        if let CacheEvent::Ready {
            video_media_url,
            audio_variants,
            ..
        } = &mut duplicate_artifact_path
        {
            audio_variants[0].insert("audio_url".to_owned(), json!(video_media_url));
        }
        if let CacheEvent::Ready {
            artifact_relative_directory,
            ..
        } = &mut contradictory_directory
        {
            artifact_relative_directory.push_str("/different");
        }

        for event in [
            duplicate,
            empty_path,
            empty_video_url,
            empty_variant_id,
            empty_audio_url,
            encoded_traversal,
            malformed_proposal,
            missing_identity,
            duplicate_artifact_path,
            contradictory_directory,
        ] {
            let rejected = failure(apply_cache(&mut state, "a", token, event, 11.0));
            assert!(matches!(
                rejected.error.kind.as_str(),
                "invalid_cache_ready"
                    | "duplicate_audio_variant_id"
                    | "duplicate_artifact_path"
                    | "cache_publication_identity_mismatch"
            ));
            assert_eq!(state.next_cache_attempt_token, allocator);
            let data = state.data.as_ref().expect("data");
            assert_eq!(data.snapshot(), initial_snapshot);
            assert!(data.active_cache_attempts["a"].terminal_event.is_none());
        }
    }

    #[test]
    fn concurrent_callers_share_one_serial_authority() {
        let state = Arc::new(Mutex::new(AppState::default()));
        initialize(&mut state.lock().expect("lock"), seed());
        let mut workers = Vec::new();
        for value in 1..=8 {
            let state = Arc::clone(&state);
            workers.push(thread::spawn(move || {
                state
                    .lock()
                    .expect("lock")
                    .execute(AppStateRequest::SetVolume {
                        schema_version: 1,
                        volume_percent: value,
                        now: 10.0 + f64::from(value),
                    })
            }));
        }
        for worker in workers {
            assert!(matches!(
                worker.join().expect("worker"),
                AppStateResponse::Success(_)
            ));
        }
        let snapshot = success(
            state
                .lock()
                .expect("lock")
                .execute(AppStateRequest::Snapshot { schema_version: 1 }),
        )
        .snapshot
        .expect("snapshot");
        assert_eq!(snapshot.revision, 9);
    }

    #[test]
    fn request_contract_distinguishes_invalid_uninitialized_and_shutdown() {
        let invalid: Value =
            serde_json::from_str(&execute_app_state_json("{}")).expect("invalid response JSON");
        assert_eq!(invalid["status"], "invalid_request");
        let legacy_generation: Value = serde_json::from_str(&execute_app_state_json(
            r#"{"command":"apply_cache_event","schema_version":1,"item_id":"a","generation":0,"event":{"kind":"queued","message":"legacy"},"now":1.0}"#,
        ))
        .expect("legacy generation response JSON");
        assert_eq!(legacy_generation["status"], "invalid_request");

        let mut state = AppState::default();
        let uninitialized = failure(state.execute(AppStateRequest::Snapshot { schema_version: 1 }));
        assert_eq!(uninitialized.status, "uninitialized");
        initialize(&mut state, seed());
        let shutdown = success(state.execute(AppStateRequest::Shutdown { schema_version: 1 }));
        assert!(shutdown.committed);
        let after = failure(state.execute(AppStateRequest::Snapshot { schema_version: 1 }));
        assert_eq!(after.status, "uninitialized");
    }
}
