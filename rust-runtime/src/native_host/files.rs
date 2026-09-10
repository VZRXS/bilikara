use super::*;
use std::path::{Component, PathBuf};
use std::{
    pin::Pin,
    task::{Context, Poll},
};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

struct MediaLease(String);
impl Drop for MediaLease {
    fn drop(&mut self) {
        let _ = with_app(|app| {
            app.native_unpin_media(&self.0);
            Ok(())
        });
    }
}
struct LeasedReader {
    reader: tokio::io::Take<tokio::fs::File>,
    _lease: MediaLease,
}
impl tokio::io::AsyncRead for LeasedReader {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut tokio::io::ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.reader).poll_read(cx, buffer)
    }
}

fn safe_relative(value: &str) -> Option<PathBuf> {
    if value.is_empty() || value.contains(['\\', '%', '\0']) || value.starts_with('/') {
        return None;
    }
    let path = PathBuf::from(value);
    if !path
        .components()
        .all(|part| matches!(part,Component::Normal(p) if !p.to_string_lossy().starts_with('.')))
    {
        return None;
    }
    Some(path)
}
pub(super) fn asset(context: &HostContext, path: &str, head: bool) -> Result<Response, ApiError> {
    let relative = match path {
        "/" => "index.html",
        "/remote" | "/remote/" => "remote.html",
        _ => path.trim_start_matches('/'),
    };
    safe_relative(relative).ok_or_else(|| ApiError::new(404, "not_found", "资源不存在"))?;
    let mut asset =
        (context.assets)(relative).ok_or_else(|| ApiError::new(404, "not_found", "资源不存在"))?;
    if matches!(relative, "index.html" | "remote.html") {
        let html = String::from_utf8(asset.bytes).map_err(|_| ApiError::invalid("页面编码无效"))?;
        // This marker comes from the native server, not from query parameters.
        // Reuse the shared UI without exposing desktop IPC or starting signaling.
        asset.bytes = html
            .replacen("<html ", "<html data-native-host=\"true\" ", 1)
            .replace(
                "<script src=\"/internet-remote-host.js\" defer></script>",
                "",
            )
            .into_bytes();
    }
    let length = asset.bytes.len();
    let mut response = Body::from(if head { Vec::new() } else { asset.bytes }).into_response();
    response.headers_mut().insert(
        "content-type",
        asset
            .mime
            .parse()
            .map_err(|_| ApiError::invalid("资源类型无效"))?,
    );
    response
        .headers_mut()
        .insert("content-length", length.to_string().parse().unwrap());
    // No inline scripts, remote scripts, embedding, or generic network proxy.
    response.headers_mut().insert("content-security-policy","default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.hdslb.com https://*.bilibili.com; media-src 'self' blob:; connect-src 'self'; font-src 'self' data:; object-src 'none'; frame-src 'none'; base-uri 'self'".parse().unwrap());
    Ok(response)
}

/// Inclusive byte range. A malformed/multipart/unsatisfiable range is rejected;
/// the media file is streamed, never read in full for a seek request.
fn byte_range(value: Option<&str>, length: u64) -> Result<(u64, u64, bool), ApiError> {
    if length == 0 {
        return Err(ApiError::new(416, "range", "空媒体文件"));
    }
    let Some(value) = value else {
        return Ok((0, length - 1, false));
    };
    let invalid = || ApiError::new(416, "range", "不支持此媒体范围");
    let (start, end) = value
        .strip_prefix("bytes=")
        .and_then(|v| v.split_once('-'))
        .ok_or_else(invalid)?;
    if start.is_empty() {
        let suffix = end
            .parse::<u64>()
            .ok()
            .filter(|v| *v > 0)
            .ok_or_else(invalid)?;
        return Ok((length.saturating_sub(suffix), length - 1, true));
    }
    let start = start.parse::<u64>().map_err(|_| invalid())?;
    let end = if end.is_empty() {
        length - 1
    } else {
        end.parse::<u64>().map_err(|_| invalid())?.min(length - 1)
    };
    if start >= length || end < start {
        return Err(invalid());
    }
    Ok((start, end, true))
}

