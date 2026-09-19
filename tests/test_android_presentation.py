"""Android display I/O uses the shared Host and audience renderer."""
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class AndroidPresentationTest(unittest.TestCase):
    def test_bridge_and_shared_stage_behavior(self):
        node = shutil.which("node")
        self.assertIsNotNone(node)
        result = subprocess.run([node, "tests/android_presentation.cjs"], cwd=ROOT,
                                capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_native_bridge_is_origin_role_and_generation_scoped(self):
        native = (ROOT / "src-tauri/gen/android/app/src/main/java/com/bilikara/app/HostPresentation.kt").read_text(encoding="utf-8")
        for guard in ("sourceOrigin != expected", "!isMainFrame", "view !== output",
                      "generation != windowGeneration", 'listOf("/controller.html")',
                      'listOf("/", "/index.html")', 'setOf(origin)',
                      'args.optLong("generation", -1) == generation',
                      'DisplayManager.DISPLAY_CATEGORY_PRESENTATION',
                      'allowFileAccess = false', 'allowContentAccess = false',
                      'setSupportMultipleWindows(false)', 'while (events.size > 40)',
                      'remove("name")', 'oldView?.destroy()'):
            self.assertIn(guard, native)
        for forbidden in ('addJavascriptInterface', 'setOf("*")', 'MediaPlayer(',
                          'ExoPlayer', '/api/player/', 'SESSDATA', 'getCookie('):
            self.assertNotIn(forbidden, native)

    def test_android_includes_adapter_without_changing_remote(self):
        host = (ROOT / "static/index.html").read_text(encoding="utf-8")
        stage = (ROOT / "static/controller.html").read_text(encoding="utf-8")
        remote = (ROOT / "static/remote.html").read_text(encoding="utf-8")
        self.assertLess(host.index('/android-presentation.js'), host.index('/app.js'))
        self.assertLess(stage.index('/android-presentation.js'), stage.index('/controller.js'))
        self.assertNotIn('/android-presentation.js', remote)


if __name__ == "__main__":
    unittest.main()
