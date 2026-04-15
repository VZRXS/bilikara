from __future__ import annotations

import atexit
import json
import mimetypes
import re
import socket
import threading
import time
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from .bilibili import (
    BilibiliError,
    ManualBindingRequiredError,
    MISSING_BILIBILI_COOKIE_MESSAGE,
    effective_bilibili_cookie,
    fetch_gatcha_candidate,
    fetch_owner_info,
    fetch_video_item,
    refresh_gatcha_cache,
    refresh_gatcha_cache_in_background,
    search_gatcha_cache,
)
from .cache import CacheManager
from .config import (
    BACKUP_FILE,
    CACHE_DIR,
    HOST,
    MAX_CACHE_ITEMS,
    PLAYED_SESSION_DIR,
    PORT,
    STATE_FILE,
    STATIC_DIR,
    ensure_directories,
)
from .store import PlaylistStore

RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)")


class DuplicateSessionRequestError(ValueError):
    def __init__(self, item, session_entry=None, active_item=None) -> None:
        self.item = item
        self.session_entry = session_entry
        self.active_item = active_item
        super().__init__(f"本次已经点过《{item.display_title}》")


class AppContext:
    def __init__(self) -> None:
        ensure_directories()
        self.store = PlaylistStore(STATE_FILE, BACKUP_FILE, PLAYED_SESSION_DIR)
        self.auto_restored_backup = self.store.restore_backup()
        self.cache_manager = CacheManager(self.store, max_cache_items=MAX_CACHE_ITEMS)
        self.cache_manager.prepare_session()
        self._closed = False
        self._server: ThreadingHTTPServer | None = None
        self._host = HOST
        self._port = PORT
        self._shutdown_on_last_client = False
        self._host_client_id: str | None = None
        self._client_lock = threading.RLock()
        self._client_last_seen: dict[str, float] = {}
        self._host_client_last_seen: dict[str, float] = {}
        self._host_seen_once = False
        self._client_seen_once = False
        self._no_clients_since: float | None = None
        self._shutdown_requested = False
        self._client_grace_seconds = 4.0
        self._client_stale_seconds = 120.0
        self._client_watchdog: threading.Thread | None = None
        self._owner_enrichment: threading.Thread | None = None
        self._player_control_lock = threading.RLock()
        self._player_control_seq = 0
        self._player_control_ack_seq = 0
        self._player_control_command: dict[str, object] | None = None
        self._player_status_lock = threading.RLock()
        self._player_status: dict[str, object] | None = None
        self._remote_access_lock = threading.RLock()
        self._remote_access = self._build_remote_access_payload(self._host, self._port, [])
        self._startup_lock = threading.RLock()
        self._startup_started = False

    def snapshot(self) -> dict:
        payload = self.store.snapshot()
        metrics = self.cache_manager.cache_metrics()
        self.cache_manager.enrich_snapshot(payload, metrics)
        payload["bbdown"] = self.cache_manager.status(metrics)
        payload["ffmpeg"] = self.cache_manager.ffmpeg_status()
        payload["cache_policy"] = self.cache_manager.policy_snapshot(metrics)
        payload["session_flags"] = {
            "auto_restored_backup": self.auto_restored_backup,
        }
        payload["remote_access"] = self.remote_access_snapshot()
        payload["player_control_command"] = self.player_control_command_snapshot()
        payload["player_status"] = self.player_status_snapshot(payload.get("current_item"))
        return payload

    def add_item(self, item, *, position: str, requester_name: str) -> None:
        self.store.add_item(item, position=position, requester_name=requester_name)
        self.cache_manager.sync_with_playlist()

    def advance_to_next(self) -> None:
        self.store.advance_to_next()
        self.cache_manager.sync_with_playlist()

    def remove_item(self, item_id: str) -> None:
        self.store.remove_item(item_id)
        self.cache_manager.sync_with_playlist()

    def clear_playlist(self) -> None:
        self.store.clear_playlist()
        self.cache_manager.sync_with_playlist()

    def move_item(self, item_id: str, direction: str) -> None:
        self.store.move_item(item_id, direction)
        self.cache_manager.sync_with_playlist()

    def move_item_to_index(self, item_id: str, index: int) -> None:
        self.store.move_item_to_index(item_id, index)
        self.cache_manager.sync_with_playlist()

    def move_to_next(self, item_id: str) -> None:
        self.store.move_to_next(item_id)
        self.cache_manager.sync_with_playlist()

    def move_to_front(self, item_id: str) -> None:
        self.store.move_to_front(item_id)
        self.cache_manager.sync_with_playlist()

    def set_mode(self, mode: str) -> None:
        self.store.set_mode(mode)

    def set_av_offset_ms(self, offset_ms: int) -> int:
        return self.store.set_av_offset_ms(offset_ms)

    def set_volume_percent(self, volume_percent: int) -> int:
        return self.store.set_volume_percent(volume_percent)

    def set_muted(self, is_muted: bool) -> bool:
        return self.store.set_muted(is_muted)

    def set_audio_variant(self, item_id: str, variant_id: str) -> bool:
        return self.store.set_audio_variant(item_id, variant_id)

    def add_session_user(self, name: str) -> None:
        self.store.add_session_user(name)

    def remove_session_user(self, name: str) -> None:
        self.store.remove_session_user(name)

    def move_session_user_to_index(self, name: str, index: int) -> None:
        self.store.move_session_user_to_index(name, index)

    def set_cache_limit(self, max_cache_items: int) -> None:
        self.cache_manager.set_max_cache_items(max_cache_items)

    def retry_cache_item(self, item_id: str) -> None:
        self.cache_manager.retry_item(item_id)

    def issue_player_control(
        self,
        *,
        action: str,
        item_id: str = "",
        delta_seconds: int = 0,
    ) -> dict[str, object]:
        with self._player_control_lock:
            self._player_control_seq += 1
            self._player_control_command = {
                "seq": self._player_control_seq,
                "action": action,
                "item_id": item_id,
                "delta_seconds": delta_seconds,
                "issued_at": time.time(),
            }
            return dict(self._player_control_command)

    def ack_player_control(self, seq: int) -> None:
        with self._player_control_lock:
            self._player_control_ack_seq = max(self._player_control_ack_seq, int(seq))

    def player_control_command_snapshot(self) -> dict[str, object] | None:
        with self._player_control_lock:
            if not self._player_control_command:
                return None
            if int(self._player_control_command.get("seq") or 0) <= self._player_control_ack_seq:
                return None
            return dict(self._player_control_command)

    def update_player_status(
        self,
        *,
        item_id: str,
        is_paused: bool,
        current_time: float = 0.0,
    ) -> None:
        normalized_item_id = str(item_id or "").strip()
        if not normalized_item_id:
            return
        with self._player_status_lock:
            self._player_status = {
                "item_id": normalized_item_id,
                "is_paused": bool(is_paused),
                "current_time": max(0.0, float(current_time or 0.0)),
                "updated_at": time.time(),
            }

    def player_status_snapshot(self, current_item_payload: object) -> dict[str, object] | None:
        current_item_id = ""
        if isinstance(current_item_payload, dict):
            current_item_id = str(current_item_payload.get("id") or "").strip()
        if not current_item_id:
            return None
        with self._player_status_lock:
            if not self._player_status:
                return None
            if str(self._player_status.get("item_id") or "").strip() != current_item_id:
                return None
            return dict(self._player_status)

    def restore_backup(self) -> bool:
        restored = self.store.restore_backup()
        self.auto_restored_backup = restored or self.auto_restored_backup
        self.cache_manager.sync_with_playlist()
        return restored

    def discard_backup(self) -> bool:
        discarded = self.store.discard_backup()
        if discarded:
            self.auto_restored_backup = False
        return discarded

    def bind_server(self, server: ThreadingHTTPServer, *, shutdown_on_last_client: bool) -> None:
        with self._client_lock:
            self._server = server
            bound_host, bound_port = server.server_address[:2]
            self._host = str(bound_host)
            self._port = int(bound_port)
            self._shutdown_on_last_client = shutdown_on_last_client
            self._client_last_seen.clear()
            self._client_seen_once = False
            self._host_client_last_seen.clear()
            self._host_seen_once = False
            self._no_clients_since = None
            self._shutdown_requested = False
        with self._remote_access_lock:
            self._remote_access = self._build_remote_access_payload(self._host, self._port, [])
        self._start_background_tasks_once()
        threading.Thread(target=self._refresh_remote_access_snapshot, daemon=True).start()

    def remote_access_snapshot(self) -> dict[str, object]:
        with self._remote_access_lock:
            return dict(self._remote_access)

    def touch_client(self, client_id: str, is_host: bool = True) -> None:
        client_key = str(client_id or "").strip()
        if not client_key:
            return
        now = time.monotonic()
        with self._client_lock:
            self._client_last_seen[client_key] = now
            if is_host:
                self._host_client_last_seen[client_key] = now
                self._host_seen_once = True
            self._client_seen_once = True
            self._no_clients_since = None
            self._shutdown_requested = False

    def disconnect_client(self, client_id: str) -> None:
        client_key = str(client_id or "").strip()
        if not client_key:
            return
        now = time.monotonic()
        with self._client_lock:
            self._client_last_seen.pop(client_key, None)
            self._host_client_last_seen.pop(client_key, None)
            self._prune_stale_clients(now)
            if self._host_client_last_seen:
                self._no_clients_since = None
                return
            self._no_clients_since = now

    def _client_watchdog_loop(self) -> None:
        while not self._closed:
            time.sleep(1.0)
            with self._client_lock:
                # 注意：这里改成了依赖 self._host_seen_once
                if not self._shutdown_on_last_client or not self._host_seen_once or self._shutdown_requested:
                    continue
                now = time.monotonic()
                self._prune_stale_clients(now)
                # 注意：这里改成了判断 host_client 字典
                if self._host_client_last_seen:
                    self._no_clients_since = None
                    continue
                if self._no_clients_since is None:
                    self._no_clients_since = now
                    continue
                if now - self._no_clients_since < self._client_grace_seconds:
                    continue
                server = self._server
                if server is None:
                    continue
                self._shutdown_requested = True
            threading.Thread(target=server.shutdown, daemon=True).start()

    def _prune_stale_clients(self, now: float) -> None:
        expired = [
            client_id
            for client_id, last_seen in self._client_last_seen.items()
            if now - last_seen > self._client_stale_seconds
        ]
        for client_id in expired:
            self._client_last_seen.pop(client_id, None)
            self._host_client_last_seen.pop(client_id, None)

    def disconnect_client(self, client_id: str) -> None:
        client_key = str(client_id or "").strip()
        if not client_key:
            return
        now = time.monotonic()
        with self._client_lock:
            self._client_last_seen.pop(client_key, None)
            self._prune_stale_clients(now)
            if self._client_last_seen:
                self._no_clients_since = None
                return
            self._no_clients_since = now

    def shutdown(self) -> None:
        if self._closed:
            return
        self._closed = True
        self.cache_manager.shutdown()

    def _client_watchdog_loop(self) -> None:
        while not self._closed:
            time.sleep(1.0)
            with self._client_lock:
                if not self._shutdown_on_last_client or not self._client_seen_once or self._shutdown_requested:
                    continue
                now = time.monotonic()
                self._prune_stale_clients(now)
                if self._client_last_seen:
                    self._no_clients_since = None
                    continue
                if self._no_clients_since is None:
                    self._no_clients_since = now
                    continue
                if now - self._no_clients_since < self._client_grace_seconds:
                    continue
                server = self._server
                if server is None:
                    continue
                self._shutdown_requested = True
            threading.Thread(target=server.shutdown, daemon=True).start()

    def _prune_stale_clients(self, now: float) -> None:
        expired = [
            client_id
            for client_id, last_seen in self._client_last_seen.items()
            if now - last_seen > self._client_stale_seconds
        ]
        for client_id in expired:
            self._client_last_seen.pop(client_id, None)

    def _owner_enrichment_loop(self) -> None:
        for source_url in self.store.missing_owner_urls():
            if self._closed:
                return
            try:
                owner_mid, owner_name, owner_url = fetch_owner_info(source_url)
            except Exception:  # noqa: BLE001
                continue
            if not owner_name:
                continue
            self.store.update_owner_info_for_url(
                source_url,
                owner_mid=owner_mid,
                owner_name=owner_name,
                owner_url=owner_url,
            )

    def _start_background_tasks_once(self) -> None:
        with self._startup_lock:
            if self._startup_started or self._closed:
                return
            self._startup_started = True
            self.cache_manager.prewarm_binary()
            self._client_watchdog = threading.Thread(target=self._client_watchdog_loop, daemon=True)
            self._client_watchdog.start()
            self._owner_enrichment = threading.Thread(target=self._owner_enrichment_loop, daemon=True)
            self._owner_enrichment.start()

    def _refresh_remote_access_snapshot(self) -> None:
        host = self._host
        port = self._port
        lan_urls = [f"{base}/remote" for base in _network_access_urls(host, port)]
        with self._remote_access_lock:
            if host != self._host or port != self._port:
                return
            self._remote_access = self._build_remote_access_payload(host, port, lan_urls)

    @staticmethod
    def _build_remote_access_payload(
        host: str,
        port: int,
        lan_urls: list[str],
    ) -> dict[str, object]:
        browser_host = "127.0.0.1" if host == "0.0.0.0" else host
        local_url = f"http://{browser_host}:{port}/remote"
        preferred_url = lan_urls[0] if lan_urls else local_url
        return {
            "local_url": local_url,
            "lan_urls": list(lan_urls),
            "preferred_url": preferred_url,
        }


