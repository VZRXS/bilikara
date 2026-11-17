use super::*;
use crate::app_state::PlaylistItem;
use crate::dlna::cast_http::{LiveOptions, LiveStream};
use crate::experimental_libav::{
    LibavMetadataProbe,
    cast_mux::{CastFile, CastFormat, CastInputs, CastSession},
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
        for variant in &item.audio_variants {
            let id = variant["id"]
                .as_str()
                .filter(|id| !id.is_empty())
                .ok_or_else(|| ApiError::invalid("Invalid L1 track"))?;
            let route = variant["audio_url"]
                .as_str()
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
            .map_err(|_| ApiError::new(409, "cast_prepare_failed", "Cannot prepare cast media"))
    })
}
pub(super) struct Live {
    pub stream: Arc<LiveStream>,
    pub l1: bool,
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
            let l1 = probe.live_l1_available() && (1..=2).contains(&item.audio_variants.len());
            Ok((inputs_for(&context, &item, l1)?, probe, l1))
        })();
        let (input, probe, l1) = match prepared {
            Ok(prepared) => prepared,
            Err(e) => {
                let _ = ready.send(Err(e));
                producing.cancel();
                return Ok(());
            }
        };
        if ready.send(Ok(l1)).is_err() {
            producing.cancel();
            return Ok(());
        }
        if l1 {
            return super::l1::generate(
                &probe, &input, &item, position, identity, producing, producer,
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
    let l1 = match initialized {
        Ok(l1) => l1,
        Err(e) => {
            stream.cancel();
            let _ = task.await;
            return Err(e);
        }
    };
    let mut live = Live {
        stream,
        l1,
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
