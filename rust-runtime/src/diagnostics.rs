use crate::json_http::{HttpHeader, JsonHttpRequest, execute_json_request};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};
use std::thread;
use zip::ZipWriter;
use zip::write::SimpleFileOptions;

const REDACTED: &str = "[REDACTED]";
const MAX_LOG_FILES: usize = 8;
const MAX_LOG_BYTES: u64 = 64 * 1024;
const MAX_MARKDOWN_LOG_LINES: usize = 80;

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiagnosticRequest {
    pub app_home: PathBuf,
    pub log_dir: PathBuf,
    #[serde(default)]
    pub config_files: Vec<PathBuf>,
    pub system: Value,
    pub tools_and_tasks: Value,
    pub cache_policy: Value,
    pub runtime_state: Value,
    #[serde(default)]
    pub export_diagnostics: Vec<Value>,
    #[serde(default)]
    pub local_usernames: Vec<String>,
    #[serde(default)]
    pub connectivity_override: Option<Value>,
    #[serde(default)]
    pub connectivity_targets: BTreeMap<String, String>,
    #[serde(default = "default_timeout_ms")]
    pub connectivity_timeout_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct DiagnosticResult {
    pub markdown: String,
    pub files: BTreeMap<String, String>,
    pub zip_base64: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct DiagnosticError {
    pub kind: &'static str,
    pub message: String,
}

fn default_timeout_ms() -> u64 {
    5_000
}

pub fn build_diagnostic_artifact(
    request: &DiagnosticRequest,
) -> Result<DiagnosticResult, DiagnosticError> {
    let names = normalized_usernames(&request.local_usernames);
    let system = redact_value(request.system.clone(), "", &names);
    let tools_and_tasks = redact_value(request.tools_and_tasks.clone(), "", &names);
    let policy = redact_value(request.cache_policy.clone(), "", &names);
    let runtime = redact_value(request.runtime_state.clone(), "", &names);
    let exports = sanitize_exports(&request.export_diagnostics, &names);
    let disk = disk_snapshot(&request.app_home, &names);
    let connectivity = request.connectivity_override.clone().unwrap_or_else(|| {
        probe_connectivity(
            &request.connectivity_targets,
            request.connectivity_timeout_ms,
            &names,
        )
    });
    let configs = collect_configs(&request.config_files, &names);
    let logs = collect_logs(&request.log_dir, &names);

    let mut files = BTreeMap::<String, Vec<u8>>::new();
    files.insert("system.json".to_owned(), json_bytes(&system));
    files.insert(
        "tools-and-tasks.json".to_owned(),
        json_bytes(&tools_and_tasks),
    );
    files.insert("download-policy.json".to_owned(), json_bytes(&policy));
    files.insert("runtime-state.json".to_owned(), json_bytes(&runtime));
    files.insert("disk.json".to_owned(), json_bytes(&disk));
    files.insert("connectivity.json".to_owned(), json_bytes(&connectivity));
    files.insert("export-diagnostics.json".to_owned(), json_bytes(&exports));
    for (name, payload) in configs {
        files.insert(format!("config/{name}"), json_bytes(&payload));
    }
    for (name, payload) in &logs {
        files.insert(format!("logs/{name}"), payload.as_bytes().to_vec());
    }

    let markdown = build_markdown(MarkdownInputs {
        system: &system,
        tools_and_tasks: &tools_and_tasks,
        policy: &policy,
        runtime: &runtime,
        disk: &disk,
        connectivity: &connectivity,
        exports: &exports,
        logs: &logs,
    });
    let zip_bytes = build_zip(&markdown, &files)?;
    let encoded_files = files
        .into_iter()
        .map(|(name, payload)| (name, BASE64.encode(payload)))
        .collect();
    Ok(DiagnosticResult {
        markdown,
        files: encoded_files,
        zip_base64: BASE64.encode(zip_bytes),
    })
}

pub fn probe_connectivity_only(
    targets: &BTreeMap<String, String>,
    timeout_ms: u64,
    local_usernames: &[String],
) -> Value {
    probe_connectivity(targets, timeout_ms, &normalized_usernames(local_usernames))
}

fn normalized_usernames(values: &[String]) -> Vec<String> {
    let mut names: Vec<String> = values
        .iter()
        .map(|value| value.trim().to_owned())
        .filter(|value| value.chars().count() >= 2)
        .collect();
    names.sort_by_key(|value| std::cmp::Reverse(value.chars().count()));
    names.dedup_by(|left, right| left.eq_ignore_ascii_case(right));
    names
}

fn redact_value(value: Value, key: &str, names: &[String]) -> Value {
    if sensitive_key(key) || username_key(key) {
        return Value::String(REDACTED.to_owned());
    }
    match value {
        Value::Object(entries) => Value::Object(
            entries
                .into_iter()
                .map(|(child_key, child)| {
                    let redacted = redact_value(child, &child_key, names);
                    (child_key, redacted)
                })
                .collect(),
        ),
        Value::Array(entries) => Value::Array(
            entries
                .into_iter()
                .map(|entry| redact_value(entry, key, names))
                .collect(),
        ),
        Value::String(text) => Value::String(redact_text(&text, names)),
        other => other,
    }
}

fn sensitive_key(key: &str) -> bool {
    let normalized = key.to_lowercase();
    [
        "cookie",
        "token",
        "secret",
        "password",
        "passwd",
        "authorization",
        "session",
        "sessdata",
        "bili_jct",
        "access_key",
        "access-key",
        "private_key",
        "private-key",
    ]
    .iter()
    .any(|needle| normalized.contains(needle))
}

fn username_key(key: &str) -> bool {
    matches!(
        key.to_lowercase().as_str(),
        "user"
            | "username"
            | "user_name"
            | "user_id"
            | "requester"
            | "requester_name"
            | "session_user"
            | "session_user_name"
            | "session_user_id"
            | "session_users"
            | "local_username"
    )
}

fn redact_text(text: &str, names: &[String]) -> String {
    let mut sanitized = text.to_owned();
    for name in names {
        if let Ok(pattern) = Regex::new(&format!("(?i){}", regex::escape(name))) {
            sanitized = pattern.replace_all(&sanitized, REDACTED).into_owned();
        }
    }
    let patterns = [
        r"(?im)(cookie\s*:\s*)[^\r\n]*",
        r"(?i)(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;]+",
        r"(?i)((?:cookie|sessdata|bili_jct|token|secret|password|access[_-]?key)\s*[:=]\s*)[^\s,;]+",
        r"(?i)([?&](?:token|secret|password|access_key|key)=)[^&#\s]+",
    ];
    for raw in patterns {
        if let Ok(pattern) = Regex::new(raw) {
            sanitized = pattern
                .replace_all(&sanitized, format!("${{1}}{REDACTED}"))
                .into_owned();
        }
    }
    sanitized
}

fn sanitize_exports(values: &[Value], names: &[String]) -> Value {
    let allowed = [
        "timestamp",
        "surface",
        "runtime",
        "format",
        "source",
        "pageSize",
        "stage",
        "status",
        "httpStatus",
        "contentType",
        "bytes",
        "filenameExtension",
        "elapsedMs",
        "stageTimings",
        "errorCode",
        "errorMessage",
    ];
    let entries = values
        .iter()
        .rev()
        .take(64)
        .rev()
        .filter_map(Value::as_object)
        .map(|source| {
            let mut target = Map::new();
            for key in allowed {
                let mut value = source.get(key).cloned().unwrap_or(Value::Null);
                if key == "stageTimings" {
                    value = Value::Array(
                        value
                            .as_array()
                            .into_iter()
                            .flatten()
                            .take(16)
                            .filter_map(|timing| {
                                let object = timing.as_object()?;
                                Some(json!({
                                    "stage": object.get("stage").and_then(Value::as_str).unwrap_or_default(),
                                    "elapsedMs": object.get("elapsedMs").and_then(Value::as_i64).unwrap_or(0),
                                }))
                            })
                            .collect(),
                    );
                }
                target.insert(key.to_owned(), value);
            }
            redact_value(Value::Object(target), "", names)
        })
        .collect();
    Value::Array(entries)
}

fn disk_snapshot(path: &Path, names: &[String]) -> Value {
    match (fs2::total_space(path), fs2::available_space(path)) {
        (Ok(total), Ok(free)) => json!({
            "path": redact_text(&path.to_string_lossy(), names),
            "total_bytes": total,
            "used_bytes": total.saturating_sub(free),
            "free_bytes": free,
            "free_gib": ((free as f64 / 1_073_741_824.0) * 100.0).round() / 100.0,
        }),
        (total, free) => json!({
            "path": redact_text(&path.to_string_lossy(), names),
            "error": redact_text(&format!("disk usage failed: total={total:?}, free={free:?}"), names),
            "total_bytes": 0,
            "used_bytes": 0,
            "free_bytes": 0,
            "free_gib": 0.0,
        }),
    }
}

fn probe_connectivity(
    targets: &BTreeMap<String, String>,
    timeout_ms: u64,
    names: &[String],
) -> Value {
    let handles: Vec<_> = targets
        .iter()
        .map(|(name, url)| {
            let name = name.clone();
            let url = url.clone();
            thread::spawn(move || {
                if url.trim().is_empty() {
                    return (name, json!({"reachable": false, "status": null, "latency_ms": null, "error": "not configured"}));
                }
                let started = std::time::Instant::now();
                let request = JsonHttpRequest {
                    method: "GET".to_owned(),
                    url,
                    headers: vec![HttpHeader {
                        name: "User-Agent".to_owned(),
                        value: "bilikara-diagnostics".to_owned(),
                    }],
                    payload: None,
                    timeout_ms,
                };
                let result = match execute_json_request(&request) {
                    Ok(response) => json!({
                        "reachable": true,
                        "status": response.status_code,
                        "latency_ms": started.elapsed().as_millis(),
                        "error": "",
                    }),
                    Err(error) => json!({
                        "reachable": error.status_code.is_some(),
                        "status": error.status_code,
                        "latency_ms": started.elapsed().as_millis(),
                        "error": error.message,
                    }),
                };
                (name, result)
            })
        })
        .collect();
    let mut results = Map::new();
    for handle in handles {
        if let Ok((name, result)) = handle.join() {
            results.insert(name, redact_value(result, "", names));
        }
    }
    Value::Object(results)
}

fn collect_configs(paths: &[PathBuf], names: &[String]) -> BTreeMap<String, Value> {
    let mut configs = BTreeMap::new();
    for path in paths {
        if !path.is_file() {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("config.json")
            .to_owned();
        let payload = match fs::read_to_string(path) {
            Ok(text) => serde_json::from_str(&text)
                .map(|value| redact_value(value, "", names))
                .unwrap_or_else(|cause| json!({"error": redact_text(&cause.to_string(), names)})),
            Err(cause) => json!({"error": redact_text(&cause.to_string(), names)}),
        };
        configs.insert(name, payload);
    }
    configs
}

fn collect_logs(log_dir: &Path, names: &[String]) -> BTreeMap<String, String> {
    let mut candidates = Vec::new();
    collect_log_paths(log_dir, &mut candidates);
    candidates.sort_by_key(|(modified, _)| std::cmp::Reverse(*modified));
    let mut logs = BTreeMap::new();
    for (_, path) in candidates.into_iter().take(MAX_LOG_FILES) {
        let Ok(metadata) = path.metadata() else {
            continue;
        };
        let Ok(bytes) = fs::read(&path) else {
            continue;
        };
        let start = bytes
            .len()
            .saturating_sub(MAX_LOG_BYTES.min(metadata.len()) as usize);
        let text = String::from_utf8_lossy(&bytes[start..]);
        let relative = path
            .strip_prefix(log_dir)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace(['\\', '/'], "__");
        logs.insert(relative, redact_text(&text, names));
    }
    logs
}

fn collect_log_paths(root: &Path, output: &mut Vec<(std::time::SystemTime, PathBuf)>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if metadata.is_dir() {
            collect_log_paths(&path, output);
        } else if metadata.is_file() {
            output.push((metadata.modified().unwrap_or(std::time::UNIX_EPOCH), path));
        }
    }
}

struct MarkdownInputs<'a> {
    system: &'a Value,
    tools_and_tasks: &'a Value,
    policy: &'a Value,
    runtime: &'a Value,
    disk: &'a Value,
    connectivity: &'a Value,
    exports: &'a Value,
    logs: &'a BTreeMap<String, String>,
}

fn build_markdown(inputs: MarkdownInputs<'_>) -> String {
    let MarkdownInputs {
        system,
        tools_and_tasks,
        policy,
        runtime,
        disk,
        connectivity,
        exports,
        logs,
    } = inputs;
    let tools = tools_and_tasks.get("tools").and_then(Value::as_object);
    let tasks = tools_and_tasks
        .get("tasks")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let browser = browser_label(system.get("browser"));
    let mut lines = vec![
        "# Bilikara Diagnostic Report".to_owned(),
        String::new(),
        format!("Generated: `{}`", text_field(system, "generated_at")),
        String::new(),
        "## Environment".to_owned(),
        String::new(),
        format!("- App: `{}`", text_field(system, "app_version")),
        format!("- System: `{}`", text_field(system, "system")),
        format!(
            "- Python: `{} {}`",
            text_field(system, "python_implementation"),
            text_field(system, "python_version")
        ),
        format!("- Browser: `{browser}`"),
        format!(
            "- Bundle: `{}`",
            if system
                .get("frozen_bundle")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                "yes"
            } else {
                "no"
            }
        ),
        String::new(),
        "## Tools".to_owned(),
        String::new(),
        "| Tool | Installed | Version | State | Message |".to_owned(),
        "| --- | --- | --- | --- | --- |".to_owned(),
    ];
    if let Some(tools) = tools {
        for (name, item) in tools {
            lines.push(format!(
                "| {} | {} | {} | {} | {} |",
                markdown_table_cell(name),
                if item
                    .get("installed")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    "yes"
                } else {
                    "no"
                },
                markdown_table_cell(&value_label(item.get("version"))),
                markdown_table_cell(&value_label(item.get("state"))),
                markdown_table_cell(&value_label(item.get("message"))),
            ));
        }
    }
    lines.extend([
        String::new(),
        "## Download Policy".to_owned(),
        String::new(),
        json_code_block(policy),
        String::new(),
        "## Disk".to_owned(),
        String::new(),
        format!("- Free: `{} GiB`", value_label(disk.get("free_gib"))),
        format!("- Free bytes: `{}`", value_label(disk.get("free_bytes"))),
        String::new(),
        "## Connectivity".to_owned(),
        String::new(),
        "| Target | Reachable | HTTP | Latency | Error |".to_owned(),
        "| --- | --- | --- | --- | --- |".to_owned(),
    ]);
    if let Some(entries) = connectivity.as_object() {
        for (name, item) in entries {
            lines.push(format!(
                "| {name} | {} | {} | {} ms | {} |",
                if item
                    .get("reachable")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    "yes"
                } else {
                    "no"
                },
                value_label(item.get("status")),
                value_label(item.get("latency_ms")),
                value_label(item.get("error")),
            ));
        }
    }
    lines.extend([
        String::new(),
        "## Recent Tasks".to_owned(),
        String::new(),
        json_code_block(&json!({"cache": tasks, "runtime": runtime})),
        String::new(),
        "## Recent Export Pipeline Diagnostics".to_owned(),
        String::new(),
    ]);
    if let Some(entries) = exports.as_array().filter(|entries| !entries.is_empty()) {
        lines.push("| Timestamp | Surface | Runtime | Format | Status | Stage | HTTP | Bytes | Elapsed | Error |".to_owned());
        lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |".to_owned());
        for item in entries {
            lines.push(format!(
                "| {} | {} | {} | {} | {} | {} | {} | {} | {} ms | {} |",
                value_label(item.get("timestamp")),
                value_label(item.get("surface")),
                value_label(item.get("runtime")),
                value_label(item.get("format")),
                value_label(item.get("status")),
                value_label(item.get("stage")),
                value_label(item.get("httpStatus")),
                value_label(item.get("bytes")),
                value_label(item.get("elapsedMs")),
                item.get("errorMessage")
                    .or_else(|| item.get("errorCode"))
                    .map_or("-".to_owned(), |value| value_label(Some(value))),
            ));
        }
    } else {
        lines.push("No recent export attempts recorded.".to_owned());
    }
    if !logs.is_empty() {
        let mut recent = Vec::new();
        for (name, text) in logs {
            recent.push(format!("--- {name} ---"));
            recent.extend(
                text.lines()
                    .rev()
                    .take(MAX_MARKDOWN_LOG_LINES)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .map(str::to_owned),
            );
            if recent.len() >= MAX_MARKDOWN_LOG_LINES {
                break;
            }
        }
        let start = recent.len().saturating_sub(MAX_MARKDOWN_LOG_LINES);
        lines.extend([
            String::new(),
            "## Recent Sanitized Logs".to_owned(),
            String::new(),
            "```text".to_owned(),
        ]);
        lines.extend(recent[start..].iter().cloned());
        lines.push("```".to_owned());
    }
    lines.extend([
        String::new(),
        "> Sensitive credentials and local user names are automatically redacted.".to_owned(),
        String::new(),
    ]);
    lines.join("\n")
}

