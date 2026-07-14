from __future__ import annotations

import ctypes
import json
import platform
import sys
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

PHASE2_CAPABILITIES = ("select_update_asset", "select_release", "select_media_pages")


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

