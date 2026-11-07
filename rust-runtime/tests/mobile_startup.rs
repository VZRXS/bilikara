//! Actual shared mobile startup in isolated native processes. This exercises the
//! Rust service, not WKWebView, iOS signing, device playback or LAN reachability.
#![cfg(feature = "native-host")]

use bilikara_runtime::{
    AppStateRequest, execute_app_state,
    native_host::{Asset, mobile},
};
use serde_json::{Value, json};
use std::{
    path::Path,
    process::{Command, Stdio},
    sync::Arc,
    time::{Duration, Instant},
};

fn assets() -> bilikara_runtime::native_host::AssetSource {
    Arc::new(|path| {
        matches!(path, "index.html" | "remote.html").then(|| Asset {
            bytes: b"<!DOCTYPE html><html lang=\"en\"><body>fixture</body></html>".to_vec(),
            mime: "text/html".into(),
        })
    })
}

fn child(mode: &str, directory: &Path) {
    if mode == "corrupt" {
        let original = std::fs::read(directory.join("host-state.json")).unwrap();
        let error = mobile::start_diagnosed(directory, assets())
            .err()
            .expect("corrupt checkpoint must fail");
        assert_eq!(error.code, "native_storage_invalid");
        assert_eq!(
            error.stage,
            bilikara_runtime::native_host::startup::Stage::CheckpointRestore
        );
        assert_eq!(
            error.last_completed,
            Some(bilikara_runtime::native_host::startup::Stage::StorageOpen)
        );
        assert_eq!(
            std::fs::read(directory.join("host-state.json")).unwrap(),
            original
        );
        assert!(!directory.join("media").exists());
        assert_eq!(
            mobile::start(directory, assets()).err().unwrap(),
            "mobile_start_already_attempted"
        );
        return;
    }
    if mode == "failed_recovery" || mode == "locked" {
        let before = std::fs::read(directory.join("host-state.json")).unwrap();
        let error = mobile::start_diagnosed(directory, assets())
            .err()
            .expect("injected startup failure");
        let expected_stage = if mode == "locked" {
            "storage_open"
        } else {
            "cache_recovery"
        };
        let facts = serde_json::to_value(error).unwrap();
        assert_eq!(facts["stage"], expected_stage);
        assert!(facts["io_kind"].is_string());
        assert!(facts["os_error"].is_i64());
        assert_eq!(
            std::fs::read(directory.join("host-state.json")).unwrap(),
            before
        );
        assert_eq!(
            mobile::start(directory, assets()).err().unwrap(),
            "mobile_start_already_attempted"
        );
        if mode != "locked" {
            // Failure before listener creation must release the AppState owner.
            assert!(
                execute_app_state(AppStateRequest::Snapshot { schema_version: 1 })
                    .error()
                    .is_some()
            );
            let file = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(directory.join("host-state.lock"))
                .unwrap();
            fs2::FileExt::try_lock_exclusive(&file).expect("startup failure leaked storage lock");
        }
        return;
    }
    let host = mobile::start(directory, assets()).unwrap();
    let origin = format!("http://127.0.0.1:{}", host.local_port());
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .cookie_store(true)
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    assert_eq!(
        client
            .get(format!("{origin}/api/state"))
            .send()
            .unwrap()
            .status()
            .as_u16(),
        403
    );
    assert!(
        client
            .get(host.bootstrap_url())
            .send()
            .unwrap()
            .status()
            .is_success()
    );
    let page = client
        .get(format!("{origin}/"))
        .send()
        .unwrap()
        .text()
        .unwrap();
    assert!(page.contains("data-native-host=\"true\""));
    let remote = reqwest::blocking::Client::builder()
        .no_proxy()
        .cookie_store(true)
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    assert!(
        remote
            .get(format!("{origin}/remote"))
            .send()
            .unwrap()
            .status()
            .is_success()
    );
    if mode == "restore" || mode == "abrupt" {
        let pending = client
            .post(format!("{origin}/api/session-users/add"))
            .header("origin", &origin)
            .json(&json!({"name":"Must not be added"}))
            .send()
            .unwrap();
        assert_eq!(pending.status().as_u16(), 409);
        assert_eq!(
            pending.json::<Value>().unwrap()["code"],
            "session_choice_pending"
        );
        let response = client
            .post(format!("{origin}/api/session/startup-choice"))
            .header("origin", &origin)
            .json(&json!({"choice":"continue"}))
            .send()
            .unwrap();
        assert!(
            response.status().is_success(),
            "{}",
            response.text().unwrap()
        );
        let state: Value = client
            .get(format!("{origin}/api/state"))
            .send()
            .unwrap()
            .json()
            .unwrap();
        assert_eq!(state["ok"], true);
        assert_eq!(state["data"]["session_users"], json!(["M0 singer"]));
    } else {
        let response = client
            .post(format!("{origin}/api/session-users/add"))
            .header("origin", &origin)
            .json(&json!({"name":"M0 singer"}))
            .send()
            .unwrap();
        assert!(
            response.status().is_success(),
            "{}",
            response.text().unwrap()
        );
    }
    let denied = remote
        .post(format!("{origin}/api/session-users/add"))
        .header("origin", &origin)
        .json(&json!({"name":"Forbidden"}))
        .send()
        .unwrap();
    assert_eq!(denied.status().as_u16(), 403);
    let before = std::fs::read(directory.join("host-state.json")).unwrap();
    let port = host.local_port();
    assert_eq!(
        mobile::start(directory, assets()).err().unwrap(),
        "mobile_start_already_attempted"
    );
    assert_eq!(host.local_port(), port);
    assert_eq!(
        std::fs::read(directory.join("host-state.json")).unwrap(),
        before
    );
    assert!(
        client
            .get(format!("{origin}/api/state"))
            .send()
            .unwrap()
            .status()
            .is_success()
    );
    if mode == "abrupt" {
        // No destructors: exercise OS lock release after a committed snapshot,
        // independently of the normal NativeHost/AppState shutdown paths.
        std::process::exit(0);
    }
    drop(host);
    assert!(
        execute_app_state(AppStateRequest::Shutdown { schema_version: 1 })
            .error()
            .is_none()
    );
}

