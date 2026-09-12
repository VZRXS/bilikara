//! Complete stateless export service. Rendering never acquires AppState's lock.
use bilikara_rust::playlist_export::{ExportEntry, PROJECT_URL, ordered_entries, valid_time};
use chrono::{DateTime, Local, TimeZone};
use std::io::{Cursor, Write};
use std::path::PathBuf;
use zip::{ZipWriter, write::SimpleFileOptions};

mod render;
mod wire;
pub use render::prewarm_fonts;
pub(crate) use wire::execute_export_wire;

#[derive(Debug, serde::Serialize)]
pub struct ExportError {
    pub kind: &'static str,
    pub message: String,
}
impl ExportError {
    pub(crate) fn new(kind: &'static str, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

pub struct ImageExportRequest {
    pub entries: Vec<ExportEntry>,
    pub font_path: PathBuf,
    pub title: String,
    pub page_size: usize,
    pub app_version: String,
}

pub struct ExportArtifact {
    pub bytes: Vec<u8>,
    pub mime_type: &'static str,
    pub filename: &'static str,
    pub missing_glyphs: Vec<String>,
}

fn local_time(timestamp: f64) -> Result<DateTime<Local>, ExportError> {
    if !timestamp.is_finite()
        || timestamp.floor() < i64::MIN as f64
        || timestamp.floor() >= i64::MAX as f64
    {
        return Err(ExportError::new(
            "invalid_time",
            "Export timestamp is outside the supported range",
        ));
    }
    Local
        .timestamp_opt(timestamp.floor() as i64, 0)
        .single()
        .ok_or_else(|| {
            ExportError::new(
                "invalid_time",
                "Cannot convert export timestamp to local time",
            )
        })
}

fn format_time(timestamp: Option<f64>, short: bool) -> Result<String, ExportError> {
    valid_time(timestamp)
        .map(|time| {
            local_time(time).map(|time| {
                time.format(if short {
                    "%m-%d %H:%M"
                } else {
                    "%Y-%m-%d %H:%M:%S"
                })
                .to_string()
            })
        })
        .unwrap_or_else(|| Ok(String::new()))
}

fn time_range(entries: &[&ExportEntry]) -> Result<String, ExportError> {
    let mut times = entries.iter().filter_map(|e| e.timestamp);
    let Some(first) = times.next() else {
        return Ok(Local::now().format("%Y-%m-%d %H:%M").to_string());
    };
    let (mut min, mut max) = (first, first);
    for time in times {
        min = min.min(time);
        max = max.max(time);
    }
    let (start, end) = (local_time(min)?, local_time(max)?);
    Ok(format!(
        "{} ~ {}",
        start.format("%Y-%m-%d %H:%M"),
        end.format(if start.date_naive() == end.date_naive() {
            "%H:%M"
        } else {
            "%Y-%m-%d %H:%M"
        })
    ))
}

pub fn export_csv(
    entries: &[ExportEntry],
    time_header: &str,
) -> Result<ExportArtifact, ExportError> {
    let mut writer = csv::WriterBuilder::new()
        .terminator(csv::Terminator::CRLF)
        .from_writer(vec![0xef, 0xbb, 0xbf]);
    let headers = [
        "序号",
        "标题",
        "BV 号",
        "点歌人",
        "UP 主",
        "UP 主 UID",
        "点歌次数",
        time_header,
        "视频链接",
        "原始链接",
        "分P/版本",
    ];
    let error = |_| ExportError::new("encoding_failed", "CSV encoding failed");
    writer.write_record(headers).map_err(error)?;
    for (index, entry) in ordered_entries(entries).into_iter().enumerate() {
        let mut fields = entry.csv_fields(index + 1, format_time(entry.timestamp, false)?);
        // DictWriter historically uses the time label as a dictionary key. Keep
        // even a caller-supplied label that collides with another column.
        for (i, header) in headers.iter().enumerate() {
            if i != 7 && *header == time_header {
                fields[i] = fields[7].clone();
            }
        }
        writer.write_record(fields).map_err(error)?;
    }
    let bytes = writer
        .into_inner()
        .map_err(|_| ExportError::new("encoding_failed", "CSV encoding failed"))?;
    Ok(ExportArtifact {
        bytes,
        mime_type: "text/csv; charset=utf-8",
        filename: "bilikara-playlist.csv",
        missing_glyphs: vec![],
    })
}

pub fn export_image(request: &ImageExportRequest) -> Result<ExportArtifact, ExportError> {
    let entries = ordered_entries(&request.entries);
    let size = request.page_size.max(1);
    let count = entries.len().max(1).div_ceil(size);
    let range = time_range(&entries)?;
    let fonts = render::font_resources(&request.font_path)?;
    let mut missing = std::collections::BTreeSet::new();
    // Only one uncompressed page is alive; each is encoded and dropped before
    // the next page. The ZIP retains compressed bytes only.
    let mut archive = ZipWriter::new(Cursor::new(Vec::new()));
    for page in 0..count {
        let start = page * size;
        let end = start.saturating_add(size).min(entries.len());
        let image = render::render_page(
            &entries[start..end],
            request,
            page + 1,
            count,
            start,
            &range,
            &fonts,
            &mut missing,
        )?;
        let bytes = image.encode()?;
        if count == 1 {
            return Ok(ExportArtifact {
                bytes,
                mime_type: "image/png",
                filename: "bilikara-playlist.png",
                missing_glyphs: missing.into_iter().collect(),
            });
        }
        archive
            .start_file(
                format!("bilikara-playlist-page-{:02}.png", page + 1),
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated),
            )
            .map_err(|_| ExportError::new("encoding_failed", "Export ZIP entry creation failed"))?;
        archive
            .write_all(&bytes)
            .map_err(|_| ExportError::new("encoding_failed", "Export ZIP write failed"))?;
    }
    let bytes = archive
        .finish()
        .map_err(|_| ExportError::new("encoding_failed", "Export ZIP finalization failed"))?
        .into_inner();
    Ok(ExportArtifact {
        bytes,
        mime_type: "application/zip",
        filename: "bilikara-playlist-images.zip",
        missing_glyphs: missing.into_iter().collect(),
    })
}
