from pathlib import Path
import os
import shutil
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch
from scripts.libav_cache import cache_key, snapshot, restore


class LibavCacheTest(unittest.TestCase):
    def test_driver_and_other_platform_changes_keep_c_cache_key(self):
        repository = Path(__file__).resolve().parents[1]
        for system in ("Windows", "Darwin", "Linux"):
            with self.subTest(system=system), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / "media-libav").mkdir()
                (root / "scripts").mkdir()
                for script in (repository / "media-libav").glob("build-*.sh"):
                    shutil.copy2(script, root / "media-libav" / script.name)
                shutil.copy2(repository / "scripts/libav_cache.py", root / "scripts/libav_cache.py")
                with patch("scripts.libav_cache.__file__", str(root / "scripts/libav_cache.py")), \
                     patch("scripts.libav_cache.platform.system", return_value=system), \
                     patch("scripts.libav_cache.platform.machine", return_value="arm64"), \
                     patch("scripts.libav_cache.subprocess.run", return_value=SimpleNamespace(stdout="compiler", stderr="")), \
                     patch.dict(os.environ, {"BILIKARA_LIBAV_PREFIX": "/private/prefix"}, clear=True):
                    expected = cache_key()
                    # Companion/Rust orchestration changes must not rebuild C libraries.
                    for name in ("build-posix.sh", "build-windows.sh"):
                        script = root / "media-libav" / name
                        script.write_text(script.read_text() + "\n# Changed Rust driver invocation\n")
                    self.assertEqual(cache_key(), expected)
                    other = "posix" if system == "Windows" else "windows"
                    script = root / "media-libav" / f"build-{other}-libraries.sh"
                    script.write_text("# unrelated platform recipe changed\n")
                    self.assertEqual(cache_key(), expected)
                    # Runner image rollouts must not invalidate unchanged tools.
                    for image_version in ("20260907.229.1", "20260922.246.2"):
                        with patch.dict(os.environ, {"ImageVersion": image_version}):
                            self.assertEqual(cache_key(), expected, image_version)
                    # Actual C inputs and cache verification still invalidate it.
                    selected = "windows" if system == "Windows" else "posix"
                    recipe = root / "media-libav" / f"build-{selected}-libraries.sh"
                    original_bytes = recipe.read_bytes()
                    original = recipe.read_text()
                    for before, after in (
                        ("version=9.0.1", "version=9.0.2"),
                        ("--disable-network", "--enable-network"),
                        ("FCF986EA15E6E293A5644F10B4322F04D67658D8", "0" * 40),
                    ):
                        self.assertIn(before, original)
                        recipe.write_text(original.replace(before, after))
                        self.assertNotEqual(cache_key(), expected)
                    recipe.write_bytes(original_bytes)
                    self.assertEqual(cache_key(), expected)
                    for key in ("CFLAGS", "WindowsSDKVersion", "VCToolsVersion", "SDKROOT",
                                "ImageOS", "BILIKARA_LIBAV_PREFIX"):
                        with patch.dict(os.environ, {key: "changed"}):
                            self.assertNotEqual(cache_key(), expected, key)
                    with patch("scripts.libav_cache.platform.machine", return_value="other"):
                        self.assertNotEqual(cache_key(), expected)
                    with patch("scripts.libav_cache.subprocess.run", return_value=SimpleNamespace(stdout="new compiler/SDK", stderr="")):
                        self.assertNotEqual(cache_key(), expected)
                    cache_script = root / "scripts/libav_cache.py"
                    cache_script.write_text(cache_script.read_text() + "\n# cache verification changed\n")
                    self.assertNotEqual(cache_key(), expected)
                    recipe.unlink()
                    with self.assertRaises(FileNotFoundError):
                        cache_key()

    def test_round_trip_preserves_libraries_and_provenance_but_not_application(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            prefix, cache, result = (root / name for name in ('prefix', 'cache', 'result'))
            files = {'lib/libavcodec.so': b'library', 'source/upstream.tar.xz': b'source',
                     'records/signature.log': b'verified signer', 'licenses/COPYING': b'license',
                     'driver/libav-runtime-tests': b'old Rust',
                     'bin/bilikara_media_libav.dll': b'old companion', 'bin/ffprobe.exe': b'CLI'}
            for relative, content in files.items():
                path = prefix / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(content)
            snapshot(prefix, cache)
            restore(cache, result)
            for relative in ('lib/libavcodec.so', 'source/upstream.tar.xz', 'records/signature.log', 'licenses/COPYING'):
                self.assertEqual((result / relative).read_bytes(), files[relative])
            self.assertFalse((result / 'driver').exists())
            self.assertFalse(list((result / 'bin').iterdir()))

    def test_corrupt_library_fails_before_publishing_prefix(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'prefix/lib').mkdir(parents=True)
            (root / 'prefix/lib/library').write_bytes(b'expected')
            snapshot(root / 'prefix', root / 'cache')
            (root / 'cache/lib/library').write_bytes(b'corrupt')
            with self.assertRaisesRegex(RuntimeError, 'Invalid libav cache content'):
                restore(root / 'cache', root / 'result')
            self.assertFalse((root / 'result').exists())

    def test_manifest_cannot_read_outside_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'cache').mkdir()
            (root / 'cache/cache-manifest.json').write_text('{"../outside":"hash"}')
            with self.assertRaisesRegex(RuntimeError, 'Invalid libav cache path'):
                restore(root / 'cache', root / 'result')
