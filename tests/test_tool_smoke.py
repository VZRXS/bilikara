from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from bilikara.tool_smoke import packaged_tool_smoke_json


class PackagedToolSmokeTest(unittest.TestCase):
    def test_bbdown_smoke_exercises_runtime_restore(self):
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            cache_dir = root / "data" / "cache"
            runtime = root / "tools" / "bbdown" / "BBDown.exe"
            runtime.parent.mkdir(parents=True)
            runtime.write_bytes(b"bbdown")
            events: list[str] = []

            class FakeCacheManager:
                def __init__(self, _store, *, max_cache_items: int):
                    self.max_cache_items = max_cache_items
                    events.append("created")

                def _ensure_bbdown(self) -> Path:
                    self.assert_cache_ready()
                    return runtime

                @staticmethod
                def _read_bbdown_version(_path: Path) -> str:
                    return "1.6.3"

                def assert_cache_ready(self) -> None:
                    if self.max_cache_items != 0 or not cache_dir.is_dir():
                        raise AssertionError("BBDown smoke prerequisites were not established")

                def shutdown(self) -> None:
                    events.append("shutdown")

            with patch("bilikara.config.CACHE_DIR", cache_dir), patch(
                "bilikara.config.STATE_FILE", root / "data" / "state.json"
            ), patch("bilikara.config.BACKUP_FILE", root / "data" / "backup.json"), patch(
                "bilikara.config.PLAYED_SESSION_DIR", root / "data" / "played"
            ), patch("bilikara.cache.CacheManager", FakeCacheManager), patch(
                "bilikara.store.PlaylistStore", return_value=object()
            ):
                payload = json.loads(packaged_tool_smoke_json("bbdown"))

        self.assertEqual(payload["event"], "bilikara.tool_smoke")
        self.assertEqual(payload["tool"], "bbdown")
        self.assertEqual(payload["version"], "1.6.3")
        self.assertEqual(Path(payload["path"]), runtime.resolve())
        self.assertEqual(events, ["created", "shutdown"])

    def test_smoke_validates_native_runtime_capabilities(self):
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            runtime = root / "rust" / "bilikara_runtime.dll"
            runtime.parent.mkdir(parents=True)
            runtime.write_bytes(b"native")
            with patch(
                "bilikara.rust_runtime.runtime_status",
                return_value={
                    "loaded": True,
                    "path": str(runtime),
                    "abi_version": 1,
                    "error": "",
                    "capabilities": {
                        "http_download": True,
                        "media_backend": True,
                        "status_service": True,
                        "json_http": True,
                        "networking": True,
                        "update_installer": True,
                        "diagnostics": True,
                    },
                },
            ):
                payload = json.loads(packaged_tool_smoke_json("native"))

        self.assertEqual(payload["event"], "bilikara.tool_smoke")
        self.assertEqual(payload["tool"], "native")
        self.assertEqual(payload["version"], "ABI 1")
        self.assertTrue(payload["capabilities"]["media_backend"])
        self.assertTrue(payload["capabilities"]["status_service"])
        self.assertTrue(payload["capabilities"]["diagnostics"])


if __name__ == "__main__":
    unittest.main()
