//! Native transport for the shared Internet Remote protocol. Only Rust-validated
//! Host effects reach I/O; never interpret an unvalidated peer envelope here.
use super::*;
use crate::app_state::{AppState, AppStateRequest, native_session::text};
use crate::native_video::{NativeVideoRequest, fetch_native_video};

fn public_state(app: &mut AppState) -> Result<Value, ApiError> {
    let mut state = app
        .native_execute(AppStateRequest::InternetRemoteState { schema_version: 1 })?["remote_state"]
        .clone();
    let snapshot = app.native_snapshot(false)?;
    state["state_revision"] = snapshot["state_revision"].clone();
    let status = &snapshot["player_status"];
    state["player_status"] = if status.is_object() {
        json!({"playing":status["is_paused"] == false,
            "position_seconds":status["current_time"], "duration_seconds":status["duration"]})
    } else {
        Value::Null
    };
    state["gatcha"] = public_data(&snapshot["gatcha"]);
    Ok(state)
}

pub(super) fn route(
    context: &Arc<HostContext>,
    identity: &Identity,
    path: &str,
    body: &Value,
) -> Result<Value, ApiError> {
    with_app(|app| app.native_authorize(identity, true))?;
    match path {
        "/api/internet-remote/qr" => {
            let value = text(body, "url")?;
            if value.len() > 2048
                || !value.starts_with("https://rtc.kevinx96.icu/remote.html#")
                || value.chars().any(char::is_control)
            {
                return Err(ApiError::invalid("无效的公网 Remote 链接"));
            }
            Ok(json!({"image":qr_image(&value)?}))
        }
        "/api/internet-remote/state" => {
            let mut state = with_app(public_state)?;
            state["gatcha_pool_config"] =
                public_data(&library::read(context, "/api/gatcha/pool-config", "")?);
            Ok(state)
        }
        "/api/internet-remote/peer/open" | "/api/internet-remote/peer/close" => {
            let mut command = body.clone();
            command["command"] = json!(if path.ends_with("/open") {
                "open_internet_remote_peer"
            } else {
                "close_internet_remote_peer"
            });
            command["schema_version"] = json!(1);
            if path.ends_with("/open") && command.get("profile").is_none() {
                command["profile"] = json!("controller");
            }
            let request = serde_json::from_value(command)
                .map_err(|_| ApiError::invalid("Remote 连接参数无效"))?;
            with_app(|app| app.native_execute(request))
        }
        "/api/internet-remote/dispatch" => {
            let peer = text(body, "peer_id")?;
            let lane = serde_json::from_value(body["lane"].clone())
                .map_err(|_| ApiError::invalid("Remote 通道无效"))?;
            let message = body["message"]
                .as_str()
                .filter(|value| !value.is_empty() && value.len() <= 65536)
                .ok_or_else(|| ApiError::invalid("Remote 消息长度无效"))?
                .to_owned();
            let reply = with_app(|app| {
                let reset_av_delay = app.native().cache_policy.reset_offset_on_next;
                app.native_execute(AppStateRequest::DispatchInternetRemoteMessage {
                    schema_version: 1,
                    peer_id: peer.clone(),
                    lane,
                    message,
                    reset_av_delay,
                    now: now(),
                })
            })?;
            let mut reply = effect(context, identity, &peer, reply)?;
            // Refresh under the same state lock as observations. Never publish a
            // stale core snapshot paired with a newer player's position.
            with_app(|app| {
                if is_state(&reply["data"]) {
                    reply["data"] = public_state(app)?;
                } else if is_state(&reply["data"]["state"]) {
                    reply["data"]["state"] = public_state(app)?;
                }
                Ok(reply)
            })
        }
        _ => Err(ApiError::new(404, "not_found", "未知 Remote 操作")),
    }
}

fn is_state(value: &Value) -> bool {
    value["playlist"].is_array()
        && value["player_settings"].is_object()
        && value.get("revision").is_some()
}

fn query(effect: &Value, fields: &[(&str, &str)]) -> String {
    let mut params = url::form_urlencoded::Serializer::new(String::new());
    for (key, source) in fields {
        let value = &effect[*source];
        if let Some(values) = value.as_array() {
            for value in values {
                if let Some(value) = value.as_str() {
                    params.append_pair(key, value);
                }
            }
        } else if let Some(value) = value.as_str() {
            params.append_pair(key, value);
        } else if value.is_number() {
            params.append_pair(key, &value.to_string());
        }
    }
    params.finish()
}

