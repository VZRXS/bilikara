//! Optional Windows ShowHost C ABI adapter. The DLL owns media processing,
//! program timing, its encoder and the Cast HTTP server. Call this adapter on
//! one service thread: loading and teardown synchronously wait for native work.
use serde::Serialize;
use std::marker::PhantomData;
use std::path::Path;
use std::rc::Rc;

pub const EXPECTED_ABI: &str = "ShowHost Cast with audience HUD ABI v1";
pub const REQUIRED_ABI_SYMBOLS: &[&str] = &[
    "show_host_create",
    "show_host_destroy",
    "show_host_load_with_options",
    "show_host_prepare_next",
    "show_host_set_audience_hud_state",
    "show_host_start_cast_stream",
    "show_host_get_cast_stream_port",
    "show_host_stop_cast_stream",
    "show_host_play",
    "show_host_pause",
    "show_host_stop",
    "show_host_seek",
    "show_host_set_volume",
    "show_host_set_key_semitones",
    "show_host_set_audio_clock_offset",
    "show_host_get_state",
    "show_host_get_position",
    "show_host_get_duration",
    "show_host_is_buffering",
    "show_host_get_cast_pipeline_stats",
];

#[derive(Debug, Clone, Serialize)]
pub struct Error {
    pub code: String,
    pub message: String,
}

impl Error {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for Error {}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Status {
    pub state: i32,
    pub position: f64,
    pub duration: f64,
    pub buffering: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize)]
pub(crate) struct HudRow {
    pub title: String,
    pub requester: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize)]
pub(crate) struct QueueHud {
    pub current: Option<HudRow>,
    pub upcoming: Vec<HudRow>,
}

/// Owns exactly one native instance and its loaded library. It deliberately
/// cannot be sent/shared across threads; create it inside the service worker.
pub struct ShowHostNativeAdapter {
    #[cfg(windows)]
    native: Option<native::Native>,
    _thread_bound: PhantomData<Rc<()>>,
}

#[cfg(windows)]
impl ShowHostNativeAdapter {
    pub fn open(dll_path: &Path) -> Result<Self, Error> {
        Ok(Self {
            native: Some(native::Native::open(dll_path)?),
            _thread_bound: PhantomData,
        })
    }

    fn instance(&self) -> Result<&native::Native, Error> {
        self.native
            .as_ref()
            .ok_or_else(|| Error::new("SESSION_CLOSED", "ShowHost session is closed"))
    }

    /// Start Cast before loading the first media item. This avoids opening a
    /// separate local video decoder/audio device that Cast would then replace.
    pub fn start_stream(&mut self) -> Result<u16, Error> {
        let n = self.instance()?;
        if !unsafe { (n.api.start_cast)(n.host, 0) } {
            return Err(Error::new(
                "STREAM_START_FAILED",
                "ShowHost could not start its Cast encoder/HTTP pipeline",
            ));
        }
        let port = unsafe { (n.api.port)(n.host) };
        if port == 0 {
            unsafe { (n.api.stop_cast)(n.host) };
            return Err(Error::new(
                "STREAM_URL_FAILED",
                "ShowHost returned an unbound Cast HTTP port",
            ));
        }
        Ok(port)
    }

    pub fn port(&self) -> Result<u16, Error> {
        let n = self.instance()?;
        Ok(unsafe { (n.api.port)(n.host) })
    }

    /// Both files are supplied independently, including DASH/m4s cache files.
    /// Empty lyrics/overlay are intentional. load() acknowledges submission;
    /// Show's video decoder opens asynchronously, so inspect actual HTTP media
    /// and status before claiming successful playback.
    pub fn load(&mut self, video: &Path, audio: &Path) -> Result<(), Error> {
        let n = self.instance()?;
        let video = native::media_path(video)?;
        let audio = native::media_path(audio)?;
        if !unsafe {
            (n.api.load)(
                n.host,
                video.as_ptr(),
                std::ptr::null(),
                audio.as_ptr(),
                std::ptr::null(),
                1,
                1,
            )
        } {
            return Err(Error::new(
                "MEDIA_OPEN_FAILED",
                "ShowHost rejected the video/audio program",
            ));
        }
        Ok(())
    }

