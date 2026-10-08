//! Card display preferences only. Never change scan, search or draw inputs.
use super::*;
use sha2::{Digest, Sha256};

pub(super) const MAX_SOURCES: usize = 4096;
pub(super) const MAX_BATCH: usize = 128;

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum SourceEdit {
    Remove {
        ids: Vec<String>,
    },
    Cleanup {
        ids: Vec<String>,
    },
    Move {
        id: String,
        before_id: Option<String>,
    },
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct DisplayOrder {
    pub schema_version: u32,
    #[serde(default)]
    pub uid: Vec<String>,
    #[serde(default)]
    pub favlist: Vec<String>,
}

pub(super) fn path(paths: &GatchaPaths) -> PathBuf {
    paths.uid_file.with_file_name("gatcha_source_order.json")
}

pub(super) fn valid_id(source: &str, id: &str) -> bool {
    super::source_removal::validate_source_removal(source, id).is_ok()
        && (source == "uid" || id.contains(':'))
}

fn validate_ids(source: &str, ids: &[String], maximum: usize) -> Result<(), GatchaRepositoryError> {
    if !matches!(source, "uid" | "favlist")
        || ids.len() > maximum
        || ids.iter().any(|id| !valid_id(source, id))
        || ids.iter().collect::<HashSet<_>>().len() != ids.len()
    {
        return Err(error(
            "invalid_request",
            "Invalid or duplicate source identities",
        ));
    }
    Ok(())
}

pub(crate) fn validate_edit(
    source: &str,
    expected_version: &str,
    edit: &SourceEdit,
) -> Result<(), GatchaRepositoryError> {
    if expected_version.len() != 64 || !expected_version.bytes().all(|v| v.is_ascii_hexdigit()) {
        return Err(error(
            "invalid_request",
            "A source membership/order version is required",
        ));
    }
    match edit {
        SourceEdit::Remove { ids } | SourceEdit::Cleanup { ids } => {
            validate_ids(source, ids, MAX_BATCH)?;
            if ids.is_empty() {
                return Err(error("invalid_request", "Select at least one source"));
            }
        }
        SourceEdit::Move { id, before_id } => {
            validate_ids(source, std::slice::from_ref(id), 1)?;
            if let Some(before) = before_id {
                validate_ids(source, std::slice::from_ref(before), 1)?;
            }
        }
    }
    Ok(())
}

pub(super) fn read(paths: &GatchaPaths) -> Result<DisplayOrder, GatchaRepositoryError> {
    let file = path(paths);
    let metadata = match fs::metadata(&file) {
        Ok(value) => value,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(DisplayOrder {
                schema_version: 1,
                ..Default::default()
            });
        }
        Err(_) => {
            return Err(error(
                "invalid_data",
                "Source display preferences are unreadable",
            ));
        }
    };
    if !metadata.is_file() || metadata.len() > 1_048_576 {
        return Err(error("invalid_data", "Invalid source display preferences"));
    }
    let data = fs::read(file)
        .map_err(|_| error("invalid_data", "Source display preferences are unreadable"))?;
    let order: DisplayOrder = serde_json::from_slice(&data)
        .map_err(|_| error("invalid_data", "Source display preferences are damaged"))?;
    if order.schema_version != 1
        || validate_ids("uid", &order.uid, MAX_SOURCES).is_err()
        || validate_ids("favlist", &order.favlist, MAX_SOURCES).is_err()
    {
        return Err(error(
            "invalid_data",
            "Unsupported or invalid source display preferences",
        ));
    }
    Ok(order)
}

impl DisplayOrder {
    pub(super) fn get(&self, source: &str) -> &[String] {
        if source == "uid" {
            &self.uid
        } else {
            &self.favlist
        }
    }
    pub(super) fn set(&mut self, source: &str, ids: Vec<String>) {
        if source == "uid" {
            self.uid = ids;
        } else {
            self.favlist = ids;
        }
    }
    pub(super) fn effective(&self, source: &str, members: &[String]) -> Vec<String> {
        let present: HashSet<_> = members.iter().collect();
        let saved: HashSet<_> = self.get(source).iter().collect();
        self.get(source)
            .iter()
            .filter(|id| present.contains(id))
            .cloned()
            .chain(members.iter().filter(|id| !saved.contains(id)).cloned())
            .collect()
    }
}

