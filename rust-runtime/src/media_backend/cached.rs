//! Portable validation of formats the Native cache actually publishes. This
//! is deliberately separate from MP4 download normalization: native FLAC is
//! already an elementary output, not another DASH MP4 to remux.
use super::{ExpectedMediaKind, MediaError, MediaPathRequest, MediaProbe};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

pub(crate) fn probe_cached_media(
    request: &MediaPathRequest,
    cancel: &AtomicBool,
) -> Result<MediaProbe, MediaError> {
    super::validate_source_request(request.schema_version, &request.source)?;
    if !fs::symlink_metadata(&request.source).is_ok_and(|m| m.file_type().is_file()) {
        return Err(MediaError::invalid_media(
            "cached media must be a regular non-symlink file",
        ));
    }
    let mut header = [0u8; 4];
    File::open(&request.source)
        .and_then(|mut f| f.read_exact(&mut header))
        .map_err(|_| MediaError::invalid_media("cached media header is missing"))?;
    if &header != b"fLaC" {
        return super::probe_media(request);
    }
    if request.expected_kind != ExpectedMediaKind::Audio {
        return Err(MediaError::contract_violation(
            "native FLAC cannot satisfy a video track",
        ));
    }
    probe_flac(&request.source, cancel)
}

fn payload_offset(path: &Path, size: u64) -> Result<u64, MediaError> {
    let mut file = File::open(path).map_err(|_| MediaError::io("failed to open cached FLAC"))?;
    file.seek(SeekFrom::Start(4))
        .map_err(|_| MediaError::io("failed to read cached FLAC"))?;
    let mut offset = 4u64;
    for index in 0..128 {
        let mut h = [0u8; 4];
        file.read_exact(&mut h)
            .map_err(|_| MediaError::invalid_media("truncated FLAC metadata"))?;
        let kind = h[0] & 0x7f;
        let length = u32::from_be_bytes([0, h[1], h[2], h[3]]) as u64;
        if kind == 127 || (index == 0 && (kind != 0 || length != 34)) {
            return Err(MediaError::invalid_media("invalid FLAC STREAMINFO"));
        }
        offset = offset
            .checked_add(4 + length)
            .filter(|end| *end <= size && *end <= 16 * 1024 * 1024)
            .ok_or_else(|| MediaError::invalid_media("invalid or excessive FLAC metadata"))?;
        file.seek(SeekFrom::Start(offset))
            .map_err(|_| MediaError::io("failed to read FLAC metadata"))?;
        if h[0] & 0x80 != 0 {
            return Ok(offset);
        }
    }
    Err(MediaError::invalid_media("excessive FLAC metadata blocks"))
}

