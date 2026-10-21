//! P1 application service. All session admissions/transitions use AppState;
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
    l1: bool,
) -> Result<String, ApiError> {
    let facts = app.native_output_audio_facts()?;
    Ok(if l1 {
        json!([
            facts.source.0,
            facts.source.1,
            facts.source.2,
            app.native().purek.program_epoch
        ])
    } else {
        json!([facts.source, facts.track, facts.settings])
    }
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
fn prepare(context: &HostContext, l1: bool, position: Option<f64>) -> Result<Prepared, ApiError> {
    let (video, audio, tracks, start, signature, handles) = with_app(|app| {
        let state = app.native_core_snapshot()?;
        let item = state
            .current_item
            .as_ref()
            .filter(|i| i.cache_status == "ready")
            .ok_or_else(|| failure(409, "output_media", "请先缓存当前歌曲"))?;
        let settings = &state.player_settings;
        if !l1
            && (settings.av_offset_ms != 0
                || settings.key_shift != 0
                || settings.volume_percent != 100
                || settings.is_muted)
        {
            return Err(failure(
                409,
                "output_l1_required",
                "L0 不处理音画延迟、变调或增益，请恢复默认设置后试播",
            ));
        }
        let video = item.video_media_url.clone();
        let variants = item
            .audio_variants
            .iter()
            .filter(|v| l1 || v["id"].as_str() == Some(item.selected_audio_variant_id.as_str()))
            .collect::<Vec<_>>();
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
        let signature = signature(app, l1)?;
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
    if !probe.live_ts_available() || (l1 && !probe.live_l1_available()) {
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
    for (source, kind, codec) in std::iter::once((&video, StreamType::Video, Some("h264"))).chain(
        audio
            .iter()
            .map(|a| (a, StreamType::Audio, if l1 { None } else { Some("aac") })),
    ) {
        let metadata = probe
            .probe_metadata(source, &cancelled)
            .map_err(|_| failure(409, "output_media", "媒体检查失败，请重新缓存"))?;
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
            return Err(failure(
                409,
                "output_codec",
                "投屏需要 H.264 视频；L0 还需要 AAC 音轨。请使用 AVC 和兼容音频重新缓存，FLAC 等音频需选择 L1",
            ));
        }
    }
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

pub(super) fn start(context: &Arc<HostContext>, body: &Value) -> Result<Value, ApiError> {
    let object = body
        .as_object()
        .ok_or_else(|| ApiError::invalid("JSON object required"))?;
    if object
        .keys()
        .any(|k| !matches!(k.as_str(), "experimental" | "framing" | "pipeline"))
        || body["experimental"] != true
    {
        return Err(failure(
            400,
            "output_experimental",
            "试播需要明确指定 experimental: true",
        ));
    }
    let l1 = match body.get("pipeline") {
        None => false,
        Some(Value::String(v)) if v == "L0" => false,
        Some(Value::String(v)) if v == "L1" => true,
        _ => return Err(ApiError::invalid("pipeline must be L0 or L1")),
    };
    let framing = match body.get("framing") {
        None => stream::Framing::Close,
        Some(Value::String(v)) if v == "close" => stream::Framing::Close,
        Some(Value::String(v)) if v == "chunked" => stream::Framing::Chunked,
        _ => return Err(ApiError::invalid("framing must be close or chunked")),
    };
    start_inner(context, l1, framing, None)
}
pub(super) fn start_managed(
    context: &Arc<HostContext>,
    position: f64,
    version: u64,
) -> Result<Value, ApiError> {
    start_inner(
        context,
        true,
        stream::Framing::Close,
        Some((position, version)),
    )
}
fn start_inner(
    context: &Arc<HostContext>,
    l1: bool,
    framing: stream::Framing,
    managed: Option<(f64, u64)>,
) -> Result<Value, ApiError> {
    let (generation, connection, info) = with_app(|app| {
        let session = app.native();
        let room = &mut session.purek;
        if managed.is_some_and(|(_, v)| !room.controller.managed(v))
            || (managed.is_none() && room.controller.owns_playback)
        {
            return Err(busy());
        }
        if room.busy || room.output.running.is_some() {
            return Err(busy());
        }
        let connection = room
            .connected
            .clone()
            .ok_or_else(|| failure(409, "not_authorized", "请先授权房台"))?;
        let info = room.output.protocol()?;
        room.busy = true;
        room.generation += 1;
        session.revision += 1;
        Ok((room.generation, connection, info))
    })?;
    let mut control_started = false;
    let result = (|| {
        super::super::output_platform::apply(
            super::super::output_platform::OutputActivity::Playing,
        )?;
        let prepared = prepare(context, l1, managed.map(|(p, _)| p))?;
        let expected = prepared.signature.clone();
        let running = stream::Running::with_protocol(generation, framing, l1, info)?;
        running
            .duration_us
            .store(prepared.duration_us, Ordering::Release);
        with_app(|app| {
            if app.native().purek.generation != generation
                || managed.is_some_and(|(_, v)| !app.native().purek.controller.managed(v))
                || signature(app, l1)? != expected
            {
                return Err(failure(
                    409,
                    "output_context_changed",
                    "歌曲或播放设置已变化，请重试",
                ));
            }
            app.native().purek.output.begin(generation, running.clone());
            app.native().revision += 1;
            Ok(())
        })?;
        let uri = running.bind(
            context,
            connection.local,
            protocol::local_address(&connection.room.description)?,
        )?;
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
                                let _ = send.try_send(true);
                                sent = true;
                            }
                            accepted
                        };
                        let result = if l1 {
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
                                        if app.native().purek.generation != generation
                                            || signature(app, true)? != control_expected
                                        {
                                            return Err(busy());
                                        }
                                        let mode = app.native().purek.output.mode;
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
                        } else {
                            probe.copy_live_ts(
                                &prepared.video,
                                &prepared.audio[0],
                                prepared.start,
                                &worker.stop,
                                &mut visit,
                            )
                        };
                        if !sent {
                            let _ = send.try_send(false);
                        }
                        result
                    });
                worker.finished(result.is_err());
                if result.is_err() && !worker.stop.load(Ordering::Acquire) {
                    worker.cancel();
                    if managed.is_some() {
                        let _ = with_app(|app| {
                            if signature(app, l1).is_ok_and(|s| s == control_expected)
                                && app.native().purek.generation == generation
                            {
                                app.native().purek.controller.fail("purek_output_pipeline");
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
        control_started = true;
        renderer::start_transport(&connection, &uri, &info.info())?;
        if managed.is_some_and(|(_, v)| {
            !with_app(|app| {
                Ok(app.native().purek.controller.managed(v)
                    && signature(app, l1).is_ok_and(|s| s == expected))
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
        let receiver = connection.clone();
        context
            .spawn("purek-output-monitor", move || {
                monitor_output(
                    monitor,
                    watch,
                    receiver,
                    generation,
                    expected,
                    managed.is_some(),
                )
            })
            .map_err(|_| network_error())?;
        Ok(())
    })();
    if result.is_err() {
        let owned = with_app(|app| {
            if app.native().purek.generation == generation {
                app.native().purek.output.end(
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
        // The operation lease remains claimed until rollback SOAP finishes.
        if control_started && owned {
            let _ = renderer::transport(&connection, "Stop", "");
        }
    }
    with_app(|app| {
        if app.native().purek.generation != generation {
            return Err(busy());
        }
        app.native().purek.busy = false;
        app.native().revision += 1;
        result.map(|_| snapshot(app.native()))
    })
}
pub(super) fn mark_streaming(generation: u64) {
    let _ = with_app(|app| {
        if app.native().purek.generation == generation
            && app.native().purek.output.streaming(generation)
        {
            app.native().purek.controller.streaming();
            app.native().revision += 1;
        }
        Ok(())
    });
}
fn pipeline_error(generation: u64) {
    let _ = with_app(|app| {
        if app.native().purek.generation == generation {
            app.native().purek.output.pipeline_error();
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
    let (generation, connection) = with_app(|app| {
        let session = app.native();
        let room = &mut session.purek;
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
        Ok((room.generation, room.connected.clone().filter(|_| active)))
    })?;
    let result = connection
        .as_ref()
        .map(|c| renderer::transport(c, "Stop", ""))
        .transpose();
    with_app(|app| {
        let session = app.native();
        if session.purek.generation != generation {
            return Err(busy());
        }
        session.purek.busy = false;
        if let Err(error) = &result {
            session
                .purek
                .output
                .end(generation, false, Some(&error.code));
        }
        session.revision += 1;
        result.map(|_| snapshot(session))
    })
}
fn monitor_output(
    context: Arc<HostContext>,
    running: Arc<stream::Running>,
    connection: Connection,
    generation: u64,
    expected: String,
    managed: bool,
) {
    let mut failures = 0;
    let mut last = Instant::now() - Duration::from_secs(3);
    let start = Instant::now();
    while !context.stop.load(Ordering::Acquire) {
        let current = with_app(|app| {
            Ok(app.native().purek.generation == generation
                && app.native().purek.output.running.is_some())
        });
        if !current.unwrap_or(false) {
            break;
        }
        let changed = with_app(|app| signature(app, running.level == "L1").map(|v| v != expected))
            .unwrap_or(true);
        if changed
            || running.stop.load(Ordering::Acquire)
            || (start.elapsed() > Duration::from_secs(10)
                && !running.delivered.load(Ordering::Acquire))
        {
            let code = if changed {
                "purek_output_context_changed"
            } else {
                "purek_output_pipeline"
            };
            if managed && !changed {
                let _ = with_app(|app| {
                    if app.native().purek.generation == generation
                        && !app.native().purek.controller.release_platform
                    {
                        app.native().purek.controller.fail(code);
                        app.native().revision += 1;
                    }
                    Ok(())
                });
            }
            let _ = stop_generation(
                false,
                if managed && changed { None } else { Some(code) },
                Some(generation),
            );
            // start may still own the operation lease when its monitor first
            // runs. Retry admission while this generation owns the session;
            // a completed stop advances generation and exits at the next check.
            thread::sleep(Duration::from_millis(100));
            continue;
        }
        if last.elapsed() >= Duration::from_secs(2) {
            last = Instant::now();
            let state = renderer::transport_state(&connection);
            let active = state
                .as_ref()
                .is_ok_and(|s| matches!(s.as_str(), "PLAYING" | "TRANSITIONING"));
            failures = if active { 0 } else { failures + 1 };
            if failures >= 3 {
                let completed = running.drained()
                    && state.is_ok_and(|s| matches!(s.as_str(), "STOPPED" | "NO_MEDIA_PRESENT"));
                if managed {
                    let _ = with_app(|app| {
                        if app.native().purek.generation == generation {
                            if completed {
                                app.native().purek.controller.finish(&expected);
                            } else {
                                app.native()
                                    .purek
                                    .controller
                                    .fail("purek_output_interrupted");
                            }
                            app.native().revision += 1;
                        }
                        Ok(())
                    });
                }
                let _ = stop_generation(
                    false,
                    if completed {
                        None
                    } else {
                        Some("purek_output_interrupted")
                    },
                    Some(generation),
                );
                thread::sleep(Duration::from_millis(100));
                continue;
            }
        }
        thread::sleep(Duration::from_millis(100));
    }
    running.cancel();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_callbacks_and_busy_monitor_cannot_cancel_or_release_a_new_output() {
        let _owned = crate::app_state::native_session::GLOBAL_APP_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let running = stream::Running::new(5, stream::Framing::Close).unwrap();
        with_app(|app| {
            app.native().purek = RoomState {
                generation: 5,
                busy: true,
                ..Default::default()
            };
            app.native().purek.output.begin(5, running.clone());
            Ok(())
        })
        .unwrap();
        assert_eq!(
            stop_generation(false, None, Some(5)).unwrap_err().code,
            "purek_busy"
        );
        assert!(!running.stop.load(Ordering::Acquire));
        with_app(|app| {
            app.native().purek.busy = false;
            Ok(())
        })
        .unwrap();
        assert_eq!(
            stop_generation(false, None, Some(4)).unwrap_err().code,
            "purek_busy"
        );
        pipeline_error(4);
        mark_streaming(4);
        with_app(|app| {
            assert_eq!(app.native().purek.output.snapshot()["status"], "starting");
            assert!(!app.native().purek.busy);
            Ok(())
        })
        .unwrap();
        assert!(!running.stop.load(Ordering::Acquire));
        mark_streaming(5);
        let stopped = stop_generation(false, None, Some(5)).unwrap();
        assert_eq!(stopped["output"]["generation"], 6);
        assert_eq!(stopped["output"]["status"], "stopped");
        assert!(running.stop.load(Ordering::Acquire));
        mark_streaming(5);
        pipeline_error(5);
        with_app(|app| {
            assert_eq!(app.native().purek.output.snapshot()["status"], "stopped");
            app.native().purek = RoomState::default();
            Ok(())
        })
        .unwrap();
    }
}
