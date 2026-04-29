from __future__ import annotations

import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

APP_NAME = "bilikara"
ROOT_DIR = Path(__file__).resolve().parent
VERSION_FILE = ROOT_DIR / "APP_VERSION"
REQUIRED_TOOL_BINARIES = ("ffmpeg",)
OPTIONAL_TOOL_BINARIES = ("ffprobe",)


def main() -> None:
    data_separator = ";" if platform.system() == "Windows" else ":"
    static_arg = f"{ROOT_DIR / 'static'}{data_separator}static"
    version_arg = f"{VERSION_FILE}{data_separator}."
    VERSION_FILE.write_text(_bundle_version(), encoding="utf-8")

    command = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--windowed",
        "--name",
        APP_NAME,
        "--add-data",
        static_arg,
        "--add-data",
        version_arg,
        str(ROOT_DIR / "start_bilikara.py"),
    ]
    command.extend(_bundled_binary_args(data_separator, verbose=True))

    if platform.system() == "Darwin":
        command.extend(["--osx-bundle-identifier", "com.bilikara.app"])

    subprocess.run(command, check=True, cwd=ROOT_DIR)
    print()
    print(f"Build complete. Output directory: {ROOT_DIR / 'dist'}")


def _bundle_version() -> str:
    version = os.getenv("BILIKARA_VERSION", "").strip()
    if version:
        return version
    ref_name = os.getenv("GITHUB_REF_NAME", "").strip()
    if ref_name:
        return ref_name
    return "dev"


def _bundled_binary_args(data_separator: str, *, verbose: bool = False) -> list[str]:
    args: list[str] = []
    bundled: list[str] = []
    missing: list[str] = []
    optional_missing: list[str] = []
    for binary_name in REQUIRED_TOOL_BINARIES:
        binary_path = _resolve_bundle_binary_path(binary_name)
        if not binary_path:
            missing.append(binary_name)
            continue
        bundled.append(str(binary_path.resolve()))
    for binary_name in OPTIONAL_TOOL_BINARIES:
        binary_path = _resolve_bundle_binary_path(binary_name)
        if not binary_path:
            optional_missing.append(binary_name)
            continue
        bundled.append(str(binary_path.resolve()))

    if missing:
        missing_text = ", ".join(missing)
        raise RuntimeError(
            f"Missing required external tools for bundle build: {missing_text}. "
            "Install ffmpeg and ensure it is available on PATH."
        )

    for source in bundled:
        args.extend(["--add-binary", f"{source}{data_separator}vendor"])

    if verbose:
        print("Bundling external tools:")
        for source in bundled:
            print(f"  - {source}")
        if optional_missing:
            print(f"Optional tools not bundled: {', '.join(optional_missing)}")

    return args


def _resolve_bundle_binary_path(binary_name: str) -> Path | None:
    direct = shutil.which(binary_name)
    if not direct:
        if binary_name == "ffprobe":
            return _resolve_ffprobe_from_ffmpeg()
        return None

    candidate = Path(direct)
    if platform.system() == "Windows":
        resolved = _resolve_windows_binary(binary_name, candidate)
        if resolved:
            return resolved
        if binary_name == "ffprobe":
            return _resolve_ffprobe_from_ffmpeg()
        return None
    return candidate


def _resolve_ffprobe_from_ffmpeg() -> Path | None:
    ffmpeg_path = _resolve_bundle_binary_path("ffmpeg")
    if not ffmpeg_path:
        return None

    names = ["ffprobe.exe", "ffprobe"] if platform.system() == "Windows" else ["ffprobe"]
    for name in names:
        sibling = ffmpeg_path.with_name(name)
        if sibling.exists():
            return sibling
    return None


def _resolve_windows_binary(binary_name: str, candidate: Path) -> Path | None:
    candidate_str = str(candidate).replace("/", "\\").lower()
    if "\\chocolatey\\bin\\" in candidate_str:
        root = candidate.parent.parent
        guesses = [
            root / "lib" / package_name / "tools" / package_name / "bin" / f"{binary_name}.exe"
            for package_name in _windows_package_names(binary_name)
        ]
        guesses.extend(
            root / "lib" / package_name / "tools" / "bin" / f"{binary_name}.exe"
            for package_name in _windows_package_names(binary_name)
        )
        for guess in guesses:
            if guess.exists():
                return guess
        return None

    if "\\scoop\\shims\\" in candidate_str:
        root = candidate.parent.parent
        for package_name in _windows_package_names(binary_name):
            guess = root / "apps" / package_name / "current" / "bin" / f"{binary_name}.exe"
            if guess.exists():
                return guess
        return None

    return candidate


def _windows_package_names(binary_name: str) -> list[str]:
    names = ["ffmpeg", binary_name]
    return list(dict.fromkeys(names))


if __name__ == "__main__":
    main()
