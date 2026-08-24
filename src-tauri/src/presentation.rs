use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

#[cfg(target_os = "windows")]
use windows_sys::Win32::Devices::Display::{
    DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME, DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME,
    DISPLAYCONFIG_MODE_INFO, DISPLAYCONFIG_PATH_INFO, DISPLAYCONFIG_SOURCE_DEVICE_NAME,
    DISPLAYCONFIG_TARGET_DEVICE_NAME, DisplayConfigGetDeviceInfo, GetDisplayConfigBufferSizes,
    QDC_ONLY_ACTIVE_PATHS, QueryDisplayConfig,
};
#[cfg(target_os = "windows")]
use windows_sys::Win32::Foundation::ERROR_INSUFFICIENT_BUFFER;

const STATE_EVENT: &str = "bilikara-presentation-state";
const HOST_COMPOSITION_EVENT: &str = "bilikara-presentation-host-composition";
const HOST_COMMAND_EVENT: &str = "bilikara-presentation-host-command";
const PLAYBACK_STATE_EVENT: &str = "bilikara-presentation-playback-state";
const MAX_PENDING_COMMANDS: usize = 32;
const MAX_SAFE_JS_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_MEDIA_SECONDS: f64 = 7.0 * 24.0 * 60.0 * 60.0;
const CONTROLLER_WIDTH: f64 = 520.0;
const CONTROLLER_HEIGHT: f64 = 720.0;
const ACTIVATION_READY_TIMEOUT: Duration = Duration::from_secs(10);
const RECOVERY_FINALIZATION_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
struct MonitorGeometry {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

impl MonitorGeometry {
    fn from_monitor(monitor: &tauri::window::Monitor) -> Self {
        Self {
            x: monitor.position().x,
            y: monitor.position().y,
            width: monitor.size().width,
            height: monitor.size().height,
        }
    }

    fn identity_suffix(self) -> String {
        format!("{}:{}:{}:{}", self.x, self.y, self.width, self.height)
    }

    fn same_origin(self, other: Self) -> bool {
        self.x == other.x && self.y == other.y
    }

