#[path = "support/image_decoder.rs"]
mod decoder;
#[path = "support/runtime_service.rs"]
mod service;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

struct Fixture {
    base: String,
    data: PathBuf,
    client: reqwest::blocking::Client,
}
impl Fixture {
    fn control(&self, query: &str) -> Value {
        self.client
            .get(format!("{}/fixture/{query}", self.base))
            .send()
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .unwrap()
    }
    fn login(&self, command: &str, mut fields: Value) -> Value {
        fields["command"] = json!(command);
        if command != "take_success" && command != "download_access" {
            fields["data_path"] = json!(self.data);
        }
        service::execute("desktop_login", fields)
    }
    fn start(&self) -> u64 {
        self.login("start", json!({"force":true}))["generation"]
            .as_u64()
            .unwrap()
    }
    fn reset(&self, query: &str) {
        println!("login scenario: {query}");
        self.login("logout", json!({}));
        self.control(&format!("control?{query}"));
    }
    fn state(&self) -> Value {
        self.login("snapshot", json!({}))
    }
    fn wait(&self, check: impl Fn() -> bool) {
        let limit = Instant::now() + Duration::from_secs(12);
        while !check() {
            assert!(Instant::now() < limit, "real service fixture deadline");
            thread::sleep(Duration::from_millis(10));
        }
    }
    fn worker(&self, generation: u64) -> Worker {
        let data = self.data.clone();
        let (sender, receiver) = mpsc::channel();
        let handle = thread::spawn(move || {
            let response = service::execute(
                "desktop_login",
                json!({"command":"run","data_path":data,"generation":generation}),
            );
            sender.send(response).unwrap();
        });
        Worker { handle, receiver }
    }
    fn run(&self, generation: u64) -> Value {
        self.worker(generation).finish()
    }
    fn notify(&self, generation: u64) -> bool {
        self.login("take_success", json!({"generation":generation}))["notify"]
            .as_bool()
            .unwrap()
    }
}
struct Worker {
    handle: thread::JoinHandle<()>,
    receiver: mpsc::Receiver<Value>,
}
impl Worker {
    fn finish(self) -> Value {
        let value = self
            .receiver
            .recv_timeout(Duration::from_secs(16))
            .expect("login worker must finish");
        self.handle.join().unwrap();
        value
    }
}
fn private(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    assert!(path.is_file());
}

