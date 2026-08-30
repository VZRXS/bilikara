from __future__ import annotations

import json
import os
import queue
import re
import sys
import threading
import time
import urllib.parse
from pathlib import Path
from typing import Any

import bilikara.config as cfg
from bilikara import rust_runtime

APP_ID = os.environ.get("BILIKARA_LARK_APP_ID") or "cli_a97321a5a7b89bde"
APP_SECRET = os.environ.get("BILIKARA_LARK_APP_SECRET") or "tTUE3SUe57v1YTvjLQGNAd8Hm4RHyJlf"
BITABLE_TABLES = (
    ("FWDRbyK5daxV7Wsr04lc0nxhnuc", "tblsQ7K5sUo1BGLz"),
    ("FWDRbyK5daxV7Wsr04lc0nxhnuc", "tbleRSQtkN6fc4CQ"),
    ("FWDRbyK5daxV7Wsr04lc0nxhnuc", "tblyEUAEOtzDsr0U"),
    ("FWDRbyK5daxV7Wsr04lc0nxhnuc", "tblrb1xohWsmJYOX"),
    ("FWDRbyK5daxV7Wsr04lc0nxhnuc", "tblpv4h9rmd1dxbQ"),
)

_BASE_URL = "https://open.feishu.cn/open-apis"
_CLOUDFLARE_API_URL = (os.environ.get("BILIKARA_CF_API_URL") or "https://api.kevinx96.icu").rstrip("/")
_CLOUDFLARE_SEARCH_TIMEOUT = float(os.environ.get("BILIKARA_CF_SEARCH_TIMEOUT") or "2.0")
_CLOUDFLARE_CATEGORY_TIMEOUT = float(os.environ.get("BILIKARA_CF_CATEGORY_TIMEOUT") or "8.0")
_CLOUDFLARE_PREWARM_TIMEOUT = float(os.environ.get("BILIKARA_CF_PREWARM_TIMEOUT") or "8.0")
_TOKEN_LOCK = threading.RLock()
_TOKEN_VALUE = ""
_TOKEN_EXPIRES_AT = 0.0
_TABLES_LOCK = threading.RLock()
_TABLES_READY = False
_ACTIVE_TABLES: list[dict[str, Any]] = []
_TABLE_PROBED: set[int] = set()
_FIELD_TYPES_BY_TABLE: dict[tuple[str, str], dict[str, Any]] = {}
_REQUIRED_FIELD_NAMES = {"mid", "bvid", "title", "url", "owner_name", "owner_url"}
_OPTIONAL_FIELD_NAMES = {
    "cover_url",
    "played_count",
    "preserved_1",
    "tag_1",
    "tag_2",
    "tag_3",
    "tag_4",
    "tag_5",
    "tag_status",
}
_WRITE_FIELD_NAMES = _REQUIRED_FIELD_NAMES | _OPTIONAL_FIELD_NAMES
_REQUIRED_SEARCH_FIELDS = {"bvid", "title", "url"}
_DEBUG_LOGS = str(os.environ.get("BILIKARA_LARK_DEBUG") or "").strip().lower() in {"1", "true", "yes", "on"}
_INVALID_VIDEO_TITLES = {"已失效视频"}
_VALID_BVID_RE = re.compile(r"^BV[0-9A-Za-z]{10}$")


class LarkPoolError(RuntimeError):
    pass


