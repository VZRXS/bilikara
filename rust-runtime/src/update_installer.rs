use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use zip::ZipArchive;

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrepareUpdateRequest {
    pub platform: String,
    pub archive_path: PathBuf,
    pub extract_dir: PathBuf,
    pub script_path: PathBuf,
    pub install_root: PathBuf,
    pub executable_name: String,
    #[serde(default)]
    pub launch_executable_name: String,
    #[serde(default)]
    pub wait_pids: Vec<u32>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LaunchUpdateHelperRequest {
    pub command: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct PrepareUpdateResult {
    pub command: Vec<String>,
    pub payload_root: String,
    pub script_path: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct UpdateInstallerError {
    pub kind: &'static str,
    pub message: String,
}

pub fn prepare_update(
    request: &PrepareUpdateRequest,
) -> Result<PrepareUpdateResult, UpdateInstallerError> {
    reset_directory(&request.extract_dir)?;
    safe_extract_zip(&request.archive_path, &request.extract_dir)?;
    match request.platform.trim().to_lowercase().as_str() {
        "windows" => prepare_windows_update(request),
        "macos" => prepare_macos_update(request),
        _ => Err(error(
            "unsupported_platform",
            "automatic update is not supported on this platform",
        )),
    }
}

pub fn launch_update_helper(
    request: &LaunchUpdateHelperRequest,
) -> Result<(), UpdateInstallerError> {
    validate_helper_command(&request.command)?;
    let mut command = Command::new(&request.command[0]);
    command
        .args(&request.command[1..])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0000_0200 | 0x0000_0008);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: setsid has no memory-safety preconditions and runs immediately before exec.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    command
        .spawn()
        .map(|_| ())
        .map_err(|cause| error("launch_failed", cause.to_string()))
}

fn prepare_windows_update(
    request: &PrepareUpdateRequest,
) -> Result<PrepareUpdateResult, UpdateInstallerError> {
    let payload_root = find_windows_payload_root(&request.extract_dir, &request.executable_name)?;
    let launch_name = if request.launch_executable_name.trim().is_empty() {
        request.executable_name.as_str()
    } else {
        request.launch_executable_name.as_str()
    };
    let pids = if request.wait_pids.is_empty() {
        vec![std::process::id()]
    } else {
        request.wait_pids.clone()
    };
    let script = windows_restart_script(&payload_root, &request.install_root, launch_name, &pids);
    write_text(&request.script_path, &script.replace('\n', "\r\n"))?;
    Ok(PrepareUpdateResult {
        command: vec![
            "cmd".to_owned(),
            "/c".to_owned(),
            request.script_path.to_string_lossy().into_owned(),
        ],
        payload_root: payload_root.to_string_lossy().into_owned(),
        script_path: request.script_path.to_string_lossy().into_owned(),
    })
}

fn prepare_macos_update(
    request: &PrepareUpdateRequest,
) -> Result<PrepareUpdateResult, UpdateInstallerError> {
    if request
        .install_root
        .extension()
        .and_then(|value| value.to_str())
        != Some("app")
    {
        return Err(error(
            "install_root_not_found",
            "unable to locate the current macOS app",
        ));
    }
    let app_name = request
        .install_root
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    let source_app = find_macos_payload_app(&request.extract_dir, app_name)?;
    let pid = request
        .wait_pids
        .first()
        .copied()
        .unwrap_or_else(std::process::id);
    let script = macos_restart_script(&source_app, &request.install_root, pid);
    write_text(&request.script_path, &script)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(&request.script_path)
            .map_err(io_error("script_metadata_failed"))?
            .permissions();
        permissions.set_mode(permissions.mode() | 0o100);
        fs::set_permissions(&request.script_path, permissions)
            .map_err(io_error("script_permissions_failed"))?;
    }
    Ok(PrepareUpdateResult {
        command: vec![
            "/bin/sh".to_owned(),
            request.script_path.to_string_lossy().into_owned(),
        ],
        payload_root: source_app.to_string_lossy().into_owned(),
        script_path: request.script_path.to_string_lossy().into_owned(),
    })
}

fn safe_extract_zip(archive_path: &Path, destination: &Path) -> Result<(), UpdateInstallerError> {
    let archive_file = File::open(archive_path).map_err(io_error("archive_open_failed"))?;
    let mut archive = ZipArchive::new(archive_file)
        .map_err(|cause| error("invalid_archive", cause.to_string()))?;
    let destination_root = destination
        .canonicalize()
        .map_err(io_error("extract_root_failed"))?;
    for index in 0..archive.len() {
        let mut member = archive
            .by_index(index)
            .map_err(|cause| error("invalid_archive", cause.to_string()))?;
        let relative = member.enclosed_name().ok_or_else(|| {
            error(
                "unsafe_archive_path",
                "update archive contains an unsafe path",
            )
        })?;
        let output_path = destination_root.join(relative);
        if member.is_dir() {
            fs::create_dir_all(&output_path).map_err(io_error("extract_failed"))?;
            continue;
        }
        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent).map_err(io_error("extract_failed"))?;
        }
        let mut output = File::create(&output_path).map_err(io_error("extract_failed"))?;
        io::copy(&mut member, &mut output).map_err(io_error("extract_failed"))?;
        #[cfg(unix)]
        if let Some(mode) = member.unix_mode() {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&output_path, fs::Permissions::from_mode(mode))
                .map_err(io_error("extract_permissions_failed"))?;
        }
    }
    Ok(())
}

