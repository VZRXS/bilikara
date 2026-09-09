//! Explicit, optional Linux libav stream metadata discovery.
//!
//! `avformat_open_input` + `avformat_find_stream_info` may read packets and do
//! limited decoding. This is neither header-only I/O nor full scan/validation.
//! No normal startup, cache, player, Python ABI or media path calls this module.
//! See `media-libav/README.md` for the trusted-artifact contract and build.

#[cfg(target_os = "linux")]
mod wire;

/// Pure developer comparison semantics; never consulted by normal media work.
pub mod comparison;
mod scan;
pub use scan::{PacketScan, PacketSummary, ScanSelection, ScanTerminal, TimestampBounds};
mod remux;
pub use remux::{CopyProfile, CopyRemuxRequest, CopyRemuxResult, FlacStreamInfo};

use crate::MediaError;
#[cfg(target_os = "linux")]
use crate::MediaErrorKind;
use serde::Serialize;
use std::path::Path;
use std::sync::atomic::AtomicBool;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", content = "detail", rename_all = "snake_case")]
pub enum ProbeError {
    Unavailable(String),
    Media(MediaError),
    /// A recognized demuxer outside this metadata preview's MOV/FLAC scope.
    /// Detection does not certify that the input is valid in that format.
    UnsupportedFormat(String),
    Cancelled,
    BackendFailure(String),
}

