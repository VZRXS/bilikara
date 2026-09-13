#!/usr/bin/env python3
"""Run native Host HTTP assertions with deterministic offline diagnostics probes.

The production diagnostic route probes three Internet services. Its surrounding
HTTP test is about authentication, sanitization and native transport, and should
not depend on external DNS/proxy availability. A local rejecting proxy exercises
the actual HTTP failure path without changing the renderer or its assertions.
Loopback fixtures bypass this proxy; no external request is forwarded.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit


def main() -> int:
    requests = []
    lock = threading.Lock()

    class Proxy(BaseHTTPRequestHandler):
        def reject(self):
            # Retain only the destination hostname, never headers, credentials or paths.
            host = urlsplit("//" + self.path if self.command == "CONNECT" else self.path).hostname
            with lock:
                requests.append(host)
            self.send_response(503)
            self.send_header("Content-Length", "0")
            self.end_headers()

        do_CONNECT = reject
        do_GET = reject

        def log_message(self, *_args):
            pass

    with ThreadingHTTPServer(("127.0.0.1", 0), Proxy) as proxy:
        thread = threading.Thread(target=proxy.serve_forever, daemon=True)
        thread.start()
        endpoint = f"http://127.0.0.1:{proxy.server_port}"
        env = dict(os.environ)
        for name in ("http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"):
            env[name] = endpoint
        for name in ("no_proxy", "NO_PROXY"):
            env[name] = "localhost,127.0.0.1,::1"
        try:
            result = subprocess.run(
                ["cargo", "test", "--manifest-path", "rust-runtime/Cargo.toml", "--locked",
                 "--features", "native-host", "--test", "native_host_http"],
                cwd=Path(__file__).resolve().parents[1], env=env, timeout=180,
            )
        finally:
            proxy.shutdown()
            thread.join(timeout=5)
    covered = {"api.bilibili.com", "api.github.com", "api.kevinx96.icu"}.issubset(requests)
    print(json.dumps({"offline_connectivity_fixture": covered, "destinations": sorted(set(requests)),
                      "forwarded_external_requests": 0, "cargo_exit_code": result.returncode}))
    return result.returncode or int(not covered)


if __name__ == "__main__":
    raise SystemExit(main())
