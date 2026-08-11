from __future__ import annotations

import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
from pathlib import Path

APP_NAME = "bilikara"
APP_PUBLISHER = "VZRXS"
ROOT_DIR = Path(__file__).resolve().parent
VERSION_FILE = ROOT_DIR / "APP_VERSION"
REQUIRED_TOOL_BINARIES = ("ffmpeg",)
OPTIONAL_TOOL_BINARIES = ("ffprobe",)
LEGAL_DOCUMENTS = ("LICENSE", "LEGAL.md", "THIRD_PARTY_NOTICES.md")
PYTHON_HTTPS_HIDDEN_IMPORTS = (
    "ssl",
    "_ssl",
    "urllib.request",
    "http.client",
    "certifi",
    "truststore",
)
PYTHON_HTTPS_PLATFORM_HIDDEN_IMPORTS = {
    "Darwin": ("truststore._macos",),
    "Windows": ("truststore._windows",),
    "Linux": ("truststore._openssl",),
}
RUST_BUNDLE_DIR = "rust"
RUST_STRICT_ENV = "BILIKARA_REQUIRE_RUST_LIB"
FFMPEG_SOURCE_ENV = {
    "version": "BILIKARA_FFMPEG_SOURCE_VERSION",
    "url": "BILIKARA_FFMPEG_SOURCE_URL",
    "sha256": "BILIKARA_FFMPEG_SOURCE_SHA256",
    "archive": "BILIKARA_FFMPEG_SOURCE_ARCHIVE",
    "license": "BILIKARA_FFMPEG_LICENSE_FILE",
}
BBDOWN_SOURCE_ENV = {
    "version": "BILIKARA_BBDOWN_VERSION",
    "commit": "BILIKARA_BBDOWN_RELEASE_COMMIT",
    "url": "BILIKARA_BBDOWN_SOURCE_URL",
    "archive": "BILIKARA_BBDOWN_ARCHIVE_NAME",
    "sha256": "BILIKARA_BBDOWN_SHA256",
    "license": "BILIKARA_BBDOWN_LICENSE_FILE",
}
ARIA2_MACOS_METADATA_ENV = "BILIKARA_ARIA2_MACOS_METADATA_FILE"
MACOS_SYSTEM_DEPENDENCY_PREFIXES = ("/usr/lib/", "/System/Library/")


def main() -> None:
    data_separator = ";" if platform.system() == "Windows" else ":"
    static_arg = f"{ROOT_DIR / 'static'}{data_separator}static"
    version_arg = f"{VERSION_FILE}{data_separator}."
    bundle_version = _bundle_version()
    VERSION_FILE.write_text(bundle_version, encoding="utf-8")
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
    command.extend(_macos_aria2_metadata_args(data_separator, verbose=True))
    command.extend(_rust_library_args(data_separator, verbose=True))

    if platform.system() == "Windows":
        version_info_file = _write_windows_version_info(bundle_version, spec_dir)
        command.extend(["--version-file", str(version_info_file)])

    if platform.system() == "Darwin":
        command.extend(["--osx-bundle-identifier", "com.bilikara.app"])

    subprocess.run(  # nosemgrep: python.lang.security.audit.dangerous-subprocess-use-audit
        command, shell=False, check=True, cwd=ROOT_DIR
    )
    _write_release_compliance_files()
    if platform.system() == "Darwin":
        finalize_macos_app_bundle(ROOT_DIR / "dist" / f"{APP_NAME}.app")
    print()
    print(f"Build complete. Output directory: {ROOT_DIR / 'dist'}")


MACHO_MAGICS = {
    b"\xcf\xfa\xed\xfe",
    b"\xfe\xed\xfa\xcf",
    b"\xce\xfa\xed\xfe",
    b"\xfe\xed\xfa\xce",
    b"\xca\xfe\xba\xbe",
    b"\xbe\xba\xfe\xca",
}


def _is_macho_file(path: Path) -> bool:
    if not path.is_file() or path.is_symlink():
        return False
    try:
        with path.open("rb") as handle:
            header = handle.read(4)
            if len(header) == 4 and header in MACHO_MAGICS:
                return True
    except OSError:
        pass
    return False


def _lint_info_plist(info_plist: Path) -> None:
    plutil = shutil.which("plutil")
    if not plutil:
        return
    res = subprocess.run([plutil, "-lint", str(info_plist)], capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"plutil -lint failed for {info_plist}: {res.stderr or res.stdout}")


