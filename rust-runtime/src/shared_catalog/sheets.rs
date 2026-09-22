//! Public gid=0 GViz CSV, verified from the user-supplied catalog spreadsheet.
//! No script evaluation, authentication, writeback, or privileged fallback.
use super::*;
use std::{io::Read, sync::Arc};

pub(super) const URL: &str = "https://docs.google.com/spreadsheets/d/18IFzVZh7HhxgcKJP-1qzodFzBsJ4AXoF4ZA6lWSSvOk/gviz/tq?gid=0&tqx=out:csv";
const TTL: Duration = Duration::from_secs(60);
// Snapshot downloads have a separate budget from the short D1 keyword read.
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_BYTES: usize = 32 * 1024 * 1024;
const MAX_ROWS: usize = 100_000;

#[derive(Debug, Default)]
pub(super) struct SnapshotState {
    pub(super) snapshot: Option<(String, Instant, Arc<Vec<Value>>)>,
    inflight: bool,
    backoff: Option<(String, Instant)>,
}

pub(super) fn endpoint(request: &CatalogRequest) -> Option<String> {
    match request.sheets_url.as_deref() {
        Some("") => None,
        Some(url) => Some(url.into()),
        None if request.base_url.trim_end_matches('/') == DEFAULT_API_URL => Some(URL.into()),
        None => None, // Custom D1 installations do not inherit another catalog.
    }
}
fn unavailable() -> CatalogError {
    CatalogError::new(
        503,
        "catalog_providers_unavailable",
        "D1 and the read-only Sheets catalog are unavailable",
    )
}

pub(super) fn fetch(endpoint: &str, request: &CatalogRequest) -> Result<Vec<Value>, CatalogError> {
    let url = url::Url::parse(endpoint).map_err(|_| unavailable())?;
    let loopback = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    if (!loopback && endpoint != URL)
        || !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(unavailable());
    }
    let client = crate::http_client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(SNAPSHOT_TIMEOUT)
        .build()
        .map_err(|_| unavailable())?;
    let response = client
        .get(url)
        .header("Accept", "text/csv")
        .header("User-Agent", &request.user_agent)
        .send()
        .map_err(|_| unavailable())?;
    if response.status() != reqwest::StatusCode::OK
        || response
            .content_length()
            .is_some_and(|n| n > MAX_BYTES as u64)
        || !response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| {
                v.split(';')
                    .next()
                    .unwrap_or("")
                    .trim()
                    .eq_ignore_ascii_case("text/csv")
            })
    {
        // In particular never read an authentication/HTML response body.
        return Err(unavailable());
    }
    let mut bytes = Vec::new();
    response
        .take((MAX_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| unavailable())?;
    parse(&bytes)
}

pub(super) fn parse(bytes: &[u8]) -> Result<Vec<Value>, CatalogError> {
    if bytes.len() > MAX_BYTES {
        return Err(unavailable());
    }
    let text = std::str::from_utf8(bytes)
        .map_err(|_| unavailable())?
        .trim_start_matches('\u{feff}');
    // csv follows RFC-style quoting permissively; check quote boundaries first
    // so truncated snapshots and stray quotes cannot become a partial success.
    validate_quotes(text)?;
    let mut reader = csv::ReaderBuilder::new()
        .flexible(false)
        .from_reader(text.as_bytes());
    let headers = reader.headers().map_err(|_| unavailable())?.clone();
    let mut names = HashSet::new();
    if headers.iter().any(|h| !names.insert(h))
        || !["bvid", "title", "url", "mid", "owner_name"]
            .iter()
            .all(|h| names.contains(h))
    {
        return Err(unavailable());
    }
    let mut items = Vec::new();
    let mut seen = HashSet::new();
    for (index, record) in reader.records().enumerate() {
        if index >= MAX_ROWS {
            return Err(unavailable());
        }
        let record = record.map_err(|_| unavailable())?;
        if record.iter().any(|field| field.len() > 64 * 1024) {
            return Err(unavailable());
        }
        let raw: serde_json::Map<String, Value> = headers
            .iter()
            .zip(record.iter())
            .map(|(key, value)| (key.into(), json!(value)))
            .collect();
        if let Some(mut item) = read::normalize_item(&Value::Object(raw))
            && seen.insert(item["bvid"].as_str().unwrap().to_owned())
        {
            item["source"] = json!("sheets");
            items.push(item);
        }
    }
    Ok(items)
}

fn validate_quotes(text: &str) -> Result<(), CatalogError> {
    // 0=start of field, 1=unquoted, 2=quoted, 3=after closing quote.
    let mut state = 0;
    for b in text.bytes() {
        state = match (state, b) {
            (0, b'"') => 2,
            (0 | 1 | 3, b',' | b'\r' | b'\n') => 0,
            (1, b'"') => return Err(unavailable()),
            (0 | 1, _) => 1,
            (2, b'"') => 3,
            (2, _) => 2,
            (3, b'"') => 2,
            _ => return Err(unavailable()),
        };
    }
    if state == 2 {
        return Err(unavailable());
    }
    Ok(())
}

