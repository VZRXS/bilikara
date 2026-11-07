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
    l1: bool,
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
    let mut video_codec = "unknown";
    let mut audio_codecs = Vec::new();
    for (source, kind, codec) in std::iter::once((&video, StreamType::Video, Some("h264"))).chain(
        audio
            .iter()
            .map(|a| (a, StreamType::Audio, if l1 { None } else { Some("aac") })),
    ) {
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
                "投屏需要 H.264 视频；L0 还需要 AAC 音轨。请使用 AVC 和兼容音频重新缓存，FLAC 等音频需选择 L1",
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
    let (generation, connection, info, trace) = with_app(|app| {
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
        let local_preview = managed.is_some() && room.controller.local_preview;
        let connection = if local_preview {
            None
        } else {
            Some(
                room.connected
                    .clone()
                    .ok_or_else(|| failure(409, "not_authorized", "请先授权房台"))?,
            )
        };
        let info = if local_preview {
            capabilities::TsProtocol::Mp2t
        } else {
            room.output.protocol()?
        };
        let trace = super::trace::OutputTrace::new(managed.is_some());
        trace.configure(
            if l1 { "L1" } else { "L0" },
            match framing {
                stream::Framing::Close => "close",
                stream::Framing::Chunked => "chunked",
            },
            info.mime(),
            room.output.diagnostic_summary(),
        );
        if let Some(connection) = &connection
            && let Ok(receiver) = protocol::local_address(&connection.room.description)
        {
            trace.route(super::trace::route_facts(connection.local, receiver));
        }
        room.diagnostics.begin_output(trace.clone());
        room.busy = true;
        room.generation += 1;
        session.revision += 1;
        Ok((room.generation, connection, info, trace))
    })?;
    let mut control_started = false;
    let result = (|| {
        super::super::output_platform::apply(
            super::super::output_platform::OutputActivity::Playing,
        )?;
        let prepared = prepare(context, l1, managed.map(|(p, _)| p), &trace)?;
        let expected = prepared.signature.clone();
        let mut running =
            stream::Running::with_protocol(generation, framing, l1, info, trace.clone())?;
        if connection.is_none() {
            let preview = with_app(|app| {
                Ok(app
                    .native()
                    .purek
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
        let uri = if let Some(connection) = &connection {
            running.bind(
                context,
                connection.local,
                protocol::local_address(&connection.room.description)?,
            )?
        } else {
            format!("{}index.m3u8", running.preview.as_ref().unwrap().base())
        };
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
                worker.trace.pipeline_end(match &result {
                    Ok(_) => "completed",
                    Err(_) if worker.stop.load(Ordering::Acquire) => "cancelled",
                    Err(_) => "failed",
                });
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
        if let Some(connection) = &connection {
            control_started = true;
            renderer::start_transport_traced(connection, &uri, &info.info(), &trace)?;
        }
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
                if let Some(receiver) = receiver {
                    monitor_output(
                        monitor,
                        watch,
                        receiver,
                        generation,
                        expected,
                        managed.is_some(),
                    );
                } else {
                    monitor_preview(monitor, watch, generation, expected);
                }
            })
            .map_err(|_| network_error())?;
        Ok(())
    })();
    if let Err(error) = &result {
        trace.terminal(Some(&error.code));
    }
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
        if control_started
            && owned
            && let Some(connection) = &connection
        {
            let since = Instant::now();
            let stopped = renderer::transport(connection, "Stop", "");
            trace.action("Stop", since, &stopped);
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
    let generation = with_app(|app| {
        let session = app.native();
        let room = &mut session.purek;
        if room.busy || expected.is_some_and(|g| room.generation != g) {
            return Err(busy());
        }
        let active = room.output.running.is_some();
        let external_active = room
            .output
            .running
            .as_ref()
            .is_some_and(|r| r.preview.is_none());
        if paused && !active {
            return Err(failure(409, "output_not_running", "当前没有试播输出"));
        }
        let trace = room.diagnostics.output().filter(|_| active).cloned();
        room.busy = true;
        room.generation += 1;
        room.output.end(room.generation, paused, error);
        session.revision += 1;
        Ok((
            room.generation,
            room.connected.clone().filter(|_| external_active),
            trace,
        ))
    })?;
    let (generation, connection, trace) = (generation.0, generation.1, generation.2);
    let result = connection
        .as_ref()
        .map(|c| {
            let since = Instant::now();
            let stopped = renderer::transport(c, "Stop", "");
            if let Some(trace) = &trace {
                trace.action("Stop", since, &stopped);
            }
            stopped
        })
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
/// Labels an attempt that delivered no media by what the receiver did,
/// without asserting why: no request, only rejected requests, or no bytes.
fn undelivered(running: &stream::Running) -> &'static str {
    if running.stop.load(Ordering::Acquire) {
        return "purek_output_pipeline";
    }
    match running.trace.received_stream() {
        (0, 0, _) => "purek_output_not_requested",
        (0, _, _) => "purek_output_request_rejected",
        (_, _, 0) => "purek_output_no_delivery",
        _ => "purek_output_pipeline",
    }
}
struct DeliveryProgress {
    bytes: u64,
    at: Instant,
}
impl DeliveryProgress {
    fn advancing(&mut self, now: Instant, bytes: u64, consumer: bool) -> bool {
        if bytes > self.bytes {
            self.bytes = bytes;
            self.at = now;
        }
        // Match the stream writer's bounded backpressure tolerance. Neither an
        // open GET nor an old successful write is perpetual evidence of life.
        consumer && bytes > 0 && now.duration_since(self.at) < Duration::from_secs(15)
    }
}

#[derive(Default)]
struct DrainSettlement(Option<Instant>);
impl DrainSettlement {
    fn complete(&mut self, now: Instant, drained: bool, reachable: bool) -> bool {
        if !drained {
            self.0 = None;
            return false;
        }
        let since = *self.0.get_or_insert(now);
        // Sender EOF is not a statement about the receiver's decoder. Allow a
        // bounded settle, reset by a late packet/consumer, and retain definite
        // control failure precedence rather than silently calling it success.
        reachable && now.duration_since(since) >= Duration::from_secs(2)
    }
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
    let mut delivery = DeliveryProgress {
        bytes: 0,
        at: start,
    };
    // Some receivers play a URI but reject or misreport GetTransportInfo.
    // Then actual delivery decides completion or interruption instead.
    let mut monitoring = true;
    let mut unread_since: Option<Instant> = None;
    let mut reachable = true;
    let mut drain = DrainSettlement::default();
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
                undelivered(&running)
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
        let mut outcome = None;
        if last.elapsed() >= Duration::from_secs(2) {
            last = Instant::now();
            let state = renderer::transport_state(&connection);
            let unavailable = state.as_ref().is_err_and(renderer::monitor_unavailable);
            running.trace.transport_state(state.as_deref(), unavailable);
            if unavailable {
                monitoring = false;
            }
            {
                let (_, _, bytes) = running.trace.received_stream();
                let advancing = delivery.advancing(Instant::now(), bytes, running.has_consumer());
                // Valid but contradictory state and unsupported monitoring are
                // advisory while bytes actually advance. Definite HTTP/network
                // failure still terminates even if its media socket remains open.
                reachable = state.is_ok() || unavailable;
                failures = if reachable && advancing {
                    0
                } else {
                    failures + 1
                };
                if failures >= 3 {
                    outcome = Some(
                        running.drained()
                            && state.is_ok_and(|s| {
                                matches!(s.as_str(), "STOPPED" | "NO_MEDIA_PRESENT")
                            }),
                    );
                }
            }
        }
        if !monitoring && outcome.is_none() {
            if running.has_consumer() {
                unread_since = None;
            } else if unread_since.get_or_insert_with(Instant::now).elapsed()
                >= Duration::from_secs(15)
            {
                outcome = Some(false);
            }
        }
        let completed = drain.complete(
            Instant::now(),
            running.drained()
                && running.played.load(Ordering::Acquire)
                && running.delivered.load(Ordering::Acquire),
            reachable,
        );
        if outcome.is_none() && completed {
            outcome = Some(true);
        }
        if let Some(completed) = outcome {
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
        thread::sleep(Duration::from_millis(100));
    }
    running.cancel();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn undelivered_attempts_are_labelled_by_receiver_behaviour() {
        use super::super::trace::Request;
        let quiet = stream::Running::new(1, stream::Framing::Close).unwrap();
        assert_eq!(undelivered(&quiet), "purek_output_not_requested");
        let rejected = stream::Running::new(2, stream::Framing::Close).unwrap();
        rejected
            .trace
            .request(Request::RejectedPeer { same_subnet: true });
        assert_eq!(undelivered(&rejected), "purek_output_request_rejected");
        let empty = stream::Running::new(3, stream::Framing::Close).unwrap();
        empty.trace.request(Request::Get);
        assert_eq!(undelivered(&empty), "purek_output_no_delivery");
        let failed = stream::Running::new(4, stream::Framing::Close).unwrap();
        failed.cancel();
        assert_eq!(undelivered(&failed), "purek_output_pipeline");
    }
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

#[cfg(test)]
mod delivery_monitor_tests {
    use super::*;
    #[test]
    fn current_writes_required_even_when_consumer_remains_open() {
        let now = Instant::now();
        let mut delivery = DeliveryProgress { bytes: 0, at: now };
        assert!(!delivery.advancing(now, 0, true));
        assert!(delivery.advancing(now, 188, true));
        assert!(delivery.advancing(now + Duration::from_secs(14), 188, true));
        assert!(!delivery.advancing(now + Duration::from_secs(15), 188, true));
        assert!(delivery.advancing(now + Duration::from_secs(16), 376, true));
        assert!(!delivery.advancing(now + Duration::from_secs(16), 376, false));
    }
    #[test]
    fn sender_finish_waits_for_drain_and_resets_on_late_packets() {
        let now = Instant::now();
        let mut drain = DrainSettlement::default();
        assert!(!drain.complete(now, false, true));
        assert!(!drain.complete(now, true, true));
        assert!(!drain.complete(now + Duration::from_secs(1), false, true));
        assert!(!drain.complete(now + Duration::from_secs(2), true, true));
        assert!(!drain.complete(now + Duration::from_secs(3), true, true));
        assert!(!drain.complete(now + Duration::from_secs(4), true, false));
        assert!(drain.complete(now + Duration::from_secs(4), true, true));
    }
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
            Ok(app.native().purek.generation == generation
                && app.native().purek.controller.local_preview
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
                if app.native().purek.generation != generation {
                    return Ok(None);
                }
                let code = record_preview_failure(&mut app.native().purek.controller);
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
