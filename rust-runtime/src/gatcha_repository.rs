use crate::bilibili_service::{BilibiliHttpClient, BilibiliServiceError};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use url::form_urlencoded;

const UID_SCHEMA_VERSION: u64 = 2;
const CACHE_SCHEMA_VERSION: u64 = 3;
const FAVLIST_SCHEMA_VERSION: u64 = 2;
const POOL_CONFIG_SCHEMA_VERSION: u64 = 1;
const EXPIRED_VIDEO_TITLE: &str = "已失效视频";
const SPACE_ARC_URL: &str = "https://api.bilibili.com/x/space/wbi/arc/search";
const SPACE_PROFILE_URL: &str = "https://api.bilibili.com/x/space/wbi/acc/info";
const FAVLIST_FOLDERS_URL: &str = "https://api.bilibili.com/x/v3/fav/folder/created/list-all";
const FAVLIST_ITEMS_URL: &str = "https://api.bilibili.com/x/v3/fav/resource/list";
const GATCHA_REQUEST_DELAY: Duration = Duration::from_secs(5);
const FAVLIST_REQUEST_DELAY: Duration = Duration::from_secs(3);

#[derive(Debug)]
struct UidFetchResult {
    entries: Vec<Value>,
    first_bvid: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GatchaPaths {
    pub uid_file: PathBuf,
    pub cache_file: PathBuf,
    pub favlist_file: PathBuf,
    pub pool_config_file: PathBuf,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum GatchaOperation {
    UidSnapshot,
    PoolConfigSnapshot,
    PoolConfigUpdate {
        #[serde(default)]
        uid_weight: Option<i64>,
        #[serde(default)]
        favlist_weight: Option<i64>,
        #[serde(default)]
        excluded_uids: Option<Vec<String>>,
        #[serde(default)]
        excluded_favlist_folders: Option<Vec<String>>,
    },
    Candidate {
        #[serde(default)]
        cookie_available: bool,
    },
    Search {
        query: String,
        #[serde(default = "default_search_limit")]
        limit: usize,
    },
    BrowseUid {
        #[serde(default)]
        uid: String,
        #[serde(default)]
        query: String,
    },
    BrowseFavlist {
        #[serde(default)]
        folder_id: String,
        #[serde(default)]
        query: String,
    },
    FavlistUpdatedAt,
    PreviewUid {
        uid: String,
        cookie: String,
        #[serde(default = "default_user_agent")]
        user_agent: String,
        #[serde(default = "default_referer")]
        referer: String,
        #[serde(default = "default_timeout_ms")]
        timeout_ms: u64,
    },
    AddUid {
        uid: String,
        cookie: String,
        #[serde(default)]
        keywords: Vec<String>,
        #[serde(default = "default_user_agent")]
        user_agent: String,
        #[serde(default = "default_referer")]
        referer: String,
        #[serde(default = "default_timeout_ms")]
        timeout_ms: u64,
    },
    RefreshAll {
        cookie: String,
        #[serde(default)]
        keywords: Vec<String>,
        #[serde(default = "default_user_agent")]
        user_agent: String,
        #[serde(default = "default_referer")]
        referer: String,
        #[serde(default = "default_timeout_ms")]
        timeout_ms: u64,
    },
    PreviewFavlist {
        uid: String,
        cookie: String,
        #[serde(default)]
        folder_keywords: Vec<String>,
        #[serde(default = "default_user_agent")]
        user_agent: String,
        #[serde(default = "default_referer")]
        referer: String,
        #[serde(default = "default_timeout_ms")]
        timeout_ms: u64,
    },
    RefreshFavlist {
        uid: String,
        #[serde(default)]
        folder_ids: Option<Vec<String>>,
        cookie: String,
        #[serde(default)]
        folder_keywords: Vec<String>,
        #[serde(default = "default_user_agent")]
        user_agent: String,
        #[serde(default = "default_referer")]
        referer: String,
        #[serde(default = "default_timeout_ms")]
        timeout_ms: u64,
    },
}

#[derive(Debug, Clone, Deserialize)]
pub struct GatchaRepositoryRequest {
    #[serde(default = "schema_version")]
    pub schema_version: u32,
    pub paths: GatchaPaths,
    #[serde(default)]
    pub default_uids: Vec<String>,
    #[serde(flatten)]
    pub operation: GatchaOperation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GatchaRepositoryError {
    pub kind: String,
    pub message: String,
}

static REPOSITORY_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(1);

pub fn execute_gatcha(request: &GatchaRepositoryRequest) -> Result<Value, GatchaRepositoryError> {
    if request.schema_version != 1 {
        return Err(error("invalid_request", "unsupported schema version"));
    }
    if !requires_mutation_lock(&request.operation) {
        uid_snapshot(&request.paths.uid_file, &request.default_uids)?;
        return execute_gatcha_operation(request);
    }
    let _guard = repository_guard()?;
    uid_snapshot(&request.paths.uid_file, &request.default_uids)?;
    execute_gatcha_operation(request)
}

fn requires_mutation_lock(operation: &GatchaOperation) -> bool {
    matches!(
        operation,
        GatchaOperation::PoolConfigUpdate { .. }
            | GatchaOperation::AddUid { .. }
            | GatchaOperation::RefreshFavlist { .. }
    )
}

fn repository_guard() -> Result<MutexGuard<'static, ()>, GatchaRepositoryError> {
    REPOSITORY_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| error("state", "Gacha repository lock is poisoned"))
}

fn execute_gatcha_operation(
    request: &GatchaRepositoryRequest,
) -> Result<Value, GatchaRepositoryError> {
    match &request.operation {
        GatchaOperation::UidSnapshot => {
            uid_snapshot(&request.paths.uid_file, &request.default_uids)
        }
        GatchaOperation::PoolConfigSnapshot => {
            Ok(load_pool_config(&request.paths.pool_config_file))
        }
        GatchaOperation::PoolConfigUpdate {
            uid_weight,
            favlist_weight,
            excluded_uids,
            excluded_favlist_folders,
        } => update_pool_config(
            &request.paths.pool_config_file,
            *uid_weight,
            *favlist_weight,
            excluded_uids.as_deref(),
            excluded_favlist_folders.as_deref(),
        ),
        GatchaOperation::Candidate { cookie_available } => {
            draw_candidate(&request.paths, *cookie_available)
        }
        GatchaOperation::Search { query, limit } => search(&request.paths, query, *limit),
        GatchaOperation::BrowseUid { uid, query } => browse_uid(&request.paths, uid, query),
        GatchaOperation::BrowseFavlist { folder_id, query } => {
            browse_favlist(&request.paths, folder_id, query)
        }
        GatchaOperation::FavlistUpdatedAt => {
            let payload = load_favlist(&request.paths.favlist_file);
            Ok(json!({"updated_at": number(&payload, "updated_at")}))
        }
        GatchaOperation::PreviewUid {
            uid,
            cookie,
            user_agent,
            referer,
            timeout_ms,
        } => preview_uid(
            &request.paths,
            uid,
            &network_client(cookie, user_agent, referer, *timeout_ms)?,
        ),
        GatchaOperation::AddUid {
            uid,
            cookie,
            keywords,
            user_agent,
            referer,
            timeout_ms,
        } => add_uid(
            &request.paths,
            uid,
            keywords,
            &network_client(cookie, user_agent, referer, *timeout_ms)?,
        ),
        GatchaOperation::RefreshAll {
            cookie,
            keywords,
            user_agent,
            referer,
            timeout_ms,
        } => refresh_all(
            &request.paths,
            keywords,
            &network_client(cookie, user_agent, referer, *timeout_ms)?,
        ),
        GatchaOperation::PreviewFavlist {
            uid,
            cookie,
            folder_keywords,
            user_agent,
            referer,
            timeout_ms,
        } => preview_favlist(
            uid,
            folder_keywords,
            &network_client(cookie, user_agent, referer, *timeout_ms)?,
        ),
        GatchaOperation::RefreshFavlist {
            uid,
            folder_ids,
            cookie,
            folder_keywords,
            user_agent,
            referer,
            timeout_ms,
        } => refresh_favlist(
            &request.paths,
            uid,
            folder_ids.as_deref(),
            folder_keywords,
            &network_client(cookie, user_agent, referer, *timeout_ms)?,
        ),
    }
}

fn uid_snapshot(path: &Path, default_uids: &[String]) -> Result<Value, GatchaRepositoryError> {
    let mut payload = read_object(path).unwrap_or_else(|| {
        Map::from_iter([
            ("schema_version".to_owned(), json!(UID_SCHEMA_VERSION)),
            ("uids".to_owned(), json!(normalized_uids(default_uids))),
            ("profiles".to_owned(), json!({})),
            ("updated_at".to_owned(), json!(unix_timestamp())),
        ])
    });
    let should_write = !path.exists();
    let uids = normalized_uids_from_value(payload.get("uids"));
    let profiles = payload
        .remove("profiles")
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    let updated_at = number_map(&payload, "updated_at");
    let normalized = json!({
        "schema_version": UID_SCHEMA_VERSION,
        "uids": uids,
        "profiles": profiles,
        "updated_at": updated_at,
    });
    if should_write {
        atomic_write_json(path, &normalized)?;
    }
    Ok(json!({
        "uids": normalized["uids"],
        "count": normalized["uids"].as_array().map_or(0, Vec::len),
        "profiles": normalized["profiles"],
        "updated_at": updated_at,
    }))
}

fn load_pool_config(path: &Path) -> Value {
    let payload = read_object(path).unwrap_or_default();
    json!({
        "schema_version": POOL_CONFIG_SCHEMA_VERSION,
        "uid_weight": clamped_weight(payload.get("uid_weight"), 50),
        "favlist_weight": clamped_weight(payload.get("favlist_weight"), 50),
        "excluded_uids": normalized_strings(payload.get("excluded_uids")),
        "excluded_favlist_folders": normalized_strings(payload.get("excluded_favlist_folders")),
        "updated_at": number_map(&payload, "updated_at"),
    })
}

fn update_pool_config(
    path: &Path,
    uid_weight: Option<i64>,
    favlist_weight: Option<i64>,
    excluded_uids: Option<&[String]>,
    excluded_folders: Option<&[String]>,
) -> Result<Value, GatchaRepositoryError> {
    let mut payload = load_pool_config(path);
    let object = payload
        .as_object_mut()
        .ok_or_else(|| error("state", "invalid pool configuration"))?;
    if let Some(weight) = uid_weight {
        object.insert("uid_weight".to_owned(), json!(weight.clamp(0, 100)));
    }
    if let Some(weight) = favlist_weight {
        object.insert("favlist_weight".to_owned(), json!(weight.clamp(0, 100)));
    }
    if let Some(values) = excluded_uids {
        object.insert(
            "excluded_uids".to_owned(),
            json!(normalized_strings_slice(values)),
        );
    }
    if let Some(values) = excluded_folders {
        object.insert(
            "excluded_favlist_folders".to_owned(),
            json!(normalized_strings_slice(values)),
        );
    }
    object.insert("updated_at".to_owned(), json!(unix_timestamp()));
    atomic_write_json(path, &payload)?;
    Ok(payload)
}

fn load_cache(path: &Path) -> Value {
    let payload = read_object(path).unwrap_or_default();
    json!({
        "schema_version": CACHE_SCHEMA_VERSION,
        "uids": payload.get("uids").filter(|value| value.is_object()).cloned().unwrap_or_else(|| json!({})),
        "profiles": payload.get("profiles").filter(|value| value.is_object()).cloned().unwrap_or_else(|| json!({})),
        "uid_checkpoints": payload.get("uid_checkpoints").filter(|value| value.is_object()).cloned().unwrap_or_else(|| json!({})),
        "refresh_summary": payload.get("refresh_summary").filter(|value| value.is_object()).cloned().unwrap_or_else(|| json!({})),
        "updated_at": number_map(&payload, "updated_at"),
    })
}

fn load_favlist(path: &Path) -> Value {
    let payload = read_object(path).unwrap_or_default();
    let legacy_uid = text_map(&payload, "uid");
    let mut folders = Vec::new();
    for value in array_map(&payload, "folders") {
        let Some(mut folder) = value.as_object().cloned() else {
            continue;
        };
        let uid = first_text(&folder, &["uid", "mid"]).unwrap_or_else(|| legacy_uid.clone());
        if !uid.is_empty() {
            folder.insert("uid".to_owned(), Value::String(uid));
        }
        folders.push(Value::Object(folder));
    }
    let mut items = Vec::new();
    for value in array_map(&payload, "items") {
        let Some(mut item) = value.as_object().cloned() else {
            continue;
        };
        let uid = first_text(&item, &["fav_uid"]).unwrap_or_else(|| legacy_uid.clone());
        if !uid.is_empty() {
            item.insert("fav_uid".to_owned(), Value::String(uid));
        }
        if first_text(&item, &["source"]).is_none() {
            item.insert("source".to_owned(), Value::String("favlist".to_owned()));
        }
        items.push(Value::Object(item));
    }
    let items = dedupe_entries(&items);
    let mut uids: BTreeSet<String> = normalized_strings(payload.get("uids"))
        .into_iter()
        .collect();
    for folder in &folders {
        if let Some(uid) = folder
            .as_object()
            .and_then(|value| first_text(value, &["uid", "mid"]))
        {
            uids.insert(uid);
        }
    }
    for item in &items {
        if let Some(uid) = item
            .as_object()
            .and_then(|value| first_text(value, &["fav_uid"]))
        {
            uids.insert(uid);
        }
    }
    json!({
        "schema_version": FAVLIST_SCHEMA_VERSION,
        "uid": legacy_uid,
        "uids": uids,
        "folders": folders,
        "items": items,
        "updated_at": number_map(&payload, "updated_at"),
    })
}

fn network_client(
    cookie: &str,
    user_agent: &str,
    referer: &str,
    timeout_ms: u64,
) -> Result<BilibiliHttpClient, GatchaRepositoryError> {
    BilibiliHttpClient::new(cookie, user_agent, referer, timeout_ms).map_err(network_error)
}

fn preview_uid(
    paths: &GatchaPaths,
    raw_uid: &str,
    client: &BilibiliHttpClient,
) -> Result<Value, GatchaRepositoryError> {
    let uid = required_uid(raw_uid)?;
    let profile = fetch_profile(client, &uid)?;
    let resolved_uid = text_value(&profile, "uid");
    let uid_payload = uid_snapshot(&paths.uid_file, &[])?;
    let cache = load_cache(&paths.cache_file);
    let existing = cache
        .pointer(&format!("/uids/{resolved_uid}"))
        .and_then(Value::as_array)
        .map(|items| dedupe_entries(items))
        .unwrap_or_default();
    let mode = if existing.is_empty() {
        "full"
    } else {
        "incremental"
    };
    Ok(json!({
        "uid": resolved_uid,
        "name": profile["name"],
        "space_url": profile["space_url"],
        "avatar_url": profile.get("avatar_url").cloned().unwrap_or_else(|| json!("")),
        "already_followed": normalized_strings(uid_payload.get("uids")).contains(&resolved_uid),
        "cache_mode": mode,
        "cache_mode_label": if mode == "incremental" { "最新" } else { "所有" },
        "cached_count": existing.len(),
    }))
}

fn add_uid(
    paths: &GatchaPaths,
    raw_uid: &str,
    keywords: &[String],
    client: &BilibiliHttpClient,
) -> Result<Value, GatchaRepositoryError> {
    let uid = required_uid(raw_uid)?;
    let profile = fetch_profile(client, &uid)?;
    let uid = text_value(&profile, "uid");
    let mut uid_payload = uid_snapshot(paths.uid_file.as_path(), &[])?;
    let mut uids = normalized_strings(uid_payload.get("uids"));
    let added = !uids.contains(&uid);
    if added {
        uids.push(uid.clone());
    }
    let mut profiles = uid_payload
        .get("profiles")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    profiles.insert(uid.clone(), profile.clone());
    uid_payload = json!({
        "schema_version": UID_SCHEMA_VERSION,
        "uids": uids,
        "profiles": profiles,
        "updated_at": unix_timestamp(),
    });
    atomic_write_json(&paths.uid_file, &uid_payload)?;

    let mut cache = load_cache(&paths.cache_file);
    let existing = cache
        .pointer(&format!("/uids/{uid}"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let incremental = !dedupe_entries(&existing).is_empty();
    let checkpoint = incremental
        .then(|| uid_refresh_checkpoint(&cache, &uid, &existing))
        .flatten();
    let fresh = fetch_uid_entries(client, &uid, keywords, checkpoint.as_deref())?;
    let (entries, added_count) = if incremental {
        merge_incremental_entries(&existing, &fresh.entries)
    } else {
        let entries = dedupe_entries(&fresh.entries);
        let count = entries.len();
        (entries, count)
    };
    cache
        .as_object_mut()
        .ok_or_else(|| error("state", "invalid Gacha cache"))?
        .insert("updated_at".to_owned(), json!(unix_timestamp()));
    let cache_object = cache.as_object_mut().expect("cache object was checked");
    let cache_uids = cache_object
        .entry("uids")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| error("state", "invalid Gacha UID cache"))?;
    cache_uids.insert(uid.clone(), Value::Array(entries.clone()));
    let cache_profiles = cache_object
        .entry("profiles")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| error("state", "invalid Gacha profile cache"))?;
    cache_profiles.insert(uid.clone(), profile.clone());
    persist_uid_checkpoint(cache_object, &uid, fresh.first_bvid.as_deref())?;
    atomic_write_json(&paths.cache_file, &cache)?;
    Ok(json!({
        "uid": uid,
        "name": profile["name"],
        "space_url": profile["space_url"],
        "avatar_url": profile.get("avatar_url").cloned().unwrap_or_else(|| json!("")),
        "added": added,
        "uids": uids,
        "cache": {
            "uid": uid,
            "mode": if incremental { "incremental" } else { "full" },
            "added_count": added_count,
            "total_count": entries.len(),
        },
        "entries": entries,
    }))
}

fn refresh_all(
    paths: &GatchaPaths,
    keywords: &[String],
    client: &BilibiliHttpClient,
) -> Result<Value, GatchaRepositoryError> {
    let (configured, legacy_cache, initial_checkpoints) = {
        let _guard = repository_guard()?;
        let uid_payload = uid_snapshot(&paths.uid_file, &[])?;
        let raw_cache = read_object(&paths.cache_file).unwrap_or_default();
        let configured = normalized_strings(uid_payload.get("uids"));
        let initial_checkpoints =
            uid_refresh_checkpoints(&load_cache(&paths.cache_file), &configured);
        (
            configured,
            integer_value(raw_cache.get("schema_version")).unwrap_or(0)
                < CACHE_SCHEMA_VERSION as i64
                || !raw_cache.get("profiles").is_some_and(Value::is_object),
            initial_checkpoints,
        )
    };
    let mut results = Vec::new();
    let mut errors = Vec::new();
    persist_refresh_summary(paths, &results, &errors, "", false, configured.len())?;
    for uid in &configured {
        let result = (|| {
            let (known_profile, existing) = {
                let _guard = repository_guard()?;
                let uid_payload = uid_snapshot(&paths.uid_file, &[])?;
                let cache = load_cache(&paths.cache_file);
                let existing = cache
                    .pointer(&format!("/uids/{uid}"))
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                (
                    uid_payload
                        .pointer(&format!("/profiles/{uid}"))
                        .filter(|value| valid_profile(value))
                        .cloned(),
                    existing,
                )
            };
            let profile = known_profile
                .as_ref()
                .filter(|value| valid_profile(value))
                .cloned()
                .map(Ok)
                .unwrap_or_else(|| fetch_profile(client, uid))?;
            let incremental = !legacy_cache && !dedupe_entries(&existing).is_empty();
            let stop_bvid = incremental
                .then(|| initial_checkpoints.get(uid).cloned().flatten())
                .flatten();
            let fresh = fetch_uid_entries(client, uid, keywords, stop_bvid.as_deref())?;
            let (added_count, total_count) = persist_refreshed_uid(
                paths,
                uid,
                &profile,
                &existing,
                &fresh.entries,
                fresh.first_bvid.as_deref(),
                incremental,
            )?;
            Ok::<Value, GatchaRepositoryError>(json!({
                "uid": uid,
                "mode": if incremental { "incremental" } else { "full" },
                "added_count": added_count,
                "total_count": total_count,
            }))
        })();
        match result {
            Ok(value) => results.push(value),
            Err(failure) => errors.push(json!({"uid": uid, "error": failure.message})),
        }
        persist_refresh_summary(paths, &results, &errors, "", false, configured.len())?;
    }
    let favlist_result = {
        let _guard = repository_guard()?;
        refresh_existing_favlist(paths, client)
    };
    let favlist_error = favlist_result
        .as_ref()
        .err()
        .map(|failure| failure.message.clone())
        .unwrap_or_default();
    persist_refresh_summary(
        paths,
        &results,
        &errors,
        &favlist_error,
        true,
        configured.len(),
    )
}

fn persist_refreshed_uid(
    paths: &GatchaPaths,
    uid: &str,
    profile: &Value,
    baseline_entries: &[Value],
    fresh_entries: &[Value],
    first_bvid: Option<&str>,
    incremental: bool,
) -> Result<(usize, usize), GatchaRepositoryError> {
    let _guard = repository_guard()?;
    let mut uid_payload = uid_snapshot(&paths.uid_file, &[])?;
    let uid_object = uid_payload
        .as_object_mut()
        .ok_or_else(|| error("state", "invalid Gacha UID configuration"))?;
    uid_object
        .entry("profiles")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| error("state", "invalid Gacha UID profiles"))?
        .insert(uid.to_owned(), profile.clone());
    let updated_at = unix_timestamp();
    uid_object.insert("updated_at".to_owned(), json!(updated_at));
    atomic_write_json(&paths.uid_file, &uid_payload)?;