fn effect(
    context: &Arc<HostContext>,
    identity: &Identity,
    peer: &str,
    mut reply: Value,
) -> Result<Value, ApiError> {
    let Some(effect) = reply
        .as_object_mut()
        .and_then(|reply| reply.remove("_host_effect"))
    else {
        return Ok(reply);
    };
    let kind = effect["kind"].as_str().unwrap_or_default();
    let page_fields = [
        ("q", "query"),
        ("limit", "limit"),
        ("offset", "offset"),
        ("uid", "uid"),
        ("folder_id", "folder_id"),
    ];
    let result = match kind {
        "sync_cache" => return Ok(reply), // Native pump observes committed AppState.
        "player_control" => {
            with_app(|app| app.native_control(identity, &effect, now()))?;
            return Ok(reply);
        }
        "retry_cache" => {
            api::dispatch(
                context,
                identity,
                true,
                &Method::POST,
                "/api/cache/retry",
                "",
                json!({
                    "item_id":effect["item_id"], "expected_item_incarnation_id":effect["item_incarnation_id"]
                }),
            )?;
            return Ok(reply);
        }
        "submit_rating" => {
            ratings::submit(
                identity,
                &json!({"session_user_name":effect["session_name"], "play_id":effect["play_id"], "bvid":effect["bvid"], "score":effect["score"]}),
            )?;
            return Ok(reply);
        }
        "catalog_search" => catalog::read("/api/lark/search", &query(&effect, &page_fields))?,
        "catalog_browse" => catalog::read(
            "/api/d1/browse",
            &query(
                &effect,
                &[
                    ("kind", "browse_kind"),
                    ("letter", "letter"),
                    ("q", "query"),
                    ("tag", "tag"),
                    ("locale", "locale"),
                    ("offset", "offset"),
                    ("limit", "limit"),
                ],
            ),
        )?,
        "catalog_category_browse" => catalog::read(
            "/api/d1/category-browse",
            &query(
                &effect,
                &[
                    ("q", "query"),
                    ("tag", "tags"),
                    ("tag45", "tag45s"),
                    ("offset", "offset"),
                    ("limit", "limit"),
                ],
            ),
        )?,
        "catalog_song_detail" => {
            let id = text(&effect, "catalog_item_id")?;
            let (bvid, page) = catalog_parts(&id)?;
            let data = catalog::read("/api/lark/search", &format!("q={bvid}&limit=20"))?;
            let mut item = data["items"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|item| item["bvid"] == bvid)
                .cloned()
                .unwrap_or_else(
                    || json!({"bvid":bvid,"title":bvid,"owner_name":"","cover_url":""}),
                );
            item["page"] = json!(page);
            item
        }
        "gatcha_search"
        | "gatcha_browse"
        | "gatcha_favlist_browse"
        | "gatcha_pool_config_get"
        | "gatcha_candidate" => {
            let path = match kind {
                "gatcha_search" => "/api/gatcha/search",
                "gatcha_browse" => "/api/gatcha/browse",
                "gatcha_favlist_browse" => "/api/gatcha/favlist/browse",
                "gatcha_pool_config_get" => "/api/gatcha/pool-config",
                _ => "/api/gatcha/candidate",
            };
            let value = library::read(context, path, &query(&effect, &page_fields))?;
            if kind == "gatcha_candidate" && !value.is_object() {
                return Err(ApiError::new(
                    404,
                    "gatcha_empty_pool",
                    "没找到符合条件的歌曲，再试一次吧",
                ));
            }
            value
        }
        "gatcha_pool_config_set"
        | "gatcha_uid_preview"
        | "gatcha_uid_add"
        | "gatcha_refresh"
        | "gatcha_favlist_preview"
        | "gatcha_favlist_refresh" => {
            let path = match kind {
                "gatcha_pool_config_set" => "/api/gatcha/pool-config",
                "gatcha_uid_preview" => "/api/gatcha/uids/preview",
                "gatcha_uid_add" => "/api/gatcha/uids/add",
                "gatcha_refresh" => "/api/gatcha/refresh",
                "gatcha_favlist_preview" => "/api/gatcha/favlist/preview",
                _ => "/api/gatcha/favlist",
            };
            let mut body = effect.clone();
            body.as_object_mut().unwrap().remove("kind");
            library::write(context, identity, path, &body)?
        }
        "fetch_playlist_item" => {
            let request_id = text(&reply, "request_id")?;
            let result = add(context, peer, &request_id, &effect);
            if result.is_err() {
                let _ = with_app(|app| {
                    app.native_execute(AppStateRequest::CancelInternetRemotePlaylistAdd {
                        schema_version: 1,
                        peer_id: peer.into(),
                        request_id,
                    })
                });
            }
            // Completion can only return sync_cache; still strip it at the boundary.
            return result.map(|mut value| {
                value.as_object_mut().unwrap().remove("_host_effect");
                value
            });
        }
        _ => {
            return Err(ApiError::new(
                503,
                "unsupported_effect",
                "Remote 操作尚未接入",
            ));
        }
    };
    reply["data"] = public_data(&result);
    Ok(reply)
}

