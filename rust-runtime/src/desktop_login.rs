//! Desktop adaptation of the shared QR engine to the existing Runtime status
//! owner and BBDown.data. No native HTTP Host or native library-refresh caller.
use crate::ffi::status_service;
use crate::login_service::{self, LoginError};
use crate::{BilibiliLoginFacts, BilibiliLoginStatus, BilibiliLoginUpdate};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
};

const COOKIE_ORDER: &[&str] = &[
    "SESSDATA",
    "bili_jct",
    "DedeUserID",
    "DedeUserID__ckMd5",
    "sid",
    "buvid3",
    "buvid4",
    "b_nut",
];
const LEGACY_ORDER: &[&str] = &[
    "SESSDATA",
    "bili_jct",
    "DedeUserID",
    "DedeUserID__ckMd5",
    "sid",
    "buvid3",
    "buvid4",
    "b_nut",
    "bili_ticket",
    "bili_ticket_expires",
    "CURRENT_FNVAL",
    "CURRENT_QUALITY",
];

#[derive(Deserialize)]
#[serde(tag = "command", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum LoginCommand {
    Start {
        data_path: PathBuf,
        force: bool,
    },
    Run {
        data_path: PathBuf,
        generation: u64,
    },
    Snapshot {
        data_path: PathBuf,
    },
    Cancel {
        data_path: PathBuf,
    },
    Logout {
        data_path: PathBuf,
    },
    TakeSuccess {
        generation: u64,
    },
    DownloadAccess {
        source: String,
        cookie: String,
    },
    ReadCookie {
        data_path: PathBuf,
        #[serde(default)]
        configured_cookie: String,
    },
}

fn storage_error() -> LoginError {
    LoginError::new(503, "login_storage", "Bilibili 登录凭证保存或读取失败")
}

fn cookie_name(name: &str) -> String {
    match name.to_ascii_lowercase().as_str() {
        "sessdata" => "SESSDATA".into(),
        "bili_jct" => "bili_jct".into(),
        _ => name.trim().into(),
    }
}

fn format_pairs(pairs: &BTreeMap<String, String>, order: &[&str], extras: bool) -> Option<String> {
    if !pairs.contains_key("SESSDATA") || !pairs.contains_key("bili_jct") {
        return None;
    }
    let mut names = Vec::new();
    for preferred in order {
        if let Some(name) = pairs
            .keys()
            .find(|name| name.eq_ignore_ascii_case(preferred))
        {
            names.push(name);
        }
    }
    if extras {
        for name in pairs.keys() {
            if !names.contains(&name) {
                names.push(name);
            }
        }
    }
    Some(
        names
            .iter()
            .map(|name| format!("{name}={}", pairs[*name]))
            .collect::<Vec<_>>()
            .join("; "),
    )
}

/// Desktop retains b_nut and case-insensitive names; the shared jar still
/// restricts acceptance to cookies applicable to https://api.bilibili.com/.
pub(crate) fn login_cookie(value: &str) -> Option<String> {
    if value.len() > 16 * 1024 || value.contains(['\r', '\n', '\0']) {
        return None;
    }
    let mut pairs = BTreeMap::new();
    for pair in value.split(';') {
        if let Some((name, value)) = pair.trim().split_once('=')
            && !value.is_empty()
            && value.is_ascii()
        {
            pairs.insert(cookie_name(name), value.to_owned());
        }
    }
    format_pairs(&pairs, COOKIE_ORDER, false)
}

