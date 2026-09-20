use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};

const DEFAULT_GACHA_BUSY_MESSAGE: &str = "拉取任务执行中，请等待任务结束";
const DEFAULT_BILIBILI_LOGGED_IN_MESSAGE: &str = "BBDown 已登录";
const DEFAULT_BILIBILI_INVALID_DATA_MESSAGE: &str =
    "BBDown 登录完成，但 BBDown.data 中未检测到有效的 SESSDATA 和 bili_jct";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum GachaTaskStatus {
    #[default]
    Idle,
    Running,
    Success,
    Partial,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GachaTaskUpdate {
    pub status: GachaTaskStatus,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub error: String,
    #[serde(default)]
    pub result: Option<Value>,
    #[serde(default = "default_true")]
    pub blocking: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GachaTaskSnapshot {
    pub busy: bool,
    pub background_busy: bool,
    pub blocking: bool,
    pub message: String,
    pub last_status: GachaTaskStatus,
    pub last_message: String,
    pub last_error: String,
    pub last_updated_at: f64,
    pub last_result: Option<Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum BilibiliLoginStatus {
    #[default]
    Idle,
    Starting,
    Waiting,
    LoggedIn,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BilibiliLoginUpdate {
    pub state: BilibiliLoginStatus,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub qr_image: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BilibiliLoginFacts {
    pub logged_in: bool,
    pub data_exists: bool,
    pub data_path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BilibiliLoginSnapshot {
    pub logged_in: bool,
    pub state: BilibiliLoginStatus,
    pub message: String,
    pub data_path: String,
    pub qr_image: String,
}

#[derive(Debug, Clone)]
struct GachaTaskState {
    status: GachaTaskStatus,
    message: String,
    error: String,
    updated_at: f64,
    result: Option<Value>,
    blocking: bool,
}

impl Default for GachaTaskState {
    fn default() -> Self {
        Self {
            status: GachaTaskStatus::Idle,
            message: String::new(),
            error: String::new(),
            updated_at: 0.0,
            result: None,
            blocking: true,
        }
    }
}

#[derive(Debug, Clone)]
struct BilibiliLoginState {
    state: BilibiliLoginStatus,
    message: String,
    qr_image: String,
}

impl Default for BilibiliLoginState {
    fn default() -> Self {
        Self {
            state: BilibiliLoginStatus::Idle,
            message: "未登录".to_string(),
            qr_image: String::new(),
        }
    }
}

#[derive(Debug, Default)]
pub struct RuntimeStatusService {
    gacha_task: GachaTaskState,
    gacha_refresh_lease: bool,
    gacha_busy_message: String,
    bilibili_login: BilibiliLoginState,
    bilibili_generation: u64,
    bilibili_worker: Option<u64>,
    bilibili_success: Option<u64>,
    refresh_generation: u64,
    configured_refresh: Option<crate::gatcha_refresh::RefreshTicket>,
}

impl RuntimeStatusService {
    #[cfg(any(feature = "native-host", test))]
    pub(crate) fn owns_configured_refresh(
        &self,
        ticket: &crate::gatcha_refresh::RefreshTicket,
    ) -> bool {
        self.configured_refresh.as_ref().is_some_and(|current| {
            current.0 == ticket.0 && std::sync::Arc::ptr_eq(&current.1, &ticket.1)
        })
    }
    pub(crate) fn begin_configured_refresh(
        &mut self,
        global_lock: bool,
        task: GachaTaskUpdate,
    ) -> Option<crate::gatcha_refresh::RefreshTicket> {
        if self.configured_refresh.is_some() || (global_lock && self.gacha_refresh_lease) {
            return None;
        }
        if global_lock {
            self.gacha_refresh_lease = true;
        }
        self.refresh_generation = self.refresh_generation.wrapping_add(1).max(1);
        let ticket = (
            self.refresh_generation,
            std::sync::Arc::new(crate::gatcha_refresh::RefreshControl::default()),
        );
        self.configured_refresh = Some(ticket.clone());
        self.set_gacha_busy_message(DEFAULT_GACHA_BUSY_MESSAGE.into());
        self.set_gacha_task(task);
        Some(ticket)
    }

    pub(crate) fn configured_refresh_progress(&mut self, generation: u64, progress: Value) {
        if self.configured_refresh.as_ref().map(|t| t.0) == Some(generation) {
            self.set_gacha_task(GachaTaskUpdate {
                status: GachaTaskStatus::Running,
                message: "正在重建抽卡缓存格式...".into(),
                error: String::new(),
                result: Some(serde_json::json!({"rebuild":progress})),
                blocking: false,
            });
        }
    }

    pub(crate) fn finish_configured_refresh(
        &mut self,
        generation: u64,
        global_lock: bool,
        task: GachaTaskUpdate,
    ) -> bool {
        if self.configured_refresh.as_ref().map(|t| t.0) != Some(generation) {
            return false;
        }
        self.configured_refresh = None;
        if global_lock {
            self.release_gacha_refresh();
        }
        self.set_gacha_task(task);
        true
    }

    pub fn gacha_snapshot(&self) -> GachaTaskSnapshot {
        let background_busy = self.gacha_task.status == GachaTaskStatus::Running;
        let busy = self.gacha_refresh_lease || (background_busy && self.gacha_task.blocking);
        GachaTaskSnapshot {
            busy,
            background_busy,
            blocking: self.gacha_task.blocking,
            message: if busy {
                self.effective_gacha_busy_message().to_string()
            } else {
                String::new()
            },
            last_status: self.gacha_task.status,
            last_message: self.gacha_task.message.clone(),
            last_error: self.gacha_task.error.clone(),
            last_updated_at: self.gacha_task.updated_at,
            last_result: self.gacha_task.result.clone(),
        }
    }

    pub fn try_begin_gacha_refresh(
        &mut self,
        busy_message: String,
        task: Option<GachaTaskUpdate>,
    ) -> bool {
        if self.gacha_refresh_lease
            || self
                .configured_refresh
                .as_ref()
                .is_some_and(|_| self.gacha_task.blocking)
        {
            return false;
        }
        self.gacha_refresh_lease = true;
        self.set_gacha_busy_message(busy_message);
        if let Some(update) = task {
            self.set_gacha_task(update);
        }
        true
    }

    pub fn release_gacha_refresh(&mut self) {
        self.gacha_refresh_lease = false;
    }

    pub fn set_gacha_task(&mut self, update: GachaTaskUpdate) {
        self.gacha_task = GachaTaskState {
            status: update.status,
            message: update.message,
            error: update.error,
            updated_at: unix_timestamp_seconds(),
            result: update.result,
            blocking: update.blocking,
        };
    }

    pub fn set_gacha_busy_message(&mut self, message: String) {
        if !message.trim().is_empty() {
            self.gacha_busy_message = message;
        }
    }

    pub fn reset_gacha(&mut self) {
        if let Some((_, control)) = self.configured_refresh.take() {
            control.stop();
        }
        self.gacha_task = GachaTaskState::default();
        self.gacha_refresh_lease = false;
        self.gacha_busy_message.clear();
    }

    pub fn active_bilibili_generation(&self) -> Option<u64> {
        matches!(
            self.bilibili_login.state,
            BilibiliLoginStatus::Starting | BilibiliLoginStatus::Waiting
        )
        .then_some(self.bilibili_generation)
    }

    pub fn claim_bilibili_worker(&mut self, generation: u64) -> bool {
        if self.active_bilibili_generation() != Some(generation) || self.bilibili_worker.is_some() {
            return false;
        }
        self.bilibili_worker = Some(generation);
        true
    }

    pub fn complete_bilibili_login(&mut self, generation: u64, update: BilibiliLoginUpdate) {
        if self.active_bilibili_generation() == Some(generation) {
            self.bilibili_success =
                (update.state == BilibiliLoginStatus::LoggedIn).then_some(generation);
            self.set_bilibili_login(Some(generation), update);
            self.bilibili_worker = None;
        }
    }

    pub fn take_bilibili_success(&mut self, generation: u64) -> bool {
        if self.bilibili_generation != generation
            || self.bilibili_success != Some(generation)
            || self.bilibili_login.state != BilibiliLoginStatus::LoggedIn
        {
            return false;
        }
        self.bilibili_success = None;
        true
    }

    pub fn begin_bilibili_login(&mut self, message: String) -> u64 {
        self.bilibili_worker = None;
        self.bilibili_success = None;
        self.bilibili_generation = self.bilibili_generation.wrapping_add(1).max(1);
        self.bilibili_login = BilibiliLoginState {
            state: BilibiliLoginStatus::Starting,
            message,
            qr_image: String::new(),
        };
        self.bilibili_generation
    }

    pub fn set_bilibili_login(
        &mut self,
        expected_generation: Option<u64>,
        update: BilibiliLoginUpdate,
    ) -> bool {
        if expected_generation.is_some_and(|value| value != self.bilibili_generation) {
            return false;
        }
        self.bilibili_login = BilibiliLoginState {
            state: update.state,
            message: update.message,
            qr_image: update.qr_image,
        };
        true
    }

    pub fn reset_bilibili_login(&mut self) {
        self.bilibili_worker = None;
        self.bilibili_success = None;
        self.bilibili_generation = self.bilibili_generation.wrapping_add(1).max(1);
        self.bilibili_login = BilibiliLoginState::default();
    }

    pub fn bilibili_snapshot(&self, facts: BilibiliLoginFacts) -> BilibiliLoginSnapshot {
        let (logged_in, state, message) =
            if self.bilibili_login.state == BilibiliLoginStatus::Failed {
                (
                    false,
                    BilibiliLoginStatus::Failed,
                    self.bilibili_login.message.clone(),
                )
            } else if facts.logged_in {
                (
                    true,
                    BilibiliLoginStatus::LoggedIn,
                    DEFAULT_BILIBILI_LOGGED_IN_MESSAGE.to_string(),
                )
            } else if facts.data_exists
                && !matches!(
                    self.bilibili_login.state,
                    BilibiliLoginStatus::Starting | BilibiliLoginStatus::Waiting
                )
            {
                (
                    false,
                    BilibiliLoginStatus::Failed,
                    DEFAULT_BILIBILI_INVALID_DATA_MESSAGE.to_string(),
                )
            } else {
                (
                    false,
                    self.bilibili_login.state,
                    self.bilibili_login.message.clone(),
                )
            };
        BilibiliLoginSnapshot {
            logged_in,
            state,
            message,
            data_path: facts.data_path,
            qr_image: if logged_in {
                String::new()
            } else {
                self.bilibili_login.qr_image.clone()
            },
        }
    }

    fn effective_gacha_busy_message(&self) -> &str {
        if self.gacha_busy_message.trim().is_empty() {
            DEFAULT_GACHA_BUSY_MESSAGE
        } else {
            &self.gacha_busy_message
        }
    }
}

impl Drop for RuntimeStatusService {
    fn drop(&mut self) {
        if let Some((_, control)) = &self.configured_refresh {
            control.stop();
        }
    }
}

fn default_true() -> bool {
    true
}

fn unix_timestamp_seconds() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |duration| duration.as_secs_f64())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn running_task(blocking: bool) -> GachaTaskUpdate {
        GachaTaskUpdate {
            status: GachaTaskStatus::Running,
            message: "refreshing".to_string(),
            error: String::new(),
            result: None,
            blocking,
        }
    }

    #[test]
    fn gacha_refresh_lease_is_exclusive_and_drives_busy_snapshot() {
        let mut service = RuntimeStatusService::default();
        assert!(service.try_begin_gacha_refresh("busy".to_string(), None));
        assert!(!service.try_begin_gacha_refresh("other".to_string(), None));
        let snapshot = service.gacha_snapshot();
        assert!(snapshot.busy);
        assert_eq!(snapshot.message, "busy");
        service.release_gacha_refresh();
        assert!(!service.gacha_snapshot().busy);
    }

    #[test]
    fn nonblocking_gacha_background_task_is_visible_without_blocking_actions() {
        let mut service = RuntimeStatusService::default();
        service.set_gacha_busy_message("busy".to_string());
        service.set_gacha_task(running_task(false));
        let snapshot = service.gacha_snapshot();
        assert!(snapshot.background_busy);
        assert!(!snapshot.busy);
        assert_eq!(snapshot.last_message, "refreshing");
    }

    #[test]
    fn stale_bilibili_generation_cannot_replace_new_login_state() {
        let mut service = RuntimeStatusService::default();
        let old_generation = service.begin_bilibili_login("first".to_string());
        let current_generation = service.begin_bilibili_login("second".to_string());
        assert_ne!(old_generation, current_generation);
        assert!(!service.set_bilibili_login(
            Some(old_generation),
            BilibiliLoginUpdate {
                state: BilibiliLoginStatus::Failed,
                message: "stale".to_string(),
                qr_image: String::new(),
            },
        ));
        assert_eq!(
            service
                .bilibili_snapshot(BilibiliLoginFacts {
                    logged_in: false,
                    data_exists: false,
                    data_path: "data".to_string(),
                })
                .message,
            "second"
        );
    }

    #[test]
    fn bilibili_snapshot_combines_owned_state_with_filesystem_facts() {
        let mut service = RuntimeStatusService::default();
        let generation = service.begin_bilibili_login("starting".to_string());
        assert!(service.set_bilibili_login(
            Some(generation),
            BilibiliLoginUpdate {
                state: BilibiliLoginStatus::Waiting,
                message: "scan".to_string(),
                qr_image: "data:image/png;base64,abc".to_string(),
            },
        ));
        let logged_in = service.bilibili_snapshot(BilibiliLoginFacts {
            logged_in: true,
            data_exists: true,
            data_path: "BBDown.data".to_string(),
        });
        assert!(logged_in.logged_in);
        assert_eq!(logged_in.state, BilibiliLoginStatus::LoggedIn);
        assert!(logged_in.qr_image.is_empty());

        service.reset_bilibili_login();
        let invalid = service.bilibili_snapshot(BilibiliLoginFacts {
            logged_in: false,
            data_exists: true,
            data_path: "BBDown.data".to_string(),
        });
        assert_eq!(invalid.state, BilibiliLoginStatus::Failed);
        assert!(invalid.message.contains("SESSDATA"));
    }
}
