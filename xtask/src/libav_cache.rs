//! Verified upstream-C-only cache. Schema 3 replaces the retired Python key;
//! unrelated xtask/Runtime/companion edits do not change this identity.
use crate::{
    Result,
    config::{Environment, Os, Platform},
    libav_prepare as prepare,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    ffi::{OsStr, OsString},
    fs,
    path::{Component, Path},
    process::Command,
};

const SCHEMA: u64 = 3;
const MANIFEST: &str = "cache-manifest.json";
const ROOTS: &[&str] = &[
    "bin", "lib", "include", "share", "source", "licenses", "records",
];
const ENVIRONMENT: &[&str] = &[
    "ImageOS",
    "VCToolsVersion",
    "WindowsSDKVersion",
    "CC",
    "CXX",
    "CFLAGS",
    "CXXFLAGS",
    "CPPFLAGS",
    "LDFLAGS",
    "SDKROOT",
    "DEVELOPER_DIR",
    "VSCMD_ARG_TGT_ARCH",
    "VSCMD_ARG_HOST_ARCH",
    "MACOSX_DEPLOYMENT_TARGET",
    "BILIKARA_LIBAV_PREFIX",
];

pub fn run(root: &Path, platform: Platform, env: &Environment, args: &[OsString]) -> Result<()> {
    prepare::require_target(platform, env)?;
    match args.first().and_then(|arg| arg.to_str()) {
        Some("key") if args.len() == 1 => { println!("key={}",key(root,platform,env)?); Ok(()) },
        Some("snapshot") if args.len() == 3 => snapshot(root,platform,env,Path::new(&args[1]),Path::new(&args[2])),
        Some("restore") if args.len() == 3 => restore(root,platform,env,Path::new(&args[1]),Path::new(&args[2])),
        Some("check-paths") if (3..=4).contains(&args.len()) => {
            let prefix = Path::new(&args[1]); let work = Path::new(&args[2]);
            prepare::check_prefix(root,prefix)?;
            prepare::disjoint(prefix,work)?;
            let work = prepare::absolute(work)?;
            let checkout = root.canonicalize()?;
            if checkout.starts_with(&work) || work.starts_with(checkout.join("media-libav")) || work.starts_with(checkout.join("xtask")) { return Err("Libav work directory overlaps checkout/source".into()); }
            if let Some(cache) = args.get(3) {
                let cache = Path::new(cache); prepare::disjoint(prefix,cache)?; prepare::disjoint(&work,cache)?;
                cache_location(root,cache)?;
            }
            if let Some(source) = env.get("BILIKARA_LIBAV_SOURCE_DIR").filter(|value| !value.is_empty()) {
                let source = Path::new(source);
                prepare::disjoint(source,prefix)?;
                prepare::disjoint(source,&work)?;
                if let Some(cache) = args.get(3) { prepare::disjoint(source,Path::new(cache))?; }
            }
            if env.text("BILIKARA_LIBAV_CACHE_HIT") != "true" { invalidate(prefix)?; }
            Ok(())
        },
        _ => Err("Expected libav-cache key, snapshot PREFIX CACHE, restore CACHE PREFIX or check-paths PREFIX WORK [CACHE]".into()),
    }
}

pub fn key(root: &Path, platform: Platform, env: &Environment) -> Result<String> {
    let mut compiler = Vec::new();
    let command = if platform.os == Os::Windows {
        OsStr::new("cl.exe")
    } else {
        env.get("CC")
            .filter(|value| !value.is_empty())
            .unwrap_or(OsStr::new("cc"))
    };
    let mut invocation = Command::new(command);
    if platform.os != Os::Windows {
        invocation.arg("--version");
    }
    let result = invocation.output()?;
    // cl with no input reports its version and returns 2. C compilation itself
    // is always checked by the C recipe/companion, never through this probe.
    if platform.os != Os::Windows && !result.status.success() {
        return Err("Selected C compiler version probe failed".into());
    }
    let mut bytes = result.stdout;
    bytes.extend(result.stderr);
    compiler.push(String::from_utf8_lossy(&bytes).replace("\r\n", "\n"));
    if platform.os == Os::Macos {
        let output = crate::libav::command_output("xcrun", &["--show-sdk-version".as_ref()])?;
        compiler.push(output);
    }
    key_with_compiler(root, platform, env, &compiler)
}

