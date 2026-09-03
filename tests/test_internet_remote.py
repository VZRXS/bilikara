from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import patch

from bilikara import internet_remote


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

    def issue_player_control(self, **fields):
        self.player_controls.append(fields)


class InternetRemoteAdapterTest(unittest.TestCase):
    def test_dispatch_passes_wire_message_to_the_rust_owned_module(self):
        context = FakeContext(response())

        result = internet_remote.dispatch(context, "peer-one", "control", "wire")

        self.assertTrue(result["accepted"])
        self.assertEqual(
            context.store.dispatch_calls,
            [("peer-one", "control", "wire", True)],
        )

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

    def test_catalog_id_never_accepts_a_url(self):
        with self.assertRaises(internet_remote.InternetRemoteDispatchError):
            internet_remote._catalog_parts(
                "https://www.bilibili.com/video/BV1ab411c7mD"
            )


if __name__ == "__main__":
    unittest.main()