def _sign_path(target: Path) -> None:
    codesign = shutil.which("codesign")
    if not codesign:
        raise RuntimeError("codesign binary not found on PATH")
    res = subprocess.run(
        [codesign, "--force", "--sign", "-", "--timestamp=none", str(target)],
        capture_output=True,
        text=True,
    )
    if res.returncode != 0:
        raise RuntimeError(f"codesign failed for {target}: {res.stderr or res.stdout}")


def _verify_codesign(target: Path, deep: bool = True, strict: bool = True) -> bool:
    codesign = shutil.which("codesign")
    if not codesign:
        return True
    cmd = [codesign, "--verify"]
    if deep:
        cmd.append("--deep")
    if strict:
        cmd.append("--strict")
    cmd.extend(["--verbose=4", str(target)])
    res = subprocess.run(cmd, capture_output=True, text=True)
    return res.returncode == 0


def _show_codesign_details(target: Path) -> None:
    codesign = shutil.which("codesign")
    if not codesign:
        return
    res = subprocess.run([codesign, "-dv", "--verbose=4", str(target)], capture_output=True, text=True)
    print(f"Codesign details for {target}:\n{res.stderr or res.stdout}")


def _sign_nested_macho_objects(app_path: Path) -> None:
    contents_dir = app_path / "Contents"
    if not contents_dir.exists():
        return
    for root, _, files in os.walk(contents_dir):
        for name in files:
            p = Path(root) / name
            if _is_macho_file(p):
                print(f"Signing nested Mach-O code object: {p}")
                _sign_path(p)


def finalize_macos_app_bundle(app_path: Path) -> None:
    if platform.system() != "Darwin":
        return

    info_plist = app_path / "Contents" / "Info.plist"
    executable = app_path / "Contents" / "MacOS" / "bilikara"

    if not info_plist.is_file():
        raise RuntimeError(f"Missing Contents/Info.plist in bundle: {app_path}")

    if not executable.is_file():
        raise RuntimeError(f"Missing Contents/MacOS/bilikara executable in bundle: {app_path}")

    if not os.access(executable, os.X_OK):
        raise RuntimeError(f"Main executable is not executable: {executable}")

    _lint_info_plist(info_plist)

    print(f"Finalizing macOS ad-hoc signing for {app_path}...")
    _sign_nested_macho_objects(app_path)
    _sign_path(app_path)
    if not _verify_codesign(app_path, deep=True, strict=True):
        raise RuntimeError(f"Strict codesign verification failed for {app_path}")

    _show_codesign_details(app_path)


def _write_windows_version_info(bundle_version: str, spec_dir: Path) -> Path:
    version_tuple = _windows_version_tuple(bundle_version)
    version_text = bundle_version or "dev"
    version_file = spec_dir / "bilikara_version_info.txt"
    version_file.write_text(
        """# UTF-8
VSVersionInfo(
  ffi=FixedFileInfo(
    filevers={version_tuple!r},
    prodvers={version_tuple!r},
    mask=0x3f,
    flags=0x0,
    OS=0x40004,
    fileType=0x1,
    subtype=0x0,
    date=(0, 0)
  ),
  kids=[
    StringFileInfo([
      StringTable(
        '040904B0',
        [
          StringStruct('CompanyName', {publisher!r}),
          StringStruct('FileDescription', 'bilikara backend launcher'),
          StringStruct('FileVersion', {version_text!r}),
          StringStruct('InternalName', {app_name!r}),
          StringStruct('LegalCopyright', 'Copyright (c) VZRXS'),
          StringStruct('OriginalFilename', {original_filename!r}),
          StringStruct('ProductName', {app_name!r}),
          StringStruct('ProductVersion', {version_text!r})
        ]
      )
    ]),
    VarFileInfo([VarStruct('Translation', [1033, 1200])])
  ]
)
""".format(
            version_tuple=version_tuple,
            publisher=APP_PUBLISHER,
            version_text=version_text,
            app_name=APP_NAME,
            original_filename=f"{APP_NAME}.exe",
        ),
        encoding="utf-8",
    )
    return version_file


def _windows_version_tuple(version: str) -> tuple[int, int, int, int]:
    parts = [min(int(part), 65535) for part in re.findall(r"\d+", version)[:4]]
    while len(parts) < 4:
        parts.append(0)
    return tuple(parts)


def _bundle_version() -> str:
    version = os.getenv("BILIKARA_VERSION", "").strip()
    if version:
        return version
    ref_name = os.getenv("GITHUB_REF_NAME", "").strip()
    if ref_name:
        return ref_name
    return "dev"


