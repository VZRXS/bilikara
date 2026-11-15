use super::*;
use crate::show_host_process::ShowHostProcess;
use crate::{AppStateSeed, execute_app_state};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, TcpStream};

struct FixtureDirectory(PathBuf);

impl Drop for FixtureDirectory {
    fn drop(&mut self) {
        execute_app_state(AppStateRequest::Shutdown { schema_version: 1 });
        if self.0.canonicalize().ok().as_ref() == Some(&self.0) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

fn stage_track(source: &Path, local: &Path) {
    let original = crate::cache_runtime::show_input_path(local).unwrap();
    std::fs::create_dir_all(original.parent().unwrap()).unwrap();
    std::fs::copy(source, original).unwrap();
    std::fs::copy(source, local).unwrap();
}

fn add_programme(
    root: &Path,
    id: &str,
    name: &str,
    video: &Path,
    audio: &[(u32, &Path)],
) -> PathBuf {
    let result = |input: Value| {
        let reply = execute_app_state(serde_json::from_value(input).unwrap());
        assert!(reply.error().is_none(), "{:?}", reply.error());
        reply
    };
    let pages = audio.iter().map(|(page, _)| *page).collect::<Vec<_>>();
    let cids = pages.iter().map(|page| page + 1).collect::<Vec<_>>();
    let durations = vec![4; pages.len()];
    let parts = vec!["Original"; pages.len()];
    let item = json!({
        "id":id,"original_url":"https://www.bilibili.com/video/BV1z84y1p7oS",
        "resolved_url":"https://www.bilibili.com/video/BV1z84y1p7oS?p=1",
        "bvid":"BV1z84y1p7oS","aid":1,"cid":2,"page":1,"video_page":1,
        "title":format!("Song {id}"),"part_title":"Original",
        "display_title":format!("Song {id}"),"cover_url":"","embed_url":"",
        "selected_pages":pages,"selected_cids":cids,"selected_durations":durations,
        "selected_parts":parts,"available_pages":pages,"available_cids":cids,
        "available_durations":durations,"available_parts":parts,
    });
    let reply = result(json!({
        "schema_version":1, "command":"add_item", "item":item, "position":"tail",
        "requester_name":name, "allow_repeat":true, "now":2.0
    }));
    let snapshot = reply.snapshot().unwrap();
    let entry = snapshot
        .current_item
        .iter()
        .chain(&snapshot.playlist)
        .find(|entry| entry.id == id)
        .unwrap();
    let reserved = result(json!({
        "schema_version":1, "command":"begin_cache_attempt","item_id":id,
        "expected_item_incarnation_id":entry.item_incarnation_id
    }));
    let reserved = reserved.result().unwrap();
    let relative = reserved["artifact_relative_directory"].as_str().unwrap();
    let artifact = root.join(relative);
    stage_track(video, &artifact.join("video.mp4"));
    let variants = audio
        .iter()
        .map(|(page, source)| {
            let name =
                PathBuf::from(format!("audio-p{page}")).with_extension(source.extension().unwrap());
            stage_track(source, &artifact.join(&name));
            json!({"id":format!("p{page}_original"),"label":"Original","page":page,
            "audio_url":format!("/media/{relative}/{}", name.to_str().unwrap())})
        })
        .collect::<Vec<_>>();
    result(json!({
        "schema_version":1,"command":"apply_cache_event","item_id":id,
        "cache_attempt_token":reserved["cache_attempt_token"], "now":3.0,
        "event":{"kind":"ready","message":"Ready",
            "item_incarnation_id":reserved["item_incarnation_id"],
            "artifact_set_id":reserved["artifact_set_id"],"artifact_relative_directory":relative,
            "video_relative_path":format!("{relative}/video.mp4"),
            "video_media_url":format!("/media/{relative}/video.mp4"),
            "audio_variants":variants,
            "selected_audio_variant_id":"p1_original"
        }
    }));
    artifact
}

fn required(name: &str) -> PathBuf {
    PathBuf::from(std::env::var_os(name).expect(name))
        .canonicalize()
        .unwrap()
}

fn fixture_context() -> (FixtureDirectory, HostContext) {
    execute_app_state(AppStateRequest::Shutdown { schema_version: 1 });
    let directory = std::env::temp_dir()
        .canonicalize()
        .unwrap()
        .join(format!("bilikara-show-test-{}", token().unwrap()));
    std::fs::create_dir(&directory).unwrap();
    let cleanup = FixtureDirectory(directory.clone());
    let seed: AppStateSeed = serde_json::from_value(json!({
        "session_users":["Alice","Bob"],"session_started_at":1.0,"session_played_file":"fixture.json","updated_at":1.0
    })).unwrap();
    assert!(
        execute_app_state(AppStateRequest::Initialize {
            schema_version: 1,
            state: Box::new(seed)
        })
        .error()
        .is_none()
    );
    let cache_root = directory.join("media");
    crate::app_state::with_cache_application(|app| app.open_artifact_lifetime(&cache_root))
        .unwrap()
        .unwrap();
    let context = HostContext {
        directory,
        cache_root,
        assets: Arc::new(|_| None),
        stop: Arc::new(AtomicBool::new(false)),
        api_slots: Arc::new(Semaphore::new(1)),
        export_slots: Arc::new(Semaphore::new(1)),
        export_renderer: Default::default(),
        port: 0,
        desktop: true,
        bind_address: Ipv4Addr::LOCALHOST,
        allowed_hosts: Default::default(),
        bbdown: None,
        aria2: Default::default(),
        aria2_prepare: Default::default(),
        shutdown_token: None,
        desktop_installation: None,
        workers: Default::default(),
    };
    (cleanup, context)
}

fn open_receiver(uri: &str) -> BufReader<TcpStream> {
    let uri = url::Url::parse(uri).unwrap();
    assert_eq!(uri.scheme(), "http");
    assert_eq!(uri.host_str(), Some("127.0.0.1"));
    let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, uri.port().unwrap())).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(6)))
        .unwrap();
    write!(
        stream,
        "GET {} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
        uri.path()
    )
    .unwrap();
    let mut receiver = BufReader::new(stream);
    let mut header = String::new();
    receiver.read_line(&mut header).unwrap();
    assert!(header.contains("200 OK"), "{header}");
    loop {
        header.clear();
        assert!(receiver.read_line(&mut header).unwrap() > 0);
        if header == "\r\n" {
            break;
        }
    }
    receiver
}

