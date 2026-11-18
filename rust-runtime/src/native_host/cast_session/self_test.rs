//! Host-owned, cancellable compatibility test. Raw receiver inputs never enter snapshots.
use super::*;
use crate::dlna::diagnostics::{self as diag, Cell, SkipReason, UserAnswers};
use tokio::sync::mpsc;

mod network_profile;
pub(super) mod runner;
pub(super) mod samples;

#[derive(Default)]
pub(crate) struct State {
    pub generation: u64,
    pub running: bool,
    pub trace: Option<Arc<SessionTrace>>,
    stage: Option<diag::SelfTestStage>,
    cell: Option<Cell>,
    question: bool,
    question_id: u64,
    question_deadline_ms: Option<i64>,
    ask_sync: bool,
    registered: bool,
    registration_attempted: bool,
    preferences_persisted: bool,
    /// A prepared Pure K room exists but the selected device row is not it.
    purek_room_unmatched: bool,
    pub(super) cancel: CancellationToken,
    answers: Option<mpsc::Sender<AnswerEnvelope>>,
    handoff: Option<tokio::sync::oneshot::Sender<bool>>,
    #[cfg(test)]
    changed: Arc<tokio::sync::Notify>,
}
impl State {
    pub fn snapshot(&self) -> Value {
        json!({"generation":self.generation,"running":self.running,"stage":self.stage,
            "cell":self.cell,"question":self.question,"ask_sync":self.ask_sync,
            "question_id":self.question_id,"question_deadline_ms":self.question_deadline_ms,
            "handoff_available":self.handoff.is_some(),
            "registered":self.registered,"purek_room_unmatched":self.purek_room_unmatched,"registration_attempted":self.registration_attempted,"preferences_persisted":self.preferences_persisted,
            "report_available":self.trace.is_some() && !self.running})
    }
}

pub(super) struct AnswerEnvelope {
    cell: Cell,
    question_id: u64,
    answers: UserAnswers,
}

struct Request {
    renderer: Option<Renderer>,
    qr: Option<String>,
    confirmed: bool,
    /// None: no prepared Pure K room; Some(true): prepared but not this device.
    purek_room_unmatched: Option<bool>,
}

#[cfg(windows)]
fn os_version() -> String {
    #[repr(C)]
    struct Version {
        size: u32,
        major: u32,
        minor: u32,
        build: u32,
        platform: u32,
        service_pack: [u16; 128],
    }
    #[link(name = "ntdll")]
    unsafe extern "system" {
        fn RtlGetVersion(version: *mut Version) -> i32;
    }
    let mut version = Version {
        size: std::mem::size_of::<Version>() as u32,
        major: 0,
        minor: 0,
        build: 0,
        platform: 0,
        service_pack: [0; 128],
    };
    // SAFETY: matches OSVERSIONINFOW; the system fills this writable structure.
    if unsafe { RtlGetVersion(&mut version) } == 0 {
        format!("{}.{}.{}", version.major, version.minor, version.build)
    } else {
        String::new()
    }
}
#[cfg(unix)]
fn os_version() -> String {
    let mut name = std::mem::MaybeUninit::<libc::utsname>::uninit();
    // SAFETY: uname initializes the whole structure on success; release is NUL terminated.
    if unsafe { libc::uname(name.as_mut_ptr()) } == 0 {
        let name = unsafe { name.assume_init() };
        unsafe { std::ffi::CStr::from_ptr(name.release.as_ptr()) }
            .to_string_lossy()
            .into_owned()
    } else {
        String::new()
    }
}
#[cfg(not(any(unix, windows)))]
fn os_version() -> String {
    String::new()
}

