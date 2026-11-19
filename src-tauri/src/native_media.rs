//! Desktop bridge to the native playback engine.
//!
//! Rust AppState in the Host process stays the business authority. The Host
//! page binds an already-claimed program to an engine; this bridge validates
//! the invoking window, turns Host-relative media routes into authorized
//! loopback requests and relays identity-bound observations. Video frames are
//! composited natively beneath the transparent stage of each WebView and never
//! cross JavaScript IPC.
use crate::backend_process::BackendProcess;
use crate::presentation;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::Manager;

pub(crate) const PREFERENCE_FILE: &str = "media-engine-v1.json";
// The engine and its event, route and surface consumers are Linux-only for
// now; the shared definitions stay compiled (and tested) on every platform.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) const OBSERVATION_EVENT: &str = "media-engine://observation";
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum EnginePreference {
    Gstreamer,
    Legacy,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Stored {
    schema_version: u8,
    engine: EnginePreference,
}

pub(crate) fn load_preference(path: &Path) -> Result<Option<EnginePreference>, String> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let mut bytes = Vec::new();
    file.take(129)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > 128 {
        return Err("Playback engine preference exceeds its size limit".into());
    }
    let stored: Stored = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if stored.schema_version != 1 {
        return Err("Unsupported playback engine preference".into());
    }
    Ok(Some(stored.engine))
}

pub(crate) fn save_preference(path: &Path, engine: EnginePreference) -> Result<(), String> {
    // Never silently replace corrupt or future-version storage.
    load_preference(path)?;
    let parent = path
        .parent()
        .ok_or("Playback engine preference directory unavailable")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temporary = parent.join(format!(
        ".{PREFERENCE_FILE}.{}.{}.tmp",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let bytes = serde_json::to_vec(&Stored {
            schema_version: 1,
            engine,
        })?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)?;
        Ok(())
    })();
    let _ = fs::remove_file(temporary);
    result.map_err(|e: std::io::Error| e.to_string())
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct GstreamerStatus {
    available: bool,
    /// Qualification level of this build/platform, if any.
    qualification: Option<&'static str>,
    reason: Option<String>,
    version: Option<String>,
    missing: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct EngineStatus {
    platform: &'static str,
    preference: Option<EnginePreference>,
    default_engine: EnginePreference,
    configured: EnginePreference,
    gstreamer: GstreamerStatus,
}

fn platform_name() -> &'static str {
    if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "other"
    }
}

fn gstreamer_status(app: &tauri::AppHandle) -> GstreamerStatus {
    #[cfg(target_os = "linux")]
    {
        let state = app.state::<linux::NativeMedia>();
        let capability = state.capability();
        let renderer = webview_renderer_supported(|key| std::env::var_os(key));
        let available = capability.available && renderer;
        GstreamerStatus {
            available,
            qualification: available.then_some(linux::QUALIFICATION),
            reason: if !capability.available {
                Some("runtime-plugins-missing".to_string())
            } else if !renderer {
                Some("webview-renderer-unsupported".to_string())
            } else {
                None
            },
            version: (!capability.version.is_empty()).then(|| capability.version.clone()),
            missing: capability.missing.clone(),
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;
        GstreamerStatus {
            available: false,
            qualification: None,
            reason: Some("not-qualified-on-platform".into()),
            version: None,
            missing: Vec::new(),
        }
    }
}

/// Native frames are composited beneath the page's transparent stage. Only
/// WebKitGTK's DMA-BUF renderer (its default) clears pixels that become
/// transparent; the legacy renderer and non-compositing mode keep stale
/// pixels there, so the engine must not be offered in those environments.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn webview_renderer_supported(var: impl Fn(&str) -> Option<std::ffi::OsString>) -> bool {
    let set = |key: &str| var(key).is_some_and(|value| !value.is_empty() && value != "0");
    !set("WEBKIT_DISABLE_DMABUF_RENDERER") && !set("WEBKIT_DISABLE_COMPOSITING_MODE")
}