impl std::fmt::Display for ProbeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for ProbeError {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BackendInfo {
    pub backend: String,
    pub abi_version: u32,
    pub build_version: String,
    pub runtime_version: String,
    /// Packed version integers in format, codec, util order.
    pub build_library_versions: [u32; 3],
    pub runtime_library_versions: [u32; 3],
    pub build_configuration: String,
    pub runtime_configurations: [String; 3],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InspectionLevel {
    StreamMetadata,
    PacketScan,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StreamType {
    Unknown,
    Video,
    Audio,
    Subtitle,
    Data,
    Attachment,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct TimeBase {
    pub numerator: i32,
    pub denominator: i32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StreamMetadata {
    pub index: u32,
    pub media_type: StreamType,
    pub codec_name: Option<String>,
    pub duration_us: Option<i64>,
    pub start_time_us: Option<i64>,
    pub time_base: Option<TimeBase>,
    pub width_px: Option<u32>,
    pub height_px: Option<u32>,
    pub sample_rate_hz: Option<u32>,
    pub channel_count: Option<u32>,
    pub bit_rate_bps: Option<i64>,
    pub raw_bit_depth: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Metadata {
    pub backend: String,
    pub inspection_level: InspectionLevel,
    pub container: String,
    pub duration_us: Option<i64>,
    pub start_time_us: Option<i64>,
    pub bit_rate_bps: Option<i64>,
    pub streams: Vec<StreamMetadata>,
}

/// An explicitly loaded trusted companion. Results are copied into Rust-owned
/// values and released in the companion before each call returns.
pub struct LibavMetadataProbe {
    info: BackendInfo,
    #[cfg(target_os = "linux")]
    probe: wire::Probe,
    #[cfg(target_os = "linux")]
    release: wire::Release,
    #[cfg(target_os = "linux")]
    _library: wire::linux::Library,
    #[cfg(target_os = "linux")]
    scan: Option<scan::Capability>,
    #[cfg(target_os = "linux")]
    remux: Option<remux::Capability>,
}

impl LibavMetadataProbe {
    /// Load one trusted absolute companion path; never scan PATH/CWD.
    /// Missing dependencies and incompatible ABI/build report `Unavailable`.
    ///
    /// # Safety
    /// The caller must trust the artifact and its dependency location. Loading
    /// executes native code. It must implement `media-libav/probe.h` faithfully;
    /// negotiation checks compatibility, not malicious-library safety or crash
    /// containment. Do not replace artifacts while loading/using this handle.
    pub unsafe fn load(companion: &Path) -> Result<Self, ProbeError> {
        #[cfg(target_os = "linux")]
        {
            if !companion.is_absolute() || !companion.is_file() {
                return Err(ProbeError::Unavailable(
                    "companion must be an existing absolute regular-file path".into(),
                ));
            }
            // SAFETY: propagated trusted-artifact precondition; every symbol is
            // negotiated before probing, and the handle is owned by this value.
            let library = unsafe { wire::linux::Library::open(companion)? };
            let abi: wire::Abi = unsafe { std::mem::transmute(library.symbol(c"bm_abi_version")?) };
            if unsafe { abi() } != wire::ABI {
                return Err(ProbeError::Unavailable("incompatible companion ABI".into()));
            }
            let get_info: wire::GetInfo =
                unsafe { std::mem::transmute(library.symbol(c"bm_get_info")?) };
            let mut raw = std::mem::MaybeUninit::<wire::Info>::zeroed();
            let status =
                unsafe { get_info(std::mem::size_of::<wire::Info>() as u32, raw.as_mut_ptr()) };
            if status != 0 {
                return Err(ProbeError::Unavailable(
                    "companion runtime build/configuration negotiation failed".into(),
                ));
            }
            let raw = unsafe { raw.assume_init() };
            let info = convert_info(&raw)?;
            let probe = unsafe {
                std::mem::transmute::<*mut std::ffi::c_void, wire::Probe>(
                    library.symbol(c"bm_probe_metadata")?,
                )
            };
            let release = unsafe {
                std::mem::transmute::<*mut std::ffi::c_void, wire::Release>(
                    library.symbol(c"bm_release")?,
                )
            };
            let scan = scan::Capability::load(&library).ok();
            let remux = remux::Capability::load(&library).ok();
            Ok(Self {
                remux,
                scan,
                info,
                probe,
                release,
                _library: library,
            })
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = companion;
            Err(ProbeError::Unavailable(
                "libav metadata loading is implemented only on Linux in M1".into(),
            ))
        }
    }

    pub fn backend_info(&self) -> &BackendInfo {
        &self.info
    }

    /// Discover at most 32 streams from a caller-authorized regular local file.
    /// Unknown fields stay `None`; no track selection or acceptance for any
    /// normalization/publication contract is implied. No retries or fallback.
    /// Cancellation is cooperative, not a wall-clock timeout.
    pub fn probe_metadata(
        &self,
        source: &Path,
        cancelled: &AtomicBool,
    ) -> Result<Metadata, ProbeError> {
        #[cfg(target_os = "linux")]
        {
            self.probe_with_callback(source, &Callback::new(cancelled))
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = (source, cancelled);
            Err(ProbeError::Unavailable(
                "libav metadata loading is implemented only on Linux in M1".into(),
            ))
        }
    }

    #[cfg(target_os = "linux")]
    fn probe_with_callback(
        &self,
        source: &Path,
        callback: &Callback<'_>,
    ) -> Result<Metadata, ProbeError> {
        use std::os::fd::AsRawFd;
        use std::sync::atomic::Ordering;
        if callback.flag.load(Ordering::Relaxed) {
            return Err(ProbeError::Cancelled);
        }
        let file = open_input(source)?;
        let request = wire::Request {
            fd: file.as_raw_fd(),
            cancelled: cancellation_callback,
            opaque: (callback as *const Callback<'_>).cast_mut().cast(),
        };
        let mut pointer = std::ptr::null_mut();
        // SAFETY: fd, callback context and handle stay live until the synchronous
        // C call and result release complete. The C side duplicates this fd.
        let status = unsafe { (self.probe)(&request, &mut pointer) };
        let owned = OwnedResult {
            pointer,
            owner: self,
        };
        if status != 0 {
            return Err(status_error(
                status,
                "probe could not produce a result".into(),
            ));
        }
        if owned.pointer.is_null() {
            return Err(backend_error("companion returned a null result"));
        }
        // SAFETY: negotiated v1 aggregate, exclusively owned until guard drops.
        convert_metadata(unsafe { &*owned.pointer }, &self.info.backend)
    }
}

#[cfg(target_os = "linux")]
fn open_input(source: &Path) -> Result<std::fs::File, ProbeError> {
    use std::fs::OpenOptions;
    use std::os::unix::fs::OpenOptionsExt;
    if !source.is_absolute() {
        return Err(media_error(
            MediaErrorKind::InvalidRequest,
            "source must be an absolute local path",
        ));
    }
    // Preserve M1's descriptor-based check, including racing FIFO substitutions.
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(source)
        .map_err(input_error)?;
    if !file.metadata().map_err(input_error)?.is_file() {
        return Err(media_error(
            MediaErrorKind::InvalidRequest,
            "source must be a regular file",
        ));
    }
    Ok(file)
}

#[cfg(target_os = "linux")]
fn media_error(kind: MediaErrorKind, message: &str) -> ProbeError {
    ProbeError::Media(MediaError {
        kind,
        message: message.into(),
    })
}

#[cfg(target_os = "linux")]
fn input_error(error: std::io::Error) -> ProbeError {
    let kind = match error.kind() {
        std::io::ErrorKind::NotFound => MediaErrorKind::SourceMissing,
        std::io::ErrorKind::InvalidInput => MediaErrorKind::InvalidRequest,
        _ => MediaErrorKind::Io,
    };
    media_error(kind, &error.to_string())
}

#[cfg(target_os = "linux")]
fn backend_error(message: &str) -> ProbeError {
    ProbeError::BackendFailure(message.into())
}

#[cfg(target_os = "linux")]
struct Callback<'a> {
    flag: &'a AtomicBool,
    #[cfg(test)]
    cancel_on_observation: u32,
    #[cfg(test)]
    observations: std::sync::atomic::AtomicU32,
}
#[cfg(target_os = "linux")]
impl<'a> Callback<'a> {
    fn new(flag: &'a AtomicBool) -> Self {
        Self {
            flag,
            #[cfg(test)]
            cancel_on_observation: 0,
            #[cfg(test)]
            observations: std::sync::atomic::AtomicU32::new(0),
        }
    }
}
#[cfg(target_os = "linux")]
extern "C" fn cancellation_callback(opaque: *mut std::ffi::c_void) -> i32 {
    use std::sync::atomic::Ordering;
    // SAFETY: private synchronous callback, borrowed from probe_with_callback.
    // Only non-panicking atomic operations occur; no unwind crosses C.
    let callback = unsafe { &*opaque.cast::<Callback<'_>>() };
    #[cfg(test)]
    if callback.observations.fetch_add(1, Ordering::Relaxed) + 1 == callback.cancel_on_observation {
        callback.flag.store(true, Ordering::Relaxed);
    }
    i32::from(callback.flag.load(Ordering::Relaxed))
}

#[cfg(target_os = "linux")]
struct OwnedResult<'a> {
    pointer: *mut wire::ProbeResult,
    owner: &'a LibavMetadataProbe,
}
#[cfg(target_os = "linux")]
impl Drop for OwnedResult<'_> {
    fn drop(&mut self) {
        // SAFETY: only the allocating companion releases its aggregate. This
        // borrow keeps the library loaded even on conversion/error unwinding.
        if !self.pointer.is_null() {
            unsafe { (self.owner.release)(self.pointer) };
        }
    }
}

#[cfg(target_os = "linux")]
fn text<const N: usize>(value: &wire::Text<N>) -> Result<String, ProbeError> {
    let bytes = value
        .bytes
        .get(..value.len as usize)
        .ok_or_else(|| backend_error("invalid string length"))?;
    std::str::from_utf8(bytes)
        .map(str::to_owned)
        .map_err(|_| backend_error("non-UTF-8 companion string"))
}

#[cfg(target_os = "linux")]
fn convert_info(i: &wire::Info) -> Result<BackendInfo, ProbeError> {
    let convert = || {
        let build_configuration = text(&i.build_config)?;
        let runtime_configurations = [
            text(&i.runtime_configs[0])?,
            text(&i.runtime_configs[1])?,
            text(&i.runtime_configs[2])?,
        ];
        let info = BackendInfo {
            backend: text(&i.backend)?,
            abi_version: i.abi,
            build_version: text(&i.build_version)?,
            runtime_version: text(&i.runtime_version)?,
            build_library_versions: i.build_versions,
            runtime_library_versions: i.runtime_versions,
            build_configuration,
            runtime_configurations,
        };
        if i.abi != wire::ABI
            || i.request_size as usize != std::mem::size_of::<wire::Request>()
            || i.result_size as usize != std::mem::size_of::<wire::ProbeResult>()
            || i.stream_size as usize != std::mem::size_of::<wire::Stream>()
            || info.backend != "bilikara_media_libav"
            || info.build_version != "9.0.1"
            || info.runtime_version != info.build_version
            || i.build_versions != [4129125, 4129125, 3998053]
            || i.runtime_versions != i.build_versions
            || info.build_configuration.is_empty()
            || !info
                .build_configuration
                .split_whitespace()
                .any(|v| v == "--disable-network")
            || info
                .runtime_configurations
                .iter()
                .any(|v| v != &info.build_configuration)
        {
            return Err(backend_error(
                "incompatible companion layout/build/runtime configuration",
            ));
        }
        Ok(info)
    };
    convert().map_err(|error| ProbeError::Unavailable(error.to_string()))
}

#[cfg(target_os = "linux")]
fn status_error(status: u32, message: String) -> ProbeError {
    match status {
        1 => ProbeError::Unavailable(message),
        2 => media_error(MediaErrorKind::InvalidRequest, &message),
        3 => media_error(MediaErrorKind::SourceMissing, &message),
        4 => ProbeError::UnsupportedFormat(message),
        5 => media_error(MediaErrorKind::UnsupportedCodec, &message),
        6 => media_error(MediaErrorKind::MediaContractViolation, &message),
        7 => media_error(MediaErrorKind::InvalidMedia, &message),
        8 => media_error(MediaErrorKind::Io, &message),
        9 => ProbeError::Cancelled,
        11 => media_error(MediaErrorKind::UnsupportedContainerLayout, &message),
        _ => ProbeError::BackendFailure(message),
    }
}

#[cfg(target_os = "linux")]
fn ticks_us(value: i64, base: TimeBase) -> Result<i64, ProbeError> {
    if value == i64::MIN || base.numerator <= 0 || base.denominator <= 0 {
        return Err(backend_error("invalid known timestamp/time base"));
    }
    // i64 * positive i32 * 1_000_000 fits i128. Round to nearest microsecond,
    // ties away from zero; retain negative start times and check the narrowing.
    let scaled = i128::from(value) * i128::from(base.numerator) * 1_000_000;
    let half = i128::from(base.denominator) / 2;
    let rounded = (scaled + if scaled < 0 { -half } else { half }) / i128::from(base.denominator);
    i64::try_from(rounded).map_err(|_| backend_error("timestamp conversion overflow"))
}

#[cfg(target_os = "linux")]
fn known<T: Copy>(bits: u32, bit: u32, value: T) -> Option<T> {
    (bits & bit != 0).then_some(value)
}

#[cfg(target_os = "linux")]
fn convert_metadata(r: &wire::ProbeResult, backend: &str) -> Result<Metadata, ProbeError> {
    use wire::*;
    if r.status != 0 {
        return Err(status_error(r.status, text(&r.message)?));
    }
    if r.inspection_level != 1
        || r.stream_count == 0
        || r.stream_count as usize > MAX_STREAMS
        || r.present & !(DURATION | START | BIT_RATE) != 0
    {
        return Err(backend_error("invalid metadata result shape"));
    }
    let mut result = Metadata {
        backend: backend.into(),
        inspection_level: InspectionLevel::StreamMetadata,
        container: text(&r.container)?,
        duration_us: known(r.present, DURATION, r.duration_us),
        start_time_us: known(r.present, START, r.start_time_us),
        bit_rate_bps: known(r.present, BIT_RATE, r.bit_rate_bps),
        streams: Vec::with_capacity(r.stream_count as usize),
    };
    if result.container.is_empty()
        || result.duration_us.is_some_and(|v| v < 0)
        || result.start_time_us == Some(i64::MIN)
        || result.bit_rate_bps.is_some_and(|v| v <= 0)
    {
        return Err(backend_error("invalid known container metadata"));
    }
    for s in &r.streams[..r.stream_count as usize] {
        if s.present & !511 != 0 || result.streams.iter().any(|v| v.index == s.index) {
            return Err(backend_error("invalid stream flags or duplicate index"));
        }
        let media_type = match s.media_type {
            0 => StreamType::Unknown,
            1 => StreamType::Video,
            2 => StreamType::Audio,
            3 => StreamType::Subtitle,
            4 => StreamType::Data,
            5 => StreamType::Attachment,
            _ => return Err(backend_error("invalid project media type")),
        };
        let base = known(
            s.present,
            TIME_BASE,
            TimeBase {
                numerator: s.time_base_num,
                denominator: s.time_base_den,
            },
        );
        if base.is_some_and(|v| v.numerator <= 0 || v.denominator <= 0)
            || (s.present & (DURATION | START) != 0 && base.is_none())
        {
            return Err(backend_error(
                "known timestamp without meaningful time base",
            ));
        }
        let timestamp = |bit, value| -> Result<Option<i64>, ProbeError> {
            known(s.present, bit, value)
                .map(|v| ticks_us(v, base.ok_or_else(|| backend_error("missing time base"))?))
                .transpose()
        };
        let codec = text(&s.codec)?;
        let stream = StreamMetadata {
            index: s.index,
            media_type,
            codec_name: (!codec.is_empty()).then_some(codec),
            duration_us: timestamp(DURATION, s.duration_ticks)?,
            start_time_us: timestamp(START, s.start_ticks)?,
            time_base: base,
            width_px: known(s.present, WIDTH, s.width_px),
            height_px: known(s.present, HEIGHT, s.height_px),
            sample_rate_hz: known(s.present, RATE, s.sample_rate_hz),
            channel_count: known(s.present, CHANNELS, s.channels),
            bit_rate_bps: known(s.present, BIT_RATE, s.bit_rate_bps),
            raw_bit_depth: known(s.present, RAW_BITS, s.raw_bit_depth),
        };
        if stream.duration_us.is_some_and(|v| v < 0)
            || stream.bit_rate_bps.is_some_and(|v| v <= 0)
            || [
                stream.width_px,
                stream.height_px,
                stream.sample_rate_hz,
                stream.channel_count,
                stream.raw_bit_depth,
            ]
            .contains(&Some(0))
            || (media_type != StreamType::Video
                && (stream.width_px.is_some() || stream.height_px.is_some()))
            || (media_type != StreamType::Audio
                && (stream.sample_rate_hz.is_some() || stream.channel_count.is_some()))
        {
            return Err(backend_error("invalid known stream metadata"));
        }
        result.streams.push(stream);
    }
    Ok(result)
}

#[cfg(all(test, target_os = "linux"))]
mod tests;
