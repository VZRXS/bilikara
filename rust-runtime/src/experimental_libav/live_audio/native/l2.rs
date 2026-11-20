//! FFI for `bm_live_l2_v1`: the L1 request plus the composited video source.
use super::super::composite::{
    CompositeReport, CompositeVideo, EncodedUnit, Encoder, KIND_EXTERNAL, KIND_H264, KIND_MPEG2,
    OverlaySource, TranscodeCodec,
};
use super::*;
use std::cell::RefCell;

#[repr(C)]
struct Info {
    schema: u32,
    request_size: u32,
    result_size: u32,
    kinds: u32,
}
#[repr(C)]
pub(crate) struct Unit {
    data: *const u8,
    size: u32,
    key: u32,
    pts_us: i64,
    dts_us: i64,
}
type Next = extern "C" fn(*mut c_void, *mut Unit) -> i32;
type Overlay = extern "C" fn(*mut c_void, *mut u64, *mut u8, u32, u32) -> i32;
#[repr(C)]
pub(crate) struct L2Request {
    l1: Request,
    kind: u32,
    width: u32,
    height: u32,
    fps_num: u32,
    fps_den: u32,
    bit_rate: u32,
    end_us: i64,
    next: Option<Next>,
    video: *mut c_void,
    overlay: Option<Overlay>,
    overlay_opaque: *mut c_void,
}
#[repr(C)]
#[derive(Default)]
pub(crate) struct ResultData {
    live: super::ResultData,
    encoder: u32,
    reserved: u32,
    frames: u64,
    video_packets: u64,
    overlays: u64,
}
impl ResultData {
    pub(super) fn live(&self) -> super::ResultData {
        super::ResultData {
            status: self.live.status,
            complete: self.live.complete,
            packets: self.live.packets,
            bytes: self.live.bytes,
        }
    }
    pub(super) fn report(&self) -> CompositeReport {
        CompositeReport {
            encoder: Encoder::from_wire(self.encoder),
            frames: self.frames,
            video_packets: self.video_packets,
            overlays: self.overlays,
        }
    }
}

pub(crate) struct Composited {
    pub(crate) run: unsafe extern "C" fn(*const L2Request, *mut ResultData) -> u32,
    pub(crate) kinds: u32,
}
impl Composited {
    pub(crate) fn load(library: &wire::Library) -> Result<Self, ProbeError> {
        // SAFETY: only a trusted companion selected by startup is loaded; the
        // negotiated sizes pin the layouts above.
        unsafe {
            let get: unsafe extern "C" fn(u32, *mut Info) -> u32 =
                transmute(library.symbol(c"bm_l2_info_v1")?);
            let mut info = Info {
                schema: 0,
                request_size: 0,
                result_size: 0,
                kinds: 0,
            };
            if get(size_of::<Info>() as u32, &mut info) != 0
                || info.schema != 1
                || info.request_size as usize != size_of::<L2Request>()
                || info.result_size as usize != size_of::<ResultData>()
                || info.kinds & KIND_EXTERNAL == 0
            {
                return Err(backend_error("L2 capability unavailable"));
            }
            Ok(Self {
                run: transmute::<
                    *mut c_void,
                    unsafe extern "C" fn(*const L2Request, *mut ResultData) -> u32,
                >(library.symbol(c"bm_live_l2_v1")?),
                kinds: info.kinds,
            })
        }
    }
}