fn status(app: &tauri::AppHandle, preference: Option<EnginePreference>) -> EngineStatus {
    let gstreamer = gstreamer_status(app);
    // GStreamer is preferred only where this build qualified it and the
    // runtime probe found every required plugin.
    let default_engine = if gstreamer.available && gstreamer.qualification.is_some() {
        EnginePreference::Gstreamer
    } else {
        EnginePreference::Legacy
    };
    EngineStatus {
        platform: platform_name(),
        preference,
        default_engine,
        configured: preference.unwrap_or(default_engine),
        gstreamer,
    }
}

fn preference_path(window: &tauri::WebviewWindow) -> Result<PathBuf, String> {
    crate::window_lifecycle::host_ui_preference_path(window, PREFERENCE_FILE)
}

#[tauri::command]
pub(crate) fn get_media_engine_status(
    window: tauri::WebviewWindow,
) -> Result<EngineStatus, String> {
    authorize(&window, &["main"])?;
    // A missing, unreadable or damaged preference never hides the engine;
    // report the platform default instead and record why.
    let preference = match preference_path(&window) {
        Ok(path) => load_preference(&path).unwrap_or(None),
        Err(error) => {
            crate::desktop_diagnostics::append_desktop_diagnostic(
                "media_engine_preference_unavailable",
                format!("reason={error}"),
            );
            None
        }
    };
    let status = status(window.app_handle(), preference);
    crate::desktop_diagnostics::append_desktop_diagnostic(
        "media_engine_status",
        json!({
            "available": status.gstreamer.available,
            "qualification": status.gstreamer.qualification,
            "reason": status.gstreamer.reason,
            "missing": status.gstreamer.missing,
            "configured": status.configured,
        })
        .to_string(),
    );
    Ok(status)
}

#[tauri::command]
pub(crate) fn set_media_engine_preference(
    window: tauri::WebviewWindow,
    engine: EnginePreference,
) -> Result<EngineStatus, String> {
    let path = preference_path(&window)?;
    let current = status(window.app_handle(), None);
    if engine == EnginePreference::Gstreamer && !current.gstreamer.available {
        return Err("GStreamer is unavailable on this device".into());
    }
    save_preference(&path, engine)?;
    Ok(status(window.app_handle(), Some(engine)))
}

/// Host-relative artifact route admitted by the Host media endpoint.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn media_route(value: &Value) -> Result<String, String> {
    let route = value.as_str().ok_or("media route missing")?;
    if !route.starts_with("/media/artifacts/")
        || route.len() > 2048
        || route.contains("..")
        || route.contains(['?', '#', '\\'])
        || route.chars().any(char::is_control)
    {
        return Err("media route rejected".into());
    }
    Ok(route.to_string())
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SurfaceRequest {
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub visible: bool,
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    #[serde(default)]
    pub width: f64,
    #[serde(default)]
    pub height: f64,
}

impl SurfaceRequest {
    pub(crate) fn validate(&self) -> Result<(), String> {
        let values = [self.x, self.y, self.width, self.height];
        if values.iter().any(|v| !v.is_finite() || v.abs() > 100_000.0)
            || self.width < 0.0
            || self.height < 0.0
        {
            return Err("invalid surface rectangle".into());
        }
        Ok(())
    }
}

fn authorize(window: &tauri::WebviewWindow, labels: &[&str]) -> Result<(), String> {
    let backend = window
        .try_state::<BackendProcess>()
        .ok_or("Host unavailable")?;
    presentation::authorize_window(window, &backend, labels)
}

#[tauri::command]
pub(crate) fn media_engine_command(
    window: tauri::WebviewWindow,
    command: Value,
) -> Result<Value, String> {
    authorize(&window, &["main"])?;
    #[cfg(target_os = "linux")]
    {
        let backend = window.state::<BackendProcess>();
        let base = backend
            .backend_url()
            .map_err(|()| "backend address unavailable".to_string())?
            .ok_or("backend not ready")?;
        let cookie = backend.host_cookie();
        let state = window.state::<linux::NativeMedia>();
        Ok(
            match state.command(window.app_handle(), &base, cookie, &command) {
                Ok(seek_id) => json!({"accepted": true, "seek_id": seek_id}),
                Err(code) => {
                    crate::desktop_diagnostics::append_desktop_diagnostic(
                        "media_engine_command_rejected",
                        json!({"op": command["op"].as_str().unwrap_or(""), "code": code})
                            .to_string(),
                    );
                    json!({"accepted": false, "code": code})
                }
            },
        )
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = command;
        Ok(json!({"accepted": false, "code": "not-qualified-on-platform"}))
    }
}

