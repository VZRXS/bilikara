import threading
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import monthly_gatcha_d1_refresh as monthly_refresh
from bilikara import config


class MonthlyGatchaD1RefreshTest(unittest.TestCase):
    def setUp(self):
        with monthly_refresh._LOCAL_RUN_LOCK:
            monthly_refresh._LOCAL_RUN_ACTIVE = False

    def tearDown(self):
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            with monthly_refresh._LOCAL_RUN_LOCK:
                if not monthly_refresh._LOCAL_RUN_ACTIVE:
                    return
            time.sleep(0.01)
        self.fail("local monthly refresh test worker did not stop")

    def test_local_background_start_rejects_duplicate_run(self):
        started = threading.Event()
        release = threading.Event()
        calls = []

        def fake_main(argv, *, secret_override=""):
            calls.append((argv, secret_override))
            started.set()
            release.wait(timeout=2)
            return 0

        with patch.object(monthly_refresh, "main", side_effect=fake_main):
            result = monthly_refresh.start_monthly_refresh_in_background(
                "worker-secret",
                requested_by="VZRXS",
            )
            self.assertTrue(started.wait(timeout=1))
            duplicate = monthly_refresh.start_monthly_refresh_in_background("worker-secret")
            release.set()

        self.assertTrue(result["success"])
        self.assertEqual(result["execution"], "local")
        self.assertFalse(duplicate["success"])
        self.assertIn("already running locally", duplicate["error"])
        self.assertEqual(calls, [([], "worker-secret")])

    def test_upload_entries_uses_authenticated_bounded_batches(self):
        entries = [
            {"bvid": f"BV{index:010d}", "title": f"song {index}"}
            for index in range(1_201)
        ]
        requests = []

        def fake_request(url, *, method="GET", payload=None, secret="", timeout=60.0):
            requests.append((url, method, payload, secret, timeout))
            count = len(payload["records"])
            return {"success": True, "attempted": count, "added": count}

        with patch.object(monthly_refresh, "_request_json", side_effect=fake_request):
            result = monthly_refresh._upload_entries(
                entries,
                api_url="https://api.example.test",
                secret="worker-secret",
                batch_size=500,
                dry_run=False,
            )

        self.assertEqual([len(request[2]["records"]) for request in requests], [500, 500, 201])
        self.assertTrue(all(request[0].endswith("/batch-add?sync_google=1") for request in requests))
        self.assertTrue(all(request[1] == "POST" for request in requests))
        self.assertTrue(all(request[3] == "worker-secret" for request in requests))
        self.assertEqual(result["attempted"], 1_201)
        self.assertEqual(result["added"], 1_201)

    def test_page_any_probe_detects_a_missing_middle_video(self):
        first_page = [
            {"bvid": "BVNEW0000001"},
            {"bvid": "BVMID0000001"},
            {"bvid": "BVOLD0000001"},
        ]
        d1_bvids = {"BVNEW0000001", "BVOLD0000001"}

        should_refresh, reason = monthly_refresh._needs_refresh(
            first_page,
            d1_bvids,
            probe_mode="page-any",
        )

        self.assertTrue(should_refresh)
        self.assertIn("BVMID0000001", reason)

    def test_default_uid_source_uses_runtime_data_directory(self):
        self.assertEqual(monthly_refresh.DEFAULT_UIDS_PATH, config.DATA_DIR / "gatcha_uids.json")

    def test_missing_uid_source_is_only_an_error_in_local_mode(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            missing = Path(temp_dir) / "missing-uids.json"
            local_result = monthly_refresh.main([
                "--uid-source",
                str(missing),
                "--uid-mode",
                "local",
            ])
            with patch.object(monthly_refresh, "_export_d1_records", return_value=[]):
                union_result = monthly_refresh.main([
                    "--uid-source",
                    str(missing),
                    "--uid-mode",
                    "union",
                ])

        self.assertEqual(local_result, 2)
        self.assertEqual(union_result, 0)

    def test_worker_start_failure_releases_duplicate_guard(self):
        with patch.object(monthly_refresh.threading.Thread, "start", side_effect=RuntimeError("no thread")):
            result = monthly_refresh.start_monthly_refresh_in_background("worker-secret")

        self.assertFalse(result["success"])
        self.assertIn("failed to start local monthly D1 refresh", result["error"])
        with monthly_refresh._LOCAL_RUN_LOCK:
            self.assertFalse(monthly_refresh._LOCAL_RUN_ACTIVE)


if __name__ == "__main__":
    unittest.main()
