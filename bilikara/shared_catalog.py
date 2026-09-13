from __future__ import annotations

"""Thin Host adapters to the shared Rust catalog; no Python provider policy.

The retired Feishu table selector is not a Sheets tab selector. Rust owns the
verified read-only Sheets fallback, snapshot cache and exclusion policy.
"""
import os
import sys
import urllib.parse
from typing import Any

import bilikara.config as cfg
from bilikara import rust_runtime

_CLOUDFLARE_API_URL = (os.environ.get("BILIKARA_CF_API_URL") or "https://api.kevinx96.icu").rstrip("/")
_CLOUDFLARE_SEARCH_TIMEOUT = float(os.environ.get("BILIKARA_CF_SEARCH_TIMEOUT") or "2.0")
_CLOUDFLARE_CATEGORY_TIMEOUT = float(os.environ.get("BILIKARA_CF_CATEGORY_TIMEOUT") or "8.0")
_CLOUDFLARE_PREWARM_TIMEOUT = float(os.environ.get("BILIKARA_CF_PREWARM_TIMEOUT") or "8.0")


class CatalogError(RuntimeError):
    def __init__(self, message: str, *, code: str = "catalog_unavailable", status_code: int = 503):
        super().__init__(message)
        self.code = code
        self.status_code = status_code


def _request(operation: str, *, timeout: float = 12.0, **fields: Any) -> dict:
    try:
        result = rust_runtime.shared_catalog_request(
            operation, base_url=_CLOUDFLARE_API_URL,
            user_agent=f"bilikara/{getattr(cfg, 'APP_VERSION', 'dev')} (+https://github.com/VZRXS/bilikara)",
            timeout=timeout, review_keywords=list(getattr(cfg, "GATCHA_KEYWORDS", ())), **fields,
        )
    except (rust_runtime.RustRuntimeServiceError, rust_runtime.RustRuntimeUnavailableError) as exc:
        error = getattr(exc, "response", {}).get("error", {})
        raise CatalogError(
            error.get("message") or "Shared Rust catalog unavailable", code=error.get("kind", "catalog_unavailable"),
            status_code=error.get("status_code", 503),
        ) from exc
    if not isinstance(result, dict):
        raise CatalogError("Invalid Rust catalog response", code="invalid_response")
    return result


def _items(result: dict, key: str = "items") -> list[dict]:
    items = result.get(key)
    if not isinstance(items, list) or any(not isinstance(item, dict) for item in items):
        raise CatalogError("Invalid Rust catalog items", code="invalid_response")
    return items


def read_catalog(path: str, query: str, *, timeout: float = 8.0) -> dict:
    result = _request("read", path=path, query=query, timeout=timeout)
    _items(result)
    return result


def search_catalog(query: str, *, limit: int = 80) -> list[dict]:
    return _items(read_catalog("/api/catalog/search", urllib.parse.urlencode({"q": query, "limit": limit}), timeout=_CLOUDFLARE_SEARCH_TIMEOUT))


def prewarm_cloudflare_pool() -> bool:
    try:
        read_catalog("/api/catalog/search", "q=VZRXS", timeout=_CLOUDFLARE_PREWARM_TIMEOUT)
        return True
    except CatalogError:
        return False


def browse_d1_pool(kind: str, *, letter: str = "", query: str = "", tag: str = "", locale: str = "", limit: int = 100, offset: int = 0) -> dict:
    return read_catalog("/api/d1/browse", urllib.parse.urlencode({"kind":kind,"letter":letter,"q":query,"tag":tag,"locale":locale,"limit":limit,"offset":offset}), timeout=_CLOUDFLARE_SEARCH_TIMEOUT)


def browse_d1_category_pool(tags: list[str], *, tag45s: list[str] | None = None, query: str = "", limit: int = 100, offset: int = 0) -> dict:
    return read_catalog("/api/d1/category-browse", urllib.parse.urlencode({"tag":tags,"tag45":tag45s or [],"q":query,"limit":limit,"offset":offset}, doseq=True), timeout=_CLOUDFLARE_CATEGORY_TIMEOUT)


def normalize_pool_entry(entry: dict) -> dict | None:
    result = _request("normalize_entry", entry=entry).get("entry")
    if result is not None and not isinstance(result, dict):
        raise CatalogError("Invalid Rust catalog entry", code="invalid_response")
    return result


