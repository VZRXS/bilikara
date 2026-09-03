from __future__ import annotations

import copy
import json
import threading
import time
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from . import rust_runtime
from .models import HistoryEntry, PlaylistItem, SessionPlayedEntry

MAX_SESSION_USERS = 32
MAX_SESSION_USER_NAME_LENGTH = 24
MAX_AV_OFFSET_MS = 5000
MAX_VOLUME_PERCENT = 100
DEFAULT_SONG_ADVANCE_DELAY_SECONDS = 3
MAX_SONG_ADVANCE_DELAY_SECONDS = 30
MIN_KEY_SHIFT = -6
MAX_KEY_SHIFT = 6
PLAYLIST_SLOT_TYPES = frozenset({"cycle", "priority", "manual"})
PLAYLIST_ORDER_OPERATIONS = frozenset({"rebuild", "insert_cycle"})
MAX_PLAYLIST_PLAN_ITEMS = 10_000
MAX_PLAYLIST_STRING_BYTES = 512
MAX_PLAYLIST_HISTORY_KEY_BYTES = 8_192
MAX_PLAYLIST_AUDIO_PAGES = 256
MAX_SAFE_JSON_INTEGER = 9_007_199_254_740_991


def _py_apply_av_delay_action(
    state: dict[str, object], action: dict[str, object]
) -> dict[str, object]:
    """Complete Python reference for the pure Rust AV-delay state machine."""

    global_delay = int(state["global_delay_ms"])
    local_delay = int(state["local_delay_ms"])
    locked = bool(state["locked"])
    action_type = str(action["type"])

    def bounded(value: int) -> int:
        return max(-MAX_AV_OFFSET_MS, min(MAX_AV_OFFSET_MS, value))

    if action_type == "set_effective":
        local_delay = bounded(int(action["effective_delay_ms"])) - global_delay
    elif action_type == "set_persistent":
        global_delay = bounded(int(action["effective_delay_ms"]))
        local_delay = 0
        locked = global_delay != 0
    elif action_type == "adjust":
        target = bounded(global_delay + local_delay + int(action["delta_ms"]))
        local_delay = target - global_delay
    elif action_type == "reset_local":
        local_delay = 0
    elif action_type == "toggle_lock" and locked:
        local_delay += global_delay
        global_delay = 0
        locked = False
    elif action_type == "toggle_lock" and local_delay != 0:
        global_delay += local_delay
        local_delay = 0
        locked = True
    elif action_type not in {"snapshot", "toggle_lock"}:
        raise ValueError("unknown AV delay action")

    effective_delay = global_delay + local_delay
    has_local = local_delay != 0
    return {
        "schema_version": 1,
        "global_delay_ms": global_delay,
        "local_delay_ms": local_delay,
        "effective_delay_ms": effective_delay,
        "locked": locked,
        "has_local_adjustment": has_local,
        "lock_button_enabled": locked or has_local,
    }


@dataclass(frozen=True)
class PlaylistOrderItem:
    original_index: int
    item_id: str
    requester_name: str
    slot_type: str


@dataclass(frozen=True)
class PlaylistOrderRequest:
    operation: str
    session_users: tuple[str, ...]
    current_requester: str | None
    items: tuple[PlaylistOrderItem, ...]
    candidate: PlaylistOrderItem | None = None


@dataclass(frozen=True)
class PlaylistOrderPlan:
    ordered_ids: tuple[str, ...]


@dataclass(frozen=True)
class PlaylistIdentity:
    bvid: str
    aid: int
    video_page: int
    selected_audio_pages: tuple[int, ...]


@dataclass(frozen=True)
class DuplicateActiveItem:
    original_index: int
    item_id: str
    identity: PlaylistIdentity


@dataclass(frozen=True)
class DuplicateHistoryEntry:
    original_index: int
    key: str


@dataclass(frozen=True)
class PlaylistDuplicateRequest:
    candidate: PlaylistIdentity
    current_item: DuplicateActiveItem | None = None
    queued_items: tuple[DuplicateActiveItem, ...] = ()
    history_entries: tuple[DuplicateHistoryEntry, ...] = ()


@dataclass(frozen=True)
class PlaylistDuplicateDecision:
    identity_key: str
    active_duplicate_id: str | None
    history_duplicate_index: int | None


def _validate_playlist_order_item(item: object) -> PlaylistOrderItem:
    if not isinstance(item, PlaylistOrderItem):
        raise ValueError("invalid playlist order item")
    if (
        isinstance(item.original_index, bool)
        or not isinstance(item.original_index, int)
        or item.original_index < 0
        or not isinstance(item.item_id, str)
        or not item.item_id
        or "\x00" in item.item_id
        or len(item.item_id.encode("utf-8")) > MAX_PLAYLIST_STRING_BYTES
        or not isinstance(item.requester_name, str)
        or "\x00" in item.requester_name
        or len(item.requester_name.encode("utf-8")) > MAX_PLAYLIST_STRING_BYTES
        or item.slot_type not in PLAYLIST_SLOT_TYPES
    ):
        raise ValueError("invalid playlist order item")
    return item


def _validate_playlist_order_request(request: object) -> PlaylistOrderRequest:
    if not isinstance(request, PlaylistOrderRequest):
        raise ValueError("invalid playlist order request")
    if request.operation not in PLAYLIST_ORDER_OPERATIONS:
        raise ValueError("invalid playlist order operation")
    if (
        not isinstance(request.session_users, tuple)
        or any(not isinstance(name, str) or not name for name in request.session_users)
        or any(
            "\x00" in name or len(name.encode("utf-8")) > MAX_PLAYLIST_STRING_BYTES
            for name in request.session_users
        )
        or len(request.session_users) > MAX_SESSION_USERS
        or len(set(request.session_users)) != len(request.session_users)
        or request.current_requester is not None
        and not isinstance(request.current_requester, str)
        or isinstance(request.current_requester, str)
        and (
            "\x00" in request.current_requester
            or len(request.current_requester.encode("utf-8")) > MAX_PLAYLIST_STRING_BYTES
        )
        or not isinstance(request.items, tuple)
        or len(request.items) > MAX_PLAYLIST_PLAN_ITEMS
    ):
        raise ValueError("invalid playlist order request")
    item_ids: set[str] = set()
    indices: set[int] = set()
    for item in request.items:
        item = _validate_playlist_order_item(item)
        if item.item_id in item_ids or item.original_index in indices:
            raise ValueError("duplicate playlist item identity")
        item_ids.add(item.item_id)
        indices.add(item.original_index)
    if request.operation == "rebuild":
        if request.candidate is not None:
            raise ValueError("rebuild cannot include a candidate")
    else:
        candidate = _validate_playlist_order_item(request.candidate)
        if candidate.slot_type != "cycle":
            raise ValueError("insert candidate must be a cycle item")
        if len(request.items) >= MAX_PLAYLIST_PLAN_ITEMS:
            raise ValueError("playlist insertion exceeds item limit")
        if candidate.item_id in item_ids or candidate.original_index in indices:
            raise ValueError("candidate identity collides with playlist")
    return request


