//! Android release checks reuse the shared Rust version/channel policy. APK I/O
//! and package/signature verification belong to Android's system adapter. The
//! desktop Host uses the same decisions with a native package installer.
//! Trusted launch facts and a private shell activation boundary own replacement.
mod desktop_install;
use super::*;
use bilikara_rust::{
    ReleaseCandidate, ReleaseSelection, ReleaseSelectionRequest, UpdateAction,
    UpdateAssetCandidate, UpdateAssetSelection, UpdateAssetTarget, decide_release_update,
    select_update_asset,
};
use std::io::Read;

const GITHUB: &str = "https://api.github.com/repos/VZRXS/bilikara/releases?per_page=30";
const MIRROR: &str = "https://api.kevinx96.icu/bilikara/releases/releases.json";
const MAX_APK_BYTES: u64 = 256 * 1024 * 1024;

/// Desktop release metadata sources in the established desktop order: the
/// primary GitHub API first, then the mirror, matching `bilikara/updater.py`.
/// Android's mirror-first order and its `releases.json` document are separate.
/// These are compile-time constants; a request cannot choose an endpoint.
const DESKTOP_STABLE: [&str; 2] = [
    "https://api.github.com/repos/VZRXS/bilikara/releases/latest",
    "https://api.kevinx96.icu/bilikara/releases/latest",
];
const DESKTOP_PREVIEW: [&str; 2] = [
    "https://api.github.com/repos/VZRXS/bilikara/releases",
    "https://api.kevinx96.icu/bilikara/releases",
];
const DESKTOP_TIMEOUT_SECONDS: u64 = 10;
const MAX_RELEASE_BYTES: usize = 1024 * 1024;
const RELEASE_TAG_PREFIX: &str = "https://github.com/VZRXS/bilikara/releases/tag/";

/// Trusted desktop facts resolved once from local version/launcher
/// configuration. An empty `version` is a development build for the shared
/// release policy; it is never replaced with a crate version or a published tag.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct DesktopUpdateFacts {
    pub(crate) version: String,
    pub(crate) platform: String,
    pub(crate) arch: String,
}
impl DesktopUpdateFacts {
    /// Platforms whose released desktop packages can replace an installation in
    /// place. Packaged-launch capability is checked separately.
    fn installable_platform(&self) -> bool {
        matches!(self.platform.as_str(), "windows" | "macos")
    }
    fn display_version(&self) -> String {
        if self.version.is_empty() {
            "dev".to_owned()
        } else {
            self.version.clone()
        }
    }
}

pub(crate) struct UpdateState {
    status: Value,
    package: Option<Value>,
    operation: u64,
    /// Trusted desktop facts; APK and desktop installation remain separate.
    desktop: Option<DesktopUpdateFacts>,
    install: Option<desktop_install::Job>,
}
impl Default for UpdateState {
    fn default() -> Self {
        Self {
            status: json!({"state":"idle","supported":true,"message":"可检查 Android 更新","updated_at":0}),
            package: None,
            operation: 0,
            desktop: None,
            install: None,
        }
    }
}
impl UpdateState {
    pub(crate) fn expire(&mut self, timestamp: f64) -> bool {
        if self.install.is_some() {
            return false;
        }
        let age = timestamp - self.status["updated_at"].as_f64().unwrap_or(0.0);
        let limit = if self.status["state"] == "checking" {
            60.0
        } else {
            600.0
        };
        if self.busy() && age > limit {
            self.operation += 1;
            self.status["state"] = json!(if self.package.is_some() {
                "available"
            } else {
                "failed"
            });
            self.status["updated_at"] = json!(timestamp);
            self.status["message"] = json!("上次更新操作已超时，可重新检查或重试");
            return true;
        }
        false
    }
    /// The desktop Host starts in an idle state carrying its trusted
    /// facts, so the first UI render is already coherent.
    pub(crate) fn desktop(facts: DesktopUpdateFacts) -> Self {
        Self {
            status: desktop_idle(&facts),
            package: None,
            operation: 0,
            desktop: Some(facts),
            install: None,
        }
    }
    pub(crate) fn snapshot(&self) -> Value {
        self.status.clone()
    }
    /// The displayed application version, present only on the desktop Host.
    pub(crate) fn version_label(&self) -> Option<String> {
        self.desktop
            .as_ref()
            .map(DesktopUpdateFacts::display_version)
    }
    fn busy(&self) -> bool {
        matches!(
            self.status["state"].as_str(),
            Some("checking" | "downloading" | "installing" | "prepared" | "restarting")
        )
    }
}

fn fetch(url: &str) -> Result<Value, ApiError> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(crate::native_video::USER_AGENT)
        .build()
        .map_err(|_| failed())?;
    let response = client
        .get(url)
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .map_err(|_| failed())?;
    read_bounded(response, MAX_RELEASE_BYTES).ok_or_else(failed)
}

/// Reads at most `limit` bytes of JSON. An oversized or malformed body is not a
/// result; the caller reports a failure and never an up-to-date success.
fn read_bounded(response: reqwest::blocking::Response, limit: usize) -> Option<Value> {
    let mut bytes = Vec::new();
    response
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() > limit {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}
fn failed() -> ApiError {
    ApiError::new(
        503,
        "update_check_failed",
        "无法读取 Android 发布信息，请检查网络后重试",
    )
}

fn package(release: &Value) -> Option<Value> {
    let tag = release["tag_name"].as_str()?;
    if !tag.starts_with('v')
        || tag.len() > 80
        || !tag
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b".-".contains(&c))
    {
        return None;
    }
    let name = format!("bilikara-{tag}-android-arm64.apk");
    let asset = release["assets"]
        .as_array()?
        .iter()
        .find(|asset| asset["name"] == name)?;
    let sha256 = asset["digest"].as_str()?.strip_prefix("sha256:")?;
    if sha256.len() != 64 || !sha256.bytes().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let bytes = asset["size"]
        .as_u64()
        .filter(|n| (1..=MAX_APK_BYTES).contains(n))?;
    // Reconstruct both known endpoints; don't trust a release's download URL.
    Some(
        json!({"name":name,"sha256":sha256.to_lowercase(),"bytes":bytes,
        "urls":[format!("https://api.kevinx96.icu/bilikara/releases/download/{tag}/{name}"),format!("https://github.com/VZRXS/bilikara/releases/download/{tag}/{name}")]}),
    )
}

fn plan(
    releases: &Value,
    current: &str,
    preview: bool,
    debug: bool,
) -> Result<(Value, Option<Value>), ApiError> {
    let releases: Vec<_> = releases
        .as_array()
        .ok_or_else(failed)?
        .iter()
        .take(30)
        .filter(|r| {
            r["html_url"].as_str().is_some_and(|url| {
                url.starts_with("https://github.com/VZRXS/bilikara/releases/tag/")
            })
        })
        .filter_map(|r| package(r).map(|apk| (r, apk)))
        .collect();
    let decision = decide_release_update(&ReleaseSelectionRequest {
        current_version: current.into(),
        include_preview: preview,
        releases: releases
            .iter()
            .map(|(r, _)| ReleaseCandidate {
                tag_name: r["tag_name"].as_str().unwrap_or_default().into(),
                draft: r["draft"].as_bool().unwrap_or(true),
                prerelease: r["prerelease"].as_bool().unwrap_or(false),
            })
            .collect(),
    })
    .map_err(|_| failed())?;
    let mut status = json!({"state":"up_to_date","supported":true,"auto_update_supported":false,"current_version":current,
        "include_preview":preview,"updated_at":now(),"update_action":decision.action,"eligible_update":false,
        "message":"当前没有可用的 Android APK 更新（桌面包不会作为 Android 更新）"});
    let ReleaseSelection::Selected { selected_index } = decision.selection else {
        return Ok((status, None));
    };
    let (release, apk) = &releases[selected_index];
    status["latest_version"] = release["tag_name"].clone();
    status["release_url"] = release["html_url"].clone();
    let eligible = decision.action != UpdateAction::NoAction;
    if eligible {
        status["state"] = json!("available");
        status["eligible_update"] = json!(true);
        status["update_available"] = json!(true);
        status["auto_update_supported"] = json!(!debug);
        status["message"] = json!(if debug {
            "发现 Android 更新；当前是测试签名包，请使用本地测试 APK 更新。正式签名包启用应用内安装。"
        } else {
            "发现 Android 更新，下载并校验后由系统询问是否安装。"
        });
    }
    Ok((
        status,
        if eligible && !debug {
            Some(apk.clone())
        } else {
            None
        },
    ))
}

