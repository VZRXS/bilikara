//! Independent inspection and execution of a supplied, already-built package.
//! No construction, repair, application Runtime linkage or source-tree fallback.
mod host;
#[cfg(test)]
mod installed;
#[cfg(test)]
mod tests;

use crate::{
    Result,
    config::{Os, Platform},
};
use host::RunningHost;
use regex::Regex;
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    fs,
    io::Read,
    path::{Path, PathBuf},
};
use tempfile::TempDir;

pub(super) fn require(condition: bool, message: &str) -> Result<()> {
    if condition {
        Ok(())
    } else {
        Err(message.into())
    }
}

pub(super) fn resources(executable: &Path) -> PathBuf {
    let parent = executable.parent().unwrap();
    if parent.file_name().is_some_and(|n| n == "MacOS")
        && parent
            .parent()
            .unwrap()
            .file_name()
            .is_some_and(|n| n == "Contents")
    {
        parent.parent().unwrap().join("Resources")
    } else {
        parent.to_owned()
    }
}

pub(super) fn package_root(executable: &Path) -> PathBuf {
    let root = resources(executable);
    if root.file_name().is_some_and(|n| n == "Resources") {
        let app = root.parent().unwrap().parent().unwrap();
        if app.file_name().is_some_and(|n| n == "bilikara-backend.app")
            && app
                .parent()
                .unwrap()
                .file_name()
                .is_some_and(|n| n == "Frameworks")
        {
            app.parent()
                .unwrap()
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .to_owned()
        } else {
            app.to_owned()
        }
    } else if root.file_name().is_some_and(|n| n == "_internal") {
        root.parent().unwrap().to_owned()
    } else {
        root
    }
}

fn native_file(path: &Path, platform: Platform) -> Result<()> {
    let mut magic = [0; 4];
    fs::File::open(path)?.read_exact(&mut magic)?;
    require(
        match platform.os {
            Os::Windows => magic.starts_with(b"MZ"),
            Os::Linux => magic == *b"\x7fELF",
            Os::Macos => matches!(magic, [0xcf, 0xfa, 0xed, 0xfe] | [0xfe, 0xed, 0xfa, 0xcf]),
        },
        "Expected a native executable for the package platform",
    )?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        require(
            fs::metadata(path)?.permissions().mode() & 0o111 != 0,
            "Native executable has no executable permission",
        )?;
    }
    Ok(())
}

// Enumerate links without following directories. Links may only resolve inside
// the installation; this preserves macOS's Resources -> Frameworks code links.
fn entries(root: &Path, current: &Path, windows: bool, paths: &mut Vec<PathBuf>) -> Result<()> {
    for item in fs::read_dir(current)? {
        let path = item?.path();
        if windows && path == root.join("runtime") {
            continue;
        }
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() {
            require(
                !fs::read_link(&path)?.is_absolute() && path.canonicalize()?.starts_with(root),
                "Package link escapes the installation",
            )?;
        } else if metadata.is_dir() {
            entries(root, &path, windows, paths)?;
        } else {
            require(metadata.is_file(), "Unsupported package file type")?;
        }
        paths.push(path);
    }
    Ok(())
}