#[tauri::command]
pub(crate) fn set_media_engine_surface(
    window: tauri::WebviewWindow,
    surface: SurfaceRequest,
) -> Result<(), String> {
    authorize(&window, &["main", "controller"])?;
    surface.validate()?;
    #[cfg(target_os = "linux")]
    {
        let state = window.state::<linux::NativeMedia>();
        state.set_surface(&window, surface)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = surface;
        Err("native surfaces are not qualified on this platform".into())
    }
}

#[tauri::command]
pub(crate) fn get_media_engine_snapshot(window: tauri::WebviewWindow) -> Result<Value, String> {
    authorize(&window, &["main"])?;
    #[cfg(target_os = "linux")]
    {
        Ok(window.state::<linux::NativeMedia>().snapshot())
    }
    #[cfg(not(target_os = "linux"))]
    Ok(json!({"engine": null}))
}

#[cfg(target_os = "linux")]
pub(crate) use linux::NativeMedia;

#[cfg(target_os = "linux")]
mod linux {
    use super::{OBSERVATION_EVENT, SurfaceRequest, media_route};
    use bilikara_media_engine::{
        AudioOutput, Capability, ClockMode, Command, Engine, EngineConfig, FrameSink, MediaSource,
        ProgramIdentity, SettingsPatch, VideoFrame,
    };
    use gtk::prelude::*;
    use serde_json::{Value, json};
    use std::cell::RefCell;
    use std::collections::{HashMap, HashSet};
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::{Arc, Mutex, OnceLock};
    use tauri::{Emitter, Manager};
    use webkit2gtk::WebViewExt;

    /// Evidence class of the Linux qualification behind the GStreamer default.
    pub(crate) const QUALIFICATION: &str = "linux-x86_64-virtual-output";

    /// Lifecycle diagnostics for the bounded desktop log: program identity,
    /// phase and coarse timing only (one in eight position ticks). Media URLs, cookies and
    /// GStreamer error text (which can contain request URLs) are excluded.
    pub(super) fn diagnostic(
        observation: &bilikara_media_engine::Observation,
    ) -> Option<serde_json::Value> {
        use bilikara_media_engine::ObservationKind as Kind;
        let mut record = serde_json::json!({
            "seq": observation.seq,
            "playback_generation": observation.program.playback_generation,
            "item_id": observation.program.item_id,
            "position": observation.position.map(|p| (p * 1000.0).round() / 1000.0),
            "duration": observation.duration.map(|d| (d * 1000.0).round() / 1000.0),
            "intent_playing": observation.intent_playing,
        });
        record["type"] = serde_json::json!(match &observation.kind {
            // Position ticks arrive four times per second; keep one in eight.
            Kind::Position if !observation.seq.is_multiple_of(8) => return None,
            Kind::Position => "position",
            Kind::Loading => "loading",
            Kind::Ready => "ready",
            Kind::Playing => "playing",
            Kind::Paused => "paused",
            Kind::SeekSettled { .. } => "seek-settled",
            Kind::Eos { drained, watchdog } => {
                record["drained"] = serde_json::json!(drained);
                record["watchdog"] = serde_json::json!(watchdog);
                "eos"
            }
            Kind::Error { code, fatal, .. } => {
                record["code"] = serde_json::json!(code);
                record["fatal"] = serde_json::json!(fatal);
                "error"
            }
            Kind::ClockLost => "clock-lost",
            Kind::Stopped => "stopped",
        });
        Some(record)
    }

    thread_local! {
        // GTK objects stay on the main thread; frames only carry labels.
        static WEBVIEWS: RefCell<HashMap<String, webkit2gtk::WebView>> = RefCell::new(HashMap::new());
    }

    #[derive(Clone, Copy, Default)]
    struct Geometry {
        visible: bool,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    }

