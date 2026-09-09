"""Finite extracted-package diagnostics. Python orchestrates; Rust calls libav.

Only --tool-smoke windows-libav-preview reaches this module. ctypes below is
Win32 module inspection only, never a media/companion ABI or semantic fallback.
"""
from __future__ import annotations

import ctypes
from ctypes import wintypes
import json
import math
import os
from pathlib import Path
import queue
import secrets
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import wave


class ModuleSnapshotPending(RuntimeError):
    """The new process has not published its first module yet."""


def module_paths(pid: int) -> list[Path]:
    class Entry(ctypes.Structure):
        _fields_ = [(n, wintypes.DWORD) for n in ("dwSize", "th32ModuleID", "th32ProcessID", "GlblcntUsage", "ProccntUsage")] + [
            ("modBaseAddr", ctypes.c_void_p), ("modBaseSize", wintypes.DWORD),
            ("hModule", ctypes.c_void_p), ("szModule", wintypes.WCHAR * 256),
            ("szExePath", wintypes.WCHAR * 260)]
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    kernel.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel.Module32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(Entry)]
    kernel.Module32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(Entry)]
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.K32GetModuleFileNameExW.argtypes = [wintypes.HANDLE, wintypes.HMODULE, wintypes.LPWSTR, wintypes.DWORD]
    kernel.K32GetModuleFileNameExW.restype = wintypes.DWORD
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    # ERROR_BAD_LENGTH is documented while the child's loader changes its
    # module list. Retry that specific race, never reinterpret it as success.
    for _ in range(20):
        handle = kernel.CreateToolhelp32Snapshot(8, pid)
        if handle != ctypes.c_void_p(-1).value or ctypes.get_last_error() != 24:
            break
        time.sleep(0.05)
    if handle == ctypes.c_void_p(-1).value:
        raise RuntimeError("module snapshot failed")
    process = None
    try:
        process = kernel.OpenProcess(0x0400 | 0x0010, False, pid)  # QUERY_INFORMATION | VM_READ
        if not process:
            raise RuntimeError("module process query failed")
        entry = Entry()
        entry.dwSize = ctypes.sizeof(entry)
        more = kernel.Module32FirstW(handle, ctypes.byref(entry))
        if not more:
            if ctypes.get_last_error() == 18:  # ERROR_NO_MORE_FILES during loader startup
                raise ModuleSnapshotPending("module enumeration not ready")
            raise RuntimeError("module enumeration failed")
        paths = []
        while more:
            # Query the Unicode path by module handle, independently of the
            # snapshot's fixed-size filename field, before checking identity.
            filename = ctypes.create_unicode_buffer(32768)
            count = kernel.K32GetModuleFileNameExW(process, entry.hModule, filename, len(filename))
            if not count or count >= len(filename):
                raise RuntimeError("module filename query failed or overflowed")
            paths.append(Path(filename.value).resolve())
            more = kernel.Module32NextW(handle, ctypes.byref(entry))
        return paths
    finally:
        if process:
            kernel.CloseHandle(process)
        kernel.CloseHandle(handle)


def clean_environment(work: Path) -> dict[str, str]:
    system = Path(os.environ["SystemRoot"])
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith((
        "BILIKARA_", "FF", "PYTHON", "LD_")) and k.upper() not in {
            "PATH", "SYSTEMROOT", "FFMPEG_PATH", "BB_DOWN_PATH", "YT_DLP_PATH", "ARIA2C_PATH"}}
    env.update(SystemRoot=str(system),
               PATH=os.pathsep.join(str(system / p) for p in ("System32", "", "System32/Wbem")),
               BILIKARA_HOME=str(work / "home"), BILIKARA_REQUIRE_RUST_LIB="1",
               BILIKARA_MAX_CACHE_ITEMS="0", TEMP=str(work), TMP=str(work),
               DEBUG_LOG_FILE=str(work / "startup.log"), BILIKARA_LAUNCH_MODE="tauri")
    return env


