import csv
import io
import json
from collections import deque
import threading
import unittest
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

import bilikara.server as server_module
from bilikara import rust_backend, rust_runtime
import bilikara.diagnostics as diagnostics
from bilikara.diagnostics import DiagnosticArtifact
from bilikara.models import PlaylistItem
from bilikara.remote_identity import RemoteIdentityStore
from bilikara.server import AppContext, BilikaraHandler, run
from bilikara.store import PlaylistStore, PlaylistStoreCommandError


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

    def test_media_route_never_serves_attempt_staging_or_directories(self):
        with TemporaryDirectory() as tmpdir:
            cache_dir = Path(tmpdir) / "cache"
            staging = cache_dir / ".staging" / "attempt-1"
            staging.mkdir(parents=True)
            (staging / "partial.mp4").write_bytes(b"partial")
            handler, writes, streams = self.make_handler()

            with patch("bilikara.server.CACHE_DIR", cache_dir):
                handler._serve_media("/media/.staging/attempt-1/partial.mp4")
                handler._serve_media("/media/.staging/attempt-1")

        self.assertEqual(streams, [])
        self.assertEqual(
            [entry["status"] for entry in writes],
            [server_module.HTTPStatus.NOT_FOUND, server_module.HTTPStatus.NOT_FOUND],
        )

    def test_old_and_new_immutable_artifact_urls_remain_distinct_and_servable(self):
        with TemporaryDirectory() as tmpdir:
            cache_dir = Path(tmpdir) / "cache"
            old_file = cache_dir / "artifacts" / "item" / "set-old" / "video-p1.mp4"
            new_file = cache_dir / "artifacts" / "item" / "set-new" / "video-p1.mp4"
            old_file.parent.mkdir(parents=True)
            new_file.parent.mkdir(parents=True)
            old_file.write_bytes(b"old-version")
            new_file.write_bytes(b"new-version")
            handler, writes, streams = self.make_handler()

            with patch("bilikara.server.CACHE_DIR", cache_dir):
                handler._serve_media("/media/artifacts/item/set-old/video-p1.mp4")
                handler._serve_media("/media/artifacts/item/set-new/video-p1.mp4")

        self.assertEqual(writes, [])
        self.assertEqual(streams, [old_file, new_file])


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
    def test_shutdown_stops_cache_before_uninitializing_appstate(self):
        context = AppContext.__new__(AppContext)
        context._closed = False
        calls: list[str] = []
        context.cache_manager = SimpleNamespace(
            shutdown=lambda: calls.append("cache")
        )
        context.store = SimpleNamespace(shutdown=lambda: calls.append("appstate"))

        context.shutdown()
        context.shutdown()

        self.assertTrue(context._closed)
        self.assertEqual(calls, ["cache", "appstate"])

    def test_background_tasks_include_one_time_prewarm_targets(self):
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
            patch.object(server_module, "prewarm_playlist_export_fonts") as export_prewarm,
        ):
            context._start_background_tasks_once()
            context._start_background_tasks_once()

        prewarm_thread = next((thread for thread in created_threads if thread.name == "bilikara-cloudflare-prewarm"), None)
        self.assertIsNotNone(prewarm_thread)
        self.assertIs(prewarm_thread.target, prewarm)
        self.assertTrue(prewarm_thread.daemon)
        self.assertTrue(prewarm_thread.started)
        export_thread = next(
            (
                thread
                for thread in created_threads
                if thread.name == "bilikara-playlist-export-font-prewarm"
            ),
            None,
        )
        self.assertIsNotNone(export_thread)
        self.assertIs(export_thread.target, export_prewarm)
        self.assertTrue(export_thread.daemon)
        self.assertTrue(export_thread.started)
        self.assertEqual(
            sum(
                thread.name == "bilikara-playlist-export-font-prewarm"
                for thread in created_threads
            ),
            1,
        )

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


