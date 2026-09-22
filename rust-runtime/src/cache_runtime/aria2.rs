//! The retained DownKyi transfer, supervised by Rust. No scheduler or publication
//! authority here. Only trusted Host configuration can construct an Executable.
use super::*;
use std::process::Command;

mod prepare;

#[derive(Clone, Debug)]
pub(crate) struct Executable {
    pub(super) path: PathBuf,
    pub(crate) version: String,
    pub(super) connections: u8,
}

impl Executable {
    pub(crate) fn can_prepare(vendor_roots: &[PathBuf]) -> bool {
        prepare::can_prepare(vendor_roots)
    }

    pub(super) fn check(path: PathBuf, cancel: &AtomicBool) -> Option<Self> {
        if !cfg!(any(
            target_os = "windows",
            target_os = "linux",
            target_os = "macos"
        )) || !path.is_absolute()
            || !path.is_file()
        {
            return None;
        }
        let path = path.canonicalize().ok()?;
        let mut probe = command(&path);
        probe.args(["--no-conf", "--version"]);
        let output = super::child::supervise(
            probe,
            cancel,
            Duration::from_secs(5),
            true,
            || {},
            &|_, _| {},
            "aria2c",
        )
        .ok()?;
        let text = String::from_utf8_lossy(&output);
        let version = text
            .lines()
            .find_map(|line| line.strip_prefix("aria2 version "))?
            .trim();
        let parts: Vec<_> = version.split('.').map(str::parse::<u32>).collect();
        if parts.len() != 3
            || parts.iter().any(Result::is_err)
            || parts[0] != Ok(1)
            || !text.lines().any(|line| {
                line.strip_prefix("Enabled Features:")
                    .is_some_and(|features| {
                        features
                            .split(|c: char| !c.is_ascii_alphanumeric())
                            .any(|feature| feature == "HTTPS")
                    })
            })
        {
            return None;
        }
        // Validate needed options instead of rejecting older working distro
        // builds just because they predate the currently pinned release assets.
        let mut help = command(&path);
        help.args(["--no-conf", "--help=#all"]);
        let help = super::child::supervise(
            help,
            cancel,
            Duration::from_secs(5),
            true,
            || {},
            &|_, _| {},
            "aria2c",
        )
        .ok()?;
        let help = String::from_utf8_lossy(&help);
        if [
            "--no-netrc",
            "--input-file",
            "--load-cookies",
            "--max-connection-per-server",
            "--human-readable",
            "--file-allocation",
            "--check-certificate",
            "--allow-overwrite",
            "--enable-rpc",
        ]
        .iter()
        .any(|option| !help.contains(option))
        {
            return None;
        }
        Some(Self {
            path,
            version: version.into(),
            connections: connection_limit(
                std::env::var("BILIKARA_ARIA2_CONNECTIONS_PER_TRACK")
                    .ok()
                    .as_deref(),
            ),
        })
    }

    /// Shared source-specific preparation. No public endpoint can supply paths.
    pub(crate) fn prepare(
        directory: &Path,
        override_path: Option<PathBuf>,
        vendor_roots: &[PathBuf],
        install: bool,
        cancel: &AtomicBool,
    ) -> Result<Self, CacheRuntimeError> {
        prepare::prepare(directory, override_path, vendor_roots, install, cancel)
    }
}

fn connection_limit(value: Option<&str>) -> u8 {
    value
        .and_then(|s| s.trim().parse::<i64>().ok())
        .unwrap_or(16)
        .clamp(1, 16) as u8
}

fn command(path: &Path) -> Command {
    let mut command = Command::new(path);
    // Only the admitted attempt's private cookie jar supplies credentials.
    for key in [
        "BILIKARA_BILIBILI_COOKIE",
        "BILIBILI_COOKIE",
        "BB_DOWN_PATH",
        "ARIA2C_PATH",
    ] {
        command.env_remove(key);
    }
    // Debian's locally extracted libaria2 and dependencies stay beside the tool.
    #[cfg(target_os = "linux")]
    if let Some(parent) = path.parent() {
        let mut paths = vec![parent.to_path_buf()];
        if let Some(existing) = std::env::var_os("LD_LIBRARY_PATH") {
            paths.extend(std::env::split_paths(&existing));
        }
        if let Ok(joined) = std::env::join_paths(paths) {
            command.env("LD_LIBRARY_PATH", joined);
        }
    }
    command
}

