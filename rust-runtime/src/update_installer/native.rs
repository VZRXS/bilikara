//! Native desktop installation facts and preparation. These typed inputs are
//! trusted process facts, never deserialized from a browser request.
use super::*;
use serde_json::Value;
use std::collections::HashSet;
use std::io::Read;
use std::path::Component;

const MAX_EXPANDED_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_ENTRIES: usize = 30_000;

#[derive(Clone, Debug)]
pub struct Installation {
    pub root: PathBuf,
    pub platform: String,
    pub arch: String,
    pub wait_pids: Vec<u32>,
}

#[derive(Clone, Debug)]
pub struct Prepared {
    pub command: Vec<String>,
}

impl Installation {
    /// Admit only the existing native package launched by its Tauri parent.
    pub fn from_launcher(
        backend: &Path,
        shell: &Path,
        pid: u32,
        platform: &str,
        arch: &str,
    ) -> Result<Self, UpdateInstallerError> {
        let backend = backend
            .canonicalize()
            .map_err(io_error("backend_missing"))?;
        let shell = shell.canonicalize().map_err(io_error("shell_missing"))?;
        let root = match platform {
            "windows"
                if shell
                    .file_name()
                    .is_some_and(|n| n == "bilikara-desktop.exe") =>
            {
                shell.parent().unwrap().to_owned()
            }
            "macos" if shell.ends_with("Contents/MacOS/bilikara") => shell
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .to_owned(),
            _ => {
                return Err(error(
                    "manual_update",
                    "This launch supports manual updates only",
                ));
            }
        };
        let expected = backend_path(&root, platform);
        if pid == 0
            || pid == std::process::id()
            || expected.canonicalize().ok().as_ref() != Some(&backend)
        {
            return Err(error(
                "invalid_launcher",
                "Native shell/backend layout does not match",
            ));
        }
        validate_package_contents(&root, platform, arch, None, true)?;
        // The installed updater performs the replacement. An installation
        // without one (for example an earlier package) updates manually.
        let updater = updater_path(&root, platform)
            .canonicalize()
            .map_err(|_| error("manual_update", "This installation has no updater"))?;
        if !updater.starts_with(&root) {
            return Err(error(
                "invalid_launcher",
                "Updater escapes the installation",
            ));
        }
        binary_arch(&updater, platform, arch)?;
        Ok(Self {
            root,
            platform: platform.into(),
            arch: arch.into(),
            wait_pids: vec![std::process::id(), pid],
        })
    }

    /// Only the documented portable data directory may live inside a Windows
    /// installation. The helper preserves runtime/ after both owners exit.
    pub fn permits_data_directory(&self, data: &Path) -> bool {
        !data.starts_with(&self.root)
            || (self.platform == "windows"
                && ["runtime/data", "runtime/native"]
                    .iter()
                    .any(|relative| data == self.root.join(relative)))
    }

    /// Keep the running helper and extracted payload outside the directory it
    /// will rename. External application-data roots retain their existing use.
    pub fn update_workspace_parent<'a>(&'a self, data: &'a Path) -> &'a Path {
        if data.starts_with(&self.root) {
            self.root.parent().expect("validated installation parent")
        } else {
            data
        }
    }
}

/// The updater ships beside the backend in every package built from now on.
fn updater_path(root: &Path, platform: &str) -> PathBuf {
    backend_path(root, platform).with_file_name(super::apply::updater_name(platform))
}

fn backend_path(root: &Path, platform: &str) -> PathBuf {
    if platform == "macos" {
        root.join("Contents/Frameworks/bilikara-backend.app/Contents/MacOS/bilikara-desktop-host")
    } else {
        resources(root, platform).join("bilikara-desktop-host.exe")
    }
}
fn resources(root: &Path, platform: &str) -> PathBuf {
    if platform == "macos" {
        root.join("Contents/Frameworks/bilikara-backend.app/Contents/Resources")
    } else if root.join("_internal").exists() {
        // A damaged current layout must fail validation, never fall through to
        // a stale backend left in one of the earlier native layouts.
        root.join("_internal")
    } else if root.join("backend").exists() {
        root.join("backend")
    } else {
        // Earlier native development candidates used a flat package.
        root.into()
    }
}
fn bounded_json(path: &Path) -> Result<Value, UpdateInstallerError> {
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(io_error("package_missing"))?
        .take(64 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error("package_missing"))?;
    if bytes.len() > 64 * 1024 {
        return Err(error(
            "incompatible_package",
            "Package metadata is oversized",
        ));
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| error("incompatible_package", "Invalid native package metadata"))
}

/// Validate the existing layout marker AND the actual required native payload.
/// This never loads or executes candidate code while the old product is running.
pub fn validate_package(
    root: &Path,
    platform: &str,
    arch: &str,
    version: Option<&str>,
) -> Result<(), UpdateInstallerError> {
    validate_package_contents(root, platform, arch, version, false)
}

