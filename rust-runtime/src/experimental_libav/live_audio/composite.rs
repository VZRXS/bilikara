//! L2, the composited cast: L1 audio and pacing with a video stream that was
//! decoded, overlaid and re-encoded. Either a platform pipeline supplies
//! encoded H.264 units (`External`, e.g. Android MediaCodec) or the companion
//! transcodes the source itself (`Transcode`, e.g. Media Foundation on
//! Windows). Times are source microseconds, as for L1.
use super::ProbeError;

/// Caller-encoded H.264 units.
pub const KIND_EXTERNAL: u32 = 1;
/// In-companion transcode with a platform H.264 encoder.
pub const KIND_H264: u32 = 2;
/// In-companion transcode with the software MPEG-2 encoder.
pub const KIND_MPEG2: u32 = 4;

pub enum CompositeVideo<'a> {
    External {
        width: u32,
        height: u32,
        /// Blocks until the next unit; `None` ends the stream.
        next: &'a mut dyn FnMut() -> Result<Option<EncodedUnit>, ProbeError>,
    },
    /// The source is contain-fitted (black bars) into `width`x`height`.
    Transcode {
        codec: TranscodeCodec,
        width: u32,
        height: u32,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TranscodeCodec {
    H264,
    Mpeg2,
}

/// One Annex B access unit; SPS/PPS precede every key unit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EncodedUnit {
    pub data: Vec<u8>,
    pub key: bool,
    pub pts_us: i64,
    pub dts_us: i64,
}

/// The latest overlay. `read` copies premultiplied RGBA of exactly
/// `width * height * 4` bytes and advances `generation` only when the image
/// differs from the one the caller holds (all zero clears the overlay).
pub trait OverlaySource {
    fn read(
        &self,
        generation: &mut u64,
        rgba: &mut [u8],
        width: u32,
        height: u32,
    ) -> Result<(), ProbeError>;
}

/// What the video shows. `Hold` and `Blank` carry silence and need no audio
/// track; `Blank` needs no video file either (a full-frame overlay card).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum CompositeSource {
    /// The program from the start position.
    #[default]
    Play,
    /// The program's frame at the start position, repeated.
    Hold,
    /// Black frames.
    Blank,
}

pub struct Composite<'a> {
    pub video: CompositeVideo<'a>,
    pub source: CompositeSource,
    /// Frame-rate cap; the source rate is halved until it fits.
    pub fps: (u32, u32),
    pub bit_rate: u32,
    /// Program end (source microseconds), which bounds the output.
    pub end_us: i64,
    pub overlay: Option<&'a dyn OverlaySource>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Encoder {
    #[default]
    External,
    Mpeg2,
    MediaFoundationHardware,
    MediaFoundationSoftware,
    VideoToolbox,
    Unknown(u32),
}

impl Encoder {
    pub(super) fn from_wire(value: u32) -> Self {
        match value {
            0 => Self::External,
            1 => Self::Mpeg2,
            2 => Self::MediaFoundationHardware,
            3 => Self::MediaFoundationSoftware,
            4 => Self::VideoToolbox,
            other => Self::Unknown(other),
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::External => "external",
            Self::Mpeg2 => "mpeg2_software",
            Self::MediaFoundationHardware => "media_foundation_hardware",
            Self::MediaFoundationSoftware => "media_foundation_software",
            Self::VideoToolbox => "videotoolbox",
            Self::Unknown(_) => "unknown",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CompositeReport {
    pub encoder: Encoder,
    /// Frames sent to the in-companion encoder (0 for external video).
    pub frames: u64,
    pub video_packets: u64,
    /// Overlay generations converted for blending.
    pub overlays: u64,
}
