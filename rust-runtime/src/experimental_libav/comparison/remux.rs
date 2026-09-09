//! Bounded developer-only encoded-content comparison. Raw bytes live only in
//! memory, are not Serialize, and never appear in findings or persistent logs.
use super::Outcome;
use crate::experimental_libav::TimeBase;
use serde::Serialize;
use serde_json::Value;

pub const MAX_MEDIA_BYTES: u64 = 4 * 1024 * 1024;
pub const MAX_CONTENT_JSON: usize = 24 * 1024 * 1024;
pub const MAX_PACKETS: usize = 256;

#[derive(Clone)]
pub struct EncodedSample {
    base: TimeBase,
    aac: bool,
    flac: bool,
    config: Vec<u8>,
    packets: Vec<Packet>,
}
#[derive(Clone)]
struct Packet {
    pts: Option<i64>,
    dts: Option<i64>,
    duration: Option<i64>,
    payload: Vec<u8>,
    skip_samples: Option<[u64; 4]>,
}

fn integer(value: Option<&Value>) -> Result<Option<i64>, Outcome> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s == "N/A" => Ok(None),
        Some(Value::String(s)) => s.parse().map(Some).map_err(|_| Outcome::InvalidOutput),
        Some(v) => v.as_i64().map(Some).ok_or(Outcome::InvalidOutput),
    }
}
fn hex_data(value: Option<&Value>) -> Result<Vec<u8>, Outcome> {
    let data = value
        .and_then(Value::as_str)
        .ok_or(Outcome::InvalidOutput)?;
    let mut bytes = Vec::new();
    for line in data.lines().filter(|line| !line.trim().is_empty()) {
        let (offset, rest) = line.trim().split_once(':').ok_or(Outcome::InvalidOutput)?;
        if usize::from_str_radix(offset, 16).ok() != Some(bytes.len()) {
            return Err(Outcome::InvalidOutput);
        }
        let hex = rest
            .trim_start()
            .split("  ")
            .next()
            .ok_or(Outcome::InvalidOutput)?;
        for group in hex.split_ascii_whitespace() {
            if group.len() % 2 != 0 || !group.is_ascii() {
                return Err(Outcome::InvalidOutput);
            }
            for i in (0..group.len()).step_by(2) {
                bytes.push(
                    u8::from_str_radix(&group[i..i + 2], 16).map_err(|_| Outcome::InvalidOutput)?,
                );
            }
        }
        if bytes.len() as u64 > MAX_MEDIA_BYTES {
            return Err(Outcome::InvalidOutput);
        }
    }
    Ok(bytes)
}

