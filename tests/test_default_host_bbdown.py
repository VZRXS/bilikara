"""Default Python Host -> ordinary Runtime ABI -> shared BBDown child and AppState.

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
class DefaultHostBBDownTest(unittest.TestCase):
    make_item = fixtures.CacheManagerPolicyTest.make_item

    @classmethod
    def setUpClass(cls):
        cls.build = TemporaryDirectory()
        cls.addClassCleanup(cls.build.cleanup)
        cls.binary = Path(cls.build.name) / "BBDown"
        subprocess.run(["rustc", str(Path(__file__).with_name("bbdown_fixture.rs")),
                        "-o", str(cls.binary)], check=True, capture_output=True)

    def setUp(self):
        fixtures.CacheManagerPolicyTest.setUp(self)
        self.stack = ExitStack()
        self.root = Path(self.temp_dir.name)
        self.tool = self.root / "tools" / "bbdown"
        self.tool.mkdir(parents=True)
        shutil.copy2(self.binary, self.tool / "BBDown")
        (self.tool / "VERSION").write_text("1.6.3")
        (self.tool / "BBDown.config").write_text("--ffmpeg-path forbidden-muxer")
        (self.tool / "BBDown.data").write_text("adjacent-cookie-must-not-be-used")
        self.control = self.root / "child"
        self.control.mkdir()
        self.mode("ok")
        self.stack.enter_context(patch.dict(os.environ, {
            "BILIKARA_BBDOWN_FIXTURE_ROOT": str(self.control),
            "BILIKARA_BBDOWN_MEDIA": str(Path(__file__).parent / "fixtures" / "bbdown"),
            "BILIKARA_BBDOWN_EXPECT_COOKIE": "SESSDATA=synthetic; bili_jct=csrf",
        }))
        for name, value in {
            "CACHE_DIR": self.cache_dir, "LOG_DIR": self.root / "logs",
            "BB_DOWN_DIR": self.tool, "BB_DOWN_PATH_OVERRIDE": "",
            "BB_DOWN_VERSION_FILE": self.tool / "VERSION", "PACKAGED_RUNTIME": False,
        }.items():
            self.stack.enter_context(patch("bilikara.cache." + name, value))
        self.stack.enter_context(patch("bilikara.cache.effective_bilibili_cookie",
                                       return_value="SESSDATA=synthetic; bili_jct=csrf"))
        self.net = self.stack.enter_context(VideoFixture())
        self.net.return_value = self.response
        self.video_codec = 7
        self.dolby_only = False
        self.forbidden = self.stack.enter_context(patch.object(
            CacheManager, "_download_selected_streams", side_effect=AssertionError("Python BBDown executor")))
        self.manager = CacheManager(self.store, max_cache_items=3)
        self.manager.download_source = "bbdown"
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

    def response(self, path):
        if path.startswith("/x/web-interface/nav"):
            return {"code": 0, "data": {"wbi_img": {"img_url": "https://example.invalid/" + "a" * 32 + ".png",
                                                     "sub_url": "https://example.invalid/" + "b" * 32 + ".png"}}}
        if path.startswith("/x/player/wbi/playurl"):
            return {"code": 0, "data": {"dash": {
                "video": [{"id": 64, "codecid": self.video_codec, "baseUrl": "https://api.bilibili.com/video.mp4", "bandwidth": 10}],
                "audio": [] if self.dolby_only else [{"id": 30280, "baseUrl": "https://api.bilibili.com/audio.m4a", "bandwidth": 10}],
                "flac": None if self.dolby_only else {"audio": {"id": 30251, "baseUrl": "https://api.bilibili.com/audio-flac.mp4"}},
                "dolby": {"audio": [{"id": 30250, "baseUrl": "https://api.bilibili.com/audio-eac3.m4a"}]} if self.dolby_only else None,
            }}}
        name = path.lstrip("/")
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
        deadline = time.monotonic() + 12
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

    def test_success_policy_pages_credentials_observation_and_no_cli(self):
        item = self.add()
        self.manager.set_cache_policy(video_quality="720P 高清")
        with patch.object(self.manager, "_fetch_latest_release", side_effect=AssertionError("unnecessary provisioning")):
            self.manager.sync_with_playlist()
            self.status(item, "ready")
        result = self.store.get_item(item.id)
        self.assertEqual([v["page"] for v in result.audio_variants], [2, 1])
        self.assertEqual([v["id"] for v in result.audio_variants], ["p2_off_vocal", "p1_main_track"])
        self.assertEqual(result.selected_audio_variant_id, "p2_off_vocal")
        self.assertTrue((self.cache_dir / result.video_relative_path).is_file())
        self.assertIn("artifacts/", result.video_media_url)
        self.assertTrue(self.observations)
        self.assertIn(result.artifact_set_id, json.dumps(self.persisted))
        self.assertTrue(self.store.player_state_file.is_file())
        self.assertTrue(self.store.backup_file.is_file())
        self.assertEqual(len(self.receipts()), 3)
        policies = [p.read_text() for p in self.receipts("policy")]
        self.assertIn("quality=720P 高清,480P 清晰,360P 流畅\ncodec=\nascending=false\n", policies)
        self.assertEqual(sum("ascending=true" in p for p in policies), 2)
        cids = {parse_qs(urlsplit(p).query)["cid"][0] for p, _ in self.net.requests if "playurl" in p}
        self.assertEqual(cids, {"457", "458"})
        self.assertEqual(self.manager.python_worker_download_sources, {})
        self.assertTrue(self.manager.tasks.empty())
        logs = "".join(p.read_text() for p in (self.root / "logs").rglob("*.log"))
        if os.environ.get("BILIKARA_LIBAV_COMPANION"):
            self.assertIn('"backend":"libav"', logs)
        for secret in ("synthetic-secret-output", "SESSDATA=", "adjacent-cookie"):
            self.assertNotIn(secret, logs + json.dumps(self.observations))

    def test_capability_replacement_hires_and_failed_refresh_keeps_reader(self):
        item = self.add()
        self.manager.sync_with_playlist()
        self.status(item, "ready")
        old = self.store.get_item(item.id)
        lease = self.manager.acquire_media_reader(old.video_relative_path)
        self.assertIsNotNone(lease)
        self.addCleanup(lambda: self.manager.release_media_reader(lease))
        self.manager.audio_hires = True
        capabilities = self.manager.set_client_media_capabilities({"hevc_supported": False, "max_avc_quality_index": 2})
        self.assertTrue(capabilities["force_avc"])
        self.assertEqual(capabilities["max_avc_quality"], "720P 高清")
        self.wait_for(lambda: self.store.get_item(item.id).artifact_set_id != old.artifact_set_id)
        new = self.store.get_item(item.id)
        self.assertTrue(all(v["audio_url"].endswith(".flac") for v in new.audio_variants))
        self.assertIn("quality=720P 高清,480P 清晰,360P 流畅\ncodec=avc\nascending=false\n",
                      [p.read_text() for p in self.receipts("policy")])
        self.assertTrue((self.cache_dir / old.video_relative_path).exists())
        self.mode("invalid")
        self.manager.retry_item(item.id, expected_item_incarnation_id=item.item_incarnation_id, force=True)
        self.wait_for(lambda: bool(rust_runtime.cache_runtime_request("snapshot")["terminal_events"]))
        self.manager._drain_native_cache_events()
        self.assertEqual(self.store.get_item(item.id).artifact_set_id, new.artifact_set_id)
        self.assertTrue((self.cache_dir / new.video_relative_path).exists())
        self.manager.release_media_reader(lease)
        self.assertFalse((self.cache_dir / old.video_relative_path).exists())

    @unittest.skipUnless(os.environ.get("BILIKARA_LIBAV_COMPANION"), "HEVC needs the packaged libav validator")
    def test_hevc_preserves_validated_video_and_rejects_malformed_refresh(self):
        item = self.add()
        self.mode("hevc")
        self.video_codec = 12
        with patch("bilikara.cache.BB_DOWN_PATH_OVERRIDE", str(self.tool / "BBDown")):
            self.manager.sync_with_playlist()
        self.status(item, "ready")
        ready = self.store.get_item(item.id)
        video = self.cache_dir / ready.video_relative_path
        self.assertEqual(video.read_bytes(),
                         (Path(__file__).parent / "fixtures/bbdown/video-hevc.mp4").read_bytes())
        self.assertTrue(any("codec=\n" in p.read_text() for p in self.receipts("policy")))
        self.mode("hevc-missing-mdat")
        self.manager.retry_item(item.id, expected_item_incarnation_id=item.item_incarnation_id, force=True)
        self.wait_for(lambda: bool(rust_runtime.cache_runtime_request("snapshot")["terminal_events"]))
        self.manager._drain_native_cache_events()
        self.assertEqual(self.store.get_item(item.id).artifact_set_id, ready.artifact_set_id)
        self.assertTrue(video.is_file())

    def test_inflight_source_switch_explicit_retry_and_stale_completion(self):
        item = self.add()
        self.mode("late_hold")
        self.manager.sync_with_playlist()
        self.wait_for(lambda: len(self.receipts("completed")) == 3)
        self.manager._enqueue_front(item.id)  # A stale legacy priority plan cannot create a Python owner.
        self.assertTrue(self.manager.tasks.empty())
        self.assertEqual(self.manager.python_worker_download_sources, {})
        with self.assertRaises(rust_runtime.RustRuntimeServiceError) as error:
            rust_runtime.configure_bbdown(owner=self.manager._artifact_owner, prepared_path=Path("/bin/true"))
        self.assertEqual(error.exception.kind, "busy")
        original = rust_runtime.cache_runtime_request("snapshot")
        self.manager.set_cache_policy(download_source="native")
        self.manager.sync_with_playlist()
        self.assertEqual(len(self.receipts()), 3)
        self.assertEqual(rust_runtime.cache_runtime_request("snapshot")["active_item_ids"], original["active_item_ids"])
        self.manager.retry_item(item.id, expected_item_incarnation_id=item.item_incarnation_id, force=True)
        self.status(item, "ready")
        native = self.store.get_item(item.id)
        for path in self.receipts():
            with self.assertRaises(ProcessLookupError):
                os.kill(int(path.stem), 0)
        self.mode("ok")
        self.manager.set_cache_policy(download_source="bbdown")
        self.manager.retry_item(item.id, expected_item_incarnation_id=item.item_incarnation_id, force=True)
        self.wait_for(lambda: self.store.get_item(item.id).artifact_set_id != native.artifact_set_id)
        self.assertEqual(len(self.receipts()), 6)
        (self.control / "release").touch()
        final = self.store.get_item(item.id).artifact_set_id
        self.manager.sync_with_playlist()
        self.assertEqual(self.store.get_item(item.id).artifact_set_id, final)

    @unittest.skipUnless(os.environ.get("BILIKARA_LIBAV_COMPANION"), "Dolby needs the packaged libav validator")
    def test_dolby_audio_uses_existing_validation_without_a_muxer(self):
        item = self.add()
        self.dolby_only = True
        self.mode("dolby")
        self.manager.audio_hires = True
        # AVC fallback affects video only; the admitted Dolby audio stays intact.
        self.manager.hevc_supported = False
        self.manager.sync_with_playlist()
        self.status(item, "ready")
        ready = self.store.get_item(item.id)
        source = (Path(__file__).parent / "fixtures/bbdown/audio-eac3.m4a").read_bytes()
        for variant in ready.audio_variants:
            path = self.cache_dir / variant["audio_url"].removeprefix("/media/")
            self.assertEqual(path.read_bytes(), source)
        self.assertTrue(all("ascending=false" in p.read_text() for p in self.receipts("policy")))

    def test_failure_no_automatic_retry_and_invalid_override_fail_closed(self):
        self.mode("exit")
        item = self.add()
        self.manager.sync_with_playlist()
        self.status(item, "failed")
        count = len(self.receipts())
        for _ in range(3):
            self.manager.sync_with_playlist()
        self.assertEqual(len(self.receipts()), count)

        self.assertNotIn("synthetic-secret-output", self.store.get_item(item.id).cache_message)
        self.manager.bbdown_configuration = None
        with patch("bilikara.cache.BB_DOWN_PATH_OVERRIDE", str(self.root / "missing")):
            self.manager.retry_item(item.id, expected_item_incarnation_id=item.item_incarnation_id)
            self.status(item, "failed")
        self.assertIn("BBDown unavailable", self.store.get_item(item.id).cache_message)
        self.assertEqual(len(self.receipts()), count)

    def test_missing_login_fails_before_preparation_and_metadata_http_failure_is_safe(self):
        item = self.add()
        with patch("bilikara.cache.effective_bilibili_cookie", return_value=""), patch.object(
            self.manager, "_ensure_bbdown", side_effect=AssertionError("preparation before login")):
            self.manager.sync_with_playlist()
            self.status(item, "failed")
            self.assertIn("下载需要登录", self.store.get_item(item.id).cache_message)
            with self.assertRaisesRegex(ValueError, "下载需要登录"):
                self.manager.retry_item(item.id, expected_item_incarnation_id=item.item_incarnation_id)
        self.assertEqual(self.receipts(), [])
        self.net.status = 412
        self.manager.retry_item(item.id, expected_item_incarnation_id=item.item_incarnation_id)
        self.wait_for(lambda: "412" in self.store.get_item(item.id).cache_message)
        self.assertEqual(self.receipts(), [])

    def test_urgent_bbdown_and_legacy_handoff_drain_before_new_owner(self):
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
        # Park the retained Python worker; real Rust handoff still drains and
        # settles the old child before the external attempt can reserve.
        with patch.object(self.manager, "_cache_item", return_value=False):
            self.manager.set_cache_policy(download_source="ytdlp")
            self.manager.retry_item(current.id, expected_item_incarnation_id=current.item_incarnation_id, force=True)
            self.wait_for(lambda: current.id not in self.manager.python_worker_download_sources)
        self.assertNotIn(current.id, rust_runtime.cache_runtime_request("snapshot")["active_item_ids"])
        self.mode("ok")
        self.manager.set_cache_policy(download_source="bbdown")
        self.manager.retry_item(current.id, expected_item_incarnation_id=current.item_incarnation_id, force=True)
        self.wait_for(lambda: len(self.receipts()) == 8)
        self.wait_for(lambda: current.id not in rust_runtime.cache_runtime_request("snapshot")["active_item_ids"])
        self.manager.shutdown()
        for path in self.receipts():
            with self.assertRaises(ProcessLookupError):
                os.kill(int(path.stem), 0)

    def test_stop_reaps_replacement_and_stale_incarnation_cannot_retry(self):
        first = self.add("first", pages=(1,))
        self.mode("hold")
        self.manager.sync_with_playlist()
        self.wait_for(lambda: len(self.receipts()) == 2)
        self.store.remove_item(first.id)
        replacement = self.add(first.id, pages=(1,))
        with self.assertRaises(PlaylistStoreCommandError):
            self.manager.retry_item(first.id, expected_item_incarnation_id=first.item_incarnation_id, force=True)
        self.manager.sync_with_playlist()
        self.wait_for(lambda: len(self.receipts()) == 4)
        self.assertNotEqual(first.item_incarnation_id, replacement.item_incarnation_id)
        self.manager.shutdown()
        for path in self.receipts():
            with self.assertRaises(ProcessLookupError):
                os.kill(int(path.stem), 0)
        self.assertNotEqual(self.store.get_item(first.id).cache_status, "ready")
        (self.control / "release").touch()
        self.assertFalse(list((self.cache_dir / "artifacts").glob("*/*/video*")))

    def test_generic_jobs_cannot_supply_executables_or_arguments(self):
        item = self.add(pages=(1,))
        job = {"schema_version": 1, "item_id": item.id,
               "item_incarnation_id": item.item_incarnation_id, "bvid": item.bvid,
               "video_page": 1, "pages": [{"page": 1, "cid": 457}],
               "cache_root": str(self.cache_dir), "log_file": str(self.root / "log")}
        for field in ("executor", "program", "arguments", "prepared_path"):
            with self.subTest(field=field), self.assertRaises(rust_runtime.RustRuntimeServiceError) as error:
                rust_runtime.cache_runtime_request("submit", job={**job, field: "/bin/true"})
            # The existing ABI rejects deserialization by returning null.
            self.assertEqual(error.exception.kind, "no_response")
        self.assertEqual(self.receipts(), [])
        self.manager.download_source = "native"
        self.manager._ensure_native_cache_runtime()
        rust_runtime.cache_runtime_request("submit", job=job)
        self.status(item, "ready")
        self.assertEqual(self.receipts(), [])  # Generic jobs still select Native.

    def test_bbdown_retry_captures_source_before_runtime_initialization(self):
        item = self.add()
        start = self.manager._ensure_native_cache_runtime
        def switch_after_admission():
            start()
            self.manager.set_cache_policy(download_source="ytdlp")
        with patch.object(self.manager, "_ensure_native_cache_runtime", side_effect=switch_after_admission):
            self.manager.retry_item(item.id, expected_item_incarnation_id=item.item_incarnation_id, force=True)
        self.status(item, "ready")
        self.assertEqual(self.manager.download_source, "ytdlp")
        self.assertEqual(self.manager.python_worker_download_sources, {})
        self.assertEqual(len(self.receipts()), 3)

    def test_explicit_bbdown_retry_waits_for_retained_worker_then_takes_ownership(self):
        item = self.add(pages=(1,))
        entered, release, drained = threading.Event(), threading.Event(), threading.Event()
        self.addCleanup(release.set)
        def retained(item_id, token):
            self.assertEqual(self.manager.python_worker_download_sources[item_id], "ytdlp")
            entered.set()
            if not release.wait(10):
                raise AssertionError("retained worker barrier timed out")
            self.assertFalse(self.manager._should_cache(item_id))
            drained.set()
            return False
        with patch.object(self.manager, "_cache_item", side_effect=retained):
            self.manager.set_cache_policy(download_source="ytdlp")
            with patch.object(self.manager, "enqueue"):
                self.manager.sync_with_playlist()  # Establish the retained cache window before retry.
            window = self.manager._is_in_cache_window
            def switch_after_admission(item_id):
                allowed = window(item_id)
                self.manager.set_cache_policy(download_source="bbdown")
                return allowed
            with patch.object(self.manager, "_is_in_cache_window", side_effect=switch_after_admission):
                self.manager.retry_item(item.id, expected_item_incarnation_id=item.item_incarnation_id)
            self.assertTrue(entered.wait(5))
            old = self.manager.python_cache_attempt_tokens[item.id]
            self.manager.set_cache_policy(download_source="bbdown")
            self.manager.retry_item(item.id, expected_item_incarnation_id=item.item_incarnation_id, force=True)
            self.manager.sync_with_playlist()
            self.assertEqual(self.manager.python_cache_attempt_tokens[item.id], old)
            self.assertEqual(self.receipts(), [])
            self.assertNotIn(item.id, self.manager.retry_requested_ids)
            release.set()
            self.assertTrue(drained.wait(5))
            self.status(item, "ready")
        self.assertEqual(len(self.receipts()), 2)
        self.assertEqual(self.manager.python_worker_download_sources, {})

    def test_incompatible_override_does_not_fall_back_to_valid_managed_binary(self):
        incompatible = self.root / "incompatible"
        shutil.copy2("/bin/true", incompatible)
        item = self.add()
        with patch("bilikara.cache.BB_DOWN_PATH_OVERRIDE", str(incompatible)):
            self.manager.sync_with_playlist()
            self.status(item, "failed")
        self.assertIn("BBDown unavailable", self.store.get_item(item.id).cache_message)
        self.assertEqual(self.receipts(), [])
