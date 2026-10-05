//! Explicit offline desktop import: narrowly discover legacy roots, then stage,
//! validate and install using the existing reader. No Host, media or networking.
use super::{desktop, desktop_import};
use crate::native_host_storage::import_guard_path;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    ffi::OsString,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum Format {
    Missing,
    Empty,
    Legacy,
    Native,
    Unknown,
    Incomplete,
}

fn format(data: &Path) -> Result<Format, String> {
    match fs::symlink_metadata(data) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Format::Missing),
        Ok(m) if m.is_dir() => {}
        _ => return Err("Data directory must be a real readable directory, not a link".into()),
    }
    if data.join("desktop-import.pending").exists() {
        return Ok(Format::Incomplete);
    }
    // A corrupt native checkpoint remains protected, never classified as legacy.
    if fs::symlink_metadata(data.join("host-state.json")).is_ok() {
        return Ok(Format::Native);
    }
    for name in [
        "player_state.json",
        "history.json",
        "session_users.json",
        "playlist_backup.json",
        "state.json",
    ] {
        if fs::symlink_metadata(data.join(name)).is_ok() {
            return Ok(Format::Legacy);
        }
    }
    if data.join("played_sessions").is_dir() {
        return Ok(Format::Legacy);
    }
    match fs::read_dir(data)
        .map_err(|_| "Cannot inspect data directory")?
        .next()
    {
        None => Ok(Format::Empty),
        Some(_) => Ok(Format::Unknown),
    }
}

fn legacy_root(selected: &Path) -> Result<PathBuf, String> {
    if !selected.is_absolute() || !fs::symlink_metadata(selected).is_ok_and(|m| m.is_dir()) {
        return Err("Select an absolute real legacy data folder".into());
    }
    let root = selected
        .canonicalize()
        .map_err(|_| "Cannot resolve old data folder")?;
    let mut choices = vec![
        root.clone(),
        root.join("runtime"),
        root.join("Contents/MacOS/runtime"),
    ];
    if root.file_name().is_some_and(|name| name == "data")
        && let Some(parent) = root.parent()
    {
        choices.insert(0, parent.to_owned());
    }
    let mut native_source = false;
    for candidate in choices {
        let kind = format(&candidate.join("data")).ok();
        native_source |= kind == Some(Format::Native);
        if kind == Some(Format::Legacy) {
            return candidate
                .canonicalize()
                .map_err(|_| "Cannot resolve legacy root".into());
        }
    }
    if native_source {
        return Err("Selected folder contains native-format records; follow the native-data upgrade instructions instead of legacy conversion".into());
    }
    Err("No supported legacy records found; select the old runtime folder, its data folder, or the old application-data root".into())
}

fn discover(
    destination: &Path,
    executable: &Path,
    platform: &str,
    env: impl Fn(&str) -> Option<OsString>,
) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(parent) = destination.parent() {
        roots.push(parent.to_owned());
    }
    if let Some(parent) = executable.parent() {
        roots.push(
            if parent.ends_with("_internal") {
                parent.parent().unwrap_or(parent)
            } else {
                parent
            }
            .join("runtime"),
        );
    }
    if platform == "windows" {
        for key in ["LOCALAPPDATA", "APPDATA"] {
            if let Some(path) = env(key).filter(|v| !v.is_empty()) {
                roots.push(PathBuf::from(path).join("bilikara"));
            }
        }
    } else if let Some(home) = env("HOME").filter(|v| !v.is_empty()).map(PathBuf::from) {
        if platform == "macos" {
            roots.push(home.join("Library/Application Support/bilikara"));
            for parent in [PathBuf::from("/Applications"), home.join("Applications")] {
                for app in ["bilikara.app", "bilikara-backend.app"] {
                    roots.push(parent.join(app).join("Contents/MacOS/runtime"));
                }
            }
        } else {
            roots.push(
                env("XDG_DATA_HOME")
                    .filter(|v| !v.is_empty())
                    .map(PathBuf::from)
                    .unwrap_or_else(|| home.join(".local/share"))
                    .join("bilikara"),
            );
        }
    }
    let mut seen = HashSet::new();
    roots
        .into_iter()
        .filter_map(|root| legacy_root(&root).ok())
        .filter(|root| seen.insert(root.clone()))
        .collect()
}

