//! Local source removal only. Never invokes Bilibili, the catalog, or media cache.
use super::*;

fn numeric(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 24
        && !value.starts_with('0')
        && value.bytes().all(|v| v.is_ascii_digit())
}

pub(crate) fn validate_source_removal(source: &str, id: &str) -> Result<(), GatchaRepositoryError> {
    let valid = match source {
        "uid" => numeric(id),
        "favlist" => {
            numeric(id)
                || id
                    .split_once(':')
                    .is_some_and(|(uid, folder)| numeric(uid) && numeric(folder))
        }
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(error("invalid_request", "Invalid local Gacha source"))
    }
}

// Destructive edits must not treat unreadable/corrupt existing data as empty.
fn read_for_removal(path: &Path) -> Result<Value, GatchaRepositoryError> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(json!({})),
        Err(e) => return Err(error("filesystem", e.to_string())),
    };
    serde_json::from_slice::<Value>(&bytes)
        .ok()
        .filter(Value::is_object)
        .ok_or_else(|| {
            error(
                "invalid_data",
                "Local Gacha file is damaged; removal was not saved",
            )
        })
}

fn check_field(value: &Value, key: &str, array: bool) -> Result<(), GatchaRepositoryError> {
    if value
        .get(key)
        .is_none_or(|v| if array { v.is_array() } else { v.is_object() })
    {
        Ok(())
    } else {
        Err(error(
            "invalid_data",
            format!("Invalid local Gacha field: {key}"),
        ))
    }
}

pub(super) fn remove_source(
    paths: &GatchaPaths,
    source: &str,
    id: &str,
) -> Result<Value, GatchaRepositoryError> {
    validate_source_removal(source, id)?;
    if source == "uid" {
        remove_uid(paths, id)
    } else {
        remove_folder(paths, id)
    }
}

fn remove_uid(paths: &GatchaPaths, uid: &str) -> Result<Value, GatchaRepositoryError> {
    let mut configured = read_for_removal(&paths.uid_file)?;
    let mut cache = read_for_removal(&paths.cache_file)?;
    check_field(&configured, "uids", true)?;
    check_field(&configured, "profiles", false)?;
    for key in ["uids", "profiles", "uid_checkpoints"] {
        check_field(&cache, key, false)?;
    }
    let removed = array(&configured, "uids")
        .iter()
        .any(|v| v.as_str() == Some(uid));
    let count = cache["uids"][uid].as_array().map_or(0, Vec::len);
    configured["uids"] = json!(
        array(&configured, "uids")
            .iter()
            .filter(|v| v.as_str() != Some(uid))
            .cloned()
            .collect::<Vec<_>>()
    );
    if configured.get("profiles").is_none() {
        configured["profiles"] = json!({});
    }
    if let Some(profiles) = configured
        .get_mut("profiles")
        .and_then(Value::as_object_mut)
    {
        profiles.remove(uid);
    }
    for key in ["uids", "profiles", "uid_checkpoints"] {
        if let Some(values) = cache.get_mut(key).and_then(Value::as_object_mut) {
            values.remove(uid);
        }
    }
    let timestamp = unix_timestamp();
    configured["schema_version"] = json!(UID_SCHEMA_VERSION);
    configured["updated_at"] = json!(timestamp);
    cache["updated_at"] = json!(timestamp);
    // Configuration is the authoritative membership list. Commit it first:
    // even if cache cleanup fails or the process stops, stale cached rows cannot
    // re-enter browsing/draw/refresh. A retry also cleans orphaned cached rows.
    atomic_write_json(&paths.uid_file, &configured)?;
    if paths.cache_file.exists() {
        atomic_write_json(&paths.cache_file, &cache)?;
    }
    Ok(
        json!({"operation":"remove_source","source":"uid","id":uid,"uid":uid,"removed":removed,"removed_count":count,"updated_at":timestamp}),
    )
}