def append_cloudflare_pool_entries(entries: list[dict]) -> dict:
    try:
        return _request("append", entries=entries, timeout=20)
    except CatalogError as exc:
        return {"attempted":len(entries), "added":0, "error":str(exc)}


def export_cloudflare_pool_records(secret: str, *, limit: int = 5000, timeout: float = 120.0) -> list[dict]:
    return _items(_request("export", secret=secret, limit=limit, timeout=timeout), "records")


def pending_cloudflare_review_items(secret: str, *, limit: int = 20, export_limit: int = 5000) -> dict:
    result = _request("pending_review", secret=secret, limit=limit, export_limit=export_limit, timeout=120)
    _items(result)
    return result


def approve_cloudflare_review_items(bvids: list[str], secret: str, *, limit: int = 20, export_limit: int = 5000) -> dict:
    result = _request("approve_review", bvids=bvids, secret=secret, limit=limit, export_limit=export_limit, timeout=120)
    _items(result)
    return result


def _mutate(action: str, **params: Any) -> dict:
    try:
        result = _request("mutate", action=action, params=params)
    except CatalogError as exc:
        return {"success":False,"error":str(exc),"status_code":exc.status_code}
    if type(result.get("success")) is not bool:
        raise CatalogError("Invalid Rust catalog operation result", code="invalid_response")
    return result


def reject_cloudflare_review_item(bvid: str, secret: str, *, record: dict | None = None, rejected_by: str = "") -> dict:
    return _mutate("reject_review", bvid=bvid, secret=secret, record=record, rejected_by=rejected_by)


def list_cloudflare_blacklist(secret: str, *, query: str = "", limit: int = 20, offset: int = 0, include_inactive: bool = False) -> dict:
    return _mutate("list_blacklist", secret=secret, query=query, limit=limit, offset=offset, include_inactive=include_inactive)


def restore_cloudflare_blacklist_item(bvid: str, secret: str, *, restore_video: bool = False, restored_by: str = "") -> dict:
    return _mutate("restore_blacklist", bvid=bvid, secret=secret, restore_video=restore_video, restored_by=restored_by)


def delete_cloudflare_pool_entry(bvid: str) -> dict:
    return _mutate("delete_invalid", bvid=bvid)


def delete_cloudflare_video_entry(bvid: str, secret: str) -> dict:
    return _mutate("delete_video", bvid=bvid, secret=secret)


def delete_cloudflare_mid_entries(mid: str, secret: str) -> dict:
    return _mutate("delete_mid", mid=mid, secret=secret)


def submit_cloudflare_song_rating(*, session_user_name: str, play_id: str, bvid: str, score: int) -> dict:
    return _mutate("rate_song", session_user_name=session_user_name, play_id=play_id, bvid=bvid, score=score)


def verify_cloudflare_bilikara_secret(secret: str) -> dict:
    return _mutate("verify_secret", secret=secret)


def trigger_cloudflare_maintenance_job(job: str, secret: str, *, requested_by: str = "") -> dict:
    return _mutate("maintenance", job=job, secret=secret, requested_by=requested_by)


def reset_cloudflare_video_tags(bvid: str, secret: str) -> dict:
    return _mutate("reset_tags", bvid=bvid, secret=secret)


def append_catalog_entries_in_background(entries: list[dict]) -> bool:
    """Best-effort indexing: True means Rust queue acceptance, not delivery."""
    normalized_entries = [dict(entry) for entry in entries if isinstance(entry, dict)]
    if not normalized_entries:
        return False
    try:
        result = rust_runtime.cloudflare_service_request(
            "enqueue_append",
            base_url=_CLOUDFLARE_API_URL,
            user_agent=f"bilikara/{getattr(cfg, 'APP_VERSION', 'dev')} (+https://github.com/VZRXS/bilikara)",
            timeout=20,
            entries=normalized_entries,
        )
        return isinstance(result, dict) and result.get("accepted") is True
    except Exception as exc:  # noqa: BLE001
        kind = (
            "runtime_unavailable"
            if isinstance(exc, rust_runtime.RustRuntimeUnavailableError)
            else "scheduling_error"
        )
        print(
            f"[bilikara:catalog] background append rejected: {kind} ({type(exc).__name__[:80]})",
            file=sys.stderr,
            flush=True,
        )
        return False
