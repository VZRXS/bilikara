//! Private project ABI, mirrored from media-libav/probe.h. No AV types.
use std::ffi::c_void;

pub(super) const ABI: u32 = 1;
pub(super) const MAX_STREAMS: usize = 32;
pub(super) const DURATION: u32 = 1;
pub(super) const START: u32 = 2;
pub(super) const TIME_BASE: u32 = 4;
pub(super) const WIDTH: u32 = 8;
pub(super) const HEIGHT: u32 = 16;
pub(super) const RATE: u32 = 32;
pub(super) const CHANNELS: u32 = 64;
pub(super) const BIT_RATE: u32 = 128;
pub(super) const RAW_BITS: u32 = 256;

#[repr(C)]
pub(super) struct Text<const N: usize> {
    pub len: u32,
    pub bytes: [u8; N],
}

#[repr(C)]
pub(super) struct Info {
    pub abi: u32,
    pub request_size: u32,
    pub result_size: u32,
    pub stream_size: u32,
    pub build_versions: [u32; 3],
    pub runtime_versions: [u32; 3],
    pub backend: Text<128>,
    pub build_version: Text<128>,
    pub runtime_version: Text<128>,
    pub build_config: Text<2048>,
    pub runtime_configs: [Text<2048>; 3],
}

#[repr(C)]
pub(super) struct Request {
    pub fd: i32,
    pub cancelled: extern "C" fn(*mut c_void) -> i32,
    pub opaque: *mut c_void,
}

#[repr(C)]
pub(super) struct Stream {
    pub index: u32,
    pub media_type: u32,
    pub present: u32,
    pub codec: Text<128>,
    pub duration_ticks: i64,
    pub start_ticks: i64,
    pub time_base_num: i32,
    pub time_base_den: i32,
    pub width_px: u32,
    pub height_px: u32,
    pub sample_rate_hz: u32,
    pub channels: u32,
    pub bit_rate_bps: i64,
    pub raw_bit_depth: u32,
}

#[repr(C)]
pub(super) struct ProbeResult {
    pub status: u32,
    pub inspection_level: u32,
    pub message: Text<128>,
    pub container: Text<128>,
    pub present: u32,
    pub stream_count: u32,
    pub duration_us: i64,
    pub start_time_us: i64,
    pub bit_rate_bps: i64,
    pub streams: [Stream; MAX_STREAMS],
}

pub(super) type Abi = unsafe extern "C" fn() -> u32;
pub(super) type GetInfo = unsafe extern "C" fn(u32, *mut Info) -> u32;
pub(super) type Probe = unsafe extern "C" fn(*const Request, *mut *mut ProbeResult) -> u32;
pub(super) type Release = unsafe extern "C" fn(*mut ProbeResult);

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(super) mod posix {
    use super::*;
    use crate::experimental_libav::ProbeError;
    use std::ffi::{CStr, CString};
    use std::os::unix::ffi::OsStrExt;
    use std::path::Path;

    // No new loader dependency: libc is already a mandatory runtime dependency.
    // No global registry or hot unloading; each handle outlives its synchronous
    // calls and aggregate release. No FFmpeg global callbacks are changed.
    pub(in crate::experimental_libav) struct Library(*mut c_void);

    impl Library {
        pub(in crate::experimental_libav) fn descriptor<'a>(
            &'a self,
            file: &std::fs::File,
        ) -> Result<Descriptor<'a>, ProbeError> {
            use std::os::fd::AsRawFd;
            Ok(Descriptor {
                fd: file.as_raw_fd(),
                _owner: self,
            })
        }
        pub(in crate::experimental_libav) unsafe fn open(path: &Path) -> Result<Self, ProbeError> {
            let path = CString::new(path.as_os_str().as_bytes())
                .map_err(|_| ProbeError::Unavailable("companion path contains NUL".into()))?;
            // SAFETY: caller authorizes a trusted artifact; RTLD_LOCAL does not
            // add its symbols to the process-wide lookup scope.
            let handle = unsafe { libc::dlopen(path.as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL) };
            if handle.is_null() {
                Err(load_error())
            } else {
                Ok(Self(handle))
            }
        }

        pub(in crate::experimental_libav) fn symbol(
            &self,
            name: &CStr,
        ) -> Result<*mut c_void, ProbeError> {
            // SAFETY: handle is live and name is NUL terminated. Typed signature
            // conversion is confined to the four v1 symbols at the call site.
            let pointer = unsafe { libc::dlsym(self.0, name.as_ptr()) };
            if pointer.is_null() {
                Err(load_error())
            } else {
                Ok(pointer)
            }
        }
    }

    pub(in crate::experimental_libav) struct Descriptor<'a> {
        pub fd: i32,
        _owner: &'a Library,
    }

    fn load_error() -> ProbeError {
        // SAFETY: dlerror returns a thread-local borrowed string, copied before
        // another loader operation. Bound the resulting diagnostic.
        let pointer = unsafe { libc::dlerror() };
        let message = if pointer.is_null() {
            "optional companion symbol unavailable".into()
        } else {
            unsafe { CStr::from_ptr(pointer) }
                .to_string_lossy()
                .chars()
                .take(512)
                .collect()
        };
        ProbeError::Unavailable(message)
    }

    impl Drop for Library {
        fn drop(&mut self) {
            // SAFETY: calls/results cannot outlive their borrow of the adapter.
            unsafe { libc::dlclose(self.0) };
        }
    }
}

