use crate::bilibili_service::{BilibiliDashRequest, BilibiliStream, fetch_dash_playurl};
use crate::http_downloader::{
    DownloadCandidate, DownloadErrorKind, DownloadRequest, HttpHeader, download_to_path,
};
use crate::media_backend::{ExpectedMediaKind, MediaNormalizeRequest, MediaProbe, normalize_media};
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
}

impl CacheRuntimeError {
    fn new(kind: &str, message: impl Into<String>) -> Self {
        Self {
            kind: kind.to_owned(),
            message: message.into(),
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
    item_id: String,
    kind: String,
    payload: Value,
}

#[derive(Clone)]
struct QueuedJob {
    generation: u64,
    spec: CacheJobSpec,
}

struct ActiveJob {
    generation: u64,
    cancel: Arc<AtomicBool>,
    urgent: bool,
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
    events: VecDeque<CacheEvent>,
}

struct SharedRuntime {
    state: Mutex<RuntimeState>,
    wake: Condvar,
}

struct CacheRuntime {
    shared: Arc<SharedRuntime>,
    workers: Mutex<Vec<JoinHandle<()>>>,
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

#[derive(Serialize)]
struct ReadyAudioVariant {
    id: String,
    label: String,
    page: u32,
    audio_url: String,
}

#[derive(Serialize)]
struct CacheReadyResult {
    video_relative_path: String,
    video_media_url: String,
    audio_variants: Vec<ReadyAudioVariant>,
    selected_audio_variant_id: String,
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
            retained_ids,
            jobs,
            ordered_ids,
            preempt_item_id,
        } => active_runtime()?.sync(
            &cache_root,
            current_ids,
            retained_ids,
            jobs,
            ordered_ids,
            &preempt_item_id,
        ),
        CacheRuntimeCommand::Submit { job, priority } => {
            validate_job(&job)?;
            let generation = active_runtime()?.submit(job, priority, false)?;
            Ok(json!({"generation": generation}))
        }
        CacheRuntimeCommand::Retry { job, urgent } => {
            validate_job(&job)?;
            let generation = active_runtime()?.submit(
                job,
                if urgent {
                    CacheJobPriority::Urgent
                } else {
                    CacheJobPriority::Front
                },
                true,
            )?;
            Ok(json!({"generation": generation}))
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
        })
    }

