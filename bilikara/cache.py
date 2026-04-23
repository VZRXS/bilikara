from __future__ import annotations

import base64
from datetime import datetime
import json
import os
import platform
import queue
import re
import shutil
import stat
import subprocess
import tarfile
import threading
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path
from typing import Any, Callable, Iterator, TextIO

from .config import (
    BB_DOWN_DIR,
    BB_DOWN_PATH_OVERRIDE,
    BB_DOWN_RELEASE_API,
    BB_DOWN_VERSION_FILE,
    CACHE_DIR,
    CACHE_POLICY_FILE,
    # COOKIE,
    FFMPEG_BUNDLED_PATH,
    FFMPEG_RUNTIME_PATH,
    FFMPEG_PATH_OVERRIDE,
    FFMPEG_TOOLS_DIR,
    FFPROBE_RUNTIME_PATH,
    INTERNAL_VENDOR_DIR,
    LOG_DIR,
    MAX_CACHE_ITEMS,
    VENDOR_DIR,
)
from .bilibili import effective_bilibili_cookie
from .store import PlaylistStore

MEDIA_EXTENSIONS = {".mp4", ".mkv", ".webm", ".flv", ".m4v"}
AUDIO_EXTENSIONS = {".m4a", ".aac", ".mp3", ".flac", ".ogg", ".opus", ".wav"}
PROGRESS_RE = re.compile(r"(\d{1,3}(?:\.\d+)?)\s*%")
ANSI_ESCAPE_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
CACHE_LIMIT_CHOICES = (1, 2, 3, 4, 5)
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
    "1080P 60帧",
    "1080P 高码率",
    "1080P 高清",
    "720P 60帧",
    "720P 高清",
    "480P 清晰",
    "360P 流畅",
)
DEFAULT_VIDEO_QUALITY = "1080P 60帧"
DEFAULT_AUDIO_HIRES = True


class CacheCancelledError(RuntimeError):
    pass


