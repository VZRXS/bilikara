"""Compatibility entry points for the authoritative Rust export service."""
from __future__ import annotations

from pathlib import Path
from typing import Any

from .config import APP_VERSION, STATIC_DIR
from .rust_runtime import export_playlist_artifact, prewarm_playlist_fonts

PLAYLIST_IMAGE_PAGE_SIZE = 80
PROJECT_URL = "https://github.com/VZRXS/bilikara"


def playlist_csv_bytes(items: list[dict[str, Any]], *, time_header: str = "点歌时间") -> bytes:
    return export_playlist_artifact(
        {"operation": "csv", "items": items, "time_header": time_header}
    )[0]


def playlist_image_export(
    items: list[dict[str, Any]],
    *,
    logo_path: Path | None = None,
    title: str = "bilikara 歌单导出",
    page_size: int = PLAYLIST_IMAGE_PAGE_SIZE,
) -> tuple[bytes, str, str]:
    # The established design does not draw a logo. Retain the caller signature.
    del logo_path
    return export_playlist_artifact({
        "operation": "image", "items": items, "title": title, "page_size": page_size,
        "font_path": str((STATIC_DIR / "fonts" / "SourceHanSans-VF.ttf").resolve()),
        "app_version": APP_VERSION,
    })


def prewarm_playlist_export_fonts() -> None:
    try:
        prewarm_playlist_fonts((STATIC_DIR / "fonts" / "SourceHanSans-VF.ttf").resolve())
    except Exception:
        # Startup prewarm is best effort. Export itself never swallows failure.
        return
