//! CacheRuntime event application shared by both Hosts. The runtime owns this
//! state and serializes draining, recovery and application; Hosts only observe.
use crate::app_state::{
    AppState, AppStateRequest, AppStateResponse, CacheDownloadProgress, CacheDownloadTrack,
    CacheEvent, PersistenceEffects,
};
use crate::cache_runtime::RuntimeEvent;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum HostContract {
    Default {
        max_cache_items: usize,
    },
    #[cfg(any(feature = "native-host", test))]
    Native,
}

#[derive(Default)]
pub(crate) struct CacheApplication {
    pub(crate) owner: Option<HostContract>,
    attempts: HashMap<String, Attempt>,
    settled_sequences: HashSet<u64>,
}

#[derive(Default)]
struct Attempt {
    source: String,
    generation: u64,
    token: u64,
    terminal_sequence: u64,
    tracks: HashMap<String, Track>,
}

#[derive(Clone, Default, Deserialize)]
#[serde(default)]
struct Track {
    key: String,
    label: String,
    order: usize,
    phase: String,
    attempt: u32,
    max_attempts: u32,
    current_bytes: u64,
    target_bytes: u64,
    progress_percent: Option<f64>,
    done: bool,
}

#[derive(Serialize)]
pub(crate) struct ArtifactSettlement {
    cache_attempt_token: u64,
    // Observation only; resource settlement already occurred under AppState.
    artifact: Option<ArtifactIdentity>,
}

#[derive(Serialize)]
struct ArtifactIdentity {
    item_incarnation_id: String,
    artifact_set_id: String,
    artifact_relative_directory: String,
}

#[derive(Default, Serialize)]
pub(crate) struct ApplicationEffects {
    pub(crate) observation: Option<AppStateResponse>,
    settlements: Vec<ArtifactSettlement>,
    activity_item_ids: Vec<String>,
    settled_item_ids: Vec<String>,
    pub(crate) cancelled: bool,
    pub(crate) errors: Vec<crate::app_state::AppStateError>,
}

