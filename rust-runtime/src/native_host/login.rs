//! Bilibili's existing web QR flow, using native HTTP and the shared runtime
//! login-generation guard. The QR/key/cookie never appears in Remote snapshots.
use super::*;
use crate::{BilibiliLoginStatus, BilibiliLoginUpdate};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
};

const COOKIE_FILE: &str = "bilibili-login.json";
const MAX_LOGIN_BYTES: u64 = 16 * 1024;
const ENV_COOKIE: &str = "BILIKARA_BILIBILI_COOKIE";
const ENV_DISMISSED: &str = "bilibili-env-dismissed.json";
pub(crate) use crate::login_service::LoginDiagnostic;
use crate::login_service::{self, canonical_cookie};

impl From<login_service::LoginError> for ApiError {
    fn from(error: login_service::LoginError) -> Self {
        Self::new(error.status, &error.code, error.message)
    }
}

fn record(diagnostic: LoginDiagnostic) {
    let _ = with_app(|app| {
        app.native_login_diagnostic(diagnostic);
        Ok(())
    });
}

fn run(context: &HostContext, generation: u64) -> Result<(), ApiError> {
    let mut image = String::new();
    let result = login_service::run(
        generation,
        || active(context, generation),
        |qr, message| {
            if image.is_empty() {
                image = qr_image(qr).map_err(|_| {
                    login_service::LoginError::new(502, "login_qr", "无法生成二维码")
                })?;
            }
            update_waiting(context, generation, &image, message)
                .map_err(|e| login_service::LoginError::new(e.status, &e.code, e.message))
        },
        record,
        if context.desktop {
            crate::desktop_login::login_cookie
        } else {
            canonical_cookie
        },
    );
    match result {
        Ok(Some(cookie)) => finish(context, generation, Ok(cookie)),
        Ok(None) => Ok(()),
        Err(error) => Err(error.into()),
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SavedLogin {
    schema_version: u32,
    cookie: String,
}

fn io_error() -> ApiError {
    ApiError::new(503, "login_storage", "B 站登录存储不可用；原文件已保留")
}
fn private_options() -> OpenOptions {
    let options = OpenOptions::new();
    #[cfg(unix)]
    let options = {
        use std::os::unix::fs::OpenOptionsExt;
        let mut options = options;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        options
    };
    options
}
fn regular_or_missing(path: &Path) -> Result<(), ApiError> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_file() => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        _ => Err(io_error()),
    }
}

pub(super) fn load_desktop(directory: &Path) -> Result<String, ApiError> {
    let path = directory.join("BBDown.data");
    regular_or_missing(&path)?;
    if path.metadata().is_ok_and(|m| m.len() > MAX_LOGIN_BYTES) {
        return Err(io_error());
    }
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(_) => return Err(io_error()),
    };
    let cookie = crate::desktop_login::read_cookie(&path);
    if cookie.is_empty() && !bytes.iter().all(u8::is_ascii_whitespace) {
        return Err(io_error());
    }
    Ok(cookie)
}
fn save_for_host(context: &HostContext, cookie: &str) -> Result<(), ApiError> {
    // A user logout or completed QR login supersedes the launch override, also
    // after restart. Store only its digest; a newly configured value can apply.
    dismiss_environment(
        &context.directory,
        &std::env::var(ENV_COOKIE).unwrap_or_default(),
    )?;
    if !context.desktop {
        return save(&context.directory, cookie);
    }
    let path = context.directory.join("BBDown.data");
    regular_or_missing(&path)?;
    if cookie.is_empty() {
        if path.exists() {
            fs::remove_file(path).map_err(|_| io_error())?;
        }
        Ok(())
    } else {
        crate::desktop_login::save_cookie(&path, cookie).map_err(Into::into)
    }
}

fn environment_digest(raw: &str) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(raw.trim().as_bytes()))
}

fn dismiss_environment(directory: &Path, raw: &str) -> Result<(), ApiError> {
    if raw.trim().is_empty() {
        return Ok(());
    }
    let destination = directory.join(ENV_DISMISSED);
    let pending = directory.join("bilibili-env-dismissed.pending");
    regular_or_missing(&destination)?;
    regular_or_missing(&pending)?;
    let mut file = private_options()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&pending)
        .map_err(|_| io_error())?;
    file.write_all(environment_digest(raw).as_bytes())
        .and_then(|()| file.sync_all())
        .map_err(|_| io_error())?;
    drop(file);
    fs::rename(pending, destination).map_err(|_| io_error())
}

