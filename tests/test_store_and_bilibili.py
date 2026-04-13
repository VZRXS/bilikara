import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from bilikara.bilibili import VideoPage, fetch_video_item, resolve_video_reference, select_matching_pages
from bilikara.models import PlaylistItem
from bilikara.store import PlaylistStore
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

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_default_mode_is_local(self):
        self.assertEqual(self.store.playback_mode, "local")

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

    def test_add_tail_and_next(self):
        a = self.make_item("a")
        b = self.make_item("b")
        c = self.make_item("c")
        self.store.add_item(a, position="tail")
        self.store.add_item(b, position="tail")
        self.store.add_item(c, position="next")
        self.assertEqual(self.store.current_item.id, "a")
        self.assertEqual([item.id for item in self.store.playlist], ["c", "b"])

    def test_move_to_next(self):
        a = self.make_item("a")
        b = self.make_item("b")
        c = self.make_item("c")
        self.store.add_item(a)
        self.store.add_item(b)
        self.store.add_item(c)
        self.store.move_to_next("c")
        self.assertEqual(self.store.current_item.id, "a")
        self.assertEqual([item.id for item in self.store.playlist], ["c", "b"])

    def test_advance(self):
        self.store.add_item(self.make_item("a"))
        self.store.add_item(self.make_item("b"))
        self.store.advance_to_next()
        self.assertEqual(self.store.current_item.id, "b")
        self.assertEqual([item.id for item in self.store.playlist], [])

    def test_play_now_pops_from_playlist(self):
        self.store.add_item(self.make_item("a"))
        self.store.add_item(self.make_item("b"))
        self.store.add_item(self.make_item("c"))
        self.store.move_to_front("c")
        self.assertEqual(self.store.current_item.id, "c")
        self.assertEqual([item.id for item in self.store.playlist], ["b"])

    def test_move_item_to_index(self):
        self.store.add_item(self.make_item("a"))
        self.store.add_item(self.make_item("b"))
        self.store.add_item(self.make_item("c"))
        self.store.add_item(self.make_item("d"))
        self.assertTrue(self.store.move_item_to_index("d", 0))
        self.assertEqual([item.id for item in self.store.playlist], ["d", "b", "c"])

    def test_clear_playlist_keeps_current(self):
        self.store.add_item(self.make_item("a"))
        self.store.add_item(self.make_item("b"))
        self.store.clear_playlist()
        self.assertEqual(self.store.current_item.id, "a")
        self.assertEqual(self.store.playlist, [])

    def test_snapshot_uses_cleaned_display_titles(self):
        item = self.make_item("a")
        item.title = "【纯k投屏 | ニコカラ | 少女歌剧】星のダイアローグ"
        item.part_title = "on_vocal"
        item.display_title = f"{item.title} - {item.part_title}"
        self.store.add_item(item)

        snapshot = self.store.snapshot()
        self.assertEqual(snapshot["current_item"]["display_title"], "星のダイアローグ")
        self.assertEqual(snapshot["history"][0]["display_title"], "星のダイアローグ")

    def test_history_updates_and_moves_latest_duplicate_to_top(self):
        self.store.add_item(self.make_item("a", song_key="song-a"))
        self.store.add_item(self.make_item("b", song_key="song-b"))
        self.store.add_item(self.make_item("c", song_key="song-a"))
        self.assertEqual(len(self.store.history), 2)
        self.assertEqual(self.store.history[0].display_title, "title-c - P1")
        self.assertEqual(self.store.history[0].request_count, 2)
        self.assertEqual(self.store.history[1].display_title, "title-b - P1")
        self.assertTrue(hasattr(self.store.history[0], "owner_name"))

    def test_session_history_updates_for_duplicate_request_in_current_run(self):
        self.store.add_item(self.make_item("a", song_key="song-a"))
        self.store.add_item(self.make_item("b", song_key="song-a"))
        self.assertEqual(len(self.store.session_history), 1)
        self.assertEqual(self.store.session_history[0].display_title, "title-b - P1")
        self.assertEqual(self.store.session_history[0].request_count, 2)

    def test_session_history_does_not_restore_from_state_file(self):
        self.store.add_item(self.make_item("a", song_key="song-a"))
        restored_store = PlaylistStore(
            state_file=self.state_file,
            backup_file=self.backup_file,
            session_archive_dir=self.session_archive_dir,
        )
        self.assertEqual(restored_store.session_history, [])
        self.assertIsNone(restored_store.session_request_for_item(self.make_item("z", song_key="song-a")))

    def test_session_played_archive_tracks_items_that_become_current(self):
        self.store.add_item(self.make_item("a", song_key="song-a"))
        self.store.add_item(self.make_item("b", song_key="song-b"))

        payload = json.loads(self.store.session_played_file.read_text(encoding="utf-8"))
        self.assertRegex(self.store.session_played_file.name, r"^played-\d{4}-\d{2}-\d{2}_")
        self.assertEqual(self.store.session_played_file.parent, self.session_archive_dir)
        self.assertEqual([entry["item_id"] for entry in payload["items"]], ["a"])

        self.store.advance_to_next()
        payload = json.loads(self.store.session_played_file.read_text(encoding="utf-8"))
        self.assertEqual([entry["item_id"] for entry in payload["items"]], ["a", "b"])
        self.assertEqual(payload["items"][1]["display_title"], "title-b - P1")

    def test_session_played_archive_does_not_restore_into_new_run(self):
        self.store.add_item(self.make_item("a", song_key="song-a"))

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
        self.store.add_item(first)
        self.store.add_item(second)
        found = self.store.active_duplicate_for_item(duplicate)
        self.assertIsNotNone(found)
        self.assertEqual(found.id, "a")

    def test_missing_owner_urls_collects_entries_without_owner_name(self):
        item = self.make_item("a", song_key="song-a")
        item.owner_name = ""
        self.store.add_item(item)
        self.assertEqual(
            self.store.missing_owner_urls(),
            [item.resolved_url],
        )

    def test_update_owner_info_for_url_updates_playlist_and_history(self):
        item = self.make_item("a", song_key="song-a")
        item.owner_name = ""
        item.owner_mid = 0
        item.owner_url = ""
        self.store.add_item(item)

        changed = self.store.update_owner_info_for_url(
            item.resolved_url,
            owner_mid=114514,
            owner_name="示例UP",
            owner_url="https://space.bilibili.com/114514",
        )

        self.assertTrue(changed)
        self.assertEqual(self.store.current_item.owner_name, "示例UP")
        self.assertEqual(self.store.history[0].owner_name, "示例UP")

    def test_history_restores_from_state_file(self):
        self.store.add_item(self.make_item("a", song_key="song-a"))
        restored_store = PlaylistStore(
            state_file=self.state_file,
            backup_file=self.backup_file,
            session_archive_dir=self.session_archive_dir,
        )
        self.assertEqual(len(restored_store.history), 1)
        self.assertEqual(restored_store.history[0].display_title, "title-a - P1")
        self.assertEqual(restored_store.history[0].request_count, 1)

    def test_restore_from_backup(self):
        item = self.make_item("a")
        item.cache_status = "ready"
        item.cache_progress = 100.0
        item.cache_message = "缓存已完成"
        item.local_relative_path = "a/video.mp4"
        item.local_media_url = "/media/a/video.mp4"
        self.store.add_item(item)
        self.store.set_mode("local")

        restored_store = PlaylistStore(
            state_file=self.state_file,
            backup_file=self.backup_file,
            session_archive_dir=self.session_archive_dir,
        )
        self.assertEqual(restored_store.playlist, [])
        self.assertTrue(restored_store.backup_summary()["available"])
        self.assertTrue(restored_store.restore_backup())
        self.assertEqual(restored_store.playback_mode, "local")
        self.assertEqual(restored_store.current_item.id, "a")
        self.assertEqual([entry.id for entry in restored_store.playlist], [])
        restored_item = restored_store.current_item
        self.assertEqual(restored_item.cache_status, "pending")
        self.assertEqual(restored_item.local_relative_path, "")
        self.assertEqual(restored_item.local_media_url, "")

    def test_discard_backup(self):
        self.store.add_item(self.make_item("a"))
        self.assertTrue(self.backup_file.exists())
        self.assertTrue(self.store.discard_backup())
        self.assertFalse(self.store.backup_summary()["available"])


