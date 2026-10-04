//! Standalone administrator maintenance, preserving the source CLI contract.
//! This is not the native Host's fixed monthly job or a local-library refresh.
use crate::bilibili_service::BilibiliHttpClient;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[derive(Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Options {
    pub uid_source: PathBuf,
    pub uid_mode: String,
    pub api_url: String,
    pub limit_uids: i64,
    pub delay: f64,
    pub export_limit: i64,
    pub export_timeout: f64,
    pub upload_batch_size: i64,
    pub max_visible_total: i64,
    pub bili_retry_delay: f64,
    pub bili_max_retries: i64,
    pub probe_mode: String,
    pub force: bool,
    pub dry_run: bool,
    pub cookie: String,
    pub cookie_path: PathBuf,
    pub version: String,
}

impl Default for Options {
    fn default() -> Self {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("source root");
        let home = std::env::var_os("BILIKARA_HOME")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| root.into());
        let version = source_version(root);
        let home = expand_home(home);
        Self {
            uid_source: home.join("data/gatcha_uids.json"),
            uid_mode: "union".into(),
            api_url: crate::shared_catalog::CatalogRequest::for_host().base_url,
            limit_uids: 0,
            delay: 2.0,
            export_limit: 5000,
            export_timeout: 120.0,
            upload_batch_size: 500,
            max_visible_total: 8000,
            bili_retry_delay: 5.0,
            bili_max_retries: 3,
            probe_mode: "page-any".into(),
            force: false,
            dry_run: false,
            cookie: std::env::var("BILIKARA_BILIBILI_COOKIE")
                .unwrap_or_default()
                .trim()
                .into(),
            version: version.trim().into(),
            cookie_path: home.join("tools/bbdown/BBDown.data"),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct MaintenanceError {
    pub kind: &'static str,
    pub message: String,
}
fn error(kind: &'static str, message: impl Into<String>) -> MaintenanceError {
    MaintenanceError {
        kind,
        message: message.into(),
    }
}

fn expand_home(path: PathBuf) -> PathBuf {
    if (path == Path::new("~") || path.starts_with("~/") || path.starts_with("~\\"))
        && let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))
    {
        let suffix = path.strip_prefix("~").unwrap_or(Path::new(""));
        return PathBuf::from(home).join(suffix);
    }
    path
}
fn source_version(root: &Path) -> String {
    if let Ok(value) = std::env::var("BILIKARA_VERSION")
        && !value.trim().is_empty()
    {
        return value.trim().into();
    }
    if let Ok(mut child) = Command::new("git")
        .args(["describe", "--tags", "--always", "--dirty"])
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    let mut value = String::new();
                    if status.success()
                        && let Some(stdout) = child.stdout.take()
                        && stdout.take(8192).read_to_string(&mut value).is_ok()
                        && !value.trim().is_empty()
                    {
                        return value.trim().into();
                    }
                    break;
                }
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(10))
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break;
                }
            }
        }
    }
    std::fs::read_to_string(root.join("APP_VERSION"))
        .ok()
        .filter(|v| !v.trim().is_empty())
        .map(|v| v.trim().into())
        .unwrap_or_else(|| "dev".into())
}

