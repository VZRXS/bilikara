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
from .config import BILIBILI_HEADERS, COOKIE, GATCHA_UIDS, GATCHA_KEYWORDS
from dataclasses import dataclass
from .models import PlaylistItem
import bilikara.config as cfg  

VIDEO_PATH_RE = re.compile(r"/video/(?P<vid>(BV[0-9A-Za-z]+|av\d+))", re.IGNORECASE)
BV_RE = re.compile(r"^(BV[0-9A-Za-z]+)$", re.IGNORECASE)
AV_RE = re.compile(r"^(av\d+)$", re.IGNORECASE)
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
_GATCHA_CACHE_LOCK = threading.Lock()
_GATCHA_REFRESH_LOCK = threading.Lock()
_GATCHA_REQUEST_LOCK = threading.Lock()
_GATCHA_LAST_REQUEST_AT = 0.0
_GATCHA_CACHE_FILE = cfg.DATA_DIR / "gatcha_cache.json"
GATCHA_RETRY_DELAY_SECONDS = 5

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


def _load_gatcha_cache() -> dict:
    if not _GATCHA_CACHE_FILE.exists():
        return {"uids": {}, "updated_at": 0}
    try:
        with _GATCHA_CACHE_FILE.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return {"uids": {}, "updated_at": 0}

    if not isinstance(payload, dict):
        return {"uids": {}, "updated_at": 0}
    uids = payload.get("uids")
    if not isinstance(uids, dict):
        uids = {}
    return {
        "uids": uids,
        "updated_at": float(payload.get("updated_at") or 0),
    }


def _save_gatcha_cache(cache_payload: dict) -> None:
    cfg.DATA_DIR.mkdir(parents=True, exist_ok=True)
    temp_path = _GATCHA_CACHE_FILE.with_suffix(".tmp")
    with temp_path.open("w", encoding="utf-8") as handle:
        json.dump(cache_payload, handle, ensure_ascii=False, indent=2)
    temp_path.replace(_GATCHA_CACHE_FILE)


def _wait_for_gatcha_request_slot() -> None:
    global _GATCHA_LAST_REQUEST_AT

    with _GATCHA_REQUEST_LOCK:
        now = time.monotonic()
        elapsed = now - _GATCHA_LAST_REQUEST_AT
        if elapsed < GATCHA_RETRY_DELAY_SECONDS:
            time.sleep(GATCHA_RETRY_DELAY_SECONDS - elapsed)
        _GATCHA_LAST_REQUEST_AT = time.monotonic()


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
        entries.append(
            {
                "mid": str(mid),
                "bvid": bvid,
                "title": title,
                "url": f"https://www.bilibili.com/video/{bvid}",
            }
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


def _fetch_gatcha_videos_for_uid(
    mid: str,
    *,
    on_progress: callable | None = None,
) -> list[dict]:
    page_size = 50
    page_number = 1
    all_entries: list[dict] = []
    seen_bvids: set[str] = set()

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

        vlist = data.get("list", {}).get("vlist", [])
        if not isinstance(vlist, list) or len(vlist) < page_size:
            break
        page_number += 1

    return all_entries


def refresh_gatcha_cache() -> dict:
    with _GATCHA_CACHE_LOCK:
        cache_payload = _load_gatcha_cache()

    if not isinstance(cache_payload, dict):
        cache_payload = {"uids": {}, "updated_at": 0}
    if not isinstance(cache_payload.get("uids"), dict):
        cache_payload["uids"] = {}

    cache_payload["updated_at"] = time.time()
    for raw_mid in GATCHA_UIDS:
        mid = str(raw_mid).strip()
        if not mid:
            continue
        existing_entries = cache_payload["uids"].get(mid, [])
        if isinstance(existing_entries, list) and any(isinstance(entry, dict) for entry in existing_entries):
            continue
        cache_payload["uids"][mid] = []
        with _GATCHA_CACHE_LOCK:
            _save_gatcha_cache(cache_payload)

        def _save_mid_progress(entries: list[dict]) -> None:
            cache_payload["uids"][mid] = entries
            cache_payload["updated_at"] = time.time()
            with _GATCHA_CACHE_LOCK:
                _save_gatcha_cache(cache_payload)

        cache_payload["uids"][mid] = _fetch_gatcha_videos_for_uid(mid, on_progress=_save_mid_progress)
        cache_payload["updated_at"] = time.time()
        with _GATCHA_CACHE_LOCK:
            _save_gatcha_cache(cache_payload)
    return cache_payload


def refresh_gatcha_cache_in_background() -> None:
    def _worker() -> None:
        if not _GATCHA_REFRESH_LOCK.acquire(blocking=False):
            return
        try:
            refresh_gatcha_cache()
        except Exception:
            return
        finally:
            _GATCHA_REFRESH_LOCK.release()

    threading.Thread(target=_worker, daemon=True, name="gatcha-cache-refresh").start()


def _local_gatcha_candidates() -> list[dict]:
    with _GATCHA_CACHE_LOCK:
        cache_payload = _load_gatcha_cache()

    candidates: list[dict] = []
    uid_payload = cache_payload.get("uids") or {}
    for raw_mid in GATCHA_UIDS:
        entries = uid_payload.get(str(raw_mid), [])
        if not isinstance(entries, list):
            continue
        candidates.extend(entry for entry in entries if isinstance(entry, dict))
    return candidates


def _local_gatcha_candidates_by_uid() -> dict[str, list[dict]]:
    with _GATCHA_CACHE_LOCK:
        cache_payload = _load_gatcha_cache()

    grouped_candidates: dict[str, list[dict]] = {}
    uid_payload = cache_payload.get("uids") or {}
    for raw_mid in GATCHA_UIDS:
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

    results: list[dict] = []
    for entry in _local_gatcha_candidates():
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




def request_json(url: str) -> dict:
    headers = dict(BILIBILI_HEADERS)
    if cfg.COOKIE:                          
        headers["Cookie"] = cfg.COOKIE
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


def _variant_id(label: str, index: int) -> str:
    normalized = re.sub(r"[^a-z0-9]+", "_", label.lower()).strip("_")
    return normalized or f"track_{index + 1}"
def fetch_owner_info(raw_input: str) -> tuple[int, str, str]:
    reference = resolve_video_reference(raw_input)
    data = _fetch_view_data(reference)
    owner = data.get("owner") or {}
    owner_mid = int(owner.get("mid") or 0)
    owner_name = str(owner.get("name") or "").strip()
    owner_url = f"https://space.bilibili.com/{owner_mid}" if owner_mid else ""
    return owner_mid, owner_name, owner_url


def fetch_video_item(raw_input: str) -> PlaylistItem:
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
    selected_pages = select_matching_pages(pages, preferred_page=preferred_page)
    selected_page_numbers = [page.page for page in selected_pages]
    video_page = preferred_page if preferred_page in selected_page_numbers else selected_page_numbers[0]
    video_page_info = next(page for page in selected_pages if page.page == video_page)
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
        selected_audio_variant_id=_variant_id(part_title, selected_page_numbers.index(video_page)),
        video_page=video_page,
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
    candidates_by_uid = _local_gatcha_candidates_by_uid()
    if not candidates_by_uid:
        raise BilibiliError("请填写gatcha所需cookie")

    chosen_mid = random.choice(list(candidates_by_uid.keys()))
    chosen = random.choice(candidates_by_uid[chosen_mid])
    return {
        "mid": chosen_mid,
        "bvid": str(chosen.get("bvid") or ""),
        "title": str(chosen.get("title") or ""),
        "url": str(chosen.get("url") or ""),
    }
