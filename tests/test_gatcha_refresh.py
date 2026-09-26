import threading
import time
import unittest
from unittest.mock import Mock, patch

from bilikara import bilibili, gatcha_refresh, rust_runtime
from gatcha_refresh_fixture import ConfiguredRefreshFixture


class ConfiguredRefreshTest(unittest.TestCase):
    def test_readding_uid_returns_only_new_catalog_contributions(self):
        with ConfiguredRefreshFixture() as f:
            f.write("cache", {"schema_version": 3, "uids": {
                "1": [{"bvid": "BVNEW0000001", "title": "existing"}]
            }, "profiles": {}})
            f.videos["1"].insert(0, {**f.videos["1"][0], "bvid": "BVNEW0000003"})
            result = bilibili._rust_gatcha_network("add_uid", uid="1", keywords=["karaoke"])
            self.assertEqual([entry["bvid"] for entry in result["entries"]], ["BVNEW0000003"])
            self.assertEqual(result["cache"]["total_count"], 2)
            repeated = bilibili._rust_gatcha_network("add_uid", uid="1", keywords=["karaoke"])
            self.assertEqual(repeated["entries"], [])

    def test_favorites_import_does_not_upload_old_or_unrelated_folder_records(self):
        from urllib.parse import urlsplit
        with ConfiguredRefreshFixture(uids=()) as f:
            f.add_folder()
            saved = f.read("favlist")
            saved["items"] = [
                {"bvid": "BVFAVREBUILD", "title": "old", "fav_uid": "42", "fav_folder_id": "100"},
                {"bvid": "BVUNRELATED1", "title": "other", "fav_uid": "9", "fav_folder_id": "200"},
            ]
            f.write("favlist", saved)
            def respond(target):
                path = urlsplit(target).path
                if path.endswith("/list-all"):
                    return {"code": 0, "data": {"list": [{"id": "100", "title": "K songs", "attr": 0, "media_count": 2}]}}
                if path.endswith("/resource/list"):
                    return {"code": 0, "data": {"medias": [
                        {**f.favorite, "bvid": "BVNEWFAVORIT"}, f.favorite,
                    ], "has_more": False}}
                return f.respond(target)
            f.provider.return_value = respond
            result = bilibili._rust_gatcha_network("refresh_favlist", uid="42", folder_ids=["100"], folder_keywords=[])
            self.assertEqual([entry["bvid"] for entry in result["entries"]], ["BVNEWFAVORIT"])
            self.assertEqual(len(f.read("favlist")["items"]), 3)
            repeated = bilibili._rust_gatcha_network("refresh_favlist", uid="42", folder_ids=["100"], folder_keywords=[])
            self.assertEqual(repeated["entries"], [])

    def test_empty_configuration_is_success_without_provider_requests(self):
        with ConfiguredRefreshFixture(uids=()) as f:
            self.assertTrue(f.start())
            status = f.wait()
            self.assertEqual(status["last_status"], "success")
            self.assertEqual(status["last_result"]["uid_results"], [])
            self.assertEqual(status["last_result"]["errors"], [])
            self.assertEqual(f.provider.requests, [])
            self.assertEqual(f.provider.posts, [])

    def test_each_source_is_published_before_the_next_network_response(self):
        from urllib.parse import parse_qs, urlsplit
        with ConfiguredRefreshFixture(uids=("1", "2")) as f:
            f.write("favlist", {"schema_version": 2, "uid": "42",
                "folders": [{"id": "100", "title": "first"}, {"id": "200", "title": "second"}], "items": []})
            second_uid, second_folder = threading.Event(), threading.Event()
            release_uid, release_folder = threading.Event(), threading.Event()
            def respond(target):
                url = urlsplit(target)
                query = parse_qs(url.query)
                if url.path.endswith("/acc/info") and query.get("mid") == ["2"]:
                    second_uid.set()
                    if not release_uid.wait(5):
                        raise AssertionError("second UID was not released")
                if url.path.endswith("/resource/list") and query.get("media_id") == ["200"]:
                    second_folder.set()
                    if not release_folder.wait(5):
                        raise AssertionError("second folder was not released")
                return f.respond(target)
            f.provider.return_value = respond
            self.assertTrue(f.start())
            try:
                self.assertTrue(second_uid.wait(5))
                task = rust_runtime.gatcha_task_snapshot()
                self.assertTrue(task["busy"])
                self.assertEqual(task["last_result"]["rebuild"]["current_uid"], "2")
                self.assertEqual(task["last_result"]["rebuild"]["sources"]["uids"], 1)
                self.assertEqual(f.read("cache")["uids"]["1"][0]["bvid"], "BVNEW0000001")
                release_uid.set()
                self.assertTrue(second_folder.wait(5))
                task = rust_runtime.gatcha_task_snapshot()
                self.assertTrue(task["busy"])
                self.assertEqual(task["last_result"]["rebuild"]["current_folder_id"], "200")
                self.assertEqual(task["last_result"]["rebuild"]["sources"]["favorites"], 1)
                self.assertEqual(f.read("favlist")["items"][0]["fav_folder_id"], "100")
            finally:
                release_uid.set()
                release_folder.set()
            self.assertEqual(f.wait()["last_status"], "success")

    def test_schema_resume_reuses_completed_favorite_folder(self):
        with ConfiguredRefreshFixture(uids=(), legacy=True) as f:
            f.add_folder()
            saved = {
                "bvid": "BVSAVED00001", "title": "saved favorite",
                "fav_uid": "42", "fav_folder_id": "100", "source": "favlist",
            }
            f.write("favlist_temp", {
                "schema_version": 2, "uid": "42", "uids": ["42"],
                "folders": [{"id": "100", "uid": "42", "title": "K songs"}],
                "items": [saved],
            })
            f.write("rebuild_progress", {
                "completed_uids": [], "completed_folders": ["42:100"],
            })
            f.fail_favlist = True
            self.assertTrue(f.start(use_global_lock=False, startup_schema_rebuild=True))
            self.assertEqual(f.wait()["last_status"], "success")
            self.assertEqual(f.read("favlist")["items"][0]["bvid"], saved["bvid"])
            self.assertEqual(f.provider.requests, [])
            self.assertEqual(f.appended_bvids(1), [saved["bvid"]])

    def test_start_observer_can_stop_without_deadlock_or_starting_io(self):
        with ConfiguredRefreshFixture() as f:
            done = Mock()
            self.assertTrue(f.start(on_start=gatcha_refresh.stop, on_done=done))
            self.assertEqual(f.wait()["last_status"], "idle")
            done.assert_not_called()
            self.assertEqual(f.provider.requests, [])
            self.assertEqual(gatcha_refresh._observers, {})

    def test_replaced_default_host_cannot_start_or_stop_the_new_owners_task(self):
        with ConfiguredRefreshFixture() as f:
            old = gatcha_refresh.new_owner()
            current = gatcha_refresh.new_owner()
            self.assertNotEqual(old, current)
            gatcha_refresh.stop(old)
            with self.assertRaises(bilibili.BilibiliError):
                f.start(_owner=old)
            self.assertTrue(f.start(_owner=current))
            self.assertEqual(f.wait()["last_status"], "success")
            self.assertEqual(f.appended_bvids(1), ["BVNEW0000001"])

    def test_partial_success_and_favorite_failure_keep_default_summaries(self):
        with ConfiguredRefreshFixture(uids=("1", "2")) as f:
            f.fail_uids.add("1")
            f.add_folder()
            f.fail_favlist = True
            self.assertTrue(f.start())
            status = f.wait()
            self.assertEqual(status["last_status"], "partial")
            result = status["last_result"]
            self.assertEqual([v["uid"] for v in result["uid_results"]], ["2"])
            self.assertEqual([v["uid"] for v in result["errors"]], ["1"])
            self.assertIn("synthetic favorite failure", result["favlist_error"])
            self.assertEqual((result["uid_count"], result["entry_count"]), (1, 1))
            self.assertEqual(f.appended_bvids(1), ["BVNEW0000002"])

    def test_duplicate_admission_and_observers_are_driven_by_rust_worker(self):
        with ConfiguredRefreshFixture() as f:
            entered, release, done = threading.Event(), threading.Event(), threading.Event()
            events = []
            def block():
                entered.set()
                if not release.wait(5):
                    raise AssertionError("test provider was not released")
            f.provider.before_response = block
            caller_thread = threading.get_ident()
            def on_done():
                events.append(("done", threading.get_ident(), rust_runtime.gatcha_task_snapshot()["last_status"]))
                done.set()
            self.assertTrue(f.start(on_start=lambda: events.append(("start", threading.get_ident())), on_done=on_done))
            try:
                self.assertTrue(entered.wait(5))
                self.assertTrue(rust_runtime.gatcha_task_snapshot()["busy"])
                self.assertFalse(f.start())
                self.assertFalse(f.start(use_global_lock=False))
                self.assertEqual(events, [("start", caller_thread)])
            finally:
                release.set()
            self.assertTrue(done.wait(5))
            self.assertEqual(events[1][0], "done")
            self.assertNotEqual(events[1][1], caller_thread)
            self.assertEqual(events[1][2], "success")
            self.assertFalse(f.wait()["busy"])
            self.assertEqual(f.appended_bvids(1), ["BVNEW0000001"])
            self.assertEqual(gatcha_refresh._observers, {})

    def test_stop_prevents_late_status_storage_indexing_and_notification(self):
        with ConfiguredRefreshFixture() as f:
            entered, release, stopped = threading.Event(), threading.Event(), threading.Event()
            done = Mock()
            def block():
                entered.set()
                release.wait(5)
            f.provider.before_response = block
            self.assertTrue(f.start(on_done=done))
            self.assertTrue(entered.wait(5))
            stopper = threading.Thread(target=lambda: (gatcha_refresh.stop(), stopped.set()))
            stopper.start()
            try:
                deadline = time.monotonic() + 2
                while rust_runtime.gatcha_task_snapshot()["background_busy"] and time.monotonic() < deadline:
                    time.sleep(.01)
                self.assertEqual(rust_runtime.gatcha_task_snapshot()["last_status"], "idle")
                release.set()
                self.assertTrue(stopped.wait(5))
                done.assert_not_called()
                self.assertEqual(f.read("cache")["uids"], {})
                self.assertEqual(f.provider.posts, [])
                self.assertEqual(gatcha_refresh._observers, {})
                with self.assertRaises(bilibili.BilibiliError):
                    f.start()
                # A replacement owner can accept a fresh task; the stopped
                # worker has retired before reset returns.
                rust_runtime.reset_gatcha_status_service()
                f.provider.before_response = None
                self.assertTrue(f.start())
                self.assertEqual(f.wait()["last_status"], "success")
                self.assertEqual(f.appended_bvids(1), ["BVNEW0000001"])
            finally:
                release.set()
                stopper.join(5)

    def test_empty_credentials_fail_in_rust_without_network_or_python_fallback(self):
        with ConfiguredRefreshFixture() as f, patch.object(bilibili, "effective_bilibili_cookie", return_value=""):
            self.assertTrue(f.start())
            status = f.wait()
            self.assertEqual(status["last_status"], "failed")
            self.assertEqual(status["last_error"], bilibili.MISSING_BILIBILI_COOKIE_MESSAGE)
            self.assertEqual(f.provider.requests, [])
            self.assertEqual(f.provider.posts, [])

    def test_nonblocking_startup_has_no_observer_callbacks_and_no_second_scan(self):
        with ConfiguredRefreshFixture() as f:
            started, done = Mock(), Mock()
            self.assertTrue(f.start(use_global_lock=False, startup_schema_rebuild=True, on_start=started, on_done=done))
            self.assertEqual(f.wait()["last_status"], "success")
            self.assertEqual(f.appended_bvids(1), ["BVNEW0000001"])
            started.assert_not_called()
            done.assert_not_called()

    def test_schema_resume_preserves_completed_uids_and_indexes_new_records(self):
        with ConfiguredRefreshFixture(legacy=True) as f:
            f.add_folder()
            f.write("uids_temp", {"schema_version":2,"uids":["1"],"profiles":{"1":{"uid":"1","name":"saved","space_url":"https://space.bilibili.com/1"}}})
            f.write("cache_temp", {"schema_version":3,"uids":{"1":[{"bvid":"BVSAVED00001","title":"saved"}]},"profiles":{}})
            f.write("rebuild_progress", {"completed_uids":["1"],"completed_folders":[]})
            f.fail_uids.add("1")
            self.assertTrue(f.start(use_global_lock=False, startup_schema_rebuild=True))
            status = f.wait()
            self.assertEqual(status["last_status"], "success")
            self.assertEqual(f.read("cache")["uids"]["1"][0]["bvid"], "BVSAVED00001")
            self.assertFalse(any("acc/info" in path or "arc/search" in path for path, _ in f.provider.requests))
            self.assertEqual(f.appended_bvids(2), ["BVFAVREBUILD", "BVSAVED00001"])

    def test_schema_failure_keeps_published_files_and_resumes_incremental_upload(self):
        with ConfiguredRefreshFixture(legacy=True) as f:
            f.add_folder()
            before = {name: f.path(name).read_bytes() for name in ("uids", "cache", "favlist")}
            f.fail_uids.add("1")
            self.assertTrue(f.start(use_global_lock=False, startup_schema_rebuild=True))
            self.assertEqual(f.wait()["last_status"], "failed")
            for name, payload in before.items():
                self.assertEqual(f.path(name).read_bytes(), payload)
            self.assertTrue(f.path("rebuild_progress").exists())
            self.assertEqual(f.provider.posts, [])
            f.fail_uids.clear()
            self.assertTrue(f.start(use_global_lock=False, startup_schema_rebuild=True))
            self.assertEqual(f.wait()["last_status"], "success")
            self.assertFalse(f.path("rebuild_progress").exists())
            self.assertEqual(f.appended_bvids(2), ["BVFAVREBUILD", "BVNEW0000001"])

    def test_schema_rebuild_does_not_reupload_existing_uids_or_favorites(self):
        with ConfiguredRefreshFixture(uids=("1", "2"), legacy=True) as f:
            f.add_folder()
            f.write("cache", {"schema_version": 2, "uids": {
                "1": [{"bvid": "BVNEW0000001", "title": "already published"}]
            }, "profiles": {}})
            favorites = f.read("favlist")
            favorites["items"] = [{"bvid": "BVFAVREBUILD", "title": "existing favorite",
                                    "fav_uid": "42", "fav_folder_id": "100"}]
            f.write("favlist", favorites)
            self.assertTrue(f.start(use_global_lock=False, startup_schema_rebuild=True))
            self.assertEqual(f.wait()["last_status"], "success")
            self.assertEqual(f.appended_bvids(1), ["BVNEW0000002"])
            self.assertEqual(len(f.read("cache")["uids"]), 2)
            self.assertEqual(f.read("favlist")["items"][0]["bvid"], "BVFAVREBUILD")

    def test_observer_exception_does_not_leak_lease_or_prevent_catalog_completion(self):
        with ConfiguredRefreshFixture() as f, self.assertLogs("bilikara.gatcha_refresh", level="ERROR"):
            self.assertTrue(f.start(on_start=Mock(side_effect=RuntimeError("observer"))))
            self.assertEqual(f.wait()["last_status"], "success")
            self.assertEqual(f.appended_bvids(1), ["BVNEW0000001"])

    def test_runtime_unavailable_is_explicit(self):
        with ConfiguredRefreshFixture() as f, patch.object(rust_runtime, "_runtime_lib", None):
            with self.assertRaises(rust_runtime.RustRuntimeUnavailableError):
                f.start()
