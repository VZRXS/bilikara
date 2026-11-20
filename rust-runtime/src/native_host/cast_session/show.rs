//! The continuous composited cast ("show"). The receiver gets one live URI
//! for the whole connection and is never sent another command after Play:
//! songs, the pause picture and the between-song cards are generated as
//! segments (L2 runs) whose PCR/PTS/DTS are spliced onto one session clock.
//! Host pause, seek, next and settings retarget this generator; the TV sees
//! the change after the lead plus its own buffer, like a screen mirror.
use super::*;
use crate::app_state::{AppStateRequest, PlaylistItem};
use crate::cast_compositor::{self, Compositor};
use crate::dlna::cast_http::{LiveOptions, LiveProducer, LiveStream};
use crate::experimental_libav::{
    LibavMetadataProbe, ProbeError,
    cast_mux::CastStart,
    live_audio::{
        Composite, CompositeSource, CompositeVideo, Control, EncodedUnit, Event, TranscodeCodec,
        composite,
    },
};
use bilikara_rust::output_audio::OffsetMode;
use overlay::Card;
use std::collections::VecDeque;
use std::sync::Mutex;
use std::sync::atomic::{AtomicI64, AtomicU64};
use std::time::Instant;

pub(super) const FPS: (u32, u32) = (30, 1);
/// Data is produced this far ahead of the session clock. Besides the
/// receiver's start, it absorbs each segment's decoder/encoder setup.
const LEAD: Duration = Duration::from_millis(2_500);
/// Assumed receiver buffering, only for the Host's position display.
const RECEIVER_BUFFER: Duration = Duration::from_millis(1_000);
/// Session time between a segment's last data and the next segment.
const SEGMENT_GAP_US: i64 = 50_000;
/// Cards and pauses run in pieces this long; the next one continues them.
const STILL_US: i64 = 600_000_000;
const FAILED_CARD_US: i64 = 3_000_000;
/// Consecutive failed segments that stop the show.
const MAX_FAILURES: u32 = 3;

/// How every segment of one show is encoded; fixed for the connection so
/// the receiver's decoder never sees a new size.
pub(super) struct Plan {
    video: Video,
    pub width: u32,
    pub height: u32,
    pub bit_rate: u32,
}
enum Video {
    External(Arc<dyn Compositor>),
    Transcode(TranscodeCodec),
}
impl Plan {
    /// Diagnostics name of the planned encoder.
    pub fn encoder(&self) -> &'static str {
        match &self.video {
            Video::External(c) => c.name(),
            Video::Transcode(TranscodeCodec::H264) => "companion_h264",
            Video::Transcode(TranscodeCodec::Mpeg2) => "companion_mpeg2",
        }
    }
}

/// The video codec a composited cast sends from this build: H.264 from a
/// platform compositor or Media Foundation, else software MPEG-2.
pub(super) fn expected_codec() -> &'static str {
    if cast_compositor::capability().is_some() || cfg!(target_os = "windows") {
        "h264"
    } else {
        "mpeg2"
    }
}

/// Hardware or Media Foundation H.264 at 1080p; the software MPEG-2
/// fallback at 720p keeps a desktop CPU in real time.
pub(super) fn plan(
    kinds: u32,
    platform: Option<Arc<dyn Compositor>>,
) -> Result<Plan, &'static str> {
    let (video, (width, height), bit_rate) =
        match platform.filter(|_| kinds & composite::KIND_EXTERNAL != 0) {
            Some(platform) => (Video::External(platform), (1920, 1080), 8_000_000),
            None if kinds & composite::KIND_H264 != 0 => (
                Video::Transcode(TranscodeCodec::H264),
                (1920, 1080),
                8_000_000,
            ),
            None if kinds & composite::KIND_MPEG2 != 0 => (
                Video::Transcode(TranscodeCodec::Mpeg2),
                (1280, 720),
                7_500_000,
            ),
            None => return Err("composite_unavailable"),
        };
    // Receiver tests capture small pictures at a small rate.
    #[cfg(test)]
    let (width, height, bit_rate) = std::env::var("BILIKARA_TEST_CAST_SHOW_SIZE")
        .ok()
        .and_then(|v| {
            let (w, h) = v.split_once('x')?;
            Some((w.parse().ok()?, h.parse().ok()?, 600_000))
        })
        .unwrap_or((width, height, bit_rate));
    Ok(Plan {
        video,
        width,
        height,
        bit_rate,
    })
}

