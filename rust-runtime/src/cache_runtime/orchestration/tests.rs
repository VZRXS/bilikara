use super::*;
use crate::app_state::{AppStateRequest, CacheEvent};
use crate::cache_application::{CacheApplication, HostContract};
use std::sync::Barrier;

#[test]
fn failed_bbdown_replacement_cancels_the_superseded_executor() {
    let mut f = Fixture::new();
    let item = f.add("a");
    f.run(Action::Reconcile).unwrap();
    f.flush();
    let active = f.activate("a");
    f.facts.download_source = "bbdown".into();
    f.facts.cookie = "SESSDATA=fixture; bili_jct=fixture".into();
    f.run(Action::Retry {
        item_id: item.id,
        incarnation: item.item_incarnation_id,
        force: true,
    })
    .unwrap();
    assert!(f.state.active["a"].cancel.load(Ordering::Acquire));
    assert!(!f.state.jobs.contains_key("a"));
    assert_ne!(
        f.state.terminal_events["a"].cache_attempt_token,
        active.cache_attempt_token
    );
    f.flush();
    assert_eq!(f.item("a").cache_status, "failed");
}

#[test]
fn explicit_external_to_bbdown_handoff_retains_urgent_intent_until_drain() {
    let mut f = Fixture::new();
    let current = f.add("a");
    f.add("b");
    f.ready("a");
    f.run(Action::Reconcile).unwrap();
    f.activate("b");
    let external = f
        .app
        .reserve_runtime_attempt("a", &current.item_incarnation_id)
        .unwrap();
    f.facts.external_attempts.push(ExternalAttempt {
        item_id: "a".into(),
        cache_attempt_token: external.cache_attempt_token,
        retry_open: true,
        primary: false,
        urgent: true,
    });
    f.orchestration.bbdown = Some(bbdown::Executable::fixture(
        f.facts.cache_root.join("BBDown"),
    ));
    f.facts.download_source = "bbdown".into();
    f.facts.cookie = "SESSDATA=fixture; bili_jct=fixture".into();
    let result = f
        .run(Action::Retry {
            item_id: current.id,
            incarnation: current.item_incarnation_id,
            force: true,
        })
        .unwrap();
    assert_eq!(result["external_retries"][0]["handoff"], true);
    assert!(!f.state.jobs.contains_key("a"));
    f.run(Action::Reconcile).unwrap();
    assert!(!f.state.jobs.contains_key("a"));
    assert!(!f.state.active["b"].cancel.load(Ordering::Acquire));
    f.app.settle_artifact_reservation(&external);
    f.facts.external_attempts.clear();
    f.run(Action::Wake).unwrap();
    assert_eq!(f.state.jobs["a"].spec.executor.source(), "bbdown");
    assert!(matches!(
        f.state.queued_priorities["a"],
        CacheJobPriority::Urgent
    ));
    assert!(!f.state.active["b"].cancel.load(Ordering::Acquire));
}

#[test]
fn bbdown_default_admission_captures_source_cookie_and_codec_until_replacement() {
    let mut f = Fixture::new();
    let item = f.add("bbdown");
    f.orchestration.owner = f.owner.clone();
    f.orchestration.bbdown = Some(bbdown::Executable::fixture(
        f.facts.cache_root.join("BBDown"),
    ));
    f.facts.download_source = "bbdown".into();
    f.facts.cookie = "SESSDATA=fixture; bili_jct=fixture".into();
    f.run(Action::Reconcile).unwrap();
    let first = f.state.jobs[&item.id].clone();
    assert!(matches!(
        first.spec.executor,
        Executor::Bbdown {
            force_avc: false,
            ..
        }
    ));
    assert_eq!(first.spec.cookie, f.facts.cookie);
    assert_eq!(first.spec.executor.attempts(), 1);
    f.facts.download_source = "native".into();
    f.facts.cookie.clear();
    f.run(Action::Reconcile).unwrap();
    assert_eq!(
        f.state.jobs[&item.id].cache_attempt_token,
        first.cache_attempt_token
    );
    assert_eq!(f.state.jobs[&item.id].spec.executor.source(), "bbdown");
    assert_eq!(f.state.jobs[&item.id].spec.cookie, first.spec.cookie);
    f.run(Action::Retry {
        item_id: item.id.clone(),
        incarnation: item.item_incarnation_id,
        force: true,
    })
    .unwrap();
    assert_eq!(f.state.jobs[&item.id].spec.executor.source(), "native");
    assert_ne!(
        f.state.jobs[&item.id].cache_attempt_token,
        first.cache_attempt_token
    );
}