/// Only consume allowlisted ffprobe stream/packet fields; paths/tags/stderr
/// are neither part of this adapter nor returned in errors.
pub fn parse(bytes: &[u8]) -> Result<EncodedSample, Outcome> {
    if bytes.len() > MAX_CONTENT_JSON {
        return Err(Outcome::InvalidOutput);
    }
    let value: Value = serde_json::from_slice(bytes).map_err(|_| Outcome::InvalidOutput)?;
    let streams = value["streams"].as_array().ok_or(Outcome::InvalidOutput)?;
    if streams.len() != 1 || streams[0]["index"].as_u64() != Some(0) {
        return Err(Outcome::InvalidOutput);
    }
    let (num, den) = streams[0]["time_base"]
        .as_str()
        .and_then(|s| s.split_once('/'))
        .ok_or(Outcome::InvalidOutput)?;
    let base = TimeBase {
        numerator: num.parse().map_err(|_| Outcome::InvalidOutput)?,
        denominator: den.parse().map_err(|_| Outcome::InvalidOutput)?,
    };
    if base.numerator <= 0 || base.denominator <= 0 {
        return Err(Outcome::InvalidOutput);
    }
    let config = hex_data(streams[0].get("extradata"))?;
    if config.is_empty() {
        return Err(Outcome::InvalidOutput);
    }
    let rows = value["packets"].as_array().ok_or(Outcome::InvalidOutput)?;
    if rows.is_empty() || rows.len() > MAX_PACKETS {
        return Err(Outcome::InvalidOutput);
    }
    let mut packets = Vec::new();
    let mut total = config.len();
    for p in rows {
        if p["stream_index"].as_u64() != Some(0) {
            return Err(Outcome::InvalidOutput);
        }
        let payload = hex_data(p.get("data"))?;
        if integer(p.get("size"))? != Some(payload.len() as i64) {
            return Err(Outcome::InvalidOutput);
        }
        total += payload.len();
        if total as u64 > MAX_MEDIA_BYTES {
            return Err(Outcome::InvalidOutput);
        }
        let mut skip_samples = None;
        if let Some(side) = p.get("side_data_list") {
            for s in side.as_array().ok_or(Outcome::InvalidOutput)? {
                // This profile's demux-visible per-packet timing side data.
                // Other side data is not claimed as independently compared.
                if s["side_data_type"].as_str() == Some("Skip Samples") {
                    let mut values = [0; 4];
                    for (i, key) in [
                        "skip_samples",
                        "discard_padding",
                        "skip_reason",
                        "discard_reason",
                    ]
                    .iter()
                    .enumerate()
                    {
                        values[i] = integer(s.get(key))?
                            .and_then(|v| u64::try_from(v).ok())
                            .ok_or(Outcome::InvalidOutput)?;
                    }
                    if skip_samples.replace(values).is_some() {
                        return Err(Outcome::InvalidOutput);
                    }
                }
            }
        }
        packets.push(Packet {
            pts: integer(p.get("pts"))?,
            dts: integer(p.get("dts"))?,
            duration: integer(p.get("duration"))?,
            payload,
            skip_samples,
        });
    }
    Ok(EncodedSample {
        base,
        aac: streams[0]["codec_name"].as_str() == Some("aac"),
        flac: streams[0]["codec_name"].as_str() == Some("flac"),
        config,
        packets,
    })
}

#[derive(Debug, Serialize)]
pub struct ContentComparison {
    pub matches: bool,
    pub mismatches: Vec<&'static str>,
    pub packets_left: usize,
    pub packets_right: usize,
    pub configuration_bytes_left: usize,
    pub configuration_bytes_right: usize,
    pub rescaled_timestamp_values: usize,
    pub max_rounding_us: f64,
    pub representations: Vec<&'static str>,
    pub checking_depth: &'static str,
}

