from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from tempfile import TemporaryDirectory
from unittest.mock import patch

from bilikara import launcher
from bilikara.tool_smoke import packaged_tool_smoke_json


class PackagedToolSmokeTest(unittest.TestCase):
    def test_launcher_accepts_aria2c_smoke_target(self):
        marker = '{"event":"bilikara.tool_smoke","tool":"aria2c"}'
        trust_status = SimpleNamespace(
            backend="python-default",
            verify_mode="CERT_REQUIRED",
            check_hostname=True,
        )

        with patch.object(sys, "argv", ["bilikara", "--tool-smoke", "aria2c"]), patch(
            "bilikara.launcher._ensure_std_streams"
        ), patch("bilikara.launcher._install_debug_log_streams"), patch(
            "bilikara.launcher._install_startup_exception_hooks"
        ), patch(
            "bilikara.launcher.startup_logging_enabled", return_value=False
        ), patch(
            "bilikara.https_trust.initialize_https_trust", return_value=trust_status
        ), patch(
            "bilikara.tool_smoke.packaged_tool_smoke_json", return_value=marker
        ) as smoke, patch(
            "builtins.print"
        ) as print_mock:
            launcher.run_with_startup_logging()

        smoke.assert_called_once_with("aria2c")
        print_mock.assert_called_once_with(marker, flush=True)

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

    def test_aria2c_smoke_exercises_on_demand_publication(self):
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            cache_dir = root / "data" / "cache"
            runtime = root / "tools" / "aria2c" / "aria2c"
            events: list[object] = []

            class FakeCacheManager:
                def __init__(self, _store, *, max_cache_items: int):
                    if max_cache_items != 0:
                        raise AssertionError("tool smoke must disable media caching")
                    events.append("created")

                @staticmethod
                def _local_aria2c_binary_path() -> Path:
                    return runtime

                @staticmethod
                def _install_aria2c(path: Path, *, allow_brew_fallback: bool) -> None:
                    events.append((path, allow_brew_fallback))
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(b"aria2c")

                @staticmethod
                def _read_aria2c_version(_path: Path) -> str:
                    return "1.37.0"

                def shutdown(self) -> None:
                    events.append("shutdown")

            with patch("bilikara.config.CACHE_DIR", cache_dir), patch(
                "bilikara.config.STATE_FILE", root / "data" / "state.json"
            ), patch("bilikara.config.BACKUP_FILE", root / "data" / "backup.json"), patch(
                "bilikara.config.PLAYED_SESSION_DIR", root / "data" / "played"
            ), patch("bilikara.cache.CacheManager", FakeCacheManager), patch(
                "bilikara.store.PlaylistStore", return_value=object()
            ):
                payload = json.loads(packaged_tool_smoke_json("aria2c"))

        self.assertEqual(payload["event"], "bilikara.tool_smoke")
        self.assertEqual(payload["tool"], "aria2c")
        self.assertEqual(payload["version"], "1.37.0")
        self.assertEqual(Path(payload["path"]), runtime.resolve())
        self.assertEqual(events, ["created", (runtime, False), "shutdown"])


if __name__ == "__main__":
    unittest.main()
