from __future__ import annotations

import os
import platform
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import build_bundle


class MacFinalizationTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = Path(tempfile.mkdtemp(prefix="test_mac_fin_"))
        self.app_path = self.temp_dir / "bilikara.app"
        self.contents = self.app_path / "Contents"
        self.macos = self.contents / "MacOS"
        self.macos.mkdir(parents=True, exist_ok=True)

        self.info_plist = self.contents / "Info.plist"
        self.info_plist.write_text("<plist></plist>", encoding="utf-8")

        self.executable = self.macos / "bilikara"
        self.executable.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        self.executable.chmod(0o755)

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_finalization_is_macos_only(self):
        with patch.object(platform, "system", return_value="Linux"):
            # Should do nothing and not raise
            build_bundle.finalize_macos_app_bundle(self.app_path)

    def test_missing_info_plist_fails(self):
        self.info_plist.unlink()
        with patch.object(platform, "system", return_value="Darwin"):
            with self.assertRaisesRegex(RuntimeError, "Missing Contents/Info.plist"):
                build_bundle.finalize_macos_app_bundle(self.app_path)

    def test_missing_executable_fails(self):
        self.executable.unlink()
        with patch.object(platform, "system", return_value="Darwin"):
            with self.assertRaisesRegex(RuntimeError, "Missing Contents/MacOS/bilikara"):
                build_bundle.finalize_macos_app_bundle(self.app_path)

    def test_non_executable_binary_fails(self):
        with patch.object(platform, "system", return_value="Darwin"), patch.object(
            build_bundle.os, "access", return_value=False
        ):
            with self.assertRaisesRegex(RuntimeError, "not executable"):
                build_bundle.finalize_macos_app_bundle(self.app_path)

    def test_codesign_failure_fails_build(self):
        with patch.object(platform, "system", return_value="Darwin"), patch.object(
            build_bundle, "_lint_info_plist"
        ), patch.object(
            build_bundle, "_sign_path", side_effect=RuntimeError("codesign error")
        ):
            with self.assertRaisesRegex(RuntimeError, "codesign error"):
                build_bundle.finalize_macos_app_bundle(self.app_path)

    def test_strict_verification_failure_fails_build(self):
        with patch.object(platform, "system", return_value="Darwin"), patch.object(
            build_bundle, "_lint_info_plist"
        ), patch.object(build_bundle, "_sign_path"), patch.object(
            build_bundle, "_verify_codesign", return_value=False
        ), patch.object(
            build_bundle, "_sign_nested_macho_objects"
        ):
            with self.assertRaisesRegex(RuntimeError, "Strict codesign verification failed"):
                build_bundle.finalize_macos_app_bundle(self.app_path)

    def test_nested_code_is_signed_before_outer_bundle_exactly_once(self):
        calls = []

        with patch.object(platform, "system", return_value="Darwin"), patch.object(
            build_bundle, "_lint_info_plist"
        ), patch.object(
            build_bundle,
            "_sign_nested_macho_objects",
            side_effect=lambda path: calls.append(("nested", path)),
        ) as sign_nested, patch.object(
            build_bundle,
            "_sign_path",
            side_effect=lambda path: calls.append(("outer", path)),
        ) as sign_outer, patch.object(
            build_bundle, "_verify_codesign", return_value=True
        ), patch.object(
            build_bundle, "_show_codesign_details"
        ):
            build_bundle.finalize_macos_app_bundle(self.app_path)

        self.assertEqual(calls, [("nested", self.app_path), ("outer", self.app_path)])
        sign_nested.assert_called_once_with(self.app_path)
        sign_outer.assert_called_once_with(self.app_path)


if __name__ == "__main__":
    unittest.main()
