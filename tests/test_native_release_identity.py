"""Release packaging must reject matching records with the wrong version."""
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from scripts.check_native_desktop_bundle import inspect_package


class NativeReleaseIdentityTests(unittest.TestCase):
    def test_release_gate_rejects_matching_but_wrong_version_records(self):
        expected = "v0.8.0-preview.3"
        wrong = f"{expected}-g0123456789ab-dirty"
        facts = {
            "schema_version": 1, "backend": "rust", "version": wrong,
            "resource_layout": "internal-v1", "platform": "windows",
            "arch": "x64", "development": False,
        }
        with tempfile.TemporaryDirectory() as directory:
            internal = Path(directory) / "_internal"
            internal.mkdir()
            (internal / "native-desktop.json").write_text(json.dumps(facts), encoding="utf-8")
            (internal / "APP_VERSION").write_text(wrong, encoding="utf-8")
            with patch.dict(os.environ, BILIKARA_EXPECT_RELEASE_VERSION=expected):
                with self.assertRaisesRegex(AssertionError, "Release version mismatch"):
                    inspect_package(internal / "bilikara-desktop-host.exe")


    def test_manual_bundle_version_labels_artifacts_without_releasing(self):
        workflow = (Path(__file__).resolve().parents[1] / ".github/workflows/ci-bundle.yml").read_text(encoding="utf-8")
        self.assertIn("bundle_version:", workflow)
        self.assertIn("BILIKARA_VERSION: ${{ github.event_name == 'workflow_dispatch' && inputs.bundle_version || '' }}", workflow)
        self.assertIn("github.ref_name || inputs.bundle_version || ''", workflow)
        self.assertIn("-preview\\.[0-9]+)?$'", workflow)
        release = workflow[workflow.index("- name: Upload bundle to GitHub Release"):]
        self.assertIn("if: startsWith(github.ref, 'refs/tags/v')", release.split("\n", 3)[1])
        mirror = workflow[workflow.index("  mirror-release-r2:"):]
        self.assertIn("if: startsWith(github.ref, 'refs/tags/v')", mirror[:400])

if __name__ == "__main__":
    unittest.main()
