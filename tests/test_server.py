import csv
import io
import ipaddress
from collections import deque
import threading
import unittest
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

import bilikara.server as server_module
from bilikara.diagnostics import DiagnosticArtifact
from bilikara.remote_identity import RemoteIdentityStore
from bilikara.server import AppContext, BilikaraHandler, run
from bilikara.store import PlaylistStore


class FileServingPathSecurityTest(unittest.TestCase):
    @staticmethod
    def make_handler():
        handler = BilikaraHandler.__new__(BilikaraHandler)
        writes = []
        streams = []
        handler._write_json = lambda payload, status=None: writes.append({"payload": payload, "status": status})
        handler._stream_file = lambda path, **kwargs: streams.append(path)
        return handler, writes, streams

    def test_media_route_rejects_sibling_directory_with_cache_prefix(self):
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            cache_dir = root / "cache"
            sibling_dir = root / "cache_secret"
            cache_dir.mkdir()
            sibling_dir.mkdir()
            (sibling_dir / "secret.mp4").write_bytes(b"secret")
            handler, writes, streams = self.make_handler()

            with patch("bilikara.server.CACHE_DIR", cache_dir):
                handler._serve_media("/media/../cache_secret/secret.mp4")

        self.assertEqual(streams, [])
        self.assertEqual(writes[0]["status"], server_module.HTTPStatus.NOT_FOUND)

    def test_static_route_rejects_sibling_directory_with_static_prefix(self):
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            static_dir = root / "static"
            sibling_dir = root / "static_secret"
            static_dir.mkdir()
            sibling_dir.mkdir()
            (sibling_dir / "secret.js").write_text("secret", encoding="utf-8")
            handler, writes, streams = self.make_handler()

            with patch("bilikara.server.STATIC_DIR", static_dir):
                handler._serve_static("/../static_secret/secret.js")

        self.assertEqual(streams, [])
        self.assertEqual(writes[0]["status"], server_module.HTTPStatus.NOT_FOUND)


class FileServingPathSecurityTest(unittest.TestCase):
    @staticmethod
    def make_handler():
        handler = BilikaraHandler.__new__(BilikaraHandler)
        writes = []
        streams = []
        handler._write_json = lambda payload, status=None: writes.append({"payload": payload, "status": status})
        handler._stream_file = lambda path, **kwargs: streams.append(path)
        return handler, writes, streams

    def test_media_route_rejects_sibling_directory_with_cache_prefix(self):
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            cache_dir = root / "cache"
            sibling_dir = root / "cache_secret"
            cache_dir.mkdir()
            sibling_dir.mkdir()
            (sibling_dir / "secret.mp4").write_bytes(b"secret")
            handler, writes, streams = self.make_handler()

            with patch("bilikara.server.CACHE_DIR", cache_dir):
                handler._serve_media("/media/../cache_secret/secret.mp4")

        self.assertEqual(streams, [])
        self.assertEqual(writes[0]["status"], server_module.HTTPStatus.NOT_FOUND)

    def test_static_route_rejects_sibling_directory_with_static_prefix(self):
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            static_dir = root / "static"
            sibling_dir = root / "static_secret"
            static_dir.mkdir()
            sibling_dir.mkdir()
            (sibling_dir / "secret.js").write_text("secret", encoding="utf-8")
            handler, writes, streams = self.make_handler()

            with patch("bilikara.server.STATIC_DIR", static_dir):
                handler._serve_static("/../static_secret/secret.js")

        self.assertEqual(streams, [])
        self.assertEqual(writes[0]["status"], server_module.HTTPStatus.NOT_FOUND)


class FileServingPathSecurityTest(unittest.TestCase):
    @staticmethod
    def make_handler():
        handler = BilikaraHandler.__new__(BilikaraHandler)
        writes = []
        streams = []
        handler._write_json = lambda payload, status=None: writes.append({"payload": payload, "status": status})
        handler._stream_file = lambda path, **kwargs: streams.append(path)
        return handler, writes, streams

    def test_media_route_rejects_sibling_directory_with_cache_prefix(self):
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            cache_dir = root / "cache"
            sibling_dir = root / "cache_secret"
            cache_dir.mkdir()
            sibling_dir.mkdir()
            (sibling_dir / "secret.mp4").write_bytes(b"secret")
            handler, writes, streams = self.make_handler()

            with patch("bilikara.server.CACHE_DIR", cache_dir):
                handler._serve_media("/media/../cache_secret/secret.mp4")

        self.assertEqual(streams, [])
        self.assertEqual(writes[0]["status"], server_module.HTTPStatus.NOT_FOUND)

    def test_static_route_rejects_sibling_directory_with_static_prefix(self):
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            static_dir = root / "static"
            sibling_dir = root / "static_secret"
            static_dir.mkdir()
            sibling_dir.mkdir()
            (sibling_dir / "secret.js").write_text("secret", encoding="utf-8")
            handler, writes, streams = self.make_handler()

            with patch("bilikara.server.STATIC_DIR", static_dir):
                handler._serve_static("/../static_secret/secret.js")

        self.assertEqual(streams, [])
        self.assertEqual(writes[0]["status"], server_module.HTTPStatus.NOT_FOUND)


class AppContextRemoteAccessTest(unittest.TestCase):
    def make_context(self, *, host: str = "0.0.0.0", port: int = 8080) -> AppContext:
        context = AppContext.__new__(AppContext)
        context._closed = False
        context._host = host
        context._port = port
        context._remote_access_lock = threading.RLock()
        context._remote_access = AppContext._build_remote_access_payload(host, port, [])
        context._state_change_condition = threading.Condition()
        context._state_revision = 0
        return context

    def test_remote_access_snapshot_uses_cached_payload(self):
        context = self.make_context()
        context._remote_access = {
            "local_url": "http://127.0.0.1:8080/remote",
            "lan_urls": ["http://192.168.0.8:8080/remote"],
            "preferred_url": "http://192.168.0.8:8080/remote",
        }

        with patch("bilikara.server._network_access_urls", side_effect=AssertionError("should not resolve")):
            snapshot = context.remote_access_snapshot()

        self.assertEqual(snapshot["preferred_url"], "http://192.168.0.8:8080/remote")
        self.assertEqual(snapshot["lan_urls"], ["http://192.168.0.8:8080/remote"])

    def test_refresh_remote_access_snapshot_updates_cached_lan_urls(self):
        context = self.make_context()

        with patch("bilikara.server._network_access_urls", return_value=["http://192.168.0.8:8080"]):
            context._refresh_remote_access_snapshot()

        snapshot = context.remote_access_snapshot()
        self.assertEqual(snapshot["local_url"], "http://127.0.0.1:8080/remote")
        self.assertEqual(snapshot["lan_urls"], ["http://192.168.0.8:8080/remote"])
        self.assertEqual(snapshot["preferred_url"], "http://192.168.0.8:8080/remote")
        self.assertEqual(context._state_revision, 1)


class AppContextRemoteIdentityTest(unittest.TestCase):
    def make_context(self, root: Path) -> AppContext:
        context = AppContext.__new__(AppContext)
        context._state_change_condition = threading.Condition()
        context._state_revision = 0
        context.store = PlaylistStore(
            root / "state.json",
            root / "backup.json",
            root / "played",
            on_change=context._notify_state_changed,
        )
        context.remote_identities = RemoteIdentityStore(root / "remote_identities.json")
        context._remote_identity_lock = threading.RLock()
        context._rating_submission_lock = threading.RLock()
        context._rating_submission_keys = set()
        context._rating_submission_key_order = deque()
        return context

    @staticmethod
    def prepare_reset_state(context: AppContext) -> None:
        context.cache_manager = SimpleNamespace(clear_runtime_cache=lambda: None)
        context.auto_restored_backup = False
        context._player_control_lock = threading.RLock()
        context._player_control_seq = 0
        context._player_control_ack_seq = 0
        context._player_control_command = None
        context._player_status_lock = threading.RLock()
        context._player_status = None

    def test_register_rename_and_host_delete_identity(self):
        with TemporaryDirectory() as tmpdir:
            context = self.make_context(Path(tmpdir))

            token, registered = context.register_remote_identity("Kevin")
            renamed = context.rename_remote_identity(token, "VZRXS")

            self.assertEqual(registered["name"], "Kevin")
            self.assertEqual(renamed["name"], "VZRXS")
            self.assertEqual(context.store.snapshot()["session_users"], ["VZRXS"])
            context.remove_session_user("VZRXS")
            self.assertFalse(context.remote_identity_snapshot(token)["registered"])

    def test_register_existing_identity_succeeds(self):
        with TemporaryDirectory() as tmpdir:
            context = self.make_context(Path(tmpdir))

            # Register "Kevin" for the first time
            token1, registered1 = context.register_remote_identity("Kevin")
            self.assertEqual(registered1["name"], "Kevin")
            self.assertEqual(context.store.snapshot()["session_users"], ["Kevin"])

            # Register "Kevin" again without claiming (should fail)
            with self.assertRaises(server_module.SessionUserAlreadyExistsError):
                context.register_remote_identity("Kevin", claim=False)

            # Register "Kevin" again with claim=True (should succeed)
            token2, registered2 = context.register_remote_identity("Kevin", claim=True)
            self.assertEqual(registered2["name"], "Kevin")
            self.assertNotEqual(token1, token2)
            self.assertEqual(context.store.snapshot()["session_users"], ["Kevin"])  # No duplicate entries
            self.assertTrue(context.remote_identity_snapshot(token2)["registered"])

    def test_cookie_is_persistent_and_lan_http_compatible(self):
        cookie = BilikaraHandler._remote_identity_cookie("token")

        self.assertIn("bilikara_remote_token=token", cookie)
        self.assertIn("HttpOnly", cookie)
        self.assertIn("Max-Age=31536000", cookie)
        self.assertIn("SameSite=Strict", cookie)
        self.assertNotIn("Secure", cookie)

    def test_clear_data_starts_a_new_remote_session(self):
        with TemporaryDirectory() as tmpdir:
            context = self.make_context(Path(tmpdir))
            self.prepare_reset_state(context)
            token, identity = context.register_remote_identity("Kevin")
            context._rating_submission_keys.add(("kevin", "play-1"))
            context._rating_submission_key_order.append(("kevin", "play-1"))

            context.reset_runtime_data()

            snapshot = context.remote_identity_snapshot(token)
            self.assertFalse(snapshot["registered"])
            self.assertNotEqual(snapshot["session_id"], identity["session_id"])
            self.assertEqual(context.store.snapshot()["session_users"], [])
            self.assertEqual(context._rating_submission_keys, set())
            self.assertEqual(context._rating_submission_key_order, deque())


