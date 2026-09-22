//! Source-specific adaptation of the existing aria2 preparation routes. Reuses
//! the shared HTTP downloader and pinned asset policy; never receives cookies.
use super::*;
use sha2::{Digest, Sha256};
use std::io::Read;

fn error(message: &str) -> CacheRuntimeError {
    CacheRuntimeError::new("unavailable", message)
}
fn cancelled(cancel: &AtomicBool) -> Result<(), CacheRuntimeError> {
    if cancel.load(Ordering::Acquire) {
        Err(CacheRuntimeError::new(
            "cancelled",
            "aria2c preparation cancelled",
        ))
    } else {
        Ok(())
    }
}
fn io(_: std::io::Error) -> CacheRuntimeError {
    error("aria2c preparation I/O failed")
}
fn name() -> &'static str {
    if cfg!(windows) {
        "aria2c.exe"
    } else {
        "aria2c"
    }
}
fn tool(name: &str) -> Option<PathBuf> {
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
        .map(|p| p.join(name))
        .find(|p| p.is_absolute() && p.is_file())
}
fn bundled_roots(vendors: &[PathBuf]) -> Vec<PathBuf> {
    let mut roots = vendors.to_vec();
    if let Ok(exe) = std::env::current_exe() {
        for root in exe.ancestors().skip(1).take(4) {
            for relative in [
                "vendor",
                "_internal/vendor",
                "Resources/vendor",
                "tools/aria2c",
            ] {
                roots.push(root.join(relative));
            }
        }
    }
    roots
}
fn brew() -> Option<PathBuf> {
    tool("brew").or_else(|| {
        ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]
            .into_iter()
            .map(PathBuf::from)
            .find(|p| p.is_file())
    })
}
fn run(
    program: &Path,
    args: &[&std::ffi::OsStr],
    dir: &Path,
    capture: bool,
    cancel: &AtomicBool,
) -> Result<Vec<u8>, CacheRuntimeError> {
    let mut c = Command::new(program);
    c.args(args).current_dir(dir);
    // Tool preparation is credential-free even when the Host is logged in.
    for key in [
        "BILIKARA_BILIBILI_COOKIE",
        "BILIBILI_COOKIE",
        "BB_DOWN_PATH",
        "ARIA2C_PATH",
    ] {
        c.env_remove(key);
    }
    super::super::child::supervise(
        c,
        cancel,
        Duration::from_secs(120),
        capture,
        || {},
        &|_, _| {},
        "aria2c preparation",
    )
}
struct Staging(PathBuf);
impl Drop for Staging {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub(super) fn prepare(
    directory: &Path,
    override_path: Option<PathBuf>,
    vendors: &[PathBuf],
    install: bool,
    cancel: &AtomicBool,
) -> Result<Executable, CacheRuntimeError> {
    if !cfg!(any(
        target_os = "linux",
        target_os = "macos",
        target_os = "windows"
    )) {
        return Err(error("aria2c is desktop-only"));
    }
    if !directory.is_absolute() || vendors.len() > 16 || vendors.iter().any(|p| !p.is_absolute()) {
        return Err(invalid());
    }
    cancelled(cancel)?;
    if let Some(path) = override_path {
        return Executable::check(path, cancel).ok_or_else(|| {
            CacheRuntimeError::new(
                "invalid_override",
                "Invalid ARIA2C_PATH: an executable aria2c with HTTPS support is required",
            )
        });
    }
    let mut candidates = vec![directory.join(name())];
    if let Ok(current) = fs::read_to_string(directory.join("CURRENT")) {
        let current = current.trim();
        if current.starts_with("managed-") && Path::new(current).components().count() == 1 {
            candidates.push(directory.join(current).join(name()));
        }
    }
    if let Some(home) = std::env::var_os("BILIKARA_HOME") {
        candidates.push(PathBuf::from(home).join("tools/aria2c").join(name()));
    }
    let roots = bundled_roots(vendors);
    candidates.extend(roots.iter().map(|p| p.join(name())));
    // Preserve the default product's existing system-tool discovery. Never run
    // an installer when a supplied/bundled/managed/system tool already works.
    if let Some(path) = tool(name()) {
        candidates.push(path);
    }
    for path in [
        "/opt/homebrew/bin/aria2c",
        "/usr/local/bin/aria2c",
        "/opt/local/bin/aria2c",
        "/usr/bin/aria2c",
        "/bin/aria2c",
        "/snap/bin/aria2c",
    ] {
        candidates.push(path.into());
    }
    if let Some(exe) = candidates
        .into_iter()
        .find_map(|path| Executable::check(path, cancel))
    {
        return Ok(exe);
    }
    cancelled(cancel)?;
    if !install {
        return Err(error(
            "DownKyi/aria2c unavailable; prepare the tool or configure ARIA2C_PATH",
        ));
    }
    fs::create_dir_all(directory).map_err(io)?;
    let id = format!(
        "managed-{}-{}",
        std::process::id(),
        ATTEMPT_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    );
    let staging = Staging(directory.join(format!(".prepare-{id}")));
    fs::create_dir(&staging.0).map_err(io)?;
    let payload = staging.0.join("payload");
    fs::create_dir(&payload).map_err(io)?;
    if cfg!(target_os = "linux") {
        apt(&staging.0, &payload, cancel)?;
    } else if cfg!(target_os = "macos") {
        macos(&staging.0, &payload, &roots, cancel)?;
    } else {
        windows(&staging.0, &payload, cancel)?;
    }
    if Executable::check(payload.join(name()), cancel).is_none() {
        return Err(error(
            "Prepared aria2c failed its HTTPS/version capability check",
        ));
    }
    cancelled(cancel)?;
    let published = directory.join(&id);
    fs::rename(&payload, &published).map_err(io)?;
    let pending = directory.join(format!(".current-{id}"));
    fs::write(&pending, id.as_bytes()).map_err(io)?;
    // Directory is private to this source; executable directories are immutable.
    #[cfg(windows)]
    if directory.join("CURRENT").exists() {
        fs::remove_file(directory.join("CURRENT")).map_err(io)?;
    }
    fs::rename(pending, directory.join("CURRENT")).map_err(io)?;
    Executable::check(published.join(name()), cancel)
        .ok_or_else(|| error("Published aria2c unavailable"))
}

fn visit(
    directory: &Path,
    depth: usize,
    result: &mut Vec<PathBuf>,
) -> Result<(), CacheRuntimeError> {
    if depth > 12 || result.len() > 4096 {
        return Err(error("aria2c package exceeds bounded layout"));
    }
    for entry in fs::read_dir(directory).map_err(io)? {
        let path = entry.map_err(io)?.path();
        let meta = fs::symlink_metadata(&path).map_err(io)?;
        if meta.is_dir() {
            visit(&path, depth + 1, result)?;
        } else {
            result.push(path);
        }
    }
    Ok(())
}
fn apt(dir: &Path, payload: &Path, cancel: &AtomicBool) -> Result<(), CacheRuntimeError> {
    let apt = tool("apt-get").ok_or_else(|| {
        error("Install aria2c manually or configure ARIA2C_PATH (apt-get unavailable)")
    })?;
    let dpkg = tool("dpkg-deb")
        .ok_or_else(|| error("dpkg-deb unavailable for local aria2c extraction"))?;
    let mut downloaded = false;
    for packages in [
        &["aria2", "libaria2-0", "libssh2-1", "libc-ares2"][..],
        &["aria2", "libaria2-0"][..],
        &["aria2"][..],
    ] {
        let args: Vec<_> = std::iter::once("download")
            .chain(packages.iter().copied())
            .map(std::ffi::OsStr::new)
            .collect();
        cancelled(cancel)?;
        if run(&apt, &args, dir, false, cancel).is_ok() {
            downloaded = true;
            break;
        }
    }
    if !downloaded {
        return Err(error("Trusted distribution aria2 packages unavailable"));
    }
    let extract = dir.join("extracted");
    fs::create_dir(&extract).map_err(io)?;
    for entry in fs::read_dir(dir).map_err(io)? {
        let path = entry.map_err(io)?.path();
        if path.extension().is_some_and(|e| e == "deb") {
            run(
                &dpkg,
                &["-x".as_ref(), path.as_os_str(), extract.as_os_str()],
                dir,
                false,
                cancel,
            )?;
        }
    }
    let mut files = Vec::new();
    visit(&extract, 0, &mut files)?;
    for path in files {
        let file = path.file_name().unwrap().to_string_lossy();
        if file == name()
            || ["libaria2.so", "libssh2.so", "libcares.so"]
                .iter()
                .any(|prefix| file.starts_with(prefix))
        {
            let real = path.canonicalize().map_err(io)?;
            if !real.starts_with(&extract) || !real.is_file() {
                return Err(error("aria2 package symlink escaped extraction"));
            }
            fs::copy(real, payload.join(file.as_ref())).map_err(io)?;
        }
    }
    executable(&payload.join(name()))
}
fn executable(path: &Path) -> Result<(), CacheRuntimeError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).map_err(io)?;
    }
    Ok(())
}
fn fetch(urls: Vec<String>, path: &Path, cancel: &AtomicBool) -> Result<(), CacheRuntimeError> {
    cancelled(cancel)?;
    let request = DownloadRequest {
        schema_version: 1,
        candidates: urls
            .into_iter()
            .map(|url| DownloadCandidate {
                url,
                headers: vec![],
            })
            .collect(),
        destination: path.into(),
        connect_timeout_ms: 15000,
        request_timeout_ms: 120000,
        attempts_per_candidate: 1,
    };
    download_to_path(&request, |p| {
        !cancel.load(Ordering::Acquire) && p.downloaded_bytes <= 64 * 1024 * 1024
    })
    .map_err(|_| error("aria2c tool asset download failed"))?;
    Ok(())
}
fn windows(dir: &Path, payload: &Path, cancel: &AtomicBool) -> Result<(), CacheRuntimeError> {
    use bilikara_rust::{
        ToolAssetInput, ToolDownloadPlanRequest, ToolFallbackBaseInput, ToolKind, ToolTarget,
        plan_tool_download_candidates,
    };
    let plan = plan_tool_download_candidates(&ToolDownloadPlanRequest {
        tool: ToolKind::Aria2c,
        asset: ToolAssetInput::DefaultForTarget(ToolTarget {
            platform: "windows".into(),
            architecture: if cfg!(target_arch = "x86") {
                "x86"
            } else {
                "x64"
            }
            .into(),
        }),
        fallback_bases: vec![ToolFallbackBaseInput {
            original_index: 0,
            base_url: asset_base(),
        }],
    })
    .map_err(|_| error("No aria2c Windows asset for this platform"))?;
    let archive = dir.join("aria2.zip");
    fetch(
        plan.candidates.into_iter().map(|c| c.url).collect(),
        &archive,
        cancel,
    )?;
    zip_binary(&archive, payload)?;
    if !Executable::check(payload.join(name()), cancel).is_some_and(|e| e.version == "1.37.0") {
        return Err(error("Pinned Windows aria2c version mismatch"));
    }
    Ok(())
}
fn zip_binary(path: &Path, payload: &Path) -> Result<(), CacheRuntimeError> {
    let mut archive = zip::ZipArchive::new(fs::File::open(path).map_err(io)?)
        .map_err(|_| error("Invalid aria2c zip"))?;
    let mut found = false;
    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|_| error("Invalid aria2c zip"))?;
        if file
            .enclosed_name()
            .is_some_and(|p| p.file_name().is_some_and(|n| n == "aria2c.exe"))
        {
            if found
                || file.size() > 64 * 1024 * 1024
                || file.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000)
            {
                return Err(error("Ambiguous aria2c zip"));
            }
            std::io::copy(
                &mut file,
                &mut fs::File::create(payload.join(name())).map_err(io)?,
            )
            .map_err(io)?;
            found = true;
        }
    }
    if !found {
        return Err(error("aria2c not present in archive"));
    }
    Ok(())
}
fn asset_base() -> String {
    std::env::var("BILIKARA_TOOL_ASSET_BASE_URL")
        .unwrap_or_else(|_| "https://download.kevinx96.icu/bilikara/tools".into())
        .trim_end_matches('/')
        .into()
}
fn tar_binary(archive: &Path, payload: &Path) -> Result<(), CacheRuntimeError> {
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(
        fs::File::open(archive).map_err(io)?,
    ));
    let mut found = false;
    for entry in archive.entries().map_err(io)?.take(4096) {
        let mut entry = entry.map_err(io)?;
        if entry
            .path()
            .map_err(io)?
            .file_name()
            .is_some_and(|n| n == "aria2c")
        {
            if found || !entry.header().entry_type().is_file() || entry.size() > 64 * 1024 * 1024 {
                return Err(error("Unsafe aria2c archive"));
            }
            std::io::copy(
                &mut entry,
                &mut fs::File::create(payload.join(name())).map_err(io)?,
            )
            .map_err(io)?;
            found = true;
        }
    }
    if !found {
        return Err(error("aria2c not present in archive"));
    }
    executable(&payload.join(name()))
}
fn macos(
    dir: &Path,
    payload: &Path,
    roots: &[PathBuf],
    cancel: &AtomicBool,
) -> Result<(), CacheRuntimeError> {
    let arch = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    };
    for root in roots {
        let Ok(file) = fs::File::open(root.join("aria2-macos.json")) else {
            continue;
        };
        let Ok(data) = serde_json::from_reader::<_, Value>(file.take(16384)) else {
            continue;
        };
        let Some((raw, digest)) = pinned_asset(&data, arch, &asset_base()) else {
            continue;
        };
        let archive = dir.join("aria2.tar.gz");
        if fetch(vec![raw], &archive, cancel).is_ok() {
            let bytes = fs::read(&archive).map_err(io)?;
            if format!("{:x}", Sha256::digest(&bytes)) == digest.to_lowercase()
                && tar_binary(&archive, payload).is_ok()
                && Executable::check(payload.join(name()), cancel)
                    .is_some_and(|e| e.version == "1.37.0")
            {
                return Ok(());
            }
        }
        let _ = fs::remove_file(archive);
        let _ = fs::remove_file(payload.join(name()));
    }
    let brew = brew()
        .ok_or_else(|| error("No trusted pinned macOS aria2c asset or Homebrew available"))?;
    run(
        &brew,
        &["fetch".as_ref(), "--bottle".as_ref(), "aria2".as_ref()],
        dir,
        false,
        cancel,
    )
    .or_else(|_| {
        run(
            &brew,
            &["fetch".as_ref(), "aria2".as_ref()],
            dir,
            false,
            cancel,
        )
    })?;
    let output = run(
        &brew,
        &["--cache".as_ref(), "--bottle".as_ref(), "aria2".as_ref()],
        dir,
        true,
        cancel,
    )
    .or_else(|_| {
        run(
            &brew,
            &["--cache".as_ref(), "aria2".as_ref()],
            dir,
            true,
            cancel,
        )
    })?;
    let text = String::from_utf8_lossy(&output);
    let path = Path::new(text.lines().last().unwrap_or("").trim());
    if !path.is_absolute() || !path.is_file() {
        return Err(error("Homebrew did not return an aria2 archive"));
    }
    tar_binary(path, payload)
}

