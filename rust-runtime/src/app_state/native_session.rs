//! Native HTTP session state lives under the same AppState mutex as the queue.
//! This is transient transport/player ownership, never a second playlist or a
//! persisted bearer-token store. A process restart invalidates every token.
//! Validated cache preferences are reloaded separately from private storage.
use super::*;
use crate::native_host::ApiError;
use crate::status_service::{BilibiliLoginFacts, RuntimeStatusService};
use std::collections::VecDeque;
mod media;

#[cfg(test)]
mod tests;

#[derive(Default)]
pub(crate) struct NativeSession {
    pub desktop: bool,
    pub player_media: crate::native_host::preferences::PlayerMedia,
    pub media_client: String,
    pub cache_policy: crate::native_host::preferences::CachePolicy,
    pub cache_usage_bytes: u64,
    pub ui_language: Option<crate::native_host::preferences::UiLanguage>,
    pub library_cooldown_until: Option<std::time::Instant>,
    pub library_refresh_active: bool,
    pub ratings: crate::native_host::ratings::RatingLedger,
    pub remote_export_ready: bool,
    pub updates: crate::native_host::updates::UpdateState,
    pub host_token: String,
    pub invite: String,
    pub cookie: String,
    pub login: RuntimeStatusService,
    pub login_generation: Option<u64>,
    pub remote_access: Value,
    pub revision: u64,
    devices: HashMap<String, Device>,
    claim: Option<Claim>,
    observation: Option<Value>,
    diagnostics: VecDeque<Value>,
    remote_connection_diagnostics: VecDeque<Value>,
    login_diagnostics: VecDeque<crate::native_host::LoginDiagnostic>,
    library_diagnostics: VecDeque<crate::native_host::LibraryDiagnostic>,
    media_readers: HashMap<String, usize>,
}

impl std::fmt::Debug for NativeSession {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("NativeSession")
            .field("revision", &self.revision)
            .field("device_count", &self.devices.len())
            .field("logged_in", &!self.cookie.is_empty())
            .finish_non_exhaustive()
    }
}

#[derive(Debug)]
struct Device {
    name: String,
    generation: u64,
}

#[derive(Debug)]
struct Claim {
    client: String,
    generation: u64,
    incarnation: String,
    artifact: String,
}

#[derive(Clone)]
pub(crate) struct Identity {
    pub token: String,
    pub loopback: bool,
    pub client: String,
}

pub(crate) fn with_app<T>(
    action: impl FnOnce(&mut AppState) -> Result<T, ApiError>,
) -> Result<T, ApiError> {
    let mut state = APP_STATE
        .get_or_init(|| Mutex::new(AppState::default()))
        .lock()
        .map_err(|_| ApiError::new(503, "state_unavailable", "Rust 状态锁不可用"))?;
    action(&mut state)
}

pub(crate) fn text(body: &Value, key: &str) -> Result<String, ApiError> {
    body.get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 4096)
        .map(str::to_owned)
        .ok_or_else(|| ApiError::invalid(format!("缺少或无效的 {key}")))
}

pub(crate) fn positive(body: &Value, key: &str) -> Result<u64, ApiError> {
    body.get(key)
        .and_then(Value::as_u64)
        .filter(|v| *v > 0 && *v <= MAX_SAFE_JSON_INTEGER)
        .ok_or_else(|| ApiError::invalid(format!("缺少或无效的 {key}")))
}

fn number(body: &Value, key: &str) -> Result<f64, ApiError> {
    body.get(key)
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite() && v.abs() <= PLAYER_STATUS_MAX_SECONDS)
        .ok_or_else(|| ApiError::invalid(format!("缺少或无效的 {key}")))
}

impl AppState {
    pub(crate) fn native_session_archives(&self) -> Vec<SessionArchiveSeed> {
        self.data
            .as_ref()
            .map(|data| data.session_archives.clone())
            .unwrap_or_default()
    }

    pub(crate) fn native_session_choice_pending(&self) -> bool {
        self.data
            .as_ref()
            .is_some_and(|data| data.native_session_choice_pending)
    }

    pub(crate) fn native(&mut self) -> &mut NativeSession {
        &mut self.native_session
    }

