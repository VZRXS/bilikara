from __future__ import annotations

import re
import threading
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from .bilibili import (
    MISSING_BILIBILI_COOKIE_MESSAGE,
    add_gatcha_uid,
    annotate_gatcha_local_status,
    browse_gatcha_cache,
    browse_gatcha_favlist,
    effective_bilibili_cookie,
    fetch_gatcha_candidate,
    fetch_video_item,
    gatcha_pool_config_detail,
    gatcha_pool_config_snapshot,
    gatcha_task_snapshot,
    preview_gatcha_favlist,
    preview_gatcha_uid,
    refresh_gatcha_favlist,
    search_gatcha_cache,
    update_gatcha_pool_config,
)
from .lark_pool_client import (
    append_lark_pool_entries_in_background,
    browse_d1_category_pool,
    browse_d1_pool,
    search_lark_pool,
    submit_cloudflare_song_rating,
)
from .store import PlaylistStoreCommandError


CATALOG_ID_RE = re.compile(r"^(BV[0-9A-Za-z]{10})(?:_p([1-9][0-9]{0,8}))?$")


class InternetRemoteDispatchError(ValueError):
    def __init__(self, kind: str, message: str) -> None:
        self.kind = kind
        super().__init__(message)


def open_peer(context: Any, peer_id: str, epoch: str, profile: str) -> dict[str, Any]:
    return context.store.open_internet_remote_peer(peer_id, epoch, profile)


def close_peer(context: Any, peer_id: str) -> dict[str, Any]:
    return context.store.close_internet_remote_peer(peer_id)


def remote_state(context: Any) -> dict[str, Any]:
    result = context.store.internet_remote_state()
    state = result.get("remote_state")
    if not isinstance(state, dict):
        raise RuntimeError("Rust AppState omitted Internet Remote state")
    public = dict(state)
    public["gatcha"] = _public_gatcha_task(gatcha_task_snapshot())
    public["gatcha_pool_config"] = _public_gatcha_pool_config(
        gatcha_pool_config_snapshot()
    )
    return public


def dispatch(context: Any, peer_id: str, lane: str, message: str) -> dict[str, Any]:
    """Bridge one WebRTC message into the Rust-owned Internet Remote module.

    Rust validates the envelope, authorizes the operation, applies every AppState
    mutation, and returns at most one typed Host effect. This adapter only performs
    retained Host I/O and never interprets the original remote request.
    """

    try:
        response = context.store.dispatch_internet_remote_message(
            peer_id,
            lane,
            message,
            reset_av_delay=context.cache_manager.reset_offset_on_next,
        )
        return _run_host_effect(context, peer_id, response)
    except PlaylistStoreCommandError as exc:
        raise InternetRemoteDispatchError(exc.kind, str(exc)) from exc


