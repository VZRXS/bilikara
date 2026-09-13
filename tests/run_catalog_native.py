"""Native Host + native Internet adapter fixture; requires native_host_alpha."""
from __future__ import annotations
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import urllib.error
import urllib.parse
import urllib.request
import uuid
from tests.test_shared_catalog import CatalogFixtureTest


class NativeCatalogTest(CatalogFixtureTest):
    def test_native_host_and_internet_share_catalog_and_permissions(self):
        self.run_native_catalog("cloudflare")

    def test_native_host_and_internet_share_read_only_sheets_fallback(self):
        self.run_native_catalog("sheets")

    def run_native_catalog(self, source):
        root=Path(__file__).resolve().parents[1]
        binary=root/"rust-runtime/target/debug/examples/native_host_alpha"
        self.assertTrue(binary.is_file(),"Build the native-host example before this test")
        self.reply=lambda *_:(200,[self.item])
        if source == "sheets":
            csv=b'bvid,title,url,mid,owner_name\nBV1xx411c7mD,native,,,fixture\n'
            self.reply=lambda method,path,*_:(200,csv,{"Content-Type":"text/csv"}) if path == "/catalog.csv" else (503,{})
        with tempfile.TemporaryDirectory(prefix="bilikara-catalog-native-") as home:
            env={**os.environ,"BILIKARA_CF_API_URL":f"http://127.0.0.1:{self.server.server_port}"}
            env["BILIKARA_CATALOG_SHEETS_URL"] = f"http://127.0.0.1:{self.server.server_port}/catalog.csv" if source == "sheets" else ""
            with tempfile.TemporaryFile(mode="w+") as errors:
                process=subprocess.Popen([str(binary),home,str(root/"static")],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=errors,text=True,env=env)
                try:
                    # The private bootstrap value is consumed here, never logged.
                    bootstrap=json.loads(process.stdout.readline())["bootstrap_url"]
                    base=urllib.parse.urlunsplit((*urllib.parse.urlsplit(bootstrap)[:2],"","",""))
                    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
                    with opener.open(bootstrap,timeout=5) as response:
                        cookie=response.headers["Set-Cookie"].split(";",1)[0]
                    def call(path,body=None,*,authenticated=True):
                        headers={"Content-Type":"application/json"}
                        if authenticated:
                            headers["Cookie"]=cookie
                        request=urllib.request.Request(base+path,json.dumps(body).encode() if body is not None else None,headers)
                        try:
                            response=opener.open(request,timeout=5)
                        except urllib.error.HTTPError as error:
                            response=error
                        with response:
                            return response.status,json.load(response)
                    self.assertEqual(call("/api/catalog/search?q=native",authenticated=False)[0],403)
                    status,result=call("/api/catalog/search?q=native&limit=80")
                    self.assertEqual(status,200)
                    self.assertEqual(result["data"]["items"][0]["bvid"],self.item["bvid"])
                    self.assertEqual(call("/api/lark/search?q=native&limit=80")[1],result)
                    self.assertEqual(call("/api/lark/search?q=native&table=1")[0],410)
                    epoch="abcdefghijklmnopqrstuv"
                    self.assertEqual(call("/api/internet-remote/peer/open",{"peer_id":"catalog-fixture","epoch":epoch})[0],200)
                    status,remote=call("/api/internet-remote/dispatch",{
                        "peer_id":"catalog-fixture","lane":"bulk","message":json.dumps({"v":1,"lane":"bulk","epoch":epoch,"seq":1,"id":str(uuid.uuid4()),"kind":"catalog.search","body":{"query":"native","limit":80}}),
                    })
                    self.assertEqual(status,200)
                    self.assertEqual(remote["data"]["data"]["items"][0]["bvid"],self.item["bvid"])
                    self.assertEqual(remote["data"]["data"]["items"][0]["source"],source)
                    self.assertEqual(len(self.calls),2 if source == "sheets" else 1,"Native HTTP and Internet adapters share Rust caches")
                    self.assertTrue(all(c[0]=="GET" for c in self.calls))
                finally:
                    if process.poll() is None:
                        process.communicate("\n",timeout=15)
                    self.assertEqual(process.returncode,0)


if __name__=="__main__":
    result=unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite([NativeCatalogTest("test_native_host_and_internet_share_catalog_and_permissions"),NativeCatalogTest("test_native_host_and_internet_share_read_only_sheets_fallback")]))
    raise SystemExit(not result.wasSuccessful())