class AppContextSsePayloadCacheTest(unittest.TestCase):
    @staticmethod
    def make_context(revision: int = 1) -> AppContext:
        context = AppContext.__new__(AppContext)
        context._state_change_condition = threading.Condition()
        context._state_revision = revision
        context._sse_payload_condition = threading.Condition()
        context._sse_payload_revision = -1
        context._sse_payload = b""
        context._sse_payload_building = False
        return context

    @staticmethod
    def decode_state_event(payload: bytes) -> dict[str, object]:
        lines = payload.decode("utf-8").splitlines()
        data = "\n".join(line.removeprefix("data: ") for line in lines if line.startswith("data: "))
        return json.loads(data)

    def test_same_revision_reuses_one_snapshot_and_serialization(self):
        context = self.make_context(revision=7)
        snapshot_calls = 0

        def snapshot() -> dict[str, object]:
            nonlocal snapshot_calls
            snapshot_calls += 1
            return {"state_revision": context._state_revision, "value": "same"}

        context.snapshot = snapshot

        first_revision, first_payload = context.serialized_sse_state_event()
        second_revision, second_payload = context.serialized_sse_state_event()

        self.assertEqual(snapshot_calls, 1)
        self.assertEqual(first_revision, 7)
        self.assertEqual(second_revision, 7)
        self.assertIs(first_payload, second_payload)
        self.assertEqual(
            self.decode_state_event(first_payload),
            {"state_revision": 7, "value": "same"},
        )

    def test_state_event_carries_authoritative_rust_revision(self):
        context = self.make_context(revision=7)
        context.snapshot = lambda: {
            "revision": 41,
            "session_generation": 3,
            "playback_generation": 9,
            "state_revision": context._state_revision,
        }

        transport_revision, payload = context.serialized_sse_state_event()

        self.assertEqual(transport_revision, 7)
        self.assertEqual(
            self.decode_state_event(payload),
            {
                "revision": 41,
                "session_generation": 3,
                "playback_generation": 9,
                "state_revision": 7,
            },
        )

    def test_revision_change_builds_and_publishes_new_payload(self):
        context = self.make_context(revision=4)
        snapshot_calls = 0

        def snapshot() -> dict[str, object]:
            nonlocal snapshot_calls
            snapshot_calls += 1
            return {
                "state_revision": context._state_revision,
                "value": f"revision-{context._state_revision}",
            }

        context.snapshot = snapshot
        old_revision, old_payload = context.serialized_sse_state_event()

        context._notify_state_changed()
        new_revision, new_payload = context.serialized_sse_state_event()

        self.assertEqual(snapshot_calls, 2)
        self.assertEqual(old_revision, 4)
        self.assertEqual(new_revision, 5)
        self.assertNotEqual(old_payload, new_payload)
        self.assertEqual(
            self.decode_state_event(new_payload),
            {"state_revision": 5, "value": "revision-5"},
        )

    def test_revision_change_during_build_discards_stale_payload(self):
        context = self.make_context(revision=8)
        snapshot_calls = 0

        def snapshot() -> dict[str, object]:
            nonlocal snapshot_calls
            snapshot_calls += 1
            revision = context._state_revision
            if snapshot_calls == 1:
                context._notify_state_changed()
                return {"state_revision": revision, "value": "stale"}
            return {"state_revision": revision, "value": "current"}

        context.snapshot = snapshot

        revision, payload = context.serialized_sse_state_event()

        self.assertEqual(snapshot_calls, 2)
        self.assertEqual(revision, 9)
        self.assertEqual(
            self.decode_state_event(payload),
            {"state_revision": 9, "value": "current"},
        )

    def test_concurrent_cache_miss_has_one_builder_and_shared_result(self):
        context = self.make_context(revision=11)
        worker_count = 12
        start_barrier = threading.Barrier(worker_count + 1)
        builder_started = threading.Event()
        release_builder = threading.Event()
        count_lock = threading.Lock()
        snapshot_calls = 0
        results: list[tuple[int, bytes]] = []
        errors: list[BaseException] = []

        def snapshot() -> dict[str, object]:
            nonlocal snapshot_calls
            with count_lock:
                snapshot_calls += 1
            builder_started.set()
            if not release_builder.wait(timeout=1.0):
                raise TimeoutError("test did not release SSE payload builder")
            return {"state_revision": context._state_revision, "value": "concurrent"}

        def request_payload() -> None:
            try:
                start_barrier.wait(timeout=1.0)
                results.append(context.serialized_sse_state_event())
            except BaseException as exc:
                errors.append(exc)

        context.snapshot = snapshot
        workers = [threading.Thread(target=request_payload) for _ in range(worker_count)]
        for worker in workers:
            worker.start()
        start_barrier.wait(timeout=1.0)
        self.assertTrue(builder_started.wait(timeout=1.0))
        release_builder.set()
        for worker in workers:
            worker.join(timeout=1.0)

        self.assertFalse(errors)
        self.assertTrue(all(not worker.is_alive() for worker in workers))
        self.assertEqual(snapshot_calls, 1)
        self.assertEqual(len(results), worker_count)
        self.assertEqual({revision for revision, _payload in results}, {11})
        self.assertEqual(len({id(payload) for _revision, payload in results}), 1)
        self.assertEqual(
            self.decode_state_event(results[0][1]),
            {"state_revision": 11, "value": "concurrent"},
        )

    def test_failed_build_does_not_poison_cache_or_waiters(self):
        context = self.make_context(revision=3)
        snapshot_calls = 0

        def snapshot() -> dict[str, object]:
            nonlocal snapshot_calls
            snapshot_calls += 1
            if snapshot_calls == 1:
                raise RuntimeError("snapshot failed")
            return {"state_revision": context._state_revision, "value": "recovered"}

        context.snapshot = snapshot

        with self.assertRaisesRegex(RuntimeError, "snapshot failed"):
            context.serialized_sse_state_event()
        revision, payload = context.serialized_sse_state_event()

        self.assertEqual(snapshot_calls, 2)
        self.assertFalse(context._sse_payload_building)
        self.assertEqual(revision, 3)
        self.assertEqual(
            self.decode_state_event(payload),
            {"state_revision": 3, "value": "recovered"},
        )