pub(crate) fn key_with_compiler(
    root: &Path,
    platform: Platform,
    env: &Environment,
    compiler: &[String],
) -> Result<String> {
    let system = match platform.os {
        Os::Windows => "Windows",
        Os::Macos => "Darwin",
        Os::Linux => "Linux",
    };
    let recipe = if platform.os == Os::Windows {
        "windows"
    } else {
        "posix"
    };
    let name = format!("media-libav/build-{recipe}-libraries.sh");
    let environment: BTreeMap<_, _> = ENVIRONMENT
        .iter()
        .map(|name| {
            Ok((
                *name,
                env.get(name)
                    .unwrap_or(OsStr::new(""))
                    .to_str()
                    .ok_or("Invalid UTF-8 C cache environment")?
                    .to_owned(),
            ))
        })
        .collect::<Result<_>>()?;
    key_from_facts(
        system,
        if platform.arm { "aarch64" } else { "x86_64" },
        &fs::read(root.join(&name))?,
        &environment,
        compiler,
    )
}

pub fn key_from_facts(
    system: &str,
    arch: &str,
    recipe: &[u8],
    environment: &BTreeMap<&str, String>,
    compiler: &[String],
) -> Result<String> {
    let inputs = json!({"schema":SCHEMA,"system":system,"arch":arch,"environment":environment,"recipe":hash(recipe),"compiler":compiler});
    Ok(format!(
        "libav-v{SCHEMA}-{system}-{arch}-{}",
        hash(&serde_json::to_vec(&inputs)?)
    ))
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub(crate) fn cache_location(root: &Path, cache: &Path) -> Result<std::path::PathBuf> {
    let cache = prepare::absolute(cache)?;
    let root = root.canonicalize()?;
    if root.starts_with(&cache)
        || cache.starts_with(root.join("media-libav"))
        || cache.starts_with(root.join("xtask"))
    {
        return Err("Cache overlaps checkout/source/tooling".into());
    }
    Ok(cache)
}

pub fn provenance(prefix: &Path) -> Result<()> {
    for name in [
        "source/ffmpeg-9.0.1.tar.xz",
        "source/ffmpeg-9.0.1.tar.xz.asc",
        "source/ffmpeg-devel.asc",
        "licenses/COPYING.LGPLv2.1",
        "licenses/LICENSE.md",
        "records/signature.log",
        "records/configure.log",
        "records/install.log",
        "records/config.h",
        "records/config_components.h",
        "records/config.mak",
        "include/libavformat/avformat.h",
        "include/libavcodec/avcodec.h",
        "include/libavutil/avutil.h",
    ] {
        let path = prepare::safe_file(prefix, &prefix.join(name))?;
        if fs::metadata(path)?.len() == 0 {
            return Err("Libav source/license/configuration provenance is incomplete".into());
        }
    }
    let signature = fs::read_to_string(prefix.join("records/signature.log"))?;
    if !signature.contains(&format!("[GNUPG:] VALIDSIG {} ", prepare::SIGNER)) {
        return Err("Pinned libav release signer record is missing".into());
    }
    Ok(())
}

fn excluded(relative: &Path) -> bool {
    let parts: Vec<_> = relative
        .components()
        .filter_map(|part| part.as_os_str().to_str())
        .collect();
    if let ["bin", name, ..] = parts.as_slice() {
        let name = name.to_ascii_lowercase();
        if ![
            "avcodec",
            "avformat",
            "avutil",
            "avfilter",
            "swresample",
            "swscale",
        ]
        .iter()
        .any(|prefix| name.starts_with(prefix))
        {
            return true;
        }
    }
    if let ["records", name, ..] = parts.as_slice()
        && !matches!(
            *name,
            "signature.log"
                | "configure.log"
                | "build.log"
                | "install.log"
                | "config.log"
                | "config.h"
                | "config_components.h"
                | "config.mak"
                | "libav-linker-flags.rsp"
        )
    {
        return true;
    }
    if let ["licenses", name, ..] = parts.as_slice()
        && !name.starts_with("COPYING")
        && *name != "LICENSE.md"
    {
        return true;
    }
    relative
        .components()
        .filter_map(|part| part.as_os_str().to_str())
        .any(|name| {
            let lowercase = name.to_ascii_lowercase();
            let name = lowercase.as_str();
            name.ends_with(".exe")
                || matches!(
                    name,
                    "ffmpeg"
                        | "ffprobe"
                        | "build-info.json"
                        | "build_config.h"
                        | "ffmpeg-runtime.json"
                )
                || name.contains("bilikara")
                || name.starts_with("companion")
                || name.starts_with("runtime-test")
                || name.starts_with("test_shim")
                || name.starts_with("probe.")
                || name == "driver-build.log"
                || name == "rust-version.txt"
                || name == "msvc-version.txt"
        })
}
fn relative(path: &Path) -> Result<()> {
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
        || path.to_str().is_none_or(|name| name.contains(['\\', ':']))
        || !path
            .components()
            .next()
            .is_some_and(|part| ROOTS.iter().any(|name| part.as_os_str() == *name))
        || excluded(path)
    {
        return Err("Invalid libav cache path".into());
    }
    Ok(())
}
fn mode(metadata: &fs::Metadata) -> u32 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o7777
    }
    #[cfg(not(unix))]
    {
        if metadata.permissions().readonly() {
            0o444
        } else {
            0o666
        }
    }
}
fn set_mode(path: &Path, mode: u32) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(mode))?;
    }
    #[cfg(not(unix))]
    {
        let mut permissions = fs::metadata(path)?.permissions();
        permissions.set_readonly(mode & 0o222 == 0);
        fs::set_permissions(path, permissions)?;
    }
    Ok(())
}

