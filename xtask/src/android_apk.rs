//! Inspect the final archive, independently of Gradle's intermediate outputs.
use crate::{Result, android_libav};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::{OsStr, OsString},
    fs,
    io::{Cursor, Read},
    path::{Path, PathBuf},
};

const LIBRARIES: &[&str] = &[
    "libbilikara_app.so",
    "libbilikara_media_libav.so",
    "libavformat.so",
    "libavcodec.so",
    "libavutil.so",
    "libswresample.so",
    "libc++_shared.so",
];
fn safe(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('/')
        && !name.contains(['\\', ':', '\0'])
        && name
            .trim_end_matches('/')
            .split('/')
            .all(|p| !p.is_empty() && p != "." && p != "..")
}
fn entries<R: Read + std::io::Seek>(
    zip: &mut zip::ZipArchive<R>,
) -> Result<BTreeMap<String, usize>> {
    if zip.len() > 20_000 {
        return Err("Android archive has too many entries".into());
    }
    let mut names = BTreeMap::new();
    let mut total = 0u64;
    for i in 0..zip.len() {
        let entry = zip.by_index(i)?;
        total = total.checked_add(entry.size()).ok_or("APK size overflow")?;
        if total > 1024 * 1024 * 1024
            || entry.size() > 256 * 1024 * 1024
            || !safe(entry.name())
            || entry.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000)
            || names.insert(entry.name().to_owned(), i).is_some()
        {
            return Err("Unsafe, duplicate or overlarge Android archive entry".into());
        }
    }
    Ok(names)
}
fn bytes<R: Read + std::io::Seek>(
    zip: &mut zip::ZipArchive<R>,
    names: &BTreeMap<String, usize>,
    key: &str,
    limit: u64,
) -> Result<Vec<u8>> {
    let mut entry = zip.by_index(
        *names
            .get(key)
            .ok_or_else(|| format!("Missing Android package entry: {key}"))?,
    )?;
    if entry.size() > limit {
        return Err("Android package entry exceeds its limit".into());
    }
    let mut result = Vec::new();
    entry.read_to_end(&mut result)?;
    Ok(result)
}
fn source_kit(data: Vec<u8>) -> Result<()> {
    let mut zip = zip::ZipArchive::new(Cursor::new(data))?;
    let names = entries(&mut zip)?;
    let source = bytes(
        &mut zip,
        &names,
        "source/ffmpeg-9.0.1.tar.xz",
        32 * 1024 * 1024,
    )?;
    if format!("{:x}", Sha256::digest(source))
        != "cf38e0e28c7e5605942c4a77755349b0145804a397af37eb1fb4c77cb237f635"
    {
        return Err("APK rebuild source pin mismatch".into());
    }
    let manifest: Value = serde_json::from_slice(&bytes(
        &mut zip,
        &names,
        "media-libav/signalsmith/sources.json",
        64 * 1024,
    )?)?;
    let files = manifest["files"]
        .as_array()
        .filter(|v| v.len() == 22)
        .ok_or("Missing DSP source inventory")?;
    for file in files {
        let path = file["path"]
            .as_str()
            .filter(|p| safe(p))
            .ok_or("Invalid DSP source name")?;
        let payload = bytes(
            &mut zip,
            &names,
            &format!("media-libav/signalsmith/{path}"),
            4 * 1024 * 1024,
        )?;
        if file["sha256"] != format!("{:x}", Sha256::digest(payload)) {
            return Err("APK DSP source mismatch".into());
        }
    }
    for name in [
        "media-libav/probe.c",
        "media-libav/live_ts.c",
        "media-libav/live_audio.c",
        "media-libav/stretch.cpp",
        "media-libav/REBUILD.md",
        "xtask/Cargo.lock",
        "xtask/src/android_libav.rs",
        "THIRD_PARTY_NOTICES.md",
        "source/ffmpeg-9.0.1.tar.xz.asc",
        "source/ffmpeg-devel.asc",
    ] {
        bytes(&mut zip, &names, name, 4 * 1024 * 1024)?;
    }
    Ok(())
}
pub(super) fn verify(ndk: &Path, apk: &Path, abi: &str) -> Result<Value> {
    if !apk.is_absolute()
        || !ndk.is_absolute()
        || fs::symlink_metadata(apk)?.file_type().is_symlink()
        || fs::metadata(apk)?.len() > 512 * 1024 * 1024
    {
        return Err("Use a bounded regular APK and absolute native paths".into());
    }
    let tc = android_libav::apk_toolchain(ndk)?;
    let mut zip = zip::ZipArchive::new(fs::File::open(apk)?)?;
    let names = entries(&mut zip)?;
    let expected = LIBRARIES
        .iter()
        .map(|n| format!("lib/{abi}/{n}"))
        .collect::<BTreeSet<_>>();
    let actual = names
        .keys()
        .filter(|p| p.starts_with("lib/") && !p.ends_with('/'))
        .cloned()
        .collect::<BTreeSet<_>>();
    if actual != expected {
        return Err(
            "Final APK must contain exactly the selected ABI and declared native libraries".into(),
        );
    }
    let stage = tempfile::Builder::new()
        .prefix("bilikara-apk-media-")
        .tempdir()?;
    let mut facts = BTreeMap::new();
    for name in LIBRARIES {
        let payload = bytes(
            &mut zip,
            &names,
            &format!("lib/{abi}/{name}"),
            if *name == "libbilikara_app.so" {
                256 * 1024 * 1024
            } else {
                64 * 1024 * 1024
            },
        )?;
        let path = stage.path().join(name);
        fs::write(&path, payload)?;
        facts.insert(
            *name,
            android_libav::apk_library(&tc, &path, abi, *name == "libbilikara_app.so")?,
        );
    }
    let prefix = format!("assets/bilikara-media/{abi}");
    let info: Value = serde_json::from_slice(&bytes(
        &mut zip,
        &names,
        &format!("{prefix}/build-info.json"),
        64 * 1024,
    )?)?;
    if info["schema_version"] != 1
        || info["abi"] != abi
        || info["ndk"] != "27.0.12077973"
        || info["ffmpeg"] != "9.0.1"
    {
        return Err("Invalid final APK media build metadata".into());
    }
    for name in &LIBRARIES[1..] {
        if info["libraries"][*name] != facts[*name] {
            return Err("Final APK libraries differ from declared media build facts".into());
        }
    }
    for name in [
        "licenses/libav/COPYING.LGPLv2.1",
        "licenses/Signalsmith-Stretch.txt",
        "licenses/Signalsmith-Linear.txt",
        "licenses/Android-NDK-NOTICE.txt",
        "licenses/THIRD_PARTY_NOTICES.md",
    ] {
        if bytes(
            &mut zip,
            &names,
            &format!("{prefix}/{name}"),
            4 * 1024 * 1024,
        )?
        .is_empty()
        {
            return Err("Empty APK media license".into());
        }
    }
    source_kit(bytes(
        &mut zip,
        &names,
        &format!("{prefix}/source-kit.zip"),
        64 * 1024 * 1024,
    )?)?;
    Ok(
        json!({"schema_version":1,"kind":"android-apk-media","abi":abi,"libraries":facts,"rebuild_kit_verified":true}),
    )
}
pub(super) fn run(args: Vec<OsString>) -> Result<()> {
    let mut values = BTreeMap::new();
    let mut args = args.into_iter();
    while let Some(k) = args.next() {
        if !["--ndk", "--apk", "--abi"].iter().any(|n| k == *n) || values.contains_key(&k) {
            return Err("Invalid or duplicate verify-android-apk argument".into());
        }
        values.insert(k, args.next().ok_or("Missing argument")?);
    }
    let path = |k: &str| {
        values
            .get(OsStr::new(k))
            .map(PathBuf::from)
            .ok_or_else(|| format!("Missing {k}"))
    };
    let abi = values
        .get(OsStr::new("--abi"))
        .and_then(|v| v.to_str())
        .ok_or("Missing ABI")?;
    println!("{}", verify(&path("--ndk")?, &path("--apk")?, abi)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn archive_names_reject_native_traversal_and_links() {
        for name in [
            "../lib/a", "/lib/a", "lib\\a", "lib/C:a", "lib//a", "lib/./a",
        ] {
            assert!(!safe(name));
        }
        assert!(safe("assets/bilikara-media/arm64-v8a/source-kit.zip"));
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        zip.add_symlink(
            "assets/link",
            "../escape",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
        let mut archive = zip::ZipArchive::new(zip.finish().unwrap()).unwrap();
        assert!(entries(&mut archive).is_err());
    }
}
