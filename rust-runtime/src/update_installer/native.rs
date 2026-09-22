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
        validate_package(&root, platform, arch, None)?;
        // Refuse paths whose CMD expansion could change a generated command.
        if platform == "windows" {
            cmd_path(&root)?;
        }
        Ok(Self {
            root,
            platform: platform.into(),
            arch: arch.into(),
            wait_pids: vec![std::process::id(), pid],
        })
    }
}

fn backend_path(root: &Path, platform: &str) -> PathBuf {
    if platform == "macos" {
        root.join("Contents/Frameworks/bilikara-backend.app/Contents/MacOS/bilikara-desktop-host")
    } else {
        root.join("bilikara-desktop-host.exe")
    }
}
fn resources(root: &Path, platform: &str) -> PathBuf {
    if platform == "macos" {
        root.join("Contents/Frameworks/bilikara-backend.app/Contents/Resources")
    } else {
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
        "static/fonts/SourceHanSans-VF.ttf",
        "static/vendor/signalsmith-stretch/SignalsmithStretch.js",
    ];
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
    reject_runtime_payloads(&root, &root)?;
    Ok(())
}

fn reject_runtime_payloads(root: &Path, boundary: &Path) -> Result<(), UpdateInstallerError> {
    for entry in fs::read_dir(root).map_err(io_error("package_scan"))? {
        let entry = entry.map_err(io_error("package_scan"))?;
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        let ty = entry.file_type().map_err(io_error("package_scan"))?;
        if name == "_internal"
            || name == "site-packages"
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
                "ffmpeg" | "ffmpeg.exe" | "ffprobe" | "ffprobe.exe"
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
            reject_runtime_payloads(&entry.path(), boundary)?;
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
    version: &str,
    mut active: impl FnMut() -> bool,
) -> Result<Prepared, UpdateInstallerError> {
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
        find_macos_payload_app(&extract_dir, "Bilikara-Desktop.app")?
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
    let script = workspace.join(if installation.platform == "windows" {
        "apply.cmd"
    } else {
        "apply.sh"
    });
    let content = if installation.platform == "windows" {
        native_windows_script(&payload, installation, workspace)?
    } else {
        native_macos_script(&payload, installation, workspace)
    };
    write_text(&script, &content)?;
    Ok(Prepared {
        command: if installation.platform == "windows" {
            vec![
                "cmd".into(),
                "/c".into(),
                script.to_string_lossy().into_owned(),
            ]
        } else {
            vec!["/bin/sh".into(), script.to_string_lossy().into_owned()]
        },
    })
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

fn cmd_path(path: &Path) -> Result<String, UpdateInstallerError> {
    let text = path.to_string_lossy();
    if text.contains(['%', '!', '"', '\r', '\n']) {
        return Err(error(
            "unsafe_install_path",
            "Installation path cannot be safely represented by CMD",
        ));
    }
    Ok(text.into_owned())
}

fn native_windows_script(
    payload: &Path,
    installation: &Installation,
    workspace: &Path,
) -> Result<String, UpdateInstallerError> {
    let src = cmd_path(payload)?;
    let dst = cmd_path(&installation.root)?;
    let work = cmd_path(workspace)?;
    let suffix = workspace.file_name().unwrap().to_string_lossy();
    let pids = installation
        .wait_pids
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(" ");
    // Copy to a sibling on the same volume before moving the old installation.
    // Never mirror-delete a live installation or kill a PID. Keep old data and
    // the recoverable backup until the new version is confirmed by the user.
    Ok(format!(
        "@echo off\r\nsetlocal DisableDelayedExpansion\r\nset \"SRC={src}\"\r\nset \"DST={dst}\"\r\nset \"NEW={dst}.incoming-{suffix}\"\r\nset \"OLD={dst}.previous-{suffix}\"\r\nif exist \"%NEW%\" exit /b 1\r\nif exist \"%OLD%\" exit /b 1\r\nfor %%I in ({pids}) do (call :waitpid %%I & if errorlevel 1 exit /b 1)\r\nrobocopy \"%SRC%\" \"%NEW%\" /E >nul\r\nif errorlevel 8 goto failed\r\nfor %%D in (runtime data updates) do if exist \"%DST%\\%%D\" (robocopy \"%DST%\\%%D\" \"%NEW%\\%%D\" /E >nul & if errorlevel 8 goto failed)\r\nmove \"%DST%\" \"%OLD%\" >nul\r\nif errorlevel 1 goto failed\r\nmove \"%NEW%\" \"%DST%\" >nul\r\nif errorlevel 1 goto restore\r\nstart \"\" \"%DST%\\bilikara-desktop.exe\"\r\nrmdir /s /q \"{work}\"\r\nexit /b 0\r\n:restore\r\nmove \"%OLD%\" \"%DST%\" >nul\r\nstart \"\" \"%DST%\\bilikara-desktop.exe\"\r\n:failed\r\nrmdir /s /q \"%NEW%\"\r\nexit /b 1\r\n:waitpid\r\nset /a WAIT=0\r\n:wait\r\nset /a WAIT+=1\r\nif %WAIT% GEQ 90 exit /b 1\r\nfor /f \"tokens=2\" %%P in ('tasklist /FI \"PID eq %~1\" /NH 2^>nul') do if \"%%P\"==\"%~1\" (timeout /t 1 /nobreak >nul & goto wait)\r\nexit /b 0\r\n"
    ))
}

fn native_macos_script(payload: &Path, installation: &Installation, workspace: &Path) -> String {
    let suffix = workspace.file_name().unwrap().to_string_lossy();
    let pids = installation
        .wait_pids
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(" ");
    format!(
        "#!/bin/sh\nset -eu\nSRC={}\nDST={}\nNEW=\"${{DST}}.incoming-{suffix}\"\nOLD=\"${{DST}}.previous-{suffix}\"\n[ ! -e \"$NEW\" ] && [ ! -e \"$OLD\" ] || exit 1\nfor pid in {pids}; do\n n=0\n while kill -0 \"$pid\" 2>/dev/null; do\n  n=$((n+1)); [ \"$n\" -lt 90 ] || exit 1\n  /bin/sleep 1\n done\ndone\n/usr/bin/ditto \"$SRC\" \"$NEW\" || {{ /bin/rm -rf \"$NEW\"; exit 1; }}\n/bin/mv \"$DST\" \"$OLD\" || {{ /bin/rm -rf \"$NEW\"; exit 1; }}\nif /bin/mv \"$NEW\" \"$DST\"; then\n /usr/bin/open \"$DST\"\n /bin/rm -rf {}\nelse\n /bin/mv \"$OLD\" \"$DST\"\n /usr/bin/open \"$DST\"\n exit 1\nfi\n",
        shell_quote(payload),
        shell_quote(&installation.root),
        shell_quote(workspace)
    )
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use zip::{ZipWriter, write::SimpleFileOptions};

    pub(crate) fn windows_package(version: &str, arch: &str) -> Vec<u8> {
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
        let manifest=serde_json::json!({"schema_version":1,"backend":"rust","platform":"windows","arch":arch,"version":version,"development":false}).to_string();
        let media =
            serde_json::json!({"schema_version":1,"kind":"libav","target":format!("{}-pc-windows-msvc",if arch=="arm64" {"aarch64"} else {"x86_64"}),"runtime_files":["bilikara_media_libav.dll"]})
                .to_string();
        for (name, data) in [
            ("bilikara-desktop.exe", pe.as_slice()),
            ("bilikara-desktop-host.exe", pe.as_slice()),
            ("native-desktop.json", manifest.as_bytes()),
            ("APP_VERSION", version.as_bytes()),
            ("vendor/ffmpeg-runtime.json", media.as_bytes()),
            ("vendor/bilikara_media_libav.dll", pe.as_slice()),
            ("vendor/BBDown.exe", b"fixture tool"),
            ("static/index.html", b"fixture"),
            ("static/app.js", b"fixture"),
            ("static/styles.css", b"fixture"),
            ("static/fonts/SourceHanSans-VF.ttf", b"fixture font"),
            (
                "static/vendor/signalsmith-stretch/SignalsmithStretch.js",
                b"fixture worklet",
            ),
        ] {
            writer
                .start_file(format!("bilikara/{name}"), SimpleFileOptions::default())
                .unwrap();
            writer.write_all(data).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }
    fn root() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "native-update-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        root
    }
    #[test]
    fn native_preparation_preserves_old_install_and_legacy_launcher_contract() {
        let root = root();
        let installed = root.join("installed");
        fs::create_dir(&installed).unwrap();
        fs::write(installed.join("user-record"), b"unchanged").unwrap();
        let archive = root.join("native.zip");
        fs::write(&archive, windows_package("0.8.0-preview.2", "x64")).unwrap();
        let workspace = root.join("operation");
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
            "v0.8.0-preview.2",
            || true,
        )
        .unwrap();
        let script = fs::read_to_string(&prepared.command[2]).unwrap();
        assert!(script.contains("111 222"));
        assert!(script.contains("bilikara-desktop.exe"));
        assert!(!script.contains("taskkill"));
        assert!(!script.contains("/MIR"));
        assert!(script.contains(".previous-operation"));
        assert!(script.contains(":restore"));
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
        fs::write(package.join("python311.dll"), b"retired").unwrap();
        assert!(validate_package(&package, "windows", "x64", None).is_err());
        fs::remove_file(package.join("python311.dll")).unwrap();
        fs::remove_file(package.join("static/vendor/signalsmith-stretch/SignalsmithStretch.js"))
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
        let installation = Installation {
            root: root.join("installed.app"),
            platform: "macos".into(),
            arch: "arm64".into(),
            wait_pids: vec![111, 222],
        };
        let script = native_macos_script(
            &dest.join("Bilikara-Desktop.app"),
            &installation,
            &root.join("job"),
        );
        assert!(script.contains("for pid in 111 222"));
        assert!(script.contains("/usr/bin/ditto"));
        assert!(!script.contains("kill -9"));
        fs::remove_dir_all(root).unwrap();
    }
}
