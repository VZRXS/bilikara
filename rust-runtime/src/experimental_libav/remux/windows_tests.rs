//! Executed only from the extracted package's Runtime test binary.
use super::*;

#[test]
#[ignore = "requires extracted same-build package artifacts"]
fn packaged_cancellation_and_collision() {
    let path = |name| PathBuf::from(std::env::var_os(name).expect("required package artifact"));
    let fixtures = path("BILIKARA_LIBAV_FIXTURES");
    let probe = unsafe { LibavMetadataProbe::load(&path("BILIKARA_LIBAV_COMPANION")) }.unwrap();
    let faults = unsafe { LibavMetadataProbe::load(&path("BILIKARA_M5_FAULT_COMPANION")) }.unwrap();
    type SetFault =
        unsafe extern "C" fn(u32, extern "C" fn(*mut std::ffi::c_void), *mut std::ffi::c_void);
    let set_fault: SetFault =
        unsafe { std::mem::transmute(faults._library.symbol(c"bm_test_remux_fault").unwrap()) };
    extern "C" fn cancel(context: *mut std::ffi::c_void) {
        unsafe { &*context.cast::<AtomicBool>() }.store(true, Ordering::Relaxed);
    }
    for (profile, name) in [
        (CopyProfile::Mp4, "aac.m4a"),
        (CopyProfile::Flac, "flac.mp4"),
    ] {
        let source = fixtures.join(name);
        let original = fs::read(&source).unwrap();
        let destination = fixtures.join(format!("collision.{}", profile.extension()));
        let q = CopyRemuxRequest {
            source: &source,
            destination: &destination,
            expected_kind: ExpectedMediaKind::Audio,
        };
        let flag = AtomicBool::new(false);
        // Existing C checkpoint after three real packet writes, not pre-cancel.
        unsafe { set_fault(1, cancel, (&flag as *const AtomicBool).cast_mut().cast()) };
        assert_eq!(
            faults.copy_profile(&q, profile, &flag).unwrap_err(),
            ProbeError::Cancelled
        );
        assert!(!destination.exists());
        assert_eq!(fs::read(&source).unwrap(), original);
        flag.store(false, Ordering::Relaxed);
        // Existing Rust before_publish seam and sentinel: the actual platform
        // no-replace hard_link must preserve a newly competing destination.
        let error = probe
            .remux_impl(
                &q,
                profile,
                &super::super::Callback::new(&flag),
                &mut || fs::write(&destination, b"competing destination").unwrap(),
                &mut || {},
            )
            .unwrap_err();
        assert!(
            matches!(error, ProbeError::Media(e) if e.kind == MediaErrorKind::DestinationExists)
        );
        assert_eq!(fs::read(&destination).unwrap(), b"competing destination");
        assert_eq!(fs::read(&source).unwrap(), original);
        assert!(!fs::read_dir(&fixtures).unwrap().any(|e| {
            e.unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".bilikara-remux-")
        }));
        fs::remove_file(destination).unwrap();
    }
}