def _post_json(url: str, payload: dict[str, Any], *, token: str | None = None, timeout: float = 12.0) -> dict:
    headers = {"Content-Type": "application/json; charset=utf-8"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    try:
        result = rust_runtime.json_http_request(
            "POST", url, headers=headers, payload=payload, timeout=timeout
        )
        if not isinstance(result, dict):
            raise LarkPoolError("Lark request returned a non-object response")
        return result
    except (rust_runtime.RustRuntimeServiceError, rust_runtime.RustRuntimeUnavailableError) as exc:
        raise LarkPoolError(f"Lark request failed: {exc}") from exc


def _get_json(url: str, *, token: str, timeout: float = 12.0) -> dict:
    try:
        result = rust_runtime.json_http_request(
            "GET", url, headers={"Authorization": f"Bearer {token}"}, timeout=timeout
        )
        if not isinstance(result, dict):
            raise LarkPoolError("Lark request returned a non-object response")
        return result
    except (rust_runtime.RustRuntimeServiceError, rust_runtime.RustRuntimeUnavailableError) as exc:
        raise LarkPoolError(f"Lark request failed: {exc}") from exc


def _cloudflare_json(method: str, path: str, payload: dict[str, Any] | None = None, *, timeout: float = 12.0) -> Any:
    url = f"{_CLOUDFLARE_API_URL}{path}"
    user_agent = f"bilikara/{getattr(cfg, 'APP_VERSION', 'dev')} (+https://github.com/VZRXS/bilikara)"
    _log_lark_debug(
        "cloudflare request",
        {"method": method.upper(), "url": url, "timeout": timeout, "payload_keys": sorted((payload or {}).keys())},
    )
    try:
        result = rust_runtime.cloudflare_service_request(
            "request",
            base_url=_CLOUDFLARE_API_URL,
            user_agent=user_agent,
            timeout=timeout,
            method=method.upper(),
            path=path,
            payload=payload,
        )
        parsed = result.get("payload")
        _log_lark_debug(
            "cloudflare response",
            {
                "url": url,
                "shape": type(parsed).__name__,
                "preview": json.dumps(parsed, ensure_ascii=False)[:500],
            },
        )
        return parsed
    except (rust_runtime.RustRuntimeServiceError, rust_runtime.RustRuntimeUnavailableError) as exc:
        response = getattr(exc, "response", {})
        error = response.get("error") if isinstance(response, dict) else {}
        _log_lark_debug(
            "cloudflare request failed",
            {
                "url": url,
                "status": error.get("status_code") if isinstance(error, dict) else None,
                "error": str(exc),
                "body": str(error.get("body_preview") or "")[:1000]
                if isinstance(error, dict)
                else "",
            },
        )
        raise LarkPoolError(f"Cloudflare request failed: {exc}") from exc


def _cloudflare_admin_get_json(path: str, secret: str, *, timeout: float = 60.0) -> Any:
    normalized_secret = str(secret or "").strip()
    if not normalized_secret:
        raise LarkPoolError("missing secret")
    url = f"{_CLOUDFLARE_API_URL}{path}"
    user_agent = f"bilikara/{getattr(cfg, 'APP_VERSION', 'dev')} (+https://github.com/VZRXS/bilikara)"
    _log_lark_debug("cloudflare admin request", {"url": url, "timeout": timeout})
    try:
        result = rust_runtime.cloudflare_service_request(
            "request",
            base_url=_CLOUDFLARE_API_URL,
            user_agent=user_agent,
            timeout=timeout,
            method="GET",
            path=path,
            authorization=f"Bearer {normalized_secret}",
        )
        return result.get("payload")
    except (rust_runtime.RustRuntimeServiceError, rust_runtime.RustRuntimeUnavailableError) as exc:
        response = getattr(exc, "response", {})
        error = response.get("error") if isinstance(response, dict) else {}
        _log_lark_debug(
            "cloudflare admin request failed",
            {
                "url": url,
                "status": error.get("status_code") if isinstance(error, dict) else None,
                "error": str(exc),
                "body": str(error.get("body_preview") or "")[:1000]
                if isinstance(error, dict)
                else "",
            },
        )
        raise LarkPoolError(f"Cloudflare request failed: {exc}") from exc


def _require_success(payload: dict, label: str) -> dict:
    if payload.get("code") != 0:
        if _DEBUG_LOGS:
            print(
                f"[bilikara:lark] {label}: {json.dumps(payload, ensure_ascii=False)}",
                file=sys.stderr,
                flush=True,
            )
        raise LarkPoolError(str(payload.get("msg") or label))
    data = payload.get("data")
    return data if isinstance(data, dict) else {}


def _log_lark_request(label: str, payload: dict[str, Any]) -> None:
    if not _DEBUG_LOGS:
        return
    print(
        f"[bilikara:lark] {label} request: {json.dumps(payload, ensure_ascii=False)}",
        file=sys.stderr,
        flush=True,
    )


def _log_lark_debug(label: str, payload: dict[str, Any]) -> None:
    if not _DEBUG_LOGS:
        return
    print(
        f"[bilikara:lark] {label}: {json.dumps(payload, ensure_ascii=False)}",
        file=sys.stderr,
        flush=True,
    )


def _tenant_access_token() -> str:
    global _TOKEN_VALUE, _TOKEN_EXPIRES_AT
    if not APP_SECRET:
        raise LarkPoolError("BILIKARA_LARK_APP_SECRET is required for direct Feishu access")
    now = time.time()
    with _TOKEN_LOCK:
        if _TOKEN_VALUE and now < _TOKEN_EXPIRES_AT - 60:
            return _TOKEN_VALUE
        payload = _post_json(
            f"{_BASE_URL}/auth/v3/tenant_access_token/internal",
            {"app_id": APP_ID, "app_secret": APP_SECRET},
            timeout=10,
        )
        if payload.get("code") != 0:
            raise LarkPoolError(str(payload.get("msg") or "tenant token failed"))
        token = str(payload.get("tenant_access_token") or "").strip()
        if not token:
            raise LarkPoolError("tenant token missing")
        try:
            expires_in = int(payload.get("expire") or 7200)
        except (TypeError, ValueError):
            expires_in = 7200
        _TOKEN_VALUE = token
        _TOKEN_EXPIRES_AT = now + max(300, expires_in)
        return token


def _records_url(app_token: str, table_id: str, suffix: str = "") -> str:
    return f"{_BASE_URL}/bitable/v1/apps/{app_token}/tables/{table_id}/records{suffix}"


def _fields_url(app_token: str, table_id: str) -> str:
    return f"{_BASE_URL}/bitable/v1/apps/{app_token}/tables/{table_id}/fields"


def _table_field_names(token: str, app_token: str, table_id: str) -> set[str]:
    query = urllib.parse.urlencode({"page_size": 100})
    data = _require_success(
        _get_json(f"{_fields_url(app_token, table_id)}?{query}", token=token, timeout=10),
        "table field probe failed",
    )
    names: set[str] = set()
    field_types: dict[str, Any] = {}
    for item in data.get("items") or []:
        if not isinstance(item, dict):
            continue
        field_name = str(item.get("field_name") or item.get("name") or "").strip()
        if field_name:
            names.add(field_name)
            field_type = item.get("type")
            if field_type is None:
                field_type = item.get("field_type")
            if field_type is not None:
                field_types[field_name] = field_type
    _FIELD_TYPES_BY_TABLE[(app_token, table_id)] = field_types
    return names


def _table_record_count(token: str, app_token: str, table_id: str) -> int:
    query = urllib.parse.urlencode({"page_size": 1})
    data = _require_success(
        _get_json(f"{_records_url(app_token, table_id)}?{query}", token=token, timeout=10),
        "table probe failed",
    )
    try:
        return int(data.get("total") or 0)
    except (TypeError, ValueError):
        return 0


def _table_payload(index: int, app_token: str, table_id: str, field_names: set[str], count: int) -> dict[str, Any]:
    return {
        "index": index,
        "app_token": app_token,
        "table_id": table_id,
        "count": count,
        "field_names": sorted(field_names),
        "field_types": dict(_FIELD_TYPES_BY_TABLE.get((app_token, table_id), {})),
        "search_enabled": index == 1 or count > 0,
    }


def _cache_active_table(table: dict[str, Any]) -> dict[str, Any]:
    global _ACTIVE_TABLES
    table_index = int(table.get("index") or 0)
    _ACTIVE_TABLES = [cached for cached in _ACTIVE_TABLES if int(cached.get("index") or 0) != table_index]
    _ACTIVE_TABLES.append(dict(table))
    _ACTIVE_TABLES.sort(key=lambda cached: int(cached.get("index") or 0))
    return dict(table)


def _cached_active_table(table_index: int) -> dict[str, Any] | None:
    for table in _ACTIVE_TABLES:
        if int(table.get("index") or 0) == table_index:
            return dict(table)
    return None


def _active_table(table_index: int) -> dict[str, Any] | None:
    global _TABLE_PROBED
    normalized_index = int(table_index)
    with _TABLES_LOCK:
        if _TABLES_READY or normalized_index in _TABLE_PROBED:
            return _cached_active_table(normalized_index)
        if normalized_index < 1 or normalized_index > len(BITABLE_TABLES):
            return None

        token = _tenant_access_token()
        app_token, table_id = BITABLE_TABLES[normalized_index - 1]
        try:
            field_names = _table_field_names(token, app_token, table_id)
            _log_lark_debug(
                "bilikara table probe fields",
                {
                    "index": normalized_index,
                    "table_id": table_id,
                    "fields": sorted(field_names),
                    "search_fields_ready": _REQUIRED_SEARCH_FIELDS.issubset(field_names),
                },
            )
            if not _REQUIRED_SEARCH_FIELDS.issubset(field_names):
                _TABLE_PROBED.add(normalized_index)
                return None
            count = _table_record_count(token, app_token, table_id)
            _log_lark_debug(
                "bilikara table probe count",
                {
                    "index": normalized_index,
                    "table_id": table_id,
                    "count": count,
                    "search_enabled": normalized_index == 1 or count > 0,
                },
            )
        except LarkPoolError:
            if normalized_index == 1:
                raise
            _log_lark_debug(
                "bilikara table probe failed",
                {"index": normalized_index, "table_id": table_id},
            )
            _TABLE_PROBED.add(normalized_index)
            return None

        _TABLE_PROBED.add(normalized_index)
        return _cache_active_table(_table_payload(normalized_index, app_token, table_id, field_names, count))


def _active_tables() -> list[dict[str, Any]]:
    global _TABLES_READY, _ACTIVE_TABLES, _TABLE_PROBED
    with _TABLES_LOCK:
        if _TABLES_READY:
            return [dict(table) for table in _ACTIVE_TABLES]
        token = _tenant_access_token()
        active: list[dict[str, Any]] = []
        for index, (app_token, table_id) in enumerate(BITABLE_TABLES, start=1):
            try:
                field_names = _table_field_names(token, app_token, table_id)
                _log_lark_debug(
                    "bilikara table probe fields",
                    {
                        "index": index,
                        "table_id": table_id,
                        "fields": sorted(field_names),
                        "search_fields_ready": _REQUIRED_SEARCH_FIELDS.issubset(field_names),
                    },
                )
                if not _REQUIRED_SEARCH_FIELDS.issubset(field_names):
                    continue
                count = _table_record_count(token, app_token, table_id)
                _log_lark_debug(
                    "bilikara table probe count",
                    {
                        "index": index,
                        "table_id": table_id,
                        "count": count,
                        "search_enabled": index == 1 or count > 0,
                    },
                )
            except LarkPoolError:
                if index == 1:
                    raise
                _log_lark_debug("bilikara table probe failed", {"index": index, "table_id": table_id})
                continue
            active.append(_table_payload(index, app_token, table_id, field_names, count))
        _ACTIVE_TABLES = active
        _TABLE_PROBED = set(range(1, len(BITABLE_TABLES) + 1))
        _TABLES_READY = True
        return [dict(table) for table in _ACTIVE_TABLES]


def _bump_table_count(index: int, delta: int) -> None:
    with _TABLES_LOCK:
        for table in _ACTIVE_TABLES:
            if table.get("index") == index:
                updated_count = int(table.get("count") or 0) + int(delta)
                table["count"] = updated_count
                table["search_enabled"] = int(table.get("index") or 0) == 1 or updated_count > 0
                return
        if 1 <= int(index) <= len(BITABLE_TABLES):
            app_token, table_id = BITABLE_TABLES[int(index) - 1]
            _ACTIVE_TABLES.append(
                {
                    "index": int(index),
                    "app_token": app_token,
                    "table_id": table_id,
                    "count": int(delta),
                    "field_names": sorted(_WRITE_FIELD_NAMES),
                    "field_types": {},
                    "search_enabled": True,
                }
            )
            _TABLE_PROBED.add(int(index))


def _field_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, list):
        parts: list[str] = []
        for item in value:
            if isinstance(item, dict):
                parts.append(str(item.get("text") or item.get("name") or item.get("link") or ""))
            else:
                parts.append(str(item or ""))
        return "".join(parts).strip()
    if isinstance(value, dict):
        return str(value.get("text") or value.get("name") or value.get("link") or "")
    return str(value)