def _bundled_binary_args(data_separator: str, *, verbose: bool = False, validate: bool = False) -> list[str]:
    args: list[str] = []
    bundled_paths, missing_tools = _resolved_bundle_binary_paths()
    required_tools = set(REQUIRED_TOOL_BINARIES)
    if platform.system() == "Darwin":
        required_tools.update(OPTIONAL_TOOL_BINARIES)
    missing_required = [name for name in missing_tools if name in required_tools]
    optional_missing = [name for name in missing_tools if name not in required_tools]

    if missing_required:
        missing_text = ", ".join(missing_required)
        raise RuntimeError(
            f"Missing required external tools for bundle build: {missing_text}. "
            "Install ffmpeg and ensure it is available on PATH."
        )

    if validate:
        _validate_ffmpeg_redistribution_metadata(bundled_paths)

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


def _rust_library_name() -> str:
    system = platform.system()
    if system == "Windows":
        return "bilikara_rust.dll"
    if system == "Darwin":
        return "libbilikara_rust.dylib"
    return "libbilikara_rust.so"


def _macos_aria2_metadata_args(
    data_separator: str,
    *,
    verbose: bool = False,
) -> list[str]:
    if platform.system() != "Darwin":
        return []
    raw_path = os.getenv(ARIA2_MACOS_METADATA_ENV, "").strip()
    if not raw_path:
        raise RuntimeError(
            f"{ARIA2_MACOS_METADATA_ENV} is required for a macOS release bundle"
        )
    metadata_path = Path(raw_path).expanduser()
    if not metadata_path.is_file():
        raise RuntimeError(f"Configured macOS aria2c metadata not found: {metadata_path}")
    try:
        payload = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Invalid macOS aria2c metadata: {metadata_path}") from exc
    required = {
        "schema_version": 1,
        "tool": "aria2c",
        "provider": "bilikara-r2",
        "platform": "darwin",
    }
    if any(payload.get(key) != value for key, value in required.items()):
        raise RuntimeError(f"Unexpected macOS aria2c metadata identity: {metadata_path}")
    metadata_arch = payload.get("arch")
    if metadata_arch not in {"arm64", "x64"}:
        raise RuntimeError(f"Invalid macOS aria2c metadata architecture: {metadata_path}")
    machine = platform.machine().lower()
    expected_arch = "arm64" if machine in {"arm64", "aarch64"} else "x64"
    if metadata_arch != expected_arch:
        raise RuntimeError(
            f"macOS aria2c metadata targets {metadata_arch}, but the bundle target is {expected_arch}"
        )
    if not re.fullmatch(r"[0-9a-f]{64}", str(payload.get("sha256") or "")):
        raise RuntimeError(f"Invalid macOS aria2c asset SHA-256: {metadata_path}")
    if not str(payload.get("url") or "").startswith("https://"):
        raise RuntimeError(f"macOS aria2c asset URL must use HTTPS: {metadata_path}")
    if verbose:
        print(f"Bundling pinned macOS aria2c download metadata: {metadata_path}")
    return [
        "--add-data",
        f"{metadata_path.resolve()}{data_separator}vendor/aria2-macos.json",
    ]


def _rust_library_args(data_separator: str, *, verbose: bool = False) -> list[str]:
    library_path = ROOT_DIR / "rust" / "target" / "release" / _rust_library_name()
    if library_path.is_file():
        if verbose:
            print("Bundling Rust title cleanup library:")
            print(f"  - {library_path}")
        return ["--add-binary", f"{library_path.resolve()}{data_separator}{RUST_BUNDLE_DIR}"]

    message = f"Rust library not found; using Python fallback: {library_path}"
    if os.getenv(RUST_STRICT_ENV, "").strip().lower() in {"1", "true", "yes", "on"}:
        raise RuntimeError(message)
    if verbose:
        print(f"Warning: {message}")
    return []


def _validate_ffmpeg_redistribution_metadata(bundled_paths: dict[str, Path]) -> None:
    for binary_name in ("ffmpeg", "ffprobe"):
        binary_path = bundled_paths.get(binary_name)
        if not binary_path:
            continue
        return_code, version_output = _run_tool_version(binary_path)
        if return_code != 0:
            raise RuntimeError(
                f"{binary_name} failed its release build execution check: "
                f"{version_output.strip()}"
            )
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
        if platform.system() == "Darwin":
            _validate_macos_tool_portability(binary_path)


def _macos_dynamic_dependencies(binary_path: Path) -> list[str]:
    otool = Path("/usr/bin/otool")
    otool_command = str(otool) if otool.is_file() else shutil.which("otool")
    if not otool_command:
        raise RuntimeError("otool is required to validate portable macOS release tools")
    process = subprocess.run(
        [otool_command, "-L", str(binary_path)],
        shell=False,
        capture_output=True,
        text=True,
        errors="replace",
        check=False,
    )
    if process.returncode != 0:
        raise RuntimeError(
            f"otool -L failed for {binary_path}: "
            f"{(process.stderr or process.stdout).strip()}"
        )
    dependencies: list[str] = []
    for line in process.stdout.splitlines()[1:]:
        dependency = line.strip().split(" (compatibility version", 1)[0].strip()
        if dependency:
            dependencies.append(dependency)
    return dependencies