    pub(crate) fn native_authorize(
        &self,
        identity: &Identity,
        host_only: bool,
    ) -> Result<bool, ApiError> {
        let session = &self.native_session;
        let host = identity.loopback
            && !session.host_token.is_empty()
            && identity.token == session.host_token;
        if host || (!host_only && session.devices.contains_key(&identity.token)) {
            Ok(host)
        } else {
            Err(ApiError::new(
                403,
                "forbidden",
                "请使用此 Host 当前显示的手机点歌二维码加入",
            ))
        }
    }

    pub(crate) fn native_redeem(
        &mut self,
        invite: &str,
        existing_token: &str,
        new_token: String,
    ) -> Result<String, ApiError> {
        if self.native_session.invite.is_empty() || invite != self.native_session.invite {
            return Err(ApiError::new(
                403,
                "invalid_invite",
                "二维码已失效，请重新扫码",
            ));
        }
        if self.native_session.devices.contains_key(existing_token) {
            return Ok(existing_token.to_owned());
        }
        if self.native_session.devices.len() >= 10 {
            return Err(ApiError::new(
                429,
                "room_full",
                "此 Alpha 最多连接 10 台手机；重启 Host 可清理设备",
            ));
        }
        self.native_session.devices.insert(
            new_token.clone(),
            Device {
                name: String::new(),
                generation: 0,
            },
        );
        Ok(new_token)
    }

    pub(crate) fn native_identity(&self, identity: &Identity) -> Result<Value, ApiError> {
        self.native_authorize(identity, false)?;
        let snapshot = self.native_core_snapshot()?;
        let name = self
            .native_session
            .devices
            .get(&identity.token)
            .filter(|device| {
                device.generation == snapshot.session_generation
                    && snapshot.session_users.contains(&device.name)
            })
            .map(|device| device.name.as_str())
            .unwrap_or("");
        Ok(
            json!({"registered":!name.is_empty(),"name":name,"session_id":format!("native-{}",snapshot.session_generation)}),
        )
    }

    pub(crate) fn native_register(
        &mut self,
        identity: &Identity,
        body: &Value,
        rename: bool,
        now: f64,
    ) -> Result<Value, ApiError> {
        self.native_authorize(identity, false)?;
        let snapshot = self.native_core_snapshot()?;
        let name = text(body, "name")?.trim().to_owned();
        let current = self
            .native_session
            .devices
            .get(&identity.token)
            .map(|d| d.name.clone())
            .unwrap_or_default();
        if rename && current.is_empty() {
            return Err(ApiError::new(403, "identity_required", "请先登记点歌人"));
        }
        if rename && current != name {
            self.native_execute(AppStateRequest::RenameSessionUser {
                schema_version: 1,
                current_name: current,
                new_name: name.clone(),
                now,
            })?;
        } else if !snapshot.session_users.contains(&name) {
            self.native_execute(AppStateRequest::AddSessionUser {
                schema_version: 1,
                name: name.clone(),
                now,
            })?;
        } else if current != name && body["claim"] != true {
            let mut error = ApiError::new(409, "session_user_already_exists", "该用户已存在");
            error.extra = json!({"name":name});
            return Err(error);
        }
        if let Some(device) = self.native_session.devices.get_mut(&identity.token) {
            device.name = name;
            device.generation = snapshot.session_generation;
        }
        self.native_identity(identity)
    }

    pub(crate) fn native_requester(
        &self,
        identity: &Identity,
        requested: &str,
    ) -> Result<String, ApiError> {
        if self.native_authorize(identity, false)? {
            return Ok(requested.to_owned());
        }
        let identity = self.native_identity(identity)?;
        if identity["registered"] != true {
            return Err(ApiError::new(403, "identity_required", "请先登记点歌人"));
        }
        Ok(identity["name"].as_str().unwrap_or_default().to_owned())
    }

    pub(crate) fn native_core_snapshot(&self) -> Result<AppSnapshot, ApiError> {
        self.data
            .as_ref()
            .ok_or_else(|| ApiError::new(503, "state_unavailable", "Rust Host 尚未初始化"))?
            .snapshot()
            .map_err(|_| ApiError::new(500, "snapshot", "无法读取 Rust 状态"))
    }