    pub(crate) fn prepare_next(&mut self, video: &Path, audio: &Path) -> Result<bool, Error> {
        let n = self.instance()?;
        let video = native::media_path(video)?;
        let audio = native::media_path(audio)?;
        // Match load() so Show can promote this standby programme at the boundary.
        Ok(unsafe {
            (n.api.prepare)(
                n.host,
                video.as_ptr(),
                std::ptr::null(),
                audio.as_ptr(),
                std::ptr::null(),
                1,
            )
        })
    }

    pub(crate) fn set_queue_hud(&mut self, revision: u64, hud: &QueueHud) -> Result<(), Error> {
        native::set_queue_hud(self.instance()?, revision, hud)
    }

    pub fn play(&mut self) -> Result<(), Error> {
        if self.status()?.state == 1 {
            return Ok(());
        }
        let n = self.instance()?;
        unsafe { (n.api.play)(n.host) };
        self.wait_for_command("play", |status| status.state == 1)
    }

    pub fn pause(&mut self) -> Result<(), Error> {
        if self.status()?.state == 2 {
            return Ok(());
        }
        let n = self.instance()?;
        unsafe { (n.api.pause)(n.host) };
        self.wait_for_command("pause", |status| status.state == 2)
    }

    pub fn seek(&mut self, seconds: f64) -> Result<(), Error> {
        validate_seek(seconds)?;
        let n = self.instance()?;
        unsafe { (n.api.seek)(n.host, seconds) };
        Ok(())
    }

    pub fn set_volume(&mut self, percent: i32) -> Result<(), Error> {
        if !(0..=100).contains(&percent) {
            return Err(Error::new(
                "INVALID_ARGUMENT",
                "ShowHost volume must be between 0 and 100",
            ));
        }
        let n = self.instance()?;
        unsafe { (n.api.volume)(n.host, percent) };
        Ok(())
    }

    pub fn set_key(&mut self, semitones: i32) -> Result<(), Error> {
        if !(-6..=6).contains(&semitones) {
            return Err(Error::new(
                "UNSUPPORTED_CONTROL",
                "ShowHost supports pitch from -6 to +6 semitones",
            ));
        }
        let n = self.instance()?;
        unsafe { (n.api.key)(n.host, semitones) };
        Ok(())
    }

    pub fn set_audio_offset(&mut self, seconds: f64) -> Result<(), Error> {
        validate_offset(seconds)?;
        let n = self.instance()?;
        unsafe { (n.api.offset)(n.host, seconds) };
        Ok(())
    }

    pub fn status(&self) -> Result<Status, Error> {
        let n = self.instance()?;
        let status = unsafe {
            Status {
                state: (n.api.state)(n.host),
                position: (n.api.position)(n.host),
                duration: (n.api.duration)(n.host),
                buffering: (n.api.buffering)(n.host),
            }
        };
        validate_status(status)
    }

    /// Counts actual decoded source frames, excluding the continuous idle TS
    /// program. A newly started session must reach a nonzero count before it
    /// can be considered a media pipeline success.
    pub fn decoded_frames(&self) -> Result<u64, Error> {
        self.instance()?.decoded_frames()
    }

    pub(crate) fn served_streams(&self) -> Result<u64, Error> {
        self.instance()?.served_streams()
    }

    /// Stops the current song while keeping the HTTP stream/encoder alive.
    /// Show emits its idle program until another load, or close().
    pub fn stop(&mut self) -> Result<(), Error> {
        let stopped = |status: Status| status.state == 3 && status.position <= 0.001;
        if stopped(self.status()?) {
            return Ok(());
        }
        let n = self.instance()?;
        unsafe { (n.api.stop)(n.host) };
        self.wait_for_command("stop", stopped)
    }

    fn wait_for_command(&self, command: &str, ready: impl Fn(Status) -> bool) -> Result<(), Error> {
        // Native playback commands use PostMessage whereas load/seek use
        // SendMessage. Confirm the posted state transition before a following
        // synchronous command can overtake it and affect the wrong program.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            if ready(self.status()?) {
                return Ok(());
            }
            if std::time::Instant::now() >= deadline {
                return Err(Error::new(
                    "NATIVE_COMMAND_FAILED",
                    format!("ShowHost did not acknowledge {command} within 5 seconds"),
                ));
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }

    /// Synchronous and idempotent: native destroy joins its worker threads
    /// before the last DLL reference can be released.
    pub fn close(&mut self) -> Result<(), Error> {
        drop(self.native.take());
        Ok(())
    }
}

#[cfg(not(windows))]
impl ShowHostNativeAdapter {
    pub fn open(_dll_path: &Path) -> Result<Self, Error> {
        Err(unavailable())
    }
    pub fn start_stream(&mut self) -> Result<u16, Error> {
        Err(unavailable())
    }
    pub fn port(&self) -> Result<u16, Error> {
        Err(unavailable())
    }
    pub fn load(&mut self, _video: &Path, _audio: &Path) -> Result<(), Error> {
        Err(unavailable())
    }
    pub(crate) fn prepare_next(&mut self, _video: &Path, _audio: &Path) -> Result<bool, Error> {
        Err(unavailable())
    }
    pub(crate) fn set_queue_hud(&mut self, _revision: u64, _hud: &QueueHud) -> Result<(), Error> {
        Err(unavailable())
    }
    pub fn play(&mut self) -> Result<(), Error> {
        Err(unavailable())
    }
    pub fn pause(&mut self) -> Result<(), Error> {
        Err(unavailable())
    }
    pub fn seek(&mut self, _seconds: f64) -> Result<(), Error> {
        Err(unavailable())
    }
    pub fn set_volume(&mut self, _percent: i32) -> Result<(), Error> {
        Err(unavailable())
    }
    pub fn set_key(&mut self, _semitones: i32) -> Result<(), Error> {
        Err(unavailable())
    }
    pub fn set_audio_offset(&mut self, _seconds: f64) -> Result<(), Error> {
        Err(unavailable())
    }
    pub fn status(&self) -> Result<Status, Error> {
        Err(unavailable())
    }
    pub fn decoded_frames(&self) -> Result<u64, Error> {
        Err(unavailable())
    }
    pub(crate) fn served_streams(&self) -> Result<u64, Error> {
        Err(unavailable())
    }
    pub fn stop(&mut self) -> Result<(), Error> {
        Err(unavailable())
    }
    pub fn close(&mut self) -> Result<(), Error> {
        Ok(())
    }
}

#[cfg(not(windows))]
fn unavailable() -> Error {
    Error::new(
        "BACKEND_UNAVAILABLE",
        "ShowHost media casting is available on Windows only",
    )
}

#[cfg(any(windows, test))]
fn validate_seek(seconds: f64) -> Result<(), Error> {
    if !seconds.is_finite() || seconds < 0.0 {
        return Err(Error::new(
            "INVALID_ARGUMENT",
            "ShowHost seek must be finite and nonnegative",
        ));
    }
    Ok(())
}

#[cfg(any(windows, test))]
fn validate_offset(seconds: f64) -> Result<(), Error> {
    if !seconds.is_finite() || !(-2.0..=2.0).contains(&seconds) {
        return Err(Error::new(
            "UNSUPPORTED_CONTROL",
            "ShowHost audio offset must be between -2 and +2 seconds",
        ));
    }
    Ok(())
}

#[cfg(any(windows, test))]
fn validate_status(status: Status) -> Result<Status, Error> {
    if !(0..=3).contains(&status.state)
        || !status.position.is_finite()
        || status.position < 0.0
        || !status.duration.is_finite()
        || status.duration < 0.0
    {
        return Err(Error::new(
            "NATIVE_OUTPUT_INVALID",
            "ShowHost returned an invalid playback status",
        ));
    }
    Ok(status)
}