    fn submit(
        &self,
        job: CacheJobSpec,
        priority: CacheJobPriority,
        replace: bool,
    ) -> Result<u64, CacheRuntimeError> {
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
            if let Some(active) = state.active.get(&item_id) {
                return Ok(active.generation);
            }
            if let Some(existing) = state.jobs.get(&item_id) {
                return Ok(existing.generation);
            }
        }
        if replace {
            if let Some(active) = state.active.get(&item_id) {
                active.cancel.store(true, Ordering::Release);
                let generation = active.generation;
                state
                    .cancel_reasons
                    .insert((item_id.clone(), generation), "retry requested".to_owned());
            }
            remove_queued_locked(&mut state, &item_id);
        }
        state.next_generation = state.next_generation.saturating_add(1).max(1);
        let generation = state.next_generation;
        state.jobs.insert(
            item_id.clone(),
            QueuedJob {
                generation,
                spec: job,
            },
        );
        queue_locked(&mut state, &item_id, priority);
        push_event_locked(
            &mut state,
            generation,
            &item_id,
            "queued",
            json!({"priority": priority_name(priority)}),
        );
        self.shared.wake.notify_all();
        Ok(generation)
    }

    fn sync(
        &self,
        cache_root: &Path,
        current_ids: Vec<String>,
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
        let current: HashSet<String> = current_ids
            .into_iter()
            .filter(|value| valid_item_id(value))
            .collect();
        let retained: HashSet<String> = retained_ids
            .into_iter()
            .filter(|value| current.contains(value))
            .collect();
        cleanup_orphan_directories(cache_root, &current)?;

        let desired: HashSet<String> = jobs.iter().map(|job| job.item_id.clone()).collect();
        let mut evict_now = Vec::new();
        {
            let mut state = lock_state(&self.shared);
            let queued_ids: Vec<String> = state.jobs.keys().cloned().collect();
            for item_id in queued_ids {
                if desired.contains(&item_id) || state.active.contains_key(&item_id) {
                    continue;
                }
                if let Some(job) = state.jobs.remove(&item_id) {
                    remove_queued_locked(&mut state, &item_id);
                    push_event_locked(
                        &mut state,
                        job.generation,
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
                evict_now.push(item_id.clone());
                if let Some(job) = state.jobs.remove(item_id) {
                    remove_queued_locked(&mut state, item_id);
                    push_event_locked(
                        &mut state,
                        job.generation,
                        item_id,
                        "evicted",
                        json!({"reason": "outside cache window"}),
                    );
                } else {
                    push_event_locked(
                        &mut state,
                        0,
                        item_id,
                        "evicted",
                        json!({"reason": "outside cache window"}),
                    );
                }
            }
        }
        for item_id in evict_now {
            remove_item_directory(cache_root, &item_id)?;
        }

        let mut generations = serde_json::Map::new();
        let preempt_item_id = preempt_item_id.trim();
        for job in jobs {
            if existing_artifacts_ready(&job) {
                continue;
            }
            let replace = !preempt_item_id.is_empty() && job.item_id == preempt_item_id;
            let generation = self.submit(job.clone(), CacheJobPriority::Normal, replace)?;
            generations.insert(job.item_id, json!(generation));
        }
        self.reorder(&ordered_ids);
        Ok(json!({
            "generations": generations,
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
        for job in queued {
            if !state.active.contains_key(&job.spec.item_id) {
                push_event_locked(
                    &mut state,
                    job.generation,
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
                    &item_id,
                    "started",
                    json!({"tracks": initial_tracks}),
                );
                break (job, cancel);
            }
        };

        let outcome = run_job(&shared, &job, &cancel);
        let mut state = lock_state(&shared);
        state.active.remove(&job.spec.item_id);
        if state.primary_active_item_id.as_deref() == Some(job.spec.item_id.as_str()) {
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
            JobOutcome::Ready(result) => push_event_locked(
                &mut state,
                job.generation,
                &job.spec.item_id,
                "ready",
                serde_json::to_value(result).unwrap_or_else(|_| json!({})),
            ),
            JobOutcome::Cancelled => push_event_locked(
                &mut state,
                job.generation,
                &job.spec.item_id,
                "cancelled",
                json!({"reason": cancellation_reason}),
            ),
            JobOutcome::Failed(error) => push_event_locked(
                &mut state,
                job.generation,
                &job.spec.item_id,
                "failed",
                json!({"kind": error.kind, "message": error.message}),
            ),
        }
        shared.wake.notify_all();
    }
}

fn run_job(shared: &Arc<SharedRuntime>, job: &QueuedJob, cancel: &Arc<AtomicBool>) -> JobOutcome {
    if cancel.load(Ordering::Acquire) {
        return JobOutcome::Cancelled;
    }
    let item_dir = job.spec.cache_root.join(&job.spec.item_id);
    if let Err(error) = reset_item_directory(&item_dir) {
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
        let _ = fs::remove_dir_all(&item_dir);
        let error = failures.remove(0);
        append_log(
            &job.spec.log_file,
            &format!("cache failed: {}", error.message),
        );
        return JobOutcome::Failed(error);
    }
    if cancel.load(Ordering::Acquire) {
        let _ = fs::remove_dir_all(&item_dir);
        append_log(&job.spec.log_file, "cache cancelled");
        return JobOutcome::Cancelled;
    }
    match publish_tracks(&job.spec, results) {
        Ok(result) => {
            append_log(&job.spec.log_file, "cache ready");
            JobOutcome::Ready(result)
        }
        Err(error) => {
            let _ = fs::remove_dir_all(&item_dir);
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
        let attempt_dir = job.spec.cache_root.join(&job.spec.item_id).join(format!(
            ".attempt-{}-{}",
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
            last_error =
                CacheRuntimeError::new("download", format!("{}: {}", track.label, error.message));
            append_log(
                &job.spec.log_file,
                &format!(
                    "{} attempt {}/{} failed: {}",
                    track.label, attempt, TRACK_ATTEMPTS, last_error.message
                ),
            );
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
                last_error = CacheRuntimeError::new(
                    "invalid_media",
                    format!("{}: {}", track.label, error.message),
                );
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
        if !wait_for_retry(cancel, attempt) {
            return Err(CacheRuntimeError::new("cancelled", "cache cancelled"));
        }
    }
    Err(CacheRuntimeError::new(
        last_error.kind.as_str(),
        format!(
            "{} failed after {} attempts: {}",
            track.label, TRACK_ATTEMPTS, last_error.message
        ),
    ))
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
    .map_err(|error| CacheRuntimeError::new(error.kind.as_str(), error.message))?;
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

fn publish_tracks(
    job: &CacheJobSpec,
    mut tracks: Vec<TrackResult>,
) -> Result<CacheReadyResult, CacheRuntimeError> {
    tracks.sort_by_key(|track| track.spec.order);
    if tracks.len() != job.pages.len() + 1 {
        return Err(CacheRuntimeError::new(
            "publish",
            "cache job did not produce every requested track",
        ));
    }
    let item_dir = job.cache_root.join(&job.item_id);
    let mut published = Vec::new();
    for track in &tracks {
        if track.probe.file_bytes == 0 || !track.temporary_path.is_file() {
            return Err(CacheRuntimeError::new(
                "publish",
                "validated cache track is missing",
            ));
        }
        let destination = item_dir.join(&track.final_name);
        if destination.exists() {
            fs::remove_file(&destination)
                .map_err(|error| CacheRuntimeError::new("io", error.to_string()))?;
        }
        if let Err(error) = fs::rename(&track.temporary_path, &destination) {
            for path in published {
                let _ = fs::remove_file(path);
            }
            return Err(CacheRuntimeError::new("publish", error.to_string()));
        }
        published.push(destination);
    }
    for track in &tracks {
        if let Some(parent) = track.temporary_path.parent() {
            let _ = fs::remove_dir_all(parent);
        }
    }
    let video = tracks
        .iter()
        .find(|track| track.spec.kind == ExpectedMediaKind::Video)
        .ok_or_else(|| CacheRuntimeError::new("publish", "video track is missing"))?;
    let video_relative_path = relative_media_path(&job.item_id, &video.final_name);
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
            audio_url: media_url(&relative_media_path(&job.item_id, &track.final_name)),
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

fn push_event_locked(
    state: &mut RuntimeState,
    generation: u64,
    item_id: &str,
    kind: &str,
    payload: Value,
) {
    state.next_event_sequence = state.next_event_sequence.saturating_add(1).max(1);
    if state.events.len() >= MAX_EVENTS {
        state.events.pop_front();
    }
    state.events.push_back(CacheEvent {
        sequence: state.next_event_sequence,
        generation,
        item_id: item_id.to_owned(),
        kind: kind.to_owned(),
        payload,
    });
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
    json!({
        "stopping": state.stopping,
        "primary_active_item_id": state.primary_active_item_id,
        "active_item_ids": active_ids,
        "urgent_item_ids": urgent_ids,
        "pending_ids": state.normal_queue.iter().chain(state.urgent_queue.iter()).cloned().collect::<Vec<_>>(),
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

fn relative_media_path(item_id: &str, file_name: &str) -> String {
    format!("{item_id}/{file_name}")
}

fn media_url(relative_path: &str) -> String {
    format!("/media/{}", relative_path.replace('\\', "/"))
}

fn reset_item_directory(item_dir: &Path) -> Result<(), CacheRuntimeError> {
    if item_dir.exists() {
        fs::remove_dir_all(item_dir)
            .map_err(|error| CacheRuntimeError::new("io", error.to_string()))?;
    }
    fs::create_dir_all(item_dir).map_err(|error| CacheRuntimeError::new("io", error.to_string()))
}

fn remove_item_directory(cache_root: &Path, item_id: &str) -> Result<(), CacheRuntimeError> {
    if !valid_item_id(item_id) {
        return Ok(());
    }
    let path = cache_root.join(item_id);
    if path.exists() {
        fs::remove_dir_all(path)
            .map_err(|error| CacheRuntimeError::new("io", error.to_string()))?;
    }
    Ok(())
}

fn cleanup_orphan_directories(
    cache_root: &Path,
    current_ids: &HashSet<String>,
) -> Result<(), CacheRuntimeError> {
    let entries = fs::read_dir(cache_root)
        .map_err(|error| CacheRuntimeError::new("io", error.to_string()))?;
    for entry in entries {
        let entry = entry.map_err(|error| CacheRuntimeError::new("io", error.to_string()))?;
        let name = entry.file_name().to_string_lossy().to_string();
        if current_ids.contains(&name) {
            continue;
        }
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

    fn job(root: &Path) -> CacheJobSpec {
        CacheJobSpec {
            schema_version: 1,
            item_id: "song-a".to_owned(),
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
    fn variant_ids_match_the_python_compatibility_format() {
        assert_eq!(variant_id(2, "Off Vocal", 0), "p2_off_vocal");
        assert_eq!(variant_id(1, "伴奏", 1), "p1_track_2");
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
        let runtime = CacheRuntime::new().expect("start cache runtime");

        let result = runtime
            .sync(
                &root,
                vec!["song-a".to_owned()],
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
