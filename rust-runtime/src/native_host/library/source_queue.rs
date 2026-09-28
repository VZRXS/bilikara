//! Bounded manual additions owned by AppState; one existing library lease runs
//! each job. Previews remain read-only and never hold the long-running lease.
use super::*;
use crate::app_state::native_session::text;
use std::collections::{BTreeMap, VecDeque};

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub(crate) struct SourceJob {
    uid: String,
    folder_ids: Option<Vec<String>>,
    folder_titles: BTreeMap<String, String>,
}

impl SourceJob {
    fn same_source(&self, other: &Self) -> bool {
        self.uid == other.uid && self.folder_ids == other.folder_ids
    }
}

#[derive(Default, Debug)]
pub(crate) struct SourceQueue {
    pending: VecDeque<SourceJob>,
    active: Option<SourceJob>,
    completed_uids: u64,
    completed_favorites: u64,
    failed: VecDeque<SourceJob>,
}

impl SourceQueue {
    pub(crate) fn snapshot(&self) -> Value {
        json!({"pending":self.pending,"active":self.active,"failed":self.failed,
            "completed":{"uids":self.completed_uids,"favorites":self.completed_favorites}})
    }
    pub(crate) fn clear(&mut self) {
        self.pending.clear();
        self.failed.clear();
    }
    pub(super) fn remember_refresh_result(&mut self, value: &Value) {
        let summary = value.get("refresh_summary").unwrap_or(value);
        for source in summary["uids"].as_array().into_iter().flatten() {
            self.failed
                .retain(|job| job.folder_ids.is_some() || source["uid"] != job.uid);
        }
        if summary["favlist_errors"].is_array() {
            self.failed.retain(|job| job.folder_ids.is_none());
        }
        for key in ["errors", "favlist_errors"] {
            for source in summary[key].as_array().into_iter().flatten() {
                let Some(uid) = source["uid"].as_str() else {
                    continue;
                };
                let job = SourceJob {
                    uid: uid.into(),
                    folder_ids: source["folder_id"].as_str().map(|id| vec![id.into()]),
                    folder_titles: BTreeMap::new(),
                };
                self.failed.retain(|previous| !previous.same_source(&job));
                self.failed.push_back(job);
            }
        }
        while self.failed.len() > 100 {
            self.failed.pop_front();
        }
    }
    fn enqueue(&mut self, job: SourceJob) -> Result<Value, ApiError> {
        let duplicate = self.active.as_ref().is_some_and(|v| v.same_source(&job))
            || self.pending.iter().any(|v| v.same_source(&job));
        if duplicate {
            for existing in self.active.iter_mut().chain(self.pending.iter_mut()) {
                if existing.same_source(&job) {
                    existing.folder_titles.extend(job.folder_titles.clone());
                }
            }
        }
        if !duplicate {
            if let Some(pending) = self
                .pending
                .iter_mut()
                .find(|v| v.uid == job.uid && v.folder_ids.is_some() && job.folder_ids.is_some())
            {
                let mut ids = pending.folder_ids.clone().unwrap();
                ids.extend(job.folder_ids.as_ref().unwrap().iter().cloned());
                ids.sort();
                ids.dedup();
                if ids.len() <= 100 {
                    let duplicate = pending.folder_ids.as_ref() == Some(&ids);
                    pending.folder_ids = Some(ids);
                    pending.folder_titles.extend(job.folder_titles.clone());
                    return Ok(json!({"queued":true,"duplicate":duplicate,"uid":job.uid}));
                }
            }
            if self.pending.len() >= 100 {
                return Err(ApiError::new(
                    429,
                    "source_queue_full",
                    "来源队列已满，请稍后重试",
                ));
            }
            self.pending.push_back(job.clone());
        }
        Ok(
            json!({"queued":true,"duplicate":duplicate,"uid":job.uid,"position":self.pending.iter().position(|v| v.same_source(&job)).map(|n|n+1).unwrap_or(0)}),
        )
    }
}

