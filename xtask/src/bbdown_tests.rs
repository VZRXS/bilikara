use super::*;
use crate::{
    config::{Config, Environment},
    tools,
};
use std::{
    collections::BTreeMap,
    io::Cursor,
    net::TcpListener,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    thread,
};
use tempfile::TempDir;
use zip::{ZipWriter, write::SimpleFileOptions};

#[test]
fn independent_pins_and_target_aliases() {
    let expected = [
        (
            "windows",
            "x64",
            "BBDown_1.6.3_20240814_win-x64.zip",
            "40f1e2af0d4e74df765c6f93d2e931f9bea201d5168d0bc62dc35a54b7e0ec02",
        ),
        (
            "windows",
            "arm64",
            "BBDown_1.6.3_20240814_win-arm64.zip",
            "da8fc9cbf1031f4c4ca97af82d98bbfd1bbc55bd8ea49602da8d3d1613c190ff",
        ),
        (
            "macos",
            "x64",
            "BBDown_1.6.3_20240814_osx-x64.zip",
            "262c15ca7890898560d00e5ffd5ada1864fbd9d0d58ac4ee492c9f3e73f3ae5f",
        ),
        (
            "macos",
            "arm64",
            "BBDown_1.6.3_20240814_osx-arm64.zip",
            "4df84014d818bd6dff2b365b847645340e8955c4450fe965688f41af89a38baa",
        ),
        (
            "linux",
            "x64",
            "BBDown_1.6.3_20240814_linux-x64.zip",
            "ec233b7d8d40b1cc4447dac05be343f53a757dc605743a8808abaa8e97e5d10e",
        ),
        (
            "linux",
            "arm64",
            "BBDown_1.6.3_20240814_linux-arm64.zip",
            "f58e0a18df1a589375428a0af27ea61f5ce96ffaf67d115f335d5f9bee9a34dc",
        ),
    ];
    assert_eq!(VERSION, "1.6.3");
    assert_eq!(RELEASE_COMMIT, "45622f79cd766e0fc6f5cbd49fcf4960340f35c3");
    assert_eq!(
        RELEASE_BASE,
        "https://github.com/nilaoda/BBDown/releases/download/1.6.3"
    );
    assert_eq!(MIRROR_BASE, "https://download.kevinx96.icu/bilikara/tools");
    for (os, arch, name, hash) in expected {
        let actual = asset(platform(os, arch).unwrap());
        assert_eq!((actual.name, actual.sha256), (name, hash));
    }
    for os in ["Darwin", " macOS "] {
        assert_eq!(
            platform(os, "aarch64").unwrap().target(),
            "aarch64-apple-darwin"
        );
    }
    for os in ["Windows", "win32", "WIN"] {
        for arch in [" AMD64 ", "x86_64", "X64"] {
            assert_eq!(
                platform(os, arch).unwrap().target(),
                "x86_64-pc-windows-msvc"
            );
        }
    }
    for (os, arch) in [
        ("android", "arm64"),
        ("linux", "x86"),
        ("linux", "armv7"),
        ("unknown", "amd64"),
    ] {
        assert!(platform(os, arch).is_err());
    }
}