def _py_rotated_playlist_users(request: PlaylistOrderRequest) -> tuple[str, ...]:
    users = request.session_users
    current = request.current_requester
    if not users or current not in users:
        return users
    start = (users.index(current) + 1) % len(users)
    return users[start:] + users[:start]


def _py_playlist_cycle_state(
    request: PlaylistOrderRequest,
) -> tuple[dict[str, tuple[int, int]], dict[str, int], dict[str, int]]:
    ordered_users = _py_rotated_playlist_users(request)
    order_index = {name: index for index, name in enumerate(ordered_users)}
    requester_counts = {name: 0 for name in ordered_users}
    cycle_keys: dict[str, tuple[int, int]] = {}
    for item in request.items:
        if item.slot_type != "cycle" or item.requester_name not in order_index:
            continue
        cycle_keys[item.item_id] = (
            requester_counts[item.requester_name],
            order_index[item.requester_name],
        )
        requester_counts[item.requester_name] += 1
    return cycle_keys, requester_counts, order_index


def _py_plan_playlist_order(request: PlaylistOrderRequest) -> PlaylistOrderPlan:
    """Return the exact queue rebuild or cycle-insertion order without mutation."""

    request = _validate_playlist_order_request(request)
    cycle_keys, requester_counts, order_index = _py_playlist_cycle_state(request)
    if request.operation == "insert_cycle":
        candidate = request.candidate
        assert candidate is not None
        ordered_ids = [item.item_id for item in request.items]
        if not ordered_ids:
            return PlaylistOrderPlan((candidate.item_id,))
        if candidate.requester_name not in order_index:
            return PlaylistOrderPlan(tuple(ordered_ids + [candidate.item_id]))
        new_key = (
            requester_counts[candidate.requester_name],
            order_index[candidate.requester_name],
        )
        insert_index = 0
        for index, existing in enumerate(request.items):
            if existing.slot_type != "cycle":
                insert_index = index + 1
                continue
            existing_key = cycle_keys.get(existing.item_id)
            if existing_key is None or existing_key <= new_key:
                insert_index = index + 1
        ordered_ids.insert(insert_index, candidate.item_id)
        return PlaylistOrderPlan(tuple(ordered_ids))

    cycle_positions: list[int] = []
    sortable: list[tuple[tuple[int, int], int, str]] = []
    for position, item in enumerate(request.items):
        if item.slot_type != "cycle" or item.item_id not in cycle_keys:
            continue
        cycle_positions.append(position)
        sortable.append((cycle_keys[item.item_id], item.original_index, item.item_id))
    sortable.sort(key=lambda entry: (entry[0][0], entry[0][1], entry[1]))
    ordered_ids = [item.item_id for item in request.items]
    for target, (_, _, item_id) in zip(cycle_positions, sortable):
        ordered_ids[target] = item_id
    return PlaylistOrderPlan(tuple(ordered_ids))


def _validate_playlist_identity(identity: object) -> PlaylistIdentity:
    if not isinstance(identity, PlaylistIdentity):
        raise ValueError("invalid playlist identity")
    if (
        not isinstance(identity.bvid, str)
        or isinstance(identity.aid, bool)
        or not isinstance(identity.aid, int)
        or identity.aid < 0
        or identity.aid > 2**64 - 1
        or isinstance(identity.video_page, bool)
        or not isinstance(identity.video_page, int)
        or identity.video_page <= 0
        or identity.video_page > 2**64 - 1
        or not isinstance(identity.selected_audio_pages, tuple)
        or any(isinstance(page, bool) or not isinstance(page, int) for page in identity.selected_audio_pages)
        or len(identity.bvid.encode("utf-8")) > MAX_PLAYLIST_STRING_BYTES
        or "\x00" in identity.bvid
        or len(identity.selected_audio_pages) > MAX_PLAYLIST_AUDIO_PAGES
        or any(not -(2**63) <= page <= 2**63 - 1 for page in identity.selected_audio_pages)
    ):
        raise ValueError("invalid playlist identity")
    return identity


def _py_playlist_identity_key(identity: PlaylistIdentity) -> str:
    identity = _validate_playlist_identity(identity)
    audio_pages = [page for page in identity.selected_audio_pages if page > 0]
    audio_suffix = ":a" + "-".join(str(page) for page in audio_pages) if audio_pages else ""
    prefix = identity.bvid if identity.bvid else f"aid:{identity.aid}"
    return f"{prefix}:p{identity.video_page}{audio_suffix}"


def _py_decide_playlist_duplicate(
    request: PlaylistDuplicateRequest,
) -> PlaylistDuplicateDecision:
    """Return canonical identity and first active/history matches without mutation."""

    if not isinstance(request, PlaylistDuplicateRequest):
        raise ValueError("invalid playlist duplicate request")
    identity_key = _py_playlist_identity_key(request.candidate)
    if not isinstance(request.queued_items, tuple) or not isinstance(request.history_entries, tuple):
        raise ValueError("invalid playlist duplicate collections")
    active_items = (() if request.current_item is None else (request.current_item,)) + request.queued_items
    active_ids: set[str] = set()
    active_indices: set[int] = set()
    active_duplicate_id: str | None = None
    for item in active_items:
        if (
            not isinstance(item, DuplicateActiveItem)
            or isinstance(item.original_index, bool)
            or not isinstance(item.original_index, int)
            or item.original_index < 0
            or not isinstance(item.item_id, str)
            or not item.item_id
            or "\x00" in item.item_id
            or len(item.item_id.encode("utf-8")) > MAX_PLAYLIST_STRING_BYTES
            or item.item_id in active_ids
            or item.original_index in active_indices
        ):
            raise ValueError("invalid or duplicate active item")
        active_ids.add(item.item_id)
        active_indices.add(item.original_index)
        item_key = _py_playlist_identity_key(item.identity)
        if active_duplicate_id is None and item_key == identity_key:
            active_duplicate_id = item.item_id
    history_indices: set[int] = set()
    history_duplicate_index: int | None = None
    for entry in request.history_entries:
        if (
            not isinstance(entry, DuplicateHistoryEntry)
            or isinstance(entry.original_index, bool)
            or not isinstance(entry.original_index, int)
            or entry.original_index < 0
            or not isinstance(entry.key, str)
            or "\x00" in entry.key
            or len(entry.key.encode("utf-8")) > MAX_PLAYLIST_HISTORY_KEY_BYTES
            or entry.original_index in history_indices
        ):
            raise ValueError("invalid or duplicate history entry")
        history_indices.add(entry.original_index)
        if history_duplicate_index is None and entry.key == identity_key:
            history_duplicate_index = entry.original_index
    return PlaylistDuplicateDecision(
        identity_key=identity_key,
        active_duplicate_id=active_duplicate_id,
        history_duplicate_index=history_duplicate_index,
    )