fn inspect(
    destination: &Path,
    executable: &Path,
    platform: &str,
    source: Option<&Path>,
    env: impl Fn(&str) -> Option<OsString>,
) -> Result<Value, String> {
    let candidates = if let Some(source) = source {
        vec![legacy_root(source)?]
    } else {
        discover(destination, executable, platform, env)
    };
    Ok(json!({"schema_version":1,"destination":destination,
        "destination_status":format(destination)?,
        "pending":fs::symlink_metadata(import_guard_path(destination, "json")?).is_ok(),
        "candidates":candidates}))
}

fn inspect_first_start(
    destination: &Path,
    executable: &Path,
    platform: &str,
    env: impl Fn(&str) -> Option<OsString>,
) -> Result<Value, String> {
    let kind = format(destination)?;
    let pending = fs::symlink_metadata(import_guard_path(destination, "json")?).is_ok();
    // Reopening a native library never scans other locations or offers to
    // overwrite it. Malformed checkpoints remain native and protected.
    let candidates = if !pending && matches!(kind, Format::Missing | Format::Empty | Format::Legacy)
    {
        discover(destination, executable, platform, env)
    } else {
        Vec::new()
    };
    Ok(json!({"schema_version":1,"destination":destination,
        "destination_status":kind,"pending":pending,"candidates":candidates}))
}

fn private_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    options
}

fn directory(path: &Path) -> Result<(), String> {
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(path)
        .map_err(|_| "Cannot create private import staging directory".into())
}

fn real(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(m) if !m.file_type().is_symlink() => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        _ => Err("Import path is unreadable or a link; data preserved".into()),
    }
}

fn destination(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("Import destination must be an absolute native path without traversal".into());
    }
    real(path)?;
    let parent = path.parent().ok_or("Missing import destination parent")?;
    fs::create_dir_all(parent).map_err(|_| "Cannot create destination parent")?;
    let parent = parent
        .canonicalize()
        .map_err(|_| "Cannot resolve destination parent")?;
    Ok(parent.join(path.file_name().ok_or("Missing destination name")?))
}

fn lock(destination: &Path) -> Result<File, String> {
    let path = import_guard_path(destination, "lock")?;
    real(&path)?;
    let file = private_options()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|_| "Cannot open import lock")?;
    fs2::FileExt::try_lock_exclusive(&file)
        .map_err(|_| "Another Host or import tool owns this data directory")?;
    Ok(file)
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Plan {
    schema_version: u32,
    destination: String,
    work: String,
    had_data: bool,
    #[serde(default)]
    replaced_native: bool,
}

fn read_plan(destination: &Path) -> Result<Plan, String> {
    let path = import_guard_path(destination, "json")?;
    real(&path)?;
    let mut bytes = Vec::new();
    private_options()
        .read(true)
        .open(path)
        .and_then(|f| f.take(8193).read_to_end(&mut bytes))
        .map_err(|_| "Cannot read pending import; data preserved")?;
    let plan: Plan =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid pending import; data preserved")?;
    if bytes.len() > 8192
        || plan.schema_version != 1
        || Some(plan.destination.as_str()) != destination.file_name().and_then(|s| s.to_str())
        || plan.work.len() != ".bilikara-import-".len() + 32
        || !plan.work.starts_with(".bilikara-import-")
        || !plan.work[".bilikara-import-".len()..]
            .bytes()
            .all(|b| b.is_ascii_hexdigit())
    {
        return Err("Unsafe pending import path; data preserved".into());
    }
    Ok(plan)
}

fn clear_guard(destination: &Path) -> Result<(), String> {
    fs::remove_file(import_guard_path(destination, "json")?)
        .map_err(|_| "Cannot finish import; rerun the import tool")?;
    sync(destination.parent().unwrap())
}

fn sync(directory: &Path) -> Result<(), String> {
    crate::native_host_storage::sync_directory(directory)
        .map_err(|_| "Cannot persist import directory changes; rerun the import tool".into())
}

fn result(destination: &Path, backup: Option<&Path>, completed: bool) -> Value {
    json!({"schema_version":1,"destination":destination,"backup":backup,"completed":completed})
}

