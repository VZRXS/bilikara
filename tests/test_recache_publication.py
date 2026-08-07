import json
import tempfile
import threading
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import MagicMock, patch
from http import HTTPStatus

from bilikara.cache import CacheManager, MEDIA_LEASE_COORDINATOR
from bilikara.models import PlaylistItem
from bilikara.store import PlaylistStore
from bilikara.server import AppContext


class RecachePublicationTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root_dir = Path(self.temp_dir.name)
        self.store_path = self.root_dir / "state.json"
        self.backup_path = self.root_dir / "backup.json"
        self.store = PlaylistStore(self.store_path, self.backup_path)
        self.store.add_session_user("TestUser")
        self.cache_dir = self.root_dir / "cache"
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        MEDIA_LEASE_COORDINATOR.active_release_requests.clear()
        MEDIA_LEASE_COORDINATOR.draining_revisions.clear()
        MEDIA_LEASE_COORDINATOR.acknowledged_requests.clear()

    def tearDown(self):
        MEDIA_LEASE_COORDINATOR.active_release_requests.clear()
        MEDIA_LEASE_COORDINATOR.draining_revisions.clear()
        MEDIA_LEASE_COORDINATOR.acknowledged_requests.clear()
        self.temp_dir.cleanup()

    def _create_ready_item(self, item_id="test-id"):
        item = PlaylistItem(
            id=item_id,
            original_url="https://www.bilibili.com/video/BV123456",
            resolved_url="https://www.bilibili.com/video/BV123456",
            title="Test Song",
            aid=123,
            bvid="BV123456",
            cid=111,
            page=1,
            part_title="Part 1",
            display_title="Test Song",
            cover_url="https://img.bilibili.com/cover.jpg",
            embed_url="",
            cache_status="ready",
            video_relative_path=f"{item_id}/video.mp4",
            video_media_url=f"/media/{item_id}/video.mp4?rev=rev-old",
            media_revision="rev-old",
            audio_variants=[
                {
                    "id": "default",
                    "audio_relative_path": f"{item_id}/audio.m4a",
                    "audio_url": f"/media/{item_id}/audio.m4a?rev=rev-old",
                }
            ],
            selected_audio_variant_id="default",
            requester_name="TestUser",
        )
        self.store.add_item(item, requester_name="TestUser")
        item_dir = self.cache_dir / item_id
        item_dir.mkdir(parents=True, exist_ok=True)
        (item_dir / "video.mp4").write_bytes(b"old-video")
        (item_dir / "audio.m4a").write_bytes(b"old-audio")
        return item

    @contextmanager
    def _manager(self):
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), \
             patch.object(CacheManager, "_load_cache_policy", return_value=None), \
             patch.object(CacheManager, "_cleanup_stale_staging_and_obsolete", return_value=None), \
             patch("bilikara.cache.threading.Thread"):
            manager = CacheManager(self.store)
            try:
                yield manager
            finally:
                # The real shutdown intentionally clears the runtime cache;
                # this fixture uses a mocked worker and must inspect files.
                manager.stop_event.set()

    def _cache_result(self, staging_dir: Path) -> dict:
        video = staging_dir / "video.mp4"
        audio = staging_dir / "audio.m4a"
        video.write_bytes(b"new-video")
        audio.write_bytes(b"new-audio")
        audio_relative = audio.name
        return {
            "video_file": video,
            "audio_variants": [{
                "id": "default",
                "audio_relative_path": audio_relative,
                "audio_url": f"/media/{audio_relative}",
            }],
            "selected_audio_variant_id": "default",
        }

    def _run_recache(
        self,
        manager: CacheManager,
        item_id: str,
        *,
        download=None,
        release_wait=None,
        drain_wait=None,
    ) -> bool:
        item = self.store.get_item(item_id)
        self.assertIsNotNone(item)
        with manager.lock:
            manager.desired_ids = {item_id}
        download_side_effect = download or (
            lambda _item, _binary, _ffmpeg, staging, *_args, **_kwargs: self._cache_result(staging)
        )
        with patch.object(manager, "_ensure_downloader", return_value=Path("downloader")), \
             patch.object(manager, "_ensure_ffmpeg", return_value=Path("ffmpeg")), \
             patch.object(manager, "_download_selected_streams", side_effect=download_side_effect), \
             patch.object(manager, "_validate_cache_result", return_value=None), \
             patch.object(manager, "_should_cache", return_value=True), \
             patch.object(MEDIA_LEASE_COORDINATOR, "wait_for_release", side_effect=release_wait or (lambda *_args, **_kwargs: True)), \
             patch.object(MEDIA_LEASE_COORDINATOR, "wait_for_drain", side_effect=drain_wait or (lambda *_args, **_kwargs: True)):
            return manager._cache_item_multi(item_id, item, allow_refresh_retry=False)

    def test_retry_item_ready_preserves_published_fields_until_release(self):
        item = self._create_ready_item("item-ready")
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), \
             patch.object(CacheManager, "_load_cache_policy", return_value=None), \
             patch.object(CacheManager, "_cleanup_stale_staging_and_obsolete", return_value=None), \
             patch.object(CacheManager, "_is_in_cache_window", return_value=True), \
             patch("bilikara.cache.threading.Thread"):
            manager = CacheManager(self.store)
            manager.retry_item("item-ready", force=True)
            updated = self.store.get_item("item-ready")
            # Immediate release request created, but active media URLs and revision remain visible for release matching
            self.assertIsNotNone(self.store.media_release_request)
            self.assertEqual(self.store.media_release_request["item_id"], "item-ready")
            self.assertEqual(self.store.media_release_request["media_revision"], "rev-old")
            self.assertEqual(updated.cache_status, "pending")
            self.assertEqual(updated.video_relative_path, "item-ready/video.mp4")
            self.assertIn("video.mp4", updated.video_media_url)
            self.assertEqual(updated.media_revision, "rev-old")

    def test_repeated_retry_during_downloading_does_not_create_empty_revision_release_request(self):
        item = PlaylistItem(
            id="item-downloading",
            original_url="https://www.bilibili.com/video/BV123456",
            resolved_url="https://www.bilibili.com/video/BV123456",
            title="Test Song",
            aid=123,
            bvid="BV123456",
            cid=111,
            page=1,
            part_title="Part 1",
            display_title="Test Song",
            cover_url="",
            embed_url="",
            cache_status="downloading",
            video_relative_path="",
            media_revision="",
            requester_name="TestUser",
        )
        self.store.add_item(item, requester_name="TestUser")
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), \
             patch.object(CacheManager, "_load_cache_policy", return_value=None), \
             patch.object(CacheManager, "_cleanup_stale_staging_and_obsolete", return_value=None), \
             patch.object(CacheManager, "_is_in_cache_window", return_value=True), \
             patch("bilikara.cache.threading.Thread"):
            manager = CacheManager(self.store)
            with manager.lock:
                manager.pending_ids.add("item-downloading")
                manager.active_builds["item-downloading"] = "build-1"
            manager.retry_item("item-downloading", force=True)
            self.assertIsNone(self.store.media_release_request)
            with manager.lock:
                self.assertIn("item-downloading", manager.retry_requested_ids)

    def test_retry_item_failed_clears_published_fields(self):
        item = PlaylistItem(
            id="item-failed",
            original_url="https://www.bilibili.com/video/BV123456",
            resolved_url="https://www.bilibili.com/video/BV123456",
            title="Test Song",
            aid=123,
            bvid="BV123456",
            cid=111,
            page=1,
            part_title="Part 1",
            display_title="Test Song",
            cover_url="",
            embed_url="",
            cache_status="failed",
            video_relative_path="item-failed/video.mp4",
            requester_name="TestUser",
        )
        self.store.add_item(item, requester_name="TestUser")
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), \
             patch.object(CacheManager, "_load_cache_policy", return_value=None), \
             patch.object(CacheManager, "_cleanup_stale_staging_and_obsolete", return_value=None), \
             patch.object(CacheManager, "_is_in_cache_window", return_value=True), \
             patch("bilikara.cache.threading.Thread"):
            manager = CacheManager(self.store)
            with patch.object(manager, "_remove_cache_dir") as mock_rm:
                manager.retry_item("item-failed")
                updated = self.store.get_item("item-failed")
                self.assertEqual(updated.cache_status, "pending")
                self.assertEqual(updated.video_relative_path, "")
                mock_rm.assert_called_once_with("item-failed")

    def test_head_get_preserve_query_string(self):
        from bilikara.server import BilikaraHandler
        handler = BilikaraHandler.__new__(BilikaraHandler)
        handler.path = "/media/test-id/video.mp4?rev=rev123"
        handler.headers = {}
        with patch.object(handler, "_serve_media") as mock_serve:
            handler.do_HEAD()
            mock_serve.assert_called_once_with("/media/test-id/video.mp4?rev=rev123", head_only=True)

        with patch.object(handler, "_serve_media") as mock_serve:
            handler.do_GET()
            mock_serve.assert_called_once_with("/media/test-id/video.mp4?rev=rev123")

    def test_serve_media_stale_revision_returns_410(self):
        from bilikara.server import BilikaraHandler
        item = self._create_ready_item("item-rev")
        item.media_revision = "rev-new"
        self.store.update_item("item-rev", media_revision="rev-new")

        context = AppContext()
        context.store = self.store

        item_dir = self.cache_dir / "item-rev"
        item_dir.mkdir(parents=True, exist_ok=True)
        (item_dir / "video.mp4").unlink(missing_ok=True)

        handler = BilikaraHandler.__new__(BilikaraHandler)
        handler.headers = {}
        handler.send_response = MagicMock()
        handler.send_header = MagicMock()
        handler.end_headers = MagicMock()
        handler._write_json = MagicMock()
        handler._stream_file = MagicMock()

        with patch("bilikara.server.CONTEXT", context), \
             patch("bilikara.server.CACHE_DIR", self.cache_dir):
            handler._serve_media("/media/item-rev/video.mp4?rev=rev-old")
            handler.send_response.assert_called_once_with(HTTPStatus.GONE)
            handler._stream_file.assert_not_called()

    def test_serve_media_current_revision_streams_file(self):
        from bilikara.server import BilikaraHandler
        item = self._create_ready_item("item-rev2")
        item.media_revision = "rev-current"
        self.store.update_item("item-rev2", media_revision="rev-current")

        context = AppContext()
        context.store = self.store

        item_dir = self.cache_dir / "item-rev2"
        item_dir.mkdir(parents=True, exist_ok=True)
        (item_dir / "video.mp4").touch()

        handler = BilikaraHandler.__new__(BilikaraHandler)
        handler.headers = {}
        handler._stream_file = MagicMock()

        with patch("bilikara.server.CONTEXT", context), \
             patch("bilikara.server.CACHE_DIR", self.cache_dir):
            handler._serve_media("/media/item-rev2/video.mp4?rev=rev-current")
            handler._stream_file.assert_called_once()

    def test_media_lease_is_registered_before_open_and_unregistered_on_stream_error(self):
        from bilikara.server import BilikaraHandler

        self._create_ready_item("item-lease")
        self.store.update_item("item-lease", media_revision="rev-lease")
        context = AppContext()
        context.store = self.store
        events = []
        handler = BilikaraHandler.__new__(BilikaraHandler)
        handler.headers = {}

        def stream(*_args, **_kwargs):
            events.append("open")
            raise ConnectionError("client disconnected")

        handler._stream_file = stream
        with patch("bilikara.server.CONTEXT", context), \
             patch("bilikara.server.CACHE_DIR", self.cache_dir), \
             patch.object(MEDIA_LEASE_COORDINATOR, "register_reader", side_effect=lambda *_args: events.append("register") or True), \
             patch.object(MEDIA_LEASE_COORDINATOR, "unregister_reader", side_effect=lambda *_args: events.append("unregister")):
            with self.assertRaises(ConnectionError):
                handler._serve_media("/media/item-lease/video.mp4?rev=rev-lease")
        self.assertEqual(events, ["register", "open", "unregister"])

    def test_role_race_current_item_generation_increment(self):
        gen0 = self.store.current_item_generation
        item1 = self._create_ready_item("item-1")
        gen1 = self.store.current_item_generation
        self.assertGreater(gen1, gen0)

        self.store.advance_to_next()
        gen2 = self.store.current_item_generation
        self.assertGreater(gen2, gen1)

    def test_public_retry_failure_sets_failed_cache_status_and_clears_revision(self):
        self._create_ready_item("item-failure")
        with self._manager() as manager, \
             patch.object(manager, "_ensure_downloader", side_effect=RuntimeError("offline")), \
             patch.object(manager, "_should_cache", return_value=True):
            with manager.lock:
                manager.desired_ids = {"item-failure"}
            result = manager._cache_item_multi(
                "item-failure",
                self.store.get_item("item-failure"),
                allow_refresh_retry=False,
            )
        item = self.store.get_item("item-failure")
        self.assertFalse(result)
        self.assertEqual(item.cache_status, "failed")
        self.assertEqual(item.media_revision, "")

    def test_destructive_recache_deletes_old_cache_before_downloader_and_ffmpeg_preflight(self):
        self._create_ready_item("item-preflight-order")
        events = []

        original_remove = CacheManager._remove_cache_dir_for_forced_retry
        def fake_remove(m, item_id):
            events.append("delete_old_cache")
            return original_remove(m, item_id)

        def fake_downloader(m, source):
            events.append("ensure_downloader")
            return Path("downloader")

        def fake_ffmpeg(m, force_refresh=False):
            events.append("ensure_ffmpeg")
            return Path("ffmpeg")

        staging = self.cache_dir / "staging"
        staging.mkdir(parents=True, exist_ok=True)
        with self._manager() as manager, \
             patch.object(CacheManager, "_is_in_cache_window", return_value=True), \
             patch.object(CacheManager, "_remove_cache_dir_for_forced_retry", fake_remove), \
             patch.object(CacheManager, "_ensure_downloader", fake_downloader), \
             patch.object(CacheManager, "_ensure_ffmpeg", fake_ffmpeg), \
             patch.object(manager, "_download_selected_streams", return_value=self._cache_result(staging)), \
             patch.object(manager, "_validate_cache_result", return_value=None), \
             patch.object(manager, "_should_cache", return_value=True), \
             patch.object(MEDIA_LEASE_COORDINATOR, "wait_for_release", return_value=True):
            manager.retry_item("item-preflight-order", force=True)
            result = manager._cache_item_multi(
                "item-preflight-order",
                self.store.get_item("item-preflight-order"),
                allow_refresh_retry=False,
            )
            self.assertTrue(result)
            self.assertEqual(events, ["delete_old_cache", "ensure_downloader", "ensure_ffmpeg"])

    def test_downloader_failure_after_deletion_leaves_old_physical_media_deleted_and_revision_cleared(self):
        self._create_ready_item("item-dl-fail")
        with self._manager() as manager, \
             patch.object(CacheManager, "_is_in_cache_window", return_value=True), \
             patch.object(CacheManager, "_ensure_downloader", side_effect=RuntimeError("downloader binary missing")), \
             patch.object(manager, "_should_cache", return_value=True), \
             patch.object(MEDIA_LEASE_COORDINATOR, "wait_for_release", return_value=True):
            manager.retry_item("item-dl-fail", force=True)
            result = manager._cache_item_multi(
                "item-dl-fail",
                self.store.get_item("item-dl-fail"),
                allow_refresh_retry=False,
            )
            self.assertFalse(result)
            item = self.store.get_item("item-dl-fail")
            self.assertEqual(item.cache_status, "failed")
            self.assertEqual(item.media_revision, "")
            self.assertFalse((self.cache_dir / "item-dl-fail").exists())

    def test_ffmpeg_failure_after_deletion_leaves_old_physical_media_deleted_and_revision_cleared(self):
        self._create_ready_item("item-ff-fail")
        with self._manager() as manager, \
             patch.object(CacheManager, "_is_in_cache_window", return_value=True), \
             patch.object(CacheManager, "_ensure_downloader", return_value=Path("downloader")), \
             patch.object(CacheManager, "_ensure_ffmpeg", side_effect=RuntimeError("ffmpeg missing")), \
             patch.object(manager, "_should_cache", return_value=True), \
             patch.object(MEDIA_LEASE_COORDINATOR, "wait_for_release", return_value=True):
            manager.retry_item("item-ff-fail", force=True)
            result = manager._cache_item_multi(
                "item-ff-fail",
                self.store.get_item("item-ff-fail"),
                allow_refresh_retry=False,
            )
            self.assertFalse(result)
            item = self.store.get_item("item-ff-fail")
            self.assertEqual(item.cache_status, "failed")
            self.assertEqual(item.media_revision, "")
            self.assertFalse((self.cache_dir / "item-ff-fail").exists())

    def test_successful_publication_uses_revision_directory_and_only_then_replaces_store(self):
        self._create_ready_item("item-success")
        with self._manager() as manager:
            result = self._run_recache(manager, "item-success")
        item = self.store.get_item("item-success")
        self.assertTrue(result)
        self.assertEqual(item.cache_status, "ready")
        self.assertNotEqual(item.media_revision, "rev-old")
        self.assertEqual(item.video_relative_path, "item-success/video.mp4")
        self.assertEqual((self.cache_dir / item.video_relative_path).read_bytes(), b"new-video")

    def test_successful_current_item_forced_recache_cleans_release_coordinator_and_context(self):
        self._create_ready_item("item-clean")
        with self._manager() as manager, \
             patch.object(CacheManager, "_is_in_cache_window", return_value=True):
            manager.retry_item("item-clean", force=True)
            release_req = self.store.media_release_request
            self.assertIsNotNone(release_req)
            release_req_id = release_req["request_id"]
            MEDIA_LEASE_COORDINATOR.ack_release_request(release_req_id, "item-clean", "rev-old")

            result = self._run_recache(manager, "item-clean")
            self.assertTrue(result)

            item = self.store.get_item("item-clean")
            self.assertEqual(item.cache_status, "ready")
            self.assertNotEqual(item.media_revision, "rev-old")
            self.assertTrue((self.cache_dir / item.video_relative_path).exists())
            self.assertIsNone(self.store.media_release_request)

            with MEDIA_LEASE_COORDINATOR.lock:
                self.assertNotIn(release_req_id, MEDIA_LEASE_COORDINATOR.active_release_requests)
                self.assertNotIn(release_req_id, MEDIA_LEASE_COORDINATOR.acknowledged_requests)
                self.assertNotIn("rev-old", MEDIA_LEASE_COORDINATOR.draining_revisions)
            self.assertNotIn("item-clean", manager.active_recache_contexts)

    def test_marker_cleanup_failure_keeps_committed_new_revision_serviceable(self):
        self._create_ready_item("item-marker-locked")
        original_unlink = Path.unlink

        def lock_marker(path, *args, **kwargs):
            if path.name.startswith(".tx_"):
                raise PermissionError("marker locked")
            return original_unlink(path, *args, **kwargs)

        with self._manager() as manager, patch.object(Path, "unlink", lock_marker):
            result = self._run_recache(manager, "item-marker-locked")
        item = self.store.get_item("item-marker-locked")
        markers = list(self.cache_dir.glob(".tx_*.json"))
        self.assertTrue(result)
        self.assertNotEqual(item.media_revision, "rev-old")
        self.assertEqual((self.cache_dir / item.video_relative_path).read_bytes(), b"new-video")
        self.assertEqual(len(markers), 1)
        with self._manager() as manager:
            self.assertTrue(manager._recover_publication_transaction(markers[0]))
        self.assertFalse(markers[0].exists())
        self.assertEqual(self.store.get_item("item-marker-locked").media_revision, item.media_revision)

    def test_store_publication_failure_sets_failed_cache_status(self):
        self._create_ready_item("item-store-failure")
        original_update = self.store.update_item

        def fail_new_revision(item_id, **changes):
            if changes.get("media_revision") not in {None, ""}:
                raise OSError("state disk full")
            return original_update(item_id, **changes)

        with self._manager() as manager, patch.object(
            self.store,
            "update_item",
            side_effect=fail_new_revision,
        ):
            result = self._run_recache(manager, "item-store-failure")
        item = self.store.get_item("item-store-failure")
        self.assertFalse(result)
        self.assertEqual(item.cache_status, "failed")
        self.assertEqual(item.media_revision, "")
        self.assertEqual(list(self.cache_dir.glob(".tx_*.json")), [])

    def test_supersession_during_release_wait_never_publishes_completed_old_build(self):
        self._create_ready_item("item-superseded")

        def supersede_during_wait(*_args, **_kwargs):
            with manager.lock:
                manager.active_builds["item-superseded"] = "newer-build"
            return True

        with self._manager() as manager:
            result = self._run_recache(
                manager,
                "item-superseded",
                release_wait=supersede_during_wait,
            )
        item = self.store.get_item("item-superseded")
        self.assertFalse(result)
        self.assertEqual(item.cache_status, "pending")
        self.assertEqual(item.media_revision, "")

    def test_release_timeout_does_not_restore_old_ready_revision(self):
        self._create_ready_item("item-timeout")
        with self._manager() as manager:
            result = self._run_recache(
                manager,
                "item-timeout",
                release_wait=lambda *_args, **_kwargs: False,
            )
        item = self.store.get_item("item-timeout")
        self.assertFalse(result)
        self.assertEqual(item.cache_status, "failed")
        self.assertEqual(item.media_revision, "")

    def test_notification_failure_sets_failed_status(self):
        self._create_ready_item("item-notify-failure")
        self.store.on_change = MagicMock(
            side_effect=[None, None, None, RuntimeError("SSE unavailable"), None, None]
        )
        with self._manager() as manager:
            result = self._run_recache(manager, "item-notify-failure")
        item = self.store.get_item("item-notify-failure")
        self.assertFalse(result)
        self.assertEqual(item.cache_status, "failed")

    def test_rename_failure_removes_staging_and_sets_failed_status(self):
        self._create_ready_item("item-rename-failure")
        original_rename = Path.rename

        def fail_staging_rename(path, target):
            if ".staging" in path.parts:
                raise PermissionError("file locked")
            return original_rename(path, target)

        with self._manager() as manager, patch.object(Path, "rename", fail_staging_rename):
            result = self._run_recache(manager, "item-rename-failure")
        item = self.store.get_item("item-rename-failure")
        self.assertFalse(result)
        self.assertEqual(item.cache_status, "failed")
        self.assertEqual(item.media_revision, "")
        staging_item_root = self.cache_dir / ".staging" / "item-rename-failure"
        self.assertFalse(staging_item_root.exists() and any(staging_item_root.iterdir()))

    def test_noncurrent_item_becoming_current_aborts_before_unreleased_swap(self):
        self._create_ready_item("placeholder")
        self._create_ready_item("item-role-race")

        def become_current(_revision, timeout):
            self.assertTrue(self.store.move_to_front("item-role-race"))
            return True

        with self._manager() as manager, patch.object(
            MEDIA_LEASE_COORDINATOR,
            "wait_for_drain",
            side_effect=become_current,
        ):
            item = self.store.get_item("item-role-race")
            with manager.lock:
                manager.desired_ids = {"item-role-race"}
            with patch.object(manager, "_ensure_downloader", return_value=Path("downloader")), \
                 patch.object(manager, "_ensure_ffmpeg", return_value=Path("ffmpeg")), \
                 patch.object(manager, "_download_selected_streams", side_effect=lambda _i, _b, _f, s, *_a, **_k: self._cache_result(s)), \
                 patch.object(manager, "_validate_cache_result", return_value=None), \
                 patch.object(manager, "_should_cache", return_value=True):
                result = manager._cache_item_multi("item-role-race", item, allow_refresh_retry=False)
        current = self.store.get_item("item-role-race")
        self.assertFalse(result)
        self.assertTrue(self.store.is_current_item("item-role-race"))
        self.assertEqual(current.cache_status, "failed")

    def test_role_transition_waits_without_holding_store_lock_during_publication(self):
        self._create_ready_item("item-reserved")
        is_current, generation = self.store.capture_current_item_role("item-reserved")
        token = self.store.begin_current_item_publication(
            "item-reserved",
            expected_is_current=is_current,
            expected_generation=generation,
        )
        self.assertIsNotNone(token)
        started = threading.Event()
        finished = threading.Event()

        def advance():
            started.set()
            self.store.advance_to_next()
            finished.set()

        worker = threading.Thread(target=advance)
        worker.start()
        self.assertTrue(started.wait(1))
        self.assertFalse(finished.wait(0.05))
        self.store.finish_current_item_publication(token)
        self.assertTrue(finished.wait(1))
        worker.join(timeout=1)

    def test_startup_recovery_preserves_old_store_when_files_were_only_renamed(self):
        self._create_ready_item("item-recover")
        final_dir = self.cache_dir / "item-recover" / "revisions" / "rev-new"
        final_dir.mkdir(parents=True)
        (final_dir / "video.mp4").write_bytes(b"candidate")
        old_state = CacheManager._publication_store_state(self.store.get_item("item-recover"))
        new_state = dict(old_state)
        new_state.update({
            "video_relative_path": "item-recover/revisions/rev-new/video.mp4",
            "video_media_url": "/media/item-recover/revisions/rev-new/video.mp4?rev=rev-new",
            "media_revision": "rev-new",
        })
        marker = self.cache_dir / ".tx_item-recover_build.json"
        marker.write_text(json.dumps({
            "item_id": "item-recover",
            "phase": "files_published",
            "staging_dir": ".staging/item-recover/build",
            "final_dir": "item-recover/revisions/rev-new",
            "old_store_state": old_state,
            "new_store_state": new_state,
        }), encoding="utf-8")
        with self._manager() as manager:
            self.assertTrue(manager._recover_publication_transaction(marker))
        item = self.store.get_item("item-recover")
        self.assertEqual(item.media_revision, "rev-old")
        self.assertTrue((self.cache_dir / "item-recover" / "video.mp4").exists())
        self.assertFalse(final_dir.exists())
        self.assertFalse(marker.exists())

    def test_forced_recache_release_timeout_fails_without_restoring_old_ready_revision(self):
        self._create_ready_item("item-timeout")
        with self._manager() as manager, \
             patch.object(CacheManager, "_is_in_cache_window", return_value=True), \
             patch.object(MEDIA_LEASE_COORDINATOR, "wait_for_release", return_value=False), \
             patch.object(manager, "_should_cache", return_value=True):
            manager.retry_item("item-timeout", force=True)
            updated_start = self.store.get_item("item-timeout")
            self.assertEqual(updated_start.cache_status, "pending")

            with manager.lock:
                manager.desired_ids = {"item-timeout"}
            result = manager._cache_item_multi(
                "item-timeout",
                self.store.get_item("item-timeout"),
                allow_refresh_retry=False,
            )
            self.assertFalse(result)
            failed_item = self.store.get_item("item-timeout")
            self.assertEqual(failed_item.cache_status, "failed")
            self.assertEqual(failed_item.media_revision, "")
            self.assertIsNone(self.store.media_release_request)
            self.assertEqual(len(MEDIA_LEASE_COORDINATOR.active_release_requests), 0)

    def test_old_revision_deleted_before_new_download_starts(self):
        self._create_ready_item("item-del-before-download")
        item_dir = self.cache_dir / "item-del-before-download"
        item_dir.mkdir(parents=True, exist_ok=True)
        (item_dir / "video.mp4").write_bytes(b"old-video")

        deleted_before_download = False

        def fake_download(item, binary_path, ffmpeg_path, staging_dir, log_path, **kwargs):
            nonlocal deleted_before_download
            deleted_before_download = not item_dir.exists()
            return self._cache_result(staging_dir)

        with self._manager() as manager, \
             patch.object(CacheManager, "_is_in_cache_window", return_value=True), \
             patch.object(CacheManager, "_ensure_downloader", return_value=Path("downloader")), \
             patch.object(CacheManager, "_ensure_ffmpeg", return_value=Path("ffmpeg")), \
             patch.object(manager, "_download_selected_streams", side_effect=fake_download), \
             patch.object(manager, "_validate_cache_result", return_value=None), \
             patch.object(manager, "_should_cache", return_value=True), \
             patch.object(MEDIA_LEASE_COORDINATOR, "wait_for_release", return_value=True):
            manager.retry_item("item-del-before-download", force=True)
            result = manager._cache_item_multi(
                "item-del-before-download",
                self.store.get_item("item-del-before-download"),
                allow_refresh_retry=False,
            )
            self.assertTrue(result)
            self.assertTrue(deleted_before_download)

    def test_deletion_failure_prevents_new_download(self):
        self._create_ready_item("item-del-fail")
        download_called = False

        def fake_download(*args, **kwargs):
            nonlocal download_called
            download_called = True
            return {}

        with self._manager() as manager, \
             patch.object(CacheManager, "_is_in_cache_window", return_value=True), \
             patch.object(CacheManager, "_remove_cache_dir_for_forced_retry", side_effect=RuntimeError("disk locked")), \
             patch.object(manager, "_download_selected_streams", side_effect=fake_download), \
             patch.object(manager, "_should_cache", return_value=True), \
             patch.object(MEDIA_LEASE_COORDINATOR, "wait_for_release", return_value=True):
            manager.retry_item("item-del-fail", force=True)
            result = manager._cache_item_multi(
                "item-del-fail",
                self.store.get_item("item-del-fail"),
                allow_refresh_retry=False,
            )
            self.assertFalse(result)
            self.assertFalse(download_called)
            item = self.store.get_item("item-del-fail")
            self.assertEqual(item.cache_status, "failed")
            self.assertIn("旧缓存删除失败", item.cache_message)
            self.assertEqual(len(MEDIA_LEASE_COORDINATOR.active_release_requests), 0)

    def test_failed_destructive_recache_does_not_restore_deleted_old_media(self):
        self._create_ready_item("item-fail-no-restore")
        item_dir = self.cache_dir / "item-fail-no-restore"
        item_dir.mkdir(parents=True, exist_ok=True)
        (item_dir / "video.mp4").write_bytes(b"old-video")

        with self._manager() as manager, \
             patch.object(CacheManager, "_is_in_cache_window", return_value=True), \
             patch.object(CacheManager, "_ensure_downloader", return_value=Path("downloader")), \
             patch.object(CacheManager, "_ensure_ffmpeg", return_value=Path("ffmpeg")), \
             patch.object(manager, "_download_selected_streams", side_effect=RuntimeError("download crash")), \
             patch.object(manager, "_should_cache", return_value=True), \
             patch.object(MEDIA_LEASE_COORDINATOR, "wait_for_release", return_value=True):
            manager.retry_item("item-fail-no-restore", force=True)
            result = manager._cache_item_multi(
                "item-fail-no-restore",
                self.store.get_item("item-fail-no-restore"),
                allow_refresh_retry=False,
            )
            self.assertFalse(result)
            item = self.store.get_item("item-fail-no-restore")
            self.assertEqual(item.cache_status, "failed")
            self.assertEqual(item.media_revision, "")
            self.assertFalse((self.cache_dir / "item-fail-no-restore").exists())
            self.assertEqual(len(MEDIA_LEASE_COORDINATOR.active_release_requests), 0)


if __name__ == "__main__":
    unittest.main()
