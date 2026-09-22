"""Build/test driver for the actual installed native layout (never shipped)."""
from __future__ import annotations

import http.cookiejar
import json
import os
from pathlib import Path
import queue
import re
import subprocess
import sys
import tempfile
import threading
import urllib.error
import urllib.request


def resources(executable: Path) -> Path:
    parent = executable.parent
    return parent.parent / "Resources" if parent.name == "MacOS" and parent.parent.name == "Contents" else parent


def inspect_package(executable: Path) -> dict:
    root = resources(executable)
    package = root.parent if root.name == "Resources" else root
    facts = json.loads((root / "native-desktop.json").read_text())
    assert facts["backend"] == "rust" and facts["schema_version"] == 1
    assert facts["development"] is False, "Expected a release product layout"
    assert (root / "APP_VERSION").read_text().strip() == facts["version"]
    assert (root / "static/fonts/SourceHanSans-VF.ttf").is_file()
    assert (root / "static/vendor/signalsmith-stretch/SignalsmithStretch.js").is_file()
    for path in package.rglob("*"):
        if not path.is_file():
            continue
        name = path.name.lower()
        assert name not in {"ffmpeg", "ffprobe", "ffmpeg.exe", "ffprobe.exe", "python", "python3", "python.exe", "pythonw.exe", "base_library.zip", "pyz-00.pyz", "bilikara_rust.dll", "bilikara_runtime.dll", "libbilikara_rust.so", "libbilikara_runtime.so", "libbilikara_rust.dylib", "libbilikara_runtime.dylib"}, path
        assert not re.match(r"(?:lib)?python\d.*\.(?:so|dll|dylib)", name), path
        assert "site-packages" not in path.parts and "_internal" not in path.parts, path
    assert executable.read_bytes()[:4] in {b"\x7fELF", b"\xcf\xfa\xed\xfe", b"\xfe\xed\xfa\xcf"} or executable.read_bytes()[:2] == b"MZ"
    assert (root / "vendor/ffmpeg-runtime.json").is_file()
    return facts


def isolated_environment(home: Path) -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not k.startswith(("BILIKARA_", "BB_DOWN", "ARIA2C_", "FFMPEG_", "FFPROBE_", "PYTHON", "LD_LIBRARY_PATH", "DYLD_"))}
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
            with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(self.base + "/api/health", timeout=1):
                raise AssertionError("Backend listener survived shutdown")
        except urllib.error.URLError:
            pass
        finally:
            if self.process.poll() is None:
                self.process.kill()
            self.process.communicate(timeout=10)


def check(executable: Path) -> dict:
    facts = inspect_package(executable)
    with tempfile.TemporaryDirectory(prefix="native-package-home-") as directory:
        home = Path(directory)
        for _ in range(2):
            host = RunningHost(executable, home)
            try:
                with host.request("/api/health") as response:
                    assert json.load(response)["backend"] == "rust"
                state = host.api("/api/state")
                assert state["app"]["version"] == facts["version"]
                assert host.api("/api/app/update/status")["auto_update_supported"] is False
                with host.request("/vendor/signalsmith-stretch/SignalsmithStretch.js") as response:
                    assert "javascript" in response.headers["Content-Type"]
                    assert b"WebAssembly" in response.read()
                with host.request("/api/events") as response:
                    assert "text/event-stream" in response.headers["Content-Type"]
                    assert response.readline()
                try:
                    host.request("/api/session-users/add", {"name": "forbidden"}, {"Origin": "https://unrelated.invalid"})
                except urllib.error.HTTPError as error:
                    assert error.code == 403
                else:
                    raise AssertionError("Foreign origin accepted")
                proc = Path(f"/proc/{host.process.pid}")
                if proc.is_dir():
                    assert Path(os.readlink(proc / "exe")) == executable.resolve()
                    assert not re.search(r"(?:libpython|site-packages|_MEI)", (proc / "maps").read_text())
                    assert not (proc / "task" / str(host.process.pid) / "children").read_text().strip()
            finally:
                host.close()
    return {"nativeReleaseBackend": True, "pythonFreeLayout": True, "bootstrap": True,
            "resources": True, "sse": True, "shutdownAndReopen": True, "version": facts["version"]}


if __name__ == "__main__":
    print(json.dumps(check(Path(sys.argv[1]).resolve(strict=True))))
