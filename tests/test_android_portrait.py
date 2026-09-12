"""Portrait navigation is UI-only and does not replace shared Host/media state."""
import json
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class AndroidPortraitTest(unittest.TestCase):
    def test_shared_host_includes_five_translated_mobile_pages(self):
        host = (ROOT / "static/index.html").read_text(encoding="utf-8")
        remote = (ROOT / "static/remote.html").read_text(encoding="utf-8")
        self.assertIn('/android-host.js', host)
        self.assertIn('/android-host.css', host)
        self.assertNotIn('/android-host.js', remote)
        for page in ("playback", "queue", "request", "users", "my"):
            self.assertEqual(host.count(f'data-android-page="{page}"'), 1)
        translations = json.loads((ROOT / "static/i18n.json").read_text(encoding="utf-8"))["languages"]
        for language in ("zh", "ja", "en"):
            for key in ("navigation", "playback", "queue", "me", "backToMe", "settingsHint", "downloadSettings"):
                self.assertTrue(translations[language][f"mobile.{key}"])

    def test_navigation_orientation_keyboard_and_settings_roundtrip(self):
        node = shutil.which("node")
        self.assertIsNotNone(node, "Node.js is required for frontend tests")
        result = subprocess.run([node, "tests/android_portrait_navigation.cjs"], cwd=ROOT,
                                capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_account_login_requires_action_and_guards_duplicates(self):
        node = shutil.which("node")
        self.assertIsNotNone(node, "Node.js is required for frontend tests")
        result = subprocess.run([node, "tests/android_login_action.cjs"], cwd=ROOT,
                                capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
