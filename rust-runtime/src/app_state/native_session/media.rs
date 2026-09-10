//! Cache lifetime decisions share the queue's lock. An open HTTP body and the
//! mounted player each pin their immutable artifact; GC never races a new read.
use super::*;

impl AppState {
    pub(crate) fn native_pin_media(&mut self, route: &str) -> Result<(), ApiError> {
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
        let readers = &mut self.native_session.media_readers;
        if readers.values().sum::<usize>() >= 64 {
            return Err(ApiError::new(429, "media_busy", "媒体读取过多，请稍后重试"));
        }
        *readers.entry(route.to_owned()).or_default() += 1;
        Ok(())
    }

    pub(crate) fn native_unpin_media(&mut self, route: &str) {
        let readers = &mut self.native_session.media_readers;
        if let Some(count) = readers.get_mut(route) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                readers.remove(route);
            }
        }
    }

    /// Call and rename to the retired directory in the same AppState lock.
    /// The directory identities are allocated by Rust, never taken from HTTP.
    pub(crate) fn native_can_retire_artifact(&self, incarnation: &str, artifact: &str) -> bool {
        if !valid_authoritative_identity(incarnation, 'i')
            || !valid_authoritative_identity(artifact, 'a')
        {
            return false;
        }
        let Some(data) = &self.data else {
            return false;
        };
        if data
            .current_item
            .iter()
            .chain(&data.playlist)
            .any(|item| item.item_incarnation_id == incarnation && item.artifact_set_id == artifact)
            || data.active_cache_attempts.values().any(|attempt| {
                attempt.terminal_event.is_none()
                    && attempt.reservation.item_incarnation_id == incarnation
                    && attempt.reservation.artifact_set_id == artifact
            })
            || self
                .native_session
                .claim
                .as_ref()
                .is_some_and(|claim| claim.incarnation == incarnation && claim.artifact == artifact)
        {
            return false;
        }
        let prefix = format!("/media/artifacts/{incarnation}/{artifact}/");
        !self
            .native_session
            .media_readers
            .keys()
            .any(|route| route.starts_with(&prefix))
    }
}
