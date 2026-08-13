from __future__ import annotations

import unittest
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

from scripts import prepare_bbdown_vendor


class PrepareBBDownVendorTest(unittest.TestCase):
    def test_release_asset_and_sha_are_pinned_for_every_bundle_target(self):
        expected = {
            ("windows", "x64"): (
                "BBDown_1.6.3_20240814_win-x64.zip",
                "40f1e2af0d4e74df765c6f93d2e931f9bea201d5168d0bc62dc35a54b7e0ec02",
            ),
            ("windows", "arm64"): (
                "BBDown_1.6.3_20240814_win-arm64.zip",
                "da8fc9cbf1031f4c4ca97af82d98bbfd1bbc55bd8ea49602da8d3d1613c190ff",
            ),
            ("macos", "x64"): (
                "BBDown_1.6.3_20240814_osx-x64.zip",
                "262c15ca7890898560d00e5ffd5ada1864fbd9d0d58ac4ee492c9f3e73f3ae5f",
            ),
            ("macos", "arm64"): (
                "BBDown_1.6.3_20240814_osx-arm64.zip",
                "4df84014d818bd6dff2b365b847645340e8955c4450fe965688f41af89a38baa",
            ),
        }
        self.assertEqual(prepare_bbdown_vendor.BBDOWN_ASSETS, expected)
        self.assertEqual(prepare_bbdown_vendor.BBDOWN_VERSION, "1.6.3")
        self.assertEqual(
            prepare_bbdown_vendor.BBDOWN_RELEASE_COMMIT,
            "45622f79cd766e0fc6f5cbd49fcf4960340f35c3",
        )

    def test_target_aliases_select_expected_matrix_keys(self):
        self.assertEqual(prepare_bbdown_vendor._normalized_platform("Darwin"), "macos")
        self.assertEqual(prepare_bbdown_vendor._normalized_platform("Windows"), "windows")
        self.assertEqual(prepare_bbdown_vendor._normalized_arch("AMD64"), "x64")
        self.assertEqual(prepare_bbdown_vendor._normalized_arch("aarch64"), "arm64")

    def test_version_validation_uses_supported_help_command(self):
        binary = Path("BBDown.exe")
        with patch(
            "scripts.prepare_bbdown_vendor.subprocess.run",
            return_value=SimpleNamespace(
                returncode=0,
                stdout="BBDown version 1.6.3, Bilibili Downloader.\n",
                stderr="",
            ),
        ) as run_mock:
            self.assertEqual(prepare_bbdown_vendor._validated_version(binary), "1.6.3")
        self.assertEqual(run_mock.call_args.args[0], [str(binary), "--help"])

    def test_archive_extraction_rejects_traversal_and_preserves_binary_bytes(self):
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            valid_archive = root / "valid.zip"
            target = root / "BBDown"
            with zipfile.ZipFile(valid_archive, "w") as bundle:
                bundle.writestr("release/BBDown", b"bbdown")
            prepare_bbdown_vendor._extract_binary(valid_archive, target)
            self.assertEqual(target.read_bytes(), b"bbdown")

            unsafe_archive = root / "unsafe.zip"
            with zipfile.ZipFile(unsafe_archive, "w") as bundle:
                bundle.writestr("../BBDown", b"unsafe")
            with self.assertRaisesRegex(RuntimeError, "exactly one"):
                prepare_bbdown_vendor._extract_binary(unsafe_archive, target)


if __name__ == "__main__":
    unittest.main()
