import json
import threading
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import bilikara.bilibili as bilibili_module
from bilikara.bilibili import (
    ManualBindingRequiredError,
    VideoPage,
    fetch_video_item,
    resolve_video_reference,
    select_matching_pages,
)
from bilikara.models import PlaylistItem
from bilikara.store import DEFAULT_SONG_ADVANCE_DELAY_SECONDS, PlaylistStore
from bilikara.title_cleanup import clean_display_title


class PlaylistStoreTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = TemporaryDirectory()
        temp_path = Path(self.temp_dir.name)
        self.state_file = temp_path / "state.json"
        self.backup_file = temp_path / "playlist_backup.json"
        self.session_archive_dir = temp_path / "played_sessions"
        self.store = PlaylistStore(
            state_file=self.state_file,
            backup_file=self.backup_file,
            session_archive_dir=self.session_archive_dir,
        )
        for user_name in ["A", "B", "C", "D"]:
            self.store.add_session_user(user_name)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_default_mode_is_local(self):
        self.assertEqual(self.store.playback_mode, "local")

    def test_av_offset_persists_in_player_state_file(self):
        self.store.set_av_offset_ms(230)

        restored_store = PlaylistStore(
            state_file=self.state_file,
            backup_file=self.backup_file,
            session_archive_dir=self.session_archive_dir,
        )

        self.assertEqual(self.store.snapshot()["player_settings"]["av_offset_ms"], 230)
        self.assertEqual(restored_store.av_offset_ms, 230)
        self.assertFalse(self.state_file.exists())
        self.assertTrue((self.state_file.parent / "player_state.json").exists())

    def test_volume_settings_persist_in_player_state_file(self):
        self.store.set_volume_percent(35)
        self.store.set_muted(True)

        restored_store = PlaylistStore(
            state_file=self.state_file,
            backup_file=self.backup_file,
            session_archive_dir=self.session_archive_dir,
        )

        snapshot = self.store.snapshot()["player_settings"]
        self.assertEqual(snapshot["volume_percent"], 35)
        self.assertTrue(snapshot["is_muted"])
        self.assertEqual(restored_store.volume_percent, 35)
        self.assertTrue(restored_store.is_muted)

    def test_song_advance_delay_persists_in_player_state_file(self):
        self.store.set_song_advance_delay_seconds(8)

        restored_store = PlaylistStore(
            state_file=self.state_file,
            backup_file=self.backup_file,
            session_archive_dir=self.session_archive_dir,
        )

        snapshot = self.store.snapshot()["player_settings"]
        self.assertEqual(snapshot["song_advance_delay_seconds"], 8)
        self.assertEqual(restored_store.song_advance_delay_seconds, 8)

    def test_reset_player_state_keeps_queue_and_runtime_data(self):
        self.store.set_mode("online")
        self.store.set_av_offset_ms(230)
        self.store.set_volume_percent(35)
        self.store.set_muted(True)
        self.store.set_song_advance_delay_seconds(8)
        self.add_item("a", requester_name="A")
        self.add_item("b", requester_name="B")
        self.mark_started("a")

        self.store.reset_player_state()

        snapshot = self.store.snapshot()
        self.assertEqual(snapshot["playback_mode"], "local")
        self.assertEqual(snapshot["player_settings"]["av_offset_ms"], 0)
        self.assertEqual(snapshot["player_settings"]["volume_percent"], 100)
        self.assertFalse(snapshot["player_settings"]["is_muted"])
        self.assertEqual(
            snapshot["player_settings"]["song_advance_delay_seconds"],
            DEFAULT_SONG_ADVANCE_DELAY_SECONDS,
        )
        self.assertEqual(snapshot["current_item"]["id"], "a")
        self.assertEqual([item["id"] for item in snapshot["playlist"]], ["b"])
        self.assertEqual(snapshot["session_users"], ["A", "B", "C", "D"])
        self.assertFalse(self.store.current_item_started)

    def test_legacy_state_file_is_ignored_and_removed(self):
        for name in ["player_state.json", "history.json", "session_users.json"]:
            (self.state_file.parent / name).unlink(missing_ok=True)
        legacy_payload = {
            "playback_mode": "online",
            "player_settings": {"av_offset_ms": 320, "volume_percent": 55, "is_muted": True},
            "history": [
                {
                    "key": "song-a",
                    "display_title": "legacy song",
                    "original_url": "https://www.bilibili.com/video/BV1xx411c7mD",
                    "resolved_url": "https://www.bilibili.com/video/BV1xx411c7mD",
                    "title": "legacy song",
                    "part_title": "P1",
                    "requested_at": 1,
                    "request_count": 2,
                    "requester_name": "A",
                }
            ],
            "session_users": ["A", "B"],
            "updated_at": 1,
        }
        self.state_file.write_text(
            json.dumps(legacy_payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

        restored_store = PlaylistStore(
            state_file=self.state_file,
            backup_file=self.backup_file,
            session_archive_dir=self.session_archive_dir,
        )

        self.assertEqual(restored_store.playback_mode, "local")
        self.assertEqual(restored_store.av_offset_ms, 0)
        self.assertEqual(restored_store.volume_percent, 100)
        self.assertFalse(restored_store.is_muted)
        self.assertEqual(restored_store.history, [])
        self.assertEqual(restored_store.session_users, [])
        self.assertFalse(self.state_file.exists())
        self.assertTrue((self.state_file.parent / "history.json").exists())
        self.assertTrue((self.state_file.parent / "session_users.json").exists())

    def make_item(self, item_id: str, *, song_key: str | None = None) -> PlaylistItem:
        key = song_key or item_id
        numeric = sum(ord(char) for char in key)
        return PlaylistItem(
            id=item_id,
            original_url="https://www.bilibili.com/video/BV1xx411c7mD",
            resolved_url="https://www.bilibili.com/video/BV1xx411c7mD?p=1",
            bvid=f"BV{key.upper():0<10}"[:12],
            aid=max(numeric, 1),
            cid=max(numeric + 10, 11),
            page=1,
            title=f"title-{item_id}",
            part_title="P1",
            display_title=f"title-{item_id} - P1",
            cover_url="",
            embed_url=f"https://player.bilibili.com/player.html?aid={max(numeric, 1)}",
        )

    def add_item(
        self,
        item_id: str,
        *,
        requester_name: str = "A",
        position: str = "tail",
        song_key: str | None = None,
    ) -> PlaylistItem:
        item = self.make_item(item_id, song_key=song_key)
        self.store.add_item(item, position=position, requester_name=requester_name)
        return item

    def mark_started(self, item_id: str) -> None:
        self.assertTrue(self.store.mark_item_playback_started(item_id))

    def test_add_tail_and_next(self):
        self.add_item("a", requester_name="A")
        self.add_item("b", requester_name="B")
        self.add_item("c", requester_name="C", position="next")
        self.assertEqual(self.store.current_item.id, "a")
        self.assertEqual([item.id for item in self.store.playlist], ["c", "b"])

    def test_move_to_next(self):
        self.add_item("a", requester_name="A")
        self.add_item("b", requester_name="B")
        self.add_item("c", requester_name="C")
        self.store.move_to_next("c")
        self.assertEqual(self.store.current_item.id, "a")
        self.assertEqual([item.id for item in self.store.playlist], ["c", "b"])

    def test_advance(self):
        self.add_item("a", requester_name="A")
        self.add_item("b", requester_name="B")
        self.store.advance_to_next()
        self.assertEqual(self.store.current_item.id, "b")
        self.assertEqual([item.id for item in self.store.playlist], [])

    def test_play_now_pops_from_playlist(self):
        self.add_item("a", requester_name="A")
        self.add_item("b", requester_name="B")
        self.add_item("c", requester_name="C")
        self.store.move_to_front("c")
        self.assertEqual(self.store.current_item.id, "c")
        self.assertEqual([item.id for item in self.store.playlist], ["b"])

    def test_move_item_to_index(self):
        self.add_item("a", requester_name="A")
        self.add_item("b", requester_name="B")
        self.add_item("c", requester_name="C")
        self.add_item("d", requester_name="D")
        self.assertTrue(self.store.move_item_to_index("d", 0))
        self.assertEqual([item.id for item in self.store.playlist], ["d", "b", "c"])

    def test_resort_playlist_resets_priority_and_manual_items_to_cycle_order(self):
        self.add_item("a1", requester_name="A")
        self.add_item("b1", requester_name="B")
        self.add_item("c1", requester_name="C")
        self.add_item("a2", requester_name="A")

        self.store.move_to_next("c1")
        self.store.move_item_to_index("a2", 0)
        self.assertEqual([item.queue_slot_type for item in self.store.playlist], ["manual", "priority", "cycle"])

        self.assertTrue(self.store.resort_playlist_by_cycle())

        self.assertEqual([item.id for item in self.store.playlist], ["b1", "c1", "a2"])
        self.assertEqual([item.queue_slot_type for item in self.store.playlist], ["cycle", "cycle", "cycle"])

    def test_clear_playlist_keeps_current(self):
        self.add_item("a", requester_name="A")
        self.add_item("b", requester_name="B")
        self.assertTrue(self.backup_file.exists())
        self.store.clear_playlist()
        self.assertEqual(self.store.current_item.id, "a")
        self.assertEqual(self.store.playlist, [])
        self.assertFalse(self.backup_file.exists())
        self.assertFalse(self.store.backup_summary()["available"])

    def test_snapshot_uses_cleaned_display_titles(self):
        item = self.make_item("a")
        item.title = "\u3010meta | noise\u3011Song Name"
        item.part_title = "on_vocal"
        item.display_title = f"{item.title} - {item.part_title}"
        self.store.add_item(item, requester_name="A")

        snapshot = self.store.snapshot()
        self.assertEqual(snapshot["current_item"]["display_title"], "Song Name")
        self.assertEqual(snapshot["current_item"]["requester_name"], "A")

        self.mark_started("a")
        self.store.advance_to_next()
        snapshot = self.store.snapshot()
        self.assertEqual(snapshot["history"][0]["display_title"], "Song Name")

    def test_history_stays_empty_until_current_item_has_started_playing(self):
        self.add_item("a", requester_name="A", song_key="song-a")
        self.add_item("b", requester_name="B", song_key="song-b")

        self.assertEqual(self.store.history, [])

        self.store.advance_to_next()

        self.assertEqual(self.store.history, [])

        self.mark_started("b")
        self.store.remove_item("b")

        self.assertEqual(len(self.store.history), 1)
        self.assertEqual(self.store.history[0].display_title, "title-b - P1")
        self.assertEqual(self.store.history[0].requester_name, "B")

    def test_history_records_started_song_when_advanced_to_next(self):
        self.add_item("a", requester_name="A", song_key="song-a")
        self.add_item("b", requester_name="B", song_key="song-b")
        self.mark_started("a")
        self.store.advance_to_next()

        self.assertEqual(len(self.store.history), 1)
        self.assertEqual(self.store.history[0].display_title, "title-a - P1")
        self.assertEqual(self.store.history[0].requester_name, "A")

    def test_history_updates_and_moves_latest_duplicate_to_top(self):
        self.add_item("a", requester_name="A", song_key="song-a")
        self.add_item("b", requester_name="B", song_key="song-b")
        self.add_item("c", requester_name="C", song_key="song-a")
        self.mark_started("a")
        self.store.advance_to_next()
        self.mark_started("b")
        self.store.move_to_front("c")
        self.mark_started("c")
        self.store.advance_to_next()
        self.assertEqual(len(self.store.history), 2)
        self.assertEqual(self.store.history[0].display_title, "title-c - P1")
        self.assertEqual(self.store.history[0].request_count, 2)
        self.assertEqual(self.store.history[1].display_title, "title-b - P1")
        self.assertEqual(self.store.history[0].requester_name, "C")
        self.assertTrue(hasattr(self.store.history[0], "owner_name"))

    def test_session_history_updates_for_duplicate_request_in_current_run(self):
        self.add_item("a", requester_name="A", song_key="song-a")
        self.add_item("b", requester_name="B", song_key="song-a")
        self.mark_started("a")
        self.store.move_to_front("b")
        self.mark_started("b")
        self.store.remove_item("b")
        self.assertEqual(len(self.store.session_history), 1)
        self.assertEqual(self.store.session_history[0].display_title, "title-b - P1")
        self.assertEqual(self.store.session_history[0].request_count, 2)
        self.assertEqual(self.store.session_history[0].requester_name, "B")

    def test_unstarted_removed_song_does_not_count_as_session_duplicate(self):
        self.add_item("a", requester_name="A", song_key="song-a")
        self.add_item("b", requester_name="B", song_key="song-b")

        self.store.advance_to_next()

        self.assertEqual(self.store.session_history, [])
        self.assertIsNone(self.store.session_request_for_item(self.make_item("retry", song_key="song-b")))

    def test_session_history_does_not_restore_from_state_file(self):
        self.add_item("a", requester_name="A", song_key="song-a")
        self.store.move_session_user_to_index("C", 1)
        restored_store = PlaylistStore(
            state_file=self.state_file,
            backup_file=self.backup_file,
            session_archive_dir=self.session_archive_dir,
        )
        self.assertEqual(restored_store.session_history, [])
        self.assertEqual(restored_store.session_users[:4], ["A", "C", "B", "D"])
        self.assertIsNone(restored_store.session_request_for_item(self.make_item("z", song_key="song-a")))

    def test_session_played_archive_tracks_items_that_become_current(self):
        self.add_item("a", requester_name="A", song_key="song-a")
        self.add_item("b", requester_name="B", song_key="song-b")

        payload = json.loads(self.store.session_played_file.read_text(encoding="utf-8"))
        self.assertRegex(self.store.session_played_file.name, r"^played-\d{4}-\d{2}-\d{2}_")
        self.assertEqual(self.store.session_played_file.parent, self.session_archive_dir)
        self.assertEqual([entry["item_id"] for entry in payload["items"]], ["a"])

        self.store.advance_to_next()
        payload = json.loads(self.store.session_played_file.read_text(encoding="utf-8"))
        self.assertEqual([entry["item_id"] for entry in payload["items"]], ["a", "b"])
        self.assertEqual(payload["items"][1]["display_title"], "title-b - P1")
        self.assertEqual(payload["items"][1]["requester_name"], "B")

    def test_session_played_archive_does_not_restore_into_new_run(self):
        self.add_item("a", requester_name="A", song_key="song-a")

        restored_store = PlaylistStore(
            state_file=self.state_file,
            backup_file=self.backup_file,
            session_archive_dir=self.session_archive_dir,
        )

        self.assertEqual(restored_store.session_played, [])

    def test_active_duplicate_for_item_matches_current_or_playlist(self):
        first = self.make_item("a", song_key="song-a")
        second = self.make_item("b", song_key="song-b")
        duplicate = self.make_item("c", song_key="song-a")
        self.store.add_item(first, requester_name="A")
        self.store.add_item(second, requester_name="B")
        found = self.store.active_duplicate_for_item(duplicate)
        self.assertIsNotNone(found)
        self.assertEqual(found.id, "a")

    def test_missing_owner_urls_collects_entries_without_owner_name(self):
        item = self.make_item("a", song_key="song-a")
        item.owner_name = ""
        self.store.add_item(item, requester_name="A")
        self.assertEqual(self.store.missing_owner_urls(), [item.resolved_url])

    def test_update_owner_info_for_url_updates_playlist_and_history(self):
        item = self.make_item("a", song_key="song-a")
        item.owner_name = ""
        item.owner_mid = 0
        item.owner_url = ""
        self.store.add_item(item, requester_name="A")
        self.store.add_item(self.make_item("b", song_key="song-b"), requester_name="B")
        self.mark_started("a")
        self.store.advance_to_next()

        changed = self.store.update_owner_info_for_url(
            item.resolved_url,
            owner_mid=114514,
            owner_name="example-up",
            owner_url="https://space.bilibili.com/114514",
        )

        self.assertTrue(changed)
        self.assertEqual(self.store.current_item.owner_name, "example-up")
        self.assertEqual(self.store.history[0].owner_name, "example-up")

    def test_set_audio_variant_accepts_predicted_part_before_cache_ready(self):
        item = self.make_item("a", song_key="song-a")
        item.selected_pages = [1, 2]
        item.selected_parts = ["on vocal", "off vocal"]
        item.available_pages = [1, 2]
        item.available_parts = ["on vocal", "off vocal"]
        self.store.add_item(item, requester_name="A")

        changed = self.store.set_audio_variant("a", "p2_off_vocal")

        self.assertTrue(changed)
        self.assertEqual(self.store.current_item.selected_audio_variant_id, "p2_off_vocal")

    def test_history_restores_from_history_state_file(self):
        self.add_item("a", requester_name="A", song_key="song-a")
        self.mark_started("a")
        self.store.advance_to_next()
        restored_store = PlaylistStore(
            state_file=self.state_file,
            backup_file=self.backup_file,
            session_archive_dir=self.session_archive_dir,
        )
        self.assertEqual(len(restored_store.history), 1)
        self.assertEqual(restored_store.history[0].display_title, "title-a - P1")
        self.assertEqual(restored_store.history[0].request_count, 1)
        self.assertEqual(restored_store.history[0].requester_name, "A")

    def test_clear_history_removes_persisted_entries(self):
        self.add_item("a", requester_name="A", song_key="song-a")
        self.mark_started("a")
        self.store.advance_to_next()
        self.assertEqual(len(self.store.history), 1)

        self.store.clear_history()

        self.assertEqual(self.store.history, [])
        restored_store = PlaylistStore(
            state_file=self.state_file,
            backup_file=self.backup_file,
            session_archive_dir=self.session_archive_dir,
        )
        self.assertEqual(restored_store.history, [])

    def test_restore_from_backup(self):
        item = self.make_item("a")
        item.cache_status = "ready"
        item.cache_progress = 100.0
        item.cache_message = "cached"
        item.video_relative_path = "a/video-only.m4s"
        item.video_media_url = "/media/a/video-only.m4s"
        self.store.move_session_user_to_index("D", 1)
        self.store.add_item(item, requester_name="A")
        self.store.set_mode("local")
        self.store.set_av_offset_ms(180)
        self.store.set_volume_percent(42)
        self.store.set_muted(True)

        backup_payload = json.loads(self.backup_file.read_text(encoding="utf-8"))
        backup_payload["current_item"]["local_relative_path"] = "legacy/video.mp4"
        backup_payload["current_item"]["local_media_url"] = "/media/legacy/video.mp4"
        self.backup_file.write_text(
            json.dumps(backup_payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

        restored_store = PlaylistStore(
            state_file=self.state_file,
            backup_file=self.backup_file,
            session_archive_dir=self.session_archive_dir,
        )
        self.assertEqual(restored_store.playlist, [])
        self.assertTrue(restored_store.backup_summary()["available"])
        self.assertTrue(restored_store.restore_backup())
        self.assertEqual(restored_store.playback_mode, "local")
        self.assertEqual(restored_store.av_offset_ms, 180)
        self.assertEqual(restored_store.volume_percent, 42)
        self.assertTrue(restored_store.is_muted)
        self.assertEqual(restored_store.current_item.id, "a")
        self.assertEqual([entry.id for entry in restored_store.playlist], [])
        restored_item = restored_store.current_item
        self.assertEqual(restored_item.cache_status, "pending")
        self.assertFalse(hasattr(restored_item, "local_relative_path"))
        self.assertFalse(hasattr(restored_item, "local_media_url"))
        self.assertEqual(restored_item.video_relative_path, "")
        self.assertEqual(restored_item.video_media_url, "")
        self.assertEqual(restored_item.requester_name, "A")
        self.assertEqual(restored_store.session_users[:4], ["A", "D", "B", "C"])

    def test_discard_backup(self):
        self.add_item("a", requester_name="A")
        self.assertTrue(self.backup_file.exists())
        self.assertTrue(self.store.discard_backup())
        self.assertFalse(self.store.backup_summary()["available"])
        self.assertIsNone(self.store.current_item)
        self.assertEqual(self.store.playlist, [])

    def test_reset_runtime_data_keeps_gatcha_cache_and_played_sessions(self):
        self.store.set_mode("online")
        self.add_item("a", requester_name="A")
        self.assertTrue(self.backup_file.exists())
        gatcha_file = self.state_file.parent / "gatcha_cache.json"
        gatcha_file.write_text("{}", encoding="utf-8")
        gatcha_uid_file = self.state_file.parent / "gatcha_uids.json"
        gatcha_uid_file.write_text("{}", encoding="utf-8")
        played_file = self.session_archive_dir / "played-keep.json"
        played_file.parent.mkdir(parents=True, exist_ok=True)
        played_file.write_text("{}", encoding="utf-8")

        self.store.reset_runtime_data()

        self.assertTrue(gatcha_file.exists())
        self.assertTrue(gatcha_uid_file.exists())
        self.assertTrue(played_file.exists())
        self.assertFalse(self.backup_file.exists())
        self.assertEqual(self.store.playback_mode, "local")
        self.assertEqual(self.store.history, [])
        self.assertEqual(self.store.session_users, [])

    def test_add_requires_existing_session_user_selection(self):
        isolated_store = PlaylistStore(
            state_file=self.state_file.parent / "isolated-state.json",
            backup_file=self.state_file.parent / "isolated-backup.json",
            session_archive_dir=self.session_archive_dir,
        )
        with self.assertRaises(ValueError):
            isolated_store.add_item(self.make_item("solo"), requester_name="A")

    def test_tail_queue_cycles_by_session_user_order(self):
        self.store.move_session_user_to_index("C", 1)
        self.add_item("a1", requester_name="A")
        self.add_item("a2", requester_name="A")
        self.add_item("b1", requester_name="B")
        self.add_item("c1", requester_name="C")
        self.assertEqual([item.id for item in self.store.playlist], ["c1", "b1", "a2"])

    def test_reordering_session_users_rebuilds_cycle_queue(self):
        self.add_item("a1", requester_name="A")
        self.add_item("a2", requester_name="A")
        self.add_item("b1", requester_name="B")
        self.add_item("c1", requester_name="C")
        self.assertEqual([item.id for item in self.store.playlist], ["b1", "c1", "a2"])

        self.store.move_session_user_to_index("C", 1)
        self.assertEqual(self.store.session_users[:3], ["A", "C", "B"])
        self.assertEqual([item.id for item in self.store.playlist], ["c1", "b1", "a2"])

    def test_play_now_rebuilds_cycle_queue_for_new_current_requester(self):
        self.add_item("a1", requester_name="A")
        self.add_item("b1", requester_name="B")
        self.add_item("c1", requester_name="C")
        self.add_item("a2", requester_name="A")
        self.assertEqual([item.id for item in self.store.playlist], ["b1", "c1", "a2"])

        self.store.move_to_front("c1")

        self.assertEqual(self.store.current_item.id, "c1")
        self.assertEqual([item.id for item in self.store.playlist], ["a2", "b1"])

    def test_advance_to_priority_item_rebuilds_cycle_queue(self):
        self.add_item("a1", requester_name="A")
        self.add_item("b1", requester_name="B")
        self.add_item("c1", requester_name="C")
        self.add_item("a2", requester_name="A")
        self.store.move_to_next("c1")

        self.store.advance_to_next()

        self.assertEqual(self.store.current_item.id, "c1")
        self.assertEqual([item.id for item in self.store.playlist], ["a2", "b1"])

    def test_reordering_session_users_keeps_priority_next_and_rebuilds_cycle_tail(self):
        self.add_item("a1", requester_name="A")
        self.add_item("b1", requester_name="B")
        self.add_item("c1", requester_name="C")
        self.add_item("a2", requester_name="A")
        self.add_item("b2", requester_name="B")
        self.assertEqual([item.id for item in self.store.playlist], ["b1", "c1", "a2", "b2"])

        self.store.move_to_next("b2")
        self.assertEqual([item.id for item in self.store.playlist], ["b2", "b1", "c1", "a2"])

        self.store.move_session_user_to_index("C", 1)

        self.assertEqual(self.store.session_users[:3], ["A", "C", "B"])
        self.assertEqual([item.id for item in self.store.playlist], ["b2", "c1", "b1", "a2"])
        self.assertEqual(self.store.playlist[0].queue_slot_type, "priority")

    def test_priority_section_is_independent_from_cycle_queue(self):
        self.add_item("a1", requester_name="A")
        self.add_item("b1", requester_name="B")
        self.add_item("c1", requester_name="C")
        self.add_item("a2", requester_name="A")
        self.add_item("b2", requester_name="B")
        self.add_item("c2", requester_name="C")
        self.assertEqual([item.id for item in self.store.playlist], ["b1", "c1", "a2", "b2", "c2"])

        self.add_item("c-priority", requester_name="C", position="next")
        self.assertEqual(
            [item.id for item in self.store.playlist],
            ["c-priority", "b1", "c1", "a2", "b2", "c2"],
        )

        self.add_item("b-priority", requester_name="B", position="next")
        self.assertEqual(
            [item.id for item in self.store.playlist],
            ["b-priority", "c-priority", "b1", "c1", "a2", "b2", "c2"],
        )
        self.assertEqual(
            [item.queue_slot_type for item in self.store.playlist[:2]],
            ["priority", "priority"],
        )

    def test_current_item_does_not_consume_waiting_queue_turn(self):
        self.store = PlaylistStore(
            state_file=self.state_file.parent / "current-state.json",
            backup_file=self.state_file.parent / "current-backup.json",
            session_archive_dir=self.session_archive_dir,
        )
        for user_name in ["凛夜", "kevin", "VZRXS"]:
            self.store.add_session_user(user_name)

        current = self.make_item("current")
        self.store.add_item(current, requester_name="VZRXS")
        self.store.add_item(self.make_item("a1"), requester_name="凛夜")
        self.store.add_item(self.make_item("b1"), requester_name="kevin")
        self.store.add_item(self.make_item("c1"), requester_name="VZRXS")

        self.assertEqual(
            [(item.id, item.requester_name) for item in self.store.playlist],
            [("a1", "凛夜"), ("b1", "kevin"), ("c1", "VZRXS")],
        )


class BilibiliParserTest(unittest.TestCase):
    def test_clean_display_title_removes_brackets_and_part_suffix(self):
        cleaned = clean_display_title(
            title="\u3010pure k | nico karaoke | troupe\u3011Song Name",
            display_title="\u3010pure k | nico karaoke | troupe\u3011Song Name - on_vocal",
            part_title="on_vocal",
        )
        self.assertEqual(cleaned, "Song Name")

    def test_resolve_bv_input(self):
        reference = resolve_video_reference("BV1xx411c7mD")
        self.assertEqual(reference.bvid, "BV1xx411c7mD")
        self.assertEqual(reference.page, 1)

    def test_resolve_bv_url_keeps_case(self):
        reference = resolve_video_reference("https://www.bilibili.com/video/BV1WvfWBXExJ/")
        self.assertEqual(reference.bvid, "BV1WvfWBXExJ")

    def test_select_matching_pages_filters_duration_outlier(self):
        pages = [
            VideoPage(page=1, cid=101, duration=25, part="preview"),
            VideoPage(page=2, cid=102, duration=301, part="on vocal"),
            VideoPage(page=3, cid=103, duration=303, part="off vocal"),
            VideoPage(page=4, cid=104, duration=302, part="duet"),
        ]
        selected = select_matching_pages(pages, preferred_page=1)
        self.assertEqual([page.page for page in selected], [2, 3, 4])

    def test_select_matching_pages_prefers_longer_duration_when_no_cluster(self):
        pages = [
            VideoPage(page=1, cid=101, duration=120, part="P1"),
            VideoPage(page=2, cid=102, duration=220, part="P2"),
            VideoPage(page=3, cid=103, duration=330, part="P3"),
        ]
        selected = select_matching_pages(pages, preferred_page=2)
        self.assertEqual([page.page for page in selected], [3])

    def test_effective_cookie_prefers_bbdown_data(self):
        with TemporaryDirectory() as temp_dir:
            bbdown_dir = Path(temp_dir)
            (bbdown_dir / "BBDown.data").write_text(
                json.dumps(
                    {
                        "cookie_info": {
                            "cookies": [
                                {"name": "bili_jct", "value": "jct-from-bbdown"},
                                {"name": "SESSDATA", "value": "sess-from-bbdown"},
                                {"name": "DedeUserID", "value": "42"},
                            ]
                        }
                    }
                ),
                encoding="utf-8",
            )

            with (
                patch.object(bilibili_module.cfg, "BB_DOWN_DIR", bbdown_dir),
                patch.object(bilibili_module.cfg, "COOKIE", "SESSDATA=manual; bili_jct=manual"),
            ):
                self.assertEqual(
                    bilibili_module.effective_bilibili_cookie(),
                    "SESSDATA=sess-from-bbdown; bili_jct=jct-from-bbdown; DedeUserID=42",
                )

    def test_effective_cookie_falls_back_to_manual_cookie(self):
        with TemporaryDirectory() as temp_dir:
            with (
                patch.object(bilibili_module.cfg, "BB_DOWN_DIR", Path(temp_dir)),
                patch.object(bilibili_module.cfg, "COOKIE", "SESSDATA=manual; bili_jct=manual"),
            ):
                self.assertEqual(
                    bilibili_module.effective_bilibili_cookie(),
                    "SESSDATA=manual; bili_jct=manual",
                )

    def test_gatcha_missing_cookie_message_when_cache_empty(self):
        with (
            patch.object(bilibili_module, "_local_gatcha_candidates_by_uid", return_value={}),
            patch.object(bilibili_module, "effective_bilibili_cookie", return_value=""),
        ):
            with self.assertRaisesRegex(
                bilibili_module.BilibiliError,
                bilibili_module.MISSING_BILIBILI_COOKIE_MESSAGE,
            ):
                bilibili_module.fetch_gatcha_candidate()

    def test_gatcha_uid_snapshot_creates_default_uid_file(self):
        with TemporaryDirectory() as temp_dir:
            data_dir = Path(temp_dir)
            uid_file = data_dir / "gatcha_uids.json"

            with (
                patch.object(bilibili_module.cfg, "DATA_DIR", data_dir),
                patch.object(bilibili_module.cfg, "GATCHA_UIDS", ["1", "2", "1"]),
                patch.object(bilibili_module, "_GATCHA_UIDS_FILE", uid_file),
            ):
                snapshot = bilibili_module.gatcha_uid_snapshot()

            self.assertEqual(snapshot["uids"], ["1", "2"])
            self.assertEqual(json.loads(uid_file.read_text(encoding="utf-8"))["uids"], ["1", "2"])

    def test_gatcha_uid_rejects_video_ids_instead_of_guessing_digits(self):
        with self.assertRaisesRegex(bilibili_module.BilibiliError, "不要输入 BV/av 视频号"):
            bilibili_module._normalize_gatcha_uid("BV1xx411c7mD")

        with self.assertRaisesRegex(bilibili_module.BilibiliError, "不要输入 BV/av 视频号"):
            bilibili_module._normalize_gatcha_uid("https://www.bilibili.com/video/BV1xx411c7mD")

    def test_preview_gatcha_uid_fetches_owner_and_cache_mode(self):
        with TemporaryDirectory() as temp_dir:
            data_dir = Path(temp_dir)
            uid_file = data_dir / "gatcha_uids.json"
            cache_file = data_dir / "gatcha_cache.json"
            uid_file.write_text(json.dumps({"uids": ["42"]}), encoding="utf-8")
            cache_file.write_text(
                json.dumps(
                    {
                        "uids": {
                            "42": [
                                {
                                    "mid": "42",
                                    "bvid": "BVOLD",
                                    "title": "old karaoke",
                                    "url": "https://www.bilibili.com/video/BVOLD",
                                }
                            ]
                        },
                        "updated_at": 1,
                    }
                ),
                encoding="utf-8",
            )

            with (
                patch.object(bilibili_module.cfg, "DATA_DIR", data_dir),
                patch.object(bilibili_module, "_GATCHA_UIDS_FILE", uid_file),
                patch.object(bilibili_module, "_GATCHA_CACHE_FILE", cache_file),
                patch.object(bilibili_module, "effective_bilibili_cookie", return_value="cookie"),
                patch.object(
                    bilibili_module,
                    "_request_gatcha_uid_profile",
                    return_value={
                        "uid": "42",
                        "name": "example-up",
                        "space_url": "https://space.bilibili.com/42",
                    },
                ),
            ):
                preview = bilibili_module.preview_gatcha_uid("https://space.bilibili.com/42")

            self.assertEqual(preview["uid"], "42")
            self.assertEqual(preview["name"], "example-up")
            self.assertTrue(preview["already_followed"])
            self.assertEqual(preview["cache_mode"], "incremental")
            self.assertEqual(preview["cache_mode_label"], "最新")

    def test_refresh_gatcha_cache_incremental_for_existing_and_full_for_missing_uid(self):
        with TemporaryDirectory() as temp_dir:
            data_dir = Path(temp_dir)
            uid_file = data_dir / "gatcha_uids.json"
            cache_file = data_dir / "gatcha_cache.json"
            uid_file.write_text(json.dumps({"uids": ["1", "2"]}), encoding="utf-8")
            cache_file.write_text(
                json.dumps(
                    {
                        "uids": {
                            "1": [
                                {
                                    "mid": "1",
                                    "bvid": "BVOLD",
                                    "title": "old karaoke",
                                    "url": "https://www.bilibili.com/video/BVOLD",
                                }
                            ]
                        },
                        "updated_at": 1,
                    }
                ),
                encoding="utf-8",
            )
            calls: list[tuple[str, object, bool]] = []

            def fake_fetch(mid, *, on_progress=None, max_pages=None):
                calls.append((mid, max_pages, on_progress is not None))
                if mid == "1":
                    return [
                        {
                            "mid": "1",
                            "bvid": "BVNEW",
                            "title": "new karaoke",
                            "url": "https://www.bilibili.com/video/BVNEW",
                        },
                        {
                            "mid": "1",
                            "bvid": "BVOLD",
                            "title": "old karaoke",
                            "url": "https://www.bilibili.com/video/BVOLD",
                        },
                    ]
                entries = [
                    {
                        "mid": "2",
                        "bvid": "BV2A",
                        "title": "first karaoke",
                        "url": "https://www.bilibili.com/video/BV2A",
                    },
                    {
                        "mid": "2",
                        "bvid": "BV2B",
                        "title": "second karaoke",
                        "url": "https://www.bilibili.com/video/BV2B",
                    },
                ]
                if on_progress is not None:
                    on_progress(entries[:1])
                return entries

            with (
                patch.object(bilibili_module.cfg, "DATA_DIR", data_dir),
                patch.object(bilibili_module, "_GATCHA_UIDS_FILE", uid_file),
                patch.object(bilibili_module, "_GATCHA_CACHE_FILE", cache_file),
                patch.object(bilibili_module, "_GATCHA_REFRESH_LOCK", threading.Lock()),
                patch.object(bilibili_module, "effective_bilibili_cookie", return_value="cookie"),
                patch.object(bilibili_module, "_fetch_gatcha_videos_for_uid", side_effect=fake_fetch),
            ):
                bilibili_module.refresh_gatcha_cache()

            self.assertEqual(calls, [("1", 1, False), ("2", None, True)])
            cache_payload = json.loads(cache_file.read_text(encoding="utf-8"))
            self.assertEqual([entry["bvid"] for entry in cache_payload["uids"]["1"]], ["BVNEW", "BVOLD"])
            self.assertEqual([entry["bvid"] for entry in cache_payload["uids"]["2"]], ["BV2A", "BV2B"])

    def test_add_gatcha_uid_persists_uid_and_refreshes_added_uid(self):
        with TemporaryDirectory() as temp_dir:
            data_dir = Path(temp_dir)
            uid_file = data_dir / "gatcha_uids.json"
            cache_file = data_dir / "gatcha_cache.json"
            uid_file.write_text(json.dumps({"uids": ["1"]}), encoding="utf-8")
            calls: list[str] = []

            def fake_fetch(mid, *, on_progress=None, max_pages=None):
                calls.append(mid)
                entries = [
                    {
                        "mid": mid,
                        "bvid": "BVADDED42",
                        "title": "added test karaoke",
                        "url": "https://www.bilibili.com/video/BVADDED42",
                    }
                ]
                if on_progress is not None:
                    on_progress(entries)
                return entries

            with (
                patch.object(bilibili_module.cfg, "DATA_DIR", data_dir),
                patch.object(bilibili_module, "_GATCHA_UIDS_FILE", uid_file),
                patch.object(bilibili_module, "_GATCHA_CACHE_FILE", cache_file),
                patch.object(bilibili_module, "_GATCHA_REFRESH_LOCK", threading.Lock()),
                patch.object(bilibili_module, "effective_bilibili_cookie", return_value="cookie"),
                patch.object(
                    bilibili_module,
                    "_request_gatcha_uid_profile",
                    return_value={
                        "uid": "42",
                        "name": "example-up",
                        "space_url": "https://space.bilibili.com/42",
                    },
                ),
                patch.object(bilibili_module, "_fetch_gatcha_videos_for_uid", side_effect=fake_fetch),
            ):
                result = bilibili_module.add_gatcha_uid("https://space.bilibili.com/42")

            self.assertTrue(result["added"])
            self.assertEqual(result["uid"], "42")
            self.assertIn("42", calls)
            self.assertEqual(calls.count("42"), 1)
            self.assertEqual(json.loads(uid_file.read_text(encoding="utf-8"))["uids"], ["1", "42"])
            cache_payload = json.loads(cache_file.read_text(encoding="utf-8"))
            self.assertEqual(cache_payload["uids"]["42"][0]["bvid"], "BVADDED42")

    @patch("bilikara.bilibili.request_json")
    def test_fetch_video_item(self, mock_request_json):
        mock_request_json.return_value = {
            "code": 0,
            "data": {
                "aid": 123,
                "bvid": "BV1xx411c7mD",
                "title": "example video",
                "pic": "https://example.com/cover.jpg",
                "owner": {
                    "mid": 114514,
                    "name": "example-up",
                },
                "pages": [
                    {"cid": 456, "page": 1, "part": "on_vocal"},
                    {"cid": 789, "page": 2, "part": "off_vocal"},
                ],
            },
        }
        item = fetch_video_item("https://www.bilibili.com/video/BV1xx411c7mD?p=2")
        self.assertEqual(item.page, 2)
        self.assertEqual(item.cid, 789)
        self.assertEqual(item.video_page, 2)
        self.assertEqual(item.selected_pages, [1, 2])
        self.assertEqual(item.selected_cids, [456, 789])
        self.assertEqual(item.display_title, "example video - off_vocal")
        self.assertEqual(item.owner_mid, 114514)
        self.assertEqual(item.owner_name, "example-up")
        self.assertEqual(item.owner_url, "https://space.bilibili.com/114514")
        self.assertEqual(item.selected_audio_variant_id, "p2_off_vocal")
        self.assertEqual(item.available_pages, [1, 2])
        self.assertEqual(item.available_parts, ["on_vocal", "off_vocal"])

    @patch("bilikara.bilibili.request_json")
    def test_fetch_video_item_keeps_both_keyword_matched_pages_when_durations_differ(self, mock_request_json):
        mock_request_json.return_value = {
            "code": 0,
            "data": {
                "aid": 123,
                "bvid": "BV1xx411c7mD",
                "title": "example video",
                "pic": "https://example.com/cover.jpg",
                "owner": {
                    "mid": 114514,
                    "name": "example-up",
                },
                "pages": [
                    {"cid": 456, "page": 1, "part": "on vocal", "duration": 300},
                    {"cid": 789, "page": 2, "part": "off vocal", "duration": 309},
                ],
            },
        }

        item = fetch_video_item("https://www.bilibili.com/video/BV1xx411c7mD?p=2")

        self.assertFalse(item.manual_selection)
        self.assertEqual(item.video_page, 2)
        self.assertEqual(item.selected_pages, [1, 2])
        self.assertEqual(item.selected_durations, [300, 309])
        self.assertEqual(item.selected_audio_variant_id, "p2_off_vocal")

    @patch("bilikara.bilibili.request_json")
    def test_fetch_video_item_requires_manual_binding_for_ambiguous_multipart_video(self, mock_request_json):
        mock_request_json.return_value = {
            "code": 0,
            "data": {
                "aid": 123,
                "bvid": "BV1xx411c7mD",
                "title": "example video",
                "pic": "https://example.com/cover.jpg",
                "owner": {"mid": 1, "name": "up"},
                "pages": [
                    {"cid": 456, "page": 1, "part": "P1 main"},
                    {"cid": 789, "page": 2, "part": "P2 alt"},
                    {"cid": 999, "page": 3, "part": "P3 chorus"},
                ],
            },
        }

        with self.assertRaises(ManualBindingRequiredError) as raised:
            fetch_video_item("https://www.bilibili.com/video/BV1xx411c7mD?p=2")

        self.assertEqual(raised.exception.preferred_page, 2)
        self.assertEqual([page.page for page in raised.exception.pages], [1, 2, 3])

    @patch("bilikara.bilibili.request_json")
    def test_fetch_video_item_accepts_manual_binding_selection(self, mock_request_json):
        mock_request_json.return_value = {
            "code": 0,
            "data": {
                "aid": 123,
                "bvid": "BV1xx411c7mD",
                "title": "example video",
                "pic": "https://example.com/cover.jpg",
                "owner": {"mid": 1, "name": "up"},
                "pages": [
                    {"cid": 456, "page": 1, "part": "P1 main"},
                    {"cid": 789, "page": 2, "part": "P2 alt"},
                    {"cid": 999, "page": 3, "part": "P3 chorus"},
                ],
            },
        }

        item = fetch_video_item(
            "https://www.bilibili.com/video/BV1xx411c7mD?p=2",
            selected_video_page=2,
            selected_audio_pages=[1, 3],
        )

        self.assertTrue(item.manual_selection)
        self.assertEqual(item.page, 2)
        self.assertEqual(item.video_page, 2)
        self.assertEqual(item.selected_pages, [1, 3])
        self.assertEqual(item.selected_parts, ["P1 main", "P3 chorus"])
        self.assertEqual(item.available_pages, [1, 2, 3])
        self.assertEqual(item.selected_audio_variant_id, "p1_p1_main")

    def test_fetch_gatcha_videos_for_uid_retries_once_on_412(self):
        if not hasattr(bilibili_module, "_fetch_gatcha_videos_for_uid"):
            self.skipTest("gatcha fetch is not available on this branch")

        with (
            patch("bilikara.bilibili.time.sleep") as mock_sleep,
            patch("bilikara.bilibili.time.monotonic") as mock_monotonic,
            patch("bilikara.bilibili.request_json") as mock_request_json,
            patch("bilikara.bilibili.get_cached_wbi_keys") as mock_get_cached_wbi_keys,
        ):
            mock_get_cached_wbi_keys.return_value = ("a" * 32, "b" * 32)
            mock_monotonic.side_effect = [100.0, 100.0, 103.5, 103.5]
            mock_request_json.side_effect = [
                {"code": 412, "message": "412 Precondition Failed"},
                {
                    "code": 0,
                    "data": {
                        "list": {
                            "vlist": [
                                {"bvid": "BV1xx411c7mD", "title": "karaoke sample"},
                                {"bvid": "BV1yy411c7mD", "title": "other sample"},
                            ]
                        }
                    },
                },
            ]

            with (
                patch.object(bilibili_module, "GATCHA_KEYWORDS", ["karaoke"], create=True),
                patch.object(bilibili_module, "_GATCHA_LAST_REQUEST_AT", 0.0, create=True),
            ):
                entries = bilibili_module._fetch_gatcha_videos_for_uid("123")

        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["bvid"], "BV1xx411c7mD")
        mock_sleep.assert_any_call(bilibili_module.GATCHA_RETRY_DELAY_SECONDS)


if __name__ == "__main__":
    unittest.main()