fn validate_package_contents(
    root: &Path,
    platform: &str,
    arch: &str,
    version: Option<&str>,
    installed: bool,
) -> Result<(), UpdateInstallerError> {
    let root = root.canonicalize().map_err(io_error("package_missing"))?;
    let assets = resources(&root, platform);
    let manifest = bounded_json(&assets.join("native-desktop.json"))?;
    let mut app_version = String::new();
    File::open(assets.join("APP_VERSION"))
        .map_err(io_error("package_missing"))?
        .take(257)
        .read_to_string(&mut app_version)
        .map_err(io_error("package_missing"))?;
    if app_version.len() > 256
        || !matches!(arch, "x64" | "arm64")
        || manifest["schema_version"] != 1
        || manifest["backend"] != "rust"
        || manifest
            .get("resource_layout")
            .is_some_and(|v| v != "internal-v1")
        || manifest["development"] != false
        || manifest["platform"] != platform
        || manifest["arch"] != arch
        || manifest["version"].as_str() != Some(app_version.trim())
        || version.is_some_and(|v| {
            v.trim_start_matches('v') != app_version.trim().trim_start_matches('v')
        })
    {
        return Err(error(
            "incompatible_package",
            "Update is not a compatible native desktop package",
        ));
    }
    let shell = if platform == "macos" {
        root.join("Contents/MacOS/bilikara")
    } else {
        root.join("bilikara-desktop.exe")
    };
    for file in [shell, backend_path(&root, platform)] {
        let actual = file.canonicalize().map_err(io_error("package_missing"))?;
        if !actual.starts_with(&root) {
            return Err(error(
                "incompatible_package",
                "Native binary escapes its bundle",
            ));
        }
        binary_arch(&actual, platform, arch)?;
    }
    let companion = if platform == "macos" {
        "libbilikara_media_libav.dylib"
    } else {
        "bilikara_media_libav.dll"
    };
    let tool = if platform == "macos" {
        "BBDown"
    } else {
        "BBDown.exe"
    };
    let mut required = vec![
        "static/index.html",
        "static/app.js",
        "static/styles.css",
        "static/native-session.js",
        "static/host-layout.js",
        "static/host-layout.css",
        "static/host-layout-preferences.js",
        "static/host-updates.js",
        "static/desktop-platform.js",
        "static/fonts/SourceHanSans-VF.ttf",
    ];
    required.push(
        if assets.file_name().is_some_and(|n| n == "_internal")
            || manifest["resource_layout"] == "internal-v1"
        {
            "vendor/signalsmith-stretch/SignalsmithStretch.js"
        } else {
            // Earlier native archives kept frontend dependencies within static/.
            "static/vendor/signalsmith-stretch/SignalsmithStretch.js"
        },
    );
    required.push("vendor/ffmpeg-runtime.json");
    for file in required.into_iter().map(|p| assets.join(p)).chain([
        assets.join("vendor").join(companion),
        assets.join("vendor").join(tool),
    ]) {
        let actual = file.canonicalize().map_err(io_error("package_missing"))?;
        if !actual.starts_with(&root)
            || !actual.is_file()
            || fs::metadata(&actual)
                .map_err(io_error("package_missing"))?
                .len()
                == 0
        {
            return Err(error(
                "incompatible_package",
                "Native resource is missing or escapes its bundle",
            ));
        }
    }
    let media = bounded_json(&assets.join("vendor/ffmpeg-runtime.json"))?;
    let cpu = if arch == "arm64" { "aarch64" } else { "x86_64" };
    let target = format!(
        "{cpu}-{}",
        if platform == "macos" {
            "apple-darwin"
        } else {
            "pc-windows-msvc"
        }
    );
    if media["schema_version"] != 1 || media["target"] != target || media["kind"] != "libav" {
        return Err(error(
            "incompatible_package",
            "Native update requires the libav-only media profile",
        ));
    }
    // The manifest names the complete dynamic dependency closure staged by the
    // existing builder. Do not accidentally accept just an isolated companion.
    let files = media["runtime_files"]
        .as_array()
        .filter(|files| !files.is_empty() && files.len() <= 100)
        .ok_or_else(|| error("incompatible_package", "Missing libav dependency inventory"))?;
    {
        for file in files {
            let name = file
                .as_str()
                .ok_or_else(|| error("incompatible_package", "Invalid libav dependency"))?;
            let path = assets
                .join("vendor")
                .join(name)
                .canonicalize()
                .map_err(io_error("package_missing"))?;
            if !path.starts_with(&root) || !path.is_file() {
                return Err(error("incompatible_package", "Missing libav dependency"));
            }
            binary_arch(&path, platform, arch)?;
        }
    }
    if platform == "macos" {
        bounded_json(&assets.join("vendor/aria2-macos.json"))?;
    }
    // Inspect actual entries, without rejecting documentation mentioning Python.
    reject_runtime_payloads(&root, &root, installed && platform == "windows")?;
    Ok(())
}

