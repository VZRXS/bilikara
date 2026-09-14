"""Local TLS interception for the real desktop login ABI; never forwards traffic.

Only ephemeral, synthetic cookie/QR material is used. Production URLs are retained
in Rust; a temporary test CA verifies the real hostname without trust bypasses.
"""
import json
import os
import ssl
import subprocess
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch


class LoginFixture:
    def __init__(self):
        self.codes = [0]
        self.cookies = [
            "SESSDATA=synthetic-session; Domain=.bilibili.com; Path=/; Secure; HttpOnly",
            "bili_jct=synthetic-csrf; Domain=.bilibili.com; Path=/; Secure",
            "b_nut=synthetic-nut; Domain=.bilibili.com; Path=/; Secure",
        ]
        self.generate_body = None
        self.poll_body = None
        self.generate_status = 200
        self.poll_status = 200
        self.before_generate = None
        self.before_poll = None
        self.stages = []  # No URLs, keys, cookies, or request headers retained.

    def __enter__(self):
        if not sys.platform.startswith("linux"):
            raise unittest.SkipTest("local TLS fixture requires Linux SSL_CERT_FILE trust")
        self.temp = TemporaryDirectory()
        root = Path(self.temp.name)
        cert, key = root / "cert.pem", root / "key.pem"
        def openssl(*args):
            subprocess.run(["openssl", *map(str, args)], check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        ca, ca_key, csr = root / "ca.pem", root / "ca-key.pem", root / "server.csr"
        openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", ca_key,
                "-out", ca, "-days", "1", "-subj", "/CN=Bilikara ephemeral test CA",
                "-addext", "basicConstraints=critical,CA:TRUE")
        openssl("req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", key,
                "-out", csr, "-subj", "/CN=passport.bilibili.com")
        extensions = root / "server.ext"
        extensions.write_text("subjectAltName=DNS:passport.bilibili.com\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n")
        openssl("x509", "-req", "-in", csr, "-CA", ca, "-CAkey", ca_key,
                "-CAcreateserial", "-out", cert, "-days", "1", "-extfile", extensions)
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(cert, key)
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_CONNECT(self):
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
                generate = self.path.startswith("/x/passport-login/web/qrcode/generate")
                fixture.stages.append("generate" if generate else "poll")
                hook = fixture.before_generate if generate else fixture.before_poll
                if hook:
                    hook()
                if generate:
                    body = fixture.generate_body
                    if body is None:
                        body = {"code": 0, "data": {
                            "url": "https://account.bilibili.com/scan?token=synthetic",
                            "qrcode_key": "synthetic-key",
                        }}
                    status = fixture.generate_status
                else:
                    body = fixture.poll_body
                    if body is None:
                        code = fixture.codes.pop(0) if len(fixture.codes) > 1 else fixture.codes[0]
                        body = {"code": 0, "data": {"code": code}}
                    status = fixture.poll_status
                self.send_response(status)
                if not generate:
                    for cookie in fixture.cookies:
                        self.send_header("Set-Cookie", cookie)
                encoded = body if isinstance(body, bytes) else json.dumps(body).encode()
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        proxy = f"http://127.0.0.1:{self.server.server_port}"
        self.env = patch.dict(os.environ, {
            "HTTPS_PROXY": proxy, "https_proxy": proxy,
            "HTTP_PROXY": proxy, "http_proxy": proxy,
            "ALL_PROXY": proxy, "all_proxy": proxy,
            "NO_PROXY": "", "no_proxy": "",
            "SSL_CERT_FILE": str(ca), "SSL_CERT_DIR": str(root),
        })
        self.env.start()
        return self

    def __exit__(self, *_):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.env.stop()
        self.temp.cleanup()