/// What a show segment put on the session clock, for the Host's position.
#[derive(Clone, Debug)]
struct Record {
    session_us: i64,
    item: Option<String>,
    /// Source microseconds at `session_us`.
    origin_us: i64,
    moving: bool,
}

/// Worker <-> generator state.
#[derive(Default)]
pub(super) struct Shared {
    version: AtomicU64,
    seek: Mutex<Option<f64>>,
    records: Mutex<VecDeque<Record>>,
    /// Session microseconds of the newest pushed data.
    generated_us: AtomicI64,
    began: std::sync::OnceLock<Instant>,
    encoder: Mutex<Option<String>>,
    /// The media length of an item (seconds), from its preflight.
    duration: Mutex<Option<(String, f64)>>,
}
impl Shared {
    /// The Host changed pause, settings or program: re-decide now.
    pub fn retarget(&self) {
        self.version.fetch_add(1, Ordering::AcqRel);
    }
    pub fn seek(&self, position: f64) {
        *self.seek.lock().unwrap_or_else(|e| e.into_inner()) = Some(position);
        self.retarget();
    }
    /// Seconds of `item` from its media, once a segment inspected it.
    pub fn duration(&self, item: &str) -> Option<f64> {
        self.duration
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .filter(|(id, _)| id == item)
            .map(|(_, seconds)| *seconds)
    }
    pub fn encoder(&self) -> Option<String> {
        self.encoder
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
    /// Estimated position of `item` on the receiver (seconds), or None
    /// before it is on screen.
    pub fn on_air(&self, item: &str) -> Option<f64> {
        let began = self.began.get()?;
        let now = began
            .elapsed()
            .saturating_sub(LEAD + RECEIVER_BUFFER)
            .as_micros() as i64;
        let records = self.records.lock().unwrap_or_else(|e| e.into_inner());
        let record = records.iter().rev().find(|r| r.session_us <= now)?;
        if record.item.as_deref() != Some(item) {
            return None;
        }
        let moved = if record.moving {
            now - record.session_us
        } else {
            0
        };
        Some((record.origin_us + moved) as f64 / 1_000_000.0)
    }
    fn record(&self, record: Record) {
        let mut records = self.records.lock().unwrap_or_else(|e| e.into_inner());
        records.push_back(record);
        while records.len() > 32 {
            records.pop_front();
        }
    }
}

pub(super) struct Show {
    pub stream: Arc<LiveStream>,
    pub shared: Arc<Shared>,
    pub encoder: &'static str,
    task: Option<tokio::task::JoinHandle<Result<(), ApiError>>>,
}
impl Show {
    /// The generator failed (or ended): its error.
    pub async fn check(&mut self) -> Result<(), ApiError> {
        if self.task.as_ref().is_some_and(|task| task.is_finished()) {
            self.task.take().unwrap().await.map_err(|_| {
                ApiError::new(409, "cast_prepare_failed", "Composited cast failed")
            })??;
            return Err(ApiError::new(
                409,
                "cast_prepare_failed",
                "Composited cast ended",
            ));
        }
        Ok(())
    }
    pub async fn stop(mut self) {
        self.stream.cancel();
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }
}

/// Starts the generator for operation `id` and HTTP generation
/// `generation`; returns once the first segment produced its start.
pub(super) async fn start(
    context: Arc<HostContext>,
    identity: (u64, u64),
    hub: Arc<overlay::Hub>,
    cancel: &CancellationToken,
) -> Result<Show, ApiError> {
    let (stream, producer) = LiveStream::external(LiveOptions::default())
        .map_err(|_| ApiError::invalid("Invalid live options"))?;
    let shared = Arc::new(Shared::default());
    let (ready, planned) = tokio::sync::oneshot::channel();
    let task = {
        let stream = stream.clone();
        let shared = shared.clone();
        tokio::task::spawn_blocking(move || {
            // The companion handle is thread-affine on Windows: load and use
            // it on this thread only.
            let prepared = (|| {
                let probe = media::probe()?;
                if !probe.live_l1_available() {
                    return Err(ApiError::new(409, "cast_prepare_failed", "l1_unavailable"));
                }
                let plan = plan(probe.composite_kinds(), cast_compositor::installed())
                    .map_err(|reason| ApiError::new(409, "cast_prepare_failed", reason))?;
                Ok((probe, plan))
            })();
            let (probe, plan) = match prepared {
                Ok(prepared) => prepared,
                Err(e) => {
                    let _ = ready.send(Err(e));
                    stream.cancel();
                    return Ok(());
                }
            };
            if ready.send(Ok(plan.encoder())).is_err() {
                stream.cancel();
                return Ok(());
            }
            Generator {
                context,
                identity,
                probe,
                plan,
                view: None,
                hub,
                shared,
                stream,
                producer: Some(producer),
                offset_us: 0,
                marked: None,
            }
            .run()
        })
    };
    let encoder = planned.await.unwrap_or_else(|_| {
        Err(ApiError::new(
            409,
            "cast_prepare_failed",
            "Composited cast failed",
        ))
    });
    let mut show = Show {
        stream,
        shared,
        encoder: "",
        task: Some(task),
    };
    match encoder {
        Ok(encoder) => show.encoder = encoder,
        Err(e) => {
            show.stop().await;
            return Err(e);
        }
    }
    // The first segment opens its decoder and encoder before the URI goes out.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while show.stream.snapshot().start.is_none() {
        if cancel.is_cancelled() || tokio::time::Instant::now() >= deadline {
            show.stop().await;
            return Err(ApiError::new(
                409,
                "cast_prepare_failed",
                "Composited start unavailable",
            ));
        }
        if let Err(error) = show.check().await {
            show.stop().await;
            return Err(error);
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    Ok(show)
}

// ---- generator ----------------------------------------------------------

/// Where the program stands between segments.
#[derive(Clone, Debug, PartialEq)]
enum Machine {
    /// Show `item` of `generation` from `position_us` (paused: held).
    Program {
        generation: u64,
        item: String,
        position_us: i64,
    },
    /// The program of `generation` ended; advance at `until_us` (session).
    Transition { generation: u64, until_us: i64 },
    /// The program of `generation` failed; advance at `until_us`.
    Failed {
        generation: u64,
        title: String,
        until_us: i64,
    },
}

/// One segment to generate.
struct Segment {
    source: CompositeSource,
    item: Option<PlaylistItem>,
    /// Source position (Play/Hold) where it starts.
    start_us: i64,
    card: Option<Card>,
    /// Session time at which a card ends by itself.
    until_us: Option<i64>,
    /// Re-decide when this observable state changes.
    watch: Watch,
    version: u64,
}

/// Cheap AppState facts a running segment compares against: the program
/// and whether its cache is ready.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Watch {
    generation: u64,
    item: Option<(String, bool)>,
}
fn watch_of(snap: &crate::app_state::native_session::NativeCastInput) -> Watch {
    Watch {
        generation: snap.playback_generation,
        item: snap
            .current_item
            .as_ref()
            .map(|i| (i.item_incarnation_id.clone(), i.cache_status == "ready")),
    }
}
/// The current song's whole cache percent, for a waiting card.
fn caching_of(snap: &crate::app_state::native_session::NativeCastInput) -> Option<(String, u32)> {
    snap.current_item
        .as_ref()
        .map(|c| (item_title(c), c.cache_progress.clamp(0.0, 100.0) as u32))
}

enum Outcome {
    /// The source ended.
    Ended,
    /// Stopped for a new decision; the last source microsecond generated.
    Retarget(Option<i64>),
    /// The track set must be reopened at this source microsecond.
    Reopen(i64),
    Cancelled,
    Failed(ApiError),
}

struct Generator {
    context: Arc<HostContext>,
    identity: (u64, u64),
    probe: LibavMetadataProbe,
    plan: Plan,
    view: Option<Arc<overlay::View>>,
    hub: Arc<overlay::Hub>,
    shared: Arc<Shared>,
    stream: Arc<LiveStream>,
    producer: Option<LiveProducer>,
    /// Session microseconds where the next segment starts.
    offset_us: i64,
    /// The program already reported as started: (generation, item id).
    marked: Option<(u64, String)>,
}

fn neutral_control() -> Control {
    Control {
        offset_ms: 0,
        key_shift: 0,
        volume_percent: 100,
        muted: false,
        track: 0,
        mode: OffsetMode::Splice,
    }
}

fn item_title(item: &PlaylistItem) -> String {
    if item.display_title.is_empty() {
        item.title.clone()
    } else {
        item.display_title.clone()
    }
}

impl Generator {
    fn cancelled(&self) -> bool {
        self.stream.cancellation().load(Ordering::Acquire)
    }

