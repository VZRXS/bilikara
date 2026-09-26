"""Default Python Host -> ordinary Runtime ABI -> shared DownKyi child and AppState.

No forwarding proxy, real credentials, user storage, or media CLI. Child receipts
contain only synthetic identities/settings, never argv/cookies/provider URLs.
"""
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import unittest
from contextlib import ExitStack
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

from bilikara import rust_runtime
from bilikara.cache import CacheManager
from bilikara.store import PlaylistStoreCommandError
from tests import test_cache as fixtures
from tests.video_service_fixture import VideoFixture


@unittest.skipUnless(sys.platform.startswith("linux"), "local TLS trust fixture requires Linux")
class DownKyiFixture:
    make_item = fixtures.CacheManagerPolicyTest.make_item

    @classmethod
    def setUpClass(cls):
        cls.build = TemporaryDirectory()
        cls.addClassCleanup(cls.build.cleanup)
        cls.binary = Path(cls.build.name) / "aria2c"
        subprocess.run(["rustc", str(Path(__file__).with_name("aria2_fixture.rs")),
                        "-o", str(cls.binary)], check=True, capture_output=True)

    def setUp(self):
        fixtures.CacheManagerPolicyTest.setUp(self)
        self.stack = ExitStack()
        self.root = Path(self.temp_dir.name)
        self.tool = self.root / "tools" / "aria2c"
        self.tool.mkdir(parents=True)
        shutil.copy2(self.binary, self.tool / "aria2c")
        (self.tool / "VERSION").write_text("1.6.3")
        (self.tool / "BBDown.config").write_text("--ffmpeg-path forbidden-muxer")
        (self.tool / "BBDown.data").write_text("adjacent-cookie-must-not-be-used")
        self.control = self.root / "child"
        self.control.mkdir()
        self.mode("ok")
        self.stack.enter_context(patch.dict(os.environ, {
            "BILIKARA_BILIBILI_COOKIE": "SESSDATA=synthetic; bili_jct=csrf",
            "BILIKARA_ARIA2_FIXTURE_ROOT": str(self.control),
            "BILIKARA_ARIA2_MEDIA": str(Path(__file__).parent / "fixtures" / "bbdown"),
            "BILIKARA_BBDOWN_EXPECT_COOKIE": "SESSDATA=synthetic; bili_jct=csrf",
        }))
        for name, value in {
            "CACHE_DIR": self.cache_dir, "LOG_DIR": self.root / "logs",
            "ARIA2C_DIR": self.tool, "ARIA2C_PATH_OVERRIDE": str(self.tool / "aria2c"),
            "BB_DOWN_VERSION_FILE": self.tool / "VERSION", "PACKAGED_RUNTIME": False,
        }.items():
            self.stack.enter_context(patch("bilikara.cache." + name, value))
        self.stack.enter_context(patch("bilikara.cache.effective_bilibili_cookie",
                                       return_value="SESSDATA=synthetic; bili_jct=csrf"))
        self.net = self.stack.enter_context(VideoFixture())
        self.net.return_value = self.response
        self.video_codec = 7
        self.dolby_only = False
        self.media_origin = None
        self.forbidden = self.stack.enter_context(patch.object(
            CacheManager, "_download_selected_streams", side_effect=AssertionError("Python transfer executor")))
        self.manager = CacheManager(self.store, max_cache_items=3)
        self.manager.download_source = "downkyi"
        self.manager.audio_hires = False
        self.persisted = []
        persist = self.store._persist_response_unlocked
        def record_persistence(response):
            persist(response)
            self.persisted.append(response)
        self.stack.enter_context(patch.object(self.store, "_persist_response_unlocked", side_effect=record_persistence))
        self.observations = []
        self.store.on_change = lambda: self.observations.append(self.store.snapshot())

    def tearDown(self):
        self.manager.shutdown()
        self.store.on_change = None
        self.forbidden.assert_not_called()
        self.stack.close()
        fixtures.CacheManagerPolicyTest.tearDown(self)

    def mode(self, mode):
        (self.control / "mode").write_text(mode)

    def _metadata(self, path):
        if path.startswith("/x/web-interface/nav"):
            return {"code": 0, "data": {"wbi_img": {"img_url": "https://example.invalid/" + "a" * 32 + ".png",
                                                     "sub_url": "https://example.invalid/" + "b" * 32 + ".png"}}}
        if path.startswith("/x/player/wbi/playurl"):
            cid = parse_qs(urlsplit(path).query)["cid"][0]
            return {"code": 0, "data": {"dash": {
                "video": [{"id": 64, "codecid": self.video_codec, "baseUrl": f"https://api.bilibili.com/video{'-hevc' if self.video_codec == 12 else ''}.mp4?cid={cid}", "bandwidth": 10}],
                "audio": [] if self.dolby_only else [{"id": 30280, "baseUrl": f"https://api.bilibili.com/audio.m4a?cid={cid}", "bandwidth": 10}],
                "flac": None if self.dolby_only else {"audio": {"id": 30251, "baseUrl": f"https://api.bilibili.com/audio-flac.mp4?cid={cid}"}},
                "dolby": {"audio": [{"id": 30250, "baseUrl": f"https://api.bilibili.com/audio-eac3.m4a?cid={cid}"}]} if self.dolby_only else None,
            }}}
        name = urlsplit(path).path.lstrip("/")
        if name in {"video.mp4", "audio.m4a", "audio-flac.mp4"}:
            return (Path(__file__).parent / "fixtures" / "bbdown" / name).read_bytes()
        raise AssertionError("unexpected network operation")

    def add(self, name="song", *, pages=(2, 1)):
        item = self.make_item(name)
        item.selected_pages = list(pages)
        item.selected_cids = [456 + page for page in pages]
        item.selected_parts = ["off vocal" if p == 2 else "main track" for p in pages]
        item.selected_durations = [999] * len(pages)
        item.available_pages = [1, 2]
        item.available_cids = [457, 458]
        item.video_page = pages[0]
        item.selected_audio_variant_id = "p2_off_vocal"
        self.store.add_item(item, requester_name="cache-test-user")
        return self.store.get_item(name)

    def wait_for(self, predicate):
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            result = predicate()
            if result:
                return result
            time.sleep(.01)
        self.fail("fixture did not reach the controlled boundary")

    def status(self, item, expected):
        return self.wait_for(lambda: self.store.get_item(item.id).cache_status == expected)

    def receipts(self, suffix="started"):
        return list(self.control.glob("*." + suffix))

    def response(self, path):
        response = self._metadata(path)
        if self.media_origin and isinstance(response, dict) and "dash" in response.get("data", {}):
            def replace(value):
                if isinstance(value, str):
                    return value.replace("https://api.bilibili.com", self.media_origin)
                if isinstance(value, list): return [replace(v) for v in value]
                if isinstance(value, dict): return {k: replace(v) for k, v in value.items()}
                return value
            return replace(response)
        return response


