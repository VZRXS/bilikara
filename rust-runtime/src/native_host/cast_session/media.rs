use super::*;
use crate::app_state::PlaylistItem;
use crate::dlna::cast_http::{Growth, LiveOptions, LiveStream};
use crate::experimental_libav::{
    LibavMetadataProbe, ProbeError,
    cast_mux::{CastFile, CastFormat, CastInputs, CastSession, CastSummary, GrowingTs},
    live_audio::{Control, Event},
};
use std::path::Component;

pub(super) struct Inputs {
    pub(super) video: PathBuf,
    pub(super) audio: PathBuf,
    pub(super) tracks: Vec<(String, PathBuf)>,
    leases: Vec<String>,
}
impl Drop for Inputs {
    fn drop(&mut self) {
        let _ = with_app(|app| {
            for lease in &self.leases {
                app.native_unpin_media(lease);
            }
            Ok(())
        });
    }
}

fn path(root: &Path, route: &str) -> Result<PathBuf, ApiError> {
    let relative = route
        .strip_prefix("/media/")
        .ok_or_else(|| ApiError::invalid("Invalid media route"))?;
    if relative.contains(['\\', '%', '\0'])
        || !Path::new(relative)
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
    {
        return Err(ApiError::invalid("Invalid media path"));
    }
    let root = root
        .canonicalize()
        .map_err(|_| ApiError::new(409, "cast_media_unavailable", "Cache unavailable"))?;
    let path = root
        .join(relative)
        .canonicalize()
        .map_err(|_| ApiError::new(409, "cast_media_unavailable", "Cache unavailable"))?;
    if !path.starts_with(root) || !path.is_file() {
        return Err(ApiError::invalid("Invalid media path"));
    }
    Ok(path)
}
pub(super) fn inputs(context: &HostContext, item: &PlaylistItem) -> Result<Inputs, ApiError> {
    inputs_for(context, item, false)
}
/// The companion's L1 ABI renders at most two tracks. Send the selected one
/// and, when cached, the first other cached variant in item order (both in
/// item order). Uncached variants are left out instead of refusing L1;
/// selecting a variant outside these restarts the stream at the current
/// position (worker.rs).
pub(super) fn l1_track_ids(
    variants: &[serde_json::Map<String, Value>],
    selected: &str,
) -> Vec<String> {
    let cached = variants
        .iter()
        .filter(|v| v.get("audio_url").and_then(Value::as_str).is_some())
        .filter_map(|v| {
            v.get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
        })
        .collect::<Vec<_>>();
    let partner = cached.iter().find(|id| **id != selected).copied();
    cached
        .into_iter()
        .filter(|id| *id == selected || Some(*id) == partner)
        .map(str::to_owned)
        .collect()
}
/// Why live delivery cannot run L1 for this source. `live_ts.c` refuses any
/// video packet more than 4 s after its keyframe; T3 has no such limit, so
/// those sources keep the raw T3 stream and report the reason.
pub(super) fn l1_refusal(available: bool, facts: &CastSummary) -> Option<&'static str> {
    if !available {
        return Some("l1_unavailable");
    }
    let longest = facts.gop_us.unwrap_or(facts.duration_us);
    (longest > 4_000_000).then_some("long_gop")
}
/// Source-codec refusals are the user's actionable case (re-cache as H.264);
/// every other preparation failure keeps the generic code.
pub(super) fn prepare_error(error: ProbeError, message: &'static str) -> ApiError {
    match error {
        ProbeError::Media(e) if e.kind == crate::MediaErrorKind::UnsupportedCodec => ApiError::new(
            409,
            "cast_media_unsupported_codec",
            "Casting needs H.264 video; re-cache this song as H.264",
        ),
        _ => ApiError::new(409, "cast_prepare_failed", message),
    }
}
pub(super) fn inputs_for(
    context: &HostContext,
    item: &PlaylistItem,
    l1: bool,
) -> Result<Inputs, ApiError> {
    let audio = item
        .audio_variants
        .iter()
        .find(|v| v["id"] == item.selected_audio_variant_id)
        .and_then(|v| v["audio_url"].as_str())
        .ok_or_else(|| {
            ApiError::new(
                409,
                "cast_media_unavailable",
                "Cache the selected audio first",
            )
        })?;
    let mut input = Inputs {
        video: PathBuf::new(),
        audio: PathBuf::new(),
        tracks: Vec::new(),
        leases: Vec::new(),
    };
    with_app(|app| {
        input
            .leases
            .push(app.native_pin_media(&item.video_media_url)?);
        input.leases.push(app.native_pin_media(audio)?);
        Ok(())
    })?;
    input.video = path(&context.cache_root, &item.video_media_url)?;
    input.audio = path(&context.cache_root, audio)?;
    if l1 {
        let ids = l1_track_ids(&item.audio_variants, &item.selected_audio_variant_id);
        for variant in &item.audio_variants {
            let Some(id) = variant
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| ids.iter().any(|t| t == id))
            else {
                continue;
            };
            let route = variant
                .get("audio_url")
                .and_then(Value::as_str)
                .ok_or_else(|| ApiError::invalid("Uncached L1 track"))?;
            input
                .leases
                .push(with_app(|app| app.native_pin_media(route))?);
            input
                .tracks
                .push((id.to_owned(), path(&context.cache_root, route)?));
        }
    }
    Ok(input)
}
pub(super) fn probe() -> Result<LibavMetadataProbe, ApiError> {
    #[cfg(test)]
    if let Some(path) = std::env::var_os("BILIKARA_TEST_CAST_COMPANION") {
        // Explicit test-only same-build companion, never an HTTP input.
        return unsafe { LibavMetadataProbe::load(Path::new(&path)) }.map_err(|_| {
            ApiError::new(
                501,
                "cast_backend_unavailable",
                "Test companion cannot load",
            )
        });
    }
    let path = crate::media_routing::output_companion().ok_or_else(|| {
        ApiError::new(
            501,
            "cast_backend_unavailable",
            "Cast companion is unavailable",
        )
    })?;
    // Only the existing Host-authorized, same-build companion path is accepted.
    unsafe { LibavMetadataProbe::load(path) }.map_err(|_| {
        ApiError::new(
            501,
            "cast_backend_unavailable",
            "Cast companion cannot load",
        )
    })
}
pub(super) const MAX_BYTES: u64 = 4 * 1024 * 1024 * 1024;

