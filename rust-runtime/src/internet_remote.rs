use crate::app_state::{AppSnapshot, PlaylistItem};
use bilikara_rust::{
    INTERNET_REMOTE_PROTOCOL_VERSION, MAX_REMOTE_STATE_ITEMS, RemoteAudioVariantV1,
    RemoteCacheStatusV1, RemoteLane, RemotePlaybackModeV1, RemotePlayerSettingsV1,
    RemotePlaylistPositionV1, RemoteProfile, RemoteProtocolError, RemoteRequestEnvelopeV1,
    RemoteRequestV1, RemoteStateV1, RemoteValidationContext, decode_remote_request_v1,
};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;

const MAX_INTERNET_REMOTE_PEERS: usize = 32;
const MAX_PENDING_PLAYLIST_ADDS_PER_PEER: usize = 8;
const MAX_PEER_ID_BYTES: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq)]
struct PeerSession {
    epoch: String,
    profile: RemoteProfile,
    session_name: Option<String>,
    control_last_sequence: Option<u64>,
    bulk_last_sequence: Option<u64>,
    pending_playlist_adds: HashMap<String, PendingPlaylistAdd>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PendingPlaylistAdd {
    pub request_id: String,
    pub sequence: u64,
    pub expected_revision: u64,
    pub catalog_item_id: String,
    pub position: RemotePlaylistPositionV1,
    pub allow_repeat: bool,
    pub session_name: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct InternetRemotePeers {
    peers: HashMap<String, PeerSession>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub(crate) struct InternetRemoteValidation {
    pub peer_id: String,
    pub request_id: String,
    pub sequence: u64,
    pub accepted: bool,
    pub stale_revision: bool,
    pub current_revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_name: Option<String>,
    pub request: RemoteRequestV1,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_state: Option<RemoteStateV1>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum InternetRemoteError {
    InvalidPeerId,
    InvalidEpoch,
    TooManyPeers,
    UnknownPeer,
    IdentityRequired,
    PendingRequestMissing,
    TooManyPendingRequests,
    Protocol(RemoteProtocolError),
}

impl InternetRemoteError {
    pub(crate) const fn kind(&self) -> &'static str {
        match self {
            Self::InvalidPeerId => "invalid_internet_remote_peer_id",
            Self::InvalidEpoch => "invalid_internet_remote_epoch",
            Self::TooManyPeers => "too_many_internet_remote_peers",
            Self::UnknownPeer => "unknown_internet_remote_peer",
            Self::IdentityRequired => "internet_remote_identity_required",
            Self::PendingRequestMissing => "internet_remote_pending_request_missing",
            Self::TooManyPendingRequests => "too_many_internet_remote_pending_requests",
            Self::Protocol(error) => match error {
                RemoteProtocolError::MessageTooLarge => "internet_remote_message_too_large",
                RemoteProtocolError::MalformedEnvelope => "malformed_internet_remote_envelope",
                RemoteProtocolError::UnsupportedVersion => "unsupported_internet_remote_version",
                RemoteProtocolError::InvalidLane => "invalid_internet_remote_lane",
                RemoteProtocolError::InvalidEpoch => "invalid_internet_remote_epoch",
                RemoteProtocolError::StaleEpoch => "stale_internet_remote_epoch",
                RemoteProtocolError::InvalidSequence => "invalid_internet_remote_sequence",
                RemoteProtocolError::ReplayedSequence => "replayed_internet_remote_sequence",
                RemoteProtocolError::InvalidRequestId => "invalid_internet_remote_request_id",
                RemoteProtocolError::UnknownRequestKind => "unknown_internet_remote_request",
                RemoteProtocolError::InvalidRequestBody => "invalid_internet_remote_request",
                RemoteProtocolError::CapabilityDenied => "internet_remote_capability_denied",
            },
        }
    }

    pub(crate) const fn message(&self) -> &'static str {
        match self {
            Self::InvalidPeerId => "Internet Remote peer id is invalid",
            Self::InvalidEpoch => "Internet Remote epoch is invalid",
            Self::TooManyPeers => "Internet Remote peer limit has been reached",
            Self::UnknownPeer => "Internet Remote peer is not registered",
            Self::IdentityRequired => "Set an Internet Remote identity before this operation",
            Self::PendingRequestMissing => "Internet Remote request is no longer pending",
            Self::TooManyPendingRequests => "Too many Internet Remote requests are pending",
            Self::Protocol(_) => "Internet Remote message was rejected",
        }
    }
}

impl InternetRemotePeers {
    pub(crate) fn open(
        &mut self,
        peer_id: &str,
        epoch: &str,
        profile: RemoteProfile,
    ) -> Result<(), InternetRemoteError> {
        if !valid_opaque_id(peer_id, MAX_PEER_ID_BYTES) {
            return Err(InternetRemoteError::InvalidPeerId);
        }
        if !valid_epoch(epoch) {
            return Err(InternetRemoteError::InvalidEpoch);
        }
        if !self.peers.contains_key(peer_id) && self.peers.len() >= MAX_INTERNET_REMOTE_PEERS {
            return Err(InternetRemoteError::TooManyPeers);
        }
        self.peers.insert(
            peer_id.to_owned(),
            PeerSession {
                epoch: epoch.to_owned(),
                profile,
                session_name: None,
                control_last_sequence: None,
                bulk_last_sequence: None,
                pending_playlist_adds: HashMap::new(),
            },
        );
        Ok(())
    }

    pub(crate) fn close(&mut self, peer_id: &str) -> bool {
        self.peers.remove(peer_id).is_some()
    }

    pub(crate) fn clear(&mut self) {
        self.peers.clear();
    }

    pub(crate) fn validate(
        &mut self,
        peer_id: &str,
        lane: RemoteLane,
        message: &str,
        snapshot: &AppSnapshot,
    ) -> Result<InternetRemoteValidation, InternetRemoteError> {
        let peer = self
            .peers
            .get_mut(peer_id)
            .ok_or(InternetRemoteError::UnknownPeer)?;
        let last_sequence = match lane {
            RemoteLane::Control => peer.control_last_sequence,
            RemoteLane::Bulk => peer.bulk_last_sequence,
        };
        let decoded = decode_remote_request_v1(
            message,
            RemoteValidationContext {
                expected_lane: lane,
                expected_epoch: &peer.epoch,
                last_sequence,
                profile: peer.profile,
            },
        )
        .map_err(InternetRemoteError::Protocol)?;

        match lane {
            RemoteLane::Control => peer.control_last_sequence = Some(decoded.seq),
            RemoteLane::Bulk => peer.bulk_last_sequence = Some(decoded.seq),
        }

        Ok(validation_result(
            peer_id,
            peer.session_name.clone(),
            decoded,
            snapshot,
        ))
    }

    pub(crate) fn commit_identity(
        &mut self,
        peer_id: &str,
        name: String,
    ) -> Result<(), InternetRemoteError> {
        let peer = self
            .peers
            .get_mut(peer_id)
            .ok_or(InternetRemoteError::UnknownPeer)?;
        peer.session_name = Some(name);
        Ok(())
    }

    pub(crate) fn begin_playlist_add(
        &mut self,
        validation: &InternetRemoteValidation,
        catalog_item_id: &str,
        position: RemotePlaylistPositionV1,
        allow_repeat: bool,
        expected_revision: u64,
    ) -> Result<(), InternetRemoteError> {
        let peer = self
            .peers
            .get_mut(&validation.peer_id)
            .ok_or(InternetRemoteError::UnknownPeer)?;
        let session_name = validation
            .session_name
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .ok_or(InternetRemoteError::IdentityRequired)?;
        if peer.pending_playlist_adds.len() >= MAX_PENDING_PLAYLIST_ADDS_PER_PEER {
            return Err(InternetRemoteError::TooManyPendingRequests);
        }
        let pending = PendingPlaylistAdd {
            request_id: validation.request_id.clone(),
            sequence: validation.sequence,
            expected_revision,
            catalog_item_id: catalog_item_id.to_owned(),
            position,
            allow_repeat,
            session_name: session_name.to_owned(),
        };
        peer.pending_playlist_adds
            .insert(validation.request_id.clone(), pending);
        Ok(())
    }

    pub(crate) fn take_playlist_add(
        &mut self,
        peer_id: &str,
        request_id: &str,
    ) -> Result<PendingPlaylistAdd, InternetRemoteError> {
        let peer = self
            .peers
            .get_mut(peer_id)
            .ok_or(InternetRemoteError::UnknownPeer)?;
        peer.pending_playlist_adds
            .remove(request_id)
            .ok_or(InternetRemoteError::PendingRequestMissing)
    }
}

fn validation_result(
    peer_id: &str,
    session_name: Option<String>,
    decoded: RemoteRequestEnvelopeV1,
    snapshot: &AppSnapshot,
) -> InternetRemoteValidation {
    let expected_revision = expected_revision(&decoded.request);
    let stale_revision = expected_revision.is_some_and(|value| value != snapshot.revision);
    let include_state = stale_revision
        || matches!(
            decoded.request,
            RemoteRequestV1::ConnectionHealth | RemoteRequestV1::StateGet { .. }
        );
    InternetRemoteValidation {
        peer_id: peer_id.to_owned(),
        request_id: decoded.id,
        sequence: decoded.seq,
        accepted: !stale_revision,
        stale_revision,
        current_revision: snapshot.revision,
        session_name,
        request: decoded.request,
        remote_state: include_state.then(|| project_remote_state(snapshot)),
    }
}

fn expected_revision(request: &RemoteRequestV1) -> Option<u64> {
    match request {
        RemoteRequestV1::PlaylistAdd {
            expected_revision, ..
        }
        | RemoteRequestV1::PlaylistRemove {
            expected_revision, ..
        }
        | RemoteRequestV1::PlaylistMove {
            expected_revision, ..
        }
        | RemoteRequestV1::PlaylistResort { expected_revision }
        | RemoteRequestV1::PlaylistMoveNext {
            expected_revision, ..
        }
        | RemoteRequestV1::PlaylistPlayNow {
            expected_revision, ..
        }
        | RemoteRequestV1::PlayerSetAudioVariant {
            expected_revision, ..
        }
        | RemoteRequestV1::CacheRetry {
            expected_revision, ..
        } => Some(*expected_revision),
        _ => None,
    }
}

pub(crate) fn project_remote_state(snapshot: &AppSnapshot) -> RemoteStateV1 {
    RemoteStateV1 {
        v: INTERNET_REMOTE_PROTOCOL_VERSION,
        revision: snapshot.revision,
        session_generation: snapshot.session_generation,
        playback_generation: snapshot.playback_generation,
        playback_mode: if snapshot.playback_mode == "online" {
            RemotePlaybackModeV1::Online
        } else {
            RemotePlaybackModeV1::Local
        },
        current_item: snapshot.current_item.as_ref().map(project_item),
        playlist: snapshot
            .playlist
            .iter()
            .take(MAX_REMOTE_STATE_ITEMS)
            .map(project_item)
            .collect(),
        session_users: snapshot.session_users.clone(),
        player_settings: RemotePlayerSettingsV1 {
            effective_av_delay_ms: snapshot.player_settings.av_offset_ms,
            av_delay_locked: snapshot.player_settings.av_delay.locked,
            volume_percent: snapshot.player_settings.volume_percent.clamp(0, 100) as u8,
            is_muted: snapshot.player_settings.is_muted,
            key_shift: snapshot.player_settings.key_shift.clamp(-6, 6) as i8,
        },
        player_status: None,
    }
}

fn project_item(item: &PlaylistItem) -> bilikara_rust::RemotePlaylistItemV1 {
    bilikara_rust::RemotePlaylistItemV1 {
        id: item.id.clone(),
        bvid: item.bvid.clone(),
        page: item.page.clamp(1, i64::from(u32::MAX)) as u32,
        display_title: item.display_title.clone(),
        cover_url: safe_cover_url(&item.cover_url),
        owner_mid: item.owner_mid.max(0) as u64,
        owner_name: item.owner_name.clone(),
        requester_name: item.requester_name.clone(),
        cache_status: cache_status(&item.cache_status),
        cache_progress: item.cache_progress.clamp(0.0, 100.0) as f32,
        audio_variants: item
            .audio_variants
            .iter()
            .filter_map(project_audio_variant)
            .collect(),
        selected_audio_variant_id: item.selected_audio_variant_id.clone(),
    }
}

fn project_audio_variant(variant: &serde_json::Map<String, Value>) -> Option<RemoteAudioVariantV1> {
    let id = variant.get("id")?.as_str()?.trim();
    if id.is_empty() || id.len() > 128 {
        return None;
    }
    let label = variant
        .get("label")
        .and_then(Value::as_str)
        .unwrap_or(id)
        .trim();
    Some(RemoteAudioVariantV1 {
        id: id.to_owned(),
        label: label.chars().take(80).collect(),
    })
}

fn cache_status(value: &str) -> RemoteCacheStatusV1 {
    match value {
        "queued" => RemoteCacheStatusV1::Queued,
        "downloading" => RemoteCacheStatusV1::Downloading,
        "ready" => RemoteCacheStatusV1::Ready,
        "failed" => RemoteCacheStatusV1::Failed,
        _ => RemoteCacheStatusV1::Pending,
    }
}

fn safe_cover_url(value: &str) -> String {
    let normalized = value.trim();
    let candidate = if normalized.starts_with("//") {
        format!("https:{normalized}")
    } else {
        normalized.to_owned()
    };
    let Ok(mut parsed) = url::Url::parse(&candidate) else {
        return String::new();
    };
    if !matches!(parsed.scheme(), "http" | "https")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.port().is_some_and(|port| port != 443)
    {
        return String::new();
    }
    let host = parsed.host_str().unwrap_or("").to_ascii_lowercase();
    if host != "hdslb.com" && !host.ends_with(".hdslb.com") {
        return String::new();
    }
    if parsed.set_scheme("https").is_err() {
        return String::new();
    }
    parsed.set_fragment(None);
    parsed.to_string()
}

fn valid_epoch(value: &str) -> bool {
    value.len() == 22 && valid_opaque_id(value, 22)
}

fn valid_opaque_id(value: &str, max_bytes: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_bytes
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_state::{
        AppState, AppStateRequest, AppStateResponse, AppStateSeed, PlayerSettingsSeed,
    };
    use serde_json::json;

    const EPOCH: &str = "abcdefghijklmnopqrstuv";

    fn empty_snapshot() -> AppSnapshot {
        let mut state = AppState::default();
        let response = state.execute(AppStateRequest::Initialize {
            schema_version: 1,
            state: Box::new(AppStateSeed {
                playback_mode: "local".into(),
                player_settings: PlayerSettingsSeed::default(),
                current_item: None,
                current_item_started: false,
                playlist: vec![],
                history: vec![],
                session_history: vec![],
                session_users: vec![],
                session_started_at: 1.0,
                session_played_file: "played.json".into(),
                session_played: vec![],
                previous_session: None,
                backup: None,
                updated_at: 1.0,
            }),
        });
        match response {
            AppStateResponse::Success(success) => success.snapshot.unwrap(),
            AppStateResponse::Failure(failure) => panic!("initialization failed: {failure:?}"),
        }
    }

    fn message(seq: u64, expected_revision: u64) -> String {
        json!({
            "v": 1,
            "lane": "control",
            "epoch": EPOCH,
            "seq": seq,
            "id": "123e4567-e89b-42d3-a456-426614174000",
            "kind": "playlist.resort",
            "body": {"expected_revision": expected_revision},
        })
        .to_string()
    }

    #[test]
    fn peer_sessions_are_bounded_and_replay_safe() {
        let snapshot = empty_snapshot();
        let mut peers = InternetRemotePeers::default();
        peers
            .open("peer-one", EPOCH, RemoteProfile::Controller)
            .unwrap();
        let accepted = peers
            .validate(
                "peer-one",
                RemoteLane::Control,
                &message(1, snapshot.revision),
                &snapshot,
            )
            .unwrap();
        assert!(accepted.accepted);
        assert_eq!(
            peers.validate(
                "peer-one",
                RemoteLane::Control,
                &message(1, snapshot.revision),
                &snapshot,
            ),
            Err(InternetRemoteError::Protocol(
                RemoteProtocolError::ReplayedSequence
            ))
        );
    }

    #[test]
    fn stale_revision_is_consumed_but_not_accepted() {
        let snapshot = empty_snapshot();
        let mut peers = InternetRemotePeers::default();
        peers
            .open("peer-one", EPOCH, RemoteProfile::Controller)
            .unwrap();
        let stale = peers
            .validate(
                "peer-one",
                RemoteLane::Control,
                &message(1, snapshot.revision + 1),
                &snapshot,
            )
            .unwrap();
        assert!(!stale.accepted);
        assert!(stale.stale_revision);
        assert!(stale.remote_state.is_some());
    }

    #[test]
    fn validated_identity_is_retained_for_subsequent_requests() {
        let snapshot = empty_snapshot();
        let mut peers = InternetRemotePeers::default();
        peers
            .open("peer-one", EPOCH, RemoteProfile::Controller)
            .unwrap();
        let identity = json!({
            "v": 1,
            "lane": "control",
            "epoch": EPOCH,
            "seq": 1,
            "id": "123e4567-e89b-42d3-a456-426614174000",
            "kind": "session.set_identity",
            "body": {"name": "Alice"},
        })
        .to_string();
        let set = peers
            .validate("peer-one", RemoteLane::Control, &identity, &snapshot)
            .unwrap();
        assert_eq!(set.session_name, None);
        peers
            .commit_identity("peer-one", "Alice".to_owned())
            .unwrap();

        let health = json!({
            "v": 1,
            "lane": "control",
            "epoch": EPOCH,
            "seq": 2,
            "id": "223e4567-e89b-42d3-a456-426614174000",
            "kind": "connection.health",
            "body": {},
        })
        .to_string();
        let next = peers
            .validate("peer-one", RemoteLane::Control, &health, &snapshot)
            .unwrap();
        assert_eq!(next.session_name.as_deref(), Some("Alice"));
    }

    #[test]
    fn projection_normalizes_bilibili_covers_to_https_and_rejects_other_hosts() {
        assert_eq!(
            safe_cover_url("https://i1.hdslb.com/bfs/archive/test.jpg"),
            "https://i1.hdslb.com/bfs/archive/test.jpg"
        );
        assert_eq!(
            safe_cover_url("http://i1.hdslb.com/test.jpg"),
            "https://i1.hdslb.com/test.jpg"
        );
        assert_eq!(
            safe_cover_url("//i1.hdslb.com/test.jpg"),
            "https://i1.hdslb.com/test.jpg"
        );
        assert!(safe_cover_url("https://user@i1.hdslb.com/test.jpg").is_empty());
        assert!(safe_cover_url("https://example.com/test.jpg").is_empty());
    }
}
