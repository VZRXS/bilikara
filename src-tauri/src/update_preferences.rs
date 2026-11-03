//! Device-local update choices, independent of the Host's ephemeral HTTP origin.
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

pub(crate) const FILENAME: &str = "update-preferences-v1.json";
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Preferences {
    pub automatic: bool,
    pub preview: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Stored {
    schema_version: u8,
    preferences: Preferences,
}

pub(crate) fn load(path: &Path) -> Result<Option<Preferences>, String> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let mut bytes = Vec::new();
    file.take(257)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > 256 {
        return Err("Update preferences exceed their size limit".into());
    }
    let stored: Stored = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if stored.schema_version != 1 {
        return Err("Unsupported update preferences".into());
    }
    Ok(Some(stored.preferences))
}

pub(crate) fn save(path: &Path, preferences: Preferences) -> Result<Preferences, String> {
    // Do not silently overwrite corrupt or future-version storage.
    load(path)?;
    let parent = path
        .parent()
        .ok_or("Update preferences directory unavailable")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temporary = parent.join(format!(
        ".{FILENAME}.{}.{}.tmp",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let bytes = serde_json::to_vec(&Stored {
            schema_version: 1,
            preferences,
        })?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)?;
        Ok(preferences)
    })();
    let _ = fs::remove_file(temporary);
    result.map_err(|e: std::io::Error| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn first_launch_and_restarts_preserve_both_choices_and_reject_bad_storage() {
        let home = std::env::temp_dir().join(format!(
            "bilikara-update-preferences-{}-{}",
            std::process::id(),
            TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let path = home.join(FILENAME);
        assert_eq!(load(&path).unwrap(), None);
        for automatic in [true, false] {
            for preview in [false, true] {
                let preferences = Preferences { automatic, preview };
                assert_eq!(save(&path, preferences).unwrap(), preferences);
                assert_eq!(load(&path).unwrap(), Some(preferences));
                assert_eq!(fs::read_dir(&home).unwrap().count(), 1);
            }
        }
        for bytes in [br#"{"schema_version":2,"preferences":{"automatic":true,"preview":false}}"#.as_slice(), br#"{"schema_version":1,"preferences":{"automatic":"false","preview":false}}"#.as_slice(), br#"{"schema_version":1,"preferences":{"automatic":true,"preview":false,"endpoint":"untrusted"}}"#.as_slice(), &[b' ';257]] {
            fs::write(&path, bytes).unwrap();
            assert!(load(&path).is_err());
            assert!(save(&path, Preferences {automatic:true,preview:false}).is_err());
            assert_eq!(fs::read(&path).unwrap(), bytes);
        }
        fs::remove_dir_all(home).unwrap();
    }
}
