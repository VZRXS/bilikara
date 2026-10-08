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
pub(super) fn read_for_removal(path: &Path) -> Result<Value, GatchaRepositoryError> {
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

pub(super) fn check_field(
    value: &Value,
    key: &str,
    array: bool,
) -> Result<(), GatchaRepositoryError> {
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

pub(super) fn folder_identity(value: &Value, legacy_uid: &str) -> Option<(String, String)> {
    value.as_object().map(|m| {
        (
            first_text(m, &["uid", "mid"]).unwrap_or_else(|| legacy_uid.to_owned()),
            first_text(m, &["media_id", "id", "fid"]).unwrap_or_default(),
        )
    })
}

pub(super) fn remove_source(
    paths: &GatchaPaths,
    source: &str,
    id: &str,
) -> Result<Value, GatchaRepositoryError> {
    let mut result = remove_sources(paths, source, &[id.to_owned()], None)?;
    let removal = result["removals"][0]
        .as_object()
        .cloned()
        .unwrap_or_default();
    result.as_object_mut().unwrap().extend(removal);
    result["operation"] = json!("remove_source");
    Ok(result)
}

pub(super) fn remove_sources(
    paths: &GatchaPaths,
    source: &str,
    ids: &[String],
    expected_version: Option<&str>,
) -> Result<Value, GatchaRepositoryError> {
    remove_sources_with_writer(paths, source, ids, expected_version, &mut atomic_write_json)
}

/// Explicit repair of a previously committed deletion. A source that has
/// since been re-added must never be removed by an old cleanup request.
pub(super) fn cleanup_sources(
    paths: &GatchaPaths,
    source: &str,
    ids: &[String],
    expected_version: &str,
) -> Result<Value, GatchaRepositoryError> {
    let members = source_order::members(paths, source)?;
    let order = source_order::read(paths)?;
    if source_order::version(source, &members, &order) != expected_version {
        return Err(error(
            "stale_source_version",
            "Sources changed; reload before cleanup",
        ));
    }
    if ids.iter().any(|id| members.contains(id)) {
        return Err(error(
            "unknown_source",
            "A source was re-added; cleanup was cancelled",
        ));
    }
    let mut result = remove_sources(paths, source, ids, None)?;
    result["operation"] = json!("source_cleanup");
    Ok(result)
}

type WriteJson<'a> = dyn FnMut(&Path, &Value) -> Result<(), GatchaRepositoryError> + 'a;

// One repository lock/lease surrounds this entire set, not one lease per ID.
// Membership publishes first. Subsequent cleanup failures return its committed
// truth; atomic replacement of each file is not a cross-file transaction.
fn remove_sources_with_writer(
    paths: &GatchaPaths,
    source: &str,
    selectors: &[String],
    expected_version: Option<&str>,
    write: &mut WriteJson<'_>,
) -> Result<Value, GatchaRepositoryError> {
    if selectors.is_empty()
        || selectors.len() > source_order::MAX_BATCH
        || selectors.iter().collect::<HashSet<_>>().len() != selectors.len()
    {
        return Err(error("invalid_request", "Invalid source batch"));
    }
    for id in selectors {
        validate_source_removal(source, id)?;
    }
    let membership_path = if source == "uid" {
        &paths.uid_file
    } else {
        &paths.favlist_file
    };
    let mut payload = read_for_removal(membership_path)?;
    let mut cache = if source == "uid" {
        Some(read_for_removal(&paths.cache_file)?)
    } else {
        None
    };
    let mut order = source_order::read(paths)?;
    if source == "uid" {
        check_field(&payload, "uids", true)?;
        check_field(&payload, "profiles", false)?;
        for key in ["uids", "profiles", "uid_checkpoints"] {
            check_field(cache.as_ref().unwrap(), key, false)?;
        }
    } else {
        for key in ["folders", "items", "uids"] {
            check_field(&payload, key, true)?;
        }
    }
    let original = payload.clone();
    let legacy_uid = payload["uid"].as_str().unwrap_or_default().to_owned();
    let members: Vec<String> = if source == "uid" {
        array(&payload, "uids")
            .iter()
            .map(|v| {
                v.as_str()
                    .map(str::to_owned)
                    .filter(|v| validate_source_removal("uid", v).is_ok())
                    .ok_or_else(|| error("invalid_data", "Invalid source membership"))
            })
            .collect::<Result<_, _>>()?
    } else {
        array(&payload, "folders")
            .iter()
            .map(|v| {
                folder_identity(v, &legacy_uid)
                    .filter(|(uid, id)| {
                        validate_source_removal("favlist", id).is_ok()
                            && (uid.is_empty() || validate_source_removal("uid", uid).is_ok())
                    })
                    .map(|(uid, id)| browser_folder_id(&uid, &id))
                    .ok_or_else(|| error("invalid_data", "Invalid favorite membership"))
            })
            .collect::<Result<_, _>>()?
    };
    if members.iter().collect::<HashSet<_>>().len() != members.len() {
        return Err(error("invalid_data", "Duplicate source membership"));
    }
    if let Some(expected) = expected_version {
        source_order::validate_edit(
            source,
            expected,
            &source_order::SourceEdit::Remove {
                ids: selectors.to_vec(),
            },
        )?;
        if source_order::version(source, &members, &order) != expected {
            return Err(error(
                "stale_source_version",
                "Sources changed; reload before editing",
            ));
        }
        if selectors.iter().any(|id| !members.contains(id)) {
            return Err(error(
                "unknown_source",
                "A selected source no longer exists",
            ));
        }
    }
    let ids = selectors
        .iter()
        .map(|selector| {
            if source == "uid" || selector.contains(':') {
                return Ok(selector.clone());
            }
            let owners: BTreeSet<_> = array(&payload, "folders")
                .iter()
                .filter_map(|v| folder_identity(v, &legacy_uid))
                .filter(|(_, id)| id == selector)
                .map(|(uid, _)| uid)
                .collect();
            if owners.len() > 1 {
                return Err(error(
                    "invalid_request",
                    "Ambiguous favorite folder; include its owner",
                ));
            }
            Ok(browser_folder_id(
                owners.iter().next().map(String::as_str).unwrap_or_default(),
                selector,
            ))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let targets: HashSet<_> = ids.iter().collect();
    let remaining: Vec<_> = members
        .iter()
        .filter(|id| !targets.contains(id))
        .cloned()
        .collect();
    let mut removals = Vec::new();
    for id in &ids {
        let (uid, folder) = if source == "uid" {
            (id.clone(), String::new())
        } else {
            split_folder_id(id)
        };
        let count = if let Some(cache) = &cache {
            cache["uids"][id].as_array().map_or(0, Vec::len)
        } else {
            array(&payload, "items")
                .iter()
                .filter(|v| {
                    v.as_object().is_some_and(|m| {
                        first_text(m, &["fav_folder_id"]).as_deref() == Some(&folder)
                            && first_text(m, &["fav_uid"]).unwrap_or_else(|| legacy_uid.clone())
                                == uid
                    })
                })
                .count()
        };
        let mut value = json!({"source":source,"id":id,"uid":uid,"removed":members.contains(id),"removed_count":count});
        if source == "favlist" {
            value["folder_id"] = json!(folder);
        }
        removals.push(value);
    }
    if source == "uid" {
        payload["uids"] = json!(remaining);
        if payload.get("profiles").is_none() {
            payload["profiles"] = json!({});
        }
        for id in &ids {
            if let Some(values) = payload["profiles"].as_object_mut() {
                values.remove(id);
            }
        }
        if let Some(cache) = &mut cache {
            for key in ["uids", "profiles", "uid_checkpoints"] {
                if let Some(values) = cache.get_mut(key).and_then(Value::as_object_mut) {
                    for id in &ids {
                        values.remove(id);
                    }
                }
            }
        }
    } else {
        payload["folders"] = json!(
            array(&payload, "folders")
                .iter()
                .filter(|v| folder_identity(v, &legacy_uid)
                    .is_none_or(|(uid, id)| !targets.contains(&browser_folder_id(&uid, &id))))
                .cloned()
                .collect::<Vec<_>>()
        );
        payload["items"] = json!(
            array(&payload, "items")
                .iter()
                .filter(|v| v.as_object().is_none_or(|m| {
                    let uid = first_text(m, &["fav_uid"]).unwrap_or_else(|| legacy_uid.clone());
                    let folder = first_text(m, &["fav_folder_id"]).unwrap_or_default();
                    !targets.contains(&browser_folder_id(&uid, &folder))
                }))
                .cloned()
                .collect::<Vec<_>>()
        );
        let mut owners: BTreeSet<_> = array(&payload, "folders")
            .iter()
            .filter_map(|v| folder_identity(v, &legacy_uid))
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
        if !owners.contains(&legacy_uid) {
            payload["uid"] = json!("");
        }
    }
    let timestamp = unix_timestamp();
    if original != payload && (membership_path.exists() || !members.is_empty()) {
        payload["schema_version"] = json!(if source == "uid" {
            UID_SCHEMA_VERSION
        } else {
            FAVLIST_SCHEMA_VERSION
        });
        payload["updated_at"] = json!(timestamp);
        write(membership_path, &payload)?;
    }
    let mut cleanup_pending = Vec::new();
    if let Some(mut cache) = cache
        && paths.cache_file.exists()
    {
        cache["updated_at"] = json!(timestamp);
        if write(&paths.cache_file, &cache).is_err() {
            cleanup_pending.push("cache");
        }
    }
    let saved = order.get(source).to_vec();
    order.set(
        source,
        saved
            .iter()
            .filter(|id| remaining.contains(id))
            .cloned()
            .collect(),
    );
    if source_order::path(paths).exists()
        && saved != order.get(source)
        && write(
            &source_order::path(paths),
            &serde_json::to_value(&order).expect("display order serializes"),
        )
        .is_err()
    {
        cleanup_pending.push("display_order");
    }
    let removed_ids: Vec<_> = ids
        .iter()
        .filter(|id| members.contains(id))
        .cloned()
        .collect();
    let removed_count: usize = removals
        .iter()
        .filter_map(|v| v["removed_count"].as_u64())
        .map(|v| v as usize)
        .sum();
    Ok(
        json!({"operation":"remove_sources","source":source,"committed":true,"removed_ids":removed_ids,
        "removed_source_count":removed_ids.len(),"removed_count":removed_count,"removals":removals,
        "cleanup_pending":cleanup_pending,"updated_at":timestamp,"source_order_version":source_order::version(source,&remaining,&order)}),
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

        fn browse(&self, source: &str) -> Value {
            if source == "uid" {
                browse_uid(&self.paths, "", "", 0, 100).unwrap()
            } else {
                browse_favlist(&self.paths, "", "", 0, 100).unwrap()
            }
        }
        fn edit(
            &self,
            source: &str,
            version: &str,
            edit: SourceEdit,
        ) -> Result<Value, GatchaRepositoryError> {
            execute_gatcha(&GatchaRepositoryRequest {
                schema_version: 1,
                paths: self.paths.clone(),
                default_uids: vec!["999".into()],
                operation: GatchaOperation::EditSources {
                    source: source.into(),
                    expected_version: version.into(),
                    edit,
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

    #[test]
    fn batch_removal_validates_whole_set_and_preserves_sibling_bvs_and_source_type() {
        for source in ["uid", "favlist"] {
            let f = Fixture::new();
            let other = if source == "uid" {
                &f.paths.favlist_file
            } else {
                &f.paths.cache_file
            };
            let other_bytes = fs::read(other).unwrap();
            let version = f.browse(source)["source_order_version"]
                .as_str()
                .unwrap()
                .to_owned();
            let ids: Vec<String> = if source == "uid" {
                vec!["42".into(), "43".into()]
            } else {
                vec!["42:10".into(), "43:10".into()]
            };
            let before = fs::read(if source == "uid" {
                &f.paths.uid_file
            } else {
                &f.paths.favlist_file
            })
            .unwrap();
            for bad in [
                vec![ids[0].clone(), ids[0].clone()],
                vec![ids[0].clone(), "999".into()],
            ] {
                assert!(
                    f.edit(source, &version, SourceEdit::Remove { ids: bad })
                        .is_err()
                );
                assert_eq!(
                    fs::read(if source == "uid" {
                        &f.paths.uid_file
                    } else {
                        &f.paths.favlist_file
                    })
                    .unwrap(),
                    before
                );
            }
            let result = f
                .edit(source, &version, SourceEdit::Remove { ids: ids.clone() })
                .unwrap();
            assert_eq!(result["committed"], true);
            assert_eq!(result["removed_ids"], json!(ids));
            assert_eq!(result["removed_source_count"], 2);
            assert_eq!(result["cleanup_pending"], json!([]));
            assert_eq!(fs::read(other).unwrap(), other_bytes);
            if source == "favlist" {
                let saved = read_for_removal(&f.paths.favlist_file).unwrap();
                assert_eq!(saved["items"].as_array().unwrap().len(), 1);
                assert_eq!(saved["items"][0]["bvid"], "BVshared");
                assert_eq!(saved["items"][0]["fav_folder_id"], "11");
            } else {
                initialize_native_uids(&f.paths, &["42".into(), "43".into()]).unwrap();
                assert_eq!(f.browse(source)["owners"], json!([]));
            }
            assert_eq!(
                f.edit(source, &version, SourceEdit::Remove { ids })
                    .unwrap_err()
                    .kind,
                "stale_source_version"
            );
        }
    }

    #[test]
    fn source_host_preview_is_read_only_and_shares_the_same_strict_policy() {
        let f = Fixture::new();
        let version = f.browse("uid")["source_order_version"]
            .as_str()
            .unwrap()
            .to_owned();
        let request = GatchaRepositoryRequest {
            schema_version: 1,
            paths: f.paths.clone(),
            default_uids: vec![],
            operation: GatchaOperation::PreviewSourceEdit {
                source: "uid".into(),
                expected_version: version.clone(),
                edit: SourceEdit::Move {
                    id: "43".into(),
                    before_id: Some("42".into()),
                },
            },
        };
        let before = [
            fs::read(&f.paths.uid_file).unwrap(),
            fs::read(&f.paths.cache_file).unwrap(),
        ];
        assert_eq!(execute_gatcha(&request).unwrap()["changed"], true);
        assert!(!source_order::path(&f.paths).exists());
        assert_eq!(
            [
                fs::read(&f.paths.uid_file).unwrap(),
                fs::read(&f.paths.cache_file).unwrap()
            ],
            before
        );
        let mut noop = request.clone();
        noop.operation = GatchaOperation::PreviewSourceEdit {
            source: "uid".into(),
            expected_version: version,
            edit: SourceEdit::Move {
                id: "43".into(),
                before_id: Some("43".into()),
            },
        };
        assert_eq!(execute_gatcha(&noop).unwrap()["changed"], false);
    }

    #[test]
    fn display_order_persists_independently_and_noop_does_not_write_or_seed() {
        let f = Fixture::new();
        let files = [
            &f.paths.uid_file,
            &f.paths.cache_file,
            &f.paths.favlist_file,
            &f.paths.pool_config_file,
        ];
        let before: Vec<_> = files.iter().map(|p| fs::read(p).ok()).collect();
        let initial = f.browse("uid");
        assert_eq!(initial["owners"][0]["uid"], "42");
        assert!(!source_order::path(&f.paths).exists());
        let version = initial["source_order_version"].as_str().unwrap();
        assert_eq!(
            f.edit(
                "uid",
                version,
                SourceEdit::Move {
                    id: "42".into(),
                    before_id: Some("43".into())
                }
            )
            .unwrap()["changed"],
            false
        );
        assert!(!source_order::path(&f.paths).exists());
        f.edit(
            "uid",
            version,
            SourceEdit::Move {
                id: "43".into(),
                before_id: Some("42".into()),
            },
        )
        .unwrap();
        let favorites = f.browse("favlist");
        f.edit(
            "favlist",
            favorites["source_order_version"].as_str().unwrap(),
            SourceEdit::Move {
                id: "43:10".into(),
                before_id: Some("42:10".into()),
            },
        )
        .unwrap();
        assert_eq!(
            files.iter().map(|p| fs::read(p).ok()).collect::<Vec<_>>(),
            before,
            "a display edit never rewrites membership or the song cache"
        );
        assert_eq!(
            f.browse("uid")["owners"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v["uid"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["43", "42"]
        );
        assert_eq!(f.browse("favlist")["folders"][0]["id"], "43:10");
        let restarted = source_order::read(&f.paths).unwrap();
        assert_eq!(restarted.uid, vec!["43", "42"]);
        assert_eq!(restarted.favlist, vec!["43:10", "42:10", "42:11"]);
        let stable = f.browse("uid")["source_order_version"].clone();
        let mut cache = read_for_removal(&f.paths.cache_file).unwrap();
        cache["updated_at"] = json!(9999);
        cache["uids"]["42"] = json!([]);
        atomic_write_json(&f.paths.cache_file, &cache).unwrap();
        assert_eq!(
            f.browse("uid")["source_order_version"],
            stable,
            "count/progress changes must not invalidate a drag"
        );
        let mut uids = read_for_removal(&f.paths.uid_file).unwrap();
        uids["uids"] = json!(["42", "43", "44"]);
        atomic_write_json(&f.paths.uid_file, &uids).unwrap();
        assert_eq!(
            f.browse("uid")["owners"][2]["uid"],
            "44",
            "new sources append after saved display entries"
        );
        assert_ne!(f.browse("uid")["source_order_version"], stable);
        f.remove("uid", "43").unwrap();
        assert_eq!(source_order::read(&f.paths).unwrap().uid, vec!["42"]);
        assert_eq!(f.browse("uid")["owners"][0]["uid"], "42");
        assert_eq!(f.browse("favlist")["folders"][0]["id"], "43:10");
    }

    #[test]
    fn display_order_does_not_change_search_dedup_draw_or_configured_scan_inputs() {
        let f = Fixture::new();
        let before = search(&f.paths, "Shared", 0, 100).unwrap();
        let uid_bytes = fs::read(&f.paths.uid_file).unwrap();
        let favorites = fs::read(&f.paths.favlist_file).unwrap();
        let cache = fs::read(&f.paths.cache_file).unwrap();
        let version = f.browse("uid")["source_order_version"]
            .as_str()
            .unwrap()
            .to_owned();
        f.edit(
            "uid",
            &version,
            SourceEdit::Move {
                id: "43".into(),
                before_id: Some("42".into()),
            },
        )
        .unwrap();
        assert_eq!(search(&f.paths, "Shared", 0, 100).unwrap(), before);
        assert_eq!(fs::read(&f.paths.uid_file).unwrap(), uid_bytes);
        assert_eq!(fs::read(&f.paths.favlist_file).unwrap(), favorites);
        assert_eq!(fs::read(&f.paths.cache_file).unwrap(), cache);
        // All draw/refresh consumers still load these untouched source arrays,
        // not the display metadata; browse is the only projection consumer.
    }

    #[test]
    fn source_edit_shapes_bounds_corrupt_metadata_and_unknown_anchors_are_rejected() {
        let f = Fixture::new();
        let version = f.browse("uid")["source_order_version"]
            .as_str()
            .unwrap()
            .to_owned();
        for edit in [
            SourceEdit::Remove { ids: vec![] },
            SourceEdit::Remove {
                ids: vec!["42".into(); 129],
            },
            SourceEdit::Move {
                id: "42".into(),
                before_id: Some("999".into()),
            },
            SourceEdit::Remove {
                ids: vec!["42:10".into()],
            },
        ] {
            assert!(f.edit("uid", &version, edit).is_err());
        }
        for body in [
            json!({"operation":"edit_sources","source":"uid","expected_version":version,"edit":{"action":"remove","ids":["42"],"path":"owned"}}),
            json!({"operation":"edit_sources","source":"uid","expected_version":version,"edit":{"action":"move","id":"42","before_id":null},"role":"host"}),
        ] {
            assert!(serde_json::from_value::<GatchaOperation>(body).is_err());
        }
        let configured = fs::read(&f.paths.uid_file).unwrap();
        for damaged in [
            "{broken",
            r#"{"schema_version":2,"uid":[]}"#,
            r#"{"schema_version":1,"uid":["42","42"]}"#,
            r#"{"schema_version":1,"favlist":["10"]}"#,
            r#"{"schema_version":1,"uid":{},"extra":true}"#,
        ] {
            fs::write(source_order::path(&f.paths), damaged).unwrap();
            let browse = f.browse("uid");
            assert_eq!(browse["source_order_editable"], false);
            assert_eq!(browse["owners"].as_array().unwrap().len(), 2);
            assert!(
                f.edit(
                    "uid",
                    &version,
                    SourceEdit::Remove {
                        ids: vec!["42".into()]
                    }
                )
                .is_err()
            );
            assert_eq!(
                fs::read(source_order::path(&f.paths)).unwrap(),
                damaged.as_bytes()
            );
            assert_eq!(fs::read(&f.paths.uid_file).unwrap(), configured);
        }
    }

    #[test]
    fn prepublication_failure_preserves_data_but_cleanup_failure_reports_committed_membership() {
        let f = Fixture::new();
        let version = f.browse("uid")["source_order_version"]
            .as_str()
            .unwrap()
            .to_owned();
        f.edit(
            "uid",
            &version,
            SourceEdit::Move {
                id: "43".into(),
                before_id: Some("42".into()),
            },
        )
        .unwrap();
        let version = f.browse("uid")["source_order_version"]
            .as_str()
            .unwrap()
            .to_owned();
        let before = [
            &f.paths.uid_file,
            &f.paths.cache_file,
            &source_order::path(&f.paths),
        ]
        .map(|p| fs::read(p).unwrap());
        let failure = remove_sources_with_writer(
            &f.paths,
            "uid",
            &["42".into()],
            Some(&version),
            &mut |_, _| Err(error("filesystem", "fixture prepublication failure")),
        );
        assert!(failure.is_err());
        assert_eq!(
            [
                &f.paths.uid_file,
                &f.paths.cache_file,
                &source_order::path(&f.paths)
            ]
            .map(|p| fs::read(p).unwrap()),
            before
        );
        let mut writes = Vec::new();
        let result = remove_sources_with_writer(
            &f.paths,
            "uid",
            &["42".into()],
            Some(&version),
            &mut |path, value| {
                writes.push(path.to_owned());
                if path == f.paths.cache_file || path == source_order::path(&f.paths) {
                    Err(error("filesystem", "fixture cleanup failure"))
                } else {
                    atomic_write_json(path, value)
                }
            },
        )
        .unwrap();
        assert_eq!(
            writes.len(),
            3,
            "publish membership once, then try each cleanup once"
        );
        assert_eq!(result["committed"], true);
        assert_eq!(result["removed_ids"], json!(["42"]));
        assert_eq!(result["cleanup_pending"], json!(["cache", "display_order"]));
        assert_eq!(
            f.browse("uid")["owners"][0]["uid"],
            "43",
            "orphan cache/order rows cannot resurrect a removed source"
        );
        let current = f.browse("uid")["source_order_version"]
            .as_str()
            .unwrap()
            .to_owned();
        let repaired = cleanup_sources(&f.paths, "uid", &["42".into()], &current).unwrap();
        assert_eq!(repaired["operation"], "source_cleanup");
        assert_eq!(repaired["removed_source_count"], 0);
        assert_eq!(repaired["cleanup_pending"], json!([]));
        assert_eq!(
            cleanup_sources(&f.paths, "uid", &["43".into()], &current)
                .unwrap_err()
                .kind,
            "unknown_source",
            "repair must not remove a present or re-added source"
        );
        assert_eq!(
            cleanup_sources(&f.paths, "uid", &["42".into()], &version)
                .unwrap_err()
                .kind,
            "stale_source_version"
        );
        assert_eq!(
            f.remove("uid", "42").unwrap()["removed"],
            false,
            "an explicit legacy retry can finish orphan cleanup"
        );
        assert!(
            read_for_removal(&f.paths.cache_file).unwrap()["uids"]
                .get("42")
                .is_none()
        );
        assert_eq!(source_order::read(&f.paths).unwrap().uid, vec!["43"]);
    }

    #[test]
    fn competing_membership_and_order_writes_reject_the_stale_version() {
        let f = Fixture::new();
        let version = f.browse("uid")["source_order_version"]
            .as_str()
            .unwrap()
            .to_owned();
        f.edit(
            "uid",
            &version,
            SourceEdit::Move {
                id: "43".into(),
                before_id: Some("42".into()),
            },
        )
        .unwrap();
        assert_eq!(
            f.edit(
                "uid",
                &version,
                SourceEdit::Remove {
                    ids: vec!["42".into()]
                }
            )
            .unwrap_err()
            .kind,
            "stale_source_version"
        );
        assert_eq!(
            read_for_removal(&f.paths.uid_file).unwrap()["uids"],
            json!(["42", "43"])
        );
    }
}