def _record_to_item(record: dict) -> dict | None:
    fields = record.get("fields") if isinstance(record, dict) else {}
    if not isinstance(fields, dict):
        return None
    bvid = _field_text(fields.get("bvid")).strip()
    title = _field_text(fields.get("title")).strip()
    url = _field_text(fields.get("url")).strip()
    if not url and bvid:
        url = f"https://www.bilibili.com/video/{bvid}"
    if not bvid or not title or not url:
        return None
    item = {
        "mid": _field_text(fields.get("mid")).strip(),
        "bvid": bvid,
        "title": title,
        "url": url,
        "owner_name": _field_text(fields.get("owner_name")).strip(),
        "owner_url": _field_text(fields.get("owner_url")).strip(),
        "source": "bilikara",
    }
    for key in ("cover_url", "rank", "played_count", "preserved_1"):
        value = _field_text(fields.get(key)).strip()
        if value:
            item[key] = value
    return item


def _search_lark_pool_table(
    query: str,
    table: dict[str, Any],
    *,
    token: str,
    limit: int,
    seen_bvids: set[str] | None = None,
) -> list[dict]:
    normalized_query = str(query or "").strip()
    if not normalized_query:
        return []
    if table.get("search_enabled", True) is False:
        return []
    results: list[dict] = []
    seen = seen_bvids if seen_bvids is not None else set()
    payload = {
        "filter": {
            "conjunction": "and",
            "conditions": [
                {"field_name": "title", "operator": "contains", "value": [normalized_query]},
            ],
        },
    }
    _log_lark_request(f"bilikara search table {table.get('index')}", payload)
    data = _require_success(
        _post_json(_records_url(table["app_token"], table["table_id"], "/search"), payload, token=token),
        "bilikara search failed",
    )
    for record in data.get("items") or []:
        item = _record_to_item(record)
        if not item or item["bvid"] in seen:
            continue
        seen.add(item["bvid"])
        results.append(item)
        if len(results) >= max(1, int(limit)):
            return results
    return results


def search_lark_pool_table(query: str, table_index: int, *, limit: int = 80) -> list[dict]:
    normalized_query = str(query or "").strip()
    if not normalized_query:
        return []
    try:
        normalized_index = int(table_index)
    except (TypeError, ValueError):
        return []
    if not APP_SECRET:
        _log_lark_debug(
            "table search skipped without feishu secret",
            {"table": normalized_index, "query": normalized_query},
        )
        return []
    table = _active_table(normalized_index)
    if table is None:
        return []
    token = _tenant_access_token()
    return _search_lark_pool_table(normalized_query, table, token=token, limit=limit)


def _cloudflare_search_item(raw_item: Any) -> dict | None:
    if not isinstance(raw_item, dict):
        return None
    bvid = _field_text(raw_item.get("bvid")).strip()
    title = _field_text(raw_item.get("title")).strip()
    url = _field_text(raw_item.get("url")).strip()
    if not url and bvid:
        url = f"https://www.bilibili.com/video/{bvid}"
    if not bvid or not title or not url:
        return None
    item = {
        "mid": _field_text(raw_item.get("mid")).strip(),
        "bvid": bvid,
        "title": title,
        "url": url,
        "owner_name": _field_text(raw_item.get("owner_name")).strip(),
        "owner_url": _field_text(raw_item.get("owner_url")).strip(),
        "source": "cloudflare",
    }
    for key in (
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
    ):
        value = _field_text(raw_item.get(key)).strip()
        if value:
            item[key] = value
    return item