/// Use the existing preferred-source policy, deliberately not Native's regular
/// audio quality ranking: first regular, FLAC, Dolby have DownKyi semantics.
pub(super) fn select_audio(
    dash: &crate::bilibili_service::BilibiliDashResult,
    hires: bool,
) -> Result<BilibiliStream, CacheRuntimeError> {
    use bilikara_rust::{
        PreferredAudioSource, PreferredAudioSourceRequest, PreferredAudioSourceSelection,
        PreferredRegularAudioCandidate, select_preferred_audio_source,
    };
    let selection = select_preferred_audio_source(&PreferredAudioSourceRequest {
        audio_hires: hires,
        regular_candidates: (0..dash.audio.len())
            .map(|original_index| PreferredRegularAudioCandidate { original_index })
            .collect(),
        flac_available: dash.flac.is_some(),
        dolby_available: dash.dolby.is_some(),
    })
    .map_err(|_| CacheRuntimeError::new("selection", "Invalid DownKyi audio preference"))?;
    let selected = match selection {
        PreferredAudioSourceSelection::Selected {
            preferred_source: PreferredAudioSource::Flac,
            ..
        } => dash.flac.as_ref(),
        PreferredAudioSourceSelection::Selected {
            preferred_source: PreferredAudioSource::Dolby,
            ..
        } => dash.dolby.as_ref(),
        PreferredAudioSourceSelection::Selected {
            selected_regular_index: Some(index),
            ..
        } => dash.audio.get(index),
        _ => None,
    };
    selected
        .cloned()
        .ok_or_else(|| CacheRuntimeError::new("selection", "No DownKyi audio stream available"))
}

fn invalid() -> CacheRuntimeError {
    CacheRuntimeError::new("invalid_request", "Unsafe DownKyi transfer input")
}
fn field(value: &str) -> Result<(), CacheRuntimeError> {
    if value.len() > 16384 || value.chars().any(|c| c.is_control()) {
        Err(invalid())
    } else {
        Ok(())
    }
}
fn trusted_cookie_host(host: &str) -> bool {
    [
        "bilibili.com",
        "bilivideo.com",
        "bilivideo.cn",
        "biliapi.net",
    ]
    .iter()
    .any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}")))
}

struct Inputs {
    input: PathBuf,
    cookies: PathBuf,
}
impl Drop for Inputs {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.input);
        let _ = fs::remove_file(&self.cookies);
    }
}
fn private_write(path: &Path, data: &[u8]) -> Result<(), CacheRuntimeError> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .and_then(|mut f| f.write_all(data))
        .map_err(|_| CacheRuntimeError::new("storage", "Cannot write private aria2c input"))
}
fn inputs(
    job: &CacheJobSpec,
    stream: &BilibiliStream,
    path: &Path,
) -> Result<Inputs, CacheRuntimeError> {
    let request = download_request(job, stream, path.into())?;
    let directory = path.parent().ok_or_else(invalid)?;
    let files = Inputs {
        input: directory.join("aria2.input"),
        cookies: directory.join("aria2.cookies"),
    };
    let mut urls = Vec::new();
    let mut hosts = HashSet::new();
    for candidate in &request.candidates {
        field(&candidate.url)?;
        let url = url::Url::parse(&candidate.url).map_err(|_| invalid())?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
            || candidate.url.chars().any(char::is_whitespace)
        {
            return Err(invalid());
        }
        let host = url.host_str().unwrap();
        if trusted_cookie_host(host) {
            hosts.insert(host.to_owned());
        }
        urls.push(candidate.url.as_str());
    }
    if urls.is_empty() || urls.len() > 32 {
        return Err(invalid());
    }
    field(&job.cookie)?;
    // A scoped cookie jar, not a generic Cookie header: aria2 must not forward
    // credentials to unrelated hosts on redirects. No user cookie files loaded.
    let mut cookies = String::from("# Netscape HTTP Cookie File\n");
    for piece in job
        .cookie
        .split(';')
        .map(str::trim)
        .filter(|p| !p.is_empty())
    {
        let (name, value) = piece.split_once('=').ok_or_else(invalid)?;
        if name.is_empty()
            || !name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-.".contains(&b))
        {
            return Err(invalid());
        }
        for host in &hosts {
            cookies.push_str(&format!("{host}\tFALSE\t/\tFALSE\t0\t{name}\t{value}\n"));
        }
    }
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(invalid)?;
    field(name)?;
    let mut input = format!("{}\n out={}\n", urls.join("\t"), name);
    for header in &request.candidates[0].headers {
        if header.name.eq_ignore_ascii_case("cookie") {
            continue;
        }
        field(&header.value)?;
        input.push_str(&format!(" header={}: {}\n", header.name, header.value));
    }
    private_write(&files.cookies, cookies.as_bytes())?;
    private_write(&files.input, input.as_bytes())?;
    Ok(files)
}