fn normalize_uid(text: &str) -> Option<String> {
    let text = text.trim();
    let space = Regex::new(r"space\.bilibili\.com/(\d+)").expect("static regex");
    let digits = Regex::new(r"\b(\d{2,})\b").expect("static regex");
    let selected = space
        .captures(text)
        .or_else(|| digits.captures(text))
        .and_then(|c| c.get(1).map(|m| m.as_str().to_owned()))
        .unwrap_or_else(|| text.into());
    if selected.is_empty() || !selected.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let trimmed = selected.trim_start_matches('0');
    Some(if trimmed.is_empty() { "0" } else { trimmed }.into())
}
fn value_text(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| value.to_string())
}
fn dedupe(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter_map(|v| normalize_uid(&v))
        .filter(|v| seen.insert(v.clone()))
        .collect()
}
fn load_uids(path: &Path) -> Result<Vec<String>, MaintenanceError> {
    let bytes = std::fs::read(path).map_err(|_| error("input", "Cannot read UID source"))?;
    if path
        .extension()
        .is_some_and(|v| v.eq_ignore_ascii_case("json"))
    {
        let payload: OrderedUidSource =
            serde_json::from_slice(&bytes).map_err(|_| error("input", "Invalid UID JSON shape"))?;
        return Ok(dedupe(payload.0));
    }
    let text = String::from_utf8_lossy(&bytes);
    Ok(dedupe(
        text.trim_start_matches('\u{feff}')
            .lines()
            .map(str::trim)
            .filter(|v| !v.is_empty() && !v.starts_with('#') && !v.starts_with("//"))
            .map(str::to_owned),
    ))
}
fn bvid(entry: &Value) -> Option<&str> {
    entry["bvid"].as_str().map(str::trim).filter(|v| {
        v.len() == 12 && v.starts_with("BV") && v[2..].bytes().all(|c| c.is_ascii_alphanumeric())
    })
}
fn entry_id(entry: &Value) -> Option<&str> {
    entry["bvid"]
        .as_str()
        .map(str::trim)
        .filter(|v| !v.is_empty())
}
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::Number(v) => v.as_f64() != Some(0.0),
        Value::String(v) => !v.is_empty(),
        Value::Array(v) => !v.is_empty(),
        Value::Object(v) => !v.is_empty(),
    }
}
fn counter(value: &Value) -> Result<i64, MaintenanceError> {
    if !truthy(value) {
        return Ok(0);
    }
    match value {
        Value::Bool(v) => Ok(i64::from(*v)),
        Value::Number(v) => v
            .as_i64()
            .or_else(|| v.as_f64().map(|v| v as i64))
            .ok_or_else(|| error("upload", "Invalid D1 upload counter")),
        Value::String(v) => v
            .trim()
            .parse()
            .map_err(|_| error("upload", "Invalid D1 upload counter")),
        _ => Err(error("upload", "Invalid D1 upload counter")),
    }
}
#[derive(Default, Debug, PartialEq)]
struct Upload {
    attempted: i64,
    added: i64,
    updated_existing: i64,
    skipped_existing: i64,
    skipped_blacklisted: i64,
}
fn upload_entries(
    source: &mut impl Source,
    options: &Options,
    entries: &[Value],
) -> Result<Upload, MaintenanceError> {
    if options.dry_run {
        return Ok(Upload {
            attempted: entries.len() as i64,
            ..Default::default()
        });
    }
    let mut result = Upload::default();
    for chunk in entries.chunks(options.upload_batch_size.clamp(1, 2000) as usize) {
        let reply = source.upload(chunk)?;
        if !reply.is_object() || !truthy(&reply["success"]) {
            return Err(error("upload", "D1 batch upload was not confirmed"));
        }
        result.attempted += counter(&reply["attempted"])?;
        result.added += counter(&reply["added"])?;
        result.updated_existing += counter(&reply["updated_existing"])?;
        result.skipped_existing += counter(&reply["skipped_existing"])?;
        result.skipped_blacklisted += counter(&reply["skipped_blacklisted"])?;
    }
    Ok(result)
}
fn needs_refresh(entries: &[Value], known: &HashSet<String>, mode: &str) -> bool {
    let mut ids = entries.iter().filter_map(bvid);
    if mode == "latest" {
        ids.next().is_some_and(|v| !known.contains(v))
    } else {
        ids.any(|v| !known.contains(v))
    }
}

trait Source {
    fn export(&mut self) -> Result<Vec<Value>, MaintenanceError>;
    fn page(&mut self, uid: &str, page: usize) -> Result<(Vec<Value>, usize), MaintenanceError>;
    fn upload(&mut self, entries: &[Value]) -> Result<Value, MaintenanceError>;
    fn pause(&mut self, seconds: f64);
}

#[derive(Default, Debug, Serialize)]
pub struct Summary {
    pub refreshed: usize,
    pub skipped: usize,
    pub failed: usize,
}