class AppContextStateRevisionTest(unittest.TestCase):
    def test_background_tasks_include_cloudflare_pool_prewarm(self):
        context = AppContext.__new__(AppContext)
        context._startup_lock = threading.RLock()
        context._startup_started = False
        context._closed = False
        context.cache_manager = SimpleNamespace(prewarm_binary=lambda: None)
        created_threads = []

        class FakeThread:
            def __init__(self, *, target, daemon=False, name=None):
                self.target = target
                self.daemon = daemon
                self.name = name
                self.started = False
                created_threads.append(self)

            def start(self):
                self.started = True

        with (
            patch.object(server_module.threading, "Thread", FakeThread),
            patch.object(server_module, "prewarm_cloudflare_pool") as prewarm,
        ):
            context._start_background_tasks_once()

        prewarm_thread = next((thread for thread in created_threads if thread.name == "bilikara-cloudflare-prewarm"), None)
        self.assertIsNotNone(prewarm_thread)
        self.assertIs(prewarm_thread.target, prewarm)
        self.assertTrue(prewarm_thread.daemon)
        self.assertTrue(prewarm_thread.started)

    def test_startup_gatcha_refresh_bypasses_global_lock_only_once(self):
        context = AppContext.__new__(AppContext)
        context._startup_lock = threading.RLock()
        context._startup_gatcha_refresh_bypass_available = True
        context._state_change_condition = threading.Condition()
        context._state_revision = 0

        with patch("bilikara.server.refresh_gatcha_cache_in_background", return_value=True) as refresh:
            self.assertTrue(context.refresh_startup_gatcha_cache_in_background())
            self.assertTrue(context.refresh_startup_gatcha_cache_in_background())

        self.assertEqual(refresh.call_count, 2)
        self.assertEqual(
            refresh.call_args_list[0].kwargs,
            {
                "use_global_lock": False,
                "upload_default_uids_to_lark": False,
                "startup_schema_rebuild": True,
            },
        )
        self.assertIn("on_start", refresh.call_args_list[1].kwargs)
        self.assertIn("on_done", refresh.call_args_list[1].kwargs)
        self.assertNotIn("use_global_lock", refresh.call_args_list[1].kwargs)

    def test_wait_for_state_change_unblocks_after_notify(self):
        context = AppContext.__new__(AppContext)
        context._closed = False
        context._state_change_condition = threading.Condition()
        context._state_revision = 0

        results: list[bool] = []

        def wait_for_change() -> None:
            results.append(context.wait_for_state_change(0, timeout=1.0))

        worker = threading.Thread(target=wait_for_change)
        worker.start()
        context._notify_state_changed()
        worker.join(timeout=1.0)

        self.assertFalse(worker.is_alive())
        self.assertEqual(results, [True])

    def test_reset_player_state_notifies_after_clearing_player_state(self):
        context = AppContext.__new__(AppContext)
        context._state_change_condition = threading.Condition()
        context._state_revision = 0
        context._player_control_lock = threading.RLock()
        context._player_control_seq = 7
        context._player_control_ack_seq = 0
        context._player_control_command = {"type": "play"}
        context._player_status_lock = threading.RLock()
        context._player_status = {"item_id": "song-a", "current_time": 12.0}
        context.store = SimpleNamespace(reset_player_state=lambda: None)

        context.reset_player_state()

        self.assertEqual(context._state_revision, 1)
        self.assertEqual(context._player_control_ack_seq, 7)
        self.assertIsNone(context._player_control_command)
        self.assertIsNone(context._player_status)


class AppContextRatingSubmissionTest(unittest.TestCase):
    def make_context(self) -> AppContext:
        context = AppContext.__new__(AppContext)
        context._rating_submission_lock = threading.RLock()
        context._rating_submission_keys = set()
        context._rating_submission_key_order = deque()
        return context

    def test_register_rating_submission_dedupes_by_user_and_play_id(self):
        context = self.make_context()

        self.assertTrue(context.register_rating_submission("VZRXS", "song-a"))
        self.assertFalse(context.register_rating_submission("vzrxs", "song-a"))
        self.assertTrue(context.register_rating_submission("Other", "song-a"))
        self.assertTrue(context.register_rating_submission("VZRXS", "song-b"))

    def test_register_rating_submission_rejects_empty_keys(self):
        context = self.make_context()

        self.assertFalse(context.register_rating_submission("", "song-a"))
        self.assertFalse(context.register_rating_submission("   ", "song-a"))
        self.assertFalse(context.register_rating_submission("VZRXS", ""))
        self.assertFalse(context.register_rating_submission("VZRXS", "   "))

    def test_register_rating_submission_drops_old_keys_over_limit(self):
        context = self.make_context()

        with patch.object(server_module, "RATING_SUBMISSION_KEY_LIMIT", 2):
            self.assertTrue(context.register_rating_submission("VZRXS", "song-a"))
            self.assertTrue(context.register_rating_submission("VZRXS", "song-b"))
            self.assertTrue(context.register_rating_submission("VZRXS", "song-c"))

        self.assertNotIn(("vzrxs", "song-a"), context._rating_submission_keys)
        self.assertIn(("vzrxs", "song-b"), context._rating_submission_keys)
        self.assertIn(("vzrxs", "song-c"), context._rating_submission_keys)


class BilikaraHandlerLocalClientTest(unittest.TestCase):
    @staticmethod
    def make_handler(peer_host, local_host="127.0.0.1"):
        handler = BilikaraHandler.__new__(BilikaraHandler)
        handler.client_address = (peer_host, 54321)
        handler.connection = SimpleNamespace(getsockname=lambda: (local_host, 8080))
        return handler

    def test_loopback_clients_are_allowed(self):
        for host in ("127.0.0.1", "::1", "::ffff:127.0.0.1"):
            with self.subTest(host=host):
                self.assertTrue(self.make_handler(host)._is_local_client())

    def test_matching_concrete_local_socket_is_allowed(self):
        handler = self.make_handler("192.168.1.20", "192.168.1.20")
        self.assertTrue(handler._is_local_client())

    def test_other_lan_client_is_rejected(self):
        handler = self.make_handler("192.168.1.35", "192.168.1.20")
        self.assertFalse(handler._is_local_client())

    def test_unspecified_local_socket_rejects_non_loopback_peer(self):
        handler = self.make_handler("192.168.1.20", "0.0.0.0")
        self.assertFalse(handler._is_local_client())

    def test_malformed_peer_is_rejected(self):
        handler = self.make_handler("not-an-ip", "192.168.1.20")
        self.assertFalse(handler._is_local_client())

    def test_missing_connection_is_rejected(self):
        handler = BilikaraHandler.__new__(BilikaraHandler)
        handler.client_address = ("192.168.1.20", 54321)
        self.assertFalse(handler._is_local_client())

    def test_getsockname_failure_is_rejected(self):
        def fail_getsockname():
            raise OSError("socket unavailable")

        handler = BilikaraHandler.__new__(BilikaraHandler)
        handler.client_address = ("192.168.1.20", 54321)
        handler.connection = SimpleNamespace(getsockname=fail_getsockname)
        self.assertFalse(handler._is_local_client())


class AddressArchitectureTest(unittest.TestCase):
    def test_wildcard_bind_uses_loopback_for_local_ui(self):
        self.assertEqual(server_module._local_ui_host("0.0.0.0"), "127.0.0.1")
        self.assertEqual(server_module._local_ui_url("0.0.0.0", 8080), "http://127.0.0.1:8080")

    def test_windows_remote_url_uses_ranked_system_addresses(self):
        with (
            patch.object(server_module.os, "name", "nt"),
            patch(
                "bilikara.server.detect_lan_ipv4_addresses",
                return_value=["192.168.1.20", "192.168.1.21"],
            ),
        ):
            urls = server_module._network_access_urls("0.0.0.0", 8080)

        self.assertEqual(
            urls,
            ["http://192.168.1.20:8080", "http://192.168.1.21:8080"],
        )

    def test_container_runtime_does_not_publish_bridge_address(self):
        with (
            patch.object(server_module.os, "name", "posix"),
            patch("bilikara.server._is_container_runtime", return_value=True),
            patch(
                "bilikara.server.socket.getaddrinfo",
                side_effect=AssertionError("container hostname must not be resolved"),
            ),
        ):
            urls = server_module._network_access_urls("0.0.0.0", 8080)

        self.assertEqual(urls, [])

    def test_native_posix_remote_url_uses_lan_address(self):
        with (
            patch.object(server_module.os, "name", "posix"),
            patch("bilikara.server._is_container_runtime", return_value=False),
            patch(
                "bilikara.server.detect_lan_ipv4_addresses",
                return_value=["192.168.1.20"],
            ),
        ):
            urls = server_module._network_access_urls("0.0.0.0", 8080)

        self.assertEqual(urls, ["http://192.168.1.20:8080"])

    def test_explicit_host_is_honored_for_local_and_remote_urls(self):
        self.assertEqual(
            server_module._local_ui_url("192.168.1.20", 9090),
            "http://192.168.1.20:9090",
        )
        self.assertEqual(
            server_module._network_access_urls("192.168.1.20", 9090),
            ["http://192.168.1.20:9090"],
        )


