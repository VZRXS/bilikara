"""M6 application routing evidence using the accepted synthetic media corpus."""
from __future__ import annotations

import copy
import ctypes
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from bilikara import rust_runtime
from bilikara.cache import CacheManager, DownloadCommandError


class MediaRoutingShapeTests(unittest.TestCase):
    def test_failed_startup_facts_cannot_launch_an_unconfigured_native_job(self):
        with patch.object(rust_runtime, "_runtime_lib", object()), patch.object(rust_runtime, "_media_startup_error", "invalid startup facts"), patch.object(rust_runtime, "_call_runtime_service") as service:
            with self.assertRaises(rust_runtime.RustRuntimeServiceError):
                rust_runtime.cache_runtime_request("submit", job={})
        service.assert_not_called()

    def test_malformed_success_never_becomes_compatibility(self):
        source = Path(tempfile.gettempdir()) / "synthetic.m4a"
        good = {"action": "completed", "metadata": {"backend": "libav", "path": str(source), "size": 10,
            "container": "mp4", "duration_seconds": None, "inspection_level": "packet_scan", "stream_count": 1,
            "streams": [{"kind": "audio", "codec": "aac", "duration_seconds": None}]},
            "diagnostic": {"operation": "validate", "backend": "libav", "outcome": "success", "compatibility_reason": None}}
        rust_runtime._validate_inspection(good, source=source, expected_kind="audio", operation="validate")
        for field, value in [("size", True), ("size", 0), ("streams", []), ("duration_seconds", float("nan")),
                             ("inspection_level", "stream_metadata"), ("backend", "planned_libav"), ("stream_count", 2)]:
            bad = copy.deepcopy(good)
            bad["metadata"][field] = value
            with self.subTest(field=field), self.assertRaises(rust_runtime.RustMediaError):
                rust_runtime._validate_inspection(bad, source=source, expected_kind="audio", operation="validate")
        for backend, reason in [("legacy", "unknown"), ("ffmpeg", "unavailable"), ("ffprobe", "io"), ("legacy", "unavailable")]:
            with self.subTest(backend=backend, reason=reason), self.assertRaises(rust_runtime.RustMediaError):
                rust_runtime._validate_inspection({"action": "compatibility", "backend": backend, "reason": reason},
                                                 source=source, expected_kind="audio", operation="validate")

    def test_failure_messages_never_authorize_host_fallback(self):
        manager = CacheManager.__new__(CacheManager)
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "synthetic.m4a"
            for kind in ["invalid_media", "media_contract_violation", "invalid_request", "io", "backend_failure", "unknown"]:
                with self.subTest(kind=kind), patch.object(rust_runtime, "inspect_media", side_effect=rust_runtime.RustMediaError(
                    kind, "Unsupported unavailable", response={})), patch("subprocess.run") as cli, self.assertRaises(DownloadCommandError):
                    manager._probe_media_metadata(None, Path(temporary) / "ffmpeg", source, label="synthetic",
                                                 log_path=Path(temporary) / "log", expected_kind="audio")
                cli.assert_not_called()

    def test_native_envelope_is_freed_even_when_malformed(self):
        class MalformedLibrary:
            def __init__(self):
                self.buffer = ctypes.create_string_buffer(b'{"schema_version":1,"status":"completed","result":{}}')
                self.freed = False
            def bilikara_runtime_media_inspect(self, *_args):
                return ctypes.addressof(self.buffer)
            def bilikara_runtime_free_string(self, _pointer):
                self.freed = True
        lib = MalformedLibrary()
        with patch.object(rust_runtime, "_runtime_lib", lib), patch.object(rust_runtime, "_media_startup_error", ""), self.assertRaises(rust_runtime.RustMediaError):
            rust_runtime.inspect_media(source=Path(tempfile.gettempdir()) / "synthetic", expected_kind="audio", operation="metadata")
        self.assertTrue(lib.freed)


