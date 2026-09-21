//! Submission policy over the existing workers, AppState and artifact owner.
//! Lock order: orchestration -> worker state -> AppState. No event observer,
//! network operation or filesystem collection runs under these locks. A source
//! handoff holds only the submission gate while waiting for an executor to drain.
use super::*;
use crate::PlaylistItem;
use crate::app_state::{AppState, AppStateError, with_cache_application};
use bilikara_rust::{CacheItem, CachePlanRequest, plan_cache_window};

#[cfg(test)]
mod tests;

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExternalAttempt {
    pub item_id: String,
    pub cache_attempt_token: u64,
    pub retry_open: bool,
    #[serde(default)]
    pub primary: bool,
    #[serde(default)]
    pub urgent: bool,
}

/// Trusted adapter facts only: no playlist, desired jobs or queue decisions.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Facts {
    pub cache_root: PathBuf,
    pub log_dir: PathBuf,
    pub max_cache_items: usize,
    pub download_source: String,
    pub video_quality: String,
    pub audio_hires: bool,
    pub hevc_supported: Option<bool>,
    pub avc_quality_cap: String,
    pub cookie: String,
    pub user_agent: String,
    pub referer: String,
    #[serde(default)]
    pub external_attempts: Vec<ExternalAttempt>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "command", rename_all = "snake_case", deny_unknown_fields)]
pub enum Command {
    /// Trusted Host preparation result, never forwarded from HTTP request data.
    ConfigureBbdown {
        owner: String,
        prepared_path: Option<PathBuf>,
    },
    Handoff {
        owner: String,
        item_id: String,
        expected_item_incarnation_id: String,
    },
    Reconcile {
        owner: String,
        facts: Facts,
    },
    Wake {
        owner: String,
        facts: Facts,
    },
    Retry {
        owner: String,
        facts: Facts,
        item_id: String,
        expected_item_incarnation_id: String,
        force: bool,
    },
    Prepare {
        owner: String,
        facts: Facts,
    },
    Clear {
        owner: String,
        facts: Facts,
    },
    Stop {
        owner: String,
        facts: Facts,
    },
}

#[derive(Default)]
pub(crate) struct Orchestration {
    owner: String,
    stopped: bool,
    paused: bool,
    capability: Option<(bool, String)>,
    bbdown: Option<bbdown::Executable>,
    // Pending replacement intent, keyed by existing identities, while a retained
    // external worker finishes publication. This is not a second work queue.
    replacements: HashSet<(String, String)>,
    external_handoffs: HashMap<(String, String), bool>, // captured urgent intent
}

pub(crate) enum JobContract {
    Default,
    #[cfg(feature = "native-host")]
    Native,
}

pub(crate) struct JobInputs {
    pub cache_root: PathBuf,
    pub log_file: PathBuf,
    pub cookie: String,
    pub user_agent: String,
    pub referer: String,
    pub video_quality: String,
    pub avc_quality_cap: String,
    pub audio_hires: bool,
    pub executor: Executor,
}