// Native Rust executables, never shell/Python wrappers. One compilation per mode
// is shared across tests and also works in the copied standalone source kit.
fn native(mode: &str) -> &'static [u8] {
    static BINARIES: OnceLock<BTreeMap<&str, Vec<u8>>> = OnceLock::new();
    BINARIES.get_or_init(|| {
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("native.rs");
        fs::write(&source, r#"
fn main() {
    let args: Vec<_> = std::env::args_os().collect();
    if args.len() != 2 || args[1] != "--help" { std::process::exit(17); }
    match env!("BBDOWN_FIXTURE_MODE") {
        "wrong" => println!("BBDown version 1.6.30, Bilibili Downloader."),
        "extended" => println!("BBDown version 1.6.3.0"),
        "nonzero" => { println!("BBDown version 1.6.3"); std::process::exit(7); },
        "sleep" => {
            std::fs::write(std::env::current_exe().unwrap().with_extension("pid"), std::process::id().to_string()).unwrap();
            std::thread::sleep(std::time::Duration::from_secs(60));
        },
        "stderr" => eprintln!("BBDown version 1.6.3, Bilibili Downloader."),
        "cwd" => {
            assert_eq!(std::env::current_dir().unwrap().canonicalize().unwrap(), std::env::current_exe().unwrap().parent().unwrap().canonicalize().unwrap());
            println!("BBDown version 1.6.3");
        },
        _ => println!("BBDown version 1.6.3, Bilibili Downloader."),
    }
}
"#).unwrap();
        let mut binaries = BTreeMap::new();
        for mode in ["valid", "wrong", "extended", "nonzero", "sleep", "stderr", "cwd"] {
            let binary = temp.path().join(Platform::current().unwrap().executable(mode));
            let output = Command::new("rustc").current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
                .arg(&source).args(["--crate-name", "bbdown_fixture", "--edition", "2024", "--target"])
                .arg(Platform::current().unwrap().target()).arg("-o")
                .arg(&binary).env("BBDOWN_FIXTURE_MODE", mode).output().unwrap();
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
            binaries.insert(mode, fs::read(binary).unwrap());
        }
        binaries
    }).get(mode).unwrap()
}

fn zip_bytes(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in entries {
        writer
            .start_file(
                *name,
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated),
            )
            .unwrap();
        writer.write_all(bytes).unwrap();
    }
    writer.finish().unwrap().into_inner()
}

struct Http {
    base: String,
    requests: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}
impl Http {
    fn new(responses: Vec<(u16, Vec<u8>, Option<usize>)>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let worker_requests = requests.clone();
        let worker_stop = stop.clone();
        let worker = thread::spawn(move || {
            let mut responses = responses.into_iter();
            while !worker_stop.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        // Winsock inherits the listener's nonblocking state.
                        // Reading the complete HTTP headers is a bounded blocking operation.
                        stream.set_nonblocking(false).unwrap();
                        stream
                            .set_read_timeout(Some(Duration::from_secs(2)))
                            .unwrap();
                        let mut request = Vec::new();
                        let mut byte = [0];
                        while stream.read(&mut byte).unwrap_or(0) == 1 {
                            request.push(byte[0]);
                            if request.ends_with(b"\r\n\r\n") {
                                break;
                            }
                        }
                        // A connection probe is not an HTTP request. In particular,
                        // Windows can open and retire a socket before sending bytes.
                        if request.is_empty() {
                            continue;
                        }
                        assert!(
                            request.ends_with(b"\r\n\r\n"),
                            "Incomplete fixture request: {request:?}"
                        );
                        worker_requests
                            .lock()
                            .unwrap()
                            .push(String::from_utf8(request).unwrap());
                        let (status, body, length) =
                            responses.next().unwrap_or((500, Vec::new(), None));
                        if status == 0 {
                            thread::sleep(Duration::from_millis(500));
                            continue;
                        }
                        let redirect = if status == 302 {
                            "Location: /redirect.zip\r\n"
                        } else {
                            ""
                        };
                        let header = format!(
                            "HTTP/1.1 {status} fixture\r\n{redirect}Content-Length: {}\r\nConnection: close\r\n\r\n",
                            length.unwrap_or(body.len())
                        );
                        let _ = stream.write_all(header.as_bytes());
                        let _ = stream.write_all(&body);
                    }
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5))
                    }
                    Err(error) => panic!("{error}"),
                }
            }
        });
        Self {
            base,
            requests,
            stop,
            worker: Some(worker),
        }
    }
    fn sources(&self) -> [String; 2] {
        [
            format!("{}/primary.zip", self.base),
            format!("{}/mirror.zip", self.base),
        ]
    }
    fn paths(&self) -> Vec<String> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .map(|request| {
                assert!(
                    request
                        .to_ascii_lowercase()
                        .contains("user-agent: bilikara-bundle-builder\r\n"),
                    "Unexpected fixture HTTP headers: {request:?}"
                );
                request.split_whitespace().nth(1).unwrap().to_owned()
            })
            .collect()
    }
}
impl Drop for Http {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        self.worker.take().unwrap().join().unwrap();
    }
}