#[derive(Default)]
struct Output {
    pending: Vec<u8>,
    bytes: Option<(u64, u64)>,
    status: Option<u16>,
}
impl Output {
    fn consume(&mut self, chunk: &[u8]) {
        for byte in chunk {
            if matches!(byte, b'\n' | b'\r') {
                self.line();
                self.pending.clear();
            } else if self.pending.len() < 8192 {
                self.pending.push(*byte);
            }
        }
    }
    fn line(&mut self) {
        let line = String::from_utf8_lossy(&self.pending);
        // Only exact byte readouts. Never derive transferred bytes from stat or
        // rounded percentages, and never retain/output raw child diagnostics.
        static PROGRESS: OnceLock<regex::Regex> = OnceLock::new();
        let re = PROGRESS.get_or_init(|| {
            regex::Regex::new(r"\[#[0-9a-fA-F]+\s+([0-9]+)B?/([0-9]+)B?\(").unwrap()
        });
        if let Some(c) = re.captures(&line)
            && let (Ok(done), Ok(total)) = (c[1].parse::<u64>(), c[2].parse::<u64>())
            && total > 0
            && done <= total
        {
            self.bytes = Some((done, total));
        }
        static STATUS: OnceLock<regex::Regex> = OnceLock::new();
        if let Some(capture) = STATUS
            .get_or_init(|| regex::Regex::new(r"\bstatus=(401|402|403)\b").unwrap())
            .captures(&line)
        {
            self.status = capture[1].parse().ok();
        }
    }
}

