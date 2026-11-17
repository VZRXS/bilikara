use super::*;
use crate::dlna::{
    self, DeviceContext, DiscoverySource,
    cast_http::{self, CastEndpoint, HttpStage},
    control::ControlClient,
    discovery, purek,
};
use crate::experimental_libav::cast_mux::{CastFile, CastSession};
use diag::{SelfTestStage as Stage, StageOutcome as Outcome};
use std::{collections::HashSet, time::Instant};

#[derive(Clone, Copy)]
pub(crate) struct Timing {
    pub scan_before: Duration,
    pub scan_after: Duration,
    pub playback: Duration,
    pub question_after: Duration,
    pub answer_timeout: Duration,
    pub between: Duration,
    pub poll: Duration,
    pub handoff_timeout: Duration,
}
impl Default for Timing {
    fn default() -> Self {
        Self {
            scan_before: Duration::from_secs(15),
            scan_after: Duration::from_secs(5),
            playback: Duration::from_secs(20),
            question_after: Duration::from_secs(15),
            answer_timeout: Duration::from_secs(60),
            between: Duration::from_secs(2),
            poll: Duration::from_secs(2),
            handoff_timeout: Duration::from_secs(60),
        }
    }
}

fn begin(generation: u64, stage: Stage) -> Instant {
    update(generation, |s| {
        s.stage = Some(stage);
        s.question = false;
    });
    Instant::now()
}
fn step(
    trace: &SessionTrace,
    stage: Stage,
    since: Instant,
    outcome: Outcome,
    cancel: &CancellationToken,
) {
    trace.self_test_step(diag::SelfTestStep {
        stage,
        outcome: if cancel.is_cancelled() {
            Outcome::Cancelled
        } else {
            outcome
        },
        elapsed_ms: since.elapsed().as_millis() as u64,
    });
}
fn refresh_android_network(
    generation: u64,
    trace: &SessionTrace,
    environment: &mut diag::Environment,
) {
    if !cfg!(target_os = "android") && !crate::cast_platform::has_platform_state() {
        return;
    }
    let facts = crate::cast_platform::network_facts();
    environment.network_hint = facts.network_hint();
    environment.android_network = Some(facts.clone());
    trace.environment(environment.clone());
    let _ = with_app(|app| {
        if app.native().cast.self_test.generation == generation {
            app.native().cast.network_facts = facts;
            app.native().revision += 1;
        }
        Ok(())
    });
}
async fn scan(
    trace: &SessionTrace,
    connection: u64,
    window: Duration,
    cancel: &CancellationToken,
) -> Vec<Renderer> {
    #[cfg(test)]
    if window.is_zero() {
        return Vec::new();
    }
    let child = cancel.child_token();
    let mut found = Vec::new();
    {
        let scan = discovery::discover(&child, |event| {
            trace.discovery(connection, &event);
            if let discovery::DiscoveryUpdate::Renderers(renderers) = event {
                found = renderers;
            }
        });
        tokio::pin!(scan);
        tokio::select! {
            _=&mut scan=>{},
            _=tokio::time::sleep(window)=>{child.cancel();let _=scan.await;},
        }
    }
    found
}

pub(in crate::native_host::cast_session) fn identity_match<'a>(
    target: &Renderer,
    devices: &'a [Renderer],
) -> Option<&'a DeviceContext> {
    // Never equate T2 and T9 salts, or assume two missing UDNs identify a device.
    let key = preference_key(target)?;
    devices
        .iter()
        .find(|r| preference_key(r).as_ref() == Some(&key))
        .map(|r| &r.context)
}

pub(super) struct Handoff {
    pub renderer: Renderer,
    pub room: Option<purek::Session>,
}

