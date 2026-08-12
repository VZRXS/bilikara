from __future__ import annotations

import json
from pathlib import Path


def packaged_tool_smoke_json(tool: str) -> str:
    from . import rust_runtime

    normalized = str(tool or "").strip().lower()
    if normalized != "native":
        raise ValueError(f"unsupported packaged tool smoke target: {tool}")

    status = rust_runtime.runtime_status()
    capabilities = status.get("capabilities") or {}
    runtime_path = Path(str(status.get("path") or "")).resolve()
    if (
        not status.get("loaded")
        or not runtime_path.is_file()
        or not capabilities.get("http_download")
        or not capabilities.get("media_backend")
        or not capabilities.get("status_service")
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
