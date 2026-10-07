use crate::{
    Result,
    config::{Config, Os},
    libav, macos, tools,
};
use serde_json::json;
use std::{
    fs,
    path::{Path, PathBuf},
};

// The two existing package layouts. Development always uses the adjacent
// internal layout, including on macOS; final macOS code lives in Frameworks.
pub struct Layout {
    pub resources: PathBuf,
    pub code: PathBuf,
    pub vendor: PathBuf,
    pub docs: PathBuf,
    pub macos_app: bool,
}
impl Layout {
    pub fn new(destination: &Path, macos_app: bool) -> Self {
        let resources = destination.join(if macos_app {
            "Contents/Resources"
        } else {
            "_internal"
        });
        Self {
            code: if macos_app {
                destination.join("Contents/MacOS")
            } else {
                resources.clone()
            },
            vendor: if macos_app {
                destination.join("Contents/Frameworks")
            } else {
                resources.join("vendor")
            },
            docs: if macos_app {
                resources.join("license")
            } else {
                destination.join("license")
            },
            resources,
            macos_app,
        }
    }
}

pub fn relative_link(target: &Path, link: &Path) -> Result<()> {
    if target.is_absolute() {
        return Err("bundle links must be relative".into());
    }
    if link.exists() || link.is_symlink() {
        fs::remove_file(link)?;
    }
    fs::create_dir_all(link.parent().ok_or("missing link parent")?)?;
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link)?;
        Ok(())
    }
    #[cfg(not(unix))]
    Err("macOS bundle assembly requires a POSIX runner".into())
}

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
    stage_resources(config, destination, executable, prefix, false)
}

pub fn stage_resources(
    config: &Config,
    destination: &Path,
    executable: &Path,
    prefix: Option<&Path>,
    macos_app: bool,
) -> Result<()> {
    let layout = Layout::new(destination, macos_app);
    let resources = &layout.resources;
    let vendor = resources.join("vendor");
    let docs = &layout.docs;
    for directory in [&vendor, &layout.vendor, &layout.code] {
        fs::create_dir_all(directory)?;
    }
    for name in ["bilikara-desktop-host", "bilikara-updater"] {
        let name = config.platform.executable(name);
        let source = if name.starts_with("bilikara-desktop-host") {
            executable.to_owned()
        } else {
            executable.with_file_name(&name)
        };
        let to = layout.code.join(name);
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
    if macos_app {
        macos::write_backend_plist(config, destination, &version)?;
    }
    if let Some(tool) = tools::bbdown(config)? {
        let filename = config.platform.executable("BBDown");
        for entry in fs::read_dir(&layout.vendor)? {
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
        copy(&tool, &layout.vendor.join(&filename))?;
        if macos_app {
            relative_link(
                &Path::new("../../Frameworks").join(&filename),
                &vendor.join(filename),
            )?;
        }
    } else if !config.development {
        return Err("Prepare the pinned BBDown vendor before packaging".into());
    }
    if config.platform.os == Os::Macos {
        tools::aria2_metadata(config, &vendor)?;
    }
    if let Some(prefix) = prefix {
        libav::stage(config, prefix, &layout)?;
    }
    Ok(())
}
