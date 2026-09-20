"""Local TLS/HTTP fixture for the real Rust video ABI. Never forwards traffic.

The checked-in key is deliberately public, exclusively for this test server.
The test CA is trusted only within the fixture environment, not installed.
"""
import functools
import json
import os
import ssl
import sys
import unittest
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch


class VideoFixture:
    def __init__(self):
        self.return_value = {"code": 0, "data": {
            "aid": 123, "bvid": "BV1xx411c7mD", "title": " 歌曲 🎤 ",
            "pic": "http://example.invalid/cover.jpg",
            "owner": {"mid": 42, "name": " UP 主 "},
            "pages": [{"page": 1, "cid": 456, "duration": 123, "part": " 原唱 "}],
        }}
        self.before_response = None
        self.status = 200
        self.requests = []
        self.posts = []
        self.redirects = {"/short": "https://www.bilibili.com/video/BV1xx411c7mD?p=2&x=&x=%E4%B8%AD#keep"}

    def __enter__(self):
        if not sys.platform.startswith("linux"):
            raise unittest.SkipTest("local TLS fixture uses Linux SSL_CERT_FILE trust; native Windows/macOS verifiers require platform trust setup")
        fixture = self
        certs = Path(__file__).parent / "fixtures" / "video_service"
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(certs / "cert.pem", certs / "key.pem")

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_CONNECT(self):
                # No forwarding/DNS: even an unexpected destination stays local.
                self.send_response(200)
                self.end_headers()
                self.rfile.close()
                self.wfile.close()
                self.connection = tls.wrap_socket(self.connection, server_side=True)
                self.request = self.connection
                self.rfile = self.connection.makefile("rb")
                self.wfile = self.connection.makefile("wb")
                self.close_connection = False
                try:
                    self.handle_one_request()
                finally:
                    self.close_connection = True

            def finish(self):
                try:
                    super().finish()
                finally:
                    self.connection.close()

            def do_GET(self):
                fixture.requests.append((self.path, dict(self.headers)))
                if fixture.before_response:
                    fixture.before_response()
                if self.path in fixture.redirects:
                    self.send_response(302)
                    self.send_header("Location", fixture.redirects[self.path])
                    body = b""
                elif self.path.startswith("/video/"):
                    self.send_response(200)
                    body = b"local video page"
                else:
                    self.send_response(fixture.status)
                    value = fixture.return_value
                    if callable(value):
                        value = value(self.path)
                    body = value if isinstance(value, bytes) else json.dumps(value, ensure_ascii=False).encode("utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self):
                fixture.posts.append((self.path, json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))))
                body = b'{"success":true,"added":1}'
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        proxy = f"http://127.0.0.1:{self.server.server_port}"
        self.env = patch.dict(os.environ, {
            "HTTPS_PROXY": proxy, "https_proxy": proxy,
            "HTTP_PROXY": proxy, "http_proxy": proxy,
            "ALL_PROXY": proxy, "all_proxy": proxy,
            "NO_PROXY": "", "no_proxy": "",
            "SSL_CERT_FILE": str(certs / "ca.pem"),
            "SSL_CERT_DIR": str(certs),
        })
        self.env.start()
        return self

    def __exit__(self, *_):
        self.env.stop()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def assert_called_once(self):
        assert len(self.requests) == 1, self.requests

    @property
    def call_args(self):
        from types import SimpleNamespace
        return SimpleNamespace(args=[self.requests[-1][0]])


def video_fixture(test):
    @functools.wraps(test)
    def run(*args, **kwargs):
        with VideoFixture() as fixture, patch("bilikara.bilibili.effective_bilibili_cookie", return_value=""):
            return test(*args, fixture, **kwargs)
    return run