fn environment_candidate(directory: &Path, raw: &str) -> Option<String> {
    if fs::read_to_string(directory.join(ENV_DISMISSED))
        .ok()
        .as_deref()
        == Some(&environment_digest(raw))
    {
        return None;
    }
    canonical_cookie(raw)
}

pub(super) fn launch_cookie(directory: &Path, saved: String) -> (String, String) {
    let raw = std::env::var(ENV_COOKIE).unwrap_or_default();
    if raw.trim().is_empty() {
        return (saved, String::new());
    }
    let Some(cookie) = environment_candidate(directory, &raw) else {
        return (saved, String::new());
    };
    let verified = crate::bilibili_service::BilibiliHttpClient::for_video(
        &cookie,
        crate::native_video::USER_AGENT,
        "https://www.bilibili.com/",
        5000,
    )
    .and_then(|client| {
        client.get_api_json(
            "https://api.bilibili.com/x/web-interface/nav",
            "无法验证 Bilibili 登录",
        )
    });
    if verified.is_ok_and(|value| value["data"]["isLogin"] == true) {
        (cookie, String::new())
    } else {
        (
            saved,
            "环境变量 Cookie 未通过登录验证，已保留原登录状态；可在软件中重新登录".into(),
        )
    }
}

pub(super) fn load(directory: &Path) -> Result<String, ApiError> {
    let path = directory.join(COOKIE_FILE);
    regular_or_missing(&path)?;
    let file = match private_options().read(true).open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(_) => return Err(io_error()),
    };
    let mut bytes = Vec::new();
    file.take(MAX_LOGIN_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| io_error())?;
    if bytes.len() as u64 > MAX_LOGIN_BYTES {
        return Err(io_error());
    }
    let login: SavedLogin = serde_json::from_slice(&bytes).map_err(|_| io_error())?;
    if login.schema_version != 1 {
        return Err(io_error());
    }
    if login.cookie.is_empty() {
        Ok(String::new())
    } else {
        canonical_cookie(&login.cookie).ok_or_else(io_error)
    }
}

fn save(directory: &Path, cookie: &str) -> Result<(), ApiError> {
    if !cookie.is_empty() && canonical_cookie(cookie).as_deref() != Some(cookie) {
        return Err(io_error());
    }
    let destination = directory.join(COOKIE_FILE);
    let pending = directory.join("bilibili-login.pending");
    regular_or_missing(&destination)?;
    regular_or_missing(&pending)?;
    let bytes = serde_json::to_vec(&SavedLogin {
        schema_version: 1,
        cookie: cookie.into(),
    })
    .map_err(|_| io_error())?;
    if bytes.len() as u64 > MAX_LOGIN_BYTES {
        return Err(io_error());
    }
    let mut file = private_options()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&pending)
        .map_err(|_| io_error())?;
    file.write_all(&bytes)
        .and_then(|()| file.sync_all())
        .map_err(|_| io_error())?;
    drop(file);
    fs::rename(pending, destination).map_err(|_| io_error())
}

fn reserve_generation(
    session: &mut crate::app_state::native_session::NativeSession,
    force: bool,
) -> Option<u64> {
    if !session.cookie.is_empty() || (!force && session.login_generation.is_some()) {
        return None;
    }
    let generation = session
        .login
        .begin_bilibili_login("正在生成 B 站登录二维码".into());
    session.login_generation = Some(generation);
    session.revision += 1;
    Some(generation)
}

pub(super) fn begin(
    context: Arc<HostContext>,
    identity: &Identity,
    force: bool,
) -> Result<Value, ApiError> {
    let generation = with_app(|app| {
        app.native_authorize(identity, true)?;
        Ok(reserve_generation(app.native(), force))
    })?;
    if let Some(generation) = generation {
        let context = context.clone();
        if context
            .clone()
            .spawn("native-bilibili-login", move || {
                if let Err(error) = run(&context, generation) {
                    let _ = finish(&context, generation, Err(error));
                }
            })
            .is_err()
        {
            with_app(|app| {
                let session = app.native();
                if session.login_generation != Some(generation) {
                    return Ok(());
                }
                session.login_generation = None;
                session.login.set_bilibili_login(
                    Some(generation),
                    BilibiliLoginUpdate {
                        state: BilibiliLoginStatus::Failed,
                        message: "无法启动登录线程".into(),
                        qr_image: String::new(),
                    },
                );
                session.revision += 1;
                Ok(())
            })?;
        }
    }
    with_app(|app| app.native_snapshot(true))
}