#[test]
#[ignore = "requires isolated local TLS fixture and synthetic login data; no external account"]
fn shared_desktop_login_publication_and_generation_contract() {
    let home = PathBuf::from(
        std::env::var_os("BILIKARA_TEST_LOGIN_HOME").expect("required isolated login home"),
    );
    let base = std::env::var("BILIKARA_TEST_LOGIN_FIXTURE").expect("required local fixture");
    assert!(base.starts_with("http://127.0.0.1:"));
    let fixture = Fixture {
        base,
        data: home.join("bbdown/BBDown.data"),
        client: reqwest::blocking::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap(),
    };
    let qr = fixture.data.with_file_name("qrcode.png");
    fs::create_dir_all(fixture.data.parent().unwrap()).unwrap();
    for payload in [
        "https://passport.bilibili.com/synthetic-login?token=SYNTHETIC-ONLY%2B123#qr",
        "https://passport.bilibili.com/scan?name=カラオケ🎤",
    ] {
        fixture.reset(&format!(
            "mode=success&hold=poll&payload={}",
            url::form_urlencoded::byte_serialize(payload.as_bytes()).collect::<String>()
        ));
        let generation = fixture.start();
        let worker = fixture.worker(generation);
        fixture.wait(|| fixture.state()["state"] == "waiting");
        let image = fs::read(&qr).unwrap();
        private(&qr);
        assert_eq!(
            image,
            STANDARD
                .decode(
                    fixture.state()["qr_image"]
                        .as_str()
                        .unwrap()
                        .split_once(',')
                        .unwrap()
                        .1
                )
                .unwrap()
        );
        let pixels = decoder::Pixels::png(&image);
        assert_eq!(pixels.depth, png::BitDepth::One);
        assert_eq!(pixels.color, png::ColorType::Grayscale);
        assert_eq!(pixels.width, pixels.height);
        pixels.decode(0, 0, pixels.width, pixels.height, 0, payload);
        assert_eq!(
            fixture.login("start", json!({"force":false}))["generation"],
            Value::Null
        );
        fixture.login("cancel", json!({}));
        fixture.control("release");
        worker.finish();
        assert!(!qr.exists());
        assert!(!fixture.data.exists());
        assert!(!fixture.notify(generation));
        fixture.login("cancel", json!({}));
    }
    fixture.reset("mode=success");
    assert_eq!(
        fixture.login("download_access", json!({"source":"bbdown","cookie":""}))["message"],
        Value::Null
    );
    assert!(
        fixture.login("download_access", json!({"source":"downkyi","cookie":""}))["message"]
            .as_str()
            .unwrap()
            .contains("需要登录")
    );
    let generation = fixture.start();
    let diagnostics = fixture.run(generation);
    assert_eq!(
        fixture.control("stats")["stages"],
        json!(["generate", "poll"])
    );
    assert_eq!(
        fixture.state(),
        json!({"logged_in":true,"state":"logged_in","message":"BBDown 已登录","data_path":fixture.data,"qr_image":""})
    );
    private(&fixture.data);
    let cookie = fs::read_to_string(&fixture.data).unwrap();
    assert!(cookie.contains("b_nut=synthetic-nut"));
    assert_eq!(
        fixture.login(
            "read_cookie",
            json!({"configured_cookie":"configured=retained"})
        )["cookie"],
        cookie
    );
    for source in ["bbdown", "downkyi"] {
        assert_eq!(
            fixture.login("download_access", json!({"source":source,"cookie":cookie}))["message"],
            Value::Null
        );
    }
    assert!(fixture.notify(generation));
    assert!(!fixture.notify(generation));
    fixture.run(generation);
    assert_eq!(
        fixture.control("stats")["stages"],
        json!(["generate", "poll"])
    );
    assert!(!qr.exists());
    assert!(!fixture.data.with_file_name("bilibili-login.json").exists());
    assert!(
        !fixture
            .data
            .with_file_name(".BBDown.data.login.tmp")
            .exists()
    );
    let diagnostic = diagnostics.to_string();
    for forbidden in ["synthetic", "https://", "SESSDATA", "qrcode_key"] {
        assert!(!diagnostic.contains(forbidden));
    }
    fixture.login("logout", json!({}));
    assert!(!fixture.data.exists());

    fixture.reset("mode=expired");
    let generation = fixture.start();
    let worker = fixture.worker(generation);
    fixture.wait(|| {
        fixture.state()["message"]
            .as_str()
            .unwrap()
            .contains("确认")
    });
    worker.finish();
    assert!(
        fixture.state()["message"]
            .as_str()
            .unwrap()
            .contains("过期")
    );
    assert_eq!(fixture.state()["state"], "failed");
    assert!(!fixture.notify(generation));
    for mode in [
        "generate_http",
        "generate_api",
        "generate_json",
        "poll_api",
        "unknown",
        "ticket",
        "host_only",
    ] {
        fixture.reset(&format!("mode={mode}"));
        let generation = fixture.start();
        let value = fixture.run(generation);
        assert_eq!(fixture.state()["state"], "failed", "{mode}");
        assert!(!fixture.data.exists());
        assert!(!qr.exists());
        assert!(!fixture.notify(generation));
        let log = value.to_string();
        for forbidden in ["synthetic", "https://", "SESSDATA", "qrcode_key"] {
            assert!(!log.contains(forbidden), "diagnostic leaked {forbidden}");
        }
    }
    for stage in ["generate", "poll"] {
        for action in ["cancel", "regenerate", "logout", "shutdown"] {
            fixture.reset(&format!("mode=success&hold={stage}"));
            let generation = fixture.start();
            let worker = fixture.worker(generation);
            fixture.wait(|| {
                fixture.control("stats")["held"]
                    .as_array()
                    .is_some_and(|held| !held.is_empty())
            });
            match action {
                "regenerate" => {
                    assert_ne!(fixture.start(), generation);
                }
                "logout" => {
                    fixture.login("logout", json!({}));
                }
                _ => {
                    fixture.login("cancel", json!({}));
                }
            }
            fixture.control("release");
            worker.finish();
            assert!(!fixture.notify(generation));
            assert!(!fixture.data.exists());
            assert!(!qr.exists());
            assert_eq!(
                fixture.state()["state"],
                if action == "regenerate" {
                    "starting"
                } else {
                    "idle"
                }
            );
            fixture.login("cancel", json!({}));
        }
    }
    // An old blocked worker cannot remove or notify for the replacement QR.
    fixture.reset("mode=success&hold=poll");
    let old = fixture.start();
    let old_worker = fixture.worker(old);
    fixture.wait(|| fixture.control("stats")["held"].as_array().unwrap().len() == 1);
    let new = fixture.start();
    let new_worker = fixture.worker(new);
    fixture.wait(|| fixture.control("stats")["held"].as_array().unwrap().len() == 2);
    fixture.control("release?index=0");
    old_worker.finish();
    assert!(!fixture.notify(old));
    assert!(!fixture.data.exists());
    assert_eq!(fixture.state()["state"], "waiting");
    assert!(qr.exists());
    fixture.control("release?index=1");
    new_worker.finish();
    assert!(fixture.notify(new));
    assert!(!fixture.notify(new));
    // An existing file must not convert a failed poll to accepted success.
    fixture.reset("mode=unknown&hold=poll");
    let generation = fixture.start();
    let worker = fixture.worker(generation);
    fixture.wait(|| fixture.state()["state"] == "waiting");
    fs::write(&fixture.data, "SESSDATA=existing; bili_jct=existing").unwrap();
    fixture.wait(|| {
        fixture.control("stats")["held"]
            .as_array()
            .is_some_and(|held| !held.is_empty())
    });
    fixture.control("release");
    worker.finish();
    assert_eq!(fixture.state()["state"], "failed");
    assert_eq!(
        fs::read_to_string(&fixture.data).unwrap(),
        "SESSDATA=existing; bili_jct=existing"
    );
    assert!(!fixture.notify(generation));
    // Native create_new storage failure preserves the prior file and publishes no event.
    fixture.reset("mode=success&hold=poll");
    fs::write(&fixture.data, "ticket=synthetic").unwrap();
    let generation = fixture.start();
    let worker = fixture.worker(generation);
    fixture.wait(|| fixture.state()["state"] == "waiting");
    fs::create_dir(fixture.data.with_file_name(".BBDown.data.login.tmp")).unwrap();
    fixture.wait(|| {
        fixture.control("stats")["held"]
            .as_array()
            .is_some_and(|held| !held.is_empty())
    });
    fixture.control("release");
    worker.finish();
    assert_eq!(fixture.state()["state"], "failed");
    assert_eq!(
        fs::read_to_string(&fixture.data).unwrap(),
        "ticket=synthetic"
    );
    assert!(!fixture.notify(generation));
    fs::remove_dir(fixture.data.with_file_name(".BBDown.data.login.tmp")).unwrap();
    for action in ["logout", "replacement", "cancel"] {
        fixture.reset("mode=success");
        let generation = fixture.start();
        fixture.run(generation);
        assert!(fixture.data.exists());
        if action == "replacement" {
            fixture.login("logout", json!({}));
            fixture.start();
        } else {
            fixture.login(action, json!({}));
        }
        assert!(!fixture.notify(generation));
    }
    for value in [
        "\u{feff}{\"cookies\":[{\"name\":\"sessdata\",\"value\":\"synthetic\"},{\"name\":\"BILI_JCT\",\"value\":\"csrf\"}]}",
        "{\"SESSDATA\":\"synthetic\",\"bili_jct\":\"csrf\"}",
        "sessdata=synthetic; BILI_JCT=csrf",
    ] {
        fs::write(&fixture.data, value).unwrap();
        assert_eq!(
            fixture.login(
                "read_cookie",
                json!({"configured_cookie":" configured=retained "})
            )["cookie"],
            "SESSDATA=synthetic; bili_jct=csrf"
        );
    }
    fs::write(&fixture.data, "ticket=synthetic").unwrap();
    assert_eq!(
        fixture.login(
            "read_cookie",
            json!({"configured_cookie":" configured=retained "})
        )["cookie"],
        "configured=retained"
    );
    fixture.login("logout", json!({}));
}
