"""Real native HTTP, storage upgrade and paginated export compatibility."""
import csv
import io
import json
import os
import socket
from pathlib import Path
import tempfile
import unittest
import urllib.error
import urllib.request
import zipfile

from scripts.check_native_desktop_bundle import RunningHost, isolated_environment

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(os.environ.get("BILIKARA_TEST_NATIVE_HOST_BINARY"), "requires built native Host")
class NativeCompatibilityMigrationTest(unittest.TestCase):
    def test_legacy_configuration_environment_and_real_paginated_zip_survive_restart(self):
        with tempfile.TemporaryDirectory(prefix="native-compatibility-") as temporary:
            home = Path(temporary)
            data = home / "data"
            data.mkdir()
            entry = {"key": "song", "item_id": "song", "display_title": "【卡拉OK】Song - P2",
                     "title": "Song", "part_title": "P2", "original_url": "", "resolved_url": "",
                     "bvid": "BV1xx411c7mD", "aid": 1, "cid": 2, "page": 2,
                     "played_at": 1, "owner_name": "Fixture owner"}
            preferences = {f"user:User-{i}": {"uid_weight": i % 100} for i in range(300)}
            # A single user also exceeds the old 64 KiB eviction/rejection bound.
            preferences["user:Large"] = {"excluded_uids": [str(10000000 + i) for i in range(20000)]}
            seed = {"session_started_at": 1, "session_played_file": "played.json", "updated_at": 1,
                    "session_played": [{**entry, "key": f"song-{i}"} for i in range(51)],
                    "history": [{**{k: entry[k] for k in ("display_title", "title", "part_title", "original_url", "resolved_url", "owner_name")}, "key": f"history-{i}", "requested_at": 1} for i in range(10001)],
                    "gatcha_pool_preferences": preferences}
            original = json.dumps({"schema_version": 1, "state": seed}).encode()
            (data / "host-state.json").write_bytes(original)
            legacy_pool = b'{"uid_weight":17,"excluded_uids":["42"]}'
            (data / "gatcha_pool_config.json").write_bytes(legacy_pool)
            env = isolated_environment(home)
            env.update(BILIKARA_HOST="127.0.0.2", BILIKARA_MAX_CACHE_ITEMS="5",
                       BB_DOWN_PATH=str(home / "missing-bbdown"))
            with socket.socket() as reservation:
                reservation.bind(("127.0.0.1", 0))
                port = reservation.getsockname()[1]
            env["BILIKARA_PORT"] = str(port)
            if companion := os.environ.get("BILIKARA_TEST_LIBAV_COMPANION"):
                env["BILIKARA_LIBAV_COMPANION"] = companion
            def start():
                return RunningHost(Path(os.environ["BILIKARA_TEST_NATIVE_HOST_BINARY"]), home,
                                   "--data-dir", str(data), "--static-dir", str(ROOT / "static"), env=env)
            host = start()
            remote_client = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            with remote_client.open(host.base + "/remote", timeout=10) as response:
                remote_cookie = response.headers["Set-Cookie"].split(";", 1)[0]
            def remote(path, body=None):
                return remote_client.open(urllib.request.Request(host.base + path,
                    data=None if body is None else json.dumps(body).encode(),
                    headers={"Cookie": remote_cookie, "Origin": host.base,
                             "Content-Type": "application/json"}), timeout=15)
            try:
                first_epoch = host.api("/api/state")["state_epoch"]
                self.assertTrue(first_epoch)
                self.assertTrue(host.base.endswith(f":{port}"))
                self.assertEqual(host.api("/api/state")["cache_policy"]["max_cache_items"], 5)
                self.assertEqual(host.api("/api/gatcha/pool-config")["uid_weight"], 17)
                host.api("/api/session/startup-choice", {"choice": "continue"})
                with remote("/api/remote-identity/register", {"name": "Migration singer"}) as response:
                    self.assertEqual(json.load(response)["data"]["name"], "Migration singer")
                host.api("/api/cache-policy", {"max_cache_items": 2})
                for source in ("yt-dlp", "ytdlp"):
                    status = host.api("/api/cache-downloader/status", {"download_source": source})
                    self.assertFalse(status["enabled"])
                    self.assertEqual(status["state"], "disabled")
                    with self.assertRaises(urllib.error.HTTPError) as error:
                        host.api("/api/cache-policy", {"download_source": source})
                    self.assertEqual(error.exception.code, 501)
                    self.assertEqual(json.load(error.exception)["code"], "cache_source_unavailable")
                    error.exception.close()
                for size, mime, extension in [(100, "image/png", "png"), (50, "application/zip", "zip")]:
                    with host.request(f"/api/playlist/export?format=image&source=played&page_size={size}") as response:
                        self.assertEqual(response.headers["Content-Type"], mime)
                        self.assertRegex(response.headers["Content-Disposition"], rf'bilikara-played-\d{{8}}-\d{{6}}\.{extension}"$')
                        payload = response.read()
                    if extension == "png":
                        self.assertTrue(payload.startswith(b"\x89PNG\r\n\x1a\n"))
                    else:
                        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
                            self.assertEqual(len(archive.namelist()), 2)
                            for name in archive.namelist():
                                self.assertTrue(name.endswith(".png"))
                                self.assertTrue(archive.read(name).startswith(b"\x89PNG\r\n\x1a\n"))
                with host.request("/api/playlist/export?format=csv&source=history") as response:
                    rows = list(csv.reader(io.StringIO(response.read().decode("utf-8-sig"))))
                self.assertEqual(len(rows), 10002)
                self.assertIn("播放时间", rows[0])
                self.assertIn(entry["display_title"], rows[1])
                with remote("/api/playlist/export?format=image&source=played&page_size=50") as response:
                    self.assertEqual(response.headers["Content-Type"], "application/zip")
                    self.assertTrue(response.headers["Content-Disposition"].endswith('.zip"'))
                    with zipfile.ZipFile(io.BytesIO(response.read())) as archive:
                        self.assertEqual(len(archive.namelist()), 2)
            finally:
                host.close()
            self.assertEqual((data / "host-state.v1.backup.json").read_bytes(), original)
            self.assertEqual((data / "gatcha_pool_config.legacy.backup.json").read_bytes(), legacy_pool)
            manifest = json.loads((data / "host-state.json").read_text())
            self.assertEqual(manifest["schema_version"], 3)
            pieces = manifest["records"]["gatcha_pool_preferences"]
            migrated = json.loads(b"".join((data / "host-records" / name).read_bytes() for name in pieces))
            for key, value in preferences.items():
                self.assertEqual(migrated[key], value)
            self.assertEqual(migrated[":default"]["uid_weight"], 17)
            token = remote_cookie.split("=", 1)[1].encode()
            for path in data.rglob("*"):
                if path.is_file():
                    self.assertNotIn(token, path.read_bytes(), str(path.relative_to(data)))
            host = start()
            try:
                self.assertNotEqual(host.api("/api/state")["state_epoch"], first_epoch)
                self.assertEqual(host.api("/api/state")["cache_policy"]["max_cache_items"], 2)
                self.assertEqual(host.api("/api/gatcha/pool-config")["uid_weight"], 17)
                with remote("/remote") as response:
                    response.read()
                with remote("/api/remote-identity") as response:
                    self.assertEqual(json.load(response)["data"]["name"], "Migration singer")
            finally:
                host.close()
