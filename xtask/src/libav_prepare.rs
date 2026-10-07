//! Native libav prerequisites; C recipes remain shell/make/MSVC owned.
use crate::{
    Result,
    config::{Config, Environment, Os, Platform},
    files, libav, libav_cache,
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::{OsStr, OsString},
    fs,
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
};

pub const VERSION: &str = "9.0.1";
pub const SOURCE_URL: &str = "https://ffmpeg.org/releases/ffmpeg-9.0.1.tar.xz";
pub const SIGNER: &str = "FCF986EA15E6E293A5644F10B4322F04D67658D8";

pub fn run(action: &str, args: Vec<OsString>) -> Result<()> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let platform = Platform::current()?;
    let env = Environment::current();
    if action == "libav-cache" {
        return libav_cache::run(root, platform, &env, &args);
    }
    if !matches!(action, "libav-companion" | "libav-finish" | "libav-collect") {
        return Err("Unknown libav prerequisite command".into());
    }
    let mut prefix = None;
    let mut out = None;
    let mut redist = None;
    let mut system = None;
    let mut tests = false;
    let mut sanitize = false;
    let mut target = None;
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        match arg.to_str() {
            Some("--prefix") => {
                prefix = Some(PathBuf::from(
                    args.next().ok_or("--prefix requires a path")?,
                ))
            }
            Some("--out") if action == "libav-companion" => {
                out = Some(PathBuf::from(args.next().ok_or("--out requires a path")?))
            }
            Some("--redist") => {
                redist = Some(PathBuf::from(
                    args.next().ok_or("--redist requires a path")?,
                ))
            }
            Some("--system") => {
                system = Some(PathBuf::from(
                    args.next().ok_or("--system requires a path")?,
                ))
            }
            Some("--target") => target = Some(args.next().ok_or("--target requires a triple")?),
            Some("--test") if action == "libav-companion" => tests = true,
            Some("--sanitize") if action == "libav-companion" => sanitize = true,
            _ => {
                return Err(
                    format!("Unsupported libav argument: {}", arg.to_string_lossy()).into(),
                );
            }
        }
    }
    let mut config = Config::new(root, platform, env, target)?;
    config.development = false;
    require_target(platform, &config.env)?;
    let prefix = prefix.ok_or("--prefix is required")?;
    check_prefix(root, &prefix)?;
    match action {
        "libav-companion" => companion(
            &config,
            &prefix,
            &out.ok_or("--out is required")?,
            tests,
            sanitize,
        ),
        "libav-finish" => finish(&config, &prefix, redist.as_deref(), system.as_deref()),
        "libav-collect" => collect(
            &prefix,
            platform,
            &config.env,
            redist.as_deref(),
            system.as_deref(),
        ),
        _ => unreachable!(),
    }
}

pub fn require_target(platform: Platform, env: &Environment) -> Result<()> {
    let target = env.text("BILIKARA_LIBAV_TARGET");
    if !target.is_empty() && target != platform.target() {
        return Err("Libav target does not match the executing native runner".into());
    }
    if platform.os == Os::Windows {
        let expected = if platform.arm { "arm64" } else { "x64" };
        if env.text("VSCMD_ARG_TGT_ARCH") != expected {
            return Err("Expected matching native x64/ARM64 MSVC environment".into());
        }
    }
    Ok(())
}

pub fn absolute(path: &Path) -> Result<PathBuf> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
    {
        return Err("Libav requires absolute paths without traversal".into());
    }
    let mut ancestor = path;
    let mut missing = Vec::new();
    while !ancestor.exists() {
        if ancestor.is_symlink() {
            return Err("Libav path contains a dangling link".into());
        }
        missing.push(ancestor.file_name().ok_or("Invalid libav path")?.to_owned());
        ancestor = ancestor.parent().ok_or("Invalid libav path")?;
    }
    if ancestor.is_symlink() {
        return Err("Libav output must not be a link".into());
    }
    let mut result = ancestor.canonicalize()?;
    for part in missing.into_iter().rev() {
        result.push(part);
    }
    Ok(result)
}

pub fn disjoint(left: &Path, right: &Path) -> Result<()> {
    let left = absolute(left)?;
    let right = absolute(right)?;
    if left.starts_with(&right) || right.starts_with(&left) {
        return Err("Libav source/cache/output paths overlap".into());
    }
    Ok(())
}

