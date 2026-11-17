//! One supervised worker, asleep on a bounded command channel while OFF.
//! No decoder/file work occurs under AppState's serialized lock.
use super::*;
use crate::app_state::automatic_volume::{AnalysisSignal, AutomaticVolumeCommand};
use crate::experimental_libav::{LibavMetadataProbe, LoudnessMeasurement, ProbeError};
use serde::{Deserialize, Serialize};
use std::fs;

enum Scanner {
    Libav(Box<LibavMetadataProbe>),
    #[cfg(feature = "portable-loudness")]
    Portable,
}

impl Scanner {
    fn load() -> Option<Self> {
        #[cfg(feature = "portable-loudness")]
        if cfg!(feature = "portable-loudness") {
            return Some(Self::Portable);
        }
        crate::media_routing::loudness_companion().and_then(|path| {
            // SAFETY: trusted Host/package configuration, never a client path.
            unsafe { LibavMetadataProbe::load(path) }
                .ok()
                .filter(LibavMetadataProbe::loudness_available)
                .map(Box::new)
                .map(Self::Libav)
        })
    }

    fn integrated_loudness(
        &self,
        path: &Path,
        cancelled: &AtomicBool,
        details: &mut Value,
    ) -> Result<LoudnessMeasurement, ProbeError> {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match self {
            Self::Libav(probe) => {
                *details = json!({"backend":"libav"});
                probe.integrated_loudness(path, cancelled)
            },
            #[cfg(feature = "portable-loudness")]
            Self::Portable => {
                let mut diagnostic = crate::portable_loudness::ScanDiagnostics::default();
                let result = crate::portable_loudness::analyze_diagnosed(path, cancelled, &mut diagnostic);
                *details = json!({"codec":diagnostic.codec,"profile":diagnostic.profile,"tracks":diagnostic.tracks,"legacy_aac_sl_config":diagnostic.legacy_aac_sl_config,
                    "sample_rate":diagnostic.sample_rate,"channels":diagnostic.channels,
                    "declared_seconds":diagnostic.declared_seconds,"decoded_seconds":diagnostic.decoded_seconds,
                    "packet_index":diagnostic.packet_index,"packet_seconds":diagnostic.packet_seconds,
                    "packet_duration":diagnostic.packet_duration,"gap_seconds":diagnostic.gap_seconds});
                result.map_err(|error| match error {
                    crate::portable_loudness::Error::Cancelled => ProbeError::Cancelled,
                    error => ProbeError::BackendFailure(error.diagnostic_code().into()),
                })
            }
        }))
        .unwrap_or_else(|_| Err(ProbeError::BackendFailure("audio scanner failed".into())))
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CachedFact {
    schema: u32,
    bytes: u64,
    modified_nanos: u128,
    fact: LoudnessMeasurement,
}

fn identity(path: &Path) -> Option<(u64, u128)> {
    let metadata = fs::metadata(path).ok()?;
    Some((
        metadata.len(),
        metadata
            .modified()
            .ok()?
            .duration_since(UNIX_EPOCH)
            .ok()?
            .as_nanos(),
    ))
}

fn failure_stage(error: &ProbeError) -> &'static str {
    match error {
        ProbeError::Cancelled => "cancelled",
        ProbeError::UnsupportedFormat(_) => "unsupported_container",
        ProbeError::Unavailable(_) | ProbeError::NegotiationFailed(_) => "scanner_unavailable",
        ProbeError::BackendFailure(code) => match code.as_str() {
            "missing_artifact" => "missing_artifact",
            "unsupported_container" => "unsupported_container",
            "unsupported_codec_profile" => "unsupported_codec_profile",
            "packet_timeline" => "packet_timeline",
            "duration_mismatch" => "duration_mismatch",
            "analysis_timeout" => "analysis_timeout",
            "silent_signal" => "silent_signal",
            _ => "decoder_failure",
        },
        _ => "decoder_failure",
    }
}

