//! Opt-in storage for an in-process Host. It is not the desktop JSON adapter.
//! AppState supplies restart-safe snapshots and publishes mutations only after
//! the new checkpoint has atomically replaced the old one.
use crate::app_state::AppStateSeed;
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

const CHECKPOINT_VERSION: u32 = 1;
const CHECKPOINT_FILE: &str = "host-state.json";
const MAX_CHECKPOINT_BYTES: u64 = 32 * 1024 * 1024;

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
}

#[derive(Debug)]
pub(crate) struct NativeHostStorage {
    directory: PathBuf,
    // Keep the stable lock file open for the lifetime of this state authority.
    // Never unlink it: replacing a lock inode could admit a second writer.
    _lock: File,
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
            _lock: lock,
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

    fn load(&self) -> Result<Option<AppStateSeed>, NativeStorageError> {
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
        let checkpoint: Checkpoint = serde_json::from_slice(&bytes).map_err(|_| {
            NativeStorageError::new(
                "native_storage_invalid",
                "Checkpoint is incomplete or incompatible; the original file has been preserved",
            )
        })?;
        if checkpoint.schema_version != CHECKPOINT_VERSION {
            return Err(NativeStorageError::new(
                "native_storage_version",
                "Unsupported checkpoint version; the original file has been preserved",
            ));
        }
        Ok(Some(checkpoint.state))
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
        let checkpoint = Checkpoint {
            schema_version: CHECKPOINT_VERSION,
            state,
        };
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
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temp);
        } else {
            self.last_state = Some(checkpoint.state);
        }
        result
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
    fn bounded_writer_never_writes_beyond_the_limit() {
        let mut writer = BoundedWriter {
            inner: Vec::new(),
            remaining: 4,
        };
        writer.write_all(b"123").unwrap();
        assert!(writer.write_all(b"45").is_err());
        assert_eq!(writer.inner, b"123");
    }
}