class AppContextPlayerStatusTest(unittest.TestCase):
    def make_context(self) -> AppContext:
        context = AppContext.__new__(AppContext)
        context._player_status_lock = threading.RLock()
        context._player_status = None
        context._state_change_condition = threading.Condition()
        context._state_revision = 0
        context.store = SimpleNamespace(mark_item_playback_started=lambda item_id: None)
        return context

    def test_player_status_preserves_reported_duration(self):
        context = self.make_context()

        context.update_player_status(
            item_id="song-1",
            is_paused=False,
            current_time=12.0,
            duration=123.4,
        )
        context.update_player_status(
            item_id="song-1",
            is_paused=True,
            current_time=13.0,
        )

        snapshot = context.player_status_snapshot({"id": "song-1"})
        self.assertIsNotNone(snapshot)
        self.assertEqual(snapshot["duration"], 123.4)
        self.assertEqual(snapshot["current_time"], 13.0)


class AppContextPlayerDiagnosticTest(unittest.TestCase):
    def test_recent_events_are_bounded_and_copied(self):
        context = AppContext.__new__(AppContext)
        context._state_change_condition = threading.Condition()
        context._state_revision = 11
        context._player_diagnostic_lock = threading.RLock()
        context._player_diagnostics = deque(
            maxlen=server_module.PLAYER_DIAGNOSTIC_EVENT_LIMIT
        )

        with patch("builtins.print") as stdout_output, patch.object(
            context,
            "_notify_state_changed",
            side_effect=AssertionError(
                "diagnostic recording must not publish a state change"
            ),
        ) as notify_state_changed:
            for sequence in range(server_module.PLAYER_DIAGNOSTIC_EVENT_LIMIT + 3):
                context.record_player_diagnostic(
                    {
                        "event": "sync-none",
                        "sequence": sequence,
                        "unexpected_text": (
                            "https://cdn.example/video.m4s?token=secret"
                            if sequence == server_module.PLAYER_DIAGNOSTIC_EVENT_LIMIT + 2
                            else ""
                        ),
                    }
                )
        stdout_output.assert_not_called()
        notify_state_changed.assert_not_called()
        self.assertEqual(context._state_revision, 11)

        snapshot = context.player_diagnostics_snapshot()
        self.assertEqual(len(snapshot), server_module.PLAYER_DIAGNOSTIC_EVENT_LIMIT)
        self.assertEqual(snapshot[0]["sequence"], 3)
        self.assertEqual(
            snapshot[-1]["sequence"],
            server_module.PLAYER_DIAGNOSTIC_EVENT_LIMIT + 2,
        )
        self.assertEqual(snapshot[-1]["unexpected_text"], "<redacted-url>")
        snapshot[-1]["sequence"] = -1
        self.assertNotEqual(context.player_diagnostics_snapshot()[-1]["sequence"], -1)

    def test_player_diagnostic_text_removes_complete_urls_and_credentials(self):
        message = BilikaraHandler._sanitize_player_diagnostic_text(
            "failed https://cdn.example/video.m4s?token=secret&upsig=signed Cookie: SESSDATA=value",
            500,
        )
        basename = BilikaraHandler._sanitize_player_diagnostic_basename(
            "https://cdn.example/path/video.m4s?token=secret&upsig=signed"
        )

        self.assertEqual(message, "failed <redacted-url> Cookie: [REDACTED]")
        self.assertEqual(basename, "video.m4s")
        self.assertNotIn("secret", message + basename)
        self.assertNotIn("signed", message + basename)

    def test_diagnostic_artifact_receives_recent_events_and_backend_timings(self):
        context = AppContext.__new__(AppContext)
        context._state_revision = 7
        context.store = SimpleNamespace(
            snapshot=lambda: {
                "current_item": None,
                "playlist": [],
                "session_users": [],
                "playback_selector": {"mode": "rust"},
            }
        )
        context.cache_manager = SimpleNamespace(
            cache_metrics=lambda: {},
            policy_snapshot=lambda metrics: {"video_quality": "360P 流畅"},
        )
        context.update_manager = SimpleNamespace(snapshot=lambda: {"status": "idle"})
        context._player_diagnostic_lock = threading.RLock()
        context._player_diagnostics = deque(
            maxlen=server_module.PLAYER_DIAGNOSTIC_EVENT_LIMIT
        )
        for sequence in range(server_module.PLAYER_DIAGNOSTIC_EVENT_LIMIT + 2):
            context.record_player_diagnostic(
                {
                    "event": "waiting",
                    "sequence": sequence,
                    "unexpected_text": (
                        "https://cdn.example/video.m4s?token=secret&upsig=signed"
                        if sequence == server_module.PLAYER_DIAGNOSTIC_EVENT_LIMIT + 1
                        else ""
                    ),
                }
            )
        artifact = DiagnosticArtifact(markdown="diagnostic", files={})
        backend_status = {
            "loaded": True,
            "path": "/Users/alice/private/libbilikara_rust.dylib",
            "error": "token=secret",
            "timing_diagnostics_enabled": True,
            "timing_diagnostics": {
                "select_video_stream": {"rust_ffi_max_seconds": 0.002}
            },
        }

        with patch(
            "bilikara.server.gatcha_task_snapshot", return_value={"busy": False}
        ), patch(
            "bilikara.server.rust_backend.backend_status",
            return_value=backend_status,
        ), patch(
            "bilikara.server.build_diagnostic_artifact", return_value=artifact
        ) as build:
            actual = context.build_diagnostics()

        self.assertIs(actual, artifact)
        runtime_state = build.call_args.kwargs["runtime_state"]
        self.assertEqual(runtime_state["playback_selector"], {"mode": "rust"})
        self.assertEqual(
            runtime_state["rust_backend"],
            {
                "loaded": True,
                "timing_diagnostics_enabled": True,
                "timing_diagnostics": {
                    "select_video_stream": {"rust_ffi_max_seconds": 0.002}
                },
            },
        )
        self.assertNotIn("path", runtime_state["rust_backend"])
        self.assertNotIn("error", runtime_state["rust_backend"])
        recent = runtime_state["recent_player_diagnostics"]
        self.assertEqual(len(recent), server_module.PLAYER_DIAGNOSTIC_EVENT_LIMIT)
        self.assertEqual(recent[0]["sequence"], 2)
        self.assertEqual(recent[-1]["unexpected_text"], "<redacted-url>")
        serialized = repr(recent)
        self.assertNotIn("token=", serialized)
        self.assertNotIn("secret", serialized)
        self.assertNotIn("signed", serialized)

    def test_build_diagnostics_with_real_remote_identity_store(self):
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            log_dir = root / "logs"
            log_dir.mkdir()
            context = AppContext.__new__(AppContext)
            context._closed = False
            context.remote_identities = RemoteIdentityStore(root / "remote_identities.json")
            self.assertFalse(hasattr(context.remote_identities, "registered_user_names"))

            context.store = SimpleNamespace(
                snapshot=lambda: {
                    "current_item": None,
                    "playlist": [],
                    "playback_selector": "auto",
                    "session_users": ["AliceSecretUser"],
                }
            )
            context.update_manager = SimpleNamespace(snapshot=lambda: {})
            context._diagnostic_item_snapshot = lambda item: item
            context._diagnostic_rust_backend_status = lambda: {}
            context.player_diagnostics_snapshot = lambda: []
            context.repair_actions_snapshot = lambda: []
            context.cache_manager = SimpleNamespace(
                diagnostic_snapshot=lambda: {"tools": {}, "tasks": {}},
                cache_metrics=lambda: {},
                policy_snapshot=lambda metrics: {"user": "AliceSecretUser"},
            )
            context._state_revision = 1

            with (
                patch("bilikara.diagnostics.APP_HOME", root),
                patch("bilikara.diagnostics.LOG_DIR", log_dir),
                patch("bilikara.diagnostics.DIAGNOSTIC_CONFIG_FILES", ()),
                patch("bilikara.diagnostics.probe_connectivity", return_value={}),
            ):
                artifact = context.build_diagnostics()

            self.assertIsInstance(artifact, DiagnosticArtifact)
            self.assertNotIn("AliceSecretUser", artifact.markdown)
            with zipfile.ZipFile(io.BytesIO(artifact.zip_bytes())) as archive:
                content = archive.read("download-policy.json").decode("utf-8")
                self.assertNotIn("AliceSecretUser", content)
                self.assertIn("[REDACTED]", content)


class AppContextClientTrackingTest(unittest.TestCase):
    def make_context(self) -> AppContext:
        context = AppContext.__new__(AppContext)
        context._client_lock = threading.RLock()
        context._client_last_seen = {}
        context._host_client_last_seen = {}
        context._host_seen_once = False
        context._client_seen_once = False
        context._no_clients_since = None
        context._shutdown_requested = False
        context._client_stale_seconds = 120.0
        return context

    def test_disconnecting_last_host_client_starts_shutdown_grace_even_if_remote_client_remains(self):
        context = self.make_context()

        context.touch_client("host-client", is_host=True)
        context.touch_client("remote-client", is_host=False)
        context.disconnect_client("host-client")

        self.assertNotIn("host-client", context._client_last_seen)
        self.assertIn("remote-client", context._client_last_seen)
        self.assertEqual(context._host_client_last_seen, {})
        self.assertIsNotNone(context._no_clients_since)


class RunDefaultsTest(unittest.TestCase):
    def test_run_defaults_enable_shutdown_on_last_client(self):
        with patch("bilikara.server._serve") as serve:
            run()

        serve.assert_called_once()
        self.assertTrue(serve.call_args.kwargs["shutdown_on_last_client"])


class PortSelectionTest(unittest.TestCase):
    def test_find_available_port_skips_loopback_conflict_for_wildcard_host(self):
        def can_bind(host: str, port: int) -> bool:
            if (host, port) == ("0.0.0.0", 8080):
                return True
            if (host, port) == ("127.0.0.1", 8080):
                return False
            return True

        with patch("bilikara.server._can_bind_port", side_effect=can_bind):
            port = server_module._find_available_port("0.0.0.0", 8080)

        self.assertEqual(port, 8081)


