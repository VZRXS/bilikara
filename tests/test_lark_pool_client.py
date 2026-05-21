import unittest
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
            patch.object(lark_pool, "APP_SECRET", "secret"),
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
            patch.object(lark_pool, "_search_cloudflare_pool", return_value=None),
            patch.object(lark_pool, "_tenant_access_token", return_value="token"),
            patch.object(lark_pool, "_active_tables", return_value=[{"app_token": "app", "table_id": "table"}]),
            patch.object(lark_pool, "_post_json", side_effect=fake_post),
        ):
            results = lark_pool.search_lark_pool("karaoke")

        self.assertEqual(results[0]["bvid"], "BVPOOL1")
        self.assertEqual(results[0]["title"], "karaoke title")
        self.assertEqual(results[0]["source"], "bilikara")

    def test_search_lark_pool_uses_cloudflare_first(self):
        def fake_cloudflare(method, path, payload=None, *, timeout=12.0):
            self.assertEqual(method, "GET")
            self.assertIn("/search?", path)
            self.assertLessEqual(timeout, 2.0)
            return [
                {
                    "mid": "42",
                    "bvid": "BVCF1",
                    "title": "cloudflare karaoke",
                    "url": "https://www.bilibili.com/video/BVCF1",
                    "owner_name": "owner",
                    "owner_url": "https://space.bilibili.com/42",
                }
            ]

        with (
            patch.object(lark_pool, "_cloudflare_json", side_effect=fake_cloudflare),
            patch.object(lark_pool, "_search_lark_pool_legacy") as legacy,
        ):
            results = lark_pool.search_lark_pool("karaoke")

        legacy.assert_not_called()
        self.assertEqual(results[0]["bvid"], "BVCF1")
        self.assertEqual(results[0]["source"], "cloudflare")

    def test_append_lark_pool_entries_posts_to_cloudflare(self):
        posted_payloads = []

        def fake_cloudflare(method, path, payload=None, *, timeout=12.0):
            posted_payloads.append(payload)
            self.assertEqual(method, "POST")
            self.assertEqual(path, "/batch-add")
            return {"attempted": 1, "added": 1, "skipped_existing": 0, "feishu_queued": 1}

        with patch.object(lark_pool, "_cloudflare_json", side_effect=fake_cloudflare):
            result = lark_pool.append_lark_pool_entries(
                [{"bvid": "BV1CFADD0001", "title": "new", "url": "https://www.bilibili.com/video/BV1CFADD0001"}]
            )

        self.assertEqual(result["added"], 1)
        self.assertEqual(posted_payloads[0]["records"][0]["bvid"], "BV1CFADD0001")

    def test_append_lark_pool_entries_rejects_short_dummy_bvids(self):
        with patch.object(lark_pool, "_cloudflare_json") as cloudflare:
            result = lark_pool.append_lark_pool_entries(
                [
                    {"bvid": "BVFAV1", "title": "dummy", "url": "https://www.bilibili.com/video/BVFAV1"},
                    {"bvid": "BVADDED42", "title": "dummy", "url": "https://www.bilibili.com/video/BVADDED42"},
                ]
            )

        cloudflare.assert_not_called()
        self.assertEqual(result, {"attempted": 0, "added": 0})

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
            patch.object(lark_pool, "_table_record_count", return_value=0),
        ):
            tables = lark_pool._active_tables()

        self.assertEqual([table["index"] for table in tables], [2])
        self.assertEqual(tables[0]["field_names"], ["bvid", "owner_name", "title", "url"])
        self.assertFalse(tables[0]["search_enabled"])

    def test_active_tables_enable_non_primary_table_with_one_record(self):
        with (
            patch.object(lark_pool, "_TABLES_READY", False),
            patch.object(lark_pool, "_ACTIVE_TABLES", []),
            patch.object(lark_pool, "_TABLE_PROBED", set()),
            patch.object(lark_pool, "BITABLE_TABLES", (("app1", "table1"), ("app2", "table2"))),
            patch.object(lark_pool, "_tenant_access_token", return_value="token"),
            patch.object(lark_pool, "_table_field_names", return_value={"bvid", "title", "url"}),
            patch.object(lark_pool, "_table_record_count", return_value=1),
        ):
            tables = lark_pool._active_tables()

        self.assertTrue(tables[1]["search_enabled"])

    def test_search_lark_pool_skips_empty_overflow_tables(self):
        post_count = 0

        def fake_post(url, payload, *, token=None, timeout=12.0):
            nonlocal post_count
            self.assertIn("/records/search", url)
            post_count += 1
            return {"code": 0, "data": {"items": []}}

        with (
            patch.object(lark_pool, "_search_cloudflare_pool", return_value=None),
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

    def test_search_lark_pool_table_probes_only_requested_table(self):
        searched_urls = []

        def fake_post(url, payload, *, token=None, timeout=12.0):
            searched_urls.append(url)
            return {
                "code": 0,
                "data": {
                    "items": [
                        {
                            "fields": {
                                "bvid": "BVTABLE1",
                                "title": "table one karaoke",
                                "url": "https://www.bilibili.com/video/BVTABLE1",
                            }
                        }
                    ]
                },
            }

        with (
            patch.object(lark_pool, "_TABLES_READY", False),
            patch.object(lark_pool, "_ACTIVE_TABLES", []),
            patch.object(lark_pool, "_TABLE_PROBED", set()),
            patch.object(lark_pool, "BITABLE_TABLES", (("app1", "table1"), ("app2", "table2"))),
            patch.object(lark_pool, "_CLOUDFLARE_API_URL", ""),
            patch.object(lark_pool, "APP_SECRET", "secret"),
            patch.object(lark_pool, "_tenant_access_token", return_value="token"),
            patch.object(lark_pool, "_table_field_names", return_value={"bvid", "title", "url"}) as fields,
            patch.object(lark_pool, "_table_record_count", return_value=1) as count,
            patch.object(lark_pool, "_post_json", side_effect=fake_post),
        ):
            results = lark_pool.search_lark_pool_table("karaoke", 1)

        self.assertEqual([item["bvid"] for item in results], ["BVTABLE1"])
        fields.assert_called_once_with("token", "app1", "table1")
        count.assert_called_once_with("token", "app1", "table1")
        self.assertEqual(len(searched_urls), 1)
        self.assertIn("/apps/app1/tables/table1/", searched_urls[0])

    def test_lark_append_bumps_cached_table_search_enabled_state(self):
        post_count = 0

        def fake_post(url, payload, *, token=None, timeout=12.0):
            nonlocal post_count
            post_count += 1
            return {"code": 0, "data": {"items": []}}

        with (
            patch.object(lark_pool, "_TABLES_READY", False),
            patch.object(lark_pool, "_ACTIVE_TABLES", []),
            patch.object(lark_pool, "_TABLE_PROBED", set()),
            patch.object(lark_pool, "BITABLE_TABLES", (("app1", "table1"), ("app2", "table2"))),
            patch.object(lark_pool, "_CLOUDFLARE_API_URL", ""),
            patch.object(lark_pool, "APP_SECRET", "secret"),
            patch.object(lark_pool, "_tenant_access_token", return_value="token"),
            patch.object(lark_pool, "_table_field_names", return_value={"bvid", "title", "url"}),
            patch.object(lark_pool, "_table_record_count", return_value=0),
            patch.object(lark_pool, "_post_json", side_effect=fake_post),
        ):
            self.assertEqual(lark_pool.search_lark_pool_table("karaoke", 2), [])
            self.assertEqual(post_count, 0)
            lark_pool._bump_table_count(2, 1)
            self.assertEqual(lark_pool.search_lark_pool_table("karaoke", 2), [])
            self.assertEqual(post_count, 1)

    def test_append_lark_pool_entries_posts_to_cloudflare_only(self):
        requests = []

        def fake_cloudflare(method, path, payload=None, *, timeout=12.0):
            requests.append((method, path, payload, timeout))
            return {"attempted": 1, "added": 1, "skipped_existing": 0, "feishu_queued": 1}

        with patch.object(lark_pool, "_cloudflare_json", side_effect=fake_cloudflare):
            result = lark_pool.append_lark_pool_entries(
                [
                    {
                        "bvid": "BV1NEW000001",
                        "title": "new",
                        "url": "https://www.bilibili.com/video/BV1NEW000001",
                    }
                ]
            )

        self.assertEqual(result["added"], 1)
        self.assertEqual(len(requests), 1)
        method, path, payload, timeout = requests[0]
        self.assertEqual(method, "POST")
        self.assertEqual(path, "/batch-add")
        self.assertEqual(timeout, 20)
        self.assertEqual(payload["records"][0]["bvid"], "BV1NEW000001")

    def test_delete_cloudflare_pool_entry_posts_single_bvid(self):
        requests = []

        def fake_cloudflare(method, path, payload=None, *, timeout=12.0):
            requests.append((method, path, payload, timeout))
            return {
                "success": True,
                "bvid": "BV1xx411c7mD",
                "found": True,
                "deleted": True,
                "feishu_queued": True,
            }

        with patch.object(lark_pool, "_cloudflare_json", side_effect=fake_cloudflare):
            result = lark_pool.delete_cloudflare_pool_entry("BV1xx411c7mD")

        self.assertTrue(result["deleted"])
        self.assertEqual(len(requests), 1)
        method, path, payload, timeout = requests[0]
        self.assertEqual(method, "POST")
        self.assertEqual(path, "/delete-invalid")
        self.assertEqual(timeout, 10)
        self.assertEqual(payload, {"bvid": "BV1xx411c7mD"})

    def test_delete_cloudflare_pool_entry_rejects_invalid_bvid(self):
        with patch.object(lark_pool, "_cloudflare_json") as cloudflare:
            result = lark_pool.delete_cloudflare_pool_entry("BVSHORT")

        cloudflare.assert_not_called()
        self.assertFalse(result["success"])
        self.assertFalse(result["deleted"])


if __name__ == "__main__":
    unittest.main()