/// Compatibility with the Python Host's runtime Cookie override. Like that
/// route this does not overwrite saved QR credentials on disk.
pub(super) fn configure(
    context: &HostContext,
    identity: &Identity,
    body: &Value,
) -> Result<Value, ApiError> {
    with_app(|app| app.native_authorize(identity, true))?;
    let sessdata = body["sessdata"].as_str().unwrap_or_default().trim();
    let jct = body["bili_jct"].as_str().unwrap_or_default().trim();
    if !sessdata.is_empty() || !jct.is_empty() {
        if sessdata.is_empty() || jct.is_empty() || sessdata.contains(';') || jct.contains(';') {
            return Err(ApiError::invalid("请同时提供有效的 SESSDATA 和 bili_jct"));
        }
        let cookie = canonical_cookie(&format!("SESSDATA={sessdata}; bili_jct={jct}"))
            .ok_or_else(|| ApiError::invalid("Cookie 格式无效"))?;
        let value = crate::bilibili_service::BilibiliHttpClient::for_video(
            &cookie,
            crate::native_video::USER_AGENT,
            "https://www.bilibili.com/",
            5000,
        )
        .and_then(|client| {
            client.get_api_json(
                "https://api.bilibili.com/x/web-interface/nav",
                "无法验证 Bilibili 登录",
            )
        })
        .map_err(|error| ApiError::new(400, &error.kind, error.message))?;
        if value["data"]["isLogin"] != true {
            return Err(ApiError::new(
                400,
                "authentication",
                "Cookie 无效或已过期，请重新登录",
            ));
        }
    }
    with_app(|app| {
        app.native_authorize(identity, true)?;
        let sessdata = body["sessdata"].as_str().unwrap_or_default().trim();
        let jct = body["bili_jct"].as_str().unwrap_or_default().trim();
        let session = app.native();
        if !sessdata.is_empty() || !jct.is_empty() {
            if sessdata.is_empty() || jct.is_empty() || sessdata.contains(';') || jct.contains(';')
            {
                return Err(ApiError::invalid("请同时提供有效的 SESSDATA 和 bili_jct"));
            }
            let cookie = canonical_cookie(&format!("SESSDATA={sessdata}; bili_jct={jct}"))
                .ok_or_else(|| ApiError::invalid("请同时提供有效的 SESSDATA 和 bili_jct"))?;
            if session.cookie != cookie {
                library::invalidate_credentials(session);
            }
            session.cookie = cookie;
            session.login_generation = None;
            session.login.reset_bilibili_login();
            session.login.set_bilibili_login(
                None,
                BilibiliLoginUpdate {
                    state: BilibiliLoginStatus::LoggedIn,
                    message: "Bilibili 已登录".into(),
                    qr_image: String::new(),
                },
            );
            session.revision += 1;
        }
        if session.cookie.is_empty() {
            return Err(ApiError::invalid(
                "请先登录 Bilibili 或提供 SESSDATA 和 bili_jct",
            ));
        }
        session.pending_library_refresh = Some("cookie_config");
        Ok(())
    })?;
    // This old entry used ordinary admission and never consumed the first
    // startup/login bypass. A busy refresh does not roll back the override.
    library::refresh_after_login(context);
    Ok(json!({"message":"配置已实时生效"}))
}

pub(super) fn logout(context: &HostContext, identity: &Identity) -> Result<Value, ApiError> {
    with_app(|app| {
        app.native_authorize(identity, true)?;
        save_for_host(context, "")?;
        let session = app.native();
        session.login_generation = None;
        session.login.reset_bilibili_login();
        library::invalidate_credentials(session);
        session.cookie.clear();
        session.revision += 1;
        app.native_snapshot(true)
    })
}

fn active(context: &HostContext, generation: u64) -> bool {
    !context.stop.load(Ordering::Acquire)
        && with_app(|app| Ok(app.native().login_generation == Some(generation))).unwrap_or(false)
}

fn update_waiting(
    context: &HostContext,
    generation: u64,
    image: &str,
    message: &str,
) -> Result<(), ApiError> {
    if !active(context, generation) {
        return Ok(());
    }
    with_app(|app| {
        let session = app.native();
        if session.login_generation == Some(generation) {
            session.login.set_bilibili_login(
                Some(generation),
                BilibiliLoginUpdate {
                    state: BilibiliLoginStatus::Waiting,
                    message: message.into(),
                    qr_image: image.into(),
                },
            );
            session.revision += 1;
        }
        Ok(())
    })
}

