from __future__ import annotations

import base64
from concurrent.futures import FIRST_EXCEPTION, ThreadPoolExecutor, wait
import ctypes
from dataclasses import dataclass
from datetime import datetime
import hashlib
import http.cookiejar
import json
import math
import os
import platform
import queue
import re
import shutil
import ssl
import stat
import subprocess
import sys
import tarfile
import threading
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any, Callable, Iterable, Iterator, TextIO

from .config import (
    ARIA2C_DIR,
    ARIA2C_PATH_OVERRIDE,
    ARIA2_MACOS_METADATA_PATH,
    ARIA2_RELEASE_API,
    BB_DOWN_DIR,
    BB_DOWN_BUNDLED_PATH,
    BB_DOWN_PATH_OVERRIDE,
    BB_DOWN_RELEASE_API,
    BB_DOWN_VERSION_FILE,
    BILIBILI_HEADERS,
    CACHE_DIR,
    CACHE_POLICY_FILE,
    FFMPEG_RUNTIME_PATH,
    FFMPEG_PATH_OVERRIDE,
    FFMPEG_TOOLS_DIR,
    FFPROBE_RUNTIME_PATH,
    INTERNAL_VENDOR_DIR,
    LOG_DIR,
    MAX_CACHE_ITEMS,
    PACKAGED_RUNTIME,
    TOOL_ASSET_BASE_URL,
    VENDOR_DIR,
    YTDLP_DIR,
    YTDLP_PATH_OVERRIDE,
    YTDLP_RELEASE_API,
)
from .bilibili import (
    BilibiliError,
    cookie_from_bbdown_data,
    effective_bilibili_cookie,
    fetch_dash_playurl,
)
from . import rust_backend, rust_runtime
from .playback_selector import PlaybackCapabilityError, PlaybackSelector
from .store import PlaylistStore

MEDIA_EXTENSIONS = {".mp4", ".mkv", ".webm", ".flv", ".m4v"}
AUDIO_EXTENSIONS = {".m4a", ".aac", ".mp3", ".flac", ".ogg", ".opus", ".wav"}
PROGRESS_RE = re.compile(r"(\d{1,3}(?:\.\d+)?)\s*%")
ARIA2_PROGRESS_RE = re.compile(
    r"\[#\w+\s+([0-9.]+)([A-Za-z]*)/([0-9.]+)([A-Za-z]+)"
    r"\(([0-9.]+)%\)",
    re.IGNORECASE,
)
ANSI_ESCAPE_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
STREAM_SIZE_HINT_RE = re.compile(r"~?\s*(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)\b", re.IGNORECASE)
CACHE_LIMIT_CHOICES = (1, 2, 3, 4, 5)
CACHE_RETENTION_BUFFER_ITEMS = 3
MAX_PARALLEL_TRACK_DOWNLOADS = 4
DOWNKYI_TRACK_MAX_ATTEMPTS = 10
DOWNKYI_TRACK_RETRY_WAIT_SECONDS = 3.0
BILIBILI_QR_GENERATE_URL = (
    "https://passport.bilibili.com/x/passport-login/web/qrcode/generate"
    "?source=main-fe-header"
)
BILIBILI_QR_POLL_URL = "https://passport.bilibili.com/x/passport-login/web/qrcode/poll"
BILIBILI_QR_WAITING_SCAN = 86101
BILIBILI_QR_WAITING_CONFIRMATION = 86090
BILIBILI_QR_EXPIRED = 86038
BILIBILI_LOGIN_LOG_NAME = "bilibili-login.log"
DESKTOP_STARTUP_LOG_NAME = "desktop-startup.log"
PERSISTENT_DIAGNOSTIC_LOG_NAMES = frozenset(
    {BILIBILI_LOGIN_LOG_NAME, DESKTOP_STARTUP_LOG_NAME}
)
BILIBILI_LOGIN_URL_RE = re.compile(r"https?://[^\s\"'<>]+", re.IGNORECASE)
BILIBILI_LOGIN_SENSITIVE_FIELD_RE = re.compile(
    r"(?i)([\"']?(?:sessdata|bili_jct|csrf|access_token|refresh_token|qrcode_key|"
    r"authorization|cookie|shutdown_token|secret|token)[\"']?\s*[:=]\s*[\"']?)"
    r"([^\"'&;,\s<>]+)"
)
BILIBILI_LOGIN_COOKIE_ORDER = (
    "SESSDATA",
    "bili_jct",
    "DedeUserID",
    "DedeUserID__ckMd5",
    "sid",
    "buvid3",
    "buvid4",
    "b_nut",
)
ARIA2_MACOS_VERSION = "1.37.0"
ARIA2_MACOS_SOURCE_URL = (
    "https://github.com/aria2/aria2/releases/download/release-1.37.0/"
    "aria2-1.37.0.tar.xz"
)
ARIA2_MACOS_SOURCE_SHA256 = (
    "60a420ad7085eb616cb6e2bdf0a7206d68ff3d37fb5a956dc44242eb2f79b66b"
)
SOURCE_AUDIO_DURATION_TOLERANCE_SECONDS = 2.0
try:
    ARIA2_CONNECTIONS_PER_TRACK = max(
        1,
        min(16, int(os.getenv("BILIKARA_ARIA2_CONNECTIONS_PER_TRACK", "16"))),
    )
except ValueError:
    ARIA2_CONNECTIONS_PER_TRACK = 16
CREATE_NO_WINDOW = 0x08000000
STARTF_USESHOWWINDOW = 0x00000001
SW_HIDE = 0
RETRY_REQUESTED_MESSAGE = "__retry_requested__"
SUBPROCESS_OUTPUT_ENCODING = "gb18030" if os.name == "nt" else "utf-8"
VIDEO_QUALITY_CHOICES = (
    # "8K 超高清",
    # "杜比视界",
    # "HDR 真彩",
    # "4K 超清",
    "1080P 高帧率",
    # "1080P 高码率",
    "1080P 高清",
    # "720P 60帧",
    "720P 高清",
    "480P 清晰",
    "360P 流畅",
)
DEFAULT_VIDEO_QUALITY = "1080P 高帧率"
DEFAULT_AUDIO_HIRES = True
DOWNLOAD_SOURCE_BBDOWN = "bbdown"
DOWNLOAD_SOURCE_YTDLP = "ytdlp"
DOWNLOAD_SOURCE_DOWNKYI = "downkyi"
DOWNLOAD_SOURCE_NATIVE = "native"
DOWNLOAD_SOURCE_CHOICES = (
    DOWNLOAD_SOURCE_BBDOWN,
    DOWNLOAD_SOURCE_YTDLP,
    DOWNLOAD_SOURCE_DOWNKYI,
    DOWNLOAD_SOURCE_NATIVE,
)
DEFAULT_DOWNLOAD_SOURCE = DOWNLOAD_SOURCE_BBDOWN


class CacheCancelledError(RuntimeError):
    pass


class DownloadCommandError(RuntimeError):
    pass


@dataclass(frozen=True)
class CachePlanItem:
    original_index: int
    item_id: str
    cache_ready: bool


@dataclass(frozen=True)
class CachePlanRequest:
    items: tuple[CachePlanItem, ...]
    max_items: int
    retention_limit: int
    active_item_ids: tuple[str, ...] = ()
    primary_active_item_id: str | None = None
    urgent_item_ids: tuple[str, ...] = ()


@dataclass(frozen=True)
class CachePlan:
    desired_ids: tuple[str, ...]
    pending_order: tuple[str, ...]
    retained_ids: tuple[str, ...]
    preempt_ids: tuple[str, ...]


def _py_plan_cache_window(request: CachePlanRequest) -> CachePlan:
    """Return the complete cache policy decision without I/O or mutation."""

    if not isinstance(request, CachePlanRequest) or not isinstance(request.items, tuple):
        raise ValueError("invalid cache plan request")
    if (
        isinstance(request.max_items, bool)
        or not isinstance(request.max_items, int)
        or request.max_items < 0
        or isinstance(request.retention_limit, bool)
        or not isinstance(request.retention_limit, int)
        or request.retention_limit < 0
    ):
        raise ValueError("cache limits must be non-negative integers")

    item_ids: set[str] = set()
    indices: set[int] = set()
    for item in request.items:
        if not isinstance(item, CachePlanItem):
            raise ValueError("invalid cache plan item")
        if (
            isinstance(item.original_index, bool)
            or not isinstance(item.original_index, int)
            or item.original_index < 0
            or not isinstance(item.item_id, str)
            or not item.item_id
            or not isinstance(item.cache_ready, bool)
            or item.item_id in item_ids
            or item.original_index in indices
        ):
            raise ValueError("invalid or duplicate cache plan item")
        item_ids.add(item.item_id)
        indices.add(item.original_index)

    for references in (request.active_item_ids, request.urgent_item_ids):
        if not isinstance(references, tuple) or len(set(references)) != len(references):
            raise ValueError("cache plan references must be unique tuples")
        if any(not isinstance(item_id, str) or item_id not in item_ids for item_id in references):
            raise ValueError("cache plan reference does not identify an item")
    primary_id = request.primary_active_item_id
    if primary_id is not None and (
        not isinstance(primary_id, str)
        or primary_id not in item_ids
        or primary_id not in request.active_item_ids
    ):
        raise ValueError("primary active item must identify an active item")

    window = request.items[: request.max_items] if request.max_items else ()
    desired_ids = tuple(item.item_id for item in window)
    pending_order = tuple(item.item_id for item in window if not item.cache_ready)

    retained = list(desired_ids)
    retained_set = set(retained)
    if request.max_items:
        for item in request.items:
            if len(retained) >= len(desired_ids) + request.retention_limit:
                break
            if item.item_id not in retained_set and item.cache_ready:
                retained.append(item.item_id)
                retained_set.add(item.item_id)

    preempt_ids: tuple[str, ...] = ()
    if (
        primary_id is not None
        and pending_order
        and primary_id in pending_order
        and primary_id != pending_order[0]
        and pending_order[0] not in request.urgent_item_ids
    ):
        preempt_ids = (primary_id,)

    return CachePlan(
        desired_ids=desired_ids,
        pending_order=pending_order,
        retained_ids=tuple(retained),
        preempt_ids=preempt_ids,
    )


def _debug_print(msg: str) -> None:
    """Print debug message to console, replacing unencodable characters."""
    import sys
    try:
        print(msg, flush=True)
    except (UnicodeEncodeError, OSError):
        try:
            encoding = getattr(sys.stdout, "encoding", None) or "utf-8"
            encoded = msg.encode(encoding, errors="replace")
            if hasattr(sys.stdout, "buffer") and sys.stdout.buffer:
                sys.stdout.buffer.write(encoded + b"\n")
                sys.stdout.buffer.flush()
            else:
                sys.stdout.write(encoded.decode(encoding, errors="replace") + "\n")
                sys.stdout.flush()
        except Exception:
            pass