/// Preserve each Host's selected-page contract without a serde round trip.
/// Page duration remains metadata; track validation belongs to the media backend.
pub(crate) fn build_job(
    item: &PlaylistItem,
    inputs: JobInputs,
    contract: JobContract,
) -> Result<CacheJobSpec, CacheRuntimeError> {
    let mut selected = Vec::new();
    match contract {
        JobContract::Default => {
            for page in &item.selected_pages {
                if *page > 0 && !selected.contains(page) {
                    selected.push(*page);
                }
            }
            if selected.is_empty() {
                selected.push(item.page.max(1));
            }
        }
        #[cfg(feature = "native-host")]
        JobContract::Native => selected.extend(
            item.available_pages
                .iter()
                .copied()
                .filter(|page| item.selected_pages.contains(page) || *page == item.video_page),
        ),
    }
    let mut pages = Vec::new();
    for page in &selected {
        let selected_index = item.selected_pages.iter().position(|p| p == page);
        let available_index = item.available_pages.iter().position(|p| p == page);
        let (cid, duration, label) = match contract {
            JobContract::Default => (
                selected_index
                    .and_then(|i| item.selected_cids.get(i))
                    .copied()
                    .or_else(|| {
                        available_index
                            .and_then(|i| item.available_cids.get(i))
                            .copied()
                    })
                    .or_else(|| (*page == item.page).then_some(item.cid)),
                selected_index
                    .and_then(|i| item.selected_durations.get(i))
                    .filter(|d| **d > 0)
                    .or_else(|| {
                        available_index
                            .and_then(|i| item.available_durations.get(i))
                            .filter(|d| **d > 0)
                    })
                    .copied(),
                selected_index
                    .and_then(|i| item.selected_parts.get(i))
                    .map(|s| s.trim())
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("P{page}")),
            ),
            #[cfg(feature = "native-host")]
            JobContract::Native => (
                available_index
                    .and_then(|i| item.available_cids.get(i))
                    .copied(),
                available_index
                    .and_then(|i| item.available_durations.get(i))
                    .copied(),
                available_index
                    .and_then(|i| item.available_parts.get(i))
                    .cloned()
                    .unwrap_or_default(),
            ),
        };
        pages.push(CachePageSpec {
            page: u32::try_from(*page).unwrap_or(0),
            cid: cid.and_then(|v| u64::try_from(v).ok()).unwrap_or(0),
            duration_seconds: duration.map(|d| d as f64),
            label,
        });
    }
    let video_page = match contract {
        JobContract::Default if !selected.contains(&item.video_page) => selected[0],
        _ => item.video_page,
    };
    let job = CacheJobSpec {
        schema_version: 1,
        item_id: item.id.clone(),
        item_incarnation_id: item.item_incarnation_id.clone(),
        bvid: item.bvid.clone(),
        aid: item.aid.max(0) as u64,
        video_page: u32::try_from(video_page).unwrap_or(0),
        pages,
        cache_root: inputs.cache_root,
        log_file: inputs.log_file,
        cookie: inputs.cookie,
        user_agent: inputs.user_agent,
        referer: inputs.referer,
        timeout_ms: 15_000,
        video_quality: inputs.video_quality,
        avc_quality_cap: inputs.avc_quality_cap,
        audio_hires: inputs.audio_hires,
        executor: inputs.executor,
        selected_audio_variant_id: item.selected_audio_variant_id.clone(),
        reported_ready: item.cache_status == "ready",
        existing_video_relative_path: item.video_relative_path.clone(),
        existing_audio_variants: item
            .audio_variants
            .iter()
            .filter_map(|variant| {
                let relative_path = variant
                    .get("audio_url")?
                    .as_str()?
                    .strip_prefix("/media/")?;
                Some(ExistingAudioVariant {
                    id: variant
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .into(),
                    label: variant
                        .get("label")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .into(),
                    page: variant
                        .get("page")
                        .and_then(Value::as_u64)
                        .and_then(|v| u32::try_from(v.max(1)).ok())
                        .unwrap_or(1),
                    relative_path: relative_path.into(),
                })
            })
            .collect(),
    };
    validate_job_fields(&job)?;
    Ok(job)
}

fn app_error(error: AppStateError) -> CacheRuntimeError {
    CacheRuntimeError::new(&error.kind, error.message)
}

fn reserve(
    app: &mut AppState,
    id: &str,
    incarnation: &str,
) -> Result<CacheAttemptReservation, CacheRuntimeError> {
    app.reserve_runtime_attempt(id, incarnation)
        .map_err(app_error)
}

