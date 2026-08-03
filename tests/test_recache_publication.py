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

    def tearDown(self):
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
        audio_relative = audio.relative_to(self.cache_dir).as_posix()
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

    def test_retry_item_ready_preserves_published_fields(self):
        item = self._create_ready_item("item-ready")
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), \
             patch.object(CacheManager, "_load_cache_policy", return_value=None), \
             patch.object(CacheManager, "_cleanup_stale_staging_and_obsolete", return_value=None), \
             patch.object(CacheManager, "_is_in_cache_window", return_value=True), \
             patch("bilikara.cache.threading.Thread"):
            manager = CacheManager(self.store)
            with patch.object(manager, "_remove_cache_dir") as mock_rm:
                manager.retry_item("item-ready", force=True)
                updated = self.store.get_item("item-ready")
                # Readiness and media fields must be preserved
                self.assertEqual(updated.cache_status, "ready")
                self.assertEqual(updated.video_relative_path, "item-ready/video.mp4")
                self.assertEqual(updated.video_media_url, "/media/item-ready/video.mp4?rev=rev-old")
                self.assertEqual(updated.media_revision, "rev-old")
                self.assertTrue(len(updated.audio_variants) > 0)
                mock_rm.assert_not_called()

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

    def test_public_retry_failure_keeps_ready_revision_and_files(self):
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
        self.assertEqual(item.cache_status, "ready")
        self.assertEqual(item.media_revision, "rev-old")
        self.assertEqual((self.cache_dir / "item-failure" / "video.mp4").read_bytes(), b"old-video")

    def test_successful_publication_uses_revision_directory_and_only_then_replaces_store(self):
        self._create_ready_item("item-success")
        with self._manager() as manager:
            result = self._run_recache(manager, "item-success")
        item = self.store.get_item("item-success")
        self.assertTrue(result)
        self.assertEqual(item.cache_status, "ready")
        self.assertNotEqual(item.media_revision, "rev-old")
        self.assertIn(f"item-success/revisions/{item.media_revision}/", item.video_relative_path)
        self.assertEqual((self.cache_dir / item.video_relative_path).read_bytes(), b"new-video")
        self.assertFalse((self.cache_dir / "item-success" / "video.mp4").exists())

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

    def test_store_publication_failure_rolls_back_old_ready_revision(self):
        self._create_ready_item("item-store-failure")
        original_update = self.store.update_item

        def fail_new_revision(item_id, **changes):
            if changes.get("media_revision") not in {None, "rev-old"}:
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
        self.assertEqual(item.cache_status, "ready")
        self.assertEqual(item.media_revision, "rev-old")
        self.assertTrue((self.cache_dir / "item-store-failure" / "video.mp4").exists())
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
        self.assertEqual(item.media_revision, "rev-old")
        self.assertTrue((self.cache_dir / "item-superseded" / "video.mp4").exists())
        self.assertEqual(list((self.cache_dir / "item-superseded").glob("revisions/*")), [])

    def test_release_timeout_restores_old_ready_revision(self):
        self._create_ready_item("item-timeout")
        with self._manager() as manager:
            result = self._run_recache(
                manager,
                "item-timeout",
                release_wait=lambda *_args, **_kwargs: False,
            )
        item = self.store.get_item("item-timeout")
        self.assertFalse(result)
        self.assertEqual(item.cache_status, "ready")
        self.assertEqual(item.media_revision, "rev-old")
        self.assertEqual((self.cache_dir / "item-timeout" / "video.mp4").read_bytes(), b"old-video")

    def test_notification_failure_restores_old_revision_and_playable_files(self):
        self._create_ready_item("item-notify-failure")
        self.store.on_change = MagicMock(
            side_effect=[None, None, RuntimeError("SSE unavailable"), None, None]
        )
        with self._manager() as manager:
            result = self._run_recache(manager, "item-notify-failure")
        item = self.store.get_item("item-notify-failure")
        self.assertFalse(result)
        self.assertEqual(item.media_revision, "rev-old")
        self.assertEqual((self.cache_dir / "item-notify-failure" / "video.mp4").read_bytes(), b"old-video")

    def test_rollback_persistence_failure_keeps_old_serviceable_and_marker_repairs_restart(self):
        self._create_ready_item("item-rollback-failure")
        self.store.on_change = MagicMock(
            side_effect=[None, None, RuntimeError("SSE unavailable"), None]
        )
        original_update = self.store.update_item
        publication_seen = False

        def fail_rollback(item_id, **changes):
            nonlocal publication_seen
            revision = changes.get("media_revision")
            if revision and revision != "rev-old":
                publication_seen = True
                return original_update(item_id, **changes)
            if publication_seen and revision == "rev-old":
                raise OSError("rollback persistence failed")
            return original_update(item_id, **changes)

        with self._manager() as manager, patch.object(
            self.store,
            "update_item",
            side_effect=fail_rollback,
        ):
            result = self._run_recache(manager, "item-rollback-failure")
        item = self.store.get_item("item-rollback-failure")
        markers = list(self.cache_dir.glob(".tx_*.json"))
        self.assertFalse(result)
        self.assertEqual(item.media_revision, "rev-old")
        self.assertTrue((self.cache_dir / "item-rollback-failure" / "video.mp4").exists())
        self.assertEqual(len(markers), 1)

        transaction = json.loads(markers[0].read_text(encoding="utf-8"))
        self.store.on_change = None
        self.assertTrue(self.store.update_item(
            "item-rollback-failure",
            **transaction["new_store_state"],
            persist_backup=False,
        ))
        with self._manager() as manager:
            self.assertTrue(manager._recover_publication_transaction(markers[0]))
        restarted_item = self.store.get_item("item-rollback-failure")
        self.assertIsNotNone(restarted_item)
        self.assertEqual(restarted_item.media_revision, "rev-old")
        self.assertTrue((self.cache_dir / "item-rollback-failure" / "video.mp4").exists())
        self.assertFalse(markers[0].exists())

    def test_rename_failure_keeps_old_revision_and_removes_staging(self):
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
        self.assertEqual(item.media_revision, "rev-old")
        self.assertTrue((self.cache_dir / "item-rename-failure" / "video.mp4").exists())
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
        self.assertEqual(current.media_revision, "rev-old")
        self.assertTrue((self.cache_dir / "item-role-race" / "video.mp4").exists())

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


if __name__ == "__main__":
    unittest.main()
