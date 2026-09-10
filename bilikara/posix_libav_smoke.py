"""Finite relocated-package diagnostics; all media executes through Rust/CLI."""
from __future__ import annotations

import json
import math
import os
from pathlib import Path
import shutil
import sys
import tempfile
import wave

from .ffmpeg_vendor import runtime_files
from .windows_preview_smoke import comparison_has_same_build, invoke


def clean_environment(work: Path) -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith((
        "BILIKARA_", "FF", "PYTHON", "LD_", "DYLD_")) and k.upper() not in {
            "PATH", "BB_DOWN_PATH", "YT_DLP_PATH", "ARIA2C_PATH"}}
    env.update(PATH="/usr/bin:/bin", BILIKARA_HOME=str(work / "home"),
               BILIKARA_REQUIRE_RUST_LIB="1", BILIKARA_MAX_CACHE_ITEMS="0",
               DEBUG_LOG_FILE=str(work / "startup.log"), BILIKARA_LAUNCH_MODE="tauri")
    return env


def run() -> str:
    if sys.platform not in {"linux", "darwin"} or not getattr(sys, "frozen", False):
        raise RuntimeError("requires extracted native POSIX backend")
    executable = Path(sys.executable).resolve()
    macos = sys.platform == "darwin"
    package = executable.parents[2] if macos else executable.parent
    resources = package / "Contents/Resources" if macos else package
    vendor = package / ("Contents/Frameworks/vendor" if macos else "_internal/vendor")
    name = "libbilikara_media_libav." + ("dylib" if macos else "so")
    result_path = Path(os.environ["BILIKARA_LIBAV_SMOKE_RESULT"])
    report = {"schema_version": 1, "platform": sys.platform, "outcome": "failed",
              "manual_device": "pending", "stage": "prepare", "checks": {}}
    checks = report["checks"]
    checks["extracted_location"] = {"has_spaces": " " in str(package), "has_non_ascii": not str(package).isascii()}
    checks["orchestrator"] = "PyInstaller backend -> Runtime cdylib -> package companion"
    try:
        files = runtime_files(vendor)
        if files is None:
            raise RuntimeError("required libav manifest missing")
        with tempfile.TemporaryDirectory(prefix="Bilikara smoke 空 ") as temporary:
            work = Path(temporary).resolve()
            env = clean_environment(work)
            report["stage"] = "restore_tools"
            for tool in ("native", "ffmpeg", "bbdown"):
                invoke([executable, "--tool-smoke", tool], env, work, timeout=120)
                checks["restore_" + tool] = "success"
            cli = work / "home/tools/bbdown"
            if any(not (cli / p.name).is_file() for p in files):
                raise RuntimeError("incomplete restored CLI closure")
            # Existing comparison driver accepts a prefix with bin/lib children.
            # Both point at the actual restored same-build closure, outside app.
            reference = work / "reference"
            reference.mkdir()
            (reference / "bin").symlink_to(cli, target_is_directory=True)
            (reference / "lib").symlink_to(cli, target_is_directory=True)
            ffmpeg, ffprobe = cli / "ffmpeg", cli / "ffprobe"
            fixtures = work / "fixtures"
            fixtures.mkdir()
            report["stage"] = "synthetic_fixtures"
            pcm = fixtures / "synthetic.wav"
            with wave.open(str(pcm), "wb") as output:
                output.setparams((2, 3, 96000, 96000, "NONE", "not compressed"))
                output.writeframes(b"".join(int(1_000_000 * math.sin(2 * math.pi * 997 * n / 96000)).to_bytes(3, "little", signed=True) * 2 for n in range(96000)))
            def ff(*args):
                return invoke([ffmpeg, "-v", "error", "-nostdin", *args], env, work)
            ff("-i", pcm, "-ar", "48000", "-c:a", "aac", fixtures / "aac.m4a")
            ff("-i", pcm, "-c:a", "flac", fixtures / "audio.flac")
            ff("-i", fixtures / "audio.flac", "-c", "copy", "-strict", "-2", fixtures / "flac.mp4")
            video = fixtures / "synthetic.h264"
            video.write_bytes((resources / "THIRD_PARTY_SOURCES/media-libav/fixtures/synthetic.h264").read_bytes() * 4)
            ff("-framerate", "12", "-i", video, "-c", "copy", fixtures / "video.mp4")
            for mode, expected in (("default", "libav"), ("legacy", "pure_rust")):
                report["stage"] = "application_" + mode
                application_env = dict(env, BILIKARA_LIBAV_FIXTURES=str(fixtures), BILIKARA_MEDIA_BACKEND=mode)
                record = json.loads(invoke([executable, "--tool-smoke", "media-routing"], application_env, work, timeout=120).stdout)
                checks["application_" + mode] = record
                rows = record["operations"]
                if len(rows) != 6 or any(r["backend"] != ("ffmpeg" if mode == "legacy" and r["operation"] == "packet_scan" else expected) for r in rows):
                    raise RuntimeError("packaged application used an unexpected media backend")
                if mode == "default" and any(r["cli_calls"] != 0 for r in rows):
                    raise RuntimeError("successful libav operation repeated a CLI effect")
            driver = resources / "libav-diagnostics/libav_metadata"
            companion = vendor / name
            cases = [("probe", "aac.m4a", []), ("scan", "aac.m4a", ["--scan-stream", "0", "--scan-kind", "audio"]),
                     ("mp4_audio", "aac.m4a", ["--copy-remux", "audio"]),
                     ("mp4_video", "video.mp4", ["--copy-remux", "video"]),
                     ("flac", "flac.mp4", ["--flac", "audio"])]
            for label, source, options in cases:
                report["stage"] = "reference_" + label
                output = invoke([driver, "compare", companion, reference, fixtures / source, label, *options,
                                 "--timeout-ms", "30000"], env, work, success=None, timeout=120)
                records = [json.loads(line) for line in output.stdout.splitlines() if line.strip()]
                checks[label] = records
                if output.returncode != 0 or not records or any(not comparison_has_same_build(r, packet_scan=label == "scan") for r in records):
                    raise RuntimeError("same-build comparison failed")
            report["stage"] = "actual_dependency_paths"
            dependencies = json.loads(invoke([driver, "package-info", companion, package], env, work).stdout)
            if not all(dependencies.get(k) for k in ("scan", "mp4", "flac")):
                raise RuntimeError("required optional capability missing")
            checks["driver_dependencies"] = dependencies
            for source, kind in (("aac.m4a", "audio"), ("video.mp4", "video"), ("audio.flac", "audio")):
                stream = "0:v:0" if kind == "video" else "0:a:0"
                invoke([ffprobe, "-v", "error", "-show_streams", "-show_format", "-of", "json", fixtures / source], env, work)
                ff("-xerror", "-i", fixtures / source, "-map", stream, "-c", "copy", "-f", "null", "-")
                flags = [] if source.endswith(".flac") else ["-movflags", "+faststart"]
                ff("-xerror", "-y", "-fflags", "+genpts", "-i", fixtures / source, "-map", stream,
                   "-c", "copy", "-avoid_negative_ts", "make_zero", *flags, fixtures / ("normalized-" + source))
            checks["cli_corpus"] = "success: metadata / demux-null / normalization"
            test_env = dict(env, BILIKARA_LIBAV_FIXTURES=str(fixtures), BILIKARA_LIBAV_COMPANION=str(companion),
                            BILIKARA_M5_FAULT_COMPANION=str(vendor / name.replace("libav.", "libav_test.")))
            binary = resources / "libav-diagnostics/libav-runtime-tests"
            tests = [("cancellation_collision", "experimental_libav::remux::package_tests::packaged_cancellation_and_collision", "default"),
                     ("native_cache_default", "cache_runtime::tests::live_default_media_through_native_track", "default"),
                     ("native_cache_legacy", "cache_runtime::tests::live_default_media_through_native_track", "legacy")]
            for label, test, mode in tests:
                report["stage"] = label
                output = invoke([binary, "--exact", test, "--ignored", "--test-threads=1"],
                                dict(test_env, BILIKARA_MEDIA_BACKEND=mode), work, timeout=120)
                if b"1 passed; 0 failed; 0 ignored" not in output.stdout:
                    raise RuntimeError("required native test did not execute")
                checks[label] = "success"
            # Fresh disposable copies avoid loader caching. Re-sign only the
            # deliberately changed macOS fault copy; the original stays intact.
            for fault in ("without_companion", "missing_dependency", "wrong_companion"):
                report["stage"] = fault
                # PyInstaller recognizes macOS Frameworks only inside .app.
                copy = work / (fault + ".app" if macos else fault)
                shutil.copytree(package, copy, symlinks=True)
                copied_vendor = copy / ("Contents/Frameworks/vendor" if macos else "_internal/vendor")
                copied_executable = copy / executable.relative_to(package)
                target = copied_vendor / name
                if fault == "missing_dependency":
                    dependency = next(p.name for p in files if p.name.startswith("libavutil."))
                    for path in copy.rglob(dependency):
                        path.unlink()
                else:
                    target.unlink()
                    if fault == "wrong_companion":
                        shutil.copy2(copy / ("Contents/Frameworks/rust/libbilikara_runtime.dylib" if macos else "_internal/rust/libbilikara_runtime.so"), target)
                if macos:
                    report["stage"] = fault + "_resign"
                    invoke(["/usr/bin/codesign", "--force", "--deep", "--sign", "-", copy], env, work, timeout=120)
                failure_work = work / (fault + " home")
                failure_work.mkdir()
                failure_env = clean_environment(failure_work)
                report["stage"] = fault + "_native"
                invoke([copied_executable, "--tool-smoke", "native"], failure_env, failure_work)
                report["stage"] = fault + "_routing"
                result = invoke([copied_executable, "--tool-smoke", "media-routing"],
                                dict(failure_env, BILIKARA_LIBAV_FIXTURES=str(fixtures)), failure_work,
                                success=fault != "missing_dependency", timeout=120)
                if fault != "missing_dependency" and any(r["backend"] == "libav" for r in json.loads(result.stdout)["operations"]):
                    raise RuntimeError("broken companion produced false libav success")
                checks[fault] = "expected compatibility" if fault != "missing_dependency" else "explicit failure"
            report.update(outcome="success", stage="complete")
    except Exception as exc:
        report["error_type"] = type(exc).__name__
        if type(exc) is RuntimeError:
            report["reason"] = str(exc)[:256]
        raise RuntimeError("POSIX package smoke failed; see result stage") from None
    finally:
        result_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return json.dumps({"event": "bilikara.libav_package", "outcome": "success"})