pub fn check_prefix(root: &Path, prefix: &Path) -> Result<()> {
    let prefix = absolute(prefix)?;
    let root = root.canonicalize()?;
    if root.starts_with(&prefix)
        || prefix.starts_with(root.join("media-libav"))
        || prefix.starts_with(root.join("xtask"))
    {
        return Err("Libav output overlaps checkout/source/tooling".into());
    }
    if prefix.is_dir() {
        for entry in fs::read_dir(&prefix)? {
            let entry = entry?;
            if !matches!(
                entry.file_name().to_str(),
                Some(
                    "bin"
                        | "lib"
                        | "include"
                        | "share"
                        | "source"
                        | "licenses"
                        | "records"
                        | "driver"
                        | "build-info.json"
                )
            ) {
                return Err("Refusing libav output containing unrelated files or user data".into());
            }
            if entry.path().is_symlink() {
                return Err("Linked libav output directory".into());
            }
        }
    } else if prefix.exists() {
        return Err("Libav prefix is not a directory".into());
    }
    Ok(())
}

pub fn safe_file(root: &Path, path: &Path) -> Result<PathBuf> {
    let root = root.canonicalize()?;
    let path = path.canonicalize()?;
    if !path.starts_with(&root) || !path.is_file() {
        return Err("Libav file escapes selected prefix or is missing".into());
    }
    Ok(path)
}

pub fn atomic_json(path: &Path, data: &Value) -> Result<()> {
    atomic_bytes(
        path,
        format!("{}\n", serde_json::to_string_pretty(data)?).as_bytes(),
    )
}
pub fn atomic_bytes(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    if path.is_symlink() {
        return Err("Refusing linked libav generated output".into());
    }
    let parent = path.parent().ok_or("Missing libav output parent")?;
    fs::create_dir_all(parent)?;
    // Generated headers/manifests keep ordinary create-file permissions under
    // the caller's umask, matching the accepted producer rather than tempfile's
    // private 0600 default.
    let mut temp =
        tempfile::Builder::new()
            .prefix(".libav-output-")
            .make_in(parent, |temporary| {
                fs::OpenOptions::new()
                    .read(true)
                    .write(true)
                    .create_new(true)
                    .open(temporary)
            })?;
    temp.write_all(bytes)?;
    temp.as_file().sync_all()?;
    temp.persist(path)?;
    Ok(())
}

fn selected_library(prefix: &Path, platform: Platform, name: &str) -> Result<PathBuf> {
    let dir = prefix.join(if platform.os == Os::Windows {
        "bin"
    } else {
        "lib"
    });
    let mut candidates = BTreeSet::new();
    for entry in fs::read_dir(&dir)? {
        let entry = entry?;
        let filename = entry.file_name();
        let filename = filename.to_str().ok_or("Invalid library filename")?;
        let matches = match platform.os {
            Os::Windows => filename.starts_with(&format!("{name}-")) && filename.ends_with(".dll"),
            Os::Macos => {
                filename.starts_with(&format!("lib{name}.")) && filename.ends_with(".dylib")
            }
            Os::Linux => filename.starts_with(&format!("lib{name}.so.")),
        };
        if matches {
            candidates.insert(safe_file(&dir, &entry.path())?);
        }
    }
    if candidates.len() != 1 {
        return Err(format!("Expected one selected {name} library").into());
    }
    Ok(candidates.pop_first().unwrap())
}

pub fn library_facts(prefix: &Path, platform: Platform) -> Result<Value> {
    // Validate all private imports before dlopen. A missing same-prefix library
    // must never resolve to an unrelated system FFmpeg through loader search.
    let mut selected = BTreeMap::new();
    for name in ["avutil", "swresample", "avcodec", "avformat"] {
        selected.insert(name, selected_library(prefix, platform, name)?);
    }
    let directory = prefix.join(if platform.os == Os::Windows {
        "bin"
    } else {
        "lib"
    });
    for path in selected.values() {
        for dependency in libav::binary_imports(path, platform)? {
            let filename = Path::new(&dependency)
                .file_name()
                .ok_or("Invalid libav import")?;
            if private_import(&dependency, platform) {
                safe_file(&directory, &directory.join(filename))?;
            } else if platform.os != Os::Windows && !system_import(&dependency, platform) {
                return Err(format!("Unresolved private libav dependency: {dependency}").into());
            } else if platform.os == Os::Windows && foreign_windows(&dependency) {
                return Err("Non-MSVC runtime import".into());
            }
        }
    }
    let mut libraries = Vec::new();
    let mut versions = Vec::new();
    let mut version = None;
    let mut configuration = None;
    for name in ["avutil", "swresample", "avcodec", "avformat"] {
        // The selected verified native libraries are trusted executable code.
        // Keep every handle alive through symbol calls; Windows searches only
        // the explicit DLL directory and OS default directories.
        let library = unsafe {
            #[cfg(windows)]
            {
                libloading::Library::from(libloading::os::windows::Library::load_with_flags(
                    &selected[name],
                    0x100 | 0x1000,
                )?)
            }
            #[cfg(unix)]
            {
                libloading::Library::from(libloading::os::unix::Library::open(
                    Some(&selected[name]),
                    libc::RTLD_NOW | libc::RTLD_LOCAL,
                )?)
            }
        };
        unsafe {
            if name != "swresample" {
                let symbol: libloading::Symbol<unsafe extern "C" fn() -> u32> =
                    library.get(format!("{name}_version\0").as_bytes())?;
                versions.push(json!({"name":format!("lib{name}"), "version":symbol()}));
            }
            if name == "avutil" {
                let symbol: libloading::Symbol<unsafe extern "C" fn() -> *const std::ffi::c_char> =
                    library.get(b"av_version_info\0")?;
                version = Some(bounded_string(symbol(), 128)?);
            }
            if name == "avformat" {
                let symbol: libloading::Symbol<unsafe extern "C" fn() -> *const std::ffi::c_char> =
                    library.get(b"avformat_configuration\0")?;
                configuration = Some(bounded_string(symbol(), 2048)?);
            }
        }
        libraries.push(library);
    }
    let facts = json!({"program_version":{"version":version, "configuration":configuration}, "library_versions":versions});
    validate_facts(&facts)?;
    Ok(facts)
}