def invoke(command: list, env: dict, cwd: Path, *, success: bool | None = True, timeout: int = 60):
    result = subprocess.run([str(v) for v in command], cwd=cwd, env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    if len(result.stdout) > 2 * 1024 * 1024 or len(result.stderr) > 2 * 1024 * 1024:
        raise RuntimeError("smoke output limit exceeded")
    if success is not None and (result.returncode == 0) != success:
        raise RuntimeError(f"packaged child exit code {result.returncode}; expected success={success}")
    return result


def backend(package: Path, work: Path, env: dict, diagnostics: dict | None = None) -> dict:
    token = secrets.token_urlsafe(32)
    child_env = dict(env, BILIKARA_SHUTDOWN_TOKEN=token)
    child = subprocess.Popen([str(package / "bilikara.exe"), "--no-browser", "--headless",
                              "--host", "127.0.0.1", "--port", "0"], cwd=work, env=child_env,
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    messages: queue.Queue = queue.Queue(maxsize=256)
    def drain():
        for line in child.stdout:
            if len(line) > 65536:
                continue
            try:
                value = json.loads(line)
                if value.get("event") == "bilikara.ready":
                    messages.put_nowait(value)
            except (ValueError, AttributeError, queue.Full):
                pass
    reader = threading.Thread(target=drain, daemon=True)
    reader.start()
    try:
        ready = messages.get(timeout=90)
        port = ready.get("port")
        if type(port) is not int or not 0 < port < 65536:
            raise RuntimeError("invalid backend ready port")
        base = f"http://127.0.0.1:{port}"
        with urllib.request.urlopen(base + "/api/health", timeout=5) as response:
            if json.load(response) != {"ok": True, "status": "ready"}:
                raise RuntimeError("backend health failed")
        paths = module_paths(child.pid)
        expected_runtime = package / "_internal/rust/bilikara_runtime.dll"
        matches_runtime = []
        path_errors = []
        for path in paths:
            try:
                matches_runtime.append(path.samefile(expected_runtime))
            except OSError as error:
                matches_runtime.append(False)
                path_errors.append({"name": path.name, "errno": error.errno,
                                    "winerror": getattr(error, "winerror", None),
                                    "question_mark_in_parts": any("?" in part for part in path.parts[1:])})
        if diagnostics is not None:
            diagnostics["module_count"] = len(paths)
            diagnostics["module_path_errors"] = path_errors
            diagnostics["bilikara_modules"] = [
                {"name": p.name, "in_package": p.is_relative_to(package),
                 "matches_runtime": matches}
                for p, matches in zip(paths, matches_runtime) if p.name.lower().startswith("bili")
            ]
        if not any(matches_runtime):
            raise RuntimeError("packaged mandatory Runtime missing")
        if any(is_ffmpeg(p.name) or p.name.lower().startswith("bilikara_media_libav") for p in paths):
            raise RuntimeError("default startup loaded optional libav")
        request = urllib.request.Request(base + "/api/app/shutdown", data=b"{}", method="POST",
            headers={"Content-Type": "application/json", "X-Bilikara-Shutdown-Token": token})
        with urllib.request.urlopen(request, timeout=5) as response:
            if response.status != 200:
                raise RuntimeError("backend shutdown failed")
        if child.wait(timeout=20) != 0:
            raise RuntimeError("backend shutdown exit code")
        return {"outcome": "success", "process": "PyInstaller bilikara.exe",
                "mandatory_runtime": "_internal/rust/bilikara_runtime.dll", "optional_loaded": False}
    finally:
        if child.poll() is None:
            child.kill()
        child.wait(timeout=10)
        reader.join(timeout=2)
        child.stdout.close()


def is_ffmpeg(name: str) -> bool:
    return name.lower().startswith(("avformat-", "avcodec-", "avutil-", "avfilter-", "avdevice-", "swresample-", "swscale-")) and name.lower().endswith(".dll")


def comparison_has_same_build(record: dict, *, packet_scan: bool) -> bool:
    value = record.get("same_build")
    if packet_scan:
        return (isinstance(value, dict) and set(value) == {"inventory", "operational"}
                and value["inventory"] is True and value["operational"] is True)
    return value is True


def remove_package_dependency(package: Path, name: str) -> list[str]:
    # PyInstaller may collect a second copy beside the embedding runtime.
    # Remove every exact-name copy in this disposable fault-injection package.
    paths = list(package.rglob(name))
    if not paths:
        raise RuntimeError("fault-injection dependency is absent")
    removed = []
    for path in paths:
        removed.append(path.relative_to(package).as_posix())
        path.unlink()
    return sorted(removed)


def require_x64(path: Path) -> None:
    with path.open("rb") as handle:
        dos = handle.read(64)
        if len(dos) != 64 or dos[:2] != b"MZ":
            raise RuntimeError("missing PE header")
        handle.seek(struct.unpack_from("<I", dos, 60)[0])
        header = handle.read(6)
        if header != b"PE\0\0\x64\x86":
            raise RuntimeError("package binary is not x64 PE")


def run() -> str:
    if sys.platform != "win32" or not getattr(sys, "frozen", False):
        raise RuntimeError("requires extracted Windows preview backend")
    package = Path(sys.executable).resolve().parent
    vendor = package / "_internal/vendor"
    from .ffmpeg_vendor import runtime_files
    result_path = package / "libav-smoke-result.json"
    report = {"schema_version": 1, "platform": "windows-x64-preview", "outcome": "failed",
              "manual_device": "pending", "checks": {}, "stage": "prepare"}
    checks = report["checks"]
    checks["extracted_location"] = {"has_spaces": " " in str(package),
                                    "has_non_ascii": not str(package).isascii()}
    def stage(name):
        report["stage"] = name
    previous_error_mode = None
    try:
        if runtime_files(vendor) is None:
            raise RuntimeError("required preview manifest missing")
        # Record the embedding bootloader's setting without changing it. Media
        # calls below run in child Rust drivers, not in this Python process.
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.GetErrorMode.argtypes = []
        kernel.GetErrorMode.restype = wintypes.UINT
        kernel.SetErrorMode.argtypes = [wintypes.UINT]
        kernel.SetErrorMode.restype = wintypes.UINT
        previous_error_mode = kernel.GetErrorMode()
        # Missing-DLL fault cases must return an error rather than waiting for
        # a Windows dialog. Only this diagnostic process and its children inherit it.
        kernel.SetErrorMode(previous_error_mode | 0x0001)  # SEM_FAILCRITICALERRORS
        kernel.GetDllDirectoryW.argtypes = [wintypes.DWORD, wintypes.LPWSTR]
        directory = ctypes.create_unicode_buffer(32768)
        count = kernel.GetDllDirectoryW(len(directory), directory)
        if count >= len(directory):
            raise RuntimeError("DLL directory diagnostic overflow")
        dll_dir = Path(directory.value).resolve() if count else None
        if dll_dir is not None and not dll_dir.is_relative_to(package):
            raise RuntimeError("unexpected PyInstaller DLL directory")
        checks["orchestrator"] = {"process": f"PyInstaller {Path(sys.executable).name}",
            "dll_directory": dll_dir.relative_to(package).as_posix() if dll_dir else "default",
            "media_process": "PyInstaller bilikara.exe -> Runtime cdylib -> trusted companion; developer comparisons retained"}
        with tempfile.TemporaryDirectory(prefix="Bilikara smoke 空 ") as temporary:
            work = Path(temporary).resolve()
            env = clean_environment(work)
            stage("default_backend")
            checks["default_backend"] = backend(package, work, env, checks.setdefault("default_backend", {}))
            for tool in ("ffmpeg", "bbdown", "native"):
                stage("restore_" + tool)
                invoke([package / "bilikara.exe", "--tool-smoke", tool], env, work)
            stage("restored_cli_files")
            cli = work / "home/tools/bbdown"
            for path in runtime_files(vendor):
                if not (cli / path.name).is_file():
                    raise RuntimeError("CLI dependency was not restored")
            invoke([cli / "BBDown.exe", "--help"], env, work)
            checks["bbdown"] = {"outcome": "success", "scope": "existing offline vendor restore and help only; no live download"}
            ffmpeg, ffprobe = cli / "ffmpeg.exe", cli / "ffprobe.exe"
            stage("synthetic_fixtures")
            fixtures = work / "fixtures"
            fixtures.mkdir()
            pcm = fixtures / "synthetic.wav"
            with wave.open(str(pcm), "wb") as output:
                output.setparams((2, 3, 96000, 96000, "NONE", "not compressed"))
                output.writeframes(b"".join(int(1_000_000 * math.sin(2 * math.pi * 997 * n / 96000)).to_bytes(3, "little", signed=True) * 2 for n in range(96000)))
            def ff(*args):
                return invoke([ffmpeg, "-v", "error", "-nostdin", *args], env, work)
            ff("-i", pcm, "-ar", "48000", "-c:a", "aac", fixtures / "aac.m4a")
            ff("-i", pcm, "-c:a", "flac", fixtures / "audio.flac")
            ff("-i", fixtures / "audio.flac", "-c", "copy", "-strict", "-2", fixtures / "flac.mp4")
            # Raw H.264 has no seekable timestamps for -stream_loop. Repeat
            # the existing six-frame fixture bytes to retain all 24 frames.
            video_source = fixtures / "synthetic.h264"
            video_source.write_bytes((package / "THIRD_PARTY_SOURCES/media-libav/fixtures/synthetic.h264").read_bytes() * 4)
            ff("-framerate", "12", "-i", video_source,
               "-c", "copy", fixtures / "video.mp4")
            for mode, expected in (("default", "libav"), ("legacy", "pure_rust")):
                stage("application_" + mode)
                application_env = dict(env, BILIKARA_LIBAV_FIXTURES=str(fixtures))
                if mode == "legacy":
                    application_env["BILIKARA_MEDIA_BACKEND"] = "legacy"
                output = invoke([package / "bilikara.exe", "--tool-smoke", "media-routing"], application_env, work, timeout=120)
                report_row = json.loads(output.stdout)
                checks["application_" + mode] = report_row
                rows = report_row["operations"]
                if len(rows) != 6 or any(r["backend"] != ("ffmpeg" if mode == "legacy" and r["operation"] == "packet_scan" else expected) for r in rows):
                    raise RuntimeError("packaged normal application used an unexpected media backend")
                if mode == "default" and any(r["cli_calls"] != 0 for r in rows):
                    raise RuntimeError("packaged application duplicated a successful libav operation")
            driver = package / "preview/libav_metadata.exe"
            companion = vendor / "bilikara_media_libav.dll"
            stage("runtime_companion_references")
            cases = [("probe", "aac.m4a", []), ("scan", "aac.m4a", ["--scan-stream", "0", "--scan-kind", "audio"]),
                     ("mp4_audio", "aac.m4a", ["--copy-remux", "audio"]),
                     ("mp4_video", "video.mp4", ["--copy-remux", "video"]),
                     ("flac", "flac.mp4", ["--flac", "audio"])]
            for label, name, options in cases:
                stage("reference_" + label)
                output = invoke([driver, "compare", companion, cli, fixtures / name, label, *options,
                                 "--timeout-ms", "30000"], env, work, success=None, timeout=120)
                records = [json.loads(line) for line in output.stdout.splitlines() if line.strip()]
                checks[label] = records  # Preserve the accepted sanitized report even on failure.
                if output.returncode != 0 or not records or any(
                    not comparison_has_same_build(r, packet_scan=label == "scan") for r in records
                ):
                    raise RuntimeError("same-build comparison did not execute")
            stage("actual_dependency_paths")
            checks["driver_dependencies"] = json.loads(invoke([driver, "package-info", companion, package], env, work).stdout)
            if not all(checks["driver_dependencies"].get(k) for k in ("scan", "mp4", "flac")):
                raise RuntimeError("required optional capability missing")
            manifest = json.loads((vendor / "ffmpeg-runtime.json").read_text(encoding="utf-8"))
            for name in manifest["pe"]:
                require_x64(vendor / name)
            for name in manifest["driver_pe"]:
                require_x64(package / "preview" / name)
            for name in ("bilikara_rust.dll", "bilikara_runtime.dll"):
                require_x64(package / "_internal/rust" / name)
            require_x64(package / "bilikara.exe")
            require_x64(package / "bilikara-desktop.exe")
            for path in runtime_files(vendor):
                require_x64(cli / path.name)
            checks["pe"] = manifest["pe"]
            child = subprocess.Popen([str(ffmpeg), "-v", "error", "-nostdin", "-re", "-stream_loop", "-1",
                "-i", str(fixtures / "aac.m4a"), "-c", "copy", "-f", "null", "-"], env=env, cwd=work,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                deadline = time.monotonic() + 10
                while True:
                    try:
                        loaded_paths = module_paths(child.pid)
                    except ModuleSnapshotPending:
                        loaded_paths = []
                    paths = [p for p in loaded_paths
                             if is_ffmpeg(p.name) or p.name.lower() in manifest["runtime_files"]]
                    if all(any(p.name.lower().startswith(n) for p in paths) for n in ("avformat-", "avcodec-", "avutil-")):
                        break
                    if child.poll() is not None or time.monotonic() >= deadline:
                        raise RuntimeError("restored CLI never loaded FFmpeg")
                    time.sleep(0.05)
                system = (Path(env["SystemRoot"]) / "System32").resolve()
                if any(p.parent != cli and (is_ffmpeg(p.name) or p.parent != system) for p in paths):
                    raise RuntimeError("restored CLI mixed external FFmpeg modules")
                checks["restored_cli_dependencies"] = [{"name": p.name,
                    "actual": ("SMOKE_HOME/tools/bbdown/" if p.parent == cli else "SYSTEM32/") + p.name} for p in paths]
            finally:
                child.kill()
                child.wait(timeout=10)
            stage("cli_corpus")
            for name, kind in (("aac.m4a", "audio"), ("video.mp4", "video"), ("audio.flac", "audio")):
                source = fixtures / name
                stream = "0:v:0" if kind == "video" else "0:a:0"
                invoke([ffprobe, "-v", "error", "-show_streams", "-show_format", "-of", "json", source], env, work)
                ff("-xerror", "-i", source, "-map", stream, "-c", "copy", "-f", "null", "-")
                flags = [] if source.suffix == ".flac" else ["-movflags", "+faststart"]
                ff("-xerror", "-y", "-fflags", "+genpts", "-i", source, "-map", stream,
                   "-c", "copy", "-avoid_negative_ts", "make_zero", *flags, fixtures / ("normalized-" + name))
            checks["cli_corpus"] = "success: existing metadata / demux-null / normalization shapes"
            stage("cancellation_collision")
            test_env = dict(env, BILIKARA_LIBAV_FIXTURES=str(fixtures), BILIKARA_LIBAV_COMPANION=str(companion),
                            BILIKARA_M5_FAULT_COMPANION=str(vendor / "bilikara_media_libav_test.dll"))
            output = invoke([package / "preview/libav-runtime-tests.exe", "--exact",
                "experimental_libav::remux::windows_tests::packaged_cancellation_and_collision",
                "--ignored", "--test-threads=1"], test_env, work)
            if b"1 passed; 0 failed; 0 ignored" not in output.stdout:
                raise RuntimeError("required transform test did not run")
            checks["cancellation_collision"] = "success: both profiles; real C write checkpoint / Rust before_publish sentinel"
            stage("native_cache_application_route")
            for mode in ("default", "legacy"):
                output = invoke([package / "preview/libav-runtime-tests.exe", "--exact",
                    "cache_runtime::tests::live_default_media_through_native_track", "--ignored", "--test-threads=1"],
                    dict(test_env, BILIKARA_MEDIA_BACKEND=mode), work, timeout=120)
                if b"1 passed; 0 failed; 0 ignored" not in output.stdout:
                    raise RuntimeError("required Native application media test did not run")
                checks["native_cache_" + mode] = "success: real run_track, HTTP fixture acquisition, media and stale publication checks"
            stage("optional_failures")
            # Disposable package copies and fresh processes avoid loader caching.
            for mode in ("without_companion", "missing_dependency", "wrong_companion"):
                copy = work / mode
                shutil.copytree(package, copy, ignore=lambda directory, names:
                    {"data", "tools", "logs", "libav-smoke-result.json"}.intersection(names)
                    if Path(directory) == package else set())
                copied_vendor = copy / "_internal/vendor"
                target = copied_vendor / companion.name
                if mode == "without_companion":
                    target.unlink()
                elif mode == "missing_dependency":
                    name = next(n for n in manifest["runtime_files"] if n.startswith("avutil-"))
                    checks["missing_dependency_removed"] = remove_package_dependency(copy, name)
                else:
                    target.unlink()
                    shutil.copy2(copy / "_internal/rust/bilikara_runtime.dll", target)
                child_work = work / (mode + " home")
                child_work.mkdir()
                failure_env = clean_environment(child_work)
                checks[mode + "_startup"] = backend(copy, child_work, failure_env)
                application = invoke([copy / "bilikara.exe", "--tool-smoke", "media-routing"],
                    dict(failure_env, BILIKARA_LIBAV_FIXTURES=str(fixtures)), child_work,
                    success=mode != "missing_dependency", timeout=120)
                if mode != "missing_dependency":
                    rows = json.loads(application.stdout)["operations"]
                    if any(r["backend"] == "libav" for r in rows):
                        raise RuntimeError("broken companion produced false libav success")
                    checks[mode + "_application"] = rows
                else:
                    checks[mode + "_application"] = "failed as expected; shared dependency unavailable to CLI and libav"
                output = invoke([copy / "preview/libav_metadata.exe", "package-info", target, copy], failure_env, child_work, success=False)
                if json.loads(output.stdout).get("outcome") != "unavailable":
                    raise RuntimeError("optional failure did not negotiate Unavailable")
                if mode == "missing_dependency":
                    invoke([copy / "bilikara.exe", "--tool-smoke", "ffmpeg"], failure_env, child_work, success=False)
                    checks["missing_dependency_cli"] = "failed as expected; no system fallback"
            report["outcome"] = "success"
            report["stage"] = "complete"
    except Exception as exc:
        report["error_type"] = type(exc).__name__  # no raw output, paths, tokens or media metadata
        if type(exc) is RuntimeError:
            report["reason"] = str(exc)[:256]  # these helpers use fixed diagnostics, never child output
        raise RuntimeError("Windows package smoke failed; see sanitized result stage") from None
    finally:
        if previous_error_mode is not None:
            kernel.SetErrorMode(previous_error_mode)
        result_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return json.dumps({"event": "bilikara.windows_libav_preview", "outcome": "success"})
