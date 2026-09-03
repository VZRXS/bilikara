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
    """Bridge one WebRTC message into the Rust-owned Internet Remote module.

    Rust validates the envelope, authorizes the operation, applies every AppState
    mutation, and returns at most one typed Host effect. This adapter only performs
    retained Host I/O and never interprets the original remote request.
    """

    response = context.store.dispatch_internet_remote_message(
        peer_id,
        lane,
        message,
        reset_av_delay=context.cache_manager.reset_offset_on_next,
    )
    return _run_host_effect(context, peer_id, response)


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
    if kind == "catalog_song_detail":
        public_response["data"] = _catalog_detail(str(effect["catalog_item_id"]))
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