def _cloudflare_search_items(payload: Any) -> list[Any]:
    if isinstance(payload, list):
        return payload
    if not isinstance(payload, dict):
        return []
    for key in ("items", "results"):
        items = payload.get(key)
        if isinstance(items, list):
            return items
    data = payload.get("data")
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for key in ("items", "results"):
            items = data.get(key)
            if isinstance(items, list):
                return items
    return []


def _cloudflare_browse_tags(payload: Any) -> list[Any]:
    if not isinstance(payload, dict):
        return []
    tags = payload.get("tags")
    if isinstance(tags, list):
        return tags
    data = payload.get("data")
    if isinstance(data, dict) and isinstance(data.get("tags"), list):
        return data["tags"]
    return []


def _search_cloudflare_pool(query: str, *, limit: int = 80) -> list[dict] | None:
    normalized_query = str(query or "").strip()
    if not normalized_query:
        return []
    query_string = urllib.parse.urlencode({"keyword": normalized_query, "limit": max(1, int(limit))})
    try:
        payload = _cloudflare_json(
            "GET",
            f"/search?{query_string}",
            timeout=_CLOUDFLARE_SEARCH_TIMEOUT,
        )
    except LarkPoolError:
        return None
    results: list[dict] = []
    seen_bvids: set[str] = set()
    raw_items = _cloudflare_search_items(payload)
    for raw_item in raw_items:
        item = _cloudflare_search_item(raw_item)
        if not item or item["bvid"] in seen_bvids:
            continue
        seen_bvids.add(item["bvid"])
        results.append(item)
        if len(results) >= max(1, int(limit)):
            break
    _log_lark_debug(
        "cloudflare search parsed",
        {
            "query": normalized_query,
            "raw_count": len(raw_items),
            "result_count": len(results),
            "sample_bvids": [item.get("bvid") for item in results[:5]],
        },
    )
    return results


def prewarm_cloudflare_pool() -> bool:
    if not _CLOUDFLARE_API_URL:
        return False
    try:
        _cloudflare_json(
            "GET",
            "/search?keyword=VZRXS",
            timeout=_CLOUDFLARE_PREWARM_TIMEOUT,
        )
    except LarkPoolError:
        return False
    return True


def browse_d1_pool(
    kind: str,
    *,
    letter: str = "",
    query: str = "",
    tag: str = "",
    locale: str = "",
    limit: int = 100,
) -> dict:
    normalized_kind = "artist" if str(kind or "").strip().lower() == "artist" else "name"
    params = {
        "kind": normalized_kind,
        "limit": str(max(1, int(limit))),
    }
    if letter:
        params["letter"] = str(letter or "").strip().upper()
    if query:
        params["q"] = str(query or "").strip()
    if tag:
        params["tag"] = str(tag or "").strip()
    if locale:
        params["locale"] = str(locale or "").strip().lower()
    try:
        payload = _cloudflare_json(
            "GET",
            f"/browse?{urllib.parse.urlencode(params)}",
            timeout=_CLOUDFLARE_SEARCH_TIMEOUT,
        )
    except LarkPoolError:
        return {"kind": normalized_kind, "letter": letter, "query": query, "tag": tag, "locale": locale, "tags": [], "items": []}
    tags = []
    for raw_tag in _cloudflare_browse_tags(payload):
        if not isinstance(raw_tag, dict):
            continue
        tag_text = _field_text(raw_tag.get("tag")).strip()
        if not tag_text:
            continue
        tags.append(
            {
                "tag": tag_text,
                "letter": _field_text(raw_tag.get("letter")).strip(),
                "locale": _field_text(raw_tag.get("locale")).strip(),
                "yomi": _field_text(raw_tag.get("yomi")).strip(),
                "count": int(raw_tag.get("count") or 0),
            }
        )
    items: list[dict] = []
    seen_bvids: set[str] = set()
    for raw_item in _cloudflare_search_items(payload):
        item = _cloudflare_search_item(raw_item)
        if not item or item["bvid"] in seen_bvids:
            continue
        seen_bvids.add(item["bvid"])
        items.append(item)
    return {
        "kind": str(payload.get("kind") or normalized_kind) if isinstance(payload, dict) else normalized_kind,
        "letter": str(payload.get("letter") or letter) if isinstance(payload, dict) else letter,
        "query": str(payload.get("query") or query) if isinstance(payload, dict) else query,
        "tag": str(payload.get("tag") or tag) if isinstance(payload, dict) else tag,
        "locale": str(payload.get("locale") or locale) if isinstance(payload, dict) else locale,
        "tags": tags,
        "items": items,
    }


def browse_d1_category_pool(
    tags: list[str],
    *,
    tag45s: list[str] | None = None,
    query: str = "",
    limit: int = 100,
    offset: int = 0,
) -> dict:
    normalized_tags: list[str] = []
    seen_tags: set[str] = set()
    for tag in tags or []:
        normalized_tag = str(tag or "").strip()
        if not normalized_tag or normalized_tag in seen_tags:
            continue
        seen_tags.add(normalized_tag)
        normalized_tags.append(normalized_tag)
    normalized_tag45s: list[str] = []
    seen_tag45s: set[str] = set()
    for tag in tag45s or []:
        normalized_tag = str(tag or "").strip()
        if not normalized_tag or normalized_tag in seen_tag45s:
            continue
        seen_tag45s.add(normalized_tag)
        normalized_tag45s.append(normalized_tag)
    normalized_limit = max(1, min(100, int(limit)))
    normalized_offset = max(0, int(offset))
    normalized_query = str(query or "").strip()
    if not normalized_tags and not normalized_tag45s:
        return {
            "query": normalized_query,
            "tags": [],
            "tag45s": [],
            "offset": normalized_offset,
            "limit": normalized_limit,
            "items": [],
            "has_more": False,
            "next_offset": normalized_offset,
        }
    params: list[tuple[str, str]] = [
        ("limit", str(normalized_limit)),
        ("offset", str(normalized_offset)),
    ]
    if normalized_query:
        params.append(("q", normalized_query))
    params.extend(("tag", tag) for tag in normalized_tags)
    params.extend(("tag45", tag) for tag in normalized_tag45s)
    try:
        payload = _cloudflare_json(
            "GET",
            f"/browse-category?{urllib.parse.urlencode(params)}",
            timeout=_CLOUDFLARE_CATEGORY_TIMEOUT,
        )
    except (LarkPoolError, ValueError):
        return {
            "query": normalized_query,
            "tags": normalized_tags,
            "tag45s": normalized_tag45s,
            "offset": normalized_offset,
            "limit": normalized_limit,
            "items": [],
            "has_more": False,
            "next_offset": normalized_offset,
        }
    items: list[dict] = []
    seen_bvids: set[str] = set()
    for raw_item in _cloudflare_search_items(payload):
        item = _cloudflare_search_item(raw_item)
        if not item or item["bvid"] in seen_bvids:
            continue
        seen_bvids.add(item["bvid"])
        items.append(item)
    payload_dict = payload if isinstance(payload, dict) else {}
    has_more = bool(payload_dict.get("has_more")) if isinstance(payload_dict, dict) else len(items) >= normalized_limit
    try:
        next_offset = int(payload_dict.get("next_offset"))
    except (TypeError, ValueError):
        next_offset = normalized_offset + len(items)
    return {
        "query": str(payload_dict.get("query") or normalized_query),
        "tags": normalized_tags,
        "tag45s": normalized_tag45s,
        "offset": normalized_offset,
        "limit": normalized_limit,
        "items": items[:normalized_limit],
        "has_more": has_more,
        "next_offset": max(normalized_offset, next_offset),
    }