#[cfg(test)]
fn analyze(
    probe: &Scanner,
    path: &Path,
    cancelled: &AtomicBool,
) -> Result<(LoudnessMeasurement, bool), ProbeError> {
    analyze_with_reuse(probe, path, cancelled, true, &mut Value::Null)
}

fn analyze_with_reuse(
    probe: &Scanner,
    path: &Path,
    cancelled: &AtomicBool,
    reuse: bool,
    details: &mut Value,
) -> Result<(LoudnessMeasurement, bool), ProbeError> {
    let before =
        identity(path).ok_or_else(|| ProbeError::BackendFailure("missing_artifact".into()))?;
    let metadata = path.with_extension(format!(
        "{}.loudness.json",
        path.extension().and_then(|s| s.to_str()).unwrap_or("audio")
    ));
    if reuse
        && fs::metadata(&metadata).is_ok_and(|m| m.len() <= 4096)
        && let Ok(bytes) = fs::read(&metadata)
        && let Ok(saved) = serde_json::from_slice::<CachedFact>(&bytes)
        && saved.schema == 1
        && (saved.bytes, saved.modified_nanos) == before
        && saved.fact.valid()
        && !cancelled.load(Ordering::Acquire)
    {
        return Ok((saved.fact, true));
    }
    let fact = probe.integrated_loudness(path, cancelled, details)?;
    if cancelled.load(Ordering::Acquire) || identity(path) != Some(before) {
        return Err(ProbeError::Cancelled);
    }
    // A single tiny sidecar follows the existing artifact's eviction lifetime.
    // Immutable audio bytes/URLs/publication are untouched. No second hash pass.
    let saved = CachedFact {
        schema: 1,
        bytes: before.0,
        modified_nanos: before.1,
        fact: fact.clone(),
    };
    if let Ok(bytes) = serde_json::to_vec(&saved) {
        let temporary = metadata.with_extension("json.tmp");
        if fs::write(&temporary, bytes).is_ok() && fs::rename(&temporary, &metadata).is_err() {
            let _ = fs::remove_file(temporary);
        }
    }
    Ok((fact, false))
}

pub(super) fn command(
    context: &HostContext,
    identity: &Identity,
    body: &Value,
) -> Result<Value, ApiError> {
    match with_app(|app| app.begin_automatic_volume(identity, body))? {
        AutomaticVolumeCommand::Complete(snapshot) => Ok(snapshot),
        AutomaticVolumeCommand::Verify(job, cancelled) => {
            // This HTTP operation already runs on the bounded blocking pool.
            // AppState owns admission, context and the cache read lease; no
            // decoder/file work is performed under its serialized lock.
            let mut details = Value::Null;
            let result = Scanner::load()
                .ok_or_else(|| ProbeError::Unavailable("scanner unavailable".into()))
                .and_then(|scanner| {
                    analyze_with_reuse(
                        &scanner,
                        &context.cache_root.join(&job.relative),
                        &cancelled,
                        false,
                        &mut details,
                    )
                });
            let stopped = cancelled.load(Ordering::Acquire) || context.stop.load(Ordering::Acquire);
            with_app(|app| {
                if let Err(error) = &result {
                    app.native_diagnostic(&json!({"event":"automatic-volume-analysis-failed","phase":"verification","reason":failure_stage(error),"scan":details,"analysis_epoch":job.epoch}), now());
                }
                let reason = result.as_ref().err().map(failure_stage);
                let finished = app.finish_scanner_verification(
                    &job,
                    result.ok().map(|(fact, _)| fact),
                    stopped,
                );
                finished.map_err(|mut error| {
                    if error.code == "scanner_unavailable" {
                        error.extra = json!({"analysis_reason":reason.unwrap_or("scanner_unavailable"),"analysis_phase":"verification"});
                    }
                    error
                })
            })
        }
    }
}

