mod ffi;
mod http_downloader;
mod media_backend;
mod status_service;

pub use ffi::{
    bilikara_runtime_abi_version, bilikara_runtime_download, bilikara_runtime_free_string,
    bilikara_runtime_media_normalize, bilikara_runtime_media_probe,
    bilikara_runtime_status_service,
};
pub use http_downloader::{
    DownloadCandidate, DownloadError, DownloadErrorKind, DownloadProgress, DownloadRequest,
    DownloadResult, HttpHeader, download_to_path,
};
pub use media_backend::{
    ExpectedMediaKind, MediaError, MediaErrorKind, MediaNormalizeRequest, MediaNormalizeResult,
    MediaPathRequest, MediaProbe, normalize_media, probe_media,
};
pub use status_service::{
    BilibiliLoginFacts, BilibiliLoginSnapshot, BilibiliLoginStatus, BilibiliLoginUpdate,
    GachaTaskSnapshot, GachaTaskStatus, GachaTaskUpdate, RuntimeStatusService,
};
