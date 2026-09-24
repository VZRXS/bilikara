"""Startup remains usable while optional desktop resources initialize."""
import os
from pathlib import Path
import shutil
import sys
import tempfile
import time
import unittest
import urllib.error

from scripts.check_native_desktop_bundle import RunningHost, isolated_environment


ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(os.environ.get("BILIKARA_TEST_NATIVE_PACKAGE"), "requires built native desktop Host")
class NativeDesktopStartupTests(unittest.TestCase):
    def start(self, home, assets=None, **overrides):
        env = isolated_environment(home)
        if companion := os.environ.get("BILIKARA_TEST_LIBAV_COMPANION"):
            env["BILIKARA_LIBAV_COMPANION"] = companion
        env.update(overrides)
        return RunningHost(Path(os.environ["BILIKARA_TEST_NATIVE_PACKAGE"]).resolve(), home,
                           "--headless", "--data-dir", str(home / "data"),
                           "--static-dir", str(assets or ROOT / "static"), env=env)

    def test_export_font_failure_does_not_prevent_startup_or_csv_and_can_recover(self):
        with tempfile.TemporaryDirectory(prefix="desktop-startup-font-") as temp:
            home = Path(temp)
            assets = home / "static"
            shutil.copytree(ROOT / "static", assets)
            font = assets / "fonts/SourceHanSans-VF.ttf"
            font.write_bytes(b"invalid-font-fixture")
            host = self.start(home, assets)
            try:
                self.assertEqual(host.api("/api/state")["cache_policy"]["download_source"], "native")
                with host.request("/api/playlist/export?format=csv&source=history&page_size=50") as response:
                    self.assertEqual(response.status, 200)
                    self.assertTrue(response.read())
                with self.assertRaises(urllib.error.HTTPError) as error:
                    host.request("/api/playlist/export?format=image&source=history&page_size=50")
                self.assertEqual(error.exception.code, 503)
                error.exception.close()
                shutil.copyfile(ROOT / "static/fonts/SourceHanSans-VF.ttf", font)
                with host.request("/api/playlist/export?format=image&source=history&page_size=50") as response:
                    self.assertEqual(response.read(8), b"\x89PNG\r\n\x1a\n")
            finally:
                host.close()

    def test_immediate_image_export_shares_prewarm_resources(self):
        with tempfile.TemporaryDirectory(prefix="desktop-startup-export-") as temp:
            host = self.start(Path(temp))
            try:
                with host.request("/api/playlist/export?format=image&source=history&page_size=50") as response:
                    self.assertEqual(response.read(8), b"\x89PNG\r\n\x1a\n")
            finally:
                host.close()

    @unittest.skipUnless(os.name == "posix", "controlled aria2 executable uses a POSIX shebang")
    def test_unselected_tool_probe_does_not_block_ready_and_explicit_selection_reuses_it(self):
        with tempfile.TemporaryDirectory(prefix="desktop-startup-tool-") as temp:
            home = Path(temp)
            tool = home / "aria2c"
            # The first probe cannot finish until the test has used the live
            # Host. This checks the dependency without a startup-time threshold.
            tool.write_text(f"#!{sys.executable}\n" + """
from pathlib import Path
import sys, time
root = Path(__file__).parent
with (root / 'calls').open('a') as calls: calls.write(sys.argv[-1] + '\\n')
if '--version' in sys.argv:
    while not (root / 'release').exists(): time.sleep(.01)
    print('aria2 version 1.37.0\\nEnabled Features: HTTPS')
else:
    print('--no-netrc --input-file --load-cookies --max-connection-per-server --human-readable --file-allocation --check-certificate --allow-overwrite --enable-rpc')
""")
            tool.chmod(0o700)
            host = self.start(home, ARIA2C_PATH=str(tool))
            try:
                self.assertEqual(host.api("/api/state")["cache_policy"]["download_source"], "native")
                deadline = time.monotonic() + 3
                while not (home / "calls").exists() and time.monotonic() < deadline:
                    time.sleep(.01)
                self.assertTrue((home / "calls").exists())
                # Capability readers must not hold up unrelated operations on
                # the preparation lock while the external process is waiting.
                self.assertIn("markdown", host.api("/api/diagnostics/markdown", {}))
                (home / "release").touch()
                result = host.api("/api/cache-downloader/status", {"download_source": "downkyi"})
                self.assertTrue(result["ready"])
                host.api("/api/cache-policy", {"download_source": "downkyi"})
                self.assertEqual(host.api("/api/state")["cache_policy"]["download_source"], "downkyi")
                self.assertEqual((home / "calls").read_text().splitlines(), ["--version", "--help=#all"])
            finally:
                (home / "release").touch()
                host.close()
            host = self.start(home, ARIA2C_PATH=str(tool))
            try:
                # A persisted DownKyi selection is validated before readiness.
                policy = host.api("/api/state")["cache_policy"]
                self.assertEqual(policy["download_source"], "downkyi")
                self.assertTrue(policy["enabled"])
                self.assertEqual((home / "calls").read_text().splitlines(),
                                 ["--version", "--help=#all"] * 2)
            finally:
                host.close()