fn finish(
    context: &HostContext,
    generation: u64,
    result: Result<String, ApiError>,
) -> Result<(), ApiError> {
    let logged_in = with_app(|app| {
        let session = app.native();
        if context.stop.load(Ordering::Acquire) || session.login_generation != Some(generation) {
            return Ok(false);
        }
        let result = result.and_then(|cookie| {
            save_for_host(context, &cookie)?;
            Ok(cookie)
        });
        let mut diagnostic = LoginDiagnostic::new(generation, "finish");
        let logged_in = result.is_ok();
        if let Err(error) = &result {
            diagnostic.result = login_service::error_result(&login_service::LoginError::new(
                error.status,
                &error.code,
                &error.message,
            ));
        }
        let update = match result {
            Ok(cookie) => {
                if session.cookie != cookie {
                    library::invalidate_credentials(session);
                }
                session.cookie = cookie;
                session.pending_library_refresh = Some("login_success");
                BilibiliLoginUpdate {
                    state: BilibiliLoginStatus::LoggedIn,
                    message: "Bilibili 已登录".into(),
                    qr_image: String::new(),
                }
            }
            Err(error) => BilibiliLoginUpdate {
                state: BilibiliLoginStatus::Failed,
                message: error.message,
                qr_image: String::new(),
            },
        };
        session.login.set_bilibili_login(Some(generation), update);
        session.login_generation = None;
        session.revision += 1;
        app.native_login_diagnostic(diagnostic);
        Ok(logged_in)
    })?;
    if logged_in {
        library::refresh_after_login(context);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn dismissed_environment_cannot_restore_itself_after_logout_or_qr_login() {
        let directory = std::env::temp_dir().join(format!("cookie-override-{}", token().unwrap()));
        fs::create_dir_all(&directory).unwrap();
        let first = "SESSDATA=first; bili_jct=first";
        let second = "SESSDATA=second; bili_jct=second";
        assert!(environment_candidate(&directory, first).is_some());
        dismiss_environment(&directory, first).unwrap();
        assert!(environment_candidate(&directory, first).is_none());
        assert!(environment_candidate(&directory, second).is_some());
        let stored = fs::read_to_string(directory.join(ENV_DISMISSED)).unwrap();
        assert!(!stored.contains("SESSDATA"));
        assert!(!stored.contains("first"));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn successful_login_refreshes_library_once_but_stale_or_failed_login_does_not() {
        let _owned = crate::app_state::native_session::GLOBAL_APP_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let directory =
            std::env::temp_dir().join(format!("bilikara-login-library-{}", token().unwrap()));
        fs::create_dir_all(&directory).unwrap();
        // Explicitly empty configured library; defaults are covered separately.
        fs::write(
            directory.join("gatcha_uids.json"),
            br#"{"schema_version":2,"uids":[],"profiles":{}}"#,
        )
        .unwrap();
        let context = HostContext {
            cache_root: directory.join("media"),
            directory: directory.clone(),
            assets: Arc::new(|_| None),
            stop: Arc::new(AtomicBool::new(false)),
            api_slots: Arc::new(Semaphore::new(1)),
            export_slots: Arc::new(Semaphore::new(1)),
            export_renderer: std::sync::OnceLock::new(),
            port: 0,
            desktop: false,
            bind_address: std::net::Ipv4Addr::UNSPECIFIED,
            allowed_hosts: Default::default(),
            bbdown: None,
            aria2: std::sync::Mutex::new(None),
            aria2_prepare: std::sync::Mutex::new(()),
            shutdown_token: None,
            desktop_installation: None,
            workers: std::sync::Mutex::new(Vec::new()),
        };
        let generation = with_app(|app| {
            let session = app.native();
            let generation = session.login.begin_bilibili_login("test".into());
            session.login_generation = Some(generation);
            Ok(generation)
        })
        .unwrap();
        let replacement = with_app(|app| {
            app.native().cookie.clear();
            assert_eq!(reserve_generation(app.native(), false), None);
            Ok(reserve_generation(app.native(), true).unwrap())
        })
        .unwrap();
        assert_ne!(generation, replacement);
        update_waiting(&context, replacement, "new-qr", "new login").unwrap();
        update_waiting(&context, generation, "old-qr", "old login").unwrap();
        finish(
            &context,
            generation,
            Ok("SESSDATA=stale; bili_jct=stale".into()),
        )
        .unwrap();
        finish(&context, generation, Err(network_failure())).unwrap();
        assert!(!directory.join(COOKIE_FILE).exists());
        with_app(|app| {
            let session = app.native();
            assert_eq!(session.login_generation, Some(replacement));
            assert!(session.cookie.is_empty());
            assert_eq!(
                session
                    .login
                    .bilibili_snapshot(crate::status_service::BilibiliLoginFacts {
                        logged_in: false,
                        data_exists: false,
                        data_path: String::new()
                    })
                    .qr_image,
                "new-qr"
            );
            Ok(())
        })
        .unwrap();
        let generation = replacement;
        // No configured sources: the real refresh pipeline must complete without
        // any Bilibili/D1 request, still publishing its status and repository file.
        finish(
            &context,
            generation,
            Ok("SESSDATA=synthetic; bili_jct=synthetic".into()),
        )
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        let status = loop {
            let status = with_app(|app| Ok(app.native().login.gacha_snapshot())).unwrap();
            if status.last_status == crate::status_service::GachaTaskStatus::Success
                || Instant::now() >= deadline
            {
                break status;
            }
            thread::sleep(Duration::from_millis(10));
        };
        assert_eq!(
            status.last_status,
            crate::status_service::GachaTaskStatus::Success,
            "Persisting the login must trigger the configured-library refresh"
        );
        assert!(!status.busy);
        let checkpoint = fs::read(directory.join("gatcha_cache.json")).unwrap();
        finish(
            &context,
            generation,
            Ok("SESSDATA=stale; bili_jct=stale".into()),
        )
        .unwrap();
        let failed_generation = with_app(|app| {
            let session = app.native();
            let generation = session.login.begin_bilibili_login("test".into());
            session.login_generation = Some(generation);
            Ok(generation)
        })
        .unwrap();
        finish(&context, failed_generation, Err(network_failure())).unwrap();
        assert_eq!(
            fs::read(directory.join("gatcha_cache.json")).unwrap(),
            checkpoint
        );
        assert_eq!(
            with_app(|app| Ok(app.native().login.gacha_snapshot().last_updated_at)).unwrap(),
            status.last_updated_at
        );
        with_app(|app| {
            assert!(
                app.native()
                    .login
                    .try_begin_gacha_refresh("manual".into(), None)
            );
            Ok(())
        })
        .unwrap();
        with_app(|app| {
            app.native().pending_library_refresh = Some("credential_restore");
            Ok(())
        })
        .unwrap();
        library::refresh_after_login(&context);
        assert_eq!(
            with_app(|app| Ok(app.native_diagnostics()["library_refresh"]
                .as_array()
                .unwrap()
                .last()
                .unwrap()["error_code"]
                .clone()))
            .unwrap(),
            "library_busy"
        );
        with_app(|app| {
            let session = app.native();
            session.login.release_gacha_refresh();
            session.library_cooldown_until = Some(Instant::now() + Duration::from_secs(60));
            Ok(())
        })
        .unwrap();
        with_app(|app| {
            app.native().pending_library_refresh = Some("credential_restore");
            Ok(())
        })
        .unwrap();
        library::refresh_after_login(&context);
        let deadline = Instant::now() + Duration::from_secs(3);
        while with_app(|app| Ok(app.native().library_refresh_active)).unwrap()
            && Instant::now() < deadline
        {
            thread::sleep(Duration::from_millis(10));
        }
        with_app(|app| {
            let session = app.native();
            assert!(!session.library_refresh_active);
            assert_eq!(
                session.login.gacha_snapshot().last_status,
                crate::status_service::GachaTaskStatus::Success
            );
            assert!(
                session.library_cooldown_until.is_some(),
                "Automatic refresh preserves manual cooldown"
            );
            Ok(())
        })
        .unwrap();
        with_app(|app| {
            app.native().cookie.clear();
            app.native().library_cooldown_until = None;
            Ok(())
        })
        .unwrap();
        fs::remove_dir_all(directory).unwrap();
    }

    fn network_failure() -> ApiError {
        ApiError::new(502, "login_network", "test transport failure")
    }

    #[test]
    fn private_cookie_checkpoint_roundtrip_and_invalid_file_preservation() {
        let path = std::env::temp_dir().join(format!("bilikara-native-login-{}", token().unwrap()));
        fs::create_dir(&path).unwrap();
        assert_eq!(load(&path).unwrap(), "");
        let cookie = canonical_cookie("SESSDATA=a; bili_jct=b").unwrap();
        save(&path, &cookie).unwrap();
        assert_eq!(load(&path).unwrap(), cookie);
        save(&path, "").unwrap();
        assert_eq!(load(&path).unwrap(), "");
        let bad = b"incomplete";
        fs::write(path.join(COOKIE_FILE), bad).unwrap();
        assert!(load(&path).is_err());
        assert_eq!(fs::read(path.join(COOKIE_FILE)).unwrap(), bad);
        fs::remove_dir_all(path).unwrap();
    }
}
