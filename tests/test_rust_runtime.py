import ctypes
import json
import os
import threading
import unittest
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import Mock, patch

from bilikara import rust_runtime
from bilikara.cache import CacheManager, DEFAULT_VIDEO_QUALITY


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


class FakeServiceLibrary:
    def __init__(self, response: dict) -> None:
        self.buffer = ctypes.create_string_buffer(json.dumps(response).encode("utf-8"))
        self.request = None

    def bilikara_runtime_service(self, payload):
        self.request = json.loads(payload.decode("utf-8"))
        return ctypes.addressof(self.buffer)

    def bilikara_runtime_free_string(self, _pointer):
        return None


class FakeAppStateLibrary:
    def __init__(self, response: dict) -> None:
        self.buffer = ctypes.create_string_buffer(json.dumps(response).encode("utf-8"))
        self.request = None

    def bilikara_runtime_app_state_request(self, payload):
        self.request = json.loads(payload.decode("utf-8"))
        return ctypes.addressof(self.buffer)

    def bilikara_runtime_free_string(self, _pointer):
        return None


class RustRuntimeAdapterTest(unittest.TestCase):
    def test_app_state_adapter_sends_one_strict_request_and_returns_full_result(self):
        response = {
            "schema_version": 1,
            "status": "completed",
            "committed": False,
            "snapshot": {"revision": 7},
            "persistence": {"updated_at": 1},
            "effects": {
                "write_core": False,
                "write_session_played": False,
                "write_backup": False,
                "delete_backup": False,
                "delete_runtime_files": False,
            },
            "result": {"snapshot": True},
        }
        library = FakeAppStateLibrary(response)
        with patch("bilikara.rust_runtime._runtime_lib", library):
            actual = rust_runtime.app_state_request("snapshot")

        self.assertEqual(actual, response)
        self.assertEqual(
            library.request,
            {"schema_version": 1, "command": "snapshot"},
        )

    def test_app_state_adapter_preserves_domain_rejection_without_fallback(self):
        library = FakeAppStateLibrary(
            {
                "schema_version": 1,
                "status": "rejected",
                "error": {
                    "kind": "duplicate_session_request",
                    "message": "duplicate",
                    "details": {"identity_key": "BV1:p1"},
                },
            }
        )
        with patch("bilikara.rust_runtime._runtime_lib", library):
            with self.assertRaises(rust_runtime.RustAppStateRejectedError) as raised:
                rust_runtime.app_state_request("add_item", item={})

        self.assertEqual(raised.exception.kind, "duplicate_session_request")
        self.assertEqual(
            raised.exception.response["error"]["details"]["identity_key"],
            "BV1:p1",
        )

    def test_app_state_adapter_fails_when_runtime_is_unavailable(self):
        with patch("bilikara.rust_runtime._runtime_lib", None):
            with self.assertRaises(rust_runtime.RustRuntimeUnavailableError):
                rust_runtime.app_state_request("snapshot")

    def test_cache_runtime_adapter_sends_flattened_command(self):
        library = FakeServiceLibrary(
            {
                "schema_version": 1,
                "status": "completed",
                "result": {"events": [], "snapshot": {}},
            }
        )
        with patch("bilikara.rust_runtime._runtime_lib", library):
            result = rust_runtime.cache_runtime_request(
                "drain_events", max_events=32
            )

        self.assertEqual(result, {"events": [], "snapshot": {}})
        self.assertEqual(library.request["service"], "cache_runtime")
        self.assertEqual(
            library.request["request"],
            {"command": "drain_events", "max_events": 32},
        )

    def test_runtime_service_sends_structured_json_http_request(self):
        library = FakeServiceLibrary(
            {
                "schema_version": 1,
                "status": "completed",
                "result": {"status_code": 200, "payload": {"ok": True}},
            }
        )
        with patch("bilikara.rust_runtime._runtime_lib", library):
            result = rust_runtime.json_http_request(
                "POST",
                "https://example.test/api",
                headers={"Authorization": "Bearer secret"},
                payload={"bvid": "BV1xx411c7mD"},
                timeout=3,
            )

        self.assertEqual(result, {"ok": True})
        self.assertEqual(library.request["service"], "json_http")
        self.assertEqual(library.request["request"]["timeout_ms"], 3000)
        self.assertEqual(
            library.request["request"]["headers"],
            [{"name": "Authorization", "value": "Bearer secret"}],
        )

    def test_runtime_service_preserves_typed_native_failure(self):
        library = FakeServiceLibrary(
            {
                "schema_version": 1,
                "status": "failed",
                "error": {
                    "kind": "http_status",
                    "message": "HTTP 503",
                    "status_code": 503,
                },
            }
        )
        with patch("bilikara.rust_runtime._runtime_lib", library):
            with self.assertRaises(rust_runtime.RustRuntimeServiceError) as raised:
                rust_runtime.json_http_request("GET", "https://example.test/api")

        self.assertEqual(raised.exception.kind, "http_status")
        self.assertEqual(raised.exception.response["error"]["status_code"], 503)

    def test_library_lookup_prefers_release_and_supports_bundle(self):
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            release = root / "rust-runtime" / "target" / "release" / "libbilikara_runtime.so"
            release.parent.mkdir(parents=True)
            release.touch()
            with patch.dict(os.environ, {"BILIKARA_RUST_RUNTIME_LIBRARY": ""}), patch.object(
                rust_runtime.Path, "resolve", return_value=root / "bilikara" / "rust_runtime.py"
            ), patch("bilikara.rust_runtime.platform.system", return_value="Linux"):
                self.assertEqual(rust_runtime._get_runtime_lib_path(), release)

    def test_library_lookup_supports_explicit_development_override(self):
        with TemporaryDirectory() as temp_dir:
            explicit = Path(temp_dir) / "bilikara_runtime.dll"
            explicit.touch()
            with patch.dict(
                os.environ,
                {"BILIKARA_RUST_RUNTIME_LIBRARY": str(explicit)},
            ):
                self.assertEqual(rust_runtime._get_runtime_lib_path(), explicit)

    def test_cloudflare_service_adapter_sends_owned_request(self):
        library = FakeServiceLibrary(
            {
                "schema_version": 1,
                "status": "completed",
                "result": {"payload": {"ok": True}},
            }
        )
        with patch("bilikara.rust_runtime._runtime_lib", library):
            result = rust_runtime.cloudflare_service_request(
                "request",
                base_url="https://api.example.test",
                user_agent="bilikara/test",
                method="GET",
                path="/search?q=song",
            )

        self.assertEqual(result, {"payload": {"ok": True}})
        self.assertEqual(library.request["service"], "cloudflare")
        self.assertEqual(library.request["request"]["operation"], "request")

    def test_gatcha_repository_adapter_sends_all_owned_paths(self):
        library = FakeServiceLibrary(
            {
                "schema_version": 1,
                "status": "completed",
                "result": {"uids": [], "count": 0},
            }
        )
        with patch("bilikara.rust_runtime._runtime_lib", library):
            result = rust_runtime.gatcha_repository_request(
                "uid_snapshot",
                uid_file=Path("data/uids.json"),
                cache_file=Path("data/cache.json"),
                favlist_file=Path("data/favlist.json"),
                pool_config_file=Path("data/pool.json"),
            )

        self.assertEqual(result["count"], 0)
        self.assertEqual(library.request["service"], "gatcha_repository")
        self.assertTrue(library.request["request"]["paths"]["uid_file"].endswith("uids.json"))

    def test_runtime_load_failure_records_actionable_details(self):
        path = Path("C:/bundle/rust/bilikara_runtime.dll")
        with patch(
            "bilikara.rust_runtime.ctypes.CDLL",
            side_effect=OSError("VCRUNTIME140.dll was not found"),
        ):
            library, error, details = rust_runtime._load_runtime_library(path)

        self.assertIsNone(library)
        self.assertEqual(error, "Rust runtime load failed: OSError")
        self.assertEqual(details["stage"], "load_library")
        self.assertEqual(details["exception_type"], "OSError")
        self.assertIn("VCRUNTIME140.dll", details["exception_message"])
        self.assertEqual(details["selected_path"], str(path))

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

    @unittest.skipUnless(
        os.getenv("BILIKARA_REQUIRE_RUST_LIB", "").strip().lower()
        in {"1", "true", "yes", "on"},
        "native Rust runtime is optional outside the release gate",
    )
    def test_native_runtime_services_use_the_real_abi(self):
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.dumps({"ok": True, "source": "rust"}).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, _format, *_args):
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            result = rust_runtime.json_http_request(
                "POST",
                f"http://127.0.0.1:{server.server_port}/json",
                payload={"request": True},
            )
            addresses = rust_runtime.detect_lan_ipv4_addresses(
                platform_name="win32",
                candidates=[
                    {
                        "name": "vEthernet (WSL)",
                        "address": "172.28.32.1",
                        "is_up": True,
                        "interface_type": "virtual",
                    },
                    {
                        "name": "Wi-Fi",
                        "address": "192.168.31.8",
                        "is_up": True,
                        "interface_type": "physical",
                    },
                ],
                route_sources=["192.168.31.8"],
            )
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

        self.assertEqual(result, {"ok": True, "source": "rust"})
        self.assertEqual(addresses, ["192.168.31.8"])

        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            archive_path = root / "update.zip"
            with zipfile.ZipFile(archive_path, "w") as archive:
                archive.writestr("bundle/bilikara.exe", b"native update")
            command = rust_runtime.prepare_update_install(
                {
                    "platform": "windows",
                    "archive_path": str(archive_path),
                    "extract_dir": str(root / "extracted"),
                    "script_path": str(root / "apply.cmd"),
                    "install_root": str(root / "installed"),
                    "executable_name": "bilikara.exe",
                    "launch_executable_name": "bilikara-desktop.exe",
                    "wait_pids": [42],
                }
            )
            self.assertEqual(command[:2], ["cmd", "/c"])
            self.assertTrue((root / "extracted" / "bundle" / "bilikara.exe").is_file())
            self.assertIn(
                "/XD runtime data updates __pycache__",
                (root / "apply.cmd").read_text(encoding="utf-8"),
            )

    @unittest.skipUnless(
        os.getenv("BILIKARA_REQUIRE_RUST_LIB", "").strip().lower()
        in {"1", "true", "yes", "on"},
        "native Rust runtime is optional outside the release gate",
    )
    def test_native_status_service_owns_gatcha_lease_and_task_state(self):
        rust_runtime.reset_gatcha_status_service()
        try:
            self.assertTrue(
                rust_runtime.try_begin_gatcha_refresh(
                    busy_message="refresh busy",
                    task={
                        "status": "running",
                        "message": "refreshing",
                        "blocking": True,
                    },
                )
            )
            self.assertFalse(
                rust_runtime.try_begin_gatcha_refresh(busy_message="duplicate")
            )
            self.assertTrue(rust_runtime.gatcha_task_snapshot()["busy"])

            rust_runtime.release_gatcha_refresh()
            snapshot = rust_runtime.set_gatcha_task_status(
                "running", message="schema rebuild", blocking=False
            )
            self.assertFalse(snapshot["busy"])
            self.assertTrue(snapshot["background_busy"])
        finally:
            rust_runtime.reset_gatcha_status_service()

    @unittest.skipUnless(
        os.getenv("BILIKARA_REQUIRE_RUST_LIB", "").strip().lower()
        in {"1", "true", "yes", "on"},
        "native Rust runtime is optional outside the release gate",
    )
    def test_native_status_service_rejects_stale_bilibili_login_updates(self):
        rust_runtime.reset_bilibili_login_status()
        first_generation = rust_runtime.begin_bilibili_login(message="first")
        current_generation = rust_runtime.begin_bilibili_login(message="second")

        self.assertFalse(
            rust_runtime.set_bilibili_login_status(
                "failed",
                message="stale failure",
                generation=first_generation,
            )
        )
        self.assertTrue(
            rust_runtime.set_bilibili_login_status(
                "waiting",
                message="scan current code",
                qr_image="data:image/png;base64,current",
                generation=current_generation,
            )
        )
        snapshot = rust_runtime.bilibili_login_snapshot(
            logged_in=False,
            data_exists=False,
            data_path=Path("BBDown.data"),
        )
        self.assertEqual(snapshot["state"], "waiting")
        self.assertEqual(snapshot["message"], "scan current code")
        self.assertEqual(snapshot["qr_image"], "data:image/png;base64,current")