class StateApiCompatibilityTest(unittest.TestCase):
    def test_host_and_remote_receive_the_same_revisioned_snapshot(self):
        snapshot = {
            "revision": 19,
            "session_generation": 4,
            "playback_generation": 8,
            "playback_program": {
                "item_id": "song-a",
                "item_incarnation_id": "i-exact",
                "selected_audio_variant_id": "instrumental",
                "artifact_set_id": "a-exact",
            },
            "current_item": {"id": "song-a"},
            "playlist": [],
        }
        context = SimpleNamespace(
            touch_client=lambda *_args, **_kwargs: None,
            snapshot=lambda: dict(snapshot),
        )

        def request(referer: str) -> dict[str, object]:
            handler = BilikaraHandler.__new__(BilikaraHandler)
            handler.path = "/api/state"
            handler.headers = {
                "X-Bilikara-Client": "test-client",
                "Referer": referer,
            }
            writes: list[dict[str, object]] = []
            handler._write_json = lambda payload, status=None: writes.append(payload)
            with patch("bilikara.server.CONTEXT", context):
                handler.do_GET()
            return writes[0]

        host = request("http://127.0.0.1:8080/")
        remote = request("http://127.0.0.1:8080/remote")

        self.assertEqual(host, remote)
        self.assertEqual(host["data"]["revision"], 19)
        self.assertEqual(host["data"]["playback_generation"], 8)
        self.assertEqual(host["data"]["playback_program"], snapshot["playback_program"])


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
        temp_dir = TemporaryDirectory()
        self.addCleanup(temp_dir.cleanup)
        root = Path(temp_dir.name)
        context.store = PlaylistStore(
            root / "state.json",
            root / "backup.json",
            root / "played",
            on_change=context._notify_state_changed,
        )
        context.store.add_session_user("Alice")
        context.store.add_item(
            PlaylistItem(
                id="song-1",
                original_url="https://example.test/song-1",
                resolved_url="https://example.test/song-1?p=1",
                bvid="BV0000000001",
                aid=1,
                cid=2,
                page=1,
                title="Song 1",
                part_title="P1",
                display_title="Song 1 - P1",
                cover_url="",
                embed_url="",
            ),
            requester_name="Alice",
        )
        context._state_revision = 0
        return context

    @staticmethod
    def report(
        context: AppContext,
        *,
        generation: int,
        sequence: int,
        current_time: float,
        duration: float = 100.0,
        phase: str = "playing",
        is_paused: bool = False,
    ) -> dict[str, object]:
        return context.update_player_status(
            playback_generation=generation,
            status_sequence=sequence,
            item_id="song-1",
            observed_phase=phase,
            is_paused=is_paused,
            current_time=current_time,
            duration=duration,
            client_info={"platform": "test"},
        )

    def test_ordering_duplicate_and_inverse_arrival_change_revision_only_when_visible(self):
        context = self.make_context()
        generation = context.store.playback_generation

        first = self.report(
            context,
            generation=generation,
            sequence=1,
            current_time=50.0,
        )
        self.assertTrue(first["accepted"])
        self.assertTrue(first["changed"])
        self.assertTrue(context.store.current_item_started)
        self.assertTrue(context.store.session_played[0].threshold_reached)
        self.assertEqual(context._state_revision, 1)

        higher = self.report(
            context,
            generation=generation,
            sequence=2,
            current_time=51.0,
        )
        self.assertTrue(higher["accepted"])
        self.assertTrue(higher["changed"])
        self.assertEqual(context._state_revision, 2)

        duplicate = self.report(
            context,
            generation=generation,
            sequence=2,
            current_time=51.0,
        )
        self.assertTrue(duplicate["accepted"])
        self.assertTrue(duplicate["duplicate"])
        self.assertFalse(duplicate["changed"])
        self.assertEqual(context._state_revision, 2)

        with self.assertRaises(server_module.PlayerStatusAdmissionError) as conflict:
            self.report(
                context,
                generation=generation,
                sequence=2,
                current_time=52.0,
            )
        self.assertEqual(conflict.exception.kind, "player_status_sequence_conflict")
        self.assertEqual(context._state_revision, 2)

        newest = self.report(
            context,
            generation=generation,
            sequence=4,
            current_time=54.0,
        )
        self.assertTrue(newest["changed"])
        self.assertEqual(context._state_revision, 3)
        with self.assertRaises(server_module.PlayerStatusAdmissionError) as stale:
            self.report(
                context,
                generation=generation,
                sequence=3,
                current_time=53.0,
            )
        self.assertEqual(stale.exception.kind, "player_status_sequence_stale")
        self.assertEqual(context._state_revision, 3)

        ordering_only = self.report(
            context,
            generation=generation,
            sequence=5,
            current_time=54.0,
        )
        self.assertTrue(ordering_only["accepted"])
        self.assertFalse(ordering_only["changed"])
        self.assertEqual(context._state_revision, 3)

        snapshot = context.player_status_snapshot(context.store.snapshot())
        self.assertIsNotNone(snapshot)
        self.assertEqual(snapshot["playback_generation"], generation)
        self.assertEqual(snapshot["current_time"], 54.0)
        self.assertNotIn("status_sequence", snapshot)

    def test_program_change_hides_status_and_stale_generation_has_no_side_effect(self):
        context = self.make_context()
        generation = context.store.playback_generation
        self.report(
            context,
            generation=generation,
            sequence=1,
            current_time=0.0,
            phase="ready-paused",
            is_paused=True,
        )
        self.assertFalse(context.store.current_item_started)
        self.assertIsNotNone(
            context.player_status_snapshot(context.store.snapshot())
        )

        context._notify_state_changed()
        same_program = context.store.snapshot()
        self.assertEqual(same_program["playback_generation"], generation)
        self.assertIsNotNone(context.player_status_snapshot(same_program))

        context.store.restart_playback_program()
        replacement = context.store.snapshot()
        self.assertGreater(replacement["playback_generation"], generation)
        self.assertIsNone(context.player_status_snapshot(replacement))
        revision_after_replacement = context._state_revision
        before_rust = context.store.authoritative_snapshot()
        with self.assertRaises(server_module.PlayerStatusAdmissionError) as stale:
            self.report(
                context,
                generation=generation,
                sequence=2,
                current_time=75.0,
            )
        self.assertEqual(stale.exception.kind, "playback_generation_mismatch")
        self.assertEqual(context.store.authoritative_snapshot(), before_rust)
        self.assertEqual(context._state_revision, revision_after_replacement)
        self.assertFalse(context.store.current_item_started)
        self.assertFalse(context.store.session_played[0].threshold_reached)

        current = self.report(
            context,
            generation=replacement["playback_generation"],
            sequence=1,
            current_time=0.0,
            phase="ready-paused",
            is_paused=True,
        )
        self.assertTrue(current["accepted"])
        projected = context.player_status_snapshot(context.store.snapshot())
        self.assertEqual(
            projected["playback_generation"],
            replacement["playback_generation"],
        )


class PlayerStatusRouteTest(unittest.TestCase):
    @staticmethod
    def run_request(
        body: dict[str, object],
        *,
        rejection: server_module.PlayerStatusAdmissionError | None = None,
    ) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
        handler = BilikaraHandler.__new__(BilikaraHandler)
        handler.path = "/api/player/status"
        handler.headers = {}
        handler._read_json_body = lambda: body
        writes: list[dict[str, object]] = []
        calls: list[dict[str, object]] = []
        handler._write_json = lambda payload, status=None: writes.append(
            {"payload": payload, "status": status}
        )
        def update_player_status(**kwargs):
            calls.append(kwargs)
            if rejection is not None:
                raise rejection
            return {"accepted": True, "duplicate": False, "changed": True}

        context = SimpleNamespace(
            touch_client=lambda _client_id, is_host=True: None,
            update_player_status=update_player_status,
        )
        with patch("bilikara.server.CONTEXT", context):
            handler.do_POST()
        return calls, writes

    @staticmethod
    def valid_body() -> dict[str, object]:
        return {
            "playback_generation": 7,
            "status_sequence": 3,
            "item_id": "song-1",
            "observed_phase": "playing",
            "is_paused": False,
            "current_time": 12.5,
            "duration": 100.0,
            "client_info": {"platform": "test"},
        }

    def test_route_forwards_one_normalized_bounded_observation(self):
        calls, writes = self.run_request(self.valid_body())

        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["playback_generation"], 7)
        self.assertEqual(calls[0]["status_sequence"], 3)
        self.assertEqual(calls[0]["observed_phase"], "playing")
        self.assertEqual(calls[0]["current_time"], 12.5)
        self.assertEqual(
            writes,
            [
                {
                    "payload": {
                        "ok": True,
                        "data": {
                            "accepted": True,
                            "duplicate": False,
                            "changed": True,
                        },
                    },
                    "status": None,
                }
            ],
        )

    def test_route_rejects_invalid_identity_phase_and_numeric_bounds(self):
        invalid_cases = [
            ("playback_generation", None),
            ("playback_generation", True),
            ("playback_generation", 0),
            ("playback_generation", 9_007_199_254_740_992),
            ("status_sequence", None),
            ("status_sequence", 0),
            ("status_sequence", 9_007_199_254_740_992),
            ("item_id", 1),
            ("item_id", ""),
            ("item_id", "x" * (server_module.PLAYER_STATUS_ITEM_ID_MAX_BYTES + 1)),
            ("observed_phase", "binding"),
            ("observed_phase", 1),
            ("current_time", -1.0),
            ("current_time", float("nan")),
            ("current_time", float("inf")),
            ("duration", -1.0),
            ("duration", server_module.PLAYER_STATUS_MAX_SECONDS + 1),
        ]
        for field, value in invalid_cases:
            with self.subTest(field=field, value=value):
                body = self.valid_body()
                body[field] = value
                calls, writes = self.run_request(body)
                self.assertEqual(calls, [])
                self.assertEqual(writes[0]["status"], server_module.HTTPStatus.BAD_REQUEST)
                self.assertFalse(writes[0]["payload"]["ok"])

        conflicting = self.valid_body()
        conflicting["is_paused"] = True
        calls, writes = self.run_request(conflicting)
        self.assertEqual(calls, [])
        self.assertEqual(writes[0]["status"], server_module.HTTPStatus.BAD_REQUEST)

    def test_route_maps_typed_stale_status_rejection_to_noop_envelope(self):
        calls, writes = self.run_request(
            self.valid_body(),
            rejection=server_module.PlayerStatusAdmissionError(
                "playback_generation_mismatch",
                "playback program changed",
            ),
        )

        self.assertEqual(len(calls), 1)
        self.assertEqual(
            writes,
            [
                {
                    "payload": {
                        "ok": True,
                        "data": {
                            "accepted": False,
                            "duplicate": False,
                            "changed": False,
                            "reason": "playback_generation_mismatch",
                        },
                    },
                    "status": None,
                }
            ],
        )


