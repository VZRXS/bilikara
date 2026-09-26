//! Opt-in storage for an in-process Host. It is not the desktop JSON adapter.
//! AppState supplies restart-safe snapshots and publishes mutations only after
//! the new checkpoint has atomically replaced the old one.
use crate::app_state::AppStateSeed;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

const CHECKPOINT_VERSION: u32 = 3;
const CHECKPOINT_FILE: &str = "host-state.json";
#[cfg(test)]
const V1_BACKUP_FILE: &str = "host-state.v1.backup.json";
const MAX_CHECKPOINT_BYTES: u64 = 32 * 1024 * 1024;
const RECORD_CHUNK_BYTES: usize = 1024 * 1024;

#[derive(Debug)]
pub(crate) struct NativeStorageError {
    pub(crate) kind: &'static str,
    pub(crate) message: String,
}

impl NativeStorageError {
    fn new(kind: &'static str, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    fn io(operation: &str, error: io::Error) -> Self {
        // Return actionable error classes, not platform paths or saved contents.
        Self::new(
            "native_storage_io",
            format!("{operation}: {:?}", error.kind()),
        )
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Checkpoint {
    schema_version: u32,
    state: AppStateSeed,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    records: BTreeMap<String, Vec<String>>,
}

#[derive(Debug)]
pub(crate) struct NativeHostStorage {
    directory: PathBuf,
    // Keep the stable lock file open for the lifetime of this state authority.
    // Never unlink it: replacing a lock inode could admit a second writer.
    lock: File,
    last_state: Option<AppStateSeed>,
}

fn private_options() -> OpenOptions {
    let options = OpenOptions::new();
    #[cfg(unix)]
    let options = {
        use std::os::unix::fs::OpenOptionsExt;
        let mut options = options;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        options
    };
    options
}

fn check_regular_or_missing(path: &Path) -> Result<(), NativeStorageError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(NativeStorageError::io("Inspect storage file", error)),
        _ => Err(NativeStorageError::new(
            "native_storage_invalid",
            "Storage files must be regular files, not links or directories",
        )),
    }
}

impl NativeHostStorage {
    pub(crate) fn open(
        directory: &Path,
    ) -> Result<(Self, Option<AppStateSeed>), NativeStorageError> {
        if !directory.is_absolute() {
            return Err(NativeStorageError::new(
                "native_storage_path",
                "Native storage requires an absolute app-private directory",
            ));
        }
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder
            .create(directory)
            .map_err(|error| NativeStorageError::io("Create storage directory", error))?;
        let directory = directory
            .canonicalize()
            .map_err(|error| NativeStorageError::io("Resolve storage directory", error))?;
        check_regular_or_missing(&directory.join("host-state.lock"))?;
        let lock = private_options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(directory.join("host-state.lock"))
            .map_err(|error| NativeStorageError::io("Open storage lock", error))?;
        fs2::FileExt::try_lock_exclusive(&lock).map_err(|error| {
            if error.kind() == io::ErrorKind::WouldBlock
                || error.raw_os_error() == fs2::lock_contended_error().raw_os_error()
            {
                NativeStorageError::new(
                    "native_storage_in_use",
                    "Another Host already owns this storage directory",
                )
            } else {
                NativeStorageError::io("Lock storage directory", error)
            }
        })?;
        let storage = Self {
            directory,
            lock,
            last_state: None,
        };
        let state = storage.load()?;
        Ok((storage, state))
    }

    pub(crate) fn is_directory(&self, directory: &Path) -> bool {
        directory
            .canonicalize()
            .is_ok_and(|path| path == self.directory)
    }