@unittest.skipUnless(os.environ.get("BILIKARA_LIBAV_COMPANION"), "live suite requires explicitly provisioned accepted companion and fixtures")
class LiveMediaRoutingTests(unittest.TestCase):
    def setUp(self):
        self.companion = Path(os.environ["BILIKARA_LIBAV_COMPANION"])
        self.prefix = Path(os.environ["BILIKARA_LIBAV_FFMPEG_PREFIX"])
        self.fixtures = Path(os.environ["BILIKARA_LIBAV_FIXTURES"])
        self.assertTrue(self.companion.is_file())
        self.assertTrue((self.fixtures / "aac.m4a").is_file())

    def child(self, code, *, legacy=False, missing=False):
        with tempfile.TemporaryDirectory() as temporary:
            env = dict(os.environ, BILIKARA_HOME=temporary, BILIKARA_MAX_CACHE_ITEMS="0")
            env.pop("BILIKARA_MEDIA_BACKEND", None)
            if legacy:
                env["BILIKARA_MEDIA_BACKEND"] = "legacy"
            if missing:
                env["BILIKARA_LIBAV_COMPANION"] = str(Path(temporary) / "absent.so")
            result = subprocess.run([sys.executable, "-c", code], env=env, capture_output=True, timeout=60)
            self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace")[-1800:])
            return json.loads(result.stdout)

    def test_real_normal_callers_default_legacy_and_missing(self):
        code = "from bilikara.media_smoke import run; print(run())"
        for mode in ("default", "legacy", "missing"):
            with self.subTest(mode=mode):
                rows = self.child(code, legacy=mode == "legacy", missing=mode == "missing")["operations"]
                self.assertEqual(len(rows), 6)
                for row in rows:
                    self.assertEqual(row["outcome"], "success")
                    if mode == "default":
                        self.assertEqual(row["backend"], "libav")
                        self.assertEqual(row["cli_calls"], 0)
                    else:
                        self.assertNotEqual(row["backend"], "libav")
                if mode != "default":
                    self.assertEqual(rows[1]["backend"], "ffmpeg")
                    self.assertEqual(rows[1]["cli_calls"], 1)
                    self.assertEqual(rows[3]["backend"], "pure_rust")
                    self.assertEqual(rows[3]["compatibility_reason"], "unavailable" if mode == "missing" else "legacy_override")

    def test_real_known_metadata_profile_limitation_uses_one_cli(self):
        code = '''
import json, os, subprocess
from pathlib import Path
from unittest.mock import patch
from bilikara.cache import CacheManager
from bilikara import rust_runtime as r
from bilikara.config import BB_DOWN_DIR
BB_DOWN_DIR.mkdir(parents=True, exist_ok=True)
source = Path(os.environ["BILIKARA_LIBAV_FIXTURES"]) / "outside.wav"
manager = CacheManager.__new__(CacheManager)
with patch("subprocess.run", wraps=subprocess.run) as calls:
    result = manager._probe_media_metadata(None, Path(os.environ["BILIKARA_LIBAV_FFMPEG_PREFIX"])/"bin/ffmpeg", source,
        label="synthetic", log_path=Path(os.environ["BILIKARA_HOME"])/"log", expected_kind="audio", metadata_only=True)
print(json.dumps({"backend":result["backend"], "calls":calls.call_count, "duration":result["duration_seconds"]}))
'''
        result = self.child(code)
        self.assertEqual(result["backend"], "ffprobe")
        self.assertEqual(result["calls"], 1)
        self.assertGreater(result["duration"], 0)

    def test_real_source_rejection_precedes_legacy_timestamp_transform(self):
        result = self.child('''
import json, os
from pathlib import Path
from unittest.mock import patch
from bilikara.cache import CacheManager, DownloadCommandError
manager = CacheManager.__new__(CacheManager)
source = Path(os.environ["BILIKARA_LIBAV_FIXTURES"]) / "missing-mdat.m4a"
with patch("subprocess.run") as cli:
    try:
        manager._normalize_downkyi_media_file(Path("/unused/ffmpeg"), source,
            label="synthetic", stream_kind="audio", log_path=Path(os.environ["BILIKARA_HOME"])/"log")
    except DownloadCommandError:
        print(json.dumps({"rejected": True, "cli_calls": cli.call_count}))
    else:
        raise AssertionError("source contract was relaxed")
''')
        self.assertEqual(result, {"rejected": True, "cli_calls": 0})


if __name__ == "__main__":
    unittest.main()