pub(super) fn route(
    context: &Arc<HostContext>,
    identity: &Identity,
    method: &Method,
    path: &str,
    body: &Value,
) -> Result<Value, ApiError> {
    with_app(|app| {
        app.native_authorize(identity, true)?;
        if path == "/api/cast/self-test/report" && method == Method::GET {
            return app
                .native()
                .cast
                .self_test
                .trace
                .as_ref()
                .map(|trace| {
                    let report = trace.report();
                    json!({"diagnostics":report.diagnostics(),"text":report.text()})
                })
                .ok_or_else(|| {
                    ApiError::new(404, "cast_report_unavailable", "No compatibility report")
                });
        }
        if method != Method::POST || !body.is_object() {
            return Err(ApiError::invalid("Self-test requires POST JSON"));
        }
        if path == "/api/cast/self-test/start" {
            if context.stop.load(Ordering::Acquire) || app.native_session_choice_pending() {
                return Err(ApiError::new(
                    409,
                    "session_choice_pending",
                    "Host is not ready",
                ));
            }
            if app.native().local_output.controller.owns_playback {
                return Err(ApiError::new(
                    409,
                    "cast_busy",
                    "Stop the local pipeline first",
                ));
            }
            let cast = &mut app.native().cast;
            if body["generation"].as_u64() != Some(cast.self_test.generation) {
                return Err(ApiError::new(
                    409,
                    "cast_self_test_stale",
                    "Compatibility test changed",
                ));
            }
            if body
                .as_object()
                .unwrap()
                .keys()
                .any(|key| !matches!(key.as_str(), "generation" | "device_key"))
            {
                return Err(ApiError::invalid(
                    "Prepare the room through the Host authorization flow",
                ));
            }
            if cast.self_test.running
                || cast.pipeline_running
                || cast.connected
                || cast.owns_playback
                || cast.pending.is_some()
                || cast.phase != Phase::Idle
            {
                return Err(ApiError::new(
                    409,
                    "cast_busy",
                    "Disconnect before compatibility testing",
                ));
            }
            let key = match body.get("device_key") {
                None | Some(Value::Null) => None,
                Some(Value::String(key)) if key.is_empty() => None,
                Some(Value::String(key)) => Some(key),
                _ => return Err(ApiError::invalid("Invalid device key")),
            };
            let renderer = key
                .map(|key| {
                    cast.renderers
                        .iter()
                        .find(|r| renderer_key(r) == *key)
                        .cloned()
                        .ok_or_else(|| {
                            ApiError::new(
                                409,
                                "cast_renderer_unavailable",
                                "Discover the receiver again",
                            )
                        })
                })
                .transpose()?;
            // P9 uses next prepare/ktv; never accept a second QR credential from this API.
            let qr = cast
                .room
                .as_ref()
                .filter(|room| {
                    renderer.as_ref().is_none_or(|r| {
                        url::Url::parse(&r.description.location).ok().as_ref()
                            == Some(&room.description)
                    })
                })
                .and_then(super::super::purek::Room::authorization_url)
                .map(str::to_owned);
            // Never silently drop a prepared room: report it as unmatched.
            let purek_room_unmatched = cast
                .room
                .as_ref()
                .is_some_and(|room| room.authorization.is_some())
                .then_some(qr.is_none());
            let target = if qr.is_some() {
                diag::TargetKind::Purek
            } else if renderer.as_ref().is_some_and(|r| {
                r.description.vendor_class == crate::dlna::dlna_policy::VendorClass::Lebo
            }) {
                diag::TargetKind::Lebo
            } else {
                diag::TargetKind::Generic
            };
            let trace = Arc::new(
                SessionTrace::new(
                    worker::platform(),
                    target,
                    env!("CARGO_PKG_VERSION"),
                    &os_version(),
                )
                .map_err(|_| {
                    ApiError::new(
                        503,
                        "cast_diagnostics_unavailable",
                        "Cannot initialize diagnostics",
                    )
                })?,
            );
            let (sender, receiver) = mpsc::channel(1);
            let output = match crate::cast_platform::OutputLease::acquire() {
                Ok(output) => output,
                Err(error) => {
                    if crate::cast_platform::initialization_failure().is_some() {
                        // A failed optional bridge still yields an honest S0 report.
                        // Do not start discovery/media or pretend to own a service.
                        let facts = crate::cast_platform::network_facts();
                        trace.environment(diag::Environment {
                            network_hint: facts.network_hint(),
                            android_network: Some(facts.clone()),
                            ..Default::default()
                        });
                        trace.self_test_step(diag::SelfTestStep {
                            stage: diag::SelfTestStage::S0,
                            outcome: diag::StageOutcome::Failed,
                            elapsed_ms: 0,
                        });
                        trace.finish(false);
                        cast.network_facts = facts;
                        cast.error_code = Some(error.code().into());
                        cast.self_test = State {
                            generation: cast.self_test.generation + 1,
                            trace: Some(trace),
                            ..Default::default()
                        };
                        app.native().revision += 1;
                    }
                    return Err(ApiError::new(409, error.code(), error.code()));
                }
            };
            cast.platform_output_id = Some(output.id());
            cast.platform_stop_error = None;
            let generation = cast.self_test.generation + 1;
            let cancel = CancellationToken::new();
            cast.self_test = State {
                generation,
                running: true,
                trace: Some(trace.clone()),
                cancel: cancel.clone(),
                answers: Some(sender),
                purek_room_unmatched: purek_room_unmatched == Some(true),
                ..Default::default()
            };
            let snapshot = app.native_snapshot(true)?;
            let cast = &mut app.native().cast;
            cast.position = snapshot["player_status"]["current_time"]
                .as_f64()
                .unwrap_or(0.0);
            cast.paused = snapshot["player_status"]["is_paused"]
                .as_bool()
                .unwrap_or(false);
            cast.playback_generation = snapshot["playback_generation"].as_u64().unwrap_or(0);
            cast.operation += 1;
            cast.cancel = cancel.clone();
            cast.resume = None;
            cast.published_resume = None;
            cast.error_code = None;
            cast.owns_playback = true;
            cast.phase = Phase::Connecting;
            cast.trace = Some(trace.clone());
            let operation = cast.operation;
            let ctx = context.clone();
            let request = Request {
                renderer,
                qr,
                confirmed: false,
                purek_room_unmatched,
            };
            if context
                .spawn("dlna-self-test", move || {
                    // Keep the same foreground lease through the T5 handoff.
                    let _output = output;
                    run(ctx, generation, operation, request, trace, cancel, receiver)
                })
                .is_err()
            {
                cast.self_test.running = false;
                cast.self_test.answers = None;
                cast.owns_playback = false;
                cast.platform_output_id = None;
                cast.phase = Phase::Idle;
                return Err(ApiError::new(
                    503,
                    "cast_worker_unavailable",
                    "Cannot start compatibility test",
                ));
            }
            app.native().revision += 1;
            return Ok(json!({"accepted":true,"generation":generation}));
        }
        let test = &mut app.native().cast.self_test;
        if body["generation"].as_u64() != Some(test.generation) || !test.running {
            return Err(ApiError::new(
                409,
                "cast_self_test_stale",
                "Compatibility test changed",
            ));
        }
        match path {
            "/api/cast/self-test/cancel" => test.cancel.cancel(),
            "/api/cast/self-test/handoff" => {
                let keep = body["start_casting"]
                    .as_bool()
                    .ok_or_else(|| ApiError::invalid("Missing handoff choice"))?;
                test.handoff
                    .take()
                    .ok_or_else(|| {
                        ApiError::new(409, "cast_self_test_stale", "Handoff choice expired")
                    })?
                    .send(keep)
                    .map_err(|_| {
                        ApiError::new(409, "cast_self_test_stale", "Handoff choice expired")
                    })?;
            }
            "/api/cast/self-test/answer" => {
                let cell: Cell = serde_json::from_value(body["cell"].clone())
                    .map_err(|_| ApiError::invalid("Invalid cell"))?;
                if !test.question
                    || test.cell != Some(cell)
                    || body["question_id"].as_u64() != Some(test.question_id)
                    || test
                        .question_deadline_ms
                        .is_none_or(|deadline| chrono::Utc::now().timestamp_millis() >= deadline)
                {
                    return Err(ApiError::new(
                        409,
                        "cast_self_test_stale",
                        "Question changed",
                    ));
                }
                let answer: UserAnswers = serde_json::from_value(body["answers"].clone())
                    .map_err(|_| ApiError::invalid("Invalid answers"))?;
                test.answers
                    .as_ref()
                    .ok_or_else(|| ApiError::invalid("No question"))?
                    .try_send(AnswerEnvelope {
                        cell,
                        question_id: test.question_id,
                        answers: answer,
                    })
                    .map_err(|_| ApiError::new(409, "cast_busy", "Answer already submitted"))?;
                test.question = false;
            }
            _ => {
                return Err(ApiError::new(
                    404,
                    "not_found",
                    "Unknown compatibility route",
                ));
            }
        }
        app.native().revision += 1;
        Ok(json!({"accepted":true}))
    })
}