class BilibiliParserTest(unittest.TestCase):
    def test_clean_display_title_removes_brackets_and_part_suffix(self):
        cleaned = clean_display_title(
            title="【纯k投屏 | ニコカラ | 少女歌剧】星のダイアローグ",
            display_title="【纯k投屏 | ニコカラ | 少女歌剧】星のダイアローグ - on_vocal",
            part_title="on_vocal",
        )
        self.assertEqual(cleaned, "星のダイアローグ")

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

    @patch("bilikara.bilibili.request_json")
    def test_fetch_video_item(self, mock_request_json):
        mock_request_json.return_value = {
            "code": 0,
            "data": {
                "aid": 123,
                "bvid": "BV1xx411c7mD",
                "title": "示例视频",
                "pic": "https://example.com/cover.jpg",
                "owner": {
                    "mid": 114514,
                    "name": "示例UP",
                },
                "pages": [
                    {"cid": 456, "page": 1, "part": "第一段"},
                    {"cid": 789, "page": 2, "part": "第二段"},
                ],
            },
        }
        item = fetch_video_item("https://www.bilibili.com/video/BV1xx411c7mD?p=2")
        self.assertEqual(item.page, 2)
        self.assertEqual(item.cid, 789)
        self.assertEqual(item.video_page, 2)
        self.assertEqual(item.selected_pages, [1, 2])
        self.assertEqual(item.selected_cids, [456, 789])
        self.assertEqual(item.display_title, "示例视频 - 第二段")
        self.assertEqual(item.owner_mid, 114514)
        self.assertEqual(item.owner_name, "示例UP")
        self.assertEqual(item.owner_url, "https://space.bilibili.com/114514")


if __name__ == "__main__":
    unittest.main()
