import hashlib
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

import build_bundle


class BuildBundleTest(unittest.TestCase):
    def test_rust_library_args_includes_release_library(self):
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            library = root / "rust" / "target" / "release" / "libbilikara_rust.so"
            library.parent.mkdir(parents=True)
            library.touch()

            with patch("build_bundle.ROOT_DIR", root), patch(
                "build_bundle.platform.system", return_value="Linux"
            ):
                args = build_bundle._rust_library_args(":")

        self.assertEqual(args, ["--add-binary", f"{library.resolve()}:rust"])

    def test_rust_library_args_allows_missing_library(self):
        with TemporaryDirectory() as temp_dir, patch("build_bundle.ROOT_DIR", Path(temp_dir)), patch(
            "build_bundle.platform.system", return_value="Linux"
        ), patch.dict("build_bundle.os.environ", {}, clear=True):
            self.assertEqual(build_bundle._rust_library_args(":"), [])

    def test_rust_library_args_rejects_missing_library_in_strict_mode(self):
        with TemporaryDirectory() as temp_dir, patch("build_bundle.ROOT_DIR", Path(temp_dir)), patch(
            "build_bundle.platform.system", return_value="Linux"
        ), patch.dict("build_bundle.os.environ", {build_bundle.RUST_STRICT_ENV: "1"}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "Rust library not found"):
                build_bundle._rust_library_args(":")

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

        with patch("build_bundle.platform.system", return_value="Linux"), patch(
            "build_bundle._resolve_bundle_binary_path", side_effect=fake_resolve
        ):
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
            "build_bundle._run_tool_version",
            return_value=(0, "configuration: --enable-nonfree\n"),
        ):
            with self.assertRaisesRegex(RuntimeError, "enable-nonfree"):
                build_bundle._bundled_binary_args(":", validate=True)

    def test_bundled_binary_args_requires_ffprobe_for_macos(self):
        ffmpeg = Path("/usr/bin/ffmpeg")

        def fake_resolve(binary_name: str):
            return ffmpeg if binary_name == "ffmpeg" else None

        with patch("build_bundle.platform.system", return_value="Darwin"), patch(
            "build_bundle._resolve_bundle_binary_path", side_effect=fake_resolve
        ):
            with self.assertRaisesRegex(RuntimeError, "ffprobe"):
                build_bundle._bundled_binary_args(":")

    def test_release_validation_rejects_tool_that_does_not_execute(self):
        ffmpeg = Path("/tools/ffmpeg")
        with patch(
            "build_bundle._run_tool_version",
            return_value=(1, "dyld: Library not loaded: @rpath/libavdevice.62.dylib\n"),
        ):
            with self.assertRaisesRegex(RuntimeError, "release build execution check"):
                build_bundle._validate_ffmpeg_redistribution_metadata({"ffmpeg": ffmpeg})

    def test_macos_portability_rejects_homebrew_and_rpath_dependencies(self):
        ffmpeg = Path("/tools/ffmpeg")
        for dependency in (
            "/opt/homebrew/Cellar/ffmpeg/8.1.2/lib/libavdevice.62.dylib",
            "/usr/local/Cellar/ffmpeg/8.1.2/lib/libavdevice.62.dylib",
            "@rpath/libavdevice.62.dylib",
        ):
            with self.subTest(dependency=dependency), patch(
                "build_bundle._macos_dynamic_dependencies", return_value=[dependency]
            ):
                with self.assertRaisesRegex(RuntimeError, "non-portable dynamic dependencies"):
                    build_bundle._validate_macos_tool_portability(ffmpeg)

    def test_macos_portability_allows_only_system_dependencies(self):
        ffmpeg = Path("/tools/ffmpeg")
        with patch(
            "build_bundle._macos_dynamic_dependencies",
            return_value=[
                "/usr/lib/libSystem.B.dylib",
                "/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation",
            ],
        ):
            build_bundle._validate_macos_tool_portability(ffmpeg)

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
            source_archive = root_dir / "tools" / "ffmpeg-8.1.2.tar.xz"
            source_archive.write_bytes(b"official source archive")
            license_file = root_dir / "tools" / "COPYING.LGPLv2.1"
            license_file.write_text("LGPL text\n", encoding="utf-8")
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
            ), patch.dict(
                build_bundle.os.environ,
                {
                    "BILIKARA_FFMPEG_SOURCE_VERSION": "8.1.2",
                    "BILIKARA_FFMPEG_SOURCE_URL": "https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz",
                    "BILIKARA_FFMPEG_SOURCE_SHA256": hashlib.sha256(source_archive.read_bytes()).hexdigest(),
                    "BILIKARA_FFMPEG_SOURCE_ARCHIVE": str(source_archive),
                    "BILIKARA_FFMPEG_LICENSE_FILE": str(license_file),
                },
                clear=False,
            ):
                build_bundle._write_release_compliance_files()

            self.assertTrue((dist_dir / "LICENSE").exists())
            self.assertTrue((dist_dir / "LEGAL.md").exists())
            self.assertTrue((dist_dir / "THIRD_PARTY_NOTICES.md").exists())
            licenses_dir = dist_dir / "THIRD_PARTY_LICENSES"
            self.assertIn("FFmpeg / FFprobe redistribution notes", (licenses_dir / "ffmpeg-source.txt").read_text(encoding="utf-8"))
            self.assertEqual((licenses_dir / "ffmpeg-version.txt").read_text(encoding="utf-8"), "tool version\n")
            self.assertEqual((licenses_dir / "ffprobe-version.txt").read_text(encoding="utf-8"), "tool version\n")
            self.assertEqual(
                (licenses_dir / "FFmpeg-COPYING.LGPLv2.1.txt").read_text(encoding="utf-8"),
                "LGPL text\n",
            )
            self.assertEqual(
                (dist_dir / "THIRD_PARTY_SOURCES" / source_archive.name).read_bytes(),
                source_archive.read_bytes(),
            )

    def test_macos_aria2_metadata_is_validated_and_bundled_as_data(self):
        with TemporaryDirectory() as temp_dir:
            metadata = Path(temp_dir) / "aria2.json"
            metadata.write_text(
                '{"schema_version":1,"tool":"aria2c","provider":"bilikara-r2",'
                '"platform":"darwin","arch":"arm64","sha256":"' + "a" * 64
                + '","url":"https://download.example/aria2.tar.gz"}',
                encoding="utf-8",
            )
            with patch("build_bundle.platform.system", return_value="Darwin"), patch(
                "build_bundle.platform.machine", return_value="arm64"
            ), patch.dict(
                build_bundle.os.environ,
                {build_bundle.ARIA2_MACOS_METADATA_ENV: str(metadata)},
                clear=False,
            ):
                args = build_bundle._macos_aria2_metadata_args(":")

        self.assertEqual(
            args,
            ["--add-data", f"{metadata.resolve()}:vendor/aria2-macos.json"],
        )

    def test_macos_aria2_metadata_rejects_wrong_architecture(self):
        with TemporaryDirectory() as temp_dir:
            metadata = Path(temp_dir) / "aria2.json"
            metadata.write_text(
                '{"schema_version":1,"tool":"aria2c","provider":"bilikara-r2",'
                '"platform":"darwin","arch":"x64","sha256":"' + "a" * 64
                + '","url":"https://download.example/aria2.tar.gz"}',
                encoding="utf-8",
            )
            with patch("build_bundle.platform.system", return_value="Darwin"), patch(
                "build_bundle.platform.machine", return_value="arm64"
            ), patch.dict(
                build_bundle.os.environ,
                {build_bundle.ARIA2_MACOS_METADATA_ENV: str(metadata)},
                clear=False,
            ):
                with self.assertRaisesRegex(RuntimeError, "bundle target is arm64"):
                    build_bundle._macos_aria2_metadata_args(":")

    def test_python_https_args_includes_hidden_imports(self):
        with patch("build_bundle.platform.system", return_value="Linux"):
            args = build_bundle._python_https_args(":")

        for module_name in build_bundle.PYTHON_HTTPS_HIDDEN_IMPORTS:
            self.assertIn("--hidden-import", args)
            self.assertIn(module_name, args)

    def test_python_https_args_includes_macos_truststore_backend(self):
        with patch("build_bundle.platform.system", return_value="Darwin"):
            args = build_bundle._python_https_args(":")

        self.assertIn("truststore", args)
        self.assertIn("truststore._macos", args)
        self.assertNotIn("truststore._windows", args)

    def test_python_https_binary_paths_collects_windows_openssl_dlls(self):
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            bin_dir = root / "Library" / "bin"
            bin_dir.mkdir(parents=True)
            ssl_dll = bin_dir / "libssl-3-x64.dll"
            crypto_dll = bin_dir / "libcrypto-3-x64.dll"
            ignored_pdb = bin_dir / "libssl-3-x64.pdb"
            ssl_dll.write_text("", encoding="utf-8")
            crypto_dll.write_text("", encoding="utf-8")
            ignored_pdb.write_text("", encoding="utf-8")

            with patch("build_bundle.platform.system", return_value="Windows"), patch.object(
                build_bundle.sys,
                "prefix",
                str(root),
            ), patch.object(build_bundle.sys, "base_prefix", str(root)), patch.object(
                build_bundle.sys,
                "exec_prefix",
                str(root),
            ), patch.object(build_bundle.sys, "base_exec_prefix", str(root)):
                paths = build_bundle._python_https_binary_paths()

        self.assertEqual({path.name for path in paths}, {"libssl-3-x64.dll", "libcrypto-3-x64.dll"})


if __name__ == "__main__":
    unittest.main()