#[cfg(test)]
pub(super) static TEST_SCANNER_WAKES: std::sync::atomic::AtomicU32 =
    std::sync::atomic::AtomicU32::new(0);

fn report_unavailable(path: Option<&Path>) -> bool {
    use crate::experimental_libav::load_cache::FailureNotices;
    static NOTICES: std::sync::OnceLock<std::sync::Mutex<FailureNotices>> =
        std::sync::OnceLock::new();
    NOTICES
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .changed(path)
}

pub(super) fn start(context: Arc<HostContext>) -> Result<(), ApiError> {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let cancelled = Arc::new(AtomicBool::new(false));
    with_app(|app| {
        app.install_analysis(AnalysisSignal {
            wake: sender,
            cancelled: cancelled.clone(),
        });
        Ok(())
    })?;
    context.clone().spawn("native-host-loudness", move || {
        // Capability negotiation is lazy too: OFF has no companion load or scan.
        let mut probe = None;
        while receiver.recv().is_ok() {
            if context.stop.load(Ordering::Acquire) { break; }
            let enabled = with_app(|app| Ok(app.native_core_snapshot()?.automatic_volume.enabled)).unwrap_or(false);
            if !enabled { continue; }
            if probe.is_none() {
                probe = Scanner::load();
                let report = probe.is_none() && report_unavailable(crate::media_routing::loudness_companion());
                let _ = with_app(|app| {
                    app.set_scanner_available(probe.is_some());
                    if report {
                        app.native_diagnostic(&json!({"event":"automatic-volume-unavailable","reason":"companion_unavailable"}), now());
                    }
                    Ok(())
                });
                #[cfg(test)]
                TEST_SCANNER_WAKES.fetch_add(1, Ordering::Release);
            }
            let Some(probe) = &probe else { continue; };
            loop {
                if context.stop.load(Ordering::Acquire) { break; }
                // Clear before admission while the previous cancellation is no
                // longer in use; a concurrent mutation sets it again afterward.
                cancelled.store(false, Ordering::Release);
                let job = with_app(|app| Ok(app.take_analysis_job())).ok().flatten();
                let Some(job) = job else { break; };
                let mut details = Value::Null;
                let result = analyze_with_reuse(probe, &context.cache_root.join(&job.relative), &cancelled, true, &mut details);
                let stopped = cancelled.load(Ordering::Acquire) || context.stop.load(Ordering::Acquire) || matches!(result, Err(ProbeError::Cancelled));
                let _ = with_app(|app| {
                    if let Ok((fact, reused)) = &result {
                        app.native_diagnostic(&json!({"event":"automatic-volume-analysis","codec":fact.codec,"sample_rate":fact.sample_rate,"channels":fact.channels,"duration_seconds":fact.duration_seconds,"elapsed_seconds":fact.elapsed_seconds,"processing_ratio":fact.elapsed_seconds/fact.duration_seconds,"reused":reused}), now());
                    }
                    if let Err(error) = &result {
                        app.native_diagnostic(&json!({"event":"automatic-volume-analysis-failed","phase":"analysis","reason":failure_stage(error),"scan":details,"analysis_epoch":job.epoch}), now());
                    }
                    app.finish_analysis(&job, result.ok().map(|(fact, _)| fact), stopped)
                });
            }
        }
    }).map_err(|_| ApiError::new(503,"scanner_start","无法启动音频分析服务"))
}

