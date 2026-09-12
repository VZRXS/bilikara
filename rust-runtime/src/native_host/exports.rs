//! Read-only export projection from authoritative AppState. Android owns text /
//! image rendering and the system save dialog, not record selection or ordering.
use super::*;
use crate::app_state::{HistoryEntry, SessionPlayedEntry};
use serde::Serialize;
use std::{
    pin::Pin,
    task::{Context, Poll},
};

const MAX_ROWS: usize = 10_000;
const MAX_BYTES: u64 = 64 * 1024 * 1024;

pub(super) fn clean_stale(directory: &Path) -> Result<(), ApiError> {
    let root = directory.join("remote-exports");
    if !root.exists() {
        return Ok(());
    }
    if root.canonicalize().map_err(|_| export_failed())?.parent() != Some(directory) {
        return Err(export_failed());
    }
    for entry in std::fs::read_dir(root).map_err(|_| export_failed())? {
        let entry = entry.map_err(|_| export_failed())?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let owned = name
            .strip_prefix("remote-export-")
            .and_then(|s| s.strip_suffix(".tmp"))
            .is_some_and(|s| {
                s.len() == 43
                    && s.bytes()
                        .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
            });
        if owned && entry.file_type().map_err(|_| export_failed())?.is_file() {
            std::fs::remove_file(entry.path()).map_err(|_| export_failed())?;
        }
    }
    Ok(())
}

#[derive(Serialize)]
struct ExportRow {
    title: String,
    bvid: String,
    requester: String,
    owner: String,
    owner_mid: i64,
    count: u64,
    at: f64,
    url: String,
    original_url: String,
    part: String,
}

fn title(display: &str, original: &str) -> String {
    if display.is_empty() {
        original
    } else {
        display
    }
    .into()
}

fn project(
    history: &[HistoryEntry],
    played: &[SessionPlayedEntry],
    source: &str,
) -> Result<Vec<ExportRow>, ApiError> {
    let mut rows: Vec<ExportRow> = match source {
        "history" => {
            let bvid = regex::Regex::new(r"BV[0-9A-Za-z]{10}").expect("constant BV pattern");
            history
                .iter()
                .map(|item| ExportRow {
                    title: title(&item.display_title, &item.title),
                    bvid: [&item.resolved_url, &item.original_url, &item.key]
                        .into_iter()
                        .find_map(|s| bvid.find(s).map(|m| m.as_str().to_owned()))
                        .unwrap_or_default(),
                    requester: item.requester_name.clone(),
                    owner: item.owner_name.clone(),
                    owner_mid: item.owner_mid,
                    count: item.request_count.max(1),
                    at: item.requested_at,
                    url: item.resolved_url.clone(),
                    original_url: item.original_url.clone(),
                    part: item.part_title.clone(),
                })
                .collect()
        }
        "played" => played
            .iter()
            .map(|item| ExportRow {
                title: title(&item.display_title, &item.title),
                bvid: item.bvid.clone(),
                requester: item.requester_name.clone(),
                owner: item.owner_name.clone(),
                owner_mid: item.owner_mid,
                count: 1,
                at: item.played_at,
                url: item.resolved_url.clone(),
                original_url: item.original_url.clone(),
                part: item.part_title.clone(),
            })
            .collect(),
        _ => return Err(ApiError::invalid("请选择本场记录、全部历史或有效的旧场次")),
    };
    // Match desktop export: chronological, stable on equal timestamps, missing
    // timestamps last. Do not mutate/reorder AppState or merge separate plays.
    rows.sort_by(|a, b| match (a.at > 0.0, b.at > 0.0) {
        (true, true) => a.at.total_cmp(&b.at),
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        (false, false) => std::cmp::Ordering::Equal,
    });
    Ok(rows)
}

pub(super) fn snapshot(identity: &Identity, query: &str) -> Result<Value, ApiError> {
    let source = library::query_value(query, "source");
    with_app(|app| {
        app.native_authorize(identity, true)?;
        let (revision, rows) = selected_rows(app, &source)?;
        encode(revision, &source, rows)
    })
}

fn archive_id(archive: &crate::SessionArchiveSeed) -> String {
    if archive.file_name.starts_with("played-") {
        archive.file_name.clone()
    } else {
        format!("played-{}", archive.file_name)
    }
}

fn valid_source(source: &str) -> bool {
    ["played", "history"].contains(&source)
        || regex::Regex::new(r"^played-[A-Za-z0-9._-]{1,128}\.json$")
            .unwrap()
            .is_match(source)
}

