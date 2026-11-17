//! Actual loopback SOAP and HTTP reads with T3's trusted companion.
use super::*;
use crate::app_state::{AppStateRequest, native_session::GLOBAL_APP_TEST_LOCK};
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::Mutex,
    time::Instant,
};

struct ReceiverState {
    fault_on: Option<&'static str>,
    http_error_on: Option<&'static str>,
    hang_on: Option<&'static str>,
    no_pull: bool,
    clients: usize,
    different_peer: bool,
    synchronize_pulls: bool,
    reject_files: bool,
    file_uri: bool,
    state: &'static str,
    position: u64,
    duration: u64,
    offline: bool,
    hang: bool,
    response_delay: Duration,
    completed: Vec<String>,
    no_position: bool,
    unsupported: bool,
    actions: Vec<String>,
    uri: Option<String>,
    releases: usize,
    bytes: u64,
}
struct Receiver {
    address: std::net::SocketAddr,
    state: Arc<Mutex<ReceiverState>>,
    stop: Arc<AtomicBool>,
    release_ready: Arc<AtomicBool>,
    release_hold: Arc<AtomicBool>,
    query_hold: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}
fn field<'a>(s: &'a str, name: &str) -> Option<&'a str> {
    s.split_once(&format!("<{name}>"))?
        .1
        .split_once(&format!("</{name}>"))
        .map(|v| v.0)
}
fn time(v: u64) -> String {
    format!("{:02}:{:02}:{:02}", v / 3600, v / 60 % 60, v % 60)
}
impl Receiver {
    fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let state = Arc::new(Mutex::new(ReceiverState {
            fault_on: None,
            http_error_on: None,
            hang_on: None,
            no_pull: false,
            clients: 1,
            different_peer: false,
            synchronize_pulls: false,
            reject_files: false,
            file_uri: false,
            state: "PLAYING",
            position: 12,
            duration: 120,
            offline: false,
            hang: false,
            response_delay: Duration::ZERO,
            completed: Vec::new(),
            no_position: false,
            unsupported: false,
            actions: Vec::new(),
            uri: None,
            releases: 0,
            bytes: 0,
        }));
        let stop = Arc::new(AtomicBool::new(false));
        let release_ready = Arc::new(AtomicBool::new(false));
        let release_hold = Arc::new(AtomicBool::new(false));
        let query_hold = Arc::new(AtomicBool::new(false));
        let holding_query = query_hold.clone();
        let releasing = release_ready.clone();
        let holding_release = release_hold.clone();
        let stopping = stop.clone();
        let shared = state.clone();
        let worker = thread::spawn(move || {
            let mut pulls = Vec::new();
            let mut hung = Vec::new();
            while !stopping.load(Ordering::Acquire) {
                let Ok((mut stream, _)) = listener.accept() else {
                    thread::sleep(Duration::from_millis(5));
                    continue;
                };
                // Winsock can inherit the nonblocking listener mode. A partial
                // request must wait for its body instead of returning a bogus
                // description and resetting a concurrent revoke/transport call.
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut data = Vec::new();
                let mut buf = [0u8; 4096];
                while let Ok(n) = stream.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    data.extend_from_slice(&buf[..n]);
                    if let Some(end) = data.windows(4).position(|v| v == b"\r\n\r\n") {
                        let header = String::from_utf8_lossy(&data[..end]).to_ascii_lowercase();
                        let length = header
                            .lines()
                            .find_map(|l| {
                                l.strip_prefix("content-length:")?
                                    .trim()
                                    .parse::<usize>()
                                    .ok()
                            })
                            .unwrap_or(0);
                        if data.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                let raw = String::from_utf8_lossy(&data);
                let action = raw
                    .lines()
                    .find(|l| l.to_ascii_lowercase().starts_with("soapaction:"))
                    .and_then(|l| l.rsplit_once('#'))
                    .map(|(_, a)| a.trim_matches(['"', '\r', ' ']).to_owned());
                let mut state = shared.lock().unwrap();
                let delay = if action.is_some() {
                    state.response_delay
                } else {
                    Duration::ZERO
                };
                let completed_action = action.clone();
                let (status, body) = if let Some(action) = action {
                    state.actions.push(action.clone());
                    while action == "GetProtocolInfo"
                        && holding_query.load(Ordering::Acquire)
                        && !stopping.load(Ordering::Acquire)
                    {
                        thread::sleep(Duration::from_millis(1));
                    }
                    if action == "SetAVTransportURI" {
                        let uri = field(&raw, "CurrentURI").map(str::to_owned);
                        if uri != state.uri {
                            state.file_uri = raw.contains("size=");
                            state.uri = uri;
                        }
                    }
                    if state.fault_on == Some(action.as_str())
                        && !(action == "SetDeviceAuthorization"
                            && field(&raw, "Enable") == Some("0"))
                        || (action == "SetAVTransportURI" && state.reject_files && state.file_uri)
                    {
                        let body = "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body><s:Fault><detail><UPnPError><errorCode>714</errorCode></UPnPError></detail></s:Fault></s:Body></s:Envelope>";
                        let _ = write!(
                            stream,
                            "HTTP/1.1 500 Error\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        );
                        continue;
                    }
                    if state.http_error_on == Some(action.as_str()) {
                        let _ = write!(
                            stream,
                            "HTTP/1.1 500 Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                        );
                        continue;
                    }
                    if state.hang || state.hang_on == Some(action.as_str()) {
                        hung.push(stream);
                        continue;
                    }
                    if state.offline {
                        continue;
                    }
                    let fields = match action.as_str() {
                        "GetProtocolInfo" => {
                            "<Source></Source><Sink>http-get:*:video/MP2T:*</Sink>".to_owned()
                        }
                        "SetAVTransportURI" => {
                            state.uri = field(&raw, "CurrentURI").map(|s| s.replace("&amp;", "&"));
                            state.position = 0;
                            String::new()
                        }
                        "Play" => {
                            state.state = "PLAYING";
                            if let Some(uri) = state.uri.clone().filter(|_| !state.no_pull) {
                                let client = reqwest::blocking::Client::builder()
                                    .no_proxy()
                                    .local_address(state.different_peer.then_some(
                                        std::net::IpAddr::V4(std::net::Ipv4Addr::new(127, 0, 0, 2)),
                                    ))
                                    .timeout(Duration::from_secs(30))
                                    .build()
                                    .unwrap();
                                let mut release_reads = Vec::new();
                                for _ in 0..state.clients {
                                    let uri = uri.clone();
                                    let client = client.clone();
                                    let shared = shared.clone();
                                    let synchronize = state.synchronize_pulls;
                                    let (ready, received) = std::sync::mpsc::channel();
                                    let (release, read) = std::sync::mpsc::channel();
                                    pulls.push(thread::spawn(move || {
                                        let response = client.get(uri).send();
                                        if synchronize {
                                            // A successful response header is the endpoint's
                                            // acknowledgement of this GET, not merely an attempt.
                                            let _ = ready.send(
                                                response
                                                    .as_ref()
                                                    .map(|r| r.status())
                                                    .map_err(ToString::to_string),
                                            );
                                            if read.recv_timeout(Duration::from_secs(30)).is_err() {
                                                return;
                                            }
                                        }
                                        if let Ok(mut response) = response {
                                            if !response.status().is_success() {
                                                return;
                                            } // superseded URI
                                            let mut data = [0u8; 8192];
                                            while let Ok(n) = response.read(&mut data) {
                                                if n == 0 {
                                                    break;
                                                }
                                                shared.lock().unwrap().bytes += n as u64;
                                            }
                                        }
                                    }));
                                    if synchronize {
                                        let status = received
                                            .recv_timeout(Duration::from_secs(30))
                                            .expect("endpoint must acknowledge each GET")
                                            .expect("loopback GET must reach the endpoint");
                                        assert!(status.is_success(), "loopback GET: {status}");
                                        // Keep earlier readers open until the Nth GET is admitted.
                                        // In particular the fifth GET must evict an active reader.
                                        release_reads.push(release);
                                    }
                                }
                                for release in release_reads {
                                    let _ = release.send(());
                                }
                            }
                            String::new()
                        }
                        "Pause" => {
                            state.state = "PAUSED_PLAYBACK";
                            String::new()
                        }
                        "Stop" => {
                            state.state = "STOPPED";
                            String::new()
                        }
                        "Seek" => {
                            let target = field(&raw, "Target").unwrap();
                            state.position = target
                                .split(':')
                                .fold(0.0, |v, p| v * 60.0 + p.parse::<f64>().unwrap())
                                as u64;
                            String::new()
                        }
                        "GetTransportInfo" => format!(
                            "<CurrentTransportState>{}</CurrentTransportState><CurrentTransportStatus>OK</CurrentTransportStatus><CurrentSpeed>1</CurrentSpeed>",
                            state.state
                        ),
                        "GetPositionInfo" => format!(
                            "<Track>1</Track><TrackDuration>{}</TrackDuration><RelTime>{}</RelTime>",
                            if state.no_position {
                                "NOT_IMPLEMENTED".into()
                            } else {
                                time(state.duration)
                            },
                            if state.no_position {
                                "NOT_IMPLEMENTED".into()
                            } else {
                                time(state.position)
                            }
                        ),
                        "SetDeviceAuthorization" => {
                            if field(&raw, "Enable") == Some("0") {
                                state.releases += 1;
                                releasing.store(true, Ordering::Release);
                                while holding_release.load(Ordering::Acquire)
                                    && !stopping.load(Ordering::Acquire)
                                {
                                    thread::sleep(Duration::from_millis(1));
                                }
                                thread::sleep(Duration::from_millis(200));
                            }
                            String::new()
                        }
                        _ => String::new(),
                    };
                    if state.unsupported
                        && matches!(action.as_str(), "GetTransportInfo" | "GetPositionInfo")
                    {
                        (500,"<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body><s:Fault><detail><UPnPError xmlns=\"urn:schemas-upnp-org:control-1-0\"><errorCode>401</errorCode></UPnPError></detail></s:Fault></s:Body></s:Envelope>".to_owned())
                    } else {
                        (
                            200,
                            format!(
                                "<?xml version=\"1.0\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body><u:{action}Response xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\">{fields}</u:{action}Response></s:Body></s:Envelope>"
                            ),
                        )
                    }
                } else {
                    (200,"<root><device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType><friendlyName>Fixture TV</friendlyName><UDN>uuid:cast-fixture</UDN><serviceList><service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/av</controlURL></service><service><serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType><controlURL>/cm</controlURL></service></serviceList></device></root>".to_owned())
                };
                drop(state);
                let response = format!(
                    "HTTP/1.1 {status} OK\r\nContent-Length: {}\r\nContent-Type: text/xml\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let shared = shared.clone();
                let respond = move || {
                    if !delay.is_zero() {
                        thread::sleep(delay);
                    }
                    if stream.write_all(response.as_bytes()).is_ok()
                        && let Some(action) = completed_action
                    {
                        shared.lock().unwrap().completed.push(action);
                    }
                };
                if delay.is_zero() {
                    respond();
                } else {
                    pulls.push(thread::spawn(respond));
                }
            }
            for pull in pulls {
                pull.join().unwrap();
            }
        });
        Self {
            address,
            state,
            stop,
            release_ready,
            release_hold,
            query_hold,
            worker: Some(worker),
        }
    }
    fn renderer(&self) -> Renderer {
        let location = format!("http://{}/description", self.address);
        let description = reqwest::blocking::get(&location).unwrap().text().unwrap();
        crate::dlna::session_fixture::renderer(&location, &description)
    }
    fn qr(&self) -> String {
        use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
        let mut inner = url::Url::parse("https://conn.dolphinstar.cn/Remote").unwrap();
        inner
            .query_pairs_mut()
            .append_pair("url", &format!("http://{}/room", self.address))
            .append_pair("token", "test-secret-token")
            .append_pair("name", "Test Room")
            .append_pair("appid", "test-app");
        let mut outer = url::Url::parse("https://wx.chunk.cn/projection/login").unwrap();
        outer
            .query_pairs_mut()
            .append_pair("place_code", "test-place")
            .append_pair("bill_id", "test-bill")
            .append_pair("projection_url", &URL_SAFE_NO_PAD.encode(inner.as_str()));
        outer.into()
    }
}

#[path = "tests/android_output.rs"]
mod android_output;
impl Drop for Receiver {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        let _ = TcpStream::connect(self.address);
        let result = self.worker.take().unwrap().join();
        if !thread::panicking() {
            result.unwrap();
        }
    }
}

struct Host {
    context: Arc<HostContext>,
    identity: Identity,
}
impl Host {
    fn new() -> Self {
        Self::with_duration(120)
    }
    fn with_duration(duration: u64) -> Self {
        Self::with_initial_storage(duration, None)
    }
    fn with_storage(duration: u64, corrupt: bool) -> Self {
        Self::with_initial_storage(duration, Some(corrupt))
    }
    fn with_initial_storage(duration: u64, storage: Option<bool>) -> Self {
        crate::execute_app_state(AppStateRequest::Shutdown { schema_version: 1 });
        let directory = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join(".tmp")
            .join(format!("cast-session-{}", token().unwrap()));
        std::fs::create_dir_all(&directory).unwrap();
        let seed=serde_json::from_value(json!({"session_users":["Alice"],"session_started_at":1,"session_played_file":"session.json","updated_at":1})).unwrap();
        let initialized = if let Some(corrupt) = storage {
            if corrupt {
                std::fs::write(directory.join("cast-devices.json"), b"{broken").unwrap();
            }
            crate::app_state::initialize_native_host(&directory, seed)
        } else {
            crate::execute_app_state(AppStateRequest::Initialize {
                schema_version: 1,
                state: Box::new(seed),
            })
        };
        assert!(initialized.error().is_none());
        let context = Arc::new(HostContext {
            directory: directory.clone(),
            cache_root: directory.join("media"),
            assets: Arc::new(|_| None),
            stop: Arc::new(AtomicBool::new(false)),
            api_slots: Arc::new(Semaphore::new(1)),
            export_slots: Arc::new(Semaphore::new(1)),
            export_renderer: Default::default(),
            port: 0,
            desktop: false,
            bind_address: std::net::Ipv4Addr::LOCALHOST,
            allowed_hosts: Default::default(),
            bbdown: None,
            aria2: Mutex::new(None),
            aria2_prepare: Mutex::new(()),
            shutdown_token: None,
            desktop_installation: None,
            workers: Mutex::new(Vec::new()),
        });
        crate::app_state::with_cache_application(|app| {
            app.open_artifact_lifetime(&context.cache_root)
        })
        .unwrap()
        .unwrap();
        with_app(|app| {
            app.native().host_token = "fixture-host".into();
            Ok(())
        })
        .unwrap();
        let host = Self {
            context,
            identity: Identity {
                token: "fixture-host".into(),
                loopback: true,
                client: "fixture".into(),
            },
        };
        for id in ["song-one", "song-two", "song-three"] {
            host.song(id, duration);
        }
        host
    }
    fn song(&self, id: &str, duration: u64) {
        let item=serde_json::from_value(json!({"id":id,"original_url":"https://example.test/video","resolved_url":"https://example.test/video","bvid":id,"aid":1,"cid":2,"page":1,"title":id,"part_title":"P1","display_title":id,"cover_url":"","embed_url":"","selected_pages":[1],"selected_cids":[2],"selected_durations":[duration],"selected_parts":["P1"],"available_pages":[1],"available_cids":[2],"available_durations":[duration],"available_parts":["P1"]})).unwrap();
        assert!(
            crate::execute_app_state(AppStateRequest::AddItem {
                schema_version: 1,
                item,
                position: "tail".into(),
                requester_name: "Alice".into(),
                requester_user_id: None,
                reset_av_delay: false,
                allow_repeat: true,
                now: 2.0
            })
            .error()
            .is_none()
        );
        let snap = with_app(|app| app.native_core_snapshot()).unwrap();
        let item = snap
            .current_item
            .iter()
            .chain(&snap.playlist)
            .find(|i| i.id == id)
            .unwrap();
        let r = crate::app_state::begin_cache_attempt_for_runtime(id, &item.item_incarnation_id)
            .unwrap();
        let dir = self.context.cache_root.join(&r.artifact_relative_directory);
        std::fs::create_dir_all(&dir).unwrap();
        let fixtures = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("tests/fixtures/bbdown");
        for file in ["video.mp4", "audio.m4a"] {
            std::fs::copy(
                fixtures.join(if file == "video.mp4" {
                    "video-reordered-start.mp4"
                } else {
                    file
                }),
                dir.join(file),
            )
            .unwrap();
        }
        let relative = &r.artifact_relative_directory;
        let event=serde_json::from_value(json!({"kind":"ready","message":"ready","video_relative_path":format!("{relative}/video.mp4"),"video_media_url":format!("/media/{relative}/video.mp4"),"audio_variants":[{"id":"p1","page":1,"label":"P1","audio_url":format!("/media/{relative}/audio.m4a")}],"selected_audio_variant_id":"p1","item_incarnation_id":r.item_incarnation_id,"artifact_set_id":r.artifact_set_id,"artifact_relative_directory":relative})).unwrap();
        assert!(
            crate::execute_app_state(AppStateRequest::ApplyCacheEvent {
                schema_version: 1,
                item_id: id.into(),
                cache_attempt_token: r.cache_attempt_token,
                event,
                now: 3.0
            })
            .error()
            .is_none()
        );
    }
    fn post(&self, path: &str, body: Value) -> Result<Value, ApiError> {
        api::dispatch(
            &self.context,
            &self.identity,
            true,
            &Method::POST,
            path,
            "",
            body,
        )
    }
    fn snapshot(&self) -> Value {
        with_app(|app| app.native_snapshot(true)).unwrap()
    }
    fn use_long_media(&self) {
        // The short upstream fixture ends around 1s. A live pause under CPU
        // load can legitimately resume later; use actual 30s media, not a
        // fictitious duration or a longer assertion deadline.
        let snapshot = with_app(|app| app.native_core_snapshot()).unwrap();
        let fixtures =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("src/native_host/cast_session/fixtures");
        for item in snapshot.current_item.iter().chain(&snapshot.playlist) {
            let video = self
                .context
                .cache_root
                .join(item.video_media_url.strip_prefix("/media/").unwrap());
            std::fs::copy(fixtures.join("keyframes-30s.mp4"), &video).unwrap();
            std::fs::copy(
                fixtures.join("audio-30s.m4a"),
                video.with_file_name("audio.m4a"),
            )
            .unwrap();
        }
    }
    fn wait(&self, predicate: impl Fn(&Value) -> bool) -> Value {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let snap = self.snapshot();
            if predicate(&snap) {
                return snap;
            }
            assert!(
                Instant::now() < deadline,
                "cast={} current={} generation={}",
                snap["cast"],
                snap["current_item"]["id"],
                snap["playback_generation"]
            );
            thread::sleep(Duration::from_millis(20));
        }
    }
    fn connect(&self, renderer: Renderer) {
        let key = renderer_key(&renderer);
        with_app(|app| {
            app.native().cast.renderers = vec![renderer];
            Ok(())
        })
        .unwrap();
        self.post("/api/cast/connect", json!({"device_key":key}))
            .unwrap();
        self.wait(|s| s["cast"]["phase"] == "active");
    }
    fn command(&self, action: &str) -> Value {
        let generation = self.snapshot()["playback_generation"].clone();
        self.post(
            "/api/cast/command",
            json!({"action":action,"playback_generation":generation}),
        )
        .unwrap();
        self.wait(|s| s["cast"]["busy"] == false)
    }
}
impl Drop for Host {
    fn drop(&mut self) {
        self.context.stop.store(true, Ordering::Release);
        let workers = std::mem::take(&mut *self.context.workers.lock().unwrap());
        for worker in workers {
            worker.join().unwrap();
        }
        crate::execute_app_state(AppStateRequest::Shutdown { schema_version: 1 });
        std::fs::remove_dir_all(&self.context.directory).unwrap();
    }
}

#[test]
fn cancelling_discovery_does_not_issue_a_local_resume() {
    let _serial = GLOBAL_APP_TEST_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let host = Host::new();
    host.post(
        "/api/cast/discover",
        json!({"description_url":"http://192.168.254.254/description"}),
    )
    .unwrap();
    host.post("/api/cast/disconnect", json!({})).unwrap();
    let snap = host.wait(|s| s["cast"]["phase"] == "idle" && s["cast"]["busy"] == false);
    assert_eq!(snap["cast"]["owns_playback"], false);
    assert!(snap["cast"]["resume"].is_null());
}

#[test]
fn platform_callback_fences_old_output() {
    let _serial = GLOBAL_APP_TEST_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let host = Host::new();
    with_app(|app| {
        let cast = &mut app.native().cast;
        cast.operation = 1;
        cast.platform_output_id = Some(12);
        cast.owns_playback = true;
        cast.phase = Phase::Active;
        Ok(())
    })
    .unwrap();
    platform_stopped(11, 1);
    platform_stopped(12, 99);
    assert_eq!(host.snapshot()["cast"]["phase"], "active");
    let previous_cancel = with_app(|app| Ok(app.native().cast.cancel.clone())).unwrap();
    platform_stopped(12, 1);
    with_app(|app| {
        let cast = &mut app.native().cast;
        assert!(previous_cancel.is_cancelled());
        assert!(!cast.cancel.is_cancelled());
        assert!(matches!(cast.pending, Some(Request::Disconnect)));
        cast.pending = None;
        Ok(())
    })
    .unwrap();
    worker::restore(2, None);
    assert_eq!(host.snapshot()["cast"]["owns_playback"], false);
    assert_eq!(host.snapshot()["cast"]["local_media"], "host");
    with_app(|app| {
        let cast = &mut app.native().cast;
        cast.platform_output_id = Some(14);
        Ok(())
    })
    .unwrap();
    platform_stopped(14, 3);
    worker::restore(2, None); // Superseded connection finishes before disconnect.
    with_app(|app| {
        assert_eq!(
            app.native().cast.platform_stop_error,
            Some("cast_platform_unavailable")
        );
        app.native().cast.pending = None;
        Ok(())
    })
    .unwrap();
    worker::restore(3, None);
    assert_eq!(
        host.snapshot()["cast"]["error_code"],
        "cast_platform_unavailable"
    );
}

#[test]
#[ignore = "requires trusted BILIKARA_TEST_CAST_COMPANION; real T3 mux + loopback receiver"]
fn receiver_lifecycle_pause_seek_next_natural_end_disconnect_and_cancellation() {
    let _serial = GLOBAL_APP_TEST_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let receiver = Receiver::new();
    let host = Host::new();
    assert!(host.snapshot().get("cast").is_none());
    host.connect(receiver.renderer());
    host.wait(|s| s["cast"]["duration"] == 120.0);
    receiver.state.lock().unwrap().state = "PAUSED_PLAYBACK";
    host.wait(|s| s["cast"]["is_paused"] == true);
    host.command("play");
    assert_eq!(
        host.snapshot()["cast"]["local_media"],
        "retain_paused_muted"
    );
    assert_eq!(
        host.command("pause")["cast"]["is_paused"],
        true,
        "{}",
        host.snapshot()["cast"]
    );
    assert_eq!(host.command("play")["cast"]["is_paused"], false);
    let generation = host.snapshot()["playback_generation"].clone();
    host.post(
        "/api/cast/command",
        json!({"action":"seek-relative","delta_seconds":15,"playback_generation":generation}),
    )
    .unwrap();
    host.wait(|s| s["cast"]["busy"] == false);
    assert_eq!(receiver.state.lock().unwrap().position, 15);
    // The app selects the next item before the worker replaces the output; the
    // previous output stays "active" (with the same duration) until
    // start_output bumps the output generation. Wait for the new output,
    // otherwise its SetAVTransportURI can reset receiver state set below.
    let established = |previous: u64| {
        move |s: &Value| {
            s["cast"]["generation"].as_u64().unwrap() > previous
                && s["cast"]["phase"] == "active"
                && s["cast"]["duration"] == 120.0
        }
    };
    let first = host.snapshot()["cast"]["generation"].as_u64().unwrap();
    assert_eq!(host.command("next")["current_item"]["id"], "song-two");
    let second = host.wait(established(first))["cast"]["generation"]
        .as_u64()
        .unwrap();
    {
        let mut s = receiver.state.lock().unwrap();
        s.position = 119;
        s.state = "STOPPED";
    }
    let third = host.wait(established(second));
    assert_eq!(third["current_item"]["id"], "song-three");
    receiver.state.lock().unwrap().position = 37;
    host.wait(|s| s["cast"]["position"] == 37.0);
    let began = Instant::now();
    host.post("/api/cast/disconnect", json!({})).unwrap();
    let state = host.wait(|s| s["cast"]["phase"] == "idle" && s["cast"]["busy"] == false);
    assert!(began.elapsed() < Duration::from_secs(3));
    assert_eq!(state["cast"]["resume"]["position"], 37.0);
    assert_eq!(state["cast"]["owns_playback"], false);
    let (actions, uri) = {
        let s = receiver.state.lock().unwrap();
        assert!(s.bytes > 0);
        (s.actions.len(), s.uri.clone().unwrap())
    };
    thread::sleep(Duration::from_millis(2200));
    assert_eq!(receiver.state.lock().unwrap().actions.len(), actions);
    assert!(reqwest::blocking::get(uri).is_err());
    let report = api::dispatch(
        &host.context,
        &host.identity,
        true,
        &Method::GET,
        "/api/cast/report",
        "",
        json!({}),
    )
    .unwrap();
    assert!(!report.to_string().contains("127.0.0.1"));
}

#[test]
#[ignore = "requires trusted BILIKARA_TEST_CAST_COMPANION; real T3 mux + loopback receiver"]
fn receiver_failures_recover_to_local_and_unsupported_monitors_keep_session() {
    let _serial = GLOBAL_APP_TEST_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let receiver = Receiver::new();
    let host = Host::new();
    host.connect(receiver.renderer());
    receiver.state.lock().unwrap().position = 24;
    host.wait(|s| s["cast"]["position"] == 24.0);
    receiver.state.lock().unwrap().offline = true;
    host.wait(|s| s["cast"]["phase"] == "recovering");
    let snap = host.wait(|s| s["cast"]["phase"] == "idle");
    assert_eq!(snap["cast"]["resume"]["position"], 24.0);
    assert_eq!(snap["cast"]["error_code"], "cast_receiver_unreachable");
    {
        let mut s = receiver.state.lock().unwrap();
        s.offline = false;
        s.unsupported = true;
    }
    host.connect(receiver.renderer());
    thread::sleep(Duration::from_millis(4300));
    assert_eq!(host.snapshot()["cast"]["phase"], "active");
}

#[test]
#[ignore = "requires trusted BILIKARA_TEST_CAST_COMPANION; T9 loopback room"]
fn purek_disconnect_and_replacement_await_enable_zero() {
    let _serial = GLOBAL_APP_TEST_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let receiver = Receiver::new();
    let host = Host::new();
    let qr = receiver.qr();
    host.post("/api/cast/connect", json!({"purek_qr":qr}))
        .unwrap();
    host.wait(|s| s["cast"]["phase"] == "active");
    host.post("/api/cast/connect", json!({"purek_qr":qr}))
        .unwrap();
    host.wait(|s| s["cast"]["phase"] == "active" && s["cast"]["operation_id"] == 2);
    assert_eq!(receiver.state.lock().unwrap().releases, 1);
    let releasing = Instant::now();
    host.post("/api/cast/disconnect", json!({})).unwrap();
    host.wait(|s| s["cast"]["phase"] == "idle" && s["cast"]["busy"] == false);
    // Capture before taking the room's mutex: its delayed HTTP response holds
    // that mutex, which must not accidentally satisfy this timing assertion.
    let until_idle = releasing.elapsed();
    let (releases, actions) = {
        let s = receiver.state.lock().unwrap();
        (s.releases, s.actions.clone())
    };
    assert_eq!(
        releases,
        2,
        "state={} actions={actions:?} report={}",
        host.snapshot()["cast"],
        api::dispatch(
            &host.context,
            &host.identity,
            true,
            &Method::GET,
            "/api/cast/report",
            "",
            json!({})
        )
        .unwrap()
    );
    assert!(
        until_idle >= Duration::from_millis(200),
        "Idle must await Enable=0 response"
    );
}

#[test]
fn api_device_revision_permissions_busy_and_live_seek_rejection() {
    let _serial = GLOBAL_APP_TEST_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let host = Host::new();
    let receiver = Receiver::new();
    let renderer = receiver.renderer();
    let key = renderer_key(&renderer);
    with_app(|app| {
        app.native().cast.renderers.push(renderer);
        Ok(())
    })
    .unwrap();
    let revision = host.snapshot()["revision"].clone();
    let request = json!({"command":"cast.set_device_mode","device_key":key,"revision":revision,"mode":"live"});
    let remote = Identity {
        token: "unknown".into(),
        loopback: false,
        client: "remote".into(),
    };
    assert_eq!(
        api::dispatch(
            &host.context,
            &remote,
            false,
            &Method::POST,
            "/api/cast/command",
            "",
            request.clone()
        )
        .unwrap_err()
        .code,
        "forbidden"
    );
    let result = host.post("/api/cast/command", request.clone()).unwrap();
    assert_eq!(result["cast"]["devices"][&key]["mode"], "live");
    assert_eq!(
        host.post("/api/cast/command", request).unwrap_err().code,
        "cast_revision_conflict"
    );
    with_app(|app| {
        let state = &mut app.native().cast;
        state.phase = Phase::Active;
        state.owns_playback = true;
        state.mode = Mode::Live;
        state.operation = 1;
        Ok(())
    })
    .unwrap();
    let generation = host.snapshot()["playback_generation"].clone();
    assert_eq!(
        host.post(
            "/api/cast/command",
            json!({"action":"seek-relative","delta_seconds":15,"playback_generation":generation})
        )
        .unwrap_err()
        .code,
        "cast_seek_unsupported"
    );
    host.post(
        "/api/cast/command",
        json!({"action":"pause","playback_generation":generation}),
    )
    .unwrap();
    assert_eq!(
        host.post(
            "/api/cast/command",
            json!({"action":"play","playback_generation":generation})
        )
        .unwrap_err()
        .code,
        "cast_busy"
    );
    assert_eq!(
        host.post("/api/player/key-shift", json!({"key_shift":2}))
            .unwrap_err()
            .code,
        "cast_setting_unavailable"
    );
    assert_eq!(
        host.post(
            "/api/player/av-delay-action",
            json!({"type":"adjust","delta_ms":20})
        )
        .unwrap_err()
        .code,
        "cast_setting_unavailable"
    );
}

#[test]
#[ignore = "requires trusted BILIKARA_TEST_CAST_COMPANION; actual live producer and HTTP endpoint"]
fn learned_live_mode_pause_resume_mode_switch_and_connect_cancellation() {
    let _serial = GLOBAL_APP_TEST_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let receiver = Receiver::new();
    let host = Host::new();
    host.use_long_media();
    let renderer = receiver.renderer();
    let key = renderer_key(&renderer);
    with_app(|app| {
        app.native().cast.renderers.push(renderer.clone());
        Ok(())
    })
    .unwrap();
    host.post("/api/cast/command",json!({"command":"cast.set_device_learning","device_key":key,"revision":host.snapshot()["revision"],"learned_mode":"live","learned_variant":"original"})).unwrap();
    host.connect(renderer.clone());
    assert_eq!(host.snapshot()["cast"]["effective_mode"], "live");
    host.wait(|_| receiver.state.lock().unwrap().bytes > 0);
    let first = host.snapshot()["cast"]["generation"].as_u64().unwrap();
    assert_eq!(host.command("pause")["cast"]["is_paused"], true);
    host.command("play");
    assert!(host.snapshot()["cast"]["generation"].as_u64().unwrap() > first);
    host.command("pause");
    host.post("/api/cast/command",json!({"command":"cast.set_device_mode","device_key":key,"revision":host.snapshot()["revision"],"mode":"file"})).unwrap();
    let snap = host.wait(|s| {
        s["cast"]["effective_mode"] == "file"
            && s["cast"]["busy"] == false
            && s["cast"]["is_paused"] == true
    });
    assert_eq!(
        snap["cast"]["learned_mode"], "live",
        "manual choice must not erase learned preference"
    );
    host.post("/api/cast/disconnect", json!({})).unwrap();
    host.wait(|s| s["cast"]["phase"] == "idle" && s["cast"]["busy"] == false);
    let began = Instant::now();
    host.post("/api/cast/connect", json!({"device_key":key}))
        .unwrap();
    host.post("/api/cast/disconnect", json!({})).unwrap();
    host.wait(|s| s["cast"]["phase"] == "idle" && s["cast"]["busy"] == false);
    assert!(began.elapsed() < Duration::from_secs(3));
    let count = receiver.state.lock().unwrap().actions.len();
    thread::sleep(Duration::from_millis(2200));
    assert_eq!(receiver.state.lock().unwrap().actions.len(), count);
}

#[path = "platform_tests.rs"]
mod platform_tests;
#[path = "tests_round1.rs"]
mod round1;
