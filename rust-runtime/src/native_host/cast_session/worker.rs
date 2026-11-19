use super::*;
use crate::app_state::{AppStateRequest, PlaylistItem};
use crate::dlna::{
    Operation,
    cast_http::{CastEndpoint, HttpStageResult, ServerIdentity, TsMime},
    control::{
        CapabilityQuery, ControlClient, MonitorDecision, MonitorSample, StartRequest,
        TransportMonitor,
    },
    diagnostics::{self, OutputConfig},
    discovery,
    dlna_policy::{FileMetadata, TransportState},
    purek,
};
use crate::experimental_libav::cast_mux::CastSession;
use std::time::Instant;

// Allow slow receivers (including two 2.5s replies in one poll). Commands can
// interrupt either RPC; responsiveness must not depend on a short RPC timeout.
const MONITOR_TIMEOUT: Duration = Duration::from_secs(4);
const RECEIVER_SILENCE: Duration = Duration::from_secs(8);
const RECOVERY_WINDOW: Duration = Duration::from_secs(4);

fn receiver_silent(last_response: Instant, failures: u8, now: Instant) -> bool {
    failures > 0 && now.saturating_duration_since(last_response) >= RECEIVER_SILENCE
}

fn clock_after_observation(running: bool, state: TransportState) -> bool {
    match state {
        TransportState::Playing => true,
        TransportState::Unknown => running, // Disabled monitor: retain the last known state.
        TransportState::Paused
        | TransportState::Stopped
        | TransportState::NoMedia
        | TransportState::Transitioning => false,
    }
}

fn update<T>(operation: u64, action: impl FnOnce(&mut State) -> T) -> Option<T> {
    with_app(|app| {
        if app.native().cast.operation != operation {
            return Ok(None);
        }
        let result = action(&mut app.native().cast);
        app.native().cast.observation_sequence =
            app.native().cast.observation_sequence.saturating_add(1);
        app.native().revision += 1;
        Ok(Some(result))
    })
    .ok()
    .flatten()
}
pub(super) fn platform() -> diagnostics::Platform {
    if cfg!(windows) {
        diagnostics::Platform::Windows
    } else if cfg!(target_os = "macos") {
        diagnostics::Platform::Macos
    } else if cfg!(target_os = "android") {
        diagnostics::Platform::Android
    } else {
        diagnostics::Platform::Linux
    }
}
fn error(code: &str) -> ApiError {
    ApiError::new(409, code, code)
}
fn record<T>(
    trace: &SessionTrace,
    connection: u64,
    output: Option<u64>,
    operation: Operation<T>,
) -> Result<T, ApiError> {
    trace.record_operation(Some(connection), output, &operation);
    operation.result.map_err(|e| error(e.code.as_str()))
}

pub(super) fn run(context: Arc<HostContext>) {
    let Ok(runtime) = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .max_blocking_threads(2)
        .enable_all()
        .build()
    else {
        let operation = with_app(|app| {
            app.native().cast.worker_started = false;
            app.native().cast.pending = None;
            app.native().revision += 1;
            Ok(app.native().cast.operation)
        });
        if let Ok(operation) = operation {
            restore(operation, Some("cast_worker_unavailable".into()));
        }
        return;
    };
    runtime.block_on(async {
        while !context.stop.load(Ordering::Acquire) {
            let pending = with_app(|app| {
                let s = &mut app.native().cast;
                if s.self_test_handoff_active || s.self_test.running {
                    return Ok(None);
                }
                Ok(s.pending.take().map(|r| {
                    s.mux_stop = Arc::new(AtomicBool::new(false));
                    (s.operation, r, s.cancel.clone(), s.mux_stop.clone())
                }))
            })
            .ok()
            .flatten();
            let Some((id, request, cancel, stop)) = pending else {
                tokio::time::sleep(Duration::from_millis(30)).await;
                continue;
            };
            let watching = context.clone();
            let watch_cancel = cancel.clone();
            let watch_stop = stop.clone();
            let watch = tokio::spawn(async move {
                while !watch_cancel.is_cancelled() && !watching.stop.load(Ordering::Acquire) {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                watch_cancel.cancel();
                watch_stop.store(true, Ordering::Release);
            });
            match request {
                Request::Disconnect => {
                    restore(id, None);
                }
                Request::Discover(location) => {
                    if let Ok(trace) = SessionTrace::new(
                        platform(),
                        diagnostics::TargetKind::Generic,
                        env!("CARGO_PKG_VERSION"),
                        std::env::consts::OS,
                    ) {
                        let trace = Arc::new(trace);
                        let connection = trace.begin_connection();
                        update(id, |s| s.trace = Some(trace.clone()));
                        let result = if let Some(location) = location {
                            record(
                                &trace,
                                connection,
                                None,
                                load_renderer(&location, &cancel).await,
                            )
                            .map(|r| vec![r])
                        } else {
                            let result = discovery::discover(&cancel, |event| {
                                trace.discovery(connection, &event);
                                if let discovery::DiscoveryUpdate::Renderers(renderers) = event {
                                    update(id, |s| s.renderers = renderers);
                                }
                            })
                            .await;
                            result.result.map_err(|e| error(e.code.as_str()))
                        };
                        trace.finish(cancel.is_cancelled());
                        let facts = crate::cast_platform::network_facts();
                        update(id, |s| {
                            s.network_facts = facts;
                            s.phase = Phase::Idle;
                            match result {
                                Ok(r) => s.renderers = r,
                                Err(e) => s.error_code = Some(e.code),
                            }
                        });
                    }
                }
                Request::Connect {
                    output: _output,
                    renderer,
                    qr,
                    confirmed,
                    location,
                    assisted,
                } => {
                    let result = connect(
                        ConnectContext {
                            context: &context,
                            id,
                            assisted: assisted.as_ref(),
                            cancel: &cancel,
                            stop: &stop,
                        },
                        renderer.map(|r| *r),
                        qr,
                        confirmed,
                        location,
                    )
                    .await;
                    if let Some(grant) = &assisted {
                        let _ = with_app(|app| {
                            if super::super::purek::assistance::check_current(
                                app,
                                &grant.remote,
                                (&grant.request, &grant.epoch),
                            )
                            .is_ok()
                            {
                                super::super::purek::assistance::checked(
                                    app,
                                    &grant.remote,
                                    false,
                                    result.as_ref().err().map(|e| e.code.clone()),
                                );
                            }
                            super::super::purek::assistance::release_io(
                                app,
                                grant.generation,
                                &grant.epoch,
                            );
                            Ok(())
                        });
                    }
                    restore(id, result.err().map(|e| e.code));
                }
            }
            cancel.cancel();
            stop.store(true, Ordering::Release);
            let _ = watch.await;
        }
        // Host shutdown can win before the worker takes an admitted request.
        // Drop its foreground lease even though AppState outlives NativeHost.
        if let Ok(id) = with_app(|app| {
            let state = &mut app.native().cast;
            state.pending = None;
            state.worker_started = false;
            Ok(state.operation)
        }) {
            restore(id, None);
        }
    });
}

pub(super) fn restore(id: u64, failure: Option<String>) {
    let _ = with_app(|app| {
        let snap = app.native_cast_input()?;
        let state = &mut app.native().cast;
        // Even a superseding disconnect must receive the last receiver position.
        // A new connection will capture this resume before taking ownership.
        if state.owns_playback || state.resume.is_some() {
            if state.playback_generation != snap.playback_generation {
                state.position = 0.0;
                state.paused = false;
            }
            state.resume = Some(
                json!({"playback_generation":snap.playback_generation,"item_id":snap.current_item.as_ref().map(|i|&i.id),"position":state.position,"is_paused":state.paused,"operation_id":id}),
            );
        }
        if state.operation == id || matches!(state.pending, Some(Request::Disconnect)) {
            state.owns_playback = false;
            state.l1 = false;
            state.platform_output_id = None;
            state.connected = false;
            state.connection_id = None;
            state.room_busy = false;
            state.output_enabled = false;
            state.pipeline_running = false;
            state.phase = Phase::Idle;
            state.error_code = state.platform_stop_error.map(str::to_owned).or(failure);
            state.room_error = state.error_code.clone();
            state.output_failure = None;
            // A superseded worker drains before the queued disconnect. Keep
            // its platform failure until that final operation publishes it.
            if state.operation == id {
                state.platform_stop_error = None;
            }
            state.control_busy = false;
            state.capability_probe_running = false;
            state.receiver_state = None;
        }
        projection::resume_local(app)?;
        app.native().revision += 1;
        Ok(())
    });
}

struct ConnectContext<'a> {
    context: &'a Arc<HostContext>,
    id: u64,
    assisted: Option<&'a Assisted>,
    cancel: &'a CancellationToken,
    stop: &'a Arc<AtomicBool>,
}

