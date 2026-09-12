//! Post-commit catalog append, using the desktop's bounded background service.
//! A sharing failure must never undo a successful local song request.
use super::*;
use crate::app_state::PlaylistItem;
use crate::cloudflare_service::{
    CloudflareOperation, CloudflareServiceRequest, execute_cloudflare,
};

fn request(item: &PlaylistItem) -> CloudflareServiceRequest {
    CloudflareServiceRequest {
        schema_version: 1,
        base_url: "https://api.kevinx96.icu".into(),
        user_agent: crate::native_video::USER_AGENT.into(),
        timeout_ms: 10_000,
        operation: CloudflareOperation::EnqueueAppend {
            entries: vec![json!({
                "mid":if item.owner_mid == 0 {String::new()} else {item.owner_mid.to_string()}, "bvid":item.bvid,
                "title":if item.title.is_empty() {&item.display_title} else {&item.title},
                "url":if item.resolved_url.is_empty() {&item.original_url} else {&item.resolved_url}, "owner_name":item.owner_name,
                "owner_url":item.owner_url, "cover_url":item.cover_url,
            })],
        },
    }
}

pub(super) fn enqueue(item: &PlaylistItem) {
    // No SQL, credentials, media URLs or source-library bulk upload here.
    // The service normalizes entries and writes through the same /batch-add API.
    if execute_cloudflare(&request(item)).is_err() {
        eprintln!("native catalog append could not be scheduled");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn append_is_bounded_background_metadata_only() {
        let item: PlaylistItem = serde_json::from_value(json!({
            "id":"test","bvid":"BV1zm41117sU","title":"Song", "owner_mid":123,
            "owner_name":"UP", "resolved_url":"https://www.bilibili.com/video/BV1zm41117sU",
            "original_url":"https://www.bilibili.com/video/BV1zm41117sU", "aid":1, "cid":1,
            "part_title":"Song", "display_title":"Song", "embed_url":"", "cover_url":"",
            "video_relative_path":"private/media.mp4", "video_media_url":"private/audio.m4a"
        }))
        .unwrap();
        let request = request(&item);
        assert_eq!(request.base_url, "https://api.kevinx96.icu");
        let CloudflareOperation::EnqueueAppend { entries } = request.operation else {
            panic!()
        };
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["mid"], "123");
        assert_eq!(entries[0]["bvid"], item.bvid);
        assert!(!entries[0].to_string().contains("private"));
        assert_eq!(entries[0].as_object().unwrap().len(), 7);
    }
}