class PlaylistAddRequestTest(unittest.TestCase):
    def test_add_requires_session_user_before_parsing_video(self):
        handler = BilikaraHandler.__new__(BilikaraHandler)
        context = SimpleNamespace(has_session_users=lambda: False)

        with patch("bilikara.server.CONTEXT", context), patch(
            "bilikara.server.fetch_video_item",
            side_effect=AssertionError("should not parse video before user setup"),
        ) as fetch_video:
            with self.assertRaisesRegex(ValueError, "请先在服务端添加本场 KTV 用户"):
                handler._handle_add(
                    {
                        "url": "https://www.bilibili.com/video/BV1xx411c7mD",
                        "position": "tail",
                        "requester_name": "",
                    }
                )

        fetch_video.assert_not_called()

    def test_successful_add_queues_video_for_cloudflare_indexing(self):
        handler = BilikaraHandler.__new__(BilikaraHandler)
        writes = []
        handler._write_json = lambda payload, status=None: writes.append((payload, status))
        item = SimpleNamespace(
            owner_mid=123,
            bvid="BV1xx411c7mD",
            title="Song title",
            display_title="Display title",
            resolved_url="https://www.bilibili.com/video/BV1xx411c7mD",
            original_url="https://b23.tv/example",
            owner_name="Singer",
            owner_url="https://space.bilibili.com/123",
            cover_url="https://example.com/cover.jpg",
        )
        added = []
        context = SimpleNamespace(
            has_session_users=lambda: True,
            capture_playback_selector=lambda: "rust",
            store=SimpleNamespace(
                session_request_for_item=lambda _item: None,
                active_duplicate_for_item=lambda _item: None,
            ),
            add_item=lambda added_item, **kwargs: added.append((added_item, kwargs)),
            snapshot=lambda: {"playlist": []},
        )

        with patch("bilikara.server.CONTEXT", context), patch(
            "bilikara.server.fetch_video_item",
            return_value=item,
        ), patch("bilikara.server.append_lark_pool_entries_in_background") as append_entries:
            handler._handle_add(
                {
                    "url": item.original_url,
                    "position": "tail",
                    "requester_name": "VZRXS",
                }
            )

        self.assertEqual(len(added), 1)
        append_entries.assert_called_once_with(
            [
                {
                    "mid": "123",
                    "bvid": item.bvid,
                    "title": item.title,
                    "url": item.resolved_url,
                    "owner_name": item.owner_name,
                    "owner_url": item.owner_url,
                    "cover_url": item.cover_url,
                }
            ]
        )
        self.assertEqual(writes, [({"ok": True, "data": {"playlist": []}}, None)])

    def test_missing_bilibili_video_error_deletes_pool_bvid(self):
        handler = BilikaraHandler.__new__(BilikaraHandler)

        with patch(
            "bilikara.server.delete_cloudflare_pool_entry",
            return_value={"success": True, "found": True, "deleted": True},
        ) as delete_entry:
            handler._delete_missing_bvid_from_pool_if_needed(
                {"url": "https://www.bilibili.com/video/BV1VpCJBHEGg"},
                server_module.BilibiliError("啥都木有"),
            )

        delete_entry.assert_called_once_with("BV1VpCJBHEGg")

    def test_other_bilibili_errors_do_not_delete_pool_bvid(self):
        handler = BilikaraHandler.__new__(BilikaraHandler)

        with patch("bilikara.server.delete_cloudflare_pool_entry") as delete_entry:
            handler._delete_missing_bvid_from_pool_if_needed(
                {"url": "https://www.bilibili.com/video/BV1VpCJBHEGg"},
                server_module.BilibiliError("请求太频繁"),
            )

        delete_entry.assert_not_called()


class PlaylistExportRouteTest(unittest.TestCase):
    def test_playlist_csv_and_image_are_unchanged_by_tauri_launch_mode(self):
        def run_export(path, image_payload=None):
            handler = BilikaraHandler.__new__(BilikaraHandler)
            handler.path = path
            handler.headers = {"X-Bilikara-Client": "host-client"}
            writes = []
            handler._write_download = lambda payload, content_type, filename: writes.append(
                (payload, content_type, filename)
            )
            context = SimpleNamespace(
                touch_client=lambda client_id, is_host=True: None,
                history_snapshot=lambda: [{"display_title": "song", "requested_at": 1}],
                session_played_snapshot=lambda: [{"display_title": "song", "requested_at": 1}],
            )
            patches = [
                patch("bilikara.server.CONTEXT", context),
                patch("bilikara.server.time.strftime", return_value="20260728-120000"),
            ]
            if image_payload is not None:
                patches.append(
                    patch(
                        "bilikara.server.playlist_image_export",
                        return_value=image_payload,
                    )
                )
            with patches[0], patches[1]:
                if len(patches) == 3:
                    with patches[2]:
                        handler.do_GET()
                else:
                    handler.do_GET()
            return writes[0]

        cases = [
            ("/api/playlist/export?format=csv&source=played", None),
            (
                "/api/playlist/export?format=image&source=played",
                (b"png", "image/png", "playlist.png"),
            ),
        ]
        for path, image_payload in cases:
            with self.subTest(path=path):
                with patch.dict(server_module.os.environ, {}, clear=False):
                    server_module.os.environ.pop("BILIKARA_LAUNCH_MODE", None)
                    standalone = run_export(path, image_payload)
                with patch.dict(
                    server_module.os.environ,
                    {"BILIKARA_LAUNCH_MODE": "tauri"},
                    clear=False,
                ):
                    tauri = run_export(path, image_payload)
                self.assertEqual(tauri, standalone)

    def test_playlist_export_csv_route_downloads_friendly_csv(self):
        handler = BilikaraHandler.__new__(BilikaraHandler)
        writes: list[dict] = []
        history = [
            {
                "display_title": "Second song",
                "resolved_url": "https://www.bilibili.com/video/BV2xx411c7mD",
                "original_url": "BV2xx411c7mD",
                "requester_name": "Later",
                "owner_name": "Later UP",
                "owner_mid": "67890",
                "request_count": 1,
                "requested_at": 200,
                "part_title": "P2",
            },
            {
                "display_title": "First song",
                "resolved_url": "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
                "original_url": "BV1xx411c7mD",
                "requester_name": "Kevin",
                "owner_name": "μ's",
                "owner_mid": "12345",
                "request_count": 2,
                "requested_at": 100,
                "part_title": "P1",
            },
            {
                "display_title": "Undated song",
                "resolved_url": "https://www.bilibili.com/video/BV3xx411c7mD",
                "requester_name": "No Time",
                "requested_at": 0,
            },
        ]
        context = SimpleNamespace(
            touch_client=lambda client_id, is_host=True: None,
            history_snapshot=lambda: history,
        )

        handler.path = "/api/playlist/export?format=csv"
        handler.headers = {"Host": "127.0.0.1:8080"}
        handler._is_local_client = lambda: self.fail("playlist export must not depend on local authorization")
        handler._write_download = lambda payload, content_type, filename: writes.append(
            {
                "payload": payload,
                "content_type": content_type,
                "filename": filename,
            }
        )

        with patch("bilikara.server.CONTEXT", context), patch(
            "bilikara.server.time.strftime",
            return_value="20260430-123456",
        ):
            handler.do_GET()

        self.assertEqual(writes[0]["content_type"], "text/csv; charset=utf-8")
        self.assertEqual(writes[0]["filename"], "bilikara-history-20260430-123456.csv")
        decoded = writes[0]["payload"].decode("utf-8-sig")
        rows = list(csv.DictReader(io.StringIO(decoded)))
        self.assertEqual([row["标题"] for row in rows], ["First song", "Second song", "Undated song"])
        self.assertEqual(rows[0]["序号"], "1")
        self.assertEqual(rows[0]["BV 号"], "BV1xx411c7mD")
        self.assertEqual(rows[0]["点歌人"], "Kevin")
        self.assertEqual(rows[0]["UP 主"], "μ's")
        self.assertEqual(rows[0]["UP 主 UID"], "12345")
        self.assertEqual(rows[0]["点歌次数"], "2")
        self.assertTrue(rows[0]["播放时间"])
        self.assertEqual(rows[0]["视频链接"], "https://www.bilibili.com/video/BV1xx411c7mD?p=1")
        self.assertEqual(rows[0]["原始链接"], "BV1xx411c7mD")
        self.assertEqual(rows[0]["分P/版本"], "P1")
        self.assertEqual(rows[2]["播放时间"], "")

    def test_playlist_export_image_route_uses_generated_suffix(self):
        handler = BilikaraHandler.__new__(BilikaraHandler)
        writes: list[dict] = []
        context = SimpleNamespace(
            touch_client=lambda client_id, is_host=True: None,
            history_snapshot=lambda: [{"display_title": "song"}],
        )

        handler.path = "/api/playlist/export?format=image"
        handler.headers = {}
        handler._write_download = lambda payload, content_type, filename: writes.append(
            {
                "payload": payload,
                "content_type": content_type,
                "filename": filename,
            }
        )

        with patch("bilikara.server.CONTEXT", context), patch(
            "bilikara.server.time.strftime",
            return_value="20260430-123456",
        ), patch(
            "bilikara.server.playlist_image_export",
            return_value=(b"zip-bytes", "application/zip", "bilikara-playlist-images.zip"),
        ) as image_export:
            handler.do_GET()

        self.assertEqual(writes[0]["payload"], b"zip-bytes")
        self.assertEqual(writes[0]["content_type"], "application/zip")
        self.assertEqual(writes[0]["filename"], "bilikara-history-20260430-123456.zip")
        self.assertEqual(image_export.call_args.kwargs["page_size"], 200)

    def test_playlist_export_played_source_downloads_session_csv(self):
        handler = BilikaraHandler.__new__(BilikaraHandler)
        writes: list[dict] = []
        played = [
            {
                "display_title": "中文歌曲",
                "resolved_url": "https://www.bilibili.com/video/BV9xx411c7mD",
                "requester_name": "小明",
                "requested_at": 300,
            }
        ]
        context = SimpleNamespace(
            touch_client=lambda client_id, is_host=True: None,
            history_snapshot=lambda: (_ for _ in ()).throw(AssertionError("should export played")),
            session_played_snapshot=lambda: played,
        )

        handler.path = "/api/playlist/export?format=csv&source=played"
        handler.headers = {}
        handler._write_download = lambda payload, content_type, filename: writes.append(
            {
                "payload": payload,
                "content_type": content_type,
                "filename": filename,
            }
        )

        with patch("bilikara.server.CONTEXT", context), patch(
            "bilikara.server.time.strftime",
            return_value="20260430-123456",
        ):
            handler.do_GET()

        self.assertEqual(writes[0]["filename"], "bilikara-played-20260430-123456.csv")
        self.assertTrue(writes[0]["payload"].startswith(b"\xef\xbb\xbf"))
        decoded = writes[0]["payload"].decode("utf-8-sig")
        rows = list(csv.DictReader(io.StringIO(decoded)))
        self.assertIn("播放时间", rows[0])
        self.assertEqual(rows[0]["标题"], "中文歌曲")
        self.assertEqual(rows[0]["点歌人"], "小明")

    def test_playlist_export_image_route_applies_selected_page_size(self):
        handler = BilikaraHandler.__new__(BilikaraHandler)
        writes: list[dict] = []
        history = [
            {"display_title": f"Song {index}", "requested_at": index}
            for index in range(160)
        ]
        context = SimpleNamespace(
            touch_client=lambda client_id, is_host=True: None,
            history_snapshot=lambda: history,
        )

        handler.path = "/api/playlist/export?format=image&page_size=150"
        handler.headers = {}
        handler._write_download = lambda payload, content_type, filename: writes.append(
            {
                "payload": payload,
                "content_type": content_type,
                "filename": filename,
            }
        )

        with patch("bilikara.server.CONTEXT", context), patch(
            "bilikara.server.time.strftime",
            return_value="20260430-123456",
        ), patch(
            "bilikara.server.playlist_image_export",
            return_value=(b"image-bytes", "image/png", "bilikara-playlist.png"),
        ) as image_export:
            handler.do_GET()

        self.assertEqual(writes[0]["payload"], b"image-bytes")
        self.assertEqual(image_export.call_args.kwargs["page_size"], 150)

    def test_history_clear_route_returns_fresh_snapshot(self):
        handler = BilikaraHandler.__new__(BilikaraHandler)
        writes: list[dict] = []
        context = SimpleNamespace(
            touch_client=lambda client_id, is_host=True: None,
            clear_history=lambda: writes.append({"cleared": True}),
            snapshot=lambda: {"history": []},
        )

        handler.path = "/api/history/clear"
        handler.headers = {}
        handler._read_json_body = lambda: {}
        handler._write_json = lambda payload, status=None: writes.append(payload)

        with patch("bilikara.server.CONTEXT", context):
            handler.do_POST()

        self.assertEqual(writes[0], {"cleared": True})
        self.assertEqual(writes[1], {"ok": True, "data": {"history": []}})

    def test_history_remove_route_removes_key_and_returns_fresh_snapshot(self):
        handler = BilikaraHandler.__new__(BilikaraHandler)
        writes: list[dict] = []
        removed_keys: list[str] = []
        context = SimpleNamespace(
            touch_client=lambda client_id, is_host=True: None,
            remove_history_entry=lambda key: removed_keys.append(key),
            snapshot=lambda: {"history": [], "session_played": []},
        )

        handler.path = "/api/history/remove"
        handler.headers = {}
        handler._read_json_body = lambda: {"key": "BVSONG:p1"}
        handler._write_json = lambda payload, status=None: writes.append(payload)

        with patch("bilikara.server.CONTEXT", context):
            handler.do_POST()

        self.assertEqual(removed_keys, ["BVSONG:p1"])
        self.assertEqual(writes[0], {"ok": True, "data": {"history": [], "session_played": []}})

    def test_continue_previous_session_route_returns_fresh_snapshot(self):
        handler = BilikaraHandler.__new__(BilikaraHandler)
        writes: list[dict] = []
        continued: list[bool] = []
        context = SimpleNamespace(
            touch_client=lambda client_id, is_host=True: None,
            continue_previous_session=lambda: continued.append(True) or True,
            snapshot=lambda: {
                "previous_session": {"available": False},
                "session_played": [{"item_id": "previous"}],
            },
        )

        handler.path = "/api/session/continue-previous"
        handler.headers = {}
        handler._read_json_body = lambda: {}
        handler._write_json = lambda payload, status=None: writes.append(payload)

        with patch("bilikara.server.CONTEXT", context):
            handler.do_POST()

        self.assertEqual(continued, [True])
        self.assertEqual(
            writes[0],
            {
                "ok": True,
                "data": {
                    "previous_session": {"available": False},
                    "session_played": [{"item_id": "previous"}],
                },
            },
        )