    #[derive(Default)]
    pub(crate) struct Surfaces {
        frame: Mutex<Option<Arc<VideoFrame>>>,
        geometry: Mutex<HashMap<String, Geometry>>,
        installed: Mutex<HashSet<String>>,
        redraw_pending: AtomicBool,
        app: OnceLock<tauri::AppHandle>,
        drawn: AtomicU64,
        presented: AtomicU64,
    }

    impl Surfaces {
        /// Coalesces frame arrivals into at most one pending main-thread
        /// invalidation of every visible stage.
        fn schedule_redraw(&self) {
            if self.redraw_pending.swap(true, Ordering::AcqRel) {
                return;
            }
            let Some(app) = self.app.get().cloned() else {
                self.redraw_pending.store(false, Ordering::Release);
                return;
            };
            let handle = app.clone();
            let scheduled = app.run_on_main_thread(move || {
                let state = handle.state::<NativeMedia>();
                let surfaces = &state.surfaces;
                surfaces.redraw_pending.store(false, Ordering::Release);
                let geometry = surfaces.geometry.lock().unwrap().clone();
                WEBVIEWS.with(|webviews| {
                    for (label, webview) in webviews.borrow().iter() {
                        if let Some(area) = geometry.get(label).filter(|g| g.visible) {
                            queue_area(webview, area);
                        }
                    }
                });
            });
            if scheduled.is_err() {
                self.redraw_pending.store(false, Ordering::Release);
            }
        }
    }

    fn zoom(webview: &webkit2gtk::WebView) -> f64 {
        let zoom = webview.zoom_level();
        if zoom.is_finite() && zoom > 0.0 {
            zoom
        } else {
            1.0
        }
    }

    fn queue_area(webview: &webkit2gtk::WebView, area: &Geometry) {
        let zoom = zoom(webview);
        let x = (area.x * zoom).floor() as i32 - 1;
        let y = (area.y * zoom).floor() as i32 - 1;
        let width = (area.width * zoom).ceil() as i32 + 2;
        let height = (area.height * zoom).ceil() as i32 + 2;
        if width > 0 && height > 0 {
            webview.queue_draw_area(x, y, width, height);
        }
    }

    impl FrameSink for Surfaces {
        fn present(&self, frame: Arc<VideoFrame>) {
            *self.frame.lock().unwrap() = Some(frame);
            self.presented.fetch_add(1, Ordering::Relaxed);
            self.schedule_redraw();
        }

        fn clear(&self) {
            *self.frame.lock().unwrap() = None;
            self.schedule_redraw();
        }
    }

    /// Clears the stage rectangle to transparent before WebKit paints.
    fn clear(cr: &gtk::cairo::Context, area: &Geometry, zoom: f64) {
        let (x, y, width, height) = (
            area.x * zoom,
            area.y * zoom,
            area.width * zoom,
            area.height * zoom,
        );
        if width < 1.0 || height < 1.0 {
            return;
        }
        let _ = cr.save();
        cr.rectangle(x, y, width, height);
        cr.set_operator(gtk::cairo::Operator::Clear);
        let _ = cr.fill();
        let _ = cr.restore();
    }

    /// Paints the current frame beneath the WebView's transparent stage.
    /// DEST_OVER fills only pixels the page left transparent, so every DOM
    /// overlay (controls, QR, notices, feedback cards) stays above the video.
    fn paint(
        cr: &gtk::cairo::Context,
        area: &Geometry,
        frame: Option<&Arc<VideoFrame>>,
        zoom: f64,
    ) {
        let (x, y, width, height) = (
            area.x * zoom,
            area.y * zoom,
            area.width * zoom,
            area.height * zoom,
        );
        if width < 1.0 || height < 1.0 {
            return;
        }
        let _ = cr.save();
        cr.rectangle(x, y, width, height);
        cr.clip();
        cr.set_operator(gtk::cairo::Operator::DestOver);
        if let Some(frame) = frame {
            let aspect = frame.display_aspect.max(0.01);
            let (mut fit_width, mut fit_height) = (width, width / aspect);
            if fit_height > height {
                fit_height = height;
                fit_width = height * aspect;
            }
            let left = x + (width - fit_width) / 2.0;
            let top = y + (height - fit_height) / 2.0;
            // SAFETY: the frame owns a read-only mapping that outlives this
            // synchronous paint; cairo only reads from a source surface.
            let surface = unsafe {
                gtk::cairo::ImageSurface::create_for_data_unsafe(
                    frame.data().as_ptr() as *mut u8,
                    gtk::cairo::Format::Rgb24,
                    frame.width as i32,
                    frame.height as i32,
                    frame.stride as i32,
                )
            };
            if let Ok(surface) = surface {
                let _ = cr.save();
                cr.translate(left, top);
                cr.scale(
                    fit_width / f64::from(frame.width),
                    fit_height / f64::from(frame.height),
                );
                if cr.set_source_surface(&surface, 0.0, 0.0).is_ok() {
                    cr.source().set_filter(gtk::cairo::Filter::Good);
                    let _ = cr.paint();
                }
                let _ = cr.restore();
                surface.finish();
            }
        }
        // Letterbox (or no frame yet): opaque black, never the desktop.
        cr.set_source_rgb(0.0, 0.0, 0.0);
        let _ = cr.paint();
        let _ = cr.restore();
    }

