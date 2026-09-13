//! Read-only shared catalog adapter. No Feishu fallback, prewarm, append, SQL,
//! caller-provided destination or privileged credentials are exposed here.
use super::library::{query_number, query_value};
use super::*;
use crate::cloudflare_service::{
    CloudflareOperation, CloudflareServiceRequest, execute_cloudflare,
};
use std::{collections::HashSet, time::Instant};

const API_URL: &str = "https://api.kevinx96.icu";
const CACHE_TTL: Duration = Duration::from_secs(60);
const MAX_CACHE_ENTRIES: usize = 48;

#[derive(Debug)]
struct Query {
    path: String,
    limit: usize,
    defaults: Value,
    empty: bool,
}

fn plan(path: &str, query: &str) -> Result<Query, ApiError> {
    let keyword = query_value(query, "q");
    if keyword.chars().count() > 120 {
        return Err(ApiError::invalid("搜索内容过长"));
    }
    let limit = query_number(query, "limit", 80, 500)?
        .clamp(1, if path == "/api/d1/browse" { 500 } else { 100 });
    let mut params = url::form_urlencoded::Serializer::new(String::new());
    params.append_pair("limit", &limit.to_string());
    let (endpoint, defaults, empty) = match path {
        "/api/lark/search" => {
            params.append_pair("keyword", &keyword);
            ("/search", json!({"items":[]}), keyword.is_empty())
        }
        "/api/d1/browse" => {
            let offset = query_number(query, "offset", 0, 100_000)?;
            params.append_pair("offset", &offset.to_string());
            let kind = if query_value(query, "kind") == "artist" {
                "artist"
            } else {
                "name"
            };
            let letter = query_value(query, "letter").to_uppercase();
            let tag = query_value(query, "tag");
            let locale = query_value(query, "locale").to_lowercase();
            if letter.len() > 8 || tag.chars().count() > 120 || locale.len() > 16 {
                return Err(ApiError::invalid("浏览条件无效"));
            }
            for (key, value) in [
                ("kind", kind),
                ("letter", &letter),
                ("tag", &tag),
                ("locale", &locale),
                ("q", &keyword),
            ] {
                if !value.is_empty() {
                    params.append_pair(key, value);
                }
            }
            (
                "/browse",
                json!({"kind":kind,"letter":letter,"tag":tag,"locale":locale,"query":keyword,"offset":offset,"tags":[],"items":[]}),
                false,
            )
        }
        "/api/d1/category-browse" => {
            let offset = query_number(query, "offset", 0, 100_000)?;
            let mut tags = Vec::new();
            let mut extra = Vec::new();
            for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
                let target = match key.as_ref() {
                    "tag" | "tags" => &mut tags,
                    "tag45" | "tag45s" => &mut extra,
                    _ => continue,
                };
                for part in value.split(',').map(str::trim).filter(|s| !s.is_empty()) {
                    if part.chars().count() > 120 || target.len() >= 20 {
                        return Err(ApiError::invalid("分类条件过多或过长"));
                    }
                    if !target.contains(&part.to_owned()) {
                        target.push(part.to_owned());
                    }
                }
            }
            tags.sort();
            extra.sort();
            params.append_pair("offset", &offset.to_string());
            if !keyword.is_empty() {
                params.append_pair("q", &keyword);
            }
            for tag in &tags {
                params.append_pair("tag", tag);
            }
            for tag in &extra {
                params.append_pair("tag45", tag);
            }
            (
                "/browse-category",
                json!({"query":keyword,"tags":tags,"tag45s":extra,"offset":offset,"limit":limit,"items":[],"has_more":false,"next_offset":offset}),
                tags.is_empty() && extra.is_empty(),
            )
        }
        _ => return Err(ApiError::new(404, "not_found", "未知共享曲库操作")),
    };
    Ok(Query {
        path: format!("{endpoint}?{}", params.finish()),
        limit,
        defaults,
        empty,
    })
}