CONTEXT = AppContext()
atexit.register(CONTEXT.shutdown)


class BilikaraHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self) -> None:  # noqa: N802
        route = urlparse(self.path).path
        client_id = self.headers.get("X-Bilikara-Client", "")
        referer = self.headers.get("Referer", "")
        
        # 默认认为是 Host 主屏幕，除非明确来自 Remote
        is_host = True
        if referer and referer.rstrip("/").endswith("/remote"):
            is_host = False
        elif route == "/remote" or route.startswith("/remote/"):
            is_host = False
            
        CONTEXT.touch_client(client_id, is_host=is_host)
        if route == "/api/state":
            self._write_json({"ok": True, "data": CONTEXT.snapshot()})
            return
        if route == "/api/gatcha/candidate":
            try:
                candidate = fetch_gatcha_candidate()
                if not candidate:
                    self._write_json({"ok": False, "error": "没找到符合条件的歌曲，再试一次吧"})
                else:
                    self._write_json({"ok": True, "data": candidate})
            except Exception as e:
                self._write_json({"ok": False, "error": str(e)})
            return
        if route == "/api/gatcha/search":
            query = parse_qs(urlparse(self.path).query).get("q", [""])[0]
            try:
                results = search_gatcha_cache(query)
                self._write_json({"ok": True, "data": {"items": results}})
            except Exception as e:
                self._write_json({"ok": False, "error": str(e)})
            return
        if route.startswith("/media/"):
            self._serve_media(route)
            return
        self._serve_static(route)

    def do_POST(self) -> None:  # noqa: N802
        route = urlparse(self.path).path
        client_id = self.headers.get("X-Bilikara-Client", "")
        referer = self.headers.get("Referer", "")
        
        is_host = True
        if referer and referer.rstrip("/").endswith("/remote"):
            is_host = False
        elif route == "/remote" or route.startswith("/remote/"):
            is_host = False
            
        CONTEXT.touch_client(client_id, is_host=is_host)
        
        try:
            body = self._read_json_body()
            if route == "/api/playlist/add":
                self._handle_add(body)
                return
            if route == "/api/player/next":
                CONTEXT.advance_to_next()
                self._write_json({"ok": True, "data": CONTEXT.snapshot()})
                return
            if route == "/api/playlist/remove":
                self._require_id(body)
                CONTEXT.remove_item(body["item_id"])
                self._write_json({"ok": True, "data": CONTEXT.snapshot()})
                return
            if route == "/api/playlist/clear":
                CONTEXT.clear_playlist()
                self._write_json({"ok": True, "data": CONTEXT.snapshot()})
                return
            if route == "/api/session-users/add":
                name = str(body.get("name") or "").strip()
                CONTEXT.add_session_user(name)
                self._write_json({"ok": True, "data": CONTEXT.snapshot()})
                return
            if route == "/api/session-users/remove":
                name = str(body.get("name") or "").strip()
                if not name:
                    raise ValueError("missing name")
                CONTEXT.remove_session_user(name)
                self._write_json({"ok": True, "data": CONTEXT.snapshot()})
                return
            if route == "/api/session-users/reorder":
                name = str(body.get("name") or "").strip()
                index = body.get("index")
                if not name:
                    raise ValueError("missing name")
                if not isinstance(index, int):
                    raise ValueError("index must be an integer")
                CONTEXT.move_session_user_to_index(name, index)
                self._write_json({"ok": True, "data": CONTEXT.snapshot()})
                return
            if route == "/api/playlist/move":
                self._require_id(body)
                direction = str(body.get("direction") or "")
                if direction not in {"up", "down"}:
                    raise ValueError("direction 必须是 up 或 down")
                CONTEXT.move_item(body["item_id"], direction)
                self._write_json({"ok": True, "data": CONTEXT.snapshot()})
                return
            if route == "/api/playlist/reorder":
                self._require_id(body)
                index = body.get("index")
                if not isinstance(index, int):
                    raise ValueError("index 必须是整数")
                CONTEXT.move_item_to_index(body["item_id"], index)
                self._write_json({"ok": True, "data": CONTEXT.snapshot()})
                return
            if route == "/api/playlist/move-next":
                self._require_id(body)
                CONTEXT.move_to_next(body["item_id"])
                self._write_json({"ok": True, "data": CONTEXT.snapshot()})
                return
            if route == "/api/playlist/play-now":
                self._require_id(body)
                CONTEXT.move_to_front(body["item_id"])
                self._write_json({"ok": True, "data": CONTEXT.snapshot()})
                return
            if route == "/api/mode":
                mode = str(body.get("mode") or "")
                if mode not in {"online", "local"}:
                    raise ValueError("mode 必须是 online 或 local")
                CONTEXT.set_mode(mode)
                self._write_json({"ok": True, "data": CONTEXT.snapshot()})
                return
            if route == "/api/player/av-offset":
                offset_ms = body.get("offset_ms")
                if not isinstance(offset_ms, int):
                    raise ValueError("offset_ms must be an integer")
                CONTEXT.set_av_offset_ms(offset_ms)
                self._write_json({"ok": True, "data": CONTEXT.snapshot()})
                return
            if route == "/api/player/volume":
                volume_percent = body.get("volume_percent")
                is_muted = body.get("is_muted")
                if volume_percent is not None:
                    if not isinstance(volume_percent, int):
                        raise ValueError("volume_percent must be an integer")
                    CONTEXT.set_volume_percent(volume_percent)
                if is_muted is not None:
                    if not isinstance(is_muted, bool):
                        raise ValueError("is_muted must be a boolean")
                    CONTEXT.set_muted(is_muted)
                if volume_percent is None and is_muted is None:
                    raise ValueError("missing volume settings")
                self._write_json({"ok": True, "data": CONTEXT.snapshot()})
                return
            if route == "/api/cache/retry":
                self._require_id(body)
                CONTEXT.retry_cache_item(body["item_id"])
                self._write_json({"ok": True, "data": CONTEXT.snapshot()})
                return
            if route == "/api/player/audio-variant":
                self._require_id(body)
                variant_id = str(body.get("variant_id") or "").strip()
                if not variant_id:
                    raise ValueError("missing variant_id")
                if not CONTEXT.set_audio_variant(body["item_id"], variant_id):
                    raise ValueError("invalid audio variant")
                self._write_json({"ok": True, "data": CONTEXT.snapshot()})
                return
            if route == "/api/player/control":
                action = str(body.get("action") or "").strip()
                item_id = str(body.get("item_id") or "").strip()
                if action not in {"toggle-play", "seek-relative"}:
                    raise ValueError("invalid player control action")
                delta_seconds = int(body.get("delta_seconds") or 0)
                if action == "seek-relative" and delta_seconds == 0:
                    raise ValueError("missing delta_seconds")
                if action == "seek-relative" and abs(delta_seconds) > 300:
                    raise ValueError("delta_seconds too large")
                CONTEXT.issue_player_control(
                    action=action,
                    item_id=item_id,
                    delta_seconds=delta_seconds,
                )
                self._write_json({"ok": True, "data": CONTEXT.snapshot()})
                return
            if route == "/api/player/control-ack":
                seq = body.get("seq")
                if not isinstance(seq, int):
                    raise ValueError("seq must be an integer")
                CONTEXT.ack_player_control(seq)
                self._write_json({"ok": True})
                return
            if route == "/api/player/status":
                item_id = str(body.get("item_id") or "").strip()
                if not item_id:
                    raise ValueError("missing item_id")
                is_paused = body.get("is_paused")
                if not isinstance(is_paused, bool):
                    raise ValueError("is_paused must be boolean")
                current_time = float(body.get("current_time") or 0.0)
                CONTEXT.update_player_status(
                    item_id=item_id,
                    is_paused=is_paused,
                    current_time=current_time,
                )
                self._write_json({"ok": True})
                return
            if route == "/api/cache-policy":
                max_cache_items = body.get("max_cache_items")
                if not isinstance(max_cache_items, int):
                    raise ValueError("max_cache_items 必须是整数")
                CONTEXT.set_cache_limit(max_cache_items)
                self._write_json({"ok": True, "data": CONTEXT.snapshot()})
                return
            if route == "/api/backup/restore":
                if not CONTEXT.restore_backup():
                    raise ValueError("没有可恢复的备份")
                self._write_json({"ok": True, "data": CONTEXT.snapshot()})
                return
            if route == "/api/backup/discard":
                CONTEXT.discard_backup()
                self._write_json({"ok": True, "data": CONTEXT.snapshot()})
                return
            if route == "/api/client/disconnect":
                CONTEXT.disconnect_client(str(body.get("client_id") or ""))
                self._write_json({"ok": True})
                return
            if route == "/api/bbdown/login/start":
                CONTEXT.cache_manager.start_bbdown_login(force_refresh_qr=bool(body.get("force")))
                self._write_json({"ok": True, "data": CONTEXT.snapshot()})
                return
            if route == "/api/bbdown/logout":
                CONTEXT.cache_manager.logout_bbdown()
                self._write_json({"ok": True, "data": CONTEXT.snapshot()})
                return
            if route == "/api/config/cookie":
                sessdata = str(body.get("sessdata", "")).strip()
                jct = str(body.get("bili_jct", "")).strip()
                import bilikara.config as cfg
                if sessdata or jct:
                    if not sessdata or not jct:
                        raise ValueError(MISSING_BILIBILI_COOKIE_MESSAGE)
                    cfg.COOKIE = f"SESSDATA={sessdata}; bili_jct={jct}"
                if not effective_bilibili_cookie():
                    raise ValueError(MISSING_BILIBILI_COOKIE_MESSAGE)
                refresh_gatcha_cache_in_background()
                self._write_json({"ok": True, "message": "配置已实时生效"})
                return
            self._write_json(
                {"ok": False, "error": f"未知接口: {route}"},
                status=HTTPStatus.NOT_FOUND,
            )
        except ManualBindingRequiredError as exc:
            self._write_json(
                {
                    "ok": False,
                    "error": str(exc),
                    "code": "manual_binding_required",
                    "binding": {
                        "title": exc.title,
                        "preferred_page": exc.preferred_page,
                        "pages": [
                            {
                                "page": page.page,
                                "cid": page.cid,
                                "duration": page.duration,
                                "part": page.part,
                            }
                            for page in exc.pages
                        ],
                    },
                },
                status=HTTPStatus.CONFLICT,
            )
        except BilibiliError as exc:
            self._write_json({"ok": False, "error": str(exc)}, status=HTTPStatus.BAD_REQUEST)
        except DuplicateSessionRequestError as exc:
            self._write_json(
                {
                    "ok": False,
                    "error": str(exc),
                    "code": "duplicate_session_request",
                    "duplicate_item": exc.item.to_dict(),
                    "session_entry": exc.session_entry.to_dict() if exc.session_entry else None,
                    "active_item": exc.active_item.to_dict() if exc.active_item else None,
                },
                status=HTTPStatus.CONFLICT,
            )
        except ValueError as exc:
            self._write_json({"ok": False, "error": str(exc)}, status=HTTPStatus.BAD_REQUEST)
        except Exception as exc:  # noqa: BLE001
            self._write_json(
                {"ok": False, "error": f"服务器异常: {exc}"},
                status=HTTPStatus.INTERNAL_SERVER_ERROR,
            )

    def log_message(self, format: str, *args: object) -> None:
        return

    def _handle_add(self, body: dict) -> None:
        url = str(body.get("url") or "").strip()
        position = str(body.get("position") or "tail")
        requester_name = str(body.get("requester_name") or "").strip()
        allow_repeat = bool(body.get("allow_repeat"))
        raw_selected_video_page = body.get("selected_video_page")
        selected_video_page = raw_selected_video_page if isinstance(raw_selected_video_page, int) else None
        raw_selected_audio_pages = body.get("selected_audio_pages")
        selected_audio_pages = raw_selected_audio_pages if isinstance(raw_selected_audio_pages, list) else None
        item = fetch_video_item(
            url,
            selected_video_page=selected_video_page,
            selected_audio_pages=selected_audio_pages,
        )
        existing_session_entry = CONTEXT.store.session_request_for_item(item)
        active_duplicate = CONTEXT.store.active_duplicate_for_item(item)
        if (existing_session_entry or active_duplicate) and not allow_repeat:
            raise DuplicateSessionRequestError(item, existing_session_entry, active_duplicate)
        CONTEXT.add_item(item, position=position, requester_name=requester_name)
        self._write_json({"ok": True, "data": CONTEXT.snapshot()})

    def _serve_static(self, route: str) -> None:
        if route in {"", "/"}:
            relative = "index.html"
        elif route in {"/remote", "/remote/"}:
            relative = "remote.html"
        else:
            relative = route.lstrip("/")
        static_path = (STATIC_DIR / relative).resolve()
        if not str(static_path).startswith(str(STATIC_DIR.resolve())) or not static_path.exists():
            self._write_json({"ok": False, "error": "资源不存在"}, status=HTTPStatus.NOT_FOUND)
            return
        self._stream_file(static_path, content_type=self._guess_type(static_path))

    def _serve_media(self, route: str) -> None:
        relative = route.removeprefix("/media/")
        decoded = unquote(relative)
        media_path = (CACHE_DIR / decoded).resolve()
        if not str(media_path).startswith(str(CACHE_DIR.resolve())) or not media_path.exists():
            self._write_json({"ok": False, "error": "媒体文件不存在"}, status=HTTPStatus.NOT_FOUND)
            return
        self._stream_file(
            media_path,
            content_type=self._guess_type(media_path),
            allow_ranges=True,
        )

    def _read_json_body(self) -> dict:
        raw_length = self.headers.get("Content-Length", "0")
        length = int(raw_length or "0")
        raw_body = self.rfile.read(length) if length > 0 else b"{}"
        payload = json.loads(raw_body.decode("utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("请求体必须是 JSON 对象")
        return payload

    def _require_id(self, body: dict) -> None:
        if not str(body.get("item_id") or "").strip():
            raise ValueError("缺少 item_id")

    def _write_json(self, payload: dict, status: HTTPStatus = HTTPStatus.OK) -> None:
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def _stream_file(
        self,
        file_path: Path,
        *,
        content_type: str,
        allow_ranges: bool = False,
    ) -> None:
        file_size = file_path.stat().st_size
        range_header = self.headers.get("Range", "")
        if allow_ranges and range_header:
            match = RANGE_RE.fullmatch(range_header.strip())
            if match:
                start_str, end_str = match.groups()
                start = int(start_str) if start_str else 0
                end = int(end_str) if end_str else file_size - 1
                end = min(end, file_size - 1)
                if start <= end:
                    self.send_response(HTTPStatus.PARTIAL_CONTENT)
                    self.send_header("Content-Type", content_type)
                    self.send_header("Accept-Ranges", "bytes")
                    self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
                    self.send_header("Content-Length", str(end - start + 1))
                    self.end_headers()
                    with file_path.open("rb") as handle:
                        handle.seek(start)
                        remaining = end - start + 1
                        while remaining > 0:
                            chunk = handle.read(min(64 * 1024, remaining))
                            if not chunk:
                                break
                            self.wfile.write(chunk)
                            remaining -= len(chunk)
                    return

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(file_size))
        if allow_ranges:
            self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
        with file_path.open("rb") as handle:
            while True:
                chunk = handle.read(64 * 1024)
                if not chunk:
                    break
                self.wfile.write(chunk)

    def _guess_type(self, file_path: Path) -> str:
        return mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"


def _serve(
    *,
    host: str = HOST,
    port: int = PORT,
    auto_open_browser: bool = False,
    auto_select_port: bool = False,
    shutdown_on_last_client: bool = False,
    status_label: str = "bilikara",
) -> None:
    actual_port = _find_available_port(host, port) if auto_select_port else port
    server = ThreadingHTTPServer((host, actual_port), BilikaraHandler)
    CONTEXT.bind_server(server, shutdown_on_last_client=shutdown_on_last_client)
    browser_host = "127.0.0.1" if host == "0.0.0.0" else host
    url = f"http://{browser_host}:{actual_port}"
    print(f"{status_label} running on {url}")
    print(f"{status_label} mobile remote: {url}/remote")

    if auto_open_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        CONTEXT.shutdown()
        server.server_close()


def run(
    *,
    host: str = HOST,
    port: int = PORT,
    open_browser: bool = True,
    auto_select_port: bool = True,
    shutdown_on_last_client: bool | None = True,
) -> None:
    close_when_browser_exits = False if shutdown_on_last_client is None else shutdown_on_last_client
    _serve(
        host=host,
        port=port,
        auto_open_browser=open_browser,
        auto_select_port=auto_select_port,
        shutdown_on_last_client=close_when_browser_exits,
        status_label="bilikara",
    )


def run_webui(
    *,
    host: str = HOST,
    port: int = PORT,
    auto_open_browser: bool = True,
    auto_select_port: bool = True,
) -> None:
    run(
        host=host,
        port=port,
        open_browser=auto_open_browser,
        auto_select_port=auto_select_port,
    )


def _find_available_port(host: str, preferred_port: int) -> int:
    for candidate in range(preferred_port, preferred_port + 30):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind((host, candidate))
            except OSError:
                continue
            return candidate
    raise OSError(f"无法为 bilikara 找到可用端口，起始端口: {preferred_port}")


def _network_access_urls(host: str, port: int) -> list[str]:
    if host not in {"0.0.0.0", "::"}:
        return []

    candidates: list[str] = []
    seen: set[str] = set()
    try:
        addresses = socket.getaddrinfo(socket.gethostname(), None, family=socket.AF_INET)
    except OSError:
        addresses = []

    for entry in addresses:
        ip = entry[4][0]
        if ip.startswith("127."):
            continue
        url = f"http://{ip}:{port}"
        if url in seen:
            continue
        seen.add(url)
        candidates.append(url)
    return candidates