pub(crate) fn inventory(root: &Path, filter: bool) -> Result<BTreeMap<String, Value>> {
    fn visit(
        root: &Path,
        path: &Path,
        filter: bool,
        entries: &mut BTreeMap<String, Value>,
    ) -> Result<()> {
        for entry in fs::read_dir(path)? {
            let entry = entry?;
            let full = entry.path();
            let relative = full.strip_prefix(root)?;
            if relative == Path::new(MANIFEST) {
                continue;
            }
            if filter
                && (excluded(relative)
                    || (relative.components().count() == 1
                        && !ROOTS.iter().any(|name| relative == Path::new(name))))
            {
                continue;
            }
            super::libav_cache::relative(relative)?;
            let name = relative
                .to_str()
                .ok_or("Invalid UTF-8 cache filename")?
                .replace(std::path::MAIN_SEPARATOR, "/");
            let metadata = fs::symlink_metadata(&full)?;
            let value = if metadata.file_type().is_symlink() {
                let link = fs::read_link(&full)?;
                if link.is_absolute() || link.to_str().is_none_or(|name| name.contains(['\\', ':']))
                {
                    return Err("Unsafe libav cache link".into());
                }
                let resolved = full.canonicalize()?;
                if !resolved.starts_with(root.canonicalize()?) {
                    return Err("Unsafe libav cache link".into());
                }
                let target = resolved.strip_prefix(root.canonicalize()?)?.to_owned();
                super::libav_cache::relative(&target)?;
                json!({"kind":"link","target":link.to_str().ok_or("Invalid link target")?})
            } else if metadata.is_dir() {
                let value = json!({"kind":"directory","mode":mode(&metadata)});
                visit(root, &full, filter, entries)?;
                value
            } else if metadata.is_file() {
                json!({"kind":"file","sha256":hash(&fs::read(&full)?),"size":metadata.len(),"mode":mode(&metadata)})
            } else {
                return Err("Unsupported cache object".into());
            };
            entries.insert(name, value);
        }
        Ok(())
    }
    let mut entries = BTreeMap::new();
    visit(root, root, filter, &mut entries)?;
    Ok(entries)
}

fn copy_entries(
    source: &Path,
    destination: &Path,
    entries: &BTreeMap<String, Value>,
) -> Result<()> {
    for (name, entry) in entries {
        let from = source.join(name);
        let to = destination.join(name);
        let parent = to.parent().ok_or("Missing cache parent")?;
        destination_path(destination, &to)?;
        fs::create_dir_all(parent)?;
        match entry["kind"].as_str() {
            Some("directory") => {
                if to.is_symlink() {
                    return Err("Linked cache restore directory".into());
                }
                fs::create_dir_all(&to)?;
            }
            Some("file") => {
                if to.is_symlink() {
                    return Err("Linked cache restore destination".into());
                }
                fs::copy(from, &to)?;
                set_mode(
                    &to,
                    u32::try_from(entry["mode"].as_u64().ok_or("Malformed cache mode")?)?,
                )?;
            }
            Some("link") => {
                if to.exists() || to.is_symlink() {
                    if !to.is_symlink() {
                        return Err("Cache link would replace a real output".into());
                    }
                    fs::remove_file(&to)?;
                }
                #[cfg(unix)]
                std::os::unix::fs::symlink(
                    entry["target"]
                        .as_str()
                        .ok_or("Invalid cache link target")?,
                    &to,
                )?;
                #[cfg(not(unix))]
                return Err("Windows upstream cache does not accept symlinks".into());
            }
            _ => return Err("Malformed cache entry".into()),
        }
    }
    // Apply directory modes after copying their children.
    for (name, entry) in entries.iter().rev() {
        if entry["kind"] == "directory" {
            set_mode(
                &destination.join(name),
                u32::try_from(
                    entry["mode"]
                        .as_u64()
                        .ok_or("Malformed cache directory mode")?,
                )?,
            )?;
        }
    }
    Ok(())
}

