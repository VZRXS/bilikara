"""Actual Rust FFI plus retained Python Host HTTP; no Python scheduling oracle."""
import json
import threading
import unittest
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

from bilikara import server
from bilikara.store import PlaylistStore
from tests.test_app_state_store import item


class QueueOrderingR7Test(unittest.TestCase):
    def test_real_http_top_next_manual_conflicts_and_delete_use_rust_authority(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            store = PlaylistStore(root / "state.json", root / "backup.json", root / "sessions")
            for user in ["A", "B", "C"]:
                store.add_session_user(user)
            for identity in ["A0", "B1", "C1", "A1", "B2", "C2", "A2"]:
                store.add_item(item(identity), requester_name=identity[0])
            context = SimpleNamespace(store=store, snapshot=store.snapshot,
                touch_client=lambda *args, **kwargs: None,
                cache_manager=SimpleNamespace(sync_with_playlist=lambda: None, reset_offset_on_next=True))
            for name in ["move_to_next", "move_to_front", "move_item_to_index", "resort_playlist_by_cycle", "remove_item", "advance_to_next"]:
                setattr(context, name, getattr(server.AppContext, name).__get__(context))
            class Handler(server.BilikaraHandler):
                def log_message(self, *args):
                    pass
            http = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            worker = threading.Thread(target=http.serve_forever, daemon=True)
            def post(route, body):
                connection = HTTPConnection("127.0.0.1", http.server_port, timeout=10)
                try:
                    connection.request("POST", route, json.dumps(body), {"Content-Type": "application/json"})
                    response = connection.getresponse()
                    return response.status, json.loads(response.read())
                finally:
                    connection.close()
            try:
                with patch("bilikara.server.CONTEXT", context):
                    worker.start()
                    old = store.snapshot()
                    self.assertEqual(old["queue_mutation_version"], 1)
                    status, response = post("/api/playlist/move-next", {"item_id": "C1", "expected_queue_version": old["queue_version"]})
                    self.assertEqual(status, 200)
                    self.assertEqual([i["id"] for i in response["data"]["playlist"]], ["C1", "B1", "A1", "B2", "C2", "A2"])
                    before = store.snapshot()
                    for route, body in [
                        ("/api/playlist/move-next", {"item_id": "B2"}),
                        ("/api/playlist/remove", {"item_id": "B1"}),
                        ("/api/playlist/play-now", {"item_id": "B1"}),
                        ("/api/playlist/resort", {}),
                        ("/api/playlist/reorder", {"item_id": "B1", "index": 3}),
                        ("/api/player/next", {"playback_generation": before["playback_generation"]}),
                    ]:
                        status, response = post(route, {**body, "expected_queue_version": old["queue_version"]})
                        self.assertEqual(status, 409, route)
                        self.assertEqual(response["code"], "queue_changed")
                        self.assertEqual(response["data"]["queue_version"], before["queue_version"])
                        self.assertEqual(store.snapshot(), before)
                    status, response = post("/api/player/next", {"playback_generation": before["playback_generation"], "expected_queue_version": before["queue_version"]})
                    self.assertEqual(status, 200)
                    self.assertEqual(response["data"]["current_item"]["id"], "C1")
                    self.assertEqual([i["id"] for i in response["data"]["playlist"]], ["B1", "A1", "B2", "C2", "A2"])
                    status, response = post("/api/playlist/remove", {"item_id": "C1", "expected_queue_version": response["data"]["queue_version"]})
                    self.assertEqual(status, 200)
                    self.assertEqual(response["data"]["current_item"]["id"], "B1")
                    self.assertTrue(any(e["item_id"] == "A0" and e["reason"] == "skipped_unstarted" for e in store.queue_departure_diagnostics()))
                    saved_cursor = store._persistence["stable_cycle_cursor"]
                    saved_order = [i["id"] for i in response["data"]["playlist"]]
                    restarted = PlaylistStore(root / "state.json", root / "backup.json", root / "sessions")
                    self.assertTrue(restarted.restore_backup())
                    self.assertEqual(restarted._persistence["stable_cycle_cursor"], saved_cursor)
                    self.assertEqual([i["id"] for i in restarted.snapshot()["playlist"]], saved_order)
            finally:
                http.shutdown()
                http.server_close()
                worker.join(timeout=10)
                store.shutdown()
