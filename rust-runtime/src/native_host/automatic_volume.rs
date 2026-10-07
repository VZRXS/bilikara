//! One supervised worker, asleep on a bounded command channel while OFF.
//! No decoder/file work occurs under AppState's serialized lock.
use super::*;
use crate::app_state::automatic_volume::AnalysisSignal;
use crate::experimental_libav::{LibavMetadataProbe, LoudnessMeasurement, ProbeError};
use serde::{Deserialize, Serialize};
use std::fs;

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

fn analyze(
    probe: &LibavMetadataProbe,
    path: &Path,
    cancelled: &AtomicBool,
) -> Result<(LoudnessMeasurement, bool), ProbeError> {
    let before =
        identity(path).ok_or_else(|| ProbeError::BackendFailure("artifact unavailable".into()))?;
    let metadata = path.with_extension(format!(
        "{}.loudness.json",
        path.extension().and_then(|s| s.to_str()).unwrap_or("audio")
    ));
    if fs::metadata(&metadata).is_ok_and(|m| m.len() <= 4096)
        && let Ok(bytes) = fs::read(&metadata)
        && let Ok(saved) = serde_json::from_slice::<CachedFact>(&bytes)
        && saved.schema == 1
        && (saved.bytes, saved.modified_nanos) == before
        && saved.fact.valid()
        && !cancelled.load(Ordering::Acquire)
    {
        return Ok((saved.fact, true));
    }
    let fact = probe.integrated_loudness(path, cancelled)?;
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
                probe = crate::media_routing::loudness_companion().and_then(|path| {
                    // SAFETY: existing trusted Host/package configuration.
                    unsafe { LibavMetadataProbe::load(path) }.ok().filter(LibavMetadataProbe::loudness_available)
                });
                let _ = with_app(|app| { app.set_scanner_available(probe.is_some()); Ok(()) });
            }
            let Some(probe) = &probe else { continue; };
            loop {
                if context.stop.load(Ordering::Acquire) { break; }
                // Clear before admission while the previous cancellation is no
                // longer in use; a concurrent mutation sets it again afterward.
                cancelled.store(false, Ordering::Release);
                let job = with_app(|app| Ok(app.take_analysis_job())).ok().flatten();
                let Some(job) = job else { break; };
                let result = analyze(probe, &context.cache_root.join(&job.relative), &cancelled);
                let stopped = cancelled.load(Ordering::Acquire) || context.stop.load(Ordering::Acquire) || matches!(result, Err(ProbeError::Cancelled));
                let _ = with_app(|app| {
                    if let Ok((fact, reused)) = &result {
                        app.native_diagnostic(&json!({"event":"automatic-volume-analysis","codec":fact.codec,"sample_rate":fact.sample_rate,"channels":fact.channels,"duration_seconds":fact.duration_seconds,"elapsed_seconds":fact.elapsed_seconds,"processing_ratio":fact.elapsed_seconds/fact.duration_seconds,"reused":reused}), now());
                    }
                    app.finish_analysis(&job, result.ok().map(|(fact, _)| fact), stopped)
                });
            }
        }
    }).map_err(|_| ApiError::new(503,"scanner_start","无法启动音频分析服务"))
}

pub(super) fn configure_capability() {
    // Do not load a library at startup. These are trusted backend provisioning
    // facts; symbol/build negotiation still runs on the first explicit enable.
    let available = crate::media_routing::loudness_companion().is_some();
    let _ = with_app(|app| {
        app.set_scanner_available(available);
        Ok(())
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "requires prepared native companion and generated offline audio fixtures"]
    fn artifact_fact_reuse_and_replacement() {
        let companion = PathBuf::from(std::env::var_os("BILIKARA_TEST_LIBAV_COMPANION").unwrap());
        let fixtures = PathBuf::from(std::env::var_os("BILIKARA_TEST_LOUDNESS_FIXTURES").unwrap());
        // SAFETY: explicit same-build local test artifact.
        let probe = unsafe { LibavMetadataProbe::load(&companion) }.unwrap();
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
        let probe = unsafe { LibavMetadataProbe::load(&companion) }.unwrap();
        assert!(analyze(&probe, &path, &flag).unwrap().1);
        fs::copy(fixtures.join("aac-44100.m4a"), &path).unwrap();
        assert!(!analyze(&probe, &path, &flag).unwrap().1);
        flag.store(true, Ordering::Release);
        assert!(analyze(&probe, &path, &flag).is_err());
    }
}