    fn run(mut self) -> Result<(), ApiError> {
        let view = Arc::new(overlay::View::new(
            self.hub.clone(),
            self.plan.width,
            self.plan.height,
        ));
        overlay::prewarm();
        self.view = Some(view);
        let mut machine: Option<Machine> = None;
        let mut failures = 0;
        let result = loop {
            if self.cancelled() {
                break Ok(());
            }
            let segment = match with_app(|app| self.decide(app, &mut machine)) {
                Ok(segment) => segment,
                Err(e) => break Err(e),
            };
            let outcome = self.segment(&segment);
            match outcome {
                Outcome::Cancelled => break Ok(()),
                Outcome::Ended => {
                    failures = 0;
                    match (&segment.source, &machine) {
                        (CompositeSource::Play, Some(Machine::Program { generation, .. })) => {
                            let delay = with_app(|app| app.native_cast_queue(0))
                                .map_or(0, |q| q.advance_delay_seconds.max(0));
                            if delay == 0 {
                                let _ = worker::advance(self.identity.0, *generation);
                                machine = None;
                            } else {
                                machine = Some(Machine::Transition {
                                    generation: *generation,
                                    until_us: self.offset_us + i64::from(delay) * 1_000_000,
                                });
                            }
                        }
                        // A card reached its time: move to the next song.
                        (
                            CompositeSource::Blank,
                            Some(
                                Machine::Transition { generation, .. }
                                | Machine::Failed { generation, .. },
                            ),
                        ) if segment.until_us.is_some() => {
                            let _ = worker::advance(self.identity.0, *generation);
                            machine = None;
                        }
                        _ => {}
                    }
                }
                Outcome::Retarget(position) => {
                    failures = 0;
                    if let (Some(position), Some(Machine::Program { position_us, .. })) =
                        (position, machine.as_mut())
                        && segment.source == CompositeSource::Play
                    {
                        *position_us = position;
                    }
                }
                Outcome::Reopen(position) => {
                    if let Some(Machine::Program { position_us, .. }) = machine.as_mut() {
                        *position_us = position;
                    }
                }
                Outcome::Failed(error) => {
                    failures += 1;
                    eprintln!("[cast] composited segment failed: {}", error.code);
                    if failures >= MAX_FAILURES {
                        break Err(error);
                    }
                    if let (Some(item), Some(Machine::Program { generation, .. })) =
                        (&segment.item, &machine)
                    {
                        machine = Some(Machine::Failed {
                            generation: *generation,
                            title: item_title(item),
                            until_us: self.offset_us + FAILED_CARD_US,
                        });
                    }
                }
            }
        };
        let success = result.is_ok();
        if let Some(producer) = self.producer.take() {
            let _ = producer.finish(success);
        }
        result
    }

