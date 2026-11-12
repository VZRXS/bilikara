use super::*;

#[derive(Clone, PartialEq, Eq, Hash)]
pub(super) struct MediaKey {
    video: String,
    audio: String,
}

impl MediaKey {
    pub(super) fn from_ready(item: &PlaylistItem) -> Result<Option<Self>, ApiError> {
        if item.cache_status != "ready" {
            return Ok(None);
        }
        let audio = item
            .audio_variants
            .iter()
            .find(|v| v["id"].as_str() == Some(&item.selected_audio_variant_id))
            .and_then(|v| v["audio_url"].as_str())
            .ok_or_else(|| {
                ApiError::new(409, "cast_media_missing", "当前歌曲没有可播放的缓存音轨")
            })?;
        Ok(Some(Self {
            video: item.video_media_url.clone(),
            audio: audio.to_owned(),
        }))
    }
}

struct MediaLease(String);
impl Drop for MediaLease {
    fn drop(&mut self) {
        let _ = with_app(|app| {
            app.native_unpin_media(&self.0);
            Ok(())
        });
    }
}

// load() is not a decoder-retirement fence. Give Show stable session-owned
// names instead of retaining an unbounded number of AppState reader handles.
// Published artifacts are immutable: a same-volume hard link owns their bytes
// even after cache GC removes the original name. A copy handles other volumes.
// Keep every program's names until destroy has joined all native readers.
pub(super) struct SessionFiles {
    root: PathBuf,
    sequence: u64,
    paths: std::collections::HashMap<MediaKey, (PathBuf, PathBuf)>,
}
impl SessionFiles {
    pub(super) fn new(context: &HostContext) -> Result<Self, ApiError> {
        let parent = context.directory.join("show-cast-private");
        if parent.exists()
            && !std::fs::symlink_metadata(&parent)
                .is_ok_and(|m| m.is_dir() && !m.file_type().is_symlink())
        {
            return Err(ApiError::new(
                500,
                "cast_storage",
                "投屏临时目录不是普通目录",
            ));
        }
        std::fs::create_dir_all(&parent)
            .map_err(|e| ApiError::new(500, "cast_storage", e.to_string()))?;
        let parent = parent
            .canonicalize()
            .map_err(|e| ApiError::new(500, "cast_storage", e.to_string()))?;
        if !parent.starts_with(
            context
                .directory
                .canonicalize()
                .map_err(|e| ApiError::new(500, "cast_storage", e.to_string()))?,
        ) {
            return Err(ApiError::new(500, "cast_storage", "投屏临时目录越界"));
        }
        // NativeHost owns the exclusive data-root lock, and no prior Cast
        // reader is alive. Recover only precisely named real child directories.
        for entry in std::fs::read_dir(&parent)
            .map_err(|e| ApiError::new(500, "cast_storage", e.to_string()))?
            .take(256)
        {
            let entry = entry.map_err(|e| ApiError::new(500, "cast_storage", e.to_string()))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.strip_prefix("session-").is_some_and(|suffix| {
                suffix.len() == 43
                    && suffix
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            }) && entry
                .file_type()
                .is_ok_and(|kind| kind.is_dir() && !kind.is_symlink())
            {
                let child = entry
                    .path()
                    .canonicalize()
                    .map_err(|e| ApiError::new(500, "cast_storage", e.to_string()))?;
                if child.parent() != Some(parent.as_path()) {
                    return Err(ApiError::new(500, "cast_storage", "投屏临时文件越界"));
                }
                std::fs::remove_dir_all(child)
                    .map_err(|e| ApiError::new(500, "cast_storage", e.to_string()))?;
            }
        }
        let root = parent.join(format!("session-{}", token()?));
        std::fs::create_dir(&root)
            .map_err(|e| ApiError::new(500, "cast_storage", e.to_string()))?;
        Ok(Self {
            root,
            sequence: 0,
            paths: Default::default(),
        })
    }
    pub(super) fn paths(
        &mut self,
        context: &HostContext,
        key: &MediaKey,
    ) -> Result<(PathBuf, PathBuf), ApiError> {
        if let Some(paths) = self.paths.get(key) {
            return Ok(paths.clone());
        }
        let (source_video, _video_lease) = pin_path(context, &key.video)?;
        let (source_audio, _audio_lease) = pin_path(context, &key.audio)?;
        self.sequence += 1;
        let directory = self.root.join(self.sequence.to_string());
        std::fs::create_dir(&directory)
            .map_err(|e| ApiError::new(500, "cast_storage", e.to_string()))?;
        let video = directory.join("video.mp4");
        let audio = directory
            .join("audio")
            .with_extension(source_audio.extension().unwrap_or_default());
        for (source, destination) in [(&source_video, &video), (&source_audio, &audio)] {
            if std::fs::hard_link(source, destination).is_err() {
                std::fs::copy(source, destination)
                    .map_err(|e| ApiError::new(500, "cast_storage", e.to_string()))?;
            }
        }
        self.paths
            .insert(key.clone(), (video.clone(), audio.clone()));
        Ok((video, audio))
    }
}
impl Drop for SessionFiles {
    fn drop(&mut self) {
        // root is exclusively created here, never an HTTP/client-supplied path.
        if let Err(error) = std::fs::remove_dir_all(&self.root) {
            eprintln!("Show cast private media cleanup failed: {error}");
        }
    }
}

fn pin_path(context: &HostContext, route: &str) -> Result<(PathBuf, MediaLease), ApiError> {
    let relative = route
        .strip_prefix("/media/")
        .filter(|value| value.starts_with("artifacts/"))
        .filter(|value| {
            value.split('/').all(|part| {
                !part.is_empty()
                    && part != "."
                    && part != ".."
                    && !part.contains(['\\', ':', '\0', '%'])
            })
        })
        .ok_or_else(|| ApiError::invalid("投屏媒体路径无效"))?;
    let handle = with_app(|app| app.native_pin_media(route))?;
    let lease = MediaLease(handle);
    let root = context
        .cache_root
        .canonicalize()
        .map_err(|_| ApiError::invalid("缓存目录不可用"))?;
    let path = root
        .join(relative)
        .canonicalize()
        .map_err(|_| ApiError::invalid("投屏媒体不存在"))?;
    if !path.starts_with(&root) || !path.is_file() {
        return Err(ApiError::invalid("投屏媒体不在缓存目录中"));
    }
    Ok((path, lease))
}
