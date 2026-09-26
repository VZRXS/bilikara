//! Shared diagnostic renderer with bounded, host-only platform facts and probes.
use super::*;
use crate::diagnostics::{DiagnosticRequest, DiagnosticResult, build_diagnostic_artifact};

fn safe_text(value: &Value) -> String {
    value
        .as_str()
        .unwrap_or_default()
        .chars()
        .filter(|c| !c.is_control())
        .take(240)
        .collect()
}

fn environment(body: &Value, timestamp: f64) -> Value {
    let date = time::OffsetDateTime::from_unix_timestamp(timestamp as i64)
        .unwrap_or(time::OffsetDateTime::UNIX_EPOCH);
    let platform = &body["native_environment"];
    let mut system = json!({
        "generated_at":format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",date.year(),u8::from(date.month()),date.day(),date.hour(),date.minute(),date.second()),
        "app_version":"0.8.0 · bilikara beta", "system":format!("{} {}",std::env::consts::OS,std::env::consts::ARCH),
        "python_implementation":"not applicable (Rust Native)","python_version":"", "frozen_bundle":cfg!(target_os="android"),
        "browser":{"user_agent":safe_text(&body["browser"]["user_agent"]),"platform":safe_text(&body["browser"]["platform"])},
    });
    // Client platform facts are informational only, never authorization input.
    if cfg!(target_os = "android") && platform["sdk"].as_u64().is_some_and(|sdk| sdk > 0) {
        system["system"] = json!(format!(
            "Android {} (API {}) · {} {} · {}",
            safe_text(&platform["release"]),
            platform["sdk"].as_u64().unwrap_or(0),
            safe_text(&platform["manufacturer"]),
            safe_text(&platform["model"]),
            std::env::consts::ARCH
        ));
        system["app_version"] = json!(format!(
            "{} ({}) · bilikara beta",
            safe_text(&platform["version_name"]),
            platform["version_code"].as_u64().unwrap_or(0)
        ));
        system["browser"]["user_agent"] = json!(format!(
            "{} · {} {}",
            safe_text(&body["browser"]["user_agent"]),
            safe_text(&platform["webview_package"]),
            safe_text(&platform["webview_version"])
        ));
    }
    system
}

fn home_username(path: &Path, names: &mut Vec<String>) {
    if let Some(name) = path.file_name().and_then(|name| name.to_str()) {
        names.push(name.to_owned());
    }
}

fn local_account_names() -> Vec<String> {
    let mut names = Vec::new();
    for key in ["USERNAME", "USER", "LOGNAME"] {
        if let Ok(name) = std::env::var(key) {
            names.push(name);
        }
    }
    if let Some(home) = std::env::home_dir() {
        home_username(&home, &mut names);
    }
    system_account_names(&mut names);
    names
}

#[cfg(unix)]
fn system_account_names(names: &mut Vec<String>) {
    use std::ffi::CStr;
    // Reentrant account lookup also works when login environment variables
    // are absent or HOME points at an isolated application directory.
    let mut buffer = vec![0u8; 16384];
    loop {
        let mut entry = std::mem::MaybeUninit::<libc::passwd>::uninit();
        let mut result = std::ptr::null_mut();
        // SAFETY: all output pointers refer to writable storage for this call.
        let status = unsafe {
            libc::getpwuid_r(
                libc::getuid(),
                entry.as_mut_ptr(),
                buffer.as_mut_ptr().cast(),
                buffer.len(),
                &mut result,
            )
        };
        if status == libc::ERANGE && buffer.len() < 1024 * 1024 {
            buffer.resize(buffer.len() * 2, 0);
            continue;
        }
        if status == 0 && !result.is_null() {
            // SAFETY: successful getpwuid_r initialized entry and its strings
            // point into buffer, which stays alive while they are copied.
            let entry = unsafe { entry.assume_init() };
            if !entry.pw_name.is_null() {
                names.push(
                    unsafe { CStr::from_ptr(entry.pw_name) }
                        .to_string_lossy()
                        .into_owned(),
                );
            }
            if !entry.pw_dir.is_null() {
                let home = unsafe { CStr::from_ptr(entry.pw_dir) }.to_string_lossy();
                home_username(Path::new(home.as_ref()), names);
            }
        }
        break;
    }
}

#[cfg(windows)]
fn system_account_names(names: &mut Vec<String>) {
    let mut buffer = vec![0u16; 257];
    let mut size = buffer.len() as u32;
    // SAFETY: buffer contains size writable UTF-16 elements.
    if unsafe {
        windows_sys::Win32::System::WindowsProgramming::GetUserNameW(buffer.as_mut_ptr(), &mut size)
    } != 0
    {
        names.push(String::from_utf16_lossy(
            &buffer[..size.saturating_sub(1) as usize],
        ));
    }
}

#[cfg(not(any(unix, windows)))]
fn system_account_names(_names: &mut Vec<String>) {}