class DefaultHostDownKyiTest(DownKyiFixture, unittest.TestCase):
    def test_connection_budget_is_captured_with_trusted_capability(self):
        with patch.dict(os.environ, {"BILIKARA_ARIA2_CONNECTIONS_PER_TRACK": "3"}):
            self.assertTrue(self.manager._configure_aria2_executor()["ready"])
        with patch.dict(os.environ, {"BILIKARA_ARIA2_EXPECT_CONNECTIONS": "3"}):
            item = self.add()
            self.manager.sync_with_playlist()
            self.status(item, "ready")

    def test_shutdown_interrupts_configuration_without_holding_appstate(self):
        self.mode("probe_hold")
        self.manager._ensure_native_cache_runtime()
        errors = []
        def configure():
            try:
                self.manager._configure_aria2_executor()
            except rust_runtime.RustRuntimeServiceError as error:
                errors.append(error.kind)
        worker = threading.Thread(target=configure)
        worker.start()
        self.addCleanup(worker.join, 8)
        self.wait_for(lambda: self.receipts("probe"))
        self.add("remains-responsive")
        start = time.monotonic()
        self.manager.shutdown()
        worker.join(2)
        self.assertFalse(worker.is_alive())
        self.assertLess(time.monotonic() - start, 2)
        self.assertEqual(errors, ["stopped"])
        for receipt in self.receipts("probe"):
            with self.assertRaises(ProcessLookupError): os.kill(int(receipt.stem), 0)

    def test_urgent_and_legacy_source_handoff_drains_before_new_owner(self):
        current = self.add("current", pages=(1,))
        self.manager.sync_with_playlist()
        self.status(current, "ready")
        self.store.set_current_item(current.id)
        background = self.add("background", pages=(1,))
        self.mode("hold")
        self.manager.sync_with_playlist()
        self.wait_for(lambda: len(self.receipts()) == 4)
        self.manager.retry_item(current.id, expected_item_incarnation_id=current.item_incarnation_id, force=True)
        self.wait_for(lambda: len(self.receipts()) == 6)
        state = rust_runtime.cache_runtime_request("snapshot")
        self.assertEqual(state["primary_active_item_id"], background.id)
        self.assertIn(current.id, state["urgent_item_ids"])
        with patch.object(self.manager, "_cache_item", return_value=False):
            self.manager.set_cache_policy(download_source="ytdlp")
            self.manager.retry_item(current.id, expected_item_incarnation_id=current.item_incarnation_id, force=True)
            self.wait_for(lambda: current.id not in self.manager.python_worker_download_sources)
        self.assertNotIn(current.id, rust_runtime.cache_runtime_request("snapshot")["active_item_ids"])
        self.mode("ok")
        self.manager.set_cache_policy(download_source="downkyi")
        self.manager.retry_item(current.id, expected_item_incarnation_id=current.item_incarnation_id, force=True)
        self.wait_for(lambda: len(self.receipts()) == 8)
        self.wait_for(lambda: current.id not in rust_runtime.cache_runtime_request("snapshot")["active_item_ids"])
        self.manager.shutdown()
        for receipt in self.receipts():
            with self.assertRaises(ProcessLookupError): os.kill(int(receipt.stem), 0)

    def test_login_required_before_preparation_or_child_admission(self):
        item = self.add()
        with patch("bilikara.cache.effective_bilibili_cookie", return_value=""), patch.object(
            self.manager, "_configure_aria2_executor", wraps=self.manager._configure_aria2_executor
        ) as prepare:
            self.manager.sync_with_playlist()
            self.status(item, "failed")
            prepare.assert_not_called()
            self.assertEqual(self.receipts(), [])
            self.assertEqual(self.receipts("probe"), [])
            self.assertIn("登录 Bilibili", self.store.get_item(item.id).cache_message)
            with self.assertRaisesRegex(ValueError, "登录 Bilibili"):
                self.manager.retry_item(item.id, expected_item_incarnation_id=item.item_incarnation_id)
        self.manager.retry_item(item.id, expected_item_incarnation_id=item.item_incarnation_id)
        self.status(item, "ready")

    def test_failed_configuration_is_cached_until_explicit_preparation(self):
        with patch("bilikara.cache.ARIA2C_PATH_OVERRIDE", str(self.root / "missing")), patch(
            "bilikara.rust_runtime.configure_aria2", wraps=rust_runtime.configure_aria2
        ) as configure:
            item = self.add()
            self.manager.sync_with_playlist()
            self.status(item, "failed")
            for _ in range(3):
                self.manager.sync_with_playlist()
                self.assertFalse(self.manager.downloader_status("downkyi")["ready"])
            self.assertEqual(configure.call_count, 1)
        self.assertTrue(self.manager.prepare_downloader("downkyi")["ready"])
        self.manager.retry_item(item.id, expected_item_incarnation_id=item.item_incarnation_id)
        self.status(item, "ready")

    def test_multi_page_real_abi_persistence_and_no_python_transfer(self):
        self.assertFalse(hasattr(CacheManager, "_download_stream_with_aria2c"))
        self.assertFalse(hasattr(CacheManager, "_download_dash_streams_with_aria2c"))
        item = self.add()
        self.manager.sync_with_playlist()
        self.status(item, "ready")
        result = self.store.get_item(item.id)
        self.assertEqual([v["page"] for v in result.audio_variants], [2, 1])
        self.assertEqual([v["id"] for v in result.audio_variants], ["p2_off_vocal", "p1_main_track"])
        self.assertEqual(result.selected_audio_variant_id, "p2_off_vocal")
        self.assertEqual(len(self.receipts()), 3)
        self.assertTrue(self.observations)
        self.assertIn(result.artifact_set_id, json.dumps(self.persisted))
        self.assertTrue(self.store.backup_file.is_file())
        self.assertEqual(self.manager.python_worker_download_sources, {})
        self.assertTrue(self.manager.tasks.empty())
        self.assertFalse(list(self.cache_dir.rglob("aria2.input")))
        self.assertFalse(list(self.cache_dir.rglob("aria2.cookies")))
        self.assertTrue(any("DownKyi/aria2c" in json.dumps(o) for o in self.observations))

    def test_progress_is_transferred_bytes_and_cancel_reaps_siblings(self):
        self.mode("preallocated")
        item = self.add()
        self.manager.sync_with_playlist()
        self.wait_for(lambda: len(self.receipts()) == 3)
        self.wait_for(lambda: "128 B" in self.store.get_item(item.id).cache_message)
        self.assertIn("128 B / 976.6 KB", self.store.get_item(item.id).cache_message)
        self.manager.clear_runtime_cache()
        self.wait_for(lambda: not rust_runtime.cache_runtime_request("snapshot")["active_item_ids"])
        for receipt in self.receipts():
            with self.assertRaises(ProcessLookupError): os.kill(int(receipt.stem), 0)
        self.assertNotEqual(self.store.get_item(item.id).cache_status, "ready")
        self.assertFalse(list(self.cache_dir.rglob("aria2.cookies")))

    def test_retry_refresh_hires_and_protected_failure(self):
        self.mode("retry")
        item = self.add()
        self.manager.sync_with_playlist()
        self.status(item, "ready")
        self.assertEqual(len(self.receipts()), 6)
        old = self.store.get_item(item.id)
        lease = self.manager.acquire_media_reader(old.video_relative_path)
        self.addCleanup(lambda: self.manager.release_media_reader(lease))
        self.mode("ok")
        self.manager.audio_hires = True
        self.manager.retry_item(item.id, expected_item_incarnation_id=item.item_incarnation_id, force=True)
        self.wait_for(lambda: self.store.get_item(item.id).artifact_set_id != old.artifact_set_id)
        new = self.store.get_item(item.id)
        self.assertTrue(all(v["audio_url"].endswith(".flac") for v in new.audio_variants))
        self.assertTrue((self.cache_dir / old.video_relative_path).exists())
        self.mode("invalid")
        self.manager.retry_item(item.id, expected_item_incarnation_id=item.item_incarnation_id, force=True)
        self.wait_for(lambda: bool(rust_runtime.cache_runtime_request("snapshot")["terminal_events"]))
        self.manager._drain_native_cache_events()
        self.assertEqual(self.store.get_item(item.id).artifact_set_id, new.artifact_set_id)
        self.assertTrue((self.cache_dir / new.video_relative_path).exists())

    def test_finite_attempts_and_failed_until_explicit_retry(self):
        self.mode("always_fail")
        item = self.add(pages=(1,))
        self.manager.sync_with_playlist()
        self.status(item, "failed")
        counts = [p.read_text().split(":")[0] for p in self.receipts()]
        self.assertEqual(max(counts.count(v) for v in set(counts)), 10)
        self.assertLessEqual(len(counts), 20)
        for _ in range(3): self.manager.sync_with_playlist()
        self.assertEqual(len(self.receipts()), len(counts))
        self.assertIn("10 attempts", self.store.get_item(item.id).cache_message)

    def test_cancel_during_retry_wait(self):
        self.mode("always_fail")
        item = self.add(pages=(1,))
        self.manager.sync_with_playlist()
        self.wait_for(lambda: "次失败" in self.store.get_item(item.id).cache_message)
        count = len(self.receipts())
        self.manager.shutdown()
        self.assertEqual(len(self.receipts()), count)
        self.assertFalse(list(self.cache_dir.rglob("aria2.input")))

    def test_invalid_override_and_input_fail_closed(self):
        item = self.add()
        with patch("bilikara.cache.ARIA2C_PATH_OVERRIDE", str(self.root / "missing")):
            self.manager.sync_with_playlist()
        self.status(item, "failed")
        self.assertEqual(len(self.receipts()), 0)
        self.assertFalse(self.manager.aria2_configuration["ready"])
        self.manager.aria2_configuration = None
        with patch("bilikara.cache.effective_bilibili_cookie", return_value="SESSDATA=bad\n header=Injected: bad"):
            with self.assertRaisesRegex(ValueError, "下载需要登录"):
                self.manager.retry_item(item.id, expected_item_incarnation_id=item.item_incarnation_id)
        self.assertEqual(len(self.receipts()), 0)

    def test_terminal_errors_and_bounded_media_validation_retries(self):
        for mode in ["forbidden", "extra", "invalid"]:
            with self.subTest(mode=mode):
                self.mode(mode)
                item = self.add(mode, pages=(1,))
                prior_receipts = set(self.receipts())
                previous = len(prior_receipts)
                self.manager.sync_with_playlist()
                self.status(item, "failed")
                if mode == "invalid":
                    own = [
                        p.read_text().split(":")[0] for p in self.receipts()
                        if p not in prior_receipts
                    ]
                    self.assertEqual(max(own.count(track) for track in set(own)), 10)
                    self.assertLessEqual(len(own), 20)
                    self.assertIn("10 attempts", self.store.get_item(item.id).cache_message)
                else:
                    self.assertLessEqual(len(self.receipts()) - previous, 2)
                self.assertNotIn("credential-must-never-be-logged", self.store.get_item(item.id).cache_message)
                self.store.remove_item(item.id)

    def test_stale_incarnation_and_shutdown(self):
        from tests.test_default_host_bbdown import DefaultHostBBDownTest
        DefaultHostBBDownTest.test_stop_reaps_replacement_and_stale_incarnation_cannot_retry(self)

    def test_only_failed_track_retries_and_terminal_video_stops_waiting_siblings(self):
        self.mode("retry_video")
        item = self.add()
        self.manager.sync_with_playlist()
        self.status(item, "ready")
        receipts = [p.read_text().split(":")[0] for p in self.receipts()]
        self.assertEqual(receipts.count("video-p2"), 2)
        self.assertEqual(receipts.count("audio-p2"), 1)
        self.assertEqual(receipts.count("audio-p1"), 1)
        self.mode("invalid_video")
        old = self.store.get_item(item.id)
        self.manager.retry_item(item.id, expected_item_incarnation_id=item.item_incarnation_id, force=True)
        self.wait_for(lambda: bool(rust_runtime.cache_runtime_request("snapshot")["terminal_events"]))
        self.wait_for(lambda: not rust_runtime.cache_runtime_request("snapshot")["active_item_ids"])
        for receipt in self.receipts():
            with self.assertRaises(ProcessLookupError): os.kill(int(receipt.stem), 0)
        self.manager._drain_native_cache_events()
        self.assertEqual(self.store.get_item(item.id).artifact_set_id, old.artifact_set_id)

    def test_existing_managed_tool_is_validated_once_and_active_reconfiguration_is_rejected(self):
        with patch("bilikara.cache.ARIA2C_PATH_OVERRIDE", ""):
            result = self.manager._configure_aria2_executor(install=True)
        self.assertTrue(result["ready"])
        self.assertEqual(Path(result["path"]), self.tool / "aria2c")
        count = len(self.receipts("probe"))
        self.mode("hold")
        item = self.add()
        self.manager.sync_with_playlist()
        self.wait_for(lambda: len(self.receipts()) == 3)
        for _ in range(3): self.manager.sync_with_playlist()
        self.assertEqual(len(self.receipts("probe")), count)
        with self.assertRaises(rust_runtime.RustRuntimeServiceError) as rejected:
            rust_runtime.configure_aria2(owner=self.manager._artifact_owner, directory=self.tool,
                override_path=Path("/bin/true"), vendor_roots=[], install=False)
        self.assertEqual(rejected.exception.kind, "busy")
        self.assertEqual(self.manager.python_worker_download_sources, {})

    def test_missing_cid_and_incompatible_override_do_not_launch_downloads(self):
        item = self.make_item("missing-cid")
        item.selected_pages = [2]
        item.selected_cids = []
        item.available_pages = [1]
        item.available_cids = [457]
        self.store.add_item(item, requester_name="cache-test-user")
        self.manager.sync_with_playlist()
        self.status(item, "failed")
        self.assertEqual(self.receipts(), [])
        self.manager.aria2_configuration = None
        with patch("bilikara.cache.ARIA2C_PATH_OVERRIDE", "/bin/true"):
            result = self.manager._configure_aria2_executor(install=True)
        self.assertFalse(result["ready"])
        self.assertEqual(result["kind"], "invalid_override")

    def test_hevc_and_dolby_preserve_validated_source_bytes(self):
        if not rust_runtime._media_companion_provisioned:
            # Media routing is configured once per process. Keep the legacy
            # pure-Rust/fallback suite independent of this packaged-libav case.
            companion = os.environ.get("BILIKARA_TEST_LIBAV_COMPANION", "")
            self.assertTrue(
                companion and Path(companion).is_file(),
                "Set BILIKARA_TEST_LIBAV_COMPANION to the built libav companion",
            )
            completed = subprocess.run(
                [sys.executable, "-m", "unittest", "tests." + self.id().removeprefix("tests."), "-v"],
                env={**os.environ, "BILIKARA_LIBAV_COMPANION": companion},
                capture_output=True, text=True, timeout=90,
            )
            self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
            return
        self.video_codec = 12
        self.dolby_only = True
        self.manager.audio_hires = True
        item = self.add()
        self.manager.sync_with_playlist()
        self.status(item, "ready")
        ready = self.store.get_item(item.id)
        self.assertEqual((self.cache_dir / ready.video_relative_path).read_bytes(),
                         (Path(__file__).parent / "fixtures/bbdown/video-hevc.mp4").read_bytes())
        for variant in ready.audio_variants:
            self.assertEqual((self.cache_dir / variant["audio_url"].removeprefix("/media/")).read_bytes(),
                             (Path(__file__).parent / "fixtures/bbdown/audio-eac3.m4a").read_bytes())

    def test_video_page_is_independent_of_selected_audio_pages(self):
        item = self.make_item("different-video")
        item.video_page = 2
        item.selected_pages = [1]
        item.selected_cids = [457]
        item.selected_parts = ["main track"]
        item.available_pages = [1, 2]
        item.available_cids = [457, 458]
        self.store.add_item(item, requester_name="cache-test-user")
        self.manager.sync_with_playlist()
        self.status(item, "ready")
        receipts = [p.read_text().split(":")[0] for p in self.receipts()]
        self.assertCountEqual(receipts, ["video-p2", "audio-p1"])
        self.assertEqual([v["page"] for v in self.store.get_item(item.id).audio_variants], [1])

    def test_native_and_bbdown_handoffs_keep_captured_source_and_drain_old_children(self):
        item = self.add()
        self.mode("hold")
        self.manager.sync_with_playlist()
        self.wait_for(lambda: len(self.receipts()) == 3)
        old = [int(p.stem) for p in self.receipts()]
        self.manager.set_cache_policy(download_source="native")
        self.manager.sync_with_playlist()
        self.assertEqual(len(self.receipts()), 3)
        self.manager.retry_item(item.id, expected_item_incarnation_id=item.item_incarnation_id, force=True)
        self.status(item, "ready")
        for pid in old:
            with self.assertRaises(ProcessLookupError): os.kill(pid, 0)
        native = self.store.get_item(item.id)
        bbdown = self.tool / "BBDown"
        subprocess.run(["rustc", str(Path(__file__).with_name("bbdown_fixture.rs")), "-o", str(bbdown)], check=True, capture_output=True)
        self.mode("ok")
        with patch("bilikara.cache.BB_DOWN_PATH_OVERRIDE", str(bbdown)), patch.dict(os.environ, {
            "BILIKARA_BBDOWN_FIXTURE_ROOT": str(self.control), "BILIKARA_BBDOWN_MEDIA": str(Path(__file__).parent / "fixtures/bbdown"),
            "BILIKARA_BBDOWN_EXPECT_COOKIE": "SESSDATA=synthetic; bili_jct=csrf"}):
            self.manager.set_cache_policy(download_source="bbdown")
            self.manager.retry_item(item.id, expected_item_incarnation_id=item.item_incarnation_id, force=True)
            self.wait_for(lambda: self.store.get_item(item.id).artifact_set_id != native.artifact_set_id)
        bbdown_ready = self.store.get_item(item.id)
        self.manager.set_cache_policy(download_source="downkyi")
        self.manager.retry_item(item.id, expected_item_incarnation_id=item.item_incarnation_id, force=True)
        self.wait_for(lambda: self.store.get_item(item.id).artifact_set_id != bbdown_ready.artifact_set_id)
        self.assertEqual(self.manager.python_worker_download_sources, {})


