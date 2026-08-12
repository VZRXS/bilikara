import ctypes
import json
import os
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import Mock, patch

from bilikara import rust_runtime
from bilikara.cache import CacheCancelledError, CacheManager, DownloadCommandError


class FakeRuntimeLibrary:
    def __init__(self, response: dict) -> None:
        self.buffer = ctypes.create_string_buffer(
            json.dumps(response).encode("utf-8")
        )

    def bilikara_runtime_download(self, _payload, callback, _context):
        callback(4, 8, None)
        callback(8, 8, None)
        return ctypes.addressof(self.buffer)

    def bilikara_runtime_free_string(self, _pointer):
        return None


class FakeMediaLibrary:
    def __init__(self, responses: dict[str, dict]) -> None:
        self.responses = responses
        self.buffers = []

    def _response(self, name: str):
        buffer = ctypes.create_string_buffer(
            json.dumps(self.responses[name]).encode("utf-8")
        )
        self.buffers.append(buffer)
        return ctypes.addressof(buffer)

    def bilikara_runtime_media_probe(self, _payload):
        return self._response("probe")

    def bilikara_runtime_media_normalize(self, _payload):
        return self._response("normalize")

    def bilikara_runtime_free_string(self, _pointer):
        return None


class RustRuntimeAdapterTest(unittest.TestCase):
    def test_library_lookup_prefers_release_and_supports_bundle(self):
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            release = root / "rust-runtime" / "target" / "release" / "libbilikara_runtime.so"
            release.parent.mkdir(parents=True)
            release.touch()
            with patch.object(rust_runtime.Path, "resolve", return_value=root / "bilikara" / "rust_runtime.py"), patch(
                "bilikara.rust_runtime.platform.system", return_value="Linux"
            ):
                self.assertEqual(rust_runtime._get_runtime_lib_path(), release)

    def test_download_validates_success_and_reports_progress(self):
        with TemporaryDirectory() as temp_dir:
            destination = Path(temp_dir) / "track.m4s"
            response = {
                "schema_version": 1,
                "status": "completed",
                "result": {
                    "destination": str(destination.resolve()),
                    "bytes_written": 8,
                    "content_length": 8,
                    "candidate_index": 1,
                    "attempt": 1,
                },
            }
            progress = []
            with patch("bilikara.rust_runtime._runtime_lib", FakeRuntimeLibrary(response)):
                result = rust_runtime.download_to_path(
                    urls=["https://primary.invalid", "https://backup.invalid"],
                    destination=destination,
                    headers=[("Cookie", "SESSDATA=secret")],
                    on_progress=lambda current, total: progress.append((current, total)),
                )

        self.assertEqual(result["candidate_index"], 1)
        self.assertEqual(progress, [(4, 8), (8, 8)])

    def test_download_raises_typed_failure_without_exposing_request(self):
        response = {
            "schema_version": 1,
            "status": "failed",
            "error": {
                "kind": "http_status",
                "message": "HTTP request returned status 403",
                "candidate_index": 0,
                "http_status": 403,
            },
        }
        with TemporaryDirectory() as temp_dir, patch(
            "bilikara.rust_runtime._runtime_lib", FakeRuntimeLibrary(response)
        ):
            with self.assertRaises(rust_runtime.RustDownloadError) as raised:
                rust_runtime.download_to_path(
                    urls=["https://media.invalid/secret-token"],
                    destination=Path(temp_dir) / "track.m4s",
                    headers=[("Cookie", "SESSDATA=secret")],
                )

        self.assertEqual(raised.exception.kind, "http_status")
        self.assertNotIn("secret-token", str(raised.exception))
        self.assertNotIn("SESSDATA", str(raised.exception))

    def test_media_probe_and_normalize_validate_native_metadata(self):
        with TemporaryDirectory() as temp_dir:
            source = (Path(temp_dir) / "source.mp4").resolve()
            destination = (Path(temp_dir) / "output.mp4").resolve()
            source.write_bytes(b"source")

            def probe(path: Path, *, fast_start: bool) -> dict:
                return {
                    "path": str(path),
                    "kind": "video",
                    "codec": "h264",
                    "duration_seconds": 12.5,
                    "sample_count": 375,
                    "sample_bytes": 1024,
                    "file_bytes": 1200,
                    "fragmented": not fast_start,
                    "fast_start": fast_start,
                }

            responses = {
                "probe": {
                    "schema_version": 1,
                    "status": "completed",
                    "result": probe(source, fast_start=False),
                },
                "normalize": {
                    "schema_version": 1,
                    "status": "completed",
                    "result": {
                        "source": probe(source, fast_start=False),
                        "output": probe(destination, fast_start=True),
                    },
                },
            }
            with patch(
                "bilikara.rust_runtime._runtime_lib", FakeMediaLibrary(responses)
            ):
                probed = rust_runtime.probe_media(
                    source=source, expected_kind="video"
                )
                normalized = rust_runtime.normalize_media(
                    source=source,
                    destination=destination,
                    expected_kind="video",
                )

        self.assertEqual(probed["sample_count"], 375)
        self.assertTrue(normalized["output"]["fast_start"])

    @unittest.skipUnless(
        os.getenv("BILIKARA_REQUIRE_RUST_LIB", "").strip().lower()
        in {"1", "true", "yes", "on"},
        "native Rust runtime is optional outside the release gate",
    )
    def test_native_runtime_downloads_through_the_real_abi(self):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                body = b"native-runtime"
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, _format, *_args):
                return

        self.assertTrue(rust_runtime.http_download_available())
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with TemporaryDirectory() as temp_dir:
                destination = Path(temp_dir) / "track.m4s"
                result = rust_runtime.download_to_path(
                    urls=[f"http://127.0.0.1:{server.server_port}/track"],
                    destination=destination,
                )
                self.assertEqual(destination.read_bytes(), b"native-runtime")
                self.assertEqual(result["bytes_written"], len(b"native-runtime"))
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


