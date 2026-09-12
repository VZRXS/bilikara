//! Native Host preferences live in AppState. Persist a validated replacement
//! before publishing it; cache jobs capture a snapshot, never a mutable setting.
use super::*;
use bilikara_rust::{QualityPolicyRequest, decide_quality_policy};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub(crate) struct CachePolicy {
    pub max_cache_items: usize,
    pub video_quality: String,
    pub audio_hires: bool,
    pub reset_offset_on_next: bool,
}

impl Default for CachePolicy {
    fn default() -> Self {
        Self {
            max_cache_items: 3,
            video_quality: "720P 高清".into(),
            audio_hires: false,
            reset_offset_on_next: false,
        }
    }
}

impl CachePolicy {
    fn qualities() -> Vec<String> {
        decide_quality_policy(&QualityPolicyRequest {
            raw_quality: "1080P 高帧率".into(),
            raw_cap: "1080P 高帧率".into(),
            choice_index: None,
        })
        .bbdown_quality_order
        .iter()
        .map(|quality| quality.label().to_owned())
        .collect()
    }

    fn validate(&self) -> Result<(), ApiError> {
        if !(1..=5).contains(&self.max_cache_items)
            || !Self::qualities().contains(&self.video_quality)
        {
            return Err(ApiError::invalid("请选择 1–5 首缓存及支持的视频清晰度"));
        }
        Ok(())
    }

    pub(crate) fn snapshot(&self) -> Value {
        let mut value = json!(self);
        value["enabled"] = json!(true);
        value["download_source"] = json!("native");
        value["download_source_choices"] = json!([{"value":"native","label":"Rust Native"}]);
        value["avc_quality_cap"] = json!(&self.video_quality);
        value["choices"] = json!([1, 2, 3, 4, 5]);
        value["video_quality_choices"] = json!(Self::qualities());
        value
    }

    fn updated(&self, body: &Value) -> Result<Self, ApiError> {
        let fields = body
            .as_object()
            .filter(|v| !v.is_empty())
            .ok_or_else(|| ApiError::invalid("没有可更新的缓存策略"))?;
        let mut next = json!(self);
        for (key, value) in fields {
            if key == "download_source" && value == "native" {
                continue;
            }
            if next.get(key).is_none() {
                return Err(ApiError::invalid(
                    "Android 仅支持原生下载器和列出的缓存设置",
                ));
            }
            next[key] = value.clone();
        }
        let next: Self =
            serde_json::from_value(next).map_err(|_| ApiError::invalid("缓存设置格式无效"))?;
        next.validate()?;
        Ok(next)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum UiLanguage {
    Zh,
    En,
    Ja,
}

#[derive(Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Saved {
    schema_version: u32,
    pub cache: CachePolicy,
    #[serde(default)]
    pub language: Option<UiLanguage>,
}

fn storage_error() -> ApiError {
    ApiError::new(503, "preferences_storage", "无法读写应用设置；原设置已保留")
}

fn regular(path: &Path) -> Result<(), ApiError> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_file() => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        _ => Err(storage_error()),
    }
}

pub(super) fn load(directory: &Path) -> Result<Saved, ApiError> {
    let path = directory.join("native-preferences.json");
    regular(&path)?;
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Saved {
                schema_version: 1,
                ..Saved::default()
            });
        }
        Err(_) => return Err(storage_error()),
    };
    let mut bytes = Vec::new();
    file.take(4097)
        .read_to_end(&mut bytes)
        .map_err(|_| storage_error())?;
    if bytes.len() > 4096 {
        return Err(storage_error());
    }
    let saved: Saved = serde_json::from_slice(&bytes).map_err(|_| storage_error())?;
    if saved.schema_version != 1 {
        return Err(storage_error());
    }
    saved.cache.validate().map_err(|_| storage_error())?;
    Ok(saved)
}

fn save(
    directory: &Path,
    cache: &CachePolicy,
    language: Option<UiLanguage>,
) -> Result<(), ApiError> {
    let destination = directory.join("native-preferences.json");
    let pending = directory.join("native-preferences.pending");
    regular(&destination)?;
    regular(&pending)?;
    let mut options = fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options.open(&pending).map_err(|_| storage_error())?;
    let bytes = serde_json::to_vec(&Saved {
        schema_version: 1,
        cache: cache.clone(),
        language,
    })
    .map_err(|_| storage_error())?;
    file.write_all(&bytes)
        .and_then(|()| file.sync_all())
        .map_err(|_| storage_error())?;
    drop(file);
    fs::rename(pending, destination).map_err(|_| storage_error())
}

