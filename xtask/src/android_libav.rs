//! Android's signed, upstream-C-only cache and separately rebuilt companion.
//! Adapted from bilikara-next xtask/src/android_libav.rs (MIT, same author family).
//! P11 ports R2 A1 (b49e1ae; fb7455d + 066a57b) back to next with L0/L1 enabled.
//! Keep CONFIGURE and cache_key inputs aligned with that upstream-C cache.
//! Foreign ELF is inspected with the selected NDK, never loaded on the host.
use crate::{Result, files, libav_cache, libav_prepare as paths};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    env,
    ffi::{OsStr, OsString},
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const NDK: &str = "27.0.12077973";
const VERSION: &str = "9.0.1";
const SOURCE_SHA: &str = "cf38e0e28c7e5605942c4a77755349b0145804a397af37eb1fb4c77cb237f635";
const FINGERPRINT: &str = "FCF986EA15E6E293A5644F10B4322F04D67658D8";
const INSTALL_PREFIX: &str = "/bilikara-android-libav";
const LIBRARIES: &[&str] = &[
    "libavformat.so",
    "libavcodec.so",
    "libavutil.so",
    "libswresample.so",
    "libbilikara_media_libav.so",
];
const CONFIGURE: &[&str] = &[
    "--target-os=android",
    "--enable-cross-compile",
    "--cc=clang",
    "--cxx=clang++",
    "--ar=llvm-ar",
    "--ranlib=llvm-ranlib",
    "--nm=llvm-nm",
    "--strip=llvm-strip",
    "--disable-autodetect",
    "--disable-debug",
    "--disable-doc",
    "--disable-programs",
    "--disable-static",
    "--enable-shared",
    "--enable-pic",
    "--disable-network",
    "--disable-avdevice",
    "--disable-swscale",
    "--disable-avfilter",
    "--enable-swresample",
    "--disable-everything",
    "--enable-decoder=aac,flac,h264,eac3,ac3,mp3,opus",
    "--enable-encoder=aac",
    "--enable-demuxer=mov,flac,mpegts",
    "--enable-muxer=mp4,flac,mpegts,adts",
    "--enable-parser=aac,flac,h264,eac3,ac3,mpegaudio,opus",
    "--enable-protocol=fd,file",
    "--enable-bsf=h264_mp4toannexb,extract_extradata,aac_adtstoasc",
];

#[derive(Clone, Copy)]
struct Abi {
    name: &'static str,
    arch: &'static str,
    triple: &'static str,
    machine: &'static str,
}
fn abi(name: &str) -> Result<Abi> {
    match name {
        "arm64-v8a" => Ok(Abi {
            name: "arm64-v8a",
            arch: "aarch64",
            triple: "aarch64-linux-android",
            machine: "AArch64",
        }),
        "x86_64" => Ok(Abi {
            name: "x86_64",
            arch: "x86_64",
            triple: "x86_64-linux-android",
            machine: "Advanced Micro Devices X86-64",
        }),
        _ => Err(
            "Android libav supports arm64-v8a and x86_64; select a supported 64-bit APK ABI".into(),
        ),
    }
}
struct Options {
    ndk: PathBuf,
    out: PathBuf,
    cache: PathBuf,
    source: Option<PathBuf>,
    abi: Abi,
    key: bool,
    verify: bool,
    signalsmith: bool,
}
fn options(args: Vec<OsString>) -> Result<Options> {
    let mut values = BTreeMap::new();
    let mut key = false;
    let mut verify = false;
    let mut signalsmith = false;
    let mut args = args.into_iter();
    while let Some(name) = args.next() {
        if name == "--with-signalsmith" {
            if signalsmith {
                return Err("Duplicate --with-signalsmith".into());
            }
            signalsmith = true;
            continue;
        }
        if name == "--cache-key" {
            if key {
                return Err("Duplicate --cache-key".into());
            }
            key = true;
            continue;
        }
        if name == "--verify-only" {
            if verify {
                return Err("Duplicate --verify-only".into());
            }
            verify = true;
            continue;
        }
        if !["--ndk", "--out", "--cache", "--source-dir", "--abi"]
            .iter()
            .any(|n| name == *n)
            || values.contains_key(&name)
        {
            return Err("Invalid or duplicate android-libav argument".into());
        }
        values.insert(
            name,
            args.next().ok_or("Missing android-libav argument value")?,
        );
    }
    let required = |name: &str| {
        values
            .get(OsStr::new(name))
            .map(PathBuf::from)
            .ok_or_else(|| format!("android-libav requires {name}"))
    };
    Ok(Options {
        ndk: required("--ndk")?,
        out: required("--out")?,
        cache: required("--cache")?,
        source: values.get(OsStr::new("--source-dir")).map(PathBuf::from),
        abi: abi(values
            .get(OsStr::new("--abi"))
            .and_then(|s| s.to_str())
            .ok_or("--abi is required")?)?,
        key,
        verify,
        // next L1 always requires the DSP companion; the explicit flag remains
        // accepted for source-kit callers and does not enter the upstream C key.
        signalsmith: true,
    })
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn toolchain(ndk: &Path) -> Result<PathBuf> {
    if !fs::read_to_string(ndk.join("source.properties"))?
        .lines()
        .any(|l| l.trim() == format!("Pkg.Revision = {NDK}"))
    {
        return Err("Android libav requires the pinned NDK 27.0.12077973".into());
    }
    let host = match env::consts::OS {
        "linux" => "linux-x86_64",
        "macos" => "darwin-x86_64",
        "windows" => "windows-x86_64",
        _ => return Err("Unsupported NDK build host".into()),
    };
    let path = ndk.join("toolchains/llvm/prebuilt").join(host);
    for name in ["clang", "clang++", "llvm-strip", "llvm-readelf"] {
        if !path
            .join("bin")
            .join(format!("{name}{}", env::consts::EXE_SUFFIX))
            .is_file()
        {
            return Err("Incomplete selected Android NDK".into());
        }
    }
    Ok(path)
}
fn binary(tc: &Path, name: &str) -> PathBuf {
    // Keep the caller's NDK spelling for tool execution; canonical paths are
    // used separately for containment checks. Never strip a verbatim prefix.
    tc.join("bin")
        .join(format!("{name}{}", env::consts::EXE_SUFFIX))
}
fn library_names(signalsmith: bool) -> Vec<&'static str> {
    let mut names = LIBRARIES.to_vec();
    if signalsmith {
        names.push("libc++_shared.so");
    }
    names
}
fn cache_key(abi: Abi, compiler: &[u8]) -> Result<String> {
    Ok(format!(
        "android-libav-v1-{}-{}",
        abi.name,
        digest(&serde_json::to_vec(
            &json!({"ndk":NDK,"source":SOURCE_SHA,"abi":abi.name,"api":24,"configure":CONFIGURE,"page_size":16384,"compiler":digest(compiler)})
        )?)
    ))
}
fn command(tc: &Path, name: &str) -> Command {
    Command::new(binary(tc, name))
}