def _run_host_effect(
    context: Any,
    peer_id: str,
    response: dict[str, Any],
) -> dict[str, Any]:
    public_response = dict(response)
    effect = public_response.pop("_host_effect", None)
    if effect is None:
        return public_response
    if not isinstance(effect, dict):
        raise RuntimeError("Rust AppState returned an invalid Internet Remote Host effect")

    kind = str(effect.get("kind") or "")
    if kind == "sync_cache":
        context.cache_manager.sync_with_playlist()
        return public_response
    if kind == "player_control":
        context.issue_player_control(
            action=str(effect["action"]),
            playback_generation=int(effect["playback_generation"]),
            item_id=str(effect.get("item_id") or ""),
            delta_seconds=int(effect.get("delta_seconds") or 0),
        )
        return public_response
    if kind == "retry_cache":
        context.retry_cache_item(
            str(effect["item_id"]),
            expected_item_incarnation_id=str(effect["item_incarnation_id"]),
            force=True,
        )
        return public_response
    if kind == "submit_rating":
        context.submit_rating_in_background(
            str(effect["session_name"]),
            str(effect["play_id"]),
            str(effect["bvid"]),
            int(effect["score"]),
        )
        return public_response
    if kind == "catalog_search":
        items = annotate_gatcha_local_status(
            search_lark_pool(str(effect["query"]), limit=int(effect["limit"]))
        )
        public_response["data"] = {
            "items": [_public_catalog_item(item) for item in items]
        }
        return public_response
    if kind == "catalog_browse":
        result = browse_d1_pool(
            str(effect["browse_kind"]),
            letter=str(effect["letter"]),
            query=str(effect["query"]),
            tag=str(effect["tag"]),
            locale=str(effect["locale"]),
            limit=int(effect["limit"]),
        )
        public_response["data"] = _public_catalog_browse(result)
        return public_response
    if kind == "catalog_category_browse":
        result = browse_d1_category_pool(
            [str(value) for value in effect["tags"]],
            tag45s=[str(value) for value in effect["tag45s"]],
            query=str(effect["query"]),
            offset=int(effect["offset"]),
            limit=int(effect["limit"]),
        )
        public_response["data"] = _public_category_browse(result)
        return public_response
    if kind == "catalog_song_detail":
        public_response["data"] = _catalog_detail(str(effect["catalog_item_id"]))
        return public_response
    if kind == "gatcha_search":
        public_response["data"] = {
            "items": _public_catalog_items(
                search_gatcha_cache(str(effect["query"]))[: int(effect["limit"])]
            )
        }
        return public_response
    if kind == "gatcha_browse":
        public_response["data"] = _public_gatcha_browse(
            browse_gatcha_cache(str(effect["uid"]), str(effect["query"]))
        )
        return public_response
    if kind == "gatcha_favlist_browse":
        public_response["data"] = _public_gatcha_favlist_browse(
            browse_gatcha_favlist(
                str(effect["folder_id"]),
                str(effect["query"]),
            )
        )
        return public_response
    if kind == "gatcha_pool_config_get":
        public_response["data"] = _public_gatcha_pool_config(
            gatcha_pool_config_detail()
        )
        return public_response
    if kind == "gatcha_candidate":
        candidate = fetch_gatcha_candidate()
        if not candidate:
            raise InternetRemoteDispatchError(
                "gatcha_empty_pool", "没找到符合条件的歌曲，再试一次吧"
            )
        public_response["data"] = _public_catalog_item(candidate)
        return public_response
    if kind == "gatcha_pool_config_set":
        result = update_gatcha_pool_config(
            uid_weight=int(effect["uid_weight"]),
            favlist_weight=int(effect["favlist_weight"]),
            excluded_uids=[str(value) for value in effect["excluded_uids"]],
            excluded_favlist_folders=[
                str(value) for value in effect["excluded_favlist_folders"]
            ],
        )
        context._notify_state_changed()
        public_response["data"] = _public_gatcha_pool_config(
            {**gatcha_pool_config_detail(), **result}
        )
        return public_response
    if kind == "gatcha_uid_preview":
        _require_gatcha_idle()
        public_response["data"] = _public_uid_preview(
            preview_gatcha_uid(str(effect["uid"]))
        )
        return public_response
    if kind == "gatcha_uid_add":
        public_response["data"] = _public_uid_add_result(
            add_gatcha_uid(
                str(effect["uid"]),
                on_start=context._notify_state_changed,
                on_done=context._notify_state_changed,
            )
        )
        return public_response
    if kind == "gatcha_refresh":
        if not effective_bilibili_cookie():
            raise InternetRemoteDispatchError(
                "missing_bilibili_cookie", MISSING_BILIBILI_COOKIE_MESSAGE
            )
        started = context.refresh_gatcha_cache_in_background()
        if not started:
            raise InternetRemoteDispatchError(
                "gatcha_busy", "拉取任务执行中，请等待任务结束"
            )
        public_response["data"] = {"started": True}
        return public_response
    if kind == "gatcha_favlist_preview":
        _require_gatcha_idle()
        public_response["data"] = _public_favlist_preview(
            preview_gatcha_favlist(str(effect["uid"]))
        )
        return public_response
    if kind == "gatcha_favlist_refresh":
        public_response["data"] = _public_favlist_refresh_result(
            refresh_gatcha_favlist(
                str(effect["uid"]),
                [str(value) for value in effect["folder_ids"]],
                on_start=context._notify_state_changed,
                on_done=context._notify_state_changed,
            )
        )
        return public_response
    if kind == "fetch_playlist_item":
        item = _fetch_catalog_item(str(effect["catalog_item_id"]))
        completion = context.store.complete_internet_remote_playlist_add(
            peer_id,
            str(public_response["request_id"]),
            item,
            reset_av_delay=context.cache_manager.reset_offset_on_next,
        )
        completed = _run_host_effect(context, peer_id, completion)
        if completed.get("accepted"):
            _append_catalog_item(item)
        return completed
    raise RuntimeError(f"Rust returned an unsupported Internet Remote Host effect: {kind}")


