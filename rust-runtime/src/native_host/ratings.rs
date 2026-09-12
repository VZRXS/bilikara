//! Native rating admission lives in AppState. Cloud I/O happens outside its
//! lock, and success is acknowledged only after the existing service accepts it.
use super::*;
use crate::app_state::AppState;
use crate::cloudflare_service::{
    CloudflareOperation, CloudflareServiceRequest, execute_cloudflare,
};
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
}
struct Submission {
    generation: u64,
    id: u64,
    payload: Value,
}

impl RatingLedger {
    fn reserve(
        &mut self,
        generation: u64,
        user: &str,
        play: &str,
    ) -> Result<Option<u64>, ApiError> {
        if self.generation != generation {
            self.entries.clear();
            self.generation = generation;
        }
        let user = user.to_lowercase();
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
        if self.entries.iter().filter(|e| !e.complete).count() >= 4 {
            return Err(ApiError::new(
                429,
                "rating_busy",
                "评分提交较多，请稍后重试",
            ));
        }
        if self.entries.len() >= 2048 {
            // Never evict a still-running request's duplicate guard.
            if let Some(index) = self.entries.iter().position(|e| e.complete) {
                self.entries.remove(index);
            }
        }
        self.sequence += 1;
        self.entries.push_back(Entry {
            id: self.sequence,
            user,
            play: play.into(),
            complete: false,
        });
        Ok(Some(self.sequence))
    }
    pub(crate) fn rename(&mut self, old: &str, new: &str) {
        for entry in &mut self.entries {
            if entry.user == old.to_lowercase() {
                entry.user = new.to_lowercase();
            }
        }
    }
    fn finish(&mut self, submission: &Submission, success: bool) {
        if self.generation == submission.generation
            && let Some(index) = self.entries.iter().position(|e| e.id == submission.id)
        {
            if success {
                self.entries[index].complete = true;
            } else {
                self.entries.remove(index);
            }
        }
        if self.events.len() >= 50 {
            self.events.pop_front();
        }
        self.events
            .push_back(json!({"at":now(),"event":if success {"accepted"} else {"failed"}}));
    }
}

fn prepare(
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
    let id = app
        .native()
        .ratings
        .reserve(snapshot.session_generation, &user, &play)?;
    Ok(id.map(|id| Submission {
        id,
        generation: snapshot.session_generation,
        payload: json!({"session_user_name":user,"play_id":play,"bvid":bvid,"score":score}),
    }))
}

fn send(
    submission: &Submission,
    transport: impl FnOnce(
        &CloudflareServiceRequest,
    ) -> Result<Value, crate::cloudflare_service::CloudflareServiceError>,
) -> Result<(), ApiError> {
    let result = transport(&CloudflareServiceRequest {
        schema_version: 1,
        base_url: "https://api.kevinx96.icu".into(),
        user_agent: crate::native_video::USER_AGENT.into(),
        timeout_ms: 10_000,
        operation: CloudflareOperation::Request {
            method: "POST".into(),
            path: "/rate-song".into(),
            payload: Some(submission.payload.clone()),
            authorization: String::new(),
        },
    });
    match result {
        Ok(value) if value["payload"]["success"] == true => Ok(()),
        // Never expose upstream response previews, cookies or arbitrary text.
        _ => Err(ApiError::new(
            503,
            "rating_unavailable",
            "评分提交失败，请稍后重新评分",
        )),
    }
}

pub(super) fn submit(identity: &Identity, body: &Value) -> Result<Value, ApiError> {
    let Some(submission) = with_app(|app| prepare(app, identity, body))? else {
        return Ok(json!({"success":true,"queued":false,"duplicate":true}));
    };
    // A dropped/panicking transport must release admission just like a timeout.
    struct Pending {
        value: Submission,
        finished: bool,
    }
    impl Drop for Pending {
        fn drop(&mut self) {
            if !self.finished {
                let _ = with_app(|app| {
                    app.native().ratings.finish(&self.value, false);
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
        app.native().ratings.finish(&pending.value, result.is_ok());
        Ok(())
    })?;
    pending.finished = true;
    result?;
    Ok(json!({"success":true,"queued":false,"duplicate":false}))
}

#[cfg(test)]
mod tests {
    use super::*;
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
        app.native().invite = "invite".into();
        app.native_redeem("invite", "", "remote".into()).unwrap();
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
            ledger.reserve(1, "Alice", &n.to_string()).unwrap();
        }
        assert!(ledger.reserve(1, "Alice", "overflow").is_err());
        assert!(ledger.reserve(2, "Alice", "0").unwrap().is_some());
    }
}