def _search_lark_pool_legacy(query: str, *, limit: int = 80) -> list[dict]:
    normalized_query = str(query or "").strip()
    if not normalized_query:
        return []
    token = _tenant_access_token()
    results: list[dict] = []
    seen_bvids: set[str] = set()
    for table in _active_tables():
        remaining = max(1, int(limit)) - len(results)
        if remaining <= 0:
            break
        results.extend(
            _search_lark_pool_table(normalized_query, table, token=token, limit=remaining, seen_bvids=seen_bvids)
        )
    return results


def search_lark_pool(query: str, *, limit: int = 80) -> list[dict]:
    normalized_query = str(query or "").strip()
    if not normalized_query:
        return []
    if _CLOUDFLARE_API_URL:
        cloudflare_results = _search_cloudflare_pool(normalized_query, limit=limit)
        if cloudflare_results is not None:
            _log_lark_debug(
                "search served by cloudflare",
                {"query": normalized_query, "count": len(cloudflare_results)},
            )
            return cloudflare_results
        _log_lark_debug("search falling back to feishu tables", {"query": normalized_query})
    return _search_lark_pool_legacy(normalized_query, limit=limit)



def normalize_pool_entry(entry: dict) -> dict | None:
    if not isinstance(entry, dict):
        return None
    bvid = str(entry.get("bvid") or "").strip()
    title = str(entry.get("title") or "").strip()
    url = str(entry.get("url") or "").strip()
    if title in _INVALID_VIDEO_TITLES:
        return None
    if not _VALID_BVID_RE.match(bvid):
        return None
    if not url and bvid:
        url = f"https://www.bilibili.com/video/{bvid}"
    if not bvid or not title or not url:
        return None
    normalized = {
        "mid": str(entry.get("mid") or entry.get("owner_mid") or "").strip(),
        "bvid": bvid,
        "title": title,
        "url": url,
        "owner_name": str(entry.get("owner_name") or entry.get("author") or "").strip(),
        "owner_url": str(entry.get("owner_url") or "").strip(),
    }
    for key in (
        "cover_url",
        "rank",
        "played_count",
        "preserved_1",
        "preserved_2",
        "preserved_3",
        "preserved_4",
        "preserved_5",
    ):
        value = entry.get(key)
        if value is not None:
            normalized[key] = str(value).strip()
    for key in ("tag_1", "tag_2", "tag_3", "tag_4", "tag_5"):
        value = entry.get(key)
        if value is not None:
            normalized[key] = str(value).strip()
    if entry.get("tag_status") is not None:
        normalized["tag_status"] = str(entry.get("tag_status")).strip()
    return normalized


def _normalize_pool_entries(entries: list[dict]) -> list[dict]:
    normalized: list[dict] = []
    seen_batch: set[str] = set()
    for entry in entries:
        normalized_entry = normalize_pool_entry(entry)
        if not normalized_entry or normalized_entry["bvid"] in seen_batch:
            continue
        seen_batch.add(normalized_entry["bvid"])
        normalized.append(normalized_entry)
    return normalized


def append_cloudflare_pool_entries(entries: list[dict]) -> dict:
    try:
        payload = rust_runtime.cloudflare_service_request(
            "append",
            base_url=_CLOUDFLARE_API_URL,
            user_agent=f"bilikara/{getattr(cfg, 'APP_VERSION', 'dev')} (+https://github.com/VZRXS/bilikara)",
            timeout=20,
            entries=entries,
        )
    except (rust_runtime.RustRuntimeServiceError, rust_runtime.RustRuntimeUnavailableError) as exc:
        return {"attempted": len(entries), "added": 0, "error": f"Cloudflare request failed: {exc}"}
    attempted = int(payload.get("attempted") or 0)
    if attempted == 0:
        return {"attempted": 0, "added": 0}
    return {
        "attempted": attempted,
        "added": int(payload.get("added") or 0),
        "updated_existing": int(payload.get("updated_existing") or 0),
        "skipped_existing": int(payload.get("skipped_existing") or 0),
        "skipped_blacklisted": int(payload.get("skipped_blacklisted") or 0),
        "feishu_queued": int(payload.get("feishu_queued") or 0),
    }


def export_cloudflare_pool_records(secret: str, *, limit: int = 5000, timeout: float = 120.0) -> list[dict]:
    try:
        normalized_limit = max(1, min(50000, int(limit)))
    except (TypeError, ValueError):
        normalized_limit = 5000
    query = urllib.parse.urlencode(
        {
            "all": "1",
            "limit": str(normalized_limit),
            "_": str(int(time.time() * 1000)),
        }
    )
    payload = _cloudflare_admin_get_json(f"/export?{query}", secret, timeout=timeout)
    if isinstance(payload, list):
        records = payload
    elif isinstance(payload, dict):
        records = _cloudflare_search_items(payload)
    else:
        records = []
    return [record for record in records if isinstance(record, dict)]


def _gatcha_keyword_matched(title: str) -> bool:
    normalized_title = str(title or "").lower()
    if not normalized_title:
        return False
    for keyword in getattr(cfg, "GATCHA_KEYWORDS", ()):
        normalized_keyword = str(keyword or "").strip().lower()
        if normalized_keyword and normalized_keyword in normalized_title:
            return True
    return False


