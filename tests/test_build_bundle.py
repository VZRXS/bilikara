import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
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

    def test_resolve_ffprobe_from_ffmpeg_sibling_when_not_on_path(self):
        ffmpeg = Path("/tools/ffmpeg")
        ffprobe = Path("/tools/ffprobe")

        def fake_which(binary_name: str):
            return str(ffmpeg) if binary_name == "ffmpeg" else None

        with patch("build_bundle.platform.system", return_value="Linux"), patch(
            "build_bundle.shutil.which",
            side_effect=fake_which,
        ), patch.object(
            Path,
            "exists",
            lambda self: self == ffprobe,
        ):
            resolved = build_bundle._resolve_bundle_binary_path("ffprobe")

        self.assertEqual(resolved, ffprobe)

    def test_bundled_binary_args_allows_missing_optional_ffprobe(self):
        ffmpeg = Path("/usr/bin/ffmpeg")
        data_separator = ";" if build_bundle.platform.system() == "Windows" else ":"

        def fake_resolve(binary_name: str):
            return ffmpeg if binary_name == "ffmpeg" else None

        with patch("build_bundle._resolve_bundle_binary_path", side_effect=fake_resolve):
            args = build_bundle._bundled_binary_args(data_separator)

        self.assertEqual(args, ["--add-binary", f"{ffmpeg.resolve()}{data_separator}vendor"])

    def test_bundled_binary_args_includes_resolved_optional_ffprobe(self):
        ffmpeg = Path("/usr/bin/ffmpeg")
        ffprobe = Path("/usr/bin/ffprobe")
        data_separator = ";" if build_bundle.platform.system() == "Windows" else ":"

        def fake_resolve(binary_name: str):
            return {"ffmpeg": ffmpeg, "ffprobe": ffprobe}.get(binary_name)

        with patch("build_bundle._resolve_bundle_binary_path", side_effect=fake_resolve):
            args = build_bundle._bundled_binary_args(data_separator)

        self.assertEqual(
            args,
            [
                "--add-binary",
                f"{ffmpeg.resolve()}{data_separator}vendor",
                "--add-binary",
                f"{ffprobe.resolve()}{data_separator}vendor",
            ],
        )

    def test_bundled_binary_args_rejects_nonfree_ffmpeg_when_validating(self):
        ffmpeg = Path("/usr/bin/ffmpeg")

        with patch("build_bundle._resolve_bundle_binary_path", return_value=ffmpeg), patch(
            "build_bundle._tool_version_output",
            return_value="configuration: --enable-nonfree\n",
        ):
            with self.assertRaisesRegex(RuntimeError, "enable-nonfree"):
                build_bundle._bundled_binary_args(":", validate=True)

    def test_write_release_compliance_files_copies_notices_and_tool_versions(self):
        with TemporaryDirectory() as temp_dir:
            root_dir = Path(temp_dir)
            dist_dir = root_dir / "dist" / build_bundle.APP_NAME
            dist_dir.mkdir(parents=True)
            ffmpeg = root_dir / "tools" / "ffmpeg"
            ffprobe = root_dir / "tools" / "ffprobe"
            ffmpeg.parent.mkdir()
            ffmpeg.write_bytes(b"ffmpeg-bin")
            ffprobe.write_bytes(b"ffprobe-bin")
            for document_name in build_bundle.LEGAL_DOCUMENTS:
                (root_dir / document_name).write_text(f"{document_name}\n", encoding="utf-8")

            with patch("build_bundle.ROOT_DIR", root_dir), patch(
                "build_bundle.platform.system",
                return_value="Linux",
            ), patch(
                "build_bundle._resolved_bundle_binary_paths",
                return_value=({"ffmpeg": ffmpeg, "ffprobe": ffprobe}, []),
            ), patch(
                "build_bundle.subprocess.run",
                return_value=SimpleNamespace(returncode=0, stdout="tool version\n", stderr=""),
            ):
                build_bundle._write_release_compliance_files()

            self.assertTrue((dist_dir / "LICENSE").exists())
            self.assertTrue((dist_dir / "LEGAL.md").exists())
            self.assertTrue((dist_dir / "THIRD_PARTY_NOTICES.md").exists())
            licenses_dir = dist_dir / "THIRD_PARTY_LICENSES"
            self.assertIn("FFmpeg / FFprobe redistribution notes", (licenses_dir / "ffmpeg-source.txt").read_text(encoding="utf-8"))
            self.assertEqual((licenses_dir / "ffmpeg-version.txt").read_text(encoding="utf-8"), "tool version\n")
            self.assertEqual((licenses_dir / "ffprobe-version.txt").read_text(encoding="utf-8"), "tool version\n")


if __name__ == "__main__":
    unittest.main()