@unittest.skipUnless(os.environ.get("BILIKARA_TEST_ARIA2"), "set a real local aria2c executable for localhost integration")
class RealAria2Test(DownKyiFixture, unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.binary = Path(os.environ["BILIKARA_TEST_ARIA2"]).resolve()

    def setUp(self):
        super().setUp()
        for lib in self.binary.parent.glob("*.so*"):
            shutil.copy2(lib, self.tool / lib.name)
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        fixture = self
        self.media_requests = []
        self.transfer_started = threading.Event()
        self.transfer_release = threading.Event()
        self.hold = False
        self.reject = False
        self.backup = False

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_): pass
            def do_GET(self):
                fixture.media_requests.append((self.path, self.headers.get("Cookie")))
                status = 403 if fixture.reject else 503 if self.path.startswith("/fail/") else 200
                name = urlsplit(self.path).path.rsplit("/", 1)[-1]
                data = (Path(__file__).parent / "fixtures" / "bbdown" / name).read_bytes() if status == 200 else b""
                self.send_response(status)
                self.send_header("Content-Length", len(data))
                self.end_headers()
                if fixture.hold:
                    fixture.transfer_started.set()
                    fixture.transfer_release.wait(10)
                try: self.wfile.write(data)
                except (BrokenPipeError, ConnectionResetError): pass
        self.http = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.http_thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.http_thread.start()
        self.media_origin = f"http://127.0.0.1:{self.http.server_port}"
        self.stack.enter_context(patch.dict(os.environ, {"NO_PROXY": "127.0.0.1,localhost", "no_proxy": "127.0.0.1,localhost"}))

    def tearDown(self):
        self.manager.shutdown()
        self.transfer_release.set()
        self.http.shutdown()
        self.http.server_close()
        self.http_thread.join()
        super().tearDown()

    def response(self, path):
        result = super().response(path)
        if self.backup and isinstance(result, dict):
            for kind in ["video", "audio"]:
                for stream in result.get("data", {}).get("dash", {}).get(kind, []):
                    stream["backupUrl"] = [stream["baseUrl"]]
                    stream["baseUrl"] = stream["baseUrl"].replace(self.media_origin + "/", self.media_origin + "/fail/")
        return result

    def test_real_tool_localhost_multitrack_candidate_failover(self):
        self.backup = True
        item = self.add()
        self.manager.sync_with_playlist()
        self.status(item, "ready")
        ready = self.store.get_item(item.id)
        self.assertEqual([v["page"] for v in ready.audio_variants], [2, 1])
        requests = [p for p, _ in self.media_requests]
        self.assertTrue(any(p.startswith("/fail/") for p in requests))
        self.assertIn("/audio.m4a?cid=457", requests)
        self.assertIn("/audio.m4a?cid=458", requests)
        self.assertIn("/video.mp4?cid=458", requests)
        # Cookie is scoped to Bilibili/CDNs: fake credentials must not be
        # forwarded to the loopback fixture, even via a metadata-supplied URL.
        self.assertTrue(all(cookie is None for _, cookie in self.media_requests))
        self.assertTrue((self.cache_dir / ready.video_relative_path).is_file())
        self.assertIn(ready.artifact_set_id, json.dumps(self.persisted))
        self.assertFalse(list(self.cache_dir.rglob("aria2.input")))

    def test_real_tool_cancel_and_terminal_forbidden(self):
        self.hold = True
        item = self.add(pages=(1,))
        self.manager.sync_with_playlist()
        self.assertTrue(self.transfer_started.wait(8))
        self.manager.clear_runtime_cache()
        self.wait_for(lambda: not rust_runtime.cache_runtime_request("snapshot")["active_item_ids"])
        self.assertNotEqual(self.store.get_item(item.id).cache_status, "ready")
        self.transfer_release.set()
        self.hold = False
        self.reject = True
        self.manager.retry_item(item.id, expected_item_incarnation_id=item.item_incarnation_id, force=True)
        self.status(item, "failed")
        self.assertIn("403", self.store.get_item(item.id).cache_message)
        self.assertFalse(list(self.cache_dir.rglob("aria2.cookies")))

