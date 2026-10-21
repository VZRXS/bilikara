//! Android's signed, upstream-C-only cache and separately rebuilt companion.
//! Foreign ELF is inspected with the selected NDK, never loaded on the host.
use crate::{Result, files, libav_cache, libav_prepare as paths};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    env,
    ffi::{OsStr, OsString},
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const NDK: &str = "27.0.12077973";
const VERSION: &str = "9.0.1";
const SOURCE_SHA: &str = "cf38e0e28c7e5605942c4a77755349b0145804a397af37eb1fb4c77cb237f635";
const FINGERPRINT: &str = "FCF986EA15E6E293A5644F10B4322F04D67658D8";
const LIBRARIES: &[&str] = &[
    "libavformat.so",
    "libavcodec.so",
    "libavutil.so",
    "libswresample.so",
    "libbilikara_media_libav.so",
    "libc++_shared.so",
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
}
fn options(args: Vec<OsString>) -> Result<Options> {
    let mut values = BTreeMap::new();
    let mut key = false;
    let mut verify = false;
    let mut args = args.into_iter();
    while let Some(name) = args.next() {
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
    tc.join("bin")
        .join(format!("{name}{}", env::consts::EXE_SUFFIX))
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
    let retained = (|| -> Result<PathBuf> {
        let mut copy = tempfile::Builder::new()
            .prefix("bilikara-android-media-failure-")
            .suffix(".log")
            .tempfile()?;
        std::io::copy(&mut fs::File::open(log)?.take(1024 * 1024), &mut copy)?;
        Ok(copy.keep()?.1)
    })();
    format!(
        "{reason}; log: {}",
        retained.as_deref().unwrap_or(log).display()
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
            return Err(failed_log(log, "Android media build stage failed"));
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

fn shell_path(path: &Path) -> Result<OsString> {
    #[cfg(windows)]
    {
        let result = Command::new("bash")
            .args(["-c", "cygpath -u \"$1\"", "--"])
            .arg(path)
            .output()?;
        if !result.status.success() {
            return Err("Android FFmpeg on Windows requires MSYS2 bash/make/GPG".into());
        }
        Ok(String::from_utf8(result.stdout)?.trim().into())
    }
    #[cfg(not(windows))]
    {
        Ok(path.as_os_str().to_owned())
    }
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
            cmd.args([
                "--fail",
                "--location",
                "--proto",
                "=https",
                "--max-time",
                "120",
                "--max-filesize",
                "20971520",
            ])
            .arg(url)
            .arg("-o")
            .arg(source.join(&name));
            execute(cmd, &prefix.join("records/download.log"), 130)?;
        }
    }
    let archive = source.join(format!("ffmpeg-{VERSION}.tar.xz"));
    if digest(&fs::read(&archive)?) != SOURCE_SHA {
        return Err("Pinned FFmpeg source digest mismatch".into());
    }
    let keyring = work.path().join("keyring");
    fs::create_dir(&keyring)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&keyring, fs::Permissions::from_mode(0o700))?;
    }
    let mut gpg = Command::new("gpg");
    gpg.args(["--no-options", "--homedir"])
        .arg(&keyring)
        .args(["--no-autostart", "--batch", "--dearmor", "--output"])
        .arg(keyring.join("release.gpg"))
        .arg(source.join("ffmpeg-devel.asc"));
    execute(gpg, &prefix.join("records/key.log"), 30)?;
    // gpgv verifies public material without contacting gpg-agent. This also
    // preserves legitimate long/CJK build paths without Unix socket limits.
    let mut gpg = Command::new("gpgv");
    gpg.arg("--homedir")
        .arg(&keyring)
        .arg("--keyring")
        .arg(keyring.join("release.gpg"))
        .args(["--status-fd", "1"])
        .arg(source.join(format!("ffmpeg-{VERSION}.tar.xz.asc")))
        .arg(&archive);
    let sig = prefix.join("records/signature.log");
    execute(gpg, &sig, 30)?;
    if !fs::read_to_string(sig)?.contains(&format!("[GNUPG:] VALIDSIG {FINGERPRINT} ")) {
        return Err("Unexpected FFmpeg signing fingerprint".into());
    }
    let mut tar = Command::new("tar");
    tar.arg("-xf").arg(&archive).arg("-C").arg(work.path());
    execute(tar, &prefix.join("records/extract.log"), 60)?;
    let source = work.path().join(format!("ffmpeg-{VERSION}"));
    let mut build = Command::new("bash");
    build.current_dir(&source).arg("./configure").args(CONFIGURE)
        .arg(format!("--arch={}",o.abi.arch)).arg(format!("--prefix={}",shell_path(&prefix)?.to_string_lossy()))
        .arg(format!("--extra-cflags=--target={}24",o.abi.triple))
        .arg(format!("--extra-ldflags=--target={}24 -Wl,-z,max-page-size=16384 -Wl,-z,common-page-size=16384",o.abi.triple));
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
    let mut make = Command::new("make");
    make.current_dir(&source)
        .env("PATH", &path)
        .args(["install-libs", "install-headers"]);
    execute(make, &prefix.join("records/install.log"), 120)?;
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
    if manifest["schema_version"] != 1
        || manifest["kind"] != "android-upstream-c"
        || manifest["key"] != key
        || manifest["abi"] != abi.name
        || manifest["entries"] != serde_json::to_value(libav_cache::inventory(prefix, false)?)?
    {
        return Err("Android C cache inventory/target mismatch".into());
    }
    if digest(&fs::read(
        prefix.join(format!("source/ffmpeg-{VERSION}.tar.xz")),
    )?) != SOURCE_SHA
    {
        return Err("Android C cache source mismatch".into());
    }
    let cfg = fs::read_to_string(prefix.join("records/config.h"))?;
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