    pub(crate) fn native_execute(
        &mut self,
        mut command: AppStateRequest,
    ) -> Result<Value, ApiError> {
        if self.native_session.desktop {
            match &mut command {
                AppStateRequest::AdvanceToNext { reset_av_delay, .. }
                | AppStateRequest::MoveToFront { reset_av_delay, .. }
                | AppStateRequest::SetCurrentItem { reset_av_delay, .. } => {
                    *reset_av_delay = self.native_session.cache_policy.reset_offset_on_next
                }
                _ => {}
            }
        }
        let renamed = match &command {
            AppStateRequest::RenameSessionUser {
                current_name,
                new_name,
                ..
            } => Some((current_name.clone(), new_name.clone())),
            _ => None,
        };
        let response = self.execute(command);
        if let Some(error) = response.error() {
            let status = match error.kind.as_str() {
                "player_busy" => 429,
                "invalid_player_control" => 400,
                _ => 409,
            };
            let mut failure = ApiError::new(status, &error.kind, &error.message);
            failure.extra = error.details.clone().unwrap_or_else(|| json!({}));
            return Err(failure);
        }
        if let Some((old, new)) = renamed {
            self.native().ratings.rename(&old, &new);
        }
        Ok(response.result().cloned().unwrap_or(Value::Null))
    }

    pub(crate) fn native_snapshot(&self, host: bool) -> Result<Value, ApiError> {
        let snapshot = self.native_core_snapshot()?;
        let mut value = serde_json::to_value(&snapshot)
            .map_err(|_| ApiError::invalid("无法序列化 Host 状态"))?;
        let session = &self.native_session;
        value["state_revision"] = json!(
            snapshot
                .revision
                .saturating_add(session.revision)
                .saturating_add(self.player_controls.revision)
        );
        value["remote_session_id"] = json!(format!("native-{}", snapshot.session_generation));
        value["player_status"] = session
            .observation
            .as_ref()
            .filter(|status| {
                status["playback_generation"] == snapshot.playback_generation
                    && Some(status["item_id"].as_str().unwrap_or_default())
                        == snapshot.current_item.as_ref().map(|i| i.id.as_str())
            })
            .cloned()
            .unwrap_or(Value::Null);
        value["player_control_command"] = if host {
            self.player_control_head().unwrap_or(Value::Null)
        } else {
            Value::Null
        };
        value["capabilities"] = json!({"native_android_alpha":!session.desktop,"native_android_beta":!session.desktop,"desktop_preview":session.desktop,"backend":"rust","platform":if session.desktop {"desktop"} else {"android"},"native_host":true,"event_heartbeat":true,"local_remote":true,"internet_remote":true,"gatcha":true,"shared_search":true,"desktop_tools":false,"playlist_export":session.remote_export_ready,"app_update":!session.desktop,"catalog_write":!session.desktop,"maintenance":!session.desktop});
        value["app"] = json!({"version":"0.8.0-preview.0","releases_url":"https://github.com/VZRXS/bilikara/releases"});
        value["session_flags"] = json!({"auto_restored_backup":false,
            "startup_choice_pending":self.native_session_choice_pending()});
        value["cache_policy"] = session.cache_policy.snapshot();
        if session.desktop {
            let effective = crate::native_host::preferences::MediaSelection::new(
                &session.cache_policy,
                &session.player_media,
                true,
            );
            value["cache_policy"]["force_avc"] = json!(true);
            value["cache_policy"]["avc_quality_cap"] = json!(session.player_media.avc_quality_cap);
            value["cache_policy"]["media_capabilities"] = session.player_media.snapshot();
            value["cache_policy"]["effective_video_quality"] = json!(effective.quality);
            value["cache_policy"]["media_backend"] =
                json!({"video_codecs":["avc"],"hevc_available":false});
            if !session.player_media.usable() {
                value["cache_policy"]["enabled"] = json!(false);
                value["cache_policy"]["unavailable_reason"] = json!(
                    "Host player reports no AVC decode support; this media backend requires AVC"
                );
            }
        }
        if value["cache_policy"]["enabled"] == false {
            let message = value["cache_policy"]["unavailable_reason"].clone();
            if let Some(item) = value
                .get_mut("current_item")
                .filter(|item| item.is_object())
            {
                item["cache_message"] = message.clone();
            }
            if let Some(items) = value.get_mut("playlist").and_then(Value::as_array_mut) {
                for item in items {
                    item["cache_message"] = message.clone();
                }
            }
        }
        value["cache_policy"]["usage_bytes"] = json!(session.cache_usage_bytes);
        // Count committed songs, not the staging/artifacts top-level directories.
        value["cache_policy"]["cached_item_count"] = json!(
            snapshot
                .current_item
                .iter()
                .chain(snapshot.playlist.iter())
                .filter(|item| item.cache_status == "ready" && !item.artifact_set_id.is_empty())
                .count()
        );
        value["gatcha"] = json!(session.login.gacha_snapshot());
        if host {
            value["app_update"] = if session.desktop {
                json!({"state":"unavailable","available":false,"message":"Desktop Rust preview: updater is unavailable"})
            } else {
                session.updates.snapshot()
            };
        }
        value["bbdown"] = json!({"available":session.cache_policy.available(),"download_source":session.cache_policy.download_source,"ready":session.cache_policy.available(),"state":if session.cache_policy.available() {"ready"} else {"unavailable"},"version":"Rust Native","max_cache_items":session.cache_policy.max_cache_items,"message":if !session.cache_policy.available() {"Imported downloader/preferences unavailable; select supported Native settings explicitly"} else if session.desktop {"Desktop Rust preview · Native only"} else {"Android Alpha"}});
        if session.desktop && !session.player_media.usable() {
            value["bbdown"]["ready"] = json!(false);
            value["bbdown"]["state"] = json!("unavailable");
            value["bbdown"]["message"] = value["cache_policy"]["unavailable_reason"].clone();
        }
        value["bbdown"]["logged_in"] = json!(!session.cookie.is_empty());
        // The shared status chip aggregates these two fields. No external FFmpeg
        // is installed or advertised; media normalization is in-process Rust.
        value["ffmpeg"] =
            json!({"available":true,"ready":true,"state":"ready","version":"Rust Native"});
        if host {
            let mut login =
                serde_json::to_value(session.login.bilibili_snapshot(BilibiliLoginFacts {
                    logged_in: !session.cookie.is_empty(),
                    data_exists: false,
                    data_path: String::new(),
                }))
                .unwrap_or(Value::Null);
            if !session.cookie.is_empty() {
                login["message"] = json!("Bilibili 已登录（设备私有存储）");
            }
            value["bbdown"]["login"] = login;
            value["remote_access"] = session.remote_access.clone();
        }
        Ok(value)
    }