fn open_native() -> ShowHostProcess {
    let executable = required("BILIKARA_TEST_SHOW_HOST_EXE");
    let dll = required("BILIKARA_TEST_SHOW_DLL");
    ShowHostProcess::with_executable(&executable, &dll).unwrap()
}

fn fixture_renderer() -> Renderer {
    Renderer {
        id: "fixture".into(),
        name: "Fixture reader".into(),
        location: String::new(),
        av_transport_url: String::new(),
        av_transport_type: String::new(),
        local_address: Ipv4Addr::LOCALHOST,
    }
}

#[test]
fn cast_keeps_original_track_bytes_and_never_uses_the_local_copy() {
    let _global = crate::app_state::native_session::GLOBAL_APP_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let (_cleanup, context) = fixture_context();
    let video = context.directory.join("source.mp4");
    let audio = context.directory.join("source.m4a");
    std::fs::write(&video, b"original video").unwrap();
    std::fs::write(&audio, b"original audio").unwrap();
    let artifact = add_programme(
        &context.cache_root,
        "originals",
        "Alice",
        &video,
        &[(1, &audio)],
    );
    let local_video = artifact.join("video.mp4");
    let local_audio = artifact.join("audio-p1.m4a");
    std::fs::write(&local_video, b"normalized video").unwrap();
    std::fs::write(&local_audio, b"normalized audio").unwrap();
    let item = with_app(|app| Ok(app.native_cast_input()?.current_item.unwrap())).unwrap();
    let key = MediaKey::from_ready(&item).unwrap().unwrap();
    let mut files = SessionFiles::new(&context).unwrap();
    let paths = files.paths(&context, &key).unwrap();
    assert_eq!(std::fs::read(&paths.video).unwrap(), b"original video");
    assert_eq!(std::fs::read(&paths.first).unwrap(), b"original audio");

    // The session owns its link even if cache collection removes the input.
    let original = crate::cache_runtime::show_input_path(&local_video).unwrap();
    std::fs::remove_file(&original).unwrap();
    assert_eq!(std::fs::read(&paths.video).unwrap(), b"original video");
    drop(files);
    let mut files = SessionFiles::new(&context).unwrap();
    assert_eq!(
        files.paths(&context, &key).err().unwrap().code,
        media::ORIGINAL_PENDING,
    );
    assert_eq!(std::fs::read(&local_video).unwrap(), b"normalized video");
    assert_eq!(std::fs::read(&local_audio).unwrap(), b"normalized audio");
}

