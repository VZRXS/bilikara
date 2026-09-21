use super::*;
use std::sync::{Arc, Barrier};

struct Fixture {
    app: AppState,
    root: PathBuf,
    owner: String,
}
impl Fixture {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("bilikara-lifetime-{}", opaque_token().unwrap()));
        let mut app = AppState::default();
        let seed = serde_json::from_value(json!({"session_users":["Alice"], "session_started_at":1.0, "session_played_file":"test.json", "updated_at":1.0})).unwrap();
        assert!(
            app.execute(AppStateRequest::Initialize {
                schema_version: 1,
                state: Box::new(seed)
            })
            .error()
            .is_none()
        );
        let owner = app.open_artifact_lifetime(&root).unwrap();
        Self { app, root, owner }
    }

    fn add(&mut self, id: &str) {
        let item = serde_json::from_value(json!({"id":id,"original_url":"https://example.test/video","resolved_url":"https://example.test/video","bvid":id,"aid":1,"cid":2,"page":1,"title":id,"part_title":"P1","display_title":id,"cover_url":"","embed_url":"","selected_pages":[1],"selected_cids":[2],"selected_durations":[120],"selected_parts":["P1"],"available_pages":[1],"available_cids":[2],"available_durations":[120],"available_parts":["P1"]})).unwrap();
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
    }

    fn begin(&mut self, id: &str) -> CacheAttemptReservation {
        let incarnation = self
            .app
            .data
            .as_ref()
            .unwrap()
            .find_item(id)
            .unwrap()
            .item_incarnation_id
            .clone();
        let response = self.app.execute(AppStateRequest::BeginCacheAttempt {
            schema_version: 1,
            item_id: id.into(),
            expected_item_incarnation_id: incarnation,
        });
        let AppStateResponse::Success(response) = response else {
            panic!("reservation failed")
        };
        serde_json::from_value(response.result).unwrap()
    }

    fn publish(&mut self, reservation: &CacheAttemptReservation) {
        let complete = self
            .root
            .join(".staging")
            .join(format!("attempt-{}", reservation.cache_attempt_token))
            .join("complete");
        fs::create_dir_all(&complete).unwrap();
        fs::write(complete.join("video.mp4"), b"synthetic video").unwrap();
        fs::write(complete.join("audio.m4a"), b"synthetic audio").unwrap();
        assert!(
            self.app
                .publish_external_artifact(reservation.cache_attempt_token)
                .unwrap()
        );
    }

    fn ready(&mut self, r: &CacheAttemptReservation) -> AppStateResponse {
        let dir = &r.artifact_relative_directory;
        let event = serde_json::from_value(json!({"kind":"ready","message":"ready","video_relative_path":format!("{dir}/video.mp4"),"video_media_url":format!("/media/{dir}/video.mp4"),"audio_variants":[{"id":"p1","label":"P1","page":1,"audio_url":format!("/media/{dir}/audio.m4a")}],"selected_audio_variant_id":"p1","item_incarnation_id":r.item_incarnation_id,"artifact_set_id":r.artifact_set_id,"artifact_relative_directory":dir})).unwrap();
        self.app.execute(AppStateRequest::ApplyCacheEvent {
            schema_version: 1,
            item_id: r.item_id.clone(),
            cache_attempt_token: r.cache_attempt_token,
            event,
            now: 3.0,
        })
    }

    fn remove(&mut self, id: &str) {
        assert!(
            self.app
                .execute(AppStateRequest::RemoveItem {
                    schema_version: 1,
                    item_id: id.into(),
                    now: 4.0
                })
                .error()
                .is_none()
        );
    }

    fn claim(
        &mut self,
        client: &str,
        generation: u64,
        r: &CacheAttemptReservation,
        retire: bool,
    ) -> bool {
        self.app
            .claim_artifact_program(
                client,
                generation,
                &r.item_incarnation_id,
                &r.artifact_set_id,
                retire,
            )
            .unwrap()
    }

    fn collect(&mut self) -> usize {
        let jobs = self.app.prepare_artifact_collection();
        let mut count = 0;
        for job in jobs {
            let ok = job.delete().is_ok();
            self.app.finish_artifact_collection(&job, ok);
            count += usize::from(ok);
        }
        count
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn references_attempts_exact_programs_and_overlapping_readers_each_protect() {
    let mut f = Fixture::new();
    f.add("current");
    f.add("queued");
    let current = f.begin("current");
    f.publish(&current);
    assert!(f.ready(&current).error().is_none());
    let generation = f.app.data.as_ref().unwrap().playback_generation;
    let queued = f.begin("queued");
    f.publish(&queued);
    assert!(f.ready(&queued).error().is_none());
    assert_eq!(f.collect(), 0); // current and queued independently
    assert!(f.claim("host-a", generation, &current, false));
    assert!(f.claim("host-b", generation, &current, false));
    let relative = format!("{}/video.mp4", current.artifact_relative_directory);
    let reader_a = f.app.acquire_artifact_reader(&relative).unwrap().unwrap();
    let reader_b = f.app.acquire_artifact_reader(&relative).unwrap().unwrap();
    let replacement = f.begin("current");
    f.publish(&replacement);
    assert_eq!(f.collect(), 0); // replacement is published but not ready
    assert!(f.ready(&replacement).error().is_none());
    assert!(f.claim("host-a", generation, &current, true));
    assert_eq!(f.collect(), 0);
    assert!(f.claim("host-b", generation, &current, true));
    assert_eq!(f.collect(), 0);
    assert!(!f.app.release_artifact_reader("forged"));
    assert!(f.app.release_artifact_reader(&reader_a));
    assert!(!f.app.release_artifact_reader(&reader_a));
    assert_eq!(f.collect(), 0);
    assert!(f.app.release_artifact_reader(&reader_b));
    assert_eq!(f.collect(), 1);
    assert!(f.app.acquire_artifact_reader(&relative).unwrap().is_none());
    f.remove("queued");
    assert_eq!(f.collect(), 1);
    assert!(
        f.root
            .join(&replacement.artifact_relative_directory)
            .is_dir()
    );
}

#[test]
fn stale_completion_and_reused_item_id_settle_only_the_exact_physical_attempt() {
    let mut f = Fixture::new();
    f.add("same");
    let old = f.begin("same");
    f.publish(&old);
    f.remove("same");
    assert_eq!(f.collect(), 0); // removed worker has not settled
    f.add("same");
    let new = f.begin("same");
    assert_ne!(old.item_incarnation_id, new.item_incarnation_id);
    f.publish(&new);
    assert!(f.ready(&old).error().is_some());
    assert_eq!(f.collect(), 1);
    assert_eq!(f.collect(), 0);
    assert!(f.ready(&old).error().is_some());
    assert!(f.root.join(&new.artifact_relative_directory).is_dir());
    assert!(f.ready(&new).error().is_none());
    assert!(f.ready(&new).error().is_none()); // duplicate terminal is idempotent
}

#[test]
fn program_retirement_is_monotonic_exact_and_client_scoped() {
    let mut f = Fixture::new();
    f.add("song");
    let first = f.begin("song");
    f.publish(&first);
    assert!(f.ready(&first).error().is_none());
    let old_generation = f.app.data.as_ref().unwrap().playback_generation;
    assert!(f.claim("a", old_generation, &first, false));
    let second = f.begin("song");
    f.publish(&second);
    assert!(f.ready(&second).error().is_none());
    let new_generation = f.app.data.as_ref().unwrap().playback_generation;
    assert!(f.claim("a", new_generation, &second, false));
    assert!(!f.claim("a", new_generation, &first, true)); // wrong exact identity
    assert!(f.claim("a", old_generation, &first, true));
    assert!(!f.claim("a", old_generation, &first, false));
    assert!(f.claim("b", old_generation, &first, false));
    assert!(!f.claim("a", old_generation, &second, false));
    f.remove("song");
    assert_eq!(f.collect(), 0);
    assert!(f.claim("b", old_generation, &first, true));
    assert_eq!(f.collect(), 1);
    assert!(f.claim("a", new_generation, &second, true));
    assert_eq!(f.collect(), 1);
}

#[test]
fn collection_closes_admission_before_unlock_and_deletes_without_the_state_lock() {
    let mut f = Fixture::new();
    f.add("song");
    let r = f.begin("song");
    f.publish(&r);
    assert!(f.ready(&r).error().is_none());
    let generation = f.app.data.as_ref().unwrap().playback_generation;
    f.remove("song");
    let app = Arc::new(Mutex::new(std::mem::take(&mut f.app)));
    let renamed = Arc::new(Barrier::new(2));
    let admitted = Arc::new(Barrier::new(2));
    let worker = {
        let app = app.clone();
        let renamed = renamed.clone();
        let admitted = admitted.clone();
        std::thread::spawn(move || {
            let jobs = app.lock().unwrap().prepare_artifact_collection();
            assert_eq!(jobs.len(), 1);
            renamed.wait();
            admitted.wait(); // the other thread acquires AppState before delete
            for job in jobs {
                job.delete().unwrap();
                app.lock().unwrap().finish_artifact_collection(&job, true);
            }
        })
    };
    renamed.wait();
    {
        let mut app = app.lock().unwrap();
        assert!(
            app.acquire_artifact_reader(&format!("{}/video.mp4", r.artifact_relative_directory))
                .unwrap()
                .is_none()
        );
        assert!(
            !app.claim_artifact_program(
                "late",
                generation,
                &r.item_incarnation_id,
                &r.artifact_set_id,
                false
            )
            .unwrap()
        );
        assert!(
            !app.register_artifact_attempt(r.cache_attempt_token)
                .unwrap()
        );
        assert!(app.prepare_artifact_collection().is_empty()); // no duplicate deleter
    }
    admitted.wait();
    worker.join().unwrap();
    assert!(!f.root.join(&r.artifact_relative_directory).exists());
}

#[test]
fn rename_failure_retries_without_forgetting_or_overwriting_unknown_files() {
    let mut f = Fixture::new();
    f.add("song");
    let r = f.begin("song");
    f.publish(&r);
    assert!(f.ready(&r).error().is_none());
    f.remove("song");
    fs::write(f.root.join(".retired"), b"unknown user file").unwrap();
    assert_eq!(f.collect(), 0);
    assert!(f.root.join(&r.artifact_relative_directory).is_dir());
    assert_eq!(
        fs::read(f.root.join(".retired")).unwrap(),
        b"unknown user file"
    );
    fs::remove_file(f.root.join(".retired")).unwrap();
    assert_eq!(f.collect(), 1);
}

#[test]
fn failed_no_replace_publication_never_adopts_the_collision_directory() {
    let mut f = Fixture::new();
    f.add("song");
    let r = f.begin("song");
    let destination = f.root.join(&r.artifact_relative_directory);
    fs::create_dir_all(&destination).unwrap();
    fs::write(destination.join("user-file"), b"keep").unwrap();
    let staging = f.root.join(format!(
        ".staging/attempt-{}/complete",
        r.cache_attempt_token
    ));
    fs::create_dir_all(&staging).unwrap();
    fs::write(staging.join("video.mp4"), b"synthetic").unwrap();
    assert!(
        f.app
            .publish_external_artifact(r.cache_attempt_token)
            .is_err()
    );
    let failed = f.app.execute(AppStateRequest::ApplyCacheEvent {
        schema_version: 1,
        item_id: r.item_id.clone(),
        cache_attempt_token: r.cache_attempt_token,
        event: CacheEvent::Failed {
            message: "no-replace collision".into(),
        },
        now: 4.0,
    });
    assert!(failed.error().is_none());
    f.remove("song");
    assert_eq!(f.collect(), 0);
    assert_eq!(fs::read(destination.join("user-file")).unwrap(), b"keep");
    assert!(staging.join("video.mp4").is_file());
}

#[cfg(unix)]
#[test]
fn unsafe_descendants_are_rejected_and_failed_deletion_is_retried() {
    use std::os::unix::fs::symlink;
    let mut f = Fixture::new();
    f.add("song");
    let r = f.begin("song");
    f.publish(&r);
    assert!(f.ready(&r).error().is_none());
    let outside = f.root.join("user-file");
    fs::write(&outside, b"preserve").unwrap();
    let link = f.root.join(&r.artifact_relative_directory).join("link");
    symlink(&outside, &link).unwrap();
    assert!(
        f.app
            .acquire_artifact_reader(&format!("{}/link", r.artifact_relative_directory))
            .unwrap()
            .is_none()
    );
    f.remove("song");
    assert_eq!(f.collect(), 0); // renamed, but link makes deletion fail closed
    assert_eq!(f.app.artifact_lifetime.retired.len(), 1);
    f.app
        .execute(AppStateRequest::Shutdown { schema_version: 1 });
    let blocked = f.app.execute(AppStateRequest::Initialize {
        schema_version: 1,
        state: Box::new(serde_json::from_value(json!({"session_started_at":1.0,"session_played_file":"restart.json","updated_at":1.0})).unwrap()),
    });
    assert_eq!(blocked.error().unwrap().kind, "artifact_drain_pending");
    let key = ArtifactKey::new(&r.item_incarnation_id, &r.artifact_set_id).unwrap();
    fs::remove_file(f.root.join(key.relative(".retired")).join("link")).unwrap();
    assert_eq!(f.collect(), 1);
    assert_eq!(fs::read(outside).unwrap(), b"preserve");
}

#[test]
fn shutdown_and_reinitialization_cannot_reuse_old_owner_or_reader_handles() {
    let mut f = Fixture::new();
    f.add("song");
    let r = f.begin("song");
    f.publish(&r);
    assert!(f.ready(&r).error().is_none());
    let path = format!("{}/video.mp4", r.artifact_relative_directory);
    let handle = f.app.acquire_artifact_reader(&path).unwrap().unwrap();
    f.remove("song");
    assert!(f.app.close_artifact_lifetime(&f.owner));
    assert!(f.app.acquire_artifact_reader(&path).unwrap().is_none());
    assert_eq!(f.collect(), 0);
    assert!(f.app.open_artifact_lifetime(&f.root).is_err()); // drain old readers first
    assert!(f.app.release_artifact_reader(&handle));
    assert_eq!(f.collect(), 1);
    let owner = f.app.open_artifact_lifetime(&f.root).unwrap();
    assert_ne!(owner, f.owner);
    assert!(!f.app.artifact_owner(&f.owner));
    f.add("next");
    let next = f.begin("next");
    f.publish(&next);
    assert!(f.ready(&next).error().is_none());
    let new_handle = f
        .app
        .acquire_artifact_reader(&format!("{}/audio.m4a", next.artifact_relative_directory))
        .unwrap()
        .unwrap();
    assert!(!f.app.release_artifact_reader(&handle));
    f.remove("next");
    assert_eq!(f.collect(), 0);
    assert!(f.app.release_artifact_reader(&new_handle));
    assert_eq!(f.collect(), 1);
}

#[cfg(unix)]
#[test]
fn trusted_root_alias_works_but_unregistered_and_escaping_paths_never_become_owned() {
    let mut f = Fixture::new();
    let alias = f.root.with_extension("alias");
    std::os::unix::fs::symlink(&f.root, &alias).unwrap();
    assert!(f.app.close_artifact_lifetime(&f.owner));
    f.owner = f.app.open_artifact_lifetime(&alias).unwrap();
    fs::remove_file(alias).unwrap();
    let unknown = f.root.join("artifacts/i-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-0000000000000001/a-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-0000000000000001");
    fs::create_dir_all(&unknown).unwrap();
    f.add("song");
    let r = f.begin("song");
    f.publish(&r);
    assert!(f.ready(&r).error().is_none());
    for path in [
        "../secret",
        "/artifacts/a/b/video",
        "artifacts/../secret",
        "artifacts/a/b/../x",
        "artifacts/a/b/C:\\x",
    ] {
        assert!(f.app.acquire_artifact_reader(path).unwrap().is_none());
    }
    f.remove("song");
    assert_eq!(f.collect(), 1);
    assert!(unknown.is_dir());
    assert!(f.root.is_dir());
}
