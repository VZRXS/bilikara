use super::*;

#[test]
fn version_mismatch_is_rejected_before_execution() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("_internal");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("native-desktop.json"),br#"{"schema_version":1,"backend":"rust","version":"v0.8.0-preview.3-g0123456789ab-dirty","resource_layout":"internal-v1","development":false,"platform":"windows","arch":"x64"}"#).unwrap();
    fs::write(
        root.join("APP_VERSION"),
        "v0.8.0-preview.3-g0123456789ab-dirty",
    )
    .unwrap();
    let error = inspect(
        &root.join("bilikara-desktop-host.exe"),
        "v0.8.0-preview.3",
        Platform::new("windows", "x86_64").unwrap(),
    )
    .unwrap_err();
    assert_eq!(error.to_string(), "Release version mismatch");
}

use host::Limits;
use std::{
    net::TcpListener,
    process::Command,
    sync::OnceLock,
    time::{Duration, Instant},
};

fn native() -> &'static [u8] {
    static BYTES: OnceLock<Vec<u8>> = OnceLock::new();
    BYTES.get_or_init(|| {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("fixture.rs");
        fs::write(&source, include_str!("fixture.rs")).unwrap();
        let executable = temp
            .path()
            .join(Platform::current().unwrap().executable("fixture"));
        let output = Command::new("rustc")
            .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
            .arg(source)
            .args([
                "--crate-name",
                "native_package_fixture",
                "--edition",
                "2024",
                "--target",
            ])
            .arg(Platform::current().unwrap().target())
            .arg("-o")
            .arg(&executable)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        fs::read(executable).unwrap()
    })
}
struct Fixture {
    home: TempDir,
    executable: PathBuf,
    assets: PathBuf,
    docs: PathBuf,
    platform: Platform,
}
impl Fixture {
    fn new(mode: &str) -> Self {
        Self::layout(Platform::current().unwrap(), false, native(), mode)
    }
    fn layout(platform: Platform, embedded: bool, bytes: &[u8], mode: &str) -> Self {
        let home = tempfile::Builder::new()
            .prefix("verifier-路径 空 & ")
            .tempdir()
            .unwrap();
        let package = home.path().join(if platform.os == Os::Macos {
            "bilikara-desktop.app"
        } else {
            "bilikara"
        });
        let backend = if embedded {
            package.join("Contents/Frameworks/bilikara-backend.app")
        } else {
            package.clone()
        };
        let assets = backend.join(if platform.os == Os::Macos {
            "Contents/Resources"
        } else {
            "_internal"
        });
        let code = if platform.os == Os::Macos {
            backend.join("Contents/MacOS")
        } else {
            assets.clone()
        };
        let docs = if platform.os == Os::Macos {
            assets.join("license")
        } else {
            package.join("license")
        };
        fs::create_dir_all(&code).unwrap();
        fs::create_dir_all(&assets).unwrap();
        fs::write(assets.join("APP_VERSION"), "v0.8.0-preview.3\n").unwrap();
        fs::write(assets.join("native-desktop.json"),json!({"schema_version":1,"backend":"rust","resource_layout":"internal-v1",
            "development":false,"version":"v0.8.0-preview.3","platform":platform.name(),"arch":platform.arch()}).to_string()).unwrap();
        for (name, text) in [
            ("static/fonts/SourceHanSans-VF.ttf", "font bytes"),
            (
                "vendor/signalsmith-stretch/SignalsmithStretch.js",
                "WebAssembly",
            ),
            ("vendor/ffmpeg-runtime.json", "{\"schema_version\":1}"),
        ] {
            fs::create_dir_all(assets.join(name).parent().unwrap()).unwrap();
            fs::write(assets.join(name), text).unwrap();
        }
        for name in [
            "LICENSE",
            "LEGAL.md",
            "THIRD_PARTY_NOTICES.md",
            "THIRD_PARTY_LICENSES/libav-source.txt",
            "THIRD_PARTY_LICENSES/libav/COPYING.LGPLv2.1",
            "THIRD_PARTY_LICENSES/BBDown-LICENSE.txt",
            "THIRD_PARTY_LICENSES/signalsmith-stretch/LICENSE.txt",
        ] {
            fs::create_dir_all(docs.join(name).parent().unwrap()).unwrap();
            fs::write(docs.join(name), "required notice fixture").unwrap();
        }
        let executable = code.join(platform.executable("bilikara-desktop-host"));
        for file in [
            &executable,
            &code.join(platform.executable("bilikara-updater")),
        ] {
            fs::write(file, bytes).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(file, fs::Permissions::from_mode(0o755)).unwrap();
            }
        }
        fs::write(executable.with_extension("mode"), mode).unwrap();
        if platform.os != Os::Macos {
            fs::write(package.join(platform.executable("bilikara-desktop")), bytes).unwrap();
        }
        Self {
            home,
            executable,
            assets,
            docs,
            platform,
        }
    }
    fn inspect(&self) -> Result<Value> {
        inspect(&self.executable, "v0.8.0-preview.3", self.platform)
    }
    fn start(&self) -> Result<RunningHost> {
        RunningHost::start_with_limits(
            &self.executable,
            self.home.path(),
            &[],
            Limits {
                ready: Duration::from_millis(900),
                request: Duration::from_millis(800),
                shutdown: Duration::from_millis(800),
            },
        )
    }
    fn gone(&self) {
        if let Ok(port) = fs::read_to_string(self.executable.with_extension("port")) {
            let address = format!("127.0.0.1:{}", port.trim()).parse().unwrap();
            assert!(
                std::net::TcpStream::connect_timeout(&address, Duration::from_millis(150)).is_err(),
                "Owned fixture listener survived failure cleanup"
            );
        }
        #[cfg(target_os = "linux")]
        if let Ok(pid) = fs::read_to_string(self.executable.with_extension("pid")) {
            assert!(
                !Path::new(&format!("/proc/{}", pid.trim())).exists(),
                "Owned fixture process survived"
            );
        }
    }
}
#[test]
fn fixture_verifier_exercises_all_success_checks_and_relocated_copy() {
    let fixture = Fixture::new("valid");
    let result = verify(&fixture.executable, "v0.8.0-preview.3").unwrap();
    assert_eq!(
        result,
        json!({"nativeReleaseBackend":true,"pythonFreeLayout":true,"bootstrap":true,
        "auxiliaryWindowBootstrap":true,"resources":true,"sse":true,"shutdownAndReopen":true,"version":"v0.8.0-preview.3"})
    );
    assert!(
        !fixture.executable.with_extension("pid").exists(),
        "Verifier mutated the supplied package"
    );
}
#[test]
fn independent_adjacent_standalone_and_embedded_layouts() {
    for (os, magic) in [
        ("windows", b"MZxx".as_slice()),
        ("linux", b"\x7fELF".as_slice()),
        ("macos", b"\xcf\xfa\xed\xfe".as_slice()),
    ] {
        for arch in ["x64", "arm64"] {
            let platform =
                Platform::new(os, if arch == "x64" { "x86_64" } else { "aarch64" }).unwrap();
            for embedded in [false, true] {
                if embedded && platform.os != Os::Macos {
                    continue;
                }
                let fixture = Fixture::layout(platform, embedded, magic, "valid");
                let facts = fixture.inspect().unwrap();
                assert_eq!(facts["arch"], arch);
                assert_eq!(resources(&fixture.executable), fixture.assets);
                assert_eq!(
                    package_root(&fixture.executable),
                    fixture.home.path().join(if os == "macos" {
                        "bilikara-desktop.app"
                    } else {
                        "bilikara"
                    })
                );
                // Descriptor/magic-byte checks are deliberately NOT native execution.
            }
        }
    }
}
#[test]
fn missing_resources_notices_updater_and_top_level_fail() {
    let fixture = Fixture::new("valid");
    fixture.inspect().unwrap();
    let mut files = vec![
        fixture.assets.join("static/fonts/SourceHanSans-VF.ttf"),
        fixture
            .assets
            .join("vendor/signalsmith-stretch/SignalsmithStretch.js"),
        fixture.assets.join("vendor/ffmpeg-runtime.json"),
        fixture.assets.join("APP_VERSION"),
        fixture.assets.join("native-desktop.json"),
        fixture
            .executable
            .with_file_name(fixture.platform.executable("bilikara-updater")),
    ];
    for name in [
        "LICENSE",
        "LEGAL.md",
        "THIRD_PARTY_NOTICES.md",
        "THIRD_PARTY_LICENSES/libav-source.txt",
        "THIRD_PARTY_LICENSES/libav/COPYING.LGPLv2.1",
        "THIRD_PARTY_LICENSES/BBDown-LICENSE.txt",
        "THIRD_PARTY_LICENSES/signalsmith-stretch/LICENSE.txt",
    ] {
        files.push(fixture.docs.join(name));
    }
    for file in files {
        let hidden = file.with_extension("hidden");
        fs::rename(&file, &hidden).unwrap();
        assert!(
            fixture.inspect().is_err(),
            "Missing required input accepted: {}",
            file.display()
        );
        fs::rename(hidden, file).unwrap();
    }
    fs::write(fixture.docs.join("native-desktop.md"), "engineering guide").unwrap();
    assert!(fixture.inspect().is_err());
    fs::remove_file(fixture.docs.join("native-desktop.md")).unwrap();
    if fixture.platform.os != Os::Macos {
        fs::write(
            package_root(&fixture.executable).join("extra.txt"),
            "unexpected outer entry",
        )
        .unwrap();
        assert!(fixture.inspect().is_err());
    }
}

