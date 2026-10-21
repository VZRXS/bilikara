//! Descriptor-only optional live MPEG-TS capability. No CLI/network fallback.
use super::{LibavMetadataProbe, ProbeError};
#[cfg(all(
    test,
    any(
        target_os = "android",
        target_os = "linux",
        target_os = "macos",
        target_os = "windows"
    )
))]
pub(in crate::experimental_libav) use native::inspect;
use std::{path::Path, sync::atomic::AtomicBool};

impl LibavMetadataProbe {
    pub fn live_ts_available(&self) -> bool {
        #[cfg(any(
            target_os = "android",
            target_os = "linux",
            target_os = "macos",
            target_os = "windows"
        ))]
        {
            native::Capability::load(&self._library).is_ok()
        }
        #[cfg(not(any(
            target_os = "android",
            target_os = "linux",
            target_os = "macos",
            target_os = "windows"
        )))]
        {
            false
        }
    }

    /// Callback bytes are borrowed until return, at most 24064 bytes, in decode
    /// order. Return false to stop. The caller owns pacing and bounded storage.
    pub fn copy_live_ts(
        &self,
        video: &Path,
        audio: &Path,
        start_us: i64,
        cancelled: &AtomicBool,
        visit: &mut dyn FnMut(&[u8], i64, bool) -> bool,
    ) -> Result<(), ProbeError> {
        #[cfg(any(
            target_os = "android",
            target_os = "linux",
            target_os = "macos",
            target_os = "windows"
        ))]
        {
            native::run(self, video, audio, start_us, cancelled, visit)
        }
        #[cfg(not(any(
            target_os = "android",
            target_os = "linux",
            target_os = "macos",
            target_os = "windows"
        )))]
        {
            let _ = (video, audio, start_us, cancelled, visit);
            Err(ProbeError::Unavailable(
                "live TS platform not packaged".into(),
            ))
        }
    }
}

#[cfg(all(
    test,
    any(
        target_os = "android",
        target_os = "linux",
        target_os = "macos",
        target_os = "windows"
    )
))]
mod tests {
    use super::*;
    #[test]
    #[ignore = "requires the actual P1 companion; npm run test:purek-output supplies it"]
    fn real_pipeline_copy_and_native_ts_inspection() {
        let companion =
            std::env::var_os("BILIKARA_TEST_LIBAV_COMPANION").expect("actual companion");
        // SAFETY: explicitly supplied test-owned native build.
        let probe = unsafe { LibavMetadataProbe::load(Path::new(&companion)) }.unwrap();
        assert!(probe.live_ts_available());
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("tests/fixtures/bbdown");
        let mut bytes = Vec::new();
        let mut keys = 0;
        let mut last = 0;
        probe
            .copy_live_ts(
                &root.join("video-reordered-start.mp4"),
                &root.join("audio.m4a"),
                0,
                &AtomicBool::new(false),
                &mut |chunk, time, key| {
                    assert!(time >= last);
                    last = time;
                    keys += usize::from(key);
                    bytes.extend_from_slice(chunk);
                    bytes.len() < 4 * 1024 * 1024
                },
            )
            .unwrap();
        assert!(keys >= 1);
        assert!(bytes.len() > 188 * 4);
        assert_eq!(bytes.len() % 188, 0);
        let output = PathBuf::from(
            std::env::var_os("BILIKARA_TEST_PUREK_TS").expect("test-owned output TS path"),
        );
        std::fs::write(&output, &bytes).unwrap();
        let inspected = native::inspect(&probe, &output);
        assert_eq!(inspected.status, 0, "{inspected:?}");
        assert_eq!(inspected.complete, 1);
        assert_eq!(inspected.packets[0], 24);
        assert!(inspected.packets[1] > 20);
        assert!(inspected.first_dts.iter().all(|v| *v >= 0));
        assert!(
            (inspected.max_pts[0] - inspected.max_pts[1]).abs() < 100_000,
            "{inspected:?}"
        );
        assert!(bytes.windows(4).any(|v| v == [0, 0, 1, 0x67]));
        assert!(bytes.windows(4).any(|v| v == [0, 0, 1, 0x68]));
        let cancelled = probe.copy_live_ts(
            &root.join("video-reordered-start.mp4"),
            &root.join("audio.m4a"),
            0,
            &AtomicBool::new(true),
            &mut |_, _, _| panic!("cancelled visitor"),
        );
        assert!(
            matches!(cancelled, Err(ProbeError::Cancelled)),
            "{cancelled:?}"
        );
        let cancelled = probe.copy_live_ts(
            &root.join("video-reordered-start.mp4"),
            &root.join("audio.m4a"),
            0,
            &AtomicBool::new(false),
            &mut |_, _, _| false,
        );
        assert!(
            matches!(cancelled, Err(ProbeError::Cancelled)),
            "{cancelled:?}"
        );
        for (video, audio) in [
            ("video-hevc.mp4", "audio.m4a"),
            ("video-reordered-start.mp4", "audio-flac.mp4"),
        ] {
            assert!(
                probe
                    .copy_live_ts(
                        &root.join(video),
                        &root.join(audio),
                        0,
                        &AtomicBool::new(false),
                        &mut |_, _, _| panic!("unsupported codec must not publish")
                    )
                    .is_err()
            );
        }
    }
    use std::path::PathBuf;
}

