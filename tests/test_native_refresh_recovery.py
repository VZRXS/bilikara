"""Real native manual refresh after partial failure, with offline Bilibili TLS."""
import json
import os
from pathlib import Path
import select
import subprocess
import tempfile
import time
import unittest
import urllib.parse
import urllib.request

from video_service_fixture import VideoFixture


@unittest.skipUnless(os.environ.get("BILIKARA_TEST_NATIVE_HOST_BINARY"), "requires built native Host")
class NativeRefreshRecoveryTest(unittest.TestCase):
    def test_failed_uid_does_not_starve_healthy_uid_or_favorites(self):
        root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory(prefix="bilikara-refresh-recovery-") as temp, VideoFixture() as provider:
            directory = Path(temp)
            for name, value in {
                "native-library-defaults.json": {"schema_version": 1},
                "gatcha_uids.json": {"schema_version": 2, "uids": ["1", "2"], "profiles": {
                    uid: {"uid": uid, "name": "Fixture " + uid, "space_url": "https://space.bilibili.com/" + uid}
                    for uid in ["1", "2"]}},
                "gatcha_cache.json": {"schema_version": 3, "uids": {}, "profiles": {}},
                "gatcha_favlist.json": {"schema_version": 2, "uid": "42", "folders": [{"uid": "42", "id": "100", "title": "Fixture favorites"}], "items": []},
            }.items():
                (directory / name).write_text(json.dumps(value))
            (directory / ".bilikara-desktop-rust-preview").write_text("desktop-rust-preview-v1\n")
            (directory / "BBDown.data").write_text("SESSDATA=synthetic; bili_jct=synthetic")
            round_number = [1]

            def respond(target):
                url = urllib.parse.urlsplit(target)
                query = urllib.parse.parse_qs(url.query)
                if url.path.endswith("/nav"):
                    return {"code": 0, "data": {"isLogin": True, "wbi_img": {
                        "img_url": "https://example.invalid/" + "a" * 32 + ".png",
                        "sub_url": "https://example.invalid/" + "b" * 32 + ".png"}}}
                if url.path.endswith("/arc/search"):
                    if query.get("mid") == ["2"]:
                        return {"code": -101, "message": "synthetic permanent source failure"}
                    return {"code": 0, "data": {"list": {"vlist": [
                        {"bvid": "BVNEW000000" + str(n), "title": "karaoke new " + str(n), "author": "Fixture"}
                        for n in range(round_number[0], 0, -1)]}}}
                if url.path.endswith("/resource/list"):
                    return {"code": 0, "data": {"medias": [
                        {"bvid": "BVFAV000000" + str(n), "title": "Favorite " + str(n), "upper": {"mid": 42, "name": "Fixture"}}
                        for n in range(round_number[0], 0, -1)], "has_more": False}}
                # Other startup probes are confined to this fixture as well.
                return {"code": 0, "data": {}}

            provider.return_value = respond
            env = dict(os.environ)
            for key in list(env):
                if key.startswith("BILIKARA_"):
                    env.pop(key)
            env.update({"BILIKARA_CF_API_URL": "", "BILIKARA_CATALOG_SHEETS_URL": "",
                        "NO_PROXY": "localhost,127.0.0.1,::1", "no_proxy": "localhost,127.0.0.1,::1"})
            with tempfile.TemporaryFile(mode="w+") as errors:
                process = subprocess.Popen([
                    os.environ["BILIKARA_TEST_NATIVE_HOST_BINARY"], "--headless", "--port", "0",
                    "--data-dir", str(directory), "--static-dir", str(root / "static"),
                ], stdout=subprocess.PIPE, stderr=errors, text=True, env=env)
                try:
                    self.assertTrue(select.select([process.stdout], [], [], 20)[0], "native Host readiness timeout")
                    ready = json.loads(process.stdout.readline())
                    bootstrap = ready["bootstrapUrl"]
                    base = urllib.parse.urlunsplit((*urllib.parse.urlsplit(bootstrap)[:2], "", "", ""))
                    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                    with opener.open(bootstrap, timeout=5) as response:
                        cookie = response.headers["Set-Cookie"].split(";", 1)[0]

                    def call(path, body=None):
                        request = urllib.request.Request(base + path,
                            json.dumps(body).encode() if body is not None else None,
                            {"Cookie": cookie, "Content-Type": "application/json"})
                        with opener.open(request, timeout=5) as response:
                            return json.load(response)["data"]

                    def wait_finished():
                        deadline = time.monotonic() + 20
                        while time.monotonic() < deadline:
                            status = call("/api/state")["gatcha"]
                            if not status["background_busy"]:
                                self.assertEqual(status["last_status"], "partial")
                                return json.loads((directory / "gatcha_cache.json").read_text())
                            time.sleep(.02)
                        self.fail("native refresh did not finish")

                    first = wait_finished()
                    self.assertEqual([item["uid"] for item in first["refresh_summary"]["uids"]], ["1"])
                    provider.requests.clear()
                    round_number[0] = 2
                    self.assertTrue(call("/api/gatcha/refresh", {})["started"])
                    second = wait_finished()
                    summary = second["refresh_summary"]
                    self.assertEqual([item["uid"] for item in summary["errors"]], ["2"])
                    self.assertEqual([item["uid"] for item in summary["uids"]], ["1"])
                    self.assertEqual(summary["total_count"], 2)
                    self.assertEqual(second["uids"]["1"][0]["bvid"], "BVNEW0000002")
                    favorites = json.loads((directory / "gatcha_favlist.json").read_text())
                    self.assertIn("BVFAV0000002", [item["bvid"] for item in favorites["items"]])
                    uid_order = [urllib.parse.parse_qs(urllib.parse.urlsplit(path).query)["mid"][0]
                                 for path, _ in provider.requests if "/arc/search" in path]
                    self.assertEqual(uid_order, ["2", "2", "2", "1"])
                finally:
                    if process.poll() is None:
                        process.terminate()
                    process.wait(timeout=20)
                    process.stdout.close()
                self.assertEqual(process.returncode, 0)
