from __future__ import annotations

import platform
import shutil
import subprocess
import sys
from pathlib import Path

APP_NAME = "bilikara"
ROOT_DIR = Path(__file__).resolve().parent


def main() -> None:
    data_separator = ";" if platform.system() == "Windows" else ":"
    static_arg = f"{ROOT_DIR / 'static'}{data_separator}static"

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
        str(ROOT_DIR / "start_bilikara.py"),
    ]
    command.extend(_bundled_binary_args(data_separator))

    if platform.system() == "Darwin":
        command.extend(["--osx-bundle-identifier", "com.bilikara.app"])

    subprocess.run(command, check=True, cwd=ROOT_DIR)
    print()
    print(f"Build complete. Output directory: {ROOT_DIR / 'dist'}")


def _bundled_binary_args(data_separator: str) -> list[str]:
    args: list[str] = []
    bundled: list[str] = []
    missing: list[str] = []
    for binary_name in ("ffmpeg", "ffprobe"):
        binary_path = _resolve_bundle_binary_path(binary_name)
        if not binary_path:
            missing.append(binary_name)
            continue
        bundled.append(str(binary_path.resolve()))

    if missing:
        missing_text = ", ".join(missing)
        raise RuntimeError(
            f"Missing required external tools for bundle build: {missing_text}. "
            "Install ffmpeg/ffprobe and ensure they are available on PATH."
        )

    for source in bundled:
        args.extend(["--add-binary", f"{source}{data_separator}vendor"])

    print("Bundling external tools:")
    for source in bundled:
        print(f"  - {source}")

    return args


def _resolve_bundle_binary_path(binary_name: str) -> Path | None:
    direct = shutil.which(binary_name)
    if not direct:
        return None

    candidate = Path(direct)
    if platform.system() == "Windows":
        resolved = _resolve_windows_binary(binary_name, candidate)
        if resolved:
            return resolved
    return candidate


def _resolve_windows_binary(binary_name: str, candidate: Path) -> Path | None:
    candidate_str = str(candidate).replace("/", "\\").lower()
    if "\\chocolatey\\bin\\" in candidate_str:
        root = candidate.parent.parent
        guesses = [
            root / "lib" / binary_name / "tools" / binary_name / "bin" / f"{binary_name}.exe",
            root / "lib" / binary_name / "tools" / "bin" / f"{binary_name}.exe",
        ]
        for guess in guesses:
            if guess.exists():
                return guess

    if "\\scoop\\shims\\" in candidate_str:
        root = candidate.parent.parent
        guess = root / "apps" / binary_name / "current" / "bin" / f"{binary_name}.exe"
        if guess.exists():
            return guess

    return candidate


if __name__ == "__main__":
    main()
