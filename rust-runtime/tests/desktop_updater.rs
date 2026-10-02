//! The built `bilikara-updater`, started detached through the production
//! launcher, replaces a fixture installation after its owner exits and keeps
//! its result. The relaunch target is a harmless executable (or, off Windows,
//! absent and only logged); package validation is covered by unit tests.
use bilikara_runtime::update_installer::{
    LaunchUpdateHelperRequest, apply::Plan, launch_update_helper,
};
use std::fs;
#[cfg(windows)]
use std::path::PathBuf;
use std::process::Command;
#[cfg(windows)]
use std::process::Stdio;
use std::time::{Duration, Instant};

#[test]
fn built_updater_replaces_after_owner_exit_and_keeps_its_result() {
    for handshake in [true, false] {
        replace_and_report(handshake);
    }
}

fn replace_and_report(handshake: bool) {
    let root = std::env::temp_dir().join(format!(
        "bilikara-updater-bin-{}-{handshake}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&root);
    let base = root.join("更新 测试 (x86) & bin");
    let platform = if cfg!(target_os = "macos") {
        "macos"
    } else {
        "windows"
    };
    let destination = base.join(if platform == "macos" {
        "bilikara-desktop.app"
    } else {
        "bilikara 安装"
    });
    let workspace = base.join("update-bin");
    let source = workspace.join("extracted/bilikara");
    for (path, text) in [
        (destination.join("old-only.txt"), "old"),
        (destination.join("runtime/data/user.json"), "keep"),
        (source.join("new-only.txt"), "new"),
    ] {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }
    #[cfg(windows)]
    for directory in [&destination, &source] {
        // A real program that exits at once stands in for the shell.
        fs::copy(
            PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join("System32/whoami.exe"),
            directory.join("bilikara-desktop.exe"),
        )
        .unwrap();
    }
    let updater = workspace.join(if cfg!(windows) {
        "bilikara-updater.exe"
    } else {
        "bilikara-updater"
    });
    fs::copy(env!("CARGO_BIN_EXE_bilikara-updater"), &updater).unwrap();
    #[cfg(windows)]
    let mut owner = Command::new("ping")
        .args(["-n", "3", "127.0.0.1"])
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    #[cfg(unix)]
    let mut owner = Command::new("/bin/sleep").arg("2").spawn().unwrap();
    let plan = Plan {
        schema_version: 1,
        platform: platform.into(),
        operation: "update-bin".into(),
        source,
        destination: destination.clone(),
        workspace: workspace.clone(),
        reports: base.join("data/update-logs"),
        preserve: if platform == "windows" {
            vec!["runtime".into()]
        } else {
            vec![]
        },
        wait_pids: vec![owner.id()],
    };
    let plan_path = workspace.join("plan.json");
    fs::write(&plan_path, serde_json::to_vec(&plan).unwrap()).unwrap();
    let started = Instant::now();
    let mut standalone = None;
    if handshake {
        launch_update_helper(&LaunchUpdateHelperRequest {
            command: vec![
                updater.to_string_lossy().into_owned(),
                "--plan".into(),
                plan_path.to_string_lossy().into_owned(),
            ],
        })
        .unwrap();
        assert!(workspace.join("handoff-ready").is_file());
        assert!(workspace.join("handoff-ack").is_file());
        assert!(destination.join("old-only.txt").is_file());
        assert!(!destination.join("new-only.txt").exists());
        // Repeating the same handoff cannot start a second installer.
        assert!(
            launch_update_helper(&LaunchUpdateHelperRequest {
                command: vec![
                    updater.to_string_lossy().into_owned(),
                    "--plan".into(),
                    plan_path.to_string_lossy().into_owned()
                ],
            })
            .is_err()
        );
    } else {
        // Published --plan launches still work without the private handshake.
        standalone = Some(
            Command::new(&updater)
                .arg("--plan")
                .arg(&plan_path)
                .spawn()
                .unwrap(),
        );
    }
    owner.wait().unwrap();
    let result = plan.reports.join("last-result.txt");
    while !result.is_file() {
        assert!(
            started.elapsed() < Duration::from_secs(60),
            "the updater kept no result"
        );
        std::thread::sleep(Duration::from_millis(100));
    }
    assert_eq!(
        fs::read_to_string(&result).unwrap(),
        "operation=update-bin\nresult=installed\n"
    );
    assert!(
        started.elapsed() >= Duration::from_millis(1500),
        "it waited for the owner"
    );
    assert_eq!(
        fs::read_to_string(destination.join("new-only.txt")).unwrap(),
        "new"
    );
    assert!(!destination.join("old-only.txt").exists());
    assert_eq!(
        destination.join("runtime/data/user.json").exists(),
        platform == "windows"
    );
    let kept = fs::read_to_string(plan.reports.join("update-bin.log")).unwrap();
    assert!(
        kept.contains("] installed, previous installation kept at"),
        "{kept}"
    );
    // Unix updaters remove their own workspace; Windows leaves it to the Host.
    let deadline = Instant::now() + Duration::from_secs(10);
    while cfg!(unix) && workspace.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(100));
    }
    assert_eq!(workspace.exists(), cfg!(windows));
    if let Some(mut child) = standalone {
        assert!(child.wait().unwrap().success());
    }
    let _ = fs::remove_dir_all(root);
}