@unittest.skipUnless(os.environ.get("BILIKARA_TEST_NATIVE_HOST") or os.environ.get("BILIKARA_TEST_NATIVE_PACKAGE"), "set the compiled native desktop Host binary or package")
class NativeDesktopDownKyiTest(unittest.TestCase):
    def test_native_desktop_http_uses_shared_executor_and_keeps_source_and_media(self):
        import http.cookiejar
        import select
        import urllib.error
        import urllib.request
        with TemporaryDirectory() as temporary, ExitStack() as stack:
            root = Path(temporary)
            home = root / "host"
            home.mkdir()
            (home / ".bilikara-desktop-rust-preview").write_text("desktop-rust-preview-v1\n")
            (home / "BBDown.data").write_text("SESSDATA=synthetic; bili_jct=csrf")
            control = root / "control"
            control.mkdir()
            (control / "mode").write_text("ok")
            binary = root / "aria2c"
            subprocess.run(["rustc", str(Path(__file__).with_name("aria2_fixture.rs")), "-o", str(binary)], check=True, capture_output=True)
            net = stack.enter_context(VideoFixture())
            def response(path):
                if path.startswith("/x/web-interface/wbi/view"):
                    return {"code": 0, "data": {"aid": 123, "bvid": "BV1xx411c7mD", "title": "test song", "pic": "", "owner": {"mid": 42, "name": "fixture"},
                        "pages": [{"page": 1, "cid": 457, "duration": 999, "part": "track A"}, {"page": 2, "cid": 458, "duration": 500, "part": "track B"}]}}
                harness = type("Metadata", (), {"video_codec": 7, "dolby_only": False})()
                return DownKyiFixture._metadata(harness, path)
            net.return_value = response
            env = dict(os.environ, ARIA2C_PATH=str(binary), BILIKARA_HOME=str(home),
                BILIKARA_BILIBILI_COOKIE="SESSDATA=synthetic; bili_jct=csrf",
                       BB_DOWN_PATH=str(root / "missing-BBDown"),
                       BILIKARA_ARIA2_FIXTURE_ROOT=str(control),
                       BILIKARA_ARIA2_MEDIA=str(Path(__file__).parent / "fixtures" / "bbdown"))
            log = stack.enter_context((root / "host.log").open("wb"))
            packaged = os.environ.get("BILIKARA_TEST_NATIVE_PACKAGE")
            command = [packaged or os.environ["BILIKARA_TEST_NATIVE_HOST"], "--data-dir", str(home)]
            if not packaged:
                command.extend(["--static-dir", str(Path(__file__).parents[1] / "static")])
            process = subprocess.Popen([*command, "--port", "0", "--headless", "--no-browser"],
                cwd=root, env=env, stdout=subprocess.PIPE, stderr=log)
            try:
                self.assertTrue(select.select([process.stdout], [], [], 30)[0], "native Host startup timeout")
                line = process.stdout.readline()
                self.assertTrue(line, "native Host did not start")
                ready = json.loads(line)
                jar = http.cookiejar.CookieJar()
                client = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(jar))
                client.open(ready["bootstrapUrl"], timeout=5).close()
                base = ready["baseUrl"]
                def api(path, body=None):
                    request = urllib.request.Request(base + path, data=None if body is None else json.dumps(body).encode(),
                        headers={"Content-Type": "application/json", "Origin": base})
                    try:
                        with client.open(request, timeout=10) as result: return json.load(result)["data"]
                    except urllib.error.HTTPError as error:
                        if path != "/api/cache-downloader/prepare":
                            self.fail(f"{path}: {error.read().decode()}")
                        raise
                state = api("/api/state")
                if state["session_flags"]["startup_choice_pending"]:
                    api("/api/session/startup-choice", {"choice": "continue"})
                api("/api/session-users/add", {"name": "Alice"})
                tool_status = api("/api/cache-downloader/status", {"download_source": "downkyi"})
                self.assertTrue(tool_status["ready"])
                self.assertFalse(tool_status["auto_prepare_supported"])
                api("/api/cache-policy", {"download_source": "downkyi", "audio_hires": False})
                with self.assertRaises(urllib.error.HTTPError) as rejected:
                    api("/api/cache-downloader/prepare", {"download_source": "downkyi", "program": "/bin/true"})
                self.assertEqual(rejected.exception.code, 400)
                api("/api/playlist/add", {"url": "https://www.bilibili.com/video/BV1xx411c7mD", "requester_name": "Alice", "selected_video_page": 2, "selected_audio_pages": [2, 1]})
                deadline = time.monotonic() + 15
                item = None
                while time.monotonic() < deadline:
                    state = api("/api/state")
                    items = ([state["current_item"]] if state.get("current_item") else []) + state["playlist"]
                    if items:
                        item = items[0]
                        if item["cache_status"] in {"ready", "failed"}: break
                    time.sleep(.02)
                self.assertIsNotNone(item)
                self.assertEqual(item["cache_status"], "ready", item.get("cache_message"))
                self.assertEqual(state["cache_policy"]["download_source"], "downkyi")
                self.assertEqual({v["page"] for v in item["audio_variants"]}, {1, 2})
                self.assertEqual([v["page"] for v in item["audio_variants"]], item["selected_pages"])
                self.assertEqual(len(list(control.glob("*.started"))), 3)
                with client.open(base + item["video_media_url"], timeout=5) as media:
                    self.assertGreater(len(media.read()), 0)
                def current():
                    snapshot = api("/api/state")
                    return snapshot.get("current_item") or snapshot["playlist"][0]
                def until(predicate):
                    end = time.monotonic() + 20
                    while time.monotonic() < end:
                        result = predicate()
                        if result: return result
                        time.sleep(.02)
                    self.fail("native Host did not reach controlled ownership boundary")
                def all_reaped():
                    for receipt in control.glob("*.started"):
                        try: os.kill(int(receipt.stem), 0)
                        except ProcessLookupError: continue
                        return False
                    return True
                # Replace an active DownKyi attempt in the native Host too.
                old_id = item["artifact_set_id"]
                (control / "mode").write_text("hold")
                api("/api/cache/retry", {"item_id": item["id"], "expected_item_incarnation_id": item["item_incarnation_id"], "force": True})
                until(lambda: len(list(control.glob("*.started"))) == 6)
                api("/api/cache-policy", {"download_source": "native"})
                until(lambda: current()["artifact_set_id"] != old_id and current()["cache_status"] == "ready")
                self.assertTrue(all_reaped())
                native_id = current()["artifact_set_id"]
                (control / "mode").write_text("ok")
                api("/api/cache-policy", {"download_source": "downkyi"})
                until(lambda: current()["artifact_set_id"] != native_id and current()["cache_status"] == "ready")
                item = current()
                previous = len(list(control.glob("*.started")))
                (control / "mode").write_text("invalid")
                api("/api/cache/retry", {"item_id": item["id"], "expected_item_incarnation_id": item["item_incarnation_id"], "force": True})
                until(lambda: len(list(control.glob("*.started"))) > previous)
                until(all_reaped)
                self.assertEqual(current()["artifact_set_id"], item["artifact_set_id"])
                self.assertTrue((home / "media" / item["video_relative_path"]).is_file())
                with client.open(base + item["video_media_url"], timeout=5) as media:
                    self.assertGreater(len(media.read()), 0)
            finally:
                process.terminate()
                process.wait(timeout=35)
                process.stdout.close()
            self.assertFalse(list(home.rglob("aria2.cookies")))
            for receipt in control.glob("*.started"):
                with self.assertRaises(ProcessLookupError): os.kill(int(receipt.stem), 0)