/// The pitch, delay and track a file-mode output renders into its file.
/// Volume and mute stay with the receiver, as before.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct Baked {
    pub key_shift: i32,
    pub offset_ms: i32,
    pub track: String,
}
impl Baked {
    /// The Host's current settings for this item, or None once it is no
    /// longer the current program (T5 retires that output).
    pub(super) fn current(app: &crate::app_state::AppState, item: &PlaylistItem) -> Option<Self> {
        let facts = app.native_output_audio_facts().ok()?;
        (facts.source.0 == item.id
            && facts.source.1 == item.item_incarnation_id
            && facts.source.2 == item.artifact_set_id)
            .then_some(Self {
                key_shift: facts.settings.key_shift,
                offset_ms: facts.settings.av_offset_ms,
                track: facts.track,
            })
    }
    /// Neutral settings keep T3's copied audio: the exact file format the
    /// store self-test qualifies. Anything else is an L1 render.
    pub(super) fn neutral(item: &PlaylistItem) -> Self {
        Self {
            key_shift: 0,
            offset_ms: 0,
            track: item.selected_audio_variant_id.clone(),
        }
    }
    pub(super) fn is_neutral(&self) -> bool {
        self.key_shift == 0 && self.offset_ms == 0
    }
}

pub(super) struct Prepared {
    pub file: CastFile,
    /// What the published file actually contains.
    pub baked: Baked,
    /// Why later DSP edits cannot be rendered for this source (None: an edit
    /// regenerates the file through L1).
    pub refusal: Option<&'static str>,
    /// An L1 render still in progress behind the file's declared length.
    pub growth: Option<Arc<Growth>>,
    /// Source seconds where the file starts: 0 for T3 copies (the receiver
    /// seeks), the keyframe before the requested position for L1 renders.
    pub origin: f64,
}

