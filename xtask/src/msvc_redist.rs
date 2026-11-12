//! App-local VC14 release CRTs for the executable that imports them. Only the
//! selected MSVC redistributable directory is a construction input; neither
//! PATH nor the build machine's system DLLs supply product dependencies.
use crate::{
    Result,
    config::{Config, Os, Platform},
    files, libav,
};
use object::{Object, ObjectKind, read::pe::PeFile64};
use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
};

const CRTS: &[&str] = &[
    "vcruntime140.dll",
    "vcruntime140_1.dll",
    "msvcp140.dll",
    "msvcp140_1.dll",
    "msvcp140_2.dll",
    "msvcp140_atomic_wait.dll",
    "msvcp140_codecvt_ids.dll",
    "concrt140.dll",
];

fn crt_imports(path: &Path, platform: Platform) -> Result<BTreeSet<String>> {
    let mut names = BTreeSet::new();
    for name in libav::binary_imports(path, platform)? {
        if CRTS.contains(&name.as_str()) {
            names.insert(name);
        } else if ["vcruntime140", "msvcp140", "concrt140", "vccorlib140"]
            .iter()
            .any(|prefix| name.starts_with(prefix))
        {
            return Err(format!("Unsupported VC14 CRT import: {name}").into());
        }
    }
    Ok(names)
}

fn selected_directory(config: &Config) -> Result<PathBuf> {
    let explicit = config.env.text("BILIKARA_MSVC_REDIST_DIR");
    let path = if !explicit.is_empty() {
        PathBuf::from(explicit)
    } else {
        let root = PathBuf::from(config.env.text("VCToolsRedistDir"));
        if !root.is_absolute() || !root.is_dir() {
            return Err("App-local CRT packaging requires BILIKARA_MSVC_REDIST_DIR or the selected native MSVC VCToolsRedistDir".into());
        }
        let arch = root.join(config.platform.arch());
        let candidates = fs::read_dir(&arch)?
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
                name.starts_with("microsoft.vc") && name.ends_with(".crt") && entry.path().is_dir()
            })
            .map(|entry| entry.path())
            .collect::<Vec<_>>();
        if candidates.len() != 1 {
            return Err("Expected exactly one selected Microsoft.VC*.CRT directory".into());
        }
        candidates.into_iter().next().unwrap()
    };
    if !path.is_absolute() || !path.is_dir() {
        return Err("BILIKARA_MSVC_REDIST_DIR must name an absolute MSVC CRT directory".into());
    }
    Ok(path.canonicalize()?)
}

fn runtime_files(directory: &Path) -> Result<BTreeMap<String, PathBuf>> {
    let mut paths = BTreeMap::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        if CRTS.contains(&name.as_str()) && paths.insert(name, entry.path()).is_some() {
            return Err("Duplicate case-insensitive app-local CRT filename".into());
        }
    }
    Ok(paths)
}

fn closure(
    roots: &[PathBuf],
    directory: &Path,
    available: &BTreeMap<String, PathBuf>,
    platform: Platform,
) -> Result<BTreeSet<String>> {
    let mut pending = BTreeSet::new();
    for root in roots {
        pending.extend(crt_imports(root, platform)?);
    }
    let mut result = BTreeSet::new();
    while let Some(name) = pending.pop_first() {
        if !result.insert(name.clone()) {
            continue;
        }
        let path = available
            .get(&name)
            .ok_or_else(|| format!("Missing required app-local MSVC CRT: {name}"))?;
        let metadata = fs::symlink_metadata(path)?;
        if !metadata.is_file()
            || metadata.is_symlink()
            || path.canonicalize()?.parent() != Some(directory.canonicalize()?.as_path())
        {
            return Err(format!(
                "MSVC CRT must be a regular file in its selected directory: {name}"
            )
            .into());
        }
        // Check the machine and imports without executing a source DLL.
        pending.extend(crt_imports(path, platform)?);
        let bytes = fs::read(path)?;
        if PeFile64::parse(bytes.as_slice())?.kind() != ObjectKind::Dynamic {
            return Err(format!("Expected a native MSVC CRT DLL: {name}").into());
        }
    }
    Ok(result)
}

/// Resolve and validate this construction input before release output cleanup.
pub fn input_directory(config: &Config, roots: &[PathBuf]) -> Result<Option<PathBuf>> {
    if config.platform.os != Os::Windows {
        return Ok(None);
    }
    let mut required = BTreeSet::new();
    for root in roots {
        required.extend(crt_imports(root, config.platform)?);
    }
    if required.is_empty() {
        return Ok(None);
    }
    let source = selected_directory(config)?;
    closure(roots, &source, &runtime_files(&source)?, config.platform)?;
    Ok(Some(source))
}

fn resolved_output(path: &Path) -> Result<PathBuf> {
    if path.exists() || path.is_symlink() {
        return Ok(path.canonicalize()?);
    }
    let parent = path.parent().ok_or("App-local CRT output has no parent")?;
    let name = path.file_name().ok_or("Invalid app-local CRT output")?;
    Ok(resolved_output(parent)?.join(name))
}

pub fn stage(config: &Config, roots: &[PathBuf], destination: &Path) -> Result<()> {
    if config.platform.os != Os::Windows {
        return Ok(());
    }
    // Static-CRT executables need no MSVC input. Ordinary release executables
    // with a direct VC14 import must never depend on the builder's installation.
    let (available, needed) = if let Some(source) = input_directory(config, roots)? {
        let output = resolved_output(destination)?;
        if source.starts_with(&output) || output.starts_with(&source) {
            return Err(
                "App-local CRT source and generated output must be separate directories".into(),
            );
        }
        let available = runtime_files(&source)?;
        let needed = closure(roots, &source, &available, config.platform)?;
        (available, needed)
    } else {
        (BTreeMap::new(), BTreeSet::new())
    };
    fs::create_dir_all(destination)?;
    // Only known generated CRT files are replaced/removed, after the complete
    // new input closure has passed validation.
    let previous = runtime_files(destination)?;
    for path in previous.values() {
        let metadata = fs::symlink_metadata(path)?;
        if !metadata.is_file() || metadata.is_symlink() {
            return Err("Refusing a linked or non-file generated app-local CRT".into());
        }
    }
    for (name, path) in &previous {
        if !needed.contains(name) {
            fs::remove_file(path)?;
        }
    }
    for name in needed {
        let path = destination.join(&name);
        let temporary = tempfile::NamedTempFile::new_in(destination)?;
        files::copy(&available[&name], temporary.path())?;
        temporary.persist(&path)?;
        if let Some(previous) = previous.get(&name)
            && previous.file_name() != path.file_name()
        {
            #[cfg(not(windows))]
            fs::remove_file(previous)?;
        }
    }
    Ok(())
}

/// Legacy packages without any app-local CRT retain their prior acceptance.
/// Once present, the directory must contain the exact native closure required
/// by these executables; a whitelisted but unused DLL is still invalid.
pub fn installed(
    directory: &Path,
    roots: &[PathBuf],
    platform: Platform,
) -> Result<BTreeSet<OsString>> {
    if platform.os != Os::Windows {
        return Ok(BTreeSet::new());
    }
    let available = runtime_files(directory)?;
    if available.is_empty() {
        return Ok(BTreeSet::new());
    }
    let needed = closure(roots, directory, &available, platform)?;
    if needed != available.keys().cloned().collect() {
        return Err("Unexpected app-local CRT outside the executable import closure".into());
    }
    Ok(available
        .values()
        .map(|path| path.file_name().unwrap().to_owned())
        .collect())
}

#[cfg(test)]
pub(crate) mod tests;