#[test]
fn cast_sends_only_the_requested_playback_indicators() {
    struct RecordingBackend {
        state: PlaybackState,
        actions: Vec<PlaybackAction>,
    }

    impl CastBackend for RecordingBackend {
        fn start_output(&mut self, _: Ipv4Addr) -> Result<String, BackendError> {
            unreachable!("this test starts with a connected backend")
        }
        fn has_served_output(&mut self) -> Result<bool, BackendError> {
            Ok(true)
        }
        fn load_media(&mut self, _: &MediaPaths) -> Result<(), BackendError> {
            self.state = PlaybackState::Idle;
            Ok(())
        }
        fn prepare_media(&mut self, _: &MediaPaths) -> Result<(), BackendError> {
            Ok(())
        }
        fn set_audio_track(&mut self, _: AudioSlot) -> Result<(), BackendError> {
            Ok(())
        }
        fn resync_audio(&mut self) -> Result<(), BackendError> {
            Ok(())
        }
        fn set_queue_hud(&mut self, _: u64, _: &QueueHud) -> Result<(), BackendError> {
            Ok(())
        }
        fn notify_action(&mut self, action: PlaybackAction) -> Result<(), BackendError> {
            self.actions.push(action);
            Ok(())
        }
        fn play(&mut self) -> Result<(), BackendError> {
            self.state = PlaybackState::Playing;
            Ok(())
        }
        fn pause(&mut self) -> Result<(), BackendError> {
            self.state = PlaybackState::Paused;
            Ok(())
        }
        fn stop(&mut self) -> Result<(), BackendError> {
            self.state = PlaybackState::Stopped;
            Ok(())
        }
        fn seek(&mut self, _: f64) -> Result<(), BackendError> {
            Ok(())
        }
        fn set_volume(&mut self, _: i32) -> Result<(), BackendError> {
            Ok(())
        }
        fn set_key(&mut self, _: i32) -> Result<(), BackendError> {
            Ok(())
        }
        fn playback_status(&mut self) -> Result<PlaybackStatus, BackendError> {
            Ok(PlaybackStatus {
                state: self.state,
                position: 1.0,
                duration: 4.0,
                buffering: false,
            })
        }
        fn close(&mut self) -> Result<(), BackendError> {
            Ok(())
        }
    }

    let _global = crate::app_state::native_session::GLOBAL_APP_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let (_cleanup, context) = fixture_context();
    let source = context.directory.join("source.mp4");
    std::fs::write(&source, b"fixture").unwrap();
    add_programme(
        &context.cache_root,
        "alpha",
        "Alice",
        &source,
        &[(1, &source), (2, &source)],
    );
    add_programme(&context.cache_root, "beta", "Bob", &source, &[(1, &source)]);
    with_app(|app| {
        app.native().show_cast.phase = Phase::Active;
        app.native().show_cast.owns_playback = true;
        app.native().host_token = "test-token".into();
        Ok(())
    })
    .unwrap();
    let mut active = Active::new(
        RecordingBackend {
            state: PlaybackState::Idle,
            actions: vec![],
        },
        SessionFiles::new(&context).unwrap(),
        fixture_renderer(),
        None,
    );
    let control = |action: &str| {
        with_app(|app| {
            let snapshot = app.native_cast_input()?;
            app.native_control(
                &Identity { token: "test-token".into(), client: "test".into(), loopback: true },
                &json!({"item_id": "alpha", "playback_generation": snapshot.playback_generation, "action": action}),
                now(),
            )
        }).unwrap();
    };
    let volume = |volume_percent| {
        with_app(|app| {
            app.native_execute(AppStateRequest::SetVolume {
                schema_version: 1,
                volume_percent,
                expected_item_incarnation_id: None,
                now: now(),
            })
        })
        .unwrap();
    };
    volume(40);
    active.tick(&context).unwrap();
    assert!(active.backend.actions.is_empty());
    control("pause");
    active.tick(&context).unwrap();
    volume(50);
    active.tick(&context).unwrap();
    volume(30);
    active.tick(&context).unwrap();
    control("play");
    active.tick(&context).unwrap();
    control("play");
    active.tick(&context).unwrap();
    with_app(|app| {
        let item = app.native_cast_input()?.current_item.unwrap();
        app.native_execute(AppStateRequest::SetAudioVariant {
            schema_version: 1,
            item_id: item.id,
            expected_item_incarnation_id: item.item_incarnation_id,
            variant_id: "p2_original".into(),
            now: now(),
        })
    })
    .unwrap();
    active.tick(&context).unwrap();
    control("next-track");
    active.tick(&context).unwrap();
    active.tick(&context).unwrap();
    assert_eq!(active.programme.as_ref().unwrap().item_id, "beta");
    assert_eq!(
        active.backend.actions,
        [
            PlaybackAction::Pause,
            PlaybackAction::VolumeUp,
            PlaybackAction::VolumeDown,
            PlaybackAction::Play,
            PlaybackAction::Skip,
        ]
    );
}