pub(super) async fn run(
    context: Arc<HostContext>,
    generation: u64,
    request: Request,
    trace: Arc<SessionTrace>,
    cancel: CancellationToken,
    mut answers: mpsc::Receiver<AnswerEnvelope>,
    timing: Timing,
) -> Option<Handoff> {
    let connection = trace.begin_connection();
    let since = begin(generation, Stage::S0);
    // S0 only observes. S1/S3 fill in this run's actual multicast result;
    // acquiring a diagnostic-only lock here would extend the lease boundary.
    let android_network =
        if cfg!(target_os = "android") || crate::cast_platform::has_platform_state() {
            let mut facts = crate::cast_platform::network_facts();
            facts.multicast_acquired = None;
            let _ = with_app(|app| {
                if app.native().cast.self_test.generation == generation {
                    app.native().cast.network_facts = facts.clone();
                    app.native().revision += 1;
                }
                Ok(())
            });
            Some(facts)
        } else {
            None
        };
    let (_sample_lease, sample_b) = samples::load_uniform(context.clone()).await;
    let companion =
        tokio::task::spawn_blocking(|| media::probe().is_ok_and(|p| p.cast_mux_available()))
            .await
            .unwrap_or(false);
    let route = request.renderer.as_ref().map(|r| r.local_address);
    let (profile, profile_reason) =
        tokio::task::spawn_blocking(move || network_profile::query(route))
            .await
            .unwrap_or((
                diag::NetworkProfile::Unavailable,
                Some(diag::NetworkProfileReason::QueryFailed),
            ));
    let mut environment = diag::Environment {
        network_hint: android_network
            .as_ref()
            .and_then(|facts| facts.network_hint()),
        android_network,
        sample_b_verified: Some(sample_b.is_ok()),
        companion_mpegts: Some(companion),
        companion_annexb: Some(companion),
        companion_aac: Some(companion),
        windows_network_type: Some(profile),
        windows_network_reason: profile_reason,
        ..Default::default()
    };
    let interfaces = crate::networking::local_interfaces();
    environment.interface_kinds = interfaces
        .iter()
        .map(|i| match i.interface_type.as_str() {
            "ethernet" => diag::InterfaceKind::Ethernet,
            "wifi" | "hotspot" => diag::InterfaceKind::Wireless,
            "virtual" | "container" => diag::InterfaceKind::Virtual,
            "tunnel" => diag::InterfaceKind::Tun,
            _ => diag::InterfaceKind::Other,
        })
        .collect();
    environment.vpn_or_tun = environment
        .android_network
        .as_ref()
        .and_then(|f| f.vpn_active)
        .or_else(|| Some(interfaces.iter().any(|i| i.interface_type == "tunnel")));
    trace.environment(environment.clone());
    step(&trace, Stage::S0, since, Outcome::Complete, &cancel);

    let since = begin(generation, Stage::S1);
    let before = scan(&trace, connection, timing.scan_before, &cancel).await;
    refresh_android_network(generation, &trace, &mut environment);
    let scan_duration = since.elapsed();
    step(&trace, Stage::S1, since, Outcome::Complete, &cancel);
    let mut target = request.renderer;
    let mut room = None;
    let mut after = Vec::new();
    let since = begin(generation, Stage::S2);
    let approval = if request.confirmed {
        purek::AddressApproval::ConfirmHostname
    } else {
        purek::AddressApproval::LanLiteralOnly
    };
    let purek_client = purek_client(target.as_ref());
    let parsed = request
        .qr
        .as_ref()
        .map(|qr| parse_room(qr, target.as_ref()));
    if parsed.as_ref().is_some_and(Result::is_err) {
        // T9 supplies only presence/category facts, even for rejected QR input.
        let operation = purek_client
            .connect(request.qr.as_deref().unwrap(), approval, &cancel)
            .await;
        trace.record_purek_operation(connection, &operation);
    }
    step(
        &trace,
        Stage::S2,
        since,
        match &parsed {
            None => Outcome::Skipped,
            Some(Ok(_)) => Outcome::Complete,
            Some(Err(_)) => Outcome::Failed,
        },
        &cancel,
    );
    let since = begin(generation, Stage::S3);
    if let Some(qr) = request
        .qr
        .filter(|_| parsed.as_ref().is_some_and(Result::is_ok))
    {
        // connect records parse failures too; all T9 work obeys the same token.
        let operation = purek_client.connect(&qr, approval, &cancel).await;
        trace.record_purek_operation(connection, &operation);
        let registered = operation.result.is_ok();
        if let Ok(session) = operation.result {
            target = session.renderer().ok().or(target);
            room = Some(session);
        } else if let Some(Ok(parsed)) = parsed {
            let inspected = purek_client.inspect(parsed, approval, &cancel).await;
            trace.record_purek_operation(connection, &inspected);
            if let Ok(session) = inspected.result {
                target = session.renderer().ok().or(target);
                room = Some(session);
            }
        }
        update(generation, |s| {
            s.registered = registered;
            s.registration_attempted = true;
        });
        after = scan(&trace, connection, timing.scan_after, &cancel).await;
        refresh_android_network(generation, &trace, &mut environment);
        step(
            &trace,
            Stage::S3,
            since,
            if registered {
                Outcome::Complete
            } else {
                Outcome::Failed
            },
            &cancel,
        );
    } else {
        step(&trace, Stage::S3, since, Outcome::Skipped, &cancel);
    }
    // No automatic selection among multiple unrelated receivers.
    if target.is_none() && before.len() == 1 {
        target = before.first().cloned();
    }
    if let Some(renderer) = &target {
        let local = renderer.local_address;
        let (profile, reason) =
            tokio::task::spawn_blocking(move || network_profile::query(Some(local)))
                .await
                .unwrap_or((
                    diag::NetworkProfile::Unavailable,
                    Some(diag::NetworkProfileReason::QueryFailed),
                ));
        environment.windows_network_type = Some(profile);
        environment.windows_network_reason = reason;
        trace.renderer(renderer);
        let matched_before = identity_match(renderer, &before);
        let matched_after = identity_match(renderer, &after);
        trace.discovery_facts(
            connection,
            scan_duration,
            Some(matched_before.is_some()),
            room.as_ref().map(|_| matched_after.is_some()),
        );
        trace.discovery_target_facts(connection, &renderer.context, matched_before, matched_after);
        if let Ok(url) = url::Url::parse(&renderer.description.location)
            && let Some(url::Host::Ipv4(ip)) = url.host()
        {
            environment.same_subnet_24 =
                Some(ip.octets()[..3] == renderer.local_address.octets()[..3]);
            environment.exit_address_class = Some(diag::address_class(renderer.local_address));
        }
        trace.environment(environment);
        let _ = with_app(|app| {
            let cast = &mut app.native().cast;
            if cast.self_test.generation == generation {
                cast.selected = Some(renderer_key(renderer));
                if !cast
                    .renderers
                    .iter()
                    .any(|r| renderer_key(r) == renderer_key(renderer))
                {
                    cast.renderers.push(renderer.clone());
                }
                cast.self_test.preferences_persisted = preference_key(renderer).is_some();
                app.native().revision += 1;
            }
            Ok(())
        });
    } else {
        trace.discovery_facts(connection, scan_duration, None, None);
    }
    // Revoke immediately when cancellation arrives, concurrently with media
    // teardown. Await this owned task at S7; never leave a registration behind.
    let (release_requested, requested) = tokio::sync::oneshot::channel();
    let cancelled = cancel.clone();
    let releasing_trace = trace.clone();
    let release = tokio::spawn(async move {
        let keep = tokio::select! {biased; _=cancelled.cancelled()=>false, choice=requested=>choice.unwrap_or(false)};
        if keep && !cancelled.is_cancelled() {
            return room;
        }
        if let Some(room) = &mut room {
            let operation = room.release().await;
            releasing_trace.record_purek_operation(connection, &operation);
        }
        None
    });
    let since = begin(generation, Stage::S4);
    let control = target.as_ref().and_then(|r| make_control(r.clone()).ok());
    let mut protocol = diag::ProtocolState::NotChecked;
    let mut sinks = Vec::new();
    let mut baseline = None;
    if let Some(client) = &control {
        let operation = client.get_protocol_info(&cancel).await;
        trace.record_operation(Some(connection), None, &operation);
        match operation.result {
            Ok(values) => {
                protocol = if values.is_empty() {
                    diag::ProtocolState::Empty
                } else {
                    diag::ProtocolState::Reported
                };
                sinks = values;
            }
            Err(_) => protocol = diag::ProtocolState::Unavailable,
        }
        let operation = client.get_transport_info(&cancel).await;
        trace.record_operation(Some(connection), None, &operation);
        baseline = operation.result.ok();
    }
    step(
        &trace,
        Stage::S4,
        since,
        if control.is_some() {
            Outcome::Complete
        } else {
            Outcome::Skipped
        },
        &cancel,
    );

    let since = begin(generation, Stage::S5);
    let session = CastSession::new(&context.cache_root, media::MAX_BYTES)
        .map(Arc::new)
        .ok();
    let a = if let Some(session) = &session {
        samples::prepare(context.clone(), session.clone(), None, &cancel).await
    } else {
        Err(SkipReason::SamplePreparationFailed)
    };
    let b = match (&session, sample_b) {
        (Some(session), Ok(bytes)) => {
            samples::prepare(context.clone(), session.clone(), Some(bytes), &cancel).await
        }
        (_, Err(reason)) => Err(reason),
        _ => Err(SkipReason::SamplePreparationFailed),
    };
    if let Ok(sample) = &a {
        trace.sample(diag::Variant::A, sample.facts.clone());
    }
    if let Ok(sample) = &b {
        trace.sample(diag::Variant::B, sample.facts.clone());
    }
    step(
        &trace,
        Stage::S5,
        since,
        if a.is_ok() || b.is_ok() {
            Outcome::Complete
        } else {
            Outcome::Failed
        },
        &cancel,
    );

    let since = begin(generation, Stage::S6);
    let unknown = DeviceContext {
        device_key: "no-receiver".into(),
        udn_hash: None,
        source: DiscoverySource::Manual,
        server: String::new(),
        route: None,
    };
    let device = target.as_ref().map(|r| &r.context).unwrap_or(&unknown);
    let mut visible = false;
    let mut sync_asked = false;
    for cell in [
        Cell::FileA,
        Cell::FileB,
        Cell::LiveA,
        Cell::LiveB,
        Cell::FileMp4A,
    ] {
        update(generation, |s| {
            s.cell = Some(cell);
            s.question = false;
        });
        let sample = if matches!(cell, Cell::FileB | Cell::LiveB) {
            &b
        } else {
            &a
        };
        let mode = match cell {
            Cell::LiveA | Cell::LiveB => diag::Mode::Live,
            Cell::FileMp4A => diag::Mode::FileMp4,
            _ => diag::Mode::File,
        };
        let output = trace.begin_output(
            device,
            diag::OutputConfig {
                cell: Some(cell),
                mode,
                mime: if cell == Cell::FileMp4A {
                    diag::Mime::Mp4
                } else {
                    diag::Mime::Ts
                },
                preflight: sample.as_ref().map(|s| s.facts.clone()).unwrap_or_default(),
            },
        );
        trace.capabilities(
            output,
            protocol,
            &sinks,
            control.is_some(),
            target
                .as_ref()
                .is_some_and(|r| r.description.rendering_control.is_some()),
        );
        if let Some(state) = baseline {
            trace.transport(output, state, None);
        }
        let skip = if cancel.is_cancelled() {
            Some(SkipReason::Cancelled)
        } else if cell == Cell::FileMp4A && visible {
            Some(SkipReason::NotNeeded)
        } else if matches!(cell, Cell::FileB | Cell::LiveB) && sample.is_err() {
            // Preserve the offline sample failure even without a receiver. A
            // storage/copy failure must explain only B; A keeps its own result.
            sample.as_ref().err().copied()
        } else if control.is_none() {
            Some(SkipReason::NoReceiver)
        } else {
            sample.as_ref().err().copied()
        };
        if let Some(reason) = skip {
            trace.skip_output(output, reason);
            continue;
        }
        let sample = sample.as_ref().unwrap();
        let file = if matches!(cell, Cell::LiveA | Cell::LiveB) {
            Ok(Media::Live(sample.clone()))
        } else {
            samples::remux(
                session.as_ref().unwrap().clone(),
                sample.clone(),
                if cell == Cell::FileMp4A {
                    crate::experimental_libav::cast_mux::CastFormat::Mp4
                } else {
                    crate::experimental_libav::cast_mux::CastFormat::Ts
                },
                &cancel,
            )
            .await
            .map(Media::File)
        };
        let file = match file {
            Ok(file) => file,
            Err(reason) => {
                trace.skip_output(output, reason);
                continue;
            }
        };
        let answer = play_cell(
            control.as_ref().unwrap(),
            &trace,
            connection,
            output,
            cell,
            file,
            &cancel,
            &mut answers,
            timing,
            |question| {
                update(generation, |s| {
                    s.question = question;
                    s.question_id = output;
                    s.question_deadline_ms = question.then(|| {
                        chrono::Utc::now().timestamp_millis()
                            + timing.answer_timeout.as_millis() as i64
                    });
                    s.ask_sync = !sync_asked;
                })
            },
        )
        .await;
        let picture = matches!(
            answer.video,
            diag::VideoAnswer::Normal | diag::VideoAnswer::Stuttering
        );
        visible |= picture;
        sync_asked |= picture;
        trace.complete_output(output, answer);
        tokio::select! {_ = cancel.cancelled()=>{},_ = tokio::time::sleep(timing.between)=>{}}
    }
    step(&trace, Stage::S6, since, Outcome::Complete, &cancel);
    let since = begin(generation, Stage::S7);
    let keep = if target.is_some() && !cancel.is_cancelled() {
        let (send, receive) = tokio::sync::oneshot::channel();
        update(generation, |s| s.handoff = Some(send));
        let keep = tokio::select! {biased; _=cancel.cancelled()=>false, value=tokio::time::timeout(timing.handoff_timeout, receive)=>matches!(value, Ok(Ok(true)))};
        update(generation, |s| s.handoff = None);
        keep
    } else {
        false
    };
    let _ = release_requested.send(keep);
    let stop = async {
        if let Some(client) = &control {
            let cleanup = CancellationToken::new();
            let operation =
                tokio::time::timeout(Duration::from_secs(2), client.stop(&cleanup)).await;
            if let Ok(operation) = operation {
                trace.record_operation(Some(connection), None, &operation);
            }
        }
    };
    let (retained, ()) = tokio::join!(release, stop);
    let room = retained.ok().flatten();
    if !cancel.is_cancelled()
        && let Some(renderer) = &target
    {
        learn(generation, renderer, &trace);
    }
    step(&trace, Stage::S7, since, Outcome::Complete, &cancel);
    if keep {
        target.map(|renderer| Handoff { renderer, room })
    } else {
        None
    }
}

