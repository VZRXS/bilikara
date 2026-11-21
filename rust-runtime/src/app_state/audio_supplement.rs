//! Additional audio is prepared as a complete immutable candidate. Publication
//! does not replace the playing program; an explicit audio selection adopts it.
use super::*;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AudioSupplement {
    pub item_incarnation_id: String,
    pub page: u32,
    pub cache_attempt_token: u64,
    pub message: String,
    pub status: String,
    pub progress: Option<f64>,
    pub ready: Option<CacheEvent>,
}

impl AudioSupplement {
    pub(crate) fn candidate(&self, item: &PlaylistItem) -> PlaylistItem {
        let mut result = item.clone();
        if let Some(CacheEvent::Ready {
            video_relative_path,
            video_media_url,
            audio_variants,
            artifact_set_id,
            artifact_relative_directory,
            ..
        }) = &self.ready
        {
            result.video_relative_path.clone_from(video_relative_path);
            result.video_media_url.clone_from(video_media_url);
            result.audio_variants.clone_from(audio_variants);
            result.artifact_set_id.clone_from(artifact_set_id);
            result
                .artifact_relative_directory
                .clone_from(artifact_relative_directory);
            result.selected_pages = audio_variants
                .iter()
                .filter_map(|v| v["page"].as_i64())
                .collect();
            let indices: Vec<_> = result
                .selected_pages
                .iter()
                .filter_map(|p| result.available_pages.iter().position(|v| v == p))
                .collect();
            result.selected_cids = indices
                .iter()
                .filter_map(|i| result.available_cids.get(*i).copied())
                .collect();
            result.selected_durations = indices
                .iter()
                .filter_map(|i| result.available_durations.get(*i).copied())
                .collect();
            result.selected_parts = indices
                .iter()
                .filter_map(|i| result.available_parts.get(*i).cloned())
                .collect();
        }
        result
    }
    pub(crate) fn retains(&self, artifact: &str) -> bool {
        matches!(&self.ready, Some(CacheEvent::Ready {artifact_set_id,..}) if artifact_set_id == artifact)
    }
}

impl AppState {
    pub(crate) fn mark_audio_supplement(
        &mut self,
        id: &str,
        token: u64,
        page: u32,
    ) -> Result<(), AppStateError> {
        let result = (|| {
            let data = self
                .data
                .as_mut()
                .ok_or_else(|| rejected("uninitialized", "Host not initialized"))?;
            let active =
                validate_cache_attempt_ownership(data, id, token, self.next_cache_attempt_token)?;
            let item = data
                .find_item(id)
                .ok_or_else(|| rejected("item_not_found", "Song removed"))?;
            if item.cache_status != "ready"
                || !item.media_source.is_bilibili()
                || !item.available_pages.contains(&i64::from(page))
                || !active.refresh
            {
                return Err(rejected(
                    "invalid_audio_supplement",
                    "Audio supplement requires a ready Bilibili item and an available page",
                ));
            }
            let incarnation = item.item_incarnation_id.clone();
            let next_revision = data
                .revision
                .checked_add(1)
                .ok_or_else(|| rejected("revision_exhausted", "Revision exhausted"))?;
            let ready = data.audio_supplements.get(id).and_then(|s| s.ready.clone());
            data.active_cache_attempts
                .get_mut(id)
                .unwrap()
                .supplement_page = Some(page);
            data.audio_supplements.insert(
                id.into(),
                AudioSupplement {
                    item_incarnation_id: incarnation,
                    page,
                    cache_attempt_token: token,
                    message: String::new(),
                    status: "queued".into(),
                    progress: Some(0.0),
                    ready,
                },
            );
            data.revision = next_revision;
            Ok(())
        })();
        result.map_err(|e| match e {
            ExecuteError::Rejected(e) => e,
            ExecuteError::Internal(message) => AppStateError {
                kind: "internal".into(),
                message,
                details: None,
            },
        })
    }
}

pub(super) fn apply_event(
    data: &mut AppStateData,
    id: &str,
    page: u32,
    event: &CacheEvent,
) -> Result<MutationResult, ExecuteError> {
    if let CacheEvent::Ready { audio_variants, .. } = event {
        let item = data
            .find_item(id)
            .ok_or_else(|| rejected("item_not_found", "Song removed"))?;
        let baseline = data
            .audio_supplements
            .get(id)
            .map_or_else(|| item.clone(), |s| s.candidate(item));
        if !audio_variants
            .iter()
            .any(|v| v["page"].as_u64() == Some(u64::from(page)))
            || baseline
                .audio_variants
                .iter()
                .any(|old| !audio_variants.iter().any(|v| v["id"] == old["id"]))
        {
            return Err(rejected(
                "incomplete_audio_supplement",
                "Supplement must include the requested page and all existing audio",
            ));
        }
    }
    let supplement = data
        .audio_supplements
        .get_mut(id)
        .ok_or_else(|| rejected("stale_audio_supplement", "Audio supplement retired"))?;
    if supplement.page != page {
        return Err(rejected("stale_audio_supplement", "Audio page changed"));
    }
    supplement.message.clear();
    match event {
        CacheEvent::Ready { .. } => {
            supplement.ready = Some(event.clone());
            supplement.status = "ready".into();
            supplement.progress = Some(100.0);
        }
        CacheEvent::Failed { message }
        | CacheEvent::Cancelled { message }
        | CacheEvent::Evicted { message }
        | CacheEvent::Reset { message, .. } => {
            supplement.message.clone_from(message);
            supplement.status = "failed".into();
            supplement.progress = None;
        }
        CacheEvent::Progress {
            download, progress, ..
        } => {
            if !progress.is_finite() {
                return Err(rejected("invalid_cache_progress", "Invalid progress"));
            }
            supplement.status = "downloading".into();
            supplement.progress = download
                .as_ref()
                .and_then(|d| d.tracks.iter().find(|t| t.key == format!("audio-p{page}")))
                .and_then(|t| {
                    if t.done {
                        Some(99.0)
                    } else if t.target_bytes > 0 {
                        Some(
                            (t.current_bytes as f64 / t.target_bytes as f64 * 99.0)
                                .clamp(0.0, 99.0),
                        )
                    } else {
                        None
                    }
                });
        }
        _ => {
            supplement.status = "downloading".into();
        }
    }
    if terminal_cache_event(event) {
        data.active_cache_attempts
            .get_mut(id)
            .unwrap()
            .terminal_event = Some(event.clone());
    }
    Ok(
        MutationResult::changed(json!({"applied":true,"replayed":false}), false)
            .with_operational_change(),
    )
}

pub(super) fn select_ready(
    data: &mut AppStateData,
    id: &str,
    incarnation: &str,
    variant: &str,
) -> Result<(), ExecuteError> {
    if let Some(candidate) = data
        .find_item(id)
        .filter(|item| item.item_incarnation_id == incarnation)
        .and_then(|item| selection_candidate(data, item, variant))
    {
        *data.find_item_mut(id).unwrap() = candidate;
    }
    Ok(())
}

pub(super) fn selection_candidate(
    data: &AppStateData,
    item: &PlaylistItem,
    variant: &str,
) -> Option<PlaylistItem> {
    let supplement = data.audio_supplements.get(&item.id)?;
    if supplement.item_incarnation_id != item.item_incarnation_id
        || item.audio_variants.iter().any(|v| v["id"] == variant)
    {
        return None;
    }
    let candidate = supplement.candidate(item);
    candidate.audio_variants.iter().any(|v| v["id"] == variant).then_some(candidate)
}
