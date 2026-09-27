//! Host-only adapters to the existing shared catalog administration service.
use super::*;
use crate::shared_catalog::{CatalogAction, CatalogOperation, CatalogRequest, execute_catalog};
use sha2::{Digest, Sha256};

pub(super) fn handles(path: &str) -> bool {
    matches!(
        path,
        "/api/bilikara-secret/verify"
            | "/api/admin-review/pending"
            | "/api/admin-review/approve"
            | "/api/admin-review/reject"
            | "/api/admin-blacklist/list"
            | "/api/admin-blacklist/restore"
            | "/api/admin-tags/reset"
            | "/api/admin-video/delete"
            | "/api/admin-video/delete-mid"
            | "/api/admin-maintenance/trigger"
    )
}

pub(super) fn route(
    context: &Arc<HostContext>,
    identity: &Identity,
    path: &str,
    body: &Value,
) -> Result<Value, ApiError> {
    with_app(|app| app.native_authorize(identity, true))?;
    let configured = std::env::var("BILIKARA_ADMIN_SECRET").unwrap_or_default();
    let secret = body["BILIKARA_ADMIN_SECRET"].as_str().unwrap_or("").trim();
    verify(secret, configured.trim(), &run)?;
    if path == "/api/bilikara-secret/verify" {
        return Ok(json!({"verified":true}));
    }
    if path == "/api/admin-maintenance/trigger" && body["job"] == "monthly-d1-refresh" {
        return monthly::start(context, secret);
    }
    perform(path, body, secret, &run)
}

fn run(operation: CatalogOperation) -> Result<Value, ApiError> {
    execute_catalog(&CatalogRequest {
        operation,
        timeout_ms: 120_000,
        ..CatalogRequest::for_host()
    })
    .map_err(|e| ApiError::new(e.status_code, &e.kind, e.message))
}

fn verify(
    secret: &str,
    configured: &str,
    execute: &impl Fn(CatalogOperation) -> Result<Value, ApiError>,
) -> Result<(), ApiError> {
    let verified = if secret.is_empty() {
        false
    } else if !configured.is_empty() {
        // Compare fixed-size digests without an early exit on the first byte.
        Sha256::digest(secret)
            .iter()
            .zip(Sha256::digest(configured))
            .fold(0u8, |difference, (a, b)| difference | (a ^ b))
            == 0
    } else {
        execute(CatalogOperation::Mutate {
            action: CatalogAction::VerifySecret,
            params: json!({"secret":secret}),
        })?["verified"]
            == true
    };
    if verified {
        Ok(())
    } else {
        Err(ApiError::new(403, "catalog_forbidden", "管理员密钥无效"))
    }
}