fn browser_label(browser: Option<&Value>) -> String {
    let Some(browser) = browser else {
        return "unknown".to_owned();
    };
    if let Some(brands) = browser.get("brands").and_then(Value::as_array) {
        let labels: Vec<String> = brands
            .iter()
            .filter_map(|item| {
                let brand = item.get("brand")?.as_str()?;
                Some(format!(
                    "{brand} {}",
                    item.get("version")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                ))
            })
            .collect();
        if !labels.is_empty() {
            return labels.join(", ");
        }
    }
    browser
        .get("user_agent")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_owned()
}

fn text_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .map_or(String::new(), |item| value_label(Some(item)))
}

fn value_label(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => "-".to_owned(),
        Some(Value::String(text)) if text.is_empty() => "-".to_owned(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
    }
}

fn markdown_table_cell(value: &str) -> String {
    value.replace('|', "\\|").replace(['\r', '\n'], " ")
}

fn json_code_block(value: &Value) -> String {
    format!(
        "```json\n{}\n```",
        serde_json::to_string_pretty(value).unwrap_or_else(|_| "{}".to_owned())
    )
}

fn json_bytes(value: &Value) -> Vec<u8> {
    serde_json::to_vec_pretty(value).unwrap_or_else(|_| b"{}".to_vec())
}