fn pinned_asset(data: &Value, arch: &str, base_url: &str) -> Option<(String, String)> {
    let expected = json!({"schema_version":2,"tool":"aria2c","provider":"bilikara-r2","platform":"darwin","arch":arch,"version":"1.37.0",
        "source_url":"https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0.tar.xz",
        "source_sha256":"60a420ad7085eb616cb6e2bdf0a7206d68ff3d37fb5a956dc44242eb2f79b66b"});
    if expected
        .as_object()
        .unwrap()
        .iter()
        .any(|(k, v)| data[k] != *v)
    {
        return None;
    }
    let (Some(raw), Some(asset_name), Some(digest), Some(recipe)) = (
        data["url"].as_str(),
        data["name"].as_str(),
        data["sha256"].as_str(),
        data["recipe_revision"].as_str(),
    ) else {
        return None;
    };
    let (Ok(url), Ok(base)) = (url::Url::parse(raw), url::Url::parse(base_url)) else {
        return None;
    };
    if url.scheme() != "https"
        || url.host_str() != base.host_str()
        || url.port() != base.port()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || asset_name.contains(['/', '\\'])
        || !asset_name.ends_with(".tar.gz")
        || digest.len() != 64
        || !digest.bytes().all(|b| b.is_ascii_hexdigit())
        || recipe.is_empty()
        || recipe.len() > 128
        || !recipe
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
        || !url.path().starts_with(&format!(
            "{}/aria2/1.37.0/",
            base.path().trim_end_matches('/')
        ))
        || !url.path().contains(&format!("/{recipe}/"))
        || !url.path().ends_with(&format!("/{asset_name}"))
    {
        return None;
    }
    Some((raw.into(), digest.to_lowercase()))
}

