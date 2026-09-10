"""Build-only same-source libav package assembly for native desktop targets."""
from __future__ import annotations

import json
import os
from pathlib import Path
import platform
import re
import shutil
import struct
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
COMPANIONS = {"Windows": "bilikara_media_libav.dll", "Darwin": "libbilikara_media_libav.dylib",
              "Linux": "libbilikara_media_libav.so"}


def native_target() -> str:
    machine = platform.machine().lower()
    arch = {"amd64": "x86_64", "x86_64": "x86_64", "arm64": "aarch64", "aarch64": "aarch64"}.get(machine)
    suffix = {"Windows": "pc-windows-msvc", "Darwin": "apple-darwin", "Linux": "unknown-linux-gnu"}.get(platform.system())
    if arch is None or suffix is None:
        raise RuntimeError("Unsupported native libav bundle target")
    return f"{arch}-{suffix}"


def package_prefix() -> Path | None:
    value = os.environ.get("BILIKARA_LIBAV_PREFIX", "")
    if not value:
        return None
    prefix = Path(value)
    if not prefix.is_absolute():
        raise RuntimeError("Libav packaging requires an absolute same-build prefix")
    from bilikara.ffmpeg_vendor import runtime_files
    if runtime_files(prefix / "bin") is None or not (prefix / "bin" / COMPANIONS[platform.system()]).is_file():
        raise RuntimeError("Libav prefix is incomplete; no system fallback")
    data = json.loads((prefix / "bin/ffmpeg-runtime.json").read_text(encoding="utf-8"))
    if data["target"] != native_target():
        raise RuntimeError("Libav prefix does not match the native package target")
    for name in ("source/ffmpeg-9.0.1.tar.xz", "licenses/COPYING.LGPLv2.1", "build-info.json"):
        if not (prefix / name).is_file():
            raise RuntimeError("Libav prefix provenance is incomplete")
    return prefix


def output(*args) -> str:
    return subprocess.check_output([str(a) for a in args], text=True, encoding="utf-8")


def binary_info(path: Path) -> dict:
    """Inspect actual native import tables; never infer dependencies from names."""
    if platform.system() == "Darwin":
        arch = output("lipo", "-archs", path).strip()
        expected = "arm64" if native_target().startswith("aarch64") else "x86_64"
        if arch != expected:
            raise RuntimeError(f"Non-native Mach-O: {path.name}")
        imports = [line.strip().split(" (", 1)[0] for line in output("otool", "-L", path).splitlines()[1:]]
        # A dylib's first entry is its identity, not an import.
        if path.name.endswith(".dylib"):
            imports = imports[1:]
        return {"machine": arch, "imports": imports}
    header = path.read_bytes()[:20]
    expected = 183 if native_target().startswith("aarch64") else 62
    if len(header) != 20 or header[:6] != b"\x7fELF\x02\x01" or struct.unpack_from("<H", header, 18)[0] != expected:
        raise RuntimeError(f"Non-native ELF: {path.name}")
    return {"machine": "arm64" if expected == 183 else "x64",
            "imports": re.findall(r"\(NEEDED\).*\[([^\]]+)\]", output("readelf", "-d", path))}


def system_import(name: str) -> bool:
    if platform.system() == "Darwin":
        return name.startswith(("/usr/lib/", "/System/Library/"))
    return name in {"libc.so.6", "libm.so.6", "libpthread.so.0", "libdl.so.2", "librt.so.1",
                    "libresolv.so.2", "libgcc_s.so.1", "ld-linux-x86-64.so.2", "ld-linux-aarch64.so.1"}


