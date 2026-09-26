//! One desktop update operation, owned by the existing Host and AppState.
use super::*;
use crate::update_installer::native::{Installation, Prepared};
use sha2::{Digest, Sha256};
use std::sync::atomic::AtomicU8;

const MAX_PACKAGE: u64 = 1024 * 1024 * 1024;
const WORKING: u8 = 0;
const PREPARED: u8 = 1;
const ACTIVATING: u8 = 2;
const COMMITTED: u8 = 3;
const CANCELLED: u8 = 4;

#[derive(Clone)]
pub(super) struct Job {
    phase: Arc<AtomicU8>,
    prepared: Option<Prepared>,
    session_generation: u64,
}
impl Job {
    pub(super) fn cancel(&self) {
        self.phase.store(CANCELLED, Ordering::Release);
    }
}

#[cfg(test)]
pub(super) static DOWNLOAD_OVERRIDE: std::sync::Mutex<Option<Vec<String>>> =
    std::sync::Mutex::new(None);

/// Metadata is not an installability proof. Retain a bounded, digest-bound
/// candidate, then inspect its actual native layout before activation.
pub(super) fn package(payload: &Value, status: &Value) -> Option<Value> {
    if status["eligible_update"] != true {
        return None;
    }
    let releases: Vec<&Value> = if let Some(array) = payload.as_array() {
        array.iter().collect()
    } else {
        vec![payload]
    };
    let release = releases
        .into_iter()
        .find(|r| r["tag_name"] == status["latest_version"])?;
    let name = status["asset_name"].as_str()?;
    if name.len() > 200
        || !name.ends_with(".zip")
        || !name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
    {
        return None;
    }
    let asset = release["assets"]
        .as_array()?
        .iter()
        .find(|a| a["name"] == name)?;
    let bytes = asset["size"]
        .as_u64()
        .filter(|n| (1..=MAX_PACKAGE).contains(n))?;
    let hash = asset["digest"].as_str()?.strip_prefix("sha256:")?;
    if hash.len() != 64 || !hash.bytes().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    Some(
        json!({"name":name,"bytes":bytes,"sha256":hash.to_lowercase(),"tag":status["latest_version"]}),
    )
}

fn candidates(package: &Value) -> Vec<crate::DownloadCandidate> {
    #[cfg(test)]
    if let Some(urls) = DOWNLOAD_OVERRIDE.lock().unwrap().clone() {
        return urls
            .into_iter()
            .map(|url| crate::DownloadCandidate {
                url,
                headers: vec![],
            })
            .collect();
    }
    let tag = package["tag"].as_str().unwrap_or_default();
    let name = package["name"].as_str().unwrap_or_default();
    let planned =
        bilikara_rust::plan_update_download_candidates(&bilikara_rust::UpdateDownloadPlanRequest {
            candidates: vec![
                bilikara_rust::UpdateCandidateInput {
                    original_index: 0,
                    source: bilikara_rust::UpdateCandidateSource::Primary,
                    url: format!(
                        "https://github.com/VZRXS/bilikara/releases/download/{tag}/{name}"
                    ),
                },
                bilikara_rust::UpdateCandidateInput {
                    original_index: 1,
                    source: bilikara_rust::UpdateCandidateSource::DerivedMirror,
                    url: format!(
                        "https://api.kevinx96.icu/bilikara/releases/download/{tag}/{name}"
                    ),
                },
            ],
            proxy: crate::native_host::environment::download_proxy(),
        })
        .expect("fixed candidate identities");
    planned
        .candidates
        .into_iter()
        .map(|c| crate::DownloadCandidate {
            url: c.url,
            headers: vec![],
        })
        .collect()
}

fn current(context: &HostContext, operation: u64, phase: &AtomicU8) -> bool {
    if context.stop.load(Ordering::Acquire) || phase.load(Ordering::Acquire) >= ACTIVATING {
        return false;
    }
    with_app(|app| {
        let generation = app.native_core_snapshot()?.session_generation;
        let update = &app.native().updates;
        Ok(update.operation == operation
            && update.install.as_ref().is_some_and(|job| {
                job.session_generation == generation && std::ptr::eq(job.phase.as_ref(), phase)
            }))
    })
    .unwrap_or(false)
}
fn failure(message: impl Into<String>) -> ApiError {
    ApiError::new(400, "update_install_failed", message)
}