class MediaRangeEvidenceTest(unittest.TestCase):
    @staticmethod
    def _serve(
        payload: bytes,
        range_header: str = "",
        *,
        head_only: bool = False,
    ) -> tuple[int, dict[str, str], bytes]:
        handler = BilikaraHandler.__new__(BilikaraHandler)
        handler.headers = {"Range": range_header} if range_header else {}
        handler.wfile = io.BytesIO()
        response: dict[str, object] = {"status": 0, "headers": {}}
        handler.send_response = lambda status: response.update(status=int(status))
        handler.send_header = lambda name, value: response["headers"].__setitem__(name, value)
        handler.end_headers = lambda: None
        with TemporaryDirectory() as tmpdir:
            media = Path(tmpdir) / "track.bin"
            media.write_bytes(payload)
            handler._stream_file(
                media,
                content_type="application/octet-stream",
                allow_ranges=True,
                head_only=head_only,
            )
        return int(response["status"]), dict(response["headers"]), handler.wfile.getvalue()

    def test_head_dispatches_media_without_body_mode(self):
        handler = BilikaraHandler.__new__(BilikaraHandler)
        handler.path = "/media/song/video.mp4?cache=1"
        calls = []
        handler._serve_media = lambda route, *, head_only=False: calls.append((route, head_only))
        handler._serve_static = lambda route, *, head_only=False: self.fail("media HEAD routed to static")
        handler.do_HEAD()
        self.assertEqual(calls, [("/media/song/video.mp4?cache=1", True)])

    def test_full_response_without_range(self):
        status, headers, body = self._serve(b"0123456789")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Length"], "10")
        self.assertEqual(headers["Accept-Ranges"], "bytes")
        self.assertEqual(body, b"0123456789")

    def test_first_and_middle_closed_ranges(self):
        first = self._serve(b"0123456789", "bytes=0-0")
        middle = self._serve(b"0123456789", "bytes=3-6")
        self.assertEqual(first, (206, {
            "Content-Type": "application/octet-stream",
            "Accept-Ranges": "bytes",
            "Content-Range": "bytes 0-0/10",
            "Content-Length": "1",
        }, b"0"))
        self.assertEqual(middle[0], 206)
        self.assertEqual(middle[1]["Content-Range"], "bytes 3-6/10")
        self.assertEqual(middle[2], b"3456")

    def test_closed_range_end_is_clamped_to_eof(self):
        status, headers, body = self._serve(b"0123456789", "bytes=8-999")
        self.assertEqual(status, 206)
        self.assertEqual(headers["Content-Range"], "bytes 8-9/10")
        self.assertEqual(body, b"89")

    def test_one_byte_file_ranges(self):
        status, headers, body = self._serve(b"x", "bytes=-1")
        self.assertEqual(status, 206)
        self.assertEqual(headers["Content-Range"], "bytes 0-0/1")
        self.assertEqual(body, b"x")

    def test_empty_file_range_is_unsatisfiable(self):
        status, headers, body = self._serve(b"", "bytes=0-")
        self.assertEqual(status, 416)
        self.assertEqual(headers["Content-Range"], "bytes */0")
        self.assertEqual(body, b"")

    def test_suffix_larger_than_file_returns_entire_file_as_partial(self):
        status, headers, body = self._serve(b"0123", "bytes=-99")
        self.assertEqual(status, 206)
        self.assertEqual(headers["Content-Range"], "bytes 0-3/4")
        self.assertEqual(body, b"0123")

    def test_zero_suffix_and_reversed_range_are_rejected(self):
        for range_header in ("bytes=-0", "bytes=5-4", "bytes=-"):
            with self.subTest(range_header=range_header):
                status, headers, body = self._serve(b"0123456789", range_header)
                self.assertEqual(status, 416)
                self.assertEqual(headers["Content-Range"], "bytes */10")
                self.assertEqual(body, b"")

    def test_head_range_has_get_headers_without_body(self):
        status, headers, body = self._serve(b"0123456789", "bytes=2-5", head_only=True)
        self.assertEqual(status, 206)
        self.assertEqual(headers["Content-Range"], "bytes 2-5/10")
        self.assertEqual(headers["Content-Length"], "4")
        self.assertEqual(body, b"")

    def test_open_ended_range_returns_requested_tail(self):
        status, headers, body = self._serve(b"0123456789", "bytes=4-")
        self.assertEqual(status, 206)
        self.assertEqual(headers["Content-Range"], "bytes 4-9/10")
        self.assertEqual(headers["Content-Length"], "6")
        self.assertEqual(body, b"456789")

    def test_suffix_range_returns_final_bytes(self):
        status, headers, body = self._serve(b"0123456789", "bytes=-4")
        self.assertEqual(status, 206)
        self.assertEqual(headers["Content-Range"], "bytes 6-9/10")
        self.assertEqual(headers["Content-Length"], "4")
        self.assertEqual(body, b"6789")

    def test_unsatisfiable_range_returns_416(self):
        status, headers, body = self._serve(b"0123456789", "bytes=99-")
        self.assertEqual(status, 416)
        self.assertEqual(headers["Content-Range"], "bytes */10")
        self.assertEqual(body, b"")

    def test_invalid_range_does_not_fall_back_to_full_response(self):
        status, headers, body = self._serve(b"0123456789", "bytes=invalid")
        self.assertEqual(status, 416)
        self.assertEqual(headers["Content-Range"], "bytes */10")
        self.assertEqual(body, b"")

    def test_multiple_ranges_are_rejected(self):
        status, headers, body = self._serve(b"0123456789", "bytes=0-1,4-5")
        self.assertEqual(status, 416)
        self.assertEqual(headers["Content-Range"], "bytes */10")
        self.assertEqual(body, b"")

