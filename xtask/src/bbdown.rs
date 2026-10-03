//! Pinned build-time tool acquisition. This is independent of product preparation.
use crate::{
    Result,
    config::{Os, Platform, timed_output},
};
use regex::Regex;
use sha2::{Digest, Sha256};
use std::{
    env,
    ffi::OsString,
    fs::{self, File},
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    process::Command,
    time::{Duration, Instant},
};

const VERSION: &str = "1.6.3";
const RELEASE_COMMIT: &str = "45622f79cd766e0fc6f5cbd49fcf4960340f35c3";
const RELEASE_BASE: &str = "https://github.com/nilaoda/BBDown/releases/download/1.6.3";
const MIRROR_BASE: &str = "https://download.kevinx96.icu/bilikara/tools";
const USER_AGENT: &str = "bilikara-bundle-builder";
const MAX_ARCHIVE: u64 = 128 * 1024 * 1024;
const MAX_BINARY: u64 = 512 * 1024 * 1024;

struct Asset {
    name: &'static str,
    sha256: &'static str,
}
fn asset(platform: Platform) -> Asset {
    let (name, sha256) = match (platform.os, platform.arm) {
        (Os::Windows, false) => (
            "BBDown_1.6.3_20240814_win-x64.zip",
            "40f1e2af0d4e74df765c6f93d2e931f9bea201d5168d0bc62dc35a54b7e0ec02",
        ),
        (Os::Windows, true) => (
            "BBDown_1.6.3_20240814_win-arm64.zip",
            "da8fc9cbf1031f4c4ca97af82d98bbfd1bbc55bd8ea49602da8d3d1613c190ff",
        ),
        (Os::Macos, false) => (
            "BBDown_1.6.3_20240814_osx-x64.zip",
            "262c15ca7890898560d00e5ffd5ada1864fbd9d0d58ac4ee492c9f3e73f3ae5f",
        ),
        (Os::Macos, true) => (
            "BBDown_1.6.3_20240814_osx-arm64.zip",
            "4df84014d818bd6dff2b365b847645340e8955c4450fe965688f41af89a38baa",
        ),
        (Os::Linux, false) => (
            "BBDown_1.6.3_20240814_linux-x64.zip",
            "ec233b7d8d40b1cc4447dac05be343f53a757dc605743a8808abaa8e97e5d10e",
        ),
        (Os::Linux, true) => (
            "BBDown_1.6.3_20240814_linux-arm64.zip",
            "f58e0a18df1a589375428a0af27ea61f5ce96ffaf67d115f335d5f9bee9a34dc",
        ),
    };
    Asset { name, sha256 }
}

fn platform(os: &str, arch: &str) -> Result<Platform> {
    let os = os.trim().to_ascii_lowercase();
    let os = match os.as_str() {
        "darwin" => "macos",
        "win32" | "win" => "windows",
        value => value,
    };
    let arch = arch.trim().to_ascii_lowercase();
    let normalized = match arch.as_str() {
        "amd64" | "x86_64" | "x64" => "x86_64",
        "aarch64" | "arm64" => "aarch64",
        value => value,
    };
    Platform::new(os, normalized)
        .map_err(|_| format!("No pinned BBDown release asset for {os}/{arch}").into())
}

pub fn run(args: Vec<OsString>) -> Result<()> {
    let mut output = None;
    let mut os = env::consts::OS.to_owned();
    let mut arch = env::consts::ARCH.to_owned();
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        if arg == "--platform" || arg == "--arch" {
            let value = args.next().ok_or("BBDown target option requires a value")?;
            let value = value.to_str().ok_or("Invalid BBDown target")?.to_owned();
            if arg == "--platform" {
                os = value;
            } else {
                arch = value;
            }
        } else if let Some(value) = arg.to_str().and_then(|s| s.strip_prefix("--platform=")) {
            os = value.into();
        } else if let Some(value) = arg.to_str().and_then(|s| s.strip_prefix("--arch=")) {
            arch = value.into();
        } else if output.is_none() && !arg.to_string_lossy().starts_with('-') {
            output = Some(PathBuf::from(arg));
        } else {
            return Err("expected prepare-bbdown OUTPUT_DIR [--platform OS] [--arch ARCH]".into());
        }
    }
    let output = output.ok_or("prepare-bbdown requires OUTPUT_DIR")?;
    let platform = platform(&os, &arch)?;
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let pinned = asset(platform);
    let binary = prepare(
        root,
        &output,
        platform,
        &Recipe {
            name: pinned.name,
            sha256: pinned.sha256,
            sources: [
                format!("{RELEASE_BASE}/{}", pinned.name),
                format!("{MIRROR_BASE}/{}", pinned.name),
            ],
            transfer_timeout: Duration::from_secs(120),
            help_timeout: Duration::from_secs(30),
            max_archive: MAX_ARCHIVE,
            max_binary: MAX_BINARY,
        },
    )?;
    println!(
        "Prepared pinned BBDown {VERSION} for {}/{}: {}",
        platform.name(),
        platform.arch(),
        binary.display()
    );
    Ok(())
}