pub fn execute(command: Command) -> Result<Value, CacheRuntimeError> {
    if let Command::ConfigureBbdown {
        owner,
        prepared_path,
    } = command
    {
        return configure_bbdown(&owner, prepared_path);
    }
    if let Command::Handoff {
        owner,
        item_id,
        expected_item_incarnation_id,
    } = command
    {
        return handoff(&owner, &item_id, &expected_item_incarnation_id);
    }
    let (owner, mut facts, action) = match command {
        Command::Handoff { .. } | Command::ConfigureBbdown { .. } => unreachable!(),
        Command::Reconcile { owner, facts } => (owner, facts, Action::Reconcile),
        Command::Wake { owner, facts } => (owner, facts, Action::Wake),
        Command::Retry {
            owner,
            facts,
            item_id,
            expected_item_incarnation_id,
            force,
        } => (
            owner,
            facts,
            Action::Retry {
                item_id,
                incarnation: expected_item_incarnation_id,
                force,
            },
        ),
        Command::Prepare { owner, facts } => (owner, facts, Action::Prepare),
        Command::Clear { owner, facts } => (owner, facts, Action::Clear),
        Command::Stop { owner, facts } => (owner, facts, Action::Stop),
    };
    validate_cache_root(&facts.cache_root)?;
    facts.cache_root = facts
        .cache_root
        .canonicalize()
        .map_err(|e| CacheRuntimeError::new("io", e.to_string()))?;
    if facts.max_cache_items > 5
        || !facts.log_dir.is_absolute()
        || facts.external_attempts.len() > 256
    {
        return Err(CacheRuntimeError::new(
            "invalid_request",
            "invalid Native cache configuration",
        ));
    }
    // Validate the lifetime before accessing workers, then again at admission.
    with_cache_application(|app| check_owner(app, &owner, &facts)).map_err(app_error)??;
    let runtime = runtime_slot()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_ref()
        .cloned()
        .ok_or_else(|| CacheRuntimeError::new("stopped", "Native cache runtime has not started"))?;
    let mut orchestration = runtime
        .orchestration
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let observed = with_cache_application(|app| app.cache_items())
        .map_err(app_error)?
        .map_err(app_error)?;
    let completed: Vec<_> = lock_state(&runtime.shared)
        .completed
        .values()
        .cloned()
        .collect();
    // Container/file inspection is outside AppState and worker locks. Admission
    // below matches immutable artifact/attempt identities before using these facts.
    let reuse = Reuse::inspect(&observed, &completed, &facts);
    let mut state = lock_state(&runtime.shared);
    let result = with_cache_application(|app| {
        orchestration.apply(&mut state, app, &owner, &facts, action, &reuse)
    })
    .map_err(app_error)?;
    runtime.shared.wake.notify_all();
    result
}

fn configure_bbdown(
    owner: &str,
    prepared_path: Option<PathBuf>,
) -> Result<Value, CacheRuntimeError> {
    let runtime = runtime_slot()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_ref()
        .cloned()
        .ok_or_else(|| CacheRuntimeError::new("stopped", "cache runtime has not started"))?;
    let mut orchestration = runtime
        .orchestration
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    with_cache_application(|app| {
        if !app.artifact_owner(owner) {
            return Err(CacheRuntimeError::new("stopped", "cache owner changed"));
        }
        Ok(())
    })
    .map_err(app_error)??;
    {
        let state = lock_state(&runtime.shared);
        if state.stopping || orchestration.stopped && orchestration.owner == owner {
            return Err(CacheRuntimeError::new(
                "stopped",
                "cache orchestration stopped",
            ));
        }
        if state
            .jobs
            .values()
            .any(|job| matches!(job.spec.executor, Executor::Bbdown { .. }))
            || state.active.iter().any(|(id, active)| {
                state
                    .jobs
                    .get(id)
                    .is_none_or(|job| job.cache_attempt_token != active.cache_attempt_token)
            })
            || (orchestration.owner != owner && !state.active.is_empty())
        {
            return Err(CacheRuntimeError::new(
                "busy",
                "BBDown attempts must drain before configuring its executable",
            ));
        }
    }
    // Only the admission gate is held across the bounded offline probe. Never
    // invoke a tool while holding AppState, worker state or Python store locks.
    let executable = prepared_path.and_then(bbdown::Executable::check);
    if orchestration.owner != owner {
        *orchestration = Orchestration {
            owner: owner.into(),
            ..Default::default()
        };
    }
    let ready = executable.is_some();
    orchestration.bbdown = executable;
    Ok(
        json!({"ready":ready, "message": if ready { "BBDown 1.6.3 ready" } else { "BBDown unavailable: prepare a compatible executable or correct BB_DOWN_PATH" }}),
    )
}

