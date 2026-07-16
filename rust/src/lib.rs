mod archive;
mod asset_selection;
mod asset_tokens;
mod audio_binding;
mod ffi;
mod filename;
mod media_page_selection;
mod platform;
mod release_selection;
mod title_cleanup;
mod url_utils;
mod version;

pub use audio_binding::{
    AudioBindingDecision, AudioBindingError, AudioBindingMode, AudioBindingRequest,
    AudioBindingResult, AudioPageDescriptor, decide_audio_binding,
};
pub use ffi::{
    rust_asset_has_arm64, rust_asset_has_linux, rust_asset_has_macos, rust_asset_has_universal,
    rust_asset_has_windows, rust_asset_has_x64, rust_asset_tokens, rust_backend_abi_version,
    rust_clean_display_title, rust_decide_audio_binding, rust_format_download_proxy_url,
    rust_free_string, rust_is_downloadable_archive, rust_normalize_machine_arch,
    rust_normalize_version_tag, rust_release_list_api_from_latest, rust_safe_filename,
    rust_select_media_pages, rust_select_release, rust_select_update_asset, rust_version_sort_key,
    rust_version_tuple,
};
pub use media_page_selection::{
    MediaPageDescriptor, MediaPageSelection, MediaPageSelectionError, MediaPageSelectionRequest,
    select_media_pages,
};
pub use release_selection::{
    ReleaseCandidate, ReleaseSelection, ReleaseSelectionError, ReleaseSelectionRequest,
    select_release,
};