fn reset_directory(path: &Path) -> Result<(), UpdateInstallerError> {
    if path.exists() {
        fs::remove_dir_all(path).map_err(io_error("extract_cleanup_failed"))?;
    }
    fs::create_dir_all(path).map_err(io_error("extract_create_failed"))
}

fn find_windows_payload_root(
    root: &Path,
    executable_name: &str,
) -> Result<PathBuf, UpdateInstallerError> {
    let direct = root.join(executable_name);
    if direct.is_file() {
        return Ok(root.to_path_buf());
    }
    let mut named = Vec::new();
    let mut executables = Vec::new();
    walk_paths(root, &mut |path| {
        if path.is_file() {
            let file_name = path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default();
            if file_name.eq_ignore_ascii_case(executable_name) {
                named.push(path.to_path_buf());
            } else if path
                .extension()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.eq_ignore_ascii_case("exe"))
            {
                executables.push(path.to_path_buf());
            }
        }
    })?;
    named.sort_by_key(|path| path.components().count());
    executables.sort_by_key(|path| path.components().count());
    named
        .first()
        .or_else(|| executables.first())
        .and_then(|path| path.parent())
        .map(Path::to_path_buf)
        .ok_or_else(|| {
            error(
                "payload_not_found",
                "update archive has no Windows executable",
            )
        })
}

fn find_macos_payload_app(
    root: &Path,
    current_name: &str,
) -> Result<PathBuf, UpdateInstallerError> {
    let mut preferred = Vec::new();
    let mut apps = Vec::new();
    walk_paths(root, &mut |path| {
        if path.is_dir() && path.extension().and_then(|value| value.to_str()) == Some("app") {
            if path.file_name().and_then(|value| value.to_str()) == Some(current_name) {
                preferred.push(path.to_path_buf());
            }
            apps.push(path.to_path_buf());
        }
    })?;
    preferred.sort_by_key(|path| path.components().count());
    apps.sort_by_key(|path| path.components().count());
    preferred
        .first()
        .or_else(|| apps.first())
        .cloned()
        .ok_or_else(|| error("payload_not_found", "update archive has no macOS app"))
}

fn walk_paths(root: &Path, visitor: &mut impl FnMut(&Path)) -> Result<(), UpdateInstallerError> {
    let entries = fs::read_dir(root).map_err(io_error("payload_scan_failed"))?;
    for entry in entries {
        let path = entry.map_err(io_error("payload_scan_failed"))?.path();
        visitor(&path);
        if path.is_dir() {
            walk_paths(&path, visitor)?;
        }
    }
    Ok(())
}

fn windows_restart_script(
    source_root: &Path,
    destination_root: &Path,
    executable: &str,
    pids: &[u32],
) -> String {
    let pid_list = pids
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(" ");
    format!(
        "@echo off\nsetlocal\nset \"PIDS={pid_list}\"\nset \"SRC={}\"\nset \"DST={}\"\nset \"EXE={executable}\"\nset \"LOG=%TEMP%\\bilikara-update.log\"\nfor %%I in (%PIDS%) do call :waitpid %%I\nrobocopy \"%SRC%\" \"%DST%\" /MIR /XD runtime data updates __pycache__ /XF \"%~nx0\" > \"%LOG%\" 2>&1\nset \"RC=%ERRORLEVEL%\"\nif %RC% GEQ 8 exit /b %RC%\nstart \"\" \"%DST%\\%EXE%\"\nexit /b 0\n\n:waitpid\nset \"WAITPID=%~1\"\n:wait\nfor /f \"tokens=2\" %%P in ('tasklist /FI \"PID eq %WAITPID%\" /NH 2^>nul') do (\n  if \"%%P\"==\"%WAITPID%\" (\n    timeout /t 1 /nobreak >nul\n    goto wait\n  )\n)\nexit /b 0\n",
        source_root.display(),
        destination_root.display(),
    )
}

