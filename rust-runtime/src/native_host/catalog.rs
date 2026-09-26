//! Native HTTP and Internet adapters share the same catalog service as Python FFI.
use super::*;
use crate::shared_catalog::{CatalogOperation, CatalogRequest, execute_catalog};

pub(super) fn delete_invalid(bvid: &str) {
    // Only an upstream -404 may remove a shared entry. Network/authentication
    // failures must never trigger deletion, and deletion cannot mask add errors.
    let admitted = with_app(|app| {
        let recent = &mut app.native().invalid_catalog_deletions;
        Ok(admit_invalid_deletion(
            recent,
            bvid,
            std::time::Instant::now(),
        ))
    })
    .unwrap_or(false);
    if !admitted {
        return;
    }
    let _ = execute_catalog(&CatalogRequest {
        operation: CatalogOperation::Mutate {
            action: crate::shared_catalog::CatalogAction::DeleteInvalid,
            params: json!({"bvid": bvid}),
        },
        ..CatalogRequest::for_host()
    });
}

fn admit_invalid_deletion(
    recent: &mut std::collections::VecDeque<(String, std::time::Instant)>,
    bvid: &str,
    now: std::time::Instant,
) -> bool {
    recent.retain(|(_, at)| now.saturating_duration_since(*at) < Duration::from_secs(60));
    if recent.len() >= 8 || recent.iter().any(|(old, _)| old == bvid) {
        return false;
    }
    recent.push_back((bvid.to_owned(), now));
    true
}

pub(super) fn read(context: &HostContext, path: &str, query: &str) -> Result<Value, ApiError> {
    let mut value = execute_catalog(&CatalogRequest {
        operation: CatalogOperation::Read {
            path: path.into(),
            query: query.into(),
        },
        ..CatalogRequest::for_host()
    })
    .map_err(|error| ApiError::new(error.status_code, &error.kind, error.message))?;
    if let Some(items) = value.get_mut("items").and_then(Value::as_array_mut) {
        // Local badges are optional enrichment, not a dependency of cloud reads.
        let _ =
            crate::gatcha_repository::annotate_local(&library::paths(&context.directory), items);
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn invalid_video_deletions_are_deduplicated_and_bounded_across_routes() {
        let mut recent = std::collections::VecDeque::new();
        let now = std::time::Instant::now();
        for index in 0..8 {
            assert!(admit_invalid_deletion(
                &mut recent,
                &format!("BV{index:010}"),
                now
            ));
        }
        assert!(!admit_invalid_deletion(&mut recent, "BV0000000000", now));
        assert!(!admit_invalid_deletion(&mut recent, "BV0000000009", now));
        assert!(admit_invalid_deletion(
            &mut recent,
            "BV0000000009",
            now + Duration::from_secs(60)
        ));
        assert_eq!(recent.len(), 1);
    }
}
