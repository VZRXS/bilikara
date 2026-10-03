//! Ordinary release construction and final assembly from prepared inputs.
use crate::{
    Result, build_backend_executable, compliance,
    config::{Config, Os},
    files, libav, macos, tools,
};
use serde_json::Value;
use std::{
    fs,
    path::{Component, Path, PathBuf},
    process::Command,
};

pub fn dist_directory(config: &Config, supplied: Option<&Path>) -> Result<PathBuf> {
    let path = supplied.unwrap_or(Path::new("dist"));
    let path = if path.is_absolute() {
        path.to_owned()
    } else {
        config.root.join(path)
    };
    let mut normal = PathBuf::new();
    for part in path.components() {
        match part {
            Component::ParentDir => {
                if !normal.pop() {
                    return Err("invalid generated output path".into());
                }
            }
            Component::CurDir => {}
            part => normal.push(part.as_os_str()),
        }
    }
    let relative = normal
        .strip_prefix(&config.root)
        .map_err(|_| "release outputs must be inside repository dist/ or .tmp/")?;
    if !relative.starts_with("dist")
        && !(relative.starts_with(".tmp") && relative.components().count() > 1)
    {
        return Err("release outputs must be inside repository dist/ or .tmp/".into());
    }
    reject_links(&normal, &config.root)?;
    Ok(normal)
}

fn reject_links(path: &Path, root: &Path) -> Result<()> {
    path.strip_prefix(root)
        .map_err(|_| "generated output is outside the checkout")?;
    for parent in path.ancestors() {
        // The checkout is trusted. System ancestors such as macOS /var may be
        // links; only generated paths beneath that boundary must be link-free.
        if parent == root {
            break;
        }
        if parent.is_symlink() {
            return Err(format!("generated output path is a symlink: {}", parent.display()).into());
        }
    }
    Ok(())
}

pub fn clean_product(
    config: &Config,
    dist: &Path,
    name: &str,
    inputs: &[&Path],
) -> Result<PathBuf> {
    let dist = dist_directory(config, Some(dist))?;
    if !matches!(name, "bilikara" | "bilikara.app" | "bilikara-desktop.app") {
        return Err("invalid generated product name".into());
    }
    let destination = dist.join(name);
    reject_links(&destination, &config.root)?;
    for input in inputs {
        let input = input.canonicalize()?;
        // The destination itself may not exist; its checked ancestors contain
        // no links. Compare against real input roots before recursive deletion.
        let root = config.root.canonicalize()?;
        let canonical_destination = root.join(destination.strip_prefix(&config.root)?);
        if input.starts_with(&canonical_destination) || canonical_destination.starts_with(&input) {
            return Err("generated product overlaps a prepared input".into());
        }
    }
    for relative in [
        "runtime",
        "data",
        "Contents/Resources/runtime",
        "Contents/Resources/data",
    ] {
        if destination.join(relative).exists() {
            return Err(format!(
                "refusing to clean product containing user data: {}",
                destination.display()
            )
            .into());
        }
    }
    if destination.exists() {
        fs::remove_dir_all(&destination)?;
    }
    fs::create_dir_all(&dist)?;
    Ok(destination)
}

pub fn backend_path(config: &Config, dist: &Path) -> PathBuf {
    dist.join(if config.platform.os == Os::Macos {
        "bilikara.app"
    } else {
        "bilikara"
    })
}

pub fn build_backend(config: &Config, dist: &Path) -> Result<PathBuf> {
    let prefix = libav::prefix(config)?
        .ok_or("BILIKARA_LIBAV_PREFIX is required for a complete native bundle")?;
    let mut inputs = compliance::input_files(config)?;
    inputs.extend(tools::bbdown_path(config)?);
    let executable = build_backend_executable(config)?;
    let name = if config.platform.os == Os::Macos {
        "bilikara.app"
    } else {
        "bilikara"
    };
    let mut input_refs = vec![prefix.as_path(), executable.as_path()];
    input_refs.extend(inputs.iter().map(PathBuf::as_path));
    let destination = clean_product(config, dist, name, &input_refs)?;
    files::stage_resources(
        config,
        &destination,
        &executable,
        Some(&prefix),
        config.platform.os == Os::Macos,
    )?;
    compliance::write(
        config,
        &files::Layout::new(&destination, config.platform.os == Os::Macos).docs,
    )?;
    if config.platform.os == Os::Macos {
        macos::finalize_backend(config, &destination)?;
    }
    Ok(destination)
}

pub fn shell_path(config: &Config) -> Result<PathBuf> {
    let output = config.target_output("src-tauri")?;
    Ok(output.join(if config.platform.os == Os::Macos {
        "bundle/macos/bilikara.app"
    } else if config.platform.os == Os::Windows {
        "bilikara.exe"
    } else {
        "bilikara"
    }))
}

pub fn build_shell(config: &Config) -> Result<PathBuf> {
    let mut command = Command::new(if config.platform.os == Os::Windows {
        "npm.cmd"
    } else {
        "npm"
    });
    command
        .current_dir(&config.root)
        .args(["exec", "--", "tauri", "build"]);
    if config.platform.os == Os::Macos {
        command.args(["--bundles", "app"]);
    } else {
        command.arg("--no-bundle");
    }
    if let Some(target) = &config.target {
        command.arg("--target").arg(target);
    }
    command.args(["--", "--locked"]);
    if !command.status()?.success() {
        return Err("Tauri release build failed".into());
    }
    shell_path(config)
}

fn check_backend(config: &Config, backend: &Path) -> Result<()> {
    reject_links(backend, &config.root)?;
    let layout = files::Layout::new(backend, config.platform.os == Os::Macos);
    reject_links(&layout.resources, &config.root)?;
    reject_links(&layout.code, &config.root)?;
    let facts: Value =
        serde_json::from_slice(&fs::read(layout.resources.join("native-desktop.json"))?)?;
    if facts["schema_version"] != 1
        || facts["backend"] != "rust"
        || facts["resource_layout"] != "internal-v1"
        || facts["development"] != false
        || facts["platform"] != config.platform.name()
        || facts["arch"] != config.platform.arch()
    {
        return Err("assembly requires the matching release backend layout".into());
    }
    let version = fs::read_to_string(layout.resources.join("APP_VERSION"))?;
    if facts["version"].as_str() != Some(version.trim()) {
        return Err("release backend version/manifest mismatch".into());
    }
    for name in ["bilikara-desktop-host", "bilikara-updater"] {
        libav::binary_imports(
            &layout.code.join(config.platform.executable(name)),
            config.platform,
        )?;
    }
    Ok(())
}

pub fn assemble(config: &Config, dist: &Path, shell: &Path) -> Result<PathBuf> {
    let shell = if shell.is_absolute() {
        shell.to_owned()
    } else {
        config.root.join(shell)
    };
    let backend = backend_path(config, dist);
    check_backend(config, &backend)?;
    if config.platform.os == Os::Macos {
        let desktop = clean_product(config, dist, "bilikara-desktop.app", &[&backend, &shell])?;
        macos::copy_app(&shell, &desktop)?;
        macos::embed_backend(&backend, &desktop)?;
        Ok(desktop)
    } else {
        libav::binary_imports(&shell, config.platform)?;
        if backend.join("runtime").exists() || backend.join("data").exists() {
            return Err("refusing to assemble into product containing user data".into());
        }
        let launcher = backend.join(config.platform.executable("bilikara-desktop"));
        reject_links(&launcher, &config.root)?;
        files::copy(&shell, &launcher)?;
        Ok(backend)
    }
}