fn probe_flac(path: &Path, cancel: &AtomicBool) -> Result<MediaProbe, MediaError> {
    let file_bytes = path
        .metadata()
        .map_err(|_| MediaError::io("failed to stat cached FLAC"))?
        .len();
    let offset = payload_offset(path, file_bytes)?;
    let mut reader = claxon::FlacReader::open(path)
        .map_err(|_| MediaError::invalid_media("invalid native FLAC header"))?;
    let info = reader.streaminfo();
    if info.sample_rate == 0
        || !(1..=8).contains(&info.channels)
        || !(4..=32).contains(&info.bits_per_sample)
    {
        return Err(MediaError::invalid_media("invalid FLAC signal parameters"));
    }
    let mut digest = md5::Context::new();
    let mut pcm = Vec::with_capacity(super::COPY_BUFFER_BYTES + 4);
    let bytes_per_sample = info.bits_per_sample.div_ceil(8) as usize;
    let mut frames = reader.blocks();
    let mut buffer = Vec::new();
    let mut samples = 0u64;
    let mut count = 0u32;
    let mut short_final = false;
    loop {
        if cancel.load(Ordering::Acquire) {
            return Err(MediaError::io("cached FLAC validation cancelled"));
        }
        let Some(block) = frames
            .read_next_or_eof(buffer)
            .map_err(|_| MediaError::invalid_media("invalid or truncated FLAC frame"))?
        else {
            break;
        };
        // Claxon 0.4 computes a fixed frame's time as frame-number times that
        // frame's own size. For the legal shorter final frame this is not its
        // sample offset. Verify its index against the preceding fixed blocks,
        // require EOF next, and still verify total samples and decoded MD5.
        let shorter_fixed = info.min_block_size == info.max_block_size
            && block.duration() < u32::from(info.max_block_size);
        let final_index = shorter_fixed
            && block.time() == u64::from(count) * u64::from(block.duration())
            && samples == u64::from(count) * u64::from(info.max_block_size);
        if short_final
            || block.channels() != info.channels
            || block.duration() == 0
            || (block.time() != samples && !final_index)
        {
            return Err(MediaError::invalid_media("invalid FLAC frame timeline"));
        }
        short_final = shorter_fixed;
        for index in 0..block.duration() {
            if index % 4096 == 0 && cancel.load(Ordering::Acquire) {
                return Err(MediaError::io("cached FLAC validation cancelled"));
            }
            for channel in 0..info.channels {
                pcm.extend_from_slice(
                    &block.sample(channel, index).to_le_bytes()[..bytes_per_sample],
                );
            }
            if pcm.len() >= super::COPY_BUFFER_BYTES {
                digest.consume(&pcm);
                pcm.clear();
            }
        }
        samples = samples
            .checked_add(u64::from(block.duration()))
            .ok_or_else(|| MediaError::invalid_media("FLAC sample count overflow"))?;
        count = count
            .checked_add(1)
            .ok_or_else(|| MediaError::invalid_media("FLAC frame count overflow"))?;
        buffer = block.into_buffer();
    }
    digest.consume(&pcm);
    if count == 0 || info.samples.is_some_and(|expected| expected != samples) {
        return Err(MediaError::invalid_media(
            "FLAC decoded sample inventory mismatch",
        ));
    }
    if info.md5sum != [0; 16] && digest.finalize().0 != info.md5sum {
        return Err(MediaError::invalid_media("FLAC decoded checksum mismatch"));
    }
    Ok(MediaProbe {
        path: path.into(),
        kind: ExpectedMediaKind::Audio,
        codec: "flac".into(),
        duration_seconds: samples as f64 / f64::from(info.sample_rate),
        sample_count: count,
        sample_bytes: file_bytes - offset,
        file_bytes,
        fragmented: false,
        fast_start: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cached_flac_checks_frames_inventory_checksum_kind_links_and_cancellation() {
        let root =
            std::env::temp_dir().join(format!("bilikara-cached-flac-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("native.flac");
        super::super::normalize_media(&super::super::MediaNormalizeRequest {
            schema_version: 1,
            source: Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../tests/fixtures/bbdown/audio-flac.mp4"),
            destination: path.clone(),
            expected_kind: ExpectedMediaKind::Audio,
        })
        .unwrap();
        let bytes = fs::read(&path).unwrap();
        let cancel = AtomicBool::new(false);
        let request = MediaPathRequest {
            schema_version: 1,
            source: path.clone(),
            expected_kind: ExpectedMediaKind::Audio,
        };
        assert_eq!(probe_cached_media(&request, &cancel).unwrap().codec, "flac");
        let mut video = request.clone();
        video.expected_kind = ExpectedMediaKind::Video;
        assert_eq!(
            probe_cached_media(&video, &cancel).unwrap_err().kind,
            super::super::MediaErrorKind::MediaContractViolation
        );
        for version in [
            bytes[..bytes.len() - 1].to_vec(),
            bytes[..42].to_vec(),
            {
                let mut altered = bytes.clone();
                altered[26] ^= 1;
                altered
            },
            {
                let mut altered = bytes.clone();
                altered[25] ^= 1;
                altered
            },
        ] {
            fs::write(&path, version).unwrap();
            assert!(probe_cached_media(&request, &cancel).is_err());
        }
        fs::write(&path, &bytes).unwrap();
        cancel.store(true, Ordering::Release);
        assert!(probe_cached_media(&request, &cancel).is_err());
        cancel.store(false, Ordering::Release);
        #[cfg(unix)]
        {
            let link = root.join("linked.flac");
            std::os::unix::fs::symlink(&path, &link).unwrap();
            let mut linked = request.clone();
            linked.source = link;
            assert!(probe_cached_media(&linked, &cancel).is_err());
        }
        assert_eq!(fs::read(path).unwrap(), bytes);
        fs::remove_dir_all(root).unwrap();
    }
}
