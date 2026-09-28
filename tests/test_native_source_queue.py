"""Manual incremental sources use one native queue on both Remote transports."""
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
import uuid
from urllib.parse import parse_qs, urlsplit

from scripts.check_native_desktop_bundle import RunningHost, isolated_environment
from tests.video_service_fixture import VideoFixture


@unittest.skipUnless(os.environ.get("BILIKARA_TEST_NATIVE_PACKAGE"), "requires built native desktop Host")
class NativeSourceQueueTests(unittest.TestCase):
    def test_busy_additions_deduplicate_and_continue_after_failure(self):
        with tempfile.TemporaryDirectory() as temporary, VideoFixture() as provider:
            home = Path(temporary)
            data = home / "data"
            data.mkdir()
            (data / ".bilikara-desktop-rust-preview").write_text("desktop-rust-preview-v1\n", encoding="utf-8")
            for name, value in {
                "native-library-defaults.json": {"schema_version": 1},
                "gatcha_uids.json": {"schema_version": 2, "uids": [], "profiles": {}},
                "gatcha_cache.json": {"schema_version": 3, "uids": {}, "profiles": {}},
                "gatcha_favlist.json": {"schema_version": 2, "folders": [], "items": []},
            }.items():
                (data / name).write_text(json.dumps(value), encoding="utf-8")
            started, release = threading.Event(), threading.Event()
            fetched = []

            def respond(target):
                url = urlsplit(target)
                uid = parse_qs(url.query).get("mid", ["123"])[0]
                if url.path.endswith("/nav"):
                    return {"code": 0, "data": {"isLogin": True, "wbi_img": {"img_url": "https://i0.hdslb.com/" + "a" * 32 + ".png", "sub_url": "https://i0.hdslb.com/" + "b" * 32 + ".png"}}}
                if url.path.endswith("/acc/info"):
                    return {"code": 0, "data": {"mid": int(uid), "name": "UP " + uid, "face": ""}}
                if url.path.endswith("/arc/search"):
                    fetched.append(uid)
                    if uid == "111":
                        started.set()
                        release.wait(10)
                    if uid == "999":
                        return {"code": -403, "message": "fixture failed"}
                    return {"code": 0, "data": {"list": {"vlist": [{"bvid": "BV1xx411c7mD", "title": "karaoke " + uid, "author": "UP " + uid, "length": "1:30"}]}}}
                if url.path.endswith("/list-all"):
                    return {"code": 0, "data": {"list": []}}
                return {"code": 0, "data": {}}

            provider.return_value = respond
            env = isolated_environment(home)
            for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR"):
                env[key] = os.environ[key]
            env["BILIKARA_CF_API_URL"] = f"http://127.0.0.1:{provider.server.server_port}"
            host = RunningHost(Path(os.environ["BILIKARA_TEST_NATIVE_PACKAGE"]).resolve(), home,
                               "--headless", "--data-dir", str(data),
                               "--static-dir", str(Path(__file__).resolve().parents[1] / "static"), env=env)
            try:
                def wait_idle():
                    deadline = time.monotonic() + 12
                    while time.monotonic() < deadline:
                        state = host.api("/api/state")
                        queue = state["gatcha"]["source_queue"]
                        if not state["gatcha"].get("background_busy") and not queue["pending"] and not queue["active"]:
                            return state
                        time.sleep(.03)
                    self.fail("native queue did not finish")

                host.api("/api/config/cookie", {"sessdata": "fixture", "bili_jct": "fixture"})
                wait_idle()
                self.assertTrue(host.api("/api/gatcha/uids/add", {"uid": "111", "queue": True})["queued"])
                self.assertTrue(started.wait(5))
                # A read-only preview must remain usable during active pulling.
                self.assertIn("uid", host.api("/api/gatcha/uids/preview", {"uid": "123"}))
                host.api("/api/gatcha/uids/add", {"uid": "999", "queue": True})
                peer, epoch = "queued-peer", "abcdefghijklmnopqrstuv"
                host.api("/api/internet-remote/peer/open", {"peer_id": peer, "epoch": epoch, "profile": "controller"})
                def remote(seq, kind, body):
                    reply = host.api("/api/internet-remote/dispatch", {"peer_id": peer, "lane": "control", "message": json.dumps({"v": 1, "lane": "control", "epoch": epoch, "seq": seq, "id": str(uuid.uuid4()), "kind": kind, "body": body})})
                    return reply["data"]
                remote(1, "session.set_identity", {"name": "Queue tester"})
                queued = remote(2, "gatcha.uid_add", {"uid": "123"})
                self.assertTrue(queued["queued"])
                self.assertFalse(queued["duplicate"])
                self.assertTrue(host.api("/api/gatcha/uids/add", {"uid": "123", "queue": True})["duplicate"])
                public = host.api("/api/internet-remote/state")
                self.assertTrue(public["capabilities"]["source_queue"])
                self.assertTrue(public["capabilities"]["source_queue_titles"])
                self.assertEqual([v["uid"] for v in public["gatcha"]["source_queue"]["pending"]], ["999", "123"])
                titles = {"456": "🎤 我的收藏"}
                remote(3, "gatcha.favlist_refresh", {"uid": "123", "folder_ids": ["456"], "folder_titles": titles})
                # Metadata crosses public dispatch, authoritative queue and both
                # snapshots; a Host which never opened the picker sees the name.
                for path in ("/api/state", "/api/internet-remote/state"):
                    pending = host.api(path)["gatcha"]["source_queue"]["pending"]
                    self.assertEqual(pending[-1]["folder_titles"], titles)
                release.set()
                state = wait_idle()
                self.assertEqual(state["gatcha"]["source_queue"]["completed"]["uids"], 3)
                self.assertEqual([v["uid"] for v in state["gatcha"]["source_queue"]["failed"]], ["999"])
                # The repository's three attempts stay within the one failed
                # job; successful queued jobs must each execute only once.
                self.assertEqual(fetched, ["111", "999", "999", "999", "123"])
                self.assertEqual(len(host.api("/api/gatcha/browse?uid=123")["items"]), 1)
            finally:
                release.set()
                host.close()