    let mut cache = load_cache(&paths.cache_file);
    let cache_object = cache
        .as_object_mut()
        .ok_or_else(|| error("state", "invalid Gacha cache"))?;
    let cache_uids = cache_object
        .entry("uids")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| error("state", "invalid Gacha UID cache"))?;
    let latest_entries = cache_uids
        .get(uid)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let concurrent_change = latest_entries != baseline_entries;
    let (entries, added_count) = if incremental || concurrent_change {
        merge_incremental_entries(&latest_entries, fresh_entries)
    } else {
        let entries = dedupe_entries(fresh_entries);
        let count = entries.len();
        (entries, count)
    };
    let total_count = entries.len();
    cache_uids.insert(uid.to_owned(), Value::Array(entries));
    cache_object
        .entry("profiles")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| error("state", "invalid Gacha profile cache"))?
        .insert(uid.to_owned(), profile.clone());
    persist_uid_checkpoint(cache_object, uid, first_bvid)?;
    cache_object.insert("updated_at".to_owned(), json!(updated_at));
    atomic_write_json(&paths.cache_file, &cache)?;
    Ok((added_count, total_count))
}

fn persist_refresh_summary(
    paths: &GatchaPaths,
    results: &[Value],
    errors: &[Value],
    favlist_error: &str,
    completed: bool,
    total_count: usize,
) -> Result<Value, GatchaRepositoryError> {
    let _guard = repository_guard()?;
    let mut cache = load_cache(&paths.cache_file);
    let updated_at = unix_timestamp();
    let cache_object = cache
        .as_object_mut()
        .ok_or_else(|| error("state", "invalid Gacha cache"))?;
    cache_object.insert("updated_at".to_owned(), json!(updated_at));
    cache_object.insert(
        "refresh_summary".to_owned(),
        json!({
            "uids": results,
            "errors": errors,
            "favlist_error": favlist_error,
            "completed": completed,
            "completed_count": results.len() + errors.len(),
            "total_count": total_count,
            "updated_at": updated_at,
        }),
    );
    atomic_write_json(&paths.cache_file, &cache)?;
    Ok(cache)
}