    /// The next segment from the Host's state and the program machine.
    fn decide(
        &self,
        app: &mut crate::app_state::AppState,
        machine: &mut Option<Machine>,
    ) -> Result<Segment, ApiError> {
        let snap = app.native_cast_input()?;
        let s = &app.native().cast;
        if (s.operation, s.generation) != self.identity {
            return Err(ApiError::new(409, "cancelled", "Cast output replaced"));
        }
        let paused = s.paused;
        let host_position = s.position;
        let seek = self
            .shared
            .seek
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        let version = self.shared.version.load(Ordering::Acquire);
        let current = snap.current_item.clone();
        // A different program (or a seek) restarts the machine.
        let program_changed = match (machine.as_ref(), current.as_ref()) {
            (
                Some(Machine::Program {
                    generation, item, ..
                }),
                Some(c),
            ) => *generation != snap.playback_generation || *item != c.item_incarnation_id,
            (
                Some(Machine::Transition { generation, .. } | Machine::Failed { generation, .. }),
                _,
            ) => *generation != snap.playback_generation,
            _ => true,
        };
        if let Some(c) = current.as_ref().filter(|c| c.cache_status == "ready")
            && (program_changed || seek.is_some())
            && !matches!(machine, Some(Machine::Transition { generation, .. } | Machine::Failed { generation, .. }) if *generation == snap.playback_generation && seek.is_none())
        {
            // The first program continues where the Host stood.
            let position = seek.unwrap_or(if machine.is_none() && self.marked.is_none() {
                host_position
            } else {
                0.0
            });
            *machine = Some(Machine::Program {
                generation: snap.playback_generation,
                item: c.item_incarnation_id.clone(),
                position_us: (position.max(0.0) * 1_000_000.0) as i64,
            });
        } else if program_changed
            && matches!(
                machine,
                Some(Machine::Transition { .. } | Machine::Failed { .. })
            )
        {
            // The Host moved on to a song that is not ready: wait for it.
            *machine = None;
        }
        let queue = app.native_cast_queue(4)?;
        let watched = watch_of(&snap);
        let card_segment = |card: Card, until_us: Option<i64>| -> Result<Segment, ApiError> {
            Ok(Segment {
                source: CompositeSource::Blank,
                item: None,
                start_us: 0,
                card: Some(card),
                until_us,
                watch: watched.clone(),
                version,
            })
        };
        match machine.clone() {
            Some(Machine::Transition { until_us, .. }) => {
                let next = queue.upcoming.first();
                card_segment(
                    Card::Next {
                        title: next.map(item_title),
                        requester: next.map(|i| i.requester_name.clone()).unwrap_or_default(),
                        seconds: 0,
                        later: queue
                            .upcoming
                            .iter()
                            .skip(1)
                            .take(3)
                            .map(item_title)
                            .collect(),
                    },
                    Some(until_us),
                )
            }
            Some(Machine::Failed {
                title, until_us, ..
            }) => card_segment(Card::Failed { title }, Some(until_us)),
            Some(Machine::Program { position_us, .. })
                if current.as_ref().is_some_and(|c| c.cache_status == "ready") =>
            {
                let item = current.unwrap();
                Ok(Segment {
                    source: if paused {
                        CompositeSource::Hold
                    } else {
                        CompositeSource::Play
                    },
                    card: paused.then_some(Card::Paused),
                    item: Some(item),
                    start_us: position_us,
                    until_us: None,
                    watch: watched.clone(),
                    version,
                })
            }
            _ => {
                *machine = None;
                card_segment(
                    Card::Waiting {
                        caching: caching_of(&snap),
                    },
                    None,
                )
            }
        }
    }

