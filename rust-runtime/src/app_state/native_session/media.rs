//! Cache lifetime decisions share the queue's lock. An open HTTP body and the
//! mounted player each pin their immutable artifact; GC never races a new read.
use super::*;

impl AppState {
    pub(crate) fn native_pin_media(&mut self, route: &str) -> Result<String, ApiError> {
        let snapshot = self.native_core_snapshot()?;
        if !snapshot
            .current_item
            .iter()
            .chain(&snapshot.playlist)
            .any(|item| {
                item.video_media_url == route
                    || item
                        .audio_variants
                        .iter()
                        .any(|variant| variant["audio_url"].as_str() == Some(route))
            })
        {
            return Err(ApiError::new(404, "stale_media", "媒体已过期"));
        }
        if self.artifact_reader_count() >= 64 {
            return Err(ApiError::new(429, "media_busy", "媒体读取过多，请稍后重试"));
        }
        self.acquire_artifact_reader(route.strip_prefix("/media/").unwrap_or(""))
            .map_err(|_| ApiError::new(404, "stale_media", "媒体已过期"))?
            .ok_or_else(|| ApiError::new(404, "stale_media", "媒体已过期"))
    }

    pub(crate) fn native_unpin_media(&mut self, handle: &str) {
        self.release_artifact_reader(handle);
    }

    pub(in crate::app_state) fn native_artifact_claimed(
        &self,
        incarnation: &str,
        artifact: &str,
    ) -> bool {
        self.native_session
            .claim
            .as_ref()
            .is_some_and(|claim| claim.incarnation == incarnation && claim.artifact == artifact)
    }
}