pub(super) fn enqueue(identity: &Identity, path: &str, body: &Value) -> Result<Value, ApiError> {
    let uid = crate::gatcha_repository::required_uid(&text(body, "uid")?)
        .map_err(|e| ApiError::invalid(e.message))?;
    let folders = if path.ends_with("/favlist") {
        let mut ids: Vec<String> = body["folder_ids"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_owned())
            .collect();
        ids.sort();
        ids.dedup();
        Some(ids)
    } else {
        None
    };
    let mut folder_titles = BTreeMap::new();
    if let Some(titles) = body.get("folder_titles") {
        let titles = titles
            .as_object()
            .ok_or_else(|| ApiError::invalid("Invalid folder titles"))?;
        if titles.len() > 100 {
            return Err(ApiError::invalid("Too many folder titles"));
        }
        for (id, title) in titles {
            let title = title
                .as_str()
                .ok_or_else(|| ApiError::invalid("Invalid folder title"))?;
            if !folders.as_ref().is_some_and(|ids| ids.contains(id)) || title.chars().count() > 200
            {
                return Err(ApiError::invalid("Invalid folder title"));
            }
            folder_titles.insert(id.clone(), title.trim().to_owned());
        }
    }
    with_app(|app| {
        app.native_requester(identity, "")?;
        let session = app.native();
        if folders.is_none() && session.cookie.is_empty() {
            return Err(ApiError::new(
                400,
                "missing_cookie",
                "请先在 Host 设置中登录 Bilibili",
            ));
        }
        let response = session.library_queue.enqueue(SourceJob {
            uid,
            folder_ids: folders,
            folder_titles,
        })?;
        session.revision += 1;
        Ok(response)
    })
}