    pub(crate) fn load(&self) -> Result<Option<AppStateSeed>, NativeStorageError> {
        check_regular_or_missing(&self.directory.join(CHECKPOINT_FILE))?;
        let file = match private_options()
            .read(true)
            .open(self.directory.join(CHECKPOINT_FILE))
        {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(NativeStorageError::io("Open checkpoint", error)),
        };
        let metadata = file
            .metadata()
            .map_err(|error| NativeStorageError::io("Inspect checkpoint", error))?;
        if !metadata.is_file() || metadata.len() > MAX_CHECKPOINT_BYTES {
            return Err(NativeStorageError::new(
                "native_storage_invalid",
                "Checkpoint must be a regular file no larger than 32 MiB",
            ));
        }
        let mut bytes = Vec::new();
        file.take(MAX_CHECKPOINT_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| NativeStorageError::io("Read checkpoint", error))?;
        if bytes.len() as u64 > MAX_CHECKPOINT_BYTES {
            return Err(NativeStorageError::new(
                "native_storage_invalid",
                "Checkpoint exceeds 32 MiB",
            ));
        }
        let mut checkpoint: Checkpoint = serde_json::from_slice(&bytes).map_err(|_| {
            NativeStorageError::new(
                "native_storage_invalid",
                "Checkpoint is incomplete or incompatible; the original file has been preserved",
            )
        })?;
        if ![1, 2, CHECKPOINT_VERSION].contains(&checkpoint.schema_version) {
            return Err(NativeStorageError::new(
                "native_storage_version",
                "Unsupported checkpoint version; the original file has been preserved",
            ));
        }
        if (checkpoint.schema_version == 2 && checkpoint.records.len() != 6)
            || (checkpoint.schema_version == 3 && checkpoint.records.len() != 7)
        {
            return Err(NativeStorageError::new(
                "native_storage_invalid",
                "Record manifest is incomplete",
            ));
        }
        self.restore_records(&mut checkpoint)?;
        if checkpoint.schema_version < CHECKPOINT_VERSION {
            self.preserve_checkpoint(checkpoint.schema_version, &bytes)?;
        }
        Ok(Some(checkpoint.state))
    }

