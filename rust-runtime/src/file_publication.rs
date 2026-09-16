//! Filesystem publication and credential-free I/O diagnostics.

use std::io;
use std::path::Path;

/// Publish a completed, owned scratch file without replacing any destination.
/// The source may be consumed on success; callers may still best-effort remove
/// their scratch path, but must never remove the destination on an error.
pub(crate) fn publish_no_replace(source: &Path, destination: &Path) -> io::Result<()> {
    #[cfg(target_os = "android")]
    {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;

        // Android's untrusted_app SELinux policy forbids hard links, including
        // to the app's own files. Plain rename is not an alternative: it may
        // overwrite a concurrent publisher. The syscall keeps RENAME_NOREPLACE
        // atomic without depending on bionic's API-30 renameat2 symbol (min 24).
        let source = CString::new(source.as_os_str().as_bytes())?;
        let destination = CString::new(destination.as_os_str().as_bytes())?;
        // SAFETY: both NUL-terminated paths live for the call; the syscall and
        // flags are platform constants. No descriptor or pointer is retained.
        let result = unsafe {
            libc::syscall(
                libc::SYS_renameat2,
                libc::AT_FDCWD,
                source.as_ptr(),
                libc::AT_FDCWD,
                destination.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        if result == 0 {
            Ok(())
        } else {
            // Fail closed on an unsupported kernel/filesystem. Never fall
            // back to a check-then-rename race or a partial destination copy.
            Err(io::Error::last_os_error())
        }
    }
    #[cfg(not(target_os = "android"))]
    {
        std::fs::hard_link(source, destination)
    }
}

/// Atomic no-replace publication for a complete cache artifact directory.
/// Hard links cannot publish directories; use the platform's exclusive rename.
pub(crate) fn publish_directory_no_replace(source: &Path, destination: &Path) -> io::Result<()> {
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        let source = CString::new(source.as_os_str().as_bytes())?;
        let destination = CString::new(destination.as_os_str().as_bytes())?;
        // SAFETY: NUL-terminated paths and platform constants live for this call.
        let result = unsafe {
            libc::syscall(
                libc::SYS_renameat2,
                libc::AT_FDCWD,
                source.as_ptr(),
                libc::AT_FDCWD,
                destination.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        if result == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }
    #[cfg(target_os = "macos")]
    {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        let source = CString::new(source.as_os_str().as_bytes())?;
        let destination = CString::new(destination.as_os_str().as_bytes())?;
        // SAFETY: both paths remain live; RENAME_EXCL refuses any destination.
        let result =
            unsafe { libc::renamex_np(source.as_ptr(), destination.as_ptr(), libc::RENAME_EXCL) };
        if result == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
        let destination: Vec<u16> = destination
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        // SAFETY: terminated paths live for the call. MoveFileW never replaces.
        let result = unsafe {
            windows_sys::Win32::Storage::FileSystem::MoveFileW(
                source.as_ptr(),
                destination.as_ptr(),
            )
        };
        if result != 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }
    #[cfg(not(any(
        target_os = "linux",
        target_os = "android",
        target_os = "macos",
        windows
    )))]
    {
        let _ = (source, destination);
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "exclusive directory publication unavailable",
        ))
    }
}

pub(crate) fn io_failure_message(stage: &str, error: &std::io::Error) -> String {
    // Error::Display may contain a caller-supplied path. Only record OS facts.
    let code = error
        .raw_os_error()
        .map_or_else(|| "none".to_owned(), |value| value.to_string());
    format!("{stage} (io_kind={:?}, os_error={code})", error.kind())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQUENCE: AtomicU64 = AtomicU64::new(0);

    fn directory() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "bilikara-publication-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        path
    }

    #[test]
    fn artifact_directory_publication_never_replaces_even_an_empty_competitor() {
        let root = directory();
        let source = root.join("owned");
        let destination = root.join("competing");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("track"), b"owned").unwrap();
        fs::create_dir(&destination).unwrap();
        assert!(publish_directory_no_replace(&source, &destination).is_err());
        assert!(source.join("track").exists());
        assert_eq!(fs::read_dir(&destination).unwrap().count(), 0);
        let final_path = root.join("ready");
        publish_directory_no_replace(&source, &final_path).unwrap();
        assert_eq!(fs::read(final_path.join("track")).unwrap(), b"owned");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn publishes_only_completed_bytes() {
        let root = directory();
        let source = root.join("source.part");
        let destination = root.join("complete");
        fs::write(&source, b"complete bytes").unwrap();
        publish_no_replace(&source, &destination).unwrap();
        assert_eq!(fs::read(&destination).unwrap(), b"complete bytes");
        let _ = fs::remove_file(source);
        assert_eq!(fs::read(&destination).unwrap(), b"complete bytes");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn refuses_existing_destination_without_changing_either_file() {
        let root = directory();
        let source = root.join("source.part");
        let destination = root.join("complete");
        fs::write(&source, b"new bytes").unwrap();
        fs::write(&destination, b"keep bytes").unwrap();
        let error = publish_no_replace(&source, &destination).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(&source).unwrap(), b"new bytes");
        assert_eq!(fs::read(&destination).unwrap(), b"keep bytes");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn concurrent_publishers_have_exactly_one_winner() {
        let root = directory();
        let destination = root.join("complete");
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let handles = [b"first".as_slice(), b"second".as_slice()]
            .into_iter()
            .enumerate()
            .map(|(index, bytes)| {
                let source = root.join(format!("{index}.part"));
                fs::write(&source, bytes).unwrap();
                let destination = destination.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    (bytes, publish_no_replace(&source, &destination))
                })
            })
            .collect::<Vec<_>>();
        let results = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            results.iter().filter(|(_, result)| result.is_ok()).count(),
            1
        );
        for (bytes, result) in results {
            match result {
                Ok(()) => assert_eq!(fs::read(&destination).unwrap(), bytes),
                Err(error) => assert_eq!(error.kind(), io::ErrorKind::AlreadyExists),
            }
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn refuses_dangling_symlink_destination() {
        let root = directory();
        let source = root.join("source.part");
        let destination = root.join("complete");
        let missing = root.join("missing");
        fs::write(&source, b"new bytes").unwrap();
        std::os::unix::fs::symlink(&missing, &destination).unwrap();
        let error = publish_no_replace(&source, &destination).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read_link(&destination).unwrap(), missing);
        assert_eq!(fs::read(&source).unwrap(), b"new bytes");
        assert!(!missing.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn io_diagnostics_never_include_the_error_payload() {
        let error = std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "private-path/SESSDATA=secret?token=secret",
        );
        assert_eq!(
            io_failure_message("publish", &error),
            "publish (io_kind=PermissionDenied, os_error=none)"
        );
        let os_error = std::io::Error::from_raw_os_error(13);
        assert!(io_failure_message("publish", &os_error).contains("os_error=13"));
    }
}