fn preview_favlist(
    raw_uid: &str,
    folder_keywords: &[String],
    client: &BilibiliHttpClient,
) -> Result<Value, GatchaRepositoryError> {
    let uid = required_uid(raw_uid)?;
    let folders = fetch_favlist_folders(client, &uid)?;
    let public: Vec<Value> = folders
        .iter()
        .filter_map(Value::as_object)
        .filter(|folder| public_folder(folder))
        .filter_map(|folder| folder_summary(folder, folder_keywords))
        .collect();
    Ok(json!({
        "uid": uid,
        "folder_count": folders.len(),
        "public_folder_count": public.len(),
        "selected_folder_ids": public.iter().filter(|folder| folder.get("selected").and_then(Value::as_bool).unwrap_or(false)).filter_map(|folder| folder.get("id").and_then(Value::as_str)).collect::<Vec<_>>(),
        "folders": public,
    }))
}

fn refresh_favlist(
    paths: &GatchaPaths,
    raw_uid: &str,
    selected_folder_ids: Option<&[String]>,
    folder_keywords: &[String],
    client: &BilibiliHttpClient,
) -> Result<Value, GatchaRepositoryError> {
    let uid = required_uid(raw_uid)?;
    let selected: Option<HashSet<String>> = selected_folder_ids.map(|values| {
        values
            .iter()
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .collect()
    });
    if selected.as_ref().is_some_and(HashSet::is_empty) {
        return Err(error("invalid_request", "请选择至少一个收藏夹"));
    }
    let folders = fetch_favlist_folders(client, &uid)?;
    let mut matched = Vec::new();
    let mut incoming = Vec::new();
    for folder in folders.iter().filter_map(Value::as_object) {
        if !public_folder(folder) {
            continue;
        }
        let Some(mut summary) = folder_summary(folder, folder_keywords) else {
            continue;
        };
        let folder_id = text_value(&summary, "id");
        let include = selected
            .as_ref()
            .map(|values| values.contains(&folder_id))
            .unwrap_or_else(|| summary["selected"].as_bool().unwrap_or(false));
        if !include {
            continue;
        }
        summary
            .as_object_mut()
            .expect("folder summary")
            .remove("selected");
        summary
            .as_object_mut()
            .expect("folder summary")
            .insert("uid".to_owned(), Value::String(uid.clone()));
        incoming.extend(fetch_favlist_entries(client, &uid, folder, None)?);
        matched.push(summary);
    }
    let incoming = dedupe_entries(&incoming);
    let incoming_count = incoming.len();
    let mut current = load_favlist(&paths.favlist_file);
    let incoming_keys: HashSet<(String, String)> = matched
        .iter()
        .filter_map(Value::as_object)
        .map(|folder| (uid.clone(), folder_id(folder)))
        .filter(|(_, folder)| !folder.is_empty())
        .collect();
    let mut merged_folders: BTreeMap<(String, String), Value> = BTreeMap::new();
    for folder in array(&current, "folders") {
        let Some(object) = folder.as_object() else {
            continue;
        };
        let folder_uid = first_text(object, &["uid", "mid"]).unwrap_or_default();
        let key = (folder_uid, folder_id(object));
        if !key.1.is_empty() && !incoming_keys.contains(&key) {
            merged_folders.insert(key, folder.clone());
        }
    }
    for folder in matched.iter().filter_map(Value::as_object) {
        let key = (uid.clone(), folder_id(folder));
        if !key.1.is_empty() {
            merged_folders.insert(key, Value::Object(folder.clone()));
        }
    }
    let mut entries: Vec<Value> = array(&current, "items")
        .iter()
        .filter(|entry| {
            entry.as_object().is_none_or(|object| {
                let key = (
                    first_text(object, &["fav_uid"]).unwrap_or_default(),
                    first_text(object, &["fav_folder_id"]).unwrap_or_default(),
                );
                !incoming_keys.contains(&key)
            })
        })
        .cloned()
        .collect();
    entries.extend(incoming);
    entries = dedupe_entries(&entries);
    let mut uids: BTreeSet<String> = normalized_strings(current.get("uids"))
        .into_iter()
        .collect();
    uids.insert(uid.clone());
    let updated_at = unix_timestamp();
    current = json!({
        "schema_version": FAVLIST_SCHEMA_VERSION,
        "uid": uid,
        "uids": uids,
        "folders": merged_folders.into_values().collect::<Vec<_>>(),
        "items": entries,
        "updated_at": updated_at,
    });
    atomic_write_json(&paths.favlist_file, &current)?;
    Ok(json!({
        "uid": uid,
        "folder_count": folders.len(),
        "matched_folder_count": matched.len(),
        "item_count": incoming_count,
        "updated_at": updated_at,
        "entries": current["items"],
    }))
}