fn remove_folder(paths: &GatchaPaths, selector: &str) -> Result<Value, GatchaRepositoryError> {
    let mut payload = read_for_removal(&paths.favlist_file)?;
    for key in ["folders", "items", "uids"] {
        check_field(&payload, key, true)?;
    }
    let legacy_uid = payload["uid"].as_str().unwrap_or_default().to_owned();
    let folder_key = |v: &Value| {
        v.as_object().map(|m| {
            (
                first_text(m, &["uid", "mid"]).unwrap_or_else(|| legacy_uid.clone()),
                first_text(m, &["media_id", "id", "fid"]).unwrap_or_default(),
            )
        })
    };
    let (mut uid, folder_id) = split_folder_id(selector);
    if uid.is_empty() {
        let owners: BTreeSet<_> = array(&payload, "folders")
            .iter()
            .filter_map(&folder_key)
            .filter(|(_, id)| id == &folder_id)
            .map(|(uid, _)| uid)
            .collect();
        if owners.len() > 1 {
            return Err(error(
                "invalid_request",
                "Ambiguous favorite folder; include its owner",
            ));
        }
        uid = owners.into_iter().next().unwrap_or_default();
    }
    let before = array(&payload, "folders").len();
    payload["folders"] = json!(
        array(&payload, "folders")
            .iter()
            .filter(|v| folder_key(v) != Some((uid.clone(), folder_id.clone())))
            .cloned()
            .collect::<Vec<_>>()
    );
    let removed = array(&payload, "folders").len() != before;
    let before_items = array(&payload, "items").len();
    payload["items"] = json!(
        array(&payload, "items")
            .iter()
            .filter(|v| {
                v.as_object().is_none_or(|m| {
                    first_text(m, &["fav_folder_id"]).as_deref() != Some(&folder_id)
                        || first_text(m, &["fav_uid"]).unwrap_or_else(|| legacy_uid.clone()) != uid
                })
            })
            .cloned()
            .collect::<Vec<_>>()
    );
    let count = before_items - array(&payload, "items").len();
    let mut owners: BTreeSet<String> = array(&payload, "folders")
        .iter()
        .filter_map(folder_key)
        .map(|(uid, _)| uid)
        .collect();
    owners.extend(
        array(&payload, "items")
            .iter()
            .filter_map(Value::as_object)
            .map(|v| first_text(v, &["fav_uid"]).unwrap_or_else(|| legacy_uid.clone())),
    );
    owners.remove("");
    payload["uids"] = json!(owners);
    // Keep the legacy fallback only while remaining records may depend on it.
    if !owners.contains(&legacy_uid) {
        payload["uid"] = json!("");
    }
    let timestamp = unix_timestamp();
    payload["updated_at"] = json!(timestamp);
    if paths.favlist_file.exists() {
        atomic_write_json(&paths.favlist_file, &payload)?;
    }
    Ok(
        json!({"operation":"remove_source","source":"favlist","id":browser_folder_id(&uid,&folder_id),"uid":uid,"folder_id":folder_id,"removed":removed,"removed_count":count,"updated_at":timestamp}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        root: PathBuf,
        paths: GatchaPaths,
    }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "bilikara-source-removal-{}-{}",
                std::process::id(),
                TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&root).unwrap();
            let paths = GatchaPaths {
                uid_file: root.join("uids.json"),
                cache_file: root.join("cache.json"),
                favlist_file: root.join("favorites.json"),
                pool_config_file: root.join("pool.json"),
            };
            initialize_native_uids(&paths, &["42".into(), "43".into()]).unwrap();
            atomic_write_json(&paths.cache_file, &json!({"schema_version":3,"uids":{"42":[{"bvid":"BVshared","title":"Shared"}],"43":[{"bvid":"BVshared","title":"Shared"}]},"profiles":{"42":{"name":"One"},"43":{"name":"Two"}},"uid_checkpoints":{"42":{"first_bvid":"BVshared"},"43":{"first_bvid":"BVshared"}}})).unwrap();
            atomic_write_json(&paths.favlist_file, &json!({"schema_version":2,"uid":"42","uids":["42","43"],"folders":[{"uid":"42","id":"10"},{"uid":"42","media_id":"11"},{"uid":"43","id":"10"}],"items":[{"bvid":"BVshared","title":"Shared","fav_uid":"42","fav_folder_id":"10"},{"bvid":"BVshared","title":"Shared","fav_uid":"42","fav_folder_id":"11"},{"bvid":"BVshared","title":"Shared","fav_uid":"43","fav_folder_id":"10"}]})).unwrap();
            Self { root, paths }
        }
        fn remove(&self, source: &str, id: &str) -> Result<Value, GatchaRepositoryError> {
            execute_gatcha(&GatchaRepositoryRequest {
                schema_version: 1,
                paths: self.paths.clone(),
                default_uids: vec!["42".into(), "43".into()],
                operation: GatchaOperation::RemoveSource {
                    source: source.into(),
                    id: id.into(),
                },
            })
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.root).unwrap();
        }
    }

    #[test]
    fn uid_removal_keeps_other_sources_and_stays_removed_after_restart() {
        let fixture = Fixture::new();
        let favorites = fs::read(&fixture.paths.favlist_file).unwrap();
        assert_eq!(fixture.remove("uid", "42").unwrap()["removed_count"], 1);
        let cache = read_for_removal(&fixture.paths.cache_file).unwrap();
        for key in ["uids", "profiles", "uid_checkpoints"] {
            assert!(cache[key].get("42").is_none());
            assert!(cache[key].get("43").is_some());
        }
        assert_eq!(fs::read(&fixture.paths.favlist_file).unwrap(), favorites);
        assert_eq!(fixture.remove("uid", "42").unwrap()["removed"], false);
        fixture.remove("uid", "43").unwrap();
        initialize_native_uids(&fixture.paths, &["42".into(), "43".into()]).unwrap();
        assert_eq!(
            uid_snapshot(&fixture.paths.uid_file, &[]).unwrap()["uids"],
            json!([])
        );
        assert_eq!(
            browse_uid(&fixture.paths, "42", "", 0, 100).unwrap()["selected_uid"],
            ""
        );
    }

    #[test]
    fn favorite_removal_is_scoped_by_owner_and_folder_not_bvid() {
        let fixture = Fixture::new();
        let cache = fs::read(&fixture.paths.cache_file).unwrap();
        assert!(
            fixture.remove("favlist", "10").is_err(),
            "ambiguous legacy id must not delete two owners"
        );
        assert_eq!(
            fixture.remove("favlist", "42:10").unwrap()["removed_count"],
            1
        );
        let saved = read_for_removal(&fixture.paths.favlist_file).unwrap();
        assert_eq!(array(&saved, "items").len(), 2);
        assert_eq!(saved["items"][0]["fav_folder_id"], "11");
        assert_eq!(saved["items"][1]["fav_uid"], "43");
        assert_eq!(fs::read(&fixture.paths.cache_file).unwrap(), cache);
        fixture.remove("favlist", "11").unwrap();
        assert_eq!(
            read_for_removal(&fixture.paths.favlist_file).unwrap()["uids"],
            json!(["43"])
        );
        assert_eq!(
            fixture.remove("favlist", "42:10").unwrap()["removed"],
            false
        );
        assert_eq!(
            browse_favlist(&fixture.paths, "42:10", "", 0, 100).unwrap()["selected_folder_id"],
            ""
        );
    }

    #[test]
    fn legacy_favorite_membership_is_preserved_and_empty_owner_does_not_refresh() {
        let fixture = Fixture::new();
        atomic_write_json(&fixture.paths.favlist_file,&json!({"uid":"42","folders":[{"id":10},{"id":11}],"items":[{"bvid":"BVshared","fav_folder_id":"10"},{"bvid":"BVshared","fav_folder_id":"11"}]})).unwrap();
        fixture.remove("favlist", "42:10").unwrap();
        let saved = read_for_removal(&fixture.paths.favlist_file).unwrap();
        assert_eq!(saved["uid"], "42");
        assert_eq!(saved["items"][0]["fav_folder_id"], "11");
        fixture.remove("favlist", "42:11").unwrap();
        let saved = read_for_removal(&fixture.paths.favlist_file).unwrap();
        assert_eq!(saved["uid"], "");
        assert_eq!(saved["uids"], json!([]));
        assert_eq!(saved["folders"], json!([]));
        assert_eq!(saved["items"], json!([]));
    }

    #[test]
    fn corrupt_file_and_invalid_target_never_replace_local_data() {
        let fixture = Fixture::new();
        let uids = fs::read(&fixture.paths.uid_file).unwrap();
        fs::write(&fixture.paths.cache_file, b"{broken").unwrap();
        assert!(fixture.remove("uid", "42").is_err());
        assert_eq!(fs::read(&fixture.paths.uid_file).unwrap(), uids);
        assert_eq!(fs::read(&fixture.paths.cache_file).unwrap(), b"{broken");
        for (source, id) in [
            ("d1", "42"),
            ("uid", "../42"),
            ("favlist", "42:10:11"),
            ("uid", ""),
            ("uid", "0"),
        ] {
            assert!(fixture.remove(source, id).is_err());
        }
        fs::write(
            &fixture.paths.favlist_file,
            br#"{"folders":"broken","items":[]}"#,
        )
        .unwrap();
        let before = fs::read(&fixture.paths.favlist_file).unwrap();
        assert!(fixture.remove("favlist", "42:10").is_err());
        assert_eq!(fs::read(&fixture.paths.favlist_file).unwrap(), before);
        fs::write(&fixture.paths.uid_file, b"{broken-uids").unwrap();
        assert!(fixture.remove("uid", "42").is_err());
        assert_eq!(fs::read(&fixture.paths.uid_file).unwrap(), b"{broken-uids");
    }

    #[test]
    fn deleting_a_favorite_does_not_seed_unrelated_uid_defaults() {
        let fixture = Fixture::new();
        fs::remove_file(&fixture.paths.uid_file).unwrap();
        fixture.remove("favlist", "42:10").unwrap();
        assert!(!fixture.paths.uid_file.exists());
    }

    #[test]
    fn missing_optional_metadata_remains_valid_for_subsequent_removals() {
        let fixture = Fixture::new();
        atomic_write_json(&fixture.paths.uid_file, &json!({"uids":["42","43"]})).unwrap();
        atomic_write_json(
            &fixture.paths.cache_file,
            &json!({"uids":{"42":[],"43":[]}}),
        )
        .unwrap();
        fixture.remove("uid", "42").unwrap();
        fixture.remove("uid", "43").unwrap();
        let cache = read_for_removal(&fixture.paths.cache_file).unwrap();
        assert!(cache.get("profiles").is_none());
        assert!(cache.get("uid_checkpoints").is_none());
        assert_eq!(
            read_for_removal(&fixture.paths.uid_file).unwrap()["profiles"],
            json!({})
        );
        initialize_native_uids(&fixture.paths, &["42".into(), "43".into()]).unwrap();
        assert_eq!(
            uid_snapshot(&fixture.paths.uid_file, &[]).unwrap()["uids"],
            json!([])
        );
    }
}