/// File delivery always starts at 0 and the receiver seeks over SOAP, so a
/// regeneration keeps the existing position and Seek semantics.
pub(super) fn file(
    context: Arc<HostContext>,
    session: Arc<CastSession>,
    item: PlaylistItem,
    wanted: Baked,
    position: f64,
    stop: Arc<AtomicBool>,
) -> tokio::task::JoinHandle<Result<Prepared, ApiError>> {
    tokio::task::spawn_blocking(move || {
        let input = inputs(&context, &item)?;
        let probe = probe()?;
        let t3 = |input: &Inputs| {
            session
                .mux(
                    &probe,
                    &CastInputs {
                        video: &input.video,
                        audio: &input.audio,
                        start_us: 0,
                    },
                    CastFormat::Ts,
                    &stop,
                )
                .map_err(|e| prepare_error(e, "Cannot prepare cast media"))
        };
        if wanted.is_neutral() && wanted.track == item.selected_audio_variant_id {
            let file = t3(&input)?;
            let refusal = l1_refusal(probe.live_l1_available(), &file.summary);
            return Ok(Prepared {
                file,
                baked: Baked::neutral(&item),
                refusal,
                growth: None,
                origin: 0.0,
            });
        }
        let facts = probe
            .cast_preflight(&input.video, &stop)
            .map_err(|e| prepare_error(e, "Cannot inspect cast media"))?;
        if let Some(refusal) = l1_refusal(probe.live_l1_available(), &facts) {
            // Not renderable by L1: the unprocessed copy, as before.
            return Ok(Prepared {
                file: t3(&input)?,
                baked: Baked::neutral(&item),
                refusal: Some(refusal),
                growth: None,
                origin: 0.0,
            });
        }
        // The companion handle is thread-affine (Windows): the renderer
        // thread loads its own and keeps the input leases until it ends.
        drop(probe);
        let (ready, declared) = std::sync::mpsc::sync_channel(1);
        std::thread::Builder::new()
            .name("cast-file-l1".into())
            .spawn(move || render_growing(session, input, facts, wanted, position, stop, ready))
            .map_err(|_| ApiError::new(409, "cast_prepare_failed", "Cannot start cast render"))?;
        let (file, growth, origin, baked) = declared
            .recv()
            .map_err(|_| ApiError::new(409, "cast_prepare_failed", "Cast render ended"))??;
        Ok(Prepared {
            file,
            baked: Baked {
                track: item.selected_audio_variant_id.clone(),
                ..baked
            },
            refusal: None,
            growth: Some(growth),
            origin,
        })
    })
}

/// Seconds of measured bytes added to a growing file's declared length, so a
/// render that runs slightly long is padded rather than truncated.
const DECLARE_MARGIN_S: f64 = 2.0;

type Declared = Result<(CastFile, Arc<Growth>, f64, Baked), ApiError>;