// BBDown legacy JSON/text compatibility. This is the old desktop file policy,
// shared by login status and existing downloader consumers through the FFI.
fn collect_pairs(value: &Value, pairs: &mut BTreeMap<String, String>) {
    match value {
        Value::Object(object) => {
            let field = |name: &str| {
                object
                    .iter()
                    .find(|(key, _)| key.eq_ignore_ascii_case(name))
                    .map(|(_, v)| v)
            };
            if let (Some(Value::String(name)), Some(value)) = (field("name"), field("value")) {
                insert_pair(pairs, name, value);
            }
            for (key, value) in object {
                if LEGACY_ORDER
                    .iter()
                    .any(|name| key.eq_ignore_ascii_case(name))
                {
                    insert_pair(pairs, key, value);
                }
                collect_pairs(value, pairs);
            }
        }
        Value::Array(values) => {
            for value in values {
                collect_pairs(value, pairs);
            }
        }
        Value::String(value) => {
            static PAIR: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
            for captures in PAIR
                .get_or_init(|| {
                    regex::Regex::new(r"([A-Za-z0-9_]+)=([^;\s]+)").expect("cookie regex")
                })
                .captures_iter(value)
            {
                pairs.insert(cookie_name(&captures[1]), captures[2].to_owned());
            }
        }
        _ => {}
    }
}
fn insert_pair(pairs: &mut BTreeMap<String, String>, name: &str, value: &Value) {
    let text = match value {
        Value::String(s) => s.trim().to_owned(),
        Value::Number(n) if n.as_f64() != Some(0.0) => n.to_string(),
        _ => return,
    };
    if !name.trim().is_empty() && !text.is_empty() {
        pairs.insert(cookie_name(name), text);
    }
}
pub(crate) fn read_cookie(path: &Path) -> String {
    let Ok(bytes) = fs::read(path) else {
        return String::new();
    };
    let text = String::from_utf8_lossy(&bytes);
    let text = text.trim_start_matches('\u{feff}');
    let value = serde_json::from_str(text).unwrap_or_else(|_| Value::String(text.into()));
    let mut pairs = BTreeMap::new();
    collect_pairs(&value, &mut pairs);
    format_pairs(&pairs, LEGACY_ORDER, true).unwrap_or_default()
}
fn qr_path(data_path: &Path) -> PathBuf {
    data_path.with_file_name("qrcode.png")
}
fn remove_qr(data_path: &Path) {
    let _ = fs::remove_file(qr_path(data_path));
}

/// Called only under the existing status/generation lock. Network and waits
/// never hold that lock. Publication cannot interleave with reset/logout.
pub(crate) fn save_cookie(path: &Path, cookie: &str) -> Result<(), LoginError> {
    if login_cookie(cookie).as_deref() != Some(cookie) {
        return Err(storage_error());
    }
    let pending = path.with_file_name(".BBDown.data.login.tmp");
    let result = (|| {
        fs::create_dir_all(path.parent().ok_or_else(storage_error)?)
            .map_err(|_| storage_error())?;
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&pending).map_err(|_| storage_error())?;
        file.write_all(cookie.as_bytes())
            .and_then(|()| file.sync_all())
            .map_err(|_| storage_error())?;
        drop(file);
        if read_cookie(&pending) != cookie {
            return Err(storage_error());
        }
        fs::rename(&pending, path).map_err(|_| storage_error())
    })();
    let _ = fs::remove_file(pending);
    result
}

/// Shared external-download admission rule; Native remains available to guests.
pub(crate) fn download_login_error(source: &str, cookie: &str) -> Option<&'static str> {
    if login_cookie(cookie).is_some() {
        return None;
    }
    match source {
        "bbdown" => Some("BBDown 下载需要登录 Bilibili，请登录后重新下载"),
        "downkyi" => Some("DownKyi/aria2c 下载需要登录 Bilibili，请登录后重新下载"),
        _ => None,
    }
}

pub(crate) fn execute(command: LoginCommand) -> Result<Value, LoginError> {
    match command {
        LoginCommand::DownloadAccess { source, cookie } => {
            Ok(json!({"message": download_login_error(&source, &cookie)}))
        }
        LoginCommand::ReadCookie {
            data_path,
            configured_cookie,
        } => {
            let cookie = read_cookie(&data_path);
            Ok(
                json!({"cookie": if cookie.is_empty() { configured_cookie.trim().to_owned() } else { cookie }}),
            )
        }
        LoginCommand::Snapshot { data_path } => {
            let service = status_service();
            Ok(json!(service.bilibili_snapshot(BilibiliLoginFacts {
                logged_in: !read_cookie(&data_path).is_empty(),
                data_exists: data_path.exists(),
                data_path: data_path.to_string_lossy().into(),
            })))
        }
        LoginCommand::Start { data_path, force } => {
            let mut service = status_service();
            if !read_cookie(&data_path).is_empty()
                || (!force && service.active_bilibili_generation().is_some())
            {
                return Ok(json!({"generation": null}));
            }
            remove_qr(&data_path);
            let generation = service.begin_bilibili_login("正在启动 BBDown 登录".into());
            Ok(json!({"generation": generation}))
        }
        LoginCommand::Cancel { data_path } => cancel(&data_path, false),
        LoginCommand::Logout { data_path } => cancel(&data_path, true),
        LoginCommand::TakeSuccess { generation } => {
            Ok(json!({"notify": status_service().take_bilibili_success(generation)}))
        }
        LoginCommand::Run {
            data_path,
            generation,
        } => run(&data_path, generation),
    }
}

