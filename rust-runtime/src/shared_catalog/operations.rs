//! Existing catalog module administration/review policy. No monthly runner,
//! rating identity ledger, login or cache-worker lifecycle is owned here.
use super::*;
use std::collections::{HashMap, HashSet};

fn text(value: &Value) -> String {
    match value {
        Value::String(s) => s.trim().into(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}
fn number(value: &Value, default: i64, min: i64, max: i64) -> i64 {
    value
        .as_i64()
        .or_else(|| value.as_str().and_then(|s| s.parse().ok()))
        .unwrap_or(default)
        .clamp(min, max)
}
fn bvid(value: &str) -> bool {
    value.len() == 12
        && value.starts_with("BV")
        && value[2..].bytes().all(|b| b.is_ascii_alphanumeric())
}

fn send(
    request: &CatalogRequest,
    fetch: &impl Fn(&CloudflareServiceRequest) -> Result<Value, CloudflareServiceError>,
    method: &str,
    path: String,
    payload: Option<Value>,
    authorization: String,
    timeout_ms: u64,
) -> Result<Value, CatalogError> {
    fetch(&cloud_request(
        request,
        CloudflareOperation::Request {
            method: method.into(),
            path,
            payload,
            authorization,
        },
        timeout_ms,
    ))
    .map_err(|e| {
        let mut error = CatalogError::upstream(e);
        error.fallback_eligible = false; // This entry is never a public-read fallback.
        error
    })
    .and_then(|v| v.get("payload").cloned().ok_or_else(CatalogError::response))
}

fn records(payload: Value) -> Result<Vec<Value>, CatalogError> {
    let data = payload.get("data").unwrap_or(&payload);
    let records = data
        .as_array()
        .or_else(|| data.get("items").and_then(Value::as_array))
        .or_else(|| data.get("results").and_then(Value::as_array))
        .ok_or_else(CatalogError::response)?;
    Ok(records.iter().filter(|r| r.is_object()).cloned().collect())
}
fn export(
    request: &CatalogRequest,
    secret: &str,
    limit: &Value,
    fetch: &impl Fn(&CloudflareServiceRequest) -> Result<Value, CloudflareServiceError>,
) -> Result<Vec<Value>, CatalogError> {
    if secret.trim().is_empty() {
        return Err(CatalogError::invalid("missing secret"));
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let path = format!(
        "/export?all=1&limit={}&_={stamp}",
        number(limit, 5000, 1, 50000)
    );
    records(send(
        request,
        fetch,
        "GET",
        path,
        None,
        format!("Bearer {}", secret.trim()),
        request.timeout_ms,
    )?)
}

fn pending(record: &Value, keywords: &[String]) -> Option<Value> {
    let item = read::normalize_item(record)?;
    let title = text(&item["title"]).to_lowercase();
    if keywords
        .iter()
        .map(|k| k.trim().to_lowercase())
        .any(|k| !k.is_empty() && title.contains(&k))
    {
        return None;
    }
    matches!(text(&record["preserved_3"]).as_str(), "" | "0" | "0.0").then_some(item)
}
fn pending_payload(records: &[Value], keywords: &[String], limit: &Value) -> Value {
    let mut seen = HashSet::new();
    let items: Vec<_> = records
        .iter()
        .filter_map(|r| pending(r, keywords))
        .filter(|r| seen.insert(text(&r["bvid"])))
        .collect();
    json!({"items":items.iter().take(number(limit,20,1,20) as usize).collect::<Vec<_>>(),
        "total_pending":items.len(),"export_count":records.len()})
}
fn append(
    request: &CatalogRequest,
    entries: Vec<Value>,
    fetch: &impl Fn(&CloudflareServiceRequest) -> Result<Value, CloudflareServiceError>,
) -> Result<Value, CatalogError> {
    let result = fetch(&cloud_request(
        request,
        CloudflareOperation::Append { entries },
        20_000,
    ))
    .map_err(|e| {
        let mut e = CatalogError::upstream(e);
        e.fallback_eligible = false;
        e
    })?;
    if !result.is_object() {
        return Err(CatalogError::response());
    }
    if result.get("error").is_some_and(|v| !v.is_null() && v != "")
        || result.get("success") == Some(&json!(false))
    {
        return Err(CatalogError::new(
            503,
            "catalog_rejected",
            "Catalog append rejected",
        ));
    }
    let mut output = json!({"attempted":number(&result["attempted"],0,0,i64::MAX), "added":number(&result["added"],0,0,i64::MAX)});
    if output["attempted"] != 0 {
        for key in [
            "updated_existing",
            "skipped_existing",
            "skipped_blacklisted",
            "feishu_queued",
        ] {
            output[key] = json!(number(&result[key], 0, 0, i64::MAX));
        }
    }
    Ok(output)
}

pub(super) fn execute(
    request: &CatalogRequest,
    fetch: &impl Fn(&CloudflareServiceRequest) -> Result<Value, CloudflareServiceError>,
) -> Result<Value, CatalogError> {
    match &request.operation {
        CatalogOperation::Read { .. } => unreachable!(),
        CatalogOperation::NormalizeEntry { entry } => Ok(
            json!({"entry":entry.as_object().and_then(crate::cloudflare_service::normalize_entry)}),
        ),
        CatalogOperation::Export { secret, limit } => {
            Ok(json!({"records":export(request,secret,limit,fetch)?}))
        }
        CatalogOperation::PendingReview {
            secret,
            limit,
            export_limit,
        } => Ok(pending_payload(
            &export(request, secret, export_limit, fetch)?,
            &request.review_keywords,
            limit,
        )),
        CatalogOperation::Append { entries } => {
            invalidate()?;
            let result = append(request, entries.clone(), fetch);
            invalidate()?;
            result
        }
        CatalogOperation::EnqueueAppend { entries } => fetch(&cloud_request(
            request,
            CloudflareOperation::EnqueueAppend {
                entries: entries.clone(),
            },
            20_000,
        ))
        .map_err(|e| {
            let mut e = CatalogError::upstream(e);
            e.fallback_eligible = false;
            e
        }),
        CatalogOperation::Mutate { action, params } => mutate(request, action, params, fetch),
        CatalogOperation::ApproveReview {
            secret,
            bvids,
            limit,
            export_limit,
        } => {
            let mut seen = HashSet::new();
            let requested: Vec<_> = bvids
                .iter()
                .map(text)
                .filter(|s| bvid(s) && seen.insert(s.clone()))
                .collect();
            let current: HashMap<_, _> = export(request, secret, export_limit, fetch)?
                .iter()
                .filter_map(read::normalize_item)
                .map(|r| (text(&r["bvid"]), r))
                .collect();
            let updates: Vec<_> = requested
                .iter()
                .filter_map(|b| current.get(b))
                .map(|r| {
                    let mut r = r.clone();
                    r["preserved_3"] = json!("1");
                    r
                })
                .collect();
            invalidate()?;
            let result = (|| {
                let mut upload = append(request, updates.clone(), fetch)?;
                let mut refreshed = export(request, secret, export_limit, fetch)?;
                let still_pending: HashSet<_> = refreshed
                    .iter()
                    .filter_map(|r| pending(r, &request.review_keywords))
                    .map(|r| text(&r["bvid"]))
                    .collect();
                let retry: Vec<_> = updates
                    .iter()
                    .filter(|u| still_pending.contains(&text(&u["bvid"])))
                    .cloned()
                    .collect();
                // Preserve the existing privileged update compatibility sequence.
                // This is a D1 mutation, never a Sheets fallback or public action.
                if !retry.is_empty() {
                    for update in &retry {
                        let deleted = mutate(
                            request,
                            &CatalogAction::DeleteVideo,
                            &json!({"bvid":update["bvid"],"secret":secret}),
                            fetch,
                        )?;
                        if deleted["success"] != true {
                            return Err(CatalogError::new(
                                503,
                                "catalog_rejected",
                                "Approval delete failed",
                            ));
                        }
                    }
                    let retried = append(request, retry.clone(), fetch)?;
                    upload["fallback_attempted"] = json!(retry.len());
                    upload["fallback_deleted"] = json!(retry.len());
                    upload["fallback_added"] = retried["added"].clone();
                    upload["fallback_updated_existing"] =
                        retried.get("updated_existing").cloned().unwrap_or(json!(0));
                    refreshed = export(request, secret, export_limit, fetch)?;
                }
                let remaining: HashSet<_> = refreshed
                    .iter()
                    .filter_map(|r| pending(r, &request.review_keywords))
                    .map(|r| text(&r["bvid"]))
                    .collect();
                let mut result = pending_payload(&refreshed, &request.review_keywords, limit);
                result["requested"] = json!(requested.len());
                result["approved"] = json!(
                    requested
                        .iter()
                        .filter(|b| current.contains_key(*b) && !remaining.contains(*b))
                        .count()
                );
                result["skipped_missing"] = json!(requested.len() - updates.len());
                result["upload"] = upload;
                Ok(result)
            })();
            invalidate()?;
            result
        }
    }
}

fn mutate(
    request: &CatalogRequest,
    action: &CatalogAction,
    params: &Value,
    fetch: &impl Fn(&CloudflareServiceRequest) -> Result<Value, CloudflareServiceError>,
) -> Result<Value, CatalogError> {
    if !params.is_object() {
        return Err(CatalogError::invalid("Invalid catalog parameters"));
    }
    let bv = text(&params["bvid"]);
    let secret = text(&params["secret"]);
    let mid = text(&params["mid"]);
    let job = text(&params["job"]).to_lowercase();
    let mut defaults = json!({"success":false});
    match action {
        CatalogAction::DeleteMid => {
            defaults["mid"] = json!(mid);
            defaults["deleted"] = json!(false);
        }
        CatalogAction::ListBlacklist => defaults["items"] = json!([]),
        CatalogAction::VerifySecret => defaults["verified"] = json!(false),
        CatalogAction::Maintenance => defaults["job"] = json!(job),
        CatalogAction::RateSong => {}
        _ => defaults["bvid"] = json!(bv),
    }
    if matches!(
        action,
        CatalogAction::DeleteInvalid | CatalogAction::DeleteVideo
    ) {
        defaults["deleted"] = json!(false);
    }
    let mut invalid = None;
    if matches!(
        action,
        CatalogAction::RejectReview
            | CatalogAction::RestoreBlacklist
            | CatalogAction::DeleteInvalid
            | CatalogAction::DeleteVideo
            | CatalogAction::ResetTags
    ) && !bvid(&bv)
    {
        invalid = Some("invalid bvid");
    }
    if matches!(action, CatalogAction::DeleteMid)
        && (mid.is_empty()
            || !mid.bytes().all(|c| c.is_ascii_digit())
            || !mid.bytes().any(|c| c != b'0'))
    {
        invalid = Some("invalid mid");
    }
    if matches!(action, CatalogAction::Maintenance) && job != "tagger-yomi" {
        invalid = Some("invalid maintenance job");
    }
    if !matches!(
        action,
        CatalogAction::DeleteInvalid | CatalogAction::RateSong
    ) && secret.is_empty()
        && invalid.is_none()
    {
        invalid = Some("missing secret");
    }
    let user = text(&params["session_user_name"]);
    let play = text(&params["play_id"]);
    let score = number(&params["score"], 0, i64::MIN, i64::MAX);
    if matches!(action, CatalogAction::RateSong) {
        invalid = if user.is_empty() {
            Some("missing session_user_name")
        } else if play.is_empty() {
            Some("missing play_id")
        } else if !bvid(&bv) {
            Some("invalid bvid")
        } else if !(1..=5).contains(&score) {
            Some("score must be between 1 and 5")
        } else {
            None
        };
    }
    if let Some(error) = invalid {
        defaults["error"] = json!(error);
        return Ok(defaults);
    }
    let mut body = json!({"bvid":bv,"BILIKARA_ADMIN_SECRET":secret});
    let mut authorization = String::new();
    let (path, timeout, failure) = match action {
        CatalogAction::RejectReview => {
            body["reason_code"] = json!("not_karaoke");
            body["source"] = json!("pending_review");
            body["rejected_by"] = json!(text(&params["rejected_by"]));
            if params["record"].is_object() {
                body["record"] = params["record"].clone();
            }
            ("/admin/review/reject", 15_000, "review rejection failed")
        }
        CatalogAction::ListBlacklist => {
            body = json!({"BILIKARA_ADMIN_SECRET":secret,"query":text(&params["query"]),"limit":number(&params["limit"],20,1,100),"offset":number(&params["offset"],0,0,i64::MAX),"include_inactive":params["include_inactive"].as_bool().unwrap_or(false)});
            ("/admin/blacklist/list", 20_000, "blacklist query failed")
        }
        CatalogAction::RestoreBlacklist => {
            body["restore_video"] = json!(params["restore_video"].as_bool().unwrap_or(false));
            body["restored_by"] = json!(text(&params["restored_by"]));
            (
                "/admin/blacklist/restore",
                15_000,
                "blacklist restore failed",
            )
        }
        CatalogAction::DeleteInvalid => {
            body = json!({"bvid":bv});
            ("/delete-invalid", 10_000, "delete failed")
        }
        CatalogAction::DeleteVideo => ("/admin/delete-video", 10_000, "delete failed"),
        CatalogAction::DeleteMid => {
            body = json!({"mid":mid,"BILIKARA_ADMIN_SECRET":secret});
            ("/admin/delete-mid", 20_000, "delete failed")
        }
        CatalogAction::RateSong => {
            body = json!({"session_user_name":user,"play_id":play,"bvid":bv,"score":score});
            defaults["play_id"] = json!(play);
            defaults["bvid"] = json!(bv);
            defaults["score"] = json!(score);
            ("/rate-song", 10_000, "rating failed")
        }
        CatalogAction::VerifySecret => {
            body = json!({"BILIKARA_ADMIN_SECRET":secret});
            ("/admin/verify", 10_000, "invalid secret")
        }
        CatalogAction::Maintenance => {
            body = json!({"requested_by":text(&params["requested_by"]).chars().take(120).collect::<String>()});
            authorization = format!("Bearer {secret}");
            (
                "/admin/jobs/tagger-yomi",
                15_000,
                "maintenance job start failed",
            )
        }
        CatalogAction::ResetTags => ("/admin/reset-tags", 10_000, "reset failed"),
    };
    let changes_catalog = !matches!(
        action,
        CatalogAction::ListBlacklist | CatalogAction::VerifySecret | CatalogAction::RateSong
    );
    if changes_catalog {
        invalidate()?;
    }
    let response = send(
        request,
        fetch,
        "POST",
        path.into(),
        Some(body),
        authorization,
        timeout,
    );
    // Preserve confirmed removals and ambiguous service/transport outcomes.
    // Explicit authorization/validation rejection must not create exclusions.
    let removed_or_uncertain = match &response {
        Ok(payload) => payload["success"] == true,
        Err(error) => matches!(error.status_code, 408 | 429 | 500..=599),
    };
    if removed_or_uncertain {
        match action {
            CatalogAction::DeleteVideo
            | CatalogAction::DeleteInvalid
            | CatalogAction::RejectReview => sheets::exclude(request, "bvid", &bv)?,
            CatalogAction::DeleteMid => sheets::exclude(request, "mid", &mid)?,
            _ => {}
        }
    }
    if changes_catalog {
        invalidate()?;
    }
    let payload = match response {
        Ok(payload) if payload.is_object() => payload,
        Ok(_) => {
            defaults["error"] = json!("Cloudflare returned an invalid payload");
            return Ok(defaults);
        }
        Err(error) => {
            defaults["error"] = json!(error.message);
            defaults["status_code"] = json!(error.status_code);
            return Ok(defaults);
        }
    };
    if matches!(action, CatalogAction::VerifySecret) {
        let verified = ["verified", "valid", "authorized", "success", "ok"]
            .iter()
            .any(|k| payload[*k] == true);
        let error = ["error", "message"]
            .iter()
            .map(|k| text(&payload[*k]))
            .find(|value| !value.is_empty())
            .unwrap_or_else(|| "invalid secret".into());
        return Ok(
            json!({"success":verified,"verified":verified,"error":if verified {String::new()} else {error}}),
        );
    }
    if matches!(action, CatalogAction::DeleteInvalid) {
        let returned_bvid = text(&payload["bvid"]);
        return Ok(json!({"success":payload["success"] == true,
            "bvid":if returned_bvid.is_empty() {bv} else {returned_bvid},
            "found":payload["found"] == true, "deleted":payload["deleted"] == true,
            "feishu_queued":payload["feishu_queued"] == true, "error":text(&payload["error"])}));
    }
    let mut result = payload;
    for (k, v) in defaults.as_object().expect("defaults object") {
        result
            .as_object_mut()
            .expect("checked object")
            .entry(k.clone())
            .or_insert_with(|| v.clone());
    }
    let success = result["success"] == true;
    result["success"] = json!(success);
    if matches!(action, CatalogAction::Maintenance) {
        result["job"] = json!(job);
    }
    if matches!(action, CatalogAction::ListBlacklist) && !result["items"].is_array() {
        return Err(CatalogError::response());
    }
    result
        .as_object_mut()
        .expect("checked object")
        .entry("error")
        .or_insert_with(|| json!(if success { "" } else { failure }));
    Ok(result)
}
