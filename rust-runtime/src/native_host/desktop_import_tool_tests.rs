use super::*;
use crate::native_host_storage::NativeHostStorage;
use std::{
    cell::{Cell, RefCell},
    panic::AssertUnwindSafe,
};

thread_local! { static INTERRUPT: Cell<Option<&'static str>> = const { Cell::new(None) }; }
thread_local! { static EDIT_SOURCE: RefCell<Option<PathBuf>> = const { RefCell::new(None) }; }
pub(super) fn interrupt(phase: &'static str) {
    if phase == "prepared" {
        EDIT_SOURCE.with(|source| {
            if let Some(path) = source.borrow_mut().take() {
                fs::write(path, b"{\"history\":[]}").unwrap();
            }
        });
    }
    INTERRUPT.with(|point| {
        if point.get() == Some(phase) {
            panic!("fixture process interruption: {phase}");
        }
    });
}

#[test]
fn source_changed_during_conversion_preserves_latest_old_records() {
    let f = Fixture::new();
    let source = f.source();
    f.populate(&source);
    let target = source.join("data");
    EDIT_SOURCE.with(|path| *path.borrow_mut() = Some(target.join("history.json")));
    assert!(
        install(Some(&source), &target)
            .unwrap_err()
            .contains("changed")
    );
    assert_eq!(
        fs::read(target.join("history.json")).unwrap(),
        b"{\"history\":[]}"
    );
    assert!(!target.join("host-state.json").exists());
    assert!(!import_guard_path(&target, "json").unwrap().exists());
}
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "bilikara import 中文 & $() {}",
            super::super::token().unwrap()
        ));
        fs::create_dir_all(&root).unwrap();
        Self(root.canonicalize().unwrap())
    }
    fn source(&self) -> PathBuf {
        self.0.join("old/runtime")
    }
    fn target(&self) -> PathBuf {
        self.0.join("new/runtime/data")
    }
    fn populate(&self, source: &Path) {
        fs::create_dir_all(source.join("data/played_sessions")).unwrap();
        fs::write(source.join("data/player_state.json"), br#"{"playback_mode":"local","player_settings":{"av_offset_ms":300,"volume_percent":64}}"#).unwrap();
        fs::write(
            source.join("data/session_users.json"),
            "{\"session_users\":[\"小林\",\"Alice\"]}",
        )
        .unwrap();
        fs::write(source.join("data/history.json"), br#"{"history":[{"key":"song","display_title":"Song","original_url":"https://example.test/song","resolved_url":"https://example.test/song","requested_at":100,"request_count":3}]}"#).unwrap();
        fs::write(source.join("data/played_sessions/played-old.json"), br#"{"session_started_at":50,"items":[{"key":"song","item_id":"old","display_title":"Song","title":"Song","part_title":"P1","original_url":"https://example.test/song","resolved_url":"https://example.test/song","bvid":"BV1xx411c7mD","aid":1,"cid":2,"page":1,"played_at":51,"requester_name":"Alice"}]}"#).unwrap();
        fs::create_dir(source.join("data/cache")).unwrap();
        fs::write(
            source.join("data/cache/old.mp4"),
            b"old media bytes retained only in backup",
        )
        .unwrap();
    }
    fn plan(&self, target: &Path) -> Plan {
        read_plan(target).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn real_enumeration_discovery_is_scoped_read_only_and_deduplicated() {
    let f = Fixture::new();
    let local = f.0.join("Local");
    let roaming = f.0.join("Roaming");
    for root in [
        &f.0.join("new/runtime"),
        &local.join("bilikara"),
        &roaming.join("bilikara"),
        &local.join("unrelated"),
    ] {
        f.populate(root);
    }
    let target = f.target();
    let found = discover(
        &target,
        &f.0.join("new/_internal/bilikara-desktop-host.exe"),
        "windows",
        |key| match key {
            "LOCALAPPDATA" => Some(local.clone().into_os_string()),
            "APPDATA" => Some(roaming.clone().into_os_string()),
            _ => None,
        },
    );
    assert_eq!(
        found,
        vec![
            f.0.join("new/runtime"),
            local.join("bilikara"),
            roaming.join("bilikara")
        ]
    );
    assert!(!target.join("host-state.json").exists());
    let duplicate = discover(&target, &f.0.join("new/_internal/host"), "windows", |_| {
        Some(local.clone().into_os_string())
    });
    assert_eq!(duplicate.len(), 2);
    assert!(!local.join("unrelated/data/host-state.json").exists());
    assert!(!import_guard_path(&target, "lock").unwrap().exists());
}

#[test]
fn platform_known_roots_and_manual_installation_or_data_folder_are_supported() {
    let f = Fixture::new();
    let source = f.source();
    f.populate(&source);
    assert_eq!(legacy_root(&source).unwrap(), source);
    assert_eq!(legacy_root(source.parent().unwrap()).unwrap(), source);
    assert_eq!(legacy_root(&source.join("data")).unwrap(), source);
    let mac = f.0.join("Library/Application Support/bilikara");
    f.populate(&mac);
    let found = discover(&f.target(), &f.0.join("unrelated/host"), "macos", |key| {
        (key == "HOME").then(|| f.0.clone().into_os_string())
    });
    assert!(found.contains(&mac));
    let linux = f.0.join(".local/share/bilikara");
    f.populate(&linux);
    assert_eq!(
        discover(&f.target(), &f.0.join("other/host"), "linux", |key| (key
            == "HOME")
            .then(|| f.0.clone().into_os_string())),
        vec![linux]
    );
}

#[test]
fn external_and_in_place_import_preserve_records_source_bytes_and_backup() {
    for in_place in [false, true] {
        let f = Fixture::new();
        let source = f.source();
        f.populate(&source);
        let target = if in_place {
            source.join("data")
        } else {
            f.target()
        };
        let original = fs::read(source.join("data/history.json")).unwrap();
        let result = install(Some(&source), &target).unwrap();
        assert_eq!(result["completed"], true);
        let (_storage, seed) = NativeHostStorage::open(&target).unwrap();
        let seed = seed.unwrap();
        assert_eq!(seed.session_users, vec!["小林", "Alice"]);
        assert_eq!(seed.history[0].request_count, 3);
        assert_eq!(seed.session_archives[0].items.len(), 1);
        assert_eq!(seed.player_settings.global_av_delay_ms, 300);
        assert_eq!(seed.player_settings.volume_percent, 64);
        assert!(seed.session_history.is_empty());
        assert!(!target.join("cache/old.mp4").exists());
        if in_place {
            let backup = Path::new(result["backup"].as_str().unwrap());
            assert_eq!(fs::read(backup.join("history.json")).unwrap(), original);
            assert_eq!(
                fs::read(backup.join("cache/old.mp4")).unwrap(),
                b"old media bytes retained only in backup"
            );
            assert_eq!(format(backup).unwrap(), Format::Legacy);
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(
                    fs::metadata(target.join("host-state.json"))
                        .unwrap()
                        .permissions()
                        .mode()
                        & 0o777,
                    0o600
                );
            }
        } else {
            assert_eq!(
                fs::read(source.join("data/history.json")).unwrap(),
                original
            );
            assert!(result["backup"].is_null());
        }
        assert!(!import_guard_path(&target, "json").unwrap().exists());
    }
}

#[test]
fn existing_native_unknown_incomplete_and_other_legacy_targets_are_never_overwritten() {
    let f = Fixture::new();
    let source = f.source();
    f.populate(&source);
    let target = f.target();
    install(Some(&source), &target).unwrap();
    let bytes = fs::read(target.join("host-state.json")).unwrap();
    assert!(
        install(Some(&source), &target)
            .unwrap_err()
            .contains("protected")
    );
    assert_eq!(fs::read(target.join("host-state.json")).unwrap(), bytes);
    for name in ["unknown", "incomplete", "another"] {
        let root = f.0.join(name);
        let data = root.join("data");
        fs::create_dir_all(&data).unwrap();
        fs::write(data.join("sentinel"), b"preserve").unwrap();
        if name == "incomplete" {
            fs::write(data.join("desktop-import.pending"), b"unfinished").unwrap();
        }
        if name == "another" {
            f.populate(&root);
        }
        assert!(install(Some(&source), &data).is_err());
        assert_eq!(fs::read(data.join("sentinel")).unwrap(), b"preserve");
        assert!(!data.join("host-state.json").exists());
    }
}

#[test]
fn malformed_input_does_not_move_source_or_publish_completion() {
    let f = Fixture::new();
    let source = f.source();
    f.populate(&source);
    fs::write(source.join("data/history.json"), b"{interrupted").unwrap();
    assert!(install(Some(&source), &source.join("data")).is_err());
    assert_eq!(
        fs::read(source.join("data/history.json")).unwrap(),
        b"{interrupted"
    );
    assert!(!source.join("data/host-state.json").exists());
    assert!(
        !import_guard_path(&source.join("data"), "json")
            .unwrap()
            .exists()
    );
    assert!(legacy_root(Path::new("relative")).is_err());
    assert!(install(Some(&source), &f.0.join("../escape")).is_err());
}

#[test]
fn actual_interrupted_phases_rollback_or_finish_without_reimport() {
    for phase in ["prepared", "backed_up", "installed"] {
        let f = Fixture::new();
        let source = f.source();
        f.populate(&source);
        let target = source.join("data");
        let original = fs::read(target.join("history.json")).unwrap();
        INTERRUPT.with(|point| point.set(Some(phase)));
        let crashed =
            std::panic::catch_unwind(AssertUnwindSafe(|| install(Some(&source), &target)));
        INTERRUPT.with(|point| point.set(None));
        assert!(crashed.is_err());
        assert!(import_guard_path(&target, "json").unwrap().exists());
        assert!(desktop::preview_root(&target).is_err());
        assert!(NativeHostStorage::open(&target).is_err());
        let plan = f.plan(&target);
        assert_eq!(plan.schema_version, 1);
        let recovered = install(None, &target).unwrap();
        assert_eq!(recovered["completed"], phase == "installed");
        assert!(!import_guard_path(&target, "json").unwrap().exists());
        if phase == "installed" {
            assert_eq!(format(&target).unwrap(), Format::Native);
        } else {
            assert_eq!(fs::read(target.join("history.json")).unwrap(), original);
            install(Some(&source), &target).unwrap();
        }
    }
}

#[test]
fn unsafe_or_corrupt_recovery_records_preserve_every_directory() {
    for work in [
        "../../outside",
        "/absolute",
        "C:\\outside",
        "\\\\server\\share",
        ".bilikara-import-invalid",
    ] {
        let f = Fixture::new();
        let source = f.source();
        f.populate(&source);
        let target = source.join("data");
        let guard = import_guard_path(&target, "json").unwrap();
        fs::write(
            &guard,
            json!({"schema_version":1,"destination":"data","work":work,"had_data":true})
                .to_string(),
        )
        .unwrap();
        assert!(install(None, &target).is_err());
        assert!(guard.exists());
        assert!(target.join("history.json").is_file());
        assert!(!target.join("host-state.json").exists());
        fs::write(&guard, b"{unfinished").unwrap();
        assert!(install(None, &target).is_err());
    }
}

#[test]
fn native_host_and_import_tool_locks_exclude_concurrent_operations() {
    let f = Fixture::new();
    let source = f.source();
    f.populate(&source);
    let target = f.target();
    install(Some(&source), &target).unwrap();
    let (storage, _) = NativeHostStorage::open(&target).unwrap();
    assert!(
        install(Some(&source), &target)
            .unwrap_err()
            .contains("owns")
    );
    drop(storage);
    let guard = lock(&target).unwrap();
    assert!(NativeHostStorage::open(&target).is_err());
    drop(guard);
    assert!(NativeHostStorage::open(&target).is_ok());
}

#[test]
fn first_start_only_discovers_legacy_when_destination_has_no_native_checkpoint() {
    let f = Fixture::new();
    let known = f.0.join("Library/Application Support/bilikara");
    f.populate(&known);
    let target = f.target();
    let report = || {
        inspect_first_start(&target, &f.0.join("new/host"), "macos", |key| {
            (key == "HOME").then(|| f.0.clone().into_os_string())
        })
        .unwrap()
    };
    assert_eq!(report()["candidates"], json!([known]));
    assert!(!target.exists());
    assert!(!import_guard_path(&target, "lock").unwrap().exists());
    install(Some(&known), &target).unwrap();
    assert_eq!(report()["destination_status"], "native");
    assert_eq!(report()["candidates"], json!([]));
    fs::write(target.join("host-state.json"), b"broken checkpoint").unwrap();
    assert_eq!(
        report()["candidates"],
        json!([]),
        "Malformed native data must never become an automatic import target"
    );
}

#[test]
fn explicit_native_replacement_preserves_complete_backup_and_rejects_active_or_corrupt_storage() {
    let f = Fixture::new();
    let source = f.source();
    f.populate(&source);
    let target = f.target();
    install(Some(&source), &target).unwrap();
    let original = fs::read(target.join("host-state.json")).unwrap();
    fs::write(
        target.join("keep-user-file"),
        b"complete current native backup",
    )
    .unwrap();
    let (storage, _) = NativeHostStorage::open(&target).unwrap();
    assert!(install_with_options(Some(&source), &target, true).is_err());
    drop(storage);
    let report = install_with_options(Some(&source), &target, true).unwrap();
    assert_eq!(report["completed"], true);
    let backup = Path::new(report["backup"].as_str().unwrap());
    assert_eq!(fs::read(backup.join("host-state.json")).unwrap(), original);
    assert_eq!(
        fs::read(backup.join("keep-user-file")).unwrap(),
        b"complete current native backup"
    );
    fs::write(target.join("host-state.json"), b"broken native data").unwrap();
    assert!(install_with_options(Some(&source), &target, true).is_err());
    assert_eq!(
        fs::read(target.join("host-state.json")).unwrap(),
        b"broken native data"
    );
}

#[test]
fn native_replacement_interrupted_at_each_phase_rolls_back_or_finishes() {
    for phase in ["prepared", "backed_up", "installed"] {
        let f = Fixture::new();
        let source = f.source();
        f.populate(&source);
        let target = f.target();
        install(Some(&source), &target).unwrap();
        let original = fs::read(target.join("host-state.json")).unwrap();
        fs::write(target.join("current-library-file"), b"current library").unwrap();
        INTERRUPT.with(|point| point.set(Some(phase)));
        let crashed = std::panic::catch_unwind(AssertUnwindSafe(|| {
            install_with_options(Some(&source), &target, true)
        }));
        INTERRUPT.with(|point| point.set(None));
        assert!(crashed.is_err());
        assert!(NativeHostStorage::open(&target).is_err());
        let recovered = install(None, &target).unwrap();
        assert_eq!(recovered["completed"], phase == "installed");
        if phase != "installed" {
            assert_eq!(fs::read(target.join("host-state.json")).unwrap(), original);
            assert_eq!(
                fs::read(target.join("current-library-file")).unwrap(),
                b"current library"
            );
        } else {
            let backup = Path::new(recovered["backup"].as_str().unwrap());
            assert_eq!(
                fs::read(backup.join("current-library-file")).unwrap(),
                b"current library"
            );
        }
        assert!(!import_guard_path(&target, "json").unwrap().exists());
    }
}

#[cfg(unix)]
#[test]
fn import_guard_paths_preserve_native_non_utf8_components() {
    use std::os::unix::ffi::OsStringExt;
    let f = Fixture::new();
    let target = f.0.join(OsString::from_vec(b"data-\xff".to_vec()));
    for suffix in ["lock", "json"] {
        let guard = import_guard_path(&target, suffix).unwrap();
        let mut expected = b".data-\xff.bilikara-import.".to_vec();
        expected.extend_from_slice(suffix.as_bytes());
        assert_eq!(guard.parent(), Some(f.0.as_path()));
        assert_eq!(
            guard.file_name(),
            Some(OsString::from_vec(expected).as_os_str())
        );
    }
}

// Linux filesystems admit these raw byte names. macOS HFS+/APFS require valid
// UTF-8 names; their rejection is checked independently below.
#[cfg(target_os = "linux")]
#[test]
fn normal_storage_keeps_native_non_utf8_paths_without_import_files() {
    use std::os::unix::ffi::OsStringExt;
    let f = Fixture::new();
    let target = f.0.join(OsString::from_vec(b"data-\xff".to_vec()));
    let (storage, state) = NativeHostStorage::open(&target).unwrap();
    assert!(state.is_none());
    assert!(!import_guard_path(&target, "lock").unwrap().exists());
    drop(storage);
    assert!(NativeHostStorage::open(&target).is_ok());
}

#[cfg(target_os = "macos")]
#[test]
fn unsupported_non_utf8_storage_name_fails_without_import_files() {
    use std::os::unix::ffi::OsStringExt;
    let f = Fixture::new();
    let target = f.0.join(OsString::from_vec(b"data-\xff".to_vec()));
    let error = match NativeHostStorage::open(&target) {
        Ok(_) => panic!("macOS must reject the unsupported filename"),
        Err(error) => error,
    };
    assert_eq!(error.kind, "native_storage_io");
    assert!(!target.exists());
    assert_eq!(fs::read_dir(&f.0).unwrap().count(), 0);
}

#[cfg(unix)]
#[test]
fn linked_sources_destinations_and_recovery_workspaces_are_rejected() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    let source = f.source();
    f.populate(&source);
    let linked = f.0.join("linked");
    symlink(&source, &linked).unwrap();
    assert!(legacy_root(&linked).is_err());
    let target = f.0.join("target-link");
    symlink(source.join("data"), &target).unwrap();
    assert!(install(Some(&source), &target).is_err());
    fs::remove_file(source.join("data/history.json")).unwrap();
    symlink(f.0.join("outside"), source.join("data/history.json")).unwrap();
    assert!(install(Some(&source), &f.target()).is_err());
    assert!(!f.target().join("host-state.json").exists());

    let work = format!(".bilikara-import-{}", "a".repeat(32));
    symlink(&source, f.0.join(&work)).unwrap();
    let recovery_target = f.0.join("recovery");
    let guard = import_guard_path(&recovery_target, "json").unwrap();
    fs::write(
        &guard,
        json!({"schema_version":1,"destination":"recovery","work":work,"had_data":false})
            .to_string(),
    )
    .unwrap();
    assert!(install(None, &recovery_target).is_err());
    assert!(guard.exists());
    assert!(!recovery_target.exists());
}