type NextUnit<'a> = &'a mut dyn FnMut() -> Result<Option<EncodedUnit>, ProbeError>;
pub(super) struct VideoState<'a, 'f> {
    kind: u32,
    width: u32,
    height: u32,
    next: Option<NextUnit<'a>>,
    /// Borrowed by C until the following call.
    current: Option<EncodedUnit>,
    failed: &'f AtomicBool,
    pub(super) error: Option<ProbeError>,
}
impl<'a, 'f> VideoState<'a, 'f> {
    pub(super) fn new(video: CompositeVideo<'a>, failed: &'f AtomicBool) -> Self {
        let (kind, width, height, next) = match video {
            CompositeVideo::External {
                width,
                height,
                next,
            } => (KIND_EXTERNAL, width, height, Some(next)),
            CompositeVideo::Transcode {
                codec,
                width,
                height,
            } => (
                match codec {
                    TranscodeCodec::H264 => KIND_H264,
                    TranscodeCodec::Mpeg2 => KIND_MPEG2,
                },
                width,
                height,
                None,
            ),
        };
        Self {
            kind,
            width,
            height,
            next,
            current: None,
            failed,
            error: None,
        }
    }
}
extern "C" fn video_next(opaque: *mut c_void, unit: *mut Unit) -> i32 {
    let state = unsafe { &mut *(opaque as *mut VideoState<'_, '_>) };
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let next = state
            .next
            .as_mut()
            .ok_or_else(|| backend_error("L2 video source missing"))?;
        let produced = next()?;
        if let Some(u) = &produced
            && (u.data.is_empty() || u.data.len() > 8 * 1024 * 1024 || u.pts_us < u.dts_us)
        {
            return Err(backend_error("invalid composited video unit"));
        }
        state.current = produced;
        Ok(())
    }))
    .unwrap_or_else(|_| Err(backend_error("L2 video source panic")));
    match result {
        Ok(()) => {
            let out = unsafe { &mut *unit };
            match &state.current {
                Some(u) => {
                    *out = Unit {
                        data: u.data.as_ptr(),
                        size: u.data.len() as u32,
                        key: u32::from(u.key),
                        pts_us: u.pts_us,
                        dts_us: u.dts_us,
                    }
                }
                None => {
                    *out = Unit {
                        data: std::ptr::null(),
                        size: 0,
                        key: 0,
                        pts_us: 0,
                        dts_us: 0,
                    }
                }
            }
            0
        }
        Err(e) => {
            let cancelled = matches!(e, ProbeError::Cancelled);
            state.failed.store(true, Ordering::Release);
            state.error = Some(e);
            if cancelled { 9 } else { 10 }
        }
    }
}

pub(super) struct OverlayState<'a> {
    source: &'a dyn OverlaySource,
    pub(super) error: RefCell<Option<ProbeError>>,
}
impl<'a> OverlayState<'a> {
    pub(super) fn new(source: &'a dyn OverlaySource) -> Self {
        Self {
            source,
            error: RefCell::new(None),
        }
    }
}
extern "C" fn overlay_read(
    opaque: *mut c_void,
    generation: *mut u64,
    rgba: *mut u8,
    width: u32,
    height: u32,
) -> i32 {
    let state = unsafe { &*(opaque as *const OverlayState<'_>) };
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if generation.is_null() || rgba.is_null() || width == 0 || height == 0 {
            return Err(backend_error("invalid L2 overlay request"));
        }
        let len = width as usize * height as usize * 4;
        let rgba = unsafe { std::slice::from_raw_parts_mut(rgba, len) };
        state
            .source
            .read(unsafe { &mut *generation }, rgba, width, height)
    }))
    .unwrap_or_else(|_| Err(backend_error("L2 overlay panic")));
    match result {
        Ok(()) => 0,
        Err(e) => {
            let cancelled = matches!(e, ProbeError::Cancelled);
            *state.error.borrow_mut() = Some(e);
            if cancelled { 9 } else { 10 }
        }
    }
}

pub(super) fn request(
    l1: Request,
    video: &mut VideoState<'_, '_>,
    overlay: Option<&OverlayState<'_>>,
    fps: (u32, u32),
    bit_rate: u32,
    end_us: i64,
) -> Result<L2Request, ProbeError> {
    if fps.0 == 0 || fps.1 == 0 || bit_rate == 0 || !(1..=21_600_000_000).contains(&end_us) {
        return Err(backend_error("invalid L2 request"));
    }
    let external = video.kind == KIND_EXTERNAL;
    Ok(L2Request {
        l1,
        kind: video.kind,
        width: video.width,
        height: video.height,
        fps_num: fps.0,
        fps_den: fps.1,
        bit_rate,
        end_us,
        next: external.then_some(video_next as Next),
        video: (video as *mut VideoState<'_, '_>).cast(),
        overlay: overlay.map(|_| overlay_read as Overlay),
        overlay_opaque: overlay.map_or(std::ptr::null_mut(), |o| {
            (o as *const OverlayState<'_>).cast_mut().cast()
        }),
    })
}