struct Refresh;
impl Drop for Refresh {
    fn drop(&mut self) {
        let _ = with_catalog(|state| {
            state.sheets.inflight = false;
            Ok(())
        });
    }
}

pub(super) fn search(
    request: &CatalogRequest,
    query: &str,
    endpoint: &str,
    fetch: &impl Fn(&str, &CatalogRequest) -> Result<Vec<Value>, CatalogError>,
) -> Result<Value, CatalogError> {
    let key = format!("{}\n{endpoint}", request.base_url);
    let (snapshot, generation) = with_catalog(|state| {
        let now = Instant::now();
        if state.exclusions_full {
            return Err(unavailable());
        }
        if let Some((k, at, rows)) = &state.sheets.snapshot
            && k == &key
            && now.duration_since(*at) < TTL
        {
            return Ok((Some(Arc::clone(rows)), state.generation));
        }
        state.sheets.snapshot = None; // Never serve expired rows on refresh failure.
        if state
            .sheets
            .backoff
            .as_ref()
            .is_some_and(|(k, until)| k == &key && *until > now)
        {
            return Err(unavailable());
        }
        if state.sheets.inflight {
            return Err(CatalogError::new(
                429,
                "catalog_busy",
                "Catalog snapshot refresh in flight",
            ));
        }
        state.sheets.inflight = true;
        Ok((None, state.generation))
    })?;
    let rows = if let Some(snapshot) = snapshot {
        snapshot
    } else {
        let _refresh = Refresh;
        // Fetch, parse, normalize and allocate outside AppState's mutex.
        let result = fetch(endpoint, request).map(Arc::new);
        with_catalog(|state| {
            if state.generation != generation {
                return Err(CatalogError::new(
                    409,
                    "catalog_changed",
                    "Catalog changed; retry the read",
                ));
            }
            match &result {
                Ok(rows) => {
                    state.sheets.snapshot = Some((key, Instant::now(), Arc::clone(rows)));
                    state.sheets.backoff = None;
                }
                Err(_) => {
                    state.sheets.backoff = Some((key, Instant::now() + Duration::from_secs(30)))
                }
            }
            Ok(())
        })?;
        result?
    };
    let exclusions = with_catalog(|state| Ok(state.exclusions.clone()))?;
    let keyword = query_value(query, "q").to_lowercase();
    let tokens: Vec<_> = keyword.split_whitespace().collect();
    let limit = query_number(query, "limit", 80, 500)?.clamp(1, 100);
    let offset = query_number(query, "offset", 0, 100_000)?;
    let matches: Vec<_> = rows
        .iter()
        .filter(|item| {
            !["bvid", "mid"].iter().any(|field| {
                exclusions.contains(&(
                    request.base_url.clone(),
                    (*field).into(),
                    item[*field].as_str().unwrap_or("").into(),
                ))
            })
        })
        .filter(|item| {
            let searchable = [
                "bvid",
                "title",
                "mid",
                "owner_name",
                "tag_1",
                "tag_2",
                "tag_3",
                "tag_4",
                "tag_5",
            ]
            .iter()
            .filter_map(|field| item[*field].as_str())
            .collect::<Vec<_>>()
            .join(" ")
            .to_lowercase();
            tokens.iter().all(|token| searchable.contains(token))
        })
        .collect();
    let matched_count = matches.len();
    let items: Vec<_> = matches
        .into_iter()
        .skip(offset)
        .take(limit)
        .cloned()
        .collect();
    with_catalog(|state| {
        if state.generation != generation || state.exclusions_full {
            return Err(CatalogError::new(
                409,
                "catalog_changed",
                "Catalog changed; retry the read",
            ));
        }
        Ok(())
    })?;
    let next_offset = offset + items.len();
    let has_more = next_offset < matched_count;
    // Exclusions made elsewhere cannot be inferred from this public snapshot.
    Ok(
        json!({"items":items,"matched_count":matched_count,"offset":offset,"next_offset":next_offset,"has_more":has_more,"source":"sheets","snapshot_max_age_seconds":60,
        "exclusion_coverage":"process_local_only; upstream_snapshot_sync_unverified"}),
    )
}

pub(super) fn exclude(
    request: &CatalogRequest,
    field: &str,
    value: &str,
) -> Result<(), CatalogError> {
    with_catalog(|state| {
        if state.exclusions.len() >= 10_000 {
            state.exclusions_full = true;
        } else {
            state
                .exclusions
                .insert((request.base_url.clone(), field.into(), value.into()));
        }
        state.generation = state.generation.wrapping_add(1);
        Ok(())
    })
}
