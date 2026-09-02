from __future__ import annotations

import re
import threading
from typing import Any

from .bilibili import annotate_gatcha_local_status, fetch_video_item
from .lark_pool_client import (
    append_lark_pool_entries_in_background,
    search_lark_pool,
    submit_cloudflare_song_rating,
)


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
    return state


def dispatch(context: Any, peer_id: str, lane: str, message: str) -> dict[str, Any]:
    with context.store.lock:
        validation = context.store.validate_internet_remote_message(peer_id, lane, message)
        if not isinstance(validation, dict):
            raise RuntimeError("Rust AppState returned invalid Internet Remote validation")
        request = validation.get("request")
        if not isinstance(request, dict):
            raise RuntimeError("Rust AppState omitted validated Internet Remote request")
        if not validation.get("accepted"):
            return _response(validation, validation.get("remote_state"), stale=True)

        kind = str(request.get("kind") or "")
        body = request.get("body")
        if not isinstance(body, dict):
            raise RuntimeError("Rust AppState returned invalid Internet Remote request body")

        if kind == "connection.health":
            return _response(validation, {"healthy": True, "state": remote_state(context)})
        if kind == "state.get":
            return _response(validation, remote_state(context))
        if kind == "session.set_identity":
            name = _session_name(validation)
            context.add_session_user(name)
            return _response(validation, {"name": name, "state": remote_state(context)})
        if kind in {"catalog.search", "catalog.song_detail", "playlist.add"}:
            validated_revision = int(validation.get("current_revision") or 0)
        else:
            result = _dispatch_locked(context, validation, kind, body)
            return _response(validation, result)

    if kind == "catalog.search":
        items = annotate_gatcha_local_status(
            search_lark_pool(str(body["query"]), limit=int(body["limit"]))
        )
        return _response(validation, {"items": [_public_catalog_item(item) for item in items]})
    if kind == "catalog.song_detail":
        catalog_id = str(body["catalog_item_id"])
        return _response(validation, _catalog_detail(catalog_id))

    catalog_id = str(body["catalog_item_id"])
    item = _fetch_catalog_item(catalog_id)
    with context.store.lock:
        if context.store.revision != validated_revision:
            return _response(validation, remote_state(context), stale=True)
        requester_name = _session_name(validation)
        if not context.store.has_session_user(requester_name):
            raise InternetRemoteDispatchError(
                "internet_remote_identity_missing",
                "Internet Remote identity is no longer active",
            )
        context.add_item(
            item,
            position="tail",
            requester_name=requester_name,
            allow_repeat=False,
        )
        state = remote_state(context)
    _append_catalog_item(item)
    return _response(validation, state)


def _dispatch_locked(
    context: Any,
    validation: dict[str, Any],
    kind: str,
    body: dict[str, Any],
) -> Any:
    if kind == "playlist.remove":
        context.remove_item(str(body["item_id"]))
    elif kind == "playlist.move":
        context.move_item_to_index(str(body["item_id"]), int(body["target_index"]))
    elif kind == "playlist.resort":
        context.resort_playlist_by_cycle()
    elif kind == "playlist.move_next":
        context.move_to_next(str(body["item_id"]))
    elif kind == "playlist.play_now":
        context.move_to_front(str(body["item_id"]))
    elif kind in {"playback.play", "playback.pause", "playback.seek_relative", "playback.next"}:
        snapshot = context.store.snapshot()
        current = snapshot.get("current_item") or {}
        action = {
            "playback.play": "play",
            "playback.pause": "pause",
            "playback.seek_relative": "seek-relative",
            "playback.next": "next-track",
        }[kind]
        context.issue_player_control(
            action=action,
            playback_generation=int(snapshot["playback_generation"]),
            item_id=str(current.get("id") or ""),
            delta_seconds=int(body.get("delta_seconds") or 0),
        )
    elif kind == "player.set_volume":
        context.set_volume_percent(int(body["volume_percent"]))
    elif kind == "player.set_muted":
        context.set_muted(bool(body["is_muted"]))
    elif kind == "player.set_key_shift":
        context.set_key_shift(int(body["key_shift"]))
    elif kind == "player.set_av_delay":
        context.apply_av_delay_action(
            {"type": "set_effective", "effective_delay_ms": int(body["effective_delay_ms"])}
        )
    elif kind == "player.set_audio_variant":
        item = _find_active_item(context.store.snapshot(), str(body["item_id"]))
        context.set_audio_variant(
            str(body["item_id"]),
            str(body["variant_id"]),
            expected_item_incarnation_id=str(item["item_incarnation_id"]),
        )
    elif kind == "cache.retry":
        item = _find_active_item(context.store.snapshot(), str(body["item_id"]))
        context.retry_cache_item(
            str(body["item_id"]),
            expected_item_incarnation_id=str(item["item_incarnation_id"]),
            force=True,
        )
    elif kind == "rating.submit":
        snapshot = context.store.snapshot()
        current = snapshot.get("current_item") or {}
        bvid = str(current.get("bvid") or "")
        if not bvid:
            raise InternetRemoteDispatchError("internet_remote_no_current_song", "No song is playing")
        context.submit_rating_in_background(
            _session_name(validation), str(body["play_id"]), bvid, int(body["score"])
        )
    else:
        raise RuntimeError(f"Rust admitted an unsupported Internet Remote request: {kind}")
    return remote_state(context)


