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

fn inspection(backend: &Path, source: Option<&Path>) -> Result<Inspection, String> {
    let mut args = vec![OsString::from("--inspect-legacy-import")];
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
    let report: Completion = serde_json::from_slice(&execute(backend, &args, DEADLINE)?)
        .map_err(|_| "导入结果无效，请再次运行工具检查。")?;
    if report.schema_version != 1
        || (report.destination != destination
            && destination
                .parent()
                .and_then(|p| p.canonicalize().ok())
                .and_then(|p| destination.file_name().map(|name| p.join(name)))
                .as_ref()
                != Some(&report.destination))
        || report.backup.as_ref().is_some_and(|p| !p.is_absolute())
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
        .map(|p| format!("\n\n旧数据备份：\n{}", p.display()))
        .unwrap_or_default();
    information(
        app,
        format!(
            "导入完成。现在可以正常打开 bilikara。\n\n数据位置：\n{}{backup}\n\n媒体将重新缓存，Remote 设备需要重新登记。",
            report.destination.display()
        ),
    );
}

fn choose_folder(app: &tauri::AppHandle) -> Result<Option<PathBuf>, String> {
    app.dialog()
        .file()
        .set_title("选择旧版 runtime、data 或 bilikara 数据文件夹")
        .blocking_pick_folder()
        .map(|p| p.into_path().map_err(|_| "请选择本机的数据文件夹。".into()))
        .transpose()
}

fn workflow(app: &tauri::AppHandle) -> Result<(), String> {
    let backend = crate::backend_process::import_tool_backend()?;
    let mut report = inspection(&backend, None)?;
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
            return Ok(());
        }
        let recovered = convert(&backend, &report.destination, None)?;
        if recovered.completed {
            success(app, &recovered);
            return Ok(());
        }
        information(app, "已恢复旧数据。接下来可以重新选择导入来源。");
        report = inspection(&backend, None)?;
    }
    if report.destination_status == "native" {
        information(
            app,
            "目标已有新版原生数据文件。本工具不会覆盖或合并已有歌单和记录。",
        );
        return Ok(());
    }
    if !["missing", "empty", "legacy"].contains(&report.destination_status.as_str()) {
        return Err("目标目录包含无法识别或未完成的数据。请保留这个目录，并在新解压的 bilikara 中运行导入工具。".into());
    }
    let mut index = 0;
    loop {
        let source = if let Some(source) = report.candidates.get(index) {
            source.clone()
        } else {
            let Some(selected) = choose_folder(app)? else {
                return Ok(());
            };
            match inspection(&backend, Some(&selected)) {
                Ok(selected) => selected
                    .candidates
                    .into_iter()
                    .next()
                    .ok_or("没有发现可导入的旧数据。")?,
                Err(error) => {
                    information(app, error);
                    continue;
                }
            }
        };
        let result=app.dialog().message(format!("检测到旧版数据：\n{}\n\n导入位置：\n{}\n\n请先关闭旧版和新版 bilikara。导入会保留已保存的歌单、历史和分场记录，并保留旧数据备份。",source.display(),report.destination.display()))
            .title("bilikara · 导入旧数据").buttons(MessageDialogButtons::YesNoCancelCustom(
                "导入".into(),if index+1<report.candidates.len(){"下一处"}else{"选择其他位置"}.into(),"取消".into()))
            .blocking_show_with_result();
        match result {
            MessageDialogResult::Yes | MessageDialogResult::Ok => {}
            MessageDialogResult::Custom(ref label) if label == "导入" => {}
            MessageDialogResult::No => {
                index += 1;
                continue;
            }
            MessageDialogResult::Custom(ref label)
                if label == "下一处" || label == "选择其他位置" =>
            {
                index += 1;
                continue;
            }
            _ => return Ok(()),
        }
        let converted = convert(&backend, &report.destination, Some(&source))?;
        if !converted.completed {
            return Err("旧数据已恢复，请重新运行工具导入。".into());
        }
        success(app, &converted);
        return Ok(());
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
                    let status = match workflow(&app) {
                        Ok(()) => 0,
                        Err(error) => {
                            app.dialog()
                                .message(error)
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
        std::fs::remove_dir_all(directory).unwrap();
    }
}
