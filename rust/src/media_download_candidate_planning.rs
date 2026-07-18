use std::collections::HashSet;

use serde::{Deserialize, Serialize};

const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaDownloadPlanMode {
    DashStreams,
    PreferredAudio,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaStreamKind {
    Video,
    Audio,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaStreamUrlInput {
    pub original_index: usize,
    pub primary_url: String,
    pub backup_urls: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaDownloadPlanRequest {
    pub mode: MediaDownloadPlanMode,
    pub stream_kind: MediaStreamKind,
    pub streams: Vec<MediaStreamUrlInput>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaCandidateSource {
    Primary,
    Backup,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedMediaCandidate {
    pub stream_index: usize,
    pub source: MediaCandidateSource,
    pub backup_index: Option<usize>,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaDownloadPlan {
    pub candidates: Vec<PlannedMediaCandidate>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaDownloadPlanError {
    InvalidRequest,
}

pub fn plan_media_download_candidates(
    request: &MediaDownloadPlanRequest,
) -> Result<MediaDownloadPlan, MediaDownloadPlanError> {
    if request.mode == MediaDownloadPlanMode::PreferredAudio
        && (request.stream_kind != MediaStreamKind::Audio || request.streams.len() > 1)
    {
        return Err(MediaDownloadPlanError::InvalidRequest);
    }

    let mut indices = HashSet::with_capacity(request.streams.len());
    if request
        .streams
        .iter()
        .any(|stream| !indices.insert(stream.original_index))
    {
        return Err(MediaDownloadPlanError::InvalidRequest);
    }

    let mut candidates = Vec::new();
    for stream in &request.streams {
        push_candidate(
            &mut candidates,
            request.mode,
            stream.original_index,
            MediaCandidateSource::Primary,
            None,
            &stream.primary_url,
        );
        for (backup_index, backup_url) in stream.backup_urls.iter().enumerate() {
            push_candidate(
                &mut candidates,
                request.mode,
                stream.original_index,
                MediaCandidateSource::Backup,
                Some(backup_index),
                backup_url,
            );
        }
    }
    Ok(MediaDownloadPlan { candidates })
}

fn push_candidate(
    candidates: &mut Vec<PlannedMediaCandidate>,
    mode: MediaDownloadPlanMode,
    stream_index: usize,
    source: MediaCandidateSource,
    backup_index: Option<usize>,
    raw_url: &str,
) {
    let url = match mode {
        MediaDownloadPlanMode::DashStreams => raw_url.trim(),
        MediaDownloadPlanMode::PreferredAudio => raw_url,
    };
    if mode == MediaDownloadPlanMode::DashStreams && url.is_empty() {
        return;
    }
    candidates.push(PlannedMediaCandidate {
        stream_index,
        source,
        backup_index,
        url: url.to_string(),
    });
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct MediaDownloadPlanWireRequest {
    schema_version: u32,
    mode: MediaDownloadPlanModeWire,
    stream_kind: MediaStreamKindWire,
    streams: Vec<MediaStreamUrlWireInput>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum MediaDownloadPlanModeWire {
    DashStreams,
    PreferredAudio,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum MediaStreamKindWire {
    Video,
    Audio,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct MediaStreamUrlWireInput {
    original_index: usize,
    primary_url: String,
    backup_urls: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum MediaDownloadPlanWireStatus {
    Planned,
    Empty,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum MediaCandidateSourceWire {
    Primary,
    Backup,
}

#[derive(Debug, Serialize)]
struct PlannedMediaCandidateWire {
    stream_index: usize,
    source: MediaCandidateSourceWire,
    backup_index: Option<usize>,
    url: String,
}

#[derive(Debug, Serialize)]
struct MediaDownloadPlanWireResponse {
    schema_version: u32,
    status: MediaDownloadPlanWireStatus,
    candidates: Vec<PlannedMediaCandidateWire>,
}

pub(crate) fn plan_media_download_candidates_json(request_json: &str) -> Option<String> {
    let wire: MediaDownloadPlanWireRequest = serde_json::from_str(request_json).ok()?;
    if wire.schema_version != SCHEMA_VERSION {
        return None;
    }
    let mut previous_index = None;
    for stream in &wire.streams {
        if previous_index.is_some_and(|previous| stream.original_index <= previous) {
            return None;
        }
        previous_index = Some(stream.original_index);
    }
    let request = MediaDownloadPlanRequest {
        mode: match wire.mode {
            MediaDownloadPlanModeWire::DashStreams => MediaDownloadPlanMode::DashStreams,
            MediaDownloadPlanModeWire::PreferredAudio => MediaDownloadPlanMode::PreferredAudio,
        },
        stream_kind: match wire.stream_kind {
            MediaStreamKindWire::Video => MediaStreamKind::Video,
            MediaStreamKindWire::Audio => MediaStreamKind::Audio,
        },
        streams: wire
            .streams
            .into_iter()
            .map(|stream| MediaStreamUrlInput {
                original_index: stream.original_index,
                primary_url: stream.primary_url,
                backup_urls: stream.backup_urls,
            })
            .collect(),
    };
    let plan = plan_media_download_candidates(&request).ok()?;
    let status = if plan.candidates.is_empty() {
        MediaDownloadPlanWireStatus::Empty
    } else {
        MediaDownloadPlanWireStatus::Planned
    };
    serde_json::to_string(&MediaDownloadPlanWireResponse {
        schema_version: SCHEMA_VERSION,
        status,
        candidates: plan
            .candidates
            .into_iter()
            .map(|candidate| PlannedMediaCandidateWire {
                stream_index: candidate.stream_index,
                source: match candidate.source {
                    MediaCandidateSource::Primary => MediaCandidateSourceWire::Primary,
                    MediaCandidateSource::Backup => MediaCandidateSourceWire::Backup,
                },
                backup_index: candidate.backup_index,
                url: candidate.url,
            })
            .collect(),
    })
    .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stream(index: usize, primary: &str, backups: &[&str]) -> MediaStreamUrlInput {
        MediaStreamUrlInput {
            original_index: index,
            primary_url: primary.to_string(),
            backup_urls: backups.iter().map(|url| (*url).to_string()).collect(),
        }
    }

    fn request(
        mode: MediaDownloadPlanMode,
        kind: MediaStreamKind,
        streams: Vec<MediaStreamUrlInput>,
    ) -> MediaDownloadPlanRequest {
        MediaDownloadPlanRequest {
            mode,
            stream_kind: kind,
            streams,
        }
    }

    fn urls(plan: &MediaDownloadPlan) -> Vec<&str> {
        plan.candidates
            .iter()
            .map(|item| item.url.as_str())
            .collect()
    }

    #[test]
    fn dash_empty_primary_backup_order_and_duplicates_are_preserved() {
        let plan = plan_media_download_candidates(&request(
            MediaDownloadPlanMode::DashStreams,
            MediaStreamKind::Video,
            vec![
                stream(2, " primary ", &[" backup ", "primary", " "]),
                stream(5, "", &["backup", "backup"]),
            ],
        ))
        .unwrap();
        assert_eq!(
            urls(&plan),
            ["primary", "backup", "primary", "backup", "backup"]
        );
        assert_eq!(plan.candidates[1].stream_index, 2);
        assert_eq!(plan.candidates[1].source, MediaCandidateSource::Backup);
        assert_eq!(plan.candidates[1].backup_index, Some(0));
    }

    #[test]
    fn preferred_audio_preserves_raw_strings_and_duplicates() {
        let plan = plan_media_download_candidates(&request(
            MediaDownloadPlanMode::PreferredAudio,
            MediaStreamKind::Audio,
            vec![stream(9, " primary ", &["", " primary ", "歌曲/%E6%AD%8C"])],
        ))
        .unwrap();
        assert_eq!(
            urls(&plan),
            [" primary ", "", " primary ", "歌曲/%E6%AD%8C"]
        );
    }

    #[test]
    fn empty_input_is_valid_and_execution_is_deterministic() {
        let request = request(
            MediaDownloadPlanMode::DashStreams,
            MediaStreamKind::Audio,
            vec![stream(
                0,
                "https://例子.test/歌曲",
                &["https://example/%E6%AD%8C"],
            )],
        );
        let first = plan_media_download_candidates(&request).unwrap();
        for _ in 0..20 {
            assert_eq!(plan_media_download_candidates(&request).unwrap(), first);
        }
        let empty = plan_media_download_candidates(&MediaDownloadPlanRequest {
            mode: MediaDownloadPlanMode::DashStreams,
            stream_kind: MediaStreamKind::Video,
            streams: vec![],
        })
        .unwrap();
        assert!(empty.candidates.is_empty());
    }

    #[test]
    fn invalid_typed_and_wire_invariants_are_rejected() {
        let duplicate = request(
            MediaDownloadPlanMode::DashStreams,
            MediaStreamKind::Video,
            vec![stream(1, "a", &[]), stream(1, "b", &[])],
        );
        assert_eq!(
            plan_media_download_candidates(&duplicate),
            Err(MediaDownloadPlanError::InvalidRequest)
        );
        let invalid_preferred = request(
            MediaDownloadPlanMode::PreferredAudio,
            MediaStreamKind::Video,
            vec![stream(0, "a", &[])],
        );
        assert_eq!(
            plan_media_download_candidates(&invalid_preferred),
            Err(MediaDownloadPlanError::InvalidRequest)
        );
        assert!(plan_media_download_candidates_json(
            r#"{"schema_version":1,"mode":"dash_streams","stream_kind":"video","streams":[{"original_index":2,"primary_url":"a","backup_urls":[]},{"original_index":1,"primary_url":"b","backup_urls":[]}]}"#
        )
        .is_none());
    }

    #[test]
    fn wire_rejects_schema_enums_and_unknown_fields_and_returns_empty() {
        for invalid in [
            r#"{"schema_version":2,"mode":"dash_streams","stream_kind":"video","streams":[]}"#,
            r#"{"schema_version":1,"mode":"unknown","stream_kind":"video","streams":[]}"#,
            r#"{"schema_version":1,"mode":"dash_streams","stream_kind":"unknown","streams":[]}"#,
            r#"{"schema_version":1,"mode":"dash_streams","stream_kind":"video","streams":[],"extra":true}"#,
        ] {
            assert!(plan_media_download_candidates_json(invalid).is_none());
        }
        let response = plan_media_download_candidates_json(
            r#"{"schema_version":1,"mode":"dash_streams","stream_kind":"video","streams":[]}"#,
        )
        .unwrap();
        assert!(response.contains(r#""status":"empty""#));
    }
}