impl CacheApplication {
    pub(crate) fn apply(
        &mut self,
        app: &mut AppState,
        events: Vec<RuntimeEvent>,
        contract: HostContract,
        now: f64,
    ) -> ApplicationEffects {
        let mut effects = ApplicationEffects::default();
        let mut committed = false;
        let mut persistence = PersistenceEffects::default();
        for event in events {
            if (event.generation == 0 && event.kind != "evicted")
                || event.cache_attempt_token == 0
                || event.item_id.is_empty()
            {
                continue;
            }
            let terminal = matches!(
                event.kind.as_str(),
                "ready" | "failed" | "cancelled" | "evicted"
            );
            let attempt = self.attempts.entry(event.item_id.clone()).or_default();
            // Clean stale publications too, but never make them current.
            if terminal && self.settled_sequences.insert(event.sequence) {
                if event.kind == "ready"
                    && let Some(artifact) = artifact_identity(&event.payload)
                {
                    app.register_ready_artifact(
                        &event.item_id,
                        event.cache_attempt_token,
                        &artifact.item_incarnation_id,
                        &artifact.artifact_set_id,
                        &artifact.artifact_relative_directory,
                    );
                }
                app.settle_artifact_attempt(&event.item_id, event.cache_attempt_token);
                effects.settlements.push(ArtifactSettlement {
                    cache_attempt_token: event.cache_attempt_token,
                    artifact: if event.kind == "ready" {
                        artifact_identity(&event.payload)
                    } else {
                        None
                    },
                });
            }
            if (event.generation > 0
                && (event.generation < attempt.generation
                    || (event.generation == attempt.generation
                        && attempt.token != event.cache_attempt_token)))
                || (event.sequence > 0 && event.sequence <= attempt.terminal_sequence)
            {
                continue;
            }
            if terminal {
                effects.settled_item_ids.push(event.item_id.clone());
            }
            let item = match app.cache_runtime_item(&event.item_id, event.cache_attempt_token) {
                Ok(item) => item,
                Err(error) => {
                    effects.errors.push(error);
                    continue;
                }
            };
            if event.generation > attempt.generation {
                *attempt = Attempt {
                    generation: event.generation,
                    token: event.cache_attempt_token,
                    ..Attempt::default()
                };
            }
            let count = item.selected_pages.len().max(1);
            let current_progress = item.cache_progress;
            let payload = &event.payload;
            let default = matches!(contract, HostContract::Default { .. });
            let projections = match event.kind.as_str() {
                "queued" => vec![CacheEvent::Queued {
                    message: "等待 Rust 缓存队列".into(),
                }],
                "started" => {
                    attempt.source = match payload["source"].as_str() {
                        Some("downkyi") => "downkyi",
                        Some("bbdown") => "bbdown",
                        _ => "native",
                    }
                    .into();
                    attempt.tracks = payload["tracks"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|t| serde_json::from_value::<Track>(t.clone()).ok())
                        .filter(|t| !t.key.is_empty())
                        .map(|t| (t.key.clone(), t))
                        .collect();
                    let message = if attempt.source == "downkyi" {
                        "DownKyi/aria2c 正在下载视频及音轨".into()
                    } else if default {
                        format!("正在缓存 1 路视频轨 + {count} 路音轨")
                    } else if payload["source"] == "bbdown" {
                        "BBDown 正在下载视频及音轨".into()
                    } else {
                        "正在下载视频及音轨".into()
                    };
                    let mut projections = vec![CacheEvent::Started { message }];
                    if !attempt.tracks.is_empty() {
                        projections.push(progress(attempt, 0.0));
                    }
                    projections
                }
                "progress" => {
                    let Ok(mut track) = serde_json::from_value::<Track>(payload["track"].clone())
                    else {
                        continue;
                    };
                    if track.key.is_empty() {
                        continue;
                    }
                    if attempt.tracks.is_empty() {
                        continue;
                    }
                    // Validation reports a phase change without transfer byte counters.
                    // Retain the completed download while the media backend validates it.
                    if track.phase == "validating"
                        && track.current_bytes == 0
                        && track.target_bytes == 0
                        && let Some(previous) = attempt.tracks.get(&track.key)
                    {
                        track.current_bytes = previous.current_bytes;
                        track.target_bytes = previous.target_bytes;
                    }
                    attempt.tracks.insert(track.key.clone(), track);
                    vec![progress(attempt, current_progress)]
                }
                "ready" => {
                    if default && artifact_identity(payload).is_none() {
                        effects.errors.push(crate::app_state::AppStateError {
                            kind: "cache_event".into(),
                            message: "Rust artifact reservation identity is invalid".into(),
                            details: None,
                        });
                        continue;
                    }
                    if default
                        && payload["audio_variants"]
                            .as_array()
                            .is_none_or(Vec::is_empty)
                    {
                        vec![CacheEvent::Failed {
                            message: "缓存失败: Rust 缓存结果缺少音轨".into(),
                        }]
                    } else {
                        let mut ready = payload.clone();
                        ready["kind"] = json!("ready");
                        ready["message"] = json!(if default {
                            format!("缓存完成，共 {count} 条音轨")
                        } else {
                            "已就绪".into()
                        });
                        match serde_json::from_value(ready) {
                            Ok(ready) => vec![ready],
                            Err(_) => {
                                effects.errors.push(crate::app_state::AppStateError {
                                    kind: "cache_event".into(),
                                    message: "缓存完成消息无效".into(),
                                    details: None,
                                });
                                continue;
                            }
                        }
                    }
                }
                "failed" => vec![CacheEvent::Failed {
                    message: if default {
                        format!(
                            "缓存失败: {}",
                            payload["message"]
                                .as_str()
                                .filter(|s| !s.is_empty())
                                .unwrap_or("Rust 缓存任务失败")
                        )
                    } else {
                        payload["message"]
                            .as_str()
                            .unwrap_or("媒体下载失败，请查看诊断或重试")
                            .chars()
                            .take(400)
                            .collect()
                    },
                }],
                "cancelled" | "evicted" => {
                    let message = match contract {
                        HostContract::Default { max_cache_items } => payload["reason"]
                            .as_str()
                            .filter(|s| !s.is_empty())
                            .map(str::to_owned)
                            .unwrap_or_else(|| {
                                if max_cache_items == 0 {
                                    "已禁用自动缓存".into()
                                } else {
                                    format!("仅自动缓存前 {max_cache_items} 首，已释放本地缓存")
                                }
                            }),
                        #[cfg(any(feature = "native-host", test))]
                        HostContract::Native => {
                            if event.kind == "cancelled" {
                                "缓存任务已取消".into()
                            } else {
                                "等待进入缓存窗口".into()
                            }
                        }
                    };
                    effects.cancelled |= event.kind == "cancelled";
                    vec![if event.kind == "cancelled" {
                        CacheEvent::Cancelled { message }
                    } else {
                        CacheEvent::Evicted { message }
                    }]
                }
                _ => continue,
            };
            for projection in projections {
                let response = app.execute(AppStateRequest::ApplyCacheEvent {
                    schema_version: 1,
                    item_id: event.item_id.clone(),
                    cache_attempt_token: event.cache_attempt_token,
                    event: projection,
                    now,
                });
                if let Some(error) = response.error() {
                    effects.errors.push(error.clone());
                }
                committed |= response.accumulate_cache_effects(&mut persistence);
            }
            if terminal {
                attempt.terminal_sequence = event.sequence;
                attempt.tracks.clear();
            }
            effects.activity_item_ids.push(event.item_id);
        }
        effects.observation = Some(app.cache_observation(committed, persistence));
        effects
    }