    pub(crate) struct NativeMedia {
        engine: Mutex<Option<Engine>>,
        pub(crate) surfaces: Arc<Surfaces>,
        capability: OnceLock<Capability>,
    }

    impl Default for NativeMedia {
        fn default() -> Self {
            Self {
                engine: Mutex::new(None),
                surfaces: Arc::new(Surfaces::default()),
                capability: OnceLock::new(),
            }
        }
    }

    fn identity(value: &Value) -> Result<ProgramIdentity, String> {
        let program: ProgramIdentity =
            serde_json::from_value(value.clone()).map_err(|_| "invalid-program".to_string())?;
        program.validate().map_err(str::to_string)?;
        Ok(program)
    }

    impl NativeMedia {
        pub(crate) fn capability(&self) -> &Capability {
            self.capability.get_or_init(bilikara_media_engine::probe)
        }

        fn ensure_engine(&self, app: &tauri::AppHandle) -> Result<(), String> {
            let mut engine = self.engine.lock().unwrap();
            if engine.is_some() {
                return Ok(());
            }
            if !self.capability().available {
                return Err("gstreamer-unavailable".into());
            }
            let _ = self.surfaces.app.set(app.clone());
            let emitter = app.clone();
            let observer = Arc::new(move |observation: bilikara_media_engine::Observation| {
                if let Some(record) = diagnostic(&observation) {
                    crate::desktop_diagnostics::append_desktop_diagnostic(
                        "media_engine_observation",
                        record.to_string(),
                    );
                }
                let payload = bilikara_media_engine::observation_json(&observation);
                let _ = emitter.emit_to("main", OBSERVATION_EVENT, payload);
            });
            *engine = Some(
                Engine::start(
                    EngineConfig {
                        audio: AudioOutput::Auto,
                        // The PulseAudio stream opens only at a program's first
                        // Play (libpulse 15.99-16.x misreports streams that start
                        // corked), so the sink cannot provide the clock earlier.
                        clock: ClockMode::System,
                        hardware_decoding: false,
                    },
                    self.surfaces.clone(),
                    observer,
                )
                .map_err(|error| format!("engine-start:{error}"))?,
            );
            Ok(())
        }