fn refresh_existing_favlist(
    paths: &GatchaPaths,
    client: &BilibiliHttpClient,
) -> Result<Option<Value>, GatchaRepositoryError> {
    if !paths.favlist_file.exists() {
        return Ok(None);
    }
    let mut payload = load_favlist(&paths.favlist_file);
    let folders = array(&payload, "folders").to_vec();
    if folders.is_empty() {
        return Ok(None);
    }
    let mut fresh = Vec::new();
    let mut refreshed = 0usize;
    for folder in folders.iter().filter_map(Value::as_object) {
        let uid =
            first_text(folder, &["uid", "mid"]).unwrap_or_else(|| text_value(&payload, "uid"));
        if uid.is_empty() || folder_id(folder).is_empty() {
            continue;
        }
        fresh.extend(fetch_favlist_entries(client, &uid, folder, Some(1))?);
        refreshed += 1;
    }
    if refreshed == 0 {
        return Ok(None);
    }
    let existing = array(&payload, "items").to_vec();
    let (merged, added_count) = merge_incremental_entries(&existing, &fresh);
    payload
        .as_object_mut()
        .expect("favlist payload")
        .insert("items".to_owned(), Value::Array(merged.clone()));
    payload
        .as_object_mut()
        .expect("favlist payload")
        .insert("updated_at".to_owned(), json!(unix_timestamp()));
    atomic_write_json(&paths.favlist_file, &payload)?;
    Ok(Some(json!({
        "mode": "incremental",
        "folder_count": refreshed,
        "added_count": added_count,
        "total_count": merged.len(),
    })))
}

fn fetch_profile(client: &BilibiliHttpClient, uid: &str) -> Result<Value, GatchaRepositoryError> {
    let payload = client
        .get_wbi_json(
            SPACE_PROFILE_URL,
            BTreeMap::from([("mid".to_owned(), uid.to_owned())]),
            "UP 主信息获取失败",
        )
        .map_err(network_error)?;
    let data = payload
        .get("data")
        .and_then(Value::as_object)
        .ok_or_else(|| error("invalid_response", "UP 主信息获取失败"))?;
    let resolved_uid = first_text(data, &["mid"]).unwrap_or_else(|| uid.to_owned());
    let name = first_text(data, &["name"]).unwrap_or_default();
    if normalize_uid(&resolved_uid).is_none() || name.is_empty() {
        return Err(error("not_found", "没有找到这个 UID 对应的 UP 主"));
    }
    let mut profile = json!({
        "uid": normalize_uid(&resolved_uid).unwrap_or(resolved_uid.clone()),
        "name": name,
        "space_url": format!("https://space.bilibili.com/{resolved_uid}"),
    });
    if let Some(avatar) = first_text(data, &["face"]) {
        profile
            .as_object_mut()
            .expect("profile object")
            .insert("avatar_url".to_owned(), Value::String(avatar));
    }
    Ok(profile)
}

fn uid_refresh_checkpoint(cache: &Value, uid: &str, existing: &[Value]) -> Option<String> {
    if let Some(checkpoint) = cache
        .pointer(&format!("/uid_checkpoints/{uid}"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Some(checkpoint.to_owned());
    }

    let added_count = cache
        .pointer("/refresh_summary/uids")
        .and_then(Value::as_array)
        .and_then(|results| {
            results.iter().find_map(|result| {
                let object = result.as_object()?;
                (first_text(object, &["uid"]).as_deref() == Some(uid)
                    && first_text(object, &["mode"]).as_deref() == Some("incremental"))
                .then(|| integer(object, &["added_count"]).unwrap_or(0).max(0) as usize)
            })
        })
        .unwrap_or(0);

    existing
        .get(added_count)
        .or_else(|| existing.first())
        .and_then(Value::as_object)
        .and_then(|entry| first_text(entry, &["bvid"]))
}

fn uid_refresh_checkpoints(cache: &Value, uids: &[String]) -> BTreeMap<String, Option<String>> {
    uids.iter()
        .map(|uid| {
            let existing = cache
                .pointer(&format!("/uids/{uid}"))
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            (uid.clone(), uid_refresh_checkpoint(cache, uid, existing))
        })
        .collect()
}

fn persist_uid_checkpoint(
    cache: &mut Map<String, Value>,
    uid: &str,
    first_bvid: Option<&str>,
) -> Result<(), GatchaRepositoryError> {
    let checkpoints = cache
        .entry("uid_checkpoints")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| error("state", "invalid Gacha UID checkpoints"))?;
    if let Some(first_bvid) = first_bvid.map(str::trim).filter(|value| !value.is_empty()) {
        checkpoints.insert(uid.to_owned(), Value::String(first_bvid.to_owned()));
    }
    Ok(())
}

fn fetch_uid_entries(
    client: &BilibiliHttpClient,
    uid: &str,
    keywords: &[String],
    stop_bvid: Option<&str>,
) -> Result<UidFetchResult, GatchaRepositoryError> {
    let mut output = Vec::new();
    let mut seen = HashSet::new();
    let mut first_bvid = None;
    let page_size = 50usize;
    let mut page = 1usize;
    loop {
        if page > 1 {
            thread::sleep(GATCHA_REQUEST_DELAY);
        }
        let payload = retry_request(
            GATCHA_REQUEST_DELAY,
            |_| true,
            || {
                client.get_wbi_json(
                    SPACE_ARC_URL,
                    BTreeMap::from([
                        ("mid".to_owned(), uid.to_owned()),
                        ("ps".to_owned(), page_size.to_string()),
                        ("tid".to_owned(), "0".to_owned()),
                        ("pn".to_owned(), page.to_string()),
                        ("order".to_owned(), "pubdate".to_owned()),
                        ("platform".to_owned(), "web".to_owned()),
                    ]),
                    "稿件列表拉取失败",
                )
            },
        )?;
        let videos = payload
            .pointer("/data/list/vlist")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        if page == 1 {
            first_bvid = videos
                .iter()
                .filter_map(Value::as_object)
                .find_map(|video| first_text(video, &["bvid"]));
        }
        let reached_checkpoint =
            stop_bvid.is_some_and(|checkpoint| page_contains_bvid(videos, checkpoint));
        for video in videos.iter().filter_map(Value::as_object) {
            let bvid = first_text(video, &["bvid"]).unwrap_or_default();
            let title = first_text(video, &["title"]).unwrap_or_default();
            if bvid.is_empty()
                || title.is_empty()
                || (!keywords.is_empty()
                    && !keywords
                        .iter()
                        .any(|keyword| !keyword.is_empty() && title.contains(keyword)))
                || !seen.insert(bvid.clone())
            {
                continue;
            }
            let owner_name = first_text(video, &["author", "owner_name"]).unwrap_or_default();
            let mut entry = json!({
                "mid": uid,
                "bvid": bvid,
                "title": title,
                "url": format!("https://www.bilibili.com/video/{bvid}"),
            });
            let object = entry.as_object_mut().expect("entry object");
            if !owner_name.is_empty() {
                object.insert("owner_name".to_owned(), Value::String(owner_name));
                object.insert(
                    "owner_url".to_owned(),
                    Value::String(format!("https://space.bilibili.com/{uid}")),
                );
            }
            add_video_extras(object, video);
            output.push(entry);
        }
        if reached_checkpoint || videos.len() < page_size {
            break;
        }
        page += 1;
    }
    Ok(UidFetchResult {
        entries: output,
        first_bvid,
    })
}

fn page_contains_bvid(videos: &[Value], checkpoint: &str) -> bool {
    videos
        .iter()
        .filter_map(Value::as_object)
        .filter_map(|video| first_text(video, &["bvid"]))
        .any(|bvid| bvid == checkpoint)
}

fn fetch_favlist_folders(
    client: &BilibiliHttpClient,
    uid: &str,
) -> Result<Vec<Value>, GatchaRepositoryError> {
    let query = encode_query(&[("up_mid", uid.to_owned()), ("platform", "web".to_owned())]);
    let payload = retry_request(
        FAVLIST_REQUEST_DELAY,
        |error| error.kind == "risk_control",
        || {
            client.get_api_json(
                &format!("{FAVLIST_FOLDERS_URL}?{query}"),
                "收藏夹列表拉取失败",
            )
        },
    )?;
    Ok(payload
        .pointer("/data/list")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default())
}

