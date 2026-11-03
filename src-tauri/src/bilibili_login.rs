//! Desktop-only official login window. It has no application IPC capability,
//! an ephemeral cookie store, and never passes credentials through frontend JS.
use crate::backend_process::BackendProcess;
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant};
use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const LOGIN_URL: &str = "https://account.bilibili.com/login";
const WINDOW_LABEL: &str = "bilibili-login";
const COOKIE_NAMES: &[&str] = &[
    "SESSDATA",
    "bili_jct",
    "DedeUserID",
    "DedeUserID__ckMd5",
    "sid",
    "buvid3",
    "buvid4",
    "b_nut",
];

#[derive(Default)]
pub(crate) struct LoginWindows(Arc<AtomicBool>);
struct ActiveWindow(Arc<AtomicBool>);
impl Drop for ActiveWindow {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

fn allowed_navigation(url: &tauri::Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port_or_known_default() == Some(443)
        && matches!(
            url.host_str(),
            Some("account.bilibili.com" | "passport.bilibili.com" | "www.bilibili.com")
        )
}

fn login_cookie(cookies: Vec<tauri::webview::Cookie<'static>>) -> Option<String> {
    let mut pairs = Vec::new();
    for name in COOKIE_NAMES {
        let mut values = cookies.iter().filter(|cookie| {
            cookie.name() == *name
                && cookie
                    .domain()
                    .is_some_and(|domain| domain.trim_start_matches('.') == "bilibili.com")
                && cookie.path().unwrap_or("/") == "/"
                && cookie.expires_datetime().is_none_or(|expiry| {
                    expiry > tauri::webview::cookie::time::OffsetDateTime::now_utc()
                })
        });
        let Some(cookie) = values.next() else {
            continue;
        };
        if values.next().is_some()
            || cookie.value().is_empty()
            || cookie
                .value()
                .chars()
                .any(|ch| ch.is_control() || ch == ';')
        {
            return None;
        }
        pairs.push(format!("{name}={}", cookie.value()));
    }
    if !pairs.iter().any(|s| s.starts_with("SESSDATA="))
        || !pairs.iter().any(|s| s.starts_with("bili_jct="))
    {
        return None;
    }
    let cookie = pairs.join("; ");
    (cookie.len() <= 16 * 1024).then_some(cookie)
}

fn login_window_builder<'a>(
    app: &'a tauri::AppHandle,
    url: tauri::Url,
    allow: impl Fn(&tauri::Url) -> bool + Send + 'static,
) -> WebviewWindowBuilder<'a, tauri::Wry, tauri::AppHandle> {
    // Incognito creates a non-persistent WebView context on all desktop targets.
    // This window's label is deliberately absent from every capability file.
    let builder = WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::External(url))
        .title("Bilibili 登录 · bilikara")
        .inner_size(1000.0, 720.0)
        .min_inner_size(700.0, 600.0)
        .incognito(true)
        .disable_drag_drop_handler()
        .on_navigation(allow)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .on_download(|_, _| false);
    // Keep the foreign WebView2 environment separate from the portable Host's
    // cookie store; use the same established native browser arguments.
    #[cfg(windows)]
    let builder = builder
        .data_directory(
            crate::desktop_storage::webview_directory(app.config())
                .expect("desktop storage configured before creating login windows")
                .with_file_name("bilibili-login-webview"),
        )
        .additional_browser_args(crate::desktop_storage::WINDOWS_WEBVIEW_BROWSER_ARGS);
    builder
}