// Only unit tests can supply different pins/endpoints/limits; the CLI always uses the table above.
struct Recipe<'a> {
    name: &'a str,
    sha256: &'a str,
    sources: [String; 2],
    transfer_timeout: Duration,
    help_timeout: Duration,
    max_archive: u64,
    max_binary: u64,
}

fn digest(path: &Path) -> Result<String> {
    let mut file = File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0; 65536];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn download(recipe: &Recipe<'_>, archive: &Path) -> Result<String> {
    let mut failures = Vec::new();
    for source in &recipe.sources {
        let mut command = Command::new("curl");
        command
            .args([
                "--disable",
                "--fail",
                "--location",
                "--silent",
                "--show-error",
                "--user-agent",
                USER_AGENT,
                "--max-time",
            ])
            .arg(recipe.transfer_timeout.as_secs_f64().to_string())
            .arg("--max-filesize")
            .arg(recipe.max_archive.to_string())
            .arg("--output")
            .arg(archive)
            .args(["--write-out", "%{http_code}"])
            .arg("--url")
            .arg(source);
        let result = timed_output(command, recipe.transfer_timeout);
        match result {
            Ok(result)
                if result.status.success()
                    && std::str::from_utf8(&result.stdout)
                        .ok()
                        .and_then(|s| s.trim().parse::<u16>().ok())
                        .is_some_and(|status| (200..300).contains(&status)) =>
            {
                if fs::metadata(archive)?.len() > recipe.max_archive {
                    return Err("Pinned BBDown archive exceeds size limit".into());
                }
                // A complete download with the wrong pin is an integrity failure, never a mirror retry.
                let actual = digest(archive)?;
                if actual != recipe.sha256 {
                    return Err(format!(
                        "Pinned BBDown SHA-256 mismatch for {}: expected {}, got {actual}",
                        recipe.name, recipe.sha256
                    )
                    .into());
                }
                return Ok(source.clone());
            }
            Ok(result) => failures.push(format!(
                "{source}: curl exit {}, HTTP {}",
                result.status,
                String::from_utf8_lossy(&result.stdout).trim()
            )),
            Err(_) => failures.push(format!("{source}: bounded transfer failed")),
        }
        if archive.exists() {
            fs::remove_file(archive)?;
        }
    }
    Err(format!(
        "Unable to download pinned BBDown asset: {}",
        failures.join("; ")
    )
    .into())
}

// Archive names are wire paths, not native OS paths. Backslash archives retain the
// accepted separator handling, but prefixes/traversal/streams are never cleaned away.
fn member_basename(name: &str) -> Result<&str> {
    if name.is_empty() || name.starts_with(['/', '\\']) || name.contains([':', '\0']) {
        return Err("Unsafe pinned BBDown archive path".into());
    }
    let parts: Vec<_> = name.split(['/', '\\']).collect();
    if parts.contains(&"..") {
        return Err("Unsafe pinned BBDown archive path".into());
    }
    parts
        .into_iter()
        .rev()
        .find(|part| !part.is_empty() && *part != ".")
        .ok_or_else(|| "Unsafe pinned BBDown archive path".into())
}

fn extract(archive: &Path, binary: &Path, expected: &str, limit: u64) -> Result<()> {
    let mut zip = zip::ZipArchive::new(File::open(archive)?)?;
    check_unique_entries(archive, zip.central_directory_start(), zip.len())?;
    if zip.len() > 4096 {
        return Err("Pinned BBDown archive has too many entries".into());
    }
    let mut matches = Vec::new();
    for index in 0..zip.len() {
        let entry = zip.by_index(index)?;
        let basename = member_basename(entry.name())?;
        let kind = entry.unix_mode().unwrap_or(0) & 0o170000;
        if entry.is_symlink() || !matches!(kind, 0 | 0o100000 | 0o040000) {
            return Err("Pinned BBDown archive contains a linked or non-regular entry".into());
        }
        if !entry.is_dir() && basename.eq_ignore_ascii_case(expected) {
            if kind == 0o040000 || entry.size() > limit {
                return Err("Invalid or oversized pinned BBDown executable".into());
            }
            matches.push(index);
        }
    }
    if matches.len() != 1 {
        return Err(format!(
            "Pinned BBDown archive must contain exactly one {expected}; found {}",
            matches.len()
        )
        .into());
    }
    let entry = zip.by_index(matches[0])?;
    let size = entry.size();
    let mut source = entry.take(limit + 1);
    let mut output = File::create(binary)?;
    let copied = io::copy(&mut source, &mut output)?;
    if copied != size || copied > limit {
        return Err("Incomplete or oversized pinned BBDown executable".into());
    }
    output.sync_all()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = output.metadata()?.permissions().mode() | 0o100;
        fs::set_permissions(binary, fs::Permissions::from_mode(mode))?;
    }
    Ok(())
}

