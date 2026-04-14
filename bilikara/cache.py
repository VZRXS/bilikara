from __future__ import annotations

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
from typing import Any, Iterator, TextIO

from .config import (
    BB_DOWN_DIR,
    BB_DOWN_PATH_OVERRIDE,
    BB_DOWN_RELEASE_API,
    BB_DOWN_VERSION_FILE,
    CACHE_DIR,
    COOKIE,
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


class CacheCancelledError(RuntimeError):
    pass


class DownloadCommandError(RuntimeError):
    pass


class CacheManager:
    def __init__(self, store: PlaylistStore, max_cache_items: int = MAX_CACHE_ITEMS) -> None:
        self.store = store
        self.max_cache_items = max(0, max_cache_items)
        self.tasks: "queue.Queue[str]" = queue.Queue()
        self.pending_ids: set[str] = set()
        self.desired_ids: set[str] = set()
        self.stop_event = threading.Event()
        self.lock = threading.RLock()
        self.binary_state = "idle"
        self.binary_version = ""
        self.binary_message = "鬯ｯ・ｩ陋ｹ繝ｻ・ｽ・ｽ繝ｻ・ｲ鬮ｴ螟ｧ・｣・ｼ鬩墓㈱繝ｻ繝ｻ・ｽ郢晢ｽｻ繝ｻ・ｾ鬩幢ｽ｢隴趣ｽ｢繝ｻ・ｽ繝ｻ・ｻ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｻ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｻ鬯ｮ・ｯ繝ｻ・ｷ髣費ｽｨ陞滂ｽｲ繝ｻ・ｽ繝ｻ・ｽ郢晢ｽｻ繝ｻ・｡"
        self.binary_prepare_lock = threading.Lock()
        self.ffmpeg_state = "idle"
        self.ffmpeg_version = ""
        self.ffmpeg_message = "鬯ｯ・ｩ陋ｹ繝ｻ・ｽ・ｽ繝ｻ・ｲ鬮ｴ螟ｧ・｣・ｼ鬩墓㈱繝ｻ繝ｻ・ｽ郢晢ｽｻ繝ｻ・ｾ鬩幢ｽ｢隴趣ｽ｢繝ｻ・ｽ繝ｻ・ｻ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｻ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｻ鬯ｮ・ｯ繝ｻ・ｷ髣費ｽｨ陞滂ｽｲ繝ｻ・ｽ繝ｻ・ｽ郢晢ｽｻ繝ｻ・｡"
        self.ffmpeg_prepare_lock = threading.Lock()
        self.active_process: subprocess.Popen[str] | None = None
        self.active_item_id: str | None = None
        self.item_activity_at: dict[str, float] = {}
        self.retry_requested_ids: set[str] = set()
        self.log_dir = LOG_DIR / "bbdown"
        self.worker = threading.Thread(target=self._worker_loop, daemon=True)
        self.worker.start()

    def status(self, metrics: dict[str, Any] | None = None) -> dict:
        cache_metrics = metrics or self.cache_metrics()
        with self.lock:
            return {
                "state": self.binary_state,
                "version": self.binary_version,
                "message": self.binary_message,
                "max_cache_items": self.max_cache_items,
                "cache_bytes": cache_metrics["total_bytes"],
                "cached_items": cache_metrics["item_count"],
            }

    def ffmpeg_status(self) -> dict[str, Any]:
        with self.lock:
            return {
                "state": self.ffmpeg_state,
                "version": self.ffmpeg_version,
                "message": self.ffmpeg_message,
                "path": str(FFMPEG_RUNTIME_PATH),
            }

    def policy_snapshot(self, metrics: dict[str, Any] | None = None) -> dict[str, Any]:
        cache_metrics = metrics or self.cache_metrics()
        with self.lock:
            return {
                "max_cache_items": self.max_cache_items,
                "choices": list(CACHE_LIMIT_CHOICES),
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
        bounded = min(max(int(max_cache_items), CACHE_LIMIT_CHOICES[0]), CACHE_LIMIT_CHOICES[-1])
        with self.lock:
            if self.max_cache_items == bounded:
                return bounded
            self.max_cache_items = bounded
        self.sync_with_playlist()
        return bounded

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
                local_relative_path="",
                local_media_url="",
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
                local_relative_path="",
                local_media_url="",
                audio_variants=[],
                selected_audio_variant_id="",
                persist_backup=False,
            )
            self._record_item_activity(item.id)

    def retry_item(self, item_id: str) -> None:
        item = self.store.get_item(item_id)
        if not item:
            raise ValueError("没有找到要重新下载的歌曲")
        if item.local_media_url or item.cache_status == "ready":
            raise ValueError("这首歌已经缓存完成，无需重新下载")
        if item.cache_status not in {"downloading", "failed"}:
            raise ValueError("当前缓存状态不能重新下载")
        if not self._should_cache(item_id):
            raise ValueError("当前不在自动缓存窗口中")

        log_path = self._item_log_path(item_id)
        self._append_log_line(log_path, f"[{self._log_timestamp()}] manual retry requested")

        with self.lock:
            active_process = self.active_process if self.active_item_id == item_id else None
            if active_process is not None:
                self.retry_requested_ids.add(item_id)

        self.store.update_item(
            item_id,
            cache_status="pending",
            cache_progress=0.0,
            cache_message="准备重新下载",            local_relative_path="",
            local_media_url="",
            audio_variants=[],
            selected_audio_variant_id="",
            persist_backup=False,
        )
        self._record_item_activity(item_id)

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
        item = self.store.get_item(item_id)
        if not item:
            self._remove_cache_dir(item_id)
            return
        # The current implementation always uses the multi-track pipeline.
        # Keep the old single-pass BBDown flow in `_cache_item_legacy()` for reference.
        self._cache_item_multi(item_id, item, allow_refresh_retry=allow_refresh_retry)
        return

        self.store.update_item(
            item_id,
            cache_status="queued",
            cache_progress=0.0,
            cache_message="等待缓存队列",
            persist_backup=False,
        )

        try:
            binary_path = self._ensure_bbdown()
        except Exception as exc:  # noqa: BLE001
            self.store.update_item(
                item_id,
                cache_status="failed",
                cache_message=f"BBDown 鬯ｮ・｣陋ｹ繝ｻ・ｽ・ｽ繝ｻ・ｳ鬮ｫ・ｶ隴幢ｽｱ陞ｳ・ｦ郢晢ｽｻ繝ｻ・ｺ驛｢譎｢・ｽ・ｻ繝ｻ縺､ﾂ髯具ｽｹ郢晢ｽｻ繝ｻ・ｽ繝ｻ・ｽ郢晢ｽｻ繝ｻ・ｨ: {exc}",
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
                cache_message=f"BBDown 不可用: {exc}",
                persist_backup=False,
            )
            return

        if not self._should_cache(item_id):
            return

        item_dir = CACHE_DIR / item_id
        item_dir.mkdir(parents=True, exist_ok=True)
        log_path = self._item_log_path(item_id)
        self.store.update_item(
            item_id,
            cache_status="downloading",
            cache_message="开始缓存视频",
            persist_backup=False,
        )
        self._append_log_line(log_path, "")
        self._append_log_line(log_path, f"[{self._log_timestamp()}] start cache: {item.display_title}")

        command = [
            str(binary_path),
            item.resolved_url,
            "-p",
            str(item.page),
            "--work-dir",
            str(item_dir),
            "--ffmpeg-path",
            self._bbdown_ffmpeg_path_arg(ffmpeg_path),
            "--file-pattern",
            "video",
            "--skip-subtitle",
            "--skip-cover",
            "--skip-ai",
        ]
        if COOKIE:
            command.extend(["-c", COOKIE])
        self._append_log_line(log_path, f"[{self._log_timestamp()}] command: {json.dumps(command, ensure_ascii=False)}")

        cancelled = False
        cancel_message = "鬯ｯ・ｩ陝ｶ蟷｢・ｽ・ｸ繝ｻ・ｷ繝ｻ繧托ｽｽ・ｧ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｭ鬮｣雋ｻ・ｽ・ｨ髫ｲ蟷｢・ｽ・ｶ郢晢ｽｻ繝ｻ・ｽ郢晢ｽｻ繝ｻ・ｷ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｲ鬯ｮ・ｯ陷ｿ・･繝ｻ・ｸ繝ｻ・ｶ驛｢・ｩ繝ｻ・ｧ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｭ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・｢"
        last_message = "鬯ｯ・ｩ陝ｶ蟷｢・ｽ・ｸ繝ｻ・ｷ繝ｻ繧托ｽｽ・ｧ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｭ鬮ｯ蛹ｺ・ｺ蛟･繝ｻ郢晢ｽｻ繝ｻ・ｽ郢晢ｽｻ繝ｻ・ｸ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｭ"
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
                progress = self._extract_progress(line)
                changes = {"cache_message": self._display_message(line, progress)}
                if progress is not None:
                    changes["cache_progress"] = progress
                self.store.update_item(item_id, persist_backup=False, **changes)
                if self.stop_event.is_set():
                    cancelled = True
                    cancel_message = "鬯ｯ・ｩ陝ｶ蟷｢・ｽ・ｸ繝ｻ・ｷ繝ｻ繧托ｽｽ・ｧ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｭ鬮｣雋ｻ・ｽ・ｨ髫ｲ蟷｢・ｽ・ｶ郢晢ｽｻ繝ｻ・ｽ郢晢ｽｻ繝ｻ・ｷ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｲ鬯ｮ・ｯ陷ｿ・･繝ｻ・ｸ繝ｻ・ｶ驛｢・ｩ繝ｻ・ｧ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｭ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・｢"
                    self._terminate_process(process)
                    break
                if not self._should_cache(item_id):
                    cancelled = True
                    cancel_message = self._outside_window_message()
                    self._terminate_process(process)
                    break
            return_code = process.wait()
        finally:
            with self.lock:
                if self.active_process is process:
                    self.active_process = None
                    self.active_item_id = None

        if cancelled or self.stop_event.is_set() or not self._should_cache(item_id):
            self._append_log_line(log_path, f"[{self._log_timestamp()}] cancelled: {cancel_message}")
            self._drop_item_cache(item_id, cancel_message)
            return

        if return_code != 0:
            if allow_refresh_retry and self._should_force_refresh_bbdown(last_message):
                self._append_log_line(
                    log_path,
                    f"[{self._log_timestamp()}] detected stale BBDown hint, forcing refresh and retry",
                )
                try:
                    self._ensure_bbdown(force_refresh=True)
                    shutil.rmtree(item_dir, ignore_errors=True)
                    item_dir.mkdir(parents=True, exist_ok=True)
                    self._cache_item(item_id, allow_refresh_retry=False)
                    return
                except Exception as exc:  # noqa: BLE001
                    self._append_log_line(
                        log_path,
                        f"[{self._log_timestamp()}] forced BBDown refresh failed: {exc}",
                    )
            self._append_log_line(
                log_path,
                f"[{self._log_timestamp()}] failed with exit code {return_code}: {last_message}",
            )
            self.store.update_item(
                item_id,
                cache_status="failed",
                cache_message=f"缓存失败: {last_message}",
                persist_backup=False,
            )
            return

        media_file = self._find_media_file(item_dir)
        if not media_file:
            self._append_log_line(
                log_path,
                f"[{self._log_timestamp()}] failed: media file not found after download",
            )
            self.store.update_item(
                item_id,
                cache_status="failed",
                cache_message="缓存完成，但没有找到可播放文件",
                persist_backup=False,
            )
            return

        relative_path = str(media_file.relative_to(CACHE_DIR))
        self.store.update_item(
            item_id,
            cache_status="ready",
            cache_progress=100.0,
            cache_message="缓存已完成",
            local_relative_path=relative_path,
            local_media_url=self._build_media_url(relative_path),
            persist_backup=False,
        )
        self._append_log_line(log_path, f"[{self._log_timestamp()}] ready: {media_file.name}")

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

        media_file = cache_result["media_file"]
        relative_path = str(media_file.relative_to(CACHE_DIR))
        self.store.update_item(
            item_id,
            cache_status="ready",
            cache_progress=100.0,
            cache_message=self._ready_message(item),
            local_relative_path=relative_path,
            local_media_url=self._build_media_url(relative_path),
            audio_variants=cache_result["audio_variants"],
            selected_audio_variant_id=cache_result["selected_audio_variant_id"],
            persist_backup=False,
        )
        self._record_item_activity(item_id)
        self._append_log_line(log_path, f"[{self._log_timestamp()}] ready: {media_file.name}")
        
        
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

        audio_files: list[tuple[Path, str]] = []
        for stage_offset, page in enumerate(selected_pages, start=1):
            audio_files.append(
                (
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

        return self._mux_downloaded_streams(
            item,
            ffmpeg_path,
            item_dir,
            log_path,
            video_file=video_file,
            audio_files=audio_files,
        )

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

        command = [
            str(binary_path),
            page_url,
            "-p",
            str(page),
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
        if COOKIE:
            command.extend(["-c", COOKIE])

        label = "视频轨" if stream_kind == "video" else "audio stream"
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
        stream_file = self._find_stream_file(target_dir, allowed_extensions)
        if not stream_file:
            raise DownloadCommandError(f"{stage_label} 完成后未找到输出文件")
        return stream_file

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
                    raise CacheCancelledError("鬯ｯ・ｩ陝ｶ蟷｢・ｽ・ｸ繝ｻ・ｷ繝ｻ繧托ｽｽ・ｧ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｭ鬮｣雋ｻ・ｽ・ｨ髫ｲ蟷｢・ｽ・ｶ郢晢ｽｻ繝ｻ・ｽ郢晢ｽｻ繝ｻ・ｷ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｲ鬯ｮ・ｯ陷ｿ・･繝ｻ・ｸ繝ｻ・ｶ驛｢・ｩ繝ｻ・ｧ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｭ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・｢")
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

    def _mux_downloaded_streams(
        self,
        item,
        ffmpeg_path: Path,
        item_dir: Path,
        log_path: Path,
        *,
        video_file: Path,
        audio_files: list[tuple[Path, str]],
    ) -> dict[str, object]:
        item_id = item.id
        output_dir = item_dir / "output"
        output_dir.mkdir(parents=True, exist_ok=True)
        output_file = output_dir / "video.mp4"
        output_file.unlink(missing_ok=True)

        command = [str(ffmpeg_path), "-y", "-i", str(video_file)]
        for audio_file, _label in audio_files:
            command.extend(["-i", str(audio_file)])
        command.extend(["-map", "0:v:0"])
        for index in range(len(audio_files)):
            command.extend(["-map", f"{index + 1}:a:0"])
        command.extend(["-c", "copy", "-movflags", "+faststart"])
        for index, (_audio_file, label) in enumerate(audio_files):
            command.extend([f"-metadata:s:a:{index}", f"title={label}"])
            command.extend([f"-disposition:a:{index}", "default" if index == 0 else "0"])
        command.append(str(output_file))

        self.store.update_item(
            item_id,
            cache_progress=95.0,
            cache_message=f"正在混流 {len(audio_files)} 条音轨",
            persist_backup=False,
        )
        self._record_item_activity(item_id)
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
        last_message = "ffmpeg mux"
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
                self.store.update_item(
                    item_id,
                    cache_message=f"正在混流 {len(audio_files)} 条音轨",
                    persist_backup=False,
                )
                if self.stop_event.is_set():
                    self._terminate_process(process)
                    raise CacheCancelledError("鬯ｯ・ｩ陝ｶ蟷｢・ｽ・ｸ繝ｻ・ｷ繝ｻ繧托ｽｽ・ｧ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｭ鬮｣雋ｻ・ｽ・ｨ髫ｲ蟷｢・ｽ・ｶ郢晢ｽｻ繝ｻ・ｽ郢晢ｽｻ繝ｻ・ｷ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｲ鬯ｮ・ｯ陷ｿ・･繝ｻ・ｸ繝ｻ・ｶ驛｢・ｩ繝ｻ・ｧ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｭ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・｢")
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
        if not output_file.exists():
            raise DownloadCommandError("FFmpeg 鬯ｮ・ｮ髮懶ｽ｣繝ｻ・ｽ繝ｻ・ｺ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｷ鬯ｮ・ｮ髮懶ｽ｣繝ｻ・ｽ繝ｻ・ｬ鬩包ｽｶ闕ｵ諤懈ｬｾ郢晢ｽｻ繝ｻ・ｽ郢晢ｽｻ繝ｻ・ｮ鬮ｫ・ｴ繝ｻ・ｴ郢晢ｽｻ繝ｻ・ｧ鬩幢ｽ｢隴趣ｽ｢繝ｻ・ｽ繝ｻ・ｻ鬩幢ｽ｢隴趣ｽ｢繝ｻ・ｽ繝ｻ・ｻ鬮ｯ貅ｷ譯√・・ｽ繝ｻ・｡驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｽ鬩幢ｽ｢隴趣ｽ｢繝ｻ・ｽ繝ｻ・ｻ鬮ｫ・ｰ髮具ｽｻ繝ｻ・ｽ繝ｻ・ｴ鬯ｯ・ｨ繝ｻ・ｾ髯溘・螻ｮ繝ｻ・ｽ繝ｻ・ｻ鬮ｦ・ｮ陷ｷ・ｶ郢晢ｽｻ鬯ｯ・ｮ繝ｻ・ｴ髯橸ｽｳ隰紋ｼ夲ｽｽ・ｧ鬩幢ｽ｢隴趣ｽ｢繝ｻ・ｽ繝ｻ・ｻ鬯ｮ・ｫ繝ｻ・ｴ驕ｶ荳橸ｽ｣・ｹ郢晢ｽｻ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｻ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｶ")

        self.store.update_item(
            item_id,
            cache_progress=99.0,
            cache_message="混流完成，正在收尾",
            persist_backup=False,
        )
        self._record_item_activity(item_id)
        variant_files = self._build_audio_variant_outputs(
            item,
            ffmpeg_path,
            item_dir,
            log_path,
            video_file=video_file,
            audio_files=audio_files,
        )
        audio_variants = [
            {
                "id": variant_id,
                "label": label,
                "media_url": self._build_media_url(str(path.relative_to(CACHE_DIR))),
            }
            for variant_id, label, path in variant_files
        ]
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
        return {
            "media_file": output_file,
            "audio_variants": audio_variants,
            "selected_audio_variant_id": selected_audio_variant_id,
        }

    def _build_audio_variant_outputs(
        self,
        item,
        ffmpeg_path: Path,
        item_dir: Path,
        log_path: Path,
        *,
        video_file: Path,
        audio_files: list[tuple[Path, str]],
    ) -> list[tuple[str, str, Path]]:
        if len(audio_files) <= 1:
            return [("default", audio_files[0][1] if audio_files else "Default", item_dir / "output" / "video.mp4")]

        variant_files: list[tuple[str, str, Path]] = []
        variants_dir = item_dir / "variants"
        variants_dir.mkdir(parents=True, exist_ok=True)

        for index, (audio_file, label) in enumerate(audio_files):
            variant_id = self._variant_id(label, index)
            variant_path = variants_dir / f"{variant_id}.mp4"
            variant_path.unlink(missing_ok=True)
            command = [
                str(ffmpeg_path),
                "-y",
                "-i",
                str(video_file),
                "-i",
                str(audio_file),
                "-map",
                "0:v:0",
                "-map",
                "1:a:0",
                "-c",
                "copy",
                "-movflags",
                "+faststart",
                "-metadata:s:a:0",
                f"title={label}",
                str(variant_path),
            ]
            self._append_log_line(log_path, f"[{self._log_timestamp()}] command: {json.dumps(command, ensure_ascii=False)}")
            process = subprocess.run(
                command,
                capture_output=True,
                text=True,
                errors="replace",
                check=False,
                cwd=str(BB_DOWN_DIR),
                env=self._tool_process_env(ffmpeg_path),
                **self._hidden_process_kwargs(),
            )
            if process.returncode != 0 or not variant_path.exists():
                raise DownloadCommandError(process.stderr.strip() or process.stdout.strip() or f"鬯ｯ・ｨ繝ｻ・ｾ髯溘・螻ｮ繝ｻ・ｽ繝ｻ・ｻ鬮ｦ・ｮ陷ｷ・ｶ郢晢ｽｻ鬯ｯ・ｯ繝ｻ・ｮ郢晢ｽｻ繝ｻ・ｻ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｳ鬯ｯ・ｮ繝ｻ・ｴ鬯ｮ・ｮ繝ｻ・｣郢晢ｽｻ繝ｻ・ｽ郢晢ｽｻ繝ｻ・ｨ鬯ｮ・ｯ繝ｻ・ｷ郢晢ｽｻ繝ｻ・ｿ鬮ｯ蛹ｺ・ｺ蛟･繝ｻ郢晢ｽｻ繝ｻ・ｽ郢晢ｽｻ繝ｻ・ｽ鬮ｴ髮｣・ｽ・｣髯句ｸ吶・繝ｻ・ｽ繝ｻ・ｽ郢晢ｽｻ繝ｻ・､驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｱ鬯ｯ・ｮ繝ｻ・ｮ髫ｰ・ｳ繝ｻ・ｾ郢晢ｽｻ繝ｻ・ｽ郢晢ｽｻ繝ｻ・･: {label}")
            self._record_item_activity(item.id)
            variant_files.append((variant_id, label, variant_path))
        return variant_files

    @staticmethod
    def _variant_id(label: str, index: int) -> str:
        normalized = re.sub(r"[^a-z0-9]+", "_", label.lower()).strip("_")
        return normalized or f"track_{index + 1}"

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
        page_count = len(item.selected_pages or [])
        if page_count > 1:
            return f"Preparing cache for {page_count} media tracks"
        return "Preparing cache"

    @staticmethod
    def _ready_message(item) -> str:
        page_count = len(item.selected_pages or [])
        if page_count > 1:
            return f"Cache ready with {page_count} audio tracks"
        return "Cache ready"

    @staticmethod
    def _display_stage_message(stage_label: str, line: str, progress: float | None) -> str:
        if progress is not None:
            return f"{stage_label} {round(progress)}%"
        return stage_label

    def _ensure_bbdown(self, force_refresh: bool = False) -> Path:
        with self.binary_prepare_lock:
            override = Path(BB_DOWN_PATH_OVERRIDE) if BB_DOWN_PATH_OVERRIDE else None
            if override and override.exists():
                with self.lock:
                    self.binary_state = "ready"
                    self.binary_message = f"鬯ｮ・｣陷ｴ繝ｻ・ｽ・ｽ繝ｻ・ｴ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｿ鬯ｯ・ｨ繝ｻ・ｾ髯具ｽｹ郢晢ｽｻ繝ｻ・ｽ繝ｻ・ｽ郢晢ｽｻ繝ｻ・ｨ鬯ｮ・ｯ隶灘･・ｽｽ・ｺ繝ｻ・ｷ郢晢ｽｻ繝ｻ・､髫ｲ・ｷ陞｢・ｹ郢晢ｽｻBBDown: {override}"
                return override

            current_binary = self._local_binary_path()
            release = self._fetch_latest_release()
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
                    self.binary_message = f"BBDown {latest_version} 鬯ｮ・ｯ隴趣ｽ｢繝ｻ・ｽ繝ｻ・ｾ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｲ鬯ｮ・ｯ隴擾ｽｴ郢晢ｽｻ郢晢ｽｻ繝ｻ・ｽ郢晢ｽｻ繝ｻ・ｱ鬮ｫ・ｰ郢晢ｽｻ髢ｧ・ｩ郢晢ｽｻ繝ｻ・ｽ郢晢ｽｻ繝ｻ・ｪ"
                return current_binary

            with self.lock:
                self.binary_state = "installing"
                self.binary_message = "鬯ｮ・ｮ陟托ｽｱ郢晢ｽｻ郢晢ｽｻ繝ｻ・ｽ郢晢ｽｻ繝ｻ・｣鬯ｮ・ｯ隲幢ｽｶ繝ｻ・ｽ繝ｻ・ｨ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｨ鬯ｮ・ｯ雋頑瑳・ｱ螢ｹ繝ｻ繝ｻ・ｽ郢晢ｽｻ繝ｻ・ｺ鬯ｮ・ｯ陷茨ｽｷ繝ｻ・ｽ繝ｻ・ｻ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｶ鬯ｮ・ｫ繝ｻ・ｴ髯ｷ・ｴ郢晢ｽｻ繝ｻ・ｽ繝ｻ・ｽ郢晢ｽｻ繝ｻ・ｴ鬯ｮ・ｫ繝ｻ・ｴ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｽ郢晢ｽｻ繝ｻ・ｰ BBDown" if force_refresh else "鬯ｮ・ｮ陟托ｽｱ郢晢ｽｻ郢晢ｽｻ繝ｻ・ｽ郢晢ｽｻ繝ｻ・｣鬯ｮ・ｯ隲幢ｽｶ繝ｻ・ｽ繝ｻ・ｨ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｨ鬯ｮ・ｫ繝ｻ・ｴ郢晢ｽｻ繝ｻ・ｽ郢晢ｽｻ邵ｺ・､・つ鬯ｮ・ｫ繝ｻ・ｴ髮狗ｿｫ・代・・ｽ繝ｻ・ｽ郢晢ｽｻ繝ｻ・･鬯ｮ・ｯ繝ｻ・ｷ郢晢ｽｻ繝ｻ・･鬮ｫ・ｴ繝ｻ・ｴ郢晢ｽｻ繝ｻ・ｧ鬮ｯ譎｢・ｽ・ｲ郢晢ｽｻ繝ｻ・ｩ鬯ｮ・ｫ繝ｻ・ｴ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｽ郢晢ｽｻ繝ｻ・ｰ BBDown"

            asset = self._select_asset(release)
            tmp_archive = BB_DOWN_DIR / asset["name"]
            urllib.request.urlretrieve(asset["browser_download_url"], tmp_archive)
            self._extract_archive(tmp_archive, BB_DOWN_DIR)
            tmp_archive.unlink(missing_ok=True)

            if not current_binary.exists():
                raise RuntimeError("鬯ｮ・｣陋ｹ繝ｻ・ｽ・ｽ繝ｻ・ｳ鬯ｩ髦ｪ繝ｻ驕倪・繝ｻ繝ｻ・ｽ郢晢ｽｻ繝ｻ・ｽ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｽ鬯ｮ・ｯ隶厄ｽｸ繝ｻ・ｽ繝ｻ・ｳ鬮ｫ・ｴ繝ｻ・ｴ郢晢ｽｻ繝ｻ・ｧ鬩幢ｽ｢隴趣ｽ｢繝ｻ・ｽ繝ｻ・ｻ鬩幢ｽ｢隴趣ｽ｢繝ｻ・ｽ繝ｻ・ｻ鬮ｯ貅ｷ譯√・・ｽ繝ｻ・｡驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｽ鬩幢ｽ｢隴趣ｽ｢繝ｻ・ｽ繝ｻ・ｻ鬮ｫ・ｰ髮具ｽｻ繝ｻ・ｽ繝ｻ・ｴ鬯ｮ・ｫ繝ｻ・ｰ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｽ郢晢ｽｻ繝ｻ・ｾ鬯ｮ・ｯ陷茨ｽｷ繝ｻ・ｽ繝ｻ・ｻ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｰ BBDown 鬯ｮ・ｯ繝ｻ・ｷ郢晢ｽｻ繝ｻ・ｿ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｯ鬯ｮ・ｫ繝ｻ・ｰ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｽ郢晢ｽｻ繝ｻ・ｧ鬯ｯ・ｮ繝ｻ・ｯ郢晢ｽｻ繝ｻ・ｦ鬮ｫ・ｴ繝ｻ・ｴ郢晢ｽｻ繝ｻ・ｧ鬮ｫ・ｴ繝ｻ・ｫ髯樊ｻ・ｽ｡菴ｯﾂ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｶ")

            current_binary.chmod(current_binary.stat().st_mode | stat.S_IEXEC)
            BB_DOWN_VERSION_FILE.write_text(latest_version, encoding="utf-8")

            with self.lock:
                self.binary_state = "ready"
                self.binary_version = latest_version
                self.binary_message = f"BBDown {latest_version} 鬯ｮ・ｯ隴趣ｽ｢繝ｻ・ｽ繝ｻ・ｾ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｲ鬯ｮ・ｫ繝ｻ・ｴ髯ｷ・ｴ郢晢ｽｻ繝ｻ・ｽ繝ｻ・ｽ郢晢ｽｻ繝ｻ・ｴ鬯ｮ・ｫ繝ｻ・ｴ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｽ郢晢ｽｻ繝ｻ・ｰ"

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
            raise RuntimeError(f"鬯ｮ・ｯ雋贋ｼ夲ｽｽ・ｹ雎ｺ讖ｸ・ｽ・ｧ鬮ｴ雜｣・ｽ・ｯ髫ｰ遒・｣ｰ謇假ｽｽ・ｿ繝ｻ・､驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｳ鬯ｮ・ｯ繝ｻ・ｷ郢晢ｽｻ繝ｻ・ｿ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｰ鬯ｮ・ｫ繝ｻ・ｴ髯晢ｽｲ繝ｻ・ｨ郢晢ｽｻ鬩帙・・ｽ・ｬ髮具ｽｻ繝ｻ・ｽ繝ｻ・ｴ鬯ｯ・ｯ繝ｻ・ｨ郢晢ｽｻ繝ｻ・ｾ鬩幢ｽ｢繝ｻ・ｧ髣包ｽｵ隴擾ｽｴ郢晢ｽｻ BBDown 鬯ｯ・ｮ繝ｻ・｢郢晢ｽｻ繝ｻ・ｾ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｪ鬯ｮ・ｯ繝ｻ・ｷ髣費ｽｨ陞滂ｽｲ繝ｻ・ｽ繝ｻ・ｽ郢晢ｽｻ繝ｻ・ｨ鬯ｮ・｣陋ｹ繝ｻ・ｽ・ｽ繝ｻ・ｳ鬯ｩ髦ｪ繝ｻ驕倪・繝ｻ繝ｻ・ｽ郢晢ｽｻ繝ｻ・ｽ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｽ: {system}/{machine}")

        assets = release.get("assets") or []
        for asset in assets:
            name = str(asset.get("name") or "").lower()
            if token in name and (name.endswith(".zip") or name.endswith(".tar.gz")):
                return asset
        raise RuntimeError(f"鬯ｮ・ｮ陷ｿ蜀ｶ繝ｻ郢晢ｽｻ繝ｻ・ｽ郢晢ｽｻ繝ｻ・｡鬯ｮ・ｫ繝ｻ・ｴ髯晢ｽｶ繝ｻ・ｷ髯具ｽｻ繝ｻ・､鬮｣雋ｻ・ｽ・ｨ郢晢ｽｻ繝ｻ・ｽ鬯ｮ・ｯ陷茨ｽｷ繝ｻ・ｽ繝ｻ・ｻ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｰ鬯ｯ・ｯ繝ｻ・ｨ郢晢ｽｻ繝ｻ・ｾ鬩幢ｽ｢繝ｻ・ｧ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｲ鬩阪・遘√・・｣繝ｻ・ｰ髣包ｽｵ雎ｺ讖ｸ・ｽ・ｧ鬮ｴ雜｣・ｽ・ｯ髫ｰ遒・｣ｰ謇假ｽｽ・ｿ繝ｻ・､驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｳ鬯ｮ・ｯ繝ｻ・ｷ郢晢ｽｻ繝ｻ・ｿ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｰ鬯ｯ・ｨ繝ｻ・ｾ郢晢ｽｻ繝ｻ・ｧ鬩幢ｽ｢隴趣ｽ｢繝ｻ・ｽ繝ｻ・ｻBBDown 鬯ｮ・ｯ隶厄ｽｸ繝ｻ・ｽ繝ｻ・ｳ鬯ｮ・｣郢晢ｽｻ繝ｻ・ｽ繝ｻ・ｽ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・｣鬩幢ｽ｢隴趣ｽ｢繝ｻ・ｽ繝ｻ・ｻ鬮ｫ・ｴ繝ｻ・ｯ驛｢譎｢・ｽ・ｻ {token}")

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
            raise RuntimeError(f"鬯ｮ・｣陋ｹ繝ｻ・ｽ・ｽ繝ｻ・ｳ鬯ｮ・｢繝ｻ・ｧ郢晢ｽｻ繝ｻ・ｴ鬯ｯ・ｯ繝ｻ・ｮ郢晢ｽｻ繝ｻ・ｪ鬯ｮ・ｫ繝ｻ・ｰ髯懶｣ｰ闕ｵ蜉ｱ窶ｲ鬮ｯ諛・ｽｶ・｣繝ｻ・ｽ繝ｻ・ｪ BBDown 鬯ｮ・ｯ繝ｻ・ｷ郢晢ｽｻ繝ｻ・ｴ鬮ｴ謇假ｽｽ・｢髫ｴ莨夲ｽｽ・ｦ郢晢ｽｻ繝ｻ・ｽ郢晢ｽｻ繝ｻ・ｼ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｩ鬯ｮ・ｯ陷茨ｽｷ繝ｻ・ｽ繝ｻ・ｹ鬩幢ｽ｢隴趣ｽ｢繝ｻ・ｽ繝ｻ・ｻ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｰ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｼ鬯ｮ・ｯ雋贋ｼ夲ｽｽ・ｻ繝ｻ・｣驛｢譎｢・ｽ・ｻ {archive_path.name}")

    def _local_binary_path(self) -> Path:
        return BB_DOWN_DIR / ("BBDown.exe" if os.name == "nt" else "BBDown")

    def _find_media_file(self, item_dir: Path) -> Path | None:
        media_files = [
            path
            for path in item_dir.rglob("*")
            if path.is_file() and path.suffix.lower() in MEDIA_EXTENSIONS
        ]
        if not media_files:
            return None
        return max(media_files, key=lambda path: path.stat().st_size)

    @staticmethod
    def _find_stream_file(target_dir: Path, allowed_extensions: set[str]) -> Path | None:
        media_files = [
            path
            for path in target_dir.rglob("*")
            if path.is_file() and path.suffix.lower() in allowed_extensions
        ]
        if not media_files:
            return None
        return max(media_files, key=lambda path: path.stat().st_size)

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
        if progress is not None:
            return f"Caching {round(progress)}%"
        return "Caching..."

    @staticmethod
    def _should_force_refresh_bbdown(message: str) -> bool:
        text = str(message or "")
        return "latest version" in text or "download the latest version" in text

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
                    raise RuntimeError(f"鬯ｮ・ｯ隶灘･・ｽｽ・ｺ繝ｻ・ｷ郢晢ｽｻ繝ｻ・､髫ｲ・ｷ陞｢・ｹ郢晢ｽｻFFmpeg 鬯ｮ・｣陋ｹ繝ｻ・ｽ・ｽ繝ｻ・ｳ鬮ｫ・ｶ隴幢ｽｱ陞ｳ・ｦ郢晢ｽｻ繝ｻ・ｺ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｬ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｽ郢晢ｽｻ繝ｻ・ｧ鬯ｯ・ｮ繝ｻ・ｯ郢晢ｽｻ繝ｻ・ｦ鬩幢ｽ｢隴趣ｽ｢繝ｻ・ｽ繝ｻ・ｻ {override}")
                with self.lock:
                    self.ffmpeg_state = "ready"
                    self.ffmpeg_version = version
                    self.ffmpeg_message = f"鬯ｮ・｣陷ｴ繝ｻ・ｽ・ｽ繝ｻ・ｴ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｿ鬯ｯ・ｨ繝ｻ・ｾ髯具ｽｹ郢晢ｽｻ繝ｻ・ｽ繝ｻ・ｽ郢晢ｽｻ繝ｻ・ｨ鬯ｮ・ｯ隶灘･・ｽｽ・ｺ繝ｻ・ｷ郢晢ｽｻ繝ｻ・､髫ｲ・ｷ陞｢・ｹ郢晢ｽｻFFmpeg: {override}"
                return override

            with self.lock:
                self.ffmpeg_state = "checking"
                self.ffmpeg_message = "鬯ｮ・ｮ陟托ｽｱ郢晢ｽｻ郢晢ｽｻ繝ｻ・ｽ郢晢ｽｻ繝ｻ・｣鬯ｮ・ｯ隲幢ｽｶ繝ｻ・ｽ繝ｻ・ｨ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｨ鬯ｮ・ｯ繝ｻ・ｷ驛｢譎｢・ｽ・ｻ驛｢譎｢・ｽ・ｻ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・､鬩幢ｽ｢隴趣ｽ｢繝ｻ・ｽ繝ｻ・ｻFFmpeg"

            source_ffmpeg, source_ffprobe = self._preferred_ffmpeg_sources()
            runtime_ffmpeg = FFMPEG_RUNTIME_PATH
            runtime_ffprobe = FFPROBE_RUNTIME_PATH

            if source_ffmpeg:
                FFMPEG_TOOLS_DIR.mkdir(parents=True, exist_ok=True)
                self._sync_runtime_tool(source_ffmpeg, runtime_ffmpeg, force_refresh=force_refresh)
                if source_ffprobe:
                    self._sync_runtime_tool(source_ffprobe, runtime_ffprobe, force_refresh=force_refresh)
            elif not runtime_ffmpeg.exists():
                raise RuntimeError("鬯ｮ・ｫ繝ｻ・ｴ髯晢ｽｷ繝ｻ・｢郢晢ｽｻ繝ｻ・ｽ郢晢ｽｻ繝ｻ・ｪ鬯ｮ・ｫ繝ｻ・ｰ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｽ郢晢ｽｻ繝ｻ・ｾ鬯ｮ・ｯ陷茨ｽｷ繝ｻ・ｽ繝ｻ・ｻ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｰ鬯ｮ・ｯ繝ｻ・ｷ郢晢ｽｻ繝ｻ・ｿ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｯ鬯ｯ・ｨ繝ｻ・ｾ髯具ｽｹ郢晢ｽｻ繝ｻ・ｽ繝ｻ・ｽ郢晢ｽｻ繝ｻ・ｨ鬯ｯ・ｨ繝ｻ・ｾ郢晢ｽｻ繝ｻ・ｧ鬩幢ｽ｢隴趣ｽ｢繝ｻ・ｽ繝ｻ・ｻffmpeg鬩幢ｽ｢隴趣ｽ｢繝ｻ・ｽ繝ｻ・ｻ鬮ｫ・ｰ騾搾ｽｲ繝ｻ・ｺ繝ｻ・ｷ郢晢ｽｻ繝ｻ・ｺ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｩ郢晢ｽｻ繝ｻ・･鬯ｮ・｢繝ｻ・ｧ郢晢ｽｻ繝ｻ・ｴ鬯ｨ・ｾ繝ｻ・ｵ郢晢ｽｻ繝ｻ・ｰ鬯ｮ・ｫ繝ｻ・ｰ驛｢譎｢・ｽ・ｻ繝ｻ繧托ｽｽ・ｧ鬮ｫ・ｴ繝ｻ・ｯ驕ｶ謫ｾ・ｽ・ｬ郢晢ｽｻ繝ｻ・ｬ髫ｰ逍ｲ・ｺ蛟･繝ｻ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｮ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｾ鬯ｯ・ｩ陷会ｽｱ繝ｻ莉｣繝ｻ繝ｻ・ｽ郢晢ｽｻ繝ｻ・ｮ FFMPEG_PATH")

            version = self._read_ffmpeg_version(runtime_ffmpeg)
            if not version:
                raise RuntimeError(f"FFmpeg 鬯ｮ・｣陋ｹ繝ｻ・ｽ・ｽ繝ｻ・ｳ鬮ｫ・ｶ隴幢ｽｱ陞ｳ・ｦ郢晢ｽｻ繝ｻ・ｺ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｬ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｽ郢晢ｽｻ繝ｻ・ｧ鬯ｯ・ｮ繝ｻ・ｯ郢晢ｽｻ繝ｻ・ｦ鬩幢ｽ｢隴趣ｽ｢繝ｻ・ｽ繝ｻ・ｻ {runtime_ffmpeg}")
            with self.lock:
                self.ffmpeg_state = "ready"
                self.ffmpeg_version = version
                self.ffmpeg_message = f"FFmpeg {version} 鬯ｮ・ｯ隴趣ｽ｢繝ｻ・ｽ繝ｻ・ｾ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｲ鬯ｮ・ｯ隴擾ｽｴ郢晢ｽｻ郢晢ｽｻ繝ｻ・ｽ郢晢ｽｻ繝ｻ・ｱ鬮ｫ・ｰ郢晢ｽｻ髢ｧ・ｩ郢晢ｽｻ繝ｻ・ｽ郢晢ｽｻ繝ｻ・ｪ" if version else "FFmpeg 鬯ｮ・ｯ隴趣ｽ｢繝ｻ・ｽ繝ｻ・ｾ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｲ鬯ｮ・ｯ隴擾ｽｴ郢晢ｽｻ郢晢ｽｻ繝ｻ・ｽ郢晢ｽｻ繝ｻ・ｱ鬮ｫ・ｰ郢晢ｽｻ髢ｧ・ｩ郢晢ｽｻ繝ｻ・ｽ郢晢ｽｻ繝ｻ・ｪ"
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
        media_path = CACHE_DIR / item.local_relative_path if item.local_relative_path else None
        if media_path and media_path.exists():
            self.store.update_item(
                item.id,
                local_media_url=self._build_media_url(item.local_relative_path),
                audio_variants=item.audio_variants,
                selected_audio_variant_id=item.selected_audio_variant_id,
                cache_status="ready",
                cache_progress=100.0,
                cache_message="缓存完成",
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
            local_relative_path="",
            local_media_url="",
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
            local_relative_path="",
            local_media_url="",
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

    def _outside_window_message(self) -> str:
        if self.max_cache_items <= 0:
            return "Caching is disabled because the cache limit is set to 0"
        return f"Outside active cache window (limit: {self.max_cache_items})"

    def _waiting_message(self) -> str:
        if self.max_cache_items <= 0:
            return "Caching is disabled because the cache limit is set to 0"
        return "Waiting in cache queue"

    def _prewarm_binary_worker(self) -> None:
        try:
            with self.lock:
                if self.ffmpeg_state == "idle":
                    self.ffmpeg_state = "checking"
                    self.ffmpeg_message = "鬯ｮ・ｯ繝ｻ・ｷ郢晢ｽｻ繝ｻ・ｷ鬮｣蛹・ｽｽ・ｳ郢晢ｽｻ繝ｻ・ｻ鬮ｯ貊捺・繝ｻ・｡闖ｫ・ｶ・つ陞ｳ闌ｨ・ｽ・ｹ隴趣ｽ｢繝ｻ・ｽ繝ｻ・ｻ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・､鬩幢ｽ｢隴趣ｽ｢繝ｻ・ｽ繝ｻ・ｻFFmpeg 鬯ｮ・｣陋ｹ繝ｻ・ｽ・ｽ繝ｻ・ｳ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｭ"
            self._ensure_ffmpeg(force_refresh=True)
        except Exception as exc:  # noqa: BLE001
            with self.lock:
                self.ffmpeg_state = "failed"
                self.ffmpeg_message = f"FFmpeg 鬯ｮ・ｯ繝ｻ・ｷ驛｢譎｢・ｽ・ｻ驛｢譎｢・ｽ・ｻ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・､鬩幢ｽ｢隴趣ｽ｢繝ｻ・ｽ繝ｻ・ｻ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・､驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｱ鬯ｯ・ｮ繝ｻ・ｮ髫ｰ・ｳ繝ｻ・ｾ郢晢ｽｻ繝ｻ・ｽ郢晢ｽｻ繝ｻ・･: {exc}"

        try:
            with self.lock:
                if self.binary_state == "idle":
                    self.binary_state = "checking"
                    self.binary_message = "鬯ｮ・ｯ繝ｻ・ｷ郢晢ｽｻ繝ｻ・ｷ鬮｣蛹・ｽｽ・ｳ郢晢ｽｻ繝ｻ・ｻ鬮ｯ貊捺・繝ｻ・｡陋帙・・ｽ・ｽ繝ｻ・ｭ郢晢ｽｻ繝ｻ・ｽ郢晢ｽｻ邵ｺ・､・つ鬯ｮ・ｫ繝ｻ・ｴ髮狗ｿｫ・代・・ｽ繝ｻ・ｽ郢晢ｽｻ繝ｻ・･ BBDown 鬯ｮ・ｫ繝ｻ・ｴ髯ｷ・ｴ郢晢ｽｻ繝ｻ・ｽ繝ｻ・ｽ郢晢ｽｻ繝ｻ・ｴ鬯ｮ・ｫ繝ｻ・ｴ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｽ郢晢ｽｻ繝ｻ・ｰ鬯ｮ・｣陋ｹ繝ｻ・ｽ・ｽ繝ｻ・ｳ驛｢譎｢・ｽ・ｻ郢晢ｽｻ繝ｻ・ｭ"
            self._ensure_bbdown()
        except Exception as exc:  # noqa: BLE001
            with self.lock:
                self.binary_state = "failed"
                self.binary_message = f"BBDown 鬯ｮ・ｫ繝ｻ・ｴ郢晢ｽｻ繝ｻ・ｽ郢晢ｽｻ邵ｺ・､・つ鬯ｮ・ｫ繝ｻ・ｴ髮狗ｿｫ・代・・ｽ繝ｻ・ｽ郢晢ｽｻ繝ｻ・･鬯ｮ・ｯ隶灘･・ｽｽ・ｻ郢ｧ謇假ｽｽ・ｽ繝ｻ・ｽ郢晢ｽｻ繝ｻ・ｱ鬯ｯ・ｮ繝ｻ・ｮ髫ｰ・ｳ繝ｻ・ｾ郢晢ｽｻ繝ｻ・ｽ郢晢ｽｻ繝ｻ・･: {exc}"