unsafe fn bounded_string(pointer: *const std::ffi::c_char, bound: usize) -> Result<String> {
    if pointer.is_null() {
        return Err("Libav returned a null build fact".into());
    }
    let mut bytes = Vec::new();
    for index in 0..=bound {
        // ABI functions return NUL-terminated static strings. Do not let an
        // unexpected configuration grow beyond the existing companion bound.
        let byte = unsafe { *pointer.add(index) } as u8;
        if byte == 0 {
            return Ok(String::from_utf8(bytes)?);
        }
        bytes.push(byte);
    }
    Err("configuration exceeds ABI bound".into())
}

pub fn validate_facts(facts: &Value) -> Result<()> {
    let versions = facts["library_versions"]
        .as_array()
        .ok_or("Malformed libav library facts")?;
    for (name, expected) in [
        ("libavutil", 3998053),
        ("libavcodec", 4129125),
        ("libavformat", 4129125),
    ] {
        if !versions
            .iter()
            .any(|item| item["name"] == name && item["version"] == expected)
        {
            return Err("this companion requires the selected FFmpeg 9.0.1 build".into());
        }
    }
    if facts["program_version"]["version"] != VERSION {
        return Err("this companion requires the selected FFmpeg 9.0.1 build".into());
    }
    let config = facts["program_version"]["configuration"]
        .as_str()
        .ok_or("Missing library configuration")?;
    if config.len() > 2048 {
        return Err("configuration exceeds ABI bound".into());
    }
    if !["--disable-network", "--enable-shared"]
        .iter()
        .all(|flag| config.split_whitespace().any(|part| part == *flag))
    {
        return Err("selected build must disable network and enable shared libraries".into());
    }
    Ok(())
}

fn ascii_json_string(value: &str) -> Result<String> {
    let serialized = serde_json::to_string(value)?;
    Ok(serialized
        .chars()
        .map(|ch| {
            if ch.is_ascii() {
                ch.to_string()
            } else {
                let mut units = [0; 2];
                ch.encode_utf16(&mut units)
                    .iter()
                    .map(|unit| format!("\\u{unit:04x}"))
                    .collect()
            }
        })
        .collect())
}

