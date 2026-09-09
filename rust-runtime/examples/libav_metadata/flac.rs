//! Full-decode diagnostic oracle for small developer fixtures only. No runtime
//! API or production full-decode capability; Claxon is an existing dev dependency.
use super::*;
use bilikara_runtime::experimental_libav::FlacStreamInfo;
use bilikara_runtime::{MediaNormalizeRequest, normalize_media};
use claxon::FlacReader;

const MAX_PCM_BYTES: usize = 16 * 1024 * 1024;
const PCM_OUTPUT: &[&str] = &["-map", "0:0", "-c:a", "pcm_s32le", "-f", "s32le", "pipe:1"];

fn pcm(args: &Args, path: &Path) -> Result<Vec<u8>, Outcome> {
    // FFmpeg aligns 16/24-bit decoded integers to the MSBs of signed s32.
    // Explicit encoder/muxer, original rate and channel layout: no -ar/-ac,
    // filters, resampling, trimming or implicit 16-bit output defaults.
    let result = capture_limited(
        tool_command(&args.prefix, "ffmpeg")
            .args(["-v", "error", "-xerror", "-nostdin"])
            // Same M3 operational spelling: MOV-only options are unused on
            // raw FLAC. Their pinned defaults are zero; fd-only stays explicit.
            .args(
                DISCOVERY
                    .chunks_exact(2)
                    .filter(|pair| !matches!(pair[0], "-enable_drefs" | "-use_absolute_path"))
                    .flatten(),
            )
            .args(["-fd", "0", "-i", "fd:"])
            .args(PCM_OUTPUT)
            .stdin(Stdio::from(file(path)?)),
        &CANCELLED,
        args.timeout,
        true,
        MAX_PCM_BYTES,
    )?;
    if !result.success || result.diagnostic_bytes != 0 || result.bytes.is_empty() {
        return Err(Outcome::InvalidOutput);
    }
    Ok(result.bytes)
}

fn pcm_equal(a: &[u8], b: &[u8], channels: u32) -> bool {
    channels > 0 && !a.is_empty() && a.len().is_multiple_of(channels as usize * 4) && a == b
}

fn independent(
    path: &Path,
    source_pcm: &[u8],
    info: &FlacStreamInfo,
) -> Result<Option<u64>, Outcome> {
    // Existing Claxon predates RFC 9639's 32-bit frame code. Its support limit
    // is not evidence of corrupt output or a conversion rule.
    if info.bits_per_sample == 32 {
        return Ok(None);
    }
    let mut decoder = match FlacReader::new(file(path)?) {
        Ok(decoder) => decoder,
        Err(claxon::Error::Unsupported(_)) => return Ok(None),
        Err(_) => return Err(Outcome::InvalidOutput),
    };
    let s = decoder.streaminfo();
    if s.sample_rate != info.sample_rate_hz
        || s.channels != info.channel_count
        || s.bits_per_sample != info.bits_per_sample
    {
        return Err(Outcome::InvalidOutput);
    }
    let mut expected = source_pcm.chunks_exact(4);
    let mut values = 0u64;
    // Claxon yields signed integers at their actual precision, not MSB-aligned
    // s32. Widen before scaling so 24-bit precision and signs cannot be lost.
    for sample in decoder.samples() {
        if CANCELLED.load(Ordering::Relaxed) {
            return Err(Outcome::Cancelled);
        }
        let sample = match sample {
            Ok(sample) => sample,
            Err(claxon::Error::Unsupported(_)) => return Ok(None),
            Err(_) => return Err(Outcome::InvalidOutput),
        };
        let bytes = expected.next().ok_or(Outcome::InvalidOutput)?;
        let aligned = i64::from(sample) * (1i64 << (32 - info.bits_per_sample));
        if aligned != i64::from(i32::from_le_bytes(bytes.try_into().unwrap())) {
            return Err(Outcome::InvalidOutput);
        }
        values += 1;
    }
    if expected.next().is_some()
        || !expected.remainder().is_empty()
        || values == 0
        || !values.is_multiple_of(u64::from(info.channel_count))
    {
        return Err(Outcome::InvalidOutput);
    }
    Ok(Some(values / u64::from(info.channel_count)))
}