fn make_control(renderer: Renderer) -> Result<ControlClient, dlna::DlnaError> {
    #[cfg(test)]
    if renderer.local_address.is_loopback() {
        return dlna::session_fixture::control(renderer);
    }
    ControlClient::new(renderer)
}

fn purek_client(_target: Option<&Renderer>) -> purek::PureKClient {
    #[cfg(test)]
    if _target.is_some_and(|r| r.local_address.is_loopback()) {
        return purek::diagnostic_fixture::client();
    }
    purek::PureKClient::new()
}
fn parse_room(qr: &str, _target: Option<&Renderer>) -> Result<purek::Room, purek::PureKError> {
    #[cfg(test)]
    if _target.is_some_and(|r| r.local_address.is_loopback()) {
        return purek::diagnostic_fixture::parse(qr);
    }
    purek::Room::parse(qr)
}

#[derive(Default)]
struct Requests {
    active: HashSet<u64>,
    mismatched: HashSet<u64>,
    maximum: u64,
    replaced: HashSet<u64>,
    last_byte_ms: Option<u64>,
    seen: bool,
    all_match: bool,
    lost: bool,
}
impl Requests {
    fn event(&mut self, event: &cast_http::HttpStageResult, origin: Duration) {
        if matches!(
            event.stage,
            HttpStage::FirstByte | HttpStage::BytesWritten | HttpStage::Disconnect
        ) && event.bytes_written > 0
        {
            let at = (origin + event.elapsed).as_millis() as u64;
            self.last_byte_ms = Some(self.last_byte_ms.map_or(at, |previous| previous.max(at)));
        }
        match event.stage {
            HttpStage::PeerMismatch => {
                self.mismatched.insert(event.connection_id);
            }
            HttpStage::Get => {
                let matched = !self.mismatched.contains(&event.connection_id);
                self.all_match = if self.seen {
                    self.all_match && matched
                } else {
                    matched
                };
                self.seen = true;
                self.active.insert(event.connection_id);
                self.maximum = self.maximum.max(self.active.len() as u64);
            }
            HttpStage::Disconnect => {
                if event.disconnect_reason == Some(cast_http::Reason::Replaced) {
                    self.replaced.insert(event.connection_id);
                }
                self.active.remove(&event.connection_id);
                self.mismatched.remove(&event.connection_id);
            }
            _ => {}
        }
    }
    fn finish(self) -> diag::RequestObservations {
        diag::RequestObservations {
            source_matches_description: (!self.lost && self.seen).then_some(self.all_match),
            source_same_subnet_24: (!self.lost && self.seen && self.all_match).then_some(true),
            maximum_concurrent_get: (!self.lost).then_some(self.maximum),
            over_client_limit: (!self.lost).then_some(self.replaced.len() as u64),
            last_byte_ms: (!self.lost).then_some(self.last_byte_ms).flatten(),
            ..Default::default()
        }
    }
}

