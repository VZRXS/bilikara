//! Remove only native-owned, no-longer-referenced immutable cache generations.
//! No recursive deletion of the cache root and no following directory symlinks.
use super::*;

pub(super) fn collect(root: &Path, include_staging: bool) -> std::io::Result<usize> {
    if include_staging {
        with_app(|app| {
            app.open_artifact_lifetime(root).map_err(storage_error)?;
            Ok(())
        })
        .map_err(|_| std::io::Error::other("native cache recovery failed"))?;
        let mut collected = 0;
        for area in [".retired", "artifacts", ".staging"] {
            crate::app_state::artifact_lifetime::recover_native_artifacts(root, area)?;
            collected += crate::app_state::artifact_lifetime::collect_artifacts(None)?;
        }
        return Ok(collected);
    }
    crate::app_state::artifact_lifetime::collect_artifacts(None)
}

fn storage_error(_: std::io::Error) -> ApiError {
    ApiError::new(503, "cache_storage", "无法回收旧媒体缓存")
}