// zip 2.x collapses identical names in its index. Count raw central records so
// duplicate (including otherwise hidden unsafe) entries cannot evade validation.
// ZIP decoding/decompression remains the library's responsibility.
fn check_unique_entries(archive: &Path, start: u64, indexed: usize) -> Result<()> {
    let mut file = File::open(archive)?;
    let length = file.metadata()?.len();
    file.seek(SeekFrom::Start(start))?;
    let mut count = 0;
    loop {
        let mut signature = [0; 4];
        file.read_exact(&mut signature)?;
        match &signature {
            b"PK\x01\x02" => {
                count += 1;
                if count > 4096 {
                    return Err("Pinned BBDown archive has too many entries".into());
                }
                let mut header = [0; 42];
                file.read_exact(&mut header)?;
                let skip: u64 = [24, 26, 28]
                    .into_iter()
                    .map(|index| u64::from(u16::from_le_bytes([header[index], header[index + 1]])))
                    .sum();
                if file.seek(SeekFrom::Current(skip as i64))? > length {
                    return Err("Incomplete pinned BBDown ZIP directory".into());
                }
            }
            b"PK\x05\x06" | b"PK\x06\x06" => break, // Classic or ZIP64 end record.
            _ => return Err("Invalid pinned BBDown ZIP directory".into()),
        }
    }
    if count != indexed {
        return Err("Pinned BBDown archive contains duplicate entry names".into());
    }
    Ok(())
}

fn validate_help(binary: &Path, timeout: Duration) -> Result<()> {
    let started = Instant::now();
    let result = loop {
        let mut command = Command::new(binary);
        command.arg("--help").current_dir(
            binary
                .parent()
                .ok_or("BBDown executable requires a parent")?,
        );
        match timed_output(command, timeout.saturating_sub(started.elapsed())) {
            // A concurrent fork can briefly inherit a writable extraction FD.
            // No child was created on ETXTBSY: retry only that spawn condition,
            // within the original help budget and at most one second.
            Err(error)
                if cfg!(unix)
                    && error
                        .downcast_ref::<io::Error>()
                        .is_some_and(|error| error.kind() == io::ErrorKind::ExecutableFileBusy)
                    && started.elapsed() < timeout.min(Duration::from_secs(1)) =>
            {
                std::thread::sleep(Duration::from_millis(10));
            }
            result => break result?,
        }
    };
    let output = format!(
        "{}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    let pattern = Regex::new(r"(?i)\b(?:v|version\s*)?(\d+(?:\.\d+){1,3})")?;
    if !result.status.success()
        || pattern
            .captures(&output)
            .and_then(|c| c.get(1))
            .map(|v| v.as_str())
            != Some(VERSION)
    {
        return Err(format!(
            "Pinned BBDown executable validation failed (exit={}): {}",
            result.status,
            output.trim()
        )
        .into());
    }
    Ok(())
}

fn metadata(root: &Path, recipe: &Recipe<'_>, source: &str) -> Result<String> {
    let license = root.join("third_party/BBDown-LICENSE.txt");
    if !license.is_file() {
        return Err(format!("BBDown license file is missing: {}", license.display()).into());
    }
    let license = license
        .to_str()
        .ok_or("BBDown license path must be UTF-8")?;
    let fields = [
        ("BILIKARA_BBDOWN_VERSION", VERSION),
        ("BILIKARA_BBDOWN_RELEASE_COMMIT", RELEASE_COMMIT),
        ("BILIKARA_BBDOWN_SOURCE_URL", source),
        ("BILIKARA_BBDOWN_ARCHIVE_NAME", recipe.name),
        ("BILIKARA_BBDOWN_SHA256", recipe.sha256),
        ("BILIKARA_BBDOWN_LICENSE_FILE", license),
    ];
    let mut text = String::new();
    for (key, value) in fields {
        if value.contains(['\r', '\n', '\0']) {
            return Err("Invalid multiline BBDown metadata value".into());
        }
        text.push_str(&format!(
            "{key}={value}{}",
            if cfg!(windows) { "\r\n" } else { "\n" }
        ));
    }
    Ok(text)
}

fn output_directory(root: &Path, output: &Path) -> Result<PathBuf> {
    let absolute = if output.is_absolute() {
        output.to_owned()
    } else {
        env::current_dir()?.join(output)
    };
    let mut path = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                return Err("Unsafe BBDown output traversal".into());
            }
            value => path.push(value.as_os_str()),
        }
    }
    // Resolve existing parents consistently (including Windows verbatim drive
    // prefixes and macOS /var). The owned output itself must never be a link.
    let path = crate::libav_prepare::absolute(&path)?;
    let root = root.canonicalize()?;
    if root.starts_with(&path)
        || [
            ".git",
            "rust",
            "rust-runtime",
            "src-tauri",
            "xtask",
            "static",
            "bilikara",
            "scripts",
            "media-libav",
            "third_party",
        ]
        .iter()
        .any(|name| path.starts_with(root.join(name)))
    {
        return Err("BBDown output overlaps source or checkout".into());
    }
    for ancestor in path.ancestors() {
        if ancestor.file_name().is_some_and(|n| n == "runtime") {
            return Err("BBDown output overlaps runtime data".into());
        }
        if let Ok(meta) = fs::symlink_metadata(ancestor) {
            if meta.file_type().is_symlink() || !meta.is_dir() {
                return Err("Unsafe BBDown output directory".into());
            }
            if ancestor.join("native-desktop.json").exists()
                || ancestor.join("_internal/native-desktop.json").exists()
                || ancestor.join("Contents/Info.plist").exists()
            {
                return Err("BBDown output overlaps installed application".into());
            }
        }
    }
    for owned in [path.join("bin"), path.join("metadata.env")] {
        if owned.is_symlink() {
            return Err("Linked BBDown output is unsafe".into());
        }
    }
    if path.join("bin").exists() && !path.join("bin").is_dir() {
        return Err("Invalid BBDown bin directory".into());
    }
    if path.join("metadata.env").exists() && !path.join("metadata.env").is_file() {
        return Err("Invalid BBDown metadata output".into());
    }
    Ok(path)
}

