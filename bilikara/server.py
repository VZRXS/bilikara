from __future__ import annotations

import atexit
from collections import deque
from email.utils import formatdate
import hmac
import ipaddress
import json
import math
import mimetypes
import os
import re
import socket
import sys
import threading
import time
import webbrowser
from http.cookies import SimpleCookie
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from .bilibili import (
    BilibiliError,
    ManualBindingRequiredError,
    MISSING_BILIBILI_COOKIE_MESSAGE,
    add_gatcha_uid,
    annotate_gatcha_local_status,
    browse_gatcha_cache,
    browse_gatcha_favlist,
    effective_bilibili_cookie,
    fetch_gatcha_candidate,
    gatcha_pool_config_detail,
    gatcha_pool_config_snapshot,
    gatcha_favlist_updated_at,
    gatcha_task_snapshot,
    fetch_owner_info,
    fetch_video_item,
    gatcha_uid_snapshot,
    preview_gatcha_favlist,
    preview_gatcha_uid,
    refresh_gatcha_cache_in_background,
    refresh_gatcha_favlist,
    search_gatcha_cache,
    update_gatcha_pool_config,
)
from .lark_pool_client import (
    LarkPoolError,
    append_lark_pool_entries_in_background,
    approve_cloudflare_review_items,
    browse_d1_category_pool,
    browse_d1_pool,
    delete_cloudflare_mid_entries,
    delete_cloudflare_pool_entry,
    delete_cloudflare_video_entry,
    list_cloudflare_blacklist,
    pending_cloudflare_review_items,
    prewarm_cloudflare_pool,
    reject_cloudflare_review_item,
    reset_cloudflare_video_tags,
    restore_cloudflare_blacklist_item,
    search_lark_pool,
    search_lark_pool_table,
    submit_cloudflare_song_rating,
    verify_cloudflare_bilikara_secret,
)
from .cache import CacheManager
from .rust_backend import PlaybackCapabilityError
from .config import (
    APP_RELEASES_URL,
    APP_VERSION,
    BACKUP_FILE,
    CACHE_DIR,
    HOST,
    MAX_CACHE_ITEMS,
    PLAYED_SESSION_DIR,
    PORT,
    REMOTE_IDENTITIES_FILE,
    STATE_FILE,
    STATIC_DIR,
    ensure_directories,
)
from .diagnostics import DiagnosticArtifact, build_diagnostic_artifact, redact_text
from .models import HistoryEntry, PlaylistItem
from .networking import detect_lan_ipv4_addresses
from .playlist_export import (
    playlist_csv_bytes,
    playlist_image_export,
    prewarm_playlist_export_fonts,
)
from .remote_identity import RemoteIdentityStore
from .store import MAX_SAFE_JSON_INTEGER, PlaylistStore, PlaylistStoreCommandError
from .updater import AppUpdateManager, check_for_update

mimetypes.add_type("video/mp4", ".mp4")
mimetypes.add_type("video/mp4", ".m4s")
mimetypes.add_type("audio/mp4", ".m4a")

RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)")
BVID_IN_TEXT_RE = re.compile(r"BV[0-9A-Za-z]{10}")
RATING_SUBMISSION_KEY_LIMIT = 2000
PLAYER_DIAGNOSTIC_LIMIT = 128
PLAYER_DIAGNOSTIC_URL_RE = re.compile(r"(?i)\b(?:https?|file)://[^\s<>\"']+")
MISSING_BILIBILI_VIDEO_MESSAGE = "啥都木有"
PLAYER_STATUS_MAX_SECONDS = 7 * 24 * 60 * 60
PLAYER_STATUS_ITEM_ID_MAX_BYTES = 512
PLAYER_STATUS_PHASES = frozenset(
    {
        "ready-paused",
        "starting",
        "playing",
        "paused",
        "needs-user-gesture",
        "failed",
        "ended",
    }
)
REMOTE_IDENTITY_COOKIE = "bilikara_remote_token"
REMOTE_IDENTITY_COOKIE_MAX_AGE = 365 * 24 * 60 * 60
CONTAINER_RUNTIME_MARKERS = ("docker", "containerd", "kubepods", "lxc")
LOCAL_EXPORT_SHUTDOWN_GRACE_SECONDS = 10.0


def _positive_safe_player_status_integer(value: object, field: str) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or value < 1
        or value > MAX_SAFE_JSON_INTEGER
    ):
        raise ValueError(f"{field} must be a positive safe integer")
    return value