struct Fixture {
    temp: TempDir,
    root: PathBuf,
    output: PathBuf,
    bytes: Vec<u8>,
    hash: String,
}
impl Fixture {
    fn new(mode: &str) -> Self {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("source 工具");
        fs::create_dir_all(root.join("third_party")).unwrap();
        fs::write(
            root.join("third_party/BBDown-LICENSE.txt"),
            "MIT License\nfixture license\n",
        )
        .unwrap();
        let name = Platform::current().unwrap().executable("BBDown");
        let bytes = zip_bytes(&[(&format!("release/{name}"), native(mode))]);
        let hash = format!("{:x}", Sha256::digest(&bytes));
        let output = temp.path().join("vendor 空间 & ' $name");
        Self {
            temp,
            root,
            output,
            bytes,
            hash,
        }
    }
    fn recipe(&self, sources: [String; 2]) -> Recipe<'_> {
        Recipe {
            name: "fixture.zip",
            sha256: &self.hash,
            sources,
            transfer_timeout: Duration::from_secs(3),
            help_timeout: Duration::from_secs(3),
            max_archive: MAX_ARCHIVE,
            max_binary: MAX_BINARY,
        }
    }
    fn prepare(&self, http: &Http) -> Result<PathBuf> {
        prepare(
            &self.root,
            &self.output,
            Platform::current()?,
            &self.recipe(http.sources()),
        )
    }
}

#[test]
fn primary_success_exact_bytes_metadata_repeat_and_release_discovery() {
    let fixture = Fixture::new("valid");
    let http = Http::new(vec![
        (200, fixture.bytes.clone(), None),
        (200, fixture.bytes.clone(), None),
    ]);
    for _ in 0..2 {
        let binary = fixture.prepare(&http).unwrap();
        assert_eq!(fs::read(&binary).unwrap(), native("valid"));
        validate_help(&binary, Duration::from_secs(3)).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_ne!(
                fs::metadata(&binary).unwrap().permissions().mode() & 0o100,
                0
            );
        }
        let fields = fs::read_to_string(fixture.output.join("metadata.env")).unwrap();
        let expected = [
            ("BILIKARA_BBDOWN_VERSION", "1.6.3".to_owned()),
            (
                "BILIKARA_BBDOWN_RELEASE_COMMIT",
                "45622f79cd766e0fc6f5cbd49fcf4960340f35c3".to_owned(),
            ),
            (
                "BILIKARA_BBDOWN_SOURCE_URL",
                format!("{}/primary.zip", http.base),
            ),
            ("BILIKARA_BBDOWN_ARCHIVE_NAME", "fixture.zip".to_owned()),
            ("BILIKARA_BBDOWN_SHA256", fixture.hash.clone()),
            (
                "BILIKARA_BBDOWN_LICENSE_FILE",
                fixture
                    .root
                    .join("third_party/BBDown-LICENSE.txt")
                    .to_str()
                    .unwrap()
                    .to_owned(),
            ),
        ];
        assert_eq!(
            fields.lines().collect::<Vec<_>>(),
            expected
                .iter()
                .map(|(k, v)| format!("{k}={v}"))
                .collect::<Vec<_>>()
        );
        let mut env = Environment::default();
        env.0.insert(
            "PATH".into(),
            env::join_paths([fixture.output.join("bin")]).unwrap(),
        );
        env.0
            .insert("BILIKARA_BBDOWN_VERSION".into(), "1.6.3".into());
        env.0.insert("TAURI_ENV_DEBUG".into(), "false".into());
        // The existing macOS release check requires otool. Use native discovery
        // there; its actual Mach-O portability gates remain in CI.
        let mut config =
            Config::new(&fixture.root, Platform::current().unwrap(), env, None).unwrap();
        assert_eq!(
            tools::bbdown_path(&config)
                .unwrap()
                .unwrap()
                .canonicalize()
                .unwrap(),
            binary.canonicalize().unwrap()
        );
        if config.platform.os == Os::Macos {
            config.development = true;
        }
        assert_eq!(
            tools::bbdown(&config)
                .unwrap()
                .unwrap()
                .canonicalize()
                .unwrap(),
            binary.canonicalize().unwrap()
        );
    }
    assert_eq!(http.paths(), ["/primary.zip", "/primary.zip"]);
    assert!(fs::read_dir(&fixture.output).unwrap().all(|e| {
        !e.unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".bilikara-bbdown-")
    }));
}

