from __future__ import annotations

import json
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
import bilikara.config as cfg  

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
_GATCHA_REFRESH_LOCK = threading.Lock()
_GATCHA_REQUEST_LOCK = threading.Lock()
_GATCHA_LAST_REQUEST_AT = 0.0
_GATCHA_CACHE_FILE = cfg.DATA_DIR / "gatcha_cache.json"
_GATCHA_UIDS_FILE = cfg.DATA_DIR / "gatcha_uids.json"
_GATCHA_FAVLIST_FILE = cfg.DATA_DIR / "gatcha_favlist.json"
_GATCHA_CACHE_SCHEMA_VERSION = 2
_GATCHA_FAVLIST_SCHEMA_VERSION = 1
_GATCHA_FAVLIST_LOCK = threading.Lock()
_GATCHA_FAVLIST_REQUEST_LOCK = threading.Lock()
_GATCHA_FAVLIST_LAST_REQUEST_AT = 0.0
_GATCHA_FAVLIST_TITLE_KEYWORDS = ("🎤", "卡拉", "k")
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


def cookie_from_bbdown_data() -> str:
    data_path = cfg.BB_DOWN_DIR / "BBDown.data"
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


def _save_gatcha_uid_payload(uid_payload: dict) -> None:
    cfg.DATA_DIR.mkdir(parents=True, exist_ok=True)
    temp_path = _GATCHA_UIDS_FILE.with_suffix(".tmp")
    with temp_path.open("w", encoding="utf-8") as handle:
        json.dump(uid_payload, handle, ensure_ascii=False, indent=2)
    temp_path.replace(_GATCHA_UIDS_FILE)


def gatcha_task_snapshot() -> dict:
    return {
        "busy": _GATCHA_REFRESH_LOCK.locked(),
        "message": GATCHA_TASK_BUSY_MESSAGE if _GATCHA_REFRESH_LOCK.locked() else "",
    }


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
    return {
        "uid": uid,
        "name": name,
        "space_url": str(raw_profile.get("space_url") or f"https://space.bilibili.com/{uid}"),
    }


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
        payload = {"uids": _default_gatcha_uids(), "profiles": {}, "updated_at": time.time()}
        _save_gatcha_uid_payload(payload)
        return payload

    try:
        with _GATCHA_UIDS_FILE.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, json.JSONDecodeError):
        payload = {"uids": _default_gatcha_uids(), "profiles": {}, "updated_at": time.time()}
        _save_gatcha_uid_payload(payload)
        return payload

    if isinstance(payload, list):
        normalized_payload = {
            "uids": _normalize_gatcha_uid_list(payload),
            "profiles": {},
            "updated_at": time.time(),
        }
        _save_gatcha_uid_payload(normalized_payload)
        return normalized_payload

    if not isinstance(payload, dict):
        payload = {"uids": _default_gatcha_uids(), "profiles": {}, "updated_at": time.time()}
        _save_gatcha_uid_payload(payload)
        return payload

    profiles = _normalize_gatcha_profiles(payload.get("profiles"))

    return {
        "uids": _normalize_gatcha_uid_list(payload.get("uids")),
        "profiles": profiles,
        "updated_at": float(payload.get("updated_at") or 0),
    }


def gatcha_uid_snapshot() -> dict:
    with _GATCHA_UIDS_LOCK:
        payload = _load_gatcha_uid_payload()
    uids = payload.get("uids") if isinstance(payload, dict) else []
    if not isinstance(uids, list):
        uids = []
    return {
        "uids": list(uids),
        "count": len(uids),
        "profiles": dict(payload.get("profiles") or {}),
        "updated_at": float(payload.get("updated_at") or 0),
    }


