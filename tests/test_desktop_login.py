"""P02 request-consumer → Runtime FFI → shared PR109 login contracts."""
import os
import threading
import time
import unittest
from contextlib import ExitStack
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import Mock, patch

from bilikara import bilibili, rust_runtime
from bilikara.cache import CacheManager
from login_service_fixture import LoginFixture


class DesktopLoginTest(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(TemporaryDirectory()))
        self.data = self.root / "BBDown.data"
        self.hooks = []
        # Only the existing request consumer is instantiated; cache workers and
        # unrelated AppState setup are irrelevant to this login service test.
        self.manager = CacheManager.__new__(CacheManager)
        self.manager.lock = threading.RLock()
        self.manager.stop_event = threading.Event()
        self.manager.log_dir = self.root / "logs"
        self.manager.on_bbdown_login_success = lambda: self.hooks.append("refresh")
        self.stack.enter_context(patch("bilikara.cache.BB_DOWN_DIR", self.root))
        self.stack.enter_context(patch("bilikara.bilibili.cfg.BB_DOWN_DIR", self.root))
        rust_runtime.reset_bilibili_login_status()
        self.addCleanup(rust_runtime.reset_bilibili_login_status)

    def request(self, command, **fields):
        if command not in {"take_success"}:
            fields["data_path"] = str(self.data)
        return rust_runtime.desktop_login(command, **fields)

    def wait_state(self, *states):
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            status = self.manager.bbdown_login_status()
            if status["state"] in states:
                return status
            time.sleep(.01)
        self.fail(f"Login did not reach {states}")

    def worker(self, generation):
        worker = threading.Thread(target=self.manager._bbdown_login_worker, args=(generation,))
        worker.start()
        self.addCleanup(lambda: worker.join(16))
        return worker

    def join(self, worker):
        worker.join(12)
        self.assertFalse(worker.is_alive())

    def test_download_access_rejects_malformed_runtime_results(self):
        for result in [{}, {"message": False}, {"message": []}]:
            with self.subTest(result=result), patch.object(rust_runtime, "_call_runtime_service", return_value=result):
                with self.assertRaises(rust_runtime.RustStatusServiceError):
                    rust_runtime.desktop_login("download_access", source="bbdown", cookie="")

    def test_bbdown_new_commands_read_login_and_logout_without_restart(self):
        def command():
            cookie = bilibili.effective_bilibili_cookie()
            if message := self.manager._download_login_error("bbdown", cookie=cookie):
                raise RuntimeError(message)
            return cookie
        with patch("bilikara.bilibili.cfg.COOKIE", ""):
            self.assertEqual(command(), "")
            self.assertIn("下载需要登录", self.manager._download_login_error("downkyi"))
            with LoginFixture():
                generation = self.request("start", force=False)["generation"]
                self.join(self.worker(generation))
            self.assertTrue(self.manager.bbdown_login_status()["logged_in"])
            for source in ["bbdown", "downkyi"]:
                self.assertEqual(self.manager._download_login_error(source), "")
            authenticated = command()
            self.assertEqual(authenticated, bilibili.effective_bilibili_cookie())
            self.manager.logout_bbdown()
            self.assertEqual(self.manager._download_login_error("bbdown"), "")
            self.assertIn("下载需要登录", self.manager._download_login_error("downkyi"))
            self.assertEqual(command(), "")

    def test_success_png_downloader_readability_and_exactly_one_existing_hook(self):
        with LoginFixture() as fixture:
            arrived, release = threading.Event(), threading.Event()
            fixture.before_poll = lambda: (arrived.set(), release.wait(10))
            self.addCleanup(release.set)
            start = self.request("start", force=False)
            generation = start["generation"]
            worker = self.worker(generation)
            self.assertTrue(arrived.wait(8))
            status = self.manager.bbdown_login_status()
            self.assertEqual(status["state"], "waiting")
            self.assertTrue(status["qr_image"].startswith("data:image/png;base64,"))
            self.assertEqual((self.root / "qrcode.png").read_bytes()[:8], b"\x89PNG\r\n\x1a\n")
            self.assertIsNone(self.request("start", force=False)["generation"])
            release.set()
            self.join(worker)
            self.manager._bbdown_login_worker(generation)  # duplicate delivery/worker
            self.assertEqual(fixture.stages, ["generate", "poll"])
        self.assertEqual(self.hooks, ["refresh"])
        self.assertEqual(self.manager.bbdown_login_status(), {
            "logged_in": True, "state": "logged_in", "message": "BBDown 已登录",
            "data_path": str(self.data), "qr_image": "",
        })
        self.assertEqual(bilibili.cookie_from_bbdown_data(self.data), self.data.read_text(encoding="utf-8"))
        self.assertIn("b_nut=synthetic-nut", self.data.read_text(encoding="utf-8"))
        self.assertFalse((self.root / "bilibili-login.json").exists())
        self.assertFalse((self.root / "qrcode.png").exists())
        self.assertFalse((self.root / ".BBDown.data.login.tmp").exists())
        if os.name != "nt":
            self.assertEqual(self.data.stat().st_mode & 0o777, 0o600)
        logs = (self.manager.log_dir / "bilibili-login.log").read_text(encoding="utf-8")
        for forbidden in ("synthetic", "https://", "SESSDATA", "qrcode_key"):
            self.assertNotIn(forbidden, logs)
        self.manager.logout_bbdown()
        self.assertFalse(self.data.exists())

    def test_waiting_confirmation_then_expired(self):
        with LoginFixture() as fixture:
            fixture.codes = [86090, 86038]
            generation = self.request("start", force=False)["generation"]
            worker = self.worker(generation)
            deadline = time.monotonic() + 8
            while "确认" not in self.manager.bbdown_login_status()["message"]:
                self.assertLess(time.monotonic(), deadline)
                time.sleep(.01)
            self.join(worker)
        status = self.manager.bbdown_login_status()
        self.assertEqual(status["state"], "failed")
        self.assertIn("过期", status["message"])
        self.assertEqual(self.hooks, [])
        self.assertFalse(self.data.exists())

    def test_rejections_and_missing_or_wrong_scope_cookies_never_publish_success(self):
        for scenario in ("generate_http", "generate_api", "generate_json", "poll_api", "unknown", "ticket", "host_only"):
            with LoginFixture() as fixture, self.subTest(scenario=scenario):
                if scenario == "generate_http": fixture.generate_status = 403
                if scenario == "generate_api": fixture.generate_body = {"code": -1, "message": "synthetic-secret"}
                if scenario == "generate_json": fixture.generate_body = b"synthetic-bad-json"
                if scenario == "poll_api": fixture.poll_body = {"code": -1, "data": {"code": 0}}
                if scenario == "unknown": fixture.codes = [1]
                if scenario == "ticket": fixture.cookies = ["access_token=synthetic; Domain=.bilibili.com; Path=/"]
                if scenario == "host_only": fixture.cookies = ["SESSDATA=synthetic; Path=/", "bili_jct=synthetic; Path=/"]
                generation = self.request("start", force=True)["generation"]
                self.manager._bbdown_login_worker(generation)
                self.assertEqual(self.manager.bbdown_login_status()["state"], "failed")
                self.assertFalse(self.data.exists())
                self.assertEqual(self.hooks, [])
        logs = (self.manager.log_dir / "bilibili-login.log").read_text(encoding="utf-8")
        self.assertIn('"stage":"generate"', logs)
        self.assertIn('"stage":"poll"', logs)
        self.assertNotIn("synthetic", logs)

    def test_inflight_cancel_regenerate_logout_and_shutdown_discard_late_success(self):
        for stage in ("generate", "poll"):
            for action in ("cancel", "regenerate", "logout", "shutdown"):
                with LoginFixture() as fixture, self.subTest(stage=stage, action=action):
                    self.manager.stop_event.clear()
                    arrived, release = threading.Event(), threading.Event()
                    setattr(fixture, f"before_{stage}", lambda: (arrived.set(), release.wait(10)))
                    generation = self.request("start", force=True)["generation"]
                    worker = self.worker(generation)
                    self.assertTrue(arrived.wait(8))
                    try:
                        if action == "logout":
                            self.manager.logout_bbdown()
                        elif action == "regenerate":
                            replacement = self.request("start", force=True)["generation"]
                            self.assertNotEqual(replacement, generation)
                        elif action == "shutdown":
                            # Exercise the actual shutdown login invalidation with
                            # narrow mocks for unrelated cache cleanup below it.
                            self.manager.store = Mock()
                            self.manager.store.list_items.return_value = []
                            self.manager.urgent_workers = {}
                            self.manager.native_cache_started = False
                            self.manager.native_cache_event_stop = threading.Event()
                            self.manager.native_cache_event_worker = None
                            for name in (
                                "item_activity_at", "item_stage_progress_signatures", "item_download_progress",
                                "item_download_attempt_tokens", "python_worker_download_sources",
                                "python_cache_attempt_tokens", "retry_requested_ids", "settling_cache_attempt_tokens",
                                "cache_interrupted_messages", "urgent_cache_ids", "active_process_item_ids",
                                "native_cache_generations", "native_cache_attempt_tokens", "native_cache_terminal_sequences",
                                "native_cache_snapshot",
                            ):
                                setattr(self.manager, name, {})
                            with ExitStack() as cleanup:
                                cleanup.enter_context(patch.object(self.manager, "_artifact_request", return_value={"accepted": True, "collected": 0}))
                                for name in ("_begin_live_cache_attempts", "_active_processes_locked",
                                             "_terminate_processes", "_clear_cache_root"):
                                    cleanup.enter_context(patch.object(self.manager, name, return_value=[]))
                                self.manager.shutdown()
                        else:
                            self.request("cancel")
                    finally:
                        release.set()
                    self.join(worker)
                    self.assertEqual(self.hooks, [])
                    self.assertFalse(self.data.exists())
                    self.assertFalse((self.root / "qrcode.png").exists())
                    self.assertEqual(self.manager.bbdown_login_status()["state"], "starting" if action == "regenerate" else "idle")
                    self.request("cancel")

    def test_replacement_qr_survives_old_completion_and_only_replacement_notifies(self):
        with LoginFixture() as fixture:
            first_arrived, first_release = threading.Event(), threading.Event()
            second_arrived, second_release = threading.Event(), threading.Event()
            self.addCleanup(first_release.set)
            self.addCleanup(second_release.set)
            def hold_poll():
                if not first_arrived.is_set():
                    first_arrived.set()
                    first_release.wait(10)
                else:
                    second_arrived.set()
                    second_release.wait(10)
            fixture.before_poll = hold_poll
            first = self.request("start", force=False)["generation"]
            old_worker = self.worker(first)
            self.assertTrue(first_arrived.wait(8))
            second = self.request("start", force=True)["generation"]
            new_worker = self.worker(second)
            self.assertTrue(second_arrived.wait(8))
            first_release.set()
            self.join(old_worker)
            self.assertEqual(self.hooks, [])
            self.assertFalse(self.data.exists())
            self.assertEqual(self.manager.bbdown_login_status()["state"], "waiting")
            self.assertTrue((self.root / "qrcode.png").exists())
            second_release.set()
            self.join(new_worker)
            self.assertEqual(self.hooks, ["refresh"])

    def test_failed_poll_does_not_report_existing_valid_file_as_success(self):
        with LoginFixture() as fixture:
            fixture.codes = [1]
            fixture.before_poll = lambda: self.data.write_text("SESSDATA=existing; bili_jct=existing", encoding="utf-8")
            generation = self.request("start", force=False)["generation"]
            self.manager._bbdown_login_worker(generation)
        self.assertFalse(self.manager.bbdown_login_status()["logged_in"])
        self.assertEqual(self.manager.bbdown_login_status()["state"], "failed")
        self.assertEqual(self.hooks, [])
        self.assertEqual(self.data.read_text(encoding="utf-8"), "SESSDATA=existing; bili_jct=existing")

    def test_existing_desktop_routes_start_regenerate_logout_payloads(self):
        from types import SimpleNamespace
        from bilikara import server
        from bilikara.server import BilikaraHandler
        context = SimpleNamespace(
            cache_manager=self.manager,
            touch_client=lambda *args, **kwargs: None,
            snapshot=lambda: {"bbdown": {"login": self.manager.bbdown_login_status()}},
        )
        workers = []
        original_thread = threading.Thread
        def capture_thread(*args, **kwargs):
            worker = original_thread(*args, **kwargs)
            if kwargs.get("target") == self.manager._bbdown_login_worker:
                workers.append(worker)
            return worker
        def request(path, body):
            handler = BilikaraHandler.__new__(BilikaraHandler)
            handler.path, handler.headers = path, {}
            handler._read_json_body = lambda: body
            writes = []
            handler._write_json = lambda payload, status=None: writes.append((payload, status))
            handler.do_POST()
            self.assertEqual(len(writes), 1)
            self.assertTrue(writes[0][0]["ok"])
            return writes[0][0]["data"]["bbdown"]["login"]
        with LoginFixture() as fixture, patch.object(server, "CONTEXT", context):
            # Generation requests are held so route replacement and logout run
            # while the real network requests are in flight.
            release = threading.Event()
            self.addCleanup(release.set)
            fixture.before_generate = lambda: release.wait(10)
            with patch("bilikara.cache.threading.Thread", side_effect=capture_thread):
                # ThreadingHTTPServer and other callers share the threading module.
                # An unrelated thread must not count as another login attempt.
                unrelated = threading.Thread(target=lambda: None)
                unrelated.start()
                self.join(unrelated)
                self.assertEqual(request("/api/bbdown/login/start", {})["state"], "starting")
                self.assertEqual(request("/api/bbdown/login/start", {})["state"], "starting")
                self.assertEqual(len(workers), 1)
                self.assertEqual(request("/api/bbdown/login/start", {"force": True})["state"], "starting")
                self.assertEqual(len(workers), 2)
            self.assertEqual(request("/api/bbdown/logout", {})["state"], "idle")
            release.set()
            for worker in workers:
                self.join(worker)
        self.assertFalse(self.data.exists())
        self.assertEqual(self.hooks, [])

    def test_credential_write_failure_preserves_file_and_no_notification(self):
        self.data.write_text("ticket=synthetic", encoding="utf-8")
        with LoginFixture() as fixture:
            fixture.before_poll = lambda: (self.root / ".BBDown.data.login.tmp").mkdir()
            generation = self.request("start", force=False)["generation"]
            self.manager._bbdown_login_worker(generation)
        self.assertEqual(self.data.read_text(encoding="utf-8"), "ticket=synthetic")
        self.assertEqual(self.manager.bbdown_login_status()["state"], "failed")
        self.assertEqual(self.hooks, [])

    def test_completion_before_hook_is_invalidated_by_logout_or_replacement(self):
        for action in ("logout", "replacement", "cancel"):
            with LoginFixture(), self.subTest(action=action):
                self.request("logout")
                generation = self.request("start", force=True)["generation"]
                # Execute through FFI, leaving the committed event unconsumed.
                self.request("run", generation=generation)
                self.assertTrue(self.data.exists())
                if action == "replacement":
                    self.request("logout")
                    self.request("start", force=True)
                else:
                    self.request(action)
                self.manager._bbdown_login_worker(generation)
                self.assertEqual(self.hooks, [])

    def test_legacy_json_text_and_configured_precedence(self):
        values = [
            '\ufeff{"cookies":[{"name":"sessdata","value":"synthetic"},{"name":"BILI_JCT","value":"csrf"}]}',
            '{"SESSDATA":"synthetic","bili_jct":"csrf"}',
            "sessdata=synthetic; BILI_JCT=csrf",
        ]
        with patch("bilikara.bilibili.cfg.COOKIE", " configured=retained "):
            self.assertEqual(bilibili.effective_bilibili_cookie(), "configured=retained")
            for value in values:
                self.data.write_text(value, encoding="utf-8")
                self.assertEqual(bilibili.cookie_from_bbdown_data(self.data), "SESSDATA=synthetic; bili_jct=csrf")
                self.assertEqual(bilibili.effective_bilibili_cookie(), "SESSDATA=synthetic; bili_jct=csrf")
            self.data.write_text("ticket=synthetic", encoding="utf-8")
            self.assertEqual(bilibili.cookie_from_bbdown_data(self.data), "")
            self.assertEqual(bilibili.effective_bilibili_cookie(), "configured=retained")

    def test_diagnostic_or_hook_failure_does_not_undo_committed_login(self):
        def failed_hook():
            self.hooks.append("refresh")
            raise RuntimeError("synthetic follow-up failure")
        self.manager.on_bbdown_login_success = failed_hook
        with LoginFixture(), patch.object(self.manager, "_append_log_line", side_effect=OSError("synthetic log failure")):
            generation = self.request("start", force=False)["generation"]
            self.manager._bbdown_login_worker(generation)
        self.assertEqual(self.hooks, ["refresh"])
        self.assertTrue(self.manager.bbdown_login_status()["logged_in"])
        self.assertTrue(self.data.exists())

    def test_malformed_native_login_results_fail_before_consumption(self):
        for command, result in (
            ("start", {}), ("start", {"generation": True}),
            ("read_cookie", []), ("read_cookie", {"cookie": None}),
            ("take_success", {"notify": "true"}),
            ("run", {"diagnostics": [{"cookie": "synthetic-private"}]}),
        ):
            with self.subTest(command=command), patch.object(rust_runtime, "_call_runtime_service", return_value=result):
                with self.assertRaises(rust_runtime.RustStatusServiceError):
                    rust_runtime.desktop_login(command, generation=1)
        self.assertFalse(self.data.exists())
        self.assertEqual(self.hooks, [])

    def test_unavailable_tls_fixture_skips_the_whole_case(self):
        for method in (
            "test_rejections_and_missing_or_wrong_scope_cookies_never_publish_success",
            "test_inflight_cancel_regenerate_logout_and_shutdown_discard_late_success",
            "test_completion_before_hook_is_invalidated_by_logout_or_replacement",
        ):
            with self.subTest(method=method):
                case = type(self)(method)
                result = unittest.TestResult()
                with patch.object(LoginFixture, "__enter__", side_effect=unittest.SkipTest("TLS trust unavailable")):
                    case.run(result)
                self.assertEqual(result.errors, [])
                self.assertEqual(result.failures, [])
                self.assertEqual(result.skipped, [(case, "TLS trust unavailable")])

    def test_unavailable_runtime_has_no_python_login_fallback(self):
        with patch.object(rust_runtime, "_runtime_lib", None):
            with self.assertRaises(rust_runtime.RustRuntimeUnavailableError):
                self.manager.start_bbdown_login()
        self.assertFalse(self.data.exists())
