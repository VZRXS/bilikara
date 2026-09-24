//! Desktop product entry: one Runtime/AppState, PR109 transport, P02/P03 services.
//! Legacy desktop data is read only through an explicit one-time import.
use super::*;
use crate::{AppStateRequest, AppStateSeed, execute_app_state, initialize_native_host};
use std::io::Write;
#[path = "desktop_paths.rs"]
mod paths;

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
        "This action is not yet available in the native desktop product",
    )
}

/// Admit empty roots or existing native checkpoints. Storage validates the
/// checkpoint schema and owns the lock; old preview markers are compatibility
/// input only, never created for a new installation.
pub(super) fn preview_root(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("--data-dir must be an absolute native data directory".into());
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
    if path.join("desktop-import.pending").exists() {
        return Err(
            "Incomplete desktop import; preserve this directory and import into a new destination"
                .into(),
        );
    }
    // The checkpoint's strict schema validation runs before any Host services.
    if path.join("host-state.json").exists() {
        return Ok(path);
    }
    let marker = path.join(MARKER);
    if marker.exists() {
        if !std::fs::symlink_metadata(&marker)
            .map_err(|e| e.to_string())?
            .is_file()
            || std::fs::read(&marker).map_err(|e| e.to_string())? != b"desktop-rust-preview-v1\n"
        {
            return Err("Invalid old preview directory marker".into());
        }
    } else if std::fs::read_dir(&path)
        .map_err(|e| e.to_string())?
        .next()
        .is_some()
    {
        return Err("Refusing existing data without a native checkpoint; use --import-from with a new destination".into());
    }
    Ok(path)
}

pub fn asset_source(root: &Path) -> Result<AssetSource, String> {
    asset_source_with_worklet(root, &root.join("vendor/signalsmith-stretch"))
}