pub fn companion_commands(
    config: &Config,
    prefix: &Path,
    out: &Path,
    tests: bool,
    sanitize: bool,
) -> Result<Vec<Vec<OsString>>> {
    let platform = config.platform;
    if sanitize && platform.os == Os::Windows {
        return Err("Windows companion build does not enable sanitizers".into());
    }
    let source = config.root.join("media-libav");
    let output = out.join(platform.companion());
    let arg = |base: &str, path: &Path| {
        let mut value = OsString::from(base);
        value.push(path);
        value
    };
    // Commands run in the validated owned output directory. MSVC's include
    // search does not accept Rust's canonical \\?\ path syntax; keep generated
    // headers, objects and link outputs relative to that cwd instead of
    // stripping filesystem/security prefixes from canonical paths.
    let link_output = |path: &Path| {
        arg(
            "/OUT:",
            if platform.os == Os::Windows {
                Path::new(path.file_name().unwrap())
            } else {
                path
            },
        )
    };
    let mut command: Vec<OsString> = if platform.os == Os::Windows {
        vec![
            "cl.exe".into(),
            "/nologo".into(),
            "/std:c11".into(),
            "/O2".into(),
            "/MD".into(),
            "/W3".into(),
            "/we4013".into(),
            "/D_CRT_SECURE_NO_WARNINGS".into(),
            "/D_CRT_NONSTDC_NO_WARNINGS".into(),
            "/LD".into(),
            arg("/I", &prefix.join("include")),
            "/I.".into(),
            source.join("probe.c").into(),
            "/Fo.\\".into(),
            "/link".into(),
            if platform.arm {
                "/MACHINE:ARM64"
            } else {
                "/MACHINE:X64"
            }
            .into(),
            arg("/LIBPATH:", &prefix.join("bin")),
            arg("/LIBPATH:", &prefix.join("lib")),
            "avformat.lib".into(),
            "avcodec.lib".into(),
            "avutil.lib".into(),
            "kernel32.lib".into(),
            link_output(&output),
        ]
    } else {
        let mut result: Vec<OsString> = vec![
            config
                .env
                .get("CC")
                .filter(|value| !value.is_empty())
                .unwrap_or(OsStr::new("cc"))
                .to_owned(),
            "-std=c11".into(),
            "-O2".into(),
            "-g".into(),
            "-Wall".into(),
            "-Wextra".into(),
            "-Werror".into(),
            "-fPIC".into(),
            "-fvisibility=hidden".into(),
            if platform.os == Os::Macos {
                "-dynamiclib"
            } else {
                "-shared"
            }
            .into(),
            arg("-I", &prefix.join("include")),
            arg("-I", out),
            source.join("probe.c").into(),
            arg("-L", &prefix.join("lib")),
        ];
        if platform.os == Os::Linux {
            result.extend([
                arg("-Wl,--disable-new-dtags,-rpath,", &prefix.join("lib")),
                "-Wl,-z,defs".into(),
            ]);
        }
        result.extend([
            "-lavformat".into(),
            "-lavcodec".into(),
            "-lavutil".into(),
            "-o".into(),
            output.clone().into(),
        ]);
        if platform.os == Os::Macos {
            result.extend([
                arg("-Wl,-rpath,", &prefix.join("lib")),
                "-Wl,-headerpad_max_install_names".into(),
            ]);
        }
        result
    };
    if sanitize {
        command.extend([
            "-fsanitize=address,undefined".into(),
            "-fno-omit-frame-pointer".into(),
        ]);
    }
    let mut commands = vec![command.clone()];
    if tests {
        let shim = out.join(platform.executable("test_shim"));
        let mut test = command.clone();
        test.retain(|arg| {
            !["/LD", "-shared", "-dynamiclib"]
                .iter()
                .any(|flag| arg == flag)
        });
        for item in &mut test {
            if item == source.join("probe.c").as_os_str() {
                *item = source.join("test_shim.c").into();
            }
            if item == output.as_os_str() {
                *item = shim.clone().into();
            }
            if item == &link_output(&output) {
                *item = link_output(&shim);
            }
        }
        commands.push(test);
        commands.push(vec![shim.into()]);
        for item in &mut command {
            if item == source.join("probe.c").as_os_str() {
                *item = source.join("test_shim.c").into();
            }
            if item == output.as_os_str() {
                *item = out.join(test_companion(platform)).into();
            }
            if item == &link_output(&output) {
                *item = link_output(&out.join(test_companion(platform)));
            }
        }
        commands.push(command);
    }
    Ok(commands)
}

pub fn companion(
    config: &Config,
    prefix: &Path,
    out: &Path,
    tests: bool,
    sanitize: bool,
) -> Result<()> {
    let out = companion_output(config, prefix, out)?;
    let commands = companion_commands(config, prefix, &out, tests, sanitize)?;
    let facts = library_facts(prefix, config.platform)?;
    safe_file(prefix, &prefix.join("include/libavformat/avformat.h"))?;
    fs::create_dir_all(&out)?;
    // Never leave an old completion record alongside a failed new compiler run.
    let info = out.join("build-info.json");
    if info.exists() {
        if info.is_symlink() {
            return Err("Linked companion completion metadata".into());
        }
        fs::remove_file(&info)?;
    }
    let configuration = facts["program_version"]["configuration"].as_str().unwrap();
    atomic_bytes(
        &out.join("build_config.h"),
        format!(
            "#define BM_BUILD_CONFIG {}\n",
            ascii_json_string(configuration)?
        )
        .as_bytes(),
    )?;
    run_companion_commands(&out, &commands)?;
    libav::binary_imports(&out.join(config.platform.companion()), config.platform)?;
    atomic_json(&info, &facts)?;
    println!("{}", out.join(config.platform.companion()).display());
    Ok(())
}

pub(crate) fn run_companion_commands(out: &Path, commands: &[Vec<OsString>]) -> Result<()> {
    for command in commands {
        if !Command::new(&command[0])
            .args(&command[1..])
            .current_dir(out)
            .status()?
            .success()
        {
            return Err("Libav companion compiler/test failed".into());
        }
    }
    Ok(())
}