def _configured_gatcha_uids() -> list[str]:
    return gatcha_uid_snapshot()["uids"]

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
    cfg.DATA_DIR.mkdir(parents=True, exist_ok=True)
    cache_payload["schema_version"] = _GATCHA_CACHE_SCHEMA_VERSION
    temp_path = _GATCHA_CACHE_FILE.with_suffix(".tmp")
    with temp_path.open("w", encoding="utf-8") as handle:
        json.dump(cache_payload, handle, ensure_ascii=False, indent=2)
    temp_path.replace(_GATCHA_CACHE_FILE)


def _empty_gatcha_favlist_payload() -> dict:
    return {"schema_version": _GATCHA_FAVLIST_SCHEMA_VERSION, "uid": "", "folders": [], "items": [], "updated_at": 0}


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
    items = _dedupe_gatcha_entries(payload.get("items"))
    return {
        "schema_version": _GATCHA_FAVLIST_SCHEMA_VERSION,
        "uid": str(payload.get("uid") or ""),
        "folders": [dict(folder) for folder in folders if isinstance(folder, dict)],
        "items": items,
        "updated_at": float(payload.get("updated_at") or 0),
    }


def _save_gatcha_favlist(payload: dict) -> None:
    cfg.DATA_DIR.mkdir(parents=True, exist_ok=True)
    payload["schema_version"] = _GATCHA_FAVLIST_SCHEMA_VERSION
    temp_path = _GATCHA_FAVLIST_FILE.with_suffix(".tmp")
    with temp_path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
    temp_path.replace(_GATCHA_FAVLIST_FILE)


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
        entries.append(
            entry
        )
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
        while True:
            try:
                payload = _request_gatcha_page(mid, page_number, page_size)
                break
            except Exception as exc:  # noqa: BLE001
                print(
                    # f"[debug] gatcha page retry scheduled: mid={mid}, page={page_number}, "
                    # f"cached_entries={len(all_entries)}, error={exc}"
                )
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
    seen_bvids: set[str] = set()
    for raw_entry in raw_entries:
        if not isinstance(raw_entry, dict):
            continue
        bvid = str(raw_entry.get("bvid") or "").strip()
        if not bvid or bvid in seen_bvids:
            continue
        seen_bvids.add(bvid)
        entries.append(dict(raw_entry))
    return entries


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


def preview_gatcha_favlist(raw_mid: object) -> dict:
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
        matched_folders.append(matched_folder)
        entries.extend(_fetch_gatcha_favlist_entries_for_folder(mid, folder))

    deduped_entries = _dedupe_gatcha_entries(entries)
    payload = {
        "schema_version": _GATCHA_FAVLIST_SCHEMA_VERSION,
        "uid": mid,
        "folders": matched_folders,
        "items": deduped_entries,
        "updated_at": time.time(),
    }
    with _GATCHA_FAVLIST_LOCK:
        _save_gatcha_favlist(payload)
    return {
        "uid": mid,
        "folder_count": len(folders),
        "matched_folder_count": len(matched_folders),
        "item_count": len(deduped_entries),
        "updated_at": payload["updated_at"],
    }


def refresh_gatcha_favlist(
    raw_mid: object,
    raw_folder_ids: object = None,
    *,
    on_start: callable | None = None,
    on_done: callable | None = None,
) -> dict:
    if not _GATCHA_REFRESH_LOCK.acquire(blocking=False):
        raise BilibiliError(GATCHA_TASK_BUSY_MESSAGE)
    try:
        if on_start is not None:
            on_start()
        return _refresh_gatcha_favlist_unlocked(raw_mid, raw_folder_ids)
    finally:
        _GATCHA_REFRESH_LOCK.release()
        if on_done is not None:
            on_done()


def _refresh_existing_gatcha_favlist_cache() -> dict | None:
    if not _GATCHA_FAVLIST_FILE.exists():
        return None
    with _GATCHA_FAVLIST_LOCK:
        payload = _load_gatcha_favlist()

    uid = str(payload.get("uid") or "").strip()
    folders = payload.get("folders") if isinstance(payload, dict) else []
    if not uid or not isinstance(folders, list) or not folders:
        return None

    fresh_entries: list[dict] = []
    refreshed_folders = 0
    for folder in folders:
        if not isinstance(folder, dict):
            continue
        if not _gatcha_favlist_media_id(folder):
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
        "uid": uid,
        "mode": "incremental",
        "folder_count": refreshed_folders,
        "added_count": added_count,
        "total_count": len(merged_entries),
    }