fn selected_rows(
    app: &crate::app_state::AppState,
    source: &str,
) -> Result<(u64, Vec<ExportRow>), ApiError> {
    if !valid_source(source) {
        return Err(ApiError::invalid("无效的导出场次"));
    }
    let snapshot = app.native_core_snapshot()?;
    let rows = if ["played", "history"].contains(&source) {
        project(&snapshot.history, &snapshot.session_played, source)?
    } else {
        let archive = app
            .native_session_archives()
            .into_iter()
            .find(|archive| archive_id(archive) == source)
            .ok_or_else(|| ApiError::new(404, "session_not_found", "旧场次不存在"))?;
        project(&[], &archive.items, "played")?
    };
    Ok((snapshot.revision, rows))
}

pub(super) fn sessions(identity: &Identity) -> Result<Value, ApiError> {
    let mut archives = with_app(|app| {
        app.native_authorize(identity, true)?;
        Ok(app.native_session_archives())
    })?;
    archives.sort_by(|a, b| b.session_started_at.total_cmp(&a.session_started_at));
    Ok(json!(archives.iter().map(|archive| json!({
        "id":archive_id(archive), "started_at":archive.session_started_at, "count":archive.items.len()
    })).collect::<Vec<_>>()))
}

fn encode(revision: u64, source: &str, rows: Vec<ExportRow>) -> Result<Value, ApiError> {
    if rows.len() > MAX_ROWS {
        return Err(ApiError::new(
            413,
            "export_too_large",
            "导出记录过多，请选择本场记录",
        ));
    }
    let result = json!({"schema_version":1,"revision":revision,"source":source,"rows":rows});
    if result.to_string().len() > 16 * 1024 * 1024 {
        return Err(ApiError::new(
            413,
            "export_too_large",
            "导出记录过大，请选择本场记录",
        ));
    }
    Ok(result)
}

struct Options {
    format: String,
    source: String,
    page_size: usize,
}
impl Options {
    fn parse(query: &str) -> Result<Self, ApiError> {
        let format = library::query_value(query, "format");
        let source = library::query_value(query, "source");
        let page_size = library::query_number(query, "page_size", 200, 200)?;
        if !["csv", "image"].contains(&format.as_str())
            || !valid_source(&source)
            || ![50, 60, 80, 100, 150, 200].contains(&page_size)
        {
            return Err(ApiError::invalid(
                "无效的导出选项；请选择本场记录、全部历史或有效的旧场次",
            ));
        }
        Ok(Self {
            format,
            source,
            page_size,
        })
    }
    fn file_type(&self, rows: usize) -> (&'static str, &'static str) {
        if self.format == "csv" {
            ("text/csv; charset=utf-8", "csv")
        } else if rows <= self.page_size {
            ("image/png", "png")
        } else {
            ("application/zip", "zip")
        }
    }
}

// Dedicated private scratch directory, never part of /media or static assets.
// Its RAII guard removes partial files on renderer failure/disconnect, too.
struct Scratch(PathBuf);
impl Scratch {
    fn create(directory: &Path) -> Result<Self, ApiError> {
        let root = directory.join("remote-exports");
        std::fs::create_dir_all(&root).map_err(|_| export_failed())?;
        let canonical = root.canonicalize().map_err(|_| export_failed())?;
        if canonical.parent() != Some(directory) {
            return Err(export_failed());
        }
        let path = canonical.join(format!("remote-export-{}.tmp", token()?));
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|_| export_failed())?;
        Ok(Self(path))
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
struct DownloadReader {
    // Field order closes the file before removing it (also needed on Windows).
    reader: tokio::fs::File,
    _scratch: Scratch,
    _permit: tokio::sync::OwnedSemaphorePermit,
}
impl tokio::io::AsyncRead for DownloadReader {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut tokio::io::ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.reader).poll_read(cx, buffer)
    }
}
fn export_failed() -> ApiError {
    ApiError::new(
        503,
        "export_failed",
        "导出失败，请减少每页歌曲数或改用 CSV 后重试",
    )
}

