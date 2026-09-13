import unittest
from unittest.mock import patch

import bilikara.shared_catalog as catalog


class BackgroundAppendTest(unittest.TestCase):
    def setUp(self):
        self.request = self.enterContext(patch.object(
            catalog.rust_runtime, "cloudflare_service_request",
            return_value={"accepted": True, "count": 1},
        ))
        self.diagnostic = self.enterContext(patch("builtins.print"))
        self.enterContext(patch.object(catalog, "_CLOUDFLARE_API_URL", "http://127.0.0.1:1"))
        self.secondary_paths = [
            self.enterContext(patch.object(owner, name))
            for owner, name in (
                (catalog, "append_cloudflare_pool_entries"),
                (catalog, "normalize_pool_entry"),
                (catalog.rust_runtime, "json_http_request"),
            )
        ]
        self.entries = [{"bvid": "BV1xx411c7mD", "title": " Song ",
                         "mid": "", "owner_mid": "42", "played_count": 7}]

    def tearDown(self):
        for path in self.secondary_paths:
            path.assert_not_called()

    def test_native_acceptance_only_enqueues_copied_dictionaries(self):
        entries = [None, *self.entries, "ignored", {}, self.entries[0]]
        self.assertIs(catalog.append_catalog_entries_in_background(entries), True)
        self.request.assert_called_once_with(
            "enqueue_append",
            base_url="http://127.0.0.1:1",
            user_agent=f"bilikara/{getattr(catalog.cfg, 'APP_VERSION', 'dev')} (+https://github.com/VZRXS/bilikara)",
            timeout=20,
            entries=[self.entries[0], {}, self.entries[0]],
        )
        copied = self.request.call_args.kwargs["entries"]
        self.assertIsNot(copied[0], self.entries[0])
        self.assertIsNot(copied[2], self.entries[0])
        self.assertIsNot(copied[0], copied[2])
        self.diagnostic.assert_not_called()

    def test_injected_native_rejection_and_invalid_acceptance_do_not_retry(self):
        # Adapter injection proves routing, not real Rust queue saturation.
        for result in (
            {"accepted": False},
            {"accepted": False, "count": 1, "reason": "queue_full"},
            {"accepted": False, "count": 0},
            {}, None, [],
            *({"accepted": value} for value in (None, 0, 1, "false", "true", [], {})),
        ):
            with self.subTest(result=result):
                self.request.reset_mock()
                self.request.return_value = result
                self.assertIs(catalog.append_catalog_entries_in_background(self.entries), False)
                self.request.assert_called_once()
                self.assertEqual(self.request.call_args.args, ("enqueue_append",))
        self.diagnostic.assert_not_called()

    def test_unavailable_and_service_exceptions_are_contained_and_redacted(self):
        sensitive = "private title cookie authorization https://signed.invalid/?token=secret raw body"
        for error, kind in (
            (catalog.rust_runtime.RustRuntimeUnavailableError(sensitive), "runtime_unavailable"),
            (catalog.rust_runtime.RustRuntimeServiceError(
                "queue_unavailable", sensitive, response={"body_preview": sensitive},
            ), "scheduling_error"),
            (RuntimeError(sensitive), "scheduling_error"),
        ):
            with self.subTest(error=type(error).__name__):
                self.request.reset_mock()
                self.diagnostic.reset_mock()
                self.request.side_effect = error
                self.assertIs(catalog.append_catalog_entries_in_background(self.entries), False)
                self.request.assert_called_once()
                self.assertEqual(self.request.call_args.args, ("enqueue_append",))
                self.diagnostic.assert_called_once_with(
                    f"[bilikara:catalog] background append rejected: {kind} ({type(error).__name__})",
                    file=catalog.sys.stderr, flush=True,
                )

    def test_empty_filtered_input_never_enters_runtime(self):
        for entries in ([], [None, 42, "ignored", []]):
            with self.subTest(entries=entries):
                self.assertIs(catalog.append_catalog_entries_in_background(entries), False)
        self.request.assert_not_called()
        self.diagnostic.assert_not_called()