class RustRuntimeCacheRoutingTest(unittest.TestCase):
    def make_manager(self):
        manager = CacheManager.__new__(CacheManager)
        manager._append_log_line = Mock()
        return manager

    def test_native_success_does_not_start_aria2c(self):
        manager = self.make_manager()
        native_path = Path("native-output.m4s")
        manager._download_stream_with_rust = Mock(return_value=native_path)
        manager._download_stream_with_aria2c = Mock()
        with patch("bilikara.cache.rust_runtime.http_download_available", return_value=True):
            result = manager._download_stream_with_native_or_aria2c(
                "song-a",
                Path("aria2c"),
                Path("ffmpeg"),
                Path("target"),
                Path("download.log"),
                urls=["https://media.invalid"],
                out_name="track.m4s",
                cookie="",
                stage_label="download",
                track_key="video-p1",
                stream_kind="video",
            )

        self.assertEqual(result, native_path)
        manager._download_stream_with_aria2c.assert_not_called()

    def test_native_selected_stream_path_never_calls_legacy_downloader(self):
        with TemporaryDirectory() as temp_dir, patch(
            "bilikara.cache.CACHE_DIR", Path(temp_dir)
        ):
            cache_dir = Path(temp_dir)
            item_dir = cache_dir / "song-a"
            video_path = item_dir / "video-p1" / "video-p1.mp4"
            audio_path = item_dir / "audio-p1" / "audio-p1.m4a"
            video_path.parent.mkdir(parents=True)
            audio_path.parent.mkdir(parents=True)
            video_path.write_bytes(b"video")
            audio_path.write_bytes(b"audio")

            manager = self.make_manager()
            manager.store = Mock()
            manager._raise_if_priority_shift = Mock()
            manager._raise_if_retry_requested = Mock()
            manager._selected_pages_for_item = Mock(return_value=[1])
            manager._begin_download_progress = Mock()
            manager._record_item_activity = Mock()
            manager._part_label_for_page = Mock(return_value="P1")
            manager._cid_for_validation = Mock(return_value=123)
            manager._duration_for_page = Mock(return_value=12)
            manager._resolve_dash_streams = Mock(
                return_value={"video": [{"codec_name": "avc"}], "audio": [{}]}
            )
            manager._download_page_stream = Mock()

            def native_download(*_args, video_track, audio_tracks, **_kwargs):
                video_track["validation_metadata"] = {"kind": "video"}
                audio_tracks[0]["validation_metadata"] = {"kind": "audio"}
                return {
                    str(video_track["key"]): video_path,
                    str(audio_tracks[0]["key"]): audio_path,
                }

            manager._download_dash_streams_native = Mock(
                side_effect=native_download
            )
            item = Mock(
                id="song-a",
                video_page=1,
                selected_audio_variant_id="",
            )

            result = manager._download_selected_streams(
                item,
                Path(),
                Path(),
                item_dir,
                cache_dir / "native.log",
                download_source="native",
            )

        manager._download_dash_streams_native.assert_called_once()
        manager._download_page_stream.assert_not_called()
        self.assertTrue(result["native_tracks_prevalidated"])
        self.assertEqual(len(result["validation_metadata"]), 2)

    def test_native_failure_falls_back_but_cancellation_does_not(self):
        manager = self.make_manager()
        fallback_path = Path("aria-output.m4s")
        manager._download_stream_with_rust = Mock(
            side_effect=DownloadCommandError("native failed")
        )
        manager._download_stream_with_aria2c = Mock(return_value=fallback_path)
        kwargs = {
            "urls": ["https://media.invalid"],
            "out_name": "track.m4s",
            "cookie": "",
            "stage_label": "download",
            "track_key": "video-p1",
            "stream_kind": "video",
        }
        with patch("bilikara.cache.rust_runtime.http_download_available", return_value=True):
            result = manager._download_stream_with_native_or_aria2c(
                "song-a",
                Path("aria2c"),
                Path("ffmpeg"),
                Path("target"),
                Path("download.log"),
                **kwargs,
            )
        self.assertEqual(result, fallback_path)
        manager._download_stream_with_aria2c.assert_called_once()

        manager._download_stream_with_rust.side_effect = CacheCancelledError("cancelled")
        manager._download_stream_with_aria2c.reset_mock()
        with patch("bilikara.cache.rust_runtime.http_download_available", return_value=True):
            with self.assertRaises(CacheCancelledError):
                manager._download_stream_with_native_or_aria2c(
                    "song-a",
                    Path("aria2c"),
                    Path("ffmpeg"),
                    Path("target"),
                    Path("download.log"),
                    **kwargs,
                )
        manager._download_stream_with_aria2c.assert_not_called()
