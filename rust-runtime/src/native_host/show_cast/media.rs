use super::*;

pub(super) const ORIGINAL_PENDING: &str = "cast_original_pending";

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct AudioTrack {
    pub(super) id: String,
    route: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct MediaKey {
    pub(super) video: String,
    pub(super) first: AudioTrack,
    pub(super) second: Option<AudioTrack>,
}

impl MediaKey {
    pub(super) fn from_ready(item: &PlaylistItem) -> Result<Option<Self>, ApiError> {
        if item.cache_status != "ready" {
            return Ok(None);
        }
        let tracks = item.audio_variants.iter().filter_map(|variant| {
            let id = variant.get("id")?.as_str()?;
            let route = variant
                .get("audio_url")?
                .as_str()
                .filter(|route| !route.is_empty())?;
            let page = variant
                .get("page")
                .and_then(Value::as_u64)
                .or_else(|| id.strip_prefix('p')?.split('_').next()?.parse().ok())
                .filter(|page| *page > 0)
                .unwrap_or(u64::MAX);
            Some((page, id, route))
        });
        let track = |(_, id, route): (_, &str, &str)| AudioTrack {
            id: id.to_owned(),
            route: route.to_owned(),
        };
        let first = tracks
            .clone()
            .find(|&(_, id, _)| id == item.selected_audio_variant_id)
            .map(track)
            .ok_or_else(|| {
                ApiError::new(409, "cast_media_missing", "当前歌曲没有可播放的缓存音轨")
            })?;
        let second = tracks
            .filter(|&(_, id, _)| id != first.id)
            .min_by_key(|&(page, _, _)| page)
            .map(track);
        Ok(Some(Self {
            video: item.video_media_url.clone(),
            first,
            second,
        }))
    }

    pub(super) fn slot_for(&self, track: &AudioTrack) -> Option<AudioSlot> {
        if self.first == *track {
            Some(AudioSlot::First)
        } else if self.second.as_ref() == Some(track) {
            Some(AudioSlot::Second)
        } else {
            None
        }
    }

    pub(super) fn track(&self, slot: AudioSlot) -> &AudioTrack {
        match slot {
            AudioSlot::First => &self.first,
            AudioSlot::Second => self.second.as_ref().expect("loaded second audio slot"),
        }
    }
}

pub(super) struct MediaPaths {
    pub(super) video: PathBuf,
    pub(super) first: PathBuf,
    pub(super) second: Option<PathBuf>,
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
    paths: std::collections::HashMap<String, PathBuf>,
    audio_durations: std::collections::HashMap<String, Option<f64>>,
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
            audio_durations: Default::default(),
        })
    }
    pub(super) fn paths(
        &mut self,
        context: &HostContext,
        key: &MediaKey,
    ) -> Result<MediaPaths, ApiError> {
        let video = self.path(context, &key.video)?;
        let first = self.path(context, &key.first.route)?;
        let second = key
            .second
            .as_ref()
            .and_then(|track| match self.path(context, &track.route) {
                Ok(path) => Some(path),
                Err(error) => {
                    eprintln!("[show-cast] unavailable standby audio: {error}");
                    None
                }
            });
        Ok(MediaPaths {
            video,
            first,
            second,
        })
    }

    pub(super) fn audio_duration(&mut self, track: &AudioTrack) -> Option<f64> {
        *self
            .audio_durations
            .entry(track.route.clone())
            .or_insert_with(|| {
                let path = self.paths.get(&track.route)?;
                crate::probe_media(&crate::MediaPathRequest {
                    schema_version: 1,
                    source: path.clone(),
                    expected_kind: crate::ExpectedMediaKind::Audio,
                })
                .ok()
                .map(|probe| probe.duration_seconds)
                .filter(|duration| duration.is_finite() && *duration > 0.0)
            })
    }

    fn path(&mut self, context: &HostContext, route: &str) -> Result<PathBuf, ApiError> {
        if let Some(path) = self.paths.get(route) {
            return Ok(path.clone());
        }
        let (source, _lease) = pin_path(context, route)?;
        self.sequence += 1;
        let destination = self
            .root
            .join(self.sequence.to_string())
            .with_extension(source.extension().unwrap_or_default());
        if std::fs::hard_link(&source, &destination).is_err() {
            std::fs::copy(source, &destination)
                .map_err(|e| ApiError::new(500, "cast_storage", e.to_string()))?;
        }
        self.paths.insert(route.to_owned(), destination.clone());
        Ok(destination)
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
    let original = crate::cache_runtime::resolve_show_input(&path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            ApiError::new(409, ORIGINAL_PENDING, "等待缓存原始投屏媒体")
        } else {
            ApiError::new(500, "cast_storage", "无法读取原始投屏媒体")
        }
    })?;
    Ok((original, lease))
}