fn reject_runtime_payloads(
    root: &Path,
    boundary: &Path,
    installed: bool,
) -> Result<(), UpdateInstallerError> {
    for entry in fs::read_dir(root).map_err(io_error("package_scan"))? {
        let entry = entry.map_err(io_error("package_scan"))?;
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        let ty = entry.file_type().map_err(io_error("package_scan"))?;
        if root == boundary && name == "runtime" {
            if installed && ty.is_dir() {
                // User-owned data/tools, including untouched legacy import
                // sources, are not immutable application payloads.
                continue;
            }
            return Err(error(
                "incompatible_package",
                "Update archive must not supply runtime data",
            ));
        }
        if name == "site-packages"
            || name == "base_library.zip"
            || name.ends_with(".pyz")
            || name.ends_with(".pyc")
            || name == "python"
            || name.starts_with("python3")
            || name.starts_with("libpython")
            || name == "python.exe"
            || (name.starts_with("python") && name.ends_with(".dll"))
            || matches!(
                name.as_str(),
                "ffmpeg"
                    | "ffmpeg.exe"
                    | "ffprobe"
                    | "ffprobe.exe"
                    | "bilikara_rust.dll"
                    | "bilikara_runtime.dll"
                    | "libbilikara_rust.so"
                    | "libbilikara_runtime.so"
                    | "libbilikara_rust.dylib"
                    | "libbilikara_runtime.dylib"
            )
        {
            return Err(error(
                "incompatible_package",
                "Update contains a retired product runtime",
            ));
        }
        if ty.is_symlink()
            && !entry
                .path()
                .canonicalize()
                .map_err(io_error("invalid_link"))?
                .starts_with(boundary)
        {
            return Err(error(
                "incompatible_package",
                "Bundle link escapes the installed application",
            ));
        }
        if ty.is_dir() {
            reject_runtime_payloads(&entry.path(), boundary, installed)?;
        }
    }
    Ok(())
}

fn binary_arch(path: &Path, platform: &str, arch: &str) -> Result<(), UpdateInstallerError> {
    let mut file = File::open(path).map_err(io_error("package_missing"))?;
    let mut header = [0_u8; 4096];
    let n = file
        .read(&mut header)
        .map_err(io_error("package_missing"))?;
    let valid = if platform == "windows" && n >= 64 && &header[..2] == b"MZ" {
        let offset = u32::from_le_bytes(header[60..64].try_into().unwrap()) as usize;
        offset + 6 <= n
            && &header[offset..offset + 4] == b"PE\0\0"
            && u16::from_le_bytes(header[offset + 4..offset + 6].try_into().unwrap())
                == if arch == "arm64" { 0xaa64 } else { 0x8664 }
    } else if platform == "macos" && n >= 8 && header[..4] == [0xcf, 0xfa, 0xed, 0xfe] {
        u32::from_le_bytes(header[4..8].try_into().unwrap())
            == if arch == "arm64" {
                0x0100000c
            } else {
                0x01000007
            }
    } else if platform == "macos" && n >= 8 && header[..4] == [0xca, 0xfe, 0xba, 0xbe] {
        let count = u32::from_be_bytes(header[4..8].try_into().unwrap()) as usize;
        count <= 16
            && 8 + count * 20 <= n
            && (0..count).any(|i| {
                u32::from_be_bytes(header[8 + i * 20..12 + i * 20].try_into().unwrap())
                    == if arch == "arm64" {
                        0x0100000c
                    } else {
                        0x01000007
                    }
            })
    } else {
        false
    };
    use std::io::{Seek, SeekFrom};
    let length = file.metadata().map_err(io_error("package_missing"))?.len();
    file.seek(SeekFrom::Start(length.saturating_sub(65536)))
        .map_err(io_error("package_missing"))?;
    let mut tail = Vec::new();
    file.take(65536)
        .read_to_end(&mut tail)
        .map_err(io_error("package_missing"))?;
    if tail
        .windows(8)
        .any(|bytes| bytes == b"MEI\x0c\x0b\x0a\x0b\x0e")
    {
        return Err(error(
            "incompatible_package",
            "Frozen Python executable is not a native backend",
        ));
    }
    if !valid {
        return Err(error(
            "incompatible_architecture",
            "Native executable architecture does not match",
        ));
    }
    Ok(())
}

fn relative_path(name: &str) -> Result<PathBuf, UpdateInstallerError> {
    if name.is_empty() || name.contains(['\\', ':']) || name.chars().any(char::is_control) {
        return Err(error("unsafe_archive_path", "Unsafe update archive path"));
    }
    let path = Path::new(name);
    for component in name.split('/').filter(|part| !part.is_empty()) {
        let stem = component
            .split('.')
            .next()
            .unwrap_or_default()
            .to_ascii_uppercase();
        if component.ends_with(['.', ' '])
            || component.contains(['<', '>', '|', '?', '*', '"'])
            || matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || ((stem.starts_with("COM") || stem.starts_with("LPT"))
                && stem.len() == 4
                && stem.as_bytes()[3].is_ascii_digit())
        {
            return Err(error("unsafe_archive_path", "Unsafe portable archive name"));
        }
    }
    if path
        .components()
        .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
    {
        return Err(error(
            "unsafe_archive_path",
            "Update archive escapes staging",
        ));
    }
    Ok(path.to_owned())
}

