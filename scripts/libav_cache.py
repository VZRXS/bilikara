"""Cache only the verified upstream C libraries, never application binaries."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys


def cache_key() -> str:
    root = Path(__file__).resolve().parents[1]
    system = platform.system()
    arch = platform.machine()
    # Only the selected C recipe produces this cache. Companion/Rust builds
    # run after restore/snapshot and must never invalidate upstream libraries.
    recipe = "windows" if system == "Windows" else "posix"
    inputs = {
        "schema": 2,
        "system": system,
        "arch": arch,
        # Keep the OS generation and actual toolchain/SDK identity, not the
        # runner image revision: unrelated preinstalled tools also change it.
        "environment": {name: os.environ.get(name, "") for name in (
            "ImageOS", "VCToolsVersion", "WindowsSDKVersion",
            "CC", "CXX", "CFLAGS", "CXXFLAGS", "CPPFLAGS", "LDFLAGS", "SDKROOT", "DEVELOPER_DIR",
            "VSCMD_ARG_TGT_ARCH", "VSCMD_ARG_HOST_ARCH", "MACOSX_DEPLOYMENT_TARGET", "BILIKARA_LIBAV_PREFIX",
        )},
        "scripts": {name: hashlib.sha256((root / name).read_bytes()).hexdigest()
                    for name in (f"media-libav/build-{recipe}-libraries.sh",
                                 "scripts/libav_cache.py")},
    }
    commands = [["cl.exe"]] if system == "Windows" else [["cc", "--version"]]
    if system == "Darwin":
        commands.append(["xcrun", "--show-sdk-version"])
    inputs["compiler"] = []
    for command in commands:
        result = subprocess.run(command, capture_output=True, text=True, errors="replace")
        inputs["compiler"].append(result.stdout + result.stderr)
    digest = hashlib.sha256(json.dumps(inputs, sort_keys=True).encode()).hexdigest()
    return f"libav-v2-{system}-{arch}-{digest}"


def snapshot(prefix: Path, cache: Path) -> None:
    if cache.exists():
        shutil.rmtree(cache)
    cache.mkdir(parents=True)
    # Called immediately after make install, before companion/driver generation.
    for name in ("bin", "lib", "include", "share", "source", "licenses", "records"):
        source = prefix / name
        if source.exists():
            shutil.copytree(source, cache / name, symlinks=True,
                            ignore=shutil.ignore_patterns("*.exe", "ffmpeg", "ffprobe", "*bilikara*", "companion*",
                                                         "build-info.json", "build_config.h", "runtime-test*"))
    files = {str(path.relative_to(cache)): hashlib.sha256(path.read_bytes()).hexdigest()
             for path in cache.rglob("*") if path.is_file()}
    (cache / "cache-manifest.json").write_text(json.dumps(files, sort_keys=True), encoding="utf-8")


def restore(cache: Path, prefix: Path) -> None:
    files = json.loads((cache / "cache-manifest.json").read_text(encoding="utf-8"))
    for relative, expected in files.items():
        path = cache / relative
        if not path.resolve().is_relative_to(cache.resolve()):
            raise RuntimeError(f"Invalid libav cache path: {relative}")
        if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise RuntimeError(f"Invalid libav cache content: {relative}")
    shutil.copytree(cache, prefix, symlinks=True, dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns("cache-manifest.json"))


if __name__ == "__main__":
    if sys.argv[1] == "key":
        print(f"key={cache_key()}")
    elif sys.argv[1] == "snapshot":
        snapshot(Path(sys.argv[2]), Path(sys.argv[3]))
    elif sys.argv[1] == "restore":
        restore(Path(sys.argv[2]), Path(sys.argv[3]))
    else:
        raise SystemExit("Expected key, snapshot or restore")
