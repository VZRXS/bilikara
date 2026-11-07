//! Bounded committed queue transitions, never song content or bearer material.
use super::*;

pub(super) const MAX_DEPARTURES: usize = 256;

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum QueueActor {
    #[default]
    Runtime,
    Host,
    LanRemote,
    PublicRemote,
    PythonHost,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct QueueDeparture {
    pub item_id: String,
    pub item_incarnation_id: String,
    pub from: String,
    pub to: String,
    pub reason: String,
    pub operation: String,
    pub actor_channel: QueueActor,
    pub queue_version: String,
    pub playback_generation: u64,
    pub started: bool,
    pub timestamp: f64,
}

pub(super) fn operation(request: &AppStateRequest) -> &'static str {
    match request {
        AppStateRequest::RemoveItem { .. } => "explicit_delete",
        AppStateRequest::AdvanceToNext { .. } => "advance",
        AppStateRequest::SetCurrentItem { item_id: None, .. } => "clear_current",
        AppStateRequest::MoveToFront { .. } | AppStateRequest::SetCurrentItem { .. } => "play_now",
        AppStateRequest::DeferCurrentItem { .. } => "defer_current",
        AppStateRequest::ClearPlaylist { .. } => "clear_waiting",
        AppStateRequest::RestoreBackup { .. } => "backup_restore",
        AppStateRequest::DiscardBackup { .. } => "backup_discard",
        AppStateRequest::BeginSession { .. } | AppStateRequest::ResolveNativeSession { .. } => {
            "session_replace"
        }
        AppStateRequest::ResetRuntime { .. } => "runtime_reset",
        AppStateRequest::AddItem { .. } => "admission_promote",
        _ => "state_mutation",
    }
}

pub(super) fn validate(events: &[QueueDeparture]) -> Result<(), ExecuteError> {
    if events.len() > MAX_DEPARTURES
        || events.iter().any(|e| {
            !valid_string(&e.item_id, MAX_ITEM_ID_BYTES, false)
                || !valid_authoritative_identity(&e.item_incarnation_id, 'i')
                || !matches!(e.from.as_str(), "current" | "waiting")
                || !matches!(e.to.as_str(), "current" | "waiting" | "retired")
                || !matches!(
                    e.operation.as_str(),
                    "explicit_delete"
                        | "advance"
                        | "play_now"
                        | "defer_current"
                        | "clear_waiting"
                        | "backup_restore"
                        | "backup_discard"
                        | "session_replace"
                        | "runtime_reset"
                        | "admission_promote"
                        | "clear_current"
                        | "state_mutation"
                        | "initialization_replace"
                )
                || (e.reason != e.operation && e.reason != "skipped_unstarted")
                || e.queue_version.len() != 64
                || !e.queue_version.bytes().all(|b| b.is_ascii_hexdigit())
                || e.playback_generation > MAX_SAFE_JSON_INTEGER
                || !e.timestamp.is_finite()
                || e.timestamp < 0.0
        })
    {
        return Err(rejected(
            "invalid_initial_state",
            "invalid bounded queue diagnostics",
        ));
    }
    Ok(())
}

pub(super) fn record(
    before: &AppStateData,
    after: &mut AppStateData,
    operation: &str,
    actor: QueueActor,
    now: f64,
) {
    let positions: HashMap<_, _> = after
        .current_item
        .iter()
        .map(|i| (&i.item_incarnation_id, "current"))
        .chain(
            after
                .playlist
                .iter()
                .map(|i| (&i.item_incarnation_id, "waiting")),
        )
        .collect();
    let version = after.queue_version();
    let mut events = Vec::new();
    for (item, from) in before
        .current_item
        .iter()
        .map(|i| (i, "current"))
        .chain(before.playlist.iter().map(|i| (i, "waiting")))
    {
        let to = positions
            .get(&item.item_incarnation_id)
            .copied()
            .unwrap_or("retired");
        if from == to {
            continue;
        }
        let started = from == "current" && before.current_item_started;
        let skipped = from == "current"
            && to == "retired"
            && !started
            && matches!(
                operation,
                "advance" | "play_now" | "explicit_delete" | "clear_current"
            );
        events.push(QueueDeparture {
            item_id: item.id.clone(),
            item_incarnation_id: item.item_incarnation_id.clone(),
            from: from.into(),
            to: to.into(),
            reason: if skipped {
                "skipped_unstarted"
            } else {
                operation
            }
            .into(),
            operation: operation.into(),
            actor_channel: actor,
            queue_version: version.clone(),
            playback_generation: after.playback_generation,
            started,
            timestamp: now,
        });
    }
    // Limit memory even when a 10,000-item reset is committed at once.
    after.queue_departures.extend(
        events
            .into_iter()
            .rev()
            .take(MAX_DEPARTURES)
            .collect::<Vec<_>>()
            .into_iter()
            .rev(),
    );
    let excess = after.queue_departures.len().saturating_sub(MAX_DEPARTURES);
    after.queue_departures.drain(..excess);
}