fn page_with_retry(
    source: &mut impl Source,
    options: &Options,
    uid: &str,
    number: usize,
) -> Result<(Vec<Value>, usize), MaintenanceError> {
    let mut attempts = 0i64;
    loop {
        match source.page(uid, number) {
            Ok(page) => return Ok(page),
            Err(failure) => {
                attempts = attempts.saturating_add(1);
                if options.bili_max_retries > 0 && attempts > options.bili_max_retries {
                    return Err(failure);
                }
                eprintln!("  Bilibili page retry uid={uid} page={number} attempt={attempts}");
                source.pause(options.bili_retry_delay);
            }
        }
    }
}

fn run(
    source: &mut impl Source,
    options: &Options,
    local: Vec<String>,
) -> Result<Summary, MaintenanceError> {
    let started = Instant::now();
    let records = source.export()?;
    let mut known: HashSet<String> = records.iter().filter_map(bvid).map(str::to_owned).collect();
    let mut exported = dedupe(
        records
            .iter()
            .filter_map(|r| r.get("mid"))
            .filter(|v| truthy(v))
            .map(value_text),
    );
    exported.sort_by(|a, b| a.len().cmp(&b.len()).then_with(|| a.cmp(b)));
    let local_set: HashSet<_> = local.iter().cloned().collect();
    let exported_set: HashSet<_> = exported.iter().cloned().collect();
    let mut uids = match options.uid_mode.as_str() {
        "local" => local.clone(),
        "d1" => exported.clone(),
        _ => dedupe(local.iter().cloned().chain(exported)),
    };
    if options.limit_uids > 0 {
        uids.truncate(options.limit_uids as usize);
    }
    if uids.is_empty() {
        println!("No UID found.");
        return Ok(Summary::default());
    }
    println!(
        "Loaded uid_mode={} process_uids={} process_unique_mids={} local_uids={} local_unique_mids={} d1_records={} d1_unique_mids={} d1_unique_bvids={} local_only_mids={} d1_only_mids={}",
        options.uid_mode,
        uids.len(),
        uids.iter().collect::<HashSet<_>>().len(),
        local.len(),
        local_set.len(),
        records.len(),
        exported_set.len(),
        known.len(),
        local_set.difference(&exported_set).count(),
        exported_set.difference(&local_set).count()
    );
    let mut summary = Summary::default();
    for (index, uid) in uids.iter().enumerate() {
        println!("[{}/{}] probe uid={uid}", index + 1, uids.len());
        let refreshed: Result<bool, MaintenanceError> = (|| {
            let (first, total) = page_with_retry(source, options, uid, 1)?;
            if (options.max_visible_total > 0 && total as u64 > options.max_visible_total as u64)
                || (!options.force && !needs_refresh(&first, &known, &options.probe_mode))
            {
                return Ok(false);
            }
            // The source CLI refetches page one, and stops on filtered-entry
            // count. Native Host uses its own accepted raw-page recipe.
            let mut entries = Vec::new();
            let mut seen = HashSet::new();
            let mut page = 1;
            loop {
                let (items, _) = page_with_retry(source, options, uid, page)?;
                let count = items.len();
                for item in items {
                    if let Some(id) = entry_id(&item)
                        && seen.insert(id.to_owned())
                        && !known.contains(id)
                    {
                        entries.push(item);
                    }
                }
                if count < 50 {
                    break;
                }
                page += 1;
            }
            let upload = upload_entries(source, options, &entries)?;
            known.extend(entries.iter().filter_map(bvid).map(str::to_owned));
            println!(
                "  refreshed entries={} missing={} d1_attempted={} d1_added={} d1_updated={}",
                seen.len(),
                entries.len(),
                upload.attempted,
                upload.added,
                upload.updated_existing
            );
            Ok(true)
        })();
        match refreshed {
            Ok(true) => summary.refreshed += 1,
            Ok(false) => {
                summary.skipped += 1;
                continue;
            }
            Err(failure) => {
                summary.failed += 1;
                eprintln!("  failed uid={uid}: {}", failure.message);
            }
        }
        if index + 1 < uids.len() {
            source.pause(options.delay);
        }
    }
    println!(
        "Done. refreshed={} skipped={} failed={} elapsed={:.1}s",
        summary.refreshed,
        summary.skipped,
        summary.failed,
        started.elapsed().as_secs_f64()
    );
    Ok(summary)
}

