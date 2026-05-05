from __future__ import annotations

import json
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

import bilikara.config as cfg

APP_ID = "cli_a97321a5a7b89bde"
APP_SECRET = "tTUE3SUe57v1YTvjLQGNAd8Hm4RHyJlf"
BITABLE_TABLES = (
    ("FWDRbyK5daxV7Wsr04lc0nxhnuc", "tblsQ7K5sUo1BGLz"),
    ("NxoQblT9TamM77sOcU5cAtMznnc", "tblxBaiTH7h1EoX0"),
    ("Khdqb1bcDau0EqsryUNcbgNUnVc", "tblDVME8pevjWBJD"),
    ("ONWQbyZZRaArhusSFEccF9F0n1g", "tblaGCllQB0QLWa0"),
    ("VBUJbUzJBaI9LOs43sJcnbwDnU5", "tbl3Z8VKPhOTr7Ka"),
)

_BASE_URL = "https://open.feishu.cn/open-apis"
_TABLE_LIMIT = 20_000
_APPEND_CHUNK_SIZE = 400
_SYNC_FILE = cfg.DATA_DIR / "lark_pool_sync.json"
_TOKEN_LOCK = threading.RLock()
_TOKEN_VALUE = ""
_TOKEN_EXPIRES_AT = 0.0
_TABLES_LOCK = threading.RLock()
_TABLES_READY = False
_ACTIVE_TABLES: list[dict[str, Any]] = []
_SYNC_LOCK = threading.RLock()
_REQUIRED_FIELD_NAMES = {"mid", "bvid", "title", "url", "owner_name", "owner_url"}
_REQUIRED_SEARCH_FIELDS = {"bvid", "title", "url"}
_DEBUG_LOGS = False


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


def _tenant_access_token() -> str:
    global _TOKEN_VALUE, _TOKEN_EXPIRES_AT
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
    for item in data.get("items") or []:
        if not isinstance(item, dict):
            continue
        field_name = str(item.get("field_name") or item.get("name") or "").strip()
        if field_name:
            names.add(field_name)
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


def _active_tables() -> list[dict[str, Any]]:
    global _TABLES_READY, _ACTIVE_TABLES
    with _TABLES_LOCK:
        if _TABLES_READY:
            return [dict(table) for table in _ACTIVE_TABLES]
        token = _tenant_access_token()
        active: list[dict[str, Any]] = []
        for index, (app_token, table_id) in enumerate(BITABLE_TABLES, start=1):
            try:
                field_names = _table_field_names(token, app_token, table_id)
                if not _REQUIRED_SEARCH_FIELDS.issubset(field_names):
                    continue
                count = _table_record_count(token, app_token, table_id)
            except LarkPoolError:
                if index == 1:
                    raise
                continue
            active.append(
                {
                    "index": index,
                    "app_token": app_token,
                    "table_id": table_id,
                    "count": count,
                    "field_names": sorted(field_names),
                    "search_enabled": index == 1 or count > 1,
                }
            )
        _ACTIVE_TABLES = active
        _TABLES_READY = True
        return [dict(table) for table in _ACTIVE_TABLES]


def _bump_table_count(index: int, delta: int) -> None:
    with _TABLES_LOCK:
        for table in _ACTIVE_TABLES:
            if table.get("index") == index:
                updated_count = int(table.get("count") or 0) + int(delta)
                table["count"] = updated_count
                table["search_enabled"] = int(table.get("index") or 0) == 1 or updated_count > 1
                break


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


def search_lark_pool(query: str, *, limit: int = 30) -> list[dict]:
    normalized_query = str(query or "").strip()
    if not normalized_query:
        return []
    token = _tenant_access_token()
    results: list[dict] = []
    seen_bvids: set[str] = set()
    for table in _active_tables():
        if table.get("search_enabled", True) is False:
            continue
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
            if not item or item["bvid"] in seen_bvids:
                continue
            seen_bvids.add(item["bvid"])
            results.append(item)
            if len(results) >= max(1, int(limit)):
                return results
    return results


def _load_synced_bvids() -> set[str]:
    try:
        payload = json.loads(_SYNC_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return set()
    bvids = payload.get("bvids") if isinstance(payload, dict) else []
    return {str(bvid).strip() for bvid in bvids if str(bvid).strip()}


def _save_synced_bvids(bvids: set[str]) -> None:
    cfg.DATA_DIR.mkdir(parents=True, exist_ok=True)
    payload = {"schema_version": 1, "bvids": sorted(bvids), "updated_at": time.time()}
    temp_path = Path(str(_SYNC_FILE) + ".tmp")
    temp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temp_path.replace(_SYNC_FILE)


def normalize_pool_entry(entry: dict) -> dict | None:
    if not isinstance(entry, dict):
        return None
    bvid = str(entry.get("bvid") or "").strip()
    title = str(entry.get("title") or "").strip()
    url = str(entry.get("url") or "").strip()
    if not url and bvid:
        url = f"https://www.bilibili.com/video/{bvid}"
    if not bvid or not title or not url:
        return None
    return {
        "mid": str(entry.get("mid") or entry.get("owner_mid") or "").strip(),
        "bvid": bvid,
        "title": title,
        "url": url,
        "owner_name": str(entry.get("owner_name") or entry.get("author") or "").strip(),
        "owner_url": str(entry.get("owner_url") or "").strip(),
    }


def append_lark_pool_entries(entries: list[dict]) -> dict:
    normalized: list[dict] = []
    seen_batch: set[str] = set()
    for entry in entries:
        normalized_entry = normalize_pool_entry(entry)
        if not normalized_entry or normalized_entry["bvid"] in seen_batch:
            continue
        seen_batch.add(normalized_entry["bvid"])
        normalized.append(normalized_entry)
    if not normalized:
        return {"attempted": 0, "added": 0}

    with _SYNC_LOCK:
        synced_bvids = _load_synced_bvids()
        pending = [entry for entry in normalized if entry["bvid"] not in synced_bvids]
        if not pending:
            return {"attempted": len(normalized), "added": 0}
        token = _tenant_access_token()
        added = 0
        cursor = 0
        for table in _active_tables():
            capacity = max(0, _TABLE_LIMIT - int(table.get("count") or 0))
            if capacity <= 0:
                continue
            field_names = set(table.get("field_names") or _REQUIRED_FIELD_NAMES)
            while cursor < len(pending) and capacity > 0:
                chunk = pending[cursor : cursor + min(_APPEND_CHUNK_SIZE, capacity)]
                records = [
                    {"fields": {key: value for key, value in entry.items() if key in field_names}}
                    for entry in chunk
                ]
                _log_lark_request("bilikara pool append", {"records": records})
                _require_success(
                    _post_json(
                        _records_url(table["app_token"], table["table_id"], "/batch_create"),
                        {"records": records},
                        token=token,
                        timeout=20,
                    ),
                    "bilikara pool append failed",
                )
                cursor += len(chunk)
                capacity -= len(chunk)
                added += len(chunk)
                synced_bvids.update(entry["bvid"] for entry in chunk)
                _bump_table_count(int(table["index"]), len(chunk))
                _save_synced_bvids(synced_bvids)
            if cursor >= len(pending):
                break
        return {"attempted": len(normalized), "added": added}


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
