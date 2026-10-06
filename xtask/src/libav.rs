//! Shared validation/staging of prepared libav inputs. Dependency construction
//! and collection remain outside the desktop construction commands.
use crate::{
    Result,
    config::{Config, Os, Platform},
    files,
};
use object::{
    endian::LittleEndian as LE,
    read::pe::{ImageNtHeaders, ImageOptionalHeader, PeFile64},
};
use regex::Regex;
use serde_json::Value;
use std::{
    collections::HashSet,
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::Command,
};

const MANIFEST: &str = "ffmpeg-runtime.json";

pub fn prefix(config: &Config) -> Result<Option<PathBuf>> {
    let Some(value) = config
        .env
        .get("BILIKARA_LIBAV_PREFIX")
        .filter(|v| !v.is_empty())
    else {
        return Ok(None);
    };
    let prefix = PathBuf::from(value);
    if !prefix.is_absolute() {
        return Err("Libav packaging requires an absolute same-build prefix".into());
    }
    let vendor = prefix.join("bin");
    if !vendor.join(MANIFEST).is_file() {
        return Err("Libav prefix is incomplete; no system fallback".into());
    }
    let data: Value = serde_json::from_slice(&fs::read(vendor.join(MANIFEST))?)?;
    validate_manifest(&vendor, &data)?;
    if !vendor.join(config.platform.companion()).is_file() {
        return Err("Libav prefix is incomplete; no system fallback".into());
    }
    if data["target"] != config.platform.target() {
        return Err("Libav prefix does not match the native package target".into());
    }
    for name in [
        "source/ffmpeg-9.0.1.tar.xz",
        "licenses/COPYING.LGPLv2.1",
        "build-info.json",
    ] {
        if !prefix.join(name).is_file() {
            return Err("Libav prefix provenance is incomplete".into());
        }
    }
    if data["kind"] != "libav" {
        return Err(
            "Native desktop requires a libav-only prefix; media CLI prefixes are retired".into(),
        );
    }
    Ok(Some(prefix))
}

fn validate_manifest(vendor: &Path, data: &Value) -> Result<()> {
    let invalid = "Invalid packaged FFmpeg manifest";
    let target = data["target"].as_str().ok_or(invalid)?;
    let windows = target.ends_with("-windows-msvc");
    let tools: &[&str] = if data["kind"] == "libav" {
        if windows {
            &["bilikara_media_libav.dll"]
        } else if target.ends_with("apple-darwin") {
            &["libbilikara_media_libav.dylib"]
        } else {
            &["libbilikara_media_libav.so"]
        }
    } else if windows {
        &["ffmpeg.exe", "ffprobe.exe"]
    } else {
        &["ffmpeg", "ffprobe"]
    };
    let names = data["runtime_files"].as_array().ok_or(invalid)?;
    if data["schema_version"] != 1
        || data["version"] != "9.0.1"
        || !Regex::new(r"^(x86_64|aarch64)-(pc-windows-msvc|apple-darwin|unknown-linux-gnu)$")
            .unwrap()
            .is_match(target)
        || names.len() > 64
        || !tools.iter().all(|t| names.iter().any(|n| n == t))
    {
        return Err(invalid.into());
    }
    let pattern = Regex::new(r"^lib[A-Za-z0-9_.-]+(?:\.dylib|\.so(?:\.[0-9]+)*)$").unwrap();
    let mut seen = HashSet::new();
    let mut codec = false;
    for name in names {
        let name = name.as_str().ok_or(invalid)?;
        if !name.is_ascii()
            || name.contains(['/', '\\', ':'])
            || matches!(name, "." | "..")
            || !(tools.contains(&name)
                || (windows && name.to_ascii_lowercase().ends_with(".dll"))
                || (!windows && pattern.is_match(name)))
        {
            return Err("Invalid packaged runtime filename".into());
        }
        let path = vendor.join(name);
        if !path.is_file()
            || path.canonicalize()?.parent() != Some(vendor.canonicalize()?.as_path())
        {
            return Err("Packaged FFmpeg runtime dependency is missing".into());
        }
        if !seen.insert(name) {
            return Err("Incomplete packaged FFmpeg manifest".into());
        }
        codec |= name.starts_with(if windows { "avcodec-" } else { "libavcodec." });
    }
    if !codec {
        return Err("Incomplete packaged FFmpeg manifest".into());
    }
    Ok(())
}