fn run_login(app: tauri::AppHandle, backend: BackendProcess) -> Result<Value, String> {
    let generation = backend.web_login("begin", json!({}))?["generation"]
        .as_u64()
        .ok_or("无法开始网页登录")?;
    let mut opened = None;
    let result = (|| {
        let window = login_window_builder(&app, LOGIN_URL.parse().unwrap(), allowed_navigation)
            .build()
            .map_err(|_| "无法打开 Bilibili 登录窗口，请使用二维码登录")?;
        opened = Some(window.clone());
        let closed = Arc::new(AtomicBool::new(false));
        let closed_event = closed.clone();
        let backend_event = backend.clone();
        window.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                closed_event.store(true, Ordering::Release);
                let backend = backend_event.clone();
                // Invalidate even while a verification request is in flight.
                tauri::async_runtime::spawn_blocking(move || {
                    let _ = backend.web_login("cancel", json!({"generation":generation}));
                });
            }
        });
        let deadline = Instant::now() + Duration::from_secs(300);
        while !closed.load(Ordering::Acquire) {
            if Instant::now() >= deadline {
                return Err("登录窗口已超时，请重试或扫码登录".into());
            }
            // cookies() releases the dispatcher lock before waiting for the UI
            // thread. The pinned runtime's cookies_for_url() holds that lock
            // across recv and can deadlock against a concurrent UI eval.
            let cookies = window.cookies().map_err(|_| "无法读取登录窗口的登录状态")?;
            if let Some(cookie) = login_cookie(cookies) {
                if closed.load(Ordering::Acquire) {
                    break;
                }
                return backend
                    .web_login("complete", json!({"generation":generation,"cookie":cookie}));
            }
            std::thread::sleep(Duration::from_millis(750));
        }
        Ok(json!({"logged_in":false}))
    })();
    if let Some(window) = opened {
        let _ = window.destroy();
    }
    let _ = backend.web_login("cancel", json!({"generation":generation}));
    result
}

#[tauri::command]
pub(crate) async fn open_bilibili_login(
    window: WebviewWindow,
    backend: tauri::State<'_, BackendProcess>,
    windows: tauri::State<'_, LoginWindows>,
) -> Result<Value, String> {
    crate::presentation::authorize_window(&window, &backend, &["main"])?;
    if windows.0.swap(true, Ordering::AcqRel) {
        if let Some(existing) = window.app_handle().get_webview_window(WINDOW_LABEL) {
            let _ = existing.set_focus();
        }
        return Err("Bilibili 登录窗口已打开".into());
    }
    let active = ActiveWindow(windows.0.clone());
    let app = window.app_handle().clone();
    let backend = backend.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _active = active;
        run_login(app, backend)
    })
    .await
    .map_err(|_| "网页登录未完成，请重试".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn login_navigation_cannot_launch_apps_downloads_or_untrusted_origins() {
        for url in [
            LOGIN_URL,
            "https://passport.bilibili.com/login",
            "https://www.bilibili.com/",
        ] {
            assert!(allowed_navigation(&url.parse().unwrap()));
        }
        for url in [
            "http://account.bilibili.com/login",
            "https://account.bilibili.com:444/login",
            "https://account.bilibili.com.evil.test/",
            "https://evil.test/",
            "bilibili://login",
            "file:///etc/passwd",
            "http://127.0.0.1:8080/",
            "https://user@account.bilibili.com/",
            "https://dl.hdslb.com/mobile/latest/android64/iBiliPlayer-bilih5.apk",
        ] {
            assert!(!allowed_navigation(&url.parse().unwrap()), "{url}");
        }
    }
    #[test]
    fn only_complete_bilibili_root_credentials_leave_the_native_window() {
        let parse = |s: &str| {
            tauri::webview::Cookie::parse(s.to_owned())
                .unwrap()
                .into_owned()
        };
        let session =
            parse("SESSDATA=synthetic-session; Domain=.bilibili.com; Path=/; Secure; HttpOnly");
        let csrf = parse("bili_jct=synthetic-csrf; Domain=.bilibili.com; Path=/; Secure");
        assert_eq!(
            login_cookie(vec![
                session.clone(),
                csrf.clone(),
                parse("unrelated=secret; Domain=.bilibili.com"),
                parse("SESSDATA=wrong; Domain=evil.test")
            ])
            .unwrap(),
            "SESSDATA=synthetic-session; bili_jct=synthetic-csrf"
        );
        assert!(login_cookie(vec![session.clone()]).is_none());
        assert!(login_cookie(vec![session.clone(), csrf.clone(), session]).is_none());
        assert!(login_cookie(vec![csrf, parse("SESSDATA=expired; Domain=.bilibili.com; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT")]).is_none());
    }
}