import http.server
import json
import threading
import urllib.parse
from pathlib import Path


class CatalogFixtureTest(unittest.TestCase):
    """Real Python -> C ABI -> shared Rust -> loopback HTTP, never live writes."""
    def setUp(self):
        self.calls = []
        self.reply = lambda method, path, body, headers: (200, [])
        case = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.serve()

            def do_POST(self):
                self.serve()

            def serve(self):
                body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                body = json.loads(body) if body else None
                case.calls.append((self.command, self.path, body, {k.title(): v for k, v in self.headers.items()}))
                reply = case.reply(self.command, self.path, body, self.headers)
                status, response = reply[:2]
                data = response if isinstance(response, bytes) else json.dumps(response, ensure_ascii=False).encode()
                self.send_response(status)
                self.send_header("Content-Type", reply[2].get("Content-Type", "application/json") if len(reply) == 3 else "application/json")
                self.send_header("Content-Length", str(len(data)))
                if len(reply) == 3:
                    for key, value in reply[2].items():
                        if key.lower() != "content-type":
                            self.send_header(key, value)
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval":0.01}, daemon=True)
        self.thread.start()
        self.enterContext(patch.object(catalog, "_CLOUDFLARE_API_URL", f"http://127.0.0.1:{self.server.server_port}"))
        self.addCleanup(self.close)
        self.item = {"bvid":"BV1xx411c7mD", "title":"歌曲, \"日本語\"\n🎶", "mid":42, "preserved_1":3.5, "tag_1":"动画"}

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.assertFalse(self.thread.is_alive())

    def test_d1_success_normalizes_and_deduplicates_with_optional_fields_missing(self):
        self.reply = lambda *_: (200, {"data":{"items":[self.item,self.item,{"bvid":"bad","title":"invalid"},{"bvid":"BV1yy411c7mD","title":" plain ","url":"javascript:evil"}]}})
        result = catalog.search_catalog("日本語")
        self.assertEqual(len(result),2)
        self.assertEqual(result[0]["title"], self.item["title"])
        self.assertEqual(result[0]["mid"], "42")
        self.assertEqual(result[0]["preserved_1"], "3.5")
        self.assertEqual(result[1]["url"], "https://www.bilibili.com/video/BV1yy411c7mD")
        self.assertEqual(result[1]["source"], "cloudflare")
        self.assertNotIn("tag_1",result[1])
        self.assertNotIn("preserved_1",result[1])
        self.assertEqual(catalog.search_catalog("日本語"), result)
        self.assertEqual(len(self.calls),1)
        self.assertEqual(self.calls[0][0],"GET")
        self.assertNotIn("Authorization",self.calls[0][3])
        self.assertEqual(urllib.parse.parse_qs(urllib.parse.urlsplit(self.calls[0][1]).query)["keyword"],["日本語"])

    def test_empty_primary_result_is_success_without_fallback(self):
        self.assertEqual(catalog.search_catalog("missing"),[])
        self.assertEqual(catalog.search_catalog("missing"),[])
        self.assertEqual(len(self.calls),1)
        self.assertEqual(catalog.search_catalog(""),[])
        self.assertEqual(len(self.calls),1)

    def test_prewarm_uses_shared_read_and_contains_failure(self):
        self.assertTrue(catalog.prewarm_cloudflare_pool())
        self.assertIn("keyword=VZRXS",self.calls[0][1])
        with patch.object(catalog,"read_catalog",side_effect=catalog.CatalogError("fixture")):
            self.assertFalse(catalog.prewarm_cloudflare_pool())

    def test_alias_shares_cache_and_table_selection_is_retired(self):
        self.assertEqual(catalog.read_catalog("/api/lark/search","q=alias"),catalog.read_catalog("/api/catalog/search","q=alias"))
        self.assertEqual(len(self.calls),1)
        for query in ["q=x&table=1","q=x&table="]:
            with self.assertRaises(catalog.CatalogError) as error:
                catalog.read_catalog("/api/lark/search",query)
            self.assertEqual(error.exception.status_code,410)
            self.assertEqual(error.exception.code,"catalog_table_retired")
        self.assertEqual(len(self.calls),1)

    def test_custom_d1_does_not_inherit_an_unrelated_sheets_catalog(self):
        self.reply = lambda *_: (503, {"error":"private upstream token"})
        with self.assertRaises(catalog.CatalogError) as error:
            catalog.search_catalog("outage")
        self.assertEqual(error.exception.status_code,503)
        self.assertNotIn("private",str(error.exception))
        with self.assertRaises(catalog.CatalogError):
            catalog.search_catalog("another")
        self.assertEqual(len(self.calls),1,"shared outage backoff")

    def test_authorization_and_validation_failures_remain_failures(self):
        for status in [400,401,403,404,422]:
            self.reply = lambda *_, status=status: (status, {"error":"denied"})
            with self.assertRaises(catalog.CatalogError) as error:
                catalog.search_catalog(f"status{status}")
            self.assertEqual(error.exception.status_code,status)
        self.assertEqual(len(self.calls),5)
        self.reply = lambda *_: (200, {"ok":False,"code":403,"items":[]})
        with self.assertRaises(catalog.CatalogError) as error:
            catalog.search_catalog("semantic-auth")
        self.assertEqual(error.exception.status_code,403)

    def test_malformed_source_and_auth_html_are_errors(self):
        for raw in [b'<html><form action="https://accounts.google.com">Sign in</form></html>',b'not json',b'{"bad":[]}',b'{"data":{"error":"denied","items":[]}}']:
            # Distinct configured fixture URL keys isolate backoff without sleeping.
            with patch.object(catalog,"_CLOUDFLARE_API_URL",f"http://127.0.0.1:{self.server.server_port}/{len(self.calls)}"):
                self.reply = lambda *_, raw=raw: (200,raw)
                with self.assertRaises(catalog.CatalogError):
                    catalog.search_catalog("malformed")
        self.assertEqual(len(self.calls),4)

    def test_browse_preserves_worker_pagination_and_category_tags(self):
        self.reply = lambda *_: (200, {"items":[self.item],"tags":[{"tag":"歌手","count":12}],"has_more":True,"next_offset":200})
        page = catalog.browse_d1_pool("artist",tag="歌手",offset=100)
        self.assertEqual(page["next_offset"],200)
        self.assertIs(page["has_more"],True)
        self.assertEqual(page["tags"][0]["count"],12)
        result = catalog.browse_d1_category_pool(["热血","战斗","热血"],tag45s=["乙女"],query="op",offset=20)
        query=urllib.parse.parse_qs(urllib.parse.urlsplit(self.calls[-1][1]).query)
        self.assertEqual(set(query["tag"]),{"热血","战斗"})
        self.assertEqual(query["tag45"],["乙女"])
        self.assertEqual(query["offset"],["20"])
        self.assertEqual(result["items"][0]["bvid"],self.item["bvid"])
        self.reply=lambda *_:(200,{"items":[],"tags":[]})
        page=catalog.browse_d1_pool("name",query="legacy")
        for key in ["has_more","next_offset","offset"]:
            self.assertNotIn(key,page)
        count=len(self.calls)
        self.assertEqual(catalog.browse_d1_category_pool([])["items"],[])
        self.assertEqual(len(self.calls),count)

    def test_invalid_pagination_does_not_reach_network(self):
        for path,query in [("/api/catalog/search","q=x&limit=99999"),("/api/d1/browse","offset=100001"),("/api/d1/category-browse","tag=x&offset=-1"),("/api/admin","")]:
            with self.assertRaises(catalog.CatalogError):
                catalog.read_catalog(path,query)
        self.assertEqual(self.calls,[])

    def test_append_normalization_existing_counters_and_invalid_entries(self):
        self.reply=lambda *_:(200,{"added":1,"skipped_existing":2,"feishu_queued":1})
        result=catalog.append_cloudflare_pool_entries([self.item,self.item,{"bvid":"BVSHORT","title":"invalid"}])
        self.assertEqual(result["attempted"],1)
        self.assertEqual(result["added"],1)
        self.assertEqual(result["feishu_queued"],1)
        method,path,body,_=self.calls[0]
        self.assertEqual((method,path),("POST","/batch-add"))
        self.assertEqual(len(body["records"]),1)
        self.assertEqual(body["records"][0]["preserved_1"],"3.5")
        self.assertEqual(catalog.append_cloudflare_pool_entries([{"bvid":"BVSHORT","title":"invalid"}]),{"attempted":0,"added":0})
        self.assertEqual(len(self.calls),1)
        self.assertIsNone(catalog.normalize_pool_entry({"bvid":"BVSHORT","title":"invalid"}))
        self.assertEqual(catalog.normalize_pool_entry(self.item)["bvid"],self.item["bvid"])

    def test_pending_review_filters_keywords_deduplicates_and_limits(self):
        records=[self.item,self.item,{**self.item,"bvid":"BV1yy411c7mD","title":"カラオケ accepted"},{**self.item,"bvid":"BV1zz411c7mD","preserved_3":"1"}]
        self.reply=lambda *_:(200,{"data":{"items":records}})
        with patch.object(catalog.cfg,"GATCHA_KEYWORDS",("カラオケ",)):
            result=catalog.pending_cloudflare_review_items(" fixture-secret ",limit=1)
        self.assertEqual(result["total_pending"],1)
        self.assertEqual(result["export_count"],4)
        self.assertEqual(len(result["items"]),1)
        self.assertEqual(self.calls[0][3]["Authorization"],"Bearer fixture-secret")
        self.assertIn("all=1",self.calls[0][1])

    def test_approval_preserves_existing_privileged_update_sequence(self):
        pending={**self.item,"preserved_3":"0"}
        exports=iter([[pending],[pending],[{**pending,"preserved_3":"1"}]])
        def reply(method,path,body,headers):
            if path.startswith("/export?"):
                return 200,next(exports)
            if path=="/batch-add":
                return 200,{"added":0,"skipped_existing":1} if len([c for c in self.calls if c[1]==path])==1 else {"added":1}
            if path=="/admin/delete-video":
                self.assertEqual(body["BILIKARA_ADMIN_SECRET"],"fixture-secret")
                return 200,{"success":True,"deleted":True}
            self.fail(f"unexpected local fixture request {path}")
        self.reply=reply
        result=catalog.approve_cloudflare_review_items([self.item["bvid"],self.item["bvid"],"bad"],"fixture-secret")
        self.assertEqual(result["approved"],1)
        self.assertEqual(result["items"],[])
        self.assertEqual(result["upload"]["fallback_attempted"],1)
        posts=[c for c in self.calls if c[0]=="POST"]
        self.assertEqual([c[1] for c in posts],["/batch-add","/admin/delete-video","/batch-add"])
        self.assertEqual(posts[-1][2]["records"][0]["preserved_3"],"1")

    def test_review_reject_blacklist_restore_and_delete_preserve_protocol(self):
        self.reply=lambda *_:(200,{"success":True,"deleted":True,"feishu_queued":True,"items":[]})
        calls=[
            (lambda:catalog.reject_cloudflare_review_item(self.item["bvid"],"fixture-secret",record=self.item,rejected_by="host"),"/admin/review/reject"),
            (lambda:catalog.list_cloudflare_blacklist("fixture-secret",query="test",limit=500,offset=-4,include_inactive=True),"/admin/blacklist/list"),
            (lambda:catalog.restore_cloudflare_blacklist_item(self.item["bvid"],"fixture-secret",restore_video=True,restored_by="host"),"/admin/blacklist/restore"),
            (lambda:catalog.delete_cloudflare_pool_entry(self.item["bvid"]),"/delete-invalid"),
            (lambda:catalog.delete_cloudflare_video_entry(self.item["bvid"],"fixture-secret"),"/admin/delete-video"),
            (lambda:catalog.delete_cloudflare_mid_entries("42","fixture-secret"),"/admin/delete-mid"),
            (lambda:catalog.reset_cloudflare_video_tags(self.item["bvid"],"fixture-secret"),"/admin/reset-tags"),
        ]
        for call,path in calls:
            result=call()
            self.assertIs(result["success"],True)
            self.assertIs(result["feishu_queued"],True)
            self.assertEqual(self.calls[-1][1],path)
        self.assertEqual(self.calls[0][2]["record"],self.item)
        self.assertEqual(self.calls[0][2]["reason_code"],"not_karaoke")
        self.assertEqual(self.calls[0][2]["source"],"pending_review")
        self.assertEqual(self.calls[1][2]["limit"],100)
        self.assertEqual(self.calls[1][2]["offset"],0)
        self.assertIs(self.calls[2][2]["restore_video"],True)
        self.assertEqual(self.calls[3][2],{"bvid":self.item["bvid"]})
        self.reply=lambda *_:(200,{"success":True})
        self.assertEqual(catalog.delete_cloudflare_pool_entry(self.item["bvid"]),{
            "success":True,"bvid":self.item["bvid"],"found":False,"deleted":False,"feishu_queued":False,"error":"",
        })

    def test_invalid_mutations_do_not_make_requests(self):
        results=[catalog.reject_cloudflare_review_item("bad","fixture"),catalog.restore_cloudflare_blacklist_item(self.item["bvid"],""),catalog.delete_cloudflare_pool_entry("bad"),catalog.delete_cloudflare_video_entry("bad","fixture"),catalog.delete_cloudflare_mid_entries("-1","fixture"),catalog.reset_cloudflare_video_tags("bad","fixture"),catalog.verify_cloudflare_bilikara_secret(""),catalog.trigger_cloudflare_maintenance_job("monthly-d1-refresh","fixture"),catalog.submit_cloudflare_song_rating(session_user_name="u",play_id="p",bvid=self.item["bvid"],score=6)]
        for result in results:
            self.assertIs(result["success"],False)
            self.assertTrue(result["error"])
        self.assertEqual(self.calls,[])

    def test_rating_verification_and_maintenance_headers(self):
        self.reply=lambda *_:(200,{"success":True})
        result=catalog.submit_cloudflare_song_rating(session_user_name=" user ",play_id=" play ",bvid=self.item["bvid"],score="4")
        self.assertIs(result["success"],True)
        self.assertEqual(self.calls[-1][2],{"session_user_name":"user","play_id":"play","bvid":self.item["bvid"],"score":4})
        self.assertIs(catalog.verify_cloudflare_bilikara_secret("fixture-secret")["verified"],True)
        result=catalog.trigger_cloudflare_maintenance_job(" TAGGER-YOMI ","fixture-secret",requested_by="日"*140)
        self.assertIs(result["success"],True)
        self.assertEqual(self.calls[-1][1],"/admin/jobs/tagger-yomi")
        self.assertEqual(self.calls[-1][2],{"requested_by":"日"*120})
        self.assertEqual(self.calls[-1][3]["Authorization"],"Bearer fixture-secret")
        self.assertNotIn("BILIKARA_ADMIN_SECRET",self.calls[-1][2])

    def test_privileged_failure_and_malformed_mutation_never_fallback(self):
        self.reply=lambda *_:(403,{"error":"private secret"})
        result=catalog.reset_cloudflare_video_tags(self.item["bvid"],"fixture-secret")
        self.assertIs(result["success"],False)
        self.assertEqual(result["status_code"],403)
        self.assertNotIn("private",result["error"])
        self.assertEqual(len(self.calls),1)
        self.reply=lambda *_:(200,[])
        result=catalog.trigger_cloudflare_maintenance_job("tagger-yomi","fixture-secret")
        self.assertIs(result["success"],False)
        self.assertIn("invalid payload",result["error"])

    def test_privileged_redirect_never_forwards_credentials(self):
        self.reply=lambda *_:(307,{}, {"Location":f"http://127.0.0.1:{self.server.server_port}/capture"})
        result=catalog.verify_cloudflare_bilikara_secret("fixture-secret")
        self.assertIs(result["success"],False)
        self.assertEqual(len(self.calls),1)
        self.assertEqual(self.calls[0][1],"/admin/verify")

    def test_mutations_invalidate_cached_catalog(self):
        self.reply=lambda method,*_:(200,[self.item] if method=="GET" else {"success":True,"deleted":True})
        self.assertEqual(len(catalog.search_catalog("delete")),1)
        catalog.delete_cloudflare_video_entry(self.item["bvid"],"fixture-secret")
        self.reply=lambda *_:(200,[])
        self.assertEqual(catalog.search_catalog("delete"),[])
        self.assertEqual(len(self.calls),3)

    def test_concurrent_ffi_search_rejects_duplicate_and_refreshes_once(self):
        entered=threading.Event()
        release=threading.Event()
        def reply(*_):
            entered.set()
            self.assertTrue(release.wait(5))
            return 200,[self.item]
        self.reply=reply
        results=[]
        worker=threading.Thread(target=lambda: results.append(catalog.search_catalog("concurrent")))
        worker.start()
        try:
            self.assertTrue(entered.wait(3))
            with self.assertRaises(catalog.CatalogError) as error:
                catalog.search_catalog("concurrent")
            self.assertEqual(error.exception.code,"catalog_busy")
        finally:
            release.set()
            worker.join(5)
        self.assertFalse(worker.is_alive())
        self.assertEqual(catalog.search_catalog("concurrent"),results[0])
        self.assertEqual(len(self.calls),1)

    def test_python_http_and_internet_adapters_use_shared_rust_results(self):
        from tests.test_transport_concurrency import DesktopFixture
        from bilikara import server, internet_remote
        from urllib.request import urlopen
        from urllib.error import HTTPError
        self.reply=lambda *_:(200,[self.item])
        with DesktopFixture() as host, patch.object(server,"annotate_gatcha_local_status",side_effect=lambda x:x), patch.object(internet_remote,"annotate_gatcha_local_status",side_effect=lambda x:x):
            with urlopen(host.base+"/api/catalog/search?q=adapters&limit=80",timeout=5) as response:
                result=json.load(response)
            self.assertEqual(result["data"]["items"][0]["bvid"],self.item["bvid"])
            status,remote=host.remote("catalog.search",{"query":"adapters","limit":80},lane="bulk")
            self.assertEqual(status,200)
            self.assertEqual(remote["data"]["data"]["items"][0]["bvid"],self.item["bvid"])
            self.assertEqual(remote["data"]["data"]["items"][0]["source"],"cloudflare")
            self.assertEqual(len(self.calls),1,"Python HTTP and Internet requests share Rust's cache")
            with urlopen(host.base+"/api/lark/search?q=adapters&limit=80",timeout=5) as response:
                self.assertEqual(json.load(response)["data"],result["data"])
            with self.assertRaises(HTTPError) as error:
                urlopen(host.base+"/api/lark/search?q=x&table=1",timeout=5)
            self.assertEqual(error.exception.code,410)
            error.exception.close()
            with self.assertRaises(HTTPError) as error:
                urlopen(host.base+"/api/catalog/search?q=x&limit=99999",timeout=5)
            self.assertEqual(error.exception.code,400)
            error.exception.close()
            self.reply=lambda *_:(403,{"error":"denied"})
            status,remote=host.remote("catalog.search",{"query":"denied","limit":80},lane="bulk")
            self.assertEqual(status,403)
            self.assertFalse(remote["ok"])
            self.assertEqual(remote["code"],"catalog_forbidden")

    def test_no_direct_feishu_implementation_or_credentials_remain(self):
        self.assertFalse(Path("bilikara/lark_pool_client.py").exists())
        for path in [*Path("bilikara").glob("*.py"),*Path("rust-runtime/src/shared_catalog").glob("*.rs")]:
            source=path.read_text()
            for retired in ["open.feishu.cn", "BILIKARA_LARK_APP_SECRET", "tenant_access_token/internal"]:
                self.assertNotIn(retired,source,path)


