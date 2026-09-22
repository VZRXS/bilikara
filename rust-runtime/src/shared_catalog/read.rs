//! D1 query planning/normalization extracted from PR109; no transport state here.
use super::*;
use std::collections::HashSet;

const CACHE_TTL: Duration = Duration::from_secs(60);
const MAX_CACHE_ENTRIES: usize = 48;

#[derive(Debug)]
struct Query {
    path: String,
    limit: usize,
    search_offset: Option<usize>,
    defaults: Value,
    empty: bool,
}

fn plan(path: &str, query: &str) -> Result<Query, CatalogError> {
    if url::form_urlencoded::parse(query.as_bytes()).any(|(key, _)| key == "table") {
        return Err(CatalogError::new(
            410,
            "catalog_table_retired",
            "Feishu table selection has been retired",
        ));
    }
    let keyword = query_value(query, "q");
    if keyword.chars().count() > 120 {
        return Err(CatalogError::invalid("搜索内容过长"));
    }
    let limit = query_number(query, "limit", 80, 500)?
        .clamp(1, if path == "/api/d1/browse" { 500 } else { 100 });
    let search_offset = if matches!(path, "/api/catalog/search" | "/api/lark/search") {
        Some(query_number(query, "offset", 0, 100_000)?)
    } else {
        None
    };
    let mut params = url::form_urlencoded::Serializer::new(String::new());
    params.append_pair("limit", &limit.to_string());
    // Opt in song windows only. Group lists stay legacy until Host/Remote
    // consume server-side group counts and fetch subsequent windows.
    if path != "/api/d1/browse" || !query_value(query, "tag").is_empty() {
        params.append_pair("format", "paged");
    }
    if let Some(offset) = search_offset.filter(|offset| *offset > 0) {
        params.append_pair("offset", &offset.to_string());
    }
    let (endpoint, defaults, empty) = match path {
        "/api/catalog/search" | "/api/lark/search" => {
            params.append_pair("keyword", &keyword);
            ("/search", json!({"items":[]}), keyword.is_empty())
        }
        "/api/d1/browse" => {
            let offset = query_number(query, "offset", 0, 100_000)?;
            params.append_pair("offset", &offset.to_string());
            let kind = if query_value(query, "kind").eq_ignore_ascii_case("artist") {
                "artist"
            } else {
                "name"
            };
            let letter = query_value(query, "letter").to_uppercase();
            let tag = query_value(query, "tag");
            let locale = query_value(query, "locale").to_lowercase();
            if letter.len() > 8 || tag.chars().count() > 120 || locale.len() > 16 {
                return Err(CatalogError::invalid("浏览条件无效"));
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
                json!({"kind":kind,"letter":letter,"tag":tag,"locale":locale,"query":keyword,"tags":[],"items":[]}),
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
                        return Err(CatalogError::invalid("分类条件过多或过长"));
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
        _ => return Err(CatalogError::new(404, "not_found", "未知共享曲库操作")),
    };
    Ok(Query {
        path: format!("{endpoint}?{}", params.finish()),
        limit,
        search_offset,
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

fn normalize(query: &Query, payload: &Value) -> Result<Value, CatalogError> {
    let data = payload.get("data").unwrap_or(payload);
    for value in [payload, data] {
        if value.get("ok") == Some(&json!(false))
            || value.get("success") == Some(&json!(false))
            || value
                .get("error")
                .is_some_and(|v| !v.is_null() && v != "" && v != false)
        {
            let status = ["status_code", "status", "code"]
                .iter()
                .find_map(|key| value[*key].as_u64().filter(|s| (400..600).contains(s)))
                .or_else(|| {
                    match value["code"]
                        .as_str()
                        .or_else(|| value["error"]["code"].as_str())
                    {
                        Some("unauthorized" | "authentication_required") => Some(401),
                        Some("forbidden") => Some(403),
                        Some("invalid_request" | "validation_error") => Some(400),
                        _ => None,
                    }
                });
            let mut error = CatalogError::new(
                status.unwrap_or(503) as u16,
                if let Some(status) = status {
                    CatalogError::status_kind(status as u16)
                } else {
                    "catalog_rejected"
                },
                "Catalog rejected the read",
            );
            error.fallback_eligible =
                status.is_some_and(|s| matches!(s, 408 | 429 | 500 | 502 | 503 | 504));
            return Err(error);
        }
    }
    let items = data
        .as_array()
        .or_else(|| data.get("items").and_then(Value::as_array))
        .or_else(|| data.get("results").and_then(Value::as_array))
        .ok_or_else(|| CatalogError::new(503, "catalog_response", "共享曲库返回格式无效"))?;
    let mut result = query.defaults.clone();
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();
    for raw in items {
        let Some(bvid) = normalize_bvid(&field(&raw["bvid"]), &field(&raw["url"])) else {
            continue;
        };
        let title = field(&raw["title"]);
        if bvid.len() != 12
            || !bvid.starts_with("BV")
            || !bvid[2..].bytes().all(|b| b.is_ascii_alphanumeric())
            || title.is_empty()
            || title == "已失效视频"
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
    // A legacy array is a capped prefix, not evidence of pagination or a total.
    // Never grow LIMIT or scan more pages to manufacture a count.
    if query.search_offset.is_some_and(|offset| offset > 0)
        && data.get("offset").and_then(Value::as_u64)
            != query.search_offset.map(|offset| offset as u64)
    {
        return Err(CatalogError::new(
            502,
            "catalog_pagination_unavailable",
            "共享曲库未返回请求的分页位置",
        ));
    }
    for key in ["matched_count", "total", "total_count"] {
        if let Some(total) = data[key]
            .as_u64()
            .filter(|total| *total <= 9_007_199_254_740_991)
        {
            result["matched_count"] = json!(total);
            break;
        }
    }
    result["items"] = json!(normalized);
    if query.path.starts_with("/browse?") {
        result["tags"] = json!(data["tags"].as_array().into_iter().flatten().filter(|v| !field(&v["tag"]).is_empty()).take(query.limit).map(|v| json!({
            "tag":field(&v["tag"]),"letter":field(&v["letter"]),"locale":field(&v["locale"]),"yomi":field(&v["yomi"]),"count":v["count"].as_u64().unwrap_or(0)
        })).collect::<Vec<_>>());
    }
    if query.path.starts_with("/browse-category?")
        || data.get("has_more").is_some()
        || (data.get("offset").is_some() && result.get("matched_count").is_some())
    {
        let offset = query_number(
            query.path.split_once('?').map_or("", |(_, q)| q),
            "offset",
            0,
            100_000,
        )? as u64;
        let count = result["items"].as_array().map_or(0, Vec::len) as u64;
        let next = data["next_offset"].as_u64().unwrap_or(offset + count);
        result["offset"] = json!(offset);
        result["next_offset"] = json!(next.max(offset));
        result["has_more"] = json!(
            data["has_more"]
                .as_bool()
                .unwrap_or_else(|| result["matched_count"]
                    .as_u64()
                    .is_some_and(|total| next < total))
                && next > offset
        );
        // Search pagination must explicitly echo its position. Old providers
        // may ignore offset; repeating their first page would duplicate songs.
        if query.search_offset.is_some() && data["offset"].as_u64() != Some(offset) {
            result.as_object_mut().unwrap().remove("has_more");
            result.as_object_mut().unwrap().remove("next_offset");
        }
    }
    Ok(result)
}

struct Inflight(String);
impl Drop for Inflight {
    fn drop(&mut self) {
        let _ = with_catalog(|state| {
            state.inflight.remove(&self.0);
            Ok(())
        });
    }
}

pub(super) fn read_with(
    request: &CatalogRequest,
    path: &str,
    query: &str,
    fetch: &impl Fn(&CloudflareServiceRequest) -> Result<Value, CloudflareServiceError>,
) -> Result<Value, CatalogError> {
    let query = plan(path, query)?;
    if query.empty {
        return Ok(query.defaults);
    }
    let key = format!(
        "{}\n{}\n{:?}:{}",
        request.base_url, query.path, query.search_offset, query.limit
    );
    let (cached, generation) = with_catalog(|state| {
        let now = Instant::now();
        // Expired data is never served on error, including a D1 outage.
        state
            .cache
            .retain(|(_, at, _)| now.duration_since(*at) < CACHE_TTL);
        state.backoff.retain(|(_, until, _)| *until > now);
        if let Some((_, _, value)) = state.cache.iter().find(|(k, _, _)| *k == key) {
            return Ok((Some(value.clone()), state.generation));
        }
        if let Some((_, _, error)) = state
            .backoff
            .iter()
            .find(|(base, _, _)| *base == request.base_url)
        {
            return Err(error.clone());
        }
        if state.inflight.len() >= 2 || !state.inflight.insert(key.clone()) {
            return Err(CatalogError::new(
                429,
                "catalog_busy",
                "Catalog request already in flight",
            ));
        }
        Ok((None, state.generation))
    })?;
    if let Some(value) = cached {
        return Ok(value);
    }
    let _inflight = Inflight(key.clone());
    let result = fetch(&cloud_request(
        request,
        CloudflareOperation::Request {
            method: "GET".into(),
            path: query.path.clone(),
            payload: None,
            authorization: String::new(),
        },
        request.timeout_ms,
    ))
    .map_err(CatalogError::upstream)
    .and_then(|value| normalize(&query, &value["payload"]));
    // Compute potentially expensive size outside AppState.
    let cacheable = result
        .as_ref()
        .is_ok_and(|v| v.to_string().len() <= 512 * 1024);
    with_catalog(|state| {
        if generation != state.generation {
            return Err(CatalogError::new(
                409,
                "catalog_changed",
                "Catalog changed; retry the read",
            ));
        }
        match &result {
            Ok(value) if cacheable => {
                while state.cache.len() >= MAX_CACHE_ENTRIES {
                    state.cache.pop_front();
                }
                state.cache.push_back((key, Instant::now(), value.clone()));
            }
            Err(error) if error.fallback_eligible => {
                while state.backoff.len() >= MAX_CACHE_ENTRIES {
                    state.backoff.pop_front();
                }
                state.backoff.push_back((
                    request.base_url.clone(),
                    Instant::now() + Duration::from_secs(30),
                    error.clone(),
                ));
            }
            _ => {}
        }
        Ok(())
    })?;
    result
}

pub(super) fn normalize_item(raw: &Value) -> Option<Value> {
    let query = plan("/api/catalog/search", "q=normalize&limit=1").ok()?;
    normalize(&query, &json!([raw])).ok()?["items"]
        .as_array()?
        .first()
        .cloned()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn builds_bounded_read_only_queries_without_fallback_or_arbitrary_paths() {
        let query = plan(
            "/api/lark/search",
            "q=%E9%AB%98%E8%BE%BE&limit=80&path=/batch-add",
        )
        .unwrap();
        assert_eq!(
            query.path,
            "/search?limit=80&format=paged&keyword=%E9%AB%98%E8%BE%BE"
        );
        assert!(plan("/api/lark/search", "q=%20").unwrap().empty);
        assert!(plan("/api/d1/category-browse", "q=x").unwrap().empty);
        assert!(plan("/api/admin", "").is_err());
        assert!(plan("/api/lark/search", "limit=99999").is_err());
        assert_eq!(
            plan("/api/d1/category-browse", "tag=z&tag=a&tag=z&offset=100")
                .unwrap()
                .path,
            "/browse-category?limit=80&format=paged&offset=100&tag=a&tag=z"
        );
        assert!(
            !plan("/api/d1/browse", "kind=name")
                .unwrap()
                .path
                .contains("format=paged")
        );
        assert!(
            plan("/api/d1/browse", "kind=artist&tag=Singer")
                .unwrap()
                .path
                .contains("format=paged")
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