class AppContextPlayerDiagnosticTest(unittest.TestCase):
    @staticmethod
    def make_context() -> AppContext:
        context = AppContext.__new__(AppContext)
        context._player_diagnostic_lock = threading.RLock()
        context._player_diagnostic_sequence = 0
        context._player_diagnostics = deque(maxlen=server_module.PLAYER_DIAGNOSTIC_LIMIT)
        return context

    def test_player_diagnostic_ring_is_bounded_and_ordered(self):
        context = self.make_context()

        for index in range(server_module.PLAYER_DIAGNOSTIC_LIMIT + 3):
            context.record_player_diagnostic({"event": f"event-{index}"})

        snapshot = context.player_diagnostic_snapshot()
        self.assertEqual(len(snapshot), server_module.PLAYER_DIAGNOSTIC_LIMIT)
        self.assertEqual(snapshot[0]["sequence"], 4)
        self.assertEqual(snapshot[-1]["sequence"], server_module.PLAYER_DIAGNOSTIC_LIMIT + 3)
        self.assertGreater(snapshot[-1]["received_at_unix_ms"], 0)

    def test_exported_markdown_contains_sanitized_player_startup_event(self):
        context = self.make_context()
        media_url = "https://media.example/audio/track.m4a?token=secret"
        event = server_module._normalize_player_diagnostic(
            {
                "event": "autoplay-audio-play-rejected",
                "media_kind": "audio",
                "error_message": f"NotAllowedError: autoplay denied at {media_url}",
                "url_basename": "track.m4a",
            }
        )
        context.record_player_diagnostic(event)
        context.store = SimpleNamespace(
            snapshot=lambda: {"current_item": None, "playlist": [], "session_users": []}
        )
        context.cache_manager = SimpleNamespace(
            cache_metrics=lambda: {},
            policy_snapshot=lambda metrics: {},
            diagnostic_snapshot=lambda: {"tools": {}, "tasks": {}},
        )
        context.update_manager = SimpleNamespace(snapshot=lambda: {})
        context._state_revision = 1

        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            log_dir = root / "logs"
            log_dir.mkdir()
            with (
                patch.object(diagnostics, "APP_HOME", root),
                patch.object(diagnostics, "LOG_DIR", log_dir),
                patch.object(diagnostics, "DIAGNOSTIC_CONFIG_FILES", ()),
                patch.object(diagnostics, "_local_usernames", return_value=set()),
                patch.object(diagnostics, "probe_connectivity", return_value={}),
                patch.object(
                    diagnostics.shutil,
                    "disk_usage",
                    return_value=SimpleNamespace(total=1000, used=400, free=600),
                ),
                patch("bilikara.server.gatcha_task_snapshot", return_value={}),
            ):
                artifact = context.build_diagnostics()

        self.assertIn("autoplay-audio-play-rejected", artifact.markdown)
        self.assertIn(
            "NotAllowedError: autoplay denied at [REDACTED_MEDIA_URL]",
            artifact.markdown,
        )
        self.assertNotIn(media_url, artifact.markdown)
        self.assertIn('"player_diagnostics"', artifact.markdown)

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
                    "session_users": ["AliceSecretUser"],
                }
            )
            context.update_manager = SimpleNamespace(snapshot=lambda: {})
            context._diagnostic_item_snapshot = lambda item: item
            context._diagnostic_rust_backend_status = lambda: {}
            context.player_diagnostic_snapshot = lambda: []
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
        context._closed = False
        context._active_local_exports = 0
        context._local_export_idle = threading.Event()
        context._local_export_idle.set()
        context._server = None
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

    def test_shutdown_waits_for_the_active_local_export(self):
        context = self.make_context()
        shutdown_called = threading.Event()
        context._server = SimpleNamespace(shutdown=shutdown_called.set)

        self.assertTrue(context.begin_local_export())
        context.request_shutdown()
        self.assertFalse(shutdown_called.wait(0.05))

        context.touch_client("host-client", is_host=True)
        self.assertFalse(context.begin_local_export())

        context.finish_local_export()
        self.assertTrue(shutdown_called.wait(1))

    def test_rejected_local_export_cannot_reopen_shutdown_admission(self):
        context = self.make_context()
        context.request_shutdown()

        self.assertFalse(context.begin_local_export())
        context.touch_client("host-client", is_host=True)

        self.assertFalse(context.begin_local_export())

    def test_shutdown_wait_is_bounded_when_an_export_stalls(self):
        context = self.make_context()
        shutdown_called = threading.Event()
        context._server = SimpleNamespace(shutdown=shutdown_called.set)

        self.assertTrue(context.begin_local_export())
        with patch.object(server_module, "LOCAL_EXPORT_SHUTDOWN_GRACE_SECONDS", 0.05):
            context.request_shutdown()
            self.assertTrue(shutdown_called.wait(1))


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


