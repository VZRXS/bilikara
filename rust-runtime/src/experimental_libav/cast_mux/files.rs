//! Private, quota-bounded cast files under the caller's authoritative cache root.
use super::*;
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::Write,
    path::PathBuf,
    sync::{
        Arc, Mutex, TryLockError,
        atomic::{AtomicU64, Ordering},
    },
};

fn io_error(error: impl std::fmt::Display) -> ProbeError {
    ProbeError::BackendFailure(format!("cast staging: {error}"))
}
fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0 // all reparse points, including junctions
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}
fn private_directory(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    let mut builder = fs::DirBuilder::new();
    #[cfg(not(unix))]
    let builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)
}
fn lock_file(path: &Path) -> std::io::Result<File> {
    match fs::symlink_metadata(path) {
        Ok(m) if is_link(&m) || !m.is_file() => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "invalid cast lock",
            ));
        }
        Ok(_) => (),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
        Err(e) => return Err(e),
    }
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
}
// Never unlink this stable gate: all processes must lock the same inode.
fn root_gate(cast: &Path) -> std::io::Result<File> {
    let meta = fs::symlink_metadata(cast)?;
    if is_link(&meta) || !meta.is_dir() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "cast root is not a real directory",
        ));
    }
    let file = lock_file(&cast.join(".lock"))?;
    fs2::FileExt::lock_exclusive(&file)?;
    Ok(file)
}
/// Bounded, path-free diagnostics for a best-effort cleanup pass. Reasons are
/// fixed stage/error-category pairs, never OS error text or user filenames.
#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct CastRecovery {
    pub collected: usize,
    pub retained_live: usize,
    pub skipped: usize,
    pub reasons: BTreeMap<String, usize>,
}
impl CastRecovery {
    fn record(&mut self, stage: &'static str, error: &std::io::Error) {
        let reason = match error.kind() {
            #[cfg(windows)]
            _ if error.raw_os_error() == Some(32) => "sharing_violation",
            std::io::ErrorKind::PermissionDenied => "permission_denied",
            std::io::ErrorKind::InvalidData => "invalid_layout",
            std::io::ErrorKind::NotFound => "not_found",
            _ => "io_error",
        };
        self.skipped += 1;
        *self.reasons.entry(format!("{stage}:{reason}")).or_default() += 1;
    }
    fn log(&self) {
        if self.skipped != 0 {
            eprintln!("cast_recovery: {}", serde_json::json!(self));
        }
    }
}
fn recover_entry(path: &Path, report: &mut CastRecovery) {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(e) => {
            report.record("entry", &e);
            return;
        }
    };
    if is_link(&meta) || !meta.is_dir() {
        report.record(
            "entry",
            &std::io::Error::from(std::io::ErrorKind::InvalidData),
        );
        return;
    }
    let lease = match lock_file(&path.join(".lease")) {
        Ok(lease) => lease,
        Err(e) => {
            report.record("lease", &e);
            return;
        }
    };
    match fs2::FileExt::try_lock_exclusive(&lease) {
        Ok(()) => (),
        Err(e)
            if e.kind() == std::io::ErrorKind::WouldBlock
                || e.raw_os_error() == fs2::lock_contended_error().raw_os_error() =>
        {
            report.retained_live += 1;
            return;
        }
        Err(e) => {
            report.record("lease", &e);
            return;
        }
    }
    // Root gate still excludes creation and other collectors. Close before
    // Windows deletion; no live owner can acquire an abandoned directory.
    drop(lease);
    match fs::remove_dir_all(path) {
        // std does not follow child links/junctions
        Ok(()) => report.collected += 1,
        Err(e) => report.record("remove", &e),
    }
}
fn recover_locked(cast: &Path) -> CastRecovery {
    let mut report = CastRecovery::default();
    let entries = match fs::read_dir(cast) {
        Ok(entries) => entries,
        Err(e) => {
            report.record("enumerate", &e);
            return report;
        }
    };
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(e) => {
                report.record("enumerate", &e);
                continue;
            }
        };
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.len() != 32 || !name.bytes().all(|b| b.is_ascii_hexdigit()) {
            continue;
        }
        recover_entry(&entry.path(), &mut report);
    }
    report
}
struct Directory {
    path: PathBuf,
    lease: Option<File>,
}
impl Drop for Directory {
    fn drop(&mut self) {
        if let Some(root) = self.path.parent()
            && let Ok(_gate) = root_gate(root)
        {
            drop(self.lease.take());
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}
/// One per cast session. Files and in-flight readers share its private directory.
/// Retained files count against the quota; drop obsolete generations to free it.
pub struct CastSession {
    directory: Arc<Directory>,
    used: Arc<AtomicU64>,
    limit: u64,
    generator: Mutex<()>,
}
pub struct CastFile {
    path: PathBuf,
    pub summary: CastSummary,
    _directory: Arc<Directory>,
    used: Arc<AtomicU64>,
    charged: u64,
}
impl CastFile {
    pub fn path(&self) -> &Path {
        &self.path
    }
}
impl Drop for CastFile {
    fn drop(&mut self) {
        // On Windows a reader must retain this lease until its file handle closes.
        if fs::remove_file(&self.path).is_ok() {
            self.used.fetch_sub(self.charged, Ordering::AcqRel);
        }
    }
}
impl CastSession {
    /// Retain a caller-verified preencoded TS in the same quota/lease boundary
    /// as generated media. The self-test supplies its pinned bundled asset;
    /// this is not an untrusted upload or a format-validation entry point.
    #[cfg(feature = "native-host")]
    pub(crate) fn retain_ts(
        &self,
        bytes: &[u8],
        expected_sha256: &str,
        mut summary: CastSummary,
    ) -> Result<CastFile, ProbeError> {
        use sha2::{Digest, Sha256};
        if bytes.is_empty()
            || !bytes.len().is_multiple_of(188)
            || bytes.chunks_exact(188).any(|p| {
                p[0] != 0x47
                    || p[1] & 0x80 != 0
                    || p[3] & 0x30 == 0
                    || (p[3] & 0x20 != 0 && p[4] > 183)
            })
            || format!("{:x}", Sha256::digest(bytes)) != expected_sha256
        {
            return Err(io_error("invalid verified TS"));
        }
        let _generation = self.generator.lock().map_err(io_error)?;
        let size = bytes.len() as u64;
        if size == 0 || size > self.limit.saturating_sub(self.used.load(Ordering::Acquire)) {
            return Err(io_error("session quota exhausted"));
        }
        let mut nonce = [0; 16];
        getrandom::fill(&mut nonce).map_err(io_error)?;
        let path = self
            .directory
            .path
            .join(format!("{:032x}.ts", u128::from_le_bytes(nonce)));
        let result = (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
                .map_err(io_error)?;
            file.write_all(bytes)
                .and_then(|_| file.sync_all())
                .map_err(io_error)
        })();
        if let Err(error) = result {
            if fs::remove_file(&path).is_err()
                && let Ok(meta) = fs::metadata(&path)
            {
                self.used.fetch_add(meta.len(), Ordering::AcqRel);
            }
            return Err(error);
        }
        self.used.fetch_add(size, Ordering::AcqRel);
        summary.bytes = size;
        Ok(CastFile {
            path,
            summary,
            _directory: self.directory.clone(),
            used: self.used.clone(),
            charged: size,
        })
    }
    /// `cache_root` is runtime/data/cache (or its explicit configured override).
    /// The caller keeps this object until session end, and file leases until the
    /// last reader closes. No hard links, cache source mutation or external path.
    pub fn new(cache_root: &Path, max_bytes: u64) -> Result<Self, ProbeError> {
        if max_bytes == 0 || max_bytes > i64::MAX as u64 {
            return Err(io_error("invalid quota"));
        }
        let root = fs::canonicalize(cache_root).map_err(io_error)?;
        let cast = root.join(".cast");
        match private_directory(&cast) {
            Ok(()) => (),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
            Err(e) => return Err(io_error(e)),
        }
        let _gate = root_gate(&cast).map_err(io_error)?;
        recover_locked(&cast).log();
        let mut nonce = [0u8; 16];
        getrandom::fill(&mut nonce).map_err(io_error)?;
        let name = nonce.iter().map(|b| format!("{b:02x}")).collect::<String>();
        let path = cast.join(name);
        private_directory(&path).map_err(io_error)?;
        let lease = lock_file(&path.join(".lease")).map_err(io_error)?;
        fs2::FileExt::try_lock_exclusive(&lease).map_err(io_error)?;
        Ok(Self {
            directory: Arc::new(Directory {
                path,
                lease: Some(lease),
            }),
            used: Arc::new(AtomicU64::new(0)),
            generator: Mutex::new(()),
            limit: max_bytes,
        })
    }
    /// Best-effort recovery: a damaged or inaccessible cast root/entry is
    /// reported and left alone, never promoted to a Host startup/cache error.
    /// New sessions independently require a safe, exclusively locked cast root.
    pub fn recover(cache_root: &Path) -> CastRecovery {
        let mut report = CastRecovery::default();
        let root = match fs::canonicalize(cache_root) {
            Ok(root) => root,
            Err(e) => {
                report.record("root", &e);
                report.log();
                return report;
            }
        };
        let cast = root.join(".cast");
        match fs::symlink_metadata(&cast) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return report,
            Err(e) => {
                report.record("root", &e);
                report.log();
                return report;
            }
            Ok(_) => (),
        }
        match root_gate(&cast) {
            Ok(_gate) => report = recover_locked(&cast),
            Err(e) => report.record("root", &e),
        }
        report.log();
        report
    }
    pub fn mux(
        &self,
        probe: &LibavMetadataProbe,
        inputs: &CastInputs<'_>,
        format: CastFormat,
        stop: &AtomicBool,
    ) -> Result<CastFile, ProbeError> {
        // Serialize generators within a session; readers never acquire this lock.
        let _generation = loop {
            if stop.load(Ordering::Acquire) {
                return Err(ProbeError::Cancelled);
            }
            match self.generator.try_lock() {
                Ok(lock) => break lock,
                Err(TryLockError::Poisoned(error)) => return Err(io_error(error)),
                Err(TryLockError::WouldBlock) => std::thread::sleep(Duration::from_millis(10)),
            }
        };
        let remaining = self.limit.saturating_sub(self.used.load(Ordering::Acquire));
        if remaining == 0 {
            return Err(io_error("session quota exhausted"));
        }
        let mut nonce = [0u8; 16];
        getrandom::fill(&mut nonce).map_err(io_error)?;
        let name = nonce.iter().map(|b| format!("{b:02x}")).collect::<String>();
        let staging = self.directory.path.join(format!("{name}.part"));
        let published = self.directory.path.join(format!(
            "{name}.{}",
            if format == CastFormat::Ts {
                "ts"
            } else {
                "mp4"
            }
        ));
        // Unique exclusive directory and filenames make rename no-replace by
        // construction, including Android (which forbids hard-link publication).
        let result = (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&staging)
                .map_err(io_error)?;
            let mut write_error = None;
            let summary = if format == CastFormat::Ts {
                let result = probe.cast_run(
                    inputs,
                    CastOutput::FileTs,
                    CastPacing::FullSpeed,
                    remaining,
                    stop,
                    &mut |event| match event {
                        CastEvent::Start(_) => true,
                        CastEvent::Data { bytes, .. } => match file.write_all(bytes) {
                            Ok(()) => true,
                            Err(e) => {
                                write_error = Some(e);
                                false
                            }
                        },
                    },
                );
                if let Some(e) = write_error {
                    return Err(io_error(e));
                }
                result?
            } else {
                drop(file);
                let summary = probe.cast_run(
                    inputs,
                    CastOutput::Mp4(&staging),
                    CastPacing::FullSpeed,
                    remaining,
                    stop,
                    &mut |_| true,
                )?;
                file = OpenOptions::new()
                    .write(true)
                    .open(&staging)
                    .map_err(io_error)?;
                summary
            };
            file.sync_all().map_err(io_error)?;
            drop(file);
            let size = fs::metadata(&staging).map_err(io_error)?.len();
            if size != summary.bytes || size > remaining {
                return Err(io_error("invalid finalized size"));
            }
            if stop.load(std::sync::atomic::Ordering::Acquire) {
                return Err(ProbeError::Cancelled);
            }
            #[cfg(target_os = "android")]
            crate::file_publication::publish_no_replace(&staging, &published).map_err(io_error)?;
            #[cfg(not(target_os = "android"))]
            fs::rename(&staging, &published).map_err(io_error)?;
            self.used.fetch_add(size, Ordering::AcqRel);
            Ok(CastFile {
                path: published,
                summary,
                _directory: self.directory.clone(),
                used: self.used.clone(),
                charged: size,
            })
        })();
        if result.is_err() && fs::remove_file(&staging).is_err() {
            // A failed cleanup still consumes disk until the session directory
            // is removed; retries must not bypass the quota with orphan parts.
            if let Ok(metadata) = fs::metadata(&staging) {
                self.used.fetch_add(metadata.len(), Ordering::AcqRel);
            }
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(feature = "native-host")]
    #[test]
    fn retained_ts_is_verified_charged_leased_and_released() {
        use sha2::{Digest, Sha256};
        let root = root();
        let mut bytes = vec![0xff; 188];
        bytes[..4].copy_from_slice(&[0x47, 0x1f, 0xff, 0x10]);
        let hash = format!("{:x}", Sha256::digest(&bytes));
        let summary = CastSummary {
            packets: 1,
            bytes: 188,
            profile: 77,
            level: 40,
            width: 1920,
            height: 1080,
            has_b_frames: false,
            audio_transcoded: false,
            source_start_us: 0,
            duration_us: 1,
            gop_us: None,
        };
        let session = CastSession::new(&root, 188).unwrap();
        let file = session.retain_ts(&bytes, &hash, summary.clone()).unwrap();
        let path = file.path().to_owned();
        assert_eq!(session.used.load(Ordering::Acquire), 188);
        assert!(session.retain_ts(&bytes, &hash, summary.clone()).is_err());
        assert_eq!(CastSession::recover(&root).retained_live, 1);
        drop(file);
        assert!(!path.exists());
        assert_eq!(session.used.load(Ordering::Acquire), 0);
        let mut broken = bytes.clone();
        broken[50] ^= 1;
        assert!(session.retain_ts(&broken, &hash, summary.clone()).is_err());
        assert!(
            session
                .retain_ts(&bytes[..187], &hash, summary.clone())
                .is_err()
        );
        assert!(
            session
                .retain_ts(
                    &[bytes.clone(), bytes.clone()].concat(),
                    &hash,
                    summary.clone()
                )
                .is_err()
        );
        let file = Arc::new(session.retain_ts(&bytes, &hash, summary).unwrap());
        let reader = file.clone();
        let directory = file.path().parent().unwrap().to_owned();
        drop(session);
        drop(file);
        assert_eq!(CastSession::recover(&root).retained_live, 1);
        assert_eq!(fs::read(reader.path()).unwrap(), bytes);
        drop(reader);
        assert!(!directory.exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(feature = "native-host")]
    #[test]
    fn retained_ts_crash_child() {
        let Some(root) = std::env::var_os("BILIKARA_RETAIN_TS_CRASH_ROOT") else {
            return;
        };
        use sha2::{Digest, Sha256};
        let mut bytes = vec![0xff; 188];
        bytes[..4].copy_from_slice(&[0x47, 0x1f, 0xff, 0x10]);
        let hash = format!("{:x}", Sha256::digest(&bytes));
        let session = CastSession::new(Path::new(&root), 188).unwrap();
        let summary = CastSummary {
            packets: 1,
            bytes: 188,
            profile: 77,
            level: 40,
            width: 1920,
            height: 1080,
            has_b_frames: false,
            audio_transcoded: false,
            source_start_us: 0,
            duration_us: 1,
            gop_us: None,
        };
        let file = session.retain_ts(&bytes, &hash, summary).unwrap();
        std::mem::forget(file);
        std::mem::forget(session);
        std::process::exit(0);
    }
    #[cfg(feature = "native-host")]
    #[test]
    fn retained_ts_crash_is_collected_without_touching_a_live_reader() {
        let root = root();
        let live = CastSession::new(&root, 188).unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "experimental_libav::cast_mux::files::tests::retained_ts_crash_child",
            ])
            .env("BILIKARA_RETAIN_TS_CRASH_ROOT", &root)
            .status()
            .unwrap();
        assert!(status.success());
        let report = CastSession::recover(&root);
        assert_eq!(report.collected, 1);
        assert_eq!(report.retained_live, 1);
        drop(live);
        fs::remove_dir_all(root).unwrap();
    }
    fn root() -> PathBuf {
        let mut nonce = [0; 16];
        getrandom::fill(&mut nonce).unwrap();
        let path =
            std::env::temp_dir().join(format!("cast-recovery-{:x}", u128::from_ne_bytes(nonce)));
        fs::create_dir(&path).unwrap();
        path
    }
    #[test]
    fn crash_owner_child() {
        let Some(root) = std::env::var_os("BILIKARA_CAST_CRASH_TEST_ROOT") else {
            return;
        };
        let session = CastSession::new(Path::new(&root), 1024).unwrap();
        fs::write(session.directory.path.join("crashed.part"), b"unfinished").unwrap();
        std::process::exit(0); // deliberate crash-like exit: no Directory/lease Drop
    }
    #[test]
    fn recovery_reclaims_crashed_owner_but_preserves_live_reader_lease() {
        let root = root();
        let session = CastSession::new(&root, 1024).unwrap();
        let reader = session.directory.clone();
        let path = reader.path.clone();
        fs::write(path.join("live.ts"), b"live").unwrap();
        drop(session);
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "experimental_libav::cast_mux::files::tests::crash_owner_child",
                "--nocapture",
            ])
            .env("BILIKARA_CAST_CRASH_TEST_ROOT", &root)
            .status()
            .unwrap();
        assert!(status.success());
        assert_eq!(CastSession::recover(&root).collected, 1);
        assert!(path.join("live.ts").exists());
        assert_eq!(CastSession::recover(&root).collected, 0);
        drop(reader);
        assert!(!path.exists());
        // A crash between mkdir and lease creation is also recoverable.
        let orphan = root.join(".cast").join("0123456789abcdef0123456789abcdef");
        fs::create_dir(&orphan).unwrap();
        fs::write(orphan.join("partial"), b"x").unwrap();
        let next = CastSession::new(&root, 1024).unwrap();
        assert!(!orphan.exists());
        drop(next);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn recovery_skips_failed_cast_orphans_and_preserves_live_leases() {
        use super::super::recovery_test_support::{BlockedOrphan, cases, orphan};
        for case in cases() {
            let root = root();
            let live = CastSession::new(&root, 1024).unwrap();
            let reader = live.directory.clone();
            let live_path = reader.path.join("live.ts");
            fs::write(&live_path, b"live").unwrap();
            drop(live);
            let blocked = BlockedOrphan::new(&root, case);
            let good = orphan(&root, 2);
            let report = CastSession::recover(&root);
            assert_eq!(report.collected, 1, "{case:?}: {report:?}");
            assert_eq!(report.skipped, 1);
            assert_eq!(report.retained_live, 1);
            assert_eq!(report.reasons[blocked.reason], 1);
            let diagnostic = serde_json::to_string(&report).unwrap();
            assert!(!diagnostic.contains(&root.to_string_lossy().to_string()));
            assert!(!diagnostic.contains("crashed.part"));
            assert!(!good.exists());
            assert!(blocked.path.exists());
            assert!(live_path.exists());
            let next_good = orphan(&root, 3);
            let next = CastSession::new(&root, 1024).unwrap();
            assert!(!next_good.exists());
            assert!(live_path.exists());
            assert!(blocked.path.exists());
            drop(next);
            drop(reader);
            drop(blocked);
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[cfg(windows)]
    #[test]
    fn recovery_does_not_follow_cast_junctions() {
        fn junction(target: &Path, link: &Path) {
            let status = std::process::Command::new("powershell.exe")
                .args(["-NoProfile", "-NonInteractive", "-Command",
                    "$ErrorActionPreference = 'Stop'; New-Item -ItemType Junction -Path $env:BILIKARA_CAST_LINK -Target $env:BILIKARA_CAST_TARGET | Out-Null"])
                .env("BILIKARA_CAST_LINK", link)
                .env("BILIKARA_CAST_TARGET", target)
                .status().unwrap();
            assert!(status.success());
        }
        use super::super::recovery_test_support::orphan;
        let root = root();
        let outside = root.with_extension("outside");
        fs::create_dir(&outside).unwrap();
        let sentinel = outside.join("keep");
        fs::write(&sentinel, b"outside cast").unwrap();
        junction(&outside, &root.join(".cast"));
        assert_eq!(
            CastSession::recover(&root).reasons["root:invalid_layout"],
            1
        );
        assert!(CastSession::new(&root, 1024).is_err());
        assert_eq!(fs::read(&sentinel).unwrap(), b"outside cast");
        fs::remove_dir(root.join(".cast")).unwrap(); // unlink only the junction
        let session = CastSession::new(&root, 1024).unwrap();
        let linked_session = root.join(".cast").join(format!("{:032x}", 1));
        junction(&outside, &linked_session);
        let bad_lease = orphan(&root, 2);
        junction(&outside, &bad_lease.join(".lease"));
        let removable = orphan(&root, 3);
        junction(&outside, &removable.join("nested"));
        let report = CastSession::recover(&root);
        assert_eq!(report.collected, 1);
        assert_eq!(report.retained_live, 1);
        assert_eq!(report.skipped, 2);
        assert_eq!(report.reasons["entry:invalid_layout"], 1);
        assert_eq!(report.reasons["lease:invalid_layout"], 1);
        assert!(!removable.exists());
        assert!(linked_session.exists());
        assert!(bad_lease.exists());
        assert_eq!(fs::read(&sentinel).unwrap(), b"outside cast");
        drop(session);
        fs::remove_dir_all(&root).unwrap();
        assert_eq!(fs::read(&sentinel).unwrap(), b"outside cast");
        fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn recovery_rejects_non_directory_root_and_preserves_unrecognized_paths() {
        let root = root();
        fs::write(root.join(".cast"), b"not ours").unwrap();
        assert_eq!(
            CastSession::recover(&root).reasons["root:invalid_layout"],
            1
        );
        assert!(CastSession::new(&root, 1024).is_err());
        fs::remove_file(root.join(".cast")).unwrap();
        let session = CastSession::new(&root, 1024).unwrap();
        let other = root.join(".cast/not-a-session");
        fs::create_dir(&other).unwrap();
        assert_eq!(CastSession::recover(&root).collected, 0);
        assert!(other.exists());
        drop(session);
        fs::remove_dir_all(root).unwrap();
    }
}
