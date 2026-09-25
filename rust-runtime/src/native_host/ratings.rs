//! Native rating admission lives in AppState. Cloud I/O happens outside its
//! lock, and success is acknowledged only after the existing service accepts it.
use super::*;
use crate::app_state::AppState;
use crate::cloudflare_service::{CloudflareServiceRequest, execute_cloudflare};
use std::collections::VecDeque;

#[derive(Default)]
pub(crate) struct RatingLedger {
    generation: u64,
    sequence: u64,
    entries: VecDeque<Entry>,
    pub events: VecDeque<Value>,
}
struct Entry {
    id: u64,
    user: String,
    play: String,
    complete: bool,
    status: &'static str,
    payload: Value,
}
pub(super) struct Submission {
    owner: String,
    generation: u64,
    id: u64,
    payload: Value,
    waiting: bool,
}

impl RatingLedger {
    fn reserve(
        &mut self,
        generation: u64,
        user: &str,
        play: &str,
        waiting: bool,
    ) -> Result<Option<u64>, ApiError> {
        if self.generation != generation {
            self.entries.clear();
            self.generation = generation;
        }
        let user = user.to_lowercase();
        self.entries.retain(|e| {
            !(e.user == user && e.play == play && matches!(e.status, "failed" | "discarded"))
        });
        if let Some(entry) = self
            .entries
            .iter()
            .find(|e| e.user == user && e.play == play)
        {
            return if entry.complete {
                Ok(None)
            } else {
                Err(ApiError::new(
                    409,
                    "rating_pending",
                    "此评分正在提交，请稍候",
                ))
            };
        }
        if self
            .entries
            .iter()
            .filter(|e| !e.complete && !matches!(e.status, "failed" | "discarded"))
            .count()
            >= 64
            || (!waiting
                && self
                    .entries
                    .iter()
                    .filter(|e| e.status == "sending")
                    .count()
                    >= 4)
        {
            return Err(ApiError::new(
                429,
                "rating_busy",
                "评分提交较多，请稍后重试",
            ));
        }
        if self.entries.len() >= 2048 {
            // Never evict a still-running request's duplicate guard.
            if let Some(index) = self
                .entries
                .iter()
                .position(|e| e.complete || matches!(e.status, "failed" | "discarded"))
            {
                self.entries.remove(index);
            }
        }
        self.sequence += 1;
        self.entries.push_back(Entry {
            id: self.sequence,
            user,
            play: play.into(),
            complete: false,
            status: if waiting { "waiting" } else { "sending" },
            payload: Value::Null,
        });
        Ok(Some(self.sequence))
    }
    pub(crate) fn rename(&mut self, old: &str, new: &str) {
        for entry in &mut self.entries {
            if entry.user == old.to_lowercase() {
                entry.user = new.to_lowercase();
                entry.payload["session_user_name"] = json!(new);
            }
        }
    }
    fn finish(&mut self, submission: &Submission, success: bool) {
        if self.generation == submission.generation
            && let Some(index) = self.entries.iter().position(|e| e.id == submission.id)
        {
            if success {
                self.entries[index].complete = true;
                self.entries[index].status = "accepted";
            } else {
                self.entries[index].status = "failed";
            }
        }
        if self.events.len() >= 50 {
            self.events.pop_front();
        }
        self.events
            .push_back(json!({"at":now(),"event":if success {"accepted"} else {"failed"}}));
    }
}

