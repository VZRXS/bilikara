//! Session names are presentation; stable singer IDs own ordering and edits.
use super::*;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SessionUserEntry {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum SessionUserEdit {
    Rename {
        user_id: String,
        name: String,
    },
    Remove {
        user_ids: Vec<String>,
    },
    Reorder {
        user_ids: Vec<String>,
        before_user_id: Option<String>,
    },
}

impl AppStateData {
    pub(super) fn sync_user_ids(&mut self, namespace: &[u8; IDENTITY_NAMESPACE_BYTES]) {
        self.session_user_ids
            .retain(|name, _| self.session_users.contains(name));
        for name in &self.session_users {
            self.session_user_ids
                .entry(name.clone())
                .or_insert_with(|| {
                    let mut hash = Sha256::new();
                    hash.update(namespace);
                    hash.update(self.session_generation.to_le_bytes());
                    hash.update(self.revision.to_le_bytes());
                    hash.update(name.as_bytes());
                    format!("{:x}", hash.finalize())
                });
        }
    }

    pub(super) fn user_name_for_id(&self, id: &str) -> Option<&str> {
        self.session_users
            .iter()
            .find(|name| {
                self.session_user_ids
                    .get(*name)
                    .is_some_and(|candidate| candidate == id)
            })
            .map(String::as_str)
    }

    pub(super) fn user_entries(&self) -> Vec<SessionUserEntry> {
        self.session_users
            .iter()
            .filter_map(|name| {
                Some(SessionUserEntry {
                    id: self.session_user_ids.get(name)?.clone(),
                    name: name.clone(),
                })
            })
            .collect()
    }

    pub(super) fn users_version(&self) -> String {
        let mut hash = Sha256::new();
        hash.update(self.session_user_epoch.as_bytes());
        hash.update(self.session_generation.to_le_bytes());
        for user in self.user_entries() {
            hash.update(user.id.as_bytes());
            hash.update((user.name.len() as u64).to_le_bytes());
            hash.update(user.name.as_bytes());
        }
        format!("{:x}", hash.finalize())
    }

    // Legacy checkpoints acquire IDs once. Thereafter an item's association
    // survives a rename or a removal, even if its old name is reused.
    pub(super) fn restore_requester_ids(&mut self) {
        for item in self.current_item.iter().chain(self.playlist.iter()).chain(
            self.backup
                .iter()
                .flat_map(|backup| backup.current_item.iter().chain(backup.playlist.iter())),
        ) {
            if let Some(id) = self.session_user_ids.get(&item.requester_name) {
                self.requester_user_ids
                    .entry(item.id.clone())
                    .or_insert_with(|| id.clone());
            }
        }
    }

    pub(super) fn requester_order_key(&self, item: &PlaylistItem) -> String {
        self.requester_user_ids
            .get(&item.id)
            .cloned()
            .unwrap_or_else(|| {
                // Never make an unowned legacy record belong to a later namesake.
                format!(
                    "legacy:{}",
                    normalize_session_user_name(&item.requester_name)
                )
            })
    }
}

pub(super) fn validate_user_ids(seed: &AppStateSeed) -> Result<(), ExecuteError> {
    let valid_id = |id: &str| id.len() == 64 && id.bytes().all(|byte| byte.is_ascii_hexdigit());
    let mut ids = HashSet::new();
    if seed
        .session_user_ids
        .iter()
        .any(|(name, id)| !seed.session_users.contains(name) || !valid_id(id) || !ids.insert(id))
        || seed.requester_user_ids.len() > (MAX_ITEMS + 1) * 2
        || seed
            .requester_user_ids
            .iter()
            .any(|(item, id)| !valid_string(item, MAX_ITEM_ID_BYTES, false) || !valid_id(id))
    {
        return Err(rejected(
            "invalid_initial_state",
            "invalid session user identities",
        ));
    }
    Ok(())
}

pub(super) fn apply_edit(
    data: &mut AppStateData,
    expected_version: &str,
    edit: SessionUserEdit,
) -> Result<MutationResult, ExecuteError> {
    if expected_version != data.users_version() {
        return Err(rejected("session_users_changed", "用户列表已更新，请重试"));
    }
    match edit {
        SessionUserEdit::Rename { user_id, name } => {
            let current = data
                .user_name_for_id(&user_id)
                .ok_or_else(|| rejected("session_user_not_found", "用户已移除"))?
                .to_owned();
            rename(data, &current, &name)
        }
        SessionUserEdit::Remove { user_ids } => {
            validate_selection(data, &user_ids)?;
            let removed_names: Vec<_> = data
                .session_users
                .iter()
                .filter(|name| user_ids.contains(&data.session_user_ids[*name]))
                .cloned()
                .collect();
            data.session_users
                .retain(|name| !user_ids.contains(&data.session_user_ids[name]));
            data.session_user_ids
                .retain(|name, _| data.session_users.contains(name));
            rebuild_playlist_order(data, None)?;
            Ok(MutationResult::changed(
                json!({"changed":true,"removed_names":removed_names}),
                true,
            ))
        }
        SessionUserEdit::Reorder {
            user_ids,
            before_user_id,
        } => {
            validate_selection(data, &user_ids)?;
            if before_user_id
                .as_ref()
                .is_some_and(|id| user_ids.contains(id) || data.user_name_for_id(id).is_none())
            {
                return Err(rejected("invalid_session_user", "调整位置的目标无效"));
            }
            let original = data.session_users.clone();
            let (selected, mut remaining): (Vec<_>, Vec<_>) = original
                .iter()
                .cloned()
                .partition(|name| user_ids.contains(&data.session_user_ids[name]));
            let index = before_user_id
                .as_ref()
                .and_then(|id| {
                    remaining
                        .iter()
                        .position(|name| &data.session_user_ids[name] == id)
                })
                .unwrap_or(remaining.len());
            remaining.splice(index..index, selected);
            if remaining == original {
                return Ok(MutationResult::unchanged(mutation_value(false)));
            }
            data.session_users = remaining;
            rebuild_playlist_order(data, None)?;
            Ok(MutationResult::changed(mutation_value(true), true))
        }
    }
}

fn validate_selection(data: &AppStateData, ids: &[String]) -> Result<(), ExecuteError> {
    let unique: HashSet<_> = ids.iter().collect();
    if ids.is_empty()
        || ids.len() > MAX_SESSION_USERS
        || unique.len() != ids.len()
        || ids.iter().any(|id| data.user_name_for_id(id).is_none())
    {
        return Err(rejected(
            "session_user_not_found",
            "所选用户已移除，请重新选择",
        ));
    }
    Ok(())
}

pub(super) fn rename(
    data: &mut AppStateData,
    current_name: &str,
    new_name: &str,
) -> Result<MutationResult, ExecuteError> {
    let current = normalize_session_user_name(current_name);
    let renamed = normalize_session_user_name(new_name);
    let index = data
        .session_users
        .iter()
        .position(|user| user == &current)
        .ok_or_else(|| rejected("session_user_not_found", "session user does not exist"))?;
    if renamed.is_empty() {
        return Err(rejected(
            "invalid_session_user",
            "user name cannot be empty",
        ));
    }
    if renamed != current && data.session_users.contains(&renamed) {
        return Err(rejected(
            "duplicate_session_user",
            "session user already exists",
        ));
    }
    if renamed == current {
        return Ok(MutationResult::unchanged(json!({"name":renamed})));
    }
    let id = data
        .session_user_ids
        .remove(&current)
        .ok_or_else(|| rejected("session_user_not_found", "session user identity is missing"))?;
    data.session_users[index] = renamed.clone();
    data.session_user_ids.insert(renamed.clone(), id.clone());
    for name in data.remote_identities.values_mut() {
        if name == &current {
            name.clone_from(&renamed);
        }
    }
    if let Some(config) = data
        .gatcha_pool_preferences
        .remove(&format!("user:{current}"))
    {
        data.gatcha_pool_preferences
            .insert(format!("user:{renamed}"), config);
    }
    // A requester label is an immutable request-time record. No queue rebuild
    // is needed: grouping follows IDs, and renaming preserves roster order.
    Ok(MutationResult::changed(
        json!({"name":renamed, "user_id":id, "previous_name":current}),
        true,
    ))
}
