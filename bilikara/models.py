from __future__ import annotations

from dataclasses import asdict, dataclass, field, fields as dataclass_fields
from typing import Any

from .title_cleanup import clean_display_title


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
    available_pages: list[int] = field(default_factory=list)
    available_cids: list[int] = field(default_factory=list)
    available_durations: list[int] = field(default_factory=list)
    available_parts: list[str] = field(default_factory=list)
    audio_variants: list[dict[str, str]] = field(default_factory=list)
    selected_audio_variant_id: str = ""
    video_page: int = 1
    manual_selection: bool = False
    owner_mid: int = 0
    owner_name: str = ""
    owner_url: str = ""
    requester_name: str = ""
    queue_slot_type: str = "cycle"
    cache_status: str = "pending"
    cache_progress: float = 0.0
    cache_message: str = "等待缓存"
    video_relative_path: str = ""
    video_media_url: str = ""

    def serialize(self) -> dict[str, Any]:
        return asdict(self)

    def to_dict(self) -> dict[str, Any]:
        data = self.serialize()
        data["display_title"] = clean_display_title(
            title=self.title,
            display_title=self.display_title,
            part_title=self.part_title,
        )
        # LEGACY: old state files used local_media_url for one muxed file.
        # Split playback requires both video and audio.
        data["is_cached"] = bool(
            self.video_media_url
            and any(
                isinstance(variant, dict)
                and str(variant.get("audio_url") or variant.get("media_url") or "").strip()
                for variant in self.audio_variants
            )
        )
        return data

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "PlaylistItem":
        allowed_fields = {item.name for item in dataclass_fields(cls)}
        filtered = {
            key: value
            for key, value in dict(payload).items()
            if key in allowed_fields
        }
        return cls(**filtered)


@dataclass
class HistoryEntry:
    key: str
    display_title: str
    original_url: str
    resolved_url: str
    requested_at: float
    title: str = ""
    part_title: str = ""
    owner_mid: int = 0
    owner_name: str = ""
    owner_url: str = ""
    requester_name: str = ""
    request_count: int = 1

    def serialize(self) -> dict[str, Any]:
        return asdict(self)

    def to_dict(self) -> dict[str, Any]:
        data = self.serialize()
        data["display_title"] = clean_display_title(
            title=self.title,
            display_title=self.display_title,
            part_title=self.part_title,
        )
        return data

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
    requester_name: str = ""

    def serialize(self) -> dict[str, Any]:
        return asdict(self)

    def to_dict(self) -> dict[str, Any]:
        return self.serialize()

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "SessionPlayedEntry":
        return cls(**dict(payload))
