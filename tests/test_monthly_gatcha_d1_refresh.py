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