fn destination_path(root: &Path, path: &Path) -> Result<()> {
    for ancestor in path.parent().ok_or("Missing cache parent")?.ancestors() {
        if ancestor == root {
            break;
        }
        if ancestor.is_symlink() {
            return Err("Linked cache restore destination ancestor".into());
        }
    }
    Ok(())
}

pub(crate) fn validated(
    cache: &Path,
    expected_key: &str,
    target: &str,
) -> Result<BTreeMap<String, Value>> {
    if cache.is_symlink() {
        return Err("Linked libav cache".into());
    }
    let metadata = cache.join(MANIFEST);
    if metadata.is_symlink() || !metadata.is_file() {
        return Err("Missing libav cache manifest".into());
    }
    let manifest: Value = serde_json::from_slice(&fs::read(metadata)?)?;
    if manifest["schema_version"] != SCHEMA
        || manifest["key"] != expected_key
        || manifest["target"] != target
    {
        return Err("Libav cache target/toolchain/key mismatch".into());
    }
    let entries: BTreeMap<String, Value> = serde_json::from_value(manifest["entries"].clone())?;
    for name in entries.keys() {
        relative(Path::new(name))?;
    }
    if inventory(cache, false)? != entries {
        return Err("Invalid libav cache content, links or permissions".into());
    }
    Ok(entries)
}

pub(crate) fn invalidate(prefix: &Path) -> Result<()> {
    for name in ["build-info.json", "bin/ffmpeg-runtime.json"] {
        let path = prefix.join(name);
        if path.is_symlink() {
            return Err("Linked libav completion record".into());
        }
        if path.exists() {
            if !path.is_file() {
                return Err("Invalid libav completion record".into());
            }
            fs::remove_file(path)?;
        }
    }
    Ok(())
}

pub fn snapshot(
    root: &Path,
    platform: Platform,
    env: &Environment,
    prefix: &Path,
    cache: &Path,
) -> Result<()> {
    prepare::check_prefix(root, prefix)?;
    prepare::disjoint(prefix, cache)?;
    let cache = cache_location(root, cache)?;
    provenance(prefix)?;
    prepare::library_facts(prefix, platform)?;
    let expected_key = key(root, platform, env)?;
    if cache.exists() {
        validated(&cache, &expected_key, &platform.target())?;
    }
    let entries = inventory(prefix, true)?;
    fs::create_dir_all(cache.parent().ok_or("Missing cache parent")?)?;
    let staging = tempfile::Builder::new()
        .prefix(".libav-cache-")
        .tempdir_in(cache.parent().unwrap())?;
    copy_entries(prefix, staging.path(), &entries)?;
    // Ensure excluded application outputs cannot be reintroduced via a link.
    if inventory(staging.path(), false)? != entries {
        return Err("Invalid upstream cache snapshot".into());
    }
    prepare::atomic_json(
        &staging.path().join(MANIFEST),
        &json!({"schema_version":SCHEMA,"key":expected_key,"target":platform.target(),"entries":entries}),
    )?;
    if cache.exists() {
        fs::remove_dir_all(&cache)?;
    } // Already validated owned cache only.
    let staged = staging.keep();
    fs::rename(&staged, &cache)?;
    Ok(())
}

pub fn restore(
    root: &Path,
    platform: Platform,
    env: &Environment,
    cache: &Path,
    prefix: &Path,
) -> Result<()> {
    prepare::check_prefix(root, prefix)?;
    prepare::disjoint(prefix, cache)?;
    let cache = cache_location(root, cache)?;
    let entries = validated(&cache, &key(root, platform, env)?, &platform.target())?;
    provenance(&cache)?;
    prepare::library_facts(&cache, platform)?;
    let parent = prefix.parent().ok_or("Missing libav prefix parent")?;
    fs::create_dir_all(parent)?;
    let staging = tempfile::Builder::new()
        .prefix(".libav-restore-")
        .tempdir_in(parent)?;
    copy_entries(&cache, staging.path(), &entries)?;
    if inventory(staging.path(), false)? != entries {
        return Err("Invalid staged upstream cache".into());
    }
    if !prefix.exists() {
        let staged = staging.keep();
        fs::rename(staged, prefix)?;
    } else {
        for name in entries.keys() {
            destination_path(prefix, &prefix.join(name))?;
        }
        invalidate(prefix)?;
        copy_entries(staging.path(), prefix, &entries)?;
    }
    Ok(())
}