/// An explicit retained-source retry drains this item's old Native executor
/// before Python reserves its replacement. The submission gate stays closed;
/// AppState and worker locks are released while the existing worker unwinds.
fn handoff(owner: &str, id: &str, incarnation: &str) -> Result<Value, CacheRuntimeError> {
    let runtime = runtime_slot()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_ref()
        .cloned()
        .ok_or_else(|| CacheRuntimeError::new("stopped", "Native cache runtime has not started"))?;
    let mut orchestration = runtime
        .orchestration
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    if orchestration.stopped {
        return Err(CacheRuntimeError::new(
            "stopped",
            "cache orchestration stopped",
        ));
    }
    let reservations = {
        let mut state = lock_state(&runtime.shared);
        with_cache_application(|app| {
            if !app.artifact_owner(owner) {
                return Err(CacheRuntimeError::new("stopped", "cache owner changed"));
            }
            let items = app.cache_items().map_err(app_error)?;
            let item = items.iter().find(|i| i.id == id).ok_or_else(|| {
                CacheRuntimeError::new("item_not_found", "playlist item does not exist")
            })?;
            if item.item_incarnation_id != incarnation {
                return Err(CacheRuntimeError::new(
                    "item_incarnation_mismatch",
                    "playlist item incarnation changed before handoff",
                ));
            }
            let reservations: Vec<_> = resource_reservations(&state)
                .into_iter()
                .filter(|r| r.item_id == id)
                .collect();
            CacheRuntime::cancel_item_locked(&mut state, id, "explicit source retry");
            Ok(reservations)
        })
        .map_err(app_error)??
    };
    runtime.shared.wake.notify_all();
    let snapshot = wait_for_item_drain(&runtime, id)?;
    orchestration
        .replacements
        .remove(&(id.into(), incarnation.into()));
    orchestration
        .external_handoffs
        .remove(&(id.into(), incarnation.into()));
    settle_drained_artifacts(&reservations);
    Ok(
        json!({"snapshot":snapshot,"desired_ids":[],"ordered_ids":[],"external_retries":[],"current_ids":[]}),
    )
}

fn wait_for_item_drain(runtime: &CacheRuntime, id: &str) -> Result<Value, CacheRuntimeError> {
    let deadline = Instant::now() + SHUTDOWN_WAIT;
    let mut state = lock_state(&runtime.shared);
    while state.active.contains_key(id) {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(CacheRuntimeError::new(
                "busy",
                "Native cache item did not drain",
            ));
        }
        state = runtime
            .shared
            .wake
            .wait_timeout(state, remaining)
            .unwrap_or_else(|p| p.into_inner())
            .0;
    }
    let snapshot = snapshot_locked(&state);
    drop(state);
    Ok(snapshot)
}

fn check_owner(app: &AppState, owner: &str, facts: &Facts) -> Result<(), CacheRuntimeError> {
    if !app.artifact_admission(owner, &facts.cache_root) {
        return Err(CacheRuntimeError::new(
            "stopped",
            "cache owner is no longer admitting work",
        ));
    }
    Ok(())
}

