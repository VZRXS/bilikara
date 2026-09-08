//! M2 allowlisted metadata comparison. No I/O, routing, state or fallback.
//! A successful enumeration is never a media acceptance/validation result.
use super::{BackendInfo, Metadata, ProbeError, StreamType, TimeBase};
use crate::{ExpectedMediaKind, MediaErrorKind, MediaProbe};
use serde::Serialize;
use serde_json::{Value, json};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Success,
    Unavailable,
    Cancelled,
    Timeout,
    ExecutionError,
    InvalidOutput,
    InvalidRequest,
    SourceMissing,
    UnsupportedFormat,
    UnsupportedCodec,
    UnsupportedContainerLayout,
    MediaContractViolation,
    InvalidMedia,
    Io,
}
impl From<&ProbeError> for Outcome {
    fn from(error: &ProbeError) -> Self {
        match error {
            ProbeError::Unavailable(_) => Self::Unavailable,
            ProbeError::Cancelled => Self::Cancelled,
            ProbeError::UnsupportedFormat(_) => Self::UnsupportedFormat,
            ProbeError::BackendFailure(_) => Self::ExecutionError,
            ProbeError::Media(error) => error.kind.into(),
        }
    }
}
impl From<MediaErrorKind> for Outcome {
    fn from(kind: MediaErrorKind) -> Self {
        match kind {
            MediaErrorKind::InvalidRequest | MediaErrorKind::DestinationExists => {
                Self::InvalidRequest
            }
            MediaErrorKind::SourceMissing => Self::SourceMissing,
            MediaErrorKind::UnsupportedCodec => Self::UnsupportedCodec,
            MediaErrorKind::UnsupportedContainerLayout => Self::UnsupportedContainerLayout,
            MediaErrorKind::MediaContractViolation => Self::MediaContractViolation,
            MediaErrorKind::InvalidMedia => Self::InvalidMedia,
            MediaErrorKind::Io => Self::Io,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Observation {
    pub outcome: Outcome,
    pub metadata: Option<Metadata>,
    /// Only the numeric structured error is retained; never stderr/message text.
    pub reference_error_code: Option<i64>,
}
impl Observation {
    pub fn error(outcome: Outcome) -> Self {
        Self {
            outcome,
            metadata: None,
            reference_error_code: None,
        }
    }
    pub fn libav(result: Result<Metadata, ProbeError>) -> Self {
        match result {
            Ok(metadata) => match normalize(metadata) {
                Ok(metadata) => Self {
                    outcome: Outcome::Success,
                    metadata: Some(metadata),
                    reference_error_code: None,
                },
                Err(error) => Self::error(error),
            },
            Err(error) => Self::error(Outcome::from(&error)),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    MatchingComparableMetadata,
    SemanticMismatch,
    DepthOrContractDifference,
    Advisory,
    BackendOrReferenceError,
    PotentialSafetyMismatch,
    NotComparable,
}
#[derive(Debug, Serialize)]
pub struct FieldComparison {
    pub field: String,
    pub left: Value,
    pub right: Value,
    pub kind: Kind,
    pub reason: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tolerance_us: Option<i64>,
}
#[derive(Debug, Serialize)]
pub struct Comparison {
    pub kinds: Vec<Kind>,
    pub fields: Vec<FieldComparison>,
}
impl Comparison {
    fn new() -> Self {
        Self {
            kinds: vec![],
            fields: vec![],
        }
    }
    fn add(&mut self, field: &str, left: Value, right: Value, kind: Kind, reason: &'static str) {
        if kind != Kind::NotComparable && !self.kinds.contains(&kind) {
            self.kinds.push(kind);
        }
        self.fields.push(FieldComparison {
            field: field.into(),
            left,
            right,
            kind,
            reason,
            tolerance_us: None,
        });
    }
    fn field(
        &mut self,
        name: &str,
        left: Value,
        right: Value,
        tolerance: Option<i64>,
        advisory: bool,
    ) {
        let (kind, reason) = if left.is_null() && right.is_null() {
            (Kind::NotComparable, "both unknown; no equality evidence")
        } else if left.is_null() || right.is_null() {
            (Kind::Advisory, "known versus unknown; no value substituted")
        } else if left == right
            || tolerance.is_some_and(|t| {
                left.as_i64()
                    .zip(right.as_i64())
                    .is_some_and(|(a, b)| (i128::from(a) - i128::from(b)).abs() <= i128::from(t))
            })
        {
            (
                Kind::MatchingComparableMetadata,
                if tolerance == Some(0) {
                    "container timestamps already use integer microseconds; six-decimal reference preserves that unit"
                } else if tolerance.is_some() {
                    "nearest microsecond versus six-decimal CLI rounding; at most 1 us"
                } else {
                    "equal known metadata"
                },
            )
        } else if advisory {
            (
                Kind::Advisory,
                "bitrate is an estimate; difference is not an integrity failure",
            )
        } else {
            (
                Kind::SemanticMismatch,
                "different known values under the same metadata contract",
            )
        };
        self.add(name, left, right, kind, reason);
        self.fields.last_mut().unwrap().tolerance_us = tolerance;
    }
    pub fn needs_analysis(&self) -> bool {
        self.kinds.iter().any(|k| {
            matches!(
                k,
                Kind::SemanticMismatch
                    | Kind::PotentialSafetyMismatch
                    | Kind::BackendOrReferenceError
            )
        })
    }
}

/// No expansive alias/codec registry: only the names of M1's MOV family.
fn container(name: &str) -> Option<&str> {
    match name {
        "mov,mp4,m4a,3gp,3g2,mj2" | "mov" | "mp4" | "m4a" => Some("mov_mp4"),
        "mov_mp4" | "flac" => Some(name),
        _ => None,
    }
}
fn token(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}
fn rational(mut base: TimeBase) -> Result<TimeBase, Outcome> {
    if base.numerator <= 0 || base.denominator <= 0 {
        return Err(Outcome::InvalidOutput);
    }
    let (mut a, mut b) = (base.numerator, base.denominator);
    while b != 0 {
        (a, b) = (b, a % b);
    }
    base.numerator /= a;
    base.denominator /= a;
    Ok(base)
}
fn normalize(mut metadata: Metadata) -> Result<Metadata, Outcome> {
    metadata.container = container(&metadata.container)
        .ok_or(Outcome::InvalidOutput)?
        .into();
    if metadata.streams.is_empty() || metadata.streams.len() > 32 {
        return Err(Outcome::InvalidOutput);
    }
    for (i, stream) in metadata.streams.iter().enumerate() {
        if metadata.streams[..i]
            .iter()
            .any(|s| s.index == stream.index)
            || stream.codec_name.as_deref().is_some_and(|s| !token(s))
        {
            return Err(Outcome::InvalidOutput);
        }
    }
    for stream in &mut metadata.streams {
        stream.time_base = stream.time_base.map(rational).transpose()?;
    }
    // Backend identity is project-owned, never arbitrary text from the input.
    if metadata.backend != "bilikara_media_libav" && metadata.backend != "ffprobe" {
        return Err(Outcome::InvalidOutput);
    }
    Ok(metadata)
}

/// Compare complete inventories by actual index; never zip/sort/select a track.
pub fn compare(left: &Observation, right: &Observation, same_build: bool) -> Comparison {
    let mut result = Comparison::new();
    if !same_build {
        result.add(
            "same_build",
            json!(false),
            json!(false),
            Kind::BackendOrReferenceError,
            "same-build identity was not established; no parity claim",
        );
        return result;
    }
    let observations = (left.outcome, right.outcome, &left.metadata, &right.metadata);
    let (Outcome::Success, Outcome::Success, Some(a), Some(b)) = observations else {
        result.add(
            "operation_outcome",
            json!(left.outcome),
            json!(right.outcome),
            Kind::BackendOrReferenceError,
            "enumeration failed or was unavailable; even matching errors are not successful parity",
        );
        if (left.outcome == Outcome::Success
            && matches!(
                right.outcome,
                Outcome::InvalidMedia | Outcome::MediaContractViolation
            ))
            || (right.outcome == Outcome::Success
                && matches!(
                    left.outcome,
                    Outcome::InvalidMedia | Outcome::MediaContractViolation
                ))
        {
            result.add("enumeration_rejection", json!(left.outcome), json!(right.outcome), Kind::SemanticMismatch, "same metadata operation disagrees on rejection; investigate discovery/options, not proof of validation bypass");
        }
        return result;
    };
    result.field(
        "container.family",
        json!(a.container),
        json!(b.container),
        None,
        false,
    );
    result.field(
        "container.duration_us",
        json!(a.duration_us),
        json!(b.duration_us),
        Some(0),
        false,
    );
    result.field(
        "container.start_time_us",
        json!(a.start_time_us),
        json!(b.start_time_us),
        Some(0),
        false,
    );
    result.field(
        "container.bit_rate_bps",
        json!(a.bit_rate_bps),
        json!(b.bit_rate_bps),
        None,
        true,
    );
    result.field(
        "stream_count",
        json!(a.streams.len()),
        json!(b.streams.len()),
        None,
        false,
    );
    for stream in &a.streams {
        let name = format!("streams[{}]", stream.index);
        let Some(other) = b.streams.iter().find(|s| s.index == stream.index) else {
            result.add(
                &name,
                json!({"index":stream.index,"type":stream.media_type}),
                Value::Null,
                Kind::SemanticMismatch,
                "stream index missing from reference inventory",
            );
            continue;
        };
        result.field(
            &format!("{name}.type"),
            json!(stream.media_type),
            json!(other.media_type),
            None,
            false,
        );
        if stream.media_type != other.media_type {
            result.add(
                &format!("{name}.fields"),
                Value::Null,
                Value::Null,
                Kind::NotComparable,
                "same index has different type; do not pair unrelated stream fields",
            );
            continue;
        }
        macro_rules! field {
            ($member:ident, $tol:expr, $advisory:expr) => {
                result.field(
                    &format!("{name}.{}", stringify!($member)),
                    json!(stream.$member),
                    json!(other.$member),
                    $tol,
                    $advisory,
                );
            };
        }
        field!(codec_name, None, false);
        field!(time_base, None, false);
        field!(duration_us, Some(1), false);
        field!(start_time_us, Some(1), false);
        field!(width_px, None, false);
        field!(height_px, None, false);
        field!(sample_rate_hz, None, false);
        field!(channel_count, None, false);
        field!(raw_bit_depth, None, false);
        field!(bit_rate_bps, None, true);
    }
    for stream in &b.streams {
        if !a.streams.iter().any(|s| s.index == stream.index) {
            result.add(
                &format!("streams[{}]", stream.index),
                Value::Null,
                json!({"index":stream.index,"type":stream.media_type}),
                Kind::SemanticMismatch,
                "extra stream index in reference inventory",
            );
        }
    }
    result
}

#[derive(Debug, Serialize)]
pub struct PureObservation {
    pub outcome: Outcome,
    pub expected_kind: ExpectedMediaKind,
    pub requested_stream_contract_satisfied: Option<bool>,
    pub codec: Option<String>,
    /// Existing probe's maximum sample decode end, NOT AVStream duration.
    pub sample_end_us: Option<i64>,
}
impl PureObservation {
    pub fn new(expected_kind: ExpectedMediaKind, result: Result<MediaProbe, Outcome>) -> Self {
        match result {
            Ok(p)
                if token(&p.codec)
                    && p.duration_seconds.is_finite()
                    && p.duration_seconds >= 0.0
                    && p.duration_seconds * 1e6 < i64::MAX as f64 =>
            {
                Self {
                    outcome: Outcome::Success,
                    expected_kind,
                    requested_stream_contract_satisfied: Some(true),
                    codec: Some(p.codec),
                    sample_end_us: Some((p.duration_seconds * 1e6).round() as i64),
                }
            }
            Ok(_) => Self::new(expected_kind, Err(Outcome::InvalidOutput)),
            Err(outcome) => Self {
                outcome,
                expected_kind,
                requested_stream_contract_satisfied: (outcome == Outcome::MediaContractViolation)
                    .then_some(false),
                codec: None,
                sample_end_us: None,
            },
        }
    }
}

pub fn compare_pure(libav: &Observation, pure: &PureObservation) -> Comparison {
    let mut result = Comparison::new();
    let Some(metadata) = &libav.metadata else {
        result.add(
            "operation_outcome",
            json!(libav.outcome),
            json!(pure.outcome),
            Kind::BackendOrReferenceError,
            "libav enumeration unavailable; no shared metadata comparison",
        );
        return result;
    };
    let expected = match pure.expected_kind {
        ExpectedMediaKind::Video => StreamType::Video,
        ExpectedMediaKind::Audio => StreamType::Audio,
    };
    let contract = metadata.container == "mov_mp4"
        && metadata.streams.len() == 1
        && metadata.streams[0].media_type == expected;
    if pure.outcome != Outcome::Success {
        let (kind, why) = match pure.outcome {
            Outcome::MediaContractViolation if !contract => (
                Kind::DepthOrContractDifference,
                "metadata enumeration accepts multiple/wrong-kind streams; Pure Rust requires exactly one requested MP4 track",
            ),
            Outcome::InvalidMedia if metadata.container == "flac" => (
                Kind::DepthOrContractDifference,
                "raw FLAC is outside the existing Pure Rust MP4 input contract; original rejection retained",
            ),
            Outcome::InvalidMedia => (
                Kind::DepthOrContractDifference,
                "Pure Rust sample/structure inspection rejected the input; stream metadata discovery does not certify that deeper contract",
            ),
            Outcome::UnsupportedCodec | Outcome::UnsupportedContainerLayout => (
                Kind::DepthOrContractDifference,
                "existing operation capability limit; no routing/fallback follows",
            ),
            Outcome::MediaContractViolation => (
                Kind::SemanticMismatch,
                "unexpected contract rejection for an enumerated single requested MP4 track; analyze the retained rejection",
            ),
            _ => (
                Kind::BackendOrReferenceError,
                "explicit Pure Rust operation error; no parity inferred",
            ),
        };
        result.add(
            "operation_outcome",
            json!(libav.outcome),
            json!(pure.outcome),
            kind,
            why,
        );
        return result;
    }
    if !contract {
        result.add("single_track_contract", json!({"container":metadata.container,"streams":metadata.streams.iter().map(|s| json!({"index":s.index,"type":s.media_type})).collect::<Vec<_>>()}), json!(pure.outcome), Kind::PotentialSafetyMismatch, "Pure Rust accepted a file whose observed inventory violates its requested MP4 single-track contract; investigate");
        return result;
    }
    let stream = &metadata.streams[0];
    result.add("stream_identity", json!(stream.index), Value::Null, Kind::NotComparable, "Pure Rust exposes no stream index; association is justified only by its successful exactly-one-track contract");
    result.field(
        "stream.type",
        json!(stream.media_type),
        json!(expected),
        None,
        false,
    );
    result.field(
        "stream.codec_name",
        json!(stream.codec_name),
        json!(pure.codec),
        None,
        false,
    );
    result.add("stream.duration_us_vs_sample_end_us", json!(stream.duration_us), json!(pure.sample_end_us), Kind::DepthOrContractDifference, "AVStream presentation duration versus maximum sample decode end; edit lists/start offsets are not exposed by Pure Rust, so no equal-timeline claim");
    result.add("other_metadata", Value::Null, Value::Null, Kind::NotComparable, "Pure Rust result exposes no dimensions/rate/channels/bit depth/time base/start/container duration/bitrate; no invented values");
    result
}

/// Safe configuration evidence: exact raw equality is checked in memory below.
/// Only these fixed flag names survive serialization; paths/values never do.
#[derive(Debug, Serialize)]
pub struct Identity {
    pub backend: &'static str,
    pub version: String,
    pub library_versions_format_codec_util: [u32; 3],
    pub configuration_flags: Vec<&'static str>,
    pub omitted_configuration_tokens: usize,
}
const FLAGS: &[&str] = &[
    "--disable-autodetect",
    "--disable-debug",
    "--disable-doc",
    "--disable-ffplay",
    "--disable-static",
    "--enable-shared",
    "--disable-x86asm",
    "--disable-avdevice",
    "--disable-swscale",
    "--enable-swresample",
    "--disable-network",
];
fn identity(
    backend: &'static str,
    version: &str,
    libraries: [u32; 3],
    config: &str,
) -> Result<Identity, Outcome> {
    if version.len() > 32 || !version.bytes().all(|b| b.is_ascii_digit() || b == b'.') {
        return Err(Outcome::InvalidOutput);
    }
    let configuration_flags: Vec<_> = FLAGS
        .iter()
        .copied()
        .filter(|flag| config.split_whitespace().any(|s| s == *flag))
        .collect();
    let omitted_configuration_tokens = config
        .split_whitespace()
        .filter(|s| !FLAGS.contains(s))
        .count();
    Ok(Identity {
        backend,
        version: version.into(),
        library_versions_format_codec_util: libraries,
        configuration_flags,
        omitted_configuration_tokens,
    })
}
pub fn libav_identity(info: &BackendInfo) -> Result<Identity, Outcome> {
    identity(
        "bilikara_media_libav",
        &info.runtime_version,
        info.runtime_library_versions,
        &info.build_configuration,
    )
}

/// CLI version adapter; private configuration is intentionally not Serialize.
pub struct ReferenceBuild {
    version: String,
    libraries: [u32; 3],
    configuration: String,
}
#[derive(Debug, Serialize)]
pub struct BuildChecks {
    pub source_version: bool,
    pub build_and_runtime_library_versions: bool,
    pub exact_configuration: bool,
}
impl ReferenceBuild {
    pub fn parse(bytes: &[u8]) -> Result<Self, Outcome> {
        let value: Value = serde_json::from_slice(bytes).map_err(|_| Outcome::InvalidOutput)?;
        let program = &value["program_version"];
        let version = program["version"]
            .as_str()
            .ok_or(Outcome::InvalidOutput)?
            .to_owned();
        let configuration = program["configuration"]
            .as_str()
            .filter(|v| v.len() <= 2048)
            .ok_or(Outcome::InvalidOutput)?
            .to_owned();
        let array = value["library_versions"]
            .as_array()
            .ok_or(Outcome::InvalidOutput)?;
        let mut libraries = [0; 3];
        for (i, name) in ["libavformat", "libavcodec", "libavutil"]
            .iter()
            .enumerate()
        {
            let found: Vec<_> = array
                .iter()
                .filter(|v| v["name"].as_str() == Some(name))
                .collect();
            if found.len() != 1 {
                return Err(Outcome::InvalidOutput);
            }
            libraries[i] = found[0]["version"]
                .as_u64()
                .and_then(|n| u32::try_from(n).ok())
                .ok_or(Outcome::InvalidOutput)?;
        }
        let result = Self {
            version,
            libraries,
            configuration,
        };
        result.identity()?;
        Ok(result)
    }
    pub fn matches(&self, info: &BackendInfo) -> bool {
        let checks = self.checks(info);
        checks.source_version
            && checks.build_and_runtime_library_versions
            && checks.exact_configuration
    }
    pub fn checks(&self, info: &BackendInfo) -> BuildChecks {
        BuildChecks {
            source_version: self.version == "9.0.1"
                && self.version == info.build_version
                && self.version == info.runtime_version,
            build_and_runtime_library_versions: self.libraries == info.build_library_versions
                && self.libraries == info.runtime_library_versions,
            exact_configuration: self.configuration == info.build_configuration
                && info
                    .runtime_configurations
                    .iter()
                    .all(|c| c == &self.configuration),
        }
    }
    pub fn identity(&self) -> Result<Identity, Outcome> {
        identity(
            "ffprobe",
            &self.version,
            self.libraries,
            &self.configuration,
        )
    }
}

// Narrow reference adapter. It never serializes the parsed JSON tree.
fn integer(value: &Value) -> Result<Option<i64>, Outcome> {
    match value {
        Value::Null => Ok(None),
        Value::String(s) if s == "N/A" => Ok(None),
        Value::String(s) => s.parse().map(Some).map_err(|_| Outcome::InvalidOutput),
        Value::Number(n) => n.as_i64().map(Some).ok_or(Outcome::InvalidOutput),
        _ => Err(Outcome::InvalidOutput),
    }
}
fn positive(value: &Value) -> Result<Option<u32>, Outcome> {
    integer(value)?
        .filter(|v| *v != 0)
        .map(|n| u32::try_from(n).map_err(|_| Outcome::InvalidOutput))
        .transpose()
}
fn bitrate(value: &Value) -> Result<Option<i64>, Outcome> {
    let n = integer(value)?.filter(|v| *v != 0);
    if n.is_some_and(|v| v < 0) {
        return Err(Outcome::InvalidOutput);
    }
    Ok(n)
}
/// ffprobe's six-decimal seconds -> exact microseconds, without f64 loss.
fn micros(value: &Value, duration: bool) -> Result<Option<i64>, Outcome> {
    if value.is_null() || value.as_str() == Some("N/A") {
        return Ok(None);
    }
    let s = value.as_str().ok_or(Outcome::InvalidOutput)?;
    let negative = s.starts_with('-');
    let s = s.strip_prefix('-').unwrap_or(s);
    let (whole, fraction) = s.split_once('.').unwrap_or((s, ""));
    if whole.is_empty()
        || fraction.len() > 6
        || !whole
            .bytes()
            .chain(fraction.bytes())
            .all(|b| b.is_ascii_digit())
    {
        return Err(Outcome::InvalidOutput);
    }
    let whole: i128 = whole.parse().map_err(|_| Outcome::InvalidOutput)?;
    let fraction: i128 = if fraction.is_empty() {
        0
    } else {
        fraction.parse().map_err(|_| Outcome::InvalidOutput)?
    };
    let n = whole
        .checked_mul(1_000_000)
        .and_then(|n| {
            n.checked_add(
                fraction * 10_i128.pow(6 - s.split_once('.').map_or(0, |(_, f)| f.len()) as u32),
            )
        })
        .ok_or(Outcome::InvalidOutput)?;
    let n = i64::try_from(if negative { -n } else { n }).map_err(|_| Outcome::InvalidOutput)?;
    if n == i64::MIN || (duration && n < 0) {
        return Err(Outcome::InvalidOutput);
    }
    Ok(Some(n))
}
pub fn reference_metadata(bytes: &[u8], exit_success: bool) -> Observation {
    let parse = || -> Result<Observation, Outcome> {
        let value: Value = serde_json::from_slice(bytes).map_err(|_| Outcome::InvalidOutput)?;
        if !value["error"].is_null() || !exit_success {
            let code = integer(&value["error"]["code"])?;
            // Pinned libav INVALIDDATA and EOF only. Generic exits/stderr never
            // become Unsupported or successful parity.
            let outcome = if matches!(code, Some(-1094995529 | -541478725)) {
                Outcome::InvalidMedia
            } else {
                Outcome::ExecutionError
            };
            return Ok(Observation {
                outcome,
                metadata: None,
                reference_error_code: code,
            });
        }
        let format = &value["format"];
        let mut metadata = Metadata {
            backend: "ffprobe".into(),
            inspection_level: super::InspectionLevel::StreamMetadata,
            container: format["format_name"]
                .as_str()
                .ok_or(Outcome::InvalidOutput)?
                .into(),
            duration_us: micros(&format["duration"], true)?,
            start_time_us: micros(&format["start_time"], false)?,
            bit_rate_bps: bitrate(&format["bit_rate"])?,
            streams: vec![],
        };
        let streams = value["streams"].as_array().ok_or(Outcome::InvalidOutput)?;
        if streams.is_empty() || streams.len() > 32 {
            return Err(Outcome::InvalidOutput);
        }
        for stream in streams {
            let media_type = match stream["codec_type"].as_str() {
                Some("video") => StreamType::Video,
                Some("audio") => StreamType::Audio,
                Some("subtitle") => StreamType::Subtitle,
                Some("data") => StreamType::Data,
                Some("attachment") => StreamType::Attachment,
                Some("unknown") | None => StreamType::Unknown,
                _ => return Err(Outcome::InvalidOutput),
            };
            let time_base = match stream["time_base"].as_str() {
                None | Some("N/A" | "0/0") => None,
                Some(s) => {
                    let (n, d) = s.split_once('/').ok_or(Outcome::InvalidOutput)?;
                    Some(rational(TimeBase {
                        numerator: n.parse().map_err(|_| Outcome::InvalidOutput)?,
                        denominator: d.parse().map_err(|_| Outcome::InvalidOutput)?,
                    })?)
                }
            };
            let codec_name = match &stream["codec_name"] {
                Value::Null => None,
                Value::String(s) if s == "unknown" || s == "N/A" => None,
                Value::String(s) if token(s) => Some(s.clone()),
                _ => return Err(Outcome::InvalidOutput),
            };
            metadata.streams.push(super::StreamMetadata {
                index: integer(&stream["index"])?
                    .and_then(|v| u32::try_from(v).ok())
                    .ok_or(Outcome::InvalidOutput)?,
                media_type,
                codec_name,
                duration_us: micros(&stream["duration"], true)?,
                start_time_us: micros(&stream["start_time"], false)?,
                time_base,
                width_px: positive(&stream["width"])?,
                height_px: positive(&stream["height"])?,
                sample_rate_hz: positive(&stream["sample_rate"])?,
                channel_count: positive(&stream["channels"])?,
                bit_rate_bps: bitrate(&stream["bit_rate"])?,
                raw_bit_depth: positive(&stream["bits_per_raw_sample"])?,
            });
        }
        Ok(Observation {
            outcome: Outcome::Success,
            metadata: Some(normalize(metadata)?),
            reference_error_code: None,
        })
    };
    parse().unwrap_or_else(Observation::error)
}

#[cfg(test)]
mod tests;