struct NetworkSource<'a> {
    options: &'a Options,
    secret: &'a str,
    client: BilibiliHttpClient,
    next_page: Instant,
}
impl NetworkSource<'_> {
    fn request(
        &self,
        path: &str,
        payload: Option<Value>,
        timeout: f64,
    ) -> Result<Value, MaintenanceError> {
        let duration = Duration::try_from_secs_f64(timeout)
            .map_err(|_| error("timeout", "Invalid request timeout"))?;
        let client = crate::http_client::builder()
            .timeout(duration)
            .build()
            .map_err(|_| error("http", "Cannot create verified HTTP client"))?;
        let mut request = client
            .request(
                if payload.is_some() {
                    reqwest::Method::POST
                } else {
                    reqwest::Method::GET
                },
                format!("{}{}", self.options.api_url.trim_end_matches('/'), path),
            )
            .header("Accept", "application/json")
            .header("Cache-Control", "no-store")
            .header("Pragma", "no-cache")
            .header(
                "User-Agent",
                format!(
                    "bilikara/{} (+https://github.com/VZRXS/bilikara)",
                    self.options.version
                ),
            )
            .header("Authorization", format!("Bearer {}", self.secret));
        if let Some(body) = payload {
            request = request.json(&body);
        }
        let reply = request
            .send()
            .map_err(|_| error("http", "D1 transport failed (credentials omitted)"))?;
        if !reply.status().is_success() {
            return Err(error(
                "http",
                format!("D1 returned HTTP {}", reply.status().as_u16()),
            ));
        }
        reply
            .json()
            .map_err(|_| error("json", "D1 returned invalid or interrupted JSON"))
    }
}
impl Source for NetworkSource<'_> {
    fn export(&mut self) -> Result<Vec<Value>, MaintenanceError> {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let value = self.request(
            &format!(
                "/export?all=1&limit={}&_={stamp}",
                self.options.export_limit.max(1)
            ),
            None,
            self.options.export_timeout,
        )?;
        value
            .as_array()
            .map(|v| v.iter().filter(|v| v.is_object()).cloned().collect())
            .ok_or_else(|| error("export", "D1 export returned an invalid payload"))
    }
    fn page(&mut self, uid: &str, page: usize) -> Result<(Vec<Value>, usize), MaintenanceError> {
        std::thread::sleep(self.next_page.saturating_duration_since(Instant::now()));
        self.next_page = Instant::now() + Duration::from_secs(5);
        crate::gatcha_repository::source_catalog_uid_page(
            &self.client,
            uid,
            page,
            &crate::shared_catalog::CatalogRequest::for_host().review_keywords,
        )
        .map_err(|_| error("bilibili", "Bilibili UID page failed (credentials omitted)"))
    }
    fn upload(&mut self, entries: &[Value]) -> Result<Value, MaintenanceError> {
        self.request(
            "/batch-add?sync_google=1",
            Some(json!({"records":entries})),
            120.0,
        )
    }
    fn pause(&mut self, seconds: f64) {
        if seconds > 0.0
            && let Ok(duration) = Duration::try_from_secs_f64(seconds)
        {
            std::thread::sleep(duration);
        }
    }
}