        pub(crate) fn command(
            &self,
            app: &tauri::AppHandle,
            base: &str,
            cookie: Option<String>,
            command: &Value,
        ) -> Result<Option<u64>, String> {
            let op = command
                .get("op")
                .and_then(Value::as_str)
                .ok_or("invalid-command")?;
            let allowed: &[&str] = match op {
                "load" => &[
                    "op",
                    "program",
                    "video_url",
                    "audio_url",
                    "start_seconds",
                    "play",
                ],
                "seek" => &["op", "program", "seconds", "play"],
                "play" | "pause" | "stop" => &["op", "program"],
                "settings" => &["op", "volume", "muted", "key_shift", "av_delay_ms"],
                _ => return Err("unsupported-command".into()),
            };
            let object = command.as_object().ok_or("invalid-command")?;
            if object.keys().any(|key| !allowed.contains(&key.as_str())) {
                return Err("invalid-command-field".into());
            }
            if op != "load" && self.engine.lock().unwrap().is_none() {
                return if op == "settings" {
                    Ok(None)
                } else {
                    Err("no-program".into())
                };
            }
            let translated = match op {
                "load" => {
                    let base = base.trim_end_matches('/');
                    let video = media_route(&command["video_url"])?;
                    let audio = media_route(&command["audio_url"])?;
                    Command::Load {
                        program: identity(&command["program"])?,
                        media: MediaSource {
                            video_uri: format!("{base}{video}"),
                            audio_uri: format!("{base}{audio}"),
                            cookies: cookie.into_iter().collect(),
                        },
                        start_seconds: command["start_seconds"].as_f64().unwrap_or(0.0),
                        play: command["play"].as_bool().unwrap_or(false),
                    }
                }
                "play" => Command::Play {
                    program: identity(&command["program"])?,
                },
                "pause" => Command::Pause {
                    program: identity(&command["program"])?,
                },
                "stop" => Command::Stop {
                    program: identity(&command["program"])?,
                },
                "seek" => Command::Seek {
                    program: identity(&command["program"])?,
                    seconds: command["seconds"].as_f64().ok_or("invalid-seek")?,
                    play: command["play"].as_bool(),
                },
                _ => Command::Settings(SettingsPatch {
                    volume: command["volume"].as_f64(),
                    muted: command["muted"].as_bool(),
                    key_shift: command["key_shift"].as_f64().map(|v| v as f32),
                    av_delay_ms: command["av_delay_ms"].as_i64(),
                }),
            };
            if op == "load" {
                self.ensure_engine(app)?;
            }
            let engine = self.engine.lock().unwrap();
            engine
                .as_ref()
                .ok_or_else(|| "no-engine".to_string())?
                .command(translated)
                .map(|receipt| receipt.seek_id)
                .map_err(|error| error.code)
        }

        pub(crate) fn set_surface(
            &self,
            window: &tauri::WebviewWindow,
            surface: SurfaceRequest,
        ) -> Result<(), String> {
            let _ = self.surfaces.app.set(window.app_handle().clone());
            let label = window.label().to_string();
            let previous = self.surfaces.geometry.lock().unwrap().insert(
                label.clone(),
                Geometry {
                    visible: surface.visible,
                    x: surface.x,
                    y: surface.y,
                    width: surface.width,
                    height: surface.height,
                },
            );
            if previous.is_none_or(|old| old.visible != surface.visible) {
                crate::desktop_diagnostics::append_desktop_diagnostic(
                    "media_engine_surface",
                    json!({
                        "label": label,
                        "visible": surface.visible,
                        "width": surface.width.round(),
                        "height": surface.height.round(),
                    })
                    .to_string(),
                );
            }
            let install = self
                .surfaces
                .installed
                .lock()
                .unwrap()
                .insert(label.clone());
            let surfaces = self.surfaces.clone();
            let visible = surface.visible;
            window
                .with_webview(move |platform| {
                    let webview = platform.inner();
                    if install {
                        // Before WebKit draws: clear the stage so pixels the page
                        // leaves transparent never keep stale window content
                        // (WebKit may composite with OVER into the paint buffer).
                        let clear_label = label.clone();
                        let clear_surfaces = surfaces.clone();
                        webview.connect_local("draw", false, move |values| {
                            let cr = values.get(1)?.get::<gtk::cairo::Context>().ok()?;
                            let webview = values.first()?.get::<webkit2gtk::WebView>().ok()?;
                            let area = clear_surfaces
                                .geometry
                                .lock()
                                .unwrap()
                                .get(&clear_label)
                                .copied();
                            if let Some(area) = area.filter(|g| g.visible) {
                                clear(&cr, &area, zoom(&webview));
                            }
                            Some(false.to_value())
                        });
                        let draw_label = label.clone();
                        let draw_surfaces = surfaces.clone();
                        webview.connect_local("draw", true, move |values| {
                            let cr = values.get(1)?.get::<gtk::cairo::Context>().ok()?;
                            let webview = values.first()?.get::<webkit2gtk::WebView>().ok()?;
                            let area = draw_surfaces
                                .geometry
                                .lock()
                                .unwrap()
                                .get(&draw_label)
                                .copied();
                            if let Some(area) = area.filter(|g| g.visible) {
                                let frame = draw_surfaces.frame.lock().unwrap().clone();
                                paint(&cr, &area, frame.as_ref(), zoom(&webview));
                                let drawn = draw_surfaces.drawn.fetch_add(1, Ordering::Relaxed);
                                if matches!(drawn, 0 | 1 | 2 | 10 | 100 | 1000) {
                                    let clip = cr.clip_extents().unwrap_or_default();
                                    crate::desktop_diagnostics::append_desktop_diagnostic(
                                        "media_engine_surface_painted",
                                        format!(
                                            "label={draw_label} draw={drawn} frame={} clip={:.0},{:.0},{:.0},{:.0} presented={}",
                                            frame.is_some(),
                                            clip.0,
                                            clip.1,
                                            clip.2,
                                            clip.3,
                                            draw_surfaces.presented.load(Ordering::Relaxed)
                                        ),
                                    );
                                }
                            }
                            Some(false.to_value())
                        });
                        WEBVIEWS
                            .with(|map| map.borrow_mut().insert(label.clone(), webview.clone()));
                    }
                    // The main WebView is transparent from creation on Linux
                    // (platform::configure_linux_main_window); the page and
                    // the theme background keep everything else opaque.
                    let _ = visible;
                    if let Some(previous) = previous.filter(|g| g.visible) {
                        queue_area(&webview, &previous);
                    }
                    let geometry = surfaces.geometry.lock().unwrap().get(&label).copied();
                    if let Some(area) = geometry {
                        queue_area(&webview, &area);
                    }
                })
                .map_err(|error| error.to_string())
        }