pub(super) fn prepare(
    app: &mut AppState,
    identity: &Identity,
    body: &Value,
) -> Result<Option<Submission>, ApiError> {
    let user = app.native_requester(identity, body["session_user_name"].as_str().unwrap_or(""))?;
    let snapshot = app.native_core_snapshot()?;
    if !snapshot.session_users.contains(&user) {
        return Err(ApiError::new(403, "identity_required", "请先登记点歌人"));
    }
    let play = crate::app_state::native_session::text(body, "play_id")?;
    let bvid = crate::app_state::native_session::text(body, "bvid")?;
    let score = body["score"]
        .as_u64()
        .filter(|score| (1..=5).contains(score))
        .ok_or_else(|| ApiError::invalid("评分必须为 1–5 的整数"))?;
    if bvid.len() != 12
        || !bvid.starts_with("BV")
        || !bvid.bytes().all(|c| c.is_ascii_alphanumeric())
    {
        return Err(ApiError::invalid("BV 号无效"));
    }
    let played_here = snapshot
        .current_item
        .as_ref()
        .is_some_and(|item| item.id == play && item.bvid == bvid)
        || snapshot
            .session_played
            .iter()
            .any(|item| item.item_id == play && item.bvid == bvid);
    if !played_here {
        return Err(ApiError::new(
            409,
            "rating_stale",
            "此歌曲不在当前场次的播放记录中",
        ));
    }
    let eligible = snapshot
        .session_played
        .iter()
        .any(|item| item.item_id == play && item.bvid == bvid && item.threshold_reached);
    let current = snapshot
        .current_item
        .as_ref()
        .is_some_and(|item| item.id == play && item.bvid == bvid);
    if !eligible && !current {
        return Err(ApiError::new(
            409,
            "rating_not_eligible",
            "此歌曲未播放达到 50%，评分已失效",
        ));
    }
    let id = app
        .native()
        .ratings
        .reserve(snapshot.session_generation, &user, &play, !eligible)?;
    let payload = json!({"session_user_name":user,"play_id":play,"bvid":bvid,"score":score});
    if let Some(id) = id {
        let entry = app
            .native()
            .ratings
            .entries
            .iter_mut()
            .find(|e| e.id == id)
            .unwrap();
        entry.payload = payload.clone();
        entry.status = if eligible { "sending" } else { "waiting" };
        app.native().revision += 1;
    }
    Ok(id.map(|id| Submission {
        owner: app.native().host_token.clone(),
        id,
        generation: snapshot.session_generation,
        payload,
        waiting: !eligible,
    }))
}

fn send(
    submission: &Submission,
    transport: impl Fn(
        &CloudflareServiceRequest,
    ) -> Result<Value, crate::cloudflare_service::CloudflareServiceError>,
) -> Result<(), ApiError> {
    let result = crate::shared_catalog::execute_with(
        &crate::shared_catalog::CatalogRequest {
            operation: crate::shared_catalog::CatalogOperation::Mutate {
                action: crate::shared_catalog::CatalogAction::RateSong,
                params: submission.payload.clone(),
            },
            ..crate::shared_catalog::CatalogRequest::for_host()
        },
        &transport,
    );
    match result {
        Ok(value) if value["success"] == true => Ok(()),
        // Never expose upstream response previews, cookies or arbitrary text.
        _ => Err(ApiError::new(
            503,
            "rating_unavailable",
            "评分提交失败，请稍后重新评分",
        )),
    }
}

pub(super) fn submit(
    context: &HostContext,
    identity: &Identity,
    body: &Value,
) -> Result<Value, ApiError> {
    submit_reserved(with_app(|app| {
        if context.stop.load(Ordering::Acquire) {
            return Err(ApiError::new(503, "stopped", "Host 已停止"));
        }
        prepare(app, identity, body)
    })?)
}

fn finish(app: &mut AppState, submission: &Submission, success: bool) {
    if app.native().host_token == submission.owner {
        app.native().ratings.finish(submission, success);
        app.native().revision += 1;
    }
}

pub(super) fn submit_reserved(submission: Option<Submission>) -> Result<Value, ApiError> {
    let Some(submission) = submission else {
        return Ok(json!({"success":true,"queued":false,"duplicate":true}));
    };
    if submission.waiting {
        return Ok(json!({"success":true,"queued":true,"duplicate":false}));
    }
    // A dropped/panicking transport must release admission just like a timeout.
    struct Pending {
        value: Submission,
        finished: bool,
    }
    impl Drop for Pending {
        fn drop(&mut self) {
            if !self.finished {
                let _ = with_app(|app| {
                    finish(app, &self.value, false);
                    Ok(())
                });
            }
        }
    }
    let mut pending = Pending {
        value: submission,
        finished: false,
    };
    let result = send(&pending.value, execute_cloudflare);
    with_app(|app| {
        finish(app, &pending.value, result.is_ok());
        Ok(())
    })?;
    pending.finished = true;
    result?;
    Ok(json!({"success":true,"queued":false,"duplicate":false}))
}

impl RatingLedger {
    pub(crate) fn snapshot(
        &self,
        generation: u64,
        current: Option<&str>,
        previous: Option<&str>,
    ) -> Value {
        if self.generation != generation {
            return json!([]);
        }
        json!(
            self.entries
                .iter()
                .filter(|entry| Some(entry.play.as_str()) == current
                    || Some(entry.play.as_str()) == previous)
                .map(|entry| json!({
                    "session_user_name":entry.user,"play_id":entry.play,
                    "status":entry.status
                }))
                .collect::<Vec<_>>()
        )
    }
}

