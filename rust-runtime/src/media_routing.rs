//! Application media routing. The optional backend is a capability, independent
//! of mandatory AppState. No source selection, cache ownership, or retry loop.
use crate::experimental_libav::{CopyProfile, ProbeError};
use crate::media_backend::{self, MediaNormalizeRequest, MediaNormalizeResult, MediaPathRequest};
use crate::{ExpectedMediaKind, MediaError, MediaErrorKind, MediaProbe};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{
    OnceLock,
    atomic::{AtomicBool, Ordering},
};

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Mode {
    #[default]
    Default,
    Legacy,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Configuration {
    pub mode: Mode,
    /// Host-authorized same-build artifact; never inferred from PATH or CWD.
    pub companion: Option<PathBuf>,
}
static CONFIGURATION: OnceLock<Configuration> = OnceLock::new();

pub(crate) fn configure(config: Configuration) -> Result<bool, RouteError> {
    if config.companion.as_ref().is_some_and(|p| !p.is_absolute()) {
        return Err(error("invalid_request"));
    }
    let current = CONFIGURATION.get_or_init(|| config.clone());
    if current != &config {
        return Err(error("invalid_request"));
    }
    Ok(true)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Backend {
    Libav,
    PureRust,
    Ffprobe,
    Ffmpeg,
    Legacy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Reason {
    LegacyOverride,
    NotProvisioned,
    Unavailable,
    UnsupportedFormat,
    UnsupportedCodec,
    UnsupportedContainerLayout,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct Diagnostic {
    pub operation: &'static str,
    pub backend: Backend,
    pub outcome: &'static str,
    pub compatibility_reason: Option<Reason>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct RouteError {
    pub kind: &'static str,
    pub message: &'static str,
    pub diagnostic: Option<Diagnostic>,
}
fn error(kind: &'static str) -> RouteError {
    RouteError {
        kind,
        message: "application media operation failed",
        diagnostic: None,
    }
}
impl From<MediaError> for RouteError {
    fn from(e: MediaError) -> Self {
        error(e.kind.as_str())
    }
}
impl From<ProbeError> for RouteError {
    fn from(e: ProbeError) -> Self {
        match e {
            ProbeError::Media(e) => e.into(),
            ProbeError::Cancelled => error("cancelled"),
            ProbeError::Unavailable(_) => error("unavailable"),
            ProbeError::UnsupportedFormat(_) => error("unsupported_format"),
            ProbeError::BackendFailure(_) => error("backend_failure"),
        }
    }
}

/// Capability fallback and S3 re-download classification remain independent.
fn fallback_reason(e: &ProbeError) -> Option<Reason> {
    match e {
        ProbeError::Unavailable(_) => Some(Reason::Unavailable),
        ProbeError::UnsupportedFormat(_) => Some(Reason::UnsupportedFormat),
        ProbeError::Media(e) if e.kind.allows_backend_fallback() => match e.kind {
            MediaErrorKind::UnsupportedCodec => Some(Reason::UnsupportedCodec),
            MediaErrorKind::UnsupportedContainerLayout => Some(Reason::UnsupportedContainerLayout),
            _ => None,
        },
        _ => None,
    }
}

fn capability(config: &Configuration) -> Result<&Path, Reason> {
    if config.mode == Mode::Legacy {
        return Err(Reason::LegacyOverride);
    }
    if !cfg!(any(
        target_os = "linux",
        all(target_os = "windows", target_arch = "x86_64")
    )) {
        return Err(Reason::NotProvisioned);
    }
    config.companion.as_deref().ok_or(Reason::NotProvisioned)
}

fn diagnostic(operation: &'static str, backend: Backend, reason: Option<Reason>) -> Diagnostic {
    Diagnostic {
        operation,
        backend,
        outcome: "success",
        compatibility_reason: reason,
    }
}
fn failed(mut e: RouteError, mut d: Diagnostic) -> RouteError {
    d.outcome = "failed";
    e.diagnostic = Some(d);
    e
}
fn check_cancel(flag: &AtomicBool, poll: &dyn Fn() -> bool) -> Result<(), RouteError> {
    if poll() {
        flag.store(true, Ordering::Relaxed);
    }
    if flag.load(Ordering::Relaxed) {
        Err(error("cancelled"))
    } else {
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Operation {
    Metadata,
    Validate,
    PacketScan,
}
impl Operation {
    fn name(self) -> &'static str {
        match self {
            Self::Metadata => "metadata",
            Self::Validate => "validate",
            Self::PacketScan => "packet_scan",
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct InspectRequest {
    pub schema_version: u32,
    pub operation: Operation,
    pub source: PathBuf,
    pub expected_kind: ExpectedMediaKind,
    pub container_hint: Option<String>,
    pub compatibility: Option<CliEvidence>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CliEvidence {
    pub reason: Reason,
    pub size: u64,
    pub container: String,
    pub duration_seconds: Option<f64>,
    pub streams: Vec<CliStream>,
    pub packet_scan_complete: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CliStream {
    pub kind: String,
    pub codec: Option<String>,
    pub duration_seconds: Option<f64>,
}

fn finish_cli(
    q: &InspectRequest,
    e: &CliEvidence,
    flag: &AtomicBool,
) -> Result<Inspection, RouteError> {
    let d = diagnostic(q.operation.name(), Backend::Ffprobe, Some(e.reason));
    let expected = match q.expected_kind {
        ExpectedMediaKind::Audio => "audio",
        ExpectedMediaKind::Video => "video",
    };
    if e.streams.len() != 1 || e.streams[0].kind != expected {
        return Err(failed(error("media_contract_violation"), d));
    }
    if matches!(e.reason, Reason::NotProvisioned | Reason::LegacyOverride)
        || q.operation == Operation::PacketScan
        || e.size == 0
        || e.container.is_empty()
        || (q.operation == Operation::Validate && !e.packet_scan_complete)
        || [e.duration_seconds, e.streams[0].duration_seconds]
            .into_iter()
            .flatten()
            .any(|d| !d.is_finite() || d < 0.0)
    {
        return Err(failed(error("invalid_request"), d));
    }
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    if q.operation == Operation::Validate
        && matches!(e.container.as_str(), "mp4" | "mov,mp4,m4a,3gp,3g2,mj2")
    {
        validate_mp4(&q.source, e.streams[0].codec.as_deref(), flag)
            .map_err(|e| failed(e.into(), d.clone()))?;
    }
    Ok(Inspection::Completed {
        metadata: Metadata {
            backend: Backend::Ffprobe,
            path: q.source.clone(),
            size: e.size,
            container: e.container.clone(),
            duration_seconds: e.duration_seconds,
            inspection_level: if e.packet_scan_complete {
                "packet_scan"
            } else {
                "stream_metadata"
            },
            stream_count: 1,
            streams: vec![Stream {
                kind: q.expected_kind,
                codec: e.streams[0].codec.clone(),
                duration_seconds: e.streams[0].duration_seconds,
            }],
        },
        diagnostic: d,
    })
}
#[derive(Debug, Serialize)]
pub(crate) struct Metadata {
    pub backend: Backend,
    pub path: PathBuf,
    pub size: u64,
    pub container: String,
    pub duration_seconds: Option<f64>,
    pub inspection_level: &'static str,
    pub stream_count: usize,
    pub streams: Vec<Stream>,
}
#[derive(Debug, Serialize)]
pub(crate) struct Stream {
    pub kind: ExpectedMediaKind,
    pub codec: Option<String>,
    pub duration_seconds: Option<f64>,
}
#[derive(Debug, Serialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub(crate) enum Inspection {
    Completed {
        metadata: Metadata,
        diagnostic: Diagnostic,
    },
    /// Execute one existing Host effect. This is a decision, not success proof.
    Compatibility { backend: Backend, reason: Reason },
}

pub(crate) fn inspect(
    q: &InspectRequest,
    flag: &AtomicBool,
    poll: &dyn Fn() -> bool,
) -> Result<Inspection, RouteError> {
    inspect_with_config(
        q,
        CONFIGURATION.get().unwrap_or(&Configuration::default()),
        flag,
        poll,
    )
}
fn inspect_with_config(
    q: &InspectRequest,
    config: &Configuration,
    flag: &AtomicBool,
    poll: &dyn Fn() -> bool,
) -> Result<Inspection, RouteError> {
    if q.schema_version != 1
        || !q.source.is_absolute()
        || q.container_hint.as_deref().is_some_and(|s| s != "mp4")
    {
        return Err(error("invalid_request"));
    }
    check_cancel(flag, poll)?;
    if let Some(evidence) = &q.compatibility {
        return finish_cli(q, evidence, flag);
    }
    let path = match capability(config) {
        Ok(path) => path,
        Err(reason) => {
            return Ok(Inspection::Compatibility {
                backend: Backend::Legacy,
                reason,
            });
        }
    };
    match inspect_libav(q, path, flag, poll) {
        Ok(metadata) => Ok(Inspection::Completed {
            metadata,
            diagnostic: diagnostic(q.operation.name(), Backend::Libav, None),
        }),
        Err(e) => {
            let Some(reason) = fallback_reason(&e) else {
                return Err(failed(
                    e.into(),
                    diagnostic(q.operation.name(), Backend::Libav, None),
                ));
            };
            check_cancel(flag, poll)?;
            let mp4 = q.container_hint.as_deref() == Some("mp4")
                || q.source
                    .extension()
                    .and_then(|s| s.to_str())
                    .is_some_and(|s| ["mp4", "m4a"].iter().any(|ext| s.eq_ignore_ascii_case(ext)));
            if q.operation == Operation::PacketScan {
                #[cfg(any(target_os = "linux", target_os = "windows"))]
                if mp4 {
                    validate_mp4(&q.source, None, flag).map_err(|e| {
                        failed(
                            e.into(),
                            diagnostic(q.operation.name(), Backend::PureRust, Some(reason)),
                        )
                    })?;
                }
                return Ok(Inspection::Compatibility {
                    backend: Backend::Ffmpeg,
                    reason,
                });
            }
            if !mp4 {
                return Ok(Inspection::Compatibility {
                    backend: Backend::Ffprobe,
                    reason,
                });
            }
            // The retained MP4 implementation already supplies stricter sample
            // traversal. Do it once; its own failure cannot launch a third backend.
            let d = diagnostic(q.operation.name(), Backend::PureRust, Some(reason));
            #[cfg(any(target_os = "linux", target_os = "windows"))]
            if q.operation == Operation::Validate {
                // The historical probe can enumerate samples without mdat.
                // Strict validation still requires the accepted S3 envelope;
                // a missing companion must not weaken that operation contract.
                validate_mp4(&q.source, None, flag).map_err(|e| failed(e.into(), d.clone()))?;
            }
            let p = media_backend::probe_media(&MediaPathRequest {
                schema_version: 1,
                source: q.source.clone(),
                expected_kind: q.expected_kind,
            })
            .map_err(|e| failed(e.into(), d.clone()))?;
            Ok(Inspection::Completed {
                metadata: Metadata {
                    backend: Backend::PureRust,
                    path: p.path,
                    size: p.file_bytes,
                    container: "mp4".into(),
                    duration_seconds: Some(p.duration_seconds),
                    inspection_level: "sample_traversal",
                    stream_count: 1,
                    streams: vec![Stream {
                        kind: p.kind,
                        codec: Some(p.codec),
                        duration_seconds: Some(p.duration_seconds),
                    }],
                },
                diagnostic: d,
            })
        }
    }
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn inspect_libav(
    q: &InspectRequest,
    path: &Path,
    flag: &AtomicBool,
    poll: &dyn Fn() -> bool,
) -> Result<Metadata, ProbeError> {
    use crate::experimental_libav::{Callback, LibavMetadataProbe, ScanSelection, StreamType};
    // SAFETY: the host configures only a trusted same-build package path once.
    let lib = unsafe { LibavMetadataProbe::load(path)? };
    let callback = Callback::with_poll(flag, poll);
    let metadata = lib.probe_with_callback(&q.source, &callback)?;
    let expected = match q.expected_kind {
        ExpectedMediaKind::Audio => StreamType::Audio,
        ExpectedMediaKind::Video => StreamType::Video,
    };
    if metadata.streams.len() != 1 || metadata.streams[0].media_type != expected {
        return Err(ProbeError::Media(MediaError {
            kind: MediaErrorKind::MediaContractViolation,
            message: "exactly one stream of the expected kind required".into(),
        }));
    }
    let stream = &metadata.streams[0];
    if q.operation != Operation::Metadata {
        if metadata.container == "mov,mp4,m4a,3gp,3g2,mj2" {
            validate_mp4(&q.source, stream.codec_name.as_deref(), flag)?;
        }
        let scan = lib.scan_with_callback(
            &q.source,
            ScanSelection {
                stream_index: stream.index,
                expected_kind: q.expected_kind,
            },
            &callback,
        )?;
        if !scan.clean_eof() {
            return Err(scan.error.unwrap_or(ProbeError::Media(MediaError {
                kind: MediaErrorKind::InvalidMedia,
                message: "packet traversal did not establish clean EOF".into(),
            })));
        }
    }
    let size = std::fs::metadata(&q.source)
        .map_err(|_| {
            ProbeError::Media(MediaError {
                kind: MediaErrorKind::Io,
                message: "media stat failed".into(),
            })
        })?
        .len();
    Ok(Metadata {
        backend: Backend::Libav,
        path: q.source.clone(),
        size,
        container: metadata.container,
        duration_seconds: metadata.duration_us.map(|v| v as f64 / 1_000_000.0),
        inspection_level: if q.operation == Operation::Metadata {
            "stream_metadata"
        } else {
            "packet_scan"
        },
        stream_count: 1,
        streams: vec![Stream {
            kind: q.expected_kind,
            codec: stream.codec_name.clone(),
            duration_seconds: stream.duration_us.map(|v| v as f64 / 1_000_000.0),
        }],
    })
}
#[cfg(not(any(target_os = "linux", target_os = "windows")))]
fn inspect_libav(
    _: &InspectRequest,
    _: &Path,
    _: &AtomicBool,
    _: &dyn Fn() -> bool,
) -> Result<Metadata, ProbeError> {
    Err(ProbeError::Unavailable("platform not packaged".into()))
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn validate_mp4(
    path: &Path,
    codec: Option<&str>,
    flag: &AtomicBool,
) -> Result<(bool, bool), ProbeError> {
    let mut file = crate::experimental_libav::open_input(path)?;
    let facts = crate::experimental_libav::remux::layout_facts(&mut file, false, flag)?;
    if codec == Some("aac") {
        let config = media_backend::aac_decoder_specific_config(path)
            .map_err(ProbeError::Media)?
            .ok_or_else(|| {
                ProbeError::Media(MediaError {
                    kind: MediaErrorKind::InvalidMedia,
                    message: "AAC decoder configuration missing".into(),
                })
            })?;
        media_backend::validate_aac_decoder_specific_config(&config).map_err(ProbeError::Media)?;
    }
    Ok(facts)
}

#[derive(Serialize)]
pub(crate) struct Normalized {
    #[serde(flatten)]
    pub media: MediaNormalizeResult,
    pub diagnostic: Diagnostic,
}
pub(crate) fn normalize(
    q: &MediaNormalizeRequest,
    flag: &AtomicBool,
    poll: &dyn Fn() -> bool,
) -> Result<Normalized, RouteError> {
    normalize_with_config(
        q,
        CONFIGURATION.get().unwrap_or(&Configuration::default()),
        flag,
        poll,
    )
}
fn normalize_with_config(
    q: &MediaNormalizeRequest,
    config: &Configuration,
    flag: &AtomicBool,
    poll: &dyn Fn() -> bool,
) -> Result<Normalized, RouteError> {
    if q.schema_version != 1 || !q.source.is_absolute() || !q.destination.is_absolute() {
        return Err(error("invalid_request"));
    }
    check_cancel(flag, poll)?;
    let profile = if q
        .destination
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("flac"))
    {
        CopyProfile::Flac
    } else {
        CopyProfile::Mp4
    };
    let operation = if profile == CopyProfile::Flac {
        "flac"
    } else {
        "mp4"
    };
    let reason = match capability(config) {
        Err(reason) => reason,
        Ok(path) => match normalize_libav(q, profile, path, flag, poll) {
            Ok(media) => {
                return Ok(Normalized {
                    media,
                    diagnostic: diagnostic(operation, Backend::Libav, None),
                });
            }
            // M5 reports unrepresentable timing / changing configuration with
            // S3's layout-limit kind. The retained writer cannot certify this
            // exact profile for those inputs, so it is not an eligible remedy.
            Err(ProbeError::Media(e)) if e.kind == MediaErrorKind::UnsupportedContainerLayout => {
                return Err(failed(
                    e.into(),
                    diagnostic(operation, Backend::Libav, None),
                ));
            }
            Err(e) => match fallback_reason(&e) {
                Some(reason) => reason,
                None => {
                    return Err(failed(
                        e.into(),
                        diagnostic(operation, Backend::Libav, None),
                    ));
                }
            },
        },
    };
    check_cancel(flag, poll)?;
    // M5 has closed and discarded its exclusively owned scratch before return.
    // The existing Pure Rust normalizer creates fresh scratch and publishes with
    // S2's no-replace primitive. No CLI, source switch, or fallback recursion.
    let d = diagnostic(operation, Backend::PureRust, Some(reason));
    media_backend::normalize_media(q)
        .map(|media| Normalized {
            media,
            diagnostic: d.clone(),
        })
        .map_err(|e| failed(e.into(), d))
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn normalize_libav(
    q: &MediaNormalizeRequest,
    profile: CopyProfile,
    path: &Path,
    flag: &AtomicBool,
    poll: &dyn Fn() -> bool,
) -> Result<MediaNormalizeResult, ProbeError> {
    use crate::experimental_libav::{Callback, CopyRemuxRequest, LibavMetadataProbe};
    // SAFETY: immutable host-authorized package path, as for inspection.
    let lib = unsafe { LibavMetadataProbe::load(path)? };
    let callback = Callback::with_poll(flag, poll);
    let metadata = lib.probe_with_callback(&q.source, &callback)?;
    let (leading, fragmented) = validate_mp4(
        &q.source,
        metadata
            .streams
            .first()
            .and_then(|s| s.codec_name.as_deref()),
        flag,
    )?;
    let result = lib.remux_impl(
        &CopyRemuxRequest {
            source: &q.source,
            destination: &q.destination,
            expected_kind: q.expected_kind,
        },
        profile,
        &callback,
        &mut || {},
        &mut || {},
    )?;
    let invalid = || {
        ProbeError::Media(MediaError {
            kind: MediaErrorKind::InvalidMedia,
            message: "required normalization metadata missing".into(),
        })
    };
    let probe = |path: &Path,
                 metadata: &crate::experimental_libav::Metadata,
                 scan: &crate::experimental_libav::PacketScan,
                 file_bytes,
                 fast_start,
                 fragmented|
     -> Result<MediaProbe, ProbeError> {
        let stream = metadata.streams.first().ok_or_else(invalid)?;
        let duration =
            stream.duration_us.filter(|d| *d > 0).ok_or_else(invalid)? as f64 / 1_000_000.0;
        let packets = scan
            .selected
            .as_ref()
            .filter(|p| scan.clean_eof() && p.payload_bytes > 0)
            .ok_or_else(invalid)?;
        Ok(MediaProbe {
            path: path.into(),
            kind: q.expected_kind,
            codec: stream.codec_name.clone().ok_or_else(invalid)?,
            duration_seconds: duration,
            sample_count: u32::try_from(packets.packet_count).map_err(|_| invalid())?,
            sample_bytes: packets.payload_bytes,
            file_bytes,
            fast_start,
            fragmented,
        })
    };
    Ok(MediaNormalizeResult {
        source: probe(
            &q.source,
            &result.input_metadata,
            &result.input,
            std::fs::metadata(&q.source)
                .map_err(|_| {
                    ProbeError::Media(MediaError {
                        kind: MediaErrorKind::Io,
                        message: "media stat failed".into(),
                    })
                })?
                .len(),
            leading,
            fragmented,
        )?,
        output: probe(
            &q.destination,
            &result.output,
            &result.output_scan,
            result.output_bytes,
            result.leading_moov || profile == CopyProfile::Flac,
            false,
        )?,
    })
}
#[cfg(not(any(target_os = "linux", target_os = "windows")))]
fn normalize_libav(
    _: &MediaNormalizeRequest,
    _: CopyProfile,
    _: &Path,
    _: &AtomicBool,
    _: &dyn Fn() -> bool,
) -> Result<MediaNormalizeResult, ProbeError> {
    Err(ProbeError::Unavailable("platform not packaged".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fallback_is_exhaustively_separate_from_s3_retry() {
        for kind in [
            MediaErrorKind::InvalidRequest,
            MediaErrorKind::SourceMissing,
            MediaErrorKind::DestinationExists,
            MediaErrorKind::MediaContractViolation,
            MediaErrorKind::InvalidMedia,
            MediaErrorKind::Io,
        ] {
            let e = ProbeError::Media(MediaError {
                kind,
                message: "unavailable unsupported".into(),
            });
            assert_eq!(fallback_reason(&e), None);
            assert_eq!(RouteError::from(e).kind, kind.as_str());
        }
        for e in [
            ProbeError::Cancelled,
            ProbeError::BackendFailure("unavailable".into()),
            ProbeError::BackendFailure("unknown code".into()),
        ] {
            assert_eq!(fallback_reason(&e), None);
        }
        for (kind, reason) in [
            (MediaErrorKind::UnsupportedCodec, Reason::UnsupportedCodec),
            (
                MediaErrorKind::UnsupportedContainerLayout,
                Reason::UnsupportedContainerLayout,
            ),
        ] {
            assert_eq!(
                fallback_reason(&ProbeError::Media(MediaError {
                    kind,
                    message: String::new()
                })),
                Some(reason)
            );
        }
        assert_eq!(
            fallback_reason(&ProbeError::Unavailable(String::new())),
            Some(Reason::Unavailable)
        );
        assert_eq!(
            fallback_reason(&ProbeError::UnsupportedFormat(String::new())),
            Some(Reason::UnsupportedFormat)
        );
    }

    #[test]
    fn rollback_and_absence_are_capability_decisions_before_loading() {
        let mut config = Configuration::default();
        assert_eq!(capability(&config), Err(Reason::NotProvisioned));
        config.mode = Mode::Legacy;
        config.companion = Some(PathBuf::from("never-open-this-library"));
        assert_eq!(capability(&config), Err(Reason::LegacyOverride));
        assert!(
            serde_json::from_str::<Configuration>(r#"{"mode":"unknown","companion":null}"#)
                .is_err()
        );
    }

    #[test]
    #[ignore = "requires accepted real companion and fixtures; missing inputs fail"]
    fn live_application_routing_contracts() {
        let fixtures =
            PathBuf::from(std::env::var_os("BILIKARA_LIBAV_FIXTURES").expect("fixtures"));
        let companion =
            PathBuf::from(std::env::var_os("BILIKARA_LIBAV_COMPANION").expect("companion"));
        assert!(companion.is_file() && fixtures.is_dir());
        let config = Configuration {
            mode: Mode::Default,
            companion: Some(companion),
        };
        let flag = AtomicBool::new(false);
        let mut q = InspectRequest {
            schema_version: 1,
            operation: Operation::Metadata,
            source: fixtures.join("aac.m4a"),
            expected_kind: ExpectedMediaKind::Audio,
            container_hint: None,
            compatibility: None,
        };
        for operation in [
            Operation::Metadata,
            Operation::Validate,
            Operation::PacketScan,
        ] {
            q.operation = operation;
            let Inspection::Completed {
                metadata,
                diagnostic,
            } = inspect_with_config(&q, &config, &flag, &|| false).unwrap()
            else {
                panic!("real libav must execute");
            };
            assert_eq!(diagnostic.backend, Backend::Libav);
            assert!(
                metadata.streams[0]
                    .duration_seconds
                    .is_some_and(|d| d > 0.0)
            );
        }
        for (name, kind) in [
            ("missing-mdat.m4a", "invalid_media"),
            ("unknown.bin", "invalid_media"),
            ("av.mp4", "media_contract_violation"),
        ] {
            q.source = fixtures.join(name);
            let failure = inspect_with_config(&q, &config, &flag, &|| false).unwrap_err();
            assert_eq!(failure.kind, kind);
            assert_eq!(failure.diagnostic.unwrap().backend, Backend::Libav);
        }
        q.source = fixtures.join("aac.m4a");
        let calls = std::cell::Cell::new(0);
        let failure = inspect_with_config(&q, &config, &flag, &|| {
            calls.set(calls.get() + 1);
            calls.get() >= 4
        })
        .unwrap_err();
        assert_eq!(failure.kind, "cancelled");
        flag.store(false, Ordering::Relaxed);
        let missing = Configuration {
            companion: Some(fixtures.join("absent-companion")),
            ..config.clone()
        };
        let Inspection::Compatibility { backend, reason } =
            inspect_with_config(&q, &missing, &flag, &|| false).unwrap()
        else {
            panic!("expected CLI scan decision");
        };
        assert_eq!((backend, reason), (Backend::Ffmpeg, Reason::Unavailable));
        q.operation = Operation::Validate;
        let Inspection::Completed { diagnostic, .. } =
            inspect_with_config(&q, &missing, &flag, &|| false).unwrap()
        else {
            panic!("expected one Pure Rust compatibility call");
        };
        assert_eq!(diagnostic.backend, Backend::PureRust);
        assert_eq!(diagnostic.compatibility_reason, Some(Reason::Unavailable));
        // A failed compatibility implementation is final, never ffprobe repair.
        q.source = fixtures.join("missing-mdat.m4a");
        let failure = inspect_with_config(&q, &missing, &flag, &|| false).unwrap_err();
        assert_eq!(failure.kind, "invalid_media");
        assert_eq!(failure.diagnostic.unwrap().backend, Backend::PureRust);
    }
}