pub(crate) fn companion_output(config: &Config, prefix: &Path, out: &Path) -> Result<PathBuf> {
    let out = absolute(out)?;
    let prefix = prefix.canonicalize()?;
    let checkout = config.root.canonicalize()?;
    if prefix.starts_with(&out)
        || checkout.starts_with(&out)
        || out.starts_with(checkout.join("media-libav"))
        || out.starts_with(checkout.join("xtask"))
        || (out.starts_with(&prefix) && out != prefix.join("bin"))
    {
        return Err("Companion output overlaps source/prefix".into());
    }
    if out != prefix.join("bin") && out.is_dir() {
        for entry in fs::read_dir(&out)? {
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_str().ok_or("Invalid companion output name")?;
            if entry.path().is_symlink()
                || !entry.path().is_file()
                || !(name == "build-info.json"
                    || name == "build_config.h"
                    || name == config.platform.companion()
                    || name == test_companion(config.platform)
                    || name.starts_with("test_shim.")
                    || name == "test_shim"
                    || name.starts_with("probe.")
                    || name.starts_with("bilikara_media_libav.")
                    || name.starts_with("bilikara_media_libav_test."))
            {
                return Err(
                    "Refusing companion output containing unrelated files or user data".into(),
                );
            }
        }
    }
    Ok(out)
}

pub fn test_companion(platform: Platform) -> String {
    if platform.os == Os::Windows {
        "bilikara_media_libav_test.dll".into()
    } else {
        platform.companion().replace("libav.", "libav_test.")
    }
}
fn private_import(name: &str, platform: Platform) -> bool {
    let name = Path::new(name)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_ascii_lowercase();
    if platform.os == Os::Windows {
        [
            "avcodec-",
            "avformat-",
            "avutil-",
            "avfilter-",
            "swresample-",
            "swscale-",
        ]
        .iter()
        .any(|prefix| name.starts_with(prefix))
    } else {
        name.starts_with("libav") || name.starts_with("libsw")
    }
}
pub fn system_import(name: &str, platform: Platform) -> bool {
    if platform.os == Os::Macos {
        return name.starts_with("/usr/lib/") || name.starts_with("/System/Library/");
    }
    matches!(
        name,
        "libc.so.6"
            | "libm.so.6"
            | "libpthread.so.0"
            | "libdl.so.2"
            | "librt.so.1"
            | "libresolv.so.2"
            | "libgcc_s.so.1"
            | "ld-linux-x86-64.so.2"
            | "ld-linux-aarch64.so.1"
    )
}
fn foreign_windows(name: &str) -> bool {
    ["msys-", "cygwin", "libgcc", "libstdc++", "libwinpthread"]
        .iter()
        .any(|prefix| name.starts_with(prefix))
}

fn info(path: &Path, platform: Platform) -> Result<Value> {
    let mut imports = libav::binary_imports(path, platform)?;
    if platform.os == Os::Windows {
        imports.sort();
        imports.dedup();
    }
    Ok(
        json!({"machine":if platform.os == Os::Macos && !platform.arm {"x86_64"} else {platform.arch()},"imports":imports}),
    )
}

fn closure(facts: &BTreeMap<String, Value>, root: &str, platform: Platform) -> Result<Vec<String>> {
    let mut seen = BTreeSet::new();
    let mut pending = vec![root.to_owned()];
    while let Some(name) = pending.pop() {
        if !seen.insert(name.clone()) {
            continue;
        }
        let imports = facts.get(&name).ok_or("Missing libav closure node")?["imports"]
            .as_array()
            .ok_or("Invalid imports")?;
        for dependency in imports {
            let dependency = dependency.as_str().ok_or("Invalid dependency")?;
            let name = Path::new(dependency)
                .file_name()
                .ok_or("Invalid dependency name")?
                .to_string_lossy()
                .to_string();
            if facts.contains_key(&name) {
                pending.push(name);
            } else if platform.os != Os::Windows && !system_import(dependency, platform) {
                return Err("Unresolved runtime closure".into());
            }
        }
    }
    Ok(seen.into_iter().collect())
}