fn cancel(data_path: &Path, logout: bool) -> Result<Value, LoginError> {
    let mut service = status_service();
    service.reset_bilibili_login();
    remove_qr(data_path);
    if logout
        && let Err(error) = fs::remove_file(data_path)
        && error.kind() != std::io::ErrorKind::NotFound
    {
        service.set_bilibili_login(
            None,
            BilibiliLoginUpdate {
                state: BilibiliLoginStatus::Failed,
                message: "退出登录失败：凭证文件无法删除".into(),
                qr_image: String::new(),
            },
        );
    }
    Ok(json!({"reset": true}))
}

fn run(data_path: &Path, generation: u64) -> Result<Value, LoginError> {
    if !status_service().claim_bilibili_worker(generation) {
        return Ok(json!({"diagnostics": []}));
    }
    let mut diagnostics = Vec::new();
    let mut image = String::new();
    let result = login_service::run(
        generation,
        || status_service().active_bilibili_generation() == Some(generation),
        |qr, message| {
            let png = if image.is_empty() {
                let png = crate::generate_qr_png(qr, 10, 4)
                    .map_err(|_| LoginError::new(502, "login_qr", "无法生成二维码"))?;
                image = format!("data:image/png;base64,{}", STANDARD.encode(&png));
                Some(png)
            } else {
                None
            };
            let mut service = status_service();
            if service.active_bilibili_generation() == Some(generation) {
                if let Some(png) = png {
                    // The PNG is also kept at the existing desktop private path.
                    fs::create_dir_all(data_path.parent().ok_or_else(storage_error)?)
                        .map_err(|_| storage_error())?;
                    let path = qr_path(data_path);
                    let mut options = fs::OpenOptions::new();
                    options.write(true).create_new(true);
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::OpenOptionsExt;
                        options.mode(0o600);
                    }
                    options
                        .open(path)
                        .and_then(|mut f| f.write_all(&png))
                        .map_err(|_| storage_error())?;
                }
                service.set_bilibili_login(
                    Some(generation),
                    BilibiliLoginUpdate {
                        state: BilibiliLoginStatus::Waiting,
                        message: message.into(),
                        qr_image: image.clone(),
                    },
                );
            }
            Ok(())
        },
        |diagnostic| diagnostics.push(diagnostic),
        login_cookie,
    );
    let mut service = status_service();
    if service.active_bilibili_generation() == Some(generation) {
        let result = result.and_then(|cookie| {
            if let Some(cookie) = cookie {
                save_cookie(data_path, &cookie)?;
                Ok(true)
            } else {
                Ok(false)
            }
        });
        let mut diagnostic = login_service::LoginDiagnostic::new(generation, "finish");
        let update = match result {
            Ok(true) => BilibiliLoginUpdate {
                state: BilibiliLoginStatus::LoggedIn,
                message: "BBDown 已登录".into(),
                qr_image: String::new(),
            },
            Ok(false) => BilibiliLoginUpdate {
                state: BilibiliLoginStatus::Idle,
                message: "未登录".into(),
                qr_image: String::new(),
            },
            Err(error) => {
                diagnostic.result = login_service::error_result(&error);
                BilibiliLoginUpdate {
                    state: BilibiliLoginStatus::Failed,
                    message: error.message,
                    qr_image: String::new(),
                }
            }
        };
        diagnostics.push(diagnostic);
        remove_qr(data_path);
        service.complete_bilibili_login(generation, update);
    }
    Ok(json!({"diagnostics": diagnostics}))
}

#[cfg(test)]
mod download_tests {
    use super::*;
    #[test]
    fn external_downloads_require_login_but_native_does_not() {
        for cookie in [
            "",
            "buvid3=visitor; bili_ticket=visitor",
            "SESSDATA=partial",
        ] {
            for source in ["bbdown", "downkyi"] {
                assert!(download_login_error(source, cookie).is_some());
            }
            assert!(download_login_error("native", cookie).is_none());
        }
        for source in ["bbdown", "downkyi", "native", "yt-dlp"] {
            assert!(download_login_error(source, "SESSDATA=synthetic; bili_jct=csrf").is_none());
        }
    }
}
