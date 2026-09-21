"""Real default Host/FFI submission seam; all media and credentials are fixtures.

Queue/executor timing is exercised in Rust without workers. Here malformed CIDs
prevent native network admission, while real files prove reuse/lease behavior.
"""
import threading
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

from bilikara import rust_runtime
from bilikara.store import PlaylistStoreCommandError
from bilikara.cache import CacheManager, DownloadCommandError, DOWNLOAD_SOURCE_BBDOWN, DOWNLOAD_SOURCE_NATIVE
from tests import test_cache as fixtures


class NativeCacheOrchestrationTest(unittest.TestCase):
    make_item = fixtures.CacheManagerPolicyTest.make_item
    ready_payload = fixtures.CacheManagerPolicyTest.ready_payload
    mark_item_ready_with_files = fixtures.CacheManagerPolicyTest.mark_item_ready_with_files
    staged_cache_result = fixtures.CacheManagerPolicyTest.staged_cache_result

    def setUp(self):
        fixtures.CacheManagerPolicyTest.setUp(self)
        self.stack = ExitStack()
        self.stack.enter_context(patch("bilikara.cache.CACHE_DIR", self.cache_dir))
        self.stack.enter_context(patch("bilikara.cache.LOG_DIR", Path(self.temp_dir.name) / "logs"))
        self.stack.enter_context(patch.object(CacheManager, "_worker_loop", lambda self: None))
        self.stack.enter_context(patch.object(CacheManager, "_native_cache_event_loop", lambda self: None))
        self.leases = []
        self.manager = CacheManager(self.store, max_cache_items=3)
        self.manager.download_source = DOWNLOAD_SOURCE_NATIVE

    def tearDown(self):
        for lease in self.leases:
            self.manager.release_media_reader(lease)
        self.manager.shutdown()
        self.stack.close()
        fixtures.CacheManagerPolicyTest.tearDown(self)

    def reader(self, path):
        lease = self.manager.acquire_media_reader(path)
        self.leases.append(lease)
        return lease

    def add(self, item_id, *, valid=False):
        item = self.make_item(item_id)
        item.selected_pages = [1]
        item.selected_cids = [456 if valid else 0]
        item.available_pages = [1]
        item.available_cids = item.selected_cids[:]
        item.cid = item.selected_cids[0]
        self.store.add_item(item, requester_name="cache-test-user")
        return self.store.get_item(item_id)

    def test_sync_reads_authoritative_items_without_python_job_or_window_assembly(self):
        self.add("bad")
        original = rust_runtime.native_cache_request
        with patch.object(self.store, "list_items", side_effect=AssertionError("Python playlist assembly")), patch.object(
            self.manager, "_stable_cache_plan_snapshot", side_effect=AssertionError("Python Native plan")
        ), patch("bilikara.cache.rust_runtime.native_cache_request", wraps=original) as service:
            self.manager.sync_with_playlist()
        self.assertEqual(self.store.get_item("bad").cache_status, "failed")
        self.assertIn("valid CIDs", self.store.get_item("bad").cache_message)
        self.assertFalse(hasattr(self.manager, "_native_cache_job"))
        self.assertFalse(hasattr(self.manager, "_request_native_desired_recaching"))
        self.assertEqual(self.manager.python_worker_download_sources, {})
        self.assertEqual(self.manager.pending_ids, set())
        self.assertTrue(self.manager.tasks.empty())
        facts = service.call_args.kwargs["facts"]
        self.assertNotIn("jobs", facts)
        self.assertNotIn("items", facts)
        self.assertEqual(facts["external_attempts"], [])

    def test_failed_until_explicit_retry_and_progress_only_sync_has_no_new_attempt(self):
        item = self.add("bad")
        self.manager.sync_with_playlist()
        first = rust_runtime.cache_runtime_request("snapshot")
        for _ in range(3):
            self.manager.sync_with_playlist()
        self.assertEqual(rust_runtime.cache_runtime_request("snapshot")["last_event_sequence"], first["last_event_sequence"])
        self.manager.retry_item(item.id, expected_item_incarnation_id=item.item_incarnation_id)
        final = rust_runtime.cache_runtime_request("snapshot")
        self.assertGreater(final["last_event_sequence"], first["last_event_sequence"])
        self.assertEqual(self.store.get_item(item.id).cache_status, "failed")

    def test_stale_retry_and_stale_external_attempt_cannot_own_reused_id(self):
        old = self.add("same")
        token = self.store.begin_cache_attempt(old.id, old.item_incarnation_id)
        self.manager.python_worker_download_sources[old.id] = DOWNLOAD_SOURCE_BBDOWN
        self.manager.python_cache_attempt_tokens[old.id] = token
        self.store.remove_item(old.id)
        new = self.add("same")
        with self.assertRaises(PlaylistStoreCommandError) as error:
            self.manager.retry_item(old.id, expected_item_incarnation_id=old.item_incarnation_id, force=True)
        self.assertEqual(error.exception.kind, "item_incarnation_mismatch")
        self.assertEqual(self.store.get_item(new.id).cache_status, "pending")
        self.manager.sync_with_playlist()
        self.assertEqual(self.store.get_item(new.id).cache_status, "failed")
        self.assertEqual(self.store.get_item(new.id).item_incarnation_id, new.item_incarnation_id)

    def test_ready_reuse_future_preferences_and_clear_use_the_shared_lifetime(self):
        item = self.add("ready", valid=True)
        self.mark_item_ready_with_files(item.id)
        ready = self.store.get_item(item.id)
        lease = self.reader(ready.video_relative_path)
        self.assertIsNotNone(lease)
        self.manager.sync_with_playlist()
        before = rust_runtime.cache_runtime_request("snapshot")
        self.manager.set_cache_policy(video_quality="720P 高清", audio_hires=True)
        self.manager.sync_with_playlist()
        self.assertEqual(rust_runtime.cache_runtime_request("snapshot")["last_event_sequence"], before["last_event_sequence"])
        self.assertEqual(self.store.get_item(item.id).artifact_set_id, ready.artifact_set_id)
        self.manager.clear_runtime_cache()
        self.assertEqual(self.store.get_item(item.id).cache_status, "pending")
        self.manager._native_orchestration("wake")
        self.assertEqual(rust_runtime.cache_runtime_request("snapshot")["pending_ids"], [])
        self.assertTrue((self.cache_dir / ready.video_relative_path).exists())
        self.assertTrue(self.manager.release_media_reader(lease))
        self.assertFalse((self.cache_dir / ready.video_relative_path).exists())

    def test_refresh_failure_preserves_media_and_capability_reconcile_is_idempotent(self):
        item = self.add("ready")  # Malformed CID deliberately fails before any I/O.
        self.mark_item_ready_with_files(item.id)
        ready = self.store.get_item(item.id)
        self.manager.sync_with_playlist()
        self.manager.set_client_media_capabilities({"hevc_supported":False,"avc_supported":True,"max_avc_quality_index":2})
        first = rust_runtime.cache_runtime_request("snapshot")
        self.manager.sync_with_playlist()
        self.assertEqual(rust_runtime.cache_runtime_request("snapshot")["last_event_sequence"], first["last_event_sequence"])
        self.assertEqual(self.store.get_item(item.id).artifact_set_id, ready.artifact_set_id)
        self.assertTrue((self.cache_dir / ready.video_relative_path).exists())
        self.assertEqual(self.manager.python_cache_attempt_tokens, {})

    def test_sync_failure_does_not_fan_out_or_create_python_fallback(self):
        self.add("a")
        self.add("b")
        with patch("bilikara.cache.rust_runtime.native_cache_request", side_effect=RuntimeError("unavailable")):
            self.manager.sync_with_playlist()
        self.assertEqual(self.manager.native_cache_error, "unavailable")
        self.assertEqual([item.cache_status for item in self.store.list_items()], ["pending", "pending"])
        self.assertTrue(self.manager.tasks.empty())

    def test_late_observation_cannot_replace_a_newer_native_queue_view(self):
        self.manager._apply_native_cache_snapshot({"last_event_sequence": 20, "pending_ids": ["new"]})
        self.manager._apply_native_cache_snapshot({"last_event_sequence": 19, "pending_ids": []})
        self.assertEqual(self.manager.native_cache_snapshot["pending_ids"], ["new"])
        self.assertEqual(self.manager.pending_ids, set())

    def test_closed_owner_rejects_direct_ffi_scheduling(self):
        original = rust_runtime.native_cache_request
        with patch("bilikara.cache.rust_runtime.native_cache_request", wraps=original) as service:
            self.manager.sync_with_playlist()
        facts = service.call_args.kwargs["facts"]
        owner = self.manager._artifact_owner
        self.manager.shutdown()
        with self.assertRaises(rust_runtime.RustRuntimeServiceError) as rejected:
            original("reconcile", owner=owner, facts=facts)
        self.assertEqual(rejected.exception.kind, "stopped")

    def test_explicit_retained_source_retry_uses_native_handoff_before_reservation(self):
        item = self.add("song")
        self.manager.sync_with_playlist()
        old = rust_runtime.cache_runtime_request("snapshot")["terminal_events"][0]["cache_attempt_token"]
        self.manager.set_cache_policy(download_source=DOWNLOAD_SOURCE_BBDOWN)
        original = rust_runtime.native_cache_request
        with patch("bilikara.cache.rust_runtime.native_cache_request", wraps=original) as service:
            self.manager.retry_item(item.id, expected_item_incarnation_id=item.item_incarnation_id)
        service.assert_called_once_with("handoff", owner=self.manager._artifact_owner,
                                       item_id=item.id, expected_item_incarnation_id=item.item_incarnation_id)
        self.assertGreater(self.manager.python_cache_attempt_tokens[item.id], old)
        self.assertEqual(self.manager.python_worker_download_sources[item.id], DOWNLOAD_SOURCE_BBDOWN)
        self.assertEqual(self.manager.tasks.get_nowait(), item.id)
        self.manager.tasks.task_done()

    def test_persistence_precedes_notification_and_shutdown_rejects_late_sync(self):
        self.add("bad")
        effects = []
        persist = self.store._persist_response_unlocked
        def observe(response):
            persist(response)
            effects.append("persist")
        self.store.on_change = lambda: effects.append("notify")
        with patch.object(self.store, "_persist_response_unlocked", side_effect=observe):
            self.manager.sync_with_playlist()
        self.assertIn("notify", effects)
        self.assertLess(effects.index("persist"), effects.index("notify"))
        self.manager.shutdown()
        with patch("bilikara.cache.rust_runtime.native_cache_request", side_effect=AssertionError("late admission")):
            self.manager.sync_with_playlist()
        self.store.on_change = None

    def test_python_queue_captures_source_before_native_switch(self):
        item = self.add("external")
        self.add("native")
        self.manager.download_source = DOWNLOAD_SOURCE_BBDOWN
        self.manager.enqueue(item.id)
        token = self.manager.python_cache_attempt_tokens[item.id]
        self.manager.set_cache_policy(download_source=DOWNLOAD_SOURCE_NATIVE)
        self.manager.sync_with_playlist()
        self.assertEqual(self.manager.tasks.get_nowait(), item.id)
        self.manager.tasks.task_done()
        self.assertEqual(self.manager.python_worker_download_sources, {item.id: DOWNLOAD_SOURCE_BBDOWN})
        self.assertEqual(self.manager.python_cache_attempt_tokens[item.id], token)
        self.assertEqual(self.store.cache_attempt_reservation(token)["item_incarnation_id"], item.item_incarnation_id)
        self.assertEqual(self.store.get_item("native").cache_status, "failed")
        self.assertNotEqual(self.store.get_item(item.id).cache_status, "failed")

    def run_external_boundary(self, outcome, handoff):
        item = self.add("external", valid=handoff)
        self.mark_item_ready_with_files(item.id)
        previous = self.store.get_item(item.id)
        # A reader keeps the previous publication observable through replacement.
        lease = self.reader(previous.video_relative_path)
        self.manager.download_source = DOWNLOAD_SOURCE_BBDOWN
        self.manager.desired_ids = {item.id}
        self.manager.ordered_desired_ids = [item.id]
        self.manager.enqueue(item.id)
        first_token = self.manager.python_cache_attempt_tokens[item.id]
        parked, resume, finished = threading.Event(), threading.Event(), threading.Event()
        attempts, errors = [], []
        close = self.manager._close_python_retry_window
        count = 0
        def close_at_boundary(item_id, token):
            nonlocal count
            count += 1
            if count == 1:
                result = None if handoff else close(item_id, token)
                parked.set()
                if not resume.wait(10):
                    raise AssertionError("capability handoff did not resume")
                return close(item_id, token) if handoff else result
            return close(item_id, token)
        def download(observed, _binary, _media, staging, _log, *, cache_attempt_token, download_source):
            attempts.append((cache_attempt_token, download_source, self.manager._bbdown_stream_preference_args("video")))
            if len(attempts) == 1 and outcome == "download_error":
                raise DownloadCommandError("synthetic download failure")
            if len(attempts) == 1 and outcome == "generic_error":
                raise RuntimeError("synthetic failure")
            return self.staged_cache_result(staging)
        after_attempt = self.manager._after_external_cache_attempt
        def after(should_resync):
            after_attempt(should_resync)
            self.manager.stop_event.set()
            finished.set()
        worker_loop = ORIGINAL_WORKER_LOOP
        def worker():
            try:
                worker_loop(self.manager)
            except BaseException as error:
                errors.append(error)
                finished.set()
        with ExitStack() as stack:
            stack.enter_context(patch.object(self.manager, "_close_python_retry_window", side_effect=close_at_boundary))
            stack.enter_context(patch.object(self.manager, "_ensure_downloader", side_effect=RuntimeError("synthetic preparation failure") if outcome == "preparation_error" else None, return_value=Path("fixture-bbdown")))
            stack.enter_context(patch.object(self.manager, "_ensure_ffmpeg", return_value=Path()))
            stack.enter_context(patch.object(self.manager, "_download_selected_streams", side_effect=download))
            stack.enter_context(patch.object(self.manager, "_validate_cache_result"))
            stack.enter_context(patch.object(self.manager, "_after_external_cache_attempt", side_effect=after))
            thread = threading.Thread(target=worker)
            thread.start()
            try:
                self.assertTrue(parked.wait(10), errors)
                self.manager.set_cache_policy(download_source=DOWNLOAD_SOURCE_NATIVE)
                self.manager.sync_with_playlist()
                self.manager.set_client_media_capabilities({"hevc_supported":False,"avc_supported":True,"max_avc_quality_index":2})
                self.assertEqual(self.manager.python_cache_attempt_tokens[item.id], first_token)
                self.assertEqual(self.manager.retry_requested_ids, {item.id} if handoff else set())
                self.assertEqual(rust_runtime.cache_runtime_request("snapshot")["pending_ids"], [])
                self.assertTrue((self.cache_dir / previous.video_relative_path).exists())
            finally:
                resume.set()
                self.assertTrue(finished.wait(10), errors)
                thread.join(10)
                self.manager.stop_event.clear()
        self.assertEqual(errors, [])
        self.assertFalse(thread.is_alive())
        self.assertEqual(self.manager.python_worker_download_sources, {})
        self.assertEqual(self.manager.python_cache_attempt_tokens, {})
        self.assertEqual(self.manager.retry_requested_ids, set())
        self.assertEqual(self.manager.settling_cache_attempt_tokens, set())
        terminal = rust_runtime.cache_runtime_request("snapshot")["terminal_events"]
        if handoff:
            self.assertEqual(len(attempts), 2)
            self.assertTrue(all(attempt[1] == DOWNLOAD_SOURCE_BBDOWN for attempt in attempts))
            self.assertGreater(attempts[1][0], attempts[0][0])
            self.assertNotIn("-e", attempts[0][2])
            self.assertIn("avc", attempts[1][2])
            self.assertEqual(terminal, [])
        else:
            self.assertEqual(len(terminal), 1)
            self.assertEqual(terminal[0]["kind"], "failed")
            self.assertGreater(terminal[0]["cache_attempt_token"], first_token)
        self.assertEqual(self.store.get_item(item.id).cache_status, "ready")
        self.assertTrue((self.cache_dir / self.store.get_item(item.id).video_relative_path).exists())
        self.assertTrue(self.manager.release_media_reader(lease))

    def test_capability_handoff_restarts_original_external_executor(self):
        self.run_external_boundary("ready", True)

    def test_late_download_error_handoff_is_consumed_once(self):
        self.run_external_boundary("download_error", True)

    def test_capability_waits_for_closed_external_publication(self):
        self.run_external_boundary("ready", False)

    def test_capability_waits_for_closed_download_failure(self):
        self.run_external_boundary("download_error", False)

    def test_capability_waits_for_closed_generic_failure(self):
        self.run_external_boundary("generic_error", False)

    def test_capability_waits_for_closed_preparation_failure(self):
        self.run_external_boundary("preparation_error", False)


ORIGINAL_WORKER_LOOP = CacheManager._worker_loop
