from __future__ import annotations

import ctypes
import json
import platform
import sys
import urllib.parse
from pathlib import Path
from typing import Any

EXPECTED_ABI_VERSION = 1

PHASE1_CAPABILITIES = (
    "title_cleanup",
    "safe_filename",
    "normalize_version_tag",
    "version_tuple",
    "version_sort_key",
    "normalize_machine_arch",
    "asset_tokens",
    "asset_has_windows",
    "asset_has_macos",
    "asset_has_linux",
    "asset_has_x64",
    "asset_has_arm64",
    "asset_has_universal",
    "release_list_api_from_latest",
    "format_download_proxy_url",
    "is_downloadable_archive",
)

PHASE2_CAPABILITIES = (
    "select_update_asset",
    "select_release",
    "select_media_pages",
    "decide_audio_binding",
    "plan_update_download_candidates",
    "plan_media_download_candidates",
    "plan_tool_download_candidates",
    "decide_quality_policy",
    "select_video_stream",
    "select_audio_stream",
)

MAX_UPDATE_DOWNLOAD_CANDIDATE_INPUTS = 4096
MAX_MEDIA_DOWNLOAD_STREAM_INPUTS = 4096
MAX_MEDIA_DOWNLOAD_CANDIDATES = 16384
MAX_TOOL_FALLBACK_BASES = 256
MAX_STREAM_RANKING_INPUTS = 512
MAX_CODEC_STRING_BYTES = 256
MAX_QUALITY_LABEL_BYTES = 256


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


_SYMBOLS = {
    "title_cleanup": (
        "rust_clean_display_title",
        [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p],
        ctypes.c_void_p,
    ),
    "safe_filename": (
        "rust_safe_filename",
        [ctypes.c_char_p, ctypes.c_char_p],
        ctypes.c_void_p,
    ),
    "normalize_version_tag": (
        "rust_normalize_version_tag",
        [ctypes.c_char_p],
        ctypes.c_void_p,
    ),
    "version_tuple": (
        "rust_version_tuple",
        [ctypes.c_char_p],
        ctypes.c_void_p,
    ),
    "version_sort_key": (
        "rust_version_sort_key",
        [ctypes.c_char_p],
        ctypes.c_void_p,
    ),
    "normalize_machine_arch": (
        "rust_normalize_machine_arch",
        [ctypes.c_char_p],
        ctypes.c_void_p,
    ),
    "asset_tokens": ("rust_asset_tokens", [ctypes.c_char_p], ctypes.c_void_p),
    "asset_has_windows": (
        "rust_asset_has_windows",
        [ctypes.c_char_p],
        ctypes.c_void_p,
    ),
    "asset_has_macos": ("rust_asset_has_macos", [ctypes.c_char_p], ctypes.c_void_p),
    "asset_has_linux": ("rust_asset_has_linux", [ctypes.c_char_p], ctypes.c_void_p),
    "asset_has_x64": (
        "rust_asset_has_x64",
        [ctypes.c_char_p, ctypes.c_char_p],
        ctypes.c_void_p,
    ),
    "asset_has_arm64": ("rust_asset_has_arm64", [ctypes.c_char_p], ctypes.c_void_p),
    "asset_has_universal": (
        "rust_asset_has_universal",
        [ctypes.c_char_p],
        ctypes.c_void_p,
    ),
    "release_list_api_from_latest": (
        "rust_release_list_api_from_latest",
        [ctypes.c_char_p],
        ctypes.c_void_p,
    ),
    "format_download_proxy_url": (
        "rust_format_download_proxy_url",
        [ctypes.c_char_p, ctypes.c_char_p],
        ctypes.c_void_p,
    ),
    "is_downloadable_archive": (
        "rust_is_downloadable_archive",
        [ctypes.c_char_p, ctypes.c_char_p],
        ctypes.c_int,
    ),
    "select_update_asset": (
        "rust_select_update_asset",
        [ctypes.c_char_p],
        ctypes.c_void_p,
    ),
    "select_release": (
        "rust_select_release",
        [ctypes.c_char_p],
        ctypes.c_void_p,
    ),
    "select_media_pages": (
        "rust_select_media_pages",
        [ctypes.c_char_p],
        ctypes.c_void_p,
    ),
    "decide_audio_binding": (
        "rust_decide_audio_binding",
        [ctypes.c_char_p],
        ctypes.c_void_p,
    ),
    "plan_update_download_candidates": (
        "rust_plan_update_download_candidates",
        [ctypes.c_char_p],
        ctypes.c_void_p,
    ),
    "plan_media_download_candidates": (
        "rust_plan_media_download_candidates",
        [ctypes.c_char_p],
        ctypes.c_void_p,
    ),
    "plan_tool_download_candidates": (
        "rust_plan_tool_download_candidates",
        [ctypes.c_char_p],
        ctypes.c_void_p,
    ),
    "decide_quality_policy": (
        "rust_decide_quality_policy",
        [ctypes.c_char_p],
        ctypes.c_void_p,
    ),
    "select_video_stream": (
        "rust_select_video_stream",
        [ctypes.c_char_p],
        ctypes.c_void_p,
    ),
    "select_audio_stream": (
        "rust_select_audio_stream",
        [ctypes.c_char_p],
        ctypes.c_void_p,
    ),
}

# Asset tokens use the grammar ``[a-z0-9]+``.  The FFI therefore transports a
# token set as sorted, newline-separated ASCII: newline can never occur inside
# a valid token, and an empty string represents a valid empty set.
_ASSET_CLASSIFIER_SYMBOLS = {
    "asset_has_windows": "rust_asset_has_windows",
    "asset_has_macos": "rust_asset_has_macos",
    "asset_has_linux": "rust_asset_has_linux",
    "asset_has_x64": "rust_asset_has_x64",
    "asset_has_arm64": "rust_asset_has_arm64",
    "asset_has_universal": "rust_asset_has_universal",
}


def _empty_capabilities() -> dict[str, bool]:
    return {capability: False for capability in _SYMBOLS}


def _configure_library(library: Any) -> dict[str, bool]:
    capabilities = _empty_capabilities()
    try:
        free_string = library.rust_free_string
        free_string.argtypes = [ctypes.c_void_p]
        free_string.restype = None
    except Exception:
        return capabilities

    for capability, (symbol_name, argtypes, restype) in _SYMBOLS.items():
        try:
            symbol = getattr(library, symbol_name)
            symbol.argtypes = argtypes
            symbol.restype = restype
            capabilities[capability] = True
        except Exception:
            continue
    return capabilities


def _load_library(
    path: Path | None,
) -> tuple[Any | None, dict[str, bool], str | None]:
    if path is None:
        return None, _empty_capabilities(), "Rust library not compiled"
    try:
        library = ctypes.CDLL(str(path))
        capabilities = _configure_library(library)
        if not any(capabilities.values()):
            return None, capabilities, "Rust library has no usable symbols"
        return library, capabilities, None
    except Exception as exc:
        return None, _empty_capabilities(), str(exc)


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
_rust_lib, _CAPABILITIES, _RUST_LOAD_ERROR = _load_library(_lib_path)


def _detect_abi_version(library: Any | None) -> tuple[int | None, bool | None]:
    if library is None:
        return None, None
    try:
        symbol = library.rust_backend_abi_version
    except Exception:
        return None, None
    try:
        symbol.argtypes = []
        symbol.restype = ctypes.c_uint32
        version = int(symbol())
        return version, version == EXPECTED_ABI_VERSION
    except Exception:
        return None, False