    pub(crate) fn retain(&mut self, ids: &HashSet<String>, sequences: &HashSet<u64>) {
        self.attempts.retain(|id, _| ids.contains(id));
        self.settled_sequences
            .retain(|sequence| sequences.contains(sequence));
    }
}

fn artifact_identity(payload: &Value) -> Option<ArtifactIdentity> {
    let incarnation = payload["item_incarnation_id"].as_str()?;
    let artifact = payload["artifact_set_id"].as_str()?;
    let directory = payload["artifact_relative_directory"].as_str()?;
    if !crate::app_state::valid_authoritative_identity(incarnation, 'i')
        || !crate::app_state::valid_authoritative_identity(artifact, 'a')
        || !crate::app_state::valid_artifact_relative_directory(directory, incarnation, artifact)
    {
        return None;
    }
    Some(ArtifactIdentity {
        item_incarnation_id: incarnation.into(),
        artifact_set_id: artifact.into(),
        artifact_relative_directory: directory.into(),
    })
}

fn bytes(value: u64) -> String {
    let mut size = value as f64;
    let mut index = 0;
    let units = ["B", "KB", "MB", "GB", "TB"];
    while size >= 1024.0 && index < 4 {
        size /= 1024.0;
        index += 1;
    }
    if index == 0 {
        format!("{value} B")
    } else {
        format!("{size:.1} {}", units[index])
    }
}