pub(super) fn update(
    context: &HostContext,
    identity: &Identity,
    body: &Value,
) -> Result<Value, ApiError> {
    with_app(|app| {
        app.native_authorize(identity, true)?;
        let next = app.native().cache_policy.updated(body)?;
        if next != app.native().cache_policy {
            save(&context.directory, &next, app.native().ui_language)?;
            app.native().cache_policy = next;
            app.native().revision += 1;
        }
        app.native_snapshot(true)
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LanguageChange {
    language: UiLanguage,
    #[serde(default)]
    initialize_only: bool,
}

pub(super) fn language(
    context: &HostContext,
    identity: &Identity,
    body: Option<&Value>,
) -> Result<Value, ApiError> {
    let change = body
        .map(|value| {
            serde_json::from_value::<LanguageChange>(value.clone())
                .map_err(|_| ApiError::invalid("请选择 zh、en 或 ja"))
        })
        .transpose()?;
    with_app(|app| {
        app.native_authorize(identity, true)?;
        let session = app.native();
        if let Some(change) = change {
            let next = if change.initialize_only {
                session.ui_language.or(Some(change.language))
            } else {
                Some(change.language)
            };
            if next != session.ui_language {
                // First-run selection and manual changes survive listener-port
                // changes. Serialize with cache writes so neither loses fields.
                save(&context.directory, &session.cache_policy, next)?;
                session.ui_language = next;
                session.revision += 1;
            }
        }
        Ok(json!({"language":session.ui_language}))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_entire_patch_and_exposes_only_native_choices() {
        let original = CachePolicy::default();
        for patch in [
            json!({"max_cache_items":0}),
            json!({"max_cache_items":6}),
            json!({"max_cache_items":true}),
            json!({"video_quality":"8K"}),
            json!({"audio_hires":"true"}),
            json!({"download_source":"bbdown"}),
            json!({"max_cache_items":5,"unknown":1}),
        ] {
            assert!(original.updated(&patch).is_err(), "{patch}");
        }
        let next = original.updated(&json!({"video_quality":"1080P 高清","max_cache_items":5,"audio_hires":true,"reset_offset_on_next":true})).unwrap();
        assert_eq!(next.max_cache_items, 5);
        assert_eq!(next.snapshot()["avc_quality_cap"], "1080P 高清");
        assert_eq!(
            next.snapshot()["download_source_choices"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(original.max_cache_items, 3);
    }
    #[test]
    fn roundtrip_replacement_and_corrupt_preferences_fail_closed() {
        let directory = std::env::temp_dir().join(format!(
            "bilikara-preferences-{}-{}",
            std::process::id(),
            now()
        ));
        fs::create_dir_all(&directory).unwrap();
        assert_eq!(load(&directory).unwrap().cache, CachePolicy::default());
        assert_eq!(load(&directory).unwrap().language, None);
        let next = CachePolicy::default()
            .updated(&json!({"max_cache_items":4}))
            .unwrap();
        save(&directory, &CachePolicy::default(), Some(UiLanguage::Ja)).unwrap();
        save(&directory, &next, Some(UiLanguage::Ja)).unwrap();
        assert_eq!(load(&directory).unwrap().cache, next);
        assert_eq!(load(&directory).unwrap().language, Some(UiLanguage::Ja));
        // Existing Alpha preferences have no language field; retain their cache.
        fs::write(
            directory.join("native-preferences.json"),
            json!({"schema_version":1,"cache":next}).to_string(),
        )
        .unwrap();
        assert_eq!(load(&directory).unwrap().language, None);
        assert_eq!(load(&directory).unwrap().cache, next);
        fs::write(directory.join("native-preferences.json"), b"invalid").unwrap();
        assert!(load(&directory).is_err());
        assert_eq!(
            fs::read(directory.join("native-preferences.json")).unwrap(),
            b"invalid"
        );
        fs::remove_dir_all(directory).unwrap();
    }
}
