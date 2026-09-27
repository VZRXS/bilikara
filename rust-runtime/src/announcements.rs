//! Bounded static-feed IO and installation-local presentation records.
//! The native Host owns `State` inside the authoritative AppState; this module
//! creates no singleton, background poller, D1 query or Python fallback.
use bilikara_rust::announcement_policy::{self as policy, Announcement, Kind};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{Read, Write},
    path::Path,
    time::{Duration, Instant},
};

pub const FEED_URL: &str = "https://download.kevinx96.icu/bilikara/announcements/index.json";
pub const MAX_FEED_BYTES: usize = 512 * 1024;
const MAX_SAVED_BYTES: u64 = 1024 * 1024;
const MAX_SHOWN: usize = 4096;
const CACHE_SECONDS: i64 = 300;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Feed {
    schema_version: u32,
    announcements: Vec<Item>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Item {
    id: String,
    kind: String,
    published_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    starts_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ends_at: Option<String>,
    #[serde(default)]
    platforms: Vec<String>,
    title: BTreeMap<String, String>,
    body_markdown: BTreeMap<String, String>,
}

fn timestamp(value: &str) -> Result<i64, String> {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|date| date.timestamp())
        .map_err(|_| "announcement_timestamp: expected RFC3339 with timezone".into())
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 96
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

fn translations(values: &BTreeMap<String, String>, limit: usize) -> bool {
    !values.is_empty()
        && values.iter().all(|(language, value)| {
            matches!(language.as_str(), "zh" | "en" | "ja")
                && !value.trim().is_empty()
                && value.len() <= limit
                && !value.contains('\0')
        })
}

impl Item {
    fn policy(&self) -> Result<Announcement, String> {
        if !valid_id(&self.id)
            || !translations(&self.title, 512)
            || !translations(&self.body_markdown, 16 * 1024)
            || self.platforms.len() > 4
            || self
                .platforms
                .iter()
                .any(|p| !matches!(p.as_str(), "windows" | "macos" | "linux" | "android"))
        {
            return Err("announcement_fields: invalid ID, translation or platform".into());
        }
        let kind = match self.kind.as_str() {
            "release" if self.starts_at.is_none() && self.ends_at.is_none() => {
                let version = self.version.as_deref().unwrap_or_default();
                if version.is_empty()
                    || version.len() > 128
                    || version.trim() != version
                    || !version
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b".+-".contains(&b))
                {
                    return Err(
                        "announcement_version: release requires an installed-version label".into(),
                    );
                }
                Kind::Release {
                    version: version.into(),
                }
            }
            "notice" if self.version.is_none() => {
                let starts_at = timestamp(self.starts_at.as_deref().unwrap_or_default())?;
                let ends_at = timestamp(self.ends_at.as_deref().unwrap_or_default())?;
                if starts_at >= ends_at {
                    return Err("announcement_interval: start must precede end".into());
                }
                Kind::Notice { starts_at, ends_at }
            }
            _ => {
                return Err(
                    "announcement_kind: expected release or notice with matching fields".into(),
                );
            }
        };
        Ok(Announcement {
            id: self.id.clone(),
            kind,
            published_at: timestamp(&self.published_at)?,
            platforms: self.platforms.clone(),
        })
    }
}

impl Feed {
    fn validate(&self) -> Result<(), String> {
        if self.schema_version != 1 || self.announcements.len() > 128 {
            return Err("announcement_schema: expected schema 1 and at most 128 items".into());
        }
        let mut ids = BTreeSet::new();
        for item in &self.announcements {
            item.policy()?;
            if !ids.insert(&item.id) {
                return Err("announcement_id: duplicate ID".into());
            }
        }
        Ok(())
    }
}

fn parse(bytes: &[u8]) -> Result<Feed, String> {
    if bytes.len() > MAX_FEED_BYTES {
        return Err("announcement_size: feed exceeds 512 KiB".into());
    }
    let feed: Feed =
        serde_json::from_slice(bytes).map_err(|_| "announcement_json: invalid feed".to_owned())?;
    feed.validate()?;
    Ok(feed)
}