fn run_child(mode: &str, directory: &Path) {
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "mobile_startup_preserves_state_and_authentication",
            "--nocapture",
        ])
        .env("BILIKARA_MOBILE_STARTUP_TEST_MODE", mode)
        .env("BILIKARA_MOBILE_STARTUP_TEST_DIR", directory)
        .env("BILIKARA_CF_API_URL", "")
        .env("BILIKARA_CATALOG_SHEETS_URL", "")
        .stdin(Stdio::null())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(40);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert!(status.success(), "shared mobile {mode} process failed");
            return;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("shared mobile {mode} process timed out");
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn mobile_startup_preserves_state_and_authentication() {
    if let Ok(mode) = std::env::var("BILIKARA_MOBILE_STARTUP_TEST_MODE") {
        child(
            &mode,
            Path::new(&std::env::var_os("BILIKARA_MOBILE_STARTUP_TEST_DIR").unwrap()),
        );
        return;
    }
    struct OwnedDirectory(std::path::PathBuf);
    impl Drop for OwnedDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let mut random = [0u8; 8];
    getrandom::fill(&mut random).unwrap();
    let root = OwnedDirectory(std::env::temp_dir().join(format!(
        "bilikara-mobile-startup-{:x}",
        u64::from_le_bytes(random)
    )));
    let data = root.0.join("data");
    std::fs::create_dir_all(&data).unwrap();
    // No default library/network source is needed for the startup boundary.
    std::fs::write(
        data.join("native-library-defaults.json"),
        br#"{"schema_version":1}"#,
    )
    .unwrap();
    std::fs::write(
        data.join("gatcha_uids.json"),
        br#"{"schema_version":2,"uids":[],"profiles":{}}"#,
    )
    .unwrap();
    run_child("fresh", &data);
    for _ in 0..10 {
        run_child("restore", &data);
    }
    run_child("abrupt", &data);
    run_child("restore", &data);
    // An interrupted download is also a startup path through exclusive
    // directory publication (.staging -> .retired). Missing iOS support can
    // therefore prevent relaunch, not just the original cache completion.
    let abandoned = data
        .join("media/.staging")
        .join(format!("i-{}-0000000000000001", "1".repeat(32)))
        .join(format!("a-{}-0000000000000002", "2".repeat(32)));
    std::fs::create_dir_all(&abandoned).unwrap();
    std::fs::write(
        abandoned.join("incomplete.part"),
        b"old interrupted transfer",
    )
    .unwrap();
    let unrelated = data.join("media/keep-unowned-file");
    std::fs::write(&unrelated, b"unowned bytes").unwrap();
    run_child("restore", &data);
    assert!(
        !abandoned.exists(),
        "owned abandoned attempt was not recovered"
    );
    assert_eq!(std::fs::read(&unrelated).unwrap(), b"unowned bytes");
    {
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(data.join("host-state.lock"))
            .unwrap();
        fs2::FileExt::try_lock_exclusive(&file).unwrap();
        run_child("locked", &data);
    }
    std::fs::remove_dir_all(data.join("media")).unwrap();
    std::fs::write(data.join("media"), b"preserve this conflicting file").unwrap();
    run_child("failed_recovery", &data);
    assert_eq!(
        std::fs::read(data.join("media")).unwrap(),
        b"preserve this conflicting file"
    );
    std::fs::remove_file(data.join("media")).unwrap();
    run_child("restore", &data);
    let corrupt = root.0.join("corrupt");
    std::fs::create_dir_all(&corrupt).unwrap();
    std::fs::write(
        corrupt.join("host-state.json"),
        b"{preserve this truncated checkpoint",
    )
    .unwrap();
    run_child("corrupt", &corrupt);
}
