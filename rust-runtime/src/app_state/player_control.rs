//! Shared transient player delivery, extracted from native_session's FIFO.
//! LAN HTTP/FFI and native Host use this one queue under the AppState mutex.
use super::*;
use std::collections::VecDeque;

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlayerControlInput {
    pub action: String,
    pub playback_generation: u64,
    pub item_id: String,
    #[serde(default)]
    pub delta_seconds: f64,
    pub target_seconds: Option<f64>,
}

#[derive(Debug, Default)]
pub(super) struct PlayerControls {
    sequence: u64,
    pub(super) revision: u64,
    commands: VecDeque<Value>,
}

impl PlayerControls {
    pub(super) fn clear(&mut self) {
        if !self.commands.is_empty() {
            self.commands.clear();
            self.revision = self.revision.saturating_add(1);
        }
        // Keep the sequence across reinitialization: late ACKs cannot name new commands.
    }

    fn head(&self) -> Option<&Value> {
        self.commands.front()
    }

    fn acknowledge(&mut self, seq: u64) -> bool {
        if self.head().is_some_and(|command| command["seq"] == seq) {
            self.commands.pop_front();
            self.revision = self.revision.saturating_add(1);
            true
        } else {
            false
        }
    }
}

impl AppState {
    pub(super) fn player_control_head(&self) -> Option<Value> {
        self.player_controls.head().cloned()
    }

    fn enqueue_player_control(
        &mut self,
        control: PlayerControlInput,
        now: f64,
    ) -> Result<Value, ExecuteError> {
        let data = self
            .data
            .as_ref()
            .ok_or_else(|| rejected("uninitialized", "AppState is unavailable"))?;
        if control.playback_generation != data.playback_generation
            || data.current_item.as_ref().map(|item| item.id.as_str()) != Some(&control.item_id)
        {
            return Err(rejected("stale_command", "歌曲已切换，请重试当前操作"));
        }
        if ![
            "toggle-play",
            "play",
            "pause",
            "seek-relative",
            "seek-absolute",
            "next-track",
        ]
        .contains(&control.action.as_str())
        {
            return Err(rejected("invalid_player_control", "无效的播放操作"));
        }
        if !control.delta_seconds.is_finite()
            || control.delta_seconds.abs() > 300.0
            || control.target_seconds.is_some_and(|value| {
                !value.is_finite() || !(0.0..=PLAYER_STATUS_MAX_SECONDS).contains(&value)
            })
            || (control.action == "seek-absolute" && control.target_seconds.is_none())
        {
            return Err(rejected("invalid_player_control", "跳转范围无效"));
        }
        let queue = &mut self.player_controls;
        if queue.commands.len() >= 16 {
            return Err(rejected("player_busy", "播放器仍在处理操作，请稍后再试"));
        }
        let sequence = queue
            .sequence
            .checked_add(1)
            .filter(|seq| *seq <= MAX_SAFE_JSON_INTEGER)
            .ok_or_else(|| ExecuteError::Internal("Player control sequence overflow".into()))?;
        let command = json!({"seq":sequence,"action":control.action,
            "playback_generation":control.playback_generation,"item_id":control.item_id,
            "delta_seconds":control.delta_seconds,"target_seconds":control.target_seconds,"issued_at":now});
        queue.sequence = sequence;
        queue.commands.push_back(command.clone());
        queue.revision = queue.revision.saturating_add(1);
        Ok(command)
    }

    pub(super) fn execute_player_control(&mut self, request: AppStateRequest) -> AppStateResponse {
        let Some(data) = &self.data else {
            return uninitialized_response();
        };
        let snapshot = match data.snapshot() {
            Ok(snapshot) => snapshot,
            Err(error) => return execute_error_response(error),
        };
        let persistence = data.persistence_snapshot();
        let result = match request {
            AppStateRequest::IssuePlayerControl { control, now, .. } => {
                match self.enqueue_player_control(control, now) {
                    Ok(command) => json!({"command":command}),
                    Err(error) => return execute_error_response(error),
                }
            }
            AppStateRequest::AckPlayerControl { seq, .. } => {
                if seq > MAX_SAFE_JSON_INTEGER {
                    return invalid_request_response(
                        "invalid_sequence",
                        "Invalid player ACK sequence",
                    );
                }
                json!({"acknowledged":self.player_controls.acknowledge(seq)})
            }
            AppStateRequest::PlayerControlSnapshot { .. } => {
                json!({"command":self.player_control_head()})
            }
            _ => unreachable!("player delivery request group changed"),
        };
        AppStateResponse::Success(Box::new(AppStateSuccess {
            schema_version: SCHEMA_VERSION,
            status: "completed",
            committed: false,
            snapshot: Some(snapshot),
            persistence: Some(persistence),
            effects: PersistenceEffects::default(),
            result,
        }))
    }
}