/// Links are created last. No archive entry may be written through a link.
/// Legitimate relative framework/compatibility links must resolve inside staging.
pub(super) fn extract(
    archive: &Path,
    destination: &Path,
    active: &mut impl FnMut() -> bool,
) -> Result<(), UpdateInstallerError> {
    fs::create_dir(destination).map_err(io_error("extract_create_failed"))?;
    let mut zip = ZipArchive::new(File::open(archive).map_err(io_error("archive_open_failed"))?)
        .map_err(|_| error("invalid_archive", "Invalid update ZIP"))?;
    if zip.len() > MAX_ENTRIES {
        return Err(error("oversized_archive", "Too many update entries"));
    }
    let mut names = HashSet::new();
    let mut links = Vec::new();
    let mut expanded = 0_u64;
    for i in 0..zip.len() {
        if !active() {
            return Err(error("cancelled", "Update cancelled"));
        }
        let mut entry = zip
            .by_index(i)
            .map_err(|_| error("invalid_archive", "Invalid ZIP entry"))?;
        let relative = relative_path(entry.name())?;
        let key = relative
            .to_string_lossy()
            .trim_end_matches('/')
            .to_lowercase();
        if !names.insert(key) {
            return Err(error("unsafe_archive_path", "Duplicate update entry"));
        }
        expanded = expanded
            .checked_add(entry.size())
            .filter(|v| *v <= MAX_EXPANDED_BYTES)
            .ok_or_else(|| error("oversized_archive", "Expanded update exceeds its limit"))?;
        let output = destination.join(&relative);
        if entry.is_symlink() {
            let mut target = String::new();
            entry
                .take(4097)
                .read_to_string(&mut target)
                .map_err(io_error("invalid_link"))?;
            if target.len() > 4096
                || target.contains(['\\', ':'])
                || target.chars().any(char::is_control)
                || Path::new(&target).is_absolute()
            {
                return Err(error("unsafe_archive_path", "Unsafe bundle link"));
            }
            links.push((relative, target));
        } else if entry.is_dir() {
            fs::create_dir_all(&output).map_err(io_error("extract_failed"))?;
        } else {
            fs::create_dir_all(output.parent().unwrap()).map_err(io_error("extract_failed"))?;
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&output)
                .map_err(io_error("extract_failed"))?;
            let mut copied = 0;
            let mut buffer = [0_u8; 65536];
            loop {
                if !active() {
                    return Err(error("cancelled", "Update cancelled"));
                }
                let n = entry
                    .read(&mut buffer)
                    .map_err(io_error("extract_failed"))?;
                if n == 0 {
                    break;
                }
                copied += n as u64;
                if copied > entry.size() {
                    return Err(error("invalid_archive", "ZIP size mismatch"));
                }
                file.write_all(&buffer[..n])
                    .map_err(io_error("extract_failed"))?;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(
                    &output,
                    fs::Permissions::from_mode(entry.unix_mode().unwrap_or(0o644) & 0o777),
                )
                .map_err(io_error("extract_failed"))?;
            }
        }
    }
    let boundary = destination
        .canonicalize()
        .map_err(io_error("extract_failed"))?;
    while !links.is_empty() {
        if !active() {
            return Err(error("cancelled", "Update cancelled"));
        }
        let mut pending = Vec::new();
        let count = links.len();
        for (relative, target) in links {
            let mut resolved = relative.parent().unwrap().to_path_buf();
            for part in Path::new(&target).components() {
                match part {
                    Component::Normal(p) => resolved.push(p),
                    Component::CurDir => (),
                    Component::ParentDir if resolved.pop() => (),
                    _ => return Err(error("unsafe_archive_path", "Bundle link escapes staging")),
                }
            }
            if relative.starts_with(&resolved) {
                return Err(error("unsafe_archive_path", "Cyclic bundle link"));
            }
            let Ok(actual) = destination.join(&resolved).canonicalize() else {
                pending.push((relative, target));
                continue;
            };
            if !actual.starts_with(&boundary) {
                return Err(error("unsafe_archive_path", "Bundle link escapes staging"));
            }
            let output = destination.join(relative);
            fs::create_dir_all(output.parent().unwrap()).map_err(io_error("extract_failed"))?;
            #[cfg(unix)]
            std::os::unix::fs::symlink(target, output).map_err(io_error("extract_failed"))?;
            #[cfg(not(unix))]
            return Err(error(
                "unsafe_archive_path",
                "Windows packages must not contain links",
            ));
        }
        if pending.len() == count {
            return Err(error(
                "unsafe_archive_path",
                "Cyclic or dangling bundle link",
            ));
        }
        links = pending;
    }
    Ok(())
}

