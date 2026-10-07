use super::*;

fn isolated(action: impl FnOnce()) {
    let _owned = crate::app_state::native_session::GLOBAL_APP_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            with_app(|app| {
                *app.native() = Default::default();
                Ok(())
            })
            .unwrap();
        }
    }
    let _reset = Reset;
    with_app(|app| {
        *app.native() = Default::default();
        app.native().cookie = "SESSDATA=fixture; bili_jct=fixture".into();
        app.native().desktop = true;
        Ok(())
    })
    .unwrap();
    action();
}

fn source() -> TaskLease {
    with_app(|app| TaskLease::start(app.native(), true, "queued_source", false, true)).unwrap()
}

#[test]
fn startup_and_one_manual_source_overlap_without_cooldown_or_false_idle_in_either_order() {
    for source_first in [true, false] {
        isolated(|| {
            let (background, _) =
                TaskLease::acquire(None, "credential_restore", true, false).unwrap();
            let manual = source();
            with_app(|app| {
                let session = app.native();
                assert!(session.library_refresh_active && session.library_source_active);
                assert!(TaskLease::start(session, true, "queued_source", false, true).is_err());
                assert!(TaskLease::start(session, false, "manual_refresh", true, false).is_err());
                assert!(TaskLease::start(session, false, "remove_source", false, true).is_err());
                session.login.configured_refresh_progress(
                    background.ticket.as_ref().unwrap().0,
                    json!({"phase":"uid","current_uid":"11","sources":{"uids":0,"favorites":0}}),
                );
                assert!(session.login.gacha_snapshot().background_busy);
                assert!(!session.login.gacha_snapshot().busy);
                Ok(())
            })
            .unwrap();
            let remaining = if source_first {
                manual.finish(&Ok(json!({}))).unwrap();
                with_app(|app| {
                    assert!(app.native().library_refresh_active);
                    assert_eq!(app.native().login.gacha_snapshot().last_result.unwrap()["rebuild"]["current_uid"], "11");
                    Ok(())
                }).unwrap();
                background
            } else {
                background.finish(&Ok(json!({}))).unwrap();
                with_app(|app| {
                    assert!(app.native().library_source_active);
                    Ok(())
                })
                .unwrap();
                manual
            };
            with_app(|app| {
                let status = app.native().login.gacha_snapshot();
                assert!(status.background_busy);
                assert_eq!(status.last_status, GachaTaskStatus::Running);
                assert!(app.native().library_cooldown_until.is_none());
                Ok(())
            })
            .unwrap();
            remaining.finish(&Ok(json!({}))).unwrap();
            with_app(|app| {
                assert!(!app.native().login.gacha_snapshot().background_busy);
                assert!(!app.native().library_source_active);
                assert!(!app.native().library_refresh_active);
                assert!(app.native().library_cooldown_until.is_none());
                Ok(())
            })
            .unwrap();
        });
    }
}

#[test]
fn foreground_first_shares_results_with_startup_but_a_later_round_fetches_again() {
    isolated(|| {
        let manual = source();
        let foreground_control = manual.ticket.as_ref().unwrap().1.clone();
        assert!(
            !foreground_control
                .source("uid:11".into(), || Ok(
                    json!({"cache":{"uid":"11"},"entries":[{"bvid":"new"}]})
                ))
                .unwrap()
                .1
        );
        let (background, _) = TaskLease::acquire(None, "credential_restore", true, false).unwrap();
        let control = &background.ticket.as_ref().unwrap().1;
        let (shared, reused) = control
            .source("uid:11".into(), || panic!("duplicate source request"))
            .unwrap();
        assert!(reused);
        assert!(
            shared.get("entries").is_none(),
            "a follower must not append the owner's delta twice"
        );
        manual.finish(&Ok(json!({}))).unwrap();
        background.finish(&Ok(json!({}))).unwrap();
        let next = source();
        assert!(
            !next
                .ticket
                .as_ref()
                .unwrap()
                .1
                .source("uid:11".into(), || Ok(json!("next round")))
                .unwrap()
                .1
        );
        next.finish(&Ok(json!({}))).unwrap();
    });
}

#[test]
fn credential_change_fences_both_lanes_and_deletion_stays_exclusive() {
    isolated(|| {
        let (background, _) = TaskLease::acquire(None, "credential_restore", true, false).unwrap();
        let manual = source();
        manual
            .ticket
            .as_ref()
            .unwrap()
            .1
            .source("uid:11".into(), || Ok(json!("old account")))
            .unwrap();
        with_app(|app| {
            invalidate_credentials(app.native());
            Ok(())
        })
        .unwrap();
        for lease in [&background, &manual] {
            assert!(
                lease
                    .ticket
                    .as_ref()
                    .unwrap()
                    .1
                    .commit(
                        || -> Result<(), crate::gatcha_repository::GatchaRepositoryError> {
                            panic!("late file write")
                        }
                    )
                    .is_err()
            );
        }
        manual.finish(&Ok(json!({}))).unwrap();
        let new_account_source = source();
        assert_eq!(
            new_account_source
                .ticket
                .as_ref()
                .unwrap()
                .1
                .source("uid:11".into(), || Ok(json!("new account")))
                .unwrap(),
            (json!("new account"), false)
        );
        new_account_source.finish(&Ok(json!({}))).unwrap();
        background.finish(&Ok(json!({}))).unwrap();
        let (deletion, _) = TaskLease::acquire(None, "remove_source", false, true).unwrap();
        assert!(TaskLease::acquire(None, "credential_restore", true, false).is_err());
        with_app(|app| {
            assert!(TaskLease::start(app.native(), true, "queued_source", false, true).is_err());
            Ok(())
        })
        .unwrap();
        deletion
            .finish(&Ok(json!({"operation":"remove_source"})))
            .unwrap();
    });
}

#[test]
fn full_manual_refresh_and_legacy_conversion_do_not_gain_parallel_admission() {
    isolated(|| {
        let (maintenance, _) = TaskLease::acquire_current_parallel(
            None,
            Some("credential_restore"),
            true,
            false,
            false,
        )
        .unwrap();
        with_app(|app| {
            assert!(TaskLease::start(app.native(), true, "queued_source", false, true).is_err());
            Ok(())
        })
        .unwrap();
        maintenance.finish(&Ok(json!({}))).unwrap();
        let (manual, _) = TaskLease::acquire(None, "cookie_config", true, false).unwrap();
        with_app(|app| {
            assert!(TaskLease::start(app.native(), true, "queued_source", false, true).is_err());
            Ok(())
        })
        .unwrap();
        manual.finish(&Ok(json!({}))).unwrap();
        assert!(TaskLease::acquire(None, "cookie_config", true, false).is_err());
        let queued = source(); // Single-source imports do not obey or reset that cooldown.
        queued.finish(&Ok(json!({}))).unwrap();
        with_app(|app| {
            assert!(app.native().library_cooldown_until.is_some());
            Ok(())
        })
        .unwrap();
    });
}
