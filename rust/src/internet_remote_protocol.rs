use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;

pub const INTERNET_REMOTE_PROTOCOL_VERSION: u16 = 1;
pub const MAX_CONTROL_MESSAGE_BYTES: usize = 16 * 1024;
pub const MAX_SAFE_JSON_INTEGER: u64 = 9_007_199_254_740_991;
pub const MAX_SEARCH_RESULTS: u16 = 80;
pub const MAX_BROWSE_RESULTS: u16 = 100;
pub const MAX_REMOTE_STATE_ITEMS: usize = 1_000;

const MAX_EPOCH_BYTES: usize = 22;
const MAX_CATALOG_ID_BYTES: usize = 128;
const MAX_ITEM_ID_BYTES: usize = 512;
const MAX_AUDIO_VARIANT_ID_BYTES: usize = 128;
const MAX_SEARCH_QUERY_BYTES: usize = 400;
const MAX_SEARCH_QUERY_CHARS: usize = 100;
const MAX_BROWSE_FILTER_BYTES: usize = 400;
const MAX_BROWSE_FILTER_CHARS: usize = 100;
const MAX_BROWSE_TAGS: usize = 10;
const MAX_GATCHA_EXCLUSIONS: usize = 256;
const MAX_NUMERIC_ID_BYTES: usize = 24;
const MAX_SESSION_NAME_BYTES: usize = 96;
const MAX_SESSION_NAME_CHARS: usize = 24;
const MAX_SEEK_DELTA_SECONDS: i32 = 300;
const MAX_AV_DELAY_MS: i32 = 5_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RemoteLane {
    Control,
    Bulk,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RemoteProfile {
    Viewer,
    Controller,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RemotePlaylistPositionV1 {
    #[default]
    Tail,
    Next,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteCapability {
    ConnectionHealth,
    StateRead,
    CatalogRead,
    PlaylistWrite,
    PlaybackControl,
    PlayerSettingsWrite,
    SessionIdentityWrite,
    RatingWrite,
    CacheRetry,
    GatchaManage,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteOperation {
    ConnectionHealth,
    StateGet,
    CatalogSearch,
    CatalogBrowse,
    CatalogCategoryBrowse,
    SongDetail,
    GatchaSearch,
    GatchaBrowse,
    GatchaFavlistBrowse,
    GatchaPoolConfigGet,
    GatchaCandidate,
    GatchaPoolConfigSet,
    GatchaUidPreview,
    GatchaUidAdd,
    GatchaRefresh,
    GatchaFavlistPreview,
    GatchaFavlistRefresh,
    PlaylistAdd,
    PlaylistRemove,
    PlaylistMove,
    PlaylistResort,
    PlaylistMoveNext,
    PlaylistPlayNow,
    PlaybackPlay,
    PlaybackPause,
    PlaybackToggle,
    PlaybackSeekRelative,
    PlaybackNext,
    PlayerSetVolume,
    PlayerSetMuted,
    PlayerSetKeyShift,
    PlayerSetAudioVariant,
    PlayerSetAvDelay,
    SessionSetIdentity,
    RatingSubmit,
    CacheRetry,
}

impl RemoteOperation {
    pub const fn capability(self) -> RemoteCapability {
        match self {
            Self::ConnectionHealth => RemoteCapability::ConnectionHealth,
            Self::StateGet => RemoteCapability::StateRead,
            Self::CatalogSearch
            | Self::CatalogBrowse
            | Self::CatalogCategoryBrowse
            | Self::SongDetail
            | Self::GatchaSearch
            | Self::GatchaBrowse
            | Self::GatchaFavlistBrowse
            | Self::GatchaPoolConfigGet
            | Self::GatchaCandidate => RemoteCapability::CatalogRead,
            Self::PlaylistAdd
            | Self::PlaylistRemove
            | Self::PlaylistMove
            | Self::PlaylistResort
            | Self::PlaylistMoveNext
            | Self::PlaylistPlayNow => RemoteCapability::PlaylistWrite,
            Self::PlaybackPlay
            | Self::PlaybackPause
            | Self::PlaybackToggle
            | Self::PlaybackSeekRelative
            | Self::PlaybackNext => RemoteCapability::PlaybackControl,
            Self::PlayerSetVolume
            | Self::PlayerSetMuted
            | Self::PlayerSetKeyShift
            | Self::PlayerSetAudioVariant
            | Self::PlayerSetAvDelay => RemoteCapability::PlayerSettingsWrite,
            Self::SessionSetIdentity => RemoteCapability::SessionIdentityWrite,
            Self::RatingSubmit => RemoteCapability::RatingWrite,
            Self::CacheRetry => RemoteCapability::CacheRetry,
            Self::GatchaPoolConfigSet
            | Self::GatchaUidPreview
            | Self::GatchaUidAdd
            | Self::GatchaRefresh
            | Self::GatchaFavlistPreview
            | Self::GatchaFavlistRefresh => RemoteCapability::GatchaManage,
        }
    }
}

pub const fn profile_allows(profile: RemoteProfile, operation: RemoteOperation) -> bool {
    match profile {
        RemoteProfile::Viewer => matches!(
            operation.capability(),
            RemoteCapability::ConnectionHealth
                | RemoteCapability::StateRead
                | RemoteCapability::CatalogRead
        ),
        RemoteProfile::Controller => matches!(
            operation.capability(),
            RemoteCapability::ConnectionHealth
                | RemoteCapability::StateRead
                | RemoteCapability::CatalogRead
                | RemoteCapability::PlaylistWrite
                | RemoteCapability::PlaybackControl
                | RemoteCapability::PlayerSettingsWrite
                | RemoteCapability::SessionIdentityWrite
                | RemoteCapability::RatingWrite
                | RemoteCapability::CacheRetry
                | RemoteCapability::GatchaManage
        ),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RemoteCatalogBrowseKindV1 {
    Name,
    Artist,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", content = "body")]
pub enum RemoteRequestV1 {
    #[serde(rename = "connection.health")]
    ConnectionHealth,
    #[serde(rename = "state.get")]
    StateGet { since_revision: Option<u64> },
    #[serde(rename = "catalog.search")]
    CatalogSearch { query: String, limit: u16 },
    #[serde(rename = "catalog.browse")]
    CatalogBrowse {
        kind: RemoteCatalogBrowseKindV1,
        letter: String,
        query: String,
        tag: String,
        locale: String,
        limit: u16,
    },
    #[serde(rename = "catalog.category_browse")]
    CatalogCategoryBrowse {
        tags: Vec<String>,
        tag45s: Vec<String>,
        query: String,
        offset: u32,
        limit: u16,
    },
    #[serde(rename = "catalog.song_detail")]
    SongDetail { catalog_item_id: String },
    #[serde(rename = "gatcha.search")]
    GatchaSearch { query: String, limit: u16 },
    #[serde(rename = "gatcha.browse")]
    GatchaBrowse { uid: String, query: String },
    #[serde(rename = "gatcha.favlist_browse")]
    GatchaFavlistBrowse { folder_id: String, query: String },
    #[serde(rename = "gatcha.pool_config_get")]
    GatchaPoolConfigGet,
    #[serde(rename = "gatcha.candidate")]
    GatchaCandidate,
    #[serde(rename = "gatcha.pool_config_set")]
    GatchaPoolConfigSet {
        uid_weight: u8,
        favlist_weight: u8,
        excluded_uids: Vec<String>,
        excluded_favlist_folders: Vec<String>,
    },
    #[serde(rename = "gatcha.uid_preview")]
    GatchaUidPreview { uid: String },
    #[serde(rename = "gatcha.uid_add")]
    GatchaUidAdd { uid: String },
    #[serde(rename = "gatcha.refresh")]
    GatchaRefresh,
    #[serde(rename = "gatcha.favlist_preview")]
    GatchaFavlistPreview { uid: String },
    #[serde(rename = "gatcha.favlist_refresh")]
    GatchaFavlistRefresh {
        uid: String,
        folder_ids: Vec<String>,
    },
    #[serde(rename = "playlist.add")]
    PlaylistAdd {
        catalog_item_id: String,
        position: RemotePlaylistPositionV1,
        allow_repeat: bool,
        expected_revision: u64,
    },
    #[serde(rename = "playlist.remove")]
    PlaylistRemove {
        item_id: String,
        expected_revision: u64,
    },
    #[serde(rename = "playlist.move")]
    PlaylistMove {
        item_id: String,
        target_index: u32,
        expected_revision: u64,
    },
    #[serde(rename = "playlist.resort")]
    PlaylistResort { expected_revision: u64 },
    #[serde(rename = "playlist.move_next")]
    PlaylistMoveNext {
        item_id: String,
        expected_revision: u64,
    },
    #[serde(rename = "playlist.play_now")]
    PlaylistPlayNow {
        item_id: String,
        expected_revision: u64,
    },
    #[serde(rename = "playback.play")]
    PlaybackPlay,
    #[serde(rename = "playback.pause")]
    PlaybackPause,
    #[serde(rename = "playback.toggle")]
    PlaybackToggle,
    #[serde(rename = "playback.seek_relative")]
    PlaybackSeekRelative { delta_seconds: i32 },
    #[serde(rename = "playback.next")]
    PlaybackNext,
    #[serde(rename = "player.set_volume")]
    PlayerSetVolume { volume_percent: u8 },
    #[serde(rename = "player.set_muted")]
    PlayerSetMuted { is_muted: bool },
    #[serde(rename = "player.set_key_shift")]
    PlayerSetKeyShift { key_shift: i8 },
    #[serde(rename = "player.set_audio_variant")]
    PlayerSetAudioVariant {
        item_id: String,
        variant_id: String,
        expected_revision: u64,
    },
    #[serde(rename = "player.set_av_delay")]
    PlayerSetAvDelay { effective_delay_ms: i32 },
    #[serde(rename = "session.set_identity")]
    SessionSetIdentity { name: String },
    #[serde(rename = "rating.submit")]
    RatingSubmit { play_id: String, score: u8 },
    #[serde(rename = "cache.retry")]
    CacheRetry {
        item_id: String,
        expected_revision: u64,
    },
}

impl RemoteRequestV1 {
    pub const fn operation(&self) -> RemoteOperation {
        match self {
            Self::ConnectionHealth => RemoteOperation::ConnectionHealth,
            Self::StateGet { .. } => RemoteOperation::StateGet,
            Self::CatalogSearch { .. } => RemoteOperation::CatalogSearch,
            Self::CatalogBrowse { .. } => RemoteOperation::CatalogBrowse,
            Self::CatalogCategoryBrowse { .. } => RemoteOperation::CatalogCategoryBrowse,
            Self::SongDetail { .. } => RemoteOperation::SongDetail,
            Self::GatchaSearch { .. } => RemoteOperation::GatchaSearch,
            Self::GatchaBrowse { .. } => RemoteOperation::GatchaBrowse,
            Self::GatchaFavlistBrowse { .. } => RemoteOperation::GatchaFavlistBrowse,
            Self::GatchaPoolConfigGet => RemoteOperation::GatchaPoolConfigGet,
            Self::GatchaCandidate => RemoteOperation::GatchaCandidate,
            Self::GatchaPoolConfigSet { .. } => RemoteOperation::GatchaPoolConfigSet,
            Self::GatchaUidPreview { .. } => RemoteOperation::GatchaUidPreview,
            Self::GatchaUidAdd { .. } => RemoteOperation::GatchaUidAdd,
            Self::GatchaRefresh => RemoteOperation::GatchaRefresh,
            Self::GatchaFavlistPreview { .. } => RemoteOperation::GatchaFavlistPreview,
            Self::GatchaFavlistRefresh { .. } => RemoteOperation::GatchaFavlistRefresh,
            Self::PlaylistAdd { .. } => RemoteOperation::PlaylistAdd,
            Self::PlaylistRemove { .. } => RemoteOperation::PlaylistRemove,
            Self::PlaylistMove { .. } => RemoteOperation::PlaylistMove,
            Self::PlaylistResort { .. } => RemoteOperation::PlaylistResort,
            Self::PlaylistMoveNext { .. } => RemoteOperation::PlaylistMoveNext,
            Self::PlaylistPlayNow { .. } => RemoteOperation::PlaylistPlayNow,
            Self::PlaybackPlay => RemoteOperation::PlaybackPlay,
            Self::PlaybackPause => RemoteOperation::PlaybackPause,
            Self::PlaybackToggle => RemoteOperation::PlaybackToggle,
            Self::PlaybackSeekRelative { .. } => RemoteOperation::PlaybackSeekRelative,
            Self::PlaybackNext => RemoteOperation::PlaybackNext,
            Self::PlayerSetVolume { .. } => RemoteOperation::PlayerSetVolume,
            Self::PlayerSetMuted { .. } => RemoteOperation::PlayerSetMuted,
            Self::PlayerSetKeyShift { .. } => RemoteOperation::PlayerSetKeyShift,
            Self::PlayerSetAudioVariant { .. } => RemoteOperation::PlayerSetAudioVariant,
            Self::PlayerSetAvDelay { .. } => RemoteOperation::PlayerSetAvDelay,
            Self::SessionSetIdentity { .. } => RemoteOperation::SessionSetIdentity,
            Self::RatingSubmit { .. } => RemoteOperation::RatingSubmit,
            Self::CacheRetry { .. } => RemoteOperation::CacheRetry,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RemoteRequestEnvelopeV1 {
    pub v: u16,
    pub lane: RemoteLane,
    pub epoch: String,
    pub seq: u64,
    pub id: String,
    #[serde(flatten)]
    pub request: RemoteRequestV1,
}

#[derive(Debug, Clone, Copy)]
pub struct RemoteValidationContext<'a> {
    pub expected_lane: RemoteLane,
    pub expected_epoch: &'a str,
    pub last_sequence: Option<u64>,
    pub profile: RemoteProfile,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteProtocolError {
    MessageTooLarge,
    MalformedEnvelope,
    UnsupportedVersion,
    InvalidLane,
    InvalidEpoch,
    StaleEpoch,
    InvalidSequence,
    ReplayedSequence,
    InvalidRequestId,
    UnknownRequestKind,
    InvalidRequestBody,
    CapabilityDenied,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WireEnvelope {
    v: u16,
    lane: RemoteLane,
    epoch: String,
    seq: u64,
    id: String,
    kind: String,
    body: Value,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyBody {}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct StateGetBody {
    since_revision: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CatalogSearchBody {
    query: String,
    limit: u16,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CatalogBrowseBody {
    kind: RemoteCatalogBrowseKindV1,
    letter: String,
    query: String,
    tag: String,
    locale: String,
    limit: u16,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CatalogCategoryBrowseBody {
    tags: Vec<String>,
    tag45s: Vec<String>,
    query: String,
    offset: u32,
    limit: u16,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct GatchaBrowseBody {
    uid: String,
    query: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct GatchaFavlistBrowseBody {
    folder_id: String,
    query: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct GatchaPoolConfigBody {
    uid_weight: u8,
    favlist_weight: u8,
    excluded_uids: Vec<String>,
    excluded_favlist_folders: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct GatchaUidBody {
    uid: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct GatchaFavlistRefreshBody {
    uid: String,
    folder_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CatalogItemBody {
    catalog_item_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CatalogMutationBody {
    catalog_item_id: String,
    #[serde(default)]
    position: RemotePlaylistPositionV1,
    #[serde(default)]
    allow_repeat: bool,
    expected_revision: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ItemMutationBody {
    item_id: String,
    expected_revision: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct MoveItemBody {
    item_id: String,
    target_index: u32,
    expected_revision: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RevisionBody {
    expected_revision: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SeekRelativeBody {
    delta_seconds: i32,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct VolumeBody {
    volume_percent: u8,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct MutedBody {
    is_muted: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct KeyShiftBody {
    key_shift: i8,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AudioVariantBody {
    item_id: String,
    variant_id: String,
    expected_revision: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AvDelayBody {
    effective_delay_ms: i32,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct IdentityBody {
    name: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RatingBody {
    play_id: String,
    score: u8,
}

fn body<T: DeserializeOwned>(value: Value) -> Result<T, RemoteProtocolError> {
    serde_json::from_value(value).map_err(|_| RemoteProtocolError::InvalidRequestBody)
}

fn valid_text(value: &str, max_bytes: usize, max_chars: usize) -> bool {
    !value.contains('\0')
        && !value.chars().any(char::is_control)
        && !value.is_empty()
        && value.len() <= max_bytes
        && value.chars().count() <= max_chars
        && !value.trim().is_empty()
}

fn valid_optional_text(value: &str, max_bytes: usize, max_chars: usize) -> bool {
    value.is_empty()
        || (!value.contains('\0')
            && !value.chars().any(char::is_control)
            && value.len() <= max_bytes
            && value.chars().count() <= max_chars
            && value.trim() == value)
}

fn valid_numeric_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_NUMERIC_ID_BYTES
        && !value.starts_with('0')
        && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn valid_optional_numeric_id(value: &str) -> bool {
    value.is_empty() || valid_numeric_id(value)
}

fn valid_folder_selector(value: &str) -> bool {
    if let Some((uid, folder_id)) = value.split_once(':') {
        valid_numeric_id(uid) && valid_numeric_id(folder_id) && !folder_id.contains(':')
    } else {
        valid_numeric_id(value)
    }
}

fn valid_browse_tags(values: &[String]) -> bool {
    values.len() <= MAX_BROWSE_TAGS
        && values
            .iter()
            .all(|value| valid_text(value, MAX_BROWSE_FILTER_BYTES, MAX_BROWSE_FILTER_CHARS))
}

fn valid_exclusions(values: &[String], validator: impl Fn(&str) -> bool) -> bool {
    values.len() <= MAX_GATCHA_EXCLUSIONS && values.iter().all(|value| validator(value))
}

fn valid_base64url(value: &str, exact_bytes: usize) -> bool {
    value.len() == exact_bytes
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn valid_uuid_v4(value: &str) -> bool {
    if value.len() != 36 {
        return false;
    }
    let bytes = value.as_bytes();
    for (index, byte) in bytes.iter().copied().enumerate() {
        if matches!(index, 8 | 13 | 18 | 23) {
            if byte != b'-' {
                return false;
            }
        } else if !byte.is_ascii_hexdigit() {
            return false;
        }
    }
    bytes[14] == b'4' && matches!(bytes[19].to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b')
}

fn valid_revision(value: u64) -> bool {
    value <= MAX_SAFE_JSON_INTEGER
}

fn validate_request(request: &RemoteRequestV1) -> Result<(), RemoteProtocolError> {
    let valid_item = |value: &str| valid_text(value, MAX_ITEM_ID_BYTES, MAX_ITEM_ID_BYTES);
    let valid_catalog = |value: &str| valid_catalog_item_id(value);
    let valid_expected = |value: u64| valid_revision(value);
    let valid = match request {
        RemoteRequestV1::ConnectionHealth
        | RemoteRequestV1::PlaybackPlay
        | RemoteRequestV1::PlaybackPause
        | RemoteRequestV1::PlaybackToggle
        | RemoteRequestV1::PlaybackNext
        | RemoteRequestV1::GatchaPoolConfigGet
        | RemoteRequestV1::GatchaCandidate
        | RemoteRequestV1::GatchaRefresh => true,
        RemoteRequestV1::StateGet { since_revision } => since_revision.is_none_or(valid_revision),
        RemoteRequestV1::CatalogSearch { query, limit }
        | RemoteRequestV1::GatchaSearch { query, limit } => {
            valid_text(query, MAX_SEARCH_QUERY_BYTES, MAX_SEARCH_QUERY_CHARS)
                && (1..=MAX_SEARCH_RESULTS).contains(limit)
        }
        RemoteRequestV1::CatalogBrowse {
            letter,
            query,
            tag,
            locale,
            limit,
            ..
        } => {
            valid_optional_text(letter, 8, 2)
                && valid_optional_text(query, MAX_BROWSE_FILTER_BYTES, MAX_BROWSE_FILTER_CHARS)
                && valid_optional_text(tag, MAX_BROWSE_FILTER_BYTES, MAX_BROWSE_FILTER_CHARS)
                && valid_optional_text(locale, 32, 16)
                && (1..=MAX_BROWSE_RESULTS).contains(limit)
        }
        RemoteRequestV1::CatalogCategoryBrowse {
            tags,
            tag45s,
            query,
            limit,
            ..
        } => {
            valid_browse_tags(tags)
                && valid_browse_tags(tag45s)
                && valid_optional_text(query, MAX_BROWSE_FILTER_BYTES, MAX_BROWSE_FILTER_CHARS)
                && (1..=MAX_BROWSE_RESULTS).contains(limit)
        }
        RemoteRequestV1::SongDetail { catalog_item_id } => valid_catalog(catalog_item_id),
        RemoteRequestV1::GatchaBrowse { uid, query } => {
            valid_optional_numeric_id(uid)
                && valid_optional_text(query, MAX_BROWSE_FILTER_BYTES, MAX_BROWSE_FILTER_CHARS)
        }
        RemoteRequestV1::GatchaFavlistBrowse { folder_id, query } => {
            (folder_id.is_empty() || valid_folder_selector(folder_id))
                && valid_optional_text(query, MAX_BROWSE_FILTER_BYTES, MAX_BROWSE_FILTER_CHARS)
        }
        RemoteRequestV1::GatchaPoolConfigSet {
            uid_weight,
            favlist_weight,
            excluded_uids,
            excluded_favlist_folders,
        } => {
            *uid_weight <= 100
                && *favlist_weight <= 100
                && u16::from(*uid_weight) + u16::from(*favlist_weight) == 100
                && valid_exclusions(excluded_uids, valid_numeric_id)
                && valid_exclusions(excluded_favlist_folders, valid_folder_selector)
        }
        RemoteRequestV1::GatchaUidPreview { uid }
        | RemoteRequestV1::GatchaUidAdd { uid }
        | RemoteRequestV1::GatchaFavlistPreview { uid } => valid_numeric_id(uid),
        RemoteRequestV1::GatchaFavlistRefresh { uid, folder_ids } => {
            valid_numeric_id(uid)
                && !folder_ids.is_empty()
                && valid_exclusions(folder_ids, valid_numeric_id)
        }
        RemoteRequestV1::PlaylistAdd {
            catalog_item_id,
            expected_revision,
            ..
        } => valid_catalog(catalog_item_id) && valid_expected(*expected_revision),
        RemoteRequestV1::PlaylistRemove {
            item_id,
            expected_revision,
        }
        | RemoteRequestV1::PlaylistMoveNext {
            item_id,
            expected_revision,
        }
        | RemoteRequestV1::PlaylistPlayNow {
            item_id,
            expected_revision,
        }
        | RemoteRequestV1::CacheRetry {
            item_id,
            expected_revision,
        } => valid_item(item_id) && valid_expected(*expected_revision),
        RemoteRequestV1::PlaylistMove {
            item_id,
            target_index,
            expected_revision,
        } => {
            valid_item(item_id)
                && (*target_index as usize) < MAX_REMOTE_STATE_ITEMS
                && valid_expected(*expected_revision)
        }
        RemoteRequestV1::PlaylistResort { expected_revision } => valid_expected(*expected_revision),
        RemoteRequestV1::PlaybackSeekRelative { delta_seconds } => {
            *delta_seconds != 0
                && (-MAX_SEEK_DELTA_SECONDS..=MAX_SEEK_DELTA_SECONDS).contains(delta_seconds)
        }
        RemoteRequestV1::PlayerSetVolume { volume_percent } => *volume_percent <= 100,
        RemoteRequestV1::PlayerSetMuted { .. } => true,
        RemoteRequestV1::PlayerSetKeyShift { key_shift } => (-6..=6).contains(key_shift),
        RemoteRequestV1::PlayerSetAudioVariant {
            item_id,
            variant_id,
            expected_revision,
        } => {
            valid_item(item_id)
                && valid_text(
                    variant_id,
                    MAX_AUDIO_VARIANT_ID_BYTES,
                    MAX_AUDIO_VARIANT_ID_BYTES,
                )
                && valid_expected(*expected_revision)
        }
        RemoteRequestV1::PlayerSetAvDelay { effective_delay_ms } => {
            (-MAX_AV_DELAY_MS..=MAX_AV_DELAY_MS).contains(effective_delay_ms)
        }
        RemoteRequestV1::SessionSetIdentity { name } => {
            valid_text(name, MAX_SESSION_NAME_BYTES, MAX_SESSION_NAME_CHARS)
        }
        RemoteRequestV1::RatingSubmit { play_id, score } => {
            valid_item(play_id) && (1..=5).contains(score)
        }
    };
    valid
        .then_some(())
        .ok_or(RemoteProtocolError::InvalidRequestBody)
}

fn valid_catalog_item_id(value: &str) -> bool {
    if value.len() > MAX_CATALOG_ID_BYTES {
        return false;
    }
    let (bvid, page) = value.split_once("_p").unwrap_or((value, ""));
    if bvid.len() != 12
        || !bvid.starts_with("BV")
        || !bvid[2..].bytes().all(|byte| byte.is_ascii_alphanumeric())
    {
        return false;
    }
    page.is_empty()
        || (page.len() <= 6
            && !page.starts_with('0')
            && page.bytes().all(|byte| byte.is_ascii_digit()))
}

fn parse_request(kind: &str, value: Value) -> Result<RemoteRequestV1, RemoteProtocolError> {
    let request = match kind {
        "connection.health" => {
            let _: EmptyBody = body(value)?;
            RemoteRequestV1::ConnectionHealth
        }
        "state.get" => {
            let body: StateGetBody = body(value)?;
            RemoteRequestV1::StateGet {
                since_revision: body.since_revision,
            }
        }
        "catalog.search" => {
            let body: CatalogSearchBody = body(value)?;
            RemoteRequestV1::CatalogSearch {
                query: body.query,
                limit: body.limit,
            }
        }
        "catalog.browse" => {
            let body: CatalogBrowseBody = body(value)?;
            RemoteRequestV1::CatalogBrowse {
                kind: body.kind,
                letter: body.letter,
                query: body.query,
                tag: body.tag,
                locale: body.locale,
                limit: body.limit,
            }
        }
        "catalog.category_browse" => {
            let body: CatalogCategoryBrowseBody = body(value)?;
            RemoteRequestV1::CatalogCategoryBrowse {
                tags: body.tags,
                tag45s: body.tag45s,
                query: body.query,
                offset: body.offset,
                limit: body.limit,
            }
        }
        "catalog.song_detail" => {
            let body: CatalogItemBody = body(value)?;
            RemoteRequestV1::SongDetail {
                catalog_item_id: body.catalog_item_id,
            }
        }
        "gatcha.search" => {
            let body: CatalogSearchBody = body(value)?;
            RemoteRequestV1::GatchaSearch {
                query: body.query,
                limit: body.limit,
            }
        }
        "gatcha.browse" => {
            let body: GatchaBrowseBody = body(value)?;
            RemoteRequestV1::GatchaBrowse {
                uid: body.uid,
                query: body.query,
            }
        }
        "gatcha.favlist_browse" => {
            let body: GatchaFavlistBrowseBody = body(value)?;
            RemoteRequestV1::GatchaFavlistBrowse {
                folder_id: body.folder_id,
                query: body.query,
            }
        }
        "gatcha.pool_config_get" | "gatcha.candidate" | "gatcha.refresh" => {
            let _: EmptyBody = body(value)?;
            match kind {
                "gatcha.pool_config_get" => RemoteRequestV1::GatchaPoolConfigGet,
                "gatcha.candidate" => RemoteRequestV1::GatchaCandidate,
                _ => RemoteRequestV1::GatchaRefresh,
            }
        }
        "gatcha.pool_config_set" => {
            let body: GatchaPoolConfigBody = body(value)?;
            RemoteRequestV1::GatchaPoolConfigSet {
                uid_weight: body.uid_weight,
                favlist_weight: body.favlist_weight,
                excluded_uids: body.excluded_uids,
                excluded_favlist_folders: body.excluded_favlist_folders,
            }
        }
        "gatcha.uid_preview" | "gatcha.uid_add" | "gatcha.favlist_preview" => {
            let body: GatchaUidBody = body(value)?;
            match kind {
                "gatcha.uid_preview" => RemoteRequestV1::GatchaUidPreview { uid: body.uid },
                "gatcha.uid_add" => RemoteRequestV1::GatchaUidAdd { uid: body.uid },
                _ => RemoteRequestV1::GatchaFavlistPreview { uid: body.uid },
            }
        }
        "gatcha.favlist_refresh" => {
            let body: GatchaFavlistRefreshBody = body(value)?;
            RemoteRequestV1::GatchaFavlistRefresh {
                uid: body.uid,
                folder_ids: body.folder_ids,
            }
        }
        "playlist.add" => {
            let body: CatalogMutationBody = body(value)?;
            RemoteRequestV1::PlaylistAdd {
                catalog_item_id: body.catalog_item_id,
                position: body.position,
                allow_repeat: body.allow_repeat,
                expected_revision: body.expected_revision,
            }
        }
        "playlist.remove" | "playlist.move_next" | "playlist.play_now" | "cache.retry" => {
            let body: ItemMutationBody = body(value)?;
            match kind {
                "playlist.remove" => RemoteRequestV1::PlaylistRemove {
                    item_id: body.item_id,
                    expected_revision: body.expected_revision,
                },
                "playlist.move_next" => RemoteRequestV1::PlaylistMoveNext {
                    item_id: body.item_id,
                    expected_revision: body.expected_revision,
                },
                "playlist.play_now" => RemoteRequestV1::PlaylistPlayNow {
                    item_id: body.item_id,
                    expected_revision: body.expected_revision,
                },
                _ => RemoteRequestV1::CacheRetry {
                    item_id: body.item_id,
                    expected_revision: body.expected_revision,
                },
            }
        }
        "playlist.move" => {
            let body: MoveItemBody = body(value)?;
            RemoteRequestV1::PlaylistMove {
                item_id: body.item_id,
                target_index: body.target_index,
                expected_revision: body.expected_revision,
            }
        }
        "playlist.resort" => {
            let body: RevisionBody = body(value)?;
            RemoteRequestV1::PlaylistResort {
                expected_revision: body.expected_revision,
            }
        }
        "playback.play" | "playback.pause" | "playback.toggle" | "playback.next" => {
            let _: EmptyBody = body(value)?;
            match kind {
                "playback.play" => RemoteRequestV1::PlaybackPlay,
                "playback.pause" => RemoteRequestV1::PlaybackPause,
                "playback.toggle" => RemoteRequestV1::PlaybackToggle,
                _ => RemoteRequestV1::PlaybackNext,
            }
        }
        "playback.seek_relative" => {
            let body: SeekRelativeBody = body(value)?;
            RemoteRequestV1::PlaybackSeekRelative {
                delta_seconds: body.delta_seconds,
            }
        }
        "player.set_volume" => {
            let body: VolumeBody = body(value)?;
            RemoteRequestV1::PlayerSetVolume {
                volume_percent: body.volume_percent,
            }
        }
        "player.set_muted" => {
            let body: MutedBody = body(value)?;
            RemoteRequestV1::PlayerSetMuted {
                is_muted: body.is_muted,
            }
        }
        "player.set_key_shift" => {
            let body: KeyShiftBody = body(value)?;
            RemoteRequestV1::PlayerSetKeyShift {
                key_shift: body.key_shift,
            }
        }
        "player.set_audio_variant" => {
            let body: AudioVariantBody = body(value)?;
            RemoteRequestV1::PlayerSetAudioVariant {
                item_id: body.item_id,
                variant_id: body.variant_id,
                expected_revision: body.expected_revision,
            }
        }
        "player.set_av_delay" => {
            let body: AvDelayBody = body(value)?;
            RemoteRequestV1::PlayerSetAvDelay {
                effective_delay_ms: body.effective_delay_ms,
            }
        }
        "session.set_identity" => {
            let body: IdentityBody = body(value)?;
            RemoteRequestV1::SessionSetIdentity { name: body.name }
        }
        "rating.submit" => {
            let body: RatingBody = body(value)?;
            RemoteRequestV1::RatingSubmit {
                play_id: body.play_id,
                score: body.score,
            }
        }
        _ => return Err(RemoteProtocolError::UnknownRequestKind),
    };
    validate_request(&request)?;
    Ok(request)
}

pub fn decode_remote_request_v1(
    message: &str,
    context: RemoteValidationContext<'_>,
) -> Result<RemoteRequestEnvelopeV1, RemoteProtocolError> {
    if message.len() > MAX_CONTROL_MESSAGE_BYTES {
        return Err(RemoteProtocolError::MessageTooLarge);
    }
    let wire: WireEnvelope =
        serde_json::from_str(message).map_err(|_| RemoteProtocolError::MalformedEnvelope)?;
    if wire.v != INTERNET_REMOTE_PROTOCOL_VERSION {
        return Err(RemoteProtocolError::UnsupportedVersion);
    }
    if wire.lane != context.expected_lane {
        return Err(RemoteProtocolError::InvalidLane);
    }
    if !valid_base64url(&wire.epoch, MAX_EPOCH_BYTES)
        || !valid_base64url(context.expected_epoch, MAX_EPOCH_BYTES)
    {
        return Err(RemoteProtocolError::InvalidEpoch);
    }
    if wire.epoch != context.expected_epoch {
        return Err(RemoteProtocolError::StaleEpoch);
    }
    if wire.seq == 0 || wire.seq > MAX_SAFE_JSON_INTEGER {
        return Err(RemoteProtocolError::InvalidSequence);
    }
    if context
        .last_sequence
        .is_some_and(|last_sequence| wire.seq <= last_sequence)
    {
        return Err(RemoteProtocolError::ReplayedSequence);
    }
    if !valid_uuid_v4(&wire.id) {
        return Err(RemoteProtocolError::InvalidRequestId);
    }
    let request = parse_request(&wire.kind, wire.body)?;
    if !profile_allows(context.profile, request.operation()) {
        return Err(RemoteProtocolError::CapabilityDenied);
    }
    Ok(RemoteRequestEnvelopeV1 {
        v: wire.v,
        lane: wire.lane,
        epoch: wire.epoch,
        seq: wire.seq,
        id: wire.id,
        request,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RemotePlaybackModeV1 {
    Local,
    Online,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RemoteCacheStatusV1 {
    Pending,
    Queued,
    Downloading,
    Ready,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RemoteAudioVariantV1 {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RemotePlaylistItemV1 {
    pub id: String,
    pub bvid: String,
    pub page: u32,
    pub display_title: String,
    pub cover_url: String,
    pub owner_mid: u64,
    pub owner_name: String,
    pub requester_name: String,
    pub cache_status: RemoteCacheStatusV1,
    pub cache_progress: f32,
    pub audio_variants: Vec<RemoteAudioVariantV1>,
    pub selected_audio_variant_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RemotePlayerSettingsV1 {
    pub effective_av_delay_ms: i32,
    pub av_delay_locked: bool,
    pub volume_percent: u8,
    pub is_muted: bool,
    pub key_shift: i8,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RemotePlaybackStatusV1 {
    pub playing: bool,
    pub position_seconds: f64,
    pub duration_seconds: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RemoteStateV1 {
    pub v: u16,
    pub revision: u64,
    pub session_generation: u64,
    pub playback_generation: u64,
    pub playback_mode: RemotePlaybackModeV1,
    pub current_item: Option<RemotePlaylistItemV1>,
    pub playlist: Vec<RemotePlaylistItemV1>,
    pub session_users: Vec<String>,
    pub player_settings: RemotePlayerSettingsV1,
    pub player_status: Option<RemotePlaybackStatusV1>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const EPOCH: &str = "abcdefghijklmnopqrstuv";
    const REQUEST_ID: &str = "123e4567-e89b-42d3-a456-426614174000";

    fn request(kind: &str, body: Value) -> String {
        json!({
            "v": 1,
            "lane": "control",
            "epoch": EPOCH,
            "seq": 1,
            "id": REQUEST_ID,
            "kind": kind,
            "body": body,
        })
        .to_string()
    }

    fn context(profile: RemoteProfile) -> RemoteValidationContext<'static> {
        RemoteValidationContext {
            expected_lane: RemoteLane::Control,
            expected_epoch: EPOCH,
            last_sequence: None,
            profile,
        }
    }

    #[test]
    fn viewer_decodes_bounded_read_requests() {
        let decoded = decode_remote_request_v1(
            &request("catalog.search", json!({"query": "测试", "limit": 80})),
            context(RemoteProfile::Viewer),
        )
        .unwrap();
        assert_eq!(decoded.seq, 1);
        assert_eq!(decoded.request.operation(), RemoteOperation::CatalogSearch);
        let encoded = serde_json::to_value(&decoded).unwrap();
        assert_eq!(encoded["kind"], "catalog.search");
        assert_eq!(encoded["body"]["limit"], 80);
        assert!(encoded.get("request").is_none());
        assert!(profile_allows(
            RemoteProfile::Viewer,
            RemoteOperation::StateGet
        ));
        assert!(profile_allows(
            RemoteProfile::Viewer,
            RemoteOperation::SongDetail
        ));
    }

    #[test]
    fn viewer_cannot_mutate_and_controller_can() {
        let message = request(
            "playlist.remove",
            json!({"item_id": "item-1", "expected_revision": 4}),
        );
        assert_eq!(
            decode_remote_request_v1(&message, context(RemoteProfile::Viewer)),
            Err(RemoteProtocolError::CapabilityDenied)
        );
        assert_eq!(
            decode_remote_request_v1(&message, context(RemoteProfile::Controller))
                .unwrap()
                .request
                .operation(),
            RemoteOperation::PlaylistRemove
        );
    }

    #[test]
    fn playlist_add_preserves_position_and_repeat_policy_with_safe_defaults() {
        let explicit = decode_remote_request_v1(
            &request(
                "playlist.add",
                json!({
                    "catalog_item_id": "BV1ab411c7mD",
                    "position": "next",
                    "allow_repeat": true,
                    "expected_revision": 4,
                }),
            ),
            context(RemoteProfile::Controller),
        )
        .unwrap();
        assert!(matches!(
            explicit.request,
            RemoteRequestV1::PlaylistAdd {
                position: RemotePlaylistPositionV1::Next,
                allow_repeat: true,
                ..
            }
        ));

        let compatible = decode_remote_request_v1(
            &request(
                "playlist.add",
                json!({
                    "catalog_item_id": "BV1ab411c7mD",
                    "expected_revision": 4,
                }),
            ),
            context(RemoteProfile::Controller),
        )
        .unwrap();
        assert!(matches!(
            compatible.request,
            RemoteRequestV1::PlaylistAdd {
                position: RemotePlaylistPositionV1::Tail,
                allow_repeat: false,
                ..
            }
        ));
    }

    #[test]
    fn shared_remote_browse_requests_are_typed_and_bounded() {
        let browse = decode_remote_request_v1(
            &request(
                "catalog.browse",
                json!({
                    "kind": "artist",
                    "letter": "A",
                    "query": "",
                    "tag": "anime",
                    "locale": "ja",
                    "limit": 100,
                }),
            ),
            context(RemoteProfile::Viewer),
        )
        .unwrap();
        assert!(matches!(
            browse.request,
            RemoteRequestV1::CatalogBrowse {
                kind: RemoteCatalogBrowseKindV1::Artist,
                limit: 100,
                ..
            }
        ));

        let category = decode_remote_request_v1(
            &request(
                "catalog.category_browse",
                json!({
                    "tags": ["anime"],
                    "tag45s": ["female"],
                    "query": "",
                    "offset": 100,
                    "limit": 100,
                }),
            ),
            context(RemoteProfile::Viewer),
        )
        .unwrap();
        assert_eq!(
            category.request.operation(),
            RemoteOperation::CatalogCategoryBrowse
        );
    }

    #[test]
    fn gatcha_management_requires_controller_and_rejects_unsafe_ids() {
        let refresh = request("gatcha.refresh", json!({}));
        assert_eq!(
            decode_remote_request_v1(&refresh, context(RemoteProfile::Viewer)),
            Err(RemoteProtocolError::CapabilityDenied)
        );
        assert_eq!(
            decode_remote_request_v1(&refresh, context(RemoteProfile::Controller))
                .unwrap()
                .request
                .operation(),
            RemoteOperation::GatchaRefresh
        );

        for message in [
            request("gatcha.uid_preview", json!({"uid": "https://example.test"})),
            request(
                "gatcha.favlist_refresh",
                json!({"uid": "123", "folder_ids": []}),
            ),
            request(
                "gatcha.pool_config_set",
                json!({
                    "uid_weight": 80,
                    "favlist_weight": 80,
                    "excluded_uids": [],
                    "excluded_favlist_folders": [],
                }),
            ),
        ] {
            assert_eq!(
                decode_remote_request_v1(&message, context(RemoteProfile::Controller)),
                Err(RemoteProtocolError::InvalidRequestBody)
            );
        }
    }

    #[test]
    fn controller_can_toggle_playback_without_exposing_a_generic_command() {
        let decoded = decode_remote_request_v1(
            &request("playback.toggle", json!({})),
            context(RemoteProfile::Controller),
        )
        .unwrap();
        assert_eq!(decoded.request.operation(), RemoteOperation::PlaybackToggle);
    }

    #[test]
    fn envelope_rejects_unknown_fields_version_lane_epoch_replay_and_bad_ids() {
        let extra = json!({
            "v": 1,
            "lane": "control",
            "epoch": EPOCH,
            "seq": 1,
            "id": REQUEST_ID,
            "kind": "connection.health",
            "body": {},
            "extra": true,
        })
        .to_string();
        assert_eq!(
            decode_remote_request_v1(&extra, context(RemoteProfile::Viewer)),
            Err(RemoteProtocolError::MalformedEnvelope)
        );

        for (field, value, expected) in [
            ("v", json!(2), RemoteProtocolError::UnsupportedVersion),
            ("lane", json!("bulk"), RemoteProtocolError::InvalidLane),
            ("epoch", json!("bad"), RemoteProtocolError::InvalidEpoch),
            (
                "id",
                json!("not-uuid-v4"),
                RemoteProtocolError::InvalidRequestId,
            ),
        ] {
            let mut envelope =
                serde_json::from_str::<Value>(&request("connection.health", json!({}))).unwrap();
            envelope[field] = value;
            assert_eq!(
                decode_remote_request_v1(&envelope.to_string(), context(RemoteProfile::Viewer)),
                Err(expected),
                "field {field}"
            );
        }

        let mut replay = context(RemoteProfile::Viewer);
        replay.last_sequence = Some(1);
        assert_eq!(
            decode_remote_request_v1(&request("connection.health", json!({})), replay),
            Err(RemoteProtocolError::ReplayedSequence)
        );

        let stale_epoch = request("connection.health", json!({})).replace(EPOCH, &"z".repeat(22));
        assert_eq!(
            decode_remote_request_v1(&stale_epoch, context(RemoteProfile::Viewer)),
            Err(RemoteProtocolError::StaleEpoch)
        );

        let oversized = " ".repeat(MAX_CONTROL_MESSAGE_BYTES + 1);
        assert_eq!(
            decode_remote_request_v1(&oversized, context(RemoteProfile::Viewer)),
            Err(RemoteProtocolError::MessageTooLarge)
        );
    }

    #[test]
    fn request_bodies_reject_unknown_fields_and_unsafe_bounds() {
        let cases = [
            request("connection.health", json!({"extra": true})),
            request("catalog.search", json!({"query": " ", "limit": 80})),
            request("catalog.search", json!({"query": "ok", "limit": 81})),
            request("playback.seek_relative", json!({"delta_seconds": 301})),
            request("player.set_volume", json!({"volume_percent": 101})),
            request("player.set_key_shift", json!({"key_shift": 7})),
            request("rating.submit", json!({"play_id": "p", "score": 0})),
        ];
        for message in cases {
            assert_eq!(
                decode_remote_request_v1(&message, context(RemoteProfile::Controller)),
                Err(RemoteProtocolError::InvalidRequestBody)
            );
        }
    }

    #[test]
    fn catalog_ids_are_bvids_with_an_optional_positive_page() {
        for catalog_item_id in ["BV1ab411c7mD", "BV1ab411c7mD_p1", "BV1ab411c7mD_p123"] {
            let decoded = decode_remote_request_v1(
                &request(
                    "catalog.song_detail",
                    json!({"catalog_item_id": catalog_item_id}),
                ),
                context(RemoteProfile::Viewer),
            )
            .unwrap();
            assert_eq!(decoded.request.operation(), RemoteOperation::SongDetail);
        }
        for catalog_item_id in [
            "https://www.bilibili.com/video/BV1ab411c7mD",
            "BV1ab411c7mD_p0",
            "BV1ab411c7mD_p01",
            "BV1ab411c7mD_p1_extra",
            "av123",
        ] {
            assert_eq!(
                decode_remote_request_v1(
                    &request(
                        "catalog.song_detail",
                        json!({"catalog_item_id": catalog_item_id}),
                    ),
                    context(RemoteProfile::Viewer),
                ),
                Err(RemoteProtocolError::InvalidRequestBody),
                "catalog_item_id {catalog_item_id}"
            );
        }
    }

    #[test]
    fn maintenance_and_arbitrary_transport_routes_are_not_protocol_kinds() {
        for kind in [
            "app.shutdown",
            "app.update",
            "diagnostics.export",
            "cache.configure",
            "http.request",
            "url.open",
        ] {
            assert_eq!(
                decode_remote_request_v1(
                    &request(kind, json!({})),
                    context(RemoteProfile::Controller)
                ),
                Err(RemoteProtocolError::UnknownRequestKind),
                "kind {kind}"
            );
        }
    }

    #[test]
    fn remote_state_shape_has_no_local_paths_urls_or_maintenance_state() {
        let state = RemoteStateV1 {
            v: INTERNET_REMOTE_PROTOCOL_VERSION,
            revision: 4,
            session_generation: 2,
            playback_generation: 3,
            playback_mode: RemotePlaybackModeV1::Local,
            current_item: Some(RemotePlaylistItemV1 {
                id: "item-1".into(),
                bvid: "BV1example".into(),
                page: 1,
                display_title: "Song".into(),
                cover_url: "https://i0.hdslb.com/example.jpg".into(),
                owner_mid: 42,
                owner_name: "Singer".into(),
                requester_name: "Guest".into(),
                cache_status: RemoteCacheStatusV1::Ready,
                cache_progress: 1.0,
                audio_variants: vec![RemoteAudioVariantV1 {
                    id: "main".into(),
                    label: "伴奏".into(),
                }],
                selected_audio_variant_id: "main".into(),
            }),
            playlist: vec![],
            session_users: vec!["Guest".into()],
            player_settings: RemotePlayerSettingsV1 {
                effective_av_delay_ms: 0,
                av_delay_locked: false,
                volume_percent: 80,
                is_muted: false,
                key_shift: 0,
            },
            player_status: Some(RemotePlaybackStatusV1 {
                playing: true,
                position_seconds: 12.5,
                duration_seconds: 180.0,
            }),
        };
        let encoded = serde_json::to_string(&state).unwrap();
        for forbidden in [
            "original_url",
            "resolved_url",
            "video_relative_path",
            "artifact_relative_directory",
            "cookie",
            "gatcha",
            "app_update",
            "diagnostic",
        ] {
            assert!(!encoded.contains(forbidden), "forbidden field {forbidden}");
        }
    }
}
