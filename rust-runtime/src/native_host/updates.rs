//! Android release checks reuse the shared Rust version/channel policy. APK I/O
//! and package/signature verification belong to Android's system adapter.
use super::*;
use bilikara_rust::{
    ReleaseCandidate, ReleaseSelection, ReleaseSelectionRequest, UpdateAction,
    decide_release_update,
};
use std::io::Read;

const GITHUB: &str = "https://api.github.com/repos/VZRXS/bilikara/releases?per_page=30";
const MIRROR: &str = "https://api.kevinx96.icu/bilikara/releases/releases.json";
const MAX_APK_BYTES: u64 = 256 * 1024 * 1024;

pub(crate) struct UpdateState {
    status: Value,
    package: Option<Value>,
    operation: u64,
}
impl Default for UpdateState {
    fn default() -> Self {
        Self {
            status: json!({"state":"idle","supported":true,"message":"可检查 Android 更新","updated_at":0}),
            package: None,
            operation: 0,
        }
    }
}
impl UpdateState {
    pub(crate) fn expire(&mut self, timestamp: f64) -> bool {
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
    pub(crate) fn snapshot(&self) -> Value {
        self.status.clone()
    }
    fn busy(&self) -> bool {
        matches!(
            self.status["state"].as_str(),
            Some("checking" | "downloading" | "installing")
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
    let mut bytes = Vec::new();
    response
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| failed())?;
    if bytes.len() > 1024 * 1024 {
        return Err(failed());
    }
    serde_json::from_slice(&bytes).map_err(|_| failed())
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

pub(super) fn route(identity: &Identity, path: &str, body: &Value) -> Result<Value, ApiError> {
    with_app(|app| app.native_authorize(identity, true))?;
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

#[cfg(test)]
mod tests {
    use super::*;
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
