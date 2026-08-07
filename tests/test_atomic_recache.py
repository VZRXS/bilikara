import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from bilikara.cache import CacheManager, MediaLeaseCoordinator, MEDIA_LEASE_COORDINATOR
from bilikara.models import PlaylistItem
from bilikara.store import PlaylistStore


class AtomicRecacheTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root_dir = Path(self.temp_dir.name)
        self.store_path = self.root_dir / "state.json"
        self.backup_path = self.root_dir / "backup.json"
        self.store = PlaylistStore(self.store_path, self.backup_path)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_media_lease_coordinator_lifecycle(self):
        coordinator = MediaLeaseCoordinator()
        request_id = "req-test-1"
        registered = coordinator.register_reader("rev-1", request_id)
        self.assertTrue(registered)
        self.assertEqual(coordinator.reader_count("rev-1"), 1)
        self.assertFalse(coordinator.is_draining("rev-1"))
        self.assertFalse(coordinator.is_request_cancelled(request_id))

        coordinator.mark_draining("rev-1")
        self.assertTrue(coordinator.is_draining("rev-1"))
        self.assertTrue(coordinator.is_request_cancelled(request_id))

        coordinator.unregister_reader("rev-1", request_id)
        self.assertEqual(coordinator.reader_count("rev-1"), 0)

    def test_media_lease_coordinator_release_ack(self):
        coordinator = MediaLeaseCoordinator()
        req_id = "req-123"
        coordinator.start_release_request(req_id, "item-1", "rev-old")

        self.assertFalse(coordinator.ack_release_request(req_id, "wrong-item", "rev-old"))
        self.assertTrue(coordinator.ack_release_request(req_id, "item-1", "rev-old"))
        self.assertTrue(coordinator.wait_for_release(req_id, "rev-old", timeout=0.1))

    def test_wait_for_release_returns_false_on_timeout_without_ack_even_with_zero_readers(self):
        coordinator = MediaLeaseCoordinator()
        req_id = "req-no-ack"
        coordinator.start_release_request(req_id, "item-1", "rev-old")
        # readers is 0, but ACK was never sent!
        self.assertEqual(coordinator.reader_count("rev-old"), 0)
        self.assertFalse(coordinator.wait_for_release(req_id, "rev-old", timeout=0.05))

    def test_wait_for_release_waits_for_reader_drain_after_ack(self):
        coordinator = MediaLeaseCoordinator()
        req_id = "req-drain"
        # Register reader BEFORE start_release_request sets draining_revisions
        registered = coordinator.register_reader("rev-old", "reader-1")
        self.assertTrue(registered)
        self.assertEqual(coordinator.reader_count("rev-old"), 1)

        coordinator.start_release_request(req_id, "item-1", "rev-old")

        coordinator.ack_release_request(req_id, "item-1", "rev-old")
        # ACK received, but reader is still active -> wait_for_release must wait!
        result_holder = []

        def _waiter():
            result_holder.append(coordinator.wait_for_release(req_id, "rev-old", timeout=0.5))

        thread = threading.Thread(target=_waiter)
        thread.start()

        time.sleep(0.05)
        self.assertEqual(len(result_holder), 0)  # still waiting for reader

        coordinator.unregister_reader("rev-old", "reader-1")
        thread.join(timeout=1.0)
        self.assertEqual(result_holder, [True])

    def test_ack_validation_rejects_wrong_id_item_or_revision(self):
        coordinator = MediaLeaseCoordinator()
        req_id = "req-val"
        coordinator.start_release_request(req_id, "item-1", "rev-1")

        self.assertFalse(coordinator.ack_release_request("wrong-req", "item-1", "rev-1"))
        self.assertFalse(coordinator.ack_release_request(req_id, "wrong-item", "rev-1"))
        self.assertFalse(coordinator.ack_release_request(req_id, "item-1", "wrong-rev"))
        self.assertFalse(coordinator.wait_for_release(req_id, "rev-1", timeout=0.05))

    def test_duplicate_ack_is_idempotent(self):
        coordinator = MediaLeaseCoordinator()
        req_id = "req-dup"
        coordinator.start_release_request(req_id, "item-1", "rev-1")

        self.assertTrue(coordinator.ack_release_request(req_id, "item-1", "rev-1"))
        self.assertTrue(coordinator.ack_release_request(req_id, "item-1", "rev-1"))
        self.assertTrue(coordinator.wait_for_release(req_id, "rev-1", timeout=0.1))

    def test_late_ack_after_finish_release_request_is_rejected(self):
        coordinator = MediaLeaseCoordinator()
        req_id = "req-late"
        coordinator.start_release_request(req_id, "item-1", "rev-1")
        coordinator.finish_release_request(req_id, "rev-1")

        self.assertFalse(coordinator.ack_release_request(req_id, "item-1", "rev-1"))
        self.assertFalse(coordinator.is_draining("rev-1"))

    def test_wait_for_drain_succeeds_without_ack_for_non_current_item(self):
        coordinator = MediaLeaseCoordinator()
        coordinator.mark_draining("rev-noncurrent")
        self.assertTrue(coordinator.wait_for_drain("rev-noncurrent", timeout=0.05))

    def test_media_revision_assigned_in_to_dict(self):
        item = PlaylistItem(
            id="item-test",
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
            video_media_url="/media/item-test/video.mp4",
            media_revision="rev-abcdef123",
        )
        item_dict = item.to_dict()
        self.assertEqual(item_dict["media_revision"], "rev-abcdef123")
        self.assertIn("?rev=rev-abcdef123", item_dict["video_media_url"])

    def test_store_media_release_request_snapshot(self):
        self.store.set_media_release_request("req-99", "item-abc", "rev-1")
        snapshot = self.store.snapshot()
        self.assertEqual(
            snapshot["media_release_request"],
            {
                "request_id": "req-99",
                "item_id": "item-abc",
                "media_revision": "rev-1",
            },
        )
        self.store.clear_media_release_request("req-99")
        snapshot2 = self.store.snapshot()
        self.assertIsNone(snapshot2["media_release_request"])

    def test_obsolete_cleanup_deferred_retry_and_path_validation(self):
        cache_dir = self.root_dir / "cache"
        cache_dir.mkdir(parents=True, exist_ok=True)
        obs_dir = cache_dir / ".obsolete" / "item-1-rev-old-123456"
        obs_dir.mkdir(parents=True, exist_ok=True)
        (obs_dir / "test.txt").write_text("hello")

        with patch("bilikara.cache.CACHE_DIR", cache_dir), \
             patch.object(CacheManager, "_load_cache_policy", return_value=None), \
             patch.object(CacheManager, "_cleanup_stale_staging_and_obsolete", return_value=None), \
             patch("bilikara.cache.threading.Thread"):
            manager = CacheManager(self.store)

            # Invalid path outside .obsolete must be rejected
            active_dir = cache_dir / "item-1"
            active_dir.mkdir(parents=True, exist_ok=True)
            self.assertFalse(manager._remove_obsolete_dir(active_dir))

            # Valid obsolete directory deletion
            with patch("shutil.rmtree", side_effect=[PermissionError("Locked"), None]):
                # First attempt fails with PermissionError -> added to pending cleanups
                self.assertFalse(manager._remove_obsolete_dir(obs_dir))
                self.assertIn(str(obs_dir), manager.pending_obsolete_cleanups)

                # Fast-forward last_attempt time
                manager.pending_obsolete_cleanups[str(obs_dir)]["last_attempt"] = time.time() - 2.0
                manager._process_pending_obsolete_cleanups()

                # Second attempt succeeds -> removed from pending cleanups
                self.assertNotIn(str(obs_dir), manager.pending_obsolete_cleanups)

    def test_unrelated_release_requests_survive_empty_revision_cleanup(self):
        coordinator = MediaLeaseCoordinator()
        coordinator.start_release_request("req-1", "item-1", "rev-1")
        coordinator.start_release_request("req-2", "item-2", "")

        # Finishing req-1 with empty revision must NOT remove req-2
        coordinator.finish_release_request("req-1", "")
        with coordinator.lock:
            self.assertNotIn("req-1", coordinator.active_release_requests)
            self.assertIn("req-2", coordinator.active_release_requests)

    def test_urgent_cache_path_does_not_race_with_normal_queue_worker(self):
        with patch("bilikara.cache.CACHE_DIR", self.root_dir), \
             patch.object(CacheManager, "_load_cache_policy", return_value=None), \
             patch.object(CacheManager, "_cleanup_stale_staging_and_obsolete", return_value=None), \
             patch("bilikara.cache.threading.Thread"):
            manager = CacheManager(self.store)
            manager.tasks.put("item-urgent-race")
            with manager.lock:
                manager.pending_ids.add("item-urgent-race")

            cache_item_calls = []
            with patch.object(manager, "_cache_item", side_effect=lambda item_id: cache_item_calls.append(item_id) or False):
                manager._start_urgent_cache("item-urgent-race")
                # Simulate normal worker loop step attempting to process item dequeued from tasks
                item_id = "item-urgent-race"
                with manager.lock:
                    if not (manager.stop_event.is_set() or item_id in manager.urgent_cache_ids):
                        manager.active_item_id = item_id
                        manager._cache_item(item_id)

            # Normal worker must skip item because item_id is in urgent_cache_ids
            self.assertEqual(cache_item_calls, [])
            with manager.lock:
                self.assertIn("item-urgent-race", manager.urgent_cache_ids)

    def test_worker_loop_guarantees_exactly_one_task_done_per_get(self):
        with patch("bilikara.cache.CACHE_DIR", self.root_dir), \
             patch.object(CacheManager, "_load_cache_policy", return_value=None), \
             patch.object(CacheManager, "_cleanup_stale_staging_and_obsolete", return_value=None), \
             patch("bilikara.cache.threading.Thread"):
            manager = CacheManager(self.store)
            manager.tasks.put("item-skip")
            with manager.lock:
                manager.urgent_cache_ids.add("item-skip")

            original_task_done = manager.tasks.task_done
            def side_effect_task_done():
                manager.stop_event.set()
                original_task_done()

            with patch.object(manager.tasks, "task_done", side_effect=side_effect_task_done):
                manager._worker_loop()

            self.assertEqual(manager.tasks.unfinished_tasks, 0)

    def test_start_urgent_cache_cleans_stale_ownership_when_active_item_matches(self):
        with patch("bilikara.cache.CACHE_DIR", self.root_dir), \
             patch.object(CacheManager, "_load_cache_policy", return_value=None), \
             patch.object(CacheManager, "_cleanup_stale_staging_and_obsolete", return_value=None), \
             patch("bilikara.cache.threading.Thread"):
            manager = CacheManager(self.store)
            with manager.lock:
                manager.active_item_id = "target-item"

            manager._start_urgent_cache("target-item")

            with manager.lock:
                self.assertNotIn("target-item", manager.urgent_cache_ids)
                self.assertNotIn("target-item", manager.urgent_workers)


if __name__ == "__main__":
    unittest.main()