def _is_pending_review_record(raw_item: dict) -> bool:
    item = _cloudflare_search_item(raw_item)
    if not item or _gatcha_keyword_matched(item.get("title", "")):
        return False
    preserved = _field_text(raw_item.get("preserved_3")).strip()
    return preserved in {"", "0", "0.0"}


def _pending_cloudflare_review_payload(records: list[dict], *, limit: int = 20) -> dict:
    try:
        normalized_limit = max(1, min(20, int(limit)))
    except (TypeError, ValueError):
        normalized_limit = 20
    pending_items: list[dict] = []
    seen_bvids: set[str] = set()
    for record in records:
        if not _is_pending_review_record(record):
            continue
        item = _cloudflare_search_item(record)
        if not item:
            continue
        bvid = str(item.get("bvid") or "").strip()
        if not bvid or bvid in seen_bvids:
            continue
        seen_bvids.add(bvid)
        pending_items.append(item)
    return {
        "items": pending_items[:normalized_limit],
        "total_pending": len(pending_items),
        "export_count": len(records),
    }


def pending_cloudflare_review_items(secret: str, *, limit: int = 20, export_limit: int = 5000) -> dict:
    records = export_cloudflare_pool_records(secret, limit=export_limit)
    return _pending_cloudflare_review_payload(records, limit=limit)


def approve_cloudflare_review_items(
    bvids: list[str],
    secret: str,
    *,
    limit: int = 20,
    export_limit: int = 5000,
) -> dict:
    requested: list[str] = []
    seen_requested: set[str] = set()
    for raw_bvid in bvids if isinstance(bvids, list) else []:
        bvid = str(raw_bvid or "").strip()
        if _VALID_BVID_RE.match(bvid) and bvid not in seen_requested:
            requested.append(bvid)
            seen_requested.add(bvid)
    records = export_cloudflare_pool_records(secret, limit=export_limit)
    current_items: dict[str, dict] = {}
    for record in records:
        item = _cloudflare_search_item(record)
        bvid = str(item.get("bvid") or "").strip() if item else ""
        if bvid in seen_requested:
            current_items[bvid] = item
    updates: list[dict] = []
    for bvid in requested:
        item = current_items.get(bvid)
        if not item:
            continue
        update = dict(item)
        update["preserved_3"] = "1"
        updates.append(update)
    upload = append_cloudflare_pool_entries(updates) if updates else {"attempted": 0, "added": 0}
    if upload.get("error"):
        raise LarkPoolError(str(upload.get("error") or "approval update failed"))
    refreshed_records = export_cloudflare_pool_records(secret, limit=export_limit)
    still_pending = {
        str(item.get("bvid") or "").strip()
        for item in (_cloudflare_search_item(record) for record in refreshed_records if _is_pending_review_record(record))
        if item
    }
    fallback_updates = [update for update in updates if str(update.get("bvid") or "").strip() in still_pending]
    fallback_deleted = 0
    if fallback_updates:
        for update in fallback_updates:
            delete_result = delete_cloudflare_video_entry(str(update.get("bvid") or ""), secret)
            if not delete_result.get("success"):
                raise LarkPoolError(str(delete_result.get("error") or "approval delete fallback failed"))
            fallback_deleted += 1
        fallback_upload = append_cloudflare_pool_entries(fallback_updates)
        if fallback_upload.get("error"):
            raise LarkPoolError(str(fallback_upload.get("error") or "approval fallback update failed"))
        upload["fallback_attempted"] = len(fallback_updates)
        upload["fallback_deleted"] = fallback_deleted
        upload["fallback_added"] = int(fallback_upload.get("added") or 0)
        upload["fallback_updated_existing"] = int(fallback_upload.get("updated_existing") or 0)
        refreshed_records = export_cloudflare_pool_records(secret, limit=export_limit)
    payload = _pending_cloudflare_review_payload(refreshed_records, limit=limit)
    remaining_pending = {
        str(item.get("bvid") or "").strip()
        for item in (_cloudflare_search_item(record) for record in refreshed_records if _is_pending_review_record(record))
        if item
    }
    actual_approved = sum(1 for bvid in requested if bvid in current_items and bvid not in remaining_pending)
    payload.update(
        {
            "requested": len(requested),
            "approved": actual_approved,
            "skipped_missing": max(0, len(requested) - len(updates)),
            "upload": upload,
        }
    )
    return payload


def reject_cloudflare_review_item(
    bvid: str,
    secret: str,
    *,
    record: dict | None = None,
    rejected_by: str = "",
) -> dict:
    normalized_bvid = str(bvid or "").strip()
    normalized_secret = str(secret or "").strip()
    if not _VALID_BVID_RE.match(normalized_bvid):
        return {"success": False, "bvid": normalized_bvid, "error": "invalid bvid"}
    if not normalized_secret:
        return {"success": False, "bvid": normalized_bvid, "error": "missing secret"}
    payload_body = {
        "bvid": normalized_bvid,
        "BILIKARA_ADMIN_SECRET": normalized_secret,
        "reason_code": "not_karaoke",
        "source": "pending_review",
        "rejected_by": str(rejected_by or "").strip(),
    }
    if isinstance(record, dict):
        payload_body["record"] = dict(record)
    try:
        payload = _cloudflare_json("POST", "/admin/review/reject", payload_body, timeout=15)
    except LarkPoolError as exc:
        return {"success": False, "bvid": normalized_bvid, "error": str(exc)}
    if not isinstance(payload, dict):
        return {"success": False, "bvid": normalized_bvid, "error": "Cloudflare returned an invalid payload"}
    result = dict(payload)
    result.setdefault("bvid", normalized_bvid)
    result.setdefault("error", "" if result.get("success") else "review rejection failed")
    return result


def list_cloudflare_blacklist(
    secret: str,
    *,
    query: str = "",
    limit: int = 20,
    offset: int = 0,
    include_inactive: bool = False,
) -> dict:
    normalized_secret = str(secret or "").strip()
    if not normalized_secret:
        return {"success": False, "items": [], "error": "missing secret"}
    try:
        normalized_limit = max(1, min(100, int(limit)))
    except (TypeError, ValueError):
        normalized_limit = 20
    try:
        normalized_offset = max(0, int(offset))
    except (TypeError, ValueError):
        normalized_offset = 0
    try:
        payload = _cloudflare_json(
            "POST",
            "/admin/blacklist/list",
            {
                "BILIKARA_ADMIN_SECRET": normalized_secret,
                "query": str(query or "").strip(),
                "limit": normalized_limit,
                "offset": normalized_offset,
                "include_inactive": bool(include_inactive),
            },
            timeout=20,
        )
    except LarkPoolError as exc:
        return {"success": False, "items": [], "error": str(exc)}
    if not isinstance(payload, dict):
        return {"success": False, "items": [], "error": "Cloudflare returned an invalid payload"}
    result = dict(payload)
    result.setdefault("items", [])
    result.setdefault("error", "" if result.get("success") else "blacklist query failed")
    return result