    fn preserve_checkpoint(&self, version: u32, bytes: &[u8]) -> Result<(), NativeStorageError> {
        let backup = self
            .directory
            .join(format!("host-state.v{version}.backup.json"));
        check_regular_or_missing(&backup)?;
        if backup.exists() {
            return Ok(());
        }
        let pending = self
            .directory
            .join(format!("host-state.v{version}.backup.pending"));
        check_regular_or_missing(&pending)?;
        let mut file = private_options()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&pending)
            .map_err(|e| NativeStorageError::io("Create legacy backup", e))?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| NativeStorageError::io("Write legacy backup", e))?;
        drop(file);
        fs::rename(pending, backup)
            .map_err(|e| NativeStorageError::io("Publish legacy backup", e))?;
        sync_directory(&self.directory)
    }

    fn record_directory(&self) -> Result<PathBuf, NativeStorageError> {
        let directory = self.directory.join("host-records");
        match fs::symlink_metadata(&directory) {
            Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                fs::create_dir(&directory)
                    .map_err(|e| NativeStorageError::io("Create record directory", e))?;
            }
            _ => {
                return Err(NativeStorageError::new(
                    "native_storage_invalid",
                    "Record storage must be a directory",
                ));
            }
        }
        Ok(directory)
    }

    fn split_records(&self, checkpoint: &mut Checkpoint) -> Result<(), NativeStorageError> {
        let directory = self.record_directory()?;
        // Immutable, content-addressed pieces are written before the manifest.
        // The manifest rename remains the single commit point for every field.
        // Serialize each typed field directly; do not allocate a second JSON
        // tree containing the entire history on every durable mutation.
        macro_rules! record {
            ($field:ident) => {{
                let value = std::mem::take(&mut checkpoint.state.$field);
                (
                    stringify!($field),
                    serde_json::to_vec(&value).map_err(|_| {
                        NativeStorageError::new("native_storage_write", "Cannot serialize records")
                    })?,
                )
            }};
        }
        let records = [
            record!(history),
            record!(session_history),
            record!(session_played),
            record!(session_archives),
            record!(previous_session),
            record!(backup),
            record!(gatcha_pool_preferences),
        ];
        for (field, bytes) in records {
            let mut files = Vec::new();
            for chunk in bytes.chunks(RECORD_CHUNK_BYTES) {
                let name = format!("{:x}.part", Sha256::digest(chunk));
                let path = directory.join(&name);
                check_regular_or_missing(&path)?;
                // A damaged existing piece must never be carried into the next
                // committed manifest just because its filename matches.
                let needs_write = match private_options().read(true).open(&path) {
                    Ok(file) => {
                        let mut bytes = Vec::new();
                        file.take(chunk.len() as u64 + 1)
                            .read_to_end(&mut bytes)
                            .map_err(|e| NativeStorageError::io("Verify record", e))?;
                        bytes != chunk
                    }
                    Err(error) if error.kind() == io::ErrorKind::NotFound => true,
                    Err(error) => return Err(NativeStorageError::io("Verify record", error)),
                };
                if needs_write {
                    let pending = directory.join("record.pending");
                    check_regular_or_missing(&pending)?;
                    let mut output = private_options()
                        .write(true)
                        .create(true)
                        .truncate(true)
                        .open(&pending)
                        .map_err(|e| NativeStorageError::io("Create record", e))?;
                    output
                        .write_all(chunk)
                        .and_then(|_| output.sync_all())
                        .map_err(|e| NativeStorageError::io("Write record", e))?;
                    fs::rename(&pending, &path)
                        .map_err(|e| NativeStorageError::io("Publish record", e))?;
                }
                files.push(name);
            }
            checkpoint.records.insert(field.into(), files);
        }
        sync_directory(&directory)?;
        Ok(())
    }

    fn restore_records(&self, checkpoint: &mut Checkpoint) -> Result<(), NativeStorageError> {
        if checkpoint.records.is_empty() {
            return Ok(());
        }
        let directory = self.record_directory()?;
        let invalid = || {
            NativeStorageError::new(
                "native_storage_invalid",
                "Saved records are incomplete or corrupt; original files preserved",
            )
        };
        let mut value = serde_json::to_value(&checkpoint.state).map_err(|_| invalid())?;
        for (field, files) in &checkpoint.records {
            if ![
                "history",
                "session_history",
                "session_played",
                "session_archives",
                "previous_session",
                "backup",
                "gatcha_pool_preferences",
            ]
            .contains(&field.as_str())
                || files.is_empty()
            {
                return Err(invalid());
            }
            let mut bytes = Vec::new();
            for name in files {
                if name.len() != 69
                    || !name.ends_with(".part")
                    || !name.as_bytes()[..64]
                        .iter()
                        .copied()
                        .all(|b| b.is_ascii_hexdigit())
                {
                    return Err(invalid());
                }
                let path = directory.join(name);
                check_regular_or_missing(&path)?;
                let mut chunk = Vec::new();
                private_options()
                    .read(true)
                    .open(path)
                    .map_err(|e| NativeStorageError::io("Open record", e))?
                    .take(RECORD_CHUNK_BYTES as u64 + 1)
                    .read_to_end(&mut chunk)
                    .map_err(|e| NativeStorageError::io("Read record", e))?;
                if chunk.len() > RECORD_CHUNK_BYTES
                    || format!("{:x}.part", Sha256::digest(&chunk)) != *name
                {
                    return Err(invalid());
                }
                bytes.extend(chunk);
            }
            value[field] = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
        }
        checkpoint.state = serde_json::from_value(value).map_err(|_| invalid())?;
        Ok(())
    }

    fn collect_records(&self, checkpoint: &Checkpoint) {
        let mut retained: HashSet<String> =
            checkpoint.records.values().flatten().cloned().collect();
        // A v2 backup references immutable chunks too. Keep its dependencies so
        // rollback remains possible after the current history/config changes.
        if let Ok(bytes) = fs::read(self.directory.join("host-state.v2.backup.json"))
            && let Ok(backup) = serde_json::from_slice::<Checkpoint>(&bytes)
        {
            retained.extend(backup.records.into_values().flatten());
        }
        let Ok(entries) = fs::read_dir(self.directory.join("host-records")) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.len() == 69
                && name.ends_with(".part")
                && name.as_bytes()[..64]
                    .iter()
                    .copied()
                    .all(|b| b.is_ascii_hexdigit())
                && !retained.contains(&name)
            {
                let _ = fs::remove_file(entry.path());
            }
        }
    }

    pub(crate) fn save(&mut self, mut state: AppStateSeed) -> Result<(), NativeStorageError> {
        // Progress, revision and playback-lifetime churn are not durable changes.
        // Ignore the projection timestamp when the restart-safe state is equal.
        if let Some(previous) = &self.last_state {
            let now = state.updated_at;
            state.updated_at = previous.updated_at;
            if &state == previous {
                return Ok(());
            }
            state.updated_at = now;
        }
        let mut checkpoint = Checkpoint {
            schema_version: CHECKPOINT_VERSION,
            state: state.clone(),
            records: BTreeMap::new(),
        };
        self.split_records(&mut checkpoint)?;
        // A fixed scratch name is safe under the lifetime lock. An abandoned
        // file is never read as a checkpoint, and is truncated on the next save.
        let temp = self.directory.join("host-state.pending");
        check_regular_or_missing(&temp)?;
        let result = (|| {
            let file = private_options()
                .write(true)
                .create(true)
                .truncate(true)
                .open(&temp)
                .map_err(|error| NativeStorageError::io("Create pending checkpoint", error))?;
            let mut writer = BoundedWriter {
                inner: io::BufWriter::new(file),
                remaining: MAX_CHECKPOINT_BYTES,
            };
            serde_json::to_writer(&mut writer, &checkpoint).map_err(|error| {
                if writer.remaining == 0 {
                    NativeStorageError::new(
                        "native_storage_full",
                        "Checkpoint exceeds the 32 MiB storage limit",
                    )
                } else {
                    NativeStorageError::new(
                        "native_storage_write",
                        format!("Write checkpoint failed ({:?})", error.classify()),
                    )
                }
            })?;
            writer
                .flush()
                .map_err(|error| NativeStorageError::io("Flush checkpoint", error))?;
            writer
                .inner
                .get_ref()
                .sync_all()
                .map_err(|error| NativeStorageError::io("Sync checkpoint", error))?;
            drop(writer);
            // Same-directory rename is the commit point: do not report failure
            // after it and leave the live authority older than the saved state.
            fs::rename(&temp, self.directory.join(CHECKPOINT_FILE))
                .map_err(|error| NativeStorageError::io("Replace checkpoint", error))?;
            // The rename is already committed. Keep the in-memory authority
            // current even if a filesystem cannot complete directory sync.
            if sync_directory(&self.directory).is_err() {
                eprintln!("[native-storage] checkpoint committed; directory sync failed");
            }
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temp);
        } else {
            self.collect_records(&checkpoint);
            self.last_state = Some(state);
        }
        result
    }
}