// Admission and readiness remain under the AppState lock. Only the accepted
// player observation may latch eligibility; clients cannot submit a ratio.
fn take_ready(app: &mut AppState) -> Result<Option<Submission>, ApiError> {
    if !app
        .native()
        .ratings
        .entries
        .iter()
        .any(|entry| entry.status == "waiting")
    {
        return Ok(None);
    }
    let snapshot = app.native_core_snapshot()?;
    let owner = app.native().host_token.clone();
    let ledger = &mut app.native().ratings;
    if ledger.generation != snapshot.session_generation {
        ledger.entries.clear();
        ledger.generation = snapshot.session_generation;
        return Ok(None);
    }
    let has_slot = ledger
        .entries
        .iter()
        .filter(|e| e.status == "sending")
        .count()
        < 4;
    let mut ready = None;
    let mut changed = false;
    for entry in &mut ledger.entries {
        if entry.status != "waiting" {
            continue;
        }
        let user_exists = snapshot
            .session_users
            .iter()
            .any(|user| user.to_lowercase() == entry.user);
        let eligible = snapshot
            .session_played
            .iter()
            .any(|item| item.item_id == entry.play && item.threshold_reached);
        let current = snapshot
            .current_item
            .as_ref()
            .is_some_and(|item| item.id == entry.play);
        if !user_exists || (!eligible && !current) {
            entry.status = "discarded";
            changed = true;
        } else if eligible && has_slot && ready.is_none() {
            entry.status = "sending";
            changed = true;
            ready = Some(Submission {
                owner: owner.clone(),
                generation: ledger.generation,
                id: entry.id,
                payload: entry.payload.clone(),
                waiting: false,
            });
        }
    }
    if changed {
        app.native().revision += 1;
    }
    Ok(ready)
}

