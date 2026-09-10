from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import textwrap
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

    def test_rust_gate_stops_before_later_commands_can_hide_a_failure(self):
        block = self.bundle_workflow.split("      - name: Rust Checks and Build\n", 1)[1].split(
            "      - name:", 1
        )[0]
        self.assertIn("shell: bash", block)
        script = textwrap.dedent(block.split("run: |\n", 1)[1])
        bash = shutil.which("bash")
        if os.name == "nt":
            git_bash = Path(os.environ["ProgramFiles"]) / "Git/bin/bash.exe"
            if git_bash.is_file():
                bash = str(git_bash)
        if not bash:
            self.skipTest("Bash is required to execute the workflow gate")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for directory in ("rust", "rust-runtime", "src-tauri"):
                (root / directory).mkdir()
            stub = '''cargo() {
  printf '%s\\n' "${PWD##*/}:$*" >> ../calls.log
  if [ "$1" = clippy ]; then return 42; fi
  return 0
}
'''
            result = subprocess.run([bash, "--noprofile", "--norc", "-c", stub + script],
                                    cwd=root, capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 42, result.stdout + result.stderr)
            self.assertEqual((root / "calls.log").read_text().splitlines(), [
                "rust:fmt --check", "rust:clippy --all-targets --locked -- -D warnings",
            ])

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

    def test_bundle_names_end_with_branch_and_preserve_tag_archive_names(self):
        block = self.bundle_workflow.split("      - name: Resolve bundle archive name\n", 1)[1].split(
            "      - name:", 1
        )[0]
        self.assertIn("BUNDLE_SLUG: ${{ matrix.slug }}", block)
        self.assertIn("BUNDLE_ARCH: ${{ matrix.arch }}", block)
        script = textwrap.dedent(block.split("run: |\n", 1)[1])
        self.assertTrue(script.strip())
        upload = self.bundle_workflow.split("      - name: Upload native bundle\n", 1)[1].split(
            "      - name:", 1
        )[0]
        self.assertIn("uses: actions/upload-artifact@v7", upload)
        self.assertIn("path: ${{ steps.bundle-name.outputs.archive_name }}", upload)
        self.assertIn("archive: false", upload)
        self.assertNotIn("if: always()", upload)
        self.assertNotIn("dist/", upload)
        diagnostics = self.bundle_workflow.split("      - name: Upload native libav diagnostics\n", 1)[1].split(
            "      - name:", 1
        )[0]
        self.assertIn("if: always()", diagnostics)
        self.assertIn("name: diagnostics-${{ steps.bundle-name.outputs.artifact_name }}", diagnostics)
        self.assertIn("dist/libav-build-records", diagnostics)
        self.assertIn("dist/libav-smoke-result.json", diagnostics)
        self.assertNotIn(".zip", diagnostics)
        self.assertLess(self.bundle_workflow.index("Resolve bundle archive name"),
                        self.bundle_workflow.index("Build same-source Windows"))
        bash = shutil.which("bash")
        if os.name == "nt":
            git_bash = Path(os.environ["ProgramFiles"]) / "Git/bin/bash.exe"
            if git_bash.is_file():
                bash = str(git_bash)
        if not bash:
            self.skipTest("Bash is required to execute workflow bundle naming")
        cases = (
            ("branch", "work/v0.8.0", "{slug}-{arch}-work-v0.8.0"),
            ("branch", "v0.8.0", "{slug}-{arch}-v0.8.0"),
            ("tag", "v0.8.0", "v0.8.0-{slug}-{arch}"),
            ("tag", "v0.8.0-preview.1", "v0.8.0-preview.1-{slug}-{arch}"),
            ("branch", "", "{slug}-{arch}-local"),
            ("branch", "///", "{slug}-{arch}-local"),
        )
        for slug in ("windows", "macos"):
            for arch in ("x64", "arm64"):
                for ref_type, ref_name, expected_suffix in cases:
                    with self.subTest(slug=slug, arch=arch, ref_type=ref_type, ref_name=ref_name), tempfile.TemporaryDirectory() as temporary:
                        root = Path(temporary)
                        output_file = root / "output"
                        env_file = root / "env"
                        result = subprocess.run(
                            [bash, "--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script],
                            cwd=root, capture_output=True, text=True, timeout=10,
                            env={**os.environ, "GITHUB_REF_TYPE": ref_type, "GITHUB_REF_NAME": ref_name,
                                 "BUNDLE_SLUG": slug, "BUNDLE_ARCH": arch,
                                 "GITHUB_OUTPUT": output_file.as_posix(), "GITHUB_ENV": env_file.as_posix()},
                        )
                        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                        artifact_name = "bilikara-" + expected_suffix.format(slug=slug, arch=arch)
                        self.assertEqual(output_file.read_text().splitlines(), [
                            f"archive_name={artifact_name}.zip", f"artifact_name={artifact_name}",
                        ])
                        self.assertEqual(env_file.read_text().splitlines(), [f"BUNDLE_ARCHIVE={artifact_name}.zip"])

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
        self.assertIn("Build same-source Windows FFmpeg and companion", self.bundle_workflow)
        self.assertNotIn("choco install ffmpeg", self.bundle_workflow)
        self.assertNotIn("for ($attempt", self.bundle_workflow)
        self.assertNotIn("Start-Sleep", self.bundle_workflow)
        self.assertIn("Build same-source POSIX FFmpeg and companion", self.bundle_workflow)
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
