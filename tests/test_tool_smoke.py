from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from bilikara.tool_smoke import packaged_tool_smoke_json


class PackagedToolSmokeTest(unittest.TestCase):
    def test_smoke_establishes_cache_root_before_using_cache_manager(self):
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            cache_dir = root / "data" / "cache"
            runtime = root / "tools" / "bbdown" / "BBDown"
            runtime.parent.mkdir(parents=True)
            runtime.write_bytes(b"bbdown")
            events: list[str] = []

            class FakeCacheManager:
                def __init__(self, _store, *, max_cache_items: int):
                    if max_cache_items != 0:
                        raise AssertionError("tool smoke must disable media caching")
                    if not cache_dir.is_dir():
                        raise AssertionError("cache root was not established")
                    events.append("created")

                def _ensure_bbdown(self) -> Path:
                    return runtime

                @staticmethod
                def _read_bbdown_version(_path: Path) -> str:
                    return "1.6.3"

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
        self.assertEqual(events, ["created", "shutdown"])


if __name__ == "__main__":
    unittest.main()