pub(super) fn download(
    executable: &Executable,
    job: &CacheJobSpec,
    stream: &BilibiliStream,
    path: &Path,
    cancel: &AtomicBool,
    mut progress: impl FnMut((u64, u64)),
) -> Result<(), CacheRuntimeError> {
    let files = inputs(job, stream, path)?;
    let directory = path.parent().ok_or_else(invalid)?;
    let mut command = command(&executable.path);
    command
        .current_dir(directory)
        .args([
            "--no-conf",
            "--no-netrc=true",
            "--enable-rpc=false",
            "--follow-torrent=false",
            "--follow-metalink=false",
            "--continue=false",
            "--auto-file-renaming=false",
            "--allow-overwrite=false",
            "--max-tries=1",
            "--retry-wait=3",
            "--min-split-size=5M",
            "--max-concurrent-downloads=1",
            "--uri-selector=inorder",
            "--file-allocation=none",
            "--human-readable=false",
            "--summary-interval=1",
            "--console-log-level=notice",
            "--download-result=hide",
            "--check-certificate=true",
            "--connect-timeout=15",
            "--timeout=15",
            "--auto-save-interval=0",
        ])
        .arg(format!("--split={}", executable.connections))
        .arg(format!(
            "--max-connection-per-server={}",
            executable.connections
        ))
        .arg("--input-file")
        .arg(&files.input)
        .arg("--load-cookies")
        .arg(&files.cookies)
        .arg("--dir")
        .arg(directory);
    // Same trusted process-local CA override as the shared Rust HTTPS client;
    // no certificate bypass and no public configuration route.
    if let Some(ca) = std::env::var_os("SSL_CERT_FILE") {
        command.arg("--ca-certificate").arg(ca);
    }
    let output = Mutex::new([Output::default(), Output::default()]);
    let mut last = None;
    let result = super::child::supervise(
        command,
        cancel,
        Duration::from_secs(3600),
        false,
        || {
            let bytes = output.lock().unwrap_or_else(|p| p.into_inner())[0].bytes;
            if bytes != last {
                if let Some(bytes) = bytes {
                    progress(bytes);
                }
                last = bytes;
            }
        },
        &|stderr, chunk| {
            output.lock().unwrap_or_else(|p| p.into_inner())[usize::from(stderr)].consume(chunk)
        },
        "DownKyi/aria2c",
    );
    let mut output = output.into_inner().unwrap_or_else(|p| p.into_inner());
    for stream in &mut output {
        stream.line();
    }
    if let Some(bytes) = output[0].bytes {
        progress(bytes);
    }
    drop(files); // secret-bearing inputs removed before validation or retry
    if let Err(error) = result {
        if error.kind == "cancelled" {
            return Err(error);
        }
        if let Some(status) = output[0].status.or(output[1].status) {
            return Err(CacheRuntimeError {
                kind: match status {
                    401 => "authentication",
                    402 => "unavailable",
                    _ => "forbidden",
                }
                .into(),
                message: format!("DownKyi/aria2c media access rejected (HTTP {status})"),
                status_code: Some(status),
                api_code: None,
            });
        }
        return Err(error);
    }
    // Successful exit is not a completed track. No control/extra files, aliases,
    // directories or symlinks are acceptable output in the owned attempt.
    let entries = fs::read_dir(directory)
        .map_err(|_| CacheRuntimeError::new("storage", "Cannot inspect aria2c output"))?;
    let mut count = 0;
    for entry in entries {
        let entry =
            entry.map_err(|_| CacheRuntimeError::new("storage", "Cannot inspect aria2c output"))?;
        let meta = fs::symlink_metadata(entry.path())
            .map_err(|_| CacheRuntimeError::new("invalid_media", "Missing aria2c output"))?;
        if entry.path() != path
            || !meta.is_file()
            || meta.file_type().is_symlink()
            || meta.len() == 0
        {
            return Err(CacheRuntimeError::new(
                "media_contract_violation",
                "Unexpected or partial aria2c output",
            ));
        }
        count += 1;
    }
    if count != 1 {
        return Err(CacheRuntimeError::new(
            "media_contract_violation",
            "aria2c exited without a complete track",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn stream(url: &str) -> BilibiliStream {
        BilibiliStream {
            url: url.into(),
            backup_urls: vec![],
            codec_id: None,
            codec_name: None,
            codecs: None,
            mime_type: None,
            width: None,
            height: None,
            quality_id: None,
            bandwidth: None,
            order: None,
        }
    }
    fn job(root: &Path) -> CacheJobSpec {
        serde_json::from_value(json!({"item_id":"a","item_incarnation_id":"i-fixture", "bvid":"BV1xx411c7mD","video_page":1,
            "pages":[{"page":1,"cid":457}],"cache_root":root,"log_file":root.join("cache.log"),"cookie":"SESSDATA=synthetic; bili_jct=csrf"})).unwrap()
    }
    fn root() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "aria2-test-{}-{}",
            std::process::id(),
            ATTEMPT_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        root
    }
    #[test]
    fn preferred_audio_preserves_first_regular_flac_dolby_order() {
        let dash = crate::bilibili_service::BilibiliDashResult {
            video: vec![],
            audio: vec![stream("first"), stream("second")],
            flac: Some(stream("flac")),
            dolby: Some(stream("dolby")),
        };
        assert_eq!(select_audio(&dash, false).unwrap().url, "first");
        assert_eq!(select_audio(&dash, true).unwrap().url, "dolby");
        let no_dolby = crate::bilibili_service::BilibiliDashResult {
            dolby: None,
            ..dash.clone()
        };
        assert_eq!(select_audio(&no_dolby, true).unwrap().url, "flac");
        let no_flac = crate::bilibili_service::BilibiliDashResult {
            flac: None,
            ..dash.clone()
        };
        assert_eq!(select_audio(&no_flac, true).unwrap().url, "dolby");
        let only_dolby = crate::bilibili_service::BilibiliDashResult {
            audio: vec![],
            ..no_flac
        };
        assert_eq!(select_audio(&only_dolby, true).unwrap().url, "dolby");
        assert!(select_audio(&only_dolby, false).is_err());
    }
    #[test]
    fn input_is_private_scoped_ordered_and_rejects_injected_options() {
        let root = root();
        let mut job = job(&root);
        let path = root.join("track.raw");
        let mut stream = stream("https://one.bilivideo.com/media?token=synthetic");
        stream.backup_urls = vec![
            "https://two.bilivideo.com/media?token=synthetic".into(),
            stream.url.clone(),
            "http://127.0.0.1/unrelated".into(),
        ];
        let files = inputs(&job, &stream, &path).unwrap();
        let input = fs::read_to_string(&files.input).unwrap();
        let cookies = fs::read_to_string(&files.cookies).unwrap();
        assert!(input.starts_with("https://one.bilivideo.com/media?token=synthetic\thttps://two.bilivideo.com/media?token=synthetic\thttp://127.0.0.1/unrelated\n"));
        assert!(!input.contains("SESSDATA"));
        assert!(cookies.contains("one.bilivideo.com\tFALSE"));
        assert!(!cookies.contains("127.0.0.1"));
        drop(files);
        assert!(!root.join("aria2.cookies").exists());
        assert!(!root.join("aria2.input").exists());
        for url in [
            "https://one.bilivideo.com/a\n out=escape",
            "https://user:password@one.bilivideo.com/a",
            "file:///etc/passwd",
            "https://one.bilivideo.com/a\t--hook=bad",
        ] {
            stream.url = url.into();
            assert!(inputs(&job, &stream, &path).is_err());
        }
        stream.url = "https://one.bilivideo.com/a".into();
        job.user_agent = "agent\r\n header=Injected: bad".into();
        assert!(inputs(&job, &stream, &path).is_err());
        assert!(!root.join("aria2.cookies").exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn progress_is_bounded_exact_bytes_never_a_percentage_or_file_length() {
        let mut o = Output::default();
        o.consume(b"[#abc 128B/1000000B(0%) CN:1]\r");
        assert_eq!(o.bytes, Some((128, 1000000)));
        o.consume(b"[#abc 1MiB/20MiB(5%)]\n");
        assert_eq!(o.bytes, Some((128, 1000000)));
        o.consume(b"[#abc 900/800(99%)]\n");
        assert_eq!(o.bytes, Some((128, 1000000)));
        o.consume(&vec![b'x'; 100000]);
        assert_eq!(o.pending.len(), 8192);
        o.consume(b"\n");
        o.consume(b"credential-bearing diagnostic status=403\n");
        assert_eq!(o.status, Some(403));
    }
    #[test]
    fn trusted_connection_budget_preserves_configured_bounds() {
        for (value, expected) in [
            (None, 16),
            (Some("3"), 3),
            (Some("-1"), 1),
            (Some("20"), 16),
            (Some("invalid"), 16),
        ] {
            assert_eq!(connection_limit(value), expected);
        }
    }
    #[test]
    fn missing_override_fails_without_discovery_or_install() {
        let root = root();
        let missing = root.join("missing");
        assert_eq!(
            Executable::prepare(&root, Some(missing), &[], true, &AtomicBool::new(false))
                .unwrap_err()
                .kind,
            "invalid_override"
        );
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn generic_job_cannot_select_executable_and_cancellation_interrupts_retry_wait() {
        assert!(
            serde_json::from_value::<CacheJobSpec>(
                json!({"executor":"downkyi","program":"/bin/true"})
            )
            .is_err()
        );
        let cancel = AtomicBool::new(true);
        let start = Instant::now();
        assert!(!wait_for_retry(&cancel, 1));
        assert!(start.elapsed() < Duration::from_millis(100));
    }
}