class CatalogAdapterValidationTest(unittest.TestCase):
    def test_missing_native_runtime_never_runs_python_policy(self):
        with patch.object(catalog.rust_runtime,"shared_catalog_request",side_effect=catalog.rust_runtime.RustRuntimeUnavailableError("fixture")):
            with self.assertRaises(catalog.CatalogError):
                catalog.search_catalog("song")

    def test_native_result_shape_is_validated(self):
        for result in [None,[],{"items":None},{"items":["bad"]}]:
            with patch.object(catalog.rust_runtime,"shared_catalog_request",return_value=result):
                with self.assertRaises(catalog.CatalogError):
                    catalog.search_catalog("song")


class SheetsFixtureTest(unittest.TestCase):
    setUp = CatalogFixtureTest.setUp
    close = CatalogFixtureTest.close

    def enable_sheets(self):
        import os
        self.enterContext(patch.dict(os.environ, {"BILIKARA_CATALOG_SHEETS_URL": f"http://127.0.0.1:{self.server.server_port}/catalog.csv"}))
        self.csv = 'bvid,title,url,mid,owner_name,tag_1\nBV1xx411c7mD,"歌曲, ""日本語""",,42,fixture,动画\n'.encode()
        self.reply = lambda method, path, *_: (200, self.csv, {"Content-Type":"text/csv; charset=utf-8"}) if path == "/catalog.csv" else (503, {"error":"outage"})

    def test_python_ffi_fallback_cache_and_known_deletion(self):
        self.enable_sheets()
        result = catalog.search_catalog("日本語")
        self.assertEqual(result[0]["source"], "sheets")
        self.assertNotIn("rank", result[0])
        self.assertEqual(catalog.search_catalog("动画"), result)
        self.assertEqual(len(self.calls), 2)
        self.assertTrue(all(c[0] == "GET" for c in self.calls))
        self.assertTrue(all("Authorization" not in c[3] and "Cookie" not in c[3] for c in self.calls))
        original = self.reply
        self.reply = lambda method, *args: (200,{"success":True,"deleted":True}) if method == "POST" else original(method,*args)
        self.assertTrue(catalog.delete_cloudflare_video_entry("BV1xx411c7mD", "local-fixture")["success"])
        self.assertEqual(catalog.search_catalog("日本語"), [])
        self.assertEqual([c[1] for c in self.calls if c[0] == "POST"], ["/admin/delete-video"])

    def test_both_providers_unavailable_html_malformed_and_redirect(self):
        self.enable_sheets()
        for suffix, response in [
            ("html", (200,b'<html>sign in</html>',{"Content-Type":"text/html"})),
            ("fakecsv", (200,b'<html>sign in</html>',{"Content-Type":"text/csv"})),
            ("quotes", (200,b'bvid,title,url,mid,owner_name\nBV1xx411c7mD,"unterminated,,,',{"Content-Type":"text/csv"})),
            ("redirect", (302,b'',{"Location":"/never-follow","Content-Type":"text/csv"})),
            ("unavailable", (503,b'',{"Content-Type":"text/csv"})),
            ("partial", (206,b'',{"Content-Type":"text/csv"})),
        ]:
            with self.subTest(suffix=suffix), patch.object(catalog,"_CLOUDFLARE_API_URL",f"http://127.0.0.1:{self.server.server_port}/{suffix}"):
                self.reply = lambda method,path,*_, response=response: response if path == "/catalog.csv" else (503,{})
                with self.assertRaises(catalog.CatalogError) as error:
                    catalog.search_catalog("fixture")
                self.assertEqual(error.exception.code,"catalog_providers_unavailable")
        self.assertFalse(any(c[1] == "/never-follow" for c in self.calls))

    def test_python_http_and_internet_share_sheets_results(self):
        self.enable_sheets()
        from tests.test_transport_concurrency import DesktopFixture
        from bilikara import server, internet_remote
        from urllib.request import urlopen
        with DesktopFixture() as host, patch.object(server,"annotate_gatcha_local_status",side_effect=lambda x:x), patch.object(internet_remote,"annotate_gatcha_local_status",side_effect=lambda x:x):
            with urlopen(host.base+"/api/catalog/search?q=fixture&limit=80",timeout=5) as response:
                result=json.load(response)["data"]
            self.assertEqual(result["items"][0]["source"],"sheets")
            self.assertIn("unverified",result["exclusion_coverage"])
            status, remote = host.remote("catalog.search",{"query":"动画","limit":80},lane="bulk")
            self.assertEqual(status,200)
            remote_item = remote["data"]["data"]["items"][0]
            for key in ["bvid", "title", "source", "tag_1", "mid", "owner_name"]:
                self.assertEqual(remote_item[key], result["items"][0][key])
            self.assertEqual(remote_item["catalog_item_id"], result["items"][0]["bvid"])
            self.assertNotIn("rank", remote_item)
            self.assertNotIn("preserved_1", remote_item)
            self.assertEqual(len(self.calls),2,"one D1 request and one snapshot shared across adapters and keywords")

    def test_enabled_fallback_preserves_primary_empty_auth_and_mutation_failures(self):
        self.enable_sheets()
        self.reply = lambda *_: (200, [])
        self.assertEqual(catalog.search_catalog("empty"), [])
        for status in [400,401,403,422]:
            self.reply = lambda *_, status=status: (status,{"error":"denied"})
            with self.assertRaises(catalog.CatalogError) as error:
                catalog.search_catalog(f"auth{status}")
            self.assertEqual(error.exception.status_code,status)
        self.reply = lambda *_: (503,{})
        self.assertFalse(catalog.verify_cloudflare_bilikara_secret("local-fixture")["success"])
        self.assertFalse(any(c[1] == "/catalog.csv" for c in self.calls))

    def test_concurrent_ffi_snapshot_refresh_is_bounded(self):
        self.enable_sheets()
        entered, release = threading.Event(), threading.Event()
        original = self.reply
        def reply(method,path,*args):
            if path == "/catalog.csv":
                entered.set()
                self.assertTrue(release.wait(5))
            return original(method,path,*args)
        self.reply = reply
        result, errors = [], []
        def search():
            try:
                result.extend(catalog.search_catalog("日本語"))
            except Exception as exc:
                errors.append(exc)
        worker = threading.Thread(target=search)
        worker.start()
        try:
            self.assertTrue(entered.wait(3))
            with self.assertRaises(catalog.CatalogError) as error:
                catalog.search_catalog("动画")
            self.assertEqual(error.exception.code,"catalog_busy")
        finally:
            release.set()
            worker.join(5)
        self.assertFalse(worker.is_alive())
        self.assertEqual(errors,[])
        self.assertEqual(catalog.search_catalog("动画"),result)
        self.assertEqual(len(self.calls),2)


    def test_snapshot_refresh_has_independent_budget_from_d1_search(self):
        import time
        self.enable_sheets()
        original = self.reply
        def reply(method, path, *args):
            if path == "/catalog.csv":
                time.sleep(3)
            return original(method, path, *args)
        self.reply = reply
        with patch.object(catalog, "_CLOUDFLARE_SEARCH_TIMEOUT", 2.0):
            items = catalog.search_catalog("日本語")
            self.assertEqual(items[0]["source"], "sheets")
            self.assertEqual(catalog.search_catalog("动画"), items)
        self.assertEqual(len(self.calls), 2, "one failed D1 read and one slow snapshot, then cache reuse")
