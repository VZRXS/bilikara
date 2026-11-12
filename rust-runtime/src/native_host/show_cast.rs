//! Windows Cast is a playback owner, not a mirror of a running WebView.
//! AppState owns the queue, commands and observations. One joined worker owns
//! the receiver connection and one Show process/TS endpoint until disconnect.
use super::*;
use crate::app_state::{AppStateRequest, PlaylistItem};
use crate::show_dlna::{self, Renderer};
use crate::show_host_process::ShowHostProcess;
use crate::windows_show_host::{HudRow, QueueHud, Status};
use serde::Deserialize;
use std::time::Instant;

mod media;
use media::{MediaKey, SessionFiles};

#[cfg(all(test, windows, target_arch = "x86_64"))]
mod tests;

#[derive(Clone, Copy, Default, PartialEq, Eq)]
enum Phase {
    #[default]
    Idle,
    Discovering,
    Connecting,
    Active,
    Stopping,
    Error,
}

impl Phase {
    fn label(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Discovering => "discovering",
            Self::Connecting => "connecting",
            Self::Active => "active",
            Self::Stopping => "stopping",
            Self::Error => "error",
        }
    }
}

enum Command {
    Discover,
    Connect(Renderer),
    Disconnect,
}

/// Frontend titles are presentation data. Item order and requesters always
/// come from AppState. A late submission cannot label a different programme.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Titles {
    playback_generation: u64,
    queue_version: String,
    current: Option<String>,
    upcoming: Vec<String>,
}

/// Bounded worker input. The playback poll must not clone the Host's history,
/// ratings or entire playlist ten times per second.
pub(crate) struct CastInput {
    pub(crate) playback_generation: u64,
    pub(crate) queue_version: String,
    pub(crate) current_item: Option<PlaylistItem>,
    pub(crate) upcoming: Vec<PlaylistItem>,
    pub(crate) volume_percent: i32,
    pub(crate) is_muted: bool,
    pub(crate) key_shift: i32,
}

#[derive(Default)]
pub(crate) struct CastState {
    supported: bool,
    available: bool,
    phase: Phase,
    pub(crate) owns_playback: bool,
    operation: u64,
    pending: Option<Command>,
    renderers: Vec<Renderer>,
    selected: Option<String>,
    error: Option<String>,
    titles: Option<Titles>,
    pub(crate) resume: Option<Value>,
}

impl CastState {
    pub(crate) fn snapshot(&self) -> Value {
        json!({
            "supported": self.supported, "available": self.available,
            "phase": self.phase.label(), "owns_playback": self.owns_playback,
            "renderers": self.renderers.iter().map(|r| json!({"id":r.id, "name":r.name})).collect::<Vec<_>>(),
            "selected_renderer_id": self.selected, "error_code": self.error,
            "resume": self.resume,
        })
    }
}

fn dll_path() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("BILIKARA_SHOW_HOST_DLL") {
        let path = PathBuf::from(path);
        return (path.is_absolute() && path.is_file()).then_some(path);
    }
    let path = std::env::current_exe()
        .ok()?
        .parent()?
        .join("vendor/show-host/libshow_host.dll");
    path.is_file().then_some(path)
}

pub(super) fn start(context: Arc<HostContext>) -> Result<(), ApiError> {
    if !cfg!(all(windows, target_arch = "x86_64")) || !context.desktop {
        return Ok(());
    }
    let dll = dll_path();
    with_app(|app| {
        let session = app.native();
        session.show_cast.supported = true;
        session.show_cast.available = dll.is_some();
        session.revision += 1;
        Ok(())
    })?;
    if let Some(dll) = dll {
        let worker_context = context.clone();
        context
            .spawn("windows-show-cast", move || worker(&worker_context, &dll))
            .map_err(|_| ApiError::new(503, "cast_worker", "无法启动投屏服务"))?;
    }
    Ok(())
}

