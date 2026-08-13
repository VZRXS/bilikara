from __future__ import annotations

import json
import re
import sys
import threading
import time
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from .models import HistoryEntry, PlaylistItem, SessionPlayedEntry
from . import rust_backend
from .playback_selector import (
    PlaybackSelector,
    capture_playback_selector,
    normalize_persisted_playback_selector_mode,
    playback_selector_snapshot,
    validate_playback_selector_mode,
)

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


class PlaylistStore:
    def __init__(
        self,
        state_file: Path,
        backup_file: Path,
        session_archive_dir: Path | None = None,
        *,
        on_change: Callable[[], None] | None = None,
    ) -> None:
        self.state_file = state_file
        self.backup_file = backup_file
        self.player_state_file = self._split_state_path(state_file, "player_state.json", "player")
        self.history_state_file = self._split_state_path(state_file, "history.json", "history")
        self.session_users_state_file = self._split_state_path(
            state_file,
            "session_users.json",
            "session-users",
        )
        self.session_archive_dir = session_archive_dir or state_file.parent / "played_sessions"
        self.on_change = on_change
        self.lock = threading.RLock()
        self.playback_mode = "local"
        self.playback_selector_mode = "python"
        self.playback_selector_warning = ""
        self.av_global_delay_ms = 0
        self.av_local_delay_ms = 0
        self.av_delay_locked = False
        self.volume_percent = 100
        self.is_muted = False
        self.song_advance_delay_seconds = DEFAULT_SONG_ADVANCE_DELAY_SECONDS
        self.key_shift = 0
        self.current_item: PlaylistItem | None = None
        self.current_item_started = False
        self.playlist: list[PlaylistItem] = []
        self.history: list[HistoryEntry] = []
        self.session_history: list[HistoryEntry] = []
        self.session_users: list[str] = []
        self.session_started_at = time.time()
        self.session_played_file = self._session_played_file_for_timestamp(
            self.session_started_at
        )
        self.session_played: list[SessionPlayedEntry] = []
        (
            self._previous_session_file,
            self._previous_session_count,
        ) = self._latest_previous_session_file_unlocked()
        self.updated_at = time.time()
        self._restore_persistent_state()
        self._save_session()

    def snapshot(self) -> dict:
        with self.lock:
            return {
                "playback_mode": self.playback_mode,
                "playback_selector": playback_selector_snapshot(
                    self.playback_selector_mode,
                    self.playback_selector_warning,
                ),
                "player_settings": {
                    "av_offset_ms": self.av_offset_ms,
                    "av_delay": self._av_delay_snapshot_unlocked(),
                    "volume_percent": self.volume_percent,
                    "is_muted": self.is_muted,
                    "song_advance_delay_seconds": self.song_advance_delay_seconds,
                    "key_shift": self.key_shift,
                },
                "playlist": [item.to_dict() for item in self.playlist],
                "current_item": self.current_item.to_dict() if self.current_item else None,
                "history": [entry.to_dict() for entry in self.history],
                "session_history": [entry.to_dict() for entry in self.session_history],
                "session_users": list(self.session_users),
                "updated_at": self.updated_at,
                "backup": self._backup_summary_unlocked(),
                "previous_session": self._previous_session_summary_unlocked(),
            }

    def list_items(self) -> list[PlaylistItem]:
        with self.lock:
            items: list[PlaylistItem] = []
            if self.current_item:
                items.append(PlaylistItem.from_dict(self.current_item.serialize()))
            items.extend(
                PlaylistItem.from_dict(item.serialize()) for item in self.playlist
            )
            return items

    def get_item(self, item_id: str) -> PlaylistItem | None:
        with self.lock:
            return self._find_item_unlocked(item_id)

    def is_current_item(self, item_id: str) -> bool:
        with self.lock:
            return bool(self.current_item and self.current_item.id == item_id)

    def capture_playback_selector(self) -> PlaybackSelector:
        with self.lock:
            mode = self.playback_selector_mode
        return capture_playback_selector(mode)

    def set_playback_selector_mode(self, mode: object) -> str:
        validated = validate_playback_selector_mode(mode)
        normalized, warning = normalize_persisted_playback_selector_mode(validated)
        with self.lock:
            if (
                self.playback_selector_mode == normalized
                and not self.playback_selector_warning
            ):
                return normalized
            self.playback_selector_mode = normalized
            self.playback_selector_warning = ""
            self._touch(persist_backup=False)
        return normalized

    def add_item(
        self,
        item: PlaylistItem,
        position: str = "tail",
        *,
        requester_name: str = "",
        reset_av_delay: bool = False,
    ) -> None:
        playback_selector = (
            self.capture_playback_selector() if reset_av_delay else None
        )
        with self.lock:
            normalized_requester = self._validate_requester_name_unlocked(requester_name)
            item.requester_name = normalized_requester
            item.queue_slot_type = "priority" if position == "next" else "cycle"
            if self.current_item is None:
                self._clear_previous_session_unlocked()
                self.current_item = item
                self.current_item_started = False
                if reset_av_delay:
                    assert playback_selector is not None
                    self._apply_av_delay_action_unlocked(
                        {"type": "reset_local"},
                        playback_selector=playback_selector,
                        persist=False,
                    )
                self._record_session_played_unlocked(item)
                self._touch(persist_backup=True)
                return
            if position == "next":
                self.playlist.insert(0, item)
            else:
                self._insert_cycle_item_unlocked(item)
            self._touch(persist_backup=True)

    def has_session_users(self) -> bool:
        with self.lock:
            return bool(self.session_users)

    def has_session_user(self, name: str) -> bool:
        normalized = self._normalize_session_user_name(name)
        with self.lock:
            return bool(normalized and normalized in self.session_users)

    @classmethod
    def normalize_session_user_name(cls, name: str) -> str:
        return cls._normalize_session_user_name(name)

    def remove_item(self, item_id: str) -> bool:
        with self.lock:
            if self.current_item and self.current_item.id == item_id:
                self._archive_current_item_unlocked()
                self.current_item = None
                self.current_item_started = False
                self._rebuild_cycle_items_unlocked()
                self._touch(persist_backup=True)
                return True
            for index, item in enumerate(self.playlist):
                if item.id == item_id:
                    self.playlist.pop(index)
                    self._rebuild_cycle_items_unlocked()
                    self._touch(persist_backup=True)
                    return True
        return False

    def clear_playlist(self) -> None:
        with self.lock:
            self.playlist = []
            self.backup_file.unlink(missing_ok=True)
            self._touch(persist_backup=False)

    def clear_history(self) -> None:
        with self.lock:
            self.history = []
            self._touch(persist_backup=False)

    def remove_history_entry(self, key: str) -> bool:
        normalized_key = str(key or "").strip()
        if not normalized_key:
            return False
        with self.lock:
            history_count = len(self.history)
            session_history_count = len(self.session_history)
            session_played_count = len(self.session_played)
            self.history = [
                entry for entry in self.history if entry.key != normalized_key
            ]
            self.session_history = [
                entry for entry in self.session_history if entry.key != normalized_key
            ]
            self.session_played = [
                entry for entry in self.session_played if entry.key != normalized_key
            ]
            changed = (
                len(self.history) != history_count
                or len(self.session_history) != session_history_count
                or len(self.session_played) != session_played_count
            )
            if changed:
                self._touch(persist_backup=True)
            return changed

    def advance_to_next(self, *, reset_av_delay: bool = False) -> bool:
        with self.lock:
            if not self.current_item and not self.playlist:
                return False
            self._archive_current_item_unlocked()
            self.current_item = self.playlist.pop(0) if self.playlist else None
            self.current_item_started = False
            self.key_shift = 0
            if self.current_item and reset_av_delay:
                self._apply_av_delay_action_unlocked(
                    {"type": "reset_local"}, persist=False
                )
            if self.current_item:
                self._record_session_played_unlocked(self.current_item)
            self._rebuild_cycle_items_unlocked()
            self._touch(persist_backup=True)
            return True

    def move_item(self, item_id: str, direction: str) -> bool:
        with self.lock:
            index = self._find_index(item_id)
            if index is None:
                return False
            if direction == "up" and index > 0:
                self.playlist[index].queue_slot_type = "manual"
                self.playlist[index - 1], self.playlist[index] = (
                    self.playlist[index],
                    self.playlist[index - 1],
                )
                self._rebuild_cycle_items_unlocked()
                self._touch(persist_backup=True)
                return True
            if direction == "down" and index < len(self.playlist) - 1:
                self.playlist[index].queue_slot_type = "manual"
                self.playlist[index + 1], self.playlist[index] = (
                    self.playlist[index],
                    self.playlist[index + 1],
                )
                self._rebuild_cycle_items_unlocked()
                self._touch(persist_backup=True)
                return True
        return False

    def move_to_next(self, item_id: str) -> bool:
        with self.lock:
            index = self._find_index(item_id)
            if index is None:
                return False
            item = self.playlist.pop(index)
            item.queue_slot_type = "priority"
            self.playlist.insert(0, item)
            self._rebuild_cycle_items_unlocked()
            self._touch(persist_backup=True)
            return True

    def move_item_to_index(self, item_id: str, target_index: int) -> bool:
        with self.lock:
            index = self._find_index(item_id)
            if index is None:
                return False
            bounded_index = max(0, min(target_index, len(self.playlist) - 1))
            if bounded_index == index:
                return True
            item = self.playlist.pop(index)
            item.queue_slot_type = "manual"
            self.playlist.insert(bounded_index, item)
            self._rebuild_cycle_items_unlocked()
            self._touch(persist_backup=True)
            return True

    def resort_playlist_by_cycle(self) -> bool:
        with self.lock:
            if len(self.playlist) < 2:
                return False
            for item in self.playlist:
                item.queue_slot_type = "cycle"
            self._rebuild_cycle_items_unlocked()
            self._touch(persist_backup=True)
            return True

    def move_to_front(self, item_id: str, *, reset_av_delay: bool = False) -> bool:
        with self.lock:
            index = self._find_index(item_id)
            if index is None:
                return False
            self._archive_current_item_unlocked()
            self.current_item = self.playlist.pop(index)
            self.current_item_started = False
            if reset_av_delay:
                self._apply_av_delay_action_unlocked(
                    {"type": "reset_local"}, persist=False
                )
            self._record_session_played_unlocked(self.current_item)
            self._rebuild_cycle_items_unlocked()
            self._touch(persist_backup=True)
            return True

    def set_mode(self, mode: str) -> None:
        with self.lock:
            self.playback_mode = mode
            self._touch(persist_backup=True)

    def set_av_offset_ms(self, offset_ms: int) -> int:
        playback_selector = self.capture_playback_selector()
        with self.lock:
            result = self._apply_av_delay_action_unlocked(
                {"type": "set_persistent", "effective_delay_ms": int(offset_ms)},
                playback_selector=playback_selector,
            )
            return int(result["effective_delay_ms"])

    @property
    def av_offset_ms(self) -> int:
        return self.av_global_delay_ms + self.av_local_delay_ms

    def apply_av_delay_action(self, action: dict[str, object]) -> dict[str, object]:
        playback_selector = self.capture_playback_selector()
        with self.lock:
            return self._apply_av_delay_action_unlocked(
                action, playback_selector=playback_selector
            )

    def _av_delay_snapshot_unlocked(self) -> dict[str, object]:
        effective_delay = self.av_global_delay_ms + self.av_local_delay_ms
        has_local_adjustment = self.av_local_delay_ms != 0
        return {
            "schema_version": 1,
            "global_delay_ms": self.av_global_delay_ms,
            "local_delay_ms": self.av_local_delay_ms,
            "effective_delay_ms": effective_delay,
            "locked": self.av_delay_locked,
            "has_local_adjustment": has_local_adjustment,
            "lock_button_enabled": self.av_delay_locked or has_local_adjustment,
        }

    def _apply_av_delay_action_unlocked(
        self,
        action: dict[str, object],
        *,
        playback_selector: PlaybackSelector | None = None,
        persist: bool = True,
    ) -> dict[str, object]:
        if playback_selector is None:
            playback_selector = self.capture_playback_selector()
        request = {
            "schema_version": 1,
            "state": {
                "global_delay_ms": self.av_global_delay_ms,
                "local_delay_ms": self.av_local_delay_ms,
                "locked": self.av_delay_locked,
            },
            "action": dict(action),
        }
        result = playback_selector.dispatch(
            "apply_av_delay_action",
            python=lambda: _py_apply_av_delay_action(
                request["state"], request["action"]
            ),
            rust=lambda: rust_backend.try_apply_av_delay_action(
                request, allow_python_reference=False
            ),
        )
        changed = (
            self.av_global_delay_ms != result["global_delay_ms"]
            or self.av_local_delay_ms != result["local_delay_ms"]
            or self.av_delay_locked != result["locked"]
        )
        self.av_global_delay_ms = int(result["global_delay_ms"])
        self.av_local_delay_ms = int(result["local_delay_ms"])
        self.av_delay_locked = bool(result["locked"])
        if changed and persist:
            self._touch(persist_backup=True)
        return result

    def reset_av_delay_for_track_change(self) -> dict[str, object]:
        playback_selector = self.capture_playback_selector()
        with self.lock:
            return self._apply_av_delay_action_unlocked(
                {"type": "reset_local"},
                playback_selector=playback_selector,
            )

    def set_volume_percent(self, volume_percent: int) -> int:
        with self.lock:
            bounded = max(0, min(MAX_VOLUME_PERCENT, int(volume_percent)))
            if self.volume_percent == bounded:
                return bounded
            self.volume_percent = bounded
            self._touch(persist_backup=True)
            return bounded

    def set_muted(self, is_muted: bool) -> bool:
        with self.lock:
            normalized = bool(is_muted)
            if self.is_muted == normalized:
                return normalized
            self.is_muted = normalized
            self._touch(persist_backup=True)
            return normalized

    def set_key_shift(self, key_shift: int) -> int:
        with self.lock:
            bounded = max(MIN_KEY_SHIFT, min(MAX_KEY_SHIFT, int(key_shift)))
            if self.key_shift == bounded:
                return bounded
            self.key_shift = bounded
            self._touch(persist_backup=True)
            return bounded

    def set_song_advance_delay_seconds(self, delay_seconds: int) -> int:
        with self.lock:
            bounded = max(0, min(MAX_SONG_ADVANCE_DELAY_SECONDS, int(delay_seconds)))
            if self.song_advance_delay_seconds == bounded:
                return bounded
            self.song_advance_delay_seconds = bounded
            self._touch(persist_backup=True)
            return bounded

    def set_audio_variant(self, item_id: str, variant_id: str) -> bool:
        with self.lock:
            item = self._find_item_unlocked(item_id)
            if not item:
                return False
            normalized_variant_id = str(variant_id or "").strip()
            if not normalized_variant_id:
                return False
            allowed_variant_ids = {
                str(variant.get("id") or "").strip()
                for variant in item.audio_variants
                if isinstance(variant, dict)
            }
            if not allowed_variant_ids:
                allowed_variant_ids = self._predicted_audio_variant_ids_unlocked(item)
            if normalized_variant_id not in allowed_variant_ids:
                return False
            item.selected_audio_variant_id = normalized_variant_id
            self._touch(persist_backup=True)
            return True

    def update_item(
        self,
        item_id: str,
        *,
        persist_backup: bool = False,
        **changes: object,
    ) -> bool:
        with self.lock:
            item = self._find_item_unlocked(item_id)
            if not item:
                return False
            for key, value in changes.items():
                if key not in PlaylistItem.__dataclass_fields__:
                    continue
                setattr(item, key, value)
            self._touch(persist_backup=persist_backup)
            return True

    def add_session_user(self, name: str) -> bool:
        with self.lock:
            normalized = self._normalize_session_user_name(name)
            if not normalized:
                raise ValueError("用户名不能为空")
            if normalized in self.session_users:
                raise ValueError("该用户已存在")
            if len(self.session_users) >= MAX_SESSION_USERS:
                raise ValueError(f"最多只能添加 {MAX_SESSION_USERS} 个用户")
            self.session_users.append(normalized)
            self._rebuild_cycle_items_unlocked()
            self._touch(persist_backup=True)
            return True

    def remove_session_user(self, name: str) -> bool:
        with self.lock:
            normalized = self._normalize_session_user_name(name)
            if not normalized or normalized not in self.session_users:
                return False
            self.session_users = [entry for entry in self.session_users if entry != normalized]
            self._rebuild_cycle_items_unlocked()
            self._touch(persist_backup=True)
            return True

    def rename_session_user(self, current_name: str, new_name: str) -> str:
        with self.lock:
            current = self._normalize_session_user_name(current_name)
            renamed = self._normalize_session_user_name(new_name)
            if not current or current not in self.session_users:
                raise ValueError("session user does not exist")
            if not renamed:
                raise ValueError("user name cannot be empty")
            if renamed != current and renamed in self.session_users:
                raise ValueError("session user already exists")
            if renamed == current:
                return renamed

            index = self.session_users.index(current)
            self.session_users[index] = renamed
            if self.current_item and self.current_item.requester_name == current:
                self.current_item.requester_name = renamed
            for item in self.playlist:
                if item.requester_name == current:
                    item.requester_name = renamed
            for entry in self.history:
                if entry.requester_name == current:
                    entry.requester_name = renamed
            for entry in self.session_history:
                if entry.requester_name == current:
                    entry.requester_name = renamed
            for entry in self.session_played:
                if entry.requester_name == current:
                    entry.requester_name = renamed

            self._rebuild_cycle_items_unlocked()
            self._touch(persist_backup=True)
            return renamed

    def move_session_user_to_index(self, name: str, target_index: int) -> bool:
        with self.lock:
            normalized = self._normalize_session_user_name(name)
            if not normalized:
                return False
            try:
                index = self.session_users.index(normalized)
            except ValueError:
                return False
            bounded_index = max(0, min(target_index, len(self.session_users) - 1))
            if bounded_index == index:
                return True
            user_name = self.session_users.pop(index)
            self.session_users.insert(bounded_index, user_name)
            self._rebuild_cycle_items_unlocked()
            self._touch(persist_backup=True)
            return True

    def restore_backup(self, *, reset_av_delay: bool = False) -> bool:
        with self.lock:
            payload = self._read_backup_payload_unlocked()
            if not payload:
                return False
            current_item_payload = payload.get("current_item")
            playlist_payload = payload.get("playlist") or []
            if not current_item_payload and not playlist_payload:
                return False
            self.current_item = (
                PlaylistItem.from_dict(self._sanitize_backup_payload(current_item_payload))
                if current_item_payload
                else None
            )
            self.playlist = [
                PlaylistItem.from_dict(self._sanitize_backup_payload(item))
                for item in playlist_payload
            ]
            self.current_item_started = False
            if self.current_item and reset_av_delay:
                self._apply_av_delay_action_unlocked(
                    {"type": "reset_local"}, persist=False
                )
            self._restore_session_played_from_backup_unlocked(payload)
            self._clear_previous_session_unlocked()
            self._rebuild_cycle_items_unlocked()
            self._touch(persist_backup=False)
            return True

    def discard_backup(self) -> bool:
        with self.lock:
            existed = self.backup_file.exists() or self.current_item is not None or bool(self.playlist)
            self.current_item = None
            self.playlist = []
            if existed:
                self._start_new_session_played_unlocked()
            self._clear_previous_session_unlocked()
            self.backup_file.unlink(missing_ok=True)
            self._touch(persist_backup=False)
            return existed

    def reset_runtime_data(self) -> None:
        with self.lock:
            self.playback_mode = "local"
            self.av_global_delay_ms = 0
            self.av_local_delay_ms = 0
            self.av_delay_locked = False
            self.volume_percent = 100
            self.is_muted = False
            self.song_advance_delay_seconds = DEFAULT_SONG_ADVANCE_DELAY_SECONDS
            self.key_shift = 0
            self.current_item = None
            self.current_item_started = False
            self.playlist = []
            self.history = []
            self.session_history = []
            self.session_users = []
            self._clear_previous_session_unlocked()
            self.updated_at = time.time()
            self._delete_runtime_json_files_unlocked()
        self._notify_change()

    def reset_player_state(self) -> None:
        with self.lock:
            self.playback_mode = "local"
            self.av_global_delay_ms = 0
            self.av_local_delay_ms = 0
            self.av_delay_locked = False
            self.volume_percent = 100
            self.is_muted = False
            self.song_advance_delay_seconds = DEFAULT_SONG_ADVANCE_DELAY_SECONDS
            self.key_shift = 0
            self.current_item_started = False
            self._touch(persist_backup=False)

    def backup_summary(self) -> dict[str, Any]:
        with self.lock:
            return self._backup_summary_unlocked()

    def continue_previous_session(self) -> bool:
        with self.lock:
            if self.current_item or self.playlist or self.session_played:
                return False
            candidate = self._previous_session_file
            if candidate is None:
                return False
            payload = self._read_json_payload_unlocked(candidate)
            entries = self._session_played_entries_from_payload(payload)
            if not payload or not entries:
                self._clear_previous_session_unlocked()
                return False
            self.session_played_file = candidate
            self.session_started_at = self._session_started_at_from_payload(payload, {})
            self.session_played = entries
            self._clear_previous_session_unlocked()
            self._touch(persist_backup=False)
            return True

    def session_request_for_item(self, item: PlaylistItem) -> HistoryEntry | None:
        with self.lock:
            decision = self._decide_playlist_duplicate_unlocked(
                item,
                history_entries=self.session_history,
            )
            if decision.history_duplicate_index is None:
                return None
            entry = self.session_history[decision.history_duplicate_index]
            return HistoryEntry.from_dict(entry.serialize())

    def active_duplicate_for_item(self, item: PlaylistItem) -> PlaylistItem | None:
        with self.lock:
            decision = self._decide_playlist_duplicate_unlocked(
                item,
                current_item=self.current_item,
                queued_items=self.playlist,
            )
            if decision.active_duplicate_id is None:
                return None
            existing = self._find_item_unlocked(decision.active_duplicate_id)
            return PlaylistItem.from_dict(existing.serialize()) if existing else None

    def session_played_snapshot(self) -> list[dict[str, Any]]:
        with self.lock:
            return [
                self._session_played_export_payload_unlocked(entry)
                for entry in self.session_played
            ]

    def missing_owner_urls(self) -> list[str]:
        with self.lock:
            urls: list[str] = []
            seen: set[str] = set()

            def collect(url: str, owner_name: str) -> None:
                candidate = str(url or "").strip()
                if not candidate or str(owner_name or "").strip() or candidate in seen:
                    return
                seen.add(candidate)
                urls.append(candidate)

            if self.current_item:
                collect(
                    self.current_item.resolved_url or self.current_item.original_url,
                    self.current_item.owner_name,
                )
            for item in self.playlist:
                collect(item.resolved_url or item.original_url, item.owner_name)
            for entry in self.history:
                collect(entry.resolved_url or entry.original_url, entry.owner_name)
            return urls

    def update_owner_info_for_url(
        self,
        source_url: str,
        *,
        owner_mid: int,
        owner_name: str,
        owner_url: str,
    ) -> bool:
        with self.lock:
            changed = False
            source = str(source_url or "").strip()
            if not source:
                return False

            def matches(entry_url: str, fallback_url: str) -> bool:
                return source in {str(entry_url or "").strip(), str(fallback_url or "").strip()}

            def update_target(target: Any) -> None:
                nonlocal changed
                if not matches(getattr(target, "resolved_url", ""), getattr(target, "original_url", "")):
                    return
                if (
                    int(getattr(target, "owner_mid", 0) or 0) == owner_mid
                    and str(getattr(target, "owner_name", "") or "") == owner_name
                    and str(getattr(target, "owner_url", "") or "") == owner_url
                ):
                    return
                target.owner_mid = owner_mid
                target.owner_name = owner_name
                target.owner_url = owner_url
                changed = True

            if self.current_item:
                update_target(self.current_item)
            for item in self.playlist:
                update_target(item)
            for entry in self.history:
                update_target(entry)
            for entry in self.session_history:
                update_target(entry)
            for entry in self.session_played:
                update_target(entry)

            if changed:
                self._touch(persist_backup=True)
            return changed

    def mark_item_playback_started(self, item_id: str) -> bool:
        with self.lock:
            if not self.current_item or self.current_item.id != str(item_id or "").strip():
                return False
            self.current_item_started = True
            return True

    def mark_session_played_threshold_reached(self, item_id: str) -> bool:
        with self.lock:
            changed = False
            for entry in self.session_played:
                if entry.item_id == item_id:
                    if not entry.threshold_reached:
                        entry.threshold_reached = True
                        changed = True
            if changed:
                self._touch(persist_backup=True)
            return changed

    def _find_index(self, item_id: str) -> int | None:
        for index, item in enumerate(self.playlist):
            if item.id == item_id:
                return index
        return None

    def _find_item_unlocked(self, item_id: str) -> PlaylistItem | None:
        if self.current_item and self.current_item.id == item_id:
            return self.current_item
        for item in self.playlist:
            if item.id == item_id:
                return item
        return None

    @staticmethod
    def _variant_id(page: int, label: str, index: int) -> str:
        normalized = re.sub(r"[^a-z0-9]+", "_", label.lower()).strip("_")
        suffix = normalized or f"track_{index + 1}"
        return f"p{max(int(page), 1)}_{suffix}"

    def _predicted_audio_variant_ids_unlocked(self, item: PlaylistItem) -> set[str]:
        predicted_ids: set[str] = set()
        for index, label in enumerate(item.selected_parts or []):
            normalized_label = str(label or "").strip()
            if not normalized_label:
                continue
            page = item.selected_pages[index] if index < len(item.selected_pages or []) else index + 1
            predicted_ids.add(self._variant_id(page, normalized_label, index))
        return predicted_ids

    def _playlist_order_request_unlocked(
        self,
        operation: str,
        candidate: PlaylistItem | None = None,
    ) -> PlaylistOrderRequest:
        items = tuple(
            PlaylistOrderItem(
                original_index=index,
                item_id=item.id,
                requester_name=self._normalize_session_user_name(item.requester_name),
                slot_type=item.queue_slot_type,
            )
            for index, item in enumerate(self.playlist)
        )
        candidate_descriptor = None
        if candidate is not None:
            candidate_descriptor = PlaylistOrderItem(
                original_index=len(items),
                item_id=candidate.id,
                requester_name=self._normalize_session_user_name(candidate.requester_name),
                slot_type=candidate.queue_slot_type,
            )
        return PlaylistOrderRequest(
            operation=operation,
            session_users=tuple(self.session_users),
            current_requester=(
                self._normalize_session_user_name(self.current_item.requester_name)
                if self.current_item
                else None
            ),
            items=items,
            candidate=candidate_descriptor,
        )

    @staticmethod
    def _playlist_order_wire_request(request: PlaylistOrderRequest) -> dict[str, object]:
        def item_payload(item: PlaylistOrderItem) -> dict[str, object]:
            return {
                "original_index": item.original_index,
                "item_id": item.item_id,
                "requester_name": item.requester_name,
                "slot_type": item.slot_type,
            }

        return {
            "schema_version": 1,
            "operation": request.operation,
            "session_users": list(request.session_users),
            "current_requester": request.current_requester,
            "items": [item_payload(item) for item in request.items],
            "candidate": item_payload(request.candidate) if request.candidate else None,
        }

    def _plan_playlist_order_unlocked(
        self,
        operation: str,
        candidate: PlaylistItem | None = None,
    ) -> PlaylistOrderPlan:
        request = self._playlist_order_request_unlocked(operation, candidate)
        completed, response = rust_backend.try_plan_playlist_order(
            self._playlist_order_wire_request(request)
        )
        if not completed or response is None:
            return rust_backend.python_fallback(
                "plan_playlist_order", lambda: _py_plan_playlist_order(request)
            )
        return PlaylistOrderPlan(tuple(response["ordered_ids"]))

    def _apply_playlist_order_unlocked(
        self,
        plan: PlaylistOrderPlan,
        candidate: PlaylistItem | None = None,
    ) -> None:
        objects_by_id = {item.id: item for item in self.playlist}
        if candidate is not None:
            if candidate.id in objects_by_id:
                raise ValueError("playlist candidate ID already exists")
            objects_by_id[candidate.id] = candidate
        if len(plan.ordered_ids) != len(objects_by_id) or set(plan.ordered_ids) != set(objects_by_id):
            raise ValueError("playlist order plan violates object conservation")
        self.playlist = [objects_by_id[item_id] for item_id in plan.ordered_ids]

    def _insert_cycle_item_unlocked(self, item: PlaylistItem) -> None:
        plan = self._plan_playlist_order_unlocked("insert_cycle", item)
        self._apply_playlist_order_unlocked(plan, item)

    def _rebuild_cycle_items_unlocked(self) -> None:
        plan = self._plan_playlist_order_unlocked("rebuild")
        self._apply_playlist_order_unlocked(plan)

    def _requester_cycle_state_unlocked(
        self,
    ) -> tuple[dict[str, tuple[int, int]], defaultdict[str, int], dict[str, int]]:
        request = self._playlist_order_request_unlocked("rebuild")
        cycle_keys, counts, order_index = _py_playlist_cycle_state(request)
        requester_counts: defaultdict[str, int] = defaultdict(
            int,
            {requester: count for requester, count in counts.items() if count > 0},
        )
        return cycle_keys, requester_counts, order_index

    def _rotated_cycle_users_unlocked(self) -> list[str]:
        request = self._playlist_order_request_unlocked("rebuild")
        return list(_py_rotated_playlist_users(request))

    def _save_session(self) -> None:
        self._write_json_payload_unlocked(
            self.player_state_file,
            {
                "playback_mode": self.playback_mode,
                "player_settings": {
                    "global_av_delay_ms": self.av_global_delay_ms,
                    "av_delay_locked": self.av_delay_locked,
                    "volume_percent": self.volume_percent,
                    "is_muted": self.is_muted,
                    "song_advance_delay_seconds": self.song_advance_delay_seconds,
                    "key_shift": self.key_shift,
                },
                "updated_at": self.updated_at,
            },
        )
        self._write_json_payload_unlocked(
            self.history_state_file,
            {
                "history": [entry.serialize() for entry in self.history],
                "updated_at": self.updated_at,
            },
        )
        self._write_json_payload_unlocked(
            self.session_users_state_file,
            {
                "session_users": list(self.session_users),
                "updated_at": self.updated_at,
            },
        )
        # Legacy monolithic state.json is no longer used. Remove it if present
        # so a fresh run cannot accidentally revive old queue/cache churn.
        self.state_file.unlink(missing_ok=True)

    def _save_session_played(self) -> None:
        if not self.session_played:
            self.session_played_file.unlink(missing_ok=True)
            return
        self.session_archive_dir.mkdir(parents=True, exist_ok=True)
        payload = {
            "session_started_at": self.session_started_at,
            "updated_at": self.updated_at,
            "items": [entry.serialize() for entry in self.session_played],
        }
        self.session_played_file.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    def _save_backup(self) -> None:
        if not self.current_item and not self.playlist:
            self.backup_file.unlink(missing_ok=True)
            return
        payload = {
            "current_item": (
                self._backup_item_payload(self.current_item) if self.current_item else None
            ),
            "playlist": [self._backup_item_payload(item) for item in self.playlist],
            "played_session": {
                "file": self.session_played_file.name,
                "session_started_at": self.session_started_at,
            },
            "updated_at": self.updated_at,
        }
        self._write_json_payload_unlocked(self.backup_file, payload)

    def _restore_session_played_from_backup_unlocked(self, payload: dict[str, Any]) -> bool:
        session_payload = payload.get("played_session")
        if not isinstance(session_payload, dict):
            self._start_new_session_played_unlocked()
            return False

        filename = Path(str(session_payload.get("file") or "").strip()).name
        if not filename:
            self._start_new_session_played_unlocked()
            return False

        candidate = self.session_archive_dir / filename
        played_payload = self._read_json_payload_unlocked(candidate)
        if not played_payload:
            self._start_new_session_played_unlocked()
            return False

        entries = self._session_played_entries_from_payload(played_payload)

        self.session_played_file = candidate
        self.session_started_at = self._session_started_at_from_payload(
            played_payload,
            session_payload,
        )
        self.session_played = entries
        return True

    @staticmethod
    def _session_played_entries_from_payload(
        payload: dict[str, Any] | None,
    ) -> list[SessionPlayedEntry]:
        entries: list[SessionPlayedEntry] = []
        if not payload:
            return entries
        for entry_payload in payload.get("items") or []:
            if not isinstance(entry_payload, dict):
                continue
            try:
                entries.append(SessionPlayedEntry.from_dict(dict(entry_payload)))
            except TypeError:
                continue
        return entries

    def _start_new_session_played_unlocked(self) -> None:
        self.session_started_at = time.time()
        self.session_played_file = self._session_played_file_for_timestamp(
            self.session_started_at
        )
        self.session_played = []

    def _session_played_file_for_timestamp(self, timestamp: float) -> Path:
        return (
            self.session_archive_dir
            / f"played-{self._session_file_label(timestamp)}.json"
        )

    def _latest_previous_session_file_unlocked(self) -> tuple[Path | None, int]:
        if not self.session_archive_dir.exists():
            return None, 0
        try:
            candidates = sorted(
                self.session_archive_dir.glob("played-*.json"),
                key=lambda path: path.name,
                reverse=True,
            )
        except OSError:
            return None, 0
        for candidate in candidates:
            if candidate == self.session_played_file:
                continue
            payload = self._read_json_payload_unlocked(candidate)
            entries = self._session_played_entries_from_payload(payload)
            if entries:
                return candidate, len(entries)
        return None, 0

    def _clear_previous_session_unlocked(self) -> None:
        self._previous_session_file = None
        self._previous_session_count = 0

    @staticmethod
    def _session_started_at_from_payload(
        played_payload: dict[str, Any],
        backup_payload: dict[str, Any],
    ) -> float:
        for payload in (played_payload, backup_payload):
            try:
                timestamp = float(payload.get("session_started_at") or 0.0)
            except (TypeError, ValueError):
                timestamp = 0.0
            if timestamp > 0:
                return timestamp
        return time.time()

    def _touch(self, *, persist_backup: bool) -> None:
        self.updated_at = time.time()
        self._save_session()
        self._save_session_played()
        if persist_backup:
            self._save_backup()
        self._notify_change()

    def _notify_change(self) -> None:
        callback = self.on_change
        if not callback:
            return
        try:
            callback()
        except Exception:
            return

    def _backup_item_payload(self, item: PlaylistItem) -> dict[str, Any]:
        payload = item.serialize()
        # Cache files are runtime-only. Clear split-cache fields before
        # persisting playlist backups.
        payload.update(
            cache_status="pending",
            cache_progress=0.0,
            cache_message="待缓存",
            video_relative_path="",
            video_media_url="",
            audio_variants=[],
            selected_audio_variant_id="",
        )
        return payload

    def _sanitize_backup_payload(self, payload: dict[str, Any]) -> dict[str, Any]:
        sanitized = dict(payload)
        # Keep restored backups portable across machines and app versions.
        sanitized.update(
            cache_status="pending",
            cache_progress=0.0,
            cache_message="待缓存",
            video_relative_path="",
            video_media_url="",
            audio_variants=[],
            selected_audio_variant_id="",
        )
        return sanitized

    def _read_backup_payload_unlocked(self) -> dict[str, Any] | None:
        return self._read_json_payload_unlocked(self.backup_file)

    def _read_json_payload_unlocked(self, path: Path) -> dict[str, Any] | None:
        if not path.exists():
            return None
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return None
        if not isinstance(payload, dict):
            return None
        return payload

    def _write_json_payload_unlocked(self, path: Path, payload: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    def _save_player_state_unlocked(self) -> None:
        self._write_json_payload_unlocked(
            self.player_state_file,
            {
                "playback_mode": self.playback_mode,
                "playback_selector_mode": self.playback_selector_mode,
                "player_settings": {
                    "global_av_delay_ms": self.av_global_delay_ms,
                    "av_delay_locked": self.av_delay_locked,
                    "volume_percent": self.volume_percent,
                    "is_muted": self.is_muted,
                    "song_advance_delay_seconds": self.song_advance_delay_seconds,
                    "key_shift": self.key_shift,
                },
                "updated_at": self.updated_at,
            },
        )

    def _save_session(self) -> None:
        self._save_player_state_unlocked()
        self._write_json_payload_unlocked(
            self.history_state_file,
            {
                "history": [entry.serialize() for entry in self.history],
                "updated_at": self.updated_at,
            },
        )
        self._write_json_payload_unlocked(
            self.session_users_state_file,
            {
                "session_users": list(self.session_users),
                "updated_at": self.updated_at,
            },
        )
        # Legacy monolithic state.json is no longer used. Remove it if present
        # so a fresh run cannot accidentally revive old queue/cache churn.
        self.state_file.unlink(missing_ok=True)

    def _restore_persistent_state(self) -> None:
        with self.lock:
            history_payload = (
                self._read_json_payload_unlocked(self.history_state_file) or {}
            ).get("history") or []
            self.history = [
                HistoryEntry.from_dict(dict(entry))
                for entry in history_payload
                if isinstance(entry, dict)
            ]

            player_payload = self._read_json_payload_unlocked(self.player_state_file)
            selector_is_set = (
                player_payload is not None
                and "playback_selector_mode" in player_payload
            )
            persisted_selector_mode = (
                player_payload.get("playback_selector_mode")
                if selector_is_set and player_payload is not None
                else None
            )
            (
                self.playback_selector_mode,
                self.playback_selector_warning,
            ) = normalize_persisted_playback_selector_mode(
                persisted_selector_mode,
                is_set=selector_is_set,
            )
            if self.playback_selector_warning:
                print(
                    f"[bilikara] {self.playback_selector_warning}",
                    file=sys.stderr,
                    flush=True,
                )
            if player_payload:
                self.playback_mode = self._load_playback_mode(player_payload)
                (
                    self.av_global_delay_ms,
                    self.av_delay_locked,
                ) = self._load_av_delay_persistent_state(player_payload)
                self.av_local_delay_ms = 0
                self.volume_percent = self._load_volume_percent(player_payload)
                self.is_muted = self._load_is_muted(player_payload)
                self.song_advance_delay_seconds = self._load_song_advance_delay_seconds(player_payload)
                self.key_shift = self._load_key_shift(player_payload)
                if self.playback_selector_warning:
                    self._save_player_state_unlocked()

            users_payload = self._read_json_payload_unlocked(self.session_users_state_file)
            if users_payload:
                self.session_users = self._load_session_users_from_payload(users_payload)

    # LEGACY REFERENCE: old monolithic state.json reader.
    # We intentionally do not call this anymore; v0.4+ expects users to start
    # from an empty data directory and persists split files instead.
    #
    # def _read_state_payload_unlocked(self) -> dict[str, Any] | None:
    #     return self._read_json_payload_unlocked(self.state_file)

    def _delete_runtime_json_files_unlocked(self) -> None:
        data_dir = self.state_file.parent
        keep_names = {"gatcha_cache.json", "gatcha_uids.json", "gatcha_favlist.json"}
        for path in data_dir.glob("*.json"):
            if path.name in keep_names:
                continue
            path.unlink(missing_ok=True)

    @staticmethod
    def _split_state_path(state_file: Path, default_name: str, suffix: str) -> Path:
        if state_file.name == "state.json":
            return state_file.with_name(default_name)
        return state_file.with_name(f"{state_file.stem}-{suffix}.json")

    @staticmethod
    def _load_playback_mode(_payload: dict[str, Any]) -> str:
        # Online embed playback is deprecated in the frontend. Keep the
        # server-side mode field for compatibility, but never restore it.
        return "local"

    @staticmethod
    def _load_av_offset_ms(payload: dict[str, Any]) -> int:
        player_settings = payload.get("player_settings")
        if not isinstance(player_settings, dict):
            return 0
        raw_value = player_settings.get("av_offset_ms", 0)
        try:
            value = int(raw_value)
        except (TypeError, ValueError):
            return 0
        return max(-MAX_AV_OFFSET_MS, min(MAX_AV_OFFSET_MS, value))

    @classmethod
    def _load_av_delay_persistent_state(
        cls, payload: dict[str, Any]
    ) -> tuple[int, bool]:
        player_settings = payload.get("player_settings")
        if not isinstance(player_settings, dict):
            return 0, False
        if "global_av_delay_ms" not in player_settings:
            legacy_delay = cls._load_av_offset_ms(payload)
            return legacy_delay, legacy_delay != 0
        raw_global = player_settings.get("global_av_delay_ms", 0)
        try:
            global_delay = int(raw_global)
        except (TypeError, ValueError):
            global_delay = 0
        global_delay = max(-MAX_AV_OFFSET_MS, min(MAX_AV_OFFSET_MS, global_delay))
        locked = player_settings.get("av_delay_locked", False)
        return global_delay, locked if isinstance(locked, bool) else False

    @staticmethod
    def _load_volume_percent(payload: dict[str, Any]) -> int:
        player_settings = payload.get("player_settings")
        if not isinstance(player_settings, dict):
            return 100
        raw_value = player_settings.get("volume_percent", 100)
        try:
            value = int(raw_value)
        except (TypeError, ValueError):
            return 100
        return max(0, min(MAX_VOLUME_PERCENT, value))

    @staticmethod
    def _load_is_muted(payload: dict[str, Any]) -> bool:
        player_settings = payload.get("player_settings")
        if not isinstance(player_settings, dict):
            return False
        return bool(player_settings.get("is_muted", False))

    @staticmethod
    def _load_song_advance_delay_seconds(payload: dict[str, Any]) -> int:
        player_settings = payload.get("player_settings")
        if not isinstance(player_settings, dict):
            return DEFAULT_SONG_ADVANCE_DELAY_SECONDS
        raw_value = player_settings.get(
            "song_advance_delay_seconds",
            DEFAULT_SONG_ADVANCE_DELAY_SECONDS,
        )
        try:
            value = int(raw_value)
        except (TypeError, ValueError):
            return DEFAULT_SONG_ADVANCE_DELAY_SECONDS
        return max(0, min(MAX_SONG_ADVANCE_DELAY_SECONDS, value))

    @staticmethod
    def _load_key_shift(payload: dict[str, Any]) -> int:
        player_settings = payload.get("player_settings")
        if not isinstance(player_settings, dict):
            return 0
        raw_value = player_settings.get("key_shift", 0)
        try:
            value = int(raw_value)
        except (TypeError, ValueError):
            return 0
        return max(MIN_KEY_SHIFT, min(MAX_KEY_SHIFT, value))

    @staticmethod
    def _playlist_identity_from_item(item: PlaylistItem) -> PlaylistIdentity:
        return PlaylistIdentity(
            bvid=str(item.bvid or ""),
            aid=int(item.aid),
            video_page=int(item.page),
            selected_audio_pages=tuple(int(page) for page in (item.selected_pages or [])),
        )

    @staticmethod
    def _playlist_duplicate_wire_request(
        request: PlaylistDuplicateRequest,
    ) -> dict[str, object]:
        def identity_payload(identity: PlaylistIdentity) -> dict[str, object]:
            return {
                "bvid": identity.bvid,
                "aid": identity.aid,
                "video_page": identity.video_page,
                "selected_audio_pages": list(identity.selected_audio_pages),
            }

        def active_payload(item: DuplicateActiveItem) -> dict[str, object]:
            return {
                "original_index": item.original_index,
                "item_id": item.item_id,
                "identity": identity_payload(item.identity),
            }

        return {
            "schema_version": 1,
            "candidate": identity_payload(request.candidate),
            "current_item": active_payload(request.current_item) if request.current_item else None,
            "queued_items": [active_payload(item) for item in request.queued_items],
            "history_entries": [
                {"original_index": entry.original_index, "key": entry.key}
                for entry in request.history_entries
            ],
        }

    @classmethod
    def _decide_playlist_duplicate_unlocked(
        cls,
        item: PlaylistItem,
        *,
        current_item: PlaylistItem | None = None,
        queued_items: list[PlaylistItem] | None = None,
        history_entries: list[HistoryEntry] | None = None,
    ) -> PlaylistDuplicateDecision:
        request = PlaylistDuplicateRequest(
            candidate=cls._playlist_identity_from_item(item),
            current_item=(
                DuplicateActiveItem(
                    original_index=0,
                    item_id=current_item.id,
                    identity=cls._playlist_identity_from_item(current_item),
                )
                if current_item
                else None
            ),
            queued_items=tuple(
                DuplicateActiveItem(
                    original_index=index,
                    item_id=queued.id,
                    identity=cls._playlist_identity_from_item(queued),
                )
                for index, queued in enumerate(queued_items or [], start=1)
            ),
            history_entries=tuple(
                DuplicateHistoryEntry(original_index=index, key=entry.key)
                for index, entry in enumerate(history_entries or [])
            ),
        )
        completed, response = rust_backend.try_decide_playlist_duplicate(
            cls._playlist_duplicate_wire_request(request)
        )
        if not completed or response is None:
            return rust_backend.python_fallback(
                "decide_playlist_duplicate",
                lambda: _py_decide_playlist_duplicate(request),
            )
        return PlaylistDuplicateDecision(
            identity_key=response["identity_key"],
            active_duplicate_id=response["active_duplicate_id"],
            history_duplicate_index=response["history_duplicate_index"],
        )

    @classmethod
    def _history_key(cls, item: PlaylistItem) -> str:
        return cls._decide_playlist_duplicate_unlocked(item).identity_key

    def _record_history_unlocked(self, item: PlaylistItem) -> None:
        now = time.time()
        decision = self._decide_playlist_duplicate_unlocked(
            item,
            history_entries=self.history,
        )
        key = decision.identity_key
        entry = HistoryEntry(
            key=key,
            display_title=item.display_title,
            original_url=item.original_url,
            resolved_url=item.resolved_url,
            title=item.title,
            part_title=item.part_title,
            owner_mid=item.owner_mid,
            owner_name=item.owner_name,
            owner_url=item.owner_url,
            requester_name=item.requester_name,
            requested_at=now,
            request_count=1,
        )
        index = decision.history_duplicate_index
        if index is not None:
            existing = self.history[index]
            entry.request_count = existing.request_count + 1
            self.history.pop(index)
        self.history.insert(0, entry)

    def _archive_current_item_unlocked(self) -> None:
        if not self.current_item:
            return
        self._mark_session_played_ended_unlocked(self.current_item.id)
        if not self.current_item_started:
            return
        self._record_session_request_unlocked(self.current_item)
        self._record_history_unlocked(self.current_item)

    def _mark_session_played_ended_unlocked(self, item_id: str) -> bool:
        for entry in reversed(self.session_played):
            if entry.item_id == item_id and entry.ended_at is None:
                entry.ended_at = time.time()
                return True
        return False

    def _record_session_request_unlocked(self, item: PlaylistItem) -> None:
        now = time.time()
        decision = self._decide_playlist_duplicate_unlocked(
            item,
            history_entries=self.session_history,
        )
        key = decision.identity_key
        entry = HistoryEntry(
            key=key,
            display_title=item.display_title,
            original_url=item.original_url,
            resolved_url=item.resolved_url,
            title=item.title,
            part_title=item.part_title,
            owner_mid=item.owner_mid,
            owner_name=item.owner_name,
            owner_url=item.owner_url,
            requester_name=item.requester_name,
            requested_at=now,
            request_count=1,
        )
        index = decision.history_duplicate_index
        if index is not None:
            existing = self.session_history[index]
            entry.request_count = existing.request_count + 1
            self.session_history.pop(index)
        self.session_history.insert(0, entry)

    def _record_session_played_unlocked(self, item: PlaylistItem) -> None:
        self.session_played.append(
            SessionPlayedEntry(
                key=self._history_key(item),
                item_id=item.id,
                display_title=item.display_title,
                title=item.title,
                part_title=item.part_title,
                original_url=item.original_url,
                resolved_url=item.resolved_url,
                bvid=item.bvid,
                aid=item.aid,
                cid=item.cid,
                page=item.page,
                played_at=time.time(),
                owner_mid=item.owner_mid,
                owner_name=item.owner_name,
                owner_url=item.owner_url,
                requester_name=item.requester_name,
                cover_url=item.cover_url,
            )
        )

    @staticmethod
    def _session_played_export_payload_unlocked(entry: SessionPlayedEntry) -> dict[str, Any]:
        payload = entry.to_dict()
        payload["requested_at"] = entry.played_at
        payload["request_count"] = 1
        return payload

    @staticmethod
    def _session_file_label(timestamp: float) -> str:
        return datetime.fromtimestamp(timestamp).astimezone().strftime("%Y-%m-%d_%H-%M-%S-%f")

    def _backup_summary_unlocked(self) -> dict[str, Any]:
        payload = self._read_backup_payload_unlocked()
        if not payload:
            return {"available": False}
        current_item_payload = payload.get("current_item")
        playlist_payload = payload.get("playlist") or []
        total_count = len(playlist_payload) + (1 if current_item_payload else 0)
        if total_count == 0:
            return {"available": False}
        preview_titles: list[str] = []
        if current_item_payload and str(current_item_payload.get("display_title") or ""):
            preview_titles.append(str(current_item_payload.get("display_title") or ""))
        preview_titles.extend(
            str(item.get("display_title") or "")
            for item in playlist_payload[:3]
            if str(item.get("display_title") or "")
        )
        return {
            "available": True,
            "playlist_count": total_count,
            "updated_at": float(payload.get("updated_at", 0.0) or 0.0),
            "preview_titles": preview_titles[:3],
            "playback_mode": self.playback_mode,
        }

    def _previous_session_summary_unlocked(self) -> dict[str, Any]:
        if self._previous_session_file is None:
            return {"available": False}
        return {
            "available": True,
            "item_count": self._previous_session_count,
        }

    def _validate_requester_name_unlocked(self, requester_name: str) -> str:
        # print(f"[DEBUG] raw={repr(requester_name)}, normalized={repr(self._normalize_session_user_name(requester_name))}")
        if not self.session_users:
            raise ValueError("请先在服务端添加本场 KTV 用户")
        normalized = self._normalize_session_user_name(requester_name)
        if not normalized:
            return self.session_users[0]
        if normalized not in self.session_users:
            raise ValueError("所选用户名不存在，请重新选择")
        return normalized

    @staticmethod
    def _normalize_session_user_name(name: str) -> str:
        normalized = " ".join(str(name or "").strip().split())
        return normalized[:MAX_SESSION_USER_NAME_LENGTH]

    def _load_session_users_from_payload(self, payload: dict[str, Any]) -> list[str]:
        loaded_users: list[str] = []
        for raw_name in payload.get("session_users") or []:
            normalized = self._normalize_session_user_name(str(raw_name or ""))
            if not normalized or normalized in loaded_users:
                continue
            if len(loaded_users) >= MAX_SESSION_USERS:
                break
            loaded_users.append(normalized)
        return loaded_users