fn build_zip(
    markdown: &str,
    files: &BTreeMap<String, Vec<u8>>,
) -> Result<Vec<u8>, DiagnosticError> {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    writer
        .start_file("diagnostics.md", options)
        .map_err(zip_error)?;
    writer.write_all(markdown.as_bytes()).map_err(io_error)?;
    for (name, payload) in files {
        writer.start_file(name, options).map_err(zip_error)?;
        writer.write_all(payload).map_err(io_error)?;
    }
    writer
        .finish()
        .map(|cursor| cursor.into_inner())
        .map_err(zip_error)
}

fn zip_error(cause: zip::result::ZipError) -> DiagnosticError {
    DiagnosticError {
        kind: "zip_failed",
        message: cause.to_string(),
    }
}

fn io_error(cause: std::io::Error) -> DiagnosticError {
    DiagnosticError {
        kind: "zip_failed",
        message: cause.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_nested_secrets_and_usernames() {
        let value = json!({
            "access_token": "secret",
            "path": r"C:\Users\Kevin\bilikara",
            "nested": {"authorization": "Bearer secret"},
        });
        let redacted = redact_value(value, "", &["Kevin".to_owned()]);
        let text = redacted.to_string();
        assert!(!text.contains("secret"));
        assert!(!text.contains("Kevin"));
        assert!(text.contains(REDACTED));
    }

    #[test]
    fn export_sanitizer_caps_records_and_stage_timings() {
        let timing = json!({"stage": "request", "elapsedMs": 1});
        let values = (0..70)
            .map(|_| json!({"format": "csv", "requester": "hidden", "stageTimings": vec![timing.clone(); 20]}))
            .collect::<Vec<_>>();
        let result = sanitize_exports(&values, &[]);
        let entries = result.as_array().unwrap();
        assert_eq!(entries.len(), 64);
        assert_eq!(entries[0]["stageTimings"].as_array().unwrap().len(), 16);
        assert!(entries[0].get("requester").is_none());
    }

    #[test]
    fn markdown_tool_table_includes_failure_messages() {
        let system = json!({
            "generated_at": "2026-08-14T00:00:00Z",
            "app_version": "test",
        });
        let tools_and_tasks = json!({
            "tools": {
                "Rust Native / Bilibili": {
                    "installed": true,
                    "version": "ABI 1",
                    "state": "failed",
                    "message": "legacy BBDown prewarm failed",
                }
            },
            "tasks": {},
        });
        let empty = json!({});
        let logs = BTreeMap::new();
        let markdown = build_markdown(MarkdownInputs {
            system: &system,
            tools_and_tasks: &tools_and_tasks,
            policy: &empty,
            runtime: &empty,
            disk: &empty,
            connectivity: &empty,
            exports: &json!([]),
            logs: &logs,
        });

        assert!(markdown.contains("| Tool | Installed | Version | State | Message |"));
        assert!(markdown.contains("legacy BBDown prewarm failed"));
    }
}