pub(super) fn route(
    context: &HostContext,
    identity: &Identity,
    method: &Method,
    path: &str,
    body: Value,
) -> Result<Value, ApiError> {
    with_app(|app| {
        app.native_authorize(identity, true)?;
        if method != Method::POST || !body.is_object() {
            return Err(ApiError::invalid("投屏操作需要 POST JSON"));
        }
        if app.native_session_choice_pending() {
            return Err(ApiError::new(
                409,
                "session_choice_pending",
                "请先选择或创建场次",
            ));
        }
        let snapshot = app.native_cast_input()?;
        let session = app.native();
        let state = &mut session.show_cast;
        if !context.desktop || !state.available {
            return Err(ApiError::new(
                501,
                "cast_unavailable",
                "未安装新版 Windows ShowHost 组件",
            ));
        }
        if path == "/api/show-cast/hud" {
            if !state.owns_playback || state.phase != Phase::Active {
                return Ok(json!({"accepted":false}));
            }
            let titles: Titles =
                serde_json::from_value(body).map_err(|_| ApiError::invalid("投屏待播标题无效"))?;
            if titles.playback_generation != snapshot.playback_generation
                || titles.queue_version != snapshot.queue_version
                || titles.current.is_some() != snapshot.current_item.is_some()
                || titles.upcoming.len() != snapshot.upcoming.len()
            {
                return Ok(json!({"accepted":false}));
            }
            if titles
                .current
                .iter()
                .chain(&titles.upcoming)
                .any(|title| title.len() > 4096)
            {
                return Err(ApiError::invalid("投屏待播标题过长"));
            }
            state.titles = Some(titles);
            return Ok(json!({"accepted":true}));
        }
        let (phase, command) = match path {
            "/api/show-cast/discover" if matches!(state.phase, Phase::Idle | Phase::Error) => {
                state.renderers.clear();
                (Phase::Discovering, Command::Discover)
            }
            "/api/show-cast/connect"
                if matches!(state.phase, Phase::Idle | Phase::Discovering | Phase::Error) =>
            {
                let id = body["renderer_id"]
                    .as_str()
                    .ok_or_else(|| ApiError::invalid("请选择投屏设备"))?;
                let renderer = state
                    .renderers
                    .iter()
                    .find(|r| r.id == id)
                    .cloned()
                    .ok_or_else(|| {
                        ApiError::new(409, "renderer_unavailable", "请重新搜索投屏设备")
                    })?;
                state.selected = Some(renderer.id.clone());
                (Phase::Connecting, Command::Connect(renderer))
            }
            "/api/show-cast/disconnect"
                if matches!(
                    state.phase,
                    Phase::Active | Phase::Connecting | Phase::Discovering
                ) =>
            {
                (Phase::Stopping, Command::Disconnect)
            }
            "/api/show-cast/disconnect" if matches!(state.phase, Phase::Idle | Phase::Error) => {
                state.phase = Phase::Idle;
                state.error = None;
                session.revision += 1;
                return app.native_snapshot(true);
            }
            "/api/show-cast/discover" | "/api/show-cast/connect" | "/api/show-cast/disconnect" => {
                return Err(ApiError::new(409, "cast_busy", "投屏操作正在进行"));
            }
            _ => return Err(ApiError::new(404, "not_found", "未知投屏操作")),
        };
        state.phase = phase;
        state.error = None;
        state.operation += 1;
        state.pending = Some(command);
        session.revision += 1;
        app.native_snapshot(true)
    })
}

fn queue_hud(snapshot: &CastInput, titles: Option<&Titles>) -> QueueHud {
    let titles = titles.filter(|t| {
        t.playback_generation == snapshot.playback_generation
            && t.queue_version == snapshot.queue_version
    });
    let row = |item: &PlaylistItem, title: Option<&String>| HudRow {
        title: title
            .filter(|t| !t.trim().is_empty())
            .cloned()
            .unwrap_or_else(|| {
                bilikara_rust::clean_display_title(
                    &item.title,
                    &item.display_title,
                    &item.part_title,
                )
            }),
        requester: item.requester_name.clone(),
    };
    QueueHud {
        current: snapshot
            .current_item
            .as_ref()
            .map(|item| row(item, titles.and_then(|t| t.current.as_ref()))),
        upcoming: snapshot
            .upcoming
            .iter()
            .take(4)
            .enumerate()
            .map(|(i, item)| row(item, titles.and_then(|t| t.upcoming.get(i))))
            .collect(),
    }
}