class UpdateRouteTest(unittest.TestCase):
    def test_bilikara_secret_verify_uses_local_bilikara_secret_when_set(self):
        handler = BilikaraHandler.__new__(BilikaraHandler)
        writes: list[dict] = []
        context = SimpleNamespace(touch_client=lambda client_id, is_host=True: None)

        handler.path = "/api/bilikara-secret/verify"
        handler.headers = {}
        handler._read_json_body = lambda: {"BILIKARA_ADMIN_SECRET": "local-secret"}
        handler._write_json = lambda payload, status=None: writes.append({"payload": payload, "status": status})

        with patch("bilikara.server.CONTEXT", context), patch.dict(
            "bilikara.server.os.environ",
            {"BILIKARA_ADMIN_SECRET": "local-secret"},
            clear=False,
        ), patch("bilikara.server.verify_cloudflare_bilikara_secret") as cloudflare_verify:
            handler.do_POST()

        cloudflare_verify.assert_not_called()
        self.assertEqual(writes[0]["payload"], {"ok": True, "data": {"verified": True}})

    def test_bilikara_secret_verify_rejects_wrong_local_bilikara_secret(self):
        handler = BilikaraHandler.__new__(BilikaraHandler)
        writes: list[dict] = []
        context = SimpleNamespace(touch_client=lambda client_id, is_host=True: None)

        handler.path = "/api/bilikara-secret/verify"
        handler.headers = {}
        handler._read_json_body = lambda: {"BILIKARA_ADMIN_SECRET": "wrong-secret"}
        handler._write_json = lambda payload, status=None: writes.append({"payload": payload, "status": status})

        with patch("bilikara.server.CONTEXT", context), patch.dict(
            "bilikara.server.os.environ",
            {"BILIKARA_ADMIN_SECRET": "local-secret"},
            clear=False,
        ), patch("bilikara.server.verify_cloudflare_bilikara_secret") as cloudflare_verify:
            handler.do_POST()

        cloudflare_verify.assert_not_called()
        self.assertEqual(writes[0]["status"], server_module.HTTPStatus.FORBIDDEN)

    def test_update_check_route_returns_update_payload(self):
        handler = BilikaraHandler.__new__(BilikaraHandler)
        writes: list[dict] = []
        context = SimpleNamespace(touch_client=lambda client_id, is_host=True: None)

        handler.path = "/api/app/update"
        handler.headers = {}
        handler._write_json = lambda payload, status=None: writes.append(payload)

        with patch("bilikara.server.CONTEXT", context), patch(
            "bilikara.server.check_for_update",
            return_value={
                "current_version": "v0.4.0",
                "latest_version": "v0.4.1",
                "release_url": "https://github.com/VZRXS/bilikara/releases/tag/v0.4.1",
                "update_available": True,
            },
        ) as update_check:
            handler.do_GET()

        self.assertEqual(writes[0]["ok"], True)
        self.assertTrue(writes[0]["data"]["update_available"])
        update_check.assert_called_once_with(include_preview=False)

    def test_update_check_route_can_include_preview_releases(self):
        handler = BilikaraHandler.__new__(BilikaraHandler)
        writes: list[dict] = []
        context = SimpleNamespace(touch_client=lambda client_id, is_host=True: None)

        handler.path = "/api/app/update?include_preview=1"
        handler.headers = {}
        handler._write_json = lambda payload, status=None: writes.append(payload)

        with patch("bilikara.server.CONTEXT", context), patch(
            "bilikara.server.check_for_update",
            return_value={
                "current_version": "v0.4.0",
                "latest_version": "v0.5.0-preview.1",
                "release_url": "https://github.com/VZRXS/bilikara/releases/tag/v0.5.0-preview.1",
                "update_available": True,
                "include_preview": True,
            },
        ) as update_check:
            handler.do_GET()

        self.assertEqual(writes[0]["ok"], True)
        self.assertTrue(writes[0]["data"]["include_preview"])
        update_check.assert_called_once_with(include_preview=True)

    def test_update_status_route_returns_update_snapshot(self):
        handler = BilikaraHandler.__new__(BilikaraHandler)
        writes: list[dict] = []
        context = SimpleNamespace(
            touch_client=lambda client_id, is_host=True: None,
            app_update_snapshot=lambda: {"state": "downloading", "progress": 0.5},
        )

        handler.path = "/api/app/update/status"
        handler.headers = {}
        handler._write_json = lambda payload, status=None: writes.append(payload)

        with patch("bilikara.server.CONTEXT", context):
            handler.do_GET()

        self.assertEqual(writes[0], {"ok": True, "data": {"state": "downloading", "progress": 0.5}})

    def test_update_install_route_starts_background_update(self):
        handler = BilikaraHandler.__new__(BilikaraHandler)
        writes: list[dict] = []
        calls: list[dict] = []

        def start_app_update(*, include_preview=False):
            calls.append({"include_preview": include_preview})
            return {"state": "checking", "include_preview": include_preview}

        context = SimpleNamespace(
            touch_client=lambda client_id, is_host=True: None,
            start_app_update=start_app_update,
        )

        handler.path = "/api/app/update/install"
        handler.headers = {}
        handler._read_json_body = lambda: {"include_preview": True}
        handler._is_local_client = lambda: True
        handler._write_json = lambda payload, status=None: writes.append(payload)

        with patch("bilikara.server.CONTEXT", context):
            handler.do_POST()

        self.assertEqual(calls, [{"include_preview": True}])
        self.assertEqual(writes[0], {"ok": True, "data": {"state": "checking", "include_preview": True}})

    def test_update_install_route_rejects_lan_client(self):
        handler = BilikaraHandler.__new__(BilikaraHandler)
        writes: list[dict] = []
        context = SimpleNamespace(
            touch_client=lambda client_id, is_host=True: None,
            start_app_update=lambda **kwargs: self.fail("LAN client must not start update"),
        )

        handler.path = "/api/app/update/install"
        handler.headers = {}
        handler._read_json_body = lambda: {"include_preview": False}
        handler._is_local_client = lambda: False
        handler._write_json = lambda payload, status=None: writes.append(
            {"payload": payload, "status": status}
        )

        with patch("bilikara.server.CONTEXT", context):
            handler.do_POST()

        self.assertEqual(writes[0]["payload"], {"ok": False, "error": "forbidden"})
        self.assertEqual(writes[0]["status"], server_module.HTTPStatus.FORBIDDEN)


class DownloadResponseTest(unittest.TestCase):
    @staticmethod
    def make_handler():
        handler = BilikaraHandler.__new__(BilikaraHandler)
        handler.status = None
        handler.response_headers = {}
        handler.send_response = lambda status: setattr(handler, "status", status)
        handler.send_header = lambda name, value: handler.response_headers.__setitem__(name, value)
        handler.end_headers = lambda: None
        handler.wfile = io.BytesIO()
        return handler

    def assert_download_response(self, content_type, filename, payload):
        handler = self.make_handler()

        self.assertTrue(
            handler._write_download(payload, content_type=content_type, filename=filename)
        )

        self.assertEqual(handler.status, server_module.HTTPStatus.OK)
        self.assertEqual(handler.response_headers["Content-Type"], content_type)
        self.assertEqual(handler.response_headers["Content-Length"], str(len(payload)))
        self.assertEqual(
            handler.response_headers["Content-Disposition"],
            f'attachment; filename="{filename}"',
        )
        self.assertEqual(handler.response_headers["Cache-Control"], "no-store")
        self.assertEqual(handler.wfile.getvalue(), payload)

    def test_csv_download_headers_and_body_length(self):
        self.assert_download_response(
            "text/csv; charset=utf-8",
            "bilikara-played.csv",
            b"column\r\nvalue\r\n",
        )

    def test_image_download_headers_and_body_length(self):
        self.assert_download_response(
            "image/png",
            "bilikara-played.png",
            b"\x89PNG\r\n\x1a\n",
        )

    def test_export_stage_logs_headers_and_body(self):
        handler = self.make_handler()
        events = []
        context = {
            "started_at": server_module.time.monotonic(),
            "format": "csv",
            "source": "played",
            "item_count": 1,
            "payload_size": 3,
        }
        handler._active_export_context = context
        handler._log_export_stage = lambda stage, active_context, **kwargs: events.append(stage)

        self.assertTrue(handler._write_download(b"csv", content_type="text/csv", filename="list.csv"))

        self.assertEqual(events, ["export_headers_sent", "export_body_written"])

    def test_diagnostics_stage_logs_headers_and_body(self):
        handler = self.make_handler()
        events = []
        context = {
            "started_at": server_module.time.monotonic(),
            "payload_size": 3,
        }
        handler._active_diagnostic_context = context
        handler._log_diagnostics_stage = lambda stage, active_context, **kwargs: events.append(stage)

        self.assertTrue(
            handler._write_download(
                b"zip",
                content_type="application/zip",
                filename="diagnostics.zip",
            )
        )

        self.assertEqual(events, ["diagnostics_headers_sent", "diagnostics_body_written"])

    def test_download_disconnect_is_handled(self):
        class BrokenWriter:
            def write(self, payload):
                raise BrokenPipeError("client closed")

            def flush(self):
                raise AssertionError("flush must not follow a failed write")

        handler = self.make_handler()
        handler.wfile = BrokenWriter()

        self.assertFalse(handler._write_download(b"csv", content_type="text/csv", filename="list.csv"))