    pub(crate) fn native_media_capabilities(
        &mut self,
        identity: &Identity,
        body: &Value,
    ) -> Result<Value, ApiError> {
        self.native_authorize(identity, true)?;
        if !self.native_session.desktop {
            return Ok(json!({"profile":"avc-aac-720p","hevc_available":false}));
        }
        if identity.client.is_empty() || identity.client.len() > 128 {
            return Err(ApiError::invalid("Missing Host player identity"));
        }
        if self
            .native_session
            .claim
            .as_ref()
            .is_some_and(|claim| claim.client != identity.client)
        {
            return Err(ApiError::new(
                409,
                "player_not_owner",
                "Another Host player owns the playback program",
            ));
        }
        let next = crate::native_host::preferences::PlayerMedia::reported(body)?;
        if next != self.native_session.player_media
            || self.native_session.media_client != identity.client
        {
            self.native_session.player_media = next;
            self.native_session.media_client = identity.client.clone();
            self.native_session.revision += 1;
        }
        Ok(self.native_session.player_media.snapshot())
    }

    pub(crate) fn native_claim(
        &mut self,
        identity: &Identity,
        body: &Value,
        retire: bool,
    ) -> Result<Value, ApiError> {
        self.native_authorize(identity, true)?;
        let generation = positive(body, "playback_generation")?;
        let incarnation = text(body, "item_incarnation_id")?;
        let artifact = text(body, "artifact_set_id")?;
        if identity.client.is_empty() || identity.client.len() > 128 {
            return Err(ApiError::invalid("缺少播放器身份"));
        }
        if retire {
            let released = self.native_session.claim.as_ref().is_some_and(|claim| {
                claim.client == identity.client
                    && claim.generation == generation
                    && claim.incarnation == incarnation
                    && claim.artifact == artifact
            });
            if released {
                self.native_session.claim = None;
            }
            return Ok(json!({"released":released}));
        }
        let snapshot = self.native_core_snapshot()?;
        let current = snapshot.playback_program.as_ref();
        let matches = snapshot.playback_generation == generation
            && current.is_some_and(|p| {
                p.item_incarnation_id == incarnation
                    && p.artifact_set_id.as_deref() == Some(&artifact)
            });
        let occupied = self
            .native_session
            .claim
            .as_ref()
            .is_some_and(|c| c.generation == generation && c.client != identity.client);
        if matches && !occupied {
            if self.native_session.desktop && self.native_session.media_client != identity.client {
                self.native_session.player_media = Default::default();
                self.native_session.media_client = identity.client.clone();
                self.native_session.revision += 1;
            }
            self.native_session.claim = Some(Claim {
                client: identity.client.clone(),
                generation,
                incarnation,
                artifact,
            });
        }
        Ok(json!({"claimed":matches && !occupied}))
    }

