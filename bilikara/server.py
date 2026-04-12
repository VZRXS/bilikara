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
from urllib.parse import unquote, urlparse

from .bilibili import BilibiliError, fetch_video_item
from .cache import CacheManager
from .config import (
    BACKUP_FILE,
    CACHE_DIR,
    HOST,
    MAX_CACHE_ITEMS,
    PORT,
    STATE_FILE,
    STATIC_DIR,
    ensure_directories,
)
from .store import PlaylistStore

RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)")


class AppContext:
    def __init__(self) -> None:
        ensure_directories()
        self.store = PlaylistStore(STATE_FILE, BACKUP_FILE)
        self.auto_restored_backup = self.store.restore_backup()
        self.cache_manager = CacheManager(self.store, max_cache_items=MAX_CACHE_ITEMS)
        self.cache_manager.prepare_session()
        self.cache_manager.prewarm_binary()
        self._closed = False
        self._server: ThreadingHTTPServer | None = None
        self._host = HOST
        self._port = PORT
        self._shutdown_on_last_client = False
        self._client_lock = threading.RLock()
        self._client_last_seen: dict[str, float] = {}
        self._client_seen_once = False
        self._no_clients_since: float | None = None
        self._shutdown_requested = False
        self._client_grace_seconds = 4.0
        self._client_stale_seconds = 120.0
        self._client_watchdog = threading.Thread(target=self._client_watchdog_loop, daemon=True)
        self._client_watchdog.start()

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
        return payload

    def add_item(self, item, *, position: str) -> None:
        self.store.add_item(item, position=position)
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

    def set_cache_limit(self, max_cache_items: int) -> None:
        self.cache_manager.set_max_cache_items(max_cache_items)

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
            self._no_clients_since = None
            self._shutdown_requested = False

    def remote_access_snapshot(self) -> dict[str, object]:
        host = self._host
        port = self._port
        browser_host = "127.0.0.1" if host == "0.0.0.0" else host
        local_url = f"http://{browser_host}:{port}/remote"
        lan_urls = [f"{base}/remote" for base in _network_access_urls(host, port)]
        preferred_url = lan_urls[0] if lan_urls else local_url
        return {
            "local_url": local_url,
            "lan_urls": lan_urls,
            "preferred_url": preferred_url,
        }

    def touch_client(self, client_id: str) -> None:
        client_key = str(client_id or "").strip()
        if not client_key:
            return
        now = time.monotonic()
        with self._client_lock:
            self._client_last_seen[client_key] = now
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


CONTEXT = AppContext()
atexit.register(CONTEXT.shutdown)


class BilikaraHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self) -> None:  # noqa: N802
        CONTEXT.touch_client(self.headers.get("X-Bilikara-Client", ""))
        route = urlparse(self.path).path
        if route == "/api/state":
            self._write_json({"ok": True, "data": CONTEXT.snapshot()})
            return
        if route.startswith("/media/"):
            self._serve_media(route)
            return
        self._serve_static(route)

    def do_POST(self) -> None:  # noqa: N802
        CONTEXT.touch_client(self.headers.get("X-Bilikara-Client", ""))
        route = urlparse(self.path).path
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
            self._write_json(
                {"ok": False, "error": f"未知接口: {route}"},
                status=HTTPStatus.NOT_FOUND,
            )
        except BilibiliError as exc:
            self._write_json({"ok": False, "error": str(exc)}, status=HTTPStatus.BAD_REQUEST)
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
        item = fetch_video_item(url)
        CONTEXT.add_item(item, position=position)
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
    for access_url in _network_access_urls(host, actual_port):
        print(f"{status_label} LAN access: {access_url}")
        print(f"{status_label} mobile remote (LAN): {access_url}/remote")

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
    shutdown_on_last_client: bool | None = False,
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
