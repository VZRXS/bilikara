from __future__ import annotations

import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

import bilikara.config as cfg

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
_TOKEN_LOCK = threading.RLock()
_TOKEN_VALUE = ""
_TOKEN_EXPIRES_AT = 0.0
_TABLES_LOCK = threading.RLock()
_TABLES_READY = False
_ACTIVE_TABLES: list[dict[str, Any]] = []
_TABLE_PROBED: set[int] = set()
_FIELD_TYPES_BY_TABLE: dict[tuple[str, str], dict[str, Any]] = {}
_REQUIRED_FIELD_NAMES = {"mid", "bvid", "title", "url", "owner_name", "owner_url"}
_OPTIONAL_FIELD_NAMES = {"tag_1", "tag_2", "tag_3", "tag_4", "tag_5", "tag_status"}
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
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except (OSError, urllib.error.URLError, json.JSONDecodeError) as exc:
        raise LarkPoolError(f"Lark request failed: {exc}") from exc


def _get_json(url: str, *, token: str, timeout: float = 12.0) -> dict:
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"}, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except (OSError, urllib.error.URLError, json.JSONDecodeError) as exc:
        raise LarkPoolError(f"Lark request failed: {exc}") from exc


def _cloudflare_json(method: str, path: str, payload: dict[str, Any] | None = None, *, timeout: float = 12.0) -> Any:
    url = f"{_CLOUDFLARE_API_URL}{path}"
    headers = {
        "Accept": "application/json",
        "User-Agent": f"bilikara/{getattr(cfg, 'APP_VERSION', 'dev')} (+https://github.com/VZRXS/bilikara)",
    }
    data = None
    if payload is not None:
        headers["Content-Type"] = "application/json; charset=utf-8"
        data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=data, headers=headers, method=method.upper())
    _log_lark_debug(
        "cloudflare request",
        {"method": method.upper(), "url": url, "timeout": timeout, "payload_keys": sorted((payload or {}).keys())},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw_body = response.read().decode("utf-8")
            parsed = json.loads(raw_body)
            _log_lark_debug(
                "cloudflare response",
                {
                    "status": getattr(response, "status", None),
                    "url": url,
                    "shape": type(parsed).__name__,
                    "preview": raw_body[:500],
                },
            )
            return parsed
    except urllib.error.HTTPError as exc:
        try:
            error_body = exc.read().decode("utf-8", errors="replace")
        except Exception:
            error_body = ""
        _log_lark_debug(
            "cloudflare request failed",
            {
                "url": url,
                "status": exc.code,
                "error": str(exc),
                "body": error_body[:1000],
            },
        )
        raise LarkPoolError(f"Cloudflare request failed: {exc}") from exc
    except (OSError, urllib.error.URLError, json.JSONDecodeError) as exc:
        _log_lark_debug("cloudflare request failed", {"url": url, "error": str(exc)})
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
    return {
        "mid": _field_text(fields.get("mid")).strip(),
        "bvid": bvid,
        "title": title,
        "url": url,
        "owner_name": _field_text(fields.get("owner_name")).strip(),
        "owner_url": _field_text(fields.get("owner_url")).strip(),
        "source": "bilikara",
    }


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
    return {
        "mid": _field_text(raw_item.get("mid")).strip(),
        "bvid": bvid,
        "title": title,
        "url": url,
        "owner_name": _field_text(raw_item.get("owner_name")).strip(),
        "owner_url": _field_text(raw_item.get("owner_url")).strip(),
        "source": "cloudflare",
    }


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
    normalized = _normalize_pool_entries(entries)
    if not normalized:
        return {"attempted": 0, "added": 0}
    try:
        payload = _cloudflare_json("POST", "/batch-add", {"records": normalized}, timeout=20)
    except LarkPoolError as exc:
        return {"attempted": len(normalized), "added": 0, "error": str(exc)}
    if not isinstance(payload, dict):
        return {"attempted": len(normalized), "added": 0, "error": "Cloudflare returned an invalid payload"}
    return {
        "attempted": int(payload.get("attempted") or len(normalized)),
        "added": int(payload.get("added") or 0),
        "skipped_existing": int(payload.get("skipped_existing") or 0),
        "feishu_queued": int(payload.get("feishu_queued") or 0),
    }


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



def append_lark_pool_entries(entries: list[dict]) -> dict:
    return append_cloudflare_pool_entries(entries)


def append_lark_pool_entries_in_background(entries: list[dict]) -> None:
    normalized_entries = [entry for entry in entries if isinstance(entry, dict)]
    if not normalized_entries:
        return

    def _worker() -> None:
        try:
            append_lark_pool_entries(normalized_entries)
        except Exception:
            pass

    threading.Thread(target=_worker, daemon=True, name="lark-pool-append").start()
