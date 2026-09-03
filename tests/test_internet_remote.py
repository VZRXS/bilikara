from __future__ import annotations

import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from bilikara import internet_remote


class FakeStore:
    def __init__(self, validation):
        self.lock = threading.RLock()
        self.validation = validation
        self.revision = int(validation.get("current_revision") or 1)
        self.users: set[str] = set()
        self.snapshot_value = {
            "revision": self.revision,
            "playback_generation": 3,
            "current_item": None,
            "playlist": [],
        }

    def validate_internet_remote_message(self, peer_id, lane, message):
        self.last_validation = (peer_id, lane, message)
        return dict(self.validation)

    def internet_remote_state(self):
        return {"remote_state": {"v": 1, "revision": self.revision}}

    def has_session_user(self, name):
        return name in self.users

    def snapshot(self):
        return dict(self.snapshot_value)


class FakeContext:
    def __init__(self, validation):
        self.store = FakeStore(validation)
        self.added = []

    def add_session_user(self, name):
        self.store.users.add(name)

    def add_item(self, item, *, position, requester_name, allow_repeat):
        self.added.append((item, position, requester_name, allow_repeat))


def validation(kind, body, *, name="Alice", revision=7):
    return {
        "peer_id": "peer-one",
        "request_id": "123e4567-e89b-42d3-a456-426614174000",
        "sequence": 1,
        "accepted": True,
        "stale_revision": False,
        "current_revision": revision,
        "session_name": name,
        "request": {"kind": kind, "body": body},
    }


class InternetRemoteAdapterTest(unittest.TestCase):
    def test_identity_is_added_only_after_rust_validation(self):
        context = FakeContext(validation("session.set_identity", {"name": "Alice"}))

        response = internet_remote.dispatch(context, "peer-one", "control", "wire")

        self.assertTrue(response["accepted"])
        self.assertEqual(context.store.users, {"Alice"})

    def test_catalog_add_rechecks_revision_after_network_fetch(self):
        context = FakeContext(
            validation(
                "playlist.add",
                {
                    "catalog_item_id": "BV1ab411c7mD",
                    "position": "next",
                    "allow_repeat": True,
                    "expected_revision": 7,
                },
            )
        )
        context.store.users.add("Alice")
        fake_item = SimpleNamespace()

        def fetch(_catalog_id):
            context.store.revision = 8
            return fake_item

        with patch.object(internet_remote, "_fetch_catalog_item", side_effect=fetch):
            response = internet_remote.dispatch(context, "peer-one", "control", "wire")

        self.assertFalse(response["accepted"])
        self.assertTrue(response["stale"])
        self.assertEqual(context.added, [])

    def test_catalog_add_forwards_validated_position_and_repeat_policy(self):
        context = FakeContext(
            validation(
                "playlist.add",
                {
                    "catalog_item_id": "BV1ab411c7mD",
                    "position": "next",
                    "allow_repeat": True,
                    "expected_revision": 7,
                },
            )
        )
        context.store.users.add("Alice")
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
            patch.object(internet_remote, "_append_catalog_item"),
        ):
            response = internet_remote.dispatch(context, "peer-one", "control", "wire")

        self.assertTrue(response["accepted"])
        self.assertEqual(context.added, [(fake_item, "next", "Alice", True)])

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
            internet_remote._catalog_parts("https://www.bilibili.com/video/BV1ab411c7mD")


if __name__ == "__main__":
    unittest.main()