fn sync_directory(directory: &Path) -> Result<(), NativeStorageError> {
    #[cfg(unix)]
    File::open(directory)
        .and_then(|file| file.sync_all())
        .map_err(|e| NativeStorageError::io("Sync storage directory", e))?;
    #[cfg(not(unix))]
    let _ = directory;
    Ok(())
}

impl Drop for NativeHostStorage {
    fn drop(&mut self) {
        // Closing the descriptor is not a deterministic release. A flock lives on
        // the open file description, so any child forked while this Host was
        // running keeps that description - and the lock - alive until it execs.
        // Unlock first: that clears the lock on the shared description itself, so
        // the directory is free the moment this authority goes away.
        let _ = fs2::FileExt::unlock(&self.lock);
    }
}

struct BoundedWriter<W> {
    inner: W,
    remaining: u64,
}

impl<W: Write> Write for BoundedWriter<W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() as u64 > self.remaining {
            self.remaining = 0;
            return Err(io::Error::other("checkpoint size limit exceeded"));
        }
        let written = self.inner.write(bytes)?;
        self.remaining -= written as u64;
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upgrade_keeps_original_v1_bytes_and_repairs_corrupt_reused_chunks() {
        let directory = std::env::temp_dir().join(format!(
            "bilikara-storage-upgrade-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&directory).unwrap();
        let original = br#"{"schema_version":1,"state":{"session_started_at":1,"session_played_file":"test.json","updated_at":1}}"#;
        fs::write(directory.join(CHECKPOINT_FILE), original).unwrap();
        let (mut storage, seed) = NativeHostStorage::open(&directory).unwrap();
        let mut seed = seed.unwrap();
        assert_eq!(fs::read(directory.join(V1_BACKUP_FILE)).unwrap(), original);
        storage.save(seed.clone()).unwrap();
        let manifest: Checkpoint =
            serde_json::from_slice(&fs::read(directory.join(CHECKPOINT_FILE)).unwrap()).unwrap();
        let piece = directory
            .join("host-records")
            .join(&manifest.records["history"][0]);
        fs::write(&piece, b"damaged").unwrap();
        assert!(storage.load().is_err());
        seed.updated_at += 1.0;
        seed.session_users.push("Alice".into());
        storage.save(seed.clone()).unwrap();
        assert_eq!(storage.load().unwrap().unwrap(), seed);
        assert_eq!(fs::read(directory.join(V1_BACKUP_FILE)).unwrap(), original);
        drop(storage);
        // A deliberate rollback and a second upgrade preserve the first backup.
        let changed = String::from_utf8(original.to_vec())
            .unwrap()
            .replace("\"updated_at\":1", "\"updated_at\":2");
        fs::write(directory.join(CHECKPOINT_FILE), changed).unwrap();
        let (storage, _) = NativeHostStorage::open(&directory).unwrap();
        assert_eq!(fs::read(directory.join(V1_BACKUP_FILE)).unwrap(), original);
        drop(storage);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn split_records_roundtrip_large_history_and_detect_missing_chunks() {
        let directory = std::env::temp_dir().join(format!(
            "bilikara-records-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let (mut storage, _) = NativeHostStorage::open(&directory).unwrap();
        let entry = serde_json::json!({"key":"song", "item_id":"song", "display_title":"x".repeat(4096), "title":"Song", "part_title":"P1", "original_url":"https://example.test/video", "resolved_url":"https://example.test/video", "bvid":"BV1z84y1p7oS", "aid":1, "cid":2, "page":1,"played_at":10});
        let seed: AppStateSeed = serde_json::from_value(serde_json::json!({"session_started_at":1,"session_played_file":"played.json","updated_at":1,"session_played":vec![entry;9000]})).unwrap();
        storage.save(seed.clone()).unwrap();
        assert_eq!(storage.load().unwrap().unwrap(), seed);
        assert!(fs::metadata(directory.join(CHECKPOINT_FILE)).unwrap().len() < 32 * 1024);
        for file in fs::read_dir(directory.join("host-records"))
            .unwrap()
            .flatten()
        {
            assert!(file.metadata().unwrap().len() <= RECORD_CHUNK_BYTES as u64);
        }
        let manifest: Checkpoint =
            serde_json::from_slice(&fs::read(directory.join(CHECKPOINT_FILE)).unwrap()).unwrap();
        fs::remove_file(
            directory
                .join("host-records")
                .join(&manifest.records["session_played"][0]),
        )
        .unwrap();
        assert!(storage.load().is_err());
        drop(storage);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn bounded_writer_never_writes_beyond_the_limit() {
        let mut writer = BoundedWriter {
            inner: Vec::new(),
            remaining: 4,
        };
        writer.write_all(b"123").unwrap();
        assert!(writer.write_all(b"45").is_err());
        assert_eq!(writer.inner, b"123");
    }

    #[test]
    fn version_two_migrates_all_preferences_and_keeps_backup_record_dependencies() {
        let directory = std::env::temp_dir().join(format!(
            "bilikara-v2-migration-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let (mut storage, _) = NativeHostStorage::open(&directory).unwrap();
        let mut seed: AppStateSeed = serde_json::from_value(serde_json::json!({"session_started_at":1,"session_played_file":"test.json","updated_at":1})).unwrap();
        for index in 0..300 {
            seed.gatcha_pool_preferences.insert(
                format!("user:{index}"),
                serde_json::json!({"uid_weight":index % 100}),
            );
        }
        storage.save(seed.clone()).unwrap();
        let path = directory.join(CHECKPOINT_FILE);
        let mut legacy: Checkpoint = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        legacy.schema_version = 2;
        legacy.records.remove("gatcha_pool_preferences");
        legacy.state.gatcha_pool_preferences = seed.gatcha_pool_preferences.clone();
        let original = serde_json::to_vec(&legacy).unwrap();
        fs::write(&path, &original).unwrap();
        drop(storage);
        let (mut storage, loaded) = NativeHostStorage::open(&directory).unwrap();
        assert_eq!(loaded.unwrap(), seed);
        seed.gatcha_pool_preferences.insert("user:large".into(), serde_json::json!({"excluded_uids": (0..100_000).map(|i|i.to_string()).collect::<Vec<_>>() }));
        storage.save(seed.clone()).unwrap();
        assert_eq!(storage.load().unwrap().unwrap(), seed);
        assert_eq!(
            fs::read(directory.join("host-state.v2.backup.json")).unwrap(),
            original
        );
        for name in legacy.records.values().flatten() {
            assert!(directory.join("host-records").join(name).is_file());
        }
        assert!(fs::metadata(&path).unwrap().len() < 32 * 1024);
        drop(storage);
        fs::remove_dir_all(directory).unwrap();
    }
}
