//! Retained next L1 local/Audience pipeline; network delivery belongs to T4/T5. All session admissions/transitions use AppState;
//! worker handles, bounded transport buffers and libav resources do no policy.
use super::*;
use crate::experimental_libav::{LibavMetadataProbe, StreamType};
use std::{
    path::{Path, PathBuf},
    sync::mpsc,
};

struct Readers(Vec<String>);
impl Drop for Readers {
    fn drop(&mut self) {
        let _ = with_app(|app| {
            for handle in &self.0 {
                app.native_unpin_media(handle);
            }
            Ok(())
        });
    }
}
struct Prepared {
    video: PathBuf,
    audio: Vec<PathBuf>,
    tracks: Vec<String>,
    companion: PathBuf,
    start: i64,
    duration_us: i64,
    signature: String,
    _readers: Readers,
}
pub(super) fn signature(
    app: &mut crate::app_state::AppState,
    _l1: bool,
) -> Result<String, ApiError> {
    let facts = app.native_output_audio_facts()?;
    Ok(json!([
        facts.source.0,
        facts.source.1,
        facts.source.2,
        app.native().local_output.program_epoch
    ])
    .to_string())
}
fn path(root: &Path, route: &str) -> Result<PathBuf, ApiError> {
    let relative = route
        .strip_prefix("/media/")
        .and_then(super::super::files::safe_relative)
        .filter(|p| p.starts_with("artifacts"))
        .ok_or_else(|| failure(409, "output_media", "缓存媒体不可用"))?;
    let path = root
        .join(relative)
        .canonicalize()
        .map_err(|_| failure(409, "output_media", "请重新缓存当前歌曲"))?;
    let root = root
        .canonicalize()
        .map_err(|_| failure(409, "output_media", "缓存目录不可用"))?;
    if !path.starts_with(root) {
        return Err(failure(409, "output_media", "缓存媒体不可用"));
    }
    Ok(path)
}
/// Known codec names only; anything else is reported as "other".
fn codec_name(name: Option<&str>) -> &'static str {
    match name {
        Some("h264") => "h264",
        Some("hevc") => "hevc",
        Some("av1") => "av1",
        Some("aac") => "aac",
        Some("flac") => "flac",
        Some("eac3") => "eac3",
        Some("ac3") => "ac3",
        Some("mp3") => "mp3",
        Some("opus") => "opus",
        None => "unknown",
        Some(_) => "other",
    }
}
fn prepare(
    context: &HostContext,
    position: Option<f64>,
    trace: &super::trace::OutputTrace,
) -> Result<Prepared, ApiError> {
    let (video, audio, tracks, start, signature, handles) = with_app(|app| {
        let state = app.native_core_snapshot()?;
        let item = state
            .current_item
            .as_ref()
            .filter(|i| i.cache_status == "ready")
            .ok_or_else(|| failure(409, "output_media", "请先缓存当前歌曲"))?;
        let video = item.video_media_url.clone();
        let variants = item.audio_variants.iter().collect::<Vec<_>>();
        if variants.is_empty() || variants.len() > 2 {
            return Err(failure(409, "output_media", "L1 需要一至两条已缓存音轨"));
        }
        let audio = variants
            .iter()
            .map(|v| {
                v["audio_url"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .ok_or_else(|| failure(409, "output_media", "音轨未缓存"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let tracks = variants
            .iter()
            .map(|v| v["id"].as_str().unwrap_or_default().to_owned())
            .collect::<Vec<_>>();
        if !tracks.contains(&item.selected_audio_variant_id) {
            return Err(failure(409, "output_media", "所选音轨未缓存"));
        }
        let observed = app.native_snapshot(true)?;
        let start = position.unwrap_or_else(|| {
            observed["player_status"]["current_time"]
                .as_f64()
                .filter(|v| v.is_finite() && (0.0..=21600.0).contains(v))
                .unwrap_or(0.0)
        });
        let signature = signature(app, true)?;
        let mut handles = Vec::new();
        for route in std::iter::once(&video).chain(audio.iter()) {
            match app.native_pin_media(route) {
                Ok(h) => handles.push(h),
                Err(e) => {
                    for h in handles {
                        app.native_unpin_media(&h);
                    }
                    return Err(e);
                }
            }
        }
        Ok((
            video,
            audio,
            tracks,
            (start * 1_000_000.0) as i64,
            signature,
            handles,
        ))
    })?;
    let readers = Readers(handles);
    let companion = crate::media_routing::output_companion()
        .ok_or_else(|| {
            failure(
                501,
                "output_backend_unavailable",
                "此平台未提供 live MPEG-TS libav 管线",
            )
        })?
        .to_owned();
    // SAFETY: selected by the trusted Host startup configuration, not an API path.
    let probe = unsafe { LibavMetadataProbe::load(&companion) }.map_err(|_| {
        failure(
            501,
            "output_backend_unavailable",
            "live MPEG-TS libav 管线不可用",
        )
    })?;
    if !probe.live_ts_available() || !probe.live_l1_available() {
        return Err(failure(
            501,
            "output_backend_unavailable",
            "请使用包含 live MPEG-TS companion 的构建",
        ));
    }
    let video = path(&context.cache_root, &video)?;
    let audio = audio
        .iter()
        .map(|a| path(&context.cache_root, a))
        .collect::<Result<Vec<_>, _>>()?;
    let cancelled = AtomicBool::new(false);
    let mut duration_us = 0;
    let mut video_codec = "unknown";
    let mut audio_codecs = Vec::new();
    for (source, kind, codec) in std::iter::once((&video, StreamType::Video, Some("h264")))
        .chain(audio.iter().map(|a| (a, StreamType::Audio, None)))
    {
        let metadata = probe
            .probe_metadata(source, &cancelled)
            .map_err(|_| failure(409, "output_media", "媒体检查失败，请重新缓存"))?;
        let name = codec_name(
            metadata
                .streams
                .first()
                .and_then(|s| s.codec_name.as_deref()),
        );
        if kind == StreamType::Video {
            video_codec = name;
        } else {
            audio_codecs.push(name);
        }
        if kind == StreamType::Video {
            duration_us = metadata
                .duration_us
                .or_else(|| metadata.streams.first().and_then(|s| s.duration_us))
                .unwrap_or(0);
        }
        if metadata.streams.len() != 1
            || metadata.streams[0].media_type != kind
            || codec.is_some_and(|c| metadata.streams[0].codec_name.as_deref() != Some(c))
            || (codec.is_none()
                && !matches!(
                    metadata.streams[0].codec_name.as_deref(),
                    Some("aac" | "flac" | "eac3" | "ac3" | "mp3" | "opus")
                ))
        {
            trace.preflight(json!({"outcome":"failed","code":"purek_output_codec",
                "video_codec":video_codec,"audio_codecs":audio_codecs}));
            return Err(failure(
                409,
                "output_codec",
                "本机管线需要 H.264 视频和受支持的音轨，请重新缓存",
            ));
        }
    }
    trace.preflight(
        json!({"outcome":"ok","video_codec":video_codec,"audio_codecs":audio_codecs,
        "duration_ms":duration_us / 1000,"start_ms":start / 1000}),
    );
    Ok(Prepared {
        video,
        audio,
        tracks,
        companion,
        start,
        duration_us,
        signature,
        _readers: readers,
    })
}

pub(super) fn start_managed(
    context: &Arc<HostContext>,
    position: f64,
    version: u64,
) -> Result<Value, ApiError> {
    let managed = Some((position, version));
    let (generation, trace) = with_app(|app| {
        let session = app.native();
        let room = &mut session.local_output;
        if managed.is_some_and(|(_, v)| !room.controller.managed(v))
            || (managed.is_none() && room.controller.owns_playback)
        {
            return Err(busy());
        }
        if room.busy || room.output.running.is_some() {
            return Err(busy());
        }
        let trace = trace::OutputTrace::new();
        room.diagnostics.begin_output(trace.clone());
        room.busy = true;
        room.generation += 1;
        session.revision += 1;
        Ok((room.generation, trace))
    })?;
    let result = (|| {
        super::super::output_platform::apply(
            super::super::output_platform::OutputActivity::Playing,
        )?;
        let prepared = prepare(context, managed.map(|(p, _)| p), &trace)?;
        let expected = prepared.signature.clone();
        let mut running = stream::Running::new(generation, trace.clone())?;
        {
            let preview = with_app(|app| {
                Ok(app
                    .native()
                    .local_output
                    .local_preview
                    .get_or_insert_with(|| {
                        Arc::new(super::preview::Preview::new(
                            running.preview_nonce(),
                            context.stop.clone(),
                        ))
                    })
                    .clone())
            })?;
            preview.begin(generation);
            Arc::get_mut(&mut running).unwrap().preview = Some(preview);
        }
        running
            .duration_us
            .store(prepared.duration_us, Ordering::Release);
        with_app(|app| {
            if app.native().local_output.generation != generation
                || managed.is_some_and(|(_, v)| !app.native().local_output.controller.managed(v))
                || signature(app, true)? != expected
            {
                return Err(failure(
                    409,
                    "output_context_changed",
                    "歌曲或播放设置已变化，请重试",
                ));
            }
            app.native()
                .local_output
                .output
                .begin(generation, running.clone());
            app.native().revision += 1;
            Ok(())
        })?;
        let worker = running.clone();
        let control_expected = expected.clone();
        let (send, ready) = mpsc::sync_channel(1);
        context
            .spawn("purek-ts-pipeline", move || {
                let _readers = prepared._readers;
                // SAFETY: same trusted artifact as preflight, loaded on its owning thread.
                let result =
                    unsafe { LibavMetadataProbe::load(&prepared.companion) }.and_then(|probe| {
                        let mut sent = false;
                        let mut visit = |bytes: &[u8], time, key| {
                            let accepted = worker.push(bytes, time, key);
                            if accepted && !sent {
                                worker.trace.first_packet();
                                let _ = send.try_send(true);
                                sent = true;
                            }
                            accepted
                        };
                        let result = {
                            let paths = prepared
                                .audio
                                .iter()
                                .map(PathBuf::as_path)
                                .collect::<Vec<_>>();
                            probe.render_live_ts(
                                &prepared.video,
                                &paths,
                                prepared.start,
                                &worker.stop,
                                &mut visit,
                                &mut || {
                                    with_app(|app| {
                                        if app.native().local_output.generation != generation
                                            || signature(app, true)? != control_expected
                                        {
                                            return Err(busy());
                                        }
                                        let mode = app.native().local_output.output.mode;
                                        let facts = app.native_output_audio_facts()?;
                                        let track = prepared
                                            .tracks
                                            .iter()
                                            .position(|t| t == &facts.track)
                                            .ok_or_else(|| {
                                                failure(409, "output_media", "所选音轨未缓存")
                                            })?;
                                        Ok(crate::experimental_libav::live_audio::Control {
                                            offset_ms: facts.settings.av_offset_ms,
                                            key_shift: facts.settings.key_shift,
                                            volume_percent: facts.settings.volume_percent,
                                            muted: facts.settings.is_muted,
                                            track,
                                            mode,
                                        })
                                    })
                                    .map_err(|_| {
                                        crate::experimental_libav::ProbeError::BackendFailure(
                                            "L1 output context changed".into(),
                                        )
                                    })
                                },
                            )
                        };
                        if !sent {
                            let _ = send.try_send(false);
                        }
                        result
                    });
                worker.finished(result.is_err());
                worker.trace.pipeline_end(match &result {
                    Ok(_) => "completed",
                    Err(_) if worker.stop.load(Ordering::Acquire) => "cancelled",
                    Err(_) => "failed",
                });
                if result.is_err() && !worker.stop.load(Ordering::Acquire) {
                    worker.cancel();
                    if managed.is_some() {
                        let _ = with_app(|app| {
                            if signature(app, true).is_ok_and(|s| s == control_expected)
                                && app.native().local_output.generation == generation
                            {
                                app.native()
                                    .local_output
                                    .controller
                                    .fail("purek_output_pipeline");
                                app.native().revision += 1;
                            }
                            Ok(())
                        });
                    }
                    pipeline_error(generation);
                }
            })
            .map_err(|_| network_error())?;
        if ready.recv_timeout(Duration::from_secs(6)) != Ok(true)
            || running.stop.load(Ordering::Acquire)
        {
            return Err(failure(
                502,
                "output_pipeline",
                "媒体封装失败，请检查缓存编码和原生媒体构建",
            ));
        }
        if managed.is_some_and(|(_, v)| {
            !with_app(|app| {
                Ok(app.native().local_output.controller.managed(v)
                    && signature(app, true).is_ok_and(|s| s == expected))
            })
            .unwrap_or(false)
        }) {
            return Err(busy());
        }
        if running.stop.load(Ordering::Acquire) {
            return Err(failure(502, "output_pipeline", "媒体管线已结束"));
        }
        running.played.store(true, Ordering::Release);
        running.publish();
        let monitor = context.clone();
        let watch = running.clone();
        context
            .spawn("local-output-monitor", move || {
                monitor_preview(monitor, watch, generation, expected);
            })
            .map_err(|_| network_error())?;
        Ok(())
    })();
    if let Err(error) = &result {
        trace.terminal(Some(&error.code));
    }
    if result.is_err() {
        let _ = with_app(|app| {
            if app.native().local_output.generation == generation {
                app.native().local_output.output.end(
                    generation,
                    false,
                    result.as_ref().err().map(|e| e.code.as_str()),
                );
                app.native().revision += 1;
                return Ok(true);
            }
            Ok(false)
        })
        .unwrap_or(false);
    }
    with_app(|app| {
        if app.native().local_output.generation != generation {
            return Err(busy());
        }
        app.native().local_output.busy = false;
        app.native().revision += 1;
        result.map(|_| snapshot(app.native()))
    })
}
pub(super) fn mark_streaming(generation: u64) {
    let _ = with_app(|app| {
        if app.native().local_output.generation == generation
            && app.native().local_output.output.streaming(generation)
        {
            app.native().local_output.controller.streaming();
            app.native().revision += 1;
        }
        Ok(())
    });
}
fn pipeline_error(generation: u64) {
    let _ = with_app(|app| {
        if app.native().local_output.generation == generation {
            app.native().local_output.output.pipeline_error();
            app.native().revision += 1;
        }
        Ok(())
    });
}
pub(super) fn stop(paused: bool, error: Option<&str>) -> Result<Value, ApiError> {
    stop_generation(paused, error, None)
}
fn stop_generation(
    paused: bool,
    error: Option<&str>,
    expected: Option<u64>,
) -> Result<Value, ApiError> {
    let generation = with_app(|app| {
        let session = app.native();
        let room = &mut session.local_output;
        if room.busy || expected.is_some_and(|g| room.generation != g) {
            return Err(busy());
        }
        let active = room.output.running.is_some();
        if paused && !active {
            return Err(failure(409, "output_not_running", "当前没有试播输出"));
        }
        room.busy = true;
        room.generation += 1;
        room.output.end(room.generation, paused, error);
        session.revision += 1;
        Ok(room.generation)
    })?;
    with_app(|app| {
        let session = app.native();
        if session.local_output.generation != generation {
            return Err(busy());
        }
        session.local_output.busy = false;
        session.revision += 1;
        Ok(snapshot(session))
    })
}
fn record_preview_failure(controller: &mut super::controller::Controller) -> String {
    // Pipeline/decoder failure may cancel the producer before this monitor
    // observes it. Keep that primary error through cleanup; a cancellation
    // caused by the failure is not a new missing-consumer diagnosis.
    if let Some(primary) = &controller.error {
        return primary.clone();
    }
    controller.fail("purek_output_preview_lost");
    "purek_output_preview_lost".into()
}

fn monitor_preview(
    context: Arc<HostContext>,
    running: Arc<stream::Running>,
    generation: u64,
    expected: String,
) {
    let started = Instant::now();
    while !context.stop.load(Ordering::Acquire) {
        let current = with_app(|app| {
            Ok(app.native().local_output.generation == generation
                && app.native().local_output.controller.local_preview
                && signature(app, true).ok().as_deref() == Some(&expected))
        })
        .unwrap_or(false);
        if !current {
            running.cancel();
            break;
        }
        if running.stop.load(Ordering::Acquire)
            || (started.elapsed() > Duration::from_secs(10) && !running.has_consumer())
        {
            let code = with_app(|app| {
                if app.native().local_output.generation != generation {
                    return Ok(None);
                }
                let code = record_preview_failure(&mut app.native().local_output.controller);
                app.native().revision += 1;
                Ok(Some(code))
            })
            .ok()
            .flatten();
            if let Some(code) = code {
                let _ = stop_generation(false, Some(&code), Some(generation));
            }
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preview_loss_preserves_the_primary_pipeline_or_decoder_error() {
        for primary in ["purek_output_pipeline", "purek_output_preview_decode"] {
            let mut controller = super::super::controller::Controller::default();
            controller.fail(primary);
            assert_eq!(record_preview_failure(&mut controller), primary);
            assert_eq!(controller.error.as_deref(), Some(primary));
            assert!(controller.release_platform);
        }
        let mut controller = super::super::controller::Controller::default();
        assert_eq!(
            record_preview_failure(&mut controller),
            "purek_output_preview_lost"
        );
        assert_eq!(
            controller.error.as_deref(),
            Some("purek_output_preview_lost")
        );
        assert!(controller.release_platform);
    }
}