fn fetch_favlist_entries(
    client: &BilibiliHttpClient,
    uid: &str,
    folder: &Map<String, Value>,
    max_pages: Option<usize>,
) -> Result<Vec<Value>, GatchaRepositoryError> {
    let media_id = folder_id(folder);
    if media_id.is_empty() {
        return Ok(Vec::new());
    }
    let mut output = Vec::new();
    let page_size = 20usize;
    let mut page = 1usize;
    loop {
        if page > 1 {
            thread::sleep(FAVLIST_REQUEST_DELAY);
        }
        let query = encode_query(&[
            ("media_id", media_id.clone()),
            ("platform", "web".to_owned()),
            ("pn", page.to_string()),
            ("ps", page_size.to_string()),
            ("order", "mtime".to_owned()),
            ("type", "0".to_owned()),
        ]);
        let payload = retry_request(
            FAVLIST_REQUEST_DELAY,
            |error| error.kind == "risk_control",
            || {
                client.get_api_json(
                    &format!("{FAVLIST_ITEMS_URL}?{query}"),
                    "收藏夹内容拉取失败",
                )
            },
        )?;
        let data = payload.get("data").and_then(Value::as_object);
        let medias = data
            .and_then(|value| value.get("medias"))
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let folder_title = first_text(folder, &["title"]).unwrap_or_default();
        for media in medias.iter().filter_map(Value::as_object) {
            let bvid = first_text(media, &["bvid"]).unwrap_or_default();
            let title = first_text(media, &["title"]).unwrap_or_default();
            if bvid.is_empty() || title.is_empty() {
                continue;
            }
            let upper = media.get("upper").and_then(Value::as_object);
            let owner_uid = upper
                .and_then(|value| first_text(value, &["mid"]))
                .or_else(|| first_text(media, &["upper_mid"]))
                .unwrap_or_default();
            let owner_name = upper
                .and_then(|value| first_text(value, &["name"]))
                .or_else(|| first_text(media, &["upper_name"]))
                .unwrap_or_default();
            let mut entry = json!({
                "mid": owner_uid,
                "bvid": bvid,
                "title": title,
                "url": format!("https://www.bilibili.com/video/{bvid}"),
                "fav_uid": uid,
                "fav_folder_id": media_id,
                "fav_folder_title": folder_title,
                "source": "favlist",
            });
            let object = entry.as_object_mut().expect("entry object");
            if !owner_name.is_empty() {
                object.insert("owner_name".to_owned(), Value::String(owner_name));
            }
            if !owner_uid.is_empty() {
                object.insert(
                    "owner_url".to_owned(),
                    Value::String(format!("https://space.bilibili.com/{owner_uid}")),
                );
            }
            add_video_extras(object, media);
            output.push(entry);
        }
        let media_count = data
            .and_then(|value| value.get("info"))
            .and_then(Value::as_object)
            .and_then(|value| integer(value, &["media_count"]))
            .unwrap_or(0)
            .max(0) as usize;
        let has_more = data
            .and_then(|value| value.get("has_more"))
            .and_then(Value::as_bool);
        if medias.is_empty()
            || max_pages.is_some_and(|limit| page >= limit)
            || (media_count > 0 && page * page_size >= media_count)
            || (media_count == 0 && medias.len() < page_size)
            || has_more == Some(false)
        {
            break;
        }
        page += 1;
    }
    Ok(output)
}

fn folder_summary(folder: &Map<String, Value>, keywords: &[String]) -> Option<Value> {
    let id = folder_id(folder);
    let title = first_text(folder, &["title"]).unwrap_or_default();
    if id.is_empty() || title.is_empty() {
        return None;
    }
    let normalized = title.to_lowercase().replace(['ｋ', 'Ｋ'], "k");
    Some(json!({
        "id": id,
        "fid": first_text(folder, &["fid"]).unwrap_or_default(),
        "title": title,
        "media_count": integer(folder, &["media_count"]).unwrap_or(0),
        "selected": keywords.iter().any(|keyword| normalized.contains(&keyword.to_lowercase())),
    }))
}

fn public_folder(folder: &Map<String, Value>) -> bool {
    integer(folder, &["attr"]).unwrap_or(0) & 1 == 0
}

fn folder_id(folder: &Map<String, Value>) -> String {
    first_text(folder, &["id", "media_id", "fid"])
        .filter(|value| value.chars().all(|character| character.is_ascii_digit()))
        .unwrap_or_default()
}

fn add_video_extras(target: &mut Map<String, Value>, source: &Map<String, Value>) {
    if let Some(value) = first_text(
        source,
        &["cover_url", "cover", "pic", "pic_url", "thumbnail"],
    ) {
        target.insert("cover_url".to_owned(), Value::String(value));
    }
    let played = first_text(
        source,
        &["played_count", "play_count", "play", "view", "views"],
    )
    .or_else(|| {
        source
            .get("cnt_info")
            .and_then(Value::as_object)
            .and_then(|value| first_text(value, &["play", "view", "played_count"]))
    })
    .or_else(|| {
        source
            .get("stat")
            .and_then(Value::as_object)
            .and_then(|value| first_text(value, &["view", "play", "played_count"]))
    });
    if let Some(value) = played {
        target.insert("played_count".to_owned(), Value::String(value));
    }
    if let Some(value) = duration_text(source.get("duration").or_else(|| source.get("length"))) {
        target.insert("preserved_1".to_owned(), Value::String(value));
    }
}

fn duration_text(value: Option<&Value>) -> Option<String> {
    let value = value?;
    if let Some(seconds) = value.as_u64() {
        return Some(seconds.to_string());
    }
    if let Some(seconds) = value
        .as_f64()
        .filter(|value| value.is_finite() && *value >= 0.0)
    {
        return Some((seconds as u64).to_string());
    }
    let text = value.as_str()?.trim();
    if text.is_empty() {
        return None;
    }
    if text.contains(':') {
        let mut seconds = 0u64;
        for part in text.split(':') {
            seconds = seconds.checked_mul(60)?.checked_add(part.parse().ok()?)?;
        }
        return Some(seconds.to_string());
    }
    text.parse::<f64>()
        .ok()
        .filter(|value| value.is_finite() && *value >= 0.0)
        .map(|value| (value as u64).to_string())
        .or_else(|| Some(text.to_owned()))
}

fn merge_incremental_entries(existing: &[Value], fresh: &[Value]) -> (Vec<Value>, usize) {
    let mut existing = dedupe_entries(existing);
    let indexes: std::collections::HashMap<String, usize> = existing
        .iter()
        .enumerate()
        .filter_map(|(index, entry)| entry_key(entry).map(|key| (key, index)))
        .collect();
    let mut new_entries = Vec::new();
    for fresh_entry in dedupe_entries(fresh) {
        let Some(key) = entry_key(&fresh_entry) else {
            continue;
        };
        if let Some(index) = indexes.get(&key) {
            merge_entry_fields(&mut existing[*index], &fresh_entry);
        } else {
            new_entries.push(fresh_entry);
        }
    }
    let added = new_entries.len();
    new_entries.extend(existing);
    (new_entries, added)
}

fn entry_key(value: &Value) -> Option<String> {
    let entry = value.as_object()?;
    let bvid = first_text(entry, &["bvid"])?;
    let uid = first_text(entry, &["fav_uid"]).unwrap_or_default();
    let folder = first_text(entry, &["fav_folder_id"]).unwrap_or_default();
    Some(if !uid.is_empty() && !folder.is_empty() {
        format!("favlist:{uid}:{folder}:{bvid}")
    } else {
        bvid
    })
}

fn merge_entry_fields(existing: &mut Value, fresh: &Value) {
    let (Some(existing), Some(fresh)) = (existing.as_object_mut(), fresh.as_object()) else {
        return;
    };
    for key in [
        "mid",
        "title",
        "url",
        "owner_name",
        "owner_url",
        "cover_url",
        "preserved_1",
        "preserved_2",
        "preserved_3",
        "preserved_4",
        "preserved_5",
    ] {
        let current = first_text(existing, &[key]).unwrap_or_default();
        if current.is_empty()
            && let Some(value) = fresh.get(key).filter(|value| !value.is_null())
        {
            existing.insert(key.to_owned(), value.clone());
        }
    }
    if let Some(value) = fresh.get("played_count").filter(|value| !value.is_null()) {
        existing.insert("played_count".to_owned(), value.clone());
    }
}

fn encode_query(values: &[(&str, String)]) -> String {
    let mut serializer = form_urlencoded::Serializer::new(String::new());
    for (key, value) in values {
        serializer.append_pair(key, value);
    }
    serializer.finish()
}

fn required_uid(value: &str) -> Result<String, GatchaRepositoryError> {
    normalize_uid(value).ok_or_else(|| error("invalid_request", "UID 格式不正确"))
}

fn valid_profile(value: &Value) -> bool {
    value.as_object().is_some_and(|profile| {
        first_text(profile, &["uid"]).is_some() && first_text(profile, &["name"]).is_some()
    })
}

fn text_value(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(|value| match value {
            Value::String(text) => Some(text.trim().to_owned()),
            Value::Number(number) => Some(number.to_string()),
            _ => None,
        })
        .unwrap_or_default()
}

fn network_error(value: BilibiliServiceError) -> GatchaRepositoryError {
    error(&value.kind, value.message)
}

fn retry_request<T, Retry, Request>(
    delay: Duration,
    should_retry: Retry,
    mut request: Request,
) -> Result<T, GatchaRepositoryError>
where
    Retry: Fn(&BilibiliServiceError) -> bool,
    Request: FnMut() -> Result<T, BilibiliServiceError>,
{
    for attempt in 0..3 {
        match request() {
            Ok(value) => return Ok(value),
            Err(failure) if attempt < 2 && should_retry(&failure) => thread::sleep(delay),
            Err(failure) => return Err(network_error(failure)),
        }
    }
    unreachable!("bounded retry loop always returns")
}