def restore_cloudflare_blacklist_item(
    bvid: str,
    secret: str,
    *,
    restore_video: bool = False,
    restored_by: str = "",
) -> dict:
    normalized_bvid = str(bvid or "").strip()
    normalized_secret = str(secret or "").strip()
    if not _VALID_BVID_RE.match(normalized_bvid):
        return {"success": False, "bvid": normalized_bvid, "error": "invalid bvid"}
    if not normalized_secret:
        return {"success": False, "bvid": normalized_bvid, "error": "missing secret"}
    try:
        payload = _cloudflare_json(
            "POST",
            "/admin/blacklist/restore",
            {
                "bvid": normalized_bvid,
                "BILIKARA_ADMIN_SECRET": normalized_secret,
                "restore_video": bool(restore_video),
                "restored_by": str(restored_by or "").strip(),
            },
            timeout=15,
        )
    except LarkPoolError as exc:
        return {"success": False, "bvid": normalized_bvid, "error": str(exc)}
    if not isinstance(payload, dict):
        return {"success": False, "bvid": normalized_bvid, "error": "Cloudflare returned an invalid payload"}
    result = dict(payload)
    result.setdefault("bvid", normalized_bvid)
    result.setdefault("error", "" if result.get("success") else "blacklist restore failed")
    return result


def delete_cloudflare_pool_entry(bvid: str) -> dict:
    normalized_bvid = str(bvid or "").strip()
    if not _VALID_BVID_RE.match(normalized_bvid):
        return {"success": False, "deleted": False, "error": "invalid bvid"}
    try:
        payload = _cloudflare_json("POST", "/delete-invalid", {"bvid": normalized_bvid}, timeout=10)
    except LarkPoolError as exc:
        return {"success": False, "bvid": normalized_bvid, "deleted": False, "error": str(exc)}
    if not isinstance(payload, dict):
        return {
            "success": False,
            "bvid": normalized_bvid,
            "deleted": False,
            "error": "Cloudflare returned an invalid payload",
        }
    return {
        "success": bool(payload.get("success")),
        "bvid": str(payload.get("bvid") or normalized_bvid),
        "found": bool(payload.get("found")),
        "deleted": bool(payload.get("deleted")),
        "feishu_queued": bool(payload.get("feishu_queued")),
        "error": str(payload.get("error") or ""),
    }


def delete_cloudflare_video_entry(bvid: str, secret: str) -> dict:
    normalized_bvid = str(bvid or "").strip()
    normalized_secret = str(secret or "").strip()
    if not _VALID_BVID_RE.match(normalized_bvid):
        return {"success": False, "bvid": normalized_bvid, "deleted": False, "error": "invalid bvid"}
    if not normalized_secret:
        return {"success": False, "bvid": normalized_bvid, "deleted": False, "error": "missing secret"}
    try:
        payload = _cloudflare_json(
            "POST",
            "/admin/delete-video",
            {"bvid": normalized_bvid, "BILIKARA_ADMIN_SECRET": normalized_secret},
            timeout=10,
        )
    except LarkPoolError as exc:
        return {"success": False, "bvid": normalized_bvid, "deleted": False, "error": str(exc)}
    if not isinstance(payload, dict):
        return {
            "success": False,
            "bvid": normalized_bvid,
            "deleted": False,
            "error": "Cloudflare returned an invalid payload",
        }
    result = dict(payload)
    result.setdefault("bvid", normalized_bvid)
    result.setdefault("deleted", False)
    result.setdefault("error", "" if result.get("success") else "delete failed")
    return result


def delete_cloudflare_mid_entries(mid: str, secret: str) -> dict:
    normalized_mid = str(mid or "").strip()
    normalized_secret = str(secret or "").strip()
    if not normalized_mid.isdigit() or int(normalized_mid) <= 0:
        return {"success": False, "mid": normalized_mid, "deleted": False, "error": "invalid mid"}
    if not normalized_secret:
        return {"success": False, "mid": normalized_mid, "deleted": False, "error": "missing secret"}
    try:
        payload = _cloudflare_json(
            "POST",
            "/admin/delete-mid",
            {"mid": normalized_mid, "BILIKARA_ADMIN_SECRET": normalized_secret},
            timeout=20,
        )
    except LarkPoolError as exc:
        return {"success": False, "mid": normalized_mid, "deleted": False, "error": str(exc)}
    if not isinstance(payload, dict):
        return {
            "success": False,
            "mid": normalized_mid,
            "deleted": False,
            "error": "Cloudflare returned an invalid payload",
        }
    result = dict(payload)
    result.setdefault("mid", normalized_mid)
    result.setdefault("deleted", False)
    result.setdefault("error", "" if result.get("success") else "delete failed")
    return result


def submit_cloudflare_song_rating(*, session_user_name: str, play_id: str, bvid: str, score: int) -> dict:
    normalized_user_name = str(session_user_name or "").strip()
    normalized_play_id = str(play_id or "").strip()
    normalized_bvid = str(bvid or "").strip()
    try:
        normalized_score = int(score)
    except (TypeError, ValueError):
        normalized_score = 0
    if not normalized_user_name:
        return {"success": False, "error": "missing session_user_name"}
    if not normalized_play_id:
        return {"success": False, "error": "missing play_id"}
    if not _VALID_BVID_RE.match(normalized_bvid):
        return {"success": False, "error": "invalid bvid"}
    if normalized_score < 1 or normalized_score > 5:
        return {"success": False, "error": "score must be between 1 and 5"}
    try:
        payload = _cloudflare_json(
            "POST",
            "/rate-song",
            {
                "session_user_name": normalized_user_name,
                "play_id": normalized_play_id,
                "bvid": normalized_bvid,
                "score": normalized_score,
            },
            timeout=10,
        )
    except LarkPoolError as exc:
        return {"success": False, "play_id": normalized_play_id, "bvid": normalized_bvid, "score": normalized_score, "error": str(exc)}
    if not isinstance(payload, dict):
        return {
            "success": False,
            "play_id": normalized_play_id,
            "bvid": normalized_bvid,
            "score": normalized_score,
            "error": "Cloudflare returned an invalid payload",
        }
    return dict(payload)


