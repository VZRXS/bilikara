//! Platform video compositor for the composited cast (L2, external video).
//!
//! A platform with a hardware pipeline (Android: MediaCodec decode -> GL
//! overlay -> MediaCodec encode) installs one compositor at startup. The cast
//! producer opens one stream per program and pulls encoded H.264 units from
//! it; the companion muxes them with the L1 audio. Platforms without one use
//! the companion's own transcoder instead. Rust owns the overlay pixels.
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, OnceLock};

/// One Annex B access unit; SPS/PPS precede every key unit. Times are source
/// microseconds on the requested frame grid.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Unit {
    pub data: Vec<u8>,
    pub key: bool,
    pub pts_us: i64,
    pub dts_us: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Request {
    /// Cached source video (any codec the platform decodes).
    pub video: PathBuf,
    /// Output starts at the first frame at or after this source time.
    pub start_us: i64,
    /// Output ends before this source time.
    pub end_us: i64,
    /// Encoded size; the source is scaled to fit with black bars.
    pub width: u32,
    pub height: u32,
    /// Frame-rate cap (the source rate is halved until it fits).
    pub fps: (u32, u32),
    pub bit_rate: u32,
}

pub trait Stream: Send {
    /// Blocks until the next unit; `None` ends the program. Waits observe
    /// `cancelled` at least every 250 ms and then fail.
    fn next(&mut self, cancelled: &AtomicBool) -> Result<Option<Unit>, String>;
    /// The platform encoder actually used, for diagnostics.
    fn encoder(&self) -> String {
        String::new()
    }
    /// Premultiplied RGBA at the output size; applies to frames encoded
    /// after this call. An all-transparent image clears the overlay.
    fn set_overlay(&mut self, rgba: &[u8]) -> Result<(), String>;
}

/// Implementations must not call AppState synchronously.
pub trait Compositor: Send + Sync {
    /// Short stable name for diagnostics, e.g. `android_mediacodec`.
    fn name(&self) -> &'static str;
    fn open(&self, request: &Request) -> Result<Box<dyn Stream>, String>;
}

static COMPOSITOR: OnceLock<Arc<dyn Compositor>> = OnceLock::new();

/// Installs the platform compositor once, before casts start.
pub fn install(compositor: Arc<dyn Compositor>) -> Result<(), &'static str> {
    COMPOSITOR
        .set(compositor)
        .map_err(|_| "cast_compositor_already_installed")
}

pub fn installed() -> Option<Arc<dyn Compositor>> {
    COMPOSITOR.get().cloned()
}

/// The installed platform compositor's name, if any.
pub fn capability() -> Option<&'static str> {
    COMPOSITOR.get().map(|c| c.name())
}