class PlaybackCapabilityHttpBoundaryTest(unittest.TestCase):
    @staticmethod
    def context():
        return SimpleNamespace(touch_client=lambda _client_id, is_host=True: None)

    def test_removed_processing_backend_routes_are_not_dispatched(self):
        route = "/api/player/" + "playback-" + "selector"
        handler = BilikaraHandler.__new__(BilikaraHandler)
        handler.path = route
        handler.headers = {}
        served = []
        handler._serve_static = lambda value: served.append(value)
        handler._write_json = lambda *_args, **_kwargs: None
        with patch("bilikara.server.CONTEXT", self.context()):
            handler.do_GET()
        self.assertEqual(served, [route])

        writes = []
        handler = BilikaraHandler.__new__(BilikaraHandler)
        handler.path = route
        handler.headers = {}
        handler._read_json_body = lambda: {"mode": "rust"}
        handler._write_json = lambda payload, status=None: writes.append(
            (payload, status)
        )
        with patch("bilikara.server.CONTEXT", self.context()):
            handler.do_POST()
        self.assertEqual(writes[0][1], server_module.HTTPStatus.NOT_FOUND)
        self.assertIn("未知接口", writes[0][0]["error"])

    def test_direct_capability_failure_preserves_stable_503_shape(self):
        handler = BilikaraHandler.__new__(BilikaraHandler)
        handler.path = "/api/playlist/add"
        handler.headers = {}
        handler._read_json_body = lambda: {"url": "https://example.test/video"}
        handler._handle_add = lambda _body: (_ for _ in ()).throw(
            rust_backend.PlaybackCapabilityError("decide_audio_binding")
        )
        writes = []
        handler._write_json = lambda payload, status=None: writes.append(
            (payload, status)
        )

        with patch("bilikara.server.CONTEXT", self.context()):
            handler.do_POST()

        self.assertEqual(writes[0][1], server_module.HTTPStatus.SERVICE_UNAVAILABLE)
        self.assertEqual(
            writes[0][0],
            {
                "ok": False,
                "error": "Rust playback capability failed: decide_audio_binding",
                "code": "playback_capability_failed",
                "capability": "decide_audio_binding",
            },
        )


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
        self.assertEqual(
            added[0][1],
            {
                "position": "tail",
                "requester_name": "VZRXS",
                "allow_repeat": False,
            },
        )
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

    def test_duplicate_add_is_decided_atomically_by_rust_appstate(self):
        handler = BilikaraHandler.__new__(BilikaraHandler)
        item = PlaylistItem(
            id="incoming",
            original_url="https://www.bilibili.com/video/BV1xx411c7mD",
            resolved_url="https://www.bilibili.com/video/BV1xx411c7mD?p=1",
            bvid="BV1xx411c7mD",
            aid=123,
            cid=456,
            page=1,
            title="Song title",
            part_title="P1",
            display_title="Song title - P1",
            cover_url="",
            embed_url="https://player.bilibili.com/player.html?aid=123",
        )
        active = PlaylistItem.from_dict({**item.serialize(), "id": "active"})
        response = {
            "schema_version": 1,
            "status": "rejected",
            "error": {
                "kind": "duplicate_session_request",
                "message": "duplicate",
                "details": {
                    "identity_key": "BV1xx411c7mD:p1:a1",
                    "session_entry": None,
                    "active_item": active.serialize(),
                },
            },
        }
        rust_error = rust_runtime.RustAppStateRejectedError(
            "rejected",
            "duplicate_session_request",
            "duplicate",
            response=response,
        )
        rejection = PlaylistStoreCommandError(rust_error)
        add_calls = []

        def reject_add(added_item, **kwargs):
            add_calls.append((added_item, kwargs))
            raise rejection

        context = SimpleNamespace(
            has_session_users=lambda: True,
            add_item=reject_add,
        )

        with patch("bilikara.server.CONTEXT", context), patch(
            "bilikara.server.fetch_video_item",
            return_value=item,
        ), patch(
            "bilikara.server.append_lark_pool_entries_in_background",
            side_effect=AssertionError("rejected add must not be indexed"),
        ):
            with self.assertRaises(server_module.DuplicateSessionRequestError) as raised:
                handler._handle_add(
                    {
                        "url": item.original_url,
                        "requester_name": "VZRXS",
                        "allow_repeat": False,
                    }
                )

        self.assertEqual(len(add_calls), 1)
        self.assertFalse(add_calls[0][1]["allow_repeat"])
        self.assertIs(raised.exception.item, item)
        self.assertIsNone(raised.exception.session_entry)
        self.assertEqual(raised.exception.active_item.id, "active")

    def test_add_indexing_payload_falls_back_to_display_title_and_original_url(self):
        handler = BilikaraHandler.__new__(BilikaraHandler)
        handler._write_json = lambda payload, status=None: None
        item = SimpleNamespace(
            owner_mid=123,
            bvid="BV1xx411c7mD",
            title="",
            display_title="Display title",
            resolved_url="",
            original_url="https://b23.tv/example",
            owner_name="Singer",
            owner_url="https://space.bilibili.com/123",
            cover_url="https://example.com/cover.jpg",
        )
        context = SimpleNamespace(
            has_session_users=lambda: True,
            store=SimpleNamespace(
                session_request_for_item=lambda _item: None,
                active_duplicate_for_item=lambda _item: None,
            ),
            add_item=lambda *_args, **_kwargs: None,
            snapshot=lambda: {"playlist": []},
        )

        with patch("bilikara.server.CONTEXT", context), patch(
            "bilikara.server.fetch_video_item",
            return_value=item,
        ), patch("bilikara.server.append_lark_pool_entries_in_background") as append_entries:
            handler._handle_add({"url": item.original_url})

        entry = append_entries.call_args.args[0][0]
        self.assertEqual(entry["title"], item.display_title)
        self.assertEqual(entry["url"], item.original_url)

    def test_successful_add_is_not_failed_by_indexing_scheduler_error(self):
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
            store=SimpleNamespace(
                session_request_for_item=lambda _item: None,
                active_duplicate_for_item=lambda _item: None,
            ),
            add_item=lambda added_item, **kwargs: added.append((added_item, kwargs)),
            snapshot=lambda: {"playlist": [item.bvid]},
        )

        with (
            patch("bilikara.server.CONTEXT", context),
            patch("bilikara.server.fetch_video_item", return_value=item),
            patch(
                "bilikara.server.append_lark_pool_entries_in_background",
                side_effect=RuntimeError("scheduler failed"),
            ),
            patch("builtins.print") as mock_print,
        ):
            handler._handle_add({"url": item.original_url})

        self.assertEqual(len(added), 1)
        self.assertEqual(writes, [({"ok": True, "data": {"playlist": [item.bvid]}}, None)])
        mock_print.assert_called_once_with(
            "[bilikara:lark] background append scheduling failed: scheduler failed",
            file=server_module.sys.stderr,
            flush=True,
        )

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
        self.assertEqual(calls, [("/media/song/video.mp4", True)])

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
        handler._write_json = lambda payload, status=None: writes.append(payload)

        with patch("bilikara.server.CONTEXT", context):
            handler.do_POST()

        self.assertEqual(calls, [{"include_preview": True}])
        self.assertEqual(writes[0], {"ok": True, "data": {"state": "checking", "include_preview": True}})


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

    def test_player_diagnostic_route_retains_only_sanitized_bounded_fields(self):
        media_url = "https://media.example/video/track.m4a?token=secret"
        handler = self.make_handler(
            "/api/player/diagnostic",
            {
                "event": "autoplay-audio-play-rejected",
                "media_kind": "audio",
                "current_time": media_url,
                "error_message": f"NotAllowedError: failed to play {media_url}",
                "url_basename": media_url,
                "play_rejection_name": "NotAllowedError",
                "playback_start_state": "starting",
                "local_should_be_playing": True,
                "authorization": "Bearer must-not-be-retained",
            },
        )
        writes = []
        retained = []
        context = SimpleNamespace(
            touch_client=lambda client_id, is_host=True: None,
            record_player_diagnostic=lambda event: retained.append(event)
            or {**event, "sequence": 1, "received_at_unix_ms": 1},
        )
        handler._write_json = lambda payload, status=None: writes.append(payload)

        with patch("bilikara.server.CONTEXT", context), patch("builtins.print"):
            handler.do_POST()

        self.assertEqual(writes, [{"ok": True}])
        self.assertEqual(retained[0]["event"], "autoplay-audio-play-rejected")
        self.assertEqual(retained[0]["play_rejection_name"], "NotAllowedError")
        self.assertEqual(retained[0]["playback_start_state"], "starting")
        self.assertTrue(retained[0]["local_should_be_playing"])
        self.assertIsNone(retained[0]["current_time"])
        self.assertEqual(retained[0]["url_basename"], "track.m4a")
        self.assertIn("[REDACTED_MEDIA_URL]", retained[0]["error_message"])
        self.assertNotIn(media_url, json.dumps(retained[0]))
        self.assertNotIn("authorization", retained[0])

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
    def test_player_reset_route_returns_rust_forced_program_lifetime(self):
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            store = PlaylistStore(
                root / "state.json",
                root / "backup.json",
                root / "played",
            )
            store.add_session_user("Alice")
            store.add_item(
                PlaylistItem(
                    id="song-a",
                    original_url="https://example.test/song-a",
                    resolved_url="https://example.test/song-a?p=1",
                    bvid="BV0000000001",
                    aid=1,
                    cid=2,
                    page=1,
                    title="Song A",
                    part_title="P1",
                    display_title="Song A - P1",
                    cover_url="",
                    embed_url="",
                ),
                requester_name="Alice",
            )
            before = store.authoritative_snapshot()
            handler = BilikaraHandler.__new__(BilikaraHandler)
            writes: list[dict] = []
            context = SimpleNamespace(
                touch_client=lambda client_id, is_host=True: None,
                reset_player_state=store.reset_player_state,
                snapshot=store.snapshot,
            )

            handler.path = "/api/player/reset"
            handler.headers = {}
            handler._read_json_body = lambda: {}
            handler._write_json = lambda payload, status=None: writes.append(payload)

            with patch("bilikara.server.CONTEXT", context):
                handler.do_POST()

            self.assertEqual(len(writes), 1)
            returned = writes[0]["data"]
            self.assertEqual(returned["playback_program"], before["playback_program"])
            self.assertEqual(
                returned["playback_generation"],
                before["playback_generation"] + 1,
            )
            authoritative = store.authoritative_snapshot()
            self.assertEqual(
                returned["playback_program"], authoritative["playback_program"]
            )
            self.assertEqual(
                returned["playback_generation"],
                authoritative["playback_generation"],
            )