pub(super) fn configure_capability() {
    // Do not load a library at startup. These are trusted backend provisioning
    // facts; Android has already negotiated its optional APK companion. Other
    // platforms still negotiate symbols/build on the first explicit enable.
    let available = !cfg!(feature = "portable-loudness")
        && crate::media_routing::loudness_companion().is_some();
    #[cfg(any(target_os = "android", test))]
    let available = super::android_media::capability().map_or(available, |c| c.loudness);
    let _ = with_app(|app| {
        #[cfg(any(target_os = "android", test))]
        if let Some(c) = super::android_media::capability() {
            app.native_diagnostic(&json!({"event":"android-media-capability","reason":c.reason,
                "companion_metadata":c.metadata,"companion_packet_scan":c.packet_scan,
                "companion_remux":c.remux,"companion_loudness":c.loudness,"companion_cast":c.cast,"companion_l1":c.l1}), now());
            if !c.loudness && report_unavailable(crate::media_routing::loudness_companion()) {
                app.native_diagnostic(&json!({"event":"automatic-volume-unavailable","reason":c.reason.unwrap_or("companion_pcm_unavailable")}), now());
            }
        }
        app.set_scanner_available(available);
        app.set_scanner_probe_available(cfg!(feature = "portable-loudness"));
        Ok(())
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scanner_failures_expose_only_bounded_stage_codes() {
        assert_eq!(failure_stage(&ProbeError::Cancelled), "cancelled");
        assert_eq!(
            failure_stage(&ProbeError::BackendFailure("packet_timeline".into())),
            "packet_timeline"
        );
        assert_eq!(
            failure_stage(&ProbeError::BackendFailure(
                "/private/media/user-song.m4a: bad packet".into()
            )),
            "decoder_failure"
        );
    }
    #[cfg(feature = "portable-loudness")]
    #[test]
    #[ignore = "requires generated real compressed audio fixtures"]
    fn portable_artifact_fact_reuse_and_replacement() {
        let fixtures = PathBuf::from(std::env::var_os("BILIKARA_TEST_LOUDNESS_FIXTURES").unwrap());
        let path = fixtures.join("portable-reusable.m4a");
        fs::copy(fixtures.join("aac-48000.m4a"), &path).unwrap();
        let probe = Scanner::Portable;
        let flag = AtomicBool::new(false);
        let (first, reused) = analyze(&probe, &path, &flag).unwrap();
        assert!(!reused);
        let (second, reused) = analyze(&Scanner::Portable, &path, &flag).unwrap();
        assert!(reused);
        assert_eq!(first, second);
        fs::copy(fixtures.join("aac-44100.m4a"), &path).unwrap();
        assert!(!analyze(&probe, &path, &flag).unwrap().1);
        flag.store(true, Ordering::Release);
        assert!(matches!(
            analyze(&probe, &path, &flag),
            Err(ProbeError::Cancelled)
        ));
    }
    #[test]
    #[ignore = "requires prepared native companion and generated offline audio fixtures"]
    fn artifact_fact_reuse_and_replacement() {
        let companion = PathBuf::from(std::env::var_os("BILIKARA_TEST_LIBAV_COMPANION").unwrap());
        let fixtures = PathBuf::from(std::env::var_os("BILIKARA_TEST_LOUDNESS_FIXTURES").unwrap());
        // SAFETY: explicit same-build local test artifact.
        let probe = Scanner::Libav(Box::new(
            unsafe { LibavMetadataProbe::load(&companion) }.unwrap(),
        ));
        let path = fixtures.join("reusable.m4a");
        fs::copy(fixtures.join("aac-48000.m4a"), &path).unwrap();
        let flag = AtomicBool::new(false);
        let (first, reused) = analyze(&probe, &path, &flag).unwrap();
        assert!(!reused);
        let (second, reused) = analyze(&probe, &path, &flag).unwrap();
        assert!(reused);
        assert_eq!(first, second);
        drop(probe);
        // A new loader (restart) reuses only validated immutable-file facts.
        let probe = Scanner::Libav(Box::new(
            unsafe { LibavMetadataProbe::load(&companion) }.unwrap(),
        ));
        assert!(analyze(&probe, &path, &flag).unwrap().1);
        fs::copy(fixtures.join("aac-44100.m4a"), &path).unwrap();
        assert!(!analyze(&probe, &path, &flag).unwrap().1);
        flag.store(true, Ordering::Release);
        assert!(analyze(&probe, &path, &flag).is_err());
    }
}