pub(super) fn inspect(executable: &Path, expected: &str, platform: Platform) -> Result<Value> {
    let root = resources(executable);
    let package = package_root(executable).canonicalize()?;
    let facts: Value = serde_json::from_slice(&fs::read(root.join("native-desktop.json"))?)?;
    require(
        facts["schema_version"] == 1
            && facts["backend"] == "rust"
            && facts["resource_layout"] == "internal-v1"
            && facts["development"] == false,
        "Expected a release product layout",
    )?;
    let version = facts["version"].as_str().ok_or("Missing package version")?;
    require(
        !version.is_empty() && fs::read_to_string(root.join("APP_VERSION"))?.trim() == version,
        "APP_VERSION disagrees with native-desktop.json",
    )?;
    require(
        expected.is_empty() || version == expected,
        "Release version mismatch",
    )?;
    require(
        facts["platform"] == platform.name() && facts["arch"] == platform.arch(),
        "Package does not match the executing native platform/architecture",
    )?;
    for name in [
        "static/fonts/SourceHanSans-VF.ttf",
        "vendor/signalsmith-stretch/SignalsmithStretch.js",
        "vendor/ffmpeg-runtime.json",
    ] {
        require(
            root.join(name).is_file(),
            &format!("Missing package resource: {name}"),
        )?;
    }
    require(
        !root.join("static/vendor").exists(),
        "Third-party assets must share one vendor directory",
    )?;
    if root.file_name().is_some_and(|n| n == "_internal") {
        let mut names = fs::read_dir(&package)?
            .map(|e| e.map(|e| e.file_name()))
            .collect::<std::io::Result<BTreeSet<_>>>()?;
        if platform.os == Os::Windows && package.join("runtime").is_dir() {
            names.remove(std::ffi::OsStr::new("runtime"));
        }
        let allowed = [
            "_internal".into(),
            "license".into(),
            platform.executable("bilikara-desktop").into(),
        ]
        .into_iter()
        .collect();
        require(names == allowed, "Unexpected desktop top-level entries")?;
    }
    let docs = if root.file_name().is_some_and(|n| n == "Resources") {
        root.join("license")
    } else {
        package.join("license")
    };
    for name in [
        "LICENSE",
        "LEGAL.md",
        "THIRD_PARTY_NOTICES.md",
        "THIRD_PARTY_LICENSES/libav-source.txt",
        "THIRD_PARTY_LICENSES/libav/COPYING.LGPLv2.1",
        "THIRD_PARTY_LICENSES/BBDown-LICENSE.txt",
        "THIRD_PARTY_LICENSES/signalsmith-stretch/LICENSE.txt",
    ] {
        require(
            docs.join(name).is_file(),
            &format!("Missing product license: {name}"),
        )?;
    }
    require(
        !docs.join("native-desktop.md").exists(),
        "Engineering guide is not product payload",
    )?;
    let mut paths = Vec::new();
    entries(&package, &package, platform.os == Os::Windows, &mut paths)?;
    require(
        paths
            .iter()
            .filter(|p| p.file_name().is_some_and(|n| n == "vendor") && p.is_dir())
            .count()
            == 1,
        "Third-party assets must share one vendor directory",
    )?;
    let python = Regex::new(r"^(?:lib)?python\d.*\.(?:so|dll|dylib)")?;
    for path in paths {
        let name = path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_ascii_lowercase();
        require(name != "site-packages", "Python site-packages in product")?;
        require(
            !matches!(name.as_str(), "libav-diagnostics" | "preview"),
            "Build-only directory in product",
        )?;
        if !path.is_file() {
            continue;
        }
        require(
            !name.ends_with(".pyc")
                && !name.ends_with(".pyz")
                && !python.is_match(&name)
                && !matches!(
                    name.as_str(),
                    "ffmpeg"
                        | "ffprobe"
                        | "ffmpeg.exe"
                        | "ffprobe.exe"
                        | "python"
                        | "python3"
                        | "python.exe"
                        | "pythonw.exe"
                        | "base_library.zip"
                        | "bilikara_rust.dll"
                        | "bilikara_runtime.dll"
                        | "libbilikara_rust.so"
                        | "libbilikara_runtime.so"
                        | "libbilikara_rust.dylib"
                        | "libbilikara_runtime.dylib"
                        | "bilikara_media_libav_test.dll"
                        | "libbilikara_media_libav_test.so"
                        | "libbilikara_media_libav_test.dylib"
                        | "test_shim"
                        | "test_shim.exe"
                        | "libav_metadata"
                        | "libav_metadata.exe"
                        | "libav-runtime-tests"
                        | "libav-runtime-tests.exe"
                        | "media_libav_test"
                        | "media_libav_test.exe"
                        | "libav-smoke.ps1"
                        | "libav-smoke-result.json"
                ),
            "Forbidden runtime or build-only product payload",
        )?;
    }
    native_file(executable, platform)?;
    native_file(
        &executable.with_file_name(platform.executable("bilikara-updater")),
        platform,
    )?;
    Ok(facts)
}