// --- Desktop release checks --------------------------------------------------

fn desktop_failed(message: &str) -> ApiError {
    ApiError::new(503, "update_check_failed", message)
}
const DESKTOP_NETWORK_ERROR: &str = "无法读取发布信息，请检查网络后重试";
const DESKTOP_SCHEMA_ERROR: &str = "发布信息格式不正确，请稍后重试";

/// Test builds may retarget the sources at a local fixture. Production builds
/// have no such seam: the constants above are the only desktop sources.
#[cfg(test)]
static SOURCE_OVERRIDE: std::sync::Mutex<Option<Vec<String>>> = std::sync::Mutex::new(None);

fn desktop_sources(preview: bool) -> Vec<String> {
    #[cfg(test)]
    if let Some(urls) = SOURCE_OVERRIDE.lock().expect("source override").clone() {
        return urls;
    }
    if preview {
        DESKTOP_PREVIEW
    } else {
        DESKTOP_STABLE
    }
    .iter()
    .map(|url| (*url).to_owned())
    .collect()
}

fn fetch_desktop(url: &str) -> Result<Value, ApiError> {
    let client = crate::http_client::builder()
        .timeout(Duration::from_secs(DESKTOP_TIMEOUT_SECONDS))
        .redirect(crate::http_client::release_redirects())
        .build()
        .map_err(|_| desktop_failed(DESKTOP_NETWORK_ERROR))?;
    let response = client
        .get(url)
        .header("accept", "application/vnd.github+json")
        .header("user-agent", "bilikara-update-check")
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .map_err(|_| desktop_failed(DESKTOP_NETWORK_ERROR))?;
    read_bounded(response, MAX_RELEASE_BYTES).ok_or_else(|| desktop_failed(DESKTOP_SCHEMA_ERROR))
}

/// Accepts a release only when its tag is a bounded ASCII tag and its page is
/// the published release page. The page URL is then reconstructed from that
/// validated tag, so a payload cannot point the Host at another host or path.
fn release_tag(release: &Value) -> Option<String> {
    let tag = release["tag_name"].as_str()?;
    if !tag.starts_with('v')
        || tag.len() > 80
        || !tag
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b".-".contains(&c))
    {
        return None;
    }
    release["html_url"]
        .as_str()
        .filter(|url| url.starts_with(RELEASE_TAG_PREFIX))?;
    Some(tag.to_owned())
}

/// Bounds untrusted free text before it reaches a status message or the UI.
fn safe_text(value: &str) -> String {
    value
        .chars()
        .filter(|c| !c.is_control())
        .take(120)
        .collect()
}

/// Compatible-asset availability for this platform, kept separate from version
/// eligibility and from installation capability.
fn desktop_asset(release: &Value, facts: &DesktopUpdateFacts) -> Option<String> {
    let candidates: Vec<UpdateAssetCandidate> = release["assets"]
        .as_array()?
        .iter()
        .take(100)
        .map(|asset| UpdateAssetCandidate {
            name: asset["name"].as_str().unwrap_or_default().to_owned(),
            label: asset["label"].as_str().unwrap_or_default().to_owned(),
            browser_download_url: asset["browser_download_url"]
                .as_str()
                .unwrap_or_default()
                .to_owned(),
            content_type: asset["content_type"]
                .as_str()
                .unwrap_or_default()
                .to_owned(),
        })
        .collect();
    match select_update_asset(
        &UpdateAssetTarget {
            platform: facts.platform.clone(),
            arch: facts.arch.clone(),
        },
        &candidates,
    ) {
        UpdateAssetSelection::Selected { selected_index } => {
            Some(safe_text(&candidates[selected_index].name))
        }
        UpdateAssetSelection::NoMatch => None,
    }
}

fn desktop_base(facts: &DesktopUpdateFacts, preview: bool) -> Value {
    json!({
        "supported": true,
        "operation": "check",
        "include_preview": preview,
        "current_version": facts.display_version(),
        "latest_version": "",
        "release_url": "https://github.com/VZRXS/bilikara/releases",
        "update_action": "no_action",
        "update_reason": "",
        "update_installable": false,
        "update_available": false,
        "switch_to_release_available": false,
        "eligible_update": false,
        "asset_name": "",
        "asset_available": false,
        // Release metadata alone never proves an installable native replacement.
        // The packaged-launch and digest-bound candidate admission below decide
        // whether this operation can proceed to native package preparation.
        "auto_update_supported": false,
        "platform_auto_update_supported": facts.installable_platform(),
        "requires_recheck": false,
        "platform": {"platform": facts.platform.as_str(), "arch": facts.arch.as_str()},
        "error": "",
        "updated_at": now(),
    })
}

fn desktop_idle(facts: &DesktopUpdateFacts) -> Value {
    let mut status = desktop_base(facts, false);
    status["state"] = json!("idle");
    status["updated_at"] = json!(0);
    status["message"] = json!("");
    status
}

fn desktop_checking(facts: &DesktopUpdateFacts, preview: bool) -> Value {
    let mut status = desktop_base(facts, preview);
    status["state"] = json!("checking");
    status["message"] = json!("正在检查更新...");
    status
}

fn desktop_failure(facts: &DesktopUpdateFacts, preview: bool, message: &str) -> Value {
    let mut status = desktop_base(facts, preview);
    status["state"] = json!("failed");
    status["update_reason"] = json!("check_failed");
    status["message"] = json!(message);
    status["error"] = json!(message);
    status
}

fn desktop_message(
    decision: &bilikara_rust::ReleaseDecision,
    facts: &DesktopUpdateFacts,
    tag: &str,
    release_url: &str,
    asset: bool,
) -> String {
    use bilikara_rust::UpdateReason;
    let current = facts.display_version();
    let channel = if tag.contains("-preview.") {
        "预览版"
    } else {
        "正式版"
    };
    let head = match decision.action {
        UpdateAction::PreviewToStable => {
            format!("当前使用预览版 {current}，已关闭预览版更新；可切换到最新正式版 {tag}。")
        }
        UpdateAction::DevelopmentToStable | UpdateAction::DevelopmentToPreview => {
            format!("当前是开发版或非正式版（{current}），最新{channel}是 {tag}。")
        }
        UpdateAction::NormalUpgrade => format!("发现新{channel} {tag}，当前版本 {current}。"),
        UpdateAction::NoAction => {
            return match decision.reason {
                UpdateReason::PreviewNotNewer => {
                    format!("当前预览版已是所选更新频道的最新版本（{current}）。")
                }
                UpdateReason::DevelopmentTargetNotStable => {
                    format!("当前是开发版或非正式版（{current}），没有可用的正式版。")
                }
                _ => format!("当前已是最新版本（{current}）。"),
            };
        }
    };
    // Check-only: say what this Host will not do, and where to update by hand.
    let tail = if asset {
        format!("当前启动方式或发布信息不支持原生自动安装；请在浏览器打开 {release_url} 手动更新。")
    } else {
        format!(
            "该版本没有适用于 {}/{} 的桌面更新包；请在浏览器打开 {release_url}。",
            facts.platform, facts.arch
        )
    };
    format!("{head}{tail}")
}