def _abi_compatibility_error(
    version: int | None,
    compatible: bool | None,
) -> str | None:
    if compatible is not False:
        return None
    if version is None:
        return "Rust backend ABI check failed"
    return f"Rust backend ABI mismatch: expected {EXPECTED_ABI_VERSION}, got {version}"


_ABI_VERSION, _ABI_COMPATIBLE = _detect_abi_version(_rust_lib)
if _ABI_COMPATIBLE is False:
    _RUST_LOAD_ERROR = _abi_compatibility_error(_ABI_VERSION, _ABI_COMPATIBLE)
    _CAPABILITIES = _empty_capabilities()
    _rust_lib = None


def backend_status() -> dict[str, object]:
    missing_capabilities = sorted(
        capability for capability, available in _CAPABILITIES.items() if not available
    )
    return {
        "loaded": _rust_lib is not None,
        "fully_compatible": _rust_lib is not None and not missing_capabilities,
        "error": _RUST_LOAD_ERROR,
        "path": str(_lib_path) if _lib_path else "",
        "capabilities": dict(_CAPABILITIES),
        "missing_capabilities": missing_capabilities,
        "abi_version": _ABI_VERSION,
        "expected_abi_version": EXPECTED_ABI_VERSION,
        "abi_compatible": _ABI_COMPATIBLE,
    }


def clean_display_title(title: str, display_title: str, part_title: str) -> str | None:
    if _rust_lib is None or not _CAPABILITIES["title_cleanup"]:
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
    if _rust_lib is None or not _CAPABILITIES["safe_filename"] or "\x00" in fallback:
        return None
    try:
        pointer = _rust_lib.rust_safe_filename(
            name.replace("\x00", "/").encode("utf-8"),
            fallback.encode("utf-8"),
        )
        return _read_rust_string(pointer)
    except Exception:
        return None


def normalize_version_tag(version: str) -> str | None:
    if _rust_lib is None or not _CAPABILITIES["normalize_version_tag"] or "\x00" in version:
        return None
    try:
        pointer = _rust_lib.rust_normalize_version_tag(version.encode("utf-8"))
        return _read_rust_string(pointer)
    except Exception:
        return None


def _try_version_fields(
    version: str,
    capability: str,
    symbol_name: str,
    field_count: int,
) -> tuple[bool, tuple[int, ...] | None]:
    if _rust_lib is None or not _CAPABILITIES[capability] or "\x00" in version:
        return False, None
    try:
        pointer = getattr(_rust_lib, symbol_name)(version.encode("utf-8"))
        result = _read_rust_string(pointer)
        if result is None:
            return False, None
        if result == "":
            return True, None
        parts = result.split(",")
        if len(parts) != field_count:
            return False, None
        return True, tuple(int(part) for part in parts)
    except Exception:
        return False, None


def try_version_tuple(version: str) -> tuple[bool, tuple[int, int, int] | None]:
    completed, result = _try_version_fields(
        version, "version_tuple", "rust_version_tuple", 3
    )
    if result is None:
        return completed, None
    return completed, (result[0], result[1], result[2])


def try_version_sort_key(
    version: str,
) -> tuple[bool, tuple[int, int, int, int, int] | None]:
    completed, result = _try_version_fields(
        version, "version_sort_key", "rust_version_sort_key", 5
    )
    if result is None:
        return completed, None
    return completed, (result[0], result[1], result[2], result[3], result[4])


def normalize_machine_arch(machine: str) -> str | None:
    if _rust_lib is None or not _CAPABILITIES["normalize_machine_arch"] or "\x00" in machine:
        return None
    try:
        pointer = _rust_lib.rust_normalize_machine_arch(machine.encode("utf-8"))
        return _read_rust_string(pointer)
    except Exception:
        return None


def asset_tokens(text: str) -> set[str] | None:
    if _rust_lib is None or not _CAPABILITIES["asset_tokens"]:
        return None
    try:
        # NUL is a delimiter under the Python token grammar, but cannot be
        # embedded in a C string. Replacing it with newline preserves that
        # boundary without creating a valid token character.
        encoded_text = str(text).replace("\x00", "\n").encode("utf-8")
        value = _read_rust_string(_rust_lib.rust_asset_tokens(encoded_text))
        if value is None:
            return None
        return {token for token in value.splitlines() if token}
    except Exception:
        return None


def _asset_token_payload(tokens: set[str]) -> str | None:
    normalized_tokens = {str(token) for token in tokens}
    if any(
        not token or not token.isascii() or not token.isalnum()
        for token in normalized_tokens
    ):
        return None
    return "\n".join(sorted(normalized_tokens))


def _call_asset_classifier(
    capability: str,
    arguments: tuple[str, ...],
) -> bool | None:
    symbol_name = _ASSET_CLASSIFIER_SYMBOLS.get(capability)
    if (
        symbol_name is None
        or _rust_lib is None
        or not _CAPABILITIES.get(capability, False)
    ):
        return None
    try:
        symbol = getattr(_rust_lib, symbol_name)
        encoded_arguments = tuple(
            argument.replace("\x00", "\n").encode("utf-8")
            for argument in arguments
        )
        value = _read_rust_string(symbol(*encoded_arguments))
        if value == "1":
            return True
        if value == "0":
            return False
        return None
    except Exception:
        return None


def asset_has_windows(tokens: set[str]) -> bool | None:
    payload = _asset_token_payload(tokens)
    if payload is None:
        return None
    return _call_asset_classifier("asset_has_windows", (payload,))


def asset_has_macos(tokens: set[str]) -> bool | None:
    payload = _asset_token_payload(tokens)
    if payload is None:
        return None
    return _call_asset_classifier("asset_has_macos", (payload,))


def asset_has_linux(tokens: set[str]) -> bool | None:
    payload = _asset_token_payload(tokens)
    if payload is None:
        return None
    return _call_asset_classifier("asset_has_linux", (payload,))


def asset_has_x64(text: str, tokens: set[str]) -> bool | None:
    payload = _asset_token_payload(tokens)
    if payload is None:
        return None
    return _call_asset_classifier("asset_has_x64", (str(text), payload))


def asset_has_arm64(tokens: set[str]) -> bool | None:
    payload = _asset_token_payload(tokens)
    if payload is None:
        return None
    return _call_asset_classifier("asset_has_arm64", (payload,))


def asset_has_universal(tokens: set[str]) -> bool | None:
    payload = _asset_token_payload(tokens)
    if payload is None:
        return None
    return _call_asset_classifier("asset_has_universal", (payload,))


def release_list_api_from_latest(api_url: str) -> str | None:
    if (
        _rust_lib is None
        or not _CAPABILITIES["release_list_api_from_latest"]
        or "\x00" in api_url
    ):
        return None
    try:
        pointer = _rust_lib.rust_release_list_api_from_latest(api_url.encode("utf-8"))
        return _read_rust_string(pointer)
    except Exception:
        return None


def format_download_proxy_url(proxy: str, url: str) -> str | None:
    if (
        _rust_lib is None
        or not _CAPABILITIES["format_download_proxy_url"]
        or "\x00" in proxy
        or "\x00" in url
    ):
        return None
    try:
        pointer = _rust_lib.rust_format_download_proxy_url(
            proxy.encode("utf-8"),
            url.encode("utf-8"),
        )
        return _read_rust_string(pointer)
    except Exception:
        return None