fn native_error(error: crate::windows_show_host::Error) -> ApiError {
    ApiError::new(502, &error.code, error.message)
}

#[derive(Clone)]
struct Programme {
    generation: u64,
    item_id: String,
    incarnation: String,
    media: MediaKey,
}

struct Active {
    // The process must exit before the private cache names are removed.
    native: ShowHostProcess,
    files: SessionFiles,
    renderer: Renderer,
    programme: Option<Programme>,
    initial: Option<Value>,
    want_play: bool,
    last_settings: Option<(i32, i32)>,
    last_hud: Option<QueueHud>,
    hud_revision: u64,
    prepared: Option<MediaKey>,
    waiting_generation: Option<u64>,
    last_report: Option<(Instant, &'static str)>,
    loaded_at: Instant,
    saw_playback: bool,
}

impl Active {
    fn new(
        native: ShowHostProcess,
        files: SessionFiles,
        renderer: Renderer,
        initial: Option<Value>,
    ) -> Self {
        Self {
            native,
            files,
            renderer,
            programme: None,
            initial,
            want_play: true,
            last_settings: None,
            last_hud: None,
            hud_revision: 0,
            prepared: None,
            waiting_generation: None,
            last_report: None,
            loaded_at: Instant::now(),
            saw_playback: false,
        }
    }

    fn connect(
        context: &HostContext,
        dll: &Path,
        renderer: Renderer,
        operation: u64,
    ) -> Result<Self, ApiError> {
        let files = SessionFiles::new(context)?;
        let mut native = ShowHostProcess::open(dll).map_err(native_error)?;
        // Open Cast first. Show provides its idle programme while Bilikara
        // waits for the receiver and keeps local playback available.
        let port = native.start_stream().map_err(native_error)?;
        if !operation_current(context, operation) {
            return Err(ApiError::new(409, "cast_cancelled", "投屏已取消"));
        }
        let uri = format!("http://{}:{port}/cast/stage.ts", renderer.local_address);
        if let Err(error) = show_dlna::connect(&renderer, &uri, "Bilikara") {
            let _ = show_dlna::stop(&renderer);
            return Err(ApiError::new(502, "CAST_FAILED", error));
        }
        let initial = (|| {
            // SOAP success alone is insufficient. Wait for the new Show HTTP
            // server to send its first payload, without querying TV playback.
            let deadline = Instant::now() + Duration::from_secs(8);
            loop {
                if !operation_current(context, operation) {
                    return Err(ApiError::new(409, "cast_cancelled", "投屏已取消"));
                }
                if native.served_streams().map_err(native_error)? > 0 {
                    break;
                }
                if Instant::now() >= deadline {
                    return Err(ApiError::new(
                        502,
                        "CAST_NO_MEDIA_REQUEST",
                        "投屏设备没有拉取视频流",
                    ));
                }
                thread::sleep(Duration::from_millis(100));
            }
            with_app(|app| {
                let state = &mut app.native().show_cast;
                if state.operation != operation
                    || state.phase != Phase::Connecting
                    || context.stop.load(Ordering::Acquire)
                {
                    return Err(ApiError::new(409, "cast_cancelled", "投屏已取消"));
                }
                state.phase = Phase::Active;
                state.owns_playback = true;
                state.resume = None;
                state.titles = None;
                Ok(app.native_take_cast_playback())
            })
        })();
        let initial = match initial {
            Ok(initial) => initial,
            Err(error) => {
                let _ = show_dlna::stop(&renderer);
                return Err(error);
            }
        };
        Ok(Self::new(native, files, renderer, initial))
    }