// Independent additive scan schema; never enlarge/read the M1 Info or result.
#[repr(C)]
pub(super) struct ScanInfo {
    pub schema: u32,
    pub request_size: u32,
    pub result_size: u32,
    pub summary_size: u32,
}
#[repr(C)]
pub(super) struct ScanRequest {
    pub input: Request,
    pub stream_index: u32,
    pub media_type: u32,
}
#[repr(C)]
pub(super) struct PacketSummary {
    pub index: u32,
    pub media_type: u32,
    pub present: u32,
    pub codec: Text<128>,
    pub time_base_num: i32,
    pub time_base_den: i32,
    pub packet_count: u64,
    pub payload_bytes: u64,
    pub corrupt_packets: u64,
    pub pts_min: i64,
    pub pts_max: i64,
    pub dts_min: i64,
    pub dts_max: i64,
}
#[repr(C)]
pub(super) struct ScanResult {
    pub status: u32,
    pub inspection_level: u32,
    pub terminal: u32,
    pub selected_count: u32,
    pub demuxed_packets: u64,
    pub incidental_corrupt_packets: u64,
    pub selected: PacketSummary,
}
pub(super) type GetScanInfo = unsafe extern "C" fn(u32, *mut ScanInfo) -> u32;
pub(super) type Scan = unsafe extern "C" fn(*const ScanRequest, *mut *mut ScanResult) -> u32;
pub(super) type ScanRelease = unsafe extern "C" fn(*mut ScanResult);

// M5 negotiates its own sizes. M1 and M3 layouts above remain unchanged.
#[repr(C)]
pub(super) struct RemuxInfo {
    pub schema: u32,
    pub request_size: u32,
    pub result_size: u32,
    pub scan_size: u32,
}
#[repr(C)]
pub(super) struct RemuxRequest {
    pub input: Request,
    pub media_type: u32,
    pub staging_path: *const std::ffi::c_char,
}
#[repr(C)]
pub(super) struct RemuxResult {
    pub status: u32,
    pub stage: u32,
    pub finalized: u32,
    pub configuration_preserved: u32,
    pub input_scan: ScanResult,
}
pub(super) type GetRemuxInfo = unsafe extern "C" fn(u32, *mut RemuxInfo) -> u32;
pub(super) type Remux = unsafe extern "C" fn(*const RemuxRequest, *mut *mut RemuxResult) -> u32;
pub(super) type RemuxRelease = unsafe extern "C" fn(*mut RemuxResult);

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(super) use posix::Library;
#[cfg(target_os = "windows")]
#[path = "windows.rs"]
mod windows;
#[cfg(target_os = "windows")]
pub(super) use windows::Library;