// Recovery is based on the actual staged/backup/installed directories. The
// immutable guard remains until completion or a verified rollback; never guess
// that a malformed checkpoint or an unexpected directory can be discarded.
fn recover_locked(destination: &Path) -> Result<Value, String> {
    let plan = read_plan(destination)?;
    let work = destination.parent().unwrap().join(&plan.work);
    real(&work)?;
    let backup = work.join("legacy/data");
    real(&work.join("legacy"))?;
    real(&backup)?;
    let stage = work.join("new-data");
    real(&stage)?;
    if plan.replaced_native && format(destination)? == Format::Native && !backup.exists() {
        // Before the switch, the destination is still the original native
        // library. An interrupted preparation must not report import success.
        desktop_import::validate_for_tool(destination)?;
        clear_guard(destination)?;
        return Ok(result(destination, None, false));
    }
    match format(destination)? {
        Format::Native if !stage.exists() => {
            desktop_import::validate_for_tool(destination)?;
            if plan.had_data && !backup.is_dir() {
                return Err("Import backup is missing; data preserved".into());
            }
            clear_guard(destination)?;
            Ok(result(
                destination,
                plan.had_data.then_some(backup.as_path()),
                true,
            ))
        }
        Format::Missing if plan.had_data && backup.is_dir() => {
            fs::rename(&backup, destination)
                .map_err(|_| "Cannot restore legacy backup; data preserved")?;
            sync(work.join("legacy").as_path())?;
            sync(destination.parent().unwrap())?;
            clear_guard(destination)?;
            Ok(result(destination, None, false))
        }
        Format::Missing if !plan.had_data && !backup.exists() => {
            clear_guard(destination)?;
            Ok(result(destination, None, false))
        }
        Format::Legacy | Format::Empty if plan.had_data && !backup.exists() => {
            clear_guard(destination)?;
            Ok(result(destination, None, false))
        }
        _ => Err(
            "Interrupted import has conflicting data; original and staged files preserved".into(),
        ),
    }
}

fn install(source: Option<&Path>, requested: &Path) -> Result<Value, String> {
    install_with_options(source, requested, false)
}

fn install_with_options(
    source: Option<&Path>,
    requested: &Path,
    replace_native: bool,
) -> Result<Value, String> {
    let destination = destination(requested)?;
    let _lock = lock(&destination)?;
    let pending = import_guard_path(&destination, "json")?;
    if fs::symlink_metadata(&pending).is_ok() {
        let recovered = recover_locked(&destination)?;
        if recovered["completed"] == true || source.is_none() {
            return Ok(recovered);
        }
    }
    let source = legacy_root(source.ok_or("Select an old data folder to import")?)?;
    let kind = format(&destination)?;
    match kind {
        Format::Native if !replace_native => return Err("Existing native data is protected; import will not overwrite or merge it".into()),
        Format::Legacy if destination != source.join("data") =>
            return Err("Destination contains another legacy library; select that library rather than overwrite it".into()),
        Format::Unknown | Format::Incomplete => return Err("Destination contains unrecognized or incomplete data; preserve it and choose a fresh installation".into()),
        _ => {},
    }
    let original_native = if kind == Format::Native {
        // Validate the complete checkpoint and acquire its actual storage
        // lock. This also rejects a Host that started before the import lock
        // existed. The guard below prevents new Hosts throughout the switch.
        desktop_import::validate_for_tool(&destination)?;
        Some(
            fs::read(destination.join("host-state.json"))
                .map_err(|_| "Cannot read existing native records; data preserved")?,
        )
    } else {
        None
    };
    if source.starts_with(&destination) {
        return Err("Import destination must not contain the old source".into());
    }
    if destination.starts_with(&source) && destination != source.join("data") {
        return Err("Only the old root's data directory supports an in-place import".into());
    }
    let stamp = desktop_import::source_stamp(&source)?;
    let import = desktop_import::Import::read(&source, "")?;
    let mut random = [0_u8; 16];
    getrandom::fill(&mut random).map_err(|_| "Cannot create private import identity")?;
    let nonce: String = random.iter().map(|b| format!("{b:02x}")).collect();
    let plan = Plan {
        schema_version: 1,
        destination: destination
            .file_name()
            .unwrap()
            .to_str()
            .ok_or("Non-UTF-8 destination")?
            .into(),
        work: format!(".bilikara-import-{nonce}"),
        had_data: kind != Format::Missing,
        replaced_native: original_native.is_some(),
    };
    let work = destination.parent().unwrap().join(&plan.work);
    directory(&work)?;
    let stage = work.join("new-data");
    let backup = work.join("legacy/data");
    private_options()
        .write(true)
        .create_new(true)
        .open(&pending)
        .and_then(|mut f| {
            f.write_all(&serde_json::to_vec(&plan).unwrap())
                .and_then(|()| f.sync_all())
        })
        .map_err(|_| "Cannot claim import destination; data preserved")?;
    sync(destination.parent().unwrap())?;
    let converted = (|| {
        if original_native.is_some() {
            // Also reject a Host whose initial lock lookup preceded creation
            // of our parent lock. The durable guard now blocks any new opener.
            desktop_import::validate_for_tool(&destination)?;
        }
        directory(&stage)?;
        import.publish(&stage)?;
        desktop_import::validate_for_tool(&stage)?;
        sync(&work)?;
        #[cfg(test)]
        tests::interrupt("prepared");
        if stamp != desktop_import::source_stamp(&source)? || format(&destination)? != kind {
            return Err("Old data changed during import; close both versions and try again".into());
        }
        if let Some(original) = &original_native
            && fs::read(destination.join("host-state.json")).ok().as_ref() != Some(original)
        {
            return Err("Native data changed during import; data preserved".into());
        }
        if plan.had_data {
            directory(&work.join("legacy"))?;
            fs::rename(&destination, &backup)
                .map_err(|_| "Cannot back up old data; close both versions and try again")?;
            sync(work.join("legacy").as_path())?;
            sync(destination.parent().unwrap())?;
        }
        #[cfg(test)]
        tests::interrupt("backed_up");
        fs::rename(&stage, &destination)
            .map_err(|_| "Cannot install converted data; rerun the import tool to recover")?;
        sync(&work)?;
        sync(destination.parent().unwrap())?;
        #[cfg(test)]
        tests::interrupt("installed");
        desktop_import::validate_for_tool(&destination)?;
        clear_guard(&destination)?;
        Ok(result(
            &destination,
            plan.had_data.then_some(backup.as_path()),
            true,
        ))
    })();
    if converted.is_err() {
        // Never delete original or staged records. A failed publication rolls
        // back when unambiguous, otherwise its guard requires explicit recovery.
        if let Ok(recovered) = recover_locked(&destination)
            && recovered["completed"] == true
        {
            return Ok(recovered);
        }
    }
    converted
}

