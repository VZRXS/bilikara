import shutil
import subprocess
import unittest
from pathlib import Path


class NativeRemoteParityTest(unittest.TestCase):
    def test_rating_http_errors_release_dedup_and_busy_state_for_retry(self):
        node = shutil.which("node")
        self.assertIsNotNone(node, "Node is required for Remote behavior tests")
        result = subprocess.run([node, "tests/native_remote_rating.cjs"],
                                cwd=Path(__file__).resolve().parents[1],
                                capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
