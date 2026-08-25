use crate::app_state::{
    CacheAttemptReservation, authorize_cache_publication_for_runtime,
    begin_cache_attempt_for_runtime,
};
use crate::bilibili_service::{BilibiliDashRequest, BilibiliStream, fetch_dash_playurl};
use crate::http_downloader::{
    DownloadCandidate, DownloadError, DownloadErrorKind, DownloadRequest, HttpHeader,
    download_to_path,
};
use crate::media_backend::{
    ExpectedMediaKind, MediaErrorKind, MediaNormalizeRequest, MediaProbe, normalize_media,
};
use bilikara_rust::{
    AudioStreamDescriptor, AudioStreamSelection, AudioStreamSelectionRequest, QualityPolicyRequest,
    VideoCodec, VideoStreamDescriptor, VideoStreamSelection, VideoStreamSelectionRequest,
    decide_quality_policy, select_audio_stream, select_video_stream,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MAX_CACHE_JOBS: usize = 256;
const MAX_JOB_PAGES: usize = 32;
const MAX_EVENTS: usize = 4096;
const MAX_DRAIN_EVENTS: usize = 512;
const MAX_PARALLEL_TRACK_DOWNLOADS: usize = 4;
const TRACK_ATTEMPTS: u32 = 10;
const TRACK_RETRY_DELAY: Duration = Duration::from_secs(3);
const SHUTDOWN_WAIT: Duration = Duration::from_secs(30);
static ATTEMPT_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CachePageSpec {
    pub page: u32,
    pub cid: u64,
    #[serde(default)]
    pub duration_seconds: Option<f64>,
    #[serde(default)]
    pub label: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ExistingAudioVariant {
    pub id: String,
    pub label: String,
    pub page: u32,
    pub relative_path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CacheJobSpec {
    #[serde(default = "schema_version")]
    pub schema_version: u32,
    pub item_id: String,
    pub item_incarnation_id: String,
    pub bvid: String,
    #[serde(default)]
    pub aid: u64,
    pub video_page: u32,
    pub pages: Vec<CachePageSpec>,
    pub cache_root: PathBuf,
    pub log_file: PathBuf,
    #[serde(default)]
    pub cookie: String,
    #[serde(default = "default_user_agent")]
    pub user_agent: String,
    #[serde(default = "default_referer")]
    pub referer: String,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
    #[serde(default)]
    pub video_quality: String,
    #[serde(default)]
    pub avc_quality_cap: String,
    #[serde(default)]
    pub audio_hires: bool,
    #[serde(default)]
    pub selected_audio_variant_id: String,
    #[serde(default)]
    pub reported_ready: bool,
    #[serde(default)]
    pub existing_video_relative_path: String,
    #[serde(default)]
    pub existing_audio_variants: Vec<ExistingAudioVariant>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CacheJobPriority {
    #[default]
    Normal,
    Front,
    Urgent,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "command", rename_all = "snake_case", deny_unknown_fields)]
pub enum CacheRuntimeCommand {
    Start {},
    Sync {
        cache_root: PathBuf,
        #[serde(default)]
        current_ids: Vec<String>,
        #[serde(default)]
        current_item_incarnations: HashMap<String, String>,
        #[serde(default)]
        retained_ids: Vec<String>,
        #[serde(default)]
        jobs: Vec<CacheJobSpec>,
        #[serde(default)]
        ordered_ids: Vec<String>,
        #[serde(default)]
        preempt_item_id: String,
    },
    Submit {
        job: CacheJobSpec,
        #[serde(default)]
        priority: CacheJobPriority,
    },
    Retry {
        job: CacheJobSpec,
        #[serde(default)]
        urgent: bool,
    },
    Cancel {
        item_id: String,
        #[serde(default)]
        reason: String,
    },
    Clear {
        cache_root: PathBuf,
    },
    Metrics {
        cache_root: PathBuf,
    },
    Snapshot {},
    DrainEvents {
        #[serde(default = "default_event_limit")]
        max_events: usize,
    },
    Shutdown {},
}

#[derive(Clone, Debug, Serialize)]
pub struct CacheRuntimeError {
    pub kind: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_code: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_code: Option<i64>,
}

impl CacheRuntimeError {
    fn new(kind: &str, message: impl Into<String>) -> Self {
        Self {
            kind: kind.to_owned(),
            message: message.into(),
            status_code: None,
            api_code: None,
        }
    }
}

impl std::fmt::Display for CacheRuntimeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for CacheRuntimeError {}

#[derive(Clone, Debug, Serialize)]
struct CacheEvent {
    sequence: u64,
    generation: u64,
    cache_attempt_token: u64,
    item_id: String,
    kind: String,
    payload: Value,
}

#[derive(Clone)]
struct QueuedJob {
    generation: u64,
    cache_attempt_token: u64,
    reservation: CacheAttemptReservation,
    spec: CacheJobSpec,
}

struct ActiveJob {
    generation: u64,
    cache_attempt_token: u64,
    reservation: CacheAttemptReservation,
    cancel: Arc<AtomicBool>,
    urgent: bool,
}

#[derive(Clone)]
struct CompletedJob {
    generation: u64,
    cache_attempt_token: u64,
    reservation: CacheAttemptReservation,
    result: CacheReadyResult,
}

#[derive(Default)]
struct RuntimeState {
    stopping: bool,
    next_generation: u64,
    next_event_sequence: u64,
    jobs: HashMap<String, QueuedJob>,
    normal_queue: VecDeque<String>,
    urgent_queue: VecDeque<String>,
    queued_priorities: HashMap<String, CacheJobPriority>,
    active: HashMap<String, ActiveJob>,
    primary_active_item_id: Option<String>,
    cancel_reasons: HashMap<(String, u64), String>,
    completed: HashMap<String, CompletedJob>,
    terminal_events: HashMap<String, CacheEvent>,
    events: VecDeque<CacheEvent>,
}

struct SharedRuntime {
    state: Mutex<RuntimeState>,
    wake: Condvar,
}

struct CacheRuntime {
    shared: Arc<SharedRuntime>,
    workers: Mutex<Vec<JoinHandle<()>>>,
    reserve_cache_attempt: CacheAttemptReserver,
}

type CacheAttemptReserver = Arc<
    dyn Fn(&str, &str) -> Result<CacheAttemptReservation, CacheRuntimeError>
        + Send
        + Sync
        + 'static,
>;

#[derive(Clone, Debug, Serialize)]
struct CacheAttemptIdentity {
    generation: u64,
    cache_attempt_token: u64,
    item_incarnation_id: String,
    artifact_set_id: String,
    artifact_relative_directory: String,
    refresh: bool,
}

#[derive(Clone, Copy)]
enum WorkerKind {
    Primary,
    Urgent,
}

#[derive(Clone)]
struct TrackSpec {
    key: String,
    label: String,
    order: usize,
    page: CachePageSpec,
    kind: ExpectedMediaKind,
}

struct TrackResult {
    spec: TrackSpec,
    temporary_path: PathBuf,
    final_name: String,
    probe: MediaProbe,
}

#[derive(Clone, Debug, Serialize)]
struct ReadyAudioVariant {
    id: String,
    label: String,
    page: u32,
    audio_url: String,
}

#[derive(Clone, Debug, Serialize)]
struct CacheReadyResult {
    video_relative_path: String,
    video_media_url: String,
    audio_variants: Vec<ReadyAudioVariant>,
    selected_audio_variant_id: String,
    item_incarnation_id: String,
    artifact_set_id: String,
    artifact_relative_directory: String,
}

enum JobOutcome {
    Ready(CacheReadyResult),
    Cancelled,
    Failed(CacheRuntimeError),
}

static CACHE_RUNTIME: OnceLock<Mutex<Option<Arc<CacheRuntime>>>> = OnceLock::new();

fn schema_version() -> u32 {
    1
}

fn default_user_agent() -> String {
    "Mozilla/5.0 Bilikara Rust Runtime".to_owned()
}

fn default_referer() -> String {
    "https://www.bilibili.com/".to_owned()
}

fn default_timeout_ms() -> u64 {
    15_000
}

fn default_event_limit() -> usize {
    128
}

fn runtime_slot() -> &'static Mutex<Option<Arc<CacheRuntime>>> {
    CACHE_RUNTIME.get_or_init(|| Mutex::new(None))
}

fn active_runtime() -> Result<Arc<CacheRuntime>, CacheRuntimeError> {
    let mut slot = runtime_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(runtime) = slot.as_ref() {
        return Ok(Arc::clone(runtime));
    }
    let runtime = Arc::new(CacheRuntime::new()?);
    *slot = Some(Arc::clone(&runtime));
    Ok(runtime)
}

pub fn execute_cache_runtime(command: CacheRuntimeCommand) -> Result<Value, CacheRuntimeError> {
    match command {
        CacheRuntimeCommand::Start {} => Ok(active_runtime()?.snapshot()),
        CacheRuntimeCommand::Sync {
            cache_root,
            current_ids,
            current_item_incarnations,
            retained_ids,
            jobs,
            ordered_ids,
            preempt_item_id,
        } => {
            let current: HashSet<String> = current_ids
                .into_iter()
                .filter(|value| valid_item_id(value))
                .collect();
            if current.len() != current_item_incarnations.len()
                || current
                    .iter()
                    .any(|item_id| !current_item_incarnations.contains_key(item_id))
            {
                return Err(CacheRuntimeError::new(
                    "invalid_request",
                    "current cache item identities are inconsistent",
                ));
            }
            active_runtime()?.sync(
                &cache_root,
                current_item_incarnations,
                retained_ids,
                jobs,
                ordered_ids,
                &preempt_item_id,
            )
        }
        CacheRuntimeCommand::Submit { job, priority } => {
            validate_job(&job)?;
            let attempt = active_runtime()?.submit(job, priority, false)?;
            Ok(json!({
                "generation": attempt.generation,
                "cache_attempt_token": attempt.cache_attempt_token,
                "item_incarnation_id": attempt.item_incarnation_id,
                "artifact_set_id": attempt.artifact_set_id,
                "artifact_relative_directory": attempt.artifact_relative_directory,
                "refresh": attempt.refresh,
            }))
        }
        CacheRuntimeCommand::Retry { job, urgent } => {
            validate_job(&job)?;
            let attempt = active_runtime()?.submit(
                job,
                if urgent {
                    CacheJobPriority::Urgent
                } else {
                    CacheJobPriority::Front
                },
                true,
            )?;
            Ok(json!({
                "generation": attempt.generation,
                "cache_attempt_token": attempt.cache_attempt_token,
                "item_incarnation_id": attempt.item_incarnation_id,
                "artifact_set_id": attempt.artifact_set_id,
                "artifact_relative_directory": attempt.artifact_relative_directory,
                "refresh": attempt.refresh,
            }))
        }
        CacheRuntimeCommand::Cancel { item_id, reason } => {
            let cancelled = active_runtime()?.cancel_item(
                item_id.trim(),
                if reason.trim().is_empty() {
                    "cache cancelled"
                } else {
                    reason.trim()
                },
            );
            Ok(json!({"cancelled": cancelled}))
        }
        CacheRuntimeCommand::Clear { cache_root } => {
            validate_cache_root(&cache_root)?;
            let runtime = active_runtime()?;
            runtime.cancel_all("cache cleared");
            if !runtime.wait_until_idle(SHUTDOWN_WAIT) {
                return Err(CacheRuntimeError::new(
                    "busy",
                    "Rust cache workers did not stop before the clear deadline",
                ));
            }
            clear_directory(&cache_root)?;
            Ok(runtime.snapshot())
        }
        CacheRuntimeCommand::Metrics { cache_root } => {
            validate_cache_root(&cache_root)?;
            Ok(cache_metrics(&cache_root))
        }
        CacheRuntimeCommand::Snapshot {} => Ok(active_runtime()?.snapshot()),
        CacheRuntimeCommand::DrainEvents { max_events } => {
            Ok(active_runtime()?.drain_events(max_events))
        }
        CacheRuntimeCommand::Shutdown {} => {
            let runtime = runtime_slot()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .take();
            if let Some(runtime) = runtime {
                runtime.shutdown();
            }
            Ok(json!({"stopped": true}))
        }
    }
}

impl CacheRuntime {
    fn new() -> Result<Self, CacheRuntimeError> {
        Self::new_with_attempt_reserver(Arc::new(|item_id, item_incarnation_id| {
            begin_cache_attempt_for_runtime(item_id, item_incarnation_id)
                .map_err(|error| CacheRuntimeError::new(&error.kind, error.message))
        }))
    }

    fn new_with_attempt_reserver(
        reserve_cache_attempt: CacheAttemptReserver,
    ) -> Result<Self, CacheRuntimeError> {
        let shared = Arc::new(SharedRuntime {
            state: Mutex::new(RuntimeState::default()),
            wake: Condvar::new(),
        });
        let primary_shared = Arc::clone(&shared);
        let urgent_shared = Arc::clone(&shared);
        let primary = thread::Builder::new()
            .name("bilikara-cache-primary".to_owned())
            .spawn(move || worker_loop(primary_shared, WorkerKind::Primary))
            .map_err(|error| CacheRuntimeError::new("thread", error.to_string()))?;
        let urgent = match thread::Builder::new()
            .name("bilikara-cache-urgent".to_owned())
            .spawn(move || worker_loop(urgent_shared, WorkerKind::Urgent))
        {
            Ok(handle) => handle,
            Err(error) => {
                {
                    let mut state = lock_state(&shared);
                    state.stopping = true;
                    shared.wake.notify_all();
                }
                let _ = primary.join();
                return Err(CacheRuntimeError::new("thread", error.to_string()));
            }
        };
        Ok(Self {
            shared,
            workers: Mutex::new(vec![primary, urgent]),
            reserve_cache_attempt,
        })
    }

    #[cfg(test)]
    fn new_without_workers(reserve_cache_attempt: CacheAttemptReserver) -> Self {
        Self {
            shared: Arc::new(SharedRuntime {
                state: Mutex::new(RuntimeState::default()),
                wake: Condvar::new(),
            }),
            workers: Mutex::new(Vec::new()),
            reserve_cache_attempt,
        }
    }

    fn submit(
        &self,
        job: CacheJobSpec,
        priority: CacheJobPriority,
        replace: bool,
    ) -> Result<CacheAttemptIdentity, CacheRuntimeError> {
        validate_job(&job)?;
        let item_id = job.item_id.clone();
        let mut state = lock_state(&self.shared);
        if state.stopping {
            return Err(CacheRuntimeError::new(
                "stopped",
                "Rust cache runtime is stopping",
            ));
        }
        if state.jobs.len() >= MAX_CACHE_JOBS && !state.jobs.contains_key(&item_id) {
            return Err(CacheRuntimeError::new(
                "queue_full",
                "Rust cache queue is full",
            ));
        }
        if !replace {
            if let Some(existing) = state.jobs.get(&item_id)
                && existing.reservation.item_incarnation_id == job.item_incarnation_id
            {
                return Ok(CacheAttemptIdentity {
                    generation: existing.generation,
                    cache_attempt_token: existing.cache_attempt_token,
                    item_incarnation_id: existing.reservation.item_incarnation_id.clone(),
                    artifact_set_id: existing.reservation.artifact_set_id.clone(),
                    artifact_relative_directory: existing
                        .reservation
                        .artifact_relative_directory
                        .clone(),
                    refresh: existing.reservation.refresh,
                });
            }
            if !state.jobs.contains_key(&item_id) {
                if let Some(active) = state.active.get(&item_id)
                    && active.reservation.item_incarnation_id == job.item_incarnation_id
                {
                    return Ok(CacheAttemptIdentity {
                        generation: active.generation,
                        cache_attempt_token: active.cache_attempt_token,
                        item_incarnation_id: active.reservation.item_incarnation_id.clone(),
                        artifact_set_id: active.reservation.artifact_set_id.clone(),
                        artifact_relative_directory: active
                            .reservation
                            .artifact_relative_directory
                            .clone(),
                        refresh: active.reservation.refresh,
                    });
                }
                if let Some(completed) = state.completed.get(&item_id)
                    && completed.reservation.item_incarnation_id == job.item_incarnation_id
                    && completed_artifacts_ready(&job.cache_root, &completed.result)
                {
                    return Ok(CacheAttemptIdentity {
                        generation: completed.generation,
                        cache_attempt_token: completed.cache_attempt_token,
                        item_incarnation_id: completed.reservation.item_incarnation_id.clone(),
                        artifact_set_id: completed.reservation.artifact_set_id.clone(),
                        artifact_relative_directory: completed
                            .reservation
                            .artifact_relative_directory
                            .clone(),
                        refresh: completed.reservation.refresh,
                    });
                }
            }
        }
        let next_generation = state
            .next_generation
            .checked_add(1)
            .filter(|generation| *generation > 0)
            .ok_or_else(|| {
                CacheRuntimeError::new("generation_exhausted", "cache generation is exhausted")
            })?;
        let replace_existing =
            replace || state.active.contains_key(&item_id) || state.jobs.contains_key(&item_id);
        let reservation = self.reserve_attempt(&job.item_id, &job.item_incarnation_id)?;
        let cache_attempt_token = reservation.cache_attempt_token;
        state.completed.remove(&item_id);
        if replace_existing {
            if let Some(active) = state.active.get(&item_id) {
                active.cancel.store(true, Ordering::Release);
                let generation = active.generation;
                state.cancel_reasons.insert(
                    (item_id.clone(), generation),
                    if replace {
                        "retry requested"
                    } else {
                        "item incarnation replaced"
                    }
                    .to_owned(),
                );
            }
            remove_queued_locked(&mut state, &item_id);
        }
        state.terminal_events.remove(&item_id);
        state.next_generation = next_generation;
        let generation = next_generation;
        state.jobs.insert(
            item_id.clone(),
            QueuedJob {
                generation,
                cache_attempt_token,
                reservation: reservation.clone(),
                spec: job,
            },
        );
        queue_locked(&mut state, &item_id, priority);
        push_event_locked(
            &mut state,
            generation,
            cache_attempt_token,
            &item_id,
            "queued",
            json!({"priority": priority_name(priority)}),
        );
        self.shared.wake.notify_all();
        Ok(CacheAttemptIdentity {
            generation,
            cache_attempt_token,
            item_incarnation_id: reservation.item_incarnation_id,
            artifact_set_id: reservation.artifact_set_id,
            artifact_relative_directory: reservation.artifact_relative_directory,
            refresh: reservation.refresh,
        })
    }

    fn reserve_attempt(
        &self,
        item_id: &str,
        expected_item_incarnation_id: &str,
    ) -> Result<CacheAttemptReservation, CacheRuntimeError> {
        let reservation = (self.reserve_cache_attempt)(item_id, expected_item_incarnation_id)?;
        if reservation.cache_attempt_token == 0
            || reservation.item_id != item_id
            || reservation.item_incarnation_id != expected_item_incarnation_id
            || reservation.item_incarnation_id.is_empty()
            || reservation.artifact_set_id.is_empty()
            || reservation.artifact_relative_directory.is_empty()
        {
            return Err(CacheRuntimeError::new(
                "invalid_cache_attempt_reservation",
                "AppState returned an invalid cache attempt reservation",
            ));
        }
        Ok(reservation)
    }

    fn sync(
        &self,
        cache_root: &Path,
        current_item_incarnations: HashMap<String, String>,
        retained_ids: Vec<String>,
        jobs: Vec<CacheJobSpec>,
        ordered_ids: Vec<String>,
        preempt_item_id: &str,
    ) -> Result<Value, CacheRuntimeError> {
        validate_cache_root(cache_root)?;
        if jobs.len() > MAX_CACHE_JOBS {
            return Err(CacheRuntimeError::new(
                "invalid_request",
                "too many cache jobs",
            ));
        }
        for job in &jobs {
            validate_job(job)?;
            if job.cache_root != cache_root {
                return Err(CacheRuntimeError::new(
                    "invalid_request",
                    "cache job root does not match sync root",
                ));
            }
        }
        let current: HashSet<String> = current_item_incarnations.keys().cloned().collect();
        if current.iter().any(|item_id| {
            current_item_incarnations
                .get(item_id)
                .is_none_or(|item_incarnation_id| item_incarnation_id.is_empty())
        }) {
            return Err(CacheRuntimeError::new(
                "invalid_request",
                "current cache item incarnation is missing",
            ));
        }
        let retained: HashSet<String> = retained_ids
            .into_iter()
            .filter(|value| current.contains(value))
            .collect();
        let desired: HashSet<String> = jobs.iter().map(|job| job.item_id.clone()).collect();
        {
            let mut state = lock_state(&self.shared);
            let mut eviction_tokens = HashMap::new();
            for item_id in current.difference(&retained) {
                if !state.active.contains_key(item_id) && !state.jobs.contains_key(item_id) {
                    let expected_item_incarnation_id =
                        current_item_incarnations.get(item_id).ok_or_else(|| {
                            CacheRuntimeError::new(
                                "invalid_request",
                                "current cache item incarnation is missing",
                            )
                        })?;
                    eviction_tokens.insert(
                        item_id.clone(),
                        self.reserve_attempt(item_id, expected_item_incarnation_id)?,
                    );
                }
            }
            state
                .terminal_events
                .retain(|item_id, _| current.contains(item_id));
            state.completed.retain(|item_id, completed| {
                current.contains(item_id)
                    && current_item_incarnations.get(item_id)
                        == Some(&completed.reservation.item_incarnation_id)
                    && completed_artifacts_ready(cache_root, &completed.result)
            });
            let queued_ids: Vec<String> = state.jobs.keys().cloned().collect();
            for item_id in queued_ids {
                if desired.contains(&item_id)
                    || state.active.contains_key(&item_id)
                    || (current.contains(&item_id) && !retained.contains(&item_id))
                {
                    continue;
                }
                if let Some(job) = state.jobs.remove(&item_id) {
                    remove_queued_locked(&mut state, &item_id);
                    push_event_locked(
                        &mut state,
                        job.generation,
                        job.cache_attempt_token,
                        &item_id,
                        "cancelled",
                        json!({"reason": "outside cache window"}),
                    );
                }
            }
            let active_ids: Vec<(String, u64)> = state
                .active
                .iter()
                .filter(|(item_id, _)| !desired.contains(*item_id))
                .map(|(item_id, active)| (item_id.clone(), active.generation))
                .collect();
            for (item_id, generation) in active_ids {
                if let Some(active) = state.active.get(&item_id) {
                    active.cancel.store(true, Ordering::Release);
                }
                state
                    .cancel_reasons
                    .insert((item_id, generation), "outside cache window".to_owned());
            }
            for item_id in current.difference(&retained) {
                if state.active.contains_key(item_id) {
                    continue;
                }
                if let Some(job) = state.jobs.remove(item_id) {
                    remove_queued_locked(&mut state, item_id);
                    push_event_locked(
                        &mut state,
                        job.generation,
                        job.cache_attempt_token,
                        item_id,
                        "evicted",
                        json!({"reason": "outside cache window"}),
                    );
                } else {
                    push_event_locked(
                        &mut state,
                        0,
                        eviction_tokens
                            .get(item_id)
                            .ok_or_else(|| {
                                CacheRuntimeError::new(
                                    "cache_attempt_not_reserved",
                                    "eviction cache attempt was not reserved",
                                )
                            })?
                            .cache_attempt_token,
                        item_id,
                        "evicted",
                        json!({"reason": "outside cache window"}),
                    );
                }
            }
        }

        let mut generations = serde_json::Map::new();
        let mut cache_attempt_tokens = serde_json::Map::new();
        let preempt_item_id = preempt_item_id.trim();
        for job in jobs {
            if existing_artifacts_ready(&job) {
                continue;
            }
            if self.completed_artifacts_ready(&job, cache_root) {
                continue;
            }
            let replace = !preempt_item_id.is_empty() && job.item_id == preempt_item_id;
            let attempt = self.submit(job.clone(), CacheJobPriority::Normal, replace)?;
            generations.insert(job.item_id.clone(), json!(attempt.generation));
            cache_attempt_tokens.insert(job.item_id, json!(attempt.cache_attempt_token));
        }
        self.reorder(&ordered_ids);
        Ok(json!({
            "generations": generations,
            "cache_attempt_tokens": cache_attempt_tokens,
            "snapshot": self.snapshot(),
        }))
    }

    fn reorder(&self, ordered_ids: &[String]) {
        let mut state = lock_state(&self.shared);
        let queued: HashSet<String> = state.normal_queue.drain(..).collect();
        for item_id in ordered_ids {
            if queued.contains(item_id)
                && state
                    .queued_priorities
                    .get(item_id)
                    .is_some_and(|priority| !matches!(priority, CacheJobPriority::Urgent))
            {
                state.normal_queue.push_back(item_id.clone());
            }
        }
        for item_id in queued {
            if !state.normal_queue.contains(&item_id) {
                state.normal_queue.push_back(item_id);
            }
        }
        self.shared.wake.notify_all();
    }

    fn cancel_item(&self, item_id: &str, reason: &str) -> bool {
        if !valid_item_id(item_id) {
            return false;
        }
        let mut state = lock_state(&self.shared);
        state.completed.remove(item_id);
        let mut cancelled = false;
        if let Some(active) = state.active.get(item_id) {
            active.cancel.store(true, Ordering::Release);
            let generation = active.generation;
            state
                .cancel_reasons
                .insert((item_id.to_owned(), generation), reason.to_owned());
            cancelled = true;
        }
        if let Some(job) = state.jobs.remove(item_id) {
            remove_queued_locked(&mut state, item_id);
            if !state.active.contains_key(item_id) {
                push_event_locked(
                    &mut state,
                    job.generation,
                    job.cache_attempt_token,
                    item_id,
                    "cancelled",
                    json!({"reason": reason}),
                );
            }
            cancelled = true;
        }
        self.shared.wake.notify_all();
        cancelled
    }

    fn cancel_all(&self, reason: &str) {
        let mut state = lock_state(&self.shared);
        let active: Vec<(String, u64)> = state
            .active
            .iter()
            .map(|(item_id, active)| {
                active.cancel.store(true, Ordering::Release);
                (item_id.clone(), active.generation)
            })
            .collect();
        for key in active {
            state.cancel_reasons.insert(key, reason.to_owned());
        }
        let queued: Vec<QueuedJob> = state.jobs.values().cloned().collect();
        state.jobs.clear();
        state.normal_queue.clear();
        state.urgent_queue.clear();
        state.queued_priorities.clear();
        state.completed.clear();
        state.terminal_events.clear();
        for job in queued {
            if !state.active.contains_key(&job.spec.item_id) {
                push_event_locked(
                    &mut state,
                    job.generation,
                    job.cache_attempt_token,
                    &job.spec.item_id,
                    "cancelled",
                    json!({"reason": reason}),
                );
            }
        }
        self.shared.wake.notify_all();
    }

    fn wait_until_idle(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut state = lock_state(&self.shared);
        while !state.active.is_empty() && Instant::now() < deadline {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let (next, _) = self
                .shared
                .wake
                .wait_timeout(state, remaining.min(Duration::from_millis(250)))
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state = next;
        }
        state.active.is_empty()
    }

    fn snapshot(&self) -> Value {
        let state = lock_state(&self.shared);
        snapshot_locked(&state)
    }

    fn completed_artifacts_ready(&self, job: &CacheJobSpec, cache_root: &Path) -> bool {
        let mut state = lock_state(&self.shared);
        let ready = state.completed.get(&job.item_id).is_some_and(|completed| {
            completed.reservation.item_incarnation_id == job.item_incarnation_id
                && completed_artifacts_ready(cache_root, &completed.result)
        });
        if !ready {
            state.completed.remove(&job.item_id);
        }
        ready
    }

    fn drain_events(&self, max_events: usize) -> Value {
        let limit = max_events.clamp(1, MAX_DRAIN_EVENTS);
        let mut state = lock_state(&self.shared);
        let events: Vec<CacheEvent> = (0..limit)
            .filter_map(|_| state.events.pop_front())
            .collect();
        json!({"events": events, "snapshot": snapshot_locked(&state)})
    }

    fn shutdown(&self) {
        {
            let mut state = lock_state(&self.shared);
            state.stopping = true;
            let active: Vec<(String, u64)> = state
                .active
                .iter()
                .map(|(item_id, active)| {
                    active.cancel.store(true, Ordering::Release);
                    (item_id.clone(), active.generation)
                })
                .collect();
            for key in active {
                state.cancel_reasons.insert(key, "cache stopped".to_owned());
            }
            state.normal_queue.clear();
            state.urgent_queue.clear();
            state.queued_priorities.clear();
            state.jobs.clear();
            state.completed.clear();
            self.shared.wake.notify_all();
        }
        let handles = std::mem::take(
            &mut *self
                .workers
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        );
        for handle in handles {
            let _ = handle.join();
        }
    }
}

fn lock_state(shared: &SharedRuntime) -> std::sync::MutexGuard<'_, RuntimeState> {
    shared
        .state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn worker_loop(shared: Arc<SharedRuntime>, kind: WorkerKind) {
    loop {
        let (job, cancel) = {
            let mut state = lock_state(&shared);
            loop {
                if state.stopping {
                    return;
                }
                let item_id = match kind {
                    WorkerKind::Primary => state.normal_queue.pop_front(),
                    WorkerKind::Urgent => state.urgent_queue.pop_front(),
                };
                let Some(item_id) = item_id else {
                    state = shared
                        .wake
                        .wait(state)
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    continue;
                };
                if state.active.contains_key(&item_id) {
                    match kind {
                        WorkerKind::Primary => state.normal_queue.push_back(item_id),
                        WorkerKind::Urgent => state.urgent_queue.push_back(item_id),
                    }
                    let (next, _) = shared
                        .wake
                        .wait_timeout(state, Duration::from_millis(100))
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    state = next;
                    continue;
                }
                let Some(job) = state.jobs.get(&item_id).cloned() else {
                    state.queued_priorities.remove(&item_id);
                    continue;
                };
                state.queued_priorities.remove(&item_id);
                let cancel = Arc::new(AtomicBool::new(false));
                state.active.insert(
                    item_id.clone(),
                    ActiveJob {
                        generation: job.generation,
                        cache_attempt_token: job.cache_attempt_token,
                        reservation: job.reservation.clone(),
                        cancel: Arc::clone(&cancel),
                        urgent: matches!(kind, WorkerKind::Urgent),
                    },
                );
                if matches!(kind, WorkerKind::Primary) {
                    state.primary_active_item_id = Some(item_id.clone());
                }
                let initial_tracks = initial_track_payloads(&job.spec).unwrap_or_default();
                push_event_locked(
                    &mut state,
                    job.generation,
                    job.cache_attempt_token,
                    &item_id,
                    "started",
                    json!({"tracks": initial_tracks}),
                );
                break (job, cancel);
            }
        };

        let outcome = run_job(&shared, &job, &cancel);
        let mut state = lock_state(&shared);
        settle_job_locked(&mut state, &job, outcome);
        shared.wake.notify_all();
    }
}

fn settle_job_locked(state: &mut RuntimeState, job: &QueuedJob, outcome: JobOutcome) {
    if state
        .active
        .get(&job.spec.item_id)
        .is_some_and(|active| active.generation == job.generation)
    {
        state.active.remove(&job.spec.item_id);
    }
    if state.primary_active_item_id.as_deref() == Some(job.spec.item_id.as_str())
        && !state.active.contains_key(&job.spec.item_id)
    {
        state.primary_active_item_id = None;
    }
    let current_generation = state
        .jobs
        .get(&job.spec.item_id)
        .map(|value| value.generation);
    if current_generation == Some(job.generation) {
        state.jobs.remove(&job.spec.item_id);
    }
    let cancellation_reason = state
        .cancel_reasons
        .remove(&(job.spec.item_id.clone(), job.generation))
        .unwrap_or_else(|| "cache cancelled".to_owned());
    match outcome {
        JobOutcome::Ready(result) => {
            if current_generation.is_none() || current_generation == Some(job.generation) {
                state.completed.insert(
                    job.spec.item_id.clone(),
                    CompletedJob {
                        generation: job.generation,
                        cache_attempt_token: job.cache_attempt_token,
                        reservation: job.reservation.clone(),
                        result: result.clone(),
                    },
                );
            }
            push_event_locked(
                state,
                job.generation,
                job.cache_attempt_token,
                &job.spec.item_id,
                "ready",
                serde_json::to_value(result).unwrap_or_else(|_| json!({})),
            )
        }
        JobOutcome::Cancelled => push_event_locked(
            state,
            job.generation,
            job.cache_attempt_token,
            &job.spec.item_id,
            "cancelled",
            json!({"reason": cancellation_reason}),
        ),
        JobOutcome::Failed(error) => push_event_locked(
            state,
            job.generation,
            job.cache_attempt_token,
            &job.spec.item_id,
            "failed",
            serde_json::to_value(&error).unwrap_or_else(|_| {
                json!({"kind": "invalid_response", "message": "cache error serialization failed"})
            }),
        ),
    }
}

fn run_job(shared: &Arc<SharedRuntime>, job: &QueuedJob, cancel: &Arc<AtomicBool>) -> JobOutcome {
    if cancel.load(Ordering::Acquire) {
        return JobOutcome::Cancelled;
    }
    let staging_dir = job
        .spec
        .cache_root
        .join(".staging")
        .join(&job.reservation.item_incarnation_id)
        .join(&job.reservation.artifact_set_id);
    if let Some(parent) = staging_dir.parent()
        && let Err(error) = create_directory_within_cache_root(&job.spec.cache_root, parent)
    {
        return JobOutcome::Failed(error);
    }
    if let Err(error) = fs::create_dir(&staging_dir) {
        return JobOutcome::Failed(CacheRuntimeError::new("io", error.to_string()));
    }
    if let Err(error) = canonical_directory_within_cache_root(&job.spec.cache_root, &staging_dir) {
        return JobOutcome::Failed(error);
    }
    append_log(
        &job.spec.log_file,
        &format!("start Rust cache generation {}", job.generation),
    );
    let track_specs = match track_specs(&job.spec) {
        Ok(tracks) => tracks,
        Err(error) => return JobOutcome::Failed(error),
    };
    let mut results = Vec::new();
    let mut failures = Vec::new();
    for batch in track_specs.chunks(MAX_PARALLEL_TRACK_DOWNLOADS) {
        let mut handles = Vec::with_capacity(batch.len());
        for track in batch.iter().cloned() {
            let shared = Arc::clone(shared);
            let job = job.clone();
            let track_cancel = Arc::clone(cancel);
            match thread::Builder::new()
                .name(format!("bilikara-cache-track-{}", track.key))
                .spawn(move || run_track(&shared, &job, &track, &track_cancel))
            {
                Ok(handle) => handles.push(handle),
                Err(error) => {
                    failures.push(CacheRuntimeError::new("thread", error.to_string()));
                    cancel.store(true, Ordering::Release);
                }
            }
        }
        for handle in handles {
            match handle.join() {
                Ok(Ok(result)) => results.push(result),
                Ok(Err(error)) => {
                    if error.kind != "cancelled" {
                        failures.push(error);
                    }
                    cancel.store(true, Ordering::Release);
                }
                Err(_) => {
                    failures.push(CacheRuntimeError::new(
                        "worker_panic",
                        "Rust cache track worker panicked",
                    ));
                    cancel.store(true, Ordering::Release);
                }
            }
        }
        if cancel.load(Ordering::Acquire) {
            break;
        }
    }
    if !failures.is_empty() {
        let _ = fs::remove_dir_all(&staging_dir);
        let error = failures.remove(0);
        append_log(
            &job.spec.log_file,
            &format!("cache failed: {}", error.message),
        );
        return JobOutcome::Failed(error);
    }
    if cancel.load(Ordering::Acquire) {
        let _ = fs::remove_dir_all(&staging_dir);
        append_log(&job.spec.log_file, "cache cancelled");
        return JobOutcome::Cancelled;
    }
    match publish_tracks_for_attempt(&job.spec, &job.reservation, results) {
        Ok(result) => {
            append_log(&job.spec.log_file, "cache ready");
            JobOutcome::Ready(result)
        }
        Err(error) => {
            let _ = fs::remove_dir_all(&staging_dir);
            append_log(
                &job.spec.log_file,
                &format!("publish failed: {}", error.message),
            );
            JobOutcome::Failed(error)
        }
    }
}

fn run_track(
    shared: &Arc<SharedRuntime>,
    job: &QueuedJob,
    track: &TrackSpec,
    cancel: &Arc<AtomicBool>,
) -> Result<TrackResult, CacheRuntimeError> {
    let mut last_error = CacheRuntimeError::new("download", "track download failed");
    for attempt in 1..=TRACK_ATTEMPTS {
        if cancel.load(Ordering::Acquire) {
            return Err(CacheRuntimeError::new("cancelled", "cache cancelled"));
        }
        emit_track_progress(shared, job, track, "resolving", attempt, (0, 0));
        let stream = match resolve_track_stream(&job.spec, track) {
            Ok(stream) => stream,
            Err(error) => {
                last_error = error;
                if is_terminal_track_error(&last_error) {
                    return Err(last_error);
                }
                if !wait_for_retry(cancel, attempt) {
                    return Err(CacheRuntimeError::new("cancelled", "cache cancelled"));
                }
                continue;
            }
        };
        let extension = match track.kind {
            ExpectedMediaKind::Video => "mp4",
            ExpectedMediaKind::Audio if stream.codec_name.as_deref() == Some("flac") => "flac",
            ExpectedMediaKind::Audio => "m4a",
        };
        let final_name = match track.kind {
            ExpectedMediaKind::Video => format!("video-p{}.{}", track.page.page, extension),
            ExpectedMediaKind::Audio => format!("audio-p{}.{}", track.page.page, extension),
        };
        let attempt_dir = job
            .spec
            .cache_root
            .join(".staging")
            .join(&job.reservation.item_incarnation_id)
            .join(&job.reservation.artifact_set_id)
            .join(format!(
                "track-{}-{}",
                job.generation,
                ATTEMPT_SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
        if let Err(error) = fs::create_dir_all(&attempt_dir) {
            return Err(CacheRuntimeError::new("io", error.to_string()));
        }
        let raw_path = attempt_dir.join(format!(".{final_name}.raw"));
        let normalized_path = attempt_dir.join(&final_name);
        emit_track_progress(shared, job, track, "downloading", attempt, (0, 0));
        let request = match download_request(&job.spec, &stream, raw_path.clone()) {
            Ok(request) => request,
            Err(error) => {
                let _ = fs::remove_dir_all(&attempt_dir);
                return Err(error);
            }
        };
        let download = download_to_path(&request, |progress| {
            emit_track_progress(
                shared,
                job,
                track,
                "downloading",
                attempt,
                (progress.downloaded_bytes, progress.total_bytes.unwrap_or(0)),
            );
            !cancel.load(Ordering::Acquire)
        });
        if let Err(error) = download {
            let _ = fs::remove_dir_all(&attempt_dir);
            if error.kind == DownloadErrorKind::Cancelled {
                return Err(CacheRuntimeError::new("cancelled", "cache cancelled"));
            }
            last_error = cache_download_error(track, error);
            append_log(
                &job.spec.log_file,
                &format!(
                    "{} attempt {}/{} failed: {}",
                    track.label, attempt, TRACK_ATTEMPTS, last_error.message
                ),
            );
            if is_terminal_track_error(&last_error) {
                return Err(last_error);
            }
            if !wait_for_retry(cancel, attempt) {
                return Err(CacheRuntimeError::new("cancelled", "cache cancelled"));
            }
            continue;
        }
        emit_track_progress(shared, job, track, "validating", attempt, (0, 0));
        let normalized = normalize_media(&MediaNormalizeRequest {
            schema_version: 1,
            source: raw_path.clone(),
            destination: normalized_path.clone(),
            expected_kind: track.kind,
        });
        let _ = fs::remove_file(&raw_path);
        match normalized {
            Ok(result) => {
                if result.output.duration_seconds < 1.0 {
                    last_error = CacheRuntimeError::new(
                        "invalid_media",
                        format!("{} has an invalid duration", track.label),
                    );
                    let _ = fs::remove_dir_all(&attempt_dir);
                } else if track.kind == ExpectedMediaKind::Video
                    && track.page.duration_seconds.is_some_and(|expected| {
                        result.output.duration_seconds + duration_tolerance(expected) < expected
                    })
                {
                    last_error = CacheRuntimeError::new(
                        "invalid_media",
                        format!("{} is shorter than expected", track.label),
                    );
                    let _ = fs::remove_dir_all(&attempt_dir);
                } else {
                    let size = result.output.file_bytes;
                    emit_track_progress(shared, job, track, "ready", attempt, (size, size));
                    return Ok(TrackResult {
                        spec: track.clone(),
                        temporary_path: normalized_path,
                        final_name,
                        probe: result.output,
                    });
                }
            }
            Err(error) => {
                let kind = match error.kind {
                    MediaErrorKind::InvalidRequest => "invalid_request",
                    MediaErrorKind::SourceMissing => "source_missing",
                    MediaErrorKind::DestinationExists => "destination_exists",
                    MediaErrorKind::UnsupportedCodec => "unsupported_codec",
                    MediaErrorKind::InvalidMedia => "invalid_media",
                    MediaErrorKind::Io => "io",
                };
                last_error =
                    CacheRuntimeError::new(kind, format!("{}: {}", track.label, error.message));
                let _ = fs::remove_dir_all(&attempt_dir);
            }
        }
        append_log(
            &job.spec.log_file,
            &format!(
                "{} attempt {}/{} failed: {}",
                track.label, attempt, TRACK_ATTEMPTS, last_error.message
            ),
        );
        if is_terminal_track_error(&last_error) {
            return Err(last_error);
        }
        if !wait_for_retry(cancel, attempt) {
            return Err(CacheRuntimeError::new("cancelled", "cache cancelled"));
        }
    }
    last_error.message = format!(
        "{} failed after {} attempts: {}",
        track.label, TRACK_ATTEMPTS, last_error.message
    );
    Err(last_error)
}

fn cache_download_error(track: &TrackSpec, error: DownloadError) -> CacheRuntimeError {
    let status_code = error.http_status;
    let (kind, message) = match (error.kind, status_code) {
        (DownloadErrorKind::HttpStatus, Some(401)) => (
            "authentication",
            format!(
                "{}: Bilibili login/Cookie is invalid or expired (HTTP 401)",
                track.label
            ),
        ),
        (DownloadErrorKind::HttpStatus, Some(402)) => (
            "unavailable",
            format!(
                "{}: Bilibili media access is unavailable or requires payment (HTTP 402)",
                track.label
            ),
        ),
        (DownloadErrorKind::HttpStatus, Some(403)) => (
            "forbidden",
            format!(
                "{}: Bilibili media access was forbidden (HTTP 403)",
                track.label
            ),
        ),
        (kind, _) => {
            let kind = match kind {
                DownloadErrorKind::InvalidRequest => "invalid_request",
                DownloadErrorKind::DestinationExists => "destination_exists",
                DownloadErrorKind::Network => "network",
                DownloadErrorKind::HttpStatus => "http_status",
                DownloadErrorKind::Io => "io",
                DownloadErrorKind::LengthMismatch => "length_mismatch",
                DownloadErrorKind::EmptyBody => "empty_body",
                DownloadErrorKind::Cancelled => "cancelled",
            };
            (kind, format!("{}: {}", track.label, error.message))
        }
    };
    CacheRuntimeError {
        kind: kind.to_owned(),
        message,
        status_code,
        api_code: None,
    }
}

fn is_terminal_track_error(error: &CacheRuntimeError) -> bool {
    if matches!(
        error.kind.as_str(),
        "authentication"
            | "forbidden"
            | "invalid_request"
            | "risk_control"
            | "selection"
            | "source_missing"
            | "destination_exists"
            | "unavailable"
            | "unsupported"
            | "unsupported_codec"
    ) {
        return true;
    }
    matches!(
        (error.kind.as_str(), error.status_code),
        ("http_status", Some(401..=403)) | ("http", Some(400 | 401 | 402 | 403 | 404 | 412))
    )
}

fn wait_for_retry(cancel: &AtomicBool, attempt: u32) -> bool {
    if attempt >= TRACK_ATTEMPTS {
        return true;
    }
    let deadline = Instant::now() + TRACK_RETRY_DELAY;
    while Instant::now() < deadline {
        if cancel.load(Ordering::Acquire) {
            return false;
        }
        thread::sleep(Duration::from_millis(100));
    }
    true
}

fn resolve_track_stream(
    job: &CacheJobSpec,
    track: &TrackSpec,
) -> Result<BilibiliStream, CacheRuntimeError> {
    let dash = fetch_dash_playurl(&BilibiliDashRequest {
        schema_version: 1,
        bvid: job.bvid.clone(),
        cid: track.page.cid,
        avid: job.aid,
        qn: 127,
        fnval: 4048,
        cookie: job.cookie.clone(),
        user_agent: job.user_agent.clone(),
        referer: job.referer.clone(),
        timeout_ms: job.timeout_ms,
    })
    .map_err(|error| CacheRuntimeError {
        kind: error.kind,
        message: error.message,
        status_code: error.status_code,
        api_code: error.api_code,
    })?;
    match track.kind {
        ExpectedMediaKind::Video => select_video(&dash.video, job),
        ExpectedMediaKind::Audio => select_audio(&dash.audio, dash.flac.as_ref(), job.audio_hires),
    }
}

fn select_video(
    streams: &[BilibiliStream],
    job: &CacheJobSpec,
) -> Result<BilibiliStream, CacheRuntimeError> {
    let quality = decide_quality_policy(&QualityPolicyRequest {
        raw_quality: job.video_quality.clone(),
        raw_cap: job.avc_quality_cap.clone(),
        choice_index: None,
    });
    let descriptors: Vec<VideoStreamDescriptor> = streams
        .iter()
        .enumerate()
        .map(|(index, stream)| VideoStreamDescriptor {
            original_index: index,
            quality_id: stream.quality_id.unwrap_or(0),
            bandwidth: i64::try_from(stream.bandwidth.unwrap_or(0)).unwrap_or(i64::MAX),
            codec: VideoCodec::from_name(stream.codec_name.as_deref().unwrap_or("")),
        })
        .collect();
    let selection = select_video_stream(&VideoStreamSelectionRequest {
        max_quality_id: quality.dash_max_quality_id,
        codec_filter: Some(VideoCodec::Avc),
        max_avc_quality_id: quality.optional_cap.map(|cap| cap.dash_quality_id()),
        streams: descriptors,
    })
    .map_err(|_| CacheRuntimeError::new("selection", "invalid video stream selection"))?;
    let VideoStreamSelection::Selected { selected_index, .. } = selection else {
        return Err(CacheRuntimeError::new(
            "selection",
            "no video stream is available",
        ));
    };
    let stream = streams
        .get(selected_index)
        .cloned()
        .ok_or_else(|| CacheRuntimeError::new("selection", "invalid selected video stream"))?;
    if stream.codec_name.as_deref() != Some("avc") {
        return Err(CacheRuntimeError::new(
            "selection",
            "Rust Native found no compatible AVC video stream",
        ));
    }
    Ok(stream)
}

fn select_audio(
    regular: &[BilibiliStream],
    flac: Option<&BilibiliStream>,
    audio_hires: bool,
) -> Result<BilibiliStream, CacheRuntimeError> {
    if audio_hires && let Some(flac) = flac {
        return Ok(flac.clone());
    }
    let descriptors: Vec<AudioStreamDescriptor> = regular
        .iter()
        .enumerate()
        .map(|(index, stream)| AudioStreamDescriptor {
            original_index: index,
            quality_id: stream.quality_id.unwrap_or(0),
            bandwidth: i64::try_from(stream.bandwidth.unwrap_or(0)).unwrap_or(i64::MAX),
        })
        .collect();
    let selection = select_audio_stream(&AudioStreamSelectionRequest {
        audio_hires,
        regular_streams: descriptors,
    })
    .map_err(|_| CacheRuntimeError::new("selection", "invalid audio stream selection"))?;
    let AudioStreamSelection::Selected { selected_index, .. } = selection else {
        return Err(CacheRuntimeError::new(
            "selection",
            "no audio stream is available",
        ));
    };
    regular
        .get(selected_index)
        .cloned()
        .ok_or_else(|| CacheRuntimeError::new("selection", "invalid selected audio stream"))
}

fn download_request(
    job: &CacheJobSpec,
    stream: &BilibiliStream,
    destination: PathBuf,
) -> Result<DownloadRequest, CacheRuntimeError> {
    let mut urls = Vec::new();
    if !stream.url.trim().is_empty() {
        urls.push(stream.url.trim().to_owned());
    }
    for url in &stream.backup_urls {
        let value = url.trim();
        if !value.is_empty() && !urls.iter().any(|existing| existing == value) {
            urls.push(value.to_owned());
        }
    }
    if urls.is_empty() {
        return Err(CacheRuntimeError::new(
            "selection",
            "selected media stream has no URL",
        ));
    }
    let mut headers = vec![
        HttpHeader {
            name: "Origin".to_owned(),
            value: "https://www.bilibili.com".to_owned(),
        },
        HttpHeader {
            name: "Referer".to_owned(),
            value: job.referer.clone(),
        },
        HttpHeader {
            name: "User-Agent".to_owned(),
            value: job.user_agent.clone(),
        },
    ];
    if !job.cookie.trim().is_empty() {
        headers.push(HttpHeader {
            name: "Cookie".to_owned(),
            value: job.cookie.clone(),
        });
    }
    Ok(DownloadRequest {
        schema_version: 1,
        candidates: urls
            .into_iter()
            .map(|url| DownloadCandidate {
                url,
                headers: headers.clone(),
            })
            .collect(),
        destination,
        connect_timeout_ms: 15_000,
        request_timeout_ms: 30 * 60 * 1000,
        attempts_per_candidate: 1,
    })
}

fn publish_tracks_for_attempt(
    job: &CacheJobSpec,
    reservation: &CacheAttemptReservation,
    tracks: Vec<TrackResult>,
) -> Result<CacheReadyResult, CacheRuntimeError> {
    publish_tracks_with_authorizer(job, reservation, tracks, |item_id, reservation| {
        authorize_cache_publication_for_runtime(item_id, reservation)
            .map_err(|error| CacheRuntimeError::new(&error.kind, error.message))
    })
}

fn publish_tracks_with_authorizer<F>(
    job: &CacheJobSpec,
    reservation: &CacheAttemptReservation,
    mut tracks: Vec<TrackResult>,
    authorize: F,
) -> Result<CacheReadyResult, CacheRuntimeError>
where
    F: FnOnce(&str, &CacheAttemptReservation) -> Result<(), CacheRuntimeError>,
{
    tracks.sort_by_key(|track| track.spec.order);
    if tracks.len() != job.pages.len() + 1 {
        return Err(CacheRuntimeError::new(
            "publish",
            "cache job did not produce every requested track",
        ));
    }
    let staging_dir = job
        .cache_root
        .join(".staging")
        .join(&reservation.item_incarnation_id)
        .join(&reservation.artifact_set_id);
    let complete_dir = staging_dir.join("complete");
    let canonical_staging = canonical_directory_within_cache_root(&job.cache_root, &staging_dir)?;
    fs::create_dir(&complete_dir)
        .map_err(|error| CacheRuntimeError::new("publish", error.to_string()))?;
    let mut final_names = HashSet::with_capacity(tracks.len());
    for track in &tracks {
        if track.probe.file_bytes == 0
            || !track.temporary_path.is_file()
            || !final_names.insert(track.final_name.clone())
        {
            return Err(CacheRuntimeError::new(
                "publish",
                "validated cache track is missing or has a duplicate path",
            ));
        }
        let canonical_track = track
            .temporary_path
            .canonicalize()
            .map_err(|error| CacheRuntimeError::new("publish", error.to_string()))?;
        if !canonical_track.starts_with(&canonical_staging) {
            return Err(CacheRuntimeError::new(
                "invalid_cache_path",
                "validated cache track escaped its attempt staging directory",
            ));
        }
        fs::rename(&track.temporary_path, complete_dir.join(&track.final_name))
            .map_err(|error| CacheRuntimeError::new("publish", error.to_string()))?;
    }
    authorize(&job.item_id, reservation)?;
    let committed_dir =
        safe_relative_cache_path(&job.cache_root, &reservation.artifact_relative_directory)
            .ok_or_else(|| {
                CacheRuntimeError::new(
                    "invalid_cache_publication_identity",
                    "Rust artifact directory escaped the cache root",
                )
            })?;
    if committed_dir.exists() {
        return Err(CacheRuntimeError::new(
            "artifact_destination_exists",
            "immutable artifact destination already exists",
        ));
    }
    let committed_parent = committed_dir.parent().ok_or_else(|| {
        CacheRuntimeError::new("publish", "immutable artifact destination has no parent")
    })?;
    create_directory_within_cache_root(&job.cache_root, committed_parent)?;
    fs::rename(&complete_dir, &committed_dir)
        .map_err(|error| CacheRuntimeError::new("publish", error.to_string()))?;
    for track in &tracks {
        if let Some(parent) = track.temporary_path.parent() {
            let _ = fs::remove_dir_all(parent);
        }
    }
    let _ = fs::remove_dir_all(&staging_dir);
    let video = tracks
        .iter()
        .find(|track| track.spec.kind == ExpectedMediaKind::Video)
        .ok_or_else(|| CacheRuntimeError::new("publish", "video track is missing"))?;
    let video_relative_path = format!(
        "{}/{}",
        reservation.artifact_relative_directory, video.final_name
    );
    let mut audio_variants = Vec::new();
    for (index, track) in tracks
        .iter()
        .filter(|track| track.spec.kind == ExpectedMediaKind::Audio)
        .enumerate()
    {
        audio_variants.push(ReadyAudioVariant {
            id: variant_id(track.spec.page.page, &track.spec.page.label, index),
            label: track.spec.page.label.clone(),
            page: track.spec.page.page,
            audio_url: media_url(&format!(
                "{}/{}",
                reservation.artifact_relative_directory, track.final_name
            )),
        });
    }
    let selected = if audio_variants
        .iter()
        .any(|variant| variant.id == job.selected_audio_variant_id)
    {
        job.selected_audio_variant_id.clone()
    } else {
        audio_variants
            .first()
            .map(|variant| variant.id.clone())
            .unwrap_or_default()
    };
    Ok(CacheReadyResult {
        video_media_url: media_url(&video_relative_path),
        video_relative_path,
        audio_variants,
        selected_audio_variant_id: selected,
        item_incarnation_id: reservation.item_incarnation_id.clone(),
        artifact_set_id: reservation.artifact_set_id.clone(),
        artifact_relative_directory: reservation.artifact_relative_directory.clone(),
    })
}

fn validate_job(job: &CacheJobSpec) -> Result<(), CacheRuntimeError> {
    if job.schema_version != 1 {
        return Err(CacheRuntimeError::new(
            "invalid_request",
            "unsupported cache job schema",
        ));
    }
    if !valid_item_id(&job.item_id) {
        return Err(CacheRuntimeError::new(
            "invalid_request",
            "cache item ID is invalid",
        ));
    }
    if job.item_incarnation_id.trim().is_empty() {
        return Err(CacheRuntimeError::new(
            "invalid_request",
            "cache item incarnation ID is missing",
        ));
    }
    if !job.bvid.starts_with("BV") || job.bvid.len() < 10 || job.bvid.len() > 32 {
        return Err(CacheRuntimeError::new(
            "invalid_request",
            "cache job BVID is invalid",
        ));
    }
    validate_cache_root(&job.cache_root)?;
    if !job.log_file.is_absolute() || job.log_file.file_name().is_none() {
        return Err(CacheRuntimeError::new(
            "invalid_request",
            "cache log path must be absolute",
        ));
    }
    if job.pages.is_empty() || job.pages.len() > MAX_JOB_PAGES {
        return Err(CacheRuntimeError::new(
            "invalid_request",
            "cache job must contain between 1 and 32 audio pages",
        ));
    }
    let mut pages = HashSet::new();
    for page in &job.pages {
        if page.page == 0 || page.cid == 0 || !pages.insert(page.page) {
            return Err(CacheRuntimeError::new(
                "invalid_request",
                "cache job pages must be unique and have valid CIDs",
            ));
        }
        if page
            .duration_seconds
            .is_some_and(|duration| !duration.is_finite() || duration <= 0.0)
        {
            return Err(CacheRuntimeError::new(
                "invalid_request",
                "cache job page duration is invalid",
            ));
        }
    }
    if !pages.contains(&job.video_page) {
        return Err(CacheRuntimeError::new(
            "invalid_request",
            "cache video page is not selected",
        ));
    }
    if job.timeout_ms < 100 {
        return Err(CacheRuntimeError::new(
            "invalid_request",
            "cache quality or timeout is invalid",
        ));
    }
    Ok(())
}

fn validate_cache_root(cache_root: &Path) -> Result<(), CacheRuntimeError> {
    if !cache_root.is_absolute() {
        return Err(CacheRuntimeError::new(
            "invalid_request",
            "cache root must be absolute",
        ));
    }
    fs::create_dir_all(cache_root).map_err(|error| CacheRuntimeError::new("io", error.to_string()))
}

fn valid_item_id(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value.len() <= 160
        && Path::new(value).components().count() == 1
        && Path::new(value)
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

fn queue_locked(state: &mut RuntimeState, item_id: &str, priority: CacheJobPriority) {
    remove_queued_locked(state, item_id);
    match priority {
        CacheJobPriority::Normal => state.normal_queue.push_back(item_id.to_owned()),
        CacheJobPriority::Front => state.normal_queue.push_front(item_id.to_owned()),
        CacheJobPriority::Urgent => state.urgent_queue.push_back(item_id.to_owned()),
    }
    state.queued_priorities.insert(item_id.to_owned(), priority);
}

fn remove_queued_locked(state: &mut RuntimeState, item_id: &str) {
    state.normal_queue.retain(|value| value != item_id);
    state.urgent_queue.retain(|value| value != item_id);
    state.queued_priorities.remove(item_id);
}

fn priority_name(priority: CacheJobPriority) -> &'static str {
    match priority {
        CacheJobPriority::Normal => "normal",
        CacheJobPriority::Front => "front",
        CacheJobPriority::Urgent => "urgent",
    }
}

fn terminal_event(kind: &str) -> bool {
    matches!(kind, "ready" | "failed" | "cancelled" | "evicted")
}

fn push_event_locked(
    state: &mut RuntimeState,
    generation: u64,
    cache_attempt_token: u64,
    item_id: &str,
    kind: &str,
    payload: Value,
) {
    state.next_event_sequence = state.next_event_sequence.saturating_add(1).max(1);
    let event = CacheEvent {
        sequence: state.next_event_sequence,
        generation,
        cache_attempt_token,
        item_id: item_id.to_owned(),
        kind: kind.to_owned(),
        payload,
    };
    if terminal_event(kind) {
        state
            .terminal_events
            .insert(item_id.to_owned(), event.clone());
    }
    if state.events.len() >= MAX_EVENTS {
        state.events.pop_front();
    }
    state.events.push_back(event);
}

fn emit_track_progress(
    shared: &SharedRuntime,
    job: &QueuedJob,
    track: &TrackSpec,
    phase: &str,
    attempt: u32,
    bytes: (u64, u64),
) {
    let mut state = lock_state(shared);
    push_event_locked(
        &mut state,
        job.generation,
        job.cache_attempt_token,
        &job.spec.item_id,
        "progress",
        json!({
            "track": {
                "key": track.key,
                "label": track.label,
                "order": track.order,
                "page": track.page.page,
                "stream_kind": match track.kind { ExpectedMediaKind::Video => "video", ExpectedMediaKind::Audio => "audio" },
                "phase": phase,
                "attempt": attempt,
                "max_attempts": TRACK_ATTEMPTS,
                "current_bytes": bytes.0,
                "target_bytes": bytes.1,
                "done": phase == "ready",
            }
        }),
    );
}

fn snapshot_locked(state: &RuntimeState) -> Value {
    let mut active_ids: Vec<String> = state.active.keys().cloned().collect();
    active_ids.sort();
    let mut urgent_ids: Vec<String> = state
        .active
        .iter()
        .filter(|(_, active)| active.urgent)
        .map(|(item_id, _)| item_id.clone())
        .collect();
    urgent_ids.sort();
    let mut terminal_events: Vec<CacheEvent> = state.terminal_events.values().cloned().collect();
    terminal_events.sort_by_key(|event| event.sequence);
    json!({
        "stopping": state.stopping,
        "primary_active_item_id": state.primary_active_item_id,
        "active_item_ids": active_ids,
        "urgent_item_ids": urgent_ids,
        "pending_ids": state.normal_queue.iter().chain(state.urgent_queue.iter()).cloned().collect::<Vec<_>>(),
        "terminal_events": terminal_events,
        "event_count": state.events.len(),
        "last_event_sequence": state.next_event_sequence,
    })
}

fn track_specs(job: &CacheJobSpec) -> Result<Vec<TrackSpec>, CacheRuntimeError> {
    let video_page = job
        .pages
        .iter()
        .find(|page| page.page == job.video_page)
        .cloned()
        .ok_or_else(|| {
            CacheRuntimeError::new(
                "validation",
                "video_page does not reference a validated page",
            )
        })?;
    let mut tracks = vec![TrackSpec {
        key: format!("video-p{}", video_page.page),
        label: format!("视频轨P{}", video_page.page),
        order: 0,
        page: video_page,
        kind: ExpectedMediaKind::Video,
    }];
    tracks.extend(job.pages.iter().enumerate().map(|(index, page)| TrackSpec {
        key: format!("audio-p{}", page.page),
        label: format!("音轨P{}", page.page),
        order: index + 1,
        page: page.clone(),
        kind: ExpectedMediaKind::Audio,
    }));
    Ok(tracks)
}

fn initial_track_payloads(job: &CacheJobSpec) -> Result<Vec<Value>, CacheRuntimeError> {
    Ok(track_specs(job)?
        .into_iter()
        .map(|track| {
            json!({
                "key": track.key,
                "label": track.label,
                "order": track.order,
                "page": track.page.page,
                "stream_kind": match track.kind { ExpectedMediaKind::Video => "video", ExpectedMediaKind::Audio => "audio" },
                "phase": "queued",
                "attempt": 0,
                "max_attempts": TRACK_ATTEMPTS,
                "current_bytes": 0,
                "target_bytes": 0,
                "done": false,
            })
        })
        .collect())
}

fn duration_tolerance(expected: f64) -> f64 {
    3.0_f64.max(expected * 0.02)
}

fn variant_id(page: u32, label: &str, index: usize) -> String {
    let mut normalized = String::new();
    let mut separator = false;
    for character in label.to_ascii_lowercase().chars() {
        if character.is_ascii_lowercase() || character.is_ascii_digit() {
            if separator && !normalized.is_empty() {
                normalized.push('_');
            }
            separator = false;
            normalized.push(character);
        } else {
            separator = true;
        }
    }
    let suffix = if normalized.is_empty() {
        format!("track_{}", index + 1)
    } else {
        normalized
    };
    format!("p{}_{}", page.max(1), suffix)
}

fn media_url(relative_path: &str) -> String {
    format!("/media/{}", relative_path.replace('\\', "/"))
}

fn clear_directory(root: &Path) -> Result<(), CacheRuntimeError> {
    let entries =
        fs::read_dir(root).map_err(|error| CacheRuntimeError::new("io", error.to_string()))?;
    for entry in entries {
        let entry = entry.map_err(|error| CacheRuntimeError::new("io", error.to_string()))?;
        let path = entry.path();
        if path.is_dir() {
            fs::remove_dir_all(path)
                .map_err(|error| CacheRuntimeError::new("io", error.to_string()))?;
        } else {
            fs::remove_file(path)
                .map_err(|error| CacheRuntimeError::new("io", error.to_string()))?;
        }
    }
    Ok(())
}

fn existing_artifacts_ready(job: &CacheJobSpec) -> bool {
    if !job.reported_ready || job.existing_audio_variants.is_empty() {
        return false;
    }
    let Some(video_path) =
        safe_relative_cache_path(&job.cache_root, &job.existing_video_relative_path)
    else {
        return false;
    };
    if !nonempty_file(&video_path) {
        return false;
    }
    job.existing_audio_variants.iter().all(|variant| {
        safe_relative_cache_path(&job.cache_root, &variant.relative_path)
            .is_some_and(|path| nonempty_file(&path))
    })
}

fn completed_artifacts_ready(cache_root: &Path, result: &CacheReadyResult) -> bool {
    let Some(video_path) = safe_relative_cache_path(cache_root, &result.video_relative_path) else {
        return false;
    };
    if !nonempty_file(&video_path) || result.audio_variants.is_empty() {
        return false;
    }
    result.audio_variants.iter().all(|variant| {
        variant
            .audio_url
            .strip_prefix("/media/")
            .and_then(|relative| safe_relative_cache_path(cache_root, relative))
            .is_some_and(|path| nonempty_file(&path))
    })
}

fn safe_relative_cache_path(root: &Path, relative: &str) -> Option<PathBuf> {
    let normalized = relative.trim().replace('\\', "/");
    let path = Path::new(&normalized);
    if normalized.is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return None;
    }
    Some(root.join(path))
}

fn canonical_directory_within_cache_root(
    cache_root: &Path,
    directory: &Path,
) -> Result<PathBuf, CacheRuntimeError> {
    let canonical_root = cache_root
        .canonicalize()
        .map_err(|error| CacheRuntimeError::new("invalid_cache_path", error.to_string()))?;
    let canonical_directory = directory
        .canonicalize()
        .map_err(|error| CacheRuntimeError::new("invalid_cache_path", error.to_string()))?;
    if !canonical_directory.starts_with(&canonical_root) {
        return Err(CacheRuntimeError::new(
            "invalid_cache_path",
            "cache directory escaped the configured cache root",
        ));
    }
    Ok(canonical_directory)
}

fn create_directory_within_cache_root(
    cache_root: &Path,
    directory: &Path,
) -> Result<(), CacheRuntimeError> {
    let relative = directory.strip_prefix(cache_root).map_err(|_| {
        CacheRuntimeError::new(
            "invalid_cache_path",
            "cache directory is outside the configured cache root",
        )
    })?;
    let mut cursor = cache_root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(component) = component else {
            return Err(CacheRuntimeError::new(
                "invalid_cache_path",
                "cache directory contains an invalid path component",
            ));
        };
        cursor.push(component);
        match fs::symlink_metadata(&cursor) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(CacheRuntimeError::new(
                    "invalid_cache_path",
                    "cache directory contains a symbolic-link ancestor",
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => {
                return Err(CacheRuntimeError::new(
                    "invalid_cache_path",
                    error.to_string(),
                ));
            }
        }
    }
    fs::create_dir_all(directory)
        .map_err(|error| CacheRuntimeError::new("io", error.to_string()))?;
    canonical_directory_within_cache_root(cache_root, directory).map(|_| ())
}

fn nonempty_file(path: &Path) -> bool {
    path.metadata()
        .is_ok_and(|metadata| metadata.is_file() && metadata.len() > 0)
}

fn cache_metrics(cache_root: &Path) -> Value {
    let mut item_bytes = serde_json::Map::new();
    let mut total_bytes = 0_u64;
    let mut item_count = 0_u64;
    if let Ok(entries) = fs::read_dir(cache_root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let size = directory_size(&path);
            total_bytes = total_bytes.saturating_add(size);
            if size > 0 {
                item_count = item_count.saturating_add(1);
            }
            item_bytes.insert(entry.file_name().to_string_lossy().to_string(), json!(size));
        }
    }
    json!({
        "item_bytes": item_bytes,
        "total_bytes": total_bytes,
        "item_count": item_count,
    })
}

fn directory_size(root: &Path) -> u64 {
    let mut total = 0_u64;
    let mut pending = vec![root.to_path_buf()];
    while let Some(path) = pending.pop() {
        let Ok(entries) = fs::read_dir(path) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                pending.push(path);
            } else if let Ok(metadata) = path.metadata() {
                total = total.saturating_add(metadata.len());
            }
        }
    }
    total
}

