"""Test-only transport for retained native business/FFI Python tests.

This module does not inspect packages or implement the native package gate.
That gate and installed-entry regressions live in xtask/native_package.
"""
from __future__ import annotations

import http.cookiejar
import json
import os
from pathlib import Path
import queue
import subprocess
import threading
import urllib.error
import urllib.request


def isolated_environment(home: Path) -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not k.startswith(("BILIKARA_", "BB_DOWN", "ARIA2C_", "FFMPEG_", "FFPROBE_", "PYTHON", "CARGO_", "RUSTUP_", "RUSTFLAGS", "NODE_", "LD_LIBRARY_PATH", "DYLD_"))}
    empty = home / "empty-path"
    empty.mkdir(exist_ok=True)
    env.update(HOME=str(home), USERPROFILE=str(home), LOCALAPPDATA=str(home / "local"),
               XDG_DATA_HOME=str(home / "share"), XDG_CONFIG_HOME=str(home / "config"),
               XDG_CACHE_HOME=str(home / "cache"), PATH=str(empty),
               BILIKARA_SHUTDOWN_TOKEN="fixture-shutdown-capability")
    for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        env[key] = "http://127.0.0.1:1"  # Deliberately non-forwarding/offline.
    env.update(NO_PROXY="127.0.0.1,localhost", no_proxy="127.0.0.1,localhost")
    return env


class RunningHost:
    def __init__(self, executable: Path, home: Path, *args: str, env: dict | None = None):
        self.process = subprocess.Popen([str(executable), *args], cwd=home,
            env=env or isolated_environment(home), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        lines: queue.Queue = queue.Queue()
        threading.Thread(target=lambda: lines.put(self.process.stdout.readline()), daemon=True).start()
        try:
            line = lines.get(timeout=40)
            if not line:
                raise AssertionError(self.process.stderr.read().decode(errors="replace"))
            ready = json.loads(line)
            assert ready["backend"] == "rust"
            self.base = ready["baseUrl"]
            self.bootstrap_url = ready["bootstrapUrl"]
            self.client = urllib.request.build_opener(urllib.request.ProxyHandler({}),
                urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
            self.client.open(ready["bootstrapUrl"], timeout=5).close()
        except BaseException:
            self.process.kill()
            self.process.communicate(timeout=10)
            raise

    def request(self, path, body=None, headers=None):
        return self.client.open(urllib.request.Request(self.base + path,
            data=None if body is None else json.dumps(body).encode(),
            headers={"Origin": self.base, "Content-Type": "application/json", **(headers or {})}), timeout=10)

    def api(self, path, body=None):
        with self.request(path, body) as response:
            return json.load(response)["data"]

    def close(self):
        try:
            if self.process.poll() is None:
                self.request("/api/app/shutdown", {}, {"X-Bilikara-Shutdown-Token": "fixture-shutdown-capability"}).close()
                assert self.process.wait(timeout=30) == 0
            try:
                with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(self.base + "/api/health", timeout=1):
                    raise AssertionError("Backend listener survived shutdown")
            except urllib.error.HTTPError:
                raise
            except urllib.error.URLError:
                pass
        finally:
            if self.process.poll() is None:
                self.process.kill()
            self.process.communicate(timeout=10)
