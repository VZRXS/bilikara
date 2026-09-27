//! Authenticated Host transport. Remote clients cannot poll R2 or change this
//! installation's shown records. Network IO never holds the AppState lock.
use super::*;

pub(super) fn route(
    context: &HostContext,
    identity: &Identity,
    path: &str,
    body: &Value,
) -> Result<Value, ApiError> {
    let check = with_app(|app| {
        app.native_authorize(identity, true)?;
        Ok(app.native().announcements.check.clone())
    })?;
    match path {
        "/api/announcements/check" => {
            // Coalesces simultaneous startup/manual requests. The next waiter
            // observes the completed cache, including a throttled failed check.
            let _checking = check.lock().map_err(|_| {
                ApiError::new(503, "announcements", "Announcement check unavailable")
            })?;
            let request = with_app(|app| {
                let state = &app.native().announcements;
                Ok((!state.fresh(now() as i64)).then(|| state.etag()))
            })?;
            if let Some(etag) = request {
                let fetched = crate::announcements::fetch(etag.as_deref());
                with_app(|app| {
                    app.native()
                        .announcements
                        .finish(&context.directory, fetched, now() as i64);
                    Ok(())
                })?;
            }
            with_app(|app| Ok(app.native().announcements.snapshot(now() as i64)))
        }
        "/api/announcements/shown" => {
            let ids: Vec<String> = serde_json::from_value(body["ids"].clone())
                .map_err(|_| ApiError::invalid("Announcement IDs required"))?;
            with_app(|app| {
                app.native()
                    .announcements
                    .shown(&context.directory, &ids)
                    .map_err(|error| ApiError::new(503, "announcement_storage", error))?;
                Ok(json!({"saved":true}))
            })
        }
        _ => Err(ApiError::new(
            404,
            "not_found",
            "Announcement route not found",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn announcement_routes_are_host_only_and_cached_checks_preserve_shown_records() {
        let _owned = crate::app_state::native_session::GLOBAL_APP_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let directory =
            std::env::temp_dir().join(format!("bilikara-announcement-route-{}", token().unwrap()));
        std::fs::create_dir_all(&directory).unwrap();
        let context = HostContext {
            directory: directory.clone(),
            cache_root: directory.join("media"),
            assets: Arc::new(|_| None),
            stop: Arc::new(AtomicBool::new(false)),
            api_slots: Arc::new(Semaphore::new(1)),
            export_slots: Arc::new(Semaphore::new(1)),
            export_renderer: Default::default(),
            port: 0,
            desktop: true,
            bind_address: std::net::Ipv4Addr::LOCALHOST,
            allowed_hosts: Default::default(),
            bbdown: None,
            aria2: Default::default(),
            aria2_prepare: Default::default(),
            shutdown_token: None,
            desktop_installation: None,
            workers: Default::default(),
        };
        let host = Identity {
            token: "announcement-test-host".into(),
            loopback: true,
            client: "test".into(),
        };
        let remote = Identity {
            loopback: false,
            ..host.clone()
        };
        let mut saved =
            crate::announcements::State::load(&directory, "0.8.0".into(), "windows".into());
        saved.finish(
            &directory,
            Ok(crate::announcements::Refresh::Changed {
                feed: serde_json::from_str(include_str!("../../../announcements/example.json"))
                    .unwrap(),
                etag: None,
            }),
            now() as i64,
        );
        struct Restore(Option<crate::app_state::native_session::NativeSession>);
        impl Drop for Restore {
            fn drop(&mut self) {
                with_app(|app| {
                    *app.native() = self.0.take().unwrap();
                    Ok(())
                })
                .unwrap();
            }
        }
        let _restore = Restore(Some(
            with_app(|app| {
                let old = std::mem::take(app.native());
                app.native().host_token = host.token.clone();
                app.native().announcements = saved;
                Ok(old)
            })
            .unwrap(),
        ));
        for path in ["/api/announcements/check", "/api/announcements/shown"] {
            assert_eq!(
                route(&context, &remote, path, &json!({"ids":[]}))
                    .unwrap_err()
                    .status,
                403
            );
        }
        let before = std::fs::read(directory.join("announcements.json")).unwrap();
        let first = route(&context, &host, "/api/announcements/check", &json!({})).unwrap();
        assert_eq!(first["available"], true);
        assert_eq!(first["installed_version"], "0.8.0");
        assert_eq!(
            std::fs::read(directory.join("announcements.json")).unwrap(),
            before
        );
        route(
            &context,
            &host,
            "/api/announcements/shown",
            &json!({"ids":["example-release-0.8.0"]}),
        )
        .unwrap();
        let second = route(&context, &host, "/api/announcements/check", &json!({})).unwrap();
        assert!(
            !second["automatic_ids"]
                .as_array()
                .unwrap()
                .contains(&json!("example-release-0.8.0"))
        );
        assert_eq!(
            route(&context, &host, "/api/announcements/unknown", &json!({}))
                .unwrap_err()
                .status,
            404
        );
        std::fs::remove_dir_all(directory).unwrap();
    }
}
