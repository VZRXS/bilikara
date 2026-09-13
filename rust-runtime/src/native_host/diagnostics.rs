//! Shared diagnostic renderer with bounded, host-only platform facts and probes.
use super::*;
use crate::diagnostics::{DiagnosticRequest, build_diagnostic_artifact};

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

pub(super) fn markdown(
    context: &HostContext,
    identity: &Identity,
    body: &Value,
) -> Result<Value, ApiError> {
    let (snapshot, events, cache_policy) = with_app(|app| {
        app.native_authorize(identity, true)?;
        Ok((
            app.native_core_snapshot()?,
            app.native_diagnostics(),
            app.native().cache_policy.snapshot(),
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
    let request = DiagnosticRequest {
        app_home: context.directory.clone(),
        log_dir: context.directory.join("logs"),
        config_files: Vec::new(),
        system: environment(body, now()),
        tools_and_tasks: json!({"tools":{"rust_native":{"installed":true,"version":env!("CARGO_PKG_VERSION"),"state":"ready","message":"In-process media downloader and normalizer"}}}),
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
        local_usernames: snapshot.session_users,
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
    let result = build_diagnostic_artifact(&request)
        .map_err(|_| ApiError::new(503, "diagnostics", "无法生成原生诊断信息"))?;
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
