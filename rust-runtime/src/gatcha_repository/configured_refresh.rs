//! Task-only repository entry. The legacy schema trigger is explicit; native
//! Hosts never opt into rebuilding or indexing an old desktop library.
use super::*;
use crate::gatcha_refresh::{RebuildPaths, RefreshRequest};

pub(crate) fn execute_configured_refresh(
    request: &RefreshRequest,
    control: &RefreshControl,
    notify: &dyn Fn(Value),
) -> Result<Value, GatchaRepositoryError> {
    let repository = &request.repository;
    if repository.schema_version != 1 {
        return Err(error("invalid_request", "unsupported schema version"));
    }
    let GatchaOperation::RefreshAll {
        cookie,
        keywords,
        user_agent,
        referer,
        timeout_ms,
    } = &repository.operation
    else {
        return Err(error(
            "invalid_request",
            "expected configured-source refresh",
        ));
    };
    if cookie.is_empty() {
        return Err(error("missing_cookie", "请登录 Bilibili 账号或输入 Cookie"));
    }
    control.check()?;
    let client = network_client(cookie, user_agent, referer, *timeout_ms)?;
    let rebuild = request
        .rebuild
        .as_ref()
        .filter(|paths| rebuild_needed(&repository.paths, paths));
    control.commit(|| uid_snapshot(&repository.paths.uid_file, &repository.default_uids))?;
    if let Some(paths) = rebuild {
        rebuild_schema(repository, paths, keywords, &client, control, notify)
    } else {
        refresh_all(&repository.paths, keywords, &client, control)
    }
}

fn rebuild_needed(paths: &GatchaPaths, temp: &RebuildPaths) -> bool {
    [
        &temp.uid_temp,
        &temp.cache_temp,
        &temp.favlist_temp,
        &temp.progress,
    ]
    .iter()
    .any(|p| p.exists())
        || [
            (&paths.uid_file, UID_SCHEMA_VERSION),
            (&paths.cache_file, CACHE_SCHEMA_VERSION),
            (&paths.favlist_file, FAVLIST_SCHEMA_VERSION),
        ]
        .iter()
        .any(|(path, version)| {
            path.exists()
                && read_object(path)
                    .and_then(|p| p.get("schema_version").and_then(Value::as_u64))
                    .unwrap_or(0)
                    < *version
        })
}

