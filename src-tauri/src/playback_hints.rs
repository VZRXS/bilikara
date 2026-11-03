//! Device-local UI learning receipt. No application/media state or arbitrary key.
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

pub(crate) const FILENAME: &str = "playback-restart-hint-v1.json";
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

pub(crate) fn authorize_entry_path(path: &str) -> Result<(), String> {
    if matches!(path, "/" | "/index.html") {
        Ok(())
    } else {
        Err("UI preferences are available only in the main Host page".into())
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    schema_version: u8,
    seen: bool,
}

fn read(path: &Path) -> Result<bool, String> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.to_string()),
    };
    let mut encoded = Vec::new();
    file.take(257)
        .read_to_end(&mut encoded)
        .map_err(|e| e.to_string())?;
    if encoded.len() > 256 {
        return Err("UI receipt exceeds its size limit".into());
    }
    let receipt: Receipt = serde_json::from_slice(&encoded).map_err(|e| e.to_string())?;
    if receipt.schema_version != 1 {
        return Err("Unsupported UI receipt".into());
    }
    Ok(receipt.seen)
}

fn mark(path: &Path) -> Result<(), String> {
    if read(path)? {
        return Ok(());
    }
    let parent = path.parent().ok_or("UI receipt directory unavailable")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temporary = parent.join(format!(
        ".{FILENAME}.{}.{}.tmp",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(br#"{"schema_version":1,"seen":true}"#)?;
        file.sync_all()?;
        // Only false -> true exists; a concurrent successful receipt is identical.
        match fs::rename(&temporary, path) {
            Ok(()) => Ok(()),
            Err(_) if read(path).unwrap_or(false) => Ok(()),
            Err(error) => Err(error),
        }
    })();
    let _ = fs::remove_file(&temporary);
    result.map_err(|e: std::io::Error| e.to_string())
}

#[tauri::command]
pub(crate) fn get_playback_restart_hint_seen(window: tauri::WebviewWindow) -> Result<bool, String> {
    read(&crate::window_lifecycle::playback_hint_path(&window)?)
}

#[tauri::command]
pub(crate) fn mark_playback_restart_hint_seen(window: tauri::WebviewWindow) -> Result<(), String> {
    mark(&crate::window_lifecycle::playback_hint_path(&window)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hint_preferences_reject_remote_audience_and_encoded_paths() {
        for path in ["/", "/index.html"] {
            assert!(authorize_entry_path(path).is_ok());
        }
        for path in [
            "/remote",
            "/remote.html",
            "/controller.html",
            "/audience",
            "/%69ndex.html",
            "/index.html/",
            "",
        ] {
            assert!(authorize_entry_path(path).is_err());
        }
    }
    #[test]
    fn playback_hint_persists_on_disk_and_rejects_invalid_receipts() {
        let root = std::env::temp_dir().join(format!(
            "bilikara-ui-hint-{}-{}",
            std::process::id(),
            TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        let path = root.join(FILENAME);
        assert!(!read(&path).unwrap());
        mark(&path).unwrap();
        assert!(read(&path).unwrap());
        mark(&path).unwrap();
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        for invalid in [
            br#"{"schema_version":2,"seen":true}"#.as_slice(),
            br#"{"schema_version":1,"seen":true,"key":"arbitrary"}"#.as_slice(),
            &[b' '; 257],
        ] {
            fs::write(&path, invalid).unwrap();
            assert!(read(&path).is_err());
            assert!(mark(&path).is_err());
            assert_eq!(fs::read(&path).unwrap(), invalid);
        }
        fs::remove_dir_all(root).unwrap();
    }
}