#[test]
fn unavailable_bbdown_cannot_settle_captured_native_and_failure_is_not_retried() {
    let mut f = Fixture::new();
    let old = f.add("native");
    f.run(Action::Reconcile).unwrap();
    let token = f.state.jobs[&old.id].cache_attempt_token;
    let new = f.add("unavailable");
    f.facts.download_source = "bbdown".into();
    f.facts.cookie = "SESSDATA=fixture; bili_jct=fixture".into();
    f.run(Action::Reconcile).unwrap();
    f.flush();
    assert_eq!(f.state.jobs[&old.id].cache_attempt_token, token);
    assert_eq!(f.state.jobs[&old.id].spec.executor.source(), "native");
    assert_eq!(f.item(&new.id).cache_status, "failed");
    assert!(f.item(&new.id).cache_message.contains("BBDown unavailable"));
    let sequence = f.state.next_generation;
    f.run(Action::Reconcile).unwrap();
    assert_eq!(f.state.next_generation, sequence);
}

struct Fixture {
    app: AppState,
    state: RuntimeState,
    orchestration: Orchestration,
    application: CacheApplication,
    facts: Facts,
    owner: String,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "bilikara-orchestration-{}-{}",
            std::process::id(),
            ATTEMPT_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let mut app = AppState::default();
        let state = serde_json::from_value(json!({"session_users":["Alice"],"session_started_at":1.0,"session_played_file":"test.json","updated_at":1.0})).unwrap();
        assert!(
            app.execute(AppStateRequest::Initialize {
                schema_version: 1,
                state: Box::new(state)
            })
            .error()
            .is_none()
        );
        let owner = app.open_artifact_lifetime(&root).unwrap();
        Self {
            app,
            state: RuntimeState::default(),
            orchestration: Orchestration::default(),
            application: CacheApplication::default(),
            owner,
            facts: Facts {
                cache_root: root.clone(),
                log_dir: root.join("logs"),
                max_cache_items: 3,
                download_source: "native".into(),
                video_quality: "1080P 高清".into(),
                audio_hires: true,
                hevc_supported: None,
                avc_quality_cap: String::new(),
                cookie: String::new(),
                user_agent: "fixture".into(),
                referer: "https://example.test/".into(),
                external_attempts: vec![],
            },
        }
    }
    fn add(&mut self, id: &str) -> PlaylistItem {
        self.add_with_cid(id, 2)
    }
    fn add_with_cid(&mut self, id: &str, cid: u64) -> PlaylistItem {
        let item = serde_json::from_value(json!({"id":id,"original_url":"https://example.test/","resolved_url":"https://example.test/","bvid":"BV1234567890","aid":1,"cid":cid,"page":1,"title":id,"part_title":"P1","display_title":id,"cover_url":"","embed_url":"","selected_pages":[1],"selected_cids":[cid],"selected_durations":[120],"selected_parts":["P1"],"available_pages":[1],"available_cids":[cid],"available_durations":[120],"available_parts":["P1"]})).unwrap();
        assert!(
            self.app
                .execute(AppStateRequest::AddItem {
                    schema_version: 1,
                    item,
                    position: "tail".into(),
                    requester_name: "Alice".into(),
                    reset_av_delay: false,
                    allow_repeat: true,
                    now: 2.0
                })
                .error()
                .is_none()
        );
        self.item(id)
    }
    fn item(&self, id: &str) -> PlaylistItem {
        self.app
            .cache_items()
            .unwrap()
            .into_iter()
            .find(|i| i.id == id)
            .unwrap()
    }
    fn run(&mut self, action: Action) -> Result<Value, CacheRuntimeError> {
        let reuse = Reuse::inspect(
            &self.app.cache_items().unwrap(),
            &self.state.completed.values().cloned().collect::<Vec<_>>(),
            &self.facts,
        );
        self.orchestration.apply(
            &mut self.state,
            &mut self.app,
            &self.owner,
            &self.facts,
            action,
            &reuse,
        )
    }
    fn flush(&mut self) {
        let events = self.state.events.drain(..).collect();
        let effects = self.application.apply(
            &mut self.app,
            events,
            HostContract::Default {
                max_cache_items: self.facts.max_cache_items,
            },
            4.0,
        );
        assert!(effects.errors.is_empty(), "{:?}", effects.errors);
    }
    fn ready(&mut self, id: &str) -> CacheAttemptReservation {
        let item = self.item(id);
        let r = self
            .app
            .reserve_runtime_attempt(id, &item.item_incarnation_id)
            .unwrap();
        let complete = self.facts.cache_root.join(format!(
            ".staging/attempt-{}/complete",
            r.cache_attempt_token
        ));
        fs::create_dir_all(&complete).unwrap();
        fs::write(complete.join("video.mp4"), b"synthetic video").unwrap();
        fs::write(complete.join("audio.m4a"), b"synthetic audio").unwrap();
        assert!(
            self.app
                .publish_external_artifact(r.cache_attempt_token)
                .unwrap()
        );
        let dir = &r.artifact_relative_directory;
        let event = serde_json::from_value(json!({"kind":"ready","message":"ready","video_relative_path":format!("{dir}/video.mp4"),"video_media_url":format!("/media/{dir}/video.mp4"),"audio_variants":[{"id":"p1","label":"P1","page":1,"audio_url":format!("/media/{dir}/audio.m4a")}],"selected_audio_variant_id":"p1","item_incarnation_id":r.item_incarnation_id,"artifact_set_id":r.artifact_set_id,"artifact_relative_directory":dir})).unwrap();
        assert!(
            self.app
                .execute(AppStateRequest::ApplyCacheEvent {
                    schema_version: 1,
                    item_id: id.into(),
                    cache_attempt_token: r.cache_attempt_token,
                    event,
                    now: 3.0
                })
                .error()
                .is_none()
        );
        r
    }
    fn activate(&mut self, id: &str) -> QueuedJob {
        let job = self.state.jobs[id].clone();
        remove_queued_locked(&mut self.state, id);
        self.state.primary_active_item_id = Some(id.into());
        self.state.active.insert(
            id.into(),
            ActiveJob {
                generation: job.generation,
                cache_attempt_token: job.cache_attempt_token,
                reservation: job.reservation.clone(),
                cancel: Arc::new(AtomicBool::new(false)),
                urgent: false,
            },
        );
        job
    }
    fn collect(&mut self) -> usize {
        let jobs = self.app.prepare_artifact_collection();
        let count = jobs.len();
        for job in jobs {
            let ok = job.delete().is_ok();
            assert!(ok);
            self.app.finish_artifact_collection(&job, ok);
        }
        count
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.facts.cache_root);
    }
}

