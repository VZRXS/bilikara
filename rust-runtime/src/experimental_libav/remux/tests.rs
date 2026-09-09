use super::*;
use std::os::unix::fs::symlink;

fn env_path(name: &str) -> PathBuf {
    let path = PathBuf::from(std::env::var_os(name).unwrap_or_else(|| panic!("required {name}")));
    assert!(path.is_absolute() && path.exists());
    path
}
fn request<'a>(source: &'a Path, destination: &'a Path) -> CopyRemuxRequest<'a> {
    CopyRemuxRequest {
        source,
        destination,
        expected_kind: ExpectedMediaKind::Audio,
    }
}
fn assert_kind(error: ProbeError, kind: MediaErrorKind) {
    assert!(matches!(error, ProbeError::Media(e) if e.kind == kind));
}

#[test]
fn normal_flac_header_allows_unknown_integrity_and_sample_fields() {
    let mut header = [0u8; 42];
    header[..8].copy_from_slice(b"fLaC\x80\0\0\x22");
    header[8..12].copy_from_slice(&[0x10, 0, 0x10, 0]);
    header[18..26].copy_from_slice(&((96000u64 << 44) | (1 << 41) | (23 << 36)).to_be_bytes());
    let info = FlacStreamInfo::read(&mut header.as_slice()).unwrap();
    assert_eq!(
        (
            info.sample_rate_hz,
            info.channel_count,
            info.bits_per_sample
        ),
        (96000, 2, 24)
    );
    assert_eq!(info.total_samples, None);
    assert!(!info.md5_present);
    header[25] = 19;
    header[26] = 1;
    let info = FlacStreamInfo::read(&mut header.as_slice()).unwrap();
    assert_eq!(info.total_samples, Some(19));
    assert!(info.md5_present); // presence is not an integrity check
    for position in [0, 4, 7, 8] {
        let mut bad = header;
        bad[position] = 0;
        if position == 4 {
            bad[position] = 1;
        }
        assert!(FlacStreamInfo::read(&mut bad.as_slice()).is_err());
    }
    assert!(FlacStreamInfo::read(&mut &header[..41]).is_err());
}

#[test]
fn owned_scratch_does_not_delete_unowned_files() {
    let scratch = Scratch::new(&std::env::temp_dir()).unwrap();
    let directory = scratch.directory.clone();
    let extra = directory.join("unowned");
    fs::write(&extra, b"competitor").unwrap();
    assert!(scratch.cleanup().is_err());
    drop(scratch);
    assert_eq!(fs::read(&extra).unwrap(), b"competitor");
    fs::remove_file(extra).unwrap();
    fs::remove_dir(directory).unwrap();
}

#[test]
#[ignore = "requires real M5 companion, private fault companion and accepted fixtures"]
fn live_publication_cancellation_and_late_errors() {
    publication_cancellation_and_late_errors(CopyProfile::Mp4);
}

#[test]
#[ignore = "requires real FLAC companion and shared M5 fault companion"]
fn live_flac_publication_cancellation_and_late_errors() {
    publication_cancellation_and_late_errors(CopyProfile::Flac);
}