/// Applies the shared release decision to one metadata payload. `/latest`
/// answers with a single release; the list endpoint answers with many.
fn desktop_decide(
    payload: &Value,
    facts: &DesktopUpdateFacts,
    preview: bool,
) -> Result<Value, ApiError> {
    let entries: Vec<&Value> = match payload {
        Value::Array(items) => items.iter().take(30).collect(),
        Value::Object(_) => vec![payload],
        _ => return Err(desktop_failed(DESKTOP_SCHEMA_ERROR)),
    };
    let releases: Vec<(&Value, String)> = entries
        .into_iter()
        .filter_map(|release| release_tag(release).map(|tag| (release, tag)))
        .collect();
    let decision = decide_release_update(&ReleaseSelectionRequest {
        current_version: facts.version.clone(),
        include_preview: preview,
        releases: releases
            .iter()
            .map(|(release, tag)| ReleaseCandidate {
                tag_name: tag.clone(),
                draft: release["draft"].as_bool().unwrap_or(true),
                prerelease: release["prerelease"].as_bool().unwrap_or(false),
            })
            .collect(),
    })
    .map_err(|_| desktop_failed(DESKTOP_SCHEMA_ERROR))?;

    let mut status = desktop_base(facts, preview);
    status["state"] = json!("idle");
    status["update_action"] = json!(decision.action);
    status["update_reason"] = json!(decision.reason);
    let ReleaseSelection::Selected { selected_index } = decision.selection else {
        status["message"] = json!(if preview {
            "没有找到可用的 Release。"
        } else {
            "没有找到可用的正式版。"
        });
        return Ok(status);
    };
    let (release, tag) = &releases[selected_index];
    let release_url = format!("{RELEASE_TAG_PREFIX}{tag}");
    let eligible = decision.action != UpdateAction::NoAction;
    let asset = desktop_asset(release, facts);
    status["latest_version"] = json!(tag);
    status["release_url"] = json!(release_url);
    status["update_installable"] = json!(false);
    status["update_available"] = json!(decision.action == UpdateAction::NormalUpgrade);
    status["switch_to_release_available"] = json!(matches!(
        decision.action,
        UpdateAction::PreviewToStable
            | UpdateAction::DevelopmentToStable
            | UpdateAction::DevelopmentToPreview
    ));
    status["eligible_update"] = json!(eligible);
    if let Some(name) = &asset {
        status["asset_name"] = json!(name);
        status["asset_available"] = json!(true);
    }
    if eligible {
        status["state"] = json!("available");
    }
    status["message"] = json!(desktop_message(
        &decision,
        facts,
        tag,
        &release_url,
        asset.is_some()
    ));
    Ok(status)
}

/// Walks the trusted sources in order and returns the first complete decision.
/// Every source failing is a failure, never an up-to-date success.
fn desktop_plan(
    facts: &DesktopUpdateFacts,
    preview: bool,
) -> Result<(Value, Option<Value>), ApiError> {
    let mut last = desktop_failed(DESKTOP_NETWORK_ERROR);
    for url in desktop_sources(preview) {
        match fetch_desktop(&url).and_then(|payload| {
            let status = desktop_decide(&payload, facts, preview)?;
            let package = desktop_install::package(&payload, &status);
            Ok((status, package))
        }) {
            Ok(status) => return Ok(status),
            Err(error) => last = error,
        }
    }
    Err(last)
}

/// The authoritative desktop status, shared by the status route and the
/// AppState/SSE projection the Host UI actually consumes.
pub(super) fn desktop_status(identity: &Identity) -> Result<Value, ApiError> {
    with_app(|app| {
        app.native_authorize(identity, true)?;
        Ok(app.native().updates.snapshot())
    })
}

fn desktop_route(context: &Arc<HostContext>, path: &str, body: &Value) -> Result<Value, ApiError> {
    if path != "/api/app/update/check" {
        return Err(desktop::unavailable());
    }
    let preview = body["include_preview"]
        .as_bool()
        .ok_or_else(|| ApiError::invalid("更新频道参数无效"))?;
    // Trusted desktop facts are resolved once at startup. A request cannot
    // redefine the current version, platform or architecture.
    let (operation, facts) = with_app(|app| {
        let session = app.native();
        let facts = session
            .updates
            .desktop
            .clone()
            .ok_or_else(desktop::unavailable)?;
        if session.updates.busy() {
            return Err(ApiError::new(409, "update_busy", "更新检查正在进行"));
        }
        session.updates.operation += 1;
        session.updates.package = None;
        session.updates.status = desktop_checking(&facts, preview);
        session.revision += 1;
        Ok((session.updates.operation, facts))
    })?;
    // Release metadata I/O runs outside the AppState lock.
    let result = desktop_plan(&facts, preview);
    with_app(|app| {
        // A late completion must not mutate a stopped or superseded Host.
        if context.stop.load(Ordering::Acquire) {
            return Err(ApiError::new(503, "stopped", "Host 已停止"));
        }
        let session = app.native();
        if session.updates.operation != operation {
            return Err(ApiError::new(409, "stale_update", "更新检查已失效"));
        }
        let (mut status, package) =
            result.unwrap_or_else(|error| (desktop_failure(&facts, preview, &error.message), None));
        if context.desktop_installation.is_some() && package.is_some() {
            status["auto_update_supported"] = json!(true);
            status["message"] = json!(
                "发现桌面更新。下载后将校验原生包结构与完整性；旧 Python 包无法安装。确认更新后应用将重新启动。"
            );
        }
        session.updates.status = status;
        session.updates.package = package;
        session.revision += 1;
        Ok(session.updates.snapshot())
    })
}