fn is_local_pipeline_failure(error: &ApiError) -> bool {
    matches!(
        error.code.as_str(),
        "cast_backend_unavailable" | "cast_prepare_failed" | "cast_publish_failed"
    )
}

fn suspend_failed_output(id: u64, failure: ApiError, stage: &'static str) -> Result<(), ApiError> {
    with_app(|app| {
        let snap = app.native_cast_input()?;
        let s = &mut app.native().cast;
        if s.operation != id || s.cancel.is_cancelled() {
            return Err(error("cancelled"));
        }
        if s.playback_generation != snap.playback_generation {
            s.position = 0.0;
            s.paused = false;
        }
        s.resume = Some(json!({"playback_generation":snap.playback_generation,
            "item_id":snap.current_item.as_ref().map(|i|&i.id),"position":s.position,
            "is_paused":s.paused,"operation_id":id}));
        s.output_failure = Some((failure.code.clone(), stage));
        s.error_code = Some(failure.code);
        s.output_enabled = false;
        s.owns_playback = false;
        s.l1 = false;
        s.phase = Phase::Active;
        s.control = None;
        s.control_busy = false;
        s.delivered = false;
        s.receiver_state = None;
        projection::resume_local(app)?;
        app.native().revision += 1;
        Ok(())
    })
}
async fn connect(
    admitted: ConnectContext<'_>,
    renderer: Option<Renderer>,
    qr: Option<String>,
    confirmed: bool,
    location: Option<String>,
) -> Result<(), ApiError> {
    let ConnectContext {
        context,
        id,
        assisted,
        cancel,
        stop,
    } = admitted;
    let trace = Arc::new(
        SessionTrace::new(
            platform(),
            if qr.is_some() {
                diagnostics::TargetKind::Purek
            } else {
                diagnostics::TargetKind::Generic
            },
            env!("CARGO_PKG_VERSION"),
            std::env::consts::OS,
        )
        .map_err(|_| error("cast_diagnostics_unavailable"))?,
    );
    let connection = trace.begin_connection();
    update(id, |s| s.trace = Some(trace.clone()));
    let prepared = qr
        .as_deref()
        .map(super::super::purek::Room::parse)
        .transpose()?;
    let mut room = None;
    let renderer = if let Some(qr) = qr {
        let operation = connect_room(&qr, confirmed, cancel).await;
        trace.record_purek_operation(connection, &operation);
        if operation.result.is_err() {
            record_room_failure(id, &operation);
        }
        let session = operation.result.map_err(|e| error(e.code.as_str()))?;
        let renderer = session.renderer();
        room = Some(session);
        renderer.map_err(|e| error(e.code.as_str()))
    } else if let Some(location) = location {
        let operation = load_renderer(&location, cancel).await;
        if let Err(failure) = &operation.result {
            let stage = if operation
                .stages
                .iter()
                .rev()
                .find(|s| s.result.is_err())
                .is_some_and(|s| s.stage == crate::dlna::Stage::Route)
            {
                "route"
            } else {
                "description"
            };
            update(id, |s| {
                s.room_failure = Some((
                    projection::legacy_error(failure.code.as_str()).into(),
                    stage,
                ))
            });
        }
        record(&trace, connection, None, operation)
    } else {
        renderer.ok_or_else(|| error("cast_renderer_unavailable"))
    };
    // Never use `?` after acquiring the room without passing this cleanup.
    let result = match renderer {
        Ok(renderer) => {
            if let Ok(client) = make_control(renderer.clone()) {
                query_capabilities(&client, id, &trace, connection, None, cancel).await;
            }
            let admitted = with_app(|app| {
                if app.native().cast.operation != id || cancel.is_cancelled() {
                    return Err(error("cancelled"));
                }
                if let Some(grant) = assisted {
                    super::super::purek::assistance::check_current(
                        app,
                        &grant.remote,
                        (&grant.request, &grant.epoch),
                    )?;
                }
                let state = &mut app.native().cast;
                state.connected = true;
                state.room_busy = false;
                state.connection_cancel = None;
                state.connection_id = Some(token()?);
                if let Some(prepared) = prepared {
                    state.room = Some(prepared);
                }
                if let Some(room) = state.room.as_mut().filter(|r| r.authorization.is_none()) {
                    room.name = renderer.description.name.chars().take(100).collect();
                }
                if state.room.is_none() {
                    state.room = Some(super::super::purek::Room {
                        name: renderer.description.name.clone(),
                        description: url::Url::parse(&renderer.description.location)
                            .map_err(|_| error("cast_renderer_unavailable"))?,
                        authorization: None,
                    });
                }
                if let Some(grant) = assisted {
                    app.native().ktv.connecting = None;
                    super::super::purek::assistance::checked(app, &grant.remote, true, None);
                }
                app.native().revision += 1;
                Ok(())
            });
            if let Err(error) = admitted {
                if let Some(room) = &mut room {
                    let release = room.release().await;
                    trace.record_purek_operation(connection, &release);
                }
                return Err(error);
            }
            play_session(
                context,
                id,
                renderer,
                (&trace, connection),
                cancel,
                stop,
                &mut room,
            )
            .await
        }
        Err(e) => Err(e),
    };
    stop.store(true, Ordering::Release);
    if let Some(room) = &mut room {
        let release = room.release().await;
        trace.record_purek_operation(connection, &release);
    }
    trace.finish(cancel.is_cancelled());
    result
}

struct Output {
    id: u64,
    generation: u64,
    item: PlaylistItem,
    playback_generation: u64,
    live: Option<media::Live>,
    l1: bool,
    /// File delivery: the settings rendered into the published file, and a
    /// differing Host setting with the time it was first seen (debounce).
    baked: Option<media::Baked>,
    regenerate: Option<(media::Baked, Instant)>,
    began: Instant,
    start: f64,
    receiver_origin: f64,
    duration: f64,
    paused: bool,
    seen_playing: bool,
    seek_settles: Instant,
    last_position: Option<f64>,
    position_advanced: Instant,
    position_usable: bool,
    clock_running: bool,
    intentional_stop: bool,
}

/// Transfer the already admitted receiver/registration from the self-test into
/// the ordinary T5 playback loop. The room never returns to a QR/string form.
pub(super) async fn handoff(
    context: &Arc<HostContext>,
    previous: u64,
    renderer: Renderer,
    mut room: Option<purek::Session>,
    cancel: &CancellationToken,
) {
    let id = with_app(|app| {
        let state = &mut app.native().cast;
        if state.operation != previous
            || cancel.is_cancelled()
            || context.stop.load(Ordering::Acquire)
        {
            return Err(error("cancelled"));
        }
        state.operation += 1;
        state.phase = Phase::Connecting;
        state.cancel = cancel.clone();
        state.mux_stop = Arc::new(AtomicBool::new(false));
        state.owns_playback = true;
        state.connected = true;
        state.room_busy = false;
        state.connection_id = Some(token()?);
        // P10 review N4: the ordinary session now belongs to the device the
        // self-test handed over. Keep a prepared room only when it is that
        // device (its credential was used); never leave an unrelated room.
        let location = url::Url::parse(&renderer.description.location)
            .map_err(|_| error("cast_renderer_unavailable"))?;
        if state
            .room
            .as_ref()
            .is_none_or(|room| room.description != location)
        {
            state.room = Some(super::super::purek::Room {
                name: renderer.description.name.clone(),
                description: location,
                authorization: None,
            });
        }
        state.output_enabled = true;
        state.self_test_handoff_active = true;
        state.self_test.running = false;
        let admitted = (state.operation, state.mux_stop.clone());
        app.native().revision += 1;
        Ok(admitted)
    });
    let Ok((id, stop)) = id else {
        if let Some(room) = &mut room {
            let _ = room.release().await;
        }
        restore(previous, None);
        return;
    };
    let trace = SessionTrace::new(
        platform(),
        if room.is_some() {
            diagnostics::TargetKind::Purek
        } else {
            diagnostics::TargetKind::Generic
        },
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
    )
    .map(Arc::new);
    let result = if let Ok(trace) = &trace {
        let connection = trace.begin_connection();
        update(id, |state| state.trace = Some(trace.clone()));
        if cancel.is_cancelled() {
            Err(error("cancelled"))
        } else {
            play_session(
                context,
                id,
                renderer,
                (trace, connection),
                cancel,
                &stop,
                &mut room,
            )
            .await
        }
    } else {
        Err(error("cast_diagnostics_unavailable"))
    };
    stop.store(true, Ordering::Release);
    if let Some(room) = &mut room {
        let _ = room.release().await;
    }
    if let Ok(trace) = trace {
        trace.finish(cancel.is_cancelled());
    }
    restore(id, result.err().map(|error| error.code));
    let _ = with_app(|app| {
        app.native().cast.self_test_handoff_active = false;
        Ok(())
    });
}
/// Settings must stay unchanged this long before a file is regenerated, so
/// repeated pitch or delay steps cost one render and one receiver restart.
const REGENERATE_SETTLE: Duration = Duration::from_secs(1);