#[test]
fn earlier_native_layout_and_exact_optional_import_launcher_are_accepted() {
    for (os, magic, name, content) in [
        (
            "windows",
            b"MZxx".as_slice(),
            "导入旧数据.cmd",
            "@echo off\r\n\"%~dp0bilikara-desktop.exe\" --import-legacy\r\n",
        ),
        (
            "linux",
            b"\x7fELF".as_slice(),
            "导入旧数据.sh",
            "#!/bin/sh\nset -eu\nhere=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)\nexec \"$here/bilikara-desktop\" --import-legacy\n",
        ),
    ] {
        let platform = Platform::new(os, "x86_64").unwrap();
        let fixture = Fixture::layout(platform, false, magic, "valid");
        fixture.inspect().unwrap();
        let file = package_root(&fixture.executable).join(name);
        fs::write(&file, content).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&file, fs::Permissions::from_mode(0o755)).unwrap();
        }
        fixture.inspect().unwrap();
        fs::write(&file, format!("{content}\necho unexpected mutation\n")).unwrap();
        assert!(fixture.inspect().is_err());
        fs::remove_file(&file).unwrap();
        fixture.inspect().unwrap();
    }
}
#[test]
fn forbidden_payloads_multiple_vendor_and_user_data_exemption() {
    let fixture = Fixture::new("valid");
    for name in [
        "ffmpeg",
        "ffprobe.exe",
        "python.exe",
        "python3",
        "base_library.zip",
        "module.pyc",
        "PYZ-00.pyz",
        "libpython3.13.so.1",
        "bilikara_rust.dll",
        "libbilikara_runtime.so",
        "libbilikara_runtime.dylib",
        "bilikara_media_libav_test.dll",
        "libbilikara_media_libav_test.so",
        "libbilikara_media_libav_test.dylib",
        "libav_metadata",
        "libav-runtime-tests.exe",
        "media_libav_test.exe",
        "libav-smoke.ps1",
    ] {
        let path = fixture.assets.join(name);
        fs::write(&path, "forbidden payload").unwrap();
        assert!(
            fixture.inspect().is_err(),
            "Forbidden payload accepted: {name}"
        );
        fs::remove_file(path).unwrap();
    }
    for name in [
        "site-packages",
        "libav-diagnostics",
        "preview",
        "static/vendor",
    ] {
        let path = fixture.assets.join(name);
        fs::create_dir_all(&path).unwrap();
        assert!(
            fixture.inspect().is_err(),
            "Forbidden directory accepted: {name}"
        );
        fs::remove_dir_all(path).unwrap();
    }
    fs::create_dir_all(fixture.assets.join("extra/vendor")).unwrap();
    assert!(fixture.inspect().is_err());
    fs::remove_dir_all(fixture.assets.join("extra")).unwrap();
    // Legally useful source is allowed; no interpreter executes it.
    fs::write(fixture.docs.join("source.py"), "source/rebuild material").unwrap();
    fixture.inspect().unwrap();
    let windows = Fixture::layout(
        Platform::new("windows", "x86_64").unwrap(),
        false,
        b"MZxx",
        "valid",
    );
    let runtime = package_root(&windows.executable).join("runtime/site-packages/vendor");
    fs::create_dir_all(&runtime).unwrap();
    fs::write(runtime.join("python.exe"), "mutable user cache").unwrap();
    windows.inspect().unwrap();
}
#[test]
fn manifest_release_identity_and_native_file_failures() {
    let fixture = Fixture::new("valid");
    let path = fixture.assets.join("native-desktop.json");
    let original = fs::read(&path).unwrap();
    for (key, value) in [
        ("schema_version", json!(2)),
        ("backend", json!("python")),
        ("development", json!(true)),
        ("resource_layout", json!("other")),
        ("arch", json!("incompatible")),
        ("platform", json!("other")),
        ("version", json!("wrong")),
    ] {
        let mut facts: Value = serde_json::from_slice(&original).unwrap();
        facts[key] = value;
        fs::write(&path, facts.to_string()).unwrap();
        assert!(
            fixture.inspect().is_err(),
            "Invalid manifest field accepted {key}"
        );
    }
    fs::write(&path, b"malformed").unwrap();
    assert!(fixture.inspect().is_err());
    fs::write(path, original).unwrap();
    fs::write(&fixture.executable, b"#!/usr/bin/python\n").unwrap();
    assert!(fixture.inspect().is_err());
    assert!(verify(&fixture.home.path().join("absent-host"), "").is_err());
    let magic: &[u8] = match Platform::current().unwrap().os {
        Os::Windows => b"MZxx not an executable",
        Os::Macos => b"\xcf\xfa\xed\xfe not an executable",
        Os::Linux => b"\x7fELF not an executable",
    };
    let invalid = Fixture::layout(Platform::current().unwrap(), false, magic, "valid");
    assert!(
        verify(&invalid.executable, "").is_err(),
        "An unexecutable supplied artifact must fail the gate"
    );
}
#[test]
fn readiness_bootstrap_failures_are_bounded_redacted_and_cleaned() {
    for mode in [
        "malformed",
        "early",
        "no-ready",
        "oversized",
        "no-newline",
        "foreign-ready",
        "redirect",
        "bad-cookie",
    ] {
        let fixture = Fixture::new(mode);
        let start = Instant::now();
        let error = fixture
            .start()
            .err()
            .expect("Broken readiness/bootstrap accepted")
            .to_string();
        assert!(!error.contains("test-token") && !error.contains("private credential"));
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "Unbounded failure {mode}"
        );
        fixture.gone();
    }
}
#[test]
fn http_role_resource_sse_and_capability_failures_are_detected() {
    for mode in [
        "unauth",
        "bad-query",
        "flash",
        "bad-health",
        "wrong-state",
        "bad-json",
        "updater",
        "bad-js-type",
        "bad-js",
        "expose-private",
        "bad-sse-type",
        "no-event",
        "foreign-origin",
        "no-capability",
        "stall",
    ] {
        let fixture = Fixture::new(mode);
        let facts = fixture.inspect().unwrap();
        let start = Instant::now();
        let host = fixture.start().unwrap();
        assert!(
            host.check(&facts).is_err(),
            "Verifier accepted broken HTTP behavior: {mode}"
        );
        drop(host);
        assert!(start.elapsed() < Duration::from_secs(5));
        fixture.gone();
    }
}
#[test]
fn transport_failures_identify_the_stage_without_leaking_capabilities() {
    for (mode, reason) in [("closed-health", "I/O"), ("stall", "timeout")] {
        let fixture = Fixture::new(mode);
        let host = fixture.start().unwrap();
        let start = Instant::now();
        let error = host
            .check(&fixture.inspect().unwrap())
            .unwrap_err()
            .to_string();
        assert!(error.contains("health"), "Missing request stage: {error}");
        assert!(error.contains(reason), "Missing transport cause: {error}");
        assert!(!error.contains("test-token") && !error.contains("test-host"));
        assert!(start.elapsed() < Duration::from_secs(5));
        let error = host
            .request("/api/health?token=private-credential", None, &[])
            .unwrap_err()
            .to_string();
        assert!(error.contains("health"));
        assert!(!error.contains("private-credential") && !error.contains('?'));
        drop(host);
        fixture.gone();
    }
}
#[test]
fn shutdown_errors_stuck_process_and_nonzero_exit_are_never_success() {
    for mode in ["shutdown-403", "shutdown-stuck", "shutdown-exit"] {
        let fixture = Fixture::new(mode);
        let mut host = fixture.start().unwrap();
        assert!(
            host.close().is_err(),
            "Verifier accepted failed authorized shutdown: {mode}"
        );
        drop(host);
        fixture.gone();
    }
    let fixture = Fixture::new("valid");
    let mut host = fixture.start().unwrap();
    // Independently hold a listener to exercise the closure assertion after the
    // native fixture exits successfully. This listener is owned by this test.
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    host.set_test_listener(listener.local_addr().unwrap());
    assert!(host.close().is_err());
    drop(host);
    drop(listener);
    fixture.gone();
}
#[test]
fn concurrent_log_drain_handles_pressure_after_and_before_readiness() {
    let fixture = Fixture::new("pressure");
    let mut host = fixture.start().unwrap();
    host.check(&fixture.inspect().unwrap()).unwrap();
    host.close().unwrap();
    let (stdout, stderr) = host.process.log_sizes();
    assert!(stdout.0 > 2 * 1024 * 1024 && stderr.0 >= 4 * 1024 * 1024);
    assert!(stdout.1 <= 64 * 1024 && stderr.1 <= 64 * 1024);
    drop(host);
    fixture.gone();
}
#[cfg(unix)]
#[test]
fn relative_links_modes_and_source_data_survive_copy() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let fixture = Fixture::new("valid");
    let package = package_root(&fixture.executable);
    // macOS keeps user data outside its signed app; portable layouts keep it
    // beside the launcher. Do not fabricate in-bundle macOS user data.
    let data = if fixture.platform.os == Os::Macos {
        fixture.home.path().join("runtime")
    } else {
        package.join("runtime")
    };
    fs::create_dir(&data).unwrap();
    fs::write(data.join("real-user-data"), "never touch").unwrap();
    fs::write(fixture.assets.join("vendor/library.so"), "native bytes").unwrap();
    symlink("library.so", fixture.assets.join("vendor/link.so")).unwrap();
    let install = Installation::copy(&fixture.executable).unwrap();
    assert!(!install.package.join("runtime").exists());
    assert_eq!(
        fs::read_to_string(data.join("real-user-data")).unwrap(),
        "never touch"
    );
    assert_eq!(
        fs::read_link(resources(&install.executable).join("vendor/link.so")).unwrap(),
        Path::new("library.so")
    );
    assert_eq!(
        fs::metadata(&fixture.executable)
            .unwrap()
            .permissions()
            .mode(),
        fs::metadata(&install.executable)
            .unwrap()
            .permissions()
            .mode()
    );
    fs::remove_dir_all(&data).unwrap();
    symlink(fixture.home.path(), fixture.assets.join("unsafe-link")).unwrap();
    assert!(fixture.inspect().is_err());
    fs::remove_file(fixture.assets.join("unsafe-link")).unwrap();
    symlink("../../outside", fixture.assets.join("unsafe-link")).unwrap();
    assert!(fixture.inspect().is_err());
}