fn publication_cancellation_and_late_errors(profile: CopyProfile) {
    let probe = unsafe { LibavMetadataProbe::load(&env_path("BILIKARA_LIBAV_COMPANION")) }.unwrap();
    assert!(probe.copy_profile_available(profile));
    let fixture = env_path("BILIKARA_LIBAV_FIXTURES").join(if profile == CopyProfile::Flac {
        "flac.mp4"
    } else {
        "aac.m4a"
    });
    let root = Scratch::new(&std::env::temp_dir()).unwrap();
    let source = root.directory.join("source.m4a");
    fs::copy(fixture, &source).unwrap();
    let original = fs::read(&source).unwrap();
    let destination = root.directory.join("final.mp4");
    let q = request(&source, &destination);
    let flag = AtomicBool::new(false);
    let scratch_count = || {
        fs::read_dir(&root.directory)
            .unwrap()
            .filter(|e| {
                e.as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".bilikara-remux-")
            })
            .count()
    };

    for mode in 0..4 {
        match mode {
            0 => fs::write(&destination, b"competing output").unwrap(),
            1 => fs::hard_link(&source, &destination).unwrap(),
            2 => symlink(&source, &destination).unwrap(),
            _ => symlink(root.directory.join("missing"), &destination).unwrap(),
        }
        assert_kind(
            probe.copy_profile(&q, profile, &flag).unwrap_err(),
            MediaErrorKind::DestinationExists,
        );
        assert!(fs::symlink_metadata(&destination).is_ok());
        if mode == 0 {
            assert_eq!(fs::read(&destination).unwrap(), b"competing output");
        }
        if mode == 1 || mode == 2 {
            assert_eq!(fs::read(&destination).unwrap(), original);
        }
        fs::remove_file(&destination).unwrap();
    }
    let error = probe
        .remux_impl(
            &q,
            profile,
            &super::super::Callback::new(&flag),
            &mut || {
                fs::write(&destination, b"racing publisher").unwrap();
            },
            &mut || {},
        )
        .unwrap_err();
    assert_kind(error, MediaErrorKind::DestinationExists);
    assert_eq!(fs::read(&destination).unwrap(), b"racing publisher");
    fs::remove_file(&destination).unwrap();
    assert_eq!(scratch_count(), 0);
    flag.store(true, Ordering::Relaxed);
    assert_eq!(
        probe.copy_profile(&q, profile, &flag).unwrap_err(),
        ProbeError::Cancelled
    );
    flag.store(false, Ordering::Relaxed);
    let error = probe
        .remux_impl(
            &q,
            profile,
            &super::super::Callback::new(&flag),
            &mut || {
                flag.store(true, Ordering::Relaxed);
            },
            &mut || {},
        )
        .unwrap_err();
    assert_eq!(error, ProbeError::Cancelled);
    assert!(!destination.exists());
    assert_eq!(scratch_count(), 0);

    // Cancellation after the actual successful link must preserve committed
    // outcome. Cleanup trouble is similarly a bounded success warning.
    flag.store(false, Ordering::Relaxed);
    let mut leftover = None;
    let result = probe
        .remux_impl(
            &q,
            profile,
            &super::super::Callback::new(&flag),
            &mut || {},
            &mut || {
                flag.store(true, Ordering::Relaxed);
                let dir = fs::read_dir(&root.directory)
                    .unwrap()
                    .map(|e| e.unwrap().path())
                    .find(|p| {
                        p.file_name()
                            .unwrap()
                            .to_string_lossy()
                            .starts_with(".bilikara-remux-")
                    })
                    .unwrap();
                fs::write(dir.join("extra"), b"cleanup checkpoint").unwrap();
                leftover = Some(dir);
            },
        )
        .unwrap();
    assert!(result.finalized_and_published && destination.is_file());
    assert_eq!(
        result.cleanup_warning,
        Some("owned_scratch_cleanup_incomplete")
    );
    fs::remove_dir_all(leftover.unwrap()).unwrap();
    fs::remove_file(&destination).unwrap();

    let faults =
        unsafe { LibavMetadataProbe::load(&env_path("BILIKARA_M5_FAULT_COMPANION")) }.unwrap();
    type SetFault =
        unsafe extern "C" fn(u32, extern "C" fn(*mut std::ffi::c_void), *mut std::ffi::c_void);
    let set_fault: SetFault =
        unsafe { std::mem::transmute(faults._library.symbol(c"bm_test_remux_fault").unwrap()) };
    extern "C" fn cancel(opaque: *mut std::ffi::c_void) {
        unsafe { &*opaque.cast::<AtomicBool>() }.store(true, Ordering::Relaxed);
    }
    let fds = || fs::read_dir("/proc/self/fd").unwrap().count();
    let before = fds();
    for _ in 0..8 {
        for mode in [1, 2, 3, 4, 5, 6] {
            flag.store(false, Ordering::Relaxed);
            unsafe {
                set_fault(mode, cancel, (&flag as *const AtomicBool).cast_mut().cast());
            }
            let error = faults.copy_profile(&q, profile, &flag).unwrap_err();
            if mode == 1 {
                assert_eq!(error, ProbeError::Cancelled);
            } else {
                if mode == 4 {
                    assert!(
                        matches!(&error, ProbeError::Media(e) if e.message.contains("corrupt packet"))
                    );
                }
                assert!(
                    matches!(&error, ProbeError::Media(e) if e.message.ends_with(if mode == 2 { "stage 4" } else { "stage 3" }))
                );
                assert_kind(
                    error,
                    match mode {
                        4 => MediaErrorKind::InvalidMedia,
                        5 | 6 => MediaErrorKind::UnsupportedContainerLayout,
                        _ => MediaErrorKind::Io,
                    },
                );
            }
            assert!(!destination.exists());
            assert_eq!(scratch_count(), 0);
        }
    }
    assert_eq!(fds(), before, "all writable/read descriptors must close");
    assert_eq!(fs::read(&source).unwrap(), original);
    fs::remove_file(source).unwrap();
}

#[test]
#[ignore = "requires accepted M3 companion without remux capability"]
fn live_old_companion_does_not_remux() {
    let probe =
        unsafe { LibavMetadataProbe::load(&env_path("BILIKARA_M5_OLD_COMPANION")) }.unwrap();
    assert!(probe.packet_scan_available());
    assert!(!probe.copy_remux_available());
    let source = env_path("BILIKARA_LIBAV_FIXTURES").join("aac.m4a");
    let destination = std::env::temp_dir().join("unused-old-companion-remux.mp4");
    assert!(matches!(
        probe.copy_remux_mp4(&request(&source, &destination), &AtomicBool::new(false)),
        Err(ProbeError::Unavailable(_))
    ));
    assert!(
        probe
            .probe_metadata(&source, &AtomicBool::new(false))
            .is_ok()
    );
    assert!(
        probe
            .scan_packets(
                &source,
                crate::experimental_libav::ScanSelection {
                    stream_index: 0,
                    expected_kind: ExpectedMediaKind::Audio
                },
                &AtomicBool::new(false)
            )
            .unwrap()
            .clean_eof()
    );
}
