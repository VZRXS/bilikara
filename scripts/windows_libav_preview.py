"""MSVC dependency collection and package staging for x64 and ARM64."""
from __future__ import annotations

import json
import os
from pathlib import Path
import platform
import shutil
import sys

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = "ffmpeg-runtime.json"
TARGET = ("aarch64" if platform.machine().lower() in {"arm64", "aarch64"} else "x86_64") + "-pc-windows-msvc"
COMPANION = "bilikara_media_libav.dll"
TEST_COMPANION = "bilikara_media_libav_test.dll"


def pe_info(path: Path) -> dict:
    import pefile  # PyInstaller's Windows packaging dependency; build-time only.
    with pefile.PE(str(path), fast_load=True) as pe:
        expected = 0xAA64 if TARGET.startswith("aarch64") else 0x8664
        if pe.FILE_HEADER.Machine != expected:
            raise RuntimeError(f"Expected native MSVC PE: {path.name}")
        pe.parse_data_directories(directories=[
            pefile.DIRECTORY_ENTRY["IMAGE_DIRECTORY_ENTRY_IMPORT"],
            pefile.DIRECTORY_ENTRY["IMAGE_DIRECTORY_ENTRY_DELAY_IMPORT"],
        ])
        imports = sorted({entry.dll.decode("ascii").lower()
                          for attr in ("DIRECTORY_ENTRY_IMPORT", "DIRECTORY_ENTRY_DELAY_IMPORT")
                          for entry in getattr(pe, attr, [])})
        return {"machine": "arm64" if expected == 0xAA64 else "x64", "imports": imports}


def collect(prefix: Path, redist: Path, system: Path) -> dict:
    """Walk actual PE imports; only selected build, VC redist and Windows OS."""
    bindir = prefix / "bin"
    roots = ["ffmpeg.exe", "ffprobe.exe", COMPANION, TEST_COMPANION]
    local = {p.name.lower(): p for p in bindir.glob("*.dll")}
    runtime = {p.name.lower(): p for p in redist.glob("*.dll")}
    drivers = list((prefix / "driver").glob("*.exe"))
    pending = [bindir / n for n in roots] + drivers
    facts = {}
    system_imports = set()
    copied = []
    while pending:
        path = pending.pop()
        key = path.name.lower()
        if key in facts:
            continue
        facts[key] = pe_info(path)
        for name in facts[key]["imports"]:
            if name.startswith(("msys-", "cygwin", "libgcc", "libstdc++", "libwinpthread")):
                raise RuntimeError(f"Non-MSVC runtime import: {name}")
            if name in local:
                pending.append(local[name])
            elif name in runtime:
                destination = bindir / name
                shutil.copy2(runtime[name], destination)
                local[name] = destination
                pending.append(destination)
                copied.append(name)
            elif name.startswith(("api-ms-win-", "ext-ms-win-")) or (system / name).is_file():
                if name.startswith(("avcodec-", "avformat-", "avutil-", "avfilter-", "swresample-", "swscale-", "msys-", "libgcc", "libwinpthread")):
                    raise RuntimeError(f"Foreign toolchain/FFmpeg import: {name}")
                system_imports.add(name)
            else:
                raise RuntimeError(f"Unresolved preview PE import: {name}")
    # CLI restore excludes the optional companion/test DLLs, but includes the
    # complete CLI dependency closure. All libav DLLs stay alongside the shim.
    cli = set()
    pending_names = ["ffmpeg.exe", "ffprobe.exe"]
    while pending_names:
        name = pending_names.pop()
        if name in cli:
            continue
        cli.add(name)
        pending_names.extend(n for n in facts[name]["imports"] if n in facts)
    # /MD is a correctness requirement for the fd adapter, not just a compiler
    # flag echoed in provenance. All C participants must import the shared UCRT.
    for name in roots + [n for n in facts if n.startswith(("avformat-", "avcodec-", "avutil-"))]:
        if not any(n == "ucrtbase.dll" or n.startswith("api-ms-win-crt-") for n in facts[name]["imports"]):
            raise RuntimeError(f"Expected shared UCRT imports: {name}")
    driver_facts = {p.name.lower(): facts.pop(p.name.lower()) for p in drivers}
    data = {"schema_version": 1, "version": "9.0.1", "target": TARGET,
            "build_run": os.environ.get("GITHUB_RUN_ID", "local-helper-test"),
            "build_attempt": os.environ.get("GITHUB_RUN_ATTEMPT", "1"),
            "runtime_files": sorted(cli), "pe": facts,
            "driver_pe": driver_facts,
            "system_imports": sorted(system_imports), "vc_redist_files": sorted(copied)}
    (bindir / MANIFEST).write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    return data


def stage(prefix: Path, bundle: Path) -> None:
    """Post-PyInstaller staging avoids its implicit DLL search/collection."""
    vendor = bundle / "_internal/vendor"
    vendor.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((prefix / "bin" / MANIFEST).read_text(encoding="utf-8"))
    for name in manifest["pe"]:
        if name == TEST_COMPANION:
            continue
        shutil.copy2(prefix / "bin" / name, vendor / name)
    runtime_manifest = {
        key: manifest[key]
        for key in ("schema_version", "version", "target", "runtime_files", "build_run", "build_attempt")
        if key in manifest
    }
    (vendor / MANIFEST).write_text(json.dumps(runtime_manifest, indent=2) + "\n", encoding="utf-8")
    shutil.copytree(prefix / "licenses", bundle / "THIRD_PARTY_LICENSES/libav-preview", dirs_exist_ok=True)
    for source in (prefix / "source").glob("*.asc"):
        shutil.copy2(source, bundle / "THIRD_PARTY_SOURCES" / source.name)
    for name in ("bilikara_rust.dll", "bilikara_runtime.dll"):
        mandatory = pe_info(bundle / "_internal/rust" / name)
        if any(n.startswith(("bilikara_media_libav", "avformat-", "avcodec-", "avutil-")) for n in mandatory["imports"]):
            raise RuntimeError("Mandatory Runtime acquired a libav import")
    # Ship rebuild sources, not historical Linux acceptance notes containing
    # workstation paths. This also excludes developer outputs/private fixtures.
    for name in ("probe.h", "probe.c", "remux.c", "test_shim.c", "windows_io.h", "build.py",
                 "build-windows.sh", "prepare-windows.ps1", "fixtures/synthetic.h264"):
        destination = bundle / "THIRD_PARTY_SOURCES/media-libav" / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / "media-libav" / name, destination)
    shutil.copy2(ROOT / "media-libav/PACKAGING.md", bundle / "LIBAV_PACKAGING.md")


if __name__ == "__main__":
    if sys.argv[1] == "collect":
        collect(*(Path(p).resolve(strict=True) for p in sys.argv[2:5]))
    else:
        raise SystemExit("expected collect PREFIX VC_REDIST_DIR SYSTEM32")
