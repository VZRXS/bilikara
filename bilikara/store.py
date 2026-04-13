from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import Any

from .models import HistoryEntry, PlaylistItem


class PlaylistStore:
    def __init__(self, state_file: Path, backup_file: Path) -> None:
        self.state_file = state_file
        self.backup_file = backup_file
        self.lock = threading.RLock()
        self.playback_mode = "local"
        self.current_item: PlaylistItem | None = None
        self.playlist: list[PlaylistItem] = []
        self.history: list[HistoryEntry] = []
        self.updated_at = time.time()
        self._restore_history_from_state()
        self._save_session()

    def snapshot(self) -> dict:
        with self.lock:
            return {
                "playback_mode": self.playback_mode,
                "playlist": [item.to_dict() for item in self.playlist],
                "current_item": self.current_item.to_dict() if self.current_item else None,
                "history": [entry.to_dict() for entry in self.history],
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

    def add_item(self, item: PlaylistItem, position: str = "tail") -> None:
        with self.lock:
            self._record_history_unlocked(item)
            if self.current_item is None:
                self.current_item = item
                self._touch(persist_backup=True)
                return
            if position == "next":
                self.playlist.insert(0, item)
            else:
                self.playlist.append(item)
            self._touch(persist_backup=True)

    def remove_item(self, item_id: str) -> bool:
        with self.lock:
            if self.current_item and self.current_item.id == item_id:
                self.current_item = None
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
            self._touch(persist_backup=True)

    def advance_to_next(self) -> bool:
        with self.lock:
            if not self.current_item and not self.playlist:
                return False
            self.current_item = self.playlist.pop(0) if self.playlist else None
            self._touch(persist_backup=True)
            return True

    def move_item(self, item_id: str, direction: str) -> bool:
        with self.lock:
            index = self._find_index(item_id)
            if index is None:
                return False
            if direction == "up" and index > 0:
                self.playlist[index - 1], self.playlist[index] = (
                    self.playlist[index],
                    self.playlist[index - 1],
                )
                self._touch(persist_backup=True)
                return True
            if direction == "down" and index < len(self.playlist) - 1:
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
            self.playlist.insert(bounded_index, item)
            self._touch(persist_backup=True)
            return True

    def move_to_front(self, item_id: str) -> bool:
        with self.lock:
            index = self._find_index(item_id)
            if index is None:
                return False
            self.current_item = self.playlist.pop(index)
            self._touch(persist_backup=True)
            return True

    def set_mode(self, mode: str) -> None:
        with self.lock:
            self.playback_mode = mode
            self._touch(persist_backup=True)

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
                setattr(item, key, value)
            self._touch(persist_backup=persist_backup)
            return True

    def restore_backup(self) -> bool:
        with self.lock:
            payload = self._read_backup_payload_unlocked()
            if not payload:
                return False
            current_item_payload = payload.get("current_item")
            playlist_payload = payload.get("playlist") or []
            if not current_item_payload and not playlist_payload:
                history_payload = payload.get("history") or []
                if history_payload:
                    self.history = [
                        HistoryEntry.from_dict(dict(entry))
                        for entry in history_payload
                        if isinstance(entry, dict)
                    ]
                return False
            self.playback_mode = str(payload.get("playback_mode") or "local")
            self.current_item = (
                PlaylistItem.from_dict(self._sanitize_backup_payload(current_item_payload))
                if current_item_payload
                else None
            )
            self.playlist = [
                PlaylistItem.from_dict(self._sanitize_backup_payload(item))
                for item in playlist_payload
            ]
            self.history = [
                HistoryEntry.from_dict(dict(entry))
                for entry in payload.get("history") or []
                if isinstance(entry, dict)
            ]
            self._touch(persist_backup=False)
            return True

    def discard_backup(self) -> bool:
        with self.lock:
            existed = self.backup_file.exists()
            self.backup_file.unlink(missing_ok=True)
            return existed

    def backup_summary(self) -> dict[str, Any]:
        with self.lock:
            return self._backup_summary_unlocked()

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

    def _save_session(self) -> None:
        payload = {
            "playback_mode": self.playback_mode,
            "current_item": self.current_item.serialize() if self.current_item else None,
            "playlist": [item.serialize() for item in self.playlist],
            "history": [entry.serialize() for entry in self.history],
            "updated_at": self.updated_at,
        }
        self.state_file.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    def _save_backup(self) -> None:
        if not self.current_item and not self.playlist:
            self.backup_file.unlink(missing_ok=True)
            return
        payload = {
            "playback_mode": self.playback_mode,
            "current_item": (
                self._backup_item_payload(self.current_item) if self.current_item else None
            ),
            "playlist": [self._backup_item_payload(item) for item in self.playlist],
            "history": [entry.serialize() for entry in self.history],
            "updated_at": self.updated_at,
        }
        self.backup_file.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    def _touch(self, *, persist_backup: bool) -> None:
        self.updated_at = time.time()
        self._save_session()
        if persist_backup:
            self._save_backup()

    def _backup_item_payload(self, item: PlaylistItem) -> dict[str, Any]:
        payload = item.serialize()
        payload.update(
            cache_status="pending",
            cache_progress=0.0,
            cache_message="等待缓存",
            local_relative_path="",
            local_media_url="",
            audio_variants=[],
            selected_audio_variant_id="",
        )
        return payload

    def _sanitize_backup_payload(self, payload: dict[str, Any]) -> dict[str, Any]:
        sanitized = dict(payload)
        sanitized.update(
            cache_status="pending",
            cache_progress=0.0,
            cache_message="等待缓存",
            local_relative_path="",
            local_media_url="",
            audio_variants=[],
            selected_audio_variant_id="",
        )
        return sanitized

    def _read_backup_payload_unlocked(self) -> dict[str, Any] | None:
        if not self.backup_file.exists():
            return None
        try:
            payload = json.loads(self.backup_file.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return None
        if not isinstance(payload, dict):
            return None
        return payload

    def _read_state_payload_unlocked(self) -> dict[str, Any] | None:
        if not self.state_file.exists():
            return None
        try:
            payload = json.loads(self.state_file.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return None
        if not isinstance(payload, dict):
            return None
        return payload

    def _restore_history_from_state(self) -> None:
        with self.lock:
            payload = self._read_state_payload_unlocked()
            if not payload:
                return
            history_payload = payload.get("history") or []
            self.history = [
                HistoryEntry.from_dict(dict(entry))
                for entry in history_payload
                if isinstance(entry, dict)
            ]

    @staticmethod
    def _history_key(item: PlaylistItem) -> str:
        if item.bvid:
            return f"{item.bvid}:p{item.page}"
        return f"aid:{item.aid}:p{item.page}"

    def _record_history_unlocked(self, item: PlaylistItem) -> None:
        now = time.time()
        key = self._history_key(item)
        entry = HistoryEntry(
            key=key,
            display_title=item.display_title,
            original_url=item.original_url,
            resolved_url=item.resolved_url,
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
            "playback_mode": str(payload.get("playback_mode") or "local"),
        }
