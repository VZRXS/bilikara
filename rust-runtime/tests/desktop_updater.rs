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

#[cfg(windows)]
fn desktop_process_job() -> windows_sys::Win32::Foundation::HANDLE {
    use std::sync::OnceLock;
    use windows_sys::Win32::System::{JobObjects::*, Threading::*};

    // Git Bash may place tests in a job that forbids breakaway. Production
    // Hosts first create their own kill-on-close, breakaway-enabled inner job.
    // Exercise that actual lifecycle rather than weakening the updater launcher.
    static JOB: OnceLock<usize> = OnceLock::new();
    let job = *JOB.get_or_init(|| {
        // SAFETY: documented Win32 POD structures; one unnamed non-inheritable
        // job is intentionally retained until process exit, exactly as the Host
        // does. Closing it in a test thread would terminate the test process.
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            assert!(!job.is_null(), "{}", std::io::Error::last_os_error());
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags =
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
            assert_ne!(
                SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    std::mem::size_of_val(&limits) as u32,
                ),
                0,
                "{}",
                std::io::Error::last_os_error()
            );
            assert_ne!(
                AssignProcessToJobObject(job, GetCurrentProcess()),
                0,
                "{}",
                std::io::Error::last_os_error()
            );
            job as usize
        }
    });
    job as windows_sys::Win32::Foundation::HANDLE
}

#[cfg(windows)]
fn assert_updater_left_desktop_job(workspace: &std::path::Path) {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::{
        Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
        System::{Diagnostics::ToolHelp::*, JobObjects::IsProcessInJob, Threading::*},
    };
    let expected = fs::canonicalize(workspace.join("bilikara-updater.exe")).unwrap();
    let mut matches = Vec::new();
    // SAFETY: read-only snapshot/query handles are closed before assertions.
    // Identify only this fixture's exact compiled executable, never a log's
    // version number or an unrelated updater with the same basename.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        assert_ne!(
            snapshot,
            INVALID_HANDLE_VALUE,
            "{}",
            std::io::Error::last_os_error()
        );
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of_val(&entry) as u32;
        let mut found = Process32FirstW(snapshot, &mut entry);
        while found != 0 {
            let length = entry
                .szExeFile
                .iter()
                .position(|value| *value == 0)
                .unwrap_or(entry.szExeFile.len());
            if String::from_utf16(&entry.szExeFile[..length])
                .is_ok_and(|name| name.eq_ignore_ascii_case("bilikara-updater.exe"))
            {
                let process =
                    OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, entry.th32ProcessID);
                if !process.is_null() {
                    let mut image = vec![0_u16; 32768];
                    let mut length = image.len() as u32;
                    if QueryFullProcessImageNameW(process, 0, image.as_mut_ptr(), &mut length) != 0
                    {
                        let image =
                            PathBuf::from(std::ffi::OsString::from_wide(&image[..length as usize]));
                        if fs::canonicalize(image).ok().as_ref() == Some(&expected) {
                            let mut in_job = 0;
                            let queried =
                                IsProcessInJob(process, desktop_process_job(), &mut in_job);
                            matches.push((
                                entry.th32ProcessID,
                                queried,
                                in_job,
                                std::io::Error::last_os_error(),
                            ));
                        }
                    }
                    CloseHandle(process);
                }
            }
            found = Process32NextW(snapshot, &mut entry);
        }
        CloseHandle(snapshot);
    }
    assert_eq!(
        matches.len(),
        1,
        "one actual updater for {}: {matches:?}",
        expected.display()
    );
    for (_, queried, in_job, error) in matches {
        assert_ne!(queried, 0, "{error}");
        assert_eq!(in_job, 0, "updater must outlive the Host's job");
    }
}

#[test]
fn built_updater_replaces_after_owner_exit_and_keeps_its_result() {
    #[cfg(windows)]
    desktop_process_job();
    for handshake in [true, false] {
        for special_path in [false, true] {
            replace_and_report(handshake, special_path);
        }
    }
}

fn replace_and_report(handshake: bool, special_path: bool) {
    let root = std::env::temp_dir().join(format!(
        "bilikara-updater-bin-{}-{handshake}-{special_path}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&root);
    let base = root.join(if special_path {
        "更新 测试 (x86) & bin"
    } else {
        "ordinary"
    });
    let platform = if cfg!(target_os = "macos") {
        "macos"
    } else {
        "windows"
    };
    let destination = base.join(if platform == "macos" {
        "bilikara-desktop.app"
    } else if special_path {
        "bilikara 安装"
    } else {
        "bilikara"
    });
    let workspace = base.join("update-bin");
    let source = workspace.join("extracted/bilikara");
    for (path, text) in [
        (destination.join("old-only.txt"), "old"),
        (destination.join("runtime/data/user.json"), "keep"),
        (destination.join("APP_VERSION"), "v0.8.0-preview.3"),
        (source.join("new-only.txt"), "new"),
        (source.join("APP_VERSION"), "v0.8.0-preview.4"),
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
        #[cfg(windows)]
        assert_updater_left_desktop_job(&workspace);
        assert!(workspace.join("handoff-ready").is_file());
        assert!(workspace.join("handoff-ack").is_file());
        assert!(destination.join("old-only.txt").is_file());
        assert!(!destination.join("new-only.txt").exists());
        let lease = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(workspace.join("updater.lock"))
            .unwrap();
        assert!(
            fs2::FileExt::try_lock_exclusive(&lease).is_err(),
            "running updater must hold the cleanup lease"
        );
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
    // The marker precedes relaunch; wait for reporting to finish before
    // inspecting the restart result. A spawn/exit code is not shell readiness.
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(workspace.join("updater.lock"))
        {
            Ok(lease) if fs2::FileExt::try_lock_exclusive(&lease).is_ok() => break,
            Err(_) if !workspace.exists() => break,
            _ => assert!(Instant::now() < deadline, "updater is still reporting"),
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let marker = fs::read_to_string(&result).unwrap();
    assert!(marker.starts_with("operation=update-bin\nresult=installed\n"));
    #[cfg(not(any(windows, target_os = "macos")))]
    assert_eq!(
        marker,
        "operation=update-bin\nresult=installed\nrelaunch=failed\n"
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
        fs::read_to_string(destination.join("APP_VERSION")).unwrap(),
        "v0.8.0-preview.4"
    );
    assert_eq!(
        destination.join("runtime/data/user.json").exists(),
        platform == "windows"
    );
    let kept = fs::read_to_string(plan.reports.join("update-bin.log")).unwrap();
    #[cfg(not(any(windows, target_os = "macos")))]
    assert!(kept.contains("relaunching failed: desktop updates are not supported here"));
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
    #[cfg(windows)]
    desktop_process_job();
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
    #[cfg(windows)]
    desktop_process_job();
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
        assert!(
            error.message.contains(if case == "stale_ack" {
                "stale updater handshake"
            } else {
                "updater startup failed:"
            }),
            "{case} must reach its declared failure boundary: {error:?}"
        );
        assert_eq!(
            fs::read_to_string(destination.join("old.txt")).unwrap(),
            "keep"
        );
        assert!(!destination.join("new.txt").exists());
        assert!(!plan.reports.join("last-result.txt").exists());
        fs::remove_dir_all(root).unwrap();
    }
}