def _validate_macos_tool_portability(binary_path: Path) -> None:
    non_system_dependencies = [
        dependency
        for dependency in _macos_dynamic_dependencies(binary_path)
        if not dependency.startswith(MACOS_SYSTEM_DEPENDENCY_PREFIXES)
    ]
    if non_system_dependencies:
        formatted = ", ".join(non_system_dependencies)
        raise RuntimeError(
            f"macOS release tool {binary_path} has non-portable dynamic dependencies: "
            f"{formatted}. Use a pinned portable build instead of a Homebrew or other "
            "externally linked executable."
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
    _copy_ffmpeg_source_material(target_dir, licenses_dir)
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
    source_metadata = _ffmpeg_source_metadata()
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
    if source_metadata.get("version"):
        lines.extend(
            [
                "",
                "Pinned portable macOS build provenance:",
                f"- FFmpeg version: {source_metadata['version']}",
                f"- Official source URL: {source_metadata.get('url') or 'not recorded'}",
                f"- Source SHA-256: {source_metadata.get('sha256') or 'not recorded'}",
                "- Exact source archive: THIRD_PARTY_SOURCES/"
                f"{Path(source_metadata['archive']).name if source_metadata.get('archive') else 'not packaged'}",
                "- Build configuration: see ffmpeg-version.txt and ffprobe-version.txt",
            ]
        )
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


def _ffmpeg_source_metadata() -> dict[str, str]:
    return {
        key: os.getenv(environment_name, "").strip()
        for key, environment_name in FFMPEG_SOURCE_ENV.items()
    }


def _copy_ffmpeg_source_material(target_dir: Path, licenses_dir: Path) -> None:
    metadata = _ffmpeg_source_metadata()
    archive_value = metadata.get("archive")
    if archive_value:
        archive_path = Path(archive_value).expanduser()
        if not archive_path.is_file():
            raise RuntimeError(f"Configured FFmpeg source archive not found: {archive_path}")
        expected_sha256 = metadata.get("sha256", "").lower()
        if expected_sha256:
            actual_sha256 = hashlib.sha256(archive_path.read_bytes()).hexdigest()
            if actual_sha256 != expected_sha256:
                raise RuntimeError(
                    f"FFmpeg source archive SHA-256 mismatch: expected {expected_sha256}, "
                    f"got {actual_sha256}"
                )
        sources_dir = target_dir / "THIRD_PARTY_SOURCES"
        sources_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(archive_path, sources_dir / archive_path.name)

    license_value = metadata.get("license")
    if license_value:
        license_path = Path(license_value).expanduser()
        if not license_path.is_file():
            raise RuntimeError(f"Configured FFmpeg license file not found: {license_path}")
        shutil.copy2(license_path, licenses_dir / "FFmpeg-COPYING.LGPLv2.1.txt")


def _run_tool_version(binary_path: Path) -> tuple[int | None, str]:
    try:
        process = subprocess.run(  # nosemgrep: python.lang.security.audit.dangerous-subprocess-use-audit
            [str(binary_path), "-version"],
            shell=False,
            capture_output=True,
            text=True,
            errors="replace",
            check=False,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return None, f"Unable to run {binary_path}: {exc}\n"

    output = (process.stdout or "") + (process.stderr or "")
    if not output.strip():
        output = f"{binary_path} exited with code {process.returncode} and produced no output\n"
    return process.returncode, output


def _tool_version_output(binary_path: Path) -> str:
    return _run_tool_version(binary_path)[1]


def _write_text(path: Path, content: str) -> None:
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(content)


def _python_https_args(data_separator: str, *, verbose: bool = False) -> list[str]:
    args: list[str] = []
    hidden_imports = PYTHON_HTTPS_HIDDEN_IMPORTS + PYTHON_HTTPS_PLATFORM_HIDDEN_IMPORTS.get(
        platform.system(), ()
    )
    for module_name in hidden_imports:
        args.extend(["--hidden-import", module_name])

    ssl_binaries = _python_https_binary_paths()
    for source in ssl_binaries:
        args.extend(["--add-binary", f"{source.resolve()}{data_separator}."])

    if verbose:
        print("Bundling Python HTTPS support:")
        print(f"  - hidden imports: {', '.join(hidden_imports)}")
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