#[test]
fn mirror_is_used_only_for_transport_failure_and_records_selected_source() {
    for truncated in [false, true] {
        let fixture = Fixture::new("valid");
        let first = if truncated {
            (200, b"interrupted".to_vec(), Some(fixture.bytes.len()))
        } else {
            (503, b"unavailable".to_vec(), None)
        };
        let http = Http::new(vec![first, (200, fixture.bytes.clone(), None)]);
        fixture.prepare(&http).unwrap();
        assert_eq!(http.paths(), ["/primary.zip", "/mirror.zip"]);
        assert!(
            fs::read_to_string(fixture.output.join("metadata.env"))
                .unwrap()
                .contains(&format!(
                    "BILIKARA_BBDOWN_SOURCE_URL={}/mirror.zip",
                    http.base
                ))
        );
    }
}

#[test]
fn integrity_and_transport_failures_preserve_existing_valid_output() {
    let fixture = Fixture::new("valid");
    let good = Http::new(vec![(200, fixture.bytes.clone(), None)]);
    let binary = fixture.prepare(&good).unwrap();
    let before = fs::read(&binary).unwrap();
    let marker = fs::read(fixture.output.join("metadata.env")).unwrap();
    fs::write(fixture.output.join("unrelated.txt"), "keep").unwrap();
    for integrity in [false, true] {
        let replies = if integrity {
            vec![
                (200, b"not the pinned archive".to_vec(), None),
                (200, fixture.bytes.clone(), None),
            ]
        } else {
            vec![(404, Vec::new(), None), (503, Vec::new(), None)]
        };
        let http = Http::new(replies);
        let error = fixture.prepare(&http).unwrap_err().to_string();
        assert!(
            error.contains(if integrity {
                "SHA-256 mismatch"
            } else {
                "Unable to download"
            }),
            "{error}"
        );
        assert_eq!(http.paths().len(), if integrity { 1 } else { 2 });
        assert_eq!(fs::read(&binary).unwrap(), before);
        assert_eq!(
            fs::read(fixture.output.join("metadata.env")).unwrap(),
            marker
        );
        assert_eq!(
            fs::read_to_string(fixture.output.join("unrelated.txt")).unwrap(),
            "keep"
        );
    }
}

#[test]
fn incomplete_vendor_never_publishes_success_metadata() {
    for mode in ["wrong", "nonzero"] {
        let fixture = Fixture::new(mode);
        let http = Http::new(vec![(200, fixture.bytes.clone(), None)]);
        assert!(
            fixture
                .prepare(&http)
                .unwrap_err()
                .to_string()
                .contains("validation failed")
        );
        assert!(!fixture.output.join("metadata.env").exists());
        assert!(!fixture.output.join("bin").exists());
    }
    let mut fixture = Fixture::new("valid");
    fixture.bytes = b"bad ZIP with a matching digest".to_vec();
    fixture.hash = format!("{:x}", Sha256::digest(&fixture.bytes));
    let http = Http::new(vec![(200, fixture.bytes.clone(), None)]);
    assert!(fixture.prepare(&http).is_err());
    assert!(!fixture.output.join("metadata.env").exists());
    fs::remove_file(fixture.root.join("third_party/BBDown-LICENSE.txt")).unwrap();
    assert!(
        fixture
            .prepare(&http)
            .unwrap_err()
            .to_string()
            .contains("license file is missing")
    );
    assert_eq!(http.paths().len(), 1); // Missing license fails before a second download.
}