def collect_posix(prefix: Path) -> None:
    bindir = prefix / "bin"
    roots = ["ffmpeg", "ffprobe", COMPANIONS[platform.system()],
             COMPANIONS[platform.system()].replace("libav.", "libav_test.")]
    facts = {}
    pending = list(roots)
    while pending:
        name = pending.pop()
        if name in facts:
            continue
        path = bindir / name
        facts[name] = binary_info(path)
        for dependency in facts[name]["imports"]:
            if system_import(dependency):
                continue
            filename = Path(dependency).name
            source = prefix / "lib" / filename
            if not filename.startswith(("libav", "libsw")) or not source.is_file():
                raise RuntimeError(f"Unresolved private libav dependency: {dependency}")
            if not (bindir / filename).exists():
                shutil.copy2(source, bindir / filename)
            pending.append(filename)
    for name, info in facts.items():
        path = bindir / name
        if platform.system() == "Darwin":
            for dep in info["imports"]:
                if not system_import(dep):
                    subprocess.run(["install_name_tool", "-change", dep, "@loader_path/" + Path(dep).name, str(path)], check=True)
            if name.endswith(".dylib"):
                subprocess.run(["install_name_tool", "-id", "@loader_path/" + name, str(path)], check=True)
            subprocess.run(["codesign", "--force", "--sign", "-", str(path)], check=True)
        else:
            subprocess.run(["patchelf", "--set-rpath", "$ORIGIN", str(path)], check=True)
        facts[name] = binary_info(path)
        for dep in facts[name]["imports"]:
            if not system_import(dep) and (Path(dep).name not in facts or
                    (platform.system() == "Darwin" and dep != "@loader_path/" + Path(dep).name)):
                raise RuntimeError("Private libav closure is not relocatable")
    cli = set()
    pending = ["ffmpeg", "ffprobe"]
    while pending:
        name = pending.pop()
        if name not in cli:
            cli.add(name)
            pending.extend(Path(d).name for d in facts[name]["imports"] if not system_import(d))
    drivers = {p.name: binary_info(p) for p in (prefix / "driver").iterdir() if p.is_file()}
    for info in drivers.values():
        if any(not system_import(dep) for dep in info["imports"]):
            raise RuntimeError("Developer driver acquired a non-system import")
    data = {"schema_version": 1, "version": "9.0.1", "target": native_target(),
            "runtime_files": sorted(cli), "binaries": facts, "drivers": drivers,
            "build_run": os.environ.get("GITHUB_RUN_ID", "local"),
            "build_attempt": os.environ.get("GITHUB_RUN_ATTEMPT", "1")}
    (bindir / "ffmpeg-runtime.json").write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def stage(prefix: Path, bundle: Path) -> None:
    if platform.system() == "Windows":
        from scripts.windows_libav_preview import stage as stage_windows
        stage_windows(prefix, bundle)
        return
    contents = bundle / "Contents" if platform.system() == "Darwin" else bundle
    resources = contents / "Resources" if platform.system() == "Darwin" else bundle
    vendor = contents / ("Frameworks/vendor" if platform.system() == "Darwin" else "_internal/vendor")
    vendor.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((prefix / "bin/ffmpeg-runtime.json").read_text(encoding="utf-8"))
    for name in manifest["binaries"]:
        destination = vendor / name
        # Replace PyInstaller data links with private native files, before signing.
        if destination.is_symlink():
            destination.unlink()
        shutil.copy2(prefix / "bin" / name, destination)
    manifest_path = vendor / "ffmpeg-runtime.json"
    if platform.system() == "Darwin":
        # Frameworks contains code. Match PyInstaller's data layout: the real
        # manifest is a resource, with a relative link beside the native files.
        resource_vendor = resources / "vendor"
        resource_vendor.mkdir(parents=True, exist_ok=True)
        resource_manifest = resource_vendor / manifest_path.name
        shutil.copy2(prefix / "bin" / manifest_path.name, resource_manifest)
        if manifest_path.exists() or manifest_path.is_symlink():
            manifest_path.unlink()
        manifest_path.symlink_to(os.path.relpath(resource_manifest, vendor))
    else:
        shutil.copy2(prefix / "bin" / manifest_path.name, manifest_path)
    shutil.copytree(prefix / "driver", resources / "libav-diagnostics", dirs_exist_ok=True)
    shutil.copytree(prefix / "records", resources / "libav-diagnostics/build", dirs_exist_ok=True)
    shutil.copytree(prefix / "licenses", resources / "THIRD_PARTY_LICENSES/libav", dirs_exist_ok=True)
    sources = resources / "THIRD_PARTY_SOURCES"
    sources.mkdir(exist_ok=True)
    for source in (prefix / "source").iterdir():
        shutil.copy2(source, sources / source.name)
    shutil.copy2(prefix / "build-info.json", resources / "libav-diagnostics/build-info.json")
    for name in ("probe.h", "probe.c", "remux.c", "test_shim.c", "windows_io.h", "build.py", "build-posix.sh", "fixtures/synthetic.h264"):
        destination = sources / "media-libav" / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / "media-libav" / name, destination)
    shutil.copy2(ROOT / "media-libav/PACKAGING.md", resources / "LIBAV_PACKAGING.md")
    for library in (contents / ("Frameworks/rust" if platform.system() == "Darwin" else "_internal/rust")).iterdir():
        if library.is_file() and any(Path(dep).name.startswith(("libav", "libbilikara_media_libav")) for dep in binary_info(library)["imports"]):
            raise RuntimeError("Mandatory Rust library acquired a libav import")


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] != "collect":
        raise SystemExit("expected collect PREFIX")
    collect_posix(Path(sys.argv[2]).resolve(strict=True))
