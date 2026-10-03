//! Optional actual installed-entry regressions; CI supplies each extracted artifact.
use super::*;
use host::{Process, isolated_environment};
use std::{ffi::OsString, time::Duration};

fn installation() -> Installation {
    let path = std::env::var_os("BILIKARA_TEST_NATIVE_PACKAGE")
        .expect("Installed-package regression requires BILIKARA_TEST_NATIVE_PACKAGE pointing to an actual release Host");
    let executable = PathBuf::from(path)
        .canonicalize()
        .expect("Supplied installed Host is absent");
    let expected = std::env::var("BILIKARA_EXPECT_RELEASE_VERSION").unwrap_or_default();
    inspect(&executable, &expected, Platform::current().unwrap())
        .expect("Supplied installed package is invalid");
    Installation::copy(&executable).unwrap()
}
fn args(data: &Path, source: Option<&Path>) -> Vec<OsString> {
    let mut args = vec!["--data-dir".into(), data.as_os_str().to_owned()];
    if let Some(source) = source {
        args.extend(["--import-from".into(), source.as_os_str().to_owned()]);
    }
    args
}
fn fail(install: &Installation, arguments: &[OsString], message: &str) {
    let (mut process, _) =
        Process::spawn(&install.executable, install.home.path(), arguments).unwrap();
    let output = process.output(Duration::from_secs(30)).unwrap();
    assert!(
        !output.status.success(),
        "Invalid installed entry succeeded"
    );
    assert!(!String::from_utf8_lossy(&output.stdout).contains("bilikara.ready"));
    assert!(
        String::from_utf8_lossy(&output.stderr).contains(message),
        "Expected explicit startup failure: {message}"
    );
}
fn legacy(root: &Path) -> PathBuf {
    fs::create_dir_all(root.join("data")).unwrap();
    let record = root.join("data/player_state.json");
    fs::write(
        &record,
        br#"{"playback_mode":"local","player_settings":{"volume_percent":43}}"#,
    )
    .unwrap();
    record
}

