//! Decoded video frames handed to native presentation surfaces.
//!
//! One appsink per program produces each frame once. Every attached surface
//! (Host stage, independent Audience) shares the same immutable mapping, so
//! switching or adding a surface never creates another decoder. Frames never
//! cross JavaScript IPC.
use gst_video::prelude::*;
use gstreamer as gst;
use gstreamer_video as gst_video;
use std::sync::Arc;

/// A mapped BGRx frame (cairo `RGB24` layout on little-endian hosts).
pub struct VideoFrame {
    frame: gst_video::VideoFrame<gst_video::video_frame::Readable>,
    pub width: u32,
    pub height: u32,
    pub stride: u32,
    /// Display aspect ratio after pixel-aspect correction.
    pub display_aspect: f64,
    pub pts_ns: Option<u64>,
    /// Monotonic per-engine frame counter.
    pub sequence: u64,
    /// Engine-internal pipeline token; surfaces use it only for diagnostics.
    pub pipeline_token: u64,
}

// SAFETY: the buffer is mapped read-only for the lifetime of the value and is
// never mutated; concurrent readers only observe immutable plane memory.
unsafe impl Sync for VideoFrame {}

impl VideoFrame {
    pub(crate) fn from_sample(sample: &gst::Sample, sequence: u64, token: u64) -> Option<Self> {
        let caps = sample.caps()?;
        let info = gst_video::VideoInfo::from_caps(caps).ok()?;
        if info.format() != gst_video::VideoFormat::Bgrx {
            return None;
        }
        let buffer = sample.buffer_owned()?;
        let pts_ns = buffer.pts().map(|t| t.nseconds());
        let frame = gst_video::VideoFrame::from_buffer_readable(buffer, &info).ok()?;
        let width = frame.width();
        let height = frame.height();
        let stride = u32::try_from(*frame.plane_stride().first()?).ok()?;
        let par = info.par();
        let par = if par.numer() > 0 && par.denom() > 0 {
            f64::from(par.numer()) / f64::from(par.denom())
        } else {
            1.0
        };
        if width == 0 || height == 0 || stride < width * 4 {
            return None;
        }
        Some(Self {
            frame,
            width,
            height,
            stride,
            display_aspect: f64::from(width) * par / f64::from(height),
            pts_ns,
            sequence,
            pipeline_token: token,
        })
    }

    /// Packed BGRx rows, `stride` bytes apart.
    pub fn data(&self) -> &[u8] {
        self.frame.plane_data(0).unwrap_or(&[])
    }
}

/// Receives frames on GStreamer streaming threads at their render time.
/// Implementations must return quickly and must not call back into the engine.
pub trait FrameSink: Send + Sync + 'static {
    fn present(&self, frame: Arc<VideoFrame>);
    /// The program owning the surface retired; drop the last frame.
    fn clear(&self);
}

/// Sink that discards frames (audio-only runs and headless tests).
pub struct NullFrameSink;

impl FrameSink for NullFrameSink {
    fn present(&self, _frame: Arc<VideoFrame>) {}
    fn clear(&self) {}
}
