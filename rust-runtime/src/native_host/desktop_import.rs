//! One-time desktop layout reader. The source is never opened for writing.
//! Existing storage publishes the checkpoint; import completion is committed
//! last, so an interrupted import cannot be mistaken for a usable installation.
use super::{desktop, library, preferences};
use crate::{
    AppStateSeed, SessionArchiveSeed, app_state, desktop_login,
    native_host_storage::NativeHostStorage,
};
use serde_json::{Value, json};
use std::{
    fs,
    io::{Read, Write},
    path::Path,
};

const LIBRARY_FILES: [&str; 4] = [
    "gatcha_uids.json",
    "gatcha_cache.json",
    "gatcha_favlist.json",
    "gatcha_pool_config.json",
];

fn failure(name: &str) -> String {
    format!("Desktop import: invalid or unreadable {name}; source unchanged")
}

// Every existing component must be a real directory/file, never an indirect
// reference out of the explicitly selected source. Contents never enter errors.
fn read(root: &Path, relative: &Path, limit: Option<u64>) -> Result<Option<Vec<u8>>, String> {
    let mut path = root.to_owned();
    for component in relative.components() {
        if !matches!(component, std::path::Component::Normal(_)) {
            return Err(failure("source path"));
        }
        path.push(component);
        match fs::symlink_metadata(&path) {
            Ok(meta) if !meta.file_type().is_symlink() => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            _ => return Err(failure("source file")),
        }
    }
    let meta = fs::symlink_metadata(&path).map_err(|_| failure("source file"))?;
    if !meta.is_file() || limit.is_some_and(|limit| meta.len() > limit) {
        return Err(failure("source file size/type"));
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .and_then(|f| {
            f.take(limit.map_or(u64::MAX, |limit| limit.saturating_add(1)))
                .read_to_end(&mut bytes)
        })
        .map_err(|_| failure("source file"))?;
    if limit.is_some_and(|limit| bytes.len() as u64 > limit) {
        return Err(failure("source file size"));
    }
    Ok(Some(bytes))
}

fn object(root: &Path, relative: &str) -> Result<Option<Value>, String> {
    read(root, Path::new(relative), None)?
        .map(|bytes| {
            let value: Value = serde_json::from_slice(&bytes).map_err(|_| failure(relative))?;
            if !value.is_object() {
                return Err(failure(relative));
            }
            Ok(value)
        })
        .transpose()
}

struct Import {
    seed: AppStateSeed,
    cache: preferences::CachePolicy,
    cookie: Option<String>,
    library: Vec<(String, Vec<u8>)>,
    report: Value,
}

impl Import {
    fn read(source: &Path, configured_cookie: &str) -> Result<Self, String> {
        let data = source.join("data");
        if !fs::symlink_metadata(&data).is_ok_and(|m| m.is_dir()) {
            return Err(failure("data directory"));
        }
        let mut report = json!({"schema_version":1,"media":"Not copied; existing Rust restart invalidation requires re-cache", "users":"Names/order only; no device authentication imported", "warnings":["Settings outside the supported native fields are retained in native-preferences.json but are not applied", "Legacy split files do not persist session_history; pre-import duplicate-request history cannot be recovered. Played and global history records are retained without inferring playback"]});
        let mut retained = serde_json::Map::new();
        let split_layout = [
            "player_state.json",
            "history.json",
            "session_users.json",
            "playlist_backup.json",
        ]
        .iter()
        .any(|name| data.join(name).exists());
        let legacy = if split_layout {
            json!({})
        } else {
            object(&data, "state.json")?.unwrap_or(json!({}))
        };
        let mut seed = json!({"session_started_at":super::now(),"session_played_file":format!("played-native-{}.json",(super::now()*1000.0) as u64),"updated_at":super::now()});
        for key in [
            "current_item",
            "playlist",
            "history",
            "session_history",
            "session_users",
            "session_started_at",
            "session_played_file",
            "session_played",
            "updated_at",
        ] {
            if let Some(value) = legacy.get(key) {
                seed[key] = value.clone();
            }
        }
        let player = match object(&data, "player_state.json")? {
            Some(player)
                if player.get("player_settings").is_some_and(Value::is_object)
                    && player.get("playback_mode").is_some_and(Value::is_string) =>
            {
                player
            }
            Some(_) => return Err(failure("player_state.json required fields")),
            None => legacy,
        };
        if let Some(mode) = player.get("playback_mode") {
            seed["playback_mode"] = mode.clone();
        }
        if let Some(settings) = player.get("player_settings") {
            let mut settings = settings
                .as_object()
                .cloned()
                .ok_or_else(|| failure("player_settings"))?;
            retained.insert("player_settings".into(), json!(settings));
            if !settings.contains_key("global_av_delay_ms")
                && let Some(old) = settings.get("av_offset_ms")
            {
                let delay: i32 =
                    serde_json::from_value(old.clone()).map_err(|_| failure("av_offset_ms"))?;
                let result = bilikara_rust::decide_av_delay(
                    bilikara_rust::AvDelayState {
                        global_delay_ms: 0,
                        local_delay_ms: 0,
                        locked: false,
                    },
                    bilikara_rust::AvDelayAction::SetPersistent {
                        effective_delay_ms: delay,
                    },
                );
                settings.insert(
                    "global_av_delay_ms".into(),
                    json!(result.state.global_delay_ms),
                );
                settings.insert("av_delay_locked".into(), json!(result.state.locked));
            }
            settings.retain(|key, _| {
                matches!(
                    key.as_str(),
                    "global_av_delay_ms"
                        | "local_av_delay_ms"
                        | "av_delay_locked"
                        | "volume_percent"
                        | "is_muted"
                        | "song_advance_delay_seconds"
                        | "key_shift"
                )
            });
            seed["player_settings"] = json!(settings);
        }
        for (file, key) in [
            ("history.json", "history"),
            ("session_users.json", "session_users"),
        ] {
            if let Some(value) = object(&data, file)? {
                seed[key] = value
                    .get(key)
                    .filter(|v| v.is_array())
                    .ok_or_else(|| failure(file))?
                    .clone();
            }
        }
        let mut archives = Vec::<SessionArchiveSeed>::new();
        let archive_dir = data.join("played_sessions");
        match fs::symlink_metadata(&archive_dir) {
            Ok(meta) if meta.is_dir() => {
                for entry in fs::read_dir(&archive_dir).map_err(|_| failure("played_sessions"))? {
                    let entry = entry.map_err(|_| failure("played_sessions"))?;
                    let name = entry
                        .file_name()
                        .into_string()
                        .map_err(|_| failure("archive filename"))?;
                    if !name.starts_with("played-") || !name.ends_with(".json") {
                        continue;
                    }
                    if !super::exports::valid_source(&name) {
                        return Err(failure("archive filename"));
                    }
                    let value = object(&data, &format!("played_sessions/{name}"))?
                        .ok_or_else(|| failure("archive"))?;
                    let archive = json!({"file_name":name,"session_started_at":value["session_started_at"],"items":value["items"]});
                    archives.push(
                        serde_json::from_value(archive).map_err(|_| failure("archive records"))?,
                    );
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            _ => return Err(failure("played_sessions")),
        }
        if let Some(backup) = object(&data, "playlist_backup.json")? {
            seed["current_item"] = backup
                .get("current_item")
                .ok_or_else(|| failure("playlist_backup current_item"))?
                .clone();
            seed["playlist"] = backup
                .get("playlist")
                .filter(|v| v.is_array())
                .ok_or_else(|| failure("playlist_backup playlist"))?
                .clone();
            if let Some(played) = backup.get("played_session").filter(|v| !v.is_null()) {
                let name = played["file"]
                    .as_str()
                    .filter(|s| {
                        !s.is_empty()
                            && !s.contains(['/', '\\'])
                            && s.starts_with("played-")
                            && s.ends_with(".json")
                    })
                    .ok_or_else(|| failure("played_session filename"))?;
                seed["session_played_file"] = json!(name);
                seed["session_started_at"] = played["session_started_at"].clone();
                seed["session_played"] = match archives.iter().find(|a| a.file_name == name) {
                    Some(archive)
                        if Some(archive.session_started_at)
                            == played["session_started_at"].as_f64() =>
                    {
                        json!(archive.items)
                    }
                    Some(_) => return Err(failure("played_session timestamp mismatch")),
                    // The old desktop deliberately omits an empty played file.
                    None => {
                        report["warnings"].as_array_mut().unwrap().push(json!("Referenced played file absent: old desktop omits empty played files; no played records recovered"));
                        json!([])
                    }
                };
            }
        }
        archives.sort_by(|a, b| b.session_started_at.total_cmp(&a.session_started_at));
        archives.retain(|a| json!(a.file_name) != seed["session_played_file"]);
        seed["previous_session"] = json!(archives.first());
        seed["session_archives"] = json!(archives);
        // Legacy to_dict included presentation-only fields. They are not cache authority.
        for item in seed
            .get_mut("playlist")
            .and_then(Value::as_array_mut)
            .into_iter()
            .flatten()
        {
            strip_presentation(item);
        }
        if let Some(item) = seed.get_mut("current_item") {
            strip_presentation(item);
        }
        let seed: AppStateSeed =
            serde_json::from_value(seed).map_err(|_| failure("desktop state shape"))?;
        let seed = app_state::prepare_import(seed)?;
        let mut cache = preferences::CachePolicy::default();
        if let Some(value) = object(&data, "cache_policy.json")? {
            retained.insert("cache_policy".into(), value.clone());
            let mut fields = value.as_object().unwrap().clone();
            fields.retain(|k, _| {
                matches!(
                    k.as_str(),
                    "max_cache_items"
                        | "download_source"
                        | "video_quality"
                        | "audio_hires"
                        | "reset_offset_on_next"
                )
            });
            cache = serde_json::from_value(json!(fields)).map_err(|_| failure("cache_policy"))?;
        }
        if cache.download_source.len() > 128 || cache.video_quality.len() > 128 {
            return Err(failure("cache_policy length"));
        }
        cache.retained_settings = retained;
        if serde_json::to_vec(&cache)
            .map_err(|_| failure("settings"))?
            .len()
            > 60000
        {
            return Err(failure("settings size"));
        }
        report["cache_available"] = json!(cache.available());
        report["download_source"] = json!(cache.download_source);
        let credential = Path::new("tools/bbdown/BBDown.data");
        let bytes = read(source, credential, Some(16384))?;
        let result = desktop_login::execute(desktop_login::LoginCommand::ReadCookie {
            data_path: source.join(credential),
            configured_cookie: configured_cookie.into(),
        })
        .map_err(|_| failure("credentials"))?;
        let selected = result["cookie"].as_str().unwrap_or_default();
        let cookie = if selected.trim().is_empty() {
            if bytes.is_some_and(|b| !b.iter().all(u8::is_ascii_whitespace)) {
                return Err(failure("BBDown.data credential format"));
            }
            None
        } else {
            Some(
                desktop_login::login_cookie(selected)
                    .ok_or_else(|| failure("credential format"))?,
            )
        };
        report["credential_imported"] = json!(cookie.is_some());
        let mut library = Vec::new();
        for name in LIBRARY_FILES {
            if let Some(value) = object(&data, name)? {
                validate_library(name, &value)?;
                library.push((
                    name.into(),
                    serde_json::to_vec(&value).map_err(|_| failure(name))?,
                ));
            }
        }
        Ok(Self {
            seed,
            cache,
            cookie,
            library,
            report,
        })
    }

    fn publish(self, directory: &Path) -> Result<(), String> {
        let (mut storage, loaded) = NativeHostStorage::open(directory).map_err(|e| e.message)?;
        if loaded.is_some() {
            return Err(failure("destination already initialized"));
        }
        let pending = directory.join("desktop-import.pending");
        write_new(&pending, b"desktop-import-v1\n")?;
        preferences::save(directory, &self.cache, None)
            .map_err(|_| failure("destination preferences"))?;
        if let Some(cookie) = self.cookie {
            desktop_login::save_cookie(&directory.join("BBDown.data"), &cookie)
                .map_err(|_| failure("destination credentials"))?;
        }
        for (name, bytes) in self.library {
            write_new(&directory.join(name), &bytes)?;
        }
        if directory.join("gatcha_uids.json").exists() {
            crate::gatcha_repository::initialize_native_uids(&library::paths(directory), &[])
                .map_err(|_| failure("configured UP sources"))?;
        } else {
            library::initialize(directory).map_err(|_| failure("default UP sources"))?;
        }
        write_new(
            &directory.join("desktop-import-report.json"),
            &serde_json::to_vec_pretty(&self.report).map_err(|_| failure("report"))?,
        )?;
        // Publish the valid checkpoint last. Until the pending guard is removed,
        // an interrupted multi-file import cannot reopen as a completed one.
        storage.save(self.seed).map_err(|e| e.message)?;
        fs::remove_file(pending).map_err(|_| failure("import completion"))?;
        Ok(())
    }
}

fn strip_presentation(item: &mut Value) {
    if let Some(object) = item.as_object_mut() {
        for key in ["is_cached", "local_media_url", "local_media_path"] {
            object.remove(key);
        }
    }
}

fn validate_library(name: &str, value: &Value) -> Result<(), String> {
    let arrays: &[&str] = match name {
        "gatcha_uids.json" => &["uids"],
        "gatcha_favlist.json" => &["folders", "items"],
        "gatcha_pool_config.json" => &["excluded_uids", "excluded_favlist_folders"],
        _ => &[],
    };
    let objects: &[&str] = match name {
        "gatcha_cache.json" => &["uids", "profiles", "uid_checkpoints", "refresh_summary"],
        "gatcha_uids.json" => &["profiles"],
        _ => &[],
    };
    if arrays
        .iter()
        .any(|k| value.get(k).is_some_and(|v| !v.is_array()))
        || objects
            .iter()
            .any(|k| value.get(k).is_some_and(|v| !v.is_object()))
    {
        return Err(failure(name));
    }
    if name == "gatcha_favlist.json"
        && ["items", "folders"].iter().any(|key| {
            value
                .get(key)
                .and_then(Value::as_array)
                .is_some_and(|items| items.iter().any(|item| !item.is_object()))
        })
    {
        return Err(failure(name));
    }
    Ok(())
}

fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .and_then(|mut f| f.write_all(bytes).and_then(|()| f.sync_all()))
        .map_err(|_| failure("destination publication"))
}

pub(super) fn restore(
    source: &Path,
    destination: &Path,
    configured_cookie: &str,
) -> Result<(), String> {
    if !source.is_absolute() || !destination.is_absolute() {
        return Err(
            "Desktop import requires absolute source app-home and native destination".into(),
        );
    }
    if let (Ok(source), Ok(destination)) = (source.canonicalize(), destination.canonicalize())
        && (source.starts_with(&destination) || destination.starts_with(&source))
    {
        return Err("Desktop source and destination must not overlap".into());
    }
    // Restart never touches the legacy source again, even if it was moved away.
    if destination
        .try_exists()
        .map_err(|_| failure("destination"))?
    {
        if !destination.join("host-state.json").is_file() {
            return Err(
                "Desktop import refuses an existing destination without a native checkpoint; select a new directory"
                    .into(),
            );
        }
        let directory = desktop::preview_root(destination)?;
        let (_storage, seed) = NativeHostStorage::open(&directory).map_err(|e| e.message)?;
        app_state::prepare_import(seed.ok_or_else(|| failure("existing destination checkpoint"))?)?;
        preferences::load(&directory, true)
            .map_err(|_| failure("existing destination preferences"))?;
        super::login::load_desktop(&directory)
            .map_err(|_| failure("existing destination credentials"))?;
        return Ok(());
    }
    if !fs::symlink_metadata(source).is_ok_and(|m| m.is_dir()) {
        return Err(failure("source directory"));
    }
    let source = source
        .canonicalize()
        .map_err(|_| failure("source directory"))?;
    let parent = destination
        .parent()
        .ok_or_else(|| failure("destination parent"))?
        .canonicalize()
        .map_err(|_| failure("destination parent must exist"))?;
    let directory = parent.join(
        destination
            .file_name()
            .ok_or_else(|| failure("destination name"))?,
    );
    if directory.starts_with(&source) || source.starts_with(&directory) {
        return Err("Desktop source and destination must not overlap".into());
    }
    let import = Import::read(&source, configured_cookie)?;
    #[cfg(unix)]
    let builder = {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = fs::DirBuilder::new();
        builder.mode(0o700);
        builder
    };
    #[cfg(not(unix))]
    let builder = fs::DirBuilder::new();
    builder
        .create(&directory)
        .map_err(|_| failure("new destination"))?;
    import.publish(&directory)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "desktop-import-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(root.join("source/data")).unwrap();
            Self(root)
        }
        fn source(&self) -> std::path::PathBuf {
            self.0.join("source")
        }
        fn dest(&self) -> std::path::PathBuf {
            self.0.join("native")
        }
        fn put(&self, name: &str, value: Value) {
            let path = self.source().join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, value.to_string()).unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn item(id: &str) -> Value {
        json!({"id":id,"original_url":"https://www.bilibili.com/video/BV1xx411c7mD","resolved_url":"https://www.bilibili.com/video/BV1xx411c7mD","bvid":"BV1xx411c7mD","aid":1,"cid":2,"title":"Fixture","part_title":"P1","display_title":"Fixture","cover_url":"","embed_url":"","requester_name":"Alice","cache_status":"ready","cache_progress":100,"video_relative_path":"/untrusted/media","video_media_url":"file:///untrusted/media","artifact_relative_directory":"../../outside","is_cached":true})
    }
    fn played() -> Value {
        json!({"key":"fixture","item_id":"old","display_title":"Fixture","title":"Fixture","part_title":"P1","original_url":"https://www.bilibili.com/video/BV1xx411c7mD","resolved_url":"https://www.bilibili.com/video/BV1xx411c7mD","bvid":"BV1xx411c7mD","aid":1,"cid":2,"page":1,"played_at":101.0,"ended_at":102.0,"requester_name":"Alice"})
    }
    fn populate(f: &Fixture) {
        f.put("data/player_state.json",json!({"playback_mode":"local","player_settings":{"av_offset_ms":320,"volume_percent":55,"is_muted":true,"song_advance_delay_seconds":5,"key_shift":2,"future_setting":"retained"}}));
        f.put(
            "data/session_users.json",
            json!({"session_users":["Alice","Bob"]}),
        );
        f.put("data/history.json",json!({"history":[{"key":"fixture","display_title":"Fixture","original_url":"https://www.bilibili.com/video/BV1xx411c7mD","resolved_url":"https://www.bilibili.com/video/BV1xx411c7mD","requested_at":101.0,"request_count":2}]}));
        f.put(
            "data/played_sessions/played-current.json",
            json!({"session_started_at":100.0,"items":[played()]}),
        );
        f.put(
            "data/played_sessions/played-archive.json",
            json!({"session_started_at":50.0,"items":[played()]}),
        );
        f.put("data/playlist_backup.json",json!({"current_item":item("current"),"playlist":[item("queued")],"played_session":{"file":"played-current.json","session_started_at":100.0},"updated_at":103.0}));
        f.put("data/cache_policy.json",json!({"download_source":"bbdown","max_cache_items":4,"audio_hires":true,"reset_offset_on_next":true,"unknown":7}));
        f.put(
            "data/gatcha_uids.json",
            json!({"uids":["123"],"profiles":{}}),
        );
        f.put(
            "data/gatcha_favlist.json",
            json!({"uid":"456","folders":[{"id":"7","title":"Saved"}],"items":[]}),
        );
        f.put(
            "data/gatcha_pool_config.json",
            json!({"uid_weight":30,"favlist_weight":70,"excluded_uids":["123"]}),
        );
    }
    #[test]
    fn empty_and_populated_restore_keep_records_and_invalidate_only_media() {
        let empty = Fixture::new();
        restore(&empty.source(), &empty.dest(), "").unwrap();
        let (storage, seed) = NativeHostStorage::open(&empty.dest()).unwrap();
        assert!(seed.unwrap().playlist.is_empty());
        drop(storage);
        let f = Fixture::new();
        populate(&f);
        let source_bytes = fs::read(f.source().join("data/playlist_backup.json")).unwrap();
        restore(&f.source(), &f.dest(), "").unwrap();
        let (storage, seed) = NativeHostStorage::open(&f.dest()).unwrap();
        let seed = seed.unwrap();
        assert_eq!(seed.current_item.as_ref().unwrap().id, "current");
        assert_eq!(seed.playlist[0].id, "queued");
        assert_eq!(seed.session_users, vec!["Alice", "Bob"]);
        assert_eq!(seed.session_played.len(), 1);
        assert_eq!(seed.session_archives.len(), 1);
        assert_eq!(seed.history[0].request_count, 2);
        assert!(seed.session_history.is_empty());
        assert_eq!(seed.player_settings.global_av_delay_ms, 320);
        assert_eq!(seed.player_settings.volume_percent, 55);
        assert!(seed.player_settings.av_delay_locked);
        assert!(!seed.current_item_started);
        assert!(
            seed.current_item
                .as_ref()
                .unwrap()
                .video_relative_path
                .is_empty()
        );
        assert_eq!(seed.playlist[0].cache_status, "pending");
        let prefs = preferences::load(&f.dest(), true).unwrap();
        assert_eq!(prefs.cache.download_source, "bbdown");
        assert!(!prefs.cache.available());
        assert_eq!(prefs.cache.retained_settings["cache_policy"]["unknown"], 7);
        assert_eq!(
            prefs.cache.retained_settings["player_settings"]["future_setting"],
            "retained"
        );
        let uids: Value =
            serde_json::from_slice(&fs::read(f.dest().join("gatcha_uids.json")).unwrap()).unwrap();
        assert_eq!(uids["uids"], json!(["123"]));
        assert_eq!(
            fs::read(f.source().join("data/playlist_backup.json")).unwrap(),
            source_bytes
        );
        drop(storage);
        let before = fs::read(f.dest().join("host-state.json")).unwrap();
        assert!(!f.dest().join(desktop::MARKER).exists());
        assert!(!f.dest().join("desktop-import.pending").exists());
        // A vanished or now-corrupt old source cannot overwrite native changes.
        restore(&f.0.join("gone"), &f.dest(), "bad credential never read").unwrap();
        assert_eq!(fs::read(f.dest().join("host-state.json")).unwrap(), before);
    }
    #[test]
    fn p02_cookie_shapes_and_configured_fallback_use_one_desktop_file() {
        for cookie in [
            json!("SESSDATA=synthetic; bili_jct=csrf; DedeUserID=123"),
            json!({"cookie_info":{"cookies":[{"name":"SESSDATA","value":"synthetic"},{"name":"bili_jct","value":"csrf"}]}}),
            json!({"SESSDATA":"synthetic","bili_jct":"csrf"}),
        ] {
            let f = Fixture::new();
            f.put("tools/bbdown/BBDown.data", cookie);
            restore(&f.source(), &f.dest(), "SESSDATA=config; bili_jct=config").unwrap();
            assert!(
                desktop_login::read_cookie(&f.dest().join("BBDown.data"))
                    .contains("SESSDATA=synthetic")
            );
            assert!(!f.dest().join("bilibili-login.json").exists());
        }
        let f = Fixture::new();
        restore(&f.source(), &f.dest(), "SESSDATA=config; bili_jct=config").unwrap();
        assert!(
            desktop_login::read_cookie(&f.dest().join("BBDown.data")).contains("SESSDATA=config")
        );
    }
    #[test]
    fn corrupt_incomplete_overlapping_and_occupied_sources_fail_closed() {
        let f = Fixture::new();
        f.put("data/history.json", json!({"history":"broken"}));
        assert!(restore(&f.source(), &f.dest(), "").is_err());
        assert!(!f.dest().exists());
        fs::remove_file(f.source().join("data/history.json")).unwrap();
        assert!(restore(&f.source(), &f.source().join("native"), "").is_err());
        fs::create_dir(f.dest()).unwrap();
        fs::write(f.dest().join("unrelated"), b"preserve").unwrap();
        assert!(restore(&f.source(), &f.dest(), "").is_err());
        assert_eq!(fs::read(f.dest().join("unrelated")).unwrap(), b"preserve");
        f.put("tools/bbdown/BBDown.data", json!({"bad":"credentials"}));
        assert!(Import::read(&f.source(), "").is_err());
    }
    #[test]
    fn interrupted_import_never_reopens_partial_destination() {
        for blocked in ["host-state.pending", "desktop-import.pending"] {
            let f = Fixture::new();
            populate(&f);
            let before = fs::read(f.source().join("data/history.json")).unwrap();
            let import = Import::read(&f.source(), "").unwrap();
            fs::create_dir(f.dest()).unwrap();
            fs::create_dir(f.dest().join(blocked)).unwrap();
            assert!(import.publish(&f.dest()).is_err());
            assert!(!f.dest().join(desktop::MARKER).exists());
            assert!(desktop::preview_root(&f.dest()).is_err());
            assert_eq!(
                fs::read(f.source().join("data/history.json")).unwrap(),
                before
            );
            assert!(restore(&f.source(), &f.dest(), "").is_err());
        }
    }
    #[test]
    fn history_restore_does_not_infer_playback_from_skipped_or_open_records() {
        let f = Fixture::new();
        populate(&f);
        let mut open = played();
        open["ended_at"] = Value::Null;
        f.put(
            "data/played_sessions/played-current.json",
            json!({"session_started_at":100,"items":[played(),played(),open]}),
        );
        let import = Import::read(&f.source(), "").unwrap();
        assert_eq!(import.seed.session_played.len(), 3);
        assert!(import.seed.session_history.is_empty());
        assert!(
            import.report["warnings"]
                .to_string()
                .contains("cannot be recovered")
        );
        assert_eq!(import.seed.history[0].request_count, 2);
    }
    #[test]
    fn explicit_unified_session_history_is_preserved_and_split_files_take_precedence() {
        let f = Fixture::new();
        let history = json!([{"key":"fixture","display_title":"Fixture","original_url":"https://www.bilibili.com/video/BV1xx411c7mD","resolved_url":"https://www.bilibili.com/video/BV1xx411c7mD","requested_at":102.0,"request_count":2}]);
        f.put(
            "data/state.json",
            json!({"session_history":history,"history":history,"session_users":["Old"]}),
        );
        let imported = Import::read(&f.source(), "").unwrap();
        assert_eq!(imported.seed.session_history[0].request_count, 2);
        assert_eq!(imported.seed.history.len(), 1);
        f.put(
            "data/session_users.json",
            json!({"session_users":["Current"]}),
        );
        let imported = Import::read(&f.source(), "").unwrap();
        assert_eq!(imported.seed.session_users, vec!["Current"]);
        assert!(imported.seed.session_history.is_empty());
        assert!(imported.seed.history.is_empty());
    }
    #[test]
    fn corrupt_existing_destination_is_not_reimported_or_overwritten() {
        let f = Fixture::new();
        restore(&f.source(), &f.dest(), "").unwrap();
        fs::write(f.dest().join("host-state.json"), b"broken").unwrap();
        assert!(restore(&f.source(), &f.dest(), "").is_err());
        assert_eq!(
            fs::read(f.dest().join("host-state.json")).unwrap(),
            b"broken"
        );
        let other = Fixture::new();
        restore(&other.source(), &other.dest(), "").unwrap();
        fs::write(other.dest().join("BBDown.data"), b"malformed credentials").unwrap();
        assert!(restore(&other.source(), &other.dest(), "").is_err());
        assert_eq!(
            fs::read(other.dest().join("BBDown.data")).unwrap(),
            b"malformed credentials"
        );
    }
    #[cfg(unix)]
    #[test]
    fn source_symlinks_are_never_followed() {
        let f = Fixture::new();
        fs::write(f.0.join("outside"), b"{}").unwrap();
        std::os::unix::fs::symlink(f.0.join("outside"), f.source().join("data/history.json"))
            .unwrap();
        assert!(restore(&f.source(), &f.dest(), "").is_err());
        assert!(!f.dest().exists());
    }
}