#[test]
#[ignore = "requires a real Windows Show DLL, Host executable, and short H.264/AAC fixtures"]
fn show_cast_real_dll_advances_over_the_same_http_connection() {
    let video = required("BILIKARA_TEST_SHOW_VIDEO");
    let audio = required("BILIKARA_TEST_SHOW_AUDIO");
    let next_video = std::env::var_os("BILIKARA_TEST_SHOW_NEXT_VIDEO")
        .map_or_else(|| video.clone(), PathBuf::from);
    let next_audio = std::env::var_os("BILIKARA_TEST_SHOW_NEXT_AUDIO")
        .map_or_else(|| audio.clone(), PathBuf::from);
    let _global = crate::app_state::native_session::GLOBAL_APP_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let (_cleanup, context) = fixture_context();
    add_programme(
        &context.cache_root,
        "alpha",
        "Alice",
        &video,
        &[(1, &audio)],
    );
    let next = add_programme(
        &context.cache_root,
        "beta",
        "Bob",
        &next_video,
        &[(1, &next_audio)],
    );
    let local_video = next.join("video.mp4");
    for (env, destination) in [
        ("BILIKARA_TEST_SHOW_NEXT_LOCAL_VIDEO", local_video.clone()),
        (
            "BILIKARA_TEST_SHOW_NEXT_LOCAL_AUDIO",
            next.join("audio-p1")
                .with_extension(next_audio.extension().unwrap()),
        ),
    ] {
        if let Some(source) = std::env::var_os(env) {
            std::fs::copy(source, destination).unwrap();
        }
    }
    let mut native = open_native();
    let uri = native.start_output(Ipv4Addr::LOCALHOST).unwrap();
    let port = native.port().unwrap();
    assert_eq!(native.served_streams().unwrap(), 0);
    let mut receiver = open_receiver(&uri);
    let mut initial_ts = [0; 188 * 8];
    receiver.read_exact(&mut initial_ts).unwrap();
    assert!(initial_ts.chunks_exact(188).all(|packet| packet[0] == 0x47));
    assert_eq!(native.served_streams().unwrap(), 1);
    receiver.get_ref().set_nonblocking(true).unwrap();

    let first = with_app(|app| {
        let snapshot = app.native_cast_input()?;
        let state = &mut app.native().show_cast;
        state.phase = Phase::Active;
        state.owns_playback = true;
        state.titles = Some(Titles {
            playback_generation: snapshot.playback_generation,
            queue_version: snapshot.queue_version,
            current: Some("Parsed Alpha".into()),
            upcoming: vec!["Parsed Beta".into()],
        });
        app.native().host_token = "fixture-token".into();
        Ok(snapshot.playback_generation)
    })
    .unwrap();
    let mut active = Active::new(
        native,
        SessionFiles::new(&context).unwrap(),
        fixture_renderer(),
        None,
    );
    let pid = active.backend.id();
    active.tick(&context).unwrap();
    let hud = active.last_hud.as_ref().unwrap();
    assert_eq!(hud.current.as_ref().unwrap().title, "Parsed Alpha");
    assert_eq!(hud.upcoming[0].title, "Parsed Beta");
    assert_eq!(hud.upcoming[0].requester, "Bob");

    let mut bytes = [0; 64 * 1024];
    let mut received = 0;
    let deadline = Instant::now() + Duration::from_secs(22);
    let second = loop {
        active.tick(&context).unwrap();
        loop {
            match receiver.read(&mut bytes) {
                Ok(0) => panic!("the original TS connection closed at a song boundary"),
                Ok(count) => received += count,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(error) => panic!("receiver read: {error}"),
            }
        }
        if let Some(programme) = &active.programme
            && programme.item_id == "beta"
            && active.saw_playback
        {
            break programme.generation;
        }
        assert!(
            Instant::now() < deadline,
            "Show did not naturally advance: {:?}",
            active.backend.status()
        );
        thread::sleep(Duration::from_millis(60));
    };
    assert!(second > first);
    assert!(received > 188 * 100);
    assert_eq!(active.backend.port().unwrap(), port);
    assert_eq!(active.backend.id(), pid);
    let snapshot = with_app(|app| app.native_snapshot(true)).unwrap();
    assert_eq!(snapshot["current_item"]["id"], "beta");
    assert_eq!(snapshot["player_status"]["position_source"], "show_sender");
    assert!(
        snapshot["session_played"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["item_id"] == "alpha")
    );

    with_app(|app| {
        app.native_control(
            &Identity {
                token: "fixture-token".into(),
                client: "fixture".into(),
                loopback: true,
            },
            &json!({"item_id":"beta","playback_generation":second,"action":"pause"}),
            now(),
        )
    })
    .unwrap();
    active.tick(&context).unwrap();
    active.tick(&context).unwrap();
    assert_eq!(active.backend.status().unwrap().state, 2);
    active.backend.close().unwrap();
    with_app(|app| {
        app.native_return_cast_playback()?;
        let snapshot = app.native_snapshot(true)?;
        assert_ne!(snapshot["cast_active"], true);
        assert_eq!(snapshot["show_cast"]["resume"]["item_id"], "beta");
        assert_eq!(snapshot["show_cast"]["resume"]["was_playing"], false);
        assert_eq!(
            context.cache_root.join(
                snapshot["current_item"]["video_relative_path"]
                    .as_str()
                    .unwrap()
            ),
            local_video,
        );
        Ok(())
    })
    .unwrap();
}