pub(super) fn start(context: &Arc<HostContext>, body: &Value) -> Result<Value, ApiError> {
    if context.stop.load(Ordering::Acquire) {
        return Err(failure("Host 已停止"));
    }
    let installation = context
        .desktop_installation
        .clone()
        .ok_or_else(|| ApiError::new(409, "manual_update", "当前启动方式只支持检查和手动更新"))?;
    if !installation.permits_data_directory(&context.directory) {
        return Err(failure(
            "安装目录内仅支持 runtime/data（兼容旧 native）数据目录的自动更新；自定义目录请手动更新并保留数据",
        ));
    }
    if body.as_object().is_none_or(|m| m.len() != 1) || !body["include_preview"].is_boolean() {
        return Err(ApiError::invalid("安装只接受已检查的更新频道"));
    }
    let phase = Arc::new(AtomicU8::new(WORKING));
    let (operation, package, status) = with_app(|app| {
        let session_generation = app.native_core_snapshot()?.session_generation;
        let session = app.native();
        let update = &mut session.updates;
        if update.busy() {
            return Err(ApiError::new(409, "update_busy", "更新操作正在进行"));
        }
        if body["include_preview"] != update.status["include_preview"] {
            return Err(ApiError::invalid("更新频道已更改，请重新检查"));
        }
        let package = update
            .package
            .clone()
            .ok_or_else(|| ApiError::invalid("请先检查包含完整性信息的原生更新包"))?;
        update.operation += 1;
        update.install = Some(Job {
            phase: phase.clone(),
            prepared: None,
            session_generation,
        });
        update.status["operation"] = json!(update.operation);
        update.status["state"] = json!("downloading");
        update.status["error"] = json!("");
        update.status["cancellable"] = json!(true);
        update.status["message"] = json!("正在下载更新；验证原生包后将关闭并重新启动应用");
        update.status["updated_at"] = json!(now());
        session.revision += 1;
        Ok((update.operation, package, update.snapshot()))
    })?;
    let worker = context.clone();
    let worker_phase = phase.clone();
    if context
        .spawn("desktop-update", move || {
            run(worker, installation, package, operation, worker_phase)
        })
        .is_err()
    {
        phase.store(CANCELLED, Ordering::Release);
        with_app(|app| {
            let session = app.native();
            if session.updates.operation == operation {
                session.updates.install = None;
                session.updates.status["state"] = json!("failed");
                session.updates.status["error"] = json!("Host 无法启动更新任务");
                session.revision += 1;
            }
            Ok(())
        })?;
        return Err(failure("Host 无法启动更新任务"));
    }
    Ok(status)
}

