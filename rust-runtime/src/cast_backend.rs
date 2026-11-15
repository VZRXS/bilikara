//! Media operations used by the Cast session. Backends own their media
//! readers and output stream for the entire session, including song changes.
use serde::{Deserialize, Serialize};
use std::net::Ipv4Addr;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize)]
pub struct Error {
    pub code: String,
    pub message: String,
}

impl Error {
    pub(crate) fn new(code: &str, message: impl Into<String>) -> Self {
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PlaybackState {
    Idle,
    Playing,
    Paused,
    Stopped,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct PlaybackStatus {
    pub state: PlaybackState,
    pub position: f64,
    pub duration: f64,
    pub buffering: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AudioSlot {
    First,
    Second,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct HudRow {
    pub title: String,
    pub requester: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct QueueHud {
    pub current: Option<HudRow>,
    pub upcoming: Vec<HudRow>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PlaybackAction {
    Clear,
    Play,
    Pause,
    Skip,
    VolumeUp,
    VolumeDown,
}

pub(crate) struct MediaPaths {
    pub video: PathBuf,
    pub first: PathBuf,
    pub second: Option<PathBuf>,
}

pub(crate) trait CastBackend {
    fn start_output(&mut self, local_address: Ipv4Addr) -> Result<String, Error>;
    fn has_served_output(&mut self) -> Result<bool, Error>;
    fn load_media(&mut self, media: &MediaPaths) -> Result<(), Error>;
    fn prepare_media(&mut self, media: &MediaPaths) -> Result<(), Error>;
    fn set_audio_track(&mut self, slot: AudioSlot) -> Result<(), Error>;
    fn resync_audio(&mut self) -> Result<(), Error>;
    fn set_queue_hud(&mut self, revision: u64, hud: &QueueHud) -> Result<(), Error>;
    fn notify_action(&mut self, action: PlaybackAction) -> Result<(), Error>;
    fn play(&mut self) -> Result<(), Error>;
    fn pause(&mut self) -> Result<(), Error>;
    /// Stop the current song while retaining the output session.
    fn stop(&mut self) -> Result<(), Error>;
    fn seek(&mut self, seconds: f64) -> Result<(), Error>;
    fn set_volume(&mut self, percent: i32) -> Result<(), Error>;
    fn set_key(&mut self, semitones: i32) -> Result<(), Error>;
    fn playback_status(&mut self) -> Result<PlaybackStatus, Error>;
    /// Finish all reads before the host releases the session's media files.
    fn close(&mut self) -> Result<(), Error>;
}