fn artifact(
    context: &HostContext,
    identity: &Identity,
    body: &Value,
) -> Result<DiagnosticResult, ApiError> {
    let aria2_available = context.desktop && context.aria2().is_some();
    let (snapshot, events, cache_policy) = with_app(|app| {
        app.native_authorize(identity, true)?;
        Ok((
            app.native_core_snapshot()?,
            app.native_diagnostics(),
            app.native()
                .cache_policy
                .snapshot_with(context.desktop && context.bbdown.is_some(), aria2_available),
        ))
    })?;
    // Never include the login checkpoint, access URLs, tokens, or raw HTTP headers.
    let items = snapshot
        .current_item
        .iter()
        .chain(snapshot.playlist.iter())
        .map(|item| {
            json!({"item_id":item.id,"bvid":item.bvid,"cache_status":item.cache_status,
            "cache_message":item.cache_message,"cache_progress":item.cache_progress,
            "artifact_set_id":item.artifact_set_id})
        })
        .collect::<Vec<_>>();
    let mut system = environment(body, now());
    if context.desktop {
        let version = desktop::update_facts().version;
        system["app_version"] = json!(if version.is_empty() {
            "dev".to_owned()
        } else {
            version
        });
    }
    let mut local_usernames = snapshot.session_users;
    local_usernames.extend(local_account_names());
    let request = DiagnosticRequest {
        app_home: context.directory.clone(),
        log_dir: context.directory.join("logs"),
        additional_logs: if context.desktop {
            std::env::var_os("BILIKARA_DESKTOP_STARTUP_LOG")
                .filter(|p| !p.is_empty())
                .map(PathBuf::from)
                .into_iter()
                .collect()
        } else {
            Vec::new()
        },
        config_files: [
            "native-preferences.json",
            "gatcha_uids.json",
            "native-library-defaults.json",
        ]
        .iter()
        .map(|name| context.directory.join(name))
        .collect(),
        system,
        tools_and_tasks: json!({"tools":{"rust_native":{"installed":true,"version":env!("CARGO_PKG_VERSION"),"state":"ready","message":"In-process media downloader and normalizer"},"bbdown":{"installed":context.bbdown.is_some(),"enabled":cache_policy["download_source"] == "bbdown"},"aria2c":{"installed":aria2_available,"enabled":cache_policy["download_source"] == "downkyi"},"yt-dlp":{"installed":false,"enabled":false,"state":"disabled"}}}),
        cache_policy,
        runtime_state: json!({"revision":snapshot.revision,"playback_generation":snapshot.playback_generation,"items":items,"diagnostics":events}),
        export_diagnostics: body["export_diagnostics"]
            .as_array()
            .map(|v| v.iter().take(64).cloned().collect())
            .unwrap_or_default(),
        internet_remote_diagnostics: body["internet_remote_diagnostics"]
            .as_array()
            .map(|v| v.iter().take(64).cloned().collect())
            .unwrap_or_default(),
        local_usernames,
        connectivity_override: None,
        connectivity_targets: [
            (
                "bilibili".into(),
                "https://api.bilibili.com/x/web-interface/nav".into(),
            ),
            (
                "github".into(),
                "https://api.github.com/repos/VZRXS/bilikara/releases/latest".into(),
            ),
            (
                "r2_mirror".into(),
                "https://api.kevinx96.icu/bilikara/releases/latest.json".into(),
            ),
        ]
        .into(),
        connectivity_timeout_ms: 5000,
    };
    let started = std::time::Instant::now();
    eprintln!("[diagnostics] stage=package status=start");
    let result = build_diagnostic_artifact(&request);
    eprintln!(
        "[diagnostics] stage=package status={} elapsed_ms={}",
        if result.is_ok() { "complete" } else { "failed" },
        started.elapsed().as_millis()
    );
    result.map_err(|_| ApiError::new(503, "diagnostics", "无法生成原生诊断信息"))
}

pub(super) fn package(
    context: &HostContext,
    identity: &Identity,
    body: &Value,
) -> Result<Response, ApiError> {
    let result = artifact(context, identity, body)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(result.zip_base64)
        .map_err(|_| ApiError::new(503, "diagnostics", "无法生成原生诊断包"))?;
    let length = bytes.len();
    let mut response = Body::from(bytes).into_response();
    let headers = response.headers_mut();
    headers.insert("content-type", "application/zip".parse().unwrap());
    headers.insert("content-length", length.to_string().parse().unwrap());
    headers.insert("cache-control", "no-store".parse().unwrap());
    headers.insert(
        "content-disposition",
        format!(
            "attachment; filename=\"bilikara-diagnostics-{}.zip\"",
            chrono::Local::now().format("%Y%m%d-%H%M%S")
        )
        .parse()
        .unwrap(),
    );
    Ok(response)
}

pub(super) fn markdown(
    context: &HostContext,
    identity: &Identity,
    body: &Value,
) -> Result<Value, ApiError> {
    let result = artifact(context, identity, body)?;
    let runtime = result
        .files
        .get("runtime-state.json")
        .and_then(|value| base64::engine::general_purpose::STANDARD.decode(value).ok())
        .and_then(|value| String::from_utf8(value).ok())
        .ok_or_else(|| ApiError::new(503, "diagnostics", "缺少已脱敏的原生状态"))?;
    Ok(
        json!({"markdown":format!("# bilikara beta · rust-native\n\n{}\n\n## Native runtime (sanitized)\n\n```json\n{}\n```\n",result.markdown,runtime)}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn diagnostic_environment_supplies_renderer_keys_and_bounds_untrusted_browser_facts() {
        let value = environment(
            &json!({"browser":{"user_agent":"Android WebView\nTest","platform":"Android","secret":"do not copy"}}),
            1_789_200_000.0,
        );
        assert_eq!(value["generated_at"], "2026-09-12T08:00:00Z");
        assert!(!value["app_version"].as_str().unwrap().is_empty());
        assert!(!value["system"].as_str().unwrap().is_empty());
        assert_eq!(value["browser"]["user_agent"], "Android WebViewTest");
        assert!(value["browser"].get("secret").is_none());
    }
}
