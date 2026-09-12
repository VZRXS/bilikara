use super::*;
use crate::app_state::{
    AppStateRequest,
    native_session::{positive, text},
};
use crate::native_video::{NativeVideoRequest, fetch_native_video};

pub(super) fn queue_space(length: usize) -> Result<(), ApiError> {
    if length >= 200 {
        return Err(ApiError::new(
            429,
            "queue_full",
            "此 Alpha 点歌列表最多 200 首",
        ));
    }
    Ok(())
}

pub(super) fn video_error(error: crate::native_video::NativeVideoError) -> ApiError {
    let mut api = ApiError::new(
        if error.binding.is_some() { 409 } else { 400 },
        &error.code,
        error.message,
    );
    if let Some(binding) = error.binding {
        api.extra = json!({"binding":binding});
    }
    api
}

pub(super) fn dispatch(
    context: &Arc<HostContext>,
    identity: &Identity,
    host: bool,
    method: &Method,
    path: &str,
    query: &str,
    body: Value,
) -> Result<Value, ApiError> {
    with_app(|app| app.native_authorize(identity, false))?;
    if method == Method::GET {
        if path == "/api/internet-remote/state" {
            return internet::route(context, identity, path, &body);
        }
        if path == "/api/ui-language" {
            return preferences::language(context, identity, None);
        }
        if path == "/api/playlist/export-data" {
            return exports::snapshot(identity, query);
        }
        if path == "/api/played-sessions" {
            return exports::sessions(identity);
        }
        if matches!(
            path,
            "/api/lark/search" | "/api/d1/browse" | "/api/d1/category-browse"
        ) {
            return catalog::read(path, query);
        }
        if path.starts_with("/api/gatcha/") {
            return library::read(context, path, query);
        }
        return with_app(|app| match path {
            "/api/state" => app.native_snapshot(host),
            "/api/remote-identity" => app.native_identity(identity),
            "/api/diagnostics/native" if host => Ok(app.native_diagnostics()),
            _ => Err(unavailable()),
        });
    }
    if method != Method::POST {
        return Err(ApiError::new(405, "method", "此接口需要 POST"));
    }
    if !body.is_object() {
        return Err(ApiError::invalid("请求必须为 JSON 对象"));
    }
    if path == "/api/session/startup-choice" {
        return with_app(|app| {
            app.native_authorize(identity, true)?;
            let continue_previous = match body["choice"].as_str() {
                Some("continue") => true,
                Some("new") => false,
                _ => return Err(ApiError::invalid("请选择继续上一场或开启新一场")),
            };
            let now = now();
            app.native_execute(AppStateRequest::ResolveNativeSession {
                schema_version: 1,
                continue_previous,
                new_session: crate::app_state::SessionArchiveSeed {
                    file_name: format!("played-native-{}.json", (now * 1000.0) as u64),
                    session_started_at: now,
                    items: Vec::new(),
                },
                now,
            })?;
            app.native_snapshot(true)
        });
    }
    if with_app(|app| Ok(app.native_session_choice_pending()))? {
        return Err(ApiError::new(
            409,
            "session_choice_pending",
            "请先在 Host 选择继续上一场或开启新一场",
        ));
    }
    if path == "/api/cache-policy" {
        return preferences::update(context, identity, &body);
    }
    if path.starts_with("/api/app/update/") {
        return updates::route(identity, path, &body);
    }
    if path.starts_with("/api/internet-remote/") {
        return internet::route(context, identity, path, &body);
    }
    if path == "/api/rating/submit" {
        return ratings::submit(identity, &body);
    }
    if path == "/api/rating/log" {
        with_app(|app| app.native_requester(identity, ""))?;
        // Backend-owned outcomes are logged separately; never persist arbitrary
        // client messages, usernames or capability URLs in diagnostics.
        return Ok(json!({}));
    }
    if path == "/api/ui-language" {
        return preferences::language(context, identity, Some(&body));
    }
    if path.starts_with("/api/gatcha/") {
        return library::write(context, identity, path, &body);
    }
    if path == "/api/diagnostics/markdown" {
        return diagnostics::markdown(context, identity, &body);
    }
    if path == "/api/bbdown/login/start" {
        return login::begin(context.clone(), identity);
    }
    if path == "/api/bbdown/logout" {
        return login::logout(context, identity);
    }
    if path == "/api/playlist/add" {
        let url = text(&body, "url")?;
        let (cookie, session_generation) = with_app(|app| {
            app.native_requester(identity, body["requester_name"].as_str().unwrap_or(""))?;
            let snapshot = app.native_core_snapshot()?;
            if snapshot.session_users.is_empty() {
                return Err(ApiError::invalid("请先添加本场 KTV 用户"));
            }
            queue_space(snapshot.playlist.len())?;
            Ok((app.native().cookie.clone(), snapshot.session_generation))
        })?;
        let request=serde_json::from_value::<NativeVideoRequest>(json!({"url":url,"selected_video_page":body.get("selected_video_page"),"selected_audio_pages":body.get("selected_audio_pages")})).map_err(|_|ApiError::invalid("分 P 选择格式无效"))?;
        let item = fetch_native_video(&request, &cookie).map_err(video_error)?;
        let snapshot = with_app(|app| {
            let requester =
                app.native_requester(identity, body["requester_name"].as_str().unwrap_or(""))?;
            let snapshot = app.native_core_snapshot()?;
            if snapshot.session_generation != session_generation {
                return Err(ApiError::new(
                    409,
                    "session_changed",
                    "本场 KTV 已更换，请重新点歌",
                ));
            }
            // Other phones can finish metadata I/O first. Recheck admission
            // under the same lock as AddItem, not only before the HTTP request.
            queue_space(snapshot.playlist.len())?;
            let reset_av_delay = app.native().cache_policy.reset_offset_on_next;
            let result = app.native_execute(AppStateRequest::AddItem {
                schema_version: 1,
                item: item.clone(),
                position: body["position"].as_str().unwrap_or("tail").into(),
                requester_name: requester,
                reset_av_delay,
                allow_repeat: body["allow_repeat"].as_bool().unwrap_or(false),
                now: now(),
            });
            if let Err(mut error) = result {
                if error.code == "duplicate_session_request" {
                    error.extra["duplicate_item"] = json!(item);
                }
                return Err(error);
            }
            app.native_snapshot(host)
        })?;
        catalog_append::enqueue(&item);
        return Ok(snapshot);
    }
    if path == "/api/cache/retry" {
        let (item, cookie) = with_app(|app| {
            app.native_authorize(identity, false)?;
            let id = text(&body, "item_id")?;
            let expected = text(&body, "expected_item_incarnation_id")?;
            let snapshot = app.native_core_snapshot()?;
            let item = snapshot
                .current_item
                .iter()
                .chain(snapshot.playlist.iter())
                .find(|item| item.id == id && item.item_incarnation_id == expected)
                .cloned()
                .ok_or_else(|| ApiError::new(409, "stale_item", "此歌曲已更换"))?;
            Ok((item, app.native().cookie.clone()))
        })?;
        cache::retry(context, &item, &cookie)?;
        return with_app(|app| app.native_snapshot(host));
    }
    with_app(|app| {
        let now = now();
        match path {
            "/api/remote-identity/register" => {
                return app.native_register(identity, &body, false, now);
            }
            "/api/remote-identity/rename" => {
                return app.native_register(identity, &body, true, now);
            }
            "/api/player/claim-program" => return app.native_claim(identity, &body, false),
            "/api/player/retire-program" => return app.native_claim(identity, &body, true),
            "/api/player/status" => return app.native_player_status(identity, &body, now),
            "/api/player/control" => {
                app.native_control(identity, &body, now)?;
                return app.native_snapshot(host);
            }
            "/api/player/control-ack" => {
                app.native_ack(identity, &body)?;
                return Ok(json!({}));
            }
            "/api/player/diagnostic" => {
                app.native_authorize(identity, true)?;
                app.native_diagnostic(&body, now);
                return Ok(json!({}));
            }
            "/api/client/disconnect" => return Ok(json!({})),
            "/api/remote/connection-diagnostic" => {
                app.native_requester(identity, "")?;
                app.native_remote_connection_diagnostic(&body, now);
                return Ok(json!({}));
            }
            "/api/client/media-capabilities" => {
                app.native_authorize(identity, true)?;
                return Ok(json!({"profile":"avc-aac-720p","hevc_available":false}));
            }
            _ => {}
        }
        let shared = [
            "/api/player/next",
            "/api/player/audio-variant",
            "/api/player/volume",
            "/api/player/av-delay-action",
            "/api/player/key-shift",
            "/api/playlist/reorder",
            "/api/playlist/resort",
        ];
        app.native_authorize(identity, !shared.contains(&path))?;
        let mut command = json!({"schema_version":1,"now":now});
        match path {
            "/api/session-users/add" => {
                command["command"] = json!("add_session_user");
                command["name"] = json!(text(&body, "name")?);
            }
            "/api/session-users/remove" => {
                command["command"] = json!("remove_session_user");
                command["name"] = json!(text(&body, "name")?);
            }
            "/api/session-users/reorder" => {
                command["command"] = json!("move_session_user_to_index");
                command["name"] = body["name"].clone();
                // Shared Host sends `index`; retain the early Alpha spelling.
                command["target_index"] =
                    body.get("index").unwrap_or(&body["target_index"]).clone();
            }
            "/api/playlist/remove" | "/api/playlist/play-now" | "/api/playlist/move-next" => {
                command["command"] = json!(match path {
                    "/api/playlist/remove" => "remove_item",
                    "/api/playlist/play-now" => "move_to_front",
                    _ => "move_to_next",
                });
                command["item_id"] = json!(text(&body, "item_id")?);
            }
            "/api/playlist/reorder" => {
                command["command"] = json!("move_item_to_index");
                command["item_id"] = json!(text(&body, "item_id")?);
                command["target_index"] =
                    body.get("index").unwrap_or(&body["target_index"]).clone();
            }
            "/api/playlist/resort" => command["command"] = json!("resort_playlist_by_cycle"),
            "/api/playlist/clear" => command["command"] = json!("clear_playlist"),
            "/api/history/clear" => command["command"] = json!("clear_history"),
            "/api/history/remove" => {
                command["command"] = json!("remove_history_entry");
                command["key"] = json!(text(&body, "key")?);
            }
            "/api/player/next" => {
                command["command"] = json!("advance_to_next");
                command["expected_playback_generation"] =
                    json!(positive(&body, "playback_generation")?);
            }
            "/api/player/reset" => command["command"] = json!("reset_player"),
            "/api/player/restart-program" => {
                command = json!({"command":"restart_playback_program","schema_version":1});
                app.native_release_claim();
            }
            "/api/player/audio-variant" => {
                command["command"] = json!("set_audio_variant");
                for key in ["item_id", "expected_item_incarnation_id", "variant_id"] {
                    command[key] = json!(text(&body, key)?);
                }
            }
            "/api/player/volume" => {
                // Parse both inputs before committing either existing core command.
                let settings = app.native_core_snapshot()?.player_settings;
                let volume =
                    body.get("volume_percent")
                        .cloned()
                        .unwrap_or(json!(settings.volume_percent))
                        .as_i64()
                        .filter(|v| (0..=100).contains(v))
                        .ok_or_else(|| ApiError::invalid("音量无效"))? as i32;
                let muted = body
                    .get("is_muted")
                    .cloned()
                    .unwrap_or(json!(settings.is_muted))
                    .as_bool()
                    .ok_or_else(|| ApiError::invalid("静音状态无效"))?;
                app.native_execute(AppStateRequest::SetVolume {
                    schema_version: 1,
                    volume_percent: volume,
                    now,
                })?;
                app.native_execute(AppStateRequest::SetMuted {
                    schema_version: 1,
                    is_muted: muted,
                    now,
                })?;
                return app.native_snapshot(host);
            }
            "/api/player/advance-delay" => {
                command["command"] = json!("set_song_advance_delay");
                command["delay_seconds"] = body["delay_seconds"].clone();
            }
            "/api/player/key-shift" => {
                command["command"] = json!("set_key_shift");
                command["key_shift"] = body["key_shift"].clone();
            }
            "/api/player/av-delay-action" => {
                command["command"] = json!("apply_av_delay");
                command["action"] = body.clone();
            }
            "/api/backup/discard" | "/api/data/reset" => {
                command["command"] = json!(if path == "/api/data/reset" {
                    "reset_runtime"
                } else {
                    "discard_backup"
                });
                command["new_session"] = json!({"file_name":format!("session-{}.json",(now*1000.0) as u64),"session_started_at":now,"items":[]});
            }
            "/api/session/continue-previous" => {
                command["command"] = json!("continue_previous_session")
            }
            _ => return Err(unavailable()),
        }
        let request: AppStateRequest = serde_json::from_value(command)
            .map_err(|_| ApiError::invalid("操作参数不完整或格式无效"))?;
        app.native_execute(request)?;
        if path == "/api/player/av-delay-action" {
            Ok(json!(app.native_core_snapshot()?.player_settings.av_delay))
        } else {
            app.native_snapshot(host)
        }
    })
}

fn unavailable() -> ApiError {
    ApiError::new(
        501,
        "alpha_unavailable",
        "此功能尚未接入 Android Alpha；本版本先验证点歌、本机播放和局域网 Remote",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_queue_admission_rejects_the_first_overflow_and_larger_values() {
        assert!(queue_space(0).is_ok());
        assert!(queue_space(199).is_ok());
        for length in [200, 201, usize::MAX] {
            let error = queue_space(length).unwrap_err();
            assert_eq!(error.status, 429);
            assert_eq!(error.code, "queue_full");
        }
    }
}
