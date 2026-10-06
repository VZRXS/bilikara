//! Saved calibration, media facts and per-playback intent have distinct owners.
use super::*;
use crate::experimental_libav::LoudnessMeasurement;
use bilikara_rust::automatic_volume::automatic_percent;
#[cfg(feature = "native-host")]
use bilikara_rust::automatic_volume::reference_target;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct AutomaticVolumePreference {
    pub enabled: bool,
    pub target_lufs: Option<f64>,
    pub calibration_revision: u64,
}

// Treat malformed newly introduced settings as OFF. A malformed feature field
// must neither enable analysis nor make an otherwise valid old library unusable.
pub(super) fn read_preference<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<AutomaticVolumePreference, D::Error> {
    let value = Value::deserialize(d)?;
    let mut pref = serde_json::from_value::<AutomaticVolumePreference>(value).unwrap_or_default();
    if pref
        .target_lufs
        .is_some_and(|t| !t.is_finite() || !(-110.0..=24.0).contains(&t))
        || pref.calibration_revision > MAX_SAFE_JSON_INTEGER
    {
        pref = AutomaticVolumePreference::default();
    }
    Ok(pref)
}

#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(
    not(feature = "native-host"),
    expect(
        dead_code,
        reason = "Source projections share the fact model; only the native Host produces measurements"
    )
)]
pub(super) enum MeasurementState {
    Analyzing,
    Unavailable,
    Complete(LoudnessMeasurement),
}