def _catalog_parts(catalog_id: str) -> tuple[str, int]:
    match = CATALOG_ID_RE.fullmatch(catalog_id)
    if not match:
        raise InternetRemoteDispatchError(
            "invalid_catalog_item_id", "Invalid catalog item id"
        )
    return match.group(1), int(match.group(2) or 1)


def _fetch_catalog_item(catalog_id: str):
    bvid, page = _catalog_parts(catalog_id)
    return fetch_video_item(
        f"https://www.bilibili.com/video/{bvid}?p={page}",
        selected_video_page=page,
    )


def _catalog_detail(catalog_id: str) -> dict[str, Any]:
    bvid, page = _catalog_parts(catalog_id)
    candidates = search_lark_pool(bvid, limit=20)
    for candidate in candidates:
        if str(candidate.get("bvid") or "") == bvid:
            public = _public_catalog_item(candidate)
            public["catalog_item_id"] = catalog_id
            public["page"] = page
            return public
    return {
        "catalog_item_id": catalog_id,
        "bvid": bvid,
        "page": page,
        "title": bvid,
        "owner_name": "",
        "cover_url": "",
    }


def _bounded_text(value: object, limit: int = 512) -> str:
    return str(value or "").strip()[:limit]


def _public_bilibili_asset_url(value: object) -> str:
    raw = _bounded_text(value, 2_048)
    if raw.startswith("//"):
        raw = f"https:{raw}"
    elif raw.lower().startswith("http://"):
        raw = f"https://{raw[7:]}"
    try:
        parsed = urlsplit(raw)
        hostname = (parsed.hostname or "").lower()
        if (
            parsed.scheme.lower() != "https"
            or (hostname != "hdslb.com" and not hostname.endswith(".hdslb.com"))
            or parsed.username is not None
            or parsed.password is not None
            or parsed.port not in {None, 443}
        ):
            return ""
    except ValueError:
        return ""
    netloc = hostname if parsed.port is None else f"{hostname}:443"
    return urlunsplit(("https", netloc, parsed.path, parsed.query, ""))


def _public_catalog_items(items: object) -> list[dict[str, Any]]:
    values = items if isinstance(items, list) else []
    annotated = annotate_gatcha_local_status(
        [value for value in values if isinstance(value, dict)]
    )
    return [_public_catalog_item(value) for value in annotated[:100]]


def _public_catalog_browse(result: object) -> dict[str, Any]:
    value = result if isinstance(result, dict) else {}
    tags = []
    for item in value.get("tags") or []:
        if not isinstance(item, dict):
            continue
        tags.append(
            {
                "tag": _bounded_text(item.get("tag"), 128),
                "letter": _bounded_text(item.get("letter"), 8),
                "locale": _bounded_text(item.get("locale"), 32),
                "yomi": _bounded_text(item.get("yomi"), 256),
                "count": max(0, int(item.get("count") or 0)),
            }
        )
    return {
        "kind": "artist" if value.get("kind") == "artist" else "name",
        "letter": _bounded_text(value.get("letter"), 8),
        "query": _bounded_text(value.get("query"), 400),
        "tag": _bounded_text(value.get("tag"), 400),
        "locale": _bounded_text(value.get("locale"), 32),
        "tags": tags[:500],
        "items": _public_catalog_items(value.get("items")),
    }


def _public_category_browse(result: object) -> dict[str, Any]:
    value = result if isinstance(result, dict) else {}
    offset = max(0, int(value.get("offset") or 0))
    limit = max(1, min(100, int(value.get("limit") or 100)))
    return {
        "query": _bounded_text(value.get("query"), 400),
        "tags": [_bounded_text(item, 400) for item in (value.get("tags") or [])][
            :10
        ],
        "tag45s": [
            _bounded_text(item, 400) for item in (value.get("tag45s") or [])
        ][:10],
        "offset": offset,
        "limit": limit,
        "items": _public_catalog_items(value.get("items")),
        "has_more": bool(value.get("has_more")),
        "next_offset": max(offset, int(value.get("next_offset") or offset)),
    }