fn draw_candidate(
    paths: &GatchaPaths,
    cookie_available: bool,
) -> Result<Value, GatchaRepositoryError> {
    let uid_payload = uid_snapshot(&paths.uid_file, &[])?;
    let cache = load_cache(&paths.cache_file);
    let favlist = load_favlist(&paths.favlist_file);
    let config = load_pool_config(&paths.pool_config_file);
    let excluded_uids: HashSet<String> = normalized_strings(config.get("excluded_uids"))
        .into_iter()
        .collect();
    let excluded_folders: HashSet<String> =
        normalized_strings(config.get("excluded_favlist_folders"))
            .into_iter()
            .collect();
    let uid_weight = integer_value(config.get("uid_weight"))
        .unwrap_or(50)
        .clamp(0, 100) as u32;
    let favlist_weight = integer_value(config.get("favlist_weight"))
        .unwrap_or(50)
        .clamp(0, 100) as u32;
    let cache_uids = cache.get("uids").and_then(Value::as_object);
    let mut uid_candidates: Vec<(String, Vec<Value>)> = Vec::new();
    for uid in normalized_strings(uid_payload.get("uids")) {
        if uid_weight == 0 || excluded_uids.contains(&uid) {
            continue;
        }
        let entries = cache_uids
            .and_then(|values| values.get(&uid))
            .and_then(Value::as_array)
            .map(|values| valid_entries(values))
            .unwrap_or_default();
        if !entries.is_empty() {
            uid_candidates.push((uid, entries));
        }
    }
    let mut fav_candidates = Vec::new();
    if favlist_weight > 0 {
        for value in array(&favlist, "items") {
            let Some(object) = value.as_object() else {
                continue;
            };
            if expired_entry(object) {
                continue;
            }
            let uid = first_text(object, &["fav_uid"]).unwrap_or_default();
            let folder = first_text(object, &["fav_folder_id"]).unwrap_or_default();
            let compound = if uid.is_empty() {
                folder.clone()
            } else {
                format!("{uid}:{folder}")
            };
            if excluded_folders.contains(&folder) || excluded_folders.contains(&compound) {
                continue;
            }
            fav_candidates.push(value.clone());
        }
    }
    if uid_candidates.is_empty() && fav_candidates.is_empty() {
        return Err(if cookie_available {
            error("empty_pool", "本地稿件缓存还没准备好，请稍后再试")
        } else {
            error("missing_cookie", "请登录 Bilibili 账号或输入 Cookie")
        });
    }
    let choose_favlist = match (uid_candidates.is_empty(), fav_candidates.is_empty()) {
        (true, false) => true,
        (false, true) => false,
        (false, false) => {
            let total = (uid_weight + favlist_weight).max(1);
            random_index(total as usize) < favlist_weight as usize
        }
        (true, true) => false,
    };
    if choose_favlist {
        let chosen = fav_candidates
            .get(random_index(fav_candidates.len()))
            .and_then(Value::as_object)
            .ok_or_else(|| error("empty_pool", "收藏夹卡池没有可用稿件"))?;
        return Ok(candidate_payload(chosen, "favlist", None));
    }
    let (uid, entries) = uid_candidates
        .get(random_index(uid_candidates.len()))
        .ok_or_else(|| error("empty_pool", "UID 卡池没有可用稿件"))?;
    let chosen = entries
        .get(random_index(entries.len()))
        .and_then(Value::as_object)
        .ok_or_else(|| error("empty_pool", "UID 卡池没有可用稿件"))?;
    Ok(candidate_payload(chosen, "cache", Some(uid)))
}

fn search(paths: &GatchaPaths, query: &str, limit: usize) -> Result<Value, GatchaRepositoryError> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(json!({"items": []}));
    }
    let cache = load_cache(&paths.cache_file);
    let favlist = load_favlist(&paths.favlist_file);
    let mut values = all_cache_entries(&cache);
    values.extend(array(&favlist, "items").iter().cloned());
    let items: Vec<Value> = values
        .iter()
        .filter_map(Value::as_object)
        .filter(|entry| {
            first_text(entry, &["title"])
                .unwrap_or_default()
                .to_lowercase()
                .contains(&needle)
        })
        .map(entry_payload)
        .take(limit.clamp(1, 500))
        .collect();
    Ok(json!({"items": items}))
}

fn browse_uid(
    paths: &GatchaPaths,
    selected_uid: &str,
    query: &str,
) -> Result<Value, GatchaRepositoryError> {
    let uid_payload = uid_snapshot(&paths.uid_file, &[])?;
    let cache = load_cache(&paths.cache_file);
    let configured = normalized_strings(uid_payload.get("uids"));
    let profiles = uid_payload.get("profiles").and_then(Value::as_object);
    let cache_profiles = cache.get("profiles").and_then(Value::as_object);
    let cache_uids = cache.get("uids").and_then(Value::as_object);
    let mut owners = Vec::new();
    for uid in &configured {
        let entries = cache_uids
            .and_then(|values| values.get(uid))
            .and_then(Value::as_array)
            .map(|values| dedupe_entries(values))
            .unwrap_or_default();
        let profile = profiles
            .and_then(|values| values.get(uid))
            .and_then(Value::as_object)
            .or_else(|| {
                cache_profiles
                    .and_then(|values| values.get(uid))
                    .and_then(Value::as_object)
            });
        let name = profile
            .and_then(|value| first_text(value, &["name"]))
            .or_else(|| {
                entries
                    .iter()
                    .filter_map(Value::as_object)
                    .find_map(|entry| first_text(entry, &["owner_name", "author"]))
            })
            .unwrap_or_else(|| format!("UID {uid}"));
        owners.push(json!({
            "uid": uid,
            "name": name,
            "space_url": profile.and_then(|value| first_text(value, &["space_url"])).unwrap_or_else(|| format!("https://space.bilibili.com/{uid}")),
            "avatar_url": profile.and_then(|value| first_text(value, &["avatar_url"])).unwrap_or_default(),
            "count": entries.len(),
        }));
    }
    let selected = selected_uid.trim();
    let valid_selected = if configured.iter().any(|uid| uid == selected) {
        selected
    } else {
        ""
    };
    let needle = query.trim().to_lowercase();
    let items = if valid_selected.is_empty() {
        Vec::new()
    } else {
        cache_uids
            .and_then(|values| values.get(valid_selected))
            .and_then(Value::as_array)
            .map(|values| {
                dedupe_entries(values)
                    .iter()
                    .filter_map(Value::as_object)
                    .filter(|entry| {
                        needle.is_empty()
                            || first_text(entry, &["title"])
                                .unwrap_or_default()
                                .to_lowercase()
                                .contains(&needle)
                    })
                    .map(entry_payload)
                    .collect()
            })
            .unwrap_or_default()
    };
    Ok(json!({
        "owners": owners,
        "selected_uid": valid_selected,
        "query": query.trim(),
        "items": items,
        "updated_at": number(&cache, "updated_at"),
    }))
}

fn browse_favlist(
    paths: &GatchaPaths,
    selected_folder: &str,
    query: &str,
) -> Result<Value, GatchaRepositoryError> {
    let payload = load_favlist(&paths.favlist_file);
    let cache = load_cache(&paths.cache_file);
    let uid_payload = uid_snapshot(&paths.uid_file, &[])?;
    let profiles = uid_payload.get("profiles").and_then(Value::as_object);
    let cache_profiles = cache.get("profiles").and_then(Value::as_object);
    let legacy_uid = payload
        .get("uid")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut folders = Vec::new();
    for value in array(&payload, "folders") {
        let Some(folder) = value.as_object() else {
            continue;
        };
        let folder_id = first_text(folder, &["media_id", "id", "fid"]).unwrap_or_default();
        if folder_id.is_empty() {
            continue;
        }
        let uid = first_text(folder, &["uid", "mid"]).unwrap_or_else(|| legacy_uid.to_owned());
        let profile = profiles
            .and_then(|values| values.get(&uid))
            .and_then(Value::as_object)
            .or_else(|| {
                cache_profiles
                    .and_then(|values| values.get(&uid))
                    .and_then(Value::as_object)
            });
        folders.push(json!({
            "id": browser_folder_id(&uid, &folder_id),
            "folder_id": folder_id,
            "fid": first_text(folder, &["fid"]).unwrap_or_default(),
            "title": first_text(folder, &["title"]).unwrap_or_else(|| folder_id.clone()),
            "media_count": integer(folder, &["media_count"]).unwrap_or(0),
            "count": integer(folder, &["media_count"]).unwrap_or(0),
            "uid": uid,
            "avatar_url": profile.and_then(|value| first_text(value, &["avatar_url"])).unwrap_or_default(),
        }));
    }
    let mut selected = selected_folder.trim().to_owned();
    if !selected.is_empty()
        && !folders
            .iter()
            .any(|folder| folder.get("id").and_then(Value::as_str) == Some(&selected))
    {
        let matches: Vec<&Value> = folders
            .iter()
            .filter(|folder| folder.get("folder_id").and_then(Value::as_str) == Some(&selected))
            .collect();
        selected = if matches.len() == 1 {
            matches[0]
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned()
        } else {
            String::new()
        };
    }
    let (selected_uid, selected_id) = split_folder_id(&selected);
    let needle = query.trim().to_lowercase();
    let items: Vec<Value> = if selected.is_empty() {
        Vec::new()
    } else {
        dedupe_entries(array(&payload, "items"))
            .iter()
            .filter_map(Value::as_object)
            .filter(|entry| {
                first_text(entry, &["fav_folder_id"]).as_deref() == Some(selected_id.as_str())
                    && (selected_uid.is_empty()
                        || first_text(entry, &["fav_uid"]).as_deref()
                            == Some(selected_uid.as_str()))
                    && (needle.is_empty()
                        || first_text(entry, &["title"])
                            .unwrap_or_default()
                            .to_lowercase()
                            .contains(&needle))
            })
            .map(entry_payload)
            .collect()
    };
    Ok(json!({
        "folders": folders,
        "selected_folder_id": selected,
        "query": query.trim(),
        "items": items,
        "updated_at": number(&payload, "updated_at"),
    }))
}