class PlayerNextRouteTest(unittest.TestCase):
    @staticmethod
    def run_request(expected_generation: int, authoritative_generation: int) -> tuple[list, dict]:
        program = {"current": "song-b", "queue": ["song-c"]}
        calls: list[int | None] = []
        current_generation = authoritative_generation

        def advance_to_next(playback_generation=None):
            nonlocal current_generation
            calls.append(playback_generation)
            if playback_generation is not None and playback_generation != authoritative_generation:
                response = {
                    "schema_version": 1,
                    "status": "rejected",
                    "error": {
                        "kind": "playback_generation_mismatch",
                        "message": "playback generation changed before Next was applied",
                    },
                }
                raise PlaylistStoreCommandError(
                    rust_runtime.RustAppStateRejectedError(
                        "rejected",
                        "playback_generation_mismatch",
                        "playback generation changed before Next was applied",
                        response=response,
                    )
                )
            program["current"] = program["queue"].pop(0)
            current_generation += 1

        context = SimpleNamespace(
            touch_client=lambda _client_id, is_host=True: None,
            advance_to_next=advance_to_next,
            snapshot=lambda: {
                "state_revision": 99,
                "playback_generation": current_generation,
                "current_item": {"id": program["current"]},
            },
        )
        handler = BilikaraHandler.__new__(BilikaraHandler)
        handler.path = "/api/player/next"
        handler.headers = {}
        handler._read_json_body = lambda: {
            "playback_generation": expected_generation,
            "state_revision": 1,
        }
        writes = []
        handler._write_json = lambda payload, status=None: writes.append((payload, status))

        with patch("bilikara.server.CONTEXT", context):
            handler.do_POST()

        return calls, {"program": program, "writes": writes}

    def test_stale_generation_next_rejects_without_skipping_authoritative_current(self):
        calls, result = self.run_request(7, 8)

        self.assertEqual(calls, [7])
        self.assertEqual(result["program"], {"current": "song-b", "queue": ["song-c"]})
        self.assertIsNone(result["writes"][0][1])
        self.assertTrue(result["writes"][0][0]["ok"])
        self.assertTrue(result["writes"][0][0]["stale"])

    def test_exact_generation_ignores_python_state_revision_and_advances_once(self):
        calls, result = self.run_request(8, 8)

        self.assertEqual(calls, [8])
        self.assertEqual(result["program"], {"current": "song-c", "queue": []})
        self.assertIsNone(result["writes"][0][1])
        self.assertEqual(result["writes"][0][0]["data"]["state_revision"], 99)