def preview_gatcha_uid(raw_mid: object) -> dict:
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
        "already_followed": mid in followed_uids,
        "cache_mode": cache_mode,
        "cache_mode_label": "最新" if cache_mode == "incremental" else "所有",
        "cached_count": len(existing_entries),
    }


def _merge_incremental_gatcha_entries(existing_entries: object, fresh_entries: object) -> tuple[list[dict], int]:
    existing = _dedupe_gatcha_entries(existing_entries)
    seen_bvids = {str(entry.get("bvid") or "").strip() for entry in existing}
    new_entries: list[dict] = []
    for fresh_entry in _dedupe_gatcha_entries(fresh_entries):
        bvid = str(fresh_entry.get("bvid") or "").strip()
        if not bvid or bvid in seen_bvids:
            continue
        seen_bvids.add(bvid)
        new_entries.append(fresh_entry)
    return new_entries + existing, len(new_entries)


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
            _save_gatcha_cache(cache_payload)
        return {
            "uid": mid,
            "mode": "incremental",
            "added_count": added_count,
            "total_count": len(merged_entries),
        }

    cache_payload["uids"][mid] = []
    cache_payload["updated_at"] = time.time()
    with _GATCHA_CACHE_LOCK:
        _save_gatcha_cache(cache_payload)

    def _save_mid_progress(entries: list[dict]) -> None:
        cache_payload["uids"][mid] = _dedupe_gatcha_entries(entries)
        cache_payload["updated_at"] = time.time()
        with _GATCHA_CACHE_LOCK:
            _save_gatcha_cache(cache_payload)

    fetched_entries = _fetch_gatcha_videos_for_uid(mid, on_progress=_save_mid_progress)
    cache_payload["uids"][mid] = _dedupe_gatcha_entries(fetched_entries)
    cache_payload["updated_at"] = time.time()
    with _GATCHA_CACHE_LOCK:
        _save_gatcha_cache(cache_payload)
    return {
        "uid": mid,
        "mode": "full",
        "added_count": len(cache_payload["uids"][mid]),
        "total_count": len(cache_payload["uids"][mid]),
    }


def refresh_gatcha_cache() -> dict:
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

    cache_payload["updated_at"] = time.time()
    for raw_mid in configured_uids:
        mid = str(raw_mid).strip()
        if not mid:
            continue
        profile = _resolve_gatcha_uid_profile(mid, known_profiles)
        if profile is not None:
            cache_profiles[str(profile["uid"])] = profile
            known_profiles[str(profile["uid"])] = profile
        _refresh_gatcha_uid_cache(cache_payload, mid)
    try:
        _refresh_existing_gatcha_favlist_cache()
    except Exception:
        pass
    return cache_payload


def refresh_gatcha_cache_in_background(
    *,
    on_start: callable | None = None,
    on_done: callable | None = None,
    use_global_lock: bool = True,
) -> bool:
    if use_global_lock:
        if not _GATCHA_REFRESH_LOCK.acquire(blocking=False):
            return False
        if on_start is not None:
            on_start()

    def _worker() -> None:
        try:
            refresh_gatcha_cache()
        except Exception:
            return
        finally:
            if use_global_lock:
                _GATCHA_REFRESH_LOCK.release()
                if on_done is not None:
                    on_done()

    threading.Thread(target=_worker, daemon=True, name="gatcha-cache-refresh").start()
    return True


