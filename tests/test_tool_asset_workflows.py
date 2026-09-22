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

    @unittest.skipIf(os.name == "nt", "Requires POSIX executable permissions and bundle symlinks")
    def test_macos_tool_gate_executes_resource_symlink_and_rejects_missing_tool(self):
        block = self.bundle_workflow.split(
            "      - name: Verify native backend and bundled tools on macOS\n", 1
        )[1].split("      - name:", 1)[0]
        script = textwrap.dedent(block.split("run: |\n", 1)[1])
        with tempfile.TemporaryDirectory(prefix="macos bundle gate ") as temporary:
            root = Path(temporary)
            contents = root / "dist/bilikara.app/Contents"
            for directory in ("MacOS", "Frameworks", "Resources/vendor"):
                (contents / directory).mkdir(parents=True)
            backend = contents / "MacOS/bilikara-desktop-host"
            backend.write_text("#!/bin/sh\nexit 0\n")
            backend.chmod(0o755)
            (contents / "Resources/native-desktop.json").write_text("{}")
            tool = contents / "Frameworks/BBDown"
            tool.write_text('#!/bin/sh\nprintf "%s\\n" "$*" > calls.log\n')
            tool.chmod(0o755)
            (contents / "Resources/vendor/BBDown").symlink_to("../../Frameworks/BBDown")

            def run_gate():
                return subprocess.run(["bash", "-e", "-c", script], cwd=root,
                                      capture_output=True, text=True, timeout=10)

            result = run_gate()
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual((root / "calls.log").read_text(), "--help\n")
            tool.chmod(0o644)
            self.assertNotEqual(run_gate().returncode, 0)
            tool.unlink()
            self.assertNotEqual(run_gate().returncode, 0)

    def test_test_and_bundle_do_not_compete_for_an_immutable_rust_cache(self):
        test_job = self.bundle_workflow.split("\n  test:\n", 1)[1].split("\n  bundle:\n", 1)[0]
        bundle_job = self.bundle_workflow.split("\n  bundle:\n", 1)[1].split("\n  android-bundle:\n", 1)[0]
        def cache_namespace(job):
            return job.split("shared-key:", 1)[1].splitlines()[0].strip()
        self.assertNotEqual(cache_namespace(test_job), cache_namespace(bundle_job))
        # Only CI test debug information is reduced; optimized product builds
        # and their assertions keep the repository's release profile.
        self.assertIn('CARGO_PROFILE_DEV_DEBUG: "line-tables-only"', test_job)
        self.assertNotIn("CARGO_PROFILE_RELEASE_", self.bundle_workflow)

    def test_media_drivers_and_packaged_backend_share_runtime_features(self):
        backend = (ROOT / "scripts/native_desktop_bundle.py").read_text(encoding="utf-8")
        self.assertIn('"--features", "native-host"', backend)
        for filename in ("build-posix.sh", "prepare-windows.ps1"):
            script = (ROOT / "media-libav" / filename).read_text(encoding="utf-8")
            builds = [line for line in script.splitlines()
                      if "cargo " in line and "rust-runtime/Cargo.toml" in line]
            self.assertEqual(len(builds), 2, filename)
            for command in builds:
                self.assertIn("--features native-host", command, filename)
                self.assertIn("--release", command)
                self.assertIn("--locked", command)

    @unittest.skipIf(os.name == "nt", "Exercises the Linux-only prerequisite step")
    def test_linux_media_prerequisite_builds_only_the_consumed_companion_and_fails_closed(self):
        block = self.bundle_workflow.split(
            "      - name: Build libav prerequisite for packaged media tests\n", 1
        )[1].split("      - name:", 1)[0]
        script = textwrap.dedent(block.split("run: |\n", 1)[1])
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            env = {**os.environ, "BILIKARA_LIBAV_PREFIX": str(root / "prefix"),
                   "GITHUB_ENV": str(root / "environment"), "FAIL_AT": ""}
            stub = '''bash() {
  printf 'bash:%s\\n' "$*" >> calls.log
  test "$FAIL_AT" != libraries
}
python() {
  printf 'python:%s\\n' "$*" >> calls.log
  test "$FAIL_AT" != companion
}
'''
            expected = ["bash:media-libav/build-posix-libraries.sh",
                        f"python:media-libav/build.py --prefix {root / 'prefix'} --out {root / 'prefix/bin'} --test"]
            for failure in ("", "libraries", "companion"):
                with self.subTest(failure=failure):
                    (root / "calls.log").unlink(missing_ok=True)
                    (root / "environment").unlink(missing_ok=True)
                    result = subprocess.run(["bash", "-e", "-c", stub + script], cwd=root,
                                            env={**env, "FAIL_AT": failure}, capture_output=True, text=True, timeout=10)
                    self.assertEqual((root / "calls.log").read_text().splitlines(),
                                     expected[:1] if failure == "libraries" else expected)
                    if failure:
                        self.assertNotEqual(result.returncode, 0)
                        self.assertFalse((root / "environment").exists())
                    else:
                        self.assertEqual(result.returncode, 0, result.stderr)
                        self.assertEqual((root / "environment").read_text().strip(),
                                         f"BILIKARA_TEST_LIBAV_COMPANION={root / 'prefix/bin/libbilikara_media_libav.so'}")

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
        for test_only_operation in (
            "--tool-smoke",
            "& './libav-smoke.ps1'",
            "BILIKARA_REQUIRE_BACKEND_SMOKE",
            "BILIKARA_REQUIRE_TAURI_SMOKE",
        ):
            self.assertNotIn(test_only_operation, bundle_job)

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
        self.assertNotIn("Upload native libav diagnostics", self.bundle_workflow)
        self.assertNotIn("diagnostics-${{ steps.bundle-name.outputs.artifact_name }}", self.bundle_workflow)
        self.assertNotIn("dist/libav-build-records", self.bundle_workflow)
        self.assertLess(self.bundle_workflow.index("Resolve bundle archive name"),
                        self.bundle_workflow.index("Build Windows libav"))
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

    def test_normal_bundle_embeds_required_media_tools(self):
        self.assertIn("Build Windows libav libraries and companion", self.bundle_workflow)
        self.assertNotIn("choco install ffmpeg", self.bundle_workflow)
        for script in ("build-windows.sh", "build-posix.sh"):
            recipe = script.replace(".sh", "-libraries.sh")
            self.assertIn(f'/{recipe}"', (ROOT / "media-libav" / script).read_text())
            self.assertIn("--disable-programs", (ROOT / "media-libav" / recipe).read_text())
        self.assertIn("check_native_desktop_bundle.py", self.bundle_workflow)
        self.assertNotIn("ilammy/msvc-dev-cmd", self.bundle_workflow)
        self.assertNotIn("for ($attempt", self.bundle_workflow)
        self.assertNotIn("Start-Sleep", self.bundle_workflow)
        self.assertIn("Build POSIX libav libraries and companion", self.bundle_workflow)
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
        self.assertNotIn("Verify clean BBDown runtime restore on Windows", self.bundle_workflow)
        self.assertIn("Locked aria2c metadata-only checks", self.bundle_workflow)
        self.assertNotIn("BILIKARA_REQUIRE_ARIA2_TOOL_SMOKE=1", self.bundle_workflow)
        self.assertNotIn("Packaged portable FFmpeg checks", self.bundle_workflow)
        self.assertNotIn("Running extracted portable FFmpeg checks", self.bundle_workflow)
        for tool in ("BBDown", "bilikara_media_libav.dll"):
            self.assertIn(tool, self.bundle_workflow)
        self.assertIn("bilikara-desktop-host.exe", self.bundle_workflow)
        self.assertIn("native-desktop.json", self.bundle_workflow)

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