class PlayerRestartProgramRouteTest(unittest.TestCase):
    def test_local_host_restart_returns_one_settings_preserving_lifetime(self):
        before = {
            "state_revision": 4,
            "revision": 8,
            "playback_generation": 5,
            "playback_program": {"item_id": "song-a"},
            "player_settings": {"volume_percent": 37, "is_muted": True},
        }
        after = {
            **before,
            "state_revision": 5,
            "revision": 9,
            "playback_generation": 6,
        }
        restarts: list[bool] = []
        writes: list[tuple[dict, object]] = []
        context = SimpleNamespace(
            touch_client=lambda client_id, is_host=True: None,
            restart_playback_program=lambda: restarts.append(True),
            snapshot=lambda: after,
        )
        handler = BilikaraHandler.__new__(BilikaraHandler)
        handler.path = "/api/player/restart-program"
        handler.headers = {"X-Bilikara-Client": "host-client"}
        handler._is_local_client = lambda: True
        handler._read_json_body = lambda: {}
        handler._write_json = lambda payload, status=None: writes.append((payload, status))

        with patch("bilikara.server.CONTEXT", context):
            handler.do_POST()

        self.assertEqual(restarts, [True])
        self.assertEqual(writes, [({"ok": True, "data": after}, None)])
        self.assertEqual(after["playback_program"], before["playback_program"])
        self.assertEqual(after["player_settings"], before["player_settings"])
        self.assertEqual(after["revision"], before["revision"] + 1)
        self.assertEqual(
            after["playback_generation"], before["playback_generation"] + 1
        )

    def test_nonlocal_remote_cannot_restart_program(self):
        writes: list[tuple[dict, object]] = []
        context = SimpleNamespace(
            touch_client=lambda client_id, is_host=True: None,
            restart_playback_program=lambda: self.fail("remote restart must be rejected"),
            snapshot=lambda: self.fail("remote restart must not return a snapshot"),
        )
        handler = BilikaraHandler.__new__(BilikaraHandler)
        handler.path = "/api/player/restart-program"
        handler.headers = {"Referer": "http://192.168.1.20:8080/remote"}
        handler._is_local_client = lambda: False
        handler._read_json_body = lambda: {}
        handler._write_json = lambda payload, status=None: writes.append((payload, status))

        with patch("bilikara.server.CONTEXT", context):
            handler.do_POST()

        self.assertEqual(
            writes,
            [({"ok": False, "error": "forbidden"}, server_module.HTTPStatus.FORBIDDEN)],
        )
        controller = (Path(__file__).resolve().parents[1] / "static" / "controller.js").read_text(
            encoding="utf-8"
        )
        remote = (Path(__file__).resolve().parents[1] / "static" / "remote.js").read_text(
            encoding="utf-8"
        )
        self.assertNotIn("/api/player/restart-program", controller)
        self.assertNotIn("/api/player/restart-program", remote)


class CacheRetryRouteTest(unittest.TestCase):
    def test_explicit_force_retries_current_item_with_recache(self):
        handler = BilikaraHandler.__new__(BilikaraHandler)
        writes: list[dict] = []
        retries: list[dict] = []
        context = SimpleNamespace(
            touch_client=lambda client_id, is_host=True: None,
            is_current_item=lambda item_id: item_id == "current-song",
            retry_cache_item=lambda item_id, force=False, **kwargs: retries.append(
                {"item_id": item_id, "force": force, **kwargs}
            ),
            snapshot=lambda: {"current_item": {"id": "current-song"}},
        )

        handler.path = "/api/cache/retry"
        handler.headers = {}
        handler._read_json_body = lambda: {
            "item_id": "current-song",
            "expected_item_incarnation_id": "i-current",
            "force": True,
        }
        handler._write_json = lambda payload, status=None: writes.append(payload)

        with patch("bilikara.server.CONTEXT", context):
            handler.do_POST()

        self.assertEqual(
            retries,
            [
                {
                    "item_id": "current-song",
                    "expected_item_incarnation_id": "i-current",
                    "force": True,
                }
            ],
        )
        self.assertEqual(writes[0], {"ok": True, "data": {"current_item": {"id": "current-song"}}})

    def test_current_item_is_not_silently_forced(self):
        handler = BilikaraHandler.__new__(BilikaraHandler)
        retries: list[dict] = []
        context = SimpleNamespace(
            touch_client=lambda client_id, is_host=True: None,
            retry_cache_item=lambda item_id, force=False, **kwargs: retries.append(
                {"item_id": item_id, "force": force, **kwargs}
            ),
            snapshot=lambda: {"current_item": {"id": "current-song"}},
        )

        handler.path = "/api/cache/retry"
        handler.headers = {}
        handler._read_json_body = lambda: {
            "item_id": "current-song",
            "expected_item_incarnation_id": "i-current",
        }
        handler._write_json = lambda payload, status=None: None

        with patch("bilikara.server.CONTEXT", context):
            handler.do_POST()

        self.assertEqual(
            retries,
            [
                {
                    "item_id": "current-song",
                    "expected_item_incarnation_id": "i-current",
                    "force": False,
                }
            ],
        )

    def test_retry_playlist_item_keeps_requested_force_flag(self):
        handler = BilikaraHandler.__new__(BilikaraHandler)
        retries: list[dict] = []
        context = SimpleNamespace(
            touch_client=lambda client_id, is_host=True: None,
            is_current_item=lambda item_id: False,
            retry_cache_item=lambda item_id, force=False, **kwargs: retries.append(
                {"item_id": item_id, "force": force, **kwargs}
            ),
            snapshot=lambda: {"playlist": [{"id": "queued-song"}]},
        )

        handler.path = "/api/cache/retry"
        handler.headers = {}
        handler._read_json_body = lambda: {
            "item_id": "queued-song",
            "expected_item_incarnation_id": "i-queued",
        }
        handler._write_json = lambda payload, status=None: None

        with patch("bilikara.server.CONTEXT", context):
            handler.do_POST()

        self.assertEqual(
            retries,
            [
                {
                    "item_id": "queued-song",
                    "expected_item_incarnation_id": "i-queued",
                    "force": False,
                }
            ],
        )

    def test_stale_retry_is_consumed_once_without_retargeting_the_replacement(self):
        handler = BilikaraHandler.__new__(BilikaraHandler)
        writes: list[tuple[dict, object]] = []
        retries: list[dict] = []

        def reject_stale(item_id, force=False, **kwargs):
            retries.append({"item_id": item_id, "force": force, **kwargs})
            response = {
                "schema_version": 1,
                "status": "rejected",
                "error": {
                    "kind": "item_incarnation_mismatch",
                    "message": "cache item changed before retry",
                },
            }
            raise PlaylistStoreCommandError(
                rust_runtime.RustAppStateRejectedError(
                    "rejected",
                    "item_incarnation_mismatch",
                    "cache item changed before retry",
                    response=response,
                )
            )

        context = SimpleNamespace(
            touch_client=lambda client_id, is_host=True: None,
            retry_cache_item=reject_stale,
            snapshot=lambda: {
                "revision": 9,
                "current_item": {
                    "id": "same-song",
                    "item_incarnation_id": "i-new",
                },
            },
        )
        handler.path = "/api/cache/retry"
        handler.headers = {}
        handler._read_json_body = lambda: {
            "item_id": "same-song",
            "expected_item_incarnation_id": "i-old",
            "force": True,
        }
        handler._write_json = lambda payload, status=None: writes.append(
            (payload, status)
        )

        with patch("bilikara.server.CONTEXT", context):
            handler.do_POST()

        self.assertEqual(
            retries,
            [
                {
                    "item_id": "same-song",
                    "expected_item_incarnation_id": "i-old",
                    "force": True,
                }
            ],
        )
        self.assertEqual(len(writes), 1)
        self.assertIsNone(writes[0][1])
        self.assertTrue(writes[0][0]["ok"])
        self.assertTrue(writes[0][0]["stale"])
        self.assertEqual(
            writes[0][0]["data"]["current_item"]["item_incarnation_id"],
            "i-new",
        )

    def test_retry_requires_an_exact_item_incarnation(self):
        handler = BilikaraHandler.__new__(BilikaraHandler)
        writes: list[tuple[dict, object]] = []
        retries: list[dict] = []
        context = SimpleNamespace(
            touch_client=lambda client_id, is_host=True: None,
            retry_cache_item=lambda *args, **kwargs: retries.append(kwargs),
            snapshot=lambda: {},
        )
        handler.path = "/api/cache/retry"
        handler.headers = {}
        handler._read_json_body = lambda: {"item_id": "same-song", "force": True}
        handler._write_json = lambda payload, status=None: writes.append(
            (payload, status)
        )

        with patch("bilikara.server.CONTEXT", context):
            handler.do_POST()

        self.assertEqual(retries, [])
        self.assertEqual(writes[0][1], server_module.HTTPStatus.BAD_REQUEST)


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
            "playback_generation": 17,
        }
        handler._write_json = lambda payload, status=None: writes.append(payload)

        with patch("bilikara.server.CONTEXT", context):
            handler.do_POST()

        self.assertEqual(issued[0]["action"], "next-track")
        self.assertEqual(issued[0]["item_id"], "song-1")
        self.assertEqual(issued[0]["playback_generation"], 17)
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
            "playback_generation": 23,
        }
        handler._write_json = lambda payload, status=None: writes.append(payload)

        with patch("bilikara.server.CONTEXT", context):
            handler.do_POST()

        self.assertEqual(issued[0]["action"], "seek-absolute")
        self.assertEqual(issued[0]["item_id"], "song-1")
        self.assertEqual(issued[0]["target_seconds"], 262.5)
        self.assertEqual(issued[0]["playback_generation"], 23)
        self.assertEqual(writes[0]["data"]["player_control_command"]["target_seconds"], 262.5)

    def test_program_relative_control_requires_an_exact_playback_generation(self):
        handler = BilikaraHandler.__new__(BilikaraHandler)
        writes: list[tuple[dict, object]] = []
        issued: list[dict] = []
        context = SimpleNamespace(
            touch_client=lambda client_id, is_host=True: None,
            issue_player_control=lambda **kwargs: issued.append(kwargs),
            snapshot=lambda: {},
        )

        handler.path = "/api/player/control"
        handler.headers = {}
        handler._read_json_body = lambda: {
            "action": "seek-relative",
            "item_id": "song-1",
            "delta_seconds": 15,
        }
        handler._write_json = lambda payload, status=None: writes.append((payload, status))

        with patch("bilikara.server.CONTEXT", context):
            handler.do_POST()

        self.assertEqual(issued, [])
        self.assertEqual(writes[0][1], server_module.HTTPStatus.BAD_REQUEST)