def _bounded_player_status_number(value: object, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{field} must be a number")
    number = float(value)
    if not math.isfinite(number) or number < 0 or number > PLAYER_STATUS_MAX_SECONDS:
        raise ValueError(f"{field} must be finite and within the supported range")
    return number


def _normalize_player_status_observation(
    *,
    playback_generation: object,
    status_sequence: object,
    item_id: object,
    observed_phase: object,
    is_paused: object,
    current_time: object,
    duration: object,
    client_info: object | None = None,
) -> dict[str, object]:
    generation = _positive_safe_player_status_integer(
        playback_generation, "playback_generation"
    )
    sequence = _positive_safe_player_status_integer(status_sequence, "status_sequence")
    if not isinstance(item_id, str):
        raise ValueError("item_id must be a bounded non-empty string")
    normalized_item_id = item_id.strip()
    if (
        not normalized_item_id
        or "\0" in normalized_item_id
        or len(normalized_item_id.encode("utf-8")) > PLAYER_STATUS_ITEM_ID_MAX_BYTES
    ):
        raise ValueError("item_id must be a bounded non-empty string")
    if not isinstance(observed_phase, str):
        raise ValueError("observed_phase is invalid")
    phase = observed_phase.strip()
    if phase not in PLAYER_STATUS_PHASES:
        raise ValueError("observed_phase is invalid")
    if not isinstance(is_paused, bool):
        raise ValueError("is_paused must be boolean")
    expected_paused = phase != "playing"
    if is_paused is not expected_paused:
        raise ValueError("is_paused conflicts with observed_phase")

    normalized: dict[str, object] = {
        "playback_generation": generation,
        "status_sequence": sequence,
        "item_id": normalized_item_id,
        "observed_phase": phase,
        "is_paused": is_paused,
        "current_time": _bounded_player_status_number(current_time, "current_time"),
        "duration": _bounded_player_status_number(duration, "duration"),
    }
    if isinstance(client_info, dict):
        normalized["client_info"] = {
            "user_agent": str(client_info.get("user_agent") or "")[:500],
            "platform": str(client_info.get("platform") or "")[:120],
            "language": str(client_info.get("language") or "")[:80],
            "vendor": str(client_info.get("vendor") or "")[:120],
        }
    return normalized


def _projected_player_status(status: dict[str, object]) -> dict[str, object]:
    projection = {
        key: status[key]
        for key in (
            "playback_generation",
            "item_id",
            "observed_phase",
            "is_paused",
            "current_time",
            "duration",
            "updated_at",
        )
        if key in status
    }
    if isinstance(status.get("client_info"), dict):
        projection["client_info"] = dict(status["client_info"])
    return projection


def _comparable_player_status(status: dict[str, object]) -> dict[str, object]:
    comparable = _projected_player_status(status)
    comparable.pop("updated_at", None)
    return comparable


def _player_diagnostic_number(value: object) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _player_diagnostic_text(value: object, limit: int, *, redact_urls: bool = True) -> str:
    text = str(value or "")
    if redact_urls:
        text = PLAYER_DIAGNOSTIC_URL_RE.sub("[REDACTED_MEDIA_URL]", text)
    return redact_text(text)[:limit]


def _player_diagnostic_basename(value: object) -> str:
    text = str(value or "").split("?", 1)[0].split("#", 1)[0].replace("\\", "/")
    return redact_text(text.rsplit("/", 1)[-1])[:255]


def _normalize_player_diagnostic(body: dict[str, object]) -> dict[str, object]:
    numeric_fields = (
        "current_time",
        "duration",
        "ready_state",
        "network_state",
        "playback_rate",
        "buffered_end",
        "error_code",
        "audio_current_time",
        "video_current_time",
        "target_video_time",
        "drift_seconds",
        "effective_av_delay_seconds",
        "audio_playback_rate",
        "video_playback_rate",
        "audio_ready_state",
        "video_ready_state",
        "audio_network_state",
        "video_network_state",
        "audio_buffered_end",
        "video_buffered_end",
        "dropped_video_frames",
        "total_video_frames",
    )
    boolean_fields = (
        "paused",
        "seeking",
        "ended",
        "audio_paused",
        "video_paused",
        "audio_seeking",
        "video_seeking",
        "audio_ended",
        "video_ended",
        "local_should_be_playing",
        "local_audio_playback_blocked",
        "local_video_playback_blocked",
        "is_webkit_runtime",
        "is_tauri_runtime",
        "is_tauri_webkit_runtime",
    )
    event: dict[str, object] = {
        "event": _player_diagnostic_text(body.get("event"), 40),
        "item_id": _player_diagnostic_text(body.get("item_id"), 80),
        "media_kind": _player_diagnostic_text(body.get("media_kind"), 20),
        "error_message": _player_diagnostic_text(
            body.get("error_message"),
            500,
            redact_urls=True,
        ),
        "play_rejection_name": _player_diagnostic_text(body.get("play_rejection_name"), 80),
        "url_basename": _player_diagnostic_basename(body.get("url_basename")),
        "synchronization_action": _player_diagnostic_text(
            body.get("synchronization_action") or "none",
            40,
        ),
        "playback_start_state": _player_diagnostic_text(
            body.get("playback_start_state"),
            40,
        ),
    }
    event.update({field: _player_diagnostic_number(body.get(field)) for field in numeric_fields})
    event.update({field: bool(body.get(field)) for field in boolean_fields})
    return event


def _serialize_sse_event(event: str, payload: dict[str, object]) -> bytes:
    encoded = json.dumps(payload, ensure_ascii=False)
    chunks = [f"event: {event}\n".encode("utf-8")]
    chunks.extend(f"data: {line}\n".encode("utf-8") for line in encoded.splitlines() or ["{}"])
    chunks.append(b"\n")
    return b"".join(chunks)


def _normalized_ip_address(value: object) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    text = str(value or "").strip()
    if not text:
        return None
    if "%" in text:
        text = text.split("%", 1)[0]
    try:
        address = ipaddress.ip_address(text)
    except ValueError:
        return None
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
        return address.ipv4_mapped
    return address


def _url_host(host: str) -> str:
    return f"[{host}]" if ":" in host and not host.startswith("[") else host


def _local_ui_host(bind_host: str) -> str:
    if bind_host in {"0.0.0.0", "::"}:
        return "127.0.0.1"
    return bind_host


def _local_ui_url(bind_host: str, port: int) -> str:
    return f"http://{_url_host(_local_ui_host(bind_host))}:{port}"


def _is_container_runtime() -> bool:
    if Path("/.dockerenv").exists():
        return True
    try:
        cgroup = Path("/proc/1/cgroup").read_text(encoding="utf-8", errors="replace").lower()
    except OSError:
        return False
    return any(marker in cgroup for marker in CONTAINER_RUNTIME_MARKERS)


def _is_path_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _is_path_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _is_path_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


class DuplicateSessionRequestError(ValueError):
    def __init__(self, item, session_entry=None, active_item=None) -> None:
        self.item = item
        self.session_entry = session_entry
        self.active_item = active_item
        super().__init__(f"本次已经点过《{item.display_title}》")


class SessionUserAlreadyExistsError(ValueError):
    def __init__(self, name: str) -> None:
        self.name = name
        super().__init__("该用户已存在")


class PlayerStatusAdmissionError(ValueError):
    def __init__(self, kind: str, message: str) -> None:
        self.kind = str(kind or "player_status_rejected")
        super().__init__(message)


class AppContext:
    def __init__(self) -> None:
        ensure_directories()
        self._state_change_condition = threading.Condition()
        self._state_revision = 0
        self._sse_payload_condition = threading.Condition()
        self._sse_payload_revision = -1
        self._sse_payload = b""
        self._sse_payload_building = False
        self.store = PlaylistStore(
            STATE_FILE,
            BACKUP_FILE,
            PLAYED_SESSION_DIR,
            on_change=self._notify_state_changed,
        )
        self.remote_identities = RemoteIdentityStore(REMOTE_IDENTITIES_FILE)
        self._remote_identity_lock = threading.RLock()
        self.auto_restored_backup = self.store.restore_backup()
        self.cache_manager = CacheManager(
            self.store,
            max_cache_items=MAX_CACHE_ITEMS,
            on_bbdown_login_success=self.refresh_startup_gatcha_cache_in_background,
        )
        self.update_manager = AppUpdateManager(
            on_status_change=self._notify_state_changed,
            on_restart_requested=self._request_update_restart,
        )
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
        self._active_local_exports = 0
        self._local_export_idle = threading.Event()
        self._local_export_idle.set()
        self._client_grace_seconds = 4.0
        self._client_stale_seconds = 120.0
        self._client_watchdog: threading.Thread | None = None
        self._owner_enrichment: threading.Thread | None = None
        self._cloudflare_prewarm: threading.Thread | None = None
        self._playlist_export_prewarm: threading.Thread | None = None
        self._player_control_lock = threading.RLock()
        self._player_control_seq = 0
        self._player_control_ack_seq = 0
        self._player_control_command: dict[str, object] | None = None
        self._player_status_lock = threading.RLock()
        self._player_status: dict[str, object] | None = None
        self._player_diagnostic_lock = threading.RLock()
        self._player_diagnostic_sequence = 0
        self._player_diagnostics: deque[dict[str, object]] = deque(
            maxlen=PLAYER_DIAGNOSTIC_LIMIT
        )
        self._remote_access_lock = threading.RLock()
        self._remote_access = self._build_remote_access_payload(self._host, self._port, [])
        self._startup_lock = threading.RLock()
        self._startup_started = False
        self._startup_gatcha_refresh_bypass_available = True
        self._rating_submission_lock = threading.RLock()
        self._rating_submission_keys: set[tuple[str, str]] = set()
        self._rating_submission_key_order: deque[tuple[str, str]] = deque()

    def snapshot(self) -> dict:
        self.cache_manager.reconcile_cache_state()
        with self._state_change_condition:
            state_revision = self._state_revision
        payload = self.store.snapshot()
        payload["session_played"] = self.store.session_played_snapshot()[-2:]
        metrics = self.cache_manager.cache_metrics()
        self.cache_manager.enrich_snapshot(payload, metrics)
        payload["bbdown"] = self.cache_manager.status(metrics)
        payload["ffmpeg"] = self.cache_manager.ffmpeg_status()
        payload["cache_policy"] = self.cache_manager.policy_snapshot(metrics)
        payload["session_flags"] = {
            "auto_restored_backup": self.auto_restored_backup,
        }
        payload["remote_session_id"] = self.remote_identities.snapshot_session_id()
        payload["remote_access"] = self.remote_access_snapshot()
        payload["gatcha"] = gatcha_task_snapshot()
        payload["gatcha_pool_config"] = gatcha_pool_config_snapshot()
        payload["gatcha_favlist_updated_at"] = gatcha_favlist_updated_at()
        payload["player_control_command"] = self.player_control_command_snapshot()
        payload["player_status"] = self.player_status_snapshot(payload)
        payload["app"] = {
            "version": APP_VERSION,
            "releases_url": APP_RELEASES_URL,
        }
        payload["app_update"] = self.app_update_snapshot()
        payload["state_revision"] = state_revision
        return payload

    def serialized_sse_state_event(self) -> tuple[int, bytes]:
        while True:
            with self._sse_payload_condition:
                with self._state_change_condition:
                    state_revision = self._state_revision
                if self._sse_payload_revision == state_revision:
                    return self._sse_payload_revision, self._sse_payload
                if not self._sse_payload_building:
                    self._sse_payload_building = True
                    break
                self._sse_payload_condition.wait()

        try:
            while True:
                snapshot = self.snapshot()
                snapshot_revision = int(snapshot.get("state_revision") or 0)
                serialized = _serialize_sse_event("state", snapshot)
                with self._sse_payload_condition:
                    with self._state_change_condition:
                        revision_is_current = self._state_revision == snapshot_revision
                    if not revision_is_current:
                        continue
                    self._sse_payload_revision = snapshot_revision
                    self._sse_payload = serialized
                    self._sse_payload_building = False
                    self._sse_payload_condition.notify_all()
                    return snapshot_revision, serialized
        except BaseException:
            with self._sse_payload_condition:
                self._sse_payload_building = False
                self._sse_payload_condition.notify_all()
            raise

    def refresh_gatcha_cache_in_background(self) -> bool:
        return refresh_gatcha_cache_in_background(
            on_start=self._notify_state_changed,
            on_done=self._notify_state_changed,
        )

    def app_update_snapshot(self) -> dict[str, object]:
        return self.update_manager.snapshot()

    def record_player_diagnostic(self, event: dict[str, object]) -> dict[str, object]:
        with self._player_diagnostic_lock:
            self._player_diagnostic_sequence += 1
            retained = {
                **event,
                "sequence": self._player_diagnostic_sequence,
                "received_at_unix_ms": int(time.time() * 1000),
            }
            self._player_diagnostics.append(retained)
            return dict(retained)

    def player_diagnostic_snapshot(self) -> list[dict[str, object]]:
        with self._player_diagnostic_lock:
            return [dict(event) for event in self._player_diagnostics]

    def build_diagnostics(
        self,
        browser_info: dict[str, object] | None = None,
        export_diagnostics: list[dict[str, object]] | None = None,
    ) -> DiagnosticArtifact:
        store_snapshot = self.store.snapshot()
        current_item = store_snapshot.get("current_item")
        playlist = store_snapshot.get("playlist") or []
        runtime_state = {
            "current_item": self._diagnostic_item_snapshot(current_item),
            "queued_items": [
                self._diagnostic_item_snapshot(item)
                for item in playlist[:10]
                if isinstance(item, dict)
            ],
            "queue_count": len(playlist),
            "gatcha_task": gatcha_task_snapshot(),
            "app_update": self.app_update_snapshot(),
            "player_diagnostics": self.player_diagnostic_snapshot(),
            "state_revision": self._state_revision,
        }
        metrics = self.cache_manager.cache_metrics()
        local_usernames = [
            str(name)
            for name in store_snapshot.get("session_users") or []
        ]
        return build_diagnostic_artifact(
            cache_manager=self.cache_manager,
            cache_policy=self.cache_manager.policy_snapshot(metrics),
            runtime_state=runtime_state,
            browser_info=browser_info,
            export_diagnostics=export_diagnostics,
            local_usernames=local_usernames,
        )

    @staticmethod
    def _diagnostic_item_snapshot(item: object) -> dict[str, object] | None:
        if not isinstance(item, dict):
            return None
        return {
            "id": str(item.get("id") or ""),
            "bvid": str(item.get("bvid") or ""),
            "title": str(item.get("display_title") or item.get("title") or ""),
            "cache_status": str(item.get("cache_status") or ""),
            "cache_progress": item.get("cache_progress"),
            "cache_message": str(item.get("cache_message") or ""),
        }

    def start_app_update(self, *, include_preview: bool = False) -> dict[str, object]:
        return self.update_manager.start(include_preview=include_preview)

    def refresh_startup_gatcha_cache_in_background(self) -> bool:
        with self._startup_lock:
            if not self._startup_gatcha_refresh_bypass_available:
                return self.refresh_gatcha_cache_in_background()
            self._startup_gatcha_refresh_bypass_available = False
        return refresh_gatcha_cache_in_background(
            use_global_lock=False,
            upload_default_uids_to_lark=False,
            startup_schema_rebuild=True,
        )

    def add_item(
        self,
        item,
        *,
        position: str,
        requester_name: str,
        allow_repeat: bool,
    ) -> None:
        self.store.add_item(
            item,
            position=position,
            requester_name=requester_name,
            reset_av_delay=self.cache_manager.reset_offset_on_next,
            allow_repeat=allow_repeat,
        )
        self.cache_manager.sync_with_playlist()

    def has_session_users(self) -> bool:
        return self.store.has_session_users()

    def register_rating_submission(self, session_user_name: str, play_id: str) -> bool:
        key = (str(session_user_name or "").strip().casefold(), str(play_id or "").strip())
        if not key[0] or not key[1]:
            return False
        with self._rating_submission_lock:
            if key in self._rating_submission_keys:
                return False
            self._rating_submission_keys.add(key)
            key_order = getattr(self, "_rating_submission_key_order", None)
            if key_order is None:
                key_order = deque()
                self._rating_submission_key_order = key_order
            key_order.append(key)
            while len(key_order) > RATING_SUBMISSION_KEY_LIMIT:
                old_key = key_order.popleft()
                self._rating_submission_keys.discard(old_key)
            return True

    def advance_to_next(self, expected_playback_generation: int) -> None:
        self.store.advance_to_next(
            expected_playback_generation=expected_playback_generation,
            reset_av_delay=self.cache_manager.reset_offset_on_next
        )
        self.cache_manager.sync_with_playlist()

    def remove_item(self, item_id: str) -> None:
        self.store.remove_item(item_id)
        self.cache_manager.sync_with_playlist()

    def clear_playlist(self) -> None:
        self.store.clear_playlist()
        self.cache_manager.sync_with_playlist()

    def clear_history(self) -> None:
        self.store.clear_history()

    def remove_history_entry(self, key: str) -> None:
        self.store.remove_history_entry(key)

    def history_snapshot(self) -> list[dict]:
        history = self.store.snapshot().get("history") or []
        return list(history) if isinstance(history, list) else []

    def session_played_snapshot(self) -> list[dict]:
        return self.store.session_played_snapshot()

    def move_item(self, item_id: str, direction: str) -> None:
        self.store.move_item(item_id, direction)
        self.cache_manager.sync_with_playlist()

    def move_item_to_index(self, item_id: str, index: int) -> None:
        self.store.move_item_to_index(item_id, index)
        self.cache_manager.sync_with_playlist()

    def resort_playlist_by_cycle(self) -> None:
        self.store.resort_playlist_by_cycle()
        self.cache_manager.sync_with_playlist()

    def move_to_next(self, item_id: str) -> None:
        self.store.move_to_next(item_id)
        self.cache_manager.sync_with_playlist()

    def move_to_front(self, item_id: str) -> None:
        self.store.move_to_front(
            item_id, reset_av_delay=self.cache_manager.reset_offset_on_next
        )
        self.cache_manager.sync_with_playlist()

    def set_mode(self, mode: str) -> None:
        self.store.set_mode(mode)

    def set_av_offset_ms(self, offset_ms: int) -> int:
        return self.store.set_av_offset_ms(offset_ms)

    def apply_av_delay_action(self, action: dict[str, object]) -> dict[str, object]:
        return self.store.apply_av_delay_action(action)

    def set_volume_percent(self, volume_percent: int) -> int:
        return self.store.set_volume_percent(volume_percent)

    def set_muted(self, is_muted: bool) -> bool:
        return self.store.set_muted(is_muted)

    def set_song_advance_delay_seconds(self, delay_seconds: int) -> int:
        return self.store.set_song_advance_delay_seconds(delay_seconds)

    def set_key_shift(self, key_shift: int) -> int:
        return self.store.set_key_shift(key_shift)

    def set_audio_variant(self, item_id: str, variant_id: str) -> bool:
        return self.store.set_audio_variant(item_id, variant_id)

    def add_session_user(self, name: str) -> None:
        self.store.add_session_user(name)

    def remove_session_user(self, name: str) -> None:
        with self._remote_identity_lock:
            if self.store.remove_session_user(name):
                self.remote_identities.revoke_name(name)

    def remote_identity_snapshot(self, token: str) -> dict[str, object]:
        with self._remote_identity_lock:
            name = self.remote_identities.resolve(token)
            if name and not self.store.has_session_user(name):
                self.remote_identities.revoke_token(token)
                name = ""
            return {
                "registered": bool(name),
                "name": name,
                "session_id": self.remote_identities.snapshot_session_id(),
            }

    def register_remote_identity(self, name: str, *, claim: bool = False) -> tuple[str, dict[str, object]]:
        with self._remote_identity_lock:
            normalized = self.store.normalize_session_user_name(name)
            if not normalized:
                raise ValueError("用户名不能为空")
            newly_added = False
            if self.store.has_session_user(normalized):
                if not claim:
                    raise SessionUserAlreadyExistsError(normalized)
            else:
                self.store.add_session_user(normalized)
                newly_added = True
            try:
                token = self.remote_identities.issue(normalized)
            except Exception:
                if newly_added:
                    self.store.remove_session_user(normalized)
                raise
            return token, {
                "registered": True,
                "name": normalized,
                "session_id": self.remote_identities.snapshot_session_id(),
            }

    def rename_remote_identity(self, token: str, new_name: str) -> dict[str, object]:
        with self._remote_identity_lock:
            current_name = self.remote_identities.resolve(token)
            if not current_name or not self.store.has_session_user(current_name):
                self.remote_identities.revoke_token(token)
                raise ValueError("remote identity is no longer valid")
            renamed = self.store.rename_session_user(current_name, new_name)
            if not self.remote_identities.rename(token, renamed):
                raise ValueError("remote identity is no longer valid")
            self._rename_rating_identity(current_name, renamed)
            return {
                "registered": True,
                "name": renamed,
                "session_id": self.remote_identities.snapshot_session_id(),
            }

    def _rename_rating_identity(self, current_name: str, new_name: str) -> None:
        current_key = str(current_name or "").strip().casefold()
        new_key = str(new_name or "").strip().casefold()
        if not current_key or current_key == new_key:
            return
        with self._rating_submission_lock:
            renamed_order = deque(
                (new_key if user_name == current_key else user_name, play_id)
                for user_name, play_id in self._rating_submission_key_order
            )
            self._rating_submission_key_order = renamed_order
            self._rating_submission_keys = set(renamed_order)

    def move_session_user_to_index(self, name: str, index: int) -> None:
        self.store.move_session_user_to_index(name, index)

    def set_cache_policy(
        self,
        *,
        max_cache_items: int | None = None,
        video_quality: str | None = None,
        audio_hires: bool | None = None,
        download_source: str | None = None,
        reset_offset_on_next: bool | None = None,
    ) -> None:
        self.cache_manager.set_cache_policy(
            max_cache_items=max_cache_items,
            video_quality=video_quality,
            audio_hires=audio_hires,
            download_source=download_source,
            reset_offset_on_next=reset_offset_on_next,
        )
        self._notify_state_changed()

    def cache_downloader_status(self, download_source: str) -> dict[str, object]:
        return self.cache_manager.downloader_status(download_source)

    def prepare_cache_downloader(self, download_source: str) -> dict[str, object]:
        result = self.cache_manager.prepare_downloader(download_source)
        self._notify_state_changed()
        return result

    def set_client_media_capabilities(self, payload: dict[str, object]) -> dict[str, object]:
        result = self.cache_manager.set_client_media_capabilities(payload)
        self._notify_state_changed()
        return result

    def retry_cache_item(self, item_id: str, *, force: bool = False) -> None:
        self.cache_manager.retry_item(item_id, force=force)

    def is_current_item(self, item_id: str) -> bool:
        return self.store.is_current_item(item_id)

    def issue_player_control(
        self,
        *,
        action: str,
        item_id: str = "",
        delta_seconds: int = 0,
        target_seconds: float | None = None,
    ) -> dict[str, object]:
        with self._player_control_lock:
            self._player_control_seq += 1
            self._player_control_command = {
                "seq": self._player_control_seq,
                "action": action,
                "item_id": item_id,
                "delta_seconds": delta_seconds,
                "target_seconds": target_seconds,
                "issued_at": time.time(),
            }
            command = dict(self._player_control_command)
        self._notify_state_changed()
        return command

    def ack_player_control(self, seq: int) -> None:
        with self._player_control_lock:
            self._player_control_ack_seq = max(self._player_control_ack_seq, int(seq))
        self._notify_state_changed()

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
        playback_generation: int,
        status_sequence: int,
        item_id: str,
        observed_phase: str,
        is_paused: bool,
        current_time: float = 0.0,
        duration: float = 0.0,
        client_info: object | None = None,
    ) -> dict[str, object]:
        normalized = _normalize_player_status_observation(
            playback_generation=playback_generation,
            status_sequence=status_sequence,
            item_id=item_id,
            observed_phase=observed_phase,
            is_paused=is_paused,
            current_time=current_time,
            duration=duration,
            client_info=client_info,
        )
        generation = int(normalized["playback_generation"])
        sequence = int(normalized["status_sequence"])
        normalized_item_id = str(normalized["item_id"])

        # AppContext.snapshot() observes the store before the status slot. Keep
        # the same order here so a ThreadingHTTPServer status request cannot
        # deadlock with or cross an AppState program mutation.
        with self.store.lock:
            with self._player_status_lock:
                previous = (
                    dict(self._player_status)
                    if isinstance(self._player_status, dict)
                    else None
                )
                same_status_lifetime = bool(
                    previous
                    and previous.get("playback_generation") == generation
                    and previous.get("item_id") == normalized_item_id
                )
                if same_status_lifetime and not normalized["duration"]:
                    normalized["duration"] = previous.get("duration", 0.0)
                candidate = {
                    key: value
                    for key, value in normalized.items()
                    if key != "status_sequence"
                }
                previous_sequence = (
                    int(previous.get("status_sequence") or 0)
                    if same_status_lifetime and previous
                    else 0
                )
                if sequence < previous_sequence:
                    raise PlayerStatusAdmissionError(
                        "player_status_sequence_stale",
                        "player status sequence is older than the accepted observation",
                    )
                duplicate = sequence == previous_sequence and previous_sequence > 0
                if duplicate and _comparable_player_status(candidate) != _comparable_player_status(
                    previous
                ):
                    raise PlayerStatusAdmissionError(
                        "player_status_sequence_conflict",
                        "player status sequence was replayed with a conflicting observation",
                    )

            try:
                semantic_result = self.store.apply_player_status_observation(
                    expected_playback_generation=generation,
                    item_id=normalized_item_id,
                    is_paused=bool(normalized["is_paused"]),
                    current_time=float(normalized["current_time"]),
                    duration=float(normalized["duration"]),
                )
            except PlaylistStoreCommandError as exc:
                raise PlayerStatusAdmissionError(exc.kind, str(exc)) from exc

            if duplicate:
                return {"accepted": True, "duplicate": True, "changed": False}

            with self._player_status_lock:
                previous = (
                    dict(self._player_status)
                    if isinstance(self._player_status, dict)
                    else None
                )
                visible_changed = (
                    previous is None
                    or _comparable_player_status(candidate)
                    != _comparable_player_status(previous)
                )
                if visible_changed:
                    self._player_status = {
                        **candidate,
                        "status_sequence": sequence,
                        "updated_at": time.time(),
                    }
                else:
                    self._player_status = {
                        **previous,
                        "status_sequence": sequence,
                    }

            if visible_changed and not semantic_result["changed"]:
                self._notify_state_changed()
            return {
                "accepted": True,
                "duplicate": False,
                "changed": visible_changed,
            }

    def player_status_snapshot(self, authoritative_snapshot: object) -> dict[str, object] | None:
        if not isinstance(authoritative_snapshot, dict):
            return None
        current_item = authoritative_snapshot.get("current_item")
        playback_program = authoritative_snapshot.get("playback_program")
        playback_generation = authoritative_snapshot.get("playback_generation")
        if not isinstance(current_item, dict) or not isinstance(playback_program, dict):
            return None
        current_item_id = str(current_item.get("id") or "").strip()
        program_item_id = str(playback_program.get("item_id") or "").strip()
        if (
            not current_item_id
            or current_item_id != program_item_id
            or isinstance(playback_generation, bool)
            or not isinstance(playback_generation, int)
        ):
            return None
        with self._player_status_lock:
            if not self._player_status:
                return None
            if (
                self._player_status.get("playback_generation") != playback_generation
                or str(self._player_status.get("item_id") or "").strip()
                != current_item_id
            ):
                return None
            return _projected_player_status(self._player_status)

    def restore_backup(self) -> bool:
        restored = self.store.restore_backup(
            reset_av_delay=self.cache_manager.reset_offset_on_next
        )
        self.auto_restored_backup = restored or self.auto_restored_backup
        self.cache_manager.sync_with_playlist()
        return restored

    def continue_previous_session(self) -> bool:
        return self.store.continue_previous_session()

    def discard_backup(self) -> bool:
        discarded = self.store.discard_backup()
        if discarded:
            self.auto_restored_backup = False
        self.cache_manager.sync_with_playlist()
        return discarded

    def reset_runtime_data(self) -> None:
        self.cache_manager.clear_runtime_cache()
        with self._remote_identity_lock:
            self.store.reset_runtime_data()
            self.remote_identities.rotate_session()
            with self._rating_submission_lock:
                self._rating_submission_keys.clear()
                self._rating_submission_key_order.clear()
        self.auto_restored_backup = False
        with self._player_control_lock:
            self._player_control_ack_seq = self._player_control_seq
            self._player_control_command = None
        with self._player_status_lock:
            self._player_status = None
        self._notify_state_changed()

    def reset_player_state(self) -> None:
        self.store.reset_player_state()
        with self._player_control_lock:
            self._player_control_ack_seq = self._player_control_seq
            self._player_control_command = None
        with self._player_status_lock:
            self._player_status = None
        self._notify_state_changed()

    def restart_playback_program(self) -> bool:
        return self.store.restart_playback_program()

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
            self._active_local_exports = 0
            self._local_export_idle.set()
        with self._remote_access_lock:
            self._remote_access = self._build_remote_access_payload(self._host, self._port, [])
        self._start_background_tasks_once()
        threading.Thread(target=self._refresh_remote_access_snapshot, daemon=True).start()

    def remote_access_snapshot(self) -> dict[str, object]:
        with self._remote_access_lock:
            return dict(self._remote_access)

    def wait_for_state_change(self, state_revision: int, timeout: float | None = None) -> bool:
        deadline = None if timeout is None else time.monotonic() + max(0.0, timeout)
        with self._state_change_condition:
            while self._state_revision <= int(state_revision):
                if self._closed:
                    return False
                remaining = None if deadline is None else deadline - time.monotonic()
                if remaining is not None and remaining <= 0:
                    return False
                self._state_change_condition.wait(timeout=remaining)
            return True

    def _notify_state_changed(self) -> None:
        with self._state_change_condition:
            self._state_revision += 1
            self._state_change_condition.notify_all()

    def _request_update_restart(self) -> None:
        self._request_server_shutdown(delay_seconds=0.5, thread_name="bilikara-update-restart")

    def _request_server_shutdown(self, *, delay_seconds: float = 0.0, thread_name: str) -> None:
        with self._client_lock:
            server = self._server
            self._shutdown_requested = True
        if server is None:
            return

        def shutdown_server() -> None:
            if delay_seconds:
                time.sleep(delay_seconds)
            self._local_export_idle.wait(timeout=LOCAL_EXPORT_SHUTDOWN_GRACE_SECONDS)
            server.shutdown()

        threading.Thread(
            target=shutdown_server,
            daemon=True,
            name=thread_name,
        ).start()

    def request_shutdown(self) -> None:
        self._request_server_shutdown(thread_name="bilikara-api-shutdown")

    def begin_local_export(self) -> bool:
        with self._client_lock:
            if self._closed or self._shutdown_requested:
                return False
            self._active_local_exports += 1
            self._local_export_idle.clear()
            return True

    def finish_local_export(self) -> None:
        with self._client_lock:
            if self._active_local_exports <= 0:
                return
            self._active_local_exports -= 1
            if not self._active_local_exports:
                self._local_export_idle.set()

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
            should_shutdown = False
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
                if self._server is None:
                    continue
                self._shutdown_requested = True
                should_shutdown = True
            if should_shutdown:
                self._request_server_shutdown(thread_name="bilikara-api-shutdown")

    def _prune_stale_clients(self, now: float) -> None:
        expired = [
            client_id
            for client_id, last_seen in self._client_last_seen.items()
            if now - last_seen > self._client_stale_seconds
        ]
        for client_id in expired:
            self._client_last_seen.pop(client_id, None)
            self._host_client_last_seen.pop(client_id, None)

    def shutdown(self) -> None:
        if self._closed:
            return
        self._closed = True
        self.cache_manager.shutdown()
        self.store.shutdown()

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
            self._cloudflare_prewarm = threading.Thread(
                target=prewarm_cloudflare_pool,
                daemon=True,
                name="bilikara-cloudflare-prewarm",
            )
            self._cloudflare_prewarm.start()
            self._playlist_export_prewarm = threading.Thread(
                target=prewarm_playlist_export_fonts,
                daemon=True,
                name="bilikara-playlist-export-font-prewarm",
            )
            self._playlist_export_prewarm.start()
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
        self._notify_state_changed()

    @staticmethod
    def _build_remote_access_payload(
        host: str,
        port: int,
        lan_urls: list[str],
    ) -> dict[str, object]:
        local_url = f"{_local_ui_url(host, port)}/remote"
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

    def handle_one_request(self) -> None:
        self._local_export_lease_active = False
        self._local_export_lease_rejected = False
        try:
            super().handle_one_request()
        finally:
            if self._local_export_lease_active:
                self._local_export_lease_active = False
                CONTEXT.finish_local_export()

    def parse_request(self) -> bool:
        if not super().parse_request():
            return False
        route = urlparse(self.path).path
        is_local_export = (
            self.command == "GET" and route == "/api/playlist/export"
        ) or (
            self.command == "POST" and route == "/api/diagnostics/package"
        )
        if is_local_export and self._is_local_client():
            self._local_export_lease_active = CONTEXT.begin_local_export()
            self._local_export_lease_rejected = not self._local_export_lease_active
        return True

    def do_HEAD(self) -> None:  # noqa: N802
        route = urlparse(self.path).path
        if route.startswith("/media/"):
            self._serve_media(route, head_only=True)
            return
        self._serve_static(route, head_only=True)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        route = parsed.path
        query = parse_qs(parsed.query)
        client_id = self.headers.get("X-Bilikara-Client", "") or query.get("client_id", [""])[0]
        referer = self.headers.get("Referer", "")
        
        # 默认认为是 Host 主屏幕，除非明确来自 Remote
        is_host = True
        if referer and referer.rstrip("/").endswith("/remote"):
            is_host = False
        elif route == "/remote" or route.startswith("/remote/"):
            is_host = False
            
        CONTEXT.touch_client(client_id, is_host=is_host)
        if route == "/api/health":
            self._write_json({"ok": True, "status": "ready"})
            return
        if route == "/api/events":
            self._serve_events(client_id)
            return
        if route == "/api/state":
            self._write_json({"ok": True, "data": CONTEXT.snapshot()})
            return
        if route == "/api/remote-identity":
            self._write_json({"ok": True, "data": CONTEXT.remote_identity_snapshot(self._remote_identity_token())})
            return
        if route == "/api/app/update/status":
            self._write_json({"ok": True, "data": CONTEXT.app_update_snapshot()})
            return
        if route == "/api/app/update":
            try:
                include_preview = str(query.get("include_preview", [""])[0]).lower() in {
                    "1",
                    "true",
                    "yes",
                    "on",
                }
                self._write_json({"ok": True, "data": check_for_update(include_preview=include_preview)})
            except Exception as e:
                self._write_json({"ok": False, "error": str(e)}, status=HTTPStatus.BAD_GATEWAY)
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
        if route == "/api/gatcha/pool-config":
            try:
                self._write_json({"ok": True, "data": gatcha_pool_config_detail()})
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
        if route == "/api/lark/search":
            route_query = parse_qs(urlparse(self.path).query)
            query = route_query.get("q", [""])[0]
            table_index = route_query.get("table", [""])[0]
            try:
                limit = max(1, min(100, int(route_query.get("limit", ["80"])[0] or "80")))
            except (TypeError, ValueError):
                limit = 80
            try:
                if table_index:
                    results = search_lark_pool_table(query, int(table_index), limit=limit)
                else:
                    results = search_lark_pool(query, limit=limit)
                results = annotate_gatcha_local_status(results)
                self._write_json({"ok": True, "data": {"items": results}})
            except Exception as e:
                self._write_json({"ok": False, "error": str(e)})
            return
        if route == "/api/d1/browse":
            route_query = parse_qs(urlparse(self.path).query)
            kind = route_query.get("kind", route_query.get("type", ["name"]))[0]
            letter = route_query.get("letter", [""])[0]
            search_query = route_query.get("q", [""])[0]
            tag = route_query.get("tag", [""])[0]
            locale = route_query.get("locale", [""])[0]
            try:
                limit = max(1, min(500, int(route_query.get("limit", ["100"])[0] or "100")))
            except (TypeError, ValueError):
                limit = 100
            try:
                results = browse_d1_pool(kind, letter=letter, query=search_query, tag=tag, locale=locale, limit=limit)
                if isinstance(results.get("items"), list):
                    results["items"] = annotate_gatcha_local_status(results["items"])
                self._write_json({"ok": True, "data": results})
            except Exception as e:
                self._write_json({"ok": False, "error": str(e)})
            return
        if route == "/api/d1/category-browse":
            route_query = parse_qs(urlparse(self.path).query)
            tags = route_query.get("tag", [])
            tags.extend(
                tag
                for packed in route_query.get("tags", [])
                for tag in str(packed or "").split(",")
            )
            tag45s = route_query.get("tag45", [])
            tag45s.extend(
                tag
                for packed in route_query.get("tag45s", [])
                for tag in str(packed or "").split(",")
            )
            search_query = route_query.get("q", [""])[0]
            try:
                limit = max(1, min(100, int(route_query.get("limit", ["100"])[0] or "100")))
            except (TypeError, ValueError):
                limit = 100
            try:
                offset = max(0, int(route_query.get("offset", ["0"])[0] or "0"))
            except (TypeError, ValueError):
                offset = 0
            try:
                results = browse_d1_category_pool(tags, tag45s=tag45s, query=search_query, limit=limit, offset=offset)
                if isinstance(results.get("items"), list):
                    results["items"] = annotate_gatcha_local_status(results["items"])
                self._write_json({"ok": True, "data": results})
            except Exception as e:
                self._write_json({"ok": False, "error": str(e)})
            return
        if route == "/api/gatcha/browse":
            route_query = parse_qs(urlparse(self.path).query)
            selected_uid = route_query.get("uid", [""])[0]
            search_query = route_query.get("q", [""])[0]
            try:
                self._write_json({"ok": True, "data": browse_gatcha_cache(selected_uid, search_query)})
            except Exception as e:
                self._write_json({"ok": False, "error": str(e)})
            return
        if route == "/api/gatcha/favlist/browse":
            route_query = parse_qs(urlparse(self.path).query)
            selected_folder_id = route_query.get("folder_id", [""])[0]
            search_query = route_query.get("q", [""])[0]
            try:
                self._write_json({"ok": True, "data": browse_gatcha_favlist(selected_folder_id, search_query)})
            except Exception as e:
                self._write_json({"ok": False, "error": str(e)})
            return
        if route == "/api/gatcha/uids":
            try:
                self._write_json({"ok": True, "data": gatcha_uid_snapshot()})
            except Exception as e:
                self._write_json({"ok": False, "error": str(e)})
            return
        if route == "/api/played-sessions":
            try:
                sessions = []
                if PLAYED_SESSION_DIR.exists():
                    for f in PLAYED_SESSION_DIR.glob("played-*.json"):
                        stem = f.stem
                        if stem.startswith("played-"):
                            stem = stem[7:]
                        parts = stem.split("_")
                        if len(parts) == 2:
                            date_part, time_part = parts
                            date_splits = date_part.split("-")
                            time_splits = time_part.split("-")
                            if len(date_splits) == 3 and len(time_splits) >= 2:
                                try:
                                    year = int(date_splits[0])
                                    month = int(date_splits[1])
                                    day = int(date_splits[2])
                                    hour = int(time_splits[0])
                                    minute = int(time_splits[1])
                                    sessions.append({
                                        "id": f.name,
                                        "year": year,
                                        "month": month,
                                        "day": day,
                                        "hour": hour,
                                        "minute": minute,
                                    })
                                    continue
                                except ValueError:
                                    pass
                        sessions.append({
                            "id": f.name,
                            "year": 0,
                            "month": 0,
                            "day": 0,
                            "hour": 0,
                            "minute": 0,
                        })
                sessions.sort(key=lambda x: x["id"], reverse=True)
                self._write_json({"ok": True, "data": sessions})
            except Exception as e:
                self._write_json({"ok": False, "error": str(e)})
            return
        if route in ("/api/playlist/export", "/api/history/export"):
            query = parse_qs(urlparse(self.path).query)
            export_format = str(query.get("format", ["csv"])[0] or "csv").strip().lower()
            export_source = str(query.get("source", ["history"])[0] or "history").strip().lower()
            try:
                export_page_size = int(query.get("page_size", ["200"])[0] or "200")
            except (TypeError, ValueError):
                export_page_size = 200
            export_page_size = export_page_size if export_page_size in {200, 150, 100, 80, 60, 50} else 200
            export_context = {
                "started_at": time.monotonic(),
                "format": export_format,
                "source": export_source,
                "item_count": 0,
                "payload_size": 0,
            }
            self._log_export_stage("export_request_started", export_context)
            if getattr(self, "_local_export_lease_rejected", False):
                self._write_json(
                    {"ok": False, "error": "服务正在关闭，无法开始导出"},
                    status=HTTPStatus.SERVICE_UNAVAILABLE,
                )
                return
            source_settings = {
                "history": {
                    "items": lambda: CONTEXT.history_snapshot(),
                    "filename": "history",
                    "title": "bilikara 歌单导出",
                    "time_header": "播放时间",
                },
                "played": {
                    "items": lambda: CONTEXT.session_played_snapshot(),
                    "filename": "played",
                    "title": "bilikara 歌单导出",
                    "time_header": "播放时间",
                },
            }
            if export_source.startswith("played-") and export_source.endswith(".json"):
                safe_name = "".join(c for c in export_source if c.isalnum() or c in "-_.")
                session_file = PLAYED_SESSION_DIR / safe_name
                if session_file.exists() and session_file.is_file():
                    def read_session_file():
                        try:
                            with open(session_file, "r", encoding="utf-8") as rf:
                                data = json.load(rf)
                                return data.get("items") or []
                        except Exception:
                            return []
                    source_settings[export_source] = {
                        "items": read_session_file,
                        "filename": Path(safe_name).stem,
                        "title": "bilikara 歌单导出",
                        "time_header": "播放时间",
                    }
            if export_source not in source_settings:
                self._log_export_stage("export_failed", export_context, error="invalid export source")
                self._write_json({"ok": False, "error": "source must be history or played"}, status=HTTPStatus.BAD_REQUEST)
                return
            settings = source_settings[export_source]
            timestamp = time.strftime("%Y%m%d-%H%M%S")
            try:
                history = settings["items"]()
                export_context["item_count"] = len(history)
                self._log_export_stage("export_snapshot_ready", export_context)
                if export_format == "csv":
                    payload = playlist_csv_bytes(history, time_header=str(settings["time_header"]))
                    export_context["payload_size"] = len(payload)
                    self._log_export_stage("export_payload_ready", export_context)
                    self._write_export_download(
                        payload,
                        content_type="text/csv; charset=utf-8",
                        filename=f"bilikara-{settings['filename']}-{timestamp}.csv",
                        export_context=export_context,
                    )
                    return
                if export_format == "image":
                    payload, content_type, default_filename = playlist_image_export(
                        history,
                        logo_path=_playlist_export_logo_path(),
                        title=str(settings["title"]),
                        page_size=export_page_size,
                    )
                    suffix = Path(default_filename).suffix or ".png"
                    filename = f"bilikara-{settings['filename']}-{timestamp}{suffix}"
                    export_context["payload_size"] = len(payload)
                    self._log_export_stage("export_payload_ready", export_context)
                    self._write_export_download(
                        payload,
                        content_type=content_type,
                        filename=filename,
                        export_context=export_context,
                    )
                    return
                raise ValueError("format must be csv or image")
            except Exception as e:
                self._log_export_stage("export_failed", export_context, error=f"{type(e).__name__}: {e}")
                self._write_json({"ok": False, "error": str(e)}, status=HTTPStatus.BAD_REQUEST)
            return
        if route.startswith("/media/"):
            self._serve_media(route)
            return
        self._serve_static(route)

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        route = parsed.path
        query = parse_qs(parsed.query)
        client_id = self.headers.get("X-Bilikara-Client", "") or query.get("client_id", [""])[0]
        referer = self.headers.get("Referer", "")
        
        is_host = True
        if referer and referer.rstrip("/").endswith("/remote"):
            is_host = False
        elif route == "/remote" or route.startswith("/remote/"):
            is_host = False
            
        CONTEXT.touch_client(client_id, is_host=is_host)
        
        try:
            body = self._read_json_body()
            export_diagnostics = body.get("export_diagnostics") if isinstance(body, dict) else None
            if route == "/api/diagnostics/markdown":
                if not self._is_local_client():
                    self._write_json({"ok": False, "error": "forbidden"}, status=HTTPStatus.FORBIDDEN)
                    return
                if export_diagnostics is not None:
                    artifact = CONTEXT.build_diagnostics(
                        self._diagnostic_browser_info(body),
                        export_diagnostics=export_diagnostics,
                    )
                else:
                    artifact = CONTEXT.build_diagnostics(self._diagnostic_browser_info(body))
                self._write_json({"ok": True, "data": {"markdown": artifact.markdown}})
                return
            if route == "/api/diagnostics/package":
                diagnostic_context = {
                    "started_at": time.monotonic(),
                    "payload_size": 0,
                }
                self._log_diagnostics_stage("diagnostics_request_started", diagnostic_context)
                if not self._is_local_client():
                    self._log_diagnostics_stage(
                        "diagnostics_failed",
                        diagnostic_context,
                        error=PermissionError("remote client rejected"),
                    )
                    self._write_json({"ok": False, "error": "forbidden"}, status=HTTPStatus.FORBIDDEN)
                    return
                if getattr(self, "_local_export_lease_rejected", False):
                    self._write_json(
                        {"ok": False, "error": "服务正在关闭，无法开始导出"},
                        status=HTTPStatus.SERVICE_UNAVAILABLE,
                    )
                    return
                self._log_diagnostics_stage("diagnostics_authorized", diagnostic_context)
                try:
                    if export_diagnostics is not None:
                        artifact = CONTEXT.build_diagnostics(
                            self._diagnostic_browser_info(body),
                            export_diagnostics=export_diagnostics,
                        )
                    else:
                        artifact = CONTEXT.build_diagnostics(self._diagnostic_browser_info(body))
                    payload = artifact.zip_bytes()
                    diagnostic_context["payload_size"] = len(payload)
                    self._log_diagnostics_stage("diagnostics_artifact_ready", diagnostic_context)
                    timestamp = time.strftime("%Y%m%d-%H%M%S")
                    self._write_diagnostics_download(
                        payload,
                        content_type="application/zip",
                        filename=f"bilikara-diagnostics-{timestamp}.zip",
                        diagnostic_context=diagnostic_context,
                    )
                except Exception as exc:
                    self._log_diagnostics_stage(
                        "diagnostics_failed",
                        diagnostic_context,
                        error=exc,
                    )
                    raise
                return
            if route == "/api/remote-identity/register":
                token, identity = CONTEXT.register_remote_identity(
                    str(body.get("name") or ""),
                    claim=bool(body.get("claim")),
                )
                self._write_json(
                    {"ok": True, "data": identity},
                    headers={"Set-Cookie": self._remote_identity_cookie(token)},
                )
                return
            if route == "/api/remote-identity/rename":
                identity = CONTEXT.rename_remote_identity(
                    self._remote_identity_token(),
                    str(body.get("name") or ""),
                )
                self._write_json({"ok": True, "data": identity})
                return
            if route == "/api/app/shutdown":
                if not self._is_local_client() and not self._has_valid_shutdown_token():
                    self._write_json({"ok": False, "error": "forbidden"}, status=HTTPStatus.FORBIDDEN)
                    return
                self._write_json({"ok": True})
                CONTEXT.request_shutdown()
                return
            if route == "/api/app/update/install":
                include_preview = str(body.get("include_preview", body.get("includePreview", ""))).lower() in {
                    "1",
                    "true",
                    "yes",
                    "on",
                }
                self._write_json({"ok": True, "data": CONTEXT.start_app_update(include_preview=include_preview)})
                return
            if route == "/api/app/open-url":
                url_to_open = str(body.get("url", "")).strip()
                if url_to_open.startswith(("http://", "https://")):
                    threading.Thread(
                        target=lambda: webbrowser.open(url_to_open),
                        daemon=True
                    ).start()
                    self._write_json({"ok": True})
                else:
                    self._write_json({"ok": False, "error": "invalid url"}, status=HTTPStatus.BAD_REQUEST)
                return
            if route == "/api/playlist/add":
                self._handle_add(body)
                return
            if route == "/api/player/next":
                expected_playback_generation = body.get("playback_generation")
                if (
                    isinstance(expected_playback_generation, bool)
                    or not isinstance(expected_playback_generation, int)
                    or expected_playback_generation < 1
                    or expected_playback_generation > MAX_SAFE_JSON_INTEGER
                ):
                    raise ValueError("invalid playback_generation")
                CONTEXT.advance_to_next(expected_playback_generation)
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
            if route == "/api/history/clear":
                CONTEXT.clear_history()
                self._write_json({"ok": True, "data": CONTEXT.snapshot()})
                return
            if route == "/api/history/remove":
                key = str(body.get("key") or "").strip()
                if not key:
                    raise ValueError("missing key")
                CONTEXT.remove_history_entry(key)
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
            if route == "/api/bilikara-secret/verify":
                bilikara_secret = str(body.get("BILIKARA_ADMIN_SECRET") or "").strip()
                configured_bilikara_secret = str(os.environ.get("BILIKARA_ADMIN_SECRET") or "").strip()
                if configured_bilikara_secret:
                    if not bilikara_secret or not hmac.compare_digest(bilikara_secret, configured_bilikara_secret):
                        self._write_json(
                            {"ok": False, "error": "invalid secret"},
                            status=HTTPStatus.FORBIDDEN,
                        )
                        return
                    self._write_json({"ok": True, "data": {"verified": True}})
                    return
                result = verify_cloudflare_bilikara_secret(bilikara_secret)
                if not result.get("verified"):
                    self._write_json(
                        {"ok": False, "error": result.get("error") or "invalid secret"},
                        status=HTTPStatus.FORBIDDEN,
                    )
                    return
                self._write_json({"ok": True, "data": {"verified": True}})
                return
            if route == "/api/admin-review/pending":
                bilikara_secret = str(body.get("BILIKARA_ADMIN_SECRET") or "").strip()
                if not self._verified_bilikara_secret(bilikara_secret):
                    self._write_json({"ok": False, "error": "invalid secret"}, status=HTTPStatus.FORBIDDEN)
                    return
                try:
                    limit = max(1, min(20, int(body.get("limit") or 20)))
                except (TypeError, ValueError):
                    limit = 20
                try:
                    result = pending_cloudflare_review_items(bilikara_secret, limit=limit)
                except LarkPoolError as exc:
                    self._write_json({"ok": False, "error": str(exc)}, status=HTTPStatus.BAD_GATEWAY)
                    return
                self._write_json({"ok": True, "data": result})
                return
            if route == "/api/admin-review/approve":
                bilikara_secret = str(body.get("BILIKARA_ADMIN_SECRET") or "").strip()
                if not self._verified_bilikara_secret(bilikara_secret):
                    self._write_json({"ok": False, "error": "invalid secret"}, status=HTTPStatus.FORBIDDEN)
                    return
                bvids = body.get("bvids")
                if not isinstance(bvids, list):
                    raise ValueError("bvids must be a list")
                try:
                    limit = max(1, min(20, int(body.get("limit") or 20)))
                except (TypeError, ValueError):
                    limit = 20
                try:
                    result = approve_cloudflare_review_items(bvids, bilikara_secret, limit=limit)
                except LarkPoolError as exc:
                    self._write_json({"ok": False, "error": str(exc)}, status=HTTPStatus.BAD_GATEWAY)
                    return
                self._write_json({"ok": True, "data": result})
                return
            if route == "/api/admin-review/reject":
                bilikara_secret = str(body.get("BILIKARA_ADMIN_SECRET") or "").strip()
                if not self._verified_bilikara_secret(bilikara_secret):
                    self._write_json({"ok": False, "error": "invalid secret"}, status=HTTPStatus.FORBIDDEN)
                    return
                result = reject_cloudflare_review_item(
                    str(body.get("bvid") or ""),
                    bilikara_secret,
                    record=body.get("record") if isinstance(body.get("record"), dict) else None,
                    rejected_by=str(body.get("rejected_by") or ""),
                )
                if not result.get("success"):
                    self._write_json(
                        {"ok": False, "error": str(result.get("error") or "review rejection failed")},
                        status=HTTPStatus.BAD_GATEWAY,
                    )
                    return
                self._write_json({"ok": True, "data": result})
                return
            if route == "/api/admin-blacklist/list":
                bilikara_secret = str(body.get("BILIKARA_ADMIN_SECRET") or "").strip()
                if not self._verified_bilikara_secret(bilikara_secret):
                    self._write_json({"ok": False, "error": "invalid secret"}, status=HTTPStatus.FORBIDDEN)
                    return
                result = list_cloudflare_blacklist(
                    bilikara_secret,
                    query=str(body.get("query") or body.get("q") or ""),
                    limit=body.get("limit") or 20,
                    offset=body.get("offset") or 0,
                    include_inactive=bool(body.get("include_inactive")),
                )
                if not result.get("success"):
                    self._write_json(
                        {"ok": False, "error": str(result.get("error") or "blacklist query failed")},
                        status=HTTPStatus.BAD_GATEWAY,
                    )
                    return
                self._write_json({"ok": True, "data": result})
                return
            if route == "/api/admin-blacklist/restore":
                bilikara_secret = str(body.get("BILIKARA_ADMIN_SECRET") or "").strip()
                if not self._verified_bilikara_secret(bilikara_secret):
                    self._write_json({"ok": False, "error": "invalid secret"}, status=HTTPStatus.FORBIDDEN)
                    return
                result = restore_cloudflare_blacklist_item(
                    str(body.get("bvid") or ""),
                    bilikara_secret,
                    restore_video=bool(body.get("restore_video")),
                    restored_by=str(body.get("restored_by") or ""),
                )
                if not result.get("success"):
                    self._write_json(
                        {"ok": False, "error": str(result.get("error") or "blacklist restore failed")},
                        status=HTTPStatus.BAD_GATEWAY,
                    )
                    return
                self._write_json({"ok": True, "data": result})
                return
            if route == "/api/admin-tags/reset":
                result = reset_cloudflare_video_tags(
                    str(body.get("bvid") or ""),
                    str(body.get("BILIKARA_ADMIN_SECRET") or ""),
                )
                if not result.get("success"):
                    message = str(result.get("error") or "reset failed")
                    lowered = message.lower()
                    if "invalid bvid" in lowered or "missing" in lowered:
                        status = HTTPStatus.BAD_REQUEST
                    elif "unauthorized" in lowered or "secret" in lowered:
                        status = HTTPStatus.FORBIDDEN
                    else:
                        status = HTTPStatus.BAD_GATEWAY
                    self._write_json({"ok": False, "error": message}, status=status)
                    return
                self._write_json({"ok": True, "data": result})
                return
            if route == "/api/admin-video/delete":
                bilikara_secret = str(body.get("BILIKARA_ADMIN_SECRET") or "").strip()
                configured_bilikara_secret = str(os.environ.get("BILIKARA_ADMIN_SECRET") or "").strip()
                if configured_bilikara_secret:
                    verified = bool(bilikara_secret) and hmac.compare_digest(
                        bilikara_secret,
                        configured_bilikara_secret,
                    )
                else:
                    verified = bool(verify_cloudflare_bilikara_secret(bilikara_secret).get("verified"))
                if not verified:
                    self._write_json({"ok": False, "error": "invalid secret"}, status=HTTPStatus.FORBIDDEN)
                    return
                result = delete_cloudflare_video_entry(str(body.get("bvid") or ""), bilikara_secret)
                if not result.get("success"):
                    message = str(result.get("error") or "delete failed")
                    lowered = message.lower()
                    if "invalid bvid" in lowered or "missing" in lowered:
                        status = HTTPStatus.BAD_REQUEST
                    elif "unauthorized" in lowered or "secret" in lowered:
                        status = HTTPStatus.FORBIDDEN
                    else:
                        status = HTTPStatus.BAD_GATEWAY
                    self._write_json({"ok": False, "error": message}, status=status)
                    return
                self._write_json({"ok": True, "data": result})
                return
            if route == "/api/admin-video/delete-mid":
                bilikara_secret = str(body.get("BILIKARA_ADMIN_SECRET") or "").strip()
                configured_bilikara_secret = str(os.environ.get("BILIKARA_ADMIN_SECRET") or "").strip()
                if configured_bilikara_secret:
                    verified = bool(bilikara_secret) and hmac.compare_digest(
                        bilikara_secret,
                        configured_bilikara_secret,
                    )
                else:
                    verified = bool(verify_cloudflare_bilikara_secret(bilikara_secret).get("verified"))
                if not verified:
                    self._write_json({"ok": False, "error": "invalid secret"}, status=HTTPStatus.FORBIDDEN)
                    return
                result = delete_cloudflare_mid_entries(str(body.get("mid") or ""), bilikara_secret)
                if not result.get("success"):
                    message = str(result.get("error") or "delete failed")
                    lowered = message.lower()
                    if "invalid mid" in lowered or "missing" in lowered:
                        status = HTTPStatus.BAD_REQUEST
                    elif "unauthorized" in lowered or "secret" in lowered:
                        status = HTTPStatus.FORBIDDEN
                    else:
                        status = HTTPStatus.BAD_GATEWAY
                    self._write_json({"ok": False, "error": message}, status=status)
                    return
                self._write_json({"ok": True, "data": result})
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
            if route == "/api/playlist/resort":
                CONTEXT.resort_playlist_by_cycle()
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
            if route == "/api/player/av-delay-action":
                action_type = body.get("type")
                if action_type == "adjust":
                    delta_ms = body.get("delta_ms")
                    if isinstance(delta_ms, bool) or not isinstance(delta_ms, int):
                        raise ValueError("delta_ms must be an integer")
                    action = {"type": "adjust", "delta_ms": delta_ms}
                elif action_type == "set_effective":
                    effective_delay_ms = body.get("effective_delay_ms")
                    if isinstance(effective_delay_ms, bool) or not isinstance(effective_delay_ms, int):
                        raise ValueError("effective_delay_ms must be an integer")
                    action = {
                        "type": "set_effective",
                        "effective_delay_ms": effective_delay_ms,
                    }
                elif action_type in {"reset_local", "toggle_lock"}:
                    action = {"type": action_type}
                else:
                    raise ValueError("invalid AV delay action")
                if set(body) != set(action):
                    raise ValueError("unexpected AV delay action fields")
                decision = CONTEXT.apply_av_delay_action(action)
                self._write_json({"ok": True, "data": decision})
                return
            if route == "/api/player/advance-delay":
                delay_seconds = body.get("delay_seconds")
                if not isinstance(delay_seconds, int):
                    raise ValueError("delay_seconds must be an integer")
                CONTEXT.set_song_advance_delay_seconds(delay_seconds)
                self._write_json({"ok": True, "data": CONTEXT.snapshot()})
                return
            if route == "/api/player/key-shift":
                key_shift = body.get("key_shift")
                if not isinstance(key_shift, int):
                    raise ValueError("key_shift must be an integer")
                CONTEXT.set_key_shift(key_shift)
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
                force = bool(body.get("force"))
                CONTEXT.retry_cache_item(body["item_id"], force=force)
                self._write_json({"ok": True, "data": CONTEXT.snapshot()})
                return
            if route == "/api/gatcha/pool-config":
                result = update_gatcha_pool_config(
                    uid_weight=body.get("uid_weight"),
                    favlist_weight=body.get("favlist_weight"),
                    excluded_uids=body.get("excluded_uids"),
                    excluded_favlist_folders=body.get("excluded_favlist_folders"),
                )
                CONTEXT._notify_state_changed()
                self._write_json({"ok": True, "data": {**gatcha_pool_config_detail(), **result}})
                return
            if route == "/api/gatcha/uids/add":
                result = add_gatcha_uid(
                    body.get("uid"),
                    on_start=CONTEXT._notify_state_changed,
                    on_done=CONTEXT._notify_state_changed,
                )
                self._write_json({"ok": True, "data": result})
                return
            if route == "/api/gatcha/uids/preview":
                gatcha_task = gatcha_task_snapshot()
                if gatcha_task.get("busy"):
                    raise ValueError(gatcha_task.get("message") or "拉取任务执行中，请等待任务结束")
                result = preview_gatcha_uid(body.get("uid"))
                self._write_json({"ok": True, "data": result})
                return
            if route == "/api/gatcha/refresh":
                if not effective_bilibili_cookie():
                    raise ValueError(MISSING_BILIBILI_COOKIE_MESSAGE)
                started = CONTEXT.refresh_gatcha_cache_in_background()
                if not started:
                    raise ValueError("拉取任务执行中，请等待任务结束")
                self._write_json({"ok": True, "data": {"started": started}})
                return
            if route == "/api/gatcha/favlist/preview":
                gatcha_task = gatcha_task_snapshot()
                if gatcha_task.get("busy"):
                    raise ValueError(gatcha_task.get("message") or "拉取任务执行中，请等待任务结束")
                result = preview_gatcha_favlist(body.get("uid"))
                self._write_json({"ok": True, "data": result})
                return
            if route == "/api/gatcha/favlist":
                result = refresh_gatcha_favlist(
                    body.get("uid"),
                    body.get("folder_ids"),
                    on_start=CONTEXT._notify_state_changed,
                    on_done=CONTEXT._notify_state_changed,
                )
                self._write_json({"ok": True, "data": result})
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
                if action not in {"toggle-play", "seek-relative", "seek-absolute", "next-track"}:
                    raise ValueError("invalid player control action")
                delta_seconds = int(body.get("delta_seconds") or 0)
                target_seconds = None
                if action == "seek-relative" and delta_seconds == 0:
                    raise ValueError("missing delta_seconds")
                if action == "seek-relative" and abs(delta_seconds) > 300:
                    raise ValueError("delta_seconds too large")
                if action == "seek-absolute":
                    target_seconds = float(body.get("target_seconds") or 0.0)
                    if target_seconds < 0:
                        raise ValueError("target_seconds must be non-negative")
                CONTEXT.issue_player_control(
                    action=action,
                    item_id=item_id,
                    delta_seconds=delta_seconds,
                    target_seconds=target_seconds,
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
                observation = _normalize_player_status_observation(
                    playback_generation=body.get("playback_generation"),
                    status_sequence=body.get("status_sequence"),
                    item_id=body.get("item_id"),
                    observed_phase=body.get("observed_phase"),
                    is_paused=body.get("is_paused"),
                    current_time=body.get("current_time"),
                    duration=body.get("duration"),
                    client_info=body.get("client_info"),
                )
                result = CONTEXT.update_player_status(**observation)
                self._write_json({"ok": True, "data": result})
                return
            if route == "/api/player/diagnostic":
                event = CONTEXT.record_player_diagnostic(_normalize_player_diagnostic(body))
                print(f"[player-media] {json.dumps(event, ensure_ascii=False, sort_keys=True)}", flush=True)
                self._write_json({"ok": True})
                return
            if route == "/api/rating/log":
                message = str(body.get("message") or "").strip()
                if message:
                    print(f"[rating-front] {message}", flush=True)
                self._write_json({"ok": True})
                return
            if route == "/api/rating/submit":
                session_user_name = str(
                    body.get("session_user_name")
                    or body.get("sessionUserName")
                    or body.get("user_name")
                    or body.get("userName")
                    or body.get("session_user_id")
                    or body.get("user_id")
                    or ""
                ).strip()
                bvid = str(body.get("bvid") or "").strip()
                play_id = str(
                    body.get("play_id")
                    or body.get("playId")
                    or body.get("item_id")
                    or body.get("itemId")
                    or bvid
                ).strip()
                try:
                    score = int(body.get("score") or 0)
                except (TypeError, ValueError):
                    score = 0
                if not session_user_name:
                    raise ValueError("missing session_user_name")
                if not play_id:
                    raise ValueError("missing play_id")
                if not BVID_IN_TEXT_RE.fullmatch(bvid):
                    raise ValueError("invalid bvid")
                if score < 1 or score > 5:
                    raise ValueError("score must be between 1 and 5")
                duplicate = not CONTEXT.register_rating_submission(session_user_name, play_id)
                print(f"[rating] user={session_user_name} play_id={play_id} bvid={bvid} score={score} duplicate={duplicate}", flush=True)
                if not duplicate:
                    self._submit_rating_in_background(session_user_name, play_id, bvid, score)
                self._write_json({
                    "ok": True,
                    "data": {
                        "success": True,
                        "queued": not duplicate,
                        "duplicate": duplicate,
                        "session_user_name": session_user_name,
                        "play_id": play_id,
                        "bvid": bvid,
                        "score": score,
                    },
                })
                return
            if route == "/api/cache-downloader/status":
                download_source = body.get("download_source")
                if not isinstance(download_source, str):
                    raise ValueError("download_source 必须是字符串")
                result = CONTEXT.cache_downloader_status(download_source)
                self._write_json({"ok": True, "data": result})
                return
            if route == "/api/cache-downloader/prepare":
                download_source = body.get("download_source")
                if not isinstance(download_source, str):
                    raise ValueError("download_source 必须是字符串")
                result = CONTEXT.prepare_cache_downloader(download_source)
                self._write_json({"ok": True, "data": result})
                return
            if route == "/api/cache-policy":
                max_cache_items = body.get("max_cache_items") if "max_cache_items" in body else None
                video_quality = body.get("video_quality") if "video_quality" in body else None
                audio_hires = body.get("audio_hires") if "audio_hires" in body else None
                download_source = body.get("download_source") if "download_source" in body else None
                reset_offset_on_next = body.get("reset_offset_on_next") if "reset_offset_on_next" in body else None
                if max_cache_items is not None and not isinstance(max_cache_items, int):
                    raise ValueError("max_cache_items 必须是整数")
                if video_quality is not None and not isinstance(video_quality, str):
                    raise ValueError("video_quality 必须是字符串")
                if audio_hires is not None and not isinstance(audio_hires, bool):
                    raise ValueError("audio_hires 必须是布尔值")
                if download_source is not None and not isinstance(download_source, str):
                    raise ValueError("download_source 必须是字符串")
                if reset_offset_on_next is not None and not isinstance(reset_offset_on_next, bool):
                    raise ValueError("reset_offset_on_next 必须是布尔值")
                if max_cache_items is None and video_quality is None and audio_hires is None and download_source is None and reset_offset_on_next is None:
                    raise ValueError("没有可更新的缓存策略")
                CONTEXT.set_cache_policy(
                    max_cache_items=max_cache_items,
                    video_quality=video_quality,
                    audio_hires=audio_hires,
                    download_source=download_source,
                    reset_offset_on_next=reset_offset_on_next,
                )
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
            if route == "/api/session/continue-previous":
                if not CONTEXT.continue_previous_session():
                    raise ValueError("没有可继续的上一场记录")
                self._write_json({"ok": True, "data": CONTEXT.snapshot()})
                return
            if route == "/api/player/reset":
                CONTEXT.reset_player_state()
                self._write_json({"ok": True, "data": CONTEXT.snapshot()})
                return
            if route == "/api/player/restart-program":
                if not self._is_local_client():
                    self._write_json(
                        {"ok": False, "error": "forbidden"},
                        status=HTTPStatus.FORBIDDEN,
                    )
                    return
                CONTEXT.restart_playback_program()
                self._write_json({"ok": True, "data": CONTEXT.snapshot()})
                return
            if route == "/api/data/reset":
                CONTEXT.reset_runtime_data()
                self._write_json({"ok": True, "data": CONTEXT.snapshot()})
                return
            if route == "/api/client/disconnect":
                CONTEXT.disconnect_client(str(body.get("client_id") or ""))
                self._write_json({"ok": True})
                return
            if route == "/api/client/media-capabilities":
                result = CONTEXT.set_client_media_capabilities(body)
                self._write_json({"ok": True, "data": result})
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
                CONTEXT.refresh_gatcha_cache_in_background()
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
            if route == "/api/playlist/add":
                self._delete_missing_bvid_from_pool_if_needed(body, exc)
            self._write_json({"ok": False, "error": str(exc)}, status=HTTPStatus.BAD_REQUEST)
        except PlaybackCapabilityError as exc:
            self._write_json(
                {
                    "ok": False,
                    "error": str(exc),
                    "code": "playback_capability_failed",
                    "capability": exc.capability,
                },
                status=HTTPStatus.SERVICE_UNAVAILABLE,
            )
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
        except SessionUserAlreadyExistsError as exc:
            self._write_json(
                {
                    "ok": False,
                    "error": str(exc),
                    "code": "session_user_already_exists",
                    "name": exc.name,
                },
                status=HTTPStatus.CONFLICT,
            )
        except PlayerStatusAdmissionError as exc:
            self._write_json(
                {
                    "ok": True,
                    "data": {
                        "accepted": False,
                        "duplicate": False,
                        "changed": False,
                        "reason": exc.kind,
                    },
                }
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
        if not CONTEXT.has_session_users():
            raise ValueError("请先在服务端添加本场 KTV 用户")
        item = fetch_video_item(
            url,
            selected_video_page=selected_video_page,
            selected_audio_pages=selected_audio_pages,
        )
        try:
            CONTEXT.add_item(
                item,
                position=position,
                requester_name=requester_name,
                allow_repeat=allow_repeat,
            )
        except PlaylistStoreCommandError as exc:
            if exc.kind != "duplicate_session_request":
                raise
            details = exc.details
            if not isinstance(details, dict):
                raise RuntimeError("Rust AppState returned invalid duplicate details") from exc
            session_payload = details.get("session_entry")
            active_payload = details.get("active_item")
            if session_payload is not None and not isinstance(session_payload, dict):
                raise RuntimeError("Rust AppState returned invalid session duplicate") from exc
            if active_payload is not None and not isinstance(active_payload, dict):
                raise RuntimeError("Rust AppState returned invalid active duplicate") from exc
            session_entry = (
                HistoryEntry.from_dict(session_payload)
                if isinstance(session_payload, dict)
                else None
            )
            active_duplicate = (
                PlaylistItem.from_dict(active_payload)
                if isinstance(active_payload, dict)
                else None
            )
            if session_entry is None and active_duplicate is None:
                raise RuntimeError("Rust AppState returned an empty duplicate decision") from exc
            raise DuplicateSessionRequestError(
                item,
                session_entry,
                active_duplicate,
            ) from exc
        try:
            append_lark_pool_entries_in_background(
                [
                    {
                        "mid": str(item.owner_mid or ""),
                        "bvid": item.bvid,
                        "title": item.title or item.display_title,
                        "url": item.resolved_url or item.original_url,
                        "owner_name": item.owner_name,
                        "owner_url": item.owner_url,
                        "cover_url": item.cover_url,
                    }
                ]
            )
        except Exception as exc:  # noqa: BLE001
            error = " ".join(str(exc).split())[:300] or type(exc).__name__
            print(
                f"[bilikara:lark] background append scheduling failed: {error}",
                file=sys.stderr,
                flush=True,
            )
        self._write_json({"ok": True, "data": CONTEXT.snapshot()})

    def _delete_missing_bvid_from_pool_if_needed(self, body: dict, error: Exception) -> None:
        error_message = str(error).strip()
        if error_message != MISSING_BILIBILI_VIDEO_MESSAGE:
            return
        bvid = self._extract_bvid_from_add_body(body)
        if not bvid:
            return
        delete_cloudflare_pool_entry(bvid)

    @staticmethod
    def _submit_rating_in_background(session_user_name: str, play_id: str, bvid: str, score: int) -> None:
        def worker() -> None:
            result = submit_cloudflare_song_rating(
                session_user_name=session_user_name,
                play_id=play_id,
                bvid=bvid,
                score=score,
            )
            if not result.get("success"):
                print(f"[bilikara] rating submit failed: {result.get('error') or 'unknown error'}", flush=True)

        threading.Thread(target=worker, daemon=True, name="bilikara-rating-submit").start()

    @staticmethod
    def _extract_bvid_from_add_body(body: dict) -> str:
        raw_url = str(body.get("url") or "")
        match = BVID_IN_TEXT_RE.search(raw_url)
        return match.group(0) if match else ""

    def _serve_static(self, route: str, *, head_only: bool = False) -> None:
        if route in {"", "/"}:
            relative = "index.html"
        elif route in {"/remote", "/remote/"}:
            relative = "remote.html"
        else:
            relative = route.lstrip("/")
        static_path = (STATIC_DIR / relative).resolve()
        if not _is_path_within(static_path, STATIC_DIR.resolve()) or not static_path.exists():
            self._write_json({"ok": False, "error": "资源不存在"}, status=HTTPStatus.NOT_FOUND)
            return
        self._stream_file(
            static_path,
            content_type=self._guess_type(static_path),
            cache_control="no-store",
            head_only=head_only,
        )

    def _serve_media(self, route: str, *, head_only: bool = False) -> None:
        # relative = route.removeprefix("/media/")  # Python 3.9+
        prefix = "/media/"
        relative = route[len(prefix):] if route.startswith(prefix) else route
        decoded = unquote(relative)
        decoded_path = Path(decoded)
        media_path = (CACHE_DIR / decoded).resolve()
        if (
            decoded_path.is_absolute()
            or not decoded_path.parts
            or any(part in {".", ".."} or part.startswith(".") for part in decoded_path.parts)
            or not _is_path_within(media_path, CACHE_DIR.resolve())
            or not media_path.is_file()
        ):
            self._write_json({"ok": False, "error": "媒体文件不存在"}, status=HTTPStatus.NOT_FOUND)
            return
        self._stream_file(
            media_path,
            content_type=self._guess_type(media_path),
            allow_ranges=True,
            head_only=head_only,
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

    def _is_local_client(self) -> bool:
        peer_host = self.client_address[0] if self.client_address else ""
        try:
            local_host = self.connection.getsockname()[0]
        except (AttributeError, OSError, TypeError):
            return False

        peer_address = _normalized_ip_address(peer_host)
        local_address = _normalized_ip_address(local_host)
        if peer_address is None or local_address is None:
            return False
        if peer_address.is_loopback:
            return True
        if local_address.is_unspecified:
            return False
        return peer_address == local_address

    def _has_valid_shutdown_token(self) -> bool:
        expected = os.getenv("BILIKARA_SHUTDOWN_TOKEN", "").strip()
        provided = self.headers.get("X-Bilikara-Shutdown-Token", "").strip()
        return bool(expected and provided and hmac.compare_digest(expected, provided))

    def _remote_identity_token(self) -> str:
        cookie_header = str(self.headers.get("Cookie") or "")
        if not cookie_header:
            return ""
        cookie = SimpleCookie()
        try:
            cookie.load(cookie_header)
        except Exception:
            return ""
        morsel = cookie.get(REMOTE_IDENTITY_COOKIE)
        return str(morsel.value or "").strip() if morsel else ""

    @staticmethod
    def _diagnostic_browser_info(body: dict[str, object]) -> dict[str, object]:
        browser = body.get("browser")
        if not isinstance(browser, dict):
            return {}
        brands = browser.get("brands")
        normalized_brands = []
        if isinstance(brands, list):
            for item in brands[:10]:
                if not isinstance(item, dict):
                    continue
                normalized_brands.append(
                    {
                        "brand": str(item.get("brand") or "")[:80],
                        "version": str(item.get("version") or "")[:40],
                    }
                )
        return {
            "user_agent": str(browser.get("user_agent") or "")[:1000],
            "platform": str(browser.get("platform") or "")[:120],
            "mobile": bool(browser.get("mobile")),
            "brands": normalized_brands,
        }

    @staticmethod
    def _remote_identity_cookie(token: str) -> str:
        cookie = SimpleCookie()
        cookie[REMOTE_IDENTITY_COOKIE] = str(token or "")
        morsel = cookie[REMOTE_IDENTITY_COOKIE]
        morsel["path"] = "/"
        morsel["max-age"] = str(REMOTE_IDENTITY_COOKIE_MAX_AGE)
        morsel["httponly"] = True
        morsel["samesite"] = "Strict"
        # LAN deployments currently use plain HTTP, so Secure cannot be set.
        # Add Secure here when remote access is moved behind HTTPS.
        return morsel.OutputString()

    def _verified_bilikara_secret(self, bilikara_secret: str) -> bool:
        normalized_secret = str(bilikara_secret or "").strip()
        configured_bilikara_secret = str(os.environ.get("BILIKARA_ADMIN_SECRET") or "").strip()
        if configured_bilikara_secret:
            return bool(normalized_secret) and hmac.compare_digest(normalized_secret, configured_bilikara_secret)
        return bool(verify_cloudflare_bilikara_secret(normalized_secret).get("verified"))

    def _write_json(
        self,
        payload: dict,
        status: HTTPStatus = HTTPStatus.OK,
        *,
        headers: dict[str, str] | None = None,
    ) -> None:
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(encoded)
        self.wfile.flush()

    def _log_export_stage(
        self,
        stage: str,
        context: dict[str, object],
        *,
        error: str = "",
    ) -> None:
        try:
            local_socket = self.connection.getsockname()
        except (AttributeError, OSError, TypeError):
            local_socket = None
        record = {
            "event": stage,
            "format": context.get("format"),
            "source": context.get("source"),
            "item_count": context.get("item_count"),
            "payload_size": context.get("payload_size"),
            "elapsed_ms": round((time.monotonic() - float(context["started_at"])) * 1000, 1),
            "client_address": getattr(self, "client_address", None),
            "local_socket_address": local_socket,
            "sys_frozen": bool(getattr(sys, "frozen", False)),
            "launch_mode": str(os.getenv("BILIKARA_LAUNCH_MODE", "") or "web")[:40],
            "request_path": str(getattr(self, "path", "")),
        }
        if error:
            record["error"] = error
        print("[playlist-export] " + json.dumps(record, ensure_ascii=False, default=str), flush=True)

    @staticmethod
    def _sanitized_diagnostic_error(error: BaseException) -> str:
        message = str(error).replace("\r", " ").replace("\n", " ")[:300]
        message = re.sub(
            r"(?i)\b(cookie|token|authorization)\s*[:=]\s*[^\s,;]+",
            r"\1=<redacted>",
            message,
        )
        message = re.sub(r"(?<!\w)(?:[A-Za-z]:[\\/]|/)[^\s,;]+", "<path>", message)
        return f"{type(error).__name__}: {message}" if message else type(error).__name__

    def _log_diagnostics_stage(
        self,
        stage: str,
        context: dict[str, object],
        *,
        error: BaseException | None = None,
    ) -> None:
        try:
            local_socket = self.connection.getsockname()
        except (AttributeError, OSError, TypeError):
            local_socket = None
        record = {
            "event": stage,
            "elapsed_ms": round((time.monotonic() - float(context["started_at"])) * 1000, 1),
            "payload_size": context.get("payload_size"),
            "request_path": str(getattr(self, "path", "")),
            "launch_mode": str(os.getenv("BILIKARA_LAUNCH_MODE", "") or "web")[:40],
            "sys_frozen": bool(getattr(sys, "frozen", False)),
            "client_address": getattr(self, "client_address", None),
            "local_socket_address": local_socket,
        }
        if error is not None:
            record["error"] = self._sanitized_diagnostic_error(error)
        print("[diagnostics] " + json.dumps(record, ensure_ascii=False, default=str), flush=True)

    def _write_export_download(
        self,
        payload: bytes,
        *,
        content_type: str,
        filename: str,
        export_context: dict[str, object],
    ) -> bool:
        self._active_export_context = export_context
        try:
            return self._write_download(payload, content_type=content_type, filename=filename)
        finally:
            self._active_export_context = None

    def _write_diagnostics_download(
        self,
        payload: bytes,
        *,
        content_type: str,
        filename: str,
        diagnostic_context: dict[str, object],
    ) -> bool:
        self._active_diagnostic_context = diagnostic_context
        try:
            return self._write_download(payload, content_type=content_type, filename=filename)
        finally:
            self._active_diagnostic_context = None

    def _write_download(self, payload: bytes, *, content_type: str, filename: str) -> bool:
        safe_filename = re.sub(r"[^A-Za-z0-9_.-]+", "-", filename).strip("-") or "download.bin"
        export_context = getattr(self, "_active_export_context", None)
        diagnostic_context = getattr(self, "_active_diagnostic_context", None)
        try:
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Content-Disposition", f'attachment; filename="{safe_filename}"')
            self.send_header("Cache-Control", "no-store")
            self.send_header("Last-Modified", formatdate(timeval=None, localtime=False, usegmt=True))
            self.end_headers()
            if isinstance(export_context, dict):
                self._log_export_stage("export_headers_sent", export_context)
            if isinstance(diagnostic_context, dict):
                self._log_diagnostics_stage("diagnostics_headers_sent", diagnostic_context)
            self.wfile.write(payload)
            self.wfile.flush()
            if isinstance(export_context, dict):
                self._log_export_stage("export_body_written", export_context)
            if isinstance(diagnostic_context, dict):
                self._log_diagnostics_stage("diagnostics_body_written", diagnostic_context)
            return True
        except (BrokenPipeError, ConnectionResetError, OSError) as exc:
            if isinstance(export_context, dict):
                self._log_export_stage(
                    "export_failed",
                    export_context,
                    error=f"{type(exc).__name__}: {exc}",
                )
            if isinstance(diagnostic_context, dict):
                self._log_diagnostics_stage(
                    "diagnostics_failed",
                    diagnostic_context,
                    error=exc,
                )
            return False

    def _serve_events(self, client_id: str) -> None:
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        last_revision = -1
        try:
            last_revision, serialized = CONTEXT.serialized_sse_state_event()
            self._write_serialized_sse_event(serialized)
            while not CONTEXT._closed:
                if not CONTEXT.wait_for_state_change(last_revision, timeout=20.0):
                    if CONTEXT._closed:
                        return
                    CONTEXT.touch_client(client_id, is_host=False)
                    self.wfile.write(b": keepalive\n\n")
                    self.wfile.flush()
                    continue
                next_revision, serialized = CONTEXT.serialized_sse_state_event()
                if next_revision <= last_revision:
                    continue
                last_revision = next_revision
                CONTEXT.touch_client(client_id, is_host=False)
                self._write_serialized_sse_event(serialized)
        except (BrokenPipeError, ConnectionResetError, OSError):
            return

    def _write_sse_event(self, event: str, payload: dict) -> None:
        self._write_serialized_sse_event(_serialize_sse_event(event, payload))

    def _write_serialized_sse_event(self, payload: bytes) -> None:
        self.wfile.write(payload)
        self.wfile.flush()

    @staticmethod
    def _parse_single_byte_range(range_header: str, file_size: int) -> tuple[int, int]:
        match = RANGE_RE.fullmatch(str(range_header or "").strip())
        if not match or file_size <= 0:
            raise ValueError("invalid or unsatisfiable byte range")
        start_text, end_text = match.groups()
        if not start_text and not end_text:
            raise ValueError("empty byte range")
        if not start_text:
            suffix_length = int(end_text)
            if suffix_length <= 0:
                raise ValueError("invalid suffix byte range")
            return max(0, file_size - suffix_length), file_size - 1
        start = int(start_text)
        if start >= file_size:
            raise ValueError("byte range starts beyond EOF")
        if not end_text:
            return start, file_size - 1
        end = int(end_text)
        if end < start:
            raise ValueError("byte range end precedes start")
        return start, min(end, file_size - 1)

    def _stream_file(
        self,
        file_path: Path,
        *,
        content_type: str,
        allow_ranges: bool = False,
        cache_control: str | None = None,
        head_only: bool = False,
    ) -> None:
        with file_path.open("rb") as handle:
            file_size = os.fstat(handle.fileno()).st_size
            range_header = self.headers.get("Range", "")
            if allow_ranges and range_header:
                try:
                    start, end = self._parse_single_byte_range(range_header, file_size)
                except (TypeError, ValueError):
                    self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                    self.send_header("Content-Range", f"bytes */{file_size}")
                    self.send_header("Content-Length", "0")
                    self.send_header("Accept-Ranges", "bytes")
                    if cache_control:
                        self.send_header("Cache-Control", cache_control)
                    self.end_headers()
                    return

                content_length = end - start + 1
                self.send_response(HTTPStatus.PARTIAL_CONTENT)
                self.send_header("Content-Type", content_type)
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
                self.send_header("Content-Length", str(content_length))
                if cache_control:
                    self.send_header("Cache-Control", cache_control)
                self.end_headers()
                if head_only:
                    return
                handle.seek(start)
                remaining = content_length
                try:
                    while remaining > 0:
                        chunk = handle.read(min(64 * 1024, remaining))
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        remaining -= len(chunk)
                except (BrokenPipeError, ConnectionResetError, OSError):
                    pass
                return

            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(file_size))
            if cache_control:
                self.send_header("Cache-Control", cache_control)
            if allow_ranges:
                self.send_header("Accept-Ranges", "bytes")
            self.end_headers()
            if head_only:
                return
            try:
                while True:
                    chunk = handle.read(64 * 1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass

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
    bound_host, bound_port = server.server_address[:2]
    actual_port = bound_port
    CONTEXT.bind_server(server, shutdown_on_last_client=shutdown_on_last_client)
    if CONTEXT.cache_manager.bbdown_login_status().get("logged_in"):
        CONTEXT.refresh_startup_gatcha_cache_in_background()
    browser_host = _local_ui_host(host)
    url = _local_ui_url(host, actual_port)
    remote_urls = [f"{base}/remote" for base in _network_access_urls(host, actual_port)]
    remote_url = remote_urls[0] if remote_urls else f"{url}/remote"
    print(f"{status_label} running on {url}", flush=True)
    print(f"{status_label} mobile remote: {remote_url}", flush=True)

    if not auto_open_browser and not shutdown_on_last_client:
        print(
            json.dumps(
                {
                    "event": "bilikara.ready",
                    "host": browser_host,
                    "port": actual_port,
                    "baseUrl": url,
                }
            ),
            flush=True,
        )

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


def _playlist_export_logo_path() -> Path | None:
    for filename in ("bili.png", "bili.jpg", "bili.jpeg"):
        candidate = STATIC_DIR / "pic" / filename
        if candidate.exists():
            return candidate
    return None


def _port_probe_hosts(host: str) -> tuple[str, ...]:
    if host == "0.0.0.0":
        return (host, "127.0.0.1")
    return (host,)


def _can_bind_port(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((host, port))
        except OSError:
            return False
    return True


def _find_available_port(host: str, preferred_port: int) -> int:
    for candidate in range(preferred_port, preferred_port + 30):
        if all(_can_bind_port(probe_host, candidate) for probe_host in _port_probe_hosts(host)):
            return candidate
    raise OSError(f"无法为 bilikara 找到可用端口，起始端口: {preferred_port}")


def _network_access_urls(host: str, port: int) -> list[str]:
    if host not in {"0.0.0.0", "::"}:
        address = _normalized_ip_address(host)
        if address is None or address.is_loopback or address.is_unspecified:
            return []
        return [f"http://{_url_host(host)}:{port}"]

    if os.name != "nt" and _is_container_runtime():
        # Container bridge addresses (commonly 172.17/16) are not reachable
        # from the host's LAN and must never be advertised as mobile URLs.
        return []
    return [
        f"http://{address}:{port}" for address in detect_lan_ipv4_addresses()
    ]