#[test]
fn constructs_selected_pages_cids_labels_variants_and_effective_policy() {
    let mut f = Fixture::new();
    let mut item = f.add("song");
    item.selected_pages = vec![2, 1, 2];
    item.selected_cids = vec![22];
    item.selected_parts = vec![" 伴奏 ".into()];
    item.available_pages = vec![1, 2];
    item.available_cids = vec![11, 222];
    item.selected_durations = vec![-1];
    item.available_durations = vec![10, 20];
    item.video_page = 99;
    item.selected_audio_variant_id = "accompaniment".into();
    item.audio_variants = vec![serde_json::from_value(json!({"id":"accompaniment","label":"伴奏","page":2,"audio_url":"/media/artifacts/a/b/audio.m4a"})).unwrap()];
    f.facts.hevc_supported = Some(false);
    f.facts.avc_quality_cap = "480P 清晰".into();
    let job = default_job(&item, &f.facts).unwrap();
    assert_eq!(
        job.pages
            .iter()
            .map(|p| (p.page, p.cid))
            .collect::<Vec<_>>(),
        vec![(2, 22), (1, 11)]
    );
    assert_eq!(job.video_page, 2);
    assert_eq!(job.pages[0].label, "伴奏");
    assert_eq!(job.pages[1].label, "P1");
    assert_eq!(job.pages[0].duration_seconds, Some(20.0));
    assert_eq!(job.avc_quality_cap, "480P 清晰");
    assert!(job.audio_hires);
    assert_eq!(job.selected_audio_variant_id, "accompaniment");
    assert_eq!(job.existing_audio_variants[0].page, 2);
    item.selected_cids.clear();
    item.available_cids.clear();
    item.cid = 0;
    assert_eq!(
        default_job(&item, &f.facts).unwrap_err().kind,
        "invalid_request"
    );
}

