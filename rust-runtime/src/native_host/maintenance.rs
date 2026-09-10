//! Remove only native-owned, no-longer-referenced immutable cache generations.
//! No recursive deletion of the cache root and no following directory symlinks.
use super::*;
use std::fs;

fn directories(parent: &Path) -> Vec<PathBuf> {
    if !fs::symlink_metadata(parent).is_ok_and(|m| m.is_dir() && !m.file_type().is_symlink()) {
        return Vec::new();
    }
    fs::read_dir(parent)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_type()
                .is_ok_and(|kind| kind.is_dir() && !kind.is_symlink())
        })
        .map(|entry| entry.path())
        .collect()
}

pub(super) fn collect(root: &Path, include_staging: bool) -> std::io::Result<usize> {
    let root = root.canonicalize()?;
    let retired = root.join(".retired");
    fs::create_dir_all(&retired)?;
    if fs::symlink_metadata(&retired)?.file_type().is_symlink()
        || retired.canonicalize()?.parent() != Some(root.as_path())
    {
        return Err(std::io::Error::other("unsafe retired cache directory"));
    }
    let mut count = 0;
    for name in [".retired", "artifacts", ".staging"] {
        if name == ".staging" && !include_staging {
            continue;
        }
        let parent = root.join(name);
        for incarnation in directories(&parent) {
            for artifact in directories(&incarnation) {
                let Some(i) = incarnation.file_name().and_then(|v| v.to_str()) else {
                    continue;
                };
                let Some(a) = artifact.file_name().and_then(|v| v.to_str()) else {
                    continue;
                };
                let destination = retired.join(i).join(a);
                let moved = with_app(|app| {
                    if !app.native_can_retire_artifact(i, a) {
                        return Ok(false);
                    }
                    // Pin admission and this rename are serialized. Delete outside
                    // the lock; the old HTTP path can no longer be opened.
                    if name != ".retired" {
                        fs::create_dir_all(retired.join(i)).map_err(storage_error)?;
                        if fs::symlink_metadata(retired.join(i))
                            .map_err(storage_error)?
                            .file_type()
                            .is_symlink()
                            || artifact.canonicalize().map_err(storage_error)? != artifact
                            || !artifact.starts_with(&root)
                        {
                            return Err(ApiError::invalid("缓存路径无效"));
                        }
                        fs::rename(&artifact, &destination).map_err(storage_error)?;
                    }
                    Ok(true)
                })
                .map_err(|_| std::io::Error::other("native cache retirement failed"))?;
                if moved {
                    // Exact checked two-identity descendant, never the root.
                    fs::remove_dir_all(&destination)?;
                    let _ = fs::remove_dir(retired.join(i));
                    count += 1;
                }
            }
            let _ = fs::remove_dir(&incarnation); // Only succeeds when empty.
        }
    }
    Ok(count)
}

fn storage_error(_: std::io::Error) -> ApiError {
    ApiError::new(503, "cache_storage", "无法回收旧媒体缓存")
}

pub(super) fn trim_log(directory: &Path) {
    // AppendLog opens per event. Truncating only this bounded diagnostic file
    // never touches queue checkpoints, credentials or active media artifacts.
    let path = directory.join("logs/native-cache.log");
    if fs::symlink_metadata(&path)
        .is_ok_and(|m| m.is_file() && !m.file_type().is_symlink() && m.len() > 1024 * 1024)
    {
        let _ = fs::OpenOptions::new().write(true).truncate(true).open(path);
    }
}
