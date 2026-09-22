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


def package_root(executable: Path) -> Path:
    root = resources(executable)
    if root.name == "Resources":
        app = root.parent.parent
        return app.parent.parent.parent if app.name == "bilikara-backend.app" and app.parent.name == "Frameworks" else app
    return root.parent if root.name == "_internal" else root


def inspect_package(executable: Path) -> dict:
    root = resources(executable)
    package = package_root(executable)
    facts = json.loads((root / "native-desktop.json").read_text())
    assert facts["backend"] == "rust" and facts["schema_version"] == 1
    assert facts["resource_layout"] == "internal-v1"
    assert facts["development"] is False, "Expected a release product layout"
    assert (root / "APP_VERSION").read_text().strip() == facts["version"]
    assert (root / "static/fonts/SourceHanSans-VF.ttf").is_file()
    assert (root / "vendor/signalsmith-stretch/SignalsmithStretch.js").is_file()
    assert not (root / "static/vendor").exists(), "Third-party assets must share the internal vendor directory"
    assert len([p for p in root.rglob("vendor") if p.is_dir()]) == 1
    if root.name == "_internal":
        names = {p.name for p in package.iterdir()}
        if facts["platform"] == "windows" and (package / "runtime").is_dir():
            names.discard("runtime")  # Mutable user files are never archive payload.
        assert names == {
            "_internal", "license", "bilikara-desktop.exe" if facts["platform"] == "windows" else "bilikara-desktop"
        }, "Only the desktop launcher and its _internal/license directories belong at the top level"
    documentation = root / "license" if root.name == "Resources" else package / "license"
    for document in ("LICENSE", "LEGAL.md", "THIRD_PARTY_NOTICES.md", "THIRD_PARTY_LICENSES/libav-source.txt", "THIRD_PARTY_LICENSES/libav/COPYING.LGPLv2.1", "THIRD_PARTY_LICENSES/BBDown-LICENSE.txt", "THIRD_PARTY_LICENSES/signalsmith-stretch/LICENSE.txt"):
        assert (documentation / document).is_file(), document
    assert not (documentation / "native-desktop.md").exists(), "Engineering guide is not product payload"
    for path in package.rglob("*"):
        if facts["platform"] == "windows" and path.is_relative_to(package / "runtime"):
            continue
        assert "site-packages" not in path.parts, path
        if not path.is_file():
            continue
        name = path.name.lower()
        assert not name.endswith((".pyc", ".pyz")), path
        assert name not in {"ffmpeg", "ffprobe", "ffmpeg.exe", "ffprobe.exe", "python", "python3", "python.exe", "pythonw.exe", "base_library.zip", "pyz-00.pyz", "bilikara_rust.dll", "bilikara_runtime.dll", "libbilikara_rust.so", "libbilikara_runtime.so", "libbilikara_rust.dylib", "libbilikara_runtime.dylib"}, path
        assert not re.match(r"(?:lib)?python\d.*\.(?:so|dll|dylib)", name), path
        assert "site-packages" not in path.parts, path
    assert executable.read_bytes()[:4] in {b"\x7fELF", b"\xcf\xfa\xed\xfe", b"\xfe\xed\xfa\xcf"} or executable.read_bytes()[:2] == b"MZ"
    assert (root / "vendor/ffmpeg-runtime.json").is_file()
    return facts


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
        if facts["platform"] == "windows":
            # Exercise the portable default only in a fresh, task-owned install.
            # Never reopen or import the supplied installation's user data.
            import shutil
            source = package_root(executable)
            destination = home / "Installed product 空"
            shutil.copytree(source, destination, symlinks=True,
                            ignore=lambda directory, names: {"runtime"} if Path(directory) == source else set())
            executable = destination / executable.relative_to(source)
            # Reproduce the reported failure: unrelated AppData legacy/native
            # records must not block or redirect a fresh portable installation.
            external = home / "local/bilikara"
            external_files = {}
            for name in ("data/player_state.json", "native/state.json"):
                record = external / name
                record.parent.mkdir(parents=True, exist_ok=True)
                external_files[record] = b"external records must remain untouched"
                record.write_bytes(external_files[record])
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
                for private in ("/vendor/BBDown.exe", "/vendor/BBDown", "/vendor/ffmpeg-runtime.json",
                                "/vendor/signalsmith-stretch/../ffmpeg-runtime.json"):
                    try:
                        host.request(private)
                    except urllib.error.HTTPError as error:
                        assert error.code in (400, 404), (private, error.code)
                    else:
                        raise AssertionError("Native vendor resource was exposed over HTTP: " + private)
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
        if facts["platform"] == "windows":
            assert (destination / "runtime/data/host-state.json").is_file()
            assert {p: p.read_bytes() for p in external.rglob("*") if p.is_file()} == external_files
    return {"nativeReleaseBackend": True, "pythonFreeLayout": True, "bootstrap": True,
            "resources": True, "sse": True, "shutdownAndReopen": True, "version": facts["version"]}


if __name__ == "__main__":
    print(json.dumps(check(Path(sys.argv[1]).resolve(strict=True))))
