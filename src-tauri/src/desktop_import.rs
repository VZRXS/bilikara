//! Separate import-tool mode. Native dialogs collect consent and paths; the
//! existing packaged Rust Host performs bounded, offline, one-shot operations.
use serde::Deserialize;
use std::{
    ffi::OsString,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};
use tauri::Manager;
use tauri_plugin_dialog::{
    DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};

const LIMIT: u64 = 1024 * 1024;
const DEADLINE: Duration = Duration::from_secs(120);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Inspection {
    schema_version: u32,
    destination: PathBuf,
    destination_status: String,
    pending: bool,
    candidates: Vec<PathBuf>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Completion {
    schema_version: u32,
    destination: PathBuf,
    backup: Option<PathBuf>,
    completed: bool,
    #[serde(default)]
    source_format: Option<String>,
    #[serde(default)]
    source_backup: Option<PathBuf>,
    #[serde(default)]
    cleanup_warning: Option<String>,
}

const FEEDBACK_URL: &str = "https://github.com/VZRXS/bilikara/issues";

fn failure_message(error: &str) -> String {
    format!("{error}\n\n请在 GitHub 项目反馈或联系开发者：\n{FEEDBACK_URL}")
}

fn execute(program: &Path, arguments: &[OsString], deadline: Duration) -> Result<Vec<u8>, String> {
    let mut command = Command::new(program);
    command
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().map_err(|_| "无法启动随包的导入程序。")?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let (send, receive) = mpsc::channel();
    for (index, mut stream) in [Box::new(stdout) as Box<dyn Read + Send>, Box::new(stderr)]
        .into_iter()
        .enumerate()
    {
        let send = send.clone();
        thread::spawn(move || {
            let mut bytes = Vec::new();
            let result = stream.by_ref().take(LIMIT + 1).read_to_end(&mut bytes);
            let _ = send.send((index, result.map(|_| bytes)));
        });
    }
    drop(send);
    let started = Instant::now();
    let mut outputs = [None, None];
    let mut status = None;
    let outcome = (|| {
        loop {
            for (index, result) in receive.try_iter() {
                let bytes = result.map_err(|_| "无法读取导入结果。")?;
                if bytes.len() as u64 > LIMIT {
                    return Err("导入输出超过限制，已停止；请再次运行工具恢复。".into());
                }
                outputs[index] = Some(bytes);
            }
            if status.is_none() {
                status = child.try_wait().map_err(|_| "无法检查导入进程。")?;
            }
            if let Some(status) = status
                && outputs.iter().all(Option::is_some)
            {
                if !status.success() {
                    let diagnostic = String::from_utf8(outputs[1].take().unwrap())
                        .map_err(|_| "导入错误信息不是有效 UTF-8。")?;
                    return Err(format!(
                        "导入未完成，旧数据和备份已保留。\n{}",
                        diagnostic.trim()
                    ));
                }
                return Ok(outputs[0].take().unwrap());
            }
            if started.elapsed() >= deadline {
                return Err("导入超时，已停止；请再次运行工具恢复。".into());
            }
            thread::sleep(Duration::from_millis(10));
        }
    })();
    // This offline command never launches descendants, listeners or download
    // workers. Kill and reap the one owned converter before reporting failure.
    if outcome.is_err() {
        let _ = child.kill();
    }
    let _ = child.wait();
    outcome
}

fn inspection(
    backend: &Path,
    source: Option<&Path>,
    first_start: bool,
) -> Result<Inspection, String> {
    let mut args = vec![OsString::from(if first_start {
        "--inspect-first-start"
    } else {
        "--inspect-legacy-import"
    })];
    if let Some(source) = source {
        args.extend([
            OsString::from("--import-from"),
            source.as_os_str().to_owned(),
        ]);
    }
    let report: Inspection = serde_json::from_slice(&execute(backend, &args, DEADLINE)?)
        .map_err(|_| "导入检测结果无效。")?;
    if report.schema_version != 1
        || !report.destination.is_absolute()
        || report.candidates.iter().any(|p| !p.is_absolute())
    {
        return Err("导入检测结果不兼容。".into());
    }
    Ok(report)
}

fn convert(
    backend: &Path,
    destination: &Path,
    source: Option<&Path>,
    replace_native: bool,
) -> Result<Completion, String> {
    let mut args = vec![
        OsString::from("--import-only"),
        OsString::from("--data-dir"),
        destination.as_os_str().to_owned(),
    ];
    if let Some(source) = source {
        args.extend([
            OsString::from("--import-from"),
            source.as_os_str().to_owned(),
        ]);
    }
    if replace_native {
        args.push(OsString::from("--replace-native"));
    }
    if source.is_some() {
        args.push(OsString::from("--remove-source"));
    }
    completion(backend, &args, Some(destination))
}

fn start_without_import(
    backend: &Path,
    destination: Option<&Path>,
    failed_source: Option<&Path>,
) -> Result<Completion, String> {
    start_without_import_deadline(backend, destination, failed_source, DEADLINE)
}

fn start_without_import_deadline(
    backend: &Path,
    destination: Option<&Path>,
    failed_source: Option<&Path>,
    deadline: Duration,
) -> Result<Completion, String> {
    let mut args = vec![OsString::from("--start-without-import")];
    if let Some(destination) = destination {
        args.extend(["--data-dir".into(), destination.as_os_str().to_owned()]);
    }
    if let Some(source) = failed_source {
        args.extend(["--import-from".into(), source.as_os_str().to_owned()]);
    }
    let report = match completion_with_deadline(backend, &args, destination, deadline) {
        Ok(report) => report,
        Err(error) if failed_source.is_some() => {
            // Fresh publication precedes raw-source isolation. Its process can
            // time out while preserving a large cache, after committing valid
            // native records. Reap it, then validate/finish normal startup
            // without retrying the source move or bypassing native protection.
            args.truncate(args.len() - 2);
            let mut report = completion_with_deadline(backend, &args, destination, deadline)
                .map_err(|validation| format!("{error}\n\n无法安全准备正常启动：{validation}"))?;
            report.cleanup_warning = Some(format!(
                "旧数据隔离未完全确认，请保留原件及已生成的备份。\n{error}"
            ));
            report
        }
        Err(error) => return Err(error),
    };
    if !report.completed {
        return Err("未能安全准备正常启动，请保留数据。".into());
    }
    Ok(report)
}

fn preserved_data(report: &Completion) -> String {
    let mut message = report
        .backup
        .as_ref()
        .map(|p| format!("\n\n原数据备份：\n{}", p.display()))
        .unwrap_or_default();
    if let Some(path) = &report.source_backup
        && Some(path) != report.backup.as_ref()
    {
        message.push_str(&format!(
            "\n\n失败来源已隔离到旧数据备份：\n{}",
            path.display()
        ));
    }
    if let Some(warning) = &report.cleanup_warning {
        message.push_str(&format!(
            "\n\n旧数据无法完全隔离，原文件或已生成的备份均已保留：\n{warning}"
        ));
    }
    message
}

fn completion(
    backend: &Path,
    args: &[OsString],
    destination: Option<&Path>,
) -> Result<Completion, String> {
    completion_with_deadline(backend, args, destination, DEADLINE)
}

fn completion_with_deadline(
    backend: &Path,
    args: &[OsString],
    destination: Option<&Path>,
    deadline: Duration,
) -> Result<Completion, String> {
    let report: Completion = serde_json::from_slice(&execute(backend, args, deadline)?)
        .map_err(|_| "导入结果无效，请再次运行工具检查。")?;
    if report.schema_version != 1
        || !report.destination.is_absolute()
        || destination.is_some_and(|destination| {
            report.destination != destination
                && destination
                    .parent()
                    .and_then(|p| p.canonicalize().ok())
                    .and_then(|p| destination.file_name().map(|name| p.join(name)))
                    .as_ref()
                    != Some(&report.destination)
        })
        || report.backup.as_ref().is_some_and(|p| !p.is_absolute())
        || report
            .source_backup
            .as_ref()
            .is_some_and(|p| !p.is_absolute())
        || report
            .source_format
            .as_deref()
            .is_some_and(|kind| !["legacy", "native", "fresh"].contains(&kind))
    {
        return Err("导入结果不兼容，请保留数据。".into());
    }
    Ok(report)
}

fn information(app: &tauri::AppHandle, message: impl Into<String>) {
    app.dialog()
        .message(message)
        .title("bilikara · 导入旧数据")
        .blocking_show();
}

fn success(app: &tauri::AppHandle, report: &Completion) {
    let backup = report
        .backup
        .as_ref()
        .map(|p| format!("\n\n原数据备份：\n{}", p.display()))
        .unwrap_or_default();
    let source_backup = report
        .source_backup
        .as_ref()
        .map(|p| {
            format!(
                "\n\n来源数据已移到备份，旧位置不再保留记录：\n{}",
                p.display()
            )
        })
        .unwrap_or_default();
    let note = match report.source_format.as_deref() {
        Some("native") => "新版格式直接复制，保留已有媒体缓存和设备登记。",
        Some("legacy") => "旧格式转换后媒体会重新缓存，Remote 设备需要重新登记。",
        _ => "若来源为旧格式，媒体会重新缓存，Remote 设备需要重新登记。",
    };
    let warning = report
        .cleanup_warning
        .as_ref()
        .map(|e| {
            format!(
                "\n\n来源清理未完全确认，请保留原数据及备份。\n{}",
                failure_message(e)
            )
        })
        .unwrap_or_default();
    information(
        app,
        format!(
            "导入完成。现在可以正常打开 bilikara。\n\n数据位置：\n{}{backup}{source_backup}\n\n{note}{warning}",
            report.destination.display()
        ),
    );
}

fn choose_folder(app: &tauri::AppHandle) -> Result<Option<PathBuf>, String> {
    app.dialog()
        .file()
        .set_title("选择旧版 runtime 文件夹（也可选择 data 或 bilikara 应用数据文件夹）")
        .blocking_pick_folder()
        .map(|p| p.into_path().map_err(|_| "请选择本机的数据文件夹。".into()))
        .transpose()
}

// Only known checkpoint/guard names are checked on an ordinary reopening.
// The backend remains authoritative for directory validation and conversion.
fn needs_startup_inspection(
    executable: &Path,
    platform: &str,
    env: impl Fn(&str) -> Option<OsString>,
) -> Result<bool, String> {
    if [
        "BILIKARA_NATIVE_DATA_DIR",
        "BILIKARA_DESKTOP_RUST_PREVIEW_DIR",
        "BILIKARA_HOME",
    ]
    .into_iter()
    .any(|key| env(key).is_some_and(|v| !v.is_empty()))
    {
        return Ok(false);
    }
    let home = || {
        env("HOME")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .ok_or("无法确定应用数据位置。".to_string())
    };
    let base = match platform {
        "windows" => executable
            .parent()
            .ok_or("无法确定安装位置。")?
            .join("runtime"),
        "macos" => home()?.join("Library/Application Support/bilikara"),
        _ => env("XDG_DATA_HOME")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .map(Ok)
            .unwrap_or_else(|| home().map(|p| p.join(".local/share")))?
            .join("bilikara"),
    };
    let data = base.join("data");
    let previous = base.join("native");
    let data = if !data.join("host-state.json").exists() && previous.exists() {
        previous
    } else {
        data
    };
    let mut pending = OsString::from(".");
    pending.push(data.file_name().ok_or("无法确定数据位置。")?);
    pending.push(".bilikara-import.json");
    if std::fs::symlink_metadata(base.join(pending)).is_ok() {
        return Ok(true);
    }
    Ok(!["host-state.json", ".bilikara-desktop-rust-preview"]
        .into_iter()
        .any(|name| std::fs::symlink_metadata(data.join(name)).is_ok()))
}

pub(crate) fn gate_startup(
    app: &tauri::App,
    window: tauri::WebviewWindow,
    startup_log: Option<crate::desktop_diagnostics::DesktopStartupLog>,
) {
    let needed = std::env::current_exe()
        .map_err(|_| "无法确定启动程序位置。".to_string())
        .and_then(|path| {
            needs_startup_inspection(&path, std::env::consts::OS, |key| std::env::var_os(key))
        });
    if matches!(needed, Ok(false)) {
        crate::backend_process::launch(app.handle(), window, startup_log);
        return;
    }
    let app = app.handle().clone();
    thread::spawn(move || {
        let result = needed.and_then(|_| workflow(&app, true));
        match result {
            Ok(true) if app.get_webview_window("main").is_some() => {
                crate::backend_process::launch(&app, window, startup_log);
            }
            Ok(_) => app.exit(0),
            Err(error) => {
                information(&app, error);
                app.exit(1);
            }
        }
    });
}

fn workflow(app: &tauri::AppHandle, first_start: bool) -> Result<bool, String> {
    let backend = crate::backend_process::import_tool_backend()?;
    let mut confirmed_source = None;
    match workflow_inner(app, &backend, first_start, &mut confirmed_source) {
        Err(error) if first_start => {
            // Handle failed legacy import once, before normal Host startup.
            // The staged transaction also backs up in-place legacy records;
            // native corruption and conflicting recovery remain protected.
            let fresh = start_without_import(&backend, None, confirmed_source.as_deref()).map_err(
                |fresh_error| {
                    failure_message(&format!("{error}\n\n无法安全准备正常启动：{fresh_error}"))
                },
            )?;
            let backup = preserved_data(&fresh);
            information(
                app,
                failure_message(&format!(
                    "{error}{backup}\n\n本次不再自动尝试导入，接下来正常启动。之后可关闭软件，运行「导入旧数据」工具重新选择 runtime 文件夹。"
                )),
            );
            Ok(true)
        }
        Err(error) => {
            // A manual attempt before the first launch must not leave an
            // invalid legacy destination waiting to intercept the next launch.
            // Existing native/recovery data still follows its protected path.
            if let Ok(report) = inspection(&backend, None, true)
                && !report.pending
                && ["missing", "empty", "legacy"].contains(&report.destination_status.as_str())
            {
                let fresh = start_without_import(
                    &backend,
                    Some(&report.destination),
                    confirmed_source.as_deref(),
                )?;
                let backup = preserved_data(&fresh);
                return Err(format!(
                    "{error}{backup}\n\n下次可正常启动，不再自动尝试导入；也可重新运行本工具选择正确的 runtime 文件夹。"
                ));
            }
            Err(error)
        }
        other => other,
    }
}

fn skip_import(backend: &Path, report: &Inspection, first_start: bool) -> Result<bool, String> {
    if first_start {
        let fresh = start_without_import(backend, Some(&report.destination), None)?;
        if !fresh.completed {
            return Err("未能安全准备正常启动，请保留数据。".into());
        }
    }
    Ok(first_start)
}

fn workflow_inner(
    app: &tauri::AppHandle,
    backend: &Path,
    first_start: bool,
    confirmed_source: &mut Option<PathBuf>,
) -> Result<bool, String> {
    let mut report = inspection(backend, None, first_start)?;
    if report.pending {
        let agreed = app
            .dialog()
            .message(
                "发现上次未完成的数据导入。请先关闭旧版和新版 bilikara，再恢复。原始数据会保留。",
            )
            .title("bilikara · 恢复数据导入")
            .buttons(MessageDialogButtons::OkCancelCustom(
                "恢复".into(),
                "取消".into(),
            ))
            .blocking_show();
        if !agreed {
            return Ok(false);
        }
        let recovered = convert(backend, &report.destination, None, false)?;
        if recovered.completed {
            success(app, &recovered);
            return Ok(true);
        }
        information(app, "已恢复原数据。接下来可以重新选择导入来源。");
        report = inspection(backend, None, first_start)?;
    }
    if first_start && (report.destination_status == "native" || report.candidates.is_empty()) {
        return Ok(true);
    }
    if !["missing", "empty", "legacy", "native"].contains(&report.destination_status.as_str()) {
        return Err("目标目录包含无法识别或未完成的数据。请保留这个目录，并在新解压的 bilikara 中运行导入工具。".into());
    }
    let mut selected = report.candidates.first().cloned();
    loop {
        let source = if let Some(source) = selected.take() {
            source
        } else {
            let Some(selected) = choose_folder(app)? else {
                return skip_import(backend, &report, first_start);
            };
            inspection(backend, Some(&selected), false)?
                .candidates
                .into_iter()
                .next()
                .ok_or("没有发现可导入的数据，请选择旧版 runtime 文件夹。")?
        };
        let close_instruction = if first_start {
            "请先关闭旧版 bilikara。"
        } else {
            "请先关闭其他 bilikara 窗口。"
        };
        let result=app.dialog().message(format!("检测到可导入的数据：\n{}\n\n导入位置：\n{}\n\n{close_instruction}旧格式会转换，新版格式直接复制并校验。导入后，来源的 data 文件夹会移到备份，旧位置不再保留记录。\n\n来源不对？点击「选择其他路径」，选择旧版 runtime 文件夹（或 data、应用数据文件夹）。",source.display(),report.destination.display()))
            .title("bilikara · 导入旧数据").buttons(MessageDialogButtons::YesNoCancelCustom(
                "导入".into(),"选择其他路径".into(),if first_start { "暂不导入" } else { "取消" }.into()))
            .blocking_show_with_result();
        match result {
            MessageDialogResult::Yes | MessageDialogResult::Ok => {}
            MessageDialogResult::Custom(ref label) if label == "导入" => {}
            MessageDialogResult::No => {
                continue;
            }
            MessageDialogResult::Custom(ref label) if label == "选择其他路径" => {
                continue;
            }
            _ => return skip_import(backend, &report, first_start),
        }
        let replace_native = report.destination_status == "native";
        if replace_native && !app.dialog()
            .message("当前已存在新版数据。导入会先完整备份当前数据，再以旧版记录替换；不会合并两份歌单和历史。请关闭所有 bilikara 窗口后继续。")
            .title("bilikara · 备份并导入")
            .buttons(MessageDialogButtons::OkCancelCustom("备份并导入".into(), "取消".into()))
            .blocking_show() {
            return Ok(false);
        }
        *confirmed_source = Some(source.clone());
        let converted = convert(backend, &report.destination, Some(&source), replace_native)?;
        if !converted.completed {
            return Err("旧数据已恢复，请重新运行工具导入。".into());
        }
        success(app, &converted);
        return Ok(true);
    }
}

pub(crate) fn run(mut context: tauri::Context<tauri::Wry>) {
    // No WebView, Host launch, tray or normal application lifecycle in this mode.
    context.config_mut().app.windows.clear();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let app = app.handle().clone();
            thread::Builder::new()
                .name("bilikara-legacy-import".into())
                .spawn(move || {
                    let status = match workflow(&app, false) {
                        Ok(_) => 0,
                        Err(error) => {
                            app.dialog()
                                .message(failure_message(&error))
                                .title("bilikara · 导入未完成")
                                .kind(MessageDialogKind::Error)
                                .blocking_show();
                            1
                        }
                    };
                    app.exit(status);
                })?;
            Ok(())
        })
        .run(context)
        .expect("Unable to run bilikara import tool");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn first_start_uses_checkpoint_not_runtime_directory_and_preserves_overrides() {
        let root =
            std::env::temp_dir().join(format!("bilikara first start 中文 {}", std::process::id()));
        std::fs::create_dir_all(root.join("runtime/webview")).unwrap();
        let executable = root.join("bilikara-desktop.exe");
        assert!(needs_startup_inspection(&executable, "windows", |_| None).unwrap());
        std::fs::create_dir_all(root.join("runtime/data")).unwrap();
        std::fs::write(
            root.join("runtime/data/host-state.json"),
            b"invalid protected native data",
        )
        .unwrap();
        assert!(!needs_startup_inspection(&executable, "windows", |_| None).unwrap());
        std::fs::write(root.join("runtime/.data.bilikara-import.json"), b"pending").unwrap();
        assert!(needs_startup_inspection(&executable, "windows", |_| None).unwrap());
        assert!(
            !needs_startup_inspection(&executable, "windows", |key| (key
                == "BILIKARA_NATIVE_DATA_DIR")
                .then(|| root.clone().into_os_string()))
            .unwrap()
        );
        for (platform, relative) in [
            ("macos", "Library/Application Support/bilikara"),
            ("linux", ".local/share/bilikara"),
        ] {
            let env = |key: &str| (key == "HOME").then(|| root.clone().into_os_string());
            assert!(needs_startup_inspection(&executable, platform, env).unwrap());
            let base = root.join(relative).join("native");
            std::fs::create_dir_all(&base).unwrap();
            std::fs::write(base.join("host-state.json"), b"native fixture").unwrap();
            assert!(!needs_startup_inspection(&executable, platform, env).unwrap());
        }
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn native_converter_arguments_failures_output_bounds_and_deadline() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_owned();
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "bilikara import fixture 中文 $() & {}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir(&directory).unwrap();
        let binary = directory.join(if cfg!(windows) {
            "fixture.exe"
        } else {
            "fixture"
        });
        let compiled = Command::new("rustc")
            .current_dir(&root)
            // Direct rustc defaults to its executing host and ignores product
            // CARGO_BUILD_TARGET; `host-tuple` is a Cargo-only target alias.
            .args(["--edition=2024", "--crate-name", "import_process"])
            .arg(root.join("tests/fixtures/desktop_import_process.rs"))
            .arg("-o")
            .arg(&binary)
            .status()
            .unwrap();
        assert!(compiled.success());
        let value = "空格 中文 $() & literal\\separator";
        assert_eq!(
            execute(
                &binary,
                &["arguments".into(), value.into()],
                Duration::from_secs(10)
            )
            .unwrap(),
            value.as_bytes()
        );
        assert!(
            execute(&binary, &["fail".into()], Duration::from_secs(10))
                .unwrap_err()
                .contains("Synthetic invalid state")
        );
        assert!(
            execute(&binary, &["large".into()], Duration::from_secs(10))
                .unwrap_err()
                .contains("超过限制")
        );
        let start = Instant::now();
        assert!(
            execute(&binary, &["waiting".into()], Duration::from_millis(100))
                .unwrap_err()
                .contains("超时")
        );
        assert!(start.elapsed() < Duration::from_secs(5));
        std::fs::write(
            directory.join("fresh-result.json"),
            serde_json::to_vec(&serde_json::json!({
                "schema_version":1, "destination":directory, "backup":null, "completed":true
            }))
            .unwrap(),
        )
        .unwrap();
        let fresh = start_without_import_deadline(
            &binary,
            Some(&directory),
            Some(&directory.join("old runtime")),
            Duration::from_secs(1),
        )
        .expect("backup timeout must not block validated normal startup");
        assert!(fresh.completed);
        assert!(fresh.cleanup_warning.unwrap().contains("超时"));
        assert_eq!(
            std::fs::read_to_string(directory.join("fresh-attempts.txt")).unwrap(),
            "isolate\ninitialize\n"
        );
        std::fs::write(
            directory.join("fresh-result.json"),
            serde_json::to_vec(&serde_json::json!({
                "schema_version":1, "destination":directory, "backup":null, "completed":false
            }))
            .unwrap(),
        )
        .unwrap();
        assert!(
            start_without_import_deadline(&binary, Some(&directory), None, Duration::from_secs(1))
                .is_err(),
            "normal startup still requires a completed native result"
        );
        std::fs::remove_dir_all(directory).unwrap();
    }
}
