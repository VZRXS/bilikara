from __future__ import annotations

import ctypes
import platform
import re
import sys
from pathlib import Path

FULLWIDTH_BRACKET_RE = re.compile(r"【[^】]*】")
EDGE_SEPARATOR_RE = re.compile(r"^[\s\-|｜/:：]+|[\s\-|｜/:：]+$")
MULTISPACE_RE = re.compile(r"\s+")
_KEYWORDS = (
    r"ニコカラ|カラオケ|Aegisub|びりから|ビリカラ|纯k投屏|ktv导唱字幕|ktv字幕|导唱字幕|卡拉OK字幕|卡拉OK|导唱|字幕|"
    r"on/off vocal|on/off|自用|无损|Hi-Res|flac|\d+kHz|\d+bit|1080p|4k|UHD|60帧|60fps|mv|pv"
)

# Match keywords and surrounding separators
KARAOKE_TAGS_RE = re.compile(
    fr"(?i)\s*[\s/|\\、，,\-]*\s*(?:{_KEYWORDS})\s*[\s/|\\、，,\-]*\s*"
)

# Match other types of brackets (excluding 【】) and capture their inner content
BRACKET_BLOCK_RE = re.compile(r"([\[\(『<〈《](.*?)[\]\)』>〉》])")


def _clean_bracket_content(match: re.Match) -> str:
    """Selective cleanup of tag-like content within brackets."""
    full_block = match.group(1)
    inner_content = match.group(2)

    # Remove keywords and separators from inner content
    cleaned_inner = KARAOKE_TAGS_RE.sub("", inner_content)
    # Trim leftover separators inside
    cleaned_inner = EDGE_SEPARATOR_RE.sub("", cleaned_inner).strip()

    if not cleaned_inner:
        return " "  # Remove entire bracket if empty

    # Keep the brackets but with cleaned content
    return f"{full_block[0]}{cleaned_inner}{full_block[-1]}"


# Load Rust dynamic library
_rust_lib = None
_RUST_LOAD_ERROR = None

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


try:
    _lib_path = _get_rust_lib_path()
    if _lib_path:
        _rust_lib = ctypes.CDLL(str(_lib_path))
        _rust_lib.rust_clean_display_title.argtypes = [
            ctypes.c_char_p,
            ctypes.c_char_p,
            ctypes.c_char_p,
        ]
        _rust_lib.rust_clean_display_title.restype = ctypes.c_void_p
        _rust_lib.rust_free_string.argtypes = [ctypes.c_void_p]
        _rust_lib.rust_free_string.restype = None
    else:
        _RUST_LOAD_ERROR = "Rust library not compiled"
except Exception as e:
    _RUST_LOAD_ERROR = str(e)


def _py_clean_display_title(
    *,
    title: str = "",
    display_title: str = "",
    part_title: str = "",
) -> str:
    base_title = str(title or "").strip()
    fallback_title = _remove_part_suffix(str(display_title or ""), str(part_title or ""))
    candidate = base_title or fallback_title or str(display_title or "").strip()
    cleaned = FULLWIDTH_BRACKET_RE.sub(" ", candidate)
    cleaned = BRACKET_BLOCK_RE.sub(_clean_bracket_content, cleaned)
    cleaned = MULTISPACE_RE.sub(" ", cleaned).strip()
    cleaned = EDGE_SEPARATOR_RE.sub("", cleaned).strip()
    return cleaned or candidate.strip()


def clean_display_title(
    *,
    title: str = "",
    display_title: str = "",
    part_title: str = "",
) -> str:
    title_sanitized = str(title or "").replace("\x00", "")
    display_title_sanitized = str(display_title or "").replace("\x00", "")
    part_title_sanitized = str(part_title or "").replace("\x00", "")

    if _rust_lib is not None:
        try:
            title_bytes = title_sanitized.encode("utf-8")
            display_bytes = display_title_sanitized.encode("utf-8")
            part_bytes = part_title_sanitized.encode("utf-8")

            res_ptr = _rust_lib.rust_clean_display_title(title_bytes, display_bytes, part_bytes)
            if res_ptr:
                try:
                    res_str = ctypes.string_at(res_ptr).decode("utf-8")
                    return res_str
                finally:
                    _rust_lib.rust_free_string(res_ptr)
        except Exception:
            pass

    return _py_clean_display_title(
        title=title_sanitized,
        display_title=display_title_sanitized,
        part_title=part_title_sanitized,
    )


def rust_backend_status() -> dict[str, object]:
    return {
        "loaded": _rust_lib is not None,
        "error": _RUST_LOAD_ERROR,
        "path": str(_lib_path) if "_lib_path" in globals() and _lib_path else "",
    }


def _remove_part_suffix(display_title: str, part_title: str) -> str:
    normalized_display = str(display_title or "").strip()
    normalized_part = str(part_title or "").strip()
    if not normalized_display or not normalized_part:
        return normalized_display

    suffix = f" - {normalized_part}"
    if normalized_display.endswith(suffix):
        return normalized_display[: -len(suffix)].rstrip()
    return normalized_display