pub fn prepare(
    installation: &Installation,
    archive: &Path,
    workspace: &Path,
    data: &Path,
    version: &str,
    mut active: impl FnMut() -> bool,
) -> Result<Prepared, UpdateInstallerError> {
    if workspace
        .canonicalize()
        .map_err(io_error("package_missing"))?
        .starts_with(&installation.root)
    {
        return Err(error(
            "unsafe_install_path",
            "Update workspace must be outside the installed application",
        ));
    }
    let parent = installation
        .root
        .parent()
        .ok_or_else(|| error("unsafe_install_path", "Installation has no parent"))?;
    let probe = parent.join(format!(
        ".bilikara-write-{}",
        workspace
            .file_name()
            .ok_or_else(|| error("unsafe_install_path", "Missing staging identity"))?
            .to_string_lossy()
    ));
    let file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
        .map_err(|_| {
            error(
                "installation_read_only",
                "Installation parent is not writable; update manually",
            )
        })?;
    drop(file);
    fs::remove_file(probe).map_err(io_error("installation_read_only"))?;
    let extract_dir = workspace.join("extracted");
    extract(archive, &extract_dir, &mut active)?;
    let payload = if installation.platform == "windows" {
        find_windows_payload_root(&extract_dir, "bilikara-desktop.exe")?
    } else {
        find_macos_payload_app(&extract_dir, "bilikara-desktop.app")?
    };
    validate_package(
        &payload,
        &installation.platform,
        &installation.arch,
        Some(version),
    )?;
    if !active() {
        return Err(error("cancelled", "Update cancelled"));
    }
    verify_signature(&payload, &installation.platform)?;
    // Run a copy of the installed updater from the workspace: the original
    // lives in the installation it is about to move aside.
    let updater = workspace.join(super::apply::updater_name(&installation.platform));
    fs::copy(
        updater_path(&installation.root, &installation.platform),
        &updater,
    )
    .map_err(io_error("updater_missing"))?;
    let plan = super::apply::Plan {
        schema_version: 1,
        platform: installation.platform.clone(),
        operation: workspace
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| error("unsafe_install_path", "Missing staging identity"))?
            .to_owned(),
        source: payload,
        destination: installation.root.clone(),
        workspace: workspace.to_owned(),
        reports: reports(data),
        // Portable Windows data lives inside the installation it replaces.
        preserve: if installation.platform == "windows" {
            ["runtime", "data", "updates"].map(String::from).to_vec()
        } else {
            Vec::new()
        },
        wait_pids: installation.wait_pids.clone(),
    };
    let plan_path = workspace.join(super::apply::PLAN_FILE);
    plan.validate(&plan_path)
        .map_err(|cause| error("invalid_update_plan", cause.to_string()))?;
    write_text(
        &plan_path,
        &serde_json::to_string_pretty(&plan)
            .map_err(|cause| error("invalid_update_plan", cause.to_string()))?,
    )?;
    Ok(Prepared {
        command: vec![
            updater.to_string_lossy().into_owned(),
            "--plan".into(),
            plan_path.to_string_lossy().into_owned(),
        ],
    })
}

/// Helper logs and the last result, kept under the application data root so the
/// next Host start can report the outcome. Not part of any installed package.
pub fn reports(data: &Path) -> PathBuf {
    data.join("update-logs")
}

fn verify_signature(payload: &Path, platform: &str) -> Result<(), UpdateInstallerError> {
    if platform != "macos" {
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        let mut child = Command::new("/usr/bin/codesign")
            .args(["--verify", "--deep", "--strict"])
            .arg(payload)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(io_error("signature_failed"))?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        loop {
            if let Some(status) = child.try_wait().map_err(io_error("signature_failed"))? {
                return if status.success() {
                    Ok(())
                } else {
                    Err(error("signature_failed", "Candidate macOS seal is invalid"))
                };
            }
            if std::time::Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error(
                    "signature_failed",
                    "Signature verification timed out",
                ));
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = payload;
        Err(error(
            "signature_unavailable",
            "macOS signature verification requires macOS",
        ))
    }
}