#[test]
#[ignore = "requires an actual release Host: set BILIKARA_TEST_NATIVE_PACKAGE and run --ignored"]
fn installed_release_bootstrap_resources_sse_and_reopen() {
    let install = installation();
    let report = verify(&install.executable, "").unwrap();
    assert_eq!(report["shutdownAndReopen"], true);
}
#[test]
#[ignore = "requires an actual release Host: set BILIKARA_TEST_NATIVE_PACKAGE and run --ignored"]
fn installed_explicit_import_preserves_source_and_does_not_reimport() {
    let install = installation();
    let home = install.home.path();
    let source = home.join("legacy 空");
    let record = legacy(&source);
    let original = fs::read(&record).unwrap();
    let arguments = args(&home.join("native"), Some(&source));
    let mut host = RunningHost::start(&install.executable, home, &arguments).unwrap();
    assert_eq!(
        host.api("/api/state", None).unwrap()["player_settings"]["volume_percent"],
        43
    );
    host.close().unwrap();
    assert_eq!(fs::read(&record).unwrap(), original);
    fs::write(&record, "malformed old records must not be read again").unwrap();
    let mut host = RunningHost::start(&install.executable, home, &arguments).unwrap();
    assert_eq!(
        host.api("/api/state", None).unwrap()["player_settings"]["volume_percent"],
        43
    );
    host.close().unwrap();
    assert_eq!(
        fs::read_to_string(&record).unwrap(),
        "malformed old records must not be read again"
    );
}
#[test]
#[ignore = "requires an actual release Host: set BILIKARA_TEST_NATIVE_PACKAGE and run --ignored"]
fn installed_platform_legacy_policy_and_explicit_import() {
    let install = installation();
    let home = install.home.path();
    let environment = isolated_environment(home).unwrap();
    let source = match Platform::current().unwrap().os {
        Os::Windows => {
            PathBuf::from(&environment[&OsString::from("LOCALAPPDATA")]).join("bilikara")
        }
        Os::Macos => home.join("Library/Application Support/bilikara"),
        Os::Linux => PathBuf::from(&environment[&OsString::from("XDG_DATA_HOME")]).join("bilikara"),
    };
    let record = legacy(&source);
    let original = fs::read(&record).unwrap();
    if cfg!(windows) {
        let mut host = RunningHost::start(&install.executable, home, &[]).unwrap();
        host.close().unwrap();
        assert!(
            install
                .package
                .join("runtime/data/host-state.json")
                .is_file()
        );
    } else {
        fail(&install, &[], "Legacy desktop records found at");
        fail(&install, &[], "--import-from");
        assert!(!source.join("native").exists());
    }
    let mut host = RunningHost::start(
        &install.executable,
        home,
        &args(&home.join("new-native"), Some(&source)),
    )
    .unwrap();
    assert_eq!(
        host.api("/api/state", None).unwrap()["player_settings"]["volume_percent"],
        43
    );
    host.close().unwrap();
    assert_eq!(fs::read(record).unwrap(), original);
}
#[test]
#[ignore = "requires an actual release Host: set BILIKARA_TEST_NATIVE_PACKAGE and run --ignored"]
fn installed_markerless_checkpoint_cache_recovery_and_pending_refusal() {
    let install = installation();
    let home = install.home.path();
    let data = home.join("runtime/data");
    let arguments = args(&data, None);
    let mut host = RunningHost::start(&install.executable, home, &arguments).unwrap();
    host.api(
        "/api/session-users/add",
        Some(&json!({"name":"Layout fixture"})),
    )
    .unwrap();
    host.close().unwrap();
    assert!(data.join("host-state.json").is_file());
    assert!(!data.join(".bilikara-desktop-rust-preview").exists());
    fs::rename(data.join("cache"), data.join("media")).unwrap();
    fs::write(data.join("media/keep.txt"), "preserve preview cache").unwrap();
    let mut host = RunningHost::start(&install.executable, home, &arguments).unwrap();
    assert!(
        host.api("/api/state", None)
            .unwrap()
            .to_string()
            .contains("Layout fixture")
    );
    assert!(!data.join("media").exists());
    assert_eq!(
        fs::read_to_string(data.join("cache/keep.txt")).unwrap(),
        "preserve preview cache"
    );
    host.close().unwrap();
    fs::write(data.join("desktop-import.pending"), "incomplete import").unwrap();
    let checkpoint = fs::read(data.join("host-state.json")).unwrap();
    fail(&install, &arguments, "Incomplete desktop import");
    assert_eq!(fs::read(data.join("host-state.json")).unwrap(), checkpoint);
}
#[test]
#[ignore = "requires an actual release Host: set BILIKARA_TEST_NATIVE_PACKAGE and run --ignored"]
fn installed_malformed_unmarked_roots_fail_without_enrollment() {
    let install = installation();
    let root = install.home.path().join("records");
    fs::create_dir_all(root.join("data")).unwrap();
    let arguments = args(&root, None);
    fail(&install, &arguments, "--import-from");
    assert!(!root.join(".bilikara-desktop-rust-preview").exists());
    fs::write(root.join("host-state.json"), "broken native records").unwrap();
    fail(&install, &arguments, "");
    assert_eq!(
        fs::read_to_string(root.join("host-state.json")).unwrap(),
        "broken native records"
    );
}
#[test]
#[ignore = "requires an actual release Host: set BILIKARA_TEST_NATIVE_PACKAGE and run --ignored"]
fn installed_missing_inputs_and_incompatible_metadata_no_fallback() {
    let install = installation();
    for option in ["--data-dir", "--static-dir"] {
        fail(&install, &[option.into()], "requires");
    }
    let assets = resources(&install.executable);
    let companion = format!("vendor/{}", Platform::current().unwrap().companion());
    for name in [
        "native-desktop.json",
        "APP_VERSION",
        "static/app.js",
        companion.as_str(),
        "vendor/signalsmith-stretch/SignalsmithStretch.js",
    ] {
        let target = assets.join(name);
        assert!(target.is_file(), "Missing actual test input {name}");
        let hidden = target.with_file_name(format!(
            "{}.test-hidden",
            target.file_name().unwrap().to_string_lossy()
        ));
        fs::rename(&target, &hidden).unwrap();
        fail(&install, &[], "");
        fs::rename(hidden, target).unwrap();
    }
    let manifest = assets.join("native-desktop.json");
    let original = fs::read(&manifest).unwrap();
    let mut facts: Value = serde_json::from_slice(&original).unwrap();
    facts["arch"] = "incompatible".into();
    fs::write(&manifest, facts.to_string()).unwrap();
    fail(&install, &[], "Incompatible");
    fs::write(manifest, original).unwrap();
}