def _public_owner(value: object) -> dict[str, Any]:
    item = value if isinstance(value, dict) else {}
    uid = _bounded_text(item.get("uid"), 24)
    return {
        "uid": uid,
        "name": _bounded_text(item.get("name"), 256),
        "space_url": f"https://space.bilibili.com/{uid}" if uid.isdigit() else "",
        "avatar_url": _public_bilibili_asset_url(item.get("avatar_url")),
        "count": max(0, int(item.get("count") or 0)),
    }


def _public_folder(value: object) -> dict[str, Any]:
    item = value if isinstance(value, dict) else {}
    return {
        "id": _bounded_text(item.get("id"), 64),
        "folder_id": _bounded_text(item.get("folder_id"), 24),
        "fid": _bounded_text(item.get("fid"), 24),
        "title": _bounded_text(item.get("title"), 256),
        "media_count": max(0, int(item.get("media_count") or 0)),
        "count": max(0, int(item.get("count") or item.get("media_count") or 0)),
        "uid": _bounded_text(item.get("uid"), 24),
        "avatar_url": _public_bilibili_asset_url(item.get("avatar_url")),
        "selected": bool(item.get("selected")),
    }


def _public_gatcha_browse(result: object) -> dict[str, Any]:
    value = result if isinstance(result, dict) else {}
    return {
        "owners": [_public_owner(item) for item in (value.get("owners") or [])][
            :256
        ],
        "selected_uid": _bounded_text(value.get("selected_uid"), 24),
        "query": _bounded_text(value.get("query"), 400),
        "items": _public_catalog_items(value.get("items")),
        "updated_at": float(value.get("updated_at") or 0),
    }


def _public_gatcha_favlist_browse(result: object) -> dict[str, Any]:
    value = result if isinstance(result, dict) else {}
    return {
        "folders": [_public_folder(item) for item in (value.get("folders") or [])][
            :256
        ],
        "selected_folder_id": _bounded_text(value.get("selected_folder_id"), 64),
        "query": _bounded_text(value.get("query"), 400),
        "items": _public_catalog_items(value.get("items")),
        "updated_at": float(value.get("updated_at") or 0),
    }


def _public_gatcha_pool_config(result: object) -> dict[str, Any]:
    value = result if isinstance(result, dict) else {}
    return {
        "uid_weight": max(0, min(100, int(value.get("uid_weight") or 0))),
        "favlist_weight": max(
            0, min(100, int(value.get("favlist_weight") or 0))
        ),
        "excluded_uids": [
            _bounded_text(item, 24) for item in (value.get("excluded_uids") or [])
        ][:256],
        "excluded_favlist_folders": [
            _bounded_text(item, 64)
            for item in (value.get("excluded_favlist_folders") or [])
        ][:256],
        "updated_at": float(value.get("updated_at") or 0),
        "uid_options": [
            _public_owner(item) for item in (value.get("uid_options") or [])
        ][:256],
        "favlist_folder_options": [
            _public_folder(item)
            for item in (value.get("favlist_folder_options") or [])
        ][:256],
    }


def _public_gatcha_task(result: object) -> dict[str, Any]:
    value = result if isinstance(result, dict) else {}
    return {
        "busy": bool(value.get("busy")),
        "background_busy": bool(value.get("background_busy")),
        "blocking": bool(value.get("blocking")),
        "message": _bounded_text(value.get("message"), 256),
        "last_status": _bounded_text(value.get("last_status"), 32),
        "last_message": _bounded_text(value.get("last_message"), 256),
        "last_error": _bounded_text(value.get("last_error"), 256),
        "last_updated_at": float(value.get("last_updated_at") or 0),
    }


def _public_uid_preview(result: object) -> dict[str, Any]:
    value = result if isinstance(result, dict) else {}
    owner = _public_owner(value)
    return {
        **owner,
        "already_followed": bool(value.get("already_followed")),
        "cache_mode": _bounded_text(value.get("cache_mode"), 32),
        "cache_mode_label": _bounded_text(value.get("cache_mode_label"), 32),
        "cached_count": max(0, int(value.get("cached_count") or 0)),
    }