/// Publication tooling uses exactly the same schema validation as the client.
pub fn validate_manifest(bytes: &[u8]) -> Result<(), String> {
    parse(bytes).map(|_| ())
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Saved {
    schema_version: u32,
    feed: Option<Feed>,
    etag: Option<String>,
    checked_at: i64,
    shown: BTreeSet<String>,
}

impl Default for Saved {
    fn default() -> Self {
        Self {
            schema_version: 1,
            feed: None,
            etag: None,
            checked_at: 0,
            shown: BTreeSet::new(),
        }
    }
}

#[derive(Default)]
pub(crate) struct State {
    pub(crate) check: std::sync::Arc<std::sync::Mutex<()>>,
    saved: Saved,
    last_attempt: Option<Instant>,
    error: Option<String>,
    storage_error: bool,
    pub(crate) version: String,
    pub(crate) platform: String,
}

fn regular(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        _ => Err("announcement_storage: expected a regular private file".into()),
    }
}

fn save(directory: &Path, saved: &Saved) -> Result<(), String> {
    let destination = directory.join("announcements.json");
    let pending = directory.join("announcements.pending");
    regular(&destination)?;
    regular(&pending)?;
    let bytes = serde_json::to_vec(saved).map_err(|_| "announcement_storage".to_owned())?;
    if bytes.len() as u64 > MAX_SAVED_BYTES {
        return Err("announcement_storage_limit".into());
    }
    let mut options = fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options
        .open(&pending)
        .map_err(|_| "announcement_storage".to_owned())?;
    file.write_all(&bytes)
        .and_then(|()| file.sync_all())
        .map_err(|_| "announcement_storage".to_owned())?;
    drop(file);
    fs::rename(pending, destination).map_err(|_| "announcement_storage".to_owned())
}

impl State {
    pub(crate) fn load(directory: &Path, version: String, platform: String) -> Self {
        let mut state = Self {
            version,
            platform,
            ..Self::default()
        };
        let read = || -> Result<Saved, String> {
            let path = directory.join("announcements.json");
            regular(&path)?;
            let file = match fs::File::open(path) {
                Ok(file) => file,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    return Ok(Saved::default());
                }
                Err(_) => return Err("announcement_storage".into()),
            };
            let mut bytes = Vec::new();
            file.take(MAX_SAVED_BYTES + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| "announcement_storage".to_owned())?;
            if bytes.len() as u64 > MAX_SAVED_BYTES {
                return Err("announcement_storage_limit".into());
            }
            let saved: Saved = serde_json::from_slice(&bytes)
                .map_err(|_| "announcement_storage_corrupt".to_owned())?;
            if saved.schema_version != 1
                || saved.shown.len() > MAX_SHOWN
                || saved.shown.iter().any(|id| !valid_id(id))
                || saved.etag.as_ref().is_some_and(|v| !valid_etag(v))
            {
                return Err("announcement_storage_corrupt".into());
            }
            if let Some(feed) = &saved.feed {
                feed.validate()?;
            }
            Ok(saved)
        };
        match read() {
            Ok(saved) => state.saved = saved,
            Err(error) => {
                // Preserve damaged records; never silently forget seen IDs or
                // prevent the karaoke Host from starting.
                state.storage_error = true;
                state.error = Some(error);
            }
        }
        state
    }

    pub(crate) fn fresh(&self, now: i64) -> bool {
        self.last_attempt
            .is_some_and(|at| at.elapsed() < Duration::from_secs(CACHE_SECONDS as u64))
            || (self.saved.feed.is_some()
                && (0..CACHE_SECONDS).contains(&now.saturating_sub(self.saved.checked_at)))
    }

    pub(crate) fn etag(&self) -> Option<String> {
        self.saved.feed.as_ref().and(self.saved.etag.clone())
    }

    pub(crate) fn finish(&mut self, directory: &Path, result: Result<Refresh, String>, now: i64) {
        self.last_attempt = Some(Instant::now());
        let refresh = match result {
            Ok(refresh) => refresh,
            Err(error) => {
                self.error = Some(error);
                return;
            }
        };
        let mut next = self.saved.clone();
        if let Refresh::Changed { feed, etag } = refresh {
            next.feed = Some(feed);
            next.etag = etag;
        }
        next.checked_at = now;
        if !self.storage_error {
            if let Err(error) = save(directory, &next) {
                self.error = Some(error);
                self.storage_error = true;
            } else {
                self.error = None;
            }
        }
        // A fresh feed can still be opened manually when local storage is
        // unavailable, but no automatic popup can promise once-only semantics.
        self.saved = next;
    }

    pub(crate) fn snapshot(&self, now: i64) -> Value {
        let mut items = Vec::new();
        let mut automatic = Vec::new();
        if let Some(feed) = &self.saved.feed {
            let entries: Vec<_> = feed
                .announcements
                .iter()
                .filter_map(|item| item.policy().ok())
                .collect();
            let plan = policy::plan(
                &entries,
                &self.version,
                &self.platform,
                now,
                &self.saved.shown,
            );
            if !self.storage_error {
                automatic = plan
                    .automatic
                    .iter()
                    .map(|index| feed.announcements[*index].id.clone())
                    .collect();
            }
            for entry in plan.history {
                let mut item = serde_json::to_value(&feed.announcements[entry.index])
                    .expect("typed announcement JSON");
                item["expired"] = json!(entry.expired);
                item["unseen"] = json!(entry.unseen);
                items.push(item);
            }
        }
        json!({"items":items,"automatic_ids":automatic,"available":self.saved.feed.is_some(),
            "error":self.error,"storage_error":self.storage_error,"checked_at":self.saved.checked_at,
            "installed_version":self.version,"platform":self.platform})
    }

    pub(crate) fn shown(&mut self, directory: &Path, ids: &[String]) -> Result<(), String> {
        if self.storage_error {
            return Err("announcement_storage".into());
        }
        if ids.len() > 128 || ids.iter().any(|id| !valid_id(id)) {
            return Err("announcement_ids".into());
        }
        let mut next = self.saved.clone();
        // Authenticated Host acknowledgements can arrive after another check
        // replaces/archives the feed. Preserve that displayed batch's IDs too;
        // requiring membership in the newest feed would lose seen records.
        next.shown.extend(ids.iter().cloned());
        if next.shown.len() > MAX_SHOWN {
            self.storage_error = true;
            self.error = Some("announcement_shown_limit".into());
            return Err("announcement_shown_limit".into());
        }
        if next.shown == self.saved.shown {
            return Ok(());
        }
        if let Err(error) = save(directory, &next) {
            self.storage_error = true;
            self.error = Some(error.clone());
            return Err(error);
        }
        self.saved = next;
        Ok(())
    }
}