    fn close(mut self) -> Result<(), ApiError> {
        // A receiver is allowed to reject Stop. The native endpoint still closes.
        let result = self.native.close().map_err(native_error);
        let _ = show_dlna::stop(&self.renderer);
        result
    }

    fn settings(&mut self, settings: &CastInput) -> Result<(), ApiError> {
        // Show's gain stops at 100%; local preferences remain intact.
        let volume = if settings.is_muted {
            0
        } else {
            settings.volume_percent.clamp(0, 100)
        };
        if self.last_settings.is_none_or(|old| old.0 != volume) {
            self.native.set_volume(volume).map_err(native_error)?;
        }
        if self
            .last_settings
            .is_none_or(|old| old.1 != settings.key_shift)
        {
            self.native
                .set_key(settings.key_shift)
                .map_err(native_error)?;
        }
        self.last_settings = Some((volume, settings.key_shift));
        Ok(())
    }

    fn load(
        &mut self,
        context: &HostContext,
        snapshot: &CastInput,
        item: &PlaylistItem,
        media: MediaKey,
    ) -> Result<bool, ApiError> {
        let generation = snapshot.playback_generation;
        let mut position = 0.0;
        if let Some(initial) = self
            .initial
            .take()
            .filter(|o| o["playback_generation"] == generation && o["item_id"] == item.id)
        {
            position = initial["current_time"].as_f64().unwrap_or(0.0);
            self.want_play =
                initial["is_paused"] != true || initial["observed_phase"] == "starting";
        } else if let Some(old) = &self.programme {
            if old.incarnation == item.item_incarnation_id {
                if old.media != media {
                    // Track/cache replacement keeps the song position. A
                    // restart with unchanged media begins at zero instead.
                    position = self.native.status().map_err(native_error)?.position;
                }
            } else {
                self.want_play = true;
            }
        }
        let paths = self.files.paths(context, &media);
        if !owns_programme(generation)? {
            return Ok(false);
        }
        let (video, audio) = paths?;
        let loaded = self.native.load(&video, &audio).map_err(native_error);
        if !owns_programme(generation)? {
            return Ok(false);
        }
        loaded?;
        self.programme = Some(Programme {
            generation,
            item_id: item.id.clone(),
            incarnation: item.item_incarnation_id.clone(),
            media,
        });
        self.waiting_generation = None;
        self.prepared = None;
        self.saw_playback = false;
        self.loaded_at = Instant::now();
        self.last_report = None;
        // Load has a separate source clock; no Cast HTTP/encoder reset.
        if position > 0.0 {
            let duration = self.native.status().map_err(native_error)?.duration;
            let target = if duration > 0.0 {
                position.min(duration)
            } else {
                position
            };
            self.native.seek(target).map_err(native_error)?;
        }
        if self.want_play {
            self.native.play().map_err(native_error)?;
        }
        Ok(true)
    }

    fn command(
        &mut self,
        command: &Value,
        snapshot: &CastInput,
        status: Option<Status>,
    ) -> Result<(), ApiError> {
        let generation = snapshot.playback_generation;
        let seq = command["seq"].as_u64().unwrap_or(0);
        if command["playback_generation"] == generation
            && command["item_id"].as_str() == snapshot.current_item.as_ref().map(|i| i.id.as_str())
        {
            match command["action"].as_str() {
                Some("next-track") => {
                    self.want_play = true;
                    advance(generation)?;
                }
                Some("toggle-play" | "play" | "pause") => {
                    self.want_play = match command["action"].as_str() {
                        Some("toggle-play") => !self.want_play,
                        Some("play") => true,
                        _ => false,
                    };
                    if let Some(status) = status {
                        if self.want_play {
                            if !self.saw_playback && status.state != 1 {
                                self.loaded_at = Instant::now();
                            }
                            self.native.play().map_err(native_error)?;
                        } else if status.state == 1 {
                            self.native.pause().map_err(native_error)?;
                        }
                    }
                }
                Some("seek-relative" | "seek-absolute") => {
                    if let Some(status) = status {
                        let target = if command["action"] == "seek-relative" {
                            status.position + command["delta_seconds"].as_f64().unwrap_or(0.0)
                        } else {
                            command["target_seconds"]
                                .as_f64()
                                .unwrap_or(status.position)
                        };
                        self.native
                            .seek(target.clamp(0.0, status.duration))
                            .map_err(native_error)?;
                    }
                }
                _ => {}
            }
        }
        with_app(|app| {
            app.native_execute(AppStateRequest::AckPlayerControl {
                schema_version: 1,
                seq,
            })?;
            Ok(())
        })?;
        self.last_report = None;
        Ok(())
    }

