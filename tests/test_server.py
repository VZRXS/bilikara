import threading
import unittest
from unittest.mock import patch

from bilikara.server import AppContext


class AppContextRemoteAccessTest(unittest.TestCase):
    def make_context(self, *, host: str = "0.0.0.0", port: int = 8080) -> AppContext:
        context = AppContext.__new__(AppContext)
        context._host = host
        context._port = port
        context._remote_access_lock = threading.RLock()
        context._remote_access = AppContext._build_remote_access_payload(host, port, [])
        return context

    def test_remote_access_snapshot_uses_cached_payload(self):
        context = self.make_context()
        context._remote_access = {
            "local_url": "http://127.0.0.1:8080/remote",
            "lan_urls": ["http://192.168.0.8:8080/remote"],
            "preferred_url": "http://192.168.0.8:8080/remote",
        }

        with patch("bilikara.server._network_access_urls", side_effect=AssertionError("should not resolve")):
            snapshot = context.remote_access_snapshot()

        self.assertEqual(snapshot["preferred_url"], "http://192.168.0.8:8080/remote")
        self.assertEqual(snapshot["lan_urls"], ["http://192.168.0.8:8080/remote"])

    def test_refresh_remote_access_snapshot_updates_cached_lan_urls(self):
        context = self.make_context()

        with patch("bilikara.server._network_access_urls", return_value=["http://192.168.0.8:8080"]):
            context._refresh_remote_access_snapshot()

        snapshot = context.remote_access_snapshot()
        self.assertEqual(snapshot["local_url"], "http://127.0.0.1:8080/remote")
        self.assertEqual(snapshot["lan_urls"], ["http://192.168.0.8:8080/remote"])
        self.assertEqual(snapshot["preferred_url"], "http://192.168.0.8:8080/remote")


if __name__ == "__main__":
    unittest.main()