pub(super) fn start_pump(context: Arc<HostContext>) -> Result<(), ApiError> {
    context
        .clone()
        .spawn("native-host-ratings", move || {
            while !context.stop.load(Ordering::Acquire) {
                if let Ok(Some(submission)) = with_app(take_ready) {
                    // Failure remains visible and can be retried explicitly. No
                    // unbounded automatic traffic against the shared catalog.
                    let _ = submit_reserved(Some(submission));
                }
                thread::sleep(Duration::from_millis(200));
            }
        })
        .map_err(|_| ApiError::new(503, "rating_start", "无法启动评分提交服务"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloudflare_service::CloudflareOperation;
    fn waiting_fixture() -> (AppState, Identity, Value) {
        let mut app = AppState::default();
        let seed = serde_json::from_value(json!({"session_users":["Alice"],"session_started_at":1,
            "updated_at":1,"session_played_file":"test.json"}))
        .unwrap();
        app.native_execute(crate::AppStateRequest::Initialize {
            schema_version: 1,
            state: Box::new(seed),
        })
        .unwrap();
        app.native().host_token = "host".into();
        let host = Identity {
            token: "host".into(),
            loopback: true,
            client: "test".into(),
        };
        let item = serde_json::from_value(json!({"id":"current","original_url":"https://www.bilibili.com/video/BV1z84y1p7oS",
            "resolved_url":"https://www.bilibili.com/video/BV1z84y1p7oS","bvid":"BV1z84y1p7oS","aid":1,"cid":2,"page":1,
            "title":"Song","part_title":"P1","display_title":"Song","cover_url":"","embed_url":"",
            "selected_pages":[1],"selected_cids":[2],"selected_durations":[120],"selected_parts":["P1"]})).unwrap();
        app.native_execute(crate::AppStateRequest::AddItem {
            schema_version: 1,
            item,
            position: "tail".into(),
            requester_name: "Alice".into(),
            reset_av_delay: false,
            allow_repeat: false,
            now: 2.0,
        })
        .unwrap();
        let item = app.native_core_snapshot().unwrap().current_item.unwrap();
        let reservation = app
            .native_execute(crate::AppStateRequest::BeginCacheAttempt {
                schema_version: 1,
                item_id: item.id.clone(),
                expected_item_incarnation_id: item.item_incarnation_id,
            })
            .unwrap();
        let directory = reservation["artifact_relative_directory"].as_str().unwrap();
        let event = serde_json::from_value(json!({"kind":"ready","message":"ready",
            "video_relative_path":format!("{directory}/video.mp4"),"video_media_url":format!("/media/{directory}/video.mp4"),
            "audio_variants":[{"id":"p1_p1","label":"P1","page":1,"audio_url":format!("/media/{directory}/audio.m4a")}],
            "selected_audio_variant_id":"p1_p1","item_incarnation_id":reservation["item_incarnation_id"],
            "artifact_set_id":reservation["artifact_set_id"],"artifact_relative_directory":directory})).unwrap();
        app.native_execute(crate::AppStateRequest::ApplyCacheEvent {
            schema_version: 1,
            item_id: item.id,
            cache_attempt_token: reservation["cache_attempt_token"].as_u64().unwrap(),
            event,
            now: 3.0,
        })
        .unwrap();
        (
            app,
            host,
            json!({"session_user_name":"Alice","play_id":"current","bvid":"BV1z84y1p7oS","score":3}),
        )
    }

    fn observe(app: &mut AppState, position: f64) {
        let generation = app.native_core_snapshot().unwrap().playback_generation;
        app.native_execute(crate::AppStateRequest::ApplyPlayerStatusObservation {
            schema_version: 1,
            expected_playback_generation: generation,
            item_id: "current".into(),
            is_paused: false,
            current_time: position,
            duration: 120.0,
            now: 4.0,
        })
        .unwrap();
    }

    fn skip(app: &mut AppState) {
        let generation = app.native_core_snapshot().unwrap().playback_generation;
        app.native_execute(crate::AppStateRequest::AdvanceToNext {
            schema_version: 1,
            expected_playback_generation: generation,
            reset_av_delay: false,
            now: 5.0,
        })
        .unwrap();
    }

    #[test]
    fn early_rating_waits_for_authoritative_half_then_sends_exactly_once() {
        let (mut app, host, body) = waiting_fixture();
        let pending = prepare(&mut app, &host, &body).unwrap().unwrap();
        assert!(pending.waiting);
        assert_eq!(submit_reserved(Some(pending)).unwrap()["queued"], true);
        assert_eq!(
            app.native_snapshot(false).unwrap()["song_ratings"][0]["status"],
            "waiting"
        );
        assert!(prepare(&mut app, &host, &body).is_err());
        observe(&mut app, 59.99);
        assert!(take_ready(&mut app).unwrap().is_none());
        observe(&mut app, 60.0);
        // Switching after the threshold must not lose an already valid rating.
        skip(&mut app);
        let ready = take_ready(&mut app).unwrap().unwrap();
        assert!(!ready.waiting);
        assert_eq!(ready.payload["score"], 3);
        assert!(take_ready(&mut app).unwrap().is_none());
        send(&ready, |_| Ok(json!({"payload":{"success":true}}))).unwrap();
        finish(&mut app, &ready, true);
        assert_eq!(
            app.native_snapshot(false).unwrap()["song_ratings"][0]["status"],
            "accepted"
        );
        assert!(prepare(&mut app, &host, &body).unwrap().is_none());
    }

    #[test]
    fn early_skip_discards_rating_and_failed_delivery_can_be_retried() {
        let (mut app, host, body) = waiting_fixture();
        prepare(&mut app, &host, &body).unwrap();
        observe(&mut app, 59.99);
        skip(&mut app);
        assert!(take_ready(&mut app).unwrap().is_none());
        assert_eq!(
            app.native_snapshot(false).unwrap()["song_ratings"][0]["status"],
            "discarded"
        );
        assert!(prepare(&mut app, &host, &body).is_err());
        let (mut app, host, body) = waiting_fixture();
        prepare(&mut app, &host, &body).unwrap();
        observe(&mut app, 60.0);
        let ready = take_ready(&mut app).unwrap().unwrap();
        finish(&mut app, &ready, false);
        assert_eq!(
            app.native_snapshot(false).unwrap()["song_ratings"][0]["status"],
            "failed"
        );
        assert!(
            take_ready(&mut app).unwrap().is_none(),
            "Failure must not cause an automatic retry loop"
        );
        assert!(!prepare(&mut app, &host, &body).unwrap().unwrap().waiting);
    }

    #[test]
    fn ratings_validate_identity_play_and_score_and_release_failed_reservations() {
        let mut app = AppState::default();
        let seed = serde_json::from_value(json!({"session_users":["Alice"],"session_started_at":1,"updated_at":1,
            "session_played_file":"test.json","session_played":[{"key":"played","item_id":"played","bvid":"BV1z84y1p7oS","title":"song","display_title":"song","part_title":"P1","original_url":"https://www.bilibili.com/video/BV1z84y1p7oS","resolved_url":"https://www.bilibili.com/video/BV1z84y1p7oS","aid":1,"cid":2,"page":1,"played_at":1}]})).unwrap();
        assert!(
            app.execute(crate::app_state::AppStateRequest::Initialize {
                schema_version: 1,
                state: Box::new(seed)
            })
            .error()
            .is_none()
        );
        app.native().host_token = "host".into();
        app.native_join_remote("", "remote".into()).unwrap();
        let remote = Identity {
            token: "remote".into(),
            loopback: false,
            client: "phone".into(),
        };
        let body =
            json!({"session_user_name":"spoof","play_id":"played","bvid":"BV1z84y1p7oS","score":4});
        assert!(prepare(&mut app, &remote, &body).is_err());
        app.native_register(&remote, &json!({"name":"Alice","claim":true}), false, 2.0)
            .unwrap();
        for patch in [
            json!({"score":0}),
            json!({"score":6}),
            json!({"score":1.5}),
            json!({"play_id":"forged"}),
            json!({"bvid":"BV1zm41117sU"}),
        ] {
            let mut invalid = body.clone();
            invalid
                .as_object_mut()
                .unwrap()
                .extend(patch.as_object().unwrap().clone());
            assert!(prepare(&mut app, &remote, &invalid).is_err());
        }
        assert_eq!(
            prepare(&mut app, &remote, &body).err().unwrap().code,
            "rating_not_eligible"
        );
        assert!(app.native().ratings.entries.is_empty());
        assert!(
            app.execute(crate::AppStateRequest::MarkSessionPlayedThreshold {
                schema_version: 1,
                item_id: "played".into(),
                now: 2.0,
            })
            .error()
            .is_none()
        );
        let first = prepare(&mut app, &remote, &body).unwrap().unwrap();
        assert_eq!(first.payload["session_user_name"], "Alice");
        assert!(prepare(&mut app, &remote, &body).is_err());
        assert!(
            send(&first, |request| {
                assert_eq!(request.base_url, "https://api.kevinx96.icu");
                let CloudflareOperation::Request {
                    path,
                    payload,
                    authorization,
                    ..
                } = &request.operation
                else {
                    panic!()
                };
                assert_eq!(path, "/rate-song");
                assert!(authorization.is_empty());
                assert_eq!(payload.as_ref().unwrap()["score"], 4);
                Ok(json!({"payload":{"success":false}}))
            })
            .is_err()
        );
        app.native().ratings.finish(&first, false);
        let second = prepare(&mut app, &remote, &body).unwrap().unwrap();
        send(&second, |_| Ok(json!({"payload":{"success":true}}))).unwrap();
        app.native().ratings.finish(&second, true);
        assert!(prepare(&mut app, &remote, &body).unwrap().is_none());
        app.native_register(&remote, &json!({"name":"Renamed"}), true, 3.0)
            .unwrap();
        assert!(prepare(&mut app, &remote, &body).unwrap().is_none());
        assert!(!app.native_diagnostics().to_string().contains("Alice"));
        assert!(app.native_snapshot(false).unwrap().get("ratings").is_none());
        let mut ledger = RatingLedger::default();
        for n in 0..4 {
            ledger.reserve(1, "Alice", &n.to_string(), false).unwrap();
        }
        assert!(ledger.reserve(1, "Alice", "overflow", false).is_err());
        assert!(ledger.reserve(2, "Alice", "0", false).unwrap().is_some());
        let old = Submission {
            owner: "host".into(),
            generation: 1,
            id: 1,
            payload: json!({}),
            waiting: false,
        };
        ledger.finish(&old, true);
        assert!(
            !ledger.entries[0].complete,
            "old session completion cannot finish a new reservation"
        );

        // A replacement Host can reuse ledger sequence/session numbers. Its
        // private owner identity must still exclude the old network completion.
        app.native().host_token = "replacement".into();
        app.native().ratings = RatingLedger::default();
        assert_eq!(
            app.native()
                .ratings
                .reserve(1, "Alice", "played", false)
                .unwrap(),
            Some(1)
        );
        finish(&mut app, &old, true);
        assert!(!app.native().ratings.entries[0].complete);
        assert!(app.native().ratings.events.is_empty());
    }
}