enum Media {
    File(CastFile),
    Live(Arc<samples::Sample>),
}

#[expect(
    clippy::too_many_arguments,
    reason = "One cell has explicit session, media, cancellation and question ownership"
)]
async fn play_cell(
    client: &ControlClient,
    trace: &Arc<SessionTrace>,
    connection: u64,
    output: u64,
    cell: Cell,
    file: Media,
    cancel: &CancellationToken,
    answers: &mut mpsc::Receiver<AnswerEnvelope>,
    timing: Timing,
    question: impl Fn(bool),
) -> UserAnswers {
    let renderer = client.renderer();
    let origin = trace.elapsed();
    let endpoint = bind(renderer).await;
    let Ok(endpoint) = endpoint else {
        trace.failure(output, diag::Failure::PipelineFailed);
        return UserAnswers::default();
    };
    let mut events = endpoint.subscribe();
    for event in endpoint.diagnostics().stages {
        trace.http_at(output, origin + event.elapsed, &event);
    }
    let collecting = trace.clone();
    let collect = tokio::spawn(async move {
        let mut observations = Requests::default();
        loop {
            match events.recv().await {
                Ok(event) => {
                    observations.event(&event, origin);
                    collecting.http_at(output, origin + event.elapsed, &event);
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    observations.lost = true;
                    collecting.lagged(n);
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
        observations.finish()
    });
    let mut live = None;
    let duration = match &file {
        Media::File(f) => f.summary.duration_us,
        Media::Live(_) => 20_000_000,
    };
    let publication = match file {
        Media::Live(file) => match samples::live(file, cancel).await {
            Ok(producer) => {
                let result =
                    endpoint.publish_live(1, producer.stream.clone(), cast_http::TsMime::Mp2t);
                live = Some(producer);
                result
            }
            Err(_) => Err(cast_http::EndpointError::InvalidFile),
        },
        Media::File(file) => endpoint.publish_file(1, file, cast_http::TsMime::Mp2t),
    };
    let success = if let Ok(publication) = publication {
        if publication.content_type != "video/mp4" {
            trace.first_ts_packet(output);
        }
        // MIME follows the actual publication, including the optional MP4 probe.
        start(
            client,
            trace,
            connection,
            output,
            &publication,
            duration,
            cancel,
        )
        .await
    } else {
        trace.failure(output, diag::Failure::PrepareFailed);
        false
    };
    let started = tokio::time::Instant::now();
    let retire = async {
        if success {
            tokio::select! {biased; _=cancel.cancelled()=>{}, _=tokio::time::sleep_until(started+timing.playback)=>{}}
        }
        endpoint.shutdown().await;
        if let Some(live) = live {
            live.stop().await;
        }
        if let Ok(observations) = collect.await {
            trace.observations(output, observations);
        }
    };
    let observe = async {
        if success {
            observe(
                client, trace, connection, output, cell, cancel, answers, timing, &question,
            )
            .await
        } else {
            UserAnswers::default()
        }
    };
    let (answer, ()) = tokio::join!(observe, retire);
    question(false);
    answer
}

async fn bind(renderer: &Renderer) -> Result<CastEndpoint, cast_http::EndpointError> {
    #[cfg(test)]
    if renderer.local_address.is_loopback() {
        return Ok(cast_http::diagnostic_fixture::bind(renderer.context.clone()).await);
    }
    let url = url::Url::parse(&renderer.description.location)
        .map_err(|_| cast_http::EndpointError::Bind)?;
    let Some(url::Host::Ipv4(ip)) = url.host() else {
        return Err(cast_http::EndpointError::Bind);
    };
    CastEndpoint::bind(
        ip,
        renderer.context.clone(),
        cast_http::ServerIdentity::default(),
    )
    .await
}

async fn start(
    client: &ControlClient,
    trace: &SessionTrace,
    connection: u64,
    output: u64,
    media: &cast_http::PublishedMedia,
    duration: i64,
    cancel: &CancellationToken,
) -> bool {
    let mut stop = client.stop(cancel).await;
    if stop.result.is_err() {
        for stage in &mut stop.stages {
            stage.disposition = dlna::Disposition::Ignored;
        }
    }
    trace.record_operation(Some(connection), Some(output), &stop);
    if cancel.is_cancelled() {
        return false;
    }
    let protocol = format!(
        "http-get:*:{}:DLNA.ORG_OP={};DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000",
        media.content_type,
        if media.length.is_some() { "01" } else { "00" }
    );
    let metadata = dlna::dlna_policy::build_didl(
        &media.uri,
        "bilikara compatibility test",
        &protocol,
        media.length.map(|size| dlna::dlna_policy::FileMetadata {
            size,
            duration: Duration::from_micros(duration.max(0) as u64),
        }),
    );
    let mut set = client.set_uri(&media.uri, &metadata, cancel).await;
    let retry = set.result.as_ref().is_err_and(|e| {
        !e.is_cancelled()
            && (e.http_status.is_some_and(|s| (400..600).contains(&s))
                || matches!(
                    e.code,
                    dlna::ErrorCode::Policy(dlna::dlna_policy::PolicyError::SoapFault(_))
                ))
    });
    if retry {
        for stage in &mut set.stages {
            stage.disposition = dlna::Disposition::Retrying;
        }
    }
    trace.record_operation(Some(connection), Some(output), &set);
    if retry {
        set = client.set_uri(&media.uri, "", cancel).await;
        for stage in &mut set.stages {
            stage.attempt = 2;
        }
        trace.record_operation(Some(connection), Some(output), &set);
    }
    if set.result.is_err() {
        return false;
    }
    let play = client.play(cancel).await;
    trace.record_operation(Some(connection), Some(output), &play);
    play.result.is_ok()
}

#[expect(
    clippy::too_many_arguments,
    reason = "Cell observation uses the admitted receiver and explicit clocks"
)]
async fn observe(
    client: &ControlClient,
    trace: &SessionTrace,
    connection: u64,
    output: u64,
    cell: Cell,
    cancel: &CancellationToken,
    answers: &mut mpsc::Receiver<AnswerEnvelope>,
    timing: Timing,
    question: &impl Fn(bool),
) -> UserAnswers {
    let start = tokio::time::Instant::now();
    let mut shown = false;
    let mut stopped = false;
    let mut answer = None;
    let polling = async {
        let mut previous = None;
        let mut poll = tokio::time::interval(timing.poll);
        poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            poll.tick().await;
            let transport = client.get_transport_info(cancel).await;
            trace.record_operation(Some(connection), Some(output), &transport);
            let position = client.get_position_info(cancel).await;
            trace.record_operation(Some(connection), Some(output), &position);
            let current = position.result.ok().and_then(|p| p.position);
            let advanced = current.zip(previous).map(|(a, b)| a > b);
            if let Ok(state) = transport.result {
                trace.transport(output, state, advanced);
            }
            if current.is_some() {
                previous = current;
            }
        }
    };
    tokio::pin!(polling);
    loop {
        tokio::select! {
            biased;
            _=cancel.cancelled()=>return answer.unwrap_or_default(),
            value=answers.recv(),if shown&&answer.is_none()=>{
                if value.is_none() { return answer.unwrap_or_default(); }
                if let Some(value) = value
                    && value.cell == cell && value.question_id == output
                    && tokio::time::Instant::now() < start+timing.question_after+timing.answer_timeout {
                    answer=Some(value.answers);question(false);
                }
            },
            _=tokio::time::sleep_until(start+timing.question_after),if !shown=>{shown=true;question(true);},
            _=tokio::time::sleep_until(start+timing.playback),if !stopped=>{
                if let Ok(operation)=tokio::time::timeout(Duration::from_secs(2),client.stop(cancel)).await {trace.record_operation(Some(connection),Some(output),&operation);}stopped=true;
            },
            _=tokio::time::sleep_until(start+timing.question_after+timing.answer_timeout),if answer.is_none()=>{answer=Some(UserAnswers::default());question(false);},
            _=&mut polling,if !stopped=>{},
        }
        if stopped && let Some(answer) = answer {
            return answer;
        }
    }
}