/// Win32 form of a trusted path for the generated CMD helper. `canonicalize`
/// yields verbatim `\\?\C:\...` paths on Windows; CMD cannot use them as a
/// current directory and never resolves `..` inside them. Network and device
/// roots, and text CMD would expand, are refused rather than rewritten.
// Only the retained CMD helper launch (published-era clients) uses this.
#[cfg_attr(not(windows), allow(dead_code))]
pub(super) fn cmd_path(path: &Path) -> Result<String, UpdateInstallerError> {
    let unsafe_path = || {
        error(
            "unsafe_install_path",
            "Installation path cannot be safely represented by CMD",
        )
    };
    let text = path.to_str().ok_or_else(unsafe_path)?;
    let text = match text.strip_prefix(r"\\?\") {
        Some(rest)
            if rest.len() >= 3
                && rest.as_bytes()[0].is_ascii_alphabetic()
                && &rest.as_bytes()[1..3] == br":\" =>
        {
            rest
        }
        Some(_) => return Err(unsafe_path()),
        None => text,
    };
    if text.starts_with(r"\\") || text.contains(['%', '!', '"', '\r', '\n']) {
        return Err(unsafe_path());
    }
    Ok(text.to_owned())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use zip::{ZipWriter, write::SimpleFileOptions};

    pub(crate) fn windows_package(version: &str, arch: &str) -> Vec<u8> {
        windows_package_layout(version, arch, "_internal/")
    }

    fn windows_package_layout(version: &str, arch: &str, layout: &str) -> Vec<u8> {
        let mut writer = ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let mut pe = vec![0_u8; 128];
        pe[..2].copy_from_slice(b"MZ");
        pe[60] = 64;
        pe[64..68].copy_from_slice(b"PE\0\0");
        pe[68..70].copy_from_slice(
            &(if arch == "arm64" {
                0xaa64_u16
            } else {
                0x8664_u16
            })
            .to_le_bytes(),
        );
        let mut manifest = serde_json::json!({"schema_version":1,"backend":"rust","platform":"windows","arch":arch,"version":version,"development":false});
        if layout == "_internal/" {
            manifest["resource_layout"] = serde_json::json!("internal-v1");
        }
        let manifest = manifest.to_string();
        let media =
            serde_json::json!({"schema_version":1,"kind":"libav","target":format!("{}-pc-windows-msvc",if arch=="arm64" {"aarch64"} else {"x86_64"}),"runtime_files":["bilikara_media_libav.dll"]})
                .to_string();
        for (name, data) in [
            ("bilikara-desktop.exe", pe.as_slice()),
            ("bilikara-desktop-host.exe", pe.as_slice()),
            ("bilikara-updater.exe", pe.as_slice()),
            ("native-desktop.json", manifest.as_bytes()),
            ("APP_VERSION", version.as_bytes()),
            ("vendor/ffmpeg-runtime.json", media.as_bytes()),
            ("vendor/bilikara_media_libav.dll", pe.as_slice()),
            ("vendor/BBDown.exe", b"fixture tool"),
            ("static/index.html", b"fixture"),
            ("static/app.js", b"fixture"),
            ("static/styles.css", b"fixture"),
            ("static/native-session.js", b"fixture"),
            ("static/host-layout.js", b"fixture"),
            ("static/host-layout.css", b"fixture"),
            ("static/host-layout-preferences.js", b"fixture"),
            ("static/host-updates.js", b"fixture"),
            ("static/desktop-platform.js", b"fixture"),
            ("static/fonts/SourceHanSans-VF.ttf", b"fixture font"),
            (
                if layout == "_internal/" {
                    "vendor/signalsmith-stretch/SignalsmithStretch.js"
                } else {
                    "static/vendor/signalsmith-stretch/SignalsmithStretch.js"
                },
                b"fixture worklet",
            ),
        ] {
            let prefix = if name != "bilikara-desktop.exe" {
                layout
            } else {
                ""
            };
            writer
                .start_file(
                    format!("bilikara/{prefix}{name}"),
                    SimpleFileOptions::default(),
                )
                .unwrap();
            writer.write_all(data).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    #[test]
    fn internal_and_earlier_native_installations_validate_without_fallback() {
        for layout in ["", "backend/", "_internal/"] {
            let root = root();
            let archive = root.join("native.zip");
            fs::write(&archive, windows_package_layout("0.8.1", "x64", layout)).unwrap();
            let extracted = root.join("extracted");
            extract(&archive, &extracted, &mut || true).unwrap();
            let package = extracted.join("bilikara");
            validate_package(&package, "windows", "x64", Some("0.8.1")).unwrap();
            let installation = Installation::from_launcher(
                &backend_path(&package, "windows"),
                &package.join("bilikara-desktop.exe"),
                std::process::id() + 1,
                "windows",
                "x64",
            )
            .unwrap();
            assert_eq!(installation.root, package.canonicalize().unwrap());
            if layout != "_internal/" {
                // An incomplete new layout must not accidentally select a stale
                // flat backend left beside it.
                fs::create_dir(package.join("_internal")).unwrap();
            } else {
                fs::remove_file(package.join("_internal/native-desktop.json")).unwrap();
            }
            assert!(validate_package(&package, "windows", "x64", None).is_err());
            fs::remove_dir_all(root).unwrap();
        }
    }
    fn root() -> PathBuf {
        // Parallel tests can read the same coarse Windows clock tick.
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "native-update-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        root
    }

    #[test]
    fn portable_data_is_preserved_but_never_admitted_from_an_update_archive() {
        let root = root();
        let archive = root.join("native.zip");
        fs::write(&archive, windows_package("0.8.1", "x64")).unwrap();
        extract(&archive, &root.join("extracted"), &mut || true).unwrap();
        let package = root.join("extracted/bilikara").canonicalize().unwrap();
        let data = package.join("runtime/data");
        fs::create_dir_all(&data).unwrap();
        let legacy = package.join("runtime/tools/ffmpeg.exe");
        fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        fs::write(&legacy, b"untouched legacy import source").unwrap();
        assert!(validate_package(&package, "windows", "x64", None).is_err());
        let installation = Installation::from_launcher(
            &backend_path(&package, "windows"),
            &package.join("bilikara-desktop.exe"),
            std::process::id() + 1,
            "windows",
            "x64",
        )
        .unwrap();
        assert!(installation.permits_data_directory(&data));
        assert!(installation.permits_data_directory(&package.join("runtime/native")));
        assert_eq!(
            installation.update_workspace_parent(&data),
            package.parent().unwrap()
        );
        for relative in [
            "",
            "_internal",
            "runtime",
            "runtime/custom",
            "runtime/native/nested",
            "runtime/data/nested",
        ] {
            assert!(!installation.permits_data_directory(&package.join(relative)));
        }
        assert!(installation.permits_data_directory(&root.join("external")));
        let macos = Installation {
            platform: "macos".into(),
            ..installation.clone()
        };
        assert!(!macos.permits_data_directory(&data));
        assert_eq!(
            fs::read(&legacy).unwrap(),
            b"untouched legacy import source"
        );
        let workspace = data.join("update-fixture");
        fs::create_dir(&workspace).unwrap();
        assert_eq!(
            prepare(&installation, &archive, &workspace, &root, "0.8.1", || true)
                .unwrap_err()
                .kind,
            "unsafe_install_path"
        );
        // The installed updater does the replacement; without it, manual only.
        let updater = package.join("_internal/bilikara-updater.exe");
        let kept = fs::read(&updater).unwrap();
        fs::remove_file(&updater).unwrap();
        assert_eq!(
            Installation::from_launcher(
                &backend_path(&package, "windows"),
                &package.join("bilikara-desktop.exe"),
                std::process::id() + 1,
                "windows",
                "x64",
            )
            .unwrap_err()
            .kind,
            "manual_update"
        );
        fs::write(&updater, kept).unwrap();
        fs::write(package.join("_internal/python311.dll"), b"retired runtime").unwrap();
        assert!(
            Installation::from_launcher(
                &backend_path(&package, "windows"),
                &package.join("bilikara-desktop.exe"),
                std::process::id() + 1,
                "windows",
                "x64",
            )
            .is_err()
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn native_preparation_preserves_old_install_and_legacy_launcher_contract() {
        let root = root();
        let archive = root.join("native.zip");
        fs::write(&archive, windows_package("0.8.0-preview.2", "x64")).unwrap();
        extract(&archive, &root.join("current"), &mut || true).unwrap();
        let installed = root.join("current/bilikara");
        fs::write(installed.join("user-record"), b"unchanged").unwrap();
        let workspace = root.join("update-operation");
        fs::create_dir(&workspace).unwrap();
        let installation = Installation {
            root: installed.clone(),
            platform: "windows".into(),
            arch: "x64".into(),
            wait_pids: vec![111, 222],
        };
        let prepared = prepare(
            &installation,
            &archive,
            &workspace,
            &root,
            "v0.8.0-preview.2",
            || true,
        )
        .unwrap();
        // A copy of the installed updater runs from the workspace with a plan.
        let updater = workspace.join("bilikara-updater.exe");
        let plan_path = workspace.join(super::super::apply::PLAN_FILE);
        assert_eq!(
            prepared.command,
            [
                updater.to_string_lossy().into_owned(),
                "--plan".to_owned(),
                plan_path.to_string_lossy().into_owned()
            ]
        );
        assert_eq!(
            fs::read(&updater).unwrap(),
            fs::read(installed.join("_internal/bilikara-updater.exe")).unwrap()
        );
        let plan: super::super::apply::Plan =
            serde_json::from_slice(&fs::read(&plan_path).unwrap()).unwrap();
        plan.validate(&plan_path).unwrap();
        assert_eq!(plan.operation, "update-operation");
        assert_eq!(plan.destination, installed);
        assert_eq!(plan.workspace, workspace);
        assert!(plan.source.starts_with(workspace.join("extracted")));
        assert!(plan.source.join("bilikara-desktop.exe").is_file());
        assert_eq!(plan.reports, reports(&root));
        assert_eq!(plan.preserve, ["runtime", "data", "updates"]);
        assert_eq!(plan.wait_pids, [111, 222]);
        // Preparation never touches the running installation.
        assert_eq!(
            fs::read(installed.join("user-record")).unwrap(),
            b"unchanged"
        );
        // Published-era Windows selection may look for bilikara.exe and then
        // fall back to another EXE's parent. Its Tauri relaunch name is retained.
        let old = prepare_update(&PrepareUpdateRequest {
            platform: "windows".into(),
            archive_path: archive,
            extract_dir: root.join("old-client"),
            script_path: root.join("old.cmd"),
            install_root: installed,
            executable_name: "bilikara.exe".into(),
            launch_executable_name: "bilikara-desktop.exe".into(),
            wait_pids: vec![111, 222],
        })
        .unwrap();
        assert!(
            Path::new(&old.payload_root)
                .join("bilikara-desktop.exe")
                .is_file()
        );
        assert!(
            fs::read_to_string(root.join("old.cmd"))
                .unwrap()
                .contains("bilikara-desktop.exe")
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn invalid_native_version_arch_resources_and_python_payload_fail_closed() {
        let root = root();
        let archive = root.join("package.zip");
        fs::write(&archive, windows_package("0.8.1", "x64")).unwrap();
        let extracted = root.join("extract");
        extract(&archive, &extracted, &mut || true).unwrap();
        let package = extracted.join("bilikara");
        assert!(validate_package(&package, "windows", "arm64", Some("0.8.1")).is_err());
        assert!(validate_package(&package, "windows", "x64", Some("0.8.2")).is_err());
        assert!(validate_package(&package, "macos", "x64", None).is_err());
        for retired in [
            "python311.dll",
            "base_library.zip",
            "payload.pyz",
            "ffmpeg.exe",
            "ffprobe.exe",
            "bilikara_rust.dll",
            "bilikara_runtime.dll",
        ] {
            let file = package.join("_internal").join(retired);
            fs::write(&file, b"retired").unwrap();
            assert!(
                validate_package(&package, "windows", "x64", None).is_err(),
                "{retired}"
            );
            fs::remove_file(file).unwrap();
        }
        validate_package(&package, "windows", "x64", None).unwrap();
        fs::remove_file(package.join("_internal/vendor/signalsmith-stretch/SignalsmithStretch.js"))
            .unwrap();
        assert!(validate_package(&package, "windows", "x64", None).is_err());
        assert!(cmd_path(Path::new("C:/%evil%/app")).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn extraction_rejects_escape_alias_writes_duplicates_and_cancellation() {
        for name in ["../escape", "/absolute", "C:/escape", "..\\escape"] {
            let root = root();
            let archive = root.join("bad.zip");
            let mut writer = ZipWriter::new(File::create(&archive).unwrap());
            writer
                .start_file(name, SimpleFileOptions::default())
                .unwrap();
            writer.write_all(b"bad").unwrap();
            writer.finish().unwrap();
            assert!(extract(&archive, &root.join("extracted"), &mut || true).is_err());
            fs::remove_dir_all(root).unwrap();
        }
        let root = root();
        let archive = root.join("bad.zip");
        let mut writer = ZipWriter::new(File::create(&archive).unwrap());
        writer
            .add_symlink(
                "bundle/link",
                "../../../outside",
                SimpleFileOptions::default(),
            )
            .unwrap();
        writer.finish().unwrap();
        assert!(extract(&archive, &root.join("escaped"), &mut || true).is_err());
        fs::write(&archive, windows_package("0.8.1", "x64")).unwrap();
        assert_eq!(
            extract(&archive, &root.join("cancelled"), &mut || false)
                .unwrap_err()
                .kind,
            "cancelled"
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn legitimate_macos_relative_links_survive_and_do_not_escape() {
        let root = root();
        let archive = root.join("mac.zip");
        let mut writer = ZipWriter::new(File::create(&archive).unwrap());
        writer
            .start_file(
                "Bilikara-Desktop.app/Contents/Frameworks/vendor/lib.dylib",
                SimpleFileOptions::default(),
            )
            .unwrap();
        writer.write_all(b"fixture").unwrap();
        writer
            .add_symlink(
                "Bilikara-Desktop.app/Contents/Resources/vendor/lib.dylib",
                "../../Frameworks/vendor/lib.dylib",
                SimpleFileOptions::default(),
            )
            .unwrap();
        writer
            .add_symlink(
                "bilikara.app",
                "Bilikara-Desktop.app",
                SimpleFileOptions::default(),
            )
            .unwrap();
        writer.finish().unwrap();
        let dest = root.join("extract");
        extract(&archive, &dest, &mut || true).unwrap();
        assert_eq!(
            fs::read(dest.join("bilikara.app/Contents/Resources/vendor/lib.dylib")).unwrap(),
            b"fixture"
        );
        // Preview 1's extractor materializes symlinks as plain files. Its
        // macOS automatic path cannot preserve this sealed native layout.
        let old = prepare_update(&PrepareUpdateRequest {
            platform: "macos".into(),
            archive_path: archive.clone(),
            extract_dir: root.join("preview1"),
            script_path: root.join("preview1.sh"),
            install_root: root.join("Bilikara-Desktop.app"),
            executable_name: "bilikara".into(),
            launch_executable_name: String::new(),
            wait_pids: vec![111],
        })
        .unwrap();
        let old_link = Path::new(&old.payload_root).join("Contents/Resources/vendor/lib.dylib");
        assert!(
            !fs::symlink_metadata(&old_link)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_ne!(fs::read(&old_link).unwrap(), b"fixture");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn helper_paths_use_win32_drive_form_and_refuse_network_roots() {
        // Windows canonical installation roots are verbatim paths.
        assert_eq!(
            cmd_path(Path::new(r"\\?\D:\软件\bilikara")).unwrap(),
            r"D:\软件\bilikara"
        );
        assert_eq!(
            cmd_path(Path::new(r"D:\Apps (x86)\bilikara & co")).unwrap(),
            r"D:\Apps (x86)\bilikara & co"
        );
        for refused in [
            r"\\?\UNC\server\share\bilikara",
            r"\\?\Volume{00000000-0000-0000-0000-000000000000}\bilikara",
            r"\\?\D:",
            r"\\server\share\bilikara",
            r"D:\100%\bilikara",
            r"D:\bang!\bilikara",
        ] {
            assert_eq!(
                cmd_path(Path::new(refused)).unwrap_err().kind,
                "unsafe_install_path",
                "{refused}"
            );
        }
    }
}
