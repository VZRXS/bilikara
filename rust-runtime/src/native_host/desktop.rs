//! Desktop development entry: one Runtime/AppState, PR109 transport, P02/P03 services.
//! Legacy desktop data is read only through an explicit one-time import.
use super::*;
use crate::{AppStateRequest, AppStateSeed, execute_app_state, initialize_native_host};
use std::io::Write;

#[cfg(unix)]
static EXIT_REQUESTED: AtomicBool = AtomicBool::new(false);
#[cfg(unix)]
extern "C" fn request_exit(_: libc::c_int) {
    EXIT_REQUESTED.store(true, Ordering::Release);
}

pub(super) const MARKER: &str = ".bilikara-desktop-rust-preview";

pub(super) fn unavailable() -> ApiError {
    ApiError::new(
        501,
        "desktop_preview_unavailable",
        "Desktop Rust preview: this action is unavailable; use the default desktop product for external tools, updates and maintenance",
    )
}

/// An empty explicitly selected directory is enrolled once. Refuse any existing
/// unmarked directory, including ordinary desktop data. Storage's lock prevents
/// concurrent authorities; its checkpoint validation remains authoritative.
pub(super) fn preview_root(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("--data-dir must be an absolute isolated development directory".into());
    }
    if !path.exists() {
        std::fs::create_dir_all(path).map_err(|e| e.to_string())?;
    }
    if std::fs::symlink_metadata(path)
        .map_err(|e| e.to_string())?
        .file_type()
        .is_symlink()
    {
        return Err("Preview root must not be a symlink".into());
    }
    let path = path.canonicalize().map_err(|e| e.to_string())?;
    let marker = path.join(MARKER);
    if !marker.exists() {
        if std::fs::read_dir(&path)
            .map_err(|e| e.to_string())?
            .next()
            .is_some()
        {
            return Err(
                "Refusing nonempty unmarked directory; use --import-from with a new destination"
                    .into(),
            );
        }
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&marker)
            .and_then(|mut f| f.write_all(b"desktop-rust-preview-v1\n"))
            .map_err(|e| e.to_string())?;
    } else if !std::fs::symlink_metadata(&marker)
        .map_err(|e| e.to_string())?
        .is_file()
        || std::fs::read(&marker).map_err(|e| e.to_string())? != b"desktop-rust-preview-v1\n"
    {
        return Err("Invalid preview directory marker".into());
    }
    Ok(path)
}

pub fn asset_source(root: &Path) -> Result<AssetSource, String> {
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    for file in [
        "index.html",
        "app.js",
        "styles.css",
        "remote.html",
        "remote.js",
        "fonts/SourceHanSans-VF.ttf",
    ] {
        if !root.join(file).is_file() {
            return Err(format!("Missing shared desktop asset: {file}"));
        }
    }
    Ok(Arc::new(move |name| {
        let path = root.join(name).canonicalize().ok()?;
        if !path.starts_with(&root) {
            return None;
        }
        let mime = match path.extension()?.to_str()? {
            "html" => "text/html",
            "js" => "text/javascript",
            "css" => "text/css",
            "json" => "application/json",
            "svg" => "image/svg+xml",
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "webp" => "image/webp",
            "woff2" => "font/woff2",
            "ttf" => "font/ttf",
            _ => "application/octet-stream",
        };
        Some(Asset {
            bytes: std::fs::read(path).ok()?,
            mime: mime.into(),
        })
    }))
}

impl NativeHost {
    pub(super) fn install_desktop_export(&mut self) -> Result<(), ApiError> {
        // Reuse the existing validated export hook and P03 typed renderer.
        // The one coarse platform-hook JSON conversion is not an FFI round trip.
        self.set_export_renderer(Arc::new(|spec, path| {
            let spec: Value = serde_json::from_str(spec).map_err(|e| e.to_string())?;
            let rows = spec["data"]["rows"]
                .as_array()
                .ok_or("Missing export rows")?;
            let entries = rows
                .iter()
                .map(|row| bilikara_rust::playlist_export::ExportEntry {
                    title: row["title"].as_str().unwrap_or_default().into(),
                    display_title: row["title"].as_str().unwrap_or_default().into(),
                    requester_name: row["requester"].as_str().unwrap_or_default().into(),
                    owner_name: row["owner"].as_str().unwrap_or_default().into(),
                    owner_mid: row["owner_mid"]
                        .as_i64()
                        .filter(|v| *v != 0)
                        .map(|v| v.to_string())
                        .unwrap_or_default(),
                    resolved_url: row["url"].as_str().unwrap_or_default().into(),
                    original_url: row["original_url"].as_str().unwrap_or_default().into(),
                    key: row["bvid"].as_str().unwrap_or_default().into(),
                    part_title: row["part"].as_str().unwrap_or_default().into(),
                    request_count: row["count"].as_i64(),
                    timestamp: row["at"].as_f64(),
                })
                .collect::<Vec<_>>();
            let artifact = if spec["format"] == "csv" {
                crate::playlist_export::export_csv(
                    &entries,
                    if spec["source"] == "history" {
                        "点歌时间"
                    } else {
                        "播放时间"
                    },
                )
            } else {
                crate::playlist_export::export_image(&crate::playlist_export::ImageExportRequest {
                    entries,
                    font_path: desktop_font_path()?,
                    title: "bilikara 歌单".into(),
                    page_size: spec["pageSize"].as_u64().ok_or("Missing page size")? as usize,
                    app_version: env!("CARGO_PKG_VERSION").into(),
                })
            }
            .map_err(|e| e.message)?;
            std::fs::write(path, artifact.bytes).map_err(|e| e.to_string())
        }))
        .map_err(|e| ApiError::new(503, "export_setup", e))
    }
}

