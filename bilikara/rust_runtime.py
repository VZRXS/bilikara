from __future__ import annotations

import ctypes
import json
import platform
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

EXPECTED_RUNTIME_ABI_VERSION = 1
_PROGRESS_CALLBACK = ctypes.CFUNCTYPE(
    ctypes.c_int,
    ctypes.c_uint64,
    ctypes.c_uint64,
    ctypes.c_void_p,
)


class RustRuntimeUnavailableError(RuntimeError):
    pass


class RustDownloadError(RuntimeError):
    def __init__(self, kind: str, message: str, *, response: dict[str, Any]) -> None:
        super().__init__(message)
        self.kind = kind
        self.response = response


class RustDownloadCancelledError(RustDownloadError):
    pass


def _runtime_library_name() -> str:
    system = platform.system()
    if system == "Windows":
        return "bilikara_runtime.dll"
    if system == "Darwin":
        return "libbilikara_runtime.dylib"
    return "libbilikara_runtime.so"


def _get_runtime_lib_path() -> Path | None:
    root_dir = Path(__file__).resolve().parent.parent
    lib_name = _runtime_library_name()
    candidates = [
        root_dir / "rust-runtime" / "target" / "release" / lib_name,
        root_dir / "rust-runtime" / "target" / "debug" / lib_name,
    ]
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        candidates.append(Path(meipass) / "rust" / lib_name)
    candidates.extend(
        [
            Path(sys.executable).resolve().parent / "rust" / lib_name,
            Path(sys.executable).resolve().parent / lib_name,
        ]
    )
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return None


def _load_runtime_library(path: Path | None):
    if path is None:
        return None, "Rust runtime library not found"
    try:
        library = ctypes.CDLL(str(path))
        library.bilikara_runtime_abi_version.argtypes = []
        library.bilikara_runtime_abi_version.restype = ctypes.c_uint32
        if int(library.bilikara_runtime_abi_version()) != EXPECTED_RUNTIME_ABI_VERSION:
            return None, "Rust runtime ABI version mismatch"
        library.bilikara_runtime_download.argtypes = [
            ctypes.c_char_p,
            _PROGRESS_CALLBACK,
            ctypes.c_void_p,
        ]
        library.bilikara_runtime_download.restype = ctypes.c_void_p
        library.bilikara_runtime_free_string.argtypes = [ctypes.c_void_p]
        library.bilikara_runtime_free_string.restype = None
        return library, ""
    except (AttributeError, OSError, TypeError, ValueError) as exc:
        return None, f"Rust runtime load failed: {type(exc).__name__}"


_runtime_lib_path = _get_runtime_lib_path()
_runtime_lib, _runtime_error = _load_runtime_library(_runtime_lib_path)


def runtime_status() -> dict[str, Any]:
    return {
        "loaded": _runtime_lib is not None,
        "path": str(_runtime_lib_path or ""),
        "error": _runtime_error,
        "abi_version": EXPECTED_RUNTIME_ABI_VERSION if _runtime_lib is not None else None,
        "expected_abi_version": EXPECTED_RUNTIME_ABI_VERSION,
        "capabilities": {"http_download": _runtime_lib is not None},
    }


def http_download_available() -> bool:
    return _runtime_lib is not None


def download_to_path(
    *,
    urls: list[str],
    destination: Path,
    headers: list[tuple[str, str]] | None = None,
    on_progress: Callable[[int, int], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
    connect_timeout_ms: int = 15_000,
    request_timeout_ms: int = 30 * 60 * 1000,
) -> dict[str, Any]:
    if _runtime_lib is None:
        raise RustRuntimeUnavailableError(_runtime_error or "Rust runtime is unavailable")

    normalized_headers = [
        {"name": str(name), "value": str(value)}
        for name, value in (headers or [])
    ]
    request = {
        "schema_version": 1,
        "candidates": [
            {"url": str(url), "headers": normalized_headers}
            for url in urls
        ],
        "destination": str(destination.resolve()),
        "connect_timeout_ms": int(connect_timeout_ms),
        "request_timeout_ms": int(request_timeout_ms),
        "attempts_per_candidate": 1,
    }
    payload = json.dumps(request, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

    @_PROGRESS_CALLBACK
    def progress_callback(downloaded_bytes, total_bytes, _context):
        try:
            if should_cancel is not None and should_cancel():
                return 1
            if on_progress is not None:
                on_progress(int(downloaded_bytes), int(total_bytes))
            return 0
        except Exception:
            return 1

    pointer = _runtime_lib.bilikara_runtime_download(payload, progress_callback, None)
    if not pointer:
        raise RustDownloadError(
            "invalid_response",
            "Rust downloader returned no response",
            response={},
        )
    try:
        response_bytes = ctypes.string_at(pointer)
    finally:
        _runtime_lib.bilikara_runtime_free_string(pointer)
    try:
        response_text = response_bytes.decode("utf-8")
        response = json.loads(response_text)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RustDownloadError(
            "invalid_response",
            "Rust downloader returned malformed JSON",
            response={},
        ) from exc
    if not isinstance(response, dict) or response.get("schema_version") != 1:
        raise RustDownloadError(
            "invalid_response",
            "Rust downloader returned an unsupported response",
            response={},
        )

    status = str(response.get("status") or "")
    if status == "completed":
        result = response.get("result")
        if not isinstance(result, dict):
            raise RustDownloadError(
                "invalid_response",
                "Rust downloader omitted its result",
                response=response,
            )
        result_path = Path(str(result.get("destination") or ""))
        if result_path.resolve() != destination.resolve() or int(result.get("bytes_written") or 0) <= 0:
            raise RustDownloadError(
                "invalid_response",
                "Rust downloader returned an invalid result",
                response=response,
            )
        return result

    error = response.get("error")
    error = error if isinstance(error, dict) else {}
    kind = str(error.get("kind") or "unknown")
    message = str(error.get("message") or "Rust download failed")
    error_type = RustDownloadCancelledError if status == "cancelled" else RustDownloadError
    raise error_type(kind, message, response=response)