#[test]
#[ignore = "requires a real Windows Show DLL and three identifiable audio fixtures"]
fn show_cast_real_dll_switches_three_parts_over_the_same_http_connection() {
    let video = required("BILIKARA_TEST_SHOW_TRACK_VIDEO");
    let first = required("BILIKARA_TEST_SHOW_TRACK_FIRST");
    let short = required("BILIKARA_TEST_SHOW_TRACK_SHORT");
    let long = required("BILIKARA_TEST_SHOW_TRACK_LONG");
    let _global = crate::app_state::native_session::GLOBAL_APP_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let (_cleanup, context) = fixture_context();
    let artifact = add_programme(
        &context.cache_root,
        "parts",
        "Alice",
        &video,
        &[(3, &long), (1, &first), (4, &first), (2, &short)],
    );
    std::fs::remove_file(
        crate::cache_runtime::show_input_path(
            &artifact
                .join("audio-p4")
                .with_extension(first.extension().unwrap()),
        )
        .unwrap(),
    )
    .unwrap();
    let incarnation = with_app(|app| {
        app.native().show_cast.phase = Phase::Active;
        app.native().show_cast.owns_playback = true;
        Ok(app
            .native_cast_input()?
            .current_item
            .unwrap()
            .item_incarnation_id)
    })
    .unwrap();
    let select = |page| {
        let selected = with_app(|app| {
            app.native_execute(AppStateRequest::SetAudioVariant {
                schema_version: 1,
                item_id: "parts".into(),
                expected_item_incarnation_id: incarnation.clone(),
                variant_id: format!("p{page}_original"),
                now: now(),
            })
        })
        .unwrap();
        assert_eq!(selected["found"], true);
    };
    let mut native = open_native();
    let uri = native.start_output(Ipv4Addr::LOCALHOST).unwrap();
    let port = native.port().unwrap();
    let mut receiver = open_receiver(&uri);
    receiver.get_ref().set_nonblocking(true).unwrap();
    let mut active = Active::new(
        native,
        SessionFiles::new(&context).unwrap(),
        fixture_renderer(),
        None,
    );
    let pid = active.backend.id();
    let mut capture = Vec::new();
    let mut chunk = [0_u8; 64 * 1024];
    let mut poll = |active: &mut Active<ShowHostProcess>, position| {
        let deadline = Instant::now() + Duration::from_secs(8);
        loop {
            active.tick(&context).unwrap();
            loop {
                match receiver.read(&mut chunk) {
                    Ok(0) => panic!("the original TS connection closed during an audio switch"),
                    Ok(count) => capture.extend_from_slice(&chunk[..count]),
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
                    Err(error) => panic!("receiver read: {error}"),
                }
            }
            let status = active.backend.status().unwrap();
            if status.position >= position && !status.buffering {
                return status;
            }
            assert!(Instant::now() < deadline, "Show stalled at {status:?}");
            thread::sleep(Duration::from_millis(20));
        }
    };
    poll(&mut active, 1.4);
    let resident = active.programme.as_ref().unwrap();
    assert_eq!(resident.audio().id, "p1_original");
    assert_eq!(resident.media.second.as_ref().unwrap().id, "p2_original");
    let initial_load = active.loaded_at;

    select(2);
    let after_short = poll(&mut active, 4.8);
    assert_eq!(
        after_short.state, 1,
        "short audio ended the video programme"
    );
    assert_eq!(active.programme.as_ref().unwrap().audio().id, "p2_original");
    assert_eq!(active.loaded_at, initial_load);

    select(1);
    poll(&mut active, 6.3);
    assert_eq!(active.loaded_at, initial_load);
    select(3);
    active.tick(&context).unwrap();
    let after_load = active.backend.status().unwrap();
    assert!(after_load.position >= 6.15, "{after_load:?}");
    let replacement = active.programme.as_ref().unwrap();
    assert_eq!(replacement.audio().id, "p3_original");
    assert_eq!(replacement.media.second.as_ref().unwrap().id, "p1_original");
    assert!(active.loaded_at > initial_load);
    let replacement_load = active.loaded_at;

    poll(&mut active, 7.9);
    select(4);
    active.tick(&context).unwrap();
    with_app(|app| {
        assert_eq!(
            app.native_cast_input()?
                .current_item
                .unwrap()
                .selected_audio_variant_id,
            "p3_original"
        );
        assert!(app.native().show_cast.owns_playback);
        Ok(())
    })
    .unwrap();
    assert_eq!(active.loaded_at, replacement_load);
    select(1);
    poll(&mut active, 9.5);
    assert_eq!(active.loaded_at, replacement_load);
    assert_eq!(active.programme.as_ref().unwrap().audio().id, "p1_original");

    select(3);
    let ended = poll(&mut active, 11.99);
    assert_eq!(ended.state, 3, "{ended:?}");
    assert!((ended.duration - 12.0).abs() < 0.1, "{ended:?}");
    assert_eq!(active.backend.port().unwrap(), port);
    assert_eq!(active.backend.id(), pid);
    assert_eq!(active.backend.served_streams().unwrap(), 1);
    assert!(capture.len() > 188 * 100);
    if let Some(path) = std::env::var_os("BILIKARA_TEST_SHOW_TRACK_CAPTURE") {
        std::fs::write(path, &capture).unwrap();
    }
    active.backend.close().unwrap();
}