#[cfg(any(
    target_os = "android",
    target_os = "linux",
    target_os = "macos",
    target_os = "windows"
))]
mod native {
    use super::*;
    use crate::experimental_libav::{backend_error, open_input, status_error, wire};
    use std::{
        ffi::c_void,
        mem::{size_of, transmute},
        sync::atomic::Ordering,
    };
    #[repr(C)]
    struct Info {
        schema: u32,
        request_size: u32,
        result_size: u32,
    }
    #[repr(C)]
    struct Request {
        video: wire::Request,
        audio: wire::Request,
        start_us: i64,
        visit: extern "C" fn(*mut c_void, *const u8, u32, i64, u32) -> i32,
        opaque: *mut c_void,
    }
    #[repr(C)]
    #[derive(Default)]
    struct ResultData {
        status: u32,
        complete: u32,
        packets: u64,
        bytes: u64,
    }
    #[repr(C)]
    #[derive(Default, Debug)]
    #[cfg(test)]
    pub(in crate::experimental_libav) struct Inspection {
        pub status: u32,
        pub complete: u32,
        pub packets: [u64; 2],
        pub first_dts: [i64; 2],
        pub last_dts: [i64; 2],
        pub min_pts: [i64; 2],
        pub max_pts: [i64; 2],
    }
    #[cfg(test)]
    pub(in crate::experimental_libav) fn inspect(
        probe: &LibavMetadataProbe,
        path: &Path,
    ) -> Inspection {
        type Check = unsafe extern "C" fn(*const wire::Request, u32, *mut Inspection) -> u32;
        // SAFETY: same trusted companion, independent size is checked by C.
        let check: Check =
            unsafe { transmute(probe._library.symbol(c"bm_live_check_v1").unwrap()) };
        let file = open_input(path).unwrap();
        let fd = probe._library.descriptor(&file).unwrap();
        extern "C" fn never(_: *mut c_void) -> i32 {
            0
        }
        let request = wire::Request {
            fd: fd.fd,
            cancelled: never,
            opaque: std::ptr::null_mut(),
        };
        let mut result = Inspection::default();
        // SAFETY: all borrowed resources live through the synchronous call.
        assert_eq!(
            unsafe { check(&request, size_of::<Inspection>() as u32, &mut result) },
            0
        );
        result
    }
    pub(super) struct Capability {
        run: unsafe extern "C" fn(*const Request, *mut ResultData) -> u32,
    }
    impl Capability {
        pub(super) fn load(library: &wire::Library) -> Result<Self, ProbeError> {
            // SAFETY: the enclosing probe has negotiated the trusted companion.
            unsafe {
                let info: unsafe extern "C" fn(u32, *mut Info) -> u32 =
                    transmute(library.symbol(c"bm_live_info_v1")?);
                let mut raw = Info {
                    schema: 0,
                    request_size: 0,
                    result_size: 0,
                };
                if info(size_of::<Info>() as u32, &mut raw) != 0
                    || raw.schema != 1
                    || raw.request_size as usize != size_of::<Request>()
                    || raw.result_size as usize != size_of::<ResultData>()
                {
                    return Err(backend_error("live TS capability unavailable"));
                }
                Ok(Self {
                    run: transmute::<
                        *mut c_void,
                        unsafe extern "C" fn(*const Request, *mut ResultData) -> u32,
                    >(library.symbol(c"bm_live_ts_v1")?),
                })
            }
        }
    }
    struct Visitor<'a> {
        cancelled: &'a AtomicBool,
        callback: &'a mut dyn FnMut(&[u8], i64, bool) -> bool,
        failed: bool,
        stopped: bool,
    }
    extern "C" fn cancelled(opaque: *mut c_void) -> i32 {
        // SAFETY: synchronous call borrows this visitor for its full duration.
        let visitor = unsafe { &*(opaque as *const Visitor<'_>) };
        i32::from(visitor.cancelled.load(Ordering::Acquire) || visitor.failed || visitor.stopped)
    }
    extern "C" fn visit(
        opaque: *mut c_void,
        bytes: *const u8,
        size: u32,
        time: i64,
        key: u32,
    ) -> i32 {
        // SAFETY: callback context belongs to this synchronous invocation.
        let visitor = unsafe { &mut *(opaque as *mut Visitor<'_>) };
        if bytes.is_null()
            || size == 0
            || size > 24064
            || !size.is_multiple_of(188)
            || time < 0
            || key > 1
        {
            visitor.failed = true;
            return 1;
        }
        // SAFETY: companion borrows exactly size bytes until this call returns.
        let bytes = unsafe { std::slice::from_raw_parts(bytes, size as usize) };
        if bytes.chunks_exact(188).any(|p| p[0] != 0x47) {
            visitor.failed = true;
            return 1;
        }
        let accepted = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            (visitor.callback)(bytes, time, key == 1)
        }));
        match accepted {
            Ok(true) => 0,
            Ok(false) => {
                visitor.stopped = true;
                1
            }
            Err(_) => {
                visitor.failed = true;
                1
            }
        }
    }
    pub(super) fn run(
        probe: &LibavMetadataProbe,
        video: &Path,
        audio: &Path,
        start_us: i64,
        stop: &AtomicBool,
        callback: &mut dyn FnMut(&[u8], i64, bool) -> bool,
    ) -> Result<(), ProbeError> {
        if !(0..=21_600_000_000).contains(&start_us) {
            return Err(backend_error("invalid live TS start"));
        }
        let capability = Capability::load(&probe._library)?;
        let video = open_input(video)?;
        let audio = open_input(audio)?;
        let video_fd = probe._library.descriptor(&video)?;
        let audio_fd = probe._library.descriptor(&audio)?;
        let mut visitor = Visitor {
            cancelled: stop,
            callback,
            failed: false,
            stopped: false,
        };
        let opaque = (&mut visitor as *mut Visitor<'_>).cast();
        let request = Request {
            video: wire::Request {
                fd: video_fd.fd,
                cancelled,
                opaque,
            },
            audio: wire::Request {
                fd: audio_fd.fd,
                cancelled,
                opaque,
            },
            start_us,
            visit,
            opaque,
        };
        let mut result = ResultData::default();
        // SAFETY: descriptors/library/context remain live for call and cleanup.
        let status = unsafe { (capability.run)(&request, &mut result) };
        if visitor.failed {
            return Err(backend_error("invalid live TS visitor output"));
        }
        if visitor.stopped || stop.load(Ordering::Acquire) {
            return Err(ProbeError::Cancelled);
        }
        if status != 0 {
            return Err(status_error(status, "live TS invocation failed".into()));
        }
        if result.status != 0 {
            return Err(status_error(
                result.status,
                "live TS pipeline failed".into(),
            ));
        }
        if result.complete != 1 || result.packets == 0 || result.bytes == 0 {
            return Err(backend_error("incomplete live TS output"));
        }
        Ok(())
    }
}
