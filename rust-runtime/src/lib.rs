mod bilibili_service;
mod cloudflare_service;
mod diagnostics;
mod ffi;
mod gatcha_repository;
mod http_downloader;
mod json_http;
mod media_backend;
mod networking;
mod status_service;
mod update_installer;

pub use bilibili_service::{
    BilibiliDashRequest, BilibiliDashResult, BilibiliServiceError, BilibiliStream,
    fetch_dash_playurl,
};
pub use diagnostics::{DiagnosticError, DiagnosticRequest, DiagnosticResult};
pub use ffi::{
    bilikara_runtime_abi_version, bilikara_runtime_download, bilikara_runtime_free_string,
    bilikara_runtime_media_normalize, bilikara_runtime_media_probe, bilikara_runtime_service,
    bilikara_runtime_status_service,
};
pub use gatcha_repository::{GatchaRepositoryError, GatchaRepositoryRequest, execute_gatcha};
pub use http_downloader::{
    DownloadCandidate, DownloadError, DownloadErrorKind, DownloadProgress, DownloadRequest,
    DownloadResult, HttpHeader, download_to_path,
};
pub use json_http::{JsonHttpError, JsonHttpRequest, JsonHttpResult};
pub use media_backend::{
    ExpectedMediaKind, MediaError, MediaErrorKind, MediaNormalizeRequest, MediaNormalizeResult,
    MediaPathRequest, MediaProbe, normalize_media, probe_media,
};
pub use networking::{
    InterfaceAddress, NetworkAddressRequest, NetworkAddressResult, detect_lan_ipv4_addresses,
    rank_lan_ipv4_candidates,
};
pub use status_service::{
    BilibiliLoginFacts, BilibiliLoginSnapshot, BilibiliLoginStatus, BilibiliLoginUpdate,
    GachaTaskSnapshot, GachaTaskStatus, GachaTaskUpdate, RuntimeStatusService,
};
pub use update_installer::{
    LaunchUpdateHelperRequest, PrepareUpdateRequest, PrepareUpdateResult, UpdateInstallerError,
};