pub fn collect(
    prefix: &Path,
    platform: Platform,
    env: &Environment,
    redist: Option<&Path>,
    system: Option<&Path>,
) -> Result<()> {
    let bin = prefix.join("bin");
    let manifest = bin.join("ffmpeg-runtime.json");
    if manifest.is_symlink() {
        return Err("Linked libav manifest".into());
    }
    if manifest.exists() {
        fs::remove_file(&manifest)?;
    }
    if platform.os == Os::Windows {
        return collect_windows(
            prefix,
            platform,
            env,
            redist.ok_or("--redist is required")?,
            system.ok_or("--system is required")?,
        );
    }
    let mut facts = BTreeMap::new();
    let mut pending = vec![platform.companion().to_owned(), test_companion(platform)];
    while let Some(name) = pending.pop() {
        if facts.contains_key(&name) {
            continue;
        }
        let path = safe_file(&bin, &bin.join(&name))?;
        let fact = info(&path, platform)?;
        for dep in fact["imports"].as_array().unwrap() {
            let dep = dep.as_str().unwrap();
            if system_import(dep, platform) {
                continue;
            }
            let filename = Path::new(dep)
                .file_name()
                .ok_or("Invalid native dependency")?;
            if !private_import(dep, platform) {
                return Err(format!("Unresolved private libav dependency: {dep}").into());
            }
            let source = safe_file(&prefix.join("lib"), &prefix.join("lib").join(filename))?;
            let destination = bin.join(filename);
            if destination.exists() {
                safe_file(&bin, &destination)?;
            }
            // Refresh the selected C build even when a previous preparation
            // left relocated libraries with the same sonames in bin/.
            files::copy(&source, &destination)?;
            pending.push(
                filename
                    .to_str()
                    .ok_or("Invalid dependency filename")?
                    .to_owned(),
            );
        }
        facts.insert(name, fact);
    }
    for (name, fact) in &mut facts {
        let path = bin.join(name);
        for command in relocation_commands(&path, name, fact, platform)? {
            checked(Command::new(&command[0]).args(&command[1..]))?;
        }
        *fact = info(&path, platform)?;
    }
    for fact in facts.values() {
        for dep in fact["imports"].as_array().unwrap() {
            let dep = dep.as_str().unwrap();
            let filename = Path::new(dep).file_name().unwrap().to_string_lossy();
            if !system_import(dep, platform)
                && (!facts.contains_key(filename.as_ref())
                    || (platform.os == Os::Macos && dep != format!("@loader_path/{filename}")))
            {
                return Err("Private libav closure is not relocatable".into());
            }
        }
    }
    let runtime = closure(&facts, platform.companion(), platform)?;
    let mut drivers = BTreeMap::new();
    for entry in fs::read_dir(prefix.join("driver"))? {
        let entry = entry?;
        if !entry.path().is_file() {
            continue;
        }
        let fact = info(&safe_file(&prefix.join("driver"), &entry.path())?, platform)?;
        if fact["imports"]
            .as_array()
            .unwrap()
            .iter()
            .any(|dep| !system_import(dep.as_str().unwrap(), platform))
        {
            return Err("Developer driver acquired a non-system import".into());
        }
        drivers.insert(
            entry
                .file_name()
                .to_str()
                .ok_or("Invalid driver filename")?
                .to_owned(),
            fact,
        );
    }
    atomic_json(
        &manifest,
        &json!({"schema_version":1,"kind":"libav","version":VERSION,"target":platform.target(),"runtime_files":runtime,"binaries":facts,"drivers":drivers,"build_run":env.get("GITHUB_RUN_ID").unwrap_or(OsStr::new("local")).to_str().ok_or("Invalid build run")?,"build_attempt":env.get("GITHUB_RUN_ATTEMPT").unwrap_or(OsStr::new("1")).to_str().ok_or("Invalid build attempt")?}),
    )
}

pub(crate) fn relocation_commands(
    path: &Path,
    name: &str,
    fact: &Value,
    platform: Platform,
) -> Result<Vec<Vec<OsString>>> {
    let mut commands = Vec::new();
    if platform.os == Os::Macos {
        for dep in fact["imports"].as_array().ok_or("Invalid native imports")? {
            let dep = dep.as_str().ok_or("Invalid native import")?;
            if !system_import(dep, platform) {
                let filename = Path::new(dep)
                    .file_name()
                    .ok_or("Invalid native dependency")?
                    .to_str()
                    .ok_or("Invalid dependency filename")?;
                commands.push(vec![
                    "install_name_tool".into(),
                    "-change".into(),
                    dep.into(),
                    format!("@loader_path/{filename}").into(),
                    path.into(),
                ]);
            }
        }
        if name.ends_with(".dylib") {
            commands.push(vec![
                "install_name_tool".into(),
                "-id".into(),
                format!("@loader_path/{name}").into(),
                path.into(),
            ]);
        }
        commands.push(vec![
            "codesign".into(),
            "--force".into(),
            "--sign".into(),
            "-".into(),
            path.into(),
        ]);
    } else if platform.os == Os::Linux {
        commands.push(vec![
            "patchelf".into(),
            "--set-rpath".into(),
            "$ORIGIN".into(),
            path.into(),
        ]);
    } else {
        return Err("PE collection does not use POSIX relocation".into());
    }
    Ok(commands)
}