    pub(crate) fn native_player_status(
        &mut self,
        identity: &Identity,
        body: &Value,
        now: f64,
    ) -> Result<Value, ApiError> {
        self.native_authorize(identity, true)?;
        let generation = positive(body, "playback_generation")?;
        let sequence = positive(body, "status_sequence")?;
        let item_id = text(body, "item_id")?;
        let current_time = number(body, "current_time")?;
        let duration = number(body, "duration")?;
        let phase = text(body, "observed_phase")?;
        if current_time < 0.0
            || duration < 0.0
            || ![
                "playing",
                "paused",
                "ended",
                "ready-paused",
                "starting",
                "needs-user-gesture",
                "failed",
            ]
            .contains(&phase.as_str())
        {
            return Err(ApiError::invalid("无效的播放观测"));
        }
        let paused = body["is_paused"]
            .as_bool()
            .ok_or_else(|| ApiError::invalid("缺少暂停状态"))?;
        if paused == (phase == "playing") {
            return Err(ApiError::invalid("播放状态不一致"));
        }
        let snapshot = self.native_core_snapshot()?;
        if generation != snapshot.playback_generation
            || snapshot.current_item.as_ref().map(|i| i.id.as_str()) != Some(&item_id)
            || !self
                .native_session
                .claim
                .as_ref()
                .is_some_and(|c| c.client == identity.client && c.generation == generation)
        {
            return Err(ApiError::new(409, "stale_player", "此播放器已失效"));
        }
        let observation = json!({"item_id":item_id,"playback_generation":generation,"status_sequence":sequence,"observed_phase":phase,"is_paused":paused,"current_time":current_time,"duration":duration});
        if let Some(previous) = &self.native_session.observation
            && previous["playback_generation"] == generation
        {
            let old_sequence = previous["status_sequence"].as_u64().unwrap_or(0);
            if sequence < old_sequence || (sequence == old_sequence && *previous != observation) {
                return Err(ApiError::new(409, "stale_status", "旧的播放观测已忽略"));
            }
            if sequence == old_sequence {
                return Ok(json!({"accepted":true,"duplicate":true}));
            }
        }
        self.native_execute(AppStateRequest::ApplyPlayerStatusObservation {
            schema_version: 1,
            expected_playback_generation: generation,
            item_id,
            is_paused: paused,
            current_time,
            duration,
            now,
        })?;
        self.native_session.observation = Some(observation);
        self.native_session.revision += 1;
        Ok(json!({"accepted":true,"duplicate":false}))
    }

    pub(crate) fn native_control(
        &mut self,
        identity: &Identity,
        body: &Value,
        now: f64,
    ) -> Result<(), ApiError> {
        self.native_authorize(identity, false)?;
        let generation = positive(body, "playback_generation")?;
        let item_id = text(body, "item_id")?;
        let action = text(body, "action")?;
        let delta = if action == "seek-relative" {
            number(body, "delta_seconds")?
        } else {
            0.0
        };
        let target = if action == "seek-absolute" {
            Some(number(body, "target_seconds")?)
        } else {
            None
        };
        self.native_execute(AppStateRequest::IssuePlayerControl {
            schema_version: 1,
            control: PlayerControlInput {
                action,
                playback_generation: generation,
                item_id,
                delta_seconds: delta,
                target_seconds: target,
            },
            now,
        })?;
        Ok(())
    }

    pub(crate) fn native_ack(&mut self, identity: &Identity, body: &Value) -> Result<(), ApiError> {
        self.native_authorize(identity, true)?;
        let seq = positive(body, "seq")?;
        self.native_execute(AppStateRequest::AckPlayerControl {
            schema_version: 1,
            seq,
        })?;
        Ok(())
    }

