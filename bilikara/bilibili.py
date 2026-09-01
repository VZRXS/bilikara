from __future__ import annotations

import json
import math
import os
import sys
import threading
import re
import urllib.parse
import urllib.request
import uuid
import re
import random
import hashlib
import time
from .config import BILIBILI_HEADERS, GATCHA_KEYWORDS
from dataclasses import dataclass
from .models import PlaylistItem
from . import rust_backend, rust_runtime
import bilikara.config as cfg  
from .lark_pool_client import append_lark_pool_entries_in_background

VIDEO_PATH_RE = re.compile(r"/video/(?P<vid>(BV[0-9A-Za-z]+|av\d+))", re.IGNORECASE)
BV_RE = re.compile(r"^(BV[0-9A-Za-z]+)$", re.IGNORECASE)
AV_RE = re.compile(r"^(av\d+)$", re.IGNORECASE)
SPACE_UID_RE = re.compile(
    r"^(?:https?://)?space\.bilibili\.com/(?P<uid>\d+)(?:[/?#].*)?$",
    re.IGNORECASE,
)
SHORT_HOSTS = {"b23.tv", "bili2233.cn"}
DURATION_TOLERANCE_SECONDS = 3
WBI_MIXIN_TABLE = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
    33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
    61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
    36, 20, 34, 44, 52
]
_WBI_CACHE = {
    "keys": None,
    "last_update": 0
}
_GATCHA_PROFILE_CACHE: dict[str, tuple[float, dict]] = {}
_GATCHA_PROFILE_CACHE_LOCK = threading.Lock()
_GATCHA_CACHE_LOCK = threading.Lock()
_GATCHA_UIDS_LOCK = threading.Lock()
_GATCHA_REQUEST_LOCK = threading.Lock()
_GATCHA_LAST_REQUEST_AT = 0.0
_GATCHA_CACHE_FILE = cfg.DATA_DIR / "gatcha_cache.json"
_GATCHA_UIDS_FILE = cfg.DATA_DIR / "gatcha_uids.json"
_GATCHA_FAVLIST_FILE = cfg.DATA_DIR / "gatcha_favlist.json"
_GATCHA_CACHE_TEMP_FILE = cfg.DATA_DIR / "gatcha_cache_temp.json"
_GATCHA_UIDS_TEMP_FILE = cfg.DATA_DIR / "gatcha_uids_temp.json"
_GATCHA_FAVLIST_TEMP_FILE = cfg.DATA_DIR / "gatcha_favlist_temp.json"
_GATCHA_REBUILD_PROGRESS_FILE = cfg.DATA_DIR / "gatcha_rebuild_progress.json"
_GATCHA_UIDS_SCHEMA_VERSION = 2
_GATCHA_CACHE_SCHEMA_VERSION = 3
_GATCHA_FAVLIST_SCHEMA_VERSION = 2
_GATCHA_FAVLIST_LOCK = threading.Lock()
_GATCHA_FAVLIST_REQUEST_LOCK = threading.Lock()
_GATCHA_FAVLIST_LAST_REQUEST_AT = 0.0
_GATCHA_FAVLIST_TITLE_KEYWORDS = ("🎤", "卡拉", "k")
_GATCHA_POOL_CONFIG_FILE = cfg.DATA_DIR / "gatcha_pool_config.json"
_GATCHA_POOL_CONFIG_LOCK = threading.RLock()
_GATCHA_POOL_CONFIG_SCHEMA_VERSION = 1
GATCHA_RETRY_DELAY_SECONDS = 5
GATCHA_FAVLIST_RETRY_DELAY_SECONDS = 3
GATCHA_PROFILE_CACHE_TTL_SECONDS = 300
GATCHA_TASK_BUSY_MESSAGE = "拉取任务执行中，请等待任务结束"
MISSING_BILIBILI_COOKIE_MESSAGE = "请登录 Bilibili 账号或输入 Cookie"
_COOKIE_REQUIRED_KEYS = {"sessdata", "bili_jct"}
_COOKIE_PREFERRED_ORDER = (
    "SESSDATA",
    "bili_jct",
    "DedeUserID",
    "DedeUserID__ckMd5",
    "sid",
    "buvid3",
    "buvid4",
    "b_nut",
    "bili_ticket",
    "bili_ticket_expires",
    "CURRENT_FNVAL",
    "CURRENT_QUALITY",
)


def _rust_gatcha_repository(operation: str, **fields: object) -> dict:
    fields.setdefault("default_uids", _default_gatcha_uids())
    try:
        return rust_runtime.gatcha_repository_request(
            operation,
            uid_file=_GATCHA_UIDS_FILE,
            cache_file=_GATCHA_CACHE_FILE,
            favlist_file=_GATCHA_FAVLIST_FILE,
            pool_config_file=_GATCHA_POOL_CONFIG_FILE,
            **fields,
        )
    except rust_runtime.RustRuntimeUnavailableError:
        raise
    except rust_runtime.RustRuntimeServiceError as exc:
        raise BilibiliError(str(exc)) from exc


def _rust_gatcha_network(operation: str, **fields: object) -> dict:
    headers = dict(BILIBILI_HEADERS or {})
    return _rust_gatcha_repository(
        operation,
        cookie=effective_bilibili_cookie(),
        user_agent=str(headers.get("User-Agent") or headers.get("user-agent") or "Mozilla/5.0"),
        referer=str(headers.get("Referer") or headers.get("referer") or "https://www.bilibili.com/"),
        timeout_ms=20_000,
        **fields,
    )


def _cookie_pair_name(name: object) -> str:
    normalized = str(name or "").strip()
    if normalized.lower() == "sessdata":
        return "SESSDATA"
    if normalized.lower() == "bili_jct":
        return "bili_jct"
    return normalized


def _collect_cookie_pairs(payload: object, pairs: dict[str, str]) -> None:
    if isinstance(payload, dict):
        lower_keys = {str(key).lower(): key for key in payload}
        if "name" in lower_keys and "value" in lower_keys:
            name = _cookie_pair_name(payload.get(lower_keys["name"]))
            value = str(payload.get(lower_keys["value"]) or "").strip()
            if name and value:
                pairs[name] = value
        for key, value in payload.items():
            name = _cookie_pair_name(key)
            if name and isinstance(value, (str, int, float)) and name.lower() in {
                preferred.lower() for preferred in _COOKIE_PREFERRED_ORDER
            }:
                normalized_value = str(value or "").strip()
                if normalized_value:
                    pairs[name] = normalized_value
            _collect_cookie_pairs(value, pairs)
        return

    if isinstance(payload, list):
        for item in payload:
            _collect_cookie_pairs(item, pairs)
        return

    if isinstance(payload, str):
        for match in re.finditer(r"([A-Za-z0-9_]+)=([^;\s]+)", payload):
            name = _cookie_pair_name(match.group(1))
            value = match.group(2).strip()
            if name and value:
                pairs[name] = value


def _format_cookie_pairs(pairs: dict[str, str]) -> str:
    normalized_keys = {key.lower() for key in pairs}
    if not _COOKIE_REQUIRED_KEYS.issubset(normalized_keys):
        return ""

    ordered_names: list[str] = []
    for preferred in _COOKIE_PREFERRED_ORDER:
        for key in pairs:
            if key.lower() == preferred.lower() and key not in ordered_names:
                ordered_names.append(key)
                break
    ordered_names.extend(sorted(key for key in pairs if key not in ordered_names))
    return "; ".join(f"{name}={pairs[name]}" for name in ordered_names)


def cookie_from_bbdown_data(data_path: Path | None = None) -> str:
    data_path = data_path or (cfg.BB_DOWN_DIR / "BBDown.data")
    if not data_path.exists():
        return ""

    try:
        raw_text = data_path.read_text(encoding="utf-8-sig", errors="replace")
    except OSError:
        return ""

    pairs: dict[str, str] = {}
    try:
        payload = json.loads(raw_text)
    except json.JSONDecodeError:
        payload = raw_text
    _collect_cookie_pairs(payload, pairs)
    return _format_cookie_pairs(pairs)


def effective_bilibili_cookie() -> str:
    return cookie_from_bbdown_data() or str(cfg.COOKIE or "").strip()


def _normalize_gatcha_uid(raw_mid: object) -> str:
    text = str(raw_mid or "").strip()
    if not text:
        raise BilibiliError("UID 不能为空")

    if text.isdigit():
        uid = text
    else:
        match = SPACE_UID_RE.match(text)
        if not match:
            lower_text = text.lower()
            if BV_RE.match(text) or AV_RE.match(text) or "/video/" in lower_text:
                raise BilibiliError("请输入 Bilibili UID 或 UP 主空间链接，不要输入 BV/av 视频号")
            raise BilibiliError("请输入纯数字 UID 或 UP 主空间链接")
        uid = match.group("uid")

    uid = uid.lstrip("0") or "0"
    if not uid.isdigit() or int(uid) <= 0:
        raise BilibiliError("Bilibili UID 必须是正整数")
    return uid


def _normalize_gatcha_uid_list(raw_uids: object) -> list[str]:
    if not isinstance(raw_uids, list):
        return []
    normalized: list[str] = []
    seen: set[str] = set()
    for raw_mid in raw_uids:
        try:
            mid = _normalize_gatcha_uid(raw_mid)
        except BilibiliError:
            continue
        if mid in seen:
            continue
        seen.add(mid)
        normalized.append(mid)
    return normalized


def _default_gatcha_uids() -> list[str]:
    return _normalize_gatcha_uid_list(getattr(cfg, "GATCHA_UIDS", []))


def _read_json_file(path) -> object | None:
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError):
        return None