fn candidate_payload(entry: &Map<String, Value>, source: &str, uid: Option<&String>) -> Value {
    let mut payload = Map::new();
    payload.insert(
        "mid".to_owned(),
        Value::String(
            uid.cloned()
                .or_else(|| first_text(entry, &["mid"]))
                .unwrap_or_default(),
        ),
    );
    for key in ["bvid", "title", "url"] {
        payload.insert(
            key.to_owned(),
            Value::String(first_text(entry, &[key]).unwrap_or_default()),
        );
    }
    payload.insert("source".to_owned(), Value::String(source.to_owned()));
    for key in ["cover_url", "played_count", "preserved_1"] {
        if let Some(value) = first_text(entry, &[key]) {
            payload.insert(key.to_owned(), Value::String(value));
        }
    }
    Value::Object(payload)
}

fn entry_payload(entry: &Map<String, Value>) -> Value {
    let mut payload = Map::new();
    for (target, keys) in [
        ("mid", &["mid"][..]),
        ("bvid", &["bvid"][..]),
        ("title", &["title"][..]),
        ("url", &["url"][..]),
        ("owner_name", &["owner_name", "author"][..]),
        ("owner_url", &["owner_url"][..]),
    ] {
        payload.insert(
            target.to_owned(),
            Value::String(first_text(entry, keys).unwrap_or_default()),
        );
    }
    for key in [
        "source",
        "fav_uid",
        "fav_folder_id",
        "fav_folder_title",
        "cover_url",
        "played_count",
        "preserved_1",
    ] {
        if let Some(value) = first_text(entry, &[key]) {
            payload.insert(key.to_owned(), Value::String(value));
        }
    }
    Value::Object(payload)
}

fn all_cache_entries(cache: &Value) -> Vec<Value> {
    cache
        .get("uids")
        .and_then(Value::as_object)
        .map(|uids| {
            uids.values()
                .filter_map(Value::as_array)
                .flat_map(|values| values.iter().cloned())
                .collect()
        })
        .unwrap_or_default()
}

fn valid_entries(values: &[Value]) -> Vec<Value> {
    values
        .iter()
        .filter(|value| value.as_object().is_some_and(|entry| !expired_entry(entry)))
        .cloned()
        .collect()
}

fn expired_entry(entry: &Map<String, Value>) -> bool {
    first_text(entry, &["title"]).as_deref() == Some(EXPIRED_VIDEO_TITLE)
}

fn dedupe_entries(values: &[Value]) -> Vec<Value> {
    let mut seen = HashSet::new();
    let mut output = Vec::new();
    for value in values {
        let Some(entry) = value.as_object() else {
            continue;
        };
        let bvid = first_text(entry, &["bvid"]).unwrap_or_default();
        if bvid.is_empty() {
            continue;
        }
        let fav_uid = first_text(entry, &["fav_uid"]).unwrap_or_default();
        let folder_id = first_text(entry, &["fav_folder_id"]).unwrap_or_default();
        let key = if !fav_uid.is_empty() && !folder_id.is_empty() {
            format!("favlist:{fav_uid}:{folder_id}:{bvid}")
        } else {
            bvid
        };
        if seen.insert(key) {
            output.push(value.clone());
        }
    }
    output
}

fn read_object(path: &Path) -> Option<Map<String, Value>> {
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice::<Value>(&bytes)
        .ok()?
        .as_object()
        .cloned()
}

fn atomic_write_json(path: &Path, payload: &Value) -> Result<(), GatchaRepositoryError> {
    let parent = path
        .parent()
        .ok_or_else(|| error("filesystem", "Gacha file has no parent directory"))?;
    fs::create_dir_all(parent).map_err(|value| error("filesystem", value.to_string()))?;
    let suffix = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let temp = parent.join(format!(
        ".{}.{}.{}.tmp",
        path.file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("gatcha"),
        std::process::id(),
        suffix
    ));
    let encoded = serde_json::to_vec_pretty(payload)
        .map_err(|value| error("serialization", value.to_string()))?;
    fs::write(&temp, encoded).map_err(|value| error("filesystem", value.to_string()))?;
    replace_file(&temp, path).map_err(|value| error("filesystem", value.to_string()))
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };

    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    // SAFETY: Both paths are valid, null-terminated UTF-16 buffers for this call.
    let moved = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn normalized_uids(values: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .iter()
        .filter_map(|value| normalize_uid(value))
        .filter(|value| seen.insert(value.clone()))
        .collect()
}

fn normalized_uids_from_value(value: Option<&Value>) -> Vec<String> {
    let values: Vec<String> = value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|value| value.as_str().map(str::to_owned))
        .collect();
    normalized_uids(&values)
}

fn normalize_uid(value: &str) -> Option<String> {
    let trimmed = value.trim().trim_start_matches('0');
    if trimmed.is_empty() || !trimmed.chars().all(|value| value.is_ascii_digit()) {
        return None;
    }
    Some(trimmed.to_owned())
}

fn normalized_strings(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn normalized_strings_slice(values: &[String]) -> Vec<String> {
    values
        .iter()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect()
}

fn clamped_weight(value: Option<&Value>, default: i64) -> i64 {
    integer_value(value).unwrap_or(default).clamp(0, 100)
}

fn integer_value(value: Option<&Value>) -> Option<i64> {
    value.and_then(|value| value.as_i64().or_else(|| value.as_str()?.parse().ok()))
}

fn number(value: &Value, key: &str) -> f64 {
    value
        .get(key)
        .and_then(|value| value.as_f64().or_else(|| value.as_str()?.parse().ok()))
        .unwrap_or(0.0)
}

fn number_map(value: &Map<String, Value>, key: &str) -> f64 {
    value
        .get(key)
        .and_then(|value| value.as_f64().or_else(|| value.as_str()?.parse().ok()))
        .unwrap_or(0.0)
}

fn text_map(value: &Map<String, Value>, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_owned()
}

fn first_text(value: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        value.get(*key).and_then(|value| match value {
            Value::String(text) if !text.trim().is_empty() => Some(text.trim().to_owned()),
            Value::Number(number) => Some(number.to_string()),
            _ => None,
        })
    })
}

fn integer(value: &Map<String, Value>, keys: &[&str]) -> Option<i64> {
    keys.iter().find_map(|key| {
        value
            .get(*key)
            .and_then(|value| value.as_i64().or_else(|| value.as_str()?.parse().ok()))
    })
}

fn array<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn array_map<'a>(value: &'a Map<String, Value>, key: &str) -> &'a [Value] {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn browser_folder_id(uid: &str, folder_id: &str) -> String {
    if uid.is_empty() {
        folder_id.to_owned()
    } else {
        format!("{uid}:{folder_id}")
    }
}

fn split_folder_id(value: &str) -> (String, String) {
    value
        .split_once(':')
        .map(|(uid, folder)| (uid.trim().to_owned(), folder.trim().to_owned()))
        .unwrap_or_else(|| (String::new(), value.trim().to_owned()))
}

fn unix_timestamp() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |duration| duration.as_secs_f64())
}

fn random_index(length: usize) -> usize {
    if length <= 1 {
        return 0;
    }
    let time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_nanos() as u64);
    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let mut value = time ^ counter.rotate_left(17) ^ (std::process::id() as u64);
    value ^= value >> 30;
    value = value.wrapping_mul(0xbf58_476d_1ce4_e5b9);
    value ^= value >> 27;
    value = value.wrapping_mul(0x94d0_49bb_1331_11eb);
    ((value ^ (value >> 31)) as usize) % length
}

fn error(kind: &str, message: impl Into<String>) -> GatchaRepositoryError {
    GatchaRepositoryError {
        kind: kind.to_owned(),
        message: message.into(),
    }
}

fn schema_version() -> u32 {
    1
}

fn default_search_limit() -> usize {
    30
}

fn default_user_agent() -> String {
    "Mozilla/5.0".to_owned()
}

fn default_referer() -> String {
    "https://www.bilibili.com/".to_owned()
}

