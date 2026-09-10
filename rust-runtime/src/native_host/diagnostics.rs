//! Shared Rust diagnostic renderer, with native-only inputs and no network probe.
use super::*;
use crate::diagnostics::{DiagnosticRequest, build_diagnostic_artifact};

pub(super) fn markdown(context: &HostContext, identity: &Identity) -> Result<Value, ApiError> {
    let (snapshot, events) = with_app(|app| {
        app.native_authorize(identity, true)?;
        Ok((app.native_core_snapshot()?, app.native_diagnostics()))
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
        system: json!({"platform":std::env::consts::OS,"arch":std::env::consts::ARCH,"version":"0.8.0-android-alpha"}),
        tools_and_tasks: json!({"backend":"rust-native"}),
        cache_policy: json!({"max_cache_items":3,"video_quality":"720P","audio_hires":false}),
        runtime_state: json!({"revision":snapshot.revision,"playback_generation":snapshot.playback_generation,"items":items,"diagnostics":events}),
        export_diagnostics: Vec::new(),
        internet_remote_diagnostics: Vec::new(),
        local_usernames: snapshot.session_users,
        connectivity_override: Some(
            json!({"skipped":"Native Alpha diagnostics do not contact external services"}),
        ),
        connectivity_targets: Default::default(),
        connectivity_timeout_ms: 1000,
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
        json!({"markdown":format!("# Android Host Alpha · rust-native\n\n{}\n\n## Native runtime (sanitized)\n\n```json\n{}\n```\n",result.markdown,runtime)}),
    )
}
