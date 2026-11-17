use super::privacy::AddressClass;
use serde::{Deserialize, Serialize};

macro_rules! choices {
    ($name:ident { $($v:ident),+ $(,)? }) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
        #[serde(rename_all = "snake_case")]
        pub enum $name { $($v),+ }
    }
}
choices!(TargetKind {
    Purek,
    Generic,
    Lebo
});
choices!(Platform {
    Windows,
    Macos,
    Linux,
    Android,
    Other
});
choices!(InterfaceKind {
    Ethernet,
    Wireless,
    Virtual,
    Vpn,
    Tun,
    Other
});
choices!(NetworkProfile {
    Private,
    Public,
    Domain,
    NotApplicable,
    Unavailable
});
choices!(SelfTestStage {
    S0,
    S1,
    S2,
    S3,
    S4,
    S5,
    S6,
    S7
});
choices!(StageOutcome {
    Complete,
    Failed,
    Skipped,
    Cancelled
});
choices!(Cell {
    FileA,
    FileB,
    LiveA,
    LiveB,
    FileMp4A
});
choices!(Variant { A, B });
choices!(Mode {
    File,
    Live,
    FileMp4
});
choices!(VideoAnswer {
    Normal,
    Stuttering,
    Black,
    Unsupported,
    Uncertain,
    Unanswered
});
choices!(Answer {
    Yes,
    No,
    Uncertain,
    Unanswered
});
choices!(Codec {
    H264,
    Hevc,
    Av1,
    Aac,
    Mp3,
    Flac,
    Opus,
    Other
});
choices!(Mime {
    Ts,
    Mpeg,
    Mp4,
    Audio,
    Wildcard,
    Other
});
choices!(ProtocolState {
    NotChecked,
    Reported,
    Empty,
    Unavailable
});
choices!(Transport {
    Stopped,
    Playing,
    Transitioning,
    PausedPlayback,
    NoMediaPresent,
    Unknown
});
choices!(Failure {
    UnsupportedCodec,
    PrepareFailed,
    BackendUnavailable,
    PipelineFailed,
    Interrupted
});
choices!(SkipReason {
    NoCachedSong,
    SamplePreparationFailed,
    SampleUnavailable,
    SampleIntegrityFailed,
    SampleStorageInsufficient,
    SampleCopyFailed,
    NoReceiver,
    Cancelled,
    NotNeeded,
    PlatformUnavailable
});

#[derive(Clone, Debug, Default, Serialize)]
pub struct Environment {
    pub android_network: Option<crate::cast_platform::NetworkFacts>,
    pub network_hint: Option<crate::cast_platform::NetworkHint>,
    pub interface_kinds: Vec<InterfaceKind>,
    pub exit_address_class: Option<AddressClass>,
    pub same_subnet_24: Option<bool>,
    pub windows_network_type: Option<NetworkProfile>,
    pub windows_network_reason: Option<NetworkProfileReason>,
    pub vpn_or_tun: Option<bool>,
    pub companion_mpegts: Option<bool>,
    pub companion_aac: Option<bool>,
    pub companion_annexb: Option<bool>,
    pub sample_b_verified: Option<bool>,
}
choices!(NetworkProfileReason {
    NoReceiverRoute,
    AdapterUnavailable,
    ComUnavailable,
    QueryFailed,
    NoConnectedNetwork,
    ConflictingCategories
});

#[derive(Clone, Debug, Default, Serialize)]
pub struct MediaPreflight {
    pub video_codec: Option<Codec>,
    pub profile: Option<i32>,
    pub level: Option<i32>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fps_milli: Option<u32>,
    pub has_b_frames: Option<bool>,
    pub gop_us: Option<i64>,
    pub audio_codec: Option<Codec>,
    pub synthesis_ms: Option<u64>,
    pub file_size: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UserAnswers {
    pub video: VideoAnswer,
    pub audio: Answer,
    pub synchronized: Answer,
}
impl Default for UserAnswers {
    fn default() -> Self {
        Self {
            video: VideoAnswer::Unanswered,
            audio: Answer::Unanswered,
            synchronized: Answer::Unanswered,
        }
    }
}

/// Facts unavailable in T4 v1 must stay unknown until T8 measures them.
#[derive(Clone, Debug, Default, Serialize)]
pub struct RequestObservations {
    pub range_requests: Option<u64>,
    pub source_matches_description: Option<bool>,
    pub source_same_subnet_24: Option<bool>,
    pub maximum_concurrent_get: Option<u64>,
    pub over_client_limit: Option<u64>,
    pub last_byte_ms: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
pub struct SelfTestStep {
    pub stage: SelfTestStage,
    pub outcome: StageOutcome,
    pub elapsed_ms: u64,
}

#[derive(Clone, Debug)]
pub struct OutputConfig {
    pub cell: Option<Cell>,
    pub mode: Mode,
    pub mime: Mime,
    pub preflight: MediaPreflight,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Conclusion {
    pub learned_mode: Option<Mode>,
    pub learned_variant: Option<Variant>,
    pub decision_row: Option<u8>,
}
