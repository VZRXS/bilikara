use super::*;
use crate::app_state::PlaylistItem;
use crate::dlna::cast_http::{LiveOptions, LiveStream};
use crate::experimental_libav::{
    LibavMetadataProbe, ProbeError,
    cast_mux::{CastFile, CastFormat, CastInputs, CastSession, CastSummary},
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
fn inputs_for(context: &HostContext, item: &PlaylistItem, l1: bool) -> Result<Inputs, ApiError> {
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
pub(super) fn file(
    context: Arc<HostContext>,
    session: Arc<CastSession>,
    item: PlaylistItem,
    position: f64,
    stop: Arc<AtomicBool>,
) -> tokio::task::JoinHandle<Result<CastFile, ApiError>> {
    tokio::task::spawn_blocking(move || {
        let input = inputs(&context, &item)?;
        let probe = probe()?;
        session
            .mux(
                &probe,
                &CastInputs {
                    video: &input.video,
                    audio: &input.audio,
                    start_us: (position * 1_000_000.0) as i64,
                },
                CastFormat::Ts,
                &stop,
            )
            .map_err(|e| prepare_error(e, "Cannot prepare cast media"))
    })
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
