"""Deterministic PR109 baseline against the desktop HTTP -> Runtime FFI path.

Assertions from the original failing baseline remain active regressions. Run in
an isolated process: BILIKARA_HOME=$(mktemp -d) BILIKARA_REQUIRE_RUST_LIB=1
python -m unittest tests.test_transport_concurrency -v
Only remote acquisition/cache/update side effects are replaced, never AppState
or control delivery. All songs and identities are synthetic.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import threading
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from http.server import ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import Mock, patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from bilikara import internet_remote, server
from bilikara.models import PlaylistItem


def synthetic_item(name="a", bvid=None):
    bvid = bvid or f"BV1test0000{name}"
    return PlaylistItem(
        id=f"fixture-{name}", bvid=bvid, aid=1, cid=1, page=1,
        original_url=f"https://www.bilibili.com/video/{bvid}",
        resolved_url=f"https://www.bilibili.com/video/{bvid}",
        title=f"Synthetic {name}", display_title=f"Synthetic {name}",
        part_title="", cover_url="", embed_url="",
    )


class DesktopFixture:
    """Reusable real HTTP server with temporary persistence and inert workers."""

    def __init__(self, media_path=None):
        self.media_path = media_path

    def __enter__(self):
        self.stack = ExitStack()
        root = Path(self.stack.enter_context(TemporaryDirectory(prefix="bilikara-concurrency-")))
        for name, path in {
            "STATE_FILE": root / "state.json", "BACKUP_FILE": root / "backup.json",
            "PLAYED_SESSION_DIR": root / "sessions", "REMOTE_IDENTITIES_FILE": root / "identities.json",
        }.items():
            self.stack.enter_context(patch.object(server, name, path))
        cache = Mock(reset_offset_on_next=False)
        for method in ("cache_metrics", "status", "ffmpeg_status", "policy_snapshot"):
            getattr(cache, method).return_value = {}
        self.stack.enter_context(patch.object(server, "CacheManager", return_value=cache))
        self.stack.enter_context(patch.object(server, "AppUpdateManager", return_value=Mock(snapshot=lambda: {})))
        for module in (server, internet_remote):
            for name in ("gatcha_task_snapshot", "gatcha_pool_config_snapshot"):
                self.stack.enter_context(patch.object(module, name, return_value={}))
            self.stack.enter_context(patch.object(module, "append_lark_pool_entries_in_background"))
        self.stack.enter_context(patch.object(server, "gatcha_favlist_updated_at", return_value={}))
        self.context = server.AppContext()
        self.stack.enter_context(patch.object(server, "CONTEXT", self.context))
        self.context.store.add_session_user("Fixture ID")
        for name in "abc":
            self.context.add_item(synthetic_item(name), position="tail", requester_name="Fixture ID", allow_repeat=False)
        media_path = self.media_path
        class Handler(server.BilikaraHandler):
            def do_GET(self):
                if self.path == "/__fixture/media.webm" and media_path:
                    return self._stream_file(media_path, content_type="video/webm", allow_ranges=True)
                return super().do_GET()
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.httpd.server_port}"
        self.epoch = "abcdefghijklmnopqrstuv"
        self.sequences = {"control": 0, "bulk": 0}
        self.sequence_lock = threading.Lock()
        self.post("/api/internet-remote/peer/open", {"peer_id": "fixture-peer", "epoch": self.epoch})
        self.remote("session.set_identity", {"name": "Fixture ID"})
        return self

    def __exit__(self, *exc):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=5)
        self.context.store.shutdown()
        self.stack.close()

    def post(self, path, body):
        request = Request(self.base + path, json.dumps(body).encode(), {"Content-Type": "application/json"})
        try:
            response = urlopen(request, timeout=8)
        except HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response)

    def remote(self, kind, body, lane="control", *, epoch=None):
        with self.sequence_lock:
            self.sequences[lane] += 1
            sequence = self.sequences[lane]
        return self.post("/api/internet-remote/dispatch", {
            "peer_id": "fixture-peer", "lane": lane,
            "message": json.dumps({"v": 1, "lane": lane, "epoch": epoch or self.epoch,
                "seq": sequence, "id": str(uuid.uuid4()), "kind": kind, "body": body}),
        })

    def target(self):
        snapshot = self.context.store.snapshot()
        return {"item_id": snapshot["current_item"]["id"], "playback_generation": snapshot["playback_generation"]}


class TransportConcurrencyTest(unittest.TestCase):
    def setUp(self):
        self.fixture = DesktopFixture()
        self.f = self.fixture.__enter__()
        self.addCleanup(self.fixture.__exit__, None, None, None)

    def parallel(self, *operations):
        barrier = threading.Barrier(len(operations))
        def run(operation):
            barrier.wait(timeout=5)
            return operation()
        with ThreadPoolExecutor(max_workers=len(operations)) as executor:
            futures = [executor.submit(run, operation) for operation in operations]
            return [future.result(timeout=10) for future in futures]

    def drain(self):
        commands = []
        while command := self.f.context.player_control_command_snapshot():
            commands.append(command)
            self.assertEqual(self.f.post("/api/player/control-ack", {"seq": command["seq"]})[0], 200)
            self.assertLess(len(commands), 20, "ACK did not advance the command head")
        return commands

    def test_two_accepted_lan_internet_seeks_survive_until_host_consumption(self):
        target = self.f.target()
        results = self.parallel(
            lambda: self.f.post("/api/player/control", {**target, "action": "seek-relative", "delta_seconds": 7}),
            lambda: self.f.remote("playback.seek_relative", {**target, "delta_seconds": 11}),
        )
        self.assertTrue(all(status == 200 and body["ok"] for status, body in results), results)
        self.assertTrue(results[1][1]["data"]["accepted"])
        # No Host consumption occurs until both real HTTP responses complete.
        commands = self.drain()
        self.assertEqual(sorted(command["delta_seconds"] for command in commands), [7, 11], commands)

    def test_future_ack_cannot_erase_pending_or_future_commands(self):
        target = self.f.target()
        self.f.post("/api/player/control", {**target, "action": "pause"})
        head = self.f.context.player_control_command_snapshot()
        self.f.post("/api/player/control-ack", {"seq": head["seq"] + 100})
        self.assertEqual(self.f.context.player_control_command_snapshot(), head)
        self.drain()
        self.f.post("/api/player/control", {**target, "action": "play"})
        self.assertEqual(len(self.drain()), 1)

    def test_duplicate_and_stale_ack_do_not_consume_a_new_head(self):
        target = self.f.target()
        self.f.post("/api/player/control", {**target, "action": "pause"})
        first = self.drain()[0]
        self.f.post("/api/player/control", {**target, "action": "play"})
        head = self.f.context.player_control_command_snapshot()
        for seq in (first["seq"], first["seq"], 0):
            self.f.post("/api/player/control-ack", {"seq": seq})
            self.assertEqual(self.f.context.player_control_command_snapshot(), head)

    def test_simultaneous_same_generation_next_advances_once_and_rejects_old_remote(self):
        target = self.f.target()
        # Internet Next is accepted before LAN's actual Host next execution.
        accepted = self.f.remote("playback.next", {"playback_generation": target["playback_generation"]})
        self.assertTrue(accepted[1]["data"]["accepted"])
        command = self.f.context.player_control_command_snapshot()
        results = self.parallel(*[lambda: self.f.post("/api/player/next", {
            "playback_generation": command["playback_generation"]}) for _ in range(2)])
        self.assertEqual(sum(bool(body.get("stale")) for _, body in results), 1, results)
        self.assertEqual(self.f.target()["item_id"], "fixture-b")
        stale = self.f.remote("playback.seek_relative", {**target, "delta_seconds": 11})[1]["data"]
        self.assertFalse(stale["accepted"])
        self.assertTrue(stale["stale"])
        self.assertEqual(self.f.target()["item_id"], "fixture-b")

    def test_only_local_host_can_ack_and_invalid_sequence_does_not_consume_head(self):
        self.f.post("/api/player/control", {**self.f.target(), "action": "pause"})
        head = self.f.context.player_control_command_snapshot()
        with patch.object(server.BilikaraHandler, "_is_local_client", return_value=False):
            self.assertEqual(self.f.post("/api/player/control-ack", {"seq": head["seq"]})[0], 403)
        for invalid in (True, -1, 2**53, 1.5):
            self.assertEqual(self.f.post("/api/player/control-ack", {"seq": invalid})[0], 400)
        self.assertEqual(self.f.context.player_control_command_snapshot(), head)

    def test_full_queue_rejects_explicitly_then_recovers_and_reset_rejects_late_controls(self):
        target = self.f.target()
        for _ in range(16):
            self.assertEqual(self.f.post("/api/player/control", {**target, "action": "pause"})[0], 200)
        first = self.f.context.player_control_command_snapshot()
        status, error = self.f.post("/api/player/control", {**target, "action": "play"})
        self.assertEqual((status, error["code"]), (429, "player_busy"))
        status, error = self.f.remote("playback.pause", target)
        self.assertFalse(error["ok"])
        self.assertEqual((status, error["code"]), (429, "player_busy"))
        self.assertEqual(len(self.drain()), 16)
        self.assertEqual(self.f.post("/api/player/control", {**target, "action": "play"})[0], 200)
        self.assertEqual(self.f.post("/api/player/reset", {})[0], 200)
        self.assertIsNone(self.f.context.player_control_command_snapshot())
        status, error = self.f.post("/api/player/control", {**target, "action": "pause"})
        self.assertEqual((status, error["code"]), (409, "stale_command"))
        self.assertEqual(self.f.post("/api/player/control", {**self.f.target(), "action": "play"})[0], 200)
        head = self.f.context.player_control_command_snapshot()
        self.assertGreater(head["seq"], first["seq"])
        self.f.post("/api/player/control-ack", {"seq": first["seq"]})
        self.assertEqual(self.f.context.player_control_command_snapshot(), head)

    def test_generation_change_between_dispatch_and_host_effect_is_rechecked(self):
        entered, release = threading.Event(), threading.Event()
        original = self.f.context.issue_player_control
        def held_issue(**fields):
            entered.set()
            if not release.wait(8):
                raise RuntimeError("control effect barrier was not released")
            return original(**fields)
        target = self.f.target()
        with patch.object(self.f.context, "issue_player_control", side_effect=held_issue), ThreadPoolExecutor(max_workers=1) as executor:
            pending = executor.submit(self.f.remote, "playback.seek_relative", {**target, "delta_seconds": 7})
            try:
                self.assertTrue(entered.wait(5))
                self.assertEqual(self.f.post("/api/player/next", {"playback_generation": target["playback_generation"]})[0], 200)
            finally:
                release.set()
            status, result = pending.result(timeout=10)
        self.assertEqual(status, 409)
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "stale_command")
        self.assertIsNone(self.f.context.player_control_command_snapshot())

    def test_add_completion_checks_latest_duplicate_after_concurrent_remove_reorder(self):
        entered, release = threading.Event(), threading.Event()
        def metadata(*args, **kwargs):
            entered.set()
            if not release.wait(8):
                raise RuntimeError("metadata barrier was not released")
            return synthetic_item("d")
        revision = self.f.context.store.revision
        with patch.object(internet_remote, "fetch_video_item", side_effect=metadata), ThreadPoolExecutor(max_workers=1) as executor:
            pending = executor.submit(self.f.remote, "playlist.add", {
                "catalog_item_id": "BV1test0000d", "position": "tail", "allow_repeat": False,
                "expected_revision": revision}, "bulk")
            try:
                self.assertTrue(entered.wait(5))
                self.assertTrue(self.f.remote("playback.pause", self.f.target())[1]["data"]["accepted"])
                self.assertFalse(pending.done())
                self.f.context.add_item(synthetic_item("d"), position="tail", requester_name="Fixture ID", allow_repeat=False)
                self.assertEqual(self.f.post("/api/playlist/remove", {"item_id": "fixture-b"})[0], 200)
                self.assertEqual(self.f.post("/api/playlist/reorder", {"item_id": "fixture-d", "index": 0})[0], 200)
                stale = self.f.remote("playlist.move", {"item_id": "fixture-c", "target_index": 0, "expected_revision": revision})[1]["data"]
                self.assertFalse(stale["accepted"])
                self.assertTrue(stale["stale"])
            finally:
                release.set()
            status, response = pending.result(timeout=10)
        self.assertFalse(response.get("data", {}).get("accepted", response.get("ok")), (status, response))
        self.assertIn("duplicate", json.dumps(response))
        snapshot = self.f.context.store.snapshot()
        self.assertEqual([item["id"] for item in snapshot["playlist"]], ["fixture-d", "fixture-c"])
        self.assertGreater(snapshot["revision"], revision)

    def test_delayed_search_releases_state_lock_and_control_lane(self):
        entered, release = threading.Event(), threading.Event()
        def search(*args, **kwargs):
            entered.set()
            if not release.wait(8):
                raise RuntimeError("search barrier was not released")
            return []
        with patch.object(internet_remote, "search_lark_pool", side_effect=search), ThreadPoolExecutor(max_workers=1) as executor:
            pending = executor.submit(self.f.remote, "catalog.search", {"query": "synthetic", "limit": 5}, "bulk")
            try:
                self.assertTrue(entered.wait(5))
                response = self.f.remote("playback.pause", self.f.target())
                self.assertTrue(response[1]["data"]["accepted"])
                self.assertFalse(pending.done())
                self.assertEqual(self.drain()[0]["action"], "pause")
            finally:
                release.set()
            self.assertEqual(pending.result(timeout=10)[0], 200)

    def test_absolute_settings_last_writer_and_lan_adjustments_add(self):
        entered, release = threading.Event(), threading.Event()
        original = self.f.context.set_key_shift
        def delayed_absolute(value):
            entered.set()
            if not release.wait(8):
                raise RuntimeError("absolute setting barrier was not released")
            return original(value)
        with patch.object(self.f.context, "set_key_shift", side_effect=delayed_absolute), ThreadPoolExecutor(max_workers=1) as executor:
            pending = executor.submit(self.f.post, "/api/player/key-shift", {"key_shift": -1})
            try:
                self.assertTrue(entered.wait(5))
                self.assertTrue(self.f.remote("player.set_key_shift", {"key_shift": 2})[1]["data"]["accepted"])
                self.assertFalse(pending.done())
            finally:
                release.set()
            self.assertEqual(pending.result(timeout=10)[0], 200)
        self.assertEqual(self.f.context.store.snapshot()["player_settings"]["key_shift"], -1)
        results = self.parallel(*[lambda: self.f.post("/api/player/av-delay-action", {
            "type": "adjust", "delta_ms": 50}) for _ in range(2)])
        self.assertTrue(all(status == 200 for status, _ in results))
        self.assertEqual(self.f.context.store.snapshot()["player_settings"]["av_offset_ms"], 100)

    def test_peer_close_rebuild_revokes_old_epoch_and_keeps_lan_usable(self):
        old_epoch = self.f.epoch
        self.assertEqual(self.f.post("/api/internet-remote/peer/close", {"peer_id": "fixture-peer"})[0], 200)
        self.assertEqual(self.f.post("/api/player/key-shift", {"key_shift": 1})[0], 200)
        self.assertFalse(self.f.remote("connection.health", {})[1]["ok"])
        self.f.epoch = "z" * 22
        self.assertEqual(self.f.post("/api/internet-remote/peer/open", {"peer_id": "fixture-peer", "epoch": self.f.epoch})[0], 200)
        self.assertFalse(self.f.remote("connection.health", {}, epoch=old_epoch)[1]["ok"])
        self.assertTrue(self.f.remote("session.set_identity", {"name": "Fixture ID"})[1]["ok"])
        self.assertTrue(self.f.remote("playback.pause", self.f.target())[1]["data"]["accepted"])
        self.assertEqual(self.f.post("/api/player/key-shift", {"key_shift": 3})[0], 200)
        self.assertEqual(self.f.context.store.snapshot()["player_settings"]["key_shift"], 3)

    def test_lan_and_internet_av_adjustments_add_under_the_same_state_lock(self):
        results = self.parallel(
            lambda: self.f.post("/api/player/av-delay-action", {"type": "adjust", "delta_ms": 50}),
            lambda: self.f.remote("player.av_delay_action", {"type": "adjust", "delta_ms": 50}),
        )
        self.assertTrue(all(status == 200 and body["ok"] for status, body in results), results)
        self.assertTrue(results[1][1]["data"]["accepted"])
        self.assertEqual(self.f.context.store.snapshot()["player_settings"]["av_offset_ms"], 100)
        for action in ({"type": "toggle_lock"}, {"type": "adjust", "delta_ms": 50}, {"type": "reset_local"}):
            self.assertTrue(self.f.remote("player.av_delay_action", action)[1]["data"]["accepted"])
        snapshot = self.f.context.store.snapshot()["player_settings"]
        self.assertEqual(snapshot["av_offset_ms"], 100)
        self.assertTrue(snapshot["av_delay"]["locked"])


class PlayerControlConsumptionTest(unittest.TestCase):
    def test_ack_failure_retries_head_without_reapplying_seek_or_parallel_ack(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("node unavailable")
        source = (Path(__file__).resolve().parents[1] / "static/app.js").read_text()
        source = source[source.index("function applyRemotePlayerControl("):source.index("function observedHostPlayerStatus(")]
        harness = r"""
