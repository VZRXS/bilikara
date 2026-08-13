from __future__ import annotations

import json
from pathlib import Path


def packaged_tool_smoke_json(tool: str) -> str:
    from .cache import CacheManager
    from .config import BACKUP_FILE, CACHE_DIR, PLAYED_SESSION_DIR, STATE_FILE
    from .store import PlaylistStore

    normalized = str(tool or "").strip().lower()
    if normalized not in {"bbdown", "aria2c"}:
        raise ValueError(f"unsupported packaged tool smoke target: {tool}")

    # The normal server bootstrap creates this directory before CacheManager
    # shutdown clears it. The standalone release smoke intentionally bypasses
    # server startup, so establish the same prerequisite here.
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    store = PlaylistStore(STATE_FILE, BACKUP_FILE, PLAYED_SESSION_DIR)
    manager = CacheManager(store, max_cache_items=0)
    try:
        if normalized == "bbdown":
            path = manager._ensure_bbdown()  # noqa: SLF001 - release smoke exercises production deployment
            version = manager._read_bbdown_version(path)  # noqa: SLF001
        else:
            path = manager._local_aria2c_binary_path()  # noqa: SLF001
            manager._install_aria2c(  # noqa: SLF001 - exercises on-demand publication
                path,
                allow_brew_fallback=False,
            )
            version = manager._read_aria2c_version(path)  # noqa: SLF001
        if not version:
            raise RuntimeError(f"{normalized} runtime version validation failed: {path}")
        payload = {
            "event": "bilikara.tool_smoke",
            "tool": normalized,
            "path": str(Path(path).resolve()),
            "version": version,
        }
        return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    finally:
        manager.shutdown()