fn perform(
    path: &str,
    body: &Value,
    secret: &str,
    execute: &impl Fn(CatalogOperation) -> Result<Value, ApiError>,
) -> Result<Value, ApiError> {
    let limit = body["limit"].as_i64().unwrap_or(20).clamp(1, 20);
    let operation = match path {
        "/api/admin-review/pending" => CatalogOperation::PendingReview {
            secret: secret.into(),
            limit: json!(limit),
            export_limit: json!(5000),
        },
        "/api/admin-review/approve" => CatalogOperation::ApproveReview {
            secret: secret.into(),
            limit: json!(limit),
            export_limit: json!(5000),
            bvids: body["bvids"]
                .as_array()
                .ok_or_else(|| ApiError::invalid("bvids must be a list"))?
                .clone(),
        },
        _ => {
            let action = match path {
                "/api/admin-review/reject" => CatalogAction::RejectReview,
                "/api/admin-blacklist/list" => CatalogAction::ListBlacklist,
                "/api/admin-blacklist/restore" => CatalogAction::RestoreBlacklist,
                "/api/admin-tags/reset" => CatalogAction::ResetTags,
                "/api/admin-video/delete" => CatalogAction::DeleteVideo,
                "/api/admin-video/delete-mid" => CatalogAction::DeleteMid,
                "/api/admin-maintenance/trigger" => {
                    if body["job"] != "tagger-yomi" {
                        return Err(ApiError::invalid("invalid maintenance job"));
                    }
                    CatalogAction::Maintenance
                }
                _ => return Err(ApiError::new(404, "not_found", "未知管理操作")),
            };
            let mut params = body.clone();
            params
                .as_object_mut()
                .ok_or_else(|| ApiError::invalid("请求必须为 JSON 对象"))?
                .remove("BILIKARA_ADMIN_SECRET");
            params["secret"] = json!(secret);
            if path == "/api/admin-blacklist/list"
                && params["query"].as_str().is_none_or(str::is_empty)
            {
                params["query"] = body["q"].clone();
            }
            CatalogOperation::Mutate { action, params }
        }
    };
    let result = execute(operation)?;
    if result["success"] == false || result["error"].as_str().is_some_and(|e| !e.is_empty()) {
        let message = result["error"].as_str().unwrap_or("共享曲库管理操作失败");
        let status = result["status_code"]
            .as_u64()
            .filter(|v| (400..600).contains(v))
            .unwrap_or_else(|| {
                if message.contains("invalid ") || message.contains("missing ") {
                    400
                } else {
                    502
                }
            }) as u16;
        return Err(ApiError::new(status, "catalog_admin", message));
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_gate_rejects_missing_and_wrong_secrets_without_upstream_work() {
        let no_network = |_| -> Result<Value, ApiError> { panic!("unexpected network") };
        assert_eq!(verify("", "", &no_network).unwrap_err().status, 403);
        assert_eq!(
            verify("wrong", "configured", &no_network)
                .unwrap_err()
                .status,
            403
        );
        verify("configured", "configured", &no_network).unwrap();
        verify("worker-secret", "", &|op| {
            assert!(matches!(
                op,
                CatalogOperation::Mutate {
                    action: CatalogAction::VerifySecret,
                    ..
                }
            ));
            Ok(json!({"verified":true}))
        })
        .unwrap();
    }

    #[test]
    fn retained_admin_routes_reach_shared_operations_and_propagate_failures() {
        for (path, expected) in [
            ("/api/admin-review/reject", "RejectReview"),
            ("/api/admin-blacklist/list", "ListBlacklist"),
            ("/api/admin-blacklist/restore", "RestoreBlacklist"),
            ("/api/admin-tags/reset", "ResetTags"),
            ("/api/admin-video/delete", "DeleteVideo"),
            ("/api/admin-video/delete-mid", "DeleteMid"),
            ("/api/admin-maintenance/trigger", "Maintenance"),
        ] {
            perform(path, &json!({"job":"tagger-yomi","q":"fixture","BILIKARA_ADMIN_SECRET":"do-not-forward"}), "secret", &|op| {
                let CatalogOperation::Mutate { action, params } = op else { panic!("wrong operation") };
                assert_eq!(format!("{action:?}"), expected);
                assert_eq!(params["secret"], "secret");
                assert!(params.get("BILIKARA_ADMIN_SECRET").is_none());
                if expected == "ListBlacklist" { assert_eq!(params["query"], "fixture"); }
                Ok(json!({"success":true}))
            }).unwrap();
        }
        perform("/api/admin-review/pending", &json!({}), "secret", &|op| {
            assert!(matches!(op, CatalogOperation::PendingReview { .. }));
            Ok(json!({"items":[]}))
        })
        .unwrap();
        perform(
            "/api/admin-review/approve",
            &json!({"bvids":["BV1tPC2BEEjq"]}),
            "secret",
            &|op| {
                assert!(matches!(op, CatalogOperation::ApproveReview { .. }));
                Ok(json!({"items":[]}))
            },
        )
        .unwrap();
        let error = perform("/api/admin-blacklist/list", &json!({}), "secret", &|_| {
            Ok(json!({"success":false,"status_code":403,"error":"forbidden"}))
        })
        .unwrap_err();
        assert_eq!(error.status, 403);
    }
}
