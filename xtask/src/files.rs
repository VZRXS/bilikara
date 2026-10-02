use crate::{
    Result,
    config::{Config, Os},
    libav, tools,
};
use serde_json::json;
use std::{fs, path::Path};

pub fn copy(source: &Path, destination: &Path) -> Result<()> {
    let same = destination.exists() && source.canonicalize()? == destination.canonicalize()?;
    #[cfg(unix)]
    let same = if destination.exists() {
        use std::os::unix::fs::MetadataExt;
        let from = fs::metadata(source)?;
        let to = fs::metadata(destination)?;
        same || (from.dev(), from.ino()) == (to.dev(), to.ino())
    } else {
        same
    };
    if same {
        return Err(format!(
            "source and destination are the same file: {}",
            source.display()
        )
        .into());
    }
    fs::create_dir_all(destination.parent().ok_or("missing destination parent")?)?;
    fs::copy(source, destination)?; // Like copy2, follows source links and preserves mode.
    Ok(())
}

pub fn tree(source: &Path, destination: &Path, vendor: bool) -> Result<()> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        if vendor && (entry.file_name() == "LICENSE.txt" || entry.file_name() == "README.md") {
            continue;
        }
        let from = entry.path();
        let to = destination.join(entry.file_name());
        if from.is_dir() {
            tree(&from, &to, vendor)?;
        } else {
            copy(&from, &to)?;
        }
    }
    fs::set_permissions(destination, fs::metadata(source)?.permissions())?;
    Ok(())
}

pub fn write_json(path: &Path, value: &serde_json::Value) -> Result<()> {
    fs::write(path, format!("{}\n", serde_json::to_string_pretty(value)?))?;
    Ok(())
}

pub fn stage(
    config: &Config,
    destination: &Path,
    executable: &Path,
    prefix: Option<&Path>,
) -> Result<()> {
    let resources = destination.join("_internal");
    let vendor = resources.join("vendor");
    let docs = destination.join("license");
    fs::create_dir_all(&vendor)?;
    for name in ["bilikara-desktop-host", "bilikara-updater"] {
        let name = config.platform.executable(name);
        let source = if name.starts_with("bilikara-desktop-host") {
            executable.to_owned()
        } else {
            executable.with_file_name(&name)
        };
        let to = resources.join(name);
        if source.canonicalize()? != to.canonicalize().unwrap_or_else(|_| to.clone()) {
            copy(&source, &to)?;
        }
    }
    let assets = resources.join("static");
    // Only this generated resource tree is replaced. Never remove target/ or
    // adjacent runtime/, user data, caches or a whole installation.
    if assets.exists() {
        fs::remove_dir_all(&assets)?;
    }
    fs::create_dir_all(&assets)?;
    let source_static = config.root.join("static");
    for entry in fs::read_dir(&source_static)? {
        let entry = entry?;
        if entry.file_name() == "vendor" {
            continue;
        }
        if entry.path().is_dir() {
            tree(&entry.path(), &assets.join(entry.file_name()), false)?;
        } else {
            copy(&entry.path(), &assets.join(entry.file_name()))?;
        }
    }
    fs::set_permissions(&assets, fs::metadata(&source_static)?.permissions())?;
    if source_static.join("vendor").is_dir() {
        tree(&source_static.join("vendor"), &vendor, true)?;
        for name in ["LICENSE.txt", "README.md"] {
            let relative = Path::new("signalsmith-stretch").join(name);
            let source = source_static.join("vendor").join(&relative);
            if source.is_file() {
                copy(&source, &docs.join("THIRD_PARTY_LICENSES").join(&relative))?;
                let stale = vendor.join(relative);
                if stale.exists() || stale.is_symlink() {
                    fs::remove_file(stale)?;
                }
            }
        }
    }
    let version = config.version()?;
    fs::write(resources.join("APP_VERSION"), format!("{version}\n"))?;
    write_json(
        &resources.join("native-desktop.json"),
        &json!({"schema_version":1,"backend":"rust","version":version,
        "resource_layout":"internal-v1","platform":config.platform.name(),"arch":config.platform.arch(),"development":config.development}),
    )?;
    if let Some(tool) = tools::bbdown(config)? {
        let filename = config.platform.executable("BBDown");
        for entry in fs::read_dir(&vendor)? {
            let entry = entry?;
            if entry.file_name() != filename.as_str()
                && entry
                    .file_name()
                    .to_string_lossy()
                    .eq_ignore_ascii_case(&filename)
            {
                fs::remove_file(entry.path())?;
            }
        }
        copy(&tool, &vendor.join(filename))?;
    } else if !config.development {
        return Err("Prepare the pinned BBDown vendor before packaging".into());
    }
    if config.platform.os == Os::Macos {
        tools::aria2_metadata(config, &vendor)?;
    }
    if let Some(prefix) = prefix {
        libav::stage(config, prefix, &resources, &docs)?;
    }
    Ok(())
}
