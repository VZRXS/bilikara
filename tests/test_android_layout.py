"""Device-local window preferences; shared Host/media state is unchanged."""
import json
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class AndroidLayoutTest(unittest.TestCase):
    def test_layout_policy_and_native_bridge_lifecycle(self):
        node = shutil.which("node")
        self.assertIsNotNone(node)
        result = subprocess.run([node, "tests/android_layout.cjs"], cwd=ROOT,
                                capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_shared_host_layout_and_android_orientation_preferences_are_translated(self):
        host = (ROOT / "static/index.html").read_text(encoding="utf-8")
        remote = (ROOT / "static/remote.html").read_text(encoding="utf-8")
        self.assertLess(host.index('/android-layout.js'), host.index('/host-layout.js'))
        self.assertNotIn('/android-layout.js', remote)
        self.assertIn('/host-layout-preferences.js', host)
        self.assertNotIn('/host-layout.js', remote)
        translations = json.loads((ROOT / "static/i18n.json").read_text(encoding="utf-8"))["languages"]
        for language in ("zh", "ja", "en"):
            for key in ("layout", "layoutAuto", "layoutDesktop", "layoutPhone", "layoutHint",
                        "orientation", "orientationSystem", "orientationLandscape", "orientationPortrait",
                        "orientationHint", "windowPreferenceFailed"):
                self.assertTrue(translations[language][f"mobile.{key}"])
        for name in ("layout", "orientation"):
            self.assertIn(f'id="android-{name}-settings" hidden', host)

    def test_native_preferences_are_narrow_and_survive_loopback_port_changes(self):
        native = (ROOT / "src-tauri/gen/android/app/src/main/java/com/bilikara/app/HostWindowControls.kt").read_text(encoding="utf-8")
        for guard in ('private val preferences by lazy',
                      'getSharedPreferences("host-window", Context.MODE_PRIVATE)', 'setOf(origin)',
                      '!isMainFrame', 'sourceOrigin != expected', 'listOf("/", "/index.html")',
                      'raw.length > 1024', 'require(mode in layoutModes)', 'require(mode in orientationModes)',
                      'previousOrientation = activity.requestedOrientation',
                      'activity.requestedOrientation = previousOrientation'):
            self.assertIn(guard, native)
        for forbidden in ('addJavascriptInterface', 'setOf("*")', 'webView.reload(', 'loadUrl('):
            self.assertNotIn(forbidden, native)


if __name__ == "__main__":
    unittest.main()