class DiagnosticRouteTest(unittest.TestCase):
    @staticmethod
    def make_handler(path, body):
        handler = BilikaraHandler.__new__(BilikaraHandler)
        handler.path = path
        handler.headers = {}
        handler.client_address = ("127.0.0.1", 12345)
        handler.connection = SimpleNamespace(getsockname=lambda: ("127.0.0.1", 8080))
        handler._read_json_body = lambda: body
        return handler

    def test_markdown_route_forwards_browser_info(self):
        handler = self.make_handler(
            "/api/diagnostics/markdown",
            {
                "browser": {
                    "user_agent": "Browser/1.0",
                    "platform": "Windows",
                    "brands": [{"brand": "Browser", "version": "1"}],
                }
            },
        )
        writes = []
        browser_infos = []
        context = SimpleNamespace(
            touch_client=lambda client_id, is_host=True: None,
            build_diagnostics=lambda browser_info: (
                browser_infos.append(browser_info)
                or DiagnosticArtifact(markdown="# report", files={})
            ),
        )
        handler._write_json = lambda payload, status=None: writes.append(payload)

        with patch("bilikara.server.CONTEXT", context):
            handler.do_POST()

        self.assertEqual(writes, [{"ok": True, "data": {"markdown": "# report"}}])
        self.assertEqual(browser_infos[0]["user_agent"], "Browser/1.0")
        self.assertEqual(browser_infos[0]["brands"], [{"brand": "Browser", "version": "1"}])

    def test_package_route_downloads_zip(self):
        handler = self.make_handler("/api/diagnostics/package", {"browser": {}})
        downloads = []
        artifact = DiagnosticArtifact(markdown="# report", files={"system.json": b"{}"})
        context = SimpleNamespace(
            touch_client=lambda client_id, is_host=True: None,
            build_diagnostics=lambda browser_info: artifact,
        )
        handler._write_download = lambda payload, *, content_type, filename: downloads.append(
            {"payload": payload, "content_type": content_type, "filename": filename}
        )

        with patch("bilikara.server.CONTEXT", context):
            handler.do_POST()

        self.assertEqual(downloads[0]["content_type"], "application/zip")
        self.assertTrue(downloads[0]["filename"].startswith("bilikara-diagnostics-"))
        with zipfile.ZipFile(io.BytesIO(downloads[0]["payload"])) as archive:
            self.assertEqual(set(archive.namelist()), {"diagnostics.md", "system.json"})

    def test_package_route_logs_bounded_stages_in_tauri_launch_mode(self):
        handler = self.make_handler("/api/diagnostics/package", {"browser": {}})
        artifact = DiagnosticArtifact(markdown="# report", files={"system.json": b"{}"})
        context = SimpleNamespace(
            touch_client=lambda client_id, is_host=True: None,
            build_diagnostics=lambda browser_info: artifact,
        )
        stages = []
        handler._log_diagnostics_stage = lambda stage, active_context, **kwargs: stages.append(
            (stage, active_context.get("payload_size"), kwargs.get("error"))
        )
        handler._write_download = lambda payload, *, content_type, filename: True

        with patch("bilikara.server.CONTEXT", context), patch.dict(
            server_module.os.environ,
            {"BILIKARA_LAUNCH_MODE": "tauri"},
            clear=False,
        ):
            handler.do_POST()

        self.assertEqual(
            [stage for stage, _, _ in stages],
            [
                "diagnostics_request_started",
                "diagnostics_authorized",
                "diagnostics_artifact_ready",
            ],
        )
        self.assertGreater(stages[-1][1], 0)

    def test_diagnostic_error_sanitizer_redacts_paths_tokens_and_newlines(self):
        error = RuntimeError("failed /home/alice/private.txt token=secret\nnext")
        sanitized = BilikaraHandler._sanitized_diagnostic_error(error)
        self.assertIn("RuntimeError", sanitized)
        self.assertIn("<path>", sanitized)
        self.assertIn("token=<redacted>", sanitized)
        self.assertNotIn("alice", sanitized)
        self.assertNotIn("secret", sanitized)
        self.assertNotIn("\n", sanitized)

    def test_diagnostic_routes_reject_non_local_clients(self):
        handler = self.make_handler("/api/diagnostics/markdown", {"browser": {}})
        handler.client_address = ("192.168.1.50", 12345)
        handler.connection = SimpleNamespace(getsockname=lambda: ("192.168.1.20", 8080))
        writes = []
        context = SimpleNamespace(
            touch_client=lambda client_id, is_host=True: None,
            build_diagnostics=lambda browser_info: self.fail("diagnostics must not be generated"),
        )
        handler._write_json = lambda payload, status=None: writes.append(
            {"payload": payload, "status": status}
        )

        with patch("bilikara.server.CONTEXT", context):
            handler.do_POST()

        self.assertEqual(writes[0]["status"], server_module.HTTPStatus.FORBIDDEN)
        self.assertEqual(writes[0]["payload"], {"ok": False, "error": "forbidden"})

    def test_same_machine_physical_endpoint_allows_markdown_and_package(self):
        artifact = DiagnosticArtifact(markdown="# report", files={"system.json": b"{}"})
        context = SimpleNamespace(
            touch_client=lambda client_id, is_host=True: None,
            build_diagnostics=lambda browser_info: artifact,
        )

        markdown = self.make_handler("/api/diagnostics/markdown", {"browser": {}})
        markdown.client_address = ("192.168.1.20", 12345)
        markdown.connection = SimpleNamespace(getsockname=lambda: ("192.168.1.20", 8080))
        markdown_writes = []
        markdown._write_json = lambda payload, status=None: markdown_writes.append((payload, status))

        package = self.make_handler("/api/diagnostics/package", {"browser": {}})
        package.client_address = ("192.168.1.20", 12345)
        package.connection = SimpleNamespace(getsockname=lambda: ("192.168.1.20", 8080))
        package_downloads = []
        package._write_download = lambda payload, *, content_type, filename: package_downloads.append(
            (payload, content_type, filename)
        )

        with patch("bilikara.server.CONTEXT", context):
            markdown.do_POST()
            package.do_POST()

        self.assertEqual(markdown_writes[0][0]["data"]["markdown"], "# report")
        self.assertEqual(package_downloads[0][1], "application/zip")

    def test_package_route_downloads_real_diagnostics_zip_from_local_authorized_client(self):
        handler = self.make_handler("/api/diagnostics/package", {"browser": {}})
        handler.client_address = ("127.0.0.1", 54321)
        handler.connection = SimpleNamespace(getsockname=lambda: ("127.0.0.1", 8080))
        sent_headers = {}
        written_body = io.BytesIO()

        def fake_send_response(code):
            sent_headers["status"] = code

        def fake_send_header(keyword, value):
            sent_headers[keyword.lower()] = value

        handler.send_response = fake_send_response
        handler.send_header = fake_send_header
        handler.end_headers = lambda: None
        handler.wfile = written_body

        with patch(
            "bilikara.diagnostics.probe_connectivity",
            return_value={"bilibili": {"reachable": True, "status": 200, "latency_ms": 10, "error": ""}},
        ):
            handler.do_POST()

        self.assertEqual(sent_headers.get("status"), 200)
        content_type = sent_headers.get("content-type", "")
        self.assertEqual(content_type.split(";")[0].strip(), "application/zip")
        content_disposition = sent_headers.get("content-disposition", "")
        self.assertTrue(content_disposition.startswith("attachment"))
        filename_part = content_disposition.split("filename=")[-1].strip('"')
        self.assertTrue(filename_part.endswith(".zip"))
        payload = written_body.getvalue()
        content_length = int(sent_headers.get("content-length", "0"))
        self.assertEqual(content_length, len(payload))

        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            self.assertIn("diagnostics.md", archive.namelist())

    def test_is_local_client_unspecified_bind_authorization(self):
        handler = BilikaraHandler.__new__(BilikaraHandler)

        # Allowed case: bound to 0.0.0.0, peer is local host IP 192.168.1.20
        handler.client_address = ("192.168.1.20", 12345)
        handler.connection = SimpleNamespace(getsockname=lambda: ("0.0.0.0", 8080))
        with patch("bilikara.server._local_host_ip_addresses", return_value={ipaddress.ip_address("192.168.1.20")}):
            self.assertTrue(handler._is_local_client())

        # Rejected case: bound to 0.0.0.0, peer is remote IP 192.168.1.50
        handler.client_address = ("192.168.1.50", 12345)
        handler.connection = SimpleNamespace(getsockname=lambda: ("0.0.0.0", 8080))
        with patch("bilikara.server._local_host_ip_addresses", return_value={ipaddress.ip_address("192.168.1.20")}):
            self.assertFalse(handler._is_local_client())

        # Allowed IPv6 unspecified case: bound to ::, peer is local IPv6 fe80::1
        handler.client_address = ("fe80::1", 12345)
        handler.connection = SimpleNamespace(getsockname=lambda: ("::", 8080))
        with patch("bilikara.server._local_host_ip_addresses", return_value={ipaddress.ip_address("fe80::1")}):
            self.assertTrue(handler._is_local_client())


class CacheDownloaderRouteTest(unittest.TestCase):
    def test_cache_downloader_status_route_returns_tool_status(self):
        handler = BilikaraHandler.__new__(BilikaraHandler)
        writes: list[dict] = []
        checked: list[str] = []
        context = SimpleNamespace(
            touch_client=lambda client_id, is_host=True: None,
            cache_downloader_status=lambda download_source: checked.append(download_source) or {"ready": False},
        )

        handler.path = "/api/cache-downloader/status"
        handler.headers = {}
        handler._read_json_body = lambda: {"download_source": "downkyi"}
        handler._write_json = lambda payload, status=None: writes.append(payload)

        with patch("bilikara.server.CONTEXT", context):
            handler.do_POST()

        self.assertEqual(checked, ["downkyi"])
        self.assertEqual(writes[0], {"ok": True, "data": {"ready": False}})

    def test_cache_downloader_prepare_route_returns_tool_status(self):
        handler = BilikaraHandler.__new__(BilikaraHandler)
        writes: list[dict] = []
        prepared: list[str] = []
        context = SimpleNamespace(
            touch_client=lambda client_id, is_host=True: None,
            prepare_cache_downloader=lambda download_source: prepared.append(download_source) or {"ready": True},
        )

        handler.path = "/api/cache-downloader/prepare"
        handler.headers = {}
        handler._read_json_body = lambda: {"download_source": "downkyi"}
        handler._write_json = lambda payload, status=None: writes.append(payload)

        with patch("bilikara.server.CONTEXT", context):
            handler.do_POST()

        self.assertEqual(prepared, ["downkyi"])
        self.assertEqual(writes[0], {"ok": True, "data": {"ready": True}})