def add_gatcha_uid(raw_mid: object, *, on_start: callable | None = None, on_done: callable | None = None) -> dict:
    if not _GATCHA_REFRESH_LOCK.acquire(blocking=False):
        raise BilibiliError(GATCHA_TASK_BUSY_MESSAGE)
    try:
        if on_start is not None:
            on_start()
        preview = preview_gatcha_uid(raw_mid)
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
        cache_payload["profiles"] = cache_profiles
        cache_result = _refresh_gatcha_uid_cache(cache_payload, mid)
    finally:
        _GATCHA_REFRESH_LOCK.release()
        if on_done is not None:
            on_done()

    return {
        "uid": mid,
        "name": preview["name"],
        "space_url": preview["space_url"],
        "added": added,
        "uids": list(uids),
        "cache": cache_result,
    }


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


def search_gatcha_cache(query: str, *, limit: int = 30) -> list[dict]:
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
            {
                "bvid": str(entry.get("bvid") or ""),
                "title": title,
                "url": str(entry.get("url") or ""),
            }
        )
        if len(results) >= max(1, int(limit)):
            break
    return results


def _gatcha_entry_payload(entry: dict) -> dict:
    return {
        "mid": str(entry.get("mid") or ""),
        "bvid": str(entry.get("bvid") or ""),
        "title": str(entry.get("title") or ""),
        "url": str(entry.get("url") or ""),
    }


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


def browse_gatcha_cache(uid: str = "", query: str = "") -> dict:
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




def request_json(url: str) -> dict:
    headers = dict(BILIBILI_HEADERS)
    headers.pop("Cookie", None)
    cookie = effective_bilibili_cookie()
    if cookie:
        headers["Cookie"] = cookie
    else:
        print("Warning: [bilikara] COOKIE 变量为空，API 将以游客身份访问。")
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.loads(response.read().decode("utf-8"))

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
        request = urllib.request.Request(cleaned, headers=BILIBILI_HEADERS, method="GET")
        with urllib.request.urlopen(request, timeout=15) as response:
            resolved_url = response.geturl()

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
    return pages


