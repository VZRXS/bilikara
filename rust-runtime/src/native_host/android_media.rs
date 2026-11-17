//! Optional Android media provisioning; no AppState or Host startup dependency.
use crate::{
    experimental_libav::{LibavMetadataProbe, ProbeError},
    media_routing,
};
use serde::Serialize;
use std::{path::Path, sync::OnceLock};

#[derive(Debug, Serialize)]
pub(crate) struct Capability {
    pub metadata: bool,
    pub packet_scan: bool,
    pub remux: bool,
    pub loudness: bool,
    pub cast: bool,
    pub l1: bool,
    pub reason: Option<&'static str>,
}

impl Capability {
    fn unavailable(reason: &'static str) -> Self {
        Self {
            metadata: false,
            packet_scan: false,
            remux: false,
            loudness: false,
            cast: false,
            l1: false,
            reason: Some(reason),
        }
    }
}

static CAPABILITY: OnceLock<Capability> = OnceLock::new();

fn negotiate(companion: &Path) -> Capability {
    if !companion.is_absolute() || !companion.is_file() {
        return Capability::unavailable("companion_missing");
    }
    // SAFETY: native shell supplies the same-build APK's nativeLibraryDir path.
    // No HTTP/JS input, PATH search, or application-data copy is accepted.
    match unsafe { LibavMetadataProbe::load(companion) } {
        Ok(probe) => Capability {
            metadata: true,
            packet_scan: probe.packet_scan_available(),
            remux: probe.copy_remux_available(),
            loudness: probe.loudness_available(),
            cast: probe.cast_mux_available() && probe.live_l1_available(),
            l1: probe.live_l1_available() && probe.cast_mux_available(),
            reason: if !probe.cast_mux_available() || !probe.live_l1_available() {
                Some("companion_cast_l1_unavailable")
            } else {
                None
            },
        },
        Err(error) => {
            // Keep loader paths and arbitrary loader text out of diagnostics.
            Capability::unavailable(if matches!(error, ProbeError::NegotiationFailed(_)) {
                "companion_negotiation_failed"
            } else {
                "companion_load_failed"
            })
        }
    }
}

/// Called before Android Host startup with the APK-installed companion path.
/// Missing or incompatible optional media libraries never prevent Host startup.
pub fn configure_android_media(companion: &Path) {
    CAPABILITY.get_or_init(|| {
        if media_routing::configure(media_routing::Configuration {
            mode: media_routing::Mode::Default,
            companion: Some(companion.to_owned()),
        })
        .is_err()
        {
            return Capability::unavailable("companion_configuration_failed");
        }
        negotiate(companion)
    });
}

/// JNI lookup failed. Retain existing Rust caching and local playback behavior.
pub fn android_media_unavailable() {
    CAPABILITY.get_or_init(|| Capability::unavailable("native_library_dir_unavailable"));
}

pub(crate) fn capability() -> Option<&'static Capability> {
    CAPABILITY.get()
}