pub(super) fn version(source: &str, members: &[String], order: &DisplayOrder) -> String {
    // Counts, refresh timestamps and playback revisions are deliberately absent.
    let displayed = order.effective(source, members);
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(source, displayed)).expect("string IDs serialize"))
    )
}

pub(super) fn members(
    paths: &GatchaPaths,
    source: &str,
) -> Result<Vec<String>, GatchaRepositoryError> {
    let payload = super::source_removal::read_for_removal(if source == "uid" {
        &paths.uid_file
    } else {
        &paths.favlist_file
    })?;
    let ids = if source == "uid" {
        super::source_removal::check_field(&payload, "uids", true)?;
        array(&payload, "uids")
            .iter()
            .map(|v| {
                v.as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| error("invalid_data", "Invalid source membership"))
            })
            .collect::<Result<Vec<_>, _>>()?
    } else {
        super::source_removal::check_field(&payload, "folders", true)?;
        array(&payload, "folders")
            .iter()
            .map(|folder| {
                super::source_removal::folder_identity(
                    folder,
                    payload["uid"].as_str().unwrap_or_default(),
                )
                .map(|(uid, id)| browser_folder_id(&uid, &id))
                .ok_or_else(|| error("invalid_data", "Invalid favorite membership"))
            })
            .collect::<Result<Vec<_>, _>>()?
    };
    validate_ids(source, &ids, MAX_SOURCES)
        .map_err(|_| error("invalid_data", "Source membership cannot be edited safely"))?;
    Ok(ids)
}

pub(super) fn project(paths: &GatchaPaths, source: &str, rows: &mut [Value], key: &str) -> Value {
    let ids: Vec<String> = rows
        .iter()
        .filter_map(|row| row[key].as_str().map(str::to_owned))
        .collect();
    let result = (|| {
        validate_ids(source, &ids, MAX_SOURCES)?;
        if ids.len() != rows.len() || members(paths, source)? != ids {
            return Err(error("invalid_data", "Invalid source membership"));
        }
        let order = read(paths)?;
        let displayed = order.effective(source, &ids);
        let positions: BTreeMap<_, _> = displayed
            .iter()
            .enumerate()
            .map(|(i, id)| (id.as_str(), i))
            .collect();
        rows.sort_by_key(|row| {
            positions
                .get(row[key].as_str().unwrap_or_default())
                .copied()
                .unwrap_or(usize::MAX)
        });
        Ok(
            json!({"source_order_version":version(source, &ids, &order),"source_order_editable":true,"source_order_count":ids.len(),"source_order_error":""}),
        )
    })();
    result.unwrap_or_else(|_: GatchaRepositoryError| json!({"source_order_version":"","source_order_editable":false,"source_order_error":"source_order_unavailable"}))
}

pub(super) fn move_source(
    paths: &GatchaPaths,
    source: &str,
    expected_version: &str,
    id: &str,
    before: Option<&str>,
) -> Result<Value, GatchaRepositoryError> {
    move_source_controlled(paths, source, expected_version, id, before, true)
}

pub(super) fn move_source_controlled(
    paths: &GatchaPaths,
    source: &str,
    expected_version: &str,
    id: &str,
    before: Option<&str>,
    publish: bool,
) -> Result<Value, GatchaRepositoryError> {
    let members = members(paths, source)?;
    let mut order = read(paths)?;
    let old_version = version(source, &members, &order);
    if old_version != expected_version {
        return Err(error(
            "stale_source_version",
            "Sources changed; reload before editing",
        ));
    }
    if !members.iter().any(|v| v == id) || before.is_some_and(|v| !members.iter().any(|id| id == v))
    {
        return Err(error(
            "unknown_source",
            "A selected source or move anchor no longer exists",
        ));
    }
    let previous = order.effective(source, &members);
    let mut displayed = previous.clone();
    if before != Some(id) {
        displayed.retain(|v| v != id);
        let index = before
            .and_then(|anchor| displayed.iter().position(|v| v == anchor))
            .unwrap_or(displayed.len());
        displayed.insert(index, id.to_owned());
    }
    let changed = displayed != previous;
    if changed {
        order.set(source, displayed);
        if publish {
            atomic_write_json(
                &path(paths),
                &serde_json::to_value(&order).expect("display order serializes"),
            )?;
        }
    }
    Ok(
        json!({"operation":"source_order","source":source,"changed":changed,"source_order_version":version(source,&members,&order)}),
    )
}
