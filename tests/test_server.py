import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from bilikara.server import AppContext, BilikaraHandler, run


class AppContextRemoteAccessTest(unittest.TestCase):
    def make_context(self, *, host: str = "0.0.0.0", port: int = 8080) -> AppContext:
        context = AppContext.__new__(AppContext)
        context._closed = False
        context._host = host
        context._port = port
        context._remote_access_lock = threading.RLock()
        context._remote_access = AppContext._build_remote_access_payload(host, port, [])
        context._state_change_condition = threading.Condition()
        context._state_revision = 0
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
        self.assertEqual(context._state_revision, 1)


class AppContextStateRevisionTest(unittest.TestCase):
    def test_wait_for_state_change_unblocks_after_notify(self):
        context = AppContext.__new__(AppContext)
        context._closed = False
        context._state_change_condition = threading.Condition()
        context._state_revision = 0

        results: list[bool] = []

        def wait_for_change() -> None:
            results.append(context.wait_for_state_change(0, timeout=1.0))

        worker = threading.Thread(target=wait_for_change)
        worker.start()
        context._notify_state_changed()
        worker.join(timeout=1.0)

        self.assertFalse(worker.is_alive())
        self.assertEqual(results, [True])


class AppContextClientTrackingTest(unittest.TestCase):
    def make_context(self) -> AppContext:
        context = AppContext.__new__(AppContext)
        context._client_lock = threading.RLock()
        context._client_last_seen = {}
        context._host_client_last_seen = {}
        context._host_seen_once = False
        context._client_seen_once = False
        context._no_clients_since = None
        context._shutdown_requested = False
        context._client_stale_seconds = 120.0
        return context

    def test_disconnecting_last_host_client_starts_shutdown_grace_even_if_remote_client_remains(self):
        context = self.make_context()

        context.touch_client("host-client", is_host=True)
        context.touch_client("remote-client", is_host=False)
        context.disconnect_client("host-client")

        self.assertNotIn("host-client", context._client_last_seen)
        self.assertIn("remote-client", context._client_last_seen)
        self.assertEqual(context._host_client_last_seen, {})
        self.assertIsNotNone(context._no_clients_since)


class RunDefaultsTest(unittest.TestCase):
    def test_run_defaults_enable_shutdown_on_last_client(self):
        with patch("bilikara.server._serve") as serve:
            run()

        serve.assert_called_once()
        self.assertTrue(serve.call_args.kwargs["shutdown_on_last_client"])


class PlaylistAddRequestTest(unittest.TestCase):
    def test_add_requires_session_user_before_parsing_video(self):
        handler = BilikaraHandler.__new__(BilikaraHandler)
        context = SimpleNamespace(has_session_users=lambda: False)

        with patch("bilikara.server.CONTEXT", context), patch(
            "bilikara.server.fetch_video_item",
            side_effect=AssertionError("should not parse video before user setup"),
        ) as fetch_video:
            with self.assertRaisesRegex(ValueError, "请先在服务端添加本场 KTV 用户"):
                handler._handle_add(
                    {
                        "url": "https://www.bilibili.com/video/BV1xx411c7mD",
                        "position": "tail",
                        "requester_name": "",
                    }
                )

        fetch_video.assert_not_called()


class HistoryRouteTest(unittest.TestCase):
    def test_history_clear_route_returns_fresh_snapshot(self):
        handler = BilikaraHandler.__new__(BilikaraHandler)
        writes: list[dict] = []
        context = SimpleNamespace(
            touch_client=lambda client_id, is_host=True: None,
            clear_history=lambda: writes.append({"cleared": True}),
            snapshot=lambda: {"history": []},
        )

        handler.path = "/api/history/clear"
        handler.headers = {}
        handler._read_json_body = lambda: {}
        handler._write_json = lambda payload, status=None: writes.append(payload)

        with patch("bilikara.server.CONTEXT", context):
            handler.do_POST()

        self.assertEqual(writes[0], {"cleared": True})
        self.assertEqual(writes[1], {"ok": True, "data": {"history": []}})


class PlayerResetRouteTest(unittest.TestCase):
    def test_player_reset_route_returns_fresh_snapshot(self):
        handler = BilikaraHandler.__new__(BilikaraHandler)
        writes: list[dict] = []
        context = SimpleNamespace(
            touch_client=lambda client_id, is_host=True: None,
            reset_player_state=lambda: writes.append({"reset_player": True}),
            snapshot=lambda: {"playback_mode": "local"},
        )

        handler.path = "/api/player/reset"
        handler.headers = {}
        handler._read_json_body = lambda: {}
        handler._write_json = lambda payload, status=None: writes.append(payload)

        with patch("bilikara.server.CONTEXT", context):
            handler.do_POST()

        self.assertEqual(writes[0], {"reset_player": True})
        self.assertEqual(writes[1], {"ok": True, "data": {"playback_mode": "local"}})


class PlaylistResortRouteTest(unittest.TestCase):
    def test_playlist_resort_route_returns_fresh_snapshot(self):
        handler = BilikaraHandler.__new__(BilikaraHandler)
        writes: list[dict] = []
        context = SimpleNamespace(
            touch_client=lambda client_id, is_host=True: None,
            resort_playlist_by_cycle=lambda: writes.append({"resorted": True}),
            snapshot=lambda: {"playlist": ["b", "c", "a"]},
        )

        handler.path = "/api/playlist/resort"
        handler.headers = {}
        handler._read_json_body = lambda: {}
        handler._write_json = lambda payload, status=None: writes.append(payload)

        with patch("bilikara.server.CONTEXT", context):
            handler.do_POST()

        self.assertEqual(writes[0], {"resorted": True})
        self.assertEqual(writes[1], {"ok": True, "data": {"playlist": ["b", "c", "a"]}})


if __name__ == "__main__":
    unittest.main()
