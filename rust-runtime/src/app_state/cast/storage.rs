//! Optional preferences under the existing NativeHostStorage lifetime lock.
//! A corrupt file never prevents Host startup and is never overwritten.
use super::Preferences;
use std::{
    fs,
    io::{self, Read},
    path::Path,
};
#[cfg(feature = "native-host")]
use std::{io::Write, path::PathBuf};

const LIMIT: u64 = 256 * 1024;
#[derive(Debug)]
pub(crate) struct Storage {
    #[cfg(feature = "native-host")]
    directory: PathBuf,
    #[cfg(feature = "native-host")]
    protected: bool,
}
fn regular(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_file() => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        _ => Err(io::Error::other("Cast storage must be a regular file")),
    }
}
fn read(path: &Path) -> io::Result<Preferences> {
    regular(path)?;
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(LIMIT + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > LIMIT {
        return Err(io::Error::other("Cast preferences too large"));
    }
    let prefs: Preferences = serde_json::from_slice(&bytes)?;
    prefs
        .validate()
        .map_err(|_| io::Error::other("Invalid cast preferences"))?;
    Ok(prefs)
}
impl Storage {
    pub fn load(directory: &Path) -> (Self, Preferences) {
        let path = directory.join("cast-devices.json");
        let (preferences, protected) = match read(&path) {
            Ok(p) => (p, false),
            Err(e) if e.kind() == io::ErrorKind::NotFound => (Preferences::default(), false),
            Err(_) => {
                eprintln!("[cast-storage] preferences unavailable; preserving original file");
                (Preferences::default(), true)
            }
        };
        #[cfg(not(feature = "native-host"))]
        let _ = protected;
        (
            Self {
                #[cfg(feature = "native-host")]
                directory: directory.to_owned(),
                #[cfg(feature = "native-host")]
                protected,
            },
            preferences,
        )
    }

    #[cfg(feature = "native-host")]
    pub fn writable(&self) -> bool {
        !self.protected
    }

    #[cfg(feature = "native-host")]
    pub fn save(&self, preferences: &Preferences) -> io::Result<()> {
        if self.protected {
            return Err(io::Error::other("Original cast preferences protected"));
        }
        preferences
            .validate()
            .map_err(|_| io::Error::other("Invalid cast preferences"))?;
        let path = self.directory.join("cast-devices.json");
        regular(&path)?;
        // Preserve the first valid version before replacement, like native
        // checkpoint backups. Never replace or trust a malformed original.
        if path.exists() {
            read(&path)?;
            let backup = self.directory.join("cast-devices.v1.backup.json");
            regular(&backup)?;
            if !backup.exists() {
                self.publish(&backup, &fs::read(&path)?)?;
            }
        }
        let bytes = serde_json::to_vec(preferences)?;
        if bytes.len() as u64 > LIMIT {
            return Err(io::Error::other("Cast preferences too large"));
        }
        self.publish(&path, &bytes)
    }

    #[cfg(feature = "native-host")]
    fn publish(&self, path: &Path, bytes: &[u8]) -> io::Result<()> {
        let pending = path.with_extension("pending");
        regular(&pending)?;
        let result = (|| {
            let mut options = fs::OpenOptions::new();
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
            }
            let mut file = options
                .write(true)
                .create(true)
                .truncate(true)
                .open(&pending)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            drop(file);
            fs::rename(&pending, path)?;
            // Rename commits the transaction even when directory sync fails.
            if crate::native_host_storage::sync_directory(&self.directory).is_err() {
                eprintln!("[cast-storage] committed; directory sync failed");
            }
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(pending);
        }
        result
    }
}