pub fn compare(a: &EncodedSample, b: &EncodedSample) -> ContentComparison {
    let mut result = ContentComparison {
        matches: true,
        mismatches: Vec::new(),
        packets_left: a.packets.len(),
        packets_right: b.packets.len(),
        configuration_bytes_left: a.config.len(),
        configuration_bytes_right: b.config.len(),
        rescaled_timestamp_values: 0,
        max_rounding_us: 0.0,
        representations: Vec::new(),
        checking_depth: "bounded ordered demuxed payloads + full extradata + every PTS/DTS/duration + skip-samples; shared libav, no independent decode",
    };
    let mut mismatch = |field| {
        if !result.mismatches.contains(&field) {
            result.mismatches.push(field);
        }
    };
    if a.config != b.config {
        mismatch("decoder_configuration");
    }
    if a.flac && b.flac {
        // Raw FLAC and MOV can group the same encoded frames differently.
        // Ignore container PTS and compare the ordered byte sequence directly.
        if !a
            .packets
            .iter()
            .flat_map(|p| &p.payload)
            .eq(b.packets.iter().flat_map(|p| &p.payload))
        {
            mismatch("ordered_encoded_frames");
        }
        result
            .representations
            .push("FLAC_sample_sequence_not_container_timeline_or_packet_count");
        result.checking_depth = "bounded ordered encoded bytes + complete STREAMINFO; PCM and independent decode are separate diagnostic oracles";
        result.matches = result.mismatches.is_empty();
        return result;
    }
    if a.packets.len() != b.packets.len() {
        mismatch("packet_count");
    }
    for (index, (a_packet, b_packet)) in a.packets.iter().zip(&b.packets).enumerate() {
        if a_packet.payload != b_packet.payload {
            mismatch("ordered_packet_payload");
        }
        if a_packet.skip_samples != b_packet.skip_samples {
            if index + 1 == a.packets.len()
                && a.packets.len() == b.packets.len()
                && equivalent_final_padding(a, a_packet, b, b_packet)
            {
                result.representations.push(
                    "aac_lc_final_discard_padding_equals_frame_samples_minus_packet_duration",
                );
            } else {
                mismatch("skip_samples");
            }
        }
        for (field, left, right) in [
            ("pts", a_packet.pts, b_packet.pts),
            ("dts", a_packet.dts, b_packet.dts),
            ("duration", a_packet.duration, b_packet.duration),
        ] {
            match (left, right) {
                (None, None) => {
                    mismatch("unknown_timing_not_established");
                }
                (Some(l), Some(r)) if l != i64::MIN && r != i64::MIN => {
                    // Exact expected rescale to the actual destination time
                    // base, nearest/ties away. No broad timing tolerance.
                    let num = i128::from(l)
                        * i128::from(a.base.numerator)
                        * i128::from(b.base.denominator);
                    let den = i128::from(a.base.denominator) * i128::from(b.base.numerator);
                    let expected = (num + if num < 0 { -den / 2 } else { den / 2 }) / den;
                    if expected != i128::from(r) {
                        mismatch(field);
                    }
                    let delta = num - i128::from(r) * den;
                    if delta != 0 && expected == i128::from(r) {
                        result.rescaled_timestamp_values += 1;
                        let delta_us = (delta.abs() as f64 * 1_000_000.0)
                            / (f64::from(a.base.denominator) * f64::from(b.base.denominator));
                        result.max_rounding_us = result.max_rounding_us.max(delta_us);
                    }
                }
                _ => mismatch(field),
            }
        }
    }
    result.matches = result.mismatches.is_empty();
    result
}