class CacheManager:
    def __init__(
        self,
        store: PlaylistStore,
        max_cache_items: int = MAX_CACHE_ITEMS,
        *,
        on_bbdown_login_success: Callable[[], None] | None = None,
    ) -> None:
        self.store = store
        self.max_cache_items = self._bounded_cache_items(max_cache_items)
        self.video_quality = DEFAULT_VIDEO_QUALITY
        self.audio_hires = DEFAULT_AUDIO_HIRES
        self.download_source = DEFAULT_DOWNLOAD_SOURCE
        self.reset_offset_on_next = True
        self.hevc_supported: bool | None = None
        self.avc_quality_cap = ""
        self.client_media_capabilities: dict[str, Any] = {}
        self.on_bbdown_login_success = on_bbdown_login_success
        self.tasks: "queue.Queue[str]" = queue.Queue()
        self.pending_ids: set[str] = set()
        self.requeued_active_ids: set[str] = set()
        self.urgent_cache_ids: set[str] = set()
        self.urgent_workers: dict[str, threading.Thread] = {}
        self.desired_ids: set[str] = set()
        self.ordered_desired_ids: list[str] = []
        self.stop_event = threading.Event()
        self.lock = threading.RLock()
        self.binary_state = "idle"
        self.binary_version = ""
        self.binary_message = "等待任务"
        self.binary_prepare_lock = threading.Lock()
        self.ffmpeg_state = "idle"
        self.ffmpeg_version = ""
        self.ffmpeg_message = "等待任务"
        self.ffmpeg_prepare_lock = threading.Lock()
        self.active_process: subprocess.Popen[str] | None = None
        self.active_processes: set[subprocess.Popen[str]] = set()
        self.active_process_item_ids: dict[subprocess.Popen[str], str] = {}
        self.active_item_id: str | None = None
        self.item_activity_at: dict[str, float] = {}
        self.item_stage_progress_signatures: dict[str, str] = {}
        self.item_download_progress: dict[str, dict[str, dict[str, object]]] = {}
        self.retry_requested_ids: set[str] = set()
        self.cache_interrupted_messages: dict[str, str] = {}
        self.log_dir = LOG_DIR
        self.bbdown_login_cancel_event: threading.Event | None = None
        self.bbdown_login_generation: int | None = None
        self.native_cache_started = False
        self.native_cache_event_stop = threading.Event()
        self.native_cache_event_worker: threading.Thread | None = None
        self.native_cache_generations: dict[str, int] = {}
        self.native_cache_snapshot: dict[str, Any] = {}
        self.native_cache_error = ""
        self.native_cache_call_lock = threading.Lock()
        rust_runtime.reset_bilibili_login_status()
        self._load_cache_policy()
        self.worker = threading.Thread(target=self._worker_loop, daemon=True)
        self.worker.start()

    def _native_cache_request(self, command: str, **fields: Any) -> dict[str, Any]:
        with self.native_cache_call_lock:
            return rust_runtime.cache_runtime_request(command, **fields)

    def _ensure_native_cache_runtime(self) -> None:
        with self.lock:
            if self.native_cache_started:
                return
        snapshot = self._native_cache_request("start")
        with self.lock:
            if self.native_cache_started:
                return
            self.native_cache_started = True
            self.native_cache_error = ""
            self.native_cache_snapshot = dict(snapshot)
            self.native_cache_event_stop.clear()
            worker = threading.Thread(
                target=self._native_cache_event_loop,
                name="bilikara-rust-cache-events",
                daemon=True,
            )
            self.native_cache_event_worker = worker
        worker.start()

    def _native_cache_event_loop(self) -> None:
        while not self.native_cache_event_stop.wait(0.1):
            try:
                self._drain_native_cache_events()
            except Exception as exc:  # noqa: BLE001
                with self.lock:
                    self.native_cache_error = str(exc)
                if self.native_cache_event_stop.wait(1.0):
                    return

    def _drain_native_cache_events(self) -> None:
        result = self._native_cache_request("drain_events", max_events=128)
        snapshot = result.get("snapshot")
        if isinstance(snapshot, dict):
            self._apply_native_cache_snapshot(snapshot)
        events = result.get("events")
        if not isinstance(events, list):
            raise RuntimeError("Rust cache runtime returned invalid events")
        for event in events:
            if isinstance(event, dict):
                self._apply_native_cache_event(event)
        with self.lock:
            self.native_cache_error = ""

    def _apply_native_cache_snapshot(self, snapshot: dict[str, Any]) -> None:
        active_ids = {
            str(item_id)
            for item_id in snapshot.get("active_item_ids", [])
            if str(item_id).strip()
        }
        pending_ids = {
            str(item_id)
            for item_id in snapshot.get("pending_ids", [])
            if str(item_id).strip()
        }
        urgent_ids = {
            str(item_id)
            for item_id in snapshot.get("urgent_item_ids", [])
            if str(item_id).strip()
        }
        primary_id = str(snapshot.get("primary_active_item_id") or "").strip()
        with self.lock:
            self.native_cache_snapshot = dict(snapshot)
            if self.download_source == DOWNLOAD_SOURCE_NATIVE:
                self.active_item_id = primary_id or None
                self.pending_ids = pending_ids | active_ids
                self.urgent_cache_ids = urgent_ids

    def _apply_native_cache_event(self, event: dict[str, Any]) -> None:
        item_id = str(event.get("item_id") or "").strip()
        kind = str(event.get("kind") or "").strip()
        payload = event.get("payload")
        payload = payload if isinstance(payload, dict) else {}
        try:
            generation = int(event.get("generation") or 0)
        except (TypeError, ValueError):
            return
        with self.lock:
            expected_generation = self.native_cache_generations.get(item_id)
            if generation > 0:
                if expected_generation and generation < expected_generation:
                    return
                if not expected_generation or generation > expected_generation:
                    self.native_cache_generations[item_id] = generation
        item = self.store.get_item(item_id)
        if not item:
            return

        if kind == "queued":
            self.store.update_item(
                item_id,
                cache_status="queued",
                cache_progress=0.0,
                cache_message="等待 Rust 缓存队列",
                persist_backup=False,
            )
        elif kind == "started":
            tracks = payload.get("tracks")
            normalized_tracks = {
                str(track.get("key") or ""): dict(track)
                for track in (tracks if isinstance(tracks, list) else [])
                if isinstance(track, dict) and str(track.get("key") or "").strip()
            }
            with self.lock:
                self.item_download_progress[item_id] = normalized_tracks
            self.store.update_item(
                item_id,
                cache_status="downloading",
                cache_progress=0.0,
                cache_message=self._cache_start_message(item),
                video_relative_path="",
                video_media_url="",
                audio_variants=[],
                persist_backup=False,
            )
            self._publish_download_progress(item_id)
        elif kind == "progress":
            track = payload.get("track")
            if not isinstance(track, dict):
                return
            track_key = str(track.get("key") or "").strip()
            if not track_key:
                return
            with self.lock:
                tracks = self.item_download_progress.setdefault(item_id, {})
                tracks[track_key] = dict(track)
            self.store.update_item(
                item_id,
                cache_status="downloading",
                persist_backup=False,
            )
            self._publish_download_progress(item_id)
        elif kind == "ready":
            variants = payload.get("audio_variants")
            if not isinstance(variants, list) or not variants:
                self._mark_native_cache_failed(item_id, "Rust 缓存结果缺少音轨")
                return
            self._clear_item_download_progress(item_id)
            self.store.update_item(
                item_id,
                cache_status="ready",
                cache_progress=100.0,
                cache_message=self._ready_message(item),
                video_relative_path=str(payload.get("video_relative_path") or ""),
                video_media_url=str(payload.get("video_media_url") or ""),
                audio_variants=[dict(variant) for variant in variants if isinstance(variant, dict)],
                selected_audio_variant_id=str(
                    payload.get("selected_audio_variant_id") or ""
                ),
                persist_backup=False,
            )
        elif kind == "failed":
            self._mark_native_cache_failed(
                item_id,
                str(payload.get("message") or "Rust 缓存任务失败"),
            )
        elif kind in {"cancelled", "evicted"}:
            self._clear_item_download_progress(item_id)
            self.store.update_item(
                item_id,
                cache_status="pending",
                cache_progress=0.0,
                cache_message=str(payload.get("reason") or self._outside_window_message()),
                video_relative_path="",
                video_media_url="",
                audio_variants=[],
                persist_backup=False,
            )
        else:
            return
        self._record_item_activity(item_id)

    def _mark_native_cache_failed(self, item_id: str, message: str) -> None:
        self._clear_item_download_progress(item_id)
        self.store.update_item(
            item_id,
            cache_status="failed",
            cache_message=f"缓存失败: {message}",
            persist_backup=False,
        )
        self._record_item_activity(item_id)

    def _native_cache_job(self, item) -> dict[str, Any]:
        selected_pages = self._selected_pages_for_item(item)
        video_page = (
            int(item.video_page)
            if int(item.video_page or 0) in selected_pages
            else selected_pages[0]
        )
        pages = [
            {
                "page": page,
                "cid": self._cid_for_page(item, page),
                "duration_seconds": self._duration_for_page(item, page),
                "label": self._part_label_for_page(item, page),
            }
            for page in selected_pages
        ]
        existing_variants: list[dict[str, Any]] = []
        for variant in item.audio_variants:
            if not isinstance(variant, dict):
                continue
            path = self._cache_path_from_media_url(variant.get("audio_url"))
            if path is None:
                continue
            try:
                relative_path = path.relative_to(CACHE_DIR).as_posix()
            except ValueError:
                continue
            existing_variants.append(
                {
                    "id": str(variant.get("id") or ""),
                    "label": str(variant.get("label") or ""),
                    "page": max(1, int(variant.get("page") or 1)),
                    "relative_path": relative_path,
                }
            )
        with self.lock:
            video_quality = self.video_quality
            audio_hires = self.audio_hires
            avc_quality_cap = self.avc_quality_cap if self._should_force_avc_locked() else ""
        return {
            "schema_version": 1,
            "item_id": item.id,
            "bvid": item.bvid,
            "aid": max(0, int(item.aid or 0)),
            "video_page": video_page,
            "pages": pages,
            "cache_root": str(CACHE_DIR.resolve()),
            "log_file": str(
                self._item_log_path(item.id, DOWNLOAD_SOURCE_NATIVE).resolve()
            ),
            "cookie": effective_bilibili_cookie(),
            "user_agent": str(BILIBILI_HEADERS.get("User-Agent") or ""),
            "referer": str(BILIBILI_HEADERS.get("Referer") or ""),
            "timeout_ms": 15_000,
            "video_quality": video_quality,
            "avc_quality_cap": avc_quality_cap,
            "audio_hires": audio_hires,
            "selected_audio_variant_id": str(item.selected_audio_variant_id or ""),
            "reported_ready": item.cache_status == "ready",
            "existing_video_relative_path": str(item.video_relative_path or ""),
            "existing_audio_variants": existing_variants,
        }

    def status(self, metrics: dict[str, Any] | None = None) -> dict:
        cache_metrics = metrics or self.cache_metrics()
        login_status = self.bbdown_login_status()
        with self.lock:
            return {
                "state": self.binary_state,
                "version": self.binary_version,
                "message": self.binary_message,
                "download_source": self.download_source,
                "max_cache_items": self.max_cache_items,
                "cache_bytes": cache_metrics["total_bytes"],
                "cached_items": cache_metrics["item_count"],
                "logged_in": login_status["logged_in"],
                "login": login_status,
                "media_capabilities": self.media_capabilities_snapshot(),
            }

    def ffmpeg_status(self) -> dict[str, Any]:
        with self.lock:
            return {
                "state": self.ffmpeg_state,
                "version": self.ffmpeg_version,
                "message": self.ffmpeg_message,
                "path": str(FFMPEG_RUNTIME_PATH),
            }

    def diagnostic_snapshot(self) -> dict[str, Any]:
        with self.lock:
            active_item_id = self.active_item_id or ""
            urgent_item_ids = list(self.urgent_cache_ids)
            pending_ids = list(self.pending_ids)
            desired_ids = list(self.ordered_desired_ids)
            binary_state = self.binary_state
            binary_version = self.binary_version
            ffmpeg_state = self.ffmpeg_state
            ffmpeg_version = self.ffmpeg_version
            download_source = self.download_source
            native_cache_error = str(getattr(self, "native_cache_error", "") or "")
            native_cache_snapshot = dict(
                getattr(self, "native_cache_snapshot", {}) or {}
            )

        runtime = rust_runtime.runtime_status()
        runtime_load_state = "ready" if runtime["loaded"] else "failed"
        runtime_state = (
            "ready"
            if runtime["loaded"]
            and not (download_source == DOWNLOAD_SOURCE_NATIVE and native_cache_error)
            else "failed"
        )
        runtime_version = (
            f"Rust ABI {runtime.get('abi_version')}"
            if runtime["loaded"]
            else ""
        )
        bbdown_path = (
            Path(BB_DOWN_PATH_OVERRIDE).expanduser()
            if BB_DOWN_PATH_OVERRIDE
            else self._local_binary_path()
        )
        ytdlp_path = (
            Path(YTDLP_PATH_OVERRIDE).expanduser()
            if YTDLP_PATH_OVERRIDE
            else self._local_ytdlp_binary_path()
        )
        aria2c_path = (
            Path(ARIA2C_PATH_OVERRIDE).expanduser()
            if ARIA2C_PATH_OVERRIDE
            else self._local_aria2c_binary_path()
        )
        ffmpeg_path = (
            Path(FFMPEG_PATH_OVERRIDE).expanduser()
            if FFMPEG_PATH_OVERRIDE
            else FFMPEG_RUNTIME_PATH
        )
        bbdown_version = ""
        if BB_DOWN_VERSION_FILE.exists():
            try:
                bbdown_version = BB_DOWN_VERSION_FILE.read_text(encoding="utf-8").strip()
            except OSError:
                bbdown_version = ""
        if not bbdown_version and download_source == DOWNLOAD_SOURCE_BBDOWN:
            bbdown_version = binary_version
        if not bbdown_version:
            bbdown_version = self._read_bbdown_version(bbdown_path)

        return {
            "tools": {
                "BBDown": self._diagnostic_tool_entry(
                    bbdown_path, bbdown_version, binary_state
                ),
                "yt-dlp": self._diagnostic_tool_entry(
                    ytdlp_path,
                    self._read_ytdlp_version(ytdlp_path),
                    binary_state if download_source == DOWNLOAD_SOURCE_YTDLP else "",
                ),
                "aria2c": self._diagnostic_tool_entry(
                    aria2c_path,
                    self._read_aria2c_version(aria2c_path)
                    if aria2c_path.exists()
                    else "",
                    binary_state if download_source == DOWNLOAD_SOURCE_DOWNKYI else "",
                ),
                "FFmpeg": self._diagnostic_tool_entry(
                    ffmpeg_path,
                    ffmpeg_version or self._read_ffmpeg_version(ffmpeg_path),
                    ffmpeg_state,
                ),
                "Rust Native": {
                    "installed": bool(runtime["loaded"]),
                    "version": runtime_version,
                    "state": runtime_state,
                    "path": str(runtime.get("path") or ""),
                    "capabilities": dict(runtime.get("capabilities") or {}),
                    "message": str(
                        runtime.get("error")
                        or native_cache_error
                        or "Rust Native ready"
                    ),
                    "runtime_state": runtime_state,
                    "runtime_error": str(runtime.get("error") or ""),
                    "load_diagnostics": dict(runtime.get("load_diagnostics") or {}),
                },
                "Rust MediaBackend": {
                    "installed": bool(runtime["loaded"]),
                    "version": runtime_version,
                    "state": runtime_load_state,
                    "path": str(runtime.get("path") or ""),
                    "message": str(runtime.get("error") or "Rust MediaBackend ready"),
                    "runtime_state": runtime_load_state,
                    "runtime_error": str(runtime.get("error") or ""),
                },
                "Rust CacheRuntime": {
                    "installed": bool(runtime["loaded"]),
                    "version": runtime_version,
                    "state": runtime_state,
                    "path": str(runtime.get("path") or ""),
                    "message": str(
                        runtime.get("error")
                        or native_cache_error
                        or "Rust CacheRuntime ready"
                    ),
                    "snapshot": native_cache_snapshot,
                },
            },
            "tasks": {
                "active_item_id": active_item_id,
                "urgent_item_ids": urgent_item_ids,
                "pending_item_ids": pending_ids,
                "desired_item_ids": desired_ids,
                "queued_worker_tasks": self.tasks.qsize(),
            },
        }

    @staticmethod
    def _diagnostic_tool_entry(path: Path, version: str, state: str) -> dict[str, Any]:
        return {
            "installed": path.exists(),
            "version": str(version or ""),
            "state": str(state or ""),
            "path": str(path),
        }

    def bbdown_login_status(self) -> dict[str, Any]:
        data_path = self._bbdown_data_path()
        data_exists = data_path.exists()
        logged_in = bool(cookie_from_bbdown_data(data_path))
        return rust_runtime.bilibili_login_snapshot(
            logged_in=logged_in,
            data_exists=data_exists,
            data_path=data_path,
        )

    def start_bbdown_login(self, *, force_refresh_qr: bool = False) -> dict[str, Any]:
        if cookie_from_bbdown_data(self._bbdown_data_path()):
            return self.bbdown_login_status()
        login_status = self.bbdown_login_status()
        with self.lock:
            active_login = (
                self.bbdown_login_cancel_event is not None
                and not self.bbdown_login_cancel_event.is_set()
                and login_status.get("state") in {"starting", "waiting"}
            )
            if active_login and not force_refresh_qr:
                return self.bbdown_login_status()
            if self.bbdown_login_cancel_event is not None:
                self.bbdown_login_cancel_event.set()
            cancel_event = threading.Event()
            self.bbdown_login_cancel_event = cancel_event
            generation = rust_runtime.begin_bilibili_login(
                message="正在启动 BBDown 登录"
            )
            self.bbdown_login_generation = generation
        self._remove_bbdown_qr_image()
        threading.Thread(
            target=self._bbdown_login_worker,
            args=(cancel_event, generation),
            daemon=True,
        ).start()
        return self.bbdown_login_status()

    def logout_bbdown(self) -> dict[str, Any]:
        with self.lock:
            if self.bbdown_login_cancel_event is not None:
                self.bbdown_login_cancel_event.set()
            self.bbdown_login_cancel_event = None
            self.bbdown_login_generation = None
        self._remove_bbdown_qr_image()
        try:
            self._bbdown_data_path().unlink(missing_ok=True)
        except OSError as exc:
            rust_runtime.set_bilibili_login_status(
                "failed", message=f"退出登录失败: {exc}"
            )
            return self.bbdown_login_status()
        rust_runtime.reset_bilibili_login_status()
        return self.bbdown_login_status()

    def policy_snapshot(self, metrics: dict[str, Any] | None = None) -> dict[str, Any]:
        cache_metrics = metrics or self.cache_metrics()
        with self.lock:
            return {
                "max_cache_items": self.max_cache_items,
                "choices": list(CACHE_LIMIT_CHOICES),
                "video_quality": self.video_quality,
                "video_quality_choices": [
                    {"value": quality, "label": quality}
                    for quality in VIDEO_QUALITY_CHOICES
                ],
                "audio_hires": self.audio_hires,
                "download_source": self.download_source,
                "reset_offset_on_next": self.reset_offset_on_next,
                "download_source_choices": [
                    {
                        "value": DOWNLOAD_SOURCE_BBDOWN,
                        "label": "BBDown",
                    },
                    {
                        "value": DOWNLOAD_SOURCE_DOWNKYI,
                        "label": "Downkyi (aria2c)",
                    },
                    {
                        "value": DOWNLOAD_SOURCE_NATIVE,
                        "label": "Rust Native",
                    },
                ],
                "force_avc": self._should_force_avc_locked(),
                "avc_quality_cap": self.avc_quality_cap,
                "media_capabilities": dict(self.client_media_capabilities),
                "clear_on_exit": True,
                "usage_bytes": cache_metrics["total_bytes"],
                "cached_item_count": cache_metrics["item_count"],
            }

    def media_capabilities_snapshot(self) -> dict[str, Any]:
        with self.lock:
            return dict(self.client_media_capabilities)

    def set_client_media_capabilities(self, payload: dict[str, Any]) -> dict[str, Any]:
        playback_selector = self.store.capture_playback_selector()
        hevc_supported = payload.get("hevc_supported")
        if not isinstance(hevc_supported, bool):
            raise ValueError("hevc_supported must be a boolean")

        can_play_type = payload.get("can_play_type")
        if not isinstance(can_play_type, dict):
            can_play_type = {}
        avc_levels = payload.get("avc_levels")
        if not isinstance(avc_levels, list):
            avc_levels = []
        avc_supported = payload.get("avc_supported")
        if not isinstance(avc_supported, bool):
            avc_supported = False
        max_avc_quality = self._quality_from_choice_index(
            payload.get("max_avc_quality_index"),
            playback_selector=playback_selector,
        ) or self._optional_video_quality(
            payload.get("max_avc_quality"),
            playback_selector=playback_selector,
        )
        if not hevc_supported and not max_avc_quality:
            max_avc_quality = VIDEO_QUALITY_CHOICES[-1]

        next_capabilities = {
            "hevc_supported": hevc_supported,
            "force_avc": not hevc_supported,
            "avc_supported": avc_supported,
            "max_avc_quality": max_avc_quality or "",
            "max_avc_quality_index": (
                VIDEO_QUALITY_CHOICES.index(max_avc_quality)
                if max_avc_quality in VIDEO_QUALITY_CHOICES
                else None
            ),
            "can_play_type": {
                str(key): str(value)
                for key, value in can_play_type.items()
            },
            "avc_levels": [
                {
                    "name": str(entry.get("name") or "")[:50],
                    "codec": str(entry.get("codec") or "")[:120],
                    "can_play_type": str(entry.get("can_play_type") or "")[:20],
                    "max_avc_quality_index": entry.get("max_avc_quality_index"),
                }
                for entry in avc_levels[:20]
                if isinstance(entry, dict)
            ],
            "user_agent": str(payload.get("user_agent") or "")[:500],
            "platform": str(payload.get("platform") or "")[:100],
            "reported_at": datetime.now().timestamp(),
        }

        with self.lock:
            previous_force_avc = self._should_force_avc_locked()
            previous_avc_quality_cap = self.avc_quality_cap
            self.hevc_supported = hevc_supported
            self.avc_quality_cap = max_avc_quality or ""
            self.client_media_capabilities = next_capabilities
            should_recache = (
                self._should_force_avc_locked()
                and (
                    not previous_force_avc
                    or previous_avc_quality_cap != self.avc_quality_cap
                )
            )

        if should_recache:
            self._request_desired_recaching("HEVC unsupported; switching video cache to AVC")

        return self.media_capabilities_snapshot()

    @staticmethod
    def _py_quality_from_choice_index(index: object) -> str | None:
        try:
            normalized_index = int(index)
        except (TypeError, ValueError):
            return None
        if 0 <= normalized_index < len(VIDEO_QUALITY_CHOICES):
            return VIDEO_QUALITY_CHOICES[normalized_index]
        return None

    @staticmethod
    def _py_optional_video_quality(video_quality: object) -> str | None:
        value = str(video_quality or "").strip()
        if value in VIDEO_QUALITY_CHOICES:
            return value
        return None

    @staticmethod
    def _native_quality_policy(
        video_quality: object,
        quality_cap: object = "",
        choice_index: int | None = None,
        *,
        playback_selector: PlaybackSelector | None = None,
    ) -> dict[str, Any] | None:
        request = {
            "schema_version": 1,
            "raw_quality": str(video_quality or ""),
            "raw_cap": str(quality_cap or ""),
            "choice_index": choice_index,
        }
        if playback_selector is not None:
            return playback_selector.dispatch(
                "decide_quality_policy",
                python=lambda: None,
                rust=lambda: rust_backend.try_decide_quality_policy(
                    request, allow_python_reference=False
                ),
            )
        completed, response = rust_backend.try_decide_quality_policy(request)
        return response if completed else None

    @staticmethod
    def _quality_from_choice_index(
        index: object,
        *,
        playback_selector: PlaybackSelector | None = None,
    ) -> str | None:
        try:
            normalized_index = int(index)
        except (TypeError, ValueError):
            normalized_index = None
        response = CacheManager._native_quality_policy(
            "",
            choice_index=normalized_index,
            playback_selector=playback_selector,
        )
        if response is not None:
            return response["indexed_quality"]
        return rust_backend.python_fallback(
            "decide_quality_policy",
            lambda: CacheManager._py_quality_from_choice_index(index),
        )

    @staticmethod
    def _optional_video_quality(
        video_quality: object,
        *,
        playback_selector: PlaybackSelector | None = None,
    ) -> str | None:
        response = CacheManager._native_quality_policy(
            video_quality, playback_selector=playback_selector
        )
        if response is not None:
            return response["optional_quality"]
        return rust_backend.python_fallback(
            "decide_quality_policy",
            lambda: CacheManager._py_optional_video_quality(video_quality),
        )

    def enrich_snapshot(
        self,
        payload: dict[str, Any],
        metrics: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        cache_metrics = metrics or self.cache_metrics()
        item_bytes = cache_metrics["item_bytes"]

        current_item = payload.get("current_item")
        if isinstance(current_item, dict):
            current_item_id = str(current_item.get("id") or "")
            current_item["cache_size_bytes"] = int(item_bytes.get(current_item_id, 0))
            current_item["cache_activity_at"] = float(
                self.item_activity_at.get(current_item_id, 0.0)
            )
            current_item.update(self._download_progress_payload_for_item(current_item_id))

        playlist = payload.get("playlist")
        if isinstance(playlist, list):
            for item in playlist:
                if isinstance(item, dict):
                    item_id = str(item.get("id") or "")
                    item["cache_size_bytes"] = int(item_bytes.get(item_id, 0))
                    item["cache_activity_at"] = float(
                        self.item_activity_at.get(item_id, 0.0)
                    )
                    item.update(self._download_progress_payload_for_item(item_id))
        return payload

    def _download_progress_payload_for_item(self, item_id: object) -> dict[str, Any]:
        normalized_item_id = str(item_id or "").strip()
        if not normalized_item_id:
            return {}
        with self.lock:
            tracks_by_key = self.item_download_progress.get(normalized_item_id) or {}
            tracks = [dict(track) for track in tracks_by_key.values()]
        if not tracks:
            return {}

        tracks.sort(key=lambda track: int(track.get("order") or 0))
        track_payloads: list[dict[str, object]] = []
        total_current = 0
        total_target = 0
        all_targets_known = True
        for track in tracks:
            current_bytes = max(0, int(track.get("current_bytes") or 0))
            target_bytes = max(0, int(track.get("target_bytes") or 0))
            if target_bytes <= 0:
                all_targets_known = False
                display_current = current_bytes
            else:
                display_current = min(current_bytes, target_bytes)
                total_target += target_bytes
            total_current += display_current
            track_payloads.append(
                {
                    "key": str(track.get("key") or ""),
                    "label": self._download_track_progress_label(track),
                    "current_bytes": display_current,
                    "target_bytes": target_bytes,
                    "done": bool(track.get("done")),
                    "phase": str(track.get("phase") or ""),
                    "attempt": int(track.get("attempt") or 0),
                    "max_attempts": int(track.get("max_attempts") or 0),
                }
            )

        estimated_total = total_target if all_targets_known and total_target > 0 else 0
        return {
            "cache_download_current_bytes": total_current,
            "cache_download_total_bytes": estimated_total,
            "cache_download_tracks": track_payloads,
        }

    def reconcile_cache_state(self) -> None:
        items = self.store.list_items()
        if not items:
            return
        if self._current_download_source() == DOWNLOAD_SOURCE_NATIVE:
            self.sync_with_playlist()
            return
        invalidated_ids: list[str] = []

        for item in items:
            if item.cache_status != "ready" or self._item_cache_ready(item):
                continue
            self.store.update_item(
                item.id,
                cache_status="pending",
                cache_progress=0.0,
                cache_message="缓存文件已清空，等待重新缓存",
                video_relative_path="",
                video_media_url="",
                audio_variants=[],
                persist_backup=False,
            )
            self._record_item_activity(item.id)
            invalidated_ids.append(item.id)

        if not invalidated_ids:
            return

        fresh_items = self.store.list_items()
        plan, priority_state = self._stable_cache_plan_snapshot(fresh_items)
        desired_ids = set(plan.desired_ids)
        with self.lock:
            self.desired_ids = desired_ids
            self.ordered_desired_ids = list(plan.pending_order)
        fresh_by_id = {item.id: item for item in fresh_items}
        for item_id in invalidated_ids:
            if item_id not in desired_ids:
                continue
            item = fresh_by_id.get(item_id)
            if item:
                self._ensure_item_cached(item)
        priority_plan = (
            plan
            if self._cache_priority_state() == priority_state
            else self._plan_cache_snapshot(fresh_items)
        )
        self._apply_cache_plan_priority(fresh_items, priority_plan)

    def set_max_cache_items(self, max_cache_items: int) -> int:
        self.set_cache_policy(max_cache_items=max_cache_items)
        with self.lock:
            return self.max_cache_items

    def set_cache_policy(
        self,
        *,
        max_cache_items: int | None = None,
        video_quality: str | None = None,
        audio_hires: bool | None = None,
        download_source: str | None = None,
        reset_offset_on_next: bool | None = None,
    ) -> dict[str, Any]:
        playback_selector = (
            self.store.capture_playback_selector()
            if video_quality is not None
            else None
        )
        changed = False
        cache_limit_changed = False
        download_source_changed = False
        native_media_policy_changed = False
        with self.lock:
            previous_download_source = self.download_source
            if max_cache_items is not None:
                bounded = self._bounded_cache_items(max_cache_items)
                if self.max_cache_items != bounded:
                    self.max_cache_items = bounded
                    changed = True
                    cache_limit_changed = True
            if video_quality is not None:
                normalized_quality = self._normalize_video_quality(
                    video_quality, playback_selector=playback_selector
                )
                if self.video_quality != normalized_quality:
                    self.video_quality = normalized_quality
                    changed = True
                    native_media_policy_changed = True
            if audio_hires is not None:
                normalized_hires = bool(audio_hires)
                if self.audio_hires != normalized_hires:
                    self.audio_hires = normalized_hires
                    changed = True
                    native_media_policy_changed = True
            if download_source is not None:
                normalized_source = self._normalize_download_source(download_source)
                if self.download_source != normalized_source:
                    self.download_source = normalized_source
                    changed = True
                    download_source_changed = True
            if reset_offset_on_next is not None:
                val = bool(reset_offset_on_next)
                if self.reset_offset_on_next != val:
                    self.reset_offset_on_next = val
                    changed = True

            if changed:
                self._save_cache_policy_locked()

        if (
            self.native_cache_started
            and previous_download_source == DOWNLOAD_SOURCE_NATIVE
            and (
                self._current_download_source() != DOWNLOAD_SOURCE_NATIVE
                or native_media_policy_changed
            )
        ):
            self._native_cache_request("clear", cache_root=str(CACHE_DIR.resolve()))
            self._drain_native_cache_events()
            with self.lock:
                self.native_cache_generations.clear()
        if (
            cache_limit_changed
            or download_source_changed
            or (
                native_media_policy_changed
                and (
                    previous_download_source == DOWNLOAD_SOURCE_NATIVE
                    or self._current_download_source() == DOWNLOAD_SOURCE_NATIVE
                )
            )
        ):
            self.sync_with_playlist()
        return self.policy_snapshot()

    def _load_cache_policy(self) -> None:
        try:
            payload = json.loads(CACHE_POLICY_FILE.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return
        if not isinstance(payload, dict):
            return
        with self.lock:
            if "max_cache_items" in payload:
                self.max_cache_items = self._bounded_cache_items(payload["max_cache_items"])
            if "video_quality" in payload:
                self.video_quality = self._normalize_video_quality(payload["video_quality"])
            if "audio_hires" in payload:
                self.audio_hires = bool(payload["audio_hires"])
            if "download_source" in payload:
                self.download_source = self._normalize_download_source(payload["download_source"])
            if "reset_offset_on_next" in payload:
                self.reset_offset_on_next = bool(payload["reset_offset_on_next"])

    def _save_cache_policy_locked(self) -> None:
        payload = {
            "max_cache_items": self.max_cache_items,
            "video_quality": self.video_quality,
            "audio_hires": self.audio_hires,
            "download_source": self.download_source,
            "reset_offset_on_next": self.reset_offset_on_next,
        }
        try:
            CACHE_POLICY_FILE.parent.mkdir(parents=True, exist_ok=True)
            temp_path = CACHE_POLICY_FILE.with_suffix(".tmp")
            temp_path.write_text(
                json.dumps(payload, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            temp_path.replace(CACHE_POLICY_FILE)
        except OSError:
            return

    @staticmethod
    def _bounded_cache_items(max_cache_items: int) -> int:
        try:
            value = int(max_cache_items)
        except (TypeError, ValueError):
            value = CACHE_LIMIT_CHOICES[0]
        bounded = min(max(value, CACHE_LIMIT_CHOICES[0]), CACHE_LIMIT_CHOICES[-1])
        return bounded

    @staticmethod
    def _py_normalize_video_quality(video_quality: object) -> str:
        value = str(video_quality or "").strip()
        if value in VIDEO_QUALITY_CHOICES:
            return value
        return DEFAULT_VIDEO_QUALITY

    @staticmethod
    def _normalize_video_quality(
        video_quality: object,
        *,
        playback_selector: PlaybackSelector | None = None,
    ) -> str:
        response = CacheManager._native_quality_policy(
            video_quality, playback_selector=playback_selector
        )
        if response is not None:
            return str(response["normalized_quality"])
        return CacheManager._py_normalize_video_quality(video_quality)

    @staticmethod
    def _normalize_download_source(download_source: object) -> str:
        value = str(download_source or "").strip().lower()
        if value in DOWNLOAD_SOURCE_CHOICES:
            return value
        return DEFAULT_DOWNLOAD_SOURCE

    def downloader_status(self, download_source: object) -> dict[str, Any]:
        normalized_source = self._normalize_download_source(download_source)
        if normalized_source == DOWNLOAD_SOURCE_DOWNKYI:
            return self._aria2c_status()
        if normalized_source != DOWNLOAD_SOURCE_NATIVE:
            return {
                "download_source": normalized_source,
                "tool": self._download_source_label(normalized_source),
                "ready": True,
                "requires_prepare": False,
            }
        status = rust_runtime.runtime_status()
        return {
            "download_source": normalized_source,
            "tool": self._download_source_label(normalized_source),
            "ready": bool(status["loaded"]),
            "requires_prepare": False,
            "message": str(status.get("error") or "Rust Native ready"),
        }

    def prepare_downloader(self, download_source: object) -> dict[str, Any]:
        normalized_source = self._normalize_download_source(download_source)
        if normalized_source == DOWNLOAD_SOURCE_DOWNKYI:
            status = self._aria2c_status()
            if status.get("ready"):
                return status
            if not status.get("auto_prepare_supported"):
                raise RuntimeError(
                    str(status.get("message") or "aria2c requires manual installation")
                )
            restore_binary_state = DOWNLOAD_SOURCE_DOWNKYI != self._current_download_source()
            with self.lock:
                previous_binary = (self.binary_state, self.binary_version, self.binary_message)
            try:
                self._ensure_aria2c()
            except urllib.error.HTTPError as exc:
                if restore_binary_state:
                    self._restore_binary_status(previous_binary)
                if exc.code == 404:
                    raise RuntimeError(
                        f"未找到可用的 aria2c 自动下载包。请安装 aria2c，"
                        f"或将可执行文件放入 {self._local_aria2c_binary_path()} 后再切换。"
                    ) from exc
                raise
            except Exception:
                if restore_binary_state:
                    self._restore_binary_status(previous_binary)
                raise
            status = self._aria2c_status()
            status["prepared"] = True
            return status
        return self.downloader_status(normalized_source)

    def _restore_binary_status(self, status: tuple[str, str, str]) -> None:
        with self.lock:
            self.binary_state, self.binary_version, self.binary_message = status

    def _aria2c_status(self) -> dict[str, Any]:
        override = Path(ARIA2C_PATH_OVERRIDE).expanduser() if ARIA2C_PATH_OVERRIDE else None
        manual_path = self._local_aria2c_binary_path()
        system_path = None if override else self._system_aria2c_path()

        if override and override.exists():
            binary_path = override
        elif system_path:
            binary_path = system_path
        else:
            binary_path = manual_path
        exists = binary_path.exists()
        version = self._read_aria2c_version(binary_path) if exists else ""
        system, arch = self._current_platform_tokens()
        ready = bool(version)
        auto_prepare_supported = not ready and self._aria2_auto_prepare_supported(system, arch)
        if ready:
            if override and binary_path == override:
                message = f"使用外部 aria2c: {override}"
            elif system_path and binary_path == system_path:
                message = f"使用系统 aria2c: {system_path}"
            else:
                message = f"aria2c {version} 已就绪"
        elif exists and auto_prepare_supported:
            message = f"aria2c 不可执行，将在确认后自动修复: {binary_path}"
        elif exists:
            message = f"aria2c 不可执行: {binary_path}"
        elif auto_prepare_supported:
            message = f"需要下载 aria2c 到 {manual_path}"
        else:
            message = f"当前平台需要手动安装 aria2c，或将 aria2c 放入 {manual_path}"
        return {
            "download_source": DOWNLOAD_SOURCE_DOWNKYI,
            "tool": "aria2c",
            "ready": ready,
            "requires_prepare": not ready,
            "auto_prepare_supported": auto_prepare_supported,
            "path": str(binary_path),
            "manual_path": str(manual_path),
            "version": version,
            "platform": system,
            "arch": arch,
            "install_url": "https://github.com/aria2/aria2/releases",
            "message": message,
        }
    def cache_metrics(self) -> dict[str, Any]:
        if (
            self._current_download_source() == DOWNLOAD_SOURCE_NATIVE
            and self.native_cache_started
        ):
            try:
                result = self._native_cache_request(
                    "metrics", cache_root=str(CACHE_DIR.resolve())
                )
                if (
                    isinstance(result.get("item_bytes"), dict)
                    and isinstance(result.get("total_bytes"), int)
                    and isinstance(result.get("item_count"), int)
                ):
                    return result
            except Exception as exc:  # noqa: BLE001
                with self.lock:
                    self.native_cache_error = str(exc)
        item_bytes: dict[str, int] = {}
        total_bytes = 0
        item_count = 0
        if not CACHE_DIR.exists():
            return {
                "item_bytes": item_bytes,
                "total_bytes": total_bytes,
                "item_count": item_count,
            }

        for child in CACHE_DIR.iterdir():
            if not child.is_dir():
                continue
            size = self._path_size(child)
            item_bytes[child.name] = size
            total_bytes += size
            if size > 0:
                item_count += 1

        return {
            "item_bytes": item_bytes,
            "total_bytes": total_bytes,
            "item_count": item_count,
        }

    def prepare_session(self) -> None:
        if self._current_download_source() == DOWNLOAD_SOURCE_NATIVE:
            self._ensure_native_cache_runtime()
            self._native_cache_request("clear", cache_root=str(CACHE_DIR.resolve()))
            self._drain_native_cache_events()
            self._clear_log_root()
        else:
            self._clear_cache_root()
        with self.lock:
            self.item_activity_at.clear()
            self.item_stage_progress_signatures.clear()
            self.item_download_progress.clear()
            self.retry_requested_ids.clear()
            self.cache_interrupted_messages.clear()
            self.pending_ids.clear()
            self.requeued_active_ids.clear()
            self.urgent_cache_ids.clear()
            self.urgent_workers.clear()
            self.desired_ids.clear()
            self.ordered_desired_ids.clear()
        for item in self.store.list_items():
            self.store.update_item(
                item.id,
                cache_status="pending",
                cache_progress=0.0,
                cache_message=self._waiting_message(),
                video_relative_path="",
                video_media_url="",
                audio_variants=[],
                persist_backup=False,
            )
            self._record_item_activity(item.id)
        self.sync_with_playlist()

    def prewarm_binary(self) -> None:
        threading.Thread(target=self._prewarm_binary_worker, daemon=True).start()

    def shutdown(self) -> None:
        with self.lock:
            if self.stop_event.is_set():
                return
            self.stop_event.set()
            processes = self._active_processes_locked()
            urgent_workers = list(self.urgent_workers.values())
            if self.bbdown_login_cancel_event is not None:
                self.bbdown_login_cancel_event.set()
                self.bbdown_login_cancel_event = None
                self.bbdown_login_generation = None
            native_cache_started = self.native_cache_started
            self.native_cache_event_stop.set()
            native_cache_event_worker = self.native_cache_event_worker
        self._terminate_processes(processes, wait=True)
        current_thread = threading.current_thread()
        for worker in urgent_workers:
            if worker is current_thread:
                continue
            worker.join(timeout=5.0)
        if native_cache_event_worker is not None and native_cache_event_worker is not current_thread:
            native_cache_event_worker.join(timeout=5.0)
        if native_cache_started:
            try:
                self._native_cache_request("clear", cache_root=str(CACHE_DIR.resolve()))
            except Exception as exc:  # noqa: BLE001
                _debug_print(f"[bilikara-cache] Rust cache clear during shutdown failed: {exc}")
            try:
                self._native_cache_request("shutdown")
            except Exception as exc:  # noqa: BLE001
                _debug_print(f"[bilikara-cache] Rust cache shutdown failed: {exc}")
            self._clear_log_root()
        else:
            self._clear_cache_root()
        with self.lock:
            self.item_activity_at.clear()
            self.item_stage_progress_signatures.clear()
            self.item_download_progress.clear()
            self.retry_requested_ids.clear()
            self.cache_interrupted_messages.clear()
            self.urgent_cache_ids.clear()
            self.urgent_workers.clear()
            self.active_process_item_ids.clear()
            self.native_cache_started = False
            self.native_cache_event_worker = None
            self.native_cache_generations.clear()
            self.native_cache_snapshot.clear()
        for item in self.store.list_items():
            self.store.update_item(
                item.id,
                cache_status="pending",
                cache_progress=0.0,
                cache_message="缓存已在退出时清空",
                video_relative_path="",
                video_media_url="",
                audio_variants=[],
                persist_backup=False,
            )
            self._record_item_activity(item.id)

    def clear_runtime_cache(self) -> None:
        native_cache = (
            self._current_download_source() == DOWNLOAD_SOURCE_NATIVE
            or self.native_cache_started
        )
        if native_cache:
            self._ensure_native_cache_runtime()
            self._native_cache_request("clear", cache_root=str(CACHE_DIR.resolve()))
            self._drain_native_cache_events()
            self._clear_log_root()
        with self.lock:
            processes = self._active_processes_locked()
            urgent_workers = list(self.urgent_workers.values())
            self.pending_ids.clear()
            self.requeued_active_ids.clear()
            self.urgent_cache_ids.clear()
            self.urgent_workers.clear()
            self.desired_ids.clear()
            self.ordered_desired_ids.clear()
            self.retry_requested_ids.clear()
            self.cache_interrupted_messages.clear()
            self.item_activity_at.clear()
            self.item_stage_progress_signatures.clear()
            self.item_download_progress.clear()
            self.active_process = None
            self.active_processes.clear()
            self.active_process_item_ids.clear()
            self.active_item_id = None
            self.native_cache_generations.clear()
            self.native_cache_snapshot.clear()
            while True:
                try:
                    self.tasks.get_nowait()
                except queue.Empty:
                    break
        self._terminate_processes(processes)
        current_thread = threading.current_thread()
        for worker in urgent_workers:
            if worker is current_thread:
                continue
            worker.join(timeout=5.0)
        if not native_cache:
            self._clear_cache_root()

    def retry_item(self, item_id: str, *, force: bool = False) -> None:
        item = self.store.get_item(item_id)
        if not item:
            raise ValueError("没有找到要重新下载的歌曲")
        if item.cache_status == "ready" and not force:
            raise ValueError("这首歌已经缓存完成，无需重新下载")
        if item.cache_status not in {"downloading", "failed", "ready", "pending", "queued"}:
            raise ValueError("当前缓存状态不能重新下载")
        if not self._is_in_cache_window(item_id):
            raise ValueError("当前不在自动缓存窗口中")

        download_source = self._current_download_source()
        log_path = self._item_log_path(item_id, download_source)
        self._append_log_line(log_path, f"[{self._log_timestamp()}] manual retry requested")

        if download_source == DOWNLOAD_SOURCE_NATIVE:
            snapshot = dict(self.native_cache_snapshot)
            primary_active_item_id = str(
                snapshot.get("primary_active_item_id") or ""
            ).strip()
            urgent = bool(
                force
                and self.store.is_current_item(item_id)
                and primary_active_item_id
                and primary_active_item_id != item_id
            )
            self.store.update_item(
                item_id,
                cache_status="pending",
                cache_progress=0.0,
                cache_message="准备重新下载",
                video_relative_path="",
                video_media_url="",
                audio_variants=[],
                persist_backup=False,
            )
            self._record_item_activity(item_id)
            try:
                self._ensure_native_cache_runtime()
                result = self._native_cache_request(
                    "retry", job=self._native_cache_job(item), urgent=urgent
                )
                generation = int(result.get("generation") or 0)
                if generation > 0:
                    with self.lock:
                        self.native_cache_generations[item_id] = max(
                            generation,
                            self.native_cache_generations.get(item_id, 0),
                        )
                self._drain_native_cache_events()
            except Exception as exc:  # noqa: BLE001
                self._mark_native_cache_failed(item_id, str(exc))
            return

        is_current_item = self.store.is_current_item(item_id)
        with self.lock:
            active_processes = self._active_processes_locked(item_id)
            target_is_primary_active = self.active_item_id == item_id
            target_is_urgent_active = item_id in self.urgent_cache_ids
            primary_active_item_id = self.active_item_id
            start_concurrent_current_retry = bool(
                force
                and is_current_item
                and primary_active_item_id
                and primary_active_item_id != item_id
                and not target_is_urgent_active
            )
            preempted_item_id = (
                primary_active_item_id
                if force
                and primary_active_item_id != item_id
                and not start_concurrent_current_retry
                else None
            )
            preempted_processes = self._active_processes_locked(preempted_item_id) if preempted_item_id else []
            in_flight = bool(
                target_is_primary_active
                or target_is_urgent_active
                or (item_id in self.pending_ids and not start_concurrent_current_retry)
            )
            if in_flight:
                self.retry_requested_ids.add(item_id)
            if preempted_item_id:
                self.cache_interrupted_messages[preempted_item_id] = "等待当前歌曲重新下载"

        self.store.update_item(
            item_id,
            cache_status="pending",
            cache_progress=0.0,
            cache_message="准备重新下载",
            video_relative_path="",
            video_media_url="",
            audio_variants=[],
            persist_backup=False,
        )
        self._record_item_activity(item_id)

        if in_flight:
            self._terminate_processes(active_processes)
            return

        self._remove_cache_dir(item_id)
        if start_concurrent_current_retry:
            self._append_log_line(
                log_path,
                f"[{self._log_timestamp()}] starting concurrent current-item retry while "
                f"item={primary_active_item_id} continues caching",
            )
            self._start_urgent_cache(item_id)
            return
        if preempted_item_id:
            download_source = self._current_download_source()
            self._append_log_line(
                self._item_log_path(preempted_item_id, download_source),
                f"[{self._log_timestamp()}] interrupted by manual retry: {item.display_title}",
            )
            self._enqueue_retry_front(item_id, requeue_after=preempted_item_id)
            self._terminate_processes(preempted_processes)
            return
        self.enqueue(item_id)

    @staticmethod
    def _cache_plan_wire_request(request: CachePlanRequest) -> dict[str, object]:
        return {
            "schema_version": 1,
            "items": [
                {
                    "original_index": item.original_index,
                    "item_id": item.item_id,
                    "cache_ready": item.cache_ready,
                }
                for item in request.items
            ],
            "max_items": request.max_items,
            "retention_limit": request.retention_limit,
            "active_item_ids": list(request.active_item_ids),
            "primary_active_item_id": request.primary_active_item_id,
            "urgent_item_ids": list(request.urgent_item_ids),
        }

    def _plan_cache_snapshot(
        self,
        items: list[Any],
        *,
        max_items: int | None = None,
    ) -> CachePlan:
        descriptors = tuple(
            CachePlanItem(index, item.id, self._item_cache_ready(item))
            for index, item in enumerate(items)
        )
        supplied_ids = {item.item_id for item in descriptors}
        with self.lock:
            primary_id = self.active_item_id
            active_ids = set(self.active_process_item_ids.values())
            if primary_id:
                active_ids.add(primary_id)
            active_ids.update(self.urgent_cache_ids)
            urgent_ids = set(self.urgent_cache_ids)
        if primary_id not in supplied_ids:
            primary_id = None
        request = CachePlanRequest(
            items=descriptors,
            max_items=self.max_cache_items if max_items is None else max_items,
            retention_limit=CACHE_RETENTION_BUFFER_ITEMS,
            active_item_ids=tuple(
                item.item_id for item in descriptors if item.item_id in active_ids
            ),
            primary_active_item_id=primary_id,
            urgent_item_ids=tuple(
                item.item_id for item in descriptors if item.item_id in urgent_ids
            ),
        )
        completed, response = rust_backend.try_plan_cache_window(
            self._cache_plan_wire_request(request)
        )
        if not completed or response is None:
            return rust_backend.python_fallback(
                "plan_cache_window", lambda: _py_plan_cache_window(request)
            )
        return CachePlan(
            desired_ids=tuple(response["desired_ids"]),
            pending_order=tuple(response["pending_order"]),
            retained_ids=tuple(response["retained_ids"]),
            preempt_ids=tuple(response["preempt_ids"]),
        )

    def _cache_priority_state(self) -> tuple[object, ...]:
        """Return the mutable planner inputs that cache starts may change."""

        with self.lock:
            return (
                self.active_item_id,
                tuple(sorted(set(self.active_process_item_ids.values()))),
                tuple(sorted(self.urgent_cache_ids)),
            )

    def _stable_cache_plan_snapshot(
        self, items: list[Any]
    ) -> tuple[CachePlan, tuple[object, ...]]:
        """Plan outside locks and retry only if mutable planner inputs changed."""

        after = self._cache_priority_state()
        for _attempt in range(3):
            before = after
            plan = self._plan_cache_snapshot(items)
            after = self._cache_priority_state()
            if before == after:
                return plan, after
        # Persistent churn is rare. The caller will see the sentinel and avoid
        # reusing this final plan for its later priority/preemption phase.
        after = ("unstable", *after)
        return plan, after

    def _cache_window_plan(self, items: list[Any]) -> tuple[set[str], list[str]]:
        plan = self._plan_cache_snapshot(items)
        return set(plan.desired_ids), list(plan.pending_order)

    def _retained_cache_ids(self, items: list[Any], desired_ids: set[str]) -> set[str]:
        plan = self._plan_cache_snapshot(items)
        if set(plan.desired_ids) == set(desired_ids):
            return set(plan.retained_ids)

        # Private-call compatibility for callers supplying a nonstandard window.
        retained_ids = set(desired_ids)
        if self.max_cache_items > 0:
            for item in items:
                if len(retained_ids) >= len(desired_ids) + CACHE_RETENTION_BUFFER_ITEMS:
                    break
                if item.id not in retained_ids and self._item_cache_ready(item):
                    retained_ids.add(item.id)
        return retained_ids

    def _sync_native_with_playlist(self, items: list[Any], plan: CachePlan) -> None:
        desired_ids = set(plan.desired_ids)
        retained_ids = set(plan.retained_ids)
        jobs: list[dict[str, Any]] = []
        for item in items:
            if item.id not in desired_ids or item.cache_status == "failed":
                continue
            try:
                jobs.append(self._native_cache_job(item))
            except Exception as exc:  # noqa: BLE001
                self._mark_native_cache_failed(item.id, str(exc))

        try:
            self._ensure_native_cache_runtime()
            result = self._native_cache_request(
                "sync",
                cache_root=str(CACHE_DIR.resolve()),
                current_ids=[item.id for item in items],
                retained_ids=[item.id for item in items if item.id in retained_ids],
                jobs=jobs,
                ordered_ids=list(plan.pending_order),
                preempt_item_id=plan.preempt_ids[0] if plan.preempt_ids else "",
            )
        except Exception as exc:  # noqa: BLE001
            with self.lock:
                self.native_cache_error = str(exc)
            for job in jobs:
                self._mark_native_cache_failed(str(job["item_id"]), str(exc))
            return

        generations = result.get("generations")
        if isinstance(generations, dict):
            with self.lock:
                for item_id, generation in generations.items():
                    try:
                        normalized_item_id = str(item_id)
                        self.native_cache_generations[normalized_item_id] = max(
                            int(generation),
                            self.native_cache_generations.get(normalized_item_id, 0),
                        )
                    except (TypeError, ValueError):
                        continue
        snapshot = result.get("snapshot")
        if isinstance(snapshot, dict):
            self._apply_native_cache_snapshot(snapshot)
        native_log_dir = self.log_dir / DOWNLOAD_SOURCE_NATIVE
        if native_log_dir.is_dir():
            current_ids = {item.id for item in items}
            for log_file in native_log_dir.glob("*.log"):
                if log_file.stem not in current_ids:
                    self._safe_unlink(log_file)
        self._drain_native_cache_events()

    def sync_with_playlist(self) -> None:
        items = self.store.list_items()
        plan, priority_state = self._stable_cache_plan_snapshot(items)
        desired_ids = set(plan.desired_ids)
        retained_ids = set(plan.retained_ids)
        current_ids = {item.id for item in items}
        with self.lock:
            self.desired_ids = set(desired_ids)
            self.ordered_desired_ids = list(plan.pending_order)

        if self._current_download_source() == DOWNLOAD_SOURCE_NATIVE:
            self._sync_native_with_playlist(items, plan)
            return

        self._cleanup_orphan_cache_dirs(current_ids)
        self._stop_active_if_not_desired(desired_ids)

        for item in items:
            if item.id in desired_ids:
                self._ensure_item_cached(item)
            elif item.id not in retained_ids:
                self._drop_item_cache(item.id, self._outside_window_message())
        priority_plan = (
            plan
            if self._cache_priority_state() == priority_state
            else self._plan_cache_snapshot(items)
        )
        self._apply_cache_plan_priority(items, priority_plan)

    def enqueue(self, item_id: str) -> None:
        if self._current_download_source() == DOWNLOAD_SOURCE_NATIVE:
            item = self.store.get_item(item_id)
            if not item:
                return
            try:
                self._ensure_native_cache_runtime()
                result = self._native_cache_request(
                    "submit", job=self._native_cache_job(item), priority="normal"
                )
                generation = int(result.get("generation") or 0)
                if generation > 0:
                    with self.lock:
                        self.native_cache_generations[item_id] = max(
                            generation,
                            self.native_cache_generations.get(item_id, 0),
                        )
                self._drain_native_cache_events()
            except Exception as exc:  # noqa: BLE001
                self._mark_native_cache_failed(item_id, str(exc))
            return
        with self.lock:
            if (
                item_id in self.pending_ids
                or item_id in self.urgent_cache_ids
                or self.stop_event.is_set()
            ):
                return
            self.pending_ids.add(item_id)
        self.tasks.put(item_id)

    def _remove_queued_item(self, item_id: str) -> None:
        with self.lock:
            retained: list[str] = []
            while True:
                try:
                    queued_id = self.tasks.get_nowait()
                except queue.Empty:
                    break
                if queued_id != item_id:
                    retained.append(queued_id)
                self.tasks.task_done()
            for queued_id in retained:
                self.tasks.put(queued_id)

    def _start_urgent_cache(self, item_id: str) -> None:
        self._remove_queued_item(item_id)
        with self.lock:
            if self.stop_event.is_set() or item_id in self.urgent_cache_ids:
                return
            self.urgent_cache_ids.add(item_id)
            self.pending_ids.add(item_id)
            worker = threading.Thread(
                target=self._urgent_cache_worker,
                args=(item_id,),
                name=f"bilikara-current-cache-{item_id}",
                daemon=True,
            )
            self.urgent_workers[item_id] = worker
        worker.start()

    def _urgent_cache_worker(self, item_id: str) -> None:
        should_resync = False
        try:
            should_resync = self._cache_item(item_id)
        except Exception as exc:  # noqa: BLE001
            _debug_print(f"[bilikara-cache] Unexpected urgent-cache error for item {item_id}: {exc}")
            try:
                download_source = self._current_download_source()
                log_path = self._item_log_path(item_id, download_source)
                self._append_log_line(
                    log_path,
                    f"[{self._log_timestamp()}] Unexpected urgent-cache error: {exc}",
                )
                self.store.update_item(
                    item_id,
                    cache_status="failed",
                    cache_message=f"缓存发生意外错误: {exc}",
                    persist_backup=False,
                )
            except Exception:
                pass
        finally:
            with self.lock:
                self.urgent_cache_ids.discard(item_id)
                self.urgent_workers.pop(item_id, None)
                self.pending_ids.discard(item_id)
        if should_resync and not self.stop_event.is_set():
            self.sync_with_playlist()

    def _enqueue_front(self, item_id: str, *, requeue_after: str | None = None) -> None:
        with self.lock:
            if self.stop_event.is_set():
                return
            drained: list[str] = []
            skip_ids = {item_id}
            if requeue_after:
                skip_ids.add(requeue_after)
            while True:
                try:
                    queued_id = self.tasks.get_nowait()
                except queue.Empty:
                    break
                if queued_id not in skip_ids:
                    drained.append(queued_id)
                self.tasks.task_done()

            ordered = [item_id]
            self.pending_ids.add(item_id)
            if requeue_after and requeue_after != item_id and requeue_after in self.desired_ids:
                ordered.append(requeue_after)
                self.pending_ids.add(requeue_after)
                if requeue_after == self.active_item_id:
                    self.requeued_active_ids.add(requeue_after)
            for queued_id in ordered + drained:
                self.tasks.put(queued_id)

    def _enqueue_retry_front(self, item_id: str, *, requeue_after: str | None = None) -> None:
        self._enqueue_front(item_id, requeue_after=requeue_after)

    def _reorder_pending_cache_queue(self, ordered_ids: list[str]) -> None:
        ordered_set = set(ordered_ids)
        with self.lock:
            if self.stop_event.is_set():
                return
            active_item_id = self.active_item_id
            urgent_cache_ids = set(self.urgent_cache_ids)
            drained: list[str] = []
            while True:
                try:
                    queued_id = self.tasks.get_nowait()
                except queue.Empty:
                    break
                if queued_id in self.desired_ids:
                    drained.append(queued_id)
                else:
                    self.pending_ids.discard(queued_id)
                self.tasks.task_done()

            drained_set = set(drained)
            reordered: list[str] = []
            for item_id in ordered_ids:
                if item_id == active_item_id or item_id in urgent_cache_ids:
                    continue
                if item_id in drained_set or item_id in self.pending_ids:
                    reordered.append(item_id)

            for item_id in drained:
                if item_id not in ordered_set and item_id not in reordered:
                    reordered.append(item_id)

            for item_id in reordered:
                self.pending_ids.add(item_id)
                self.tasks.put(item_id)

    def _prioritize_cache_window(self, items: list[Any], desired_ids: set[str]) -> None:
        ordered_items = [item for item in items if item.id in desired_ids]
        plan = self._plan_cache_snapshot(ordered_items, max_items=len(ordered_items))
        self._apply_cache_plan_priority(ordered_items, plan)

    def _apply_cache_plan_priority(self, items: list[Any], plan: CachePlan) -> None:
        ordered_cache_ids = list(plan.pending_order)
        if not ordered_cache_ids:
            return

        self._reorder_pending_cache_queue(ordered_cache_ids)

        if len(plan.preempt_ids) != 1:
            return
        proposed_active_id = plan.preempt_ids[0]
        next_item_id = ordered_cache_ids[0]
        next_item = next((item for item in items if item.id == next_item_id), None)
        with self.lock:
            if (
                self.stop_event.is_set()
                or self.active_item_id != proposed_active_id
                or proposed_active_id not in ordered_cache_ids
                or proposed_active_id == next_item_id
                or next_item_id in self.urgent_cache_ids
            ):
                return
            active_processes = self._active_processes_locked(proposed_active_id)
            title = str(getattr(next_item, "display_title", "") or "").strip()
            self.cache_interrupted_messages[proposed_active_id] = (
                f"等待优先缓存: {title}" if title else "等待优先缓存"
            )
        self._enqueue_front(next_item_id, requeue_after=proposed_active_id)
        self._terminate_processes(active_processes)

    def _worker_loop(self) -> None:
        while not self.stop_event.is_set():
            try:
                item_id = self.tasks.get(timeout=0.5)
            except queue.Empty:
                continue
            should_resync = False
            try:
                try:
                    with self.lock:
                        self.active_item_id = item_id
                    should_resync = self._cache_item(item_id)
                except Exception as exc:  # noqa: BLE001
                    _debug_print(f"[bilikara-cache] Unexpected error caching item {item_id}: {exc}")
                    try:
                        download_source = self._current_download_source()
                        log_path = self._item_log_path(item_id, download_source)
                        self._append_log_line(
                            log_path,
                            f"[{self._log_timestamp()}] Unexpected error caching item: {exc}"
                        )
                    except Exception:
                        pass
                    try:
                        self.store.update_item(
                            item_id,
                            cache_status="failed",
                            cache_message=f"缓存发生意外错误: {exc}",
                            persist_backup=False,
                        )
                    except Exception:
                        pass
            finally:
                with self.lock:
                    if self.active_item_id == item_id:
                        self.active_item_id = None
                    item_processes = [
                        process
                        for process, process_item_id in self.active_process_item_ids.items()
                        if process_item_id == item_id
                    ]
                    for process in item_processes:
                        self.active_processes.discard(process)
                        self.active_process_item_ids.pop(process, None)
                    self.active_process = next(iter(self.active_processes), None)
                    if item_id in self.requeued_active_ids:
                        self.requeued_active_ids.discard(item_id)
                    else:
                        self.pending_ids.discard(item_id)
                self.tasks.task_done()
            if should_resync and not self.stop_event.is_set():
                self.sync_with_playlist()

    def _cache_item(self, item_id: str, allow_refresh_retry: bool = True) -> bool:
        playback_selector = self.store.capture_playback_selector()
        if self.stop_event.is_set() or not self._should_cache(item_id):
            return False
        if self._take_retry_request(item_id):
            self._remove_cache_dir(item_id)
        item = self.store.get_item(item_id)
        if not item:
            self._remove_cache_dir(item_id)
            return False
        # Current cache flow keeps video and audio tracks separate so the host
        # can switch audio variants without remuxing a single output file.
        return self._cache_item_multi(
            item_id,
            item,
            allow_refresh_retry=allow_refresh_retry,
            playback_selector=playback_selector,
        )

    def _cache_item_multi(
        self,
        item_id: str,
        item,
        *,
        allow_refresh_retry: bool,
        playback_selector: PlaybackSelector | None = None,
    ) -> bool:
        self._clear_item_download_progress(item_id)
        self.store.update_item(
            item_id,
            cache_status="queued",
            cache_progress=0.0,
            cache_message="等待缓存队列",
            persist_backup=False,
        )
        self._record_item_activity(item_id)

        item_dir = CACHE_DIR / item_id
        item_dir.mkdir(parents=True, exist_ok=True)
        download_source = self._current_download_source()
        if download_source in (DOWNLOAD_SOURCE_DOWNKYI, DOWNLOAD_SOURCE_NATIVE):
            self._cleanup_attempt_dirs(item_dir)
        log_path = self._item_log_path(item_id, download_source)
        self._append_log_line(log_path, "")
        self._append_log_line(log_path, f"[{self._log_timestamp()}] start cache: {item.display_title}")

        if download_source == DOWNLOAD_SOURCE_NATIVE:
            if not rust_runtime.http_download_available() or not rust_runtime.media_backend_available():
                status = rust_runtime.runtime_status()
                message = str(status.get("error") or "Rust runtime is unavailable")
                self._append_log_line(
                    log_path,
                    f"[{self._log_timestamp()}] Rust runtime unavailable: {message}",
                )
                self.store.update_item(
                    item_id,
                    cache_status="failed",
                    cache_message=f"Rust Native 不可用: {message}",
                    persist_backup=False,
                )
                return False
            binary_path = Path()
            ffmpeg_path = Path()
        else:
            try:
                binary_path = self._ensure_downloader(download_source)
            except Exception as exc:  # noqa: BLE001
                label = self._download_source_label(download_source)
                self.store.update_item(
                    item_id,
                    cache_status="failed",
                    cache_message=f"{label} 不可用: {exc}",
                    persist_backup=False,
                )
                return False
            try:
                ffmpeg_path = self._ensure_ffmpeg(force_refresh=False)
            except Exception as exc:  # noqa: BLE001
                self._append_log_line(
                    log_path,
                    f"[{self._log_timestamp()}] ffmpeg unavailable: {exc}",
                )
                self.store.update_item(
                    item_id,
                    cache_status="failed",
                    cache_message=f"FFmpeg 不可用: {exc}",
                    persist_backup=False,
                )
                return False

        if not self._should_cache(item_id):
            return False

        self.store.update_item(
            item_id,
            cache_status="downloading",
            cache_message=self._cache_start_message(item),
            persist_backup=False,
        )
        self._record_item_activity(item_id)

        try:
            cache_result = self._download_selected_streams(
                item,
                binary_path,
                ffmpeg_path,
                item_dir,
                log_path,
                download_source=download_source,
                playback_selector=playback_selector,
            )
            self._raise_if_retry_requested(item_id)
            self._raise_if_priority_shift(item_id)
            native_tracks_prevalidated = bool(
                cache_result.get("native_tracks_prevalidated")
            )
            downkyi_tracks_prevalidated = bool(
                cache_result.get("downkyi_tracks_prevalidated")
            )
            if download_source == DOWNLOAD_SOURCE_DOWNKYI and not downkyi_tracks_prevalidated:
                self._normalize_downkyi_cache_result(cache_result, ffmpeg_path, log_path)
            if not native_tracks_prevalidated and not downkyi_tracks_prevalidated:
                self._validate_cache_result(item.id, cache_result, ffmpeg_path, log_path)
            self._raise_if_retry_requested(item_id)
            self._raise_if_priority_shift(item_id)
            if download_source in (DOWNLOAD_SOURCE_DOWNKYI, DOWNLOAD_SOURCE_NATIVE):
                self._publish_validated_cache_result(cache_result, log_path)
        except CacheCancelledError as exc:
            if str(exc) == RETRY_REQUESTED_MESSAGE:
                self._take_retry_request(item_id)
                self._append_log_line(log_path, f"[{self._log_timestamp()}] restarting cache by manual request")
                self._remove_cache_dir(item_id)
                fresh_item = self.store.get_item(item_id)
                if fresh_item and self._should_cache(item_id):
                    return self._cache_item_multi(item_id, fresh_item, allow_refresh_retry=allow_refresh_retry)
                return False
            self._take_cache_interrupt_message(item_id)
            self._append_log_line(log_path, f"[{self._log_timestamp()}] cancelled: {exc}")
            self._drop_item_cache(item_id, str(exc))
            return False
        except DownloadCommandError as exc:
            self._cleanup_attempt_dirs(item_dir)
            if self._take_retry_request(item_id):
                self._append_log_line(log_path, f"[{self._log_timestamp()}] restarting cache by manual request")
                self._remove_cache_dir(item_id)
                fresh_item = self.store.get_item(item_id)
                if fresh_item and self._should_cache(item_id):
                    return self._cache_item_multi(item_id, fresh_item, allow_refresh_retry=allow_refresh_retry)
                return False
            last_message = str(exc)
            if (
                download_source == DOWNLOAD_SOURCE_BBDOWN
                and allow_refresh_retry
                and self._should_force_refresh_bbdown(last_message)
            ):
                self._append_log_line(
                    log_path,
                    f"[{self._log_timestamp()}] detected stale BBDown hint, forcing refresh and retry",
                )
                self._append_log_line(
                    log_path,
                    f"[{self._log_timestamp()}] detected stale BBDown hint, forcing refresh and retry",
                )
                try:
                    self._ensure_bbdown(force_refresh=True)
                    self._clear_item_download_progress(item_id)
                    self._safe_rmtree(item_dir)
                    item_dir.mkdir(parents=True, exist_ok=True)
                    return self._cache_item_multi(item_id, item, allow_refresh_retry=False)
                except Exception as refresh_exc:  # noqa: BLE001
                    self._append_log_line(
                        log_path,
                        f"[{self._log_timestamp()}] forced BBDown refresh failed: {refresh_exc}",
                    )
            self._clear_item_download_progress(item_id)
            _debug_print(f"[bilikara-cache] item={item_id} download_source={download_source} FAILED: {last_message}")
            self._append_log_line(log_path, f"[{self._log_timestamp()}] failed: {last_message}")
            self.store.update_item(
                item_id,
                cache_status="failed",
                cache_message=f"缓存失败: {last_message}",
                persist_backup=False,
            )
            self._record_item_activity(item_id)
            return False
        except Exception as exc:  # noqa: BLE001
            self._cleanup_attempt_dirs(item_dir)
            if self._take_retry_request(item_id):
                self._append_log_line(log_path, f"[{self._log_timestamp()}] restarting cache by manual request")
                self._remove_cache_dir(item_id)
                fresh_item = self.store.get_item(item_id)
                if fresh_item and self._should_cache(item_id):
                    return self._cache_item_multi(item_id, fresh_item, allow_refresh_retry=allow_refresh_retry)
                return False
            last_message = str(exc)
            self._clear_item_download_progress(item_id)
            _debug_print(f"[bilikara-cache] item={item_id} download_source={download_source} FAILED: {last_message}")
            self._append_log_line(log_path, f"[{self._log_timestamp()}] failed: {last_message}")
            self.store.update_item(
                item_id,
                cache_status="failed",
                cache_message=f"缓存失败: {last_message}",
                persist_backup=False,
            )
            self._record_item_activity(item_id)
            return False

        video_file = cache_result["video_file"]
        self._clear_item_download_progress(item_id)
        self.store.update_item(
            item_id,
            cache_status="ready",
            cache_progress=100.0,
            cache_message=self._ready_message(item),
            video_relative_path=cache_result["video_relative_path"],
            video_media_url=cache_result["video_media_url"],
            audio_variants=cache_result["audio_variants"],
            selected_audio_variant_id=cache_result["selected_audio_variant_id"],
            persist_backup=False,
        )
        self._record_item_activity(item_id)
        self._append_log_line(log_path, f"[{self._log_timestamp()}] ready: {video_file.name}")
        return True

    # LEGACY: old single-pass BBDown cache path. It produced one muxed media
    # file and populated local_relative_path/local_media_url. The current host
    # flow uses `_cache_item_multi()` instead so audio variants can switch
    # without rebuilding a single output file.
    # def _cache_item_legacy(self, item_id: str, item, allow_refresh_retry: bool = True) -> None:
    #     """Legacy single-pass BBDown caching path kept for reference.

    #     This was the original implementation before `_cache_item_multi()`
    #     became the default workflow. It is not invoked by the current host
    #     flow, but we keep it as a documented fallback/reference instead of
    #     leaving it as unreachable inline code.
    #     """
    #     log_path = self._item_log_path(item_id)

    #     self.store.update_item(
    #         item_id,
    #         cache_status="queued",
    #         cache_progress=0.0,
    #         cache_message="等待缓存队列",
    #         persist_backup=False,
    #     )

    #     try:
    #         binary_path = self._ensure_bbdown()
    #     except Exception as exc:  # noqa: BLE001
    #         self.store.update_item(
    #             item_id,
    #             cache_status="failed",
    #             cache_message=f"BBDown 不可用: {exc}",
    #             persist_backup=False,
    #         )
    #         return

    #     try:
    #         ffmpeg_path = self._ensure_ffmpeg(force_refresh=False)
    #     except Exception as exc:  # noqa: BLE001
    #         self._append_log_line(log_path, f"[{self._log_timestamp()}] ffmpeg unavailable: {exc}")
    #         self.store.update_item(
    #             item_id,
    #             cache_status="failed",
    #             cache_message=f"FFmpeg 不可用: {exc}",
    #             persist_backup=False,
    #         )
    #         return

    #     if not self._should_cache(item_id):
    #         return

    #     item_dir = CACHE_DIR / item_id
    #     item_dir.mkdir(parents=True, exist_ok=True)
    #     log_path = self._item_log_path(item_id)
    #     self.store.update_item(
    #         item_id,
    #         cache_status="downloading",
    #         cache_message="开始缓存视频",
    #         persist_backup=False,
    #     )
    #     self._append_log_line(log_path, "")
    #     self._append_log_line(log_path, f"[{self._log_timestamp()}] start cache: {item.display_title}")

    #     command = [
    #         str(binary_path),
    #         item.resolved_url,
    #         "-p",
    #         str(item.page),
    #         "--work-dir",
    #         str(item_dir),
    #         "--ffmpeg-path",
    #         self._bbdown_ffmpeg_path_arg(ffmpeg_path),
    #         "--file-pattern",
    #         "video",
    #         "--skip-subtitle",
    #         "--skip-cover",
    #         "--skip-ai",
    #     ]
    #     if COOKIE:
    #         command.extend(["-c", COOKIE])
    #     self._append_log_line(log_path, f"[{self._log_timestamp()}] command: {json.dumps(command, ensure_ascii=False)}")

    #     cancelled = False
    #     cancel_message = "缓存已停止"
    #     last_message = "缓存中"
    #     process = subprocess.Popen(
    #         command,
    #         stdout=subprocess.PIPE,
    #         stderr=subprocess.STDOUT,
    #         text=True,
    #         errors="replace",
    #         bufsize=1,
    #         cwd=str(BB_DOWN_DIR),
    #         env=self._tool_process_env(ffmpeg_path),
    #         **self._hidden_process_kwargs(),
    #     )
    #     with self.lock:
    #         self.active_process = process
    #         self.active_item_id = item_id
    #     try:
    #         assert process.stdout is not None
    #         for raw_line in self._iter_output_messages(process.stdout):
    #             line = self._normalize_output_line(raw_line)
    #             if not line:
    #                 continue
    #             last_message = line
    #             self._append_log_line(log_path, f"[{self._log_timestamp()}] {line}")
    #             progress = self._extract_progress(line)
    #             changes = {"cache_message": self._display_message(line, progress)}
    #             if progress is not None:
    #                 changes["cache_progress"] = progress
    #             self.store.update_item(item_id, persist_backup=False, **changes)
    #             if self.stop_event.is_set():
    #                 cancelled = True
    #                 cancel_message = "缓存已停止"
    #                 self._terminate_process(process)
    #                 break
    #             if not self._should_cache(item_id):
    #                 cancelled = True
    #                 cancel_message = self._outside_window_message()
    #                 self._terminate_process(process)
    #                 break
    #         return_code = process.wait()
    #     finally:
    #         with self.lock:
    #             if self.active_process is process:
    #                 self.active_process = None
    #                 self.active_item_id = None

    #     if cancelled or self.stop_event.is_set() or not self._should_cache(item_id):
    #         self._append_log_line(log_path, f"[{self._log_timestamp()}] cancelled: {cancel_message}")
    #         self._drop_item_cache(item_id, cancel_message)
    #         return

    #     if return_code != 0:
    #         if allow_refresh_retry and self._should_force_refresh_bbdown(last_message):
    #             self._append_log_line(
    #                 log_path,
    #                 f"[{self._log_timestamp()}] detected stale BBDown hint, forcing refresh and retry",
    #             )
    #             try:
    #                 self._ensure_bbdown(force_refresh=True)
    #                 shutil.rmtree(item_dir, ignore_errors=True)
    #                 item_dir.mkdir(parents=True, exist_ok=True)
    #                 self._cache_item_legacy(item_id, item, allow_refresh_retry=False)
    #                 return
    #             except Exception as exc:  # noqa: BLE001
    #                 self._append_log_line(
    #                     log_path,
    #                     f"[{self._log_timestamp()}] forced BBDown refresh failed: {exc}",
    #                 )
    #         self._append_log_line(
    #             log_path,
    #             f"[{self._log_timestamp()}] failed with exit code {return_code}: {last_message}",
    #         )
    #         self.store.update_item(
    #             item_id,
    #             cache_status="failed",
    #             cache_message=f"缓存失败: {last_message}",
    #             persist_backup=False,
    #         )
    #         return

    #     media_file = self._find_media_file(item_dir)
    #     if not media_file:
    #         self._append_log_line(
    #             log_path,
    #             f"[{self._log_timestamp()}] failed: media file not found after download",
    #         )
    #         self.store.update_item(
    #             item_id,
    #             cache_status="failed",
    #             cache_message="缓存完成，但没有找到可播放文件",
    #             persist_backup=False,
    #         )
    #         return

    #     relative_path = str(media_file.relative_to(CACHE_DIR))
    #     self.store.update_item(
    #         item_id,
    #         cache_status="ready",
    #         cache_progress=100.0,
    #         cache_message="缓存已完成",
    #         local_relative_path=relative_path,
    #         local_media_url=self._build_media_url(relative_path),
    #         persist_backup=False,
    #     )
    #     self._append_log_line(log_path, f"[{self._log_timestamp()}] ready: {media_file.name}")


    def _download_selected_streams(
        self,
        item,
        binary_path: Path,
        ffmpeg_path: Path,
        item_dir: Path,
        log_path: Path,
        *,
        download_source: str,
        playback_selector: PlaybackSelector | None = None,
    ) -> dict[str, object]:
        self._raise_if_priority_shift(item.id)
        selected_pages = self._selected_pages_for_item(item)
        video_page = item.video_page if item.video_page in selected_pages else selected_pages[0]
        video_track = {
            "key": self._download_track_key("video", video_page),
            "page": video_page,
            "stream_kind": "video",
            "label": self._download_track_label("video", video_page),
            "order": 0,
        }
        audio_tracks = [
            {
                "key": self._download_track_key("audio", page),
                "page": page,
                "stream_kind": "audio",
                "label": self._download_track_label("audio", page),
                "order": index + 1,
            }
            for index, page in enumerate(selected_pages)
        ]
        download_tracks = [video_track, *audio_tracks]
        self._begin_download_progress(item.id, download_tracks)

        if download_source == DOWNLOAD_SOURCE_YTDLP:
            ordered_tracks = [*audio_tracks, video_track]
            result_paths: dict[str, Path] = {}
            for track in ordered_tracks:
                self._raise_if_priority_shift(item.id)
                self._raise_if_retry_requested(item.id)
                result_paths[str(track["key"])] = self._download_page_stream(
                    item,
                    binary_path,
                    ffmpeg_path,
                    item_dir,
                    log_path,
                    page=int(track["page"]),
                    stream_kind=str(track["stream_kind"]),
                    track_key=str(track["key"]),
                    download_source=download_source,
                    playback_selector=playback_selector,
                )
        elif download_source == DOWNLOAD_SOURCE_NATIVE:
            dash_streams = self._resolve_dash_streams(
                item,
                playback_selector=playback_selector,
                native_media=True,
            )
            result_paths = self._download_dash_streams_native(
                item,
                item_dir,
                log_path,
                dash_streams=dash_streams,
                video_track=video_track,
                audio_tracks=audio_tracks,
                playback_selector=playback_selector,
            )
        elif download_source == DOWNLOAD_SOURCE_DOWNKYI:
            dash_streams = self._resolve_dash_streams(
                item,
                playback_selector=playback_selector,
            )
            result_paths = self._download_dash_streams_with_aria2c(
                item,
                binary_path,
                ffmpeg_path,
                item_dir,
                log_path,
                dash_streams=dash_streams,
                video_track=video_track,
                audio_tracks=audio_tracks,
                validate_tracks=True,
                playback_selector=playback_selector,
            )
        else:
            result_paths = {}
            max_workers = max(1, min(len(download_tracks), MAX_PARALLEL_TRACK_DOWNLOADS))
            executor = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="bilikara-cache-track")
            future_to_track = {
                executor.submit(
                    self._download_page_stream,
                    item,
                    binary_path,
                    ffmpeg_path,
                    item_dir,
                    log_path,
                    page=int(track["page"]),
                    stream_kind=str(track["stream_kind"]),
                    track_key=str(track["key"]),
                    download_source=download_source,
                    playback_selector=playback_selector,
                ): track
                for track in download_tracks
            }
            try:
                done, pending = wait(future_to_track, return_when=FIRST_EXCEPTION)
                exceptions: list[Exception] = []
                for future in done:
                    if future.cancelled():
                        continue
                    try:
                        future.result()
                    except Exception as exc:  # noqa: BLE001
                        exceptions.append(exc)

                if exceptions:
                    for future in pending:
                        future.cancel()
                    self._terminate_item_processes(item.id)
                    still_running = [future for future in pending if not future.cancelled()]
                    if still_running:
                        wait(still_running)
                        for future in still_running:
                            if future.cancelled():
                                continue
                            try:
                                future.result()
                            except Exception as exc:  # noqa: BLE001
                                exceptions.append(exc)
                    raise self._preferred_download_exception(exceptions)

                for future, track in future_to_track.items():
                    result_paths[str(track["key"])] = future.result()
            finally:
                executor.shutdown(wait=True)

        video_file = result_paths[str(video_track["key"])]
        audio_files: list[tuple[int, Path, str]] = []
        for track in audio_tracks:
            page = int(track["page"])
            audio_files.append(
                (
                    page,
                    result_paths[str(track["key"])],
                    self._part_label_for_page(item, page),
                )
            )

        self.store.update_item(
            item.id,
            cache_progress=99.0,
            cache_message=f"准备 {len(audio_files)} 条音轨",
            persist_backup=False,
        )
        self._record_item_activity(item.id)

        # LEGACY: older split-cache builds generated one muxed MP4 per audio
        # variant and exposed it as audio_variants[*].media_url. The current
        # host player uses the independent video track plus audio_url directly,
        # so keep the old mux path commented below as a reference only.
        # variant_files = self._build_audio_variant_outputs(
        #     item,
        #     ffmpeg_path,
        #     item_dir,
        #     log_path,
        #     video_file=video_file,
        #     audio_files=audio_files,
        # )

        audio_variants = []
        for index, (page, audio_file, label) in enumerate(audio_files):
            audio_variants.append(
                {
                    "id": self._variant_id(page, label, index),
                    "label": label,
                    "page": page,
                    "audio_url": self._build_media_url(str(audio_file.relative_to(CACHE_DIR))),
                }
            )
        existing_variant_id = str(item.selected_audio_variant_id or "").strip()
        allowed_variant_ids = {
            str(variant.get("id") or "").strip()
            for variant in audio_variants
            if isinstance(variant, dict)
        }
        selected_audio_variant_id = (
            existing_variant_id
            if existing_variant_id and existing_variant_id in allowed_variant_ids
            else (str(audio_variants[0].get("id") or "").strip() if audio_variants else "")
        )
        validation_files = [
            {
                "label": f"视频轨 P{video_page}",
                "path": video_file,
                "required_streams": {"video"},
                "stream_kind": "video",
                "page": video_page,
                "cid": self._cid_for_validation(item, video_page),
                "expected_duration": self._duration_for_page(item, video_page),
                "download_source": download_source,
                "stream_metadata": video_track.get("stream_metadata") or {},
            },
            *[
                {
                    "label": f"音轨 P{page}",
                    "path": audio_file,
                    "required_streams": {"audio"},
                    "stream_kind": "audio",
                    "page": page,
                    "cid": self._cid_for_validation(item, page),
                    "download_source": download_source,
                    "stream_metadata": next(
                        (track.get("stream_metadata") or {} for track in audio_tracks if int(track["page"]) == page),
                        {},
                    ),
                }
                for page, audio_file, _label in audio_files
            ],
            # LEGACY: muxed variant files are no longer generated, so ffprobe
            # no longer validates "播放文件 {label}" video+audio MP4 outputs.
            # *[
            #     {
            #         "label": f"播放文件 {label}",
            #         "path": path,
            #         "required_streams": {"video", "audio"},
            #     }
            #     for _variant_id, label, path in variant_files
            # ],
        ]
        result = {
            "video_file": video_file,
            "video_relative_path": str(video_file.relative_to(CACHE_DIR)),
            "video_media_url": self._build_media_url(str(video_file.relative_to(CACHE_DIR))),
            "audio_variants": audio_variants,
            "selected_audio_variant_id": selected_audio_variant_id,
            "validation_files": validation_files,
        }
        if download_source in (DOWNLOAD_SOURCE_DOWNKYI, DOWNLOAD_SOURCE_NATIVE):
            validation_metadata = [
                dict(track.get("validation_metadata") or {})
                for track in download_tracks
                if isinstance(track.get("validation_metadata"), dict)
            ]
            if len(validation_metadata) != len(download_tracks):
                source_label = self._download_source_label(download_source)
                raise DownloadCommandError(
                    f"缓存校验失败: {source_label} 轨道缺少独立校验结果"
                )
            result["validation_metadata"] = validation_metadata
            result["validation_failure_count"] = 0
            if download_source == DOWNLOAD_SOURCE_NATIVE:
                result["native_tracks_prevalidated"] = True
            else:
                result["downkyi_tracks_prevalidated"] = True
        return result

    @staticmethod
    def _preferred_download_exception(exceptions: list[Exception]) -> Exception:
        def priority(exc: Exception) -> int:
            if isinstance(exc, CacheCancelledError) and str(exc) == RETRY_REQUESTED_MESSAGE:
                return 0
            if not isinstance(exc, CacheCancelledError):
                return 1
            return 2

        return sorted(exceptions, key=priority)[0]

    @staticmethod
    def _download_track_key(stream_kind: str, page: int) -> str:
        return f"{stream_kind}-p{page}"

    @staticmethod
    def _download_track_label(stream_kind: str, page: int) -> str:
        label = "视频轨" if stream_kind == "video" else "音轨"
        return f"{label}P{page}"

    def _download_page_stream(
        self,
        item,
        binary_path: Path,
        ffmpeg_path: Path,
        item_dir: Path,
        log_path: Path,
        *,
        page: int,
        stream_kind: str,
        track_key: str,
        download_source: str,
        playback_selector: PlaybackSelector | None = None,
    ) -> Path:
        page_url = self._page_url(item.resolved_url, page)
        target_dir = item_dir / f"{stream_kind}-p{page}"
        target_dir.mkdir(parents=True, exist_ok=True)
        command = self._download_command(
            download_source,
            binary_path,
            ffmpeg_path,
            page_url,
            page=page,
            stream_kind=stream_kind,
            target_dir=target_dir,
            playback_selector=playback_selector,
        )

        label = "视频轨" if stream_kind == "video" else "音轨"
        stage_label = f"下载{label} P{page}"
        self._raise_if_priority_shift(item.id)
        self._run_item_command(
            item.id,
            command,
            ffmpeg_path,
            log_path,
            stage_label=stage_label,
            stream_kind=stream_kind,
            target_dir=target_dir,
            track_key=track_key,
            tool_dir=binary_path.parent,
        )

        allowed_extensions = MEDIA_EXTENSIONS if stream_kind == "video" else AUDIO_EXTENSIONS
        self._raise_if_retry_requested(item.id)
        stream_file = self._find_stream_file(target_dir, allowed_extensions)
        if not stream_file:
            raise DownloadCommandError(f"{stage_label} 完成后未找到输出文件")
        try:
            final_size = stream_file.stat().st_size
        except OSError:
            final_size = 0
        self._update_download_track_progress(
            item.id,
            track_key=track_key,
            target_dir=target_dir,
            target_bytes=final_size,
            done=True,
        )
        return stream_file

    def _download_command(
        self,
        download_source: str,
        binary_path: Path,
        ffmpeg_path: Path,
        page_url: str,
        *,
        page: int,
        stream_kind: str,
        target_dir: Path,
        playback_selector: PlaybackSelector | None = None,
    ) -> list[str]:
        if download_source == DOWNLOAD_SOURCE_YTDLP:
            return self._ytdlp_download_command(
                binary_path,
                ffmpeg_path,
                page_url,
                page=page,
                stream_kind=stream_kind,
                target_dir=target_dir,
                playback_selector=playback_selector,
            )
        if download_source == DOWNLOAD_SOURCE_DOWNKYI:
            return self._downkyi_download_command(
                binary_path,
                ffmpeg_path,
                page_url,
                page=page,
                stream_kind=stream_kind,
                target_dir=target_dir,
            )
        return self._bbdown_download_command(
            binary_path,
            ffmpeg_path,
            page_url,
            page=page,
            stream_kind=stream_kind,
            target_dir=target_dir,
            playback_selector=playback_selector,
        )

    def _bbdown_download_command(
        self,
        binary_path: Path,
        ffmpeg_path: Path,
        page_url: str,
        *,
        page: int,
        stream_kind: str,
        target_dir: Path,
        playback_selector: PlaybackSelector | None = None,
    ) -> list[str]:
        command = [
            self._tool_arg_path(binary_path),
            page_url,
            "-p",
            str(page),
            *self._bbdown_stream_preference_args(stream_kind, playback_selector=playback_selector),
            "--work-dir",
            self._tool_arg_path(target_dir),
            "--ffmpeg-path",
            self._bbdown_ffmpeg_path_arg(ffmpeg_path),
            "--file-pattern",
            f"{stream_kind}-p{page}",
            "--skip-mux",
            "--skip-subtitle",
            "--skip-cover",
            "--skip-ai",
            "--video-only" if stream_kind == "video" else "--audio-only",
        ]
        cookie = effective_bilibili_cookie()
        if cookie:
            command.extend(["-c", cookie])
        return command

    def _ytdlp_download_command(
        self,
        binary_path: Path,
        ffmpeg_path: Path,
        page_url: str,
        *,
        page: int,
        stream_kind: str,
        target_dir: Path,
        playback_selector: PlaybackSelector | None = None,
    ) -> list[str]:
        command = [
            self._tool_arg_path(binary_path),
            "--newline",
            "--no-playlist",
            "--retries",
            "10",
            "--fragment-retries",
            "10",
            "--file-access-retries",
            "10",
            "--retry-sleep",
            "3",
            "--throttled-rate",
            "100K",
            "--concurrent-fragments",
            "1",
            "--ffmpeg-location",
            self._tool_arg_path(ffmpeg_path),
            "-f",
            self._ytdlp_format_selector(stream_kind, playback_selector=playback_selector),
            "-o",
            self._tool_arg_path(target_dir / f"{stream_kind}-p{page}.%(ext)s"),
            page_url,
        ]
        cookie = effective_bilibili_cookie()
        if cookie:
            cookie_file = self._write_ytdlp_cookie_jar(cookie, target_dir)
            command.extend(["--cookies", self._tool_arg_path(cookie_file)])
        else:
            command.extend(["--cookies-from-browser", self._ytdlp_browser_cookie_source()])
        return command

    def _ytdlp_format_selector(
        self,
        stream_kind: str,
        *,
        playback_selector: PlaybackSelector | None = None,
    ) -> str:
        if stream_kind == "audio":
            with self.lock:
                audio_hires = self.audio_hires
            return "ba/bestaudio" if audio_hires else "ba[abr<=320]/ba/bestaudio"

        with self.lock:
            video_quality = self.video_quality
            force_avc = self._should_force_avc_locked()
            avc_quality_cap = self.avc_quality_cap if force_avc else ""
        max_height = self._ytdlp_max_height(
            video_quality, avc_quality_cap, playback_selector=playback_selector
        )
        codec_filter = "[vcodec^=avc1]" if force_avc else ""
        height_filter = f"[height<={max_height}]" if max_height else ""
        return (
            f"bv*{codec_filter}{height_filter}/"
            f"bestvideo{codec_filter}{height_filter}/"
            f"bv*{height_filter}/bestvideo{height_filter}/bv*/bestvideo"
        )

    @staticmethod
    def _py_ytdlp_max_height(video_quality: object, quality_cap: object = "") -> int:
        quality = CacheManager._py_optional_video_quality(
            quality_cap
        ) or CacheManager._py_normalize_video_quality(video_quality)
        if "360" in quality:
            return 360
        if "480" in quality:
            return 480
        if "720" in quality:
            return 720
        if "1080" in quality:
            return 1080
        if "4K" in quality:
            return 2160
        if "8K" in quality:
            return 4320
        return 1080

    @staticmethod
    def _ytdlp_max_height(
        video_quality: object,
        quality_cap: object = "",
        *,
        playback_selector: PlaybackSelector | None = None,
    ) -> int:
        response = CacheManager._native_quality_policy(
            video_quality, quality_cap, playback_selector=playback_selector
        )
        if response is not None:
            return int(response["effective_max_height"])
        return CacheManager._py_ytdlp_max_height(video_quality, quality_cap)

    @staticmethod
    def _ytdlp_browser_cookie_source() -> str:
        return os.getenv("YTDLP_COOKIES_FROM_BROWSER", "chrome").strip() or "chrome"

    @staticmethod
    def _write_ytdlp_cookie_jar(cookie_header: str, target_dir: Path) -> Path:
        """Write a Netscape cookie jar file from a cookie header string.

        yt-dlp rejects ``--add-header Cookie:`` values that contain
        characters like ``*`` (common in Bilibili SESSDATA).  Writing a
        standard cookie jar file and passing ``--cookies`` avoids this.
        """
        cookie_file = target_dir / "cookies.txt"
        lines = ["# Netscape HTTP Cookie File", "# Generated by bilikara for yt-dlp", ""]
        secure_names = {
            name.lower()
            for name in ("SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5")
        }
        for pair in cookie_header.split(";"):
            pair = pair.strip()
            if not pair or "=" not in pair:
                continue
            name, _, value = pair.partition("=")
            name = name.strip()
            value = value.strip()
            if not name:
                continue
            secure = "TRUE" if name.lower() in secure_names else "FALSE"
            # domain  include_subdomains  path  secure  expiry  name  value
            lines.append(f".bilibili.com\tTRUE\t/\t{secure}\t0\t{name}\t{value}")
        lines.append("")
        cookie_file.write_text("\n".join(lines), encoding="utf-8")
        return cookie_file

    def _resolve_dash_streams(
        self,
        item,
        cid: int | None = None,
        *,
        playback_selector: PlaybackSelector | None = None,
        native_media: bool = False,
    ) -> dict:
        """Resolve DASH stream URLs from Bilibili API for the given item.

        Returns a dict with keys matching fetch_dash_playurl output:
          - "video": list of video stream dicts
          - "audio": list of audio stream dicts
          - "flac": FLAC stream dict or None
          - "dolby": Dolby stream dict or None
        """
        cookie = effective_bilibili_cookie()
        if not cookie:
            raise BilibiliError("Downkyi 模式需要 Bilibili Cookie 才能获取播放地址")

        resolved_cid = cid if cid is not None else item.cid

        if native_media:
            dash = rust_runtime.fetch_bilibili_dash_playurl(
                bvid=item.bvid,
                cid=resolved_cid,
                avid=item.aid,
                cookie=cookie,
                user_agent=str(BILIBILI_HEADERS.get("User-Agent") or ""),
                referer=str(BILIBILI_HEADERS.get("Referer") or ""),
            )
        else:
            dash = fetch_dash_playurl(
                bvid=item.bvid,
                cid=resolved_cid,
                avid=item.aid,
            )

        if not dash.get("video") and not dash.get("audio"):
            raise BilibiliError("未获取到任何视频/音频流地址")

        with self.lock:
            force_avc = self._should_force_avc_locked()
            avc_quality_cap = self.avc_quality_cap if force_avc else ""
            video_quality = self.video_quality
            audio_hires = self.audio_hires

        video_streams = dash.get("video") or []
        codec_filter = "avc" if force_avc or native_media else None
        max_quality_id = self._dash_max_quality_id(
            video_quality, playback_selector=playback_selector
        )
        filtered_video = self._select_dash_video_stream(
            video_streams,
            max_quality_id=max_quality_id,
            codec_filter=codec_filter,
            avc_quality_cap=avc_quality_cap,
            playback_selector=playback_selector,
        )
        if native_media and filtered_video and filtered_video.get("codec_name") != "avc":
            raise BilibiliError("Rust Native 未找到可用的 AVC 视频流")
        audio_streams = dash.get("audio") or []
        selected_audio = self._select_dash_audio_stream(
            audio_streams, audio_hires=audio_hires, playback_selector=playback_selector
        )
        flac_info = dash.get("flac")
        dolby_info = dash.get("dolby")

        if native_media:
            # The native media backend supports FLAC-in-MP4, but not Dolby E-AC-3.
            selected_audio = self._select_preferred_dash_audio(
                [selected_audio] if selected_audio else [],
                flac_info,
                None,
                audio_hires=audio_hires,
                playback_selector=playback_selector,
            )

        result = {
            "video": [filtered_video] if filtered_video else [],
            "audio": [selected_audio] if selected_audio else [],
            "flac": flac_info if audio_hires and flac_info and not native_media else None,
            "dolby": dolby_info if audio_hires and dolby_info and not native_media else None,
        }

        if not result["video"]:
            raise BilibiliError("未找到符合质量要求的视频流")
        if not result["audio"] and not result["flac"] and not result["dolby"]:
            raise BilibiliError("未找到符合质量要求的音频流")

        return result

    def _cid_for_page(self, item, page: int) -> int:
        """Resolve the CID for a given page number.

        Tries selected_pages first, then available_pages. Falls back to item.cid if
        it matches item.page. Raises RuntimeError if unable to resolve.
        """
        selected_pages = getattr(item, "selected_pages", None)
        selected_cids = getattr(item, "selected_cids", None)
        if selected_pages and selected_cids:
            try:
                idx = selected_pages.index(page)
                if idx < len(selected_cids):
                    return selected_cids[idx]
            except ValueError:
                pass

        available_pages = getattr(item, "available_pages", None)
        available_cids = getattr(item, "available_cids", None)
        if available_pages and available_cids:
            try:
                idx = available_pages.index(page)
                if idx < len(available_cids):
                    return available_cids[idx]
            except ValueError:
                pass

        if getattr(item, "page", None) == page:
            cid = getattr(item, "cid", 0)
            if cid:
                return cid

        raise RuntimeError(f"无法解析 P{page} 的 cid，不能下载对应音频")

    @staticmethod
    def _duration_for_page(item, page: int) -> float | None:
        for pages_attr, durations_attr in (
            ("selected_pages", "selected_durations"),
            ("available_pages", "available_durations"),
        ):
            pages = list(getattr(item, pages_attr, None) or [])
            durations = list(getattr(item, durations_attr, None) or [])
            try:
                index = pages.index(page)
            except ValueError:
                continue
            if index >= len(durations):
                continue
            try:
                duration = float(durations[index])
            except (TypeError, ValueError):
                continue
            if duration > 0:
                return duration
        return None

    def _cid_for_validation(self, item, page: int) -> int:
        try:
            return self._cid_for_page(item, page)
        except RuntimeError:
            return 0

    @staticmethod
    def _py_dash_max_quality_id(video_quality: str) -> int:
        quality_id_map = {
            "360P 流畅": 16,
            "480P 清晰": 32,
            "720P 高清": 64,
            "720P 60帧": 74,
            "1080P 高清": 80,
            "1080P 高码率": 112,
            "1080P 高帧率": 116,
            "4K 超清": 120,
            "HDR 真彩": 125,
            "杜比视界": 126,
            "8K 超高清": 127,
        }
        return quality_id_map.get(video_quality, 80)

    @staticmethod
    def _dash_max_quality_id(
        video_quality: str,
        *,
        playback_selector: PlaybackSelector | None = None,
    ) -> int:
        if not isinstance(video_quality, str):
            return CacheManager._py_dash_max_quality_id(video_quality)
        response = CacheManager._native_quality_policy(
            video_quality, playback_selector=playback_selector
        )
        if response is not None:
            return int(response["dash_max_quality_id"])
        return CacheManager._py_dash_max_quality_id(video_quality)

    @staticmethod
    def _py_select_dash_video_stream(
        video_streams: list[dict],
        *,
        max_quality_id: int,
        codec_filter: str | None = None,
        avc_quality_cap: str = "",
    ) -> dict | None:
        max_avc_quality_id = (
            CacheManager._py_dash_max_quality_id(avc_quality_cap)
            if avc_quality_cap
            else 0
        )
        candidates = []
        for stream in video_streams:
            quality_id = stream.get("quality_id", 0)
            if quality_id > max_quality_id:
                continue
            codec_name = stream.get("codec_name", "")
            if codec_filter and codec_name != codec_filter:
                continue
            if codec_filter == "avc" and max_avc_quality_id and quality_id > max_avc_quality_id:
                continue
            candidates.append(stream)
        if not candidates:
            for stream in video_streams:
                quality_id = stream.get("quality_id", 0)
                if quality_id <= max_quality_id:
                    candidates.append(stream)
            if not candidates:
                candidates = list(video_streams)
        if not candidates:
            return None
        candidates.sort(key=lambda s: (-s.get("quality_id", 0), -s.get("bandwidth", 0)))
        return candidates[0]

    @staticmethod
    def _select_dash_video_stream(
        video_streams: list[dict],
        *,
        max_quality_id: int,
        codec_filter: str | None = None,
        avc_quality_cap: str = "",
        playback_selector: PlaybackSelector | None = None,
    ) -> dict | None:
        try:
            streams = [
                {
                    "original_index": index,
                    "quality_id": stream.get("quality_id", 0),
                    "bandwidth": stream.get("bandwidth", 0),
                    "codec": stream.get("codec_name", ""),
                }
                for index, stream in enumerate(video_streams)
            ]
            max_avc_quality_id = (
                CacheManager._dash_max_quality_id(
                    avc_quality_cap, playback_selector=playback_selector
                )
                if avc_quality_cap
                else None
            )
            request = {
                "schema_version": 1,
                "max_quality_id": max_quality_id,
                "codec_filter": codec_filter,
                "max_avc_quality_id": max_avc_quality_id,
                "streams": streams,
            }
            if playback_selector is not None:
                def decode_native_video(response: object) -> dict | None:
                    if not isinstance(response, dict):
                        raise ValueError("invalid video stream response")
                    if response.get("status") == "no_match":
                        return None
                    return video_streams[response["selected_index"]]

                return playback_selector.decide(
                    "select_video_stream",
                    python=lambda: CacheManager._py_select_dash_video_stream(
                        video_streams,
                        max_quality_id=max_quality_id,
                        codec_filter=codec_filter,
                        avc_quality_cap=avc_quality_cap,
                    ),
                    rust=lambda: rust_backend.try_select_video_stream(
                        request, allow_python_reference=False
                    ),
                    decode_rust=decode_native_video,
                )
            completed, response = rust_backend.try_select_video_stream(request)
            if completed and response is not None:
                if response["status"] == "no_match":
                    return None
                return video_streams[response["selected_index"]]
        except (AttributeError, IndexError, TypeError, ValueError):
            pass
        return rust_backend.python_fallback(
            "select_video_stream",
            lambda: CacheManager._py_select_dash_video_stream(
                video_streams,
                max_quality_id=max_quality_id,
                codec_filter=codec_filter,
                avc_quality_cap=avc_quality_cap,
            ),
        )

    @staticmethod
    def _py_select_dash_audio_stream(
        audio_streams: list[dict], *, audio_hires: bool = True
    ) -> dict | None:
        if not audio_streams:
            return None
        candidates = list(audio_streams)
        quality_order = {
            30250: 0,   # Dolby Atmos
            30251: 1,   # Hi-Res FLAC
            30280: 2,   # High 192K
            30232: 3,   # Mid 132K
            30216: 4,   # Low 64K
        }
        if not audio_hires:
            high_quality_ids = {30250, 30251}
            candidates = [s for s in candidates if s.get("quality_id") not in high_quality_ids]
            if not candidates:
                candidates = list(audio_streams)
        candidates.sort(key=lambda s: quality_order.get(s.get("quality_id", 0), 99))
        return candidates[0]

    @staticmethod
    def _select_dash_audio_stream(
        audio_streams: list[dict],
        *,
        audio_hires: bool = True,
        playback_selector: PlaybackSelector | None = None,
    ) -> dict | None:
        try:
            request = {
                "schema_version": 1,
                "audio_hires": audio_hires,
                "regular_streams": [
                    {
                        "original_index": index,
                        "quality_id": stream.get("quality_id", 0),
                        "bandwidth": stream.get("bandwidth", 0),
                    }
                    for index, stream in enumerate(audio_streams)
                ],
            }
            if playback_selector is not None:
                def decode_native_audio(response: object) -> dict | None:
                    if not isinstance(response, dict):
                        raise ValueError("invalid audio stream response")
                    selected_index = response["selected_index"]
                    return None if selected_index is None else audio_streams[selected_index]

                return playback_selector.decide(
                    "select_audio_stream",
                    python=lambda: CacheManager._py_select_dash_audio_stream(
                        audio_streams, audio_hires=audio_hires
                    ),
                    rust=lambda: rust_backend.try_select_audio_stream(
                        request, allow_python_reference=False
                    ),
                    decode_rust=decode_native_audio,
                )
            completed, response = rust_backend.try_select_audio_stream(request)
            if completed and response is not None:
                selected_index = response["selected_index"]
                return None if selected_index is None else audio_streams[selected_index]
        except (AttributeError, IndexError, TypeError, ValueError):
            pass
        return rust_backend.python_fallback(
            "select_audio_stream",
            lambda: CacheManager._py_select_dash_audio_stream(
                audio_streams, audio_hires=audio_hires
            ),
        )

    @staticmethod
    def _py_select_preferred_dash_audio(
        best_audio: list[dict],
        flac_audio: dict | None,
        dolby_audio: dict | None,
        *,
        audio_hires: bool,
    ) -> dict | None:
        preferred_audio = best_audio[0] if best_audio else None
        if flac_audio and audio_hires:
            preferred_audio = flac_audio
        if dolby_audio and audio_hires:
            preferred_audio = dolby_audio
        return preferred_audio

    @staticmethod
    def _select_preferred_dash_audio(
        best_audio: list[dict],
        flac_audio: dict | None,
        dolby_audio: dict | None,
        *,
        audio_hires: bool,
        playback_selector: PlaybackSelector | None = None,
    ) -> dict | None:
        try:
            request = {
                "schema_version": 1,
                "audio_hires": audio_hires,
                "regular_candidates": [
                    {"original_index": index} for index in range(len(best_audio))
                ],
                "flac_available": bool(flac_audio),
                "dolby_available": bool(dolby_audio),
            }
            if playback_selector is not None:
                def decode_native_preferred(response: object) -> dict | None:
                    if not isinstance(response, dict):
                        raise ValueError("invalid preferred audio response")
                    source = response["preferred_source"]
                    if source == "dolby":
                        return dolby_audio
                    if source == "flac":
                        return flac_audio
                    if source == "regular":
                        return best_audio[response["selected_regular_index"]]
                    return None

                return playback_selector.decide(
                    "select_preferred_audio_source",
                    python=lambda: CacheManager._py_select_preferred_dash_audio(
                        best_audio,
                        flac_audio,
                        dolby_audio,
                        audio_hires=audio_hires,
                    ),
                    rust=lambda: rust_backend.try_select_preferred_audio_source(
                        request, allow_python_reference=False
                    ),
                    decode_rust=decode_native_preferred,
                )
            completed, response = rust_backend.try_select_preferred_audio_source(request)
            if completed and response is not None:
                source = response["preferred_source"]
                if source == "dolby":
                    return dolby_audio
                if source == "flac":
                    return flac_audio
                if source == "regular":
                    selected_index = response["selected_regular_index"]
                    return best_audio[selected_index]
                return None
        except (AttributeError, IndexError, TypeError, ValueError):
            pass
        return rust_backend.python_fallback(
            "select_preferred_audio_source",
            lambda: CacheManager._py_select_preferred_dash_audio(
                best_audio,
                flac_audio,
                dolby_audio,
                audio_hires=audio_hires,
            ),
        )

    def _download_dash_streams_native(
        self,
        item,
        item_dir: Path,
        log_path: Path,
        *,
        dash_streams: dict,
        video_track: dict,
        audio_tracks: list[dict],
        playback_selector: PlaybackSelector | None = None,
    ) -> dict[str, Path]:
        item_id = item.id
        cookie = effective_bilibili_cookie()
        selected_pages = self._selected_pages_for_item(item)
        video_page = item.video_page if item.video_page in selected_pages else selected_pages[0]
        video_stream = (dash_streams.get("video") or [{}])[0]
        video_urls = self._dash_stream_urls(
            dash_streams, "video", playback_selector=playback_selector
        )
        if not video_urls or str(video_stream.get("codec_name") or "") != "avc":
            raise DownloadCommandError("Rust Native 未找到可用的 AVC 视频流")

        track_args: list[tuple[dict, list[str], str, Path, str, str, dict[str, object]]] = [
            (
                video_track,
                video_urls,
                f"video-p{video_page}.mp4",
                item_dir / f"video-p{video_page}",
                f"下载视频轨 P{video_page}",
                "video",
                video_stream,
            )
        ]
        for track in audio_tracks:
            page = int(track["page"])
            cid = self._cid_for_page(item, page)
            self._append_log_line(
                log_path,
                f"[{self._log_timestamp()}] resolve native audio DASH: page={page}, cid={cid}",
            )
            try:
                page_dash = self._resolve_dash_streams(
                    item,
                    cid=cid,
                    playback_selector=playback_selector,
                    native_media=True,
                )
            except Exception as exc:  # noqa: BLE001
                raise DownloadCommandError(f"P{page} 音频解析失败: {exc}") from exc
            audio_stream = (page_dash.get("audio") or [{}])[0]
            audio_urls = self._preferred_audio_urls(
                audio_stream, playback_selector=playback_selector
            )
            if not audio_urls:
                raise DownloadCommandError(f"Rust Native 未找到音频轨 P{page} 的下载地址")
            audio_extension = (
                ".flac"
                if str(audio_stream.get("codec_name") or "") == "flac"
                else ".m4a"
            )
            track_args.append(
                (
                    track,
                    audio_urls,
                    f"audio-p{page}{audio_extension}",
                    item_dir / f"audio-p{page}",
                    f"下载音轨 P{page}",
                    "audio",
                    audio_stream,
                )
            )

        def download_track(args: tuple) -> tuple[str, Path]:
            track, urls, out_name, target_dir, stage_label, stream_kind, stream_metadata = args
            track["stream_metadata"] = dict(stream_metadata)
            track_key = str(track["key"])
            page = int(track["page"])
            cid = self._cid_for_page(item, page)
            last_error = "unknown error"
            for attempt in range(1, DOWNKYI_TRACK_MAX_ATTEMPTS + 1):
                self._raise_if_retry_requested(item_id)
                self._raise_if_priority_shift(item_id)
                if attempt > 1:
                    self._reset_download_track_progress(item_id, track_key)
                self._set_download_track_phase(
                    item_id,
                    track_key,
                    phase="downloading",
                    attempt=attempt,
                    max_attempts=DOWNKYI_TRACK_MAX_ATTEMPTS,
                )
                raw_path: Path | None = None
                try:
                    raw_name = f".{Path(out_name).stem}.raw-{uuid.uuid4().hex}{Path(out_name).suffix}"
                    raw_path = self._download_stream_with_rust(
                        item_id,
                        target_dir,
                        log_path,
                        urls=urls,
                        out_name=raw_name,
                        cookie=cookie,
                        stage_label=stage_label,
                        track_key=track_key,
                        stream_kind=stream_kind,
                        page=page,
                        cid=cid,
                        stream_metadata=stream_metadata,
                        mark_done=False,
                    )
                    self._set_download_track_phase(
                        item_id,
                        track_key,
                        phase="validating",
                        attempt=attempt,
                        max_attempts=DOWNKYI_TRACK_MAX_ATTEMPTS,
                    )
                    normalized_path = raw_path.with_name(out_name)
                    normalized = rust_runtime.normalize_media(
                        source=raw_path,
                        destination=normalized_path,
                        expected_kind=stream_kind,
                    )
                    raw_path.unlink(missing_ok=True)
                    output = normalized["output"]
                    duration = float(output.get("duration_seconds") or 0)
                    if duration < 1.0:
                        raise DownloadCommandError(
                            f"{stage_label}: Rust media validation reported an invalid duration"
                        )
                    expected_duration = (
                        self._duration_for_page(item, page) if stream_kind == "video" else None
                    )
                    if expected_duration:
                        tolerance = self._duration_tolerance(expected_duration)
                        if duration + tolerance < expected_duration:
                            raise DownloadCommandError(
                                f"{stage_label}: duration {duration:.1f}s is shorter than "
                                f"expected {expected_duration:.1f}s"
                            )
                    metadata = {
                        **dict(output),
                        "label": str(track.get("label") or stage_label),
                        "page": page,
                        "stream_kind": stream_kind,
                        "expected_duration": expected_duration,
                        "stream_metadata": dict(stream_metadata),
                    }
                    track["validation_metadata"] = metadata
                    final_size = normalized_path.stat().st_size
                    self._update_download_track_progress(
                        item_id,
                        track_key=track_key,
                        target_dir=normalized_path.parent,
                        current_bytes=final_size,
                        target_bytes=final_size,
                        done=True,
                        measure_path=False,
                    )
                    self._set_download_track_phase(
                        item_id,
                        track_key,
                        phase="ready",
                        attempt=attempt,
                        max_attempts=DOWNKYI_TRACK_MAX_ATTEMPTS,
                    )
                    self._append_log_line(
                        log_path,
                        f"[{self._log_timestamp()}] media_diagnostic: "
                        f"{json.dumps({'event': 'rust_media_ready', 'item_id': item_id, 'track_key': track_key, 'page': page, 'stream_kind': stream_kind, 'codec': output.get('codec'), 'duration': duration, 'sample_count': output.get('sample_count'), 'file_size': final_size}, ensure_ascii=False, sort_keys=True)}",
                    )
                    return track_key, normalized_path
                except CacheCancelledError:
                    if raw_path is not None:
                        self._safe_rmtree(raw_path.parent)
                    raise
                except Exception as exc:  # noqa: BLE001
                    last_error = self._compact_probe_error(str(exc))
                    if raw_path is not None:
                        self._safe_rmtree(raw_path.parent)
                    self._append_log_line(
                        log_path,
                        f"[{self._log_timestamp()}] Rust Native track attempt "
                        f"{attempt}/{DOWNKYI_TRACK_MAX_ATTEMPTS} failed: {last_error}",
                    )
                    if attempt < DOWNKYI_TRACK_MAX_ATTEMPTS:
                        self._set_download_track_phase(
                            item_id,
                            track_key,
                            phase="retrying",
                            attempt=attempt,
                            max_attempts=DOWNKYI_TRACK_MAX_ATTEMPTS,
                        )
                        if self.stop_event.wait(DOWNKYI_TRACK_RETRY_WAIT_SECONDS):
                            raise CacheCancelledError("cache stopped") from exc
            raise DownloadCommandError(
                f"{stage_label}: Rust Native failed after "
                f"{DOWNKYI_TRACK_MAX_ATTEMPTS} attempts: {last_error}"
            )

        result_paths: dict[str, Path] = {}
        max_workers = max(1, min(len(track_args), MAX_PARALLEL_TRACK_DOWNLOADS))
        executor = ThreadPoolExecutor(
            max_workers=max_workers, thread_name_prefix="bilikara-native-track"
        )
        future_to_track = {
            executor.submit(download_track, args): args[0] for args in track_args
        }
        try:
            done, pending = wait(future_to_track, return_when=FIRST_EXCEPTION)
            exceptions: list[Exception] = []
            for future in done:
                try:
                    track_key, media_path = future.result()
                    result_paths[track_key] = media_path
                except Exception as exc:  # noqa: BLE001
                    exceptions.append(exc)
            if exceptions:
                for future in pending:
                    future.cancel()
                for future in pending:
                    if future.cancelled():
                        continue
                    try:
                        future.result()
                    except Exception as exc:  # noqa: BLE001
                        exceptions.append(exc)
                raise self._preferred_download_exception(exceptions)
            for future in pending:
                track_key, media_path = future.result()
                result_paths[track_key] = media_path
        finally:
            executor.shutdown(wait=True)
        return result_paths

    def _download_dash_streams_with_aria2c(
        self,
        item,
        binary_path: Path,
        ffmpeg_path: Path,
        item_dir: Path,
        log_path: Path,
        *,
        dash_streams: dict,
        video_track: dict,
        audio_tracks: list[dict],
        validate_tracks: bool = False,
        playback_selector: PlaybackSelector | None = None,
    ) -> dict[str, Path]:
        item_id = item.id
        cookie = effective_bilibili_cookie()

        selected_pages = self._selected_pages_for_item(item)
        video_page = item.video_page if item.video_page in selected_pages else selected_pages[0]

        with self.lock:
            audio_hires = self.audio_hires

        video_urls = self._dash_stream_urls(
            dash_streams, "video", playback_selector=playback_selector
        )
        if not video_urls:
            raise DownloadCommandError("未找到视频流下载地址")
        video_target_dir = item_dir / f"video-p{video_page}"
        video_target_dir.mkdir(parents=True, exist_ok=True)

        ffprobe_path = self._ffprobe_path_for_ffmpeg(ffmpeg_path) if validate_tracks else None
        if validate_tracks and not ffprobe_path:
            raise DownloadCommandError("缓存校验失败: DownKyi 下载需要可用的 ffprobe")

        track_args: list[tuple[dict, list[str], str, Path, str, str, dict[str, object]]] = []
        track_args.append((
            video_track,
            video_urls,
            f"video-p{video_page}.mp4",
            video_target_dir,
            f"下载视频轨 P{video_page}",
            "video",
            (dash_streams.get("video") or [{}])[0],
        ))

        for track in audio_tracks:
            page = int(track["page"])
            label = str(track["label"])
            audio_target_dir = item_dir / f"audio-p{page}"
            audio_target_dir.mkdir(parents=True, exist_ok=True)

            cid = self._cid_for_page(item, page)
            self._append_log_line(log_path, f"[{self._log_timestamp()}] resolve audio DASH: page={page}, cid={cid}")
            self._append_log_line(log_path, f"[{self._log_timestamp()}] download audio track: page={page}, label={label}")

            try:
                page_dash_streams = self._resolve_dash_streams(
                    item, cid=cid, playback_selector=playback_selector
                )
            except Exception as exc:
                raise RuntimeError(f"P{page} 音频解析失败: {exc}") from exc

            best_audio = page_dash_streams.get("audio") or []
            flac_audio = page_dash_streams.get("flac")
            dolby_audio = page_dash_streams.get("dolby")
            preferred_audio = self._select_preferred_dash_audio(
                best_audio,
                flac_audio,
                dolby_audio,
                audio_hires=audio_hires,
                playback_selector=playback_selector,
            )

            if preferred_audio:
                audio_urls = self._preferred_audio_urls(
                    preferred_audio, playback_selector=playback_selector
                )
            else:
                audio_urls = self._dash_stream_urls(
                    page_dash_streams, "audio", playback_selector=playback_selector
                )
            if not audio_urls:
                raise DownloadCommandError(f"未找到音频轨 P{page} 的下载地址")

            out_ext = ".flac" if (flac_audio and preferred_audio is flac_audio and audio_hires) else ".m4a"
            track_args.append((
                track,
                audio_urls,
                f"audio-p{page}{out_ext}",
                audio_target_dir,
                f"下载音轨 P{page}",
                "audio",
                preferred_audio or {},
            ))

        result_paths: dict[str, Path] = {}
        max_workers = max(1, min(len(track_args), MAX_PARALLEL_TRACK_DOWNLOADS))
        executor = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="bilikara-downkyi-track")

        def _download_track(args: tuple) -> tuple[str, Path]:
            track, urls, out_name, target_dir, stage_label, stream_kind, stream_metadata = args
            track["stream_metadata"] = dict(stream_metadata)
            track_key = str(track["key"])
            page = int(track["page"])
            cid = self._cid_for_page(item, page)
            validation_label = f"{'视频轨' if stream_kind == 'video' else '音轨'} P{page}"
            max_attempts = DOWNKYI_TRACK_MAX_ATTEMPTS if validate_tracks else 1
            last_error = "未知错误"

            for attempt in range(1, max_attempts + 1):
                if validate_tracks:
                    self._raise_if_retry_requested(item_id)
                    self._raise_if_priority_shift(item_id)
                if attempt > 1:
                    self._reset_download_track_progress(item_id, track_key)
                self._set_download_track_phase(
                    item_id,
                    track_key,
                    phase="downloading",
                    attempt=attempt,
                    max_attempts=max_attempts,
                )
                self._append_log_line(
                    log_path,
                    f"[{self._log_timestamp()}] media_diagnostic: "
                    f"{json.dumps({'event': 'downkyi_track_attempt', 'item_id': item_id, 'track_key': track_key, 'stream_kind': stream_kind, 'page': page, 'attempt': attempt, 'max_attempts': max_attempts, 'status': 'start'}, ensure_ascii=False, sort_keys=True)}",
                )
                media_path: Path | None = None
                try:
                    media_path = self._download_stream_with_aria2c(
                        item_id, binary_path, ffmpeg_path, target_dir, log_path,
                        urls=urls,
                        out_name=out_name,
                        cookie=cookie,
                        stage_label=stage_label,
                        track_key=track_key,
                        stream_kind=stream_kind,
                        page=page,
                        cid=cid,
                        stream_metadata=stream_metadata,
                        mark_done=not validate_tracks,
                    )
                    if validate_tracks:
                        self._set_download_track_phase(
                            item_id,
                            track_key,
                            phase="validating",
                            attempt=attempt,
                            max_attempts=max_attempts,
                        )
                        assert ffprobe_path is not None
                        source_audio_duration = None
                        if stream_kind == "audio":
                            source_audio_duration = self._probe_original_audio_duration(
                                ffprobe_path,
                                ffmpeg_path,
                                media_path,
                                label=validation_label,
                                log_path=log_path,
                            )
                        self._normalize_downkyi_media_file(
                            ffmpeg_path,
                            media_path,
                            label=validation_label,
                            stream_kind=stream_kind,
                            log_path=log_path,
                        )
                        validation_entry: dict[str, object] = {
                            "label": validation_label,
                            "path": media_path,
                            "required_streams": {stream_kind},
                            "stream_kind": stream_kind,
                            "page": page,
                            "cid": cid,
                            "download_source": DOWNLOAD_SOURCE_DOWNKYI,
                            "stream_metadata": dict(stream_metadata),
                        }
                        if stream_kind == "video":
                            validation_entry["expected_duration"] = self._duration_for_page(item, page)
                        if source_audio_duration is not None:
                            validation_entry["source_audio_duration"] = source_audio_duration
                        metadata = self._validate_media_file(
                            ffprobe_path,
                            ffmpeg_path,
                            media_path,
                            label=validation_label,
                            required_streams={stream_kind},
                            log_path=log_path,
                            diagnostic_context={**validation_entry, "item_id": item_id},
                        )
                        metadata.update({
                            "label": validation_label,
                            "page": page,
                            "stream_kind": stream_kind,
                            "expected_duration": self._optional_probe_float(
                                validation_entry.get("expected_duration")
                            ),
                            "source_audio_duration": self._optional_probe_float(
                                validation_entry.get("source_audio_duration")
                            ),
                        })
                        track["validation_metadata"] = metadata
                        final_size = media_path.stat().st_size
                        self._update_download_track_progress(
                            item_id,
                            track_key=track_key,
                            target_dir=media_path.parent,
                            current_bytes=final_size,
                            target_bytes=final_size,
                            done=True,
                            measure_path=False,
                        )
                        self._set_download_track_phase(
                            item_id,
                            track_key,
                            phase="ready",
                            attempt=attempt,
                            max_attempts=max_attempts,
                        )
                    self._append_log_line(
                        log_path,
                        f"[{self._log_timestamp()}] media_diagnostic: "
                        f"{json.dumps({'event': 'downkyi_track_attempt', 'item_id': item_id, 'track_key': track_key, 'stream_kind': stream_kind, 'page': page, 'attempt': attempt, 'max_attempts': max_attempts, 'status': 'ok'}, ensure_ascii=False, sort_keys=True)}",
                    )
                    return track_key, media_path
                except CacheCancelledError:
                    if media_path is not None:
                        self._safe_rmtree(media_path.parent)
                    self._set_download_track_phase(
                        item_id,
                        track_key,
                        phase="retrying",
                        attempt=attempt,
                        max_attempts=max_attempts,
                    )
                    raise
                except Exception as exc:  # noqa: BLE001
                    last_error = self._compact_probe_error(str(exc)) or type(exc).__name__
                    if media_path is not None:
                        self._safe_rmtree(media_path.parent)
                    self._append_log_line(
                        log_path,
                        f"[{self._log_timestamp()}] media_diagnostic: "
                        f"{json.dumps({'event': 'downkyi_track_attempt', 'item_id': item_id, 'track_key': track_key, 'stream_kind': stream_kind, 'page': page, 'attempt': attempt, 'max_attempts': max_attempts, 'status': 'failed', 'error': last_error}, ensure_ascii=False, sort_keys=True)}",
                    )
                    if attempt >= max_attempts:
                        raise DownloadCommandError(
                            f"{validation_label} 已尝试 {max_attempts} 次仍失败: {last_error}"
                        ) from exc
                    if self.stop_event.wait(DOWNKYI_TRACK_RETRY_WAIT_SECONDS):
                        raise CacheCancelledError("缓存已停止") from exc

            raise DownloadCommandError(
                f"{validation_label} 已尝试 {max_attempts} 次仍失败: {last_error}"
            )

        future_to_track = {
            executor.submit(_download_track, args): args[0]
            for args in track_args
        }
        try:
            done, pending = wait(future_to_track, return_when=FIRST_EXCEPTION)
            exceptions: list[Exception] = []
            for future in done:
                if future.cancelled():
                    continue
                try:
                    key, path = future.result()
                    result_paths[key] = path
                except Exception as exc:  # noqa: BLE001
                    exceptions.append(exc)

            if exceptions:
                for future in pending:
                    future.cancel()
                self._terminate_item_processes(item_id)
                still_running = [future for future in pending if not future.cancelled()]
                if still_running:
                    wait(still_running)
                    for future in still_running:
                        if future.cancelled():
                            continue
                        try:
                            future.result()
                        except Exception as exc:  # noqa: BLE001
                            exceptions.append(exc)
                raise self._preferred_download_exception(exceptions)

            for future, track_ref in future_to_track.items():
                if future not in done:
                    try:
                        key, path = future.result()
                        result_paths[key] = path
                    except Exception as exc:  # noqa: BLE001
                        exceptions.append(exc)
        finally:
            executor.shutdown(wait=True)

        return result_paths

    @staticmethod
    def _py_dash_stream_urls(dash_streams: dict, stream_kind: str) -> list[str]:
        if stream_kind == "video":
            streams = dash_streams.get("video") or []
            urls = []
            for stream in streams:
                url = str(stream.get("url") or "").strip()
                if url:
                    urls.append(url)
                for backup in stream.get("backup_urls") or []:
                    backup_url = str(backup).strip()
                    if backup_url:
                        urls.append(backup_url)
            return urls
        if stream_kind == "audio":
            streams = dash_streams.get("audio") or []
            urls = []
            for stream in streams:
                url = str(stream.get("url") or "").strip()
                if url:
                    urls.append(url)
                for backup in stream.get("backup_urls") or []:
                    backup_url = str(backup).strip()
                    if backup_url:
                        urls.append(backup_url)
            return urls
        return []

    @staticmethod
    def _dash_stream_urls(
        dash_streams: dict,
        stream_kind: str,
        *,
        playback_selector: PlaybackSelector | None = None,
    ) -> list[str]:
        if stream_kind not in {"video", "audio"}:
            if playback_selector is not None:
                if playback_selector.mode == "rust":
                    raise PlaybackCapabilityError(
                        "plan_media_download_candidates",
                        "invalid stream_kind",
                    )
                return CacheManager._py_dash_stream_urls(
                    dash_streams, stream_kind
                )
            return rust_backend.python_fallback(
                "plan_media_download_candidates",
                lambda: CacheManager._py_dash_stream_urls(dash_streams, stream_kind),
            )
        streams = dash_streams.get(stream_kind) or []
        request = {
            "schema_version": 1,
            "mode": "dash_streams",
            "stream_kind": stream_kind,
            "streams": [
                {
                    "original_index": index,
                    "primary_url": str(stream.get("url") or ""),
                    "backup_urls": [
                        str(backup) for backup in (stream.get("backup_urls") or [])
                    ],
                }
                for index, stream in enumerate(streams)
            ],
        }
        if playback_selector is not None:
            return playback_selector.decide(
                "plan_media_download_candidates",
                python=lambda: CacheManager._py_dash_stream_urls(
                    dash_streams, stream_kind
                ),
                rust=lambda: rust_backend.try_plan_media_download_candidates(
                    request, allow_python_reference=False
                ),
                decode_rust=lambda response: [
                    candidate["url"] for candidate in response["candidates"]
                ],
            )
        completed, response = rust_backend.try_plan_media_download_candidates(request)
        if completed and response is not None:
            return [candidate["url"] for candidate in response["candidates"]]
        return rust_backend.python_fallback(
            "plan_media_download_candidates",
            lambda: CacheManager._py_dash_stream_urls(dash_streams, stream_kind),
        )

    @staticmethod
    def _py_preferred_audio_urls(preferred_audio: dict) -> list[str]:
        urls = [preferred_audio["url"]]
        urls.extend(preferred_audio.get("backup_urls") or [])
        return urls

    @staticmethod
    def _preferred_audio_urls(
        preferred_audio: dict,
        *,
        playback_selector: PlaybackSelector | None = None,
    ) -> list[str]:
        primary_url = preferred_audio["url"]
        backup_urls = list(preferred_audio.get("backup_urls") or [])
        if not isinstance(primary_url, str) or not all(
            isinstance(url, str) for url in backup_urls
        ):
            if playback_selector is not None:
                if playback_selector.mode == "rust":
                    raise PlaybackCapabilityError(
                        "plan_media_download_candidates",
                        "preferred audio URLs must be strings",
                    )
                return CacheManager._py_preferred_audio_urls(preferred_audio)
            return rust_backend.python_fallback(
                "plan_media_download_candidates",
                lambda: CacheManager._py_preferred_audio_urls(preferred_audio),
            )
        request = {
            "schema_version": 1,
            "mode": "preferred_audio",
            "stream_kind": "audio",
            "streams": [
                {
                    "original_index": 0,
                    "primary_url": primary_url,
                    "backup_urls": backup_urls,
                }
            ],
        }
        if playback_selector is not None:
            return playback_selector.decide(
                "plan_media_download_candidates",
                python=lambda: CacheManager._py_preferred_audio_urls(
                    preferred_audio
                ),
                rust=lambda: rust_backend.try_plan_media_download_candidates(
                    request, allow_python_reference=False
                ),
                decode_rust=lambda response: [
                    candidate["url"] for candidate in response["candidates"]
                ],
            )
        completed, response = rust_backend.try_plan_media_download_candidates(request)
        if completed and response is not None:
            return [candidate["url"] for candidate in response["candidates"]]
        return rust_backend.python_fallback(
            "plan_media_download_candidates",
            lambda: CacheManager._py_preferred_audio_urls(preferred_audio),
        )

    @staticmethod
    def _safe_url_summary(url: object) -> str:
        raw = str(url or "").strip()
        if not raw:
            return ""
        try:
            parsed = urllib.parse.urlparse(raw)
        except ValueError:
            return "<invalid-url>"
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            return "<non-http-url>"
        basename = Path(urllib.parse.unquote(parsed.path)).name or "/"
        port = f":{parsed.port}" if parsed.port else ""
        return f"{parsed.scheme}://{parsed.hostname}{port}/{basename}"

    @classmethod
    def _redacted_command_for_log(cls, command: list[str]) -> list[str]:
        redacted: list[str] = []
        previous = ""
        for argument in command:
            value = str(argument)
            if previous == "--header" and value.lower().startswith("cookie:"):
                redacted.append("Cookie: <redacted>")
            elif value.startswith(("http://", "https://")):
                redacted.append(cls._safe_url_summary(value))
            else:
                redacted.append(value)
            previous = value
        return redacted

    @staticmethod
    def _aria2_output_diagnostics(target_dir: Path, expected_path: Path) -> dict[str, object]:
        entries: list[dict[str, object]] = []
        try:
            paths = sorted(target_dir.iterdir(), key=lambda path: path.name)
        except OSError:
            paths = []
        for path in paths:
            try:
                if not path.is_file():
                    continue
                stat_result = path.stat()
            except OSError:
                continue
            suffix = path.suffix.lower()
            media_like = suffix in MEDIA_EXTENSIONS or suffix in AUDIO_EXTENSIONS
            control_file = path.name.endswith(".aria2")
            numbered_alternative = bool(re.search(r"\.\d+\.[^.]+$", path.name))
            if not (media_like or control_file or numbered_alternative):
                continue
            entries.append({
                "name": path.name,
                "size": stat_result.st_size,
                "mtime_ns": stat_result.st_mtime_ns,
                "media_like": media_like,
                "aria2_control": control_file,
                "numbered_alternative": numbered_alternative,
            })
        return {
            "expected_output": str(expected_path),
            "expected_exists": expected_path.exists(),
            "files": entries,
            "aria2_files": [entry["name"] for entry in entries if entry["aria2_control"]],
            "numbered_alternatives": [entry["name"] for entry in entries if entry["numbered_alternative"]],
        }

    def _download_stream_with_aria2c(
        self,
        item_id: str,
        binary_path: Path,
        ffmpeg_path: Path,
        target_dir: Path,
        log_path: Path,
        *,
        urls: list[str],
        out_name: str,
        cookie: str,
        stage_label: str,
        track_key: str,
        stream_kind: str,
        page: int = 0,
        cid: int = 0,
        stream_metadata: dict[str, object] | None = None,
        mark_done: bool = True,
    ) -> Path:
        if not urls:
            raise DownloadCommandError(f"{stage_label}: 没有可用的下载地址")

        download_urls = [str(url).strip() for url in urls if str(url).strip()]
        if not download_urls:
            raise DownloadCommandError(f"{stage_label}: 没有可用的下载地址")

        target_dir.mkdir(parents=True, exist_ok=True)
        attempt_dir = target_dir / f".attempt-{uuid.uuid4().hex}"
        attempt_dir.mkdir(parents=False, exist_ok=False)
        expected_path = attempt_dir / out_name
        final_path = target_dir / out_name
        metadata = stream_metadata or {}
        selection_summary = {
            "event": "downkyi_track_selected",
            "item_id": item_id,
            "page": page,
            "cid": cid,
            "stream_kind": stream_kind,
            "quality_id": int(metadata.get("quality_id") or 0),
            "codec_name": str(metadata.get("codec_name") or ""),
            "codec_string": str(metadata.get("codecs") or ""),
            "mime_type": str(metadata.get("mime_type") or ""),
            "bandwidth": int(metadata.get("bandwidth") or 0),
            "primary_url": self._safe_url_summary(download_urls[0]),
            "backup_url_count": max(0, len(download_urls) - 1),
            "expected_output": str(expected_path),
            "final_output": str(final_path),
        }
        self._append_log_line(
            log_path,
            f"[{self._log_timestamp()}] media_diagnostic: "
            f"{json.dumps(selection_summary, ensure_ascii=False, sort_keys=True)}",
        )

        connections = str(ARIA2_CONNECTIONS_PER_TRACK)
        command = [
            self._tool_arg_path(binary_path),
            *download_urls,
            "--dir", self._tool_arg_path(attempt_dir),
            "--out", out_name,
            "--continue=false",
            "--auto-file-renaming=false",
            "--allow-overwrite=false",
            "--max-tries=1",
            "--retry-wait=3",
            f"--split={connections}",
            "--min-split-size=5M",
            f"--max-connection-per-server={connections}",
            "--file-allocation=none",
            "--human-readable=false",
            "--summary-interval=1",
            "--console-log-level=notice",
        ]

        if cookie:
            command.extend(["--header", f"Cookie: {cookie}"])
        command.extend(["--header", "Origin: https://www.bilibili.com"])
        command.extend(["--header", "Referer: https://www.bilibili.com"])
        user_agent = BILIBILI_HEADERS.get("User-Agent", "")
        if user_agent:
            command.extend(["--header", f"User-Agent: {user_agent}"])

        exit_code: int | None = None
        try:
            self._run_item_command(
                item_id,
                command,
                ffmpeg_path,
                log_path,
                stage_label=stage_label,
                stream_kind=stream_kind,
                target_dir=attempt_dir,
                track_key=track_key,
                tool_dir=binary_path.parent,
                silent=True,
                is_preallocated=False,
                progress_from_output=True,
                mark_done_on_exit=False,
            )
            exit_code = 0
        except Exception as exc:
            exit_code = getattr(exc, "return_code", None)
            raise
        finally:
            output_summary = self._aria2_output_diagnostics(attempt_dir, expected_path)
            output_summary.update(
                event="aria2_output",
                item_id=item_id,
                exit_code=exit_code,
                stream_kind=stream_kind,
                page=page,
                cid=cid,
                final_output=str(final_path),
            )
            self._append_log_line(
                log_path,
                f"[{self._log_timestamp()}] media_diagnostic: "
                f"{json.dumps(output_summary, ensure_ascii=False, sort_keys=True)}",
            )
            if exit_code != 0:
                self._safe_rmtree(attempt_dir)

        self._raise_if_retry_requested(item_id)
        output_summary = self._aria2_output_diagnostics(attempt_dir, expected_path)
        try:
            self._require_exact_aria2_output(output_summary, expected_path, stage_label)
        except Exception:
            self._safe_rmtree(attempt_dir)
            raise
        final_size = expected_path.stat().st_size
        self._update_download_track_progress(
            item_id,
            track_key=track_key,
            target_dir=attempt_dir,
            current_bytes=final_size,
            target_bytes=final_size,
            done=mark_done,
            measure_path=False,
        )
        return expected_path

    def _download_stream_with_rust(
        self,
        item_id: str,
        target_dir: Path,
        log_path: Path,
        *,
        urls: list[str],
        out_name: str,
        cookie: str,
        stage_label: str,
        track_key: str,
        stream_kind: str,
        page: int = 0,
        cid: int = 0,
        stream_metadata: dict[str, object] | None = None,
        mark_done: bool = True,
    ) -> Path:
        download_urls = [str(url).strip() for url in urls if str(url).strip()]
        if not download_urls:
            raise DownloadCommandError(f"{stage_label}: no download URL is available")

        attempt_dir = target_dir / f".attempt-{uuid.uuid4().hex}"
        try:
            target_dir.mkdir(parents=True, exist_ok=True)
            attempt_dir.mkdir(parents=False, exist_ok=False)
        except OSError as exc:
            raise DownloadCommandError(
                f"{stage_label}: unable to prepare Rust download output"
            ) from exc
        expected_path = attempt_dir / out_name
        metadata = stream_metadata or {}
        self._append_log_line(
            log_path,
            f"[{self._log_timestamp()}] media_diagnostic: "
            f"{json.dumps({'event': 'rust_downloader_selected', 'item_id': item_id, 'page': page, 'cid': cid, 'stream_kind': stream_kind, 'quality_id': int(metadata.get('quality_id') or 0), 'codec_name': str(metadata.get('codec_name') or ''), 'bandwidth': int(metadata.get('bandwidth') or 0), 'backup_url_count': max(0, len(download_urls) - 1), 'expected_output': str(expected_path)}, ensure_ascii=False, sort_keys=True)}",
        )

        headers = [
            ("Origin", "https://www.bilibili.com"),
            ("Referer", "https://www.bilibili.com"),
        ]
        if cookie:
            headers.append(("Cookie", cookie))
        user_agent = BILIBILI_HEADERS.get("User-Agent", "")
        if user_agent:
            headers.append(("User-Agent", user_agent))

        cancellation: list[CacheCancelledError] = []

        def should_cancel() -> bool:
            try:
                if self.stop_event.is_set():
                    raise CacheCancelledError("cache stopped")
                self._raise_if_retry_requested(item_id)
                self._raise_if_priority_shift(item_id)
                return False
            except CacheCancelledError as exc:
                cancellation.append(exc)
                return True

        def on_progress(current_bytes: int, target_bytes: int) -> None:
            self._update_download_track_progress(
                item_id,
                track_key=track_key,
                target_dir=attempt_dir,
                current_bytes=current_bytes,
                target_bytes=target_bytes,
                done=False,
                measure_path=False,
            )

        try:
            result = rust_runtime.download_to_path(
                urls=download_urls,
                destination=expected_path,
                headers=headers,
                on_progress=on_progress,
                should_cancel=should_cancel,
            )
        except rust_runtime.RustDownloadCancelledError as exc:
            self._safe_rmtree(attempt_dir)
            if cancellation:
                raise cancellation[-1] from exc
            raise CacheCancelledError("Rust HTTP download cancelled") from exc
        except rust_runtime.RustDownloadError as exc:
            self._safe_rmtree(attempt_dir)
            raise DownloadCommandError(
                f"{stage_label}: Rust HTTP downloader failed ({exc.kind})"
            ) from exc

        final_size = int(result.get("bytes_written") or 0)
        if final_size <= 0 or not expected_path.is_file():
            self._safe_rmtree(attempt_dir)
            raise DownloadCommandError(f"{stage_label}: Rust HTTP downloader produced no output")
        self._update_download_track_progress(
            item_id,
            track_key=track_key,
            target_dir=attempt_dir,
            current_bytes=final_size,
            target_bytes=final_size,
            done=mark_done,
            measure_path=False,
        )
        self._append_log_line(
            log_path,
            f"[{self._log_timestamp()}] media_diagnostic: "
            f"{json.dumps({'event': 'rust_downloader_output', 'item_id': item_id, 'stream_kind': stream_kind, 'page': page, 'cid': cid, 'bytes_written': final_size, 'candidate_index': int(result.get('candidate_index') or 0), 'segments_used': int(result.get('segments_used') or 1), 'workers_used': int(result.get('workers_used') or 1), 'host_rewritten': bool(result.get('host_rewritten')), 'transport': str(result.get('transport') or ''), 'final_host': str(result.get('final_host') or ''), 'elapsed_ms': int(result.get('elapsed_ms') or 0), 'average_bytes_per_second': int(result.get('average_bytes_per_second') or 0), 'status': 'ok'}, ensure_ascii=False, sort_keys=True)}",
        )
        return expected_path

    @staticmethod
    def _require_exact_aria2_output(
        output_summary: dict[str, object],
        expected_path: Path,
        stage_label: str,
    ) -> None:
        aria2_files = list(output_summary.get("aria2_files") or [])
        if aria2_files:
            raise DownloadCommandError(
                f"{stage_label} 完成后仍有 aria2 控制文件: {', '.join(map(str, aria2_files))}"
            )
        numbered = list(output_summary.get("numbered_alternatives") or [])
        if numbered:
            raise DownloadCommandError(
                f"{stage_label} 生成了意外的编号输出: {', '.join(map(str, numbered))}"
            )
        media_files = [
            entry
            for entry in list(output_summary.get("files") or [])
            if isinstance(entry, dict) and bool(entry.get("media_like"))
        ]
        if len(media_files) != 1 or str(media_files[0].get("name") or "") != expected_path.name:
            names = ", ".join(str(entry.get("name") or "") for entry in media_files) or "无"
            raise DownloadCommandError(f"{stage_label} 输出不唯一或路径不符: {names}")
        if not bool(output_summary.get("expected_exists")):
            raise DownloadCommandError(f"{stage_label} 完成后未找到精确输出文件 {expected_path.name}")
        if int(media_files[0].get("size") or 0) <= 0:
            raise DownloadCommandError(f"{stage_label} 输出文件为空")

    def _downkyi_download_command(
        self,
        binary_path: Path,
        ffmpeg_path: Path,
        page_url: str,
        *,
        page: int,
        stream_kind: str,
        target_dir: Path,
    ) -> list[str]:
        raise DownloadCommandError("Downkyi 模式不使用 URL 下载命令，请使用 _download_dash_streams_with_aria2c")

    def _bbdown_stream_preference_args(
        self,
        stream_kind: str,
        *,
        playback_selector: PlaybackSelector | None = None,
    ) -> list[str]:
        with self.lock:
            video_quality = self.video_quality
            audio_hires = self.audio_hires
            force_avc = self._should_force_avc_locked()
            avc_quality_cap = self.avc_quality_cap if force_avc else ""
        if stream_kind == "video":
            args = [
                "-q",
                self._video_quality_priority(
                    video_quality,
                    avc_quality_cap,
                    playback_selector=playback_selector,
                ),
            ]
            if force_avc:
                args.extend(["-e", "avc"])
            return args
        if stream_kind == "audio" and not audio_hires:
            # BBDown 1.6.x does not expose a direct "highest non-Hi-Res"
            # selector. The closest safe fallback is to prefer the smaller
            # audio stream when Hi-Res is disabled.
            return ["--audio-ascending"]
        return []

    def _should_force_avc_locked(self) -> bool:
        return self.hevc_supported is False

    def _request_desired_recaching(self, message: str) -> None:
        with self.lock:
            item_ids = set(self.desired_ids)
            active_item_id = self.active_item_id if self.active_item_id in item_ids else None
            active_processes = self._active_processes_locked(active_item_id) if active_item_id else []
            pending_ids = set(self.pending_ids)
            for item_id in item_ids:
                if item_id == active_item_id or item_id in pending_ids:
                    self.retry_requested_ids.add(item_id)

        for item_id in item_ids:
            self.store.update_item(
                item_id,
                cache_status="pending",
                cache_progress=0.0,
                cache_message=message,
                video_relative_path="",
                video_media_url="",
                audio_variants=[],
                selected_audio_variant_id="",
                persist_backup=False,
            )
            self._record_item_activity(item_id)
            if item_id == active_item_id or item_id in pending_ids:
                continue
            self._remove_cache_dir(item_id)
            self.enqueue(item_id)

        self._terminate_processes(active_processes)

    @staticmethod
    def _py_video_quality_priority(video_quality: object, quality_cap: object = "") -> str:
        normalized_quality = CacheManager._py_normalize_video_quality(video_quality)
        start_index = VIDEO_QUALITY_CHOICES.index(normalized_quality)
        cap_quality = CacheManager._py_optional_video_quality(quality_cap)
        if cap_quality:
            start_index = max(start_index, VIDEO_QUALITY_CHOICES.index(cap_quality))
        return ",".join(VIDEO_QUALITY_CHOICES[start_index:])

    @staticmethod
    def _video_quality_priority(
        video_quality: object,
        quality_cap: object = "",
        *,
        playback_selector: PlaybackSelector | None = None,
    ) -> str:
        response = CacheManager._native_quality_policy(
            video_quality,
            quality_cap,
            playback_selector=playback_selector,
        )
        if response is not None:
            return ",".join(response["bbdown_quality_order"])
        return CacheManager._py_video_quality_priority(video_quality, quality_cap)

    def _run_item_command(
        self,
        item_id: str,
        command: list[str],
        ffmpeg_path: Path,
        log_path: Path,
        *,
        stage_label: str,
        stream_kind: str,
        target_dir: Path,
        track_key: str,
        tool_dir: Path | None = None,
        silent: bool = True,
        is_preallocated: bool = False,
        progress_from_output: bool = False,
        mark_done_on_exit: bool = True,
    ) -> None:
        safe_command = self._redacted_command_for_log(command)
        self._append_log_line(log_path, f"[{self._log_timestamp()}] command: {json.dumps(safe_command, ensure_ascii=False)}")
        if not silent:
            _debug_print(f"[bilikara-cache] [{stage_label}] command: {json.dumps(safe_command, ensure_ascii=False)}")
        target_bytes_state = {"value": 0}
        current_bytes_state = {"value": 0}
        progress_percent_state: dict[str, float | None] = {"value": None}
        monitor_stop = threading.Event()

        process = subprocess.Popen(  # nosemgrep: python.lang.security.audit.dangerous-subprocess-use-audit
            command,
            shell=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding=SUBPROCESS_OUTPUT_ENCODING,
            errors="replace",
            bufsize=1,
            cwd=self._tool_arg_path(tool_dir or BB_DOWN_DIR),
            env=self._tool_process_env(ffmpeg_path, extra_tool_dirs=[tool_dir] if tool_dir else None),
            **self._hidden_process_kwargs(),
        )
        last_message = stage_label
        self._register_active_process(item_id, process)
        self._update_download_track_progress(
            item_id,
            track_key=track_key,
            target_dir=target_dir,
            target_bytes=0,
            is_preallocated=is_preallocated,
            measure_path=not progress_from_output,
        )
        monitor = threading.Thread(
            target=self._monitor_download_track_progress,
            kwargs={
                "item_id": item_id,
                "process": process,
                "stop_event": monitor_stop,
                "track_key": track_key,
                "target_dir": target_dir,
                "target_bytes_state": target_bytes_state,
                "current_bytes_state": current_bytes_state if progress_from_output else None,
                "progress_percent_state": progress_percent_state if progress_from_output else None,
                "is_preallocated": is_preallocated,
                "measure_path": not progress_from_output,
            },
            daemon=True,
        )
        monitor.start()
        try:
            assert process.stdout is not None
            for raw_line in self._iter_output_messages(process.stdout):
                line = self._normalize_output_line(raw_line)
                if not line:
                    continue
                last_message = line
                if not silent:
                    _debug_print(f"[bilikara-cache] [{stage_label}] {line}")
                self._append_log_line(log_path, f"[{self._log_timestamp()}] {line}")
                self._record_item_activity(item_id)
                aria2_progress = self._aria2_progress_bytes(line) if progress_from_output else None
                if aria2_progress is not None:
                    downloaded_bytes, target_bytes, progress = aria2_progress
                    current_bytes_state["value"] = max(
                        current_bytes_state["value"],
                        downloaded_bytes,
                    )
                    progress_percent_state["value"] = progress
                else:
                    downloaded_bytes = None
                    progress = self._extract_progress(line)
                    target_bytes = self._selected_stream_size_hint_bytes(line, stream_kind)
                if target_bytes:
                    target_bytes_state["value"] = max(target_bytes_state["value"], target_bytes)
                self._update_download_track_progress(
                    item_id,
                    track_key=track_key,
                    target_dir=target_dir,
                    current_bytes=downloaded_bytes,
                    target_bytes=target_bytes_state["value"],
                    progress_percent=progress,
                    is_preallocated=is_preallocated,
                    measure_path=not progress_from_output,
                )
                if self.stop_event.is_set():
                    self._terminate_process(process)
                    raise CacheCancelledError("缓存已停止")
                if not self._should_cache(item_id):
                    self._terminate_process(process)
                    raise CacheCancelledError(self._outside_window_message())
            return_code = process.wait()
        finally:
            monitor_stop.set()
            monitor.join(timeout=1.0)
            self._unregister_active_process(process)

        interrupt_message = self._peek_cache_interrupt_message(item_id)
        if interrupt_message:
            raise CacheCancelledError(interrupt_message)

        if self._has_retry_request(item_id):
            raise CacheCancelledError(RETRY_REQUESTED_MESSAGE)

        if self.stop_event.is_set():
            raise CacheCancelledError("缓存已停止")

        if not self._should_cache(item_id):
            raise CacheCancelledError(self._outside_window_message())

        self._append_log_line(
            log_path,
            f"[{self._log_timestamp()}] process_exit: "
            f"{json.dumps({'stage': stage_label, 'exit_code': return_code}, ensure_ascii=False, sort_keys=True)}",
        )
        if return_code != 0:
            if not silent:
                _debug_print(f"[bilikara-cache] [{stage_label}] FAILED exit_code={return_code} last_message={last_message}")
            error = DownloadCommandError(f"{stage_label}: {last_message}")
            error.return_code = return_code
            raise error

        if mark_done_on_exit:
            self._update_download_track_progress(
                item_id,
                track_key=track_key,
                target_dir=target_dir,
                target_bytes=target_bytes_state["value"],
                done=True,
                is_preallocated=is_preallocated,
            )
        self._record_item_activity(item_id)
        self._raise_if_retry_requested(item_id)

    # LEGACY: old mux step used by the single-output cache path. Split playback
    # keeps video and audio files separate, so this remains only as a reference.
    # def _mux_downloaded_streams(
    #     self,
    #     item,
    #     ffmpeg_path: Path,
    #     item_dir: Path,
    #     log_path: Path,
    #     *,
    #     video_file: Path,
    #     audio_files: list[tuple[int, Path, str]],
    # ) -> dict[str, object]:
    #     item_id = item.id
    #     output_dir = item_dir / "output"
    #     output_dir.mkdir(parents=True, exist_ok=True)
    #     output_file = output_dir / "video.mp4"
    #     output_file.unlink(missing_ok=True)

    #     command = [str(ffmpeg_path), "-y", "-i", str(video_file)]
    #     for _page, audio_file, _label in audio_files:
    #         command.extend(["-i", str(audio_file)])
    #     command.extend(["-map", "0:v:0"])
    #     for index in range(len(audio_files)):
    #         command.extend(["-map", f"{index + 1}:a:0"])
    #     command.extend(["-c", "copy", "-movflags", "+faststart"])
    #     for index, (_page, _audio_file, label) in enumerate(audio_files):
    #         command.extend([f"-metadata:s:a:{index}", f"title={label}"])
    #         command.extend([f"-disposition:a:{index}", "default" if index == 0 else "0"])
    #     command.append(str(output_file))

    #     self.store.update_item(
    #         item_id,
    #         cache_progress=95.0,
    #         cache_message=f"正在混流 {len(audio_files)} 条音轨",
    #         persist_backup=False,
    #     )
    #     self._record_item_activity(item_id)
    #     self._append_log_line(log_path, f"[{self._log_timestamp()}] command: {json.dumps(command, ensure_ascii=False)}")

    #     process = subprocess.Popen(
    #         command,
    #         stdout=subprocess.PIPE,
    #         stderr=subprocess.STDOUT,
    #         text=True,
    #         encoding=SUBPROCESS_OUTPUT_ENCODING,
    #         errors="replace",
    #         bufsize=1,
    #         cwd=str(BB_DOWN_DIR),
    #         env=self._tool_process_env(ffmpeg_path),
    #         **self._hidden_process_kwargs(),
    #     )
    #     last_message = "ffmpeg mux"
    #     with self.lock:
    #         self.active_process = process
    #         self.active_item_id = item_id
    #     try:
    #         assert process.stdout is not None
    #         for raw_line in self._iter_output_messages(process.stdout):
    #             line = self._normalize_output_line(raw_line)
    #             if not line:
    #                 continue
    #             last_message = line
    #             self._append_log_line(log_path, f"[{self._log_timestamp()}] {line}")
    #             self._record_item_activity(item_id)
    #             self.store.update_item(
    #                 item_id,
    #                 cache_message=f"正在混流 {len(audio_files)} 条音轨",
    #                 persist_backup=False,
    #             )
    #             if self.stop_event.is_set():
    #                 self._terminate_process(process)
    #                 raise CacheCancelledError("缓存已停止")
    #             if not self._should_cache(item_id):
    #                 self._terminate_process(process)
    #                 raise CacheCancelledError(self._outside_window_message())
    #         return_code = process.wait()
    #     finally:
    #         with self.lock:
    #             if self.active_process is process:
    #                 self.active_process = None
    #                 self.active_item_id = None

    #     if self._take_retry_request(item_id):
    #         raise CacheCancelledError(RETRY_REQUESTED_MESSAGE)

    #     if return_code != 0:
    #         raise DownloadCommandError(last_message)
    #     if not output_file.exists():
    #         raise DownloadCommandError("FFmpeg 混流完成，但未生成输出文件")

    #     self.store.update_item(
    #         item_id,
    #         cache_progress=99.0,
    #         cache_message="混流完成，正在收尾",
    #         persist_backup=False,
    #     )
    #     self._record_item_activity(item_id)
    #     variant_files = self._build_audio_variant_outputs(
    #         item,
    #         ffmpeg_path,
    #         item_dir,
    #         log_path,
    #         video_file=video_file,
    #         audio_files=audio_files,
    #     )
    #     audio_variants = []
    #     for index, (variant_id, label, path) in enumerate(variant_files):
    #         raw_audio_file = audio_files[index][1] if index < len(audio_files) else None
    #         raw_audio_url = (
    #             self._build_media_url(str(raw_audio_file.relative_to(CACHE_DIR)))
    #             if raw_audio_file is not None
    #             else ""
    #         )
    #         audio_variants.append(
    #             {
    #                 "id": variant_id,
    #                 "label": label,
    #                 "media_url": self._build_media_url(str(path.relative_to(CACHE_DIR))),
    #                 "audio_url": raw_audio_url,
    #             }
    #         )
    #     existing_variant_id = str(item.selected_audio_variant_id or "").strip()
    #     allowed_variant_ids = {
    #         str(variant.get("id") or "").strip()
    #         for variant in audio_variants
    #         if isinstance(variant, dict)
    #     }
    #     selected_audio_variant_id = (
    #         existing_variant_id
    #         if existing_variant_id and existing_variant_id in allowed_variant_ids
    #         else (str(audio_variants[0].get("id") or "").strip() if audio_variants else "")
    #     )
    #     return {
    #         "media_file": output_file,
    #         "video_relative_path": str(video_file.relative_to(CACHE_DIR)),
    #         "video_media_url": self._build_media_url(str(video_file.relative_to(CACHE_DIR))),
    #         "audio_variants": audio_variants,
    #         "selected_audio_variant_id": selected_audio_variant_id,
    #     }

    # LEGACY: old split-cache builds generated muxed MP4 files under
    # cache/<item>/variants and exposed them as audio_variants[*].media_url.
    # The current player uses split media (video_media_url + audio_url), so this
    # mux path is intentionally disabled to avoid extra ffmpeg work and storage.
    #
    # def _build_audio_variant_outputs(
    #     self,
    #     item,
    #     ffmpeg_path: Path,
    #     item_dir: Path,
    #     log_path: Path,
    #     *,
    #     video_file: Path,
    #     audio_files: list[tuple[int, Path, str]],
    # ) -> list[tuple[str, str, Path]]:
    #     if not audio_files:
    #         raise DownloadCommandError("没有可用的音轨文件，无法生成音轨变体")
    #
    #     variant_files: list[tuple[str, str, Path]] = []
    #     variants_dir = item_dir / "variants"
    #     variants_dir.mkdir(parents=True, exist_ok=True)
    #
    #     for index, (page, audio_file, label) in enumerate(audio_files):
    #         variant_id = self._variant_id(page, label, index)
    #         variant_path = variants_dir / f"{variant_id}.mp4"
    #         variant_path.unlink(missing_ok=True)
    #
    #         command = [
    #             str(ffmpeg_path),
    #             "-y",
    #             "-i",
    #             str(video_file),
    #             "-i",
    #             str(audio_file),
    #             "-map",
    #             "0:v:0",
    #             "-map",
    #             "1:a:0",
    #             "-c",
    #             "copy",
    #             "-movflags",
    #             "+faststart",
    #             "-strict",
    #             "-2",
    #             "-metadata:s:a:0",
    #             f"title={label}",
    #             str(variant_path),
    #         ]
    #         self._append_log_line(
    #             log_path,
    #             f"[{self._log_timestamp()}] command: {json.dumps(command, ensure_ascii=False)}",
    #         )
    #
    #         process = subprocess.run(
    #             command,
    #             capture_output=True,
    #             text=True,
    #             errors="replace",
    #             check=False,
    #             cwd=str(BB_DOWN_DIR),
    #             env=self._tool_process_env(ffmpeg_path),
    #             **self._hidden_process_kwargs(),
    #         )
    #         if process.returncode != 0 or not variant_path.exists():
    #             raise DownloadCommandError(
    #                 process.stderr.strip()
    #                 or process.stdout.strip()
    #                 or f"生成音轨变体失败: {label}"
    #             )
    #
    #         self._record_item_activity(item.id)
    #         variant_files.append((variant_id, label, variant_path))
    #     return variant_files

    def _normalize_downkyi_cache_result(
        self,
        cache_result: dict[str, object],
        ffmpeg_path: Path,
        log_path: Path,
    ) -> None:
        validation_files = cache_result.get("validation_files")
        if not isinstance(validation_files, list):
            raise DownloadCommandError("缓存规范化失败: 缺少媒体文件清单")
        for entry in validation_files:
            if not isinstance(entry, dict):
                continue
            path = entry.get("path")
            if not isinstance(path, Path):
                raise DownloadCommandError("缓存规范化失败: 媒体路径无效")
            self._normalize_downkyi_media_file(
                ffmpeg_path,
                path,
                label=str(entry.get("label") or "媒体文件"),
                stream_kind=str(entry.get("stream_kind") or ""),
                log_path=log_path,
            )

    def _normalize_downkyi_media_file(
        self,
        ffmpeg_path: Path,
        media_path: Path,
        *,
        label: str,
        stream_kind: str,
        log_path: Path,
    ) -> None:
        if not media_path.exists() or media_path.stat().st_size <= 0:
            raise DownloadCommandError(f"缓存规范化失败: {label} 原始文件不可用")
        normalized_path = media_path.with_name(
            f".{media_path.stem}.normalized-{uuid.uuid4().hex}{media_path.suffix}"
        )
        command = [
            self._tool_arg_path(ffmpeg_path),
            "-v",
            "error",
            "-xerror",
            "-y",
            "-fflags",
            "+genpts",
            "-i",
            self._tool_arg_path(media_path),
            "-map",
            "0:v:0" if stream_kind == "video" else "0:a:0",
            "-c",
            "copy",
            "-avoid_negative_ts",
            "make_zero",
        ]
        if media_path.suffix.lower() != ".flac":
            command.extend(["-movflags", "+faststart"])
        command.append(self._tool_arg_path(normalized_path))
        self._append_log_line(
            log_path,
            f"[{self._log_timestamp()}] command: {json.dumps(command, ensure_ascii=False)}",
        )
        try:
            process = subprocess.run(  # nosemgrep: python.lang.security.audit.dangerous-subprocess-use-audit
                command,
                shell=False,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                check=False,
                timeout=180,
                cwd=self._tool_arg_path(BB_DOWN_DIR),
                env=self._tool_process_env(ffmpeg_path),
                **self._hidden_process_kwargs(),
            )
        except subprocess.TimeoutExpired as exc:
            normalized_path.unlink(missing_ok=True)
            raise DownloadCommandError(f"缓存规范化失败: {label}: FFmpeg remux 超时") from exc
        if process.returncode != 0 or not normalized_path.exists() or normalized_path.stat().st_size <= 0:
            normalized_path.unlink(missing_ok=True)
            message = (process.stderr or process.stdout or "").strip() or f"ffmpeg 退出码 {process.returncode}"
            self._append_log_line(
                log_path,
                f"[{self._log_timestamp()}] remux {label}: failed: {self._compact_probe_error(message)}",
            )
            raise DownloadCommandError(
                f"缓存规范化失败: {label}: {self._compact_probe_error(message)}"
            )
        raw_size = media_path.stat().st_size
        normalized_size = normalized_path.stat().st_size
        try:
            os.replace(normalized_path, media_path)
        except OSError as exc:
            normalized_path.unlink(missing_ok=True)
            raise DownloadCommandError(f"缓存规范化失败: {label}: 无法替换临时文件: {exc}") from exc
        self._append_log_line(
            log_path,
            f"[{self._log_timestamp()}] media_diagnostic: "
            f"{json.dumps({'event': 'downkyi_track_remuxed', 'path': str(media_path), 'stream_kind': stream_kind, 'raw_size': raw_size, 'remuxed_size': normalized_size}, ensure_ascii=False, sort_keys=True)}",
        )

    @staticmethod
    def _final_path_for_attempt(path: Path) -> Path:
        if path.parent.name.startswith(".attempt-"):
            return path.parent.parent / path.name
        return path

    @classmethod
    def _cleanup_attempt_dirs(cls, item_dir: Path) -> None:
        try:
            attempts = [
                path
                for path in item_dir.rglob(".attempt-*")
                if path.is_dir()
            ]
        except OSError:
            return
        for attempt_dir in sorted(attempts, key=lambda path: len(path.parts), reverse=True):
            cls._safe_rmtree(attempt_dir)

    def _publish_validated_cache_result(
        self,
        cache_result: dict[str, object],
        log_path: Path,
    ) -> None:
        validation_files = cache_result.get("validation_files")
        if not isinstance(validation_files, list):
            raise DownloadCommandError("缓存发布失败: 缺少校验文件清单")

        publish_pairs: list[tuple[Path, Path]] = []
        for entry in validation_files:
            if not isinstance(entry, dict):
                continue
            source = entry.get("path")
            if not isinstance(source, Path):
                raise DownloadCommandError("缓存发布失败: 媒体路径无效")
            final_path = self._final_path_for_attempt(source)
            if final_path == source:
                continue
            if not source.exists() or source.stat().st_size <= 0:
                raise DownloadCommandError(f"缓存发布失败: 临时文件不可用 {source.name}")
            publish_pairs.append((source, final_path))

        if not publish_pairs:
            raise DownloadCommandError("缓存发布失败: DownKyi 没有待发布的临时文件")
        if len({str(final) for _source, final in publish_pairs}) != len(publish_pairs):
            raise DownloadCommandError("缓存发布失败: 多条媒体轨道指向同一最终路径")

        published: dict[str, Path] = {}
        try:
            for source, final_path in publish_pairs:
                final_path.parent.mkdir(parents=True, exist_ok=True)
                os.replace(source, final_path)
                published[str(source)] = final_path
                self._append_log_line(
                    log_path,
                    f"[{self._log_timestamp()}] media_diagnostic: "
                    f"{json.dumps({'event': 'downkyi_track_published', 'temporary_output': str(source), 'final_output': str(final_path), 'size': final_path.stat().st_size}, ensure_ascii=False, sort_keys=True)}",
                )
        except OSError as exc:
            for final_path in published.values():
                try:
                    final_path.unlink(missing_ok=True)
                except OSError:
                    pass
            raise DownloadCommandError(f"缓存发布失败: {exc}") from exc

        for entry in validation_files:
            if not isinstance(entry, dict):
                continue
            source = entry.get("path")
            if isinstance(source, Path) and str(source) in published:
                entry["path"] = published[str(source)]

        metadata = cache_result.get("validation_metadata")
        if isinstance(metadata, list):
            for entry in metadata:
                if not isinstance(entry, dict):
                    continue
                source = str(entry.get("path") or "")
                if source in published:
                    entry["path"] = str(published[source])

        video_source = cache_result.get("video_file")
        if isinstance(video_source, Path) and str(video_source) in published:
            video_file = published[str(video_source)]
            cache_result["video_file"] = video_file
            cache_result["video_relative_path"] = str(video_file.relative_to(CACHE_DIR))
            cache_result["video_media_url"] = self._build_media_url(str(video_file.relative_to(CACHE_DIR)))

        variants = cache_result.get("audio_variants")
        if isinstance(variants, list):
            url_map = {
                self._build_media_url(str(Path(source).relative_to(CACHE_DIR))):
                self._build_media_url(str(final.relative_to(CACHE_DIR)))
                for source, final in published.items()
            }
            for variant in variants:
                if not isinstance(variant, dict):
                    continue
                current_url = str(variant.get("audio_url") or "")
                if current_url in url_map:
                    variant["audio_url"] = url_map[current_url]

        for source, _final_path in publish_pairs:
            self._safe_rmtree(source.parent)

    def _validate_cache_result(
        self,
        item_id: str,
        cache_result: dict[str, object],
        ffmpeg_path: Path,
        log_path: Path,
    ) -> None:
        validation_files = cache_result.get("validation_files")
        if not isinstance(validation_files, list):
            return

        requires_strict_validation = any(
            isinstance(entry, dict)
            and str(entry.get("download_source") or "") in (DOWNLOAD_SOURCE_DOWNKYI, DOWNLOAD_SOURCE_BBDOWN)
            for entry in validation_files
        )
        ffprobe_path = self._ffprobe_path_for_ffmpeg(ffmpeg_path)
        if not ffprobe_path:
            message = "缓存校验失败: BBDown/DownKyi 下载需要可用的 ffprobe"
            self._append_log_line(
                log_path,
                f"[{self._log_timestamp()}] ffprobe validate: failed, ffprobe unavailable",
            )
            if requires_strict_validation:
                raise DownloadCommandError(message)
            self._append_log_line(
                log_path,
                f"[{self._log_timestamp()}] ffprobe validate: skipped for non-strict source",
            )
            return

        self.store.update_item(
            item_id,
            cache_progress=99.5,
            cache_message="正在校验缓存",
            persist_backup=False,
        )
        self._record_item_activity(item_id)
        self._append_log_line(
            log_path,
            f"[{self._log_timestamp()}] ffprobe validate: start ({len(validation_files)} files)",
        )

        validation_errors: list[str] = []
        validation_metadata: list[dict[str, object]] = []
        for entry in validation_files:
            self._raise_if_retry_requested(item_id)
            if not isinstance(entry, dict):
                continue
            label = str(entry.get("label") or "媒体文件")
            try:
                path = entry.get("path")
                required_streams = entry.get("required_streams")
                if not isinstance(path, Path):
                    raise DownloadCommandError(f"缓存校验失败: {label} 路径无效")
                if not isinstance(required_streams, set):
                    required_streams = set(required_streams or [])
                metadata = self._validate_media_file(
                    ffprobe_path,
                    ffmpeg_path,
                    path,
                    label=label,
                    required_streams={str(stream) for stream in required_streams},
                    log_path=log_path,
                    diagnostic_context={**entry, "item_id": item_id},
                )
                metadata.update(
                    {
                        "label": label,
                        "page": int(entry.get("page") or 0),
                        "stream_kind": str(entry.get("stream_kind") or ""),
                        "expected_duration": self._optional_probe_float(entry.get("expected_duration")),
                        "source_audio_duration": self._optional_probe_float(
                            entry.get("source_audio_duration")
                        ),
                    }
                )
                validation_metadata.append(metadata)
            except CacheCancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                message = self._compact_probe_error(str(exc))
                validation_errors.append(message)
                path = entry.get("path")
                if isinstance(path, Path):
                    self._discard_invalid_media(path)
                self._append_log_line(
                    log_path,
                    f"[{self._log_timestamp()}] ffprobe validate {label}: failed: {message}",
                )

        cache_result["validation_metadata"] = validation_metadata
        cache_result["validation_failure_count"] = len(validation_errors)
        if validation_errors:
            for message in validation_errors:
                self._append_log_line(
                    log_path,
                    f"[{self._log_timestamp()}] cache validation error: {message}",
                )
            raise DownloadCommandError("；".join(validation_errors))
        self._append_log_line(log_path, f"[{self._log_timestamp()}] ffprobe validate: ok")

    def _probe_media_payload(
        self,
        ffprobe_path: Path,
        ffmpeg_path: Path,
        media_path: Path,
        *,
        label: str,
        log_path: Path,
    ) -> tuple[int, dict[str, object]]:
        if not media_path.exists():
            raise DownloadCommandError(f"缓存校验失败: {label} 文件不存在")
        size = media_path.stat().st_size
        if size <= 0:
            raise DownloadCommandError(f"缓存校验失败: {label} 文件为空")

        command = [
            self._tool_arg_path(ffprobe_path),
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_streams",
            "-show_format",
            self._tool_arg_path(media_path),
        ]
        self._append_log_line(
            log_path,
            f"[{self._log_timestamp()}] command: {json.dumps(command, ensure_ascii=False)}",
        )
        process = subprocess.run(  # nosemgrep: python.lang.security.audit.dangerous-subprocess-use-audit
            command,
            shell=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
            timeout=20,
            cwd=self._tool_arg_path(BB_DOWN_DIR),
            env=self._tool_process_env(ffmpeg_path),
            **self._hidden_process_kwargs(),
        )
        if process.returncode != 0:
            message = (process.stderr or process.stdout or "").strip() or f"ffprobe 退出码 {process.returncode}"
            raise DownloadCommandError(f"缓存校验失败: {label}: {self._compact_probe_error(message)}")

        try:
            payload = json.loads(process.stdout or "{}")
        except json.JSONDecodeError as exc:
            raise DownloadCommandError(f"缓存校验失败: {label}: ffprobe 输出无法解析") from exc
        if not isinstance(payload, dict):
            raise DownloadCommandError(f"缓存校验失败: {label}: ffprobe 输出结构无效")
        return size, payload

    def _probe_original_audio_duration(
        self,
        ffprobe_path: Path,
        ffmpeg_path: Path,
        media_path: Path,
        *,
        label: str,
        log_path: Path,
    ) -> float:
        _size, payload = self._probe_media_payload(
            ffprobe_path,
            ffmpeg_path,
            media_path,
            label=f"{label} 原始音轨",
            log_path=log_path,
        )
        duration = self._probe_stream_duration(payload, "audio")
        if duration is None:
            raise DownloadCommandError(f"缓存校验失败: {label} 原始音轨未报告有效时长")
        self._append_log_line(
            log_path,
            f"[{self._log_timestamp()}] ffprobe source audio {label}: duration={duration:.6f}s",
        )
        return duration

    def _validate_media_file(
        self,
        ffprobe_path: Path,
        ffmpeg_path: Path,
        media_path: Path,
        *,
        label: str,
        required_streams: set[str],
        log_path: Path,
        diagnostic_context: dict[str, object] | None = None,
    ) -> dict[str, object]:
        size, payload = self._probe_media_payload(
            ffprobe_path, ffmpeg_path, media_path, label=label, log_path=log_path
        )
        streams = payload.get("streams")
        if not isinstance(streams, list) or not streams:
            raise DownloadCommandError(f"缓存校验失败: {label}: 未识别到媒体流")

        detected_streams = {
            str(stream.get("codec_type") or "").strip()
            for stream in streams
            if isinstance(stream, dict)
        }
        missing_streams = required_streams - detected_streams
        if missing_streams:
            missing_label = "/".join(sorted(missing_streams))
            detected_label = "/".join(sorted(stream for stream in detected_streams if stream)) or "none"
            raise DownloadCommandError(
                f"缓存校验失败: {label}: 缺少 {missing_label} 流，实际为 {detected_label}"
            )

        primary_stream_kind = next(iter(required_streams)) if len(required_streams) == 1 else None
        stream_duration = (
            self._probe_stream_duration(payload, primary_stream_kind)
            if primary_stream_kind is not None
            else None
        )
        duration = stream_duration or self._probe_duration(payload)
        context = diagnostic_context or {}
        expected_duration = self._optional_probe_float(context.get("expected_duration"))
        if expected_duration is not None and expected_duration > 0 and duration is None:
            raise DownloadCommandError(f"缓存校验失败: {label} 未报告有效时长")
        if duration is not None and duration < 1.0:
            raise DownloadCommandError(f"缓存校验失败: {label} 时长异常，实际 {duration:.2f} 秒")
        if expected_duration is not None and expected_duration > 0 and duration is not None:
            tolerance = self._duration_tolerance(expected_duration)
            if duration + tolerance < expected_duration:
                raise DownloadCommandError(
                    f"缓存校验失败: {label} 时长异常，预期约 {expected_duration:.0f} 秒，"
                    f"实际 {duration:.0f} 秒"
                )
        if "source_audio_duration" in context:
            source_audio_duration = self._optional_probe_float(context.get("source_audio_duration"))
            if (
                required_streams != {"audio"}
                or source_audio_duration is None
                or source_audio_duration <= 0
            ):
                raise DownloadCommandError(f"缓存校验失败: {label} 原始音轨时长上下文无效")
            if stream_duration is None:
                raise DownloadCommandError(f"缓存校验失败: {label} 未报告音频流时长")
            difference = abs(stream_duration - source_audio_duration)
            if difference > SOURCE_AUDIO_DURATION_TOLERANCE_SECONDS:
                raise DownloadCommandError(
                    f"缓存校验失败: {label} 与原始音轨时长不一致，"
                    f"原始 {source_audio_duration:.3f} 秒，实际 {stream_duration:.3f} 秒，"
                    f"相差 {difference:.3f} 秒"
                )
        if str(context.get("download_source") or "") in (DOWNLOAD_SOURCE_DOWNKYI, DOWNLOAD_SOURCE_BBDOWN):
            self._validate_demux_file(
                ffmpeg_path,
                media_path,
                label=label,
                stream_kind=str(context.get("stream_kind") or ""),
                log_path=log_path,
            )

        duration_label = f"{duration:.2f}s" if duration is not None else "unknown"
        stream_label = "/".join(sorted(stream for stream in detected_streams if stream)) or "unknown"
        self._append_log_line(
            log_path,
            f"[{self._log_timestamp()}] ffprobe validate {label}: ok "
            f"(streams={stream_label}, duration={duration_label}, size={size})",
        )

        file_format = payload.get("format") if isinstance(payload.get("format"), dict) else {}
        normalized_streams = [
            {
                "codec_type": str(stream.get("codec_type") or ""),
                "codec_name": str(stream.get("codec_name") or ""),
                "codec_tag_string": str(stream.get("codec_tag_string") or ""),
                "duration": self._optional_probe_float(stream.get("duration")),
                "start_time": self._optional_probe_float(stream.get("start_time")),
                "duration_ts": stream.get("duration_ts"),
                "time_base": str(stream.get("time_base") or ""),
            }
            for stream in streams
            if isinstance(stream, dict)
        ]
        metadata: dict[str, object] = {
            "path": str(media_path),
            "size": size,
            "format_name": str(file_format.get("format_name") or ""),
            "duration": duration,
            "start_time": self._optional_probe_float(file_format.get("start_time")),
            "streams": normalized_streams,
        }
        if str(context.get("download_source") or "") == DOWNLOAD_SOURCE_DOWNKYI:
            selected = context.get("stream_metadata") if isinstance(context.get("stream_metadata"), dict) else {}
            summary = {
                "event": "downkyi_track_probe",
                "item_id": str(context.get("item_id") or ""),
                "page": int(context.get("page") or 0),
                "cid": int(context.get("cid") or 0),
                "stream_kind": str(context.get("stream_kind") or ""),
                "quality_id": int(selected.get("quality_id") or 0),
                "codec_name": str(selected.get("codec_name") or ""),
                "codec_string": str(selected.get("codecs") or ""),
                "bandwidth": int(selected.get("bandwidth") or 0),
                "expected_output": str(media_path),
                "actual_output": str(media_path),
                "file_size": size,
                "source_audio_duration": self._optional_probe_float(context.get("source_audio_duration")),
                "aria2_control_files": [
                    candidate.name
                    for candidate in media_path.parent.glob("*.aria2")
                    if candidate.is_file()
                ],
                "ffprobe": metadata,
            }
            self._append_log_line(
                log_path,
                f"[{self._log_timestamp()}] media_diagnostic: "
                f"{json.dumps(summary, ensure_ascii=False, sort_keys=True)}",
            )
        return metadata

    @staticmethod
    def _duration_tolerance(expected_duration: float) -> float:
        return max(3.0, expected_duration * 0.02)

    @staticmethod
    def _discard_invalid_media(media_path: Path) -> None:
        for candidate in (media_path, Path(f"{media_path}.aria2")):
            try:
                candidate.unlink(missing_ok=True)
            except OSError:
                pass

    def _validate_demux_file(
        self,
        ffmpeg_path: Path,
        media_path: Path,
        *,
        label: str,
        stream_kind: str,
        log_path: Path,
    ) -> None:
        map_specifier = "0:v:0" if stream_kind == "video" else "0:a:0"
        command = [
            self._tool_arg_path(ffmpeg_path),
            "-v",
            "error",
            "-xerror",
            "-i",
            self._tool_arg_path(media_path),
            "-map",
            map_specifier,
            "-c",
            "copy",
            "-f",
            "null",
            "-",
        ]
        self._append_log_line(
            log_path,
            f"[{self._log_timestamp()}] command: {json.dumps(command, ensure_ascii=False)}",
        )
        try:
            process = subprocess.run(  # nosemgrep: python.lang.security.audit.dangerous-subprocess-use-audit
                command,
                shell=False,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                check=False,
                timeout=120,
                cwd=self._tool_arg_path(BB_DOWN_DIR),
                env=self._tool_process_env(ffmpeg_path),
                **self._hidden_process_kwargs(),
            )
        except subprocess.TimeoutExpired as exc:
            raise DownloadCommandError(f"缓存校验失败: {label}: FFmpeg 完整包扫描超时") from exc
        if process.returncode != 0:
            message = (process.stderr or process.stdout or "").strip()
            raise DownloadCommandError(
                f"缓存校验失败: {label}: FFmpeg 完整包扫描失败: "
                f"{self._compact_probe_error(message)}"
            )

    @staticmethod
    def _optional_probe_float(value: object) -> float | None:
        if isinstance(value, bool):
            return None
        try:
            result = float(value)
        except (TypeError, ValueError):
            return None
        return result if math.isfinite(result) else None

    @classmethod
    def _probe_stream_duration(
        cls,
        payload: dict[str, object],
        stream_kind: str,
    ) -> float | None:
        streams = payload.get("streams")
        if not isinstance(streams, list):
            return None
        for stream in streams:
            if (
                not isinstance(stream, dict)
                or str(stream.get("codec_type") or "").strip() != stream_kind
            ):
                continue
            duration = cls._optional_probe_float(stream.get("duration"))
            if duration is not None and duration > 0:
                return duration
            duration_ts = cls._optional_probe_float(stream.get("duration_ts"))
            time_base = str(stream.get("time_base") or "").strip()
            if duration_ts is None or duration_ts <= 0 or "/" not in time_base:
                continue
            numerator_text, denominator_text = time_base.split("/", 1)
            numerator = cls._optional_probe_float(numerator_text)
            denominator = cls._optional_probe_float(denominator_text)
            if (
                numerator is None
                or numerator <= 0
                or denominator is None
                or denominator <= 0
            ):
                continue
            reconstructed = duration_ts * numerator / denominator
            if math.isfinite(reconstructed) and reconstructed > 0:
                return reconstructed
        return None

    @classmethod
    def _probe_duration(cls, payload: dict[str, object]) -> float | None:
        streams = payload.get("streams")
        if isinstance(streams, list):
            stream_kinds = [
                str(stream.get("codec_type") or "").strip()
                for stream in streams
                if isinstance(stream, dict)
            ]
            for stream_kind in stream_kinds:
                duration = cls._probe_stream_duration(payload, stream_kind)
                if duration is not None:
                    return duration
        file_format = payload.get("format")
        if isinstance(file_format, dict):
            duration = cls._optional_probe_float(file_format.get("duration"))
            if duration is not None and duration > 0:
                return duration
        return None

    @staticmethod
    def _compact_probe_error(message: str) -> str:
        normalized = " ".join(str(message or "").split())
        return normalized[:240] if normalized else "未知错误"

    @classmethod
    def _ffprobe_path_for_ffmpeg(cls, ffmpeg_path: Path) -> Path | None:
        candidates = []
        if FFPROBE_RUNTIME_PATH.exists():
            candidates.append(FFPROBE_RUNTIME_PATH)
        ffmpeg_dir = ffmpeg_path if ffmpeg_path.is_dir() else ffmpeg_path.parent
        candidates.append(ffmpeg_dir / ("ffprobe.exe" if os.name == "nt" else "ffprobe"))
        system_ffprobe = shutil.which("ffprobe")
        if system_ffprobe:
            candidates.append(Path(system_ffprobe))
        seen: set[str] = set()
        for candidate in candidates:
            try:
                candidate_key = os.path.normcase(str(candidate.resolve()))
            except OSError:
                candidate_key = os.path.normcase(str(candidate))
            if candidate_key in seen:
                continue
            seen.add(candidate_key)
            if cls._is_usable_ffprobe(candidate):
                return candidate
        return None

    @staticmethod
    def _is_usable_ffprobe(binary_path: Path) -> bool:
        return bool(CacheManager._read_tool_version(binary_path, "ffprobe"))

    @staticmethod
    def _variant_id(page: int, label: str, index: int) -> str:
        normalized = re.sub(r"[^a-z0-9]+", "_", label.lower()).strip("_")
        suffix = normalized or f"track_{index + 1}"
        return f"p{max(int(page), 1)}_{suffix}"

    @staticmethod
    def _page_url(base_url: str, page: int) -> str:
        parsed = urllib.parse.urlparse(base_url)
        query = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
        filtered_query = [(key, value) for key, value in query if key != "p"]
        filtered_query.append(("p", str(page)))
        return urllib.parse.urlunparse(parsed._replace(query=urllib.parse.urlencode(filtered_query)))

    @staticmethod
    def _selected_pages_for_item(item) -> list[int]:
        pages = [int(page) for page in (item.selected_pages or [item.page]) if int(page) > 0]
        unique_pages: list[int] = []
        for page in pages:
            if page not in unique_pages:
                unique_pages.append(page)
        return unique_pages or [max(int(item.page), 1)]

    @staticmethod
    def _part_label_for_page(item, page: int) -> str:
        selected_pages = list(item.selected_pages or [])
        selected_parts = list(item.selected_parts or [])
        try:
            index = selected_pages.index(page)
        except ValueError:
            return f"P{page}"
        if index < len(selected_parts) and str(selected_parts[index] or "").strip():
            return str(selected_parts[index]).strip()
        return f"P{page}"

    @staticmethod
    def _cache_start_message(item) -> str:
        page_count = max(1, len(item.selected_pages or []))
        return f"正在缓存 1 路视频轨 + {page_count} 路音轨"

    @staticmethod
    def _ready_message(item) -> str:
        page_count = max(1, len(item.selected_pages or []))
        return f"缓存完成，共 {page_count} 条音轨"

    @staticmethod
    def _display_stage_message(stage_label: str, line: str, progress: float | None) -> str:
        if progress is not None:
            return f"{stage_label} {round(progress)}%"
        if line:
            return f"{stage_label}: {line}"
        return stage_label

    @staticmethod
    def _selected_stream_size_hint_bytes(line: str, stream_kind: str) -> int:
        normalized_line = str(line or "").strip()

        aria2_progress = CacheManager._aria2_progress_bytes(normalized_line)
        if aria2_progress is not None:
            return aria2_progress[1]

        expected_prefix = "[视频]" if stream_kind == "video" else "[音频]"
        if expected_prefix not in normalized_line:
            return 0
        matches = STREAM_SIZE_HINT_RE.findall(normalized_line)
        if not matches:
            return 0
        amount, unit = matches[-1]
        try:
            value = float(amount)
        except (TypeError, ValueError):
            return 0
        unit_index = {"B": 0, "KB": 1, "MB": 2, "GB": 3, "TB": 4}.get(str(unit or "").upper())
        if unit_index is None:
            return 0
        return max(0, int(value * (1024 ** unit_index)))

    @staticmethod
    def _aria2_size_bytes(amount: object, unit: object) -> int:
        try:
            value = float(amount)
        except (TypeError, ValueError):
            return 0
        unit_upper = str(unit or "").upper()
        if unit_upper.startswith("T"):
            multiplier = 1024 ** 4
        elif unit_upper.startswith("G"):
            multiplier = 1024 ** 3
        elif unit_upper.startswith("M"):
            multiplier = 1024 ** 2
        elif unit_upper.startswith("K"):
            multiplier = 1024
        else:
            multiplier = 1
        return max(0, int(value * multiplier))

    @classmethod
    def _aria2_progress_bytes(cls, line: object) -> tuple[int, int, float] | None:
        match = ARIA2_PROGRESS_RE.search(str(line or "").strip())
        if not match:
            return None
        current_amount, current_unit, total_amount, total_unit, percent_text = match.groups()
        current_bytes = cls._aria2_size_bytes(current_amount, current_unit)
        target_bytes = cls._aria2_size_bytes(total_amount, total_unit)
        try:
            percent = float(percent_text)
        except (TypeError, ValueError):
            return None
        return current_bytes, target_bytes, max(0.0, min(percent, 100.0))

    @staticmethod
    def _format_stage_bytes(value: object) -> str:
        try:
            size = max(0.0, float(value or 0.0))
        except (TypeError, ValueError):
            size = 0.0
        units = ("B", "KB", "MB", "GB", "TB")
        unit_index = 0
        while size >= 1024 and unit_index < len(units) - 1:
            size /= 1024
            unit_index += 1
        if unit_index == 0:
            return f"{round(size)} {units[unit_index]}"
        return f"{size:.1f} {units[unit_index]}"

    @classmethod
    def _structured_stage_message(cls, stage_label: str, current_bytes: int, target_bytes: int) -> str:
        normalized_current = max(0, int(current_bytes or 0))
        normalized_target = max(0, int(target_bytes or 0))
        if normalized_target > 0 and normalized_current > 0:
            percent = min(99, max(0, round((normalized_current / normalized_target) * 100)))
            return (
                f"{stage_label} {percent}% · "
                f"{cls._format_stage_bytes(normalized_current)} / {cls._format_stage_bytes(normalized_target)}"
            )
        if normalized_target > 0:
            return f"{stage_label} · 预计 {cls._format_stage_bytes(normalized_target)}"
        if normalized_current > 0:
            return f"{stage_label} · 已写入 {cls._format_stage_bytes(normalized_current)}"
        return f"{stage_label} 准备中"

    def _begin_download_progress(self, item_id: str, tracks: list[dict[str, object]]) -> None:
        with self.lock:
            self.item_stage_progress_signatures.pop(item_id, None)
            self.item_download_progress[item_id] = {
                str(track.get("key") or ""): {
                    "key": str(track.get("key") or ""),
                    "label": str(track.get("label") or ""),
                    "order": int(track.get("order") or 0),
                    "current_bytes": 0,
                    "target_bytes": 0,
                    "progress_percent": None,
                    "done": False,
                    "phase": "waiting",
                    "attempt": 0,
                    "max_attempts": 0,
                }
                for track in tracks
                if str(track.get("key") or "")
            }
        self._publish_download_progress(item_id)

    def _clear_item_download_progress(self, item_id: str) -> None:
        with self.lock:
            self.item_stage_progress_signatures.pop(item_id, None)
            self.item_download_progress.pop(item_id, None)

    def _reset_download_track_progress(self, item_id: str, track_key: str) -> None:
        with self.lock:
            tracks = self.item_download_progress.get(item_id)
            if not tracks or track_key not in tracks:
                return
            track = tracks[track_key]
            track["current_bytes"] = 0
            track["target_bytes"] = 0
            track["progress_percent"] = None
            track["done"] = False
            self.item_stage_progress_signatures.pop(item_id, None)
        self._publish_download_progress(item_id)

    def _set_download_track_phase(
        self,
        item_id: str,
        track_key: str,
        *,
        phase: str,
        attempt: int,
        max_attempts: int,
    ) -> None:
        with self.lock:
            tracks = self.item_download_progress.get(item_id)
            if not tracks or track_key not in tracks:
                return
            track = tracks[track_key]
            track["phase"] = str(phase or "")
            track["attempt"] = max(0, int(attempt or 0))
            track["max_attempts"] = max(0, int(max_attempts or 0))
            self.item_stage_progress_signatures.pop(item_id, None)
        self._publish_download_progress(item_id)

    @staticmethod
    def _download_track_progress_label(track: dict[str, object]) -> str:
        label = str(track.get("label") or "轨道")
        phase = str(track.get("phase") or "")
        attempt = max(0, int(track.get("attempt") or 0))
        max_attempts = max(0, int(track.get("max_attempts") or 0))
        if phase == "validating":
            return f"{label}（校验中）"
        if phase == "retrying" and attempt > 0 and max_attempts > 0:
            return f"{label}（第 {attempt}/{max_attempts} 次失败）"
        if phase == "downloading" and attempt > 1 and max_attempts > 0:
            return f"{label}（重试 {attempt}/{max_attempts}）"
        return label

    def _update_download_track_progress(
        self,
        item_id: str,
        *,
        track_key: str,
        target_dir: Path,
        current_bytes: int | None = None,
        target_bytes: int | None = None,
        progress_percent: float | None = None,
        done: bool = False,
        is_preallocated: bool = False,
        measure_path: bool = True,
    ) -> None:
        with self.lock:
            tracks = self.item_download_progress.get(item_id)
            if not tracks or track_key not in tracks:
                return
            track = tracks[track_key]
            if target_bytes is not None and int(target_bytes or 0) > 0:
                track["target_bytes"] = max(
                    int(track.get("target_bytes") or 0),
                    int(target_bytes or 0),
                )
            if progress_percent is not None:
                try:
                    normalized_progress = float(progress_percent)
                except (TypeError, ValueError):
                    normalized_progress = 0.0
                track["progress_percent"] = max(
                    float(track.get("progress_percent") or 0.0),
                    max(0.0, min(normalized_progress, 100.0)),
                )
            if done:
                track["done"] = True
                track["progress_percent"] = 100.0

            # Calculate current_bytes using progress_percent if available to avoid pre-allocated disk size issue
            t_bytes = int(track.get("target_bytes") or 0)
            p_percent = track.get("progress_percent")
            if current_bytes is not None:
                measured_bytes = max(
                    int(track.get("current_bytes") or 0),
                    max(0, int(current_bytes or 0)),
                )
            elif is_preallocated and p_percent is not None and t_bytes > 0:
                measured_bytes = int(t_bytes * (float(p_percent) / 100.0))
            elif measure_path:
                measured_bytes = self._path_size(target_dir)
            else:
                measured_bytes = int(track.get("current_bytes") or 0)

            track["current_bytes"] = max(0, int(measured_bytes or 0))

            if done:
                track["target_bytes"] = int(track.get("current_bytes") or 0)
        self._publish_download_progress(item_id)

    def _publish_download_progress(self, item_id: str) -> None:
        with self.lock:
            tracks_by_key = self.item_download_progress.get(item_id) or {}
            tracks = [dict(track) for track in tracks_by_key.values()]
        if not tracks:
            return

        tracks.sort(key=lambda track: int(track.get("order") or 0))
        message = self._structured_download_message(tracks)
        total_current, total_target, all_targets_known, all_done = self._download_progress_totals(tracks)
        changes: dict[str, object] = {"cache_message": message}
        if all_targets_known and total_target > 0:
            ratio = max(0.0, min(float(total_current) / float(total_target), 1.0))
            progress_cap = 99.0 if all_done else 98.0
            changes["cache_progress"] = min(progress_cap, ratio * progress_cap)
        else:
            percent_ratio = self._download_progress_ratio_from_track_percents(tracks)
            if percent_ratio is not None:
                progress_cap = 99.0 if all_done else 98.0
                changes["cache_progress"] = min(progress_cap, percent_ratio * progress_cap)

        cache_progress_signature = (
            round(float(changes["cache_progress"]), 3)
            if "cache_progress" in changes
            else None
        )
        signature = json.dumps(
            {
                "item_id": item_id,
                "message": message,
                "cache_progress": cache_progress_signature,
            },
            ensure_ascii=False,
            sort_keys=True,
        )
        with self.lock:
            if self.item_stage_progress_signatures.get(item_id) == signature:
                return
            self.item_stage_progress_signatures[item_id] = signature
        self.store.update_item(item_id, persist_backup=False, **changes)
        self._record_item_activity(item_id)

    @classmethod
    def _download_progress_totals(cls, tracks: list[dict[str, object]]) -> tuple[int, int, bool, bool]:
        total_current = 0
        total_target = 0
        all_targets_known = bool(tracks)
        all_done = bool(tracks)
        for track in tracks:
            current_bytes = max(0, int(track.get("current_bytes") or 0))
            target_bytes = max(0, int(track.get("target_bytes") or 0))
            if target_bytes <= 0:
                all_targets_known = False
                display_current = current_bytes
            else:
                display_current = min(current_bytes, target_bytes)
                total_target += target_bytes
            total_current += display_current
            if not bool(track.get("done")):
                all_done = False
        return total_current, total_target, all_targets_known, all_done

    @staticmethod
    def _download_progress_ratio_from_track_percents(tracks: list[dict[str, object]]) -> float | None:
        if not tracks:
            return None
        total = 0.0
        saw_progress = False
        for track in tracks:
            if bool(track.get("done")):
                total += 1.0
                saw_progress = True
                continue
            progress = track.get("progress_percent")
            if progress is None:
                continue
            try:
                percent = float(progress)
            except (TypeError, ValueError):
                continue
            total += max(0.0, min(percent, 100.0)) / 100.0
            saw_progress = True
        if not saw_progress:
            return None
        return max(0.0, min(total / len(tracks), 1.0))

    @classmethod
    def _structured_download_message(cls, tracks: list[dict[str, object]]) -> str:
        sorted_tracks = sorted(tracks, key=lambda track: int(track.get("order") or 0))
        total_current, total_target, all_targets_known, _all_done = cls._download_progress_totals(sorted_tracks)
        if all_targets_known and total_target > 0:
            lines = [
                f"总计：{cls._format_stage_bytes(total_current)} / {cls._format_stage_bytes(total_target)}"
            ]
        else:
            lines = [f"总计：{cls._format_stage_bytes(total_current)} / 估算中"]

        for track in sorted_tracks:
            label = cls._download_track_progress_label(track)
            current_bytes = max(0, int(track.get("current_bytes") or 0))
            target_bytes = max(0, int(track.get("target_bytes") or 0))
            if target_bytes > 0:
                display_current = min(current_bytes, target_bytes)
                lines.append(
                    f"{label}：{cls._format_stage_bytes(display_current)} / {cls._format_stage_bytes(target_bytes)}"
                )
            else:
                lines.append(f"{label}：{cls._format_stage_bytes(current_bytes)} / 估算中")
        return "\n".join(lines)

    def _monitor_download_track_progress(
        self,
        *,
        item_id: str,
        process: subprocess.Popen[str],
        stop_event: threading.Event,
        track_key: str,
        target_dir: Path,
        target_bytes_state: dict[str, int],
        current_bytes_state: dict[str, int] | None = None,
        progress_percent_state: dict[str, float | None] | None = None,
        is_preallocated: bool = False,
        measure_path: bool = True,
    ) -> None:
        while not stop_event.wait(1.0):
            self._update_download_track_progress(
                item_id,
                track_key=track_key,
                target_dir=target_dir,
                current_bytes=(current_bytes_state or {}).get("value"),
                target_bytes=target_bytes_state.get("value", 0),
                progress_percent=(progress_percent_state or {}).get("value"),
                is_preallocated=is_preallocated,
                measure_path=measure_path,
            )
            if process.poll() is not None:
                return

    def _update_structured_stage_progress(
        self,
        item_id: str,
        *,
        stage_label: str,
        target_dir: Path,
        target_bytes: int,
        progress_start: float,
        progress_span: float,
    ) -> None:
        current_bytes = self._path_size(target_dir)
        message = self._structured_stage_message(stage_label, current_bytes, target_bytes)
        changes: dict[str, object] = {"cache_message": message}
        normalized_target = max(0, int(target_bytes or 0))
        if normalized_target > 0:
            stage_ratio = max(0.0, min(float(current_bytes) / float(normalized_target), 0.99))
            changes["cache_progress"] = progress_start + stage_ratio * progress_span
        cache_progress_signature = (
            round(float(changes["cache_progress"]), 3)
            if "cache_progress" in changes
            else None
        )
        signature = json.dumps(
            {
                "item_id": item_id,
                "message": message,
                "cache_progress": cache_progress_signature,
            },
            ensure_ascii=False,
            sort_keys=True,
        )
        with self.lock:
            if self.item_stage_progress_signatures.get(item_id) == signature:
                return
            self.item_stage_progress_signatures[item_id] = signature
        self.store.update_item(item_id, persist_backup=False, **changes)
        self._record_item_activity(item_id)

    def _monitor_structured_stage_progress(
        self,
        *,
        item_id: str,
        process: subprocess.Popen[str],
        stop_event: threading.Event,
        stage_label: str,
        target_dir: Path,
        target_bytes_state: dict[str, int],
        progress_start: float,
        progress_span: float,
    ) -> None:
        while not stop_event.wait(1.0):
            self._update_structured_stage_progress(
                item_id,
                stage_label=stage_label,
                target_dir=target_dir,
                target_bytes=target_bytes_state.get("value", 0),
                progress_start=progress_start,
                progress_span=progress_span,
            )
            if process.poll() is not None:
                return

    def _current_download_source(self) -> str:
        with self.lock:
            return self.download_source

    @staticmethod
    def _download_source_label(download_source: str) -> str:
        if download_source == DOWNLOAD_SOURCE_NATIVE:
            return "Rust Native"
        if download_source == DOWNLOAD_SOURCE_YTDLP:
            return "yt-dlp"
        if download_source == DOWNLOAD_SOURCE_DOWNKYI:
            return "Downkyi"
        return "BBDown"

    def _ensure_downloader(self, download_source: str, *, force_refresh: bool = False) -> Path:
        if download_source == DOWNLOAD_SOURCE_NATIVE:
            if not rust_runtime.http_download_available():
                status = rust_runtime.runtime_status()
                raise RuntimeError(status.get("error") or "Rust runtime unavailable")
            return Path()
        if download_source == DOWNLOAD_SOURCE_YTDLP:
            return self._ensure_ytdlp()
        if download_source == DOWNLOAD_SOURCE_DOWNKYI:
            return self._ensure_aria2c()
        return self._ensure_bbdown(force_refresh=force_refresh)

    def _ensure_bbdown(self, force_refresh: bool = False) -> Path:
        with self.binary_prepare_lock:
            override = Path(BB_DOWN_PATH_OVERRIDE).expanduser() if BB_DOWN_PATH_OVERRIDE else None
            override_exists = bool(override and override.exists())
            current_binary = self._local_binary_path()
            if PACKAGED_RUNTIME:
                if override_exists:
                    with self.lock:
                        self.binary_state = "ready"
                        self.binary_version = self._read_bbdown_version(override)
                        self.binary_message = f"使用外部 BBDown: {override}"
                    return override
                return self._ensure_packaged_bbdown(
                    current_binary,
                    force_refresh=force_refresh,
                )

            local_version = ""
            if not override_exists and BB_DOWN_VERSION_FILE.exists():
                local_version = BB_DOWN_VERSION_FILE.read_text(encoding="utf-8").strip()
            completed, prepare_decision = rust_backend.try_decide_tool_prepare_policy(
                {
                    "schema_version": 1,
                    "override_exists": override_exists,
                    "installed_exists": current_binary.exists(),
                    "force_refresh": force_refresh,
                    "version_metadata_present": bool(local_version),
                }
            )
            if not completed or prepare_decision is None:
                raise RuntimeError("Rust BBDown prepare policy is unavailable or invalid")

            prepare_action = prepare_decision["action"]
            if prepare_action == "use_override":
                if override is None or not override.exists():
                    raise RuntimeError("Rust BBDown prepare policy selected an invalid override")
                with self.lock:
                    self.binary_state = "ready"
                    self.binary_message = f"使用外部 BBDown: {override}"
                return override

            if prepare_action == "use_installed":
                if not current_binary.exists():
                    raise RuntimeError(
                        "Rust BBDown prepare policy selected a missing installed binary"
                    )
                current_binary.chmod(current_binary.stat().st_mode | stat.S_IEXEC)
                if prepare_decision["probe_installed_version"]:
                    local_version = self._read_bbdown_version(current_binary)
                with self.lock:
                    self.binary_state = "ready"
                    self.binary_version = local_version
                    if local_version:
                        self.binary_message = f"BBDown {local_version} 已就绪（未检查更新）"
                    else:
                        self.binary_message = "BBDown 已就绪（未检查更新）"
                return current_binary

            if prepare_action != "fetch_install_update":
                raise RuntimeError("Rust BBDown prepare policy returned an unknown action")

            release: dict[str, Any] | None = None
            latest_version = ""
            release_error: Exception | None = None
            try:
                release = self._fetch_latest_release()
                latest_version = str(release["tag_name"])
            except Exception as exc:  # noqa: BLE001
                release_error = exc

            if release is None:
                if not TOOL_ASSET_BASE_URL:
                    raise RuntimeError(f"无法检查 BBDown 最新版本: {release_error}")
                release = {"tag_name": "r2-fallback", "assets": [self._bbdown_fallback_asset()]}
                latest_version = str(release["tag_name"])

            version_matches = (
                not force_refresh
                and
                BB_DOWN_VERSION_FILE.exists()
                and BB_DOWN_VERSION_FILE.read_text(encoding="utf-8").strip() == latest_version
                and current_binary.exists()
            )

            if version_matches:
                with self.lock:
                    self.binary_state = "ready"
                    self.binary_version = latest_version
                    self.binary_message = f"BBDown {latest_version} 已就绪"
                return current_binary

            with self.lock:
                self.binary_state = "installing"
                self.binary_message = "正在强制更新 BBDown" if force_refresh else "正在检查和更新 BBDown"

            BB_DOWN_DIR.mkdir(parents=True, exist_ok=True)
            asset = self._select_asset(release)
            tmp_archive = BB_DOWN_DIR / f".tmp_{asset['name']}"
            tmp_extract_dir = BB_DOWN_DIR / f".tmp_extract_{asset['name']}"

            try:
                # 1. Download to temporary archive
                self._download_tool_asset(asset, tmp_archive, tool="bbdown")

                # 2. Validate downloaded archive
                archive_name = asset["name"]
                is_valid = False
                lower_name = archive_name.lower()
                if lower_name.endswith(".zip"):
                    is_valid = zipfile.is_zipfile(tmp_archive)
                elif lower_name.endswith((".tar.gz", ".tgz")):
                    is_valid = tarfile.is_tarfile(tmp_archive)

                if not is_valid:
                    size = tmp_archive.stat().st_size if tmp_archive.exists() else 0
                    raise RuntimeError(f"BBDown 下载内容不是有效压缩包: {archive_name} (size={size} bytes)")

                # 3. Extract to a temporary directory
                if tmp_extract_dir.exists():
                    shutil.rmtree(tmp_extract_dir, ignore_errors=True)
                tmp_extract_dir.mkdir(parents=True, exist_ok=True)
                self._extract_archive(tmp_archive, tmp_extract_dir)

                # 4. Search the extracted directory for the expected binary
                expected_binary_name = "BBDown.exe" if os.name == "nt" else "BBDown"
                found_binary_path = None
                for candidate in tmp_extract_dir.rglob("*"):
                    if candidate.is_file() and candidate.name.lower() == expected_binary_name.lower():
                        found_binary_path = candidate
                        break

                if not found_binary_path:
                    raise RuntimeError(f"在压缩包中未找到 {expected_binary_name} 可执行文件")

                # Validate binary
                found_binary_path.chmod(found_binary_path.stat().st_mode | stat.S_IEXEC)
                if found_binary_path.stat().st_size == 0:
                    raise RuntimeError(f"提取的可执行文件 {expected_binary_name} 大小为 0，无效")

                # 5. Replace active binary only after validation
                shutil.copy2(found_binary_path, current_binary)
                current_binary.chmod(current_binary.stat().st_mode | stat.S_IEXEC)

                # 6. Only write BB_DOWN_VERSION_FILE after successful install
                BB_DOWN_VERSION_FILE.write_text(latest_version, encoding="utf-8")

            except Exception as exc:
                with self.lock:
                    self.binary_state = "error"
                    self.binary_message = f"更新 BBDown 失败: {exc}"
                raise
            finally:
                if tmp_archive.exists():
                    tmp_archive.unlink(missing_ok=True)
                if tmp_extract_dir.exists():
                    shutil.rmtree(tmp_extract_dir, ignore_errors=True)

            with self.lock:
                self.binary_state = "ready"
                self.binary_version = latest_version
                self.binary_message = f"BBDown {latest_version} 已更新"

            return current_binary

    def _ensure_packaged_bbdown(
        self,
        current_binary: Path,
        *,
        force_refresh: bool,
    ) -> Path:
        current_version = ""
        if current_binary.is_file() and not force_refresh:
            current_binary.chmod(current_binary.stat().st_mode | stat.S_IEXEC)
            current_version = self._read_bbdown_version(current_binary)
            if current_version:
                self._write_bbdown_version_metadata(current_version)
                with self.lock:
                    self.binary_state = "ready"
                    self.binary_version = current_version
                    self.binary_message = f"BBDown {current_version} 已就绪（内置版本）"
                return current_binary

        vendor_binary = self._bundled_bbdown_path()
        if vendor_binary is None:
            raise RuntimeError(
                "打包版缺少内置 BBDown，无法离线修复；请重新安装应用或设置 BB_DOWN_PATH"
            )

        with self.lock:
            self.binary_state = "installing"
            self.binary_message = "正在从应用内置副本修复 BBDown"

        BB_DOWN_DIR.mkdir(parents=True, exist_ok=True)
        suffix = ".exe" if current_binary.suffix.lower() == ".exe" else ""
        temporary_binary = BB_DOWN_DIR / f".BBDown.install-{uuid.uuid4().hex}{suffix}"
        try:
            shutil.copy2(vendor_binary, temporary_binary)
            temporary_binary.chmod(temporary_binary.stat().st_mode | stat.S_IEXEC)
            installed_version = self._read_bbdown_version(temporary_binary)
            if not installed_version:
                raise RuntimeError(f"内置 BBDown 无法执行: {vendor_binary}")
            os.replace(temporary_binary, current_binary)
            self._write_bbdown_version_metadata(installed_version)
        except Exception as exc:
            temporary_binary.unlink(missing_ok=True)
            with self.lock:
                self.binary_state = "error"
                self.binary_message = f"修复 BBDown 失败: {exc}"
            raise

        with self.lock:
            self.binary_state = "ready"
            self.binary_version = installed_version
            self.binary_message = f"BBDown {installed_version} 已从应用内置副本恢复"
        return current_binary

    @staticmethod
    def _bundled_bbdown_path() -> Path | None:
        binary_name = "BBDown.exe" if os.name == "nt" else "BBDown"
        for candidate in (
            BB_DOWN_BUNDLED_PATH,
            INTERNAL_VENDOR_DIR / binary_name,
        ):
            if candidate.is_file():
                return candidate
        return None

    @staticmethod
    def _write_bbdown_version_metadata(version: str) -> None:
        BB_DOWN_VERSION_FILE.parent.mkdir(parents=True, exist_ok=True)
        temporary_path = BB_DOWN_VERSION_FILE.with_name(
            f".{BB_DOWN_VERSION_FILE.name}.write-{uuid.uuid4().hex}"
        )
        try:
            temporary_path.write_text(version, encoding="utf-8")
            os.replace(temporary_path, BB_DOWN_VERSION_FILE)
        finally:
            temporary_path.unlink(missing_ok=True)

    def _ensure_ytdlp(self) -> Path:
        with self.binary_prepare_lock:
            override = Path(YTDLP_PATH_OVERRIDE).expanduser() if YTDLP_PATH_OVERRIDE else None
            if override and override.exists():
                version = self._read_ytdlp_version(override)
                if not version:
                    raise RuntimeError(f"外部 yt-dlp 不可执行: {override}")
                with self.lock:
                    self.binary_state = "ready"
                    self.binary_version = version
                    self.binary_message = f"使用外部 yt-dlp: {override}"
                return override

            binary_path = self._local_ytdlp_binary_path()
            if not binary_path.exists():
                with self.lock:
                    self.binary_state = "installing"
                    self.binary_message = "正在下载 yt-dlp"
                try:
                    self._install_ytdlp(binary_path)
                except Exception as exc:
                    with self.lock:
                        self.binary_state = "error"
                        self.binary_message = f"下载 yt-dlp 失败: {exc}"
                    raise
            if not binary_path.exists():
                raise RuntimeError(f"未找到 yt-dlp，可将 yt-dlp 放入 {YTDLP_DIR}")
            binary_path.chmod(binary_path.stat().st_mode | stat.S_IEXEC)
            version = self._read_ytdlp_version(binary_path)
            if not version:
                raise RuntimeError(f"yt-dlp 不可执行: {binary_path}")
            with self.lock:
                self.binary_state = "ready"
                self.binary_version = version
                self.binary_message = f"yt-dlp {version} 已就绪"
            return binary_path

    def _ensure_aria2c(self) -> Path:
        with self.binary_prepare_lock:
            override = Path(ARIA2C_PATH_OVERRIDE).expanduser() if ARIA2C_PATH_OVERRIDE else None
            if override and override.exists():
                with self.lock:
                    self.binary_state = "ready"
                    version = self._read_aria2c_version(override)
                    self.binary_version = version
                    self.binary_message = f"使用外部 aria2c: {override}"
                return override

            system_path = self._system_aria2c_path()
            if system_path:
                version = self._read_aria2c_version(system_path)
                if version:
                    with self.lock:
                        self.binary_state = "ready"
                        self.binary_version = version
                        self.binary_message = f"使用系统 aria2c: {system_path}"
                    return system_path

            binary_path = self._local_aria2c_binary_path()
            local_version = self._read_aria2c_version(binary_path) if binary_path.exists() else ""
            if not local_version:
                system, arch = self._current_platform_tokens()
                if not self._aria2_auto_prepare_supported(system, arch):
                    raise RuntimeError(
                        f"未找到 aria2c。请安装 aria2c，或将可执行文件放入 {binary_path} 后再切换。"
                    )
                with self.lock:
                    self.binary_state = "installing"
                    self.binary_message = "正在下载 aria2c"
                try:
                    self._install_aria2c(binary_path)
                except Exception as exc:
                    with self.lock:
                        self.binary_state = "error"
                        self.binary_message = f"下载 aria2c 失败: {exc}"
                    raise
            if not binary_path.exists():
                raise RuntimeError(
                    f"未找到 aria2c，可将 aria2c 放入 {ARIA2C_DIR}\n"
                    f"下载地址: https://github.com/aria2/aria2/releases"
                )
            binary_path.chmod(binary_path.stat().st_mode | stat.S_IEXEC)
            version = self._read_aria2c_version(binary_path)
            if not version:
                raise RuntimeError(f"aria2c 不可执行: {binary_path}")
            with self.lock:
                self.binary_state = "ready"
                self.binary_version = version
                self.binary_message = f"aria2c {version} 已就绪"
            return binary_path

    @staticmethod
    def _local_aria2c_binary_path() -> Path:
        return ARIA2C_DIR / ("aria2c.exe" if os.name == "nt" else "aria2c")

    @staticmethod
    def _system_aria2c_path() -> Path | None:
        resolved = shutil.which("aria2c")
        if resolved:
            return Path(resolved)
        if os.name == "nt":
            return None
        for raw_path in (
            "/opt/homebrew/bin/aria2c",
            "/usr/local/bin/aria2c",
            "/opt/local/bin/aria2c",
            "/usr/bin/aria2c",
            "/bin/aria2c",
            "/snap/bin/aria2c",
        ):
            candidate = Path(raw_path)
            if candidate.exists():
                return candidate
        return None

    def _install_ytdlp(self, target_path: Path) -> None:
        try:
            release = self._fetch_ytdlp_release()
            asset = self._select_ytdlp_asset(release)
        except Exception:
            asset = self._ytdlp_fallback_asset()
        YTDLP_DIR.mkdir(parents=True, exist_ok=True)
        name = str(asset.get("name") or target_path.name)
        download_url = str(asset.get("browser_download_url") or "")
        if not download_url and not self._tool_fallback_url(name, tool="ytdlp"):
            raise RuntimeError("yt-dlp release asset missing download URL")
        if name.lower().endswith((".zip", ".tar.gz", ".tgz")):
            archive_path = YTDLP_DIR / name
            self._download_tool_asset(asset, archive_path, tool="ytdlp")
            try:
                self._extract_tool_binary_from_archive(archive_path, YTDLP_DIR, target_path.name)
            finally:
                archive_path.unlink(missing_ok=True)
        else:
            self._download_tool_asset(asset, target_path, tool="ytdlp")

    def _install_aria2c(
        self,
        target_path: Path,
        *,
        allow_brew_fallback: bool = True,
    ) -> None:
        system, arch = self._current_platform_tokens()
        if system == "linux" and shutil.which("apt-get") and shutil.which("dpkg-deb"):
            self._install_aria2_apt(target_path)
            return
        if system == "darwin":
            self._install_macos_aria2c(
                target_path,
                arch,
                allow_brew_fallback=allow_brew_fallback,
            )
            return
        try:
            release = self._fetch_aria2_release()
            asset = self._select_aria2_asset(release)
        except Exception:
            asset = self._aria2_fallback_asset()
        self._install_aria2_asset(target_path, asset)

    def _install_macos_aria2c(
        self,
        target_path: Path,
        arch: str,
        *,
        allow_brew_fallback: bool,
    ) -> None:
        # aria2 1.37.0 publishes Windows binaries but no macOS release asset.
        # The bundled, build-pinned project metadata is therefore the first
        # viable direct-download source and avoids a needless GitHub API poll.
        failures = ["official release: aria2 1.37.0 has no macOS binary asset"]

        mirror_asset = self._macos_aria2_asset("darwin", arch)
        if mirror_asset is not None:
            try:
                self._install_aria2_asset(target_path, mirror_asset)
                return
            except Exception as exc:  # noqa: BLE001
                failures.append(f"project mirror: {type(exc).__name__}: {exc}")
        else:
            failures.append("project mirror: no trusted asset metadata for this architecture")

        brew_path = self._brew_executable() if allow_brew_fallback else None
        if brew_path is not None:
            try:
                self._install_aria2_brew(target_path, brew_path=brew_path)
                version = self._read_aria2c_version(target_path)
                if not version:
                    raise RuntimeError("Homebrew aria2c did not pass version validation")
                return
            except Exception as exc:  # noqa: BLE001
                failures.append(f"Homebrew fallback: {type(exc).__name__}: {exc}")

        raise RuntimeError("macOS aria2c automatic preparation failed: " + "; ".join(failures))

    def _install_aria2_asset(self, target_path: Path, asset: dict[str, Any]) -> None:
        name = str(asset.get("name") or "")
        if not name or Path(name).name != name or not name.lower().endswith(
            (".zip", ".tar.gz", ".tgz")
        ):
            raise RuntimeError("aria2 release asset has an unsafe or unsupported name")
        download_url = str(asset.get("browser_download_url") or "")
        if not download_url and not self._tool_fallback_url(name, tool="aria2c"):
            raise RuntimeError("aria2 release asset missing download URL")

        ARIA2C_DIR.mkdir(parents=True, exist_ok=True)
        attempt_dir = ARIA2C_DIR / f".prepare-{uuid.uuid4().hex}"
        attempt_dir.mkdir(parents=True, exist_ok=False)
        archive_path = attempt_dir / name
        try:
            self._download_tool_asset(asset, archive_path, tool="aria2c")
            expected_sha256 = str(asset.get("sha256") or "").lower()
            if expected_sha256:
                actual_sha256 = hashlib.sha256(archive_path.read_bytes()).hexdigest()
                if actual_sha256 != expected_sha256:
                    raise RuntimeError(
                        f"aria2c archive SHA-256 mismatch: expected {expected_sha256}, "
                        f"got {actual_sha256}"
                    )
            extracted = self._extract_tool_binary_from_archive(
                archive_path,
                attempt_dir,
                target_path.name,
            )
            extracted.chmod(extracted.stat().st_mode | stat.S_IEXEC)
            version = self._read_aria2c_version(extracted)
            expected_version = str(asset.get("version") or "")
            if not version or expected_version and version != expected_version:
                raise RuntimeError(
                    f"aria2c version validation failed: expected "
                    f"{expected_version or 'an executable version'}, got {version or 'no version'}"
                )
            os.replace(extracted, target_path)
            target_path.chmod(target_path.stat().st_mode | stat.S_IEXEC)
        finally:
            shutil.rmtree(attempt_dir, ignore_errors=True)

    def _install_aria2_apt(self, target_path: Path) -> None:
        import tempfile
        import subprocess

        ARIA2C_DIR.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=str(ARIA2C_DIR)) as tmpdir:
            try:
                subprocess.run(
                    ["apt-get", "download", "aria2", "libaria2-0", "libssh2-1", "libc-ares2"],
                    cwd=tmpdir,
                    check=True,
                    capture_output=True,
                    text=True,
                    timeout=60,
                )
            except (subprocess.CalledProcessError, subprocess.SubprocessError):
                try:
                    subprocess.run(
                        ["apt-get", "download", "aria2", "libaria2-0"],
                        cwd=tmpdir,
                        check=True,
                        capture_output=True,
                        text=True,
                        timeout=60,
                    )
                except (subprocess.CalledProcessError, subprocess.SubprocessError):
                    try:
                        subprocess.run(
                            ["apt-get", "download", "aria2"],
                            cwd=tmpdir,
                            check=True,
                            capture_output=True,
                            text=True,
                            timeout=60,
                        )
                    except (subprocess.CalledProcessError, subprocess.SubprocessError) as exc:
                        raise RuntimeError(
                            f"apt-get download 失败: "
                            f"{getattr(exc, 'stderr', None) or getattr(exc, 'stdout', None) or str(exc)}"
                        )

            deb_files = list(Path(tmpdir).glob("*.deb"))
            if not deb_files:
                raise RuntimeError("apt-get download 成功运行但未找到 .deb 文件")

            extract_dir = Path(tmpdir) / "extracted"
            extract_dir.mkdir(parents=True, exist_ok=True)
            for deb_file in deb_files:
                try:
                    subprocess.run(
                        ["dpkg-deb", "-x", str(deb_file), str(extract_dir)],
                        check=True,
                        capture_output=True,
                        text=True,
                        timeout=60,
                    )
                except (subprocess.CalledProcessError, subprocess.SubprocessError) as exc:
                    raise RuntimeError(
                        f"dpkg-deb 解压 {deb_file.name} 失败: "
                        f"{getattr(exc, 'stderr', None) or getattr(exc, 'stdout', None) or str(exc)}"
                    )

            found_binary = None
            for candidate in extract_dir.rglob("aria2c"):
                if candidate.is_file() and not candidate.is_symlink():
                    found_binary = candidate
                    break

            if not found_binary:
                raise RuntimeError("在提取的 .deb 包中未找到 aria2c 可执行文件")

            shutil.copy2(found_binary, target_path)

            for pattern in ("libaria2.so*", "libssh2.so*", "libcares.so*"):
                for candidate in extract_dir.rglob(pattern):
                    if candidate.is_file() or candidate.is_symlink():
                        dest = target_path.parent / candidate.name
                        if candidate.is_symlink():
                            dest.unlink(missing_ok=True)
                            link_target = os.readlink(candidate)
                            os.symlink(link_target, dest)
                        else:
                            shutil.copy2(candidate, dest)

    def _install_aria2_brew(
        self,
        target_path: Path,
        *,
        brew_path: Path | None = None,
    ) -> None:
        import subprocess

        brew = str(brew_path or self._brew_executable() or "brew")
        ARIA2C_DIR.mkdir(parents=True, exist_ok=True)
        try:
            subprocess.run(
                [brew, "fetch", "--bottle", "aria2"],
                check=True,
                capture_output=True,
                text=True,
                timeout=120,
            )
        except (subprocess.CalledProcessError, subprocess.SubprocessError):
            try:
                subprocess.run(
                    [brew, "fetch", "aria2"],
                    check=True,
                    capture_output=True,
                    text=True,
                    timeout=120,
                )
            except (subprocess.CalledProcessError, subprocess.SubprocessError) as exc:
                raise RuntimeError(
                    f"brew fetch aria2 失败: "
                    f"{getattr(exc, 'stderr', None) or getattr(exc, 'stdout', None) or str(exc)}"
                )

        try:
            res = subprocess.run(
                [brew, "--cache", "--bottle", "aria2"],
                check=True,
                capture_output=True,
                text=True,
                timeout=20,
            )
            cache_path_str = res.stdout.strip()
        except (subprocess.CalledProcessError, subprocess.SubprocessError):
            try:
                res = subprocess.run(
                    [brew, "--cache", "aria2"],
                    check=True,
                    capture_output=True,
                    text=True,
                    timeout=20,
                )
                cache_path_str = res.stdout.strip()
            except (subprocess.CalledProcessError, subprocess.SubprocessError) as exc:
                raise RuntimeError(
                    f"获取 brew 缓存路径失败: "
                    f"{getattr(exc, 'stderr', None) or getattr(exc, 'stdout', None) or str(exc)}"
                )

        lines = [line.strip() for line in cache_path_str.splitlines() if line.strip()]
        if not lines:
            raise RuntimeError("brew --cache 返回空路径")
        cache_file_path = Path(lines[-1])

        if not cache_file_path.exists():
            try:
                res = subprocess.run(
                    [brew, "--cache"],
                    check=True,
                    capture_output=True,
                    text=True,
                    timeout=20,
                )
                brew_cache_dir = Path(res.stdout.strip())
            except (subprocess.CalledProcessError, subprocess.SubprocessError):
                brew_cache_dir = Path("~/Library/Caches/Homebrew").expanduser()

            candidates = []
            if brew_cache_dir.exists():
                for p in brew_cache_dir.rglob("*aria2*"):
                    if p.is_file() and p.name.endswith((".tar.gz", ".tgz", ".bottle.tar.gz")):
                        candidates.append(p)
            if candidates:
                candidates.sort(key=lambda x: x.stat().st_mtime, reverse=True)
                cache_file_path = candidates[0]
            else:
                raise RuntimeError(
                    f"Brew 缓存文件不存在于 {cache_file_path} 且未在 {brew_cache_dir} 找到替代文件"
                )

        tmp_archive = ARIA2C_DIR / "aria2_brew_bottle.tar.gz"
        try:
            shutil.copy2(cache_file_path, tmp_archive)
            self._extract_tool_binary_from_archive(tmp_archive, ARIA2C_DIR, target_path.name)
        finally:
            tmp_archive.unlink(missing_ok=True)

    def _fetch_ytdlp_release(self) -> dict:
        return self._fetch_release(YTDLP_RELEASE_API)

    def _fetch_aria2_release(self) -> dict:
        return self._fetch_release(ARIA2_RELEASE_API)

    @classmethod
    def _fetch_release(cls, api_url: str) -> dict:
        request = urllib.request.Request(
            api_url,
            headers={"User-Agent": "bilikara"},
        )
        with cls._urlopen(request, timeout=20) as response:
            return json.loads(response.read().decode("utf-8"))

    @staticmethod
    def _py_tool_fallback_url(name: str, base_url: str) -> str:
        if not base_url or not name:
            return ""
        return f"{base_url}/{urllib.parse.quote(name)}"

    @staticmethod
    def _py_fallback_tool_asset(name: str, base_url: str) -> dict[str, str]:
        if not base_url:
            raise RuntimeError("tool asset fallback base URL is not configured")
        return {
            "name": name,
            "browser_download_url": CacheManager._py_tool_fallback_url(
                name, base_url
            ),
        }

    @staticmethod
    def _py_tool_download_candidates(
        asset: dict,
        target_name: str,
        fallback_base_urls: list[str],
    ) -> list[str]:
        name = str(asset.get("name") or target_name)
        primary_url = str(asset.get("browser_download_url") or "")
        fallback_urls = [
            CacheManager._py_tool_fallback_url(name, base_url)
            for base_url in fallback_base_urls
        ]
        urls: list[str] = []
        for url in [primary_url, *fallback_urls]:
            if url and url not in urls:
                urls.append(url)
        return urls

    @staticmethod
    def _plan_tool_download_candidates(
        tool: str,
        asset: dict,
        target_name: str,
        fallback_base_urls: list[str],
    ) -> list[str]:
        name = str(asset.get("name") or target_name)
        primary_url = str(asset.get("browser_download_url") or "")
        request = {
            "schema_version": 1,
            "tool": tool,
            "asset": {
                "mode": "supplied",
                "name": name,
                "primary_url": primary_url,
            },
            "fallback_bases": [
                {"original_index": index, "base_url": base_url}
                for index, base_url in enumerate(fallback_base_urls)
            ],
        }
        completed, response = rust_backend.try_plan_tool_download_candidates(request)
        if completed and response is not None:
            return [candidate["url"] for candidate in response["candidates"]]
        return rust_backend.python_fallback(
            "plan_tool_download_candidates",
            lambda: CacheManager._py_tool_download_candidates(
                asset, target_name, fallback_base_urls
            ),
        )

    @staticmethod
    def _tool_fallback_url(name: str, *, tool: str = "bbdown") -> str:
        urls = CacheManager._plan_tool_download_candidates(
            tool,
            {"name": name, "browser_download_url": ""},
            name,
            [TOOL_ASSET_BASE_URL],
        )
        return urls[0] if urls else ""

    @staticmethod
    def _fallback_tool_asset(name: str) -> dict[str, str]:
        urls = CacheManager._plan_tool_download_candidates(
            "bbdown",
            {"name": name, "browser_download_url": ""},
            name,
            [TOOL_ASSET_BASE_URL],
        )
        if not urls:
            return CacheManager._py_fallback_tool_asset(name, TOOL_ASSET_BASE_URL)
        return {"name": name, "browser_download_url": urls[0]}

    def _download_tool_asset(
        self, asset: dict, target_path: Path, *, tool: str = "bbdown"
    ) -> None:
        name = str(asset.get("name") or target_path.name)
        urls = self._plan_tool_download_candidates(
            tool, asset, target_path.name, [TOOL_ASSET_BASE_URL]
        )
        if not urls:
            raise RuntimeError(f"tool asset {name} missing download URL")

        failures: list[tuple[str, Exception]] = []
        for url in urls:
            try:
                self._download_url(url, target_path)
                return
            except Exception as exc:  # noqa: BLE001
                failures.append((url, exc))
                target_path.unlink(missing_ok=True)

        if failures:
            error_details = []
            for idx, (url, exc) in enumerate(failures, 1):
                exc_type = type(exc).__name__
                error_details.append(f"Attempt {idx} ({url}): {exc_type}: {exc}")
            errors_str = "; ".join(error_details)
            msg = f"tool asset {name} download failed. Attempted URLs: {urls}. Failures: {errors_str}"
            raise RuntimeError(msg)
        raise RuntimeError(f"tool asset {name} download failed")

    @staticmethod
    def _current_platform_tokens() -> tuple[str, str]:
        system = platform.system().lower()
        machine = platform.machine().lower()
        if machine in {"amd64", "x86_64"}:
            arch = "x64"
        elif machine in {"i386", "i686", "x86"}:
            arch = "x86"
        elif machine in {"arm64", "aarch64"}:
            arch = "arm64"
        elif "armv7" in machine:
            arch = "armv7"
        else:
            arch = machine
        return system, arch

    def _bbdown_fallback_asset(self) -> dict[str, str]:
        system, arch = self._current_platform_tokens()
        return self._default_tool_fallback_asset("bbdown", system, arch)

    @staticmethod
    def _py_default_tool_fallback_asset(
        tool: str,
        system: str,
        arch: str,
        fallback_base_url: str,
    ) -> dict[str, str]:
        asset_names = {
            ("windows", "x64"): "BBDown_1.6.3_20240814_win-x64.zip",
            ("windows", "x86"): "BBDown_1.6.3_20240814_win-x64.zip",
            ("windows", "arm64"): "BBDown_1.6.3_20240814_win-arm64.zip",
            ("darwin", "x64"): "BBDown_1.6.3_20240814_osx-x64.zip",
            ("darwin", "arm64"): "BBDown_1.6.3_20240814_osx-arm64.zip",
            ("linux", "x64"): "BBDown_1.6.3_20240814_linux-x64.zip",
            ("linux", "arm64"): "BBDown_1.6.3_20240814_linux-arm64.zip",
        }
        if tool == "bbdown":
            name = asset_names.get((system, arch))
            if not name:
                raise RuntimeError(f"no BBDown tool fallback asset for {system}/{arch}")
            if not fallback_base_url:
                raise RuntimeError("tool asset fallback base URL is not configured")
            url = CacheManager._py_tool_fallback_url(name, fallback_base_url)
        elif tool == "ytdlp":
            if system == "windows":
                if arch == "arm64":
                    name = "yt-dlp_arm64.exe"
                elif arch == "x86":
                    name = "yt-dlp_x86.exe"
                else:
                    name = "yt-dlp.exe"
            elif system == "darwin":
                name = "yt-dlp_macos"
            elif system == "linux":
                name = "yt-dlp_linux"
            else:
                name = "yt-dlp"
            if not fallback_base_url:
                raise RuntimeError("tool asset fallback base URL is not configured")
            url = CacheManager._py_tool_fallback_url(name, fallback_base_url)
        elif tool == "aria2c":
            if system != "windows":
                raise RuntimeError(f"no aria2c fallback asset for {system}/{arch}")
            name = CacheManager._aria2_windows_fallback_asset_name(arch)
            url = (
                "https://github.com/aria2/aria2/releases/download/release-1.37.0/"
                f"{urllib.parse.quote(name)}"
            )
        else:
            raise RuntimeError(f"unknown tool candidate planner: {tool}")
        return {"name": name, "browser_download_url": url}

    @staticmethod
    def _default_tool_fallback_asset(
        tool: str,
        system: str,
        arch: str,
    ) -> dict[str, str]:
        request = {
            "schema_version": 1,
            "tool": tool,
            "asset": {
                "mode": "default_for_target",
                "platform": system,
                "arch": arch,
            },
            "fallback_bases": [
                {"original_index": 0, "base_url": TOOL_ASSET_BASE_URL}
            ],
        }
        completed, response = rust_backend.try_plan_tool_download_candidates(request)
        if completed and response is not None and response["candidates"]:
            return {
                "name": response["asset_name"],
                "browser_download_url": response["candidates"][0]["url"],
            }
        return rust_backend.python_fallback(
            "plan_tool_download_candidates",
            lambda: CacheManager._py_default_tool_fallback_asset(
                tool, system, arch, TOOL_ASSET_BASE_URL
            ),
        )

    def _ytdlp_fallback_asset(self) -> dict[str, str]:
        system, arch = self._current_platform_tokens()
        return self._default_tool_fallback_asset("ytdlp", system, arch)

    @staticmethod
    def _aria2_windows_fallback_asset_name(arch: str) -> str:
        if arch == "x86":
            return "aria2-1.37.0-win-32bit-build1.zip"
        return "aria2-1.37.0-win-64bit-build1.zip"

    @classmethod
    def _aria2_auto_prepare_supported(cls, system: str, arch: str) -> bool:
        if system == "windows":
            return True
        if system == "linux":
            return bool(shutil.which("apt-get") and shutil.which("dpkg-deb"))
        if system == "darwin":
            return bool(cls._macos_aria2_asset(system, arch) or cls._brew_executable())
        return False

    @staticmethod
    def _brew_executable() -> Path | None:
        resolved = shutil.which("brew")
        if resolved:
            return Path(resolved)
        for raw_path in ("/opt/homebrew/bin/brew", "/usr/local/bin/brew"):
            candidate = Path(raw_path)
            if candidate.is_file():
                return candidate
        return None

    @staticmethod
    def _macos_aria2_asset(system: str, arch: str) -> dict[str, str] | None:
        if system != "darwin" or arch not in {"arm64", "x64"}:
            return None
        metadata_paths = [
            ARIA2_MACOS_METADATA_PATH,
            INTERNAL_VENDOR_DIR / "aria2-macos.json",
        ]
        if PACKAGED_RUNTIME:
            metadata_paths.append(
                Path(sys.executable).resolve().parent.parent
                / "Resources"
                / "vendor"
                / "aria2-macos.json"
            )
        for metadata_path in metadata_paths:
            if not metadata_path.is_file():
                continue
            try:
                payload = json.loads(metadata_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            required = {
                "schema_version": 2,
                "tool": "aria2c",
                "provider": "bilikara-r2",
                "platform": "darwin",
                "arch": arch,
                "version": ARIA2_MACOS_VERSION,
                "source_url": ARIA2_MACOS_SOURCE_URL,
                "source_sha256": ARIA2_MACOS_SOURCE_SHA256,
            }
            if any(payload.get(key) != value for key, value in required.items()):
                continue
            name = str(payload.get("name") or "")
            url = str(payload.get("url") or "")
            sha256 = str(payload.get("sha256") or "").lower()
            recipe_revision = str(payload.get("recipe_revision") or "")
            parsed_url = urllib.parse.urlsplit(url)
            configured_base = urllib.parse.urlsplit(TOOL_ASSET_BASE_URL)
            expected_path_prefix = f"{configured_base.path.rstrip('/')}/aria2/{ARIA2_MACOS_VERSION}/"
            if (
                not name
                or Path(name).name != name
                or not name.endswith(".tar.gz")
                or not re.fullmatch(r"[0-9a-f]{64}", sha256)
                or not re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", recipe_revision)
                or parsed_url.scheme != "https"
                or not configured_base.netloc
                or parsed_url.netloc != configured_base.netloc
                or not parsed_url.path.startswith(expected_path_prefix)
                or f"/{urllib.parse.quote(recipe_revision)}/" not in parsed_url.path
                or not parsed_url.path.endswith(f"/{urllib.parse.quote(name)}")
                or parsed_url.query
                or parsed_url.fragment
            ):
                continue
            return {
                "name": name,
                "browser_download_url": url,
                "sha256": sha256,
                "version": ARIA2_MACOS_VERSION,
            }
        return None

    def _aria2_fallback_asset(self) -> dict[str, str]:
        system, arch = self._current_platform_tokens()
        return self._default_tool_fallback_asset("aria2c", system, arch)

    def _select_ytdlp_asset(self, release: dict) -> dict:
        system, arch = self._current_platform_tokens()
        if system == "windows":
            if arch == "arm64":
                preferred_names = ("yt-dlp_arm64.exe", "yt-dlp.exe")
            elif arch == "x86":
                preferred_names = ("yt-dlp_x86.exe",)
            else:
                preferred_names = ("yt-dlp.exe",)
        elif system == "darwin":
            preferred_names = ("yt-dlp_macos",)
        elif system == "linux":
            if arch == "arm64":
                preferred_names = ("yt-dlp_linux_aarch64", "yt-dlp_linux")
            elif arch == "armv7":
                preferred_names = ("yt-dlp_linux_armv7l",)
            elif arch == "x64":
                preferred_names = ("yt-dlp_linux",)
            else:
                preferred_names = ("yt-dlp",)
        else:
            preferred_names = ("yt-dlp",)
        return self._select_asset_by_name(release, preferred_names, "yt-dlp")

    def _select_aria2_asset(self, release: dict) -> dict:
        system, arch = self._current_platform_tokens()
        if system == "windows":
            preferred_fragments = ("win-32bit",) if arch == "x86" else ("win-64bit",)
        elif system == "darwin":
            preferred_fragments = ("osx-arm64", "macos-arm64", "darwin-arm64") if arch == "arm64" else (
                "osx-x64",
                "macos-x64",
                "darwin-x64",
            )
        elif system == "linux":
            preferred_fragments = ("linux-arm64", "linux-aarch64") if arch == "arm64" else ("linux-x64", "linux-amd64")
        else:
            raise RuntimeError(f"no aria2c release asset for {system}/{arch}")
        assets = release.get("assets") or []
        for fragment in preferred_fragments:
            for asset in assets:
                name = str(asset.get("name") or "").lower()
                if fragment in name and name.endswith((".zip", ".tar.gz", ".tgz")):
                    return asset
        raise RuntimeError(f"no aria2c release asset for {system}/{arch}")

    @staticmethod
    def _select_asset_by_name(release: dict, preferred_names: Iterable[str], tool_name: str) -> dict:
        assets = release.get("assets") or []
        asset_by_name = {
            str(asset.get("name") or "").lower(): asset
            for asset in assets
        }
        for preferred_name in preferred_names:
            asset = asset_by_name.get(preferred_name.lower())
            if asset:
                return asset
        raise RuntimeError(f"no {tool_name} release asset for current platform")

    @staticmethod
    def _extract_tool_binary_from_archive(archive_path: Path, output_dir: Path, binary_name: str) -> Path:
        output_dir.mkdir(parents=True, exist_ok=True)
        target_path = output_dir / binary_name
        temporary_path = output_dir / f".{binary_name}.extract-{uuid.uuid4().hex}"
        expected_name = binary_name.lower()
        try:
            lower_name = archive_path.name.lower()
            if lower_name.endswith(".zip"):
                with zipfile.ZipFile(archive_path) as zf:
                    for info in zf.infolist():
                        if not CacheManager._safe_tool_archive_member(info.filename):
                            raise RuntimeError(
                                f"unsafe archive member in {archive_path.name}: {info.filename}"
                            )
                    matches = [
                        info
                        for info in zf.infolist()
                        if not info.is_dir()
                        and PurePosixPath(info.filename.replace("\\", "/")).name.lower()
                        == expected_name
                        and not stat.S_ISLNK(info.external_attr >> 16)
                    ]
                    if len(matches) != 1:
                        raise RuntimeError(
                            f"{binary_name} not uniquely present in {archive_path.name}"
                        )
                    with zf.open(matches[0]) as source, temporary_path.open("wb") as output:
                        shutil.copyfileobj(source, output)
            elif lower_name.endswith((".tar.gz", ".tgz")):
                with tarfile.open(archive_path, "r:gz") as tf:
                    members = tf.getmembers()
                    for member in members:
                        if not CacheManager._safe_tool_archive_member(member.name):
                            raise RuntimeError(
                                f"unsafe archive member in {archive_path.name}: {member.name}"
                            )
                    matches = [
                        member
                        for member in members
                        if member.isfile()
                        and PurePosixPath(member.name.replace("\\", "/")).name.lower()
                        == expected_name
                    ]
                    if len(matches) != 1:
                        raise RuntimeError(
                            f"{binary_name} not uniquely present in {archive_path.name}"
                        )
                    source = tf.extractfile(matches[0])
                    if source is None:
                        raise RuntimeError(f"unable to read {binary_name} from {archive_path.name}")
                    with source, temporary_path.open("wb") as output:
                        shutil.copyfileobj(source, output)
            else:
                raise RuntimeError(f"unsupported archive format: {archive_path.name}")
            if not temporary_path.is_file() or temporary_path.stat().st_size <= 0:
                raise RuntimeError(f"empty {binary_name} in {archive_path.name}")
            os.replace(temporary_path, target_path)
            return target_path
        finally:
            temporary_path.unlink(missing_ok=True)

    @staticmethod
    def _safe_tool_archive_member(name: str) -> bool:
        normalized = str(name or "").replace("\\", "/")
        path = PurePosixPath(normalized)
        return bool(normalized) and not path.is_absolute() and ".." not in path.parts

    @staticmethod
    def _aria2c_env(binary_path: Path) -> dict[str, str]:
        env = os.environ.copy()
        if os.name != "nt":
            lib_dir = str(binary_path.parent)
            existing_ld = env.get("LD_LIBRARY_PATH", "")
            env["LD_LIBRARY_PATH"] = os.pathsep.join([lib_dir, existing_ld]) if existing_ld else lib_dir
        return env

    @staticmethod
    def _read_aria2c_version(binary_path: Path) -> str:
        try:
            process = subprocess.run(  # nosemgrep: python.lang.security.audit.dangerous-subprocess-use-audit
                [str(binary_path), "--version"],
                shell=False,
                capture_output=True,
                text=True,
                errors="replace",
                timeout=10,
                env=CacheManager._aria2c_env(binary_path),
                **CacheManager._hidden_process_kwargs(),
            )
            if process.returncode != 0:
                return ""
            first_line = (process.stdout or process.stderr or "").split("\n")[0].strip()
            for part in first_line.split():
                if part[0:1].isdigit() and "." in part:
                    return part
            return first_line
        except (OSError, subprocess.SubprocessError):
            return ""

    def _fetch_latest_release(self) -> dict:
        return self._fetch_release(BB_DOWN_RELEASE_API)

    @staticmethod
    def _is_ssl_certificate_error(exc: BaseException) -> bool:
        if isinstance(exc, ssl.SSLCertVerificationError):
            return True
        reason = getattr(exc, "reason", None)
        if isinstance(reason, ssl.SSLCertVerificationError):
            return True
        return "CERTIFICATE_VERIFY_FAILED" in str(exc)

    @classmethod
    def _urlopen(cls, request: urllib.request.Request | str, *, timeout: float):
        try:
            return urllib.request.urlopen(request, timeout=timeout)
        except urllib.error.URLError as exc:
            if not cls._is_ssl_certificate_error(exc):
                raise
            try:
                import certifi  # type: ignore[import-not-found]
            except Exception as certifi_exc:  # noqa: BLE001
                raise RuntimeError(
                    "Python SSL certificate verification failed. "
                    "Install system certificates or set BB_DOWN_PATH to a manually downloaded BBDown binary."
                ) from certifi_exc
            context = ssl.create_default_context(cafile=certifi.where())
            return urllib.request.urlopen(request, timeout=timeout, context=context)

    @classmethod
    def _download_url(cls, url: str, target_path: Path) -> None:
        request = urllib.request.Request(url, headers={"User-Agent": "bilikara"})
        with cls._urlopen(request, timeout=60) as response:
            target_path.write_bytes(response.read())

    def _select_asset(self, release: dict) -> dict:
        system = platform.system().lower()
        machine = platform.machine().lower()
        if system == "linux" and machine in {"x86_64", "amd64"}:
            token = "linux-x64"
        elif system == "linux" and machine in {"aarch64", "arm64"}:
            token = "linux-arm64"
        elif system == "darwin" and machine in {"x86_64", "amd64"}:
            token = "osx-x64"
        elif system == "darwin" and machine in {"arm64", "aarch64"}:
            token = "osx-arm64"
        elif system == "windows" and machine in {"x86_64", "amd64"}:
            token = "win-x64"
        elif system == "windows" and machine in {"arm64", "aarch64"}:
            token = "win-arm64"
        else:
            raise RuntimeError(f"当前平台暂未适配 BBDown 自动下载: {system}/{machine}")

        assets = release.get("assets") or []
        for asset in assets:
            name = str(asset.get("name") or "").lower()
            if token in name and (name.endswith(".zip") or name.endswith(".tar.gz")):
                return asset
        raise RuntimeError(f"没有找到适合当前平台的 BBDown 安装包: {token}")

    def _extract_archive(self, archive_path: Path, output_dir: Path) -> None:
        if archive_path.name.endswith(".zip"):
            with zipfile.ZipFile(archive_path) as zf:
                zf.extractall(output_dir)
        elif archive_path.name.endswith(".tar.gz"):
            with tarfile.open(archive_path, "r:gz") as tf:
                tf.extractall(output_dir)
        else:
            raise RuntimeError(f"不支持的 BBDown 压缩包格式: {archive_path.name}")

    def _local_binary_path(self) -> Path:
        return BB_DOWN_DIR / ("BBDown.exe" if os.name == "nt" else "BBDown")

    def _local_ytdlp_binary_path(self) -> Path:
        if os.name == "nt":
            machine = platform.machine().lower()
            if machine in {"arm64", "aarch64"}:
                arm64_path = YTDLP_DIR / "yt-dlp_arm64.exe"
                x64_path = YTDLP_DIR / "yt-dlp.exe"
                if arm64_path.exists() or not x64_path.exists():
                    return arm64_path
                return x64_path
            if machine in {"i386", "i686", "x86"}:
                x86_path = YTDLP_DIR / "yt-dlp_x86.exe"
                x64_path = YTDLP_DIR / "yt-dlp.exe"
                if x86_path.exists() or not x64_path.exists():
                    return x86_path
            return YTDLP_DIR / "yt-dlp.exe"
        return YTDLP_DIR / "yt-dlp"

    def _find_media_file(self, item_dir: Path) -> Path | None:
        return self._largest_media_file(item_dir, MEDIA_EXTENSIONS)

    @classmethod
    def _find_stream_file(cls, target_dir: Path, allowed_extensions: set[str]) -> Path | None:
        return cls._largest_media_file(target_dir, allowed_extensions)

    @staticmethod
    def _largest_media_file(root_dir: Path, allowed_extensions: set[str]) -> Path | None:
        try:
            candidate_paths = list(root_dir.rglob("*"))
        except OSError:
            return None

        media_files: list[tuple[int, Path]] = []
        for path in candidate_paths:
            try:
                if not path.is_file() or path.suffix.lower() not in allowed_extensions:
                    continue
                size = path.stat().st_size
            except OSError:
                continue
            media_files.append((size, path))

        if not media_files:
            return None
        media_files.sort(key=lambda entry: entry[0], reverse=True)
        return media_files[0][1]

    @staticmethod
    def _iter_output_messages(stream: TextIO) -> Iterator[str]:
        raw_stream = getattr(stream, "buffer", stream)
        if hasattr(raw_stream, "raw") and raw_stream.raw is not None:
            raw_stream = raw_stream.raw

        buffer = bytearray()
        last_progress: int | None = None
        last_emitted = ""
        while True:
            if hasattr(raw_stream, "read"):
                chunk = raw_stream.read(1)
            else:
                chunk = stream.read(1)

            if not chunk:
                break

            if isinstance(chunk, str):
                char_byte = chunk.encode(SUBPROCESS_OUTPUT_ENCODING, errors="replace")
            else:
                char_byte = chunk

            for b in char_byte:
                if b == ord("\b"):
                    if buffer:
                        buffer.pop()
                    continue
                if b in {ord("\r"), ord("\n")}:
                    stripped = buffer.decode(SUBPROCESS_OUTPUT_ENCODING, errors="replace").strip()
                    if stripped and stripped != last_emitted:
                        yield stripped
                        last_emitted = stripped
                    buffer = bytearray()
                    last_progress = None
                    continue
                buffer.append(b)
                decoded_buffer = buffer.decode(SUBPROCESS_OUTPUT_ENCODING, errors="replace")
                progress = CacheManager._extract_progress(CacheManager._normalize_output_line(decoded_buffer))
                if progress is not None:
                    progress_step = int(progress)
                    if progress_step != last_progress:
                        stripped = decoded_buffer.strip()
                        if stripped and stripped != last_emitted:
                            yield stripped
                            last_emitted = stripped
                        last_progress = progress_step
        if buffer:
            stripped = buffer.decode(SUBPROCESS_OUTPUT_ENCODING, errors="replace").strip()
            if stripped and stripped != last_emitted:
                yield stripped

    @staticmethod
    def _normalize_output_line(line: str) -> str:
        return ANSI_ESCAPE_RE.sub("", line).strip()

    @staticmethod
    def _display_message(line: str, progress: float | None) -> str:
        if progress is None:
            return line
        return f"缓存中 {round(progress)}%"

    @staticmethod
    def _should_force_refresh_bbdown(message: str) -> bool:
        text = str(message or "")
        return "升级到最新版本" in text or "最新版本后重试" in text

    @staticmethod
    def _extract_progress(line: str) -> float | None:
        matches = PROGRESS_RE.findall(line)
        if not matches:
            return None
        progress = float(matches[-1])
        return max(0.0, min(progress, 100.0))

    def _build_media_url(self, relative_path: str) -> str:
        return f"/media/{relative_path.replace(os.sep, '/')}"

    def _ensure_ffmpeg(self, force_refresh: bool = False) -> Path:
        with self.ffmpeg_prepare_lock:
            override = Path(FFMPEG_PATH_OVERRIDE).expanduser() if FFMPEG_PATH_OVERRIDE else None
            if override and override.exists():
                version = self._read_ffmpeg_version(override)
                if not version:
                    raise RuntimeError(f"外部 FFmpeg 不可执行: {override}")
                with self.lock:
                    self.ffmpeg_state = "ready"
                    self.ffmpeg_version = version
                    self.ffmpeg_message = f"使用外部 FFmpeg: {override}"
                return override

            with self.lock:
                self.ffmpeg_state = "checking"
                self.ffmpeg_message = "正在准备 FFmpeg"

            source_ffmpeg, source_ffprobe = self._preferred_ffmpeg_sources()
            runtime_ffmpeg = FFMPEG_RUNTIME_PATH
            runtime_ffprobe = FFPROBE_RUNTIME_PATH

            if source_ffmpeg:
                FFMPEG_TOOLS_DIR.mkdir(parents=True, exist_ok=True)
                self._sync_runtime_tool(source_ffmpeg, runtime_ffmpeg, force_refresh=force_refresh)
                if source_ffprobe:
                    self._sync_runtime_tool(source_ffprobe, runtime_ffprobe, force_refresh=force_refresh)
            elif not runtime_ffmpeg.exists():
                raise RuntimeError("未找到可用的 ffmpeg，可重新打包或设置 FFMPEG_PATH")

            version = self._read_ffmpeg_version(runtime_ffmpeg)
            if not version:
                raise RuntimeError(f"FFmpeg 不可执行: {runtime_ffmpeg}")
            with self.lock:
                self.ffmpeg_state = "ready"
                self.ffmpeg_version = version
                self.ffmpeg_message = f"FFmpeg {version} 已就绪" if version else "FFmpeg 已就绪"
            return runtime_ffmpeg

    def _preferred_ffmpeg_sources(self) -> tuple[Path | None, Path | None]:
        tool_suffix = ".exe" if os.name == "nt" else ""
        vendor_pairs = (
            (
                VENDOR_DIR / f"ffmpeg{tool_suffix}",
                VENDOR_DIR / f"ffprobe{tool_suffix}",
            ),
            (
                INTERNAL_VENDOR_DIR / f"ffmpeg{tool_suffix}",
                INTERNAL_VENDOR_DIR / f"ffprobe{tool_suffix}",
            ),
        )
        for ffmpeg_path, ffprobe_path in vendor_pairs:
            if not ffmpeg_path.exists():
                continue
            return ffmpeg_path, ffprobe_path if ffprobe_path.exists() else None

        system_ffmpeg = shutil.which("ffmpeg")
        if system_ffmpeg:
            ffprobe = shutil.which("ffprobe")
            return Path(system_ffmpeg), Path(ffprobe) if ffprobe else None
        return None, None

    @staticmethod
    def _sync_runtime_tool(source: Path, target: Path, *, force_refresh: bool) -> None:
        source_resolved = source.resolve()
        if target.exists() and not force_refresh:
            try:
                if source_resolved.samefile(target):
                    return
            except OSError:
                pass
            if target.stat().st_size == source_resolved.stat().st_size:
                return
        shutil.copy2(source_resolved, target)
        target.chmod(target.stat().st_mode | stat.S_IEXEC)

    @staticmethod
    def _read_tool_version(binary_path: Path, tool_name: str) -> str:
        if not binary_path.exists():
            return ""
        try:
            process = subprocess.run(  # nosemgrep: python.lang.security.audit.dangerous-subprocess-use-audit
                [str(binary_path), "-version"],
                shell=False,
                capture_output=True,
                text=True,
                errors="replace",
                check=False,
                timeout=10,
                **CacheManager._hidden_process_kwargs(),
            )
        except (OSError, subprocess.SubprocessError):
            return ""

        if process.returncode != 0:
            return ""

        first_line = (process.stdout or process.stderr or "").splitlines()
        if not first_line:
            return ""
        parts = first_line[0].split()
        executable_name = Path(parts[0]).name.lower()
        normalized_tool_name = tool_name.lower()
        if (
            len(parts) >= 3
            and executable_name in {normalized_tool_name, f"{normalized_tool_name}.exe"}
            and parts[1] == "version"
        ):
            return parts[2]
        return ""

    def _read_ffmpeg_version(self, binary_path: Path) -> str:
        return self._read_tool_version(binary_path, "ffmpeg")

    @staticmethod
    def _read_ytdlp_version(binary_path: Path) -> str:
        if not binary_path.exists():
            return ""
        try:
            process = subprocess.run(  # nosemgrep: python.lang.security.audit.dangerous-subprocess-use-audit
                [str(binary_path), "--version"],
                shell=False,
                capture_output=True,
                text=True,
                errors="replace",
                check=False,
                timeout=10,
                **CacheManager._hidden_process_kwargs(),
            )
        except (OSError, subprocess.SubprocessError):
            return ""
        if process.returncode != 0:
            return ""
        return (process.stdout or process.stderr or "").splitlines()[0].strip()

    @staticmethod
    def _read_bbdown_version(binary_path: Path) -> str:
        if not binary_path.exists():
            return ""
        try:
            process = subprocess.run(  # nosemgrep: python.lang.security.audit.dangerous-subprocess-use-audit
                [str(binary_path), "--help"],
                shell=False,
                capture_output=True,
                text=True,
                errors="replace",
                check=False,
                timeout=10,
                **CacheManager._hidden_process_kwargs(),
            )
        except (OSError, subprocess.SubprocessError):
            return ""
        if process.returncode != 0:
            return ""
        output = "\n".join(part for part in (process.stdout, process.stderr) if part).strip()
        match = re.search(r"(?i)\b(?:v|version\s*)?(\d+(?:\.\d+){1,3}(?:[-+._0-9A-Za-z]*)?)", output)
        return match.group(1) if match else ""
    @staticmethod
    def _bbdown_ffmpeg_path_arg(binary_path: Path) -> str:
        target = binary_path if binary_path.is_dir() else binary_path.parent
        return CacheManager._tool_arg_path(target)

    @staticmethod
    def _tool_arg_path(path: Path) -> str:
        raw = str(path)
        if os.name != "nt":
            return raw
        return CacheManager._windows_short_path(path) or raw

    @staticmethod
    def _windows_short_path(path: Path) -> str:
        try:
            raw = str(path)
            required = ctypes.windll.kernel32.GetShortPathNameW(raw, None, 0)
            if required <= 0:
                return ""
            buffer = ctypes.create_unicode_buffer(required)
            written = ctypes.windll.kernel32.GetShortPathNameW(raw, buffer, required)
            if written <= 0:
                return ""
            return buffer.value
        except Exception:
            return ""

    @staticmethod
    def _bbdown_data_path() -> Path:
        return BB_DOWN_DIR / "BBDown.data"

    @staticmethod
    def _bbdown_qr_image_path() -> Path:
        return BB_DOWN_DIR / "qrcode.png"

    def _remove_bbdown_qr_image(self) -> None:
        try:
            self._bbdown_qr_image_path().unlink(missing_ok=True)
        except OSError:
            pass

    def _notify_bbdown_login_success(self) -> None:
        if self.on_bbdown_login_success is None:
            return
        try:
            self.on_bbdown_login_success()
        except Exception:
            # Login itself succeeded; background follow-up work should not flip
            # the BBDown login state back to failed.
            pass

    # @staticmethod
    # def _extract_terminal_qr_text(output: str) -> str:
    #     lines = [ANSI_ESCAPE_RE.sub("", line).rstrip() for line in str(output or "").splitlines()]
    #     block_chars = ("█", "■", "▓", "▀", "▄")
    #     qr_lines = [line for line in lines if any(char in line for char in block_chars)]
    #     if len(qr_lines) < 8:
    #         return ""
    #     return "\n".join(qr_lines[-48:])

    # @staticmethod
    # def _terminal_qr_svg_data_url(qr_text: str) -> str:
    #     lines = [line.rstrip() for line in str(qr_text or "").splitlines() if line.rstrip()]
    #     if len(lines) < 8:
    #         return ""

    #     width = max(len(line) for line in lines)
    #     cell = 4
    #     cells_w = max(1, (width + 1) // 2)
    #     cells_h = len(lines)
    #     rects: list[str] = []
    #     dark_chars = {"█", "■", "▓", "▀", "▄"}
    #     for y, line in enumerate(lines):
    #         padded = line.ljust(width)
    #         for x in range(cells_w):
    #             chunk = padded[x * 2 : x * 2 + 2]
    #             if any(char in dark_chars for char in chunk):
    #                 rects.append(f'<rect x="{x * cell}" y="{y * cell}" width="{cell}" height="{cell}"/>')

    #     if not rects:
    #         return ""

    #     svg = (
    #         f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {cells_w * cell} {cells_h * cell}" '
    #         f'shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/>'
    #         f'<g fill="#111">{"".join(rects)}</g></svg>'
    #     )
    #     encoded = base64.b64encode(svg.encode("utf-8")).decode("ascii")
    #     return f"data:image/svg+xml;base64,{encoded}"

    @staticmethod
    def _tool_process_env(binary_path: Path, extra_tool_dirs: Iterable[Path | None] | None = None) -> dict[str, str]:
        env = os.environ.copy()
        path_entries = []
        ffmpeg_dir = CacheManager._tool_arg_path(binary_path if binary_path.is_dir() else binary_path.parent)
        if ffmpeg_dir:
            path_entries.append(ffmpeg_dir)
        for extra_dir in extra_tool_dirs or []:
            if not extra_dir:
                continue
            tool_dir = CacheManager._tool_arg_path(extra_dir)
            if tool_dir and tool_dir not in path_entries:
                path_entries.append(tool_dir)
        bbdown_dir = CacheManager._tool_arg_path(BB_DOWN_DIR)
        if bbdown_dir and bbdown_dir not in path_entries:
            path_entries.append(bbdown_dir)
        ytdlp_dir = CacheManager._tool_arg_path(YTDLP_DIR)
        if ytdlp_dir and ytdlp_dir not in path_entries:
            path_entries.append(ytdlp_dir)
        existing_path = env.get("PATH", "")
        env["PATH"] = os.pathsep.join([*path_entries, existing_path]) if existing_path else os.pathsep.join(path_entries)

        if os.name != "nt":
            lib_dirs = []
            for extra_dir in extra_tool_dirs or []:
                if extra_dir:
                    tool_dir_path = str(extra_dir)
                    if tool_dir_path not in lib_dirs:
                        lib_dirs.append(tool_dir_path)
            if lib_dirs:
                existing_ld = env.get("LD_LIBRARY_PATH", "")
                env["LD_LIBRARY_PATH"] = os.pathsep.join(lib_dirs + [existing_ld]) if existing_ld else os.pathsep.join(lib_dirs)

        return env

    @staticmethod
    def _hidden_process_kwargs() -> dict[str, Any]:
        if os.name != "nt":
            return {}

        kwargs: dict[str, Any] = {"creationflags": CREATE_NO_WINDOW}
        startupinfo_cls = getattr(subprocess, "STARTUPINFO", None)
        if startupinfo_cls is not None:
            startupinfo = startupinfo_cls()
            startupinfo.dwFlags |= STARTF_USESHOWWINDOW
            startupinfo.wShowWindow = SW_HIDE
            kwargs["startupinfo"] = startupinfo
        return kwargs

    def _item_log_path(self, item_id: str, download_source: str | None = None) -> Path:
        source = download_source or self._current_download_source()
        return self.log_dir / source / f"{item_id}.log"

    @staticmethod
    def _log_timestamp() -> str:
        return datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    def _append_log_line(self, path: Path, message: str) -> None:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8") as handle:
                handle.write(f"{message}\n")
        except OSError:
            return

    def _cleanup_orphan_cache_dirs(self, valid_ids: set[str]) -> None:
        for child in CACHE_DIR.iterdir():
            if child.name not in valid_ids:
                if child.is_dir():
                    self._safe_rmtree(child)
                else:
                    self._safe_unlink(child)
                self._remove_item_log(child.name)

    def _clear_cache_root(self) -> None:
        for child in CACHE_DIR.iterdir():
            if child.is_dir():
                self._safe_rmtree(child)
            else:
                self._safe_unlink(child)
        self._clear_log_root()

    @staticmethod
    def _path_size(path: Path) -> int:
        if not path.exists():
            return 0
        if path.is_file():
            try:
                return path.stat().st_size
            except OSError:
                return 0

        total = 0
        try:
            for child in path.rglob("*"):
                if not child.is_file():
                    continue
                try:
                    total += child.stat().st_size
                except OSError:
                    continue
        except OSError:
            return total
        return total

    @staticmethod
    def _cache_path_from_relative_path(relative_path: object) -> Path | None:
        value = str(relative_path or "").strip().replace("\\", "/")
        if not value:
            return None
        candidate = Path(value)
        if candidate.is_absolute() or ".." in candidate.parts:
            return None
        return CACHE_DIR / candidate

    @classmethod
    def _cache_path_from_media_url(cls, media_url: object) -> Path | None:
        value = str(media_url or "").strip()
        if not value:
            return None
        parsed = urllib.parse.urlparse(value)
        path = urllib.parse.unquote(parsed.path or value)
        for prefix in ("/media/", "media/"):
            if path.startswith(prefix):
                rel_path = path[len(prefix):]
                return cls._cache_path_from_relative_path(rel_path)
        return None

    def _item_cache_ready(self, item) -> bool:
        video_path = self._cache_path_from_relative_path(item.video_relative_path)
        if not video_path or not video_path.exists():
            return False

        audio_variants = [
            variant
            for variant in item.audio_variants
            if isinstance(variant, dict)
        ]
        if not audio_variants:
            return False
        for variant in audio_variants:
            audio_path = self._cache_path_from_media_url(variant.get("audio_url"))
            if not audio_path or not audio_path.exists():
                return False
        return True

    def _ensure_item_cached(self, item) -> None:
        if item.cache_status == "failed":
            return
        if self._item_cache_ready(item):
            self.store.update_item(
                item.id,
                video_media_url=self._build_media_url(item.video_relative_path) if item.video_relative_path else "",
                audio_variants=item.audio_variants,
                selected_audio_variant_id=item.selected_audio_variant_id,
                cache_status="ready",
                cache_progress=100.0,
                cache_message="缓存已完成",
                persist_backup=False,
            )
            return

        with self.lock:
            already_in_flight = item.id in self.pending_ids or self.active_item_id == item.id
        if already_in_flight:
            return

        self.store.update_item(
            item.id,
            cache_status="pending",
            cache_progress=0.0,
            cache_message="等待缓存",
            video_relative_path="",
            video_media_url="",
            audio_variants=[],
            persist_backup=False,
        )
        self._record_item_activity(item.id)
        self.enqueue(item.id)

    def _drop_item_cache(self, item_id: str, message: str) -> None:
        self._clear_item_download_progress(item_id)
        self._remove_cache_dir(item_id)
        self.store.update_item(
            item_id,
            cache_status="pending",
            cache_progress=0.0,
            cache_message=message,
            video_relative_path="",
            video_media_url="",
            audio_variants=[],
            persist_backup=False,
        )
        self._record_item_activity(item_id)

    def _remove_cache_dir(self, item_id: str) -> None:
        self._clear_item_download_progress(item_id)
        self._safe_rmtree(CACHE_DIR / item_id)
        self._remove_item_log(item_id)

    def _remove_item_log(self, item_id: str) -> None:
        for source in DOWNLOAD_SOURCE_CHOICES:
            self._safe_unlink(self.log_dir / source / f"{item_id}.log")

    def _clear_log_root(self) -> None:
        if not self.log_dir.exists():
            return
        for child in self.log_dir.iterdir():
            if child.is_file() and child.name in PERSISTENT_DIAGNOSTIC_LOG_NAMES:
                continue
            if child.is_dir():
                self._safe_rmtree(child)
            else:
                self._safe_unlink(child)

    @staticmethod
    def _safe_rmtree(path: Path) -> None:
        try:
            shutil.rmtree(path, ignore_errors=True)
        except OSError:
            return

    @staticmethod
    def _safe_unlink(path: Path) -> None:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            return

    def _record_item_activity(self, item_id: str) -> None:
        with self.lock:
            self.item_activity_at[item_id] = datetime.now().timestamp()

    def _has_retry_request(self, item_id: str) -> bool:
        with self.lock:
            return item_id in self.retry_requested_ids

    def _take_retry_request(self, item_id: str) -> bool:
        with self.lock:
            if item_id not in self.retry_requested_ids:
                return False
            self.retry_requested_ids.discard(item_id)
            return True

    def _peek_cache_interrupt_message(self, item_id: str) -> str:
        with self.lock:
            return self.cache_interrupted_messages.get(item_id, "")

    def _take_cache_interrupt_message(self, item_id: str) -> str:
        with self.lock:
            return self.cache_interrupted_messages.pop(item_id, "")

    def _raise_if_retry_requested(self, item_id: str) -> None:
        if self._take_retry_request(item_id):
            raise CacheCancelledError(RETRY_REQUESTED_MESSAGE)

    def _raise_if_priority_shift(self, item_id: str) -> None:
        if not self._should_cache(item_id):
            raise CacheCancelledError(self._outside_window_message())

    def _is_in_cache_window(self, item_id: str) -> bool:
        with self.lock:
            return item_id in self.desired_ids and not self.stop_event.is_set()

    def _should_cache(self, item_id: str) -> bool:
        with self.lock:
            if self.stop_event.is_set():
                return False
            if item_id in self.urgent_cache_ids:
                return item_id in self.desired_ids
            if item_id == self.active_item_id:
                return item_id in self.desired_ids
            if not self.ordered_desired_ids:
                return item_id in self.desired_ids
            return item_id == self.ordered_desired_ids[0]

    def _stop_active_if_not_desired(self, desired_ids: set[str]) -> None:
        with self.lock:
            item_id = self.active_item_id
            processes = self._active_processes_locked(item_id)
        if item_id and item_id not in desired_ids:
            self._terminate_processes(processes)
    def _active_processes_locked(self, item_id: str | None = None) -> list[subprocess.Popen[str]]:
        if item_id is None:
            processes = list(self.active_processes)
        else:
            processes = [
                process
                for process in self.active_processes
                if self.active_process_item_ids.get(process) == item_id
            ]
        try:
            legacy_process_is_registered = self.active_process in self.active_process_item_ids
        except TypeError:
            legacy_process_is_registered = False
        if (
            self.active_process is not None
            and self.active_process not in processes
            and (item_id is None or self.active_item_id == item_id)
            and not legacy_process_is_registered
        ):
            processes.append(self.active_process)
        return processes

    def _register_active_process(self, item_id: str, process: subprocess.Popen[str]) -> None:
        with self.lock:
            self.active_process = process
            self.active_processes.add(process)
            self.active_process_item_ids[process] = item_id

    def _unregister_active_process(self, process: subprocess.Popen[str]) -> None:
        with self.lock:
            self.active_processes.discard(process)
            self.active_process_item_ids.pop(process, None)
            if self.active_process is process:
                self.active_process = next(iter(self.active_processes), None)

    def _terminate_item_processes(self, item_id: str) -> None:
        with self.lock:
            processes = self._active_processes_locked(item_id)
        self._terminate_processes(processes)

    def _terminate_processes(
        self,
        processes: Iterable[subprocess.Popen[str] | None],
        *,
        wait: bool = False,
    ) -> None:
        seen: set[int] = set()
        for process in processes:
            if process is None:
                continue
            process_id = id(process)
            if process_id in seen:
                continue
            seen.add(process_id)
            if wait:
                self._terminate_process(process, wait=True)
            else:
                self._terminate_process(process)

    def _terminate_process(self, process: subprocess.Popen[str] | None, *, wait: bool = False) -> None:
        if not process or process.poll() is not None:
            return
        process.terminate()
        if not wait:
            # We don't block normal API calls; the worker thread will detect termination.
            return
        try:
            process.wait(timeout=3.0)
        except subprocess.TimeoutExpired:
            process.kill()
            try:
                process.wait(timeout=1.0)
            except subprocess.TimeoutExpired:
                pass

    @staticmethod
    def _bilibili_login_request_json(
        opener: urllib.request.OpenerDirector,
        url: str,
    ) -> dict[str, Any]:
        request = urllib.request.Request(
            url,
            headers={
                "User-Agent": BILIBILI_HEADERS["User-Agent"],
                "Referer": "https://www.bilibili.com/",
            },
            method="GET",
        )
        with opener.open(request, timeout=15) as response:
            payload = json.loads(response.read().decode("utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("Bilibili login response is not an object")
        return payload

    @staticmethod
    def _sanitized_bilibili_login_error(exc: BaseException) -> str:
        message = " ".join(str(exc).split())

        def sanitize_url(match: re.Match[str]) -> str:
            raw_url = match.group(0)
            trailing = ""
            while raw_url and raw_url[-1] in ".,)]}":
                trailing = raw_url[-1] + trailing
                raw_url = raw_url[:-1]
            parsed = urllib.parse.urlsplit(raw_url)
            sanitized = urllib.parse.urlunsplit(
                (parsed.scheme, parsed.netloc, parsed.path, "<redacted>" if parsed.query else "", "")
            )
            return sanitized + trailing

        message = BILIBILI_LOGIN_URL_RE.sub(sanitize_url, message)
        message = BILIBILI_LOGIN_SENSITIVE_FIELD_RE.sub(
            lambda match: f"{match.group(1)}<redacted>",
            message,
        )
        return message[:500] if message else "(no exception message)"

    def _log_bilibili_login_failure(self, stage: str, exc: BaseException) -> None:
        safe_stage = re.sub(r"[^a-z0-9_-]+", "-", stage.lower()).strip("-") or "unknown"
        safe_message = self._sanitized_bilibili_login_error(exc)
        self._append_log_line(
            self.log_dir / BILIBILI_LOGIN_LOG_NAME,
            f"[{self._log_timestamp()}] QR login failure: stage={safe_stage} "
            f"type={type(exc).__name__} message={safe_message}",
        )

    @staticmethod
    def _write_bbdown_login_qr(qr_url: str, target_path: Path) -> str:
        try:
            import qrcode  # type: ignore[import-not-found]
        except ImportError as exc:
            raise RuntimeError("缺少本地二维码组件，请重新安装或更新 bilikara") from exc

        target_path.parent.mkdir(parents=True, exist_ok=True)
        qrcode.make(qr_url).save(target_path)
        target_path.chmod(0o600)
        encoded = base64.b64encode(target_path.read_bytes()).decode("ascii")
        return f"data:image/png;base64,{encoded}"

    @staticmethod
    def _cookie_text_from_login_jar(cookie_jar: http.cookiejar.CookieJar) -> str:
        pairs: dict[str, str] = {}
        for cookie in cookie_jar:
            name = str(cookie.name or "").strip()
            value = str(cookie.value or "").strip()
            if name and value:
                pairs[name] = value

        lower_names = {name.lower(): name for name in pairs}
        if "sessdata" not in lower_names or "bili_jct" not in lower_names:
            return ""

        ordered_names: list[str] = []
        for preferred in BILIBILI_LOGIN_COOKIE_ORDER:
            actual = lower_names.get(preferred.lower())
            if actual and actual not in ordered_names:
                ordered_names.append(actual)
        return "; ".join(f"{name}={pairs[name]}" for name in ordered_names)

    def _save_bbdown_login_cookie(self, cookie_text: str) -> bool:
        data_path = self._bbdown_data_path()
        temporary_path = data_path.with_name(f".{data_path.name}.login.tmp")
        try:
            data_path.parent.mkdir(parents=True, exist_ok=True)
            temporary_path.write_text(cookie_text, encoding="utf-8")
            temporary_path.chmod(0o600)
            os.replace(temporary_path, data_path)
            data_path.chmod(0o600)
        except OSError:
            try:
                temporary_path.unlink(missing_ok=True)
            except OSError:
                pass
            return False
        return bool(cookie_from_bbdown_data(data_path))

    def _bbdown_login_worker(
        self,
        cancel_event: threading.Event | None = None,
        generation: int | None = None,
    ) -> None:
        cancel_event = cancel_event or threading.Event()
        with self.lock:
            if self.bbdown_login_cancel_event is None:
                self.bbdown_login_cancel_event = cancel_event
            if generation is None:
                generation = self.bbdown_login_generation
            if generation is None:
                generation = rust_runtime.begin_bilibili_login(
                    message="正在启动 BBDown 登录"
                )
                self.bbdown_login_generation = generation

        login_succeeded = False
        notify_success = False
        failure_message = "Bilibili 登录失败，请重试"
        cookie_jar = http.cookiejar.CookieJar()
        opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(cookie_jar)
        )
        login_stage = "generate"

        try:
            generated = self._bilibili_login_request_json(
                opener,
                BILIBILI_QR_GENERATE_URL,
            )
            generated_data = generated.get("data")
            if not isinstance(generated_data, dict):
                raise ValueError("Bilibili QR response has no data object")
            qr_url = str(generated_data.get("url") or "").strip()
            qr_key = str(generated_data.get("qrcode_key") or "").strip()
            if not qr_url or not qr_key:
                raise ValueError("Bilibili QR response is incomplete")

            login_stage = "render-qr"
            qr_image = self._write_bbdown_login_qr(
                qr_url,
                self._bbdown_qr_image_path(),
            )
            with self.lock:
                if (
                    self.bbdown_login_cancel_event is not cancel_event
                    or self.bbdown_login_generation != generation
                ):
                    return
                if not rust_runtime.set_bilibili_login_status(
                    "waiting",
                    message="请使用哔哩哔哩 App 扫码登录",
                    qr_image=qr_image,
                    generation=generation,
                ):
                    return

            while not cancel_event.wait(1.0):
                login_stage = "poll"
                query = urllib.parse.urlencode(
                    {"qrcode_key": qr_key, "source": "main-fe-header"}
                )
                polled = self._bilibili_login_request_json(
                    opener,
                    f"{BILIBILI_QR_POLL_URL}?{query}",
                )
                poll_data = polled.get("data")
                if not isinstance(poll_data, dict):
                    raise ValueError("Bilibili QR poll response has no data object")
                code = int(poll_data.get("code", -1))
                if code == BILIBILI_QR_WAITING_SCAN:
                    continue
                if code == BILIBILI_QR_WAITING_CONFIRMATION:
                    with self.lock:
                        if (
                            self.bbdown_login_cancel_event is cancel_event
                            and self.bbdown_login_generation == generation
                        ):
                            rust_runtime.set_bilibili_login_status(
                                "waiting",
                                message="扫码成功，请在哔哩哔哩 App 中确认",
                                qr_image=qr_image,
                                generation=generation,
                            )
                    continue
                if code == BILIBILI_QR_EXPIRED:
                    failure_message = "二维码已过期，请重新生成"
                    break
                if code != 0:
                    break

                with self.lock:
                    if (
                        cancel_event.is_set()
                        or self.bbdown_login_cancel_event is not cancel_event
                    ):
                        return

                cookie_text = self._cookie_text_from_login_jar(cookie_jar)
                if not cookie_text:
                    failure_message = (
                        "Bilibili 登录完成，但响应中未检测到有效的 "
                        "SESSDATA 和 bili_jct"
                    )
                    break
                login_stage = "save-cookie"
                if not self._save_bbdown_login_cookie(cookie_text):
                    failure_message = "Bilibili 登录完成，但 Cookie 保存或验证失败"
                    break
                login_succeeded = True
                break
        except (OSError, ValueError, json.JSONDecodeError, urllib.error.URLError) as exc:
            self._log_bilibili_login_failure(login_stage, exc)
            failure_message = "Bilibili 登录请求失败，请重试"
        except RuntimeError as exc:
            self._log_bilibili_login_failure(login_stage, exc)
            failure_message = str(exc)
        except Exception as exc:  # noqa: BLE001 - never expose login response details
            self._log_bilibili_login_failure(login_stage, exc)
            failure_message = "Bilibili 登录请求失败，请重试"
        finally:
            with self.lock:
                is_current_login = self.bbdown_login_cancel_event is cancel_event
                is_current_login = (
                    is_current_login
                    and self.bbdown_login_generation == generation
                )
                if is_current_login:
                    self.bbdown_login_cancel_event = None
                    self.bbdown_login_generation = None
                    self._remove_bbdown_qr_image()
                    if cancel_event.is_set():
                        rust_runtime.reset_bilibili_login_status()
                    elif login_succeeded:
                        notify_success = rust_runtime.set_bilibili_login_status(
                            "logged_in",
                            message="BBDown 已登录",
                            generation=generation,
                        )
                    else:
                        rust_runtime.set_bilibili_login_status(
                            "failed",
                            message=failure_message,
                            generation=generation,
                        )

        if notify_success:
            self._notify_bbdown_login_success()

    def _outside_window_message(self) -> str:
        if self.max_cache_items <= 0:
            return "已禁用自动缓存"
        return f"仅自动缓存前 {self.max_cache_items} 首，已释放本地缓存"

    def _waiting_message(self) -> str:
        if self.max_cache_items <= 0:
            return "已禁用自动缓存"
        return "等待缓存"

    def _prewarm_binary_worker(self) -> None:
        try:
            with self.lock:
                if self.ffmpeg_state == "idle":
                    self.ffmpeg_state = "checking"
                    self.ffmpeg_message = "后台准备 FFmpeg 中"
            self._ensure_ffmpeg(force_refresh=True)
        except Exception as exc:  # noqa: BLE001
            with self.lock:
                self.ffmpeg_state = "failed"
                self.ffmpeg_message = f"FFmpeg 准备失败: {exc}"

        try:
            with self.lock:
                if self.binary_state == "idle":
                    self.binary_state = "checking"
                    self.binary_message = "后台准备 BBDown 中"
            self._ensure_bbdown()
        except Exception as exc:  # noqa: BLE001
            with self.lock:
                self.binary_state = "failed"
                self.binary_message = f"BBDown 准备失败: {exc}"
