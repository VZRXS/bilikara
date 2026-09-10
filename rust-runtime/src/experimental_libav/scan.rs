//! Per-call packet enumeration. No decoding, normalization or acceptance policy.
use super::{InspectionLevel, LibavMetadataProbe, ProbeError, StreamType, TimeBase};
use crate::ExpectedMediaKind;
use serde::Serialize;
use std::{path::Path, sync::atomic::AtomicBool};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ScanSelection {
    pub stream_index: u32,
    pub expected_kind: ExpectedMediaKind,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScanTerminal {
    Incomplete,
    Eof,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct TimestampBounds {
    pub min: i64,
    pub max: i64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PacketSummary {
    pub index: u32,
    pub media_type: StreamType,
    pub codec_name: Option<String>,
    pub time_base: Option<TimeBase>,
    pub packet_count: u64,
    pub payload_bytes: u64,
    pub corrupt_packets: u64,
    pub pts_ticks: Option<TimestampBounds>,
    pub dts_ticks: Option<TimestampBounds>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PacketScan {
    pub inspection_level: InspectionLevel,
    pub requested: ScanSelection,
    /// EOF describes the demuxer's terminal result, even with corrupt packets or
    /// an empty selected stream. Only clean_eof() means no observed problem.
    pub terminal: ScanTerminal,
    pub error: Option<ProbeError>,
    pub selected: Option<PacketSummary>,
    /// Includes incidental packets required to enumerate this container.
    pub demuxed_packets: u64,
    pub incidental_corrupt_packets: u64,
}
impl PacketScan {
    pub fn clean_eof(&self) -> bool {
        self.inspection_level == InspectionLevel::PacketScan
            && self.terminal == ScanTerminal::Eof
            && self.error.is_none()
            && self.incidental_corrupt_packets == 0
            && self.selected.as_ref().is_some_and(|s| {
                s.packet_count > 0
                    && s.corrupt_packets == 0
                    && s.index == self.requested.stream_index
                    && s.media_type
                        == match self.requested.expected_kind {
                            ExpectedMediaKind::Audio => StreamType::Audio,
                            ExpectedMediaKind::Video => StreamType::Video,
                        }
            })
    }
}

impl LibavMetadataProbe {
    pub fn packet_scan_available(&self) -> bool {
        #[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
        {
            self.scan.is_ok()
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
        {
            false
        }
    }
    /// Read one exact requested audio/video stream to the demuxer's terminal
    /// result. Partial/error summaries are evidence only. Cooperative atomic
    /// cancellation is observed around every read, including buffered packets;
    /// no hard native deadline, retry, CLI fallback or file writes.
    pub fn scan_packets(
        &self,
        source: &Path,
        selection: ScanSelection,
        cancelled: &AtomicBool,
    ) -> Result<PacketScan, ProbeError> {
        #[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
        {
            self.scan_with_callback(source, selection, &super::Callback::new(cancelled))
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
        {
            let _ = (source, selection, cancelled);
            Err(ProbeError::Unavailable(
                "packet scan requires the optional Linux/Windows companion".into(),
            ))
        }
    }
    #[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
    pub(crate) fn scan_with_callback(
        &self,
        source: &Path,
        selection: ScanSelection,
        callback: &super::Callback<'_>,
    ) -> Result<PacketScan, ProbeError> {
        use super::{backend_error, cancellation_callback, open_input, status_error, wire};
        let capability = self.scan.as_ref().map_err(Clone::clone)?;
        if callback.is_cancelled() {
            return Err(ProbeError::Cancelled);
        }
        let file = open_input(source)?;
        let descriptor = self._library.descriptor(&file)?;
        let request = wire::ScanRequest {
            input: wire::Request {
                fd: descriptor.fd,
                cancelled: cancellation_callback,
                opaque: (callback as *const super::Callback<'_>).cast_mut().cast(),
            },
            stream_index: selection.stream_index,
            media_type: match selection.expected_kind {
                ExpectedMediaKind::Video => 1,
                ExpectedMediaKind::Audio => 2,
            },
        };
        let mut pointer = std::ptr::null_mut();
        // SAFETY: negotiated independent schema; callback/fd/library stay live
        // through this synchronous call and allocating-module result release.
        let status = unsafe { (capability.scan)(&request, &mut pointer) };
        let owned = OwnedScan {
            pointer,
            owner: self,
        };
        if status != 0 {
            return Err(status_error(
                status,
                "scan could not produce a result".into(),
            ));
        }
        if owned.pointer.is_null() {
            return Err(backend_error("null scan result"));
        }
        convert(unsafe { &*owned.pointer }, selection)
    }
}

#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
pub(super) struct Capability {
    scan: super::wire::Scan,
    release: super::wire::ScanRelease,
}
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
impl Capability {
    pub(super) fn load(library: &super::wire::Library) -> Result<Self, ProbeError> {
        use super::{backend_error, wire};
        use std::mem::{MaybeUninit, size_of, transmute};
        // SAFETY: trusted companion already passed M1 build negotiation. Only
        // the separately sized v1 scan info is read, never a longer M1 struct.
        unsafe {
            let info: wire::GetScanInfo = transmute(library.symbol(c"bm_scan_info_v1")?);
            let mut raw = MaybeUninit::<wire::ScanInfo>::zeroed();
            if info(size_of::<wire::ScanInfo>() as u32, raw.as_mut_ptr()) != 0 {
                return Err(backend_error("scan negotiation unavailable"));
            }
            let raw = raw.assume_init();
            if raw.schema != 1
                || raw.request_size as usize != size_of::<wire::ScanRequest>()
                || raw.result_size as usize != size_of::<wire::ScanResult>()
                || raw.summary_size as usize != size_of::<wire::PacketSummary>()
            {
                return Err(backend_error("incompatible scan schema/layout"));
            }
            Ok(Self {
                scan: transmute::<*mut std::ffi::c_void, wire::Scan>(
                    library.symbol(c"bm_scan_packets_v1")?,
                ),
                release: transmute::<*mut std::ffi::c_void, wire::ScanRelease>(
                    library.symbol(c"bm_scan_release_v1")?,
                ),
            })
        }
    }
}
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
struct OwnedScan<'a> {
    pointer: *mut super::wire::ScanResult,
    owner: &'a LibavMetadataProbe,
}
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
impl Drop for OwnedScan<'_> {
    fn drop(&mut self) {
        if !self.pointer.is_null() {
            // SAFETY: owner borrow prevents unloading; capability is immutable.
            unsafe { (self.owner.scan.as_ref().unwrap().release)(self.pointer) };
        }
    }
}
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
pub(super) fn convert(
    r: &super::wire::ScanResult,
    requested: ScanSelection,
) -> Result<PacketScan, ProbeError> {
    use super::{backend_error, status_error, text};
    if r.inspection_level != 2 || r.terminal > 1 || r.selected_count > 1 {
        return Err(backend_error("invalid scan result shape"));
    }
    let mut scan = PacketScan {
        inspection_level: InspectionLevel::PacketScan,
        requested,
        terminal: if r.terminal == 1 {
            ScanTerminal::Eof
        } else {
            ScanTerminal::Incomplete
        },
        error: (r.status != 0)
            .then(|| status_error(r.status, "packet scan did not establish clean EOF".into())),
        selected: None,
        demuxed_packets: r.demuxed_packets,
        incidental_corrupt_packets: r.incidental_corrupt_packets,
    };
    if r.selected_count == 1 {
        let s = &r.selected;
        let media_type = match s.media_type {
            1 => StreamType::Video,
            2 => StreamType::Audio,
            _ => return Err(backend_error("invalid scan media type")),
        };
        let expected = match requested.expected_kind {
            ExpectedMediaKind::Video => StreamType::Video,
            ExpectedMediaKind::Audio => StreamType::Audio,
        };
        if s.index != requested.stream_index
            || media_type != expected
            || s.present & !7 != 0
            || s.corrupt_packets > s.packet_count
            || s.packet_count > r.demuxed_packets
            || r.incidental_corrupt_packets > r.demuxed_packets - s.packet_count
        {
            return Err(backend_error("invalid scan selection/counts"));
        }
        let time_base = (s.present & 4 != 0).then_some(TimeBase {
            numerator: s.time_base_num,
            denominator: s.time_base_den,
        });
        if time_base.is_some_and(|b| b.numerator <= 0 || b.denominator <= 0) {
            return Err(backend_error("invalid scan time base"));
        }
        let bounds = |bit, min, max| {
            if s.present & bit == 0 {
                return Ok(None);
            }
            if time_base.is_none() || min == i64::MIN || min > max || s.packet_count == 0 {
                return Err(backend_error("invalid scan timestamp bounds"));
            }
            Ok(Some(TimestampBounds { min, max }))
        };
        if s.packet_count == 0 && s.payload_bytes != 0 {
            return Err(backend_error("payload without packets"));
        }
        let codec = text(&s.codec)?;
        // Codec names are identifiers; media tags/messages never cross this API.
        if codec.len() > 64
            || !codec
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_')
        {
            return Err(backend_error("invalid scan codec identifier"));
        }
        scan.selected = Some(PacketSummary {
            index: s.index,
            media_type,
            codec_name: (!codec.is_empty()).then_some(codec),
            time_base,
            packet_count: s.packet_count,
            payload_bytes: s.payload_bytes,
            corrupt_packets: s.corrupt_packets,
            pts_ticks: bounds(1, s.pts_min, s.pts_max)?,
            dts_ticks: bounds(2, s.dts_min, s.dts_max)?,
        });
    } else if r.demuxed_packets != 0 || r.incidental_corrupt_packets != 0 || r.terminal != 0 {
        return Err(backend_error("scan evidence without selection"));
    }
    if r.status == 0 && !scan.clean_eof() {
        return Err(backend_error("scan claimed success without clean EOF"));
    }
    if r.terminal == 1 && r.status != 0 && r.status != 7 {
        return Err(backend_error("stopped/failed scan claimed EOF"));
    }
    Ok(scan)
}

#[cfg(all(test, target_os = "linux"))]
mod tests;
