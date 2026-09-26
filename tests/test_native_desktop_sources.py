"""Desktop source compatibility through real HTTP; all providers stay local."""
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
import urllib.error
from urllib.parse import parse_qs, urlsplit
import uuid

from scripts.check_native_desktop_bundle import RunningHost, isolated_environment
from tests.video_service_fixture import VideoFixture


@unittest.skipUnless(os.environ.get("BILIKARA_TEST_NATIVE_PACKAGE"), "requires built native desktop Host")
class NativeDesktopSourceTests(unittest.TestCase):
    def test_cookie_source_append_and_public_remote_workflows(self):
        with tempfile.TemporaryDirectory(prefix="native-source-parity-") as temporary, VideoFixture() as provider:
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
            videos = [{"bvid": "BV1xx411c7mD", "title": "karaoke first", "author": "fixture", "pic": "", "length": "1:30"}]

            def respond(target):
                url = urlsplit(target)
                uid = parse_qs(url.query).get("mid", ["123"])[0]
                if url.path.endswith("/nav"):
                    return {"code": 0, "data": {"isLogin": True, "wbi_img": {"img_url": "https://i0.hdslb.com/" + "a" * 32 + ".png", "sub_url": "https://i0.hdslb.com/" + "b" * 32 + ".png"}}}
                if url.path.endswith("/acc/info"):
                    return {"code": 0, "data": {"mid": uid, "name": "fixture", "face": ""}}
                if url.path.endswith("/arc/search"):
                    return {"code": 0, "data": {"list": {"vlist": videos}}}
                if url.path.endswith("/list-all"):
                    return {"code": 0, "data": {"list": [{"id": 456, "title": "karaoke favorites", "media_count": 1}]}}
                if url.path.endswith("/resource/list"):
                    return {"code": 0, "data": {"medias": [{"bvid": "BV1yy411c7mD", "title": "karaoke favorite", "duration": 90, "upper": {"mid": 123, "name": "fixture"}}], "has_more": False}}
                raise AssertionError("unexpected local provider request: " + target)

            provider.return_value = respond
            env = isolated_environment(home)
            for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR"):
                env[key] = os.environ[key]
            env["BILIKARA_CF_API_URL"] = f"http://127.0.0.1:{provider.server.server_port}"
            companion = os.environ.get("BILIKARA_TEST_LIBAV_COMPANION")
            args = []
            if companion:
                env["BILIKARA_LIBAV_COMPANION"] = companion
                args = ["--static-dir", str(Path(__file__).resolve().parents[1] / "static")]
            host = RunningHost(Path(os.environ["BILIKARA_TEST_NATIVE_PACKAGE"]).resolve(), home,
                               "--headless", "--data-dir", str(data), *args, env=env)
            try:
                def wait_refresh():
                    deadline = time.monotonic() + 8
                    while time.monotonic() < deadline:
                        state = host.api("/api/state")
                        if not state["gatcha"].get("background_busy"):
                            return state
                        time.sleep(.02)
                    self.fail("source refresh did not finish")

                def refresh_when_ready(request):
                    # Successful refreshes have a real 60-second cooldown.
                    # Assert the rejection contract, then wait for admission;
                    # never disable the product timer to make the fixture pass.
                    deadline = time.monotonic() + 75
                    while True:
                        try:
                            result = request()
                            self.assertTrue(result["started"])
                            return wait_refresh()
                        except urllib.error.HTTPError as error:
                            self.assertEqual(error.code, 429)
                            self.assertEqual(json.load(error)["code"], "library_cooldown")
                            if time.monotonic() >= deadline:
                                self.fail("refresh was not admitted after cooldown")
                            time.sleep(1)

                def records(expected, required=None):
                    deadline = time.monotonic() + 5
                    while time.monotonic() < deadline:
                        rows = [row for _, body in provider.posts for row in body.get("records", [])]
                        if len(rows) >= expected and (required is None or required in [row["bvid"] for row in rows]):
                            return rows
                        time.sleep(.02)
                    self.fail(f"missing review candidates: {provider.posts}")

                for body in ({}, {"sessdata": "fixture"}, {"bili_jct": "fixture"}, {"sessdata": "a\nb", "bili_jct": "fixture"}):
                    with self.assertRaises(urllib.error.HTTPError) as error:
                        host.api("/api/config/cookie", body)
                    self.assertEqual(error.exception.code, 400)
                with host.request("/api/config/cookie", {"sessdata": "fixture", "bili_jct": "fixture"}) as response:
                    configured = json.load(response)
                self.assertEqual(configured["message"], "配置已实时生效")
                self.assertEqual(configured["data"]["message"], configured["message"])
                wait_refresh()
                self.assertFalse((data / "BBDown.data").exists(), "Old runtime override does not overwrite QR credentials")
                self.assertEqual(provider.posts, [])
                added = host.api("/api/gatcha/uids/add", {"uid": "123"})
                self.assertNotIn("entries", added)
                self.assertEqual(records(1)[0]["bvid"], videos[0]["bvid"])
                videos.insert(0, {**videos[0], "bvid": "BV1zz411c7mD", "title": "karaoke new"})
                refresh_when_ready(lambda: host.api("/api/gatcha/refresh", {}))
                self.assertEqual([row["bvid"] for row in records(2)], ["BV1xx411c7mD", "BV1zz411c7mD"])
                refresh_when_ready(lambda: host.api("/api/gatcha/refresh", {}))
                self.assertEqual(len(records(2)), 2, "Unchanged full refresh must not resubmit the entire library")

                epoch, peer, seq = "abcdefghijklmnopqrstuv", "fixture-peer", 0
                host.api("/api/internet-remote/peer/open", {"peer_id": peer, "epoch": epoch, "profile": "controller"})
                def remote(kind, body):
                    nonlocal seq
                    seq += 1
                    result = host.api("/api/internet-remote/dispatch", {"peer_id": peer, "lane": "control", "message": json.dumps({"v": 1, "lane": "control", "epoch": epoch, "seq": seq, "id": str(uuid.uuid4()), "kind": kind, "body": body})})
                    self.assertNotIn("_host_effect", result)
                    self.assertNotIn("entries", result.get("data", {}))
                    return result["data"]
                remote("session.set_identity", {"name": "source fixture"})
                preference_fields = ("uid_weight", "favlist_weight", "excluded_uids", "excluded_favlist_folders")
                host_pool = host.api("/api/gatcha/pool-config")
                host_preferences = {key: host_pool[key] for key in preference_fields}
                for kind, body in (
                    ("gatcha.pool_config_set", {"uid_weight": 60, "favlist_weight": 40, "excluded_uids": [], "excluded_favlist_folders": []}),
                    ("gatcha.uid_preview", {"uid": "123"}),
                    ("gatcha.uid_add", {"uid": "123"}),
                    ("gatcha.favlist_preview", {"uid": "123"}),
                    ("gatcha.favlist_refresh", {"uid": "123", "folder_ids": ["456"]}),
                    ("gatcha.refresh", {}),
                ):
                    try:
                        if kind == "gatcha.refresh":
                            refresh_when_ready(lambda: remote(kind, body))
                        else:
                            remote(kind, body)
                    except urllib.error.HTTPError as error:
                        self.fail(f"{kind}: {error.code} {error.read().decode()}")
                    wait_refresh()
                self.assertIn("BV1yy411c7mD", [row["bvid"] for row in records(3, "BV1yy411c7mD")])
                self.assertEqual(remote("gatcha.pool_config_get", {})["uid_weight"], 60)
                # Source rows are shared and change after the favorite import;
                # only the user's saved preferences must remain independent.
                host_pool = host.api("/api/gatcha/pool-config")
                self.assertEqual({key: host_pool[key] for key in preference_fields}, host_preferences,
                                 "Remote preferences must not overwrite Host preferences")
                host.api("/api/config/cookie", {})  # Reuse current effective credential.
                self.assertFalse((data / "BBDown.data").exists())
                # A view-only peer must remain unable to write sources.
                host.api("/api/internet-remote/peer/open", {"peer_id": "viewer", "epoch": epoch, "profile": "viewer"})
                peer, seq = "viewer", 0
                with self.assertRaises(urllib.error.HTTPError):
                    remote("gatcha.uid_add", {"uid": "123"})
            finally:
                host.close()