fn append_log(path: &Path, message: &str) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "[{timestamp}] {message}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reservation(token: u64) -> CacheAttemptReservation {
        let item_incarnation_id = format!("i-{:032x}-{token:016x}", 1_u128);
        let artifact_set_id = format!("a-{:032x}-{token:016x}", 2_u128);
        CacheAttemptReservation {
            cache_attempt_token: token,
            item_id: "song-a".to_owned(),
            artifact_relative_directory: format!(
                "artifacts/{item_incarnation_id}/{artifact_set_id}"
            ),
            item_incarnation_id,
            artifact_set_id,
            refresh: false,
        }
    }

    fn reservation_for(
        token: u64,
        item_id: &str,
        item_incarnation_id: &str,
    ) -> CacheAttemptReservation {
        let mut reservation = reservation(token);
        reservation.item_id = item_id.to_owned();
        reservation.item_incarnation_id = item_incarnation_id.to_owned();
        reservation.artifact_relative_directory = format!(
            "artifacts/{}/{}",
            reservation.item_incarnation_id, reservation.artifact_set_id
        );
        reservation
    }

    fn current_item_incarnations(job: &CacheJobSpec) -> HashMap<String, String> {
        HashMap::from([(job.item_id.clone(), job.item_incarnation_id.clone())])
    }

    fn completed_result(reservation: &CacheAttemptReservation) -> CacheReadyResult {
        CacheReadyResult {
            video_relative_path: format!(
                "{}/video-p1.mp4",
                reservation.artifact_relative_directory
            ),
            video_media_url: format!(
                "/media/{}/video-p1.mp4",
                reservation.artifact_relative_directory
            ),
            audio_variants: vec![ReadyAudioVariant {
                id: "p1_track_1".to_owned(),
                label: "P1".to_owned(),
                page: 1,
                audio_url: format!(
                    "/media/{}/audio-p1.m4a",
                    reservation.artifact_relative_directory
                ),
            }],
            selected_audio_variant_id: "p1_track_1".to_owned(),
            item_incarnation_id: reservation.item_incarnation_id.clone(),
            artifact_set_id: reservation.artifact_set_id.clone(),
            artifact_relative_directory: reservation.artifact_relative_directory.clone(),
        }
    }

    fn job(root: &Path) -> CacheJobSpec {
        CacheJobSpec {
            schema_version: 1,
            item_id: "song-a".to_owned(),
            item_incarnation_id: reservation(1).item_incarnation_id,
            bvid: "BV1xx411c7mD".to_owned(),
            aid: 1,
            video_page: 1,
            pages: vec![CachePageSpec {
                page: 1,
                cid: 2,
                duration_seconds: Some(180.0),
                label: "伴奏".to_owned(),
            }],
            cache_root: root.to_path_buf(),
            log_file: root.join("song-a.log"),
            cookie: String::new(),
            user_agent: default_user_agent(),
            referer: default_referer(),
            timeout_ms: default_timeout_ms(),
            video_quality: "1080P 高清".to_owned(),
            avc_quality_cap: String::new(),
            audio_hires: false,
            selected_audio_variant_id: String::new(),
            reported_ready: false,
            existing_video_relative_path: String::new(),
            existing_audio_variants: Vec::new(),
        }
    }

    fn publication_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "bilikara-cache-runtime-{label}-{}-{}",
            std::process::id(),
            ATTEMPT_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn publication_tracks(
        job: &CacheJobSpec,
        reservation: &CacheAttemptReservation,
    ) -> Vec<TrackResult> {
        let staging = job
            .cache_root
            .join(".staging")
            .join(&reservation.item_incarnation_id)
            .join(&reservation.artifact_set_id);
        fs::create_dir_all(&staging).expect("staging directory");
        [
            (ExpectedMediaKind::Video, "video-p1.mp4", 0_usize),
            (ExpectedMediaKind::Audio, "audio-p1.m4a", 1_usize),
        ]
        .into_iter()
        .map(|(kind, final_name, order)| {
            let track_dir = staging.join(format!("track-{order}"));
            fs::create_dir(&track_dir).expect("track directory");
            let temporary_path = track_dir.join(final_name);
            fs::write(&temporary_path, format!("fixture-{final_name}")).expect("track fixture");
            let file_bytes = temporary_path.metadata().expect("metadata").len();
            TrackResult {
                spec: TrackSpec {
                    key: final_name.to_owned(),
                    label: if kind == ExpectedMediaKind::Video {
                        "video".to_owned()
                    } else {
                        "audio".to_owned()
                    },
                    order,
                    page: job.pages[0].clone(),
                    kind,
                },
                probe: MediaProbe {
                    path: temporary_path.clone(),
                    kind,
                    codec: if kind == ExpectedMediaKind::Video {
                        "h264".to_owned()
                    } else {
                        "aac".to_owned()
                    },
                    duration_seconds: 1.0,
                    sample_count: 1,
                    sample_bytes: file_bytes,
                    file_bytes,
                    fragmented: false,
                    fast_start: true,
                },
                temporary_path,
                final_name: final_name.to_owned(),
            }
        })
        .collect()
    }

    #[test]
    fn native_publication_atomically_installs_one_complete_immutable_directory() {
        let root = publication_root("atomic-publication");
        let job = job(&root);
        let reservation = reservation(301);
        let tracks = publication_tracks(&job, &reservation);
        let result =
            publish_tracks_with_authorizer(&job, &reservation, tracks, |_item_id, _reservation| {
                Ok(())
            })
            .expect("complete set publication");
        let committed = root.join(&reservation.artifact_relative_directory);
        assert_eq!(
            fs::read(committed.join("video-p1.mp4")).unwrap(),
            b"fixture-video-p1.mp4"
        );
        assert_eq!(
            fs::read(committed.join("audio-p1.m4a")).unwrap(),
            b"fixture-audio-p1.m4a"
        );
        assert_eq!(result.artifact_set_id, reservation.artifact_set_id);
        assert!(
            !root
                .join(".staging")
                .join(&reservation.item_incarnation_id)
                .join(&reservation.artifact_set_id)
                .exists()
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn stale_or_partial_native_publication_never_changes_a_committed_set() {
        let root = publication_root("stale-publication");
        let job = job(&root);
        let old = root.join("artifacts/old-item/old-set");
        fs::create_dir_all(&old).expect("old committed directory");
        fs::write(old.join("video-p1.mp4"), b"old-video").expect("old video");

        let stale = reservation(302);
        let stale_error = publish_tracks_with_authorizer(
            &job,
            &stale,
            publication_tracks(&job, &stale),
            |_item_id, _reservation| {
                Err(CacheRuntimeError::new(
                    "cache_attempt_superseded",
                    "stale attempt",
                ))
            },
        )
        .expect_err("stale publication must fail");
        assert_eq!(stale_error.kind, "cache_attempt_superseded");
        assert!(!root.join(&stale.artifact_relative_directory).exists());
        assert_eq!(fs::read(old.join("video-p1.mp4")).unwrap(), b"old-video");

        let partial = reservation(303);
        let mut partial_tracks = publication_tracks(&job, &partial);
        fs::remove_file(&partial_tracks[1].temporary_path).expect("remove audio fixture");
        let partial_error = publish_tracks_with_authorizer(
            &job,
            &partial,
            std::mem::take(&mut partial_tracks),
            |_item_id, _reservation| Ok(()),
        )
        .expect_err("partial publication must fail");
        assert_eq!(partial_error.kind, "publish");
        assert!(!root.join(&partial.artifact_relative_directory).exists());
        assert_eq!(fs::read(old.join("video-p1.mp4")).unwrap(), b"old-video");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn native_publication_refuses_an_existing_committed_destination() {
        let root = publication_root("destination-collision");
        let job = job(&root);
        let reservation = reservation(304);
        let committed = root.join(&reservation.artifact_relative_directory);
        fs::create_dir_all(&committed).expect("preexisting destination");
        fs::write(committed.join("marker"), b"existing").expect("collision marker");
        let error = publish_tracks_with_authorizer(
            &job,
            &reservation,
            publication_tracks(&job, &reservation),
            |_item_id, _reservation| Ok(()),
        )
        .expect_err("immutable destination collision must fail");
        assert_eq!(error.kind, "artifact_destination_exists");
        assert_eq!(fs::read(committed.join("marker")).unwrap(), b"existing");
        assert!(!committed.join("video-p1.mp4").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn native_publication_rejects_a_symlinked_committed_ancestor() {
        use std::os::unix::fs::symlink;

        let root = publication_root("symlinked-artifact-root");
        let outside = publication_root("symlinked-artifact-outside");
        fs::create_dir_all(&root).expect("cache root");
        fs::create_dir_all(&outside).expect("outside root");
        symlink(&outside, root.join("artifacts")).expect("artifact root symlink");
        let job = job(&root);
        let reservation = reservation(305);

        let error = publish_tracks_with_authorizer(
            &job,
            &reservation,
            publication_tracks(&job, &reservation),
            |_item_id, _reservation| Ok(()),
        )
        .expect_err("symlinked committed ancestor must fail closed");

        assert_eq!(error.kind, "invalid_cache_path");
        assert!(
            fs::read_dir(&outside)
                .expect("outside listing")
                .next()
                .is_none()
        );
        let _ = fs::remove_file(root.join("artifacts"));
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(outside);
    }

    #[test]
    fn validates_job_paths_pages_and_identity() {
        let root = std::env::temp_dir().join("bilikara-cache-runtime-validation");
        let valid = job(&root);
        assert!(validate_job(&valid).is_ok());
        let mut invalid = valid.clone();
        invalid.item_id = "../escape".to_owned();
        assert!(validate_job(&invalid).is_err());
        let mut duplicate = valid;
        duplicate.pages.push(duplicate.pages[0].clone());
        assert!(validate_job(&duplicate).is_err());
    }

    #[test]
    fn native_submission_reserves_once_and_carries_the_exact_token() {
        let root = std::env::temp_dir().join(format!(
            "bilikara-cache-runtime-reservation-{}-{}",
            std::process::id(),
            ATTEMPT_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let issued = Arc::new(AtomicU64::new(40));
        let requested = Arc::new(Mutex::new(Vec::new()));
        let runtime = CacheRuntime::new_without_workers(Arc::new({
            let issued = Arc::clone(&issued);
            let requested = Arc::clone(&requested);
            move |item_id, expected_item_incarnation_id| {
                requested
                    .lock()
                    .expect("reservation request lock")
                    .push(item_id.to_owned());
                Ok(reservation_for(
                    issued.fetch_add(1, Ordering::Relaxed) + 1,
                    item_id,
                    expected_item_incarnation_id,
                ))
            }
        }));

        let first = runtime
            .submit(job(&root), CacheJobPriority::Normal, false)
            .expect("reserve first native attempt");
        let retry = runtime
            .submit(job(&root), CacheJobPriority::Front, true)
            .expect("reserve retry native attempt");

        assert_eq!(first.cache_attempt_token, 41);
        assert_eq!(retry.cache_attempt_token, 42);
        assert!(retry.generation > first.generation);
        assert_eq!(
            *requested.lock().expect("reservation requests"),
            ["song-a", "song-a"]
        );
        let state = lock_state(&runtime.shared);
        let queued = state.jobs.get("song-a").expect("queued retry");
        assert_eq!(queued.cache_attempt_token, retry.cache_attempt_token);
        assert!(state.events.iter().all(|event| {
            event.item_id != "song-a"
                || event.cache_attempt_token == 41
                || event.cache_attempt_token == 42
        }));
        assert_eq!(
            state.events.back().map(|event| event.cache_attempt_token),
            Some(retry.cache_attempt_token)
        );
        drop(state);
        runtime.shutdown();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn mismatched_injected_reservation_changes_no_runtime_state_or_output() {
        let root = publication_root("mismatched-reservation");
        let runtime = CacheRuntime::new_without_workers(Arc::new(|item_id, _expected| {
            Ok(reservation_for(
                90,
                item_id,
                &reservation(2).item_incarnation_id,
            ))
        }));
        let before = runtime.snapshot();

        let error = runtime
            .submit(job(&root), CacheJobPriority::Normal, false)
            .expect_err("mismatched reservation must fail");

        assert_eq!(error.kind, "invalid_cache_attempt_reservation");
        assert_eq!(runtime.snapshot(), before);
        assert!(fs::read_dir(&root).is_ok_and(|mut entries| entries.next().is_none()));
        runtime.shutdown();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn same_incarnation_active_and_queued_submissions_deduplicate() {
        let root = publication_root("same-incarnation-dedup");
        let issued = Arc::new(AtomicU64::new(100));
        let issued_for_reserver = Arc::clone(&issued);
        let runtime = CacheRuntime::new_without_workers(Arc::new(move |item_id, incarnation| {
            Ok(reservation_for(
                issued_for_reserver.fetch_add(1, Ordering::Relaxed) + 1,
                item_id,
                incarnation,
            ))
        }));
        let submitted_job = job(&root);
        let queued = runtime
            .submit(submitted_job.clone(), CacheJobPriority::Normal, false)
            .expect("queue first incarnation");
        let queued_duplicate = runtime
            .submit(submitted_job.clone(), CacheJobPriority::Normal, false)
            .expect("deduplicate queued incarnation");
        assert_eq!(
            queued_duplicate.cache_attempt_token,
            queued.cache_attempt_token
        );
        assert_eq!(issued.load(Ordering::Relaxed), 101);

        {
            let mut state = lock_state(&runtime.shared);
            let queued_job = state.jobs["song-a"].clone();
            state.active.insert(
                "song-a".to_owned(),
                ActiveJob {
                    generation: queued_job.generation,
                    cache_attempt_token: queued_job.cache_attempt_token,
                    reservation: queued_job.reservation,
                    cancel: Arc::new(AtomicBool::new(false)),
                    urgent: false,
                },
            );
        }
        let active_duplicate = runtime
            .submit(submitted_job, CacheJobPriority::Normal, false)
            .expect("deduplicate active incarnation");
        assert_eq!(
            active_duplicate.cache_attempt_token,
            queued.cache_attempt_token
        );
        assert_eq!(issued.load(Ordering::Relaxed), 101);
        runtime.shutdown();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn different_incarnation_replaces_one_queued_job() {
        let root = publication_root("queued-incarnation-replacement");
        let issued = Arc::new(AtomicU64::new(110));
        let issued_for_reserver = Arc::clone(&issued);
        let runtime = CacheRuntime::new_without_workers(Arc::new(move |item_id, incarnation| {
            Ok(reservation_for(
                issued_for_reserver.fetch_add(1, Ordering::Relaxed) + 1,
                item_id,
                incarnation,
            ))
        }));
        let old_job = job(&root);
        let old_attempt = runtime
            .submit(old_job, CacheJobPriority::Normal, false)
            .expect("queue old incarnation");
        let mut new_job = job(&root);
        new_job.item_incarnation_id = reservation(2).item_incarnation_id;

        let new_attempt = runtime
            .submit(new_job.clone(), CacheJobPriority::Normal, false)
            .expect("replace queued incarnation");

        assert_ne!(
            new_attempt.cache_attempt_token,
            old_attempt.cache_attempt_token
        );
        let state = lock_state(&runtime.shared);
        assert_eq!(state.jobs.len(), 1);
        assert_eq!(
            state.normal_queue.iter().collect::<Vec<_>>(),
            [&"song-a".to_owned()]
        );
        let queued = &state.jobs["song-a"];
        assert_eq!(queued.spec.item_incarnation_id, new_job.item_incarnation_id);
        assert_eq!(
            queued.reservation.item_incarnation_id,
            new_job.item_incarnation_id
        );
        drop(state);
        runtime.shutdown();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn queued_replacement_shadows_cancelled_active_attempt_and_survives_old_settlement() {
        let root = publication_root("active-incarnation-replacement");
        let issued = Arc::new(AtomicU64::new(120));
        let issued_for_reserver = Arc::clone(&issued);
        let old_incarnation = reservation(1).item_incarnation_id;
        let new_incarnation = reservation(2).item_incarnation_id;
        let authoritative_incarnation = Arc::new(Mutex::new(old_incarnation.clone()));
        let authoritative_for_reserver = Arc::clone(&authoritative_incarnation);
        let runtime = CacheRuntime::new_without_workers(Arc::new(move |item_id, incarnation| {
            let authoritative = authoritative_for_reserver
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if authoritative.as_str() != incarnation {
                return Err(CacheRuntimeError::new(
                    "item_incarnation_mismatch",
                    "playlist item incarnation changed before cache reservation",
                ));
            }
            Ok(reservation_for(
                issued_for_reserver.fetch_add(1, Ordering::Relaxed) + 1,
                item_id,
                incarnation,
            ))
        }));
        let old_spec = job(&root);
        runtime
            .submit(old_spec, CacheJobPriority::Normal, false)
            .expect("queue old incarnation");
        let (old_job, old_cancel) = {
            let mut state = lock_state(&runtime.shared);
            let old_job = state.jobs["song-a"].clone();
            let old_cancel = Arc::new(AtomicBool::new(false));
            state.active.insert(
                "song-a".to_owned(),
                ActiveJob {
                    generation: old_job.generation,
                    cache_attempt_token: old_job.cache_attempt_token,
                    reservation: old_job.reservation.clone(),
                    cancel: Arc::clone(&old_cancel),
                    urgent: false,
                },
            );
            (old_job, old_cancel)
        };
        let mut new_job = job(&root);
        new_job.item_incarnation_id = new_incarnation.clone();
        *authoritative_incarnation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = new_incarnation;

        let new_attempt = runtime
            .submit(new_job.clone(), CacheJobPriority::Normal, false)
            .expect("queue new incarnation behind cancelled active job");
        assert!(old_cancel.load(Ordering::Acquire));
        {
            let mut state = lock_state(&runtime.shared);
            let event_count = state.events.len();
            let next_generation = state.next_generation;
            let queued_event = state
                .events
                .back()
                .expect("queued replacement event")
                .clone();
            let queued_before = state.jobs["song-a"].clone();
            drop(state);

            let stale_error = runtime
                .submit(
                    CacheJobSpec {
                        item_incarnation_id: old_incarnation,
                        ..new_job.clone()
                    },
                    CacheJobPriority::Normal,
                    false,
                )
                .expect_err("stale active incarnation must reach AppState precondition");
            assert_eq!(stale_error.kind, "item_incarnation_mismatch");
            let repeated_new = runtime
                .submit(new_job.clone(), CacheJobPriority::Normal, false)
                .expect("new queued incarnation must deduplicate");
            assert_eq!(repeated_new.generation, new_attempt.generation);
            assert_eq!(
                repeated_new.cache_attempt_token,
                new_attempt.cache_attempt_token
            );

            state = lock_state(&runtime.shared);
            assert_eq!(state.events.len(), event_count);
            assert_eq!(state.next_generation, next_generation);
            let queued_event_after = state.events.back().expect("queued replacement event");
            assert_eq!(queued_event_after.sequence, queued_event.sequence);
            assert_eq!(queued_event_after.generation, queued_event.generation);
            assert_eq!(
                queued_event_after.cache_attempt_token,
                queued_event.cache_attempt_token
            );
            assert_eq!(queued_event_after.kind, queued_event.kind);
            assert_eq!(queued_event_after.payload, queued_event.payload);
            assert_eq!(state.jobs["song-a"].generation, queued_before.generation);
            assert_eq!(
                state.jobs["song-a"].cache_attempt_token,
                queued_before.cache_attempt_token
            );
            assert!(old_cancel.load(Ordering::Acquire));
            settle_job_locked(
                &mut state,
                &old_job,
                JobOutcome::Ready(completed_result(&old_job.reservation)),
            );
            assert!(!state.active.contains_key("song-a"));
            assert_eq!(state.jobs["song-a"].generation, new_attempt.generation);
            assert_eq!(
                state.jobs["song-a"].spec.item_incarnation_id,
                new_job.item_incarnation_id
            );
            assert!(!state.completed.contains_key("song-a"));
            assert_eq!(
                state
                    .normal_queue
                    .iter()
                    .filter(|item_id| *item_id == "song-a")
                    .count(),
                1
            );
            assert!(state.events.iter().any(|event| {
                event.kind == "ready"
                    && event.generation == old_job.generation
                    && event.cache_attempt_token == old_job.cache_attempt_token
            }));
            assert!(state.events.iter().any(|event| {
                event.kind == "queued"
                    && event.generation == new_attempt.generation
                    && event.cache_attempt_token == new_attempt.cache_attempt_token
            }));
        }
        runtime.shutdown();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn native_reservation_failure_queues_no_job_and_starts_no_output() {
        let root = std::env::temp_dir().join(format!(
            "bilikara-cache-runtime-reservation-failure-{}-{}",
            std::process::id(),
            ATTEMPT_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let runtime = CacheRuntime::new_without_workers(Arc::new(|_, _| {
            Err(CacheRuntimeError::new(
                "cache_attempt_token_exhausted",
                "attempt allocator exhausted",
            ))
        }));
        let before = runtime.snapshot();

        let error = runtime
            .submit(job(&root), CacheJobPriority::Normal, false)
            .expect_err("reservation must fail");

        assert_eq!(error.kind, "cache_attempt_token_exhausted");
        assert_eq!(runtime.snapshot(), before);
        assert!(!root.join("song-a").exists());
        runtime.shutdown();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn queued_eviction_reuses_the_jobs_attempt_without_terminal_conflict() {
        let root = std::env::temp_dir().join(format!(
            "bilikara-cache-runtime-queued-eviction-{}-{}",
            std::process::id(),
            ATTEMPT_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let current_job = job(&root);
        let runtime = CacheRuntime::new_without_workers(Arc::new(|item_id, incarnation| {
            Ok(reservation_for(73, item_id, incarnation))
        }));
        let submitted = runtime
            .submit(current_job.clone(), CacheJobPriority::Normal, false)
            .expect("queue native cache job");

        runtime
            .sync(
                &root,
                current_item_incarnations(&current_job),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                "",
            )
            .expect("evict queued job");

        let state = lock_state(&runtime.shared);
        let terminal_events = state
            .events
            .iter()
            .filter(|event| terminal_event(&event.kind))
            .collect::<Vec<_>>();
        assert_eq!(terminal_events.len(), 1);
        assert_eq!(terminal_events[0].kind, "evicted");
        assert_eq!(
            terminal_events[0].cache_attempt_token,
            submitted.cache_attempt_token
        );
        assert!(!state.jobs.contains_key("song-a"));
        drop(state);
        runtime.shutdown();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn variant_ids_match_the_python_compatibility_format() {
        assert_eq!(variant_id(2, "Off Vocal", 0), "p2_off_vocal");
        assert_eq!(variant_id(1, "伴奏", 1), "p1_track_2");
    }

    #[test]
    fn guest_download_request_omits_cookie_header() {
        let root = std::env::temp_dir().join("bilikara-cache-runtime-guest-headers");
        let guest_job = job(&root);
        let stream = BilibiliStream {
            url: "https://media.example/video.m4s".to_owned(),
            backup_urls: vec!["https://backup.example/video.m4s".to_owned()],
            codec_id: Some(7),
            codec_name: Some("avc".to_owned()),
            codecs: Some("avc1.640028".to_owned()),
            mime_type: Some("video/mp4".to_owned()),
            width: Some(1280),
            height: Some(720),
            quality_id: Some(64),
            bandwidth: Some(1_000_000),
            order: None,
        };
        let request = download_request(&guest_job, &stream, root.join("guest.m4s"))
            .expect("guest download request");
        assert_eq!(request.candidates.len(), 2);
        assert!(request.candidates.iter().all(|candidate| {
            candidate
                .headers
                .iter()
                .all(|header| !header.name.eq_ignore_ascii_case("cookie"))
        }));
    }

    #[test]
    fn guest_quality_uses_best_available_lower_avc_stream() {
        let root = std::env::temp_dir().join("bilikara-cache-runtime-guest-quality");
        let mut guest_job = job(&root);
        guest_job.video_quality = "1080P 高清".to_owned();
        let stream = |quality_id, bandwidth| BilibiliStream {
            url: format!("https://media.example/{quality_id}.m4s"),
            backup_urls: Vec::new(),
            codec_id: Some(7),
            codec_name: Some("avc".to_owned()),
            codecs: Some("avc1.640028".to_owned()),
            mime_type: Some("video/mp4".to_owned()),
            width: Some(1280),
            height: Some(720),
            quality_id: Some(quality_id),
            bandwidth: Some(bandwidth),
            order: None,
        };
        let selected = select_video(&[stream(32, 500_000), stream(64, 1_000_000)], &guest_job)
            .expect("guest stream selection");
        assert_eq!(selected.quality_id, Some(64));
    }

    #[test]
    fn terminal_track_errors_are_distinct_from_transient_failures() {
        let track = TrackSpec {
            key: "video-p1".to_owned(),
            label: "video P1".to_owned(),
            order: 0,
            page: CachePageSpec {
                page: 1,
                cid: 456,
                duration_seconds: Some(120.0),
                label: "P1".to_owned(),
            },
            kind: ExpectedMediaKind::Video,
        };
        let authentication = cache_download_error(
            &track,
            DownloadError {
                kind: DownloadErrorKind::HttpStatus,
                message: "HTTP 401".to_owned(),
                candidate_index: Some(0),
                http_status: Some(401),
            },
        );
        let forbidden = cache_download_error(
            &track,
            DownloadError {
                kind: DownloadErrorKind::HttpStatus,
                message: "HTTP 403".to_owned(),
                candidate_index: Some(0),
                http_status: Some(403),
            },
        );
        let unknown_api = CacheRuntimeError::new("api", "unknown API error");
        let transient = CacheRuntimeError::new("network", "connection reset");
        let incomplete = CacheRuntimeError::new("length_mismatch", "short body");
        let unsupported = CacheRuntimeError::new("unsupported_codec", "codec rejected");

        assert_eq!(authentication.kind, "authentication");
        assert!(authentication.message.contains("invalid or expired"));
        assert_eq!(forbidden.kind, "forbidden");
        assert!(forbidden.message.contains("media access was forbidden"));
        assert!(is_terminal_track_error(&authentication));
        assert!(is_terminal_track_error(&forbidden));
        assert!(is_terminal_track_error(&unsupported));
        assert!(!is_terminal_track_error(&unknown_api));
        assert!(!is_terminal_track_error(&transient));
        assert!(!is_terminal_track_error(&incomplete));
    }

    #[test]
    fn sync_keeps_complete_reported_cache_out_of_the_worker_queue() {
        let root = std::env::temp_dir().join(format!(
            "bilikara-cache-runtime-ready-{}-{}",
            std::process::id(),
            ATTEMPT_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let item_dir = root.join("song-a");
        fs::create_dir_all(&item_dir).expect("create cache fixture");
        fs::write(item_dir.join("video-p1.mp4"), b"video").expect("write video fixture");
        fs::write(item_dir.join("audio-p1.m4a"), b"audio").expect("write audio fixture");
        let mut ready_job = job(&root);
        ready_job.reported_ready = true;
        ready_job.existing_video_relative_path = "song-a/video-p1.mp4".to_owned();
        ready_job.existing_audio_variants = vec![ExistingAudioVariant {
            id: "p1_track_1".to_owned(),
            label: "P1".to_owned(),
            page: 1,
            relative_path: "song-a/audio-p1.m4a".to_owned(),
        }];
        let current_item_incarnations = current_item_incarnations(&ready_job);
        let runtime = CacheRuntime::new().expect("start cache runtime");

        let result = runtime
            .sync(
                &root,
                current_item_incarnations,
                vec!["song-a".to_owned()],
                vec![ready_job],
                Vec::new(),
                "",
            )
            .expect("sync ready cache");

        assert_eq!(result["generations"], json!({}));
        assert_eq!(result["snapshot"]["pending_ids"], json!([]));
        runtime.shutdown();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn sync_does_not_resubmit_published_cache_before_ready_event_projection() {
        let root = std::env::temp_dir().join(format!(
            "bilikara-cache-runtime-completed-{}-{}",
            std::process::id(),
            ATTEMPT_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let completed_reservation = reservation(70);
        let item_dir = root.join(&completed_reservation.artifact_relative_directory);
        fs::create_dir_all(&item_dir).expect("create cache fixture");
        fs::write(item_dir.join("video-p1.mp4"), b"video").expect("write video fixture");
        fs::write(item_dir.join("audio-p1.m4a"), b"audio").expect("write audio fixture");
        let runtime = CacheRuntime::new_without_workers(Arc::new(|_, _| {
            Err(CacheRuntimeError::new(
                "unexpected_reservation",
                "same-incarnation completed reuse reserved a new attempt",
            ))
        }));
        {
            let mut state = lock_state(&runtime.shared);
            state.next_generation = 7;
            state.completed.insert(
                "song-a".to_owned(),
                CompletedJob {
                    generation: 7,
                    cache_attempt_token: 70,
                    reservation: completed_reservation.clone(),
                    result: completed_result(&completed_reservation),
                },
            );
        }

        let mut current_job = job(&root);
        current_job.item_incarnation_id = completed_reservation.item_incarnation_id.clone();

        let result = runtime
            .sync(
                &root,
                current_item_incarnations(&current_job),
                vec!["song-a".to_owned()],
                vec![current_job.clone()],
                vec!["song-a".to_owned()],
                "",
            )
            .expect("sync stale host state");

        assert_eq!(result["generations"], json!({}));
        assert_eq!(result["snapshot"]["pending_ids"], json!([]));
        runtime.shutdown();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn sync_queues_new_incarnation_when_old_completed_files_still_exist() {
        let root = std::env::temp_dir().join(format!(
            "bilikara-cache-runtime-reused-item-id-{}-{}",
            std::process::id(),
            ATTEMPT_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let old_reservation = reservation(70);
        let new_reservation = reservation(71);
        let old_item_dir = root.join(&old_reservation.artifact_relative_directory);
        fs::create_dir_all(&old_item_dir).expect("create old completed fixture");
        fs::write(old_item_dir.join("video-p1.mp4"), b"old-video")
            .expect("write old video fixture");
        fs::write(old_item_dir.join("audio-p1.m4a"), b"old-audio")
            .expect("write old audio fixture");
        let reserved = Arc::new(AtomicU64::new(0));
        let reserved_for_attempt = Arc::clone(&reserved);
        let next_reservation = new_reservation.clone();
        let runtime = CacheRuntime::new_without_workers(Arc::new(move |item_id, expected| {
            assert_eq!(item_id, "song-a");
            assert_eq!(expected, next_reservation.item_incarnation_id);
            reserved_for_attempt.fetch_add(1, Ordering::Relaxed);
            Ok(next_reservation.clone())
        }));
        {
            let mut state = lock_state(&runtime.shared);
            state.next_generation = 7;
            let old_result = completed_result(&old_reservation);
            state.completed.insert(
                "song-a".to_owned(),
                CompletedJob {
                    generation: 7,
                    cache_attempt_token: old_reservation.cache_attempt_token,
                    reservation: old_reservation.clone(),
                    result: old_result.clone(),
                },
            );
            push_event_locked(
                &mut state,
                7,
                old_reservation.cache_attempt_token,
                "song-a",
                "ready",
                serde_json::to_value(old_result).expect("serialize old ready result"),
            );
        }
        let mut replacement_job = job(&root);
        replacement_job.item_incarnation_id = new_reservation.item_incarnation_id.clone();

        let result = runtime
            .sync(
                &root,
                current_item_incarnations(&replacement_job),
                vec!["song-a".to_owned()],
                vec![replacement_job.clone()],
                vec!["song-a".to_owned()],
                "",
            )
            .expect("sync replacement incarnation");

        assert_eq!(reserved.load(Ordering::Relaxed), 1);
        assert_eq!(result["generations"]["song-a"], json!(8));
        assert_eq!(
            result["cache_attempt_tokens"]["song-a"],
            json!(new_reservation.cache_attempt_token)
        );
        assert_eq!(result["snapshot"]["pending_ids"], json!(["song-a"]));
        assert_eq!(result["snapshot"]["terminal_events"], json!([]));
        assert_eq!(
            fs::read(old_item_dir.join("video-p1.mp4")).expect("read retained old video"),
            b"old-video"
        );
        let state = lock_state(&runtime.shared);
        assert!(!state.completed.contains_key("song-a"));
        let queued = state.jobs.get("song-a").expect("new incarnation queued");
        assert_eq!(
            queued.reservation.item_incarnation_id,
            new_reservation.item_incarnation_id
        );
        assert_eq!(
            queued.cache_attempt_token,
            new_reservation.cache_attempt_token
        );
        assert!(
            state.events.iter().any(|event| {
                event.kind == "ready"
                    && event.generation == 7
                    && event.cache_attempt_token == old_reservation.cache_attempt_token
            }),
            "old terminal evidence must remain distinguishable as stale"
        );
        assert!(
            state.events.iter().any(|event| {
                event.kind == "queued"
                    && event.generation == 8
                    && event.cache_attempt_token == new_reservation.cache_attempt_token
            }),
            "new incarnation must own the queued attempt"
        );
        drop(state);
        runtime.shutdown();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn sync_never_retires_artifacts_without_a_safe_process_boundary() {
        let root = std::env::temp_dir().join(format!(
            "bilikara-cache-runtime-active-orphan-{}-{}",
            std::process::id(),
            ATTEMPT_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let item_dir = root.join("song-a");
        fs::create_dir_all(&item_dir).expect("create active cache fixture");
        fs::write(item_dir.join("worker-owned.tmp"), b"active").expect("write active fixture");
        let runtime = CacheRuntime::new().expect("start cache runtime");
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut state = lock_state(&runtime.shared);
            state.active.insert(
                "song-a".to_owned(),
                ActiveJob {
                    generation: 1,
                    cache_attempt_token: 10,
                    reservation: reservation(10),
                    cancel: Arc::clone(&cancel),
                    urgent: false,
                },
            );
            state.primary_active_item_id = Some("song-a".to_owned());
        }

        runtime
            .sync(
                &root,
                HashMap::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                "",
            )
            .expect("sync active orphan");

        assert!(cancel.load(Ordering::Acquire));
        assert!(item_dir.exists());
        {
            let mut state = lock_state(&runtime.shared);
            state.active.remove("song-a");
            state.primary_active_item_id = None;
        }
        runtime
            .sync(
                &root,
                HashMap::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                "",
            )
            .expect("sync after worker completion");
        assert!(item_dir.exists());
        runtime.shutdown();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn terminal_event_remains_recoverable_after_progress_overflow() {
        let runtime = CacheRuntime::new().expect("start cache runtime");
        {
            let mut state = lock_state(&runtime.shared);
            push_event_locked(
                &mut state,
                1,
                10,
                "song-a",
                "ready",
                json!({
                    "video_relative_path": "song-a/video-p1.mp4",
                    "video_media_url": "/media/song-a/video-p1.mp4",
                    "audio_variants": [{
                        "id": "p1_track_1",
                        "label": "P1",
                        "page": 1,
                        "audio_url": "/media/song-a/audio-p1.m4a"
                    }],
                    "selected_audio_variant_id": "p1_track_1"
                }),
            );
            for index in 0..MAX_EVENTS {
                push_event_locked(
                    &mut state,
                    2,
                    20,
                    "song-b",
                    "progress",
                    json!({"track": {"key": "video-p1", "current_bytes": index}}),
                );
            }
        }

        let drained = runtime.drain_events(MAX_DRAIN_EVENTS);
        assert!(
            drained["events"]
                .as_array()
                .is_some_and(|events| events.iter().all(|event| event["item_id"] != "song-a"))
        );
        let recovered = drained["snapshot"]["terminal_events"]
            .as_array()
            .expect("terminal recovery snapshot");
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0]["item_id"], "song-a");
        assert_eq!(recovered[0]["kind"], "ready");
        assert_eq!(
            recovered[0]["payload"]["selected_audio_variant_id"],
            "p1_track_1"
        );
        runtime.shutdown();
    }

    #[test]
    fn command_wire_is_strict_and_flattened() {
        let command: CacheRuntimeCommand = serde_json::from_value(json!({
            "command": "snapshot"
        }))
        .expect("snapshot command");
        assert!(matches!(command, CacheRuntimeCommand::Snapshot {}));
        assert!(
            serde_json::from_value::<CacheRuntimeCommand>(json!({
                "command": "snapshot",
                "unknown": true
            }))
            .is_err()
        );
    }
}