fn dlls(directory: &Path) -> Result<BTreeMap<String, PathBuf>> {
    let mut result = BTreeMap::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        if entry
            .path()
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("dll"))
        {
            let name = entry
                .file_name()
                .to_str()
                .ok_or("Invalid DLL filename")?
                .to_ascii_lowercase();
            if result
                .insert(name, safe_file(directory, &entry.path())?)
                .is_some()
            {
                return Err("Ambiguous DLL casing".into());
            }
        }
    }
    Ok(result)
}
fn collect_windows(
    prefix: &Path,
    platform: Platform,
    env: &Environment,
    redist: &Path,
    system: &Path,
) -> Result<()> {
    disjoint(prefix, redist)?;
    disjoint(prefix, system)?;
    let bin = prefix.join("bin");
    let local = dlls(&bin)?;
    let runtime = dlls(redist)?;
    let roots = [platform.companion().to_owned(), test_companion(platform)];
    let mut pending: Vec<PathBuf> = roots.iter().map(|name| bin.join(name)).collect();
    let mut drivers = BTreeMap::new();
    for entry in fs::read_dir(prefix.join("driver"))? {
        let entry = entry?;
        if entry
            .path()
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
        {
            let path = safe_file(&prefix.join("driver"), &entry.path())?;
            drivers.insert(
                entry
                    .file_name()
                    .to_str()
                    .ok_or("Invalid driver name")?
                    .to_ascii_lowercase(),
                path.clone(),
            );
            pending.push(path);
        }
    }
    let mut facts = BTreeMap::new();
    let mut system_imports = BTreeSet::new();
    let mut copied = BTreeSet::new();
    while let Some(path) = pending.pop() {
        let name = path
            .file_name()
            .unwrap()
            .to_str()
            .ok_or("Invalid PE filename")?
            .to_ascii_lowercase();
        if facts.contains_key(&name) {
            continue;
        }
        let fact = info(&path, platform)?;
        for dep in fact["imports"].as_array().unwrap() {
            let dep = dep.as_str().unwrap();
            if foreign_windows(dep) {
                return Err(format!("Non-MSVC runtime import: {dep}").into());
            }
            if private_import(dep, platform) {
                pending.push(
                    local
                        .get(dep)
                        .ok_or_else(|| format!("Missing private libav dependency: {dep}"))?
                        .clone(),
                );
            } else if let Some(source) = runtime.get(dep) {
                let destination = bin.join(dep);
                if destination.exists() {
                    safe_file(&bin, &destination)?;
                }
                files::copy(source, &destination)?;
                pending.push(destination);
                copied.insert(dep.to_owned());
            } else if dep.starts_with("api-ms-win-")
                || dep.starts_with("ext-ms-win-")
                || system.join(dep).is_file()
            {
                system_imports.insert(dep.to_owned());
            } else {
                return Err(format!("Unresolved preview PE import: {dep}").into());
            }
        }
        facts.insert(name, fact);
    }
    let runtime_files = closure(&facts, platform.companion(), platform)?;
    for name in roots.iter().chain(facts.keys().filter(|name| {
        ["avformat-", "avcodec-", "avutil-"]
            .iter()
            .any(|prefix| name.starts_with(prefix))
    })) {
        if !facts[name]["imports"]
            .as_array()
            .unwrap()
            .iter()
            .any(|dep| {
                dep == "ucrtbase.dll" || dep.as_str().unwrap().starts_with("api-ms-win-crt-")
            })
        {
            return Err(format!("Expected shared UCRT imports: {name}").into());
        }
    }
    let driver_facts: BTreeMap<_, _> = drivers
        .keys()
        .map(|name| (name.clone(), facts.remove(name).unwrap()))
        .collect();
    atomic_json(
        &bin.join("ffmpeg-runtime.json"),
        &json!({"schema_version":1,"kind":"libav","version":VERSION,"target":platform.target(),"build_run":env.get("GITHUB_RUN_ID").unwrap_or(OsStr::new("local-helper-test")).to_str().ok_or("Invalid build run")?,"build_attempt":env.get("GITHUB_RUN_ATTEMPT").unwrap_or(OsStr::new("1")).to_str().ok_or("Invalid build attempt")?,"runtime_files":runtime_files,"pe":facts,"driver_pe":driver_facts,"system_imports":system_imports,"vc_redist_files":copied}),
    )
}
fn checked(command: &mut Command) -> Result<()> {
    if !command.status()?.success() {
        return Err("Native libav platform tool failed".into());
    }
    Ok(())
}

