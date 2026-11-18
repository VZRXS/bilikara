//! Independent test-shim demux inspection; no production input-policy changes.
use super::*;
use std::{ffi::c_void, mem::size_of};

#[repr(C)]
struct Request {
    fd: i32,
    cancelled: extern "C" fn(*mut c_void) -> i32,
    opaque: *mut c_void,
}
// Private ABI from media-libav/test_shim.c, bm_test_cast_check_v1.
#[repr(C)]
#[derive(Default, Debug)]
struct Inspection {
    status: u32,
    streams: u32,
    first_video_key: u32,
    audio_rate: u32,
    audio_channels: u32,
    duration_us: i64,
    packets: [u64; 2],
    first_pts_us: [i64; 2],
    last_end_us: [i64; 2],
    audio_profile: i32,
}
type Check = unsafe extern "C" fn(*const Request, u32, *mut Inspection) -> u32;
extern "C" fn deadline(opaque: *mut c_void) -> i32 {
    // SAFETY: inspect_ts lends this Instant until the synchronous call returns.
    i32::from(unsafe { &*opaque.cast::<std::time::Instant>() }.elapsed() > Duration::from_secs(10))
}

pub(crate) fn inspect_ts(path: &Path) {
    let _probe = media::probe().unwrap(); // Keeps the validated test library alive.
    let library = std::env::var_os("BILIKARA_TEST_CAST_COMPANION").unwrap();
    let file = std::fs::File::open(path).unwrap();
    let mut began = std::time::Instant::now();
    let mut result = Inspection::default();
    #[cfg(windows)]
    let status = {
        use std::os::windows::{ffi::OsStrExt, io::AsRawHandle};
        use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
        let wide: Vec<_> = library.encode_wide().chain(Some(0)).collect();
        // SAFETY: resolve only the known test ABI from the already validated
        // module. The companion duplicates the borrowed handle into its CRT;
        // close that descriptor before releasing the Rust file/library.
        unsafe {
            let module = GetModuleHandleW(wide.as_ptr());
            assert!(!module.is_null());
            let check: Check = std::mem::transmute(
                GetProcAddress(module, c"bm_test_cast_check_v1".as_ptr().cast()).unwrap(),
            );
            let open: unsafe extern "C" fn(*mut c_void) -> i32 = std::mem::transmute(
                GetProcAddress(module, c"bm_fd_from_handle_v1".as_ptr().cast()).unwrap(),
            );
            let close: unsafe extern "C" fn(i32) = std::mem::transmute(
                GetProcAddress(module, c"bm_fd_close_v1".as_ptr().cast()).unwrap(),
            );
            let fd = open(file.as_raw_handle());
            assert!(fd >= 0);
            let status = check(
                &Request {
                    fd,
                    cancelled: deadline,
                    opaque: (&mut began as *mut std::time::Instant).cast(),
                },
                size_of::<Inspection>() as u32,
                &mut result,
            );
            close(fd);
            status
        }
    };
    #[cfg(unix)]
    let status = {
        use std::os::unix::{ffi::OsStrExt, io::AsRawFd};
        let library = std::ffi::CString::new(library.as_bytes()).unwrap();
        // SAFETY: same trusted test ABI; descriptor, callback and result stay
        // valid through the call. Balance the extra dlopen reference.
        unsafe {
            let module = libc::dlopen(library.as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL);
            assert!(!module.is_null());
            let symbol = libc::dlsym(module, c"bm_test_cast_check_v1".as_ptr());
            assert!(!symbol.is_null());
            let check: Check = std::mem::transmute(symbol);
            let status = check(
                &Request {
                    fd: file.as_raw_fd(),
                    cancelled: deadline,
                    opaque: (&mut began as *mut std::time::Instant).cast(),
                },
                size_of::<Inspection>() as u32,
                &mut result,
            );
            libc::dlclose(module);
            status
        }
    };
    assert_eq!(status, 0);
    assert_eq!(result.status, 0, "H.264/AAC must demux cleanly: {result:?}");
    assert_eq!(result.streams, 2);
    assert_eq!(result.first_video_key, 1);
    assert!(result.packets.iter().all(|count| *count > 0));
    assert!(result.duration_us > 0);
}