pub(crate) enum Refresh {
    Changed { feed: Feed, etag: Option<String> },
    Unchanged,
}

fn valid_etag(value: &str) -> bool {
    value.len() <= 256 && reqwest::header::HeaderValue::from_str(value).is_ok()
}

pub(crate) fn fetch(etag: Option<&str>) -> Result<Refresh, String> {
    fetch_from(FEED_URL, etag)
}

fn fetch_from(url: &str, etag: Option<&str>) -> Result<Refresh, String> {
    let builder = crate::http_client::builder();
    #[cfg(test)]
    let builder = builder.no_proxy();
    let client = builder
        .connect_timeout(Duration::from_secs(4))
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("bilikara-announcements/1")
        .build()
        .map_err(|_| "announcement_transport".to_owned())?;
    let mut request = client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json");
    if let Some(etag) = etag {
        request = request.header(reqwest::header::IF_NONE_MATCH, etag);
    }
    let response = request
        .send()
        .map_err(|_| "announcement_network".to_owned())?;
    if response.status() == reqwest::StatusCode::NOT_MODIFIED && etag.is_some() {
        return Ok(Refresh::Unchanged);
    }
    if response.status() != reqwest::StatusCode::OK {
        return Err(format!("announcement_http_{}", response.status().as_u16()));
    }
    let etag = response
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|v| v.to_str().ok())
        .filter(|v| valid_etag(v))
        .map(str::to_owned);
    let mut bytes = Vec::new();
    response
        .take((MAX_FEED_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "announcement_network".to_owned())?;
    Ok(Refresh::Changed {
        feed: parse(&bytes)?,
        etag,
    })
}

#[cfg(test)]
mod tests;