pub fn stage(config: &Config, prefix: &Path, layout: &files::Layout) -> Result<()> {
    let vendor = &layout.vendor;
    let docs = &layout.docs;
    let manifest: Value = serde_json::from_slice(&fs::read(prefix.join("bin").join(MANIFEST))?)?;
    let test_companion = if config.platform.os == Os::Windows {
        "bilikara_media_libav_test.dll".to_owned()
    } else {
        config.platform.companion().replace("libav.", "libav_test.")
    };
    for name in manifest["runtime_files"]
        .as_array()
        .ok_or("missing runtime_files")?
    {
        let name = name.as_str().ok_or("invalid runtime filename")?;
        if name == test_companion {
            continue;
        }
        let destination = vendor.join(name);
        if config.platform.os != Os::Windows && destination.is_symlink() {
            fs::remove_file(&destination)?;
        }
        files::copy(&prefix.join("bin").join(name), &destination)?;
    }
    let mut runtime = serde_json::Map::new();
    for key in [
        "schema_version",
        "kind",
        "version",
        "target",
        "runtime_files",
        "build_run",
        "build_attempt",
    ] {
        if let Some(value) = manifest.get(key) {
            runtime.insert(key.into(), value.clone());
        }
    }
    if layout.macos_app {
        let resource_vendor = layout.resources.join("vendor");
        files::write_json(&resource_vendor.join(MANIFEST), &Value::Object(runtime))?;
        files::relative_link(
            Path::new("../Resources/vendor/ffmpeg-runtime.json"),
            &vendor.join(MANIFEST),
        )?;
        for entry in fs::read_dir(vendor)? {
            let entry = entry?;
            if entry.file_name() != MANIFEST {
                files::relative_link(
                    &Path::new("../../Frameworks").join(entry.file_name()),
                    &resource_vendor.join(entry.file_name()),
                )?;
            }
        }
    } else {
        files::write_json(&vendor.join(MANIFEST), &Value::Object(runtime))?;
    }
    files::tree(
        &prefix.join("licenses"),
        &docs.join("THIRD_PARTY_LICENSES/libav"),
        false,
    )?;
    let sources = docs.join("THIRD_PARTY_SOURCES");
    fs::create_dir_all(&sources)?;
    for source in fs::read_dir(prefix.join("source"))? {
        let source = source?;
        if config.platform.os != Os::Windows
            || source
                .path()
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("asc"))
        {
            files::copy(&source.path(), &sources.join(source.file_name()))?;
        }
    }
    let mut rebuild = vec![
        "probe.h",
        "probe.c",
        "remux.c",
        "pcm.c",
        "test_shim.c",
        "windows_io.h",
        "xtask.sh",
        "REBUILD.md",
        "fixtures/synthetic.h264",
    ];
    rebuild.extend(if config.platform.os == Os::Windows {
        vec![
            "build-windows.sh",
            "build-windows-libraries.sh",
            "prepare-windows.ps1",
        ]
    } else {
        vec!["build-posix.sh", "build-posix-libraries.sh"]
    });
    for name in rebuild {
        files::copy(
            &config.root.join("media-libav").join(name),
            &sources.join("media-libav").join(name),
        )?;
    }
    // The migrated wrappers need this independent tool in the source kit.
    // Include its locked sources, never a compiled tool or application Runtime.
    for name in ["Cargo.toml", "Cargo.lock"] {
        files::copy(
            &config.root.join("xtask").join(name),
            &sources.join("xtask").join(name),
        )?;
    }
    files::tree(
        &config.root.join("xtask/src"),
        &sources.join("xtask/src"),
        false,
    )?;
    files::copy(&config.root.join("LICENSE"), &sources.join("xtask/LICENSE"))?;
    for name in ["BBDown-LICENSE.txt", "ebur128-LICENSE.txt"] {
        files::copy(
            &config.root.join("third_party").join(name),
            &sources.join("third_party").join(name),
        )?;
    }
    files::copy(
        &config.root.join("rust-toolchain.toml"),
        &sources.join("rust-toolchain.toml"),
    )?;
    let host = layout
        .code
        .join(config.platform.executable("bilikara-desktop-host"));
    let forbidden: &[&str] = if config.platform.os == Os::Windows {
        &["bilikara_media_libav", "avformat-", "avcodec-", "avutil-"]
    } else {
        &["libav", "libbilikara_media_libav"]
    };
    for import in binary_imports(&host, config.platform)? {
        let name = Path::new(&import)
            .file_name()
            .unwrap_or_default()
            .to_string_lossy();
        if forbidden.iter().any(|prefix| name.starts_with(prefix)) {
            return Err("Mandatory Rust Runtime acquired a libav import".into());
        }
    }
    Ok(())
}