#[test]
fn window_retains_three_ready_items_and_progress_sync_reserves_nothing() {
    let mut f = Fixture::new();
    f.facts.max_cache_items = 1;
    for id in ["a", "b", "c", "d", "e"] {
        f.add(id);
        if id != "a" {
            f.ready(id);
        }
    }
    let first = f.run(Action::Reconcile).unwrap();
    assert_eq!(first["desired_ids"], json!(["a"]));
    assert_eq!(first["ordered_ids"], json!(["a"]));
    assert_eq!(f.state.jobs.len(), 1);
    let token = f.state.jobs["a"].cache_attempt_token;
    f.flush();
    assert_eq!(f.item("b").cache_status, "ready");
    assert_eq!(f.item("d").cache_status, "ready");
    assert_eq!(f.item("e").cache_status, "pending");
    assert!(
        f.app
            .execute(AppStateRequest::ApplyCacheEvent {
                schema_version: 1,
                item_id: "a".into(),
                cache_attempt_token: token,
                event: CacheEvent::Progress {
                    message: Some("progress".into()),
                    progress: 25.0
                },
                now: 5.0
            })
            .error()
            .is_none()
    );
    let sequence = f.state.next_event_sequence;
    for _ in 0..3 {
        f.run(Action::Reconcile).unwrap();
    }
    assert_eq!(f.state.next_event_sequence, sequence);
    assert_eq!(f.state.jobs["a"].cache_attempt_token, token);
    assert_eq!(f.collect(), 1);
}

#[test]
fn failed_stays_failed_until_retry_and_stale_retry_cannot_replace_incarnation() {
    let mut f = Fixture::new();
    let item = f.add("a");
    f.run(Action::Reconcile).unwrap();
    f.flush();
    let job = f.activate("a");
    settle_job_locked(
        &mut f.state,
        &job,
        JobOutcome::Failed(CacheRuntimeError::new("fixture", "failed")),
    );
    f.run(Action::Wake).unwrap();
    assert!(f.state.jobs.is_empty());
    f.flush();
    f.run(Action::Reconcile).unwrap();
    assert!(f.state.jobs.is_empty());
    f.run(Action::Retry {
        item_id: "a".into(),
        incarnation: item.item_incarnation_id.clone(),
        force: false,
    })
    .unwrap();
    let new = f.state.jobs["a"].cache_attempt_token;
    assert!(new > job.cache_attempt_token);
    f.app.execute(AppStateRequest::RemoveItem {
        schema_version: 1,
        item_id: "a".into(),
        now: 6.0,
    });
    let next = f.add("a");
    assert_eq!(
        f.run(Action::Retry {
            item_id: "a".into(),
            incarnation: item.item_incarnation_id,
            force: true
        })
        .unwrap_err()
        .kind,
        "item_incarnation_mismatch"
    );
    assert_eq!(f.state.jobs["a"].cache_attempt_token, new);
    f.run(Action::Reconcile).unwrap();
    assert_eq!(
        f.state.jobs["a"].reservation.item_incarnation_id,
        next.item_incarnation_id
    );
}