// This fixture URL/proxy seam is compiled only into the test executable. The
// shipped command accepts no URL, proxy, cookie or storage path from JavaScript.
#[cfg(all(test, target_os = "linux"))]
#[test]
#[ignore = "requires an isolated X11 display and the local web-login fixture"]
fn native_ephemeral_login_window_reads_http_only_cookies_and_reopens_cleanly() {
    use std::sync::Mutex;
    let proxy: tauri::Url = std::env::var("BILIKARA_TEST_WEB_LOGIN_PROXY")
        .unwrap()
        .parse()
        .unwrap();
    let outcome: Arc<Mutex<Option<Result<(), String>>>> = Arc::default();
    let captured = outcome.clone();
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    let app = tauri::Builder::default()
        .any_thread()
        .invoke_handler(tauri::generate_handler![open_bilibili_login])
        .setup(move |app| {
            // The real product retains its main window when login closes.
            let _anchor = WebviewWindowBuilder::new(
                app,
                "web-login-anchor",
                WebviewUrl::External("about:blank".parse().unwrap()),
            )
            .visible(false)
            .build()?;
            let app = app.handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                let checks = (|| -> Result<(), String> {
                    let anchor = app.get_webview_window("web-login-anchor").unwrap();
                    anchor
                        .set_cookie(
                            tauri::webview::Cookie::parse(
                                "existing=synthetic-host; Domain=.bilibili.com; Path=/".to_owned(),
                            )
                            .unwrap(),
                        )
                        .map_err(|e| e.to_string())?;
                    assert!(
                        anchor
                            .cookies()
                            .map_err(|e| e.to_string())?
                            .iter()
                            .any(|cookie| cookie.name() == "existing")
                    );
                    let login = login_window_builder(
                        &app,
                        "http://account.bilibili.com/login".parse().unwrap(),
                        |url| {
                            url.scheme() == "http" && url.host_str() == Some("account.bilibili.com")
                        },
                    )
                    .proxy_url(proxy.clone())
                    .build()
                    .map_err(|e| e.to_string())?;
                    let deadline = Instant::now() + Duration::from_secs(30);
                    let cookie = loop {
                        let cookies = login.cookies().map_err(|e| e.to_string())?;
                        assert!(
                            !cookies.iter().any(|cookie| cookie.name() == "existing"),
                            "foreign login must not inherit Host cookies"
                        );
                        if let Some(cookie) = login_cookie(cookies) {
                            break cookie;
                        }
                        if Instant::now() > deadline {
                            return Err("no complete HttpOnly fixture credentials".into());
                        }
                        std::thread::sleep(Duration::from_millis(100));
                    };
                    assert_eq!(
                        cookie,
                        "SESSDATA=synthetic-webview; bili_jct=synthetic-csrf"
                    );
                    assert!(
                        !anchor
                            .cookies()
                            .map_err(|e| e.to_string())?
                            .iter()
                            .any(|cookie| cookie.name() == "SESSDATA"),
                        "login cookies must not enter the ordinary Host store"
                    );
                    // Record JS visibility after the HttpOnly response too.
                    std::thread::sleep(Duration::from_millis(500));
                    login.destroy().map_err(|e| e.to_string())?;
                    while app.get_webview_window(WINDOW_LABEL).is_some() {
                        if Instant::now() > deadline {
                            return Err("login window did not retire".into());
                        }
                        std::thread::sleep(Duration::from_millis(25));
                    }
                    let reopened = login_window_builder(
                        &app,
                        "http://account.bilibili.com/empty".parse().unwrap(),
                        |_| true,
                    )
                    .proxy_url(proxy)
                    .build()
                    .map_err(|e| e.to_string())?;
                    assert!(
                        reopened.cookies().map_err(|e| e.to_string())?.is_empty(),
                        "ephemeral cookies must not survive reopening"
                    );
                    reopened.destroy().map_err(|e| e.to_string())?;
                    Ok(())
                })();
                *captured.lock().unwrap() = Some(checks);
                app.exit(0);
            });
            Ok(())
        })
        .build(context)
        .unwrap();
    app.run_return(|_, _| {});
    outcome
        .lock()
        .unwrap()
        .take()
        .expect("native window check finished")
        .unwrap();
}
