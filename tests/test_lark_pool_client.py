import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import bilikara.lark_pool_client as lark_pool


class LarkPoolClientTest(unittest.TestCase):
    def test_tenant_access_token_reads_top_level_feishu_payload(self):
        with (
            patch.object(
                lark_pool,
                "_post_json",
                return_value={"code": 0, "tenant_access_token": "tenant-token", "expire": 3600},
            ),
            patch.object(lark_pool, "_TOKEN_VALUE", ""),
            patch.object(lark_pool, "_TOKEN_EXPIRES_AT", 0.0),
        ):
            token = lark_pool._tenant_access_token()

        self.assertEqual(token, "tenant-token")

    def test_search_lark_pool_normalizes_records(self):
        def fake_post(url, payload, *, token=None, timeout=12.0):
            self.assertIn("/records/search", url)
            self.assertEqual(set(payload.keys()), {"filter"})
            self.assertEqual(payload["filter"]["conditions"][0]["field_name"], "title")
            return {
                "code": 0,
                "data": {
                    "items": [
                        {
                            "fields": {
                                "mid": "42",
                                "bvid": "BVPOOL1",
                                "title": [{"text": "karaoke title"}],
                                "url": "https://www.bilibili.com/video/BVPOOL1",
                                "owner_name": "owner",
                                "owner_url": "https://space.bilibili.com/42",
                            }
                        }
                    ]
                },
            }

        with (
            patch.object(lark_pool, "_tenant_access_token", return_value="token"),
            patch.object(lark_pool, "_active_tables", return_value=[{"app_token": "app", "table_id": "table"}]),
            patch.object(lark_pool, "_post_json", side_effect=fake_post),
        ):
            results = lark_pool.search_lark_pool("karaoke")

        self.assertEqual(results[0]["bvid"], "BVPOOL1")
        self.assertEqual(results[0]["title"], "karaoke title")
        self.assertEqual(results[0]["source"], "bilikara")

    def test_active_tables_skip_tables_without_search_fields(self):
        with (
            patch.object(lark_pool, "_TABLES_READY", False),
            patch.object(lark_pool, "_ACTIVE_TABLES", []),
            patch.object(lark_pool, "BITABLE_TABLES", (("app1", "table1"), ("app2", "table2"))),
            patch.object(lark_pool, "_tenant_access_token", return_value="token"),
            patch.object(
                lark_pool,
                "_table_field_names",
                side_effect=[
                    {"bvid", "url"},
                    {"bvid", "title", "url", "owner_name"},
                ],
            ),
            patch.object(lark_pool, "_table_record_count", return_value=1),
        ):
            tables = lark_pool._active_tables()

        self.assertEqual([table["index"] for table in tables], [2])
        self.assertEqual(tables[0]["field_names"], ["bvid", "owner_name", "title", "url"])
        self.assertFalse(tables[0]["search_enabled"])

    def test_search_lark_pool_skips_empty_overflow_tables(self):
        post_count = 0

        def fake_post(url, payload, *, token=None, timeout=12.0):
            nonlocal post_count
            self.assertIn("/records/search", url)
            post_count += 1
            return {"code": 0, "data": {"items": []}}

        with (
            patch.object(lark_pool, "_tenant_access_token", return_value="token"),
            patch.object(
                lark_pool,
                "_active_tables",
                return_value=[
                    {"index": 1, "app_token": "app1", "table_id": "table1", "search_enabled": True},
                    {"index": 2, "app_token": "app2", "table_id": "table2", "search_enabled": False},
                    {"index": 3, "app_token": "app3", "table_id": "table3", "search_enabled": False},
                ],
            ),
            patch.object(lark_pool, "_post_json", side_effect=fake_post),
        ):
            results = lark_pool.search_lark_pool("dive")

        self.assertEqual(results, [])
        self.assertEqual(post_count, 1)

    def test_append_lark_pool_entries_skips_locally_synced_bvids(self):
        with TemporaryDirectory() as temp_dir:
            sync_file = Path(temp_dir) / "lark_pool_sync.json"
            sync_file.write_text(json.dumps({"bvids": ["BVOLD"]}), encoding="utf-8")
            posted_records = []

            def fake_post(url, payload, *, token=None, timeout=12.0):
                self.assertIn("/batch_create", url)
                posted_records.extend(payload["records"])
                return {"code": 0, "data": {}}

            with (
                patch.object(lark_pool, "_SYNC_FILE", sync_file),
                patch.object(lark_pool.cfg, "DATA_DIR", Path(temp_dir)),
                patch.object(lark_pool, "_tenant_access_token", return_value="token"),
                patch.object(
                    lark_pool,
                    "_active_tables",
                    return_value=[{"index": 1, "app_token": "app", "table_id": "table", "count": 1}],
                ),
                patch.object(lark_pool, "_post_json", side_effect=fake_post),
            ):
                result = lark_pool.append_lark_pool_entries(
                    [
                        {"bvid": "BVOLD", "title": "old", "url": "https://www.bilibili.com/video/BVOLD"},
                        {"bvid": "BVNEW", "title": "new", "url": "https://www.bilibili.com/video/BVNEW"},
                    ]
                )

            self.assertEqual(result["added"], 1)
            self.assertEqual(posted_records[0]["fields"]["bvid"], "BVNEW")
            payload = json.loads(sync_file.read_text(encoding="utf-8"))
            self.assertIn("BVNEW", payload["bvids"])


if __name__ == "__main__":
    unittest.main()
