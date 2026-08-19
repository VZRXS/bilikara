from __future__ import annotations

import json
from pathlib import Path


def packaged_tool_smoke_json(tool: str) -> str:
    normalized = str(tool or "").strip().lower()
    if normalized not in {"native", "bbdown", "aria2c"}:
        raise ValueError(f"unsupported packaged tool smoke target: {tool}")

    if normalized in {"bbdown", "aria2c"}:
        from .cache import CacheManager
        from .config import BACKUP_FILE, CACHE_DIR, PLAYED_SESSION_DIR, STATE_FILE
        from .store import PlaylistStore

        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        store = PlaylistStore(STATE_FILE, BACKUP_FILE, PLAYED_SESSION_DIR)
        manager = CacheManager(store, max_cache_items=0)
        try:
            if normalized == "bbdown":
                path = manager._ensure_bbdown()  # noqa: SLF001
                version = manager._read_bbdown_version(path)  # noqa: SLF001
            else:
                path = manager._local_aria2c_binary_path()  # noqa: SLF001
                manager._install_aria2c(  # noqa: SLF001
                    path,
                    allow_brew_fallback=False,
                )
                version = manager._read_aria2c_version(path)  # noqa: SLF001
            if not version:
                raise RuntimeError(
                    f"{normalized} runtime version validation failed: {path}"
                )
            payload = {
                "event": "bilikara.tool_smoke",
                "tool": normalized,
                "path": str(Path(path).resolve()),
                "version": version,
            }
            return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        finally:
            manager.shutdown()

    from . import rust_runtime

    status = rust_runtime.runtime_status()
    capabilities = status.get("capabilities") or {}
    runtime_path = Path(str(status.get("path") or "")).resolve()
    if (
        not status.get("loaded")
        or not runtime_path.is_file()
        or not capabilities.get("http_download")
        or not capabilities.get("media_backend")
        or not capabilities.get("status_service")
        or not capabilities.get("json_http")
        or not capabilities.get("networking")
        or not capabilities.get("update_installer")
        or not capabilities.get("diagnostics")
    ):
        raise RuntimeError(
            f"native runtime validation failed: {status.get('error') or runtime_path}"
        )
    payload = {
        "event": "bilikara.tool_smoke",
        "tool": normalized,
        "path": str(runtime_path),
        "version": f"ABI {status.get('abi_version')}",
        "capabilities": capabilities,
    }
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