fn catalog_parts(id: &str) -> Result<(&str, u32), ApiError> {
    let (bvid, page) = id.split_once("_p").map_or((id, "1"), |value| value);
    let page = page
        .parse::<u32>()
        .ok()
        .filter(|page| (1..=10000).contains(page));
    if bvid.len() != 12
        || !bvid.starts_with("BV")
        || !bvid.bytes().all(|b| b.is_ascii_alphanumeric())
        || page.is_none()
    {
        return Err(ApiError::invalid("曲库歌曲标识无效"));
    }
    Ok((bvid, page.unwrap()))
}

fn add(
    _context: &HostContext,
    peer: &str,
    request_id: &str,
    effect: &Value,
) -> Result<Value, ApiError> {
    let (bvid, page) = catalog_parts(effect["catalog_item_id"].as_str().unwrap_or_default())?;
    let cookie = with_app(|app| {
        api::queue_space(app.native_core_snapshot()?.playlist.len())?;
        Ok(app.native().cookie.clone())
    })?;
    let request: NativeVideoRequest = serde_json::from_value(json!({"url":format!("https://www.bilibili.com/video/{bvid}?p={page}"),"selected_video_page":effect.get("selected_video_page"),"selected_audio_pages":effect.get("selected_audio_pages")})).map_err(|_| ApiError::invalid("分 P 参数无效"))?;
    let item = fetch_native_video(&request, &cookie).map_err(api::video_error)?;
    let result = with_app(|app| {
        api::queue_space(app.native_core_snapshot()?.playlist.len())?;
        let reset_av_delay = app.native().cache_policy.reset_offset_on_next;
        app.native_execute(AppStateRequest::CompleteInternetRemotePlaylistAdd {
            schema_version: 1,
            peer_id: peer.into(),
            request_id: request_id.into(),
            item: item.clone(),
            reset_av_delay,
            now: now(),
        })
    })?;
    if result["accepted"] == true {
        catalog_append::enqueue(&item);
    }
    Ok(result)
}

fn bounded(value: &Value, limit: usize) -> String {
    let text = match value {
        Value::String(v) => v.clone(),
        Value::Number(v) => v.to_string(),
        _ => String::new(),
    };
    text.chars()
        .filter(|c| !c.is_control())
        .take(limit)
        .collect()
}

fn asset_url(value: &Value) -> String {
    let raw = bounded(value, 2048);
    let raw = if raw.starts_with("//") {
        format!("https:{raw}")
    } else {
        raw.replacen("http://", "https://", 1)
    };
    let Ok(mut url) = url::Url::parse(&raw) else {
        return String::new();
    };
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port_or_known_default() != Some(443)
        || !url
            .host_str()
            .is_some_and(|host| host == "hdslb.com" || host.ends_with(".hdslb.com"))
    {
        return String::new();
    }
    url.set_fragment(None);
    url.to_string()
}

/// Allowlisted public metadata only, shared by all library/catalog effects.
/// No arbitrary nesting, caller URLs, filesystem paths, cookies or task results.
fn public_data(value: &Value) -> Value {
    project_public_data(value, 0)
}