pub(in crate::cache_runtime) fn can_prepare(roots: &[PathBuf]) -> bool {
    if cfg!(target_os = "windows") {
        return true;
    }
    if cfg!(target_os = "linux") {
        return tool("apt-get").is_some() && tool("dpkg-deb").is_some();
    }
    if cfg!(target_os = "macos") {
        let arch = if cfg!(target_arch = "aarch64") {
            "arm64"
        } else {
            "x64"
        };
        return brew().is_some()
            || bundled_roots(roots).iter().any(|root| {
                fs::File::open(root.join("aria2-macos.json"))
                    .ok()
                    .and_then(|f| serde_json::from_reader::<_, Value>(f.take(16384)).ok())
                    .is_some_and(|data| pinned_asset(&data, arch, &asset_base()).is_some())
            });
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    fn root() -> Staging {
        let dir = std::env::temp_dir().join(format!(
            "aria2-prepare-test-{}-{}",
            std::process::id(),
            ATTEMPT_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&dir).unwrap();
        Staging(dir)
    }
    #[test]
    fn pinned_metadata_requires_exact_source_arch_recipe_origin_and_digest() {
        let mut data = json!({"schema_version":2,"tool":"aria2c","provider":"bilikara-r2","platform":"darwin","arch":"arm64","version":"1.37.0",
            "source_url":"https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0.tar.xz",
            "source_sha256":"60a420ad7085eb616cb6e2bdf0a7206d68ff3d37fb5a956dc44242eb2f79b66b",
            "name":"aria2-test.tar.gz","recipe_revision":"recipe1","sha256":"a".repeat(64),
            "url":"https://example.invalid/tools/aria2/1.37.0/recipe1/aria2-test.tar.gz"});
        let base = "https://example.invalid/tools";
        assert!(pinned_asset(&data, "arm64", base).is_some());
        assert!(pinned_asset(&data, "x64", base).is_none());
        for (key, value) in [
            ("version", "1.38.0"),
            ("source_sha256", "bad"),
            ("sha256", "bad"),
            ("recipe_revision", "other"),
            ("name", "../escape.tar.gz"),
            (
                "url",
                "https://other.invalid/tools/aria2/1.37.0/recipe1/aria2-test.tar.gz",
            ),
        ] {
            let old = data[key].clone();
            data[key] = json!(value);
            assert!(pinned_asset(&data, "arm64", base).is_none(), "{key}");
            data[key] = old;
        }
    }
    #[test]
    fn zip_extracts_only_one_regular_tool_without_path_traversal() {
        use zip::write::SimpleFileOptions;
        let root = root();
        let archive = root.0.join("tool.zip");
        let payload = root.0.join("out");
        fs::create_dir(&payload).unwrap();
        let make = |duplicate: bool| {
            let mut zip = zip::ZipWriter::new(fs::File::create(&archive).unwrap());
            zip.start_file("aria2/aria2c.exe", SimpleFileOptions::default())
                .unwrap();
            zip.write_all(b"tool").unwrap();
            zip.start_file("../escape.txt", SimpleFileOptions::default())
                .unwrap();
            zip.write_all(b"must not extract").unwrap();
            if duplicate {
                zip.start_file("other/aria2c.exe", SimpleFileOptions::default())
                    .unwrap();
                zip.write_all(b"other").unwrap();
            }
            zip.finish().unwrap();
        };
        make(false);
        zip_binary(&archive, &payload).unwrap();
        assert_eq!(fs::read(payload.join(name())).unwrap(), b"tool");
        assert!(!root.0.join("escape.txt").exists());
        make(true);
        assert!(zip_binary(&archive, &payload).is_err());
    }
    #[test]
    fn tar_rejects_symlink_tool_and_extracts_regular_binary() {
        let root = root();
        let archive = root.0.join("tool.tar.gz");
        let payload = root.0.join("out");
        fs::create_dir(&payload).unwrap();
        let make = |link: bool| {
            let gz = flate2::write::GzEncoder::new(
                fs::File::create(&archive).unwrap(),
                flate2::Compression::default(),
            );
            let mut tar = tar::Builder::new(gz);
            let mut header = tar::Header::new_gnu();
            header.set_size(if link { 0 } else { 4 });
            header.set_mode(0o755);
            if link {
                header.set_entry_type(tar::EntryType::Symlink);
                header.set_link_name("/outside").unwrap();
            }
            header.set_cksum();
            tar.append_data(
                &mut header,
                "bin/aria2c",
                if link { &b""[..] } else { &b"tool"[..] },
            )
            .unwrap();
            tar.into_inner().unwrap().finish().unwrap();
        };
        make(true);
        assert!(tar_binary(&archive, &payload).is_err());
        make(false);
        tar_binary(&archive, &payload).unwrap();
        assert_eq!(fs::read(payload.join(name())).unwrap(), b"tool");
    }
}