    fn observe(&mut self, snapshot: &CastInput, status: Status) -> Result<(), ApiError> {
        let programme = self.programme.as_ref().expect("loaded programme");
        let playing = status.state == 1 && !status.buffering && status.position > 0.0;
        self.saw_playback |= playing;
        // Show reaches STOPPED when its programme clock finishes. This is a
        // sender event: the tail is already on the existing TS timeline, so
        // it is safe to append the next song without receiver telemetry.
        let ended = self.want_play
            && status.state == 3
            && (self.saw_playback || (status.duration > 0.0 && status.position >= status.duration));
        if self.want_play
            && !self.saw_playback
            && !ended
            && self.loaded_at.elapsed() > Duration::from_secs(30)
        {
            return Err(ApiError::new(
                502,
                "CAST_MEDIA_FAILED",
                "Show 未能开始播放当前歌曲",
            ));
        }
        let phase = if ended {
            "ended"
        } else if playing {
            "playing"
        } else if self.want_play {
            "starting"
        } else {
            "paused"
        };
        if self
            .last_report
            .is_none_or(|(at, old)| old != phase || at.elapsed() >= Duration::from_secs(1))
        {
            with_app(|app| {
                app.native_report_cast_playback(
                    programme.generation,
                    &programme.item_id,
                    phase,
                    status.position,
                    status.duration,
                    now(),
                )
            })?;
            self.last_report = Some((Instant::now(), phase));
        }
        if ended {
            advance(snapshot.playback_generation)?;
        }
        Ok(())
    }