class DownloadCommandError(RuntimeError):
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
        self.on_bbdown_login_success = on_bbdown_login_success
        self.tasks: "queue.Queue[str]" = queue.Queue()
        self.pending_ids: set[str] = set()
        self.desired_ids: set[str] = set()
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
        self.active_item_id: str | None = None
        self.item_activity_at: dict[str, float] = {}
        self.retry_requested_ids: set[str] = set()
        self.log_dir = LOG_DIR / "bbdown"
        self.bbdown_login_process: subprocess.Popen[str] | None = None
        self.bbdown_login_state = "idle"
        self.bbdown_login_message = "未登录"
        # self.bbdown_login_qr_text = ""
        self.bbdown_login_qr_image = ""
        self._load_cache_policy()
        self.worker = threading.Thread(target=self._worker_loop, daemon=True)
        self.worker.start()

    def status(self, metrics: dict[str, Any] | None = None) -> dict:
        cache_metrics = metrics or self.cache_metrics()
        login_status = self.bbdown_login_status()
        with self.lock:
            return {
                "state": self.binary_state,
                "version": self.binary_version,
                "message": self.binary_message,
                "max_cache_items": self.max_cache_items,
                "cache_bytes": cache_metrics["total_bytes"],
                "cached_items": cache_metrics["item_count"],
                "logged_in": login_status["logged_in"],
                "login": login_status,
            }

    def ffmpeg_status(self) -> dict[str, Any]:
        with self.lock:
            return {
                "state": self.ffmpeg_state,
                "version": self.ffmpeg_version,
                "message": self.ffmpeg_message,
                "path": str(FFMPEG_RUNTIME_PATH),
            }

    def bbdown_login_status(self) -> dict[str, Any]:
        logged_in = self._bbdown_data_path().exists()
        with self.lock:
            if logged_in:
                state = "logged_in"
                message = "BBDown 已登录"
            else:
                state = self.bbdown_login_state
                message = self.bbdown_login_message
            return {
                "logged_in": logged_in,
                "state": state,
                "message": message,
                "data_path": str(self._bbdown_data_path()),
                # "qr_text": "" if logged_in else self.bbdown_login_qr_text,
                "qr_image": "" if logged_in else self.bbdown_login_qr_image,
            }

    def start_bbdown_login(self, *, force_refresh_qr: bool = False) -> dict[str, Any]:
        if self._bbdown_data_path().exists():
            return self.bbdown_login_status()
        process_to_stop: subprocess.Popen[str] | None = None
        with self.lock:
            if self.bbdown_login_process and self.bbdown_login_process.poll() is None and not force_refresh_qr:
                return self.bbdown_login_status()
            if self.bbdown_login_process and self.bbdown_login_process.poll() is None:
                process_to_stop = self.bbdown_login_process
                self.bbdown_login_process = None
            self.bbdown_login_state = "starting"
            self.bbdown_login_message = "正在启动 BBDown 登录"
            # self.bbdown_login_qr_text = ""
            self.bbdown_login_qr_image = ""
        self._terminate_process(process_to_stop)
        self._remove_bbdown_qr_image()
        threading.Thread(target=self._bbdown_login_worker, daemon=True).start()
        return self.bbdown_login_status()

    def logout_bbdown(self) -> dict[str, Any]:
        with self.lock:
            process = self.bbdown_login_process
            self.bbdown_login_process = None
        self._terminate_process(process)
        self._remove_bbdown_qr_image()
        try:
            self._bbdown_data_path().unlink(missing_ok=True)
        except OSError as exc:
            with self.lock:
                self.bbdown_login_state = "failed"
                self.bbdown_login_message = f"退出登录失败: {exc}"
            return self.bbdown_login_status()
        with self.lock:
            self.bbdown_login_state = "idle"
            self.bbdown_login_message = "未登录"
            # self.bbdown_login_qr_text = ""
            self.bbdown_login_qr_image = ""
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
                "clear_on_exit": True,
                "usage_bytes": cache_metrics["total_bytes"],
                "cached_item_count": cache_metrics["item_count"],
            }

    def enrich_snapshot(
        self,
        payload: dict[str, Any],
        metrics: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        cache_metrics = metrics or self.cache_metrics()
        item_bytes = cache_metrics["item_bytes"]

        current_item = payload.get("current_item")
        if isinstance(current_item, dict):
            current_item["cache_size_bytes"] = int(item_bytes.get(str(current_item.get("id") or ""), 0))
            current_item["cache_activity_at"] = float(
                self.item_activity_at.get(str(current_item.get("id") or ""), 0.0)
            )

        playlist = payload.get("playlist")
        if isinstance(playlist, list):
            for item in playlist:
                if isinstance(item, dict):
                    item["cache_size_bytes"] = int(item_bytes.get(str(item.get("id") or ""), 0))
                    item["cache_activity_at"] = float(
                        self.item_activity_at.get(str(item.get("id") or ""), 0.0)
                    )
        return payload

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
    ) -> dict[str, Any]:
        changed = False
        cache_limit_changed = False
        with self.lock:
            if max_cache_items is not None:
                bounded = self._bounded_cache_items(max_cache_items)
                if self.max_cache_items != bounded:
                    self.max_cache_items = bounded
                    changed = True
                    cache_limit_changed = True
            if video_quality is not None:
                normalized_quality = self._normalize_video_quality(video_quality)
                if self.video_quality != normalized_quality:
                    self.video_quality = normalized_quality
                    changed = True
            if audio_hires is not None:
                normalized_hires = bool(audio_hires)
                if self.audio_hires != normalized_hires:
                    self.audio_hires = normalized_hires
                    changed = True

            if changed:
                self._save_cache_policy_locked()

        if cache_limit_changed:
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

    def _save_cache_policy_locked(self) -> None:
        payload = {
            "max_cache_items": self.max_cache_items,
            "video_quality": self.video_quality,
            "audio_hires": self.audio_hires,
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
    def _normalize_video_quality(video_quality: object) -> str:
        value = str(video_quality or "").strip()
        if value in VIDEO_QUALITY_CHOICES:
            return value
        return DEFAULT_VIDEO_QUALITY

    def cache_metrics(self) -> dict[str, Any]:
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
        self._clear_cache_root()
        with self.lock:
            self.item_activity_at.clear()
            self.retry_requested_ids.clear()
        for item in self.store.list_items():
            self.store.update_item(
                item.id,
                cache_status="pending",
                cache_progress=0.0,
                cache_message=self._waiting_message(),
                video_relative_path="",
                video_media_url="",
                audio_variants=[],
                selected_audio_variant_id="",
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
            process = self.active_process
        self._terminate_process(process)
        self._clear_cache_root()
        with self.lock:
            self.item_activity_at.clear()
            self.retry_requested_ids.clear()
        for item in self.store.list_items():
            self.store.update_item(
                item.id,
                cache_status="pending",
                cache_progress=0.0,
                cache_message="缓存已在退出时清空",
                video_relative_path="",
                video_media_url="",
                audio_variants=[],
                selected_audio_variant_id="",
                persist_backup=False,
            )
            self._record_item_activity(item.id)

    def clear_runtime_cache(self) -> None:
        with self.lock:
            process = self.active_process
            self.pending_ids.clear()
            self.desired_ids.clear()
            self.retry_requested_ids.clear()
            self.item_activity_at.clear()
            self.active_process = None
            self.active_item_id = None
            while True:
                try:
                    self.tasks.get_nowait()
                except queue.Empty:
                    break
        self._terminate_process(process)
        self._clear_cache_root()

    def retry_item(self, item_id: str, *, force: bool = False) -> None:
        item = self.store.get_item(item_id)
        if not item:
            raise ValueError("没有找到要重新下载的歌曲")
        if item.cache_status == "ready" and not force:
            raise ValueError("这首歌已经缓存完成，无需重新下载")
        if item.cache_status not in {"downloading", "failed", "ready", "pending", "queued"}:
            raise ValueError("当前缓存状态不能重新下载")
        if not self._should_cache(item_id):
            raise ValueError("当前不在自动缓存窗口中")

        log_path = self._item_log_path(item_id)
        self._append_log_line(log_path, f"[{self._log_timestamp()}] manual retry requested")

        with self.lock:
            active_process = self.active_process if self.active_item_id == item_id else None
            in_flight = item_id in self.pending_ids or self.active_item_id == item_id
            if in_flight:
                self.retry_requested_ids.add(item_id)

        self.store.update_item(
            item_id,
            cache_status="pending",
            cache_progress=0.0,
            cache_message="准备重新下载",
            video_relative_path="",
            video_media_url="",
            audio_variants=[],
            selected_audio_variant_id="",
            persist_backup=False,
        )
        self._record_item_activity(item_id)

        if in_flight:
            if active_process is not None:
                self._terminate_process(active_process)
            return

        self._remove_cache_dir(item_id)
        self.enqueue(item_id)

    def sync_with_playlist(self) -> None:
        items = self.store.list_items()
        desired_ids = {item.id for item in items[: self.max_cache_items]} if self.max_cache_items > 0 else set()
        current_ids = {item.id for item in items}
        with self.lock:
            self.desired_ids = desired_ids

        self._cleanup_orphan_cache_dirs(current_ids)
        self._stop_active_if_not_desired(desired_ids)

        for item in items:
            if item.id in desired_ids:
                self._ensure_item_cached(item)
            else:
                self._drop_item_cache(item.id, self._outside_window_message())

    def enqueue(self, item_id: str) -> None:
        with self.lock:
            if item_id in self.pending_ids or self.stop_event.is_set():
                return
            self.pending_ids.add(item_id)
        self.tasks.put(item_id)

    def _worker_loop(self) -> None:
        while not self.stop_event.is_set():
            try:
                item_id = self.tasks.get(timeout=0.5)
            except queue.Empty:
                continue
            try:
                self._cache_item(item_id)
            finally:
                with self.lock:
                    self.pending_ids.discard(item_id)
                self.tasks.task_done()

    def _cache_item(self, item_id: str, allow_refresh_retry: bool = True) -> None:
        if self.stop_event.is_set() or not self._should_cache(item_id):
            return
        if self._take_retry_request(item_id):
            self._remove_cache_dir(item_id)
        item = self.store.get_item(item_id)
        if not item:
            self._remove_cache_dir(item_id)
            return
        # Current cache flow keeps video and audio tracks separate so the host
        # can switch audio variants without remuxing a single output file.
        self._cache_item_multi(item_id, item, allow_refresh_retry=allow_refresh_retry)

    def _cache_item_multi(self, item_id: str, item, *, allow_refresh_retry: bool) -> None:
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
        log_path = self._item_log_path(item_id)
        self._append_log_line(log_path, "")
        self._append_log_line(log_path, f"[{self._log_timestamp()}] start cache: {item.display_title}")

        try:
            binary_path = self._ensure_bbdown()
        except Exception as exc:  # noqa: BLE001
            self.store.update_item(
                item_id,
                cache_status="failed",
                cache_message=f"BBDown 不可用: {exc}",
                persist_backup=False,
            )
            return

        try:
            ffmpeg_path = self._ensure_ffmpeg(force_refresh=False)
        except Exception as exc:  # noqa: BLE001
            self._append_log_line(log_path, f"[{self._log_timestamp()}] ffmpeg unavailable: {exc}")
            self.store.update_item(
                item_id,
                cache_status="failed",
                cache_message=f"FFmpeg 不可用: {exc}",
                persist_backup=False,
            )
            return

        if not self._should_cache(item_id):
            return

        self.store.update_item(
            item_id,
            cache_status="downloading",
            cache_message=self._cache_start_message(item),
            persist_backup=False,
        )
        self._record_item_activity(item_id)

        try:
            cache_result = self._download_selected_streams(item, binary_path, ffmpeg_path, item_dir, log_path)
            self._raise_if_retry_requested(item_id)
            self._validate_cache_result(item.id, cache_result, ffmpeg_path, log_path)
            self._raise_if_retry_requested(item_id)
        except CacheCancelledError as exc:
            if str(exc) == RETRY_REQUESTED_MESSAGE:
                self._append_log_line(log_path, f"[{self._log_timestamp()}] restarting cache by manual request")
                self._remove_cache_dir(item_id)
                fresh_item = self.store.get_item(item_id)
                if fresh_item and self._should_cache(item_id):
                    self._cache_item_multi(item_id, fresh_item, allow_refresh_retry=allow_refresh_retry)
                return
            self._append_log_line(log_path, f"[{self._log_timestamp()}] cancelled: {exc}")
            self._drop_item_cache(item_id, str(exc))
            return
        except DownloadCommandError as exc:
            if self._take_retry_request(item_id):
                self._append_log_line(log_path, f"[{self._log_timestamp()}] restarting cache by manual request")
                self._remove_cache_dir(item_id)
                fresh_item = self.store.get_item(item_id)
                if fresh_item and self._should_cache(item_id):
                    self._cache_item_multi(item_id, fresh_item, allow_refresh_retry=allow_refresh_retry)
                return
            last_message = str(exc)
            if allow_refresh_retry and self._should_force_refresh_bbdown(last_message):
                self._append_log_line(
                    log_path,
                    f"[{self._log_timestamp()}] detected stale BBDown hint, forcing refresh and retry",
                )
                try:
                    self._ensure_bbdown(force_refresh=True)
                    shutil.rmtree(item_dir, ignore_errors=True)
                    item_dir.mkdir(parents=True, exist_ok=True)
                    self._cache_item_multi(item_id, item, allow_refresh_retry=False)
                    return
                except Exception as refresh_exc:  # noqa: BLE001
                    self._append_log_line(
                        log_path,
                        f"[{self._log_timestamp()}] forced BBDown refresh failed: {refresh_exc}",
                    )
            self._append_log_line(log_path, f"[{self._log_timestamp()}] failed: {last_message}")
            self.store.update_item(
                item_id,
                cache_status="failed",
                cache_message=f"缓存失败: {last_message}",
                persist_backup=False,
            )
            self._record_item_activity(item_id)
            return

        video_file = cache_result["video_file"]
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
    ) -> dict[str, object]:
        selected_pages = self._selected_pages_for_item(item)
        video_page = item.video_page if item.video_page in selected_pages else selected_pages[0]
        download_stage_count = len(selected_pages) + 1

        video_file = self._download_page_stream(
            item,
            binary_path,
            ffmpeg_path,
            item_dir,
            log_path,
            page=video_page,
            stream_kind="video",
            stage_index=0,
            stage_count=download_stage_count,
        )

        audio_files: list[tuple[int, Path, str]] = []
        for stage_offset, page in enumerate(selected_pages, start=1):
            audio_files.append(
                (
                    page,
                    self._download_page_stream(
                        item,
                        binary_path,
                        ffmpeg_path,
                        item_dir,
                        log_path,
                        page=page,
                        stream_kind="audio",
                        stage_index=stage_offset,
                        stage_count=download_stage_count,
                    ),
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
            },
            *[
                {
                    "label": f"音轨 P{page}",
                    "path": audio_file,
                    "required_streams": {"audio"},
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
        return {
            "video_file": video_file,
            "video_relative_path": str(video_file.relative_to(CACHE_DIR)),
            "video_media_url": self._build_media_url(str(video_file.relative_to(CACHE_DIR))),
            "audio_variants": audio_variants,
            "selected_audio_variant_id": selected_audio_variant_id,
            "validation_files": validation_files,
        }

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
        stage_index: int,
        stage_count: int,
    ) -> Path:
        page_url = self._page_url(item.resolved_url, page)
        target_dir = item_dir / f"{stream_kind}-p{page}"
        target_dir.mkdir(parents=True, exist_ok=True)
        preference_args = self._bbdown_stream_preference_args(stream_kind)

        command = [
            str(binary_path),
            page_url,
            "-p",
            str(page),
            *preference_args,
            "--work-dir",
            str(target_dir),
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

        label = "视频轨" if stream_kind == "video" else "音轨"
        stage_label = f"下载{label} P{page}"
        self._run_item_command(
            item.id,
            command,
            ffmpeg_path,
            log_path,
            stage_label=stage_label,
            stage_index=stage_index,
            stage_count=stage_count,
        )

        allowed_extensions = MEDIA_EXTENSIONS if stream_kind == "video" else AUDIO_EXTENSIONS
        self._raise_if_retry_requested(item.id)
        stream_file = self._find_stream_file(target_dir, allowed_extensions)
        if not stream_file:
            raise DownloadCommandError(f"{stage_label} 完成后未找到输出文件")
        return stream_file

    def _bbdown_stream_preference_args(self, stream_kind: str) -> list[str]:
        with self.lock:
            video_quality = self.video_quality
            audio_hires = self.audio_hires
        if stream_kind == "video":
            return ["-q", self._video_quality_priority(video_quality)]
        if stream_kind == "audio" and not audio_hires:
            # BBDown 1.6.x does not expose a direct "highest non-Hi-Res"
            # selector. The closest safe fallback is to prefer the smaller
            # audio stream when Hi-Res is disabled.
            return ["--audio-ascending"]
        return []

    @staticmethod
    def _video_quality_priority(video_quality: object) -> str:
        normalized_quality = CacheManager._normalize_video_quality(video_quality)
        start_index = VIDEO_QUALITY_CHOICES.index(normalized_quality)
        return ",".join(VIDEO_QUALITY_CHOICES[start_index:])

    def _run_item_command(
        self,
        item_id: str,
        command: list[str],
        ffmpeg_path: Path,
        log_path: Path,
        *,
        stage_label: str,
        stage_index: int,
        stage_count: int,
    ) -> None:
        progress_start = 94.0 * stage_index / max(stage_count, 1)
        progress_span = 94.0 / max(stage_count, 1)
        self._append_log_line(log_path, f"[{self._log_timestamp()}] command: {json.dumps(command, ensure_ascii=False)}")

        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding=SUBPROCESS_OUTPUT_ENCODING,
            errors="replace",
            bufsize=1,
            cwd=str(BB_DOWN_DIR),
            env=self._tool_process_env(ffmpeg_path),
            **self._hidden_process_kwargs(),
        )
        last_message = stage_label
        with self.lock:
            self.active_process = process
            self.active_item_id = item_id
        try:
            assert process.stdout is not None
            for raw_line in self._iter_output_messages(process.stdout):
                line = self._normalize_output_line(raw_line)
                if not line:
                    continue
                last_message = line
                self._append_log_line(log_path, f"[{self._log_timestamp()}] {line}")
                self._record_item_activity(item_id)
                progress = self._extract_progress(line)
                changes = {"cache_message": self._display_stage_message(stage_label, line, progress)}
                if progress is not None:
                    changes["cache_progress"] = progress_start + (progress / 100.0) * progress_span
                self.store.update_item(item_id, persist_backup=False, **changes)
                if self.stop_event.is_set():
                    self._terminate_process(process)
                    raise CacheCancelledError("缓存已停止")
                if not self._should_cache(item_id):
                    self._terminate_process(process)
                    raise CacheCancelledError(self._outside_window_message())
            return_code = process.wait()
        finally:
            with self.lock:
                if self.active_process is process:
                    self.active_process = None
                    self.active_item_id = None

        if self._take_retry_request(item_id):
            raise CacheCancelledError(RETRY_REQUESTED_MESSAGE)

        if return_code != 0:
            raise DownloadCommandError(last_message)

        self.store.update_item(
            item_id,
            cache_progress=progress_start + progress_span,
            cache_message=f"{stage_label} 完成",
            persist_backup=False,
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

        ffprobe_path = self._ffprobe_path_for_ffmpeg(ffmpeg_path)
        if not ffprobe_path:
            self._append_log_line(
                log_path,
                f"[{self._log_timestamp()}] ffprobe validate: skipped, ffprobe unavailable",
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

        for entry in validation_files:
            self._raise_if_retry_requested(item_id)
            if not isinstance(entry, dict):
                continue
            path = entry.get("path")
            label = str(entry.get("label") or "媒体文件")
            required_streams = entry.get("required_streams")
            if not isinstance(path, Path):
                raise DownloadCommandError(f"缓存校验失败: {label} 路径无效")
            if not isinstance(required_streams, set):
                required_streams = set(required_streams or [])
            self._validate_media_file(
                ffprobe_path,
                ffmpeg_path,
                path,
                label=label,
                required_streams={str(stream) for stream in required_streams},
                log_path=log_path,
            )

        self._append_log_line(log_path, f"[{self._log_timestamp()}] ffprobe validate: ok")

    def _validate_media_file(
        self,
        ffprobe_path: Path,
        ffmpeg_path: Path,
        media_path: Path,
        *,
        label: str,
        required_streams: set[str],
        log_path: Path,
    ) -> None:
        if not media_path.exists():
            raise DownloadCommandError(f"缓存校验失败: {label} 文件不存在")
        size = media_path.stat().st_size
        if size <= 0:
            raise DownloadCommandError(f"缓存校验失败: {label} 文件为空")

        command = [
            str(ffprobe_path),
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_streams",
            "-show_format",
            str(media_path),
        ]
        self._append_log_line(
            log_path,
            f"[{self._log_timestamp()}] command: {json.dumps(command, ensure_ascii=False)}",
        )
        process = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
            timeout=20,
            cwd=str(BB_DOWN_DIR),
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

        duration = self._probe_duration(payload)
        duration_label = f"{duration:.2f}s" if duration is not None else "unknown"
        stream_label = "/".join(sorted(stream for stream in detected_streams if stream)) or "unknown"
        self._append_log_line(
            log_path,
            f"[{self._log_timestamp()}] ffprobe validate {label}: ok "
            f"(streams={stream_label}, duration={duration_label}, size={size})",
        )

    @staticmethod
    def _probe_duration(payload: dict[str, object]) -> float | None:
        candidates: list[object] = []
        file_format = payload.get("format")
        if isinstance(file_format, dict):
            candidates.append(file_format.get("duration"))
        streams = payload.get("streams")
        if isinstance(streams, list):
            candidates.extend(
                stream.get("duration")
                for stream in streams
                if isinstance(stream, dict)
            )
        for candidate in candidates:
            try:
                duration = float(candidate)
            except (TypeError, ValueError):
                continue
            if duration > 0:
                return duration
        return None

    @staticmethod
    def _compact_probe_error(message: str) -> str:
        normalized = " ".join(str(message or "").split())
        return normalized[:240] if normalized else "未知错误"

    @staticmethod
    def _ffprobe_path_for_ffmpeg(ffmpeg_path: Path) -> Path | None:
        candidates = []
        if FFPROBE_RUNTIME_PATH.exists():
            candidates.append(FFPROBE_RUNTIME_PATH)
        ffmpeg_dir = ffmpeg_path if ffmpeg_path.is_dir() else ffmpeg_path.parent
        candidates.append(ffmpeg_dir / ("ffprobe.exe" if os.name == "nt" else "ffprobe"))
        system_ffprobe = shutil.which("ffprobe")
        if system_ffprobe:
            candidates.append(Path(system_ffprobe))
        for candidate in candidates:
            if candidate.exists():
                return candidate
        return None

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

    def _ensure_bbdown(self, force_refresh: bool = False) -> Path:
        with self.binary_prepare_lock:
            override = Path(BB_DOWN_PATH_OVERRIDE) if BB_DOWN_PATH_OVERRIDE else None
            if override and override.exists():
                with self.lock:
                    self.binary_state = "ready"
                    self.binary_message = f"使用外部 BBDown: {override}"
                return override

            current_binary = self._local_binary_path()
            local_version = ""
            if BB_DOWN_VERSION_FILE.exists():
                local_version = BB_DOWN_VERSION_FILE.read_text(encoding="utf-8").strip()

            release: dict[str, Any] | None = None
            latest_version = ""
            release_error: Exception | None = None
            try:
                release = self._fetch_latest_release()
                latest_version = str(release["tag_name"])
            except Exception as exc:  # noqa: BLE001
                release_error = exc

            if release is None:
                if current_binary.exists() and not force_refresh:
                    current_binary.chmod(current_binary.stat().st_mode | stat.S_IEXEC)
                    with self.lock:
                        self.binary_state = "ready"
                        self.binary_version = local_version
                        if local_version:
                            self.binary_message = f"BBDown {local_version} 已就绪（未检查更新）"
                        else:
                            self.binary_message = "BBDown 已就绪（未检查更新）"
                    return current_binary
                raise RuntimeError(f"无法检查 BBDown 最新版本: {release_error}")

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

            asset = self._select_asset(release)
            tmp_archive = BB_DOWN_DIR / asset["name"]
            urllib.request.urlretrieve(asset["browser_download_url"], tmp_archive)
            self._extract_archive(tmp_archive, BB_DOWN_DIR)
            tmp_archive.unlink(missing_ok=True)

            if not current_binary.exists():
                raise RuntimeError("下载完成，但未找到 BBDown 可执行文件")

            current_binary.chmod(current_binary.stat().st_mode | stat.S_IEXEC)
            BB_DOWN_VERSION_FILE.write_text(latest_version, encoding="utf-8")

            with self.lock:
                self.binary_state = "ready"
                self.binary_version = latest_version
                self.binary_message = f"BBDown {latest_version} 已更新"

            return current_binary

    def _fetch_latest_release(self) -> dict:
        request = urllib.request.Request(
            BB_DOWN_RELEASE_API,
            headers={"User-Agent": "bilikara"},
        )
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.loads(response.read().decode("utf-8"))

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
        else:
            raise RuntimeError(f"当前平台暂未适配 BBDown 自动下载: {system}/{machine}")

        assets = release.get("assets") or []
        for asset in assets:
            name = str(asset.get("name") or "").lower()
            if token in name and (name.endswith(".zip") or name.endswith(".tar.gz")):
                return asset
        raise RuntimeError(f"没有找到适合当前平台的 BBDown 安装包: {token}")

    def _extract_archive(self, archive_path: Path, output_dir: Path) -> None:
        for child in output_dir.iterdir():
            if child.is_file() and child.name != archive_path.name:
                child.unlink()
            elif child.is_dir():
                shutil.rmtree(child)

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
        buffer = ""
        last_progress: int | None = None
        last_emitted = ""
        while True:
            character = stream.read(1)
            if character == "":
                break
            if character == "\b":
                buffer = buffer[:-1]
                continue
            if character in {"\r", "\n"}:
                stripped = buffer.strip()
                if stripped and stripped != last_emitted:
                    yield stripped
                    last_emitted = stripped
                buffer = ""
                last_progress = None
                continue
            buffer += character
            progress = CacheManager._extract_progress(CacheManager._normalize_output_line(buffer))
            if progress is None:
                continue
            progress_step = int(progress)
            if progress_step != last_progress:
                stripped = buffer.strip()
                if stripped and stripped != last_emitted:
                    yield stripped
                    last_emitted = stripped
                last_progress = progress_step
        stripped = buffer.strip()
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
        for vendor_dir in (VENDOR_DIR, INTERNAL_VENDOR_DIR):
            ffmpeg_path = vendor_dir / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
            if not ffmpeg_path.exists():
                continue
            ffprobe_path = vendor_dir / ("ffprobe.exe" if os.name == "nt" else "ffprobe")
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

    def _read_ffmpeg_version(self, binary_path: Path) -> str:
        try:
            process = subprocess.run(
                [str(binary_path), "-version"],
                capture_output=True,
                text=True,
                errors="replace",
                check=False,
                timeout=10,
                **self._hidden_process_kwargs(),
            )
        except (OSError, subprocess.SubprocessError):
            return ""

        if process.returncode != 0:
            return ""

        first_line = (process.stdout or process.stderr or "").splitlines()
        if not first_line:
            return ""
        parts = first_line[0].split()
        if len(parts) >= 3 and parts[0].lower() == "ffmpeg" and parts[1] == "version":
            return parts[2]
        return ""

    @staticmethod
    def _bbdown_ffmpeg_path_arg(binary_path: Path) -> str:
        target = binary_path if binary_path.is_dir() else binary_path.parent
        return str(target)

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
    def _tool_process_env(binary_path: Path) -> dict[str, str]:
        env = os.environ.copy()
        path_entries = []
        ffmpeg_dir = str(binary_path if binary_path.is_dir() else binary_path.parent)
        if ffmpeg_dir:
            path_entries.append(ffmpeg_dir)
        bbdown_dir = str(BB_DOWN_DIR)
        if bbdown_dir and bbdown_dir not in path_entries:
            path_entries.append(bbdown_dir)
        existing_path = env.get("PATH", "")
        env["PATH"] = os.pathsep.join([*path_entries, existing_path]) if existing_path else os.pathsep.join(path_entries)
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

    def _item_log_path(self, item_id: str) -> Path:
        return self.log_dir / f"{item_id}.log"

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
                    shutil.rmtree(child, ignore_errors=True)
                else:
                    child.unlink(missing_ok=True)
                self._remove_item_log(child.name)

    def _clear_cache_root(self) -> None:
        for child in CACHE_DIR.iterdir():
            if child.is_dir():
                shutil.rmtree(child, ignore_errors=True)
            else:
                child.unlink(missing_ok=True)
        self._clear_log_root()

    def _path_size(self, path: Path) -> int:
        if not path.exists():
            return 0
        if path.is_file():
            try:
                return path.stat().st_size
            except OSError:
                return 0

        total = 0
        for child in path.rglob("*"):
            if not child.is_file():
                continue
            try:
                total += child.stat().st_size
            except OSError:
                continue
        return total

    def _ensure_item_cached(self, item) -> None:
        video_path = CACHE_DIR / item.video_relative_path if item.video_relative_path else None
        has_audio_variants = any(
            isinstance(variant, dict) and str(variant.get("audio_url") or "").strip()
            for variant in item.audio_variants
        )
        if video_path and video_path.exists() and has_audio_variants:
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
            selected_audio_variant_id="",
            persist_backup=False,
        )
        self._record_item_activity(item.id)
        self.enqueue(item.id)

    def _drop_item_cache(self, item_id: str, message: str) -> None:
        self._remove_cache_dir(item_id)
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

    def _remove_cache_dir(self, item_id: str) -> None:
        shutil.rmtree(CACHE_DIR / item_id, ignore_errors=True)
        self._remove_item_log(item_id)

    def _remove_item_log(self, item_id: str) -> None:
        self._item_log_path(item_id).unlink(missing_ok=True)

    def _clear_log_root(self) -> None:
        if not self.log_dir.exists():
            return
        for child in self.log_dir.iterdir():
            if child.is_dir():
                shutil.rmtree(child, ignore_errors=True)
            else:
                child.unlink(missing_ok=True)

    def _record_item_activity(self, item_id: str) -> None:
        with self.lock:
            self.item_activity_at[item_id] = datetime.now().timestamp()

    def _take_retry_request(self, item_id: str) -> bool:
        with self.lock:
            if item_id not in self.retry_requested_ids:
                return False
            self.retry_requested_ids.discard(item_id)
            return True

    def _raise_if_retry_requested(self, item_id: str) -> None:
        if self._take_retry_request(item_id):
            raise CacheCancelledError(RETRY_REQUESTED_MESSAGE)

    def _should_cache(self, item_id: str) -> bool:
        with self.lock:
            return item_id in self.desired_ids and not self.stop_event.is_set()

    def _stop_active_if_not_desired(self, desired_ids: set[str]) -> None:
        with self.lock:
            item_id = self.active_item_id
            process = self.active_process
        if item_id and item_id not in desired_ids:
            self._terminate_process(process)

    def _terminate_process(self, process: subprocess.Popen[str] | None) -> None:
        if not process or process.poll() is not None:
            return
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)

    def _bbdown_login_worker(self) -> None:
            try:
                self._remove_bbdown_qr_image()
                binary_path = self._ensure_bbdown()
            except Exception as exc:  # noqa: BLE001
                with self.lock:
                    self.bbdown_login_state = "failed"
                    self.bbdown_login_message = f"BBDown 不可用: {exc}"
                return

            command = [str(binary_path), "login"]
            try:
                process = subprocess.Popen(
                    command,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    stdin=subprocess.DEVNULL,
                    text=True,
                    encoding=SUBPROCESS_OUTPUT_ENCODING,
                    errors="replace",
                    bufsize=1,
                    cwd=str(BB_DOWN_DIR),
                    env=self._tool_process_env(binary_path),
                    **self._hidden_process_kwargs(),
                )
            except OSError as exc:
                with self.lock:
                    self.bbdown_login_state = "failed"
                    self.bbdown_login_message = f"启动 BBDown 登录失败: {exc}"
                return

            with self.lock:
                self.bbdown_login_process = process
                self.bbdown_login_state = "waiting"
                self.bbdown_login_message = "请使用哔哩哔哩 App 扫码登录"

            output_lines: list[str] = []
            try:
                assert process.stdout is not None
                for raw_line in self._iter_output_messages(process.stdout):
                    line = self._normalize_output_line(raw_line)
                    if not line:
                        continue
                    output_lines.append(line)
                    del output_lines[:-80]
                    
                    qr_image_path = self._bbdown_qr_image_path()
                    qr_image = "" 
                    
                    try:
                        if qr_image_path.stat().st_size > 0:
                            with qr_image_path.open("rb") as image_file:
                                encoded_string = base64.b64encode(image_file.read()).decode('utf-8')
                                qr_image = f"data:image/png;base64,{encoded_string}"
                    except Exception:
                        pass
                    
                    with self.lock:
                        if self.bbdown_login_process is process:
                            self.bbdown_login_qr_image = qr_image
                    
                    if self._bbdown_data_path().exists():
                        break
            finally:
                if process.poll() is None and self._bbdown_data_path().exists():
                    self._terminate_process(process)
                return_code = process.poll()
                if return_code is None:
                    try:
                        return_code = process.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        return_code = None
                login_succeeded = self._bbdown_data_path().exists()
                with self.lock:
                    is_current_process = self.bbdown_login_process is process
                    if is_current_process:
                        self.bbdown_login_process = None
                    if login_succeeded:
                        self._remove_bbdown_qr_image()
                        self.bbdown_login_state = "logged_in"
                        self.bbdown_login_message = "BBDown 已登录"
                        self.bbdown_login_qr_image = ""
                    elif is_current_process and self.bbdown_login_state not in {"failed", "idle"} and return_code not in (None, 0):
                        self.bbdown_login_state = "failed"
                        self.bbdown_login_message = "BBDown 登录失败，请重试"
                if login_succeeded:
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
                    self.binary_message = "后台检查 BBDown 更新中"
            self._ensure_bbdown()
        except Exception as exc:  # noqa: BLE001
            with self.lock:
                self.binary_state = "failed"
                self.binary_message = f"BBDown 检查失败: {exc}"
