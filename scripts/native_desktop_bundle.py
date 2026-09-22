"""Native desktop build/staging, never imported by the installed product."""
from __future__ import annotations

import json
import os
from pathlib import Path
import platform
import plistlib
import re
import shutil
import subprocess

import build_bundle as bundle
from scripts import libav_bundle


def target_output(crate: str, profile: str, target: str | None) -> Path:
    result = subprocess.check_output([
        "cargo", "metadata", "--manifest-path", str(bundle.ROOT_DIR / crate / "Cargo.toml"),
        "--format-version", "1", "--no-deps", "--locked",
    ], cwd=bundle.ROOT_DIR, text=True)
    root = Path(json.loads(result)["target_directory"])
    return (root / target if target else root) / profile


def selected_target(explicit: str | None) -> str | None:
    target = explicit or os.environ.get("CARGO_BUILD_TARGET")
    tauri_target = os.environ.get("TAURI_ENV_TARGET_TRIPLE")
    if not target and tauri_target and tauri_target != libav_bundle.native_target():
        target = tauri_target
    # Existing tool/libav pins are native architecture builds, not a cross
    # compilation toolchain. Do not silently package host binaries for a target.
    if target and target != libav_bundle.native_target():
        raise RuntimeError("Build desktop bundles on a matching target/architecture runner")
    return target


def stage_resources(destination: Path, executable: Path, *, development: bool,
                    macos_app: bool, prefix: Path | None) -> None:
    resources = destination / "Contents/Resources" if macos_app else destination
    code = destination / "Contents/MacOS" if macos_app else destination
    vendor = destination / "Contents/Frameworks/vendor" if macos_app else destination / "vendor"
    for directory in (resources, code, vendor):
        directory.mkdir(parents=True, exist_ok=True)
    name = "bilikara-desktop-host.exe" if platform.system() == "Windows" else "bilikara-desktop-host"
    if executable.resolve() != (code / name).resolve():
        shutil.copy2(executable, code / name)
    static = resources / "static"
    if static.exists():
        shutil.rmtree(static)
    shutil.copytree(bundle.ROOT_DIR / "static", static)
    version = bundle._bundle_version()
    if not re.fullmatch(r"[A-Za-z0-9.+_-]{1,80}", version):
        raise RuntimeError("Invalid trusted build version")
    (resources / "APP_VERSION").write_text(version + "\n", encoding="utf-8")
    (resources / "native-desktop.json").write_text(json.dumps({
        "schema_version": 1, "backend": "rust", "version": version,
        "platform": {"Windows": "windows", "Darwin": "macos", "Linux": "linux"}[platform.system()],
        "arch": "arm64" if libav_bundle.native_target().startswith("aarch64") else "x64",
        "development": development,
    }, indent=2) + "\n", encoding="utf-8")
    if macos_app:
        with (destination / "Contents/Info.plist").open("wb") as handle:
            plistlib.dump({"CFBundleExecutable": name, "CFBundleIdentifier": "com.bilikara.backend",
                          "CFBundleName": "bilikara backend", "CFBundlePackageType": "APPL",
                          "CFBundleVersion": ".".join(str(v) for v in bundle._windows_version_tuple(version)[:3]),
                          "CFBundleShortVersionString": ".".join(str(v) for v in bundle._windows_version_tuple(version)[:3]), "LSUIElement": True}, handle)
    tools, missing = bundle._resolved_bundle_binary_paths()
    if not development and any(name in bundle.REQUIRED_TOOL_BINARIES for name in missing):
        raise RuntimeError("Prepare the pinned BBDown vendor before packaging")
    if not development:
        bundle._validate_bbdown_redistribution_metadata(tools)
    for path in tools.values():
        shutil.copy2(path, vendor / path.name)
    resource_vendor = resources / "vendor"
    resource_vendor.mkdir(exist_ok=True)
    if macos_app:
        for source in tools.values():
            path = vendor / source.name
            link = resource_vendor / path.name
            if link.is_symlink() or link.exists():
                link.unlink()
            link.symlink_to(os.path.relpath(path, resource_vendor))
    metadata = bundle._macos_aria2_metadata_args(";")
    if metadata:
        shutil.copy2(metadata[1].rsplit(";", 1)[0], resource_vendor / "aria2-macos.json")
    if prefix:
        libav_bundle.stage(prefix, destination, native=True, macos_app=macos_app)
    elif not development:
        raise RuntimeError("BILIKARA_LIBAV_PREFIX is required for a complete native bundle")


def build_backend(*, development: bool, prepare_shell: bool, target: str | None) -> Path:
    target = selected_target(target)
    prefix = libav_bundle.package_prefix()
    if prefix and json.loads((prefix / "bin/ffmpeg-runtime.json").read_text()).get("kind") != "libav":
        raise RuntimeError("Native desktop requires a libav-only prefix; media CLI prefixes are retired")
    if not development and prefix is None:
        raise RuntimeError("BILIKARA_LIBAV_PREFIX is required for a complete native bundle")
    profile = "debug" if development else "release"
    command = ["cargo", "build", "--manifest-path", str(bundle.ROOT_DIR / "rust-runtime/Cargo.toml"),
               "--locked", "--features", "native-host", "--bin", "bilikara-desktop-host"]
    if not development:
        command.append("--release")
    if target:
        command.extend(["--target", target])
    subprocess.run(command, cwd=bundle.ROOT_DIR, check=True)
    name = "bilikara-desktop-host.exe" if platform.system() == "Windows" else "bilikara-desktop-host"
    executable = target_output("rust-runtime", profile, target) / name
    macos_app = platform.system() == "Darwin" and not prepare_shell
    destination = target_output("src-tauri", profile, target) if prepare_shell else bundle.ROOT_DIR / "dist" / ("bilikara.app" if macos_app else "bilikara")
    if not prepare_shell and destination.exists():
        shutil.rmtree(destination)  # Generated product only; never a user data root.
    stage_resources(destination, executable, development=development, macos_app=macos_app, prefix=prefix)
    if not prepare_shell:
        bundle._write_release_compliance_files()
        if macos_app:
            bundle.finalize_macos_app_bundle(destination)
    return destination


def build_desktop(backend: Path, *, target: str | None) -> None:
    target = selected_target(target)
    command = ["npm.cmd" if platform.system() == "Windows" else "npm", "exec", "--", "tauri", "build"]
    command.extend(["--bundles", "app"] if platform.system() == "Darwin" else ["--no-bundle"])
    if target:
        command.extend(["--target", target])
    command.extend(["--", "--locked"])
    subprocess.run(command, cwd=bundle.ROOT_DIR, check=True)
    shell = target_output("src-tauri", "release", target)
    if platform.system() == "Darwin":
        from scripts.embed_macos_backend import embed_backend
        desktop = backend.parent / "Bilikara-Desktop.app"
        if desktop.exists():
            shutil.rmtree(desktop)
        # ditto preserves the bundle's native links and signature metadata.
        subprocess.run(["/usr/bin/ditto", str(shell / "bundle/macos/bilikara.app"), str(desktop)], check=True)
        embed_backend(backend, desktop)
    else:
        name = "bilikara.exe" if platform.system() == "Windows" else "bilikara"
        output = "bilikara-desktop.exe" if platform.system() == "Windows" else "bilikara-desktop"
        shutil.copy2(shell / name, backend / output)