type Prefetch = (
    String,
    Arc<AtomicBool>,
    tokio::task::JoinHandle<Result<media::Prepared, ApiError>>,
);

async fn play_session(
    context: &Arc<HostContext>,
    id: u64,
    renderer: Renderer,
    diagnostic: (&SessionTrace, u64),
    cancel: &CancellationToken,
    stop: &Arc<AtomicBool>,
    room: &mut Option<purek::Session>,
) -> Result<(), ApiError> {
    let (trace, connection) = diagnostic;
    trace.renderer(&renderer);
    let mode = with_app(|app| {
        if app.native().cast.operation != id {
            return Err(error("cancelled"));
        }
        let key = preference_key(&renderer);
        let mut device = key
            .as_ref()
            .and_then(|key| app.cast_preferences().ok()?.devices.get(key))
            .cloned()
            .or_else(|| {
                app.native()
                    .cast
                    .session_devices
                    .get(&renderer_key(&renderer))
                    .cloned()
            })
            .unwrap_or_default();
        device.vendor_class = match renderer.description.vendor_class {
            crate::dlna::dlna_policy::VendorClass::Generic => {
                crate::app_state::cast::Vendor::Generic
            }
            crate::dlna::dlna_policy::VendorClass::Lebo => crate::app_state::cast::Vendor::Lebo,
            crate::dlna::dlna_policy::VendorClass::Dolphinstar => {
                crate::app_state::cast::Vendor::Dolphinstar
            }
        };
        let mode = device.effective_mode();
        if let Some(key) = &key {
            device.last_used = chrono::Utc::now().timestamp_millis().max(0) as u64;
            let revision = app.native_core_snapshot()?.revision;
            if app.cast_set_device(key, revision, device).is_err() {
                // Preference I/O is not a transport failure. Safe diagnostic log
                // is included by the Host diagnostic package, without raw keys.
                eprintln!("[cast] cast_preferences_write_failed; continuing connection");
                app.native_diagnostic(
                    &json!({"event":"cast_preferences_write_failed", "reason":"persistence_error"}),
                    now(),
                );
            }
        }
        let state = &mut app.native().cast;
        if state.operation != id {
            return Err(error("cancelled"));
        }
        state.selected = Some(renderer_key(&renderer));
        if !state
            .renderers
            .iter()
            .any(|r| renderer_key(r) == renderer_key(&renderer))
        {
            state.renderers.push(renderer.clone());
        }
        state.mode = mode;
        state.resume = None;
        Ok(mode)
    })?;
    let client = make_control(renderer.clone()).map_err(|e| error(e.code.as_str()))?;
    let address = url::Url::parse(&renderer.description.location)
        .ok()
        .and_then(|u| u.host_str()?.parse().ok())
        .ok_or_else(|| error("cast_renderer_unavailable"))?;
    #[cfg(test)]
    let test_endpoint = if renderer.local_address.is_loopback() {
        Some(crate::dlna::cast_http::diagnostic_fixture::bind(renderer.context.clone()).await)
    } else {
        None
    };
    #[cfg(not(test))]
    let test_endpoint: Option<CastEndpoint> = None;
    let endpoint = match test_endpoint {
        Some(e) => e,
        None => CastEndpoint::bind(
            address,
            renderer.context.clone(),
            ServerIdentity::new(std::env::consts::OS, env!("CARGO_PKG_VERSION"))
                .map_err(|_| error("cast_endpoint"))?,
        )
        .await
        .map_err(|_| error("cast_endpoint"))?,
    };
    let files = match CastSession::new(&context.cache_root, media::MAX_BYTES) {
        Ok(files) => Arc::new(files),
        Err(_) => {
            endpoint.shutdown().await;
            return Err(error("cast_prepare_failed"));
        }
    };
    let mut events = endpoint.subscribe();
    let mut output: Option<Output> = None;
    let mut output_ids = std::collections::BTreeMap::new();
    let mut prefetched: Option<Prefetch> = None;
    let mut attempted_output = false;
    let result = loop {
        let mut failure_stage = "media_preparation";
        let result = async {
        let position = with_app(|app| Ok(app.native().cast.position))?;
        if with_app(|app|Ok(app.native().cast.output_enabled && app.native_cast_input()?.current_item.is_some()))? {
        attempted_output = true;
        output = Some(
            start_output(
                OutputContext {
                    context,
                    id,
                    client: &client,
                    endpoint: &endpoint,
                    files: files.clone(),
                    trace,
                    connection,
                    cancel,
                    stop,
                },
                mode,
                position,
                None,
            )
            .await?,
        );
        }
        let mut monitor = TransportMonitor::default();
        let mut position_enabled = true;
        let mut poll_failures = 0u8;
        let mut last_response = Instant::now();
        let mut next_poll = Instant::now();
        let mut recovery: Option<Instant> = None;
        let mut stopped = 0u8;
        let mut health_at = Instant::now();
        loop {
            if cancel.is_cancelled() {
                break;
            }
            if let Some(room) = room.as_mut() {
                room.record_delivery(endpoint.diagnostics().bytes_written);
                if Instant::now() >= health_at {
                    if let Some(stage) = room.renew_announcement(cancel).await {
                        trace.purek(connection, &stage);
                    }
                    let health = room.poll_health(cancel).await;
                    trace.record_purek_operation(connection, &health);
                    health_at = Instant::now() + room.health_interval();
                    if !matches!(
                        health.result,
                        Ok(purek::HealthState::Online | purek::HealthState::Suspect)
                    ) {
                        record_room_failure(id, &health);
                        update(id, |s| {
                            let code = if matches!(health.result, Ok(purek::HealthState::IdentityChanged)) {
                                "purek_identity_changed".into()
                            } else {
                                s.room_failure.take().map(|f| f.0).unwrap_or_else(|| "purek_unavailable".into())
                            };
                            s.room_failure = Some((code, "health_check"));
                        });
                        return Err(error("cast_purek_unavailable"));
                    }
                }
            }
            let probe=with_app(|app|{
                let s=&mut app.native().cast;
                if matches!(s.control,Some(Control::Probe)){s.control=None;Ok(true)}else{Ok(false)}
            })?;
            if probe {
                query_capabilities(&client,id,trace,connection,output.as_ref().map(|o|o.id),cancel).await;
                update(id,|s|s.control_busy=false);
            }
            let enabled = with_app(|app| Ok(app.native().cast.output_enabled))?;
            if !enabled {
                if let Some(mut previous) = output.take() {
                    // Stop is best effort: a receiver fault must not revoke the room.
                    let _ = record(trace, connection, Some(previous.id), soap(client.stop(cancel)).await);
                    if let Some(live) = previous.live.take() { live.stop().await; }
                    endpoint.clear_generation();
                    trace.complete_output(previous.id, Default::default());
                    if let Some((_, stopping, _)) = &prefetched { stopping.store(true, Ordering::Release); }
                    let _ = take_prefetch(&mut prefetched, cancel).await;
                    with_app(|app| {
                        let snap = app.native_cast_input()?;
                        let s = &mut app.native().cast;
                        s.owns_playback = false;
                        s.l1 = false;
                        s.control = None;
                        s.control_busy = false;
                        s.resume = Some(json!({"playback_generation":snap.playback_generation,
                            "item_id":snap.current_item.as_ref().map(|i|&i.id),"position":s.position,
                            "is_paused":s.paused,"operation_id":id}));
                        projection::resume_local(app)?;
                        app.native().revision += 1;
                        Ok(())
                    })?;
                }
                update(id, |s| {s.phase = Phase::Active; s.owns_playback = false; s.l1 = false; s.control_busy = false;});
                // Keep the connection/room lease, but do not monitor the receiver
                // while output is off. Restart detects a receiver that went away.
                tokio::time::sleep(Duration::from_millis(30)).await;
                continue;
            }
            if output.is_none() {
                if with_app(|app|Ok(app.native_cast_input()?.current_item.as_ref().is_none_or(|i|i.cache_status!="ready")))? {
                    update(id,|s|{s.phase=Phase::Active;s.owns_playback=false;s.control_busy=false;});
                    tokio::time::sleep(Duration::from_millis(30)).await;continue;
                }
                let (position, mode, paused) = with_app(|app| {
                    let snap = app.native_snapshot(true)?;
                    let s = &mut app.native().cast;
                    s.owns_playback = true; s.resume = None;
                    s.paused = super::local_paused(s, &snap);
                    s.position = snap["player_status"]["current_time"].as_f64().unwrap_or(0.0);
                    app.native().revision += 1;
                    Ok((app.native().cast.position, app.native().cast.mode, app.native().cast.paused))
                })?;
                attempted_output = true;
                failure_stage = "media_preparation";
                output = Some(start_output(OutputContext { context, id, client: &client,
                    endpoint: &endpoint, files: files.clone(), trace, connection, cancel, stop },
                    mode, position, None).await?);
                update(id, |s| {
                    s.control = paused.then_some(Control::Pause);
                    s.control_busy = paused;
                });
                monitor = TransportMonitor::default(); poll_failures = 0;
                last_response = Instant::now(); stopped = 0; recovery = None;
            }
            if receiver_silent(last_response, poll_failures, Instant::now()) {
                let since = recovery.get_or_insert(last_response + RECEIVER_SILENCE);
                update(id, |s| { s.phase = Phase::Recovering; s.error_code = Some("cast_receiver_unreachable".into()); });
                if since.elapsed() >= RECOVERY_WINDOW { return Err(error("cast_receiver_unreachable")); }
            }
            let out = output.as_mut().unwrap();
            if let Some(live) = &mut out.live {
                failure_stage = "media_pipeline";
                live.check().await?;
            }
            output_ids.insert(out.generation, out.id);
            drain_http(trace, &mut events, &output_ids, Some((id, out)));
            let (snap, mut control, mode, audio_generation) = with_app(|app| {
                Ok((
                    app.native_cast_input()?,
                    app.native().cast.control.take(),
                    app.native().cast.mode,
                    app.native().cast.playback_generation,
                ))
            })?;
            // An L1 track switch keeps the program. The producer adopts it when
            // it renders the track (or nothing is streaming: Play rebuilds);
            // any other cached variant restarts the stream at the position.
            let mut track_restart = false;
            if out.l1
                && snap.playback_generation == audio_generation
                && let Some(item) = snap.current_item.as_ref().filter(|i|
                    i.item_incarnation_id == out.item.item_incarnation_id
                    && i.artifact_set_id == out.item.artifact_set_id) {
                if out.live.as_ref().is_none_or(|live| live.tracks.contains(&item.selected_audio_variant_id)) {
                    out.item.selected_audio_variant_id = item.selected_audio_variant_id.clone();
                    out.playback_generation = snap.playback_generation;
                } else {
                    track_restart = true;
                }
            }
            if track_restart {
                control = Some(Control::Restart);
                update(id, |s| s.control_busy = true);
            } else if snap.current_item.as_ref().is_none_or(|i| {
                i.item_incarnation_id != out.item.item_incarnation_id
                    || i.artifact_set_id != out.item.artifact_set_id
                    || i.selected_audio_variant_id != out.item.selected_audio_variant_id
            }) || snap.playback_generation != out.playback_generation
            {
                if snap.current_item.is_none() {
                    return Err(error(if snap.next_item.is_some() { "cast_no_current_item" } else { "cast_queue_finished" }));
                }
                control = Some(Control::ProgramChanged);
                update(id, |s| s.control_busy = true);
            }
            // File delivery renders pitch, delay and track into the file. A
            // differing Host setting regenerates it at the current position
            // once it has settled; a paused output regenerates on Play.
            let mut dsp_stale = false;
            if mode == Mode::File
                && out.l1
                && let Some(baked) = out.baked.clone()
            {
                match with_app(|app| Ok(media::Baked::current(app, &out.item)))?
                    .filter(|wanted| *wanted != baked)
                {
                    None => out.regenerate = None,
                    Some(wanted) => {
                        dsp_stale = true;
                        let settled = out.regenerate.as_ref().is_some_and(|(seen, since)| {
                            *seen == wanted && since.elapsed() >= REGENERATE_SETTLE
                        });
                        if out.regenerate.as_ref().is_none_or(|(seen, _)| *seen != wanted) {
                            out.regenerate = Some((wanted, Instant::now()));
                        } else if settled && control.is_none() && !out.paused {
                            control = Some(Control::Restart);
                            update(id, |s| s.control_busy = true);
                        }
                    }
                }
            }
            if let Some(control) = control {
                match control {
                    Control::Probe => { query_capabilities(&client,id,trace,connection,Some(out.id),cancel).await; }
                    Control::Pause if out.paused => {}
                    Control::Play if !out.paused => {}
                    Control::Pause if out.live.is_some() => {
                        let _ = record(trace, connection, Some(out.id), soap(client.stop(cancel)).await);
                        if let Some(live) = out.live.take() {
                            live.stop().await;
                        }
                        endpoint.clear_generation();
                        out.paused = true;
                        out.clock_running = false;
                        out.intentional_stop = true;
                        update(id, |s| {
                            s.paused = true;
                            s.receiver_state = Some("paused");
                        });
                    }
                    // Play with stale file settings rebuilds (the arm below).
                    Control::Pause | Control::Play
                        if mode == Mode::File
                            && !(dsp_stale && matches!(control, Control::Play)) =>
                    {
                        let pause = matches!(control, Control::Pause);
                        let action = if pause {
                            soap(client.pause(cancel)).await
                        } else {
                            soap(client.play(cancel)).await
                        };
                        match record(trace, connection, Some(out.id), action) {
                            Ok(()) => {
                                last_response = Instant::now();
                                poll_failures = 0;
                                out.paused = pause;
                                out.clock_running = !pause;
                                out.start = with_app(|app| Ok(app.native().cast.position))?;
                                out.began = Instant::now();
                                update(id, |s| {
                                    s.paused = pause;
                                    s.receiver_state =
                                        Some(if pause { "paused" } else { "playing" });
                                });
                            }
                            Err(e) => {
                                update(id, |s| s.error_code = Some(e.code));
                            }
                        }
                    }
                    // A paused live output has no stream (Pause stopped it):
                    // keep the target for the rebuild that Play performs.
                    Control::Seek(position) if mode == Mode::Live && out.paused => {
                        out.start = position;
                        update(id, |s| s.position = position);
                    }
                    Control::Seek(position) if mode == Mode::File => {
                        match record(
                            trace,
                            connection,
                            Some(out.id),
                            soap(client.seek(Duration::from_secs_f64(position), cancel)).await,
                        ) {
                            Ok(()) => {
                                last_response = Instant::now();
                                poll_failures = 0;
                                out.seek_settles = Instant::now() + Duration::from_secs(4);
                                out.last_position = None;
                                out.position_advanced = Instant::now();
                                out.start = position;
                                out.began = Instant::now();
                                update(id, |s| s.position = position);
                            }
                            Err(_) => {
                                update(id, |s| s.error_code = Some("cast_seek_unsupported".into()));
                            }
                        }
                    }
                    // A playing live seek restarts the producer at the target;
                    // the new stream reports its actual keyframe origin.
                    Control::Next | Control::ProgramChanged | Control::Restart | Control::Play | Control::Pause | Control::Seek(_) => {
                        let next = matches!(control, Control::Next | Control::ProgramChanged);
                        let retain_pause = matches!(control, Control::Restart) && out.paused;
                        let position = if let Control::Seek(target) = control {
                            target
                        } else if next {
                            if matches!(control, Control::Next) { advance(id, out.playback_generation)?; }
                            0.0
                        } else {
                            with_app(|app| Ok(app.native().cast.position))?
                        };
                        if let Some(live) = out.live.take() {
                            live.stop().await;
                        }
                        trace.complete_output(out.id, Default::default());
                        endpoint.clear_generation();
                        if let Some((key, stopping, _)) = &prefetched
                            && (!next || (matches!(control, Control::ProgramChanged) && snap.current_item.as_ref().is_none_or(|item| media_key(item) != *key))) {
                            stopping.store(true, Ordering::Release);
                        }
                        let cached = take_prefetch(&mut prefetched, cancel).await;
                        failure_stage = "media_preparation";
                        output = Some(
                            start_output(
                                OutputContext {
                                    context,
                                    id,
                                    client: &client,
                                    endpoint: &endpoint,
                                    files: files.clone(),
                                    trace,
                                    connection,
                                    cancel,
                                    stop,
                                },
                                mode,
                                position,
                                if next { cached } else { None },
                            )
                            .await?,
                        );
                        if retain_pause {
                            update(id, |s| {
                                s.control = Some(Control::Pause);
                                s.control_busy = true;
                            });
                        }
                        monitor = TransportMonitor::default();
                        position_enabled = true;
                        poll_failures = 0;
                        last_response = Instant::now();
                        stopped = 0;
                        recovery = None;
                    }
                }
                update(id, |s| s.control_busy = s.control.is_some());
                continue;
            }
            if prefetched.is_none()
                && mode == Mode::File
                && let Some(item) = snap
                    .next_item
                    .as_ref()
                    .filter(|i| i.cache_status == "ready")
            {
                let pre_stop = Arc::new(AtomicBool::new(false));
                prefetched = Some((
                    media_key(item),
                    pre_stop.clone(),
                    // Next songs usually start with neutral settings; a
                    // mismatch is rendered on demand when the song starts.
                    media::file(context.clone(), files.clone(), item.clone(), media::Baked::neutral(item), pre_stop),
                ));
            }
            if Instant::now() >= next_poll {
                next_poll = Instant::now() + Duration::from_secs(2);
                // T2 retains its 5s per-request bound. The session gives a
                // monitor RPC and a command 4s. Check pending commands every
                // 20ms; dropping a poll future aborts its HTTP request.
                let sample = tokio::select! {
                    biased;
                    _ = cancel.cancelled() => break,
                    _ = command_pending(id) => { next_poll = Instant::now(); continue; },
                    result = tokio::time::timeout(MONITOR_TIMEOUT, monitor.poll(&client, cancel)) =>
                        result.unwrap_or(MonitorSample { decision: MonitorDecision::TransientFailure, state: None, operation: None }),
                };
                if let Some(op) = &sample.operation {
                    trace.record_operation(Some(connection), Some(out.id), op);
                }
                let transport_failed = matches!(sample.decision, MonitorDecision::TransientFailure | MonitorDecision::Disconnected);
                if !transport_failed && sample.operation.is_some() {
                    last_response = Instant::now();
                }
                let old_position = with_app(|app| Ok(app.native().cast.position))?;
                // Freeze on the observation, before reading position or applying
                // the fallback clock. Keep the last credible position when a TV
                // resets RelTime on STOPPED; never add recovery time to resume.
                if let Some(state) = sample.state {
                    let running = clock_after_observation(out.clock_running, state);
                    if running != out.clock_running {
                        out.start = old_position;
                        out.began = Instant::now();
                    }
                    out.clock_running = running;
                }
                let mut position_failed = false;
                if position_enabled && !transport_failed && !out.intentional_stop {
                    let result = tokio::select! {
                        biased;
                        _ = cancel.cancelled() => break,
                        _ = command_pending(id) => { next_poll = Instant::now(); continue; },
                        result = tokio::time::timeout(MONITOR_TIMEOUT, client.get_position_info(cancel)) => result,
                    };
                    match result {
                        Ok(op) => {
                            if !op.result.as_ref().is_err_and(|e| e.is_network() || e.is_cancelled()) {
                                last_response = Instant::now();
                            }
                            trace.record_operation(Some(connection), Some(out.id), &op);
                            match op.result {
                                Ok(info) => {
                                    if let Some(d) = info.duration.filter(|d| !d.is_zero()) {
                                        let duration = d.as_secs_f64() + if mode == Mode::Live { out.receiver_origin } else { 0.0 };
                                        update(id, |s| s.duration = duration);
                                    }
                                    let position = info.position.map(|p| p.as_secs_f64());
                                    let advances = position.zip(out.last_position).is_none_or(|(p, old)| p > old);
                                    if advances { out.position_advanced = Instant::now(); }
                                    let usable = position.is_some_and(|p| p > 0.0 || info.duration.is_some_and(|d| !d.is_zero()))
                                        && (out.paused || out.position_advanced.elapsed() < Duration::from_secs(4));
                                    out.last_position = position;
                                    out.position_usable = usable;
                                    if usable {
                                        let p = position.unwrap() + if mode == Mode::Live { out.receiver_origin } else { 0.0 };
                                        // STOPPED often resets RelTime to zero: retain the
                                        // last credible position for recovery, never fake EOF.
                                        if p > 0.0 || !matches!(sample.state, Some(TransportState::Stopped | TransportState::NoMedia)) {
                                            update(id, |s| s.position = bounded_position(p, s.duration));
                                            if advances { out.start = p; out.began = Instant::now(); }
                                        }
                                    }
                                }
                                Err(e) if e.is_network() => position_failed = true,
                                Err(e) if !e.is_cancelled() => { position_enabled = false; out.position_usable = false; },
                                _ => {},
                            }
                        }
                        Err(_) => position_failed = true,
                    }
                }
                // A healthy transport with missing/constant position is not an
                // unreachable receiver. Use the actual keyframe clock for live.
                if !transport_failed && out.clock_running && !out.paused && (!position_enabled || !out.position_usable) {
                    update(id, |s| s.position = bounded_position(out.start + out.began.elapsed().as_secs_f64(), s.duration));
                }
                if transport_failed || (sample.decision == MonitorDecision::Disabled && position_failed) {
                    poll_failures = poll_failures.saturating_add(1);
                } else {
                    poll_failures = 0;
                }
                if let Some(state) = sample.state {
                    // Hardware controls are observations too: the receiver, not
                    // the last submitted API command, owns the pause state.
                    if matches!(state, TransportState::Playing | TransportState::Paused)
                        && out.paused != (state == TransportState::Paused)
                    {
                        out.paused = state == TransportState::Paused;
                        out.start = with_app(|app| Ok(app.native().cast.position))?;
                        out.began = Instant::now();
                        update(id, |s| s.paused = out.paused);
                    }
                    trace.transport(
                        out.id,
                        state,
                        Some(with_app(|app| Ok(app.native().cast.position))? > old_position),
                    );
                    update(id, |s| {
                        s.receiver_state = Some(match state {
                            TransportState::Playing => "playing",
                            TransportState::Paused => "paused",
                            TransportState::Stopped => "stopped",
                            TransportState::NoMedia => "no_media",
                            TransportState::Transitioning => "transitioning",
                            TransportState::Unknown => "unknown",
                        })
                    });
                    if state == TransportState::Playing {
                        out.seen_playing = true;
                        stopped = 0;
                    }
                    if !out.intentional_stop
                        && matches!(state, TransportState::Stopped | TransportState::NoMedia)
                    {
                        let (position, duration) = with_app(|app| {
                            Ok((app.native().cast.position, app.native().cast.duration))
                        })?;
                        if !out.paused && out.seen_playing
                            && Instant::now() >= out.seek_settles
                            && duration > 0.0
                            && position.max(old_position) >= duration - 3.0
                        {
                            update(id, |s| {
                                s.control = Some(Control::Next);
                                s.control_busy = true;
                            });
                            continue;
                        }
                        stopped = stopped.saturating_add(1);
                    }
                }
                let silent = receiver_silent(last_response, poll_failures, Instant::now());
                let failed = silent || stopped >= 3;
                if failed {
                    let since = recovery.get_or_insert(if silent { last_response + RECEIVER_SILENCE } else { Instant::now() });
                    update(id, |s| {
                        s.phase = Phase::Recovering;
                        s.error_code = Some("cast_receiver_unreachable".into());
                    });
                    if since.elapsed() >= RECOVERY_WINDOW {
                        return Err(error("cast_receiver_unreachable"));
                    }
                } else if poll_failures == 0 && stopped == 0
                {
                    recovery = None;
                    update(id, |s| {
                        s.phase = Phase::Active;
                        s.error_code = None;
                    });
                }
                if let Err(error) = with_app(|app| app.native_cast_observation(id, out.playback_generation))
                    && error.code != "stale_player" {
                    return Err(error);
                }
                if endpoint.diagnostics().bytes_written == 0
                    && out.began.elapsed() > Duration::from_secs(10)
                {
                    update(id, |s| {
                        s.error_code = Some(
                            if mode == Mode::File {
                                "cast_retry_live"
                            } else {
                                "cast_not_requested"
                            }
                            .into(),
                        )
                    });
                }
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
        Ok(())
    }
    .await;
        // Decision 7 / A5: a local mux/companion failure stops only output. Retire
        // its producer, prefetch and HTTP generation, then keep this same worker
        // maintaining the room lease and accepting probe/output/disconnect actions.
        // Receiver, authorization and cancellation errors still leave the session.
        if !cancel.is_cancelled() && result.as_ref().is_err_and(is_local_pipeline_failure) {
            if let Some((_, stopping, _)) = &prefetched {
                stopping.store(true, Ordering::Release);
            }
            let _ = take_prefetch(&mut prefetched, cancel).await;
            if let Some(mut previous) = output.take() {
                let _ = record(
                    trace,
                    connection,
                    Some(previous.id),
                    soap(client.stop(cancel)).await,
                );
                if let Some(live) = previous.live.take() {
                    live.stop().await;
                }
                output_ids.insert(previous.generation, previous.id);
                trace.complete_output(previous.id, Default::default());
            }
            endpoint.clear_generation();
            drain_http(trace, &mut events, &output_ids, None);
            attempted_output = false;
            if let Err(error) = suspend_failed_output(id, result.unwrap_err(), failure_stage) {
                break Err(error);
            }
            continue;
        }
        break result;
    };
    stop.store(true, Ordering::Release);
    if let Some((_, stop, _)) = &prefetched {
        stop.store(true, Ordering::Release);
    }
    let cleanup_resources = async {
        let _ = take_prefetch(&mut prefetched, cancel).await;
        if let Some(out) = &mut output {
            if let Some(live) = out.live.take() {
                live.stop().await;
            }
            trace.complete_output(out.id, Default::default());
        }
        endpoint.clear_generation();
        // A cancelled operation cannot leave a long SOAP Stop behind. Release has
        // its own bounded protocol timeout and runs concurrently below.
        // next can register a room before any song exists. That connection has
        // no media ownership and must not stop unrelated receiver playback.
        if attempted_output {
            let cleanup = CancellationToken::new();
            let timeout = cleanup.clone();
            let timer = tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(500)).await;
                timeout.cancel();
            });
            let _ = record(trace, connection, None, client.stop(&cleanup).await);
            timer.abort();
            let _ = timer.await;
        }
        let _ = endpoint.shutdown().await;
    };
    // Revoke immediately, concurrently with HTTP/producer cleanup. Do not stack
    // our Stop timeout in front of T9's independent three-second release budget.
    let release_room = async {
        if let Some(room) = room.as_mut() {
            let released = room.release().await;
            trace.record_purek_operation(connection, &released);
        }
    };
    tokio::join!(cleanup_resources, release_room);
    if let Some(out) = &output {
        output_ids.insert(out.generation, out.id);
    }
    drain_http(trace, &mut events, &output_ids, None);
    result
}