class RustRuntimeCacheRoutingTest(unittest.TestCase):
    def make_manager(self):
        manager = CacheManager.__new__(CacheManager)
        manager._append_log_line = Mock()
        return manager

    def test_native_dash_resolution_selects_hires_flac(self):
        manager = self.make_manager()
        manager.lock = threading.RLock()
        manager.hevc_supported = None
        manager.avc_quality_cap = ""
        manager.video_quality = DEFAULT_VIDEO_QUALITY
        manager.audio_hires = True
        item = Mock(bvid="BV1jDVUzSEom", aid=123, cid=456)
        flac = {
            "url": "https://media.invalid/hires.m4s",
            "backup_urls": [],
            "quality_id": 30251,
            "bandwidth": 1_882_182,
            "codec_name": "flac",
            "mime_type": "audio/mp4",
        }
        dash = {
            "video": [{
                "url": "https://media.invalid/video.m4s",
                "backup_urls": [],
                "quality_id": 80,
                "bandwidth": 1_000_000,
                "codec_name": "avc",
            }],
            "audio": [{
                "url": "https://media.invalid/audio.m4s",
                "backup_urls": [],
                "quality_id": 30280,
                "bandwidth": 198_226,
                "mime_type": "audio/mp4",
            }],
            "flac": flac,
            "dolby": None,
        }

        with patch(
            "bilikara.cache.effective_bilibili_cookie",
            return_value="SESSDATA=test",
        ), patch(
            "bilikara.cache.rust_runtime.fetch_bilibili_dash_playurl",
            return_value=dash,
        ), patch.object(
            manager,
            "_select_dash_video_stream",
            return_value=dash["video"][0],
        ), patch.object(
            manager,
            "_select_dash_audio_stream",
            return_value=dash["audio"][0],
        ):
            resolved = manager._resolve_dash_streams(item, native_media=True)

        self.assertEqual(resolved["audio"][0]["quality_id"], 30251)
        self.assertEqual(resolved["audio"][0]["codec_name"], "flac")

    def test_native_download_publishes_selected_hires_as_flac(self):
        manager = self.make_manager()
        manager.stop_event = threading.Event()
        manager._selected_pages_for_item = Mock(return_value=[1])
        manager._cid_for_page = Mock(return_value=456)
        manager._dash_stream_urls = Mock(return_value=["https://media.invalid/video.m4s"])
        manager._preferred_audio_urls = Mock(return_value=["https://media.invalid/hires.m4s"])
        manager._raise_if_retry_requested = Mock()
        manager._raise_if_priority_shift = Mock()
        manager._reset_download_track_progress = Mock()
        manager._set_download_track_phase = Mock()
        manager._update_download_track_progress = Mock()
        manager._duration_for_page = Mock(return_value=120)
        flac = {
            "url": "https://media.invalid/hires.m4s",
            "backup_urls": [],
            "quality_id": 30251,
            "bandwidth": 1_882_182,
            "codec_name": "flac",
            "mime_type": "audio/mp4",
        }
        manager._resolve_dash_streams = Mock(
            return_value={"video": [], "audio": [flac], "flac": None, "dolby": None}
        )

        def download_track(_item_id, target_dir, _log_path, **kwargs):
            target_dir.mkdir(parents=True, exist_ok=True)
            output = target_dir / kwargs["out_name"]
            output.write_bytes(b"raw")
            return output

        def normalize_track(*, source, destination, expected_kind):
            destination.write_bytes(source.read_bytes())
            return {
                "source": {},
                "output": {
                    "path": str(destination),
                    "kind": expected_kind,
                    "codec": "flac" if destination.suffix == ".flac" else "h264",
                    "duration_seconds": 120.0,
                    "sample_count": 1,
                    "sample_bytes": 3,
                    "file_bytes": 3,
                    "fragmented": False,
                    "fast_start": True,
                },
            }

        manager._download_stream_with_rust = Mock(side_effect=download_track)
        item = Mock(id="song-hires", video_page=1)
        video_track = {"key": "video-p1", "page": 1, "label": "video"}
        audio_track = {"key": "audio-p1", "page": 1, "label": "audio"}
        dash = {
            "video": [{
                "url": "https://media.invalid/video.m4s",
                "backup_urls": [],
                "codec_name": "avc",
            }],
            "audio": [],
        }

        with TemporaryDirectory() as temp_dir, patch(
            "bilikara.cache.effective_bilibili_cookie",
            return_value="SESSDATA=test",
        ), patch(
            "bilikara.cache.rust_runtime.normalize_media",
            side_effect=normalize_track,
        ):
            paths = manager._download_dash_streams_native(
                item,
                Path(temp_dir),
                Path(temp_dir) / "native.log",
                dash_streams=dash,
                video_track=video_track,
                audio_tracks=[audio_track],
            )

        self.assertEqual(paths["audio-p1"].suffix, ".flac")
        self.assertEqual(audio_track["stream_metadata"]["quality_id"], 30251)

    def test_native_download_log_includes_transport_and_throughput(self):
        manager = self.make_manager()
        manager._update_download_track_progress = Mock()

        def complete_download(**kwargs):
            destination = kwargs["destination"]
            destination.write_bytes(b"download")
            return {
                "bytes_written": 8,
                "candidate_index": 0,
                "segments_used": 10,
                "workers_used": 10,
                "host_rewritten": True,
                "transport": "http",
                "final_host": "upos-sz-mirrorcoso1.bilivideo.com",
                "elapsed_ms": 2500,
                "average_bytes_per_second": 19_902_445,
            }

        with TemporaryDirectory() as temp_dir, patch(
            "bilikara.cache.rust_runtime.download_to_path",
            side_effect=complete_download,
        ):
            manager._download_stream_with_rust(
                "song-a",
                Path(temp_dir) / "video-p1",
                Path(temp_dir) / "download.log",
                urls=["https://media.invalid"],
                out_name="video-p1.mp4",
                cookie="",
                stage_label="download",
                track_key="video-p1",
                stream_kind="video",
            )

        log_line = manager._append_log_line.call_args_list[-1].args[1]
        diagnostic = json.loads(log_line.split("media_diagnostic: ", 1)[1])
        self.assertEqual(diagnostic["transport"], "http")
        self.assertEqual(diagnostic["workers_used"], 10)
        self.assertEqual(diagnostic["elapsed_ms"], 2500)
        self.assertEqual(diagnostic["average_bytes_per_second"], 19_902_445)
        self.assertEqual(
            diagnostic["final_host"],
            "upos-sz-mirrorcoso1.bilivideo.com",
        )

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

    def test_downkyi_selected_stream_path_never_calls_native_downloader(self):
        with TemporaryDirectory() as temp_dir, patch(
            "bilikara.cache.CACHE_DIR", Path(temp_dir)
        ), patch(
            "bilikara.cache.effective_bilibili_cookie", return_value="SESSDATA=test"
        ):
            cache_dir = Path(temp_dir)
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
            manager._download_dash_streams_native = Mock()

            def aria2c_download(*_args, video_track, audio_tracks, **_kwargs):
                video_track["validation_metadata"] = {"kind": "video"}
                audio_tracks[0]["validation_metadata"] = {"kind": "audio"}
                return {
                    str(video_track["key"]): cache_dir / "video.m4s",
                    str(audio_tracks[0]["key"]): cache_dir / "audio.m4s",
                }

            manager._download_dash_streams_with_aria2c = Mock(
                side_effect=aria2c_download
            )
            item = Mock(id="song-a", video_page=1, selected_audio_variant_id="")

            result = manager._download_selected_streams(
                item,
                Path("aria2c"),
                Path("ffmpeg"),
                cache_dir / "target",
                cache_dir / "download.log",
                download_source="downkyi",
            )

        manager._download_dash_streams_with_aria2c.assert_called_once()
        manager._download_dash_streams_native.assert_not_called()
        self.assertTrue(result["downkyi_tracks_prevalidated"])
        self.assertEqual(len(result["validation_metadata"]), 2)
