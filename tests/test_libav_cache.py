from pathlib import Path
import tempfile
import unittest
from scripts.libav_cache import snapshot, restore


class LibavCacheTest(unittest.TestCase):
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