fn rebuild_schema(
    request: &GatchaRepositoryRequest,
    temp: &RebuildPaths,
    keywords: &[String],
    client: &BilibiliHttpClient,
    control: &RefreshControl,
    notify: &dyn Fn(Value),
) -> Result<Value, GatchaRepositoryError> {
    let paths = &request.paths;
    let current = uid_snapshot(&paths.uid_file, &request.default_uids)?;
    let configured = normalized_strings(current.get("uids"));
    let mut uid_temp = control.commit(|| uid_snapshot(&temp.uid_temp, &configured))?;
    uid_temp
        .as_object_mut()
        .expect("UID snapshot")
        .remove("count");
    uid_temp["schema_version"] = json!(UID_SCHEMA_VERSION);
    uid_temp["uids"] = json!(configured);
    let mut cache_temp = load_cache(&temp.cache_temp);
    let mut progress = Value::Object(read_object(&temp.progress).unwrap_or_default());
    let mut completed = normalized_strings(progress.get("completed_uids"));
    let mut completed_folders = normalized_strings(progress.get("completed_folders"));
    progress["schema_version"] = json!({"uids":UID_SCHEMA_VERSION,"cache":CACHE_SCHEMA_VERSION,"favlist":FAVLIST_SCHEMA_VERSION});
    progress["uid_total"] = json!(configured.len());
    if progress["started_at"].as_f64().is_none() {
        progress["started_at"] = json!(unix_timestamp());
    }
    for (index, uid) in configured.iter().enumerate() {
        control.check()?;
        if completed.contains(uid) {
            continue;
        }
        progress["phase"] = json!("uid");
        progress["current_uid"] = json!(uid);
        progress["uid_index"] = json!(index + 1);
        control.commit(|| atomic_write_json(&temp.progress, &progress))?;
        notify(progress.clone());
        let profile = fetch_profile(client, uid)?;
        let fresh = fetch_uid_entries_controlled(client, uid, keywords, None, control)?;
        uid_temp["profiles"][uid] = profile.clone();
        cache_temp["profiles"][uid] = profile;
        cache_temp["uids"][uid] = json!(dedupe_entries(&fresh.entries));
        completed.push(uid.clone());
        progress["completed_uids"] = json!(completed);
        control.commit(|| {
            atomic_write_json(&temp.uid_temp, &uid_temp)?;
            atomic_write_json(&temp.cache_temp, &cache_temp)?;
            atomic_write_json(&temp.progress, &progress)
        })?;
    }
    let current_favlist = load_favlist(&paths.favlist_file);
    let mut fav_temp = if let Some(raw) = read_object(&temp.favlist_temp) {
        let mut value = load_favlist(&temp.favlist_temp);
        if !raw.get("folders").is_some_and(Value::is_array) {
            value["folders"] = current_favlist["folders"].clone();
        }
        if text_value(&value, "uid").is_empty() {
            value["uid"] = current_favlist["uid"].clone();
        }
        if array(&value, "uids").is_empty() {
            value["uids"] = current_favlist["uids"].clone();
        }
        value
    } else {
        let mut value = current_favlist;
        value["items"] = json!([]);
        value
    };
    let folders = array(&fav_temp, "folders").to_vec();
    progress["phase"] = json!("favlist");
    progress["favlist_total"] = json!(folders.len());
    for (index, folder) in folders.iter().filter_map(Value::as_object).enumerate() {
        let uid =
            first_text(folder, &["uid", "mid"]).unwrap_or_else(|| text_value(&fav_temp, "uid"));
        let id = folder_id(folder);
        let key = format!("{uid}:{id}");
        if uid.is_empty() || id.is_empty() || completed_folders.contains(&key) {
            continue;
        }
        progress["current_folder_id"] = json!(id);
        progress["favlist_index"] = json!(index + 1);
        control.commit(|| atomic_write_json(&temp.progress, &progress))?;
        notify(progress.clone());
        let mut entries = array(&fav_temp, "items").to_vec();
        entries.extend(fetch_favlist_entries_controlled(
            client, &uid, folder, None, control,
        )?);
        fav_temp["items"] = json!(dedupe_entries(&entries));
        completed_folders.push(key);
        progress["completed_folders"] = json!(completed_folders);
        control.commit(|| {
            atomic_write_json(&temp.favlist_temp, &fav_temp)?;
            atomic_write_json(&temp.progress, &progress)
        })?;
    }
    control.commit(|| {
        let _guard = repository_guard()?;
        // Keep source edits made during the nonblocking startup rebuild. As in
        // the old adapter, rebuilt values win for already rebuilt UID keys.
        let latest_uid = uid_snapshot(&paths.uid_file, &[])?;
        let mut all_uids = configured.clone();
        for uid in normalized_strings(latest_uid.get("uids")) {
            if !all_uids.contains(&uid) {
                all_uids.push(uid);
            }
        }
        uid_temp["uids"] = json!(all_uids);
        merge_missing(&mut uid_temp, &latest_uid, "profiles");
        let latest_cache = load_cache(&paths.cache_file);
        merge_missing(&mut cache_temp, &latest_cache, "uids");
        merge_missing(&mut cache_temp, &latest_cache, "profiles");
        for payload in [&mut uid_temp, &mut cache_temp, &mut fav_temp] {
            payload["updated_at"] = json!(unix_timestamp());
        }
        atomic_write_json(&temp.uid_temp, &uid_temp)?;
        atomic_write_json(&temp.cache_temp, &cache_temp)?;
        atomic_write_json(&temp.favlist_temp, &fav_temp)?;
        // Existing contract is per-file atomic replacement, not a multi-file
        // transaction. Keep checkpoints until all three publishes succeed.
        for (source, destination) in [
            (&temp.uid_temp, &paths.uid_file),
            (&temp.cache_temp, &paths.cache_file),
            (&temp.favlist_temp, &paths.favlist_file),
        ] {
            let value = read_object(source)
                .ok_or_else(|| error("storage", "missing rebuild checkpoint"))?;
            atomic_write_json(destination, &Value::Object(value))?;
        }
        for path in [
            &temp.uid_temp,
            &temp.cache_temp,
            &temp.favlist_temp,
            &temp.progress,
        ] {
            if path.exists() {
                fs::remove_file(path)
                    .map_err(|_| error("storage", "cannot remove rebuild checkpoint"))?;
            }
        }
        Ok(())
    })?;
    let rows: Vec<Value> = cache_temp["uids"]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(uid, entries)| {
            let count = entries.as_array().map_or(0, Vec::len);
            json!({"uid":uid,"mode":"rebuild","added_count":count,"total_count":count})
        })
        .collect();
    cache_temp["refresh_summary"] = json!({"uids":rows,"errors":[],"favlist_error":""});
    cache_temp["rebuild"] =
        json!({"completed":true,"uid_count":configured.len(),"favlist_folder_count":folders.len()});
    cache_temp["favlist_entries"] = fav_temp["items"].clone();
    Ok(cache_temp)
}

fn merge_missing(target: &mut Value, source: &Value, field: &str) {
    if let Some(source) = source[field].as_object() {
        for (key, value) in source {
            target[field]
                .as_object_mut()
                .expect("normalized repository object")
                .entry(key.clone())
                .or_insert_with(|| value.clone());
        }
    }
}