def is_downloadable_archive(name: str, url: str) -> bool | None:
    if (
        _rust_lib is None
        or not _CAPABILITIES["is_downloadable_archive"]
        or "\x00" in name
        or "\x00" in url
    ):
        return None
    try:
        result = int(
            _rust_lib.rust_is_downloadable_archive(
                name.encode("utf-8"),
                url.encode("utf-8"),
            )
        )
        if result == 1:
            return True
        if result == 0:
            return False
        return None
    except Exception:
        return None


def _asset_selection_request_indices(request: object) -> list[int] | None:
    if not isinstance(request, dict):
        return None
    schema_version = request.get("schema_version")
    if isinstance(schema_version, bool) or schema_version != 1:
        return None

    target = request.get("target")
    if not isinstance(target, dict):
        return None
    if not isinstance(target.get("platform"), str) or not isinstance(
        target.get("arch"), str
    ):
        return None

    assets = request.get("assets")
    if not isinstance(assets, list):
        return None

    indices: list[int] = []
    for asset in assets:
        if not isinstance(asset, dict):
            return None
        original_index = asset.get("original_index")
        if (
            isinstance(original_index, bool)
            or not isinstance(original_index, int)
            or original_index < 0
            or (indices and original_index <= indices[-1])
        ):
            return None
        for key in ("name", "label", "browser_download_url", "content_type"):
            if not isinstance(asset.get(key), str):
                return None
        indices.append(original_index)
    return indices


def _valid_asset_selection_response(
    response: object,
    request_indices: list[int],
) -> bool:
    if not isinstance(response, dict):
        return False

    schema_version = response.get("schema_version")
    if isinstance(schema_version, bool) or schema_version != 1:
        return False

    status = response.get("status")
    if status not in {"selected", "no_match"}:
        return False

    scores = response.get("scores")
    if not isinstance(scores, list) or len(scores) != len(request_indices):
        return False

    parsed_scores: list[tuple[int, int]] = []
    for expected_index, item in zip(request_indices, scores):
        if not isinstance(item, dict):
            return False
        original_index = item.get("original_index")
        score = item.get("score")
        if (
            isinstance(original_index, bool)
            or not isinstance(original_index, int)
            or original_index != expected_index
            or isinstance(score, bool)
            or not isinstance(score, int)
        ):
            return False
        parsed_scores.append((original_index, score))

    nonnegative_scores = [item for item in parsed_scores if item[1] >= 0]
    selected_index = response.get("selected_index")
    if status == "no_match":
        return selected_index is None and not nonnegative_scores

    if (
        isinstance(selected_index, bool)
        or not isinstance(selected_index, int)
        or not nonnegative_scores
    ):
        return False
    highest_score = max(score for _, score in nonnegative_scores)
    expected_selected_index = next(
        original_index
        for original_index, score in nonnegative_scores
        if score == highest_score
    )
    return selected_index == expected_selected_index