class PlayerAudioVariantRouteTest(unittest.TestCase):
    @staticmethod
    def rejection(kind: str) -> PlaylistStoreCommandError:
        response = {
            "schema_version": 1,
            "status": "rejected",
            "error": {"kind": kind, "message": "stale audio target"},
        }
        return PlaylistStoreCommandError(
            rust_runtime.RustAppStateRejectedError(
                "rejected",
                kind,
                "stale audio target",
                response=response,
            )
        )

    def test_audio_variant_forwards_the_exact_item_incarnation(self):
        handler = BilikaraHandler.__new__(BilikaraHandler)
        writes: list[dict] = []
        calls: list[dict] = []
        context = SimpleNamespace(
            touch_client=lambda client_id, is_host=True: None,
            set_audio_variant=lambda item_id, variant_id, **kwargs: calls.append(
                {
                    "item_id": item_id,
                    "variant_id": variant_id,
                    **kwargs,
                }
            )
            or True,
            snapshot=lambda: {"revision": 4},
        )

        handler.path = "/api/player/audio-variant"
        handler.headers = {}
        handler._read_json_body = lambda: {
            "item_id": "song-1",
            "variant_id": "instrumental",
            "expected_item_incarnation_id": "i-exact",
        }
        handler._write_json = lambda payload, status=None: writes.append(payload)

        with patch("bilikara.server.CONTEXT", context):
            handler.do_POST()

        self.assertEqual(
            calls,
            [
                {
                    "item_id": "song-1",
                    "variant_id": "instrumental",
                    "expected_item_incarnation_id": "i-exact",
                }
            ],
        )
        self.assertEqual(writes, [{"ok": True, "data": {"revision": 4}}])

    def test_stale_audio_variant_is_consumed_without_retry_or_user_error(self):
        handler = BilikaraHandler.__new__(BilikaraHandler)
        writes: list[tuple[dict, object]] = []
        calls: list[dict] = []

        def reject_stale(item_id, variant_id, **kwargs):
            calls.append({"item_id": item_id, "variant_id": variant_id, **kwargs})
            raise self.rejection("item_incarnation_mismatch")

        context = SimpleNamespace(
            touch_client=lambda client_id, is_host=True: None,
            set_audio_variant=reject_stale,
            snapshot=lambda: {"revision": 9, "current_item": {"id": "song-1"}},
        )
        handler.path = "/api/player/audio-variant"
        handler.headers = {}
        handler._read_json_body = lambda: {
            "item_id": "song-1",
            "variant_id": "instrumental",
            "expected_item_incarnation_id": "i-old",
        }
        handler._write_json = lambda payload, status=None: writes.append((payload, status))

        with patch("bilikara.server.CONTEXT", context):
            handler.do_POST()

        self.assertEqual(len(calls), 1)
        self.assertEqual(
            writes,
            [
                (
                    {
                        "ok": True,
                        "data": {"revision": 9, "current_item": {"id": "song-1"}},
                        "stale": True,
                    },
                    None,
                )
            ],
        )

    def test_audio_variant_requires_an_item_incarnation(self):
        handler = BilikaraHandler.__new__(BilikaraHandler)
        writes: list[tuple[dict, object]] = []
        calls: list[dict] = []
        context = SimpleNamespace(
            touch_client=lambda client_id, is_host=True: None,
            set_audio_variant=lambda *args, **kwargs: calls.append(kwargs),
            snapshot=lambda: {},
        )
        handler.path = "/api/player/audio-variant"
        handler.headers = {}
        handler._read_json_body = lambda: {
            "item_id": "song-1",
            "variant_id": "instrumental",
        }
        handler._write_json = lambda payload, status=None: writes.append((payload, status))

        with patch("bilikara.server.CONTEXT", context):
            handler.do_POST()

        self.assertEqual(calls, [])
        self.assertEqual(writes[0][1], server_module.HTTPStatus.BAD_REQUEST)


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