pub(super) fn run(arguments: &[String]) -> Result<bool, String> {
    let inspect_mode = arguments.iter().any(|a| a == "--inspect-legacy-import");
    let first_start = arguments.iter().any(|a| a == "--inspect-first-start");
    let import_mode = arguments.iter().any(|a| a == "--import-only");
    if !inspect_mode && !first_start && !import_mode {
        return Ok(false);
    }
    if [inspect_mode, first_start, import_mode]
        .into_iter()
        .filter(|value| *value)
        .count()
        != 1
    {
        return Err("Choose inspection or import, not both".into());
    }
    let mut args = arguments.iter();
    let mut target = None;
    let mut source = None;
    let mut replace_native = false;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--inspect-legacy-import" | "--inspect-first-start" | "--import-only" => {},
            "--replace-native" if import_mode => replace_native = true,
            "--data-dir" => target = Some(PathBuf::from(args.next().ok_or("Missing native data directory")?)),
            "--import-from" => source = Some(PathBuf::from(args.next().ok_or("Missing old data folder")?)),
            _ => return Err("Offline import accepts an inspection or import mode, --data-dir, --import-from and explicit --replace-native for import only".into()),
        }
    }
    let executable = std::env::current_exe().map_err(|_| "Cannot resolve desktop executable")?;
    let target = desktop::paths::import_data_root(target, &executable, desktop::PLATFORM, |key| {
        std::env::var_os(key)
    })?;
    if first_start && source.is_some() {
        return Err("First-start inspection discovers known roots; use explicit inspection to select a folder".into());
    }
    let report = if first_start {
        inspect_first_start(&target, &executable, desktop::PLATFORM, |key| {
            std::env::var_os(key)
        })?
    } else if inspect_mode {
        inspect(
            &target,
            &executable,
            desktop::PLATFORM,
            source.as_deref(),
            |key| std::env::var_os(key),
        )?
    } else {
        if replace_native {
            install_with_options(source.as_deref(), &target, true)?
        } else {
            install(source.as_deref(), &target)?
        }
    };
    println!(
        "{}",
        serde_json::to_string(&report).map_err(|_| "Import paths must be valid UTF-8")?
    );
    Ok(true)
}

#[cfg(test)]
#[path = "desktop_import_tool_tests.rs"]
mod tests;