pub(super) async fn download(
    context: Arc<HostContext>,
    identity: Identity,
    query: String,
) -> Result<Response, ApiError> {
    with_app(|app| {
        app.native_requester(&identity, "")?;
        Ok(())
    })?;
    let options = Options::parse(&query)?;
    let renderer = context
        .export_renderer
        .get()
        .cloned()
        .ok_or_else(|| ApiError::new(501, "export_unavailable", "此 Host 尚未就绪原生导出"))?;
    let permit = context
        .export_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError::new(429, "export_busy", "另一项导出正在进行，请稍后重试"))?;
    let (scratch, permit, mime, filename, length) = tokio::task::spawn_blocking(move || {
        let (revision, rows) = with_app(|app| {
            app.native_requester(&identity, "")?;
            if !["played", "history"].contains(&options.source.as_str()) { app.native_authorize(&identity, true)?; }
            selected_rows(app, &options.source)
        })?;
        let (mime, extension) = options.file_type(rows.len());
        let data = encode(revision, &options.source, rows)?;
        let spec = json!({"format":options.format,"source":options.source,"pageSize":options.page_size,"data":data}).to_string();
        let scratch = Scratch::create(&context.directory)?;
        renderer(&spec, &scratch.0).map_err(|_| export_failed())?;
        let metadata = std::fs::symlink_metadata(&scratch.0).map_err(|_| export_failed())?;
        if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_BYTES { return Err(export_failed()); }
        let filename = format!("bilikara-{}-{}.{}", options.source, (now() * 1000.0) as u64, extension);
        Ok((scratch, permit, mime, filename, metadata.len()))
    }).await.map_err(|_| export_failed())??;
    let reader = tokio::fs::File::open(&scratch.0)
        .await
        .map_err(|_| export_failed())?;
    let mut response = Body::from_stream(tokio_util::io::ReaderStream::with_capacity(
        DownloadReader {
            reader,
            _scratch: scratch,
            _permit: permit,
        },
        64 * 1024,
    ))
    .into_response();
    let headers = response.headers_mut();
    headers.insert("content-type", mime.parse().unwrap());
    headers.insert("content-length", length.to_string().parse().unwrap());
    headers.insert(
        "content-disposition",
        format!("attachment; filename=\"{filename}\"")
            .parse()
            .unwrap(),
    );
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_exports_bound_options_and_clean_only_owned_scratch_files() {
        for query in [
            "format=exe&source=played",
            "format=image&source=../host-state.json",
            "format=image&source=history&page_size=1",
        ] {
            assert!(Options::parse(query).is_err());
        }
        let options = Options::parse("format=image&source=history&page_size=50").unwrap();
        assert_eq!(options.file_type(50).1, "png");
        assert_eq!(options.file_type(51).1, "zip");
        let directory = std::env::temp_dir().join(format!("export-scratch-{}", token().unwrap()));
        std::fs::create_dir_all(&directory).unwrap();
        let directory = directory.canonicalize().unwrap();
        let scratch = Scratch::create(&directory).unwrap();
        let path = scratch.0.clone();
        assert!(path.exists());
        drop(scratch);
        assert!(!path.exists());
        let scratch = Scratch::create(&directory).unwrap();
        let unknown = directory.join("remote-exports/keep.txt");
        std::fs::write(&unknown, b"not ours").unwrap();
        clean_stale(&directory).unwrap();
        assert!(!scratch.0.exists());
        assert!(unknown.exists());
        drop(scratch);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn exports_keep_sources_counts_stable_order_and_only_public_record_fields() {
        let entry = |key: &str, at| {
            serde_json::from_value::<HistoryEntry>(json!({
            "key":key,"display_title":key,"original_url":"https://b23.tv/test",
            "resolved_url":"https://www.bilibili.com/video/BV1z84y1p7oS","requested_at":at,"request_count":3
        })).unwrap()
        };
        let history = vec![
            entry("later", 20.0),
            entry("first", 10.0),
            entry("same", 10.0),
            entry("unknown", 0.0),
        ];
        let rows = project(&history, &[], "history").unwrap();
        assert_eq!(
            rows.iter().map(|r| r.title.as_str()).collect::<Vec<_>>(),
            ["first", "same", "later", "unknown"]
        );
        assert_eq!(rows[0].count, 3);
        assert_eq!(rows[0].bvid, "BV1z84y1p7oS");
        assert!(project(&history, &[], "played").unwrap().is_empty());
        assert!(project(&history, &[], "../host-state.json").is_err());
        assert_eq!(history[0].key, "later");
        let encoded = serde_json::to_value(rows).unwrap();
        assert!(encoded[0].get("key").is_none());
        assert!(encoded[0].get("cookie").is_none());
    }
}