pub(super) fn run_next(context: &HostContext) -> bool {
    let work = with_app(|app| {
        let session = app.native();
        let Some(job) = session.library_queue.pending.front().cloned() else {
            return Ok(None);
        };
        if session.library_refresh_active || session.login.gacha_snapshot().busy {
            return Ok(None);
        }
        // Missing credentials produce a terminal failure, not an immortal queue.
        TaskLease::reserve_for(session, true, true, false)?;
        session.library_queue.pending.pop_front();
        session.library_queue.active = Some(job.clone());
        session
            .library_queue
            .failed
            .retain(|v| !v.same_source(&job));
        Ok(Some((
            job,
            session.cookie.clone(),
            TaskLease {
                complete: false,
                automatic: true,
                trigger: "queued_source",
                started: Instant::now(),
                ticket: None,
                stop: Some(context.stop.clone()),
            },
        )))
    });
    let Ok(Some((job, cookie, lease))) = work else {
        return false;
    };
    let path = if job.folder_ids.is_some() {
        "/api/gatcha/favlist"
    } else {
        "/api/gatcha/uids/add"
    };
    let body = json!({"uid":job.uid,"folder_ids":job.folder_ids});
    let result =
        network_operation(path, &body, &cookie).and_then(|op| execute(&context.directory, op));
    let failed = result.is_err() || result.as_ref().is_ok_and(partial_refresh);
    publish_favorites_timestamp(&context.directory);
    let _ = lease.finish(&result);
    if let Ok(mut value) = result {
        catalog_append::source_result(&mut value);
    }
    let _ = with_app(|app| {
        let queue = &mut app.native().library_queue;
        queue.active = None;
        if job.folder_ids.is_some() {
            queue.completed_favorites += 1;
        } else {
            queue.completed_uids += 1;
        }
        if failed {
            queue.failed.push_back(job);
            while queue.failed.len() > 100 {
                queue.failed.pop_front();
            }
        }
        app.native().revision += 1;
        Ok(())
    });
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn titles_travel_with_jobs_without_changing_source_identity() {
        let mut q = SourceQueue::default();
        let mut job = SourceJob {
            uid: "1".into(),
            folder_ids: Some(vec!["2".into()]),
            folder_titles: BTreeMap::new(),
        };
        q.enqueue(job.clone()).unwrap();
        job.folder_titles.insert("2".into(), "🎤 收藏".into());
        assert_eq!(q.enqueue(job.clone()).unwrap()["duplicate"], true);
        assert_eq!(q.snapshot()["pending"][0]["folder_titles"]["2"], "🎤 收藏");
        q.active = q.pending.pop_front();
        assert_eq!(q.enqueue(job).unwrap()["duplicate"], true);
        assert!(q.pending.is_empty());
        assert_eq!(q.snapshot()["active"]["folder_titles"]["2"], "🎤 收藏");
        let next = SourceJob {
            uid: "1".into(),
            folder_ids: Some(vec!["3".into()]),
            folder_titles: BTreeMap::from([("3".into(), "Three".into())]),
        };
        q.enqueue(next).unwrap();
        let more = SourceJob {
            uid: "1".into(),
            folder_ids: Some(vec!["4".into()]),
            folder_titles: BTreeMap::from([("4".into(), "Four".into())]),
        };
        q.enqueue(more).unwrap();
        assert_eq!(q.pending[0].folder_titles.len(), 2);
    }
    #[test]
    fn refresh_failures_survive_unrelated_jobs_until_the_source_succeeds() {
        let mut q = SourceQueue::default();
        q.remember_refresh_result(
            &json!({"refresh_summary":{"uids":[{"uid":"1"}],"errors":[{"uid":"2"}]}}),
        );
        q.remember_refresh_result(&json!({"uid":"3"}));
        assert_eq!(q.failed[0].uid, "2");
        q.remember_refresh_result(&json!({"refresh_summary":{"uids":[{"uid":"2"}],"errors":[]}}));
        assert!(q.failed.is_empty());
    }
    #[test]
    fn favorite_jobs_merge_pending_selections_and_detect_subset_duplicates() {
        let mut q = SourceQueue::default();
        let job = |ids: &[&str]| SourceJob {
            uid: "1".into(),
            folder_ids: Some(ids.iter().map(|v| (*v).into()).collect()),
            folder_titles: BTreeMap::new(),
        };
        q.enqueue(job(&["1", "2"])).unwrap();
        assert_eq!(q.enqueue(job(&["2", "3"])).unwrap()["duplicate"], false);
        assert_eq!(q.pending.len(), 1);
        assert_eq!(q.pending[0], job(&["1", "2", "3"]));
        assert_eq!(q.enqueue(job(&["2"])).unwrap()["duplicate"], true);
    }
    #[test]
    fn queue_deduplicates_pending_and_active_and_preserves_fifo() {
        let mut q = SourceQueue::default();
        let first = SourceJob {
            uid: "1".into(),
            folder_ids: None,
            folder_titles: BTreeMap::new(),
        };
        let second = SourceJob {
            uid: "2".into(),
            folder_ids: None,
            folder_titles: BTreeMap::new(),
        };
        assert_eq!(q.enqueue(first.clone()).unwrap()["position"], 1);
        assert_eq!(q.enqueue(first.clone()).unwrap()["duplicate"], true);
        assert_eq!(q.enqueue(second.clone()).unwrap()["position"], 2);
        q.active = q.pending.pop_front();
        assert_eq!(q.enqueue(first).unwrap()["duplicate"], true);
        assert_eq!(q.pending.pop_front(), Some(second));
        q.clear();
        assert!(q.pending.is_empty());
    }
    #[test]
    fn queue_is_bounded_without_dropping_existing_work() {
        let mut q = SourceQueue::default();
        for uid in 1..=100 {
            q.enqueue(SourceJob {
                uid: uid.to_string(),
                folder_ids: None,
                folder_titles: BTreeMap::new(),
            })
            .unwrap();
        }
        assert!(
            q.enqueue(SourceJob {
                uid: "101".into(),
                folder_ids: None,
                folder_titles: BTreeMap::new(),
            })
            .is_err()
        );
        assert_eq!(q.pending.len(), 100);
    }
}
