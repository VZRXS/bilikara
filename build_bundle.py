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
LEGAL_DOCUMENTS = ("LICENSE", "LEGAL.md", "THIRD_PARTY_NOTICES.md")
PYTHON_HTTPS_HIDDEN_IMPORTS = ("ssl", "_ssl", "urllib.request", "http.client", "certifi")


def main() -> None:
    data_separator = ";" if platform.system() == "Windows" else ":"
    static_arg = f"{ROOT_DIR / 'static'}{data_separator}static"
    version_arg = f"{VERSION_FILE}{data_separator}."
    VERSION_FILE.write_text(_bundle_version(), encoding="utf-8")
    spec_dir = ROOT_DIR / "build"
    spec_dir.mkdir(exist_ok=True)

    command = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--windowed",
        "--name",
        APP_NAME,
        "--specpath",
        str(spec_dir),
        "--add-data",
        static_arg,
        "--add-data",
        version_arg,
        str(ROOT_DIR / "start_bilikara.py"),
    ]
    command.extend(_python_https_args(data_separator, verbose=True))
    command.extend(_python_certifi_args(data_separator, verbose=True))
    command.extend(_bundled_binary_args(data_separator, verbose=True, validate=True))

    if platform.system() == "Darwin":
        command.extend(["--osx-bundle-identifier", "com.bilikara.app"])

    subprocess.run(command, check=True, cwd=ROOT_DIR)
    _write_release_compliance_files()
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


def _bundled_binary_args(data_separator: str, *, verbose: bool = False, validate: bool = False) -> list[str]:
    bundled_paths, _missing_tools = _resolved_bundle_binary_paths()
    missing_required = [binary_name for binary_name in REQUIRED_TOOL_BINARIES if binary_name not in bundled_paths]
    optional_missing = [binary_name for binary_name in OPTIONAL_TOOL_BINARIES if binary_name not in bundled_paths]

    if missing_required:
        missing_text = ", ".join(missing_required)
        raise RuntimeError(
            f"Missing required external tools for bundle build: {missing_text}. "
            "Install ffmpeg and ensure it is available on PATH."
        )
    if validate:
        _validate_ffmpeg_redistribution_metadata(bundled_paths)

    args: list[str] = []
    bundled = [str(path.resolve()) for path in bundled_paths.values()]
    for source in bundled:
        args.extend(["--add-binary", f"{source}{data_separator}vendor"])

    if verbose:
        print("Bundling external tools:")
        for source in bundled:
            print(f"  - {source}")
        if optional_missing:
            print(f"Optional tools not bundled: {', '.join(optional_missing)}")

    return args


def _validate_ffmpeg_redistribution_metadata(bundled_paths: dict[str, Path]) -> None:
    for binary_name in ("ffmpeg", "ffprobe"):
        binary_path = bundled_paths.get(binary_name)
        if not binary_path:
            continue
        version_output = _tool_version_output(binary_path)
        if "--enable-nonfree" in version_output:
            raise RuntimeError(
                f"{binary_name} appears to be built with --enable-nonfree and should not "
                "be redistributed in a public bilikara release. Use a redistributable "
                "FFmpeg build or disable FFmpeg bundling."
            )
        if "--enable-gpl" in version_output:
            print(
                f"Notice: {binary_name} appears to be built with --enable-gpl. "
                "Verify GPL redistribution obligations for this release."
            )


def _resolved_bundle_binary_paths() -> tuple[dict[str, Path], list[str]]:
    bundled: dict[str, Path] = {}
    missing: list[str] = []
    optional_missing: list[str] = []
    for binary_name in REQUIRED_TOOL_BINARIES:
        binary_path = _resolve_bundle_binary_path(binary_name)
        if not binary_path:
            missing.append(binary_name)
            continue
        bundled[binary_name] = binary_path
    for binary_name in OPTIONAL_TOOL_BINARIES:
        binary_path = _resolve_bundle_binary_path(binary_name)
        if not binary_path:
            optional_missing.append(binary_name)
            continue
        bundled[binary_name] = binary_path

    return bundled, missing + optional_missing


def _write_release_compliance_files() -> None:
    target_dir = _release_compliance_dir()
    if not target_dir:
        return
    target_dir.mkdir(parents=True, exist_ok=True)

    for document_name in LEGAL_DOCUMENTS:
        source = ROOT_DIR / document_name
        if source.exists():
            shutil.copy2(source, target_dir / document_name)

    licenses_dir = target_dir / "THIRD_PARTY_LICENSES"
    licenses_dir.mkdir(parents=True, exist_ok=True)
    bundled_paths, missing_tools = _resolved_bundle_binary_paths()
    _write_text(
        licenses_dir / "ffmpeg-source.txt",
        _ffmpeg_source_notice(bundled_paths, missing_tools),
    )
    for binary_name in ("ffmpeg", "ffprobe"):
        binary_path = bundled_paths.get(binary_name)
        if binary_path:
            _write_text(
                licenses_dir / f"{binary_name}-version.txt",
                _tool_version_output(binary_path),
            )