#[test]
fn built_updater_without_host_acknowledgement_never_replaces_files() {
    let root = std::env::temp_dir().join(format!("bilikara-updater-no-ack-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    let workspace = root.join("update-abandoned");
    let source = workspace.join("extracted/package");
    let destination = root.join("installed");
    fs::create_dir_all(&source).unwrap();
    fs::create_dir(&destination).unwrap();
    fs::write(source.join("new.txt"), "new").unwrap();
    fs::write(destination.join("old.txt"), "keep").unwrap();
    let plan = Plan {
        schema_version: 1,
        platform: "windows".into(),
        operation: "update-abandoned".into(),
        source,
        destination: destination.clone(),
        workspace: workspace.clone(),
        reports: root.join("data/update-logs"),
        preserve: vec![],
        wait_pids: vec![std::process::id()],
    };
    let path = workspace.join("plan.json");
    fs::write(&path, serde_json::to_vec(&plan).unwrap()).unwrap();
    fs::write(workspace.join("handoff-request"), "a".repeat(64)).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_bilikara-updater"))
        .arg("--plan")
        .arg(&path)
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("an abandoned handoff must stop before waiting for owners");
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    assert!(!status.success());
    assert!(workspace.join("handoff-ready").is_file());
    assert!(!workspace.join("handoff-ack").exists());
    assert!(
        fs::read_to_string(workspace.join("handoff-error"))
            .unwrap()
            .contains("did not acknowledge")
    );
    assert_eq!(
        fs::read_to_string(destination.join("old.txt")).unwrap(),
        "keep"
    );
    assert!(!destination.join("new.txt").exists());
    assert!(!plan.reports.join("last-result.txt").exists());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn built_updater_startup_failures_leave_the_application_and_installation_running() {
    for case in [
        "invalid_plan",
        "missing_payload",
        "unwritable_log",
        "stale_ack",
    ] {
        let root =
            std::env::temp_dir().join(format!("bilikara-updater-{case}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let workspace = root.join("update-startup");
        let source = workspace.join("extracted/package");
        let destination = root.join("installed");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir(&destination).unwrap();
        fs::write(destination.join("old.txt"), "keep").unwrap();
        fs::write(source.join("new.txt"), "new").unwrap();
        let updater = workspace.join(if cfg!(windows) {
            "bilikara-updater.exe"
        } else {
            "bilikara-updater"
        });
        fs::copy(env!("CARGO_BIN_EXE_bilikara-updater"), &updater).unwrap();
        let plan = Plan {
            schema_version: 1,
            platform: "windows".into(),
            operation: "update-startup".into(),
            source: source.clone(),
            destination: destination.clone(),
            workspace: workspace.clone(),
            reports: root.join("data/update-logs"),
            preserve: vec![],
            wait_pids: vec![std::process::id()],
        };
        let path = workspace.join("plan.json");
        fs::write(&path, serde_json::to_vec(&plan).unwrap()).unwrap();
        match case {
            "invalid_plan" => fs::write(&path, b"broken JSON").unwrap(),
            "missing_payload" => fs::remove_dir_all(&source).unwrap(),
            "unwritable_log" => fs::create_dir(workspace.join("apply.log")).unwrap(),
            "stale_ack" => fs::write(workspace.join("handoff-ack"), "old attempt").unwrap(),
            _ => unreachable!(),
        }
        let error = launch_update_helper(&LaunchUpdateHelperRequest {
            command: vec![
                updater.to_string_lossy().into_owned(),
                "--plan".into(),
                path.to_string_lossy().into_owned(),
            ],
        })
        .unwrap_err();
        assert_eq!(error.kind, "launch_failed", "{case}");
        assert_eq!(
            fs::read_to_string(destination.join("old.txt")).unwrap(),
            "keep"
        );
        assert!(!destination.join("new.txt").exists());
        assert!(!plan.reports.join("last-result.txt").exists());
        fs::remove_dir_all(root).unwrap();
    }
}
