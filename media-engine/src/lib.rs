//! Native GStreamer playback engine for the bilikara desktop Host.
//!
//! Rust AppState remains the only business authority. This crate executes one
//! already-authorized program (video artifact plus selected audio variant) at
//! a time, reports identity-bound observations and never selects Next, edits a
//! queue or writes history. See `docs/media-backend.md`.
mod engine;
mod frame;
mod identity;
mod pipeline;
mod pitch;

pub use engine::{
    observation_json, probe, Capability, Command, CommandError, CommandReceipt, Engine,
    EngineConfig, Observation, ObservationKind, Observer, Phase, SettingsPatch, Snapshot,
};
pub use frame::{FrameSink, NullFrameSink, VideoFrame};
pub use identity::ProgramIdentity;
pub use pipeline::{
    loopback_no_proxy, AudioOutput, ClockMode, MediaSource, OutputSettings, PcmSink, SinkKind,
    MAX_AV_DELAY_MS, MAX_VOLUME,
};
pub use pitch::{latency_frames, MAX_SEMITONES, RATE as PCM_RATE};