struct BuildProcess {
    child: std::process::Child,
    #[cfg(windows)]
    _job: Job,
}
impl Drop for BuildProcess {
    fn drop(&mut self) {
        #[cfg(unix)]
        unsafe {
            libc::kill(-(self.child.id() as i32), libc::SIGKILL);
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
fn failed_log(log: &Path, reason: &str) -> Box<dyn std::error::Error> {
    // These are owned public-source download/compiler logs, not environment
    // dumps. Surface a bounded tail before temporary build directories vanish.
    let tail = (|| -> std::io::Result<String> {
        let mut file = fs::File::open(log)?;
        file.seek(SeekFrom::Start(file.metadata()?.len().saturating_sub(8192)))?;
        let mut bytes = Vec::new();
        file.take(8192).read_to_end(&mut bytes)?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    })()
    .unwrap_or_else(|_| "Build output unavailable".into());
    let retained = (|| -> Result<PathBuf> {
        let owner = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .ok_or("No checkout root")?
            .join(".tmp/android-libav-logs");
        fs::create_dir_all(&owner)?;
        let mut copy = tempfile::Builder::new()
            .prefix("bilikara-android-media-failure-")
            .suffix(".log")
            .tempfile_in(&owner)?;
        let mut input = fs::File::open(log)?;
        input.seek(SeekFrom::Start(
            input.metadata()?.len().saturating_sub(1024 * 1024),
        ))?;
        std::io::copy(&mut input.take(1024 * 1024), &mut copy)?;
        Ok(copy.keep()?.1)
    })();
    format!(
        "{reason}; stage: {}; log: {}\n{tail}",
        log.file_name().unwrap_or_default().to_string_lossy(),
        retained.as_deref().unwrap_or(log).display(),
    )
    .into()
}

// Keep compiler output in an owned bounded log and terminate the owned process
// group on timeout/error. A cancelled build never publishes completion metadata.
fn execute(mut cmd: Command, log: &Path, seconds: u64) -> Result<()> {
    fs::create_dir_all(log.parent().ok_or("No log parent")?)?;
    let output = fs::File::create(log)?;
    cmd.stdout(output.try_clone()?)
        .stderr(output)
        .stdin(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let child = cmd.spawn()?;
    #[cfg(windows)]
    let job = match Job::new(&child) {
        Ok(job) => job,
        Err(error) => {
            let mut child = child;
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    let mut process = BuildProcess {
        child,
        #[cfg(windows)]
        _job: job,
    };
    let deadline = Instant::now() + Duration::from_secs(seconds);
    loop {
        if let Some(status) = process.child.try_wait()? {
            if status.success() {
                return Ok(());
            }
            return Err(failed_log(
                log,
                &format!("Android media build stage failed ({status})"),
            ));
        }
        if Instant::now() >= deadline || fs::metadata(log)?.len() > 64 * 1024 * 1024 {
            return Err(failed_log(log, "Android media build deadline/output limit"));
        }
        thread::sleep(Duration::from_millis(50));
    }
}
#[cfg(windows)]
struct Job(windows_sys::Win32::Foundation::HANDLE);
#[cfg(windows)]
impl Job {
    fn new(child: &std::process::Child) -> Result<Self> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::*;
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return Err("Cannot create native build job".into());
            }
            let job = Self(handle);
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&limits) as u32,
            ) == 0
                || AssignProcessToJobObject(handle, child.as_raw_handle()) == 0
            {
                return Err("Cannot contain native build job".into());
            }
            Ok(job)
        }
    }
}
#[cfg(windows)]
impl Drop for Job {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

fn verify_source(archive: &Path) -> Result<()> {
    if digest(&fs::read(archive)?) != SOURCE_SHA {
        return Err("Pinned FFmpeg source digest mismatch".into());
    }
    Ok(())
}
fn verify_signer(status: &str) -> Result<()> {
    let fingerprints: Vec<_> = status
        .lines()
        .filter_map(|l| {
            l.strip_prefix("[GNUPG:] VALIDSIG ")
                .and_then(|s| s.split_whitespace().next())
        })
        .collect();
    if fingerprints != [FINGERPRINT] {
        return Err("Unexpected FFmpeg signing fingerprint".into());
    }
    Ok(())
}
fn upstream(o: &Options, tc: &Path, key: &str) -> Result<PathBuf> {
    let cached = o.cache.join(key);
    if cached.exists() {
        verify_cache(&cached, o.abi, key)?;
        println!("Android libav C cache hit: {key}");
        return Ok(cached);
    }
    println!("Android libav C cache miss: {key}");
    let work = tempfile::Builder::new()
        .prefix(".android-libav-build-")
        .tempdir_in(&o.cache)?;
    let prefix = work.path().join("prefix");
    for dir in ["source", "licenses", "records"] {
        fs::create_dir_all(prefix.join(dir))?;
    }
    let source = prefix.join("source");
    for (name, url) in [
        (
            format!("ffmpeg-{VERSION}.tar.xz"),
            format!("https://ffmpeg.org/releases/ffmpeg-{VERSION}.tar.xz"),
        ),
        (
            format!("ffmpeg-{VERSION}.tar.xz.asc"),
            format!("https://ffmpeg.org/releases/ffmpeg-{VERSION}.tar.xz.asc"),
        ),
        (
            "ffmpeg-devel.asc".into(),
            "https://ffmpeg.org/ffmpeg-devel.asc".into(),
        ),
    ] {
        if let Some(input) = &o.source {
            files::copy(
                &paths::safe_file(input, &input.join(&name))?,
                &source.join(&name),
            )?;
        } else {
            let mut cmd = Command::new("curl");
            cmd.current_dir(work.path())
                .args([
                    "--fail",
                    "--location",
                    "--proto",
                    "=https",
                    "--retry",
                    "5",
                    "--retry-all-errors",
                    "--retry-max-time",
                    "90",
                    "--connect-timeout",
                    "15",
                    "--max-time",
                    "120",
                    "--max-filesize",
                    "20971520",
                ])
                .arg(url)
                .arg("-o")
                .arg(format!("prefix/source/{name}"));
            execute(cmd, &prefix.join("records/download.log"), 130)?;
        }
    }
    let archive = source.join(format!("ffmpeg-{VERSION}.tar.xz"));
    verify_source(&archive)?;
    let keyring = work.path().join("keyring");
    fs::create_dir(&keyring)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&keyring, fs::Permissions::from_mode(0o700))?;
    }
    // MSYS2 gpg/tar reject Windows extended (\\?\) paths, so these tools use
    // relative arguments under the owned work directory.
    let source_arg = |name: &str| format!("prefix/source/{name}");
    let mut gpg = Command::new("gpg");
    gpg.current_dir(work.path())
        .args(["--no-options", "--homedir", "keyring"])
        .args(["--no-autostart", "--batch", "--dearmor", "--output"])
        .arg("keyring/release.gpg")
        .arg(source_arg("ffmpeg-devel.asc"));
    execute(gpg, &prefix.join("records/key.log"), 30)?;
    // gpgv verifies public material without contacting gpg-agent. This also
    // preserves legitimate long/CJK build paths without Unix socket limits.
    let mut gpg = Command::new("gpgv");
    gpg.current_dir(work.path())
        .args(["--homedir", "keyring", "--keyring", "keyring/release.gpg"])
        .args(["--status-fd", "1"])
        .arg(source_arg(&format!("ffmpeg-{VERSION}.tar.xz.asc")))
        .arg(source_arg(&format!("ffmpeg-{VERSION}.tar.xz")));
    let sig = prefix.join("records/signature.log");
    execute(gpg, &sig, 30)?;
    verify_signer(&fs::read_to_string(sig)?)?;
    let mut tar = Command::new("tar");
    tar.current_dir(work.path())
        .arg("-xf")
        .arg(source_arg(&format!("ffmpeg-{VERSION}.tar.xz")))
        .args(["-C", "."]);
    execute(tar, &prefix.join("records/extract.log"), 60)?;
    let source = work.path().join(format!("ffmpeg-{VERSION}"));
    let mut build = Command::new("bash");
    // FFmpeg embeds its configure arguments in every library. Keep the logical
    // prefix machine independent; only installation sees the physical DESTDIR.
    build.current_dir(&source)
        .arg("./configure")
        .arg(format!("--prefix={INSTALL_PREFIX}"))
        .args(CONFIGURE)
        .arg(format!("--arch={}", o.abi.arch))
        .arg(format!("--extra-cflags=--target={}24", o.abi.triple))
        .arg(format!("--extra-ldflags=--target={}24 -Wl,-z,max-page-size=16384 -Wl,-z,common-page-size=16384", o.abi.triple));
    #[cfg(windows)]
    build.arg("--host-cc=gcc");
    if o.abi.arch == "x86_64" {
        build.arg("--disable-x86asm");
    }
    let path = env::join_paths(
        std::iter::once(tc.join("bin"))
            .chain(env::split_paths(&env::var_os("PATH").unwrap_or_default())),
    )?;
    build.env("PATH", &path);
    execute(build, &prefix.join("records/configure.log"), 180)?;
    let jobs = thread::available_parallelism()
        .map_or(2, usize::from)
        .min(8)
        .to_string();
    let mut make = Command::new("make");
    make.current_dir(&source)
        .env("PATH", &path)
        .arg(format!("-j{jobs}"));
    execute(make, &prefix.join("records/build.log"), 1200)?;
    fs::create_dir(work.path().join("install"))?;
    let mut make = Command::new("bash");
    make.current_dir(&source)
        .env("PATH", &path)
        .args(["-c", "dest=$(cd ../install && pwd -P) || exit; exec make install-libs install-headers \"DESTDIR=$dest\""]);
    execute(make, &prefix.join("records/install.log"), 120)?;
    let installed = work
        .path()
        .join("install")
        .join(INSTALL_PREFIX.trim_start_matches('/'));
    for name in ["lib", "include"] {
        files::tree(&installed.join(name), &prefix.join(name), false)?;
    }
    for name in ["config.h", "config_components.h"] {
        files::copy(&source.join(name), &prefix.join("records").join(name))?;
    }
    files::copy(
        &source.join("ffbuild/config.mak"),
        &prefix.join("records/config.mak"),
    )?;
    for entry in fs::read_dir(&source)? {
        let e = entry?;
        let name = e.file_name();
        if name.to_string_lossy().starts_with("COPYING") || name == "LICENSE.md" {
            files::copy(&e.path(), &prefix.join("licenses").join(name))?;
        }
    }
    for name in ["download.log", "key.log", "extract.log"] {
        let log = prefix.join("records").join(name);
        if log.exists() {
            fs::remove_file(log)?;
        }
    }
    let inventory = libav_cache::inventory(&prefix, false)?;
    files::write_json(
        &prefix.join("cache-manifest.json"),
        &json!({"schema_version":1,"kind":"android-upstream-c","key":key,"abi":o.abi.name,"entries":inventory}),
    )?;
    verify_cache(&prefix, o.abi, key)?;
    match fs::rename(&prefix, &cached) {
        Ok(()) => {}
        Err(e) if cached.exists() => {
            verify_cache(&cached, o.abi, key)?;
            let _ = e;
        }
        Err(e) => return Err(e.into()),
    }
    Ok(cached)
}
fn verify_cache(prefix: &Path, abi: Abi, key: &str) -> Result<()> {
    let manifest: Value = serde_json::from_slice(&fs::read(paths::safe_file(
        prefix,
        &prefix.join("cache-manifest.json"),
    )?)?)?;
    for name in libav_cache::inventory(prefix, false)?.keys() {
        let first = name
            .split('/')
            .next()
            .ok_or("Invalid Android C cache path")?;
        if !["lib", "include", "share", "source", "licenses", "records"].contains(&first)
            || name.contains("bilikara_media")
            || name.contains("libc++_shared")
        {
            return Err("Android C cache must contain only upstream C build inputs/outputs".into());
        }
    }
    if manifest["schema_version"] != 1
        || manifest["kind"] != "android-upstream-c"
        || manifest["key"] != key
        || manifest["abi"] != abi.name
        || manifest["entries"] != serde_json::to_value(libav_cache::inventory(prefix, false)?)?
    {
        return Err("Android C cache inventory/target mismatch".into());
    }
    verify_source(&prefix.join(format!("source/ffmpeg-{VERSION}.tar.xz")))?;
    verify_signer(&fs::read_to_string(prefix.join("records/signature.log"))?)?;
    for name in &LIBRARIES[..4] {
        paths::safe_file(prefix, &prefix.join("lib").join(name))?;
    }
    for name in [
        "include/libavformat/avformat.h",
        "include/libavcodec/avcodec.h",
        "include/libavutil/avutil.h",
        "include/libswresample/swresample.h",
        "licenses/COPYING.LGPLv2.1",
        "licenses/LICENSE.md",
    ] {
        paths::safe_file(prefix, &prefix.join(name))?;
    }
    let cfg = fs::read_to_string(prefix.join("records/config.h"))?;
    verify_configuration(&cfg).map_err(|error| {
        format!(
            "Cannot reuse Android C cache {}: {error}; select a fresh --cache directory to rebuild",
            prefix.display()
        )
    })?;
    for name in &LIBRARIES[..4] {
        verify_binary_privacy(&prefix.join("lib").join(name))?;
    }
    for flag in [
        "CONFIG_GPL",
        "CONFIG_NONFREE",
        "CONFIG_VERSION3",
        "CONFIG_NETWORK",
    ] {
        if !cfg.lines().any(|l| l == format!("#define {flag} 0")) {
            return Err("Android libav profile violates the pinned LGPL/network contract".into());
        }
    }
    let components = fs::read_to_string(prefix.join("records/config_components.h"))?;
    for flag in [
        "CONFIG_MPEGTS_MUXER",
        "CONFIG_AAC_ENCODER",
        "CONFIG_H264_MP4TOANNEXB_BSF",
        "CONFIG_AAC_DECODER",
        "CONFIG_FLAC_DECODER",
    ] {
        if !components.lines().any(|l| l == format!("#define {flag} 1")) {
            return Err("Android libav is missing a required component".into());
        }
    }
    Ok(())
}