#[test]
fn archive_selects_one_regular_payload_and_rejects_unsafe_or_bounded_inputs() {
    let temp = TempDir::new().unwrap();
    let archive = temp.path().join("asset.zip");
    let target = temp.path().join("BBDown");
    for name in ["release/nested/bBdOwN", "release\\nested\\BBDown"] {
        fs::write(
            &archive,
            zip_bytes(&[(name, b"exact bytes"), ("other.txt", b"unused")]),
        )
        .unwrap();
        extract(&archive, &target, "BBDown", 64).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"exact bytes");
    }
    for entries in [
        vec![("other", b"x".as_slice())],
        vec![("a/BBDown", b"x".as_slice()), ("b/BBDown", b"x".as_slice())],
    ] {
        fs::write(&archive, zip_bytes(&entries)).unwrap();
        assert!(
            extract(&archive, &target, "BBDown", 64)
                .unwrap_err()
                .to_string()
                .contains("exactly one")
        );
    }
    // zip 2.x indexes by name: identical duplicates must not disappear before
    // the preparer enforces its one-payload rule. Keep both local/central names.
    let mut duplicate = zip_bytes(&[("a/BBDown", b"first"), ("b/BBDown", b"second")]);
    for index in 0..duplicate.len() - 8 {
        if &duplicate[index..index + 8] == b"b/BBDown" {
            duplicate[index] = b'a';
        }
    }
    fs::write(&archive, duplicate).unwrap();
    assert!(
        extract(&archive, &target, "BBDown", 64).is_err(),
        "identical duplicate ZIP names must fail"
    );
    for name in [
        "../BBDown",
        "/BBDown",
        "a/../BBDown",
        "C:/BBDown",
        "C:\\BBDown",
        "\\\\server\\BBDown",
        "\\?\\BBDown",
        "BBDown:stream",
    ] {
        fs::write(&archive, zip_bytes(&[(name, b"unsafe")])).unwrap();
        assert!(
            extract(&archive, &target, "BBDown", 64)
                .unwrap_err()
                .to_string()
                .contains("Unsafe"),
            "{name}"
        );
        assert_eq!(fs::read(&target).unwrap(), b"exact bytes");
    }
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    writer
        .add_symlink("BBDown", "elsewhere", SimpleFileOptions::default())
        .unwrap();
    fs::write(&archive, writer.finish().unwrap().into_inner()).unwrap();
    assert!(
        extract(&archive, &target, "BBDown", 64)
            .unwrap_err()
            .to_string()
            .contains("linked")
    );
    fs::write(&archive, zip_bytes(&[("BBDown", &[0; 65])])).unwrap();
    assert!(extract(&archive, &target, "BBDown", 64).is_err());
    fs::write(&archive, b"corrupt archive").unwrap();
    assert!(extract(&archive, &target, "BBDown", 64).is_err());
}

#[test]
fn help_requires_exact_version_success_and_kills_timed_out_native_child() {
    let temp = TempDir::new().unwrap();
    for mode in [
        "valid", "stderr", "cwd", "wrong", "extended", "nonzero", "sleep",
    ] {
        let archive = temp.path().join("asset.zip");
        let name = Platform::current().unwrap().executable(mode);
        let binary = temp.path().join(&name);
        fs::write(&archive, zip_bytes(&[(&name, native(mode))])).unwrap();
        extract(&archive, &binary, &name, MAX_BINARY).unwrap();
        let timeout = if mode == "sleep" {
            Duration::from_millis(500)
        } else {
            Duration::from_secs(3)
        };
        let result = validate_help(&binary, timeout);
        assert_eq!(
            result.is_ok(),
            matches!(mode, "valid" | "stderr" | "cwd"),
            "{mode}"
        );
        if mode == "sleep" {
            assert!(result.unwrap_err().to_string().contains("timed out"));
            let pid = fs::read_to_string(binary.with_extension("pid")).unwrap();
            #[cfg(unix)]
            {
                assert_eq!(unsafe { libc::kill(pid.parse().unwrap(), 0) }, -1);
            }
            #[cfg(windows)]
            {
                let output = Command::new("tasklist")
                    .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
                    .output()
                    .unwrap();
                assert!(!String::from_utf8_lossy(&output.stdout).contains(&format!("\"{pid}\"")));
            }
        }
    }
}