fn run(
    context: Arc<HostContext>,
    installation: Installation,
    package: Value,
    operation: u64,
    phase: Arc<AtomicU8>,
) {
    let workspace = installation
        .update_workspace_parent(&context.directory)
        .join(format!(
            "update-{}",
            token().unwrap_or_else(|_| format!("{operation}"))
        ));
    let mut created = false;
    let result = (|| {
        std::fs::create_dir(&workspace).map_err(|_| failure("无法创建更新暂存目录"))?;
        created = true;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&workspace, std::fs::Permissions::from_mode(0o700))
                .map_err(|_| failure("无法保护更新暂存目录"))?;
        }
        let archive = workspace.join("update.zip");
        let expected = package["bytes"]
            .as_u64()
            .ok_or_else(|| failure("更新大小无效"))?;
        let mut too_large = false;
        let result = crate::http_downloader::download_release_to_path(
            &crate::DownloadRequest {
                schema_version: 1,
                candidates: candidates(&package),
                destination: archive.clone(),
                connect_timeout_ms: 10_000,
                request_timeout_ms: 30_000,
                attempts_per_candidate: 1,
            },
            expected,
            |progress| {
                too_large |= progress.downloaded_bytes > expected
                    || progress.total_bytes.is_some_and(|n| n > expected);
                if too_large || !current(&context, operation, &phase) {
                    return false;
                }
                with_app(|app| {
                    let session = app.native();
                    if session.updates.operation != operation {
                        return Ok(false);
                    }
                    let status = &mut session.updates.status;
                    status["downloaded_bytes"] = json!(progress.downloaded_bytes);
                    status["total_bytes"] = json!(expected);
                    status["updated_at"] = json!(now());
                    session.revision += 1;
                    Ok(true)
                })
                .unwrap_or(false)
            },
        )
        .map_err(|error| {
            failure(
                if too_large || error.kind == crate::DownloadErrorKind::SizeLimit {
                    "更新包超过声明的大小限制"
                } else {
                    "更新下载未完成或已取消，可重新检查后重试"
                },
            )
        })?;
        if result.bytes_written != expected {
            return Err(failure("更新包大小与发布信息不符"));
        }
        let mut hash = Sha256::new();
        let mut file = std::fs::File::open(&archive).map_err(|_| failure("无法读取更新包"))?;
        let mut buffer = [0_u8; 65536];
        loop {
            if !current(&context, operation, &phase) {
                return Err(failure("更新已取消"));
            }
            let n = file
                .read(&mut buffer)
                .map_err(|_| failure("无法校验更新包"))?;
            if n == 0 {
                break;
            }
            hash.update(&buffer[..n]);
        }
        if format!("{:x}", hash.finalize()) != package["sha256"].as_str().unwrap_or_default() {
            return Err(failure("更新包 SHA-256 校验失败"));
        }
        with_app(|app| {
            let session = app.native();
            if session.updates.operation != operation {
                return Err(failure("更新已失效"));
            }
            session.updates.status["state"] = json!("installing");
            session.updates.status["message"] = json!("正在验证并准备原生桌面包");
            session.updates.status["updated_at"] = json!(now());
            session.revision += 1;
            Ok(())
        })?;
        let prepared = crate::update_installer::native::prepare(
            &installation,
            &archive,
            &workspace,
            package["tag"].as_str().unwrap_or_default(),
            || current(&context, operation, &phase),
        )
        .map_err(|e| failure(e.message))?;
        with_app(|app| {
            let generation = app.native_core_snapshot()?.session_generation;
            let session = app.native();
            if context.stop.load(Ordering::Acquire)
                || session
                    .updates
                    .install
                    .as_ref()
                    .is_none_or(|job| job.session_generation != generation)
                || session.updates.operation != operation
                || phase.load(Ordering::Acquire) != WORKING
            {
                return Err(failure("更新已失效"));
            }
            session
                .updates
                .install
                .as_mut()
                .ok_or_else(|| failure("更新已失效"))?
                .prepared = Some(prepared);
            phase.store(PREPARED, Ordering::Release);
            session.updates.status["state"] = json!("prepared");
            session.updates.status["update_installable"] = json!(true);
            session.updates.status["message"] = json!("原生更新包已验证，等待桌面重启");
            session.updates.status["updated_at"] = json!(now());
            session.revision += 1;
            Ok(())
        })?;
        while phase.load(Ordering::Acquire) < COMMITTED {
            if context.stop.load(Ordering::Acquire) && phase.load(Ordering::Acquire) != ACTIVATING {
                phase.store(CANCELLED, Ordering::Release);
                return Err(failure("会话已更换或 Host 已停止，更新未激活"));
            }
            thread::park_timeout(Duration::from_millis(50));
        }
        Ok(())
    })();
    if let Err(error) = result {
        let _ = with_app(|app| {
            let session = app.native();
            if !context.stop.load(Ordering::Acquire) && session.updates.operation == operation {
                session.updates.status["state"] = json!("failed");
                session.updates.status["error"] = json!(error.message);
                session.updates.status["message"] = session.updates.status["error"].clone();
                session.updates.status["cancellable"] = json!(false);
                session.updates.status["updated_at"] = json!(now());
                session.updates.install = None;
                session.revision += 1;
            }
            Ok(())
        });
    }
    // Cleanup and archive I/O are never performed while holding AppState.
    if created && phase.load(Ordering::Acquire) != COMMITTED {
        let _ = std::fs::remove_dir_all(workspace);
    }
    #[cfg(test)]
    if let Some(sender) = COMPLETIONS.lock().unwrap().as_ref() {
        let _ = sender.send(operation);
    }
}