fn verify_configuration(cfg: &str) -> Result<()> {
    let config = cfg
        .lines()
        .find_map(|line| line.strip_prefix("#define FFMPEG_CONFIGURATION "))
        .ok_or("Missing FFmpeg configuration")?;
    let prefixes: Vec<_> = config
        .trim_matches('"')
        .split_whitespace()
        .filter(|part| part.starts_with("--prefix="))
        .collect();
    if prefixes != [format!("--prefix={INSTALL_PREFIX}")] {
        return Err(
            "FFmpeg configuration must use the fixed, machine-independent installation prefix"
                .into(),
        );
    }
    Ok(())
}

// Inspect the actual bytes, not build-info claims. This also rejects a restored
// pre-fix C cache whose configuration still embeds another builder's home path.
fn verify_binary_privacy(path: &Path) -> Result<()> {
    let bytes = fs::read(path)?;
    for marker in [
        b"/users/".as_slice(),
        b"\\users\\",
        b"/home/",
        b"\\home\\",
        b".android-libav-build-",
        b".android-libav-output-",
    ] {
        if bytes
            .windows(marker.len())
            .any(|window| window.eq_ignore_ascii_case(marker))
        {
            return Err(format!(
                "Android library {} contains a build-machine path; rebuild with a fresh C cache",
                path.display()
            )
            .into());
        }
    }
    let prefix = format!("--prefix={INSTALL_PREFIX}");
    if path.file_name() != Some(OsStr::new("libc++_shared.so"))
        && !bytes
            .windows(prefix.len())
            .any(|window| window == prefix.as_bytes())
    {
        return Err(format!(
            "Android library {} lacks the fixed installation prefix; rebuild with a fresh C cache",
            path.display()
        )
        .into());
    }
    Ok(())
}

// Google ships these precompiled runtimes with NDK 27.0.12077973. Keep the
// original bytes (no strip). Upgrading the NDK requires independent new pins.
fn cpp_runtime_sha(abi: Abi) -> &'static str {
    match abi.name {
        "arm64-v8a" => "46b51d661454b9cfaf42c1dc90893b5ad601b7a7ffc2e09d44bb3cc9d20e7ae2",
        "x86_64" => "936e1150309bdae86216f14e493f478d39e588095f1577105856da6d0f24f149",
        _ => unreachable!("validated ABI"),
    }
}
const CPP_RELRO_EXCEPTION: &str =
    "libc++_shared.so: RELRO alignment accepted by pinned NDK runtime exception";