pub fn command_output(name: &str, args: &[&std::ffi::OsStr]) -> Result<String> {
    let output = Command::new(name).args(args).output()?;
    if !output.status.success() {
        return Err(format!("{name} failed: {}", String::from_utf8_lossy(&output.stderr)).into());
    }
    Ok(String::from_utf8(output.stdout)?)
}

pub fn binary_imports(path: &Path, platform: Platform) -> Result<Vec<String>> {
    if platform.os == Os::Windows {
        return pe_imports(&fs::read(path)?, platform);
    }
    if platform.os == Os::Macos {
        let arch = command_output("lipo", &["-archs".as_ref(), path.as_os_str()])?;
        if arch.trim() != if platform.arm { "arm64" } else { "x86_64" } {
            return Err(format!("Non-native Mach-O: {}", path.display()).into());
        }
        let result = command_output("otool", &["-L".as_ref(), path.as_os_str()])?;
        return Ok(result
            .lines()
            .skip(if path.extension().is_some_and(|e| e == "dylib") {
                2
            } else {
                1
            })
            .map(|l| l.trim().split(" (").next().unwrap_or("").into())
            .collect());
    }
    let mut header = [0u8; 20];
    fs::File::open(path)?.read_exact(&mut header)?;
    if &header[..6] != b"\x7fELF\x02\x01"
        || u16::from_le_bytes([header[18], header[19]]) != if platform.arm { 183 } else { 62 }
    {
        return Err(format!("Non-native ELF: {}", path.display()).into());
    }
    let output = command_output("readelf", &["-d".as_ref(), path.as_os_str()])?;
    Ok(Regex::new(r"\(NEEDED\).*\[([^\]]+)\]")
        .unwrap()
        .captures_iter(&output)
        .map(|c| c[1].to_owned())
        .collect())
}

fn pe_imports(bytes: &[u8], platform: Platform) -> Result<Vec<String>> {
    let pe = PeFile64::parse(bytes)?;
    if pe.nt_headers().file_header().machine.get(LE) != if platform.arm { 0xaa64 } else { 0x8664 } {
        return Err("Expected native MSVC PE".into());
    }
    let mut imports = Vec::new();
    if let Some(table) = pe.import_table()? {
        let mut descriptors = table.descriptors()?;
        while let Some(desc) = descriptors.next()? {
            imports.push(std::str::from_utf8(table.name(desc.name.get(LE))?)?.to_ascii_lowercase());
        }
    }
    if let Some(table) = pe
        .data_directories()
        .delay_load_import_table(bytes, &pe.section_table())?
    {
        let mut descriptors = table.descriptors()?;
        while let Some(desc) = descriptors.next()? {
            let mut address = u64::from(desc.dll_name_rva.get(LE));
            if desc.attributes.get(LE) & 1 == 0 {
                address = address
                    .checked_sub(pe.nt_headers().optional_header().image_base())
                    .ok_or("Invalid delay import address")?;
            }
            imports.push(
                std::str::from_utf8(table.name(u32::try_from(address)?)?)?.to_ascii_lowercase(),
            );
        }
    }
    Ok(imports)
}