async fn take_prefetch(
    prefetch: &mut Option<Prefetch>,
    cancel: &CancellationToken,
) -> Option<(String, media::Prepared)> {
    let (key, stop, mut task) = prefetch.take()?;
    let result = tokio::select! {
        biased;
        _ = cancel.cancelled() => {
            stop.store(true, Ordering::Release);
            task.await
        },
        result = &mut task => result,
    };
    result.ok()?.ok().map(|file| (key, file))
}
fn advance(id: u64, generation: u64) -> Result<(), ApiError> {
    with_app(|app| {
        if app.native().cast.operation != id {
            return Err(error("cancelled"));
        }
        app.native().cast.worker_mutation = true;
        let result = app.native_execute(AppStateRequest::AdvanceToNext {
            schema_version: 1,
            expected_queue_version: None,
            expected_playback_generation: generation,
            reset_av_delay: false,
            now: now(),
        });
        app.native().cast.worker_mutation = false;
        result.map(|_| ())
    })
}

#[derive(Clone)]
struct OutputContext<'a> {
    context: &'a Arc<HostContext>,
    id: u64,
    client: &'a ControlClient,
    endpoint: &'a CastEndpoint,
    files: Arc<CastSession>,
    trace: &'a SessionTrace,
    connection: u64,
    cancel: &'a CancellationToken,
    stop: &'a Arc<AtomicBool>,
}
async fn start_output(
    resources: OutputContext<'_>,
    mode: Mode,
    mut position: f64,
    mut cached: Option<(String, media::Prepared)>,
) -> Result<Output, ApiError> {
    loop {
        let before = with_app(|app| app.native_cast_input())?;
        let result = start_output_once(resources.clone(), mode, position, cached.take()).await;
        let after = with_app(|app| app.native_cast_input())?;
        if resources.cancel.is_cancelled()
            || before.playback_generation == after.playback_generation
        {
            return result;
        }
        // A playlist edit can win while mux/Set/Play is in flight. Retire that
        // output and prepare the latest AppState program, retaining ownership.
        if let Ok(mut out) = result {
            if let Some(live) = out.live.take() {
                live.stop().await;
            }
            resources.trace.complete_output(out.id, Default::default());
        }
        resources.endpoint.clear_generation();
        position = 0.0;
    }
}