fn elf_facts(
    text: &str,
    abi: Abi,
    name: &str,
    signalsmith: bool,
    runtime: Option<(&str, &str)>,
) -> Result<Value> {
    let app = name == "libbilikara_app.so";
    let cpp = name == "libc++_shared.so";
    if cpp && (!signalsmith || runtime != Some((NDK, cpp_runtime_sha(abi)))) {
        return Err("NDK libc++ runtime version/SHA-256 mismatch".into());
    }
    if !text.lines().any(|l| {
        l.trim()
            .strip_prefix("Machine:")
            .is_some_and(|s| s.trim() == abi.machine)
    }) {
        return Err("Android ELF machine mismatch".into());
    }
    let hex = |s: &str| u64::from_str_radix(s.trim_start_matches("0x"), 16);
    let mut loads = Vec::new();
    let mut relros = Vec::new();
    let mut sonames = Vec::new();
    let mut imports = BTreeSet::new();
    for line in text.lines() {
        let fields: Vec<_> = line.split_whitespace().collect();
        if matches!(fields.first(), Some(&"LOAD" | &"GNU_RELRO")) {
            if fields.len() < 8 {
                return Err("Incomplete ELF segment".into());
            }
            let address = hex(fields[2])?;
            let size = hex(fields[5])?;
            let end = address
                .checked_add(size)
                .ok_or("Android ELF segment overflow")?;
            if fields[0] == "LOAD" {
                let align = hex(fields.last().unwrap())?;
                if align < 16384
                    || !align.is_power_of_two()
                    || address % align != hex(fields[1])? % align
                {
                    return Err("Android ELF LOAD alignment is below 16 KiB or incongruent".into());
                }
                loads.push((
                    address,
                    end,
                    fields[6..fields.len() - 1].iter().any(|f| f.contains('W')),
                ));
            } else {
                if !app && (size == 0 || (!cpp && end % 16384 != 0)) {
                    return Err("Android ELF GNU_RELRO end is not 16 KiB aligned".into());
                }
                relros.push((address, end));
            }
        }
        if line.contains("(NEEDED)") || line.contains("(SONAME)") {
            let value = line
                .split('[')
                .nth(1)
                .and_then(|s| s.split(']').next())
                .ok_or("Invalid ELF dynamic name")?;
            if line.contains("(SONAME)") {
                sonames.push(value);
            } else {
                if app && library_names(signalsmith).contains(&value) {
                    return Err(
                        "Rust Android shell must load its media companion explicitly".into(),
                    );
                }
                if !["libc.so", "libm.so", "libdl.so"].contains(&value)
                    && !(app && ["libandroid.so", "liblog.so"].contains(&value))
                    && !library_names(signalsmith).contains(&value)
                {
                    return Err("Undeclared Android native dependency".into());
                }
                imports.insert(value);
            }
        }
        if line.contains("(RPATH)") || line.contains("(RUNPATH)") || line.contains("(TEXTREL)") {
            return Err("Unexpected Android ELF loader path/text relocation".into());
        }
    }
    if loads.len() < 2 || (!app && relros.len() != 1) {
        return Err("Missing Android ELF LOAD/GNU_RELRO segments".into());
    }
    if !app && sonames != [name] {
        return Err("Android ELF SONAME mismatch (must be unversioned)".into());
    }
    if app {
        return Ok(json!({"machine":abi.machine,"minimum_page_size":16384,"imports":imports}));
    }
    if cpp {
        // Android's official page-size guide, RELRO Example 4: an unaligned
        // end is safe when RELRO fills its LOAD tail and later writable data
        // is on a different 16 KiB page. This is NOT a general exemption for
        // our five built libraries. Both layout and pinned identity must pass.
        // https://developer.android.com/guide/practices/page-sizes#check-relro
        let (start, end) = relros[0];
        let page_end = end.checked_add(16383).ok_or("RELRO page overflow")? & !16383;
        if !loads
            .iter()
            .any(|&(base, limit, _)| base <= start && limit == end)
            || loads
                .iter()
                .any(|&(base, limit, writable)| writable && limit > end && base < page_end)
        {
            return Err("Pinned NDK libc++ RELRO does not occupy an isolated LOAD tail".into());
        }
        return Ok(
            json!({"machine":abi.machine,"minimum_page_size":16384,"relro_page_size":4096,"soname":name,"imports":imports,
            "ndk":NDK,"sha256":cpp_runtime_sha(abi),"relro_alignment_exception":CPP_RELRO_EXCEPTION}),
        );
    }
    Ok(
        json!({"machine":abi.machine,"minimum_page_size":16384,"relro_page_size":16384,"soname":name,"imports":imports}),
    )
}
fn inspect(
    tc: &Path,
    directory: &Path,
    name: &str,
    abi: Abi,
    signalsmith: bool,
    log: &Path,
) -> Result<Value> {
    let mut cmd = command(tc, "llvm-readelf");
    cmd.current_dir(directory)
        .args(["-W", "-h", "-l", "-d"])
        .arg(name);
    execute(cmd, log, 30)?;
    let sha = digest(&fs::read(directory.join(name))?);
    elf_facts(
        &fs::read_to_string(log)?,
        abi,
        name,
        signalsmith,
        Some((NDK, &sha)),
    )
}
fn verify_exports(tc: &Path, directory: &Path, log: &Path, signalsmith: bool) -> Result<()> {
    let mut cmd = command(tc, "llvm-readelf");
    cmd.current_dir(directory)
        .args(["--dyn-syms", "-W", "libbilikara_media_libav.so"]);
    execute(cmd, log, 30)?;
    let text = fs::read_to_string(log)?;
    let mut required = vec![
        "bm_abi_version",
        "bm_get_info",
        "bm_probe_metadata",
        "bm_release",
        "bm_scan_info_v1",
        "bm_scan_packets_v1",
        "bm_scan_release_v1",
        "bm_pcm_info_v1",
        "bm_decode_audio_v1",
        "bm_remux_info_v1",
        "bm_copy_remux_mp4_v1",
        "bm_flac_info_v1",
        "bm_copy_flac_v1",
        "bm_remux_release_v1",
        "bm_live_ts_v1",
        "bm_live_l1_v1",
        "bm_l2_info_v1",
        "bm_live_l2_v1",
        "bm_cast_info_v1",
        "bm_cast_preflight_v1",
        "bm_cast_mux_v1",
    ];
    if signalsmith {
        required.push("bm_stretch_process_v1");
    }
    for name in required {
        if !text
            .lines()
            .any(|l| l.split_whitespace().last() == Some(name) && !l.contains(" UND "))
        {
            return Err(format!("Android companion export missing: {name}").into());
        }
    }
    Ok(())
}
// Final-APK validation shares the strict media ELF/export gate. Application
// imports retain next's explicit-dlopen boundary and are never a media fallback.
pub(super) fn apk_toolchain(ndk: &Path) -> Result<PathBuf> {
    toolchain(ndk)
}
pub(super) fn apk_library(tc: &Path, path: &Path, selected: &str, app: bool) -> Result<Value> {
    let directory = path.parent().ok_or("Missing APK library directory")?;
    let name = path
        .file_name()
        .and_then(OsStr::to_str)
        .ok_or("Invalid APK library name")?;
    if app != (name == "libbilikara_app.so") {
        return Err("Invalid APK library role".into());
    }
    if !app {
        verify_binary_privacy(path)?;
    }
    let log = directory.join("readelf.log");
    let facts = inspect(tc, directory, name, abi(selected)?, true, &log)?;
    if name == "libbilikara_media_libav.so" {
        verify_exports(tc, directory, &log, true)?;
    }
    Ok(facts)
}
fn output_inventory(root: &Path) -> Result<BTreeMap<String, String>> {
    fn walk(root: &Path, path: &Path, result: &mut BTreeMap<String, String>) -> Result<()> {
        for e in fs::read_dir(path)? {
            let e = e?;
            let p = e.path();
            let m = fs::symlink_metadata(&p)?;
            if m.file_type().is_symlink() {
                return Err("Android output contains a link".into());
            }
            if m.is_dir() {
                if fs::read_dir(&p)?.next().is_none() {
                    return Err("Android output contains an unrelated empty directory".into());
                }
                walk(root, &p, result)?
            } else if m.is_file() {
                let rel = p.strip_prefix(root)?;
                if rel != Path::new("build-info.json") {
                    result.insert(
                        rel.to_str()
                            .ok_or("Invalid Android artifact path")?
                            .replace(std::path::MAIN_SEPARATOR, "/"),
                        digest(&fs::read(&p)?),
                    );
                }
            } else {
                return Err("Unsupported Android output object".into());
            }
        }
        Ok(())
    }
    let mut result = BTreeMap::new();
    walk(root, root, &mut result)?;
    Ok(result)
}
fn validate_output(out: &Path) -> Result<Value> {
    let info: Value = serde_json::from_slice(&fs::read(paths::safe_file(
        out,
        &out.join("build-info.json"),
    )?)?)?;
    if info["schema_version"] != 1
        || info["kind"] != "android-libav"
        || info["files"] != serde_json::to_value(output_inventory(out)?)?
    {
        return Err("Android media output is incomplete or contains unrelated files".into());
    }
    let selected = abi(info["abi"].as_str().ok_or("Missing output ABI")?)?;
    let signalsmith = info["signalsmith"]
        .as_bool()
        .ok_or("Missing output profile")?;
    if info["ndk"] != NDK || info["ffmpeg"] != VERSION {
        return Err("Android output version mismatch".into());
    }
    let files = info["files"]
        .as_object()
        .ok_or("Invalid output inventory")?;
    let library_root = format!("jniLibs/{}/", selected.name);
    let expected: BTreeSet<_> = library_names(signalsmith)
        .iter()
        .map(|n| format!("{library_root}{n}"))
        .collect();
    let actual: BTreeSet<_> = files
        .keys()
        .filter(|n| n.starts_with("jniLibs/"))
        .cloned()
        .collect();
    if actual != expected {
        return Err("Android media must contain exactly the selected library set".into());
    }
    let asset_root = format!("assets/bilikara-media/{}/", selected.name);
    let kit_name = format!(
        "bilikara-android-libav-{VERSION}-{}-source-kit.zip",
        selected.name
    );
    let kit = format!("sources/{kit_name}");
    if info["source_kit_sha256"] != digest(&fs::read(out.join(&kit))?)
        || info["source_kit"] != kit_name
        || !files.contains_key(&kit)
        || !files.contains_key(&format!("{asset_root}build-info.json"))
        || !files.contains_key(&format!("{asset_root}licenses/libav-source.txt"))
        || files.keys().any(|n| {
            !expected.contains(n)
                && n != &kit
                && n != &format!("{asset_root}build-info.json")
                && !n.starts_with(&format!("{asset_root}licenses/"))
        })
    {
        return Err("Android output contains missing or unrelated source/license assets".into());
    }
    Ok(info)
}
fn source_kit(root: &Path, prefix: &Path, to: &Path) -> Result<()> {
    let mut zip = zip::ZipWriter::new(fs::File::create(to)?);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o644);
    fn add(
        zip: &mut zip::ZipWriter<fs::File>,
        from: &Path,
        name: &Path,
        options: zip::write::SimpleFileOptions,
    ) -> Result<()> {
        if fs::symlink_metadata(from)?.file_type().is_symlink() {
            return Err("Linked rebuild source".into());
        }
        if from.is_dir() {
            let mut entries = fs::read_dir(from)?.collect::<std::io::Result<Vec<_>>>()?;
            entries.sort_by_key(|e| e.file_name());
            for e in entries {
                add(zip, &e.path(), &name.join(e.file_name()), options)?;
            }
        } else {
            zip.start_file(
                name.to_str()
                    .ok_or("Invalid rebuild path")?
                    .replace(std::path::MAIN_SEPARATOR, "/"),
                options,
            )?;
            let mut file = fs::File::open(from)?;
            std::io::copy(&mut file, zip)?;
        }
        Ok(())
    }
    add(
        &mut zip,
        &prefix.join("source"),
        Path::new("source"),
        options,
    )?;
    for name in ["licenses", "records"] {
        add(&mut zip, &prefix.join(name), Path::new(name), options)?;
    }
    for name in ["media-libav", "xtask/src"] {
        add(&mut zip, &root.join(name), Path::new(name), options)?;
    }
    for name in [
        "xtask/Cargo.toml",
        "xtask/Cargo.lock",
        "rust-toolchain.toml",
        "LICENSE",
        "THIRD_PARTY_NOTICES.md",
    ] {
        add(&mut zip, &root.join(name), Path::new(name), options)?;
    }
    zip.start_file("REBUILD-ANDROID.md", options)?;
    std::io::Write::write_all(&mut zip, b"# Android libav rebuild\n\nInstall the pinned Rust toolchain, NDK 27.0.12077973 and bash, make, gcc, tar, curl, gpg/gpgv (MSYS2 on Windows). From this extracted root run:\n\ncargo run --manifest-path xtask/Cargo.toml --locked --target host-tuple -- android-libav --ndk <absolute NDK> --abi arm64-v8a --out <absolute output> --cache <absolute cache> --source-dir <absolute extracted source/>\n\nThe original signed FFmpeg 9.0.1 tarball is unmodified. records/config.h contains the exact FFmpeg configuration. Companion source and complete xtask rebuild tooling are included. Use a fresh cache for a clean rebuild.\n")?;
    zip.finish()?;
    Ok(())
}
fn companion(root: &Path, o: &Options, tc: &Path, prefix: &Path, key: &str) -> Result<()> {
    let parent = o.out.parent().ok_or("No Android output parent")?;
    fs::create_dir_all(parent)?;
    let stage = tempfile::Builder::new()
        .prefix(".android-libav-output-")
        .tempdir_in(parent)?;
    let payload = stage.path().join("payload");
    let libraries = payload.join("jniLibs").join(o.abi.name);
    let assets = payload.join("assets/bilikara-media").join(o.abi.name);
    fs::create_dir_all(&libraries)?;
    fs::create_dir_all(&assets)?;
    let cfg = fs::read_to_string(prefix.join("records/config.h"))?;
    let config = cfg
        .lines()
        .find_map(|l| l.strip_prefix("#define FFMPEG_CONFIGURATION "))
        .ok_or("Missing FFmpeg build configuration")?;
    fs::write(
        stage.path().join("build_config.h"),
        format!("#define BM_BUILD_CONFIG {config}\n"),
    )?;
    // All compiler inputs/outputs live under this owned cwd. Filesystem copy
    // uses validated canonical paths; external tools only see relative args.
    files::tree(
        &root.join("media-libav"),
        &stage.path().join("media-libav"),
        false,
    )?;
    files::tree(
        &prefix.join("include"),
        &stage.path().join("include"),
        false,
    )?;
    fs::create_dir(stage.path().join("lib"))?;
    for name in &LIBRARIES[..4] {
        let source = paths::safe_file(prefix, &prefix.join("lib").join(name))?;
        files::copy(&source, &stage.path().join("lib").join(name))?;
        files::copy(&source, &libraries.join(name))?;
    }
    let target = format!("--target={}24", o.abi.triple);
    if o.signalsmith {
        let mut cpp = command(tc, "clang++");
        cpp.current_dir(stage.path()).arg(&target).args([
            "-std=c++17",
            "-O2",
            "-fPIC",
            "-fvisibility=hidden",
            "-Wall",
            "-Wextra",
            "-Werror",
            "-c",
            "media-libav/stretch.cpp",
            "-o",
            "stretch.o",
        ]);
        execute(cpp, &stage.path().join("cpp.log"), 120)?;
        files::copy(
            &tc.join("sysroot/usr/lib")
                .join(o.abi.triple)
                .join("libc++_shared.so"),
            &libraries.join("libc++_shared.so"),
        )?;
    }
    let mut cc = command(tc, "clang");
    cc.current_dir(stage.path()).arg(target).args([
        "-std=c11",
        "-O2",
        "-fPIC",
        "-fvisibility=hidden",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-shared",
        "-I",
        "include",
        "-I",
        ".",
        "media-libav/probe.c",
        "-L",
        "lib",
        "-lavformat",
        "-lavcodec",
        "-lavutil",
        "-lswresample",
        "-lm",
        "-Wl,-z,defs",
        "-Wl,-z,max-page-size=16384",
        "-Wl,-z,common-page-size=16384",
        "-Wl,-soname,libbilikara_media_libav.so",
    ]);
    if o.signalsmith {
        cc.args(["stretch.o", "-lc++_shared"]);
    }
    cc.arg("-o").arg(format!(
        "payload/jniLibs/{}/libbilikara_media_libav.so",
        o.abi.name
    ));
    execute(cc, &stage.path().join("cc.log"), 120)?;
    let mut facts = BTreeMap::new();
    for name in library_names(o.signalsmith) {
        if name != "libc++_shared.so" {
            let mut strip = command(tc, "llvm-strip");
            strip
                .current_dir(&libraries)
                .arg("--strip-unneeded")
                .arg(name);
            execute(strip, &stage.path().join("strip.log"), 30)?;
        }
        verify_binary_privacy(&libraries.join(name))?;
        facts.insert(
            name,
            inspect(
                tc,
                &libraries,
                name,
                o.abi,
                o.signalsmith,
                &stage.path().join("readelf.log"),
            )?,
        );
    }
    verify_exports(
        tc,
        &libraries,
        &stage.path().join("symbols.log"),
        o.signalsmith,
    )?;
    files::tree(
        &prefix.join("licenses"),
        &assets.join("licenses/libav"),
        false,
    )?;
    files::copy(
        &root.join("THIRD_PARTY_NOTICES.md"),
        &assets.join("licenses/THIRD_PARTY_NOTICES.md"),
    )?;
    if o.signalsmith {
        for (source, name) in [
            (
                root.join("media-libav/signalsmith/LICENSE.txt"),
                "Signalsmith-Stretch.txt",
            ),
            (
                root.join("media-libav/signalsmith/signalsmith-linear/LICENSE.txt"),
                "Signalsmith-Linear.txt",
            ),
            (o.ndk.join("NOTICE"), "Android-NDK-NOTICE.txt"),
        ] {
            files::copy(&source, &assets.join("licenses").join(name))?;
        }
    }
    let kit_name = format!(
        "bilikara-android-libav-{VERSION}-{}-source-kit.zip",
        o.abi.name
    );
    fs::create_dir(payload.join("sources"))?;
    source_kit(root, prefix, &payload.join("sources").join(&kit_name))?;
    let kit_sha256 = digest(&fs::read(payload.join("sources").join(&kit_name))?);
    fs::write(
        assets.join("licenses/libav-source.txt"),
        format!(
            "FFmpeg {VERSION} (LGPL-2.1-or-later), dynamically linked; original source is unmodified.\nSource SHA-256: {SOURCE_SHA}\nSigning fingerprint: {FINGERPRINT}\nConfiguration: {config}\nCorresponding source and rebuild kit: {kit_name}\nDistributed separately alongside this APK at the same download location.\nUpstream archive: https://ffmpeg.org/releases/ffmpeg-{VERSION}.tar.xz\n"
        ),
    )?;
    files::write_json(
        &assets.join("build-info.json"),
        &json!({"schema_version":1,"abi":o.abi.name,"ndk":NDK,"ffmpeg":VERSION,"c_cache_key":key,"signalsmith":o.signalsmith,"configuration":config,"source_kit":kit_name,"source_kit_sha256":kit_sha256,"libraries":facts}),
    )?;
    files::write_json(
        &payload.join("build-info.json"),
        &json!({"schema_version":1,"kind":"android-libav","abi":o.abi.name,"ndk":NDK,"ffmpeg":VERSION,"c_cache_key":key,"signalsmith":o.signalsmith,"configuration":config,"source_kit":kit_name,"source_kit_sha256":kit_sha256,"libraries":facts,"files":output_inventory(&payload)?}),
    )?;
    validate_output(&payload)?;
    // Replace only our previously validated output. Preserve it on every failed
    // compiler, dependency, source-kit or final rename check.
    if o.out.exists() {
        validate_output(&o.out)?;
        replace_output_directory(&o.out, &stage.path().join("previous"))?;
    }
    if let Err(error) = fs::rename(&payload, &o.out) {
        if stage.path().join("previous").exists()
            && fs::rename(stage.path().join("previous"), &o.out).is_err()
        {
            let recovery = stage.keep();
            return Err(format!(
                "Cannot publish Android output {} to {}: {error}; rollback also failed; previous output retained at {}",
                payload.display(), o.out.display(), recovery.join("previous").display()
            )
            .into());
        }
        return Err(format!("Cannot publish Android output {} to {}: {error}; the destination may be in use by another process", payload.display(), o.out.display()).into());
    }
    println!("Android media complete: {}", o.out.display());
    Ok(())
}
fn replace_output_directory(from: &Path, to: &Path) -> Result<()> {
    fs::rename(from, to).map_err(|error| format!(
        "Cannot move existing Android output {} to {} while replacing the output directory: {error}; it may be in use by another process; leave that directory and retry (existing output preserved)",
        from.display(), to.display()
    ).into())
}
pub fn run(args: Vec<OsString>) -> Result<()> {
    let mut o = options(args)?;
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .canonicalize()?;
    // Validate the NDK through canonical paths, retaining the caller's native
    // spelling for the launched compiler's own sysroot discovery.
    paths::absolute(&o.ndk)?;
    o.out = paths::absolute(&o.out)?;
    o.cache = libav_cache::cache_location(&root, &o.cache)?;
    paths::disjoint(&o.out, &o.cache)?;
    paths::disjoint(&o.out, &o.ndk)?;
    paths::disjoint(&o.cache, &o.ndk)?;
    if root.starts_with(&o.out)
        || ["media-libav", "xtask", "static", "rust", "rust-runtime"]
            .iter()
            .any(|p| o.out.starts_with(root.join(p)))
    {
        return Err("Android media output overlaps source".into());
    }
    if let Some(source) = &o.source {
        paths::disjoint(source, &o.out)?;
        paths::disjoint(source, &o.cache)?;
    }
    if o.key && o.verify {
        return Err("--cache-key and --verify-only are mutually exclusive".into());
    }
    let tc = toolchain(&o.ndk)?;
    if o.verify {
        let info = validate_output(&o.out)?;
        if info["abi"] != o.abi.name {
            return Err("Android output ABI mismatch".into());
        }
        if info["signalsmith"] != o.signalsmith {
            return Err("Android output profile mismatch".into());
        }
        let stage = tempfile::Builder::new()
            .prefix(".android-libav-verify-")
            .tempdir_in(o.out.parent().ok_or("Missing output parent")?)?;
        let directory = o.out.join("jniLibs").join(o.abi.name);
        for name in library_names(o.signalsmith) {
            verify_binary_privacy(&directory.join(name))?;
            let facts = inspect(
                &tc,
                &directory,
                name,
                o.abi,
                o.signalsmith,
                &stage.path().join("readelf.log"),
            )?;
            if info["libraries"][name] != facts {
                return Err("Android output library facts mismatch".into());
            }
        }
        verify_exports(
            &tc,
            &directory,
            &stage.path().join("symbols.log"),
            o.signalsmith,
        )?;
        println!("Android media verified");
        return Ok(());
    }
    let compiler = command(&tc, "clang").arg("--version").output()?;
    if !compiler.status.success() {
        return Err("Selected NDK compiler unavailable".into());
    }
    let key = cache_key(o.abi, &compiler.stdout)?;
    if o.key {
        println!("key={key}");
        return Ok(());
    }
    if o.signalsmith && !root.join("media-libav/stretch.cpp").is_file() {
        return Err("Required Signalsmith companion source is not provisioned".into());
    }
    if o.out.exists() {
        validate_output(&o.out)?;
    }
    fs::create_dir_all(&o.cache)?;
    let prefix = upstream(&o, &tc, &key)?;
    companion(&root, &o, &tc, &prefix, &key)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fixed_prefix_and_binary_scan_reject_build_machine_paths() {
        assert!(verify_configuration("#define FFMPEG_CONFIGURATION \"--prefix=/bilikara-android-libav --target-os=android\"\n").is_ok());
        for prefix in [
            "/home/private-builder/cache",
            "/c/Users/private-builder/cache",
            "/bilikara-android-libav --prefix=/tmp/second",
        ] {
            assert!(
                verify_configuration(&format!(
                    "#define FFMPEG_CONFIGURATION \"--prefix={prefix}\"\n"
                ))
                .is_err()
            );
        }
        let temp = temporary();
        let library = temp.path().join("libavutil.so");
        fs::write(&library, b"\x7fELF\0--prefix=/bilikara-android-libav\0").unwrap();
        assert!(verify_binary_privacy(&library).is_ok());
        fs::write(&library, b"\x7fELF\0--prefix=/tmp/old-build\0").unwrap();
        assert!(
            verify_binary_privacy(&library)
                .unwrap_err()
                .to_string()
                .contains("lacks the fixed installation prefix")
        );
        for path in [
            "/c/Users/private-builder/cache",
            "C:\\Users\\private-builder\\cache",
            "/home/private-builder/cache",
            "/Users/private-builder/cache",
            "/tmp/.android-libav-build-random",
        ] {
            fs::write(&library, format!("\x7fELF\0{path}\0")).unwrap();
            let error = verify_binary_privacy(&library).unwrap_err().to_string();
            assert!(error.contains("build-machine path"));
            assert!(error.contains("libavutil.so"));
        }
    }
    #[test]
    fn replacement_failure_identifies_operation_and_both_paths() {
        let temp = temporary();
        let old = temp.path().join("old-output");
        let backup = temp.path().join("occupied-backup");
        fs::create_dir(&old).unwrap();
        fs::create_dir(&backup).unwrap();
        fs::write(old.join("preserve"), "old library").unwrap();
        fs::write(backup.join("occupied"), "unrelated").unwrap();
        let error = replace_output_directory(&old, &backup)
            .unwrap_err()
            .to_string();
        assert!(error.contains(&old.display().to_string()));
        assert!(error.contains(&backup.display().to_string()));
        assert!(error.contains("replacing the output directory"));
        assert!(error.contains("in use by another process"));
        assert_eq!(
            fs::read_to_string(old.join("preserve")).unwrap(),
            "old library"
        );
        assert_eq!(
            fs::read_to_string(backup.join("occupied")).unwrap(),
            "unrelated"
        );
    }
    fn temporary() -> tempfile::TempDir {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join(".tmp");
        fs::create_dir_all(&root).unwrap();
        tempfile::Builder::new()
            .prefix("android-libav-test-")
            .tempdir_in(root)
            .unwrap()
    }
    fn elf(name: &str) -> String {
        format!(
            "Machine: AArch64\nLOAD 0x000000 0x000000 0x000000 0x010000 0x010000 R E 0x4000\nLOAD 0x010000 0x014000 0x014000 0x002000 0x004000 RW 0x4000\nGNU_RELRO 0x010000 0x014000 0x014000 0x002000 0x004000 R 0x1\n0 (SONAME) Library soname: [{name}]\n0 (NEEDED) Shared library: [libavcodec.so]\n0 (NEEDED) Shared library: [libc.so]\n"
        )
    }
    #[test]
    fn elf_enforces_machine_load_relro_soname_and_dependency_closure() {
        let arm = abi("arm64-v8a").unwrap();
        let name = "libbilikara_media_libav.so";
        let good = elf(name);
        let check = |text: &str| elf_facts(text, arm, name, false, None);
        assert_eq!(check(&good).unwrap()["relro_page_size"], 16384);
        for bad in [
            good.replace("AArch64", "Advanced Micro Devices X86-64"),
            good.replace("R E 0x4000", "R E 0x1000"),
            good.replace("RW 0x4000", "RW 0x6000"),
            good.replace("0x014000 0x014000", "0x015000 0x015000"),
            good.replace("0x004000 R 0x1", "0x001000 R 0x1"),
            good.replace("GNU_RELRO", "IGNORED"),
            good.replace(name, "libbilikara_media_libav.so.1"),
            good.replace("(SONAME)", "(IGNORED)"),
            good.replace("libavcodec.so", "libavcodec.so.63"),
            good.replace("libavcodec.so", "libc++_shared.so"),
            good.replace("libavcodec.so", "liblog.so"),
            format!("{good}\n0 (RUNPATH) Library runpath: [/tmp]"),
            format!("{good}\n0 (TEXTREL) 0x0"),
        ] {
            assert!(check(&bad).is_err(), "accepted {bad}");
        }
        assert!(elf_facts(&good, abi("x86_64").unwrap(), name, false, None).is_err());
        assert!(
            elf_facts(
                &good.replace("libavcodec.so", "libc++_shared.so"),
                arm,
                name,
                true,
                None
            )
            .is_ok()
        );
        assert!(check(&good.replace("0x002000 0x004000 R 0x1", "0x000123 0x004000 R 0x1")).is_ok());
        assert!(
            check(&format!(
                "{good}GNU_RELRO 0 0xffffffffffffc000 0 0 0x4000 R 1\n"
            ))
            .is_err()
        );
    }
    #[test]
    fn cpp_runtime_exception_requires_pinned_identity_and_isolated_relro() {
        let arm = abi("arm64-v8a").unwrap();
        let name = "libc++_shared.so";
        let good = elf(name).replace("0x004000", "0x003000");
        let identity = Some((NDK, cpp_runtime_sha(arm)));
        let check = |text: &str| elf_facts(text, arm, name, true, identity);
        assert_eq!(
            check(&good).unwrap()["relro_alignment_exception"],
            CPP_RELRO_EXCEPTION
        );
        for bad_identity in [
            None,
            Some(("28.0.0", cpp_runtime_sha(arm))),
            Some((NDK, "changed")),
        ] {
            assert!(elf_facts(&good, arm, name, true, bad_identity).is_err());
        }
        for bad in [
            good.replace("R E 0x4000", "R E 0x1000"),
            good.replace("0x003000 R 0x1", "0x002000 R 0x1"),
            format!("{good}LOAD 0x013000 0x017000 0x017000 0x1000 0x1000 RW 0x4000\n"),
            good.replace("soname: [libc++_shared.so]", "soname: [liboutside.so]"),
        ] {
            assert!(check(&bad).is_err(), "accepted {bad}");
        }
        for name in LIBRARIES {
            assert!(
                elf_facts(
                    &elf(name).replace("0x004000 R 0x1", "0x003000 R 0x1"),
                    arm,
                    name,
                    true,
                    identity
                )
                .is_err()
            );
        }
    }
    #[test]
    fn application_keeps_explicit_dlopen_dependency_boundary() {
        let arm = abi("arm64-v8a").unwrap();
        let app = elf("libbilikara_app.so").replace("libavcodec.so", "libandroid.so");
        assert!(elf_facts(&app, arm, "libbilikara_app.so", true, None).is_ok());
        for library in library_names(true) {
            assert!(
                elf_facts(
                    &app.replace("libandroid.so", library),
                    arm,
                    "libbilikara_app.so",
                    true,
                    None
                )
                .is_err()
            );
        }
        assert!(
            elf_facts(
                &elf("libavutil.so").replace("libavcodec.so", "libandroid.so"),
                arm,
                "libavutil.so",
                true,
                None
            )
            .is_err()
        );
    }
    #[test]
    fn signature_and_source_fail_closed() {
        let good =
            format!("[GNUPG:] VALIDSIG {FINGERPRINT} 2026-01-01 0 0 4 0 1 10 00 {FINGERPRINT}\n");
        assert!(verify_signer(&good).is_ok());
        for bad in [
            String::new(),
            good.replace(FINGERPRINT, "0000000000000000000000000000000000000000"),
            format!("untrusted prefix {good}"),
            format!("{good}{good}"),
            "[GNUPG:] GOODSIG B4322F04D67658D8 FFmpeg\n".into(),
        ] {
            assert!(verify_signer(&bad).is_err());
        }
        let temp = temporary();
        let archive = temp.path().join("ffmpeg.tar.xz");
        fs::write(&archive, b"corrupted source").unwrap();
        assert!(
            verify_source(&archive)
                .unwrap_err()
                .to_string()
                .contains("digest mismatch")
        );
    }
    #[test]
    fn cache_identity_preserves_next_profile_and_excludes_downstream_sources() {
        let arm = abi("arm64-v8a").unwrap();
        let key = cache_key(arm, b"NDK compiler").unwrap();
        assert_ne!(
            key,
            cache_key(abi("x86_64").unwrap(), b"NDK compiler").unwrap()
        );
        assert_ne!(key, cache_key(arm, b"new compiler").unwrap());
        assert_eq!(
            key,
            "android-libav-v1-arm64-v8a-0216ccd7a98650e549d8ee8b98ba057b79f9f8e4a0ab09d091ef08a776191413"
        );
        assert_eq!(library_names(false).len(), 5);
        assert_eq!(library_names(true).len(), 6);
        assert!(abi("armeabi-v7a").is_err());
        assert!(CONFIGURE.contains(&"--enable-parser=aac,flac,h264,eac3,ac3,mpegaudio,opus"));
        assert!(
            !CONFIGURE
                .iter()
                .any(|s| s.contains("enable-gpl") || s.contains("enable-nonfree"))
        );
    }
    fn output(out: &Path) {
        let libs = out.join("jniLibs/arm64-v8a");
        let assets = out.join("assets/bilikara-media/arm64-v8a");
        fs::create_dir_all(&libs).unwrap();
        fs::create_dir_all(assets.join("licenses")).unwrap();
        fs::create_dir_all(out.join("sources")).unwrap();
        for name in LIBRARIES {
            fs::write(libs.join(name), name).unwrap();
        }
        fs::write(assets.join("build-info.json"), "{}").unwrap();
        fs::write(assets.join("licenses/libav-source.txt"), "source location").unwrap();
        fs::write(
            out.join("sources/bilikara-android-libav-9.0.1-arm64-v8a-source-kit.zip"),
            "kit",
        )
        .unwrap();
        reseal(out);
    }
    fn reseal(out: &Path) {
        files::write_json(
            &out.join("build-info.json"),
            &json!({"schema_version":1,"kind":"android-libav",
            "abi":"arm64-v8a","ndk":NDK,"ffmpeg":VERSION,"signalsmith":false,
            "source_kit":"bilikara-android-libav-9.0.1-arm64-v8a-source-kit.zip",
            "source_kit_sha256":digest(&fs::read(out.join("sources/bilikara-android-libav-9.0.1-arm64-v8a-source-kit.zip")).unwrap()),
            "files":output_inventory(out).unwrap()}),
        )
        .unwrap();
    }
    #[test]
    fn output_inventory_rejects_tampering_extra_libraries_and_embedded_source() {
        let temp = temporary();
        let out = temp.path();
        output(out);
        assert!(validate_output(out).is_ok());
        let lib = out.join("jniLibs/arm64-v8a/libavcodec.so");
        fs::write(&lib, "changed").unwrap();
        assert!(validate_output(out).is_err());
        fs::write(&lib, "libavcodec.so").unwrap();
        for name in [
            "jniLibs/arm64-v8a/liboutside.so",
            "assets/bilikara-media/arm64-v8a/source-kit.zip",
            "user-data",
        ] {
            let file = out.join(name);
            fs::write(&file, "unrelated").unwrap();
            reseal(out);
            assert!(validate_output(out).is_err(), "accepted {name}");
            fs::remove_file(file).unwrap();
        }
        reseal(out);
        assert!(validate_output(out).is_ok());
        fs::remove_file(&lib).unwrap();
        reseal(out);
        assert!(validate_output(out).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn output_rejects_symlinks() {
        let temp = temporary();
        output(temp.path());
        std::os::unix::fs::symlink(
            "libavcodec.so",
            temp.path().join("jniLibs/arm64-v8a/link.so"),
        )
        .unwrap();
        assert!(output_inventory(temp.path()).is_err());
    }
    #[test]
    fn source_kit_contains_original_source_configuration_and_rebuild_tooling() {
        let temp = temporary();
        let root = temp.path().join("root");
        let prefix = temp.path().join("prefix");
        for name in [
            "media-libav/probe.c",
            "xtask/src/main.rs",
            "xtask/Cargo.toml",
            "xtask/Cargo.lock",
            "rust-toolchain.toml",
            "LICENSE",
            "THIRD_PARTY_NOTICES.md",
        ] {
            let p = root.join(name);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, name).unwrap();
        }
        for name in [
            "source/ffmpeg-9.0.1.tar.xz",
            "source/ffmpeg-9.0.1.tar.xz.asc",
            "source/ffmpeg-devel.asc",
            "licenses/COPYING.LGPLv2.1",
            "records/config.h",
        ] {
            let p = prefix.join(name);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, name.as_bytes()).unwrap();
        }
        let kit = temp.path().join("kit.zip");
        source_kit(&root, &prefix, &kit).unwrap();
        let mut archive = zip::ZipArchive::new(fs::File::open(kit).unwrap()).unwrap();
        assert!(archive.by_name("xtask/Cargo.lock").is_ok());
        assert!(archive.by_name("media-libav/probe.c").is_ok());
        assert!(archive.by_name("records/config.h").is_ok());
        let mut original = Vec::new();
        archive
            .by_name("source/ffmpeg-9.0.1.tar.xz")
            .unwrap()
            .read_to_end(&mut original)
            .unwrap();
        assert_eq!(original, b"source/ffmpeg-9.0.1.tar.xz");
        let mut instructions = String::new();
        archive
            .by_name("REBUILD-ANDROID.md")
            .unwrap()
            .read_to_string(&mut instructions)
            .unwrap();
        assert!(instructions.contains("--source-dir"));
    }
    #[test]
    fn cache_rejects_downstream_payload_and_inventory_mismatch() {
        let temp = temporary();
        fs::create_dir(temp.path().join("lib")).unwrap();
        fs::write(
            temp.path().join("lib/libbilikara_media_libav.so"),
            b"downstream",
        )
        .unwrap();
        let seal = || {
            files::write_json(&temp.path().join("cache-manifest.json"), &json!({
            "schema_version":1,"kind":"android-upstream-c","key":"fixture-key","abi":"arm64-v8a",
            "entries":libav_cache::inventory(temp.path(), false).unwrap()
        })).unwrap()
        };
        files::write_json(&temp.path().join("cache-manifest.json"), &json!({})).unwrap();
        let check = || verify_cache(temp.path(), abi("arm64-v8a").unwrap(), "fixture-key");
        assert!(
            check()
                .unwrap_err()
                .to_string()
                .contains("Invalid libav cache path")
        );
        fs::remove_file(temp.path().join("lib/libbilikara_media_libav.so")).unwrap();
        fs::write(temp.path().join("lib/libavcodec.so"), b"original").unwrap();
        seal();
        fs::write(temp.path().join("lib/libavcodec.so"), b"changed").unwrap();
        assert!(
            check()
                .unwrap_err()
                .to_string()
                .contains("inventory/target mismatch")
        );
    }
    #[test]
    fn output_preserves_unrelated_empty_directory() {
        let temp = temporary();
        output(temp.path());
        fs::create_dir(temp.path().join("unrelated")).unwrap();
        assert!(validate_output(temp.path()).is_err());
        assert!(temp.path().join("unrelated").is_dir());
    }
    #[test]
    fn cli_rejects_duplicates_and_requires_signalsmith() {
        let base: Vec<OsString> = [
            "--ndk",
            "ndk",
            "--out",
            "out",
            "--cache",
            "cache",
            "--abi",
            "arm64-v8a",
        ]
        .map(Into::into)
        .to_vec();
        assert!(options(base.clone()).unwrap().signalsmith);
        for extra in [
            vec!["--abi", "x86_64"],
            vec!["--unknown"],
            vec!["--source-dir"],
            vec!["--cache-key", "--cache-key"],
            vec!["--with-signalsmith", "--with-signalsmith"],
        ] {
            let mut args = base.clone();
            args.extend(extra.into_iter().map(Into::into));
            assert!(options(args).is_err());
        }
    }
    #[test]
    fn failed_stage_retains_only_bounded_owned_log() {
        let temp = temporary();
        let stage = temp.path().join("stage");
        fs::create_dir(&stage).unwrap();
        let log = stage.join("cc.log");
        let mut bytes = vec![b'x'; 2 * 1024 * 1024];
        bytes.extend_from_slice(b"\ncompiler failed\n");
        fs::write(&log, bytes).unwrap();
        let error = failed_log(&log, "stage failed").to_string();
        assert!(error.contains("stage: cc.log"));
        assert!(error.len() < 9000);
        assert!(error.ends_with("compiler failed\n"));
        let retained = PathBuf::from(
            error
                .split("; log: ")
                .nth(1)
                .unwrap()
                .lines()
                .next()
                .unwrap(),
        );
        assert!(
            retained
                .parent()
                .unwrap()
                .ends_with(".tmp/android-libav-logs")
        );
        assert_eq!(fs::metadata(&retained).unwrap().len(), 1024 * 1024);
        drop(temp);
        assert_eq!(fs::metadata(&retained).unwrap().len(), 1024 * 1024);
        assert!(fs::read(&retained).unwrap().ends_with(b"compiler failed\n"));
        fs::remove_file(retained).unwrap();
    }
}