fn cargo_artifact(config: &Config, test: bool, destination: &Path) -> Result<()> {
    let mut command = Command::new("cargo");
    command
        .current_dir(&config.root)
        .arg(if test { "test" } else { "build" })
        .arg("--manifest-path")
        .arg(config.root.join("rust-runtime/Cargo.toml"))
        .args([
            "--release",
            "--locked",
            "--features",
            "native-host",
            "--message-format=json",
        ]);
    if test {
        command.args(["--lib", "--no-run"]);
    } else {
        command.args(["--example", "libav_metadata"]);
    }
    if let Some(target) = &config.target {
        command.arg("--target").arg(target);
    }
    command.stderr(Stdio::inherit());
    let output = command.output()?;
    let records = destination
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("records");
    fs::create_dir_all(&records)?;
    atomic_bytes(
        &records.join(if test {
            "runtime-test-build.jsonl"
        } else {
            "driver-build.log"
        }),
        &output.stdout,
    )?;
    if !output.status.success() {
        return Err("Developer driver/Runtime test build failed".into());
    }
    let executable = compiler_artifact(
        &output.stdout,
        if test {
            "bilikara_runtime"
        } else {
            "libav_metadata"
        },
        test,
    )?;
    let expected = config.target_output("rust-runtime")?;
    if !artifact_matches_output(
        &executable,
        &expected,
        config.platform,
        config.target.is_none(),
    )? {
        return Err("Cargo artifact is outside the selected target/profile".into());
    }
    libav::binary_imports(&executable, config.platform)?;
    files::copy(&executable, destination)?;
    Ok(())
}
pub fn compiler_artifact(output: &[u8], name: &str, test: bool) -> Result<PathBuf> {
    let mut candidates = Vec::new();
    for line in std::str::from_utf8(output)?
        .lines()
        .filter(|line| !line.trim().is_empty())
    {
        let record: Value = serde_json::from_str(line)?;
        if record["reason"] == "compiler-artifact"
            && record["target"]["name"] == name
            && record["profile"]["test"] == test
            && let Some(path) = record["executable"].as_str()
        {
            candidates.push(PathBuf::from(path));
        }
    }
    if candidates.len() != 1 {
        return Err("Expected one current Cargo compiler-artifact executable".into());
    }
    Ok(candidates.pop().unwrap())
}
pub(crate) fn artifact_matches_output(
    executable: &Path,
    expected: &Path,
    platform: Platform,
    implicit: bool,
) -> Result<bool> {
    let executable = executable.canonicalize()?;
    let mut outputs = vec![expected.to_owned()];
    if implicit {
        // Cargo may select build.target from its configuration. Its current
        // compiler-artifact is accepted only under the matching native triple.
        outputs.push(
            expected
                .parent()
                .ok_or("Missing Cargo output root")?
                .join(platform.target())
                .join(expected.file_name().ok_or("Missing Cargo profile")?),
        );
    }
    for output in outputs {
        if output.is_dir() && executable.starts_with(output.canonicalize()?) {
            return Ok(true);
        }
    }
    Ok(false)
}
fn finish(
    config: &Config,
    prefix: &Path,
    redist: Option<&Path>,
    system: Option<&Path>,
) -> Result<()> {
    libav_cache::invalidate(prefix)?;
    let facts: Value = serde_json::from_slice(&fs::read(prefix.join("bin/build-info.json"))?)?;
    validate_facts(&facts)?;
    if facts != library_facts(prefix, config.platform)? {
        return Err("Companion metadata differs from actual selected libraries".into());
    }
    libav_cache::provenance(prefix)?;
    fs::create_dir_all(prefix.join("driver"))?;
    fs::create_dir_all(prefix.join("records"))?;
    files::copy(
        &prefix.join("bin/build_config.h"),
        &prefix.join("records/companion-build-config.h"),
    )?;
    cargo_artifact(
        config,
        false,
        &prefix
            .join("driver")
            .join(config.platform.executable("libav_metadata")),
    )?;
    cargo_artifact(
        config,
        true,
        &prefix
            .join("driver")
            .join(config.platform.executable("libav-runtime-tests")),
    )?;
    let mut facts = facts;
    facts["target"] = config.platform.target().into();
    facts["source_url"] = SOURCE_URL.into();
    facts["release_signer"] = SIGNER.into();
    if config.platform.os == Os::Windows {
        facts["toolchain"] = "MSVC /MD; MSYS2 shell/make only".into();
        for (field, key) in [
            ("vc_tools_version", "VCToolsVersion"),
            ("windows_sdk", "WindowsSDKVersion"),
        ] {
            let value = config.env.text(key);
            if value.is_empty() {
                return Err("Missing selected MSVC/SDK facts".into());
            }
            facts[field] = value.into();
        }
        let version = Command::new("cl.exe").output()?;
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&version.stdout),
            String::from_utf8_lossy(&version.stderr)
        );
        atomic_bytes(
            &prefix.join("records/msvc-version.txt"),
            text.lines()
                .take(2)
                .collect::<Vec<_>>()
                .join("\n")
                .as_bytes(),
        )?;
        atomic_bytes(
            &prefix.join("records/rust-version.txt"),
            libav::command_output("rustc", &["-vV".as_ref()])?.as_bytes(),
        )?;
    }
    collect(prefix, config.platform, &config.env, redist, system)?;
    atomic_json(&prefix.join("build-info.json"), &facts)?;
    Ok(())
}
