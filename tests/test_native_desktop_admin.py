"""Exercise retained administration routes in an actual Rust desktop process.

The Worker is a local fixture. Outbound network access is disabled in the child.
"""
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from scripts.check_native_desktop_bundle import RunningHost, isolated_environment


@unittest.skipUnless(os.environ.get("BILIKARA_TEST_NATIVE_PACKAGE"), "requires built native desktop package")
class NativeDesktopAdminTests(unittest.TestCase):
    def test_admin_routes_secret_boundaries_and_supervised_monthly_job(self):
        calls = []
        export_entered, export_release = threading.Event(), threading.Event()
        hold_export = threading.Event()

        class Worker(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                calls.append((self.path, None, self.headers.get("Authorization")))
                self.assert_export_auth()
                if hold_export.is_set():
                    export_entered.set()
                    export_release.wait(10)
                self.reply([])

            def assert_export_auth(self):
                if not self.path.startswith("/export?") or self.headers.get("Authorization") != "Bearer fixture-admin":
                    raise AssertionError("unexpected export request")

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
                calls.append((self.path, body, self.headers.get("Authorization")))
                if self.path == "/admin/verify":
                    self.reply({"verified": body.get("BILIKARA_ADMIN_SECRET") == "fixture-admin"})
                elif self.path == "/admin/blacklist/list" and body.get("query") == "reject-fixture":
                    self.reply({"error": "forbidden"}, 403)
                else:
                    self.reply({"success": True, "items": [], "deleted": True, "instance_id": "fixture-tagger"})

            def reply(self, payload, status=200):
                data = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        worker = ThreadingHTTPServer(("127.0.0.1", 0), Worker)
        thread = threading.Thread(target=worker.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory(prefix="bilikara admin 空 ") as temporary:
                home = Path(temporary)
                data = home / "data"
                data.mkdir()
                (data / ".bilikara-desktop-rust-preview").write_text("desktop-rust-preview-v1\n")
                (data / "gatcha_uids.json").write_text(json.dumps({"schema_version": 2, "uids": [], "profiles": {}}))
                (data / "native-library-defaults.json").write_text('{"schema_version":1}')
                env = isolated_environment(home)
                env.pop("BILIKARA_ADMIN_SECRET", None)
                env["BILIKARA_CF_API_URL"] = f"http://127.0.0.1:{worker.server_port}"
                env["BILIKARA_CATALOG_SHEETS_URL"] = ""
                host = RunningHost(Path(os.environ["BILIKARA_TEST_NATIVE_PACKAGE"]).resolve(), home,
                    "--headless", "--data-dir", str(data), env=env)
                try:
                    snapshot = host.api("/api/state")
                    self.assertTrue(snapshot["capabilities"]["catalog_write"])
                    self.assertTrue(snapshot["capabilities"]["maintenance"])
                    secret = {"BILIKARA_ADMIN_SECRET": "fixture-admin"}
                    for body in ({}, {"BILIKARA_ADMIN_SECRET": "wrong"}):
                        with self.assertRaises(urllib.error.HTTPError) as error:
                            host.api("/api/admin-blacklist/list", body)
                        self.assertEqual(error.exception.code, 403)
                    self.assertFalse(any(path == "/admin/blacklist/list" for path, _, _ in calls))
                    self.assertTrue(host.api("/api/bilikara-secret/verify", secret)["verified"])
                    for route, fields in [
                        ("/api/admin-review/pending", {}),
                        ("/api/admin-review/approve", {"bvids": []}),
                        ("/api/admin-review/reject", {"bvid": "BV1tPC2BEEjq"}),
                        ("/api/admin-blacklist/list", {}),
                        ("/api/admin-blacklist/restore", {"bvid": "BV1tPC2BEEjq"}),
                        ("/api/admin-tags/reset", {"bvid": "BV1tPC2BEEjq"}),
                        ("/api/admin-video/delete", {"bvid": "BV1tPC2BEEjq"}),
                        ("/api/admin-video/delete-mid", {"mid": "123"}),
                    ]:
                        with self.subTest(route=route):
                            host.api(route, {**secret, **fields})
                    with host.request("/api/admin-maintenance/trigger", {**secret, "job": "tagger-yomi"}) as response:
                        self.assertEqual(response.status, 202)
                    with self.assertRaises(urllib.error.HTTPError) as error:
                        host.api("/api/admin-blacklist/list", {**secret, "query": "reject-fixture"})
                    self.assertEqual(error.exception.code, 403)
                    # Even with the correct administrator secret, a LAN Remote
                    # identity must not acquire local Host administration authority.
                    import http.cookiejar
                    remote = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
                    remote.open(snapshot["remote_access"]["local_url"], timeout=5).close()
                    request = urllib.request.Request(host.base + "/api/admin-blacklist/list", data=json.dumps(secret).encode(), headers={"Content-Type":"application/json", "Origin":host.base})
                    with self.assertRaises(urllib.error.HTTPError) as error:
                        remote.open(request, timeout=5)
                    self.assertEqual(error.exception.code, 403)
                    hold_export.set()
                    with host.request("/api/admin-maintenance/trigger", {**secret, "job":"monthly-d1-refresh"}) as response:
                        self.assertEqual(response.status, 202)
                        self.assertEqual(json.load(response)["data"]["runner"], "local")
                    self.assertTrue(export_entered.wait(5))
                    with self.assertRaises(urllib.error.HTTPError) as error:
                        host.api("/api/admin-maintenance/trigger", {**secret, "job":"monthly-d1-refresh"})
                    self.assertEqual(error.exception.code, 409)
                    export_release.set()
                    log = data / "logs/monthly-d1-refresh.log"
                    deadline = time.monotonic() + 5
                    while time.monotonic() < deadline and (not log.exists() or '"completed"' not in log.read_text()):
                        time.sleep(0.02)
                    self.assertIn('"completed"', log.read_text())
                    self.assertNotIn("fixture-admin", log.read_text())
                    # Completion releases the one-job lease.
                    host.api("/api/admin-maintenance/trigger", {**secret, "job":"monthly-d1-refresh"})
                    self.assertTrue(any(path == "/admin/jobs/tagger-yomi" and auth == "Bearer fixture-admin" for path, _, auth in calls))
                finally:
                    export_release.set()
                    host.close()
        finally:
            export_release.set()
            worker.shutdown()
            worker.server_close()
            thread.join(timeout=5)