fn default_timeout_ms() -> u64 {
    20_000
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn paths(root: &Path) -> GatchaPaths {
        GatchaPaths {
            uid_file: root.join("uids.json"),
            cache_file: root.join("cache.json"),
            favlist_file: root.join("favlist.json"),
            pool_config_file: root.join("pool.json"),
        }
    }

    fn temp_root(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "bilikara-gatcha-{name}-{}-{}",
            std::process::id(),
            TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ))
    }

    #[test]
    fn wire_request_deserializes_flattened_operation() {
        let request: GatchaRepositoryRequest = serde_json::from_value(json!({
            "schema_version": 1,
            "paths": {
                "uid_file": "uids.json",
                "cache_file": "cache.json",
                "favlist_file": "favlist.json",
                "pool_config_file": "pool.json"
            },
            "default_uids": ["42"],
            "operation": "candidate",
            "cookie_available": false
        }))
        .expect("wire request");
        assert!(matches!(
            request.operation,
            GatchaOperation::Candidate { .. }
        ));
    }

    #[test]
    fn incremental_merge_keeps_new_items_first_and_existing_order_stable() {
        let existing = vec![
            json!({"bvid": "BV1xx411c7mD", "title": "first", "played_count": "1"}),
            json!({"bvid": "BV1yy411c7mD", "title": "second"}),
        ];
        let fresh = vec![
            json!({"bvid": "BV1zz411c7mD", "title": "new"}),
            json!({"bvid": "BV1xx411c7mD", "title": "replacement", "played_count": "2"}),
        ];
        let (merged, added) = merge_incremental_entries(&existing, &fresh);
        assert_eq!(added, 1);
        assert_eq!(merged[0]["bvid"], "BV1zz411c7mD");
        assert_eq!(merged[1]["bvid"], "BV1xx411c7mD");
        assert_eq!(merged[1]["title"], "first");
        assert_eq!(merged[1]["played_count"], "2");
        assert_eq!(merged[2]["bvid"], "BV1yy411c7mD");
    }

    #[test]
    fn pool_configuration_is_persisted_and_clamped() {
        let root = temp_root("config");
        let paths = paths(&root);
        let request = GatchaRepositoryRequest {
            schema_version: 1,
            paths: paths.clone(),
            default_uids: Vec::new(),
            operation: GatchaOperation::PoolConfigUpdate {
                uid_weight: Some(120),
                favlist_weight: Some(-5),
                excluded_uids: Some(vec![" 42 ".to_owned()]),
                excluded_favlist_folders: Some(vec!["42:7".to_owned()]),
            },
        };
        let updated = execute_gatcha(&request).expect("update config");
        assert_eq!(updated["uid_weight"], 100);
        assert_eq!(updated["favlist_weight"], 0);
        let loaded = load_pool_config(&paths.pool_config_file);
        assert_eq!(loaded["excluded_uids"], json!(["42"]));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn read_only_snapshot_is_not_blocked_by_repository_mutation_lock() {
        let root = temp_root("concurrent-read");
        let paths = paths(&root);
        fs::create_dir_all(&root).expect("create root");
        atomic_write_json(
            &paths.uid_file,
            &json!({"schema_version": 2, "uids": [], "profiles": {}, "updated_at": 1}),
        )
        .expect("write uids");
        atomic_write_json(
            &paths.pool_config_file,
            &json!({"uid_weight": 40, "favlist_weight": 60}),
        )
        .expect("write pool config");
        let request = GatchaRepositoryRequest {
            schema_version: 1,
            paths,
            default_uids: Vec::new(),
            operation: GatchaOperation::PoolConfigSnapshot,
        };
        let mutation_guard = REPOSITORY_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .expect("lock repository mutation");
        let (sender, receiver) = mpsc::channel();
        let worker = thread::spawn(move || {
            sender
                .send(execute_gatcha(&request))
                .expect("send snapshot result");
        });

        let completed_while_mutation_is_active =
            receiver.recv_timeout(Duration::from_millis(250)).is_ok();
        drop(mutation_guard);
        worker.join().expect("join snapshot worker");
        let _ = fs::remove_dir_all(root);
        assert!(
            completed_while_mutation_is_active,
            "read-only Gacha snapshots must not wait for a long network refresh"
        );
    }

    #[test]
    fn refresh_all_network_work_does_not_hold_repository_mutation_lock() {
        let operation = GatchaOperation::RefreshAll {
            cookie: "cookie".to_owned(),
            keywords: Vec::new(),
            user_agent: "agent".to_owned(),
            referer: "referer".to_owned(),
            timeout_ms: 1_000,
        };
        assert!(!requires_mutation_lock(&operation));
    }

    #[test]
    fn refreshed_uid_is_persisted_without_overwriting_concurrent_cache_changes() {
        let root = temp_root("refresh-persistence");
        let paths = paths(&root);
        fs::create_dir_all(&root).expect("create root");
        atomic_write_json(
            &paths.uid_file,
            &json!({"schema_version": 2, "uids": ["1", "2"], "profiles": {}, "updated_at": 1}),
        )
        .expect("write uids");
        atomic_write_json(
            &paths.cache_file,
            &json!({
                "schema_version": 3,
                "uids": {
                    "1": [{"bvid": "BVCONCURRENT", "title": "concurrent"}],
                    "2": [{"bvid": "BVOTHER", "title": "other"}]
                },
                "profiles": {},
                "updated_at": 1
            }),
        )
        .expect("write cache");

        let (added, total) = persist_refreshed_uid(
            &paths,
            "1",
            &json!({"uid": "1", "name": "owner", "space_url": "https://space.bilibili.com/1"}),
            &[],
            &[json!({"bvid": "BVFRESH", "title": "fresh"})],
            Some("BVFRESH"),
            false,
        )
        .expect("persist refreshed uid");

        let cache = read_object(&paths.cache_file).expect("read cache");
        assert_eq!(added, 1);
        assert_eq!(total, 2);
        assert_eq!(cache["uids"]["1"][0]["bvid"], "BVFRESH");
        assert_eq!(cache["uids"]["1"][1]["bvid"], "BVCONCURRENT");
        assert_eq!(cache["uids"]["2"][0]["bvid"], "BVOTHER");
        assert_eq!(cache["profiles"]["1"]["name"], "owner");
        assert_eq!(cache["uid_checkpoints"]["1"], "BVFRESH");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn legacy_checkpoint_uses_the_entry_before_the_last_incremental_additions() {
        let cache = json!({
            "uid_checkpoints": {},
            "refresh_summary": {
                "uids": [{
                    "uid": "42",
                    "mode": "incremental",
                    "added_count": 1
                }]
            }
        });
        let existing = vec![
            json!({"bvid": "BVNEW0000001", "title": "new"}),
            json!({"bvid": "BVOLD0000001", "title": "old boundary"}),
        ];

        assert_eq!(
            uid_refresh_checkpoint(&cache, "42", &existing).as_deref(),
            Some("BVOLD0000001")
        );
    }

    #[test]
    fn persisted_checkpoint_takes_priority_over_legacy_refresh_summary() {
        let cache = json!({
            "uid_checkpoints": {"42": "BVRAW0000001"},
            "refresh_summary": {
                "uids": [{"uid": "42", "mode": "incremental", "added_count": 1}]
            }
        });
        let existing = vec![
            json!({"bvid": "BVNEW0000001", "title": "new"}),
            json!({"bvid": "BVOLD0000001", "title": "old boundary"}),
        ];

        assert_eq!(
            uid_refresh_checkpoint(&cache, "42", &existing).as_deref(),
            Some("BVRAW0000001")
        );
    }

    #[test]
    fn refresh_checkpoints_are_frozen_before_progress_summary_is_replaced() {
        let mut cache = json!({
            "uids": {
                "42": [
                    {"bvid": "BVNEW0000001", "title": "new"},
                    {"bvid": "BVOLD0000001", "title": "old boundary"}
                ]
            },
            "uid_checkpoints": {},
            "refresh_summary": {
                "uids": [{"uid": "42", "mode": "incremental", "added_count": 1}]
            }
        });
        let checkpoints = uid_refresh_checkpoints(&cache, &["42".to_owned()]);
        cache["refresh_summary"] = json!({"uids": []});

        assert_eq!(
            checkpoints.get("42").and_then(Option::as_deref),
            Some("BVOLD0000001")
        );
        assert_eq!(
            uid_refresh_checkpoint(&cache, "42", cache["uids"]["42"].as_array().unwrap())
                .as_deref(),
            Some("BVNEW0000001")
        );
    }

    #[test]
    fn checkpoint_detection_uses_raw_posts_before_keyword_filtering() {
        let videos = vec![
            json!({"bvid": "BVNEW0000001", "title": "karaoke new"}),
            json!({"bvid": "BVRAW0000001", "title": "ordinary upload"}),
        ];

        assert!(page_contains_bvid(&videos, "BVRAW0000001"));
    }

    #[test]
    fn refresh_progress_is_visible_before_refresh_finishes() {
        let root = temp_root("refresh-progress");
        let paths = paths(&root);
        fs::create_dir_all(&root).expect("create root");

        persist_refresh_summary(&paths, &[], &[], "", false, 3).expect("persist refresh progress");

        let cache = read_object(&paths.cache_file).expect("read refresh progress");
        assert_eq!(cache["refresh_summary"]["completed"], false);
        assert_eq!(cache["refresh_summary"]["completed_count"], 0);
        assert_eq!(cache["refresh_summary"]["total_count"], 3);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn candidate_respects_exclusions_and_expired_titles() {
        let root = temp_root("candidate");
        let paths = paths(&root);
        fs::create_dir_all(&root).expect("create root");
        atomic_write_json(
            &paths.uid_file,
            &json!({"schema_version": 2, "uids": ["1", "2"], "profiles": {}, "updated_at": 1}),
        )
        .expect("write uids");
        atomic_write_json(
            &paths.cache_file,
            &json!({"schema_version": 3, "uids": {
                "1": [{"bvid": "BVDEAD", "title": EXPIRED_VIDEO_TITLE, "url": "dead"}],
                "2": [{"bvid": "BVLIVE", "title": "live", "url": "live"}]
            }, "profiles": {}, "updated_at": 1}),
        )
        .expect("write cache");
        atomic_write_json(
            &paths.pool_config_file,
            &json!({"uid_weight": 100, "favlist_weight": 0, "excluded_uids": ["1"]}),
        )
        .expect("write config");
        let result = draw_candidate(&paths, true).expect("draw candidate");
        assert_eq!(result["bvid"], "BVLIVE");
        assert_eq!(result["mid"], "2");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn favlist_entries_are_deduplicated_per_folder() {
        let values = vec![
            json!({"bvid": "BV1", "fav_uid": "1", "fav_folder_id": "2"}),
            json!({"bvid": "BV1", "fav_uid": "1", "fav_folder_id": "2"}),
            json!({"bvid": "BV1", "fav_uid": "1", "fav_folder_id": "3"}),
        ];
        assert_eq!(dedupe_entries(&values).len(), 2);
    }
}