#[test]
#[cfg(target_os = "linux")]
fn help_retries_only_busy_spawn_within_the_original_deadline() {
    let temp = TempDir::new().unwrap();
    let archive = temp.path().join("asset.zip");
    let binary = temp.path().join("native BBDown 工具");
    fs::write(&archive, zip_bytes(&[("BBDown", native("valid"))])).unwrap();
    extract(&archive, &binary, "BBDown", MAX_BINARY).unwrap();
    let original = fs::read(&binary).unwrap();
    let writable = fs::OpenOptions::new().write(true).open(&binary).unwrap();
    let busy = Command::new(&binary).arg("--help").spawn().unwrap_err();
    assert_eq!(busy.raw_os_error(), Some(libc::ETXTBSY));
    let release = thread::spawn(move || {
        thread::sleep(Duration::from_millis(80));
        drop(writable);
    });
    validate_help(&binary, Duration::from_secs(2)).unwrap();
    release.join().unwrap();
    assert_eq!(fs::read(&binary).unwrap(), original);

    let _writable = fs::OpenOptions::new().write(true).open(&binary).unwrap();
    let started = Instant::now();
    let error = validate_help(&binary, Duration::from_millis(60)).unwrap_err();
    assert_eq!(
        error.downcast_ref::<io::Error>().unwrap().raw_os_error(),
        Some(libc::ETXTBSY)
    );
    assert!(
        started.elapsed() < Duration::from_millis(500),
        "busy spawn must retain the original short deadline"
    );
    assert!(
        !binary.with_extension("pid").exists(),
        "no help process starts while a writable descriptor is held"
    );
}

#[test]
fn output_safety_multiline_metadata_foreign_target_and_publication_rollback() {
    let fixture = Fixture::new("valid");
    assert!(output_directory(&fixture.root, &fixture.root).is_err());
    assert!(output_directory(&fixture.root, &fixture.root.join("xtask/output")).is_err());
    assert!(output_directory(&fixture.root, &fixture.temp.path().join("runtime/tools")).is_err());
    assert!(
        output_directory(
            &fixture.root,
            &fixture.temp.path().join("outside/../vendor")
        )
        .is_err()
    );
    let installed = fixture.temp.path().join("installed");
    fs::create_dir_all(installed.join("_internal")).unwrap();
    fs::write(installed.join("_internal/native-desktop.json"), "{}").unwrap();
    assert!(output_directory(&fixture.root, &installed.join("vendor")).is_err());
    let recipe = fixture.recipe(["http://unused".into(), "http://unused".into()]);
    assert!(metadata(&fixture.root, &recipe, "https://source\nINJECT=value").is_err());
    let foreign = Platform {
        arm: !Platform::current().unwrap().arm,
        ..Platform::current().unwrap()
    };
    assert!(
        prepare(&fixture.root, &fixture.output, foreign, &recipe)
            .unwrap_err()
            .to_string()
            .contains("matching native")
    );
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&fixture.root, fixture.temp.path().join("linked")).unwrap();
        assert!(
            output_directory(&fixture.root, &fixture.temp.path().join("linked/vendor")).is_err()
        );
    }
    let stage = fixture.temp.path().join("rollback-stage");
    fs::create_dir_all(&stage).unwrap();
    let destination = fixture.temp.path().join("previous-binary");
    let marker = fixture.temp.path().join("previous-marker");
    let new = stage.join("new-binary");
    fs::write(&destination, "old-valid").unwrap();
    fs::write(&marker, "old-metadata").unwrap();
    fs::write(&new, "new-valid").unwrap();
    assert!(
        publish(
            &new,
            &stage.join("missing-marker"),
            &destination,
            &marker,
            &stage
        )
        .is_err()
    );
    assert_eq!(fs::read_to_string(destination).unwrap(), "old-valid");
    assert_eq!(fs::read_to_string(marker).unwrap(), "old-metadata");
}