#[cfg(test)]
mod observation_tests {
    use super::*;
    #[test]
    fn self_test_observations_track_replacement_and_positive_bytes_without_inventing_headers() {
        let mut requests = Requests::default();
        let mut event = cast_http::HttpStageResult {
            stage: HttpStage::Get,
            context: DeviceContext {
                device_key: "fixture".into(),
                udn_hash: None,
                source: DiscoverySource::Manual,
                server: String::new(),
                route: None,
            },
            generation: Some(1),
            connection_id: 1,
            elapsed: Duration::from_millis(10),
            http_status: Some(200),
            result: Ok(()),
            bytes_written: 0,
            disconnect_reason: None,
            media_time_us: None,
            live_start: None,
        };
        for id in 1..=5 {
            event.connection_id = id;
            requests.event(&event, Duration::from_secs(1));
        }
        event.stage = HttpStage::FirstByte;
        event.bytes_written = 188;
        requests.event(&event, Duration::from_secs(1));
        event.stage = HttpStage::Disconnect;
        event.connection_id = 1;
        event.elapsed = Duration::from_millis(40);
        event.disconnect_reason = Some(cast_http::Reason::Replaced);
        requests.event(&event, Duration::from_secs(1));
        requests.event(&event, Duration::from_secs(1)); // duplicate terminal event is not another kick
        event.connection_id = 2;
        event.bytes_written = 0;
        event.elapsed = Duration::from_millis(90);
        event.disconnect_reason = None;
        requests.event(&event, Duration::from_secs(1));
        let result = requests.finish();
        assert_eq!(result.maximum_concurrent_get, Some(5));
        assert_eq!(result.over_client_limit, Some(1));
        assert_eq!(result.last_byte_ms, Some(1040));
        assert_eq!(result.source_same_subnet_24, Some(true));
        let result = Requests {
            lost: true,
            maximum: 8,
            last_byte_ms: Some(12),
            ..Default::default()
        }
        .finish();
        assert_eq!(result.over_client_limit, None);
        assert_eq!(result.last_byte_ms, None);
        assert_eq!(Requests::default().finish().last_byte_ms, None);
    }
}