// Fresh, task-owned destination only. Unlike development staging, never
// dereference relative links. On macOS ditto also preserves bundle metadata.
#[cfg(not(target_os = "macos"))]
fn copy_install(source: &Path, target: &Path, top: bool) -> Result<()> {
    fs::create_dir(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        if top && entry.file_name() == "runtime" {
            continue;
        }
        let from = entry.path();
        let to = target.join(entry.file_name());
        let meta = fs::symlink_metadata(&from)?;
        if meta.file_type().is_symlink() {
            #[cfg(unix)]
            std::os::unix::fs::symlink(fs::read_link(&from)?, &to)?;
            #[cfg(windows)]
            {
                if from.is_dir() {
                    std::os::windows::fs::symlink_dir(fs::read_link(&from)?, &to)?;
                } else {
                    std::os::windows::fs::symlink_file(fs::read_link(&from)?, &to)?;
                }
            }
        } else if meta.is_dir() {
            copy_install(&from, &to, false)?;
        } else {
            fs::copy(&from, &to)?;
        }
    }
    fs::set_permissions(target, fs::metadata(source)?.permissions())?;
    Ok(())
}

pub(super) struct Installation {
    pub home: TempDir,
    pub executable: PathBuf,
    pub package: PathBuf,
}
impl Installation {
    pub fn copy(executable: &Path) -> Result<Self> {
        let home = tempfile::Builder::new()
            .prefix("native-package-空 ")
            .tempdir()?;
        let source = package_root(executable);
        let package = home
            .path()
            .join(source.file_name().ok_or("Invalid package root")?);
        #[cfg(target_os = "macos")]
        {
            let mut command = std::process::Command::new("/usr/bin/ditto");
            command.arg(&source).arg(&package);
            require(
                crate::config::timed_output(command, std::time::Duration::from_secs(60))?
                    .status
                    .success(),
                "Cannot copy supplied macOS installation",
            )?;
        }
        #[cfg(not(target_os = "macos"))]
        copy_install(&source, &package, true)?;
        let executable = package.join(executable.strip_prefix(&source)?);
        Ok(Self {
            home,
            executable,
            package,
        })
    }
}

pub fn verify(executable: &Path, expected: &str) -> Result<Value> {
    let executable = executable.canonicalize()?;
    let platform = Platform::current()?;
    let facts = inspect(&executable, expected, platform)?;
    let install = Installation::copy(&executable)?;
    let home = install.home.path();
    let external = home.join("local/bilikara");
    if platform.os == Os::Windows {
        for name in ["data/player_state.json", "native/state.json"] {
            let file = external.join(name);
            fs::create_dir_all(file.parent().unwrap())?;
            fs::write(file, b"external records must remain untouched")?;
        }
    }
    for _ in 0..2 {
        let mut host = RunningHost::start(&install.executable, home, &[])?;
        host.check(&facts)?;
        host.close()?;
    }
    if platform.os == Os::Windows {
        require(
            install
                .package
                .join("runtime/data/host-state.json")
                .is_file(),
            "Portable checkpoint missing",
        )?;
        let mut paths = Vec::new();
        entries(&external, &external, false, &mut paths)?;
        require(
            paths.iter().filter(|p| p.is_file()).count() == 2,
            "External AppData records changed",
        )?;
        for name in ["data/player_state.json", "native/state.json"] {
            require(
                fs::read(external.join(name))? == b"external records must remain untouched",
                "External AppData records changed",
            )?;
        }
    }
    Ok(
        json!({"nativeReleaseBackend":true,"pythonFreeLayout":true,"bootstrap":true,
        "auxiliaryWindowBootstrap":true,"resources":true,"sse":true,
        "shutdownAndReopen":true,"version":facts["version"]}),
    )
}
