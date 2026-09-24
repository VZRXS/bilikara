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
    pub download_source: String,
    #[serde(skip_serializing_if = "serde_json::Map::is_empty")]
    pub retained_settings: serde_json::Map<String, Value>,
    pub video_quality: String,
    pub audio_hires: bool,
    pub reset_offset_on_next: bool,
}

impl Default for CachePolicy {
    fn default() -> Self {
        Self {
            max_cache_items: 3,
            download_source: "native".into(),
            retained_settings: serde_json::Map::new(),
            video_quality: "1080P 高帧率".into(),
            audio_hires: true,
            reset_offset_on_next: true,
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

    pub(crate) fn available(&self) -> bool {
        self.download_source == "native" && self.validate().is_ok()
    }

    pub(crate) fn available_with(&self, bbdown: bool, aria2: bool) -> bool {
        self.available()
            || ((bbdown && self.download_source == "bbdown"
                || aria2 && self.download_source == "downkyi")
                && self.validate().is_ok())
    }

    pub(crate) fn snapshot(&self) -> Value {
        self.snapshot_with(false, false)
    }

    pub(crate) fn snapshot_with(&self, bbdown: bool, aria2: bool) -> Value {
        let mut value = json!(self);
        value.as_object_mut().unwrap().remove("retained_settings");
        value["enabled"] = json!(self.available_with(bbdown, aria2));
        value["unavailable_reason"] = json!(if self.available_with(bbdown, aria2) {
            ""
        } else {
            "Imported download source or cache preference is unavailable in Desktop Rust; select supported Native settings explicitly"
        });
        value["download_source_choices"] = json!([{"value":"native","label":"Rust Native"}]);
        if bbdown {
            value["download_source_choices"]
                .as_array_mut()
                .unwrap()
                .push(json!({"value":"bbdown","label":"BBDown"}));
        }
        if aria2 {
            value["download_source_choices"]
                .as_array_mut()
                .unwrap()
                .push(json!({"value":"downkyi","label":"DownKyi (aria2c)"}));
        }
        if self.download_source != "native"
            && !(bbdown && self.download_source == "bbdown")
            && !(aria2 && self.download_source == "downkyi")
        {
            value["download_source_choices"].as_array_mut().unwrap().push(json!({"value":self.download_source,"label":format!("{} (unavailable in Desktop Rust)", self.download_source)}));
        }
        if self.download_source == "bbdown" && !bbdown {
            value["unavailable_reason"] = json!(
                "BBDown unavailable: configure an installed compatible executable with BB_DOWN_PATH and restart Host, or select Native"
            );
        }
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
            if key == "download_source"
                && (value == "native" || value == "bbdown" || value == "downkyi")
            {
                next[key] = value.clone();
                continue;
            }
            if !matches!(
                key.as_str(),
                "max_cache_items" | "video_quality" | "audio_hires" | "reset_offset_on_next"
            ) {
                return Err(ApiError::invalid(
                    "此 Host 仅支持原生下载器和列出的缓存设置",
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

/// Transient Host decoder facts; never serialized into preferences or imported.
/// Quality interpretation remains in the shared Rust quality service.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct PlayerMedia {
    pub avc_supported: Option<bool>,
    pub avc_quality_cap: String,
    pub details: Value,
}

impl PlayerMedia {
    pub(crate) fn reported(body: &Value) -> Result<Self, ApiError> {
        let hevc = body["hevc_supported"]
            .as_bool()
            .ok_or_else(|| ApiError::invalid("hevc_supported must be a boolean"))?;
        let avc = body["avc_supported"].as_bool().unwrap_or(false);
        let quality = decide_quality_policy(&QualityPolicyRequest {
            raw_quality: body["max_avc_quality"].as_str().unwrap_or_default().into(),
            raw_cap: String::new(),
            choice_index: body["max_avc_quality_index"].as_i64(),
        });
        let cap = quality
            .indexed_quality
            .or(quality.optional_quality)
            .unwrap_or(bilikara_rust::VideoQuality::Q360)
            .label()
            .to_owned();
        let mut details = json!({"hevc_supported":hevc,"avc_supported":avc,
            "force_avc":!hevc,"max_avc_quality":cap,
            "max_avc_quality_index":CachePolicy::qualities().iter().position(|v| v==&cap)});
        // Diagnostics are bounded, do not influence the runtime's codec contract.
        for (key, limit) in [("user_agent", 500), ("platform", 100)] {
            details[key] = json!(
                body[key]
                    .as_str()
                    .unwrap_or_default()
                    .chars()
                    .take(limit)
                    .collect::<String>()
            );
        }
        let mut types = serde_json::Map::new();
        if let Some(values) = body["can_play_type"].as_object() {
            for (key, value) in values.iter().take(32) {
                types.insert(
                    key.chars().take(120).collect(),
                    json!(
                        value
                            .as_str()
                            .unwrap_or_default()
                            .chars()
                            .take(20)
                            .collect::<String>()
                    ),
                );
            }
        }
        details["can_play_type"] = json!(types);
        details["avc_levels"] = json!(body["avc_levels"].as_array().into_iter().flatten().take(20)
            .filter(|v|v.is_object()).map(|v|json!({
                "name":v["name"].as_str().unwrap_or_default().chars().take(50).collect::<String>(),
                "codec":v["codec"].as_str().unwrap_or_default().chars().take(120).collect::<String>(),
                "can_play_type":v["can_play_type"].as_str().unwrap_or_default().chars().take(20).collect::<String>(),
                "max_avc_quality_index":v["max_avc_quality_index"].as_i64()
            })).collect::<Vec<_>>());
        Ok(Self {
            avc_supported: Some(avc),
            avc_quality_cap: cap,
            details,
        })
    }

    pub(crate) fn usable(&self) -> bool {
        self.avc_supported != Some(false)
    }

    pub(crate) fn snapshot(&self) -> Value {
        if self.details.is_null() {
            json!({})
        } else {
            self.details.clone()
        }
    }
}

/// Effective media inputs, excluding count/reset/UI facts that cannot change an
/// artifact. The existing cache runtime remains AVC-only even on an HEVC player.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MediaSelection {
    pub quality: String,
    pub avc_cap: String,
    pub audio_hires: bool,
    pub source: String,
    pub force_avc: bool,
}

impl MediaSelection {
    pub(crate) fn new(policy: &CachePolicy, player: &PlayerMedia, desktop: bool) -> Self {
        let force_avc =
            policy.download_source != "downkyi" || player.details["hevc_supported"] == false;
        let cap = if !force_avc {
            ""
        } else if desktop {
            &player.avc_quality_cap
        } else {
            &policy.video_quality
        };
        let decision = decide_quality_policy(&QualityPolicyRequest {
            raw_quality: policy.video_quality.clone(),
            raw_cap: cap.to_owned(),
            choice_index: None,
        });
        Self {
            quality: decision.bbdown_quality_order[0].label().into(),
            avc_cap: cap.to_owned(),
            audio_hires: policy.audio_hires,
            source: policy.download_source.clone(),
            force_avc,
        }
    }

    pub(crate) fn changes_artifact(&self, other: &Self) -> bool {
        self.force_avc != other.force_avc
            || self.source != other.source
            || self.quality != other.quality
            || self.audio_hires != other.audio_hires
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

pub(super) fn load(directory: &Path, desktop: bool) -> Result<Saved, ApiError> {
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
    file.take(65537)
        .read_to_end(&mut bytes)
        .map_err(|_| storage_error())?;
    if bytes.len() > 65536 {
        return Err(storage_error());
    }
    let saved: Saved = serde_json::from_slice(&bytes).map_err(|_| storage_error())?;
    if saved.schema_version != 1 {
        return Err(storage_error());
    }
    // Existing native/mobile preferences retain their strict contract. Only
    // explicit desktop imports carry preserved legacy settings for unavailable
    // values; loading them must not silently select a different downloader.
    // Validate the saved source's contract, not its current installation.
    // Desktop discovers/prepares tool availability after loading preferences.
    if saved.cache.retained_settings.is_empty() && !saved.cache.available_with(desktop, desktop) {
        return Err(storage_error());
    }
    if saved.cache.download_source.len() > 128 || saved.cache.video_quality.len() > 128 {
        return Err(storage_error());
    }
    Ok(saved)
}

pub(super) fn save(
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
        app.native().cache_policy.updated(body).map(|_| ())
    })?;
    if body["download_source"] == "downkyi" {
        context.prepare_aria2(true)?;
    }
    with_app(|app| {
        app.native_authorize(identity, true)?;
        let next = app.native().cache_policy.updated(body)?;
        if body["download_source"] == "bbdown" && (!context.desktop || context.bbdown.is_none()) {
            return Err(ApiError::new(
                501,
                "bbdown_unavailable",
                "BBDown unavailable: configure an installed compatible executable with BB_DOWN_PATH and restart Host",
            ));
        }
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
    fn downkyi_requires_aria2_and_applies_avc_cap_only_when_needed() {
        let policy = CachePolicy::default()
            .updated(&json!({"download_source":"downkyi", "video_quality":"1080P 高清"}))
            .unwrap();
        assert!(!policy.available_with(true, false));
        assert!(policy.available_with(false, true));
        let player = PlayerMedia::reported(
            &json!({"hevc_supported":true,"avc_supported":true,"max_avc_quality_index":3}),
        )
        .unwrap();
        let selection = MediaSelection::new(&policy, &player, true);
        assert!(!selection.force_avc);
        assert_eq!(selection.quality, "1080P 高清");
        let player = PlayerMedia::reported(
            &json!({"hevc_supported":false,"avc_supported":true,"max_avc_quality_index":3}),
        )
        .unwrap();
        let capped = MediaSelection::new(&policy, &player, true);
        assert!(capped.force_avc);
        assert_eq!(capped.quality, "480P 清晰");
        assert!(selection.changes_artifact(&capped));
    }
    #[test]
    fn validates_entire_patch_and_defaults_to_native_choices() {
        let original = CachePolicy::default();
        assert!(original.reset_offset_on_next);
        assert!(
            serde_json::from_value::<CachePolicy>(json!({}))
                .unwrap()
                .reset_offset_on_next
        );
        // Explicit saved/imported choices remain authoritative.
        assert!(
            !serde_json::from_value::<CachePolicy>(json!({"reset_offset_on_next":false}))
                .unwrap()
                .reset_offset_on_next
        );
        for patch in [
            json!({"max_cache_items":0}),
            json!({"max_cache_items":6}),
            json!({"max_cache_items":true}),
            json!({"video_quality":"8K"}),
            json!({"audio_hires":"true"}),
            json!({"download_source":"arbitrary-executor"}),
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
    fn bbdown_policy_requires_host_capability_and_changes_artifact_identity() {
        let native = CachePolicy::default();
        let bbdown = native
            .updated(&json!({"download_source":"bbdown"}))
            .unwrap();
        assert!(!bbdown.available());
        assert!(!bbdown.available_with(false, false));
        assert!(bbdown.available_with(true, false));
        assert_eq!(bbdown.snapshot()["enabled"], false);
        assert_eq!(bbdown.snapshot_with(true, false)["enabled"], true);
        assert_eq!(
            bbdown.snapshot_with(true, false)["download_source_choices"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert!(
            MediaSelection::new(&bbdown, &PlayerMedia::default(), true)
                .changes_artifact(&MediaSelection::new(&native, &PlayerMedia::default(), true))
        );
    }

    #[test]
    fn desktop_baseline_boundaries_and_effective_media_noops() {
        let original = CachePolicy::default();
        for count in 1..=5 {
            for quality in CachePolicy::qualities() {
                let next=original.updated(&json!({"max_cache_items":count,"video_quality":quality,"audio_hires":true,"reset_offset_on_next":true})).unwrap();
                assert!(next.available());
            }
        }
        let policy = original
            .updated(&json!({"video_quality":"1080P 高清","audio_hires":false}))
            .unwrap();
        let player = PlayerMedia::reported(
            &json!({"hevc_supported":true,"avc_supported":true,"max_avc_quality_index":3}),
        )
        .unwrap();
        let selected = MediaSelection::new(&policy, &player, true);
        assert_eq!(selected.quality, "480P 清晰");
        assert_eq!(selected.avc_cap, "480P 清晰");
        let next=policy.updated(&json!({"max_cache_items":1,"reset_offset_on_next":true,"video_quality":"720P 高清"})).unwrap();
        assert!(!selected.changes_artifact(&MediaSelection::new(&next, &player, true)));
        let next = next.updated(&json!({"audio_hires":true})).unwrap();
        assert!(selected.changes_artifact(&MediaSelection::new(&next, &player, true)));
        let unknown = PlayerMedia::default();
        assert!(unknown.usable());
        assert!(
            MediaSelection::new(&policy, &unknown, true)
                .avc_cap
                .is_empty()
        );
        let incomplete =
            PlayerMedia::reported(&json!({"hevc_supported":false,"avc_supported":true})).unwrap();
        assert_eq!(incomplete.avc_quality_cap, "360P 流畅");
        assert_eq!(
            MediaSelection::new(&policy, &player, false).avc_cap,
            policy.video_quality
        );
    }

    #[test]
    fn roundtrip_replacement_and_corrupt_preferences_fail_closed() {
        let directory = std::env::temp_dir().join(format!(
            "bilikara-preferences-{}-{}",
            std::process::id(),
            now()
        ));
        fs::create_dir_all(&directory).unwrap();
        let defaults = load(&directory, false).unwrap().cache;
        assert_eq!(defaults, CachePolicy::default());
        assert_eq!(defaults.video_quality, "1080P 高帧率");
        assert!(defaults.audio_hires);
        assert_eq!(load(&directory, false).unwrap().language, None);
        let next = CachePolicy::default()
            .updated(&json!({"max_cache_items":4,"video_quality":"720P 高清","audio_hires":false}))
            .unwrap();
        save(&directory, &CachePolicy::default(), Some(UiLanguage::Ja)).unwrap();
        save(&directory, &next, Some(UiLanguage::Ja)).unwrap();
        assert_eq!(load(&directory, false).unwrap().cache, next);
        assert_eq!(
            load(&directory, false).unwrap().language,
            Some(UiLanguage::Ja)
        );
        // Existing Alpha preferences have no language field; retain their cache.
        fs::write(
            directory.join("native-preferences.json"),
            json!({"schema_version":1,"cache":next}).to_string(),
        )
        .unwrap();
        assert_eq!(load(&directory, false).unwrap().language, None);
        assert_eq!(load(&directory, false).unwrap().cache, next);
        for source in ["bbdown", "downkyi"] {
            let selected = next.updated(&json!({"download_source":source})).unwrap();
            save(&directory, &selected, None).unwrap();
            assert_eq!(load(&directory, true).unwrap().cache, selected);
            assert!(load(&directory, false).is_err());
        }
        let mut invalid = next.clone();
        invalid.download_source = "unknown-executor".into();
        save(&directory, &invalid, None).unwrap();
        assert!(load(&directory, true).is_err());
        fs::write(directory.join("native-preferences.json"), b"invalid").unwrap();
        assert!(load(&directory, false).is_err());
        assert_eq!(
            fs::read(directory.join("native-preferences.json")).unwrap(),
            b"invalid"
        );
        fs::remove_dir_all(directory).unwrap();
    }
}
