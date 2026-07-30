use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

const SCHEMA_VERSION: u32 = 1;
const MAX_ITEMS: usize = 10_000;
const MAX_SESSION_USERS: usize = 32;
const MAX_STRING_BYTES: usize = 512;
const MAX_HISTORY_KEY_BYTES: usize = 8_192;
const MAX_AUDIO_PAGES: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlaylistOrderOperation {
    Rebuild,
    InsertCycle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlaylistSlotType {
    Cycle,
    Priority,
    Manual,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlaylistOrderItem {
    pub original_index: usize,
    pub item_id: String,
    pub requester_name: String,
    pub slot_type: PlaylistSlotType,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlaylistOrderRequest {
    pub operation: PlaylistOrderOperation,
    pub session_users: Vec<String>,
    pub current_requester: Option<String>,
    pub items: Vec<PlaylistOrderItem>,
    pub candidate: Option<PlaylistOrderItem>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlaylistOrderPlan {
    pub ordered_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlaylistIdentity {
    pub bvid: String,
    pub aid: u64,
    pub video_page: usize,
    pub selected_audio_pages: Vec<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DuplicateActiveItem {
    pub original_index: usize,
    pub item_id: String,
    pub identity: PlaylistIdentity,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DuplicateHistoryEntry {
    pub original_index: usize,
    pub key: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlaylistDuplicateRequest {
    pub candidate: PlaylistIdentity,
    pub current_item: Option<DuplicateActiveItem>,
    pub queued_items: Vec<DuplicateActiveItem>,
    pub history_entries: Vec<DuplicateHistoryEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlaylistDuplicateDecision {
    pub identity_key: String,
    pub active_duplicate_id: Option<String>,
    pub history_duplicate_index: Option<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlaylistPlanError {
    TooManyItems,
    TooManyUsers,
    InvalidString,
    DuplicateItemId,
    DuplicateOriginalIndex,
    DuplicateSessionUser,
    InvalidOperationCandidate,
    InvalidCandidate,
    InvalidIdentity,
}

fn valid_string(value: &str, max_bytes: usize, allow_empty: bool) -> bool {
    (allow_empty || !value.is_empty()) && !value.contains('\0') && value.len() <= max_bytes
}

fn validate_order_item(item: &PlaylistOrderItem) -> Result<(), PlaylistPlanError> {
    if !valid_string(&item.item_id, MAX_STRING_BYTES, false)
        || !valid_string(&item.requester_name, MAX_STRING_BYTES, true)
    {
        return Err(PlaylistPlanError::InvalidString);
    }
    Ok(())
}

fn validate_order_request(request: &PlaylistOrderRequest) -> Result<(), PlaylistPlanError> {
    if request.items.len() > MAX_ITEMS {
        return Err(PlaylistPlanError::TooManyItems);
    }
    if request.session_users.len() > MAX_SESSION_USERS {
        return Err(PlaylistPlanError::TooManyUsers);
    }
    let mut users = HashSet::with_capacity(request.session_users.len());
    for user in &request.session_users {
        if !valid_string(user, MAX_STRING_BYTES, false) {
            return Err(PlaylistPlanError::InvalidString);
        }
        if !users.insert(user.as_str()) {
            return Err(PlaylistPlanError::DuplicateSessionUser);
        }
    }
    if request
        .current_requester
        .as_deref()
        .is_some_and(|value| !valid_string(value, MAX_STRING_BYTES, true))
    {
        return Err(PlaylistPlanError::InvalidString);
    }
    let mut ids = HashSet::with_capacity(request.items.len() + 1);
    let mut indices = HashSet::with_capacity(request.items.len() + 1);
    for item in &request.items {
        validate_order_item(item)?;
        if !ids.insert(item.item_id.as_str()) {
            return Err(PlaylistPlanError::DuplicateItemId);
        }
        if !indices.insert(item.original_index) {
            return Err(PlaylistPlanError::DuplicateOriginalIndex);
        }
    }
    match (request.operation, request.candidate.as_ref()) {
        (PlaylistOrderOperation::Rebuild, None) => Ok(()),
        (PlaylistOrderOperation::InsertCycle, Some(candidate)) => {
            if request.items.len() >= MAX_ITEMS || candidate.slot_type != PlaylistSlotType::Cycle {
                return Err(PlaylistPlanError::InvalidCandidate);
            }
            validate_order_item(candidate)?;
            if !ids.insert(candidate.item_id.as_str()) {
                return Err(PlaylistPlanError::DuplicateItemId);
            }
            if !indices.insert(candidate.original_index) {
                return Err(PlaylistPlanError::DuplicateOriginalIndex);
            }
            Ok(())
        }
        _ => Err(PlaylistPlanError::InvalidOperationCandidate),
    }
}

fn rotated_users(request: &PlaylistOrderRequest) -> Vec<&str> {
    let users: Vec<&str> = request.session_users.iter().map(String::as_str).collect();
    let Some(current) = request.current_requester.as_deref() else {
        return users;
    };
    let Some(index) = users.iter().position(|user| *user == current) else {
        return users;
    };
    users[index + 1..]
        .iter()
        .chain(users[..=index].iter())
        .copied()
        .collect()
}

type CycleKey = (usize, usize);

struct PlaylistCycleState<'a> {
    keys: HashMap<&'a str, CycleKey>,
    counts: HashMap<&'a str, usize>,
    order_index: HashMap<&'a str, usize>,
}

fn cycle_state(request: &PlaylistOrderRequest) -> PlaylistCycleState<'_> {
    let users = rotated_users(request);
    let order_index: HashMap<&str, usize> = users
        .iter()
        .enumerate()
        .map(|(index, user)| (*user, index))
        .collect();
    let mut counts: HashMap<&str, usize> = users.iter().map(|user| (*user, 0)).collect();
    let mut keys = HashMap::with_capacity(request.items.len());
    for item in &request.items {
        if item.slot_type != PlaylistSlotType::Cycle {
            continue;
        }
        let Some(position) = order_index.get(item.requester_name.as_str()) else {
            continue;
        };
        let count = counts.entry(item.requester_name.as_str()).or_default();
        keys.insert(item.item_id.as_str(), (*count, *position));
        *count += 1;
    }
    PlaylistCycleState {
        keys,
        counts,
        order_index,
    }
}

pub fn plan_playlist_order(
    request: PlaylistOrderRequest,
) -> Result<PlaylistOrderPlan, PlaylistPlanError> {
    validate_order_request(&request)?;
    let cycle_state = cycle_state(&request);
    match request.operation {
        PlaylistOrderOperation::InsertCycle => {
            let candidate = request
                .candidate
                .as_ref()
                .ok_or(PlaylistPlanError::InvalidOperationCandidate)?;
            let mut ordered_ids: Vec<String> = request
                .items
                .iter()
                .map(|item| item.item_id.clone())
                .collect();
            if ordered_ids.is_empty() {
                return Ok(PlaylistOrderPlan {
                    ordered_ids: vec![candidate.item_id.clone()],
                });
            }
            let Some(candidate_order) = cycle_state
                .order_index
                .get(candidate.requester_name.as_str())
            else {
                ordered_ids.push(candidate.item_id.clone());
                return Ok(PlaylistOrderPlan { ordered_ids });
            };
            let new_key = (
                *cycle_state
                    .counts
                    .get(candidate.requester_name.as_str())
                    .unwrap_or(&0),
                *candidate_order,
            );
            let mut insert_index = 0;
            for (index, existing) in request.items.iter().enumerate() {
                if existing.slot_type != PlaylistSlotType::Cycle {
                    insert_index = index + 1;
                    continue;
                }
                match cycle_state.keys.get(existing.item_id.as_str()) {
                    None => insert_index = index + 1,
                    Some(existing_key) if *existing_key <= new_key => insert_index = index + 1,
                    Some(_) => {}
                }
            }
            ordered_ids.insert(insert_index, candidate.item_id.clone());
            Ok(PlaylistOrderPlan { ordered_ids })
        }
        PlaylistOrderOperation::Rebuild => {
            let mut positions = Vec::new();
            let mut sortable = Vec::new();
            for (position, item) in request.items.iter().enumerate() {
                let Some(key) = cycle_state.keys.get(item.item_id.as_str()) else {
                    continue;
                };
                positions.push(position);
                sortable.push((*key, item.original_index, item.item_id.clone()));
            }
            sortable.sort_by_key(|entry| (entry.0.0, entry.0.1, entry.1));
            let mut ordered_ids: Vec<String> = request
                .items
                .iter()
                .map(|item| item.item_id.clone())
                .collect();
            for (position, (_, _, item_id)) in positions.into_iter().zip(sortable) {
                ordered_ids[position] = item_id;
            }
            Ok(PlaylistOrderPlan { ordered_ids })
        }
    }
}

fn validate_identity(identity: &PlaylistIdentity) -> Result<(), PlaylistPlanError> {
    if !valid_string(&identity.bvid, MAX_STRING_BYTES, true)
        || identity.video_page == 0
        || identity.selected_audio_pages.len() > MAX_AUDIO_PAGES
    {
        return Err(PlaylistPlanError::InvalidIdentity);
    }
    Ok(())
}

fn playlist_identity_key(identity: &PlaylistIdentity) -> Result<String, PlaylistPlanError> {
    validate_identity(identity)?;
    let mut key = if identity.bvid.is_empty() {
        format!("aid:{}:p{}", identity.aid, identity.video_page)
    } else {
        format!("{}:p{}", identity.bvid, identity.video_page)
    };
    let pages: Vec<String> = identity
        .selected_audio_pages
        .iter()
        .filter(|page| **page > 0)
        .map(ToString::to_string)
        .collect();
    if !pages.is_empty() {
        key.push_str(":a");
        key.push_str(&pages.join("-"));
    }
    Ok(key)
}

fn validate_duplicate_request(request: &PlaylistDuplicateRequest) -> Result<(), PlaylistPlanError> {
    validate_identity(&request.candidate)?;
    if request.queued_items.len() > MAX_ITEMS || request.history_entries.len() > MAX_ITEMS {
        return Err(PlaylistPlanError::TooManyItems);
    }
    let mut ids = HashSet::with_capacity(request.queued_items.len() + 1);
    let mut indices = HashSet::with_capacity(request.queued_items.len() + 1);
    for item in request
        .current_item
        .iter()
        .chain(request.queued_items.iter())
    {
        if !valid_string(&item.item_id, MAX_STRING_BYTES, false) {
            return Err(PlaylistPlanError::InvalidString);
        }
        validate_identity(&item.identity)?;
        if !ids.insert(item.item_id.as_str()) {
            return Err(PlaylistPlanError::DuplicateItemId);
        }
        if !indices.insert(item.original_index) {
            return Err(PlaylistPlanError::DuplicateOriginalIndex);
        }
    }
    let mut history_indices = HashSet::with_capacity(request.history_entries.len());
    for entry in &request.history_entries {
        if !valid_string(&entry.key, MAX_HISTORY_KEY_BYTES, true) {
            return Err(PlaylistPlanError::InvalidString);
        }
        if !history_indices.insert(entry.original_index) {
            return Err(PlaylistPlanError::DuplicateOriginalIndex);
        }
    }
    Ok(())
}

pub fn decide_playlist_duplicate(
    request: PlaylistDuplicateRequest,
) -> Result<PlaylistDuplicateDecision, PlaylistPlanError> {
    validate_duplicate_request(&request)?;
    let identity_key = playlist_identity_key(&request.candidate)?;
    let mut active_duplicate_id = None;
    for item in request
        .current_item
        .iter()
        .chain(request.queued_items.iter())
    {
        if active_duplicate_id.is_none() && playlist_identity_key(&item.identity)? == identity_key {
            active_duplicate_id = Some(item.item_id.clone());
        }
    }
    let history_duplicate_index = request
        .history_entries
        .iter()
        .find(|entry| entry.key == identity_key)
        .map(|entry| entry.original_index);
    Ok(PlaylistDuplicateDecision {
        identity_key,
        active_duplicate_id,
        history_duplicate_index,
    })
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum PlaylistOrderOperationWire {
    Rebuild,
    InsertCycle,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum PlaylistSlotTypeWire {
    Cycle,
    Priority,
    Manual,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PlaylistOrderItemWire {
    original_index: usize,
    item_id: String,
    requester_name: String,
    slot_type: PlaylistSlotTypeWire,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PlaylistOrderRequestWire {
    schema_version: u32,
    operation: PlaylistOrderOperationWire,
    session_users: Vec<String>,
    current_requester: Option<String>,
    items: Vec<PlaylistOrderItemWire>,
    candidate: Option<PlaylistOrderItemWire>,
}

#[derive(Debug, Serialize)]
struct PlaylistOrderResponseWire {
    schema_version: u32,
    ordered_ids: Vec<String>,
}

impl From<PlaylistOrderItemWire> for PlaylistOrderItem {
    fn from(value: PlaylistOrderItemWire) -> Self {
        Self {
            original_index: value.original_index,
            item_id: value.item_id,
            requester_name: value.requester_name,
            slot_type: match value.slot_type {
                PlaylistSlotTypeWire::Cycle => PlaylistSlotType::Cycle,
                PlaylistSlotTypeWire::Priority => PlaylistSlotType::Priority,
                PlaylistSlotTypeWire::Manual => PlaylistSlotType::Manual,
            },
        }
    }
}

pub(crate) fn plan_playlist_order_json(request_json: &str) -> Option<String> {
    let wire: PlaylistOrderRequestWire = serde_json::from_str(request_json).ok()?;
    if wire.schema_version != SCHEMA_VERSION {
        return None;
    }
    let request = PlaylistOrderRequest {
        operation: match wire.operation {
            PlaylistOrderOperationWire::Rebuild => PlaylistOrderOperation::Rebuild,
            PlaylistOrderOperationWire::InsertCycle => PlaylistOrderOperation::InsertCycle,
        },
        session_users: wire.session_users,
        current_requester: wire.current_requester,
        items: wire.items.into_iter().map(Into::into).collect(),
        candidate: wire.candidate.map(Into::into),
    };
    let plan = plan_playlist_order(request).ok()?;
    serde_json::to_string(&PlaylistOrderResponseWire {
        schema_version: SCHEMA_VERSION,
        ordered_ids: plan.ordered_ids,
    })
    .ok()
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PlaylistIdentityWire {
    bvid: String,
    aid: u64,
    video_page: usize,
    selected_audio_pages: Vec<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DuplicateActiveItemWire {
    original_index: usize,
    item_id: String,
    identity: PlaylistIdentityWire,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DuplicateHistoryEntryWire {
    original_index: usize,
    key: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PlaylistDuplicateRequestWire {
    schema_version: u32,
    candidate: PlaylistIdentityWire,
    current_item: Option<DuplicateActiveItemWire>,
    queued_items: Vec<DuplicateActiveItemWire>,
    history_entries: Vec<DuplicateHistoryEntryWire>,
}

#[derive(Debug, Serialize)]
struct PlaylistDuplicateResponseWire {
    schema_version: u32,
    identity_key: String,
    active_duplicate_id: Option<String>,
    history_duplicate_index: Option<usize>,
}

impl From<PlaylistIdentityWire> for PlaylistIdentity {
    fn from(value: PlaylistIdentityWire) -> Self {
        Self {
            bvid: value.bvid,
            aid: value.aid,
            video_page: value.video_page,
            selected_audio_pages: value.selected_audio_pages,
        }
    }
}

impl From<DuplicateActiveItemWire> for DuplicateActiveItem {
    fn from(value: DuplicateActiveItemWire) -> Self {
        Self {
            original_index: value.original_index,
            item_id: value.item_id,
            identity: value.identity.into(),
        }
    }
}

pub(crate) fn decide_playlist_duplicate_json(request_json: &str) -> Option<String> {
    let wire: PlaylistDuplicateRequestWire = serde_json::from_str(request_json).ok()?;
    if wire.schema_version != SCHEMA_VERSION {
        return None;
    }
    let request = PlaylistDuplicateRequest {
        candidate: wire.candidate.into(),
        current_item: wire.current_item.map(Into::into),
        queued_items: wire.queued_items.into_iter().map(Into::into).collect(),
        history_entries: wire
            .history_entries
            .into_iter()
            .map(|entry| DuplicateHistoryEntry {
                original_index: entry.original_index,
                key: entry.key,
            })
            .collect(),
    };
    let decision = decide_playlist_duplicate(request).ok()?;
    serde_json::to_string(&PlaylistDuplicateResponseWire {
        schema_version: SCHEMA_VERSION,
        identity_key: decision.identity_key,
        active_duplicate_id: decision.active_duplicate_id,
        history_duplicate_index: decision.history_duplicate_index,
    })
    .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(index: usize, id: &str, requester: &str, slot: PlaylistSlotType) -> PlaylistOrderItem {
        PlaylistOrderItem {
            original_index: index,
            item_id: id.into(),
            requester_name: requester.into(),
            slot_type: slot,
        }
    }

    fn rebuild(items: Vec<PlaylistOrderItem>) -> PlaylistOrderRequest {
        PlaylistOrderRequest {
            operation: PlaylistOrderOperation::Rebuild,
            session_users: vec!["A".into(), "B".into(), "C".into()],
            current_requester: Some("A".into()),
            items,
            candidate: None,
        }
    }

    fn identity(bvid: &str, aid: u64, page: usize, audio: &[i64]) -> PlaylistIdentity {
        PlaylistIdentity {
            bvid: bvid.into(),
            aid,
            video_page: page,
            selected_audio_pages: audio.to_vec(),
        }
    }

    #[test]
    fn rebuild_rotates_rounds_and_keeps_fixed_positions() {
        let request = rebuild(vec![
            item(0, "a2", "A", PlaylistSlotType::Cycle),
            item(1, "priority", "A", PlaylistSlotType::Priority),
            item(2, "unknown", "X", PlaylistSlotType::Cycle),
            item(3, "c1", "C", PlaylistSlotType::Cycle),
            item(4, "b1", "B", PlaylistSlotType::Cycle),
            item(5, "manual", "B", PlaylistSlotType::Manual),
            item(6, "a1", "A", PlaylistSlotType::Cycle),
        ]);
        let plan = plan_playlist_order(request).unwrap();
        assert_eq!(
            plan.ordered_ids,
            ["b1", "priority", "unknown", "c1", "a2", "manual", "a1"]
        );
    }

    #[test]
    fn insertion_preserves_scan_semantics() {
        let mut request = rebuild(vec![
            item(0, "priority", "B", PlaylistSlotType::Priority),
            item(1, "b1", "B", PlaylistSlotType::Cycle),
            item(2, "unknown", "X", PlaylistSlotType::Cycle),
            item(3, "c1", "C", PlaylistSlotType::Cycle),
        ]);
        request.operation = PlaylistOrderOperation::InsertCycle;
        request.candidate = Some(item(4, "b2", "B", PlaylistSlotType::Cycle));
        assert_eq!(
            plan_playlist_order(request).unwrap().ordered_ids,
            ["priority", "b1", "unknown", "c1", "b2"]
        );

        let mut empty = rebuild(vec![]);
        empty.operation = PlaylistOrderOperation::InsertCycle;
        empty.candidate = Some(item(0, "a", "A", PlaylistSlotType::Cycle));
        assert_eq!(plan_playlist_order(empty).unwrap().ordered_ids, ["a"]);
    }

    #[test]
    fn rejects_invalid_order_identity_and_relationships() {
        let mut duplicate = rebuild(vec![
            item(0, "a", "A", PlaylistSlotType::Cycle),
            item(1, "a", "B", PlaylistSlotType::Cycle),
        ]);
        assert_eq!(
            plan_playlist_order(duplicate.clone()),
            Err(PlaylistPlanError::DuplicateItemId)
        );
        duplicate.items[1].item_id = "b".into();
        duplicate.items[1].original_index = 0;
        assert_eq!(
            plan_playlist_order(duplicate),
            Err(PlaylistPlanError::DuplicateOriginalIndex)
        );
        let mut invalid = rebuild(vec![]);
        invalid.candidate = Some(item(0, "a", "A", PlaylistSlotType::Cycle));
        assert_eq!(
            plan_playlist_order(invalid),
            Err(PlaylistPlanError::InvalidOperationCandidate)
        );

        let mut duplicate_users = rebuild(vec![]);
        duplicate_users.session_users = vec!["A".into(), "A".into()];
        assert_eq!(
            plan_playlist_order(duplicate_users),
            Err(PlaylistPlanError::DuplicateSessionUser)
        );

        let mut collision = rebuild(vec![item(0, "a", "A", PlaylistSlotType::Cycle)]);
        collision.operation = PlaylistOrderOperation::InsertCycle;
        collision.candidate = Some(item(1, "a", "A", PlaylistSlotType::Cycle));
        assert_eq!(
            plan_playlist_order(collision),
            Err(PlaylistPlanError::DuplicateItemId)
        );

        let mut oversized = rebuild(vec![]);
        oversized.items = (0..=MAX_ITEMS)
            .map(|index| {
                item(
                    index,
                    &format!("item-{index}"),
                    "A",
                    PlaylistSlotType::Cycle,
                )
            })
            .collect();
        assert_eq!(
            plan_playlist_order(oversized),
            Err(PlaylistPlanError::TooManyItems)
        );
    }

    #[test]
    fn generated_rebuilds_conserve_ids_and_fixed_positions() {
        let base = ["A", "B", "C"];
        for rotation in 0..base.len() {
            for mask in 0_u8..8 {
                let items: Vec<_> = (0..6)
                    .map(|index| {
                        let slot = if mask & (1 << (index % 3)) == 0 {
                            PlaylistSlotType::Cycle
                        } else if index % 2 == 0 {
                            PlaylistSlotType::Priority
                        } else {
                            PlaylistSlotType::Manual
                        };
                        item(index, &format!("item-{index}"), base[index % 3], slot)
                    })
                    .collect();
                let mut request = rebuild(items.clone());
                request.session_users.rotate_left(rotation);
                let plan = plan_playlist_order(request).unwrap();
                let input: HashSet<_> = items.iter().map(|entry| entry.item_id.as_str()).collect();
                let output: HashSet<_> = plan.ordered_ids.iter().map(String::as_str).collect();
                assert_eq!(input, output);
                assert_eq!(plan.ordered_ids.len(), items.len());
                for (index, entry) in items.iter().enumerate() {
                    if entry.slot_type != PlaylistSlotType::Cycle {
                        assert_eq!(plan.ordered_ids[index], entry.item_id);
                    }
                }
            }
        }
    }

    #[test]
    fn identity_and_duplicate_precedence_preserve_audio_order() {
        let candidate = identity("BVCase", 42, 2, &[2, 0, -1, 1, 2]);
        let matching = candidate.clone();
        let request = PlaylistDuplicateRequest {
            candidate,
            current_item: Some(DuplicateActiveItem {
                original_index: 0,
                item_id: "current".into(),
                identity: matching.clone(),
            }),
            queued_items: vec![DuplicateActiveItem {
                original_index: 1,
                item_id: "queued".into(),
                identity: matching,
            }],
            history_entries: vec![
                DuplicateHistoryEntry {
                    original_index: 8,
                    key: "other".into(),
                },
                DuplicateHistoryEntry {
                    original_index: 9,
                    key: "BVCase:p2:a2-1-2".into(),
                },
            ],
        };
        let decision = decide_playlist_duplicate(request).unwrap();
        assert_eq!(decision.identity_key, "BVCase:p2:a2-1-2");
        assert_eq!(decision.active_duplicate_id.as_deref(), Some("current"));
        assert_eq!(decision.history_duplicate_index, Some(9));
    }

    #[test]
    fn maximum_identity_key_is_valid_as_history_and_larger_keys_are_rejected() {
        let audio_pages = vec![i64::MAX; MAX_AUDIO_PAGES];
        let maximum = identity(
            &"B".repeat(MAX_STRING_BYTES),
            u64::MAX,
            usize::MAX,
            &audio_pages,
        );
        let key = playlist_identity_key(&maximum).unwrap();
        assert!(key.len() <= MAX_HISTORY_KEY_BYTES);

        let decision = decide_playlist_duplicate(PlaylistDuplicateRequest {
            candidate: maximum.clone(),
            current_item: None,
            queued_items: vec![],
            history_entries: vec![DuplicateHistoryEntry {
                original_index: 7,
                key: key.clone(),
            }],
        })
        .unwrap();
        assert_eq!(decision.identity_key, key);
        assert_eq!(decision.history_duplicate_index, Some(7));

        for invalid_key in [
            "x".repeat(MAX_HISTORY_KEY_BYTES + 1),
            "valid\0invalid".into(),
        ] {
            let request = PlaylistDuplicateRequest {
                candidate: maximum.clone(),
                current_item: None,
                queued_items: vec![],
                history_entries: vec![DuplicateHistoryEntry {
                    original_index: 0,
                    key: invalid_key,
                }],
            };
            assert_eq!(
                decide_playlist_duplicate(request),
                Err(PlaylistPlanError::InvalidString)
            );
        }
    }

    #[test]
    fn aid_fallback_and_distinct_audio_selection() {
        let request = PlaylistDuplicateRequest {
            candidate: identity("", 123, 1, &[1, 2]),
            current_item: None,
            queued_items: vec![DuplicateActiveItem {
                original_index: 0,
                item_id: "different".into(),
                identity: identity("", 123, 1, &[2, 1]),
            }],
            history_entries: vec![],
        };
        let decision = decide_playlist_duplicate(request).unwrap();
        assert_eq!(decision.identity_key, "aid:123:p1:a1-2");
        assert_eq!(decision.active_duplicate_id, None);
    }

    #[test]
    fn duplicate_validation_rejects_duplicate_ids_indices_and_oversized_values() {
        let candidate = identity("BV", 1, 1, &[]);
        let duplicate_ids = PlaylistDuplicateRequest {
            candidate: candidate.clone(),
            current_item: Some(DuplicateActiveItem {
                original_index: 0,
                item_id: "same".into(),
                identity: candidate.clone(),
            }),
            queued_items: vec![DuplicateActiveItem {
                original_index: 1,
                item_id: "same".into(),
                identity: candidate.clone(),
            }],
            history_entries: vec![],
        };
        assert_eq!(
            decide_playlist_duplicate(duplicate_ids),
            Err(PlaylistPlanError::DuplicateItemId)
        );

        let duplicate_history = PlaylistDuplicateRequest {
            candidate: candidate.clone(),
            current_item: None,
            queued_items: vec![],
            history_entries: vec![
                DuplicateHistoryEntry {
                    original_index: 2,
                    key: "one".into(),
                },
                DuplicateHistoryEntry {
                    original_index: 2,
                    key: "two".into(),
                },
            ],
        };
        assert_eq!(
            decide_playlist_duplicate(duplicate_history),
            Err(PlaylistPlanError::DuplicateOriginalIndex)
        );

        let oversized_identity = PlaylistDuplicateRequest {
            candidate: PlaylistIdentity {
                bvid: "x".repeat(MAX_STRING_BYTES + 1),
                aid: 1,
                video_page: 1,
                selected_audio_pages: vec![],
            },
            current_item: None,
            queued_items: vec![],
            history_entries: vec![],
        };
        assert_eq!(
            decide_playlist_duplicate(oversized_identity),
            Err(PlaylistPlanError::InvalidIdentity)
        );
    }

    #[test]
    fn generated_duplicate_decisions_are_deterministic() {
        for bvid in ["", "BVCase"] {
            for page in [1, 2] {
                for audio in [vec![], vec![1], vec![2, 1], vec![1, 1], vec![0, -1, 2]] {
                    let candidate = identity(bvid, 42, page, &audio);
                    let key = playlist_identity_key(&candidate).unwrap();
                    let request = PlaylistDuplicateRequest {
                        candidate: candidate.clone(),
                        current_item: None,
                        queued_items: vec![DuplicateActiveItem {
                            original_index: 0,
                            item_id: "queued".into(),
                            identity: candidate,
                        }],
                        history_entries: vec![DuplicateHistoryEntry {
                            original_index: 7,
                            key,
                        }],
                    };
                    let expected = decide_playlist_duplicate(request.clone()).unwrap();
                    for _ in 0..10 {
                        assert_eq!(
                            decide_playlist_duplicate(request.clone()).unwrap(),
                            expected
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn wire_rejects_schema_unknown_enums_numbers_and_collisions() {
        assert!(plan_playlist_order_json("not json").is_none());
        assert!(plan_playlist_order_json(r#"{"schema_version":2,"operation":"rebuild","session_users":[],"current_requester":null,"items":[],"candidate":null}"#).is_none());
        assert!(plan_playlist_order_json(r#"{"schema_version":1,"operation":"bad","session_users":[],"current_requester":null,"items":[],"candidate":null}"#).is_none());
        assert!(plan_playlist_order_json(r#"{"schema_version":1,"operation":"rebuild","session_users":[],"current_requester":null,"items":[],"candidate":null,"extra":1}"#).is_none());
        assert!(plan_playlist_order_json(r#"{"schema_version":1,"operation":"rebuild","session_users":[],"current_requester":null,"items":[{"original_index":true,"item_id":"a","requester_name":"","slot_type":"cycle"}],"candidate":null}"#).is_none());
        assert!(decide_playlist_duplicate_json(r#"{"schema_version":1,"candidate":{"bvid":"","aid":-1,"video_page":1,"selected_audio_pages":[]},"current_item":null,"queued_items":[],"history_entries":[]}"#).is_none());
    }

    #[test]
    fn wire_returns_concrete_empty_results() {
        let order = plan_playlist_order_json(r#"{"schema_version":1,"operation":"rebuild","session_users":[],"current_requester":null,"items":[],"candidate":null}"#).unwrap();
        assert_eq!(order, r#"{"schema_version":1,"ordered_ids":[]}"#);
        let duplicate = decide_playlist_duplicate_json(r#"{"schema_version":1,"candidate":{"bvid":"BV","aid":1,"video_page":1,"selected_audio_pages":[]},"current_item":null,"queued_items":[],"history_entries":[]}"#).unwrap();
        assert_eq!(
            duplicate,
            r#"{"schema_version":1,"identity_key":"BV:p1","active_duplicate_id":null,"history_duplicate_index":null}"#
        );
    }
}