def select_matching_pages(
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
        if _is_better_cluster(candidate, best_cluster, preferred_page):
            best_cluster = list(candidate)

    if len(best_cluster) <= 1:
        return best_cluster or [_preferred_or_first_page(pages, preferred_page)]
    return sorted(best_cluster, key=lambda item: item.page)


def _is_better_cluster(candidate: list[VideoPage], current: list[VideoPage], preferred_page: int) -> bool:
    if len(candidate) != len(current):
        return len(candidate) > len(current)

    candidate_duration = _cluster_representative_duration(candidate)
    current_duration = _cluster_representative_duration(current)
    if candidate_duration != current_duration:
        return candidate_duration > current_duration

    candidate_has_preferred = any(page.page == preferred_page for page in candidate)
    current_has_preferred = any(page.page == preferred_page for page in current)
    if candidate_has_preferred != current_has_preferred:
        return candidate_has_preferred

    candidate_spread = _cluster_spread(candidate)
    current_spread = _cluster_spread(current)
    if candidate_spread != current_spread:
        return candidate_spread < current_spread

    return [page.page for page in candidate] < [page.page for page in current]


def _cluster_spread(cluster: list[VideoPage]) -> int:
    if not cluster:
        return 10**9
    durations = [page.duration for page in cluster]
    return max(durations) - min(durations)


def _cluster_representative_duration(cluster: list[VideoPage]) -> float:
    if not cluster:
        return 0.0
    return sum(page.duration for page in cluster) / len(cluster)


def _preferred_or_first_page(pages: list[VideoPage], preferred_page: int) -> VideoPage:
    for page in pages:
        if page.page == preferred_page:
            return page
    return pages[0]


def _variant_id(page: int, label: str, index: int) -> str:
    normalized = re.sub(r"[^a-z0-9]+", "_", label.lower()).strip("_")
    suffix = normalized or f"track_{index + 1}"
    return f"p{max(int(page), 1)}_{suffix}"


def _part_keyword_match(part: str) -> bool:
    normalized = str(part or "").strip().lower()
    return any(keyword in normalized for keyword in ("on", "off", "人声", "伴奏"))


def _is_auto_dual_audio_pair(pages: list[VideoPage]) -> bool:
    return len(pages) == 2 and all(_part_keyword_match(page.part) for page in pages)


def _requires_manual_binding(pages: list[VideoPage]) -> bool:
    if len(pages) > 2:
        return True
    if len(pages) == 2 and not _is_auto_dual_audio_pair(pages):
        return True
    return False


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
    if reference.bvid:
        api_url = (
            "https://api.bilibili.com/x/web-interface/view?"
            f"bvid={urllib.parse.quote(reference.bvid)}"
        )
    else:
        api_url = (
            "https://api.bilibili.com/x/web-interface/view?"
            f"aid={reference.aid}"
        )

    payload = request_json(api_url)
    if payload.get("code") != 0:
        message = payload.get("message") or "获取视频信息失败"
        raise BilibiliError(message)

    data = _fetch_view_data(reference)
    pages = parse_video_pages(data)
    if not pages:
        raise BilibiliError("视频没有可播放的分 P 信息")

    preferred_page = min(reference.page, len(pages))
    manual_selection = _requires_manual_binding(pages)
    if manual_selection and selected_video_page is None and not selected_audio_pages:
        raise ManualBindingRequiredError(
            title=str(data.get("title") or "").strip(),
            pages=pages,
            preferred_page=preferred_page,
        )

    available_page_numbers = [page.page for page in pages]
    available_pages_by_number = {page.page: page for page in pages}
    normalized_audio_pages = _normalize_selected_pages(selected_audio_pages)
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
        if _is_auto_dual_audio_pair(pages):
            selected_pages = list(pages)
        else:
            selected_pages = select_matching_pages(pages, preferred_page=preferred_page)
        if selected_video_page is not None or normalized_audio_pages:
            raise BilibiliError("当前视频不需要手动绑定分P")

    selected_page_numbers = [page.page for page in selected_pages]
    if not selected_page_numbers:
        raise BilibiliError("至少需要选择一个音频分P")
    if manual_selection:
        video_page = int(selected_video_page or selected_page_numbers[0])
    else:
        video_page = preferred_page if preferred_page in selected_page_numbers else selected_page_numbers[0]
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
            "https://api.bilibili.com/x/web-interface/view?"
            f"bvid={urllib.parse.quote(reference.bvid)}"
        )
    else:
        api_url = (
            "https://api.bilibili.com/x/web-interface/view?"
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

def fetch_gatcha_candidate() -> dict | None:
    raw_candidates_by_uid = _local_gatcha_candidates_by_uid()
    candidates_by_uid: dict[str, list[dict]] = {}
    for mid, entries in raw_candidates_by_uid.items():
        valid_entries = [entry for entry in entries if isinstance(entry, dict) and not _is_expired_gatcha_entry(entry)]
        if valid_entries:
            candidates_by_uid[mid] = valid_entries
    favlist_candidates = [entry for entry in _local_gatcha_favlist_candidates() if not _is_expired_gatcha_entry(entry)]
    if not candidates_by_uid and not favlist_candidates:
        if not effective_bilibili_cookie():
            raise BilibiliError(MISSING_BILIBILI_COOKIE_MESSAGE)
        raise BilibiliError("本地稿件缓存还没准备好，请稍后再试")

    if favlist_candidates and (not candidates_by_uid or random.random() < 0.5):
        chosen = random.choice(favlist_candidates)
        return {
            "mid": str(chosen.get("mid") or ""),
            "bvid": str(chosen.get("bvid") or ""),
            "title": str(chosen.get("title") or ""),
            "url": str(chosen.get("url") or ""),
            "source": "favlist",
        }

    chosen_mid = random.choice(list(candidates_by_uid.keys()))
    chosen = random.choice(candidates_by_uid[chosen_mid])
    return {
        "mid": chosen_mid,
        "bvid": str(chosen.get("bvid") or ""),
        "title": str(chosen.get("title") or ""),
        "url": str(chosen.get("url") or ""),
        "source": "cache",
    }