fn validate(options: &Options) -> Result<(), MaintenanceError> {
    if !["local", "union", "d1"].contains(&options.uid_mode.as_str())
        || !["latest", "page-any"].contains(&options.probe_mode.as_str())
    {
        return Err(error("arguments", "Unsupported UID/probe mode"));
    }
    if !options.delay.is_finite()
        || !options.bili_retry_delay.is_finite()
        || !options.export_timeout.is_finite()
        || options.export_timeout <= 0.0
    {
        return Err(error("arguments", "Invalid delay or timeout"));
    }
    if options.api_url.trim().is_empty() {
        return Err(error("arguments", "BILIKARA_CF_API_URL is empty"));
    }
    Ok(())
}
pub fn execute(options: &Options, secret: &str) -> Result<Summary, MaintenanceError> {
    validate(options)?;
    let path = expand_home(options.uid_source.clone());
    let local = if path.exists() {
        load_uids(&path)?
    } else if options.uid_mode == "local" {
        return Err(error("uid_source", "UID source does not exist"));
    } else {
        Vec::new()
    };
    if secret.trim().is_empty() {
        return Err(error(
            "secret",
            "BILIKARA_ADMIN_SECRET is required to export D1 records",
        ));
    }
    let credentials =
        crate::desktop_login::execute(crate::desktop_login::LoginCommand::ReadCookie {
            data_path: expand_home(options.cookie_path.clone()),
            configured_cookie: options.cookie.clone(),
        })
        .map_err(|_| error("bilibili", "Cannot read configured Bilibili credentials"))?;
    let client=BilibiliHttpClient::new(credentials["cookie"].as_str().unwrap_or_default(),"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36","https://www.bilibili.com/",15_000)
        .map_err(|_|error("bilibili","Cannot create Bilibili client"))?;
    run(
        &mut NetworkSource {
            options,
            secret: secret.trim(),
            client,
            next_page: Instant::now(),
        },
        options,
        local,
    )
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct StartRequest {
    pub options: Options,
    pub secret: String,
    #[serde(default)]
    pub requested_by: String,
}
struct Lease;
impl Drop for Lease {
    fn drop(&mut self) {
        let _ = crate::app_state::source_monthly_guard(|active| *active = false);
    }
}
fn start_with(
    request: StartRequest,
    spawn: impl FnOnce(Box<dyn FnOnce() + Send>) -> std::io::Result<()>,
) -> Result<Value, MaintenanceError> {
    if request.secret.trim().is_empty() {
        return Ok(json!({"success":false,"job":"monthly-d1-refresh","error":"missing secret"}));
    }
    validate(&request.options)?;
    let claimed = crate::app_state::source_monthly_guard(|active| {
        if *active {
            false
        } else {
            *active = true;
            true
        }
    })
    .map_err(|_| error("state", "Rust monthly state is unavailable"))?;
    if !claimed {
        return Ok(
            json!({"success":false,"job":"monthly-d1-refresh","error":"monthly D1 refresh is already running locally"}),
        );
    }
    let lease = Lease;
    let spawned = spawn(Box::new(move || {
        let _lease = lease;
        let requester = request
            .requested_by
            .trim()
            .chars()
            .take(120)
            .collect::<String>();
        if !requester.is_empty() {
            println!("Monthly D1 refresh requested locally by {requester}.");
        }
        match execute(&request.options, &request.secret) {
            Ok(summary) if summary.failed > 0 => {
                eprintln!("Monthly D1 refresh exited with code 1.")
            }
            Err(failure) => eprintln!("Monthly D1 refresh failed: {}", failure.message),
            _ => (),
        }
    }));
    if spawned.is_err() {
        return Ok(
            json!({"success":false,"job":"monthly-d1-refresh","error":"failed to start local monthly D1 refresh"}),
        );
    }
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    Ok(
        json!({"success":true,"job":"monthly-d1-refresh","instance_id":format!("local-monthly-{stamp}"),"status":"running","execution":"local"}),
    )
}
pub(crate) fn start(request: StartRequest) -> Result<Value, MaintenanceError> {
    start_with(request, |task| {
        std::thread::Builder::new()
            .name("bilikara-monthly-d1-refresh".into())
            .spawn(task)
            .map(|_| ())
    })
}

pub fn cli(args: impl IntoIterator<Item = String>) -> i32 {
    let mut options = Options::default();
    let mut args = args.into_iter();
    while let Some(key) = args.next() {
        if key == "--help" {
            println!(
                "Monthly full-UID D1 refresh\n--uid-source PATH --uid-mode union|local|d1 --api-url URL\n--limit-uids N --delay SECONDS --export-limit N --export-timeout SECONDS\n--upload-batch-size N --max-visible-total N --bili-retry-delay SECONDS\n--bili-max-retries N (0 means unlimited) --probe-mode latest|page-any --force --dry-run"
            );
            return 0;
        }
        if key == "--force" {
            options.force = true;
            continue;
        }
        if key == "--dry-run" {
            options.dry_run = true;
            continue;
        }
        let Some(value) = args.next() else {
            eprintln!("Missing value for {key}");
            return 2;
        };
        let parsed = (|| -> Result<(), ()> {
            match key.as_str() {
                "--uid-source" => options.uid_source = value.into(),
                "--uid-mode" => options.uid_mode = value,
                "--api-url" => options.api_url = value,
                "--limit-uids" => options.limit_uids = value.parse().map_err(|_| ())?,
                "--delay" => options.delay = value.parse().map_err(|_| ())?,
                "--export-limit" => options.export_limit = value.parse().map_err(|_| ())?,
                "--export-timeout" => options.export_timeout = value.parse().map_err(|_| ())?,
                "--upload-batch-size" => {
                    options.upload_batch_size = value.parse().map_err(|_| ())?
                }
                "--max-visible-total" => {
                    options.max_visible_total = value.parse().map_err(|_| ())?
                }
                "--bili-retry-delay" => options.bili_retry_delay = value.parse().map_err(|_| ())?,
                "--bili-max-retries" => options.bili_max_retries = value.parse().map_err(|_| ())?,
                "--probe-mode" => options.probe_mode = value,
                _ => return Err(()),
            }
            Ok(())
        })();
        if parsed.is_err() {
            eprintln!("Invalid argument {key}");
            return 2;
        }
    }
    let secret = std::env::var("BILIKARA_ADMIN_SECRET").unwrap_or_default();
    match execute(&options, &secret) {
        Ok(summary) => i32::from(summary.failed > 0),
        Err(failure) => {
            eprintln!("{}", failure.message);
            if failure.kind == "input" { 1 } else { 2 }
        }
    }
}

// Preserve the source file's UID-map insertion order without changing serde
// object ordering globally for application state or package metadata.
struct OrderedUidSource(Vec<String>);
struct UidValues(Vec<String>);
impl<'de> Deserialize<'de> for UidValues {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = UidValues;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a UID array or ordered UID map")
            }
            fn visit_seq<S: serde::de::SeqAccess<'de>>(
                self,
                mut seq: S,
            ) -> Result<UidValues, S::Error> {
                let mut ids = Vec::new();
                while let Some(value) = seq.next_element::<Value>()? {
                    ids.push(value_text(&value));
                }
                Ok(UidValues(ids))
            }
            fn visit_map<M: serde::de::MapAccess<'de>>(
                self,
                mut map: M,
            ) -> Result<UidValues, M::Error> {
                let mut ids = Vec::new();
                while let Some(key) = map.next_key::<String>()? {
                    map.next_value::<serde::de::IgnoredAny>()?;
                    ids.push(key);
                }
                Ok(UidValues(ids))
            }
        }
        deserializer.deserialize_any(Visitor)
    }
}
impl<'de> Deserialize<'de> for OrderedUidSource {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = OrderedUidSource;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("UID array or object with uids")
            }
            fn visit_seq<S: serde::de::SeqAccess<'de>>(
                self,
                mut seq: S,
            ) -> Result<OrderedUidSource, S::Error> {
                let mut ids = Vec::new();
                while let Some(value) = seq.next_element::<Value>()? {
                    ids.push(value_text(&value));
                }
                Ok(OrderedUidSource(ids))
            }
            fn visit_map<M: serde::de::MapAccess<'de>>(
                self,
                mut map: M,
            ) -> Result<OrderedUidSource, M::Error> {
                let mut ids = None;
                while let Some(key) = map.next_key::<String>()? {
                    if key == "uids" {
                        ids = Some(map.next_value::<UidValues>()?.0);
                    } else {
                        map.next_value::<serde::de::IgnoredAny>()?;
                    }
                }
                ids.map(OrderedUidSource)
                    .ok_or_else(|| serde::de::Error::custom("missing uids"))
            }
        }
        deserializer.deserialize_any(Visitor)
    }
}

#[cfg(test)]
mod tests;