const assert = require("node:assert/strict");
const state = {data:{playback_generation:1}, hostPlaybackSession:{playbackGeneration:1},
  lastAppliedPlayerControlSeq:0, localShouldBePlaying:false};
let applied = 0, calls = 0, rejectAck, resolveAck;
const video = { currentTime: 0, duration: 60, paused: true };
const elements = { playerFrame: {querySelector: (selector) => selector === "video" ? video : null} };
const isCurrentHostPlaybackSession = (session) => session === state.hostPlaybackSession;
const setMediaCurrentTime = (video, time) => { applied++; video.currentTime = time; };
const apiPost = () => { calls++; return new Promise((resolve, reject) => {resolveAck=resolve;rejectAck=reject;}); };
(async () => {
  const command = {seq:1,action:"seek-relative",item_id:"fixture",playback_generation:1,delta_seconds:7};
  const consume = () => applyRemotePlayerControl(command, {id:"fixture"}, "local");
  consume(); consume();
  assert.equal(calls, 1); assert.equal(applied, 1);
  rejectAck(new Error("controlled ACK failure"));
  await Promise.resolve(); await Promise.resolve();
  consume(); consume();
  assert.equal(calls, 2); assert.equal(applied, 1); assert.equal(video.currentTime, 7);
  resolveAck({ok:true}); await Promise.resolve(); await Promise.resolve();
  assert.equal(state.playerControlAckInFlight.size, 0);
})().catch((error) => { console.error(error); process.exitCode = 1; });
"""
        result = subprocess.run([node, "-e", source + harness], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