fn macos_restart_script(source_app: &Path, destination_app: &Path, pid: u32) -> String {
    format!(
        "#!/bin/sh\nset -u\nPID={pid}\nSRC={}\nDST={}\nBACKUP=\"${{DST}}.previous-update\"\nwhile kill -0 \"$PID\" 2>/dev/null; do\n  sleep 1\ndone\nrm -rf \"$BACKUP\"\nif [ -d \"$DST\" ]; then\n  mv \"$DST\" \"$BACKUP\" || exit 1\nfi\nditto \"$SRC\" \"$DST\"\nSTATUS=$?\nif [ \"$STATUS\" -eq 0 ]; then\n  rm -rf \"$BACKUP\"\n  open \"$DST\"\n  exit 0\nfi\nrm -rf \"$DST\"\nif [ -d \"$BACKUP\" ]; then\n  mv \"$BACKUP\" \"$DST\"\n  open \"$DST\"\nfi\nexit \"$STATUS\"\n",
        shell_quote(source_app),
        shell_quote(destination_app),
    )
}

fn shell_quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
}

fn validate_helper_command(command: &[String]) -> Result<(), UpdateInstallerError> {
    match command {
        [program, flag, script]
            if program.eq_ignore_ascii_case("cmd")
                && flag.eq_ignore_ascii_case("/c")
                && script.to_lowercase().ends_with(".cmd") =>
        {
            Ok(())
        }
        [program, script] if program == "/bin/sh" && script.ends_with(".sh") => Ok(()),
        _ => Err(error(
            "invalid_helper",
            "refusing to launch an unknown update helper",
        )),
    }
}

fn write_text(path: &Path, content: &str) -> Result<(), UpdateInstallerError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(io_error("script_create_failed"))?;
    }
    let mut file = File::create(path).map_err(io_error("script_create_failed"))?;
    file.write_all(content.as_bytes())
        .map_err(io_error("script_write_failed"))
}

fn io_error(kind: &'static str) -> impl FnOnce(io::Error) -> UpdateInstallerError {
    move |cause| error(kind, cause.to_string())
}

fn error(kind: &'static str, message: impl Into<String>) -> UpdateInstallerError {
    UpdateInstallerError {
        kind,
        message: message.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};
    use zip::ZipWriter;
    use zip::write::SimpleFileOptions;

    #[test]
    fn windows_script_excludes_runtime_owned_directories() {
        let script = windows_restart_script(
            Path::new(r"C:\update\bilikara"),
            Path::new(r"C:\bilikara"),
            "bilikara-desktop.exe",
            &[111, 222],
        );
        assert!(script.contains("/XD runtime data updates __pycache__"));
        assert!(script.contains("PIDS=111 222"));
        assert!(script.contains("bilikara-desktop.exe"));
    }

    #[test]
    fn helper_launcher_rejects_arbitrary_commands() {
        let error = validate_helper_command(&["powershell".to_owned(), "malicious".to_owned()])
            .unwrap_err();
        assert_eq!(error.kind, "invalid_helper");
    }

    #[test]
    fn prepare_windows_update_extracts_and_writes_helper() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("bilikara-update-test-{unique}"));
        fs::create_dir_all(&root).unwrap();
        let archive_path = root.join("update.zip");
        let archive = File::create(&archive_path).unwrap();
        let mut writer = ZipWriter::new(archive);
        writer
            .start_file("bundle/bilikara.exe", SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"test executable").unwrap();
        writer.finish().unwrap();

        let result = prepare_update(&PrepareUpdateRequest {
            platform: "windows".to_owned(),
            archive_path,
            extract_dir: root.join("extracted"),
            script_path: root.join("apply.cmd"),
            install_root: root.join("installed"),
            executable_name: "bilikara.exe".to_owned(),
            launch_executable_name: "bilikara-desktop.exe".to_owned(),
            wait_pids: vec![42],
        })
        .unwrap();

        assert!(
            Path::new(&result.payload_root)
                .join("bilikara.exe")
                .is_file()
        );
        assert!(root.join("apply.cmd").is_file());
        assert_eq!(result.command[0], "cmd");
        fs::remove_dir_all(root).unwrap();
    }
}