def verify_cloudflare_bilikara_secret(secret: str) -> dict:
    normalized_secret = str(secret or "").strip()
    if not normalized_secret:
        return {"success": False, "verified": False, "error": "missing secret"}
    try:
        payload = _cloudflare_json(
            "POST",
            "/admin/verify",
            {"BILIKARA_ADMIN_SECRET": normalized_secret},
            timeout=10,
        )
    except LarkPoolError as exc:
        return {"success": False, "verified": False, "error": str(exc)}
    if not isinstance(payload, dict):
        return {"success": False, "verified": False, "error": "Cloudflare returned an invalid payload"}
    verified = bool(
        payload.get("verified")
        or payload.get("valid")
        or payload.get("authorized")
        or payload.get("success")
        or payload.get("ok")
    )
    return {
        "success": verified,
        "verified": verified,
        "error": "" if verified else str(payload.get("error") or payload.get("message") or "invalid secret"),
    }


def trigger_cloudflare_maintenance_job(
    job: str,
    secret: str,
    *,
    requested_by: str = "",
) -> dict:
    normalized_job = str(job or "").strip().lower()
    paths = {
        "tagger-yomi": "/admin/jobs/tagger-yomi",
    }
    path = paths.get(normalized_job)
    normalized_secret = str(secret or "").strip()
    if path is None:
        return {"success": False, "job": normalized_job, "error": "invalid maintenance job"}
    if not normalized_secret:
        return {"success": False, "job": normalized_job, "error": "missing secret"}

    user_agent = f"bilikara/{getattr(cfg, 'APP_VERSION', 'dev')} (+https://github.com/VZRXS/bilikara)"
    try:
        response = rust_runtime.cloudflare_service_request(
            "request",
            base_url=_CLOUDFLARE_API_URL,
            user_agent=user_agent,
            timeout=15,
            method="POST",
            path=path,
            payload={"requested_by": str(requested_by or "").strip()[:120]},
            authorization=f"Bearer {normalized_secret}",
        )
    except (rust_runtime.RustRuntimeServiceError, rust_runtime.RustRuntimeUnavailableError) as exc:
        return {"success": False, "job": normalized_job, "error": str(exc)}

    payload = response.get("payload") if isinstance(response, dict) else None
    if not isinstance(payload, dict):
        return {
            "success": False,
            "job": normalized_job,
            "error": "Cloudflare returned an invalid payload",
        }
    result = dict(payload)
    result["success"] = bool(result.get("success"))
    result["job"] = normalized_job
    result.setdefault("error", "" if result["success"] else "maintenance job start failed")
    return result


def reset_cloudflare_video_tags(bvid: str, secret: str) -> dict:
    normalized_bvid = str(bvid or "").strip()
    normalized_secret = str(secret or "").strip()
    if not _VALID_BVID_RE.match(normalized_bvid):
        return {"success": False, "bvid": normalized_bvid, "error": "invalid bvid"}
    if not normalized_secret:
        return {"success": False, "bvid": normalized_bvid, "error": "missing secret"}
    try:
        payload = _cloudflare_json(
            "POST",
            "/admin/reset-tags",
            {"bvid": normalized_bvid, "BILIKARA_ADMIN_SECRET": normalized_secret},
            timeout=10,
        )
    except LarkPoolError as exc:
        return {"success": False, "bvid": normalized_bvid, "error": str(exc)}
    if not isinstance(payload, dict):
        return {"success": False, "bvid": normalized_bvid, "error": "Cloudflare returned an invalid payload"}
    result = dict(payload)
    result["success"] = bool(result.get("success"))
    result.setdefault("bvid", normalized_bvid)
    result.setdefault("error", "" if result["success"] else "reset failed")
    return result



def append_lark_pool_entries(entries: list[dict]) -> dict:
    return append_cloudflare_pool_entries(entries)


class _BackgroundAppendScheduler:
    def __init__(self, *, max_pending: int = 64) -> None:
        self._queue: queue.Queue[list[dict]] = queue.Queue(maxsize=max_pending)
        self._lock = threading.Lock()
        self._worker: threading.Thread | None = None
        self._last_saturation_log_at = float("-inf")

    @staticmethod
    def _error_text(error: object) -> str:
        return " ".join(str(error or "unknown error").split())[:300]

    @classmethod
    def _process(cls, entries: list[dict]) -> None:
        try:
            result = append_lark_pool_entries(entries)
            error = str(result.get("error") or "").strip() if isinstance(result, dict) else ""
            if error:
                print(
                    f"[bilikara:lark] background append failed for {len(entries)} item(s): {cls._error_text(error)}",
                    file=sys.stderr,
                    flush=True,
                )
        except Exception as exc:  # noqa: BLE001
            print(
                f"[bilikara:lark] background append failed for {len(entries)} item(s): {cls._error_text(exc)}",
                file=sys.stderr,
                flush=True,
            )

    def _run(self) -> None:
        while True:
            entries = self._queue.get()
            try:
                self._process(entries)
            finally:
                self._queue.task_done()

    def _ensure_worker(self) -> bool:
        with self._lock:
            if self._worker is not None and self._worker.is_alive():
                return True
            worker = threading.Thread(
                target=self._run,
                daemon=True,
                name="lark-pool-append",
            )
            try:
                worker.start()
            except Exception as exc:  # noqa: BLE001
                print(
                    f"[bilikara:lark] background append scheduling failed: {self._error_text(exc)}",
                    file=sys.stderr,
                    flush=True,
                )
                return False
            self._worker = worker
            return True

    def submit(self, entries: list[dict]) -> bool:
        if not self._ensure_worker():
            return False
        try:
            self._queue.put_nowait(entries)
            return True
        except queue.Full:
            now = time.monotonic()
            should_log = False
            with self._lock:
                if now - self._last_saturation_log_at >= 30.0:
                    self._last_saturation_log_at = now
                    should_log = True
            if should_log:
                print(
                    "[bilikara:lark] background append queue is full; dropping best-effort indexing",
                    file=sys.stderr,
                    flush=True,
                )
            return False


_BACKGROUND_APPEND_SCHEDULER = _BackgroundAppendScheduler(max_pending=64)


def append_lark_pool_entries_in_background(entries: list[dict]) -> bool:
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
        return bool(result.get("accepted"))
    except rust_runtime.RustRuntimeUnavailableError:
        try:
            return _BACKGROUND_APPEND_SCHEDULER.submit(normalized_entries)
        except Exception as exc:  # noqa: BLE001
            print(
                "[bilikara:lark] background append scheduling failed: "
                f"{_BackgroundAppendScheduler._error_text(exc)}",
                file=sys.stderr,
                flush=True,
            )
            return False
    except Exception as exc:  # noqa: BLE001
        print(
            "[bilikara:lark] background append scheduling failed: "
            f"{_BackgroundAppendScheduler._error_text(exc)}",
            file=sys.stderr,
            flush=True,
        )
        return False