pub(super) fn verify(
    args: &Args,
    probe: &LibavMetadataProbe,
    directory: &Path,
    native: &Path,
    reference: &Path,
    report: &mut serde_json::Value,
) -> Result<(), Outcome> {
    let info = FlacStreamInfo::read(&mut file(native)?).map_err(|_| Outcome::InvalidOutput)?;
    let source = pcm(args, &args.source)?;
    let samples = source.len() as u64 / (u64::from(info.channel_count) * 4);
    if info.total_samples.is_some_and(|total| total != samples) {
        return Err(Outcome::InvalidOutput);
    }
    report["pcm_comparison"] = json!({"representation":"interleaved signed little-endian s32, original precision MSB-aligned; complete EOF and exact sample count",
        "source_samples_per_channel":samples,"sample_rate_hz":info.sample_rate_hz,
        "channels":info.channel_count,"bits_per_sample":info.bits_per_sample,"pcm_byte_bound":MAX_PCM_BYTES,
        "decoder_command":{"program":"FFMPEG_PREFIX/bin/ffmpeg","input":"same read-only descriptor/discovery restrictions","output_arguments":PCM_OUTPUT},
        "checking_depth":"full diagnostic decode, small bounded input/output; sample values never serialized"});
    let pure = directory.join("pure-rust.flac");
    let pure_result = normalize_media(&MediaNormalizeRequest {
        schema_version: 1,
        source: args.source.clone(),
        destination: pure.clone(),
        expected_kind: ExpectedMediaKind::Audio,
    });
    let mut paths = vec![("companion", native), ("reference", reference)];
    match pure_result {
        Ok(_) => {
            report["pure_rust"] = json!({"outcome":"success","observations":observations(probe, &pure, ExpectedMediaKind::Audio),
                "metadata_policy":"existing writer: fLaC + last STREAMINFO + frames, no comments/padding; unchanged implementation"});
            let (input, _) = bounded_content(args, &args.source)?;
            let (output, diagnostics) = bounded_content(args, &pure)?;
            let check = content::compare(&input, &output);
            report["pure_rust"]["encoded_comparison"] = json!(check);
            if !check.matches || diagnostics {
                return Err(Outcome::InvalidOutput);
            }
            paths.push(("pure_rust", &pure));
        }
        Err(e) => {
            report["pure_rust"] = json!({"outcome":"not_comparable", "reason":e.kind,
                "scope":"existing Pure Rust support only; no implementation change or fallback"});
            use bilikara_runtime::MediaErrorKind;
            if matches!(
                e.kind,
                MediaErrorKind::Io
                    | MediaErrorKind::SourceMissing
                    | MediaErrorKind::DestinationExists
                    | MediaErrorKind::InvalidRequest
            ) {
                return Err(Outcome::from(e.kind));
            }
        }
    }
    for (name, path) in paths {
        let output_info =
            FlacStreamInfo::read(&mut file(path)?).map_err(|_| Outcome::InvalidOutput)?;
        let equal = pcm_equal(&source, &pcm(args, path)?, info.channel_count);
        report["pcm_comparison"][name] =
            json!({"complete_pcm_equal":equal,"streaminfo":output_info});
        if !equal || info != output_info {
            return Err(Outcome::InvalidOutput);
        }
        // Existing independent decoder has a narrower format envelope. This
        // diagnostic profile's demonstrated 16/24-bit fixtures are supported.
        let decoded = independent(path, &source, &info)?;
        if let Some(decoded) = decoded {
            report["pcm_comparison"][name]["claxon"] =
                json!({"complete_pcm_equal":true,"samples_per_channel":decoded});
            if decoded != samples {
                return Err(Outcome::InvalidOutput);
            }
        } else {
            report["pcm_comparison"][name]["claxon"] =
                json!({"outcome":"not_comparable", "reason":"existing_claxon_decoder_limit"});
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn full_pcm_comparator_rejects_one_bit_missing_sample_and_channel_swap() {
        let a: Vec<u8> = [0x12345600i32, -0x65432100, 256, -512]
            .into_iter()
            .flat_map(i32::to_le_bytes)
            .collect();
        assert!(pcm_equal(&a, &a, 2));
        let mut b = a.clone();
        b[1] ^= 1;
        assert!(!pcm_equal(&a, &b, 2));
        assert!(!pcm_equal(&a, &a[..a.len() - 4], 2));
        let mut b = a.clone();
        b[..4].copy_from_slice(&a[4..8]);
        b[4..8].copy_from_slice(&a[..4]);
        assert!(!pcm_equal(&a, &b, 2));
    }
}
