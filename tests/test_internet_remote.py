from __future__ import annotations

import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from bilikara import internet_remote, rust_runtime


def response(*, effect=None, accepted=True, stale=False, revision=7):
    payload = {
        "request_id": "123e4567-e89b-42d3-a456-426614174000",
        "sequence": 1,
        "accepted": accepted,
        "stale": stale,
        "revision": revision,
        "data": {"v": 1, "revision": revision},
    }
    if effect is not None:
        payload["_host_effect"] = effect
    return payload


class FakeStore:
    def __init__(self, dispatch_response, completion_response=None):
        self.dispatch_response = dispatch_response
        self.completion_response = completion_response
        self.dispatch_calls = []
        self.completion_calls = []
        self.cancel_calls = []

    def dispatch_internet_remote_message(
        self, peer_id, lane, message, *, reset_av_delay=False
    ):
        self.dispatch_calls.append((peer_id, lane, message, reset_av_delay))
        return dict(self.dispatch_response)

    def complete_internet_remote_playlist_add(
        self, peer_id, request_id, item, *, reset_av_delay=False
    ):
        self.completion_calls.append((peer_id, request_id, item, reset_av_delay))
        return dict(self.completion_response)

    def cancel_internet_remote_playlist_add(self, peer_id, request_id):
        self.cancel_calls.append((peer_id, request_id))
        return {"cancelled": True}


class FakeCacheManager:
    def __init__(self):
        self.reset_offset_on_next = True
        self.sync_count = 0

    def sync_with_playlist(self):
        self.sync_count += 1


class FakeContext:
    def __init__(self, dispatch_response, completion_response=None):
        self.store = FakeStore(dispatch_response, completion_response)
        self.cache_manager = FakeCacheManager()
        self.player_controls = []
        self.notify_count = 0

    def issue_player_control(self, **fields):
        self.player_controls.append(fields)

    def _notify_state_changed(self):
        self.notify_count += 1