fn prepare(root: &Path, output: &Path, platform: Platform, recipe: &Recipe<'_>) -> Result<PathBuf> {
    if platform.target() != Platform::current()?.target() {
        return Err("Prepare BBDown on a matching native target/architecture runner".into());
    }
    let output = output_directory(root, output)?;
    // Fail missing/injectable license metadata before acquisition or payload execution.
    metadata(root, recipe, &recipe.sources[0])?;
    // Keep staging on the destination filesystem, including existing mounted
    // vendor roots. Only this unique temporary directory is cleaned on failure.
    fs::create_dir_all(&output)?;
    let staging = tempfile::Builder::new()
        .prefix(".bilikara-bbdown-")
        .tempdir_in(&output)?;
    let archive = staging.path().join("asset.zip");
    let source = download(recipe, &archive)?;
    let name = platform.executable("BBDown");
    let binary = staging.path().join(&name);
    extract(&archive, &binary, &name, recipe.max_binary)?;
    validate_help(&binary, recipe.help_timeout)?;
    let marker = staging.path().join("metadata.env");
    let mut file = File::create(&marker)?;
    file.write_all(metadata(root, recipe, &source)?.as_bytes())?;
    file.sync_all()?;
    drop(file);
    output_directory(root, &output)?;
    let destination = output.join("bin").join(name);
    if destination.is_symlink() || (destination.exists() && !destination.is_file()) {
        return Err("Unsafe BBDown binary output".into());
    }
    fs::create_dir_all(output.join("bin"))?;
    publish(
        &binary,
        &marker,
        &destination,
        &output.join("metadata.env"),
        staging.path(),
    )?;
    Ok(destination)
}

// Only the two owned files are replaced. Remove the old success marker first,
// publish the already-validated executable, then seal with metadata last.
fn publish(
    binary: &Path,
    marker: &Path,
    destination: &Path,
    metadata: &Path,
    staging: &Path,
) -> Result<()> {
    let old_binary = staging.join("previous-binary");
    let old_marker = staging.join("previous-metadata");
    if metadata.exists() {
        fs::rename(metadata, &old_marker)?;
    }
    if destination.exists()
        && let Err(error) = fs::rename(destination, &old_binary)
    {
        if old_marker.exists() {
            fs::rename(&old_marker, metadata)?;
        }
        return Err(error.into());
    }
    let result = fs::rename(binary, destination).and_then(|()| fs::rename(marker, metadata));
    if let Err(error) = result {
        if destination.exists() {
            fs::remove_file(destination)?;
        }
        if old_binary.exists() {
            fs::rename(&old_binary, destination)?;
        }
        if old_marker.exists() {
            fs::rename(&old_marker, metadata)?;
        }
        return Err(error.into());
    }
    Ok(())
}

#[cfg(test)]
#[path = "bbdown_tests.rs"]
mod tests;
