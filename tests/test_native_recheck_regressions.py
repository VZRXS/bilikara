"""Offline real-Host regressions from the v0.7.2 compatibility recheck."""
import csv
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.parse
import zipfile

from scripts.check_native_desktop_bundle import RunningHost, isolated_environment
from tests.video_service_fixture import VideoFixture

ROOT = Path(__file__).resolve().parents[1]
BINARY = os.environ.get("BILIKARA_TEST_NATIVE_HOST_BINARY")
COMPANION = os.environ.get("BILIKARA_TEST_LIBAV_COMPANION")


def wait_for(predicate, seconds=25):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if result := predicate():
            return result
        time.sleep(.03)
    raise AssertionError("native Host did not reach expected state")


def fixture_environment(home):
    env = isolated_environment(home)
    for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR"):
        if key in os.environ:
            env[key] = os.environ[key]
    env.update(BILIKARA_CF_API_URL="", BILIKARA_CATALOG_SHEETS_URL="")
    return env


def start(home, env, *args):
    return RunningHost(Path(BINARY), home, "--headless", "--port", "0", "--data-dir", str(home / "data"),
                       "--static-dir", str(ROOT / "static"), *args, env=env)


@unittest.skipUnless(BINARY, "requires built native Host")
class NativeRecheckRegressionTest(unittest.TestCase):
    @unittest.skipUnless(COMPANION, "requires packaged libav validator")
    def test_dolby_only_bbdown_preserves_independent_ordered_audio_selection(self):
        with tempfile.TemporaryDirectory(prefix="native-recheck-cache-") as temp, VideoFixture() as provider:
            home = Path(temp)
            control = home / "child"
            control.mkdir()
            (control / "mode").write_text("dolby")
            binary = home / "BBDown"
            subprocess.run(["rustc", str(ROOT / "tests/bbdown_fixture.rs"), "-o", str(binary)], check=True, capture_output=True)

            def respond(path):
                if path.startswith("/x/web-interface/wbi/view"):
                    return {"code": 0, "data": {"aid": 123, "bvid": "BV1xx411c7mD", "title": "Fixture", "owner": {"mid": 42, "name": "Fixture"},
                        "pages": [{"page": 1, "cid": 457, "duration": 999, "part": "original"},
                                  {"page": 2, "cid": 458, "duration": 500, "part": ""}]}}
                if path.endswith("/nav"):
                    return {"code": 0, "data": {"wbi_img": {"img_url": "https://example.invalid/" + "a" * 32 + ".png", "sub_url": "https://example.invalid/" + "b" * 32 + ".png"}}}
                if path.startswith("/x/player/wbi/playurl"):
                    return {"code": 0, "data": {"dash": {"video": [{"id": 64, "codecid": 7, "baseUrl": "https://api.bilibili.com/video.mp4", "bandwidth": 10}],
                        "audio": [], "flac": None, "dolby": {"audio": [{"id": 30250, "baseUrl": "https://api.bilibili.com/audio-eac3.m4a"}]}}}}
                return {"code": 0, "data": {}}

            provider.return_value = respond
            env = fixture_environment(home)
            env.update(BB_DOWN_PATH=str(binary), BILIKARA_BBDOWN_FIXTURE_ROOT=str(control),
                       BILIKARA_BBDOWN_MEDIA=str(ROOT / "tests/fixtures/bbdown"),
                       BILIKARA_BBDOWN_EXPECT_COOKIE=";", BILIKARA_LIBAV_COMPANION=COMPANION)
            host = start(home, env)
            try:
                host.api("/api/session-users/add", {"name": "Fixture"})
                host.api("/api/cache-policy", {"download_source": "bbdown", "audio_hires": True})
                for selected in ([2], [2, 1]):
                    with self.subTest(audio_pages=selected):
                        state = host.api("/api/playlist/add", {"url": "https://www.bilibili.com/video/BV1xx411c7mD", "requester_name": "Fixture",
                            "selected_video_page": 1, "selected_audio_pages": selected, "allow_repeat": True})
                        expected = (state["playlist"] or [state["current_item"]])[-1]["id"]
                        def ready():
                            snapshot = host.api("/api/state")
                            item = next(item for item in [snapshot.get("current_item"), *snapshot["playlist"]] if item and item["id"] == expected)
                            return item if item["cache_status"] in ("ready", "failed") else None
                        item = wait_for(ready)
                        self.assertEqual(item["cache_status"], "ready", item["cache_message"])
                        self.assertEqual(item["video_page"], 1)
                        self.assertEqual([v["page"] for v in item["audio_variants"]], selected)
                        chosen = next(v for v in item["audio_variants"] if v["id"] == item["selected_audio_variant_id"])
                        self.assertEqual(chosen["page"], 2)
                        self.assertEqual(chosen["label"], "P2")
                        self.assertIn(str(len(selected)), item["cache_message"])
            finally:
                host.close()

    def test_large_legacy_history_and_1001_archives_import_and_reopen_without_loss(self):
        with tempfile.TemporaryDirectory(prefix="native-recheck-import-") as temp:
            home = Path(temp)
            source = home / "legacy"
            data = source / "data"
            archives = data / "played_sessions"
            archives.mkdir(parents=True)
            for i in range(1001):
                (archives / f"played-{i}.json").write_text(json.dumps({"session_started_at": i + 1, "items": []}))
            entry = {"display_title": "x" * 4096, "title": "Song", "part_title": "P1", "original_url": "", "resolved_url": "", "requested_at": 1}
            history = data / "history.json"
            history.write_text(json.dumps({"history": [{**entry, "key": f"song-{i}"} for i in range(9000)]}))
            self.assertGreater(history.stat().st_size, 32 * 1024 * 1024)
            digest = hashlib.sha256(history.read_bytes()).digest()
            env = isolated_environment(home)
            for iteration in range(2):
                host = start(home, env, "--import-from", str(source))
                try:
                    self.assertEqual(len(host.api("/api/played-sessions")), 1001)
                    with host.request("/api/playlist/export?format=csv&source=history") as response:
                        rows = list(csv.reader(io.StringIO(response.read().decode("utf-8-sig"))))
                    self.assertEqual(len(rows), 9001, iteration)
                    self.assertIn("x" * 4096, rows[-1])
                finally:
                    host.close()
            self.assertEqual(hashlib.sha256(history.read_bytes()).digest(), digest)
            self.assertEqual(len(list(archives.glob("*.json"))), 1001)
            self.assertEqual(json.loads((home / "data/host-state.json").read_text())["schema_version"], 3)

    @unittest.skipUnless(os.name == "posix", "Unix account lookup evidence")
    def test_diagnostic_zip_redacts_system_and_home_names_without_login_environment(self):
        import pwd
        account = pwd.getpwuid(os.getuid())
        with tempfile.TemporaryDirectory(prefix="native-recheck-diagnostics-") as temp:
            home = Path(temp)
            env = isolated_environment(home)
            for key in ("USER", "USERNAME", "LOGNAME"):
                env.pop(key, None)
            host = start(home, env)
            try:
                log = home / "data/logs/host.log"
                log.parent.mkdir(exist_ok=True)
                sentinels = [f"/home/{account.pw_name}/Documents/private.json",
                             f"{account.pw_dir}/Documents/private.json", f"{home}/private.json"]
                log.write_text("\n".join(sentinels))
                with host.request("/api/diagnostics/package", {}) as response:
                    with zipfile.ZipFile(io.BytesIO(response.read())) as archive:
                        redacted = archive.read("logs/host.log").decode()
                for sentinel in sentinels:
                    self.assertNotIn(sentinel, redacted)
                self.assertIn("private.json", redacted)
            finally:
                host.close()

    @unittest.skipUnless(shutil.which("openssl"), "requires openssl for isolated passport TLS certificate")
    def test_account_switch_cancels_old_commit_and_runs_latest_login_after_busy(self):
        self._account_switch(cooldown=False)

    @unittest.skipUnless(shutil.which("openssl"), "requires openssl for isolated passport TLS certificate")
    def test_cookie_switch_retains_latest_refresh_until_manual_cooldown_expires(self):
        self._account_switch(cooldown=True)

    def _account_switch(self, *, cooldown):
        with tempfile.TemporaryDirectory(prefix="native-recheck-login-") as temp:
            home = Path(temp)
            certs = home / "certs"
            certs.mkdir()
            def openssl(*args):
                subprocess.run(["openssl", *args], check=True, capture_output=True)
            openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
                    "-subj", "/CN=Bilikara isolated test CA", "-keyout", str(certs / "ca-key.pem"), "-out", str(certs / "ca.pem"))
            openssl("req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=api.bilibili.com",
                    "-keyout", str(certs / "key.pem"), "-out", str(certs / "leaf.csr"))
            (certs / "extensions").write_text("basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:api.bilibili.com,DNS:passport.bilibili.com\n")
            openssl("x509", "-req", "-days", "2", "-in", str(certs / "leaf.csr"), "-CA", str(certs / "ca.pem"),
                    "-CAkey", str(certs / "ca-key.pem"), "-CAcreateserial", "-extfile", str(certs / "extensions"), "-out", str(certs / "cert.pem"))
            with VideoFixture(certs=certs) as provider:
                data = home / "data"
                data.mkdir()
                for name, value in {
                    "native-library-defaults.json": {"schema_version": 1},
                    "gatcha_uids.json": {"schema_version": 2, "uids": ["1"], "profiles": {"1": {"uid": "1", "name": "Fixture", "space_url": "https://space.bilibili.com/1"}}},
                    "gatcha_cache.json": {"schema_version": 3, "uids": {}, "profiles": {}},
                    "gatcha_favlist.json": {"schema_version": 2, "folders": [], "items": []},
                }.items():
                    (data / name).write_text(json.dumps(value))
                (data / ".bilikara-desktop-rust-preview").write_text("desktop-rust-preview-v1\n")
                (data / "BBDown.data").write_text("DedeUserID=1; SESSDATA=account_a; bili_jct=account_a")
                entered = threading.Event()
                release_a = threading.Event()
                release_b = threading.Event()
                entered_b = threading.Event()
                entered_c = threading.Event()
                release_c = threading.Event()
                cookies = []
                def respond(target):
                    path = urllib.parse.urlsplit(target).path
                    if path.endswith("/nav"):
                        return {"code": 0, "data": {"isLogin": True, "wbi_img": {"img_url": "https://example.invalid/" + "a" * 32 + ".png", "sub_url": "https://example.invalid/" + "b" * 32 + ".png"}}}
                    if path.endswith("/acc/info"):
                        uid = urllib.parse.parse_qs(urllib.parse.urlsplit(target).query).get("mid", ["1"])[0]
                        return {"code": 0, "data": {"mid": uid, "name": "Fixture", "face": ""}}
                    if path.endswith("/arc/search"):
                        headers = next(headers for path, headers in reversed(provider.requests) if "/arc/search" in path)
                        cookie = headers.get("Cookie", headers.get("cookie", ""))
                        cookies.append(cookie)
                        account = next(account for account in "abc" if "account_" + account in cookie)
                        {"a": entered, "b": entered_b, "c": entered_c}[account].set()
                        assert {"a": release_a, "b": release_b, "c": release_c}[account].wait(20), "fixture release timeout"
                        return {"code": 0, "data": {"list": {"vlist": [{"bvid": "BV1xx411c7m" + {"a": "D", "b": "E", "c": "F"}[account], "title": "karaoke account " + account.upper(), "author": "Fixture"}]}}}
                    if path.endswith("/generate"):
                        return {"code": 0, "data": {"url": "https://passport.bilibili.com/scan?token=fixture", "qrcode_key": "fixture"}}
                    if path.endswith("/poll"):
                        return {"code": 0, "data": {"code": 0}}
                    return {"code": 0, "data": {}}
                provider.return_value = respond
                original = provider.server.RequestHandlerClass.send_response
                def send_response(handler, *args, **kwargs):
                    original(handler, *args, **kwargs)
                    if "/qrcode/poll" in handler.path:
                        for value in ("DedeUserID=2", "SESSDATA=account_b", "bili_jct=account_b"):
                            handler.send_header("Set-Cookie", value + "; Domain=.bilibili.com; Path=/; Secure")
                provider.server.RequestHandlerClass.send_response = send_response
                host = start(home, fixture_environment(home))
                try:
                    self.assertTrue(entered.wait(10))
                    if cooldown:
                        release_a.set()
                        wait_for(lambda: not host.api("/api/state")["gatcha"]["background_busy"])
                        self.assertTrue(host.api("/api/gatcha/refresh", {})["started"])
                        wait_for(lambda: len(cookies) == 2 and not host.api("/api/state")["gatcha"]["background_busy"])
                    host.api("/api/bbdown/logout", {})
                    host.api("/api/bbdown/login/start", {"force": True})
                    wait_for(lambda: (data / "BBDown.data").exists() and "account_b" in (data / "BBDown.data").read_text())
                    release_a.set()
                    self.assertTrue(entered_b.wait(10), ("new account refresh was dropped", host.api("/api/state")["gatcha"]))
                    if cooldown:
                        self.assertEqual(host.api("/api/config/cookie", {"sessdata": "account_c", "bili_jct": "account_c"})["message"], "配置已实时生效")
                        release_b.set()
                        wait_for(lambda: not host.api("/api/state")["gatcha"]["background_busy"])
                        self.assertFalse(entered_c.wait(.3), "Cookie configuration must not bypass manual cooldown")
                        with self.assertRaises(urllib.error.HTTPError) as blocked:
                            host.api("/api/gatcha/refresh", {})
                        self.assertEqual(json.load(blocked.exception)["code"], "library_cooldown")
                        blocked.exception.close()
                        # Exercise the real 60-second deadline, without a product
                        # test override that could hide the coordinator's bug.
                        self.assertTrue(entered_c.wait(75), "C intent lost during cooldown")
                        cached = json.loads((data / "gatcha_cache.json").read_text())
                        self.assertEqual(cached["uids"]["1"][0]["title"], "karaoke account A")
                        release_c.set()
                        wait_for(lambda: host.api("/api/state")["gatcha"]["last_status"] == "success")
                        cached = json.loads((data / "gatcha_cache.json").read_text())
                        self.assertEqual({item["title"] for item in cached["uids"]["1"]}, {"karaoke account A", "karaoke account C"})
                        self.assertEqual(len(cookies), 4)
                        for cookie, account in zip(cookies, "aabc"):
                            self.assertIn("account_" + account, cookie)
                        with self.assertRaises(urllib.error.HTTPError) as blocked:
                            host.api("/api/gatcha/refresh", {})
                        self.assertEqual(json.load(blocked.exception)["code"], "library_cooldown")
                        blocked.exception.close()
                        return
                    # B is still blocked: A must not have published after logout.
                    cached = json.loads((data / "gatcha_cache.json").read_text())
                    self.assertEqual(cached["uids"].get("1", []), [])
                    release_b.set()
                    wait_for(lambda: host.api("/api/state")["gatcha"]["last_status"] == "success")
                    cached = json.loads((data / "gatcha_cache.json").read_text())
                    self.assertEqual(cached["uids"]["1"][0]["title"], "karaoke account B")
                    self.assertEqual(len(cookies), 2)
                    self.assertIn("account_a", cookies[0])
                    self.assertIn("account_b", cookies[1])
                finally:
                    release_a.set()
                    release_b.set()
                    release_c.set()
                    host.close()