// Installed before starting the listener; this is an immutable asset location,
// not a second application state. It is scoped to this executable invocation.
static FONT: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
fn desktop_font_path() -> Result<PathBuf, String> {
    FONT.get()
        .cloned()
        .ok_or("Desktop font path unavailable".into())
}

pub fn run(arguments: impl Iterator<Item = String>) -> Result<(), String> {
    #[cfg(unix)]
    unsafe {
        // The handler only sets an atomic flag; cleanup runs on the owner thread.
        libc::signal(
            libc::SIGINT,
            request_exit as *const () as libc::sighandler_t,
        );
        libc::signal(
            libc::SIGTERM,
            request_exit as *const () as libc::sighandler_t,
        );
    }
    #[cfg(unix)]
    let desktop_parent = std::env::var("BILIKARA_DESKTOP_PID")
        .ok()
        .and_then(|s| s.parse::<u32>().ok());
    let mut args = arguments;
    let mut directory = None;
    let mut assets = None;
    let mut import_from = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--data-dir" => directory = args.next().map(PathBuf::from),
            "--import-from" => import_from = Some(PathBuf::from(args.next().ok_or("--import-from requires an explicit legacy app-home")?)),
            "--static-dir" => assets = args.next().map(PathBuf::from),
            "--no-browser" | "--headless" => {},
            "--port" if args.next().as_deref() == Some("0") => {},
            _ => return Err("Usage: bilikara-desktop-host --data-dir ABSOLUTE_EMPTY_OR_PREVIEW_DIR --static-dir SHARED_STATIC_DIR [--import-from ABSOLUTE_LEGACY_APP_HOME] [--port 0 --headless --no-browser]".into()),
        }
    }
    let assets = assets
        .ok_or("Explicit --static-dir is required")?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let source = asset_source(&assets)?;
    let directory = directory.ok_or("Explicit --data-dir is required")?;
    if let Some(source) = import_from {
        super::desktop_import::restore(
            &source,
            &directory,
            &std::env::var("BILIKARA_BILIBILI_COOKIE").unwrap_or_default(),
        )?;
    }
    let directory = preview_root(&directory)?;
    let _ = FONT.set(assets.join("fonts/SourceHanSans-VF.ttf"));
    crate::playlist_export::prewarm_fonts(&desktop_font_path()?).map_err(|e| e.message)?;
    let seed: AppStateSeed = serde_json::from_value(json!({"session_started_at":now(),
        "session_played_file":format!("played-native-{}.json", (now()*1000.0) as u64),"updated_at":now()})).map_err(|e| e.to_string())?;
    let initialized = initialize_native_host(&directory, seed);
    if let Some(error) = initialized.error() {
        return Err(error.message.clone());
    }
    let result = (|| {
        let shutdown = std::env::var("BILIKARA_SHUTDOWN_TOKEN")
            .ok()
            .filter(|s| !s.is_empty());
        let host = start(&directory, source, true, shutdown).map_err(|e| e.to_string())?;
        // Only stdout's private parent pipe carries the bootstrap capability.
        println!(
            "{}",
            json!({"event":"bilikara.ready","host":"127.0.0.1","port":host.local_port(),
            "baseUrl":format!("http://127.0.0.1:{}",host.local_port()),"bootstrapUrl":host.bootstrap_url(),"backend":"rust"})
        );
        std::io::stdout().flush().map_err(|e| e.to_string())?;
        while !host.context.stop.load(Ordering::Acquire) {
            #[cfg(unix)]
            if EXIT_REQUESTED.load(Ordering::Acquire)
                || desktop_parent.is_some_and(|parent| unsafe { libc::getppid() } as u32 != parent)
            {
                break;
            }
            thread::park_timeout(Duration::from_millis(100));
        }
        drop(host); // Joins listener, requests, cache/login/library workers before AppState.
        Ok(())
    })();
    execute_app_state(AppStateRequest::Shutdown { schema_version: 1 });
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn isolated_root_never_enrolls_existing_data() {
        let root = std::env::temp_dir().join(format!("desktop-root-{}", token().unwrap()));
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("BBDown.data"), b"synthetic legacy data").unwrap();
        assert!(preview_root(&root).is_err());
        assert!(!root.join(MARKER).exists());
        assert_eq!(
            std::fs::read(root.join("BBDown.data")).unwrap(),
            b"synthetic legacy data"
        );
        std::fs::remove_file(root.join("BBDown.data")).unwrap();
        assert_eq!(preview_root(&root).unwrap(), root);
        assert_eq!(preview_root(&root).unwrap(), root);
        assert!(preview_root(Path::new("relative")).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