fn elf_facts(text: &str, abi: Abi) -> Result<Value> {
    elf_facts_role(text, abi, false)
}
fn elf_facts_role(text: &str, abi: Abi, app: bool) -> Result<Value> {
    if !text.lines().any(|l| {
        l.trim()
            .strip_prefix("Machine:")
            .is_some_and(|s| s.trim() == abi.machine)
    }) {
        return Err("Android ELF machine mismatch".into());
    }
    let mut loads = 0;
    let mut imports = BTreeSet::new();
    for line in text.lines() {
        if line.trim_start().starts_with("LOAD ") {
            let align = line
                .split_whitespace()
                .last()
                .ok_or("Missing ELF LOAD alignment")?;
            if u64::from_str_radix(align.trim_start_matches("0x"), 16)? < 16384 {
                return Err("Android ELF LOAD alignment is below 16 KiB".into());
            }
            loads += 1;
        }
        if line.contains("(NEEDED)") {
            let name = line
                .split('[')
                .nth(1)
                .and_then(|s| s.split(']').next())
                .ok_or("Invalid DT_NEEDED")?;
            if app && LIBRARIES.contains(&name) {
                return Err("Rust Android shell must load its media companion explicitly".into());
            }
            if !["libc.so", "libm.so", "libdl.so"].contains(&name)
                && !(app && ["libandroid.so", "liblog.so"].contains(&name))
                && !LIBRARIES.contains(&name)
            {
                return Err("Undeclared Android native dependency".into());
            }
            imports.insert(name);
        }
    }
    if loads < 2 {
        return Err("No usable Android ELF LOAD segments".into());
    }
    Ok(json!({"machine":abi.machine,"minimum_page_size":16384,"imports":imports}))
}
pub(super) fn apk_toolchain(ndk: &Path) -> Result<PathBuf> {
    toolchain(ndk)
}
pub(super) fn apk_library(tc: &Path, path: &Path, name: &str, app: bool) -> Result<Value> {
    let stage = tempfile::Builder::new()
        .prefix("bilikara-apk-elf-")
        .tempdir()?;
    let log = stage.path().join("readelf.log");
    let mut cmd = command(tc, "llvm-readelf");
    cmd.args(["-W", "-h", "-l", "-d"]).arg(path);
    execute(cmd, &log, 30)?;
    let facts = elf_facts_role(&fs::read_to_string(&log)?, abi(name)?, app)?;
    if path.file_name() == Some(OsStr::new("libbilikara_media_libav.so")) {
        let mut cmd = command(tc, "llvm-readelf");
        cmd.args(["--dyn-syms", "-W"]).arg(path);
        execute(cmd, &log, 30)?;
        let symbols = fs::read_to_string(&log)?;
        for symbol in [
            "bm_get_info",
            "bm_probe_metadata",
            "bm_live_ts_v1",
            "bm_live_l1_v1",
            "bm_stretch_process_v1",
        ] {
            if !symbols
                .lines()
                .any(|l| l.split_whitespace().last() == Some(symbol) && !l.contains(" UND "))
            {
                return Err("Final APK companion export missing".into());
            }
        }
    }
    Ok(facts)
}
fn inspect(tc: &Path, path: &Path, abi: Abi) -> Result<Value> {
    let result = command(tc, "llvm-readelf")
        .args(["-W", "-h", "-l", "-d"])
        .arg(path)
        .output()?;
    if !result.status.success() {
        return Err("NDK ELF inspection failed".into());
    }
    elf_facts(&String::from_utf8(result.stdout)?, abi)
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
    let object = stage.path().join("stretch.o");
    let target = format!("--target={}24", o.abi.triple);
    let mut cpp = command(tc, "clang++");
    cpp.arg(&target)
        .args([
            "-std=c++17",
            "-O2",
            "-fPIC",
            "-fvisibility=hidden",
            "-Wall",
            "-Wextra",
            "-Werror",
            "-c",
        ])
        .arg(root.join("media-libav/stretch.cpp"))
        .arg("-o")
        .arg(&object);
    execute(cpp, &stage.path().join("cpp.log"), 120)?;
    let mut cc = command(tc, "clang");
    cc.arg(target)
        .args([
            "-std=c11",
            "-O2",
            "-fPIC",
            "-fvisibility=hidden",
            "-Wall",
            "-Wextra",
            "-Werror",
            "-shared",
        ])
        .arg("-I")
        .arg(prefix.join("include"))
        .arg("-I")
        .arg(stage.path())
        .arg(root.join("media-libav/probe.c"))
        .arg(&object)
        .arg("-L")
        .arg(prefix.join("lib"))
        .args([
            "-lavformat",
            "-lavcodec",
            "-lavutil",
            "-lswresample",
            "-lc++_shared",
            "-lm",
            "-Wl,-z,defs",
            "-Wl,-z,max-page-size=16384",
            "-Wl,-z,common-page-size=16384",
            "-Wl,-soname,libbilikara_media_libav.so",
            "-o",
        ])
        .arg(libraries.join("libbilikara_media_libav.so"));
    execute(cc, &stage.path().join("cc.log"), 120)?;
    for name in &LIBRARIES[..4] {
        files::copy(
            &paths::safe_file(prefix, &prefix.join("lib").join(name))?,
            &libraries.join(name),
        )?;
    }
    files::copy(
        &tc.join("sysroot/usr/lib")
            .join(o.abi.triple)
            .join("libc++_shared.so"),
        &libraries.join("libc++_shared.so"),
    )?;
    let mut facts = BTreeMap::new();
    for name in LIBRARIES {
        let path = libraries.join(name);
        let mut strip = command(tc, "llvm-strip");
        strip.arg("--strip-unneeded").arg(&path);
        execute(strip, &stage.path().join("strip.log"), 30)?;
        facts.insert(*name, inspect(tc, &path, o.abi)?);
    }
    let exports = command(tc, "llvm-readelf")
        .args(["--dyn-syms", "-W"])
        .arg(libraries.join("libbilikara_media_libav.so"))
        .output()?;
    let exports = String::from_utf8(exports.stdout)?;
    for name in [
        "bm_get_info",
        "bm_probe_metadata",
        "bm_live_ts_v1",
        "bm_live_l1_v1",
        "bm_stretch_process_v1",
    ] {
        if !exports
            .lines()
            .any(|l| l.split_whitespace().last() == Some(name) && !l.contains(" UND "))
        {
            return Err("Android companion export is missing".into());
        }
    }
    files::tree(
        &prefix.join("licenses"),
        &assets.join("licenses/libav"),
        false,
    )?;
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
        (
            root.join("THIRD_PARTY_NOTICES.md"),
            "THIRD_PARTY_NOTICES.md",
        ),
    ] {
        files::copy(&source, &assets.join("licenses").join(name))?;
    }
    source_kit(root, prefix, &assets.join("source-kit.zip"))?;
    files::write_json(
        &assets.join("build-info.json"),
        &json!({"schema_version":1,"abi":o.abi.name,"ndk":NDK,"ffmpeg":VERSION,"c_cache_key":key,"libraries":facts}),
    )?;
    files::write_json(
        &payload.join("build-info.json"),
        &json!({"schema_version":1,"kind":"android-libav","abi":o.abi.name,"ndk":NDK,"ffmpeg":VERSION,"c_cache_key":key,"libraries":facts,"files":output_inventory(&payload)?}),
    )?;
    validate_output(&payload)?;
    // Replace only our previously validated output. Preserve it on every failed
    // compiler, dependency, source-kit or final rename check.
    if o.out.exists() {
        validate_output(&o.out)?;
        fs::rename(&o.out, stage.path().join("previous"))?;
    }
    if let Err(error) = fs::rename(&payload, &o.out) {
        if stage.path().join("previous").exists()
            && fs::rename(stage.path().join("previous"), &o.out).is_err()
        {
            let recovery = stage.keep();
            return Err(format!(
                "Android publication failed; previous output retained at {}",
                recovery.join("previous").display()
            )
            .into());
        }
        return Err(error.into());
    }
    println!("Android media complete: {}", o.out.display());
    Ok(())
}
pub fn run(args: Vec<OsString>) -> Result<()> {
    let mut o = options(args)?;
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .canonicalize()?;
    o.ndk = paths::absolute(&o.ndk)?;
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
    let tc = toolchain(&o.ndk)?;
    if o.verify {
        let info = validate_output(&o.out)?;
        if info["abi"] != o.abi.name {
            return Err("Android output ABI mismatch".into());
        }
        for name in LIBRARIES {
            inspect(
                &tc,
                &o.out.join("jniLibs").join(o.abi.name).join(name),
                o.abi,
            )?;
        }
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
    fn cache_identity_is_target_profile_and_compiler_scoped() {
        let arm = abi("arm64-v8a").unwrap();
        let key = cache_key(arm, b"NDK compiler").unwrap();
        assert_ne!(
            key,
            cache_key(abi("x86_64").unwrap(), b"NDK compiler").unwrap()
        );
        assert_ne!(key, cache_key(arm, b"other NDK compiler").unwrap());
        assert!(abi("armeabi-v7a").is_err());
        assert!(!key.contains("bilikara_runtime"));
    }
    #[test]
    fn elf_requires_machine_page_alignment_and_declared_closure() {
        let arm = abi("arm64-v8a").unwrap();
        let text = "Machine: AArch64\nLOAD 0 0 0 0 0 R E 0x4000\nLOAD 0 0 0 0 0 RW 0x4000\n0 (NEEDED) Shared library: [libavcodec.so]\n";
        assert!(elf_facts(text, arm).is_ok());
        assert!(elf_facts(&text.replace("0x4000", "0x1000"), arm).is_err());
        assert!(elf_facts(&text.replace("libavcodec.so", "liboutside.so"), arm).is_err());
        assert!(elf_facts(text, abi("x86_64").unwrap()).is_err());
    }
    #[test]
    fn output_rejects_changes_extra_files_links_and_unrelated_data() {
        let temp = tempfile::tempdir().unwrap();
        let out = temp.path();
        fs::create_dir(out.join("jniLibs")).unwrap();
        fs::write(out.join("jniLibs/a.so"), b"original").unwrap();
        files::write_json(&out.join("build-info.json"),&json!({"schema_version":1,"kind":"android-libav","files":output_inventory(out).unwrap()})).unwrap();
        assert!(validate_output(out).is_ok());
        fs::write(out.join("user-data"), b"preserve").unwrap();
        assert!(validate_output(out).is_err());
        fs::remove_file(out.join("user-data")).unwrap();
        fs::write(out.join("jniLibs/a.so"), b"changed").unwrap();
        assert!(validate_output(out).is_err());
        fs::write(out.join("jniLibs/a.so"), b"original").unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("a.so", out.join("jniLibs/linked.so")).unwrap();
            assert!(validate_output(out).is_err());
        }
    }
}
