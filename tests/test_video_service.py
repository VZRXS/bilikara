"""P04 desktop/native shared service contracts through the real Runtime FFI."""
import unittest
import threading
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import Mock, patch

from bilikara import bilibili, rust_runtime
from video_service_fixture import video_fixture


class VideoServiceTest(unittest.TestCase):
    @video_fixture
    def test_desktop_inputs_original_resolved_queries_and_embeds(self, fixture):
        for raw, expected in [
            ("  BV1xx411c7mD  ", "https://www.bilibili.com/video/BV1xx411c7mD"),
            ("av123", "https://www.bilibili.com/video/av123"),
            ("bV1xx411c7mD", "https://www.bilibili.com/video/bV1xx411c7mD"),
            ("www.bilibili.com/video/BV1xx411c7mD/", "https://www.bilibili.com/video/BV1xx411c7mD/"),
            ("http://www.bilibili.com/video/av123?p=0&a=&a=one%20two#part", "http://www.bilibili.com/video/av123?p=0&a=&a=one%20two#part"),
        ]:
            with self.subTest(raw=raw):
                item = bilibili.fetch_video_item(raw)
                self.assertEqual(item.original_url, expected)
                self.assertRegex(item.id, r"^[0-9a-f]{12}$")
                self.assertEqual(item.title, "歌曲 🎤")
                self.assertEqual(item.part_title, "原唱")
                self.assertEqual(item.owner_name, "UP 主")
                self.assertEqual(item.cover_url, "http://example.invalid/cover.jpg")
                self.assertEqual(item.cache_message, "等待缓存")
                self.assertEqual(item.selected_audio_variant_id, "p1_track_1")
                self.assertEqual(item.embed_url, "https://player.bilibili.com/player.html?aid=123&bvid=BV1xx411c7mD&cid=456&page=1&high_quality=1&danmaku=0&autoplay=1&isOutside=true")
        self.assertEqual(item.resolved_url, "http://www.bilibili.com/video/av123?a=&a=one+two&p=1#part")
        item = bilibili.fetch_video_item("http://WWW.BILIBILI.COM:80/video/av123?p=9&tag=~*#中")
        self.assertEqual(item.resolved_url, "http://WWW.BILIBILI.COM:80/video/av123?tag=~%2A&p=1#中")
        # A direct URL only supplies its video identifier; it is never fetched.
        item = bilibili.fetch_video_item("http://127.0.0.1/private/video/BV1xx411c7mD")
        self.assertTrue(all(path.startswith("/x/web-interface/wbi/view?") for path, _ in fixture.requests))

    @video_fixture
    def test_short_link_hops_and_disallowed_redirect(self, fixture):
        fixture.redirects["/short"] = "https://bili2233.cn/next"
        fixture.redirects["/next"] = "https://www.bilibili.com/video/av123?p=2&x=&x=%E4%B8%AD#keep"
        item = bilibili.fetch_video_item("b23.tv/short")
        self.assertEqual(item.original_url, "https://b23.tv/short")
        self.assertEqual(item.resolved_url, "https://www.bilibili.com/video/av123?x=&x=%E4%B8%AD&p=1#keep")
        self.assertEqual([path for path, _ in fixture.requests[:2]], ["/short", "/next"])
        for target in ("http://127.0.0.1/private", "https://bilibili.com.evil.invalid/video/BV1xx411c7mD", "https://www.bilibili.com:444/private", "https://name:secret@www.bilibili.com/private"):
            fixture.redirects["/short"] = target
            before = len(fixture.requests)
            with self.assertRaisesRegex(bilibili.BilibiliError, "受支持"):
                bilibili.fetch_video_item("https://b23.tv/short")
            self.assertEqual(len(fixture.requests), before + 1)
        fixture.redirects["/short"] = "/short"
        with self.assertRaisesRegex(bilibili.BilibiliError, "次数过多"):
            bilibili.fetch_video_item("https://b23.tv/short")

    @video_fixture
    def test_filter_defaults_sparse_pages_and_selection_normalization(self, fixture):
        fixture.return_value["data"]["pages"] = [None, {"cid": 0}, {"cid": 3, "page": 3, "duration": 4}, {"cid": "44", "page": "4", "duration": "100", "part": " "}]
        item = bilibili.fetch_video_item("BV1xx411c7mD")
        self.assertEqual(item.available_pages, [4])
        self.assertEqual(item.selected_parts, ["P4"])
        self.assertEqual(item.video_page, 4)
        fixture.return_value["data"]["pages"] = [
            {"cid": 10, "duration": 100, "part": "A"},
            {"cid": 20, "duration": 200, "part": "B"},
            {"cid": 30, "duration": 300, "part": "C"},
        ]
        item = bilibili.fetch_video_item("BV1xx411c7mD", selected_audio_pages=["3", 1, "3", 0, -2, "bad", None, 2.8])
        self.assertEqual(item.selected_pages, [3, 1, 2])
        self.assertEqual(item.video_page, 3)  # desktop audio-only manual selection
        self.assertEqual(item.selected_audio_variant_id, "p3_c")
        item = bilibili.fetch_video_item("BV1xx411c7mD", selected_audio_pages=["bad"])
        self.assertEqual(item.selected_pages, [1])
        self.assertTrue(item.manual_selection)
        item = bilibili.fetch_video_item("av123", selected_video_page=True)
        self.assertEqual(item.video_page, 1)
        with self.assertRaises(bilibili.ManualBindingRequiredError) as error:
            bilibili.fetch_video_item("https://www.bilibili.com/video/BV1xx411c7mD?p=99")
        self.assertEqual(error.exception.preferred_page, 3)
        self.assertEqual(str(error.exception), "该视频包含多个分P，请先选择视频和音频绑定关系")

    @video_fixture
    def test_errors_owner_without_pages_and_credentials(self, fixture):
        with patch.object(bilibili, "effective_bilibili_cookie", return_value="SESSDATA=synthetic; bili_jct=fixture"), patch.object(bilibili, "BILIBILI_HEADERS", {"User-Agent": "P04 fixture", "Referer": "https://www.bilibili.com/fixture"}):
            self.assertEqual(bilibili.fetch_owner_info("av123"), (42, "UP 主", "https://space.bilibili.com/42"))
        headers = fixture.requests[-1][1]
        self.assertEqual(headers.get("cookie"), "SESSDATA=synthetic; bili_jct=fixture")
        self.assertEqual(headers.get("user-agent"), "P04 fixture")
        self.assertEqual(headers.get("referer"), "https://www.bilibili.com/fixture")
        fixture.return_value["data"].pop("pages")
        self.assertEqual(bilibili.fetch_owner_info("av123")[0], 42)
        with self.assertRaisesRegex(bilibili.BilibiliError, "没有可播放"):
            bilibili.fetch_video_item("av123")
        for code in (-101, -404, -403, -412, 62002):
            fixture.return_value = {"code": code, "message": "合成 API 错误"}
            with self.assertRaisesRegex(bilibili.BilibiliError, "合成 API 错误") as error:
                bilibili.fetch_video_item("av123")
            self.assertEqual(error.exception.__cause__.response["error"]["api_code"], code)
        for status in (401, 403, 412, 503):
            fixture.status = status
            with self.assertRaises(bilibili.BilibiliError) as error:
                bilibili.fetch_video_item("av123")
            self.assertEqual(error.exception.__cause__.response["error"]["status_code"], status)
        fixture.status = 200
        for data in (b"<html>login</html>", b"{broken", {"data": {}}, {"code": 0, "data": None}):
            fixture.return_value = data
            with self.assertRaises(bilibili.BilibiliError):
                bilibili.fetch_video_item("av123")
        before = len(fixture.requests)
        for raw in ("", "not-a-video", "https://www.bilibili.com/video/av123?p=abc"):
            with self.assertRaises(bilibili.BilibiliError):
                bilibili.fetch_video_item(raw)
        self.assertEqual(len(fixture.requests), before)

    @video_fixture
    def test_credentialed_metadata_request_does_not_follow_redirects(self, fixture):
        # Python's urllib followed redirects here. The shared client deliberately
        # does not, so the session cookie can never reach a redirect target.
        view = "/x/web-interface/wbi/view?bvid=BV1xx411c7mD"
        fixture.redirects[view] = "https://www.bilibili.com/leak"
        with patch.object(bilibili, "effective_bilibili_cookie", return_value="SESSDATA=synthetic"):
            with self.assertRaises(bilibili.BilibiliError) as error:
                bilibili.fetch_video_item("BV1xx411c7mD")
        self.assertEqual(error.exception.__cause__.response["error"]["status_code"], 302)
        self.assertEqual([path for path, _ in fixture.requests], [view])

    @video_fixture
    def test_parallel_calls_guest_cookie_and_unique_ids(self, fixture):
        with patch.object(bilibili, "effective_bilibili_cookie", return_value=""), ThreadPoolExecutor(max_workers=4) as pool:
            items = list(pool.map(bilibili.fetch_video_item, ["av123"] * 8))
        self.assertEqual(len({item.id for item in items}), 8)
        self.assertTrue(all("cookie" not in headers for _, headers in fixture.requests))
        expected = items[0].serialize()
        expected.pop("id")
        for item in items:
            actual = item.serialize()
            actual.pop("id")
            self.assertEqual(actual, expected)

    @video_fixture
    def test_actual_desktop_add_manual_binding_owner_and_internet_adapters(self, fixture):
        from bilikara import server, internet_remote
        handler = server.BilikaraHandler.__new__(server.BilikaraHandler)
        handler._write_json = Mock()
        added = []
        context = SimpleNamespace(touch_client=lambda *args, **kw: None, has_session_users=lambda: True, add_item=lambda item, **kw: added.append(item), snapshot=lambda: {})
        fixture.return_value["data"]["pages"].append({"page": 2, "cid": 789, "duration": 300, "part": "伴奏"})
        with patch.object(server, "CONTEXT", context), patch.object(server, "append_catalog_entries_in_background") as append:
            with self.assertRaises(bilibili.ManualBindingRequiredError):
                handler._handle_add({"url": "av123"})
            handler.path = "/api/playlist/add"
            handler.headers = {}
            handler._read_json_body = lambda: {"url": "av123"}
            handler.do_POST()
            response = handler._write_json.call_args
            self.assertEqual(response.kwargs["status"], 409)
            self.assertEqual(response.args[0]["code"], "manual_binding_required")
            self.assertEqual(response.args[0]["binding"], {
                "title": "歌曲 🎤", "preferred_page": 1,
                "pages": [{"page": 1, "cid": 456, "duration": 123, "part": "原唱"},
                          {"page": 2, "cid": 789, "duration": 300, "part": "伴奏"}],
            })
            self.assertEqual(added, [])
            append.assert_not_called()
            handler._handle_add({"url": "av123", "selected_video_page": 1, "selected_audio_pages": [2]})
            self.assertEqual(added[0].selected_pages, [2])
            append.assert_called_once()
        store = SimpleNamespace(missing_owner_urls=lambda: ["av123"], update_owner_info_for_url=Mock())
        context = SimpleNamespace(store=store, _closed=False)
        server.AppContext._owner_enrichment_loop(context)
        store.update_owner_info_for_url.assert_called_once_with("av123", owner_mid=42, owner_name="UP 主", owner_url="https://space.bilibili.com/42")
        item = internet_remote._fetch_catalog_item("BV1xx411c7mD", selected_video_page=1, selected_audio_pages=[2])
        self.assertEqual(item.selected_pages, [2])
        before = len(fixture.requests)
        with self.assertRaises(internet_remote.InternetRemoteDispatchError):
            internet_remote._fetch_catalog_item("http://127.0.0.1/private")
        self.assertEqual(len(fixture.requests), before)

    @video_fixture
    def test_shared_item_enters_existing_desktop_app_state_admission(self, fixture):
        from bilikara import server
        from bilikara.store import PlaylistStore
        fixture.return_value["data"]["pages"].append({"page": 2, "cid": 789, "duration": 300, "part": "伴奏"})
        with TemporaryDirectory() as directory:
            root = Path(directory)
            store = PlaylistStore(root / "state.json", root / "backup.json", root / "sessions")
            store.add_session_user("fixture-user")
            context = server.AppContext.__new__(server.AppContext)
            context.store = store
            context.cache_manager = SimpleNamespace(reset_offset_on_next=False, sync_with_playlist=Mock())
            context.snapshot = lambda: {"playlist": []}
            handler = server.BilikaraHandler.__new__(server.BilikaraHandler)
            handler._write_json = Mock()
            with patch.object(server, "CONTEXT", context), patch.object(server, "append_catalog_entries_in_background"), patch.object(store, "add_item", wraps=store.add_item) as admission:
                handler._handle_add({"url": "av123", "requester_name": "fixture-user", "selected_video_page": 1, "selected_audio_pages": [2]})
            self.assertEqual(store.current_item.cid, 456)
            self.assertEqual(store.current_item.selected_cids, [789])
            self.assertEqual(admission.call_args.args[0].selected_audio_variant_id, "p2_track_1")
            # Existing admission clears pending variants until cache publication.
            self.assertEqual(store.current_item.selected_audio_variant_id, "")
            self.assertEqual(store.current_item.requester_name, "fixture-user")
            self.assertTrue(store.current_item.item_incarnation_id)
            context.cache_manager.sync_with_playlist.assert_called_once()
            store.shutdown()

    @video_fixture
    def test_network_wait_does_not_hold_app_state_lock(self, fixture):
        entered, release = threading.Event(), threading.Event()
        fixture.before_response = lambda: (entered.set(), release.wait(5))
        def snapshot():
            try:
                return rust_runtime.app_state_request("snapshot")
            except RuntimeError as error:
                # An uninitialized AppState is also an immediate, valid ABI error.
                return error
        with ThreadPoolExecutor(max_workers=2) as pool:
            pending = pool.submit(bilibili.fetch_video_item, "av123")
            try:
                self.assertTrue(entered.wait(2))
                result = pool.submit(snapshot).result(timeout=2)
                self.assertIsNotNone(result)
                self.assertFalse(pending.done())
            finally:
                release.set()
            self.assertEqual(pending.result(timeout=3).aid, 123)

    def test_no_runtime_does_not_execute_python_fallback(self):
        with patch.object(rust_runtime, "_runtime_lib", None), patch.object(bilibili, "request_json", side_effect=AssertionError("Python I/O")):
            with self.assertRaises(rust_runtime.RustRuntimeUnavailableError):
                bilibili.fetch_video_item("av123")
            with self.assertRaises(rust_runtime.RustRuntimeUnavailableError):
                bilibili.fetch_owner_info("av123")


if __name__ == "__main__":
    unittest.main()