fn project_public_data(value: &Value, depth: u8) -> Value {
    if depth > 3 {
        return json!({});
    }
    let Some(object) = value.as_object() else {
        return if let Some(items) = value.as_array() {
            json!({"items":items.iter().take(100).map(|v| project_public_data(v, depth + 1)).collect::<Vec<_>>()})
        } else {
            json!({})
        };
    };
    let mut result = json!({});
    for key in [
        "kind",
        "letter",
        "locale",
        "query",
        "tag",
        "selected_uid",
        "selected_folder_id",
        "uid",
        "fid",
        "folder_id",
        "id",
        "title",
        "name",
        "owner_name",
        "author",
        "cache_mode",
        "cache_mode_label",
        "mode",
        "message",
        "last_status",
        "last_message",
        "last_error",
        "bvid",
        "mid",
        "fav_uid",
        "source",
        "local_source",
        "played_count",
        "preserved_1",
        "rank",
        "tag_1",
        "tag_2",
        "tag_3",
        "tag_4",
        "tag_5",
        "yomi",
    ] {
        if let Some(value) = object.get(key) {
            result[key] = json!(bounded(value, if key == "title" { 512 } else { 400 }));
        }
    }
    for key in [
        "count",
        "page",
        "offset",
        "limit",
        "next_offset",
        "matched_count",
        "updated_at",
        "media_count",
        "uid_weight",
        "favlist_weight",
        "cached_count",
        "added_count",
        "total_count",
        "folder_count",
        "public_folder_count",
        "matched_folder_count",
        "item_count",
        "last_updated_at",
    ] {
        if object
            .get(key)
            .and_then(Value::as_f64)
            .filter(|n| n.is_finite() && *n >= 0.0)
            .is_some()
        {
            result[key] = object[key].clone();
        }
    }
    for key in [
        "busy",
        "background_busy",
        "blocking",
        "has_more",
        "selected",
        "is_local",
        "already_followed",
        "added",
        "started",
    ] {
        if let Some(value) = object.get(key).and_then(Value::as_bool) {
            result[key] = json!(value);
        }
    }
    for key in ["cover_url", "avatar_url"] {
        if let Some(value) = object.get(key) {
            result[key] = json!(asset_url(value));
        }
    }
    for key in [
        "items",
        "owners",
        "folders",
        "uid_options",
        "favlist_folder_options",
        "tags",
        "tag45s",
        "excluded_uids",
        "excluded_favlist_folders",
        "selected_folder_ids",
        "uids",
    ] {
        if let Some(values) = object.get(key).and_then(Value::as_array) {
            let limit = if key == "items" {
                100
            } else if key == "tags" {
                500
            } else {
                256
            };
            result[key] = json!(
                values
                    .iter()
                    .take(limit)
                    .map(|value| if value.is_object() {
                        project_public_data(value, depth + 1)
                    } else {
                        json!(bounded(value, 400))
                    })
                    .collect::<Vec<_>>()
            );
        }
    }
    if let Some(cache) = object.get("cache").filter(|v| v.is_object()) {
        result["cache"] = project_public_data(cache, depth + 1);
    }
    if let Some(bvid) = object.get("bvid").and_then(Value::as_str) {
        if result["owner_name"].as_str().unwrap_or_default().is_empty() {
            result["owner_name"] = json!(bounded(&value["author"], 256));
        }
        let page = object
            .get("page")
            .and_then(Value::as_u64)
            .unwrap_or(1)
            .clamp(1, 10000);
        result["catalog_item_id"] = json!(if page == 1 {
            bvid.into()
        } else {
            format!("{bvid}_p{page}")
        });
        result["page"] = json!(page);
        result["cached"] = json!(value["is_local"] == true);
        if result["cover_url"].as_str().unwrap_or_default().is_empty() {
            for key in ["cover", "pic", "pic_url", "thumbnail"] {
                let url = asset_url(&value[key]);
                if !url.is_empty() {
                    result["cover_url"] = json!(url);
                    break;
                }
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn public_effect_results_keep_covers_and_pagination_but_never_secrets_or_paths() {
        let value = public_data(
            &json!({"items":[{"bvid":"BV1zm41117sU","title":"Song","cover":"//i1.hdslb.com/x.jpg","page":2,"is_local":true,"path":"private","cookie":"secret","url":"https://evil.test"}], "has_more":true,"next_offset":200,"offset":100,"cookie":"secret","entries":[{"secret":"secret"}]}),
        );
        assert_eq!(value["items"][0]["catalog_item_id"], "BV1zm41117sU_p2");
        assert_eq!(value["items"][0]["cover_url"], "https://i1.hdslb.com/x.jpg");
        assert_eq!(value["has_more"], true);
        assert_eq!(value["next_offset"], 200);
        assert!(!value.to_string().contains("secret"));
        assert!(!value.to_string().contains("private"));
        assert!(!value.to_string().contains("evil"));
        for raw in [
            "https://hdslb.com.evil.test/x",
            "https://127.0.0.1/x",
            "https://user@i1.hdslb.com/x",
            "https://i1.hdslb.com:123/x",
        ] {
            assert!(asset_url(&json!(raw)).is_empty());
        }
    }
    #[test]
    fn catalog_ids_cannot_be_paths_or_urls() {
        assert_eq!(
            catalog_parts("BV1zm41117sU_p2").unwrap(),
            ("BV1zm41117sU", 2)
        );
        for raw in [
            "https://evil.test",
            "../../private",
            "BV1zm41117sU_p0",
            "BV1zm41117sU_p2?x",
            "BV1zm41117sU_p10001",
        ] {
            assert!(catalog_parts(raw).is_err());
        }
    }
}