class PlayerResetRouteTest(unittest.TestCase):
    def test_player_reset_route_returns_fresh_snapshot(self):
        handler = BilikaraHandler.__new__(BilikaraHandler)
        writes: list[dict] = []
        context = SimpleNamespace(
            touch_client=lambda client_id, is_host=True: None,
            reset_player_state=lambda: writes.append({"reset_player": True}),
            snapshot=lambda: {"playback_mode": "local"},
        )

        handler.path = "/api/player/reset"
        handler.headers = {}
        handler._read_json_body = lambda: {}
        handler._write_json = lambda payload, status=None: writes.append(payload)

        with patch("bilikara.server.CONTEXT", context):
            handler.do_POST()

        self.assertEqual(writes[0], {"reset_player": True})
        self.assertEqual(writes[1], {"ok": True, "data": {"playback_mode": "local"}})


class CacheRetryRouteTest(unittest.TestCase):
    def test_explicit_force_retries_current_item_with_recache(self):
        handler = BilikaraHandler.__new__(BilikaraHandler)
        writes: list[dict] = []
        retries: list[dict] = []
        context = SimpleNamespace(
            touch_client=lambda client_id, is_host=True: None,
            is_current_item=lambda item_id: item_id == "current-song",
            retry_cache_item=lambda item_id, force=False: retries.append(
                {"item_id": item_id, "force": force}
            ),
            snapshot=lambda: {"current_item": {"id": "current-song"}},
        )

        handler.path = "/api/cache/retry"
        handler.headers = {}
        handler._read_json_body = lambda: {"item_id": "current-song", "force": True}
        handler._write_json = lambda payload, status=None: writes.append(payload)

        with patch("bilikara.server.CONTEXT", context):
            handler.do_POST()

        self.assertEqual(retries, [{"item_id": "current-song", "force": True}])
        self.assertEqual(writes[0], {"ok": True, "data": {"current_item": {"id": "current-song"}}})

    def test_current_item_is_not_silently_forced(self):
        handler = BilikaraHandler.__new__(BilikaraHandler)
        retries: list[dict] = []
        context = SimpleNamespace(
            touch_client=lambda client_id, is_host=True: None,
            retry_cache_item=lambda item_id, force=False: retries.append(
                {"item_id": item_id, "force": force}
            ),
            snapshot=lambda: {"current_item": {"id": "current-song"}},
        )

        handler.path = "/api/cache/retry"
        handler.headers = {}
        handler._read_json_body = lambda: {"item_id": "current-song"}
        handler._write_json = lambda payload, status=None: None

        with patch("bilikara.server.CONTEXT", context):
            handler.do_POST()

        self.assertEqual(retries, [{"item_id": "current-song", "force": False}])

    def test_retry_playlist_item_keeps_requested_force_flag(self):
        handler = BilikaraHandler.__new__(BilikaraHandler)
        retries: list[dict] = []
        context = SimpleNamespace(
            touch_client=lambda client_id, is_host=True: None,
            is_current_item=lambda item_id: False,
            retry_cache_item=lambda item_id, force=False: retries.append(
                {"item_id": item_id, "force": force}
            ),
            snapshot=lambda: {"playlist": [{"id": "queued-song"}]},
        )

        handler.path = "/api/cache/retry"
        handler.headers = {}
        handler._read_json_body = lambda: {"item_id": "queued-song"}
        handler._write_json = lambda payload, status=None: None

        with patch("bilikara.server.CONTEXT", context):
            handler.do_POST()

        self.assertEqual(retries, [{"item_id": "queued-song", "force": False}])


class PlayerControlRouteTest(unittest.TestCase):
    def test_next_track_route_issues_player_control_command(self):
        handler = BilikaraHandler.__new__(BilikaraHandler)
        writes: list[dict] = []
        issued: list[dict] = []
        context = SimpleNamespace(
            touch_client=lambda client_id, is_host=True: None,
            issue_player_control=lambda **kwargs: issued.append(kwargs),
            snapshot=lambda: {"player_control_command": issued[-1]},
        )

        handler.path = "/api/player/control"
        handler.headers = {}
        handler._read_json_body = lambda: {
            "action": "next-track",
            "item_id": "song-1",
        }
        handler._write_json = lambda payload, status=None: writes.append(payload)

        with patch("bilikara.server.CONTEXT", context):
            handler.do_POST()

        self.assertEqual(issued[0]["action"], "next-track")
        self.assertEqual(issued[0]["item_id"], "song-1")
        self.assertEqual(writes[0]["data"]["player_control_command"]["action"], "next-track")

    def test_absolute_seek_route_forwards_target_seconds(self):
        handler = BilikaraHandler.__new__(BilikaraHandler)
        writes: list[dict] = []
        issued: list[dict] = []
        context = SimpleNamespace(
            touch_client=lambda client_id, is_host=True: None,
            issue_player_control=lambda **kwargs: issued.append(kwargs),
            snapshot=lambda: {"player_control_command": issued[-1]},
        )

        handler.path = "/api/player/control"
        handler.headers = {}
        handler._read_json_body = lambda: {
            "action": "seek-absolute",
            "item_id": "song-1",
            "target_seconds": 262.5,
        }
        handler._write_json = lambda payload, status=None: writes.append(payload)

        with patch("bilikara.server.CONTEXT", context):
            handler.do_POST()

        self.assertEqual(issued[0]["action"], "seek-absolute")
        self.assertEqual(issued[0]["item_id"], "song-1")
        self.assertEqual(issued[0]["target_seconds"], 262.5)
        self.assertEqual(writes[0]["data"]["player_control_command"]["target_seconds"], 262.5)


class PlaylistResortRouteTest(unittest.TestCase):
    def test_playlist_resort_route_returns_fresh_snapshot(self):
        handler = BilikaraHandler.__new__(BilikaraHandler)
        writes: list[dict] = []
        context = SimpleNamespace(
            touch_client=lambda client_id, is_host=True: None,
            resort_playlist_by_cycle=lambda: writes.append({"resorted": True}),
            snapshot=lambda: {"playlist": ["b", "c", "a"]},
        )

        handler.path = "/api/playlist/resort"
        handler.headers = {}
        handler._read_json_body = lambda: {}
        handler._write_json = lambda payload, status=None: writes.append(payload)

        with patch("bilikara.server.CONTEXT", context):
            handler.do_POST()

        self.assertEqual(writes[0], {"resorted": True})
        self.assertEqual(writes[1], {"ok": True, "data": {"playlist": ["b", "c", "a"]}})


class PlayerKeyShiftRouteTest(unittest.TestCase):
    def test_key_shift_route_returns_fresh_snapshot(self):
        handler = BilikaraHandler.__new__(BilikaraHandler)
        writes: list[dict] = []
        context = SimpleNamespace(
            touch_client=lambda client_id, is_host=True: None,
            set_key_shift=lambda key_shift: writes.append({"set_key_shift": key_shift}),
            snapshot=lambda: {"player_settings": {"key_shift": 3}},
        )

        handler.path = "/api/player/key-shift"
        handler.headers = {}
        handler._read_json_body = lambda: {"key_shift": 3}
        handler._write_json = lambda payload, status=None: writes.append(payload)

        with patch("bilikara.server.CONTEXT", context):
            handler.do_POST()

        self.assertEqual(writes[0], {"set_key_shift": 3})
        self.assertEqual(writes[1], {"ok": True, "data": {"player_settings": {"key_shift": 3}}})


class PlayerAvDelayRouteTest(unittest.TestCase):
    def test_legacy_av_offset_route_uses_persistent_compatibility_setter(self):
        handler = BilikaraHandler.__new__(BilikaraHandler)
        calls: list[object] = []
        context = SimpleNamespace(
            touch_client=lambda client_id, is_host=True: None,
            set_av_offset_ms=lambda offset_ms: calls.append(("set", offset_ms)),
            snapshot=lambda: {"player_settings": {"av_offset_ms": 240}},
        )

        handler.path = "/api/player/av-offset"
        handler.headers = {}
        handler._read_json_body = lambda: {"offset_ms": 240}
        handler._write_json = lambda payload, status=None: calls.append(("write", payload))

        with patch("bilikara.server.CONTEXT", context):
            handler.do_POST()

        self.assertEqual(
            calls,
            [
                ("set", 240),
                ("write", {"ok": True, "data": {"player_settings": {"av_offset_ms": 240}}}),
            ],
        )

    def test_av_delay_action_route_dispatches_structured_rust_action(self):
        handler = BilikaraHandler.__new__(BilikaraHandler)
        writes: list[dict] = []
        actions: list[dict] = []
        decision = {
            "global_delay_ms": 100,
            "local_delay_ms": 50,
            "effective_delay_ms": 150,
            "locked": True,
            "has_local_adjustment": True,
            "lock_button_enabled": True,
        }

        def apply_action(action):
            actions.append(action)
            return decision

        context = SimpleNamespace(
            touch_client=lambda client_id, is_host=True: None,
            apply_av_delay_action=apply_action,
            snapshot=lambda: (_ for _ in ()).throw(
                AssertionError("full snapshot must not be generated")
            ),
        )

        handler.path = "/api/player/av-delay-action"
        handler.headers = {}
        handler._read_json_body = lambda: {"type": "adjust", "delta_ms": 50}
        handler._write_json = lambda payload, status=None: writes.append(payload)

        with patch("bilikara.server.CONTEXT", context):
            handler.do_POST()

        self.assertEqual(actions, [{"type": "adjust", "delta_ms": 50}])
        self.assertEqual(writes, [{"ok": True, "data": decision}])


class AppShutdownRouteTest(unittest.TestCase):
    def test_success_response_is_flushed_before_shutdown_starts(self):
        handler = BilikaraHandler.__new__(BilikaraHandler)
        calls: list[str] = []
        context = SimpleNamespace(
            touch_client=lambda client_id, is_host=True: None,
            request_shutdown=lambda: calls.append("shutdown"),
        )

        handler.path = "/api/app/shutdown"
        handler.headers = {}
        handler._read_json_body = lambda: {}
        handler._is_local_client = lambda: True
        handler._write_json = lambda payload, status=None: calls.append("write")

        with patch("bilikara.server.CONTEXT", context):
            handler.do_POST()

        self.assertEqual(calls, ["write", "shutdown"])


if __name__ == "__main__":
    unittest.main()