fn update(generation: u64, change: impl FnOnce(&mut State)) {
    let _ = with_app(|app| {
        if app.native().cast.self_test.generation == generation {
            change(&mut app.native().cast.self_test);
            #[cfg(test)]
            app.native().cast.self_test.changed.notify_one();
            app.native().revision += 1;
        }
        Ok(())
    });
}

fn run(
    context: Arc<HostContext>,
    generation: u64,
    operation: u64,
    request: Request,
    trace: Arc<SessionTrace>,
    cancel: CancellationToken,
    answers: mpsc::Receiver<AnswerEnvelope>,
) {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .max_blocking_threads(2)
        .enable_all()
        .build();
    let mut handed_off = false;
    match runtime {
        Ok(runtime) => runtime.block_on(async {
            let watcher_context = context.clone();
            let watcher_cancel = cancel.clone();
            let watch = tokio::spawn(async move {
                loop {
                    tokio::select! {
                        _ = watcher_cancel.cancelled() => break,
                        _ = tokio::time::sleep(Duration::from_millis(20)) => {
                            if watcher_context.stop.load(Ordering::Acquire) { watcher_cancel.cancel(); }
                        }
                    }
                }
            });
            let next = runner::run(context.clone(),generation,request,trace.clone(),cancel.clone(),answers,runner::Timing::default()).await;
            // Publish the completed self-test before the ordinary cast can run
            // indefinitely. Its trace/elapsed time must not follow that session.
            complete(generation, &trace, cancel.is_cancelled());
            if let Some(next) = next {
                handed_off = true;
                worker::handoff(&context, operation, next.renderer, next.room, &cancel).await;
                update(generation, |s| s.registered = false);
            }
            cancel.cancel();
            let _ = watch.await;
        }),
        Err(_) => trace.finish(true),
    }
    update(generation, |s| {
        s.running = false;
        s.question = false;
        s.answers = None;
    });
    if !handed_off {
        worker::restore(operation, None);
    }
}