def _release_compliance_dir() -> Path | None:
    dist_dir = ROOT_DIR / "dist"
    if platform.system() == "Darwin":
        resources_dir = dist_dir / f"{APP_NAME}.app" / "Contents" / "Resources"
        return resources_dir if resources_dir.exists() else None
    bundle_dir = dist_dir / APP_NAME
    return bundle_dir if bundle_dir.exists() else None


def _ffmpeg_source_notice(bundled_paths: dict[str, Path], missing_tools: list[str]) -> str:
    lines = [
        "FFmpeg / FFprobe redistribution notes",
        "",
        "bilikara may bundle FFmpeg / FFprobe binaries from the build environment.",
        "These binaries are independent third-party software. Their license obligations",
        "depend on the exact build configuration of the binaries included in this release.",
        "",
        "Official FFmpeg legal information:",
        "https://ffmpeg.org/legal.html",
        "",
        "Bundled tool paths from the build environment:",
    ]
    for binary_name in ("ffmpeg", "ffprobe"):
        binary_path = bundled_paths.get(binary_name)
        lines.append(f"- {binary_name}: {binary_path.resolve() if binary_path else 'not bundled'}")
    if missing_tools:
        lines.extend(["", f"Missing optional tools during build: {', '.join(missing_tools)}"])
    lines.extend(
        [
            "",
            "Before redistributing a binary release, verify the FFmpeg / FFprobe build",
            "configuration and preserve or link the corresponding license and source",
            "information required by that build.",
        ]
    )
    return "\n".join(lines) + "\n"


def _tool_version_output(binary_path: Path) -> str:
    try:
        process = subprocess.run(
            [str(binary_path), "-version"],
            capture_output=True,
            text=True,
            errors="replace",
            check=False,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return f"Unable to run {binary_path}: {exc}\n"

    output = (process.stdout or "") + (process.stderr or "")
    if not output.strip():
        output = f"{binary_path} exited with code {process.returncode} and produced no output\n"
    return output


def _write_text(path: Path, content: str) -> None:
    path.write_text(content, encoding="utf-8", newline="\n")


def _python_https_args(data_separator: str, *, verbose: bool = False) -> list[str]:
    args: list[str] = []
    for module_name in PYTHON_HTTPS_HIDDEN_IMPORTS:
        args.extend(["--hidden-import", module_name])

    ssl_binaries = _python_https_binary_paths()
    for source in ssl_binaries:
        args.extend(["--add-binary", f"{source.resolve()}{data_separator}."])

    if verbose:
        print("Bundling Python HTTPS support:")
        print(f"  - hidden imports: {', '.join(PYTHON_HTTPS_HIDDEN_IMPORTS)}")
        if ssl_binaries:
            for source in ssl_binaries:
                print(f"  - {source}")
        elif platform.system() == "Windows":
            print("  - no OpenSSL DLLs found next to this Python installation")

    return args


def _python_https_binary_paths() -> list[Path]:
    if platform.system() != "Windows":
        return []

    roots = [
        Path(sys.prefix),
        Path(sys.base_prefix),
        Path(sys.exec_prefix),
        Path(sys.base_exec_prefix),
    ]
    search_dirs: list[Path] = []
    for root in roots:
        search_dirs.extend([root, root / "DLLs", root / "Library" / "bin"])

    paths: dict[str, Path] = {}
    for directory in search_dirs:
        if not directory.exists():
            continue
        for pattern in ("libssl*.dll", "libcrypto*.dll"):
            for candidate in directory.glob(pattern):
                if candidate.is_file():
                    paths[str(candidate.resolve()).lower()] = candidate
    return list(paths.values())


def _python_certifi_args(data_separator: str, *, verbose: bool = False) -> list[str]:
    try:
        import certifi
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError("certifi is required for bundle builds; run pip install -r requirements-packaging.txt") from exc

    cert_path = Path(certifi.where())
    if not cert_path.exists():
        raise RuntimeError(f"certifi CA bundle not found: {cert_path}")

    if verbose:
        print("Bundling certifi CA bundle:")
        print(f"  - {cert_path}")

    return ["--add-data", f"{cert_path.resolve()}{data_separator}certifi"]


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