#[test]
fn future_preferences_capability_replacement_and_external_handoff_are_distinct() {
    let mut f = Fixture::new();
    f.add("a");
    f.add("b");
    let external = f
        .app
        .reserve_runtime_attempt("a", &f.item("a").item_incarnation_id)
        .unwrap();
    f.facts.external_attempts.push(ExternalAttempt {
        item_id: "a".into(),
        cache_attempt_token: external.cache_attempt_token,
        retry_open: true,
        primary: true,
        urgent: false,
    });
    f.run(Action::Reconcile).unwrap();
    assert!(!f.state.jobs.contains_key("a"));
    let b = f.state.jobs["b"].clone();
    f.facts.video_quality = "720P 高清".into();
    f.facts.audio_hires = false;
    f.run(Action::Reconcile).unwrap();
    assert_eq!(f.state.jobs["b"].cache_attempt_token, b.cache_attempt_token);
    f.facts.hevc_supported = Some(false);
    f.facts.avc_quality_cap = "480P 清晰".into();
    let effect = f.run(Action::Reconcile).unwrap();
    assert_eq!(
        effect["external_retries"],
        json!([{"item_id":"a","cache_attempt_token":external.cache_attempt_token}])
    );
    assert!(!f.state.jobs.contains_key("a"));
    assert!(f.state.jobs["b"].cache_attempt_token > b.cache_attempt_token);
    assert_eq!(f.state.jobs["b"].spec.avc_quality_cap, "480P 清晰");
    assert!(!f.state.jobs["b"].spec.audio_hires);
    f.facts.external_attempts[0].retry_open = false;
    f.facts.avc_quality_cap = "360P 流畅".into();
    assert!(
        f.run(Action::Reconcile).unwrap()["external_retries"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(!f.state.jobs.contains_key("a"));
    f.app.settle_artifact_reservation(&external);
    f.facts.external_attempts.clear();
    f.run(Action::Reconcile).unwrap();
    assert_eq!(f.state.jobs["a"].spec.avc_quality_cap, "360P 流畅");
    let a = f.activate("a");
    f.facts.download_source = "downkyi".into();
    f.run(Action::Reconcile).unwrap();
    assert!(!f.state.active["a"].cancel.load(Ordering::Acquire));
    assert_eq!(f.state.jobs["a"].cache_attempt_token, a.cache_attempt_token);
    f.facts.max_cache_items = 0;
    f.run(Action::Reconcile).unwrap();
    assert!(f.state.active["a"].cancel.load(Ordering::Acquire));
}

#[test]
fn refresh_urgent_retry_and_clear_preserve_reader_and_program_protections() {
    let mut f = Fixture::new();
    let current = f.add("a");
    f.add("b");
    let r = f.ready("a");
    let snapshot = f
        .app
        .execute(AppStateRequest::Snapshot { schema_version: 1 });
    let generation = snapshot.snapshot().unwrap().playback_generation;
    assert!(
        f.app
            .claim_artifact_program(
                "host",
                generation,
                &r.item_incarnation_id,
                &r.artifact_set_id,
                false
            )
            .unwrap()
    );
    let handle = f
        .app
        .acquire_artifact_reader(&format!("{}/video.mp4", r.artifact_relative_directory))
        .unwrap()
        .unwrap();
    f.run(Action::Reconcile).unwrap();
    let b = f.activate("b");
    f.run(Action::Retry {
        item_id: "a".into(),
        incarnation: current.item_incarnation_id,
        force: true,
    })
    .unwrap();
    assert!(matches!(
        f.state.queued_priorities["a"],
        CacheJobPriority::Urgent
    ));
    assert!(!f.state.active["b"].cancel.load(Ordering::Acquire));
    assert!(f.state.jobs["a"].reservation.refresh);
    assert_eq!(f.item("a").artifact_set_id, r.artifact_set_id);
    assert_eq!(f.collect(), 0);
    f.flush();
    f.run(Action::Clear).unwrap();
    let effects = f.application.apply(
        &mut f.app,
        f.state.events.drain(..).collect(),
        HostContract::Default { max_cache_items: 3 },
        5.0,
    );
    assert_eq!(
        effects
            .errors
            .iter()
            .map(|e| e.kind.as_str())
            .collect::<Vec<_>>(),
        vec!["cache_attempt_superseded"]
    );
    assert_eq!(f.item("a").cache_status, "pending");
    assert_eq!(f.collect(), 0);
    settle_job_locked(&mut f.state, &b, JobOutcome::Cancelled);
    f.run(Action::Wake).unwrap();
    assert!(f.state.jobs.is_empty());
    assert!(f.app.release_artifact_reader(&handle));
    assert_eq!(f.collect(), 0);
    assert!(
        f.app
            .claim_artifact_program(
                "host",
                generation,
                &r.item_incarnation_id,
                &r.artifact_set_id,
                true
            )
            .unwrap()
    );
    assert_eq!(f.collect(), 1);
}

#[test]
fn malformed_item_fails_once_and_does_not_poison_the_other_jobs() {
    let mut f = Fixture::new();
    f.add_with_cid("bad", 0);
    f.add("good");
    f.run(Action::Reconcile).unwrap();
    assert!(!f.state.jobs.contains_key("bad"));
    assert!(f.state.jobs.contains_key("good"));
    let sequence = f.state.next_event_sequence;
    f.run(Action::Reconcile).unwrap();
    assert_eq!(f.state.next_event_sequence, sequence);
    f.flush();
    assert_eq!(f.item("bad").cache_status, "failed");
}

#[test]
fn captured_reuse_cannot_override_replacement_and_stop_wins_late_admission() {
    let mut f = Fixture::new();
    f.add("a");
    f.ready("a");
    let reuse = Reuse::inspect(&f.app.cache_items().unwrap(), &[], &f.facts);
    let gate = Arc::new(Barrier::new(2));
    let next = gate.clone();
    let shared = Arc::new(Mutex::new(f));
    let actor = shared.clone();
    let thread = thread::spawn(move || {
        next.wait();
        let mut f = actor.lock().unwrap();
        f.app.execute(AppStateRequest::RemoveItem {
            schema_version: 1,
            item_id: "a".into(),
            now: 6.0,
        });
        f.add("a");
        f.run(Action::Stop).unwrap();
        next.wait();
    });
    gate.wait();
    gate.wait();
    let mut f = shared.lock().unwrap();
    let Fixture {
        app,
        state,
        orchestration,
        facts,
        owner,
        ..
    } = &mut *f;
    assert_eq!(
        orchestration
            .apply(state, app, owner, facts, Action::Reconcile, &reuse)
            .unwrap_err()
            .kind,
        "stopped"
    );
    assert!(state.jobs.is_empty());
    drop(f);
    thread.join().unwrap();
}

#[test]
fn preemption_replaces_once_and_late_settlement_cannot_remove_replacement() {
    let mut f = Fixture::new();
    f.add("a");
    f.add("b");
    f.run(Action::Reconcile).unwrap();
    f.flush();
    let old = f.activate("b");
    f.run(Action::Reconcile).unwrap();
    let replacement = f.state.jobs["b"].clone();
    assert!(replacement.cache_attempt_token > old.cache_attempt_token);
    assert!(f.state.active["b"].cancel.load(Ordering::Acquire));
    let sequence = f.state.next_event_sequence;
    f.run(Action::Reconcile).unwrap();
    assert_eq!(f.state.next_event_sequence, sequence);
    settle_job_locked(&mut f.state, &old, JobOutcome::Cancelled);
    assert_eq!(
        f.state.jobs["b"].cache_attempt_token,
        replacement.cache_attempt_token
    );
    assert_eq!(
        f.state
            .normal_queue
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        vec!["a", "b"]
    );
    let effects = f.application.apply(
        &mut f.app,
        f.state.events.drain(..).collect(),
        HostContract::Default { max_cache_items: 3 },
        5.0,
    );
    assert!(effects.errors.is_empty());
    assert!(
        f.app
            .cache_runtime_item("b", replacement.cache_attempt_token)
            .is_ok()
    );
}

#[test]
fn source_handoff_waits_without_holding_appstate_or_worker_lock() {
    let mut f = Fixture::new();
    f.add("a");
    f.run(Action::Reconcile).unwrap();
    let job = f.activate("a");
    let runtime = Arc::new(CacheRuntime::new_without_workers(Arc::new(|_, _| {
        panic!("unexpected reservation")
    })));
    *lock_state(&runtime.shared) = std::mem::take(&mut f.state);
    let gate = Arc::new(Barrier::new(2));
    let parked = gate.clone();
    let actor = runtime.clone();
    let worker = thread::spawn(move || {
        let _admission = actor.orchestration.lock().unwrap();
        CacheRuntime::cancel_item_locked(&mut lock_state(&actor.shared), "a", "source handoff");
        parked.wait();
        wait_for_item_drain(&actor, "a").unwrap()
    });
    gate.wait();
    assert!(runtime.orchestration.try_lock().is_err());
    // The AppState is still freely usable while the old executor unwinds.
    assert_eq!(f.app.cache_items().unwrap().len(), 1);
    let mut state = lock_state(&runtime.shared);
    assert!(state.active["a"].cancel.load(Ordering::Acquire));
    settle_job_locked(&mut state, &job, JobOutcome::Cancelled);
    runtime.shared.wake.notify_all();
    drop(state);
    assert_eq!(worker.join().unwrap()["active_item_ids"], json!([]));
    assert!(runtime.orchestration.try_lock().is_ok());
}

#[cfg(feature = "native-host")]
#[test]
fn native_host_reuses_builder_with_its_available_page_contract() {
    let mut f = Fixture::new();
    let mut item = f.add("a");
    item.available_pages = vec![2, 1];
    item.available_cids = vec![22, 11];
    item.available_parts = vec!["instrumental".into(), "original".into()];
    item.selected_pages = vec![1, 2];
    item.selected_cids = vec![111, 222];
    item.video_page = 1;
    let job = build_job(
        &item,
        JobInputs {
            cache_root: f.facts.cache_root.clone(),
            log_file: f.facts.log_dir.join("native.log"),
            cookie: String::new(),
            user_agent: "fixture".into(),
            referer: "fixture".into(),
            video_quality: "720P 高清".into(),
            avc_quality_cap: "480P 清晰".into(),
            audio_hires: true,
            executor: Executor::Native,
        },
        JobContract::Native,
    )
    .unwrap();
    assert_eq!(
        job.pages
            .iter()
            .map(|page| (page.page, page.cid, page.label.as_str()))
            .collect::<Vec<_>>(),
        vec![(2, 22, "instrumental"), (1, 11, "original")]
    );
    assert_eq!(job.video_page, 1);
    assert_eq!(job.executor.source(), "native");
    assert_eq!(job.avc_quality_cap, "480P 清晰");
}

#[test]
fn stale_retry_cannot_reopen_a_cleared_window() {
    let mut f = Fixture::new();
    let old = f.add("same");
    f.app.execute(AppStateRequest::RemoveItem {
        schema_version: 1,
        item_id: "same".into(),
        now: 5.0,
    });
    f.add("same");
    f.run(Action::Clear).unwrap();
    assert!(f.orchestration.paused);
    assert_eq!(
        f.run(Action::Retry {
            item_id: "same".into(),
            incarnation: old.item_incarnation_id,
            force: true
        })
        .unwrap_err()
        .kind,
        "item_incarnation_mismatch"
    );
    assert!(f.orchestration.paused);
    f.run(Action::Wake).unwrap();
    assert!(f.state.jobs.is_empty());
    f.run(Action::Reconcile).unwrap();
    assert!(f.state.jobs.contains_key("same"));
}

#[test]
fn retained_source_supersedes_deferred_native_replacement_intent() {
    let mut f = Fixture::new();
    let item = f.add("a");
    let r = f
        .app
        .reserve_runtime_attempt("a", &item.item_incarnation_id)
        .unwrap();
    f.facts.external_attempts.push(ExternalAttempt {
        item_id: "a".into(),
        cache_attempt_token: r.cache_attempt_token,
        retry_open: false,
        primary: true,
        urgent: false,
    });
    f.run(Action::Reconcile).unwrap();
    f.facts.hevc_supported = Some(false);
    f.facts.avc_quality_cap = "480P 清晰".into();
    f.run(Action::Reconcile).unwrap();
    assert_eq!(f.orchestration.replacements.len(), 1);
    f.facts.download_source = "downkyi".into();
    f.run(Action::Reconcile).unwrap();
    assert!(f.orchestration.replacements.is_empty());
    f.app.settle_artifact_reservation(&r);
    f.facts.external_attempts.clear();
    f.ready("a");
    f.facts.download_source = "native".into();
    f.run(Action::Reconcile).unwrap();
    assert!(f.state.jobs.is_empty());
    assert_eq!(f.item("a").cache_status, "ready");
}
