from __future__ import annotations

import ctypes
import platform
import sys
from pathlib import Path
from typing import Any


def _rust_library_name() -> str:
    system = platform.system()
    if system == "Windows":
        return "bilikara_rust.dll"
    if system == "Darwin":
        return "libbilikara_rust.dylib"
    return "libbilikara_rust.so"


def _get_rust_lib_path() -> Path | None:
    root_dir = Path(__file__).resolve().parent.parent
    lib_name = _rust_library_name()
    candidates = [
        root_dir / "rust" / "target" / "release" / lib_name,
        root_dir / "rust" / "target" / "debug" / lib_name,
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
        if candidate.exists():
            return candidate
    return None


def _configure_library(library: Any) -> None:
    library.rust_clean_display_title.argtypes = [
        ctypes.c_char_p,
        ctypes.c_char_p,
        ctypes.c_char_p,
    ]
    library.rust_clean_display_title.restype = ctypes.c_void_p
    library.rust_safe_filename.argtypes = [ctypes.c_char_p, ctypes.c_char_p]
    library.rust_safe_filename.restype = ctypes.c_void_p
    library.rust_free_string.argtypes = [ctypes.c_void_p]
    library.rust_free_string.restype = None


def _load_library(path: Path | None) -> tuple[Any | None, str | None]:
    if path is None:
        return None, "Rust library not compiled"
    try:
        library = ctypes.CDLL(str(path))
        _configure_library(library)
        return library, None
    except Exception as exc:
        return None, str(exc)


def _read_rust_string(pointer: int | None) -> str | None:
    if not pointer or _rust_lib is None:
        return None
    try:
        return ctypes.string_at(pointer).decode("utf-8")
    except Exception:
        return None
    finally:
        try:
            _rust_lib.rust_free_string(pointer)
        except Exception:
            pass


_lib_path = _get_rust_lib_path()
_rust_lib, _RUST_LOAD_ERROR = _load_library(_lib_path)


def backend_status() -> dict[str, object]:
    return {
        "loaded": _rust_lib is not None,
        "error": _RUST_LOAD_ERROR,
        "path": str(_lib_path) if _lib_path else "",
    }


def clean_display_title(title: str, display_title: str, part_title: str) -> str | None:
    if _rust_lib is None:
        return None
    try:
        pointer = _rust_lib.rust_clean_display_title(
            title.replace("\x00", "").encode("utf-8"),
            display_title.replace("\x00", "").encode("utf-8"),
            part_title.replace("\x00", "").encode("utf-8"),
        )
        return _read_rust_string(pointer)
    except Exception:
        return None


def safe_filename(name: str, fallback: str) -> str | None:
    if _rust_lib is None or "\x00" in fallback:
        return None
    try:
        pointer = _rust_lib.rust_safe_filename(
            name.replace("\x00", "/").encode("utf-8"),
            fallback.encode("utf-8"),
        )
        return _read_rust_string(pointer)
    except Exception:
        return None
