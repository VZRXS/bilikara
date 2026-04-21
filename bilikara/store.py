from __future__ import annotations

import json
import re
import threading
import time
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from .models import HistoryEntry, PlaylistItem, SessionPlayedEntry

MAX_SESSION_USERS = 32
MAX_SESSION_USER_NAME_LENGTH = 24
MAX_AV_OFFSET_MS = 5000
MAX_VOLUME_PERCENT = 100


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
        self.av_offset_ms = 0
        self.volume_percent = 100
        self.is_muted = False
        self.current_item: PlaylistItem | None = None
        self.current_item_started = False
        self.playlist: list[PlaylistItem] = []
        self.history: list[HistoryEntry] = []
        self.session_history: list[HistoryEntry] = []
        self.session_users: list[str] = []
        self.session_started_at = time.time()
        self.session_played_file = (
            self.session_archive_dir
            / f"played-{self._session_file_label(self.session_started_at)}.json"
        )
        self.session_played: list[SessionPlayedEntry] = []
        self.updated_at = time.time()
        self._restore_persistent_state()
        self._save_session()

    def snapshot(self) -> dict:
        with self.lock:
            return {
                "playback_mode": self.playback_mode,
                "player_settings": {
                    "av_offset_ms": self.av_offset_ms,
                    "volume_percent": self.volume_percent,
                    "is_muted": self.is_muted,
                },
                "playlist": [item.to_dict() for item in self.playlist],
                "current_item": self.current_item.to_dict() if self.current_item else None,
                "history": [entry.to_dict() for entry in self.history],
                "session_history": [entry.to_dict() for entry in self.session_history],
                "session_users": list(self.session_users),
                "updated_at": self.updated_at,
                "backup": self._backup_summary_unlocked(),
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

    def add_item(
        self,
        item: PlaylistItem,
        position: str = "tail",
        *,
        requester_name: str = "",
    ) -> None:
        with self.lock:
            normalized_requester = self._validate_requester_name_unlocked(requester_name)
            item.requester_name = normalized_requester
            item.queue_slot_type = "priority" if position == "next" else "cycle"
            if self.current_item is None:
                self.current_item = item
                self.current_item_started = False
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

    def remove_item(self, item_id: str) -> bool:
        with self.lock:
            if self.current_item and self.current_item.id == item_id:
                self._archive_current_item_unlocked()
                self.current_item = None
                self.current_item_started = False
                self._touch(persist_backup=True)
                return True
            for index, item in enumerate(self.playlist):
                if item.id == item_id:
                    self.playlist.pop(index)
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

    def advance_to_next(self) -> bool:
        with self.lock:
            if not self.current_item and not self.playlist:
                return False
            self._archive_current_item_unlocked()
            self.current_item = self.playlist.pop(0) if self.playlist else None
            self.current_item_started = False
            if self.current_item:
                self._record_session_played_unlocked(self.current_item)
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
                self._touch(persist_backup=True)
                return True
            if direction == "down" and index < len(self.playlist) - 1:
                self.playlist[index].queue_slot_type = "manual"
                self.playlist[index + 1], self.playlist[index] = (
                    self.playlist[index],
                    self.playlist[index + 1],
                )
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
            self._touch(persist_backup=True)
            return True

    def move_to_front(self, item_id: str) -> bool:
        with self.lock:
            index = self._find_index(item_id)
            if index is None:
                return False
            self._archive_current_item_unlocked()
            self.current_item = self.playlist.pop(index)
            self.current_item_started = False
            self._record_session_played_unlocked(self.current_item)
            self._touch(persist_backup=True)
            return True

    def set_mode(self, mode: str) -> None:
        with self.lock:
            self.playback_mode = mode
            self._touch(persist_backup=True)

    def set_av_offset_ms(self, offset_ms: int) -> int:
        with self.lock:
            bounded = max(-MAX_AV_OFFSET_MS, min(MAX_AV_OFFSET_MS, int(offset_ms)))
            if self.av_offset_ms == bounded:
                return bounded
            self.av_offset_ms = bounded
            self._touch(persist_backup=True)
            return bounded

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

    def restore_backup(self) -> bool:
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
            self._rebuild_cycle_items_unlocked()
            self._touch(persist_backup=False)
            return True

    def discard_backup(self) -> bool:
        with self.lock:
            existed = self.backup_file.exists() or self.current_item is not None or bool(self.playlist)
            self.current_item = None
            self.playlist = []
            self.backup_file.unlink(missing_ok=True)
            self._touch(persist_backup=False)
            return existed

    def reset_runtime_data(self) -> None:
        with self.lock:
            self.playback_mode = "local"
            self.av_offset_ms = 0
            self.volume_percent = 100
            self.is_muted = False
            self.current_item = None
            self.current_item_started = False
            self.playlist = []
            self.history = []
            self.session_history = []
            self.session_users = []
            self.updated_at = time.time()
            self._delete_runtime_json_files_unlocked()
        self._notify_change()

    def backup_summary(self) -> dict[str, Any]:
        with self.lock:
            return self._backup_summary_unlocked()

    def session_request_for_item(self, item: PlaylistItem) -> HistoryEntry | None:
        with self.lock:
            key = self._history_key(item)
            for entry in self.session_history:
                if entry.key == key:
                    return HistoryEntry.from_dict(entry.serialize())
            return None

    def active_duplicate_for_item(self, item: PlaylistItem) -> PlaylistItem | None:
        with self.lock:
            key = self._history_key(item)
            if self.current_item and self._history_key(self.current_item) == key:
                return PlaylistItem.from_dict(self.current_item.serialize())
            for existing in self.playlist:
                if self._history_key(existing) == key:
                    return PlaylistItem.from_dict(existing.serialize())
            return None

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

    def _insert_cycle_item_unlocked(self, item: PlaylistItem) -> None:
        if not self.playlist:
            self.playlist.append(item)
            return

        cycle_keys, requester_counts, order_index = self._requester_cycle_state_unlocked()
        requester_name = self._normalize_session_user_name(item.requester_name)
        if requester_name not in order_index:
            self.playlist.append(item)
            return
        new_key = (requester_counts[requester_name], order_index[requester_name])

        insert_index = 0
        for index, existing in enumerate(self.playlist):
            if existing.queue_slot_type != "cycle":
                insert_index = index + 1
                continue
            existing_key = cycle_keys.get(existing.id)
            if existing_key is None:
                insert_index = index + 1
                continue
            if existing_key <= new_key:
                insert_index = index + 1
        self.playlist.insert(insert_index, item)

    def _rebuild_cycle_items_unlocked(self) -> None:
        cycle_positions: list[int] = []
        sortable_items: list[tuple[tuple[int, int], int, PlaylistItem]] = []
        cycle_keys, _, _ = self._requester_cycle_state_unlocked()

        for index, item in enumerate(self.playlist):
            if item.queue_slot_type != "cycle":
                continue
            key = cycle_keys.get(item.id)
            if key is None:
                continue
            cycle_positions.append(index)
            sortable_items.append((key, index, item))

        if not sortable_items:
            return

        sortable_items.sort(key=lambda entry: (entry[0][0], entry[0][1], entry[1]))
        rebuilt_playlist = list(self.playlist)
        for target_index, (_, _, item) in zip(cycle_positions, sortable_items):
            rebuilt_playlist[target_index] = item
        self.playlist = rebuilt_playlist

    def _requester_cycle_state_unlocked(
        self,
    ) -> tuple[dict[str, tuple[int, int]], defaultdict[str, int], dict[str, int]]:
        ordered_users = self._rotated_cycle_users_unlocked()
        order_index = {
            user_name: index for index, user_name in enumerate(ordered_users)
        }
        requester_counts: defaultdict[str, int] = defaultdict(int)
        cycle_keys: dict[str, tuple[int, int]] = {}

        for item in self.playlist:
            requester_name = self._normalize_session_user_name(item.requester_name)
            if requester_name not in order_index:
                continue
            if item.queue_slot_type == "cycle":
                cycle_keys[item.id] = (
                    requester_counts[requester_name],
                    order_index[requester_name],
                )
            requester_counts[requester_name] += 1

        return cycle_keys, requester_counts, order_index

    def _rotated_cycle_users_unlocked(self) -> list[str]:
        if not self.session_users:
            return []
        current_requester = self._normalize_session_user_name(
            self.current_item.requester_name if self.current_item else ""
        )
        if current_requester not in self.session_users:
            return list(self.session_users)
        current_index = self.session_users.index(current_requester)
        start_index = (current_index + 1) % len(self.session_users)
        return self.session_users[start_index:] + self.session_users[:start_index]

    def _save_session(self) -> None:
        self._write_json_payload_unlocked(
            self.player_state_file,
            {
                "playback_mode": self.playback_mode,
                "player_settings": {
                    "av_offset_ms": self.av_offset_ms,
                    "volume_percent": self.volume_percent,
                    "is_muted": self.is_muted,
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
            "updated_at": self.updated_at,
        }
        self._write_json_payload_unlocked(self.backup_file, payload)

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
            if player_payload:
                self.playback_mode = str(player_payload.get("playback_mode") or "local")
                self.av_offset_ms = self._load_av_offset_ms(player_payload)
                self.volume_percent = self._load_volume_percent(player_payload)
                self.is_muted = self._load_is_muted(player_payload)

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
        keep_names = {"gatcha_cache.json"}
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
    def _history_key(item: PlaylistItem) -> str:
        audio_pages = [
            int(page)
            for page in (item.selected_pages or [])
            if int(page) > 0
        ]
        audio_suffix = ""
        if audio_pages:
            audio_suffix = ":a" + "-".join(str(page) for page in audio_pages)
        if item.bvid:
            return f"{item.bvid}:p{item.page}{audio_suffix}"
        return f"aid:{item.aid}:p{item.page}{audio_suffix}"

    def _record_history_unlocked(self, item: PlaylistItem) -> None:
        now = time.time()
        key = self._history_key(item)
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
        for index, existing in enumerate(self.history):
            if existing.key != key:
                continue
            entry.request_count = existing.request_count + 1
            self.history.pop(index)
            break
        self.history.insert(0, entry)

    def _archive_current_item_unlocked(self) -> None:
        if not self.current_item or not self.current_item_started:
            return
        self._record_session_request_unlocked(self.current_item)
        self._record_history_unlocked(self.current_item)

    def _record_session_request_unlocked(self, item: PlaylistItem) -> None:
        now = time.time()
        key = self._history_key(item)
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
        for index, existing in enumerate(self.session_history):
            if existing.key != key:
                continue
            entry.request_count = existing.request_count + 1
            self.session_history.pop(index)
            break
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
            )
        )

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

    def _validate_requester_name_unlocked(self, requester_name: str) -> str:
        # print(f"[DEBUG] raw={repr(requester_name)}, normalized={repr(self._normalize_session_user_name(requester_name))}")
        if not self.session_users:
            raise ValueError("请先在服务端添加本场 KTV 用户")
        normalized = self._normalize_session_user_name(requester_name)
        if not normalized:
            return self.session_users[0]
            raise ValueError("点歌前请先选择用户名")
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