#[derive(Default)]
struct Reuse {
    reported: Vec<PlaylistItem>,
    completed: HashSet<u64>,
}
impl Reuse {
    fn inspect(items: &[PlaylistItem], completed: &[CompletedJob], facts: &Facts) -> Self {
        Self {
            reported: items
                .iter()
                .filter(|item| {
                    default_job(item, facts)
                        .as_ref()
                        .is_ok_and(existing_artifacts_ready)
                })
                .cloned()
                .collect(),
            completed: completed
                .iter()
                .filter(|job| completed_artifacts_ready(&facts.cache_root, &job.result))
                .map(|job| job.cache_attempt_token)
                .collect(),
        }
    }
    fn ready(&self, item: &PlaylistItem) -> bool {
        item.cache_status == "ready"
            && self.reported.iter().any(|old| {
                old.item_incarnation_id == item.item_incarnation_id
                    && old.artifact_set_id == item.artifact_set_id
                    && old.video_relative_path == item.video_relative_path
                    && old.audio_variants == item.audio_variants
            })
    }
}
fn default_job(item: &PlaylistItem, facts: &Facts) -> Result<CacheJobSpec, CacheRuntimeError> {
    build_job(
        item,
        JobInputs {
            cache_root: facts.cache_root.clone(),
            log_file: facts
                .log_dir
                .join(if facts.download_source == "bbdown" {
                    "bbdown"
                } else {
                    "native"
                })
                .join(format!("{}.log", item.id)),
            cookie: facts.cookie.clone(),
            user_agent: facts.user_agent.clone(),
            referer: facts.referer.clone(),
            video_quality: facts.video_quality.clone(),
            avc_quality_cap: if facts.hevc_supported == Some(false) {
                facts.avc_quality_cap.clone()
            } else {
                String::new()
            },
            audio_hires: facts.audio_hires,
            executor: Executor::Native,
        },
        JobContract::Default,
    )
}

enum Action {
    Reconcile,
    Wake,
    Retry {
        item_id: String,
        incarnation: String,
        force: bool,
    },
    Prepare,
    Clear,
    Stop,
}