fn complete(generation: u64, trace: &SessionTrace, cancelled: bool) {
    trace.finish(cancelled);
    update(generation, |s| {
        // Keep admission closed until worker::handoff atomically transfers
        // playback ownership (or the ordinary completion path restores it).
        s.question = false;
        s.question_deadline_ms = None;
        s.answers = None;
        s.handoff = None;
    });
}

fn learn(generation: u64, renderer: &Renderer, trace: &SessionTrace) {
    let report = trace.report();
    let conclusion = &report.diagnostics()["cast_self_test"]["conclusion"];
    let mode = match conclusion["learned_mode"].as_str() {
        Some("file" | "file_mp4") => Some(LearnedMode::File),
        Some("live") => Some(LearnedMode::Live),
        _ => None,
    };
    let variant = match (
        conclusion["learned_mode"].as_str(),
        conclusion["learned_variant"].as_str(),
    ) {
        (Some("file_mp4"), _) => Some(Variant::FileMp4),
        (_, Some("a")) => Some(Variant::Original),
        (_, Some("b")) => Some(Variant::Uniform),
        _ => None,
    };
    if mode.is_none() {
        return;
    }
    let _ = with_app(|app| {
        if app.native().cast.self_test.generation != generation {
            return Ok(());
        }
        let key = renderer_key(renderer);
        let persistent = preference_key(renderer).is_some();
        let mut device = app
            .cast_preferences()?
            .devices
            .get(&key)
            .cloned()
            .or_else(|| app.native().cast.session_devices.get(&key).cloned())
            .unwrap_or_default();
        device.learned_mode = mode;
        device.learned_variant = variant;
        device.learned_at = Some(chrono::Utc::now().to_rfc3339());
        device.self_test_report_version = Some(1);
        device.last_used = chrono::Utc::now().timestamp_millis().max(0) as u64;
        let revision = app.native_core_snapshot()?.revision;
        let result = if persistent {
            app.cast_set_device(&key, revision, device)
        } else {
            app.cast_set_session_device(&key, revision, device)
        };
        if result.is_err() {
            app.native().cast.error_code = Some("persistence_error".into());
        }
        app.native().cast.self_test.preferences_persisted = persistent && result.is_ok();
        app.native().revision += 1;
        result
    });
}

pub(crate) fn download(identity: &Identity) -> Result<Response, ApiError> {
    let report = with_app(|app| {
        app.native_authorize(identity, true)?;
        app.native()
            .cast
            .self_test
            .trace
            .as_ref()
            .map(|t| t.report())
            .ok_or_else(|| ApiError::new(404, "cast_report_unavailable", "No compatibility report"))
    })?;
    let bytes = serde_json::to_vec_pretty(
        &json!({"diagnostics":report.diagnostics(),"summary":report.text()}),
    )
    .map_err(|_| ApiError::new(503, "cast_report_unavailable", "Cannot encode report"))?;
    let length = bytes.len();
    let mut response = Body::from(bytes).into_response();
    let headers = response.headers_mut();
    headers.insert("content-type", "application/json".parse().unwrap());
    headers.insert("content-length", length.to_string().parse().unwrap());
    headers.insert("cache-control", "no-store".parse().unwrap());
    headers.insert(
        "content-disposition",
        "attachment; filename=\"bilikara-cast-self-test.json\""
            .parse()
            .unwrap(),
    );
    Ok(response)
}

#[cfg(test)]
pub(super) mod tests;