/// File delivery with pitch, delay or track edits (B): one L1 render at full
/// speed from the keyframe before `position`, with a fixed control snapshot
/// and the selected track. Its CBR rate is measured from the first rendered
/// seconds; the file is then published at a declared length (`ready`) while
/// rendering continues, and finally padded with null packets to that length.
/// A render that would exceed it is cut at the declared length.
fn render_growing(
    session: Arc<CastSession>,
    input: Inputs,
    facts: CastSummary,
    wanted: Baked,
    position: f64,
    stop: Arc<AtomicBool>,
    ready: std::sync::mpsc::SyncSender<Declared>,
) {
    let growth = Growth::new();
    let mut ready = Some(ready);
    let mut declared: Option<u64> = None;
    let mut truncated = false;
    let result = (|| -> Result<(), ApiError> {
        let failed = |e| prepare_error(e, "Cannot render cast media");
        let probe = probe()?;
        let mut growing = session.growing_ts().map_err(failed)?;
        let control = Control {
            offset_ms: wanted.offset_ms,
            key_shift: wanted.key_shift,
            volume_percent: 100,
            muted: false,
            track: 0,
            mode: bilikara_rust::output_audio::OffsetMode::Splice,
        };
        let end_us = facts.source_start_us.saturating_add(facts.duration_us);
        let mut origin_us = facts.source_start_us;
        let mut mark: Option<(i64, u64)> = None;
        let mut error = None;
        let mut declare = |growing: &mut GrowingTs, length: u64, origin_us: i64| {
            let summary = CastSummary {
                packets: 0,
                bytes: 0,
                audio_transcoded: true,
                source_start_us: origin_us,
                duration_us: end_us.saturating_sub(origin_us).max(1),
                ..facts.clone()
            };
            let file = growing.declare(length, summary)?;
            growth.advance(growing.written());
            if let Some(ready) = ready.take() {
                let _ = ready.send(Ok((
                    file,
                    growth.clone(),
                    origin_us as f64 / 1_000_000.0,
                    wanted.clone(),
                )));
            }
            Ok::<u64, ProbeError>(length)
        };
        let rendered = probe.render_live_ts_with_events(
            &input.video,
            &[input.audio.as_path()],
            (position * 1_000_000.0) as i64,
            &stop,
            &mut |event| match event {
                Event::Start(start) => {
                    origin_us = start.source_start_us;
                    true
                }
                Event::Data { bytes, time_us, .. } => {
                    if growth.abandoned() {
                        return false;
                    }
                    let room = declared.map_or(u64::MAX, |length| length - growing.written());
                    let take = if (bytes.len() as u64) <= room {
                        bytes.len()
                    } else {
                        (room - room % 188) as usize
                    };
                    if let Err(e) = growing.write(&bytes[..take]) {
                        error = Some(e);
                        return false;
                    }
                    if take < bytes.len() {
                        truncated = true;
                        growth.advance(growing.written());
                        return false;
                    }
                    if declared.is_some() {
                        growth.advance(growing.written());
                        return true;
                    }
                    // Measure the constant mux rate over two rendered seconds.
                    match mark {
                        None if time_us >= 1_000_000 => mark = Some((time_us, growing.written())),
                        Some((at, bytes_at)) if time_us >= at + 2_000_000 => {
                            let rate = (growing.written() - bytes_at) as f64
                                / ((time_us - at) as f64 / 1_000_000.0);
                            let left = (end_us - origin_us - time_us).max(0) as f64 / 1_000_000.0;
                            let length = growing.written() as f64
                                + rate * (left + DECLARE_MARGIN_S)
                                + 64.0 * 1024.0;
                            match declare(
                                &mut growing,
                                (length as u64).div_ceil(188) * 188,
                                origin_us,
                            ) {
                                Ok(length) => declared = Some(length),
                                Err(e) => {
                                    error = Some(e);
                                    return false;
                                }
                            }
                        }
                        _ => {}
                    }
                    true
                }
            },
            &mut || Ok(control),
        );
        if let Some(e) = error {
            return Err(failed(e));
        }
        if !truncated {
            rendered.map_err(failed)?;
        }
        if growth.abandoned() {
            return Ok(());
        }
        // Shorter than the measuring window: publish the exact length.
        if declared.is_none() {
            let length = growing.written();
            declared = Some(declare(&mut growing, length, origin_us).map_err(failed)?);
        }
        growing.finish().map_err(failed)?;
        growth.complete(growing.written());
        if truncated {
            eprintln!("[cast] file render exceeded its declared length and was cut");
        }
        Ok(())
    })();
    if let Err(e) = result {
        match ready.take() {
            Some(ready) => {
                let _ = ready.send(Err(e));
            }
            None => growth.fail(),
        }
    }
}
pub(super) struct Live {
    pub stream: Arc<LiveStream>,
    pub l1: bool,
    /// Track ids the L1 producer renders; empty for the raw T3 stream.
    pub tracks: Vec<String>,
    /// Why this live stream is raw T3 instead of L1.
    pub refusal: Option<&'static str>,
    task: Option<tokio::task::JoinHandle<Result<(), ApiError>>>,
}
impl Live {
    pub async fn check(&mut self) -> Result<(), ApiError> {
        if self.task.as_ref().is_some_and(|task| task.is_finished()) {
            self.task
                .take()
                .unwrap()
                .await
                .map_err(|_| ApiError::new(409, "cast_prepare_failed", "Live producer failed"))??;
        }
        Ok(())
    }
    pub async fn stop(self) {
        self.stream.cancel();
        if let Some(task) = self.task {
            let _ = task.await;
        }
    }
}
pub(super) async fn live(
    context: Arc<HostContext>,
    item: PlaylistItem,
    position: f64,
    identity: (u64, u64),
    cancel: &CancellationToken,
) -> Result<Live, ApiError> {
    // Fail before publishing a URI when the selected input or companion is absent.
    let (stream, producer) = LiveStream::external(LiveOptions::default())
        .map_err(|_| ApiError::invalid("Invalid live options"))?;
    let producing = stream.clone();
    let (ready, started) = tokio::sync::oneshot::channel();
    let task = tokio::task::spawn_blocking(move || {
        // The companion handle is thread-affine on Windows; initialize and use
        // it on this producer, acknowledge readiness before publishing its URI.
        let prepared = (|| {
            let probe = probe()?;
            let base = inputs(&context, &item)?;
            // One read-only packet pass decides L1 and is reused by it.
            let facts = probe
                .cast_preflight(&base.video, producing.cancellation())
                .map_err(|e| prepare_error(e, "Cannot inspect live media"))?;
            let refusal = l1_refusal(probe.live_l1_available(), &facts);
            // Keep the base leases until the L1 set holds its own pins.
            let input = if refusal.is_none() {
                inputs_for(&context, &item, true)?
            } else {
                base
            };
            Ok((input, probe, facts, refusal))
        })();
        let (input, probe, facts, refusal) = match prepared {
            Ok(prepared) => prepared,
            Err(e) => {
                let _ = ready.send(Err(e));
                producing.cancel();
                return Ok(());
            }
        };
        let tracks = input.tracks.iter().map(|(id, _)| id.clone()).collect();
        if ready.send(Ok((refusal, tracks))).is_err() {
            producing.cancel();
            return Ok(());
        }
        if refusal.is_none() {
            return super::l1::generate(
                &probe, &input, &item, facts, position, identity, producing, producer,
            );
        }
        producer
            .generate(
                &probe,
                &CastInputs {
                    video: &input.video,
                    audio: &input.audio,
                    start_us: (position * 1_000_000.0) as i64,
                },
                MAX_BYTES,
            )
            .map(|_| ())
            .map_err(|_| ApiError::new(409, "cast_prepare_failed", "Cannot generate live media"))
    });
    let initialized = started.await.unwrap_or_else(|_| {
        Err(ApiError::new(
            409,
            "cast_prepare_failed",
            "Live producer failed",
        ))
    });
    let (refusal, tracks) = match initialized {
        Ok(prepared) => prepared,
        Err(e) => {
            stream.cancel();
            let _ = task.await;
            return Err(e);
        }
    };
    let mut live = Live {
        stream,
        l1: refusal.is_none(),
        tracks,
        refusal,
        task: Some(task),
    };
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    while live.stream.snapshot().start.is_none() {
        if cancel.is_cancelled() || tokio::time::Instant::now() >= deadline {
            live.stop().await;
            return Err(ApiError::new(
                409,
                "cast_prepare_failed",
                "Live start unavailable",
            ));
        }
        if let Err(error) = live.check().await {
            live.stop().await;
            return Err(error);
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    Ok(live)
}

#[cfg(test)]
mod android_tests;

#[cfg(test)]
mod selection_tests {
    use super::*;

    fn variants(spec: &[(&str, bool)]) -> Vec<serde_json::Map<String, Value>> {
        spec.iter()
            .map(|(id, cached)| {
                let mut v = json!({"id":id});
                if *cached {
                    v["audio_url"] = json!(format!("/media/{id}.m4a"));
                }
                v.as_object().unwrap().clone()
            })
            .collect()
    }

    #[test]
    fn l1_sends_the_selected_track_and_one_cached_partner_in_item_order() {
        let pair = variants(&[("original", true), ("instrumental", true)]);
        assert_eq!(
            l1_track_ids(&pair, "instrumental"),
            ["original", "instrumental"]
        );
        // More than the ABI's two tracks: the selected one plus the first
        // other cached variant; uncached variants no longer refuse L1.
        let pages = variants(&[("p1", false), ("p2", true), ("p3", true), ("p4", true)]);
        assert_eq!(l1_track_ids(&pages, "p4"), ["p2", "p4"]);
        assert_eq!(l1_track_ids(&pages, "p2"), ["p2", "p3"]);
        assert_eq!(l1_track_ids(&variants(&[("solo", true)]), "solo"), ["solo"]);
        // The selected track must itself be cached (inputs() refuses first).
        assert_eq!(l1_track_ids(&pages, "p1"), ["p2"]);
    }

    #[test]
    fn l1_refusal_reports_the_companion_and_the_four_second_keyframe_limit() {
        let facts = |gop_us: Option<i64>, duration_us: i64| CastSummary {
            packets: 1,
            bytes: 1,
            profile: 100,
            level: 40,
            width: 1920,
            height: 1080,
            has_b_frames: false,
            audio_transcoded: false,
            source_start_us: 0,
            duration_us,
            gop_us,
        };
        assert_eq!(l1_refusal(true, &facts(Some(2_000_000), 240_000_000)), None);
        assert_eq!(l1_refusal(true, &facts(Some(4_000_000), 240_000_000)), None);
        assert_eq!(
            l1_refusal(true, &facts(Some(4_000_001), 240_000_000)),
            Some("long_gop")
        );
        // A single keyframe makes the whole video one group of pictures.
        assert_eq!(l1_refusal(true, &facts(None, 3_000_000)), None);
        assert_eq!(l1_refusal(true, &facts(None, 9_000_000)), Some("long_gop"));
        assert_eq!(
            l1_refusal(false, &facts(Some(1_000_000), 9_000_000)),
            Some("l1_unavailable")
        );
    }
}