    fn tick(&mut self, context: &HostContext) -> Result<(), ApiError> {
        let (snapshot, command, hud) = with_app(|app| {
            let snapshot = app.native_cast_input()?;
            let command = app.native_cast_control();
            let hud = queue_hud(&snapshot, app.native().show_cast.titles.as_ref());
            Ok((snapshot, command, hud))
        })?;
        let generation = snapshot.playback_generation;
        if !owns_programme(generation)? {
            return Ok(());
        }
        if self.last_hud.as_ref() != Some(&hud) {
            self.hud_revision += 1;
            self.native
                .set_queue_hud(self.hud_revision, &hud)
                .map_err(native_error)?;
            self.last_hud = Some(hud);
        }
        self.settings(&snapshot)?;
        let item = snapshot.current_item.as_ref();
        let media = item.map(MediaKey::from_ready).transpose()?.flatten();
        let status = if let (Some(item), Some(media)) = (item, media) {
            if self
                .programme
                .as_ref()
                .is_none_or(|loaded| loaded.generation != generation || loaded.media != media)
                && !self.load(context, &snapshot, item, media)?
            {
                return Ok(());
            }
            Some(self.native.status().map_err(native_error)?)
        } else {
            if self.waiting_generation != Some(generation) {
                if self.programme.take().is_some() {
                    self.native.stop().map_err(native_error)?;
                    self.want_play = true;
                }
                self.waiting_generation = Some(generation);
                self.last_report = None;
            }
            None
        };
        if !owns_programme(generation)? {
            return Ok(());
        }
        if let Some(command) = command {
            self.command(&command, &snapshot, status)?;
            return Ok(());
        }
        if let Some(status) = status {
            self.observe(&snapshot, status)?;
        }
        if let Some(next) = snapshot
            .upcoming
            .first()
            .and_then(|item| MediaKey::from_ready(item).ok().flatten())
            && self.prepared.as_ref() != Some(&next)
        {
            // Prewarming is opportunistic; normal load remains the fallback.
            if let Ok((video, audio)) = self.files.paths(context, &next) {
                self.native
                    .prepare_next(&video, &audio)
                    .map_err(native_error)?;
                self.prepared = Some(next);
            }
        }
        Ok(())
    }
}

fn owns_programme(generation: u64) -> Result<bool, ApiError> {
    with_app(|app| {
        Ok(app.native().show_cast.phase == Phase::Active && app.native_cast_generation(generation))
    })
}

fn operation_current(context: &HostContext, operation: u64) -> bool {
    !context.stop.load(Ordering::Acquire)
        && with_app(|app| Ok(app.native().show_cast.operation == operation)).unwrap_or(false)
}

fn advance(generation: u64) -> Result<(), ApiError> {
    with_app(|app| {
        if app.native().show_cast.phase == Phase::Active && app.native_cast_generation(generation) {
            app.native_execute(AppStateRequest::AdvanceToNext {
                schema_version: 1,
                expected_playback_generation: generation,
                reset_av_delay: false,
                now: now(),
            })?;
        }
        Ok(())
    })
}

fn finish(operation: u64, error: Option<ApiError>) {
    if let Some(error) = &error {
        eprintln!("[show-cast] {error}");
    }
    let _ = with_app(|app| {
        if app.native().show_cast.operation != operation {
            return Ok(());
        }
        let was_owner = app.native().show_cast.owns_playback;
        if was_owner && let Err(error) = app.native_return_cast_playback() {
            eprintln!("[show-cast] return playback: {error}");
        }
        let session = app.native();
        let state = &mut session.show_cast;
        state.owns_playback = false;
        state.phase = if error.is_some() {
            Phase::Error
        } else {
            Phase::Idle
        };
        state.selected = None;
        state.error = error.map(|e| e.code);
        state.titles = None;
        session.revision += 1;
        Ok(())
    });
}

fn worker(context: &HostContext, dll: &Path) {
    let mut active = None::<Active>;
    let mut operation = 0;
    while !context.stop.load(Ordering::Acquire) {
        let pending = with_app(|app| {
            let state = &mut app.native().show_cast;
            Ok(state
                .pending
                .take()
                .map(|command| (state.operation, command)))
        })
        .ok()
        .flatten();
        let result = if let Some((id, command)) = pending {
            operation = id;
            match command {
                Command::Discover => show_dlna::discover(
                    || !operation_current(context, id),
                    |renderers| {
                        let _ = with_app(|app| {
                            let session = app.native();
                            let cast = &mut session.show_cast;
                            if cast.operation == id && cast.renderers != renderers {
                                cast.renderers = renderers;
                                session.revision += 1;
                            }
                            Ok(())
                        });
                    },
                )
                .map_err(|e| ApiError::new(502, "DISCOVERY_FAILED", e))
                .and_then(|()| {
                    with_app(|app| {
                        let session = app.native();
                        if session.show_cast.operation == id {
                            session.show_cast.phase = Phase::Idle;
                            session.revision += 1;
                        }
                        Ok(())
                    })
                }),
                Command::Connect(renderer) => {
                    Active::connect(context, dll, renderer, id).map(|session| {
                        active = Some(session);
                    })
                }
                Command::Disconnect => {
                    let error = active.take().and_then(|session| session.close().err());
                    finish(id, error);
                    Ok(())
                }
            }
        } else if let Some(session) = &mut active {
            session.tick(context)
        } else {
            Ok(())
        };
        if let Err(error) = result {
            if let Some(session) = active.take() {
                let _ = session.close();
            }
            finish(operation, Some(error));
        }
        thread::sleep(Duration::from_millis(100));
    }
    if let Some(session) = active {
        let _ = session.close();
    }
}