#[cfg(windows)]
mod native {
    use super::{EXPECTED_ABI, Error, HudRow, QueueHud};
    use std::ffi::{CStr, OsString, c_void};
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use std::os::windows::io::AsRawHandle;
    use std::path::{Component, Path, PathBuf, Prefix};
    use std::sync::Mutex;
    use windows_sys::Win32::Foundation::{FreeLibrary, HMODULE};
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
    };
    use windows_sys::Win32::System::LibraryLoader::{
        GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS, GET_MODULE_HANDLE_EX_FLAG_PIN, GetModuleFileNameW,
        GetModuleHandleExW, GetProcAddress, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR,
        LOAD_LIBRARY_SEARCH_SYSTEM32, LoadLibraryExW,
    };

    // Show registers process-owned Win32 classes whose window procedures live
    // inside its DLL, and its current C ABI has no class-unregister operation.
    // Pin exactly one validated DLL image for this process so those callbacks
    // cannot dangle between otherwise fully destroyed native instances.
    static PROCESS_DLL_PATH: Mutex<Option<PathBuf>> = Mutex::new(None);

    type Handle = *mut c_void;
    type Action = unsafe extern "C" fn(Handle);
    type Load = unsafe extern "C" fn(
        Handle,
        *const u16,
        *const u16,
        *const u16,
        *const u16,
        i32,
        i32,
    ) -> bool;
    type Prepare =
        unsafe extern "C" fn(Handle, *const u16, *const u16, *const u16, *const u16, i32) -> bool;

    #[repr(C)]
    struct HudEntry {
        title: *const u16,
        artist: *const u16,
    }

    #[repr(C)]
    struct HudState {
        struct_size: u32,
        abi_version: u32,
        flags: u32,
        queue_count: u32,
        revision: u64,
        network_name: *const u16,
        queue: *const HudEntry,
        current_title: *const u16,
        current_artist: *const u16,
    }

    pub(super) fn set_queue_hud(n: &Native, revision: u64, hud: &QueueHud) -> Result<(), Error> {
        let wide = |text: &str| {
            let mut value = Vec::new();
            for ch in text.chars().filter(|ch| !ch.is_control()) {
                if value.len() + ch.len_utf16() > 512 {
                    break;
                }
                value.extend_from_slice(ch.encode_utf16(&mut [0; 2]));
            }
            value.push(0);
            value
        };
        let encode = |row: &HudRow| (wide(&row.title), wide(&row.requester));
        let current = hud.current.as_ref().map(encode);
        let upcoming = hud.upcoming.iter().take(4).map(encode).collect::<Vec<_>>();
        let entries = upcoming
            .iter()
            .map(|(title, requester)| HudEntry {
                title: title.as_ptr(),
                // Show names this column artist. Bilikara uses it for the requester.
                artist: requester.as_ptr(),
            })
            .collect::<Vec<_>>();
        let state = HudState {
            struct_size: std::mem::size_of::<HudState>() as u32,
            abi_version: 1,
            flags: 2, // SHOW_HOST_HUD_QUEUE_ENABLED
            queue_count: entries.len() as u32,
            revision,
            network_name: std::ptr::null(),
            queue: entries.as_ptr(),
            current_title: current
                .as_ref()
                .map_or(std::ptr::null(), |row| row.0.as_ptr()),
            current_artist: current
                .as_ref()
                .map_or(std::ptr::null(), |row| row.1.as_ptr()),
        };
        // The versioned setter copies every borrowed string before returning.
        if unsafe { (n.api.queue_hud)(n.host, &state) } {
            Ok(())
        } else {
            Err(Error::new(
                "HUD_UPDATE_FAILED",
                "ShowHost rejected the queue HUD",
            ))
        }
    }

    // Existing query-only ShowHostCastPipelineStats C layout. These diagnostics
    // are independent of Stage/Flutter rendering transports and callbacks.
    #[repr(C)]
    #[derive(Default)]
    struct EventStats {
        count: u64,
        last_frame_id: u64,
        last_qpc: u64,
        maximum_gap_qpc: u64,
        total_duration_qpc: u64,
        maximum_duration_qpc: u64,
    }

    #[repr(C)]
    #[derive(Default)]
    struct CastPipelineStats {
        struct_size: u32,
        reserved: u32,
        session_generation: u64,
        qpc_frequency: u64,
        decoded_frames: u64,
        repeated_frames: u64,
        video_processor_passes: u64,
        compute_dispatches: u64,
        gpu_copies: u64,
        explicit_flushes: u64,
        encoder_drops: u64,
        decoder_underflows: u64,
        decoder_recoveries: u64,
        client_rebases: u64,
        texture_creations: u64,
        view_creations: u64,
        missed_output_slots: u64,
        events: [EventStats; 13],
    }

    const _: () = assert!(std::mem::size_of::<CastPipelineStats>() == 752);

    pub(super) struct Api {
        create: unsafe extern "C" fn() -> Handle,
        destroy: Action,
        pub load: Load,
        pub prepare: Prepare,
        queue_hud: unsafe extern "C" fn(Handle, *const HudState) -> bool,
        pub start_cast: unsafe extern "C" fn(Handle, u16) -> bool,
        pub port: unsafe extern "C" fn(Handle) -> u16,
        pub stop_cast: Action,
        pub play: Action,
        pub pause: Action,
        pub stop: Action,
        pub seek: unsafe extern "C" fn(Handle, f64),
        pub volume: unsafe extern "C" fn(Handle, i32),
        pub key: unsafe extern "C" fn(Handle, i32),
        pub offset: unsafe extern "C" fn(Handle, f64),
        pub state: unsafe extern "C" fn(Handle) -> i32,
        pub position: unsafe extern "C" fn(Handle) -> f64,
        pub duration: unsafe extern "C" fn(Handle) -> f64,
        pub buffering: unsafe extern "C" fn(Handle) -> bool,
        stats: unsafe extern "C" fn(Handle, *mut CastPipelineStats) -> bool,
    }

    struct Library(HMODULE);

    impl Library {
        fn symbol(&self, name: &CStr) -> Result<unsafe extern "system" fn() -> isize, Error> {
            unsafe { GetProcAddress(self.0, name.as_ptr().cast()) }.ok_or_else(|| {
                Error::new(
                    "SYMBOL_NOT_FOUND",
                    format!(
                        "missing symbol: {}; expected DLL ABI: {EXPECTED_ABI}",
                        name.to_string_lossy()
                    ),
                )
            })
        }
    }

    impl Drop for Library {
        fn drop(&mut self) {
            unsafe { FreeLibrary(self.0) };
        }
    }

    pub(super) struct Native {
        pub host: Handle,
        pub api: Api,
        // The library must remain loaded until Drop has completed destroy().
        _library: Library,
    }

    impl Native {
        pub fn open(path: &Path) -> Result<Self, Error> {
            if !path.is_absolute() {
                return Err(Error::new(
                    "DLL_NOT_FOUND",
                    "ShowHost DLL requires an absolute application-local path",
                ));
            }
            let path = path.canonicalize().map_err(|error| {
                Error::new("DLL_NOT_FOUND", format!("{}: {error}", path.display()))
            })?;
            if !path.is_file() {
                return Err(Error::new(
                    "DLL_NOT_FOUND",
                    format!("{} is not a DLL file", path.display()),
                ));
            }
            let wide = wide_path(&path)?;
            let handle = unsafe {
                LoadLibraryExW(
                    wide.as_ptr(),
                    std::ptr::null_mut(),
                    LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32,
                )
            };
            if handle.is_null() {
                return Err(Error::new(
                    "INIT_FAILED",
                    format!(
                        "cannot load {}: {}",
                        path.display(),
                        std::io::Error::last_os_error()
                    ),
                ));
            }
            let library = Library(handle);
            let mut loaded_name = vec![0_u16; 32_768];
            let length = unsafe {
                GetModuleFileNameW(handle, loaded_name.as_mut_ptr(), loaded_name.len() as u32)
            };
            if length == 0 || length as usize >= loaded_name.len() {
                return Err(Error::new(
                    "INIT_FAILED",
                    "could not verify the loaded ShowHost DLL path",
                ));
            }
            let actual = PathBuf::from(OsString::from_wide(&loaded_name[..length as usize]))
                .canonicalize()
                .map_err(|error| {
                    Error::new(
                        "INIT_FAILED",
                        format!("cannot canonicalize the loaded ShowHost DLL path: {error}"),
                    )
                })?;
            if !same_file(&actual, &path)? {
                return Err(Error::new(
                    "INIT_FAILED",
                    format!(
                        "Windows reused a different ShowHost DLL image: requested {}; loaded {}",
                        path.display(),
                        actual.display()
                    ),
                ));
            }
            // Resolve every function before creating any native worker. A bad
            // ABI therefore fails without a partial media session to unwind.
            macro_rules! bind {
                ($name:literal, $ty:ty) => {
                    unsafe {
                        std::mem::transmute::<unsafe extern "system" fn() -> isize, $ty>(
                            library.symbol($name)?,
                        )
                    }
                };
            }
            let api = Api {
                create: bind!(c"show_host_create", unsafe extern "C" fn() -> Handle),
                destroy: bind!(c"show_host_destroy", Action),
                load: bind!(c"show_host_load_with_options", Load),
                prepare: bind!(c"show_host_prepare_next", Prepare),
                queue_hud: bind!(
                    c"show_host_set_audience_hud_state",
                    unsafe extern "C" fn(Handle, *const HudState) -> bool
                ),
                start_cast: bind!(
                    c"show_host_start_cast_stream",
                    unsafe extern "C" fn(Handle, u16) -> bool
                ),
                port: bind!(
                    c"show_host_get_cast_stream_port",
                    unsafe extern "C" fn(Handle) -> u16
                ),
                stop_cast: bind!(c"show_host_stop_cast_stream", Action),
                play: bind!(c"show_host_play", Action),
                pause: bind!(c"show_host_pause", Action),
                stop: bind!(c"show_host_stop", Action),
                seek: bind!(c"show_host_seek", unsafe extern "C" fn(Handle, f64)),
                volume: bind!(c"show_host_set_volume", unsafe extern "C" fn(Handle, i32)),
                key: bind!(
                    c"show_host_set_key_semitones",
                    unsafe extern "C" fn(Handle, i32)
                ),
                offset: bind!(
                    c"show_host_set_audio_clock_offset",
                    unsafe extern "C" fn(Handle, f64)
                ),
                state: bind!(c"show_host_get_state", unsafe extern "C" fn(Handle) -> i32),
                position: bind!(
                    c"show_host_get_position",
                    unsafe extern "C" fn(Handle) -> f64
                ),
                duration: bind!(
                    c"show_host_get_duration",
                    unsafe extern "C" fn(Handle) -> f64
                ),
                buffering: bind!(
                    c"show_host_is_buffering",
                    unsafe extern "C" fn(Handle) -> bool
                ),
                stats: bind!(
                    c"show_host_get_cast_pipeline_stats",
                    unsafe extern "C" fn(Handle, *mut CastPipelineStats) -> bool
                ),
            };
            let mut process_path = PROCESS_DLL_PATH.lock().map_err(|_| {
                Error::new(
                    "INIT_FAILED",
                    "ShowHost process library guard is unavailable",
                )
            })?;
            if let Some(previous) = process_path.as_ref()
                && !same_file(previous, &path)?
            {
                return Err(Error::new(
                    "INIT_FAILED",
                    format!(
                        "ShowHost is already initialized from {}; restart bilikara before selecting {}",
                        previous.display(),
                        path.display()
                    ),
                ));
            }
            // Even a failed create may have registered the window classes.
            // Pin after all symbols are bound but before calling native code.
            let mut pinned = std::ptr::null_mut();
            let pin_ok = unsafe {
                GetModuleHandleExW(
                    GET_MODULE_HANDLE_EX_FLAG_PIN | GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,
                    api.create as *const () as *const u16,
                    &mut pinned,
                )
            };
            if pin_ok == 0 || pinned != handle {
                return Err(Error::new(
                    "INIT_FAILED",
                    format!(
                        "could not retain ShowHost process callback lifetime: {}",
                        std::io::Error::last_os_error()
                    ),
                ));
            }
            *process_path = Some(path);
            drop(process_path);
            let host = unsafe { (api.create)() };
            if host.is_null() {
                return Err(Error::new(
                    "SESSION_CREATE_FAILED",
                    "ShowHost could not initialize its native Stage/MF worker",
                ));
            }
            Ok(Self {
                host,
                api,
                _library: library,
            })
        }

        fn cast_stats(&self) -> Result<CastPipelineStats, Error> {
            let mut stats = CastPipelineStats {
                struct_size: std::mem::size_of::<CastPipelineStats>() as u32,
                ..Default::default()
            };
            if !unsafe { (self.api.stats)(self.host, &mut stats) } {
                return Err(Error::new(
                    "NATIVE_OUTPUT_INVALID",
                    "ShowHost rejected the existing Cast pipeline diagnostics ABI",
                ));
            }
            Ok(stats)
        }

        pub fn decoded_frames(&self) -> Result<u64, Error> {
            Ok(self.cast_stats()?.decoded_frames)
        }

        pub fn served_streams(&self) -> Result<u64, Error> {
            // SHOW_CAST_EVENT_HTTP_FIRST_BYTE, counted after sending payload.
            Ok(self.cast_stats()?.events[9].count)
        }
    }

    impl Drop for Native {
        fn drop(&mut self) {
            // stop() posts asynchronously, while stop_cast() and destroy()
            // synchronize with the dedicated window/worker threads.
            unsafe {
                (self.api.stop)(self.host);
                (self.api.stop_cast)(self.host);
                (self.api.destroy)(self.host);
            }
            self.host = std::ptr::null_mut();
        }
    }

    fn wide_path(path: &Path) -> Result<Vec<u16>, Error> {
        let mut value: Vec<u16> = path.as_os_str().encode_wide().collect();
        if value.contains(&0) {
            return Err(Error::new(
                "INVALID_ARGUMENT",
                "native path contains a NUL character",
            ));
        }
        value.push(0);
        Ok(value)
    }

    fn same_file(left: &Path, right: &Path) -> Result<bool, Error> {
        fn identity(path: &Path) -> Result<(u32, u32, u32), Error> {
            let file = std::fs::File::open(path).map_err(|error| {
                Error::new(
                    "INIT_FAILED",
                    format!(
                        "cannot inspect native file identity for {}: {error}",
                        path.display()
                    ),
                )
            })?;
            let mut info = BY_HANDLE_FILE_INFORMATION::default();
            if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
                return Err(Error::new(
                    "INIT_FAILED",
                    format!(
                        "cannot inspect native file identity for {}: {}",
                        path.display(),
                        std::io::Error::last_os_error()
                    ),
                ));
            }
            Ok((
                info.dwVolumeSerialNumber,
                info.nFileIndexHigh,
                info.nFileIndexLow,
            ))
        }
        Ok(identity(left)? == identity(right)?)
    }

    // Media Foundation's URL resolver does not interpret Win32 device-namespace
    // paths as local media. Keep the canonical path for validation, reconstruct
    // only this media-URL boundary in ordinary Win32 spelling, then prove that
    // spelling still opens exactly the same native file. DLL loading retains
    // its absolute canonical path and restricted search flags.
    fn mf_path(path: &Path) -> Result<PathBuf, Error> {
        let mut components = path.components();
        let mut result = match components.next() {
            Some(Component::Prefix(prefix)) => match prefix.kind() {
                Prefix::VerbatimDisk(drive) => PathBuf::from(format!("{}:\\", char::from(drive))),
                Prefix::VerbatimUNC(server, share) => {
                    let mut prefix = OsString::from("\\\\");
                    prefix.push(server);
                    prefix.push("\\");
                    prefix.push(share);
                    prefix.push("\\");
                    PathBuf::from(prefix)
                }
                Prefix::Disk(_) | Prefix::UNC(_, _) => return Ok(path.to_owned()),
                _ => {
                    return Err(Error::new(
                        "MEDIA_OPEN_FAILED",
                        "ShowHost media requires an ordinary local-drive or UNC file path",
                    ));
                }
            },
            _ => {
                return Err(Error::new(
                    "MEDIA_OPEN_FAILED",
                    "ShowHost media path has no Windows volume",
                ));
            }
        };
        for component in components {
            match component {
                Component::RootDir => {}
                Component::Normal(value) => result.push(value),
                _ => {
                    return Err(Error::new(
                        "MEDIA_OPEN_FAILED",
                        "ShowHost media path is not canonical",
                    ));
                }
            }
        }
        if !same_file(path, &result)? {
            return Err(Error::new(
                "MEDIA_OPEN_FAILED",
                "ordinary Media Foundation path changed the validated file identity",
            ));
        }
        Ok(result)
    }

    pub fn media_path(path: &Path) -> Result<Vec<u16>, Error> {
        let path = path.canonicalize().map_err(|error| {
            Error::new("MEDIA_OPEN_FAILED", format!("{}: {error}", path.display()))
        })?;
        if !path.is_file() {
            return Err(Error::new(
                "MEDIA_OPEN_FAILED",
                format!("{} is not a media file", path.display()),
            ));
        }
        wide_path(&mf_path(&path)?)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn media_url_boundary_keeps_unicode_and_native_file_identity() {
            let directory = std::env::temp_dir().join(format!(
                "bilikara-show-path-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir(&directory).unwrap();
            let original = directory.join("媒体 fixture.mp4");
            let alias = directory.join("same-file-link.mp4");
            std::fs::write(&original, b"fixture").unwrap();
            std::fs::hard_link(&original, &alias).unwrap();
            {
                let canonical = original.canonicalize().unwrap();
                let mf = mf_path(&canonical).unwrap();
                assert!(
                    matches!(mf.components().next(), Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::UNC(_, _)))
                );
                assert!(same_file(&canonical, &mf).unwrap());
                assert!(same_file(&canonical, &alias).unwrap());
                let wide = media_path(&canonical).unwrap();
                assert_eq!(wide.last(), Some(&0));
                let submitted = PathBuf::from(OsString::from_wide(&wide[..wide.len() - 1]));
                assert!(same_file(&canonical, &submitted).unwrap());
            }
            std::fs::remove_file(&alias).unwrap();
            std::fs::remove_file(&original).unwrap();
            std::fs::remove_dir(&directory).unwrap();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_values_are_validated_before_state_projection() {
        let status = Status {
            state: 1,
            position: 1.0,
            duration: 20.0,
            buffering: false,
        };
        assert_eq!(validate_status(status).unwrap(), status);
        for status in [
            Status { state: 4, ..status },
            Status {
                position: f64::NAN,
                ..status
            },
            Status {
                duration: f64::INFINITY,
                ..status
            },
            Status {
                position: -1.0,
                ..status
            },
        ] {
            assert_eq!(
                validate_status(status).unwrap_err().code,
                "NATIVE_OUTPUT_INVALID"
            );
        }
        for invalid in [f64::NAN, f64::INFINITY, -1.0] {
            assert!(validate_seek(invalid).is_err());
        }
        for invalid in [f64::NAN, -2.01, 2.01] {
            assert!(validate_offset(invalid).is_err());
        }
        assert!(validate_seek(0.0).is_ok());
        assert!(validate_offset(-2.0).is_ok());
        assert!(validate_offset(2.0).is_ok());
    }

    #[test]
    #[cfg(not(windows))]
    fn other_platforms_report_unavailable() {
        let error = match ShowHostNativeAdapter::open(Path::new("/tmp/show_host.dll")) {
            Ok(_) => panic!("Windows backend unexpectedly available"),
            Err(error) => error,
        };
        assert_eq!(error.code, "BACKEND_UNAVAILABLE");
    }

    #[test]
    #[cfg(windows)]
    fn missing_abi_fails_before_session_creation() {
        let directory = std::env::var_os("SystemRoot").expect("Windows SystemRoot");
        // kernel32 is a preloaded KnownDLL: loading its verbatim absolute name
        // with restricted search flags can fail with ERROR_INVALID_ADDRESS
        // before symbol binding. version.dll is a real, unrelated Windows
        // library and exercises the intended successful-load/missing-ABI path.
        let path = std::path::PathBuf::from(directory).join("System32/version.dll");
        let error = match ShowHostNativeAdapter::open(&path) {
            Ok(_) => panic!("unrelated DLL unexpectedly accepted"),
            Err(error) => error,
        };
        assert_eq!(error.code, "SYMBOL_NOT_FOUND", "{error}");
        assert!(error.message.contains("show_host_create"));
        assert!(error.message.contains(EXPECTED_ABI));
    }
}
