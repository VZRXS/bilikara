use super::*;
use crate::cast_platform::{
    self, InitializationFailure,
    test_support::{self, RecordingPlatform},
};

#[test]
fn platform_initialization_failure_keeps_host_running_and_reports_unavailable() {
    let _serial = GLOBAL_APP_TEST_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    for reason in [
        InitializationFailure::InitializationFailed,
        InitializationFailure::InitializationTimedOut,
    ] {
        test_support::scoped(|| {
            // Same optional boundary used by Android bootstrap; the actual native
            // listener and unrelated playlist operations must still work afterward.
            cast_platform::initialize_optional(|| Err(reason));
            crate::execute_app_state(AppStateRequest::Shutdown { schema_version: 1 });
            let seed = serde_json::from_value(json!({"session_users":["Alice"],"session_started_at":1,"session_played_file":"session.json","updated_at":1})).unwrap();
            assert!(
                crate::execute_app_state(AppStateRequest::Initialize {
                    schema_version: 1,
                    state: Box::new(seed)
                })
                .error()
                .is_none()
            );
            let directory = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../.tmp")
                .join(format!("cast-bootstrap-{}", token().unwrap()));
            std::fs::create_dir_all(&directory).unwrap();
            let native = NativeHost::start(&directory, Arc::new(|_| None)).unwrap();
            drop(TcpStream::connect(("127.0.0.1", native.local_port())).unwrap());
            let identity = Identity {
                token: with_app(|app| Ok(app.native().host_token.clone())).unwrap(),
                loopback: true,
                client: "fixture".into(),
            };
            let host = Host {
                context: native.context.clone(),
                identity: identity.clone(),
            };
            host.song("after-platform-failure", 30);
            assert_eq!(
                host.snapshot()["current_item"]["id"],
                "after-platform-failure"
            );
            let post = |path, body| {
                api::dispatch(
                    &native.context,
                    &identity,
                    true,
                    &Method::POST,
                    path,
                    "",
                    body,
                )
            };
            let error = post(
                "/api/cast/connect",
                json!({"purek_qr":"invalid-but-not-yet-parsed"}),
            )
            .unwrap_err();
            assert_eq!(
                (error.status, error.code.as_str()),
                (409, "cast_platform_unavailable")
            );
            assert!(!with_app(|app| Ok(app.native().cast.owns_playback)).unwrap());
            assert!(with_app(|app| Ok(app.native().cast.pending.is_none())).unwrap());
            // A callback arriving after timeout cannot change the latched failure.
            assert_eq!(
                cast_platform::install(Arc::new(RecordingPlatform::default())),
                Err(cast_platform::PlatformError::AlreadyInstalled)
            );
            assert_eq!(cast_platform::initialization_failure(), Some(reason));
            drop(native);
        });
    }
}
