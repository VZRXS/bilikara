from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass
class PlaylistItem:
    id: str
    original_url: str
    resolved_url: str
    bvid: str
    aid: int
    cid: int
    page: int
    title: str
    part_title: str
    display_title: str
    cover_url: str
    embed_url: str
    selected_pages: list[int] = field(default_factory=list)
    selected_cids: list[int] = field(default_factory=list)
    selected_durations: list[int] = field(default_factory=list)
    selected_parts: list[str] = field(default_factory=list)
    audio_variants: list[dict[str, str]] = field(default_factory=list)
    selected_audio_variant_id: str = ""
    video_page: int = 1
    owner_mid: int = 0
    owner_name: str = ""
    owner_url: str = ""
    cache_status: str = "pending"
    cache_progress: float = 0.0
    cache_message: str = "等待缓存"
    local_relative_path: str = ""
    local_media_url: str = ""

    def serialize(self) -> dict[str, Any]:
        return asdict(self)

    def to_dict(self) -> dict[str, Any]:
        data = self.serialize()
        data["is_cached"] = bool(self.local_media_url)
        return data

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "PlaylistItem":
        filtered = dict(payload)
        filtered.pop("is_cached", None)
        return cls(**filtered)


@dataclass
class HistoryEntry:
    key: str
    display_title: str
    original_url: str
    resolved_url: str
    requested_at: float
    owner_mid: int = 0
    owner_name: str = ""
    owner_url: str = ""
    request_count: int = 1

    def serialize(self) -> dict[str, Any]:
        return asdict(self)

    def to_dict(self) -> dict[str, Any]:
        return self.serialize()

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "HistoryEntry":
        return cls(**dict(payload))


@dataclass
class SessionPlayedEntry:
    key: str
    item_id: str
    display_title: str
    title: str
    part_title: str
    original_url: str
    resolved_url: str
    bvid: str
    aid: int
    cid: int
    page: int
    played_at: float
    owner_mid: int = 0
    owner_name: str = ""
    owner_url: str = ""

    def serialize(self) -> dict[str, Any]:
        return asdict(self)

    def to_dict(self) -> dict[str, Any]:
        return self.serialize()

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "SessionPlayedEntry":
        return cls(**dict(payload))