def _write_json_file(path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    with temp_path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
    for attempt in range(6):
        try:
            temp_path.replace(path)
            return
        except PermissionError:
            if attempt >= 5:
                raise
            time.sleep(0.08 * (attempt + 1))
    temp_path.replace(path)


def _save_gatcha_uid_payload(uid_payload: dict) -> None:
    uid_payload["schema_version"] = _GATCHA_UIDS_SCHEMA_VERSION
    _write_json_file(_GATCHA_UIDS_FILE, uid_payload)


def _set_gatcha_task_status(
    status: str,
    *,
    message: str = "",
    error: str = "",
    result: dict | None = None,
    blocking: bool = True,
) -> None:
    rust_runtime.set_gatcha_task_status(
        status,
        message=message,
        error=error,
        result=result,
        blocking=blocking,
        busy_message=GATCHA_TASK_BUSY_MESSAGE,
    )


def gatcha_task_snapshot() -> dict:
    return rust_runtime.gatcha_task_snapshot()


def _normalize_gatcha_profile(raw_uid: object, raw_profile: object) -> dict | None:
    try:
        uid = _normalize_gatcha_uid(raw_uid)
    except BilibiliError:
        return None
    if not isinstance(raw_profile, dict):
        return None
    name = str(raw_profile.get("name") or "").strip()
    if not name:
        return None
    profile = {
        "uid": uid,
        "name": name,
        "space_url": str(raw_profile.get("space_url") or f"https://space.bilibili.com/{uid}"),
    }
    avatar_url = str(
        raw_profile.get("avatar_url")
        or raw_profile.get("face")
        or raw_profile.get("avatar")
        or ""
    ).strip()
    if avatar_url:
        profile["avatar_url"] = avatar_url
    return profile


def _normalize_gatcha_profiles(raw_profiles: object) -> dict[str, dict]:
    profiles: dict[str, dict] = {}
    if not isinstance(raw_profiles, dict):
        return profiles
    for raw_uid, raw_profile in raw_profiles.items():
        profile = _normalize_gatcha_profile(raw_uid, raw_profile)
        if profile is None:
            continue
        profiles[str(profile["uid"])] = profile
    return profiles


def _load_gatcha_uid_payload() -> dict:
    if not _GATCHA_UIDS_FILE.exists():
        payload = {
            "schema_version": _GATCHA_UIDS_SCHEMA_VERSION,
            "uids": _default_gatcha_uids(),
            "profiles": {},
            "updated_at": time.time(),
        }
        _save_gatcha_uid_payload(payload)
        return payload

    payload = _read_json_file(_GATCHA_UIDS_FILE)
    if payload is None:
        payload = {
            "schema_version": _GATCHA_UIDS_SCHEMA_VERSION,
            "uids": _default_gatcha_uids(),
            "profiles": {},
            "updated_at": time.time(),
        }
        _save_gatcha_uid_payload(payload)
        return payload

    if isinstance(payload, list):
        normalized_payload = {
            "schema_version": _GATCHA_UIDS_SCHEMA_VERSION,
            "uids": _normalize_gatcha_uid_list(payload),
            "profiles": {},
            "updated_at": time.time(),
        }
        _save_gatcha_uid_payload(normalized_payload)
        return normalized_payload

    if not isinstance(payload, dict):
        payload = {
            "schema_version": _GATCHA_UIDS_SCHEMA_VERSION,
            "uids": _default_gatcha_uids(),
            "profiles": {},
            "updated_at": time.time(),
        }
        _save_gatcha_uid_payload(payload)
        return payload

    profiles = _normalize_gatcha_profiles(payload.get("profiles"))

    return {
        "schema_version": _GATCHA_UIDS_SCHEMA_VERSION,
        "uids": _normalize_gatcha_uid_list(payload.get("uids")),
        "profiles": profiles,
        "updated_at": float(payload.get("updated_at") or 0),
    }


def gatcha_uid_snapshot() -> dict:
    return _rust_gatcha_repository(
        "uid_snapshot",
        default_uids=_default_gatcha_uids(),
    )


def _configured_gatcha_uids() -> list[str]:
    return gatcha_uid_snapshot()["uids"]


def _default_gatcha_pool_config() -> dict:
    return {
        "schema_version": _GATCHA_POOL_CONFIG_SCHEMA_VERSION,
        "uid_weight": 50,
        "favlist_weight": 50,
        "excluded_uids": [],
        "excluded_favlist_folders": [],
        "updated_at": 0.0,
    }


def _load_gatcha_pool_config() -> dict:
    if not _GATCHA_POOL_CONFIG_FILE.exists():
        return _default_gatcha_pool_config()
    payload = _read_json_file(_GATCHA_POOL_CONFIG_FILE)
    if not isinstance(payload, dict):
        return _default_gatcha_pool_config()
    uid_weight = payload.get("uid_weight")
    favlist_weight = payload.get("favlist_weight")
    try:
        uid_weight = max(0, min(100, int(uid_weight)))
    except (TypeError, ValueError):
        uid_weight = 50
    try:
        favlist_weight = max(0, min(100, int(favlist_weight)))
    except (TypeError, ValueError):
        favlist_weight = 50
    excluded_uids = payload.get("excluded_uids")
    if not isinstance(excluded_uids, list):
        excluded_uids = []
    excluded_uids = [str(uid).strip() for uid in excluded_uids if str(uid).strip()]
    excluded_favlist_folders = payload.get("excluded_favlist_folders")
    if not isinstance(excluded_favlist_folders, list):
        excluded_favlist_folders = []
    excluded_favlist_folders = [str(fid).strip() for fid in excluded_favlist_folders if str(fid).strip()]
    return {
        "schema_version": _GATCHA_POOL_CONFIG_SCHEMA_VERSION,
        "uid_weight": uid_weight,
        "favlist_weight": favlist_weight,
        "excluded_uids": excluded_uids,
        "excluded_favlist_folders": excluded_favlist_folders,
        "updated_at": float(payload.get("updated_at") or 0),
    }


def _save_gatcha_pool_config(config: dict) -> None:
    config["schema_version"] = _GATCHA_POOL_CONFIG_SCHEMA_VERSION
    _write_json_file(_GATCHA_POOL_CONFIG_FILE, config)


def gatcha_pool_config_snapshot() -> dict:
    return _rust_gatcha_repository("pool_config_snapshot")


def gatcha_pool_config_detail() -> dict:
    config = gatcha_pool_config_snapshot()
    try:
        uid_options = browse_gatcha_cache().get("owners") or []
    except Exception:  # noqa: BLE001
        uid_options = []
    try:
        favlist_options = browse_gatcha_favlist().get("folders") or []
    except Exception:  # noqa: BLE001
        favlist_options = []
    return {
        **config,
        "uid_options": uid_options if isinstance(uid_options, list) else [],
        "favlist_folder_options": favlist_options if isinstance(favlist_options, list) else [],
    }


def update_gatcha_pool_config(
    *,
    uid_weight: int | None = None,
    favlist_weight: int | None = None,
    excluded_uids: list[str] | None = None,
    excluded_favlist_folders: list[str] | None = None,
) -> dict:
    if excluded_uids is not None and not isinstance(excluded_uids, list):
        raise ValueError("excluded_uids must be a list")
    if excluded_favlist_folders is not None and not isinstance(excluded_favlist_folders, list):
        raise ValueError("excluded_favlist_folders must be a list")
    fields: dict[str, object] = {}
    if uid_weight is not None:
        fields["uid_weight"] = int(uid_weight)
    if favlist_weight is not None:
        fields["favlist_weight"] = int(favlist_weight)
    if excluded_uids is not None:
        fields["excluded_uids"] = list(excluded_uids)
    if excluded_favlist_folders is not None:
        fields["excluded_favlist_folders"] = list(excluded_favlist_folders)
    return _rust_gatcha_repository("pool_config_update", **fields)


@dataclass
class VideoReference:
    original_url: str
    resolved_url: str
    bvid: str = ""
    aid: int = 0
    page: int = 1


@dataclass(frozen=True)
class VideoPage:
    page: int
    cid: int
    duration: int
    part: str


@dataclass(frozen=True)
class AudioBindingDecision:
    mode: str
    selected_indices: tuple[int, ...]
    automatic_video_index: int | None


class BilibiliError(RuntimeError):
    pass


class ManualBindingRequiredError(BilibiliError):
    def __init__(self, *, title: str, pages: list[VideoPage], preferred_page: int) -> None:
        self.title = title
        self.pages = list(pages)
        self.preferred_page = preferred_page
        super().__init__("该视频包含多个分P，请先选择视频和音频绑定关系")


def _empty_gatcha_cache_payload() -> dict:
    return {"schema_version": _GATCHA_CACHE_SCHEMA_VERSION, "uids": {}, "profiles": {}, "updated_at": 0}


def _is_legacy_gatcha_cache_payload(payload: object) -> bool:
    if not isinstance(payload, dict):
        return False
    if not isinstance(payload.get("uids"), dict):
        return False
    if "profiles" not in payload:
        return True
    if not isinstance(payload.get("profiles"), dict):
        return True
    return False


def _clear_legacy_gatcha_cache_file() -> None:
    try:
        _GATCHA_CACHE_FILE.unlink(missing_ok=True)
    except OSError:
        return


def _load_gatcha_cache(*, reset_legacy: bool = False) -> dict:
    if not _GATCHA_CACHE_FILE.exists():
        return _empty_gatcha_cache_payload()
    try:
        with _GATCHA_CACHE_FILE.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return _empty_gatcha_cache_payload()

    if not isinstance(payload, dict):
        return _empty_gatcha_cache_payload()
    if reset_legacy and _is_legacy_gatcha_cache_payload(payload):
        _clear_legacy_gatcha_cache_file()
        return _empty_gatcha_cache_payload()
    uids = payload.get("uids")
    if not isinstance(uids, dict):
        uids = {}
    profiles = _normalize_gatcha_profiles(payload.get("profiles"))
    return {
        "schema_version": _GATCHA_CACHE_SCHEMA_VERSION,
        "uids": uids,
        "profiles": profiles,
        "updated_at": float(payload.get("updated_at") or 0),
    }


def _save_gatcha_cache(cache_payload: dict) -> None:
    cache_payload["schema_version"] = _GATCHA_CACHE_SCHEMA_VERSION
    _write_json_file(_GATCHA_CACHE_FILE, cache_payload)


def _save_gatcha_cache_uid(cache_payload: dict, mid: str) -> None:
    current_payload = _load_gatcha_cache(reset_legacy=False)
    current_uids = current_payload.get("uids") if isinstance(current_payload, dict) else {}
    if not isinstance(current_uids, dict):
        current_uids = {}
    payload_uids = cache_payload.get("uids") if isinstance(cache_payload, dict) else {}
    if not isinstance(payload_uids, dict):
        payload_uids = {}

    current_profiles = current_payload.get("profiles") if isinstance(current_payload, dict) else {}
    if not isinstance(current_profiles, dict):
        current_profiles = {}
    payload_profiles = cache_payload.get("profiles") if isinstance(cache_payload, dict) else {}
    if not isinstance(payload_profiles, dict):
        payload_profiles = {}

    merged_uids = dict(current_uids)
    normalized_mid = str(mid)
    merged_uids[normalized_mid] = _dedupe_gatcha_entries(payload_uids.get(normalized_mid, []))

    merged_profiles = {str(uid): dict(profile) for uid, profile in current_profiles.items() if isinstance(profile, dict)}
    for uid, profile in payload_profiles.items():
        uid_key = str(uid)
        if uid_key == normalized_mid or uid_key not in merged_profiles:
            merged_profiles[uid_key] = dict(profile) if isinstance(profile, dict) else profile

    try:
        updated_at = max(float(current_payload.get("updated_at") or 0), float(cache_payload.get("updated_at") or 0))
    except (TypeError, ValueError):
        updated_at = time.time()
    _save_gatcha_cache(
        {
            "schema_version": _GATCHA_CACHE_SCHEMA_VERSION,
            "uids": merged_uids,
            "profiles": merged_profiles,
            "updated_at": updated_at,
        }
    )


def _empty_gatcha_favlist_payload() -> dict:
    return {"schema_version": _GATCHA_FAVLIST_SCHEMA_VERSION, "uid": "", "uids": [], "folders": [], "items": [], "updated_at": 0}


def _favlist_folder_uid(folder: dict, fallback_uid: str = "") -> str:
    return str(folder.get("uid") or folder.get("mid") or fallback_uid or "").strip()


def _favlist_folder_key(folder: dict, fallback_uid: str = "") -> tuple[str, str]:
    return (_favlist_folder_uid(folder, fallback_uid), _gatcha_favlist_media_id(folder))


def _favlist_browser_id(uid: str, folder_id: str) -> str:
    normalized_uid = str(uid or "").strip()
    normalized_folder_id = str(folder_id or "").strip()
    return f"{normalized_uid}:{normalized_folder_id}" if normalized_uid else normalized_folder_id


def _split_favlist_browser_id(value: str) -> tuple[str, str]:
    text = str(value or "").strip()
    if ":" not in text:
        return "", text
    uid, folder_id = text.split(":", 1)
    return uid.strip(), folder_id.strip()


def _load_gatcha_favlist() -> dict:
    if not _GATCHA_FAVLIST_FILE.exists():
        return _empty_gatcha_favlist_payload()
    try:
        with _GATCHA_FAVLIST_FILE.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return _empty_gatcha_favlist_payload()
    if not isinstance(payload, dict):
        return _empty_gatcha_favlist_payload()
    folders = payload.get("folders")
    if not isinstance(folders, list):
        folders = []
    legacy_uid = str(payload.get("uid") or "").strip()
    normalized_folders: list[dict] = []
    for folder in folders:
        if not isinstance(folder, dict):
            continue
        normalized_folder = dict(folder)
        folder_uid = _favlist_folder_uid(normalized_folder, legacy_uid)
        if folder_uid:
            normalized_folder["uid"] = folder_uid
        normalized_folders.append(normalized_folder)
    raw_items = payload.get("items")
    if not isinstance(raw_items, list):
        raw_items = []
    normalized_items: list[dict] = []
    for entry in raw_items:
        if not isinstance(entry, dict):
            continue
        normalized_entry = dict(entry)
        entry_uid = str(normalized_entry.get("fav_uid") or legacy_uid or "").strip()
        if entry_uid:
            normalized_entry["fav_uid"] = entry_uid
        if not str(normalized_entry.get("source") or "").strip():
            normalized_entry["source"] = "favlist"
        if not str(normalized_entry.get("fav_folder_id") or "").strip():
            matching_folders = [
                folder
                for folder in normalized_folders
                if not entry_uid or _favlist_folder_uid(folder, legacy_uid) == entry_uid
            ]
            if len(matching_folders) == 1:
                folder = matching_folders[0]
                folder_id = _gatcha_favlist_media_id(folder)
                if folder_id:
                    normalized_entry["fav_folder_id"] = folder_id
                folder_title = str(folder.get("title") or "").strip()
                if folder_title and not str(normalized_entry.get("fav_folder_title") or "").strip():
                    normalized_entry["fav_folder_title"] = folder_title
        normalized_items.append(normalized_entry)
    items = _dedupe_gatcha_entries(normalized_items)
    uids = {
        str(uid).strip()
        for uid in (payload.get("uids") if isinstance(payload.get("uids"), list) else [])
        if str(uid).strip()
    }
    uids.update(_favlist_folder_uid(folder, legacy_uid) for folder in normalized_folders)
    uids.update(str(entry.get("fav_uid") or "").strip() for entry in items)
    uids.discard("")
    return {
        "schema_version": _GATCHA_FAVLIST_SCHEMA_VERSION,
        "uid": legacy_uid,
        "uids": sorted(uids),
        "folders": normalized_folders,
        "items": items,
        "updated_at": float(payload.get("updated_at") or 0),
    }


def _save_gatcha_favlist(payload: dict) -> None:
    payload["schema_version"] = _GATCHA_FAVLIST_SCHEMA_VERSION
    uids = {
        str(uid).strip()
        for uid in (payload.get("uids") if isinstance(payload.get("uids"), list) else [])
        if str(uid).strip()
    }
    uids.update(_favlist_folder_uid(folder, payload.get("uid")) for folder in payload.get("folders") or [] if isinstance(folder, dict))
    uids.update(str(entry.get("fav_uid") or "").strip() for entry in payload.get("items") or [] if isinstance(entry, dict))
    uids.discard("")
    payload["uids"] = sorted(uids)
    _write_json_file(_GATCHA_FAVLIST_FILE, payload)


def _gatcha_file_schema_latest(path, expected_version: int) -> bool:
    if not path.exists():
        return True
    payload = _read_json_file(path)
    if not isinstance(payload, dict):
        return False
    try:
        version = int(payload.get("schema_version") or 0)
    except (TypeError, ValueError):
        version = 0
    return version >= expected_version


def _gatcha_schema_rebuild_needed() -> bool:
    if (
        _GATCHA_CACHE_TEMP_FILE.exists()
        or _GATCHA_UIDS_TEMP_FILE.exists()
        or _GATCHA_FAVLIST_TEMP_FILE.exists()
        or _GATCHA_REBUILD_PROGRESS_FILE.exists()
    ):
        return True
    return not (
        _gatcha_file_schema_latest(_GATCHA_UIDS_FILE, _GATCHA_UIDS_SCHEMA_VERSION)
        and _gatcha_file_schema_latest(_GATCHA_CACHE_FILE, _GATCHA_CACHE_SCHEMA_VERSION)
        and _gatcha_file_schema_latest(_GATCHA_FAVLIST_FILE, _GATCHA_FAVLIST_SCHEMA_VERSION)
    )


def _load_gatcha_rebuild_progress() -> dict:
    payload = _read_json_file(_GATCHA_REBUILD_PROGRESS_FILE)
    if isinstance(payload, dict):
        return payload
    return {}


def _save_gatcha_rebuild_progress(progress: dict) -> None:
    progress["updated_at"] = time.time()
    _write_json_file(_GATCHA_REBUILD_PROGRESS_FILE, progress)


def _gatcha_rebuild_status(progress: dict, message: str) -> None:
    _set_gatcha_task_status("running", message=message, result={"rebuild": dict(progress)}, blocking=False)


def _load_gatcha_cache_temp() -> dict:
    payload = _read_json_file(_GATCHA_CACHE_TEMP_FILE)
    if not isinstance(payload, dict):
        return _empty_gatcha_cache_payload()
    uids = payload.get("uids")
    profiles = payload.get("profiles")
    return {
        "schema_version": _GATCHA_CACHE_SCHEMA_VERSION,
        "uids": uids if isinstance(uids, dict) else {},
        "profiles": _normalize_gatcha_profiles(profiles),
        "updated_at": float(payload.get("updated_at") or 0),
    }


def _save_gatcha_cache_temp(payload: dict) -> None:
    payload["schema_version"] = _GATCHA_CACHE_SCHEMA_VERSION
    _write_json_file(_GATCHA_CACHE_TEMP_FILE, payload)


def _load_gatcha_uid_temp(configured_uids: list[str]) -> dict:
    payload = _read_json_file(_GATCHA_UIDS_TEMP_FILE)
    if not isinstance(payload, dict):
        return {
            "schema_version": _GATCHA_UIDS_SCHEMA_VERSION,
            "uids": list(configured_uids),
            "profiles": {},
            "updated_at": 0,
        }
    uids = _normalize_gatcha_uid_list(payload.get("uids")) or list(configured_uids)
    return {
        "schema_version": _GATCHA_UIDS_SCHEMA_VERSION,
        "uids": uids,
        "profiles": _normalize_gatcha_profiles(payload.get("profiles")),
        "updated_at": float(payload.get("updated_at") or 0),
    }


def _save_gatcha_uid_temp(payload: dict) -> None:
    payload["schema_version"] = _GATCHA_UIDS_SCHEMA_VERSION
    _write_json_file(_GATCHA_UIDS_TEMP_FILE, payload)


def _load_gatcha_favlist_temp(current_favlist: dict) -> dict:
    payload = _read_json_file(_GATCHA_FAVLIST_TEMP_FILE)
    if not isinstance(payload, dict):
        return {
            "schema_version": _GATCHA_FAVLIST_SCHEMA_VERSION,
            "uid": str(current_favlist.get("uid") or ""),
            "uids": list(current_favlist.get("uids") or []),
            "folders": list(current_favlist.get("folders") or []),
            "items": [],
            "updated_at": 0,
        }
    folders = payload.get("folders")
    if not isinstance(folders, list):
        folders = list(current_favlist.get("folders") or [])
    return {
        "schema_version": _GATCHA_FAVLIST_SCHEMA_VERSION,
        "uid": str(payload.get("uid") or current_favlist.get("uid") or ""),
        "uids": list(payload.get("uids") or current_favlist.get("uids") or []),
        "folders": [dict(folder) for folder in folders if isinstance(folder, dict)],
        "items": _dedupe_gatcha_entries(payload.get("items")),
        "updated_at": float(payload.get("updated_at") or 0),
    }


def _save_gatcha_favlist_temp(payload: dict) -> None:
    payload["schema_version"] = _GATCHA_FAVLIST_SCHEMA_VERSION
    uids = {
        str(uid).strip()
        for uid in (payload.get("uids") if isinstance(payload.get("uids"), list) else [])
        if str(uid).strip()
    }
    uids.update(_favlist_folder_uid(folder, payload.get("uid")) for folder in payload.get("folders") or [] if isinstance(folder, dict))
    uids.update(str(entry.get("fav_uid") or "").strip() for entry in payload.get("items") or [] if isinstance(entry, dict))
    uids.discard("")
    payload["uids"] = sorted(uids)
    _write_json_file(_GATCHA_FAVLIST_TEMP_FILE, payload)


def _wait_for_gatcha_request_slot() -> None:
    global _GATCHA_LAST_REQUEST_AT

    with _GATCHA_REQUEST_LOCK:
        now = time.monotonic()
        elapsed = now - _GATCHA_LAST_REQUEST_AT
        if elapsed < GATCHA_RETRY_DELAY_SECONDS:
            time.sleep(GATCHA_RETRY_DELAY_SECONDS - elapsed)
        _GATCHA_LAST_REQUEST_AT = time.monotonic()


def _wait_for_gatcha_favlist_request_slot() -> None:
    global _GATCHA_FAVLIST_LAST_REQUEST_AT

    with _GATCHA_FAVLIST_REQUEST_LOCK:
        now = time.monotonic()
        elapsed = now - _GATCHA_FAVLIST_LAST_REQUEST_AT
        if elapsed < GATCHA_FAVLIST_RETRY_DELAY_SECONDS:
            time.sleep(GATCHA_FAVLIST_RETRY_DELAY_SECONDS - elapsed)
        _GATCHA_FAVLIST_LAST_REQUEST_AT = time.monotonic()


def _request_gatcha_favlist_json(url: str, error_label: str) -> dict:
    while True:
        _wait_for_gatcha_favlist_request_slot()
        payload = request_json(url)
        try:
            code = int(payload.get("code") or 0)
        except (TypeError, ValueError):
            code = 0
        if code == 0:
            return payload
        message = str(payload.get("message") or error_label)
        if code in {412, -412} or "412" in message:
            time.sleep(GATCHA_FAVLIST_RETRY_DELAY_SECONDS)
            continue
        raise BilibiliError(message)


def _matches_gatcha_keywords(title: str) -> bool:
    normalized_title = str(title or "")
    if not GATCHA_KEYWORDS:
        return True
    return any(keyword and keyword in normalized_title for keyword in GATCHA_KEYWORDS)


def _first_gatcha_text(source: dict, *keys: str) -> str:
    for key in keys:
        value = source.get(key)
        if value is None:
            continue
        text = str(value).strip()
        if text:
            return text
    return ""


def _gatcha_duration_text(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if math.isfinite(float(value)) and float(value) >= 0:
            return str(int(float(value)))
        return ""

    text = str(value).strip()
    if not text:
        return ""
    if ":" in text:
        parts = text.split(":")
        if parts and all(part.isdigit() for part in parts):
            seconds = 0
            for part in parts:
                seconds = seconds * 60 + int(part)
            return str(seconds)
    try:
        numeric = float(text)
    except ValueError:
        return text
    if math.isfinite(numeric) and numeric >= 0:
        return str(int(numeric))
    return ""


def _gatcha_video_extra_fields(source: dict) -> dict:
    extras: dict[str, str] = {}
    cover_url = _first_gatcha_text(source, "cover_url", "cover", "pic", "pic_url", "thumbnail")
    if cover_url:
        extras["cover_url"] = cover_url

    played_count = _first_gatcha_text(source, "played_count", "play_count", "play", "view", "views")
    if not played_count:
        cnt_info = source.get("cnt_info") if isinstance(source.get("cnt_info"), dict) else {}
        played_count = _first_gatcha_text(cnt_info, "play", "view", "played_count")
    if not played_count:
        stat = source.get("stat") if isinstance(source.get("stat"), dict) else {}
        played_count = _first_gatcha_text(stat, "view", "play", "played_count")
    if played_count:
        extras["played_count"] = played_count

    duration = source.get("duration")
    if duration is None:
        duration = source.get("length")
    duration_text = _gatcha_duration_text(duration)
    if duration_text:
        extras["preserved_1"] = duration_text
    return extras


def _extract_gatcha_entries(mid: str, payload: dict) -> list[dict]:
    vlist = payload.get("data", {}).get("list", {}).get("vlist", [])
    entries: list[dict] = []
    for video in vlist:
        if not isinstance(video, dict):
            continue
        bvid = str(video.get("bvid") or "").strip()
        title = str(video.get("title") or "").strip()
        if not bvid or not title or not _matches_gatcha_keywords(title):
            continue
        owner_name = str(video.get("author") or video.get("owner_name") or "").strip()
        entry = {
            "mid": str(mid),
            "bvid": bvid,
            "title": title,
            "url": f"https://www.bilibili.com/video/{bvid}",
        }
        if owner_name:
            entry["owner_name"] = owner_name
            entry["owner_url"] = f"https://space.bilibili.com/{mid}"
        entry.update(_gatcha_video_extra_fields(video))
        entries.append(entry)
    return entries


def _request_gatcha_page(mid: str, page_number: int, page_size: int = 50) -> dict:
    try:
        img_key, sub_key = get_cached_wbi_keys()
    except Exception as exc:
        raise BilibiliError(f"WBI keys failed: {exc}") from exc

    params = {
        "mid": str(mid),
        "ps": max(1, int(page_size)),
        "tid": 0,
        "pn": max(1, int(page_number)),
        "order": "pubdate",
        "platform": "web",
    }
    signed_params = enc_wbi(params, img_key, sub_key)
    query_string = urllib.parse.urlencode(signed_params)
    url = f"https://api.bilibili.com/x/space/wbi/arc/search?{query_string}"
    _wait_for_gatcha_request_slot()
    # print(f"[debug] gatcha fetch cookie: {cfg.COOKIE}")

    try:
        payload = request_json(url)
        code = int(payload.get("code") or 0)
        if code == 412:
            raise BilibiliError(str(payload.get("message") or "412 Precondition Failed"))
        if code != 0:
            raise BilibiliError(str(payload.get("message") or "API request failed"))
        # print(f"[debug] gatcha fetch success: mid={mid}, page={page_number}")
        return payload
    except Exception as exc:  # noqa: BLE001
        # print(f"[debug] gatcha fetch error: {exc}; cookie: {cfg.COOKIE}")
        raise


def _request_gatcha_uid_profile(mid: str) -> dict:
    normalized_mid = str(mid).strip()
    now = time.time()
    with _GATCHA_PROFILE_CACHE_LOCK:
        cached_at, cached_profile = _GATCHA_PROFILE_CACHE.get(normalized_mid, (0.0, {}))
        if cached_profile and now - cached_at < GATCHA_PROFILE_CACHE_TTL_SECONDS:
            return dict(cached_profile)

    try:
        img_key, sub_key = get_cached_wbi_keys()
    except Exception as exc:
        raise BilibiliError(f"WBI keys failed: {exc}") from exc

    signed_params = enc_wbi({"mid": normalized_mid}, img_key, sub_key)
    query_string = urllib.parse.urlencode(signed_params)
    url = f"https://api.bilibili.com/x/space/wbi/acc/info?{query_string}"
    _wait_for_gatcha_request_slot()
    payload = request_json(url)
    try:
        code = int(payload.get("code") or 0)
    except (TypeError, ValueError):
        code = 0
    if code != 0:
        message = str(payload.get("message") or "UP 主信息获取失败")
        raise BilibiliError(message)

    data = payload.get("data")
    if not isinstance(data, dict):
        raise BilibiliError("UP 主信息获取失败")
    owner_mid = str(data.get("mid") or normalized_mid).strip()
    owner_name = str(data.get("name") or "").strip()
    if not owner_mid.isdigit() or int(owner_mid) <= 0 or not owner_name:
        raise BilibiliError("没有找到这个 UID 对应的 UP 主")
    profile = {
        "uid": owner_mid.lstrip("0") or "0",
        "name": owner_name,
        "space_url": f"https://space.bilibili.com/{owner_mid}",
    }
    avatar_url = str(data.get("face") or "").strip()
    if avatar_url:
        profile["avatar_url"] = avatar_url
    with _GATCHA_PROFILE_CACHE_LOCK:
        _GATCHA_PROFILE_CACHE[normalized_mid] = (time.time(), dict(profile))
        _GATCHA_PROFILE_CACHE[profile["uid"]] = (time.time(), dict(profile))
    return profile


def _persist_gatcha_uid_profile(profile: dict) -> dict | None:
    normalized = _normalize_gatcha_profile(profile.get("uid"), profile)
    if normalized is None:
        return None

    with _GATCHA_UIDS_LOCK:
        uid_payload = _load_gatcha_uid_payload()
        profiles = uid_payload.get("profiles")
        if not isinstance(profiles, dict):
            profiles = {}
        uid = str(normalized["uid"])
        if profiles.get(uid) == normalized:
            return normalized
        profiles[uid] = normalized
        uid_payload["profiles"] = profiles
        uid_payload["updated_at"] = time.time()
        try:
            _save_gatcha_uid_payload(uid_payload)
        except OSError:
            return normalized
    return normalized


def _resolve_gatcha_uid_profile(mid: str, known_profiles: dict | None = None) -> dict | None:
    known = known_profiles.get(mid) if isinstance(known_profiles, dict) else None
    normalized_known = _normalize_gatcha_profile(mid, known)
    if normalized_known is not None:
        return normalized_known

    try:
        profile = _request_gatcha_uid_profile(mid)
    except Exception:
        return None
    return _persist_gatcha_uid_profile(profile)


def _fetch_gatcha_videos_for_uid(
    mid: str,
    *,
    on_progress: callable | None = None,
    max_pages: int | None = None,
) -> list[dict]:
    page_size = 50
    page_number = 1
    all_entries: list[dict] = []
    seen_bvids: set[str] = set()
    page_limit = max(1, int(max_pages)) if max_pages is not None else None

    while True:
        retry_reported = False
        while True:
            try:
                payload = _request_gatcha_page(mid, page_number, page_size)
                break
            except Exception as exc:  # noqa: BLE001
                if not retry_reported:
                    error = str(exc).replace("\r", " ").replace("\n", " ")[:300]
                    print(
                        f"[bilikara] gatcha page request failed; retrying mid={mid} page={page_number}: {error}",
                        file=sys.stderr,
                        flush=True,
                    )
                    retry_reported = True
                time.sleep(GATCHA_RETRY_DELAY_SECONDS)
        data = payload.get("data", {}) if isinstance(payload, dict) else {}
        page_entries = _extract_gatcha_entries(str(mid), payload)
        for entry in page_entries:
            bvid = str(entry.get("bvid") or "").strip()
            if not bvid or bvid in seen_bvids:
                continue
            seen_bvids.add(bvid)
            all_entries.append(entry)
        if on_progress is not None:
            on_progress(list(all_entries))

        if page_limit is not None and page_number >= page_limit:
            break

        vlist = data.get("list", {}).get("vlist", [])
        if not isinstance(vlist, list) or len(vlist) < page_size:
            break
        page_number += 1

    return all_entries


def _dedupe_gatcha_entries(raw_entries: object) -> list[dict]:
    if not isinstance(raw_entries, list):
        return []
    entries: list[dict] = []
    seen_keys: set[str] = set()
    for raw_entry in raw_entries:
        if not isinstance(raw_entry, dict):
            continue
        bvid = str(raw_entry.get("bvid") or "").strip()
        key = _gatcha_entry_dedupe_key(raw_entry)
        if not bvid or key in seen_keys:
            continue
        seen_keys.add(key)
        entries.append(dict(raw_entry))
    return entries


def _gatcha_entry_dedupe_key(entry: dict) -> str:
    bvid = str(entry.get("bvid") or "").strip()
    fav_uid = str(entry.get("fav_uid") or "").strip()
    fav_folder_id = str(entry.get("fav_folder_id") or "").strip()
    return f"favlist:{fav_uid}:{fav_folder_id}:{bvid}" if fav_uid and fav_folder_id else bvid


def _is_expired_gatcha_entry(entry: dict) -> bool:
    return str(entry.get("title") or "").strip() == "已失效视频"


def _matches_gatcha_favlist_title(title: str) -> bool:
    normalized = str(title or "").strip().lower().replace("ｋ", "k").replace("Ｋ", "k")
    return any(keyword.lower() in normalized for keyword in _GATCHA_FAVLIST_TITLE_KEYWORDS)


def _selected_gatcha_favlist_folder_ids(raw_folder_ids: object) -> set[str] | None:
    if raw_folder_ids is None:
        return None
    if not isinstance(raw_folder_ids, list):
        raise BilibiliError("收藏夹选择格式不正确")
    folder_ids: set[str] = set()
    for value in raw_folder_ids:
        folder_id = str(value or "").strip()
        if folder_id and folder_id.isdigit():
            folder_ids.add(folder_id)
    if not folder_ids:
        raise BilibiliError("请选择至少一个收藏夹")
    return folder_ids


def _is_public_gatcha_favlist_folder(folder: dict) -> bool:
    try:
        attr = int(folder.get("attr") or 0)
    except (TypeError, ValueError):
        attr = 0
    return (attr & 1) == 0


def _request_gatcha_favlist_folders(mid: str) -> list[dict]:
    query = urllib.parse.urlencode({"up_mid": str(mid), "platform": "web"})
    url = f"https://api.bilibili.com/x/v3/fav/folder/created/list-all?{query}"
    payload = _request_gatcha_favlist_json(url, "收藏夹列表拉取失败")
    data = payload.get("data")
    folders = data.get("list") if isinstance(data, dict) else []
    return [dict(folder) for folder in folders if isinstance(folder, dict)]


def _gatcha_favlist_folder_summary(folder: dict) -> dict:
    folder_id = _gatcha_favlist_media_id(folder)
    try:
        media_count = int(folder.get("media_count") or 0)
    except (TypeError, ValueError):
        media_count = 0
    title = str(folder.get("title") or "").strip()
    return {
        "id": folder_id,
        "fid": str(folder.get("fid") or ""),
        "title": title,
        "media_count": media_count,
        "selected": _matches_gatcha_favlist_title(title),
    }


def _py_preview_gatcha_favlist(raw_mid: object) -> dict:
    mid = _normalize_gatcha_uid(raw_mid)
    folders = _request_gatcha_favlist_folders(mid)
    public_folders: list[dict] = []
    for folder in folders:
        title = str(folder.get("title") or "").strip()
        if not title or not _is_public_gatcha_favlist_folder(folder):
            continue
        summary = _gatcha_favlist_folder_summary(folder)
        if summary["id"]:
            public_folders.append(summary)
    return {
        "uid": mid,
        "folder_count": len(folders),
        "public_folder_count": len(public_folders),
        "selected_folder_ids": [folder["id"] for folder in public_folders if folder.get("selected")],
        "folders": public_folders,
    }


def _request_gatcha_favlist_page(media_id: str, page_number: int, page_size: int = 20) -> dict:
    params = {
        "media_id": str(media_id),
        "platform": "web",
        "pn": max(1, int(page_number)),
        "ps": max(1, min(20, int(page_size))),
        "order": "mtime",
        "type": 0,
    }
    url = f"https://api.bilibili.com/x/v3/fav/resource/list?{urllib.parse.urlencode(params)}"
    return _request_gatcha_favlist_json(url, "收藏夹内容拉取失败")


def _gatcha_favlist_media_id(folder: dict) -> str:
    for key in ("id", "media_id", "fid"):
        value = str(folder.get(key) or "").strip()
        if value and value.isdigit():
            return value
    return ""


def _extract_gatcha_favlist_entries(uid: str, folder: dict, medias: object) -> list[dict]:
    if not isinstance(medias, list):
        return []
    folder_id = _gatcha_favlist_media_id(folder)
    folder_title = str(folder.get("title") or "").strip()
    entries: list[dict] = []
    for media in medias:
        if not isinstance(media, dict):
            continue
        bvid = str(media.get("bvid") or "").strip()
        title = str(media.get("title") or "").strip()
        if not bvid or not title:
            continue
        upper = media.get("upper") if isinstance(media.get("upper"), dict) else {}
        owner_mid = str(upper.get("mid") or media.get("upper_mid") or "").strip()
        owner_name = str(upper.get("name") or media.get("upper_name") or "").strip()
        entry = {
            "mid": owner_mid,
            "bvid": bvid,
            "title": title,
            "url": f"https://www.bilibili.com/video/{bvid}",
            "fav_uid": str(uid),
            "fav_folder_id": folder_id,
            "fav_folder_title": folder_title,
            "source": "favlist",
        }
        if owner_name:
            entry["owner_name"] = owner_name
        if owner_mid:
            entry["owner_url"] = f"https://space.bilibili.com/{owner_mid}"
        entry.update(_gatcha_video_extra_fields(media))
        entries.append(entry)
    return entries


def _fetch_gatcha_favlist_entries_for_folder(uid: str, folder: dict, *, max_pages: int | None = None) -> list[dict]:
    media_id = _gatcha_favlist_media_id(folder)
    if not media_id:
        return []
    page_size = 20
    page_number = 1
    entries: list[dict] = []
    page_limit = max(1, int(max_pages)) if max_pages is not None else None
    while True:
        payload = _request_gatcha_favlist_page(media_id, page_number, page_size)
        data = payload.get("data") if isinstance(payload, dict) else {}
        medias = data.get("medias") if isinstance(data, dict) else []
        page_entries = _extract_gatcha_favlist_entries(uid, folder, medias)
        entries.extend(page_entries)
        info = data.get("info") if isinstance(data, dict) and isinstance(data.get("info"), dict) else {}
        try:
            media_count = int(info.get("media_count") or 0)
        except (TypeError, ValueError):
            media_count = 0
        has_more = data.get("has_more") if isinstance(data, dict) else None
        if not isinstance(medias, list) or not medias:
            break
        if page_limit is not None and page_number >= page_limit:
            break
        if media_count:
            if page_number * page_size >= media_count:
                break
        else:
            if len(medias) < page_size:
                break
            if isinstance(has_more, bool) and not has_more:
                break
        page_number += 1
    return entries


def _refresh_gatcha_favlist_unlocked(raw_mid: object, raw_folder_ids: object = None) -> dict:
    mid = _normalize_gatcha_uid(raw_mid)
    selected_folder_ids = _selected_gatcha_favlist_folder_ids(raw_folder_ids)
    folders = _request_gatcha_favlist_folders(mid)
    matched_folders: list[dict] = []
    entries: list[dict] = []

    for folder in folders:
        title = str(folder.get("title") or "").strip()
        if not title or not _is_public_gatcha_favlist_folder(folder):
            continue
        folder_id = _gatcha_favlist_media_id(folder)
        if selected_folder_ids is None:
            if not _matches_gatcha_favlist_title(title):
                continue
        elif folder_id not in selected_folder_ids:
            continue
        matched_folder = _gatcha_favlist_folder_summary(folder)
        matched_folder.pop("selected", None)
        matched_folder["uid"] = mid
        matched_folders.append(matched_folder)
        entries.extend(_fetch_gatcha_favlist_entries_for_folder(mid, folder))

    deduped_entries = _dedupe_gatcha_entries(entries)
    with _GATCHA_FAVLIST_LOCK:
        current_payload = _load_gatcha_favlist()
        incoming_folder_ids = {
            _gatcha_favlist_media_id(folder)
            for folder in matched_folders
            if _gatcha_favlist_media_id(folder)
        }
        incoming_folder_keys = {(mid, folder_id) for folder_id in incoming_folder_ids}
        merged_folders_by_key: dict[tuple[str, str], dict] = {}
        for folder in current_payload.get("folders") or []:
            if not isinstance(folder, dict):
                continue
            key = _favlist_folder_key(folder, current_payload.get("uid"))
            if not key[1] or key in incoming_folder_keys:
                continue
            merged_folders_by_key[key] = dict(folder)
        for folder in matched_folders:
            key = _favlist_folder_key(folder, mid)
            if key[1]:
                merged_folders_by_key[key] = dict(folder)

        preserved_items = []
        for entry in current_payload.get("items") or []:
            if not isinstance(entry, dict):
                continue
            entry_uid = str(entry.get("fav_uid") or current_payload.get("uid") or "").strip()
            entry_folder_id = str(entry.get("fav_folder_id") or "").strip()
            if (entry_uid, entry_folder_id) in incoming_folder_keys:
                continue
            preserved_items.append(dict(entry))
        merged_entries = _dedupe_gatcha_entries(preserved_items + deduped_entries)
        payload = {
            "schema_version": _GATCHA_FAVLIST_SCHEMA_VERSION,
            "uid": mid,
            "uids": sorted({*(current_payload.get("uids") or []), mid}),
            "folders": list(merged_folders_by_key.values()),
            "items": merged_entries,
            "updated_at": time.time(),
        }
        _save_gatcha_favlist(payload)
        _merge_favlist_into_rebuild_temp(payload)
    return {
        "uid": mid,
        "folder_count": len(folders),
        "matched_folder_count": len(matched_folders),
        "item_count": len(deduped_entries),
        "updated_at": payload["updated_at"],
    }


def _py_refresh_gatcha_favlist(
    raw_mid: object,
    raw_folder_ids: object = None,
    *,
    on_start: callable | None = None,
    on_done: callable | None = None,
) -> dict:
    if not rust_runtime.try_begin_gatcha_refresh(
        busy_message=GATCHA_TASK_BUSY_MESSAGE
    ):
        raise BilibiliError(GATCHA_TASK_BUSY_MESSAGE)
    result: dict | None = None
    entries: list[dict] = []
    try:
        if on_start is not None:
            on_start()
        result = _refresh_gatcha_favlist_unlocked(raw_mid, raw_folder_ids)
        with _GATCHA_FAVLIST_LOCK:
            entries = list(_load_gatcha_favlist().get("items") or [])
    finally:
        rust_runtime.release_gatcha_refresh()
        if on_done is not None:
            on_done()
    if entries:
        _append_lark_pool_entries_async(entries)
    return result or {}


def _refresh_existing_gatcha_favlist_cache() -> dict | None:
    if not _GATCHA_FAVLIST_FILE.exists():
        return None
    with _GATCHA_FAVLIST_LOCK:
        payload = _load_gatcha_favlist()

    folders = payload.get("folders") if isinstance(payload, dict) else []
    if not isinstance(folders, list) or not folders:
        return None

    fresh_entries: list[dict] = []
    refreshed_folders = 0
    for folder in folders:
        if not isinstance(folder, dict):
            continue
        uid = _favlist_folder_uid(folder, payload.get("uid"))
        if not _gatcha_favlist_media_id(folder):
            continue
        if not uid:
            continue
        entries = _fetch_gatcha_favlist_entries_for_folder(uid, folder, max_pages=1)
        refreshed_folders += 1
        fresh_entries.extend(entries)

    if not refreshed_folders:
        return None

    merged_entries, added_count = _merge_incremental_gatcha_entries(payload.get("items"), fresh_entries)
    payload["items"] = merged_entries
    payload["updated_at"] = time.time()
    with _GATCHA_FAVLIST_LOCK:
        _save_gatcha_favlist(payload)
    return {
        "uid": ",".join(payload.get("uids") or []),
        "mode": "incremental",
        "folder_count": refreshed_folders,
        "added_count": added_count,
        "total_count": len(merged_entries),
    }


def _py_preview_gatcha_uid(raw_mid: object) -> dict:
    if not effective_bilibili_cookie():
        raise BilibiliError(MISSING_BILIBILI_COOKIE_MESSAGE)

    mid = _normalize_gatcha_uid(raw_mid)
    profile = _request_gatcha_uid_profile(mid)
    mid = str(profile["uid"])

    with _GATCHA_UIDS_LOCK:
        uid_payload = _load_gatcha_uid_payload()
    followed_uids = uid_payload.get("uids") if isinstance(uid_payload, dict) else []
    if not isinstance(followed_uids, list):
        followed_uids = []

    with _GATCHA_CACHE_LOCK:
        cache_payload = _load_gatcha_cache()
    uid_cache = cache_payload.get("uids") if isinstance(cache_payload, dict) else {}
    if not isinstance(uid_cache, dict):
        uid_cache = {}
    existing_entries = _dedupe_gatcha_entries(uid_cache.get(mid, []))
    cache_mode = "incremental" if existing_entries else "full"

    return {
        "uid": mid,
        "name": str(profile.get("name") or ""),
        "space_url": str(profile.get("space_url") or f"https://space.bilibili.com/{mid}"),
        "avatar_url": str(profile.get("avatar_url") or ""),
        "already_followed": mid in followed_uids,
        "cache_mode": cache_mode,
        "cache_mode_label": "最新" if cache_mode == "incremental" else "所有",
        "cached_count": len(existing_entries),
    }


def _merge_incremental_gatcha_entries(existing_entries: object, fresh_entries: object) -> tuple[list[dict], int]:
    existing = _dedupe_gatcha_entries(existing_entries)
    existing_by_key = {_gatcha_entry_dedupe_key(entry): entry for entry in existing}
    new_entries: list[dict] = []
    for fresh_entry in _dedupe_gatcha_entries(fresh_entries):
        key = _gatcha_entry_dedupe_key(fresh_entry)
        if not key:
            continue
        if key in existing_by_key:
            existing_by_key[key].update(_merge_gatcha_entry_data(existing_by_key[key], fresh_entry))
            continue
        new_entries.append(fresh_entry)
    return new_entries + existing, len(new_entries)


def _merge_gatcha_entry_data(existing_entry: dict, fresh_entry: dict) -> dict:
    merged = dict(existing_entry)
    for key in (
        "mid",
        "title",
        "url",
        "owner_name",
        "owner_url",
        "cover_url",
        "preserved_1",
        "preserved_2",
        "preserved_3",
        "preserved_4",
        "preserved_5",
    ):
        current = str(merged.get(key) or "").strip()
        incoming = str(fresh_entry.get(key) or "").strip()
        if not current and incoming:
            merged[key] = incoming

    played_count = str(fresh_entry.get("played_count") or "").strip()
    if played_count:
        merged["played_count"] = played_count
    return merged


def _refresh_gatcha_uid_cache(cache_payload: dict, mid: str, *, force_full: bool = False) -> dict:
    if not isinstance(cache_payload.get("uids"), dict):
        cache_payload["uids"] = {}

    existing_entries = _dedupe_gatcha_entries(cache_payload["uids"].get(mid, []))
    if existing_entries and not force_full:
        fresh_entries = _fetch_gatcha_videos_for_uid(mid, max_pages=1)
        merged_entries, added_count = _merge_incremental_gatcha_entries(existing_entries, fresh_entries)
        cache_payload["uids"][mid] = merged_entries
        cache_payload["updated_at"] = time.time()
        with _GATCHA_CACHE_LOCK:
            _save_gatcha_cache_uid(cache_payload, mid)
        return {
            "uid": mid,
            "mode": "incremental",
            "added_count": added_count,
            "total_count": len(merged_entries),
        }

    cache_payload["uids"][mid] = []
    cache_payload["updated_at"] = time.time()
    with _GATCHA_CACHE_LOCK:
        _save_gatcha_cache_uid(cache_payload, mid)

    def _save_mid_progress(entries: list[dict]) -> None:
        cache_payload["uids"][mid] = _dedupe_gatcha_entries(entries)
        cache_payload["updated_at"] = time.time()
        with _GATCHA_CACHE_LOCK:
            _save_gatcha_cache_uid(cache_payload, mid)

    fetched_entries = _fetch_gatcha_videos_for_uid(mid, on_progress=_save_mid_progress)
    cache_payload["uids"][mid] = _dedupe_gatcha_entries(fetched_entries)
    cache_payload["updated_at"] = time.time()
    with _GATCHA_CACHE_LOCK:
        _save_gatcha_cache_uid(cache_payload, mid)
    return {
        "uid": mid,
        "mode": "full",
        "added_count": len(cache_payload["uids"][mid]),
        "total_count": len(cache_payload["uids"][mid]),
    }


def _gatcha_refresh_task_result(cache_payload: dict | None) -> dict:
    if not isinstance(cache_payload, dict):
        return {"uid_count": 0, "entry_count": 0, "errors": []}
    uids = cache_payload.get("uids")
    entry_count = 0
    uid_count = 0
    if isinstance(uids, dict):
        uid_count = len(uids)
        for entries in uids.values():
            if isinstance(entries, list):
                entry_count += len(entries)
    summary = cache_payload.get("refresh_summary")
    errors = []
    uid_results = []
    favlist_error = ""
    if isinstance(summary, dict):
        raw_errors = summary.get("errors")
        if isinstance(raw_errors, list):
            errors = [error for error in raw_errors if isinstance(error, dict)]
        raw_results = summary.get("uids")
        if isinstance(raw_results, list):
            uid_results = [result for result in raw_results if isinstance(result, dict)]
        favlist_error = str(summary.get("favlist_error") or "")
    return {
        "uid_count": uid_count,
        "entry_count": entry_count,
        "uid_results": uid_results,
        "errors": errors,
        "favlist_error": favlist_error,
    }


def _py_refresh_gatcha_cache() -> dict:
    if not effective_bilibili_cookie():
        raise BilibiliError(MISSING_BILIBILI_COOKIE_MESSAGE)

    with _GATCHA_UIDS_LOCK:
        uid_payload = _load_gatcha_uid_payload()
    configured_uids = uid_payload.get("uids") if isinstance(uid_payload, dict) else []
    if not isinstance(configured_uids, list):
        configured_uids = []
    known_profiles = uid_payload.get("profiles") if isinstance(uid_payload, dict) else {}
    if not isinstance(known_profiles, dict):
        known_profiles = {}

    with _GATCHA_CACHE_LOCK:
        cache_payload = _load_gatcha_cache(reset_legacy=True)

    if not isinstance(cache_payload, dict):
        cache_payload = _empty_gatcha_cache_payload()
    if not isinstance(cache_payload.get("uids"), dict):
        cache_payload["uids"] = {}
    cache_profiles = cache_payload.get("profiles")
    if not isinstance(cache_profiles, dict):
        cache_profiles = {}
    cache_payload["profiles"] = cache_profiles

    refresh_summary = {
        "uids": [],
        "errors": [],
        "favlist_error": "",
        "updated_at": time.time(),
    }
    cache_payload["updated_at"] = time.time()
    for raw_mid in configured_uids:
        mid = str(raw_mid).strip()
        if not mid:
            continue
        try:
            profile = _resolve_gatcha_uid_profile(mid, known_profiles)
            if profile is not None:
                cache_profiles[str(profile["uid"])] = profile
                known_profiles[str(profile["uid"])] = profile
            refresh_summary["uids"].append(_refresh_gatcha_uid_cache(cache_payload, mid))
        except Exception as exc:
            refresh_summary["errors"].append({"uid": mid, "error": str(exc)})
    try:
        _refresh_existing_gatcha_favlist_cache()
    except Exception as exc:
        refresh_summary["favlist_error"] = str(exc)
    cache_payload["refresh_summary"] = refresh_summary
    return cache_payload


def _replace_gatcha_file_from_temp(temp_path, final_path) -> None:
    if temp_path.exists():
        temp_path.replace(final_path)


def _cleanup_gatcha_rebuild_temp_files() -> None:
    for path in (
        _GATCHA_CACHE_TEMP_FILE,
        _GATCHA_UIDS_TEMP_FILE,
        _GATCHA_FAVLIST_TEMP_FILE,
        _GATCHA_REBUILD_PROGRESS_FILE,
        _GATCHA_REBUILD_PROGRESS_FILE.with_suffix(_GATCHA_REBUILD_PROGRESS_FILE.suffix + ".tmp"),
    ):
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass
    for path in _GATCHA_REBUILD_PROGRESS_FILE.parent.glob(f".{_GATCHA_REBUILD_PROGRESS_FILE.name}.*.tmp"):
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass


def _gatcha_rebuild_temp_active() -> bool:
    return (
        _GATCHA_CACHE_TEMP_FILE.exists()
        or _GATCHA_UIDS_TEMP_FILE.exists()
        or _GATCHA_FAVLIST_TEMP_FILE.exists()
        or _GATCHA_REBUILD_PROGRESS_FILE.exists()
    )


def _merge_added_uid_into_rebuild_temp(mid: str, profile: dict, entries: list[dict]) -> None:
    if not _gatcha_rebuild_temp_active():
        return
    normalized_mid = str(mid or "").strip()
    if not normalized_mid:
        return

    uid_temp = _load_gatcha_uid_temp(_normalize_gatcha_uid_list(_load_gatcha_uid_payload().get("uids")))
    temp_uids = _normalize_gatcha_uid_list(uid_temp.get("uids"))
    if normalized_mid not in temp_uids:
        temp_uids.append(normalized_mid)
    uid_temp["uids"] = temp_uids
    profiles = uid_temp.get("profiles") if isinstance(uid_temp.get("profiles"), dict) else {}
    normalized_profile = _normalize_gatcha_profile(normalized_mid, profile)
    if normalized_profile is not None:
        profiles[normalized_mid] = normalized_profile
    uid_temp["profiles"] = profiles
    uid_temp["updated_at"] = time.time()
    _save_gatcha_uid_temp(uid_temp)

    cache_temp = _load_gatcha_cache_temp()
    cache_uids = cache_temp.get("uids") if isinstance(cache_temp.get("uids"), dict) else {}
    existing_entries = cache_uids.get(normalized_mid, [])
    merged_entries, _ = _merge_incremental_gatcha_entries(existing_entries, entries)
    cache_uids[normalized_mid] = merged_entries
    cache_temp["uids"] = cache_uids
    cache_profiles = cache_temp.get("profiles") if isinstance(cache_temp.get("profiles"), dict) else {}
    if normalized_profile is not None:
        cache_profiles[normalized_mid] = normalized_profile
    cache_temp["profiles"] = cache_profiles
    cache_temp["updated_at"] = time.time()
    _save_gatcha_cache_temp(cache_temp)


def _merge_favlist_into_rebuild_temp(payload: dict) -> None:
    if not _gatcha_rebuild_temp_active() or not isinstance(payload, dict):
        return
    favlist_temp = _load_gatcha_favlist_temp(payload)
    incoming_folders = payload.get("folders") if isinstance(payload.get("folders"), list) else []
    if incoming_folders:
        by_id = {
            _favlist_folder_key(folder, favlist_temp.get("uid")): dict(folder)
            for folder in favlist_temp.get("folders", [])
            if isinstance(folder, dict) and _favlist_folder_key(folder, favlist_temp.get("uid"))[1]
        }
        for folder in incoming_folders:
            if not isinstance(folder, dict):
                continue
            key = _favlist_folder_key(folder, payload.get("uid") or favlist_temp.get("uid"))
            if key[1]:
                by_id[key] = dict(folder)
        favlist_temp["folders"] = list(by_id.values())
    if payload.get("uid"):
        favlist_temp["uid"] = str(payload.get("uid") or "")
    uids = {str(uid).strip() for uid in favlist_temp.get("uids") or [] if str(uid).strip()}
    uids.update(str(uid).strip() for uid in payload.get("uids") or [] if str(uid).strip())
    if payload.get("uid"):
        uids.add(str(payload.get("uid") or "").strip())
    favlist_temp["uids"] = sorted(uid for uid in uids if uid)
    merged_entries, _ = _merge_incremental_gatcha_entries(favlist_temp.get("items"), payload.get("items"))
    favlist_temp["items"] = merged_entries
    favlist_temp["updated_at"] = time.time()
    _save_gatcha_favlist_temp(favlist_temp)


def _merge_current_gatcha_changes_into_rebuild(uid_temp: dict, cache_temp: dict) -> None:
    current_uid_payload = _load_gatcha_uid_payload()
    current_uids = _normalize_gatcha_uid_list(current_uid_payload.get("uids"))
    temp_uids = _normalize_gatcha_uid_list(uid_temp.get("uids"))
    for uid in current_uids:
        if uid not in temp_uids:
            temp_uids.append(uid)
    uid_temp["uids"] = temp_uids

    temp_profiles = uid_temp.get("profiles") if isinstance(uid_temp.get("profiles"), dict) else {}
    for uid, profile in (current_uid_payload.get("profiles") or {}).items():
        uid_key = str(uid)
        if uid_key not in temp_profiles and isinstance(profile, dict):
            temp_profiles[uid_key] = dict(profile)
    uid_temp["profiles"] = temp_profiles

    current_cache = _load_gatcha_cache(reset_legacy=False)
    current_cache_uids = current_cache.get("uids") if isinstance(current_cache, dict) else {}
    temp_cache_uids = cache_temp.get("uids") if isinstance(cache_temp.get("uids"), dict) else {}
    if isinstance(current_cache_uids, dict):
        for uid, entries in current_cache_uids.items():
            uid_key = str(uid)
            if uid_key not in temp_cache_uids and isinstance(entries, list):
                temp_cache_uids[uid_key] = _dedupe_gatcha_entries(entries)
    cache_temp["uids"] = temp_cache_uids

    temp_cache_profiles = cache_temp.get("profiles") if isinstance(cache_temp.get("profiles"), dict) else {}
    current_cache_profiles = current_cache.get("profiles") if isinstance(current_cache, dict) else {}
    if isinstance(current_cache_profiles, dict):
        for uid, profile in current_cache_profiles.items():
            uid_key = str(uid)
            if uid_key not in temp_cache_profiles and isinstance(profile, dict):
                temp_cache_profiles[uid_key] = dict(profile)
    cache_temp["profiles"] = temp_cache_profiles


def rebuild_gatcha_files_for_latest_schema() -> dict:
    if not effective_bilibili_cookie():
        raise BilibiliError(MISSING_BILIBILI_COOKIE_MESSAGE)

    with _GATCHA_UIDS_LOCK:
        uid_payload = _load_gatcha_uid_payload()
    configured_uids = _normalize_gatcha_uid_list(uid_payload.get("uids"))

    progress = _load_gatcha_rebuild_progress()
    completed_uids = {
        str(uid).strip()
        for uid in progress.get("completed_uids", [])
        if str(uid).strip()
    }
    completed_folders = {
        str(folder_id).strip()
        for folder_id in progress.get("completed_folders", [])
        if str(folder_id).strip()
    }
    progress.update(
        {
            "schema_version": {
                "uids": _GATCHA_UIDS_SCHEMA_VERSION,
                "cache": _GATCHA_CACHE_SCHEMA_VERSION,
                "favlist": _GATCHA_FAVLIST_SCHEMA_VERSION,
            },
            "uid_total": len(configured_uids),
            "started_at": float(progress.get("started_at") or time.time()),
        }
    )
    _save_gatcha_rebuild_progress(progress)
    _gatcha_rebuild_status(progress, "正在重建抽卡缓存格式...")

    uid_temp = _load_gatcha_uid_temp(configured_uids)
    uid_temp["uids"] = list(configured_uids)
    cache_temp = _load_gatcha_cache_temp()
    cache_temp.setdefault("uids", {})
    cache_temp.setdefault("profiles", {})

    for index, mid in enumerate(configured_uids, start=1):
        if mid in completed_uids:
            continue
        progress.update({"phase": "uid", "current_uid": mid, "uid_index": index})
        _save_gatcha_rebuild_progress(progress)
        _gatcha_rebuild_status(progress, f"正在重建 UID {mid} 的抽卡缓存 ({index}/{len(configured_uids)})...")

        profile = _request_gatcha_uid_profile(mid)
        normalized_profile = _normalize_gatcha_profile(profile.get("uid"), profile) or profile
        normalized_mid = str(normalized_profile.get("uid") or mid)
        uid_temp.setdefault("profiles", {})[normalized_mid] = normalized_profile
        cache_temp.setdefault("profiles", {})[normalized_mid] = normalized_profile
        _save_gatcha_uid_temp(uid_temp)
        _save_gatcha_cache_temp(cache_temp)

        def _save_uid_progress(entries: list[dict]) -> None:
            cache_temp.setdefault("uids", {})[normalized_mid] = _dedupe_gatcha_entries(entries)
            cache_temp["updated_at"] = time.time()
            progress["current_uid_entry_count"] = len(cache_temp["uids"][normalized_mid])
            _save_gatcha_cache_temp(cache_temp)
            _save_gatcha_rebuild_progress(progress)

        fetched_entries = _fetch_gatcha_videos_for_uid(normalized_mid, on_progress=_save_uid_progress)
        cache_temp.setdefault("uids", {})[normalized_mid] = _dedupe_gatcha_entries(fetched_entries)
        cache_temp["updated_at"] = time.time()
        completed_uids.add(mid)
        completed_uids.add(normalized_mid)
        progress["completed_uids"] = sorted(completed_uids)
        progress.pop("current_uid_entry_count", None)
        _save_gatcha_cache_temp(cache_temp)
        _save_gatcha_uid_temp(uid_temp)
        _save_gatcha_rebuild_progress(progress)

    current_favlist = _load_gatcha_favlist()
    favlist_temp = _load_gatcha_favlist_temp(current_favlist)
    favlist_uid = str(favlist_temp.get("uid") or "").strip()
    folders = favlist_temp.get("folders") if isinstance(favlist_temp.get("folders"), list) else []
    progress.update({"phase": "favlist", "favlist_total": len(folders)})
    _save_gatcha_rebuild_progress(progress)
    if folders:
        for index, folder in enumerate(folders, start=1):
            if not isinstance(folder, dict):
                continue
            folder_uid = _favlist_folder_uid(folder, favlist_uid)
            folder_id = _gatcha_favlist_media_id(folder)
            progress_folder_key = _favlist_browser_id(folder_uid, folder_id)
            if not folder_uid or not folder_id or progress_folder_key in completed_folders:
                continue
            progress.update({"current_folder_id": folder_id, "favlist_index": index})
            _save_gatcha_rebuild_progress(progress)
            _gatcha_rebuild_status(progress, f"正在重建收藏夹缓存 ({index}/{len(folders)})...")
            entries = _fetch_gatcha_favlist_entries_for_folder(folder_uid, folder)
            favlist_temp["items"] = _dedupe_gatcha_entries(list(favlist_temp.get("items") or []) + entries)
            favlist_temp["updated_at"] = time.time()
            completed_folders.add(progress_folder_key)
            progress["completed_folders"] = sorted(completed_folders)
            _save_gatcha_favlist_temp(favlist_temp)
            _save_gatcha_rebuild_progress(progress)
    else:
        _save_gatcha_favlist_temp(favlist_temp)

    _merge_current_gatcha_changes_into_rebuild(uid_temp, cache_temp)
    uid_temp["updated_at"] = time.time()
    cache_temp["updated_at"] = time.time()
    favlist_temp["updated_at"] = time.time()
    _save_gatcha_uid_temp(uid_temp)
    _save_gatcha_cache_temp(cache_temp)
    _save_gatcha_favlist_temp(favlist_temp)

    _replace_gatcha_file_from_temp(_GATCHA_UIDS_TEMP_FILE, _GATCHA_UIDS_FILE)
    _replace_gatcha_file_from_temp(_GATCHA_CACHE_TEMP_FILE, _GATCHA_CACHE_FILE)
    _replace_gatcha_file_from_temp(_GATCHA_FAVLIST_TEMP_FILE, _GATCHA_FAVLIST_FILE)
    _cleanup_gatcha_rebuild_temp_files()

    rebuilt_payload = {
        "uids": cache_temp.get("uids") if isinstance(cache_temp.get("uids"), dict) else {},
        "profiles": cache_temp.get("profiles") if isinstance(cache_temp.get("profiles"), dict) else {},
        "refresh_summary": {
            "uids": [
                {
                    "uid": uid,
                    "mode": "rebuild",
                    "added_count": len(entries) if isinstance(entries, list) else 0,
                    "total_count": len(entries) if isinstance(entries, list) else 0,
                }
                for uid, entries in (cache_temp.get("uids") or {}).items()
            ],
            "errors": [],
            "favlist_error": "",
            "updated_at": time.time(),
        },
    }
    result = _gatcha_refresh_task_result(rebuilt_payload)
    result["rebuild"] = {
        "completed": True,
        "uid_count": len(configured_uids),
        "favlist_folder_count": len(folders),
    }
    return result


def refresh_gatcha_cache_in_background(
    *,
    on_start: callable | None = None,
    on_done: callable | None = None,
    use_global_lock: bool = True,
    upload_default_uids_to_lark: bool = True,
    startup_schema_rebuild: bool = False,
) -> bool:
    if use_global_lock:
        if not rust_runtime.try_begin_gatcha_refresh(
            busy_message=GATCHA_TASK_BUSY_MESSAGE,
            task={
                "status": "running",
                "message": GATCHA_TASK_BUSY_MESSAGE,
                "blocking": True,
            },
        ):
            return False
        if on_start is not None:
            on_start()
    else:
        _set_gatcha_task_status("running", message=GATCHA_TASK_BUSY_MESSAGE, blocking=not startup_schema_rebuild)

    def _worker() -> None:
        cache_payload: dict | None = None
        task_status = "failed"
        try:
            if startup_schema_rebuild and _gatcha_schema_rebuild_needed():
                result = rebuild_gatcha_files_for_latest_schema()
                task_status = "success"
                message = "抽卡缓存格式重建完成。"
                _set_gatcha_task_status(task_status, message=message, result=result, blocking=False)
                rebuilt_cache = _load_gatcha_cache()
                entries = _gatcha_cache_payload_entries(rebuilt_cache)
                favlist_entries = _local_gatcha_favlist_candidates()
                if entries or favlist_entries:
                    _append_lark_pool_entries_async(entries + favlist_entries)
                return

            cache_payload = refresh_gatcha_cache()
            result = _gatcha_refresh_task_result(cache_payload)
            has_errors = bool(result.get("errors") or result.get("favlist_error"))
            has_uid_success = bool(result.get("uid_results"))
            if has_errors and not has_uid_success:
                task_status = "failed"
                message = "抽卡缓存更新失败，未成功拉取任何 UID。"
            elif has_errors:
                task_status = "partial"
                message = "抽卡缓存已部分更新，但有 UID 或收藏夹拉取失败。"
            else:
                task_status = "success"
                message = "抽卡缓存更新完成。"
            _set_gatcha_task_status(task_status, message=message, result=result)
        except Exception as exc:
            _set_gatcha_task_status("failed", message="抽卡缓存更新失败。", error=str(exc))
            return
        finally:
            if use_global_lock:
                rust_runtime.release_gatcha_refresh()
                if on_done is not None:
                    on_done()
        if cache_payload is not None and task_status != "failed":
            entries = _gatcha_cache_payload_entries(cache_payload)
            if entries:
                _append_lark_pool_entries_async(entries)

    threading.Thread(target=_worker, daemon=True, name="gatcha-cache-refresh").start()
    return True


def _py_add_gatcha_uid(raw_mid: object, *, on_start: callable | None = None, on_done: callable | None = None) -> dict:
    if not rust_runtime.try_begin_gatcha_refresh(
        busy_message=GATCHA_TASK_BUSY_MESSAGE
    ):
        raise BilibiliError(GATCHA_TASK_BUSY_MESSAGE)
    entries: list[dict] = []
    try:
        if on_start is not None:
            on_start()
        preview = _py_preview_gatcha_uid(raw_mid)
        mid = preview["uid"]
        with _GATCHA_UIDS_LOCK:
            uid_payload = _load_gatcha_uid_payload()
            uids = uid_payload.get("uids") if isinstance(uid_payload, dict) else []
            if not isinstance(uids, list):
                uids = []
            added = False
            if mid in uids:
                uids = list(uids)
            else:
                uids.append(mid)
                uid_payload["uids"] = uids
                added = True
            profiles = uid_payload.get("profiles")
            if not isinstance(profiles, dict):
                profiles = {}
            profiles[mid] = {
                "uid": mid,
                "name": preview["name"],
                "space_url": preview["space_url"],
            }
            if preview.get("avatar_url"):
                profiles[mid]["avatar_url"] = preview["avatar_url"]
            uid_payload["profiles"] = profiles
            uid_payload["updated_at"] = time.time()
            _save_gatcha_uid_payload(uid_payload)

        with _GATCHA_CACHE_LOCK:
            cache_payload = _load_gatcha_cache()
        cache_profiles = cache_payload.get("profiles") if isinstance(cache_payload, dict) else {}
        if not isinstance(cache_profiles, dict):
            cache_profiles = {}
        cache_profiles[mid] = {
            "uid": mid,
            "name": preview["name"],
            "space_url": preview["space_url"],
        }
        if preview.get("avatar_url"):
            cache_profiles[mid]["avatar_url"] = preview["avatar_url"]
        cache_payload["profiles"] = cache_profiles
        cache_result = _refresh_gatcha_uid_cache(cache_payload, mid)
        with _GATCHA_CACHE_LOCK:
            fresh_cache_payload = _load_gatcha_cache()
        entries = _gatcha_cache_payload_entries(
            {
                "uids": {mid: fresh_cache_payload.get("uids", {}).get(mid, [])},
                "profiles": {mid: fresh_cache_payload.get("profiles", {}).get(mid, {})},
            }
        )
        temp_profile = fresh_cache_payload.get("profiles", {}).get(mid, {}) if isinstance(fresh_cache_payload, dict) else {}
        if not isinstance(temp_profile, dict):
            temp_profile = {
                "uid": mid,
                "name": preview["name"],
                "space_url": preview["space_url"],
                "avatar_url": preview.get("avatar_url", ""),
            }
        _merge_added_uid_into_rebuild_temp(mid, temp_profile, entries)
    finally:
        rust_runtime.release_gatcha_refresh()
        if on_done is not None:
            on_done()
    if entries:
        _append_lark_pool_entries_async(entries)

    return {
        "uid": mid,
        "name": preview["name"],
        "space_url": preview["space_url"],
        "avatar_url": preview.get("avatar_url", ""),
        "added": added,
        "uids": list(uids),
        "cache": cache_result,
    }


def preview_gatcha_uid(raw_mid: object) -> dict:
    if not effective_bilibili_cookie():
        raise BilibiliError(MISSING_BILIBILI_COOKIE_MESSAGE)
    return _rust_gatcha_network("preview_uid", uid=_normalize_gatcha_uid(raw_mid))


def add_gatcha_uid(
    raw_mid: object,
    *,
    on_start: callable | None = None,
    on_done: callable | None = None,
) -> dict:
    if not rust_runtime.try_begin_gatcha_refresh(busy_message=GATCHA_TASK_BUSY_MESSAGE):
        raise BilibiliError(GATCHA_TASK_BUSY_MESSAGE)
    entries: list[dict] = []
    try:
        if on_start is not None:
            on_start()
        result = _rust_gatcha_network(
            "add_uid",
            uid=_normalize_gatcha_uid(raw_mid),
            keywords=list(GATCHA_KEYWORDS),
        )
        raw_entries = result.pop("entries", [])
        if isinstance(raw_entries, list):
            entries = [entry for entry in raw_entries if isinstance(entry, dict)]
    finally:
        rust_runtime.release_gatcha_refresh()
        if on_done is not None:
            on_done()
    if entries:
        _append_lark_pool_entries_async(entries)
    return result


def refresh_gatcha_cache() -> dict:
    if not effective_bilibili_cookie():
        raise BilibiliError(MISSING_BILIBILI_COOKIE_MESSAGE)
    return _rust_gatcha_network("refresh_all", keywords=list(GATCHA_KEYWORDS))


def preview_gatcha_favlist(raw_mid: object) -> dict:
    return _rust_gatcha_network(
        "preview_favlist",
        uid=_normalize_gatcha_uid(raw_mid),
        folder_keywords=list(_GATCHA_FAVLIST_TITLE_KEYWORDS),
    )


def refresh_gatcha_favlist(
    raw_mid: object,
    raw_folder_ids: object = None,
    *,
    on_start: callable | None = None,
    on_done: callable | None = None,
) -> dict:
    if not rust_runtime.try_begin_gatcha_refresh(busy_message=GATCHA_TASK_BUSY_MESSAGE):
        raise BilibiliError(GATCHA_TASK_BUSY_MESSAGE)
    entries: list[dict] = []
    try:
        if on_start is not None:
            on_start()
        folder_ids = None
        if raw_folder_ids is not None:
            folder_ids = sorted(_selected_gatcha_favlist_folder_ids(raw_folder_ids) or set())
        result = _rust_gatcha_network(
            "refresh_favlist",
            uid=_normalize_gatcha_uid(raw_mid),
            folder_ids=folder_ids,
            folder_keywords=list(_GATCHA_FAVLIST_TITLE_KEYWORDS),
        )
        raw_entries = result.pop("entries", [])
        if isinstance(raw_entries, list):
            entries = [entry for entry in raw_entries if isinstance(entry, dict)]
    finally:
        rust_runtime.release_gatcha_refresh()
        if on_done is not None:
            on_done()
    if entries:
        _append_lark_pool_entries_async(entries)
    return result


def _local_gatcha_candidates() -> list[dict]:
    with _GATCHA_CACHE_LOCK:
        cache_payload = _load_gatcha_cache()

    candidates: list[dict] = []
    uid_payload = cache_payload.get("uids") or {}
    for raw_mid in _configured_gatcha_uids():
        entries = uid_payload.get(str(raw_mid), [])
        if not isinstance(entries, list):
            continue
        candidates.extend(entry for entry in entries if isinstance(entry, dict))
    return candidates


def _local_gatcha_favlist_candidates() -> list[dict]:
    with _GATCHA_FAVLIST_LOCK:
        payload = _load_gatcha_favlist()
    items = payload.get("items") if isinstance(payload, dict) else []
    return [entry for entry in _dedupe_gatcha_entries(items) if isinstance(entry, dict)]


def _local_gatcha_candidates_by_uid() -> dict[str, list[dict]]:
    with _GATCHA_CACHE_LOCK:
        cache_payload = _load_gatcha_cache()

    grouped_candidates: dict[str, list[dict]] = {}
    uid_payload = cache_payload.get("uids") or {}
    for raw_mid in _configured_gatcha_uids():
        mid = str(raw_mid).strip()
        if not mid:
            continue
        entries = uid_payload.get(mid, [])
        if not isinstance(entries, list):
            continue
        valid_entries = [entry for entry in entries if isinstance(entry, dict)]
        if valid_entries:
            grouped_candidates[mid] = valid_entries
    return grouped_candidates


def _gatcha_cache_payload_entries(cache_payload: dict, *, exclude_uids: set[str] | None = None) -> list[dict]:
    uid_entries = cache_payload.get("uids") if isinstance(cache_payload, dict) else {}
    if not isinstance(uid_entries, dict):
        return []
    profiles = cache_payload.get("profiles") if isinstance(cache_payload, dict) else {}
    if not isinstance(profiles, dict):
        profiles = {}
    excluded = {str(uid).strip() for uid in (exclude_uids or set()) if str(uid).strip()}
    entries: list[dict] = []
    for mid, raw_entries in uid_entries.items():
        if str(mid).strip() in excluded:
            continue
        if not isinstance(raw_entries, list):
            continue
        profile = profiles.get(str(mid)) if isinstance(profiles.get(str(mid)), dict) else {}
        for entry in raw_entries:
            if not isinstance(entry, dict):
                continue
            payload = dict(entry)
            payload.setdefault("mid", str(mid))
            if profile:
                payload.setdefault("owner_name", str(profile.get("name") or ""))
                payload.setdefault("owner_url", str(profile.get("space_url") or ""))
            entries.append(payload)
    return entries


def _append_lark_pool_entries_async(entries: list[dict]) -> None:
    try:
        append_lark_pool_entries_in_background(entries)
    except Exception:
        pass


def _py_search_gatcha_cache(query: str, *, limit: int = 30) -> list[dict]:
    normalized_query = str(query or "").strip().lower()
    if not normalized_query:
        return []

    local_candidates = _local_gatcha_candidates() + _local_gatcha_favlist_candidates()
    if not local_candidates and not effective_bilibili_cookie():
        raise BilibiliError(MISSING_BILIBILI_COOKIE_MESSAGE)

    results: list[dict] = []
    for entry in local_candidates:
        title = str(entry.get("title") or "")
        if normalized_query not in title.lower():
            continue
        results.append(
            _gatcha_entry_payload(entry)
        )
        if len(results) >= max(1, int(limit)):
            break
    return _annotate_gatcha_owner_avatars(results)


def search_gatcha_cache(query: str, *, limit: int = 30) -> list[dict]:
    result = _rust_gatcha_repository(
        "search",
        query=str(query or ""),
        limit=max(1, int(limit)),
    )
    items = result.get("items")
    return _annotate_gatcha_owner_avatars(list(items)) if isinstance(items, list) else []


def _gatcha_entry_payload(entry: dict) -> dict:
    payload = {
        "mid": str(entry.get("mid") or ""),
        "bvid": str(entry.get("bvid") or ""),
        "title": str(entry.get("title") or ""),
        "url": str(entry.get("url") or ""),
        "owner_name": str(entry.get("owner_name") or entry.get("author") or ""),
        "owner_url": str(entry.get("owner_url") or ""),
    }
    for key in ("source", "fav_uid", "fav_folder_title", "cover_url", "played_count", "preserved_1"):
        value = str(entry.get(key) or "").strip()
        if value:
            payload[key] = value
    return payload


def _cached_gatcha_profile_indexes() -> tuple[dict[str, dict], dict[str, dict]]:
    with _GATCHA_UIDS_LOCK:
        uid_payload = _load_gatcha_uid_payload()
    with _GATCHA_CACHE_LOCK:
        cache_payload = _load_gatcha_cache()

    profiles_by_uid: dict[str, dict] = {}
    for payload in (cache_payload, uid_payload):
        profiles = payload.get("profiles") if isinstance(payload, dict) else {}
        if not isinstance(profiles, dict):
            continue
        for raw_uid, raw_profile in profiles.items():
            if not isinstance(raw_profile, dict):
                continue
            uid = str(raw_profile.get("uid") or raw_uid or "").strip()
            if not uid:
                continue
            merged = dict(profiles_by_uid.get(uid) or {})
            merged.update({key: value for key, value in raw_profile.items() if str(value or "").strip()})
            profiles_by_uid[uid] = merged

    profiles_by_name: dict[str, dict] = {}
    duplicate_names: set[str] = set()
    for profile in profiles_by_uid.values():
        name_key = str(profile.get("name") or "").strip().casefold()
        if not name_key:
            continue
        if name_key in profiles_by_name:
            duplicate_names.add(name_key)
            continue
        profiles_by_name[name_key] = profile
    for name_key in duplicate_names:
        profiles_by_name.pop(name_key, None)
    return profiles_by_uid, profiles_by_name


def _annotate_gatcha_owner_avatars(items: list[dict]) -> list[dict]:
    profiles_by_uid, profiles_by_name = _cached_gatcha_profile_indexes()
    annotated: list[dict] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        next_item = dict(item)
        if str(next_item.get("owner_avatar_url") or next_item.get("avatar_url") or "").strip():
            annotated.append(next_item)
            continue

        owner_name = str(next_item.get("owner_name") or next_item.get("author") or "").strip()
        owner_name_key = owner_name.casefold()
        profile = profiles_by_name.get(owner_name_key) if owner_name_key else None
        if profile is None:
            owner_uid = str(next_item.get("owner_mid") or next_item.get("mid") or "").strip()
            uid_profile = profiles_by_uid.get(owner_uid)
            uid_profile_name = str((uid_profile or {}).get("name") or "").strip().casefold()
            if uid_profile is not None and (not owner_name_key or uid_profile_name == owner_name_key):
                profile = uid_profile
        avatar_url = str((profile or {}).get("avatar_url") or "").strip()
        if avatar_url:
            next_item["owner_avatar_url"] = avatar_url
        annotated.append(next_item)
    return annotated


def annotate_gatcha_local_status(items: list[dict]) -> list[dict]:
    if not isinstance(items, list):
        return []

    followed_by_bvid: dict[str, dict] = {}
    for entry in _local_gatcha_candidates():
        if not isinstance(entry, dict):
            continue
        bvid = str(entry.get("bvid") or "").strip()
        if bvid:
            followed_by_bvid.setdefault(bvid, entry)

    favorited_by_bvid: dict[str, dict] = {}
    for entry in _local_gatcha_favlist_candidates():
        if not isinstance(entry, dict):
            continue
        bvid = str(entry.get("bvid") or "").strip()
        if bvid:
            favorited_by_bvid.setdefault(bvid, entry)

    annotated: list[dict] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        next_item = dict(item)
        bvid = str(next_item.get("bvid") or "").strip()
        if bvid in favorited_by_bvid:
            local_entry = favorited_by_bvid[bvid]
            next_item["local_source"] = "favlist"
            next_item.setdefault("fav_uid", str(local_entry.get("fav_uid") or ""))
            next_item.setdefault("fav_folder_title", str(local_entry.get("fav_folder_title") or ""))
        elif bvid in followed_by_bvid:
            local_entry = followed_by_bvid[bvid]
            next_item["local_source"] = "follow"
            next_item.setdefault("mid", str(local_entry.get("mid") or ""))
        annotated.append(next_item)
    return _annotate_gatcha_owner_avatars(annotated)


def _profile_from_cached_entries(mid: str, entries: list[dict]) -> dict:
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        owner_name = str(entry.get("owner_name") or entry.get("author") or "").strip()
        if owner_name:
            return {
                "uid": mid,
                "name": owner_name,
                "space_url": str(entry.get("owner_url") or f"https://space.bilibili.com/{mid}"),
            }
    return {
        "uid": mid,
        "name": f"UID {mid}",
        "space_url": f"https://space.bilibili.com/{mid}",
    }


def _py_browse_gatcha_cache(uid: str = "", query: str = "") -> dict:
    with _GATCHA_UIDS_LOCK:
        uid_payload = _load_gatcha_uid_payload()
    configured_uids = uid_payload.get("uids") if isinstance(uid_payload, dict) else []
    if not isinstance(configured_uids, list):
        configured_uids = []
    profiles = uid_payload.get("profiles") if isinstance(uid_payload, dict) else {}
    if not isinstance(profiles, dict):
        profiles = {}

    with _GATCHA_CACHE_LOCK:
        cache_payload = _load_gatcha_cache()
    cached_by_uid = cache_payload.get("uids") if isinstance(cache_payload, dict) else {}
    if not isinstance(cached_by_uid, dict):
        cached_by_uid = {}
    cache_profiles = cache_payload.get("profiles") if isinstance(cache_payload, dict) else {}
    if not isinstance(cache_profiles, dict):
        cache_profiles = {}

    owners: list[dict] = []
    for raw_mid in configured_uids:
        mid = str(raw_mid).strip()
        if not mid:
            continue
        entries = _dedupe_gatcha_entries(cached_by_uid.get(mid, []))
        profile = profiles.get(mid) if isinstance(profiles.get(mid), dict) else {}
        if not profile or not str(profile.get("name") or "").strip():
            profile = cache_profiles.get(mid) if isinstance(cache_profiles.get(mid), dict) else {}
        if not profile or not str(profile.get("name") or "").strip():
            profile = _profile_from_cached_entries(mid, entries)
        owners.append(
            {
                "uid": mid,
                "name": str(profile.get("name") or f"UID {mid}"),
                "space_url": str(profile.get("space_url") or f"https://space.bilibili.com/{mid}"),
                "avatar_url": str(profile.get("avatar_url") or ""),
                "count": len(entries),
            }
        )

    selected_uid = str(uid or "").strip()
    if selected_uid and selected_uid not in {owner["uid"] for owner in owners}:
        selected_uid = ""

    items: list[dict] = []
    normalized_query = str(query or "").strip().lower()
    if selected_uid:
        entries = _dedupe_gatcha_entries(cached_by_uid.get(selected_uid, []))
        for entry in entries:
            title = str(entry.get("title") or "")
            if normalized_query and normalized_query not in title.lower():
                continue
            items.append(_gatcha_entry_payload(entry))

    return {
        "owners": owners,
        "selected_uid": selected_uid,
        "query": str(query or "").strip(),
        "items": items,
        "updated_at": float(cache_payload.get("updated_at") or 0) if isinstance(cache_payload, dict) else 0,
    }


def _py_browse_gatcha_favlist(folder_id: str = "", query: str = "") -> dict:
    with _GATCHA_FAVLIST_LOCK:
        favlist_payload = _load_gatcha_favlist()
    folders_payload = favlist_payload.get("folders") if isinstance(favlist_payload, dict) else []
    if not isinstance(folders_payload, list):
        folders_payload = []
    legacy_favlist_uid = str(favlist_payload.get("uid") or "").strip() if isinstance(favlist_payload, dict) else ""

    with _GATCHA_UIDS_LOCK:
        uid_payload = _load_gatcha_uid_payload()
    uid_profiles = uid_payload.get("profiles") if isinstance(uid_payload, dict) else {}
    if not isinstance(uid_profiles, dict):
        uid_profiles = {}

    with _GATCHA_CACHE_LOCK:
        cache_payload = _load_gatcha_cache()
    cache_profiles = cache_payload.get("profiles") if isinstance(cache_payload, dict) else {}
    if not isinstance(cache_profiles, dict):
        cache_profiles = {}

    def avatar_for_uid(uid: str) -> str:
        profile = uid_profiles.get(uid) if isinstance(uid_profiles.get(uid), dict) else {}
        if not profile:
            profile = cache_profiles.get(uid) if isinstance(cache_profiles.get(uid), dict) else {}
        return str(profile.get("avatar_url") or "")

    folders: list[dict] = []
    for raw_folder in folders_payload:
        if not isinstance(raw_folder, dict):
            continue
        media_id = _gatcha_favlist_media_id(raw_folder)
        if not media_id:
            continue
        folder_uid = _favlist_folder_uid(raw_folder, legacy_favlist_uid)
        try:
            media_count = int(raw_folder.get("media_count") or 0)
        except (TypeError, ValueError):
            media_count = 0
        folders.append(
            {
                "id": _favlist_browser_id(folder_uid, media_id),
                "folder_id": media_id,
                "fid": str(raw_folder.get("fid") or ""),
                "title": str(raw_folder.get("title") or media_id),
                "media_count": media_count,
                "count": media_count,
                "uid": folder_uid,
                "avatar_url": avatar_for_uid(folder_uid),
            }
        )

    selected_folder_id = str(folder_id or "").strip()
    folder_ids = {folder["id"] for folder in folders}
    bare_folder_ids = {folder["folder_id"] for folder in folders}
    if selected_folder_id and selected_folder_id not in folder_ids and selected_folder_id in bare_folder_ids:
        selected_folder_id = next((folder["id"] for folder in folders if folder["folder_id"] == selected_folder_id), selected_folder_id)
    if selected_folder_id and selected_folder_id not in folder_ids:
        selected_folder_id = ""

    items: list[dict] = []
    normalized_query = str(query or "").strip().lower()
    if selected_folder_id:
        selected_uid, selected_media_id = _split_favlist_browser_id(selected_folder_id)
        raw_items = favlist_payload.get("items") if isinstance(favlist_payload, dict) else []
        for entry in _dedupe_gatcha_entries(raw_items):
            if not isinstance(entry, dict):
                continue
            entry_folder_id = str(entry.get("fav_folder_id") or "").strip()
            entry_uid = str(entry.get("fav_uid") or legacy_favlist_uid or "").strip()
            if entry_folder_id != selected_media_id:
                continue
            if selected_uid and entry_uid != selected_uid:
                continue
            title = str(entry.get("title") or "")
            if normalized_query and normalized_query not in title.lower():
                continue
            items.append(_gatcha_entry_payload(entry))

    return {
        "folders": folders,
        "selected_folder_id": selected_folder_id,
        "query": str(query or "").strip(),
        "items": items,
        "updated_at": float(favlist_payload.get("updated_at") or 0) if isinstance(favlist_payload, dict) else 0,
    }


def gatcha_favlist_updated_at() -> float:
    result = _rust_gatcha_repository("favlist_updated_at")
    return float(result.get("updated_at") or 0)


def browse_gatcha_cache(uid: str = "", query: str = "") -> dict:
    return _rust_gatcha_repository(
        "browse_uid",
        uid=str(uid or ""),
        query=str(query or ""),
    )


def browse_gatcha_favlist(folder_id: str = "", query: str = "") -> dict:
    return _rust_gatcha_repository(
        "browse_favlist",
        folder_id=str(folder_id or ""),
        query=str(query or ""),
    )


def _py_request_json(url: str) -> dict:
    headers = dict(BILIBILI_HEADERS)
    headers.pop("Cookie", None)
    cookie = effective_bilibili_cookie()
    if cookie:
        headers["Cookie"] = cookie
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.loads(response.read().decode("utf-8"))


def request_json(url: str) -> dict:
    headers = dict(BILIBILI_HEADERS)
    headers.pop("Cookie", None)
    cookie = effective_bilibili_cookie()
    if cookie:
        headers["Cookie"] = cookie
    try:
        payload = rust_runtime.json_http_request(
            "GET",
            url,
            headers={str(name): str(value) for name, value in headers.items()},
            timeout=15,
        )
    except rust_runtime.RustRuntimeUnavailableError:
        return _py_request_json(url)
    except rust_runtime.RustRuntimeServiceError as exc:
        raise BilibiliError(str(exc)) from exc
    if not isinstance(payload, dict):
        raise BilibiliError("B 站接口响应格式异常")
    return payload


def _py_resolve_short_url(url: str) -> str:
    request = urllib.request.Request(url, headers=BILIBILI_HEADERS, method="GET")
    with urllib.request.urlopen(request, timeout=15) as response:
        return response.geturl()


def resolve_video_reference(raw_input: str) -> VideoReference:
    cleaned = raw_input.strip()
    if not cleaned:
        raise BilibiliError("请输入 B 站视频链接")

    if BV_RE.match(cleaned):
        cleaned = f"https://www.bilibili.com/video/{cleaned}"
    elif AV_RE.match(cleaned):
        cleaned = f"https://www.bilibili.com/video/{cleaned}"
    elif not cleaned.startswith(("http://", "https://")):
        cleaned = f"https://{cleaned}"

    resolved_url = cleaned
    parsed = urllib.parse.urlparse(cleaned)
    if parsed.netloc.lower() in SHORT_HOSTS:
        try:
            resolved_url = rust_runtime.resolve_bilibili_redirect(
                cleaned,
                cookie=effective_bilibili_cookie(),
                user_agent=str(BILIBILI_HEADERS.get("User-Agent") or ""),
                referer=str(BILIBILI_HEADERS.get("Referer") or ""),
            )
        except rust_runtime.RustRuntimeUnavailableError:
            resolved_url = _py_resolve_short_url(cleaned)
        except rust_runtime.RustRuntimeServiceError as exc:
            raise BilibiliError(str(exc)) from exc

    parsed = urllib.parse.urlparse(resolved_url)
    match = VIDEO_PATH_RE.search(parsed.path)
    if not match:
        raise BilibiliError("当前仅支持普通 B 站视频 URL 或 BV/av 号")

    raw_vid = match.group("vid")
    query = urllib.parse.parse_qs(parsed.query)
    page = int(query.get("p", ["1"])[0] or "1")
    if raw_vid.lower().startswith("bv"):
        return VideoReference(
            original_url=cleaned,
            resolved_url=resolved_url,
            bvid=raw_vid,
            page=max(page, 1),
        )
    return VideoReference(
        original_url=cleaned,
        resolved_url=resolved_url,
        aid=int(raw_vid[2:]),
        page=max(page, 1),
    )


def parse_video_pages(data: dict) -> list[VideoPage]:
    raw_pages = data.get("pages") or []
    pages: list[VideoPage] = []
    for index, payload in enumerate(raw_pages, start=1):
        if not isinstance(payload, dict):
            continue
        page_number = int(payload.get("page") or index)
        cid = int(payload.get("cid") or 0)
        if cid <= 0:
            continue
        duration = int(payload.get("duration") or 0)
        part = str(payload.get("part") or f"P{page_number}").strip() or f"P{page_number}"
        pages.append(VideoPage(page=page_number, cid=cid, duration=duration, part=part))
        
    valid_pages = [p for p in pages if p.duration >= 10]
    if valid_pages and len(valid_pages) < len(pages):
        return valid_pages
        
    return pages


def _py_cluster_spread(cluster: list[VideoPage]) -> int:
    if not cluster:
        return 10**9
    durations = [page.duration for page in cluster]
    return max(durations) - min(durations)


def _py_cluster_representative_duration(cluster: list[VideoPage]) -> float:
    if not cluster:
        return 0.0
    return sum(page.duration for page in cluster) / len(cluster)


def _py_preferred_or_first_page(pages: list[VideoPage], preferred_page: int) -> VideoPage:
    for page in pages:
        if page.page == preferred_page:
            return page
    return pages[0]


def _py_is_better_cluster(candidate: list[VideoPage], current: list[VideoPage], preferred_page: int) -> bool:
    if len(candidate) != len(current):
        return len(candidate) > len(current)

    candidate_duration = _py_cluster_representative_duration(candidate)
    current_duration = _py_cluster_representative_duration(current)
    if candidate_duration != current_duration:
        return candidate_duration > current_duration

    candidate_has_preferred = any(page.page == preferred_page for page in candidate)
    current_has_preferred = any(page.page == preferred_page for page in current)
    if candidate_has_preferred != current_has_preferred:
        return candidate_has_preferred

    candidate_spread = _py_cluster_spread(candidate)
    current_spread = _py_cluster_spread(current)
    if candidate_spread != current_spread:
        return candidate_spread < current_spread

    return [page.page for page in candidate] < [page.page for page in current]


def _py_select_matching_pages(
    pages: list[VideoPage],
    *,
    preferred_page: int,
    tolerance_seconds: int = DURATION_TOLERANCE_SECONDS,
) -> list[VideoPage]:
    if len(pages) <= 1:
        return list(pages)

    sorted_pages = sorted(pages, key=lambda item: (item.duration, item.page))
    best_cluster: list[VideoPage] = []
    left = 0

    for right, current in enumerate(sorted_pages):
        while current.duration - sorted_pages[left].duration > tolerance_seconds:
            left += 1
        candidate = sorted_pages[left : right + 1]
        if _py_is_better_cluster(candidate, best_cluster, preferred_page):
            best_cluster = list(candidate)

    if len(best_cluster) <= 1:
        return best_cluster or [_py_preferred_or_first_page(pages, preferred_page)]
    return sorted(best_cluster, key=lambda item: item.page)


def select_matching_pages(
    pages: list[VideoPage],
    *,
    preferred_page: int,
    tolerance_seconds: int = DURATION_TOLERANCE_SECONDS,
) -> list[VideoPage]:
    descriptors = []
    for idx, page in enumerate(pages):
        if not isinstance(page, VideoPage):
            return rust_backend.python_fallback(
                "select_media_pages",
                lambda: _py_select_matching_pages(
                    pages,
                    preferred_page=preferred_page,
                    tolerance_seconds=tolerance_seconds,
                ),
            )
        descriptors.append({
            "original_index": idx,
            "page": int(page.page),
            "cid": int(page.cid),
            "duration": int(page.duration),
            "part": str(page.part or ""),
        })

    request: dict[str, object] = {
        "schema_version": 1,
        "preferred_page": int(preferred_page),
        "tolerance_seconds": int(tolerance_seconds),
        "pages": descriptors,
    }

    completed, response = rust_backend.try_select_media_pages(request)
    if completed and response is not None:
        status = response.get("status")
        if status == "selected":
            selected_indices = response.get("selected_indices")
            if isinstance(selected_indices, list):
                result = []
                for idx in selected_indices:
                    if isinstance(idx, int) and not isinstance(idx, bool) and 0 <= idx < len(pages):
                        result.append(pages[idx])
                    else:
                        return rust_backend.python_fallback(
                            "select_media_pages",
                            lambda: _py_select_matching_pages(
                                pages,
                                preferred_page=preferred_page,
                                tolerance_seconds=tolerance_seconds,
                            ),
                        )
                return result
        elif status == "no_match":
            return []

    return rust_backend.python_fallback(
        "select_media_pages",
        lambda: _py_select_matching_pages(
            pages,
            preferred_page=preferred_page,
            tolerance_seconds=tolerance_seconds,
        ),
    )


def _is_better_cluster(candidate: list[VideoPage], current: list[VideoPage], preferred_page: int) -> bool:
    return _py_is_better_cluster(candidate, current, preferred_page)


def _cluster_spread(cluster: list[VideoPage]) -> int:
    return _py_cluster_spread(cluster)


def _cluster_representative_duration(cluster: list[VideoPage]) -> float:
    return _py_cluster_representative_duration(cluster)


def _preferred_or_first_page(pages: list[VideoPage], preferred_page: int) -> VideoPage:
    return _py_preferred_or_first_page(pages, preferred_page)


def _variant_id(page: int, label: str, index: int) -> str:
    normalized = re.sub(r"[^a-z0-9]+", "_", label.lower()).strip("_")
    suffix = normalized or f"track_{index + 1}"
    return f"p{max(int(page), 1)}_{suffix}"


def _py_part_keyword_match(part: str) -> bool:
    normalized = str(part or "").strip().lower()
    return any(keyword in normalized for keyword in ("on", "off", "人声", "原唱", "伴奏"))


def _py_part_vocal_role(part: str) -> str | None:
    normalized = str(part or "").strip().lower()
    tokens = [token for token in re.split(r"[^a-z0-9]+", normalized) if token]
    has_vocal = "vocal" in tokens
    is_on = (
        "人声" in normalized
        or "原唱" in normalized
        or "onvocal" in tokens
        or (has_vocal and "on" in tokens)
    )
    is_off = (
        "伴奏" in normalized
        or "offvocal" in tokens
        or (has_vocal and "off" in tokens)
    )
    if is_on == is_off:
        return None
    return "on" if is_on else "off"


def _py_is_auto_dual_audio_pair(
    pages: list[VideoPage],
    tolerance_seconds: int = DURATION_TOLERANCE_SECONDS,
) -> bool:
    if len(pages) != 2:
        return False
    if not any(_py_part_keyword_match(page.part) for page in pages):
        return False
    if abs(pages[0].duration - pages[1].duration) > tolerance_seconds:
        return False
    return True


def _py_auto_dual_audio_video_index(pages: list[VideoPage]) -> int | None:
    if len(pages) != 2:
        return None
    vocal_roles = [_py_part_vocal_role(page.part) for page in pages]
    if sorted(role for role in vocal_roles if role is not None) == ["off", "on"]:
        return vocal_roles.index("on")
    return None


def _py_auto_dual_audio_video_page(pages: list[VideoPage]) -> int | None:
    automatic_video_index = _py_auto_dual_audio_video_index(pages)
    if automatic_video_index is None:
        return None
    return pages[automatic_video_index].page


def _py_requires_manual_binding(
    pages: list[VideoPage],
    tolerance_seconds: int = DURATION_TOLERANCE_SECONDS,
) -> bool:
    if len(pages) > 2:
        return True
    if len(pages) == 2 and not _py_is_auto_dual_audio_pair(
        pages, tolerance_seconds
    ):
        return True
    return False


def _py_decide_audio_binding(
    pages: list[VideoPage],
    tolerance_seconds: int = DURATION_TOLERANCE_SECONDS,
) -> AudioBindingDecision | None:
    if not pages:
        return None
    if len(pages) == 1:
        return AudioBindingDecision(
            mode="single",
            selected_indices=(0,),
            automatic_video_index=None,
        )
    if not _py_is_auto_dual_audio_pair(pages, tolerance_seconds):
        return AudioBindingDecision(
            mode="manual_required",
            selected_indices=(),
            automatic_video_index=None,
        )

    automatic_video_index = _py_auto_dual_audio_video_index(pages)
    return AudioBindingDecision(
        mode="automatic",
        selected_indices=(0, 1),
        automatic_video_index=automatic_video_index,
    )


def _part_keyword_match(part: str) -> bool:
    return _py_part_keyword_match(part)


def _is_auto_dual_audio_pair(pages: list[VideoPage]) -> bool:
    return _py_is_auto_dual_audio_pair(pages)


def _auto_dual_audio_video_page(pages: list[VideoPage]) -> int | None:
    return _py_auto_dual_audio_video_page(pages)


def _requires_manual_binding(pages: list[VideoPage]) -> bool:
    return _py_requires_manual_binding(pages)


def decide_audio_binding(
    pages: list[VideoPage],
    tolerance_seconds: int = DURATION_TOLERANCE_SECONDS,
) -> AudioBindingDecision | None:
    descriptors: list[dict[str, object]] = []
    try:
        for original_index, page in enumerate(pages):
            if not isinstance(page, VideoPage):
                raise TypeError("pages must contain VideoPage values")
            descriptors.append(
                {
                    "original_index": original_index,
                    "page": int(page.page),
                    "duration": int(page.duration),
                    "part": str(page.part or ""),
                }
            )
        request: dict[str, object] = {
            "schema_version": 1,
            "tolerance_seconds": int(tolerance_seconds),
            "pages": descriptors,
        }
    except (AttributeError, TypeError, ValueError) as exc:
        raise rust_backend.PlaybackCapabilityError(
            "decide_audio_binding", "invalid request"
        ) from exc

    def decode_native(response: object) -> AudioBindingDecision | None:
        if not isinstance(response, dict):
            raise ValueError("invalid audio-binding response")
        if response.get("status") == "no_match":
            return None
        return AudioBindingDecision(
            mode=str(response["mode"]),
            selected_indices=tuple(response["selected_indices"]),
            automatic_video_index=response.get("automatic_video_index"),
        )

    return rust_backend.require_playback_capability(
        "decide_audio_binding",
        lambda: rust_backend.try_decide_audio_binding(
            request, allow_python_reference=False
        ),
        decode=decode_native,
    )


def _normalize_selected_pages(raw_pages: object) -> list[int]:
    if not isinstance(raw_pages, list):
        return []
    normalized: list[int] = []
    for value in raw_pages:
        try:
            page = int(value)
        except (TypeError, ValueError):
            continue
        if page > 0 and page not in normalized:
            normalized.append(page)
    return normalized


def fetch_owner_info(raw_input: str) -> tuple[int, str, str]:
    reference = resolve_video_reference(raw_input)
    data = _fetch_view_data(reference)
    owner = data.get("owner") or {}
    owner_mid = int(owner.get("mid") or 0)
    owner_name = str(owner.get("name") or "").strip()
    owner_url = f"https://space.bilibili.com/{owner_mid}" if owner_mid else ""
    return owner_mid, owner_name, owner_url


def fetch_video_item(
    raw_input: str,
    *,
    selected_video_page: int | None = None,
    selected_audio_pages: list[int] | None = None,
) -> PlaylistItem:
    reference = resolve_video_reference(raw_input)
    data = _fetch_view_data(reference)
    pages = parse_video_pages(data)
    if not pages:
        raise BilibiliError("视频没有可播放的分 P 信息")

    preferred_page = min(reference.page, len(pages))
    binding_decision = decide_audio_binding(pages)
    if binding_decision is None:
        raise BilibiliError("视频没有可播放的分 P 信息")
    manual_selection = binding_decision.mode == "manual_required"
    if manual_selection and selected_video_page is None and not selected_audio_pages:
        raise ManualBindingRequiredError(
            title=str(data.get("title") or "").strip(),
            pages=pages,
            preferred_page=preferred_page,
        )

    available_page_numbers = [page.page for page in pages]
    available_pages_by_number = {page.page: page for page in pages}
    normalized_audio_pages = _normalize_selected_pages(selected_audio_pages)
    auto_video_page = None
    if manual_selection:
        video_page = int(selected_video_page or preferred_page)
        if video_page not in available_pages_by_number:
            raise BilibiliError("选择的视频分P无效")
        if not normalized_audio_pages:
            normalized_audio_pages = [video_page]
        invalid_audio_pages = [page for page in normalized_audio_pages if page not in available_pages_by_number]
        if invalid_audio_pages:
            raise BilibiliError("选择的音频分P无效")
        selected_pages = [available_pages_by_number[page] for page in normalized_audio_pages]
    else:
        selected_pages = [pages[index] for index in binding_decision.selected_indices]
        if binding_decision.automatic_video_index is not None:
            auto_video_page = pages[binding_decision.automatic_video_index].page
        if selected_video_page is not None or normalized_audio_pages:
            raise BilibiliError("当前视频不需要手动绑定分P")

    selected_page_numbers = [page.page for page in selected_pages]
    if not selected_page_numbers:
        raise BilibiliError("至少需要选择一个音频分P")
    if manual_selection:
        video_page = int(selected_video_page or selected_page_numbers[0])
    else:
        video_page = auto_video_page or (preferred_page if preferred_page in selected_page_numbers else selected_page_numbers[0])
    video_page_info = available_pages_by_number[video_page]
    aid = int(data["aid"])
    bvid = str(data["bvid"])
    title = str(data.get("title") or "").strip()
    part_title = video_page_info.part
    display_title = f"{title} - {part_title}"
    owner = data.get("owner") or {}
    owner_mid = int(owner.get("mid") or 0)
    owner_name = str(owner.get("name") or "").strip()
    owner_url = f"https://space.bilibili.com/{owner_mid}" if owner_mid else ""
    embed_query = urllib.parse.urlencode(
        {
            "aid": aid,
            "bvid": bvid,
            "cid": video_page_info.cid,
            "page": video_page,
            "high_quality": 1,
            "danmaku": 0,
            "autoplay": 1,
            "isOutside": "true",
        }
    )
    embed_url = f"https://player.bilibili.com/player.html?{embed_query}"

    resolved_url_with_page = urllib.parse.urlunparse(
        urllib.parse.urlparse(reference.resolved_url)._replace(
            query=urllib.parse.urlencode(
                [
                    (key, value)
                    for key, value in urllib.parse.parse_qsl(
                        urllib.parse.urlparse(reference.resolved_url).query,
                        keep_blank_values=True,
                    )
                    if key != "p"
                ] + [("p", str(video_page))]
            )
        )
    )

    default_audio_page = video_page if video_page in selected_page_numbers else selected_page_numbers[0]
    default_audio_index = selected_page_numbers.index(default_audio_page)
    default_audio_part = selected_pages[default_audio_index].part

    return PlaylistItem(
        id=uuid.uuid4().hex[:12],
        original_url=reference.original_url,
        resolved_url=resolved_url_with_page,
        bvid=bvid,
        aid=aid,
        cid=video_page_info.cid,
        page=video_page,
        title=title,
        part_title=part_title,
        display_title=display_title,
        cover_url=str(data.get("pic") or ""),
        embed_url=embed_url,
        selected_pages=selected_page_numbers,
        selected_cids=[page.cid for page in selected_pages],
        selected_durations=[page.duration for page in selected_pages],
        selected_parts=[page.part for page in selected_pages],
        available_pages=available_page_numbers,
        available_cids=[page.cid for page in pages],
        available_durations=[page.duration for page in pages],
        available_parts=[page.part for page in pages],
        selected_audio_variant_id=_variant_id(default_audio_page, default_audio_part, default_audio_index),
        video_page=video_page,
        manual_selection=manual_selection,
        owner_mid=owner_mid,
        owner_name=owner_name,
        owner_url=owner_url,
    )


def _fetch_view_data(reference: VideoReference) -> dict:
    if reference.bvid:
        api_url = (
            "https://api.bilibili.com/x/web-interface/wbi/view?"
            f"bvid={urllib.parse.quote(reference.bvid)}"
        )
    else:
        api_url = (
            "https://api.bilibili.com/x/web-interface/wbi/view?"
            f"aid={reference.aid}"
        )

    payload = request_json(api_url)
    if payload.get("code") != 0:
        message = payload.get("message") or "获取视频信息失败"
        raise BilibiliError(message)
    return payload["data"]
def get_mixin_key(orig: str) -> str:
    return ''.join([orig[i] for i in WBI_MIXIN_TABLE])[:32]

def enc_wbi(params: dict, img_key: str, sub_key: str) -> dict:
    mixin_key = get_mixin_key(img_key + sub_key)
    curr_time = int(time.time())
    params['wts'] = curr_time  
    params = dict(sorted(params.items()))
    params = {
        k: ''.join([c for c in str(v) if c not in "!'()*"])
        for k, v in params.items()
    }
    query = urllib.parse.urlencode(params)
    w_rid = hashlib.md5((query + mixin_key).encode()).hexdigest()
    params['w_rid'] = w_rid
    return params

def get_wbi_keys() -> tuple[str, str]:
    nav_url = "https://api.bilibili.com/x/web-interface/nav"
    try:
        resp = request_json(nav_url)
    except Exception as e:
        raise BilibiliError(f"请求 nav 接口网络异常: {e}")

    if resp.get("code") != 0:
        msg = resp.get("message", "未知错误")
        code = resp.get("code", "unknown")
        raise BilibiliError(f"B 站接口返回错误: [{code}] {msg}")
    
    data = resp.get("data", {})
    wbi_img = data.get("wbi_img")
    
    if not wbi_img:
        raise BilibiliError("接口未返回 WBI 密钥信息，请检查 COOKIE 是否有效或 IP 是否被风控")
    
    img_url = wbi_img.get("img_url")
    sub_url = wbi_img.get("sub_url")
    
    if not img_url or not sub_url:
        raise BilibiliError("WBI 密钥 URL 格式不正确")

    img_key = img_url.split("/")[-1].split(".")[0]
    sub_key = sub_url.split("/")[-1].split(".")[0]
    return img_key, sub_key
def get_cached_wbi_keys():
    curr_time = time.time()
    if _WBI_CACHE["keys"] and (curr_time - _WBI_CACHE["last_update"] < 600):
        return _WBI_CACHE["keys"]
    
    keys = get_wbi_keys()
    _WBI_CACHE["keys"] = keys
    _WBI_CACHE["last_update"] = curr_time
    return keys

def fetch_dash_playurl(
    bvid: str,
    cid: int,
    *,
    avid: int = 0,
    qn: int = 127,
    fnval: int = 4048,
) -> dict:
    """Fetch DASH playurl from Bilibili API, returning stream URLs for video/audio.

    Args:
        bvid: BV ID of the video.
        cid: CID of the specific page.
        avid: AV ID (optional, derived from bvid if not given).
        qn: Quality ID (default 127 = 8K, API will auto-downgrade).
        fnval: DASH format flag (default 4048 = all DASH formats).

    Returns:
        Dict with keys:
          - "video": list of dicts with "url", "backup_urls", "codec_id", "codec_name", "width", "height"
          - "audio": list of dicts with "url", "backup_urls", "bandwidth"
          - "flac": dict or None with "url", "backup_urls" if Hi-Res FLAC available
          - "dolby": dict or None with "url", "backup_urls" if Dolby Atmos available
    """
    if not bvid and not avid:
        raise BilibiliError("bvid 和 avid 至少需要提供一个")

    try:
        img_key, sub_key = get_cached_wbi_keys()
    except Exception as exc:
        raise BilibiliError(f"WBI 签名失败: {exc}") from exc

    params = {
        "cid": str(cid),
        "qn": str(qn),
        "fnval": str(fnval),
        "fourk": "1",
        "platform": "web",
    }
    if avid:
        params["avid"] = str(avid)
    if bvid:
        params["bvid"] = bvid

    signed_params = enc_wbi(params, img_key, sub_key)
    query_string = urllib.parse.urlencode(signed_params)
    api_url = f"https://api.bilibili.com/x/player/wbi/playurl?{query_string}"

    payload = request_json(api_url)
    if not isinstance(payload, dict):
        raise BilibiliError("播放地址响应格式异常")
    code = int(payload.get("code") or 0) if isinstance(payload.get("code"), (int, float)) else 0
    if code != 0:
        message = str(payload.get("message") or "获取播放地址失败")
        kind = {
            -101: "authentication",
            -403: "forbidden",
            -404: "unavailable",
            -400: "invalid_request",
            -352: "risk_control",
            -412: "risk_control",
            412: "risk_control",
            62002: "unavailable",
        }.get(code, "api")
        if kind == "authentication":
            display_message = (
                f"Bilibili login/Cookie is invalid or expired (API {code})"
            )
        elif kind in {"forbidden", "unavailable"}:
            display_message = f"视频播放地址不可用: {message}"
        elif kind == "risk_control":
            display_message = f"请求被风控拦截: {message}"
        else:
            display_message = message
        error = BilibiliError(display_message)
        error.kind = kind
        error.api_code = code
        raise error

    data = payload.get("data")
    if not isinstance(data, dict):
        raise BilibiliError("播放地址响应格式异常")

    dash = data.get("dash")
    if not isinstance(dash, dict):
        durl_list = data.get("durl")
        if isinstance(durl_list, list) and durl_list:
            urls = []
            for segment in durl_list:
                if isinstance(segment, dict):
                    url = str(segment.get("url") or "").strip()
                    backup_urls = segment.get("backup_url") or []
                    urls.append({
                        "url": url,
                        "backup_urls": [str(u).strip() for u in backup_urls if u],
                        "order": int(segment.get("order") or 0),
                    })
            return {"video": urls, "audio": [], "flac": None, "dolby": None}
        raise BilibiliError("视频不支持 DASH 格式且无可回退地址")

    video_streams = []
    for video in dash.get("video") or []:
        if not isinstance(video, dict):
            continue
        base_url = str(video.get("baseUrl") or video.get("base_url") or "").strip()
        if not base_url:
            continue
        backup_urls = video.get("backupUrl") or video.get("backup_url") or []
        codec_id = int(video.get("codecid") or video.get("codecId") or 0)
        codec_map = {7: "avc", 12: "hevc", 13: "av1"}
        video_streams.append({
            "url": base_url,
            "backup_urls": [str(u).strip() for u in backup_urls if u],
            "codec_id": codec_id,
            "codec_name": codec_map.get(codec_id, f"codec_{codec_id}"),
            "codecs": str(video.get("codecs") or ""),
            "mime_type": str(video.get("mimeType") or video.get("mime_type") or ""),
            "width": int(video.get("width") or 0),
            "height": int(video.get("height") or 0),
            "quality_id": int(video.get("id") or 0),
            "bandwidth": int(video.get("bandwidth") or 0),
        })

    audio_streams = []
    for audio in dash.get("audio") or []:
        if not isinstance(audio, dict):
            continue
        base_url = str(audio.get("baseUrl") or audio.get("base_url") or "").strip()
        if not base_url:
            continue
        backup_urls = audio.get("backupUrl") or audio.get("backup_url") or []
        audio_streams.append({
            "url": base_url,
            "backup_urls": [str(u).strip() for u in backup_urls if u],
            "quality_id": int(audio.get("id") or 0),
            "bandwidth": int(audio.get("bandwidth") or 0),
            "codecs": str(audio.get("codecs") or ""),
            "mime_type": str(audio.get("mimeType") or ""),
        })

    flac_info = None
    flac = dash.get("flac")
    if isinstance(flac, dict):
        flac_audio = flac.get("audio")
        if isinstance(flac_audio, dict):
            flac_url = str(flac_audio.get("baseUrl") or flac_audio.get("base_url") or "").strip()
            if flac_url:
                flac_backup = flac_audio.get("backupUrl") or flac_audio.get("backup_url") or []
                flac_info = {
                    "url": flac_url,
                    "backup_urls": [str(u).strip() for u in flac_backup if u],
                    "quality_id": int(flac_audio.get("id") or 30251),
                    "bandwidth": int(flac_audio.get("bandwidth") or 0),
                    "codecs": str(flac_audio.get("codecs") or "flac"),
                    "mime_type": str(flac_audio.get("mimeType") or flac_audio.get("mime_type") or "audio/flac"),
                    "codec_name": "flac",
                }

    dolby_info = None
    dolby = dash.get("dolby")
    if isinstance(dolby, dict):
        dolby_audio_list = dolby.get("audio") or []
        for dolby_audio in dolby_audio_list:
            if not isinstance(dolby_audio, dict):
                continue
            dolby_url = str(dolby_audio.get("baseUrl") or dolby_audio.get("base_url") or "").strip()
            if dolby_url:
                dolby_backup = dolby_audio.get("backupUrl") or dolby_audio.get("backup_url") or []
                dolby_info = {
                    "url": dolby_url,
                    "backup_urls": [str(u).strip() for u in dolby_backup if u],
                    "quality_id": int(dolby_audio.get("id") or 30250),
                    "bandwidth": int(dolby_audio.get("bandwidth") or 0),
                    "codecs": str(dolby_audio.get("codecs") or "ec-3"),
                    "mime_type": str(dolby_audio.get("mimeType") or dolby_audio.get("mime_type") or "audio/mp4"),
                    "codec_name": "eac3",
                }
                break

    return {
        "video": video_streams,
        "audio": audio_streams,
        "flac": flac_info,
        "dolby": dolby_info,
    }


def _py_fetch_gatcha_candidate() -> dict | None:
    pool_config = gatcha_pool_config_snapshot()
    excluded_uid_set = set(pool_config.get("excluded_uids") or [])
    excluded_folder_set = set(pool_config.get("excluded_favlist_folders") or [])
    uid_weight = int(pool_config.get("uid_weight", 50))
    favlist_weight = int(pool_config.get("favlist_weight", 50))

    raw_candidates_by_uid = _local_gatcha_candidates_by_uid()
    candidates_by_uid: dict[str, list[dict]] = {}
    if uid_weight > 0:
        for mid, entries in raw_candidates_by_uid.items():
            if mid in excluded_uid_set:
                continue
            valid_entries = [entry for entry in entries if isinstance(entry, dict) and not _is_expired_gatcha_entry(entry)]
            if valid_entries:
                candidates_by_uid[mid] = valid_entries

    all_favlist_candidates = _local_gatcha_favlist_candidates()
    favlist_candidates: list[dict] = []
    if favlist_weight > 0:
        for entry in all_favlist_candidates:
            if _is_expired_gatcha_entry(entry):
                continue
            entry_fav_uid = str(entry.get("fav_uid") or "").strip()
            entry_folder_id = str(entry.get("fav_folder_id") or "").strip()
            folder_key = f"{entry_fav_uid}:{entry_folder_id}" if entry_fav_uid else entry_folder_id
            if folder_key in excluded_folder_set or entry_folder_id in excluded_folder_set:
                continue
            favlist_candidates.append(entry)

    if not candidates_by_uid and not favlist_candidates:
        if not effective_bilibili_cookie():
            raise BilibiliError(MISSING_BILIBILI_COOKIE_MESSAGE)
        raise BilibiliError("本地稿件缓存还没准备好，请稍后再试")

    total_weight = uid_weight + favlist_weight
    if total_weight <= 0:
        total_weight = 100
        uid_weight = 50
        favlist_weight = 50

    pick_favlist = False
    if favlist_candidates and not candidates_by_uid:
        pick_favlist = True
    elif candidates_by_uid and not favlist_candidates:
        pick_favlist = False
    elif favlist_candidates and candidates_by_uid:
        pick_favlist = random.random() < (favlist_weight / total_weight)

    if pick_favlist:
        chosen = random.choice(favlist_candidates)
        payload = {
            "mid": str(chosen.get("mid") or ""),
            "bvid": str(chosen.get("bvid") or ""),
            "title": str(chosen.get("title") or ""),
            "url": str(chosen.get("url") or ""),
            "source": "favlist",
        }
        for key in ("cover_url", "played_count", "preserved_1"):
            value = str(chosen.get(key) or "").strip()
            if value:
                payload[key] = value
        return payload

    chosen_mid = random.choice(list(candidates_by_uid.keys()))
    chosen = random.choice(candidates_by_uid[chosen_mid])
    payload = {
        "mid": chosen_mid,
        "bvid": str(chosen.get("bvid") or ""),
        "title": str(chosen.get("title") or ""),
        "url": str(chosen.get("url") or ""),
        "source": "cache",
    }
    for key in ("cover_url", "played_count", "preserved_1"):
        value = str(chosen.get(key) or "").strip()
        if value:
            payload[key] = value
    return payload


def fetch_gatcha_candidate() -> dict | None:
    return _rust_gatcha_repository(
        "candidate",
        cookie_available=bool(effective_bilibili_cookie()),
    )