pub(super) async fn media(
    context: &HostContext,
    path: &str,
    headers: &HeaderMap,
    head: bool,
) -> Result<Response, ApiError> {
    let relative = path
        .strip_prefix("/media/")
        .and_then(safe_relative)
        .ok_or_else(|| ApiError::new(404, "not_found", "媒体不存在"))?;
    if !relative.starts_with("artifacts") {
        return Err(ApiError::new(404, "not_found", "媒体不存在"));
    }
    let route = path.to_owned();
    with_app(|app| app.native_pin_media(&route))?;
    // Released on every early error/HEAD and when the streaming body is dropped.
    let lease = MediaLease(route);
    let root = context
        .cache_root
        .canonicalize()
        .map_err(|_| ApiError::new(404, "not_found", "缓存目录不存在"))?;
    let file_path = context
        .cache_root
        .join(relative)
        .canonicalize()
        .map_err(|_| ApiError::new(404, "not_found", "媒体文件不存在"))?;
    if !file_path.starts_with(root) {
        return Err(ApiError::new(404, "not_found", "媒体不存在"));
    }
    let mut file = tokio::fs::File::open(file_path)
        .await
        .map_err(|_| ApiError::new(404, "not_found", "无法读取媒体"))?;
    let metadata = file
        .metadata()
        .await
        .map_err(|_| ApiError::new(404, "not_found", "媒体不存在"))?;
    if !metadata.is_file() {
        return Err(ApiError::new(404, "not_found", "媒体不存在"));
    }
    let length = metadata.len();
    let (start, end, partial) =
        match byte_range(headers.get("range").and_then(|v| v.to_str().ok()), length) {
            Ok(range) => range,
            Err(error) => {
                let mut response = error.response();
                response.headers_mut().insert(
                    "content-range",
                    format!("bytes */{length}").parse().unwrap(),
                );
                return Ok(response);
            }
        };
    file.seek(std::io::SeekFrom::Start(start))
        .await
        .map_err(|_| ApiError::new(500, "media_seek", "媒体跳转失败"))?;
    let body = if head {
        Body::empty()
    } else {
        Body::from_stream(tokio_util::io::ReaderStream::with_capacity(
            LeasedReader {
                reader: file.take(end - start + 1),
                _lease: lease,
            },
            64 * 1024,
        ))
    };
    let mut response = body.into_response();
    *response.status_mut() = if partial {
        StatusCode::PARTIAL_CONTENT
    } else {
        StatusCode::OK
    };
    let headers = response.headers_mut();
    let mime = if path.ends_with(".flac") {
        "audio/flac"
    } else if path.ends_with(".m4a") {
        "audio/mp4"
    } else {
        "video/mp4"
    };
    headers.insert("content-type", mime.parse().unwrap());
    headers.insert("accept-ranges", "bytes".parse().unwrap());
    headers.insert(
        "content-length",
        (end - start + 1).to_string().parse().unwrap(),
    );
    if partial {
        headers.insert(
            "content-range",
            format!("bytes {start}-{end}/{length}").parse().unwrap(),
        );
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ranges_cover_android_seek_and_suffix_requests() {
        assert_eq!(byte_range(None, 100).unwrap(), (0, 99, false));
        assert_eq!(byte_range(Some("bytes=20-"), 100).unwrap(), (20, 99, true));
        assert_eq!(byte_range(Some("bytes=-10"), 100).unwrap(), (90, 99, true));
        assert_eq!(byte_range(Some("bytes=0-500"), 100).unwrap(), (0, 99, true));
        for bad in [
            "bytes=100-",
            "bytes=-0",
            "bytes=2-1",
            "bytes=1-2,5-7",
            "wat=0-1",
        ] {
            assert!(byte_range(Some(bad), 100).is_err(), "{bad}");
        }
    }
    #[test]
    fn paths_cannot_leave_bundled_assets_or_cache() {
        for bad in [
            "../host-state.json",
            "/etc/passwd",
            "artifacts/../secret",
            "artifacts/%2e%2e/x",
            "a\\..\\b",
            ".hidden",
        ] {
            assert!(safe_relative(bad).is_none(), "{bad}");
        }
        assert!(safe_relative("artifacts/i/a/video.mp4").is_some());
    }
}
