//! Process-local negative cache for trusted companion loading, not media errors.
use super::ProbeError;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::SystemTime,
};

#[derive(Debug, Clone, PartialEq, Eq)]
enum FileIdentity {
    Unavailable(std::io::ErrorKind),
    Present {
        regular: bool,
        bytes: u64,
        modified: Option<SystemTime>,
        created: Option<SystemTime>,
    },
}

impl FileIdentity {
    fn read(path: &Path) -> Self {
        match std::fs::metadata(path) {
            Ok(metadata) => Self::Present {
                regular: metadata.is_file(),
                bytes: metadata.len(),
                modified: metadata.modified().ok(),
                created: metadata.created().ok(),
            },
            Err(error) => Self::Unavailable(error.kind()),
        }
    }
}

#[derive(Default)]
struct Failures(HashMap<PathBuf, (FileIdentity, ProbeError)>);

impl Failures {
    fn load<T>(
        &mut self,
        path: &Path,
        attempt: impl FnOnce() -> Result<T, ProbeError>,
    ) -> Result<T, ProbeError> {
        let identity = FileIdentity::read(path);
        if let Some((previous, error)) = self.0.get(path)
            && previous == &identity
        {
            return Err(error.clone());
        }
        self.0.remove(path);
        let result = attempt();
        if let Err(error) = &result {
            self.0.insert(path.to_owned(), (identity, error.clone()));
        }
        result
    }
}

pub(super) fn load<T>(
    path: &Path,
    attempt: impl FnOnce() -> Result<T, ProbeError>,
) -> Result<T, ProbeError> {
    static FAILURES: OnceLock<Mutex<Failures>> = OnceLock::new();
    // Serialize negotiation so concurrent callers cannot retry the same failure.
    // Successful handles retain their existing caller-owned lifetime.
    FAILURES
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .load(path, attempt)
}

/// De-duplicate an unavailable event across startup and subsequent worker wakes.
#[derive(Default)]
#[cfg(any(feature = "native-host", test))]
pub(crate) struct FailureNotices {
    last: Option<Option<(PathBuf, FileIdentity)>>,
}

#[cfg(any(feature = "native-host", test))]
impl FailureNotices {
    pub(crate) fn changed(&mut self, path: Option<&Path>) -> bool {
        let current = path.map(|path| (path.to_owned(), FileIdentity::read(path)));
        if self.last.as_ref() == Some(&current) {
            return false;
        }
        self.last = Some(current);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failure_is_reused_until_file_appears_changes_or_disappears() {
        let mut nonce = [0u8; 8];
        getrandom::fill(&mut nonce).unwrap();
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../.tmp")
            .join(format!("load-cache-{}", u64::from_le_bytes(nonce)));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("companion");
        let mut failures = Failures::default();
        let mut notices = FailureNotices::default();
        let expected = ProbeError::Unavailable("fixture load failure".into());
        for contents in [None, Some("invalid"), Some("different invalid bytes"), None] {
            if let Some(contents) = contents {
                std::fs::write(&path, contents).unwrap();
            } else if path.exists() {
                std::fs::remove_file(&path).unwrap();
            }
            assert!(notices.changed(Some(&path)));
            assert_eq!(
                failures.load::<()>(&path, || Err(expected.clone())),
                Err(expected.clone())
            );
            for _ in 0..3 {
                assert!(!notices.changed(Some(&path)));
                assert_eq!(
                    failures.load::<()>(&path, || panic!("cached failure must not reload")),
                    Err(expected.clone())
                );
            }
        }
        std::fs::write(&path, "repaired fixture").unwrap();
        assert!(failures.load(&path, || Ok(7)).is_ok());
        assert_eq!(failures.load(&path, || Ok(8)).unwrap(), 8);
        assert!(notices.changed(None));
        assert!(!notices.changed(None));
        std::fs::remove_dir_all(root).unwrap();
    }
}
