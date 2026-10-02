"""Native packaging must work without importing the legacy Python application."""
from __future__ import annotations

from contextlib import ExitStack
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import unittest
from unittest.mock import patch


def exercise_packaging(root: Path) -> None:
    # Called in a fresh interpreter with all bilikara imports forbidden.
    import build_bundle
    from scripts import libav_bundle, native_desktop_bundle, windows_libav_preview
    from scripts.libav_manifest import MANIFEST, runtime_files

    check = unittest.TestCase()
    for system, suffix, dependency in (
        ("Windows", "pc-windows-msvc", "avcodec-63.dll"),
        ("Darwin", "apple-darwin", "libavcodec.63.dylib"),
        ("Linux", "unknown-linux-gnu", "libavcodec.so.63"),
    ):
        for arch in ("x86_64", "aarch64"):
            prefix = root / f"{arch}-{suffix}"
            vendor = prefix / "bin"
            vendor.mkdir(parents=True)
            companion = libav_bundle.COMPANIONS[system]
            names = [companion, dependency]
            for name in names:
                (vendor / name).write_bytes(b"native fixture")
            manifest = dict(schema_version=1, kind="libav", version="9.0.1",
                            target=f"{arch}-{suffix}", runtime_files=names)
            (vendor / MANIFEST).write_text(json.dumps(manifest), encoding="utf-8")
            provenance = ("source/ffmpeg-9.0.1.tar.xz", "licenses/COPYING.LGPLv2.1", "build-info.json")
            for name in provenance:
                path = prefix / name
                path.parent.mkdir(exist_ok=True)
                path.write_bytes(b"provenance fixture")

            with ExitStack() as stack:
                stack.enter_context(patch("platform.system", return_value=system))
                stack.enter_context(patch("platform.machine", return_value=arch))
                stack.enter_context(patch.dict(os.environ, {"BILIKARA_LIBAV_PREFIX": str(prefix)}, clear=True))
                check.assertEqual(libav_bundle.package_prefix(), prefix)
                check.assertEqual(runtime_files(vendor), [vendor / n for n in names])

                for name in (*provenance, f"bin/{dependency}"):
                    path = prefix / name
                    content = path.read_bytes()
                    path.unlink()
                    try:
                        with check.assertRaises(RuntimeError, msg=name):
                            libav_bundle.package_prefix()
                    finally:
                        path.write_bytes(content)
                for changes in ({"version": "8.1.2"}, {"schema_version": 2},
                                {"target": f"{'aarch64' if arch == 'x86_64' else 'x86_64'}-{suffix}"},
                                {"runtime_files": names + [dependency]},
                                {"runtime_files": names + ["../outside.dll"]}):
                    (vendor / MANIFEST).write_text(json.dumps({**manifest, **changes}), encoding="utf-8")
                    with check.assertRaises(RuntimeError, msg=str(changes)):
                        libav_bundle.package_prefix()
                (vendor / MANIFEST).write_text(json.dumps(manifest), encoding="utf-8")

                # The real staging path still validates BBDown and copies only
                # the declared native closure. Native header inspection is
                # covered by the separate real-bundle verification gate.
                source = prefix / "checkout"
                (source / "static").mkdir(parents=True)
                (source / "static/index.html").write_text("fixture", encoding="utf-8")
                executable = prefix / "bilikara-desktop-host"
                executable.write_bytes(b"host fixture")
                updater = "bilikara-updater.exe" if system == "Windows" else "bilikara-updater"
                (prefix / updater).write_bytes(b"updater fixture")
                bbdown = prefix / "BBDown"
                bbdown.write_bytes(b"tool fixture")
                stack.enter_context(patch.object(build_bundle, "ROOT_DIR", source))
                stack.enter_context(patch.object(build_bundle, "_bundle_version", return_value="v0.8.0-preview.2"))
                stack.enter_context(patch.object(build_bundle, "_resolved_bundle_binary_paths", return_value=({"BBDown": bbdown}, [])))
                stack.enter_context(patch.object(build_bundle, "_macos_aria2_metadata_args", return_value=[]))
                stack.enter_context(patch.object(build_bundle, "_validate_macos_tool_portability"))
                stack.enter_context(patch.object(libav_bundle, "binary_info", return_value={"imports": []}))
                stack.enter_context(patch.object(windows_libav_preview, "pe_info", return_value={"imports": []}))
                stack.enter_context(patch.dict(os.environ, {"BILIKARA_BBDOWN_VERSION": "1.6.3"}))
                output = prefix / "product"
                with patch.object(build_bundle, "_run_tool_command", return_value=(0, "BBDown 1.6.3")) as tool:
                    native_desktop_bundle.stage_resources(output, executable, development=False,
                                                         macos_app=system == "Darwin", prefix=prefix)
                    tool.assert_called_once_with(bbdown, "--help")
                staged = output / ("Contents/Frameworks" if system == "Darwin" else "_internal/vendor")
                check.assertEqual(runtime_files(staged), [staged / n for n in names])
                for name in names:
                    check.assertEqual((staged / name).read_bytes(), (vendor / name).read_bytes())
                with patch.object(build_bundle, "_run_tool_command", return_value=(0, "BBDown wrong-version")):
                    with check.assertRaisesRegex(RuntimeError, "does not match pinned"):
                        native_desktop_bundle.stage_resources(output, executable, development=False,
                                                             macos_app=system == "Darwin", prefix=prefix)


class NativeBuildIsolationTests(unittest.TestCase):
    def test_native_packaging_without_legacy_application_or_site_packages(self):
        root = Path(__file__).resolve().parents[1]
        script = textwrap.dedent("""
            import importlib.abc
            from pathlib import Path
            import sys

            class NoLegacyApplication(importlib.abc.MetaPathFinder):
                def find_spec(self, fullname, path=None, target=None):
                    if fullname == 'bilikara' or fullname.startswith('bilikara.'):
                        raise AssertionError('Native build imported legacy application: ' + fullname)

            sys.meta_path.insert(0, NoLegacyApplication())
            sys.path.insert(0, sys.argv[1])
            from tests.test_native_build_isolation import exercise_packaging
            exercise_packaging(Path(sys.argv[2]))
            assert not any(n == 'bilikara' or n.startswith('bilikara.') for n in sys.modules)
        """)
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run([sys.executable, "-S", "-c", script, str(root), directory],
                                    cwd=directory, capture_output=True, encoding="utf-8", timeout=60)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_legacy_import_preserves_optional_manifest_and_missing_dependency_errors(self):
        from bilikara import ffmpeg_vendor

        with tempfile.TemporaryDirectory() as directory:
            vendor = Path(directory)
            self.assertIsNone(ffmpeg_vendor.runtime_files(vendor))
            names = ["libbilikara_media_libav.so", "libavcodec.so.63"]
            (vendor / "ffmpeg-runtime.json").write_text(json.dumps(dict(
                schema_version=1, kind="libav", version="9.0.1",
                target="x86_64-unknown-linux-gnu", runtime_files=names,
            )), encoding="utf-8")
            for name in names:
                (vendor / name).write_bytes(b"native fixture")
            self.assertEqual(ffmpeg_vendor.runtime_files(vendor), [vendor / n for n in names])
            (vendor / names[1]).unlink()
            with self.assertRaisesRegex(RuntimeError, "dependency is missing"):
                ffmpeg_vendor.runtime_files(vendor)


if __name__ == "__main__":
    unittest.main()
