//! Release notices and exact source materials; no dependency acquisition.
use crate::{Result, config::Config, files, tools};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

fn recorded(config: &Config, key: &str) -> String {
    let value = config.env.text(key);
    if value.is_empty() {
        "not recorded".into()
    } else {
        value
    }
}

fn archive(config: &Config) -> Result<Option<PathBuf>> {
    let value = config.env.text("BILIKARA_FFMPEG_SOURCE_ARCHIVE");
    if value.is_empty() {
        return Ok(None);
    }
    let path = tools::expand_metadata_path(config, &value)?;
    if !path.is_file() {
        return Err(format!(
            "Configured FFmpeg source archive not found: {}",
            path.display()
        )
        .into());
    }
    let expected = config
        .env
        .text("BILIKARA_FFMPEG_SOURCE_SHA256")
        .to_ascii_lowercase();
    if !expected.is_empty() {
        let mut file = fs::File::open(&path)?;
        let mut hash = Sha256::new();
        let mut buffer = [0; 64 * 1024];
        loop {
            let size = file.read(&mut buffer)?;
            if size == 0 {
                break;
            }
            hash.update(&buffer[..size]);
        }
        let actual = format!("{:x}", hash.finalize());
        if actual != expected {
            return Err(format!(
                "FFmpeg source archive SHA-256 mismatch: expected {expected}, got {actual}"
            )
            .into());
        }
    }
    Ok(Some(path))
}

fn bbdown_license(config: &Config) -> Result<PathBuf> {
    let value = config.env.text("BILIKARA_BBDOWN_LICENSE_FILE");
    let path = if value.is_empty() {
        config.root.join("third_party/BBDown-LICENSE.txt")
    } else {
        tools::expand_metadata_path(config, &value)?
    };
    if !path.is_file() {
        return Err(format!(
            "Configured BBDown license file not found: {}",
            path.display()
        )
        .into());
    }
    Ok(path)
}

pub fn input_files(config: &Config) -> Result<Vec<PathBuf>> {
    let source = archive(config)?;
    let mut inputs = vec![bbdown_license(config)?];
    inputs.extend(source);
    Ok(inputs)
}

pub fn write(config: &Config, docs: &Path) -> Result<()> {
    fs::create_dir_all(docs)?;
    for name in ["LICENSE", "LEGAL.md", "THIRD_PARTY_NOTICES.md"] {
        let source = config.root.join(name);
        if source.exists() {
            files::copy(&source, &docs.join(name))?;
        }
    }
    let licenses = docs.join("THIRD_PARTY_LICENSES");
    fs::create_dir_all(&licenses)?;
    let source_archive = config.env.text("BILIKARA_FFMPEG_SOURCE_ARCHIVE");
    let archive_name = if source_archive.is_empty() {
        "not recorded".into()
    } else {
        Path::new(&source_archive)
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned()
    };
    fs::write(
        licenses.join("libav-source.txt"),
        format!(
            "FFmpeg libraries (libav) redistribution notes\n\n\
This native product uses dynamically loaded libraries from the FFmpeg project.\n\
FFmpeg and ffprobe executables are not bundled. The library build disables\n\
programs, GPL and nonfree components; see libav/COPYING.LGPLv2.1 and libav/LICENSE.md.\n\n\
- FFmpeg library version: {}\n\
- Official source URL: {}\n\
- Source SHA-256: {}\n\
- Exact source archive: ../THIRD_PARTY_SOURCES/{archive_name}\n\
- Build scripts and companion source: ../THIRD_PARTY_SOURCES/media-libav/\n\
- Upstream legal information: https://ffmpeg.org/legal.html\n",
            recorded(config, "BILIKARA_FFMPEG_SOURCE_VERSION"),
            recorded(config, "BILIKARA_FFMPEG_SOURCE_URL"),
            recorded(config, "BILIKARA_FFMPEG_SOURCE_SHA256"),
        ),
    )?;
    let tool =
        tools::bbdown_path(config)?.ok_or("Prepare the pinned BBDown vendor before packaging")?;
    let canonical = tool.canonicalize()?;
    // pathlib.resolve's Windows display omits the extended-length prefix.
    let build_path = canonical.to_string_lossy();
    let build_path = build_path
        .strip_prefix(r"\\?\UNC\")
        .map(|s| format!(r"\\{s}"))
        .unwrap_or_else(|| {
            build_path
                .strip_prefix(r"\\?\")
                .unwrap_or(&build_path)
                .into()
        });
    fs::write(
        licenses.join("bbdown-source.txt"),
        format!(
            "BBDown redistribution notes\n\n\
The packaged runtime includes a pinned BBDown vendor executable and restores\n\
the writable runtime copy from that immutable vendor instead of polling releases.\n\n\
- Bundled build path: {build_path}\n\
- Version: {}\n\
- Upstream release commit: {}\n\
- Asset: {}\n\
- Source URL: {}\n\
- Asset SHA-256: {}\n\
- Upstream repository: https://github.com/nilaoda/BBDown\n\
- License: MIT; see BBDown-LICENSE.txt\n",
            recorded(config, "BILIKARA_BBDOWN_VERSION"),
            recorded(config, "BILIKARA_BBDOWN_RELEASE_COMMIT"),
            recorded(config, "BILIKARA_BBDOWN_ARCHIVE_NAME"),
            recorded(config, "BILIKARA_BBDOWN_SOURCE_URL"),
            recorded(config, "BILIKARA_BBDOWN_SHA256"),
        ),
    )?;
    if let Some(source) = archive(config)? {
        files::copy(
            &source,
            &docs
                .join("THIRD_PARTY_SOURCES")
                .join(source.file_name().ok_or("missing archive filename")?),
        )?;
    }
    files::copy(
        &bbdown_license(config)?,
        &licenses.join("BBDown-LICENSE.txt"),
    )?;
    let (success, output) = tools::help(&tool)?;
    if !success || output.trim().is_empty() {
        return Err("BBDown compliance execution failed".into());
    }
    fs::write(licenses.join("bbdown-version.txt"), output)?;
    Ok(())
}
