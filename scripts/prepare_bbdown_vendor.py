#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import os
import platform
import re
import shutil
import stat
import subprocess
import tempfile
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath


BBDOWN_VERSION = "1.6.3"
BBDOWN_RELEASE_COMMIT = "45622f79cd766e0fc6f5cbd49fcf4960340f35c3"
BBDOWN_RELEASE_BASE = f"https://github.com/nilaoda/BBDown/releases/download/{BBDOWN_VERSION}"
BBDOWN_MIRROR_BASE = "https://download.kevinx96.icu/bilikara/tools"
BBDOWN_ASSETS = {
    ("windows", "x64"): (
        "BBDown_1.6.3_20240814_win-x64.zip",
        "40f1e2af0d4e74df765c6f93d2e931f9bea201d5168d0bc62dc35a54b7e0ec02",
    ),
    ("windows", "arm64"): (
        "BBDown_1.6.3_20240814_win-arm64.zip",
        "da8fc9cbf1031f4c4ca97af82d98bbfd1bbc55bd8ea49602da8d3d1613c190ff",
    ),
    ("macos", "x64"): (
        "BBDown_1.6.3_20240814_osx-x64.zip",
        "262c15ca7890898560d00e5ffd5ada1864fbd9d0d58ac4ee492c9f3e73f3ae5f",
    ),
    ("macos", "arm64"): (
        "BBDown_1.6.3_20240814_osx-arm64.zip",
        "4df84014d818bd6dff2b365b847645340e8955c4450fe965688f41af89a38baa",
    ),
}


def _normalized_platform(value: str) -> str:
    normalized = value.strip().lower()
    aliases = {"darwin": "macos", "win32": "windows", "win": "windows"}
    return aliases.get(normalized, normalized)


def _normalized_arch(value: str) -> str:
    normalized = value.strip().lower()
    if normalized in {"amd64", "x86_64", "x64"}:
        return "x64"
    if normalized in {"aarch64", "arm64"}:
        return "arm64"
    return normalized


def _download(urls: tuple[str, ...], target: Path) -> str:
    failures: list[str] = []
    for url in urls:
        request = urllib.request.Request(url, headers={"User-Agent": "bilikara-bundle-builder"})
        try:
            with urllib.request.urlopen(request, timeout=120) as response, target.open("wb") as output:
                shutil.copyfileobj(response, output)
            return url
        except Exception as exc:  # noqa: BLE001
            target.unlink(missing_ok=True)
            failures.append(f"{url}: {type(exc).__name__}: {exc}")
    raise RuntimeError("Unable to download pinned BBDown asset: " + "; ".join(failures))


def _safe_zip_member(name: str) -> bool:
    normalized = name.replace("\\", "/")
    path = PurePosixPath(normalized)
    return not path.is_absolute() and ".." not in path.parts


def _extract_binary(archive: Path, target: Path) -> None:
    expected_name = target.name.lower()
    with zipfile.ZipFile(archive) as bundle:
        matches = [
            info
            for info in bundle.infolist()
            if not info.is_dir()
            and _safe_zip_member(info.filename)
            and PurePosixPath(info.filename.replace("\\", "/")).name.lower() == expected_name
        ]
        if len(matches) != 1:
            raise RuntimeError(
                f"Pinned BBDown archive must contain exactly one {target.name}; found {len(matches)}"
            )
        with bundle.open(matches[0]) as source, target.open("wb") as output:
            shutil.copyfileobj(source, output)


def _validated_version(binary: Path) -> str:
    process = subprocess.run(
        [str(binary), "--help"],
        shell=False,
        capture_output=True,
        text=True,
        errors="replace",
        check=False,
        timeout=30,
    )
    output = "\n".join(part for part in (process.stdout, process.stderr) if part)
    match = re.search(r"(?i)\b(?:v|version\s*)?(\d+(?:\.\d+){1,3})", output)
    if process.returncode != 0 or not match or match.group(1) != BBDOWN_VERSION:
        raise RuntimeError(
            f"Pinned BBDown executable validation failed (exit={process.returncode}): {output.strip()}"
        )
    return match.group(1)


def prepare(platform_name: str, arch: str, output_dir: Path) -> Path:
    target = (_normalized_platform(platform_name), _normalized_arch(arch))
    if target not in BBDOWN_ASSETS:
        raise RuntimeError(f"No pinned BBDown release asset for {target[0]}/{target[1]}")
    asset_name, expected_sha256 = BBDOWN_ASSETS[target]
    output_dir.mkdir(parents=True, exist_ok=True)
    bin_dir = output_dir / "bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    binary_name = "BBDown.exe" if target[0] == "windows" else "BBDown"
    binary_path = bin_dir / binary_name

    with tempfile.TemporaryDirectory(prefix="bilikara-bbdown-") as temp_value:
        archive = Path(temp_value) / asset_name
        source_url = _download(
            (
                f"{BBDOWN_RELEASE_BASE}/{asset_name}",
                f"{BBDOWN_MIRROR_BASE}/{asset_name}",
            ),
            archive,
        )
        actual_sha256 = hashlib.sha256(archive.read_bytes()).hexdigest()
        if actual_sha256 != expected_sha256:
            raise RuntimeError(
                f"Pinned BBDown SHA-256 mismatch for {asset_name}: "
                f"expected {expected_sha256}, got {actual_sha256}"
            )
        _extract_binary(archive, binary_path)

    binary_path.chmod(binary_path.stat().st_mode | stat.S_IEXEC)
    version = _validated_version(binary_path)
    license_file = Path(__file__).resolve().parents[1] / "third_party" / "BBDown-LICENSE.txt"
    if not license_file.is_file():
        raise RuntimeError(f"BBDown license file is missing: {license_file}")
    metadata = {
        "BILIKARA_BBDOWN_VERSION": version,
        "BILIKARA_BBDOWN_RELEASE_COMMIT": BBDOWN_RELEASE_COMMIT,
        "BILIKARA_BBDOWN_SOURCE_URL": source_url,
        "BILIKARA_BBDOWN_ARCHIVE_NAME": asset_name,
        "BILIKARA_BBDOWN_SHA256": expected_sha256,
        "BILIKARA_BBDOWN_LICENSE_FILE": str(license_file),
    }
    metadata_path = output_dir / "metadata.env"
    metadata_path.write_text(
        "".join(f"{key}={value}{os.linesep}" for key, value in metadata.items()),
        encoding="utf-8",
    )
    print(f"Prepared pinned BBDown {version} for {target[0]}/{target[1]}: {binary_path}")
    return binary_path


def main() -> None:
    parser = argparse.ArgumentParser(description="Prepare the pinned BBDown bundle vendor binary")
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--platform", default=platform.system())
    parser.add_argument("--arch", default=platform.machine())
    args = parser.parse_args()
    prepare(args.platform, args.arch, args.output_dir.resolve())


if __name__ == "__main__":
    main()
