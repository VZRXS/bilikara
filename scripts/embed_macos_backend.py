#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
from pathlib import Path


EMBEDDED_BACKEND_RELATIVE_PATH = Path(
    "Contents/Frameworks/bilikara-backend.app"
)
BACKEND_EXECUTABLE_RELATIVE_PATH = Path("Contents/MacOS/bilikara")
DESKTOP_EXECUTABLE_RELATIVE_PATH = Path("Contents/MacOS/bilikara")


def _run(command: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )


def _require_app(app_path: Path, executable_relative_path: Path) -> Path:
    info_plist = app_path / "Contents" / "Info.plist"
    executable = app_path / executable_relative_path
    if not info_plist.is_file():
        raise RuntimeError(f"macOS application is missing Info.plist: {app_path}")
    if not executable.is_file():
        raise RuntimeError(f"macOS application is missing its executable: {executable}")
    if not os.access(executable, os.X_OK):
        raise RuntimeError(f"macOS application executable is not executable: {executable}")
    return executable


def _architectures(executable: Path) -> set[str]:
    result = _run(["/usr/bin/lipo", "-archs", str(executable)])
    architectures = {value.strip() for value in result.stdout.split() if value.strip()}
    if not architectures:
        raise RuntimeError(f"Could not determine Mach-O architecture: {executable}")
    return architectures


def _verify_signature(app_path: Path) -> None:
    _run(
        [
            "/usr/bin/codesign",
            "--verify",
            "--deep",
            "--strict",
            "--verbose=4",
            str(app_path),
        ]
    )


def _resign_app(app_path: Path) -> None:
    _run(
        [
            "/usr/bin/codesign",
            "--force",
            "--sign",
            "-",
            "--timestamp=none",
            "--preserve-metadata=identifier,entitlements,requirements,flags",
            str(app_path),
        ]
    )


def embed_backend(backend_app: Path, desktop_app: Path) -> Path:
    backend_app = backend_app.resolve()
    desktop_app = desktop_app.resolve()
    backend_executable = _require_app(
        backend_app,
        BACKEND_EXECUTABLE_RELATIVE_PATH,
    )
    desktop_executable = _require_app(
        desktop_app,
        DESKTOP_EXECUTABLE_RELATIVE_PATH,
    )
    _verify_signature(backend_app)
    _verify_signature(desktop_app)

    desktop_architectures = _architectures(desktop_executable)
    backend_architectures = _architectures(backend_executable)
    if not desktop_architectures.issubset(backend_architectures):
        raise RuntimeError(
            "Embedded backend architecture does not match the Desktop application: "
            f"desktop={sorted(desktop_architectures)} backend={sorted(backend_architectures)}"
        )

    destination = desktop_app / EMBEDDED_BACKEND_RELATIVE_PATH
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        shutil.rmtree(destination)
    _run(["/usr/bin/ditto", str(backend_app), str(destination)])

    embedded_executable = _require_app(
        destination,
        BACKEND_EXECUTABLE_RELATIVE_PATH,
    )
    if _architectures(embedded_executable) != backend_architectures:
        raise RuntimeError("Embedded backend architecture changed while copying the bundle")

    # The PyInstaller bundle has already signed every nested Mach-O object. The
    # copy preserves those signatures; re-sign the nested app envelope, then the
    # Desktop envelope, and make no further bundle changes after this point.
    _resign_app(destination)
    _verify_signature(destination)
    _resign_app(desktop_app)
    _verify_signature(desktop_app)
    return embedded_executable


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Embed and sign the frozen backend inside a macOS Tauri app"
    )
    parser.add_argument("backend_app", type=Path)
    parser.add_argument("desktop_app", type=Path)
    args = parser.parse_args()
    embedded_executable = embed_backend(args.backend_app, args.desktop_app)
    print(f"Embedded macOS backend: {embedded_executable}")


if __name__ == "__main__":
    main()