def _public_uid_add_result(result: object) -> dict[str, Any]:
    value = result if isinstance(result, dict) else {}
    cache = value.get("cache") if isinstance(value.get("cache"), dict) else {}
    return {
        **_public_owner(value),
        "added": bool(value.get("added")),
        "uids": [_bounded_text(item, 24) for item in (value.get("uids") or [])][
            :256
        ],
        "cache": {
            "uid": _bounded_text(cache.get("uid"), 24),
            "mode": _bounded_text(cache.get("mode"), 32),
            "added_count": max(0, int(cache.get("added_count") or 0)),
            "total_count": max(0, int(cache.get("total_count") or 0)),
        },
    }


def _public_favlist_preview(result: object) -> dict[str, Any]:
    value = result if isinstance(result, dict) else {}
    return {
        "uid": _bounded_text(value.get("uid"), 24),
        "folder_count": max(0, int(value.get("folder_count") or 0)),
        "public_folder_count": max(
            0, int(value.get("public_folder_count") or 0)
        ),
        "selected_folder_ids": [
            _bounded_text(item, 24)
            for item in (value.get("selected_folder_ids") or [])
        ][:256],
        "folders": [_public_folder(item) for item in (value.get("folders") or [])][
            :256
        ],
    }


def _public_favlist_refresh_result(result: object) -> dict[str, Any]:
    value = result if isinstance(result, dict) else {}
    return {
        "uid": _bounded_text(value.get("uid"), 24),
        "folder_count": max(0, int(value.get("folder_count") or 0)),
        "matched_folder_count": max(
            0, int(value.get("matched_folder_count") or 0)
        ),
        "item_count": max(0, int(value.get("item_count") or 0)),
        "updated_at": float(value.get("updated_at") or 0),
    }


def _require_gatcha_idle() -> None:
    task = gatcha_task_snapshot()
    if task.get("busy"):
        raise InternetRemoteDispatchError(
            "gatcha_busy", str(task.get("message") or "拉取任务执行中，请等待任务结束")
        )


def _public_catalog_item(item: dict[str, Any]) -> dict[str, Any]:
    bvid = str(item.get("bvid") or "")
    try:
        page = max(1, int(item.get("page") or 1))
    except (TypeError, ValueError):
        page = 1
    catalog_id = f"{bvid}_p{page}" if page > 1 else bvid
    public = {
        "catalog_item_id": catalog_id,
        "bvid": bvid,
        "page": page,
        "title": _bounded_text(item.get("title"), 512),
        "owner_name": _bounded_text(
            item.get("owner_name") or item.get("author"), 256
        ),
        "cover_url": _public_bilibili_asset_url(
            item.get("cover_url")
            or item.get("cover")
            or item.get("pic")
            or item.get("pic_url")
            or item.get("thumbnail")
        ),
        "cached": bool(item.get("is_local")),
        "is_local": bool(item.get("is_local")),
    }
    for key, limit in {
        "mid": 24,
        "fav_uid": 24,
        "source": 32,
        "local_source": 32,
        "played_count": 32,
        "preserved_1": 64,
        "rank": 32,
        "tag_1": 128,
        "tag_2": 128,
        "tag_3": 128,
        "tag_4": 128,
        "tag_5": 128,
    }.items():
        value = _bounded_text(item.get(key), limit)
        if value:
            public[key] = value
    return public


def _append_catalog_item(item: Any) -> None:
    try:
        append_lark_pool_entries_in_background(
            [
                {
                    "mid": str(item.owner_mid or ""),
                    "bvid": item.bvid,
                    "title": item.title or item.display_title,
                    "url": item.resolved_url or item.original_url,
                    "owner_name": item.owner_name,
                    "owner_url": item.owner_url,
                    "cover_url": item.cover_url,
                }
            ]
        )
    except Exception:
        return


def submit_rating_background(
    session_user_name: str, play_id: str, bvid: str, score: int
) -> None:
    def worker() -> None:
        submit_cloudflare_song_rating(
            session_user_name=session_user_name,
            play_id=play_id,
            bvid=bvid,
            score=score,
        )

    threading.Thread(target=worker, daemon=True, name="internet-remote-rating").start()
