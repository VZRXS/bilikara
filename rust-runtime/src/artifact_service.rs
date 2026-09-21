//! Coarse local-only ABI adapter. No HTTP deletion API or second runtime.
use crate::app_state::{artifact_lifetime::collect_artifacts, with_cache_application};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{io, path::PathBuf};

#[derive(Deserialize)]
#[serde(tag = "command", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum ArtifactCommand {
    Open {
        cache_root: PathBuf,
    },
    Publish {
        owner: String,
        cache_attempt_token: u64,
    },
    Claim {
        owner: String,
        host_client_id: String,
        playback_generation: u64,
        item_incarnation_id: String,
        artifact_set_id: String,
    },
    Retire {
        owner: String,
        host_client_id: String,
        playback_generation: u64,
        item_incarnation_id: String,
        artifact_set_id: String,
    },
    Acquire {
        owner: String,
        relative_path: String,
    },
    Release {
        owner: String,
        handle: String,
    },
    Collect {
        owner: String,
    },
    Close {
        owner: String,
    },
    IsCurrent {
        owner: String,
    },
    FinishAttempts {
        owner: String,
        item_id: String,
        cache_attempt_tokens: Vec<u64>,
    },
}

pub(crate) fn execute(command: ArtifactCommand) -> Result<Value, io::Error> {
    use ArtifactCommand::*;
    if let Collect { owner } = command {
        return Ok(json!({"collected": collect_artifacts(Some(&owner))?}));
    }
    let result = with_cache_application(|app| -> io::Result<Value> {
        let owner = match &command {
            Open { .. } => None,
            Publish { owner, .. } | Claim { owner, .. } | Retire { owner, .. }
            | Acquire { owner, .. } | Release { owner, .. } | Close { owner } | Collect { owner }
            | IsCurrent { owner } | FinishAttempts { owner, .. } => Some(owner),
        };
        if owner.is_some_and(|owner| !app.artifact_owner(owner)) {
            return Ok(json!({"accepted": false, "handle": null}));
        }
        match command {
            Open { cache_root } => Ok(json!({"owner": app.open_artifact_lifetime(&cache_root)?})),
            Publish { cache_attempt_token, .. } => Ok(json!({"accepted": app.publish_external_artifact(cache_attempt_token)?})),
            Claim { host_client_id, playback_generation, item_incarnation_id, artifact_set_id, .. } =>
                Ok(json!({"accepted": app.claim_artifact_program(&host_client_id, playback_generation, &item_incarnation_id, &artifact_set_id, false)?})),
            Retire { host_client_id, playback_generation, item_incarnation_id, artifact_set_id, .. } =>
                Ok(json!({"accepted": app.claim_artifact_program(&host_client_id, playback_generation, &item_incarnation_id, &artifact_set_id, true)?})),
            Acquire { relative_path, .. } => Ok(json!({"handle": app.acquire_artifact_reader(&relative_path)?})),
            Release { handle, .. } => Ok(json!({"accepted": app.release_artifact_reader(&handle)})),
            Close { owner } => Ok(json!({"accepted": app.close_artifact_lifetime(&owner)})),
            IsCurrent { .. } => Ok(json!({"accepted": true})),
            FinishAttempts { item_id, cache_attempt_tokens, .. } => {
                for token in cache_attempt_tokens { app.settle_artifact_attempt(&item_id, token); }
                Ok(json!({"accepted": true}))
            }
            Collect { .. } => unreachable!(),
        }
    }).map_err(|error| io::Error::other(error.message))??;
    Ok(result)
}