pub(super) fn route(
    context: &Arc<HostContext>,
    identity: &Identity,
    path: &str,
    body: &Value,
) -> Result<Value, ApiError> {
    with_app(|app| app.native_authorize(identity, true))?;
    // Android APK installation and native desktop replacement are separate; neither
    // platform reaches the other's operations.
    if context.desktop {
        return desktop_route(context, path, body);
    }
    match path {
        "/api/app/update/check" => {
            let current = body["native_environment"]["version_name"]
                .as_str()
                .filter(|v| !v.is_empty() && v.len() <= 80)
                .unwrap_or("0.8.0-preview.0");
            // Informational client facts only. Kotlin independently checks the
            // installed package, ABI, version and signer before installation.
            let debug = body["native_environment"]["debug_build"]
                .as_bool()
                .unwrap_or(true);
            let preview = body["include_preview"].as_bool().unwrap_or(false);
            let operation = with_app(|app| {
                let session = app.native();
                if session.updates.busy() {
                    return Err(ApiError::new(409, "update_busy", "更新操作正在进行"));
                }
                session.updates.operation += 1;
                session.updates.package = None;
                session.updates.status = json!({"state":"checking","supported":true,"include_preview":preview,"updated_at":now()});
                session.revision += 1;
                Ok(session.updates.operation)
            })?;
            let result = fetch(MIRROR)
                .and_then(|value| plan(&value, current, preview, debug))
                .or_else(|_| fetch(GITHUB).and_then(|value| plan(&value, current, preview, debug)));
            with_app(|app| {
                let session = app.native();
                if session.updates.operation != operation {
                    return Err(ApiError::new(409, "stale_update", "更新检查已失效"));
                }
                let (status,package) = result.unwrap_or_else(|error| (json!({"state":"failed","supported":true,"include_preview":preview,"updated_at":now(),"message":error.message}),None));
                session.updates.status = status;
                session.updates.package = package;
                session.revision += 1;
                Ok(session.updates.snapshot())
            })
        }
        "/api/app/update/install" => with_app(|app| {
            let session = app.native();
            if session.updates.busy() {
                return Err(ApiError::new(409, "update_busy", "更新操作正在进行"));
            }
            if body["include_preview"] != session.updates.status["include_preview"] {
                return Err(ApiError::invalid("更新通道已更改，请重新检查"));
            }
            let package = session
                .updates
                .package
                .clone()
                .ok_or_else(|| ApiError::invalid("请先检查可安装的 Android 正式签名包"))?;
            session.updates.operation += 1;
            session.updates.status["state"] = json!("downloading");
            session.updates.status["updated_at"] = json!(now());
            session.updates.status["message"] = json!("正在下载并校验 APK；完成后由系统确认安装");
            session.revision += 1;
            let mut result = session.updates.snapshot();
            result["android_package"] = package;
            result["operation"] = json!(session.updates.operation);
            Ok(result)
        }),
        "/api/app/update/finish" => with_app(|app| {
            let session = app.native();
            if body["operation"].as_u64() != Some(session.updates.operation)
                || session.updates.status["state"] != "downloading"
            {
                return Err(ApiError::new(409, "stale_update", "更新操作已失效"));
            }
            session.updates.status["state"] = json!("available");
            session.updates.status["updated_at"] = json!(now());
            session.updates.status["message"] = json!(match body["result"].as_str() {
                Some("installer") => "系统安装器已打开；取消后可重新点击更新",
                Some("permission") => "请允许安装此来源的应用，再返回点击更新",
                _ => "APK 下载、校验或安装未完成，可重试；测试包不能覆盖正式签名包",
            });
            session.revision += 1;
            Ok(session.updates.snapshot())
        }),
        _ => Err(ApiError::new(404, "not_found", "未知更新操作")),
    }
}