    /// Generates one segment onto the session clock.
    fn segment(&mut self, segment: &Segment) -> Outcome {
        let view = self.view.clone().expect("view");
        view.set_card(segment.card.clone());
        // Leases on the cached files last for the segment.
        let input = match &segment.item {
            Some(item) => match media::inputs_for(
                &self.context,
                item,
                segment.source == CompositeSource::Play,
            ) {
                Ok(input) => Some(input),
                Err(e) => return Outcome::Failed(e),
            },
            None => None,
        };
        let end_us = match (&segment.item, &input) {
            (Some(item), Some(input)) if segment.source == CompositeSource::Play => {
                match self
                    .probe
                    .cast_preflight(&input.video, self.stream.cancellation())
                {
                    Ok(facts) => {
                        let end_us = facts.source_start_us.max(0) + facts.duration_us;
                        *self
                            .shared
                            .duration
                            .lock()
                            .unwrap_or_else(|e| e.into_inner()) =
                            Some((item.id.clone(), end_us as f64 / 1_000_000.0));
                        end_us
                    }
                    Err(_) if self.cancelled() => return Outcome::Cancelled,
                    Err(e) => {
                        return Outcome::Failed(media::prepare_error(
                            e,
                            "Cannot inspect composited media",
                        ));
                    }
                }
            }
            _ => segment.start_us + STILL_US,
        };
        if segment.start_us >= end_us {
            return Outcome::Ended;
        }
        let stop = AtomicBool::new(false);
        let reopen = std::cell::Cell::new(false);
        let mut last_time = None::<i64>;
        let mut origin_us = segment.start_us;
        let mut pacing_error = None;
        let mut started = false;
        let mut last_watch = Instant::now();
        let mut push_failed = false;
        let identity = self.identity;
        let offset_us = self.offset_us;
        let shared = self.shared.clone();
        let stream = self.stream.clone();
        let mut producer = self.producer.take().expect("producer");
        let mut mark = None;
        let plan = &self.plan;
        let platform_request = match &plan.video {
            Video::External(_) => Some(cast_compositor::Request {
                video: input.as_ref().map(|i| i.video.clone()),
                source: match segment.source {
                    CompositeSource::Play => cast_compositor::Source::Play,
                    CompositeSource::Hold => cast_compositor::Source::Hold,
                    CompositeSource::Blank => cast_compositor::Source::Blank,
                },
                start_us: segment.start_us,
                end_us,
                width: plan.width,
                height: plan.height,
                fps: FPS,
                bit_rate: plan.bit_rate,
            }),
            Video::Transcode(_) => None,
        };
        let mut platform_stream = match (&plan.video, &platform_request) {
            (Video::External(compositor), Some(request)) => match compositor.open(request) {
                Ok(stream) => Some(stream),
                Err(e) => {
                    self.producer = Some(producer);
                    eprintln!("[cast] compositor open failed: {e}");
                    return Outcome::Failed(ApiError::new(
                        409,
                        "cast_prepare_failed",
                        "Compositor unavailable",
                    ));
                }
            },
            _ => None,
        };
        let card_until = segment.until_us;
        let countdown = matches!(segment.card, Some(Card::Next { .. }));
        let waiting = matches!(segment.card, Some(Card::Waiting { .. }));
        let mut shown_seconds = None;
        let deadline = std::cell::Cell::new(false);
        let result = {
            let view_ref = &view;
            let mut overlay_generation = 0;
            let mut next = || -> Result<Option<EncodedUnit>, ProbeError> {
                let platform = platform_stream.as_mut().expect("external video");
                if stop.load(Ordering::Acquire) || stream.cancellation().load(Ordering::Acquire) {
                    return Err(ProbeError::Cancelled);
                }
                if let Some((generation, rgba)) = view_ref
                    .refresh(overlay_generation)
                    .map_err(ProbeError::BackendFailure)?
                {
                    platform
                        .set_overlay(&rgba)
                        .map_err(ProbeError::BackendFailure)?;
                    overlay_generation = generation;
                }
                let cancelled = &stop;
                Ok(platform
                    .next(cancelled)
                    .map_err(|e| {
                        if cancelled.load(Ordering::Acquire) {
                            ProbeError::Cancelled
                        } else {
                            ProbeError::BackendFailure(e)
                        }
                    })?
                    .map(|u| EncodedUnit {
                        data: u.data,
                        key: u.key,
                        pts_us: u.pts_us,
                        dts_us: u.dts_us,
                    }))
            };
            let video = match plan.video {
                Video::External(_) => CompositeVideo::External {
                    width: plan.width,
                    height: plan.height,
                    next: &mut next,
                },
                Video::Transcode(codec) => CompositeVideo::Transcode {
                    codec,
                    width: plan.width,
                    height: plan.height,
                },
            };
            let external = matches!(video, CompositeVideo::External { .. });
            let tracks = input
                .as_ref()
                .filter(|_| segment.source == CompositeSource::Play)
                .map(|i| {
                    i.tracks
                        .iter()
                        .map(|(_, p)| p.as_path())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let mut last_control = neutral_control();
            let item = segment.item.clone();
            let source = segment.source;
            let watched = segment.watch.clone();
            let version = segment.version;
            let video_path = input.as_ref().map(|i| i.video.as_path());
            self.probe.render_composited_ts_with_events(
                video_path,
                &tracks,
                segment.start_us,
                &stop,
                &mut |event| match event {
                    Event::Start(start) => {
                        origin_us = start.timestamp_origin_us;
                        if shared.began.get().is_none() {
                            let result = producer.start(CastStart {
                                source_start_us: 0,
                                timestamp_origin_us: 0,
                                profile: -1,
                                level: -1,
                                width: plan.width,
                                height: plan.height,
                                has_b_frames: false,
                                audio_transcoded: true,
                            });
                            let _ = shared.began.set(Instant::now());
                            if result.is_err() {
                                push_failed = true;
                                return false;
                            }
                        }
                        true
                    }
                    Event::Data {
                        bytes,
                        time_us,
                        key,
                    } => {
                        let Some(began) = shared.began.get().copied() else {
                            return false;
                        };
                        let session_us = offset_us + time_us;
                        if !started {
                            started = true;
                            shared.record(Record {
                                session_us,
                                item: item.as_ref().map(|i| i.id.clone()),
                                origin_us: if source == CompositeSource::Play {
                                    origin_us + time_us
                                } else {
                                    segment.start_us
                                },
                                moving: source == CompositeSource::Play,
                            });
                            if let (CompositeSource::Play, Some(item)) = (source, &item) {
                                mark = Some((watched.generation, item.id.clone()));
                            }
                        }
                        let due = match super::l1::pacing_due(session_us, LEAD) {
                            Ok(due) => due,
                            Err(error) => {
                                pacing_error = Some(error);
                                return false;
                            }
                        };
                        loop {
                            if stream.cancellation().load(Ordering::Acquire) {
                                return false;
                            }
                            // Decisions only stop the segment between packets.
                            if card_until.is_some_and(|until| session_us >= until) {
                                deadline.set(true);
                                stop.store(true, Ordering::Release);
                            }
                            if shared.version.load(Ordering::Acquire) != version {
                                stop.store(true, Ordering::Release);
                            }
                            if last_watch.elapsed() >= Duration::from_millis(250) {
                                last_watch = Instant::now();
                                match with_app(|app| app.native_cast_input()) {
                                    Ok(snap) if watch_of(&snap) != watched => {
                                        stop.store(true, Ordering::Release)
                                    }
                                    Ok(snap) if waiting => view_ref.set_card(Some(Card::Waiting {
                                        caching: caching_of(&snap),
                                    })),
                                    Err(_) => stop.store(true, Ordering::Release),
                                    _ => {}
                                }
                            }
                            if began.elapsed() >= due {
                                break;
                            }
                            thread::sleep(
                                (due - began.elapsed().min(due)).min(Duration::from_millis(10)),
                            );
                        }
                        if countdown && let Some(until) = card_until {
                            let seconds =
                                ((until - session_us).max(0) as u64).div_ceil(1_000_000) as u32;
                            if shown_seconds != Some(seconds) {
                                shown_seconds = Some(seconds);
                                if let Some(Card::Next {
                                    title,
                                    requester,
                                    later,
                                    ..
                                }) = &segment.card
                                {
                                    view_ref.set_card(Some(Card::Next {
                                        title: title.clone(),
                                        requester: requester.clone(),
                                        seconds,
                                        later: later.clone(),
                                    }));
                                }
                            }
                        }
                        let mut bytes = bytes.to_vec();
                        if !splice::shift(&mut bytes, splice::ticks(offset_us)) {
                            push_failed = true;
                            return false;
                        }
                        last_time = Some(time_us);
                        shared.generated_us.store(session_us, Ordering::Release);
                        if producer.push(&bytes, session_us, key).is_err() {
                            push_failed = true;
                            return false;
                        }
                        true
                    }
                },
                &mut || {
                    let Some(item) = &item else {
                        return Ok(last_control);
                    };
                    if source != CompositeSource::Play {
                        return Ok(last_control);
                    }
                    let input = input.as_ref().expect("play input");
                    match with_app(|app| super::l1::read_control(app, input, item, identity)) {
                        Ok(Some(control)) => last_control = control,
                        Ok(None) => {}
                        // A track outside the opened pair: reopen here.
                        Err(e)
                            if e.code == "invalid_request" || e.message == "Uncached L1 track" =>
                        {
                            reopen.set(true);
                            stop.store(true, Ordering::Release);
                        }
                        Err(_) => stop.store(true, Ordering::Release),
                    }
                    Ok(last_control)
                },
                Composite {
                    video,
                    source,
                    fps: FPS,
                    bit_rate: plan.bit_rate,
                    end_us,
                    overlay: (!external).then_some(&*view as _),
                },
            )
        };
        drop(platform_stream);
        if let Some(encoder) = match (&result, &self.plan.video) {
            (Ok(report), Video::Transcode(_)) => Some(report.encoder.name().to_owned()),
            (_, Video::External(c)) => Some(c.name().to_owned()),
            _ => None,
        } {
            *self
                .shared
                .encoder
                .lock()
                .unwrap_or_else(|e| e.into_inner()) = Some(encoder);
        }
        self.producer = Some(producer);
        // The next segment starts after everything this one put on the clock.
        if let Some(last) = last_time {
            self.offset_us = offset_us + last + SEGMENT_GAP_US;
        }
        if let Some(mark) = mark
            && self.marked.as_ref() != Some(&mark)
        {
            let _ = with_app(|app| {
                app.native_execute(AppStateRequest::MarkCurrentItemStarted {
                    schema_version: 1,
                    item_id: mark.1.clone(),
                    now: now(),
                })
            });
            self.marked = Some(mark);
        }
        if self.cancelled() {
            return Outcome::Cancelled;
        }
        if push_failed {
            return Outcome::Failed(ApiError::new(
                409,
                "cast_prepare_failed",
                "Composited stream rejected data",
            ));
        }
        if let Some(error) = pacing_error {
            return Outcome::Failed(error);
        }
        let generated = last_time.map(|t| origin_us + t);
        match result {
            Ok(_) => Outcome::Ended,
            Err(_) if deadline.get() => Outcome::Ended,
            Err(_) if reopen.get() => Outcome::Reopen(generated.unwrap_or(segment.start_us)),
            Err(ProbeError::Cancelled) | Err(_) if stop.load(Ordering::Acquire) => {
                Outcome::Retarget(generated)
            }
            Err(e) => {
                eprintln!("[cast] composited producer failed: {e}");
                Outcome::Failed(media::prepare_error(e, "Cannot generate composited media"))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plans_prefer_the_platform_then_h264_then_mpeg2_at_a_fixed_size() {
        let all = composite::KIND_EXTERNAL | composite::KIND_H264 | composite::KIND_MPEG2;
        if std::env::var_os("BILIKARA_TEST_CAST_SHOW_SIZE").is_some() {
            return;
        }
        let plan = super::plan(all, None).unwrap();
        assert_eq!(plan.encoder(), "companion_h264");
        assert_eq!(
            (plan.width, plan.height, plan.bit_rate),
            (1920, 1080, 8_000_000)
        );
        let plan = super::plan(composite::KIND_EXTERNAL | composite::KIND_MPEG2, None).unwrap();
        assert_eq!(plan.encoder(), "companion_mpeg2");
        assert_eq!((plan.width, plan.height), (1280, 720));
        assert_eq!(
            super::plan(composite::KIND_EXTERNAL, None).err(),
            Some("composite_unavailable")
        );
    }

    #[test]
    fn on_air_maps_the_receiver_clock_to_the_shown_program() {
        let shared = Shared::default();
        assert_eq!(shared.on_air("a"), None, "nothing before the start");
        let lag = (LEAD + RECEIVER_BUFFER).as_micros() as i64;
        let _ = shared
            .began
            .set(Instant::now() - Duration::from_micros((lag + 10_000_000) as u64));
        // Song a from 30 s at session 0; held at 35 s from session 5 s; then
        // song b from 0 at session 9 s (not yet on air at session ~10 s - it is).
        shared.record(Record {
            session_us: 0,
            item: Some("a".into()),
            origin_us: 30_000_000,
            moving: true,
        });
        shared.record(Record {
            session_us: 5_000_000,
            item: Some("a".into()),
            origin_us: 35_000_000,
            moving: false,
        });
        let held = shared.on_air("a").unwrap();
        assert!((held - 35.0).abs() < 0.01, "{held}");
        shared.record(Record {
            session_us: 9_000_000,
            item: Some("b".into()),
            origin_us: 0,
            moving: true,
        });
        let b = shared.on_air("b").unwrap();
        assert!((0.9..1.5).contains(&b), "{b}");
        assert_eq!(shared.on_air("a"), None, "a is no longer on air");
        // Not yet on air: a record in the future is ignored.
        shared.record(Record {
            session_us: 60_000_000,
            item: Some("c".into()),
            origin_us: 0,
            moving: true,
        });
        assert_eq!(shared.on_air("c"), None);
    }
}