pub(super) fn cancel() -> Result<Value, ApiError> {
    with_app(|app| {
        let session = app.native();
        let update = &mut session.updates;
        if let Some(job) = &update.install {
            if matches!(job.phase.load(Ordering::Acquire), ACTIVATING | COMMITTED) {
                return Err(ApiError::new(
                    409,
                    "update_committed",
                    "更新替换已提交，无法安全取消",
                ));
            }
            job.cancel();
        }
        update.install = None;
        update.operation += 1;
        update.status["state"] = json!("idle");
        update.status["cancellable"] = json!(false);
        update.status["auto_update_supported"] = json!(false);
        update.status["update_installable"] = json!(false);
        update.status["requires_recheck"] = json!(true);
        update.status["message"] = json!("更新已取消，原安装未修改");
        update.status["updated_at"] = json!(now());
        update.package = None;
        session.revision += 1;
        Ok(update.snapshot())
    })
}

/// Only the shell's private bootstrap token can enter this transition. Neither
/// browser paths/commands nor a forged native capability can launch a helper.
#[cfg(test)]
pub(super) static COMPLETIONS: std::sync::Mutex<Option<std::sync::mpsc::Sender<u64>>> =
    std::sync::Mutex::new(None);
#[cfg(test)]
pub(super) static LAUNCH_INTENTS: std::sync::Mutex<Option<Vec<Vec<String>>>> =
    std::sync::Mutex::new(None);

fn launch(command: Vec<String>) -> Result<(), crate::UpdateInstallerError> {
    #[cfg(test)]
    if let Some(intents) = LAUNCH_INTENTS.lock().unwrap().as_mut() {
        intents.push(command);
        return Ok(());
    }
    crate::update_installer::launch_update_helper(&crate::LaunchUpdateHelperRequest { command })
}
pub(super) fn activate(context: &HostContext, operation: u64) -> Result<(), ApiError> {
    let prepared = with_app(|app| {
        if context.stop.load(Ordering::Acquire) {
            return Err(failure("Host 已停止"));
        }
        let generation = app.native_core_snapshot()?.session_generation;
        let session = app.native();
        let update = &mut session.updates;
        if update.operation != operation {
            return Err(ApiError::new(409, "stale_update", "更新已失效"));
        }
        let job = update
            .install
            .as_ref()
            .ok_or_else(|| failure("没有已准备的更新"))?;
        if job.session_generation != generation {
            return Err(failure("本场会话已更换，更新已失效"));
        }
        if job.phase.load(Ordering::Acquire) == COMMITTED {
            return Ok(None);
        }
        if job.phase.load(Ordering::Acquire) != PREPARED {
            return Err(ApiError::new(409, "update_busy", "更新未准备或已提交"));
        }
        let prepared = job.prepared.clone().ok_or_else(|| failure("更新未准备"))?;
        job.phase.store(ACTIVATING, Ordering::Release);
        update.status["state"] = json!("restarting");
        update.status["cancellable"] = json!(false);
        update.status["message"] = json!("更新替换已提交，正在关闭并重新启动应用");
        session.revision += 1;
        Ok(Some((prepared, job.phase.clone())))
    })?;
    let Some((prepared, phase)) = prepared else {
        return Ok(());
    };
    let result = launch(prepared.command);
    phase.store(
        if result.is_ok() { COMMITTED } else { CANCELLED },
        Ordering::Release,
    );
    if result.is_err() {
        let _ = with_app(|app| {
            let session = app.native();
            if session.updates.operation == operation {
                session.updates.status["state"] = json!("failed");
                session.updates.status["error"] = json!("无法启动更新 helper，原安装未修改");
                session.revision += 1;
            }
            Ok(())
        });
        return Err(failure("无法启动更新 helper，原安装未修改"));
    }
    Ok(())
}