    fn intersects(self, other: Self) -> bool {
        let self_right = i64::from(self.x) + i64::from(self.width);
        let self_bottom = i64::from(self.y) + i64::from(self.height);
        let other_right = i64::from(other.x) + i64::from(other.width);
        let other_bottom = i64::from(other.y) + i64::from(other.height);
        i64::from(self.x) < other_right
            && self_right > i64::from(other.x)
            && i64::from(self.y) < other_bottom
            && self_bottom > i64::from(other.y)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct NativeDisplayMetadata {
    id: String,
    name: String,
    mirrored: bool,
    identity_stable: bool,
}

#[cfg(any(target_os = "windows", test))]
fn display_source_is_mirrored(active_path_count: usize, resolved_target_count: usize) -> bool {
    active_path_count != 1 || resolved_target_count != 1
}

#[derive(Clone, Debug)]
struct DisplayCandidate {
    monitor: tauri::window::Monitor,
    geometry: MonitorGeometry,
    base_id: String,
    name: String,
    identity_stable: bool,
    mirrored: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DisplayIdentityQuality {
    Stable,
    Unstable,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresentationDisplay {
    pub id: String,
    pub name: String,
    pub position_x: i32,
    pub position_y: i32,
    pub width: u32,
    pub height: u32,
    pub scale_factor: f64,
    pub controller: bool,
    pub primary: bool,
    pub selectable: bool,
    pub mirrored: bool,
    pub identity_stable: bool,
    pub identity_quality: DisplayIdentityQuality,
}

#[derive(Clone, Debug)]
struct PresentationDisplayRecord {
    display: PresentationDisplay,
    monitor: tauri::window::Monitor,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresentationDisplayInfo {
    pub monitor_count: usize,
    pub displays: Vec<PresentationDisplay>,
    pub controller_display_id: Option<String>,
    pub recommended_display_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PresentationMode {
    #[default]
    SingleScreen,
    LocalDualScreen,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PresentationPhase {
    #[default]
    Inactive,
    Activating,
    Active,
    Recovering,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PlaybackAuthorityIdentity {
    #[default]
    Host,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MediaRendererOwner {
    #[default]
    Host,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PresentationRecoveryReason {
    User,
    DisplayDisconnected,
    ControllerClosed,
    ActivationFailed,
    CommandFailed,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresentationSession {
    pub mode: PresentationMode,
    pub phase: PresentationPhase,
    pub generation: u64,
    pub selected_output_display_id: Option<String>,
    pub controller_display_id: Option<String>,
    pub host_ready: bool,
    pub controller_ready: bool,
    pub last_accepted_command_sequence: u64,
    pub last_applied_command_sequence: u64,
    pub playback_authority: PlaybackAuthorityIdentity,
    pub media_renderer_owner: MediaRendererOwner,
    pub recovery_reason: Option<PresentationRecoveryReason>,
}

impl Default for PresentationSession {
    fn default() -> Self {
        Self {
            mode: PresentationMode::SingleScreen,
            phase: PresentationPhase::Inactive,
            generation: 0,
            selected_output_display_id: None,
            controller_display_id: None,
            host_ready: true,
            controller_ready: false,
            last_accepted_command_sequence: 0,
            last_applied_command_sequence: 0,
            playback_authority: PlaybackAuthorityIdentity::Host,
            media_renderer_owner: MediaRendererOwner::Host,
            recovery_reason: None,
        }
    }
}

#[derive(Clone, Debug)]
struct HostWindowPlacement {
    position: tauri::PhysicalPosition<i32>,
    size: tauri::PhysicalSize<u32>,
    decorations: bool,
    resizable: bool,
    fullscreen: bool,
    maximized: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HostComposition {
    Combined,
    StageOnly,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ControllerCommand {
    Play,
    Pause,
    SeekRelative { delta_seconds: f64 },
    SeekAbsolute { target_seconds: f64 },
    NextTrack,
    SetVolume { volume_percent: u8, muted: bool },
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ControllerCommandRequest {
    generation: u64,
    sequence: u64,
    command: ControllerCommand,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerCommandEnvelope {
    generation: u64,
    sequence: u64,
    target: PlaybackAuthorityIdentity,
    command: ControllerCommand,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerCommandAccepted {
    generation: u64,
    sequence: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ControllerPlaybackState {
    pub revision: u64,
    pub item_identity: Option<String>,
    pub title: String,
    pub paused: bool,
    pub current_time_seconds: f64,
    pub duration_seconds: Option<f64>,
    pub volume_percent: u8,
    pub muted: bool,
    pub can_skip: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerPlaybackStateEnvelope {
    generation: u64,
    sequence: u64,
    state: ControllerPlaybackState,
}

#[derive(Clone, Debug)]
struct PlaybackStatePublication {
    envelope: ControllerPlaybackStateEnvelope,
    previous_state: Option<ControllerPlaybackStateEnvelope>,
    previous_sequence: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PresentationStateEvent {
    session: PresentationSession,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostCompositionEvent {
    generation: u64,
    composition: HostComposition,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum NativeLifecycleOwner {
    Activation(u64),
    Recovery(u64),
}

#[derive(Clone, Debug)]
struct RecoveryClaim {
    session: PresentationSession,
    started: bool,
    owns_native_lifecycle: bool,
}

#[derive(Default)]
struct PresentationRuntime {
    session: PresentationSession,
    host_placement: Option<HostWindowPlacement>,
    playback_state: Option<ControllerPlaybackStateEnvelope>,
    playback_state_sequence: u64,
    pending_commands: VecDeque<ControllerCommandEnvelope>,
    in_flight_command_sequence: Option<u64>,
    placement_prepared: bool,
    activation_published: bool,
    activation_attempt_generation: Option<u64>,
    native_lifecycle_owner: Option<NativeLifecycleOwner>,
    host_window_restored: bool,
    activation_finalization_claimed: bool,
    shutting_down: bool,
}

#[derive(Default)]
pub struct PresentationState {
    runtime: Mutex<PresentationRuntime>,
}

impl PresentationState {
    fn lock_runtime(&self) -> Result<std::sync::MutexGuard<'_, PresentationRuntime>, String> {
        self.runtime
            .lock()
            .map_err(|_| "presentation session lock is poisoned".to_string())
    }

    pub fn snapshot(&self) -> Result<PresentationSession, String> {
        Ok(self.lock_runtime()?.session.clone())
    }

    fn begin_activation(
        &self,
        selected_display_id: String,
        controller_display_id: String,
        host_placement: HostWindowPlacement,
    ) -> Result<PresentationSession, String> {
        let mut runtime = self.lock_runtime()?;
        if runtime.activation_attempt_generation.is_some() {
            return Err("a presentation activation attempt is still in flight".to_string());
        }
        if runtime.native_lifecycle_owner.is_some() {
            return Err("a presentation native lifecycle transition is still active".to_string());
        }
        if runtime.session.phase != PresentationPhase::Inactive {
            return Err("a presentation transition is already active".to_string());
        }
        if runtime.shutting_down {
            return Err("the application is shutting down".to_string());
        }
        let generation = next_sequence(runtime.session.generation, "presentation generation")?;
        runtime.session = PresentationSession {
            mode: PresentationMode::LocalDualScreen,
            phase: PresentationPhase::Activating,
            generation,
            selected_output_display_id: Some(selected_display_id),
            controller_display_id: Some(controller_display_id),
            host_ready: false,
            controller_ready: false,
            last_accepted_command_sequence: 0,
            last_applied_command_sequence: 0,
            playback_authority: PlaybackAuthorityIdentity::Host,
            media_renderer_owner: MediaRendererOwner::Host,
            recovery_reason: None,
        };
        runtime.host_placement = Some(host_placement);
        runtime.playback_state = None;
        runtime.playback_state_sequence = 0;
        runtime.pending_commands.clear();
        runtime.in_flight_command_sequence = None;
        runtime.placement_prepared = false;
        runtime.activation_published = false;
        runtime.activation_attempt_generation = Some(generation);
        runtime.native_lifecycle_owner = Some(NativeLifecycleOwner::Activation(generation));
        runtime.host_window_restored = false;
        runtime.activation_finalization_claimed = false;
        Ok(runtime.session.clone())
    }

    fn mark_placement_prepared(&self, generation: u64) -> Result<PresentationSession, String> {
        let mut runtime = self.lock_runtime()?;
        if runtime.session.generation != generation
            || runtime.session.phase != PresentationPhase::Activating
            || runtime.native_lifecycle_owner != Some(NativeLifecycleOwner::Activation(generation))
        {
            return Err("presentation placement generation is stale".to_string());
        }
        runtime.placement_prepared = true;
        Ok(runtime.session.clone())
    }

    fn mark_ready(
        &self,
        generation: u64,
        role: WindowRole,
    ) -> Result<(PresentationSession, bool), String> {
        let mut runtime = self.lock_runtime()?;
        if runtime.session.generation != generation
            || runtime.session.phase != PresentationPhase::Activating
        {
            return Err("presentation readiness generation is stale".to_string());
        }
        match role {
            WindowRole::Host => runtime.session.host_ready = true,
            WindowRole::Controller => runtime.session.controller_ready = true,
        }
        let should_finalize = claim_activation_finalization(&mut runtime);
        Ok((runtime.session.clone(), should_finalize))
    }

    fn mark_activation_published(
        &self,
        generation: u64,
    ) -> Result<(PresentationSession, bool), String> {
        let mut runtime = self.lock_runtime()?;
        if runtime.session.generation != generation
            || runtime.session.phase != PresentationPhase::Activating
            || !runtime.placement_prepared
            || runtime.native_lifecycle_owner != Some(NativeLifecycleOwner::Activation(generation))
        {
            return Err("presentation activation publication is stale".to_string());
        }
        if runtime.activation_published {
            return Err("presentation activation was already published".to_string());
        }
        runtime.activation_published = true;
        let should_finalize = claim_activation_finalization(&mut runtime);
        Ok((runtime.session.clone(), should_finalize))
    }

    fn complete_activation(&self, generation: u64) -> Result<PresentationSession, String> {
        let mut runtime = self.lock_runtime()?;
        if runtime.session.generation != generation
            || runtime.session.phase != PresentationPhase::Activating
            || !runtime.session.host_ready
            || !runtime.session.controller_ready
            || !runtime.placement_prepared
            || !runtime.activation_published
            || !runtime.activation_finalization_claimed
            || runtime.native_lifecycle_owner != Some(NativeLifecycleOwner::Activation(generation))
        {
            return Err("presentation activation is not ready to complete".to_string());
        }
        runtime.session.phase = PresentationPhase::Active;
        runtime.activation_published = false;
        runtime.activation_finalization_claimed = false;
        if runtime.activation_attempt_generation != Some(generation) {
            runtime.native_lifecycle_owner = None;
        }
        Ok(runtime.session.clone())
    }

    fn finish_activation_attempt(&self, generation: u64) -> Result<Option<u64>, String> {
        let mut runtime = self.lock_runtime()?;
        if runtime.activation_attempt_generation != Some(generation) {
            return Err("presentation activation attempt is stale".to_string());
        }
        runtime.activation_attempt_generation = None;
        if runtime.session.phase == PresentationPhase::Recovering {
            let recovery_generation = runtime.session.generation;
            runtime.native_lifecycle_owner =
                Some(NativeLifecycleOwner::Recovery(recovery_generation));
            return Ok(Some(recovery_generation));
        }
        if runtime.native_lifecycle_owner == Some(NativeLifecycleOwner::Activation(generation)) {
            runtime.native_lifecycle_owner = None;
        }
        Ok(None)
    }

    fn ensure_activation_native_owner(&self, generation: u64) -> Result<(), String> {
        let runtime = self.lock_runtime()?;
        if runtime.session.generation != generation
            || runtime.session.phase != PresentationPhase::Activating
            || runtime.native_lifecycle_owner != Some(NativeLifecycleOwner::Activation(generation))
        {
            return Err("presentation activation native lifecycle is stale".to_string());
        }
        Ok(())
    }

    fn ensure_active_generation(&self, generation: u64) -> Result<(), String> {
        let runtime = self.lock_runtime()?;
        if runtime.session.generation != generation
            || runtime.session.phase != PresentationPhase::Active
        {
            return Err("presentation active generation is stale".to_string());
        }
        Ok(())
    }

    fn begin_recovery(
        &self,
        expected_generation: Option<u64>,
        reason: PresentationRecoveryReason,
    ) -> Result<RecoveryClaim, String> {
        let mut runtime = self.lock_runtime()?;
        if let Some(expected_generation) = expected_generation
            && runtime.session.generation != expected_generation
        {
            return Err("presentation recovery generation is stale".to_string());
        }
        if runtime.session.phase == PresentationPhase::Inactive {
            return Ok(RecoveryClaim {
                session: runtime.session.clone(),
                started: false,
                owns_native_lifecycle: false,
            });
        }
        if runtime.session.phase == PresentationPhase::Recovering {
            return Ok(RecoveryClaim {
                session: runtime.session.clone(),
                started: false,
                owns_native_lifecycle: matches!(
                    runtime.native_lifecycle_owner,
                    Some(NativeLifecycleOwner::Recovery(generation))
                        if generation == runtime.session.generation
                ),
            });
        }
        let previous_generation = runtime.session.generation;
        let activation_attempt_in_flight =
            runtime.activation_attempt_generation == Some(previous_generation);
        let generation = next_sequence(runtime.session.generation, "presentation generation")?;
        runtime.session.phase = PresentationPhase::Recovering;
        runtime.session.generation = generation;
        runtime.session.host_ready = false;
        runtime.session.controller_ready = false;
        runtime.session.last_accepted_command_sequence = 0;
        runtime.session.last_applied_command_sequence = 0;
        runtime.session.recovery_reason = Some(reason);
        runtime.playback_state = None;
        runtime.playback_state_sequence = 0;
        runtime.pending_commands.clear();
        runtime.in_flight_command_sequence = None;
        runtime.placement_prepared = false;
        runtime.activation_published = false;
        runtime.host_window_restored = false;
        runtime.activation_finalization_claimed = false;
        if activation_attempt_in_flight {
            runtime.native_lifecycle_owner =
                Some(NativeLifecycleOwner::Activation(previous_generation));
        } else {
            runtime.native_lifecycle_owner = Some(NativeLifecycleOwner::Recovery(generation));
        }
        Ok(RecoveryClaim {
            session: runtime.session.clone(),
            started: true,
            owns_native_lifecycle: !activation_attempt_in_flight,
        })
    }

    fn ensure_recovery_native_owner(&self, generation: u64) -> Result<(), String> {
        let runtime = self.lock_runtime()?;
        if runtime.session.generation != generation
            || runtime.session.phase != PresentationPhase::Recovering
            || runtime.activation_attempt_generation.is_some()
            || runtime.native_lifecycle_owner != Some(NativeLifecycleOwner::Recovery(generation))
        {
            return Err("presentation recovery native lifecycle is stale".to_string());
        }
        Ok(())
    }

    fn mark_recovery_host_ready(&self, generation: u64) -> Result<PresentationSession, String> {
        let mut runtime = self.lock_runtime()?;
        if runtime.session.generation != generation
            || runtime.session.phase != PresentationPhase::Recovering
        {
            return Err("presentation recovery generation is stale".to_string());
        }
        runtime.session.host_ready = true;
        Ok(runtime.session.clone())
    }

    fn recovery_placement(&self, generation: u64) -> Result<Option<HostWindowPlacement>, String> {
        let runtime = self.lock_runtime()?;
        if runtime.session.generation != generation
            || runtime.session.phase != PresentationPhase::Recovering
        {
            return Err("presentation recovery generation is stale".to_string());
        }
        Ok(runtime.host_placement.clone())
    }

    fn host_window_restored(&self, generation: u64) -> Result<bool, String> {
        let runtime = self.lock_runtime()?;
        if runtime.session.generation != generation
            || runtime.session.phase != PresentationPhase::Recovering
        {
            return Err("presentation recovery generation is stale".to_string());
        }
        Ok(runtime.host_window_restored)
    }

    fn mark_host_window_restored(&self, generation: u64) -> Result<(), String> {
        let mut runtime = self.lock_runtime()?;
        if runtime.session.generation != generation
            || runtime.session.phase != PresentationPhase::Recovering
        {
            return Err("presentation recovery generation is stale".to_string());
        }
        runtime.host_window_restored = true;
        Ok(())
    }

    fn complete_recovery(&self, generation: u64) -> Result<PresentationSession, String> {
        let mut runtime = self.lock_runtime()?;
        if runtime.session.generation != generation
            || runtime.session.phase != PresentationPhase::Recovering
            || !runtime.session.host_ready
            || !runtime.host_window_restored
            || runtime.activation_attempt_generation.is_some()
            || runtime.native_lifecycle_owner != Some(NativeLifecycleOwner::Recovery(generation))
        {
            return Err("presentation recovery generation is stale".to_string());
        }
        let reason = runtime.session.recovery_reason;
        Ok(reset_runtime_to_inactive(&mut runtime, generation, reason))
    }

    fn force_complete_recovery(&self, generation: u64) -> Result<PresentationSession, String> {
        let mut runtime = self.lock_runtime()?;
        if runtime.session.generation != generation
            || runtime.session.phase != PresentationPhase::Recovering
            || runtime.activation_attempt_generation.is_some()
            || runtime.native_lifecycle_owner != Some(NativeLifecycleOwner::Recovery(generation))
        {
            return Err("presentation recovery generation is stale".to_string());
        }
        let reason = runtime.session.recovery_reason;
        Ok(reset_runtime_to_inactive(&mut runtime, generation, reason))
    }

    fn enqueue_command(
        &self,
        request: ControllerCommandRequest,
    ) -> Result<(ControllerCommandAccepted, Option<ControllerCommandEnvelope>), String> {
        validate_controller_command(&request.command)?;
        let mut runtime = self.lock_runtime()?;
        if runtime.session.generation != request.generation
            || runtime.session.phase != PresentationPhase::Active
        {
            return Err("controller command generation is stale".to_string());
        }
        if runtime.pending_commands.len() >= MAX_PENDING_COMMANDS {
            return Err("the Controller command queue is full".to_string());
        }
        let expected_sequence = next_sequence(
            runtime.session.last_accepted_command_sequence,
            "controller command sequence",
        )?;
        if request.sequence != expected_sequence {
            return Err("controller command sequence is stale or out of order".to_string());
        }
        runtime.session.last_accepted_command_sequence = request.sequence;
        let envelope = ControllerCommandEnvelope {
            generation: request.generation,
            sequence: request.sequence,
            target: PlaybackAuthorityIdentity::Host,
            command: request.command,
        };
        runtime.pending_commands.push_back(envelope.clone());
        let emit = if runtime.in_flight_command_sequence.is_none() {
            runtime.in_flight_command_sequence = Some(envelope.sequence);
            Some(envelope)
        } else {
            None
        };
        Ok((
            ControllerCommandAccepted {
                generation: request.generation,
                sequence: request.sequence,
            },
            emit,
        ))
    }

    fn acknowledge_command(
        &self,
        generation: u64,
        sequence: u64,
    ) -> Result<(PresentationSession, Option<ControllerCommandEnvelope>), String> {
        let mut runtime = self.lock_runtime()?;
        if runtime.session.generation != generation
            || runtime.session.phase != PresentationPhase::Active
        {
            return Err("controller command generation is stale".to_string());
        }
        let expected_sequence = next_sequence(
            runtime.session.last_applied_command_sequence,
            "controller command sequence",
        )?;
        let queue_head = runtime
            .pending_commands
            .front()
            .map(|command| command.sequence);
        if sequence != expected_sequence
            || queue_head != Some(sequence)
            || runtime.in_flight_command_sequence != Some(sequence)
        {
            return Err("controller command acknowledgement is stale or out of order".to_string());
        }
        runtime.pending_commands.pop_front();
        runtime.session.last_applied_command_sequence = sequence;
        runtime.in_flight_command_sequence = runtime
            .pending_commands
            .front()
            .map(|command| command.sequence);
        Ok((
            runtime.session.clone(),
            runtime.pending_commands.front().cloned(),
        ))
    }

    fn publish_playback_state(
        &self,
        generation: u64,
        candidate: ControllerPlaybackState,
    ) -> Result<PlaybackStatePublication, String> {
        validate_playback_state(&candidate)?;
        let mut runtime = self.lock_runtime()?;
        if runtime.session.generation != generation
            || !matches!(
                runtime.session.phase,
                PresentationPhase::Activating | PresentationPhase::Active
            )
        {
            return Err("controller playback state generation is stale".to_string());
        }
        if runtime
            .playback_state
            .as_ref()
            .is_some_and(|current| current.state.revision >= candidate.revision)
        {
            return Err("controller playback state revision is stale".to_string());
        }
        let previous_sequence = runtime.playback_state_sequence;
        let previous_state = runtime.playback_state.clone();
        runtime.playback_state_sequence =
            next_sequence(previous_sequence, "Controller playback state sequence")?;
        let envelope = ControllerPlaybackStateEnvelope {
            generation,
            sequence: runtime.playback_state_sequence,
            state: candidate,
        };
        runtime.playback_state = Some(envelope.clone());
        Ok(PlaybackStatePublication {
            envelope,
            previous_state,
            previous_sequence,
        })
    }

    fn rollback_playback_state(
        &self,
        publication: &PlaybackStatePublication,
    ) -> Result<(), String> {
        let mut runtime = self.lock_runtime()?;
        if runtime.session.generation != publication.envelope.generation
            || runtime.playback_state.as_ref() != Some(&publication.envelope)
            || runtime.playback_state_sequence != publication.envelope.sequence
        {
            return Err("Controller playback state reservation was superseded".to_string());
        }
        runtime.playback_state = publication.previous_state.clone();
        runtime.playback_state_sequence = publication.previous_sequence;
        Ok(())
    }

    fn playback_state(
        &self,
        generation: u64,
    ) -> Result<Option<ControllerPlaybackStateEnvelope>, String> {
        let runtime = self.lock_runtime()?;
        if runtime.session.generation != generation
            || !matches!(
                runtime.session.phase,
                PresentationPhase::Activating | PresentationPhase::Active
            )
        {
            return Err("controller playback state generation is stale".to_string());
        }
        Ok(runtime.playback_state.clone())
    }

    fn mark_shutting_down(&self) {
        if let Ok(mut runtime) = self.runtime.lock() {
            runtime.shutting_down = true;
            let generation = next_sequence(runtime.session.generation, "presentation generation")
                .unwrap_or(MAX_SAFE_JS_INTEGER);
            runtime.session = inactive_session(generation, runtime.session.recovery_reason);
            runtime.host_placement = None;
            runtime.playback_state = None;
            runtime.playback_state_sequence = 0;
            runtime.pending_commands.clear();
            runtime.in_flight_command_sequence = None;
            runtime.placement_prepared = false;
            runtime.activation_published = false;
            runtime.activation_attempt_generation = None;
            runtime.native_lifecycle_owner = None;
            runtime.host_window_restored = false;
            runtime.activation_finalization_claimed = false;
        }
    }

    fn is_shutting_down(&self) -> bool {
        self.runtime
            .lock()
            .map(|runtime| runtime.shutting_down)
            .unwrap_or(true)
    }

    pub(crate) fn allows_manual_fullscreen(&self) -> bool {
        self.runtime
            .lock()
            .map(|runtime| {
                !runtime.shutting_down && runtime.session.phase == PresentationPhase::Inactive
            })
            .unwrap_or(false)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum WindowRole {
    Host,
    Controller,
}

fn trace_presentation(
    _app: &tauri::AppHandle,
    generation: Option<u64>,
    stage: &str,
    detail: impl AsRef<str>,
) {
    super::append_desktop_diagnostic(
        "presentation_trace",
        format!(
            "generation={} stage={} thread={:?} {}",
            generation
                .map(|value| value.to_string())
                .unwrap_or_else(|| "none".to_string()),
            stage,
            std::thread::current().id(),
            detail.as_ref()
        ),
    );
}

struct ActivationAttemptGuard<'a> {
    state: &'a PresentationState,
    generation: u64,
    finished: bool,
}

impl<'a> ActivationAttemptGuard<'a> {
    fn new(state: &'a PresentationState, generation: u64) -> Self {
        Self {
            state,
            generation,
            finished: false,
        }
    }

    fn finish(mut self) -> Result<Option<u64>, String> {
        let result = self.state.finish_activation_attempt(self.generation);
        self.finished = result.is_ok();
        result
    }
}

impl Drop for ActivationAttemptGuard<'_> {
    fn drop(&mut self) {
        if !self.finished {
            let _ = self.state.finish_activation_attempt(self.generation);
        }
    }
}

fn claim_activation_finalization(runtime: &mut PresentationRuntime) -> bool {
    let generation = runtime.session.generation;
    let native_lifecycle_available = match runtime.native_lifecycle_owner {
        None => true,
        Some(NativeLifecycleOwner::Activation(owner_generation)) => owner_generation == generation,
        Some(NativeLifecycleOwner::Recovery(_)) => false,
    };
    let should_finalize = runtime.session.host_ready
        && runtime.session.controller_ready
        && runtime.placement_prepared
        && runtime.activation_published
        && !runtime.activation_finalization_claimed
        && native_lifecycle_available;
    if should_finalize {
        runtime.activation_finalization_claimed = true;
        runtime.native_lifecycle_owner = Some(NativeLifecycleOwner::Activation(generation));
    }
    should_finalize
}

fn next_sequence(current: u64, label: &str) -> Result<u64, String> {
    let next = current
        .checked_add(1)
        .ok_or_else(|| format!("{label} is exhausted"))?;
    if next > MAX_SAFE_JS_INTEGER {
        return Err(format!("{label} exceeds JavaScript's safe integer range"));
    }
    Ok(next)
}

fn inactive_session(
    generation: u64,
    recovery_reason: Option<PresentationRecoveryReason>,
) -> PresentationSession {
    PresentationSession {
        generation,
        recovery_reason,
        ..PresentationSession::default()
    }
}

fn reset_runtime_to_inactive(
    runtime: &mut PresentationRuntime,
    generation: u64,
    recovery_reason: Option<PresentationRecoveryReason>,
) -> PresentationSession {
    runtime.session = inactive_session(generation, recovery_reason);
    runtime.host_placement = None;
    runtime.playback_state = None;
    runtime.playback_state_sequence = 0;
    runtime.pending_commands.clear();
    runtime.in_flight_command_sequence = None;
    runtime.placement_prepared = false;
    runtime.activation_published = false;
    runtime.native_lifecycle_owner = None;
    runtime.host_window_restored = false;
    runtime.activation_finalization_claimed = false;
    runtime.session.clone()
}

fn validate_controller_command(command: &ControllerCommand) -> Result<(), String> {
    match command {
        ControllerCommand::SeekRelative { delta_seconds }
            if !delta_seconds.is_finite()
                || *delta_seconds == 0.0
                || delta_seconds.abs() > 600.0 =>
        {
            Err("controller relative seek is out of bounds".to_string())
        }
        ControllerCommand::SeekAbsolute { target_seconds }
            if !target_seconds.is_finite()
                || !(0.0..=MAX_MEDIA_SECONDS).contains(target_seconds) =>
        {
            Err("controller seek position is out of bounds".to_string())
        }
        ControllerCommand::SetVolume { volume_percent, .. } if *volume_percent > 100 => {
            Err("controller volume is out of bounds".to_string())
        }
        _ => Ok(()),
    }
}

fn validate_playback_state(candidate: &ControllerPlaybackState) -> Result<(), String> {
    if candidate.revision == 0
        || candidate
            .item_identity
            .as_ref()
            .is_some_and(|identity| identity.len() > 256)
        || candidate.title.len() > 1024
        || !candidate.current_time_seconds.is_finite()
        || !(0.0..=MAX_MEDIA_SECONDS).contains(&candidate.current_time_seconds)
        || candidate.duration_seconds.is_some_and(|duration| {
            !duration.is_finite() || !(0.0..=MAX_MEDIA_SECONDS).contains(&duration)
        })
        || candidate.volume_percent > 100
    {
        return Err("controller playback state is invalid".to_string());
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn wide_string(value: &[u16]) -> String {
    let length = value
        .iter()
        .position(|character| *character == 0)
        .unwrap_or(value.len());
    String::from_utf16_lossy(&value[..length])
}

#[cfg(target_os = "windows")]
fn windows_display_metadata() -> Result<HashMap<String, Vec<NativeDisplayMetadata>>, String> {
    let mut metadata: HashMap<String, Vec<NativeDisplayMetadata>> = HashMap::new();
    let mut source_path_counts: HashMap<String, usize> = HashMap::new();
    for _ in 0..3 {
        let mut path_count = 0;
        let mut mode_count = 0;
        // SAFETY: The Win32 API fills counts through valid mutable pointers.
        let size_result = unsafe {
            GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut path_count, &mut mode_count)
        };
        if size_result != 0 {
            return Err(format!(
                "Windows display metadata sizing failed with code {size_result}"
            ));
        }
        let mut paths = vec![DISPLAYCONFIG_PATH_INFO::default(); path_count as usize];
        let mut modes = vec![DISPLAYCONFIG_MODE_INFO::default(); mode_count as usize];
        // SAFETY: Both buffers have the capacities returned immediately above.
        let query_result = unsafe {
            QueryDisplayConfig(
                QDC_ONLY_ACTIVE_PATHS,
                &mut path_count,
                paths.as_mut_ptr(),
                &mut mode_count,
                modes.as_mut_ptr(),
                std::ptr::null_mut(),
            )
        };
        if query_result == ERROR_INSUFFICIENT_BUFFER {
            continue;
        }
        if query_result != 0 {
            return Err(format!(
                "Windows display metadata query failed with code {query_result}"
            ));
        }
        let active_paths = paths.iter().take(path_count as usize).collect::<Vec<_>>();
        let mut raw_source_path_counts: HashMap<(i32, u32, u32), usize> = HashMap::new();
        for path in &active_paths {
            let source_key = (
                path.sourceInfo.adapterId.HighPart,
                path.sourceInfo.adapterId.LowPart,
                path.sourceInfo.id,
            );
            *raw_source_path_counts.entry(source_key).or_default() += 1;
        }
        for path in active_paths {
            let raw_source_key = (
                path.sourceInfo.adapterId.HighPart,
                path.sourceInfo.adapterId.LowPart,
                path.sourceInfo.id,
            );
            let active_path_count = raw_source_path_counts
                .get(&raw_source_key)
                .copied()
                .unwrap_or_default();
            let mut source = DISPLAYCONFIG_SOURCE_DEVICE_NAME::default();
            source.header.r#type = DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME;
            source.header.size = std::mem::size_of_val(&source) as u32;
            source.header.adapterId = path.sourceInfo.adapterId;
            source.header.id = path.sourceInfo.id;
            // SAFETY: source begins with a fully initialized DISPLAYCONFIG header.
            if unsafe { DisplayConfigGetDeviceInfo(&mut source.header) } != 0 {
                continue;
            }
            let source_name = wide_string(&source.viewGdiDeviceName);
            if source_name.is_empty() {
                continue;
            }
            let source_key = source_name.to_ascii_lowercase();
            source_path_counts
                .entry(source_key.clone())
                .and_modify(|count| *count = (*count).max(active_path_count))
                .or_insert(active_path_count);
            let mut target = DISPLAYCONFIG_TARGET_DEVICE_NAME::default();
            target.header.r#type = DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME;
            target.header.size = std::mem::size_of_val(&target) as u32;
            target.header.adapterId = path.targetInfo.adapterId;
            target.header.id = path.targetInfo.id;
            // SAFETY: target follows the same initialized packet contract.
            if unsafe { DisplayConfigGetDeviceInfo(&mut target.header) } != 0 {
                continue;
            }
            let device_path = wide_string(&target.monitorDevicePath);
            if device_path.is_empty() {
                continue;
            }
            let friendly_name = wide_string(&target.monitorFriendlyDeviceName);
            metadata
                .entry(source_key)
                .or_default()
                .push(NativeDisplayMetadata {
                    id: format!("windows-device-path:{}", device_path.to_ascii_lowercase()),
                    name: friendly_name,
                    mirrored: false,
                    identity_stable: true,
                });
        }
        for (source_key, entries) in &mut metadata {
            entries.sort_by(|left, right| left.id.cmp(&right.id));
            entries.dedup_by(|left, right| left.id == right.id);
            let mirrored = display_source_is_mirrored(
                source_path_counts
                    .get(source_key)
                    .copied()
                    .unwrap_or_default(),
                entries.len(),
            );
            for entry in entries {
                entry.mirrored = mirrored;
                entry.identity_stable = !mirrored;
            }
        }
        return Ok(metadata);
    }
    Err("Windows display topology changed during discovery".to_string())
}

#[cfg(target_os = "macos")]
fn macos_display_uuid(display_id: u32) -> Result<String, String> {
    use core_foundation::base::TCFType;
    use core_foundation::uuid::{CFUUID, CFUUIDGetUUIDBytes, CFUUIDRef};

    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        fn CGDisplayCreateUUIDFromDisplayID(display: u32) -> CFUUIDRef;
    }

    // SAFETY: CoreGraphics owns the display identifier and returns a retained UUID.
    let reference = unsafe { CGDisplayCreateUUIDFromDisplayID(display_id) };
    if reference.is_null() {
        return Err("macOS display UUID is unavailable".to_string());
    }
    // SAFETY: reference follows Core Foundation's create rule and is non-null.
    let uuid = unsafe { CFUUID::wrap_under_create_rule(reference) };
    // SAFETY: uuid is a valid retained CFUUID for this call.
    let bytes = unsafe { CFUUIDGetUUIDBytes(uuid.as_concrete_TypeRef()) };
    Ok(format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes.byte0,
        bytes.byte1,
        bytes.byte2,
        bytes.byte3,
        bytes.byte4,
        bytes.byte5,
        bytes.byte6,
        bytes.byte7,
        bytes.byte8,
        bytes.byte9,
        bytes.byte10,
        bytes.byte11,
        bytes.byte12,
        bytes.byte13,
        bytes.byte14,
        bytes.byte15,
    ))
}

#[cfg(target_os = "macos")]
fn collect_macos_screen_details() -> Result<HashMap<String, (String, f64)>, String> {
    use objc2::{MainThreadMarker, msg_send};
    use objc2_app_kit::NSScreen;
    use objc2_foundation::NSString;

    let marker = MainThreadMarker::new()
        .ok_or_else(|| "macOS display names must be read on the AppKit main thread".to_string())?;
    let key = NSString::from_str("NSScreenNumber");
    let mut details = HashMap::new();
    for screen in NSScreen::screens(marker).iter() {
        let description = screen.deviceDescription();
        let Some(value) = description.objectForKey(&key) else {
            continue;
        };
        // SAFETY: NSScreenNumber is documented as an NSNumber-compatible value.
        let display_id: usize = unsafe { msg_send![&*value, unsignedIntegerValue] };
        let uuid = macos_display_uuid(display_id as u32)?;
        let frame = screen.frame();
        let backing_frame = screen.convertRectToBacking(frame);
        let scale = if frame.size.width > 0.0 {
            backing_frame.size.width / frame.size.width
        } else {
            1.0
        };
        details.insert(uuid, (screen.localizedName().to_string(), scale));
    }
    Ok(details)
}

#[cfg(target_os = "macos")]
fn macos_screen_details(app: &tauri::AppHandle) -> Result<HashMap<String, (String, f64)>, String> {
    if objc2::MainThreadMarker::new().is_some() {
        return collect_macos_screen_details();
    }
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let _ = sender.send(collect_macos_screen_details());
    })
    .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(Duration::from_secs(2))
        .map_err(|_| "timed out while reading macOS display names".to_string())?
}

#[cfg(target_os = "macos")]
fn macos_metadata_for_monitor(
    monitor: &tauri::window::Monitor,
    screen_details: &HashMap<String, (String, f64)>,
) -> Result<NativeDisplayMetadata, String> {
    use core_graphics::display::CGDisplay;

    let target_geometry = MonitorGeometry::from_monitor(monitor);
    let active = CGDisplay::active_displays()
        .map_err(|error| format!("macOS display discovery failed with code {error}"))?;
    let mut matches = Vec::new();
    for display_id in active {
        let display = CGDisplay::new(display_id);
        let uuid = macos_display_uuid(display_id)?;
        let Some((localized_name, scale)) = screen_details.get(&uuid) else {
            continue;
        };
        let bounds = display.bounds();
        let geometry = MonitorGeometry {
            x: (bounds.origin.x * *scale).round() as i32,
            y: (bounds.origin.y * *scale).round() as i32,
            width: (display.pixels_wide() as f64 * *scale).round() as u32,
            height: (display.pixels_high() as f64 * *scale).round() as u32,
        };
        if geometry == target_geometry {
            matches.push(NativeDisplayMetadata {
                id: format!("macos-uuid:{uuid}"),
                name: localized_name.clone(),
                mirrored: display.is_in_mirror_set(),
                identity_stable: true,
            });
        }
    }
    if matches.is_empty() {
        return Err(format!(
            "macOS display identity is unavailable at {}",
            target_geometry.identity_suffix()
        ));
    }
    matches.sort_by(|left, right| left.id.cmp(&right.id));
    let ambiguous = matches.len() != 1;
    let mut selected = matches.remove(0);
    if ambiguous {
        selected.mirrored = true;
        selected.identity_stable = false;
    }
    Ok(selected)
}

fn native_metadata_for_monitors(
    main_window: &tauri::WebviewWindow,
    monitors: &[tauri::window::Monitor],
) -> Result<Vec<Option<NativeDisplayMetadata>>, String> {
    #[cfg(target_os = "windows")]
    {
        let _ = main_window;
        let metadata = windows_display_metadata()?;
        Ok(monitors
            .iter()
            .map(|monitor| {
                let key = monitor
                    .name()
                    .map(|name| name.to_ascii_lowercase())
                    .unwrap_or_default();
                let entries = metadata.get(&key)?;
                entries.first().cloned()
            })
            .collect())
    }
    #[cfg(target_os = "macos")]
    {
        let screen_details = macos_screen_details(main_window.app_handle())?;
        Ok(monitors
            .iter()
            .map(|monitor| macos_metadata_for_monitor(monitor, &screen_details).ok())
            .collect())
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = main_window;
        Ok(vec![None; monitors.len()])
    }
}

fn matching_monitor_index(
    monitors: &[tauri::window::Monitor],
    target: Option<&tauri::window::Monitor>,
) -> Option<usize> {
    let target = target?;
    let target_geometry = MonitorGeometry::from_monitor(target);
    let target_name = target.name().map(String::as_str).unwrap_or_default();
    monitors
        .iter()
        .position(|candidate| {
            MonitorGeometry::from_monitor(candidate) == target_geometry
                && candidate.name().map(String::as_str).unwrap_or_default() == target_name
        })
        .or_else(|| {
            monitors
                .iter()
                .position(|candidate| MonitorGeometry::from_monitor(candidate) == target_geometry)
        })
}

fn candidate_identity(
    monitor: &tauri::window::Monitor,
    native: Option<&NativeDisplayMetadata>,
) -> (String, String, bool) {
    let platform_name = monitor.name().cloned().unwrap_or_default();
    if let Some(native) = native {
        let name = if native.name.trim().is_empty() {
            platform_name
        } else {
            native.name.trim().to_string()
        };
        return (native.id.clone(), name, native.identity_stable);
    }
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        let geometry = MonitorGeometry::from_monitor(monitor);
        (
            format!("unavailable:{}", geometry.identity_suffix()),
            platform_name,
            false,
        )
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let geometry = MonitorGeometry::from_monitor(monitor);
        (
            format!("unsupported:{}", geometry.identity_suffix()),
            platform_name,
            false,
        )
    }
}

fn discover_display_records(
    main_window: &tauri::WebviewWindow,
) -> Result<Vec<PresentationDisplayRecord>, String> {
    let monitors = main_window
        .available_monitors()
        .map_err(|error| error.to_string())?;
    let primary_monitor = main_window
        .primary_monitor()
        .map_err(|error| error.to_string())?;
    let primary_index = matching_monitor_index(&monitors, primary_monitor.as_ref());
    let native_metadata = native_metadata_for_monitors(main_window, &monitors)?;
    let mut candidates = monitors
        .into_iter()
        .zip(native_metadata)
        .map(|(monitor, native)| {
            let geometry = MonitorGeometry::from_monitor(&monitor);
            let (base_id, name, identity_stable) = candidate_identity(&monitor, native.as_ref());
            DisplayCandidate {
                monitor,
                geometry,
                base_id,
                name,
                identity_stable,
                mirrored: native.as_ref().is_some_and(|metadata| metadata.mirrored),
            }
        })
        .collect::<Vec<_>>();

    let mut id_counts = HashMap::new();
    let mut origin_counts = HashMap::new();
    let mut name_counts = HashMap::new();
    for candidate in &candidates {
        *id_counts.entry(candidate.base_id.clone()).or_insert(0usize) += 1;
        *origin_counts
            .entry((candidate.geometry.x, candidate.geometry.y))
            .or_insert(0usize) += 1;
        *name_counts
            .entry(candidate.name.to_ascii_lowercase())
            .or_insert(0usize) += 1;
    }
    let primary_geometry = primary_index.map(|index| candidates[index].geometry);

    Ok(candidates
        .drain(..)
        .enumerate()
        .map(|(index, candidate)| {
            let duplicate_id = id_counts.get(&candidate.base_id).copied().unwrap_or(1) > 1;
            let id = if duplicate_id {
                format!(
                    "{}@{}",
                    candidate.base_id,
                    candidate.geometry.identity_suffix()
                )
            } else {
                candidate.base_id.clone()
            };
            let identity_stable = candidate.identity_stable && !duplicate_id;
            let duplicate_origin = origin_counts
                .get(&(candidate.geometry.x, candidate.geometry.y))
                .copied()
                .unwrap_or(1)
                > 1;
            let controller = primary_index == Some(index);
            let mirrors_controller = primary_geometry
                .map(|geometry| candidate.geometry.same_origin(geometry))
                .unwrap_or(true);
            let mirrored =
                candidate.mirrored || duplicate_origin || (!controller && mirrors_controller);
            let mut name = if candidate.name.trim().is_empty() {
                format!("Display {}", index + 1)
            } else {
                candidate.name
            };
            if name_counts
                .get(&name.to_ascii_lowercase())
                .copied()
                .unwrap_or(1)
                > 1
            {
                let suffix = id.rsplit([':', '-']).next().unwrap_or(&id);
                let start = suffix.len().saturating_sub(8);
                name = format!("{name} · {}", &suffix[start..]);
            }
            PresentationDisplayRecord {
                display: PresentationDisplay {
                    id,
                    name,
                    position_x: candidate.geometry.x,
                    position_y: candidate.geometry.y,
                    width: candidate.geometry.width,
                    height: candidate.geometry.height,
                    scale_factor: candidate.monitor.scale_factor(),
                    controller,
                    primary: controller,
                    selectable: identity_stable && !controller && !mirrored,
                    mirrored,
                    identity_stable,
                    identity_quality: if identity_stable {
                        DisplayIdentityQuality::Stable
                    } else {
                        DisplayIdentityQuality::Unstable
                    },
                },
                monitor: candidate.monitor,
            }
        })
        .collect())
}

fn display_info(records: &[PresentationDisplayRecord]) -> PresentationDisplayInfo {
    PresentationDisplayInfo {
        monitor_count: records.len(),
        displays: records
            .iter()
            .map(|record| record.display.clone())
            .collect(),
        controller_display_id: records
            .iter()
            .find(|record| record.display.controller)
            .map(|record| record.display.id.clone()),
        recommended_display_id: records
            .iter()
            .find(|record| record.display.selectable)
            .map(|record| record.display.id.clone()),
    }
}

fn capture_host_placement(window: &tauri::WebviewWindow) -> Result<HostWindowPlacement, String> {
    Ok(HostWindowPlacement {
        position: window.outer_position().map_err(|error| error.to_string())?,
        size: window.inner_size().map_err(|error| error.to_string())?,
        decorations: window.is_decorated().map_err(|error| error.to_string())?,
        resizable: window.is_resizable().map_err(|error| error.to_string())?,
        fullscreen: window.is_fullscreen().map_err(|error| error.to_string())?,
        maximized: window.is_maximized().map_err(|error| error.to_string())?,
    })
}

fn run_activation_window_mutation(
    app: &tauri::AppHandle,
    state: &PresentationState,
    generation: u64,
    action: &str,
    operation: impl FnOnce() -> tauri::Result<()>,
) -> Result<(), String> {
    trace_presentation(
        app,
        Some(generation),
        "window_mutation_begin",
        format!("action={action}"),
    );
    let result = (|| {
        state.ensure_activation_native_owner(generation)?;
        operation().map_err(|error| format!("{action}: {error}"))
    })();
    trace_presentation(
        app,
        Some(generation),
        "window_mutation_end",
        format!(
            "action={} status={}",
            action,
            if result.is_ok() { "ok" } else { "error" }
        ),
    );
    result
}

fn place_host_for_activation(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    monitor: &tauri::window::Monitor,
    state: &PresentationState,
    generation: u64,
) -> Result<(), String> {
    run_activation_window_mutation(app, state, generation, "leave fullscreen", || {
        window.set_fullscreen(false)
    })?;
    run_activation_window_mutation(app, state, generation, "unminimize Host", || {
        window.unminimize()
    })?;
    run_activation_window_mutation(app, state, generation, "unmaximize Host", || {
        window.unmaximize()
    })?;
    run_activation_window_mutation(app, state, generation, "remove Host decorations", || {
        window.set_decorations(false)
    })?;
    run_activation_window_mutation(app, state, generation, "lock Host resizing", || {
        window.set_resizable(false)
    })?;
    run_activation_window_mutation(app, state, generation, "position Host", || {
        window.set_position(*monitor.position())
    })?;
    run_activation_window_mutation(app, state, generation, "resize Host", || {
        window.set_size(*monitor.size())
    })?;
    run_activation_window_mutation(app, state, generation, "show Host", || window.show())
}

fn collect_recovery_window_mutation(
    state: &PresentationState,
    generation: u64,
    action: &str,
    operation: impl FnOnce() -> tauri::Result<()>,
    errors: &mut Vec<String>,
) {
    if let Err(error) = state
        .ensure_recovery_native_owner(generation)
        .and_then(|_| operation().map_err(|error| error.to_string()))
    {
        errors.push(format!("{action}: {error}"));
    }
}

fn visible_restore_placement(
    original: &HostWindowPlacement,
    monitors: &[MonitorGeometry],
    primary_work_area: Option<(tauri::PhysicalPosition<i32>, tauri::PhysicalSize<u32>)>,
) -> (tauri::PhysicalPosition<i32>, tauri::PhysicalSize<u32>, bool) {
    let original_geometry = MonitorGeometry {
        x: original.position.x,
        y: original.position.y,
        width: original.size.width,
        height: original.size.height,
    };
    if monitors
        .iter()
        .any(|monitor| original_geometry.intersects(*monitor))
    {
        return (original.position, original.size, true);
    }
    let Some((work_position, work_size)) = primary_work_area else {
        return (original.position, original.size, false);
    };
    let width = original.size.width.max(640).min(work_size.width);
    let height = original.size.height.max(480).min(work_size.height);
    let x = work_position.x + (work_size.width.saturating_sub(width) / 2) as i32;
    let y = work_position.y + (work_size.height.saturating_sub(height) / 2) as i32;
    (
        tauri::PhysicalPosition::new(x, y),
        tauri::PhysicalSize::new(width, height),
        false,
    )
}

fn restore_host_window(
    window: &tauri::WebviewWindow,
    placement: &HostWindowPlacement,
    preserve_original_fullscreen: bool,
    state: &PresentationState,
    generation: u64,
) -> Result<(), String> {
    state.ensure_recovery_native_owner(generation)?;
    let monitors = window
        .available_monitors()
        .map_err(|error| error.to_string())?;
    let primary = window
        .primary_monitor()
        .map_err(|error| error.to_string())?;
    let monitor_geometries = monitors
        .iter()
        .map(MonitorGeometry::from_monitor)
        .collect::<Vec<_>>();
    let primary_work_area = primary.as_ref().map(|monitor| {
        let work = monitor.work_area();
        (work.position, work.size)
    });
    let (position, size, original_is_visible) =
        visible_restore_placement(placement, &monitor_geometries, primary_work_area);
    let mut errors = Vec::new();
    collect_recovery_window_mutation(
        state,
        generation,
        "leave fullscreen",
        || window.set_fullscreen(false),
        &mut errors,
    );
    collect_recovery_window_mutation(
        state,
        generation,
        "leave maximized state",
        || window.unmaximize(),
        &mut errors,
    );
    collect_recovery_window_mutation(
        state,
        generation,
        "restore decorations",
        || window.set_decorations(placement.decorations),
        &mut errors,
    );
    collect_recovery_window_mutation(
        state,
        generation,
        "restore resizable state",
        || window.set_resizable(placement.resizable),
        &mut errors,
    );
    collect_recovery_window_mutation(
        state,
        generation,
        "restore position",
        || window.set_position(position),
        &mut errors,
    );
    collect_recovery_window_mutation(
        state,
        generation,
        "restore size",
        || window.set_size(size),
        &mut errors,
    );
    collect_recovery_window_mutation(
        state,
        generation,
        "show Host",
        || window.show(),
        &mut errors,
    );
    if preserve_original_fullscreen && original_is_visible {
        if placement.maximized {
            collect_recovery_window_mutation(
                state,
                generation,
                "restore maximized state",
                || window.maximize(),
                &mut errors,
            );
        }
        if placement.fullscreen {
            collect_recovery_window_mutation(
                state,
                generation,
                "restore fullscreen state",
                || window.set_fullscreen(true),
                &mut errors,
            );
        }
    }
    collect_recovery_window_mutation(
        state,
        generation,
        "focus Host",
        || window.set_focus(),
        &mut errors,
    );
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

fn controller_url(host: &tauri::WebviewWindow, generation: u64) -> Result<tauri::Url, String> {
    let mut url = host.url().map_err(|error| error.to_string())?;
    if super::parsed_http_origin(url.as_str()).is_none() {
        return Err("the Host is not using the local Bilikara origin".to_string());
    }
    url.set_path("/controller.html");
    url.set_query(Some(&format!("presentationGeneration={generation}")));
    url.set_fragment(None);
    Ok(url)
}

fn create_controller_window(
    app: &tauri::AppHandle,
    host: &tauri::WebviewWindow,
    generation: u64,
) -> Result<tauri::WebviewWindow, String> {
    if app.get_webview_window("controller").is_some() {
        return Err("the Controller window already exists".to_string());
    }
    let url = controller_url(host, generation)?;
    let allowed_origin = url.clone();
    WebviewWindowBuilder::new(app, "controller", WebviewUrl::External(url))
        .on_navigation(move |candidate| {
            super::window_origin_authorized(candidate.as_str(), allowed_origin.as_str())
        })
        .title("Bilikara Controller")
        .visible(false)
        .decorations(true)
        .resizable(true)
        .focused(false)
        .inner_size(CONTROLLER_WIDTH, CONTROLLER_HEIGHT)
        .build()
        .map_err(|error| error.to_string())
}

fn place_controller_for_activation(
    app: &tauri::AppHandle,
    controller: &tauri::WebviewWindow,
    primary: &tauri::window::Monitor,
    state: &PresentationState,
    generation: u64,
) -> Result<(), String> {
    let work = primary.work_area();
    let scale = primary.scale_factor();
    let width = ((CONTROLLER_WIDTH * scale).round() as u32).min(work.size.width);
    let height = ((CONTROLLER_HEIGHT * scale).round() as u32).min(work.size.height);
    let x = work.position.x + (work.size.width.saturating_sub(width) / 2) as i32;
    let y = work.position.y + (work.size.height.saturating_sub(height) / 2) as i32;
    run_activation_window_mutation(app, state, generation, "resize Controller", || {
        controller.set_size(tauri::PhysicalSize::new(width, height))
    })?;
    run_activation_window_mutation(app, state, generation, "position Controller", || {
        controller.set_position(tauri::PhysicalPosition::new(x, y))
    })
}

pub(crate) fn authorize_window(
    window: &tauri::WebviewWindow,
    backend: &super::BackendProcess,
    allowed_labels: &[&str],
) -> Result<(), String> {
    if !allowed_labels.contains(&window.label()) {
        return Err("this window is not authorized for the presentation command".to_string());
    }
    let backend_url = backend
        .base_url
        .lock()
        .map_err(|_| "the backend address lock is unavailable".to_string())?
        .clone()
        .ok_or_else(|| "the local backend is not ready".to_string())?;
    let window_url = window.url().map_err(|error| error.to_string())?;
    if !super::window_origin_authorized(window_url.as_str(), &backend_url) {
        return Err("the window origin is not authorized".to_string());
    }
    Ok(())
}

fn emit_state(app: &tauri::AppHandle, session: &PresentationSession) -> Result<(), String> {
    let payload = PresentationStateEvent {
        session: session.clone(),
    };
    app.emit_to("main", STATE_EVENT, &payload)
        .map_err(|error| error.to_string())?;
    if app.get_webview_window("controller").is_some() {
        app.emit_to("controller", STATE_EVENT, &payload)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn emit_composition(
    app: &tauri::AppHandle,
    generation: u64,
    composition: HostComposition,
) -> Result<(), String> {
    app.emit_to(
        "main",
        HOST_COMPOSITION_EVENT,
        HostCompositionEvent {
            generation,
            composition,
        },
    )
    .map_err(|error| error.to_string())
}

fn emit_host_command(
    app: &tauri::AppHandle,
    command: &ControllerCommandEnvelope,
) -> Result<(), String> {
    app.emit_to("main", HOST_COMMAND_EVENT, command)
        .map_err(|error| error.to_string())
}

fn emit_playback_state(
    app: &tauri::AppHandle,
    playback_state: &ControllerPlaybackStateEnvelope,
) -> Result<(), String> {
    if app.get_webview_window("controller").is_none() {
        return Ok(());
    }
    app.emit_to("controller", PLAYBACK_STATE_EVENT, playback_state)
        .map_err(|error| error.to_string())
}

fn close_controller(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(controller) = app.get_webview_window("controller") {
        controller.close().map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn close_controller_for_recovery(
    app: &tauri::AppHandle,
    state: &PresentationState,
    generation: u64,
) -> Result<(), String> {
    state.ensure_recovery_native_owner(generation)?;
    close_controller(app)
}

fn restore_recovery_window(
    app: &tauri::AppHandle,
    state: &PresentationState,
    generation: u64,
    preserve_original_window_mode: bool,
) -> Result<(), String> {
    if state.host_window_restored(generation)? && !preserve_original_window_mode {
        return Ok(());
    }
    let host = app
        .get_webview_window("main")
        .ok_or_else(|| "main window is unavailable".to_string())?;
    let placement = state
        .recovery_placement(generation)?
        .ok_or_else(|| "the original Host placement is unavailable".to_string())?;
    restore_host_window(
        &host,
        &placement,
        preserve_original_window_mode,
        state,
        generation,
    )?;
    state.mark_host_window_restored(generation)
}

fn finalize_recovery(
    app: &tauri::AppHandle,
    state: &PresentationState,
    generation: u64,
) -> Result<PresentationSession, String> {
    trace_presentation(
        app,
        Some(generation),
        "recovery_finalize_begin",
        "forced=false",
    );
    state.ensure_recovery_native_owner(generation)?;
    let session = state.snapshot()?;
    if session.generation != generation || session.phase != PresentationPhase::Recovering {
        return Err("presentation recovery generation is stale".to_string());
    }
    let preserve_original_window_mode = !matches!(
        session.recovery_reason,
        Some(PresentationRecoveryReason::DisplayDisconnected)
    );
    let restore_error =
        restore_recovery_window(app, state, generation, preserve_original_window_mode).err();
    trace_presentation(
        app,
        Some(generation),
        "recovery_restore_end",
        format!(
            "forced=false status={}",
            if restore_error.is_none() {
                "ok"
            } else {
                "error"
            }
        ),
    );
    let close_error = close_controller_for_recovery(app, state, generation).err();
    trace_presentation(
        app,
        Some(generation),
        "recovery_controller_close_end",
        format!(
            "forced=false status={}",
            if close_error.is_none() { "ok" } else { "error" }
        ),
    );
    if let Some(restore_error) = restore_error {
        let mut errors = vec![restore_error];
        errors.extend(close_error);
        return Err(errors.join("; "));
    }
    let inactive = state.complete_recovery(generation)?;
    let state_error = emit_state(app, &inactive).err();
    let errors = [close_error, state_error]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    if errors.is_empty() {
        Ok(inactive)
    } else {
        Err(errors.join("; "))
    }
}

fn force_finalize_recovery(
    app: &tauri::AppHandle,
    state: &PresentationState,
    generation: u64,
) -> Result<PresentationSession, String> {
    trace_presentation(
        app,
        Some(generation),
        "recovery_finalize_begin",
        "forced=true",
    );
    state.ensure_recovery_native_owner(generation)?;
    let session = state.snapshot()?;
    if session.generation != generation || session.phase != PresentationPhase::Recovering {
        return Err("presentation recovery generation is stale".to_string());
    }
    let preserve_original_window_mode = !matches!(
        session.recovery_reason,
        Some(PresentationRecoveryReason::DisplayDisconnected)
    );
    let composition_error = state
        .ensure_recovery_native_owner(generation)
        .and_then(|_| emit_composition(app, generation, HostComposition::Combined))
        .err();
    let restore_error =
        restore_recovery_window(app, state, generation, preserve_original_window_mode).err();
    trace_presentation(
        app,
        Some(generation),
        "recovery_restore_end",
        format!(
            "forced=true status={}",
            if restore_error.is_none() {
                "ok"
            } else {
                "error"
            }
        ),
    );
    let close_error = close_controller_for_recovery(app, state, generation).err();
    trace_presentation(
        app,
        Some(generation),
        "recovery_controller_close_end",
        format!(
            "forced=true status={}",
            if close_error.is_none() { "ok" } else { "error" }
        ),
    );
    let inactive = state.force_complete_recovery(generation)?;
    let state_error = emit_state(app, &inactive).err();
    let errors = [composition_error, restore_error, close_error, state_error]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    if errors.is_empty() {
        Ok(inactive)
    } else {
        Err(errors.join("; "))
    }
}

fn start_recovery_finalization_deadline(app: tauri::AppHandle, generation: u64) {
    std::thread::spawn(move || {
        std::thread::sleep(RECOVERY_FINALIZATION_TIMEOUT);
        let state = app.state::<PresentationState>();
        let Ok(session) = state.snapshot() else {
            return;
        };
        if session.generation != generation || session.phase != PresentationPhase::Recovering {
            return;
        }
        let callback_app = app.clone();
        let dispatcher = app.clone();
        if let Err(error) = dispatcher.run_on_main_thread(move || {
            let state = callback_app.state::<PresentationState>();
            if let Err(error) = force_finalize_recovery(&callback_app, &state, generation) {
                eprintln!(
                    "Forced presentation recovery generation {generation} completed with errors: {error}"
                );
            }
        }) {
            let state = app.state::<PresentationState>();
            let _ = state.force_complete_recovery(generation);
            eprintln!("Failed to schedule forced presentation recovery: {error}");
        }
    });
}

fn begin_recovery_transaction(
    app: &tauri::AppHandle,
    state: &PresentationState,
    expected_generation: u64,
    reason: PresentationRecoveryReason,
) -> Result<PresentationSession, String> {
    let claim = state.begin_recovery(Some(expected_generation), reason)?;
    trace_presentation(
        app,
        Some(claim.session.generation),
        "recovery_claimed",
        format!(
            "reason={reason:?} started={} owns_native_lifecycle={}",
            claim.started, claim.owns_native_lifecycle
        ),
    );
    if !claim.started || !claim.owns_native_lifecycle {
        return Ok(claim.session);
    }
    let recovering = claim.session;
    start_recovery_finalization_deadline(app.clone(), recovering.generation);
    trace_presentation(
        app,
        Some(recovering.generation),
        "recovery_restore_begin",
        "forced=false initial=true",
    );
    let restore_error = restore_recovery_window(app, state, recovering.generation, false).err();
    trace_presentation(
        app,
        Some(recovering.generation),
        "recovery_restore_end",
        format!(
            "forced=false initial=true status={}",
            if restore_error.is_none() {
                "ok"
            } else {
                "error"
            }
        ),
    );
    let state_error = state
        .ensure_recovery_native_owner(recovering.generation)
        .and_then(|_| emit_state(app, &recovering))
        .err();
    let composition_error = state
        .ensure_recovery_native_owner(recovering.generation)
        .and_then(|_| emit_composition(app, recovering.generation, HostComposition::Combined))
        .err();
    let errors = [restore_error, state_error, composition_error]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    if errors.is_empty() {
        Ok(recovering)
    } else {
        Err(errors.join("; "))
    }
}

fn recover_after_activation_failure(
    app: &tauri::AppHandle,
    state: &PresentationState,
    generation: u64,
    error: impl AsRef<str>,
) -> String {
    match begin_recovery_transaction(
        app,
        state,
        generation,
        PresentationRecoveryReason::ActivationFailed,
    ) {
        Ok(_) => error.as_ref().to_string(),
        Err(recovery_error) => format!(
            "{}; activation recovery failed: {recovery_error}",
            error.as_ref()
        ),
    }
}

fn deliver_main_thread_operation_result<T>(
    sender: std::sync::mpsc::SyncSender<Result<T, String>>,
    result: Result<T, String>,
    completion_diagnostic: impl FnOnce(bool),
) {
    let succeeded = result.is_ok();
    let _ = sender.send(result);
    completion_diagnostic(succeeded);
}

fn run_on_main_thread_with_result<T: Send + 'static>(
    app: &tauri::AppHandle,
    generation: u64,
    operation_name: &'static str,
    operation: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    // In pinned Tauri 2.11, `#[command(async)]` runs this command body through
    // `async_runtime::spawn`. Only that worker waits; the main-thread closure never waits on it.
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    trace_presentation(
        app,
        Some(generation),
        "main_thread_schedule_begin",
        format!("operation={operation_name}"),
    );
    let callback_app = app.clone();
    app.run_on_main_thread(move || {
        trace_presentation(
            &callback_app,
            Some(generation),
            "main_thread_operation_begin",
            format!("operation={operation_name}"),
        );
        let result = operation();
        deliver_main_thread_operation_result(sender, result, |succeeded| {
            trace_presentation(
                &callback_app,
                Some(generation),
                "main_thread_operation_end",
                format!(
                    "operation={} status={}",
                    operation_name,
                    if succeeded { "ok" } else { "error" }
                ),
            );
        });
    })
    .map_err(|error| format!("failed to schedule presentation lifecycle work: {error}"))?;
    trace_presentation(
        app,
        Some(generation),
        "main_thread_result_wait_begin",
        format!("operation={operation_name}"),
    );
    let result = receiver
        .recv()
        .map_err(|error| format!("presentation lifecycle work did not return a result: {error}"))?;
    trace_presentation(
        app,
        Some(generation),
        "main_thread_result_wait_end",
        format!(
            "operation={} status={}",
            operation_name,
            if result.is_ok() { "ok" } else { "error" }
        ),
    );
    result
}

#[tauri::command]
pub(crate) fn get_presentation_displays(
    window: tauri::WebviewWindow,
    backend: tauri::State<'_, super::BackendProcess>,
) -> Result<PresentationDisplayInfo, String> {
    authorize_window(&window, &backend, &["main"])?;
    let records = discover_display_records(&window)?;
    Ok(display_info(&records))
}

#[tauri::command]
pub(crate) fn get_presentation_session(
    window: tauri::WebviewWindow,
    backend: tauri::State<'_, super::BackendProcess>,
    state: tauri::State<'_, PresentationState>,
) -> Result<PresentationSession, String> {
    authorize_window(&window, &backend, &["main", "controller"])?;
    state.snapshot()
}

// Controller construction must not run inline in the WebView IPC callback. Tauri documents
// WebviewWindowBuilder as deadlocking on Windows from synchronous commands/event handlers.
#[tauri::command(async)]
pub(crate) fn activate_local_presentation(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    backend: tauri::State<'_, super::BackendProcess>,
    state: tauri::State<'_, PresentationState>,
    display_id: String,
) -> Result<PresentationSession, String> {
    trace_presentation(
        &app,
        None,
        "activation_command_begin",
        format!("window={}", window.label()),
    );
    authorize_window(&window, &backend, &["main"])?;
    let requested_display_id = display_id.trim();
    if requested_display_id.is_empty() || requested_display_id.len() > 1024 {
        return Err("a valid presentation display must be selected".to_string());
    }
    let records = discover_display_records(&window)?;
    let target = records
        .iter()
        .find(|record| record.display.id == requested_display_id && record.display.selectable)
        .cloned()
        .ok_or_else(|| "the selected presentation display is unavailable".to_string())?;
    let controller_record = records
        .iter()
        .find(|record| record.display.controller && record.display.primary)
        .cloned()
        .ok_or_else(|| "the primary Controller display is unavailable".to_string())?;
    let placement = capture_host_placement(&window)?;
    let activating = state.begin_activation(
        target.display.id.clone(),
        controller_record.display.id.clone(),
        placement.clone(),
    )?;
    trace_presentation(
        &app,
        Some(activating.generation),
        "activation_state_begun",
        format!("display_count={}", records.len()),
    );
    let activation_attempt = ActivationAttemptGuard::new(&state, activating.generation);
    trace_presentation(
        &app,
        Some(activating.generation),
        "controller_build_begin",
        "",
    );
    let controller_result = create_controller_window(&app, &window, activating.generation);
    trace_presentation(
        &app,
        Some(activating.generation),
        "controller_build_end",
        format!(
            "status={}",
            if controller_result.is_ok() {
                "ok"
            } else {
                "error"
            }
        ),
    );
    let activation_result = controller_result
        .map_err(|error| format!("failed to create Controller: {error}"))
        .and_then(|controller| {
            let lifecycle_app = app.clone();
            let host = window.clone();
            let target_monitor = target.monitor.clone();
            let controller_monitor = controller_record.monitor.clone();
            let selected_display_id = target.display.id.clone();
            let activating = activating.clone();
            run_on_main_thread_with_result(&app, activating.generation, "activate", move || {
                let state = lifecycle_app.state::<PresentationState>();
                state.ensure_activation_native_owner(activating.generation)?;
                place_controller_for_activation(
                    &lifecycle_app,
                    &controller,
                    &controller_monitor,
                    &state,
                    activating.generation,
                )?;
                place_host_for_activation(
                    &lifecycle_app,
                    &host,
                    &target_monitor,
                    &state,
                    activating.generation,
                )?;
                state.ensure_activation_native_owner(activating.generation)?;
                let placement_is_valid = discover_display_records(&host)
                    .map_err(|error| format!("failed to verify presentation placement: {error}"))?
                    .iter()
                    .any(|record| {
                        record.display.id == selected_display_id && record.display.selectable
                    });
                if !placement_is_valid {
                    return Err(
                        "the selected presentation display changed during placement".to_string()
                    );
                }
                let activating = state
                    .mark_placement_prepared(activating.generation)
                    .map_err(|error| format!("failed to commit presentation placement: {error}"))?;
                run_activation_window_mutation(
                    &lifecycle_app,
                    &state,
                    activating.generation,
                    "show Controller",
                    || controller.show(),
                )?;
                run_activation_window_mutation(
                    &lifecycle_app,
                    &state,
                    activating.generation,
                    "focus Controller",
                    || controller.set_focus(),
                )?;
                state.ensure_activation_native_owner(activating.generation)?;
                emit_state(&lifecycle_app, &activating)
                    .map_err(|error| format!("failed to publish activating state: {error}"))?;
                state.ensure_activation_native_owner(activating.generation)?;
                emit_composition(
                    &lifecycle_app,
                    activating.generation,
                    HostComposition::StageOnly,
                )
                .map_err(|error| format!("failed to publish Stage-only composition: {error}"))?;
                let (_, should_finalize) =
                    state
                        .mark_activation_published(activating.generation)
                        .map_err(|error| format!("failed to publish activation: {error}"))?;
                start_generation_watchers(
                    lifecycle_app.clone(),
                    activating.generation,
                    selected_display_id,
                );
                complete_activation_if_ready(
                    &lifecycle_app,
                    &state,
                    activating.generation,
                    should_finalize,
                )
            })
        });
    let settled = settle_activation_attempt(
        &app,
        &state,
        activating.generation,
        activation_attempt,
        activation_result,
    );
    trace_presentation(
        &app,
        Some(activating.generation),
        "activation_command_end",
        format!("status={}", if settled.is_ok() { "ok" } else { "error" }),
    );
    settled
}

fn settle_activation_attempt(
    app: &tauri::AppHandle,
    state: &PresentationState,
    generation: u64,
    activation_attempt: ActivationAttemptGuard<'_>,
    result: Result<PresentationSession, String>,
) -> Result<PresentationSession, String> {
    let mut error = result.as_ref().err().cloned();
    if error.is_some()
        && let Ok(session) = state.snapshot()
        && session.generation == generation
        && matches!(
            session.phase,
            PresentationPhase::Activating | PresentationPhase::Active
        )
        && let Err(recovery_error) = state.begin_recovery(
            Some(generation),
            PresentationRecoveryReason::ActivationFailed,
        )
    {
        let message = format!("activation recovery claim failed: {recovery_error}");
        error = Some(match error {
            Some(error) => format!("{error}; {message}"),
            None => message,
        });
    }
    let deferred_recovery = match activation_attempt.finish() {
        Ok(deferred_recovery) => deferred_recovery,
        Err(settlement_error) => {
            let message = format!("activation attempt settlement failed: {settlement_error}");
            error = Some(match error {
                Some(error) => format!("{error}; {message}"),
                None => message,
            });
            None
        }
    };
    if let Some(recovery_generation) = deferred_recovery {
        let recovery_app = app.clone();
        if let Err(recovery_error) = run_on_main_thread_with_result(
            app,
            recovery_generation,
            "deferred_recovery",
            move || {
                let state = recovery_app.state::<PresentationState>();
                force_finalize_recovery(&recovery_app, &state, recovery_generation)
            },
        ) {
            let message = format!("deferred activation recovery failed: {recovery_error}");
            error = Some(match error {
                Some(error) => format!("{error}; {message}"),
                None => message,
            });
        } else if error.is_none() {
            error = Some("presentation activation was interrupted before it settled".to_string());
        }
    }
    match error {
        Some(error) => Err(error),
        None => result,
    }
}

fn complete_activation_if_ready(
    app: &tauri::AppHandle,
    state: &PresentationState,
    generation: u64,
    should_finalize: bool,
) -> Result<PresentationSession, String> {
    if !should_finalize {
        return state.snapshot();
    }
    let result = (|| {
        state.ensure_activation_native_owner(generation)?;
        let host = app
            .get_webview_window("main")
            .ok_or_else(|| "main window is unavailable".to_string())?;
        let session = state.snapshot()?;
        let selected_id = session
            .selected_output_display_id
            .as_deref()
            .ok_or_else(|| "the presentation display identity is unavailable".to_string())?;
        state.ensure_activation_native_owner(generation)?;
        let target_is_still_valid = discover_display_records(&host)?
            .iter()
            .any(|record| record.display.id == selected_id && record.display.selectable);
        if !target_is_still_valid {
            return Err("the selected presentation display changed before fullscreen".to_string());
        }
        run_activation_window_mutation(app, state, generation, "fullscreen Host", || {
            host.set_fullscreen(true)
        })?;
        let active = state.complete_activation(generation)?;
        emit_state(app, &active)
            .map_err(|error| format!("failed to publish active presentation state: {error}"))?;
        if let Some(controller) = app.get_webview_window("controller") {
            state.ensure_active_generation(generation)?;
            controller
                .set_focus()
                .map_err(|error| format!("failed to focus Controller: {error}"))?;
        }
        Ok(active)
    })();
    result.map_err(|error| recover_after_activation_failure(app, state, generation, error))
}

fn run_activation_readiness_step<T>(
    should_finalize: bool,
    operation: impl FnOnce() -> Result<T, String>,
    recover: impl FnOnce(String) -> String,
) -> Result<T, String> {
    operation().map_err(|error| {
        if should_finalize {
            recover(error)
        } else {
            error
        }
    })
}

#[tauri::command]
pub(crate) fn mark_presentation_host_ready(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    backend: tauri::State<'_, super::BackendProcess>,
    state: tauri::State<'_, PresentationState>,
    generation: u64,
    composition: HostComposition,
) -> Result<PresentationSession, String> {
    authorize_window(&window, &backend, &["main"])?;
    match composition {
        HostComposition::StageOnly => {
            let (ready, should_finalize) = state.mark_ready(generation, WindowRole::Host)?;
            run_activation_readiness_step(
                should_finalize,
                || {
                    emit_state(&app, &ready)
                        .map_err(|error| format!("failed to publish Host readiness: {error}"))
                },
                |error| recover_after_activation_failure(&app, &state, generation, error),
            )?;
            complete_activation_if_ready(&app, &state, generation, should_finalize)
        }
        HostComposition::Combined => {
            let ready = state.mark_recovery_host_ready(generation)?;
            let state_error = emit_state(&app, &ready).err();
            let finalization = finalize_recovery(&app, &state, generation);
            match (state_error, finalization) {
                (None, result) => result,
                (Some(error), Ok(_)) => Err(error),
                (Some(error), Err(finalization_error)) => {
                    Err(format!("{error}; {finalization_error}"))
                }
            }
        }
    }
}

#[tauri::command]
pub(crate) fn mark_presentation_controller_ready(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    backend: tauri::State<'_, super::BackendProcess>,
    state: tauri::State<'_, PresentationState>,
    generation: u64,
) -> Result<PresentationSession, String> {
    authorize_window(&window, &backend, &["controller"])?;
    let (ready, should_finalize) = state.mark_ready(generation, WindowRole::Controller)?;
    run_activation_readiness_step(
        should_finalize,
        || {
            emit_state(&app, &ready)
                .map_err(|error| format!("failed to publish Controller readiness: {error}"))?;
            if let Some(playback_state) = state
                .playback_state(generation)
                .map_err(|error| format!("failed to read Controller playback readiness: {error}"))?
            {
                emit_playback_state(&app, &playback_state).map_err(|error| {
                    format!("failed to publish Controller playback readiness: {error}")
                })?;
            }
            Ok(())
        },
        |error| recover_after_activation_failure(&app, &state, generation, error),
    )?;
    complete_activation_if_ready(&app, &state, generation, should_finalize)
}

#[tauri::command]
pub(crate) fn send_presentation_command(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    backend: tauri::State<'_, super::BackendProcess>,
    state: tauri::State<'_, PresentationState>,
    request: ControllerCommandRequest,
) -> Result<ControllerCommandAccepted, String> {
    authorize_window(&window, &backend, &["controller"])?;
    let generation = request.generation;
    let (accepted, command_to_emit) = state.enqueue_command(request)?;
    let publish_result = emit_state(&app, &state.snapshot()?).and_then(|_| {
        command_to_emit
            .as_ref()
            .map_or(Ok(()), |command| emit_host_command(&app, command))
    });
    if let Err(error) = publish_result {
        let recovery = begin_recovery_transaction(
            &app,
            &state,
            generation,
            PresentationRecoveryReason::CommandFailed,
        )
        .err();
        return Err(match recovery {
            Some(recovery) => format!(
                "failed to publish Controller command: {error}; recovery failed: {recovery}"
            ),
            None => format!("failed to publish Controller command: {error}"),
        });
    }
    Ok(accepted)
}

#[tauri::command]
pub(crate) fn acknowledge_presentation_command(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    backend: tauri::State<'_, super::BackendProcess>,
    state: tauri::State<'_, PresentationState>,
    generation: u64,
    sequence: u64,
) -> Result<PresentationSession, String> {
    authorize_window(&window, &backend, &["main"])?;
    let (session, next_command) = state.acknowledge_command(generation, sequence)?;
    let publish_result = emit_state(&app, &session).and_then(|_| {
        next_command
            .as_ref()
            .map_or(Ok(()), |command| emit_host_command(&app, command))
    });
    if let Err(error) = publish_result {
        let recovery = begin_recovery_transaction(
            &app,
            &state,
            generation,
            PresentationRecoveryReason::CommandFailed,
        )
        .err();
        return Err(match recovery {
            Some(recovery) => format!(
                "failed to publish queued Controller command: {error}; recovery failed: {recovery}"
            ),
            None => format!("failed to publish queued Controller command: {error}"),
        });
    }
    Ok(session)
}

#[tauri::command]
pub(crate) fn publish_presentation_playback_state(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    backend: tauri::State<'_, super::BackendProcess>,
    state: tauri::State<'_, PresentationState>,
    generation: u64,
    playback_state: ControllerPlaybackState,
) -> Result<ControllerPlaybackStateEnvelope, String> {
    authorize_window(&window, &backend, &["main"])?;
    let publication = state.publish_playback_state(generation, playback_state)?;
    if let Err(error) = emit_playback_state(&app, &publication.envelope) {
        let rollback_error = state.rollback_playback_state(&publication).err();
        return Err(match rollback_error {
            Some(rollback_error) => format!(
                "failed to publish Controller playback state: {error}; rollback failed: {rollback_error}"
            ),
            None => format!("failed to publish Controller playback state: {error}"),
        });
    }
    Ok(publication.envelope)
}

#[tauri::command]
pub(crate) fn deactivate_local_presentation(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    backend: tauri::State<'_, super::BackendProcess>,
    state: tauri::State<'_, PresentationState>,
    generation: u64,
) -> Result<PresentationSession, String> {
    authorize_window(&window, &backend, &["main", "controller"])?;
    begin_recovery_transaction(&app, &state, generation, PresentationRecoveryReason::User)
}

pub(crate) fn handle_controller_destroyed(app: &tauri::AppHandle) {
    let state = app.state::<PresentationState>();
    if state.is_shutting_down() {
        trace_presentation(
            app,
            None,
            "controller_destroyed_ignored",
            "reason=app_shutting_down",
        );
        return;
    }
    let Ok(session) = state.snapshot() else {
        trace_presentation(
            app,
            None,
            "controller_destroyed_ignored",
            "reason=state_unavailable",
        );
        return;
    };
    trace_presentation(
        app,
        Some(session.generation),
        "controller_destroyed",
        format!("phase={:?}", session.phase),
    );
    if matches!(
        session.phase,
        PresentationPhase::Activating | PresentationPhase::Active
    ) && let Err(error) = begin_recovery_transaction(
        app,
        &state,
        session.generation,
        PresentationRecoveryReason::ControllerClosed,
    ) {
        eprintln!("Failed to recover after Controller closed: {error}");
    }
}

pub(crate) fn prepare_app_shutdown(app: &tauri::AppHandle) {
    let state = app.state::<PresentationState>();
    let generation = state.snapshot().ok().map(|session| session.generation);
    trace_presentation(app, generation, "app_shutdown_begin", "");
    state.mark_shutting_down();
    let close_result = close_controller(app);
    trace_presentation(
        app,
        generation,
        "app_shutdown_controller_close_end",
        format!(
            "status={}",
            if close_result.is_ok() { "ok" } else { "error" }
        ),
    );
}

#[cfg(target_os = "macos")]
fn selected_display_still_available(
    _host: &tauri::WebviewWindow,
    selected_id: &str,
) -> Result<bool, String> {
    use core_graphics::display::CGDisplay;

    let active = CGDisplay::active_displays()
        .map_err(|error| format!("macOS display discovery failed with code {error}"))?;
    let main_display_id = CGDisplay::main().id;
    for display_id in active {
        let display = CGDisplay::new(display_id);
        if display_id == main_display_id || display.is_in_mirror_set() {
            continue;
        }
        let uuid = macos_display_uuid(display_id)?;
        if selected_id == format!("macos-uuid:{uuid}") {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(not(target_os = "macos"))]
fn selected_display_still_available(
    host: &tauri::WebviewWindow,
    selected_id: &str,
) -> Result<bool, String> {
    Ok(discover_display_records(host)?
        .iter()
        .any(|record| record.display.id == selected_id && record.display.selectable))
}

fn schedule_generation_recovery(
    app: tauri::AppHandle,
    generation: u64,
    reason: PresentationRecoveryReason,
) {
    let dispatcher = app.clone();
    if let Err(error) = dispatcher.run_on_main_thread(move || {
        let state = app.state::<PresentationState>();
        if let Err(error) = begin_recovery_transaction(&app, &state, generation, reason) {
            eprintln!("Failed to recover presentation generation {generation}: {error}");
        }
    }) {
        eprintln!("Failed to schedule presentation recovery: {error}");
    }
}

fn start_generation_watchers(app: tauri::AppHandle, generation: u64, selected_display_id: String) {
    let timeout_app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(ACTIVATION_READY_TIMEOUT);
        let state = timeout_app.state::<PresentationState>();
        let Ok(session) = state.snapshot() else {
            return;
        };
        if session.generation == generation && session.phase == PresentationPhase::Activating {
            schedule_generation_recovery(
                timeout_app,
                generation,
                PresentationRecoveryReason::ActivationFailed,
            );
        }
    });

    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_secs(1));
            let state = app.state::<PresentationState>();
            if state.is_shutting_down() {
                break;
            }
            let Ok(session) = state.snapshot() else {
                continue;
            };
            if session.generation != generation
                || !matches!(
                    session.phase,
                    PresentationPhase::Activating | PresentationPhase::Active
                )
            {
                break;
            }
            let Some(host) = app.get_webview_window("main") else {
                continue;
            };
            let still_available = match selected_display_still_available(
                &host,
                &selected_display_id,
            ) {
                Ok(still_available) => still_available,
                Err(error) => {
                    eprintln!(
                        "Presentation display discovery failed; recovering the current generation: {error}"
                    );
                    false
                }
            };
            if !still_available {
                schedule_generation_recovery(
                    app,
                    generation,
                    PresentationRecoveryReason::DisplayDisconnected,
                );
                break;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{
        ActivationAttemptGuard, ControllerCommand, ControllerCommandRequest,
        ControllerPlaybackState, HostWindowPlacement, MAX_PENDING_COMMANDS, MAX_SAFE_JS_INTEGER,
        MediaRendererOwner, MonitorGeometry, PlaybackAuthorityIdentity, PresentationMode,
        PresentationPhase, PresentationRecoveryReason, PresentationSession, PresentationState,
        WindowRole, deliver_main_thread_operation_result, display_source_is_mirrored,
        next_sequence, run_activation_readiness_step, validate_controller_command,
        validate_playback_state, visible_restore_placement,
    };
    use crate::{RuntimeDesktopDiagnosticEnqueue, RuntimeDesktopDiagnostics};
    use std::cell::RefCell;

    fn host_placement() -> HostWindowPlacement {
        HostWindowPlacement {
            position: tauri::PhysicalPosition::new(100, 200),
            size: tauri::PhysicalSize::new(1024, 768),
            decorations: true,
            resizable: true,
            fullscreen: false,
            maximized: false,
        }
    }

    fn begin_state() -> (PresentationState, u64) {
        let state = PresentationState::default();
        let session = state
            .begin_activation(
                "display:audience".to_string(),
                "display:primary".to_string(),
                host_placement(),
            )
            .expect("activation should begin");
        (state, session.generation)
    }

    fn active_state() -> (PresentationState, u64) {
        let (state, generation) = begin_state();
        state
            .mark_ready(generation, WindowRole::Controller)
            .expect("early Controller readiness should be recorded");
        state
            .mark_placement_prepared(generation)
            .expect("placement should be prepared");
        state
            .mark_activation_published(generation)
            .expect("activation should be published");
        let (_, should_finalize) = state
            .mark_ready(generation, WindowRole::Host)
            .expect("Host readiness should be accepted");
        assert!(should_finalize);
        state
            .complete_activation(generation)
            .expect("activation should complete");
        state
            .finish_activation_attempt(generation)
            .expect("activation command should settle");
        (state, generation)
    }

    #[test]
    fn presentation_success_result_precedes_full_completion_diagnostic() {
        let (diagnostic_sender, _diagnostic_receiver) = std::sync::mpsc::sync_channel(1);
        let diagnostics = RuntimeDesktopDiagnostics::from_sender(diagnostic_sender);
        assert_eq!(
            diagnostics.enqueue("occupied", "record"),
            RuntimeDesktopDiagnosticEnqueue::Enqueued
        );
        let (result_sender, result_receiver) = std::sync::mpsc::sync_channel(1);
        let delivered_result = RefCell::new(None);
        let completion_outcome = RefCell::new(None);

        deliver_main_thread_operation_result(result_sender, Ok(42_u32), |succeeded| {
            assert!(succeeded);
            *delivered_result.borrow_mut() = result_receiver.try_recv().ok();
            *completion_outcome.borrow_mut() = Some(diagnostics.enqueue("completion", "status=ok"));
        });

        assert_eq!(*delivered_result.borrow(), Some(Ok(42_u32)));
        assert_eq!(
            *completion_outcome.borrow(),
            Some(RuntimeDesktopDiagnosticEnqueue::DroppedFull)
        );
    }

    #[test]
    fn presentation_failure_result_precedes_disconnected_completion_diagnostic() {
        let (diagnostic_sender, diagnostic_receiver) = std::sync::mpsc::sync_channel(1);
        drop(diagnostic_receiver);
        let diagnostics = RuntimeDesktopDiagnostics::from_sender(diagnostic_sender);
        let (result_sender, result_receiver) = std::sync::mpsc::sync_channel(1);
        let delivered_result = RefCell::new(None);
        let completion_outcome = RefCell::new(None);

        deliver_main_thread_operation_result(
            result_sender,
            Err::<(), _>("native mutation failed".to_string()),
            |succeeded| {
                assert!(!succeeded);
                *delivered_result.borrow_mut() = result_receiver.try_recv().ok();
                *completion_outcome.borrow_mut() =
                    Some(diagnostics.enqueue("completion", "status=error"));
            },
        );

        assert_eq!(
            *delivered_result.borrow(),
            Some(Err("native mutation failed".to_string()))
        );
        assert_eq!(
            *completion_outcome.borrow(),
            Some(RuntimeDesktopDiagnosticEnqueue::DroppedDisconnected)
        );
    }

    #[test]
    fn default_session_has_one_host_authority_and_renderer() {
        let session = PresentationSession::default();
        assert_eq!(session.mode, PresentationMode::SingleScreen);
        assert_eq!(session.phase, PresentationPhase::Inactive);
        assert_eq!(session.playback_authority, PlaybackAuthorityIdentity::Host);
        assert_eq!(session.media_renderer_owner, MediaRendererOwner::Host);
        assert!(session.host_ready);
        assert!(!session.controller_ready);
    }

    #[test]
    fn activation_waits_for_placement_and_both_generation_bound_roles() {
        let (state, generation) = begin_state();
        let (controller_ready, finalize) = state
            .mark_ready(generation, WindowRole::Controller)
            .expect("Controller readiness should be accepted");
        assert!(controller_ready.controller_ready);
        assert!(!controller_ready.host_ready);
        assert!(!finalize);
        state
            .mark_placement_prepared(generation)
            .expect("placement should be accepted");
        state
            .mark_activation_published(generation)
            .expect("activation publication should be accepted");
        let (both_ready, finalize) = state
            .mark_ready(generation, WindowRole::Host)
            .expect("Host readiness should be accepted");
        assert!(both_ready.host_ready && both_ready.controller_ready);
        assert!(finalize);
        let active = state
            .complete_activation(generation)
            .expect("ready activation should complete");
        assert_eq!(active.phase, PresentationPhase::Active);
    }

    #[test]
    fn stale_readiness_does_not_mutate_the_session() {
        let (state, generation) = begin_state();
        assert!(state.mark_ready(generation + 1, WindowRole::Host).is_err());
        assert!(!state.snapshot().expect("snapshot").host_ready);
    }

    #[test]
    fn final_host_readiness_publication_failure_starts_recovery() {
        let (state, generation) = begin_state();
        state
            .mark_placement_prepared(generation)
            .expect("placement should be prepared");
        state
            .mark_activation_published(generation)
            .expect("activation should be published");
        state
            .mark_ready(generation, WindowRole::Controller)
            .expect("Controller readiness should be accepted");
        let (_, should_finalize) = state
            .mark_ready(generation, WindowRole::Host)
            .expect("Host readiness should claim finalization");
        let result = run_activation_readiness_step(
            should_finalize,
            || Err::<(), _>("Host readiness emission failed".to_string()),
            |error| {
                state
                    .begin_recovery(
                        Some(generation),
                        PresentationRecoveryReason::ActivationFailed,
                    )
                    .expect("claimed emission failure should begin recovery");
                error
            },
        );
        assert!(result.is_err());
        assert_eq!(
            state.snapshot().expect("snapshot").phase,
            PresentationPhase::Recovering
        );
    }

    #[test]
    fn final_controller_readiness_publication_failure_starts_recovery() {
        let (state, generation) = begin_state();
        state
            .mark_placement_prepared(generation)
            .expect("placement should be prepared");
        state
            .mark_activation_published(generation)
            .expect("activation should be published");
        state
            .mark_ready(generation, WindowRole::Host)
            .expect("Host readiness should be accepted");
        let (_, should_finalize) = state
            .mark_ready(generation, WindowRole::Controller)
            .expect("Controller readiness should claim finalization");
        let result = run_activation_readiness_step(
            should_finalize,
            || Err::<(), _>("Controller playback emission failed".to_string()),
            |error| {
                state
                    .begin_recovery(
                        Some(generation),
                        PresentationRecoveryReason::ActivationFailed,
                    )
                    .expect("claimed emission failure should begin recovery");
                error
            },
        );
        assert!(result.is_err());
        assert_eq!(
            state.snapshot().expect("snapshot").phase,
            PresentationPhase::Recovering
        );
    }

    #[test]
    fn readiness_before_activation_publication_completes_exactly_once() {
        let (state, generation) = begin_state();
        let (_, controller_finalize) = state
            .mark_ready(generation, WindowRole::Controller)
            .expect("early Controller readiness should be accepted");
        let (_, host_finalize) = state
            .mark_ready(generation, WindowRole::Host)
            .expect("early Host readiness should be accepted");
        assert!(!controller_finalize);
        assert!(!host_finalize);
        state
            .mark_placement_prepared(generation)
            .expect("placement should be accepted after readiness");
        let (_, publication_finalize) = state
            .mark_activation_published(generation)
            .expect("publication should claim finalization");
        assert!(publication_finalize);
        let active = state
            .complete_activation(generation)
            .expect("published ready activation should complete");
        assert_eq!(active.phase, PresentationPhase::Active);
        assert!(state.complete_activation(generation).is_err());
    }

    #[test]
    fn recovered_attempt_cannot_overlap_until_original_command_settles() {
        let (state, generation) = begin_state();
        let attempt = ActivationAttemptGuard::new(&state, generation);
        let recovery = state
            .begin_recovery(
                Some(generation),
                PresentationRecoveryReason::ActivationFailed,
            )
            .expect("activation recovery should begin");
        let recovering = recovery.session;
        assert!(recovery.started);
        assert!(!recovery.owns_native_lifecycle);
        assert!(state.ensure_activation_native_owner(generation).is_err());
        assert!(
            state
                .ensure_recovery_native_owner(recovering.generation)
                .is_err()
        );
        assert!(
            state
                .force_complete_recovery(recovering.generation)
                .is_err()
        );
        assert!(
            state
                .begin_activation(
                    "display:other".to_string(),
                    "display:primary".to_string(),
                    host_placement(),
                )
                .is_err()
        );
        assert_eq!(
            attempt.finish().expect("activation command should settle"),
            Some(recovering.generation)
        );
        state
            .mark_host_window_restored(recovering.generation)
            .expect("recovery placement should be restored");
        let inactive = state
            .force_complete_recovery(recovering.generation)
            .expect("settled activation should allow recovery to finish");
        assert_eq!(inactive.phase, PresentationPhase::Inactive);
        assert!(
            state
                .begin_activation(
                    "display:other".to_string(),
                    "display:primary".to_string(),
                    host_placement(),
                )
                .is_ok()
        );
    }

    #[test]
    fn recovery_claim_revokes_stale_activation_publication_and_native_mutation() {
        let (state, generation) = begin_state();
        let attempt = ActivationAttemptGuard::new(&state, generation);
        let recovery = state
            .begin_recovery(
                Some(generation),
                PresentationRecoveryReason::ControllerClosed,
            )
            .expect("Controller destruction should claim one recovery");
        assert!(recovery.started);
        assert!(!recovery.owns_native_lifecycle);
        let duplicate = state
            .begin_recovery(
                Some(recovery.session.generation),
                PresentationRecoveryReason::ControllerClosed,
            )
            .expect("duplicate Controller destruction should observe existing recovery");
        assert!(!duplicate.started);
        assert!(state.mark_placement_prepared(generation).is_err());
        assert!(state.mark_activation_published(generation).is_err());
        assert!(state.ensure_activation_native_owner(generation).is_err());
        assert_eq!(
            attempt.finish().expect("stale activation should settle"),
            Some(recovery.session.generation)
        );
        assert!(
            state
                .ensure_recovery_native_owner(recovery.session.generation)
                .is_ok()
        );
    }

    #[test]
    fn finalization_and_recovery_cannot_both_claim_native_ownership() {
        let (state, generation) = begin_state();
        state
            .mark_placement_prepared(generation)
            .expect("placement should be prepared");
        state
            .mark_activation_published(generation)
            .expect("activation should be published");
        state
            .finish_activation_attempt(generation)
            .expect("initial activation command should settle");
        state
            .mark_ready(generation, WindowRole::Host)
            .expect("Host readiness should be accepted");
        let (_, should_finalize) = state
            .mark_ready(generation, WindowRole::Controller)
            .expect("Controller readiness should claim finalization");
        assert!(should_finalize);
        assert!(state.ensure_activation_native_owner(generation).is_ok());
        let recovery = state
            .begin_recovery(
                Some(generation),
                PresentationRecoveryReason::ControllerClosed,
            )
            .expect("recovery should supersede unstarted finalization");
        assert!(recovery.started);
        assert!(recovery.owns_native_lifecycle);
        assert!(state.ensure_activation_native_owner(generation).is_err());
        assert!(state.complete_activation(generation).is_err());
        assert!(
            state
                .ensure_recovery_native_owner(recovery.session.generation)
                .is_ok()
        );
    }

    #[test]
    fn ordinary_activation_error_guard_clears_after_settlement() {
        let (state, generation) = begin_state();
        let attempt = ActivationAttemptGuard::new(&state, generation);
        let recovery = state
            .begin_recovery(
                Some(generation),
                PresentationRecoveryReason::ActivationFailed,
            )
            .expect("ordinary activation failure should claim recovery");
        let recovery_generation = attempt
            .finish()
            .expect("ordinary activation failure should settle")
            .expect("settlement should transfer recovery ownership");
        assert_eq!(recovery_generation, recovery.session.generation);
        state
            .force_complete_recovery(recovery_generation)
            .expect("ordinary activation failure should converge to inactive");
        assert!(
            state
                .begin_activation(
                    "display:other".to_string(),
                    "display:primary".to_string(),
                    host_placement(),
                )
                .is_ok()
        );
    }

    #[test]
    fn partially_resolved_windows_clone_group_is_mirrored() {
        assert!(display_source_is_mirrored(2, 1));
        assert!(display_source_is_mirrored(1, 0));
        assert!(!display_source_is_mirrored(1, 1));
    }

    #[test]
    fn commands_are_fifo_ordered_and_ack_releases_only_the_next_command() {
        let (state, generation) = active_state();
        let (first, first_emit) = state
            .enqueue_command(ControllerCommandRequest {
                generation,
                sequence: 1,
                command: ControllerCommand::Play,
            })
            .expect("first command should enqueue");
        let (second, second_emit) = state
            .enqueue_command(ControllerCommandRequest {
                generation,
                sequence: 2,
                command: ControllerCommand::Pause,
            })
            .expect("second command should enqueue");
        assert_eq!(first.sequence, 1);
        assert_eq!(second.sequence, 2);
        assert_eq!(
            first_emit.expect("first emits").target,
            PlaybackAuthorityIdentity::Host
        );
        assert!(second_emit.is_none());
        assert!(
            state
                .enqueue_command(ControllerCommandRequest {
                    generation,
                    sequence: 2,
                    command: ControllerCommand::NextTrack,
                })
                .is_err()
        );
        let (session, next) = state
            .acknowledge_command(generation, 1)
            .expect("first acknowledgement should release second");
        assert_eq!(session.last_applied_command_sequence, 1);
        assert_eq!(next.expect("second command should emit").sequence, 2);
        assert!(state.acknowledge_command(generation, 1).is_err());
        assert!(
            state
                .enqueue_command(ControllerCommandRequest {
                    generation: generation + 1,
                    sequence: 3,
                    command: ControllerCommand::NextTrack,
                })
                .is_err()
        );
    }

    #[test]
    fn command_queue_is_bounded() {
        let (state, generation) = active_state();
        for sequence in 1..=MAX_PENDING_COMMANDS as u64 {
            state
                .enqueue_command(ControllerCommandRequest {
                    generation,
                    sequence,
                    command: ControllerCommand::Pause,
                })
                .expect("queue capacity should be accepted");
        }
        assert!(
            state
                .enqueue_command(ControllerCommandRequest {
                    generation,
                    sequence: MAX_PENDING_COMMANDS as u64 + 1,
                    command: ControllerCommand::Pause,
                })
                .is_err()
        );
    }

    #[test]
    fn controller_payloads_are_bounded_and_finite() {
        assert!(validate_controller_command(&ControllerCommand::Play).is_ok());
        assert!(
            validate_controller_command(&ControllerCommand::SeekAbsolute {
                target_seconds: 12.5,
            })
            .is_ok()
        );
        assert!(
            validate_controller_command(&ControllerCommand::SeekAbsolute {
                target_seconds: f64::NAN,
            })
            .is_err()
        );
        assert!(
            validate_controller_command(&ControllerCommand::SeekRelative {
                delta_seconds: 601.0,
            })
            .is_err()
        );
        assert!(
            validate_controller_command(&ControllerCommand::SetVolume {
                volume_percent: 101,
                muted: false,
            })
            .is_err()
        );
    }

    #[test]
    fn controller_command_json_uses_camel_case_fields() {
        let cases = [
            (
                serde_json::json!({"type": "seekRelative", "deltaSeconds": -15.0}),
                ControllerCommand::SeekRelative {
                    delta_seconds: -15.0,
                },
            ),
            (
                serde_json::json!({"type": "seekAbsolute", "targetSeconds": 55.0}),
                ControllerCommand::SeekAbsolute {
                    target_seconds: 55.0,
                },
            ),
            (
                serde_json::json!({
                    "type": "setVolume",
                    "volumePercent": 75,
                    "muted": false
                }),
                ControllerCommand::SetVolume {
                    volume_percent: 75,
                    muted: false,
                },
            ),
        ];

        for (payload, expected) in cases {
            let request: ControllerCommandRequest = serde_json::from_value(serde_json::json!({
                "generation": 7,
                "sequence": 1,
                "command": payload.clone()
            }))
            .expect("camelCase Controller request should deserialize");
            assert_eq!(request.command, expected);
            assert_eq!(
                serde_json::to_value(request.command).expect("Controller command should serialize"),
                payload
            );
        }

        assert!(
            serde_json::from_value::<ControllerCommand>(serde_json::json!({
                "type": "seekAbsolute",
                "target_seconds": 55.0
            }))
            .is_err()
        );
    }

    #[test]
    fn playback_state_is_generation_and_revision_bound() {
        let (state, generation) = begin_state();
        let candidate = ControllerPlaybackState {
            revision: 1,
            item_identity: Some("song-1".to_string()),
            title: "Song".to_string(),
            paused: false,
            current_time_seconds: 1.5,
            duration_seconds: Some(120.0),
            volume_percent: 80,
            muted: false,
            can_skip: true,
        };
        assert!(validate_playback_state(&candidate).is_ok());
        state
            .publish_playback_state(generation, candidate.clone())
            .expect("first state should publish");
        assert!(state.publish_playback_state(generation, candidate).is_err());
    }

    #[test]
    fn failed_playback_publication_can_roll_back_without_consuming_revision_or_sequence() {
        let (state, generation) = begin_state();
        let candidate = ControllerPlaybackState {
            revision: 1,
            item_identity: Some("song-1".to_string()),
            title: "Song".to_string(),
            paused: true,
            current_time_seconds: 0.0,
            duration_seconds: Some(120.0),
            volume_percent: 80,
            muted: false,
            can_skip: true,
        };
        let publication = state
            .publish_playback_state(generation, candidate.clone())
            .expect("playback state should reserve a publication");
        assert_eq!(publication.envelope.sequence, 1);
        state
            .rollback_playback_state(&publication)
            .expect("failed emission should roll back its reservation");
        let retried = state
            .publish_playback_state(generation, candidate)
            .expect("the same revision should be retryable after rollback");
        assert_eq!(retried.envelope.sequence, 1);
    }

    #[test]
    fn recovery_advances_generation_and_never_selects_a_fallback_display() {
        let (state, generation) = active_state();
        let recovery = state
            .begin_recovery(
                Some(generation),
                PresentationRecoveryReason::DisplayDisconnected,
            )
            .expect("recovery should begin");
        let recovering = recovery.session;
        assert!(recovery.started);
        assert!(recovery.owns_native_lifecycle);
        assert_eq!(recovering.phase, PresentationPhase::Recovering);
        assert_eq!(recovering.generation, generation + 1);
        assert_eq!(
            recovering.selected_output_display_id.as_deref(),
            Some("display:audience")
        );
        assert!(state.acknowledge_command(generation, 1).is_err());
        state
            .mark_recovery_host_ready(recovering.generation)
            .expect("combined composition should be ready");
        state
            .mark_host_window_restored(recovering.generation)
            .expect("Host placement should be restored");
        let inactive = state
            .complete_recovery(recovering.generation)
            .expect("recovery should complete");
        assert_eq!(inactive.phase, PresentationPhase::Inactive);
        assert_eq!(inactive.selected_output_display_id, None);
        assert_eq!(
            inactive.recovery_reason,
            Some(PresentationRecoveryReason::DisplayDisconnected)
        );
    }

    #[test]
    fn forced_recovery_completion_clears_session_without_host_readiness() {
        let (state, generation) = active_state();
        let recovery = state
            .begin_recovery(
                Some(generation),
                PresentationRecoveryReason::ControllerClosed,
            )
            .expect("recovery should begin");
        let recovering = recovery.session;
        assert!(recovery.started);
        assert!(recovery.owns_native_lifecycle);
        assert!(!recovering.host_ready);
        let inactive = state
            .force_complete_recovery(recovering.generation)
            .expect("the bounded recovery deadline must converge the state");
        assert_eq!(inactive.phase, PresentationPhase::Inactive);
        assert_eq!(inactive.selected_output_display_id, None);
        assert_eq!(
            inactive.recovery_reason,
            Some(PresentationRecoveryReason::ControllerClosed)
        );
        assert!(
            state
                .mark_recovery_host_ready(recovering.generation)
                .is_err()
        );
    }

    #[test]
    fn invalid_original_placement_is_centered_on_primary() {
        let placement = HostWindowPlacement {
            position: tauri::PhysicalPosition::new(4000, 0),
            ..host_placement()
        };
        let primary = MonitorGeometry {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
        };
        let (position, size, original_visible) = visible_restore_placement(
            &placement,
            std::slice::from_ref(&primary),
            Some((
                tauri::PhysicalPosition::new(0, 0),
                tauri::PhysicalSize::new(1920, 1040),
            )),
        );
        assert!(!original_visible);
        assert_eq!(size, placement.size);
        assert_eq!(position, tauri::PhysicalPosition::new(448, 136));
    }

    #[test]
    fn mirrored_and_adjacent_geometry_are_distinct_policies() {
        let primary = MonitorGeometry {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
        };
        let mirrored = MonitorGeometry {
            x: 0,
            y: 0,
            width: 1280,
            height: 720,
        };
        let adjacent = MonitorGeometry {
            x: 1920,
            y: 0,
            width: 2560,
            height: 1440,
        };
        assert!(primary.same_origin(mirrored));
        assert!(!primary.same_origin(adjacent));
    }

    #[test]
    fn counters_never_wrap_or_exceed_javascript_safe_integers() {
        assert_eq!(
            next_sequence(MAX_SAFE_JS_INTEGER - 1, "counter").expect("last safe value"),
            MAX_SAFE_JS_INTEGER
        );
        assert!(next_sequence(MAX_SAFE_JS_INTEGER, "counter").is_err());
        assert!(next_sequence(u64::MAX, "counter").is_err());
    }

    #[test]
    fn manual_fullscreen_is_allowed_only_while_inactive() {
        let state = PresentationState::default();
        assert!(state.allows_manual_fullscreen());
        state
            .begin_activation(
                "display:audience".to_string(),
                "display:primary".to_string(),
                host_placement(),
            )
            .expect("activation should begin");
        assert!(!state.allows_manual_fullscreen());
    }
}