        pub(crate) fn snapshot(&self) -> Value {
            let engine = self.engine.lock().unwrap();
            let surfaces: Value = self
                .surfaces
                .geometry
                .lock()
                .unwrap()
                .iter()
                .map(|(label, g)| {
                    (
                        label.clone(),
                        json!({"visible": g.visible, "x": g.x, "y": g.y, "width": g.width, "height": g.height}),
                    )
                })
                .collect::<serde_json::Map<_, _>>()
                .into();
            json!({
                "engine": engine.as_ref().map(|e| serde_json::to_value(e.snapshot()).unwrap_or(Value::Null)),
                "surfaces": surfaces,
                "frames_presented": self.surfaces.presented.load(Ordering::Relaxed),
                "surface_draws": self.surfaces.drawn.load(Ordering::Relaxed),
                "capability": self.capability(),
            })
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn paint_fills_only_transparent_stage_pixels() {
            // A page pixel (opaque) must survive; a transparent stage pixel
            // receives black letterbox when no frame is available.
            let surface =
                gtk::cairo::ImageSurface::create(gtk::cairo::Format::ARgb32, 20, 10).unwrap();
            {
                let cr = gtk::cairo::Context::new(&surface).unwrap();
                cr.set_source_rgba(0.0, 0.0, 1.0, 1.0);
                cr.rectangle(0.0, 0.0, 10.0, 10.0);
                let _ = cr.fill();
                paint(
                    &cr,
                    &Geometry {
                        visible: true,
                        x: 0.0,
                        y: 0.0,
                        width: 20.0,
                        height: 10.0,
                    },
                    None,
                    1.0,
                );
            }
            surface.flush();
            let stride = surface.stride() as usize;
            let data = surface.take_data().unwrap();
            let pixel = |x: usize| u32::from_le_bytes(data[x * 4..x * 4 + 4].try_into().unwrap());
            assert_eq!(pixel(2), 0xff00_00ff, "opaque page pixel kept");
            assert_eq!(
                pixel(15),
                0xff00_0000,
                "transparent stage pixel letterboxed"
            );
            let _ = stride;
        }

        #[test]
        fn lifecycle_diagnostics_exclude_ticks_urls_and_error_text() {
            use bilikara_media_engine::{Observation, ObservationKind, ProgramIdentity};
            let program = ProgramIdentity {
                playback_generation: 7,
                item_id: "item".into(),
                item_incarnation_id: "incarnation".into(),
                selected_audio_variant_id: "variant".into(),
                artifact_set_id: Some("set".into()),
            };
            let observe = |kind| Observation {
                seq: 3,
                program: program.clone(),
                kind,
                position: Some(1.23456),
                duration: Some(90.0),
                intent_playing: true,
                at_ms: 5,
            };
            // seq 3 is not a sampled tick; every eighth position is kept.
            assert!(diagnostic(&observe(ObservationKind::Position)).is_none());
            let error = diagnostic(&observe(ObservationKind::Error {
                code: "pipeline-error".into(),
                fatal: true,
                detail: "http://127.0.0.1:1/media/artifacts/a?pin=secret".into(),
            }))
            .unwrap();
            assert_eq!(error["type"], "error");
            assert_eq!(error["code"], "pipeline-error");
            assert_eq!(error["playback_generation"], 7);
            assert_eq!(error["position"], 1.235);
            let text = error.to_string();
            assert!(!text.contains("secret") && !text.contains("http"), "{text}");
            let eos = diagnostic(&observe(ObservationKind::Eos {
                drained: true,
                watchdog: false,
            }))
            .unwrap();
            assert_eq!(
                (eos["type"].as_str(), eos["drained"].as_bool()),
                (Some("eos"), Some(true))
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preference_round_trips_and_rejects_corrupt_storage() {
        let directory =
            std::env::temp_dir().join(format!("bilikara-engine-pref-{}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);
        let path = directory.join(PREFERENCE_FILE);
        assert_eq!(load_preference(&path).unwrap(), None);
        save_preference(&path, EnginePreference::Legacy).unwrap();
        assert_eq!(
            load_preference(&path).unwrap(),
            Some(EnginePreference::Legacy)
        );
        save_preference(&path, EnginePreference::Gstreamer).unwrap();
        assert_eq!(
            load_preference(&path).unwrap(),
            Some(EnginePreference::Gstreamer)
        );
        fs::write(&path, b"{\"schema_version\":2,\"engine\":\"legacy\"}").unwrap();
        assert!(load_preference(&path).is_err());
        assert!(
            save_preference(&path, EnginePreference::Legacy).is_err(),
            "never overwrite unknown storage"
        );
        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn native_video_requires_webkits_dma_buf_compositing_renderer() {
        use std::ffi::OsString;
        let with = |pairs: &'static [(&'static str, &'static str)]| {
            move |key: &str| {
                pairs
                    .iter()
                    .find(|(k, _)| *k == key)
                    .map(|(_, v)| OsString::from(v))
            }
        };
        assert!(webview_renderer_supported(with(&[])));
        assert!(webview_renderer_supported(with(&[(
            "WEBKIT_DMABUF_RENDERER_FORCE_SHM",
            "1"
        )])));
        assert!(webview_renderer_supported(with(&[(
            "WEBKIT_DISABLE_DMABUF_RENDERER",
            "0"
        )])));
        assert!(!webview_renderer_supported(with(&[(
            "WEBKIT_DISABLE_DMABUF_RENDERER",
            "1"
        )])));
        assert!(!webview_renderer_supported(with(&[(
            "WEBKIT_DISABLE_COMPOSITING_MODE",
            "1"
        )])));
    }

    #[test]
    fn media_routes_are_confined_to_host_artifacts() {
        assert!(media_route(&json!("/media/artifacts/a/b/video.mp4")).is_ok());
        for bad in [
            json!("/media/native-output/x.ts"),
            json!("/media/artifacts/../secret"),
            json!("http://evil/media/artifacts/a"),
            json!("/media/artifacts/a?x=1"),
            json!("/media/artifacts/a\\b"),
            json!(42),
        ] {
            assert!(media_route(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn surfaces_reject_non_finite_rectangles() {
        let ok = SurfaceRequest {
            visible: true,
            x: 1.0,
            y: 2.0,
            width: 3.0,
            height: 4.0,
        };
        assert!(ok.validate().is_ok());
        let bad = SurfaceRequest {
            visible: true,
            x: f64::NAN,
            y: 0.0,
            width: 1.0,
            height: 1.0,
        };
        assert!(bad.validate().is_err());
        let negative = SurfaceRequest {
            visible: true,
            x: 0.0,
            y: 0.0,
            width: -1.0,
            height: 1.0,
        };
        assert!(negative.validate().is_err());
    }
}
