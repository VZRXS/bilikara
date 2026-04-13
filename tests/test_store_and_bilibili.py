import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from bilikara.bilibili import VideoPage, fetch_video_item, resolve_video_reference, select_matching_pages
from bilikara.models import PlaylistItem
from bilikara.store import PlaylistStore


class PlaylistStoreTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = TemporaryDirectory()
        temp_path = Path(self.temp_dir.name)
        self.state_file = temp_path / "state.json"
        self.backup_file = temp_path / "playlist_backup.json"
        self.store = PlaylistStore(
            state_file=self.state_file,
            backup_file=self.backup_file,
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

    def test_history_updates_and_moves_latest_duplicate_to_top(self):
        self.store.add_item(self.make_item("a", song_key="song-a"))
        self.store.add_item(self.make_item("b", song_key="song-b"))
        self.store.add_item(self.make_item("c", song_key="song-a"))
        self.assertEqual(len(self.store.history), 2)
        self.assertEqual(self.store.history[0].display_title, "title-c - P1")
        self.assertEqual(self.store.history[0].request_count, 2)
        self.assertEqual(self.store.history[1].display_title, "title-b - P1")

    def test_history_restores_from_state_file(self):
        self.store.add_item(self.make_item("a", song_key="song-a"))
        restored_store = PlaylistStore(
            state_file=self.state_file,
            backup_file=self.backup_file,
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


if __name__ == "__main__":
    unittest.main()
