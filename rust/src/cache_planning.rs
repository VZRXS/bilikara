use std::collections::HashSet;

use serde::{Deserialize, Serialize};

const CACHE_PLAN_SCHEMA_VERSION: u32 = 1;
const MAX_CACHE_PLAN_ITEMS: usize = 10_000;
const MAX_CACHE_ITEM_ID_BYTES: usize = 512;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CacheItem {
    pub original_index: usize,
    pub item_id: String,
    pub cache_ready: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CachePlanRequest {
    pub items: Vec<CacheItem>,
    pub max_items: usize,
    pub retention_limit: usize,
    pub active_item_ids: Vec<String>,
    pub primary_active_item_id: Option<String>,
    pub urgent_item_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CachePlan {
    pub desired_ids: Vec<String>,
    pub pending_order: Vec<String>,
    pub retained_ids: Vec<String>,
    pub preempt_ids: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CachePlanError {
    TooManyItems,
    InvalidItemId,
    DuplicateItemId,
    DuplicateOriginalIndex,
    DuplicateReference,
    UnknownReference,
    InvalidPrimaryActiveItem,
}

pub fn plan_cache_window(request: CachePlanRequest) -> Result<CachePlan, CachePlanError> {
    validate_request(&request)?;

    let window_size = request.max_items.min(request.items.len());
    let window = &request.items[..window_size];
    let desired_ids: Vec<String> = window.iter().map(|item| item.item_id.clone()).collect();
    let pending_order: Vec<String> = window
        .iter()
        .filter(|item| !item.cache_ready)
        .map(|item| item.item_id.clone())
        .collect();

    let mut retained_ids = desired_ids.clone();
    let mut retained_set: HashSet<&str> = desired_ids.iter().map(String::as_str).collect();
    if request.max_items > 0 {
        for item in &request.items {
            if retained_ids.len() >= desired_ids.len().saturating_add(request.retention_limit) {
                break;
            }
            if item.cache_ready && !retained_set.contains(item.item_id.as_str()) {
                retained_set.insert(item.item_id.as_str());
                retained_ids.push(item.item_id.clone());
            }
        }
    }

    let preempt_ids = request
        .primary_active_item_id
        .as_ref()
        .filter(|primary_id| {
            pending_order.first().is_some_and(|first_id| {
                pending_order.contains(primary_id)
                    && *primary_id != first_id
                    && !request.urgent_item_ids.contains(first_id)
            })
        })
        .cloned()
        .into_iter()
        .collect();

    Ok(CachePlan {
        desired_ids,
        pending_order,
        retained_ids,
        preempt_ids,
    })
}

fn validate_request(request: &CachePlanRequest) -> Result<(), CachePlanError> {
    if request.items.len() > MAX_CACHE_PLAN_ITEMS {
        return Err(CachePlanError::TooManyItems);
    }
    let mut item_ids = HashSet::with_capacity(request.items.len());
    let mut indices = HashSet::with_capacity(request.items.len());
    for item in &request.items {
        if item.item_id.is_empty()
            || item.item_id.contains('\0')
            || item.item_id.len() > MAX_CACHE_ITEM_ID_BYTES
        {
            return Err(CachePlanError::InvalidItemId);
        }
        if !item_ids.insert(item.item_id.as_str()) {
            return Err(CachePlanError::DuplicateItemId);
        }
        if !indices.insert(item.original_index) {
            return Err(CachePlanError::DuplicateOriginalIndex);
        }
    }
    validate_references(&request.active_item_ids, &item_ids)?;
    validate_references(&request.urgent_item_ids, &item_ids)?;
    if request
        .primary_active_item_id
        .as_ref()
        .is_some_and(|item_id| {
            !item_ids.contains(item_id.as_str()) || !request.active_item_ids.contains(item_id)
        })
    {
        return Err(CachePlanError::InvalidPrimaryActiveItem);
    }
    Ok(())
}

fn validate_references(
    references: &[String],
    item_ids: &HashSet<&str>,
) -> Result<(), CachePlanError> {
    let mut seen = HashSet::with_capacity(references.len());
    for item_id in references {
        if !seen.insert(item_id.as_str()) {
            return Err(CachePlanError::DuplicateReference);
        }
        if !item_ids.contains(item_id.as_str()) {
            return Err(CachePlanError::UnknownReference);
        }
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CacheItemWire {
    original_index: usize,
    item_id: String,
    cache_ready: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CachePlanRequestWire {
    schema_version: u32,
    items: Vec<CacheItemWire>,
    max_items: usize,
    retention_limit: usize,
    active_item_ids: Vec<String>,
    primary_active_item_id: Option<String>,
    urgent_item_ids: Vec<String>,
}

#[derive(Debug, Serialize)]
struct CachePlanResponseWire {
    schema_version: u32,
    desired_ids: Vec<String>,
    pending_order: Vec<String>,
    retained_ids: Vec<String>,
    preempt_ids: Vec<String>,
}

pub(crate) fn plan_cache_window_json(request_json: &str) -> Option<String> {
    let wire: CachePlanRequestWire = serde_json::from_str(request_json).ok()?;
    if wire.schema_version != CACHE_PLAN_SCHEMA_VERSION {
        return None;
    }
    let request = CachePlanRequest {
        items: wire
            .items
            .into_iter()
            .map(|item| CacheItem {
                original_index: item.original_index,
                item_id: item.item_id,
                cache_ready: item.cache_ready,
            })
            .collect(),
        max_items: wire.max_items,
        retention_limit: wire.retention_limit,
        active_item_ids: wire.active_item_ids,
        primary_active_item_id: wire.primary_active_item_id,
        urgent_item_ids: wire.urgent_item_ids,
    };
    let plan = plan_cache_window(request).ok()?;
    serde_json::to_string(&CachePlanResponseWire {
        schema_version: CACHE_PLAN_SCHEMA_VERSION,
        desired_ids: plan.desired_ids,
        pending_order: plan.pending_order,
        retained_ids: plan.retained_ids,
        preempt_ids: plan.preempt_ids,
    })
    .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(index: usize, id: &str, ready: bool) -> CacheItem {
        CacheItem {
            original_index: index,
            item_id: id.to_string(),
            cache_ready: ready,
        }
    }

    fn request(
        items: Vec<CacheItem>,
        max_items: usize,
        retention_limit: usize,
    ) -> CachePlanRequest {
        CachePlanRequest {
            items,
            max_items,
            retention_limit,
            active_item_ids: Vec::new(),
            primary_active_item_id: None,
            urgent_item_ids: Vec::new(),
        }
    }

    #[test]
    fn plans_empty_zero_and_window_limits() {
        assert_eq!(
            plan_cache_window(request(Vec::new(), 3, 3)).unwrap(),
            CachePlan {
                desired_ids: vec![],
                pending_order: vec![],
                retained_ids: vec![],
                preempt_ids: vec![],
            }
        );
        let items = vec![item(0, "a", false), item(1, "b", true)];
        assert!(
            plan_cache_window(request(items.clone(), 0, 3))
                .unwrap()
                .desired_ids
                .is_empty()
        );
        assert_eq!(
            plan_cache_window(request(items.clone(), 1, 0))
                .unwrap()
                .desired_ids,
            ["a"]
        );
        assert_eq!(
            plan_cache_window(request(items, 9, 3)).unwrap().desired_ids,
            ["a", "b"]
        );
    }

    #[test]
    fn preserves_pending_and_retention_traversal_order() {
        let plan = plan_cache_window(request(
            vec![
                item(0, "a", true),
                item(1, "b", false),
                item(2, "c", true),
                item(3, "d", true),
                item(4, "e", false),
                item(5, "f", true),
            ],
            2,
            2,
        ))
        .unwrap();
        assert_eq!(plan.desired_ids, ["a", "b"]);
        assert_eq!(plan.pending_order, ["b"]);
        assert_eq!(plan.retained_ids, ["a", "b", "c", "d"]);
    }

    #[test]
    fn proposes_only_existing_priority_preemption() {
        let mut req = request(
            vec![item(0, "first", false), item(1, "active", false)],
            2,
            0,
        );
        req.active_item_ids = vec!["active".into()];
        req.primary_active_item_id = Some("active".into());
        assert_eq!(
            plan_cache_window(req.clone()).unwrap().preempt_ids,
            ["active"]
        );
        req.urgent_item_ids = vec!["first".into()];
        assert!(plan_cache_window(req).unwrap().preempt_ids.is_empty());
    }

    #[test]
    fn covers_ready_retention_reordering_and_active_boundaries() {
        let all_ready =
            plan_cache_window(request(vec![item(9, "b", true), item(3, "a", true)], 2, 8)).unwrap();
        assert_eq!(all_ready.desired_ids, ["b", "a"]);
        assert!(all_ready.pending_order.is_empty());

        let none_ready = plan_cache_window(request(
            vec![item(0, "a", false), item(1, "b", false)],
            2,
            8,
        ))
        .unwrap();
        assert_eq!(none_ready.pending_order, ["a", "b"]);
        assert_eq!(none_ready.retained_ids, ["a", "b"]);

        let values = vec![
            item(0, "first", false),
            item(1, "active", false),
            item(2, "outside", false),
        ];
        let mut outside = request(values.clone(), 2, 0);
        outside.active_item_ids = vec!["outside".into()];
        outside.primary_active_item_id = Some("outside".into());
        assert!(plan_cache_window(outside).unwrap().preempt_ids.is_empty());

        let mut ready_active =
            request(vec![item(0, "first", false), item(1, "active", true)], 2, 0);
        ready_active.active_item_ids = vec!["active".into()];
        ready_active.primary_active_item_id = Some("active".into());
        assert!(
            plan_cache_window(ready_active)
                .unwrap()
                .preempt_ids
                .is_empty()
        );

        let expected = plan_cache_window(request(values, 2, 0)).unwrap();
        for _ in 0..100 {
            assert_eq!(
                plan_cache_window(request(
                    vec![
                        item(0, "first", false),
                        item(1, "active", false),
                        item(2, "outside", false),
                    ],
                    2,
                    0,
                ))
                .unwrap(),
                expected
            );
        }
    }

    #[test]
    fn rejects_duplicate_identity_and_invalid_references() {
        assert_eq!(
            plan_cache_window(request(vec![item(0, "a", false), item(1, "a", true)], 2, 0)),
            Err(CachePlanError::DuplicateItemId)
        );
        assert_eq!(
            plan_cache_window(request(vec![item(0, "a", false), item(0, "b", true)], 2, 0)),
            Err(CachePlanError::DuplicateOriginalIndex)
        );
        let mut req = request(vec![item(0, "a", false)], 1, 0);
        req.active_item_ids = vec!["missing".into()];
        assert_eq!(
            plan_cache_window(req),
            Err(CachePlanError::UnknownReference)
        );
    }

    #[test]
    fn wire_is_strict_and_returns_a_concrete_empty_plan() {
        let valid = r#"{"schema_version":1,"items":[],"max_items":0,"retention_limit":0,"active_item_ids":[],"primary_active_item_id":null,"urgent_item_ids":[]}"#;
        let response = plan_cache_window_json(valid).unwrap();
        assert_eq!(
            response,
            r#"{"schema_version":1,"desired_ids":[],"pending_order":[],"retained_ids":[],"preempt_ids":[]}"#
        );
        assert!(
            plan_cache_window_json(&valid.replace("\"schema_version\":1", "\"schema_version\":2"))
                .is_none()
        );
        assert!(
            plan_cache_window_json(&valid.replace("\"items\":[]", "\"items\":[],\"unknown\":1"))
                .is_none()
        );
        assert!(
            plan_cache_window_json(&valid.replace("\"max_items\":0", "\"max_items\":true"))
                .is_none()
        );
        assert!(
            plan_cache_window_json(&valid.replace("\"max_items\":0", "\"max_items\":-1")).is_none()
        );
        let duplicate_index = r#"{"schema_version":1,"items":[{"original_index":0,"item_id":"a","cache_ready":false},{"original_index":0,"item_id":"b","cache_ready":false}],"max_items":2,"retention_limit":0,"active_item_ids":[],"primary_active_item_id":null,"urgent_item_ids":[]}"#;
        let invalid_reference = r#"{"schema_version":1,"items":[],"max_items":0,"retention_limit":0,"active_item_ids":[],"primary_active_item_id":null,"urgent_item_ids":["missing"]}"#;
        assert!(plan_cache_window_json(duplicate_index).is_none());
        assert!(plan_cache_window_json(invalid_reference).is_none());
        assert!(plan_cache_window_json("not json").is_none());
    }
}