// Pinned mov.c exports terminal AAC-LC partial-frame duration as discard
// padding for ordinary MP4, while a fragmented input can expose only duration.
// Admit exactly that measured representation: no content or timing tolerance,
// no inference for HE-AAC/explicit frequency/other ASC forms. Config is still
// compared byte-for-byte in full (this never reconstructs or writes an ASC).
fn equivalent_final_padding(
    a: &EncodedSample,
    left: &Packet,
    b: &EncodedSample,
    right: &Packet,
) -> bool {
    if !a.aac || !b.aac || a.config != b.config || a.config.len() < 2 || a.config[0] >> 3 != 2 {
        return false;
    }
    let rate_index = ((a.config[0] & 7) << 1 | (a.config[1] >> 7)) as usize;
    let rates = [
        96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
    ];
    let Some(&rate) = rates.get(rate_index) else {
        return false;
    };
    let frame = if a.config[1] & 4 == 0 { 1024 } else { 960 };
    let samples = |p: &Packet, base: TimeBase| {
        p.duration.and_then(|d| {
            let num = i128::from(d) * i128::from(base.numerator) * i128::from(rate);
            (num > 0 && num % i128::from(base.denominator) == 0)
                .then_some(num / i128::from(base.denominator))
        })
    };
    let Some(duration) = samples(left, a.base) else {
        return false;
    };
    if duration >= frame || samples(right, b.base) != Some(duration) {
        return false;
    }
    let padding = Some([0, (frame - duration) as u64, 0, 0]);
    (left.skip_samples.is_none() && right.skip_samples == padding)
        || (right.skip_samples.is_none() && left.skip_samples == padding)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample() -> EncodedSample {
        EncodedSample {
            base: TimeBase {
                numerator: 1,
                denominator: 48000,
            },
            aac: true,
            flac: false,
            config: vec![0x2b, 0x11, 0x88, 0],
            packets: vec![
                Packet {
                    pts: Some(-1024),
                    dts: Some(-1024),
                    duration: Some(1024),
                    payload: vec![1, 2, 3],
                    skip_samples: Some([1024, 0, 0, 0]),
                },
                Packet {
                    pts: Some(0),
                    dts: Some(0),
                    duration: Some(1024),
                    payload: vec![4, 5, 6],
                    skip_samples: None,
                },
            ],
        }
    }
    #[test]
    fn flac_packet_grouping_and_container_pts_are_not_audio_equivalence_rules() {
        let mut a = sample();
        a.aac = false;
        a.flac = true;
        let mut b = a.clone();
        let tail = b.packets.pop().unwrap();
        b.packets[0].payload.extend(tail.payload);
        b.packets[0].pts = Some(123);
        assert!(compare(&a, &b).matches);
        b.packets[0].payload[4] ^= 1;
        assert!(
            compare(&a, &b)
                .mismatches
                .contains(&"ordered_encoded_frames")
        );
    }
    #[test]
    fn negative_controls_cannot_pass_on_counts_and_metadata_alone() {
        let a = sample();
        assert!(compare(&a, &a).matches);
        for field in [
            "packet_count",
            "decoder_configuration",
            "ordered_packet_payload",
            "pts",
            "skip_samples",
        ] {
            let mut b = a.clone();
            match field {
                "packet_count" => {
                    b.packets.pop();
                }
                "decoder_configuration" => {
                    b.config.truncate(2);
                }
                "ordered_packet_payload" => b.packets[0].payload[0] ^= 1,
                "pts" => b.packets[0].pts = Some(-1023),
                _ => b.packets[0].skip_samples = None,
            }
            let result = compare(&a, &b);
            assert!(!result.matches && result.mismatches.contains(&field));
            let report = serde_json::to_string(&result).unwrap();
            assert!(!report.contains("payload\":") && !report.contains("config\":"));
        }
    }
    #[test]
    fn unknown_is_not_zero_and_rational_rescale_is_exact() {
        let a = sample();
        let mut b = a.clone();
        b.base.denominator *= 2;
        for p in &mut b.packets {
            p.pts = p.pts.map(|v| v * 2);
            p.dts = p.dts.map(|v| v * 2);
            p.duration = p.duration.map(|v| v * 2);
        }
        assert!(compare(&a, &b).matches);
        b = a.clone();
        b.packets[1].pts = None;
        assert!(!compare(&a, &b).matches);
        assert!(!compare(&b, &b).matches);
        assert_eq!(
            hex_data(Some(&Value::String(
                "\n00000000: 2b11 8800                                +...\n".into()
            )))
            .unwrap(),
            a.config
        );
        assert!(parse(b"{\"streams\":[]}").is_err());
    }

    #[test]
    fn final_padding_representation_requires_exact_lc_duration_and_padding() {
        let mut a = sample();
        a.config = vec![0x12, 0x08, 0x56, 0xe5, 0]; // full existing AAC-LC ASC
        a.base.denominator = 44100;
        a.packets.last_mut().unwrap().duration = Some(136);
        let mut b = a.clone();
        b.packets.last_mut().unwrap().skip_samples = Some([0, 888, 0, 0]);
        let good = compare(&a, &b);
        assert!(good.matches && good.representations.len() == 1);
        b.packets.last_mut().unwrap().skip_samples = Some([0, 889, 0, 0]);
        assert!(!compare(&a, &b).matches);
        b.packets.last_mut().unwrap().skip_samples = Some([1, 888, 0, 0]);
        assert!(!compare(&a, &b).matches);
        b.packets.last_mut().unwrap().skip_samples = Some([0, 888, 0, 0]);
        b.packets.last_mut().unwrap().duration = Some(135);
        assert!(!compare(&a, &b).matches);
    }
}
