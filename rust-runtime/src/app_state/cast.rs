//! Persisted device choices. Addresses, credentials and active sessions never belong here.
use super::*;
pub(super) mod storage;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    #[default]
    Auto,
    File,
    Live,
}

/// What the receiver shows. `Composited` re-encodes the video with the
/// Audience overlays (a simulated mirror) and always uses live delivery.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Picture {
    #[default]
    Pure,
    Composited,
}
impl Picture {
    pub fn is_pure(&self) -> bool {
        *self == Self::Pure
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LearnedMode {
    File,
    Live,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Variant {
    Original,
    Uniform,
    FileMp4,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Vendor {
    #[default]
    Generic,
    Lebo,
    Dolphinstar,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct Device {
    pub last_used: u64,
    pub vendor_class: Vendor,
    pub mode: Mode,
    pub learned_mode: Option<LearnedMode>,
    pub learned_variant: Option<Variant>,
    pub learned_at: Option<String>,
    pub self_test_report_version: Option<u32>,
    /// Omitted while pure so files stay readable by versions without it.
    #[serde(skip_serializing_if = "Picture::is_pure")]
    pub picture: Picture,
}
#[cfg(feature = "native-host")]
impl Device {
    pub fn effective_mode(&self) -> Mode {
        if self.picture == Picture::Composited {
            return Mode::Live;
        }
        self.pure_mode()
    }
    /// The delivery of pure media (also after a composited cast is refused).
    pub fn pure_mode(&self) -> Mode {
        match self.mode {
            Mode::Auto => match self.learned_mode {
                Some(LearnedMode::Live) => Mode::Live,
                _ => Mode::File,
            },
            other => other,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Preferences {
    pub schema_version: u32,
    pub devices: BTreeMap<String, Device>,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            schema_version: 1,
            devices: BTreeMap::new(),
        }
    }
}
impl Preferences {
    #[cfg(feature = "native-host")]
    pub fn is_empty(&self) -> bool {
        self.devices.is_empty()
    }
    pub(super) fn validate(&self) -> Result<(), ExecuteError> {
        if self.schema_version != 1
            || self.devices.len() > 256
            || self.devices.iter().any(|(key, d)| {
                !valid_key(key)
                    || d.self_test_report_version.is_some_and(|v| v != 1)
                    || d.learned_at
                        .as_ref()
                        .is_some_and(|s| chrono::DateTime::parse_from_rfc3339(s).is_err())
            })
        {
            return Err(rejected(
                "invalid_cast_preferences",
                "Invalid cast device preferences",
            ));
        }
        Ok(())
    }
}
pub fn valid_key(key: &str) -> bool {
    key.len() == 32
        && key
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[cfg(feature = "native-host")]
impl AppState {
    pub(crate) fn cast_preferences(&self) -> Result<&Preferences, crate::native_host::ApiError> {
        self.data.as_ref().map(|d| &d.cast).ok_or_else(|| {
            crate::native_host::ApiError::new(503, "state_unavailable", "Host is not initialized")
        })
    }

    pub(crate) fn cast_set_session_device(
        &mut self,
        key: &str,
        revision: u64,
        device: Device,
    ) -> Result<(), crate::native_host::ApiError> {
        let data = self.data.as_mut().ok_or_else(|| {
            crate::native_host::ApiError::new(503, "state_unavailable", "Host not initialized")
        })?;
        if data.revision != revision {
            return Err(crate::native_host::ApiError::new(
                409,
                "cast_revision_conflict",
                "Refresh device preferences",
            ));
        }
        let devices = &mut self.native_session.cast.session_devices;
        if !devices.contains_key(key) && devices.len() >= 256 {
            let oldest = devices
                .iter()
                .min_by_key(|(_, d)| d.last_used)
                .map(|(key, _)| key.clone())
                .unwrap();
            devices.remove(&oldest);
        }
        devices.insert(key.to_owned(), device);
        data.revision += 1;
        self.native_session.revision += 1;
        Ok(())
    }

    pub(crate) fn cast_set_device(
        &mut self,
        key: &str,
        expected_revision: u64,
        device: Device,
    ) -> Result<(), crate::native_host::ApiError> {
        use crate::native_host::ApiError;
        let mut next = self
            .data
            .clone()
            .ok_or_else(|| ApiError::new(503, "state_unavailable", "Host is not initialized"))?;
        if next.revision != expected_revision {
            return Err(ApiError::new(
                409,
                "cast_revision_conflict",
                "Device preferences changed; refresh and retry",
            ));
        }
        if !next.cast.devices.contains_key(key) && next.cast.devices.len() >= 256 {
            let oldest = next
                .cast
                .devices
                .iter()
                .min_by_key(|(_, d)| {
                    (
                        d.mode != Mode::Auto
                            || d.learned_mode.is_some()
                            || d.learned_variant.is_some(),
                        d.last_used,
                    )
                })
                .map(|(key, _)| key.clone())
                .unwrap();
            next.cast.devices.remove(&oldest);
        }
        next.cast.devices.insert(key.to_owned(), device);
        next.cast
            .validate()
            .map_err(|_| ApiError::invalid("Invalid cast device preferences"))?;
        next.revision += 1;
        if self
            .cast_storage
            .as_ref()
            .is_some_and(|storage| !storage.writable())
        {
            return Err(ApiError::new(
                503,
                "persistence_error",
                "Original cast preferences protected",
            ));
        }
        if self.native_startup_pending {
            self.cast_startup_dirty = true;
        } else if let Some(storage) = &self.cast_storage {
            storage.save(&next.cast).map_err(|_| {
                ApiError::new(503, "persistence_error", "Cannot persist cast preferences")
            })?;
        }
        self.data = Some(next);
        self.native_session.revision += 1;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn self_test_mp4_variant_round_trips_without_changing_mode_selection() {
        let device = Device {
            learned_mode: Some(LearnedMode::File),
            learned_variant: Some(Variant::FileMp4),
            ..Default::default()
        };
        let value = serde_json::to_value(&device).unwrap();
        assert_eq!(value["learned_variant"], "file_mp4");
        let restored: Device = serde_json::from_value(value).unwrap();
        assert_eq!(restored, device);
        #[cfg(feature = "native-host")]
        assert_eq!(restored.effective_mode(), Mode::File);
    }

    #[test]
    fn composited_picture_forces_live_and_pure_stays_out_of_the_file() {
        let pure = serde_json::to_value(Device::default()).unwrap();
        assert!(
            pure.get("picture").is_none(),
            "older readers deny unknown fields"
        );
        let device = Device {
            mode: Mode::File,
            learned_mode: Some(LearnedMode::File),
            picture: Picture::Composited,
            ..Default::default()
        };
        let value = serde_json::to_value(&device).unwrap();
        assert_eq!(value["picture"], "composited");
        let restored: Device = serde_json::from_value(value).unwrap();
        assert_eq!(restored, device);
        #[cfg(feature = "native-host")]
        assert_eq!(restored.effective_mode(), Mode::Live);
    }

    fn seed() -> AppStateSeed {
        serde_json::from_value(
            json!({"session_started_at":1,"session_played_file":"old.json","updated_at":1}),
        )
        .unwrap()
    }

    #[test]
    fn old_seed_without_cast_loads_and_round_trips_without_new_fields() {
        let seed = seed();
        let value = serde_json::to_value(&seed).unwrap();
        assert!(value.get("cast").is_none());
        let mut app = AppState::default();
        assert!(
            app.execute(AppStateRequest::Initialize {
                schema_version: 1,
                state: Box::new(seed)
            })
            .error()
            .is_none()
        );
        assert_eq!(app.data.as_ref().unwrap().cast, Preferences::default());
        assert!(
            serde_json::to_value(app.data.as_ref().unwrap().snapshot().unwrap())
                .unwrap()
                .get("cast")
                .is_none()
        );
    }

    #[cfg(feature = "native-host")]
    #[test]
    fn legacy_checkpoint_load_and_device_preferences_persist_with_revision_conflicts() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join(".tmp")
            .join(format!(
                "cast-checkpoint-{}",
                crate::native_host::token().unwrap()
            ));
        std::fs::create_dir_all(&root).unwrap();
        let key = "0123456789abcdef0123456789abcdef";
        let mut app = AppState::default();
        assert!(app.initialize_native(&root, seed()).error().is_none());
        drop(app);
        let original = std::fs::read(root.join("host-state.json")).unwrap();
        assert!(!String::from_utf8_lossy(&original).contains("\"cast\""));
        let mut app = AppState::default();
        assert!(app.initialize_native(&root, seed()).error().is_none());
        assert_eq!(app.cast_preferences().unwrap(), &Preferences::default());
        assert!(!app.native_session.cast.visible());
        let revision = app.data.as_ref().unwrap().revision;
        let device = Device {
            last_used: 1,
            vendor_class: Vendor::Generic,
            mode: Mode::Auto,
            learned_mode: Some(LearnedMode::Live),
            learned_variant: Some(Variant::Original),
            learned_at: Some("2026-11-15T00:00:00Z".into()),
            self_test_report_version: Some(1),
            picture: Picture::Pure,
        };
        app.cast_set_device(key, revision, device.clone()).unwrap();
        assert_eq!(
            app.cast_preferences().unwrap().devices[key].effective_mode(),
            Mode::Live
        );
        assert_eq!(
            app.cast_set_device(key, revision, Device::default())
                .unwrap_err()
                .code,
            "cast_revision_conflict"
        );
        drop(app);
        let mut app = AppState::default();
        assert!(app.initialize_native(&root, seed()).error().is_none());
        assert_eq!(app.cast_preferences().unwrap().devices[key], device);
        let bytes = std::fs::read(root.join("host-state.json")).unwrap();
        let rev = app.data.as_ref().unwrap().revision;
        assert!(
            app.cast_set_device("192.168.1.2", rev, Device::default())
                .is_err()
        );
        assert_eq!(bytes, std::fs::read(root.join("host-state.json")).unwrap());
        drop(app);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(feature = "native-host")]
    #[test]
    fn separate_preferences_preserve_legacy_checkpoint_and_corruption_never_blocks_host() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join(".tmp")
            .join(format!(
                "cast-storage-{}",
                crate::native_host::token().unwrap()
            ));
        std::fs::create_dir_all(&root).unwrap();
        let key = "0123456789abcdef0123456789abcdef";
        let mut app = AppState::default();
        assert!(app.initialize_native(&root, seed()).error().is_none());
        let checkpoint = std::fs::read(root.join("host-state.json")).unwrap();
        let original = Device {
            mode: Mode::Live,
            ..Default::default()
        };
        app.cast_set_device(key, app.data.as_ref().unwrap().revision, original.clone())
            .unwrap();
        let preferences = std::fs::read(root.join("cast-devices.json")).unwrap();
        app.cast_set_device(key, app.data.as_ref().unwrap().revision, Device::default())
            .unwrap();
        assert_eq!(
            preferences,
            std::fs::read(root.join("cast-devices.v1.backup.json")).unwrap()
        );
        // AppStateSeed is exactly the old strict seed (deny_unknown_fields),
        // not a permissive JSON value that could hide downgrade incompatibility.
        let saved: Value = serde_json::from_slice(&checkpoint).unwrap();
        let _: AppStateSeed = serde_json::from_value(saved["state"].clone()).unwrap();
        assert!(!String::from_utf8_lossy(&checkpoint).contains("cast"));
        assert_eq!(
            checkpoint,
            std::fs::read(root.join("host-state.json")).unwrap()
        );
        assert!(
            !serde_json::to_string(&app.data.as_ref().unwrap().persistence_snapshot())
                .unwrap()
                .contains("cast")
        );
        drop(app);
        std::fs::write(root.join("cast-devices.json"), b"{broken").unwrap();
        let mut app = AppState::default();
        // next F2 inspects files inside a pending startup transaction. A normal
        // committed restart updates its playback generation checkpoint; the
        // pending path must preserve every original byte, including corruption.
        assert!(
            app.initialize_native_startup(&root, seed())
                .error()
                .is_none()
        );
        assert_eq!(app.cast_preferences().unwrap(), &Preferences::default());
        let before = app.data.as_ref().unwrap().revision;
        assert_eq!(
            app.cast_set_device(key, before, original).unwrap_err().code,
            "persistence_error"
        );
        assert_eq!(app.data.as_ref().unwrap().revision, before);
        assert_eq!(
            std::fs::read(root.join("cast-devices.json")).unwrap(),
            b"{broken"
        );
        assert_eq!(
            checkpoint,
            std::fs::read(root.join("host-state.json")).unwrap()
        );
        drop(app);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(feature = "native-host")]
    #[test]
    fn full_preferences_evict_oldest_automatic_before_manual_or_learned() {
        let mut app = AppState::default();
        app.execute(AppStateRequest::Initialize {
            schema_version: 1,
            state: Box::new(seed()),
        });
        for index in 0..256 {
            app.cast_set_device(
                &format!("{index:032x}"),
                app.data.as_ref().unwrap().revision,
                Device {
                    mode: if index == 0 { Mode::Live } else { Mode::Auto },
                    last_used: index,
                    ..Default::default()
                },
            )
            .unwrap();
        }
        app.cast_set_device(
            &format!("{:032x}", 256),
            app.data.as_ref().unwrap().revision,
            Device::default(),
        )
        .unwrap();
        let prefs = app.cast_preferences().unwrap();
        assert_eq!(prefs.devices.len(), 256);
        assert!(prefs.devices.contains_key(&format!("{:032x}", 0)));
        assert!(!prefs.devices.contains_key(&format!("{:032x}", 1)));
        assert!(prefs.devices.contains_key(&format!("{:032x}", 256)));
    }

    #[cfg(feature = "native-host")]
    #[test]
    fn casting_rejects_pitch_delay_and_stale_local_observations_without_mutation() {
        let mut app = AppState::default();
        app.execute(AppStateRequest::Initialize {
            schema_version: 1,
            state: Box::new(seed()),
        });
        app.native_session.cast.owns_playback = true;
        let before = app.data.as_ref().unwrap().snapshot().unwrap();
        for request in [
            AppStateRequest::SetKeyShift {
                schema_version: 1,
                key_shift: 2,
                now: 2.0,
            },
            AppStateRequest::ApplyAvDelay {
                schema_version: 1,
                action: AvDelayCommand::Adjust { delta_ms: 20 },
                now: 2.0,
            },
        ] {
            assert_eq!(
                app.execute(request).error().unwrap().kind,
                "cast_setting_unavailable"
            );
            assert_eq!(app.data.as_ref().unwrap().snapshot().unwrap(), before);
        }
        assert_eq!(
            app.execute(AppStateRequest::ApplyPlayerStatusObservation {
                schema_version: 1,
                expected_playback_generation: before.playback_generation,
                item_id: "stale-local-player".into(),
                is_paused: false,
                current_time: 99.0,
                duration: 120.0,
                now: 2.0,
            })
            .error()
            .unwrap()
            .kind,
            "cast_owns_playback"
        );
        assert_eq!(app.data.as_ref().unwrap().snapshot().unwrap(), before);
    }
}
