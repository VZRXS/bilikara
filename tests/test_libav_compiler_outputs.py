"""MSVC's implicit import-library outputs must not dirty the source checkout."""
import importlib.util
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch


class LibavCompilerOutputTests(unittest.TestCase):
    def test_windows_compiler_side_effects_stay_in_the_requested_output_directory(self):
        source = Path(__file__).resolve().parents[1] / "media-libav/build.py"
        spec = importlib.util.spec_from_file_location("companion_build", source)
        builder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(builder)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            checkout, prefix, output = root / "checkout", root / "prefix", root / "产物"
            checkout.mkdir()
            (prefix / "bin").mkdir(parents=True)
            for name, version in (("avutil", 61), ("avcodec", 63), ("avformat", 63)):
                (prefix / "bin" / f"{name}-{version}.dll").write_bytes(b"fixture")
            libraries = SimpleNamespace(
                avutil_version=Mock(return_value=3998053),
                avcodec_version=Mock(return_value=4129125),
                avformat_version=Mock(return_value=4129125),
                av_version_info=Mock(return_value=b"9.0.1"),
                avformat_configuration=Mock(return_value=b"--disable-network --enable-shared"),
            )
            invocations = []

            def compiler(command, **kwargs):
                working = Path(kwargs.get("cwd", checkout))
                invocations.append(working)
                if command[0] == "cl.exe":
                    stem = Path(next(arg for arg in command if arg.endswith(".c"))).stem
                    for suffix in (".lib", ".exp"):
                        (working / (stem + suffix)).write_bytes(b"implicit MSVC output")
                return subprocess.CompletedProcess(command, 0)

            with patch.object(builder.sys, "platform", "win32"), \
                    patch.object(builder.sys, "argv", [str(source), "--prefix", str(prefix), "--out", str(output), "--test"]), \
                    patch.object(builder.os, "add_dll_directory", return_value=Mock(), create=True), \
                    patch.object(builder.ctypes, "CDLL", return_value=libraries), \
                    patch.object(builder.subprocess, "run", side_effect=compiler):
                builder.main()
            self.assertEqual(list(checkout.iterdir()), [])
            self.assertEqual(invocations, [output] * 4)
            self.assertTrue((output / "probe.lib").is_file())
            self.assertTrue((output / "test_shim.exp").is_file())


if __name__ == "__main__":
    unittest.main()
