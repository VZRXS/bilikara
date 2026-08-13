mod archive;
mod asset_selection;
mod asset_tokens;
mod audio_binding;
mod audio_stream_ranking;
mod av_delay;
mod cache_planning;
mod download_candidate_planning;
mod ffi;
mod filename;
mod media_download_candidate_planning;
mod media_page_selection;
mod platform;
mod playback_selector_policy;
mod playlist_planning;
mod preferred_audio_source_binding;
mod quality_policy;
mod release_selection;
mod title_cleanup;
mod tool_download_candidate_planning;
mod tool_prepare_policy;
mod url_utils;
mod version;
mod video_stream_ranking;

pub use audio_binding::{
    AudioBindingDecision, AudioBindingError, AudioBindingMode, AudioBindingRequest,
    AudioBindingResult, AudioPageDescriptor, decide_audio_binding,
};
pub use audio_stream_ranking::{
    AudioRegularReason, AudioStreamDescriptor, AudioStreamSelection, AudioStreamSelectionError,
    AudioStreamSelectionRequest, select_audio_stream,
};
pub use av_delay::{
    AvDelayAction, AvDelayDecision, AvDelayState, MAX_AV_DELAY_MS, decide_av_delay,
};
pub use cache_planning::{
    CacheItem, CachePlan, CachePlanError, CachePlanRequest, plan_cache_window,
};
pub use download_candidate_planning::{
    PlannedUpdateCandidate, UpdateCandidateInput, UpdateCandidateRoute, UpdateCandidateSource,
    UpdateDownloadPlan, UpdateDownloadPlanError, UpdateDownloadPlanRequest, UpdateDownloadProxy,
    plan_update_download_candidates,
};
pub use ffi::{
    rust_apply_av_delay_action, rust_asset_has_arm64, rust_asset_has_linux, rust_asset_has_macos,
    rust_asset_has_universal, rust_asset_has_windows, rust_asset_has_x64, rust_asset_tokens,
    rust_backend_abi_version, rust_clean_display_title, rust_decide_audio_binding,
    rust_decide_playback_selector_policy, rust_decide_playlist_duplicate,
    rust_decide_quality_policy, rust_decide_tool_prepare_policy, rust_format_download_proxy_url,
    rust_free_string, rust_is_downloadable_archive, rust_normalize_machine_arch,
    rust_normalize_version_tag, rust_plan_cache_window, rust_plan_media_download_candidates,
    rust_plan_playlist_order, rust_plan_tool_download_candidates,
    rust_plan_update_download_candidates, rust_release_list_api_from_latest, rust_safe_filename,
    rust_select_audio_stream, rust_select_media_pages, rust_select_preferred_audio_source,
    rust_select_release, rust_select_update_asset, rust_select_video_stream, rust_version_sort_key,
    rust_version_tuple,
};
pub use media_download_candidate_planning::{
    MediaCandidateSource, MediaDownloadPlan, MediaDownloadPlanError, MediaDownloadPlanMode,
    MediaDownloadPlanRequest, MediaStreamKind, MediaStreamUrlInput, PlannedMediaCandidate,
    plan_media_download_candidates,
};
pub use media_page_selection::{
    MediaPageDescriptor, MediaPageSelection, MediaPageSelectionError, MediaPageSelectionRequest,
    select_media_pages,
};
pub use playback_selector_policy::{
    DEFAULT_PLAYBACK_SELECTOR_MODE, PersistedPlaybackSelectorMode, PlaybackSelectorDecision,
    PlaybackSelectorMode, PlaybackSelectorReason, PlaybackSelectorStatus,
    VALID_PLAYBACK_SELECTOR_MODES, decide_persisted_playback_selector_mode,
    validate_requested_playback_selector_mode,
};
pub use playlist_planning::{
    DuplicateActiveItem, DuplicateHistoryEntry, PlaylistDuplicateDecision,
    PlaylistDuplicateRequest, PlaylistIdentity, PlaylistOrderItem, PlaylistOrderOperation,
    PlaylistOrderPlan, PlaylistOrderRequest, PlaylistPlanError, PlaylistSlotType,
    decide_playlist_duplicate, plan_playlist_order,
};
pub use preferred_audio_source_binding::{
    PreferredAudioSource, PreferredAudioSourceError, PreferredAudioSourceRequest,
    PreferredAudioSourceSelection, PreferredRegularAudioCandidate, select_preferred_audio_source,
};
pub use quality_policy::{
    QualityPolicyDecision, QualityPolicyRequest, VideoQuality, decide_quality_policy,
};
pub use release_selection::{
    ReleaseCandidate, ReleaseSelection, ReleaseSelectionError, ReleaseSelectionRequest,
    select_release,
};
pub use tool_download_candidate_planning::{
    PlannedToolCandidate, ToolAssetInput, ToolCandidateSource, ToolDownloadPlan,
    ToolDownloadPlanError, ToolDownloadPlanRequest, ToolFallbackBaseInput, ToolKind, ToolTarget,
    plan_tool_download_candidates,
};
pub use tool_prepare_policy::{
    ToolPrepareAction, ToolPrepareDecision, ToolPrepareFacts, decide_tool_prepare,
};
pub use video_stream_ranking::{
    VideoCodec, VideoSelectionReason, VideoStreamDescriptor, VideoStreamSelection,
    VideoStreamSelectionError, VideoStreamSelectionRequest, select_video_stream,
};