class PlaylistStoreCommandError(ValueError):
    def __init__(self, error: rust_runtime.RustAppStateRejectedError) -> None:
        super().__init__(str(error))
        self.kind = error.kind
        raw_error = error.response.get("error")
        self.details = (
            copy.deepcopy(raw_error.get("details"))
            if isinstance(raw_error, dict)
            else None
        )


class PlaylistStore:
    """Rust AppState transport and persistence adapter.

    Every mutable application decision is committed by the process-wide Rust
    AppState.  Python keeps only a defensive projection of Rust snapshots and
    performs the existing file I/O requested by Rust persistence effects.
    """

    def __init__(
        self,
        state_file: Path,
        backup_file: Path,
        session_archive_dir: Path | None = None,
        *,
        on_change: Callable[[], None] | None = None,
    ) -> None:
        self.state_file = Path(state_file)
        self.backup_file = Path(backup_file)
        self.player_state_file = self._split_state_path(
            self.state_file, "player_state.json", "player"
        )
        self.history_state_file = self._split_state_path(
            self.state_file, "history.json", "history"
        )
        self.session_users_state_file = self._split_state_path(
            self.state_file,
            "session_users.json",
            "session-users",
        )
        self.session_archive_dir = (
            Path(session_archive_dir)
            if session_archive_dir is not None
            else self.state_file.parent / "played_sessions"
        )
        self.on_change = on_change
        self.lock = threading.RLock()
        self._snapshot: dict[str, Any] = {}
        self._persistence: dict[str, Any] = {}
        self._previous_session_path: Path | None = None
        self._cache_attempt_reservations: dict[
            int, tuple[str, dict[str, Any]]
        ] = {}

        if not rust_runtime.app_state_available():
            status = rust_runtime.runtime_status()
            raise rust_runtime.RustRuntimeUnavailableError(
                str(status.get("error") or "Rust AppState capability is unavailable")
            )

        now = time.time()
        seed = self._initial_state_seed(now)
        response = rust_runtime.app_state_request("initialize", state=seed)
        with self.lock:
            self._accept_response_unlocked(response, initializing=True)
            self._persist_response_unlocked(response)

    @property
    def revision(self) -> int:
        with self.lock:
            return int(self._snapshot["revision"])

    @property
    def session_generation(self) -> int:
        with self.lock:
            return int(self._snapshot["session_generation"])

    @property
    def playback_generation(self) -> int:
        with self.lock:
            return int(self._snapshot["playback_generation"])

    @property
    def playback_mode(self) -> str:
        with self.lock:
            return str(self._snapshot["playback_mode"])

    @property
    def av_global_delay_ms(self) -> int:
        with self.lock:
            return int(
                self._snapshot["player_settings"]["av_delay"]["global_delay_ms"]
            )

    @property
    def av_local_delay_ms(self) -> int:
        with self.lock:
            return int(
                self._snapshot["player_settings"]["av_delay"]["local_delay_ms"]
            )

    @property
    def av_delay_locked(self) -> bool:
        with self.lock:
            return bool(self._snapshot["player_settings"]["av_delay"]["locked"])

    @property
    def av_offset_ms(self) -> int:
        with self.lock:
            return int(self._snapshot["player_settings"]["av_offset_ms"])

    @property
    def volume_percent(self) -> int:
        with self.lock:
            return int(self._snapshot["player_settings"]["volume_percent"])

    @property
    def is_muted(self) -> bool:
        with self.lock:
            return bool(self._snapshot["player_settings"]["is_muted"])

    @property
    def song_advance_delay_seconds(self) -> int:
        with self.lock:
            return int(
                self._snapshot["player_settings"]["song_advance_delay_seconds"]
            )

    @property
    def key_shift(self) -> int:
        with self.lock:
            return int(self._snapshot["player_settings"]["key_shift"])

    @property
    def current_item(self) -> PlaylistItem | None:
        with self.lock:
            payload = self._snapshot.get("current_item")
            return self._item_from_payload(payload) if isinstance(payload, dict) else None

    @property
    def current_item_started(self) -> bool:
        with self.lock:
            return bool(self._snapshot.get("current_item_started", False))

    @property
    def playlist(self) -> list[PlaylistItem]:
        with self.lock:
            return [
                self._item_from_payload(payload)
                for payload in self._snapshot.get("playlist", [])
            ]

    @property
    def history(self) -> list[HistoryEntry]:
        with self.lock:
            return [
                HistoryEntry.from_dict(copy.deepcopy(payload))
                for payload in self._snapshot.get("history", [])
            ]

    @property
    def session_history(self) -> list[HistoryEntry]:
        with self.lock:
            return [
                HistoryEntry.from_dict(copy.deepcopy(payload))
                for payload in self._snapshot.get("session_history", [])
            ]

    @property
    def session_users(self) -> list[str]:
        with self.lock:
            return list(self._snapshot.get("session_users", []))

    @property
    def session_started_at(self) -> float:
        with self.lock:
            return float(self._persistence["session_started_at"])

    @property
    def session_played_file(self) -> Path:
        with self.lock:
            return self.session_archive_dir / str(
                self._persistence["session_played_file"]
            )

    @property
    def session_played(self) -> list[SessionPlayedEntry]:
        with self.lock:
            return [
                SessionPlayedEntry.from_dict(copy.deepcopy(payload))
                for payload in self._snapshot.get("session_played", [])
            ]

    @property
    def updated_at(self) -> float:
        with self.lock:
            return float(self._snapshot["updated_at"])

    @property
    def _previous_session_file(self) -> Path | None:
        with self.lock:
            summary = self._snapshot.get("previous_session") or {}
            return (
                self._previous_session_path
                if summary.get("available") is True
                else None
            )

    @property
    def _previous_session_count(self) -> int:
        with self.lock:
            summary = self._snapshot.get("previous_session") or {}
            return int(summary.get("item_count") or 0)

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            snapshot = copy.deepcopy(self._snapshot)
        current = snapshot.get("current_item")
        snapshot["current_item"] = (
            self._item_from_payload(current).to_dict()
            if isinstance(current, dict)
            else None
        )
        snapshot["playlist"] = [
            self._item_from_payload(payload).to_dict()
            for payload in snapshot.get("playlist", [])
        ]
        snapshot["history"] = [
            HistoryEntry.from_dict(payload).to_dict()
            for payload in snapshot.get("history", [])
        ]
        snapshot["session_history"] = [
            HistoryEntry.from_dict(payload).to_dict()
            for payload in snapshot.get("session_history", [])
        ]
        return snapshot

    def authoritative_snapshot(self) -> dict[str, Any]:
        with self.lock:
            response = self._request_unlocked("snapshot", include_now=False)
            return copy.deepcopy(response["snapshot"])

    def list_items(self) -> list[PlaylistItem]:
        with self.lock:
            payloads: list[dict[str, Any]] = []
            current = self._snapshot.get("current_item")
            if isinstance(current, dict):
                payloads.append(current)
            payloads.extend(self._snapshot.get("playlist", []))
            return [self._item_from_payload(payload) for payload in payloads]

    def get_item(self, item_id: str) -> PlaylistItem | None:
        normalized = str(item_id or "")
        with self.lock:
            for payload in self._item_payloads_unlocked():
                if payload.get("id") == normalized:
                    return self._item_from_payload(payload)
        return None

    def is_current_item(self, item_id: str) -> bool:
        with self.lock:
            current = self._snapshot.get("current_item")
            return bool(
                isinstance(current, dict)
                and current.get("id") == str(item_id or "")
            )

    def add_item(
        self,
        item: PlaylistItem,
        position: str = "tail",
        *,
        requester_name: str = "",
        reset_av_delay: bool = False,
        allow_repeat: bool = True,
    ) -> None:
        self._request(
            "add_item",
            item=item.serialize(),
            position=str(position),
            requester_name=str(requester_name or ""),
            reset_av_delay=bool(reset_av_delay),
            allow_repeat=bool(allow_repeat),
        )

    def has_session_users(self) -> bool:
        return bool(self.session_users)

    def has_session_user(self, name: str) -> bool:
        normalized = self.normalize_session_user_name(name)
        return bool(normalized and normalized in self.session_users)

    @classmethod
    def normalize_session_user_name(cls, name: str) -> str:
        return " ".join(str(name or "").strip().split())[:MAX_SESSION_USER_NAME_LENGTH]

    def remove_item(self, item_id: str) -> bool:
        return self._changed(self._request("remove_item", item_id=str(item_id)))

    def clear_playlist(self) -> None:
        self._request("clear_playlist")

    def clear_history(self) -> None:
        self._request("clear_history")

    def remove_history_entry(self, key: str) -> bool:
        return self._changed(self._request("remove_history_entry", key=str(key or "")))

    def advance_to_next(
        self,
        *,
        expected_playback_generation: int,
        reset_av_delay: bool = False,
    ) -> bool:
        return self._changed(
            self._request(
                "advance_to_next",
                expected_playback_generation=expected_playback_generation,
                reset_av_delay=bool(reset_av_delay),
            )
        )

    def move_item(self, item_id: str, direction: str) -> bool:
        return self._changed_or_found(
            self._request(
                "move_item", item_id=str(item_id), direction=str(direction)
            )
        )

    def move_to_next(self, item_id: str) -> bool:
        return self._changed_or_found(
            self._request("move_to_next", item_id=str(item_id))
        )

    def move_item_to_index(self, item_id: str, target_index: int) -> bool:
        return self._changed_or_found(
            self._request(
                "move_item_to_index",
                item_id=str(item_id),
                target_index=int(target_index),
            )
        )

    def resort_playlist_by_cycle(self) -> bool:
        return self._changed(self._request("resort_playlist_by_cycle"))

    def move_to_front(self, item_id: str, *, reset_av_delay: bool = False) -> bool:
        return self._changed(
            self._request(
                "move_to_front",
                item_id=str(item_id),
                reset_av_delay=bool(reset_av_delay),
            )
        )

    def set_current_item(
        self,
        item_id: str | None,
        *,
        reset_av_delay: bool = False,
    ) -> bool:
        return self._changed_or_found(
            self._request(
                "set_current_item",
                item_id=None if item_id is None else str(item_id),
                reset_av_delay=bool(reset_av_delay),
            )
        )

    def set_mode(self, mode: str) -> None:
        self._request("set_playback_mode", mode=str(mode))

    def set_av_offset_ms(self, offset_ms: int) -> int:
        result = self._request(
            "apply_av_delay",
            action={
                "type": "set_persistent",
                "effective_delay_ms": int(offset_ms),
            },
        )
        return int(result["effective_delay_ms"])

    def apply_av_delay_action(
        self, action: dict[str, object]
    ) -> dict[str, object]:
        return self._request("apply_av_delay", action=dict(action))

    def reset_av_delay_for_track_change(self) -> dict[str, object]:
        return self.apply_av_delay_action({"type": "reset_local"})

    def set_volume_percent(self, volume_percent: int) -> int:
        result = self._request("set_volume", volume_percent=int(volume_percent))
        return int(result["value"])

    def set_muted(self, is_muted: bool) -> bool:
        result = self._request("set_muted", is_muted=bool(is_muted))
        return bool(result["value"])

    def set_key_shift(self, key_shift: int) -> int:
        result = self._request("set_key_shift", key_shift=int(key_shift))
        return int(result["value"])

    def set_song_advance_delay_seconds(self, delay_seconds: int) -> int:
        result = self._request(
            "set_song_advance_delay", delay_seconds=int(delay_seconds)
        )
        return int(result["value"])

    def set_audio_variant(
        self,
        item_id: str,
        variant_id: str,
        *,
        expected_item_incarnation_id: str,
    ) -> bool:
        if (
            not isinstance(expected_item_incarnation_id, str)
            or not expected_item_incarnation_id
        ):
            raise ValueError(
                "expected item incarnation must be a non-empty Rust identity"
            )
        result = self._request(
            "set_audio_variant",
            item_id=str(item_id),
            variant_id=str(variant_id or ""),
            expected_item_incarnation_id=expected_item_incarnation_id,
        )
        return self._changed_or_found(result)

    def update_item(
        self,
        item_id: str,
        *,
        persist_backup: bool = False,
        **changes: object,
    ) -> bool:
        allowed = {
            "title",
            "part_title",
            "display_title",
            "cover_url",
            "embed_url",
            "owner_mid",
            "owner_name",
            "owner_url",
        }
        unsupported = sorted(set(changes).difference(allowed))
        if unsupported:
            raise ValueError(
                "unsupported PlaylistItem metadata fields: "
                + ", ".join(unsupported)
            )
        patch = {key: copy.deepcopy(value) for key, value in changes.items()}
        try:
            self._request(
                "update_item",
                item_id=str(item_id),
                changes=patch,
                persist_backup=bool(persist_backup),
            )
        except PlaylistStoreCommandError as exc:
            if exc.kind == "item_not_found":
                return False
            raise
        return True

    def apply_cache_event(
        self,
        item_id: str,
        *,
        cache_attempt_token: int,
        event: dict[str, Any],
    ) -> bool:
        if (
            isinstance(cache_attempt_token, bool)
            or not isinstance(cache_attempt_token, int)
            or cache_attempt_token <= 0
        ):
            raise ValueError("cache attempt token must be a positive integer")
        terminal = str(event.get("kind") or "") in {
            "ready",
            "failed",
            "cancelled",
            "evicted",
            "reset",
        }
        try:
            result = self._request(
                "apply_cache_event",
                item_id=str(item_id),
                cache_attempt_token=cache_attempt_token,
                event=copy.deepcopy(event),
            )
        except PlaylistStoreCommandError as exc:
            if exc.kind == "item_not_found":
                return False
            raise
        finally:
            if terminal:
                with self.lock:
                    self._cache_attempt_reservations.pop(
                        cache_attempt_token, None
                    )
        return bool(result.get("applied"))

    def begin_cache_attempt(
        self,
        item_id: str,
        expected_item_incarnation_id: str,
    ) -> int:
        normalized_item_id = str(item_id)
        if not isinstance(expected_item_incarnation_id, str) or not expected_item_incarnation_id:
            raise ValueError("expected item incarnation must be a non-empty Rust identity")
        with self.lock:
            result = self._request(
                "begin_cache_attempt",
                include_now=False,
                item_id=normalized_item_id,
                expected_item_incarnation_id=expected_item_incarnation_id,
            )
            token = result.get("cache_attempt_token")
            if (
                isinstance(token, bool)
                or not isinstance(token, int)
                or token <= 0
            ):
                raise rust_runtime.RustAppStateError(
                    "internal_error",
                    "invalid_cache_attempt_token",
                    "Rust AppState returned an invalid cache attempt token",
                    response={"result": copy.deepcopy(result)},
                )
            reservation_item_id = result.get("item_id")
            item_incarnation_id = result.get("item_incarnation_id")
            artifact_set_id = result.get("artifact_set_id")
            artifact_relative_directory = result.get(
                "artifact_relative_directory"
            )
            if (
                reservation_item_id != normalized_item_id
                or item_incarnation_id != expected_item_incarnation_id
                or not all(
                    isinstance(value, str) and bool(value)
                    for value in (
                        item_incarnation_id,
                        artifact_set_id,
                        artifact_relative_directory,
                    )
                )
                or not isinstance(result.get("refresh"), bool)
            ):
                raise rust_runtime.RustAppStateError(
                    "internal_error",
                    "invalid_cache_attempt_reservation",
                    "Rust AppState returned an invalid cache attempt reservation",
                    response={"result": copy.deepcopy(result)},
                )
            superseded = [
                existing_token
                for existing_token, (existing_item_id, _reservation) in (
                    self._cache_attempt_reservations.items()
                )
                if existing_item_id == normalized_item_id
            ]
            for existing_token in superseded:
                self._cache_attempt_reservations.pop(existing_token, None)
            self._cache_attempt_reservations[token] = (
                normalized_item_id,
                copy.deepcopy(result),
            )
        return token

    def cache_attempt_reservation(self, cache_attempt_token: int) -> dict[str, Any]:
        if (
            isinstance(cache_attempt_token, bool)
            or not isinstance(cache_attempt_token, int)
            or cache_attempt_token <= 0
        ):
            raise ValueError("cache attempt token must be a positive integer")
        with self.lock:
            record = self._cache_attempt_reservations.get(cache_attempt_token)
            if record is None:
                raise ValueError("cache attempt reservation is unavailable")
            return copy.deepcopy(record[1])

    def authorize_cache_publication(
        self,
        item_id: str,
        *,
        cache_attempt_token: int,
        item_incarnation_id: str,
        artifact_set_id: str,
        artifact_relative_directory: str,
    ) -> bool:
        result = self._request(
            "authorize_cache_publication",
            include_now=False,
            item_id=str(item_id),
            cache_attempt_token=int(cache_attempt_token),
            item_incarnation_id=str(item_incarnation_id),
            artifact_set_id=str(artifact_set_id),
            artifact_relative_directory=str(artifact_relative_directory),
        )
        return result.get("authorized") is True

    def add_session_user(self, name: str) -> bool:
        return self._changed(self._request("add_session_user", name=str(name or "")))

    def remove_session_user(self, name: str) -> bool:
        return self._changed(
            self._request("remove_session_user", name=str(name or ""))
        )

    def rename_session_user(self, current_name: str, new_name: str) -> str:
        result = self._request(
            "rename_session_user",
            current_name=str(current_name or ""),
            new_name=str(new_name or ""),
        )
        return str(result["name"])

    def move_session_user_to_index(self, name: str, target_index: int) -> bool:
        return self._changed_or_found(
            self._request(
                "move_session_user_to_index",
                name=str(name or ""),
                target_index=int(target_index),
            )
        )

    def set_session_users(self, users: list[str]) -> bool:
        return self._changed(
            self._request("set_session_users", users=[str(user) for user in users])
        )

    def restore_backup(self, *, reset_av_delay: bool = False) -> bool:
        result = self._request(
            "restore_backup", reset_av_delay=bool(reset_av_delay)
        )
        return self._changed(result)

    def discard_backup(self) -> bool:
        return self._changed(
            self._request("discard_backup", new_session=self._new_session_seed())
        )

    def reset_runtime_data(self) -> None:
        self._request("reset_runtime", new_session=self._new_session_seed())

    def reset_player_state(self) -> None:
        self._request("reset_player")

    def restart_playback_program(self) -> bool:
        return self._changed(
            self._request("restart_playback_program", include_now=False)
        )

    def backup_summary(self) -> dict[str, Any]:
        with self.lock:
            return copy.deepcopy(self._snapshot.get("backup") or {"available": False})

    def continue_previous_session(self) -> bool:
        with self.lock:
            candidate = self._previous_session_path
            archive = self._session_archive_seed(candidate) if candidate else None
            result = self._request_unlocked(
                "continue_previous_session",
                archive=archive,
            )["result"]
            if not self._snapshot.get("previous_session", {}).get("available"):
                self._previous_session_path = None
            return self._changed(result)

    def session_request_for_item(self, item: PlaylistItem) -> HistoryEntry | None:
        result = self._request(
            "query_duplicate", include_now=False, item=item.serialize()
        )
        entry = result.get("session_entry")
        return (
            HistoryEntry.from_dict(copy.deepcopy(entry))
            if isinstance(entry, dict)
            else None
        )

    def active_duplicate_for_item(self, item: PlaylistItem) -> PlaylistItem | None:
        result = self._request(
            "query_duplicate", include_now=False, item=item.serialize()
        )
        active = result.get("active_item")
        return self._item_from_payload(active) if isinstance(active, dict) else None

    def session_played_snapshot(self) -> list[dict[str, Any]]:
        entries = self.session_played
        result: list[dict[str, Any]] = []
        for entry in entries:
            payload = entry.to_dict()
            payload["requested_at"] = entry.played_at
            payload["request_count"] = 1
            result.append(payload)
        return result

    def missing_owner_urls(self) -> list[str]:
        urls: list[str] = []
        seen: set[str] = set()
        for entry in [*self.list_items(), *self.history]:
            source = str(entry.resolved_url or entry.original_url).strip()
            if not source or str(entry.owner_name or "").strip() or source in seen:
                continue
            seen.add(source)
            urls.append(source)
        return urls

    def update_owner_info_for_url(
        self,
        source_url: str,
        *,
        owner_mid: int,
        owner_name: str,
        owner_url: str,
    ) -> bool:
        return self._changed(
            self._request(
                "update_owner_info",
                source_url=str(source_url or ""),
                owner_mid=int(owner_mid),
                owner_name=str(owner_name or ""),
                owner_url=str(owner_url or ""),
            )
        )

    def mark_item_playback_started(self, item_id: str) -> bool:
        return self._changed_or_found(
            self._request("mark_current_item_started", item_id=str(item_id or ""))
        )

    def apply_player_status_observation(
        self,
        *,
        expected_playback_generation: int,
        item_id: str,
        is_paused: bool,
        current_time: float,
        duration: float,
    ) -> dict[str, bool]:
        result = self._request(
            "apply_player_status_observation",
            expected_playback_generation=expected_playback_generation,
            item_id=str(item_id or ""),
            is_paused=is_paused,
            current_time=current_time,
            duration=duration,
        )
        required = {"changed", "started_changed", "threshold_changed"}
        if set(result) != required or any(
            not isinstance(result.get(key), bool) for key in required
        ):
            raise rust_runtime.RustAppStateError(
                "internal_error",
                "invalid_player_status_observation_result",
                "Rust AppState returned an invalid player-status observation result",
                response={"result": copy.deepcopy(result)},
            )
        return {key: result[key] for key in required}

    def mark_session_played_threshold_reached(self, item_id: str) -> bool:
        return self._changed(
            self._request(
                "mark_session_played_threshold", item_id=str(item_id or "")
            )
        )

    def shutdown(self) -> None:
        with self.lock:
            rust_runtime.app_state_request("shutdown")
            self._snapshot = {}
            self._persistence = {}
            self._cache_attempt_reservations.clear()

    def history_key_for_item(self, item: PlaylistItem) -> str:
        result = self._request(
            "query_duplicate", include_now=False, item=item.serialize()
        )
        return str(result["identity_key"])

    def _requester_cycle_state_unlocked(
        self,
    ) -> tuple[dict[str, tuple[int, int]], defaultdict[str, int], dict[str, int]]:
        users = self.session_users
        current = self.current_item
        if current and current.requester_name in users:
            start = (users.index(current.requester_name) + 1) % len(users)
            users = users[start:] + users[:start]
        order_index = {name: index for index, name in enumerate(users)}
        counts: defaultdict[str, int] = defaultdict(int)
        cycle_keys: dict[str, tuple[int, int]] = {}
        for item in self.playlist:
            if item.queue_slot_type != "cycle" or item.requester_name not in order_index:
                continue
            cycle_keys[item.id] = (counts[item.requester_name], order_index[item.requester_name])
            counts[item.requester_name] += 1
        return cycle_keys, counts, order_index

    def _request(
        self,
        command: str,
        *,
        include_now: bool = True,
        **fields: Any,
    ) -> dict[str, Any]:
        with self.lock:
            return self._request_unlocked(
                command, include_now=include_now, **fields
            )["result"]

    def open_internet_remote_peer(
        self, peer_id: str, epoch: str, profile: str = "controller"
    ) -> dict[str, Any]:
        return self._request(
            "open_internet_remote_peer",
            include_now=False,
            peer_id=peer_id,
            epoch=epoch,
            profile=profile,
        )

    def close_internet_remote_peer(self, peer_id: str) -> dict[str, Any]:
        return self._request(
            "close_internet_remote_peer",
            include_now=False,
            peer_id=peer_id,
        )

    def internet_remote_state(self) -> dict[str, Any]:
        return self._request(
            "internet_remote_state",
            include_now=False,
        )

    def dispatch_internet_remote_message(
        self,
        peer_id: str,
        lane: str,
        message: str,
        *,
        reset_av_delay: bool = False,
    ) -> dict[str, Any]:
        return self._request(
            "dispatch_internet_remote_message",
            peer_id=peer_id,
            lane=lane,
            message=message,
            reset_av_delay=bool(reset_av_delay),
        )

    def complete_internet_remote_playlist_add(
        self,
        peer_id: str,
        request_id: str,
        item: PlaylistItem,
        *,
        reset_av_delay: bool = False,
    ) -> dict[str, Any]:
        return self._request(
            "complete_internet_remote_playlist_add",
            peer_id=peer_id,
            request_id=request_id,
            item=item.serialize(),
            reset_av_delay=bool(reset_av_delay),
        )

    def cancel_internet_remote_playlist_add(
        self,
        peer_id: str,
        request_id: str,
    ) -> dict[str, Any]:
        return self._request(
            "cancel_internet_remote_playlist_add",
            include_now=False,
            peer_id=peer_id,
            request_id=request_id,
        )

    def _request_unlocked(
        self,
        command: str,
        *,
        include_now: bool = True,
        **fields: Any,
    ) -> dict[str, Any]:
        if include_now:
            fields["now"] = time.time()
        try:
            response = rust_runtime.app_state_request(command, **fields)
        except rust_runtime.RustAppStateRejectedError as exc:
            raise PlaylistStoreCommandError(exc) from exc
        self._accept_response_unlocked(response)
        self._persist_response_unlocked(response)
        if response["committed"] and self.on_change is not None:
            self.on_change()
        return response

    def _accept_response_unlocked(
        self,
        response: dict[str, Any],
        *,
        initializing: bool = False,
    ) -> None:
        snapshot = response.get("snapshot")
        persistence = response.get("persistence")
        if not isinstance(snapshot, dict) or not isinstance(persistence, dict):
            raise rust_runtime.RustAppStateError(
                "internal_error",
                "missing_authoritative_snapshot",
                "Rust AppState response omitted authoritative state",
                response=response,
            )
        self._validate_projection_wire(snapshot, persistence, response)
        revision = snapshot.get("revision")
        if isinstance(revision, bool) or not isinstance(revision, int) or revision < 1:
            raise rust_runtime.RustAppStateError(
                "internal_error",
                "invalid_revision",
                "Rust AppState returned an invalid revision",
                response=response,
            )
        current_revision = self._snapshot.get("revision")
        if (
            not initializing
            and isinstance(current_revision, int)
            and revision < current_revision
        ):
            raise rust_runtime.RustAppStateError(
                "internal_error",
                "stale_snapshot",
                "Rust AppState returned a stale snapshot",
                response=response,
            )
        self._snapshot = copy.deepcopy(snapshot)
        self._persistence = copy.deepcopy(persistence)
        live_incarnations = {
            str(item.get("id") or ""): str(
                item.get("item_incarnation_id") or ""
            )
            for item in self._item_payloads_unlocked()
        }
        stale_reservations = [
            token
            for token, (item_id, reservation) in (
                self._cache_attempt_reservations.items()
            )
            if live_incarnations.get(item_id)
            != str(reservation.get("item_incarnation_id") or "")
        ]
        for token in stale_reservations:
            self._cache_attempt_reservations.pop(token, None)
        if not self._snapshot.get("previous_session", {}).get("available"):
            self._previous_session_path = None

    @staticmethod
    def _validate_projection_wire(
        snapshot: dict[str, Any],
        persistence: dict[str, Any],
        response: dict[str, Any],
    ) -> None:
        snapshot_collections = {
            "playlist",
            "history",
            "session_history",
            "session_users",
            "session_played",
        }
        snapshot_objects = {
            "player_settings",
            "backup",
            "previous_session",
        }
        persistence_collections = {
            "history",
            "session_users",
            "session_played",
        }
        persistence_required = {
            "playback_mode",
            "player_settings",
            "session_started_at",
            "session_played_file",
            "updated_at",
        }
        valid = (
            snapshot.get("schema_version") == 1
            and all(isinstance(snapshot.get(key), list) for key in snapshot_collections)
            and all(isinstance(snapshot.get(key), dict) for key in snapshot_objects)
            and (
                snapshot.get("current_item") is None
                or isinstance(snapshot.get("current_item"), dict)
            )
        )
        generations = [
            snapshot.get("revision"),
            snapshot.get("session_generation"),
            snapshot.get("playback_generation"),
        ]
        playback_program = snapshot.get("playback_program")
        program_keys = {
            "item_id",
            "item_incarnation_id",
            "selected_audio_variant_id",
            "artifact_set_id",
        }
        valid_program = playback_program is None or (
            isinstance(playback_program, dict)
            and set(playback_program) == program_keys
            and isinstance(playback_program.get("item_id"), str)
            and bool(playback_program["item_id"])
            and isinstance(playback_program.get("item_incarnation_id"), str)
            and bool(playback_program["item_incarnation_id"])
            and isinstance(playback_program.get("selected_audio_variant_id"), str)
            and (
                playback_program.get("artifact_set_id") is None
                or (
                    isinstance(playback_program.get("artifact_set_id"), str)
                    and bool(playback_program["artifact_set_id"])
                )
            )
        )
        valid = bool(valid) and (
            isinstance(snapshot.get("playback_mode"), str)
            and isinstance(snapshot.get("current_item_started"), bool)
            and isinstance(snapshot.get("updated_at"), (int, float))
            and "playback_program" in snapshot
            and valid_program
            and (snapshot.get("current_item") is None) == (playback_program is None)
            and all(
                isinstance(value, int) and not isinstance(value, bool) and value >= 1
                for value in generations
            )
            and snapshot.get("playback_generation") <= MAX_SAFE_JSON_INTEGER
            and all(key in persistence for key in persistence_required)
            and isinstance(persistence.get("player_settings"), dict)
            and all(
                isinstance(persistence.get(key), list)
                for key in persistence_collections
            )
            and isinstance(persistence.get("playback_mode"), str)
            and isinstance(persistence.get("session_played_file"), str)
        )
        if not valid:
            raise rust_runtime.RustAppStateError(
                "internal_error",
                "invalid_authoritative_projection",
                "Rust AppState returned an invalid authoritative projection",
                response=response,
            )

    def _persist_response_unlocked(self, response: dict[str, Any]) -> None:
        effects = response["effects"]
        persistence = self._persistence
        if effects.get("delete_runtime_files") is True:
            self._delete_runtime_json_files_unlocked()
        if effects.get("write_core") is True:
            settings = persistence["player_settings"]
            self._write_json_payload_unlocked(
                self.player_state_file,
                {
                    "playback_mode": persistence["playback_mode"],
                    "player_settings": {
                        "global_av_delay_ms": settings["global_av_delay_ms"],
                        "av_delay_locked": settings["av_delay_locked"],
                        "volume_percent": settings["volume_percent"],
                        "is_muted": settings["is_muted"],
                        "song_advance_delay_seconds": settings[
                            "song_advance_delay_seconds"
                        ],
                        "key_shift": settings["key_shift"],
                    },
                    "updated_at": persistence["updated_at"],
                },
            )
            self._write_json_payload_unlocked(
                self.history_state_file,
                {
                    "history": copy.deepcopy(persistence["history"]),
                    "updated_at": persistence["updated_at"],
                },
            )
            self._write_json_payload_unlocked(
                self.session_users_state_file,
                {
                    "session_users": list(persistence["session_users"]),
                    "updated_at": persistence["updated_at"],
                },
            )
            self.state_file.unlink(missing_ok=True)
        if effects.get("write_session_played") is True:
            session_file = self.session_archive_dir / str(
                persistence["session_played_file"]
            )
            entries = copy.deepcopy(persistence["session_played"])
            if entries:
                self._write_json_payload_unlocked(
                    session_file,
                    {
                        "session_started_at": persistence["session_started_at"],
                        "updated_at": persistence["updated_at"],
                        "items": entries,
                    },
                )
            else:
                session_file.unlink(missing_ok=True)
        if effects.get("write_backup") is True:
            backup = persistence.get("backup")
            if isinstance(backup, dict):
                played = backup.get("played_session")
                self._write_json_payload_unlocked(
                    self.backup_file,
                    {
                        "current_item": copy.deepcopy(backup.get("current_item")),
                        "playlist": copy.deepcopy(backup.get("playlist") or []),
                        "played_session": (
                            {
                                "file": played["file_name"],
                                "session_started_at": played["session_started_at"],
                            }
                            if isinstance(played, dict)
                            else None
                        ),
                        "updated_at": backup["updated_at"],
                    },
                )
            else:
                self.backup_file.unlink(missing_ok=True)
        if effects.get("delete_backup") is True:
            self.backup_file.unlink(missing_ok=True)

    def _initial_state_seed(self, now: float) -> dict[str, Any]:
        player = self._read_json_payload_unlocked(self.player_state_file) or {}
        history_payload = self._read_json_payload_unlocked(self.history_state_file) or {}
        users_payload = self._read_json_payload_unlocked(
            self.session_users_state_file
        ) or {}
        settings = player.get("player_settings")
        settings = settings if isinstance(settings, dict) else {}
        if "global_av_delay_ms" in settings:
            global_delay = self._bounded_int(
                settings.get("global_av_delay_ms"), 0, -MAX_AV_OFFSET_MS, MAX_AV_OFFSET_MS
            )
            locked = settings.get("av_delay_locked", False)
            locked = locked if isinstance(locked, bool) else False
        else:
            global_delay = self._bounded_int(
                settings.get("av_offset_ms"), 0, -MAX_AV_OFFSET_MS, MAX_AV_OFFSET_MS
            )
            locked = global_delay != 0
        users: list[str] = []
        for value in users_payload.get("session_users") or []:
            normalized = self.normalize_session_user_name(str(value or ""))
            if not normalized or normalized in users:
                continue
            users.append(normalized)
            if len(users) >= MAX_SESSION_USERS:
                break
        history = [
            HistoryEntry.from_dict(dict(entry)).serialize()
            for entry in history_payload.get("history") or []
            if isinstance(entry, dict)
        ]
        session_file = self._session_played_file_for_timestamp(now)
        previous = self._latest_previous_session_seed(session_file)
        backup = self._backup_seed(now)
        return {
            "playback_mode": "local",
            "player_settings": {
                "global_av_delay_ms": global_delay,
                "local_av_delay_ms": 0,
                "av_delay_locked": locked,
                "volume_percent": self._bounded_int(
                    settings.get("volume_percent"), 100, 0, MAX_VOLUME_PERCENT
                ),
                "is_muted": bool(settings.get("is_muted", False)),
                "song_advance_delay_seconds": self._bounded_int(
                    settings.get("song_advance_delay_seconds"),
                    DEFAULT_SONG_ADVANCE_DELAY_SECONDS,
                    0,
                    MAX_SONG_ADVANCE_DELAY_SECONDS,
                ),
                "key_shift": self._bounded_int(
                    settings.get("key_shift"), 0, MIN_KEY_SHIFT, MAX_KEY_SHIFT
                ),
            },
            "current_item": None,
            "current_item_started": False,
            "playlist": [],
            "history": history,
            "session_history": [],
            "session_users": users,
            "session_started_at": now,
            "session_played_file": session_file.name,
            "session_played": [],
            "previous_session": previous,
            "backup": backup,
            "updated_at": now,
        }

    def _backup_seed(self, now: float) -> dict[str, Any] | None:
        payload = self._read_json_payload_unlocked(self.backup_file)
        if not payload:
            return None
        current = self._normalized_item_payload(payload.get("current_item"))
        playlist = [
            item
            for item in (
                self._normalized_item_payload(entry)
                for entry in payload.get("playlist") or []
            )
            if item is not None
        ]
        if current is None and not playlist:
            return None
        played_seed = None
        played = payload.get("played_session")
        if isinstance(played, dict):
            name = Path(str(played.get("file") or "")).name
            if name:
                played_seed = self._session_archive_seed(
                    self.session_archive_dir / name
                )
        return {
            "current_item": current,
            "playlist": playlist,
            "played_session": played_seed,
            "updated_at": self._positive_float(payload.get("updated_at"), now),
        }

    def _latest_previous_session_seed(
        self, current_file: Path
    ) -> dict[str, Any] | None:
        if not self.session_archive_dir.exists():
            return None
        try:
            candidates = sorted(
                self.session_archive_dir.glob("played-*.json"),
                key=lambda path: path.name,
                reverse=True,
            )
        except OSError:
            return None
        for candidate in candidates:
            if candidate == current_file:
                continue
            archive = self._session_archive_seed(candidate)
            if archive and archive["items"]:
                self._previous_session_path = candidate
                return archive
        return None

    def _session_archive_seed(self, path: Path) -> dict[str, Any] | None:
        payload = self._read_json_payload_unlocked(path)
        if not payload:
            return None
        entries: list[dict[str, Any]] = []
        for entry in payload.get("items") or []:
            if not isinstance(entry, dict):
                continue
            try:
                entries.append(SessionPlayedEntry.from_dict(dict(entry)).serialize())
            except TypeError:
                continue
        return {
            "file_name": path.name,
            "session_started_at": self._positive_float(
                payload.get("session_started_at"), time.time()
            ),
            "items": entries,
        }

    def _new_session_seed(self) -> dict[str, Any]:
        now = time.time()
        return {
            "file_name": self._session_played_file_for_timestamp(now).name,
            "session_started_at": now,
            "items": [],
        }

    def _item_payloads_unlocked(self) -> list[dict[str, Any]]:
        payloads: list[dict[str, Any]] = []
        current = self._snapshot.get("current_item")
        if isinstance(current, dict):
            payloads.append(current)
        payloads.extend(self._snapshot.get("playlist", []))
        return payloads

    @staticmethod
    def _item_from_payload(payload: dict[str, Any]) -> PlaylistItem:
        return PlaylistItem.from_dict(copy.deepcopy(payload))

    @classmethod
    def _normalized_item_payload(cls, payload: object) -> dict[str, Any] | None:
        if not isinstance(payload, dict):
            return None
        try:
            item = PlaylistItem.from_dict(dict(payload))
        except TypeError:
            return None
        item.cache_status = "pending"
        item.cache_progress = 0.0
        item.cache_message = "待缓存"
        item.video_relative_path = ""
        item.video_media_url = ""
        item.audio_variants = []
        item.selected_audio_variant_id = ""
        return item.serialize()

    @staticmethod
    def _changed(result: dict[str, Any]) -> bool:
        return result.get("changed") is True

    @classmethod
    def _changed_or_found(cls, result: dict[str, Any]) -> bool:
        return cls._changed(result) or result.get("found") is True

    @staticmethod
    def _bounded_int(value: object, default: int, lower: int, upper: int) -> int:
        try:
            parsed = int(value)
        except (TypeError, ValueError):
            parsed = default
        return max(lower, min(upper, parsed))

    @staticmethod
    def _positive_float(value: object, default: float) -> float:
        try:
            parsed = float(value)
        except (TypeError, ValueError):
            return default
        return parsed if parsed > 0 and parsed < float("inf") else default

    @staticmethod
    def _read_json_payload_unlocked(path: Path) -> dict[str, Any] | None:
        if not path.exists():
            return None
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return None
        return payload if isinstance(payload, dict) else None

    @staticmethod
    def _write_json_payload_unlocked(path: Path, payload: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    def _delete_runtime_json_files_unlocked(self) -> None:
        keep_names = {
            "gatcha_cache.json",
            "gatcha_uids.json",
            "gatcha_favlist.json",
        }
        for path in self.state_file.parent.glob("*.json"):
            if path.name not in keep_names:
                path.unlink(missing_ok=True)

    @staticmethod
    def _split_state_path(state_file: Path, default_name: str, suffix: str) -> Path:
        if state_file.name == "state.json":
            return state_file.with_name(default_name)
        return state_file.with_name(f"{state_file.stem}-{suffix}.json")

    def _session_played_file_for_timestamp(self, timestamp: float) -> Path:
        return self.session_archive_dir / f"played-{self._session_file_label(timestamp)}.json"

    @staticmethod
    def _session_file_label(timestamp: float) -> str:
        return datetime.fromtimestamp(timestamp).astimezone().strftime(
            "%Y-%m-%d_%H-%M-%S-%f"
        )