#[derive(Debug, Clone, Default, PartialEq)]
pub(super) struct AutomaticPlayback {
    pub scanner_available: bool,
    pub manual_override: bool,
    pub intent_revision: u64,
    pub analysis_epoch: u64,
    pub measurements: HashMap<String, MeasurementState>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AutomaticVolumeContext {
    pub item_incarnation_id: String,
    pub artifact_set_id: String,
    pub selected_audio_variant_id: String,
    pub intent_revision: u64,
    pub calibration_revision: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AutomaticVolumeSnapshot {
    pub enabled: bool,
    pub calibrated: bool,
    pub scanner_available: bool,
    pub status: &'static str,
    pub manual_override: bool,
    pub reference_reason: &'static str,
    pub can_reference: bool,
    pub can_resume: bool,
    pub context: Option<AutomaticVolumeContext>,
}

pub(super) fn rendition(item: &PlaylistItem) -> Option<(String, String)> {
    if !has_committed_artifact(item) {
        return None;
    }
    let variant = item.audio_variants.iter().find(|v| {
        v.get("id").and_then(Value::as_str) == Some(item.selected_audio_variant_id.as_str())
    })?;
    let relative = variant
        .get("audio_url")?
        .as_str()?
        .strip_prefix("/media/")?;
    // Already validated at ready publication; retain the exact artifact/variant
    // identity, not title, BVID, or the playback generation changed by seeking.
    Some((
        format!(
            "{}:{}",
            item.artifact_set_id, item.selected_audio_variant_id
        ),
        relative.to_owned(),
    ))
}

impl AppStateData {
    pub(super) fn automatic_context(&self) -> Option<AutomaticVolumeContext> {
        let item = self.current_item.as_ref()?;
        rendition(item)?;
        Some(AutomaticVolumeContext {
            item_incarnation_id: item.item_incarnation_id.clone(),
            artifact_set_id: item.artifact_set_id.clone(),
            selected_audio_variant_id: item.selected_audio_variant_id.clone(),
            intent_revision: self.automatic_playback.intent_revision,
            calibration_revision: self.automatic_volume.calibration_revision,
        })
    }

    pub(super) fn current_measurement(&self) -> Option<&LoudnessMeasurement> {
        let (key, _) = rendition(self.current_item.as_ref()?)?;
        match self.automatic_playback.measurements.get(&key)? {
            MeasurementState::Complete(fact) if fact.valid() => Some(fact),
            _ => None,
        }
    }

    pub(super) fn automatic_snapshot(&self) -> AutomaticVolumeSnapshot {
        let pref = &self.automatic_volume;
        let playback = &self.automatic_playback;
        let context = self.automatic_context();
        let fact = self.current_measurement();
        let state = self
            .current_item
            .as_ref()
            .and_then(rendition)
            .and_then(|(key, _)| playback.measurements.get(&key));
        let reason = if !pref.enabled {
            "off"
        } else if !playback.scanner_available {
            "scanner_unavailable"
        } else if context.is_none() {
            "no_audio"
        } else if matches!(state, Some(MeasurementState::Unavailable)) {
            "unavailable"
        } else if fact.is_none() {
            "analyzing"
        } else if self.player_settings.is_muted {
            "muted"
        } else if !(1..=100).contains(&self.player_settings.volume_percent) {
            "reference_volume"
        } else {
            ""
        };
        let status = if !pref.enabled {
            "off"
        } else if !playback.scanner_available
            || matches!(state, Some(MeasurementState::Unavailable))
        {
            "unavailable"
        } else if pref.target_lufs.is_none() {
            "waiting_baseline"
        } else if playback.manual_override
            || self.player_settings.volume_percent == 0
            || self.player_settings.is_muted
        {
            "manual"
        } else if fact.is_none() {
            "analyzing"
        } else {
            "automatic"
        };
        AutomaticVolumeSnapshot {
            enabled: pref.enabled,
            calibrated: pref.target_lufs.is_some(),
            scanner_available: playback.scanner_available,
            status,
            manual_override: playback.manual_override,
            reference_reason: reason,
            can_reference: reason.is_empty(),
            can_resume: pref.enabled
                && pref.target_lufs.is_some()
                && fact.is_some()
                && playback.manual_override
                && !self.player_settings.is_muted,
            context,
        }
    }

    pub(super) fn mark_manual_volume(&mut self) {
        self.automatic_playback.intent_revision =
            self.automatic_playback.intent_revision.saturating_add(1);
        self.automatic_playback.manual_override = self.current_item.is_some();
    }

    pub(super) fn apply_automatic_volume(&mut self) {
        if !self.automatic_volume.enabled
            || self.automatic_playback.manual_override
            || self.player_settings.is_muted
        {
            return;
        }
        let Some(target) = self.automatic_volume.target_lufs else {
            return;
        };
        let Some(fact) = self.current_measurement() else {
            return;
        };
        if let Some(percent) = automatic_percent(target, fact.integrated_lufs) {
            self.player_settings.volume_percent = percent;
        }
    }

    pub(super) fn automatic_transition(&mut self, previous: &AppStateData, song_changed: bool) {
        if song_changed {
            self.automatic_playback.manual_override = false;
            self.automatic_playback.intent_revision =
                self.automatic_playback.intent_revision.saturating_add(1);
        }
        if !self.automatic_volume.enabled && self.automatic_playback.measurements.is_empty() {
            return;
        }
        let keys: HashSet<_> = self
            .current_item
            .iter()
            .chain(self.playlist.iter().take(2))
            .filter_map(rendition)
            .map(|(key, _)| key)
            .collect();
        self.automatic_playback
            .measurements
            .retain(|key, _| keys.contains(key));
        // Same-song seeks/reconnects/rendition switches retain manual intent.
        if song_changed || self.automatic_context() != previous.automatic_context() {
            self.apply_automatic_volume();
        }
    }
}

#[cfg(feature = "native-host")]
#[derive(Debug, Clone)]
pub(crate) struct AnalysisJob {
    pub key: String,
    pub relative: String,
    pub lease: String,
    pub epoch: u64,
    pub expected: Option<AutomaticVolumeContext>,
}

#[cfg(feature = "native-host")]
impl AppState {
    pub(crate) fn install_analysis(&mut self, signal: AnalysisSignal) {
        self.analysis_signal = Some(signal);
        self.notify_analysis(false);
    }

    pub(crate) fn set_scanner_available(&mut self, available: bool) {
        if let Some(data) = self.data.as_mut()
            && data.automatic_playback.scanner_available != available
        {
            data.automatic_playback.scanner_available = available;
            data.revision += 1;
            self.native_session.revision += 1;
        }
    }

    pub(crate) fn take_analysis_job(&mut self) -> Option<AnalysisJob> {
        let data = self.data.as_ref()?;
        if !data.automatic_volume.enabled || !data.automatic_playback.scanner_available {
            return None;
        }
        let (key, relative) = data
            .current_item
            .iter()
            .chain(data.playlist.iter().take(2))
            .filter_map(rendition)
            .find(|(key, _)| {
                !matches!(
                    data.automatic_playback.measurements.get(key),
                    Some(MeasurementState::Complete(_) | MeasurementState::Unavailable)
                )
            })?;
        let expected = data.automatic_context();
        let epoch = data.automatic_playback.analysis_epoch;
        let lease = self.acquire_artifact_reader(&relative).ok()??;
        let data = self.data.as_mut()?;
        data.automatic_playback
            .measurements
            .insert(key.clone(), MeasurementState::Analyzing);
        data.revision += 1;
        self.native_session.revision += 1;
        Some(AnalysisJob {
            key,
            relative,
            lease,
            epoch,
            expected,
        })
    }

    pub(crate) fn finish_analysis(
        &mut self,
        job: &AnalysisJob,
        fact: Option<LoudnessMeasurement>,
        cancelled: bool,
    ) -> Result<(), crate::native_host::ApiError> {
        use crate::native_host::ApiError;
        self.release_artifact_reader(&job.lease);
        let Some(data) = self.data.as_ref() else {
            return Ok(());
        };
        if !data.automatic_volume.enabled || data.automatic_playback.analysis_epoch != job.epoch {
            return Ok(());
        }
        let live = data
            .current_item
            .iter()
            .chain(data.playlist.iter().take(2))
            .filter_map(rendition)
            .any(|(key, _)| key == job.key);
        if !live {
            return Ok(());
        }
        let mut next = data.clone();
        if cancelled {
            next.automatic_playback.measurements.remove(&job.key);
        } else {
            next.automatic_playback.measurements.insert(
                job.key.clone(),
                fact.filter(LoudnessMeasurement::valid)
                    .map(MeasurementState::Complete)
                    .unwrap_or(MeasurementState::Unavailable),
            );
            // A late result is a reusable fact, never an authority to overwrite
            // newer manual/target/playback intent. No deferred calibration.
            if next.automatic_context() == job.expected {
                next.apply_automatic_volume();
            }
        }
        next.revision += 1;
        if next.player_settings != data.player_settings
            && let Err(error) = self.persist_native(&next)
        {
            // Keep the prior audible/persisted state. Do not spin on a cached
            // result after storage failure; expose truthful unavailable status.
            if let Some(data) = self.data.as_mut() {
                data.automatic_playback
                    .measurements
                    .insert(job.key.clone(), MeasurementState::Unavailable);
                data.revision += 1;
            }
            self.native_session.revision += 1;
            return Err(ApiError::new(503, error.kind, error.message));
        }
        self.data = Some(next);
        self.native_session.revision += 1;
        Ok(())
    }
}

#[cfg(all(test, feature = "native-host"))]
mod tests;

#[cfg(feature = "native-host")]
#[derive(Debug, Clone)]
pub(crate) struct AnalysisSignal {
    pub wake: std::sync::mpsc::SyncSender<()>,
    pub cancelled: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

#[cfg(feature = "native-host")]
impl AppState {
    pub(crate) fn notify_analysis(&self, cancel: bool) {
        if let Some(signal) = &self.analysis_signal {
            if cancel {
                signal
                    .cancelled
                    .store(true, std::sync::atomic::Ordering::Release);
            }
            if cancel
                || self
                    .data
                    .as_ref()
                    .is_some_and(|d| d.automatic_volume.enabled)
            {
                let _ = signal.wake.try_send(());
            }
        }
    }

    pub(crate) fn native_automatic_volume(
        &mut self,
        identity: &native_session::Identity,
        body: &Value,
    ) -> Result<Value, crate::native_host::ApiError> {
        use crate::native_host::ApiError;
        self.native_authorize(identity, true)?;
        #[derive(Deserialize)]
        #[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
        enum Intent {
            Enable { enabled: bool },
            Reference { context: AutomaticVolumeContext },
            Resume { context: AutomaticVolumeContext },
        }
        let intent: Intent = serde_json::from_value(body.clone())
            .map_err(|_| ApiError::invalid("自动音量请求无效"))?;
        let current = self
            .data
            .as_ref()
            .ok_or_else(|| ApiError::new(503, "state_unavailable", "Host 尚未初始化"))?;
        let mut next = current.clone();
        match intent {
            Intent::Enable { enabled } => {
                if enabled && !next.automatic_playback.scanner_available {
                    return Err(ApiError::new(
                        503,
                        "scanner_unavailable",
                        "此 Host 没有可用的原生音频分析器，请继续手动调节",
                    ));
                }
                if next.automatic_volume.enabled == enabled {
                    return self.native_snapshot(true);
                }
                next.automatic_volume.enabled = enabled;
                next.automatic_playback.analysis_epoch =
                    next.automatic_playback.analysis_epoch.saturating_add(1);
                // Enabling NEVER calibrates or changes current audible intent.
                // Re-enabling with a saved target protects this playback too.
                if enabled {
                    next.mark_manual_volume();
                }
            }
            Intent::Reference { context } | Intent::Resume { context } => {
                if current.automatic_context().as_ref() != Some(&context) {
                    return Err(ApiError::new(
                        409,
                        "stale_automatic_context",
                        "歌曲、音轨或音量已变化，请按当前状态重试",
                    ));
                }
                let status = current.automatic_snapshot();
                let reference = body["action"] == "reference";
                if (reference && !status.can_reference) || (!reference && !status.can_resume) {
                    return Err(ApiError::new(
                        409,
                        "automatic_volume_unavailable",
                        "请等待分析完成、取消静音，并使用 1～100% 的参考音量",
                    ));
                }
                let fact = current.current_measurement().ok_or_else(|| {
                    ApiError::new(409, "measurement_unavailable", "当前音轨分析不可用")
                })?;
                if reference {
                    let target = reference_target(
                        fact.integrated_lufs,
                        current.player_settings.volume_percent,
                    )
                    .ok_or_else(|| ApiError::invalid("基准音量无效"))?;
                    next.automatic_volume.target_lufs = Some(target);
                    next.automatic_volume.calibration_revision = next
                        .automatic_volume
                        .calibration_revision
                        .checked_add(1)
                        .filter(|r| *r <= MAX_SAFE_JSON_INTEGER)
                        .ok_or_else(|| ApiError::invalid("基准版本已耗尽"))?;
                    next.automatic_playback.manual_override = false;
                    // Deliberately leave volume and mute byte-for-byte unchanged.
                } else {
                    next.automatic_playback.manual_override = false;
                    next.apply_automatic_volume();
                }
                next.automatic_playback.intent_revision =
                    next.automatic_playback.intent_revision.saturating_add(1);
            }
        }
        next.revision += 1;
        self.persist_native(&next)
            .map_err(|e| ApiError::new(503, e.kind, e.message))?;
        self.data = Some(next);
        self.native_session.revision += 1;
        self.notify_analysis(true);
        self.native_snapshot(true)
    }
}