def try_select_update_asset(
    request: dict[str, object],
) -> tuple[bool, dict[str, Any] | None]:
    """Call the coarse native asset selector and validate its complete response.

    ``(False, None)`` means the native feature was unavailable or its request,
    call, or response failed validation. A successful ``no_match`` decision is
    returned as ``(True, response)`` so it cannot be confused with FFI failure.
    JSON escaping carries interior NUL characters safely through the C string.
    """

    request_indices = _asset_selection_request_indices(request)
    if (
        request_indices is None
        or _rust_lib is None
        or not _CAPABILITIES.get("select_update_asset", False)
    ):
        return False, None

    try:
        request_json = json.dumps(
            request,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        pointer = _rust_lib.rust_select_update_asset(request_json)
        response_json = _read_rust_string(pointer)
        if response_json is None:
            return False, None
        response = json.loads(response_json)
        if not _valid_asset_selection_response(response, request_indices):
            return False, None
        return True, response
    except Exception:
        return False, None


def try_select_release(
    request: dict[str, object],
) -> tuple[bool, dict[str, Any] | None]:
    if (
        _rust_lib is None
        or not _CAPABILITIES.get("select_release", False)
    ):
        return False, None

    try:
        request_json = json.dumps(
            request,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        pointer = _rust_lib.rust_select_release(request_json)
        response_json = _read_rust_string(pointer)
        if response_json is None:
            return False, None
        response = json.loads(response_json)
        
        if not isinstance(response, dict):
            return False, None
        
        schema_version = response.get("schema_version")
        if isinstance(schema_version, bool) or schema_version != 1:
            return False, None
            
        status = response.get("status")
        if status not in {"selected", "no_match"}:
            return False, None
            
        if status == "selected":
            selected_index = response.get("selected_index")
            if isinstance(selected_index, bool) or not isinstance(selected_index, int) or selected_index < 0:
                return False, None
        elif status == "no_match":
            selected_index = response.get("selected_index")
            if selected_index is not None:
                return False, None
                
        return True, response
    except Exception:
        return False, None


def try_select_media_pages(
    request: dict[str, Any],
) -> tuple[bool, dict[str, Any] | None]:
    if (
        _rust_lib is None
        or not _CAPABILITIES.get("select_media_pages", False)
    ):
        return False, None

    try:
        pages = request.get("pages")
        if not isinstance(pages, list):
            return False, None

        original_indices: set[int] = set()
        last_index: int | None = None
        for page in pages:
            if not isinstance(page, dict):
                return False, None
            idx = page.get("original_index")
            if isinstance(idx, bool) or not isinstance(idx, int) or idx < 0:
                return False, None
            if last_index is not None and idx <= last_index:
                return False, None
            last_index = idx
            original_indices.add(idx)

        request_json = json.dumps(
            request,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        pointer = _rust_lib.rust_select_media_pages(request_json)
        response_json = _read_rust_string(pointer)
        if response_json is None:
            return False, None
        response = json.loads(response_json)
        if not isinstance(response, dict):
            return False, None

        schema_version = response.get("schema_version")
        if isinstance(schema_version, bool) or schema_version != 1:
            return False, None

        status = response.get("status")
        if status not in {"selected", "no_match"}:
            return False, None

        selected_indices = response.get("selected_indices")
        if not isinstance(selected_indices, list):
            return False, None

        seen_selected: set[int] = set()
        for idx in selected_indices:
            if isinstance(idx, bool) or not isinstance(idx, int):
                return False, None
            if idx not in original_indices or idx in seen_selected:
                return False, None
            seen_selected.add(idx)

        if status == "no_match":
            if len(pages) != 0 or len(selected_indices) != 0:
                return False, None
        elif status == "selected":
            if len(pages) == 0 or len(selected_indices) == 0:
                return False, None

        return True, response
    except Exception:
        return False, None


def _audio_binding_request_indices(request: object) -> list[int] | None:
    if not isinstance(request, dict) or set(request) != {
        "schema_version",
        "tolerance_seconds",
        "pages",
    }:
        return None

    schema_version = request.get("schema_version")
    tolerance_seconds = request.get("tolerance_seconds")
    if (
        isinstance(schema_version, bool)
        or schema_version != 1
        or isinstance(tolerance_seconds, bool)
        or not isinstance(tolerance_seconds, int)
        or tolerance_seconds < 0
        or tolerance_seconds > 2**63 - 1
    ):
        return None

    pages = request.get("pages")
    if not isinstance(pages, list):
        return None

    indices: list[int] = []
    for page in pages:
        if not isinstance(page, dict) or set(page) != {
            "original_index",
            "page",
            "duration",
            "part",
        }:
            return None
        original_index = page.get("original_index")
        page_number = page.get("page")
        duration = page.get("duration")
        if (
            isinstance(original_index, bool)
            or not isinstance(original_index, int)
            or original_index < 0
            or original_index > 2 ** (ctypes.sizeof(ctypes.c_size_t) * 8) - 1
            or (indices and original_index <= indices[-1])
            or isinstance(page_number, bool)
            or not isinstance(page_number, int)
            or not -(2**63) <= page_number <= 2**63 - 1
            or isinstance(duration, bool)
            or not isinstance(duration, int)
            or not -(2**63) <= duration <= 2**63 - 1
            or not isinstance(page.get("part"), str)
        ):
            return None
        indices.append(original_index)
    return indices


def _valid_audio_binding_response(
    response: object,
    request_indices: list[int],
) -> bool:
    if not isinstance(response, dict) or set(response) != {
        "schema_version",
        "status",
        "mode",
        "selected_indices",
        "automatic_video_index",
    }:
        return False

    schema_version = response.get("schema_version")
    if isinstance(schema_version, bool) or schema_version != 1:
        return False

    status = response.get("status")
    mode = response.get("mode")
    selected_indices = response.get("selected_indices")
    automatic_video_index = response.get("automatic_video_index")
    if status not in {"decided", "no_match"} or not isinstance(
        selected_indices, list
    ):
        return False

    seen_indices: set[int] = set()
    for original_index in selected_indices:
        if (
            isinstance(original_index, bool)
            or not isinstance(original_index, int)
            or original_index < 0
            or original_index not in request_indices
            or original_index in seen_indices
        ):
            return False
        seen_indices.add(original_index)

    if status == "no_match":
        return (
            not request_indices
            and mode is None
            and selected_indices == []
            and automatic_video_index is None
        )

    if mode == "single":
        return (
            len(request_indices) == 1
            and selected_indices == request_indices
            and automatic_video_index is None
        )
    if mode == "automatic":
        if len(request_indices) != 2 or selected_indices != request_indices:
            return False
        if automatic_video_index is None:
            return True
        return (
            not isinstance(automatic_video_index, bool)
            and isinstance(automatic_video_index, int)
            and automatic_video_index in selected_indices
        )
    if mode == "manual_required":
        return (
            len(request_indices) >= 2
            and selected_indices == []
            and automatic_video_index is None
        )
    return False


def try_decide_audio_binding(
    request: dict[str, object],
) -> tuple[bool, dict[str, Any] | None]:
    """Call the coarse native audio-binding decision and validate its response."""

    request_indices = _audio_binding_request_indices(request)
    if (
        request_indices is None
        or _rust_lib is None
        or not _CAPABILITIES.get("decide_audio_binding", False)
    ):
        return False, None

    try:
        request_json = json.dumps(
            request,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        pointer = _rust_lib.rust_decide_audio_binding(request_json)
        response_json = _read_rust_string(pointer)
        if response_json is None:
            return False, None
        response = json.loads(response_json)
        if not _valid_audio_binding_response(response, request_indices):
            return False, None
        return True, response
    except Exception:
        return False, None


def _update_download_plan_request(
    request: object,
) -> tuple[list[dict[str, object]], dict[str, object] | None] | None:
    if not isinstance(request, dict) or set(request) != {
        "schema_version",
        "candidates",
        "proxy",
    }:
        return None
    schema_version = request.get("schema_version")
    if isinstance(schema_version, bool) or schema_version != 1:
        return None

    raw_candidates = request.get("candidates")
    if (
        not isinstance(raw_candidates, list)
        or len(raw_candidates) > MAX_UPDATE_DOWNLOAD_CANDIDATE_INPUTS
    ):
        return None

    candidates: list[dict[str, object]] = []
    previous_index: int | None = None
    max_index = 2 ** (ctypes.sizeof(ctypes.c_size_t) * 8) - 1
    for candidate in raw_candidates:
        if not isinstance(candidate, dict) or set(candidate) != {
            "original_index",
            "url",
            "source",
        }:
            return None
        original_index = candidate.get("original_index")
        url = candidate.get("url")
        source = candidate.get("source")
        if (
            isinstance(original_index, bool)
            or not isinstance(original_index, int)
            or original_index < 0
            or original_index > max_index
            or (previous_index is not None and original_index <= previous_index)
            or not isinstance(url, str)
            or source not in {"primary", "mirror", "derived_mirror"}
        ):
            return None
        previous_index = original_index
        candidates.append(
            {
                "original_index": original_index,
                "url": url,
                "source": source,
            }
        )

    raw_proxy = request.get("proxy")
    proxy: dict[str, object] | None
    if raw_proxy is None:
        proxy = None
    elif (
        isinstance(raw_proxy, dict)
        and set(raw_proxy) == {"template", "proxy_first"}
        and isinstance(raw_proxy.get("template"), str)
        and isinstance(raw_proxy.get("proxy_first"), bool)
    ):
        proxy = {
            "template": raw_proxy["template"],
            "proxy_first": raw_proxy["proxy_first"],
        }
    else:
        return None
    return candidates, proxy


def _py_format_proxy_for_validation(proxy: str, url: str) -> str:
    proxy = proxy.strip()
    url = url.strip()
    if not proxy or not url:
        return ""
    encoded_url = urllib.parse.quote(url, safe="")
    if "{url_encoded}" in proxy:
        return proxy.replace("{url_encoded}", encoded_url)
    if "{url}" in proxy:
        return proxy.replace("{url}", url)
    separator = "" if proxy.endswith(("/", "=", "?", "&")) else "/"
    return f"{proxy}{separator}{url}"


def _expected_update_download_candidates(
    candidates: list[dict[str, object]],
    proxy: dict[str, object] | None,
) -> list[dict[str, object]]:
    expected: list[dict[str, object]] = []
    seen_urls: set[str] = set()
    for candidate in candidates:
        direct_url = str(candidate["url"]).strip()
        if not direct_url:
            continue
        proxy_url = (
            _py_format_proxy_for_validation(str(proxy["template"]), direct_url)
            if proxy is not None
            else ""
        )
        if proxy_url.strip() == direct_url:
            proxy_url = ""
        routes = (
            (("proxy", proxy_url), ("direct", direct_url))
            if proxy is not None and proxy["proxy_first"] is True
            else (("direct", direct_url), ("proxy", proxy_url))
        )
        for route, raw_url in routes:
            url = raw_url.strip()
            if not url or url in seen_urls:
                continue
            seen_urls.add(url)
            expected.append(
                {
                    "input_index": candidate["original_index"],
                    "source": candidate["source"],
                    "route": route,
                    "url": url,
                }
            )
    return expected


def _valid_update_download_plan_response(
    response: object,
    candidates: list[dict[str, object]],
    proxy: dict[str, object] | None,
) -> bool:
    if not isinstance(response, dict) or set(response) != {
        "schema_version",
        "status",
        "candidates",
    }:
        return False
    schema_version = response.get("schema_version")
    status = response.get("status")
    planned = response.get("candidates")
    if (
        isinstance(schema_version, bool)
        or schema_version != 1
        or status not in {"planned", "empty"}
        or not isinstance(planned, list)
        or len(planned) > len(candidates) * 2
    ):
        return False

    parsed: list[dict[str, object]] = []
    seen_urls: set[str] = set()
    request_by_index = {
        candidate["original_index"]: candidate for candidate in candidates
    }
    for candidate in planned:
        if not isinstance(candidate, dict) or set(candidate) != {
            "input_index",
            "source",
            "route",
            "url",
        }:
            return False
        input_index = candidate.get("input_index")
        source = candidate.get("source")
        route = candidate.get("route")
        url = candidate.get("url")
        if (
            isinstance(input_index, bool)
            or not isinstance(input_index, int)
            or input_index not in request_by_index
            or source not in {"primary", "mirror", "derived_mirror"}
            or source != request_by_index[input_index]["source"]
            or route not in {"direct", "proxy"}
            or not isinstance(url, str)
            or not url
            or url != url.strip()
            or url in seen_urls
            or (route == "proxy" and proxy is None)
        ):
            return False
        seen_urls.add(url)
        parsed.append(
            {
                "input_index": input_index,
                "source": source,
                "route": route,
                "url": url,
            }
        )

    expected = _expected_update_download_candidates(candidates, proxy)
    if parsed != expected:
        return False
    return (status == "empty" and not parsed) or (status == "planned" and bool(parsed))


def try_plan_update_download_candidates(
    request: dict[str, object],
) -> tuple[bool, dict[str, Any] | None]:
    """Call and strictly validate updater-only candidate planning."""

    validated_request = _update_download_plan_request(request)
    if (
        validated_request is None
        or _rust_lib is None
        or not _CAPABILITIES.get("plan_update_download_candidates", False)
    ):
        return False, None
    candidates, proxy = validated_request
    try:
        request_json = json.dumps(
            request,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        pointer = _rust_lib.rust_plan_update_download_candidates(request_json)
        response_json = _read_rust_string(pointer)
        if response_json is None:
            return False, None
        response = json.loads(response_json)
        if not _valid_update_download_plan_response(response, candidates, proxy):
            return False, None
        return True, response
    except Exception:
        return False, None


def _media_download_plan_request(
    request: object,
) -> tuple[str, str, list[dict[str, object]]] | None:
    if not isinstance(request, dict) or set(request) != {
        "schema_version",
        "mode",
        "stream_kind",
        "streams",
    }:
        return None
    schema_version = request.get("schema_version")
    mode = request.get("mode")
    stream_kind = request.get("stream_kind")
    streams = request.get("streams")
    if (
        isinstance(schema_version, bool)
        or schema_version != 1
        or not isinstance(mode, str)
        or mode not in {"dash_streams", "preferred_audio"}
        or not isinstance(stream_kind, str)
        or stream_kind not in {"video", "audio"}
        or not isinstance(streams, list)
        or len(streams) > MAX_MEDIA_DOWNLOAD_STREAM_INPUTS
        or (mode == "preferred_audio" and (stream_kind != "audio" or len(streams) > 1))
    ):
        return None

    validated: list[dict[str, object]] = []
    previous_index: int | None = None
    candidate_count = 0
    max_index = 2 ** (ctypes.sizeof(ctypes.c_size_t) * 8) - 1
    for stream in streams:
        if not isinstance(stream, dict) or set(stream) != {
            "original_index",
            "primary_url",
            "backup_urls",
        }:
            return None
        original_index = stream.get("original_index")
        primary_url = stream.get("primary_url")
        backup_urls = stream.get("backup_urls")
        if (
            isinstance(original_index, bool)
            or not isinstance(original_index, int)
            or original_index < 0
            or original_index > max_index
            or (previous_index is not None and original_index <= previous_index)
            or not isinstance(primary_url, str)
            or not isinstance(backup_urls, list)
            or not all(isinstance(url, str) for url in backup_urls)
        ):
            return None
        candidate_count += 1 + len(backup_urls)
        if candidate_count > MAX_MEDIA_DOWNLOAD_CANDIDATES:
            return None
        previous_index = original_index
        validated.append(
            {
                "original_index": original_index,
                "primary_url": primary_url,
                "backup_urls": list(backup_urls),
            }
        )
    return str(mode), str(stream_kind), validated


def _expected_media_download_candidates(
    mode: str,
    streams: list[dict[str, object]],
) -> list[dict[str, object]]:
    expected: list[dict[str, object]] = []
    for stream in streams:
        values = [("primary", None, stream["primary_url"])]
        values.extend(
            ("backup", backup_index, url)
            for backup_index, url in enumerate(stream["backup_urls"])
        )
        for source, backup_index, raw_url in values:
            url = str(raw_url).strip() if mode == "dash_streams" else str(raw_url)
            if mode == "dash_streams" and not url:
                continue
            expected.append(
                {
                    "stream_index": stream["original_index"],
                    "source": source,
                    "backup_index": backup_index,
                    "url": url,
                }
            )
    return expected


def _valid_media_download_plan_response(
    response: object,
    mode: str,
    streams: list[dict[str, object]],
) -> bool:
    if not isinstance(response, dict) or set(response) != {
        "schema_version",
        "status",
        "candidates",
    }:
        return False
    schema_version = response.get("schema_version")
    status = response.get("status")
    candidates = response.get("candidates")
    if (
        isinstance(schema_version, bool)
        or schema_version != 1
        or not isinstance(status, str)
        or status not in {"planned", "empty"}
        or not isinstance(candidates, list)
        or len(candidates) > sum(1 + len(stream["backup_urls"]) for stream in streams)
    ):
        return False

    request_by_index = {stream["original_index"]: stream for stream in streams}
    parsed: list[dict[str, object]] = []
    for candidate in candidates:
        if not isinstance(candidate, dict) or set(candidate) != {
            "stream_index",
            "source",
            "backup_index",
            "url",
        }:
            return False
        stream_index = candidate.get("stream_index")
        source = candidate.get("source")
        backup_index = candidate.get("backup_index")
        url = candidate.get("url")
        if (
            isinstance(stream_index, bool)
            or not isinstance(stream_index, int)
            or stream_index not in request_by_index
            or not isinstance(source, str)
            or source not in {"primary", "backup"}
            or not isinstance(url, str)
            or (mode == "dash_streams" and (not url or url != url.strip()))
        ):
            return False
        if source == "primary":
            if backup_index is not None:
                return False
        elif (
            isinstance(backup_index, bool)
            or not isinstance(backup_index, int)
            or backup_index < 0
            or backup_index >= len(request_by_index[stream_index]["backup_urls"])
        ):
            return False
        parsed.append(
            {
                "stream_index": stream_index,
                "source": source,
                "backup_index": backup_index,
                "url": url,
            }
        )
    expected = _expected_media_download_candidates(mode, streams)
    return parsed == expected and (
        (status == "empty" and not parsed) or (status == "planned" and bool(parsed))
    )


def try_plan_media_download_candidates(
    request: dict[str, object],
) -> tuple[bool, dict[str, Any] | None]:
    """Call and strictly validate media primary/backup URL planning."""

    validated = _media_download_plan_request(request)
    if (
        validated is None
        or _rust_lib is None
        or not _CAPABILITIES.get("plan_media_download_candidates", False)
    ):
        return False, None
    mode, _stream_kind, streams = validated
    try:
        payload = json.dumps(request, ensure_ascii=False, separators=(",", ":")).encode(
            "utf-8"
        )
        pointer = _rust_lib.rust_plan_media_download_candidates(payload)
        response_json = _read_rust_string(pointer)
        if response_json is None:
            return False, None
        response = json.loads(response_json)
        if not _valid_media_download_plan_response(response, mode, streams):
            return False, None
        return True, response
    except Exception:
        return False, None


def _tool_download_plan_request(
    request: object,
) -> tuple[str, dict[str, object], list[dict[str, object]]] | None:
    if not isinstance(request, dict) or set(request) != {
        "schema_version",
        "tool",
        "asset",
        "fallback_bases",
    }:
        return None
    schema_version = request.get("schema_version")
    tool = request.get("tool")
    asset = request.get("asset")
    fallback_bases = request.get("fallback_bases")
    if (
        isinstance(schema_version, bool)
        or schema_version != 1
        or not isinstance(tool, str)
        or tool not in {"bbdown", "ytdlp", "aria2c"}
        or not isinstance(asset, dict)
        or not isinstance(fallback_bases, list)
        or len(fallback_bases) > MAX_TOOL_FALLBACK_BASES
    ):
        return None
    mode = asset.get("mode")
    if mode == "supplied":
        if (
            set(asset) != {"mode", "name", "primary_url"}
            or not isinstance(asset.get("name"), str)
            or not asset["name"]
            or not isinstance(asset.get("primary_url"), str)
        ):
            return None
    elif mode == "default_for_target":
        if (
            set(asset) != {"mode", "platform", "arch"}
            or not isinstance(asset.get("platform"), str)
            or not isinstance(asset.get("arch"), str)
        ):
            return None
    else:
        return None

    validated_bases: list[dict[str, object]] = []
    previous_index: int | None = None
    max_index = 2 ** (ctypes.sizeof(ctypes.c_size_t) * 8) - 1
    for fallback in fallback_bases:
        if not isinstance(fallback, dict) or set(fallback) != {
            "original_index",
            "base_url",
        }:
            return None
        original_index = fallback.get("original_index")
        base_url = fallback.get("base_url")
        if (
            isinstance(original_index, bool)
            or not isinstance(original_index, int)
            or original_index < 0
            or original_index > max_index
            or (previous_index is not None and original_index <= previous_index)
            or not isinstance(base_url, str)
        ):
            return None
        previous_index = original_index
        validated_bases.append(
            {"original_index": original_index, "base_url": base_url}
        )
    return str(tool), dict(asset), validated_bases


def _default_tool_asset_name(tool: str, platform_name: str, arch: str) -> str | None:
    if tool == "bbdown":
        return {
            ("windows", "x64"): "BBDown_1.6.3_20240814_win-x64.zip",
            ("windows", "x86"): "BBDown_1.6.3_20240814_win-x64.zip",
            ("windows", "arm64"): "BBDown_1.6.3_20240814_win-arm64.zip",
            ("darwin", "x64"): "BBDown_1.6.3_20240814_osx-x64.zip",
            ("darwin", "arm64"): "BBDown_1.6.3_20240814_osx-arm64.zip",
            ("linux", "x64"): "BBDown_1.6.3_20240814_linux-x64.zip",
            ("linux", "arm64"): "BBDown_1.6.3_20240814_linux-arm64.zip",
        }.get((platform_name, arch))
    if tool == "ytdlp":
        if platform_name == "windows":
            if arch == "arm64":
                return "yt-dlp_arm64.exe"
            if arch == "x86":
                return "yt-dlp_x86.exe"
            return "yt-dlp.exe"
        if platform_name == "darwin":
            return "yt-dlp_macos"
        if platform_name == "linux":
            return "yt-dlp_linux"
        return "yt-dlp"
    if tool == "aria2c" and platform_name == "windows":
        return (
            "aria2-1.37.0-win-32bit-build1.zip"
            if arch == "x86"
            else "aria2-1.37.0-win-64bit-build1.zip"
        )
    return None


def _expected_tool_download_plan(
    tool: str,
    asset: dict[str, object],
    fallback_bases: list[dict[str, object]],
) -> tuple[str, list[dict[str, object]]] | None:
    if asset["mode"] == "supplied":
        asset_name = str(asset["name"])
        primary_url = str(asset["primary_url"])
        primary_source = "supplied_primary"
    else:
        asset_name = _default_tool_asset_name(
            tool, str(asset["platform"]), str(asset["arch"])
        )
        if asset_name is None:
            return None
        if tool == "aria2c":
            primary_url = (
                "https://github.com/aria2/aria2/releases/download/"
                f"release-1.37.0/{urllib.parse.quote(asset_name)}"
            )
            primary_source = "built_in_primary"
        else:
            primary_url = ""
            primary_source = "supplied_primary"

    expected: list[dict[str, object]] = []
    seen: set[str] = set()
    if primary_url:
        seen.add(primary_url)
        expected.append(
            {
                "source": primary_source,
                "fallback_index": None,
                "url": primary_url,
            }
        )
    quoted_name = urllib.parse.quote(asset_name)
    for fallback in fallback_bases:
        base_url = str(fallback["base_url"])
        if not base_url:
            continue
        url = f"{base_url}/{quoted_name}"
        if url in seen:
            continue
        seen.add(url)
        expected.append(
            {
                "source": "configured_fallback",
                "fallback_index": fallback["original_index"],
                "url": url,
            }
        )
    if asset["mode"] == "default_for_target" and tool in {"bbdown", "ytdlp"} and not expected:
        return None
    return asset_name, expected


def _valid_tool_download_plan_response(
    response: object,
    tool: str,
    expected_asset_name: str,
    expected_candidates: list[dict[str, object]],
) -> bool:
    if not isinstance(response, dict) or set(response) != {
        "schema_version",
        "status",
        "tool",
        "asset_name",
        "candidates",
    }:
        return False
    schema_version = response.get("schema_version")
    status = response.get("status")
    candidates = response.get("candidates")
    if (
        isinstance(schema_version, bool)
        or schema_version != 1
        or not isinstance(status, str)
        or status not in {"planned", "empty"}
        or response.get("tool") != tool
        or response.get("asset_name") != expected_asset_name
        or not isinstance(candidates, list)
        or len(candidates) > len(expected_candidates)
    ):
        return False
    parsed: list[dict[str, object]] = []
    seen: set[str] = set()
    for candidate in candidates:
        if not isinstance(candidate, dict) or set(candidate) != {
            "source",
            "fallback_index",
            "url",
        }:
            return False
        source = candidate.get("source")
        fallback_index = candidate.get("fallback_index")
        url = candidate.get("url")
        if (
            not isinstance(source, str)
            or source
            not in {"supplied_primary", "built_in_primary", "configured_fallback"}
            or not isinstance(url, str)
            or not url
            or url in seen
        ):
            return False
        if source == "configured_fallback":
            if isinstance(fallback_index, bool) or not isinstance(fallback_index, int):
                return False
        elif fallback_index is not None:
            return False
        seen.add(url)
        parsed.append(
            {"source": source, "fallback_index": fallback_index, "url": url}
        )
    return parsed == expected_candidates and (
        (status == "empty" and not parsed) or (status == "planned" and bool(parsed))
    )


def try_plan_tool_download_candidates(
    request: dict[str, object],
) -> tuple[bool, dict[str, Any] | None]:
    """Call and strictly validate tool asset candidate planning."""

    validated = _tool_download_plan_request(request)
    if validated is None:
        return False, None
    tool, asset, fallback_bases = validated
    expected = _expected_tool_download_plan(tool, asset, fallback_bases)
    if (
        expected is None
        or _rust_lib is None
        or not _CAPABILITIES.get("plan_tool_download_candidates", False)
    ):
        return False, None
    expected_asset_name, expected_candidates = expected
    try:
        payload = json.dumps(request, ensure_ascii=False, separators=(",", ":")).encode(
            "utf-8"
        )
        pointer = _rust_lib.rust_plan_tool_download_candidates(payload)
        response_json = _read_rust_string(pointer)
        if response_json is None:
            return False, None
        response = json.loads(response_json)
        if not _valid_tool_download_plan_response(
            response, tool, expected_asset_name, expected_candidates
        ):
            return False, None
        return True, response
    except Exception:
        return False, None


_ACTIVE_VIDEO_QUALITIES = (
    "1080P 高帧率",
    "1080P 高清",
    "720P 高清",
    "480P 清晰",
    "360P 流畅",
)
_DEFAULT_VIDEO_QUALITY = _ACTIVE_VIDEO_QUALITIES[0]
_DASH_QUALITY_IDS = {
    "360P 流畅": 16,
    "480P 清晰": 32,
    "720P 高清": 64,
    "720P 60帧": 74,
    "1080P 高清": 80,
    "1080P 高码率": 112,
    "1080P 高帧率": 116,
    "4K 超清": 120,
    "HDR 真彩": 125,
    "杜比视界": 126,
    "8K 超高清": 127,
}
_I64_MIN = -(2**63)
_I64_MAX = 2**63 - 1
_USIZE_MAX = 2 ** (ctypes.sizeof(ctypes.c_size_t) * 8) - 1


def _bounded_utf8_string(value: object, max_bytes: int) -> str | None:
    if not isinstance(value, str) or len(value.encode("utf-8")) > max_bytes:
        return None
    return value


def _quality_policy_request(request: object) -> dict[str, object] | None:
    if not isinstance(request, dict) or set(request) != {
        "schema_version",
        "raw_quality",
        "raw_cap",
        "choice_index",
    }:
        return None
    schema_version = request.get("schema_version")
    raw_quality = _bounded_utf8_string(
        request.get("raw_quality"), MAX_QUALITY_LABEL_BYTES
    )
    raw_cap = _bounded_utf8_string(request.get("raw_cap"), MAX_QUALITY_LABEL_BYTES)
    choice_index = request.get("choice_index")
    if (
        isinstance(schema_version, bool)
        or schema_version != 1
        or raw_quality is None
        or raw_cap is None
        or (
            choice_index is not None
            and (
                isinstance(choice_index, bool)
                or not isinstance(choice_index, int)
                or not _I64_MIN <= choice_index <= _I64_MAX
            )
        )
    ):
        return None
    return {
        "schema_version": 1,
        "raw_quality": raw_quality,
        "raw_cap": raw_cap,
        "choice_index": choice_index,
    }


def _expected_quality_policy(request: dict[str, object]) -> dict[str, object]:
    raw_quality = str(request["raw_quality"])
    raw_cap = str(request["raw_cap"])
    stripped_quality = raw_quality.strip()
    stripped_cap = raw_cap.strip()
    optional_quality = (
        stripped_quality if stripped_quality in _ACTIVE_VIDEO_QUALITIES else None
    )
    normalized_quality = optional_quality or _DEFAULT_VIDEO_QUALITY
    optional_cap = stripped_cap if stripped_cap in _ACTIVE_VIDEO_QUALITIES else None
    choice_index = request["choice_index"]
    indexed_quality = (
        _ACTIVE_VIDEO_QUALITIES[choice_index]
        if isinstance(choice_index, int)
        and not isinstance(choice_index, bool)
        and 0 <= choice_index < len(_ACTIVE_VIDEO_QUALITIES)
        else None
    )
    effective_quality = optional_cap or normalized_quality
    if "360" in effective_quality:
        max_height = 360
    elif "480" in effective_quality:
        max_height = 480
    elif "720" in effective_quality:
        max_height = 720
    elif "1080" in effective_quality:
        max_height = 1080
    elif "4K" in effective_quality:
        max_height = 2160
    elif "8K" in effective_quality:
        max_height = 4320
    else:
        max_height = 1080
    start_index = _ACTIVE_VIDEO_QUALITIES.index(normalized_quality)
    if optional_cap:
        start_index = max(start_index, _ACTIVE_VIDEO_QUALITIES.index(optional_cap))
    return {
        "schema_version": 1,
        "status": "decided",
        "normalized_quality": normalized_quality,
        "optional_quality": optional_quality,
        "optional_cap": optional_cap,
        "indexed_quality": indexed_quality,
        "dash_max_quality_id": _DASH_QUALITY_IDS.get(raw_quality, 80),
        "effective_max_height": max_height,
        "bbdown_quality_order": list(_ACTIVE_VIDEO_QUALITIES[start_index:]),
    }


def _valid_quality_policy_response(
    response: object, request: dict[str, object]
) -> bool:
    return isinstance(response, dict) and response == _expected_quality_policy(request)


def try_decide_quality_policy(
    request: dict[str, object],
) -> tuple[bool, dict[str, Any] | None]:
    """Call and strictly reconstruct the canonical quality-policy decision."""

    validated = _quality_policy_request(request)
    if (
        validated is None
        or _rust_lib is None
        or not _CAPABILITIES.get("decide_quality_policy", False)
    ):
        return False, None
    try:
        payload = json.dumps(validated, ensure_ascii=False, separators=(",", ":")).encode(
            "utf-8"
        )
        pointer = _rust_lib.rust_decide_quality_policy(payload)
        response_json = _read_rust_string(pointer)
        if response_json is None:
            return False, None
        response = json.loads(response_json)
        if not _valid_quality_policy_response(response, validated):
            return False, None
        return True, response
    except Exception:
        return False, None


def _video_stream_request(
    request: object,
) -> dict[str, object] | None:
    if not isinstance(request, dict) or set(request) != {
        "schema_version",
        "max_quality_id",
        "codec_filter",
        "max_avc_quality_id",
        "streams",
    }:
        return None
    schema_version = request.get("schema_version")
    max_quality_id = request.get("max_quality_id")
    max_avc_quality_id = request.get("max_avc_quality_id")
    codec_filter = request.get("codec_filter")
    streams = request.get("streams")
    if (
        isinstance(schema_version, bool)
        or schema_version != 1
        or isinstance(max_quality_id, bool)
        or not isinstance(max_quality_id, int)
        or not _I64_MIN <= max_quality_id <= _I64_MAX
        or (
            max_avc_quality_id is not None
            and (
                isinstance(max_avc_quality_id, bool)
                or not isinstance(max_avc_quality_id, int)
                or not _I64_MIN <= max_avc_quality_id <= _I64_MAX
            )
        )
        or (
            codec_filter is not None
            and _bounded_utf8_string(codec_filter, MAX_CODEC_STRING_BYTES) is None
        )
        or not isinstance(streams, list)
        or len(streams) > MAX_STREAM_RANKING_INPUTS
    ):
        return None
    validated_streams: list[dict[str, object]] = []
    previous_index: int | None = None
    for stream in streams:
        if not isinstance(stream, dict) or set(stream) != {
            "original_index",
            "quality_id",
            "bandwidth",
            "codec",
        }:
            return None
        original_index = stream.get("original_index")
        quality_id = stream.get("quality_id")
        bandwidth = stream.get("bandwidth")
        codec = _bounded_utf8_string(stream.get("codec"), MAX_CODEC_STRING_BYTES)
        if (
            isinstance(original_index, bool)
            or not isinstance(original_index, int)
            or not 0 <= original_index <= _USIZE_MAX
            or (previous_index is not None and original_index <= previous_index)
            or isinstance(quality_id, bool)
            or not isinstance(quality_id, int)
            or not _I64_MIN <= quality_id <= _I64_MAX
            or isinstance(bandwidth, bool)
            or not isinstance(bandwidth, int)
            or not _I64_MIN <= bandwidth <= _I64_MAX
            or codec is None
        ):
            return None
        previous_index = original_index
        validated_streams.append(
            {
                "original_index": original_index,
                "quality_id": quality_id,
                "bandwidth": bandwidth,
                "codec": codec,
            }
        )
    return {
        "schema_version": 1,
        "max_quality_id": max_quality_id,
        "codec_filter": codec_filter,
        "max_avc_quality_id": max_avc_quality_id,
        "streams": validated_streams,
    }


def _expected_video_stream_selection(request: dict[str, object]) -> dict[str, object]:
    streams = list(request["streams"])
    if not streams:
        return {
            "schema_version": 1,
            "status": "no_match",
            "selected_index": None,
            "ranked_indices": [],
            "reason": None,
        }
    max_quality_id = int(request["max_quality_id"])
    codec_filter = request["codec_filter"]
    max_avc_quality_id = request["max_avc_quality_id"]
    candidates = [
        stream
        for stream in streams
        if int(stream["quality_id"]) <= max_quality_id
        and (not codec_filter or stream["codec"] == codec_filter)
        and not (
            codec_filter == "avc"
            and isinstance(max_avc_quality_id, int)
            and max_avc_quality_id != 0
            and int(stream["quality_id"]) > max_avc_quality_id
        )
    ]
    if candidates:
        reason = "preferred"
    else:
        candidates = [
            stream
            for stream in streams
            if int(stream["quality_id"]) <= max_quality_id
        ]
        if candidates:
            reason = "quality_fallback"
        else:
            candidates = streams
            reason = "uncapped_fallback"
    ranked = sorted(
        candidates,
        key=lambda stream: (-int(stream["quality_id"]), -int(stream["bandwidth"])),
    )
    ranked_indices = [stream["original_index"] for stream in ranked]
    return {
        "schema_version": 1,
        "status": "selected",
        "selected_index": ranked_indices[0],
        "ranked_indices": ranked_indices,
        "reason": reason,
    }


def _valid_video_stream_response(
    response: object, request: dict[str, object]
) -> bool:
    return isinstance(response, dict) and response == _expected_video_stream_selection(
        request
    )


def try_select_video_stream(
    request: dict[str, object],
) -> tuple[bool, dict[str, Any] | None]:
    """Call and strictly reconstruct DASH video ranking."""

    validated = _video_stream_request(request)
    if (
        validated is None
        or _rust_lib is None
        or not _CAPABILITIES.get("select_video_stream", False)
    ):
        return False, None
    try:
        payload = json.dumps(validated, ensure_ascii=False, separators=(",", ":")).encode(
            "utf-8"
        )
        pointer = _rust_lib.rust_select_video_stream(payload)
        response_json = _read_rust_string(pointer)
        if response_json is None:
            return False, None
        response = json.loads(response_json)
        if not _valid_video_stream_response(response, validated):
            return False, None
        return True, response
    except Exception:
        return False, None


def _audio_stream_request(request: object) -> dict[str, object] | None:
    if not isinstance(request, dict) or set(request) != {
        "schema_version",
        "audio_hires",
        "regular_streams",
        "flac_available",
        "dolby_available",
    }:
        return None
    schema_version = request.get("schema_version")
    audio_hires = request.get("audio_hires")
    flac_available = request.get("flac_available")
    dolby_available = request.get("dolby_available")
    streams = request.get("regular_streams")
    if (
        isinstance(schema_version, bool)
        or schema_version != 1
        or not isinstance(audio_hires, bool)
        or not isinstance(flac_available, bool)
        or not isinstance(dolby_available, bool)
        or not isinstance(streams, list)
        or len(streams) > MAX_STREAM_RANKING_INPUTS
    ):
        return None
    validated_streams: list[dict[str, object]] = []
    previous_index: int | None = None
    for stream in streams:
        if not isinstance(stream, dict) or set(stream) != {
            "original_index",
            "quality_id",
            "bandwidth",
        }:
            return None
        original_index = stream.get("original_index")
        quality_id = stream.get("quality_id")
        bandwidth = stream.get("bandwidth")
        if (
            isinstance(original_index, bool)
            or not isinstance(original_index, int)
            or not 0 <= original_index <= _USIZE_MAX
            or (previous_index is not None and original_index <= previous_index)
            or isinstance(quality_id, bool)
            or not isinstance(quality_id, int)
            or not _I64_MIN <= quality_id <= _I64_MAX
            or isinstance(bandwidth, bool)
            or not isinstance(bandwidth, int)
            or not _I64_MIN <= bandwidth <= _I64_MAX
        ):
            return None
        previous_index = original_index
        validated_streams.append(
            {
                "original_index": original_index,
                "quality_id": quality_id,
                "bandwidth": bandwidth,
            }
        )
    return {
        "schema_version": 1,
        "audio_hires": audio_hires,
        "regular_streams": validated_streams,
        "flac_available": flac_available,
        "dolby_available": dolby_available,
    }


def _expected_audio_stream_selection(request: dict[str, object]) -> dict[str, object]:
    streams = list(request["regular_streams"])
    audio_hires = bool(request["audio_hires"])
    candidates = streams
    regular_reason: str | None = "hires_enabled" if streams and audio_hires else None
    if streams and not audio_hires:
        standard = [
            stream for stream in streams if stream["quality_id"] not in {30250, 30251}
        ]
        if standard:
            candidates = standard
            regular_reason = "standard_only"
        else:
            regular_reason = "hires_only_fallback"
    quality_order = {30250: 0, 30251: 1, 30280: 2, 30232: 3, 30216: 4}
    ranked = sorted(
        candidates,
        key=lambda stream: quality_order.get(stream["quality_id"], 99),
    )
    ranked_indices = [stream["original_index"] for stream in ranked]
    selected_regular_index = ranked_indices[0] if ranked_indices else None
    if audio_hires and request["dolby_available"]:
        preferred_source = "dolby"
    elif audio_hires and request["flac_available"]:
        preferred_source = "flac"
    elif selected_regular_index is not None:
        preferred_source = "regular"
    else:
        preferred_source = None
    return {
        "schema_version": 1,
        "status": "selected" if preferred_source else "no_match",
        "selected_regular_index": selected_regular_index,
        "ranked_regular_indices": ranked_indices,
        "regular_reason": regular_reason,
        "preferred_source": preferred_source,
    }


def _valid_audio_stream_response(
    response: object, request: dict[str, object]
) -> bool:
    return isinstance(response, dict) and response == _expected_audio_stream_selection(
        request
    )


def try_select_audio_stream(
    request: dict[str, object],
) -> tuple[bool, dict[str, Any] | None]:
    """Call and strictly reconstruct DASH audio ranking and source preference."""

    validated = _audio_stream_request(request)
    if (
        validated is None
        or _rust_lib is None
        or not _CAPABILITIES.get("select_audio_stream", False)
    ):
        return False, None
    try:
        payload = json.dumps(validated, ensure_ascii=False, separators=(",", ":")).encode(
            "utf-8"
        )
        pointer = _rust_lib.rust_select_audio_stream(payload)
        response_json = _read_rust_string(pointer)
        if response_json is None:
            return False, None
        response = json.loads(response_json)
        if not _valid_audio_stream_response(response, validated):
            return False, None
        return True, response
    except Exception:
        return False, None
