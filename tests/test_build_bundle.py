import unittest
from pathlib import Path
from unittest.mock import patch

import build_bundle


class BuildBundleTest(unittest.TestCase):
    def test_resolve_windows_binary_prefers_chocolatey_real_executable(self):
        shim = Path("/ProgramData/chocolatey/bin/ffmpeg.exe")
        real = Path("/ProgramData/chocolatey/lib/ffmpeg/tools/ffmpeg/bin/ffmpeg.exe")

        with patch("build_bundle.platform.system", return_value="Windows"), patch.object(
            Path,
            "exists",
            lambda self: self == real,
        ):
            resolved = build_bundle._resolve_windows_binary("ffmpeg", shim)

        self.assertEqual(resolved, real)

    def test_resolve_windows_binary_finds_chocolatey_ffprobe_in_ffmpeg_package(self):
        shim = Path("/ProgramData/chocolatey/bin/ffprobe.exe")
        real = Path("/ProgramData/chocolatey/lib/ffmpeg/tools/ffmpeg/bin/ffprobe.exe")

        with patch("build_bundle.platform.system", return_value="Windows"), patch.object(
            Path,
            "exists",
            lambda self: self == real,
        ):
            resolved = build_bundle._resolve_windows_binary("ffprobe", shim)

        self.assertEqual(resolved, real)

    def test_resolve_windows_binary_rejects_unresolved_chocolatey_shim(self):
        shim = Path("/ProgramData/chocolatey/bin/ffprobe.exe")

        with patch("build_bundle.platform.system", return_value="Windows"), patch.object(
            Path,
            "exists",
            lambda self: False,
        ):
            resolved = build_bundle._resolve_windows_binary("ffprobe", shim)

        self.assertIsNone(resolved)

    def test_resolve_bundle_binary_path_rejects_unresolved_windows_shim(self):
        shim = Path("/ProgramData/chocolatey/bin/ffprobe.exe")

        with patch("build_bundle.platform.system", return_value="Windows"), patch(
            "build_bundle.shutil.which",
            return_value=str(shim),
        ), patch.object(
            Path,
            "exists",
            lambda self: False,
        ):
            resolved = build_bundle._resolve_bundle_binary_path("ffprobe")

        self.assertIsNone(resolved)


if __name__ == "__main__":
    unittest.main()