class InternetRemoteAdapterTest(unittest.TestCase):
    def test_remote_state_adds_host_transport_revision_and_live_player_status(self):
        class StateStore:
            def internet_remote_state(self):
                return {
                    "remote_state": {
                        "v": 1,
                        "revision": 7,
                        "playback_generation": 3,
                        "current_item": {"id": "song-a"},
                        "playlist": [{"id": "song-b"}],
                        "history": [{"display_title": "Earlier"}],
                        "player_status": None,
                    }
                }

            def snapshot(self):
                return {"current_item": {"id": "song-a"}, "playback_program": {"item_id": "song-a"}, "playback_generation": 3}

        context = SimpleNamespace(
            store=StateStore(),
            state_revision_snapshot=lambda: 19,
            player_status_snapshot=lambda _snapshot: {
                "is_paused": False,
                "current_time": 12.5,
                "duration": 123.0,
            },
        )

        with (
            patch.object(internet_remote, "gatcha_task_snapshot", return_value={}),
            patch.object(internet_remote, "gatcha_pool_config_snapshot", return_value={}),
        ):
            projected = internet_remote.remote_state(context)

        self.assertEqual(projected["state_revision"], 19)
        self.assertEqual(projected["history"], [{"display_title": "Earlier"}])
        self.assertEqual(
            projected["player_status"],
            {"playing": True, "position_seconds": 12.5, "duration_seconds": 123.0},
        )

    def test_decorator_refreshes_a_stale_rust_projection_before_stamping_revision(self):
        class StateStore:
            def __init__(self):
                self.lock = threading.RLock()
                self.revision = 8

            def internet_remote_state(self):
                return {
                    "remote_state": {
                        "v": 1,
                        "revision": 8,
                        "playback_generation": 4,
                        "current_item": {"id": "song-new"},
                        "playlist": [
                            {"id": "queued-a"},
                            {"id": "queued-b"},
                            {"id": "queued-c"},
                        ],
                        "history": [],
                        "player_settings": {},
                        "player_status": None,
                    }
                }

            def snapshot(self):
                return {
                    "revision": 8,
                    "current_item": {"id": "song-new"},
                    "playback_program": {"item_id": "song-new"},
                    "playback_generation": 4,
                }

        context = SimpleNamespace(
            store=StateStore(),
            state_revision_snapshot=lambda: 20,
            player_status_snapshot=lambda _snapshot: None,
        )
        stale = {
            "v": 1,
            "revision": 7,
            "playback_generation": 3,
            "current_item": {"id": "song-old"},
            "playlist": [{"id": "queued-a"}],
            "history": [],
            "player_settings": {},
            "player_status": None,
        }

        projected = internet_remote._decorate_remote_state(context, stale)

        self.assertEqual(projected["revision"], 8)
        self.assertEqual(projected["state_revision"], 20)
        self.assertEqual(
            [item["id"] for item in projected["playlist"]],
            ["queued-a", "queued-b", "queued-c"],
        )

    def test_dispatch_passes_wire_message_to_the_rust_owned_module(self):
        context = FakeContext(response())

        result = internet_remote.dispatch(context, "peer-one", "control", "wire")

        self.assertTrue(result["accepted"])
        self.assertEqual(
            context.store.dispatch_calls,
            [("peer-one", "control", "wire", True)],
        )

    def test_rust_protocol_rejections_keep_their_machine_readable_kind(self):
        context = FakeContext(response())
        rejected = rust_runtime.RustAppStateRejectedError(
            "rejected",
            "invalid_internet_remote_request",
            "invalid request",
            response={"error": {"kind": "invalid_internet_remote_request"}},
        )
        def reject(*args, **kwargs):
            raise internet_remote.PlaylistStoreCommandError(rejected)

        context.store.dispatch_internet_remote_message = reject

        with self.assertRaises(internet_remote.InternetRemoteDispatchError) as raised:
            internet_remote.dispatch(context, "peer-one", "control", "wire")

        self.assertEqual(raised.exception.kind, "invalid_internet_remote_request")

    def test_typed_player_effect_is_executed_without_exposing_it_to_remote(self):
        context = FakeContext(
            response(
                effect={
                    "kind": "player_control",
                    "action": "seek-relative",
                    "playback_generation": 3,
                    "item_id": "item-1",
                    "delta_seconds": 10,
                }
            )
        )

        result = internet_remote.dispatch(context, "peer-one", "control", "wire")

        self.assertNotIn("_host_effect", result)
        self.assertEqual(
            context.player_controls,
            [
                {
                    "action": "seek-relative",
                    "playback_generation": 3,
                    "item_id": "item-1",
                    "delta_seconds": 10,
                }
            ],
        )

    def test_absolute_seek_effect_forwards_the_exact_target_to_the_host_adapter(self):
        context = FakeContext(
            response(
                effect={
                    "kind": "player_control",
                    "action": "seek-absolute",
                    "playback_generation": 8,
                    "item_id": "item-2",
                    "delta_seconds": 0,
                    "target_seconds": 42,
                }
            )
        )

        result = internet_remote.dispatch(context, "peer-one", "control", "wire")

        self.assertNotIn("_host_effect", result)
        self.assertEqual(
            context.player_controls,
            [
                {
                    "action": "seek-absolute",
                    "playback_generation": 8,
                    "item_id": "item-2",
                    "delta_seconds": 0,
                    "target_seconds": 42.0,
                }
            ],
        )

    def test_follow_browse_effect_forwards_bounded_page_to_repository(self):
        context = FakeContext(
            response(
                effect={
                    "kind": "gatcha_browse",
                    "uid": "42",
                    "query": "song",
                    "offset": 100,
                    "limit": 50,
                }
            )
        )
        repository_page = {
            "owners": [],
            "selected_uid": "42",
            "query": "song",
            "offset": 100,
            "limit": 50,
            "matched_count": 151,
            "has_more": True,
            "next_offset": 150,
            "items": [],
        }

        with patch.object(
            internet_remote,
            "browse_gatcha_cache",
            return_value=repository_page,
        ) as browse:
            result = internet_remote.dispatch(context, "peer-one", "bulk", "wire")

        browse.assert_called_once_with("42", "song", offset=100, limit=50)
        self.assertEqual(result["data"]["next_offset"], 150)
        self.assertTrue(result["data"]["has_more"])

    def test_favlist_browse_effect_forwards_bounded_page_to_repository(self):
        context = FakeContext(
            response(
                effect={
                    "kind": "gatcha_favlist_browse",
                    "folder_id": "42:100",
                    "query": "高达",
                    "offset": 100,
                    "limit": 50,
                }
            )
        )
        repository_page = {
            "folders": [],
            "selected_folder_id": "42:100",
            "query": "高达",
            "offset": 100,
            "limit": 50,
            "matched_count": 151,
            "has_more": True,
            "next_offset": 150,
            "items": [],
        }

        with patch.object(
            internet_remote,
            "browse_gatcha_favlist",
            return_value=repository_page,
        ) as browse:
            result = internet_remote.dispatch(context, "peer-one", "bulk", "wire")

        browse.assert_called_once_with("42:100", "高达", offset=100, limit=50)
        self.assertEqual(result["data"]["matched_count"], 151)
        self.assertEqual(result["data"]["next_offset"], 150)
        self.assertTrue(result["data"]["has_more"])

    def test_catalog_add_uses_rust_completion_and_its_cache_effect(self):
        dispatch_response = response(
            effect={
                "kind": "fetch_playlist_item",
                "catalog_item_id": "BV1ab411c7mD",
            }
        )
        completion_response = response(
            effect={"kind": "sync_cache"},
            revision=8,
        )
        context = FakeContext(dispatch_response, completion_response)
        fake_item = SimpleNamespace(
            owner_mid=1,
            bvid="BV1ab411c7mD",
            title="Song",
            display_title="Song",
            resolved_url="https://www.bilibili.com/video/BV1ab411c7mD",
            original_url="https://www.bilibili.com/video/BV1ab411c7mD",
            owner_name="Singer",
            owner_url="https://space.bilibili.com/1",
            cover_url="https://i0.hdslb.com/song.jpg",
        )

        with (
            patch.object(internet_remote, "_fetch_catalog_item", return_value=fake_item),
            patch.object(internet_remote, "_append_catalog_item") as append,
        ):
            result = internet_remote.dispatch(context, "peer-one", "control", "wire")

        self.assertTrue(result["accepted"])
        self.assertEqual(result["revision"], 8)
        self.assertEqual(context.cache_manager.sync_count, 1)
        self.assertEqual(
            context.store.completion_calls,
            [
                (
                    "peer-one",
                    "123e4567-e89b-42d3-a456-426614174000",
                    fake_item,
                    True,
                )
            ],
        )
        append.assert_called_once_with(fake_item)

    def test_catalog_add_preserves_an_unselected_binding_request(self):
        context = FakeContext(
            response(
                effect={
                    "kind": "fetch_playlist_item",
                    "catalog_item_id": "BV1ab411c7mD",
                    "selected_video_page": None,
                    "selected_audio_pages": [],
                }
            ),
            response(effect={"kind": "sync_cache"}, revision=8),
        )
        fake_item = SimpleNamespace()

        with (
            patch.object(
                internet_remote, "_fetch_catalog_item", return_value=fake_item
            ) as fetch,
            patch.object(internet_remote, "_append_catalog_item"),
        ):
            internet_remote.dispatch(context, "peer-one", "control", "wire")

        fetch.assert_called_once_with(
            "BV1ab411c7mD",
            selected_video_page=None,
            selected_audio_pages=[],
        )

    def test_catalog_add_forwards_an_explicit_manual_binding(self):
        context = FakeContext(
            response(
                effect={
                    "kind": "fetch_playlist_item",
                    "catalog_item_id": "BV1ab411c7mD",
                    "selected_video_page": 2,
                    "selected_audio_pages": [1, 3],
                }
            ),
            response(effect={"kind": "sync_cache"}, revision=8),
        )
        fake_item = SimpleNamespace()

        with (
            patch.object(
                internet_remote, "_fetch_catalog_item", return_value=fake_item
            ) as fetch,
            patch.object(internet_remote, "_append_catalog_item"),
        ):
            internet_remote.dispatch(context, "peer-one", "control", "wire")

        fetch.assert_called_once_with(
            "BV1ab411c7mD",
            selected_video_page=2,
            selected_audio_pages=[1, 3],
        )

    def test_failed_catalog_fetch_releases_the_rust_pending_reservation(self):
        context = FakeContext(
            response(
                effect={
                    "kind": "fetch_playlist_item",
                    "catalog_item_id": "BV1ab411c7mD",
                    "selected_video_page": None,
                    "selected_audio_pages": [],
                }
            )
        )

        with patch.object(
            internet_remote,
            "_fetch_catalog_item",
            side_effect=RuntimeError("binding required"),
        ):
            with self.assertRaisesRegex(RuntimeError, "binding required"):
                internet_remote.dispatch(context, "peer-one", "control", "wire")

        self.assertEqual(
            context.store.cancel_calls,
            [("peer-one", "123e4567-e89b-42d3-a456-426614174000")],
        )

    def test_stale_catalog_completion_never_appends_or_syncs(self):
        context = FakeContext(
            response(
                effect={
                    "kind": "fetch_playlist_item",
                    "catalog_item_id": "BV1ab411c7mD",
                }
            ),
            response(accepted=False, stale=True, revision=8),
        )
        fake_item = SimpleNamespace()

        with (
            patch.object(internet_remote, "_fetch_catalog_item", return_value=fake_item),
            patch.object(internet_remote, "_append_catalog_item") as append,
        ):
            result = internet_remote.dispatch(context, "peer-one", "control", "wire")

        self.assertFalse(result["accepted"])
        self.assertTrue(result["stale"])
        self.assertEqual(context.cache_manager.sync_count, 0)
        append.assert_not_called()

    def test_public_catalog_projection_drops_non_bilibili_cover(self):
        projected = internet_remote._public_catalog_item(
            {
                "bvid": "BV1ab411c7mD",
                "title": "Song",
                "owner_name": "Singer",
                "cover_url": "https://example.test/private.jpg",
            }
        )

        self.assertEqual(projected["catalog_item_id"], "BV1ab411c7mD")
        self.assertEqual(projected["cover_url"], "")

    def test_public_catalog_projection_normalizes_bilibili_covers_to_https(self):
        cases = {
            "http://i1.hdslb.com/bfs/archive/example.jpg": (
                "https://i1.hdslb.com/bfs/archive/example.jpg"
            ),
            "//i2.hdslb.com/bfs/archive/example.jpg": (
                "https://i2.hdslb.com/bfs/archive/example.jpg"
            ),
            "https://i0.hdslb.com/bfs/archive/example.jpg": (
                "https://i0.hdslb.com/bfs/archive/example.jpg"
            ),
        }
        for raw_url, expected in cases.items():
            with self.subTest(raw_url=raw_url):
                projected = internet_remote._public_catalog_item(
                    {
                        "bvid": "BV1ab411c7mD",
                        "title": "Song",
                        "cover_url": raw_url,
                    }
                )
                self.assertEqual(projected["cover_url"], expected)

    def test_public_catalog_projection_rejects_bilibili_lookalike_and_credentials(self):
        for raw_url in (
            "https://i1.hdslb.com.evil.test/image.jpg",
            "https://user@i1.hdslb.com/image.jpg",
            "https://i1.hdslb.com:8443/image.jpg",
        ):
            with self.subTest(raw_url=raw_url):
                projected = internet_remote._public_catalog_item(
                    {"bvid": "BV1ab411c7mD", "cover_url": raw_url}
                )
                self.assertEqual(projected["cover_url"], "")

    def test_catalog_browse_effect_projects_items_without_exposing_raw_fields(self):
        context = FakeContext(
            response(
                effect={
                    "kind": "catalog_browse",
                    "browse_kind": "name",
                    "letter": "A",
                    "query": "",
                    "tag": "",
                    "locale": "ja",
                    "limit": 100,
                }
            )
        )
        raw = {
            "kind": "name",
            "letter": "A",
            "tags": [],
            "items": [
                {
                    "bvid": "BV1ab411c7mD",
                    "title": "Song",
                    "cover_url": "http://i1.hdslb.com/song.jpg",
                    "local_path": "D:/secret/song.mp4",
                }
            ],
        }
        with (
            patch.object(internet_remote, "browse_d1_pool", return_value=raw),
            patch.object(
                internet_remote,
                "annotate_gatcha_local_status",
                side_effect=lambda items: items,
            ),
        ):
            result = internet_remote.dispatch(context, "peer-one", "bulk", "wire")

        self.assertEqual(
            result["data"]["items"][0]["cover_url"],
            "https://i1.hdslb.com/song.jpg",
        )
        self.assertNotIn("local_path", result["data"]["items"][0])

    def test_gatcha_pool_config_effect_updates_rust_repository_through_host_io(self):
        context = FakeContext(
            response(
                effect={
                    "kind": "gatcha_pool_config_set",
                    "uid_weight": 60,
                    "favlist_weight": 40,
                    "excluded_uids": ["123"],
                    "excluded_favlist_folders": ["123:456"],
                }
            )
        )
        detail = {
            "uid_weight": 60,
            "favlist_weight": 40,
            "excluded_uids": ["123"],
            "excluded_favlist_folders": ["123:456"],
            "uid_options": [],
            "favlist_folder_options": [],
        }
        with (
            patch.object(internet_remote, "update_gatcha_pool_config", return_value=detail) as update,
            patch.object(internet_remote, "gatcha_pool_config_detail", return_value=detail),
        ):
            result = internet_remote.dispatch(context, "peer-one", "control", "wire")

        self.assertEqual(result["data"]["uid_weight"], 60)
        self.assertEqual(context.notify_count, 1)
        update.assert_called_once_with(
            uid_weight=60,
            favlist_weight=40,
            excluded_uids=["123"],
            excluded_favlist_folders=["123:456"],
        )

    def test_catalog_id_never_accepts_a_url(self):
        with self.assertRaises(internet_remote.InternetRemoteDispatchError):
            internet_remote._catalog_parts(
                "https://www.bilibili.com/video/BV1ab411c7mD"
            )


if __name__ == "__main__":
    unittest.main()