    pub(crate) fn native_diagnostic(&mut self, body: &Value, now: f64) {
        let fields = [
            "event",
            "phase",
            "reason",
            "kind",
            "message",
            "item_id",
            "playback_generation",
            "action",
            "media_kind",
            "current_time",
            "duration",
            "ready_state",
            "network_state",
            "paused",
            "seeking",
            "ended",
            "error_code",
            "error_message",
            "play_rejection_name",
        ];
        let mut safe = json!({"at":now});
        for key in fields {
            if let Some(value) = body.get(key) {
                if let Some(text) = value.as_str() {
                    safe[key] = json!(text.chars().take(240).collect::<String>());
                } else if value.is_number() || value.is_boolean() {
                    safe[key] = value.clone();
                }
            }
        }
        // Keep both clocks, not just the media element that emitted an event.
        // Readiness alone cannot explain post-seek output-clock recovery.
        // These additions accept measurements only, never arbitrary text/URLs.
        for key in [
            "audio_current_time",
            "video_current_time",
            "drift_seconds",
            "drift_before_correction_seconds",
            "correction_target_audio_time",
            "effective_av_delay_seconds",
            "audio_playback_rate",
            "video_playback_rate",
            "audio_ready_state",
            "video_ready_state",
            "audio_network_state",
            "video_network_state",
            "audio_buffered_end",
            "video_buffered_end",
            "dropped_video_frames",
            "total_video_frames",
        ] {
            if let Some(value) = body.get(key).filter(|v| v.is_number()) {
                safe[key] = value.clone();
            }
        }
        for key in [
            "audio_paused",
            "video_paused",
            "audio_seeking",
            "video_seeking",
            "audio_ended",
            "video_ended",
            "local_should_be_playing",
            "sync_force_correction",
            "local_video_held_for_audio",
            "local_video_deferred_recovery",
        ] {
            if let Some(value) = body.get(key).filter(|v| v.is_boolean()) {
                safe[key] = value.clone();
            }
        }
        let log = &mut self.native_session.diagnostics;
        if log.len() >= 100 {
            log.pop_front();
        }
        log.push_back(safe);
    }

    pub(crate) fn native_diagnostics(&self) -> Value {
        json!({"backend":"rust","events":self.native_session.diagnostics,
            "remote_connection":self.native_session.remote_connection_diagnostics,
            "bilibili_login":self.native_session.login_diagnostics,
            "library_refresh":self.native_session.library_diagnostics,
            "ratings":self.native_session.ratings.events,
            "gatcha_task":self.native_session.login.gacha_snapshot()})
    }

    pub(crate) fn native_remote_connection_diagnostic(&mut self, body: &Value, now: f64) {
        let Some(
            event @ ("connected" | "stale" | "out_of_order" | "invalid_state" | "render_error"),
        ) = body["event"].as_str()
        else {
            return;
        };
        let Ok(snapshot) = self.native_core_snapshot() else {
            return;
        };
        let mut safe = json!({"at":now,"event":event,
            "host_revision":snapshot.revision + self.native_session.revision,
            "host_playback_generation":snapshot.playback_generation});
        for key in [
            "revision",
            "received_revision",
            "playback_generation",
            "rendered_generation",
            "stream_state",
            "age_ms",
        ] {
            if let Some(value) = body[key].as_u64() {
                safe[key] = json!(value);
            }
        }
        if let Some(visible) = body["visible"].as_bool() {
            safe["visible"] = json!(visible);
        }
        let log = &mut self.native_session.remote_connection_diagnostics;
        // Rejected frames may arrive frequently. Retain bounded evidence apart
        // from media events without letting repeated errors evict everything.
        if log.back().is_some_and(|last| {
            last["event"] == event && now - last["at"].as_f64().unwrap_or(0.0) < 5.0
        }) {
            return;
        }
        if log.len() >= 60 {
            log.pop_front();
        }
        log.push_back(safe);
    }
    pub(crate) fn native_library_diagnostic(
        &mut self,
        diagnostic: crate::native_host::LibraryDiagnostic,
    ) {
        let log = &mut self.native_session.library_diagnostics;
        if log.len() >= 50 {
            log.pop_front();
        }
        log.push_back(diagnostic);
    }
    pub(crate) fn native_login_diagnostic(
        &mut self,
        diagnostic: crate::native_host::LoginDiagnostic,
    ) {
        // Playback can emit many events per second; it must not evict the
        // evidence for an earlier login failure. Exported to Host diagnostics
        // only, not the shared Remote snapshot. Bounded for long sessions.
        let log = &mut self.native_session.login_diagnostics;
        if log.len() >= 50 {
            log.pop_front();
        }
        log.push_back(diagnostic);
    }
    pub(crate) fn native_release_claim(&mut self) {
        self.native_session.claim = None;
    }
}