fn field(value: &Value) -> String {
    match value {
        Value::String(s) => s.trim().to_owned(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}

fn normalize(query: &Query, payload: &Value) -> Result<Value, ApiError> {
    if payload.get("ok") == Some(&json!(false))
        || payload
            .get("error")
            .is_some_and(|v| !v.is_null() && v != "")
    {
        return Err(ApiError::new(
            503,
            "catalog_unavailable",
            "共享曲库暂不可用，请稍后重试",
        ));
    }
    let data = payload.get("data").unwrap_or(payload);
    let items = data
        .as_array()
        .or_else(|| data.get("items").and_then(Value::as_array))
        .or_else(|| data.get("results").and_then(Value::as_array))
        .ok_or_else(|| ApiError::new(503, "catalog_response", "共享曲库返回格式无效"))?;
    let mut result = query.defaults.clone();
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();
    for raw in items {
        let bvid = field(&raw["bvid"]);
        let title = field(&raw["title"]);
        if bvid.len() != 12
            || !bvid.starts_with("BV")
            || !bvid[2..].bytes().all(|b| b.is_ascii_alphanumeric())
            || title.is_empty()
            || !seen.insert(bvid.clone())
        {
            continue;
        }
        let mut item = json!({"bvid":bvid,"title":title,"url":format!("https://www.bilibili.com/video/{bvid}"),"source":"cloudflare"});
        for key in [
            "mid",
            "owner_name",
            "owner_url",
            "cover_url",
            "rank",
            "played_count",
            "preserved_1",
            "preserved_2",
            "preserved_3",
            "preserved_4",
            "preserved_5",
            "tag_1",
            "tag_2",
            "tag_3",
            "tag_4",
            "tag_5",
        ] {
            let value = field(&raw[key]);
            if !value.is_empty() {
                item[key] = json!(value);
            }
        }
        normalized.push(item);
        if normalized.len() == query.limit {
            break;
        }
    }
    result["items"] = json!(normalized);
    if query.path.starts_with("/browse?") {
        result["tags"] = json!(data["tags"].as_array().into_iter().flatten().filter(|v| !field(&v["tag"]).is_empty()).take(query.limit).map(|v| json!({
            "tag":field(&v["tag"]),"letter":field(&v["letter"]),"locale":field(&v["locale"]),"yomi":field(&v["yomi"]),"count":v["count"].as_u64().unwrap_or(0)
        })).collect::<Vec<_>>());
    }
    if query.path.starts_with("/browse-category?") || data.get("has_more").is_some() {
        let offset = query.defaults["offset"].as_u64().unwrap_or(0);
        let count = result["items"].as_array().map_or(0, Vec::len) as u64;
        let next = data["next_offset"].as_u64().unwrap_or(offset + count);
        result["next_offset"] = json!(next.max(offset));
        result["has_more"] = json!(data["has_more"].as_bool().unwrap_or(false) && next > offset);
    }
    Ok(result)
}

struct Inflight(String);
impl Drop for Inflight {
    fn drop(&mut self) {
        let _ = with_app(|app| {
            app.native().catalog_inflight.remove(&self.0);
            Ok(())
        });
    }
}

pub(super) fn read(path: &str, query: &str) -> Result<Value, ApiError> {
    read_with(path, query, execute_cloudflare)
}

fn read_with(
    path: &str,
    query: &str,
    fetch: impl FnOnce(
        &CloudflareServiceRequest,
    ) -> Result<Value, crate::cloudflare_service::CloudflareServiceError>,
) -> Result<Value, ApiError> {
    let query = plan(path, query)?;
    if query.empty {
        return Ok(query.defaults);
    }
    let cached = with_app(|app| {
        let session = app.native();
        let current = Instant::now();
        session
            .catalog_cache
            .retain(|(_, at, _)| current.duration_since(*at) < CACHE_TTL);
        if let Some((_, _, value)) = session
            .catalog_cache
            .iter()
            .find(|(key, _, _)| key == &query.path)
        {
            return Ok(Some(value.clone()));
        }
        if session.catalog_backoff.is_some_and(|until| until > current) {
            return Err(ApiError::new(
                429,
                "catalog_cooldown",
                "共享曲库正在冷却，请稍后重试",
            ));
        }
        if session.catalog_inflight.len() >= 2
            || !session.catalog_inflight.insert(query.path.clone())
        {
            return Err(ApiError::new(
                429,
                "catalog_busy",
                "搜索正在进行，请等待结果",
            ));
        }
        Ok(None)
    })?;
    if let Some(value) = cached {
        return Ok(value);
    }
    let _inflight = Inflight(query.path.clone());
    let result = fetch(&CloudflareServiceRequest {
        schema_version: 1,
        base_url: API_URL.into(),
        user_agent: "bilikara/0.8.0-android-alpha".into(),
        timeout_ms: 8000,
        operation: CloudflareOperation::Request {
            method: "GET".into(),
            path: query.path.clone(),
            payload: None,
            authorization: String::new(),
        },
    })
    .map_err(|error| {
        ApiError::new(
            if error.status_code == Some(429) {
                429
            } else {
                503
            },
            "catalog_unavailable",
            "共享曲库暂不可用或请求过多，请稍后重试",
        )
    })
    .and_then(|value| normalize(&query, &value["payload"]));
    with_app(|app| {
        let session = app.native();
        match &result {
            Ok(value) => {
                // Bound memory even if a server returns unexpectedly large tags.
                if value.to_string().len() <= 512 * 1024 {
                    while session.catalog_cache.len() >= MAX_CACHE_ENTRIES {
                        session.catalog_cache.pop_front();
                    }
                    session.catalog_cache.push_back((
                        query.path.clone(),
                        Instant::now(),
                        value.clone(),
                    ));
                }
            }
            Err(_) => session.catalog_backoff = Some(Instant::now() + Duration::from_secs(30)),
        }
        Ok(())
    })?;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn repeated_queries_and_empty_queries_do_not_reach_cloud_and_failure_backs_off() {
        let query = "q=offline-cache-regression";
        let cached = read_with("/api/lark/search", query, |request| {
            assert_eq!(request.base_url, API_URL);
            let CloudflareOperation::Request {
                method,
                payload,
                authorization,
                ..
            } = &request.operation
            else {
                panic!()
            };
            assert_eq!(method, "GET");
            assert!(payload.is_none());
            assert!(authorization.is_empty());
            Ok(json!({"payload":[{"bvid":"BV1zm41117sU","title":"高达"}]}))
        })
        .unwrap();
        assert_eq!(
            read_with("/api/lark/search", query, |_| panic!("cache miss")).unwrap(),
            cached
        );
        assert_eq!(
            read_with("/api/lark/search", "q=", |_| panic!(
                "empty query reached cloud"
            ))
            .unwrap(),
            json!({"items":[]})
        );
        assert!(
            read_with("/api/lark/search", "q=offline-failure", |_| Err(
                crate::cloudflare_service::CloudflareServiceError {
                    kind: "http_status".into(),
                    message: "HTTP 429".into(),
                    status_code: Some(429),
                    body_preview: Some("private upstream error".into()),
                }
            ))
            .is_err()
        );
        let error = read_with("/api/lark/search", "q=offline-backoff", |_| {
            panic!("backoff reached cloud")
        })
        .unwrap_err();
        assert_eq!(error.code, "catalog_cooldown");
        assert!(!error.message.contains("private"));
        assert_eq!(
            read_with("/api/lark/search", query, |_| panic!(
                "cached result blocked by backoff"
            ))
            .unwrap(),
            cached
        );
        with_app(|app| {
            app.native().catalog_cache.clear();
            app.native().catalog_backoff = None;
            assert!(app.native().catalog_inflight.is_empty());
            Ok(())
        })
        .unwrap();
    }
    #[test]
    fn builds_bounded_read_only_queries_without_fallback_or_arbitrary_paths() {
        let query = plan(
            "/api/lark/search",
            "q=%E9%AB%98%E8%BE%BE&limit=80&table=1&path=/batch-add",
        )
        .unwrap();
        assert_eq!(query.path, "/search?limit=80&keyword=%E9%AB%98%E8%BE%BE");
        assert!(plan("/api/lark/search", "q=%20").unwrap().empty);
        assert!(plan("/api/d1/category-browse", "q=x").unwrap().empty);
        assert!(plan("/api/admin", "").is_err());
        assert!(plan("/api/lark/search", "limit=99999").is_err());
        assert_eq!(
            plan("/api/d1/category-browse", "tag=z&tag=a&tag=z&offset=100")
                .unwrap()
                .path,
            "/browse-category?limit=80&offset=100&tag=a&tag=z"
        );
    }
    #[test]
    fn preserves_search_metadata_tags_pagination_and_errors() {
        let q = plan("/api/lark/search", "q=高达").unwrap();
        let item = json!({"bvid":"BV1zm41117sU","title":"高达","tag_1":"高达","cover_url":"https://i1.hdslb.com/x.jpg","url":"javascript:evil"});
        let value = normalize(&q, &json!([item,item,{"bvid":"x","title":"invalid"}])).unwrap();
        assert_eq!(value["items"].as_array().unwrap().len(), 1);
        assert_eq!(value["items"][0]["tag_1"], "高达");
        assert_eq!(
            value["items"][0]["url"],
            "https://www.bilibili.com/video/BV1zm41117sU"
        );
        assert!(normalize(&q, &json!({"ok":false,"error":"quota"})).is_err());
        assert!(normalize(&q, &json!({"bad":[]})).is_err());
        let q = plan("/api/d1/category-browse", "tag=热血&offset=100").unwrap();
        let value = normalize(
            &q,
            &json!({"items":[item],"has_more":true,"next_offset":101}),
        )
        .unwrap();
        assert_eq!(value["next_offset"], 101);
        assert_eq!(value["has_more"], true);
        let q = plan("/api/d1/browse", "kind=name&letter=G").unwrap();
        let value = normalize(
            &q,
            &json!({"items":[],"tags":[{"tag":"高达","letter":"G","count":12}]}),
        )
        .unwrap();
        assert_eq!(value["tags"][0]["count"], 12);
        assert!(
            value.get("has_more").is_none(),
            "legacy Worker must not advertise pagination"
        );
        let q = plan("/api/d1/browse", "kind=artist&tag=test&offset=100").unwrap();
        assert!(q.path.contains("offset=100"));
        let value = normalize(
            &q,
            &json!({"items":[item],"has_more":true,"next_offset":101}),
        )
        .unwrap();
        assert_eq!(value["next_offset"], 101);
        assert_eq!(value["has_more"], true);
        let value = normalize(
            &q,
            &json!({"items":[item],"has_more":true,"next_offset":100}),
        )
        .unwrap();
        assert_eq!(value["has_more"], false, "non-advancing page must not loop");
        assert!(plan("/api/d1/browse", "offset=100001").is_err());
    }
}