async fn start_output_once(
    resources: OutputContext<'_>,
    mode: Mode,
    position: f64,
    cached: Option<(String, media::Prepared)>,
) -> Result<Output, ApiError> {
    let OutputContext {
        context,
        id,
        client,
        endpoint,
        files,
        trace,
        connection,
        cancel,
        stop,
    } = resources;
    if cancel.is_cancelled() {
        return Err(error("cancelled"));
    }
    let snap = with_app(|app| app.native_cast_input())?;
    let item = snap
        .current_item
        .ok_or_else(|| error("cast_queue_finished"))?;
    if item.cache_status != "ready" {
        return Err(error("cast_media_unavailable"));
    }
    let generation = update(id, |s| {
        s.generation += 1;
        s.l1 = false;
        s.delivered = false;
        s.published_resume = None;
        s.playback_generation = snap.playback_generation;
        s.phase = Phase::Connecting;
        s.position = position;
        s.generation
    })
    .ok_or_else(|| error("cancelled"))?;
    let output_id = trace.begin_output(
        &client.renderer().context,
        OutputConfig {
            cell: None,
            mode: if mode == Mode::Live {
                diagnostics::Mode::Live
            } else {
                diagnostics::Mode::File
            },
            mime: diagnostics::Mime::Ts,
            preflight: Default::default(),
        },
    );
    for event in endpoint
        .diagnostics()
        .stages
        .iter()
        .filter(|e| e.stage == crate::dlna::cast_http::HttpStage::Listener)
    {
        trace.http_at(output_id, trace.elapsed(), event);
    }
    let mut live = None;
    // File delivery: what the published file renders, and why later DSP
    // edits cannot be rendered for this source.
    let mut file_profile: Option<(media::Baked, Option<&'static str>)> = None;
    let duration;
    let mut origin = position;
    let published = if mode == Mode::Live {
        let producer = media::live(
            context.clone(),
            item.clone(),
            position,
            (id, generation),
            cancel,
        )
        .await?;
        origin = producer.stream.snapshot().start.unwrap().source_start_us as f64 / 1_000_000.0;
        let publication = endpoint.publish_live(generation, producer.stream.clone(), TsMime::Mp2t);
        match publication {
            Ok(p) => {
                live = Some(producer);
                duration = item.selected_durations.first().copied().unwrap_or(0) as f64;
                p
            }
            Err(_) => {
                producer.stop().await;
                return Err(error("cast_publish_failed"));
            }
        }
    } else {
        // The Host settings this file must carry, read once at preparation;
        // later edits regenerate it (the run loop's debounce).
        let wanted = with_app(|app| Ok(media::Baked::current(app, &item)))?
            .unwrap_or_else(|| media::Baked::neutral(&item));
        let prepared = match cached.filter(|(key, prepared)| {
            *key == media_key(&item) && position == 0.0 && prepared.baked == wanted
        }) {
            Some((_, prepared)) => prepared,
            None => media::file(context.clone(), files, item.clone(), wanted, stop.clone())
                .await
                .map_err(|_| error("cast_prepare_failed"))??,
        };
        duration = prepared.file.summary.duration_us as f64 / 1_000_000.0
            + prepared.file.summary.source_start_us as f64 / 1_000_000.0;
        file_profile = Some((prepared.baked, prepared.refusal));
        endpoint
            .publish_file(generation, prepared.file, TsMime::Mp2t)
            .map_err(|_| error("cast_publish_failed"))?
    };
    let sinks = query_capabilities(client, id, trace, connection, Some(output_id), cancel).await;
    let mut started = record(
        trace,
        connection,
        Some(output_id),
        client
            .start(
                StartRequest {
                    uri: &published.uri,
                    title: &item.display_title,
                    file: published.length.map(|size| FileMetadata {
                        size,
                        duration: Duration::from_secs_f64(duration.max(0.0)),
                    }),
                    capabilities: CapabilityQuery::Known(sinks),
                },
                cancel,
            )
            .await,
    );
    if started.is_ok()
        && mode == Mode::File
        && position > 0.0
        && let Err(e) = record(
            trace,
            connection,
            Some(output_id),
            soap(client.seek(Duration::from_secs_f64(position), cancel)).await,
        )
    {
        started = Err(e);
    }
    if let Err(e) = started {
        if let Some(producer) = live {
            producer.stop().await;
        }
        endpoint.clear_generation();
        return Err(if mode == Mode::File && !cancel.is_cancelled() {
            error("cast_retry_live")
        } else {
            e
        });
    }
    if cancel.is_cancelled() {
        if let Some(producer) = live {
            producer.stop().await;
        }
        return Err(error("cancelled"));
    }
    let committed = with_app(|app| {
        if app.native().cast.operation != id {
            return Err(error("cancelled"));
        }
        app.native_execute(AppStateRequest::MarkCurrentItemStarted {
            schema_version: 1,
            item_id: item.id.clone(),
            now: now(),
        })?;
        Ok(())
    });
    if let Err(e) = committed {
        if let Some(producer) = live {
            producer.stop().await;
        }
        endpoint.clear_generation();
        return Err(e);
    }
    update(id, |s| {
        s.phase = Phase::Active;
        s.owns_playback = true;
        // L1 means the Host's DSP edits reach the receiver: applied live, or
        // rendered into a regenerated file.
        s.l1 = live.as_ref().is_some_and(|live| live.l1)
            || file_profile
                .as_ref()
                .is_some_and(|(_, refusal)| refusal.is_none());
        s.l1_refusal = live
            .as_ref()
            .and_then(|live| live.refusal)
            .or_else(|| file_profile.as_ref().and_then(|(_, refusal)| *refusal));
        s.connected = true;
        s.paused = false;
        s.duration = duration;
        s.position = origin;
        s.receiver_state = Some("playing");
        s.error_code = None;
    });
    Ok(Output {
        id: output_id,
        generation,
        item,
        playback_generation: snap.playback_generation,
        l1: live.as_ref().is_some_and(|live| live.l1)
            || file_profile
                .as_ref()
                .is_some_and(|(_, refusal)| refusal.is_none()),
        live,
        baked: file_profile.map(|(baked, _)| baked),
        regenerate: None,
        began: Instant::now(),
        start: origin,
        receiver_origin: origin,
        duration,
        paused: false,
        seen_playing: false,
        seek_settles: Instant::now(),
        last_position: None,
        position_advanced: Instant::now(),
        position_usable: false,
        clock_running: true,
        intentional_stop: false,
    })
}

fn bounded_position(position: f64, duration: f64) -> f64 {
    if duration > 0.0 {
        position.clamp(0.0, duration)
    } else {
        position.max(0.0)
    }
}

fn make_control(renderer: Renderer) -> Result<ControlClient, crate::dlna::DlnaError> {
    #[cfg(test)]
    if renderer.local_address.is_loopback() {
        return crate::dlna::session_fixture::control(renderer);
    }
    ControlClient::new(renderer)
}

async fn query_capabilities(
    client: &ControlClient,
    id: u64,
    trace: &SessionTrace,
    connection: u64,
    output: Option<u64>,
    cancel: &CancellationToken,
) -> Vec<String> {
    update(id, |s| s.capability_probe_running = true);
    let query = record(
        trace,
        connection,
        output,
        soap(client.get_protocol_info(cancel)).await,
    );
    let (state, error, sinks) = match query {
        Ok(sinks) => (
            if sinks.is_empty() {
                diagnostics::ProtocolState::Empty
            } else {
                diagnostics::ProtocolState::Reported
            },
            None,
            sinks,
        ),
        Err(error) => (
            diagnostics::ProtocolState::Unavailable,
            Some(error.code),
            Vec::new(),
        ),
    };
    if let Some(output) = output {
        trace.capabilities(
            output,
            state,
            &sinks,
            true,
            client.renderer().description.rendering_control.is_some(),
        );
    }
    update(id, |s| {
        s.capability_probe_running = false;
        s.protocol_state = Some(state);
        s.protocol_error = error;
        s.sink_protocols = sinks.clone();
    });
    sinks
}

fn record_room_failure<T>(id: u64, operation: &purek::PureKOperation<T>) {
    let failed = operation.stages.iter().rev().find(|s| {
        s.stage.result.is_err()
            && !matches!(s.phase, purek::Phase::Revoke | purek::Phase::Announcement)
    });
    // Health checks return a terminal HealthState, with the cause in their
    // stage list. Ignore later revoke errors when presenting that cause.
    let staged_error = failed.and_then(|s| {
        Some(purek::PureKError {
            code: s.error_code?,
            cause: s.stage.result.as_ref().err()?.clone(),
        })
    });
    let Some(error) = operation.result.as_ref().err().or(staged_error.as_ref()) else {
        return;
    };
    let stage = failed
        .map(|s| match s.phase {
            purek::Phase::Parse | purek::Phase::Resolve | purek::Phase::Route => "route",
            purek::Phase::DescriptionBefore => "description",
            purek::Phase::Register | purek::Phase::Revoke | purek::Phase::Announcement => {
                "authorization"
            }
            purek::Phase::Confirm => "revalidation",
            purek::Phase::Health => "health_check",
        })
        .unwrap_or("route");
    let code = super::super::purek::authorization_error(error).code;
    update(id, |s| {
        s.room_failure = Some((projection::legacy_error(&code).into(), stage))
    });
}

async fn load_renderer(location: &str, cancel: &CancellationToken) -> Operation<Renderer> {
    #[cfg(test)]
    if url::Url::parse(location).is_ok_and(|u| u.host_str() == Some("127.0.0.1")) {
        return discovery::diagnostic_fixture::load(location, cancel).await;
    }
    discovery::load_renderer(location, cancel).await
}

async fn connect_room(
    qr: &str,
    confirmed: bool,
    cancel: &CancellationToken,
) -> purek::PureKOperation<purek::Session> {
    #[cfg(test)]
    if purek::diagnostic_fixture::parse(qr)
        .is_ok_and(|room| room.description_url().host_str() == Some("127.0.0.1"))
    {
        return purek::diagnostic_fixture::client()
            .connect(
                qr,
                if confirmed {
                    purek::AddressApproval::ConfirmHostname
                } else {
                    purek::AddressApproval::LanLiteralOnly
                },
                cancel,
            )
            .await;
    }
    purek::PureKClient::new()
        .connect(
            qr,
            if confirmed {
                purek::AddressApproval::ConfirmHostname
            } else {
                purek::AddressApproval::LanLiteralOnly
            },
            cancel,
        )
        .await
}

fn media_key(item: &PlaylistItem) -> String {
    format!(
        "{}:{}:{}",
        item.item_incarnation_id, item.artifact_set_id, item.selected_audio_variant_id
    )
}

async fn command_pending(id: u64) {
    loop {
        if with_app(|app| {
            let cast = &app.native().cast;
            Ok(cast.operation != id
                || cast.control.is_some()
                || cast.output_enabled != cast.owns_playback)
        })
        .unwrap_or(true)
        {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
async fn soap<T>(future: impl std::future::Future<Output = Operation<T>>) -> Operation<T> {
    // Controls must tolerate the same slow replies as monitoring. A timeout
    // drops this request future before the worker accepts the next command.
    tokio::time::timeout(MONITOR_TIMEOUT, future)
        .await
        .unwrap_or_else(|_| Operation {
            result: Err(crate::dlna::DlnaError {
                code: crate::dlna::ErrorCode::Timeout,
                http_status: None,
                upnp_code: None,
            }),
            stages: Vec::new(),
            dropped_stages: 0,
        })
}
fn drain_http(
    trace: &SessionTrace,
    events: &mut tokio::sync::broadcast::Receiver<HttpStageResult>,
    outputs: &std::collections::BTreeMap<u64, u64>,
    current: Option<(u64, &Output)>,
) {
    loop {
        match events.try_recv() {
            Ok(event) => {
                if let Some(output) = event.generation.and_then(|g| outputs.get(&g)) {
                    trace.http_at(*output, trace.elapsed(), &event);
                    if let Some((id, out)) = current
                        && out.generation == event.generation.unwrap_or(0)
                        && event.bytes_written > 0
                    {
                        update(id, |s| s.delivered = true);
                    }
                    if let Some((id, out)) = current
                        && out.generation == event.generation.unwrap_or(0)
                        && !out.position_usable
                        && !out.paused
                        && out.clock_running
                        && out.live.is_some()
                        && let (Some(start), Some(dts)) = (event.live_start, event.media_time_us)
                    {
                        let position = out.receiver_origin
                            + presentation_elapsed(start, dts)
                                .min(out.began.elapsed().as_secs_f64());
                        update(id, |s| {
                            s.position = bounded_position(position, out.duration)
                        });
                    }
                }
            }
            Err(tokio::sync::broadcast::error::TryRecvError::Lagged(n)) => trace.lagged(n),
            Err(_) => break,
        }
    }
}

fn presentation_elapsed(start: crate::experimental_libav::cast_mux::CastStart, dts: i64) -> f64 {
    // T4 reports DTS, relative to timestamp_origin_us. Use T3's actual initial
    // PTS/DTS separation rather than assuming two B frames at 30 fps (66.7ms).
    // This is a delivery watermark, NOT the receiver clock; cap it by wall
    // time and use actual source_start_us for receiver RelTime and resume.
    let reorder = if start.has_b_frames {
        start
            .source_start_us
            .saturating_sub(start.timestamp_origin_us)
            .max(0)
    } else {
        0
    };
    start
        .timestamp_origin_us
        .saturating_add(dts)
        .saturating_add(reorder)
        .saturating_sub(start.source_start_us)
        .max(0) as f64
        / 1_000_000.0
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn receiver_liveness_uses_success_clock_not_failure_count() {
        let start = Instant::now();
        // Many immediate failures cannot accelerate the silence allowance.
        assert!(!receiver_silent(start, 20, start + Duration::from_secs(7)));
        assert!(receiver_silent(start, 2, start + Duration::from_secs(8)));
        // A successful response, even on a slow receiver, starts a new window.
        let success = start + Duration::from_millis(7500);
        assert!(!receiver_silent(
            success,
            1,
            start + Duration::from_secs(12)
        ));
        assert!(receiver_silent(success, 1, success + RECEIVER_SILENCE));
        // Unsupported monitors are disabled, not treated as network failures.
        assert!(!receiver_silent(start, 0, start + Duration::from_secs(60)));
        for state in [
            TransportState::Paused,
            TransportState::Stopped,
            TransportState::NoMedia,
            TransportState::Transitioning,
        ] {
            assert!(!clock_after_observation(true, state));
        }
        assert!(clock_after_observation(false, TransportState::Playing));
        for running in [false, true] {
            assert_eq!(
                clock_after_observation(running, TransportState::Unknown),
                running
            );
        }
    }
    #[test]
    fn lagged_and_terminal_http_events_reach_cast_diagnostic_package() {
        use crate::dlna::cast_http::{HttpStage, Reason};
        use base64::Engine;
        use std::io::Read;
        let renderer = crate::dlna::session_fixture::renderer(
            "http://127.0.0.1:12345/description",
            "<root><device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType><UDN>uuid:cast-fixture</UDN><serviceList><service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/av</controlURL></service></serviceList></device></root>",
        );
        let trace = SessionTrace::new(platform(), diagnostics::TargetKind::Generic, "test", "test")
            .unwrap();
        let output = trace.begin_output(
            &renderer.context,
            OutputConfig {
                cell: None,
                mode: diagnostics::Mode::File,
                mime: diagnostics::Mime::Ts,
                preflight: Default::default(),
            },
        );
        let (tx, mut rx) = tokio::sync::broadcast::channel(2);
        let mut event = HttpStageResult {
            stage: HttpStage::Get,
            context: renderer.context,
            generation: Some(1),
            connection_id: 1,
            elapsed: Duration::ZERO,
            http_status: Some(200),
            result: Ok(()),
            bytes_written: 188,
            disconnect_reason: None,
            media_time_us: None,
            live_start: None,
        };
        for _ in 0..3 {
            tx.send(event.clone()).unwrap();
        }
        event.stage = HttpStage::Disconnect;
        event.disconnect_reason = Some(Reason::Completed);
        tx.send(event).unwrap();
        drop(tx);
        drain_http(&trace, &mut rx, &[(1, output)].into(), None);
        trace.finish(false);
        let report = trace.report();
        assert_eq!(report.diagnostics()["cast"]["delivery_lagged_stages"], 2);
        assert!(report.json().contains("http.disconnect"));
        assert!(report.json().contains("completed"));
        let request: crate::DiagnosticRequest = serde_json::from_value(json!({"app_home":".tmp/no-data", "log_dir":".tmp/no-logs", "system":{}, "tools_and_tasks":{}, "cache_policy":{}, "runtime_state":{}, "connectivity_override":{}})).unwrap();
        let artifact = crate::native_host::diagnostics::assemble(&request, Some(&report)).unwrap();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(artifact.zip_base64)
            .unwrap();
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let mut content = String::new();
        zip.by_name("diagnostics.cast.json")
            .unwrap()
            .read_to_string(&mut content)
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&content).unwrap()["diagnostics"]["cast"]["delivery_lagged_stages"],
            2
        );
        assert!(!content.contains("127.0.0.1"));
        assert!(zip.by_name("diagnostics.cast.txt").is_ok());
        let plain = crate::native_host::diagnostics::assemble(&request, None).unwrap();
        assert!(!plain.files.contains_key("diagnostics.cast.json"));
    }
    #[test]
    fn actual_keyframe_origin_and_variable_dts_offset_preserve_resume_position() {
        for offset in [33_333, 66_667, 80_000] {
            let mut start = crate::experimental_libav::cast_mux::CastStart {
                source_start_us: 20_000_000,
                timestamp_origin_us: 20_000_000 - offset,
                profile: 100,
                level: 40,
                width: 1920,
                height: 1080,
                has_b_frames: true,
                audio_transcoded: false,
            };
            let actual_origin = start.source_start_us as f64 / 1_000_000.0;
            assert_eq!(actual_origin + presentation_elapsed(start, 5_000_000), 25.0);
            assert_eq!(actual_origin + 5.0, 25.0); // receiver RelTime; requested seek was 21s
            start.has_b_frames = false;
            assert!(
                (presentation_elapsed(start, 5_000_000) - (5.0 - offset as f64 / 1_000_000.0))
                    .abs()
                    < 0.000_001
            );
        }
        assert_eq!(bounded_position(125.0, 120.0), 120.0);
        assert_eq!(bounded_position(125.0, 0.0), 125.0);
    }
}
