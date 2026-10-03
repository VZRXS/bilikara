"""Manual artifact labels must not authorize a published release.

Wrong-version package rejection is independently tested in xtask/native_package.
"""
from pathlib import Path
import unittest


class NativeReleaseIdentityTests(unittest.TestCase):
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
