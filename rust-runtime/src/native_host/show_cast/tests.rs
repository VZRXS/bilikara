use super::*;
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

fn add_programme(root: &Path, id: &str, name: &str, video: &Path, audio: &Path) {
    let result = |input: Value| {
        let reply = execute_app_state(serde_json::from_value(input).unwrap());
        assert!(reply.error().is_none(), "{:?}", reply.error());
        reply
    };
    let item = json!({
        "id":id,"original_url":"https://www.bilibili.com/video/BV1z84y1p7oS",
        "resolved_url":"https://www.bilibili.com/video/BV1z84y1p7oS?p=1",
        "bvid":"BV1z84y1p7oS","aid":1,"cid":2,"page":1,"video_page":1,
        "title":format!("Song {id}"),"part_title":"Original",
        "display_title":format!("Song {id}"),"cover_url":"","embed_url":"",
        "selected_pages":[1],"selected_cids":[2],"selected_durations":[4],
        "selected_parts":["Original"],"available_pages":[1],"available_cids":[2],
        "available_durations":[4],"available_parts":["Original"],
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
    std::fs::create_dir_all(&artifact).unwrap();
    std::fs::copy(video, artifact.join("video.mp4")).unwrap();
    std::fs::copy(audio, artifact.join("audio.m4a")).unwrap();
    result(json!({
        "schema_version":1,"command":"apply_cache_event","item_id":id,
        "cache_attempt_token":reserved["cache_attempt_token"], "now":3.0,
        "event":{"kind":"ready","message":"Ready",
            "item_incarnation_id":reserved["item_incarnation_id"],
            "artifact_set_id":reserved["artifact_set_id"],"artifact_relative_directory":relative,
            "video_relative_path":format!("{relative}/video.mp4"),
            "video_media_url":format!("/media/{relative}/video.mp4"),
            "audio_variants":[{"id":"p1_original","label":"Original","page":1,
                "audio_url":format!("/media/{relative}/audio.m4a")}],
            "selected_audio_variant_id":"p1_original"
        }
    }));
}

#[test]
#[ignore = "requires a real Windows Show DLL, Host executable, and short H.264/AAC fixtures"]
fn show_cast_real_dll_advances_over_the_same_http_connection() {
    let required = |name| {
        PathBuf::from(std::env::var_os(name).expect(name))
            .canonicalize()
            .unwrap()
    };
    let executable = required("BILIKARA_TEST_SHOW_HOST_EXE");
    let dll = required("BILIKARA_TEST_SHOW_DLL");
    let video = required("BILIKARA_TEST_SHOW_VIDEO");
    let audio = required("BILIKARA_TEST_SHOW_AUDIO");
    let _global = crate::app_state::native_session::GLOBAL_APP_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    execute_app_state(AppStateRequest::Shutdown { schema_version: 1 });
    let directory = std::env::temp_dir()
        .canonicalize()
        .unwrap()
        .join(format!("bilikara-show-test-{}", token().unwrap()));
    std::fs::create_dir(&directory).unwrap();
    let _cleanup = FixtureDirectory(directory.clone());
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
    add_programme(&cache_root, "alpha", "Alice", &video, &audio);
    add_programme(&cache_root, "beta", "Bob", &video, &audio);
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
    let mut native = ShowHostProcess::with_executable(&executable, &dll).unwrap();
    let port = native.start_stream().unwrap();
    assert_eq!(native.served_streams().unwrap(), 0);
    let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(6)))
        .unwrap();
    stream
        .write_all(b"GET /cast/stage.ts HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
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
    let renderer = Renderer {
        id: "fixture".into(),
        name: "Fixture reader".into(),
        location: String::new(),
        av_transport_url: String::new(),
        av_transport_type: String::new(),
        local_address: Ipv4Addr::LOCALHOST,
    };
    let mut active = Active::new(native, SessionFiles::new(&context).unwrap(), renderer, None);
    let pid = active.native.id();
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
            active.native.status()
        );
        thread::sleep(Duration::from_millis(60));
    };
    assert!(second > first);
    assert!(received > 188 * 100);
    assert_eq!(active.native.port().unwrap(), port);
    assert_eq!(active.native.id(), pid);
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
    assert_eq!(active.native.status().unwrap().state, 2);
    active.native.close().unwrap();
    with_app(|app| {
        app.native_return_cast_playback()?;
        let snapshot = app.native_snapshot(true)?;
        assert_ne!(snapshot["cast_active"], true);
        assert_eq!(snapshot["show_cast"]["resume"]["item_id"], "beta");
        assert_eq!(snapshot["show_cast"]["resume"]["was_playing"], false);
        Ok(())
    })
    .unwrap();
}
