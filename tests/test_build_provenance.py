from __future__ import annotations

import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import build_bundle


class BuildProvenanceTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.git("init", "-q", "-b", "work/v0.8.0")
        (self.root / "package.json").write_text('{"version":"0.8.0"}\n', encoding="utf-8")
        self.git("add", "package.json")
        self.git("-c", "user.name=Build test", "-c", "user.email=build@example.invalid",
                 "-c", "commit.gpgsign=false", "commit", "-qm", "fixture")
        self.commit = self.git("rev-parse", "HEAD")
        environment = {key: "" for key in ("BILIKARA_VERSION", "GITHUB_REF_TYPE",
                       "GITHUB_REF_NAME", "GITHUB_HEAD_REF", "GITHUB_SHA")}
        for context in (patch.object(build_bundle, "ROOT_DIR", self.root),
                        patch.dict(os.environ, environment)):
            context.start()
            self.addCleanup(context.stop)

    def git(self, *arguments):
        return subprocess.check_output(["git", *arguments], cwd=self.root,
                                       encoding="utf-8", stderr=subprocess.PIPE).strip()

    def test_local_branches_keep_commit_identity_even_at_a_release_tag(self):
        self.git("tag", "v0.8.0")
        self.assertEqual(build_bundle._bundle_version(), f"work/v0.8.0-g{self.commit[:12]}")
        self.git("checkout", "-qb", "dev")
        self.assertEqual(build_bundle._bundle_version(), f"dev-g{self.commit[:12]}")

    def test_clean_detached_release_and_preview_tags_keep_their_versions(self):
        for tag in ("v0.8.0", "v0.8.0-preview.1"):
            with self.subTest(tag=tag):
                self.git("tag", tag)
                self.git("checkout", "-q", "--detach", tag)
                with patch.dict(os.environ, {"GITHUB_REF_TYPE": "tag", "GITHUB_REF_NAME": tag}):
                    self.assertEqual(build_bundle._bundle_version(), tag)
                self.git("tag", "-d", tag)
        self.git("tag", "v0.8.0")
        self.assertEqual(build_bundle._bundle_version(), "v0.8.0")

    def test_dirty_tag_and_untracked_files_are_development_builds(self):
        self.git("tag", "v0.8.0")
        self.git("checkout", "-q", "--detach", "v0.8.0")
        extra = self.root / "new.txt"
        extra.write_text("uncommitted", encoding="utf-8")
        expected = f"v0.8.0-g{self.commit[:12]}-dirty"
        self.assertEqual(build_bundle._bundle_version(), expected)
        extra.unlink()
        (self.root / "package.json").write_text('{"version":"0.8.1"}\n', encoding="utf-8")
        with patch.dict(os.environ, {"GITHUB_REF_TYPE": "tag", "GITHUB_REF_NAME": "v0.8.0"}):
            self.assertEqual(build_bundle._bundle_version(), expected)
        self.git("add", "package.json")
        self.assertEqual(build_bundle._bundle_version(), expected)

    def test_ci_branch_detached_head_does_not_masquerade_as_tag(self):
        self.git("tag", "v0.8.0")
        self.git("checkout", "-q", "--detach", "HEAD")
        with patch.dict(os.environ, {"GITHUB_REF_TYPE": "branch", "GITHUB_REF_NAME": "work/v0.8.0"}):
            self.assertEqual(build_bundle._bundle_version(), f"work/v0.8.0-g{self.commit[:12]}")
        with patch.dict(os.environ, {"GITHUB_REF_TYPE": "tag", "GITHUB_REF_NAME": "v9.9.9"}):
            self.assertEqual(build_bundle._bundle_version(), f"v9.9.9-g{self.commit[:12]}")

    def test_missing_git_does_not_fall_back_to_numeric_package_version(self):
        with patch.object(build_bundle, "_build_git_output", return_value=None):
            self.assertEqual(build_bundle._bundle_version(), "dev-gunknown")
            with patch.dict(os.environ, {"BILIKARA_VERSION": "v0.8.0"}):
                self.assertEqual(build_bundle._bundle_version(), "v0.8.0")

    def test_development_label_is_bounded_and_resource_version_stays_numeric(self):
        with patch.dict(os.environ, {"GITHUB_REF_TYPE": "branch", "GITHUB_REF_NAME": "work/" + "x" * 100}):
            label = build_bundle._bundle_version()
            self.assertEqual(len(label), 80)
            self.assertTrue(label.endswith(f"-g{self.commit[:12]}"))
        for label in ("dev-gab1234567890", "work/v0.8.0-g123456abcdef-dirty"):
            self.assertEqual(build_bundle._windows_version_tuple(label), (0, 8, 0, 0))
        self.assertEqual(build_bundle._windows_version_tuple("v0.8.0-preview.12"), (0, 8, 0, 12))


if __name__ == "__main__":
    unittest.main()
