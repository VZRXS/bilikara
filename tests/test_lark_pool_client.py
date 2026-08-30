import unittest
from unittest.mock import patch

import bilikara.lark_pool_client as lark_pool


class LarkPoolClientTest(unittest.TestCase):
    def test_lark_http_transport_delegates_to_rust_runtime(self):
        with patch.object(
            lark_pool.rust_runtime,
            "json_http_request",
            return_value={"code": 0, "data": {}},
        ) as request:
            result = lark_pool._post_json(
                "https://open.feishu.test/api",
                {"bvid": "BV1xx411c7mD"},
                token="tenant-token",
                timeout=4,
            )

        self.assertEqual(result["code"], 0)
        request.assert_called_once_with(
            "POST",
            "https://open.feishu.test/api",
            headers={
                "Content-Type": "application/json; charset=utf-8",
                "Authorization": "Bearer tenant-token",
            },
            payload={"bvid": "BV1xx411c7mD"},
            timeout=4,
        )

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

    def test_prewarm_cloudflare_pool_uses_dedicated_search_request(self):
        requests = []

        def fake_cloudflare(method, path, payload=None, *, timeout=12.0):
            requests.append((method, path, payload, timeout))
            return []

        with (
            patch.object(lark_pool, "_cloudflare_json", side_effect=fake_cloudflare),
            patch.object(lark_pool, "_CLOUDFLARE_PREWARM_TIMEOUT", 8.0),
        ):
            warmed = lark_pool.prewarm_cloudflare_pool()

        self.assertTrue(warmed)
        self.assertEqual(requests, [("GET", "/search?keyword=VZRXS", None, 8.0)])

    def test_prewarm_cloudflare_pool_ignores_worker_failure(self):
        with patch.object(lark_pool, "_cloudflare_json", side_effect=lark_pool.LarkPoolError("timeout")):
            self.assertFalse(lark_pool.prewarm_cloudflare_pool())

    def test_append_lark_pool_entries_posts_to_cloudflare(self):
        posted_entries = []

        def fake_cloudflare(operation, **request):
            self.assertEqual(operation, "append")
            posted_entries.extend(request["entries"])
            return {"attempted": 1, "added": 1, "skipped_existing": 0, "feishu_queued": 1}

        with patch.object(lark_pool.rust_runtime, "cloudflare_service_request", side_effect=fake_cloudflare):
            result = lark_pool.append_lark_pool_entries(
                [
                    {
                        "bvid": "BV1CFADD0001",
                        "title": "new",
                        "url": "https://www.bilibili.com/video/BV1CFADD0001",
                        "cover_url": "https://example.com/cover.jpg",
                        "played_count": 683,
                        "preserved_1": 201,
                    }
                ]
            )

        self.assertEqual(result["added"], 1)
        self.assertEqual(posted_entries[0]["bvid"], "BV1CFADD0001")
        self.assertEqual(posted_entries[0]["cover_url"], "https://example.com/cover.jpg")

    def test_append_lark_pool_entries_rejects_short_dummy_bvids(self):
        with patch.object(
            lark_pool.rust_runtime,
            "cloudflare_service_request",
            return_value={"attempted": 0, "added": 0},
        ) as cloudflare:
            result = lark_pool.append_lark_pool_entries(
                [
                    {"bvid": "BVFAV1", "title": "dummy", "url": "https://www.bilibili.com/video/BVFAV1"},
                    {"bvid": "BVADDED42", "title": "dummy", "url": "https://www.bilibili.com/video/BVADDED42"},
                ]
            )

        cloudflare.assert_called_once()
        self.assertEqual(result, {"attempted": 0, "added": 0})

    def test_background_append_reports_returned_error(self):
        with (
            patch.object(lark_pool, "append_lark_pool_entries", return_value={"error": "timeout"}),
            patch("builtins.print") as mock_print,
        ):
            lark_pool._BackgroundAppendScheduler._process([{"bvid": "BV1xx411c7mD"}])

        mock_print.assert_called_once_with(
            "[bilikara:lark] background append failed for 1 item(s): timeout",
            file=lark_pool.sys.stderr,
            flush=True,
        )

    def test_background_append_scheduler_has_one_worker_and_bounded_queue(self):
        started = []

        class FakeThread:
            def __init__(self, *, target, daemon, name):
                self.target = target
                self.daemon = daemon
                self.name = name
                self.alive = False

            def start(self):
                self.alive = True
                started.append(self)

            def is_alive(self):
                return self.alive

        scheduler = lark_pool._BackgroundAppendScheduler(max_pending=1)
        with (
            patch.object(lark_pool.threading, "Thread", FakeThread),
            patch.object(lark_pool.time, "monotonic", return_value=31.0),
            patch("builtins.print") as mock_print,
        ):
            self.assertTrue(scheduler.submit([{"bvid": "BV1xx411c7mD"}]))
            self.assertFalse(scheduler.submit([{"bvid": "BV1yy411c7mD"}]))

        self.assertEqual(len(started), 1)
        self.assertEqual(started[0].name, "lark-pool-append")
        mock_print.assert_called_once_with(
            "[bilikara:lark] background append queue is full; dropping best-effort indexing",
            file=lark_pool.sys.stderr,
            flush=True,
        )

    def test_background_append_scheduling_failure_is_contained(self):
        scheduler = lark_pool._BackgroundAppendScheduler(max_pending=1)
        with (
            patch.object(scheduler, "submit", side_effect=RuntimeError("scheduler failed")),
            patch.object(lark_pool, "_BACKGROUND_APPEND_SCHEDULER", scheduler),
            patch.object(
                lark_pool.rust_runtime,
                "cloudflare_service_request",
                side_effect=lark_pool.rust_runtime.RustRuntimeUnavailableError("missing"),
            ),
            patch("builtins.print") as mock_print,
        ):
            self.assertFalse(
                lark_pool.append_lark_pool_entries_in_background(
                    [{"bvid": "BV1xx411c7mD"}],
                )
            )

        mock_print.assert_called_once_with(
            "[bilikara:lark] background append scheduling failed: scheduler failed",
            file=lark_pool.sys.stderr,
            flush=True,
        )

    def test_background_append_thread_start_failure_is_contained(self):
        class FailingThread:
            def __init__(self, **_kwargs):
                pass

            def start(self):
                raise RuntimeError("thread unavailable")

        scheduler = lark_pool._BackgroundAppendScheduler(max_pending=1)
        with (
            patch.object(lark_pool.threading, "Thread", FailingThread),
            patch("builtins.print") as mock_print,
        ):
            self.assertFalse(scheduler.submit([{"bvid": "BV1xx411c7mD"}]))

        mock_print.assert_called_once_with(
            "[bilikara:lark] background append scheduling failed: thread unavailable",
            file=lark_pool.sys.stderr,
            flush=True,
        )

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

        def fake_cloudflare(operation, **request):
            self.assertEqual(operation, "append")
            requests.append(("POST", "/batch-add", {"records": request["entries"]}, request["timeout"]))
            return {"attempted": 1, "added": 1, "skipped_existing": 0, "feishu_queued": 1}

        with patch.object(lark_pool.rust_runtime, "cloudflare_service_request", side_effect=fake_cloudflare):
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

    def test_approve_cloudflare_review_items_falls_back_when_existing_bvid_is_skipped(self):
        pending_record = {
            "mid": "25773716",
            "bvid": "BV15kCRBsE4Q",
            "title": "☆酵哐★弗左仿市",
            "url": "https://www.bilibili.com/video/BV15kCRBsE4Q",
            "owner_name": "ilu渼",
            "preserved_3": "0",
        }
        approved_record = {**pending_record, "preserved_3": "1"}
        export_payloads = [[pending_record], [pending_record], [approved_record]]
        posts = []

        def fake_export(secret, *, limit=5000, timeout=120.0):
            self.assertEqual(secret, "secret")
            return export_payloads.pop(0)

        def fake_cloudflare(method, path, payload=None, *, timeout=12.0):
            posts.append((method, path, payload))
            if path == "/admin/delete-video":
                return {"success": True, "bvid": "BV15kCRBsE4Q", "deleted": True}
            return {"success": False, "error": "unexpected call"}

        def fake_append(operation, **request):
            self.assertEqual(operation, "append")
            posts.append(("POST", "/batch-add", {"records": request["entries"]}))
            batch_count = sum(1 for _, path, _ in posts if path == "/batch-add")
            if batch_count == 1:
                return {"attempted": 1, "added": 0, "updated_existing": 0, "skipped_existing": 1}
            return {"attempted": 1, "added": 1, "updated_existing": 0, "skipped_existing": 0}

        with (
            patch.object(lark_pool, "export_cloudflare_pool_records", side_effect=fake_export),
            patch.object(lark_pool, "_cloudflare_json", side_effect=fake_cloudflare),
            patch.object(lark_pool.rust_runtime, "cloudflare_service_request", side_effect=fake_append),
        ):
            result = lark_pool.approve_cloudflare_review_items(["BV15kCRBsE4Q"], "secret")

        self.assertEqual(result["approved"], 1)
        self.assertEqual(result["items"], [])
        self.assertEqual(result["upload"]["fallback_attempted"], 1)
        self.assertEqual(posts[0][1], "/batch-add")
        self.assertEqual(posts[1][1], "/admin/delete-video")
        self.assertEqual(posts[2][1], "/batch-add")
        self.assertEqual(posts[2][2]["records"][0]["preserved_3"], "1")

    def test_reject_cloudflare_review_item_posts_snapshot_to_blacklist_endpoint(self):
        requests = []

        def fake_cloudflare(method, path, payload=None, *, timeout=12.0):
            requests.append((method, path, payload, timeout))
            return {"success": True, "bvid": "BV1xx411c7mD", "blacklisted": True, "deleted": True}

        with patch.object(lark_pool, "_cloudflare_json", side_effect=fake_cloudflare):
            result = lark_pool.reject_cloudflare_review_item(
                "BV1xx411c7mD",
                "secret",
                record={"bvid": "BV1xx411c7mD", "title": "not karaoke"},
                rejected_by="VZRXS",
            )

        self.assertTrue(result["blacklisted"])
        self.assertEqual(requests[0][0:2], ("POST", "/admin/review/reject"))
        self.assertEqual(requests[0][2]["reason_code"], "not_karaoke")
        self.assertEqual(requests[0][2]["record"]["title"], "not karaoke")
        self.assertEqual(requests[0][2]["rejected_by"], "VZRXS")

    def test_list_cloudflare_blacklist_normalizes_pagination(self):
        requests = []

        def fake_cloudflare(method, path, payload=None, *, timeout=12.0):
            requests.append((method, path, payload, timeout))
            return {"success": True, "items": [], "total": 0, "has_more": False}

        with patch.object(lark_pool, "_cloudflare_json", side_effect=fake_cloudflare):
            result = lark_pool.list_cloudflare_blacklist(
                "secret",
                query=" macross ",
                limit=500,
                offset=-20,
            )

        self.assertTrue(result["success"])
        self.assertEqual(requests[0][0:2], ("POST", "/admin/blacklist/list"))
        self.assertEqual(requests[0][2]["query"], "macross")
        self.assertEqual(requests[0][2]["limit"], 100)
        self.assertEqual(requests[0][2]["offset"], 0)

    def test_restore_cloudflare_blacklist_item_preserves_restore_choice(self):
        requests = []

        def fake_cloudflare(method, path, payload=None, *, timeout=12.0):
            requests.append((method, path, payload, timeout))
            return {"success": True, "bvid": "BV1xx411c7mD", "restored_video": True}

        with patch.object(lark_pool, "_cloudflare_json", side_effect=fake_cloudflare):
            result = lark_pool.restore_cloudflare_blacklist_item(
                "BV1xx411c7mD",
                "secret",
                restore_video=True,
                restored_by="VZRXS",
            )

        self.assertTrue(result["restored_video"])
        self.assertEqual(requests[0][0:2], ("POST", "/admin/blacklist/restore"))
        self.assertTrue(requests[0][2]["restore_video"])
        self.assertEqual(requests[0][2]["restored_by"], "VZRXS")

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

    def test_verify_cloudflare_bilikara_secret_posts_secret(self):
        requests = []

        def fake_cloudflare(method, path, payload=None, *, timeout=12.0):
            requests.append((method, path, payload, timeout))
            return {"verified": True}

        with patch.object(lark_pool, "_cloudflare_json", side_effect=fake_cloudflare):
            result = lark_pool.verify_cloudflare_bilikara_secret("bilikara-secret")

        self.assertTrue(result["verified"])
        self.assertEqual(len(requests), 1)
        method, path, payload, timeout = requests[0]
        self.assertEqual(method, "POST")
        self.assertEqual(path, "/admin/verify")
        self.assertEqual(payload, {"BILIKARA_ADMIN_SECRET": "bilikara-secret"})
        self.assertEqual(timeout, 10)

    def test_trigger_cloudflare_maintenance_job_uses_admin_header(self):
        requests = []

        def fake_cloudflare(operation, **request):
            requests.append((operation, request))
            return {
                "payload": {
                    "success": True,
                    "job": "tagger-yomi",
                    "instance_id": "workflow-123",
                    "status": "queued",
                }
            }

        with patch.object(
            lark_pool.rust_runtime,
            "cloudflare_service_request",
            side_effect=fake_cloudflare,
        ):
            result = lark_pool.trigger_cloudflare_maintenance_job(
                "tagger-yomi",
                "bilikara-secret",
                requested_by="VZRXS",
            )

        self.assertTrue(result["success"])
        self.assertEqual(result["instance_id"], "workflow-123")
        self.assertEqual(len(requests), 1)
        operation, request = requests[0]
        self.assertEqual(operation, "request")
        self.assertEqual(request["method"], "POST")
        self.assertEqual(request["path"], "/admin/jobs/tagger-yomi")
        self.assertEqual(request["authorization"], "Bearer bilikara-secret")
        self.assertEqual(request["payload"], {"requested_by": "VZRXS"})

    def test_trigger_cloudflare_maintenance_job_rejects_local_monthly_job(self):
        with patch.object(lark_pool.rust_runtime, "cloudflare_service_request") as cloudflare:
            result = lark_pool.trigger_cloudflare_maintenance_job("monthly-d1-refresh", "secret")

        cloudflare.assert_not_called()
        self.assertFalse(result["success"])
        self.assertEqual(result["error"], "invalid maintenance job")

    def test_trigger_cloudflare_maintenance_job_bounds_requester_and_validates_payload(self):
        with patch.object(
            lark_pool.rust_runtime,
            "cloudflare_service_request",
            return_value={"unexpected": True},
        ) as cloudflare:
            result = lark_pool.trigger_cloudflare_maintenance_job(
                "tagger-yomi",
                "secret",
                requested_by="x" * 200,
            )

        self.assertFalse(result["success"])
        self.assertEqual(result["error"], "Cloudflare returned an invalid payload")
        self.assertEqual(cloudflare.call_args.kwargs["payload"], {"requested_by": "x" * 120})

    def test_reset_cloudflare_video_tags_posts_bvid_and_secret(self):
        requests = []

        def fake_cloudflare(method, path, payload=None, *, timeout=12.0):
            requests.append((method, path, payload, timeout))
            return {"success": True, "bvid": "BV1xx411c7mD", "changed": 1}

        with patch.object(lark_pool, "_cloudflare_json", side_effect=fake_cloudflare):
            result = lark_pool.reset_cloudflare_video_tags("BV1xx411c7mD", "bilikara-secret")

        self.assertTrue(result["success"])
        self.assertEqual(len(requests), 1)
        method, path, payload, timeout = requests[0]
        self.assertEqual(method, "POST")
        self.assertEqual(path, "/admin/reset-tags")
        self.assertEqual(payload, {"bvid": "BV1xx411c7mD", "BILIKARA_ADMIN_SECRET": "bilikara-secret"})
        self.assertEqual(timeout, 10)

    def test_reset_cloudflare_video_tags_rejects_invalid_bvid(self):
        with patch.object(lark_pool, "_cloudflare_json") as cloudflare:
            result = lark_pool.reset_cloudflare_video_tags("BVSHORT", "bilikara-secret")

        cloudflare.assert_not_called()
        self.assertFalse(result["success"])
        self.assertEqual(result["error"], "invalid bvid")

    def test_browse_d1_pool_posts_query_to_cloudflare(self):
        requests = []

        def fake_cloudflare(method, path, payload=None, *, timeout=12.0):
            requests.append((method, path, payload, timeout))
            return {
                "kind": "name",
                "letter": "W",
                "tags": [{"tag": "我推的孩子", "letter": "W", "locale": "zh", "count": 2}],
                "items": [
                    {
                        "bvid": "BV1xx411c7mD",
                        "title": "song",
                        "url": "https://www.bilibili.com/video/BV1xx411c7mD",
                    }
                ],
            }

        with patch.object(lark_pool, "_cloudflare_json", side_effect=fake_cloudflare):
            result = lark_pool.browse_d1_pool("name", letter="W", tag="我推的孩子", locale="zh")

        self.assertEqual(result["tags"][0]["tag"], "我推的孩子")
        self.assertEqual(result["items"][0]["bvid"], "BV1xx411c7mD")
        self.assertEqual(len(requests), 1)
        method, path, payload, timeout = requests[0]
        self.assertEqual(method, "GET")
        self.assertIn("/browse?", path)
        self.assertIn("kind=name", path)
        self.assertIn("letter=W", path)
        self.assertIsNone(payload)
        self.assertLessEqual(timeout, 2.0)

    def test_browse_d1_category_pool_uses_repeated_tags_and_offset(self):
        requests = []

        def fake_cloudflare(method, path, payload=None, *, timeout=12.0):
            requests.append((method, path, payload, timeout))
            return {
                "items": [
                    {
                        "bvid": "BV1xx411c7mD",
                        "title": "song",
                        "url": "https://www.bilibili.com/video/BV1xx411c7mD",
                    }
                ],
                "has_more": True,
                "next_offset": 120,
            }

        with (
            patch.object(lark_pool, "_cloudflare_json", side_effect=fake_cloudflare),
            patch.object(lark_pool, "_CLOUDFLARE_CATEGORY_TIMEOUT", 8.0),
        ):
            result = lark_pool.browse_d1_category_pool(["热血", "战斗"], query="op", offset=20, limit=100)

        self.assertEqual(result["items"][0]["bvid"], "BV1xx411c7mD")
        self.assertTrue(result["has_more"])
        self.assertEqual(result["next_offset"], 120)
        self.assertEqual(len(requests), 1)
        method, path, payload, timeout = requests[0]
        self.assertEqual(method, "GET")
        self.assertIn("/browse-category?", path)
        self.assertIn("tag=%E7%83%AD%E8%A1%80", path)
        self.assertIn("tag=%E6%88%98%E6%96%97", path)
        self.assertIn("q=op", path)
        self.assertIn("offset=20", path)
        self.assertIsNone(payload)
        self.assertEqual(timeout, 8.0)

    def test_browse_d1_category_pool_forwards_tag45s(self):
        requests = []

        def fake_cloudflare(method, path, payload=None, *, timeout=12.0):
            requests.append((method, path, payload, timeout))
            return {"items": [], "has_more": False, "next_offset": 0}

        with patch.object(lark_pool, "_cloudflare_json", side_effect=fake_cloudflare):
            result = lark_pool.browse_d1_category_pool(["Hololive"], tag45s=["乙女"], limit=100)

        self.assertEqual(result["items"], [])
        self.assertEqual(len(requests), 1)
        method, path, payload, timeout = requests[0]
        self.assertEqual(method, "GET")
        self.assertIn("tag=Hololive", path)
        self.assertIn("tag45=%E4%B9%99%E5%A5%B3", path)
        self.assertIsNone(payload)
        self.assertEqual(timeout, lark_pool._CLOUDFLARE_CATEGORY_TIMEOUT)


if __name__ == "__main__":
    unittest.main()