def _response(
    validation: dict[str, Any], result: Any, *, stale: bool = False
) -> dict[str, Any]:
    revision = int(validation.get("current_revision") or 0)
    if isinstance(result, dict):
        if isinstance(result.get("revision"), int):
            revision = int(result["revision"])
        elif isinstance(result.get("state"), dict) and isinstance(
            result["state"].get("revision"), int
        ):
            revision = int(result["state"]["revision"])
    return {
        "request_id": str(validation.get("request_id") or ""),
        "sequence": int(validation.get("sequence") or 0),
        "accepted": not stale,
        "stale": bool(stale),
        "revision": revision,
        "data": result,
    }


def _session_name(validation: dict[str, Any]) -> str:
    name = str(validation.get("session_name") or "").strip()
    if not name:
        raise InternetRemoteDispatchError(
            "internet_remote_identity_required",
            "Set an Internet Remote identity before this operation",
        )
    return name


def _catalog_parts(catalog_id: str) -> tuple[str, int]:
    match = CATALOG_ID_RE.fullmatch(catalog_id)
    if not match:
        raise InternetRemoteDispatchError("invalid_catalog_item_id", "Invalid catalog item id")
    return match.group(1), int(match.group(2) or 1)


def _fetch_catalog_item(catalog_id: str):
    bvid, page = _catalog_parts(catalog_id)
    return fetch_video_item(f"https://www.bilibili.com/video/{bvid}?p={page}", selected_video_page=page)


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


def _public_catalog_item(item: dict[str, Any]) -> dict[str, Any]:
    bvid = str(item.get("bvid") or "")
    page = int(item.get("page") or 1)
    catalog_id = f"{bvid}_p{page}" if page > 1 else bvid
    cover_url = str(item.get("cover_url") or "")
    if not re.fullmatch(r"https://[^/]+\.hdslb\.com/.*", cover_url, re.IGNORECASE):
        cover_url = ""
    return {
        "catalog_item_id": catalog_id,
        "bvid": bvid,
        "page": page,
        "title": str(item.get("title") or ""),
        "owner_name": str(item.get("owner_name") or ""),
        "cover_url": cover_url,
        "cached": bool(item.get("is_local")),
    }


def _find_active_item(snapshot: dict[str, Any], item_id: str) -> dict[str, Any]:
    candidates = [snapshot.get("current_item"), *(snapshot.get("playlist") or [])]
    for item in candidates:
        if isinstance(item, dict) and str(item.get("id") or "") == item_id:
            return item
    raise InternetRemoteDispatchError("item_not_found", "Playlist item was not found")


def _append_catalog_item(item: Any) -> None:
    try:
        append_lark_pool_entries_in_background(
            [{
                "mid": str(item.owner_mid or ""),
                "bvid": item.bvid,
                "title": item.title or item.display_title,
                "url": item.resolved_url or item.original_url,
                "owner_name": item.owner_name,
                "owner_url": item.owner_url,
                "cover_url": item.cover_url,
            }]
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