/// Only the desktop process capability reaches these operations. The ordinary
/// Host cookie can be shared by a presentation WebView, so it is insufficient.
pub(super) fn private_desktop(
    context: &Arc<HostContext>,
    path: &str,
    body: &Value,
) -> Result<Value, ApiError> {
    match path {
        "/api/app/update/install" => desktop_install::start(context, body),
        "/api/app/update/cancel" if body.as_object().is_some_and(|b| b.is_empty()) => {
            desktop_install::cancel()
        }
        "/api/app/update/activate" => {
            let operation = body["operation"]
                .as_u64()
                .ok_or_else(|| ApiError::invalid("Invalid operation"))?;
            desktop_install::activate(context, operation)?;
            Ok(json!({"committed":true}))
        }
        _ => Err(ApiError::invalid("Invalid desktop operation")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::sync::Mutex as StdMutex;

    /// Minimal local HTTP fixture. It never reaches a live release service and
    /// serves exactly the bytes a case scripts, including malformed ones.
    /// Status and body scripted per request path.
    type FixtureScript = Arc<StdMutex<HashMap<String, (u16, Vec<u8>)>>>;

    struct Fixture {
        port: u16,
        script: FixtureScript,
        hits: Arc<StdMutex<Vec<String>>>,
        delay: Arc<StdMutex<Duration>>,
    }
    impl Fixture {
        fn start() -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let script: FixtureScript = Arc::new(StdMutex::new(HashMap::new()));
            let hits: Arc<StdMutex<Vec<String>>> = Arc::new(StdMutex::new(Vec::new()));
            let delay: Arc<StdMutex<Duration>> = Arc::new(StdMutex::new(Duration::ZERO));
            let (worker_script, worker_hits, worker_delay) =
                (script.clone(), hits.clone(), delay.clone());
            thread::spawn(move || {
                for stream in listener.incoming() {
                    let Ok(mut stream) = stream else { break };
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    let mut request = String::new();
                    if reader.read_line(&mut request).is_err() {
                        continue;
                    }
                    loop {
                        let mut header = String::new();
                        match reader.read_line(&mut header) {
                            Ok(0) => break,
                            Ok(_) if header.trim().is_empty() => break,
                            Ok(_) => {}
                            Err(_) => break,
                        }
                    }
                    let path = request.split_whitespace().nth(1).unwrap_or("/").to_owned();
                    worker_hits.lock().unwrap().push(path.clone());
                    // Copy before sleeping so a case can still rewrite the script.
                    let pause = *worker_delay.lock().unwrap();
                    thread::sleep(pause);
                    let (status, body) = worker_script
                        .lock()
                        .unwrap()
                        .get(&path)
                        .cloned()
                        .unwrap_or((404, b"{}".to_vec()));
                    let head = format!(
                        "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = stream.write_all(head.as_bytes());
                    let _ = stream.write_all(&body);
                    let _ = stream.flush();
                }
            });
            Self {
                port,
                script,
                hits,
                delay,
            }
        }
        fn set_delay(&self, delay: Duration) {
            *self.delay.lock().unwrap() = delay;
        }
        fn serve(&self, path: &str, status: u16, body: Vec<u8>) {
            self.script
                .lock()
                .unwrap()
                .insert(path.to_owned(), (status, body));
        }
        fn json(&self, path: &str, status: u16, body: &Value) {
            self.serve(path, status, body.to_string().into_bytes());
        }
        fn url(&self, path: &str) -> String {
            format!("http://127.0.0.1:{}{path}", self.port)
        }
        fn hits(&self) -> Vec<String> {
            self.hits.lock().unwrap().clone()
        }
    }

    fn desktop_release(tag: &str, assets: Value) -> Value {
        json!({
            "tag_name": tag,
            "draft": false,
            "prerelease": tag.contains("preview"),
            "html_url": format!("{RELEASE_TAG_PREFIX}{tag}"),
            "assets": assets,
        })
    }
    fn desktop_assets(tag: &str) -> Value {
        json!([
            {"name": format!("bilikara-{tag}-android-arm64.apk"),
             "label": "", "content_type": "application/vnd.android.package-archive",
             "browser_download_url": format!("https://example.invalid/bilikara-{tag}-android-arm64.apk")},
            {"name": format!("bilikara-{tag}-windows-x64.zip"), "label": "",
             "content_type": "application/zip",
             "browser_download_url": format!("https://example.invalid/bilikara-{tag}-windows-x64.zip")},
            {"name": format!("bilikara-{tag}-macos-universal2.zip"), "label": "",
             "content_type": "application/zip",
             "browser_download_url": format!("https://example.invalid/bilikara-{tag}-macos-universal2.zip")},
        ])
    }

    fn set_sources(urls: &[String]) {
        *SOURCE_OVERRIDE.lock().unwrap() = Some(urls.to_vec());
    }
    fn set_facts(version: &str, platform: &str, arch: &str) {
        with_app(|app| {
            app.native().updates.desktop = Some(DesktopUpdateFacts {
                version: version.into(),
                platform: platform.into(),
                arch: arch.into(),
            });
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn desktop_check_loop_agrees_across_route_authoritative_state_and_guards() {
        let _owned = crate::app_state::native_session::GLOBAL_APP_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // Start from a clean singleton whichever owning test ran first.
        crate::execute_app_state(crate::AppStateRequest::Shutdown { schema_version: 1 });
        let directory = std::env::temp_dir().join(format!(
            "bilikara-desktop-update-{}-{}",
            std::process::id(),
            (now() * 1_000_000.0) as u128
        ));
        let seed: crate::AppStateSeed = serde_json::from_value(
            json!({"session_started_at":1.0,"session_played_file":"native.json","updated_at":1.0}),
        )
        .unwrap();
        assert!(
            crate::initialize_native_host(&directory, seed)
                .error()
                .is_none()
        );
        let host = super::super::start(
            &directory,
            Arc::new(|path| match path {
                "index.html" | "remote.html" => Some(Asset {
                    bytes: b"<!doctype html><html lang=\"en\">shared UI</html>".to_vec(),
                    mime: "text/html".into(),
                }),
                _ => None,
            }),
            true,
            None,
        )
        .unwrap();
        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(20))
            .build()
            .unwrap();
        let base = format!("http://127.0.0.1:{}", host.local_port());
        let bootstrap = client
            .get(host.bootstrap_url())
            .header("sec-fetch-mode", "navigate")
            .header("sec-fetch-dest", "document")
            .send()
            .unwrap();
        assert_eq!(bootstrap.status(), 200);
        let cookie = bootstrap.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned();
        let get = |path: &str| -> (u16, Value) {
            let response = client
                .get(format!("{base}{path}"))
                .header("cookie", &cookie)
                .send()
                .unwrap();
            let status = response.status().as_u16();
            (status, response.json().unwrap_or(Value::Null))
        };
        let post = |path: &str, body: Value| -> (u16, Value) {
            let response = client
                .post(format!("{base}{path}"))
                .header("cookie", &cookie)
                .json(&body)
                .send()
                .unwrap();
            let status = response.status().as_u16();
            (status, response.json().unwrap_or(Value::Null))
        };
        // The status route, the authoritative state and the UI projection must
        // never disagree; every case below compares all three.
        let agreed = |route: &Value| -> Value {
            let (status_code, status) = get("/api/app/update/status");
            assert_eq!(status_code, 200);
            let (state_code, state) = get("/api/state");
            assert_eq!(state_code, 200);
            assert_eq!(status["data"], state["data"]["app_update"]);
            assert_eq!(status["data"], *route);
            status["data"].clone()
        };

        // 1. Idle before any check: no version claim, no installation capability.
        let (code, idle) = get("/api/app/update/status");
        assert_eq!(code, 200);
        assert_eq!(idle["data"]["state"], "idle");
        assert_eq!(idle["data"]["eligible_update"], false);
        assert_eq!(idle["data"]["auto_update_supported"], false);
        assert_eq!(idle["data"]["latest_version"], "");
        assert_eq!(get("/api/state").1["data"]["app_update"], idle["data"]);
        // The capability projection must not contradict the working route.
        assert_eq!(
            get("/api/state").1["data"]["capabilities"]["app_update"],
            true
        );

        let fixture = Fixture::start();
        let (primary, mirror) = (fixture.url("/primary"), fixture.url("/mirror"));
        set_sources(&[primary.clone(), mirror.clone()]);

        // 2. Stable upgrade on Windows, reached through the trusted-source
        // fallback, selecting the desktop package and never the release's APK.
        set_facts("0.7.2", "windows", "x64");
        fixture.serve("/primary", 500, b"{}".to_vec());
        fixture.json(
            "/mirror",
            200,
            &desktop_release("v0.8.1", desktop_assets("v0.8.1")),
        );
        let (code, body) = post("/api/app/update/check", json!({"include_preview": false}));
        assert_eq!(code, 200, "{body}");
        let stable = agreed(&body["data"]);
        assert_eq!(stable["state"], "available");
        assert_eq!(stable["update_action"], "normal_upgrade");
        assert_eq!(stable["update_reason"], "newer_version");
        assert_eq!(stable["eligible_update"], true);
        assert_eq!(stable["update_available"], true);
        assert_eq!(stable["switch_to_release_available"], false);
        assert_eq!(stable["latest_version"], "v0.8.1");
        assert_eq!(stable["current_version"], "0.7.2");
        assert_eq!(
            stable["release_url"],
            "https://github.com/VZRXS/bilikara/releases/tag/v0.8.1"
        );
        assert_eq!(stable["include_preview"], false);
        assert_eq!(stable["requires_recheck"], false);
        assert_eq!(stable["error"], "");
        // Version eligibility, compatible-asset availability and installation
        // capability stay three distinct facts.
        assert_eq!(stable["asset_available"], true);
        assert_eq!(stable["asset_name"], "bilikara-v0.8.1-windows-x64.zip");
        assert_eq!(stable["platform_auto_update_supported"], true);
        assert_eq!(stable["auto_update_supported"], false);
        assert!(
            !stable["asset_name"].as_str().unwrap().ends_with(".apk"),
            "an Android APK is not a desktop package"
        );
        assert_eq!(fixture.hits(), vec!["/primary", "/mirror"]);

        // 3. A request cannot redefine the trusted desktop facts.
        let (code, body) = post(
            "/api/app/update/check",
            json!({"include_preview": false, "current_version": "99.9.9", "platform": "macos",
                "native_environment": {"version_name": "99.9.9", "debug_build": false}}),
        );
        assert_eq!(code, 200);
        assert_eq!(body["data"]["current_version"], "0.7.2");
        assert_eq!(
            body["data"]["platform"],
            json!({"platform":"windows","arch":"x64"})
        );
        assert_eq!(body["data"]["latest_version"], "v0.8.1");

        // 4. Preview channel: a deliberate switch back to a numerically lower
        // stable release, then no action once the preview is the newest.
        set_facts("0.9.0-preview.3", "windows", "x64");
        fixture.json(
            "/mirror",
            200,
            &json!([
                desktop_release("v0.8.1", desktop_assets("v0.8.1")),
                desktop_release("v0.9.0-preview.3", desktop_assets("v0.9.0-preview.3")),
            ]),
        );
        let (code, body) = post("/api/app/update/check", json!({"include_preview": false}));
        assert_eq!(code, 200);
        let switch = agreed(&body["data"]);
        assert_eq!(switch["update_action"], "preview_to_stable");
        assert_eq!(switch["update_reason"], "preview_channel_disabled");
        assert_eq!(switch["state"], "available");
        assert_eq!(switch["eligible_update"], true);
        assert_eq!(switch["switch_to_release_available"], true);
        assert_eq!(switch["update_available"], false);
        assert_eq!(switch["latest_version"], "v0.8.1");
        assert_eq!(switch["asset_available"], true);
        assert_eq!(switch["auto_update_supported"], false);

        let (code, body) = post("/api/app/update/check", json!({"include_preview": true}));
        assert_eq!(code, 200);
        let current = agreed(&body["data"]);
        assert_eq!(current["state"], "idle");
        assert_eq!(current["update_action"], "no_action");
        assert_eq!(current["update_reason"], "already_current");
        assert_eq!(current["eligible_update"], false);
        assert_eq!(current["include_preview"], true);

        // 5. A development build takes the shared development decisions.
        set_facts("", "windows", "x64");
        let (code, body) = post("/api/app/update/check", json!({"include_preview": false}));
        assert_eq!(code, 200);
        let development = agreed(&body["data"]);
        assert_eq!(development["update_action"], "development_to_stable");
        assert_eq!(development["update_reason"], "development_build");
        assert_eq!(development["current_version"], "dev");
        assert_eq!(development["state"], "available");
        assert_eq!(development["switch_to_release_available"], true);
        let (code, body) = post("/api/app/update/check", json!({"include_preview": true}));
        assert_eq!(code, 200);
        assert_eq!(body["data"]["update_action"], "development_to_preview");
        assert_eq!(body["data"]["latest_version"], "v0.9.0-preview.3");

        // 6. An eligible version with no compatible desktop package for this
        // platform is still not an installable update.
        set_facts("0.7.2", "linux", "x64");
        let (code, body) = post("/api/app/update/check", json!({"include_preview": true}));
        assert_eq!(code, 200);
        let linux = agreed(&body["data"]);
        assert_eq!(linux["eligible_update"], true);
        assert_eq!(linux["asset_available"], false);
        assert_eq!(linux["asset_name"], "");
        assert_eq!(linux["platform_auto_update_supported"], false);
        assert_eq!(linux["auto_update_supported"], false);
        assert!(linux["message"].as_str().unwrap().contains("linux/x64"));

        // 7. A release that only ships an APK offers no desktop package either.
        set_facts("0.7.2", "windows", "x64");
        fixture.json(
            "/mirror",
            200,
            &desktop_release(
                "v0.8.2",
                json!([{"name":"bilikara-v0.8.2-android-arm64.apk","label":"",
                    "content_type":"application/vnd.android.package-archive",
                    "browser_download_url":"https://example.invalid/bilikara-v0.8.2-android-arm64.apk"}]),
            ),
        );
        let (code, body) = post("/api/app/update/check", json!({"include_preview": false}));
        assert_eq!(code, 200);
        let apk_only = agreed(&body["data"]);
        assert_eq!(apk_only["eligible_update"], true);
        assert_eq!(apk_only["latest_version"], "v0.8.2");
        assert_eq!(apk_only["asset_available"], false);
        assert_eq!(apk_only["auto_update_supported"], false);

        // 8. A release whose page is not the published release page is ignored.
        let mut forged = desktop_release("v9.9.9", desktop_assets("v9.9.9"));
        forged["html_url"] = json!("https://evil.invalid/VZRXS/bilikara/releases/tag/v9.9.9");
        fixture.json("/mirror", 200, &json!([forged]));
        let (code, body) = post("/api/app/update/check", json!({"include_preview": true}));
        assert_eq!(code, 200);
        let ignored = agreed(&body["data"]);
        assert_eq!(ignored["update_action"], "no_action");
        assert_eq!(ignored["update_reason"], "no_eligible_release");
        assert_eq!(ignored["latest_version"], "");
        assert_eq!(ignored["state"], "idle");

        // 9. Malformed, oversized and failing metadata are failures, never an
        // up-to-date success, and they clear the previous result.
        for (label, status, body) in [
            ("malformed", 200_u16, b"not json at all".to_vec()),
            ("oversized", 200, vec![b' '; MAX_RELEASE_BYTES + 1]),
            ("http_error", 503, b"{}".to_vec()),
        ] {
            fixture.serve("/primary", status, body.clone());
            fixture.serve("/mirror", status, body);
            let (code, response) = post("/api/app/update/check", json!({"include_preview": false}));
            assert_eq!(code, 200, "{label}");
            let failed = agreed(&response["data"]);
            assert_eq!(failed["state"], "failed", "{label}");
            assert_eq!(failed["update_reason"], "check_failed", "{label}");
            assert_eq!(failed["eligible_update"], false, "{label}");
            assert_eq!(failed["latest_version"], "", "{label}");
            assert_eq!(failed["auto_update_supported"], false, "{label}");
            assert!(!failed["error"].as_str().unwrap().is_empty(), "{label}");
            assert_ne!(failed["state"], "up_to_date", "{label}");
        }

        // 10. Unauthorized and malformed inputs are rejected at the route.
        assert_eq!(
            client
                .post(format!("{base}/api/app/update/check"))
                .json(&json!({"include_preview": false}))
                .send()
                .unwrap()
                .status(),
            403,
            "a client without the Host capability cannot check for updates"
        );
        assert_eq!(post("/api/app/update/check", json!({})).0, 400);
        assert_eq!(
            post("/api/app/update/check", json!({"include_preview": "yes"})).0,
            400
        );

        // 11. This fixture has no packaged shell. Install stays unavailable;
        // Android finish callbacks and unrelated privileged routes stay denied.
        assert_eq!(
            post("/api/app/update/install", json!({"include_preview":false})).0,
            403
        );
        for path in ["/api/app/update/finish", "/api/rating/submit"] {
            assert_eq!(
                post(path, json!({"include_preview": false})).0,
                501,
                "{path}"
            );
        }
        assert_eq!(get("/api/app/update").0, 501);
        // Nothing in this path stages a package, an archive or an installer.
        assert!(with_app(|app| Ok(app.native().updates.package.is_none())).unwrap());

        // 12. A repeated check while one is in flight is bounded, and the
        // failure above still permits a retry.
        with_app(|app| {
            app.native().updates.status["state"] = json!("checking");
            Ok(())
        })
        .unwrap();
        let (code, busy) = post("/api/app/update/check", json!({"include_preview": false}));
        assert_eq!(code, 409);
        assert_eq!(busy["code"], "update_busy");
        with_app(|app| {
            app.native().updates.status["state"] = json!("idle");
            Ok(())
        })
        .unwrap();

        // 13. A superseded check cannot overwrite the newer result.
        fixture.json(
            "/mirror",
            200,
            &desktop_release("v0.8.1", desktop_assets("v0.8.1")),
        );
        fixture.serve("/primary", 500, b"{}".to_vec());
        fixture.set_delay(Duration::from_millis(600));
        let superseded = {
            let (base, cookie) = (base.clone(), cookie.clone());
            thread::spawn(move || {
                reqwest::blocking::Client::builder()
                    .no_proxy()
                    .timeout(Duration::from_secs(20))
                    .build()
                    .unwrap()
                    .post(format!("{base}/api/app/update/check"))
                    .header("cookie", cookie)
                    .json(&json!({"include_preview": false}))
                    .send()
                    .unwrap()
            })
        };
        thread::sleep(Duration::from_millis(200));
        with_app(|app| {
            // A newer check for the other channel claims the operation.
            app.native().updates.operation += 1;
            app.native().updates.status =
                desktop_checking(&app.native().updates.desktop.clone().unwrap(), true);
            Ok(())
        })
        .unwrap();
        let response = superseded.join().unwrap();
        assert_eq!(response.status(), 409);
        assert_eq!(response.json::<Value>().unwrap()["code"], "stale_update");
        assert_eq!(
            get("/api/app/update/status").1["data"]["include_preview"],
            true,
            "the stale completion must not replace the newer channel's state"
        );

        // 14. A completion after shutdown cannot mutate the stopped Host.
        with_app(|app| {
            app.native().updates.status["state"] = json!("idle");
            Ok(())
        })
        .unwrap();
        fixture.set_delay(Duration::from_millis(800));
        let late = {
            let (base, cookie) = (base.clone(), cookie.clone());
            thread::spawn(move || {
                reqwest::blocking::Client::builder()
                    .no_proxy()
                    .timeout(Duration::from_secs(20))
                    .build()
                    .unwrap()
                    .post(format!("{base}/api/app/update/check"))
                    .header("cookie", cookie)
                    .json(&json!({"include_preview": false}))
                    .send()
                    .unwrap()
            })
        };
        thread::sleep(Duration::from_millis(250));
        host.context.stop.store(true, Ordering::Release);
        let response = late.join().unwrap();
        assert_eq!(response.status(), 503);
        assert_eq!(response.json::<Value>().unwrap()["code"], "stopped");
        assert!(
            with_app(|app| Ok(app.native().updates.status["state"] == "checking")).unwrap(),
            "a stopped Host keeps the in-flight state instead of committing a late result"
        );

        drop(host);
        crate::execute_app_state(crate::AppStateRequest::Shutdown { schema_version: 1 });
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn desktop_native_install_routes_transfer_validate_cancel_and_preserve_old_files() {
        use sha2::{Digest, Sha256};
        let _owned = crate::app_state::native_session::GLOBAL_APP_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        crate::execute_app_state(crate::AppStateRequest::Shutdown { schema_version: 1 });
        let directory =
            std::env::temp_dir().join(format!("native-install-route-{}", token().unwrap()));
        let installed = directory.join("installed");
        std::fs::create_dir_all(&installed).unwrap();
        std::fs::write(installed.join("old-record"), b"preserved").unwrap();
        *desktop::INSTALLATION_OVERRIDE.lock().unwrap() =
            Some(crate::update_installer::native::Installation {
                root: installed.clone(),
                platform: "windows".into(),
                arch: "x64".into(),
                wait_pids: vec![111, 222],
            });
        let seed: crate::AppStateSeed = serde_json::from_value(
            json!({"session_started_at":1.0,"session_played_file":"native.json","updated_at":1.0}),
        )
        .unwrap();
        assert!(
            crate::initialize_native_host(&directory, seed)
                .error()
                .is_none()
        );
        let host = super::super::start(
            &directory,
            Arc::new(|_| None),
            true,
            Some("private-shell-fixture".into()),
        )
        .unwrap();
        set_facts("0.8.0-preview.2", "windows", "x64");
        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(15))
            .build()
            .unwrap();
        let bootstrap = client
            .get(host.bootstrap_url())
            .header("sec-fetch-mode", "navigate")
            .header("sec-fetch-dest", "document")
            .send()
            .unwrap();
        let cookie = bootstrap.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned();
        let base = format!("http://127.0.0.1:{}", host.local_port());
        let post = |path: &str, body: Value| -> (u16, Value) {
            let mut request = client
                .post(format!("{base}{path}"))
                .header("cookie", &cookie);
            if matches!(path, "/api/app/update/install" | "/api/app/update/cancel") {
                request = request.header("x-bilikara-shutdown-token", "private-shell-fixture");
            }
            let response = request.json(&body).send().unwrap();
            (
                response.status().as_u16(),
                response.json().unwrap_or(Value::Null),
            )
        };
        let state = || -> Value {
            client
                .get(format!("{base}/api/app/update/status"))
                .header("cookie", &cookie)
                .send()
                .unwrap()
                .json::<Value>()
                .unwrap()["data"]
                .clone()
        };
        let wait = |wanted: &str| -> Value {
            // Read real SSE state notifications, no retry-until-green sleeps.
            let response = client
                .get(format!("{base}/api/events"))
                .header("cookie", &cookie)
                .send()
                .unwrap();
            for line in BufReader::new(response).lines() {
                let line = line.unwrap();
                if let Some(data) = line.strip_prefix("data: ") {
                    let value: Value = serde_json::from_str(data).unwrap();
                    if value["app_update"]["state"] == wanted {
                        return value["app_update"].clone();
                    }
                }
            }
            panic!("SSE stopped before {wanted}")
        };
        let fixture = Fixture::start();
        set_sources(&[fixture.url("/metadata")]);
        *desktop_install::DOWNLOAD_OVERRIDE.lock().unwrap() =
            Some(vec![fixture.url("/primary"), fixture.url("/mirror")]);
        let bytes = crate::update_installer::native::tests::windows_package("0.8.1", "x64");
        let release_for = |bytes: &[u8]| {
            desktop_release(
                "v0.8.1",
                json!([{"name":"bilikara-v0.8.1-windows-x64.zip","size":bytes.len(),"digest":format!("sha256:{:x}",Sha256::digest(bytes)),"browser_download_url":"https://unrelated.invalid/never-used.zip"}]),
            )
        };
        fixture.json("/metadata", 200, &release_for(&bytes));
        fixture.serve("/primary", 503, vec![]);
        fixture.serve("/mirror", 200, bytes.clone());
        let check = post("/api/app/update/check", json!({"include_preview":false}));
        assert_eq!(check.0, 200);
        assert_eq!(check.1["data"]["auto_update_supported"], true);
        assert_eq!(check.1["data"]["update_installable"], false);
        assert_eq!(
            post("/api/app/update/install", json!({"include_preview":true})).0,
            400
        );
        assert_eq!(
            post(
                "/api/app/update/install",
                json!({"include_preview":false,"install_root":"/other"})
            )
            .0,
            400
        );
        assert_eq!(
            client
                .post(format!("{base}/api/app/update/install"))
                .json(&json!({"include_preview":false}))
                .send()
                .unwrap()
                .status(),
            403
        );
        assert_eq!(
            post("/api/app/update/install", json!({"include_preview":false})).0,
            200
        );
        let ready = wait("prepared");
        assert_eq!(ready["update_installable"], true);
        assert_eq!(ready["downloaded_bytes"], bytes.len());
        assert!(
            fixture
                .hits()
                .ends_with(&["/primary".into(), "/mirror".into()])
        );
        assert_eq!(
            post("/api/app/update/install", json!({"include_preview":false})).0,
            409
        );
        assert_eq!(
            post("/api/app/update/check", json!({"include_preview":true})).0,
            409
        );
        // An ordinary Host cookie cannot activate a helper, even with forged facts.
        assert_eq!(
            post(
                "/api/app/update/activate",
                json!({"operation":ready["operation"]})
            )
            .0,
            403
        );
        assert!(!with_app(|app| Ok(app.native().updates.expire(now() + 10000.0))).unwrap());
        assert_eq!(post("/api/app/update/cancel", json!({})).0, 200);
        assert_eq!(state()["requires_recheck"], true);
        let stale = client
            .post(format!("{base}/api/app/update/activate"))
            .header("x-bilikara-shutdown-token", "private-shell-fixture")
            .json(&json!({"operation":ready["operation"]}))
            .send()
            .unwrap();
        assert_eq!(stale.status(), 409);
        for (label, bad) in [
            ("invalid", b"not a zip".to_vec()),
            (
                "wrong_arch",
                crate::update_installer::native::tests::windows_package("0.8.1", "arm64"),
            ),
        ] {
            fixture.json("/metadata", 200, &release_for(&bad));
            fixture.serve("/mirror", 200, bad);
            assert_eq!(
                post("/api/app/update/check", json!({"include_preview":false})).0,
                200
            );
            assert_eq!(
                post("/api/app/update/install", json!({"include_preview":false})).0,
                200
            );
            let failed = wait("failed");
            assert!(!failed["error"].as_str().unwrap().is_empty(), "{label}");
            assert_eq!(
                std::fs::read(installed.join("old-record")).unwrap(),
                b"preserved"
            );
        }
        // Declared oversized content is rejected before allocation/publication.
        fixture.json("/metadata", 200, &release_for(b"small"));
        fixture.serve("/mirror", 200, bytes);
        post("/api/app/update/check", json!({"include_preview":false}));
        post("/api/app/update/install", json!({"include_preview":false}));
        assert!(wait("failed")["error"].as_str().unwrap().contains("大小"));
        // A controlled in-flight body barrier proves cancellation, late
        // completion and owner stop without scheduling sleeps.
        let (completed_tx, completed_rx) = std::sync::mpsc::channel();
        *desktop_install::COMPLETIONS.lock().unwrap() = Some(completed_tx);
        let barrier = |body: Vec<u8>| {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}/transfer", listener.local_addr().unwrap());
            let (arrived_tx, arrived_rx) = std::sync::mpsc::channel();
            let (release_tx, release_rx) = std::sync::mpsc::channel();
            let worker = thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line.trim().is_empty() {
                        break;
                    }
                }
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .unwrap();
                stream.write_all(&body[..20]).unwrap();
                stream.flush().unwrap();
                arrived_tx.send(()).unwrap();
                release_rx.recv_timeout(Duration::from_secs(15)).unwrap();
                let _ = stream.write_all(&body[20..]);
            });
            (url, arrived_rx, release_tx, worker)
        };
        let good = crate::update_installer::native::tests::windows_package("0.8.1", "x64");
        fixture.json("/metadata", 200, &release_for(&good));
        let (url, arrived, release, transfer) = barrier(good.clone());
        *desktop_install::DOWNLOAD_OVERRIDE.lock().unwrap() = Some(vec![url]);
        post("/api/app/update/check", json!({"include_preview":false}));
        let operation = post("/api/app/update/install", json!({"include_preview":false})).1["data"]
            ["operation"]
            .as_u64()
            .unwrap();
        arrived.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(post("/api/app/update/cancel", json!({})).0, 200);
        let newer =
            post("/api/app/update/check", json!({"include_preview":true})).1["data"].clone();
        release.send(()).unwrap();
        transfer.join().unwrap();
        while completed_rx.recv_timeout(Duration::from_secs(10)).unwrap() != operation {}
        assert_eq!(
            state(),
            newer,
            "old transfer cannot overwrite a newer check"
        );
        // Helper generation and the private launch intent are tested separately
        // from real Windows replacement; this Linux fixture launches no helper.
        fixture.serve("/mirror", 200, good.clone());
        *desktop_install::DOWNLOAD_OVERRIDE.lock().unwrap() = Some(vec![fixture.url("/mirror")]);
        post("/api/app/update/check", json!({"include_preview":false}));
        post("/api/app/update/install", json!({"include_preview":false}));
        let ready = wait("prepared");
        *desktop_install::LAUNCH_INTENTS.lock().unwrap() = Some(Vec::new());
        for _ in 0..2 {
            let result = client
                .post(format!("{base}/api/app/update/activate"))
                .header("x-bilikara-shutdown-token", "private-shell-fixture")
                .json(&json!({"operation":ready["operation"]}))
                .send()
                .unwrap();
            assert_eq!(result.status(), 200);
        }
        let intents = desktop_install::LAUNCH_INTENTS
            .lock()
            .unwrap()
            .take()
            .unwrap();
        assert_eq!(intents.len(), 1);
        assert!(
            std::fs::read_to_string(&intents[0][2])
                .unwrap()
                .contains("bilikara-desktop.exe")
        );
        assert_eq!(state()["state"], "restarting");
        assert_eq!(state()["cancellable"], false);
        assert_eq!(post("/api/app/update/cancel", json!({})).0, 409);
        while completed_rx.recv_timeout(Duration::from_secs(10)).unwrap()
            != ready["operation"].as_u64().unwrap()
        {}
        // The simulated helper now owns this directory; remove it explicitly.
        std::fs::remove_dir_all(Path::new(&intents[0][2]).parent().unwrap()).unwrap();
        with_app(|app| {
            app.native().updates = UpdateState::desktop(DesktopUpdateFacts {
                version: "0.8.0-preview.2".into(),
                platform: "windows".into(),
                arch: "x64".into(),
            });
            Ok(())
        })
        .unwrap();
        let (url, arrived, release, transfer) = barrier(good);
        *desktop_install::DOWNLOAD_OVERRIDE.lock().unwrap() = Some(vec![url]);
        post("/api/app/update/check", json!({"include_preview":false}));
        post("/api/app/update/install", json!({"include_preview":false}));
        arrived.recv_timeout(Duration::from_secs(10)).unwrap();
        host.context.stop.store(true, Ordering::Release);
        release.send(()).unwrap();
        transfer.join().unwrap();
        drop(host); // Joins the owning worker, including staging cleanup.
        assert!(std::fs::read_dir(&directory).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("update-")
        }));
        assert_eq!(
            std::fs::read(installed.join("old-record")).unwrap(),
            b"preserved"
        );
        *desktop_install::COMPLETIONS.lock().unwrap() = None;
        *SOURCE_OVERRIDE.lock().unwrap() = None;
        *desktop_install::DOWNLOAD_OVERRIDE.lock().unwrap() = None;
        *desktop::INSTALLATION_OVERRIDE.lock().unwrap() = None;
        crate::execute_app_state(crate::AppStateRequest::Shutdown { schema_version: 1 });
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn abandoned_update_leases_expire_without_accepting_a_late_completion() {
        let mut update = UpdateState {
            status: json!({"state":"checking","updated_at":100.0}),
            ..UpdateState::default()
        };
        assert!(!update.expire(159.0));
        assert!(update.expire(161.0));
        assert_eq!(update.operation, 1);
        assert_eq!(update.snapshot()["state"], "failed");
        update.status = json!({"state":"downloading","updated_at":200.0});
        update.package = Some(json!({}));
        assert!(!update.expire(799.0));
        assert!(update.expire(801.0));
        assert_eq!(update.operation, 2);
        assert_eq!(update.snapshot()["state"], "available");
        assert!(!update.expire(9000.0));
    }
    fn release(tag: &str) -> Value {
        json!({"tag_name":tag,"draft":false,"prerelease":tag.contains("preview"),"html_url":format!("https://github.com/VZRXS/bilikara/releases/tag/{tag}"),"assets":[{"name":format!("bilikara-{tag}-android-arm64.apk"),"digest":format!("sha256:{}","a".repeat(64)),"size":1234,"browser_download_url":"https://evil.test/x.apk"}]})
    }
    #[test]
    fn android_update_requires_apk_hash_and_uses_shared_channel_decision() {
        let releases = json!([release("v0.8.1"), release("v0.9.0-preview.1")]);
        let (stable, apk) = plan(&releases, "0.8.0", false, false).unwrap();
        assert_eq!(stable["latest_version"], "v0.8.1");
        assert_eq!(stable["auto_update_supported"], true);
        assert!(!apk.unwrap().to_string().contains("evil"));
        let (preview, _) = plan(&releases, "0.8.0", true, false).unwrap();
        assert_eq!(preview["latest_version"], "v0.9.0-preview.1");
        let (debug, apk) = plan(&releases, "0.8.0", true, true).unwrap();
        assert_eq!(debug["auto_update_supported"], false);
        assert!(apk.is_none());
        let mut bad = release("v0.8.2");
        bad["assets"][0]["digest"] = Value::Null;
        assert!(package(&bad).is_none());
        bad["assets"][0]["digest"] = json!(format!("sha256:{}", "a".repeat(64)));
        bad["assets"][0]["size"] = json!(MAX_APK_BYTES + 1);
        assert!(package(&bad).is_none());
        assert_eq!(
            plan(&json!([]), "0.8.0", false, false).unwrap().0["eligible_update"],
            false
        );
    }
}
