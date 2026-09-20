"""Synthetic configured-source provider and isolated storage for real Rust FFI."""
import json
import time
from contextlib import ExitStack
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

from bilikara import bilibili, gatcha_refresh, rust_runtime, shared_catalog
from video_service_fixture import VideoFixture


class ConfiguredRefreshFixture:
    def __init__(self, uids=("1",), *, legacy=False):
        self.uids = list(uids)
        self.legacy = legacy
        self.fail_uids = set()
        self.fail_favlist = False
        self.videos = {uid: [{"bvid": "BVNEW000000" + uid, "title": "karaoke new " + uid, "author": "up-" + uid,
                              "pic": "https://example.com/cover.jpg", "play": 10, "length": "1:30"}] for uid in uids}
        self.favorite = {"bvid": "BVFAVREBUILD", "title": "fav rebuilt", "cover": "https://example.com/fav-cover.jpg",
                         "cnt_info": {"play": 20}, "duration": 120, "upper": {"mid": 9, "name": "favorite up"}}

    def __enter__(self):
        self.stack = ExitStack()
        self.root = Path(self.stack.enter_context(TemporaryDirectory()))
        self.provider = self.stack.enter_context(VideoFixture())
        self.provider.return_value = self.respond
        for suffix in ("UIDS", "CACHE", "FAVLIST", "POOL_CONFIG", "UIDS_TEMP", "CACHE_TEMP", "FAVLIST_TEMP", "REBUILD_PROGRESS"):
            self.stack.enter_context(patch.object(bilibili, "_GATCHA_" + suffix + "_FILE", self.path(suffix.lower())))
        self.stack.enter_context(patch.object(bilibili, "effective_bilibili_cookie", return_value="SESSDATA=synthetic"))
        self.stack.enter_context(patch.object(bilibili, "_default_gatcha_uids", return_value=self.uids))
        self.stack.enter_context(patch.object(shared_catalog, "_CLOUDFLARE_API_URL", f"http://127.0.0.1:{self.provider.server.server_port}"))
        # No production Python worker, repository, or indexing callback may run.
        for name in ("refresh_gatcha_cache", "_append_catalog_entries_async", "_py_refresh_gatcha_cache"):
            self.stack.enter_context(patch.object(bilibili, name, side_effect=AssertionError("retired Python path: " + name)))
        self.write("uids", {"schema_version": 1 if self.legacy else 2, "uids": self.uids, "profiles": {}})
        self.write("cache", {"schema_version": 2 if self.legacy else 3, "uids": {}, "profiles": {}})
        self.write("favlist", {"schema_version": 1 if self.legacy else 2, "uid": "42", "folders": [], "items": []})
        rust_runtime.reset_gatcha_status_service()
        return self

    def __exit__(self, *args):
        # Retire callbacks/work while the provider and temporary files still exist.
        gatcha_refresh.stop()
        self.stack.close()
        rust_runtime.reset_gatcha_status_service()

    def path(self, name):
        return self.root / ("gatcha_" + name + ".json")

    def write(self, name, value):
        self.path(name).write_text(json.dumps(value), encoding="utf-8")

    def read(self, name):
        return json.loads(self.path(name).read_text(encoding="utf-8"))

    def respond(self, target):
        url = urlsplit(target)
        query = parse_qs(url.query)
        if url.path.endswith("/nav"):
            return {"code": 0, "data": {"wbi_img": {"img_url": "https://i0.hdslb.com/bfs/wbi/" + "a" * 32 + ".png",
                                                         "sub_url": "https://i0.hdslb.com/bfs/wbi/" + "b" * 32 + ".png"}}}
        uid = query.get("mid", [""])[0]
        if url.path.endswith("/acc/info"):
            if uid in self.fail_uids:
                return {"code": -101, "message": "synthetic UID failure"}
            return {"code": 0, "data": {"mid": uid, "name": "up-" + uid, "face": "https://example.com/avatar.jpg"}}
        if url.path.endswith("/arc/search"):
            return {"code": 0, "data": {"list": {"vlist": self.videos.get(uid, [])}}}
        if url.path.endswith("/resource/list"):
            if self.fail_favlist:
                return {"code": -101, "message": "synthetic favorite failure"}
            return {"code": 0, "data": {"medias": [self.favorite], "has_more": False}}
        raise AssertionError("unexpected fixture request " + target)

    def add_folder(self):
        self.write("favlist", {"schema_version": 1 if self.legacy else 2, "uid": "42",
                               "folders": [{"id": "100", "title": "K songs"}], "items": []})

    def start(self, **kwargs):
        return bilibili.refresh_gatcha_cache_in_background(**kwargs)

    def wait(self):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            value = rust_runtime.gatcha_task_snapshot()
            if not value["background_busy"]:
                return value
            time.sleep(.01)
        raise AssertionError("Rust refresh did not finish")

    def appended_bvids(self, expected_count):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            records = [row for _, payload in self.provider.posts for row in payload.get("records", [])]
            if len(records) >= expected_count:
                return [row["bvid"] for row in records]
            time.sleep(.01)
        raise AssertionError(f"missing Catalog fixture writes: {self.provider.posts}")