fn asset_source_with_worklet(root: &Path, worklet: &Path) -> Result<AssetSource, String> {
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let worklet = worklet
        .canonicalize()
        .map_err(|_| "Missing bundled Signalsmith assets")?;
    if !worklet.join("SignalsmithStretch.js").is_file() {
        return Err("Missing bundled Signalsmith entry".into());
    }
    for file in [
        "index.html",
        "app.js",
        "styles.css",
        "native-session.js",
        "host-layout.js",
        "host-layout.css",
        "host-layout-preferences.js",
        "host-updates.js",
        "desktop-platform.js",
        "remote.html",
        "remote.js",
        "fonts/SourceHanSans-VF.ttf",
    ] {
        if !root.join(file).is_file() {
            return Err(format!("Missing shared desktop asset: {file}"));
        }
    }
    Ok(Arc::new(move |name| {
        // Only the frontend worklet has an HTTP mount in the shared vendor
        // directory. Native tools, libraries and package metadata stay private.
        let (boundary, relative) = match name.strip_prefix("vendor/signalsmith-stretch/") {
            Some(relative) => (&worklet, relative),
            None => (&root, name),
        };
        let path = boundary.join(relative).canonicalize().ok()?;
        if !path.starts_with(boundary) {
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
            "wasm" => "application/wasm",
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
                    app_version: update_facts().version,
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

// Trusted desktop facts for the update loop, resolved once from
// local configuration before the listener starts. Same scope as FONT above.
static UPDATE_FACTS: std::sync::OnceLock<updates::DesktopUpdateFacts> = std::sync::OnceLock::new();

static INSTALLATION: std::sync::OnceLock<Option<crate::update_installer::native::Installation>> =
    std::sync::OnceLock::new();
#[cfg(test)]
pub(super) static INSTALLATION_OVERRIDE: std::sync::Mutex<
    Option<crate::update_installer::native::Installation>,
> = std::sync::Mutex::new(None);
pub(super) fn installation() -> Option<crate::update_installer::native::Installation> {
    #[cfg(test)]
    if let Some(value) = INSTALLATION_OVERRIDE.lock().unwrap().clone() {
        return Some(value);
    }
    INSTALLATION.get().cloned().flatten()
}

const PLATFORM: &str = if cfg!(target_os = "windows") {
    "windows"
} else if cfg!(target_os = "macos") {
    "macos"
} else if cfg!(target_os = "linux") {
    "linux"
} else {
    "unknown"
};

/// Mirrors the established `normalize_machine_arch` spellings. The target
/// architecture is a compile-time fact of this executable.
fn machine_arch() -> String {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "x86",
        other => other,
    }
    .to_owned()
}

fn sane_version(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 80
        || !value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b".-+_".contains(&c))
    {
        return None;
    }
    Some(value.to_owned())
}

fn read_version_file(path: &Path) -> Option<String> {
    let metadata = std::fs::symlink_metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > 256 {
        return None;
    }
    sane_version(std::fs::read_to_string(path).ok()?.lines().next()?)
}

/// Resolves the current version from trusted local configuration only: the
/// launcher's `BILIKARA_VERSION` override first, which is the same override
/// `bilikara/config.py` and `build_bundle.py` honor, then the `APP_VERSION`
/// file the bundle build writes beside the shared assets. An unresolved
/// version stays empty, and the shared release policy then treats this build
/// as a development build. It is never taken from an HTTP payload, a published
/// tag or an unrelated crate version.
fn resolve_update_facts(assets: &Path) -> updates::DesktopUpdateFacts {
    facts_from(std::env::var("BILIKARA_VERSION").ok().as_deref(), assets)
}

fn facts_from(launcher_version: Option<&str>, assets: &Path) -> updates::DesktopUpdateFacts {
    let version = launcher_version
        .and_then(sane_version)
        .or_else(|| read_version_file(&assets.parent()?.join("APP_VERSION")))
        .unwrap_or_default();
    updates::DesktopUpdateFacts {
        version,
        platform: PLATFORM.to_owned(),
        arch: machine_arch(),
    }
}

pub(super) fn update_facts() -> updates::DesktopUpdateFacts {
    UPDATE_FACTS
        .get()
        .cloned()
        .unwrap_or_else(|| updates::DesktopUpdateFacts {
            version: String::new(),
            platform: PLATFORM.to_owned(),
            arch: machine_arch(),
        })
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
    let mut import_from = std::env::var_os("BILIKARA_DESKTOP_RUST_IMPORT_FROM")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--data-dir" => directory = Some(PathBuf::from(args.next().ok_or("--data-dir requires an absolute native directory")?)),
            "--import-from" => import_from = Some(PathBuf::from(args.next().ok_or("--import-from requires an explicit legacy app-home")?)),
            "--static-dir" => assets = Some(PathBuf::from(args.next().ok_or("--static-dir requires an explicit asset directory")?)),
            "--no-browser" | "--headless" => {},
            "--port" if args.next().as_deref() == Some("0") => {},
            _ => return Err("Usage: bilikara-desktop-host [--data-dir ABSOLUTE_NATIVE_DIR] [--import-from ABSOLUTE_LEGACY_APP_HOME] [--static-dir ABSOLUTE_DEVELOPMENT_STATIC_DIR] [--port 0 --headless --no-browser]".into()),
        }
    }
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let resources = paths::resource_root(&executable)?;
    let development_assets = assets.is_some();
    let assets = assets
        .map(Ok)
        .unwrap_or_else(|| paths::package_assets(&resources))?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let source = if development_assets {
        asset_source(&assets)?
    } else {
        let worklet = resources
            .join("vendor/signalsmith-stretch")
            .canonicalize()
            .map_err(|_| "Missing packaged Signalsmith assets")?;
        if !worklet.starts_with(resources.canonicalize().map_err(|e| e.to_string())?) {
            return Err("Packaged Signalsmith assets escape their resources".into());
        }
        asset_source_with_worklet(&assets, &worklet)?
    };
    paths::configure_media(assets.parent().ok_or("Missing resource root")?)?;
    let directory = paths::data_root(directory, &executable, PLATFORM, |key| {
        std::env::var_os(key)
    })?;
    if let Some(source) = import_from {
        super::desktop_import::restore(
            &source,
            &directory,
            &std::env::var("BILIKARA_BILIBILI_COOKIE").unwrap_or_default(),
        )?;
    }
    let directory = preview_root(&directory)?;
    let _ = FONT.set(assets.join("fonts/SourceHanSans-VF.ttf"));
    let _ = UPDATE_FACTS.set(resolve_update_facts(&assets));
    let admitted = (|| {
        if std::env::var("BILIKARA_LAUNCH_MODE").ok().as_deref() != Some("tauri") {
            return None;
        }
        let shell = PathBuf::from(std::env::var_os("BILIKARA_DESKTOP_EXECUTABLE")?);
        let pid = std::env::var("BILIKARA_DESKTOP_PID").ok()?.parse().ok()?;
        crate::update_installer::native::Installation::from_launcher(
            &executable,
            &shell,
            pid,
            PLATFORM,
            &machine_arch(),
        )
        .ok()
    })();
    let _ = INSTALLATION
        .set(admitted.filter(|installation| installation.permits_data_directory(&directory)));
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
        // Export is optional at launch, as in the shipped Python desktop Host.
        // Reuse the renderer's synchronized font cache: an immediate export
        // waits for the same resources, while normal Host requests stay ready.
        // Track the worker so shutdown joins it before dropping AppState.
        if let Err(error) = host.context.spawn("desktop-export-prewarm", || {
            let result = desktop_font_path().and_then(|path| {
                crate::playlist_export::prewarm_fonts(&path).map_err(|e| e.message)
            });
            if let Err(error) = result {
                eprintln!("Desktop export font prewarm failed: {error}");
            }
        }) {
            eprintln!("Could not start desktop export font prewarm: {error}");
        }
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
    fn desktop_version_comes_only_from_trusted_local_configuration() {
        let root = std::env::temp_dir().join(format!("desktop-version-{}", token().unwrap()));
        let assets = root.join("static");
        std::fs::create_dir_all(&assets).unwrap();

        // Nothing configured: a development build. The shared release policy
        // handles that explicitly; no version is invented from a crate version,
        // a published tag or an Android default.
        let development = facts_from(None, &assets);
        assert_eq!(development.version, "");
        assert_eq!(development.platform, PLATFORM);
        assert_eq!(development.arch, machine_arch());
        assert!(!development.arch.is_empty());

        // The bundle build writes APP_VERSION beside the shared assets.
        std::fs::write(root.join("APP_VERSION"), "0.8.0\n").unwrap();
        assert_eq!(facts_from(None, &assets).version, "0.8.0");
        // The launcher override takes precedence over the packaged file.
        assert_eq!(
            facts_from(Some("v0.8.0-preview.1"), &assets).version,
            "v0.8.0-preview.1"
        );
        // An unusable override falls back to the file rather than being trusted.
        assert_eq!(facts_from(Some("  "), &assets).version, "0.8.0");
        assert_eq!(
            facts_from(Some("0.8.0 || curl evil"), &assets).version,
            "0.8.0"
        );

        // Malformed and oversized files are ignored, not trusted.
        for contents in ["0.8.0 ; rm -rf /\n", "开发版\n", ""] {
            std::fs::write(root.join("APP_VERSION"), contents).unwrap();
            assert_eq!(facts_from(None, &assets).version, "", "{contents:?}");
        }
        std::fs::write(root.join("APP_VERSION"), "v".repeat(300)).unwrap();
        assert_eq!(facts_from(None, &assets).version, "");
        // A directory or a symlink in that position is not a version file.
        std::fs::remove_file(root.join("APP_VERSION")).unwrap();
        std::fs::create_dir(root.join("APP_VERSION")).unwrap();
        assert_eq!(facts_from(None, &assets).version, "");

        std::fs::remove_dir_all(root).unwrap();
    }

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