impl Orchestration {
    fn apply(
        &mut self,
        state: &mut RuntimeState,
        app: &mut AppState,
        owner: &str,
        facts: &Facts,
        action: Action,
        reuse: &Reuse,
    ) -> Result<Value, CacheRuntimeError> {
        check_owner(app, owner, facts)?;
        if self.owner != owner {
            if !self.owner.is_empty() && (!state.jobs.is_empty() || !state.active.is_empty()) {
                return Err(CacheRuntimeError::new(
                    "busy",
                    "previous cache owner has not drained",
                ));
            }
            *self = Self {
                owner: owner.into(),
                ..Self::default()
            };
        }
        if self.stopped || state.stopping {
            return Err(CacheRuntimeError::new(
                "stopped",
                "cache orchestration stopped",
            ));
        }
        let items = app.cache_items().map_err(app_error)?;
        if self.paused && matches!(action, Action::Wake) {
            return Ok(
                json!({"snapshot":snapshot_locked(state), "desired_ids":[], "ordered_ids":[], "external_retries":[],"current_ids":items.iter().map(|item|&item.id).collect::<Vec<_>>()}),
            );
        }
        let live = |id: &str, incarnation: &str| {
            items
                .iter()
                .any(|item| item.id == id && item.item_incarnation_id == incarnation)
        };
        self.replacements
            .retain(|(id, incarnation)| live(id, incarnation));
        self.external_handoffs
            .retain(|(id, incarnation), _| live(id, incarnation));
        let external: HashMap<_, _> = facts
            .external_attempts
            .iter()
            .filter(|attempt| {
                app.cache_runtime_item(&attempt.item_id, attempt.cache_attempt_token)
                    .is_ok()
            })
            .map(|attempt| (attempt.item_id.as_str(), attempt))
            .collect();
        let current: HashSet<_> = items.iter().map(|item| item.id.clone()).collect();
        let primary = external
            .values()
            .find(|a| a.primary)
            .map(|a| a.item_id.clone())
            .or_else(|| state.primary_active_item_id.clone())
            .filter(|id| current.contains(id));
        let mut active: HashSet<_> = state
            .active
            .keys()
            .filter(|id| current.contains(*id))
            .cloned()
            .collect();
        active.extend(
            external
                .values()
                .filter(|a| a.primary || a.urgent)
                .map(|a| a.item_id.clone()),
        );
        let urgent = items
            .iter()
            .filter(|item| {
                external.get(item.id.as_str()).is_some_and(|a| a.urgent)
                    || state.active.get(&item.id).is_some_and(|a| a.urgent)
            })
            .map(|item| item.id.clone())
            .collect();
        let clearing = matches!(action, Action::Prepare | Action::Clear | Action::Stop);
        let clear_message = match action {
            Action::Prepare if facts.max_cache_items == 0 => "已禁用自动缓存",
            Action::Prepare => "等待缓存",
            Action::Clear => "缓存已清空",
            Action::Stop => "缓存已在退出时清空",
            _ => "",
        };
        let native = matches!(facts.download_source.as_str(), "native" | "bbdown");
        let cap = (
            facts.hevc_supported == Some(false),
            facts.avc_quality_cap.clone(),
        );
        // Default desktop preferences affect future jobs; only a reported AVC
        // fallback/cap change replaces the current window. Native Host retains
        // its own effective-policy replacement contract around the typed builder.
        let recache = native && cap.0 && self.capability.as_ref().is_none_or(|old| old != &cap);
        let jobs: HashMap<_, _> = items
            .iter()
            .map(|item| {
                let job = default_job(item, facts).and_then(|mut job| {
                    if facts.download_source == "bbdown" {
                        if let Some(message) = crate::desktop_login::download_login_error("bbdown", &facts.cookie) {
                            return Err(CacheRuntimeError::new("authentication", message));
                        }
                        job.executor = Executor::Bbdown {
                            executable: self.bbdown.clone().ok_or_else(|| CacheRuntimeError::new(
                                "unavailable", "BBDown unavailable: prepare a compatible executable or correct BB_DOWN_PATH"))?,
                            force_avc: facts.hevc_supported == Some(false),
                            default_host: true,
                        };
                    }
                    Ok(job)
                });
                (item.id.clone(), job)
            })
            .collect();
        let plan = plan_cache_window(CachePlanRequest {
            items: items
                .iter()
                .enumerate()
                .map(|(index, item)| CacheItem {
                    original_index: index,
                    item_id: item.id.clone(),
                    cache_ready: reuse.ready(item),
                })
                .collect(),
            max_items: if clearing { 0 } else { facts.max_cache_items },
            retention_limit: 3,
            active_item_ids: active.into_iter().collect(),
            primary_active_item_id: primary.clone(),
            urgent_item_ids: urgent,
        })
        .map_err(|_| CacheRuntimeError::new("cache_plan", "Rust cache window is invalid"))?;
        let mut manual_urgent = None;
        if let Action::Retry {
            item_id,
            incarnation,
            force,
        } = &action
        {
            let item = items.iter().find(|i| &i.id == item_id).ok_or_else(|| {
                CacheRuntimeError::new("item_not_found", "playlist item does not exist")
            })?;
            if &item.item_incarnation_id != incarnation {
                return Err(CacheRuntimeError::new(
                    "item_incarnation_mismatch",
                    "playlist item incarnation changed before retry",
                ));
            }
            if !native || !plan.desired_ids.contains(item_id) {
                return Err(CacheRuntimeError::new(
                    "retry_not_allowed",
                    "当前不在自动缓存窗口中",
                ));
            }
            if item.cache_status == "ready" && !force {
                return Err(CacheRuntimeError::new(
                    "retry_not_allowed",
                    "这首歌已经缓存完成，无需重新下载",
                ));
            }
            if !["pending", "queued", "downloading", "failed", "ready"]
                .contains(&item.cache_status.as_str())
            {
                return Err(CacheRuntimeError::new(
                    "retry_not_allowed",
                    "当前缓存状态不能重新下载",
                ));
            }
            if facts.download_source == "bbdown"
                && let Some(message) =
                    crate::desktop_login::download_login_error("bbdown", &facts.cookie)
            {
                return Err(CacheRuntimeError::new("retry_not_allowed", message));
            }
            manual_urgent = (*force
                && app.current_cache_item_id() == Some(item_id.as_str())
                && primary.as_ref().is_some_and(|id| id != item_id))
            .then(|| item_id.clone());
            self.replacements
                .insert((item_id.clone(), incarnation.clone()));
            if facts.download_source == "bbdown" && external.contains_key(item_id.as_str()) {
                self.external_handoffs.insert(
                    (item_id.clone(), incarnation.clone()),
                    manual_urgent.as_ref() == Some(item_id),
                );
            }
        }
        self.paused = matches!(action, Action::Prepare | Action::Clear);
        self.capability = Some(cap);
        if !native {
            // A retained source now owns future work; do not replay a deferred
            // Native capability replacement when the user switches back later.
            self.replacements.clear();
            self.external_handoffs.clear();
        }
        if matches!(action, Action::Stop) {
            self.stopped = true;
        }
        // Stale incarnations and removal cancel only the worker actually recorded
        // here; replacement cannot enter while the runtime/AppState locks are held.
        let cancel: Vec<_> = state
            .jobs
            .iter()
            .map(|(id, job)| (id.clone(), job.reservation.item_incarnation_id.clone()))
            .chain(
                state
                    .active
                    .iter()
                    .map(|(id, job)| (id.clone(), job.reservation.item_incarnation_id.clone())),
            )
            .filter(|(id, inc)| !live(id, inc) || clearing || !plan.desired_ids.contains(id))
            .collect();
        for (id, _) in cancel {
            let queued = state
                .jobs
                .get(&id)
                .filter(|job| {
                    state
                        .active
                        .get(&id)
                        .is_none_or(|active| active.cache_attempt_token != job.cache_attempt_token)
                })
                .map(|job| job.reservation.clone());
            CacheRuntime::cancel_item_locked(state, &id, "outside cache window");
            if let Some(reservation) = queued {
                app.settle_artifact_reservation(&reservation);
            }
        }
        state
            .completed
            .retain(|id, job| live(id, &job.reservation.item_incarnation_id));
        state.terminal_events.retain(|id, _| current.contains(id));
        let mut external_retries = Vec::new();
        for item in &items {
            let key = (item.id.clone(), item.item_incarnation_id.clone());
            if !plan.retained_ids.contains(&item.id) {
                self.replacements.remove(&key);
                self.external_handoffs.remove(&key);
                if (!native && !clearing) || external.contains_key(item.id.as_str()) && !clearing {
                    continue;
                }
                let already_evicted = state.terminal_events.get(&item.id).is_some_and(|event| {
                    event.kind == "evicted"
                        && app
                            .cache_runtime_item(&item.id, event.cache_attempt_token)
                            .is_ok()
                });
                if !already_evicted
                    && (clearing
                        || item.cache_status != "pending"
                        || !item.artifact_set_id.is_empty())
                {
                    let reservation = reserve(app, &item.id, &item.item_incarnation_id)?;
                    push_event_locked(
                        state,
                        0,
                        reservation.cache_attempt_token,
                        &item.id,
                        "evicted",
                        json!({"reason": clear_message}),
                    );
                }
                continue;
            }
            if !native || !plan.desired_ids.contains(&item.id) {
                continue;
            }
            if recache {
                self.replacements.insert(key.clone());
            }
            if let Some(attempt) = external.get(item.id.as_str()) {
                if self.replacements.contains(&key) && attempt.retry_open {
                    let handoff = self.external_handoffs.contains_key(&key);
                    let mut effect = json!({"item_id": item.id, "cache_attempt_token": attempt.cache_attempt_token});
                    if handoff {
                        effect["handoff"] = json!(true);
                    }
                    external_retries.push(effect);
                    if !handoff {
                        self.replacements.remove(&key);
                    }
                }
                continue;
            }
            let replace = self.replacements.contains(&key);
            let failed = item.cache_status == "failed"
                || state.terminal_events.get(&item.id).is_some_and(|event| {
                    event.kind == "failed"
                        && app
                            .cache_runtime_item(&item.id, event.cache_attempt_token)
                            .is_ok()
                });
            if failed && !replace {
                continue;
            }
            let preempt = plan.preempt_ids.contains(&item.id)
                && state
                    .active
                    .get(&item.id)
                    .is_some_and(|a| !a.cancel.load(Ordering::Acquire));
            // Future source availability cannot invalidate or relabel an already
            // captured attempt (nor an existing readable publication).
            if !replace
                && !preempt
                && (reuse.ready(item)
                    || state.jobs.get(&item.id).is_some_and(|job| {
                        job.spec.item_incarnation_id == item.item_incarnation_id
                    })
                    || state.active.get(&item.id).is_some_and(|job| {
                        job.reservation.item_incarnation_id == item.item_incarnation_id
                    }))
            {
                continue;
            }
            let job = match &jobs[&item.id] {
                Ok(job) => job.clone(),
                Err(error) => {
                    // A failed replacement still supersedes/cancels the old
                    // executor. Keep its readable artifact under AppState/leases.
                    let queued = state
                        .jobs
                        .get(&item.id)
                        .filter(|job| {
                            state.active.get(&item.id).is_none_or(|active| {
                                active.cache_attempt_token != job.cache_attempt_token
                            })
                        })
                        .map(|job| job.reservation.clone());
                    CacheRuntime::cancel_item_locked(state, &item.id, "replacement unavailable");
                    if let Some(reservation) = queued {
                        app.settle_artifact_reservation(&reservation);
                    }
                    let generation = state.next_generation.checked_add(1).ok_or_else(|| {
                        CacheRuntimeError::new(
                            "generation_exhausted",
                            "cache generation is exhausted",
                        )
                    })?;
                    let reservation = reserve(app, &item.id, &item.item_incarnation_id)?;
                    state.next_generation = generation;
                    push_event_locked(
                        state,
                        state.next_generation,
                        reservation.cache_attempt_token,
                        &item.id,
                        "failed",
                        json!({"message":error.message}),
                    );
                    self.replacements.remove(&key);
                    self.external_handoffs.remove(&key);
                    continue;
                }
            };
            if !replace
                && (reuse.ready(item)
                    || state.completed.get(&item.id).is_some_and(|done| {
                        done.reservation.item_incarnation_id == item.item_incarnation_id
                            && reuse.completed.contains(&done.cache_attempt_token)
                    }))
            {
                continue;
            }
            let priority = if manual_urgent.as_ref() == Some(&item.id)
                || self.external_handoffs.get(&key) == Some(&true)
            {
                CacheJobPriority::Urgent
            } else {
                CacheJobPriority::Normal
            };
            state.completed.remove(&item.id);
            let superseded = state
                .jobs
                .get(&item.id)
                .filter(|old| {
                    (replace || preempt)
                        && state.active.get(&item.id).is_none_or(|active| {
                            active.cache_attempt_token != old.cache_attempt_token
                        })
                })
                .map(|old| old.reservation.clone());
            CacheRuntime::submit_locked(state, job, priority, replace || preempt, |id, inc| {
                reserve(app, id, inc)
            })?;
            if let Some(reservation) = superseded {
                app.settle_artifact_reservation(&reservation);
            }
            self.replacements.remove(&key);
            self.external_handoffs.remove(&key);
        }
        CacheRuntime::reorder_locked(state, &plan.pending_order);
        Ok(
            json!({"snapshot": snapshot_locked(state), "desired_ids": plan.desired_ids,
            "ordered_ids": plan.pending_order, "external_retries": external_retries,"current_ids":items.iter().map(|item|&item.id).collect::<Vec<_>>()}),
        )
    }
}
