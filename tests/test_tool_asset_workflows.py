from __future__ import annotations

import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class ToolAssetWorkflowTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.bundle_workflow = (
            ROOT / ".github" / "workflows" / "ci-bundle.yml"
        ).read_text(encoding="utf-8")
        cls.tool_workflow = (
            ROOT / ".github" / "workflows" / "tool-assets.yml"
        ).read_text(encoding="utf-8")
        cls.build_script = (
            ROOT / "scripts" / "build_portable_macos_aria2.sh"
        ).read_text(encoding="utf-8")

    def test_normal_bundle_workflow_does_not_build_or_publish_aria2_or_ffmpeg(self):
        self.assertNotIn("macos-aria2-tools", self.bundle_workflow)
        self.assertNotIn("build_portable_macos_aria2.sh", self.bundle_workflow)
        self.assertNotIn("build_portable_macos_ffmpeg.sh", self.bundle_workflow)
        self.assertNotIn("Publish immutable aria2c", self.bundle_workflow)
        self.assertNotIn("Publish immutable FFmpeg", self.bundle_workflow)
        bundle_job = self.bundle_workflow.split("\n  bundle:\n", 1)[1].split(
            "\n  mirror-release-r2:\n", 1
        )[0]
        self.assertIn("needs: test", bundle_job)
        self.assertNotIn("R2_ACCOUNT_ID", bundle_job)
        self.assertNotIn("R2_ACCESS_KEY_ID", bundle_job)
        self.assertNotIn("R2_SECRET_ACCESS_KEY", bundle_job)
        self.assertNotIn("aws s3", bundle_job)

    def test_tool_asset_publication_is_manual_only_and_least_privileged(self):
        trigger_block = self.tool_workflow.split("\non:\n", 1)[1].split(
            "\npermissions:\n", 1
        )[0]
        self.assertIn("workflow_dispatch:", trigger_block)
        for automatic_trigger in ("push:", "pull_request:", "schedule:"):
            self.assertNotIn(automatic_trigger, trigger_block)
        self.assertIn("contents: read", self.tool_workflow)
        self.assertIn("R2_ACCESS_KEY_ID", self.tool_workflow)
        self.assertIn("--if-none-match '*'", self.tool_workflow)
        self.assertIn('publication_status="reused"', self.tool_workflow)

    def test_tool_recipe_is_tool_addressed_not_application_commit_addressed(self):
        self.assertNotIn("GITHUB_SHA", self.build_script)
        self.assertIn('BUILD_RECIPE_REVISION="portable-macos-appletls-v2"', self.build_script)
        self.assertIn("${archive_sha256}.tar.gz", self.build_script)
        self.assertIn('"schema_version": 2', self.build_script)
        self.assertIn("ARIA2_SOURCE_SHA256", self.build_script)
        self.assertIn("/usr/bin/otool -L", self.build_script)
        self.assertIn("/opt/homebrew/", self.build_script)
        self.assertIn("/usr/local/Cellar/", self.build_script)

    def test_checked_in_locks_pin_both_macos_architectures(self):
        expected_aria2_hashes = {
            "arm64": "c65d5a04e7cfe6703940db63d3a25b9caa1bbbf8a84a4aff936d280d7d6b18eb",
            "x64": "33985c31bdc342c7745d2aebe1672d52d40dcbcb0dd5c8016f148faf53a0277f",
        }
        for arch, expected_hash in expected_aria2_hashes.items():
            with self.subTest(tool="aria2", arch=arch):
                path = ROOT / "tools" / "aria2" / f"macos-{arch}.json"
                payload = json.loads(path.read_text(encoding="utf-8"))
                self.assertEqual(payload["schema_version"], 2)
                self.assertEqual(payload["tool"], "aria2c")
                self.assertEqual(payload["version"], "1.37.0")
                self.assertEqual(payload["platform"], "darwin")
                self.assertEqual(payload["arch"], arch)
                self.assertEqual(payload["sha256"], expected_hash)
                self.assertTrue(payload["url"].startswith("https://"))
                self.assertIn(payload["name"], payload["url"])
                self.assertTrue(payload["recipe_revision"])

    def test_checked_in_ffmpeg_locks_pin_both_macos_architectures(self):
        for arch in ("arm64", "x64"):
            with self.subTest(tool="ffmpeg", arch=arch):
                path = ROOT / "tools" / "ffmpeg" / f"macos-{arch}.json"
                if not path.is_file():
                    continue
                payload = json.loads(path.read_text(encoding="utf-8"))
                self.assertEqual(payload["schema_version"], 2)
                self.assertEqual(payload["tool"], "ffmpeg")
                self.assertEqual(payload["version"], "8.1.2")
                self.assertEqual(payload["platform"], "darwin")
                self.assertEqual(payload["arch"], arch)
                self.assertTrue(payload["url"].startswith("https://"))
                self.assertIn(payload["name"], payload["url"])
                self.assertTrue(payload["recipe_revision"])

    def test_normal_bundle_embeds_required_media_tools(self):
        self.assertIn("Install FFmpeg on Windows", self.bundle_workflow)
        self.assertIn("choco install ffmpeg -y --no-progress", self.bundle_workflow)
        self.assertNotIn("for ($attempt", self.bundle_workflow)
        self.assertNotIn("Start-Sleep", self.bundle_workflow)
        self.assertIn("Prepare pinned portable FFmpeg asset", self.bundle_workflow)
        self.assertIn("Prepare pinned BBDown vendor", self.bundle_workflow)
        self.assertIn("scripts/prepare_bbdown_vendor.py", self.bundle_workflow)
        self.assertIn(
            "Verify native backend and bundled tools on Windows",
            self.bundle_workflow,
        )
        self.assertIn(
            "Verify native backend and bundled tools on macOS",
            self.bundle_workflow,
        )
        self.assertIn("Verify clean BBDown runtime restore on Windows", self.bundle_workflow)
        self.assertIn("Locked aria2c metadata-only checks", self.bundle_workflow)
        self.assertIn("BILIKARA_REQUIRE_ARIA2_TOOL_SMOKE=1", self.bundle_workflow)
        self.assertIn("Packaged portable FFmpeg checks", self.bundle_workflow)
        self.assertIn("Running extracted portable FFmpeg checks", self.bundle_workflow)
        for tool in ("BBDown", "ffmpeg", "ffprobe"):
            self.assertIn(tool, self.bundle_workflow)
        self.assertIn("bilikara_runtime.dll", self.bundle_workflow)
        self.assertIn("libbilikara_runtime.dylib", self.bundle_workflow)

    def test_macos_desktop_embedding_is_part_of_final_signing_and_smoke_gate(self):
        self.assertIn("scripts/embed_macos_backend.py", self.bundle_workflow)
        self.assertIn("bilikara-backend.app", self.bundle_workflow)
        self.assertIn(
            "codesign --verify --deep --strict --verbose=4 \"$embedded_backend\"",
            self.bundle_workflow,
        )
        smoke_source = (ROOT / "tests" / "test_macos_tauri_smoke.py").read_text(
            encoding="utf-8"
        )
        self.assertIn("isolated-app", smoke_source)
        self.assertIn("candidate_type=macos-embedded-backend", smoke_source)
        self.assertIn("FINDER_LIKE_PATH", smoke_source)


if __name__ == "__main__":
    unittest.main()