fn progress(attempt: &Attempt, previous: f64) -> CacheEvent {
    let mut tracks: Vec<_> = attempt.tracks.values().collect();
    tracks.sort_by_key(|t| t.order);
    let current: u64 = tracks
        .iter()
        .map(|t| {
            if t.target_bytes > 0 {
                t.current_bytes.min(t.target_bytes)
            } else {
                t.current_bytes
            }
        })
        .sum();
    let target: u64 = tracks.iter().map(|t| t.target_bytes).sum();
    let known = tracks.iter().all(|t| t.target_bytes > 0);
    let done = tracks.iter().all(|t| t.done);
    let cap = if done { 99.0 } else { 98.0 };
    let value = if known && target > 0 {
        (current as f64 / target as f64).clamp(0.0, 1.0) * cap
    } else if tracks
        .iter()
        .any(|t| t.done || t.progress_percent.is_some())
    {
        tracks
            .iter()
            .map(|t| {
                if t.done {
                    1.0
                } else {
                    t.progress_percent.unwrap_or(0.0).clamp(0.0, 100.0) / 100.0
                }
            })
            .sum::<f64>()
            / tracks.len() as f64
            * cap
    } else {
        previous
    };
    let mut lines = vec![format!(
        "总计：{} / {}",
        bytes(current),
        if known && target > 0 {
            bytes(target)
        } else {
            "估算中".into()
        }
    )];
    if attempt.source == "downkyi" {
        lines[0].insert_str(0, "DownKyi/aria2c · ");
    }
    let mut download_tracks = Vec::new();
    for t in tracks {
        let mut label = if t.label.is_empty() {
            "轨道".into()
        } else {
            t.label.clone()
        };
        match t.phase.as_str() {
            "validating" => label.push_str("（校验中）"),
            "retrying" if t.attempt > 0 && t.max_attempts > 0 => {
                label.push_str(&format!("（第 {}/{} 次失败）", t.attempt, t.max_attempts))
            }
            "downloading" if t.attempt > 1 && t.max_attempts > 0 => {
                label.push_str(&format!("（重试 {}/{}）", t.attempt, t.max_attempts))
            }
            _ => {}
        }
        download_tracks.push(CacheDownloadTrack {
            key: t.key.clone(),
            label: label.clone(),
            current_bytes: if t.target_bytes > 0 {
                t.current_bytes.min(t.target_bytes)
            } else {
                t.current_bytes
            },
            target_bytes: t.target_bytes,
            done: t.done,
            phase: t.phase.clone(),
            attempt: t.attempt,
            max_attempts: t.max_attempts,
        });
        lines.push(format!(
            "{label}：{} / {}",
            bytes(if t.target_bytes > 0 {
                t.current_bytes.min(t.target_bytes)
            } else {
                t.current_bytes
            }),
            if t.target_bytes > 0 {
                bytes(t.target_bytes)
            } else {
                "估算中".into()
            }
        ));
    }
    CacheEvent::Progress {
        download: Some(CacheDownloadProgress {
            current_bytes: current,
            total_bytes: if known { target } else { 0 },
            tracks: download_tracks,
        }),
        progress: value.max(previous).min(99.0),
        message: Some(lines.join("\n")),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    fn request(app: &mut AppState, value: Value) -> AppStateResponse {
        let response = app.execute(serde_json::from_value(value).unwrap());
        assert!(response.error().is_none(), "{response:?}");
        response
    }

    pub(crate) fn fixture() -> (AppState, Value) {
        let mut app = AppState::default();
        request(
            &mut app,
            json!({"command":"initialize","schema_version":1,"state":{
                "current_item": {"id":"song","original_url":"https://example.test/song","resolved_url":"https://example.test/song","bvid":"BVfixture","aid":1,"cid":2,"title":"song","part_title":"P1","display_title":"song","cover_url":"","embed_url":"","selected_pages":[1,2]},
                "session_started_at":1.0,"session_played_file":"session.json","updated_at":1.0
            }}),
        );
        let reservation = reserve(&mut app);
        (app, reservation)
    }

    fn reserve(app: &mut AppState) -> Value {
        let snapshot = request(app, json!({"command":"snapshot","schema_version":1}));
        let incarnation = snapshot
            .snapshot()
            .unwrap()
            .current_item
            .as_ref()
            .unwrap()
            .item_incarnation_id
            .clone();
        request(app, json!({"command":"begin_cache_attempt","schema_version":1,"item_id":"song","expected_item_incarnation_id":incarnation})).result().unwrap().clone()
    }

    fn event(
        reservation: &Value,
        sequence: u64,
        generation: u64,
        kind: &str,
        payload: Value,
    ) -> RuntimeEvent {
        RuntimeEvent {
            sequence,
            generation,
            cache_attempt_token: reservation["cache_attempt_token"].as_u64().unwrap(),
            item_id: "song".into(),
            kind: kind.into(),
            payload,
        }
    }

    fn ready(reservation: &Value) -> Value {
        let directory = reservation["artifact_relative_directory"].as_str().unwrap();
        json!({"video_relative_path":format!("{directory}/video.mp4"),"video_media_url":format!("/media/{directory}/video.mp4"),
            "audio_variants":[{"id":"p1","label":"P1","page":1,"audio_url":format!("/media/{directory}/p1.m4a")},{"id":"p2","label":"P2","page":2,"audio_url":format!("/media/{directory}/p2.m4a")}],"selected_audio_variant_id":"p2",
            "item_incarnation_id":reservation["item_incarnation_id"],"artifact_set_id":reservation["artifact_set_id"],"artifact_relative_directory":directory})
    }

    fn apply(
        service: &mut CacheApplication,
        app: &mut AppState,
        events: Vec<RuntimeEvent>,
    ) -> ApplicationEffects {
        service.apply(
            app,
            events,
            HostContract::Default { max_cache_items: 3 },
            2.0,
        )
    }

    fn item(effects: &ApplicationEffects) -> &crate::PlaylistItem {
        effects
            .observation
            .as_ref()
            .unwrap()
            .snapshot()
            .unwrap()
            .current_item
            .as_ref()
            .unwrap()
    }

    #[test]
    fn queued_started_multitrack_progress_and_ready_preserve_default_contract() {
        let (mut app, reservation) = fixture();
        let mut service = CacheApplication::default();
        let queued = apply(
            &mut service,
            &mut app,
            vec![event(&reservation, 1, 1, "queued", json!({}))],
        );
        assert_eq!(item(&queued).cache_status, "queued");
        assert_eq!(item(&queued).cache_message, "等待 Rust 缓存队列");
        let tracks = json!([{"key":"v","label":"视频","order":0,"current_bytes":20,"target_bytes":100},{"key":"a","label":"音轨","order":1,"current_bytes":0,"target_bytes":300}]);
        let started = apply(
            &mut service,
            &mut app,
            vec![event(
                &reservation,
                2,
                1,
                "started",
                json!({"tracks":tracks}),
            )],
        );
        assert_eq!(item(&started).cache_status, "downloading");
        assert_eq!(item(&started).cache_progress, 4.9);
        assert!(item(&started).cache_message.contains("总计：20 B / 400 B"));
        let progress = apply(
            &mut service,
            &mut app,
            vec![event(
                &reservation,
                3,
                1,
                "progress",
                json!({"track":{"key":"a","label":"音轨","order":1,"current_bytes":180,"target_bytes":300,"phase":"retrying","attempt":2,"max_attempts":10}}),
            )],
        );
        assert_eq!(item(&progress).cache_progress, 49.0);
        assert!(
            item(&progress)
                .cache_message
                .contains("音轨（第 2/10 次失败）")
        );
        let ready_event = event(&reservation, 4, 1, "ready", ready(&reservation));
        let completed = apply(&mut service, &mut app, vec![ready_event.clone()]);
        assert_eq!(item(&completed).cache_status, "ready");
        assert_eq!(item(&completed).cache_progress, 100.0);
        assert_eq!(item(&completed).cache_download_current_bytes, 0);
        assert!(item(&completed).cache_download_tracks.is_empty());
        assert_eq!(item(&completed).cache_message, "缓存完成，共 2 条音轨");
        assert_eq!(item(&completed).selected_audio_variant_id, "p2");
        assert_eq!(completed.settlements.len(), 1);
        let observation = serde_json::to_value(completed.observation.as_ref().unwrap()).unwrap();
        assert_eq!(observation["committed"], true);
        assert_eq!(observation["effects"]["write_core"], true);
        assert_eq!(observation["effects"]["write_backup"], false);
        request(
            &mut app,
            json!({"command":"set_audio_variant","schema_version":1,"item_id":"song","variant_id":"p1","expected_item_incarnation_id":reservation["item_incarnation_id"],"now":3.0}),
        );
        let replay = apply(
            &mut service,
            &mut app,
            vec![ready_event, event(&reservation, 3, 1, "started", json!({}))],
        );
        assert_eq!(item(&replay).selected_audio_variant_id, "p1");
        assert_eq!(item(&replay).cache_status, "ready");
        assert!(replay.settlements.is_empty());
        assert_eq!(
            serde_json::to_value(replay.observation).unwrap()["committed"],
            false
        );
    }

    #[test]
    fn identities_replacements_terminal_replay_and_stale_artifact_settlement() {
        let (mut app, old) = fixture();
        let mut service = CacheApplication::default();
        let new = reserve(&mut app);
        let start = event(&new, 2, 2, "started", json!({}));
        apply(&mut service, &mut app, vec![start]);
        for token in [0, u64::MAX, old["cache_attempt_token"].as_u64().unwrap()] {
            let invalid = RuntimeEvent {
                cache_attempt_token: token,
                ..event(&old, 3, 999, "failed", json!({"message":"wrong"}))
            };
            let result = apply(&mut service, &mut app, vec![invalid]);
            assert_eq!(item(&result).cache_status, "downloading");
            assert_eq!(service.attempts["song"].generation, 2);
        }
        let stale = apply(
            &mut service,
            &mut app,
            vec![event(&old, 4, 1, "ready", ready(&old))],
        );
        assert_eq!(item(&stale).cache_status, "downloading");
        assert_eq!(stale.settlements.len(), 1);
        assert!(stale.settlements[0].artifact.is_some());
        let result = apply(
            &mut service,
            &mut app,
            vec![event(&new, 5, 2, "ready", ready(&new))],
        );
        assert_eq!(item(&result).artifact_set_id, new["artifact_set_id"]);
        let result = apply(
            &mut service,
            &mut app,
            vec![event(
                &new,
                6,
                2,
                "failed",
                json!({"message":"late failure"}),
            )],
        );
        assert_eq!(item(&result).cache_status, "ready");
        assert_eq!(result.errors[0].kind, "cache_terminal_conflict");
    }

    #[test]
    fn terminal_errors_cancellation_eviction_and_refresh_keep_existing_contracts() {
        for (kind, payload, status, message) in [
            (
                "failed",
                json!({"message":"provider rejected"}),
                "failed",
                "缓存失败: provider rejected",
            ),
            (
                "cancelled",
                json!({"reason":"stopped"}),
                "pending",
                "stopped",
            ),
            (
                "evicted",
                json!({}),
                "pending",
                "仅自动缓存前 3 首，已释放本地缓存",
            ),
            (
                "ready",
                json!({}),
                "failed",
                "缓存失败: Rust 缓存结果缺少音轨",
            ),
        ] {
            let (mut app, reservation) = fixture();
            let mut service = CacheApplication::default();
            let payload = if kind == "ready" {
                let mut payload = ready(&reservation);
                payload["audio_variants"] = json!([]);
                payload
            } else {
                payload
            };
            let terminal = event(&reservation, 1, 1, kind, payload);
            let result = apply(&mut service, &mut app, vec![terminal.clone()]);
            assert_eq!(item(&result).cache_status, status);
            assert_eq!(item(&result).cache_message, message);
            let replay = apply(&mut service, &mut app, vec![terminal]);
            assert!(replay.activity_item_ids.is_empty());
        }
        let (mut app, old) = fixture();
        let mut service = CacheApplication::default();
        apply(
            &mut service,
            &mut app,
            vec![event(&old, 1, 1, "ready", ready(&old))],
        );
        let refresh = reserve(&mut app);
        let result = apply(
            &mut service,
            &mut app,
            vec![event(
                &refresh,
                2,
                2,
                "cancelled",
                json!({"reason":"disabled"}),
            )],
        );
        assert_eq!(item(&result).cache_status, "ready");
        assert_eq!(item(&result).artifact_set_id, old["artifact_set_id"]);
    }

    #[test]
    fn inverse_delivery_and_conflicting_generation_token_pair_cannot_replace_newer_attempt() {
        let (mut app, old) = fixture();
        let mut service = CacheApplication::default();
        let new = reserve(&mut app);
        apply(
            &mut service,
            &mut app,
            vec![event(&new, 2, 2, "started", json!({}))],
        );
        for stale in [
            event(&old, 1, 1, "queued", json!({})),
            event(&old, 3, 2, "failed", json!({})),
            event(&new, 4, 1, "failed", json!({})),
        ] {
            let result = apply(&mut service, &mut app, vec![stale]);
            assert_eq!(item(&result).cache_status, "downloading");
            assert_eq!(service.attempts["song"].generation, 2);
            assert_eq!(service.attempts["song"].token, new["cache_attempt_token"]);
        }
        service.retain(&HashSet::new(), &HashSet::new());
        assert!(service.attempts.is_empty());
        assert!(service.settled_sequences.is_empty());
    }

    #[test]
    fn removed_and_same_id_new_incarnation_reject_late_completion_and_cleanup_once() {
        let (mut app, old) = fixture();
        let original = request(&mut app, json!({"command":"snapshot","schema_version":1}))
            .snapshot()
            .unwrap()
            .current_item
            .clone()
            .unwrap();
        let mut service = CacheApplication::default();
        apply(
            &mut service,
            &mut app,
            vec![event(&old, 1, 1, "started", json!({}))],
        );
        request(
            &mut app,
            json!({"command":"remove_item","schema_version":1,"item_id":"song","now":3.0}),
        );
        let late = event(&old, 2, 1, "ready", ready(&old));
        let removed = apply(&mut service, &mut app, vec![late.clone()]);
        assert!(
            removed
                .observation
                .unwrap()
                .snapshot()
                .unwrap()
                .current_item
                .is_none()
        );
        assert_eq!(removed.settlements.len(), 1);
        assert!(removed.settlements[0].artifact.is_some());
        request(
            &mut app,
            json!({"command":"add_session_user","schema_version":1,"name":"fixture","now":3.0}),
        );
        request(
            &mut app,
            json!({"command":"add_item","schema_version":1,"item":original,"position":"tail","requester_name":"fixture","allow_repeat":true,"now":3.0}),
        );
        let new = reserve(&mut app);
        assert_ne!(old["item_incarnation_id"], new["item_incarnation_id"]);
        let replay = apply(&mut service, &mut app, vec![late]);
        assert_eq!(item(&replay).cache_status, "pending");
        assert!(replay.settlements.is_empty());
        let accepted = apply(
            &mut service,
            &mut app,
            vec![event(&new, 3, 2, "ready", ready(&new))],
        );
        assert_eq!(item(&accepted).artifact_set_id, new["artifact_set_id"]);
        // Recovery can deliver a newer terminal before an older queued terminal.
        // That old publication still requires a collector notification.
        let old_completion = apply(
            &mut service,
            &mut app,
            vec![event(&old, 1, 1, "ready", ready(&old))],
        );
        assert_eq!(old_completion.settlements.len(), 1);
        assert_eq!(
            item(&old_completion).artifact_set_id,
            new["artifact_set_id"]
        );
    }

    #[test]
    fn zero_generation_eviction_uses_authoritative_attempt_and_invalid_ready_cannot_publish() {
        let (mut app, old) = fixture();
        let mut service = CacheApplication::default();
        apply(
            &mut service,
            &mut app,
            vec![event(&old, 1, 1, "ready", ready(&old))],
        );
        let eviction = reserve(&mut app);
        let result = apply(
            &mut service,
            &mut app,
            vec![event(
                &eviction,
                2,
                0,
                "evicted",
                json!({"reason":"outside cache window"}),
            )],
        );
        assert_eq!(item(&result).cache_status, "pending");
        assert!(item(&result).artifact_set_id.is_empty());
        let new = reserve(&mut app);
        let mut invalid = ready(&new);
        invalid["artifact_set_id"] = old["artifact_set_id"].clone();
        let rejected = apply(
            &mut service,
            &mut app,
            vec![event(&new, 3, 2, "ready", invalid)],
        );
        assert_eq!(item(&rejected).cache_status, "pending");
        assert!(rejected.settlements[0].artifact.is_none());
        assert_eq!(rejected.errors[0].kind, "cache_event");
        let mut invalid = ready(&new);
        invalid["video_relative_path"] = json!("../../escape.mp4");
        let rejected = apply(
            &mut service,
            &mut app,
            vec![event(&new, 4, 2, "ready", invalid)],
        );
        assert_eq!(item(&rejected).cache_status, "pending");
        assert!(!rejected.errors.is_empty());
    }

    #[test]
    fn native_tracks_stay_aggregated_and_activity_survives_rounded_progress() {
        for source in ["native", "bbdown", "downkyi"] {
            let (mut app, reservation) = fixture();
            let mut service = CacheApplication::default();
            let tracks = json!([
                {"key":"v","label":"视频P1","order":0,"current_bytes":80,"target_bytes":100},
                {"key":"a","label":"音轨P2","order":1,"current_bytes":20,"target_bytes":100}
            ]);
            let result = service.apply(
                &mut app,
                vec![event(
                    &reservation,
                    1,
                    1,
                    "started",
                    json!({"source":source,"tracks":tracks}),
                )],
                HostContract::Native,
                2.0,
            );
            assert_eq!(item(&result).cache_progress, 49.0);
            for (sequence, current, now) in [(2, 40, 3.0), (3, 40, 4.0), (4, 0, 5.0)] {
                let result = service.apply(&mut app, vec![event(&reservation,sequence,1,"progress",json!({"source":source,"track":{"key":"a","label":"音轨P2","order":1,"current_bytes":current,"target_bytes":100}}))], HostContract::Native, now);
                let song = item(&result);
                assert!(
                    (song.cache_progress - 58.8).abs() < 0.001,
                    "{source}: {}",
                    song.cache_progress
                );
                assert!(song.cache_message.contains("视频P1：80 B / 100 B"));
                assert!(song.cache_message.contains("音轨P2："));
                assert_eq!(song.cache_activity_at, now);
                assert_eq!(song.cache_download_current_bytes, 80 + current);
                assert_eq!(song.cache_download_total_bytes, 200);
                assert_eq!(song.cache_download_tracks.len(), 2);
                assert_eq!(song.cache_download_tracks[0].key, "v");
                assert_eq!(song.cache_download_tracks[1].current_bytes, current);
            }
        }
    }

    #[test]
    fn byte_snapshot_retains_unknown_track_sizes_and_clears_terminal_state() {
        let (mut app, reservation) = fixture();
        let mut service = CacheApplication::default();
        let result = apply(
            &mut service,
            &mut app,
            vec![event(
                &reservation,
                1,
                1,
                "started",
                json!({"source":"native","tracks":[
                    {"key":"v","label":"Video","order":0,"current_bytes":120,"target_bytes":100},
                    {"key":"a","label":"Audio","order":1,"current_bytes":30,"target_bytes":0}
                ]}),
            )],
        );
        assert_eq!(item(&result).cache_download_current_bytes, 130);
        assert_eq!(
            item(&result).cache_download_total_bytes,
            0,
            "one unknown track means total is unknown"
        );
        assert_eq!(item(&result).cache_download_tracks[0].current_bytes, 100);
        let result = apply(
            &mut service,
            &mut app,
            vec![event(
                &reservation,
                2,
                1,
                "progress",
                json!({"track":{
                    "key":"a","label":"Audio","order":1,"phase":"validating","current_bytes":0,"target_bytes":0
                }}),
            )],
        );
        assert_eq!(
            item(&result).cache_download_current_bytes,
            130,
            "validation retains transferred bytes"
        );
        let result = apply(
            &mut service,
            &mut app,
            vec![event(
                &reservation,
                3,
                1,
                "failed",
                json!({"message":"fixture failure"}),
            )],
        );
        assert_eq!(item(&result).cache_download_current_bytes, 0);
        assert_eq!(item(&result).cache_download_total_bytes, 0);
        assert!(item(&result).cache_download_tracks.is_empty());
        let result = apply(
            &mut service,
            &mut app,
            vec![event(
                &reservation,
                2,
                1,
                "progress",
                json!({"track":{
                    "key":"a","current_bytes":999,"target_bytes":1000
                }}),
            )],
        );
        assert!(
            item(&result).cache_download_tracks.is_empty(),
            "late events cannot restore stale bytes"
        );
    }

    #[test]
    fn native_contract_retains_bbdown_messages_and_error_limits() {
        let (mut app, reservation) = fixture();
        let mut service = CacheApplication::default();
        let result = service.apply(
            &mut app,
            vec![event(
                &reservation,
                1,
                1,
                "started",
                json!({"source":"bbdown","tracks":[{"key":"v","label":"视频","target_bytes":100}]}),
            )],
            HostContract::Native,
            2.0,
        );
        assert!(item(&result).cache_message.contains("视频：0 B / 100 B"));
        let result=service.apply(&mut app,vec![event(&reservation,2,1,"progress",json!({"source":"bbdown","track":{"key":"v","label":"视频","current_bytes":70,"target_bytes":100}}))],HostContract::Native,2.0);
        assert!((item(&result).cache_progress - 68.6).abs() < 0.001);
        assert!(item(&result).cache_message.contains("视频：70 B / 100 B"));
        let result = service.apply(
            &mut app,
            vec![event(
                &reservation,
                3,
                1,
                "failed",
                json!({"message":"错".repeat(500)}),
            )],
            HostContract::Native,
            2.0,
        );
        assert_eq!(item(&result).cache_message.chars().count(), 400);
    }

    #[test]
    fn malformed_ready_is_rejected_without_mutating_and_percent_fallback_is_preserved() {
        let (mut app, reservation) = fixture();
        let mut service = CacheApplication::default();
        let result = service.apply(
            &mut app,
            vec![event(&reservation, 1, 1, "ready", json!({}))],
            HostContract::Native,
            2.0,
        );
        assert_eq!(result.errors[0].kind, "cache_event");
        assert_eq!(item(&result).cache_status, "pending");
        let result = apply(
            &mut service,
            &mut app,
            vec![event(
                &reservation,
                2,
                1,
                "started",
                json!({"tracks":[{"key":"v","done":true},{"key":"a","progress_percent":50.0}]}),
            )],
        );
        assert_eq!(item(&result).cache_progress, 73.5);
        assert!(item(&result).cache_message.contains("估算中"));
    }
}
