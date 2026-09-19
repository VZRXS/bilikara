"""Keep native seek gestures separate from the shared desktop click shortcut."""
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class AndroidPlayerGesturesTest(unittest.TestCase):
    def test_shared_player_gestures(self):
        node = shutil.which("node")
        self.assertIsNotNone(node, "Node.js is required for frontend tests")
        result = subprocess.run([node, "tests/android_player_gestures.cjs"], cwd=ROOT,
                                capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