#[test]
fn transfer_timeout_and_size_limits_remove_partial_archive() {
    let fixture = Fixture::new("valid");
    let archive = fixture.temp.path().join("partial.zip");
    let stalled = Http::new(vec![(0, Vec::new(), None)]);
    let mut recipe = fixture.recipe(stalled.sources());
    recipe.transfer_timeout = Duration::from_millis(100);
    let start = std::time::Instant::now();
    assert!(
        download(&recipe, &archive)
            .unwrap_err()
            .to_string()
            .contains("Unable to download")
    );
    assert!(start.elapsed() < Duration::from_secs(2));
    assert!(!archive.exists());
    let oversized = Http::new(vec![
        (200, fixture.bytes.clone(), None),
        (200, fixture.bytes.clone(), None),
    ]);
    let mut recipe = fixture.recipe(oversized.sources());
    recipe.max_archive = 64;
    assert!(download(&recipe, &archive).is_err());
    assert!(!archive.exists());
}

#[test]
fn failed_help_keeps_the_previous_pair_and_metadata_cannot_inject_env_lines() {
    let mut fixture = Fixture::new("valid");
    let good = Http::new(vec![(200, fixture.bytes.clone(), None)]);
    let binary = fixture.prepare(&good).unwrap();
    let original = fs::read(&binary).unwrap();
    let marker = fs::read(fixture.output.join("metadata.env")).unwrap();
    let name = Platform::current().unwrap().executable("BBDown");
    fixture.bytes = zip_bytes(&[(&name, native("wrong"))]);
    fixture.hash = format!("{:x}", Sha256::digest(&fixture.bytes));
    let wrong = Http::new(vec![(200, fixture.bytes.clone(), None)]);
    assert!(fixture.prepare(&wrong).is_err());
    assert_eq!(fs::read(&binary).unwrap(), original);
    assert_eq!(
        fs::read(fixture.output.join("metadata.env")).unwrap(),
        marker
    );
    let mut recipe = fixture.recipe(wrong.sources());
    recipe.name = "fixture.zip\nINJECT=value";
    assert!(
        metadata(&fixture.root, &recipe, "https://source")
            .unwrap_err()
            .to_string()
            .contains("multiline")
    );
    #[cfg(unix)]
    {
        let injectable = fixture.temp.path().join("source\nINJECT=value");
        fs::create_dir_all(injectable.join("third_party")).unwrap();
        fs::write(injectable.join("third_party/BBDown-LICENSE.txt"), "MIT").unwrap();
        assert!(
            metadata(
                &injectable,
                &fixture.recipe(wrong.sources()),
                "https://source"
            )
            .unwrap_err()
            .to_string()
            .contains("multiline")
        );
    }
}

#[test]
fn public_cli_rejects_missing_unsupported_and_verification_bypass_arguments() {
    for (args, error) in [
        (vec![], "requires OUTPUT_DIR"),
        (
            vec!["generated", "--arch", "x86"],
            "No pinned BBDown release asset",
        ),
        (
            vec!["generated", "--platform", "android"],
            "No pinned BBDown release asset",
        ),
        (vec!["generated", "--platform"], "requires a value"),
        (
            vec!["generated", "--source-url", "http://untrusted"],
            "expected prepare-bbdown",
        ),
        (
            vec!["generated", "--skip-verification"],
            "expected prepare-bbdown",
        ),
    ] {
        assert!(
            run(args.into_iter().map(OsString::from).collect())
                .unwrap_err()
                .to_string()
                .contains(error)
        );
    }
}

#[test]
fn redirect_identity_and_non_success_http_status_are_not_integrity_fallbacks() {
    let fixture = Fixture::new("valid");
    let redirect = Http::new(vec![
        (302, Vec::new(), None),
        (200, fixture.bytes.clone(), None),
    ]);
    fixture.prepare(&redirect).unwrap();
    assert_eq!(redirect.paths(), ["/primary.zip", "/redirect.zip"]);
    assert!(
        fs::read_to_string(fixture.output.join("metadata.env"))
            .unwrap()
            .contains(&format!(
                "BILIKARA_BBDOWN_SOURCE_URL={}/primary.zip",
                redirect.base
            ))
    );
    let not_modified = Http::new(vec![
        (304, Vec::new(), None),
        (200, fixture.bytes.clone(), None),
    ]);
    fixture.prepare(&not_modified).unwrap();
    assert_eq!(not_modified.paths(), ["/primary.zip", "/mirror.zip"]);
}
